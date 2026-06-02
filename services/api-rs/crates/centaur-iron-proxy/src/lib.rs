use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const DEFAULT_PROXY_BASE_CONFIG: &str =
    include_str!("../../../../api/api/iron-proxy.base.yaml");
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

    fn source_for(&self, placeholder: &str, json_key: Option<&str>) -> Result<Value> {
        let json_key = json_key.map(ToOwned::to_owned);
        let source = match self.kind {
            SourceKind::Env => SecretSource::Env {
                var: placeholder.to_owned(),
                json_key,
            },
            SourceKind::OnePassword => SecretSource::OnePassword {
                secret_ref: self.secret_ref(placeholder),
                ttl: self.ttl.clone(),
                json_key,
            },
            SourceKind::OnePasswordConnect => SecretSource::OnePasswordConnect {
                secret_ref: self.secret_ref(placeholder),
                ttl: self.ttl.clone(),
                json_key,
            },
        };
        serde_yaml::to_value(source).map_err(IronProxyConfigError::Serialize)
    }

    fn store_source_for(&self, placeholder: &str) -> Result<Value> {
        match self.kind {
            SourceKind::Env => Err(IronProxyConfigError::BrokerStoreEnv {
                placeholder: placeholder.to_owned(),
            }),
            SourceKind::OnePassword | SourceKind::OnePasswordConnect => {
                self.source_for(placeholder, None)
            }
        }
    }

    fn secret_ref(&self, placeholder: &str) -> String {
        format!("op://{}/{placeholder}/credential", self.op_vault)
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

#[derive(Serialize)]
#[serde(tag = "type")]
enum SecretSource {
    #[serde(rename = "env")]
    Env {
        var: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        json_key: Option<String>,
    },
    #[serde(rename = "1password")]
    OnePassword {
        secret_ref: String,
        ttl: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        json_key: Option<String>,
    },
    #[serde(rename = "1password_connect")]
    OnePasswordConnect {
        secret_ref: String,
        ttl: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        json_key: Option<String>,
    },
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProxyFragment {
    #[serde(default)]
    pub transforms: Vec<Transform>,
    #[serde(default)]
    pub postgres: Vec<PostgresListener>,
    #[serde(default)]
    pub broker_credentials: Vec<BrokerCredential>,
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

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ProxyConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    transforms: Vec<Transform>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    postgres: Vec<PostgresListener>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proxy: Option<ProxySection>,
    #[serde(default, flatten)]
    top_level: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct ProxySection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tunnel_listen: Option<String>,
    #[serde(default, flatten)]
    extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Transform {
    pub name: String,
    #[serde(default, skip_serializing_if = "TransformConfig::is_empty")]
    pub config: TransformConfig,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Transform {
    fn is_managed(&self) -> bool {
        MANAGED_TRANSFORMS.contains(&self.name.as_str())
    }

    fn is_secrets(&self) -> bool {
        self.name == "secrets"
    }

    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if self.is_secrets() {
            for secret in &mut self.config.secrets {
                secret.fill_missing_source(source_policy)?;
            }
        }
        self.config.resolve_sources(source_policy)?;
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TransformConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<Secret>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl TransformConfig {
    fn is_empty(&self) -> bool {
        self.secrets.is_empty() && self.extra.is_empty()
    }

    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        for secret in &mut self.secrets {
            secret.resolve_sources(source_policy)?;
        }
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Secret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<SecretReplace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inject: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_value: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Secret {
    fn explicit_id(&self) -> Option<&str> {
        self.id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }

    fn proxy_value(&self) -> Option<&str> {
        self.replace
            .as_ref()
            .and_then(|replace| replace.proxy_value.as_deref())
            .or(self.proxy_value.as_deref())
    }

    fn fill_missing_source(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if self.source.is_some() {
            return Ok(());
        }
        if let Some(proxy_value) = self.proxy_value() {
            self.source = Some(source_policy.source_for(proxy_value, None)?);
        }
        Ok(())
    }

    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if let Some(source) = &mut self.source {
            resolve_placeholder_source_values(source, source_policy)?;
        }
        if let Some(replace) = &mut self.replace {
            replace.resolve_sources(source_policy)?;
        }
        if let Some(inject) = &mut self.inject {
            resolve_placeholder_source_values(inject, source_policy)?;
        }
        resolve_source_values(&mut self.rules, source_policy)?;
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SecretReplace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_value: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl SecretReplace {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PostgresListener {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<PostgresUpstream>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<PostgresClient>,
    #[serde(default, skip_serializing)]
    pub sandbox_env: Option<SandboxEnv>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl PostgresListener {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if let Some(upstream) = &mut self.upstream {
            upstream.resolve_sources(source_policy)?;
        }
        if let Some(client) = &mut self.client {
            client.resolve_sources(source_policy)?;
        }
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PostgresUpstream {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsn: Option<Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl PostgresUpstream {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if let Some(dsn) = &mut self.dsn {
            resolve_placeholder_source_values(dsn, source_policy)?;
        }
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PostgresClient {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_env: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl PostgresClient {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SandboxEnv {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BrokerCredential {
    pub id: String,
    pub token_endpoint: String,
    pub client_id: Value,
    pub store: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub token_endpoint_headers: BTreeMap<String, Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl BrokerCredential {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        resolve_placeholder_source_values(&mut self.client_id, source_policy)?;
        resolve_broker_store_source(&mut self.store, source_policy)?;
        if let Some(client_secret) = &mut self.client_secret {
            resolve_placeholder_source_values(client_secret, source_policy)?;
        }
        resolve_source_values(self.token_endpoint_headers.values_mut(), source_policy)?;
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Serialize)]
struct TokenBrokerConfig {
    listen: String,
    metrics_listen: String,
    bearer_auth_env: &'static str,
    log: TokenBrokerLogConfig,
    credentials: Vec<BrokerCredential>,
}

impl TokenBrokerConfig {
    fn new(credentials: Vec<BrokerCredential>) -> Self {
        Self {
            listen: format!(":{DEFAULT_BROKER_LISTEN_PORT}"),
            metrics_listen: format!(":{DEFAULT_BROKER_METRICS_PORT}"),
            bearer_auth_env: BROKER_BEARER_AUTH_ENV,
            log: TokenBrokerLogConfig {
                level: "info",
                format: "json",
            },
            credentials,
        }
    }
}

#[derive(Serialize)]
struct TokenBrokerLogConfig {
    level: &'static str,
    format: &'static str,
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
    .into_iter()
    .map(load_fragment_str)
    .collect()
}

pub fn placeholder_env(fragments: &[ProxyFragment]) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();
    for fragment in fragments {
        for transform in &fragment.transforms {
            if !transform.is_secrets() {
                continue;
            }
            for secret in &transform.config.secrets {
                let Some(proxy_value) = secret.proxy_value() else {
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
    let cfg: ProxyConfig =
        serde_yaml::from_str(config_yaml).map_err(IronProxyConfigError::ParseBase)?;
    let mut ports = Vec::new();
    ports.push(proxy_listen_port_from_config(&cfg));
    for listener in &cfg.postgres {
        if let Some(port) = listener.listen.as_deref().and_then(listen_port) {
            ports.push(port);
        }
    }
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}

pub fn proxy_listen_port_from_yaml(config_yaml: &str) -> Result<u16> {
    let cfg: ProxyConfig =
        serde_yaml::from_str(config_yaml).map_err(IronProxyConfigError::ParseBase)?;
    Ok(proxy_listen_port_from_config(&cfg))
}

fn proxy_listen_port_from_config(cfg: &ProxyConfig) -> u16 {
    cfg.proxy
        .as_ref()
        .and_then(|proxy| proxy.tunnel_listen.as_deref())
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
        let Some(sandbox_env) = &listener.sandbox_env else {
            continue;
        };
        let Some(env_name) = sandbox_env
            .name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(database) = sandbox_env
            .database
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        let Some(port) = listener.listen.as_deref().and_then(listen_port) else {
            continue;
        };
        let Some(password_env) = listener
            .client
            .as_ref()
            .and_then(|client| client.password_env.as_deref())
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

pub fn render_proxy_yaml(base_config: Option<&str>, fragments: &[ProxyFragment]) -> Result<String> {
    render_proxy_yaml_with_source_policy(base_config, fragments, &SourcePolicy::default())
}

pub fn render_proxy_yaml_with_source_policy(
    base_config: Option<&str>,
    fragments: &[ProxyFragment],
    source_policy: &SourcePolicy,
) -> Result<String> {
    let mut cfg: ProxyConfig =
        serde_yaml::from_str(base_config.unwrap_or(DEFAULT_PROXY_BASE_CONFIG))
            .map_err(IronProxyConfigError::ParseBase)?;

    for fragment in fragments {
        for (key, value) in &fragment.top_level {
            let mut value = value.clone();
            resolve_placeholder_source_values(&mut value, source_policy)?;
            cfg.top_level.insert(key.clone(), value);
        }
    }

    let mut transforms = existing_unmanaged_transforms(cfg.transforms);
    let mut managed = fragments
        .iter()
        .flat_map(|fragment| fragment.transforms.iter().cloned())
        .collect::<Vec<_>>();
    assign_secret_ids(&mut managed)?;
    for transform in &mut managed {
        transform.resolve_sources(source_policy)?;
    }
    if !managed.is_empty() {
        insert_before_header_allowlist(&mut transforms, managed);
    }
    cfg.transforms = transforms;

    let mut postgres = fragments
        .iter()
        .flat_map(|fragment| fragment.postgres.iter().cloned())
        .collect::<Vec<_>>();
    for listener in &mut postgres {
        listener.resolve_sources(source_policy)?;
    }
    cfg.postgres = postgres;

    serde_yaml::to_string(&cfg).map_err(IronProxyConfigError::Serialize)
}

pub fn render_token_broker_yaml(fragments: &[ProxyFragment]) -> Result<String> {
    render_token_broker_yaml_with_source_policy(fragments, &SourcePolicy::default())
}

pub fn render_token_broker_yaml_with_source_policy(
    fragments: &[ProxyFragment],
    source_policy: &SourcePolicy,
) -> Result<String> {
    let mut credentials = BTreeMap::<String, BrokerCredential>::new();
    for credential in fragments
        .iter()
        .flat_map(|fragment| fragment.broker_credentials.iter())
    {
        if credentials.contains_key(&credential.id) {
            continue;
        }
        let mut credential = credential.clone();
        credential.resolve_sources(source_policy)?;
        credentials.insert(credential.id.clone(), credential);
    }
    serde_yaml::to_string(&TokenBrokerConfig::new(credentials.into_values().collect()))
        .map_err(IronProxyConfigError::Serialize)
}

fn assign_secret_ids(transforms: &mut [Transform]) -> Result<()> {
    let mut used = BTreeMap::<String, usize>::new();
    for secret in transforms
        .iter()
        .filter(|transform| transform.is_secrets())
        .flat_map(|transform| transform.config.secrets.iter())
    {
        if let Some(id) = secret.explicit_id() {
            used.entry(id.to_owned()).or_insert(1);
        }
    }

    for transform in transforms
        .iter_mut()
        .filter(|transform| transform.is_secrets())
    {
        for secret in &mut transform.config.secrets {
            if secret.explicit_id().is_some() {
                continue;
            }
            let candidate = generated_secret_id(secret)?;
            secret.id = Some(unique_id(candidate, &mut used));
        }
    }
    Ok(())
}

fn generated_secret_id(secret: &Secret) -> Result<String> {
    let base = secret_id_base(secret);
    let digest = secret_identity_digest(secret)?;
    Ok(format!("{base}-{digest}"))
}

fn secret_id_base(secret: &Secret) -> String {
    let raw = secret
        .proxy_value()
        .or_else(|| value_field_str(secret.source.as_ref(), "credential_id"))
        .or_else(|| value_field_str(secret.source.as_ref(), "placeholder"))
        .or_else(|| value_field_str(secret.source.as_ref(), "var"))
        .or_else(|| value_field_str(secret.source.as_ref(), "secret_ref"))
        .or_else(|| value_field_str(secret.inject.as_ref(), "header"))
        .or_else(|| value_field_str(secret.inject.as_ref(), "query_param"))
        .or_else(|| {
            secret
                .rules
                .first()
                .and_then(|rule| value_field_str(Some(rule), "host"))
        })
        .unwrap_or("secret");
    let slug = slugify_id_component(raw);
    if slug.is_empty() {
        "secret".to_owned()
    } else {
        slug
    }
}

fn value_field_str<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?
        .as_mapping()?
        .get(&Value::String(key.to_owned()))?
        .as_str()
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

fn secret_identity_digest(secret: &Secret) -> Result<String> {
    let mut identity = secret.clone();
    identity.id = None;
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

fn resolve_source_values<'a>(
    values: impl IntoIterator<Item = &'a mut Value>,
    source_policy: &SourcePolicy,
) -> Result<()> {
    for value in values {
        resolve_placeholder_source_values(value, source_policy)?;
    }
    Ok(())
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

fn resolve_placeholder_source_values(
    value: &mut Value,
    source_policy: &SourcePolicy,
) -> Result<()> {
    if let Some(source_ref) = SourceReference::from_value(value) {
        if let Some(placeholder) = source_ref.placeholder {
            *value = source_policy.source_for(&placeholder, source_ref.json_key.as_deref())?;
            return Ok(());
        }
    }

    match value {
        Value::Mapping(map) => {
            if map.get(&string_value("type")).and_then(Value::as_str) == Some("token_broker")
                && !map.contains_key(&string_value("ttl"))
            {
                map.insert(
                    string_value("ttl"),
                    string_value(&source_policy.token_broker_ttl),
                );
            }
            for child in map.values_mut() {
                resolve_placeholder_source_values(child, source_policy)?;
            }
        }
        Value::Sequence(values) => {
            for child in values {
                resolve_placeholder_source_values(child, source_policy)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Deserialize)]
struct SourceReference {
    #[serde(default)]
    placeholder: Option<String>,
    #[serde(default)]
    json_key: Option<String>,
}

impl SourceReference {
    fn from_value(value: &Value) -> Option<Self> {
        serde_yaml::from_value(value.clone()).ok()
    }
}

fn existing_unmanaged_transforms(transforms: Vec<Transform>) -> Vec<Transform> {
    transforms
        .into_iter()
        .filter(|transform| !transform.is_managed())
        .collect()
}

fn insert_before_header_allowlist(transforms: &mut Vec<Transform>, managed: Vec<Transform>) {
    if let Some(index) = transforms
        .iter()
        .position(|transform| transform.name == "header_allowlist")
    {
        transforms.splice(index..index, managed);
    } else {
        transforms.extend(managed);
    }
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
        let rendered = render_proxy_yaml(None, &[fragment]).unwrap();
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
        let env_rendered =
            render_proxy_yaml_with_source_policy(None, &[fragment.clone()], &SourcePolicy::env())
                .unwrap();
        let op_rendered = render_proxy_yaml_with_source_policy(
            None,
            &[fragment],
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
        )
        .unwrap();
        assert_eq!(listen_ports_from_yaml(&rendered).unwrap(), vec![5432, 8080]);
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
        )
        .unwrap();
        assert_eq!(listen_ports_from_yaml(&rendered).unwrap(), vec![18080]);
        assert_eq!(proxy_listen_port_from_yaml(&rendered).unwrap(), 18080);
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
            &SourcePolicy::onepassword("ai-agents", "10m"),
        )
        .unwrap();
        assert!(rendered.contains("token_broker"));
        assert!(rendered.contains("ttl: 1m"));
        assert!(rendered.contains("chatgpt-account-id"));
        assert!(!rendered.contains("placeholder:"));
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
    store:
      placeholder: OKTA_BLOB
  - id: openai-codex
    token_endpoint: https://duplicate.example.com/token
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
        let credentials = cfg["credentials"]
            .as_sequence()
            .unwrap()
            .iter()
            .map(|credential| (credential["id"].as_str().unwrap(), credential))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(
            credentials.keys().copied().collect::<Vec<_>>(),
            vec!["anthropic-claude", "okta", "openai-codex"]
        );
        assert_eq!(
            credentials["okta"]["client_id"]["secret_ref"],
            "op://prod-agents/OKTA_BUNDLE/credential"
        );
        assert_eq!(credentials["okta"]["client_id"]["json_key"], "client_id");
        assert_eq!(
            credentials["okta"]["store"]["secret_ref"],
            "op://prod-agents/OKTA_BLOB/credential"
        );
        assert_eq!(
            credentials["openai-codex"]["token_endpoint"],
            "https://auth.openai.com/oauth/token"
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
