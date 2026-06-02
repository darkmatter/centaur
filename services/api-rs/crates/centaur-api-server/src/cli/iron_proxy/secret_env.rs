use centaur_iron_proxy::SourceKind;
use centaur_sandbox_agent_k8s::IronProxyPodConfig;
use clap::Args as ClapArgs;

#[derive(Debug, ClapArgs)]
pub(super) struct SecretEnvArgs {
    #[arg(
        long = "kubernetes-secret-env-name",
        env = "KUBERNETES_SECRET_ENV_NAME"
    )]
    secret_name: Option<String>,
    #[arg(
        long = "kubernetes-secret-env-prefix",
        env = "KUBERNETES_SECRET_ENV_PREFIX"
    )]
    prefix: Option<String>,
    #[arg(
        long = "kubernetes-bootstrap-secret-name",
        env = "KUBERNETES_BOOTSTRAP_SECRET_NAME"
    )]
    bootstrap_name: Option<String>,
}

impl SecretEnvArgs {
    pub(super) fn apply_to(&self, config: &mut IronProxyPodConfig) {
        if let Some(secret_name) = &self.secret_name {
            config.secret_env_name = Some(secret_name.clone());
            config.secret_env_prefix = self.prefix.clone().unwrap_or_default();
            config.env_from_secret_names.push(secret_name.clone());
        }
        if matches!(config.source_policy.kind, SourceKind::OnePassword) {
            if let Some(secret_name) = &self.bootstrap_name {
                config.env_from_secret_names.push(secret_name.clone());
            }
        }
    }
}
