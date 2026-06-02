use std::collections::BTreeMap;

use centaur_sandbox_core::{SandboxError, SandboxResult};
use k8s_openapi::api::core::v1::ConfigMap;
use kube::api::{Patch, PatchParams, PostParams};
use serde_json::json;

use super::super::{AgentSandboxBackend, is_not_found, map_kube_error};
use crate::TOKEN_BROKER_CONFIG_KEY;
use crate::config::IronProxyPodConfig;
use crate::resources::*;

impl AgentSandboxBackend {
    pub(super) async fn reconcile_token_broker(
        &self,
        iron_proxy: &IronProxyPodConfig,
    ) -> SandboxResult<()> {
        let Some(token_broker_name) = iron_proxy.token_broker_name.as_deref() else {
            return Ok(());
        };
        let mut fragments = centaur_iron_proxy::harness_broker_fragments().map_err(|err| {
            SandboxError::InvalidSpec(format!("iron-token-broker fragments: {err}"))
        })?;
        fragments.extend(iron_proxy.fragments.clone());
        let rendered = centaur_iron_proxy::render_token_broker_yaml_with_source_policy(
            &fragments,
            &iron_proxy.source_policy,
        )
        .map_err(|err| SandboxError::InvalidSpec(format!("iron-token-broker config: {err}")))?;
        if self
            .apply_token_broker_configmap(iron_proxy, &rendered)
            .await?
        {
            self.patch_token_broker_config_hash(token_broker_name, &short_sha256(&rendered))
                .await?;
        }
        Ok(())
    }

    async fn apply_token_broker_configmap(
        &self,
        iron_proxy: &IronProxyPodConfig,
        rendered: &str,
    ) -> SandboxResult<bool> {
        let name = iron_token_broker_configmap_name(iron_proxy)?;
        let data = BTreeMap::from([(TOKEN_BROKER_CONFIG_KEY.to_owned(), rendered.to_owned())]);
        match self.config_maps().get(&name).await {
            Ok(existing) => {
                if existing
                    .data
                    .as_ref()
                    .and_then(|data| data.get(TOKEN_BROKER_CONFIG_KEY))
                    .is_some_and(|value| value == rendered)
                {
                    return Ok(false);
                }
                let patch = Patch::Merge(json!({
                    "metadata": {"labels": token_broker_labels()},
                    "data": data,
                }));
                self.config_maps()
                    .patch(&name, &PatchParams::default(), &patch)
                    .await
                    .map(|_| true)
                    .map_err(|err| map_kube_error("patch iron-token-broker configmap", err))
            }
            Err(err) if is_not_found(&err) => {
                let body = ConfigMap {
                    metadata: object_meta(name, token_broker_labels()),
                    data: Some(data),
                    ..Default::default()
                };
                self.config_maps()
                    .create(&PostParams::default(), &body)
                    .await
                    .map(|_| true)
                    .map_err(|err| map_kube_error("create iron-token-broker configmap", err))
            }
            Err(err) => Err(map_kube_error("get iron-token-broker configmap", err)),
        }
    }

    async fn patch_token_broker_config_hash(
        &self,
        token_broker_name: &str,
        config_hash: &str,
    ) -> SandboxResult<()> {
        let patch = Patch::Merge(json!({
            "spec": {
                "template": {
                    "metadata": {
                        "annotations": {
                            "centaur.ai/config-hash": config_hash,
                        },
                    },
                },
            },
        }));
        match self
            .deployments()
            .patch(token_broker_name, &PatchParams::default(), &patch)
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("patch iron-token-broker deployment", err)),
        }
    }
}
