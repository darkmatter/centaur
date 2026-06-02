use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde_yaml::Value;

use super::*;

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

    let err =
        render_token_broker_yaml_with_source_policy(&[fragment], &SourcePolicy::env()).unwrap_err();
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
