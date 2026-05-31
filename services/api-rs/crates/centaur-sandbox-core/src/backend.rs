use async_trait::async_trait;
use bytes::Bytes;

use crate::{
    ExecCommand, ExecResult, ObservedSandbox, ReadOptions, ReadResult, SandboxHandle, SandboxId,
    SandboxResult, SandboxSpec, SandboxStatus, WriteAck,
};

#[async_trait]
pub trait SandboxBackend: Send + Sync {
    fn name(&self) -> &'static str;

    async fn create(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle>;

    async fn read_bytes(&self, id: &SandboxId, opts: ReadOptions) -> SandboxResult<ReadResult>;

    async fn write_bytes(&self, id: &SandboxId, bytes: Bytes) -> SandboxResult<WriteAck>;

    async fn close_stdin(&self, id: &SandboxId) -> SandboxResult<()>;

    async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus>;

    async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox>;

    async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>>;

    async fn stop(&self, id: &SandboxId) -> SandboxResult<()>;

    async fn pause(&self, id: &SandboxId) -> SandboxResult<()>;

    async fn resume(&self, id: &SandboxId) -> SandboxResult<()>;

    async fn exec(&self, id: &SandboxId, command: ExecCommand) -> SandboxResult<ExecResult>;

    async fn interrupt(&self, id: &SandboxId) -> SandboxResult<()>;
}
