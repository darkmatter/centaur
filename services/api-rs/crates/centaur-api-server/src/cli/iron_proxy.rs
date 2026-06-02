use std::collections::BTreeMap;

use centaur_iron_proxy::load_fragment_files;
use centaur_sandbox_agent_k8s::IronProxyPodConfig;
use clap::Args as ClapArgs;

use super::ServerError;
use super::auth::HarnessAuthArgs;
use super::kubernetes::KubernetesSandboxArgs;

mod ca;
mod fragments;
mod image;
mod labels;
mod mode;
mod op_connect;
mod secret_env;
mod source;
mod token_broker;

use ca::IronProxyCaArgs;
use fragments::IronProxyFragmentsArgs;
use image::IronProxyImageArgs;
use labels::parse_label_selector_arg;
use mode::IronProxyMode;
use op_connect::OnePasswordConnectArgs;
use secret_env::SecretEnvArgs;
use source::IronProxySourceArgs;
use token_broker::TokenBrokerArgs;

#[derive(Debug, ClapArgs)]
pub(super) struct IronProxyArgs {
    #[arg(
        long = "kubernetes-sandbox-iron-proxy-mode",
        env = "KUBERNETES_SANDBOX_IRON_PROXY_MODE",
        value_enum,
        default_value = "auto"
    )]
    mode: IronProxyMode,
    #[command(flatten)]
    image: IronProxyImageArgs,
    #[command(flatten)]
    fragments: IronProxyFragmentsArgs,
    #[command(flatten)]
    ca: IronProxyCaArgs,
    #[command(flatten)]
    secret_env: SecretEnvArgs,
    #[command(flatten)]
    source: IronProxySourceArgs,
    #[command(flatten)]
    op_connect: OnePasswordConnectArgs,
    #[arg(long = "kubernetes-api-pod-label-selector", env = "KUBERNETES_API_POD_LABEL_SELECTOR", value_parser = parse_label_selector_arg)]
    api_pod_label_selector: Option<BTreeMap<String, String>>,
    #[command(flatten)]
    token_broker: TokenBrokerArgs,
}

impl IronProxyArgs {
    pub(super) fn to_config(
        &self,
        kubernetes: &KubernetesSandboxArgs,
        harness_auth: &HarnessAuthArgs,
    ) -> Result<Option<IronProxyPodConfig>, ServerError> {
        let fragment_paths = self.fragments.paths()?;
        if !self
            .mode
            .enabled(!fragment_paths.is_empty(), self.ca.configured())
        {
            return Ok(None);
        }
        let (ca_cert_secret_name, ca_key_secret_name) = self.ca.required()?;

        let mut config =
            IronProxyPodConfig::new(self.image.name(), ca_cert_secret_name, ca_key_secret_name)
                .with_fragments(load_fragment_files(&fragment_paths)?);

        config.image_pull_policy = self
            .image
            .pull_policy()
            .or_else(|| kubernetes.agent_image_pull_policy());
        config.image_pull_secrets = kubernetes.image_pull_secrets();
        config.source_policy = self.source.policy();
        config.harness_auth_modes = harness_auth.proxy_modes();
        self.secret_env.apply_to(&mut config);
        self.op_connect.apply_to(&mut config);
        self.token_broker.apply_to(&mut config);
        if let Some(labels) = self
            .api_pod_label_selector
            .as_ref()
            .filter(|labels| !labels.is_empty())
        {
            config.api_pod_labels = labels.clone();
        }
        Ok(Some(config))
    }
}
