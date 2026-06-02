use centaur_sandbox_core::{CredentialProfile, CredentialRequest, SandboxSpec};
use k8s_openapi::api::core::v1::EnvVar;

use super::super::iron_proxy::ResolvedIronProxy;
use crate::resources::env::EnvVars;

mod proxy;

use proxy::proxy_env;

pub(super) fn env_vars(
    spec: &SandboxSpec,
    resolved_iron_proxy: Option<&ResolvedIronProxy>,
) -> Option<Vec<EnvVar>> {
    let mut env = EnvVars::from_spec(spec);
    set_harness_auth_env(&mut env, &spec.credentials);
    if let Some(resolved_iron_proxy) = resolved_iron_proxy {
        env.set_missing_values(&resolved_iron_proxy.placeholder_env);
        env.set_missing_values(&resolved_iron_proxy.pg_dsn_env);
        let no_proxy_extra = env.current_values(["NO_PROXY", "no_proxy"]);
        env.values(&proxy_env(
            &resolved_iron_proxy.proxy_host,
            resolved_iron_proxy.proxy_port,
            env.host_from_url("CENTAUR_API_URL").as_deref(),
            &no_proxy_extra,
        ));
    }
    env.into_option()
}

fn set_harness_auth_env(env: &mut EnvVars, credentials: &[CredentialRequest]) {
    for credential in credentials {
        let Some(name) = harness_auth_env_name(credential.profile) else {
            continue;
        };
        let Some(auth_mode) = credential.auth_mode else {
            continue;
        };
        env.value(name, auth_mode.as_str());
    }
}

fn harness_auth_env_name(profile: CredentialProfile) -> Option<&'static str> {
    match profile {
        CredentialProfile::Codex => Some("CODEX_AUTH_MODE"),
        CredentialProfile::ClaudeCode => Some("CLAUDE_CODE_AUTH_MODE"),
        CredentialProfile::Amp => None,
    }
}
