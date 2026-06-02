use centaur_sandbox_agent_k8s::IronProxyPodConfig;
use clap::Args as ClapArgs;

#[derive(Debug, ClapArgs)]
pub(super) struct OnePasswordConnectArgs {
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
    pub(super) fn apply_to(&self, config: &mut IronProxyPodConfig) {
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

fn parse_host_port(value: &str) -> Option<u16> {
    value.rsplit_once(':')?.1.parse().ok()
}
