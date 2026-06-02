use centaur_sandbox_agent_k8s::IronProxyPodConfig;
use clap::Args as ClapArgs;

#[derive(Debug, ClapArgs)]
pub(super) struct TokenBrokerArgs {
    #[arg(
        long = "kubernetes-token-broker-name",
        env = "KUBERNETES_TOKEN_BROKER_NAME"
    )]
    token_broker_name: Option<String>,
    #[arg(
        long = "kubernetes-token-broker-configmap-name",
        env = "KUBERNETES_TOKEN_BROKER_CONFIGMAP_NAME"
    )]
    configmap_name: Option<String>,
}

impl TokenBrokerArgs {
    pub(super) fn apply_to(&self, config: &mut IronProxyPodConfig) {
        config.token_broker_name = self.token_broker_name.clone();
        config.token_broker_configmap_name = self.configmap_name.clone();
    }
}
