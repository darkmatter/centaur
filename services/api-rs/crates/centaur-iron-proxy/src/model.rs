use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::{IronProxyConfigError, Result, SourcePolicy};

const MANAGED_TRANSFORMS: &[&str] = &["secrets", "gcp_auth", "oauth_token", "hmac_sign"];

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProxyFragment {
    #[serde(default)]
    pub transforms: Vec<Transform>,
    #[serde(default)]
    pub postgres: Vec<PostgresListener>,
    #[serde(default)]
    pub broker_credentials: Vec<BrokerCredential>,
    #[serde(default, flatten)]
    pub top_level: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct ProxyConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) transforms: Vec<Transform>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) postgres: Vec<PostgresListener>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) proxy: Option<ProxySection>,
    #[serde(default, flatten)]
    pub(crate) top_level: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct ProxySection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) tunnel_listen: Option<String>,
    #[serde(default, flatten)]
    pub(crate) extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Transform {
    pub name: String,
    #[serde(default, skip_serializing_if = "TransformConfig::is_empty")]
    pub config: TransformConfig,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Transform {
    pub(crate) fn is_managed(&self) -> bool {
        MANAGED_TRANSFORMS.contains(&self.name.as_str())
    }

    pub(crate) fn is_secrets(&self) -> bool {
        self.name == "secrets"
    }

    pub(crate) fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if self.is_secrets() {
            for secret in &mut self.config.secrets {
                secret.fill_missing_source(source_policy)?;
            }
        }
        self.config.resolve_sources(source_policy)?;
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TransformConfig {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub secrets: Vec<Secret>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl TransformConfig {
    fn is_empty(&self) -> bool {
        self.secrets.is_empty() && self.extra.is_empty()
    }

    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        for secret in &mut self.secrets {
            secret.resolve_sources(source_policy)?;
        }
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Secret {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub replace: Option<SecretReplace>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inject: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rules: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_value: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Secret {
    pub(crate) fn explicit_id(&self) -> Option<&str> {
        non_empty(self.id.as_deref())
    }

    pub(crate) fn proxy_value(&self) -> Option<&str> {
        self.replace
            .as_ref()
            .and_then(|replace| replace.proxy_value.as_deref())
            .or(self.proxy_value.as_deref())
    }

    fn fill_missing_source(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if self.source.is_some() {
            return Ok(());
        }
        if let Some(proxy_value) = self.proxy_value() {
            self.source = Some(source_policy.source_for(proxy_value, None)?);
        }
        Ok(())
    }

    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if let Some(source) = &mut self.source {
            resolve_placeholder_source_values(source, source_policy)?;
        }
        if let Some(replace) = &mut self.replace {
            replace.resolve_sources(source_policy)?;
        }
        if let Some(inject) = &mut self.inject {
            resolve_placeholder_source_values(inject, source_policy)?;
        }
        resolve_source_values(&mut self.rules, source_policy)?;
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SecretReplace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_value: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl SecretReplace {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PostgresListener {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub listen: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<PostgresUpstream>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client: Option<PostgresClient>,
    #[serde(default, skip_serializing)]
    pub sandbox_env: Option<SandboxEnv>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl PostgresListener {
    pub(crate) fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if let Some(upstream) = &mut self.upstream {
            upstream.resolve_sources(source_policy)?;
        }
        if let Some(client) = &mut self.client {
            client.resolve_sources(source_policy)?;
        }
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PostgresUpstream {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dsn: Option<Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl PostgresUpstream {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        if let Some(dsn) = &mut self.dsn {
            resolve_placeholder_source_values(dsn, source_policy)?;
        }
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PostgresClient {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password_env: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl PostgresClient {
    fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct SandboxEnv {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database: Option<String>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BrokerCredential {
    pub id: String,
    pub token_endpoint: String,
    pub client_id: Value,
    pub store: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub token_endpoint_headers: BTreeMap<String, Value>,
    #[serde(default, flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl BrokerCredential {
    pub(crate) fn resolve_sources(&mut self, source_policy: &SourcePolicy) -> Result<()> {
        resolve_placeholder_source_values(&mut self.client_id, source_policy)?;
        resolve_broker_store_source(&mut self.store, source_policy)?;
        if let Some(client_secret) = &mut self.client_secret {
            resolve_placeholder_source_values(client_secret, source_policy)?;
        }
        resolve_source_values(self.token_endpoint_headers.values_mut(), source_policy)?;
        resolve_source_values(self.extra.values_mut(), source_policy)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PgDsnEnv {
    pub env_name: String,
    pub database: String,
    pub port: u16,
    pub password_env: String,
}

pub(crate) fn listen_port(value: &str) -> Option<u16> {
    value.rsplit_once(':')?.1.parse().ok()
}

pub(crate) fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

pub(crate) fn value_field_str<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?
        .as_mapping()?
        .get(Value::String(key.to_owned()))?
        .as_str()
}

pub(crate) fn resolve_source_values<'a>(
    values: impl IntoIterator<Item = &'a mut Value>,
    source_policy: &SourcePolicy,
) -> Result<()> {
    for value in values {
        resolve_placeholder_source_values(value, source_policy)?;
    }
    Ok(())
}

pub(crate) fn resolve_placeholder_source_values(
    value: &mut Value,
    source_policy: &SourcePolicy,
) -> Result<()> {
    if let Some(placeholder) = value_field_str(Some(value), "placeholder").map(ToOwned::to_owned) {
        let json_key = value_field_str(Some(value), "json_key").map(ToOwned::to_owned);
        *value = source_policy.source_for(&placeholder, json_key.as_deref())?;
        return Ok(());
    }

    match value {
        Value::Mapping(map) => {
            if map.get(string_value("type")).and_then(Value::as_str) == Some("token_broker")
                && !map.contains_key(string_value("ttl"))
            {
                map.insert(
                    string_value("ttl"),
                    string_value(&source_policy.token_broker_ttl),
                );
            }
            for child in map.values_mut() {
                resolve_placeholder_source_values(child, source_policy)?;
            }
        }
        Value::Sequence(values) => {
            for child in values {
                resolve_placeholder_source_values(child, source_policy)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn resolve_broker_store_source(value: &mut Value, source_policy: &SourcePolicy) -> Result<()> {
    if let Some(placeholder) = value_field_str(Some(value), "placeholder").map(ToOwned::to_owned) {
        if value_has_field(value, "json_key") {
            return Err(IronProxyConfigError::BrokerStoreJsonKey { placeholder });
        }
        *value = source_policy.store_source_for(&placeholder)?;
        return Ok(());
    }
    if value_field_str(Some(value), "type") == Some("env") {
        let placeholder = value_field_str(Some(value), "var")
            .unwrap_or("store")
            .to_owned();
        return Err(IronProxyConfigError::BrokerStoreEnv { placeholder });
    }
    Ok(())
}

fn value_has_field(value: &Value, key: &str) -> bool {
    value
        .as_mapping()
        .is_some_and(|map| map.contains_key(Value::String(key.to_owned())))
}

fn string_value(value: impl AsRef<str>) -> Value {
    Value::String(value.as_ref().to_owned())
}
