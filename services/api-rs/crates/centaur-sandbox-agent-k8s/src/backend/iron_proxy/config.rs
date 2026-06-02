use std::collections::BTreeMap;

use centaur_sandbox_core::{SandboxError, SandboxId, SandboxResult, SandboxSpec};

use super::super::AgentSandboxBackend;
use crate::resources::*;

impl AgentSandboxBackend {
    pub(in crate::backend) fn resolve_iron_proxy(
        &self,
        id: &SandboxId,
        spec: &SandboxSpec,
    ) -> SandboxResult<Option<ResolvedIronProxy>> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(None);
        };
        let fragments = iron_proxy_fragments_for_spec(iron_proxy, spec)?;
        let config_yaml = centaur_iron_proxy::render_proxy_yaml_with_source_policy(
            None,
            &fragments,
            &iron_proxy.source_policy,
        )
        .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy config: {err}")))?;
        let placeholder_env = centaur_iron_proxy::placeholder_env(&fragments);
        let proxy_port = centaur_iron_proxy::proxy_listen_port_from_yaml(&config_yaml)
            .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy proxy port: {err}")))?;
        let listen_ports = centaur_iron_proxy::listen_ports_from_yaml(&config_yaml)
            .map_err(|err| SandboxError::InvalidSpec(format!("iron-proxy listen ports: {err}")))?;
        let proxy_host = iron_proxy_service_name(id);
        let mut pg_dsn_env = BTreeMap::new();
        let mut pg_proxy_password_env = BTreeMap::new();
        for entry in centaur_iron_proxy::pg_dsn_envs(&fragments) {
            let password = pg_proxy_password_env
                .entry(entry.password_env.clone())
                .or_insert_with(proxy_password)
                .clone();
            pg_dsn_env.entry(entry.env_name).or_insert_with(|| {
                proxied_pg_url(&proxy_host, entry.port, &password, &entry.database)
            });
        }
        Ok(Some(ResolvedIronProxy {
            config_yaml,
            placeholder_env,
            proxy_host,
            proxy_pod_name: new_iron_proxy_pod_name(id),
            proxy_port,
            listen_ports,
            pg_dsn_env,
            pg_proxy_password_env,
        }))
    }
}
