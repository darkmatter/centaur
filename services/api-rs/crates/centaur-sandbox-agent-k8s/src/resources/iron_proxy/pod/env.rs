use centaur_iron_proxy::SourceKind;
use k8s_openapi::api::core::v1::{EnvFromSource, EnvVar, SecretEnvSource};

use crate::config::IronProxyPodConfig;
use crate::resources::env::EnvVars;
use crate::resources::iron_proxy::ResolvedIronProxy;
use crate::resources::iron_proxy::names::token_broker_url;

pub(super) fn iron_proxy_env_vars(
    iron_proxy: &IronProxyPodConfig,
    resolved: &ResolvedIronProxy,
) -> Vec<EnvVar> {
    let mut env = EnvVars::default();
    management_api_key(&mut env, iron_proxy);
    env.values(&iron_proxy.extra_env);
    if let Some(token_broker_name) = &iron_proxy.token_broker_name {
        env.value("IRON_BROKER_URL", token_broker_url(token_broker_name));
    }
    env.values(&resolved.pg_proxy_password_env);
    proxy_secret_refs(&mut env, iron_proxy);
    env.into_vec()
}

pub(super) fn iron_proxy_env_from(iron_proxy: &IronProxyPodConfig) -> Option<Vec<EnvFromSource>> {
    (!iron_proxy.env_from_secret_names.is_empty()).then(|| {
        iron_proxy
            .env_from_secret_names
            .iter()
            .map(|name| EnvFromSource {
                secret_ref: Some(SecretEnvSource {
                    name: name.clone(),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .collect()
    })
}

fn management_api_key(env: &mut EnvVars, iron_proxy: &IronProxyPodConfig) {
    if let Some(secret_name) = &iron_proxy.secret_env_name {
        env.secret_ref(
            "IRON_MANAGEMENT_API_KEY",
            secret_name,
            &iron_proxy.secret_env_prefix,
        );
    } else {
        env.value("IRON_MANAGEMENT_API_KEY", "unused-local-sidecar-key");
    }
}

fn proxy_secret_refs(env: &mut EnvVars, iron_proxy: &IronProxyPodConfig) {
    let Some(secret_name) = &iron_proxy.secret_env_name else {
        return;
    };
    if matches!(
        iron_proxy.source_policy.kind,
        SourceKind::OnePasswordConnect
    ) {
        env.secret_ref(
            "OP_CONNECT_TOKEN",
            secret_name,
            &iron_proxy.secret_env_prefix,
        );
    }
    if iron_proxy.token_broker_name.is_some() {
        env.secret_ref(
            "IRON_BROKER_TOKEN",
            secret_name,
            &iron_proxy.secret_env_prefix,
        );
    }
}
