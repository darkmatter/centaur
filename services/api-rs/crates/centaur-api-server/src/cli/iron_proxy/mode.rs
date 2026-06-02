use clap::ValueEnum;

#[derive(Clone, Copy, Debug, Eq, PartialEq, ValueEnum)]
pub(super) enum IronProxyMode {
    Auto,
    Enabled,
    Disabled,
}

impl IronProxyMode {
    pub(super) fn enabled(self, has_fragments: bool, has_ca_config: bool) -> bool {
        match self {
            IronProxyMode::Auto => has_fragments || has_ca_config,
            IronProxyMode::Enabled => true,
            IronProxyMode::Disabled => false,
        }
    }
}
