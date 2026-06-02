use std::collections::BTreeMap;

use centaur_session_runtime::SandboxWorkloadMode;
use clap::{Args as ClapArgs, ValueEnum};

use super::ServerError;
use super::auth::HarnessAuthArgs;

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
enum SandboxWorkloadKind {
    Mock,
    #[value(name = "codex-app-server")]
    CodexAppServer,
}

#[derive(Debug, ClapArgs)]
pub(super) struct SandboxWorkloadArgs {
    #[arg(
        long = "kubernetes-sandbox-workload",
        env = "KUBERNETES_SANDBOX_WORKLOAD",
        value_enum,
        default_value = "mock"
    )]
    workload: SandboxWorkloadKind,
    #[arg(long = "kubernetes-agent-image", env = "KUBERNETES_AGENT_IMAGE")]
    agent_image: Option<String>,
    #[arg(long, env = "CENTAUR_API_URL", default_value = "http://api:8000")]
    centaur_api_url: String,
    #[arg(long, env = "CENTAUR_API_KEY")]
    centaur_api_key: Option<String>,
    #[arg(
        long = "kubernetes-sandbox-passthrough-env",
        env = "KUBERNETES_SANDBOX_PASSTHROUGH_ENV",
        value_delimiter = ','
    )]
    passthrough_env: Vec<String>,
}

impl SandboxWorkloadArgs {
    pub(super) fn local_mode(&self) -> Result<SandboxWorkloadMode, ServerError> {
        match self.workload {
            SandboxWorkloadKind::Mock => Ok(SandboxWorkloadMode::mock_app_server(
                self.agent_image
                    .clone()
                    .unwrap_or_else(|| "local-mock-app-server".to_owned()),
            )),
            SandboxWorkloadKind::CodexAppServer => Err(ServerError::UnsupportedConfig(
                "codex-app-server workload requires --kubernetes-sandbox-backend agent-k8s"
                    .to_owned(),
            )),
        }
    }

    pub(super) fn container_mode(
        &self,
        harness_auth: &HarnessAuthArgs,
        passthrough_env: BTreeMap<String, String>,
    ) -> SandboxWorkloadMode {
        let image = self
            .agent_image
            .clone()
            .unwrap_or_else(|| default_sandbox_image(self.workload).to_owned());
        match self.workload {
            SandboxWorkloadKind::Mock => SandboxWorkloadMode::mock_app_server(image),
            SandboxWorkloadKind::CodexAppServer => SandboxWorkloadMode::codex_app_server(
                image,
                self.app_server_env(harness_auth, passthrough_env),
            ),
        }
    }

    fn app_server_env(
        &self,
        harness_auth: &HarnessAuthArgs,
        passthrough_env: BTreeMap<String, String>,
    ) -> Vec<(String, String)> {
        let mut values =
            BTreeMap::from([("CENTAUR_API_URL".to_owned(), self.centaur_api_url.clone())]);
        if let Some(api_key) = &self.centaur_api_key {
            values.insert("CENTAUR_API_KEY".to_owned(), api_key.clone());
        }
        harness_auth.insert_app_server_env(&mut values);
        values.extend(passthrough_env);
        values.into_iter().collect()
    }

    pub(super) fn passthrough_env_names(&self) -> &[String] {
        &self.passthrough_env
    }
}

fn default_sandbox_image(workload: SandboxWorkloadKind) -> &'static str {
    match workload {
        SandboxWorkloadKind::Mock => "busybox:1.36",
        SandboxWorkloadKind::CodexAppServer => "centaur-agent:latest",
    }
}
