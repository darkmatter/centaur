use std::time::Duration;

use centaur_sandbox_agent_k8s::{AgentSandboxConfig, IronProxyPodConfig};
use clap::Args as ClapArgs;

use super::ServerError;

#[derive(Debug, ClapArgs)]
pub(super) struct KubernetesSandboxArgs {
    #[arg(
        long = "kubernetes-namespace",
        env = "KUBERNETES_NAMESPACE",
        default_value = "centaur-sandbox-e2e"
    )]
    namespace: String,
    #[arg(long = "kubernetes-context", env = "KUBERNETES_CONTEXT")]
    context: Option<String>,
    #[arg(
        long = "kubernetes-agent-image-pull-policy",
        env = "KUBERNETES_AGENT_IMAGE_PULL_POLICY"
    )]
    agent_image_pull_policy: Option<String>,
    #[arg(
        long = "kubernetes-sandbox-image-pull-secrets",
        env = "KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS",
        value_delimiter = ','
    )]
    image_pull_secrets: Vec<String>,
    #[arg(
        long = "kubernetes-sandbox-ready-timeout-s",
        env = "KUBERNETES_SANDBOX_READY_TIMEOUT_S",
        default_value_t = 90
    )]
    ready_timeout_s: u64,
    #[arg(
        long = "kubernetes-sandbox-runtime-class-name",
        env = "KUBERNETES_SANDBOX_RUNTIME_CLASS_NAME"
    )]
    runtime_class_name: Option<String>,
    #[arg(
        long = "kubernetes-sandbox-service-account-name",
        env = "KUBERNETES_SANDBOX_SERVICE_ACCOUNT_NAME"
    )]
    service_account_name: Option<String>,
}

impl KubernetesSandboxArgs {
    pub(super) async fn client(&self) -> Result<kube::Client, ServerError> {
        if let Some(context) = self.context.as_deref() {
            let kube_config = kube::Config::from_kubeconfig(&kube::config::KubeConfigOptions {
                context: Some(context.to_owned()),
                ..kube::config::KubeConfigOptions::default()
            })
            .await?;
            return Ok(kube::Client::try_from(kube_config)?);
        }
        Ok(kube::Client::try_default().await?)
    }

    pub(super) fn agent_config(
        &self,
        iron_proxy: Option<IronProxyPodConfig>,
    ) -> AgentSandboxConfig {
        let mut config = AgentSandboxConfig::new(self.namespace.clone());
        config.image_pull_policy = self.agent_image_pull_policy.clone();
        config.image_pull_secrets = self.image_pull_secrets.clone();
        config.ready_timeout = Duration::from_secs(self.ready_timeout_s);
        config.runtime_class_name = self.runtime_class_name.clone();
        config.service_account_name = self.service_account_name.clone();
        config.iron_proxy = iron_proxy;
        config
    }

    pub(super) fn agent_image_pull_policy(&self) -> Option<String> {
        self.agent_image_pull_policy.clone()
    }

    pub(super) fn image_pull_secrets(&self) -> Vec<String> {
        self.image_pull_secrets.clone()
    }
}
