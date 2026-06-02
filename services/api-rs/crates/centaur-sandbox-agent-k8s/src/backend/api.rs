use centaur_sandbox_core::{SandboxId, SandboxResult};
use k8s_openapi::api::apps::v1::Deployment;
use k8s_openapi::api::core::v1::{ConfigMap, Pod, Service};
use k8s_openapi::api::networking::v1::NetworkPolicy;
use kube::Api;
use kube::api::{Patch, PatchParams};
use serde_json::json;

use super::{AgentSandboxBackend, is_not_found, map_kube_error};
use crate::crd;

impl AgentSandboxBackend {
    pub(in crate::backend) fn sandboxes(&self) -> Api<crd::Sandbox> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    pub(in crate::backend) fn pods(&self) -> Api<Pod> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    pub(in crate::backend) fn config_maps(&self) -> Api<ConfigMap> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    pub(in crate::backend) fn services(&self) -> Api<Service> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    pub(in crate::backend) fn network_policies(&self) -> Api<NetworkPolicy> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    pub(in crate::backend) fn deployments(&self) -> Api<Deployment> {
        Api::namespaced(self.client.clone(), &self.config.namespace)
    }

    pub(in crate::backend) async fn get_sandbox(
        &self,
        id: &SandboxId,
    ) -> SandboxResult<Option<crd::Sandbox>> {
        match self.sandboxes().get(id.as_str()).await {
            Ok(sandbox) => Ok(Some(sandbox)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(map_kube_error("get sandbox", err)),
        }
    }

    pub(in crate::backend) async fn get_pod(&self, id: &SandboxId) -> SandboxResult<Option<Pod>> {
        match self.pods().get(id.as_str()).await {
            Ok(pod) => Ok(Some(pod)),
            Err(err) if is_not_found(&err) => Ok(None),
            Err(err) => Err(map_kube_error("get sandbox pod", err)),
        }
    }

    pub(in crate::backend) async fn patch_replicas(
        &self,
        id: &SandboxId,
        replicas: i32,
    ) -> SandboxResult<()> {
        let params = PatchParams::apply(&self.config.field_manager);
        let patch = Patch::Merge(json!({ "spec": { "replicas": replicas } }));
        self.sandboxes()
            .patch(id.as_str(), &params, &patch)
            .await
            .map(|_| ())
            .map_err(|err| map_kube_error("patch sandbox replicas", err))
    }
}
