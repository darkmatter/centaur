use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use async_trait::async_trait;
use centaur_sandbox_core::{
    ObservedSandbox, SandboxBackend, SandboxError, SandboxHandle, SandboxId, SandboxIo,
    SandboxResult, SandboxSpec, SandboxStatus,
};
use tokio::sync::Mutex;

use crate::process::LocalSandbox;

#[derive(Clone, Default)]
pub struct LocalSandboxBackend {
    inner: Arc<Inner>,
}

#[derive(Default)]
struct Inner {
    next_id: AtomicU64,
    sandboxes: Mutex<HashMap<SandboxId, Arc<Mutex<LocalSandbox>>>>,
}

impl LocalSandboxBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_id(&self) -> SandboxId {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        SandboxId::new(format!("local-{id}"))
    }

    async fn sandbox(&self, id: &SandboxId) -> SandboxResult<Arc<Mutex<LocalSandbox>>> {
        self.inner
            .sandboxes
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| SandboxError::NotFound(id.as_str().to_owned()))
    }
}

#[async_trait]
impl SandboxBackend for LocalSandboxBackend {
    fn name(&self) -> &'static str {
        "local"
    }

    async fn create(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
        let sandbox = LocalSandbox::spawn(&spec).await?;
        let id = self.next_id();
        self.inner
            .sandboxes
            .lock()
            .await
            .insert(id.clone(), Arc::new(Mutex::new(sandbox)));
        Ok(SandboxHandle::new(id, self.name()))
    }

    async fn open_io(&self, id: &SandboxId) -> SandboxResult<SandboxIo> {
        let sandbox = self.sandbox(id).await?;
        sandbox.lock().await.open_io(id).await
    }

    async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus> {
        let sandbox = self.sandbox(id).await?;
        sandbox.lock().await.status().await
    }

    async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
        Ok(ObservedSandbox::new(
            id.clone(),
            self.name(),
            self.status(id).await?,
        ))
    }

    async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
        let ids = self
            .inner
            .sandboxes
            .lock()
            .await
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut observed = Vec::with_capacity(ids.len());
        for id in ids {
            observed.push(self.observe(&id).await?);
        }
        Ok(observed)
    }

    async fn stop(&self, id: &SandboxId) -> SandboxResult<()> {
        let Some(sandbox) = self.inner.sandboxes.lock().await.remove(id) else {
            return Ok(());
        };
        sandbox.lock().await.stop().await
    }

    async fn pause(&self, id: &SandboxId) -> SandboxResult<()> {
        let sandbox = self.sandbox(id).await?;
        sandbox.lock().await.pause().await
    }

    async fn resume(&self, id: &SandboxId) -> SandboxResult<()> {
        let sandbox = self.sandbox(id).await?;
        sandbox.lock().await.resume().await
    }
}
