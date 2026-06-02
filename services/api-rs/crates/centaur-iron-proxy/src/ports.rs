use std::collections::BTreeMap;

use crate::{IronProxyConfigError, PgDsnEnv, ProxyConfig, ProxyFragment, Result};
use crate::{listen_port, non_empty};

pub fn listen_ports_from_yaml(config_yaml: &str) -> Result<Vec<u16>> {
    let cfg: ProxyConfig =
        serde_yaml::from_str(config_yaml).map_err(IronProxyConfigError::ParseBase)?;
    let mut ports = Vec::new();
    ports.push(proxy_listen_port_from_config(&cfg));
    for listener in &cfg.postgres {
        if let Some(port) = listener.listen.as_deref().and_then(listen_port) {
            ports.push(port);
        }
    }
    ports.sort_unstable();
    ports.dedup();
    Ok(ports)
}

pub fn proxy_listen_port_from_yaml(config_yaml: &str) -> Result<u16> {
    let cfg: ProxyConfig =
        serde_yaml::from_str(config_yaml).map_err(IronProxyConfigError::ParseBase)?;
    Ok(proxy_listen_port_from_config(&cfg))
}

fn proxy_listen_port_from_config(cfg: &ProxyConfig) -> u16 {
    cfg.proxy
        .as_ref()
        .and_then(|proxy| proxy.tunnel_listen.as_deref())
        .and_then(listen_port)
        .unwrap_or(8080)
}

pub fn pg_dsn_envs(fragments: &[ProxyFragment]) -> Vec<PgDsnEnv> {
    let mut entries = BTreeMap::<String, PgDsnEnv>::new();
    for listener in fragments
        .iter()
        .flat_map(|fragment| fragment.postgres.iter())
    {
        let Some(sandbox_env) = &listener.sandbox_env else {
            continue;
        };
        let Some(env_name) = non_empty(sandbox_env.name.as_deref()) else {
            continue;
        };
        let Some(database) = non_empty(sandbox_env.database.as_deref()) else {
            continue;
        };
        let Some(port) = listener.listen.as_deref().and_then(listen_port) else {
            continue;
        };
        let Some(password_env) = non_empty(
            listener
                .client
                .as_ref()
                .and_then(|client| client.password_env.as_deref()),
        ) else {
            continue;
        };
        entries.entry(env_name.to_owned()).or_insert(PgDsnEnv {
            env_name: env_name.to_owned(),
            database: database.to_owned(),
            port,
            password_env: password_env.to_owned(),
        });
    }
    entries.into_values().collect()
}
