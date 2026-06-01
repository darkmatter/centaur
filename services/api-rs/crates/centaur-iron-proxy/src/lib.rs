use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
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

    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    fn from_lookup(mut lookup: impl FnMut(&str) -> Option<String>) -> Self {
        let kind = match lookup("FIREWALL_MANAGER_SECRET_SOURCE")
            .or_else(|| lookup("KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE"))
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
            ttl: lookup("FIREWALL_MANAGER_SECRET_TTL")
                .or_else(|| lookup("KUBERNETES_FIREWALL_MANAGER_SECRET_TTL"))
                .unwrap_or_else(|| "10m".to_owned()),
            token_broker_ttl: lookup("FIREWALL_MANAGER_TOKEN_BROKER_TTL")
                .or_else(|| lookup("KUBERNETES_FIREWALL_MANAGER_TOKEN_BROKER_TTL"))
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
    #[serde(default, flatten)]
    pub top_level: BTreeMap<String, Value>,
}

impl ProxyFragment {
    pub fn is_empty(&self) -> bool {
        self.transforms.is_empty() && self.postgres.is_empty() && self.top_level.is_empty()
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
    let managed = fragments
        .iter()
        .flat_map(|fragment| fragment.transforms.iter().cloned())
        .map(|transform| resolve_fragment_transform_sources(transform, source_policy))
        .collect::<Vec<_>>();
    if !managed.is_empty() {
        insert_before_header_allowlist(&mut transforms, managed);
    }
    cfg_map.insert(string_value("transforms"), Value::Sequence(transforms));

    let mut postgres = fragments
        .iter()
        .flat_map(|fragment| fragment.postgres.iter().cloned())
        .map(|mut listener| {
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

fn resolve_fragment_transform_sources(mut transform: Value, source_policy: &SourcePolicy) -> Value {
    fill_missing_secret_sources(&mut transform, source_policy);
    resolve_placeholder_source_values(&mut transform, source_policy);
    transform
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
    fn source_policy_reads_kubernetes_prefixed_env_fallbacks() {
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
