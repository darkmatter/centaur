//! Backend-neutral sandbox runtime types.
//!
//! This crate intentionally models only isolated runtime workloads. Centaur
//! concepts such as thread keys, personas, harnesses, model choice, assignment
//! generations, and durable execution rows belong in higher-level crates.

mod backend;
mod error;
mod io;
mod lifecycle;
mod spec;

pub use backend::SandboxBackend;
pub use error::{SandboxError, SandboxResult};
pub use io::{OutputStream, ReadOptions, ReadResult, WriteAck};
pub use lifecycle::{
    DesiredSandboxState, ObservedSandbox, SandboxHandle, SandboxId, SandboxStatus,
};
pub use spec::{EnvVar, ExecCommand, ExecResult, Mount, MountKind, ResourceLimits, SandboxSpec};
