use std::{net::SocketAddr, sync::Arc};

use centaur_api_server::SandboxRuntime;
use centaur_sandbox_agent_k8s::{AgentSandboxBackend, AgentSandboxConfig};
use centaur_sandbox_local::LocalSandboxBackend;
use clap::{Args as ClapArgs, Parser, ValueEnum};

mod auth;
mod error;
mod iron_proxy;
mod kubernetes;
mod workload;

use auth::HarnessAuthArgs;
pub(crate) use error::ServerError;
use iron_proxy::IronProxyArgs;
use kubernetes::KubernetesSandboxArgs;
use workload::SandboxWorkloadArgs;

pub(crate) async fn sandbox_runtime_from_args(
    args: &SandboxArgs,
) -> Result<SandboxRuntime, ServerError> {
    match args.backend {
        SandboxBackendKind::Local => Ok(SandboxRuntime::backend_with_workload(
            Arc::new(LocalSandboxBackend::new()),
            args.workload.local_mode()?,
            args.harness_auth.modes(),
        )),
        SandboxBackendKind::AgentK8s => {
            let config = args.agent_config()?;
            let backend = Arc::new(AgentSandboxBackend::new(
                args.kubernetes.client().await?,
                config,
            ));
            Ok(SandboxRuntime::backend_with_workload(
                backend,
                args.container_workload_mode(),
                args.harness_auth.modes(),
            ))
        }
    }
}

#[derive(Debug, Parser)]
#[command(about = "Run the Centaur API Rust control plane")]
pub(crate) struct Cli {
    #[arg(long, env = "DATABASE_URL")]
    pub(crate) database_url: String,
    #[arg(long, env = "BIND_ADDR", default_value = "127.0.0.1:8080")]
    pub(crate) bind_addr: SocketAddr,
    #[arg(long, env = "RUN_MIGRATIONS", default_value_t = false)]
    pub(crate) run_migrations: bool,
    #[command(flatten)]
    pub(crate) sandbox: SandboxArgs,
}

#[derive(Debug, ClapArgs)]
pub(crate) struct SandboxArgs {
    #[arg(
        long = "kubernetes-sandbox-backend",
        env = "KUBERNETES_SANDBOX_BACKEND",
        value_enum,
        default_value = "local"
    )]
    backend: SandboxBackendKind,
    #[command(flatten)]
    kubernetes: KubernetesSandboxArgs,
    #[command(flatten)]
    workload: SandboxWorkloadArgs,
    #[command(flatten)]
    harness_auth: HarnessAuthArgs,
    #[command(flatten)]
    iron_proxy: IronProxyArgs,
}

impl SandboxArgs {
    fn agent_config(&self) -> Result<AgentSandboxConfig, ServerError> {
        let image_pull = self.kubernetes.image_pull_config();
        let iron_proxy = self.iron_proxy.to_config(&image_pull)?;
        Ok(self.kubernetes.agent_config(image_pull, iron_proxy))
    }

    fn container_workload_mode(&self) -> centaur_session_runtime::SandboxWorkloadMode {
        self.workload.container_mode()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum SandboxBackendKind {
    Local,
    #[value(name = "agent-k8s")]
    AgentK8s,
}

#[cfg(test)]
mod tests {
    use super::*;
    use centaur_iron_proxy::SourceKind;

    #[test]
    fn clap_builds_brokered_iron_proxy_config() {
        let cli = Cli::try_parse_from([
            "centaur-api-server",
            "--database-url",
            "postgresql://postgres@localhost/centaur",
            "--kubernetes-sandbox-iron-proxy-mode",
            "enabled",
            "--kubernetes-iron-proxy-image",
            "centaur-iron-proxy:test",
            "--kubernetes-firewall-ca-secret-name",
            "firewall-ca-cert",
            "--kubernetes-firewall-ca-key-secret-name",
            "firewall-ca-key",
            "--kubernetes-firewall-manager-secret-source",
            "onepassword-connect",
            "--op-vault",
            "engineering",
            "--kubernetes-firewall-manager-secret-ttl",
            "5m",
            "--kubernetes-firewall-manager-token-broker-ttl",
            "30s",
            "--kubernetes-token-broker-name",
            "centaur-token-broker",
            "--kubernetes-token-broker-configmap-name",
            "centaur-token-broker-config",
            "--codex-auth-mode",
            "access_token",
        ])
        .unwrap();

        let config = cli.sandbox.agent_config().unwrap().iron_proxy.unwrap();

        assert_eq!(config.image, "centaur-iron-proxy:test");
        assert_eq!(config.ca_cert_secret_name, "firewall-ca-cert");
        assert_eq!(config.ca_key_secret_name, "firewall-ca-key");
        assert!(matches!(
            config.source_policy.kind,
            SourceKind::OnePasswordConnect
        ));
        assert_eq!(config.source_policy.op_vault, "engineering");
        assert_eq!(config.source_policy.ttl, "5m");
        assert_eq!(config.source_policy.token_broker_ttl, "30s");
        assert_eq!(
            cli.sandbox
                .harness_auth
                .modes()
                .mode_for(centaur_sandbox_core::CredentialProfile::Codex),
            Some(centaur_sandbox_core::HarnessAuthMode::AccessToken)
        );
        assert_eq!(
            config.token_broker_name.as_deref(),
            Some("centaur-token-broker")
        );
        assert_eq!(
            config.token_broker_configmap_name.as_deref(),
            Some("centaur-token-broker-config")
        );
        assert!(!config.extra_env.contains_key("IRON_BROKER_URL"));
    }
}
