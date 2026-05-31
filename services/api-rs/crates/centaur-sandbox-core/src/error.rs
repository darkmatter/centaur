use thiserror::Error;

pub type SandboxResult<T> = Result<T, SandboxError>;

#[derive(Debug, Error)]
pub enum SandboxError {
    #[error("sandbox {0} was not found")]
    NotFound(String),

    #[error("operation is unsupported by backend {backend}: {operation}")]
    Unsupported {
        backend: &'static str,
        operation: &'static str,
    },

    #[error("sandbox is not ready: {0}")]
    NotReady(String),

    #[error("sandbox I/O failed: {0}")]
    Io(String),

    #[error("backend operation failed: {0}")]
    Backend(String),

    #[error("invalid sandbox spec: {0}")]
    InvalidSpec(String),
}
