//! Local process sandbox backend.
//!
//! This backend is for development and manager validation. It runs one local
//! child process per sandbox and wires byte-oriented stdin/stdout/stderr through
//! the shared sandbox trait.

mod backend;
mod process;

pub use backend::LocalSandboxBackend;

#[cfg(test)]
mod tests;
