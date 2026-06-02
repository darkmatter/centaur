use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const DEFAULT_PROXY_BASE_CONFIG: &str =
    include_str!("../../../../api/api/iron-proxy.base.yaml");
pub const CENTAUR_CORE_PG_LISTENER: &str = "centaur_core";
pub const DEFAULT_CORE_PG_PORT: u16 = 5432;
pub const INFRA_FRAGMENT: &str = include_str!("../../../../iron-proxy/infra.yaml");
pub const CLAUDE_CODE_API_KEY_FRAGMENT: &str =
    include_str!("../../../../iron-proxy/harness/claude-code-api-key.yaml");
pub const CLAUDE_CODE_ACCESS_TOKEN_FRAGMENT: &str =
    include_str!("../../../../iron-proxy/harness/claude-code-access-token.yaml");
pub const CODEX_API_KEY_FRAGMENT: &str =
    include_str!("../../../../iron-proxy/harness/codex-api-key.yaml");
pub const CODEX_ACCESS_TOKEN_FRAGMENT: &str =
    include_str!("../../../../iron-proxy/harness/codex-access-token.yaml");
pub const DEFAULT_BROKER_LISTEN_PORT: u16 = 8181;
pub const DEFAULT_BROKER_METRICS_PORT: u16 = 9091;
pub const BROKER_BEARER_AUTH_ENV: &str = "IRON_BROKER_TOKEN";

const MANAGED_TRANSFORMS: &[&str] = &["secrets", "gcp_auth", "oauth_token", "hmac_sign"];

#[derive(Debug, Error)]
pub enum IronProxyConfigError {
    #[error("failed to read {path}: {source}")]
    ReadFile {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to read directory {path}: {source}")]
    ReadDir {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse iron-proxy fragment {path}: {source}")]
    ParseFragment {
        path: PathBuf,
        source: serde_yaml::Error,
    },
    #[error("failed to parse iron-proxy base yaml: {0}")]
    ParseBase(serde_yaml::Error),
    #[error("iron-proxy base config must be a mapping")]
    BaseNotMapping,
    #[error("failed to serialize iron-proxy yaml: {0}")]
    Serialize(serde_yaml::Error),
    #[error(
        "iron-token-broker store cannot use env source for {placeholder}; configure KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE=onepassword or onepassword-connect"
    )]
    BrokerStoreEnv { placeholder: String },
    #[error(
        "iron-token-broker store placeholder {placeholder} cannot use json_key because the broker writes the whole credential blob"
    )]
    BrokerStoreJsonKey { placeholder: String },
}

pub type Result<T> = std::result::Result<T, IronProxyConfigError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourcePolicy {
    pub kind: SourceKind,
    pub op_vault: String,
    pub ttl: String,
    pub token_broker_ttl: String,
}

impl SourcePolicy {
    pub fn env() -> Self {
        Self {
            kind: SourceKind::Env,
            op_vault: "ai-agents".to_owned(),
            ttl: "10m".to_owned(),
            token_broker_ttl: "1m".to_owned(),
        }
    }

    pub fn onepassword(op_vault: impl Into<String>, ttl: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::OnePassword,
            op_vault: op_vault.into(),
            ttl: ttl.into(),
            token_broker_ttl: "1m".to_owned(),
        }
    }

    pub fn onepassword_connect(op_vault: impl Into<String>, ttl: impl Into<String>) -> Self {
        Self {
            kind: SourceKind::OnePasswordConnect,
            op_vault: op_vault.into(),
            ttl: ttl.into(),
            token_broker_ttl: "1m".to_owned(),
        }
    }

    pub fn with_token_broker_ttl(mut self, ttl: impl Into<String>) -> Self {
        self.token_broker_ttl = ttl.into();
        self
    }

    #[cfg(test)]
    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Self {
        let kind = match lookup("KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE")
            .unwrap_or_else(|| "env".to_owned())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "onepassword" => SourceKind::OnePassword,
            "onepassword-connect" => SourceKind::OnePasswordConnect,
            _ => SourceKind::Env,
        };
        Self {
            kind,
            op_vault: lookup("OP_VAULT").unwrap_or_else(|| "ai-agents".to_owned()),
            ttl: lookup("KUBERNETES_FIREWALL_MANAGER_SECRET_TTL")
                .unwrap_or_else(|| "10m".to_owned()),
            token_broker_ttl: lookup("KUBERNETES_FIREWALL_MANAGER_TOKEN_BROKER_TTL")
                .unwrap_or_else(|| "1m".to_owned()),
        }
    }

    fn source_for(&self, placeholder: &str, json_key: Option<&str>) -> Value {
        let mut source = Mapping::new();
        match self.kind {
            SourceKind::Env => {
                source.insert(string_value("type"), string_value("env"));
                source.insert(string_value("var"), string_value(placeholder));
            }
            SourceKind::OnePassword => {
                source.insert(string_value("type"), string_value("1password"));
                source.insert(
                    string_value("secret_ref"),
                    string_value(format!("op://{}/{placeholder}/credential", self.op_vault)),
                );
                source.insert(string_value("ttl"), string_value(&self.ttl));
            }
            SourceKind::OnePasswordConnect => {
                source.insert(string_value("type"), string_value("1password_connect"));
                source.insert(
                    string_value("secret_ref"),
                    string_value(format!("op://{}/{placeholder}/credential", self.op_vault)),
                );
                source.insert(string_value("ttl"), string_value(&self.ttl));
            }
        }
        if let Some(json_key) = json_key {
            source.insert(string_value("json_key"), string_value(json_key));
        }
        Value::Mapping(source)
    }

    fn store_source_for(&self, placeholder: &str) -> Result<Value> {
        match self.kind {
            SourceKind::Env => Err(IronProxyConfigError::BrokerStoreEnv {
                placeholder: placeholder.to_owned(),
            }),
            SourceKind::OnePassword | SourceKind::OnePasswordConnect => {
                Ok(self.source_for(placeholder, None))
            }
        }
    }
}

impl Default for SourcePolicy {
    fn default() -> Self {
        Self::env()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SourceKind {
    Env,
    OnePassword,
    OnePasswordConnect,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProxyFragment {
    #[serde(default)]
    pub transforms: Vec<Value>,
    #[serde(default)]
    pub postgres: Vec<Value>,
    #[serde(default)]
    pub broker_credentials: Vec<Value>,
    #[serde(default, flatten)]
    pub top_level: BTreeMap<String, Value>,
}

impl ProxyFragment {
    pub fn is_empty(&self) -> bool {
        self.transforms.is_empty()
            && self.postgres.is_empty()
            && self.broker_credentials.is_empty()
            && self.top_level.is_empty()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CorePgListener {
    pub port: u16,
    pub dsn_env_var: String,
    pub password_env: String,
}

impl CorePgListener {
    pub fn new(port: u16, dsn_env_var: impl Into<String>, password_env: impl Into<String>) -> Self {
        Self {
            port,
            dsn_env_var: dsn_env_var.into(),
            password_env: password_env.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PgDsnEnv {
    pub env_name: String,
    pub database: String,
    pub port: u16,
    pub password_env: String,
}

pub fn load_fragment_file(path: impl AsRef<Path>) -> Result<ProxyFragment> {
    let path = path.as_ref();
    let contents = fs::read_to_string(path).map_err(|source| IronProxyConfigError::ReadFile {
        path: path.to_path_buf(),
        source,
    })?;
    serde_yaml::from_str(&contents).map_err(|source| IronProxyConfigError::ParseFragment {
        path: path.to_path_buf(),
        source,
    })
}

pub fn load_fragment_str(contents: &str) -> Result<ProxyFragment> {
    serde_yaml::from_str(contents).map_err(|source| IronProxyConfigError::ParseFragment {
        path: PathBuf::from("<inline>"),
        source,
    })
}

pub fn load_fragment_files(paths: &[PathBuf]) -> Result<Vec<ProxyFragment>> {
    paths
        .iter()
        .map(load_fragment_file)
        .collect::<Result<Vec<_>>>()
}

pub fn discover_fragment_files(dirs: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    for dir in dirs {
        visit_fragment_dir(dir, &mut paths)?;
    }
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn visit_fragment_dir(dir: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|source| IronProxyConfigError::ReadDir {
        path: dir.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| IronProxyConfigError::ReadDir {
            path: dir.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|source| IronProxyConfigError::ReadDir {
                path: path.clone(),
                source,
            })?;
        if file_type.is_dir() {
            visit_fragment_dir(&path, paths)?;
        } else if file_type.is_file()
            && path.file_name().and_then(|name| name.to_str()) == Some("iron.yaml")
        {
            paths.push(path);
        }
    }
    Ok(())
}

pub fn harness_fragment(engine: &str, auth_mode: &str) -> Result<Option<ProxyFragment>> {
    let contents = match (engine, auth_mode) {
        ("claude-code", "access_token") => CLAUDE_CODE_ACCESS_TOKEN_FRAGMENT,
        ("claude-code", _) => CLAUDE_CODE_API_KEY_FRAGMENT,
        ("codex", "access_token") => CODEX_ACCESS_TOKEN_FRAGMENT,
        ("codex", _) => CODEX_API_KEY_FRAGMENT,
        _ => return Ok(None),
    };
    load_fragment_str(contents).map(Some)
}

pub fn infra_fragment() -> Result<ProxyFragment> {
    load_fragment_str(INFRA_FRAGMENT)
}

pub fn harness_broker_fragments() -> Result<Vec<ProxyFragment>> {
    [
        CLAUDE_CODE_ACCESS_TOKEN_FRAGMENT,
        CODEX_ACCESS_TOKEN_FRAGMENT,
    ]
    .iter()
    .map(|contents| load_fragment_str(contents))
    .collect()
}

pub fn placeholder_env(fragments: &[ProxyFragment]) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for fragment in fragments {
        for transform in &fragment.transforms {
            if transform_name(transform) != Some("secrets") {
                continue;
            }
            for secret in transform["config"]["secrets"]
                .as_sequence()
                .into_iter()
                .flatten()
            {
                let Some(proxy_value) = secret_proxy_value(secret) else {
                    continue;
                };
                if proxy_value.is_empty() || proxy_value.contains('=') {
                    continue;
                }
                env.entry(proxy_value.to_owned())
                    .or_insert_with(|| proxy_value.to_owned());
            }
        }
    }
    env
}

pub fn listen_ports_from_yaml(config_yaml: &str) -> Result<Vec<u16>> {
    let cfg: Value = serde_yaml::from_str(config_yaml).map_err(IronProxyConfigError::ParseBase)?;
    let mut ports = Vec::new();
    ports.push(proxy_listen_port_from_value(&cfg));
    for listener in cfg["postgres"].as_sequence().into_iter().flatten() {
        if let Some(port) = listener["listen"].as_str().and_then(listen_port) {
            ports.push(port);
        }
    }
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}

pub fn proxy_listen_port_from_yaml(config_yaml: &str) -> Result<u16> {
    let cfg: Value = serde_yaml::from_str(config_yaml).map_err(IronProxyConfigError::ParseBase)?;
    Ok(proxy_listen_port_from_value(&cfg))
}

fn proxy_listen_port_from_value(cfg: &Value) -> u16 {
    cfg["proxy"]["tunnel_listen"]
        .as_str()
        .and_then(listen_port)
        .unwrap_or(8080)
}

fn listen_port(value: &str) -> Option<u16> {
    value.rsplit_once(':')?.1.parse().ok()
}

pub fn pg_dsn_envs(fragments: &[ProxyFragment]) -> Vec<PgDsnEnv> {
    let mut entries = BTreeMap::<String, PgDsnEnv>::new();
    for listener in fragments
        .iter()
        .flat_map(|fragment| fragment.postgres.iter())
    {
        let Some(sandbox_env) = listener["sandbox_env"].as_mapping() else {
            continue;
        };
        let Some(env_name) = sandbox_env
            .get(&string_value("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(database) = sandbox_env
            .get(&string_value("database"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(port) = listener["listen"].as_str().and_then(listen_port) else {
            continue;
        };
        let Some(password_env) = listener["client"]["password_env"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        entries.entry(env_name.to_owned()).or_insert(PgDsnEnv {
            env_name: env_name.to_owned(),
            database: database.to_owned(),
            port,
            password_env: password_env.to_owned(),
        });
    }
    entries.into_values().collect()
}

pub fn render_proxy_yaml(
    base_config: Option<&str>,
    fragments: &[ProxyFragment],
    core_pg: Option<&CorePgListener>,
) -> Result<String> {
    render_proxy_yaml_with_source_policy(base_config, fragments, core_pg, &SourcePolicy::default())
}

pub fn render_proxy_yaml_with_source_policy(
    base_config: Option<&str>,
    fragments: &[ProxyFragment],
    core_pg: Option<&CorePgListener>,
    source_policy: &SourcePolicy,
) -> Result<String> {
    let mut cfg: Value = serde_yaml::from_str(base_config.unwrap_or(DEFAULT_PROXY_BASE_CONFIG))
        .map_err(IronProxyConfigError::ParseBase)?;
    let Value::Mapping(cfg_map) = &mut cfg else {
        return Err(IronProxyConfigError::BaseNotMapping);
    };

    for fragment in fragments {
        for (key, value) in &fragment.top_level {
            let mut value = value.clone();
            resolve_placeholder_source_values(&mut value, source_policy);
            cfg_map.insert(string_value(key), value);
        }
    }

    let mut transforms = existing_unmanaged_transforms(cfg_map);
    let mut managed = fragments
        .iter()
        .flat_map(|fragment| fragment.transforms.iter().cloned())
        .collect::<Vec<_>>();
    assign_secret_ids(&mut managed)?;
    let managed = managed
        .into_iter()
        .map(|transform| resolve_fragment_transform_sources(transform, source_policy))
        .collect::<Vec<_>>();
    let managed = merge_managed_transforms(managed);
    if !managed.is_empty() {
        insert_before_header_allowlist(&mut transforms, managed);
    }
    cfg_map.insert(string_value("transforms"), Value::Sequence(transforms));

    let mut postgres = fragments
        .iter()
        .flat_map(|fragment| fragment.postgres.iter().cloned())
        .map(|mut listener| {
            strip_centaur_postgres_extensions(&mut listener);
            resolve_placeholder_source_values(&mut listener, source_policy);
            listener
        })
        .collect::<Vec<_>>();
    if let Some(core_pg) = core_pg {
        postgres.push(core_pg_listener_value(core_pg));
    }
    if postgres.is_empty() {
        cfg_map.remove(&string_value("postgres"));
    } else {
        cfg_map.insert(string_value("postgres"), Value::Sequence(postgres));
    }

    serde_yaml::to_string(&cfg).map_err(IronProxyConfigError::Serialize)
}

pub fn render_token_broker_yaml(fragments: &[ProxyFragment]) -> Result<String> {
    render_token_broker_yaml_with_source_policy(fragments, &SourcePolicy::default())
}

pub fn render_token_broker_yaml_with_source_policy(
    fragments: &[ProxyFragment],
    source_policy: &SourcePolicy,
) -> Result<String> {
    let credentials = collect_broker_credentials(fragments, source_policy)?;
    let cfg = mapping([
        (
            "listen",
            string_value(format!(":{DEFAULT_BROKER_LISTEN_PORT}")),
        ),
        (
            "metrics_listen",
            string_value(format!(":{DEFAULT_BROKER_METRICS_PORT}")),
        ),
        ("bearer_auth_env", string_value(BROKER_BEARER_AUTH_ENV)),
        (
            "log",
            mapping([
                ("level", string_value("info")),
                ("format", string_value("json")),
            ]),
        ),
        ("credentials", Value::Sequence(credentials)),
    ]);
    serde_yaml::to_string(&cfg).map_err(IronProxyConfigError::Serialize)
}

fn collect_broker_credentials(
    fragments: &[ProxyFragment],
    source_policy: &SourcePolicy,
) -> Result<Vec<Value>> {
    let mut by_id = BTreeMap::<String, Value>::new();
    for credential in fragments
        .iter()
        .flat_map(|fragment| fragment.broker_credentials.iter().cloned())
    {
        let id = credential["id"].as_str().map(ToOwned::to_owned);
        let credential = resolve_broker_credential_sources(credential, source_policy)?;
        if let Some(id) = id {
            by_id.entry(id).or_insert(credential);
        }
    }
    Ok(by_id.into_values().collect())
}

fn resolve_broker_credential_sources(
    mut credential: Value,
    source_policy: &SourcePolicy,
) -> Result<Value> {
    let Some(map) = credential.as_mapping_mut() else {
        return Ok(credential);
    };
    let store_key = string_value("store");
    if let Some(store) = map.get_mut(&store_key) {
        resolve_broker_store_source(store, source_policy)?;
    }
    for (key, child) in map {
        if key == &store_key {
            continue;
        }
        resolve_placeholder_source_values(child, source_policy);
    }
    Ok(credential)
}

fn resolve_broker_store_source(value: &mut Value, source_policy: &SourcePolicy) -> Result<()> {
    let Some(map) = value.as_mapping_mut() else {
        return Ok(());
    };
    if let Some(placeholder) = map
        .get(&string_value("placeholder"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
    {
        if map.contains_key(&string_value("json_key")) {
            return Err(IronProxyConfigError::BrokerStoreJsonKey { placeholder });
        }
        *value = source_policy.store_source_for(&placeholder)?;
        return Ok(());
    }
    if map.get(&string_value("type")).and_then(Value::as_str) == Some("env") {
        let placeholder = map
            .get(&string_value("var"))
            .and_then(Value::as_str)
            .unwrap_or("store")
            .to_owned();
        return Err(IronProxyConfigError::BrokerStoreEnv { placeholder });
    }
    Ok(())
}

fn strip_centaur_postgres_extensions(listener: &mut Value) {
    if let Some(map) = listener.as_mapping_mut() {
        map.remove(&string_value("sandbox_env"));
    }
}

fn resolve_fragment_transform_sources(mut transform: Value, source_policy: &SourcePolicy) -> Value {
    fill_missing_secret_sources(&mut transform, source_policy);
    resolve_placeholder_source_values(&mut transform, source_policy);
    transform
}

fn assign_secret_ids(transforms: &mut [Value]) -> Result<()> {
    let mut used = BTreeMap::<String, usize>::new();
    for secret in secret_entries_mut(transforms) {
        if let Some(id) = secret["id"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            used.entry(id.to_owned()).or_insert(1);
        }
    }

    for secret in secret_entries_mut(transforms) {
        if secret
            .as_mapping()
            .and_then(|map| map.get(&string_value("id")))
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            continue;
        }
        let candidate = generated_secret_id(secret)?;
        let id = unique_id(candidate, &mut used);
        if let Some(secret_map) = secret.as_mapping_mut() {
            secret_map.insert(string_value("id"), string_value(id));
        }
    }
    Ok(())
}

fn secret_entries_mut(transforms: &mut [Value]) -> Vec<&mut Value> {
    transforms
        .iter_mut()
        .filter(|transform| transform_name(transform) == Some("secrets"))
        .filter_map(|transform| {
            transform
                .as_mapping_mut()
                .and_then(|map| map.get_mut(&string_value("config")))
                .and_then(Value::as_mapping_mut)
                .and_then(|map| map.get_mut(&string_value("secrets")))
                .and_then(Value::as_sequence_mut)
        })
        .flat_map(|secrets| secrets.iter_mut())
        .collect()
}

fn generated_secret_id(secret: &Value) -> Result<String> {
    let base = secret_id_base(secret);
    let digest = secret_identity_digest(secret)?;
    Ok(format!("{base}-{digest}"))
}

fn secret_id_base(secret: &Value) -> String {
    let raw = secret_proxy_value(secret)
        .or_else(|| secret["source"]["credential_id"].as_str())
        .or_else(|| secret["source"]["placeholder"].as_str())
        .or_else(|| secret["source"]["var"].as_str())
        .or_else(|| secret["source"]["secret_ref"].as_str())
        .or_else(|| secret["inject"]["header"].as_str())
        .or_else(|| secret["inject"]["query_param"].as_str())
        .or_else(|| secret["rules"][0]["host"].as_str())
        .unwrap_or("secret");
    let slug = slugify_id_component(raw);
    if slug.is_empty() {
        "secret".to_owned()
    } else {
        slug
    }
}

fn slugify_id_component(value: &str) -> String {
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            previous_dash = false;
        } else if !previous_dash && !slug.is_empty() {
            slug.push('-');
            previous_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

fn secret_identity_digest(secret: &Value) -> Result<String> {
    let mut identity = secret.clone();
    if let Some(map) = identity.as_mapping_mut() {
        map.remove(&string_value("id"));
    }
    let serialized = serde_yaml::to_string(&identity).map_err(IronProxyConfigError::Serialize)?;
    let digest = Sha256::digest(serialized.as_bytes());
    Ok(digest[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn unique_id(candidate: String, used: &mut BTreeMap<String, usize>) -> String {
    let count = used.entry(candidate.clone()).or_insert(0);
    *count += 1;
    if *count == 1 {
        candidate
    } else {
        format!("{candidate}-{count}")
    }
}

fn fill_missing_secret_sources(transform: &mut Value, source_policy: &SourcePolicy) {
    if transform_name(transform) != Some("secrets") {
        return;
    }
    let Some(secrets) = transform
        .as_mapping_mut()
        .and_then(|map| map.get_mut(&string_value("config")))
        .and_then(Value::as_mapping_mut)
        .and_then(|map| map.get_mut(&string_value("secrets")))
        .and_then(Value::as_sequence_mut)
    else {
        return;
    };
    for secret in secrets {
        let proxy_value = secret_proxy_value(secret).map(ToOwned::to_owned);
        let Some(secret_map) = secret.as_mapping_mut() else {
            continue;
        };
        if secret_map.contains_key(&string_value("source")) {
            continue;
        }
        let Some(proxy_value) = proxy_value else {
            continue;
        };
        secret_map.insert(
            string_value("source"),
            source_policy.source_for(&proxy_value, None),
        );
    }
}

fn secret_proxy_value(secret: &Value) -> Option<&str> {
    secret["replace"]["proxy_value"]
        .as_str()
        .or_else(|| secret["proxy_value"].as_str())
}

fn resolve_placeholder_source_values(value: &mut Value, source_policy: &SourcePolicy) {
    match value {
        Value::Mapping(map) => {
            if let Some(placeholder) = map
                .get(&string_value("placeholder"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
            {
                let json_key = map
                    .get(&string_value("json_key"))
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned);
                *value = source_policy.source_for(&placeholder, json_key.as_deref());
                return;
            }
            if map.get(&string_value("type")).and_then(Value::as_str) == Some("token_broker")
                && !map.contains_key(&string_value("ttl"))
            {
                map.insert(
                    string_value("ttl"),
                    string_value(&source_policy.token_broker_ttl),
                );
            }
            for child in map.values_mut() {
                resolve_placeholder_source_values(child, source_policy);
            }
        }
        Value::Sequence(values) => {
            for child in values {
                resolve_placeholder_source_values(child, source_policy);
            }
        }
        _ => {}
    }
}

fn existing_unmanaged_transforms(cfg: &Mapping) -> Vec<Value> {
    cfg.get(&string_value("transforms"))
        .and_then(Value::as_sequence)
        .into_iter()
        .flatten()
        .filter(|transform| {
            transform_name(transform).is_none_or(|name| !MANAGED_TRANSFORMS.contains(&name))
        })
        .cloned()
        .collect()
}

fn merge_managed_transforms(transforms: Vec<Value>) -> Vec<Value> {
    let mut merged = Vec::<Value>::new();
    let mut by_name = BTreeMap::<String, usize>::new();
    for transform in transforms {
        let Some(name) = transform_name(&transform).map(ToOwned::to_owned) else {
            merged.push(transform);
            continue;
        };
        if !MANAGED_TRANSFORMS.contains(&name.as_str()) {
            merged.push(transform);
            continue;
        }
        if let Some(index) = by_name.get(&name).copied() {
            merge_transform_config(&mut merged[index], transform);
        } else {
            by_name.insert(name, merged.len());
            merged.push(transform);
        }
    }
    merged
}

fn merge_transform_config(target: &mut Value, source: Value) {
    let Some(target_config) = target
        .as_mapping_mut()
        .and_then(|map| map.get_mut(&string_value("config")))
        .and_then(Value::as_mapping_mut)
    else {
        return;
    };
    let Some(source_config) = source
        .as_mapping()
        .and_then(|map| map.get(&string_value("config")))
        .and_then(Value::as_mapping)
    else {
        return;
    };
    for (key, source_value) in source_config {
        match target_config.get_mut(key) {
            Some(Value::Sequence(target_items)) => {
                if let Value::Sequence(source_items) = source_value {
                    target_items.extend(source_items.iter().cloned());
                }
            }
            Some(_) => {}
            None => {
                target_config.insert(key.clone(), source_value.clone());
            }
        }
    }
}

fn insert_before_header_allowlist(transforms: &mut Vec<Value>, managed: Vec<Value>) {
    if let Some(index) = transforms
        .iter()
        .position(|transform| transform_name(transform) == Some("header_allowlist"))
    {
        transforms.splice(index..index, managed);
    } else {
        transforms.extend(managed);
    }
}

fn transform_name(value: &Value) -> Option<&str> {
    value
        .as_mapping()
        .and_then(|map| map.get(&string_value("name")))
        .and_then(Value::as_str)
}

fn core_pg_listener_value(core_pg: &CorePgListener) -> Value {
    mapping([
        ("name", string_value(CENTAUR_CORE_PG_LISTENER)),
        ("listen", string_value(format!("0.0.0.0:{}", core_pg.port))),
        (
            "upstream",
            mapping([(
                "dsn",
                mapping([
                    ("type", string_value("env")),
                    ("var", string_value(&core_pg.dsn_env_var)),
                ]),
            )]),
        ),
        (
            "client",
            mapping([
                ("user", string_value("app_user")),
                ("password_env", string_value(&core_pg.password_env)),
            ]),
        ),
    ])
}

fn mapping<const N: usize>(items: [(&str, Value); N]) -> Value {
    let mut map = Mapping::new();
    for (key, value) in items {
        map.insert(string_value(key), value);
    }
    Value::Mapping(map)
}

fn string_value(value: impl AsRef<str>) -> Value {
    Value::String(value.as_ref().to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn parse_rendered(rendered: &str) -> Value {
        serde_yaml::from_str(rendered).unwrap()
    }

    fn transform_names(cfg: &Value) -> Vec<&str> {
        cfg["transforms"]
            .as_sequence()
            .unwrap()
            .iter()
            .map(|value| value["name"].as_str().unwrap())
            .collect()
    }

    fn fragment_yaml(yaml: &str) -> ProxyFragment {
        serde_yaml::from_str(yaml).unwrap()
    }

    #[test]
    fn source_policy_reads_kubernetes_prefixed_env() {
        let vars = BTreeMap::from([
            (
                "KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE".to_owned(),
                "onepassword-connect".to_owned(),
            ),
            ("OP_VAULT".to_owned(), "prod-agents".to_owned()),
            (
                "KUBERNETES_FIREWALL_MANAGER_SECRET_TTL".to_owned(),
                "20m".to_owned(),
            ),
            (
                "KUBERNETES_FIREWALL_MANAGER_TOKEN_BROKER_TTL".to_owned(),
                "45s".to_owned(),
            ),
        ]);
        let policy = SourcePolicy::from_lookup(|name| vars.get(name).cloned());

        assert_eq!(policy.kind, SourceKind::OnePasswordConnect);
        assert_eq!(policy.op_vault, "prod-agents");
        assert_eq!(policy.ttl, "20m");
        assert_eq!(policy.token_broker_ttl, "45s");
    }

    fn temp_dir(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "centaur-iron-proxy-{name}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn inserts_fragment_transforms_before_header_allowlist() {
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: secrets
    config:
      secrets: []
  - name: gcp_auth
    config:
      keyfile: { type: env, var: GCP }
      scopes: ["scope"]
      rules: [{ host: "*.googleapis.com" }]
  - name: oauth_token
    config:
      tokens: []
  - name: hmac_sign
    config:
      rules: [{ host: api.example.com }]
"#,
        );
        let rendered = render_proxy_yaml(None, &[fragment], None).unwrap();
        let cfg = parse_rendered(&rendered);
        assert_eq!(
            transform_names(&cfg),
            vec![
                "allowlist",
                "secrets",
                "gcp_auth",
                "oauth_token",
                "hmac_sign",
                "header_allowlist",
            ]
        );
    }

    #[test]
    fn replaces_managed_transforms_from_base_config() {
        let base = r#"
transforms:
  - name: allowlist
    config: { domains: ["*"] }
  - name: secrets
    config: { secrets: [{ old: true }] }
  - name: header_allowlist
    config: { headers: ["host"] }
"#;
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: secrets
    config:
      secrets:
        - source: { type: env, var: OPENAI_API_KEY }
          replace:
            proxy_value: OPENAI_API_KEY
            match_headers: ["Authorization"]
          rules: [{ host: api.openai.com }]
"#,
        );
        let rendered = render_proxy_yaml(Some(base), &[fragment], None).unwrap();
        let cfg = parse_rendered(&rendered);
        assert_eq!(
            transform_names(&cfg),
            vec!["allowlist", "secrets", "header_allowlist"]
        );
        assert_eq!(
            cfg["transforms"][1]["config"]["secrets"][0]["source"]["var"],
            "OPENAI_API_KEY"
        );
        assert!(cfg["transforms"][1]["config"]["secrets"][0]["old"].is_null());
    }

    #[test]
    fn merges_managed_secret_transforms_from_infra_and_harness_fragments() {
        let infra = infra_fragment().unwrap();
        let codex = harness_fragment("codex", "api_key").unwrap().unwrap();

        let rendered = render_proxy_yaml(None, &[infra, codex], None).unwrap();
        let cfg = parse_rendered(&rendered);

        assert_eq!(
            transform_names(&cfg),
            vec!["allowlist", "secrets", "header_allowlist"]
        );
        let secrets = cfg["transforms"][1]["config"]["secrets"]
            .as_sequence()
            .unwrap();
        assert_eq!(secrets.len(), 6);
        assert!(
            secrets
                .iter()
                .any(|secret| secret["source"]["var"].as_str() == Some("OPENAI_API_KEY"))
        );
        assert!(
            secrets
                .iter()
                .any(|secret| secret["source"]["var"].as_str() == Some("GITHUB_TOKEN"))
        );
    }

    #[test]
    fn appends_core_pg_listener_after_fragment_postgres() {
        let fragment = fragment_yaml(
            r#"
postgres:
  - name: analytics
    listen: 0.0.0.0:5432
    upstream:
      dsn: { type: env, var: ANALYTICS_DSN }
    client:
      user: app_user
      password_env: PG_PROXY_PASSWORD_ANALYTICS
"#,
        );
        let rendered = render_proxy_yaml(
            None,
            &[fragment],
            Some(&CorePgListener::new(
                5433,
                "CENTAUR_DATABASE_URL",
                "PG_PROXY_PASSWORD_CENTAUR_CORE",
            )),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        let postgres = cfg["postgres"].as_sequence().unwrap();
        assert_eq!(postgres[0]["name"], "analytics");
        assert_eq!(postgres[1]["name"], CENTAUR_CORE_PG_LISTENER);
        assert_eq!(postgres[1]["listen"], "0.0.0.0:5433");
        assert_eq!(postgres[1]["upstream"]["dsn"]["type"], "env");
        assert_eq!(
            postgres[1]["upstream"]["dsn"]["var"],
            "CENTAUR_DATABASE_URL"
        );
    }

    #[test]
    fn preserves_extra_top_level_config_from_fragments() {
        let fragment = fragment_yaml(
            r#"
mcp:
  servers:
    - name: github
      rules: [{ host: mcp.github.com }]
      tools:
        - name: search_repositories
"#,
        );
        let rendered = render_proxy_yaml(None, &[fragment], None).unwrap();
        let cfg = parse_rendered(&rendered);
        assert_eq!(cfg["mcp"]["servers"][0]["name"], "github");
    }

    #[test]
    fn resolves_placeholders_in_postgres_and_top_level_config() {
        let fragment = fragment_yaml(
            r#"
postgres:
  - name: warehouse
    listen: 0.0.0.0:5432
    upstream:
      dsn:
        placeholder: WAREHOUSE_DSN
    client:
      user: app_user
      password_env: PG_PROXY_PASSWORD_WAREHOUSE
mcp:
  servers:
    - name: github
      auth:
        placeholder: GITHUB_TOKEN
"#,
        );
        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
            None,
            &SourcePolicy::onepassword("ai-agents", "10m"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        assert_eq!(
            cfg["postgres"][0]["upstream"]["dsn"]["secret_ref"],
            "op://ai-agents/WAREHOUSE_DSN/credential"
        );
        assert_eq!(
            cfg["mcp"]["servers"][0]["auth"]["secret_ref"],
            "op://ai-agents/GITHUB_TOKEN/credential"
        );
        assert!(!rendered.contains("placeholder:"));
    }

    #[test]
    fn extracts_pg_dsn_envs_and_strips_centaur_postgres_extensions() {
        let fragment = fragment_yaml(
            r#"
postgres:
  - name: warehouse
    listen: 0.0.0.0:5440
    upstream:
      dsn:
        placeholder: WAREHOUSE_DSN_UPSTREAM
    client:
      user: app_user
      password_env: PG_PROXY_PASSWORD_WAREHOUSE
    sandbox_env:
      name: WAREHOUSE_DSN
      database: warehouse
"#,
        );

        assert_eq!(
            pg_dsn_envs(&[fragment.clone()]),
            vec![PgDsnEnv {
                env_name: "WAREHOUSE_DSN".to_owned(),
                database: "warehouse".to_owned(),
                port: 5440,
                password_env: "PG_PROXY_PASSWORD_WAREHOUSE".to_owned(),
            }]
        );

        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
            None,
            &SourcePolicy::onepassword("ai-agents", "10m"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        assert!(cfg["postgres"][0]["sandbox_env"].is_null());
        assert_eq!(
            cfg["postgres"][0]["upstream"]["dsn"]["secret_ref"],
            "op://ai-agents/WAREHOUSE_DSN_UPSTREAM/credential"
        );
    }

    #[test]
    fn extracts_placeholder_env_from_replace_mode_secrets() {
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: secrets
    config:
      secrets:
        - source: { type: env, var: OPENAI_API_KEY }
          replace:
            proxy_value: OPENAI_API_KEY
            match_headers: ["Authorization"]
          rules: [{ host: api.openai.com }]
        - source: { type: token_broker, credential_id: openai-codex, ttl: 1m }
          inject:
            header: Authorization
            formatter: "Bearer {{.Value}}"
          rules: [{ host: chatgpt.com }]
"#,
        );
        assert_eq!(
            placeholder_env(&[fragment]),
            BTreeMap::from([("OPENAI_API_KEY".to_owned(), "OPENAI_API_KEY".to_owned())])
        );
    }

    #[test]
    fn supports_legacy_secret_proxy_value_shape() {
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: secrets
    config:
      secrets:
        - proxy_value: LEGACY_API_KEY
          match_headers: ["Authorization"]
          rules: [{ host: api.example.com }]
"#,
        );
        assert_eq!(
            placeholder_env(&[fragment.clone()]),
            BTreeMap::from([("LEGACY_API_KEY".to_owned(), "LEGACY_API_KEY".to_owned())])
        );

        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
            None,
            &SourcePolicy::onepassword_connect("ai-agents", "10m"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        let secrets_transform = cfg["transforms"]
            .as_sequence()
            .unwrap()
            .iter()
            .find(|transform| transform["name"].as_str() == Some("secrets"))
            .unwrap();
        assert_eq!(
            secrets_transform["config"]["secrets"][0]["source"]["secret_ref"],
            "op://ai-agents/LEGACY_API_KEY/credential"
        );
    }

    #[test]
    fn assigns_stable_unique_secret_ids() {
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: secrets
    config:
      secrets:
        - id: explicit-api-key
          replace:
            proxy_value: OPENAI_API_KEY
            match_headers: ["Authorization"]
          rules: [{ host: api.openai.com }]
        - replace:
            proxy_value: OPENAI_API_KEY
            match_headers: ["Authorization"]
          rules: [{ host: api.openai.com }]
        - replace:
            proxy_value: OPENAI_API_KEY
            match_headers: ["Authorization"]
          rules: [{ host: proxy.openai.com }]
        - source: { type: token_broker, credential_id: openai-codex }
          inject:
            header: Authorization
            formatter: "Bearer {{.Value}}"
          rules: [{ host: chatgpt.com }]
        - source:
            placeholder: OPENAI_CODEX_ACCOUNT_ID
          inject:
            header: chatgpt-account-id
          rules: [{ host: chatgpt.com }]
"#,
        );
        let env_rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment.clone()],
            None,
            &SourcePolicy::env(),
        )
        .unwrap();
        let op_rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
            None,
            &SourcePolicy::onepassword_connect("ai-agents", "10m"),
        )
        .unwrap();

        let ids = |rendered: &str| -> Vec<String> {
            let cfg = parse_rendered(rendered);
            cfg["transforms"][1]["config"]["secrets"]
                .as_sequence()
                .unwrap()
                .iter()
                .map(|secret| secret["id"].as_str().unwrap().to_owned())
                .collect()
        };
        let env_ids = ids(&env_rendered);
        let op_ids = ids(&op_rendered);
        assert_eq!(env_ids, op_ids);
        assert_eq!(env_ids[0], "explicit-api-key");
        assert!(env_ids[1].starts_with("openai-api-key-"));
        assert!(env_ids[2].starts_with("openai-api-key-"));
        assert!(env_ids[3].starts_with("openai-codex-"));
        assert!(env_ids[4].starts_with("openai-codex-account-id-"));
        let mut unique_ids = env_ids.clone();
        unique_ids.sort();
        unique_ids.dedup();
        assert_eq!(unique_ids.len(), env_ids.len());
    }

    #[test]
    fn extracts_proxy_and_postgres_listen_ports() {
        let rendered = render_proxy_yaml(
            None,
            &[fragment_yaml(
                r#"
postgres:
  - name: warehouse
    listen: 0.0.0.0:5432
    upstream:
      dsn: { type: env, var: WAREHOUSE_DSN }
    client:
      user: app_user
      password_env: PG_PROXY_PASSWORD_WAREHOUSE
"#,
            )],
            Some(&CorePgListener::new(
                5433,
                "CENTAUR_DATABASE_URL",
                "PG_PROXY_PASSWORD_CENTAUR_CORE",
            )),
        )
        .unwrap();
        assert_eq!(
            listen_ports_from_yaml(&rendered).unwrap(),
            vec![5432, 5433, 8080]
        );
        assert_eq!(proxy_listen_port_from_yaml(&rendered).unwrap(), 8080);
        let rendered = render_proxy_yaml(
            Some(
                r#"
proxy:
  tunnel_listen: ":18080"
transforms: []
"#,
            ),
            &[],
            None,
        )
        .unwrap();
        assert_eq!(listen_ports_from_yaml(&rendered).unwrap(), vec![18080]);
        assert_eq!(proxy_listen_port_from_yaml(&rendered).unwrap(), 18080);
    }

    #[test]
    fn fills_missing_sources_from_operator_policy() {
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: secrets
    config:
      secrets:
        - replace:
            proxy_value: SLACK_BOT_TOKEN
            match_headers: ["Authorization"]
          rules: [{ host: slack.com }]
        - source:
            placeholder: OPENAI_CODEX_ACCOUNT_ID
          inject:
            header: chatgpt-account-id
          rules: [{ host: chatgpt.com }]
  - name: oauth_token
    config:
      tokens:
        - grant: refresh_token
          refresh_token:
            placeholder: GOOGLE_TOKEN_JSON
            json_key: refresh_token
          token_endpoint: https://oauth2.googleapis.com/token
          rules: [{ host: gmail.googleapis.com }]
"#,
        );
        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
            None,
            &SourcePolicy::onepassword_connect("engineering", "5m"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        let secrets = cfg["transforms"][1]["config"]["secrets"]
            .as_sequence()
            .unwrap();
        assert_eq!(secrets[0]["source"]["type"], "1password_connect");
        assert_eq!(
            secrets[0]["source"]["secret_ref"],
            "op://engineering/SLACK_BOT_TOKEN/credential"
        );
        assert_eq!(
            secrets[1]["source"]["secret_ref"],
            "op://engineering/OPENAI_CODEX_ACCOUNT_ID/credential"
        );
        let token = &cfg["transforms"][2]["config"]["tokens"][0];
        assert_eq!(
            token["refresh_token"]["secret_ref"],
            "op://engineering/GOOGLE_TOKEN_JSON/credential"
        );
        assert_eq!(token["refresh_token"]["json_key"], "refresh_token");
        assert!(!rendered.contains("placeholder:"));
    }

    #[test]
    fn resolves_placeholders_in_non_secret_managed_transforms() {
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: gcp_auth
    config:
      keyfile:
        placeholder: GCP_KEYFILE_JSON
      scopes: ["https://www.googleapis.com/auth/cloud-platform"]
      rules: [{ host: "*.googleapis.com" }]
  - name: oauth_token
    config:
      tokens:
        - grant: refresh_token
          client_id:
            placeholder: GOOGLE_OAUTH_JSON
            json_key: client_id
          client_secret:
            placeholder: GOOGLE_OAUTH_JSON
            json_key: client_secret
          refresh_token:
            placeholder: GOOGLE_REFRESH_TOKEN
          token_endpoint: https://oauth2.googleapis.com/token
          token_endpoint_headers:
            x-api-key:
              placeholder: TOKEN_ENDPOINT_API_KEY
          rules: [{ host: gmail.googleapis.com }]
  - name: hmac_sign
    config:
      timestamp: { format: unix }
      signature:
        algorithm: hmac-sha256
        key_encoding: utf8
        output_encoding: hex
        message: "{{.Method}}:{{.Path}}"
      credentials:
        signing_key:
          placeholder: HMAC_SIGNING_KEY
      headers:
        - { name: x-signature, value: "{{.Signature}}" }
      rules: [{ host: signed.example.com }]
"#,
        );
        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
            None,
            &SourcePolicy::onepassword("ai-agents", "10m"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        assert_eq!(cfg["transforms"][1]["name"], "gcp_auth");
        assert_eq!(
            cfg["transforms"][1]["config"]["keyfile"]["secret_ref"],
            "op://ai-agents/GCP_KEYFILE_JSON/credential"
        );
        let token = &cfg["transforms"][2]["config"]["tokens"][0];
        assert_eq!(
            token["client_id"]["secret_ref"],
            "op://ai-agents/GOOGLE_OAUTH_JSON/credential"
        );
        assert_eq!(token["client_id"]["json_key"], "client_id");
        assert_eq!(
            token["token_endpoint_headers"]["x-api-key"]["secret_ref"],
            "op://ai-agents/TOKEN_ENDPOINT_API_KEY/credential"
        );
        assert_eq!(
            cfg["transforms"][3]["config"]["credentials"]["signing_key"]["secret_ref"],
            "op://ai-agents/HMAC_SIGNING_KEY/credential"
        );
        assert!(!rendered.contains("placeholder:"));
    }

    #[test]
    fn loads_builtin_harness_fragments() {
        let codex = harness_fragment("codex", "api_key").unwrap().unwrap();
        assert_eq!(
            placeholder_env(&[codex]),
            BTreeMap::from([("OPENAI_API_KEY".to_owned(), "OPENAI_API_KEY".to_owned())])
        );
        let codex_access = harness_fragment("codex", "access_token").unwrap().unwrap();
        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &[codex_access],
            None,
            &SourcePolicy::onepassword("ai-agents", "10m"),
        )
        .unwrap();
        assert!(rendered.contains("token_broker"));
        assert!(rendered.contains("ttl: 1m"));
        assert!(rendered.contains("chatgpt-account-id"));
        assert!(!rendered.contains("placeholder:"));
    }

    #[test]
    fn access_token_harness_fragments_do_not_expose_static_api_key_placeholders() {
        let codex_access = harness_fragment("codex", "access_token").unwrap().unwrap();
        let claude_access = harness_fragment("claude-code", "access_token")
            .unwrap()
            .unwrap();
        let fragments = vec![codex_access, claude_access];

        assert!(placeholder_env(&fragments).is_empty());

        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &fragments,
            None,
            &SourcePolicy::onepassword_connect("prod-agents", "10m"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        let secrets = cfg["transforms"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter(|transform| transform["name"].as_str() == Some("secrets"))
            .flat_map(|transform| transform["config"]["secrets"].as_sequence().unwrap().iter())
            .collect::<Vec<_>>();
        let by_host = secrets
            .iter()
            .map(|secret| {
                (
                    secret["rules"][0]["host"].as_str().unwrap(),
                    secret["source"]["type"].as_str().unwrap_or(""),
                    secret,
                )
            })
            .collect::<Vec<_>>();

        assert!(by_host.iter().any(|(host, source_type, secret)| {
            *host == "chatgpt.com"
                && *source_type == "token_broker"
                && secret["source"]["credential_id"] == "openai-codex"
        }));
        assert!(by_host.iter().any(|(host, source_type, secret)| {
            *host == "api.anthropic.com"
                && *source_type == "token_broker"
                && secret["source"]["credential_id"] == "anthropic-claude"
        }));
        assert!(by_host.iter().any(|(host, source_type, secret)| {
            *host == "chatgpt.com"
                && *source_type == "1password_connect"
                && secret["inject"]["header"] == "chatgpt-account-id"
        }));
        assert!(!rendered.contains("OPENAI_API_KEY"));
        assert!(!rendered.contains("ANTHROPIC_API_KEY"));
        assert!(!rendered.contains("placeholder:"));
    }

    #[test]
    fn renders_token_broker_ttl_from_source_policy() {
        let fragment = fragment_yaml(
            r#"
transforms:
  - name: secrets
    config:
      secrets:
        - source:
            type: token_broker
            credential_id: openai-codex
          inject:
            header: Authorization
            formatter: "Bearer {{.Value}}"
          rules: [{ host: chatgpt.com }]
"#,
        );
        let rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
            None,
            &SourcePolicy::env().with_token_broker_ttl("30s"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        let secret = &cfg["transforms"][1]["config"]["secrets"][0];
        assert_eq!(secret["source"]["ttl"], "30s");
    }

    #[test]
    fn renders_token_broker_yaml_from_fragments() {
        let mut fragments = harness_broker_fragments().unwrap();
        fragments.push(fragment_yaml(
            r#"
broker_credentials:
  - id: okta
    token_endpoint: https://idp.example.com/oauth/token
    client_id:
      placeholder: OKTA_BUNDLE
      json_key: client_id
    client_secret:
      placeholder: OKTA_BUNDLE
      json_key: client_secret
    token_endpoint_headers:
      x-api-key:
        placeholder: OKTA_API_KEY
    store:
      placeholder: OKTA_BLOB
  - id: openai-codex
    token_endpoint: https://duplicate.example.com/oauth/token
    client_id:
      placeholder: DUPLICATE_CLIENT_ID
    store:
      placeholder: DUPLICATE_BLOB
"#,
        ));

        let rendered = render_token_broker_yaml_with_source_policy(
            &fragments,
            &SourcePolicy::onepassword_connect("prod-agents", "10m"),
        )
        .unwrap();
        let cfg = parse_rendered(&rendered);
        assert_eq!(cfg["listen"], ":8181");
        assert_eq!(cfg["metrics_listen"], ":9091");
        assert_eq!(cfg["bearer_auth_env"], BROKER_BEARER_AUTH_ENV);
        let credentials = cfg["credentials"].as_sequence().unwrap();
        let by_id = credentials
            .iter()
            .map(|credential| (credential["id"].as_str().unwrap(), credential))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            by_id.keys().copied().collect::<Vec<_>>(),
            vec!["anthropic-claude", "okta", "openai-codex"]
        );
        assert_eq!(
            by_id["anthropic-claude"]["token_endpoint"],
            "https://console.anthropic.com/v1/oauth/token"
        );
        assert_eq!(
            by_id["openai-codex"]["token_endpoint"],
            "https://auth.openai.com/oauth/token"
        );
        assert_eq!(by_id["okta"]["client_id"]["type"], "1password_connect");
        assert_eq!(
            by_id["okta"]["client_id"]["secret_ref"],
            "op://prod-agents/OKTA_BUNDLE/credential"
        );
        assert_eq!(by_id["okta"]["client_id"]["json_key"], "client_id");
        assert_eq!(by_id["okta"]["store"]["type"], "1password_connect");
        assert_eq!(
            by_id["okta"]["store"]["secret_ref"],
            "op://prod-agents/OKTA_BLOB/credential"
        );
        assert!(!rendered.contains("placeholder:"));
    }

    #[test]
    fn rejects_env_backed_token_broker_store() {
        let fragment = fragment_yaml(
            r#"
broker_credentials:
  - id: openai-codex
    token_endpoint: https://auth.openai.com/oauth/token
    client_id:
      placeholder: OPENAI_CODEX_CLIENT_ID
    store:
      placeholder: OPENAI_CODEX_BLOB
"#,
        );

        let err = render_token_broker_yaml_with_source_policy(&[fragment], &SourcePolicy::env())
            .unwrap_err();
        assert!(
            matches!(err, IronProxyConfigError::BrokerStoreEnv { placeholder } if placeholder == "OPENAI_CODEX_BLOB")
        );
    }

    #[test]
    fn rejects_token_broker_store_json_key() {
        let fragment = fragment_yaml(
            r#"
broker_credentials:
  - id: openai-codex
    token_endpoint: https://auth.openai.com/oauth/token
    client_id:
      placeholder: OPENAI_CODEX_CLIENT_ID
    store:
      placeholder: OPENAI_CODEX_BUNDLE
      json_key: refresh_token
"#,
        );

        let err = render_token_broker_yaml_with_source_policy(
            &[fragment],
            &SourcePolicy::onepassword("ai-agents", "10m"),
        )
        .unwrap_err();
        assert!(
            matches!(err, IronProxyConfigError::BrokerStoreJsonKey { placeholder } if placeholder == "OPENAI_CODEX_BUNDLE")
        );
    }

    #[test]
    fn loads_builtin_infra_fragment() {
        let fragment = infra_fragment().unwrap();
        let placeholders = placeholder_env(&[fragment]);
        for name in [
            "AMP_API_KEY",
            "GEMINI_API_KEY",
            "GITHUB_TOKEN",
            "SLACK_BOT_TOKEN",
            "XAI_API_KEY",
        ] {
            assert_eq!(placeholders.get(name).map(String::as_str), Some(name));
        }
    }

    #[test]
    fn discovers_tool_local_iron_yaml_fragments() {
        let root = temp_dir("discover");
        let base_tool = root.join("tools").join("base").join("websearch");
        let overlay_tool = root.join("overlay").join("tools").join("slack");
        fs::create_dir_all(&base_tool).unwrap();
        fs::create_dir_all(&overlay_tool).unwrap();
        fs::write(base_tool.join("iron.yaml"), "transforms: []\n").unwrap();
        fs::write(overlay_tool.join("iron.yaml"), "transforms: []\n").unwrap();
        fs::write(root.join("iron-proxy.yaml"), "transforms: []\n").unwrap();

        let discovered = discover_fragment_files(&[root.join("tools"), root.join("overlay")])
            .unwrap()
            .into_iter()
            .map(|path| path.strip_prefix(&root).unwrap().to_path_buf())
            .collect::<Vec<_>>();

        assert_eq!(
            discovered,
            vec![
                PathBuf::from("overlay/tools/slack/iron.yaml"),
                PathBuf::from("tools/base/websearch/iron.yaml"),
            ]
        );

        fs::remove_dir_all(root).unwrap();
    }
}
