use std::path::PathBuf;

use centaur_iron_proxy::discover_fragment_files;
use clap::Args as ClapArgs;

use super::ServerError;

#[derive(Debug, ClapArgs)]
pub(super) struct IronProxyFragmentsArgs {
    #[arg(
        long = "kubernetes-iron-proxy-fragment-paths",
        env = "KUBERNETES_IRON_PROXY_FRAGMENT_PATHS",
        value_delimiter = ','
    )]
    paths: Vec<PathBuf>,
    #[arg(
        long = "kubernetes-iron-proxy-fragment-dirs",
        env = "KUBERNETES_IRON_PROXY_FRAGMENT_DIRS",
        value_delimiter = ','
    )]
    dirs: Vec<PathBuf>,
    #[arg(long = "tool-dirs", env = "TOOL_DIRS", value_delimiter = ':')]
    tool_dirs: Vec<PathBuf>,
}

impl IronProxyFragmentsArgs {
    pub(super) fn paths(&self) -> Result<Vec<PathBuf>, ServerError> {
        let mut paths = self.paths.clone();
        let mut dirs = self.dirs.clone();
        if dirs.is_empty() {
            dirs.extend(self.tool_dirs.clone());
        }
        paths.extend(discover_fragment_files(&dirs)?);
        paths.sort();
        paths.dedup();
        Ok(paths)
    }
}
