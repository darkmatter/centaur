use std::{collections::BTreeMap, path::PathBuf};

use centaur_iron_proxy::{SourceKind, SourcePolicy, discover_fragment_files, load_fragment_files};
use centaur_sandbox_agent_k8s::IronProxyPodConfig;
use clap::{Args as ClapArgs, ValueEnum};

use super::ServerError;
use super::auth::HarnessAuthArgs;
use super::kubernetes::KubernetesSandboxArgs;

#[derive(Debug, ClapArgs)]
pub(super) struct IronProxyArgs {
    #[arg(
        long = "kubernetes-sandbox-iron-proxy-mode",
        env = "KUBERNETES_SANDBOX_IRON_PROXY_MODE",
        value_enum,
        default_value = "auto"
    )]
    mode: IronProxyMode,
    #[arg(
        long = "kubernetes-iron-proxy-image",
        env = "KUBERNETES_IRON_PROXY_IMAGE"
    )]
    iron_proxy_image: Option<String>,
    #[arg(
        long = "kubernetes-iron-proxy-image-pull-policy",
        env = "KUBERNETES_IRON_PROXY_IMAGE_PULL_POLICY"
    )]
    image_pull_policy: Option<String>,
    #[arg(
        long = "kubernetes-iron-proxy-fragment-paths",
        env = "KUBERNETES_IRON_PROXY_FRAGMENT_PATHS",
        value_delimiter = ','
    )]
    fragment_paths: Vec<PathBuf>,
    #[arg(
        long = "kubernetes-iron-proxy-fragment-dirs",
        env = "KUBERNETES_IRON_PROXY_FRAGMENT_DIRS",
        value_delimiter = ','
    )]
    fragment_dirs: Vec<PathBuf>,
    #[arg(long = "tool-dirs", env = "TOOL_DIRS", value_delimiter = ':')]
    tool_dirs: Vec<PathBuf>,
    #[arg(
        long = "kubernetes-firewall-ca-secret-name",
        env = "KUBERNETES_FIREWALL_CA_SECRET_NAME"
    )]
    ca_cert_secret_name: Option<String>,
    #[arg(
        long = "kubernetes-firewall-ca-key-secret-name",
        env = "KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME"
    )]
    ca_key_secret_name: Option<String>,
    #[arg(
        long = "kubernetes-secret-env-name",
        env = "KUBERNETES_SECRET_ENV_NAME"
    )]
    secret_env_name: Option<String>,
    #[arg(
        long = "kubernetes-secret-env-prefix",
        env = "KUBERNETES_SECRET_ENV_PREFIX"
    )]
    secret_env_prefix: Option<String>,
    #[arg(
        long = "kubernetes-bootstrap-secret-name",
        env = "KUBERNETES_BOOTSTRAP_SECRET_NAME"
    )]
    bootstrap_secret_name: Option<String>,
    #[command(flatten)]
    source: IronProxySourceArgs,
    #[command(flatten)]
    op_connect: OnePasswordConnectArgs,
    #[arg(long = "kubernetes-api-pod-label-selector", env = "KUBERNETES_API_POD_LABEL_SELECTOR", value_parser = parse_label_selector_arg)]
    api_pod_label_selector: Option<BTreeMap<String, String>>,
    #[command(flatten)]
    token_broker: TokenBrokerArgs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum IronProxyMode {
    Auto,
    Enabled,
    Disabled,
}

impl IronProxyMode {
    fn enabled(self, has_fragments: bool, has_ca_config: bool) -> bool {
        match self {
            IronProxyMode::Auto => has_fragments || has_ca_config,
            IronProxyMode::Enabled => true,
            IronProxyMode::Disabled => false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum IronProxySecretSourceArg {
    Env,
    #[value(name = "onepassword")]
    OnePassword,
    #[value(name = "onepassword-connect")]
    OnePasswordConnect,
}

#[derive(Debug, ClapArgs)]
struct IronProxySourceArgs {
    #[arg(
        long = "kubernetes-firewall-manager-secret-source",
        env = "KUBERNETES_FIREWALL_MANAGER_SECRET_SOURCE",
        value_enum,
        default_value = "env"
    )]
    source: IronProxySecretSourceArg,
    #[arg(long = "op-vault", env = "OP_VAULT")]
    op_vault: Option<String>,
    #[arg(
        long = "kubernetes-firewall-manager-secret-ttl",
        env = "KUBERNETES_FIREWALL_MANAGER_SECRET_TTL",
        default_value = "10m"
    )]
    secret_ttl: String,
    #[arg(
        long = "kubernetes-firewall-manager-token-broker-ttl",
        env = "KUBERNETES_FIREWALL_MANAGER_TOKEN_BROKER_TTL",
        default_value = "1m"
    )]
    token_broker_ttl: String,
}

impl From<&IronProxySourceArgs> for SourcePolicy {
    fn from(args: &IronProxySourceArgs) -> Self {
        let op_vault = args
            .op_vault
            .clone()
            .unwrap_or_else(|| "ai-agents".to_owned());
        match args.source {
            IronProxySecretSourceArg::Env => SourcePolicy::env(),
            IronProxySecretSourceArg::OnePassword => {
                SourcePolicy::onepassword(op_vault, args.secret_ttl.clone())
            }
            IronProxySecretSourceArg::OnePasswordConnect => {
                SourcePolicy::onepassword_connect(op_vault, args.secret_ttl.clone())
            }
        }
        .with_token_broker_ttl(args.token_broker_ttl.clone())
    }
}

#[derive(Debug, ClapArgs)]
struct OnePasswordConnectArgs {
    #[arg(
        long = "kubernetes-op-connect-host",
        env = "KUBERNETES_OP_CONNECT_HOST"
    )]
    host: Option<String>,
    #[arg(
        long = "kubernetes-op-connect-app-name",
        env = "KUBERNETES_OP_CONNECT_APP_NAME"
    )]
    app_name: Option<String>,
    #[arg(
        long = "kubernetes-op-connect-port",
        env = "KUBERNETES_OP_CONNECT_PORT"
    )]
    port: Option<u16>,
}

impl OnePasswordConnectArgs {
    fn apply_to(&self, config: &mut IronProxyPodConfig) {
        if let Some(app_name) = &self.app_name {
            config.op_connect_app_name = app_name.clone();
        }
        config.op_connect_port = self
            .port
            .or_else(|| self.host.as_deref().and_then(parse_host_port))
            .unwrap_or(config.op_connect_port);
        if let Some(host) = &self.host {
            config
                .extra_env
                .insert("OP_CONNECT_HOST".to_owned(), host.clone());
        }
    }
}

#[derive(Debug, ClapArgs)]
struct TokenBrokerArgs {
    #[arg(
        long = "kubernetes-token-broker-name",
        env = "KUBERNETES_TOKEN_BROKER_NAME"
    )]
    name: Option<String>,
    #[arg(
        long = "kubernetes-token-broker-configmap-name",
        env = "KUBERNETES_TOKEN_BROKER_CONFIGMAP_NAME"
    )]
    configmap_name: Option<String>,
}

impl IronProxyArgs {
    pub(super) fn to_config(
        &self,
        kubernetes: &KubernetesSandboxArgs,
        harness_auth: &HarnessAuthArgs,
    ) -> Result<Option<IronProxyPodConfig>, ServerError> {
        let fragment_paths = self.fragment_paths()?;
        if !self.mode.enabled(
            !fragment_paths.is_empty(),
            self.ca_cert_secret_name.is_some() && self.ca_key_secret_name.is_some(),
        ) {
            return Ok(None);
        }

        let mut config = IronProxyPodConfig::new(
            self.iron_proxy_image
                .clone()
                .unwrap_or_else(|| "centaur-iron-proxy:latest".to_owned()),
            self.ca_cert_secret_name
                .clone()
                .ok_or(ServerError::MissingIronProxyCaSecret)?,
            self.ca_key_secret_name
                .clone()
                .ok_or(ServerError::MissingIronProxyCaSecret)?,
        )
        .with_fragments(load_fragment_files(&fragment_paths)?);

        config.image_pull_policy = self
            .image_pull_policy
            .clone()
            .or_else(|| kubernetes.agent_image_pull_policy());
        config.image_pull_secrets = kubernetes.image_pull_secrets();
        config.source_policy = SourcePolicy::from(&self.source);
        config.harness_auth_modes = harness_auth.proxy_modes();
        self.apply_secret_env(&mut config);
        self.op_connect.apply_to(&mut config);
        config.token_broker_name = self.token_broker.name.clone();
        config.token_broker_configmap_name = self.token_broker.configmap_name.clone();
        if let Some(labels) = self
            .api_pod_label_selector
            .as_ref()
            .filter(|labels| !labels.is_empty())
        {
            config.api_pod_labels = labels.clone();
        }
        Ok(Some(config))
    }

    fn fragment_paths(&self) -> Result<Vec<PathBuf>, ServerError> {
        let mut paths = self.fragment_paths.clone();
        let mut dirs = self.fragment_dirs.clone();
        if dirs.is_empty() {
            dirs.extend(self.tool_dirs.clone());
        }
        paths.extend(discover_fragment_files(&dirs)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }

    fn apply_secret_env(&self, config: &mut IronProxyPodConfig) {
        if let Some(secret_name) = &self.secret_env_name {
            config.secret_env_name = Some(secret_name.clone());
            config.secret_env_prefix = self.secret_env_prefix.clone().unwrap_or_default();
            config.env_from_secret_names.push(secret_name.clone());
        }
        if matches!(config.source_policy.kind, SourceKind::OnePassword) {
            if let Some(secret_name) = &self.bootstrap_secret_name {
                config.env_from_secret_names.push(secret_name.clone());
            }
        }
    }
}

fn parse_host_port(value: &str) -> Option<u16> {
    value.rsplit_once(':')?.1.parse().ok()
}

fn parse_label_selector_arg(value: &str) -> Result<BTreeMap<String, String>, String> {
    let mut labels = BTreeMap::new();
    for item in value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let Some((key, value)) = item.split_once('=') else {
            return Err(format!("label selector item {item:?} must be key=value"));
        };
        let key = key.trim();
        let value = value.trim();
        if key.is_empty() || value.is_empty() {
            return Err(format!("label selector item {item:?} must be key=value"));
        }
        labels.insert(key.to_owned(), value.to_owned());
    }
    Ok(labels)
}
