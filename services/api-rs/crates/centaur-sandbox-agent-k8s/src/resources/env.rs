use std::collections::BTreeMap;

use centaur_sandbox_core::SandboxSpec;
use k8s_openapi::api::core::v1::{EnvVar, EnvVarSource, SecretKeySelector};

#[derive(Default)]
pub(crate) struct EnvVars {
    by_name: BTreeMap<String, EnvVar>,
}

impl EnvVars {
    pub(crate) fn from_spec(spec: &SandboxSpec) -> Self {
        let mut env = Self::default();
        for item in &spec.env {
            env.value(&item.name, &item.value);
        }
        env
    }

    pub(crate) fn value(&mut self, name: impl AsRef<str>, value: impl AsRef<str>) {
        let name = name.as_ref();
        self.by_name
            .insert(name.to_owned(), env_var(name, value.as_ref()));
    }

    pub(crate) fn values(&mut self, values: &BTreeMap<String, String>) {
        for (name, value) in values {
            self.value(name, value);
        }
    }

    pub(crate) fn set_missing_values(&mut self, values: &BTreeMap<String, String>) {
        for (name, value) in values {
            self.by_name
                .entry(name.clone())
                .or_insert_with(|| env_var(name, value));
        }
    }

    pub(crate) fn current_values<const N: usize>(&self, names: [&str; N]) -> Vec<String> {
        names
            .into_iter()
            .filter_map(|name| self.by_name.get(name).and_then(|env| env.value.clone()))
            .collect()
    }

    pub(crate) fn host_from_url(&self, name: &str) -> Option<String> {
        let value = self.by_name.get(name)?.value.as_deref()?.trim();
        let without_scheme = value
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(value);
        let authority = without_scheme.split('/').next()?.trim();
        let host_port = authority
            .rsplit_once('@')
            .map(|(_, host_port)| host_port)
            .unwrap_or(authority);
        let host = host_port
            .split_once(':')
            .map_or(host_port, |(host, _)| host);
        (!host.is_empty()).then(|| host.to_owned())
    }

    pub(crate) fn secret_ref(&mut self, name: &str, secret_name: &str, secret_prefix: &str) {
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

    pub(crate) fn into_option(self) -> Option<Vec<EnvVar>> {
        (!self.by_name.is_empty()).then(|| self.into_vec())
    }

    pub(crate) fn into_vec(self) -> Vec<EnvVar> {
        self.by_name.into_values().collect()
    }
}

fn env_var(name: &str, value: &str) -> EnvVar {
    EnvVar {
        name: name.to_owned(),
        value: Some(value.to_owned()),
        ..Default::default()
    }
}
