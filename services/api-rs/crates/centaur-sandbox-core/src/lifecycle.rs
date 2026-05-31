use serde::{Deserialize, Serialize};

use crate::SandboxSpec;

#[derive(Clone, Debug, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub struct SandboxId(String);

impl SandboxId {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl From<String> for SandboxId {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SandboxId {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl AsRef<str> for SandboxId {
    fn as_ref(&self) -> &str {
        self.as_str()
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct SandboxHandle {
    pub id: SandboxId,
    pub backend: String,
}

impl SandboxHandle {
    pub fn new(id: impl Into<SandboxId>, backend: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            backend: backend.into(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum SandboxStatus {
    Created,
    Running,
    Suspended,
    Stopped,
    Gone,
    Unknown(String),
}

impl SandboxStatus {
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Stopped | Self::Gone)
    }

    pub fn can_read_write(&self) -> bool {
        matches!(self, Self::Running)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ObservedSandbox {
    pub id: SandboxId,
    pub backend: String,
    pub status: SandboxStatus,
    pub generation: Option<String>,
    pub reason: Option<String>,
}

impl ObservedSandbox {
    pub fn new(
        id: impl Into<SandboxId>,
        backend: impl Into<String>,
        status: SandboxStatus,
    ) -> Self {
        Self {
            id: id.into(),
            backend: backend.into(),
            status,
            generation: None,
            reason: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum DesiredSandboxState {
    Running(SandboxSpec),
    Suspended(SandboxSpec),
    Stopped,
}
