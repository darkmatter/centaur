use clap::Args as ClapArgs;

#[derive(Debug, ClapArgs)]
pub(super) struct IronProxyImageArgs {
    #[arg(
        long = "kubernetes-iron-proxy-image",
        env = "KUBERNETES_IRON_PROXY_IMAGE"
    )]
    image_name: Option<String>,
    #[arg(
        long = "kubernetes-iron-proxy-image-pull-policy",
        env = "KUBERNETES_IRON_PROXY_IMAGE_PULL_POLICY"
    )]
    pull_policy: Option<String>,
}

impl IronProxyImageArgs {
    pub(super) fn name(&self) -> String {
        self.image_name
            .clone()
            .unwrap_or_else(|| "centaur-iron-proxy:latest".to_owned())
    }

    pub(super) fn pull_policy(&self) -> Option<String> {
        self.pull_policy.clone()
    }
}
