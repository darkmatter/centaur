use clap::Args as ClapArgs;

use super::ServerError;

#[derive(Debug, ClapArgs)]
pub(super) struct IronProxyCaArgs {
    #[arg(
        long = "kubernetes-firewall-ca-secret-name",
        env = "KUBERNETES_FIREWALL_CA_SECRET_NAME"
    )]
    cert_secret_name: Option<String>,
    #[arg(
        long = "kubernetes-firewall-ca-key-secret-name",
        env = "KUBERNETES_FIREWALL_CA_KEY_SECRET_NAME"
    )]
    key_secret_name: Option<String>,
}

impl IronProxyCaArgs {
    pub(super) fn configured(&self) -> bool {
        self.cert_secret_name.is_some() && self.key_secret_name.is_some()
    }

    pub(super) fn required(&self) -> Result<(String, String), ServerError> {
        Ok((
            self.cert_secret_name
                .clone()
                .ok_or(ServerError::MissingIronProxyCaSecret)?,
            self.key_secret_name
                .clone()
                .ok_or(ServerError::MissingIronProxyCaSecret)?,
        ))
    }
}
