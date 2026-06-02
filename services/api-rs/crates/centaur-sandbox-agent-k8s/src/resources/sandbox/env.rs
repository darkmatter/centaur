use centaur_sandbox_core::SandboxSpec;
use k8s_openapi::api::core::v1::EnvVar;

use super::super::iron_proxy::ResolvedIronProxy;

mod harness;
mod proxy;
mod vars;

use harness::harness_auth_env;
use proxy::proxy_env;
use vars::EnvVars;

pub(super) fn env_vars(
    spec: &SandboxSpec,
    resolved_iron_proxy: Option<&ResolvedIronProxy>,
) -> Option<Vec<EnvVar>> {
    let mut env = EnvVars::from_spec(spec);
    env.set_all(harness_auth_env(&spec.credentials));
    if let Some(resolved_iron_proxy) = resolved_iron_proxy {
        env.set_missing_all(&resolved_iron_proxy.placeholder_env);
        env.set_missing_all(&resolved_iron_proxy.pg_dsn_env);
        let no_proxy_extra = env.values(["NO_PROXY", "no_proxy"]);
        env.set_all(proxy_env(
            &resolved_iron_proxy.proxy_host,
            resolved_iron_proxy.proxy_port,
            env.host_from_url("CENTAUR_API_URL").as_deref(),
            &no_proxy_extra,
        ));
    }
    env.into_k8s()
}
