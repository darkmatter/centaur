use std::collections::BTreeMap;

use centaur_iron_proxy::SourceKind;
use k8s_openapi::api::core::v1::{
    EnvFromSource, EnvVar, EnvVarSource, SecretEnvSource, SecretKeySelector,
};

use crate::config::IronProxyPodConfig;
use crate::resources::common::env_var;
use crate::resources::iron_proxy::ResolvedIronProxy;
use crate::resources::iron_proxy::names::token_broker_url;

pub(super) fn iron_proxy_env_vars(
    iron_proxy: &IronProxyPodConfig,
    resolved: &ResolvedIronProxy,
) -> Vec<EnvVar> {
    let mut env = EnvVars::default();
    env.management_api_key(iron_proxy);
    env.values(&iron_proxy.extra_env);
    if let Some(token_broker_name) = &iron_proxy.token_broker_name {
        env.value("IRON_BROKER_URL", token_broker_url(token_broker_name));
    }
    env.values(&resolved.pg_proxy_password_env);
    env.proxy_secret_refs(iron_proxy);
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

#[derive(Default)]
struct EnvVars {
    by_name: BTreeMap<String, EnvVar>,
}

impl EnvVars {
    fn management_api_key(&mut self, iron_proxy: &IronProxyPodConfig) {
        if let Some(secret_name) = &iron_proxy.secret_env_name {
            self.secret_ref(
                "IRON_MANAGEMENT_API_KEY",
                secret_name,
                &iron_proxy.secret_env_prefix,
            );
        } else {
            self.value("IRON_MANAGEMENT_API_KEY", "unused-local-sidecar-key");
        }
    }

    fn proxy_secret_refs(&mut self, iron_proxy: &IronProxyPodConfig) {
        let Some(secret_name) = &iron_proxy.secret_env_name else {
            return;
        };
        if matches!(
            iron_proxy.source_policy.kind,
            SourceKind::OnePasswordConnect
        ) {
            self.secret_ref(
                "OP_CONNECT_TOKEN",
                secret_name,
                &iron_proxy.secret_env_prefix,
            );
        }
        if iron_proxy.token_broker_name.is_some() {
            self.secret_ref(
                "IRON_BROKER_TOKEN",
                secret_name,
                &iron_proxy.secret_env_prefix,
            );
        }
    }

    fn values(&mut self, values: &BTreeMap<String, String>) {
        for (name, value) in values {
            self.value(name, value);
        }
    }

    fn value(&mut self, name: impl AsRef<str>, value: impl AsRef<str>) {
        let name = name.as_ref();
        self.by_name
            .insert(name.to_owned(), env_var(name, value.as_ref()));
    }

    fn secret_ref(&mut self, name: &str, secret_name: &str, secret_prefix: &str) {
        self.by_name.insert(
            name.to_owned(),
            EnvVar {
                name: name.to_owned(),
                value_from: Some(EnvVarSource {
                    secret_key_ref: Some(SecretKeySelector {
                        name: secret_name.to_owned(),
                        key: format!("{secret_prefix}{name}"),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        );
    }

    fn into_vec(self) -> Vec<EnvVar> {
        self.by_name.into_values().collect()
    }
}
