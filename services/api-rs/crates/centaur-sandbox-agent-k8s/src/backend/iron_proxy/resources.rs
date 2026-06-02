use std::collections::BTreeMap;
use std::time::Duration;

use centaur_sandbox_core::{SandboxError, SandboxId, SandboxResult, SandboxStatus};
use k8s_openapi::api::core::v1::ConfigMap;
use kube::api::{DeleteParams, ListParams, PostParams};
use tokio::time::{Instant, sleep};

use super::super::{AgentSandboxBackend, is_not_found, map_kube_error};
use crate::SANDBOX_ID_LABEL;
use crate::resources::*;

impl AgentSandboxBackend {
    async fn create_iron_proxy_configmap(
        &self,
        id: &SandboxId,
        resolved: Option<&ResolvedIronProxy>,
    ) -> SandboxResult<()> {
        let Some(resolved) = resolved else {
            return Ok(());
        };
        let name = iron_proxy_configmap_name(id);
        let _ = self.delete_iron_proxy_configmap(id).await;
        let body = ConfigMap {
            metadata: object_meta(name, iron_proxy_labels(id)),
            data: Some(BTreeMap::from([(
                "proxy.yaml".to_owned(),
                resolved.config_yaml.clone(),
            )])),
            ..Default::default()
        };
        self.config_maps()
            .create(&PostParams::default(), &body)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("create iron-proxy configmap", err))
    }

    async fn delete_iron_proxy_configmap(&self, id: &SandboxId) -> SandboxResult<()> {
        if self.config.iron_proxy.is_none() {
            return Ok(());
        }
        match self
            .config_maps()
            .delete(&iron_proxy_configmap_name(id), &DeleteParams::default())
            .await
        {
            Ok(_) => Ok(()),
            Err(err) if is_not_found(&err) => Ok(()),
            Err(err) => Err(map_kube_error("delete iron-proxy configmap", err)),
        }
    }

    pub(in crate::backend) async fn create_iron_proxy_resources(
        &self,
        id: &SandboxId,
        resolved: Option<&ResolvedIronProxy>,
    ) -> SandboxResult<()> {
        let Some(resolved) = resolved else {
            return Ok(());
        };
        if let Some(iron_proxy) = &self.config.iron_proxy {
            self.reconcile_token_broker(iron_proxy).await?;
        }
        self.delete_iron_proxy_resources(id).await?;
        self.create_iron_proxy_configmap(id, Some(resolved)).await?;
        self.create_iron_proxy_service(id, resolved).await?;
        self.create_iron_proxy_network_policies(id, resolved)
            .await?;
        self.create_iron_proxy_pod(id, resolved).await?;
        self.wait_until_proxy_running(resolved).await
    }

    async fn create_iron_proxy_service(
        &self,
        id: &SandboxId,
        resolved: &ResolvedIronProxy,
    ) -> SandboxResult<()> {
        let service = build_iron_proxy_service(id, resolved);
        self.services()
            .create(&PostParams::default(), &service)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("create iron-proxy service", err))
    }

    async fn create_iron_proxy_pod(
        &self,
        id: &SandboxId,
        resolved: &ResolvedIronProxy,
    ) -> SandboxResult<()> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(());
        };
        let pod = build_iron_proxy_pod(id, &resolved.proxy_pod_name, iron_proxy, resolved);
        self.pods()
            .create(&PostParams::default(), &pod)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("create iron-proxy pod", err))
    }

    async fn create_iron_proxy_network_policies(
        &self,
        id: &SandboxId,
        resolved: &ResolvedIronProxy,
    ) -> SandboxResult<()> {
        let Some(iron_proxy) = &self.config.iron_proxy else {
            return Ok(());
        };
        for policy in build_iron_proxy_network_policies(id, resolved, iron_proxy) {
            self.network_policies()
                .create(&PostParams::default(), &policy)
                .await
                .map_err(|err| map_kube_error("create iron-proxy network policy", err))?;
        }
        Ok(())
    }

    pub(in crate::backend) async fn delete_iron_proxy_resources(
        &self,
        id: &SandboxId,
    ) -> SandboxResult<()> {
        if self.config.iron_proxy.is_none() {
            return Ok(());
        }
        let _ = self
            .pods()
            .delete(&iron_proxy_pod_name(id), &DeleteParams::default())
            .await;
        let _ = self.delete_iron_proxy_pods_for_sandbox(id).await;
        let _ = self
            .services()
            .delete(&iron_proxy_service_name(id), &DeleteParams::default())
            .await;
        for name in [
            iron_proxy_sandbox_egress_policy_name(id),
            iron_proxy_policy_name(id),
        ] {
            let _ = self
                .network_policies()
                .delete(&name, &DeleteParams::default())
                .await;
        }
        self.delete_iron_proxy_configmap(id).await
    }

    async fn delete_iron_proxy_pods_for_sandbox(&self, id: &SandboxId) -> SandboxResult<()> {
        let params = ListParams::default().labels(&format!(
            "centaur.ai/iron-proxy=true,{SANDBOX_ID_LABEL}={}",
            id.as_str()
        ));
        let pods = self
            .pods()
            .list(&params)
            .await
            .map_err(|err| map_kube_error("list iron-proxy pods", err))?;
        for pod in pods.items {
            if let Some(name) = pod.metadata.name {
                let _ = self.pods().delete(&name, &DeleteParams::default()).await;
            }
        }
        Ok(())
    }

    async fn wait_until_proxy_running(&self, resolved: &ResolvedIronProxy) -> SandboxResult<()> {
        let deadline = Instant::now() + self.config.ready_timeout;
        let pod_name = &resolved.proxy_pod_name;
        loop {
            match self.pods().get(pod_name).await {
                Ok(pod) if sandbox_status_from_pod(1, Some(&pod)) == SandboxStatus::Running => {
                    return Ok(());
                }
                Ok(pod) if sandbox_status_from_pod(1, Some(&pod)) == SandboxStatus::Stopped => {
                    return Err(SandboxError::NotReady(format!(
                        "iron-proxy pod {pod_name} reached terminal state before running"
                    )));
                }
                Ok(pod) if Instant::now() >= deadline => {
                    return Err(SandboxError::NotReady(format!(
                        "iron-proxy pod {pod_name} did not become running before timeout; latest phase: {:?}",
                        pod.status.and_then(|status| status.phase)
                    )));
                }
                Ok(_) => sleep(Duration::from_millis(500)).await,
                Err(err) if is_not_found(&err) && Instant::now() < deadline => {
                    sleep(Duration::from_millis(500)).await;
                }
                Err(err) if is_not_found(&err) => {
                    return Err(SandboxError::NotReady(format!(
                        "iron-proxy pod {pod_name} was not created before timeout"
                    )));
                }
                Err(err) => return Err(map_kube_error("wait iron-proxy pod", err)),
            }
        }
    }
}
