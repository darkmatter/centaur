use std::collections::BTreeMap;
use std::time::Duration;

use centaur_iron_proxy::{ProxyFragment, SourcePolicy};

const DEFAULT_CONTAINER_NAME: &str = "agent";

#[derive(Clone, Debug)]
pub struct AgentSandboxConfig {
    pub namespace: String,
    pub field_manager: String,
    pub container_name: String,
    pub labels: BTreeMap<String, String>,
    pub annotations: BTreeMap<String, String>,
    pub image_pull_policy: Option<String>,
    pub image_pull_secrets: Vec<String>,
    pub runtime_class_name: Option<String>,
    pub service_account_name: Option<String>,
    pub iron_proxy: Option<IronProxyPodConfig>,
    pub ready_timeout: Duration,
}

impl AgentSandboxConfig {
    pub fn new(namespace: impl Into<String>) -> Self {
        Self {
            namespace: namespace.into(),
            field_manager: "centaur-api-rs".to_owned(),
            container_name: DEFAULT_CONTAINER_NAME.to_owned(),
            labels: BTreeMap::new(),
            annotations: BTreeMap::new(),
            image_pull_policy: None,
            image_pull_secrets: Vec::new(),
            runtime_class_name: None,
            service_account_name: None,
            iron_proxy: None,
            ready_timeout: Duration::from_secs(60),
        }
    }
}

#[derive(Clone, Debug)]
pub struct IronProxyPodConfig {
    pub image: String,
    pub image_pull_policy: Option<String>,
    pub image_pull_secrets: Vec<String>,
    pub fragments: Vec<ProxyFragment>,
    pub source_policy: SourcePolicy,
    pub harness_auth_modes: BTreeMap<String, String>,
    pub ca_cert_secret_name: String,
    pub ca_key_secret_name: String,
    pub op_connect_app_name: String,
    pub op_connect_port: u16,
    pub api_pod_labels: BTreeMap<String, String>,
    pub env_from_secret_names: Vec<String>,
    pub secret_env_name: Option<String>,
    pub secret_env_prefix: String,
    pub extra_env: BTreeMap<String, String>,
    pub token_broker_name: Option<String>,
    pub token_broker_configmap_name: Option<String>,
}

impl IronProxyPodConfig {
    pub fn new(
        image: impl Into<String>,
        ca_cert_secret_name: impl Into<String>,
        ca_key_secret_name: impl Into<String>,
    ) -> Self {
        Self {
            image: image.into(),
            image_pull_policy: None,
            image_pull_secrets: Vec::new(),
            fragments: Vec::new(),
            source_policy: SourcePolicy::default(),
            harness_auth_modes: BTreeMap::new(),
            ca_cert_secret_name: ca_cert_secret_name.into(),
            ca_key_secret_name: ca_key_secret_name.into(),
            op_connect_app_name: "onepassword-connect".to_owned(),
            op_connect_port: 8080,
            api_pod_labels: BTreeMap::from([(
                "app.kubernetes.io/component".to_owned(),
                "api".to_owned(),
            )]),
            env_from_secret_names: Vec::new(),
            secret_env_name: None,
            secret_env_prefix: String::new(),
            extra_env: BTreeMap::new(),
            token_broker_name: None,
            token_broker_configmap_name: None,
        }
    }

    pub fn with_fragments(mut self, fragments: Vec<ProxyFragment>) -> Self {
        self.fragments = fragments;
        self
    }
}
