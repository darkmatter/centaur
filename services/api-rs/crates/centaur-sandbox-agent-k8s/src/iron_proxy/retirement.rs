//! Retire one proven terminal agent generation without admitting a replacement.
//! The Pod pin spans the two Kubernetes objects; its stored owner revision must
//! never be refreshed. See RFC 0006 for crash recovery and resume ordering.

use serde::{Deserialize, Serialize};

use super::*;
use crate::crd;

pub(crate) const RETIREMENT_ANNOTATION: &str = "centaur.ai/terminal-proxy-retirement";
const RETIREMENT_FINALIZER: &str = "centaur.ai/terminal-proxy-retirement";
pub(crate) const RESUME_ANNOTATION: &str = "centaur.ai/resume-operation";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct Retirement {
    owner_name: String,
    owner_uid: String,
    owner_revision: String,
    pod_uid: String,
    cutoff: String,
}

impl Retirement {
    fn from_metadata(metadata: &ObjectMeta) -> Option<Self> {
        let raw = metadata.annotations.as_ref()?.get(RETIREMENT_ANNOTATION)?;
        let decision: Self = serde_json::from_str(raw).ok()?;
        if [
            &decision.owner_name,
            &decision.owner_uid,
            &decision.owner_revision,
            &decision.pod_uid,
        ]
        .iter()
        .any(|value| value.is_empty())
            || decision.cutoff.parse::<jiff::Timestamp>().is_err()
        {
            return None;
        }
        Some(decision)
    }

    fn owns_fence(&self, sandbox: &crd::Sandbox) -> bool {
        sandbox.metadata.uid.as_deref() == Some(&self.owner_uid)
            && sandbox.metadata.name.as_deref() == Some(&self.owner_name)
            && tracks_agent_named(sandbox, &self.owner_name)
            && Self::from_metadata(&sandbox.metadata).as_ref() == Some(self)
            && sandbox.spec.shutdown_policy == Some(crd::SandboxShutdownPolicy::Retain)
            && sandbox.spec.shutdown_time.as_deref() == Some(&self.cutoff)
            && self
                .cutoff
                .parse::<jiff::Timestamp>()
                .is_ok_and(|cutoff| cutoff <= jiff::Timestamp::now())
    }

    fn owner_unchanged(&self, sandbox: &crd::Sandbox) -> bool {
        sandbox.metadata.uid.as_deref() == Some(&self.owner_uid)
            && sandbox.metadata.resource_version.as_deref() == Some(&self.owner_revision)
    }
}

fn tracks_agent_named(sandbox: &crd::Sandbox, name: &str) -> bool {
    sandbox
        .metadata
        .annotations
        .as_ref()
        .and_then(|annotations| annotations.get("agents.x-k8s.io/pod-name"))
        .is_none_or(|tracked| tracked == name)
}

pub(crate) fn sandbox_retired(sandbox: &crd::Sandbox) -> bool {
    Retirement::from_metadata(&sandbox.metadata)
        .is_some_and(|decision| decision.owns_fence(sandbox))
}

fn expiry_acknowledged(sandbox: &crd::Sandbox) -> bool {
    sandbox.metadata.generation.is_some()
        && sandbox
            .status
            .as_ref()
            .and_then(|status| status.conditions.as_ref())
            .is_some_and(|conditions| {
                conditions.iter().any(|condition| {
                    condition.type_ == "Ready"
                        && condition.status == "False"
                        && condition.reason == "SandboxExpired"
                        && condition.observed_generation == sandbox.metadata.generation
                })
            })
}

fn pinned(pod: &Pod) -> bool {
    pod.metadata
        .finalizers
        .as_ref()
        .is_some_and(|finalizers| finalizers.iter().any(|value| value == RETIREMENT_FINALIZER))
}

fn stale_write(error: &kube::Error) -> bool {
    matches!(error, kube::Error::Api(response) if response.code == 409 || response.code == 404)
}

impl AgentSandboxBackend {
    pub(super) async fn reconcile_terminal_proxy_owners(
        &self,
        grace: Duration,
    ) -> SandboxResult<()> {
        let managed =
            ListParams::default().labels(&format!("{MANAGED_BY_LABEL}={MANAGED_BY_VALUE}"));
        // Recovery cannot depend on a proxy still existing: resume or unwind
        // may have removed every companion after a worker acquired this pin.
        let pods = self
            .pods()
            .list(&managed)
            .await
            .map_err(|err| map_kube_error("list terminal retirement pins", err))?;
        for pod in pods.items.iter().filter(|pod| pinned(pod)) {
            self.recover_terminal_retirement(pod).await?;
        }
        // Disabling new decisions must not strand a pin or committed fence.
        if !self.config.terminal_proxy_retirement_enabled {
            return Ok(());
        }
        let sandboxes = self
            .sandboxes()
            .list(&managed)
            .await
            .map_err(|err| map_kube_error("list terminal retirement owners", err))?;
        for sandbox in sandboxes.items {
            let Some(name) = sandbox.metadata.name.as_deref() else {
                continue;
            };
            let id = SandboxId::new(name);
            // Capture the owner revision BEFORE all Pod/cohort evidence. A
            // post-resume revision must never authorize an old decision.
            let Some(owner) = self.get_sandbox(&id).await? else {
                continue;
            };
            if owner.metadata.uid != sandbox.metadata.uid
                || owner.metadata.resource_version != sandbox.metadata.resource_version
                || owner.metadata.deletion_timestamp.is_some()
                || owner.spec.replicas.unwrap_or(1) == 0
                || owner.spec.shutdown_time.is_some()
                || owner.spec.shutdown_policy != Some(crd::SandboxShutdownPolicy::Retain)
                || !tracks_agent_named(&owner, name)
            {
                continue;
            }
            let Some(pod) = self.get_pod(&id).await? else {
                continue;
            };
            if pinned(&pod)
                || !pod_stopped(&pod)
                || pod.metadata.deletion_timestamp.is_some()
                || !owned_by_sandbox(&pod.metadata, &owner.metadata)
            {
                continue;
            }
            let (
                Some(owner_uid),
                Some(owner_revision),
                Some(pod_uid),
                Some(pod_revision),
                Some(created),
            ) = (
                owner.metadata.uid.as_ref(),
                owner.metadata.resource_version.as_ref(),
                pod.metadata.uid.as_ref(),
                pod.metadata.resource_version.as_ref(),
                pod.metadata.creation_timestamp.as_ref(),
            )
            else {
                continue;
            };
            if created.0 > jiff::Timestamp::now()
                || !self
                    .terminal_proxy_cohort(&id, &owner.metadata, created.0, grace)
                    .await?
            {
                continue;
            }
            let decision = Retirement {
                owner_name: name.to_owned(),
                owner_uid: owner_uid.clone(),
                owner_revision: owner_revision.clone(),
                pod_uid: pod_uid.clone(),
                cutoff: created.0.to_string(),
            };
            let mut finalizers = pod.metadata.finalizers.clone().unwrap_or_default();
            finalizers.push(RETIREMENT_FINALIZER.to_owned());
            let patch = json!({"metadata": {
                "uid": pod_uid, "resourceVersion": pod_revision, "finalizers": finalizers,
                "annotations": {RETIREMENT_ANNOTATION: serde_json::to_string(&decision)
                    .map_err(|error| SandboxError::backend_source("encode terminal retirement", error))?}
            }});
            match self
                .pods()
                .patch(name, &PatchParams::default(), &Patch::Merge(patch))
                .await
            {
                Ok(pinned) => self.recover_terminal_retirement(&pinned).await?,
                Err(error) if stale_write(&error) => {}
                Err(error) => return Err(map_kube_error("pin terminal agent", error)),
            }
        }
        Ok(())
    }

    async fn terminal_proxy_cohort(
        &self,
        id: &SandboxId,
        owner: &ObjectMeta,
        cutoff: jiff::Timestamp,
        grace: Duration,
    ) -> SandboxResult<bool> {
        let selector = format!(
            "{MANAGED_BY_LABEL}={MANAGED_BY_VALUE},{SANDBOX_ID_LABEL}={}",
            id.as_str()
        );
        let proxy = ListParams::default().labels(&format!("{selector},{IRON_PROXY_LABEL}=true"));
        let mut resources = self
            .pods()
            .list(&proxy)
            .await
            .map_err(|err| map_kube_error("list terminal proxy cohort pods", err))?
            .items
            .into_iter()
            .map(|pod| pod.metadata)
            .collect::<Vec<_>>();
        resources.extend(
            self.services()
                .list(&proxy)
                .await
                .map_err(|err| map_kube_error("list terminal proxy cohort services", err))?
                .items
                .into_iter()
                .map(|service| service.metadata),
        );
        resources.extend(
            self.network_policies()
                .list(&ListParams::default().labels(&selector))
                .await
                .map_err(|err| map_kube_error("list terminal proxy cohort policies", err))?
                .items
                .into_iter()
                .map(|policy| policy.metadata),
        );
        let now = SystemTime::now();
        Ok(!resources.is_empty()
            && resources.iter().all(|metadata| {
                metadata.uid.is_some()
                    && metadata.resource_version.is_some()
                    && metadata.deletion_timestamp.is_none()
                    && owned_by_sandbox(metadata, owner)
                    && proxy_resource_past_grace(metadata, now, grace)
                    && metadata
                        .creation_timestamp
                        .as_ref()
                        .is_some_and(|created| created.0 < cutoff)
            }))
    }

    async fn recover_terminal_retirement(&self, pod: &Pod) -> SandboxResult<()> {
        let Some(decision) = Retirement::from_metadata(&pod.metadata) else {
            tracing::warn!(pod = ?pod.metadata.name, "terminal retirement pin has invalid decision; retaining pin");
            return Ok(());
        };
        if pod.metadata.uid.as_deref() != Some(&decision.pod_uid) || !pod_stopped(pod) {
            return Ok(());
        }
        let id = SandboxId::new(&decision.owner_name);
        let owner = self.get_sandbox(&id).await?;
        if let Some(owner) = owner
            .as_ref()
            .filter(|owner| decision.owner_unchanged(owner))
        {
            if !owned_by_sandbox(&pod.metadata, &owner.metadata) {
                return Ok(());
            }
            let patch = json!({
                "metadata": {"uid": decision.owner_uid, "resourceVersion": decision.owner_revision,
                    "annotations": {RETIREMENT_ANNOTATION: serde_json::to_string(&decision)
                        .map_err(|error| SandboxError::backend_source("encode terminal retirement", error))?}},
                "spec": {"shutdownTime": decision.cutoff, "shutdownPolicy": "Retain"}
            });
            match self
                .sandboxes()
                .patch(id.as_str(), &PatchParams::default(), &Patch::Merge(patch))
                .await
            {
                Ok(_) => {}
                Err(error) if stale_write(&error) => {}
                Err(error) => {
                    return Err(map_kube_error("retire terminal agent generation", error));
                }
            }
        }
        self.release_terminal_retirement_pin(&id).await
    }

    pub(crate) async fn release_terminal_retirement_pin(
        &self,
        id: &SandboxId,
    ) -> SandboxResult<()> {
        let Some(pod) = self.get_pod(id).await? else {
            return Ok(());
        };
        if !pinned(&pod) {
            return Ok(());
        }
        let Some(decision) = Retirement::from_metadata(&pod.metadata) else {
            return Ok(());
        };
        if pod.metadata.uid.as_deref() != Some(&decision.pod_uid) {
            return Ok(());
        }
        if let Some(owner) = self.get_sandbox(id).await? {
            if owner.metadata.uid.is_none() || owner.metadata.resource_version.is_none() {
                return Ok(());
            }
            if decision.owns_fence(&owner) && owner.spec.replicas.unwrap_or(1) != 0 {
                // The acknowledgement also fences an older controller cache
                // snapshot. Ready=False alone precedes actual Pod deletion.
                if !expiry_acknowledged(&owner) {
                    return Ok(());
                }
            } else if decision.owner_unchanged(&owner) {
                // An old worker can still commit this exact decision.
                return Ok(());
            }
        }
        let Some(revision) = pod.metadata.resource_version.as_ref() else {
            return Ok(());
        };
        let finalizers = pod
            .metadata
            .finalizers
            .as_deref()
            .unwrap_or_default()
            .iter()
            .filter(|value| value.as_str() != RETIREMENT_FINALIZER)
            .collect::<Vec<_>>();
        let patch = json!({"metadata": {"uid": decision.pod_uid, "resourceVersion": revision,
            "finalizers": finalizers, "annotations": {RETIREMENT_ANNOTATION: null}}});
        match self
            .pods()
            .patch(id.as_str(), &PatchParams::default(), &Patch::Merge(patch))
            .await
        {
            Ok(_) => Ok(()),
            Err(error) if stale_write(&error) => Ok(()),
            Err(error) => Err(map_kube_error("release terminal agent pin", error)),
        }
    }

    pub(super) async fn retired_proxy_resource(
        &self,
        metadata: &ObjectMeta,
        sandbox: &crd::Sandbox,
    ) -> SandboxResult<bool> {
        let Some(decision) = Retirement::from_metadata(&sandbox.metadata) else {
            return Ok(false);
        };
        if !decision.owns_fence(sandbox)
            || !expiry_acknowledged(sandbox)
            || sandbox.metadata.deletion_timestamp.is_some()
            || !owned_by_sandbox(metadata, &sandbox.metadata)
            || !metadata.creation_timestamp.as_ref().is_some_and(|created| {
                decision
                    .cutoff
                    .parse::<jiff::Timestamp>()
                    .is_ok_and(|cutoff| created.0 < cutoff)
            })
        {
            return Ok(false);
        }
        Ok(self
            .get_pod(&SandboxId::new(&decision.owner_name))
            .await?
            .is_none())
    }
}
