use std::collections::BTreeMap;

use centaur_iron_proxy::ProxyFragment;
use centaur_sandbox_core::{HarnessAuthMode, SandboxError, SandboxResult, SandboxSpec};
use uuid::Uuid;

use crate::config::IronProxyPodConfig;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResolvedIronProxy {
    pub(crate) config_yaml: String,
    pub(crate) placeholder_env: BTreeMap<String, String>,
    pub(crate) proxy_host: String,
    pub(crate) proxy_pod_name: String,
    pub(crate) proxy_port: u16,
    pub(crate) listen_ports: Vec<u16>,
    pub(crate) pg_dsn_env: BTreeMap<String, String>,
    pub(crate) pg_proxy_password_env: BTreeMap<String, String>,
}

pub(crate) fn proxied_pg_url(host: &str, port: u16, password: &str, database: &str) -> String {
    format!("postgresql://app_user:{password}@{host}:{port}/{database}")
}

pub(crate) fn proxy_password() -> String {
    Uuid::new_v4().simple().to_string()
}

pub(crate) fn iron_proxy_fragments_for_spec(
    iron_proxy: &IronProxyPodConfig,
    spec: &SandboxSpec,
) -> SandboxResult<Vec<ProxyFragment>> {
    let mut fragments =
        vec![centaur_iron_proxy::infra_fragment().map_err(|err| {
            SandboxError::InvalidSpec(format!("iron-proxy infra fragment: {err}"))
        })?];
    fragments.extend(iron_proxy.fragments.clone());
    for credential in &spec.credentials {
        let auth_mode = credential.auth_mode.unwrap_or(HarnessAuthMode::ApiKey);
        if let Some(fragment) =
            centaur_iron_proxy::harness_fragment(credential.profile.as_str(), auth_mode.as_str())
                .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy fragment: {err}")))?
        {
            fragments.push(fragment);
        }
    }
    Ok(fragments)
}
