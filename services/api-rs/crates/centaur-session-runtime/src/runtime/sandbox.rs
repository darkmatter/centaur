use std::sync::Arc;

use centaur_sandbox_core::{
    CredentialProfile, HarnessAuthModes, SandboxBackend, SandboxHandle, SandboxId, SandboxIo,
    SandboxResult, SandboxSpec, SandboxStatus,
};
use centaur_sandbox_manager::SandboxManager;
use centaur_session_core::{HarnessType, ThreadKey};

use crate::SandboxWorkloadMode;

type SandboxSpecFactory = Arc<dyn Fn(&ThreadKey, &HarnessType, &str) -> SandboxSpec + Send + Sync>;

#[derive(Clone)]
pub struct SandboxRuntime {
    manager: Arc<SandboxManager>,
    spec_factory: SandboxSpecFactory,
}

impl SandboxRuntime {
    pub fn backend(backend: Arc<dyn SandboxBackend>, spec: SandboxSpec) -> Self {
        let spec_factory = move |_thread_key: &ThreadKey,
                                 _harness_type: &HarnessType,
                                 _execution_id: &str| { spec.clone() };
        Self::backend_with_spec_factory(backend, spec_factory)
    }

    pub fn backend_with_workload(
        backend: Arc<dyn SandboxBackend>,
        workload: SandboxWorkloadMode,
        auth_modes: HarnessAuthModes,
    ) -> Self {
        Self::backend_with_spec_factory(backend, move |thread_key, harness_type, _execution_id| {
            let profile = credential_profile_for(harness_type);
            workload.spec(thread_key, profile, auth_modes.mode_for(profile))
        })
    }

    pub fn backend_with_spec_factory<F>(backend: Arc<dyn SandboxBackend>, spec_factory: F) -> Self
    where
        F: Fn(&ThreadKey, &HarnessType, &str) -> SandboxSpec + Send + Sync + 'static,
    {
        Self {
            manager: Arc::new(SandboxManager::new(backend)),
            spec_factory: Arc::new(spec_factory),
        }
    }

    pub(super) async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus> {
        self.manager.status(id).await
    }

    pub(super) async fn open_io(&self, id: &SandboxId) -> SandboxResult<SandboxIo> {
        self.manager.open_io(id).await
    }

    pub(super) async fn create_running(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
        self.manager.create_running(spec).await
    }

    pub(super) fn spec(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
        execution_id: &str,
    ) -> SandboxSpec {
        (self.spec_factory)(thread_key, harness_type, execution_id)
    }
}

fn credential_profile_for(harness_type: &HarnessType) -> CredentialProfile {
    match harness_type {
        HarnessType::Codex => CredentialProfile::Codex,
        HarnessType::Amp => CredentialProfile::Amp,
        HarnessType::ClaudeCode => CredentialProfile::ClaudeCode,
    }
}
