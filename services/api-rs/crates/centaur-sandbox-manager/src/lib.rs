//! Thin orchestration over a sandbox backend.
//!
//! The manager owns desired state and transition policy. Backends own the
//! runtime-specific work needed to make those transitions happen.

mod manager;
mod reconcile;
mod store;

pub use manager::{ManagedSandbox, SandboxManager};
pub use reconcile::{DriftReason, ReconcileAction, ReconcileOutcome, ReconcilePlan};
pub use store::{DesiredStateStore, InMemoryDesiredStateStore};

#[cfg(test)]
mod tests;
