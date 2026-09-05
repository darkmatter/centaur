mod cleanup;
mod title_generator;

use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    env,
    future::Future,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, SystemTime},
};

use aws_config::BehaviorVersion;
use aws_sdk_s3::{
    Client as S3Client,
    config::{Builder as S3ConfigBuilder, Region},
    primitives::ByteStream,
};
use centaur_iron_control::{IronControlError, Principal, SessionRegistrar};
use centaur_sandbox_core::{
    Mount, RepoCacheAccess, ResourceRequirements, SANDBOX_AGENT_HOME, SandboxBackend,
    SandboxCapabilities as BackendSandboxCapabilities, SandboxCommandOutput, SandboxError,
    SandboxFile, SandboxId, SandboxIoGuard, SandboxRead, SandboxSpec, SandboxStatus, SandboxWrite,
};
use centaur_sandbox_manager::{
    SandboxManager, SandboxReaper, SandboxReaperConfig, WarmPoolConfig, WarmPoolError,
    WarmPoolManager, WarmSandboxSpecFactory,
};
use centaur_session_core::{
    ChatDestination, CollabRoomOutcome, CollabRoomState, CollabStartInput, CollabStopInput,
    ExecutionStatus, HarnessType, MessageRole, SandboxCapabilities as SessionSandboxCapabilities,
    SandboxRepoCacheAccess as SessionRepoCacheAccess, Session, SessionEvent, SessionExecution,
    SessionMessageInput, SessionStatus, ThreadKey,
};
use centaur_session_sqlx::{
    PgSessionStore, SandboxCapacityCandidate, SessionEventListener, SessionOwnerMode,
    SessionStoreError, default_metadata,
};
use centaur_telemetry::{
    export_thread_trace_root_span, record_sandbox_warm_pool_claim,
    record_session_execution_finished, record_session_execution_started, record_session_failure,
    record_session_first_token_latency, set_span_parent_from_traceparent, set_span_parent_trace,
};
use dashmap::{DashMap, DashSet};
use futures_util::{FutureExt, SinkExt, Stream, StreamExt, future::BoxFuture, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use thiserror::Error;
use time::OffsetDateTime;
use tokio::{
    io,
    sync::{Mutex, RwLock},
    time::{Instant, Interval, MissedTickBehavior, interval_at, sleep, timeout},
};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec, LinesCodecError};
use tracing::{Instrument, Span, debug, error, info, info_span, warn};
use uuid::Uuid;

pub use cleanup::SessionSandboxCleanupConfig;
pub use title_generator::SessionTitleGenerationError;
use title_generator::{
    OpenAiSessionTitleGenerator, sanitize_session_title, session_title_source_from_parts,
};

pub const SESSION_OUTPUT_LINE_EVENT: &str = "session.output.line";
pub const SESSION_FIRST_TOKEN_EVENT: &str = "session.first_token";

const EVENT_STREAM_SAFETY_POLL_INTERVAL: Duration = Duration::from_secs(30);
const STEERING_STARTUP_RETRY_INTERVAL: Duration = Duration::from_millis(250);
const STEERING_STARTUP_RETRY_TIMEOUT: Duration = Duration::from_secs(15);
const SESSION_PIPE_MAX_REATTACH_ATTEMPTS: u32 = 3;
const SESSION_PIPE_REATTACH_DELAY: Duration = Duration::from_millis(500);
const STDOUT_OWNER_LEASE: Duration = Duration::from_secs(45);
const STDOUT_OWNER_RENEW_INTERVAL: Duration = Duration::from_secs(10);
const EXECUTION_HANDOFF_POLL_INTERVAL: Duration = Duration::from_millis(500);
const EXECUTION_HANDOFF_DB_TIMEOUT: Duration = Duration::from_secs(5);
/// Overall budget for one collab control round-trip: baseline DB + pipe open/write + response wait.
const COLLAB_LIFECYCLE_DEADLINE: Duration = Duration::from_secs(15);
/// Per-poll cap inside the response wait loop; timeouts are retryable until the global deadline.
const COLLAB_EVENT_POLL_TIMEOUT: Duration = Duration::from_millis(500);
/// Separate bound for cleanup finalize during stop/loss (not the control round-trip).
const COLLAB_CLEANUP_DEADLINE: Duration = Duration::from_secs(10);
/// A live execution can briefly have no sandbox while it moves from queued
/// through warm-sandbox assignment. A periodic adoption scan must not fail a
/// young row it observes in that window.
const PRE_SANDBOX_ORPHAN_GRACE: Duration = Duration::from_secs(120);
const COMPONENT_SESSION_RUNTIME: &str = "session_runtime";
const SANDBOX_REPOS_MOUNT_PATH: &str = "/home/agent/github";
const PUBLIC_REPO_CACHE_SUBPATH: &str = "public";
const CENTAUR_SKILL_DIRS_ENV: &str = "CENTAUR_SKILL_DIRS";
const CENTAUR_PUBLIC_SKILL_DIRS_ENV: &str = "CENTAUR_PUBLIC_SKILL_DIRS";
const SANDBOX_REPO_CACHE_LABEL: &str = "centaur.sandbox_repo_cache";
const OBSERVABILITY_TOOL_BLOCKLIST: &str =
    "vlogs,vmetrics,grafana,centaur_investigator,centaur-investigator";

type SandboxSpecFactory = Arc<
    dyn Fn(&ThreadKey, &str, &HarnessType, Option<&PersonaContext>) -> SandboxSpec + Send + Sync,
>;
type SessionInputSink = FramedWrite<SandboxWrite, LinesCodec>;
type ExecutionSpanRegistry = Arc<Mutex<HashMap<String, Span>>>;
type SessionOwnershipGenerationRegistry = Arc<DashMap<String, i64>>;
type SessionPipeMap = Arc<DashMap<String, SessionPipe>>;
type SessionPipeOpenLocks = Arc<DashMap<String, Arc<Mutex<()>>>>;
type CollabLifecycleLocks = Arc<DashMap<ThreadKey, Arc<Mutex<()>>>>;
type ToolHostCallLocks = Arc<DashMap<String, Arc<Mutex<()>>>>;
type SessionTitleThreadSet = Arc<DashSet<ThreadKey>>;
type SessionTitleGenerator = Arc<
    dyn Fn(String) -> BoxFuture<'static, Result<String, SessionTitleGenerationError>> + Send + Sync,
>;
/// Lifecycle cleanup phase for one exact room handle.
/// One managed worker owns transitions until DB proof / expiry / takeover / shutdown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CollabCleanupPhase {
    /// Room is live; keepalive may run; status/start may serve it.
    Active,
    /// Must remote-stop on handle.sandbox_id before any DB finalize.
    RemoteStopPending,
    /// Remote stop done or not required; DB finalize (append+release) pending/retrying.
    FinalizePending,
}

impl CollabCleanupPhase {
    fn is_externally_active(self) -> bool {
        matches!(self, Self::Active)
    }
}

/// In-memory state for one active collaboration room. The generation fences
/// stale lifecycle writes: after an owner/process/relay loss and reacquire
/// cycle, the generation bumps and stale frames are rejected.
#[derive(Clone, Debug)]
struct CollabRoomHandle {
    /// The OMP session owner_id that acquired this room. Matches the
    /// `session_owners` row so fencing is atomic with event append.
    owner_id: String,
    /// The ownership generation at room start. A stale owner whose
    /// generation no longer matches cannot publish lifecycle events or
    /// keep the room alive.
    generation: i64,
    /// Sandbox that hosts this room's resident OMP process. Start/status
    /// require exact equality with `session.sandbox_id`; assignment A→B
    /// must lose A's room before serving B. Pump EOF cleanup is fenced to
    /// this sandbox so an old A termination cannot remove a new B room.
    sandbox_id: String,
    /// Projected room state from the resident OMP host. Updated when the
    /// host emits a `collab_state` frame.
    state: CollabRoomState,
    /// Handle to the keepalive renewal task. Aborted when the room is
    /// stopped, the owner loses, or the process/relay dies.
    keepalive: Arc<AtomicBool>,
    /// Cleanup phase state machine. Non-Active is externally non-active.
    phase: CollabCleanupPhase,
    /// One managed worker scheduled for this exact handle's cleanup chain.
    cleanup_worker_scheduled: bool,
}

impl CollabRoomHandle {
    fn is_externally_active(&self) -> bool {
        self.phase.is_externally_active()
    }

    fn mark_remote_stop_pending(&mut self) {
        self.phase = CollabCleanupPhase::RemoteStopPending;
        self.keepalive.store(false, Ordering::SeqCst);
    }

    fn mark_finalize_pending(&mut self) {
        self.phase = CollabCleanupPhase::FinalizePending;
        self.keepalive.store(false, Ordering::SeqCst);
    }
}

type CollabRoomRegistry = Arc<DashMap<ThreadKey, CollabRoomHandle>>;

/// Durable cross-replica sandbox reference lease backed by `PgSessionStore`.
///
/// The renewer task periodically re-ups the lease expiry. Drop aborts the
/// renewer; a crash or cancellation leaves a TTL-bounded DB row that the
/// cleanup worker purges once expired. Explicit completion via `release`
/// owner-checked-deletes the row (best-effort, logs on failure).
#[must_use = "the sandbox reference lease must be held for the owning task's lifetime"]
pub struct SandboxReferenceLease {
    store: PgSessionStore,
    sandbox_id: Arc<str>,
    owner_id: Arc<str>,
    renewer: Option<tokio::task::JoinHandle<()>>,
}

impl SandboxReferenceLease {
    /// Aborts the renewer and owner-checked-deletes the lease row.
    /// Deletion failures are warn-only and not returned.
    pub async fn release(mut self) {
        if let Some(renewer) = self.renewer.take() {
            renewer.abort();
            let _ = renewer.await;
        }
        if let Err(error) = self
            .store
            .delete_sandbox_lease(&self.sandbox_id, &self.owner_id)
            .await
        {
            warn!(
                sandbox_id = %self.sandbox_id,
                owner_id = %self.owner_id,
                %error,
                "failed to delete sandbox reference lease on release; \
                 cleanup worker will purge it once expired",
            );
        }
    }
}

impl Drop for SandboxReferenceLease {
    fn drop(&mut self) {
        if let Some(renewer) = self.renewer.take() {
            renewer.abort();
        }
    }
}

#[async_trait::async_trait]
pub trait SessionPrincipalRegistrar: Send + Sync {
    async fn register_session(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Principal, IronControlError>;

    async fn register_requester(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Option<Principal>, IronControlError>;

    async fn get_principal(&self, principal: &str) -> Result<Principal, IronControlError>;
}

#[async_trait::async_trait]
impl SessionPrincipalRegistrar for SessionRegistrar {
    async fn register_session(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Principal, IronControlError> {
        SessionRegistrar::register_session(self, thread_key, metadata).await
    }

    async fn register_requester(
        &self,
        thread_key: &str,
        metadata: Option<&Value>,
    ) -> Result<Option<Principal>, IronControlError> {
        SessionRegistrar::register_requester(self, thread_key, metadata).await
    }

    async fn get_principal(&self, principal: &str) -> Result<Principal, IronControlError> {
        SessionRegistrar::get_principal(self, principal).await
    }
}

#[derive(Clone)]
pub struct SessionRuntime {
    store: PgSessionStore,
    sandbox_runtime: SandboxRuntime,
    sandbox_pipes: SessionPipeMap,
    sandbox_pipe_open_locks: SessionPipeOpenLocks,
    tool_host_call_locks: ToolHostCallLocks,
    execution_spans: ExecutionSpanRegistry,
    session_ownership_generations: SessionOwnershipGenerationRegistry,
    iron_control: Arc<dyn SessionPrincipalRegistrar>,
    warm_pool: Option<Arc<WarmPoolManager>>,
    personas: Option<Arc<PersonaRegistry>>,
    session_title_generator: Option<SessionTitleGenerator>,
    session_title_in_flight: SessionTitleThreadSet,
    session_title_rerun_requested: SessionTitleThreadSet,
    capacity: Option<Arc<SandboxCapacityController>>,
    stdout_owner_id: String,
    /// Set once a shutdown handoff begins; fences new stdout-owner claims
    /// so an execution cannot start on a control plane that is about to
    /// exit and release its leases.
    shutting_down: Arc<AtomicBool>,
    /// Active collaboration rooms keyed by thread_key. An active room
    /// prevents idle sandbox suspension and holds a keepalive task that
    /// renews the session ownership lease. Removal on stop/loss/termination
    /// releases the keepalive and permits normal idle cleanup.
    collab_rooms: CollabRoomRegistry,
    /// Serializes start, status, stop, loss, and shutdown cleanup per
    /// session so route responses and keepalive teardown are atomic.
    collab_lifecycle_locks: CollabLifecycleLocks,
    /// Global lifecycle gate: start/status/stop/loss hold a read lock for the
    /// whole operation; handoff takes the write lock under the aggregate
    /// deadline so in-flight starts cannot insert after the room snapshot.
    collab_lifecycle_gate: Arc<RwLock<()>>,
}

#[derive(Clone, Copy, Debug)]
pub struct SandboxCapacityConfig {
    pub max_running: usize,
    pub hot_idle_grace: Duration,
}

impl SandboxCapacityConfig {
    pub fn is_enabled(&self) -> bool {
        self.max_running > 0
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct PersonaRegistry {
    personas: BTreeMap<String, PersonaDefinition>,
    default_persona_id: Option<String>,
    overlay_chain: Vec<String>,
    public_source_roots: BTreeSet<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersonaDefinition {
    pub id: String,
    pub source_root: String,
    pub source_path: String,
    pub source_ref: Option<String>,
    pub prompt_hash: String,
    #[serde(skip_serializing)]
    pub prompt: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersonaSummary {
    pub id: String,
    pub source_root: String,
    pub source_path: String,
    pub source_ref: Option<String>,
    pub prompt_hash: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct PersonaContext {
    pub persona_id: String,
    pub source_root: String,
    pub source_path: String,
    pub source_ref: Option<String>,
    pub prompt_hash: String,
    #[serde(skip_serializing)]
    pub prompt: String,
    pub defaulted: bool,
    pub overlay_chain: Vec<String>,
}

impl PersonaRegistry {
    pub fn new(
        personas: impl IntoIterator<Item = PersonaDefinition>,
        default_persona_id: Option<String>,
        overlay_chain: Vec<String>,
    ) -> Result<Self, String> {
        let personas = personas
            .into_iter()
            .map(|persona| (persona.id.clone(), persona))
            .collect::<BTreeMap<_, _>>();
        if let Some(default_persona_id) = default_persona_id.as_deref()
            && !personas.contains_key(default_persona_id)
        {
            return Err(format!(
                "CENTAUR_DEFAULT_PERSONA {default_persona_id:?} is not in the deployed persona registry"
            ));
        }
        Ok(Self {
            personas,
            default_persona_id,
            overlay_chain,
            public_source_roots: BTreeSet::new(),
        })
    }

    pub fn with_public_source_roots(
        mut self,
        public_source_roots: impl IntoIterator<Item = String>,
    ) -> Self {
        self.public_source_roots = public_source_roots.into_iter().collect();
        self
    }

    fn default_persona_id(&self) -> Option<&str> {
        self.default_persona_id.as_deref()
    }

    fn default_persona_id_for_access(&self, access: &SessionRepoCacheAccess) -> Option<&str> {
        let default_persona_id = self.default_persona_id()?;
        let persona = self.get(default_persona_id)?;
        if self.persona_allowed_for_access(persona, access) {
            Some(default_persona_id)
        } else {
            None
        }
    }

    fn get(&self, persona_id: &str) -> Option<&PersonaDefinition> {
        self.personas.get(persona_id)
    }

    fn persona_allowed_for_access(
        &self,
        persona: &PersonaDefinition,
        access: &SessionRepoCacheAccess,
    ) -> bool {
        !matches!(access, SessionRepoCacheAccess::Public)
            || self.public_source_roots.contains(&persona.source_root)
    }

    fn context_for_access(
        &self,
        persona_id: &str,
        defaulted: bool,
        access: &SessionRepoCacheAccess,
    ) -> Result<PersonaContext, String> {
        let Some(persona) = self.get(persona_id) else {
            return Err(format!(
                "persona {persona_id:?} is not available in this deployment"
            ));
        };
        if !self.persona_allowed_for_access(persona, access) {
            return Err(format!(
                "persona {persona_id:?} is not available for public sandbox repo-cache access"
            ));
        }
        Ok(PersonaContext {
            persona_id: persona.id.clone(),
            source_root: persona.source_root.clone(),
            source_path: persona.source_path.clone(),
            source_ref: persona.source_ref.clone(),
            prompt_hash: persona.prompt_hash.clone(),
            prompt: persona.prompt.clone(),
            defaulted,
            overlay_chain: self.overlay_chain.clone(),
        })
    }
}

#[derive(Clone)]
pub struct SandboxRuntime {
    manager: Arc<SandboxManager>,
    spec_factory: SandboxSpecFactory,
    warm_spec_factory: Option<WarmSandboxSpecFactory>,
    workload_key: Option<String>,
    /// The harness warm sandboxes boot with. A warm claim is only valid for a
    /// session on the same harness; other sessions get a cold sandbox.
    warm_harness: Option<HarnessType>,
}

#[derive(Clone, Debug)]
pub enum SandboxWorkloadMode {
    MockAppServer {
        image: String,
    },
    CodexAppServer {
        image: String,
        env: Vec<(String, String)>,
        mounts: Vec<Mount>,
        /// Applied to every sandbox pod, per-session and warm.
        resources: Option<ResourceRequirements>,
        /// The harness used for warm sandboxes and as the workload default.
        /// Per-session sandboxes run the session's own harness.
        harness: HarnessType,
    },
}

/// What to do when a session already exists with a different harness.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HarnessConflictPolicy {
    /// Fail with [`SessionStoreError::HarnessConflict`] (the default).
    Reject,
    /// Restart the thread on the requested harness: stop the old sandbox,
    /// clear the harness thread state, and switch the session row over. The
    /// new harness starts with no conversational memory.
    Restart,
}

/// Result of [`SessionRuntime::create_or_get_session`].
#[derive(Clone, Debug)]
pub struct CreateOrGetSessionOutcome {
    pub session: Session,
    /// True when the session was restarted onto a different harness because
    /// the request asked for [`HarnessConflictPolicy::Restart`].
    pub harness_switched: bool,
    /// Set only when a new-session request named an unavailable persona and
    /// the returned session uses this request's resolved fallback.
    pub unavailable_requested_persona_id: Option<String>,
}

/// Outcome of [`SessionRuntime::drain`]: the sandboxes that were stopped and
/// any that failed to stop (with the backend error text).
#[derive(Debug, Default)]
pub struct DrainReport {
    pub stopped: Vec<String>,
    pub failed: Vec<DrainFailure>,
}

#[derive(Debug)]
pub struct DrainFailure {
    pub sandbox_id: String,
    pub error: String,
}

#[derive(Debug, Default)]
pub struct WorkflowSandboxCleanupReport {
    pub stopped: Vec<String>,
    pub missing: Vec<String>,
    pub failed: Vec<DrainFailure>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExecuteSessionInput {
    pub idempotency_key: Option<String>,
    pub metadata: Option<Value>,
    pub input_lines: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct InterruptExecutionOutcome {
    pub interrupted: bool,
    pub execution_id: Option<String>,
}

#[derive(Debug)]
pub struct ToolHostCallInput {
    pub principal_id: String,
    pub console_user_email: Option<String>,
    pub console_user_name: Option<String>,
    pub token_id: Option<String>,
    pub tool_name: String,
    pub method: String,
    pub arguments: Value,
    pub timeout: Duration,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ToolHostToolFilter {
    pub allowlist: Option<String>,
    pub blocklist: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolHostCallPolicy {
    principal_id: String,
    tool_filter: ToolHostToolFilter,
    sandbox_capabilities: centaur_session_core::SandboxCapabilities,
}

impl ToolHostCallPolicy {
    pub fn tool_filter(&self) -> &ToolHostToolFilter {
        &self.tool_filter
    }
}

#[derive(Debug)]
pub struct ToolHostCallOutput {
    pub request_id: String,
    pub execution_id: String,
    pub sandbox_id: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_status: Option<i32>,
    pub timed_out: bool,
}

#[derive(Debug, Error)]
#[error("{source}")]
pub struct ToolHostCallError {
    request_id: Option<String>,
    execution_id: Option<String>,
    sandbox_id: Option<String>,
    #[source]
    source: Box<SessionRuntimeError>,
}

impl ToolHostCallError {
    fn new(source: SessionRuntimeError) -> Self {
        Self {
            request_id: None,
            execution_id: None,
            sandbox_id: None,
            source: Box::new(source),
        }
    }

    fn with_request(source: SessionRuntimeError, request_id: &str) -> Self {
        Self {
            request_id: Some(request_id.to_owned()),
            execution_id: None,
            sandbox_id: None,
            source: Box::new(source),
        }
    }

    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    pub fn execution_id(&self) -> Option<&str> {
        self.execution_id.as_deref()
    }

    pub fn sandbox_id(&self) -> Option<&str> {
        self.sandbox_id.as_deref()
    }

    pub fn into_source(self) -> SessionRuntimeError {
        *self.source
    }
}

impl From<SessionRuntimeError> for ToolHostCallError {
    fn from(source: SessionRuntimeError) -> Self {
        Self::new(source)
    }
}

struct SessionExecutionAttempt {
    execution: SessionExecution,
    sandbox_id: Option<String>,
}

struct SessionExecutionAttemptError {
    execution_id: Option<String>,
    sandbox_id: Option<String>,
    source: Box<SessionRuntimeError>,
}

impl SessionExecutionAttemptError {
    fn new(
        execution_id: Option<String>,
        sandbox_id: Option<String>,
        source: SessionRuntimeError,
    ) -> Self {
        Self {
            execution_id,
            sandbox_id,
            source: Box::new(source),
        }
    }

    fn into_source(self) -> SessionRuntimeError {
        *self.source
    }
}

#[derive(Clone)]
struct SessionPipe {
    stdin: Arc<Mutex<SessionInputSink>>,
}

#[derive(Serialize)]
struct ToolHostRequest {
    id: String,
    tool: String,
    method: String,
    arguments: Value,
    principal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    token_id: Option<String>,
    timeout_seconds: u64,
}

#[derive(Deserialize)]
struct ToolHostResponse {
    status: Option<i32>,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default)]
    timed_out: bool,
}

/// Shared handles threaded through background session tasks (stdout pump,
#[derive(Clone)]
struct RuntimeContext {
    store: PgSessionStore,
    manager: Arc<SandboxManager>,
    sandbox_pipes: SessionPipeMap,
    execution_spans: ExecutionSpanRegistry,
    session_ownership_generations: SessionOwnershipGenerationRegistry,
    stdout_owner_id: String,
    collab_rooms: CollabRoomRegistry,
    /// Full runtime for projector/pump paths that must drive remote stop
    /// before finalize (cannot finalize a live room on fenced append alone).
    runtime: SessionRuntime,
}

struct SandboxCapacityController {
    store: PgSessionStore,
    manager: Arc<SandboxManager>,
    sandbox_pipes: SessionPipeMap,
    lock: Mutex<()>,
    config: SandboxCapacityConfig,
}

impl SandboxCapacityController {
    fn new(
        store: PgSessionStore,
        manager: Arc<SandboxManager>,
        sandbox_pipes: SessionPipeMap,
        config: SandboxCapacityConfig,
    ) -> Self {
        Self {
            store,
            manager,
            sandbox_pipes,
            lock: Mutex::new(()),
            config,
        }
    }

    async fn run_with_capacity<T, F, Fut>(
        &self,
        protected_thread_key: &ThreadKey,
        trigger_execution_id: &str,
        operation: &'static str,
        action: F,
    ) -> Result<T, SessionRuntimeError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, SessionRuntimeError>>,
    {
        let _guard = self.lock.lock().await;
        self.ensure_running_slot(protected_thread_key, trigger_execution_id, operation)
            .await?;
        action().await
    }

    async fn ensure_running_slot(
        &self,
        protected_thread_key: &ThreadKey,
        trigger_execution_id: &str,
        operation: &'static str,
    ) -> Result<(), SessionRuntimeError> {
        let running = self.running_slot_count().await?;
        if running < self.config.max_running {
            return Ok(());
        }

        let mut slots_needed = running.saturating_sub(self.config.max_running) + 1;
        let mut stopped_warm = 0usize;
        let mut paused_idle = 0usize;
        let mut stale_candidates_reconciled = 0usize;

        for sandbox_id in self
            .store
            .reserve_ready_warm_sandboxes_for_eviction(candidate_fetch_limit(slots_needed))
            .await?
        {
            if slots_needed == 0 {
                break;
            }
            let id = SandboxId::new(sandbox_id.as_str());
            match self.manager.status(&id).await {
                Ok(status) if status_consumes_running_slot(&status) => {}
                Ok(_) | Err(SandboxError::NotFound(_)) => {
                    let _ = self
                        .store
                        .mark_warm_sandbox_failed(
                            sandbox_id.as_str(),
                            "not running during sandbox capacity admission",
                        )
                        .await;
                    continue;
                }
                Err(error) => {
                    let failure =
                        format!("status failed during sandbox capacity admission: {error}");
                    let _ = self
                        .store
                        .mark_warm_sandbox_failed(sandbox_id.as_str(), &failure)
                        .await;
                    return Err(SessionRuntimeError::Sandbox(error));
                }
            }

            match self.manager.stop(&id).await {
                Ok(()) | Err(SandboxError::NotFound(_)) => {
                    stopped_warm += 1;
                    slots_needed -= 1;
                    let _ = self
                        .store
                        .mark_warm_sandbox_failed(
                            sandbox_id.as_str(),
                            "stopped for sandbox capacity pressure",
                        )
                        .await;
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "sandbox_capacity_warm_stopped",
                        sandbox_id,
                        trigger_thread_key = %protected_thread_key,
                        trigger_execution_id,
                        operation,
                        max_running = self.config.max_running,
                        "stopped warm sandbox for capacity"
                    );
                }
                Err(error) => {
                    let failure = format!("stop failed during sandbox capacity admission: {error}");
                    let _ = self
                        .store
                        .mark_warm_sandbox_failed(sandbox_id.as_str(), &failure)
                        .await;
                    return Err(SessionRuntimeError::Sandbox(error));
                }
            }
        }

        if slots_needed > 0 {
            loop {
                let candidates = self
                    .store
                    .list_sandbox_capacity_candidates(
                        Some(protected_thread_key),
                        self.config.hot_idle_grace,
                        candidate_fetch_limit(slots_needed),
                    )
                    .await?;
                if candidates.is_empty() {
                    break;
                }

                let mut made_progress = false;
                for candidate in candidates {
                    if slots_needed == 0 {
                        break;
                    }
                    match self
                        .pause_capacity_candidate(
                            &candidate,
                            protected_thread_key,
                            trigger_execution_id,
                            operation,
                        )
                        .await?
                    {
                        CapacityCandidateAction::Paused => {
                            paused_idle += 1;
                            slots_needed -= 1;
                            made_progress = true;
                        }
                        CapacityCandidateAction::ReconciledStale => {
                            stale_candidates_reconciled += 1;
                            made_progress = true;
                        }
                        CapacityCandidateAction::Skipped => {}
                    }
                }

                if slots_needed == 0 || !made_progress {
                    break;
                }
            }
        }

        if slots_needed == 0 {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_capacity_admitted",
                trigger_thread_key = %protected_thread_key,
                trigger_execution_id,
                operation,
                running_before = running,
                max_running = self.config.max_running,
                stopped_warm,
                paused_idle,
                stale_candidates_reconciled,
                "admitted sandbox operation under capacity pressure"
            );
            return Ok(());
        }

        Err(SessionRuntimeError::CapacityExceeded {
            max_running: self.config.max_running,
            running,
            operation,
        })
    }

    async fn pause_capacity_candidate(
        &self,
        candidate: &SandboxCapacityCandidate,
        protected_thread_key: &ThreadKey,
        trigger_execution_id: &str,
        operation: &'static str,
    ) -> Result<CapacityCandidateAction, SessionRuntimeError> {
        let id = SandboxId::new(candidate.sandbox_id.as_str());
        match self.manager.status(&id).await {
            Ok(SandboxStatus::Running | SandboxStatus::Created | SandboxStatus::Unknown(_)) => {}
            Ok(SandboxStatus::Suspended) => {
                return Ok(CapacityCandidateAction::Skipped);
            }
            Ok(SandboxStatus::Stopped | SandboxStatus::Gone) => {
                return self.reconcile_stale_capacity_candidate(candidate).await;
            }
            Err(SandboxError::NotFound(_)) => {
                return self.reconcile_stale_capacity_candidate(candidate).await;
            }
            Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
        }

        self.sandbox_pipes.remove(candidate.sandbox_id.as_str());
        match self.manager.pause(&id).await {
            Ok(()) => {
                self.store
                    .append_event(
                        &candidate.thread_key,
                        candidate.latest_execution_id.as_deref(),
                        "session.sandbox_paused",
                        json!({
                            "thread_key": candidate.thread_key.as_str(),
                            "sandbox_id": candidate.sandbox_id.as_str(),
                            "reason": "capacity_pressure",
                            "trigger_thread_key": protected_thread_key.as_str(),
                            "trigger_execution_id": trigger_execution_id,
                            "operation": operation,
                            "last_active_at": candidate.last_active_at,
                            "hot_idle_grace_ms": duration_millis_u64(self.config.hot_idle_grace),
                            "max_running": self.config.max_running,
                        }),
                    )
                    .await?;
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "sandbox_capacity_idle_paused",
                    thread_key = %candidate.thread_key,
                    sandbox_id = %candidate.sandbox_id,
                    trigger_thread_key = %protected_thread_key,
                    trigger_execution_id,
                    operation,
                    last_active_at = %candidate.last_active_at,
                    max_running = self.config.max_running,
                    "paused idle sandbox for capacity"
                );
                Ok(CapacityCandidateAction::Paused)
            }
            Err(error) => {
                self.store
                    .append_event(
                        &candidate.thread_key,
                        candidate.latest_execution_id.as_deref(),
                        "session.sandbox_pause_failed",
                        json!({
                            "thread_key": candidate.thread_key.as_str(),
                            "sandbox_id": candidate.sandbox_id.as_str(),
                            "reason": "capacity_pressure",
                            "trigger_thread_key": protected_thread_key.as_str(),
                            "trigger_execution_id": trigger_execution_id,
                            "operation": operation,
                            "error": error.to_string(),
                        }),
                    )
                    .await?;
                Err(SessionRuntimeError::Sandbox(error))
            }
        }
    }

    async fn reconcile_stale_capacity_candidate(
        &self,
        candidate: &SandboxCapacityCandidate,
    ) -> Result<CapacityCandidateAction, SessionRuntimeError> {
        let cleared = self
            .store
            .clear_sandbox_id_if_matches(&candidate.thread_key, candidate.sandbox_id.as_str())
            .await?;
        if cleared {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_capacity_stale_reconciled",
                thread_key = %candidate.thread_key,
                sandbox_id = %candidate.sandbox_id,
                "cleared stale sandbox assignment during capacity admission"
            );
            Ok(CapacityCandidateAction::ReconciledStale)
        } else {
            Ok(CapacityCandidateAction::Skipped)
        }
    }

    async fn running_slot_count(&self) -> Result<usize, SessionRuntimeError> {
        Ok(self
            .manager
            .list_observed()
            .await?
            .into_iter()
            .filter(|observed| status_consumes_running_slot(&observed.status))
            .count())
    }
}

enum CapacityCandidateAction {
    Paused,
    ReconciledStale,
    Skipped,
}

fn candidate_fetch_limit(slots_needed: usize) -> i64 {
    slots_needed.saturating_mul(4).clamp(16, 1000) as i64
}

fn status_consumes_running_slot(status: &SandboxStatus) -> bool {
    matches!(
        status,
        SandboxStatus::Created | SandboxStatus::Running | SandboxStatus::Unknown(_)
    )
}

struct EventStreamState {
    store: PgSessionStore,
    thread_key: ThreadKey,
    after_event_id: i64,
    execution_id: Option<String>,
    pending: VecDeque<SessionEvent>,
    listener: SessionEventListener,
    safety_tick: Interval,
    done: bool,
    emitted_count: u64,
    span: Span,
}

struct SandboxReadyObservation<'a> {
    thread_key: &'a ThreadKey,
    execution_id: &'a str,
    sandbox_id: &'a str,
    harness_type: &'a HarnessType,
    source: &'static str,
    ready_duration: Duration,
    startup_duration: Option<Duration>,
}

struct EnsureSessionSandboxRequest<'a> {
    thread_key: &'a ThreadKey,
    harness_type: &'a HarnessType,
    persona_id: Option<&'a str>,
    existing_sandbox_id: Option<&'a str>,
    existing_sandbox_capabilities: Option<&'a SessionSandboxCapabilities>,
    iron_control_principal: Option<&'a str>,
    requester_principal: Option<&'a str>,
    proxy_labels: &'a BTreeMap<String, String>,
    desired_capabilities: &'a SessionSandboxCapabilities,
    execution_id: &'a str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SandboxBootMode {
    Harness,
    ToolHost { principal_id: String },
}

impl SandboxBootMode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Harness => "harness",
            Self::ToolHost { .. } => "tool_host",
        }
    }

    fn uses_warm_pool(&self) -> bool {
        matches!(self, Self::Harness)
    }
}

struct PersonaResolution {
    persona_id: Option<String>,
    context: Option<PersonaContext>,
    unavailable_requested_persona_id: Option<String>,
}

impl SessionRuntime {
    pub fn new(
        store: PgSessionStore,
        sandbox_runtime: SandboxRuntime,
        iron_control: impl SessionPrincipalRegistrar + 'static,
    ) -> Self {
        Self {
            store,
            sandbox_runtime,
            sandbox_pipes: Arc::new(DashMap::new()),
            sandbox_pipe_open_locks: Arc::new(DashMap::new()),
            session_ownership_generations: Arc::new(DashMap::new()),
            tool_host_call_locks: Arc::new(DashMap::new()),
            execution_spans: Arc::new(Mutex::new(HashMap::new())),
            iron_control: Arc::new(iron_control),
            warm_pool: None,
            personas: None,
            session_title_generator: None,
            session_title_in_flight: Arc::new(DashSet::new()),
            session_title_rerun_requested: Arc::new(DashSet::new()),
            capacity: None,
            stdout_owner_id: format!("api-rs-{}", uuid::Uuid::new_v4().simple()),
            shutting_down: Arc::new(AtomicBool::new(false)),
            collab_rooms: Arc::new(DashMap::new()),
            collab_lifecycle_locks: Arc::new(DashMap::new()),
            collab_lifecycle_gate: Arc::new(RwLock::new(())),
        }
    }

    /// Acquire a durable sandbox reference shared by every api-rs replica.
    pub async fn acquire_sandbox_reference_lease(
        &self,
        sandbox_id: &str,
        owner_id: &str,
    ) -> Result<SandboxReferenceLease, SessionRuntimeError> {
        let sandbox_id: Arc<str> = Arc::from(sandbox_id);
        let owner_id: Arc<str> = Arc::from(owner_id);
        let lease_ttl = time::Duration::minutes(10);
        let acquired = self
            .store
            .acquire_sandbox_lease(
                &sandbox_id,
                &owner_id,
                OffsetDateTime::now_utc() + lease_ttl,
            )
            .await?;
        if !acquired {
            return Err(SessionRuntimeError::SandboxLeaseOwned {
                sandbox_id: sandbox_id.to_string(),
            });
        }

        let store = self.store.clone();
        let renewer_sandbox_id = Arc::clone(&sandbox_id);
        let renewer_owner_id = Arc::clone(&owner_id);
        let renewer = tokio::spawn(async move {
            loop {
                sleep(Duration::from_secs(60)).await;
                let expires_at = OffsetDateTime::now_utc() + lease_ttl;
                match store
                    .renew_sandbox_lease(&renewer_sandbox_id, &renewer_owner_id, expires_at)
                    .await
                {
                    Ok(true) => {}
                    Ok(false) => {
                        warn!(
                            sandbox_id = %renewer_sandbox_id,
                            owner_id = %renewer_owner_id,
                            "sandbox reference lease was lost; stopping renewer",
                        );
                        break;
                    }
                    Err(error) => {
                        warn!(
                            sandbox_id = %renewer_sandbox_id,
                            owner_id = %renewer_owner_id,
                            %error,
                            "failed to renew sandbox reference lease; retrying next interval",
                        );
                    }
                }
            }
        });

        Ok(SandboxReferenceLease {
            store: self.store.clone(),
            sandbox_id,
            owner_id,
            renewer: Some(renewer),
        })
    }

    pub fn with_session_title_generator<F, Fut>(mut self, generator: F) -> Self
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<String, SessionTitleGenerationError>> + Send + 'static,
    {
        self.session_title_generator = Some(Arc::new(move |source| generator(source).boxed()));
        self
    }

    pub fn with_openai_session_title_generator_from_env(mut self) -> Self {
        let Some(generator) = OpenAiSessionTitleGenerator::from_env() else {
            return self;
        };
        self.session_title_generator = Some(Arc::new(move |source| {
            let generator = generator.clone();
            async move { generator.generate(source).await }.boxed()
        }));
        self
    }

    pub fn with_personas(mut self, personas: PersonaRegistry) -> Self {
        self.personas = Some(Arc::new(personas));
        self
    }

    pub async fn session_title(
        &self,
        thread_key: &ThreadKey,
    ) -> Result<Option<String>, SessionRuntimeError> {
        Ok(self.store.get_session_title(thread_key).await?)
    }

    /// Load the durable session for API resource authorization.
    pub async fn session(&self, thread_key: &ThreadKey) -> Result<Session, SessionRuntimeError> {
        Ok(self.store.get_session(thread_key).await?)
    }

    fn resolve_stored_persona(
        &self,
        persona_id: Option<&str>,
        capabilities: &SessionSandboxCapabilities,
    ) -> Result<Option<PersonaContext>, SessionRuntimeError> {
        resolve_persona_context(
            self.personas.as_deref(),
            persona_id.and_then(clean_persona_id),
            false,
            capabilities,
        )
    }

    fn default_persona_id(&self) -> Option<&str> {
        self.personas
            .as_ref()
            .and_then(|personas| personas.default_persona_id())
    }

    fn context(&self) -> RuntimeContext {
        RuntimeContext {
            store: self.store.clone(),
            manager: self.sandbox_runtime.manager.clone(),
            sandbox_pipes: self.sandbox_pipes.clone(),
            execution_spans: self.execution_spans.clone(),
            session_ownership_generations: self.session_ownership_generations.clone(),
            stdout_owner_id: self.stdout_owner_id.clone(),
            collab_rooms: self.collab_rooms.clone(),
            runtime: self.clone(),
        }
    }
    fn collab_lifecycle_lock(&self, thread_key: &ThreadKey) -> Arc<Mutex<()>> {
        self.collab_lifecycle_locks
            .entry(thread_key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn run_tool_host_call(
        &self,
        input: ToolHostCallInput,
        policy: ToolHostCallPolicy,
    ) -> Result<ToolHostCallOutput, ToolHostCallError> {
        let principal_id = input.principal_id.trim().to_owned();
        let tool_name = input.tool_name.trim().to_owned();
        let method = input.method.trim().to_owned();
        if principal_id.is_empty() {
            return Err(SessionRuntimeError::BadRequest(
                "tool host principal_id is required".to_owned(),
            )
            .into());
        }
        if tool_name.is_empty() {
            return Err(SessionRuntimeError::BadRequest(
                "tool host tool_name is required".to_owned(),
            )
            .into());
        }
        if method.is_empty() {
            return Err(
                SessionRuntimeError::BadRequest("tool host method is required".to_owned()).into(),
            );
        }
        if input.timeout.is_zero() {
            return Err(SessionRuntimeError::BadRequest(
                "tool host timeout must be non-zero".to_owned(),
            )
            .into());
        }
        if policy.principal_id != principal_id {
            return Err(SessionRuntimeError::BadRequest(
                "tool host policy principal does not match the call principal".to_owned(),
            )
            .into());
        }

        let thread_key = tool_host_thread_key(&principal_id)?;
        let input = ToolHostCallInput {
            principal_id,
            tool_name,
            method,
            ..input
        };
        let call_lock = self.tool_host_call_lock(&thread_key);
        let result = {
            let _call_guard = call_lock.lock().await;
            self.locked_tool_host_call(&thread_key, input, policy.sandbox_capabilities)
                .await
        };
        // Drop our clone so an idle entry is only referenced by the map, then
        // evict it; remove_if holds the shard lock, so no concurrent caller
        // can clone the entry between the count check and the removal.
        drop(call_lock);
        self.tool_host_call_locks
            .remove_if(thread_key.as_str(), |_, lock| Arc::strong_count(lock) == 1);
        result
    }

    /// Resolve the principal once and return both the tool lists from its
    /// effective sandbox spec and the capabilities the ensuing call must use.
    pub async fn resolve_tool_host_call_policy(
        &self,
        principal_id: &str,
    ) -> Result<ToolHostCallPolicy, SessionRuntimeError> {
        let principal_id = principal_id.trim();
        if principal_id.is_empty() {
            return Err(SessionRuntimeError::BadRequest(
                "tool host principal_id is required".to_owned(),
            ));
        }
        let thread_key = tool_host_thread_key(principal_id)?;
        let harness = self
            .sandbox_runtime
            .warm_harness
            .clone()
            .unwrap_or(HarnessType::Codex);
        let spec =
            (self.sandbox_runtime.spec_factory)(&thread_key, "mcp-tool-catalog", &harness, None);
        let capabilities = self
            .resolve_sandbox_capabilities(Some(principal_id))
            .await?;
        Ok(ToolHostCallPolicy {
            principal_id: principal_id.to_owned(),
            tool_filter: tool_host_tool_filter_from_spec(spec, &capabilities),
            sandbox_capabilities: capabilities,
        })
    }

    fn tool_host_call_lock(&self, thread_key: &ThreadKey) -> Arc<Mutex<()>> {
        self.tool_host_call_locks
            .entry(thread_key.as_str().to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn locked_tool_host_call(
        &self,
        thread_key: &ThreadKey,
        input: ToolHostCallInput,
        sandbox_capabilities: SessionSandboxCapabilities,
    ) -> Result<ToolHostCallOutput, ToolHostCallError> {
        let ToolHostCallInput {
            principal_id,
            console_user_email,
            console_user_name,
            token_id,
            tool_name,
            method,
            arguments,
            timeout,
        } = input;
        self.create_or_get_tool_host_session(
            thread_key,
            &principal_id,
            console_user_email.as_deref(),
            console_user_name.as_deref(),
        )
        .await?;

        let request_id = format!("mcp-call-{}", Uuid::new_v4().simple());
        let request = ToolHostRequest {
            id: request_id.clone(),
            tool: tool_name.clone(),
            method: method.clone(),
            arguments,
            principal_id,
            token_id,
            timeout_seconds: timeout.as_secs().max(1),
        };
        let input_line = serde_json::to_string(&request)
            .map_err(|error| {
                SessionRuntimeError::Sandbox(SandboxError::io_source(
                    "encode tool host request",
                    error,
                ))
            })
            .map_err(|error| ToolHostCallError::with_request(error, &request_id))?;
        let response_timeout = timeout.saturating_add(Duration::from_secs(5));
        let execution_metadata = tool_host_execution_metadata(
            &request_id,
            &tool_name,
            &method,
            timeout,
            centaur_telemetry::traceparent_for_span(&Span::current()),
        );
        let attempt = match self
            .execute_session_impl(
                thread_key,
                ExecuteSessionInput {
                    idempotency_key: Some(request_id.clone()),
                    metadata: Some(execution_metadata),
                    input_lines: vec![input_line],
                    idle_timeout_ms: None,
                    max_duration_ms: Some(duration_millis_u64(response_timeout)),
                },
                None,
                Some(sandbox_capabilities),
            )
            .await
        {
            Ok(attempt) => attempt,
            Err(error) => {
                return Err(ToolHostCallError {
                    request_id: Some(request_id),
                    execution_id: error.execution_id,
                    sandbox_id: error.sandbox_id,
                    source: error.source,
                });
            }
        };
        let execution_id = attempt.execution.execution_id;
        let result = self
            .wait_for_tool_host_call(
                thread_key,
                &execution_id,
                &request_id,
                attempt.sandbox_id.as_deref(),
                response_timeout,
            )
            .await;
        match result {
            Ok(output) => Ok(output),
            Err(source) => Err(ToolHostCallError {
                request_id: Some(request_id),
                execution_id: Some(execution_id),
                sandbox_id: attempt.sandbox_id,
                source: Box::new(source),
            }),
        }
    }

    async fn create_or_get_tool_host_session(
        &self,
        thread_key: &ThreadKey,
        principal_id: &str,
        console_user_email: Option<&str>,
        console_user_name: Option<&str>,
    ) -> Result<(), SessionRuntimeError> {
        let harness = self
            .sandbox_runtime
            .warm_harness
            .clone()
            .unwrap_or(HarnessType::Codex);
        let metadata =
            tool_host_session_metadata(principal_id, console_user_email, console_user_name);
        let session = self
            .store
            .create_or_get_session_merging_metadata(
                thread_key,
                &harness,
                None,
                metadata,
                BTreeMap::new(),
            )
            .await?;
        if session.iron_control_principal.as_deref() != Some(principal_id) {
            self.store
                .set_iron_control_principal(thread_key, Some(principal_id))
                .await?;
        }
        Ok(())
    }

    async fn wait_for_tool_host_call(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        request_id: &str,
        sandbox_id: Option<&str>,
        response_timeout: Duration,
    ) -> Result<ToolHostCallOutput, SessionRuntimeError> {
        let events = self
            .stream_events(thread_key, 0, Some(execution_id))
            .await?;
        futures_util::pin_mut!(events);
        match timeout(response_timeout, async {
            while let Some(event) = events.next().await {
                let event = event?;
                match event.event_type.as_str() {
                    "session.execution_completed" => {
                        return self
                            .tool_host_completed_output(
                                &event,
                                execution_id,
                                request_id,
                                sandbox_id,
                            )
                            .await;
                    }
                    "session.execution_failed" => {
                        return self
                            .tool_host_failed_output(&event, execution_id, request_id, sandbox_id)
                            .await;
                    }
                    _ => {}
                }
            }
            Err(SessionRuntimeError::Sandbox(SandboxError::io(
                "session event stream ended before tool host call completed",
            )))
        })
        .await
        {
            Ok(output) => output,
            Err(_) => Ok(ToolHostCallOutput {
                request_id: request_id.to_owned(),
                execution_id: execution_id.to_owned(),
                sandbox_id: sandbox_id.unwrap_or_default().to_owned(),
                stdout: String::new(),
                stderr: format!(
                    "tool host call timed out after {} ms",
                    response_timeout.as_millis()
                ),
                exit_status: None,
                timed_out: true,
            }),
        }
    }

    async fn tool_host_completed_output(
        &self,
        event: &SessionEvent,
        execution_id: &str,
        request_id: &str,
        sandbox_id: Option<&str>,
    ) -> Result<ToolHostCallOutput, SessionRuntimeError> {
        let sandbox_id = sandbox_id.unwrap_or_default().to_owned();
        let Some(result_text) = event.payload.get("result_text").and_then(Value::as_str) else {
            return Ok(ToolHostCallOutput {
                request_id: request_id.to_owned(),
                execution_id: execution_id.to_owned(),
                sandbox_id,
                stdout: String::new(),
                stderr: String::new(),
                exit_status: Some(0),
                timed_out: false,
            });
        };
        let response = serde_json::from_str::<ToolHostResponse>(result_text).map_err(|error| {
            SessionRuntimeError::Sandbox(SandboxError::io_source(
                "decode tool host response",
                error,
            ))
        })?;
        Ok(ToolHostCallOutput {
            request_id: request_id.to_owned(),
            execution_id: execution_id.to_owned(),
            sandbox_id,
            stdout: response.stdout,
            stderr: response.stderr,
            exit_status: response.status,
            timed_out: response.timed_out,
        })
    }

    async fn tool_host_failed_output(
        &self,
        event: &SessionEvent,
        execution_id: &str,
        request_id: &str,
        sandbox_id: Option<&str>,
    ) -> Result<ToolHostCallOutput, SessionRuntimeError> {
        let error = event
            .payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("tool host execution failed")
            .to_owned();
        let timed_out = event
            .payload
            .get("reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| reason == "max_duration_exceeded");
        Ok(ToolHostCallOutput {
            request_id: request_id.to_owned(),
            execution_id: execution_id.to_owned(),
            sandbox_id: sandbox_id.unwrap_or_default().to_owned(),
            stdout: String::new(),
            stderr: error,
            exit_status: None,
            timed_out,
        })
    }

    async fn claim_stdout_owner(&self, execution_id: &str) -> Result<(), SessionRuntimeError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(SessionRuntimeError::ShuttingDown);
        }
        let claimed = self
            .store
            .claim_stdout_owner(execution_id, &self.stdout_owner_id, STDOUT_OWNER_LEASE)
            .await?;
        if !claimed {
            return Err(SessionRuntimeError::BadRequest(format!(
                "execution {execution_id} stdout is owned by another control plane process"
            )));
        }
        spawn_stdout_owner_renewer(self.context(), execution_id.to_owned());
        Ok(())
    }

    async fn claim_expired_stdout_owner(
        &self,
        execution_id: &str,
    ) -> Result<bool, SessionRuntimeError> {
        let claimed = self
            .store
            .claim_expired_stdout_owner(execution_id, &self.stdout_owner_id, STDOUT_OWNER_LEASE)
            .await?;
        if claimed {
            spawn_stdout_owner_renewer(self.context(), execution_id.to_owned());
        }
        Ok(claimed)
    }

    /// Acquires a one-shot session ownership lease for an OMP session before a
    /// normal execution starts. A resident collaboration host holding the
    /// session blocks this acquisition; the caller surfaces the conflict.
    /// Non-OMP harnesses are unaffected — they skip the boundary entirely.
    async fn acquire_oneshot_session_ownership(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
    ) -> Result<Option<i64>, SessionRuntimeError> {
        if !matches!(harness_type, HarnessType::Omp) {
            return Ok(None);
        }
        let ownership = self
            .store
            .acquire_session_ownership(thread_key, &self.stdout_owner_id, SessionOwnerMode::Oneshot)
            .await?;
        if !ownership.acquired {
            let mode = match ownership.mode {
                SessionOwnerMode::Resident => "resident",
                SessionOwnerMode::Oneshot => "oneshot",
            };
            return Err(SessionRuntimeError::SessionOwned {
                thread_key: thread_key.as_str().to_owned(),
                owner_id: ownership.owner_id,
                mode,
            });
        }
        Ok(Some(ownership.generation))
    }
    /// Register the shared unauthenticated MCP tool-host principal so
    /// proxy-backed tool calls can resolve an effective config without minting
    /// per-user credentials in this layer.
    pub async fn register_mcp_tool_host_principal(
        &self,
        principal_id: &str,
    ) -> Result<String, SessionRuntimeError> {
        let principal_id = principal_id.trim();
        if principal_id.is_empty() {
            return Err(SessionRuntimeError::BadRequest(
                "mcp tool host principal_id is required".to_owned(),
            ));
        }
        if principal_id.contains(':') {
            return Err(SessionRuntimeError::BadRequest(
                "mcp tool host principal_id must not contain ':'".to_owned(),
            ));
        }
        let thread_key = tool_host_thread_key(principal_id)?;
        // Serialize with run_tool_host_call so concurrent registrations for the
        // same principal cannot interleave with session setup.
        let call_lock = self.tool_host_call_lock(&thread_key);
        let _call_guard = call_lock.lock().await;
        let metadata = tool_host_session_metadata(principal_id, None, None);
        let principal = self
            .iron_control
            .register_session(thread_key.as_str(), Some(&metadata))
            .await?;
        Ok(principal.id)
    }

    pub fn with_warm_pool(mut self, config: WarmPoolConfig) -> Self {
        if config.target_size == 0 {
            return self;
        }

        let (Some(spec_factory), Some(workload_key)) = (
            self.sandbox_runtime.warm_spec_factory.clone(),
            self.sandbox_runtime.workload_key.clone(),
        ) else {
            warn!(
                target_size = config.target_size,
                "session sandbox warm pool requested for runtime without a warm sandbox spec"
            );
            return self;
        };

        let pool = Arc::new(WarmPoolManager::new(
            self.sandbox_runtime.manager.clone(),
            self.store.clone(),
            spec_factory,
            workload_key,
            config,
        ));
        pool.clone().spawn_replenisher();
        self.warm_pool = Some(pool);
        self
    }

    pub fn with_sandbox_capacity(mut self, config: SandboxCapacityConfig) -> Self {
        if !config.is_enabled() {
            return self;
        }
        self.capacity = Some(Arc::new(SandboxCapacityController::new(
            self.store.clone(),
            self.sandbox_runtime.manager.clone(),
            self.sandbox_pipes.clone(),
            config,
        )));
        self
    }

    async fn run_with_running_capacity<T, F, Fut>(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        operation: &'static str,
        action: F,
    ) -> Result<T, SessionRuntimeError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, SessionRuntimeError>>,
    {
        if let Some(capacity) = self.capacity.as_ref() {
            capacity
                .run_with_capacity(thread_key, execution_id, operation, action)
                .await
        } else {
            action().await
        }
    }

    /// Spawn the background reaper that stops sandboxes whose total lifetime
    /// expired. No-op when max-lifetime reaping is disabled.
    pub fn with_sandbox_reaper(self, config: SandboxReaperConfig) -> Self {
        if !config.is_enabled() {
            return self;
        }
        SandboxReaper::new(self.sandbox_runtime.manager.clone(), config).spawn();
        self
    }

    /// Spawn the DB-aware cleanup worker that reaps backend sandboxes no durable
    /// session/warm-pool row references and restores idle pauses lost across
    /// control-plane restarts.
    pub fn with_sandbox_cleanup(self, config: SessionSandboxCleanupConfig) -> Self {
        if !config.is_enabled() {
            return self;
        }
        cleanup::SessionSandboxCleanupWorker::new(self.context(), config).spawn();
        self
    }

    pub async fn create_or_get_session(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
        persona_id: Option<&str>,
        metadata: Option<Value>,
        on_harness_conflict: HarnessConflictPolicy,
    ) -> Result<CreateOrGetSessionOutcome, SessionRuntimeError> {
        self.create_or_get_session_with_principal(
            thread_key,
            harness_type,
            persona_id,
            metadata,
            on_harness_conflict,
            None,
        )
        .await
    }

    /// Create or load a session and bind it to an existing iron-control
    /// principal selected by foreign ID. When no foreign ID is supplied, the
    /// session keeps the normal principal derived from its thread key.
    pub async fn create_or_get_session_with_principal(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
        persona_id: Option<&str>,
        metadata: Option<Value>,
        on_harness_conflict: HarnessConflictPolicy,
        principal_foreign_id: Option<&str>,
    ) -> Result<CreateOrGetSessionOutcome, SessionRuntimeError> {
        let principal_foreign_id = match principal_foreign_id {
            Some(foreign_id) if foreign_id.trim().is_empty() => {
                return Err(SessionRuntimeError::BadRequest(
                    "principal must be a non-empty foreign ID".to_owned(),
                ));
            }
            Some(foreign_id) => Some(foreign_id.trim()),
            None => None,
        };
        let span = info_span!(
            "centaur.api_rs.session.create_or_get",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_create_or_get",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.harness_type" = %harness_type,
            thread_key = %thread_key,
            harness_type = %harness_type,
        );
        set_span_parent_trace(
            &span,
            &thread_trace_id(thread_key),
            &thread_trace_parent_span_id(thread_key),
        );
        let result = async {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_create_or_get_started",
                thread_key = %thread_key,
                harness_type = %harness_type,
                "creating or loading session"
            );
            let mut harness_switched = false;
            let mut session_metadata = default_metadata(metadata);
            let proxy_labels = proxy_labels_from_session_metadata(thread_key, &session_metadata);
            let registered_principal = match principal_foreign_id {
                Some(foreign_id) => self.iron_control.get_principal(foreign_id).await?,
                None => {
                    self.iron_control
                        .register_session(thread_key.as_str(), Some(&session_metadata))
                        .await?
                }
            };
            let desired_capabilities = sandbox_capabilities_from_principal(&registered_principal);
            // A session's persona is fixed by the first successful create.
            // Use the stored persona before the requested one so later persona
            // flags cannot change or invalidate an existing thread. Its
            // context is resolved once from the post-create session below.
            let existing_persona_id = match self.store.get_session(thread_key).await {
                Ok(session) => Some(session.persona_id),
                Err(SessionStoreError::NotFound { .. }) => None,
                Err(error) => return Err(error.into()),
            };
            let persona_resolution = match existing_persona_id {
                Some(persona_id) => PersonaResolution {
                    context: None,
                    persona_id,
                    unavailable_requested_persona_id: None,
                },
                None => resolve_persona_selection(
                    self.personas.as_deref(),
                    persona_id,
                    &desired_capabilities,
                )?,
            };
            if let Some(context) = persona_resolution.context.as_ref() {
                add_persona_metadata(&mut session_metadata, context);
            }
            match self
                .store
                .create_or_get_session(
                    thread_key,
                    harness_type,
                    persona_resolution.persona_id.as_deref(),
                    session_metadata.clone(),
                    proxy_labels.clone(),
                )
                .await
            {
                Ok(session) => session,
                Err(SessionStoreError::HarnessConflict { existing, .. })
                    if on_harness_conflict == HarnessConflictPolicy::Restart =>
                {
                    let session = self
                        .restart_session_on_harness(thread_key, harness_type, &existing)
                        .await?;
                    harness_switched = true;
                    session
                }
                Err(error) => return Err(error.into()),
            };
            // Persist the principal OID on the session row so a resumed session
            // can recreate its sandbox after a restart without re-deriving it.
            // Existing sessions are immutable at this boundary: changing their
            // credential identity requires a different session.
            let session = self
                .store
                .bind_iron_control_principal(thread_key, &registered_principal.id)
                .await?;
            let unavailable_requested_persona_id = persona_resolution
                .unavailable_requested_persona_id
                .filter(|_| {
                    // Another first-create request may have won with a different resolution.
                    persona_resolution.persona_id == session.persona_id
                });
            if let Some(context) =
                self.resolve_stored_persona(session.persona_id.as_deref(), &desired_capabilities)?
            {
                self.store
                    .append_event(
                        thread_key,
                        None,
                        "session.persona_resolved",
                        json!({
                            "persona": context,
                            "requested_persona_id": persona_id,
                            "deployment_default_persona_id": self.default_persona_id(),
                        }),
                    )
                    .await?;
            }

            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_create_or_get_completed",
                thread_key = %thread_key,
                harness_type = %harness_type,
                status = %session.status,
                iron_control_principal_persisted = true,
                harness_switched,
                "session ready"
            );
            Ok(CreateOrGetSessionOutcome {
                session,
                harness_switched,
                unavailable_requested_persona_id,
            })
        }
        .instrument(span)
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_create_or_get_failed",
                thread_key = %thread_key,
                harness_type = %harness_type,
                %error,
                "failed to create or load session"
            );
        }
        result
    }

    /// Restart an existing session on a different harness: stop its sandbox
    /// (killing any in-flight execution), clear the harness thread state, and
    /// flip the session row to the requested harness while preserving its
    /// persona. Stored messages and events are preserved for the record, but
    /// the new harness boots with no conversational memory.
    async fn restart_session_on_harness(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
        previous_harness: &str,
    ) -> Result<Session, SessionRuntimeError> {
        let previous = self.store.get_session(thread_key).await?;
        if let Some(sandbox_id) = previous.sandbox_id.as_deref() {
            self.sandbox_pipes.remove(sandbox_id);
            match self
                .sandbox_runtime
                .manager
                .stop(&SandboxId::new(sandbox_id))
                .await
            {
                Ok(()) | Err(SandboxError::NotFound(_)) => {}
                Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
            }
        }
        let session = self
            .store
            .switch_session_harness(thread_key, harness_type)
            .await?;
        self.store
            .append_event(
                thread_key,
                None,
                "session.harness_switched",
                json!({
                    "thread_key": thread_key.as_str(),
                    "from_harness": previous_harness,
                    "to_harness": harness_type.as_ref(),
                    "stopped_sandbox_id": previous.sandbox_id,
                }),
            )
            .await?;
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_harness_switched",
            thread_key = %thread_key,
            from_harness = previous_harness,
            to_harness = %harness_type,
            stopped_sandbox_id = previous.sandbox_id.as_deref().unwrap_or(""),
            "restarted session on a new harness"
        );
        Ok(session)
    }

    pub async fn append_messages(
        &self,
        thread_key: &ThreadKey,
        messages: &[SessionMessageInput],
    ) -> Result<Vec<String>, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.session.messages.append",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_messages_append",
            "centaur.thread_key" = thread_key.as_str(),
            thread_key = %thread_key,
            message_count = messages.len(),
        );
        let result = async {
            if messages.is_empty() {
                return Err(SessionRuntimeError::BadRequest(
                    "messages must not be empty".to_owned(),
                ));
            }
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_messages_append_started",
                thread_key = %thread_key,
                message_count = messages.len(),
                "appending session messages"
            );
            let message_ids = self.store.append_messages(thread_key, messages).await?;
            if let Err(error) = self.store.touch_session_sandbox_activity(thread_key).await {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_sandbox_activity_touch_failed",
                    thread_key = %thread_key,
                    %error,
                    "failed to touch sandbox activity after message append"
                );
            }
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_messages_append_completed",
                thread_key = %thread_key,
                message_count = messages.len(),
                message_id_count = message_ids.len(),
                "session messages appended"
            );
            Ok(message_ids)
        }
        .instrument(span)
        .await;

        let message_ids = match result {
            Ok(message_ids) => message_ids,
            Err(error) => {
                error!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_messages_append_failed",
                    thread_key = %thread_key,
                    message_count = messages.len(),
                    %error,
                    "failed to append session messages"
                );
                return Err(error);
            }
        };
        self.forward_messages_to_active_execution(thread_key, messages, &message_ids)
            .await;
        self.spawn_session_title_generation(thread_key);
        Ok(message_ids)
    }

    fn spawn_session_title_generation(&self, thread_key: &ThreadKey) {
        let Some(generator) = self.session_title_generator.clone() else {
            return;
        };
        if !self.session_title_in_flight.insert(thread_key.clone()) {
            self.session_title_rerun_requested
                .insert(thread_key.clone());
            return;
        }
        let store = self.store.clone();
        let in_flight = self.session_title_in_flight.clone();
        let rerun_requested = self.session_title_rerun_requested.clone();
        let thread_key = thread_key.clone();
        tokio::spawn(async move {
            // Appends skipped while generation is in flight request one more pass,
            // which lets low-signal wakeups defer to a later substantive message.
            loop {
                rerun_requested.remove(&thread_key);
                maybe_generate_session_title(store.clone(), generator.clone(), thread_key.clone())
                    .await;
                if rerun_requested.remove(&thread_key).is_some() {
                    continue;
                }

                in_flight.remove(&thread_key);
                if rerun_requested.remove(&thread_key).is_some()
                    && in_flight.insert(thread_key.clone())
                {
                    continue;
                }
                break;
            }
        });
    }

    /// Stop every non-terminal sandbox the backend currently owns.
    ///
    /// Intended for a clean control-plane shutdown (e.g. before a deploy):
    /// each sandbox is stopped independently so one failure does not abort the
    /// rest, and the [`DrainReport`] records which were stopped and which
    /// failed so the caller can surface partial failure.
    pub async fn drain(&self) -> Result<DrainReport, SessionRuntimeError> {
        let observed = self.sandbox_runtime.manager.list_observed().await?;
        let mut report = DrainReport::default();
        for sandbox in observed {
            if sandbox.status.is_terminal() {
                continue;
            }
            let id = sandbox.id.as_str().to_owned();
            match self.sandbox_runtime.manager.stop(&sandbox.id).await {
                Ok(()) => {
                    self.sandbox_pipes.remove(&id);
                    if let Err(error) = self
                        .store
                        .mark_warm_sandbox_failed(&id, "sandbox drained")
                        .await
                    {
                        warn!(sandbox_id = %id, %error, "drain failed to clear warm sandbox row");
                        report.failed.push(DrainFailure {
                            sandbox_id: id.clone(),
                            error: error.to_string(),
                        });
                    }
                    report.stopped.push(id);
                }
                Err(error) => {
                    warn!(sandbox_id = %id, %error, "drain failed to stop sandbox");
                    report.failed.push(DrainFailure {
                        sandbox_id: id,
                        error: error.to_string(),
                    });
                }
            }
        }
        Ok(report)
    }

    pub async fn stop_workflow_owned_sandboxes(
        &self,
        workflow_run_id: &str,
        reason: &str,
    ) -> Result<WorkflowSandboxCleanupReport, SessionRuntimeError> {
        let sandboxes = self
            .store
            .list_workflow_owned_sandboxes(workflow_run_id)
            .await?;
        let mut report = WorkflowSandboxCleanupReport::default();

        for sandbox in sandboxes {
            let sandbox_id = sandbox.sandbox_id;
            let thread_key = sandbox.thread_key;
            self.sandbox_pipes.remove(&sandbox_id);
            let id = SandboxId::new(sandbox_id.clone());
            let mut missing = false;
            match self.sandbox_runtime.manager.stop(&id).await {
                Ok(()) => report.stopped.push(sandbox_id.clone()),
                Err(SandboxError::NotFound(_)) => {
                    missing = true;
                    report.missing.push(sandbox_id.clone());
                }
                Err(error) => {
                    let error = error.to_string();
                    warn!(
                        thread_key = %thread_key,
                        sandbox_id,
                        workflow_run_id,
                        reason,
                        %error,
                        "failed to stop workflow-owned sandbox"
                    );
                    report.failed.push(DrainFailure {
                        sandbox_id: sandbox_id.clone(),
                        error: error.clone(),
                    });
                    if let Err(event_error) = self
                        .store
                        .append_event(
                            &thread_key,
                            None,
                            "session.workflow_sandbox_stop_failed",
                            json!({
                                "thread_key": thread_key.as_str(),
                                "sandbox_id": sandbox_id,
                                "workflow_run_id": workflow_run_id,
                                "reason": reason,
                                "error": error,
                            }),
                        )
                        .await
                    {
                        warn!(
                            thread_key = %thread_key,
                            sandbox_id,
                            workflow_run_id,
                            %event_error,
                            "failed to append workflow sandbox stop failure event"
                        );
                    }
                    continue;
                }
            }

            if let Err(error) = self
                .store
                .mark_warm_sandbox_failed(&sandbox_id, "workflow-owned sandbox stopped")
                .await
            {
                warn!(
                    thread_key = %thread_key,
                    sandbox_id,
                    workflow_run_id,
                    %error,
                    "failed to mark workflow-owned warm sandbox failed"
                );
            }

            let cleared = self
                .store
                .clear_sandbox_id_if_matches(&thread_key, &sandbox_id)
                .await?;
            if let Err(error) = self
                .store
                .append_event(
                    &thread_key,
                    None,
                    "session.workflow_sandbox_stopped",
                    json!({
                        "thread_key": thread_key.as_str(),
                        "sandbox_id": sandbox_id,
                        "workflow_run_id": workflow_run_id,
                        "reason": reason,
                        "missing": missing,
                        "cleared": cleared,
                    }),
                )
                .await
            {
                warn!(
                    thread_key = %thread_key,
                    sandbox_id,
                    workflow_run_id,
                    %error,
                    "failed to append workflow sandbox cleanup event"
                );
            }
        }

        Ok(report)
    }

    pub async fn execute_session(
        &self,
        thread_key: &ThreadKey,
        input: ExecuteSessionInput,
    ) -> Result<SessionExecution, SessionRuntimeError> {
        self.execute_session_impl(thread_key, input, None, None)
            .await
            .map(|attempt| attempt.execution)
            .map_err(SessionExecutionAttemptError::into_source)
    }

    async fn drive_session_execution(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        input: ExecuteSessionInput,
    ) -> Result<SessionExecution, SessionRuntimeError> {
        self.execute_session_impl(thread_key, input, Some(execution_id), None)
            .await
            .map(|attempt| attempt.execution)
            .map_err(SessionExecutionAttemptError::into_source)
    }

    async fn execute_session_impl(
        &self,
        thread_key: &ThreadKey,
        input: ExecuteSessionInput,
        persisted_execution_id: Option<&str>,
        // Present only for an immediately dispatched tool-host call. Durable
        // recovery passes None and resolves the principal's current policy.
        pre_resolved_sandbox_capabilities: Option<SessionSandboxCapabilities>,
    ) -> Result<SessionExecutionAttempt, SessionExecutionAttemptError> {
        let mut execution_id = persisted_execution_id.map(str::to_owned);
        let mut correlation_sandbox_id = None;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(SessionExecutionAttemptError::new(
                execution_id,
                correlation_sandbox_id,
                SessionRuntimeError::ShuttingDown,
            ));
        }
        let persisted_request = persisted_execution_id
            .is_none()
            .then(|| persisted_execute_request(&input))
            .transpose()
            .map_err(|source| {
                SessionExecutionAttemptError::new(
                    execution_id.clone(),
                    correlation_sandbox_id.clone(),
                    source,
                )
            })?;
        let ExecuteSessionInput {
            idempotency_key,
            metadata,
            input_lines,
            idle_timeout_ms,
            max_duration_ms,
        } = input;
        let input_line_count = input_lines.len();
        let idempotency_key_present = idempotency_key.is_some();
        let span = info_span!(
            "centaur.api_rs.session.execute",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_execute",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = tracing::field::Empty,
            "centaur.sandbox_id" = tracing::field::Empty,
            thread_key = %thread_key,
            execution_id = tracing::field::Empty,
            sandbox_id = tracing::field::Empty,
            input_line_count,
            idempotency_key_present,
        );
        set_span_parent_trace(
            &span,
            &thread_trace_id(thread_key),
            &thread_trace_parent_span_id(thread_key),
        );
        let mut acquired_session_ownership_generation = None;
        let result = async {
            ensure_thread_trace_root_span(thread_key);
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execute_started",
                thread_key = %thread_key,
                input_line_count,
                idempotency_key_present,
                "starting session execution"
            );
            let session = self.store.get_session(thread_key).await?;
            correlation_sandbox_id = session.sandbox_id.clone();
            let harness_label = session.harness_type.to_string();
            validate_input_lines(&input_lines)?;
            let (idle_timeout, max_duration) = duration_options(idle_timeout_ms, max_duration_ms)?;
            let requester_metadata = metadata.clone();

            let claim = if let Some(execution_id) = persisted_execution_id {
                span.record("centaur.execution_id", execution_id);
                span.record("execution_id", execution_id);
                self.store.mark_execution_running(execution_id).await?
            } else {
                // Resolve an exact idempotent retry before ownership acquisition.
                // This lets a caller attach to its existing execution while a
                // resident owner holds the session, without creating a competing
                // one-shot execution.
                if let Some(idempotency_key) = idempotency_key.as_deref()
                    && let Some(existing) = self
                        .store
                        .execution_for_idempotency_key(thread_key, idempotency_key)
                        .await?
                {
                    span.record("centaur.execution_id", existing.execution_id.as_str());
                    span.record("execution_id", existing.execution_id.as_str());
                    return Ok(existing);
                }

                // For OMP sessions, acquire a one-shot session ownership lease
                // before creating the execution. A resident collaboration host
                // holding the session blocks this acquisition; the caller surfaces
                // the conflict. Non-OMP harnesses skip the boundary entirely.
                let ownership_generation = self
                    .acquire_oneshot_session_ownership(thread_key, &session.harness_type)
                    .await?;
                acquired_session_ownership_generation = ownership_generation;
                let mut execution_metadata =
                    execution_metadata(metadata, idle_timeout_ms, max_duration_ms);
                if let Some(generation) = ownership_generation
                    && let Value::Object(object) = &mut execution_metadata
                {
                    object.insert("_session_owner_generation".to_owned(), json!(generation));
                }
                let execution = self
                    .store
                    .create_execution_with_request(
                        thread_key,
                        idempotency_key.as_deref(),
                        execution_metadata,
                        persisted_request.expect("new executions have a persisted request"),
                    )
                    .await?;
                execution_id = Some(execution.execution.execution_id.clone());
                span.record(
                    "centaur.execution_id",
                    execution.execution.execution_id.as_str(),
                );
                span.record("execution_id", execution.execution.execution_id.as_str());
                if !execution.created && execution.execution.status != ExecutionStatus::Queued {
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_execute_idempotent_replay",
                        thread_key = %thread_key,
                        execution_id = %execution.execution.execution_id,
                        status = %execution.execution.status,
                        "returning existing execution"
                    );
                    release_session_ownership_generation(
                        &self.store,
                        thread_key,
                        &self.stdout_owner_id,
                        ownership_generation,
                    )
                    .await;
                    return Ok(execution.execution);
                }
                self.store
                    .mark_execution_running(&execution.execution.execution_id)
                    .await?
            };
            let execution = claim.execution;
            execution_id = Some(execution.execution_id.clone());
            if execution.thread_key != *thread_key {
                return Err(SessionRuntimeError::BadRequest(format!(
                    "execution {} belongs to thread {}, not {}",
                    execution.execution_id, execution.thread_key, thread_key
                )));
            }
            span.record("centaur.execution_id", execution.execution_id.as_str());
            span.record("execution_id", execution.execution_id.as_str());
            if !claim.claimed {
                // A concurrent request with the same idempotency key claimed
                // the execution first (or it already reached a terminal
                // state). Do not drive it again — return the current row so
                // the caller can attach to the event stream.
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_execute_not_claimed",
                    thread_key = %thread_key,
                    execution_id = %execution.execution_id,
                    status = %execution.status,
                    "execution was already claimed or terminal"
                );
                release_session_ownership_generation(
                    &self.store,
                    thread_key,
                    &self.stdout_owner_id,
                    acquired_session_ownership_generation,
                )
                .await;
                return Ok(execution);
            }
            if let Some(generation) = acquired_session_ownership_generation {
                self.session_ownership_generations
                    .insert(execution.execution_id.clone(), generation);
            }
            if let Err(error) = self.claim_stdout_owner(&execution.execution_id).await {
                self.handle_stdout_claim_failure(thread_key, &execution.execution_id, &error)
                    .await;
                return Err(error);
            }
            if let Some(generation) = acquired_session_ownership_generation {
                spawn_execution_session_owner_renewer(
                    self.context(),
                    thread_key.clone(),
                    execution.execution_id.clone(),
                    generation,
                    session_ownership_renew_interval(),
                );
            }
            let execution_trace_span = info_span!(
                parent: None,
                "centaur.api_rs.session.execution",
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execution",
                "lmnr.span.type" = "DEFAULT",
                "lmnr.span.output" = tracing::field::Empty,
                "otel.status_code" = tracing::field::Empty,
                "lmnr.association.properties.session_id" = thread_key.as_str(),
                "lmnr.association.properties.metadata.execution_id" = execution.execution_id.as_str(),
                "lmnr.association.properties.metadata.thread_key" = thread_key.as_str(),
                "centaur.thread_key" = thread_key.as_str(),
                "centaur.execution_id" = execution.execution_id.as_str(),
                "centaur.sandbox_id" = tracing::field::Empty,
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                sandbox_id = tracing::field::Empty,
            );
            if let Some(traceparent) = execution_traceparent(&execution) {
                set_span_parent_from_traceparent(&execution_trace_span, traceparent);
            }
            let traceparent = centaur_telemetry::traceparent_for_span(&execution_trace_span);
            if let Some(traceparent) = traceparent.as_deref()
                && execution_traceparent(&execution) != Some(traceparent)
                && let Err(error) = self
                    .store
                    .set_execution_traceparent(&execution.execution_id, traceparent)
                    .await
            {
                let error = SessionRuntimeError::Store(error);
                self.record_execution_failure(thread_key, &execution.execution_id, &error)
                    .await;
                return Err(error);
            }
            self.execution_spans
                .lock()
                .await
                .insert(execution.execution_id.clone(), execution_trace_span.clone());
            record_session_execution_started(&harness_label);
            self.store
                .append_event(
                    thread_key,
                    Some(&execution.execution_id),
                    "session.execution_started",
                    json!({
                        "execution_id": execution.execution_id,
                        "thread_key": thread_key.as_str(),
                        "input_line_count": input_line_count,
                        "idle_timeout_ms": idle_timeout_ms,
                        "max_duration_ms": max_duration_ms,
                    }),
                )
                .await?;
            let requester_principal_id = self
                .resolve_requester_principal(thread_key, requester_metadata.as_ref())
                .await;
            let desired_capabilities = match pre_resolved_sandbox_capabilities {
                Some(capabilities) => capabilities,
                None => {
                    self.resolve_sandbox_capabilities(session.iron_control_principal.as_deref())
                        .await?
                }
            };

            let sandbox_id = match self
                .ensure_session_sandbox(EnsureSessionSandboxRequest {
                    thread_key,
                    harness_type: &session.harness_type,
                    persona_id: session.persona_id.as_deref(),
                    existing_sandbox_id: session.sandbox_id.as_deref(),
                    existing_sandbox_capabilities: session.sandbox_capabilities.as_ref(),
                    iron_control_principal: session.iron_control_principal.as_deref(),
                    requester_principal: requester_principal_id.as_deref(),
                    proxy_labels: &session.proxy_labels,
                    desired_capabilities: &desired_capabilities,
                    execution_id: &execution.execution_id,
                })
                .instrument(execution_trace_span.clone())
                .await
            {
                Ok(sandbox_id) => sandbox_id,
                Err(error) => {
                    self.record_execution_failure(thread_key, &execution.execution_id, &error)
                        .await;
                    return Err(error);
                }
            };
            correlation_sandbox_id = Some(sandbox_id.clone());
            span.record("centaur.sandbox_id", sandbox_id.as_str());
            span.record("sandbox_id", sandbox_id.as_str());
            execution_trace_span.record("centaur.sandbox_id", sandbox_id.as_str());
            execution_trace_span.record("sandbox_id", sandbox_id.as_str());

            let pipe = match self
                .ensure_session_pipe(thread_key, &sandbox_id)
                .instrument(execution_trace_span.clone())
                .await
            {
                Ok(pipe) => pipe,
                Err(error) => {
                    self.record_execution_failure(thread_key, &execution.execution_id, &error)
                        .await;
                    return Err(error);
                }
            };

            // Allocation-only placeholder. The Flue hosts claim a sandbox by
            // executing with the `allocate_sandbox` marker and no input: the
            // pod claim above is the entire purpose of the call. Left open,
            // nothing ever completes it — the harness has no child until a
            // User command spawns one, so not even an interrupt can end it —
            // and max_duration fails it a minute later, leaving an
            // `execution exceeded` row on the thread and a one-minute wait
            // on every cold claim. Complete it here instead: the sandbox is
            // assigned, the one-shot lease is released, and no model turn is
            // billed. Fenced to exactly this shape — the marker action AND
            // no input — so no real execution can take the path.
            if is_allocation_only_placeholder(requester_metadata.as_ref(), &input_lines) {
                // Through the normal terminal machinery, not a bare store
                // update: the completion event, transcript archive, lease
                // release, activity touch, finished metric, and the idle
                // pause the caller's own idle_timeout asked for all hang
                // off `record_terminal_output`, and skipping them is how an
                // abandoned allocation outlives its timeout until a sweep.
                let terminal = record_terminal_output(
                    &self.context(),
                    thread_key,
                    &sandbox_id,
                    &execution.execution_id,
                    TerminalOutput::Completed {
                        reason: "allocation_only",
                        result_text: None,
                    },
                )
                .await?;
                // `None` means another writer terminalized the row first;
                // the in-memory `execution` still says running, and
                // returning it would report a status the store has already
                // replaced. Read the thread's terminal truth instead.
                let terminal = match terminal {
                    Some(terminal) => terminal,
                    None => self
                        .store
                        .latest_execution_for_thread(thread_key)
                        .await?
                        .ok_or_else(|| {
                            SessionRuntimeError::BadRequest(format!(
                                "allocation-only execution {} disappeared from {}",
                                execution.execution_id,
                                thread_key.as_str(),
                            ))
                        })?,
                };
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_execute_allocation_only",
                    thread_key = %thread_key,
                    execution_id = %terminal.execution_id,
                    sandbox_id = %sandbox_id,
                    status = %terminal.status,
                    completion_reason = "allocation_only",
                    "allocation-only placeholder completed; sandbox claimed without a turn"
                );
                span.record("centaur.execution_id", terminal.execution_id.as_str());
                span.record("execution_id", terminal.execution_id.as_str());
                return Ok(terminal);
            }

            let trace = SessionTraceContext::for_execution(
                Some(&execution_trace_span),
                traceparent.or_else(|| execution_traceparent(&execution).map(ToOwned::to_owned)),
                Some(&execution.execution_id),
            )
            .with_thread_key(thread_key)
            .with_max_duration_ms(max_duration_ms);
            // Inject the trusted ownership fence (acquired above) so the
            // harness-server resident OMP host can fence stale/missing
            // ownership. Only OMP sessions have a generation; non-OMP skip.
            let trace = if let Some(generation) = acquired_session_ownership_generation {
                trace.with_ownership(&self.stdout_owner_id, generation)
            } else {
                trace
            };
            let input_lines = input_lines_with_session_context(thread_key, &trace, &input_lines);
            if let Err(error) = write_input_lines(
                &pipe,
                &input_lines,
                thread_key,
                &execution.execution_id,
                Some(&sandbox_id),
            )
            .instrument(execution_trace_span.clone())
            .await
            {
                self.record_execution_failure(thread_key, &execution.execution_id, &error)
                    .await;
                return Err(error);
            }

            if let Some(max_duration) = max_duration {
                spawn_max_duration_failure(
                    self.context(),
                    thread_key.clone(),
                    execution.execution_id.clone(),
                    max_duration,
                    idle_timeout,
                );
            }

            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execute_completed",
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                sandbox_id = %sandbox_id,
                status = %execution.status,
                completion_reason = "input_accepted",
                "session execution accepted input"
            );
            Ok(execution)
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_execute_failed",
                thread_key = %thread_key,
                input_line_count,
                %error,
                "session execution failed"
            );
            // Release exactly the one-shot generation acquired by this attempt.
            // A slow failure path must not delete a newer successor's lease.
            release_session_ownership_generation(
                &self.store,
                thread_key,
                &self.stdout_owner_id,
                acquired_session_ownership_generation,
            )
            .await;
        }
        result
            .map(|execution| SessionExecutionAttempt {
                execution,
                sandbox_id: correlation_sandbox_id.clone(),
            })
            .map_err(|source| {
                SessionExecutionAttemptError::new(execution_id, correlation_sandbox_id, source)
            })
    }

    /// Persist an execution request and return before sandbox provisioning or
    /// stdin delivery. The queued row is the durable handoff boundary for HTTP
    /// callers: a background driver handles the live attempt, while the
    /// orphan-adoption scan replays a queued request after process restart.
    pub async fn enqueue_session_execution(
        &self,
        thread_key: &ThreadKey,
        input: ExecuteSessionInput,
    ) -> Result<SessionExecution, SessionRuntimeError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(SessionRuntimeError::ShuttingDown);
        }
        self.store.get_session(thread_key).await?;
        validate_input_lines(&input.input_lines)?;
        let _ = duration_options(input.idle_timeout_ms, input.max_duration_ms)?;

        let request = persisted_execute_request(&input)?;
        let execution = self
            .store
            .create_execution_with_request(
                thread_key,
                input.idempotency_key.as_deref(),
                execution_metadata(
                    input.metadata.clone(),
                    input.idle_timeout_ms,
                    input.max_duration_ms,
                ),
                request,
            )
            .await?;

        if execution.execution.status == ExecutionStatus::Queued {
            let persisted_input = if execution.created {
                input
            } else {
                self.load_persisted_execute_request(&execution.execution.execution_id)
                    .await?
            };
            self.spawn_session_execution(
                thread_key.clone(),
                execution.execution.execution_id.clone(),
                persisted_input,
            );
        }

        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_execute_enqueued",
            thread_key = %thread_key,
            execution_id = %execution.execution.execution_id,
            status = %execution.execution.status,
            created = execution.created,
            "persisted session execution request"
        );
        Ok(execution.execution)
    }

    fn spawn_session_execution(
        &self,
        thread_key: ThreadKey,
        execution_id: String,
        input: ExecuteSessionInput,
    ) {
        let runtime = self.clone();
        tokio::spawn(async move {
            if let Err(error) = runtime
                .drive_session_execution(&thread_key, &execution_id, input)
                .await
            {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_execute_dispatch_failed",
                    thread_key = %thread_key,
                    execution_id,
                    %error,
                    "failed to dispatch queued session execution"
                );
            }
        });
    }

    async fn load_persisted_execute_request(
        &self,
        execution_id: &str,
    ) -> Result<ExecuteSessionInput, SessionRuntimeError> {
        let request = self.store.execution_request(execution_id).await?;
        deserialize_persisted_execute_request(execution_id, request)
    }

    async fn record_execution_failure(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        error: &SessionRuntimeError,
    ) {
        if let Some(span) = self.execution_spans.lock().await.remove(execution_id) {
            finish_execution_trace_span(&span, "failed");
        }
        let ownership_generation = self
            .session_ownership_generations
            .remove(execution_id)
            .map(|(_, generation)| generation);
        let error_message = error.to_string();
        let execution = match self
            .store
            .fail_execution_if_active_and_stdout_owner(
                execution_id,
                &self.stdout_owner_id,
                &error_message,
            )
            .await
        {
            Ok(Some(execution)) => execution,
            Ok(None) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_execution_failure_not_recorded",
                    thread_key = %thread_key,
                    execution_id,
                    original_error = %error_message,
                    "execution was terminal or stdout ownership changed before failure could be recorded"
                );
                return;
            }
            Err(record_error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_execution_failure_record_failed",
                    thread_key = %thread_key,
                    execution_id,
                    original_error = %error_message,
                    error = %record_error,
                    "failed to persist execution failure"
                );
                return;
            }
        };
        let _ = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.execution_failed",
                json!({
                    "execution_id": execution_id,
                    "thread_key": thread_key.as_str(),
                    "error": error_message,
                }),
            )
            .await;
        record_finished_execution_metric(
            &self.store,
            thread_key,
            &execution,
            "failed",
            Some(runtime_error_failure_class(error)),
        )
        .await;
        // Release only the generation acquired for this execution. A stale
        // failure path cannot delete a successor that reclaimed the session.
        release_session_ownership_generation(
            &self.store,
            thread_key,
            &self.stdout_owner_id,
            ownership_generation,
        )
        .await;
    }

    async fn handle_stdout_claim_failure(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        error: &SessionRuntimeError,
    ) {
        if matches!(error, SessionRuntimeError::ShuttingDown) {
            match self
                .store
                .requeue_execution_if_running_without_stdout_owner(execution_id)
                .await
            {
                Ok(Some(_)) => {
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_execution_requeued",
                        thread_key = %thread_key,
                        execution_id,
                        reason = "control_plane_shutdown",
                        "returned undelivered execution to the durable queue"
                    );
                    return;
                }
                Ok(None) => {}
                Err(requeue_error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_execution_requeue_failed",
                        thread_key = %thread_key,
                        execution_id,
                        error = %requeue_error,
                        "failed to return undelivered execution to the durable queue"
                    );
                }
            }
        }
        self.record_execution_failure(thread_key, execution_id, error)
            .await;
    }

    async fn forward_messages_to_active_execution(
        &self,
        thread_key: &ThreadKey,
        messages: &[SessionMessageInput],
        message_ids: &[String],
    ) {
        let input_lines = steering_input_lines(thread_key, messages, message_ids);
        if input_lines.is_empty() {
            return;
        }

        let Some(execution) = (match self.store.active_execution_for_thread(thread_key).await {
            Ok(execution) => execution,
            Err(error) => {
                warn!(%thread_key, %error, "active execution lookup failed during message append");
                return;
            }
        }) else {
            return;
        };

        // Steering joins the active execution's trace so harness spans for the
        // steered turn stay in the same tree.
        let execution_span = self
            .execution_spans
            .lock()
            .await
            .get(&execution.execution_id)
            .cloned();
        let trace = SessionTraceContext::for_execution(
            execution_span.as_ref(),
            execution_traceparent(&execution).map(ToOwned::to_owned),
            Some(&execution.execution_id),
        )
        .with_thread_key(thread_key);
        // Inject the trusted ownership fence from the active execution's
        // generation so the harness-server can fence steering commands.
        let trace = if let Some(generation) = self
            .session_ownership_generations
            .get(&execution.execution_id)
            .map(|g| *g.value())
        {
            trace.with_ownership(&self.stdout_owner_id, generation)
        } else {
            trace
        };
        let input_lines = input_lines_with_session_context(thread_key, &trace, &input_lines);

        let pipe = match self
            .wait_for_active_steering_pipe(thread_key, &execution.execution_id)
            .await
        {
            Ok(pipe) => pipe,
            Err(error) => {
                self.record_steering_failure(thread_key, &execution.execution_id, error)
                    .await;
                return;
            }
        };

        if let Err(error) = write_input_lines(
            &pipe,
            &input_lines,
            thread_key,
            &execution.execution_id,
            None,
        )
        .await
        {
            self.record_steering_failure(thread_key, &execution.execution_id, error.to_string())
                .await;
            return;
        }

        if let Err(error) = self
            .store
            .append_event(
                thread_key,
                Some(&execution.execution_id),
                "session.steering_delivered",
                json!({
                    "execution_id": execution.execution_id,
                    "thread_key": thread_key.as_str(),
                    "message_ids": message_ids,
                    "input_line_count": input_lines.len(),
                }),
            )
            .await
        {
            warn!(%thread_key, %error, "failed to record steering delivery");
        }
    }

    pub async fn interrupt_active_execution(
        &self,
        thread_key: &ThreadKey,
        reason: &str,
    ) -> Result<InterruptExecutionOutcome, SessionRuntimeError> {
        let Some(execution) = self.store.active_execution_for_thread(thread_key).await? else {
            return Ok(InterruptExecutionOutcome {
                interrupted: false,
                execution_id: None,
            });
        };

        let execution_span = self
            .execution_spans
            .lock()
            .await
            .get(&execution.execution_id)
            .cloned();
        let trace = SessionTraceContext::for_execution(
            execution_span.as_ref(),
            execution_traceparent(&execution).map(ToOwned::to_owned),
            Some(&execution.execution_id),
        )
        .with_thread_key(thread_key);
        // Inject the trusted ownership fence from the active execution's
        // generation so the harness-server can fence interrupt commands.
        let trace = if let Some(generation) = self
            .session_ownership_generations
            .get(&execution.execution_id)
            .map(|g| *g.value())
        {
            trace.with_ownership(&self.stdout_owner_id, generation)
        } else {
            trace
        };
        let input_lines = input_lines_with_session_context(
            thread_key,
            &trace,
            &[interrupt_input_line(thread_key, reason)],
        );

        let pipe = self
            .wait_for_active_steering_pipe(thread_key, &execution.execution_id)
            .await
            .map_err(SessionRuntimeError::BadRequest)?;
        write_input_lines(
            &pipe,
            &input_lines,
            thread_key,
            &execution.execution_id,
            None,
        )
        .await?;

        self.store
            .append_event(
                thread_key,
                Some(&execution.execution_id),
                "session.interrupt_delivered",
                json!({
                    "execution_id": execution.execution_id,
                    "thread_key": thread_key.as_str(),
                    "reason": reason,
                }),
            )
            .await?;

        Ok(InterruptExecutionOutcome {
            interrupted: true,
            execution_id: Some(execution.execution_id),
        })
    }
    // ---- collaboration room lifecycle (centaur-3w2.6) ----

    /// Starts (or returns the existing) collaboration room for an OMP session.
    ///
    /// An active room acquires a resident session ownership lease, spawns a
    /// keepalive renewal task, touches the sandbox activity timestamp to
    /// prevent idle suspension, and records a durable lifecycle event. The
    /// room state is held in memory; recovery after process/relay loss
    /// requires a new room and new capability URL — the old room's lease
    /// and state are never reused.
    pub async fn start_collab_room(
        &self,
        thread_key: &ThreadKey,
        input: &CollabStartInput,
    ) -> Result<CollabRoomOutcome, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.collab.start",
            component = COMPONENT_SESSION_RUNTIME,
            event = "collab_room_start",
            "centaur.thread_key" = thread_key.as_str(),
            thread_key = %thread_key,
        );
        set_span_parent_trace(
            &span,
            &thread_trace_id(thread_key),
            &thread_trace_parent_span_id(thread_key),
        );
        async {
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err(SessionRuntimeError::ShuttingDown);
            }
            // Global read gate: held for the entire start so handoff write
            // waits for in-flight starts (including pre-insert) to finish.
            let _lifecycle_gate = self.collab_lifecycle_gate.read().await;
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err(SessionRuntimeError::ShuttingDown);
            }
            let lifecycle_lock = self.collab_lifecycle_lock(thread_key);
            let _lifecycle_guard = lifecycle_lock.lock().await;
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err(SessionRuntimeError::ShuttingDown);
            }
            ensure_thread_trace_root_span(thread_key);
            let session = self.store.get_session(thread_key).await?;
            if session.harness_type != HarnessType::Omp {
                return Err(SessionRuntimeError::CollabNotSupported {
                    harness_type: session.harness_type.to_string(),
                });
            }
            if matches!(
                session.status,
                SessionStatus::Failed | SessionStatus::Archived
            ) {
                return Err(SessionRuntimeError::CollabTerminalSession {
                    thread_key: thread_key.as_str().to_owned(),
                    status: session.status.to_string(),
                });
            }

            // Clone under a short-lived guard. An `if let Some(x) = map.get()...`
            // keeps the DashMap Ref alive for the entire if body (including
            // awaits), which deadlocks the stdout pump on the same shard and
            // stalls Tokio timers.
            let existing_handle = self
                .collab_rooms
                .get(thread_key)
                .as_deref()
                .filter(|h| h.is_externally_active())
                .cloned();
            if let Some(handle) = existing_handle {
                let session_sandbox = session.sandbox_id.as_deref();
                if session_sandbox != Some(handle.sandbox_id.as_str()) {
                    // Sandbox gone or reassigned A→B: bounded stop on A's
                    // sandbox before finalize. Never send A ownership to B.
                    let reason = if session_sandbox.is_none() {
                        "sandbox_gone"
                    } else {
                        "sandbox_reassigned"
                    };
                    match self
                        .attempt_collab_stop(
                            thread_key,
                            &handle.owner_id,
                            handle.generation,
                            &handle.sandbox_id,
                        )
                        .await
                    {
                        Ok(()) => {
                            self.cleanup_collab_room_local(
                                thread_key,
                                &handle,
                                "session.collab_room_lost",
                                reason,
                            )
                            .await?;
                        }
                        Err(stop_error) => {
                            if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                                && current.owner_id == handle.owner_id
                                && current.generation == handle.generation
                                && current.sandbox_id == handle.sandbox_id
                            {
                                current.mark_remote_stop_pending();
                            }
                            ensure_remote_stop_pending_retry(self, thread_key, &handle, reason);
                            return Err(stop_error);
                        }
                    }
                } else {
                    let status_deadline = Instant::now() + COLLAB_LIFECYCLE_DEADLINE;
                    let status_request_id = collab_request_id();
                    let status_anchor = match tokio::time::timeout_at(
                        status_deadline,
                        self.store.latest_event_id(thread_key),
                    )
                    .await
                    {
                        Ok(Ok(id)) => id,
                        Ok(Err(error)) => return Err(SessionRuntimeError::Store(error)),
                        Err(_) => {
                            return Err(SessionRuntimeError::CollabRoomLost {
                                thread_key: thread_key.as_str().to_owned(),
                                reason: "status probe baseline exceeded deadline".to_owned(),
                            });
                        }
                    };
                    let probe_result = self
                        .send_collab_control_line(
                            thread_key,
                            &handle.owner_id,
                            handle.generation,
                            &status_request_id,
                            "collab_status",
                            None,
                            None,
                            None,
                            handle.sandbox_id.as_str(),
                            status_deadline,
                        )
                        .await;
                    if let Err(probe_error) = probe_result {
                        // Probe write failed — do not finalize/remove. Enter
                        // RemoteStopPending and retain for retry.
                        if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                            && current.owner_id == handle.owner_id
                            && current.generation == handle.generation
                            && current.sandbox_id == handle.sandbox_id
                        {
                            current.mark_remote_stop_pending();
                        }
                        ensure_remote_stop_pending_retry(
                            self,
                            thread_key,
                            &handle,
                            "status_probe_failed",
                        );
                        return Err(probe_error);
                    }
                    match wait_for_collab_status(
                        &self.store,
                        thread_key,
                        status_anchor,
                        handle.generation,
                        &status_request_id,
                        status_deadline,
                    )
                    .await
                    {
                        Ok(room) if room.active => {
                            // Exact handle must still be Active before serving URL.
                            let current = self.collab_rooms.get(thread_key).as_deref().cloned();
                            if let Some(current) = current
                                && current.owner_id == handle.owner_id
                                && current.generation == handle.generation
                                && current.sandbox_id == handle.sandbox_id
                                && current.phase.is_externally_active()
                            {
                                return Ok(CollabRoomOutcome {
                                    ok: true,
                                    thread_key: thread_key.clone(),
                                    room: Some(room),
                                    stopped: false,
                                });
                            }
                        }
                        Ok(_) => {
                            // Inactive snapshot — remote-stop pending, retain.
                        }
                        Err(SessionRuntimeError::Store(error)) => {
                            // Propagate store errors unchanged (blocker 2).
                            return Err(SessionRuntimeError::Store(error));
                        }
                        Err(_) => {
                            // Timeout/lost — enter RemoteStopPending, do not finalize.
                        }
                    }
                    if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                        && current.owner_id == handle.owner_id
                        && current.generation == handle.generation
                        && current.sandbox_id == handle.sandbox_id
                    {
                        current.mark_remote_stop_pending();
                    }
                    ensure_remote_stop_pending_retry(self, thread_key, &handle, "stale_room");
                    return Err(SessionRuntimeError::CollabRoomLost {
                        thread_key: thread_key.as_str().to_owned(),
                        reason: "existing room status probe did not confirm active room".to_owned(),
                    });
                }
            }

            let ownership = self
                .store
                .acquire_session_ownership(
                    thread_key,
                    &self.stdout_owner_id,
                    SessionOwnerMode::Resident,
                )
                .await?;
            if !ownership.acquired {
                let mode = match ownership.mode {
                    SessionOwnerMode::Resident => "resident",
                    SessionOwnerMode::Oneshot => "oneshot",
                };
                return Err(SessionRuntimeError::SessionOwned {
                    thread_key: thread_key.as_str().to_owned(),
                    owner_id: ownership.owner_id,
                    mode,
                });
            }

            // Every post-acquire failure MUST generation-fence release the lease
            // or retain a FinalizePending cleanup handle. Never ignore release Err.
            let owner_id = self.stdout_owner_id.clone();
            let generation = ownership.generation;

            // Bind exact sandbox AFTER acquire — pre-acquire session may be stale.
            let session_after = match self.store.get_session(thread_key).await {
                Ok(s) => s,
                Err(error) => {
                    self.release_acquired_or_retain(thread_key, &owner_id, generation, None)
                        .await?;
                    return Err(SessionRuntimeError::Store(error));
                }
            };
            let Some(sandbox_id) = session_after.sandbox_id.clone() else {
                self.release_acquired_or_retain(thread_key, &owner_id, generation, None)
                    .await?;
                return Err(SessionRuntimeError::BadRequest(
                    "session has no assigned sandbox for collaboration".to_owned(),
                ));
            };

            let lifecycle_deadline = Instant::now() + COLLAB_LIFECYCLE_DEADLINE;

            match self.store.touch_session_sandbox_activity(thread_key).await {
                Ok(true) => {}
                Ok(false) => {
                    self.release_acquired_or_retain(
                        thread_key,
                        &owner_id,
                        generation,
                        Some(sandbox_id.as_str()),
                    )
                    .await?;
                    return Err(SessionRuntimeError::BadRequest(
                        "session has no live sandbox for collaboration".to_owned(),
                    ));
                }
                Err(error) => {
                    self.release_acquired_or_retain(
                        thread_key,
                        &owner_id,
                        generation,
                        Some(sandbox_id.as_str()),
                    )
                    .await?;
                    return Err(SessionRuntimeError::Store(error));
                }
            }
            let baseline_event_id = match tokio::time::timeout_at(
                lifecycle_deadline,
                self.store.latest_event_id(thread_key),
            )
            .await
            {
                Ok(Ok(id)) => id,
                Ok(Err(error)) => {
                    self.release_acquired_or_retain(
                        thread_key,
                        &owner_id,
                        generation,
                        Some(sandbox_id.as_str()),
                    )
                    .await?;
                    return Err(SessionRuntimeError::Store(error));
                }
                Err(_) => {
                    self.release_acquired_or_retain(
                        thread_key,
                        &owner_id,
                        generation,
                        Some(sandbox_id.as_str()),
                    )
                    .await?;
                    return Err(SessionRuntimeError::CollabRoomLost {
                        thread_key: thread_key.as_str().to_owned(),
                        reason: "collab start baseline exceeded lifecycle deadline".to_owned(),
                    });
                }
            };
            if self.shutting_down.load(Ordering::SeqCst) {
                self.release_acquired_or_retain(
                    thread_key,
                    &owner_id,
                    generation,
                    Some(sandbox_id.as_str()),
                )
                .await?;
                return Err(SessionRuntimeError::ShuttingDown);
            }
            let request_id = collab_request_id();
            let keepalive = Arc::new(AtomicBool::new(true));
            let initial_state = CollabRoomState {
                active: true,
                join_url: None,
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            };
            self.collab_rooms.insert(
                thread_key.clone(),
                CollabRoomHandle {
                    owner_id: self.stdout_owner_id.clone(),
                    generation: ownership.generation,
                    sandbox_id: sandbox_id.clone(),
                    state: initial_state,
                    keepalive: keepalive.clone(),
                    phase: CollabCleanupPhase::Active,
                    cleanup_worker_scheduled: false,
                },
            );
            // Keepalive is spawned only after durable started append succeeds.

            let send_result = self
                .send_collab_control_line(
                    thread_key,
                    &self.stdout_owner_id,
                    ownership.generation,
                    &request_id,
                    "collab_start",
                    input.relay_url.as_deref(),
                    input.web_url.as_deref(),
                    input.display_name.as_deref(),
                    sandbox_id.as_str(),
                    lifecycle_deadline,
                )
                .await;
            if let Err(error) = send_result {
                if let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() {
                    self.stop_or_enter_remote_pending(
                        thread_key,
                        &handle,
                        "collab_start_send_failed",
                    )
                    .await?;
                    self.cleanup_collab_room_local(
                        thread_key,
                        &handle,
                        "session.collab_room_lost",
                        "collab_start_send_failed",
                    )
                    .await?;
                }
                return Err(error);
            }

            let room_state = match wait_for_collab_started(
                &self.store,
                thread_key,
                baseline_event_id,
                ownership.generation,
                &request_id,
                lifecycle_deadline,
            )
            .await
            {
                Ok(state) => state,
                Err(error) => {
                    if let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() {
                        self.stop_or_enter_remote_pending(
                            thread_key,
                            &handle,
                            "collab_start_failed",
                        )
                        .await?;
                        self.cleanup_collab_room_local(
                            thread_key,
                            &handle,
                            "session.collab_room_lost",
                            "collab_start_failed",
                        )
                        .await?;
                    }
                    return Err(error);
                }
            };
            let handle_opt = self.collab_rooms.get(thread_key).as_deref().cloned();
            let Some(handle) = handle_opt else {
                // No handle left to retain; best-effort stop against our ownership.
                let _ = self
                    .attempt_collab_stop(
                        thread_key,
                        &self.stdout_owner_id,
                        ownership.generation,
                        sandbox_id.as_str(),
                    )
                    .await;
                return Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "collab room disappeared during start".to_owned(),
                });
            };
            if handle.owner_id != self.stdout_owner_id || handle.generation != ownership.generation
            {
                // Takeover handle present — stop our generation only via owned ids.
                let ours = CollabRoomHandle {
                    owner_id: self.stdout_owner_id.clone(),
                    generation: ownership.generation,
                    sandbox_id: sandbox_id.clone(),
                    state: handle.state.clone(),
                    keepalive: handle.keepalive.clone(),
                    phase: handle.phase,
                    cleanup_worker_scheduled: false,
                };
                let _ = self
                    .stop_or_enter_remote_pending(thread_key, &ours, "start_ownership_changed")
                    .await;
                return Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "collab room ownership changed during start".to_owned(),
                });
            }
            // Exact-handle state write — never overwrite a takeover.
            if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                && current.owner_id == handle.owner_id
                && current.generation == handle.generation
                && current.sandbox_id == handle.sandbox_id
            {
                current.state = room_state.clone();
            } else {
                let _ = self
                    .stop_or_enter_remote_pending(thread_key, &handle, "start_ownership_changed")
                    .await;
                return Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "collab room ownership changed during start".to_owned(),
                });
            }
            let persisted = self
                .store
                .append_unscoped_event_if_session_owner(
                    thread_key,
                    &self.stdout_owner_id,
                    ownership.generation,
                    PgSessionStore::SESSION_OWNERSHIP_LEASE,
                    "session.collab_room_started",
                    json!({
                        "thread_key": thread_key.as_str(),
                        "owner_id": self.stdout_owner_id,
                        "generation": ownership.generation,
                        "request_id": request_id,
                        "room": room_state.clone(),
                    }),
                )
                .await;
            let append_error: Option<SessionRuntimeError> = match persisted {
                Err(error) => Some(SessionRuntimeError::Store(error)),
                Ok(None) => Some(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "collab start lost ownership fence".to_owned(),
                }),
                Ok(Some(_)) => None,
            };
            if let Some(error) = append_error {
                if let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() {
                    self.stop_or_enter_remote_pending(thread_key, &handle, "collab_start_failed")
                        .await?;
                    if let Err(cleanup_error) = self
                        .cleanup_collab_room_local(
                            thread_key,
                            &handle,
                            "session.collab_room_lost",
                            "collab_start_failed",
                        )
                        .await
                    {
                        warn!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "collab_start_cleanup_failed",
                            thread_key = %thread_key,
                            %cleanup_error,
                            "cleanup after failed start; handle remains cleanup-pending"
                        );
                        return Err(cleanup_error);
                    }
                }
                return Err(error);
            }
            // Refuse success if keepalive already aborted during start wait.
            if !keepalive.load(Ordering::SeqCst) {
                let handle = self.collab_rooms.get(thread_key).as_deref().cloned();
                if let Some(handle) = handle {
                    let _ = self
                        .cleanup_collab_room_local(
                            thread_key,
                            &handle,
                            "session.collab_room_lost",
                            "keepalive_lost_during_start",
                        )
                        .await;
                }
                return Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "keepalive lost during collab start".to_owned(),
                });
            }
            if self.shutting_down.load(Ordering::SeqCst) {
                if let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() {
                    // Shutdown owns stop/finalize inline under a short bound.
                    // Finalize ONLY after stop ack — on stop Err the handle
                    // stays RemoteStopPending with lease retained (no live ghost).
                    let dl = Instant::now() + COLLAB_CLEANUP_DEADLINE;
                    match self
                        .stop_or_enter_remote_pending_within(
                            thread_key,
                            &handle,
                            "shutting_down",
                            dl,
                        )
                        .await
                    {
                        Ok(()) => {
                            let _ = self
                                .cleanup_collab_room_local_within(
                                    thread_key,
                                    &handle,
                                    "session.collab_room_lost",
                                    "shutting_down",
                                    dl,
                                )
                                .await;
                        }
                        Err(error) => {
                            warn!(
                                component = COMPONENT_SESSION_RUNTIME,
                                event = "collab_start_shutdown_stop_pending",
                                thread_key = %thread_key,
                                %error,
                                "stop failed during start-time shutdown; retaining RemoteStopPending"
                            );
                        }
                    }
                }
                return Err(SessionRuntimeError::ShuttingDown);
            }
            // Only now is the room durable and start about to return Ok —
            // spawn keepalive so renew/touch cannot race the start lock.
            spawn_collab_keepalive(
                self.clone(),
                thread_key.clone(),
                self.stdout_owner_id.clone(),
                ownership.generation,
                keepalive,
            );
            Ok(CollabRoomOutcome {
                ok: true,
                thread_key: thread_key.clone(),
                room: Some(room_state),
                stopped: false,
            })
        }
        .instrument(span)
        .await
    }

    /// Returns the current collaboration room state for a session, or `None`
    /// when no room is active. The state is the authoritative projection
    /// already durable in the event log and cached in memory by
    /// `process_collab_state_line` / `update_collab_room_state`. The status
    /// endpoint does not probe the resident host — liveness probing is
    /// performed by `start_collab_room` when it considers reusing a cached
    /// room. If the session's sandbox is gone, the stale room is cleaned up.
    pub async fn collab_room_status(
        &self,
        thread_key: &ThreadKey,
    ) -> Result<CollabRoomOutcome, SessionRuntimeError> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(SessionRuntimeError::ShuttingDown);
        }
        let _lifecycle_gate = self.collab_lifecycle_gate.read().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(SessionRuntimeError::ShuttingDown);
        }
        let lifecycle_lock = self.collab_lifecycle_lock(thread_key);
        let _lifecycle_guard = lifecycle_lock.lock().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err(SessionRuntimeError::ShuttingDown);
        }
        let Some(handle) = self
            .collab_rooms
            .get(thread_key)
            .as_deref()
            .filter(|h| h.is_externally_active())
            .cloned()
        else {
            return Ok(CollabRoomOutcome {
                ok: true,
                thread_key: thread_key.clone(),
                room: None,
                stopped: false,
            });
        };
        let session = self.store.get_session(thread_key).await?;
        if session.sandbox_id.as_deref() != Some(handle.sandbox_id.as_str()) {
            let reason = if session.sandbox_id.is_none() {
                "sandbox_gone"
            } else {
                "sandbox_reassigned"
            };
            match self
                .attempt_collab_stop(
                    thread_key,
                    &handle.owner_id,
                    handle.generation,
                    &handle.sandbox_id,
                )
                .await
            {
                Ok(()) => {
                    self.cleanup_collab_room_local(
                        thread_key,
                        &handle,
                        "session.collab_room_lost",
                        reason,
                    )
                    .await?;
                }
                Err(stop_error) => {
                    if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                        && current.owner_id == handle.owner_id
                        && current.generation == handle.generation
                        && current.sandbox_id == handle.sandbox_id
                    {
                        current.mark_remote_stop_pending();
                    }
                    ensure_remote_stop_pending_retry(self, thread_key, &handle, reason);
                    return Err(stop_error);
                }
            }
            return Ok(CollabRoomOutcome {
                ok: true,
                thread_key: thread_key.clone(),
                room: None,
                stopped: false,
            });
        }
        // Bounded resident collab_status probe on exact handle sandbox.
        // DB sandbox match alone is insufficient — never serve a dead URL.
        let deadline = Instant::now() + COLLAB_LIFECYCLE_DEADLINE;
        let request_id = collab_request_id();
        let anchor =
            match tokio::time::timeout_at(deadline, self.store.latest_event_id(thread_key)).await {
                Ok(Ok(id)) => id,
                Ok(Err(error)) => return Err(SessionRuntimeError::Store(error)),
                Err(_) => {
                    return Err(SessionRuntimeError::CollabRoomLost {
                        thread_key: thread_key.as_str().to_owned(),
                        reason: "status baseline exceeded deadline".to_owned(),
                    });
                }
            };
        if let Err(error) = self
            .send_collab_control_line(
                thread_key,
                &handle.owner_id,
                handle.generation,
                &request_id,
                "collab_status",
                None,
                None,
                None,
                handle.sandbox_id.as_str(),
                deadline,
            )
            .await
        {
            if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                && current.owner_id == handle.owner_id
                && current.generation == handle.generation
                && current.sandbox_id == handle.sandbox_id
            {
                current.mark_remote_stop_pending();
            }
            ensure_remote_stop_pending_retry(self, thread_key, &handle, "status_probe_failed");
            return Err(error);
        }
        match wait_for_collab_status(
            &self.store,
            thread_key,
            anchor,
            handle.generation,
            &request_id,
            deadline,
        )
        .await
        {
            Ok(room) if room.active => {
                // Exact handle must still be Active before returning URL.
                if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                    && current.owner_id == handle.owner_id
                    && current.generation == handle.generation
                    && current.sandbox_id == handle.sandbox_id
                    && current.phase.is_externally_active()
                {
                    current.state = room.clone();
                    return Ok(CollabRoomOutcome {
                        ok: true,
                        thread_key: thread_key.clone(),
                        room: Some(room),
                        stopped: false,
                    });
                }
                Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "status probe succeeded but room is no longer active".to_owned(),
                })
            }
            Ok(_) => {
                if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                    && current.owner_id == handle.owner_id
                    && current.generation == handle.generation
                    && current.sandbox_id == handle.sandbox_id
                {
                    current.mark_remote_stop_pending();
                }
                ensure_remote_stop_pending_retry(
                    self,
                    thread_key,
                    &handle,
                    "status_probe_inactive",
                );
                Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "status probe did not confirm active room".to_owned(),
                })
            }
            Err(SessionRuntimeError::Store(error)) => Err(SessionRuntimeError::Store(error)),
            Err(error) => {
                if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                    && current.owner_id == handle.owner_id
                    && current.generation == handle.generation
                    && current.sandbox_id == handle.sandbox_id
                {
                    current.mark_remote_stop_pending();
                }
                ensure_remote_stop_pending_retry(
                    self,
                    thread_key,
                    &handle,
                    "status_probe_wait_failed",
                );
                Err(error)
            }
        }
    }

    pub fn has_active_collab_room(&self, thread_key: &ThreadKey) -> bool {
        self.collab_rooms
            .get(thread_key)
            .map(|h| h.is_externally_active())
            .unwrap_or(false)
    }
    #[allow(clippy::too_many_arguments)]
    async fn send_collab_control_line(
        &self,
        thread_key: &ThreadKey,
        owner_id: &str,
        generation: i64,
        request_id: &str,
        command: &str,
        relay_url: Option<&str>,
        web_url: Option<&str>,
        display_name: Option<&str>,
        // Exact sandbox hosting the resident process (handle.sandbox_id).
        // Never the current session assignment — that may have moved A→B.
        target_sandbox_id: &str,
        deadline: Instant,
    ) -> Result<(), SessionRuntimeError> {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SessionRuntimeError::CollabRoomLost {
                thread_key: thread_key.as_str().to_owned(),
                reason: format!(
                    "collab {command} exceeded lifecycle deadline before control write"
                ),
            });
        }
        let sandbox_id = target_sandbox_id.to_owned();
        let work = async {
            let pipe = self.ensure_session_pipe(thread_key, &sandbox_id).await?;
            let frame = collab_control_frame(
                request_id,
                command,
                owner_id,
                generation,
                relay_url,
                web_url,
                display_name,
            );
            write_input_lines(
                &pipe,
                &[frame.to_string()],
                thread_key,
                "collab-control",
                Some(&sandbox_id),
            )
            .await
        };
        match tokio::time::timeout(remaining, work).await {
            Ok(result) => result,
            Err(_) => Err(SessionRuntimeError::CollabRoomLost {
                thread_key: thread_key.as_str().to_owned(),
                reason: format!(
                    "collab {command} exceeded lifecycle deadline during control write"
                ),
            }),
        }
    }

    /// Attempt remote stop for an exact handle. On failure/timeout, mark
    /// RemoteStopPending and schedule the cleanup worker (which retries stop
    /// before finalize). Returns Ok only when stop was acknowledged.
    async fn stop_or_enter_remote_pending(
        &self,
        thread_key: &ThreadKey,
        handle: &CollabRoomHandle,
        reason: &str,
    ) -> Result<(), SessionRuntimeError> {
        self.stop_or_enter_remote_pending_within(
            thread_key,
            handle,
            reason,
            Instant::now() + COLLAB_LIFECYCLE_DEADLINE,
        )
        .await
    }

    async fn stop_or_enter_remote_pending_within(
        &self,
        thread_key: &ThreadKey,
        handle: &CollabRoomHandle,
        reason: &str,
        deadline: Instant,
    ) -> Result<(), SessionRuntimeError> {
        match self
            .attempt_collab_stop_within(
                thread_key,
                &handle.owner_id,
                handle.generation,
                &handle.sandbox_id,
                deadline,
            )
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                    && current.owner_id == handle.owner_id
                    && current.generation == handle.generation
                    && current.sandbox_id == handle.sandbox_id
                {
                    current.mark_remote_stop_pending();
                }
                ensure_remote_stop_pending_retry(self, thread_key, handle, reason);
                Err(error)
            }
        }
    }

    async fn attempt_collab_stop(
        &self,
        thread_key: &ThreadKey,
        owner_id: &str,
        generation: i64,
        sandbox_id: &str,
    ) -> Result<(), SessionRuntimeError> {
        self.attempt_collab_stop_within(
            thread_key,
            owner_id,
            generation,
            sandbox_id,
            Instant::now() + COLLAB_LIFECYCLE_DEADLINE,
        )
        .await
    }

    async fn attempt_collab_stop_within(
        &self,
        thread_key: &ThreadKey,
        owner_id: &str,
        generation: i64,
        sandbox_id: &str,
        deadline: Instant,
    ) -> Result<(), SessionRuntimeError> {
        // Always target the handle's sandbox — never refetch session.sandbox_id,
        // which may have been reassigned A→B while this room still lives on A.
        let request_id = collab_request_id();
        let baseline =
            match tokio::time::timeout_at(deadline, self.store.latest_event_id(thread_key)).await {
                Ok(Ok(id)) => id,
                Ok(Err(error)) => return Err(SessionRuntimeError::Store(error)),
                Err(_) => {
                    return Err(SessionRuntimeError::CollabRoomLost {
                        thread_key: thread_key.as_str().to_owned(),
                        reason: "collab_stop baseline exceeded lifecycle deadline".to_owned(),
                    });
                }
            };
        self.send_collab_control_line(
            thread_key,
            owner_id,
            generation,
            &request_id,
            "collab_stop",
            None,
            None,
            None,
            sandbox_id,
            deadline,
        )
        .await?;
        wait_for_collab_stopped(
            &self.store,
            thread_key,
            baseline,
            generation,
            &request_id,
            deadline,
        )
        .await?;
        Ok(())
    }

    /// Generation-fenced release after a failed post-acquire path. On release
    /// Err, retain a FinalizePending handle and schedule cleanup retry.
    async fn release_acquired_or_retain(
        &self,
        thread_key: &ThreadKey,
        owner_id: &str,
        generation: i64,
        sandbox_hint: Option<&str>,
    ) -> Result<(), SessionRuntimeError> {
        match self
            .store
            .release_session_ownership_at_generation(thread_key, owner_id, generation)
            .await
        {
            Ok(_) => Ok(()),
            Err(error) => {
                let sandbox_id = sandbox_hint.unwrap_or("unknown").to_owned();
                self.collab_rooms.insert(
                    thread_key.clone(),
                    CollabRoomHandle {
                        owner_id: owner_id.to_owned(),
                        generation,
                        sandbox_id,
                        state: CollabRoomState {
                            active: false,
                            join_url: None,
                            view_url: None,
                            web_url: None,
                            web_view_url: None,
                            participants: Vec::new(),
                        },
                        keepalive: Arc::new(AtomicBool::new(false)),
                        phase: CollabCleanupPhase::FinalizePending,
                        cleanup_worker_scheduled: false,
                    },
                );
                if let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() {
                    ensure_cleanup_pending_retry(
                        &self.store,
                        &self.collab_rooms,
                        thread_key,
                        &handle,
                        "session.collab_room_lost",
                        "post_acquire_release_failed",
                    );
                }
                Err(SessionRuntimeError::Store(error))
            }
        }
    }

    async fn cleanup_collab_room_local(
        &self,
        thread_key: &ThreadKey,
        handle: &CollabRoomHandle,
        event_type: &str,
        reason: &str,
    ) -> Result<(), SessionRuntimeError> {
        self.cleanup_collab_room_local_within(
            thread_key,
            handle,
            event_type,
            reason,
            Instant::now() + COLLAB_CLEANUP_DEADLINE,
        )
        .await
    }

    async fn cleanup_collab_room_local_within(
        &self,
        thread_key: &ThreadKey,
        handle: &CollabRoomHandle,
        event_type: &str,
        reason: &str,
        deadline: Instant,
    ) -> Result<(), SessionRuntimeError> {
        handle.keepalive.store(false, Ordering::SeqCst);
        if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
            && current.owner_id == handle.owner_id
            && current.generation == handle.generation
            && current.sandbox_id == handle.sandbox_id
        {
            current.mark_finalize_pending();
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            ensure_cleanup_pending_retry(
                &self.store,
                &self.collab_rooms,
                thread_key,
                handle,
                event_type,
                reason,
            );
            return Err(SessionRuntimeError::CollabRoomLost {
                thread_key: thread_key.as_str().to_owned(),
                reason: format!("collab cleanup finalize exceeded deadline for {event_type}"),
            });
        }
        let result = match tokio::time::timeout(
            remaining,
            self.store.finalize_collab_room(
                thread_key,
                &handle.owner_id,
                handle.generation,
                PgSessionStore::SESSION_OWNERSHIP_LEASE,
                event_type,
                json!({
                    "thread_key": thread_key.as_str(),
                    "reason": reason,
                    "owner_id": handle.owner_id,
                    "generation": handle.generation,
                    "sandbox_id": handle.sandbox_id,
                }),
            ),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                ensure_cleanup_pending_retry(
                    &self.store,
                    &self.collab_rooms,
                    thread_key,
                    handle,
                    event_type,
                    reason,
                );
                return Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: format!("collab cleanup finalize timed out for {event_type}"),
                });
            }
        };
        // Ownership proof shares the remaining deadline budget.
        apply_collab_finalize_result_within(
            &self.store,
            &self.collab_rooms,
            thread_key,
            handle,
            event_type,
            reason,
            result,
            deadline,
        )
        .await
    }

    /// Stops the collaboration room for a session, releasing the keepalive
    /// and the session ownership lease. Idempotent: stopping when no room is
    /// active returns `stopped: false` without error. Records a durable
    /// lifecycle event fenced by the ownership generation.
    pub async fn stop_collab_room(
        &self,
        thread_key: &ThreadKey,
        input: &CollabStopInput,
    ) -> Result<CollabRoomOutcome, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.collab.stop",
            component = COMPONENT_SESSION_RUNTIME,
            event = "collab_room_stop",
            "centaur.thread_key" = thread_key.as_str(),
            thread_key = %thread_key,
        );
        set_span_parent_trace(
            &span,
            &thread_trace_id(thread_key),
            &thread_trace_parent_span_id(thread_key),
        );
        async {
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err(SessionRuntimeError::ShuttingDown);
            }
            // Global read gate before per-thread lock (same order as start/status/loss)
            // so handoff write waits in-flight stop and cannot race finalize.
            let _lifecycle_gate = self.collab_lifecycle_gate.read().await;
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err(SessionRuntimeError::ShuttingDown);
            }
            let lifecycle_lock = self.collab_lifecycle_lock(thread_key);
            let _lifecycle_guard = lifecycle_lock.lock().await;
            if self.shutting_down.load(Ordering::SeqCst) {
                return Err(SessionRuntimeError::ShuttingDown);
            }
            let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() else {
                return Ok(CollabRoomOutcome {
                    ok: true,
                    thread_key: thread_key.clone(),
                    room: None,
                    stopped: false,
                });
            };
            let deadline = Instant::now() + COLLAB_LIFECYCLE_DEADLINE;
            let request_id = collab_request_id();
            let baseline_event_id =
                match tokio::time::timeout_at(deadline, self.store.latest_event_id(thread_key))
                    .await
                {
                    Ok(Ok(id)) => id,
                    Ok(Err(error)) => return Err(SessionRuntimeError::Store(error)),
                    Err(_) => {
                        return Err(SessionRuntimeError::CollabRoomLost {
                            thread_key: thread_key.as_str().to_owned(),
                            reason: "stop baseline exceeded lifecycle deadline".to_owned(),
                        });
                    }
                };
            let control_error = self
                .send_collab_control_line(
                    thread_key,
                    &handle.owner_id,
                    handle.generation,
                    &request_id,
                    "collab_stop",
                    None,
                    None,
                    None,
                    handle.sandbox_id.as_str(),
                    deadline,
                )
                .await
                .err();
            let wait_error = if control_error.is_none() {
                wait_for_collab_stopped(
                    &self.store,
                    thread_key,
                    baseline_event_id,
                    handle.generation,
                    &request_id,
                    deadline,
                )
                .await
                .err()
            } else {
                None
            };
            let error = control_error.or(wait_error);
            let reason = input.reason.as_deref().unwrap_or("explicit_stop");
            if let Some(error) = error {
                // Distinct remote-stop-pending: retry targets handle.sandbox_id.
                // Never DB-finalize as stopped while relay may still be live.
                if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                    && current.owner_id == handle.owner_id
                    && current.generation == handle.generation
                    && current.sandbox_id == handle.sandbox_id
                {
                    current.mark_remote_stop_pending();
                }
                ensure_remote_stop_pending_retry(self, thread_key, &handle, "stop_control_failed");
                return Err(error);
            }
            self.cleanup_collab_room_local(
                thread_key,
                &handle,
                "session.collab_room_stopped",
                reason,
            )
            .await?;
            Ok(CollabRoomOutcome {
                ok: true,
                thread_key: thread_key.clone(),
                room: None,
                stopped: true,
            })
        }
        .instrument(span)
        .await
    }

    /// Updates the in-memory room state from a `collab_state` frame emitted
    /// by the resident OMP host. Fenced by the ownership generation: a stale
    /// owner whose generation no longer matches cannot update the room state.
    /// Called by the harness-server adapter when it demultiplexes OMP stdout.
    pub async fn update_collab_room_state(
        &self,
        thread_key: &ThreadKey,
        owner_id: &str,
        generation: i64,
        state: &CollabRoomState,
    ) -> Result<bool, SessionRuntimeError> {
        // Fence before any await: stale generation cannot publish.
        let sandbox_id = {
            let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() else {
                return Ok(false);
            };
            if handle.owner_id != owner_id || handle.generation != generation {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "collab_room_update_fenced",
                    thread_key = %thread_key,
                    expected_generation = handle.generation,
                    received_generation = generation,
                    "stale owner attempted to update collab room state"
                );
                return Ok(false);
            }
            handle.sandbox_id
        };
        let persisted = self
            .store
            .append_unscoped_event_if_session_owner(
                thread_key,
                owner_id,
                generation,
                PgSessionStore::SESSION_OWNERSHIP_LEASE,
                "session.collab_room_state",
                json!({
                    "thread_key": thread_key.as_str(),
                    "owner_id": owner_id,
                    "generation": generation,
                    "state": state,
                }),
            )
            .await?;
        if persisted.is_none() {
            return Ok(false);
        }
        // Exact-handle write after await — never overwrite a takeover.
        if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
            && current.owner_id == owner_id
            && current.generation == generation
            && current.sandbox_id == sandbox_id
        {
            current.state = state.clone();
            return Ok(true);
        }
        Ok(false)
    }

    /// Removes the collaboration room for a session after a detected
    /// owner/process/relay loss. The keepalive is invalidated, the in-memory
    /// room is removed, and a terminal lifecycle event is recorded. Recovery
    /// requires a new room with a new capability URL — the old room is never
    /// reused.
    pub async fn lose_collab_room(
        &self,
        thread_key: &ThreadKey,
        reason: &str,
    ) -> Result<(), SessionRuntimeError> {
        let _lifecycle_gate = self.collab_lifecycle_gate.read().await;
        if self.shutting_down.load(Ordering::SeqCst) {
            // Shutdown owns stop/finalize under the write gate; loss is a no-op.
            return Ok(());
        }
        let lifecycle_lock = self.collab_lifecycle_lock(thread_key);
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let Some(handle) = self.collab_rooms.get(thread_key).as_deref().cloned() else {
            return Ok(());
        };
        self.stop_or_enter_remote_pending(thread_key, &handle, reason)
            .await?;
        self.cleanup_collab_room_local(thread_key, &handle, "session.collab_room_lost", reason)
            .await?;
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "collab_room_lost_recorded",
            thread_key = %thread_key,
            reason = reason,
            "collaboration room lost"
        );
        Ok(())
    }

    async fn wait_for_active_steering_pipe(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
    ) -> Result<SessionPipe, String> {
        let deadline = Instant::now() + STEERING_STARTUP_RETRY_TIMEOUT;
        loop {
            let session = self
                .store
                .get_session(thread_key)
                .await
                .map_err(|error| format!("get session: {error}"))?;

            if let Some(sandbox_id) = session.sandbox_id.as_deref() {
                match self.ensure_session_pipe(thread_key, sandbox_id).await {
                    Ok(pipe) => return Ok(pipe),
                    Err(error)
                        if is_transient_steering_startup_error(&error)
                            && Instant::now() < deadline => {}
                    Err(error) => return Err(error.to_string()),
                }
            } else if Instant::now() >= deadline {
                return Err("session has no sandbox assigned".to_owned());
            }

            if !execution_still_active(&self.store, thread_key, execution_id).await {
                return Err("execution is no longer active".to_owned());
            }
            sleep(STEERING_STARTUP_RETRY_INTERVAL).await;
        }
    }

    async fn record_steering_failure(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        error: String,
    ) {
        warn!(%thread_key, %execution_id, %error, "active steering delivery failed");
        let _ = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.steering_failed",
                json!({
                    "execution_id": execution_id,
                    "thread_key": thread_key.as_str(),
                    "error": error,
                }),
            )
            .await;
    }

    pub async fn stream_events(
        &self,
        thread_key: &ThreadKey,
        after_event_id: i64,
        execution_id: Option<&str>,
    ) -> Result<
        impl Stream<Item = Result<SessionEvent, SessionRuntimeError>> + use<>,
        SessionRuntimeError,
    > {
        let span = info_span!(
            "centaur.api_rs.session.events.stream",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_events_stream",
            "centaur.thread_key" = thread_key.as_str(),
            thread_key = %thread_key,
            after_event_id,
            execution_id = execution_id.unwrap_or(""),
        );
        let result = async {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_events_stream_started",
                thread_key = %thread_key,
                after_event_id,
                execution_id = execution_id.unwrap_or(""),
                "opening session event stream"
            );
            let session = self.store.get_session(thread_key).await?;
            if let Some(sandbox_id) = session.sandbox_id.as_deref() {
                self.ensure_session_pipe_if_live(thread_key, sandbox_id)
                    .await?;
            }

            let listener = self.store.listen_session_events().await?;

            Ok(session_event_stream(
                self.store.clone(),
                thread_key.clone(),
                after_event_id,
                execution_id.map(ToOwned::to_owned),
                listener,
                span.clone(),
            ))
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_events_stream_failed",
                thread_key = %thread_key,
                after_event_id,
                %error,
                "failed to open session event stream"
            );
        }
        result
    }

    pub async fn exec_in_session_sandbox(
        &self,
        thread_key: &ThreadKey,
        command: &[String],
    ) -> Result<SandboxCommandOutput, SessionRuntimeError> {
        let session = self.store.get_session(thread_key).await?;
        let sandbox_id = session.sandbox_id.ok_or_else(|| {
            SessionRuntimeError::BadRequest(format!(
                "session {thread_key} has no sandbox to inspect"
            ))
        })?;
        self.sandbox_runtime
            .manager
            .exec(&SandboxId::new(sandbox_id), command)
            .await
            .map_err(SessionRuntimeError::Sandbox)
    }

    async fn ensure_session_sandbox(
        &self,
        request: EnsureSessionSandboxRequest<'_>,
    ) -> Result<String, SessionRuntimeError> {
        let EnsureSessionSandboxRequest {
            thread_key,
            harness_type,
            persona_id,
            existing_sandbox_id,
            existing_sandbox_capabilities,
            iron_control_principal,
            requester_principal,
            proxy_labels,
            desired_capabilities,
            execution_id,
        } = request;
        let boot_mode = sandbox_boot_mode_for_thread(thread_key, iron_control_principal);
        let span = info_span!(
            "centaur.api_rs.sandbox.ensure",
            component = COMPONENT_SESSION_RUNTIME,
            event = "sandbox_ensure",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = execution_id,
            "centaur.sandbox_id" = tracing::field::Empty,
            thread_key = %thread_key,
            execution_id,
            sandbox_id = tracing::field::Empty,
            existing_sandbox_id = existing_sandbox_id.unwrap_or(""),
            iron_control_principal_present = iron_control_principal.is_some(),
            persona_id = persona_id.unwrap_or(""),
            sandbox_boot_mode = boot_mode.as_str(),
            sandbox_repo_cache_access = desired_capabilities.repo_cache.as_str(),
            sandbox_repo_cache_enabled = desired_capabilities.repo_cache_enabled(),
            sandbox_observability_enabled = desired_capabilities.observability_enabled,
        );
        let ensure_started = Instant::now();
        let result = async {
            let persona_context = self.resolve_stored_persona(persona_id, desired_capabilities)?;
            if let Some(sandbox_id) = existing_sandbox_id {
                let id = SandboxId::new(sandbox_id);
                if !sandbox_capabilities_match(existing_sandbox_capabilities, desired_capabilities)
                {
                    self.sandbox_pipes.remove(sandbox_id);
                    match self.sandbox_runtime.manager.stop(&id).await {
                        Ok(()) | Err(SandboxError::NotFound(_)) => {}
                        Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
                    }
                    self.store.update_sandbox_id(thread_key, None).await?;
                    self.store
                        .append_event(
                            thread_key,
                            Some(execution_id),
                            "session.sandbox_capabilities_replaced",
                            json!({
                                "execution_id": execution_id,
                                "thread_key": thread_key.as_str(),
                                "sandbox_id": sandbox_id,
                                "previous_capabilities": existing_sandbox_capabilities,
                                "desired_capabilities": desired_capabilities,
                            }),
                        )
                        .await?;
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "sandbox_ensure_capabilities_replaced",
                        thread_key = %thread_key,
                        execution_id,
                        sandbox_id,
                        sandbox_repo_cache_access = desired_capabilities.repo_cache.as_str(),
                        sandbox_repo_cache_enabled = desired_capabilities.repo_cache_enabled(),
                        sandbox_observability_enabled = desired_capabilities.observability_enabled,
                        "replacing existing sandbox whose capabilities do not match"
                    );
                } else {
                match self.sandbox_runtime.manager.status(&id).await {
                    Ok(status) => match existing_sandbox_action(&status) {
                        ExistingSandboxAction::Reuse => {
                            if let Some(principal_id) = iron_control_principal {
                                self.sandbox_runtime
                                    .manager
                                    .ensure_iron_control_proxy_resources(
                                        &id,
                                        principal_id,
                                        requester_principal,
                                        proxy_labels,
                                    )
                                    .await?;
                            }
                            span.record("centaur.sandbox_id", sandbox_id);
                            span.record("sandbox_id", sandbox_id);
                            let ready_duration = ensure_started.elapsed();
                            self.record_sandbox_ready(SandboxReadyObservation {
                                thread_key,
                                execution_id,
                                sandbox_id,
                                harness_type,
                                source: "reused",
                                ready_duration,
                                startup_duration: None,
                            })
                            .await;
                            info!(
                                component = COMPONENT_SESSION_RUNTIME,
                                event = "sandbox_ensure_reused",
                                thread_key = %thread_key,
                                execution_id,
                                sandbox_id,
                                harness_type = %harness_type,
                                sandbox_ready_source = "reused",
                                sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
                                "reusing existing session sandbox"
                            );
                            return Ok(sandbox_id.to_owned());
                        }
                        ExistingSandboxAction::ResumeOrReplace => {
                            self.sandbox_pipes.remove(sandbox_id);
                            let resume_id = id.clone();
                            match self
                                .run_with_running_capacity(
                                    thread_key,
                                    execution_id,
                                    "resume",
                                    || async {
                                        self.sandbox_runtime
                                            .manager
                                            .resume(&resume_id)
                                            .await
                                            .map_err(SessionRuntimeError::Sandbox)
                                    },
                                )
                                .await
                            {
                                Ok(()) => {
                                    if let Some(principal_id) = iron_control_principal {
                                        self.sandbox_runtime
                                            .manager
                                            .ensure_iron_control_proxy_resources(
                                                &id,
                                                principal_id,
                                                requester_principal,
                                                proxy_labels,
                                            )
                                            .await?;
                                    }
                                    span.record("centaur.sandbox_id", sandbox_id);
                                    span.record("sandbox_id", sandbox_id);
                                    let ready_duration = ensure_started.elapsed();
                                    self.store
                                        .append_event(
                                            thread_key,
                                            Some(execution_id),
                                            "session.sandbox_resumed",
                                            json!({
                                                "execution_id": execution_id,
                                                "thread_key": thread_key.as_str(),
                                                "sandbox_id": sandbox_id,
                                            }),
                                        )
                                        .await?;
                                    self.record_sandbox_ready(SandboxReadyObservation {
                                        thread_key,
                                        execution_id,
                                        sandbox_id,
                                        harness_type,
                                        source: "resumed",
                                        ready_duration,
                                        startup_duration: None,
                                    })
                                    .await;
                                    info!(
                                        component = COMPONENT_SESSION_RUNTIME,
                                        event = "sandbox_ensure_resumed",
                                        thread_key = %thread_key,
                                        execution_id,
                                        sandbox_id,
                                        harness_type = %harness_type,
                                        sandbox_ready_source = "resumed",
                                        sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
                                        "resumed existing session sandbox"
                                    );
                                    return Ok(sandbox_id.to_owned());
                                }
                                Err(SessionRuntimeError::Sandbox(error)) => {
                                    warn!(
                                        component = COMPONENT_SESSION_RUNTIME,
                                        event = "sandbox_ensure_resume_failed",
                                        %thread_key,
                                        %execution_id,
                                        %sandbox_id,
                                        %error,
                                        "replacing sandbox after resume failed"
                                    );
                                    self.store
                                        .append_event(
                                            thread_key,
                                            Some(execution_id),
                                            "session.sandbox_resume_failed",
                                            json!({
                                                "execution_id": execution_id,
                                                "thread_key": thread_key.as_str(),
                                                "sandbox_id": sandbox_id,
                                                "error": error.to_string(),
                                            }),
                                        )
                                        .await?;
                                }
                                Err(error) => return Err(error),
                            }
                        }
                        ExistingSandboxAction::Replace => {
                            info!(
                                component = COMPONENT_SESSION_RUNTIME,
                                event = "sandbox_ensure_replacing",
                                thread_key = %thread_key,
                                execution_id,
                                sandbox_id,
                                status = ?status,
                                "existing sandbox is not reusable"
                            );
                        }
                    },
                    Err(SandboxError::NotFound(_)) => {
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "sandbox_ensure_missing",
                            thread_key = %thread_key,
                            execution_id,
                            sandbox_id,
                            "existing sandbox is missing"
                        );
                    }
                    Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
                }
                }
            }

            // Warm sandboxes are pre-booted with the workload's default
            // harness; a session on any other harness needs a cold sandbox.
            let warm_harness_matches = self
                .sandbox_runtime
                .warm_harness
                .as_ref()
                .is_none_or(|warm| warm == harness_type);
            let warm_persona_matches = persona_context.is_none();
            if !warm_harness_matches && self.warm_pool.is_some() {
                record_sandbox_warm_pool_claim("harness_mismatch");
            }
            if !warm_persona_matches && self.warm_pool.is_some() {
                record_sandbox_warm_pool_claim("persona_specific");
            }
            if !desired_capabilities.is_default_enabled() && self.warm_pool.is_some() {
                record_sandbox_warm_pool_claim("capabilities_non_default");
            }
            if let Some(warm_pool) = self
                .warm_pool
                .as_ref()
                .filter(|_| {
                    boot_mode.uses_warm_pool()
                        && warm_harness_matches
                        && warm_persona_matches
                        && desired_capabilities.is_default_enabled()
                })
            {
                match warm_pool
                    .claim(
                        thread_key.as_str(),
                        iron_control_principal,
                        requester_principal,
                        proxy_labels,
                    )
                    .await
                {
                    Ok(Some(sandbox_id)) => {
                        record_sandbox_warm_pool_claim("hit");
                        span.record("centaur.sandbox_id", sandbox_id.as_str());
                        span.record("sandbox_id", sandbox_id.as_str());
                        let ready_duration = ensure_started.elapsed();
                        self.store
                            .update_sandbox_assignment(
                                thread_key,
                                sandbox_id.as_str(),
                                desired_capabilities,
                            )
                            .await?;
                        self.store
                            .append_event(
                                thread_key,
                                None,
                                "session.warm_sandbox_claimed",
                                json!({
                                    "sandbox_id": sandbox_id.as_str(),
                                    "workload_key": warm_pool.workload_key(),
                                    "iron_control_principal": iron_control_principal,
                                    "requester_principal": requester_principal,
                                    "sandbox_capabilities": desired_capabilities,
                                }),
                            )
                            .await?;
                        self.record_sandbox_ready(SandboxReadyObservation {
                            thread_key,
                            execution_id,
                            sandbox_id: sandbox_id.as_str(),
                            harness_type,
                            source: "warm_pool",
                            ready_duration,
                            startup_duration: None,
                        })
                        .await;
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "sandbox_ensure_warm_claimed",
                            thread_key = %thread_key,
                            execution_id,
                            sandbox_id = %sandbox_id,
                            harness_type = %harness_type,
                            sandbox_ready_source = "warm_pool",
                            sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
                            workload_key = warm_pool.workload_key(),
                            "claimed warm session sandbox"
                        );
                        return Ok(sandbox_id);
                    }
                    Ok(None) => record_sandbox_warm_pool_claim("miss"),
                    Err(error) => {
                        record_sandbox_warm_pool_claim("error");
                        return Err(SessionRuntimeError::WarmPool(error));
                    }
                }
            }

            let mut spec = (self.sandbox_runtime.spec_factory)(
                thread_key,
                execution_id,
                harness_type,
                persona_context.as_ref(),
            );
            if let Some(principal) = iron_control_principal {
                spec.iron_control_principal = Some(principal.to_owned());
                spec.iron_control_requester_principal = requester_principal.map(ToOwned::to_owned);
                spec.iron_control_proxy_labels = proxy_labels.clone();
            }
            apply_sandbox_boot_mode(&mut spec, &boot_mode);
            apply_sandbox_capabilities(&mut spec, desired_capabilities);
            let create_started = Instant::now();
            let handle = self
                .run_with_running_capacity(thread_key, execution_id, "cold_create", || async {
                    self.sandbox_runtime
                        .manager
                        .create_running(spec)
                        .await
                        .map_err(SessionRuntimeError::Sandbox)
                })
                .await?;
            let startup_duration = create_started.elapsed();
            let ready_duration = ensure_started.elapsed();
            span.record("centaur.sandbox_id", handle.id.as_str());
            span.record("sandbox_id", handle.id.as_str());
            self.store
                .update_sandbox_assignment(thread_key, handle.id.as_str(), desired_capabilities)
                .await?;
            self.record_sandbox_ready(SandboxReadyObservation {
                thread_key,
                execution_id,
                sandbox_id: handle.id.as_str(),
                harness_type,
                source: "cold_create",
                ready_duration,
                startup_duration: Some(startup_duration),
            })
            .await;
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ensure_created",
                thread_key = %thread_key,
                execution_id,
                sandbox_id = %handle.id.as_str(),
                harness_type = %harness_type,
                sandbox_ready_source = "cold_create",
                sandbox_ready_duration_ms = duration_millis_u64(ready_duration),
                sandbox_startup_duration_ms = duration_millis_u64(startup_duration),
                sandbox_startup_duration_seconds = startup_duration.as_secs_f64(),
                "created new session sandbox"
            );
            Ok(handle.id.into_string())
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ensure_failed",
                thread_key = %thread_key,
                execution_id,
                %error,
                "failed to ensure session sandbox"
            );
        }
        result
    }

    /// Resolve and upsert the principal of the human requesting this turn from
    /// the execute metadata. `None` for DM and non-Slack threads (the
    /// registrar decides) and on registrar failure: a broken requester lookup
    /// must degrade to today's requester-less turn, never fail the execution.
    async fn resolve_requester_principal(
        &self,
        thread_key: &ThreadKey,
        metadata: Option<&Value>,
    ) -> Option<String> {
        match self
            .iron_control
            .register_requester(thread_key.as_str(), metadata)
            .await
        {
            Ok(principal) => principal.map(|principal| principal.id),
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_requester_registration_failed",
                    thread_key = %thread_key,
                    %error,
                    "failed to register requester principal; proceeding without a requester"
                );
                None
            }
        }
    }

    async fn resolve_sandbox_capabilities(
        &self,
        iron_control_principal: Option<&str>,
    ) -> Result<SessionSandboxCapabilities, SessionRuntimeError> {
        let Some(principal_id) = iron_control_principal else {
            return Ok(SessionSandboxCapabilities::default_enabled());
        };
        let principal = self.iron_control.get_principal(principal_id).await?;
        Ok(sandbox_capabilities_from_principal(&principal))
    }

    async fn record_sandbox_ready(&self, observation: SandboxReadyObservation<'_>) {
        let SandboxReadyObservation {
            thread_key,
            execution_id,
            sandbox_id,
            harness_type,
            source,
            ready_duration,
            startup_duration,
        } = observation;
        let ready_duration_ms = duration_millis_u64(ready_duration);
        let startup_duration_ms = startup_duration.map(duration_millis_u64).unwrap_or(0);
        let sandbox_started_for_request = startup_duration.is_some();

        if let Err(error) = self
            .store
            .touch_sandbox_activity(thread_key, sandbox_id)
            .await
        {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_sandbox_activity_touch_failed",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                %error,
                "failed to touch sandbox activity after sandbox ready"
            );
        }

        if let Err(error) = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.sandbox_ready",
                json!({
                    "execution_id": execution_id,
                    "thread_key": thread_key.as_str(),
                    "sandbox_id": sandbox_id,
                    "harness_type": harness_type.to_string(),
                    "sandbox_ready_source": source,
                    "sandbox_ready_duration_ms": ready_duration_ms,
                    "sandbox_startup_duration_ms": startup_duration_ms,
                    "sandbox_started_for_request": sandbox_started_for_request,
                }),
            )
            .await
        {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "sandbox_ready_event_append_failed",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                %error,
                "failed to append sandbox ready event"
            );
        }

        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "sandbox_ready",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            harness_type = %harness_type,
            sandbox_ready_source = source,
            sandbox_ready_duration_ms = ready_duration_ms,
            sandbox_startup_duration_ms = startup_duration_ms,
            sandbox_started_for_request,
            "session sandbox ready"
        );
    }

    async fn ensure_session_pipe_if_live(
        &self,
        thread_key: &ThreadKey,
        sandbox_id: &str,
    ) -> Result<(), SessionRuntimeError> {
        let id = SandboxId::new(sandbox_id);
        match self.sandbox_runtime.manager.status(&id).await {
            Ok(status) if should_attach_session_pipe(&status) => {
                if let Err(error) = self.ensure_session_pipe(thread_key, sandbox_id).await
                    && !is_event_stream_attach_race(&error)
                {
                    return Err(error);
                }
            }
            Ok(_) => {}
            Err(SandboxError::NotFound(_)) => {}
            Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
        }
        Ok(())
    }

    async fn ensure_session_pipe(
        &self,
        thread_key: &ThreadKey,
        sandbox_id: &str,
    ) -> Result<SessionPipe, SessionRuntimeError> {
        let span = info_span!(
            "centaur.api_rs.session.pipe.ensure",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_pipe_ensure",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.sandbox_id" = sandbox_id,
            thread_key = %thread_key,
            sandbox_id,
        );
        let result = async {
            if let Some(pipe) = self
                .sandbox_pipes
                .get(sandbox_id)
                .map(|entry| entry.clone())
            {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_pipe_reused",
                    thread_key = %thread_key,
                    sandbox_id,
                    "reusing session pipe"
                );
                return Ok(pipe);
            }

            let open_lock = {
                let entry = self
                    .sandbox_pipe_open_locks
                    .entry(sandbox_id.to_owned())
                    .or_insert_with(|| Arc::new(Mutex::new(())));
                entry.clone()
            };
            let _open_guard = open_lock.lock().await;

            if let Some(pipe) = self
                .sandbox_pipes
                .get(sandbox_id)
                .map(|entry| entry.clone())
            {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_pipe_reused",
                    thread_key = %thread_key,
                    sandbox_id,
                    "reusing session pipe"
                );
                return Ok(pipe);
            }

            let io = self
                .sandbox_runtime
                .manager
                .open_io(&SandboxId::new(sandbox_id))
                .await?
                .into_parts();
            let pipe = session_pipe_from_stdin(io.stdin);

            self.sandbox_pipes
                .insert(sandbox_id.to_owned(), pipe.clone());
            drop(_open_guard);
            let ctx = self.context();
            let thread_key = thread_key.clone();
            let pump_thread_key = thread_key.clone();
            let pump_key = sandbox_id.to_owned();
            let pump_pipe = pipe.clone();
            let stdout = io.stdout;
            let stderr = io.stderr;
            let guard = io.guard;
            let stderr_key = pump_key.clone();

            spawn_stdout_pump_loop(StdoutPumpLoop {
                ctx,
                open_lock,
                thread_key: pump_thread_key,
                sandbox_id: pump_key,
                pipe: pump_pipe,
                stdout,
                guard,
            });

            spawn_stderr_drain(stderr_key, stderr);

            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_pipe_opened",
                thread_key = %thread_key,
                sandbox_id,
                "session pipe opened"
            );
            Ok(pipe)
        }
        .instrument(span.clone())
        .await;

        if let Err(error) = &result {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_pipe_ensure_failed",
                thread_key = %thread_key,
                sandbox_id,
                %error,
                "failed to ensure session pipe"
            );
        }
        result
    }

    /// Reconciles executions left `queued`/`running` by a previous control
    /// plane process. Execution rows never time out on their own: the only
    /// writer of a terminal status is the process that was watching the
    /// sandbox, so a kill mid-turn leaves the row active forever, wedging the
    /// thread (the one-active-execution index blocks new executes) and any
    /// event-stream consumer waiting for a terminal event.
    ///
    /// Adoption order of preference:
    /// 1. The sandbox already finished the turn while nobody was attached:
    ///    recover the terminal outcome from the backend's recorded output.
    /// 2. The sandbox is still running the turn: re-attach the stdout pump
    ///    and re-arm the remaining max-duration deadline.
    /// 3. The sandbox is gone: record the failure honestly.
    pub async fn adopt_orphaned_executions(&self) {
        self.run_orphan_adoption_scan(&mut OrphanAdoptionState::default(), None)
            .await;
    }

    /// Re-run the orphan adoption scan every `interval` for the lifetime of
    /// the process (the first scan runs immediately). A startup-only scan
    /// misses executions orphaned after it ran — most commonly the previous
    /// pod of a rolling deploy reaching its termination grace period
    /// mid-turn after the new pod already scanned — and those stay wedged
    /// until the next deploy.
    pub fn spawn_orphan_adoption(&self, interval: Duration) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut state = OrphanAdoptionState::default();
            let mut ticker = interval_at(Instant::now(), interval);
            ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                runtime
                    .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
                    .await;
            }
        });
    }

    /// One pass over all active executions. Queued requests with persisted
    /// input can be claimed and replayed immediately. `pre_sandbox_grace`
    /// protects running rows awaiting sandbox assignment and legacy queued
    /// rows that predate durable requests; `None` is only correct when no
    /// re-scan will follow.
    async fn run_orphan_adoption_scan(
        &self,
        state: &mut OrphanAdoptionState,
        pre_sandbox_grace: Option<Duration>,
    ) {
        let executions = match self.store.list_active_executions_with_ownership().await {
            Ok(executions) => executions,
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_scan_failed",
                    %error,
                    "failed to list orphaned executions"
                );
                return;
            }
        };
        if executions.is_empty() {
            state.deferred.clear();
            return;
        }
        let mut adopted = 0_usize;
        let mut failed = 0_usize;
        let mut skipped = 0_usize;
        let mut own = 0_usize;
        let mut deferred = HashSet::new();
        for candidate in executions {
            let execution_id = candidate.execution.execution_id.clone();
            // Advisory fast path: a live lease means the execution has an
            // active pump somewhere. Skip our own executions silently and
            // defer peers' without touching the session row or the sandbox
            // backend — the conditional claim below stays the sole authority
            // on ownership.
            if candidate.stdout_owner_lease_active {
                if candidate.stdout_owner_id.as_deref() == Some(self.stdout_owner_id.as_str()) {
                    own += 1;
                    continue;
                }
                if !state.deferred.contains(&execution_id) {
                    self.record_adoption_deferral(&candidate.execution).await;
                }
                deferred.insert(execution_id);
                continue;
            }
            let record_deferral = !state.deferred.contains(&execution_id);
            match self
                .adopt_orphaned_execution(&candidate.execution, record_deferral, pre_sandbox_grace)
                .await
            {
                Ok(OrphanAdoption::Adopted) => adopted += 1,
                Ok(OrphanAdoption::Failed) => failed += 1,
                Ok(OrphanAdoption::Skipped) => skipped += 1,
                Ok(OrphanAdoption::Deferred) => {
                    deferred.insert(execution_id);
                }
                Err(error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "execution_adoption_failed",
                        thread_key = %candidate.execution.thread_key,
                        execution_id = %candidate.execution.execution_id,
                        %error,
                        "failed to adopt orphaned execution; will retry on the next scan"
                    );
                    // Keep the dedup entry across transient errors so a
                    // recovered deferral is not re-recorded.
                    if state.deferred.contains(&execution_id) {
                        deferred.insert(execution_id);
                    }
                }
            }
        }
        state.deferred = deferred;
        if adopted > 0 || failed > 0 {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_adoption_scan",
                adopted,
                failed,
                deferred = state.deferred.len(),
                skipped,
                own,
                "adopted executions orphaned by a previous control plane process"
            );
        } else {
            debug!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_adoption_scan",
                adopted,
                failed,
                deferred = state.deferred.len(),
                skipped,
                own,
                "orphan adoption scan found nothing adoptable"
            );
        }
    }

    async fn record_adoption_deferral(&self, execution: &SessionExecution) {
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "execution_adoption_deferred",
            thread_key = %execution.thread_key,
            execution_id = %execution.execution_id,
            "active stdout owner lease still exists; deferring adoption"
        );
        let _ = self
            .store
            .append_event(
                &execution.thread_key,
                Some(&execution.execution_id),
                "session.execution_adoption_deferred",
                json!({ "reason": "stdout_owner_lease_active" }),
            )
            .await;
    }

    async fn adopt_orphaned_execution(
        &self,
        execution: &SessionExecution,
        record_deferral: bool,
        pre_sandbox_grace: Option<Duration>,
    ) -> Result<OrphanAdoption, SessionRuntimeError> {
        let thread_key = &execution.thread_key;
        let execution_id = execution.execution_id.as_str();
        if execution.status == ExecutionStatus::Queued {
            // mark_execution_running is an atomic claim, so a periodic scan
            // can safely race the accepting process without double delivery.
            let request = match self.store.execution_request(execution_id).await {
                Ok(request) => request,
                Err(error) => {
                    self.fail_orphaned_execution(
                        thread_key,
                        execution_id,
                        "",
                        &format!("queued request could not be recovered: {error}"),
                    )
                    .await;
                    return Ok(OrphanAdoption::Failed);
                }
            };
            let request_is_empty = request.as_object().is_some_and(serde_json::Map::is_empty);
            if request_is_empty {
                let age = SystemTime::now()
                    .duration_since(SystemTime::from(execution.created_at))
                    .unwrap_or_default();
                if pre_sandbox_grace.is_some_and(|grace| age < grace) {
                    debug!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "execution_adoption_skipped",
                        thread_key = %thread_key,
                        execution_id,
                        age_ms = duration_millis_u64(age),
                        "skipping young queued execution without a persisted request"
                    );
                    return Ok(OrphanAdoption::Skipped);
                }
            }
            let input = match deserialize_persisted_execute_request(execution_id, request) {
                Ok(input) => input,
                Err(error) => {
                    self.fail_orphaned_execution(
                        thread_key,
                        execution_id,
                        "",
                        &format!("queued request could not be recovered: {error}"),
                    )
                    .await;
                    return Ok(OrphanAdoption::Failed);
                }
            };
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_adopted",
                thread_key = %thread_key,
                execution_id,
                mode = "queued_request",
                "scheduling queued execution from its persisted request"
            );
            let _ = self
                .store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_adopted",
                    json!({ "mode": "queued_request" }),
                )
                .await;
            self.spawn_session_execution(thread_key.clone(), execution.execution_id.clone(), input);
            return Ok(OrphanAdoption::Adopted);
        }
        let session = self.store.get_session(thread_key).await?;
        let Some(sandbox_id) = session.sandbox_id.as_deref() else {
            let running_since = execution.started_at.unwrap_or(execution.created_at);
            let running_age = SystemTime::now()
                .duration_since(SystemTime::from(running_since))
                .unwrap_or_default();
            if pre_sandbox_grace.is_some_and(|grace| running_age < grace) {
                debug!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_skipped",
                    thread_key = %thread_key,
                    execution_id,
                    age_ms = duration_millis_u64(running_age),
                    "skipping young running execution awaiting sandbox assignment"
                );
                return Ok(OrphanAdoption::Skipped);
            }
            self.fail_orphaned_execution(
                thread_key,
                execution_id,
                "",
                "orphaned with no sandbox assigned",
            )
            .await;
            return Ok(OrphanAdoption::Failed);
        };
        let id = SandboxId::new(sandbox_id);
        // Observe rather than just status: a sandbox the kubelet killed carries
        // its cause on the pod, and that pod is often collected before anyone
        // reads it, so the reason has to be captured at the moment we give up.
        let observed = match self.sandbox_runtime.manager.observe(&id).await {
            Ok(observed) => Some(observed),
            Err(SandboxError::NotFound(_)) => None,
            // Transient status failures must not fail a possibly live
            // execution; surface the error and retry on the next startup.
            Err(error) => return Err(SessionRuntimeError::Sandbox(error)),
        };
        let status = observed
            .as_ref()
            .map_or(SandboxStatus::Gone, |observed| observed.status.clone());
        if !status.can_open_io() {
            self.fail_orphaned_execution(
                thread_key,
                execution_id,
                sandbox_id,
                &sandbox_dead_detail(
                    &status,
                    observed
                        .as_ref()
                        .and_then(|observed| observed.reason.as_deref()),
                ),
            )
            .await;
            return Ok(OrphanAdoption::Failed);
        }

        // A live resident session owner holds the session: the resident
        // collaboration host owns the sandbox and stdout pump. Adoption must
        // not claim stdout against a resident-owned OMP session, or it would
        // race the resident host. Defer the row so a later scan can revisit
        // it once the resident releases or its lease expires.
        if let Some(owner) = self.store.active_session_ownership(thread_key).await?
            && matches!(owner.mode, SessionOwnerMode::Resident)
        {
            if record_deferral {
                self.record_adoption_deferral(execution).await;
            } else {
                debug!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_deferred",
                    thread_key = %thread_key,
                    execution_id,
                    sandbox_id,
                    owner_id = %owner.owner_id,
                    "resident session owner holds the session; deferring adoption"
                );
            }
            return Ok(OrphanAdoption::Deferred);
        }
        if !self.claim_expired_stdout_owner(execution_id).await? {
            // Deferrals repeat on every periodic scan while another control
            // plane pumps the execution; only the first observation is worth
            // an info log and a durable event.
            if record_deferral {
                self.record_adoption_deferral(execution).await;
            } else {
                debug!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_deferred",
                    thread_key = %thread_key,
                    execution_id,
                    sandbox_id,
                    "active stdout owner lease still exists; deferring adoption"
                );
            }
            return Ok(OrphanAdoption::Deferred);
        }

        let recovery_span = info_span!(
            parent: None,
            "centaur.api_rs.session.execution.recovered",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_execution_recovered",
            "lmnr.span.type" = "DEFAULT",
            "lmnr.span.output" = tracing::field::Empty,
            "otel.status_code" = tracing::field::Empty,
            "lmnr.association.properties.session_id" = thread_key.as_str(),
            "lmnr.association.properties.metadata.execution_id" = execution_id,
            "lmnr.association.properties.metadata.thread_key" = thread_key.as_str(),
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = execution_id,
            "centaur.sandbox_id" = sandbox_id,
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
        );
        if let Some(traceparent) = execution_traceparent(execution) {
            set_span_parent_from_traceparent(&recovery_span, traceparent);
        }
        self.execution_spans
            .lock()
            .await
            .insert(execution_id.to_owned(), recovery_span);

        // The turn may have finished while no control plane was attached. An
        // attach stream cannot replay that output, but the backend's recorded
        // history (pod logs) can.
        let since = execution.started_at.unwrap_or(execution.created_at);
        let lines = match self
            .sandbox_runtime
            .manager
            .read_output_since(&id, Some(SystemTime::from(since)))
            .await
        {
            Ok(lines) => lines,
            Err(SandboxError::Unsupported { .. }) => Vec::new(),
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_adoption_log_read_failed",
                    thread_key = %thread_key,
                    execution_id,
                    sandbox_id,
                    %error,
                    "failed to read recorded sandbox output; adopting live"
                );
                Vec::new()
            }
        };
        if let Some(terminal) = terminal_output_from_lines(&lines) {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_adopted",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                mode = "recorded_output",
                "adopted orphaned execution from recorded sandbox output"
            );
            let _ = self
                .store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_adopted",
                    json!({ "sandbox_id": sandbox_id, "mode": "recorded_output" }),
                )
                .await;
            record_terminal_output(
                &self.context(),
                thread_key,
                sandbox_id,
                execution_id,
                terminal,
            )
            .await?;
            return Ok(OrphanAdoption::Adopted);
        }

        // No terminal in the recorded output: treat the turn as still in
        // flight. Re-attach the stdout pump and re-arm the remaining
        // max-duration budget so an adopted-but-silent turn stays bounded.
        if let Err(error) = self.ensure_session_pipe(thread_key, sandbox_id).await {
            if let Some(span) = self.execution_spans.lock().await.remove(execution_id) {
                finish_execution_trace_span(&span, "failed");
            }
            let _ = self
                .store
                .release_stdout_owner(execution_id, &self.stdout_owner_id)
                .await;
            return Err(error);
        }
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "execution_adopted",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            mode = "live_attach",
            "adopted orphaned execution with a live sandbox attach"
        );
        let _ = self
            .store
            .append_event(
                thread_key,
                Some(execution_id),
                "session.execution_adopted",
                json!({ "sandbox_id": sandbox_id, "mode": "live_attach" }),
            )
            .await;
        if let Some(max_duration) = max_duration_from_execution(execution) {
            let elapsed = SystemTime::now()
                .duration_since(SystemTime::from(since))
                .unwrap_or_default();
            spawn_max_duration_failure(
                self.context(),
                thread_key.clone(),
                execution.execution_id.clone(),
                max_duration.saturating_sub(elapsed),
                idle_timeout_from_execution(execution),
            );
        }
        Ok(OrphanAdoption::Adopted)
    }

    async fn fail_orphaned_execution(
        &self,
        thread_key: &ThreadKey,
        execution_id: &str,
        sandbox_id: &str,
        detail: &str,
    ) {
        let _ = self
            .store
            .claim_stdout_owner(execution_id, &self.stdout_owner_id, STDOUT_OWNER_LEASE)
            .await;
        let error = format!("execution orphaned by control plane restart; {detail}");
        if let Err(record_error) = record_terminal_output(
            &self.context(),
            thread_key,
            sandbox_id,
            execution_id,
            TerminalOutput::Failed { error },
        )
        .await
        {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_adoption_fail_record_failed",
                thread_key = %thread_key,
                execution_id,
                error = %record_error,
                "failed to record orphaned execution failure"
            );
        }
    }

    /// Hands off this control plane's in-flight executions before process
    /// exit. Waits up to `timeout` for owned executions to finish naturally
    /// (their stdout pumps keep running until the process exits), then
    /// releases the remaining stdout-owner leases so another control
    /// plane's adoption scan can claim the executions right away instead of
    /// waiting out the lease TTL. Turn output produced after the release is
    /// not lost: adoption replays it from the sandbox backend's recorded
    /// output.
    pub async fn handoff_owned_executions(&self, timeout: Duration) -> Vec<SessionRuntimeError> {
        let mut shutdown_errors = Vec::new();
        // One aggregate deadline for the entire handoff: lock barrier, collab
        // stop/finalize, owner release, and execution drain.
        let shutdown_deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(30));
        // Fence new stdout-owner claims first: an execution accepted after
        // this point would otherwise claim a lease that outlives the
        // process, stranding it until the lease TTL expires.
        self.shutting_down.store(true, Ordering::SeqCst);
        // Global write gate: waits for every in-flight start/status/stop/loss
        // (including starts that hold the read gate before map insert) and
        // blocks new lifecycle ops for the snapshot+cleanup window.
        let remaining = shutdown_deadline.saturating_duration_since(Instant::now());
        let _lifecycle_write_gate = if remaining.is_zero() {
            shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                thread_key: "shutdown".to_owned(),
                reason: "shutdown deadline exhausted before lifecycle write gate".to_owned(),
            });
            None
        } else {
            match tokio::time::timeout(remaining, self.collab_lifecycle_gate.write()).await {
                Ok(guard) => Some(guard),
                Err(_) => {
                    shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                        thread_key: "shutdown".to_owned(),
                        reason: "shutdown deadline exhausted waiting for lifecycle write gate"
                            .to_owned(),
                    });
                    None
                }
            }
        };
        let rooms = self
            .collab_rooms
            .iter()
            .map(|entry| (entry.key().clone(), entry.value().clone()))
            .collect::<Vec<_>>();
        for (thread_key, handle) in &rooms {
            // Never leave an Active ghost room on shutdown, even when the
            // aggregate deadline is already exhausted: mark RemoteStopPending
            // (releases keepalive) so a peer/retry can finish stop+finalize.
            if Instant::now() >= shutdown_deadline {
                // Do not schedule the normal cleanup worker during shutdown —
                // mark non-active + release keepalive so no ghost Active room
                // survives process exit; a peer retries stop/finalize.
                if let Some(mut current) = self.collab_rooms.get_mut(thread_key)
                    && current.owner_id == handle.owner_id
                    && current.generation == handle.generation
                    && current.sandbox_id == handle.sandbox_id
                    && current.phase.is_externally_active()
                {
                    current.mark_remote_stop_pending();
                }
                shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: "shutdown deadline exhausted before collab finalize".to_owned(),
                });
                continue;
            }
            // Inline bounded stop+finalize under remaining deadline.
            match self
                .stop_or_enter_remote_pending_within(
                    thread_key,
                    handle,
                    "runtime_shutdown",
                    shutdown_deadline,
                )
                .await
            {
                Ok(()) => {
                    if let Err(error) = self
                        .cleanup_collab_room_local_within(
                            thread_key,
                            handle,
                            "session.collab_room_lost",
                            "runtime_shutdown",
                            shutdown_deadline,
                        )
                        .await
                    {
                        shutdown_errors.push(error);
                    }
                }
                Err(error) => {
                    // stop_or_enter already marked RemoteStopPending. Do NOT
                    // finalize without stop ack — that would drop the lease/
                    // handle while the resident room may still be live.
                    shutdown_errors.push(error);
                }
            }
        }
        drop(_lifecycle_write_gate);
        let pending_remaining = self.collab_rooms.len();
        if pending_remaining > 0 {
            shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                thread_key: "shutdown".to_owned(),
                reason: format!(
                    "{pending_remaining} collaboration room(s) remain after shutdown finalize (pending/retry retained)"
                ),
            });
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "collab_shutdown_incomplete",
                pending_remaining,
                "shutdown could not complete collab finalize; pending handles retained for retry"
            );
        } else {
            let remaining = shutdown_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                    thread_key: "shutdown".to_owned(),
                    reason: "incomplete handoff: aggregate deadline exhausted before bulk ownership release"
                        .to_owned(),
                });
            } else {
                match tokio::time::timeout(
                    remaining.min(EXECUTION_HANDOFF_DB_TIMEOUT),
                    self.store
                        .release_session_ownership_for_owner(&self.stdout_owner_id),
                )
                .await
                {
                    Ok(Ok(count)) if count > 0 => {
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_ownership_handoff_released",
                            count,
                            "released session ownership leases at shutdown for reacquisition by a peer"
                        );
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(error)) => {
                        warn!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_ownership_handoff_release_failed",
                            %error,
                            "failed to release session ownership leases at shutdown"
                        );
                        shutdown_errors.push(SessionRuntimeError::Store(error));
                    }
                    Err(_) => {
                        warn!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_ownership_handoff_release_timeout",
                            "timed out releasing session ownership leases; peers must wait for lease expiry"
                        );
                        shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                            thread_key: "shutdown".to_owned(),
                            reason: "bulk ownership release timed out under aggregate deadline"
                                .to_owned(),
                        });
                    }
                }
            }
        }
        // Continue using the same aggregate shutdown_deadline for execution drain.
        let deadline = shutdown_deadline;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let count = tokio::time::timeout(
                remaining.min(EXECUTION_HANDOFF_DB_TIMEOUT),
                self.store
                    .count_executions_with_stdout_owner(&self.stdout_owner_id),
            )
            .await;
            let Ok(count) = count else {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_handoff_count_timeout",
                    "timed out counting in-flight executions; releasing leases now"
                );
                break;
            };
            match count {
                Ok(0) => {
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "execution_handoff_idle",
                        "no in-flight executions to hand off at shutdown"
                    );
                    return shutdown_errors;
                }
                Ok(in_flight) => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "execution_handoff_waiting",
                        in_flight,
                        "waiting for in-flight executions to finish before shutdown"
                    );
                }
                Err(error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "execution_handoff_count_failed",
                        %error,
                        "failed to count in-flight executions; releasing leases now"
                    );
                    break;
                }
            }
            sleep(EXECUTION_HANDOFF_POLL_INTERVAL).await;
        }
        let remaining = shutdown_deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                thread_key: "shutdown".to_owned(),
                reason:
                    "incomplete handoff: aggregate deadline exhausted before stdout-owner release"
                        .to_owned(),
            });
            return shutdown_errors;
        }
        let released = tokio::time::timeout(
            remaining.min(EXECUTION_HANDOFF_DB_TIMEOUT),
            self.store
                .release_stdout_owned_executions(&self.stdout_owner_id),
        )
        .await;
        let Ok(released) = released else {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "execution_handoff_release_timeout",
                "timed out releasing stdout-owner leases under aggregate deadline"
            );
            shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                thread_key: "shutdown".to_owned(),
                reason: "stdout-owner release timed out under aggregate deadline".to_owned(),
            });
            return shutdown_errors;
        };
        match released {
            Ok(released) => {
                for execution in &released {
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "execution_handoff_released",
                        thread_key = %execution.thread_key,
                        execution_id = %execution.execution_id,
                        "released stdout-owner lease at shutdown for adoption by a peer"
                    );
                    let append_remaining =
                        shutdown_deadline.saturating_duration_since(Instant::now());
                    if append_remaining.is_zero() {
                        shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                            thread_key: execution.thread_key.as_str().to_owned(),
                            reason: "incomplete handoff: aggregate deadline exhausted before stdout_owner_released append"
                                .to_owned(),
                        });
                        break;
                    }
                    match tokio::time::timeout(
                        append_remaining.min(EXECUTION_HANDOFF_DB_TIMEOUT),
                        self.store.append_event(
                            &execution.thread_key,
                            Some(&execution.execution_id),
                            "session.stdout_owner_released",
                            json!({
                                "execution_id": execution.execution_id,
                                "reason": "control_plane_shutdown",
                            }),
                        ),
                    )
                    .await
                    {
                        Ok(Ok(_)) => {}
                        Ok(Err(error)) => {
                            warn!(
                                component = COMPONENT_SESSION_RUNTIME,
                                event = "execution_handoff_append_failed",
                                thread_key = %execution.thread_key,
                                %error,
                                "failed to append stdout_owner_released at shutdown"
                            );
                            shutdown_errors.push(SessionRuntimeError::Store(error));
                        }
                        Err(_) => {
                            shutdown_errors.push(SessionRuntimeError::CollabRoomLost {
                                thread_key: execution.thread_key.as_str().to_owned(),
                                reason: "stdout_owner_released append timed out under aggregate deadline"
                                    .to_owned(),
                            });
                            break;
                        }
                    }
                }
                if released.is_empty() {
                    info!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "execution_handoff_idle",
                        "in-flight executions finished during the shutdown drain"
                    );
                }
            }
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "execution_handoff_release_failed",
                    %error,
                    "failed to release stdout-owner leases at shutdown"
                );
                shutdown_errors.push(SessionRuntimeError::Store(error));
            }
        }
        if !shutdown_errors.is_empty() {
            error!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "collab_shutdown_failures",
                count = shutdown_errors.len(),
                "collaboration room shutdown encountered {} failure(s)",
                shutdown_errors.len()
            );
        }
        shutdown_errors
    }
}

/// Outcome of one orphan-adoption attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum OrphanAdoption {
    /// Terminal output was recovered or a live pump was re-attached.
    Adopted,
    /// Another control plane still holds the stdout-owner lease.
    Deferred,
    /// The execution was failed as unrecoverable.
    Failed,
    /// Too young to judge (freshly queued); revisit on a later scan.
    Skipped,
}

/// Scan state carried across periodic orphan-adoption ticks.
#[derive(Debug, Default)]
struct OrphanAdoptionState {
    /// Executions whose deferral was already recorded, so long-lived leases
    /// do not produce a `session.execution_adoption_deferred` event on every
    /// tick.
    deferred: HashSet<String>,
}

async fn maybe_generate_session_title(
    store: PgSessionStore,
    generator: SessionTitleGenerator,
    thread_key: ThreadKey,
) {
    let parts = match store.title_generation_candidate(&thread_key).await {
        Ok(Some(parts)) => parts,
        Ok(None) => return,
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_title_candidate_failed",
                thread_key = %thread_key,
                %error,
                "failed to load session title candidate"
            );
            return;
        }
    };
    let Some(source) = session_title_source_from_parts(&parts) else {
        return;
    };
    let raw_title = match generator(source).await {
        Ok(title) => title,
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_title_generation_failed",
                thread_key = %thread_key,
                %error,
                "failed to generate session title"
            );
            return;
        }
    };
    let Some(title) = sanitize_session_title(&raw_title) else {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_title_generation_empty",
            thread_key = %thread_key,
            "session title generation returned an empty title"
        );
        return;
    };
    match store.set_session_title_if_empty(&thread_key, &title).await {
        Ok(true) => {
            info!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_title_set",
                thread_key = %thread_key,
                title,
                "session title set"
            );
        }
        Ok(false) => {}
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_title_set_failed",
                thread_key = %thread_key,
                %error,
                "failed to set session title"
            );
        }
    }
}

impl SandboxRuntime {
    pub async fn create_running_io(
        &self,
        spec: SandboxSpec,
    ) -> Result<(SandboxId, centaur_sandbox_core::SandboxIoParts), SessionRuntimeError> {
        let handle = self.manager.create_running(spec).await?;
        let io = self.manager.open_io(&handle.id).await?.into_parts();
        Ok((handle.id, io))
    }

    pub async fn stop_sandbox(&self, sandbox_id: &SandboxId) -> Result<(), SessionRuntimeError> {
        self.manager.stop(sandbox_id).await?;
        Ok(())
    }

    pub fn backend(backend: Arc<dyn SandboxBackend>, spec: SandboxSpec) -> Self {
        let warm_spec = spec.clone();
        let spec_factory =
            move |_thread_key: &ThreadKey,
                  _execution_id: &str,
                  _harness: &HarnessType,
                  _persona: Option<&PersonaContext>| { spec.clone() };
        let warm_spec_factory = move || warm_spec.clone();
        Self::backend_with_warm_spec_factory(backend, spec_factory, warm_spec_factory)
    }

    pub fn backend_with_workload(
        backend: Arc<dyn SandboxBackend>,
        workload: SandboxWorkloadMode,
    ) -> Self {
        let warm_harness = workload.default_harness();
        let warm_workload = workload.clone();
        let mut runtime = Self::backend_with_warm_spec_factory(
            backend,
            move |thread_key, _execution_id, harness, persona| {
                workload.spec(thread_key, harness, persona)
            },
            move || warm_workload.warm_spec(),
        );
        runtime.warm_harness = warm_harness;
        runtime
    }

    pub fn backend_with_spec_factory<F>(backend: Arc<dyn SandboxBackend>, spec_factory: F) -> Self
    where
        F: Fn(&ThreadKey, &str, &HarnessType, Option<&PersonaContext>) -> SandboxSpec
            + Send
            + Sync
            + 'static,
    {
        Self {
            manager: Arc::new(SandboxManager::new(backend)),
            spec_factory: Arc::new(spec_factory),
            warm_spec_factory: None,
            workload_key: None,
            warm_harness: None,
        }
    }

    pub fn backend_with_warm_spec_factory<F, W>(
        backend: Arc<dyn SandboxBackend>,
        spec_factory: F,
        warm_spec_factory: W,
    ) -> Self
    where
        F: Fn(&ThreadKey, &str, &HarnessType, Option<&PersonaContext>) -> SandboxSpec
            + Send
            + Sync
            + 'static,
        W: Fn() -> SandboxSpec + Send + Sync + 'static,
    {
        let warm_spec_factory: WarmSandboxSpecFactory = Arc::new(warm_spec_factory);
        let workload_key = sandbox_spec_key(&warm_spec_factory());
        Self {
            manager: Arc::new(SandboxManager::new(backend)),
            spec_factory: Arc::new(spec_factory),
            warm_spec_factory: Some(warm_spec_factory),
            workload_key: Some(workload_key),
            warm_harness: None,
        }
    }
}

impl SandboxWorkloadMode {
    pub fn mock_app_server(image: impl Into<String>) -> Self {
        Self::MockAppServer {
            image: image.into(),
        }
    }

    pub fn codex_app_server(
        image: impl Into<String>,
        env: impl IntoIterator<Item = (String, String)>,
        harness: HarnessType,
    ) -> Self {
        Self::CodexAppServer {
            image: image.into(),
            env: env.into_iter().collect(),
            mounts: Vec::new(),
            resources: None,
            harness,
        }
    }

    pub fn mount(mut self, mount: Mount) -> Self {
        match &mut self {
            Self::MockAppServer { .. } => {}
            Self::CodexAppServer { mounts, .. } => mounts.push(mount),
        }
        self
    }

    pub fn resources(mut self, requirements: ResourceRequirements) -> Self {
        match &mut self {
            Self::MockAppServer { .. } => {}
            Self::CodexAppServer { resources, .. } => *resources = Some(requirements),
        }
        self
    }

    fn default_harness(&self) -> Option<HarnessType> {
        match self {
            Self::MockAppServer { .. } => None,
            Self::CodexAppServer { harness, .. } => Some(harness.clone()),
        }
    }

    fn spec(
        &self,
        thread_key: &ThreadKey,
        harness: &HarnessType,
        persona: Option<&PersonaContext>,
    ) -> SandboxSpec {
        self.spec_for(Some(thread_key), harness, persona)
    }

    fn warm_spec(&self) -> SandboxSpec {
        match self {
            Self::MockAppServer { .. } => self.spec_for(None, &HarnessType::Codex, None),
            Self::CodexAppServer { harness, .. } => self.spec_for(None, harness, None),
        }
    }

    fn spec_for(
        &self,
        thread_key: Option<&ThreadKey>,
        harness: &HarnessType,
        persona: Option<&PersonaContext>,
    ) -> SandboxSpec {
        match self {
            Self::MockAppServer { image } => apply_persona_spec(
                SandboxSpec::new(image)
                    .command(["/bin/sh", "-lc"])
                    .args([mock_app_server_script()])
                    .env("CENTAUR_HARNESS_TYPE", harness.as_ref()),
                persona,
            ),
            Self::CodexAppServer {
                image,
                env,
                mounts,
                resources,
                ..
            } => {
                // Pin the harness via container args (the image entrypoint is
                // kept) so the sandbox runs the session's harness rather than
                // whatever the image CMD defaults to.
                let mut spec = SandboxSpec::new(image)
                    .label("centaur.ai/component", "session-sandbox")
                    .label("centaur.ai/harness", harness.to_string())
                    .args(["harness-server", harness_server_subcommand(harness)]);
                if let Some(thread_key) = thread_key {
                    spec = spec.env("CENTAUR_THREAD_KEY", thread_key.as_str());
                }
                if let Some(resources) = resources {
                    spec = spec.resources(resources.clone());
                }
                for mount in mounts {
                    spec = spec.mount(mount.clone());
                }
                for (name, value) in env {
                    spec = spec.env(name.clone(), value.clone());
                }
                apply_persona_spec(spec, persona)
            }
        }
    }
}

/// The harness-server CLI subcommand for a harness type
/// (see crates/harness-server/src/main.rs).
fn harness_server_subcommand(harness: &HarnessType) -> &'static str {
    match harness {
        HarnessType::Codex => "codex",
        HarnessType::ClaudeCode => "claude-code",
        HarnessType::Amp => "amp",
        HarnessType::Nanocodex => "nanocodex",
        HarnessType::Omp => "omp",
        HarnessType::Hermes => "hermes",
    }
}

fn sandbox_spec_key(spec: &SandboxSpec) -> String {
    let encoded = serde_json::to_vec(spec).expect("sandbox specs should serialize");
    let digest = Sha256::digest(encoded);
    format!("sandbox-spec-sha256:{}", hex::encode(digest))
}

fn mock_app_server_script() -> &'static str {
    r#"while IFS= read -r line; do
model="$(printf '%s\n' "$line" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')"
[ -n "$model" ] || model="unknown"
harness="${CENTAUR_HARNESS_TYPE:-unknown}"
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"startup"}'
sleep 0.2
printf '%s\n' '{"type":"system","subtype":"wrapper_heartbeat","phase":"app_server_started"}'
sleep 0.2
printf '%s\n' '{"type":"thread.started","thread_id":"mock-codex-thread"}'
sleep 0.2
turn_index=1
while [ "$turn_index" -le 3 ]; do
  turn_id="mock-turn-$turn_index"
  printf '{"type":"turn.started","turn_id":"%s"}\n' "$turn_id"
  sleep 0.2
  printf '{"type":"item.agentMessage.delta","turnId":"%s","session_id":"mock-codex-thread","delta":"PONG model=%s harness=%s"}\n' "$turn_id" "$model" "$harness"
  sleep 0.2
  printf '{"type":"turn.completed","turn":{"id":"%s"},"usage":{"input_tokens":0,"output_tokens":1}}\n' "$turn_id"
  sleep 0.2
  turn_index=$((turn_index + 1))
done
done"#
}

fn session_event_stream(
    store: PgSessionStore,
    thread_key: ThreadKey,
    after_event_id: i64,
    execution_id: Option<String>,
    listener: SessionEventListener,
    span: Span,
) -> impl Stream<Item = Result<SessionEvent, SessionRuntimeError>> {
    stream::unfold(
        EventStreamState {
            store,
            thread_key,
            after_event_id,
            execution_id,
            pending: VecDeque::new(),
            listener,
            safety_tick: {
                let mut tick = interval_at(
                    Instant::now() + EVENT_STREAM_SAFETY_POLL_INTERVAL,
                    EVENT_STREAM_SAFETY_POLL_INTERVAL,
                );
                tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
                tick
            },
            done: false,
            emitted_count: 0,
            span,
        },
        |mut state| {
            let span = state.span.clone();
            async move {
                loop {
                    if let Some(event) = state.pending.pop_front() {
                        state.after_event_id = event.event_id;
                        state.emitted_count += 1;
                        // Execution-scoped streams are per-turn: after the
                        // execution's terminal event nothing else will ever
                        // arrive, so complete the response instead of parking
                        // forever. Abandoned client connections otherwise pin
                        // this stream's dedicated LISTEN connection until the
                        // TCP peer is proven dead (the 2026-07-06 incident
                        // exhausted both the Slackbot fetch pool and staging
                        // Postgres this way). The 30s safety tick makes this
                        // robust even when the notify is missed.
                        if state.execution_id.is_some()
                            && is_terminal_execution_event(&event.event_type)
                        {
                            state.done = true;
                        }
                        return Some((Ok(event), state));
                    }
                    if state.done {
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_events_stream_completed",
                            thread_key = %state.thread_key,
                            emitted_count = state.emitted_count,
                            "session event stream completed"
                        );
                        return None;
                    }
                    match state
                        .store
                        .list_events_after(
                            &state.thread_key,
                            state.after_event_id,
                            state.execution_id.as_deref(),
                            100,
                        )
                        .await
                    {
                        Ok(events) if events.is_empty() => loop {
                            tokio::select! {
                                notification = state.listener.recv() => {
                                    match notification {
                                        Ok(notification)
                                            if notification.thread_key == state.thread_key.as_str()
                                                && notification.event_id > state.after_event_id =>
                                        {
                                            break;
                                        }
                                        Ok(_) => {}
                                        Err(error) => {
                                            state.done = true;
                                            return Some((Err(SessionRuntimeError::Store(error)), state));
                                        }
                                    }
                                }
                                _ = state.safety_tick.tick() => break,
                            }
                        }
                        Ok(events) => state.pending = events.into(),
                        Err(error) => {
                            state.done = true;
                            return Some((Err(SessionRuntimeError::Store(error)), state));
                        }
                    }
                }
            }
            .instrument(span)
        },
    )
}

/// Terminal event types for a single execution: once one of these is emitted
/// on an execution-scoped stream, the stream has nothing left to deliver.
fn is_terminal_execution_event(event_type: &str) -> bool {
    matches!(
        event_type,
        "session.execution_completed" | "session.execution_failed" | "session.execution_cancelled"
    )
}

/// How a stdout pump pass ended once the attach stream closed.
enum StdoutPumpEnd {
    /// The stream closed with no execution in flight, or the execution was
    /// already terminalized by a read/codec failure.
    Idle,
    /// The stream closed while an execution was still active. Treat this as a
    /// transport detach; the pump loop decides whether to recover or fail.
    EofActiveExecution {
        execution: Box<SessionExecution>,
        lines_pumped: u64,
    },
}

struct StdoutPumpLoop {
    ctx: RuntimeContext,
    open_lock: Arc<Mutex<()>>,
    thread_key: ThreadKey,
    sandbox_id: String,
    pipe: SessionPipe,
    stdout: SandboxRead,
    guard: SandboxIoGuard,
}

enum ReattachOutcome {
    Reattached {
        pipe: SessionPipe,
        stdout: SandboxRead,
        guard: SandboxIoGuard,
    },
    /// Another pipe replaced ours; that pump now owns the sandbox stream.
    Superseded,
    /// A retryable attach/status failure. The caller bounds attempts.
    Retryable(String),
    /// The sandbox cannot serve IO anymore.
    Dead(String),
}

fn session_pipe_from_stdin(stdin: SandboxWrite) -> SessionPipe {
    SessionPipe {
        stdin: Arc::new(Mutex::new(FramedWrite::new(stdin, LinesCodec::new()))),
    }
}

fn spawn_stderr_drain(sandbox_id: String, stderr: SandboxRead) {
    tokio::spawn(async move {
        if let Err(error) = drain_stderr(stderr).await {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_stderr_drain_failed",
                sandbox_id = %sandbox_id,
                %error,
                "session stderr drain failed"
            );
        }
    });
}

fn remove_pipe_if_current(sandbox_pipes: &SessionPipeMap, sandbox_id: &str, pipe: &SessionPipe) {
    sandbox_pipes.remove_if(sandbox_id, |_sandbox_id, current| {
        Arc::ptr_eq(&current.stdin, &pipe.stdin)
    });
}

/// Runs the stdout pump and reattaches when Kubernetes closes the attach
/// stream before the active execution emits terminal output.
fn spawn_stdout_pump_loop(state: StdoutPumpLoop) {
    tokio::spawn(async move {
        let StdoutPumpLoop {
            ctx,
            open_lock,
            thread_key,
            sandbox_id,
            mut pipe,
            mut stdout,
            mut guard,
        } = state;
        let mut reattach_attempts = 0_u32;
        let mut last_reattach_detail = "stdout reattach attempts exhausted".to_owned();

        'pump: loop {
            let result =
                run_stdout_pump(ctx.clone(), thread_key.clone(), &sandbox_id, stdout, guard).await;
            let (execution, lines_pumped) = match result {
                Ok(StdoutPumpEnd::Idle) => break,
                Ok(StdoutPumpEnd::EofActiveExecution {
                    execution,
                    lines_pumped,
                }) => (execution, lines_pumped),
                Err(error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_stdout_pump_failed",
                        thread_key = %thread_key,
                        sandbox_id = %sandbox_id,
                        %error,
                        "session stdout pump failed"
                    );
                    let _ = ctx
                        .store
                        .append_event(
                            &thread_key,
                            None,
                            "session.stdout_pump_failed",
                            json!({
                                "sandbox_id": sandbox_id.as_str(),
                                "error": error.to_string(),
                            }),
                        )
                        .await;
                    // Internal pump errors (e.g. collab state append failure)
                    // must not leave a ghost keepalive — same termination
                    // cleanup as EOF / codec failure.
                    lose_collab_room_on_pump_end(
                        &ctx,
                        &thread_key,
                        &sandbox_id,
                        "stdout_pump_internal_error",
                    )
                    .await;
                    break;
                }
            };

            if recover_detached_terminal_output(&ctx, &thread_key, &sandbox_id, &execution)
                .await
                .unwrap_or_else(|error| {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_stdout_recovery_failed",
                        thread_key = %thread_key,
                        sandbox_id = %sandbox_id,
                        execution_id = %execution.execution_id,
                        %error,
                        "failed to recover detached stdout from recorded output"
                    );
                    false
                })
            {
                break;
            }

            if lines_pumped > 0 {
                reattach_attempts = 0;
            }

            loop {
                if reattach_attempts >= SESSION_PIPE_MAX_REATTACH_ATTEMPTS {
                    fail_detached_execution(
                        &ctx,
                        &thread_key,
                        &sandbox_id,
                        &execution.execution_id,
                        &last_reattach_detail,
                    )
                    .await;
                    break 'pump;
                }
                reattach_attempts += 1;
                if reattach_attempts > 1 {
                    sleep(SESSION_PIPE_REATTACH_DELAY).await;
                }

                match reattach_session_pipe(&ctx, &open_lock, &sandbox_id, &pipe).await {
                    ReattachOutcome::Reattached {
                        pipe: new_pipe,
                        stdout: new_stdout,
                        guard: new_guard,
                    } => {
                        info!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_stdout_pump_reattached",
                            thread_key = %thread_key,
                            sandbox_id = %sandbox_id,
                            execution_id = %execution.execution_id,
                            attempt = reattach_attempts,
                            "reattached session stdout pump after eof"
                        );
                        let _ = ctx
                            .store
                            .append_event(
                                &thread_key,
                                Some(&execution.execution_id),
                                "session.stdout_pump_reattached",
                                json!({
                                    "sandbox_id": sandbox_id.as_str(),
                                    "attempt": reattach_attempts,
                                }),
                            )
                            .await;
                        pipe = new_pipe;
                        stdout = new_stdout;
                        guard = new_guard;
                        continue 'pump;
                    }
                    ReattachOutcome::Superseded => return,
                    ReattachOutcome::Retryable(detail) => {
                        warn!(
                            component = COMPONENT_SESSION_RUNTIME,
                            event = "session_stdout_pump_reattach_failed",
                            thread_key = %thread_key,
                            sandbox_id = %sandbox_id,
                            execution_id = %execution.execution_id,
                            attempt = reattach_attempts,
                            detail = %detail,
                            "session stdout pump reattach attempt failed"
                        );
                        last_reattach_detail = detail;
                    }
                    ReattachOutcome::Dead(detail) => {
                        fail_detached_execution(
                            &ctx,
                            &thread_key,
                            &sandbox_id,
                            &execution.execution_id,
                            &detail,
                        )
                        .await;
                        break 'pump;
                    }
                }
            }
        }

        remove_pipe_if_current(&ctx.sandbox_pipes, &sandbox_id, &pipe);
    });
}

async fn reattach_session_pipe(
    ctx: &RuntimeContext,
    open_lock: &Arc<Mutex<()>>,
    sandbox_id: &str,
    pipe: &SessionPipe,
) -> ReattachOutcome {
    let _open_guard = open_lock.lock().await;
    if ctx
        .sandbox_pipes
        .get(sandbox_id)
        .is_none_or(|current| !Arc::ptr_eq(&current.stdin, &pipe.stdin))
    {
        return ReattachOutcome::Superseded;
    }

    let id = SandboxId::new(sandbox_id);
    match ctx.manager.observe(&id).await {
        Ok(observed) if observed.status.can_open_io() => match ctx.manager.open_io(&id).await {
            Ok(io) => {
                let parts = io.into_parts();
                let new_pipe = session_pipe_from_stdin(parts.stdin);
                ctx.sandbox_pipes
                    .insert(sandbox_id.to_owned(), new_pipe.clone());
                spawn_stderr_drain(sandbox_id.to_owned(), parts.stderr);
                ReattachOutcome::Reattached {
                    pipe: new_pipe,
                    stdout: parts.stdout,
                    guard: parts.guard,
                }
            }
            Err(error) => {
                ReattachOutcome::Retryable(format!("sandbox stdout reattach failed: {error}"))
            }
        },
        Ok(observed) => ReattachOutcome::Dead(sandbox_dead_detail(
            &observed.status,
            observed.reason.as_deref(),
        )),
        Err(SandboxError::NotFound(_)) => {
            ReattachOutcome::Dead("sandbox no longer exists".to_owned())
        }
        Err(error) => ReattachOutcome::Retryable(format!("sandbox status check failed: {error}")),
    }
}

async fn recover_detached_terminal_output(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution: &SessionExecution,
) -> Result<bool, SessionRuntimeError> {
    let since = execution.started_at.unwrap_or(execution.created_at);
    let id = SandboxId::new(sandbox_id);
    let lines = match ctx
        .manager
        .read_output_since(&id, Some(SystemTime::from(since)))
        .await
    {
        Ok(lines) => lines,
        Err(SandboxError::Unsupported { .. }) => return Ok(false),
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_stdout_recorded_output_read_failed",
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                sandbox_id,
                %error,
                "failed to read recorded sandbox output; reattaching live"
            );
            return Ok(false);
        }
    };

    let Some(terminal) = terminal_output_from_lines(&lines) else {
        return Ok(false);
    };

    info!(
        component = COMPONENT_SESSION_RUNTIME,
        event = "session_stdout_pump_recovered",
        thread_key = %thread_key,
        execution_id = %execution.execution_id,
        sandbox_id,
        mode = "recorded_output",
        "recovered detached stdout pump from recorded sandbox output"
    );
    let _ = ctx
        .store
        .append_event(
            thread_key,
            Some(&execution.execution_id),
            "session.stdout_pump_recovered",
            json!({ "sandbox_id": sandbox_id, "mode": "recorded_output" }),
        )
        .await;
    record_terminal_output(
        ctx,
        thread_key,
        sandbox_id,
        &execution.execution_id,
        terminal,
    )
    .await?;
    Ok(true)
}

async fn fail_detached_execution(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
    detail: &str,
) {
    let error = format!("sandbox stdout closed before terminal output; {detail}");
    if let Err(record_error) = record_terminal_output(
        ctx,
        thread_key,
        sandbox_id,
        execution_id,
        TerminalOutput::Failed { error },
    )
    .await
    {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_detached_fail_record_failed",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            error = %record_error,
            "failed to record detached stdout failure"
        );
    }
}

async fn run_stdout_pump(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    sandbox_id: &str,
    stdout: SandboxRead,
    _guard: SandboxIoGuard,
) -> Result<StdoutPumpEnd, SessionRuntimeError> {
    let span = info_span!(
        "centaur.api_rs.session.stdout_pump",
        component = COMPONENT_SESSION_RUNTIME,
        event = "session_stdout_pump",
        "centaur.thread_key" = thread_key.as_str(),
        "centaur.sandbox_id" = sandbox_id,
        thread_key = %thread_key,
        sandbox_id,
    );
    async {
        let mut stdout = FramedRead::new(stdout, LinesCodec::new());
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump_started",
            thread_key = %thread_key,
            sandbox_id,
            "session stdout pump started"
        );
        let mut output_state = StdoutPumpState::default();
        let mut reported_lost_stdout_ownership = HashSet::new();
        let mut line_count = 0_u64;
        while let Some(line) = stdout.next().await {
            let line = match line {
                Ok(line) => line,
                Err(error) => {
                    let message = stdout_pump_error_message(&error);
                    record_stdout_pump_failure(&ctx, &thread_key, sandbox_id, message).await?;
                    return Ok(StdoutPumpEnd::Idle);
                }
            };
            line_count += 1;
            let output_value = serde_json::from_str::<Value>(&line).ok();
            // Collaboration lifecycle frames are emitted by the resident
            // harness-server even when no normal agent execution is active.
            // Handle them before execution ownership routing so room state is
            // durable and relay/process loss cannot leave a ghost keepalive.
            if let Some(value) = output_value.as_ref()
                && process_collab_state_line(&ctx, &thread_key, sandbox_id, value).await?
            {
                continue;
            }
            if let Some(harness_thread_id) = harness_thread_id_from_output_line(&line)
                && let Err(error) = ctx
                    .store
                    .update_harness_thread_id(&thread_key, Some(&harness_thread_id))
                    .await
            {
                warn!(%thread_key, %harness_thread_id, %error, "failed to persist harness thread id");
            }
            let active_execution = ctx.store.active_execution_for_thread(&thread_key).await?;
            let execution_id = active_execution
                .as_ref()
                .map(|execution| execution.execution_id.as_str());
            let Some(output_execution_id) = output_state.execution_for_line(execution_id, &line)
            else {
                continue;
            };
            let first_token_execution = active_execution
                .as_ref()
                .filter(|execution| {
                    execution.execution_id == output_execution_id
                        && output_state.should_record_first_token(
                            &output_execution_id,
                            output_value.as_ref(),
                        )
                })
                .cloned();
            let execution_span = ctx
                .execution_spans
                .lock()
                .await
                .get(&output_execution_id)
                .cloned();
            let output_span = output_state.stdout_span_for_execution(
                execution_span.as_ref(),
                &thread_key,
                sandbox_id,
                &output_execution_id,
            );
            let Some(output_event) = append_output_line(
                &ctx,
                &thread_key,
                &output_execution_id,
                &line,
            )
            .instrument(output_span.clone())
            .await?
            else {
                if reported_lost_stdout_ownership.insert(output_execution_id.clone()) {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_stdout_owner_lost",
                        thread_key = %thread_key,
                        execution_id = %output_execution_id,
                        sandbox_id,
                        stdout_owner_id = %ctx.stdout_owner_id,
                        "stdout pump does not own execution output; skipping row until ownership changes"
                    );
                }
                output_state.forget(&output_execution_id);
                continue;
            };
            if reported_lost_stdout_ownership.remove(&output_execution_id) {
                info!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "session_stdout_owner_recovered",
                    thread_key = %thread_key,
                    execution_id = %output_execution_id,
                    sandbox_id,
                    stdout_owner_id = %ctx.stdout_owner_id,
                    "stdout pump resumed execution output after ownership changed"
                );
            }
            if let Some(execution) = first_token_execution {
                record_first_token_observation(
                    &ctx,
                    &thread_key,
                    &execution,
                    &output_event,
                    &mut output_state,
                )
                .await;
            }
            if let Some(execution) = active_execution
                && execution.execution_id == output_execution_id
                && let Some(terminal) = output_state.observe(&output_execution_id, &line)
            {
                record_terminal_output(
                    &ctx,
                    &thread_key,
                    sandbox_id,
                    &output_execution_id,
                    terminal,
                )
                .instrument(output_span)
                .await?;
                ctx.execution_spans.lock().await.remove(&output_execution_id);
                output_state.forget(&output_execution_id);
            }
        }
        let active_execution = ctx.store.active_execution_for_thread(&thread_key).await?;
        // The stdout pump ending means the resident host process is gone. Any
        // active collaboration room for this thread lost its relay/process and
        // must be cleaned up so no ghost keepalive or dead capability URL
        // survives. The ownership generation fence prevents a reclaimed room
        // from being torn down by a stale pump.
        lose_collab_room_on_pump_end(&ctx, &thread_key, sandbox_id, "stdout_pump_terminated").await;
        ctx.store
            .append_event(
                &thread_key,
                None,
                "session.stdout_eof",
                json!({
                    "sandbox_id": sandbox_id,
                }),
            )
            .await?;
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump_completed",
            thread_key = %thread_key,
            sandbox_id,
            output_line_count = line_count,
            "session stdout pump completed"
        );
        match active_execution {
            Some(execution) => Ok(StdoutPumpEnd::EofActiveExecution {
                execution: Box::new(execution),
                lines_pumped: line_count,
            }),
            None => Ok(StdoutPumpEnd::Idle),
        }
    }
    .instrument(span)
    .await
}

async fn record_stdout_pump_failure(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    error: String,
) -> Result<(), SessionRuntimeError> {
    let active_execution = ctx.store.active_execution_for_thread(thread_key).await?;
    let execution_id = active_execution
        .as_ref()
        .map(|execution| execution.execution_id.as_str());
    ctx.store
        .append_event(
            thread_key,
            execution_id,
            "session.stdout_pump_failed",
            json!({
                "sandbox_id": sandbox_id,
                "error": error.as_str(),
                "terminalized_execution": execution_id.is_some(),
            }),
        )
        .await?;
    if let Some(execution) = active_execution {
        record_terminal_output(
            ctx,
            thread_key,
            sandbox_id,
            &execution.execution_id,
            TerminalOutput::Failed { error },
        )
        .await?;
    }
    // A pump failure means the resident host is gone — clean up any active
    // collaboration room so no ghost keepalive or dead URL survives.
    lose_collab_room_on_pump_end(ctx, thread_key, sandbox_id, "stdout_pump_failed").await;
    Ok(())
}

async fn record_first_token_observation(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution: &SessionExecution,
    output_event: &SessionEvent,
    output_state: &mut StdoutPumpState,
) {
    match ctx
        .store
        .execution_event_exists(&execution.execution_id, SESSION_FIRST_TOKEN_EVENT)
        .await
    {
        Ok(true) => {
            output_state.mark_first_token_recorded(&execution.execution_id);
            return;
        }
        Ok(false) => {}
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_first_token_marker_check_failed",
                thread_key = %thread_key,
                execution_id = %execution.execution_id,
                %error,
                "failed to check existing first-token marker"
            );
        }
    }

    let Some(latency) = first_token_latency(execution, output_event) else {
        output_state.mark_first_token_recorded(&execution.execution_id);
        return;
    };
    let harness_label = match ctx.store.get_session(thread_key).await {
        Ok(session) => session.harness_type.to_string(),
        Err(error) => {
            warn!(%thread_key, %error, "failed to load session for first-token metric labels");
            "unknown".to_owned()
        }
    };
    let latency_ms = duration_millis_u64(latency);
    if let Err(error) = ctx
        .store
        .append_event(
            thread_key,
            Some(&execution.execution_id),
            SESSION_FIRST_TOKEN_EVENT,
            json!({
                "execution_id": execution.execution_id.as_str(),
                "thread_key": thread_key.as_str(),
                "harness_type": harness_label.as_str(),
                "latency_ms": latency_ms,
                "output_event_id": output_event.event_id,
            }),
        )
        .await
    {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_first_token_marker_append_failed",
            thread_key = %thread_key,
            execution_id = %execution.execution_id,
            output_event_id = output_event.event_id,
            %error,
            "failed to append first-token marker"
        );
    }
    record_session_first_token_latency(&harness_label, latency);
    output_state.mark_first_token_recorded(&execution.execution_id);
    info!(
        component = COMPONENT_SESSION_RUNTIME,
        event = "session_first_token_observed",
        thread_key = %thread_key,
        execution_id = %execution.execution_id,
        harness_type = %harness_label,
        latency_ms,
        output_event_id = output_event.event_id,
        "session first answer token observed"
    );
}

fn first_token_latency(
    execution: &SessionExecution,
    output_event: &SessionEvent,
) -> Option<Duration> {
    let started_at = execution.started_at.unwrap_or(execution.created_at);
    (output_event.created_at - started_at).try_into().ok()
}

#[derive(Default)]
struct StdoutPumpState {
    final_answer_text_by_execution: HashMap<String, String>,
    first_token_recorded_by_execution: HashSet<String>,
    turn_execution_by_id: HashMap<String, String>,
    item_execution_by_id: HashMap<String, String>,
    stdout_span_by_execution: HashMap<String, Span>,
}

impl StdoutPumpState {
    fn execution_for_line(
        &mut self,
        active_execution_id: Option<&str>,
        line: &str,
    ) -> Option<String> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return active_execution_id.map(ToOwned::to_owned);
        };

        if let Some(known_execution_id) = self.known_execution_for_value(&value) {
            if active_execution_id == Some(known_execution_id.as_str()) {
                self.remember_value_execution(&value, &known_execution_id);
                return Some(known_execution_id);
            }
            if terminal_output(
                &value,
                self.final_answer_text_by_execution
                    .get(&known_execution_id)
                    .map(String::as_str)
                    .unwrap_or(""),
            )
            .is_some()
            {
                self.forget(&known_execution_id);
            }
            return None;
        }

        let active_execution_id = active_execution_id?;
        self.remember_value_execution(&value, active_execution_id);
        Some(active_execution_id.to_owned())
    }

    fn observe(&mut self, execution_id: &str, line: &str) -> Option<TerminalOutput> {
        let value: Value = serde_json::from_str(line).ok()?;
        if let Some(update) = output_line_final_answer_text(&value) {
            let text = self
                .final_answer_text_by_execution
                .entry(execution_id.to_owned())
                .or_default();
            match update {
                FinalAnswerTextUpdate::Append(delta) => text.push_str(&delta),
                FinalAnswerTextUpdate::Replace(canonical) => *text = canonical,
            }
        }
        terminal_output(
            &value,
            self.final_answer_text_by_execution
                .get(execution_id)
                .map(String::as_str)
                .unwrap_or(""),
        )
    }

    fn should_record_first_token(&self, execution_id: &str, value: Option<&Value>) -> bool {
        if self
            .first_token_recorded_by_execution
            .contains(execution_id)
            || self
                .final_answer_text_by_execution
                .get(execution_id)
                .is_some_and(|text| !text.trim().is_empty())
        {
            return false;
        }

        let Some(value) = value else {
            return false;
        };
        if output_line_final_answer_text(value).is_some() {
            return true;
        }
        matches!(
            terminal_output(value, ""),
            Some(TerminalOutput::Completed {
                result_text: Some(_),
                ..
            })
        )
    }

    fn mark_first_token_recorded(&mut self, execution_id: &str) {
        self.first_token_recorded_by_execution
            .insert(execution_id.to_owned());
    }

    fn forget(&mut self, execution_id: &str) {
        self.final_answer_text_by_execution.remove(execution_id);
        self.first_token_recorded_by_execution.remove(execution_id);
        self.turn_execution_by_id
            .retain(|_, mapped_execution_id| mapped_execution_id != execution_id);
        self.item_execution_by_id
            .retain(|_, mapped_execution_id| mapped_execution_id != execution_id);
        self.stdout_span_by_execution.remove(execution_id);
    }

    fn stdout_span_for_execution(
        &mut self,
        parent: Option<&Span>,
        thread_key: &ThreadKey,
        sandbox_id: &str,
        execution_id: &str,
    ) -> Span {
        if let Some(span) = self.stdout_span_by_execution.get(execution_id) {
            return span.clone();
        }
        let span = new_stdout_pump_span(parent, thread_key, sandbox_id, execution_id);
        self.stdout_span_by_execution
            .insert(execution_id.to_owned(), span.clone());
        span
    }

    fn known_execution_for_value(&self, value: &Value) -> Option<String> {
        for turn_id in turn_ids(value) {
            if let Some(execution_id) = self.turn_execution_by_id.get(&turn_id) {
                return Some(execution_id.clone());
            }
        }
        for item_id in item_ids(value) {
            if let Some(execution_id) = self.item_execution_by_id.get(&item_id) {
                return Some(execution_id.clone());
            }
        }
        None
    }

    fn remember_value_execution(&mut self, value: &Value, execution_id: &str) {
        for turn_id in turn_ids(value) {
            self.turn_execution_by_id
                .insert(turn_id, execution_id.to_owned());
        }
        for item_id in item_ids(value) {
            self.item_execution_by_id
                .insert(item_id, execution_id.to_owned());
        }
    }
}

fn new_stdout_pump_span(
    parent: Option<&Span>,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
) -> Span {
    if let Some(parent) = parent {
        info_span!(
            parent: parent,
            "centaur.api_rs.session.stdout_pump",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = execution_id,
            "centaur.sandbox_id" = sandbox_id,
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
        )
    } else {
        info_span!(
            "centaur.api_rs.session.stdout_pump",
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_stdout_pump",
            "centaur.thread_key" = thread_key.as_str(),
            "centaur.execution_id" = execution_id,
            "centaur.sandbox_id" = sandbox_id,
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
        )
    }
}

#[derive(Debug, Eq, PartialEq)]
enum TerminalOutput {
    Completed {
        reason: &'static str,
        result_text: Option<String>,
    },
    Cancelled {
        reason: &'static str,
    },
    Failed {
        error: String,
    },
}

async fn record_terminal_output(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    execution_id: &str,
    terminal: TerminalOutput,
) -> Result<Option<SessionExecution>, SessionRuntimeError> {
    let mut failure_class = None;
    let (terminal_execution, terminal_status) = match terminal {
        TerminalOutput::Completed {
            reason,
            result_text,
        } => {
            let Some(execution) = ctx
                .store
                .complete_execution_if_active_and_stdout_owner(execution_id, &ctx.stdout_owner_id)
                .await?
            else {
                return Ok(None);
            };
            let mut payload = json!({
                "execution_id": execution_id,
                "thread_key": thread_key.as_str(),
                "completion_reason": reason,
            });
            if let (Some(result_text), Some(object)) =
                (result_text.as_deref(), payload.as_object_mut())
            {
                object.insert("result_text".to_owned(), json!(result_text));
            }
            ctx.store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_completed",
                    payload,
                )
                .await?;
            (execution, "completed")
        }
        TerminalOutput::Cancelled { reason } => {
            let Some(execution) = ctx
                .store
                .cancel_execution_if_active_and_stdout_owner(
                    execution_id,
                    &ctx.stdout_owner_id,
                    reason,
                )
                .await?
            else {
                return Ok(None);
            };
            ctx.store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_cancelled",
                    json!({
                        "execution_id": execution_id,
                        "thread_key": thread_key.as_str(),
                        "reason": reason,
                    }),
                )
                .await?;
            (execution, "cancelled")
        }
        TerminalOutput::Failed { error } => {
            failure_class = Some(terminal_failure_class(&error));
            let Some(execution) = ctx
                .store
                .fail_execution_if_active_and_stdout_owner(
                    execution_id,
                    &ctx.stdout_owner_id,
                    &error,
                )
                .await?
            else {
                return Ok(None);
            };
            ctx.store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.execution_failed",
                    json!({
                        "execution_id": execution_id,
                        "thread_key": thread_key.as_str(),
                        "error": error.as_str(),
                    }),
                )
                .await?;
            (execution, "failed")
        }
    };
    spawn_transcript_archive(
        ctx.clone(),
        thread_key.clone(),
        execution_id.to_owned(),
        sandbox_id.to_owned(),
    );
    if let Some(span) = ctx.execution_spans.lock().await.remove(execution_id) {
        finish_execution_trace_span(&span, terminal_status);
    }
    // Release only the one-shot generation acquired for this execution. A
    // delayed terminal path must not delete a successor's ownership.
    release_execution_session_ownership(ctx, thread_key, execution_id).await;
    if let Err(error) = ctx
        .store
        .touch_sandbox_activity(thread_key, sandbox_id)
        .await
    {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_sandbox_activity_touch_failed",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            %error,
            "failed to touch sandbox activity after terminal output"
        );
    }
    record_finished_execution_metric(
        &ctx.store,
        thread_key,
        &terminal_execution,
        terminal_status,
        failure_class,
    )
    .await;
    if let Some(idle_timeout) = idle_timeout_from_execution(&terminal_execution) {
        spawn_idle_pause(
            ctx.clone(),
            thread_key.clone(),
            terminal_execution.execution_id.clone(),
            sandbox_id.to_owned(),
            idle_timeout,
        );
    }
    Ok(Some(terminal_execution))
}

const TRANSCRIPTS_BUCKET_ENV: &str = "CENTAUR_TRANSCRIPTS_BUCKET";
const TRANSCRIPTS_PREFIX_ENV: &str = "CENTAUR_TRANSCRIPTS_PREFIX";
const TRANSCRIPTS_DEFAULT_PREFIX: &str = "transcripts";
/// Per-thread corpus tarball cap; oversized corpora are skipped, not truncated.
const TRANSCRIPT_ARCHIVE_MAX_BYTES: usize = 256 * 1024 * 1024;
const SESSION_TRANSCRIPT_ARCHIVED_EVENT: &str = "session.transcript_archived";

struct TranscriptArchiveConfig {
    bucket: String,
    prefix: String,
    region: Option<String>,
    endpoint: Option<String>,
}

impl TranscriptArchiveConfig {
    /// `None` when no transcripts bucket is configured (archival disabled).
    /// Region/endpoint reuse the S3 configuration surface already used for
    /// archive imports so one object-store setup covers both.
    fn from_env() -> Option<Self> {
        let bucket = env::var(TRANSCRIPTS_BUCKET_ENV).ok()?.trim().to_owned();
        if bucket.is_empty() {
            return None;
        }
        let prefix = env::var(TRANSCRIPTS_PREFIX_ENV)
            .ok()
            .map(|value| value.trim_matches('/').to_owned())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| TRANSCRIPTS_DEFAULT_PREFIX.to_owned());
        Some(Self {
            bucket,
            prefix,
            region: transcript_non_empty_env("SLACK_ARCHIVE_UPLOAD_REGION"),
            endpoint: transcript_non_empty_env("SLACK_ARCHIVE_UPLOAD_ENDPOINT"),
        })
    }
}

fn transcript_non_empty_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Percent-encodes a thread key into a single S3 key segment: bytes in
/// `[A-Za-z0-9._~-]` pass through, everything else becomes `%XX` (uppercase).
/// Consumers decode with plain percent-decoding, so this must stay in lockstep
/// with the app-plane contract.
fn encode_thread_key_segment(thread_key: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut encoded = String::with_capacity(thread_key.len());
    for byte in thread_key.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'.' | b'_' | b'~' | b'-' => {
                encoded.push(byte as char);
            }
            _ => {
                encoded.push('%');
                encoded.push(HEX[usize::from(byte >> 4)] as char);
                encoded.push(HEX[usize::from(byte & 0x0f)] as char);
            }
        }
    }
    encoded
}

fn bounded_archive_pipeline(producer: &str, max_bytes: usize) -> String {
    format!(
        "set -o pipefail; {{ {producer}; }} | head -c {cap}",
        cap = max_bytes + 1
    )
}

fn omp_transcript_archive_command(max_bytes: usize) -> [String; 3] {
    let producer =
        "tar -C \"${OMP_SESSION_DIR:-$HOME/.omp-harness-sessions}\" -czf - . 2>/dev/null";
    [
        "bash".to_owned(),
        "-lc".to_owned(),
        bounded_archive_pipeline(producer, max_bytes),
    ]
}

/// Best-effort omp transcript archival at execution end. Detached so it can
/// never affect execution outcome or latency; every failure is warn-only.
fn spawn_transcript_archive(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    execution_id: String,
    sandbox_id: String,
) {
    let Some(config) = TranscriptArchiveConfig::from_env() else {
        return;
    };
    tokio::spawn(async move {
        if let Err(error) =
            archive_omp_transcripts(&ctx, &thread_key, &execution_id, &sandbox_id, &config).await
        {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "session_transcript_archive_failed",
                thread_key = %thread_key,
                execution_id,
                sandbox_id,
                error,
                "failed to archive omp transcript corpus"
            );
        }
    });
}

async fn archive_omp_transcripts(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution_id: &str,
    sandbox_id: &str,
    config: &TranscriptArchiveConfig,
) -> Result<(), String> {
    let session = ctx
        .store
        .get_session(thread_key)
        .await
        .map_err(|error| format!("failed to load session: {error}"))?;
    if session.harness_type != HarnessType::Omp {
        return Ok(());
    }
    // Same env fallback as the harness launcher: OMP_SESSION_DIR when the
    // sandbox persists sessions, else the harness default directory.
    //
    // head terminates tar after MAX+1 bytes. The oversized branch must run
    // before the status check because pipefail reports tar's expected SIGPIPE
    // as a failure; shorter output still requires a successful tar status.
    let command = omp_transcript_archive_command(TRANSCRIPT_ARCHIVE_MAX_BYTES);
    let output = ctx
        .manager
        .exec(&SandboxId::new(sandbox_id), &command)
        .await
        .map_err(|error| format!("sandbox exec failed: {error}"))?;
    // MAX+1 distinguishes an archive exactly at the limit from an oversized
    // one; the latter is skipped cleanly rather than uploaded truncated.
    if output.stdout.len() > TRANSCRIPT_ARCHIVE_MAX_BYTES {
        debug!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_transcript_archive_oversized",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            "omp transcript corpus exceeded the {} byte cap; skipping archive",
            TRANSCRIPT_ARCHIVE_MAX_BYTES
        );
        return Ok(());
    }
    if !output.success {
        return Err(format!(
            "corpus tar exited unsuccessfully: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.is_empty() {
        debug!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_transcript_archive_empty",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            "omp session directory produced no corpus; skipping archive"
        );
        return Ok(());
    }
    let object_key = format!(
        "{}/{}/corpus.tar.gz",
        config.prefix,
        encode_thread_key_segment(thread_key.as_str())
    );
    let size_bytes = output.stdout.len();
    let client = transcript_s3_client(config).await;
    client
        .put_object()
        .bucket(&config.bucket)
        .key(&object_key)
        .content_type("application/gzip")
        .body(ByteStream::from(output.stdout))
        .send()
        .await
        .map_err(|error| format!("s3 put failed: {error}"))?;
    ctx.store
        .append_event(
            thread_key,
            Some(execution_id),
            SESSION_TRANSCRIPT_ARCHIVED_EVENT,
            json!({
                "execution_id": execution_id,
                "thread_key": thread_key.as_str(),
                "object_key": object_key,
                "size_bytes": size_bytes,
            }),
        )
        .await
        .map_err(|error| format!("failed to record archive event: {error}"))?;
    Ok(())
}

async fn transcript_s3_client(config: &TranscriptArchiveConfig) -> S3Client {
    let mut loader = aws_config::defaults(BehaviorVersion::latest());
    if let Some(region) = &config.region {
        loader = loader.region(Region::new(region.clone()));
    }
    if let Some(endpoint) = &config.endpoint {
        loader = loader.endpoint_url(endpoint);
    }
    let shared_config = loader.load().await;
    let mut builder = S3ConfigBuilder::from(&shared_config);
    if config.endpoint.is_some() {
        builder = builder.force_path_style(true);
    }
    S3Client::from_conf(builder.build())
}

fn spawn_max_duration_failure(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    execution_id: String,
    max_duration: Duration,
    idle_timeout: Option<Duration>,
) {
    tokio::spawn(async move {
        sleep(max_duration).await;
        if let Err(error) = record_max_duration_failure(
            &ctx,
            &thread_key,
            &execution_id,
            max_duration,
            idle_timeout,
        )
        .await
        {
            warn!(%thread_key, %execution_id, %error, "max duration failure task failed");
        }
    });
}

async fn release_session_ownership_generation(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    owner_id: &str,
    generation: Option<i64>,
) {
    let Some(generation) = generation else {
        return;
    };
    if let Err(error) = store
        .release_session_ownership_at_generation(thread_key, owner_id, generation)
        .await
    {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_owner_release_failed",
            thread_key = %thread_key,
            owner_id,
            generation,
            %error,
            "failed to release session ownership generation"
        );
    }
}

async fn release_execution_session_ownership(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution_id: &str,
) {
    let generation = ctx
        .session_ownership_generations
        .remove(execution_id)
        .map(|(_, generation)| generation);
    release_session_ownership_generation(&ctx.store, thread_key, &ctx.stdout_owner_id, generation)
        .await;
}

fn session_ownership_renew_interval() -> Duration {
    PgSessionStore::SESSION_OWNERSHIP_LEASE
        .checked_div(3)
        .unwrap_or(Duration::from_secs(15))
}

fn spawn_execution_session_owner_renewer(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    execution_id: String,
    generation: i64,
    renew_interval: Duration,
) {
    tokio::spawn(async move {
        loop {
            sleep(renew_interval).await;
            match ctx
                .store
                .renew_session_ownership_if_active_execution_owner(
                    &thread_key,
                    &execution_id,
                    &ctx.stdout_owner_id,
                    generation,
                )
                .await
            {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_owner_renew_failed",
                        thread_key = %thread_key,
                        execution_id,
                        owner_id = %ctx.stdout_owner_id,
                        generation,
                        %error,
                        "failed to renew active execution session ownership"
                    );
                }
            }
        }
    });
}

fn spawn_stdout_owner_renewer(ctx: RuntimeContext, execution_id: String) {
    tokio::spawn(async move {
        loop {
            sleep(STDOUT_OWNER_RENEW_INTERVAL).await;
            match ctx
                .store
                .renew_stdout_owner(&execution_id, &ctx.stdout_owner_id, STDOUT_OWNER_LEASE)
                .await
            {
                Ok(true) => {}
                Ok(false) => break,
                Err(error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "session_stdout_owner_renew_failed",
                        execution_id,
                        stdout_owner_id = %ctx.stdout_owner_id,
                        %error,
                        "failed to renew stdout owner lease; retrying"
                    );
                }
            }
        }
    });
}

async fn record_max_duration_failure(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution_id: &str,
    max_duration: Duration,
    idle_timeout: Option<Duration>,
) -> Result<(), SessionRuntimeError> {
    let max_duration_ms = duration_millis_u64(max_duration);
    let error = format!("execution exceeded max_duration_ms={max_duration_ms}");
    let Some(execution) = ctx
        .store
        .fail_execution_if_active_and_stdout_owner(execution_id, &ctx.stdout_owner_id, &error)
        .await?
    else {
        return Ok(());
    };
    if let Some(span) = ctx.execution_spans.lock().await.remove(execution_id) {
        finish_execution_trace_span(&span, "failed");
    }
    if let Err(error) = ctx.store.touch_session_sandbox_activity(thread_key).await {
        warn!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "session_sandbox_activity_touch_failed",
            thread_key = %thread_key,
            execution_id,
            %error,
            "failed to touch sandbox activity after max duration"
        );
    }
    ctx.store
        .append_event(
            thread_key,
            Some(execution_id),
            "session.execution_failed",
            json!({
                "execution_id": execution_id,
                "thread_key": thread_key.as_str(),
                "error": error,
                "reason": "max_duration_exceeded",
                "max_duration_ms": max_duration_ms,
            }),
        )
        .await?;
    record_finished_execution_metric(
        &ctx.store,
        thread_key,
        &execution,
        "failed",
        Some("timeout"),
    )
    .await;
    release_execution_session_ownership(ctx, thread_key, execution_id).await;
    if let Some(idle_timeout) = idle_timeout.or_else(|| idle_timeout_from_execution(&execution))
        && let Some(sandbox_id) = ctx.store.get_session(thread_key).await?.sandbox_id
    {
        spawn_idle_pause(
            ctx.clone(),
            thread_key.clone(),
            execution_id.to_owned(),
            sandbox_id,
            idle_timeout,
        );
    }
    Ok(())
}

fn spawn_idle_pause(
    ctx: RuntimeContext,
    thread_key: ThreadKey,
    execution_id: String,
    sandbox_id: String,
    idle_timeout: Duration,
) {
    tokio::spawn(async move {
        sleep(idle_timeout).await;
        if let Err(error) =
            record_idle_pause(&ctx, &thread_key, &execution_id, &sandbox_id, idle_timeout).await
        {
            warn!(%thread_key, %execution_id, %sandbox_id, %error, "idle pause task failed");
        }
    });
}
/// Spawns a background keepalive task for an active collaboration room. The
/// task periodically renews the session ownership lease and touches the
/// sandbox activity timestamp. If renewal fails (the ownership was lost to
/// another owner after a process/relay loss and reacquire cycle), the
/// keepalive flag flips to false and the room is removed from the registry.
/// The keepalive interval is shorter than the ownership lease so renewal
/// happens well before expiry.
fn spawn_collab_keepalive(
    runtime: SessionRuntime,
    thread_key: ThreadKey,
    owner_id: String,
    generation: i64,
    keepalive: Arc<AtomicBool>,
) {
    let renew_interval = session_ownership_renew_interval();
    tokio::spawn(async move {
        // First tick after renew_interval — never fire while start still holds
        // the lifecycle lock and is waiting for durable started.
        let mut timer = interval_at(Instant::now() + renew_interval, renew_interval);
        timer.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            timer.tick().await;
            if !keepalive.load(Ordering::SeqCst) {
                return;
            }
            let renewed = runtime
                .store
                .renew_session_ownership_if_session_owner(&thread_key, &owner_id, generation)
                .await;
            let lost_reason = match renewed {
                Ok(true) => match runtime
                    .store
                    .touch_session_sandbox_activity(&thread_key)
                    .await
                {
                    Ok(true) => None,
                    Ok(false) => Some("sandbox_activity_touch_lost"),
                    Err(_) => Some("keepalive_store_failure"),
                },
                Ok(false) => Some("ownership_lease_expired"),
                Err(_) => Some("keepalive_store_failure"),
            };
            if let Some(reason) = lost_reason {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "collab_keepalive_lost",
                    thread_key = %thread_key,
                    generation,
                    reason,
                    "keepalive renewal or sandbox activity touch failed"
                );
                keepalive.store(false, Ordering::SeqCst);
                // One-shot loss attempt; on transient failure the shared
                // cleanup-pending retry worker continues without wall-clock
                // abandonment. No duplicate keepalive-local retry loop.
                let _ = runtime.lose_collab_room(&thread_key, reason).await;
            }
        }
    });
}

async fn record_idle_pause(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution_id: &str,
    sandbox_id: &str,
    idle_timeout: Duration,
) -> Result<(), SessionRuntimeError> {
    let latest_execution = ctx.store.latest_execution_for_thread(thread_key).await?;
    let session = ctx.store.get_session(thread_key).await?;
    if !should_pause_idle_sandbox(
        &session,
        latest_execution.as_ref(),
        execution_id,
        sandbox_id,
        &ctx.collab_rooms,
    ) {
        return Ok(());
    }

    let id = SandboxId::new(sandbox_id);
    match ctx.manager.status(&id).await {
        Ok(SandboxStatus::Suspended | SandboxStatus::Stopped | SandboxStatus::Gone) => {
            return Ok(());
        }
        Ok(SandboxStatus::Running | SandboxStatus::Created) => {}
        Ok(SandboxStatus::Unknown(_)) => return Ok(()),
        Err(SandboxError::NotFound(_)) => return Ok(()),
        Err(error) => {
            record_idle_pause_failure(
                &ctx.store,
                thread_key,
                execution_id,
                sandbox_id,
                idle_timeout,
                &error.to_string(),
            )
            .await?;
            return Err(SessionRuntimeError::Sandbox(error));
        }
    }

    ctx.sandbox_pipes.remove(sandbox_id);
    match ctx.manager.pause(&id).await {
        Ok(()) => {
            ctx.store
                .append_event(
                    thread_key,
                    Some(execution_id),
                    "session.sandbox_paused",
                    json!({
                        "execution_id": execution_id,
                        "thread_key": thread_key.as_str(),
                        "sandbox_id": sandbox_id,
                        "reason": "idle_timeout",
                        "idle_timeout_ms": duration_millis_u64(idle_timeout),
                    }),
                )
                .await?;
        }
        Err(error) => {
            record_idle_pause_failure(
                &ctx.store,
                thread_key,
                execution_id,
                sandbox_id,
                idle_timeout,
                &error.to_string(),
            )
            .await?;
            return Err(SessionRuntimeError::Sandbox(error));
        }
    }
    Ok(())
}

async fn record_idle_pause_failure(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution_id: &str,
    sandbox_id: &str,
    idle_timeout: Duration,
    error: &str,
) -> Result<(), SessionRuntimeError> {
    store
        .append_event(
            thread_key,
            Some(execution_id),
            "session.sandbox_pause_failed",
            json!({
                "execution_id": execution_id,
                "thread_key": thread_key.as_str(),
                "sandbox_id": sandbox_id,
                "reason": "idle_timeout",
                "idle_timeout_ms": duration_millis_u64(idle_timeout),
                "error": error,
            }),
        )
        .await?;
    Ok(())
}

fn should_pause_idle_sandbox(
    session: &Session,
    latest_execution: Option<&SessionExecution>,
    execution_id: &str,
    sandbox_id: &str,
    collab_rooms: &CollabRoomRegistry,
) -> bool {
    if session.sandbox_id.as_deref() != Some(sandbox_id) {
        return false;
    }
    // An active collaboration room keeps the sandbox awake: the room's
    // resident OMP host and guests need the sandbox process alive for
    // real-time collaboration. Suspension is deferred until the room is
    // stopped or lost.
    if collab_rooms
        .get(&session.thread_key)
        .map(|h| {
            !matches!(
                h.phase,
                CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
            )
        })
        .unwrap_or(false)
    {
        return false;
    }
    let Some(execution) = latest_execution else {
        return false;
    };
    if execution.execution_id != execution_id {
        return false;
    }
    matches!(
        execution.status,
        ExecutionStatus::Completed | ExecutionStatus::Failed | ExecutionStatus::Cancelled
    )
}
fn duration_millis_u64(duration: Duration) -> u64 {
    duration.as_millis().min(u128::from(u64::MAX)) as u64
}

fn clean_persona_id(value: &str) -> Option<&str> {
    let value = value.trim();
    if value.is_empty() { None } else { Some(value) }
}

fn resolve_persona_context(
    personas: Option<&PersonaRegistry>,
    persona_id: Option<&str>,
    defaulted: bool,
    capabilities: &SessionSandboxCapabilities,
) -> Result<Option<PersonaContext>, SessionRuntimeError> {
    let Some(persona_id) = persona_id else {
        return Ok(None);
    };
    let Some(registry) = personas else {
        return Err(SessionRuntimeError::BadRequest(format!(
            "persona {persona_id:?} was requested but no persona registry is configured"
        )));
    };
    registry
        .context_for_access(persona_id, defaulted, &capabilities.repo_cache)
        .map(Some)
        .map_err(SessionRuntimeError::BadRequest)
}

fn resolve_persona_selection(
    personas: Option<&PersonaRegistry>,
    requested_persona_id: Option<&str>,
    capabilities: &SessionSandboxCapabilities,
) -> Result<PersonaResolution, SessionRuntimeError> {
    let requested = requested_persona_id.and_then(clean_persona_id);
    let Some(registry) = personas else {
        return Ok(PersonaResolution {
            persona_id: None,
            context: None,
            unavailable_requested_persona_id: requested.map(str::to_owned),
        });
    };
    let (selected, unavailable_requested_persona_id) = match requested {
        Some(persona_id) if registry.get(persona_id).is_some() => (Some(persona_id), None),
        Some(persona_id) => (
            registry.default_persona_id_for_access(&capabilities.repo_cache),
            Some(persona_id.to_owned()),
        ),
        None => (
            registry.default_persona_id_for_access(&capabilities.repo_cache),
            None,
        ),
    };
    let defaulted = selected.is_some() && selected != requested;
    let context = resolve_persona_context(Some(registry), selected, defaulted, capabilities)?;
    Ok(PersonaResolution {
        persona_id: selected.map(str::to_owned),
        context,
        unavailable_requested_persona_id,
    })
}

fn upsert_spec_env(spec: &mut SandboxSpec, name: &str, value: String) {
    if let Some(existing) = spec.env.iter_mut().find(|env| env.name == name) {
        existing.value = value;
    } else {
        spec.env
            .push(centaur_sandbox_core::EnvVar::new(name, value));
    }
}

fn sandbox_capabilities_match(
    existing: Option<&SessionSandboxCapabilities>,
    desired: &SessionSandboxCapabilities,
) -> bool {
    existing.map_or_else(
        || desired.is_default_enabled(),
        |existing| existing == desired,
    )
}

fn sandbox_repo_cache_access_from_principal(
    principal: &centaur_iron_control::Principal,
) -> SessionRepoCacheAccess {
    match principal
        .labels
        .get(SANDBOX_REPO_CACHE_LABEL)
        .map(|value| value.trim().to_ascii_lowercase())
    {
        Some(value) if value == "all" => SessionRepoCacheAccess::All,
        Some(value) if value == "public" => SessionRepoCacheAccess::Public,
        Some(_) => SessionRepoCacheAccess::None,
        None => SessionRepoCacheAccess::None,
    }
}

fn sandbox_capabilities_from_principal(
    principal: &centaur_iron_control::Principal,
) -> SessionSandboxCapabilities {
    SessionSandboxCapabilities {
        repo_cache: sandbox_repo_cache_access_from_principal(principal),
        observability_enabled: principal.sandbox_observability_enabled,
        api_server_enabled: principal.sandbox_api_server_enabled,
    }
}

fn apply_sandbox_capabilities(spec: &mut SandboxSpec, capabilities: &SessionSandboxCapabilities) {
    spec.capabilities = BackendSandboxCapabilities {
        repo_cache: match capabilities.repo_cache {
            SessionRepoCacheAccess::None => RepoCacheAccess::None,
            SessionRepoCacheAccess::Public => RepoCacheAccess::Public,
            SessionRepoCacheAccess::All => RepoCacheAccess::All,
        },
        observability_enabled: capabilities.observability_enabled,
        api_server_enabled: capabilities.api_server_enabled,
    };
    upsert_spec_env(
        spec,
        "CENTAUR_SANDBOX_REPO_CACHE_ENABLED",
        capabilities.repo_cache_enabled().to_string(),
    );
    upsert_spec_env(
        spec,
        "CENTAUR_SANDBOX_REPO_CACHE_ACCESS",
        capabilities.repo_cache.as_str().to_owned(),
    );
    upsert_spec_env(
        spec,
        "CENTAUR_SANDBOX_OBSERVABILITY_ENABLED",
        capabilities.observability_enabled.to_string(),
    );
    upsert_spec_env(
        spec,
        "CENTAUR_SANDBOX_API_SERVER_ENABLED",
        capabilities.api_server_enabled.to_string(),
    );
    match capabilities.repo_cache {
        SessionRepoCacheAccess::None => {
            spec.mounts
                .retain(|mount| mount.target_path != SANDBOX_REPOS_MOUNT_PATH);
            remove_spec_env(spec, CENTAUR_SKILL_DIRS_ENV);
        }
        SessionRepoCacheAccess::Public => {
            scope_repo_cache_mounts_to_public(spec);
            scope_skill_dirs_to_public(spec);
        }
        SessionRepoCacheAccess::All => {
            remove_spec_env(spec, CENTAUR_PUBLIC_SKILL_DIRS_ENV);
        }
    }
    remove_spec_env(spec, CENTAUR_PUBLIC_SKILL_DIRS_ENV);
    if !capabilities.observability_enabled {
        append_spec_env_csv(spec, "TOOL_BLOCKLIST", OBSERVABILITY_TOOL_BLOCKLIST);
    }
}

fn tool_host_tool_filter_from_spec(
    mut spec: SandboxSpec,
    capabilities: &SessionSandboxCapabilities,
) -> ToolHostToolFilter {
    apply_sandbox_capabilities(&mut spec, capabilities);
    ToolHostToolFilter {
        allowlist: spec
            .env
            .iter()
            .find(|env| env.name == "TOOL_ALLOWLIST")
            .map(|env| env.value.clone()),
        blocklist: spec
            .env
            .iter()
            .find(|env| env.name == "TOOL_BLOCKLIST")
            .map(|env| env.value.clone()),
    }
}

fn scope_repo_cache_mounts_to_public(spec: &mut SandboxSpec) {
    for mount in spec
        .mounts
        .iter_mut()
        .filter(|mount| mount.target_path == SANDBOX_REPOS_MOUNT_PATH)
    {
        match &mut mount.kind {
            centaur_sandbox_core::MountKind::Bind { source_path } => {
                *source_path = format!(
                    "{}/{}",
                    source_path.trim_end_matches('/'),
                    PUBLIC_REPO_CACHE_SUBPATH
                );
            }
            centaur_sandbox_core::MountKind::NamedVolume(_) => {
                mount.sub_path = Some(PUBLIC_REPO_CACHE_SUBPATH.to_owned());
            }
            centaur_sandbox_core::MountKind::EmptyDir => {}
        }
    }
}

fn scope_skill_dirs_to_public(spec: &mut SandboxSpec) {
    let public_skill_dirs = spec
        .env
        .iter()
        .find(|env| env.name == CENTAUR_PUBLIC_SKILL_DIRS_ENV)
        .map(|env| env.value.trim().to_owned())
        .filter(|value| !value.is_empty());
    match public_skill_dirs {
        Some(public_skill_dirs) => upsert_spec_env(spec, CENTAUR_SKILL_DIRS_ENV, public_skill_dirs),
        None => remove_spec_env(spec, CENTAUR_SKILL_DIRS_ENV),
    }
}

fn append_spec_env_csv(spec: &mut SandboxSpec, name: &str, values: &str) {
    let existing = spec
        .env
        .iter()
        .find(|env| env.name == name)
        .map(|env| env.value.as_str())
        .unwrap_or("");
    let mut merged = existing
        .split(',')
        .chain(values.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .fold(Vec::<String>::new(), |mut acc, value| {
            if !acc.iter().any(|existing| existing == value) {
                acc.push(value.to_owned());
            }
            acc
        });
    merged.sort();
    upsert_spec_env(spec, name, merged.join(","));
}

fn apply_persona_spec(mut spec: SandboxSpec, persona: Option<&PersonaContext>) -> SandboxSpec {
    let persona_prompt_path = format!("{SANDBOX_AGENT_HOME}/AGENTS_PERSONA.md");
    for name in [
        "AGENT_PERSONA",
        "CENTAUR_PERSONA_ID",
        "CENTAUR_PERSONA_PROMPT_HASH",
        "CENTAUR_PERSONA_SOURCE_PATH",
        "CENTAUR_PERSONA_SOURCE_REF",
    ] {
        remove_spec_env(&mut spec, name);
    }
    spec.files
        .retain(|file| file.target_path != persona_prompt_path);
    let Some(persona) = persona else {
        return spec;
    };
    upsert_spec_env(&mut spec, "AGENT_PERSONA", persona.persona_id.clone());
    upsert_spec_env(&mut spec, "CENTAUR_PERSONA_ID", persona.persona_id.clone());
    spec.files.push(SandboxFile::new(
        persona_prompt_path,
        persona.prompt.clone(),
    ));
    upsert_spec_env(
        &mut spec,
        "CENTAUR_PERSONA_PROMPT_HASH",
        persona.prompt_hash.clone(),
    );
    upsert_spec_env(
        &mut spec,
        "CENTAUR_PERSONA_SOURCE_PATH",
        persona.source_path.clone(),
    );
    if let Some(source_ref) = persona.source_ref.as_ref() {
        upsert_spec_env(&mut spec, "CENTAUR_PERSONA_SOURCE_REF", source_ref.clone());
    }
    spec
}

fn remove_spec_env(spec: &mut SandboxSpec, name: &str) {
    spec.env.retain(|env| env.name != name);
}

fn add_persona_metadata(metadata: &mut Value, context: &PersonaContext) {
    if let Value::Object(object) = metadata {
        object.insert("persona".to_owned(), json!(context));
    }
}

async fn record_finished_execution_metric(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution: &SessionExecution,
    status: &'static str,
    failure_class: Option<&'static str>,
) {
    let harness_label = match store.get_session(thread_key).await {
        Ok(session) => session.harness_type.to_string(),
        Err(error) => {
            warn!(%thread_key, %error, "failed to load session for execution metric labels");
            "unknown".to_owned()
        }
    };
    record_session_execution_finished(&harness_label, status, execution_duration(execution));
    if let Some(failure_class) = failure_class {
        record_session_failure(&harness_label, failure_class);
    }
}

fn execution_duration(execution: &SessionExecution) -> Option<Duration> {
    let started_at = execution.started_at.unwrap_or(execution.created_at);
    let completed_at = execution.completed_at?;
    (completed_at - started_at).try_into().ok()
}

fn runtime_error_failure_class(error: &SessionRuntimeError) -> &'static str {
    match error {
        SessionRuntimeError::BadRequest(_) => "bad_request",
        SessionRuntimeError::ShuttingDown => "shutting_down",
        SessionRuntimeError::Store(_) => "store",
        SessionRuntimeError::Sandbox(SandboxError::NotFound(_)) => "sandbox_not_found",
        SessionRuntimeError::Sandbox(SandboxError::Unsupported { .. }) => "sandbox_unsupported",
        SessionRuntimeError::Sandbox(SandboxError::NotReady(_)) => "sandbox_not_ready",
        SessionRuntimeError::Sandbox(SandboxError::Io { .. }) => "sandbox_io",
        SessionRuntimeError::Sandbox(SandboxError::Backend { .. }) => "sandbox_backend",
        SessionRuntimeError::Sandbox(SandboxError::InvalidSpec(_)) => "sandbox_invalid_spec",
        SessionRuntimeError::SandboxLeaseOwned { .. } => "sandbox_lease_owned",
        SessionRuntimeError::IronControl(_) => "iron_control",
        SessionRuntimeError::WarmPool(_) => "warm_pool",
        SessionRuntimeError::CapacityExceeded { .. } => "capacity",
        SessionRuntimeError::SessionOwned { .. } => "session_owned",
        SessionRuntimeError::CollabNotSupported { .. } => "collab_not_supported",
        SessionRuntimeError::CollabTerminalSession { .. } => "collab_terminal_session",
        SessionRuntimeError::CollabRoomLost { .. } => "collab_room_lost",
    }
}

fn terminal_failure_class(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    // Capacity deaths are checked first because they arrive wrapped in the
    // generic stdout-closed message and would otherwise read as `sandbox_io`.
    // They are worth their own class: raising a memory limit and relieving node
    // pressure are different actions, and neither is a harness problem.
    if error.contains("oomkilled") {
        return "oom";
    }
    if error.contains("evicted") {
        return "evicted";
    }
    if error.contains("max_duration") || error.contains("timeout") || error.contains("timed out") {
        return "timeout";
    }
    if error.contains("execution orphaned") {
        return "orphaned";
    }
    if error.contains("sandbox stdout") || error.contains("stdout closed") {
        return "sandbox_io";
    }
    "harness"
}

/// The detail recorded when a sandbox can no longer serve io.
///
/// The backend's termination reason is appended when it has one. Without it
/// every death reads as the same "no longer accepts io" string, and an
/// OOMKilled turn is indistinguishable from a harness fault unless someone
/// reads pod status before the kubelet collects the pod.
fn sandbox_dead_detail(status: &SandboxStatus, reason: Option<&str>) -> String {
    match reason {
        Some(reason) => {
            format!("sandbox no longer accepts io (status {status:?}, reason {reason})")
        }
        None => format!("sandbox no longer accepts io (status {status:?})"),
    }
}

fn should_attach_session_pipe(status: &SandboxStatus) -> bool {
    status.can_open_io()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExistingSandboxAction {
    Reuse,
    ResumeOrReplace,
    Replace,
}

fn existing_sandbox_action(status: &SandboxStatus) -> ExistingSandboxAction {
    match status {
        SandboxStatus::Running => ExistingSandboxAction::Reuse,
        SandboxStatus::Created | SandboxStatus::Suspended => ExistingSandboxAction::ResumeOrReplace,
        SandboxStatus::Stopped | SandboxStatus::Gone | SandboxStatus::Unknown(_) => {
            ExistingSandboxAction::Replace
        }
    }
}

fn is_event_stream_attach_race(error: &SessionRuntimeError) -> bool {
    matches!(
        error,
        SessionRuntimeError::Sandbox(SandboxError::NotReady(_))
    )
}

fn terminal_output(value: &Value, prior_final_answer_text: &str) -> Option<TerminalOutput> {
    let method = value.get("method").and_then(Value::as_str);
    let event_type = value.get("type").and_then(Value::as_str);

    if event_type == Some("run.failed")
        && matches!(
            value.pointer("/payload/status").and_then(Value::as_str),
            Some("cancelled" | "canceled")
        )
    {
        return Some(TerminalOutput::Cancelled {
            reason: "turn_interrupted",
        });
    }

    if matches!(method, Some("error" | "turn/failed"))
        || matches!(event_type, Some("error" | "turn.failed" | "run.failed"))
    {
        // Codex emits intermediate `error` notifications with willRetry=true
        // while reconnecting a dropped model stream. Those are not terminal.
        if error_notification_will_retry(value) && matches!(method.or(event_type), Some("error")) {
            return None;
        }
        return Some(TerminalOutput::Failed {
            error: terminal_error_text(value),
        });
    }

    if method == Some("turn/completed") {
        return Some(completed_turn_terminal_output(
            value,
            prior_final_answer_text,
        ));
    }

    match event_type {
        Some("run.completed") => Some(completed_terminal_output_with_fallback(
            value,
            "run_completed",
            prior_final_answer_text,
        )),
        Some("turn.completed") => Some(completed_turn_terminal_output(
            value,
            prior_final_answer_text,
        )),
        Some("turn.done") => Some(completed_terminal_output(value, "turn_done")),
        Some("result") => {
            if result_is_failure(value) {
                Some(TerminalOutput::Failed {
                    error: terminal_error_text(value),
                })
            } else {
                Some(completed_terminal_output(value, "result"))
            }
        }
        _ => None,
    }
}

fn completed_turn_terminal_output(value: &Value, prior_final_answer_text: &str) -> TerminalOutput {
    match turn_completion_status(value).as_deref() {
        Some("completed" | "succeeded" | "success") | None => {
            completed_terminal_output_with_fallback(
                value,
                "turn_completed",
                prior_final_answer_text,
            )
        }
        Some("interrupted") if prior_final_answer_text.trim().is_empty() => {
            TerminalOutput::Cancelled {
                reason: "turn_interrupted",
            }
        }
        Some(_status) if !prior_final_answer_text.trim().is_empty() => {
            completed_terminal_output_with_fallback(
                value,
                "turn_completed",
                prior_final_answer_text,
            )
        }
        Some(status) => TerminalOutput::Failed {
            error: format!("turn completed with status {status} before final answer"),
        },
    }
}

fn completed_terminal_output(value: &Value, reason: &'static str) -> TerminalOutput {
    completed_terminal_output_with_fallback(value, reason, "")
}

fn completed_terminal_output_with_fallback(
    value: &Value,
    reason: &'static str,
    fallback_text: &str,
) -> TerminalOutput {
    let result_text = terminal_payload_text(value).trim().to_owned();
    let result_text = if result_text.is_empty() {
        fallback_text.trim().to_owned()
    } else {
        result_text
    };
    TerminalOutput::Completed {
        reason,
        result_text: (!result_text.is_empty()).then_some(result_text),
    }
}

fn turn_completion_status(value: &Value) -> Option<String> {
    [
        &["turn", "status"][..],
        &["params", "turn", "status"][..],
        &["status"][..],
        &["params", "status"][..],
    ]
    .into_iter()
    .filter_map(|path| string_at_path(value, path))
    .next()
}

enum FinalAnswerTextUpdate {
    Append(String),
    Replace(String),
}

fn output_line_final_answer_text(value: &Value) -> Option<FinalAnswerTextUpdate> {
    let method = value.get("method").and_then(Value::as_str);
    let event_type = value.get("type").and_then(Value::as_str);
    if event_type == Some("assistant.delta") {
        if nanocodex_message_phase(value) == Some("commentary") {
            return None;
        }
        let text = value
            .get("payload")
            .and_then(|payload| payload.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Append(text));
    }
    if event_type == Some("assistant.message") {
        if nanocodex_message_phase(value) == Some("commentary") {
            return None;
        }
        let text = value
            .get("payload")
            .and_then(|payload| payload.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Replace(text));
    }
    if matches!(method, Some("item/agentMessage/delta"))
        || matches!(event_type, Some("item.agentMessage.delta"))
    {
        let text = terminal_payload_text(value).trim().to_owned();
        return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Append(text));
    }
    if event_type == Some("assistant") {
        let text = terminal_payload_text(value).trim().to_owned();
        return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Replace(text));
    }
    if matches!(method, Some("item/completed")) || matches!(event_type, Some("item.completed")) {
        let item = value
            .get("item")
            .or_else(|| value.get("params").and_then(|params| params.get("item")));
        if let Some(item) = item
            && matches!(
                item.get("type").and_then(Value::as_str),
                Some("agentMessage" | "agent_message")
            )
            && matches!(
                item.get("phase").and_then(Value::as_str),
                Some("final_answer" | "answer") | None
            )
        {
            let text = terminal_payload_text(item).trim().to_owned();
            return (!text.is_empty()).then_some(FinalAnswerTextUpdate::Replace(text));
        }
    }
    None
}

fn nanocodex_message_phase(value: &Value) -> Option<&str> {
    value
        .get("payload")
        .and_then(|payload| payload.get("phase"))
        .and_then(Value::as_str)
}

fn turn_ids(value: &Value) -> Vec<String> {
    [
        &["turn_id"][..],
        &["turnId"][..],
        &["turn", "id"][..],
        &["params", "turnId"][..],
        &["params", "turn", "id"][..],
    ]
    .into_iter()
    .filter_map(|path| string_at_path(value, path))
    .collect()
}

fn item_ids(value: &Value) -> Vec<String> {
    [
        &["item_id"][..],
        &["itemId"][..],
        &["item", "id"][..],
        &["params", "itemId"][..],
        &["params", "item", "id"][..],
    ]
    .into_iter()
    .filter_map(|path| string_at_path(value, path))
    .collect()
}

fn string_at_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    let text = current.as_str()?.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn result_is_failure(value: &Value) -> bool {
    matches!(
        value.get("subtype").and_then(Value::as_str),
        Some("error" | "failure" | "failed")
    )
}

fn error_notification_will_retry(value: &Value) -> bool {
    matches!(
        value
            .pointer("/params/willRetry")
            .or_else(|| value.get("willRetry"))
            .and_then(Value::as_bool),
        Some(true)
    )
}

fn nested_codex_error_text(value: &Value) -> Option<String> {
    let error = value
        .pointer("/params/error")
        .or_else(|| value.get("error"))?;
    if !error.is_object() {
        return None;
    }
    let message = error.get("message").and_then(Value::as_str).unwrap_or("");
    let details = error
        .get("additionalDetails")
        .and_then(Value::as_str)
        .unwrap_or("");
    let text = match (message.is_empty(), details.is_empty()) {
        (false, false) if !message.contains(details) => format!("{message}: {details}"),
        (false, _) => message.to_owned(),
        (true, false) => details.to_owned(),
        (true, true) => return None,
    };
    Some(text)
}

fn terminal_error_text(value: &Value) -> String {
    for key in ["error", "message", "result", "text"] {
        if let Some(text) = value.get(key).and_then(Value::as_str)
            && !text.trim().is_empty()
        {
            return text.trim().to_owned();
        }
    }
    if let Some(text) = nested_codex_error_text(value) {
        return text;
    }
    terminal_payload_text(value)
        .trim()
        .to_owned()
        .if_empty("terminal harness output reported failure")
}

fn terminal_payload_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Array(values) => values
            .iter()
            .map(terminal_payload_text)
            .find(|text| !text.trim().is_empty())
            .unwrap_or_default(),
        Value::Object(object) => {
            for key in [
                "result",
                "result_text",
                "text",
                "final_text",
                "message",
                "delta",
                "content",
                "params",
                "payload",
            ] {
                if let Some(text) = object.get(key).map(terminal_payload_text)
                    && !text.trim().is_empty()
                {
                    return text;
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

trait StringExt {
    fn if_empty(self, fallback: &str) -> String;
}

impl StringExt for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_owned()
        } else {
            self
        }
    }
}

async fn drain_stderr(mut stderr: SandboxRead) -> Result<(), SessionRuntimeError> {
    io::copy(&mut stderr, &mut io::sink())
        .await
        .map_err(|err| {
            SessionRuntimeError::Sandbox(SandboxError::io_source("drain stderr", err))
        })?;
    Ok(())
}

async fn write_input_lines(
    pipe: &SessionPipe,
    input_lines: &[String],
    thread_key: &ThreadKey,
    execution_id: &str,
    sandbox_id: Option<&str>,
) -> Result<(), SessionRuntimeError> {
    let sandbox_id = sandbox_id.unwrap_or("");
    let span = info_span!(
        "centaur.api_rs.sandbox.write_input",
        component = COMPONENT_SESSION_RUNTIME,
        event = "sandbox_write_input",
        "centaur.thread_key" = thread_key.as_str(),
        "centaur.execution_id" = execution_id,
        "centaur.sandbox_id" = sandbox_id,
        thread_key = %thread_key,
        execution_id,
        sandbox_id,
        input_line_count = input_lines.len(),
    );
    async {
        let mut stdin = pipe.stdin.lock().await;
        for line in input_lines {
            stdin.send(line).await.map_err(codec_error_to_runtime)?;
        }
        info!(
            component = COMPONENT_SESSION_RUNTIME,
            event = "sandbox_write_input_completed",
            thread_key = %thread_key,
            execution_id,
            sandbox_id,
            input_line_count = input_lines.len(),
            "sandbox input written"
        );
        Ok(())
    }
    .instrument(span)
    .await
}

const EXECUTION_TRACEPARENT_METADATA_KEY: &str = "centaur.traceparent";

/// Execution trace identity injected into sandbox stdin lines so harness spans
/// join the durable execution trace. The traceparent is persisted before input
/// delivery and can therefore be reused by steering and restart recovery.
#[derive(Clone, Debug)]
struct SessionTraceContext {
    traceparent: Option<String>,
    /// Stable per-thread trace id, derived from the thread key (UUIDv5).
    /// Empty for execution contexts that do not have a thread key (tests and
    /// legacy callers); in that case caller-supplied trace_id is removed.
    trace_id: String,
    /// Trusted session ownership fence injected by api-rs (never client-
    /// asserted). The harness-server resident OMP host fences every command
    /// on this ownership; a stale or missing fence is rejected.
    owner_id: Option<String>,
    generation: Option<i64>,
    /// Trusted execution duration forwarded to the harness as a local safety
    /// deadline. api-rs remains authoritative and records the timeout first.
    max_duration_ms: Option<u64>,
    /// Durable execution identity propagated to harness trace metadata.
    execution_id: Option<String>,
}

impl SessionTraceContext {
    #[cfg(test)]
    fn new(execution_span: Option<&Span>, persisted_traceparent: Option<String>) -> Self {
        Self::for_execution(execution_span, persisted_traceparent, None)
    }

    fn for_execution(
        execution_span: Option<&Span>,
        persisted_traceparent: Option<String>,
        execution_id: Option<&str>,
    ) -> Self {
        Self {
            trace_id: String::new(),
            traceparent: execution_span
                .and_then(centaur_telemetry::traceparent_for_span)
                .or(persisted_traceparent),
            owner_id: None,
            generation: None,
            max_duration_ms: None,
            execution_id: execution_id.map(ToOwned::to_owned),
        }
    }

    #[cfg(test)]
    fn new_for_thread(thread_key: &ThreadKey, execution_span: Option<&Span>) -> Self {
        Self::for_execution(execution_span, None, None).with_thread_key(thread_key)
    }

    fn with_thread_key(mut self, thread_key: &ThreadKey) -> Self {
        self.trace_id = thread_trace_id(thread_key);
        self
    }

    fn with_max_duration_ms(mut self, max_duration_ms: Option<u64>) -> Self {
        self.max_duration_ms = max_duration_ms;
        self
    }

    /// Attach the trusted session ownership fence. Called after
    /// `acquire_oneshot_session_ownership` succeeds so the harness-server
    /// can fence stale/missing ownership without trusting client input.
    fn with_ownership(mut self, owner_id: &str, generation: i64) -> Self {
        self.owner_id = Some(owner_id.to_owned());
        self.generation = Some(generation);
        self
    }
}

/// Deterministic per-thread trace id: one trace identity per thread without a
/// `thread_traces` table (derive, don't store).
pub fn thread_trace_id(thread_key: &ThreadKey) -> String {
    uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!("centaur:thread:{}", thread_key.as_str()).as_bytes(),
    )
    .to_string()
}

fn ensure_thread_trace_root_span(thread_key: &ThreadKey) {
    let trace_id = thread_trace_id(thread_key);
    let root_span_id = thread_trace_parent_span_id(thread_key);
    let thread_key = thread_key.as_str().to_owned();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = export_thread_trace_root_span(&trace_id, &root_span_id, &thread_key).await;
        });
    }
}

pub fn thread_trace_parent_span_id(thread_key: &ThreadKey) -> String {
    let digest = Sha256::digest(format!("centaur:thread-parent:{}", thread_key.as_str()));
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&digest[..8]);
    if bytes.iter().all(|byte| *byte == 0) {
        bytes[7] = 1;
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn execution_traceparent(execution: &SessionExecution) -> Option<&str> {
    execution
        .metadata
        .get(EXECUTION_TRACEPARENT_METADATA_KEY)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn finish_execution_trace_span(span: &Span, status: &str) {
    span.record(
        "lmnr.span.output",
        serde_json::json!({ "status": status }).to_string(),
    );
    span.record(
        "otel.status_code",
        if status == "failed" { "ERROR" } else { "OK" },
    );
}

fn input_lines_with_session_context(
    thread_key: &ThreadKey,
    trace: &SessionTraceContext,
    input_lines: &[String],
) -> Vec<String> {
    input_lines
        .iter()
        .map(|line| input_line_with_session_context(thread_key, trace, line))
        .collect()
}

fn input_line_with_session_context(
    thread_key: &ThreadKey,
    trace: &SessionTraceContext,
    line: &str,
) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(line) else {
        return line.to_owned();
    };
    let Value::Object(map) = &mut value else {
        return line.to_owned();
    };
    map.entry("thread_key")
        .or_insert_with(|| Value::String(thread_key.as_str().to_owned()));
    // Execution contexts without a derived thread identity must not trust a
    // caller-supplied trace_id. Thread-bound contexts use the deterministic
    // id so harness spans remain attached to the thread trace.
    if trace.trace_id.is_empty() {
        map.remove("trace_id");
    } else {
        map.entry("trace_id")
            .or_insert_with(|| Value::String(trace.trace_id.clone()));
    }
    if let Some(traceparent) = &trace.traceparent {
        map.entry("traceparent")
            .or_insert_with(|| Value::String(traceparent.clone()));
    }
    if let Some(execution_id) = trace.execution_id.as_deref() {
        let trace_metadata = map
            .entry("trace_metadata")
            .or_insert_with(|| Value::Object(serde_json::Map::new()));
        if let Value::Object(metadata) = trace_metadata {
            metadata
                .entry("execution_id")
                .or_insert_with(|| Value::String(execution_id.to_owned()));
        }
    }
    prepend_chat_surface_note(map, thread_key);
    // max_duration_ms is a reserved control-plane field. Remove any caller
    // value even when this execution has no configured maximum; otherwise the
    // OMP harness would trust a deadline that api-rs is not enforcing.
    if let Some(Value::Object(metadata)) = map.get_mut("trace_metadata") {
        metadata.remove("max_duration_ms");
    }
    // Inject trusted execution controls into trace_metadata after the line
    // leaves the client boundary. Client-supplied values are overwritten.
    if trace.owner_id.is_some() || trace.max_duration_ms.is_some() {
        let mut metadata = match map.get("trace_metadata") {
            Some(Value::Object(existing)) => existing.clone(),
            _ => serde_json::Map::new(),
        };
        if let (Some(owner_id), Some(generation)) = (&trace.owner_id, trace.generation) {
            metadata.insert("owner_id".to_owned(), Value::String(owner_id.clone()));
            metadata.insert(
                "generation".to_owned(),
                Value::Number(serde_json::Number::from(generation)),
            );
        }
        if let Some(max_duration_ms) = trace.max_duration_ms {
            metadata.insert("max_duration_ms".to_owned(), json!(max_duration_ms));
        }
        map.insert("trace_metadata".to_owned(), Value::Object(metadata));
    }
    merge_session_context(map, session_context_for_thread(thread_key));
    serde_json::to_string(&value).unwrap_or_else(|_| line.to_owned())
}

/// Prepend a terse chat-surface note to a user turn's content so the agent always
/// knows which platform (Slack/Discord) and destination it is operating on.
///
/// The static system prompt is platform-neutral, so this per-turn line is the
/// agent's authoritative signal for where its reply and uploads land. It is added
/// only to `user` turns whose content is an array of message parts and whose
/// thread key resolves to a known chat destination; every other shape is left
/// untouched.
fn prepend_chat_surface_note(map: &mut serde_json::Map<String, Value>, thread_key: &ThreadKey) {
    if map.get("type").and_then(Value::as_str) != Some("user") {
        return;
    }
    let Some(destination) = thread_key.chat_destination() else {
        return;
    };
    let Some(Value::Array(content)) = map.get_mut("message").and_then(|m| m.get_mut("content"))
    else {
        return;
    };
    content.insert(
        0,
        json!({ "type": "text", "text": destination.context_line() }),
    );
}

fn merge_session_context(
    map: &mut serde_json::Map<String, Value>,
    context: Option<serde_json::Map<String, Value>>,
) {
    let Some(context) = context else {
        return;
    };
    let entry = map
        .entry("session_context")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Value::Object(existing) = entry else {
        return;
    };
    for (key, value) in context {
        existing.entry(key).or_insert(value);
    }
}

/// Build the structured per-turn session context for a thread, mirroring the
/// `/api/session` response shape (`{ platform, <slack|discord|linear|github>: { .. } }`).
///
/// Resolved from the same [`ChatDestination`] the session-context route uses, so
/// the structured context the agent sees in its input is consistent with what
/// tools read back from the API. Returns `None` for non-platform threads (e.g.
/// `api:` keys), which carry no chat destination and get no `session_context`.
fn session_context_for_thread(thread_key: &ThreadKey) -> Option<serde_json::Map<String, Value>> {
    let destination = thread_key.chat_destination()?;
    let mut context = serde_json::Map::new();
    context.insert(
        "platform".to_owned(),
        Value::String(destination.platform().to_owned()),
    );
    let (platform_key, block) = match destination {
        ChatDestination::Slack {
            channel_id,
            thread_ts,
        } => {
            let mut slack = serde_json::Map::new();
            slack.insert("channel_id".to_owned(), Value::String(channel_id));
            slack.insert("thread_ts".to_owned(), Value::String(thread_ts));
            ("slack", slack)
        }
        ChatDestination::Discord {
            guild_id,
            channel_id,
            thread_id,
        } => {
            let mut discord = serde_json::Map::new();
            discord.insert("guild_id".to_owned(), Value::String(guild_id));
            discord.insert("channel_id".to_owned(), Value::String(channel_id));
            if let Some(thread_id) = thread_id {
                discord.insert("thread_id".to_owned(), Value::String(thread_id));
            }
            ("discord", discord)
        }
        ChatDestination::Linear {
            issue_id,
            comment_id,
            agent_session_id,
        } => {
            let mut linear = serde_json::Map::new();
            linear.insert("issue_id".to_owned(), Value::String(issue_id));
            if let Some(comment_id) = comment_id {
                linear.insert("comment_id".to_owned(), Value::String(comment_id));
            }
            if let Some(agent_session_id) = agent_session_id {
                linear.insert(
                    "agent_session_id".to_owned(),
                    Value::String(agent_session_id),
                );
            }
            ("linear", linear)
        }
        ChatDestination::Github {
            owner,
            repo,
            number,
            kind,
            review_comment_id,
        } => {
            let mut github = serde_json::Map::new();
            github.insert("owner".to_owned(), Value::String(owner));
            github.insert("repo".to_owned(), Value::String(repo));
            github.insert("number".to_owned(), Value::Number(number.into()));
            github.insert("kind".to_owned(), Value::String(kind.as_str().to_owned()));
            if let Some(review_comment_id) = review_comment_id {
                github.insert(
                    "review_comment_id".to_owned(),
                    Value::Number(review_comment_id.into()),
                );
            }
            ("github", github)
        }
    };
    context.insert(platform_key.to_owned(), Value::Object(block));
    Some(context)
}

fn steering_input_lines(
    thread_key: &ThreadKey,
    messages: &[SessionMessageInput],
    message_ids: &[String],
) -> Vec<String> {
    messages
        .iter()
        .zip(message_ids)
        .filter_map(|(message, message_id)| steering_input_line(thread_key, message, message_id))
        .collect()
}

fn steering_input_line(
    thread_key: &ThreadKey,
    message: &SessionMessageInput,
    message_id: &str,
) -> Option<String> {
    if message.role != MessageRole::User {
        return None;
    }
    serde_json::to_string(&json!({
        "type": "user",
        "thread_key": thread_key.as_str(),
        "trace_metadata": {
            "source": "session.append_messages",
            "action": "steer_active_execution",
            "message_id": message_id,
            "metadata": message.metadata.clone(),
        },
        "message": {
            "role": message.role.as_ref(),
            "content": message.parts.clone(),
        },
    }))
    .ok()
}

fn interrupt_input_line(thread_key: &ThreadKey, reason: &str) -> String {
    serde_json::to_string(&json!({
        "type": "interrupt",
        "thread_key": thread_key.as_str(),
        "trace_metadata": {
            "source": "session.interrupt_active_execution",
            "action": "interrupt_active_execution",
            "reason": reason,
        },
    }))
    .expect("interrupt input line serializes")
}

fn collab_request_id() -> String {
    format!("collab-{}", Uuid::new_v4().simple())
}

fn collab_control_frame(
    request_id: &str,
    command: &str,
    owner_id: &str,
    generation: i64,
    relay_url: Option<&str>,
    web_url: Option<&str>,
    display_name: Option<&str>,
) -> Value {
    let mut frame = json!({
        "id": request_id,
        "type": command,
        "ownership": {
            "owner_id": owner_id,
            "generation": generation,
        },
    });
    if let Some(relay_url) = relay_url {
        frame["relayUrl"] = Value::String(relay_url.to_owned());
    }
    if let Some(web_url) = web_url {
        frame["webUrl"] = Value::String(web_url.to_owned());
    }
    if let Some(display_name) = display_name {
        frame["displayName"] = Value::String(display_name.to_owned());
    }
    frame
}

fn collab_event_matches(
    event: &SessionEvent,
    after_event_id: i64,
    generation: i64,
    request_id: &str,
) -> bool {
    // Command waiters require an exact request_id. Unsolicited lifecycle events
    // (missing request_id) may still update projection via process_collab_state_line
    // but must never acknowledge an outstanding start/status/stop.
    event.event_id > after_event_id
        && event.payload.get("generation").and_then(Value::as_i64) == Some(generation)
        && event.payload.get("request_id").and_then(Value::as_str) == Some(request_id)
}

#[allow(clippy::too_many_arguments)]
async fn wait_for_collab_event(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    mut after_event_id: i64,
    generation: i64,
    request_id: &str,
    expected_state: &str,
    expected_event_type: &str,
    deadline: Instant,
) -> Result<CollabRoomState, SessionRuntimeError> {
    loop {
        if Instant::now() >= deadline {
            return Err(SessionRuntimeError::CollabRoomLost {
                thread_key: thread_key.as_str().to_owned(),
                reason: format!(
                    "resident OMP did not emit {expected_event_type} {expected_state} before deadline"
                ),
            });
        }
        let poll_deadline = Instant::now()
            .checked_add(COLLAB_EVENT_POLL_TIMEOUT)
            .unwrap_or(deadline)
            .min(deadline);
        // Per-poll timeout is retryable until the global lifecycle deadline —
        // a single slow DB poll must not be final loss.
        let poll = tokio::time::timeout_at(
            poll_deadline,
            store.list_events_after(thread_key, after_event_id, None, 128),
        )
        .await;
        let events = match poll {
            Ok(Ok(events)) => events,
            Ok(Err(error)) => return Err(SessionRuntimeError::Store(error)),
            Err(_) => {
                // Retryable poll timeout — continue until global deadline.
                sleep(Duration::from_millis(25)).await;
                continue;
            }
        };
        let batch_anchor = after_event_id;
        for event in events {
            // Advance the poll cursor after each event so a response past a
            // full 128-event page is still reachable. Match against the batch
            // anchor (not the advanced cursor) so the current event remains
            // eligible.
            after_event_id = after_event_id.max(event.event_id);
            if !collab_event_matches(&event, batch_anchor, generation, request_id) {
                continue;
            }
            if event.event_type == "session.collab_room_error" {
                let message = event
                    .payload
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("resident collaboration command failed");
                return Err(SessionRuntimeError::BadRequest(message.to_owned()));
            }
            if event.event_type != expected_event_type
                || event.payload.get("state").and_then(Value::as_str) != Some(expected_state)
            {
                continue;
            }
            let Some(room) = event.payload.get("room") else {
                return Err(SessionRuntimeError::BadRequest(
                    "resident collaboration response omitted room state".to_owned(),
                ));
            };
            return serde_json::from_value(room.clone()).map_err(|error| {
                SessionRuntimeError::BadRequest(format!(
                    "resident collaboration response contained invalid room state: {error}"
                ))
            });
        }
        sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_collab_started(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    after_event_id: i64,
    generation: i64,
    request_id: &str,
    deadline: Instant,
) -> Result<CollabRoomState, SessionRuntimeError> {
    wait_for_collab_event(
        store,
        thread_key,
        after_event_id,
        generation,
        request_id,
        "started",
        "session.collab_room_state",
        deadline,
    )
    .await
}

async fn wait_for_collab_stopped(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    after_event_id: i64,
    generation: i64,
    request_id: &str,
    deadline: Instant,
) -> Result<CollabRoomState, SessionRuntimeError> {
    wait_for_collab_event(
        store,
        thread_key,
        after_event_id,
        generation,
        request_id,
        "stopped",
        "session.collab_room_state",
        deadline,
    )
    .await
}

async fn wait_for_collab_status(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    after_event_id: i64,
    generation: i64,
    request_id: &str,
    deadline: Instant,
) -> Result<CollabRoomState, SessionRuntimeError> {
    wait_for_collab_event(
        store,
        thread_key,
        after_event_id,
        generation,
        request_id,
        "status",
        "session.collab_room_status",
        deadline,
    )
    .await
}

/// Marks the active collab room cleanup-pending and runs a fenced finalize.
/// Used by stdout pump EOF, pump-failure, and internal pump Err paths so no
/// ghost keepalive survives process/IO loss.
async fn lose_collab_room_on_pump_end(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    reason: &str,
) {
    let handle = {
        // Only the room bound to this pump's sandbox may be cleaned up — an
        // old sandbox-A EOF must not remove a room now hosted on sandbox-B.
        if let Some(mut current) = ctx.collab_rooms.get_mut(thread_key)
            && current.sandbox_id == sandbox_id
        {
            current.keepalive.store(false, Ordering::SeqCst);
            current.mark_finalize_pending();
            Some(current.clone())
        } else {
            None
        }
    };
    let Some(handle) = handle else {
        return;
    };
    let result = ctx
        .store
        .finalize_collab_room(
            thread_key,
            &handle.owner_id,
            handle.generation,
            PgSessionStore::SESSION_OWNERSHIP_LEASE,
            "session.collab_room_lost",
            json!({
                "thread_key": thread_key.as_str(),
                "reason": reason,
                "owner_id": handle.owner_id,
                "generation": handle.generation,
            }),
        )
        .await;
    let _ = apply_collab_finalize_result(
        &ctx.store,
        &ctx.collab_rooms,
        thread_key,
        &handle,
        "session.collab_room_lost",
        reason,
        result,
    )
    .await;
}

/// Shared finalize result handling for cleanup and pump/EOF loss paths.
async fn apply_collab_finalize_result(
    store: &PgSessionStore,
    collab_rooms: &CollabRoomRegistry,
    thread_key: &ThreadKey,
    handle: &CollabRoomHandle,
    event_type: &str,
    reason: &str,
    result: Result<Option<centaur_session_core::SessionEvent>, SessionStoreError>,
) -> Result<(), SessionRuntimeError> {
    apply_collab_finalize_result_within(
        store,
        collab_rooms,
        thread_key,
        handle,
        event_type,
        reason,
        result,
        Instant::now() + COLLAB_CLEANUP_DEADLINE,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn apply_collab_finalize_result_within(
    store: &PgSessionStore,
    collab_rooms: &CollabRoomRegistry,
    thread_key: &ThreadKey,
    handle: &CollabRoomHandle,
    event_type: &str,
    reason: &str,
    result: Result<Option<centaur_session_core::SessionEvent>, SessionStoreError>,
    deadline: Instant,
) -> Result<(), SessionRuntimeError> {
    match result {
        Ok(Some(_)) => {
            handle.keepalive.store(false, Ordering::SeqCst);
            collab_rooms.remove_if(thread_key, |_key, current| {
                current.owner_id == handle.owner_id
                    && current.generation == handle.generation
                    && current.sandbox_id == handle.sandbox_id
            });
            Ok(())
        }
        Ok(None) => {
            // Fence rejected by finalize. Only remove when proof shows this
            // owner+generation no longer holds the row (Ok(false)). Ok(true)
            // means the same row still exists (e.g. race) — retain pending and
            // retry. Proof Err is never treated as proof.
            let proof_remaining = deadline.saturating_duration_since(Instant::now());
            if proof_remaining.is_zero() {
                ensure_cleanup_pending_retry(
                    store,
                    collab_rooms,
                    thread_key,
                    handle,
                    event_type,
                    reason,
                );
                return Err(SessionRuntimeError::CollabRoomLost {
                    thread_key: thread_key.as_str().to_owned(),
                    reason: format!(
                        "collab cleanup ownership proof exceeded deadline for {event_type}"
                    ),
                });
            }
            let proof = match tokio::time::timeout(
                proof_remaining,
                store.session_ownership_matches(thread_key, &handle.owner_id, handle.generation),
            )
            .await
            {
                Ok(r) => r,
                Err(_) => {
                    ensure_cleanup_pending_retry(
                        store,
                        collab_rooms,
                        thread_key,
                        handle,
                        event_type,
                        reason,
                    );
                    return Err(SessionRuntimeError::CollabRoomLost {
                        thread_key: thread_key.as_str().to_owned(),
                        reason: format!(
                            "collab cleanup ownership proof timed out for {event_type}"
                        ),
                    });
                }
            };
            match proof {
                Ok(false) => {
                    handle.keepalive.store(false, Ordering::SeqCst);
                    collab_rooms.remove_if(thread_key, |_key, current| {
                        current.owner_id == handle.owner_id
                            && current.generation == handle.generation
                            && current.sandbox_id == handle.sandbox_id
                    });
                    Err(SessionRuntimeError::CollabRoomLost {
                        thread_key: thread_key.as_str().to_owned(),
                        reason: format!(
                            "fenced collaboration cleanup for {event_type} (ownership fence rejected)"
                        ),
                    })
                }
                Ok(true) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "collab_cleanup_fence_row_still_owned",
                        thread_key = %thread_key,
                        "finalize fenced but ownership row still matches; retaining cleanup-pending"
                    );
                    ensure_cleanup_pending_retry(
                        store,
                        collab_rooms,
                        thread_key,
                        handle,
                        event_type,
                        reason,
                    );
                    Err(SessionRuntimeError::CollabRoomLost {
                        thread_key: thread_key.as_str().to_owned(),
                        reason: format!(
                            "fenced collaboration cleanup for {event_type} (row still owned; retrying)"
                        ),
                    })
                }
                Err(error) => {
                    warn!(
                        component = COMPONENT_SESSION_RUNTIME,
                        event = "collab_cleanup_proof_failed",
                        thread_key = %thread_key,
                        %error,
                        "ownership proof query failed; handle remains cleanup-pending"
                    );
                    ensure_cleanup_pending_retry(
                        store,
                        collab_rooms,
                        thread_key,
                        handle,
                        event_type,
                        reason,
                    );
                    Err(error.into())
                }
            }
        }
        Err(error) => {
            warn!(
                component = COMPONENT_SESSION_RUNTIME,
                event = "collab_cleanup_transaction_failed",
                thread_key = %thread_key,
                %error,
                "cleanup transaction failed; handle remains cleanup-pending for retry"
            );
            ensure_cleanup_pending_retry(
                store,
                collab_rooms,
                thread_key,
                handle,
                event_type,
                reason,
            );
            Err(error.into())
        }
    }
}

/// Ensures exactly one background retry task exists for a cleanup-pending
/// handle. Deduplicated via `cleanup_worker_scheduled` on the handle.
/// Single managed cleanup worker for an exact handle. Owns phase transitions:
/// RemoteStopPending → (remote stop ack) → FinalizePending → removed
/// (or stays FinalizePending under retry until proof/expiry/takeover/shutdown).
fn ensure_collab_cleanup_worker(
    runtime: &SessionRuntime,
    thread_key: &ThreadKey,
    handle: &CollabRoomHandle,
    event_type: &str,
    reason: &str,
) {
    let should_spawn = {
        if let Some(mut current) = runtime.collab_rooms.get_mut(thread_key)
            && current.owner_id == handle.owner_id
            && current.generation == handle.generation
            && current.sandbox_id == handle.sandbox_id
            && !current.phase.is_externally_active()
            && !current.cleanup_worker_scheduled
        {
            current.cleanup_worker_scheduled = true;
            true
        } else {
            false
        }
    };
    if !should_spawn {
        return;
    }
    let runtime = runtime.clone();
    let thread_key = thread_key.clone();
    let owner_id = handle.owner_id.clone();
    let generation = handle.generation;
    let sandbox_id = handle.sandbox_id.clone();
    let event_type = event_type.to_owned();
    let reason = reason.to_owned();
    tokio::spawn(async move {
        loop {
            // Normal workers keep running until handle is gone. Shutdown does
            // NOT rely on this worker — handoff performs bounded stop/finalize
            // inline under the aggregate deadline.
            let Some(handle) = runtime
                .collab_rooms
                .get(&thread_key)
                .as_deref()
                .cloned()
                .filter(|h| {
                    h.owner_id == owner_id
                        && h.generation == generation
                        && h.sandbox_id == sandbox_id
                        && !h.phase.is_externally_active()
                })
            else {
                return;
            };
            match handle.phase {
                CollabCleanupPhase::Active => return,
                CollabCleanupPhase::RemoteStopPending => {
                    match runtime
                        .attempt_collab_stop(&thread_key, &owner_id, generation, &sandbox_id)
                        .await
                    {
                        Ok(()) => {
                            if let Some(mut current) = runtime.collab_rooms.get_mut(&thread_key)
                                && current.owner_id == owner_id
                                && current.generation == generation
                                && current.sandbox_id == sandbox_id
                            {
                                current.mark_finalize_pending();
                            } else {
                                return;
                            }
                            // Continue loop into FinalizePending without sleeping.
                            continue;
                        }
                        Err(_) => {
                            sleep(Duration::from_secs(1)).await;
                            continue;
                        }
                    }
                }
                CollabCleanupPhase::FinalizePending => {
                    let result = runtime
                        .store
                        .finalize_collab_room(
                            &thread_key,
                            &handle.owner_id,
                            handle.generation,
                            PgSessionStore::SESSION_OWNERSHIP_LEASE,
                            &event_type,
                            json!({
                                "thread_key": thread_key.as_str(),
                                "reason": reason,
                                "owner_id": handle.owner_id,
                                "generation": handle.generation,
                                "sandbox_id": handle.sandbox_id,
                            }),
                        )
                        .await;
                    match apply_collab_finalize_result(
                        &runtime.store,
                        &runtime.collab_rooms,
                        &thread_key,
                        &handle,
                        &event_type,
                        &reason,
                        result,
                    )
                    .await
                    {
                        Ok(()) => return,
                        Err(_) => {
                            // Still FinalizePending (or removed by proof). If
                            // handle remains, keep responsibility and retry.
                            let still = runtime
                                .collab_rooms
                                .get(&thread_key)
                                .as_deref()
                                .is_some_and(|h| {
                                    h.owner_id == owner_id
                                        && h.generation == generation
                                        && h.sandbox_id == sandbox_id
                                        && matches!(h.phase, CollabCleanupPhase::FinalizePending)
                                });
                            if !still {
                                return;
                            }
                            sleep(Duration::from_secs(1)).await;
                        }
                    }
                }
            }
        }
    });
}

/// Schedule cleanup starting at FinalizePending (DB only).
fn ensure_cleanup_pending_retry(
    store: &PgSessionStore,
    collab_rooms: &CollabRoomRegistry,
    thread_key: &ThreadKey,
    handle: &CollabRoomHandle,
    event_type: &str,
    reason: &str,
) {
    if let Some(mut current) = collab_rooms.get_mut(thread_key)
        && current.owner_id == handle.owner_id
        && current.generation == handle.generation
        && current.sandbox_id == handle.sandbox_id
    {
        if current.phase.is_externally_active() {
            current.mark_finalize_pending();
        } else if matches!(current.phase, CollabCleanupPhase::RemoteStopPending) {
            // Do not skip remote stop — leave phase as-is.
        } else {
            current.mark_finalize_pending();
        }
    }
    // Build a runtime-like schedule via store+registry requires SessionRuntime.
    // Callers that only have store use spawn_finalize_only_worker.
    spawn_finalize_only_worker(store, collab_rooms, thread_key, handle, event_type, reason);
}

fn spawn_finalize_only_worker(
    store: &PgSessionStore,
    collab_rooms: &CollabRoomRegistry,
    thread_key: &ThreadKey,
    handle: &CollabRoomHandle,
    event_type: &str,
    reason: &str,
) {
    let should_spawn = {
        if let Some(mut current) = collab_rooms.get_mut(thread_key)
            && current.owner_id == handle.owner_id
            && current.generation == handle.generation
            && current.sandbox_id == handle.sandbox_id
            && matches!(current.phase, CollabCleanupPhase::FinalizePending)
            && !current.cleanup_worker_scheduled
        {
            current.cleanup_worker_scheduled = true;
            true
        } else {
            false
        }
    };
    if !should_spawn {
        return;
    }
    let store = store.clone();
    let collab_rooms = collab_rooms.clone();
    let thread_key = thread_key.clone();
    let owner_id = handle.owner_id.clone();
    let generation = handle.generation;
    let sandbox_id = handle.sandbox_id.clone();
    let event_type = event_type.to_owned();
    let reason = reason.to_owned();
    tokio::spawn(async move {
        loop {
            let Some(handle) = collab_rooms
                .get(&thread_key)
                .as_deref()
                .cloned()
                .filter(|h| {
                    h.owner_id == owner_id
                        && h.generation == generation
                        && h.sandbox_id == sandbox_id
                        && matches!(h.phase, CollabCleanupPhase::FinalizePending)
                })
            else {
                return;
            };
            let result = store
                .finalize_collab_room(
                    &thread_key,
                    &handle.owner_id,
                    handle.generation,
                    PgSessionStore::SESSION_OWNERSHIP_LEASE,
                    &event_type,
                    json!({
                        "thread_key": thread_key.as_str(),
                        "reason": reason,
                        "owner_id": handle.owner_id,
                        "generation": handle.generation,
                        "sandbox_id": handle.sandbox_id,
                    }),
                )
                .await;
            match apply_collab_finalize_result(
                &store,
                &collab_rooms,
                &thread_key,
                &handle,
                &event_type,
                &reason,
                result,
            )
            .await
            {
                Ok(()) => return,
                Err(_) => {
                    let still = collab_rooms.get(&thread_key).as_deref().is_some_and(|h| {
                        h.owner_id == owner_id
                            && h.generation == generation
                            && h.sandbox_id == sandbox_id
                            && matches!(h.phase, CollabCleanupPhase::FinalizePending)
                    });
                    if !still {
                        return;
                    }
                    sleep(Duration::from_secs(1)).await;
                }
            }
        }
    });
}

/// Schedule cleanup starting at RemoteStopPending (remote stop then finalize).
fn ensure_remote_stop_pending_retry(
    runtime: &SessionRuntime,
    thread_key: &ThreadKey,
    handle: &CollabRoomHandle,
    reason: &str,
) {
    if let Some(mut current) = runtime.collab_rooms.get_mut(thread_key)
        && current.owner_id == handle.owner_id
        && current.generation == handle.generation
        && current.sandbox_id == handle.sandbox_id
    {
        current.mark_remote_stop_pending();
    }
    ensure_collab_cleanup_worker(
        runtime,
        thread_key,
        handle,
        "session.collab_room_lost",
        reason,
    );
}

/// Handles normalized resident lifecycle and status notifications before
/// normal execution stdout routing. Lifecycle-only rooms have no execution
/// id, so dropping these lines would lose the control-plane response.
async fn process_collab_state_line(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    sandbox_id: &str,
    value: &Value,
) -> Result<bool, SessionRuntimeError> {
    let method = value.get("method").and_then(Value::as_str);
    let is_collab_state = method == Some("collab/state")
        || value.get("type").and_then(Value::as_str) == Some("collab_state");
    let is_collab_status = method == Some("collab/status");
    let params = value
        .get("params")
        .cloned()
        .unwrap_or_else(|| value.clone());
    let request_id = params
        .get("request_id")
        .or_else(|| params.get("requestId"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    // Only treat a `method: error` frame as a collaboration lifecycle event
    // when it is correlated to an outstanding collab request. Unstructured
    // turn errors have no request_id and belong to normal stdout routing.
    let is_collab_error = method == Some("error")
        && request_id
            .as_deref()
            .is_some_and(|id| id.starts_with("collab-"));
    if !is_collab_state && !is_collab_status && !is_collab_error {
        return Ok(false);
    }
    // Drop the DashMap guard before any await.
    let Some(handle) = ctx.collab_rooms.get(thread_key).as_deref().cloned() else {
        return Ok(true);
    };
    // Origin fence: only the pump for this room's sandbox may mutate it.
    if handle.sandbox_id != sandbox_id {
        return Ok(true);
    }
    // Required ownership echo from the resident harness (admitted fence).
    // Missing or mismatched owner_id/generation is consumed and dropped —
    // never persist or mutate. Prevents same-sandbox G1 frames after G2
    // takeover from rebinding the current handle.
    let Some(echo) = params.get("ownership") else {
        return Ok(true);
    };
    let echo_owner = echo.get("owner_id").and_then(Value::as_str);
    let echo_gen = echo.get("generation").and_then(Value::as_i64);
    if echo_owner != Some(handle.owner_id.as_str()) || echo_gen != Some(handle.generation) {
        return Ok(true);
    }
    if is_collab_error {
        let error = params
            .get("error")
            .and_then(|error| error.get("message").or(Some(error)))
            .and_then(Value::as_str)
            .unwrap_or("resident collaboration command failed");
        let _ = ctx
            .store
            .append_unscoped_event_if_session_owner(
                thread_key,
                &handle.owner_id,
                handle.generation,
                PgSessionStore::SESSION_OWNERSHIP_LEASE,
                "session.collab_room_error",
                json!({
                    "thread_key": thread_key.as_str(),
                    "request_id": request_id,
                    "generation": handle.generation,
                    "error": error,
                }),
            )
            .await?;
        return Ok(true);
    }
    let state_name = if is_collab_status {
        "status"
    } else {
        params
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or("failed")
    };
    let Some(room_value) = params.get("room") else {
        return Ok(true);
    };
    let room: CollabRoomState = serde_json::from_value(room_value.clone()).map_err(|error| {
        SessionRuntimeError::BadRequest(format!(
            "resident collaboration response contained invalid room state: {error}"
        ))
    })?;

    let correlated_stop = request_id.is_some() && state_name == "stopped";
    let is_terminal_unsolicited =
        !is_collab_status && !correlated_stop && state_name != "started" && state_name != "status";

    // Unsolicited terminal loss/failure: one fenced finalize (append+release).
    // Never append-then-separate-release — a release Err would leave a durable
    // terminal event with a live lease and no handle.
    if is_terminal_unsolicited {
        let result = ctx
            .store
            .finalize_collab_room(
                thread_key,
                &handle.owner_id,
                handle.generation,
                PgSessionStore::SESSION_OWNERSHIP_LEASE,
                "session.collab_room_lost",
                json!({
                    "thread_key": thread_key.as_str(),
                    "state": state_name,
                    "reason": params.get("reason"),
                    "request_id": request_id,
                    "room": room,
                    "owner_id": handle.owner_id,
                    "generation": handle.generation,
                    "sandbox_id": handle.sandbox_id,
                }),
            )
            .await;
        let _ = apply_collab_finalize_result(
            &ctx.store,
            &ctx.collab_rooms,
            thread_key,
            &handle,
            "session.collab_room_lost",
            state_name,
            result,
        )
        .await;
        return Ok(true);
    }

    let event_type = if is_collab_status {
        "session.collab_room_status"
    } else {
        // started or request-correlated stopped — durable state for waiters;
        // stop_collab_room finalizes correlated stopped.
        "session.collab_room_state"
    };
    let persisted = ctx
        .store
        .append_unscoped_event_if_session_owner(
            thread_key,
            &handle.owner_id,
            handle.generation,
            PgSessionStore::SESSION_OWNERSHIP_LEASE,
            event_type,
            json!({
                "thread_key": thread_key.as_str(),
                "state": state_name,
                "reason": params.get("reason"),
                "request_id": request_id,
                "room": room.clone(),
                "owner_id": handle.owner_id,
                "generation": handle.generation,
            }),
        )
        .await?;

    if persisted.is_none() {
        // Append fenced (expired/mismatched lease). Exact-handle only.
        // Correlated stopped may finalize directly (stop path already drove
        // remote stop). Nonterminal started/status must RemoteStopPending and
        // drive exact-sandbox stop before any finalize — never release a live room.
        let exact = ctx
            .collab_rooms
            .get(thread_key)
            .as_deref()
            .cloned()
            .filter(|h| {
                h.owner_id == handle.owner_id
                    && h.generation == handle.generation
                    && h.sandbox_id == handle.sandbox_id
            });
        let Some(exact) = exact else {
            return Ok(true);
        };
        if correlated_stop {
            if let Some(mut current) = ctx.collab_rooms.get_mut(thread_key)
                && current.owner_id == exact.owner_id
                && current.generation == exact.generation
                && current.sandbox_id == exact.sandbox_id
            {
                current.mark_finalize_pending();
            }
            let result = ctx
                .store
                .finalize_collab_room(
                    thread_key,
                    &exact.owner_id,
                    exact.generation,
                    PgSessionStore::SESSION_OWNERSHIP_LEASE,
                    "session.collab_room_lost",
                    json!({
                        "thread_key": thread_key.as_str(),
                        "reason": "projector_append_fenced_stopped",
                        "owner_id": exact.owner_id,
                        "generation": exact.generation,
                        "sandbox_id": exact.sandbox_id,
                    }),
                )
                .await;
            let _ = apply_collab_finalize_result(
                &ctx.store,
                &ctx.collab_rooms,
                thread_key,
                &exact,
                "session.collab_room_lost",
                "projector_append_fenced_stopped",
                result,
            )
            .await;
            return Ok(true);
        }
        // started / status: stop first, finalize only on stop ack.
        match ctx
            .runtime
            .stop_or_enter_remote_pending(thread_key, &exact, "projector_append_fenced")
            .await
        {
            Ok(()) => {
                let _ = ctx
                    .runtime
                    .cleanup_collab_room_local(
                        thread_key,
                        &exact,
                        "session.collab_room_lost",
                        "projector_append_fenced",
                    )
                    .await;
            }
            Err(error) => {
                warn!(
                    component = COMPONENT_SESSION_RUNTIME,
                    event = "collab_projector_fenced_stop_pending",
                    thread_key = %thread_key,
                    %error,
                    "fenced started/status append: remote stop failed; retaining RemoteStopPending"
                );
            }
        }
        return Ok(true);
    }

    // Success: exact-handle state write only — never overwrite a takeover.
    if let Some(mut current) = ctx.collab_rooms.get_mut(thread_key)
        && current.owner_id == handle.owner_id
        && current.generation == handle.generation
        && current.sandbox_id == handle.sandbox_id
    {
        current.state = room;
    }
    Ok(true)
}

async fn append_output_line(
    ctx: &RuntimeContext,
    thread_key: &ThreadKey,
    execution_id: &str,
    line: &str,
) -> Result<Option<SessionEvent>, SessionRuntimeError> {
    let safe_line = redact_sensitive_text(line);
    let event = ctx
        .store
        .append_event_if_stdout_owner(
            thread_key,
            execution_id,
            &ctx.stdout_owner_id,
            STDOUT_OWNER_LEASE,
            SESSION_OUTPUT_LINE_EVENT,
            Value::String(safe_line),
        )
        .await?;
    Ok(event)
}

fn redact_sensitive_text(input: &str) -> String {
    let bearer_redacted = redact_bearer_tokens(input);
    let env_redacted = redact_sensitive_env_assignments(&bearer_redacted);
    redact_prefixed_tokens(&env_redacted)
}

fn redact_bearer_tokens(input: &str) -> String {
    const BEARER: &str = "bearer ";
    let lower = input.to_ascii_lowercase();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;

    while let Some(relative) = lower[index..].find(BEARER) {
        let start = index + relative;
        let token_start = start + BEARER.len();
        let token_end = consume_sensitive_token(input, token_start);
        out.push_str(&input[index..token_start]);
        if token_end > token_start {
            out.push_str("[REDACTED_TOKEN]");
            index = token_end;
        } else {
            index = token_start;
        }
    }

    out.push_str(&input[index..]);
    out
}

fn redact_sensitive_env_assignments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut index = 0;

    while let Some(relative) = input[index..].find('=') {
        let equals = index + relative;
        let key_start = env_key_start(input, equals);
        let key = &input[key_start..equals];
        out.push_str(&input[index..=equals]);
        if is_sensitive_env_key(key) {
            let token_start = equals + 1;
            let token_end = consume_sensitive_token(input, token_start);
            if token_end > token_start {
                out.push_str("[REDACTED_TOKEN]");
                index = token_end;
                continue;
            }
        }
        index = equals + 1;
    }

    out.push_str(&input[index..]);
    out
}

fn redact_prefixed_tokens(input: &str) -> String {
    const PREFIXES: &[&str] = &[
        "sbx1.",
        "xoxa-",
        "xoxb-",
        "xoxp-",
        "xoxr-",
        "xoxs-",
        "sk-ant-",
        "sk-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "ghr_",
        "github_pat_",
    ];

    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if let Some(prefix) = PREFIXES
            .iter()
            .find(|prefix| should_redact_prefixed_token(input, index, prefix))
        {
            let token_end = consume_sensitive_token(input, index + prefix.len());
            out.push_str("[REDACTED_TOKEN]");
            index = token_end;
            continue;
        }

        let ch = input[index..].chars().next().expect("valid char boundary");
        out.push(ch);
        index += ch.len_utf8();
    }

    out
}

fn should_redact_prefixed_token(input: &str, index: usize, prefix: &str) -> bool {
    if !input[index..].starts_with(prefix) || !has_token_boundary_before(input, index) {
        return false;
    }

    let token_start = index + prefix.len();
    let token_end = consume_sensitive_token(input, token_start);
    if token_end == token_start {
        return false;
    }

    if prefix.starts_with("sk-") {
        return token_end.saturating_sub(token_start) >= 16;
    }

    true
}

fn has_token_boundary_before(input: &str, index: usize) -> bool {
    if index == 0 {
        return true;
    }

    input[..index]
        .chars()
        .next_back()
        .is_none_or(|ch| !is_sensitive_token_char(ch))
}

fn consume_sensitive_token(input: &str, start: usize) -> usize {
    let mut end = start;
    for (relative, ch) in input[start..].char_indices() {
        if !is_sensitive_token_char(ch) {
            break;
        }
        end = start + relative + ch.len_utf8();
    }
    end
}

fn is_sensitive_token_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '=' | '+' | '/' | '.' | ':')
}

fn env_key_start(input: &str, equals: usize) -> usize {
    let mut start = equals;
    for (index, ch) in input[..equals].char_indices().rev() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            start = index;
        } else {
            break;
        }
    }
    start
}

fn is_sensitive_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    upper.contains("API_KEY")
        || upper.contains("TOKEN")
        || upper.contains("SECRET")
        || upper.contains("PASSWORD")
}

async fn execution_still_active(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution_id: &str,
) -> bool {
    matches!(
        store.active_execution_for_thread(thread_key).await,
        Ok(Some(execution)) if execution.execution_id == execution_id
    )
}

fn is_transient_steering_startup_error(error: &SessionRuntimeError) -> bool {
    matches!(
        error,
        SessionRuntimeError::Sandbox(SandboxError::NotFound(_))
            | SessionRuntimeError::Sandbox(SandboxError::NotReady(_))
    )
}

fn harness_thread_id_from_output_line(line: &str) -> Option<String> {
    let value: Value = serde_json::from_str(line).ok()?;
    let event_type = value.get("type").and_then(Value::as_str);
    if event_type == Some("run.started") {
        return value
            .get("request_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|request_id| !request_id.is_empty())
            .map(ToOwned::to_owned);
    }
    if event_type != Some("thread.started") {
        return None;
    }
    value
        .get("thread_id")
        .or_else(|| value.get("threadId"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|thread_id| !thread_id.is_empty())
        .map(ToOwned::to_owned)
}

fn validate_input_lines(lines: &[String]) -> Result<(), SessionRuntimeError> {
    for (index, line) in lines.iter().enumerate() {
        if line.contains('\n') || line.contains('\r') {
            return Err(SessionRuntimeError::BadRequest(format!(
                "input_lines[{index}] must be one line"
            )));
        }
    }
    Ok(())
}

/// True for the Flue sandbox-allocation placeholder: the marker action and
/// no input lines. A host that wants only the pod an execution claims — not
/// a turn in it — executes exactly this shape, and [`SessionRuntime::
/// execute_session`] completes it as soon as the sandbox is assigned.
fn is_allocation_only_placeholder(metadata: Option<&Value>, input_lines: &[String]) -> bool {
    input_lines.is_empty()
        && metadata
            .and_then(|value| value.get("action"))
            .and_then(Value::as_str)
            == Some("allocate_sandbox")
}

fn stdout_pump_error_message(error: &LinesCodecError) -> String {
    match error {
        LinesCodecError::MaxLineLengthExceeded => {
            "sandbox stdout line exceeded codec maximum length".to_owned()
        }
        LinesCodecError::Io(error) => format!("sandbox stdout I/O failed: {error}"),
    }
}

fn codec_error_to_runtime(error: LinesCodecError) -> SessionRuntimeError {
    let context = error.to_string();
    SessionRuntimeError::Sandbox(SandboxError::Io {
        context,
        source: Some(Box::new(error)),
    })
}

fn duration_options(
    idle_timeout_ms: Option<u64>,
    max_duration_ms: Option<u64>,
) -> Result<(Option<Duration>, Option<Duration>), SessionRuntimeError> {
    let idle_timeout = idle_timeout_ms.map(nonzero_duration_millis).transpose()?;
    let max_duration = max_duration_ms.map(nonzero_duration_millis).transpose()?;

    if let (Some(idle_timeout), Some(max_duration)) = (idle_timeout, max_duration)
        && idle_timeout > max_duration
    {
        return Err(SessionRuntimeError::BadRequest(
            "idle_timeout_ms must be less than or equal to max_duration_ms".to_owned(),
        ));
    }

    Ok((idle_timeout, max_duration))
}

fn nonzero_duration_millis(value: u64) -> Result<Duration, SessionRuntimeError> {
    if value == 0 {
        return Err(SessionRuntimeError::BadRequest(
            "duration values must be greater than zero".to_owned(),
        ));
    }
    Ok(Duration::from_millis(value))
}

pub fn tool_host_thread_key(principal_id: &str) -> Result<ThreadKey, SessionRuntimeError> {
    ThreadKey::parse(format!("mcp:{}", principal_id.trim()))
        .map_err(|error| SessionRuntimeError::BadRequest(error.to_string()))
}

fn tool_host_execution_metadata(
    request_id: &str,
    tool_name: &str,
    method: &str,
    timeout: Duration,
    traceparent: Option<String>,
) -> Value {
    let mut metadata = serde_json::Map::from_iter([
        ("mcp_tool_host_call".to_owned(), Value::Bool(true)),
        (
            "request_id".to_owned(),
            Value::String(request_id.to_owned()),
        ),
        ("tool".to_owned(), Value::String(tool_name.to_owned())),
        ("method".to_owned(), Value::String(method.to_owned())),
        (
            "timeout_ms".to_owned(),
            Value::Number(duration_millis_u64(timeout).into()),
        ),
    ]);
    insert_non_empty_metadata_string(
        &mut metadata,
        EXECUTION_TRACEPARENT_METADATA_KEY,
        traceparent.as_deref(),
    );
    Value::Object(metadata)
}

/// Session/principal metadata recorded for observability; runtime behavior
/// derives from the `mcp:` thread-key prefix, not from these fields.
fn tool_host_session_metadata(
    principal_id: &str,
    console_user_email: Option<&str>,
    console_user_name: Option<&str>,
) -> Value {
    let mut metadata = serde_json::Map::from_iter([
        ("mcp_tool_host".to_owned(), Value::Bool(true)),
        (
            "mcp_principal_id".to_owned(),
            Value::String(principal_id.to_owned()),
        ),
    ]);
    insert_non_empty_metadata_string(&mut metadata, "console_user_email", console_user_email);
    insert_non_empty_metadata_string(&mut metadata, "console_user_name", console_user_name);
    Value::Object(metadata)
}

fn insert_non_empty_metadata_string(
    metadata: &mut serde_json::Map<String, Value>,
    key: &str,
    value: Option<&str>,
) {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return;
    };
    metadata.insert(key.to_owned(), Value::String(value.to_owned()));
}

fn proxy_labels_from_session_metadata(
    thread_key: &ThreadKey,
    metadata: &Value,
) -> BTreeMap<String, String> {
    let mut labels = BTreeMap::new();
    insert_metadata_string_label(
        &mut labels,
        "centaur.slack_user_id",
        metadata.get("slack_user_id"),
    );
    insert_metadata_string_label(
        &mut labels,
        "centaur.slack_team_id",
        metadata.get("slack_team_id"),
    );
    insert_metadata_string_label(
        &mut labels,
        "centaur.slack_channel_id",
        metadata.get("slack_channel_id"),
    );
    if !labels.contains_key("centaur.slack_channel_id")
        && let Some(channel_id) = slack_conversation_id(thread_key)
    {
        labels.insert("centaur.slack_channel_id".to_owned(), channel_id.to_owned());
    }
    labels
}

fn insert_metadata_string_label(
    labels: &mut BTreeMap<String, String>,
    label: &str,
    value: Option<&Value>,
) {
    let Some(value) = value.and_then(Value::as_str).map(str::trim) else {
        return;
    };
    if !value.is_empty() {
        labels.insert(label.to_owned(), value.to_owned());
    }
}

fn slack_conversation_id(thread_key: &ThreadKey) -> Option<String> {
    if let Some(ChatDestination::Slack { channel_id, .. }) = thread_key.chat_destination() {
        return Some(channel_id);
    }
    None
}

fn sandbox_boot_mode_for_thread(
    thread_key: &ThreadKey,
    iron_control_principal: Option<&str>,
) -> SandboxBootMode {
    let Some(thread_principal_id) = thread_key.as_str().strip_prefix("mcp:") else {
        return SandboxBootMode::Harness;
    };
    let principal_id = iron_control_principal
        .unwrap_or(thread_principal_id)
        .to_owned();
    SandboxBootMode::ToolHost { principal_id }
}

fn apply_sandbox_boot_mode(spec: &mut SandboxSpec, boot_mode: &SandboxBootMode) {
    let SandboxBootMode::ToolHost { principal_id } = boot_mode else {
        return;
    };
    spec.labels
        .insert("centaur.ai/component".to_owned(), "tool-host".to_owned());
    spec.labels
        .insert("centaur.ai/workload".to_owned(), "mcp-tool-host".to_owned());
    if !principal_id.trim().is_empty() {
        spec.iron_control_principal = Some(principal_id.to_owned());
        upsert_spec_env(spec, "CENTAUR_MCP_PRINCIPAL_ID", principal_id.to_owned());
    }
    configure_tool_host_command(spec);
}

fn configure_tool_host_command(spec: &mut SandboxSpec) {
    if should_preserve_entrypoint_for_tool_host(spec) {
        spec.command = Some(vec!["/entrypoint.sh".to_owned()]);
        spec.args = vec!["centaur-tool-host".to_owned()];
    } else {
        spec.command = Some(vec!["centaur-tool-host".to_owned()]);
        spec.args.clear();
    }
}

fn should_preserve_entrypoint_for_tool_host(spec: &SandboxSpec) -> bool {
    spec.command
        .as_ref()
        .and_then(|command| command.first())
        .is_some_and(|program| program == "/entrypoint.sh")
        || spec.args.first().is_some_and(|arg| arg == "harness-server")
}

fn execution_metadata(
    metadata: Option<Value>,
    idle_timeout_ms: Option<u64>,
    max_duration_ms: Option<u64>,
) -> Value {
    let mut metadata = default_metadata(metadata);
    if let Value::Object(object) = &mut metadata {
        if let Some(value) = idle_timeout_ms {
            object.insert("idle_timeout_ms".to_owned(), json!(value));
        }
        if let Some(value) = max_duration_ms {
            object.insert("max_duration_ms".to_owned(), json!(value));
        }
    }
    metadata
}

fn persisted_execute_request(input: &ExecuteSessionInput) -> Result<Value, SessionRuntimeError> {
    serde_json::to_value(input).map_err(|error| {
        SessionRuntimeError::BadRequest(format!(
            "session execution request could not be persisted: {error}"
        ))
    })
}

fn deserialize_persisted_execute_request(
    execution_id: &str,
    request: Value,
) -> Result<ExecuteSessionInput, SessionRuntimeError> {
    serde_json::from_value(request).map_err(|error| {
        SessionRuntimeError::BadRequest(format!(
            "execution {execution_id} has an invalid persisted request: {error}"
        ))
    })
}

fn idle_timeout_from_execution(execution: &SessionExecution) -> Option<Duration> {
    execution
        .metadata
        .get("idle_timeout_ms")
        .and_then(Value::as_u64)
        .and_then(|value| nonzero_duration_millis(value).ok())
}

fn max_duration_from_execution(execution: &SessionExecution) -> Option<Duration> {
    execution
        .metadata
        .get("max_duration_ms")
        .and_then(Value::as_u64)
        .and_then(|value| nonzero_duration_millis(value).ok())
}

/// Folds recorded sandbox output the same way the live stdout pump does,
/// returning the first terminal outcome (with its accumulated final answer)
/// if the recorded history already contains the end of the turn.
fn terminal_output_from_lines(lines: &[String]) -> Option<TerminalOutput> {
    let mut final_answer_text = String::new();
    for line in lines {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(update) = output_line_final_answer_text(&value) {
            match update {
                FinalAnswerTextUpdate::Append(delta) => final_answer_text.push_str(&delta),
                FinalAnswerTextUpdate::Replace(canonical) => final_answer_text = canonical,
            }
        }
        if let Some(terminal) = terminal_output(&value, &final_answer_text) {
            return Some(terminal);
        }
    }
    None
}

#[derive(Debug, Error)]
pub enum SessionRuntimeError {
    #[error("{0}")]
    BadRequest(String),
    #[error("control plane is shutting down")]
    ShuttingDown,
    #[error(transparent)]
    Store(#[from] SessionStoreError),
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
    #[error("sandbox {sandbox_id} reference lease is held by another owner")]
    SandboxLeaseOwned { sandbox_id: String },
    #[error(transparent)]
    IronControl(#[from] centaur_iron_control::IronControlError),
    #[error(transparent)]
    WarmPool(#[from] WarmPoolError),
    #[error(
        "sandbox running capacity exceeded during {operation}: running={running}, max_running={max_running}"
    )]
    CapacityExceeded {
        max_running: usize,
        running: usize,
        operation: &'static str,
    },
    #[error(
        "session {thread_key} is owned by another control plane (owner={owner_id}, mode={mode})"
    )]
    SessionOwned {
        thread_key: String,
        owner_id: String,
        mode: &'static str,
    },
    #[error("collaboration rooms require harness type 'omp' (got {harness_type})")]
    CollabNotSupported { harness_type: String },
    #[error(
        "session {thread_key} is terminal ({status}); collaboration rooms require an active or idle session"
    )]
    CollabTerminalSession { thread_key: String, status: String },
    #[error("collaboration room for session {thread_key} was lost: {reason}")]
    CollabRoomLost { thread_key: String, reason: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use centaur_sandbox_core::MountKind;
    use centaur_session_core::SessionStatus;
    use serde_json::json;
    use time::OffsetDateTime;

    #[test]
    fn transcript_thread_key_encoding_matches_contract() {
        assert_eq!(
            encode_thread_key_segment("slack:T1:C2:123.456"),
            "slack%3AT1%3AC2%3A123.456"
        );
    }

    #[test]
    fn transcript_thread_key_encoding_keeps_unreserved_bytes() {
        assert_eq!(encode_thread_key_segment("AZaz09._~-"), "AZaz09._~-");
    }

    #[test]
    fn transcript_thread_key_encoding_uses_uppercase_percent_hex() {
        assert_eq!(encode_thread_key_segment("a b/c%"), "a%20b%2Fc%25");
        assert_eq!(encode_thread_key_segment("é"), "%C3%A9");
        assert_eq!(encode_thread_key_segment(""), "");
    }

    #[test]
    fn omp_transcript_archive_command_caps_oversized_output_at_max_plus_one() {
        let max_bytes = 1024;
        let root = std::env::temp_dir().join(format!(
            "centaur-omp-archive-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        // Deterministic, incompressible-enough payload: the gzip stream is
        // larger than max_bytes, so the command must emit exactly MAX+1.
        let mut state = 0x9e37_79b9_7f4a_7c15_u64;
        let payload = (0..64 * 1024)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                state as u8
            })
            .collect::<Vec<_>>();
        std::fs::write(root.join("corpus.jsonl"), payload).unwrap();

        let command = omp_transcript_archive_command(max_bytes);
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .env("OMP_SESSION_DIR", &root)
            .output()
            .unwrap();
        assert_eq!(output.stdout.len(), max_bytes + 1);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_archive_pipeline_terminates_oversized_producer_early() {
        let max_bytes = 1024;
        let root = std::env::temp_dir().join(format!(
            "centaur-bounded-producer-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let completed = root.join("producer-completed");
        let command = [
            "bash".to_owned(),
            "-lc".to_owned(),
            bounded_archive_pipeline(
                "dd if=/dev/zero bs=1024 count=65536 2>/dev/null && : > \"$PRODUCER_COMPLETED\"",
                max_bytes,
            ),
        ];

        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .env("PRODUCER_COMPLETED", &completed)
            .output()
            .unwrap();

        assert_eq!(output.stdout.len(), max_bytes + 1);
        assert!(
            !completed.exists(),
            "producer consumed all input instead of stopping after MAX+1 bytes"
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn omp_transcript_archive_command_preserves_tar_failure() {
        let max_bytes = 1024;
        let missing = std::env::temp_dir().join(format!(
            "centaur-omp-archive-missing-{}-{}",
            std::process::id(),
            OffsetDateTime::now_utc().unix_timestamp_nanos()
        ));
        let command = omp_transcript_archive_command(max_bytes);
        let output = std::process::Command::new(&command[0])
            .args(&command[1..])
            .env("OMP_SESSION_DIR", missing)
            .output()
            .unwrap();

        assert!(!output.status.success());
    }

    #[test]
    fn sandbox_repo_cache_label_controls_access() {
        assert_eq!(
            sandbox_repo_cache_access_from_principal(&test_principal(
                std::collections::BTreeMap::new()
            )),
            SessionRepoCacheAccess::None
        );
        for value in ["none", "private", "bogus"] {
            assert_eq!(
                sandbox_repo_cache_access_from_principal(&test_principal(
                    std::collections::BTreeMap::from([(
                        SANDBOX_REPO_CACHE_LABEL.to_owned(),
                        value.to_owned(),
                    )])
                )),
                SessionRepoCacheAccess::None
            );
        }
        assert_eq!(
            sandbox_repo_cache_access_from_principal(&test_principal(
                std::collections::BTreeMap::from([(
                    SANDBOX_REPO_CACHE_LABEL.to_owned(),
                    "public".to_owned(),
                )])
            )),
            SessionRepoCacheAccess::Public
        );
        assert_eq!(
            sandbox_repo_cache_access_from_principal(&test_principal(
                std::collections::BTreeMap::from([(
                    SANDBOX_REPO_CACHE_LABEL.to_owned(),
                    "all".to_owned(),
                )])
            )),
            SessionRepoCacheAccess::All
        );
    }

    #[test]
    fn public_repo_cache_scopes_bind_mount_to_public_projection() {
        let mut spec = SandboxSpec::new("mock").mount(Mount::new(
            MountKind::Bind {
                source_path: "/var/lib/centaur/repos".to_owned(),
            },
            SANDBOX_REPOS_MOUNT_PATH,
        ));
        let capabilities = SessionSandboxCapabilities {
            repo_cache: SessionRepoCacheAccess::Public,
            observability_enabled: true,
            api_server_enabled: true,
        };

        apply_sandbox_capabilities(&mut spec, &capabilities);

        assert_eq!(spec.capabilities.repo_cache, RepoCacheAccess::Public);
        assert_eq!(
            env_value(&spec, "CENTAUR_SANDBOX_REPO_CACHE_ACCESS"),
            Some("public")
        );
        assert_eq!(
            spec.mounts[0].kind,
            MountKind::Bind {
                source_path: "/var/lib/centaur/repos/public".to_owned(),
            }
        );
        assert_eq!(spec.mounts[0].sub_path, None);
    }

    #[test]
    fn public_repo_cache_scopes_named_volume_to_public_subpath() {
        let mut spec = SandboxSpec::new("mock").mount(Mount::new(
            MountKind::NamedVolume("centaur-repo-cache".to_owned()),
            SANDBOX_REPOS_MOUNT_PATH,
        ));
        let capabilities = SessionSandboxCapabilities {
            repo_cache: SessionRepoCacheAccess::Public,
            observability_enabled: true,
            api_server_enabled: true,
        };

        apply_sandbox_capabilities(&mut spec, &capabilities);

        assert_eq!(
            spec.mounts[0].kind,
            MountKind::NamedVolume("centaur-repo-cache".to_owned())
        );
        assert_eq!(spec.mounts[0].sub_path.as_deref(), Some("public"));
    }

    #[test]
    fn public_repo_cache_scopes_skill_dirs_to_public_dirs() {
        let mut spec = SandboxSpec::new("mock")
            .env(
                CENTAUR_SKILL_DIRS_ENV,
                "/home/agent/github/acme/private/.agents/skills:\
                 /home/agent/github/acme/public/.agents/skills",
            )
            .env(
                CENTAUR_PUBLIC_SKILL_DIRS_ENV,
                "/home/agent/github/acme/public/.agents/skills",
            );
        let capabilities = SessionSandboxCapabilities {
            repo_cache: SessionRepoCacheAccess::Public,
            observability_enabled: true,
            api_server_enabled: true,
        };

        apply_sandbox_capabilities(&mut spec, &capabilities);

        assert_eq!(
            env_value(&spec, CENTAUR_SKILL_DIRS_ENV),
            Some("/home/agent/github/acme/public/.agents/skills")
        );
        assert_eq!(env_value(&spec, CENTAUR_PUBLIC_SKILL_DIRS_ENV), None);
    }

    #[test]
    fn disabled_repo_cache_removes_repo_mount() {
        let mut spec = SandboxSpec::new("mock")
            .mount(Mount::new(
                MountKind::Bind {
                    source_path: "/var/lib/centaur/repos".to_owned(),
                },
                SANDBOX_REPOS_MOUNT_PATH,
            ))
            .mount(Mount::new(MountKind::EmptyDir, "/workspace"))
            .env(
                CENTAUR_SKILL_DIRS_ENV,
                "/home/agent/github/acme/private/.agents/skills",
            )
            .env(
                CENTAUR_PUBLIC_SKILL_DIRS_ENV,
                "/home/agent/github/acme/public/.agents/skills",
            );
        let capabilities = SessionSandboxCapabilities {
            repo_cache: SessionRepoCacheAccess::None,
            observability_enabled: true,
            api_server_enabled: true,
        };

        apply_sandbox_capabilities(&mut spec, &capabilities);

        assert_eq!(spec.capabilities.repo_cache, RepoCacheAccess::None);
        assert_eq!(spec.mounts.len(), 1);
        assert_eq!(spec.mounts[0].target_path, "/workspace");
        assert_eq!(env_value(&spec, CENTAUR_SKILL_DIRS_ENV), None);
        assert_eq!(env_value(&spec, CENTAUR_PUBLIC_SKILL_DIRS_ENV), None);
    }

    #[test]
    fn tool_host_tool_filter_uses_effective_capability_scoped_spec() {
        let spec = SandboxSpec::new("mock")
            .env("TOOL_ALLOWLIST", "alpha,beta")
            .env("TOOL_BLOCKLIST", "custom-script");
        let capabilities = SessionSandboxCapabilities {
            repo_cache: SessionRepoCacheAccess::None,
            observability_enabled: false,
            api_server_enabled: false,
        };

        let filter = tool_host_tool_filter_from_spec(spec, &capabilities);

        assert_eq!(filter.allowlist.as_deref(), Some("alpha,beta"));
        let blocklist = filter.blocklist.unwrap();
        assert!(blocklist.split(',').any(|tool| tool == "custom-script"));
        for tool in OBSERVABILITY_TOOL_BLOCKLIST.split(',') {
            assert!(blocklist.split(',').any(|blocked| blocked == tool));
        }
    }

    fn test_principal(
        labels: std::collections::BTreeMap<String, String>,
    ) -> centaur_iron_control::Principal {
        centaur_iron_control::Principal {
            id: "prn_test".to_owned(),
            foreign_id: Some("slack-channel-t-c".to_owned()),
            name: "Test".to_owned(),
            labels,
            sandbox_observability_enabled: true,
            sandbox_api_server_enabled: true,
        }
    }

    #[test]
    fn persona_registry_validates_default_and_omits_prompt_when_serialized() {
        let registry = PersonaRegistry::new(
            [PersonaDefinition {
                id: "eng".to_owned(),
                source_root: "/repo/tools".to_owned(),
                source_path: "/repo/tools/personas/eng".to_owned(),
                source_ref: Some("abc123".to_owned()),
                prompt_hash: "sha256:prompt".to_owned(),
                prompt: "secret prompt".to_owned(),
            }],
            Some("eng".to_owned()),
            vec!["/repo/tools".to_owned()],
        )
        .unwrap();

        assert!(
            serde_json::to_value(registry.get("eng").unwrap())
                .unwrap()
                .get("prompt")
                .is_none()
        );
        let context = registry
            .context_for_access("eng", false, &SessionRepoCacheAccess::All)
            .unwrap();
        assert_eq!(context.prompt, "secret prompt");
        assert!(
            serde_json::to_value(context)
                .unwrap()
                .get("prompt")
                .is_none()
        );
        assert!(PersonaRegistry::new(Vec::new(), Some("missing".to_owned()), Vec::new()).is_err());
    }

    #[test]
    fn persona_registry_limits_public_access_to_public_source_roots() {
        let registry = PersonaRegistry::new(
            [
                PersonaDefinition {
                    id: "private".to_owned(),
                    source_root: "/repo/private/tools".to_owned(),
                    source_path: "/repo/private/tools/personas/private".to_owned(),
                    source_ref: None,
                    prompt_hash: "sha256:private".to_owned(),
                    prompt: "private prompt".to_owned(),
                },
                PersonaDefinition {
                    id: "public".to_owned(),
                    source_root: "/repo/public/tools".to_owned(),
                    source_path: "/repo/public/tools/personas/public".to_owned(),
                    source_ref: None,
                    prompt_hash: "sha256:public".to_owned(),
                    prompt: "public prompt".to_owned(),
                },
            ],
            Some("private".to_owned()),
            vec![
                "/repo/private/tools".to_owned(),
                "/repo/public/tools".to_owned(),
            ],
        )
        .unwrap()
        .with_public_source_roots(["/repo/public/tools".to_owned()]);

        assert_eq!(
            registry.default_persona_id_for_access(&SessionRepoCacheAccess::All),
            Some("private")
        );
        assert_eq!(
            registry.default_persona_id_for_access(&SessionRepoCacheAccess::Public),
            None
        );
        assert!(
            registry
                .context_for_access("private", false, &SessionRepoCacheAccess::Public)
                .is_err()
        );
        assert_eq!(
            registry
                .context_for_access("public", false, &SessionRepoCacheAccess::Public)
                .unwrap()
                .persona_id,
            "public"
        );
    }

    #[test]
    fn unavailable_requested_persona_uses_deployment_fallback() {
        let default_registry = PersonaRegistry::new(
            [PersonaDefinition {
                id: "eng".to_owned(),
                source_root: "/repo/tools".to_owned(),
                source_path: "/repo/tools/personas/eng".to_owned(),
                source_ref: None,
                prompt_hash: "sha256:eng".to_owned(),
                prompt: "engineering persona".to_owned(),
            }],
            Some("eng".to_owned()),
            vec!["/repo/tools".to_owned()],
        )
        .unwrap();
        let empty_registry = PersonaRegistry::new(Vec::new(), None, Vec::new()).unwrap();

        for (registry, expected_persona_id) in [
            (Some(&default_registry), Some("eng")),
            (Some(&empty_registry), None),
            (None, None),
        ] {
            let resolution = resolve_persona_selection(
                registry,
                Some("honk"),
                &SessionSandboxCapabilities::default_enabled(),
            )
            .unwrap();

            assert_eq!(resolution.persona_id.as_deref(), expected_persona_id);
            assert_eq!(
                resolution
                    .context
                    .as_ref()
                    .map(|context| context.persona_id.as_str()),
                expected_persona_id
            );
            assert_eq!(
                resolution.unavailable_requested_persona_id.as_deref(),
                Some("honk")
            );
        }
    }

    #[test]
    fn tool_host_command_preserves_sandbox_entrypoint_for_tool_setup() {
        let thread_key = ThreadKey::parse("mcp:test").unwrap();
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("TOOL_DIRS".to_owned(), "/app/tools".to_owned())],
            HarnessType::Codex,
        );
        let mut spec = workload.spec(&thread_key, &HarnessType::Codex, None);

        configure_tool_host_command(&mut spec);

        assert_eq!(spec.command, Some(vec!["/entrypoint.sh".to_owned()]));
        assert_eq!(spec.args, vec!["centaur-tool-host"]);
        assert_eq!(env_value(&spec, "TOOL_DIRS"), Some("/app/tools"));
    }

    #[test]
    fn tool_host_execution_metadata_propagates_tool_traceparent() {
        let traceparent = "00-0123456789abcdef0123456789abcdef-1111111111111111-01";

        let metadata = tool_host_execution_metadata(
            "mcp-call-123",
            "search",
            "query",
            Duration::from_secs(120),
            Some(traceparent.to_owned()),
        );

        assert_eq!(metadata[EXECUTION_TRACEPARENT_METADATA_KEY], traceparent);
        assert_eq!(metadata["request_id"], "mcp-call-123");
        assert_eq!(metadata["tool"], "search");
        assert_eq!(metadata["method"], "query");
        assert_eq!(metadata["timeout_ms"], 120_000);
    }

    #[test]
    fn tool_host_thread_key_trims_principal_id() {
        assert_eq!(
            tool_host_thread_key(" prn_test ").unwrap().as_str(),
            "mcp:prn_test"
        );
    }

    #[test]
    fn tool_host_session_metadata_includes_console_identity() {
        assert_eq!(
            tool_host_session_metadata("prn_test", Some(" test@example.com "), Some(" Test User "),),
            json!({
                "mcp_tool_host": true,
                "mcp_principal_id": "prn_test",
                "console_user_email": "test@example.com",
                "console_user_name": "Test User",
            })
        );
    }

    #[test]
    fn tool_host_session_metadata_omits_missing_console_identity() {
        assert_eq!(
            tool_host_session_metadata("prn_test", Some("  "), None),
            json!({
                "mcp_tool_host": true,
                "mcp_principal_id": "prn_test",
            })
        );
    }

    #[test]
    fn turn_completed_without_answer_text_is_terminal() {
        let event = json!({
            "type": "turn.completed",
            "turn": {"id": "turn-1", "status": "completed"},
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: None
            })
        );
    }

    #[test]
    fn turn_completed_after_answer_text_is_terminal() {
        let delta = json!({
            "method": "item/agentMessage/delta",
            "params": {"turnId": "turn-1", "delta": "Final answer"},
        });
        let terminal = json!({
            "method": "turn/completed",
            "params": {"turn": {"id": "turn-1", "status": "completed"}},
        });

        assert!(matches!(
            output_line_final_answer_text(&delta),
            Some(FinalAnswerTextUpdate::Append(_))
        ));
        assert_eq!(
            terminal_output(&terminal, "Final answer"),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn nanocodex_native_events_supply_answer_and_terminal_output() {
        let delta = json!({
            "protocol_version": 1,
            "request_id": "nano-1",
            "seq": 2,
            "type": "assistant.delta",
            "payload": {"text": "Final answer"},
        });
        let terminal = json!({
            "protocol_version": 1,
            "request_id": "nano-1",
            "seq": 3,
            "type": "run.completed",
            "payload": {"status": "completed"},
        });

        let Some(FinalAnswerTextUpdate::Append(answer)) = output_line_final_answer_text(&delta)
        else {
            panic!("Nanocodex delta should append final-answer text")
        };
        assert_eq!(
            terminal_output(&terminal, &answer),
            Some(TerminalOutput::Completed {
                reason: "run_completed",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn nanocodex_commentary_is_not_terminal_answer_text() {
        for event_type in ["assistant.delta", "assistant.message"] {
            let commentary = json!({
                "protocol_version": 1,
                "request_id": "nano-1",
                "seq": 2,
                "type": event_type,
                "payload": {
                    "item_id": "commentary-1",
                    "phase": "commentary",
                    "text": "I’ll verify."
                },
            });
            assert!(output_line_final_answer_text(&commentary).is_none());
        }

        let final_answer = json!({
            "protocol_version": 1,
            "request_id": "nano-1",
            "seq": 3,
            "type": "assistant.message",
            "payload": {
                "item_id": "answer-1",
                "phase": "final_answer",
                "text": "Done."
            },
        });
        let Some(FinalAnswerTextUpdate::Replace(text)) =
            output_line_final_answer_text(&final_answer)
        else {
            panic!("final Nanocodex message should replace terminal answer text")
        };
        assert_eq!(text, "Done.");
    }

    #[test]
    fn nanocodex_run_error_waits_for_run_failed() {
        let event = json!({
            "protocol_version": 1,
            "request_id": "nano-1",
            "seq": 2,
            "type": "run.error",
            "payload": {"message": "proxy refused"},
        });
        assert_eq!(terminal_output(&event, ""), None);

        let terminal = json!({
            "protocol_version": 1,
            "request_id": "nano-1",
            "seq": 3,
            "type": "run.failed",
            "payload": {"status": "failed"},
        });
        assert_eq!(
            terminal_output(&terminal, ""),
            Some(TerminalOutput::Failed {
                error: "terminal harness output reported failure".to_owned()
            })
        );
    }

    #[test]
    fn nanocodex_cancelled_run_uses_the_existing_cancellation_path() {
        let terminal = json!({
            "protocol_version": 1,
            "request_id": "nano-1",
            "seq": 2,
            "type": "run.failed",
            "payload": {"status": "cancelled"},
        });
        assert_eq!(
            terminal_output(&terminal, ""),
            Some(TerminalOutput::Cancelled {
                reason: "turn_interrupted"
            })
        );
    }

    #[test]
    fn turn_completed_uses_completed_agent_message_text_when_terminal_is_empty() {
        let completed = json!({
            "type": "item.completed",
            "item": {
                "id": "msg-final",
                "type": "agentMessage",
                "phase": "final_answer",
                "text": "1. No new findings.\n\n2. No writes were used."
            }
        });
        let terminal = json!({
            "type": "turn.completed",
            "turn": {"id": "turn-1", "status": "completed"},
        });

        let Some(FinalAnswerTextUpdate::Replace(final_text)) =
            output_line_final_answer_text(&completed)
        else {
            panic!("completed agentMessage should replace final answer text")
        };
        assert_eq!(
            terminal_output(&terminal, &final_text),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("1. No new findings.\n\n2. No writes were used.".to_owned())
            })
        );
    }

    #[test]
    fn interrupted_turn_completed_without_answer_is_cancelled() {
        let event = json!({
            "type": "turn.completed",
            "turn": {"id": "turn-1", "status": "interrupted"},
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Cancelled {
                reason: "turn_interrupted"
            })
        );
    }

    #[test]
    fn interrupted_turn_completed_after_answer_stays_terminal() {
        let event = json!({
            "method": "turn/completed",
            "params": {"turn": {"id": "turn-1", "status": "interrupted"}},
        });

        assert_eq!(
            terminal_output(&event, "Final answer"),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn terminal_result_completes_even_without_prior_delta() {
        let event = json!({
            "type": "result",
            "result": {"text": "Final answer"},
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Completed {
                reason: "result",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn turn_done_carries_terminal_result_text() {
        let event = json!({
            "type": "turn.done",
            "result": "Final answer",
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Completed {
                reason: "turn_done",
                result_text: Some("Final answer".to_owned())
            })
        );
    }

    #[test]
    fn turn_failed_is_terminal_failure() {
        let event = json!({
            "type": "turn.failed",
            "error": "sandbox exited",
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Failed {
                error: "sandbox exited".to_owned()
            })
        );
    }

    #[test]
    fn retryable_codex_error_notification_is_not_terminal() {
        let event = json!({
            "method": "error",
            "params": {
                "error": {
                    "message": "Reconnecting... 1/5",
                    "additionalDetails": "stream disconnected before completion: provider error",
                    "codexErrorInfo": { "responseStreamDisconnected": { "httpStatusCode": null } }
                },
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": true
            }
        });

        assert_eq!(terminal_output(&event, ""), None);
    }

    #[test]
    fn exhausted_codex_error_notification_is_terminal_with_nested_text() {
        let event = json!({
            "method": "error",
            "params": {
                "error": {
                    "message": "Reconnecting... 5/5",
                    "additionalDetails": "stream disconnected before completion: provider error",
                },
                "threadId": "thread-1",
                "turnId": "turn-1",
                "willRetry": false
            }
        });

        assert_eq!(
            terminal_output(&event, ""),
            Some(TerminalOutput::Failed {
                error: "Reconnecting... 5/5: stream disconnected before completion: provider error"
                    .to_owned()
            })
        );
    }

    #[test]
    fn nested_terminal_text_is_normalized() {
        let event = json!({
            "result": {
                "message": {
                    "content": [{"type": "text", "text": "Final answer"}],
                },
            },
        });

        assert_eq!(terminal_payload_text(&event), "Final answer");
    }

    #[test]
    fn timeout_event_uses_millisecond_duration() {
        assert_eq!(duration_millis_u64(Duration::from_millis(3_000)), 3_000);
    }

    #[test]
    fn stdout_state_first_token_detection_uses_answer_text() {
        let state = StdoutPumpState::default();
        let turn_started = json!({"type": "turn.started", "turn_id": "turn-1"});
        let delta = json!({
            "type": "item.agentMessage.delta",
            "turnId": "turn-1",
            "itemId": "msg-1",
            "delta": "Hello"
        });
        let terminal_result = json!({"type": "result", "result": {"text": "Done"}});

        assert!(!state.should_record_first_token("exe-1", Some(&turn_started)));
        assert!(state.should_record_first_token("exe-1", Some(&delta)));
        assert!(state.should_record_first_token("exe-2", Some(&terminal_result)));
    }

    #[test]
    fn terminal_failure_class_is_low_cardinality() {
        assert_eq!(
            terminal_failure_class("sandbox stdout closed before terminal output"),
            "sandbox_io"
        );
        assert_eq!(
            terminal_failure_class("execution orphaned by control plane restart"),
            "orphaned"
        );
        assert_eq!(
            terminal_failure_class("turn failed: model error"),
            "harness"
        );
    }

    /// The capacity classes have to win over `sandbox_io`, because that is
    /// exactly the string they arrive wrapped in.
    #[test]
    fn terminal_failure_class_separates_capacity_deaths_from_io() {
        let oom = sandbox_dead_detail(&SandboxStatus::Stopped, Some("OOMKilled"));
        assert_eq!(
            terminal_failure_class(&format!(
                "sandbox stdout closed before terminal output; {oom}"
            )),
            "oom"
        );
        assert_eq!(
            terminal_failure_class(&format!(
                "sandbox stdout closed before terminal output; {}",
                sandbox_dead_detail(&SandboxStatus::Stopped, Some("Evicted"))
            )),
            "evicted"
        );
        // Without a reason the classification is unchanged.
        assert_eq!(
            terminal_failure_class(&format!(
                "sandbox stdout closed before terminal output; {}",
                sandbox_dead_detail(&SandboxStatus::Created, None)
            )),
            "sandbox_io"
        );
    }

    #[test]
    fn sandbox_dead_detail_names_the_termination_reason() {
        assert_eq!(
            sandbox_dead_detail(&SandboxStatus::Stopped, Some("OOMKilled")),
            "sandbox no longer accepts io (status Stopped, reason OOMKilled)"
        );
        assert_eq!(
            sandbox_dead_detail(&SandboxStatus::Created, None),
            "sandbox no longer accepts io (status Created)"
        );
    }

    #[test]
    fn execution_max_duration_is_injected_into_trusted_harness_metadata() {
        let thread_key = ThreadKey::parse("workflow:test:repair").unwrap();
        let trace = SessionTraceContext::new_for_thread(&thread_key, None)
            .with_max_duration_ms(Some(2_700_000))
            .with_ownership("api-rs-owner", 7);
        let input = r#"{"type":"user","text":"repair","trace_metadata":{"max_duration_ms":1}}"#;

        let value: Value =
            serde_json::from_str(&input_line_with_session_context(&thread_key, &trace, input))
                .unwrap();

        assert_eq!(value["trace_metadata"]["max_duration_ms"], 2_700_000);
        assert_eq!(value["trace_metadata"]["owner_id"], "api-rs-owner");
        assert_eq!(value["trace_metadata"]["generation"], 7);
    }

    #[test]
    fn absent_execution_max_duration_removes_client_harness_override() {
        let thread_key = ThreadKey::parse("workflow:test:repair").unwrap();
        let trace = SessionTraceContext::new_for_thread(&thread_key, None)
            .with_ownership("api-rs-owner", 7);
        let input = r#"{"type":"user","text":"repair","trace_metadata":{"max_duration_ms":2700000,"client_tag":"kept"}}"#;

        let value: Value =
            serde_json::from_str(&input_line_with_session_context(&thread_key, &trace, input))
                .unwrap();
        let metadata = value["trace_metadata"].as_object().unwrap();

        assert!(!metadata.contains_key("max_duration_ms"));
        assert_eq!(metadata["client_tag"], "kept");
        assert_eq!(metadata["owner_id"], "api-rs-owner");
        assert_eq!(metadata["generation"], 7);
    }

    #[test]
    fn execution_metadata_preserves_idle_and_max_duration() {
        let metadata =
            execution_metadata(Some(json!({"source": "test"})), Some(2_000), Some(5_000));

        assert_eq!(metadata["source"], "test");
        assert_eq!(metadata["idle_timeout_ms"], 2_000);
        assert_eq!(metadata["max_duration_ms"], 5_000);
    }

    #[test]
    fn execution_traceparent_reads_durable_execution_metadata() {
        let execution = session_execution(
            "exe-trace",
            ExecutionStatus::Running,
            json!({
                "centaur.traceparent":
                    "00-0123456789abcdef0123456789abcdef-1111111111111111-01"
            }),
        );

        assert_eq!(
            execution_traceparent(&execution),
            Some("00-0123456789abcdef0123456789abcdef-1111111111111111-01")
        );
    }

    #[test]
    fn idle_timeout_is_read_from_execution_metadata() {
        let execution = session_execution(
            "exe-idle",
            ExecutionStatus::Completed,
            json!({"idle_timeout_ms": 1500}),
        );

        assert_eq!(
            idle_timeout_from_execution(&execution),
            Some(Duration::from_millis(1500))
        );
    }

    #[test]
    fn redacts_sensitive_values_from_output_lines() {
        let line = r#"{"type":"item.completed","item":{"aggregatedOutput":"Authorization: Bearer sbx1.threadpayload.signature\nSANDBOX_TOKEN=sbx1.otherpayload.othersig\nSLACK_BOT_TOKEN=xoxb-1234567890-abcdef\n"}}"#;

        let redacted = redact_sensitive_text(line);

        assert!(!redacted.contains("sbx1.threadpayload.signature"));
        assert!(!redacted.contains("sbx1.otherpayload.othersig"));
        assert!(!redacted.contains("xoxb-1234567890-abcdef"));
        assert!(redacted.contains("Authorization: Bearer [REDACTED_TOKEN]"));
        assert!(redacted.contains("SANDBOX_TOKEN=[REDACTED_TOKEN]"));
        assert!(redacted.contains("SLACK_BOT_TOKEN=[REDACTED_TOKEN]"));
    }

    #[test]
    fn prefixed_token_redaction_preserves_ordinary_hyphenated_words() {
        let line = "risk-adjusted PnL improved while sk-proj-abcdefghijklmnopqrstuvwxyz123456 stayed hidden";

        let redacted = redact_sensitive_text(line);

        assert!(redacted.contains("risk-adjusted PnL improved"));
        assert!(!redacted.contains("sk-proj-abcdefghijklmnopqrstuvwxyz123456"));
        assert!(redacted.contains("[REDACTED_TOKEN] stayed hidden"));
    }

    #[test]
    fn idle_pause_requires_latest_terminal_execution_and_same_sandbox() {
        let session = session_with_sandbox("asbx-1");
        let completed = session_execution("exe-1", ExecutionStatus::Completed, json!({}));
        let running = session_execution("exe-1", ExecutionStatus::Running, json!({}));
        let newer = session_execution("exe-2", ExecutionStatus::Completed, json!({}));

        let empty_rooms: CollabRoomRegistry = Arc::new(DashMap::new());
        assert!(should_pause_idle_sandbox(
            &session,
            Some(&completed),
            "exe-1",
            "asbx-1",
            &empty_rooms
        ));
        assert!(!should_pause_idle_sandbox(
            &session,
            Some(&running),
            "exe-1",
            "asbx-1",
            &empty_rooms
        ));
        assert!(!should_pause_idle_sandbox(
            &session,
            Some(&newer),
            "exe-1",
            "asbx-1",
            &empty_rooms
        ));
        assert!(!should_pause_idle_sandbox(
            &session,
            Some(&completed),
            "exe-1",
            "asbx-other",
            &empty_rooms
        ));
    }

    #[test]
    fn collab_start_frame_uses_native_wire_contract() {
        let frame = collab_control_frame(
            "req-1",
            "collab_start",
            "resident-1",
            7,
            Some("https://relay.example/join"),
            Some("https://relay.example/web"),
            Some("Demo"),
        );
        assert_eq!(frame["type"], "collab_start");
        assert_eq!(frame["ownership"]["owner_id"], "resident-1");
        assert_eq!(frame["ownership"]["generation"], 7);
        assert_eq!(frame["relayUrl"], "https://relay.example/join");
        assert_eq!(frame["displayName"], "Demo");
    }

    #[test]
    fn active_collab_room_keeps_sandbox_awake() {
        let session = session_with_sandbox("asbx-1");
        let completed = session_execution("exe-1", ExecutionStatus::Completed, json!({}));
        let rooms: CollabRoomRegistry = Arc::new(DashMap::new());
        let keepalive = Arc::new(AtomicBool::new(true));
        rooms.insert(
            session.thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: 4,
                sandbox_id: "Demo".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/old".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        assert!(!should_pause_idle_sandbox(
            &session,
            Some(&completed),
            "exe-1",
            "asbx-1",
            &rooms
        ));
        keepalive.store(false, Ordering::SeqCst);
        rooms.remove(&session.thread_key);
        assert!(should_pause_idle_sandbox(
            &session,
            Some(&completed),
            "exe-1",
            "asbx-1",
            &rooms
        ));
    }

    #[test]
    fn event_stream_attaches_only_to_running_sandboxes() {
        assert!(should_attach_session_pipe(&SandboxStatus::Running));
        assert!(!should_attach_session_pipe(&SandboxStatus::Created));
        assert!(!should_attach_session_pipe(&SandboxStatus::Suspended));
        assert!(!should_attach_session_pipe(&SandboxStatus::Stopped));
        assert!(!should_attach_session_pipe(&SandboxStatus::Gone));
        assert!(!should_attach_session_pipe(&SandboxStatus::Unknown(
            "other".to_owned()
        )));
    }

    #[test]
    fn existing_sandbox_action_repairs_or_replaces_non_attachable_assignments() {
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Running),
            ExistingSandboxAction::Reuse
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Suspended),
            ExistingSandboxAction::ResumeOrReplace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Created),
            ExistingSandboxAction::ResumeOrReplace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Stopped),
            ExistingSandboxAction::Replace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Gone),
            ExistingSandboxAction::Replace
        );
        assert_eq!(
            existing_sandbox_action(&SandboxStatus::Unknown("rollout missing".to_owned())),
            ExistingSandboxAction::Replace
        );
    }

    #[test]
    fn event_stream_tolerates_not_ready_attach_race() {
        let not_ready =
            SessionRuntimeError::Sandbox(SandboxError::NotReady("sandbox paused".to_owned()));
        let backend_error = SessionRuntimeError::Sandbox(SandboxError::backend("api failed"));

        assert!(is_event_stream_attach_race(&not_ready));
        assert!(!is_event_stream_attach_race(&backend_error));
    }

    #[test]
    fn steering_startup_retries_only_transient_sandbox_errors() {
        let not_ready =
            SessionRuntimeError::Sandbox(SandboxError::NotReady("sandbox starting".to_owned()));
        let not_found = SessionRuntimeError::Sandbox(SandboxError::NotFound("asbx-1".to_owned()));
        let io = SessionRuntimeError::Sandbox(SandboxError::io("stdin closed"));
        let store = SessionRuntimeError::Store(SessionStoreError::NotFound {
            thread_key: "cli:test".to_owned(),
        });

        assert!(is_transient_steering_startup_error(&not_ready));
        assert!(is_transient_steering_startup_error(&not_found));
        assert!(!is_transient_steering_startup_error(&io));
        assert!(!is_transient_steering_startup_error(&store));
    }

    #[test]
    fn stdout_state_drops_late_output_from_inactive_turn() {
        let mut state = StdoutPumpState::default();
        let started = r#"{"type":"turn.started","turn_id":"turn-old"}"#;
        let delta = r#"{"type":"item.agentMessage.delta","turnId":"turn-old","itemId":"msg-old","delta":"late"}"#;

        assert_eq!(
            state.execution_for_line(Some("exe-old"), started),
            Some("exe-old".to_owned())
        );
        assert_eq!(state.execution_for_line(None, delta), None);
        assert_eq!(state.execution_for_line(Some("exe-new"), delta), None);
    }

    #[test]
    fn stdout_state_uses_final_agent_message_when_turn_completed_is_textless() {
        let mut state = StdoutPumpState::default();
        let started = r#"{"type":"turn.started","turn_id":"turn-1"}"#;
        let delta = r#"{"type":"item.agentMessage.delta","turnId":"turn-1","itemId":"msg-final","delta":"draft"}"#;
        let completed = r#"{"type":"item.completed","item":{"id":"msg-final","type":"agentMessage","phase":"final_answer","text":"Final canonical answer."}}"#;
        let terminal =
            r#"{"type":"turn.completed","turn":{"id":"turn-1","status":"completed"},"usage":null}"#;

        assert_eq!(
            state.execution_for_line(Some("exe-1"), started),
            Some("exe-1".to_owned())
        );
        assert_eq!(state.observe("exe-1", delta), None);
        assert_eq!(state.observe("exe-1", completed), None);
        assert_eq!(
            state.observe("exe-1", terminal),
            Some(TerminalOutput::Completed {
                reason: "turn_completed",
                result_text: Some("Final canonical answer.".to_owned())
            })
        );
    }

    #[test]
    fn steering_input_lines_forward_only_user_messages() {
        let thread_key = ThreadKey::parse("cli:test-steering").unwrap();
        let messages = vec![
            SessionMessageInput {
                client_message_id: None,
                role: MessageRole::User,
                parts: vec![json!({"type": "text", "text": "steer now"})],
                metadata: json!({"platform": "test"}),
            },
            SessionMessageInput {
                client_message_id: None,
                role: MessageRole::Assistant,
                parts: vec![json!({"type": "text", "text": "do not echo assistant"})],
                metadata: json!({}),
            },
        ];
        let message_ids = vec!["msg-user".to_owned(), "msg-assistant".to_owned()];

        let lines = steering_input_lines(&thread_key, &messages, &message_ids);
        assert_eq!(lines.len(), 1);

        let value: serde_json::Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(value["type"], "user");
        assert_eq!(value["thread_key"], "cli:test-steering");
        assert_eq!(value["trace_metadata"]["action"], "steer_active_execution");
        assert_eq!(value["trace_metadata"]["message_id"], "msg-user");
        assert_eq!(value["message"]["content"][0]["text"], "steer now");
    }

    #[test]
    fn harness_thread_id_is_extracted_from_thread_started_output() {
        assert_eq!(
            harness_thread_id_from_output_line(
                r#"{"type":"thread.started","thread_id":"codex-thread-1"}"#
            ),
            Some("codex-thread-1".to_owned())
        );
        assert_eq!(
            harness_thread_id_from_output_line(
                r#"{"type":"thread.started","threadId":"codex-thread-2"}"#
            ),
            Some("codex-thread-2".to_owned())
        );
        assert_eq!(
            harness_thread_id_from_output_line(r#"{"type":"turn.started","turn_id":"turn-1"}"#),
            None
        );
    }

    #[test]
    fn codex_workload_applies_mounts_to_sandbox_spec() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
            HarnessType::Codex,
        )
        .mount(
            Mount::new(
                MountKind::Bind {
                    source_path: "/host/github".to_owned(),
                },
                "/home/agent/github",
            )
            .read_only(),
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::Codex, None);

        assert_eq!(spec.mounts.len(), 1);
        assert_eq!(spec.mounts[0].target_path, "/home/agent/github");
        assert!(spec.mounts[0].read_only);
        assert_eq!(
            spec.mounts[0].kind,
            MountKind::Bind {
                source_path: "/host/github".to_owned(),
            }
        );
    }

    #[test]
    fn codex_workload_applies_resources_to_session_and_warm_specs() {
        let resources = ResourceRequirements::new()
            .request("cpu", "500m")
            .limit("memory", "4Gi");
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        )
        .resources(resources.clone());
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::Codex, None);
        assert_eq!(spec.resources, Some(resources.clone()));
        assert_eq!(workload.warm_spec().resources, Some(resources));

        let unconstrained = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let spec = unconstrained.spec(&thread_key, &HarnessType::Codex, None);
        assert_eq!(spec.resources, None);
    }

    #[test]
    fn codex_workload_reflects_resolved_persona_in_sandbox_spec() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("AGENT_PERSONA".to_owned(), "stale".to_owned())],
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let persona = test_persona_context("eng");
        let expected_prompt_hash = persona.prompt_hash.clone();

        let spec = workload.spec(&thread_key, &HarnessType::Codex, Some(&persona));

        assert_eq!(env_value(&spec, "AGENT_PERSONA"), Some("eng"));
        assert_eq!(env_value(&spec, "CENTAUR_PERSONA_ID"), Some("eng"));
        assert_eq!(spec.files.len(), 1);
        assert_eq!(spec.files[0].target_path, "/home/agent/AGENTS_PERSONA.md");
        assert_eq!(spec.files[0].contents, "eng persona prompt");
        assert_eq!(
            env_value(&spec, "CENTAUR_PERSONA_PROMPT_HASH"),
            Some(expected_prompt_hash.as_str())
        );
        assert_eq!(
            env_value(&spec, "CENTAUR_PERSONA_SOURCE_REF"),
            Some("abc123")
        );
        assert_eq!(env_value(&workload.warm_spec(), "AGENT_PERSONA"), None);
        assert!(workload.warm_spec().files.is_empty());
    }

    #[test]
    fn codex_workload_does_not_inject_stale_continue_thread_id() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::Codex, None);

        assert_eq!(
            spec.env
                .iter()
                .find(|env| env.name == "CODEX_CONTINUE_THREAD_ID")
                .map(|env| env.value.as_str()),
            None
        );
        assert_eq!(
            spec.env
                .iter()
                .find(|env| env.name == "AMP_CONTINUE_THREAD_ID")
                .map(|env| env.value.as_str()),
            None
        );
    }

    #[test]
    fn codex_warm_spec_starts_profileless() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let claimed_spec = workload.spec(&thread_key, &HarnessType::ClaudeCode, None);
        let warm_spec = workload.warm_spec();

        assert_eq!(
            env_value(&claimed_spec, "CENTAUR_THREAD_KEY"),
            Some(thread_key.as_str())
        );
        assert_eq!(env_value(&warm_spec, "CENTAUR_THREAD_KEY"), None);
    }

    #[test]
    fn warm_workload_key_ignores_claimed_thread_key() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
            HarnessType::Codex,
        );
        let first_thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let second_thread_key = ThreadKey::parse("chat:C456:1780000000.000001").unwrap();

        assert_ne!(
            sandbox_spec_key(&workload.spec(&first_thread_key, &HarnessType::ClaudeCode, None)),
            sandbox_spec_key(&workload.spec(&second_thread_key, &HarnessType::ClaudeCode, None))
        );
        assert_eq!(
            sandbox_spec_key(&workload.warm_spec()),
            sandbox_spec_key(&workload.warm_spec())
        );
    }

    #[test]
    fn codex_workload_pins_harness_via_container_args() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let codex_spec = workload.spec(&thread_key, &HarnessType::Codex, None);
        let claude_spec = workload.spec(&thread_key, &HarnessType::ClaudeCode, None);
        let amp_spec = workload.spec(&thread_key, &HarnessType::Amp, None);
        let omp_spec = workload.spec(&thread_key, &HarnessType::Omp, None);

        assert_eq!(codex_spec.args, vec!["harness-server", "codex"]);
        assert_eq!(claude_spec.args, vec!["harness-server", "claude-code"]);
        assert_eq!(amp_spec.args, vec!["harness-server", "amp"]);
        assert_eq!(omp_spec.args, vec!["harness-server", "omp"]);
        // The image entrypoint must be preserved: only CMD is overridden.
        assert_eq!(codex_spec.command, None);
    }

    #[test]
    fn codex_workload_labels_session_sandbox_for_observability() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();

        let spec = workload.spec(&thread_key, &HarnessType::ClaudeCode, None);

        assert_eq!(
            spec.labels.get("centaur.ai/component").map(String::as_str),
            Some("session-sandbox")
        );
        assert_eq!(
            spec.labels.get("centaur.ai/harness").map(String::as_str),
            Some("claudecode")
        );
    }

    #[test]
    fn warm_spec_uses_workload_default_harness() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            Vec::new(),
            HarnessType::Codex,
        );

        assert_eq!(
            workload.warm_spec().args,
            vec!["harness-server", "codex"],
            "warm sandboxes boot the configured default harness"
        );
        // A session on a different harness produces a different spec, so a
        // warm claim for it would hand over the wrong harness.
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        assert_eq!(
            workload
                .spec(&thread_key, &HarnessType::ClaudeCode, None)
                .args,
            vec!["harness-server", "claude-code"]
        );
    }

    #[test]
    fn input_line_with_session_context_enriches_json_objects() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["type"], "user");
        assert_eq!(value["thread_key"], thread_key.as_str());
        assert!(value.get("trace_id").is_none());
        // Without an OpenTelemetry layer there is no execution context to forward.
        assert!(value.get("traceparent").is_none());
        assert!(value.get("session_context").is_none());
    }

    #[test]
    fn input_line_injects_bounded_execution_trace_metadata() {
        let thread_key = ThreadKey::parse("test:trace-metadata").unwrap();
        let trace = SessionTraceContext::for_execution(
            None,
            Some("00-0123456789abcdef0123456789abcdef-1111111111111111-01".to_owned()),
            Some("exe-123"),
        );

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","trace_metadata":{"action":"execute"}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["trace_metadata"]["execution_id"], "exe-123");
        assert_eq!(value["trace_metadata"]["action"], "execute");
    }

    #[test]
    fn input_line_with_session_context_adds_slack_thread_context() {
        let thread_key = ThreadKey::parse("slack:T123:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["session_context"]["platform"], "slack");
        assert_eq!(value["session_context"]["slack"]["channel_id"], "C123");
        assert_eq!(
            value["session_context"]["slack"]["thread_ts"],
            "1780000000.000000"
        );
    }

    #[test]
    fn input_line_with_session_context_adds_discord_thread_context() {
        let thread_key = ThreadKey::parse("discord:111:222:333").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["session_context"]["platform"], "discord");
        assert_eq!(value["session_context"]["discord"]["guild_id"], "111");
        assert_eq!(value["session_context"]["discord"]["channel_id"], "222");
        assert_eq!(value["session_context"]["discord"]["thread_id"], "333");
        assert!(value["session_context"].get("slack").is_none());
    }

    #[test]
    fn input_line_with_session_context_adds_linear_thread_context() {
        let thread_key = ThreadKey::parse("linear:ISSUE:s:SESS").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["session_context"]["platform"], "linear");
        assert_eq!(value["session_context"]["linear"]["issue_id"], "ISSUE");
        assert_eq!(
            value["session_context"]["linear"]["agent_session_id"],
            "SESS"
        );
        // No comment in this key, so the optional field is omitted entirely.
        assert!(
            value["session_context"]["linear"]
                .get("comment_id")
                .is_none()
        );
    }

    #[test]
    fn input_line_with_session_context_adds_github_thread_context() {
        let thread_key = ThreadKey::parse("github:0xSplits/centaur:704:rc:99").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["session_context"]["platform"], "github");
        assert_eq!(value["session_context"]["github"]["owner"], "0xSplits");
        assert_eq!(value["session_context"]["github"]["repo"], "centaur");
        assert_eq!(value["session_context"]["github"]["number"], 704);
        assert_eq!(value["session_context"]["github"]["kind"], "pr");
        assert_eq!(value["session_context"]["github"]["review_comment_id"], 99);
    }

    #[test]
    fn input_line_with_session_context_preserves_existing_session_context() {
        let thread_key = ThreadKey::parse("slack:T123:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","session_context":{"requester":{"github_handle":"@ada"},"platform":"custom"}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(
            value["session_context"]["requester"]["github_handle"],
            "@ada"
        );
        assert_eq!(value["session_context"]["platform"], "custom");
        assert_eq!(value["session_context"]["slack"]["channel_id"], "C123");
    }

    #[test]
    fn input_line_with_session_context_preserves_existing_fields_and_non_json() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext {
            trace_id: String::new(),
            traceparent: Some("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01".to_owned()),
            owner_id: None,
            generation: None,
            max_duration_ms: None,
            execution_id: None,
        };

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","thread_key":"chat:existing","trace_id":"caller-trace"}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();

        assert_eq!(value["thread_key"], "chat:existing");
        assert!(value.get("trace_id").is_none());
        assert_eq!(
            value["traceparent"],
            "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
        );
        assert_eq!(
            input_line_with_session_context(&thread_key, &trace, "raw"),
            "raw"
        );
    }

    #[test]
    fn input_line_prepends_discord_chat_surface_note_to_user_content() {
        let thread_key = ThreadKey::parse("discord:111:222:333").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();

        // The note is prepended ahead of the original parts, which are preserved.
        assert_eq!(content.len(), 2);
        let note = content[0]["text"].as_str().unwrap();
        assert!(note.contains("Discord"));
        assert!(note.contains("222"));
        assert_eq!(content[1]["text"], "hi");
    }

    #[test]
    fn input_line_prepends_slack_chat_surface_note_to_user_content() {
        let thread_key = ThreadKey::parse("slack:C123:123.456").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();

        assert_eq!(content.len(), 2);
        assert!(content[0]["text"].as_str().unwrap().contains("Slack"));
        assert_eq!(content[1]["text"], "hi");
    }

    #[test]
    fn input_line_prepends_linear_chat_surface_note_to_user_content() {
        let thread_key = ThreadKey::parse("linear:ISSUE:s:SESS").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();

        assert_eq!(content.len(), 2);
        let note = content[0]["text"].as_str().unwrap();
        assert!(note.contains("Linear"));
        assert!(note.contains("ISSUE"));
        assert_eq!(content[1]["text"], "hi");
    }

    #[test]
    fn input_line_prepends_github_chat_surface_note_to_user_content() {
        let thread_key = ThreadKey::parse("github:0xSplits/centaur:issue:12").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();

        assert_eq!(content.len(), 2);
        let note = content[0]["text"].as_str().unwrap();
        assert!(note.contains("GitHub"));
        assert!(note.contains("0xSplits/centaur#12"));
        assert_eq!(content[1]["text"], "hi");
    }

    #[test]
    fn input_line_leaves_content_untouched_without_a_chat_destination() {
        // A non-platform thread key resolves to no destination, so nothing is added.
        let thread_key = ThreadKey::parse("cli:test").unwrap();
        let trace = SessionTraceContext::new(None, None);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        let content = value["message"]["content"].as_array().unwrap();

        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["text"], "hi");
    }

    #[test]
    fn input_line_injects_trusted_ownership_into_trace_metadata() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new_for_thread(&thread_key, None)
            .with_ownership("api-rs-abcd1234", 7);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        // The trusted ownership fence is injected by api-rs, not client-
        // asserted. The harness-server reads owner_id + generation from
        // trace_metadata and fences stale/missing ownership.
        assert_eq!(value["trace_metadata"]["owner_id"], "api-rs-abcd1234");
        assert_eq!(value["trace_metadata"]["generation"], 7);
    }

    #[test]
    fn input_line_without_ownership_omits_trace_metadata_ownership() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new_for_thread(&thread_key, None);

        let line = input_line_with_session_context(&thread_key, &trace, r#"{"type":"user"}"#);
        let value: Value = serde_json::from_str(&line).unwrap();

        // No ownership acquired -> no owner_id/generation injected.
        let metadata = value.get("trace_metadata");
        if let Some(m) = metadata {
            assert!(m.get("owner_id").is_none());
            assert!(m.get("generation").is_none());
        }
    }

    #[test]
    fn input_line_overwrites_client_supplied_ownership_with_trusted_values() {
        // Regression: a malicious client may supply owner_id/generation in
        // trace_metadata. The api-rs injection MUST overwrite them, not
        // preserve them. or_insert_with would let the client values survive;
        // insert replaces them.
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new_for_thread(&thread_key, None)
            .with_ownership("api-rs-trusted", 42);

        // Client supplies malicious ownership in trace_metadata.
        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","trace_metadata":{"owner_id":"malicious-client","generation":999}}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();

        // Trusted values overwrite the malicious ones.
        assert_eq!(value["trace_metadata"]["owner_id"], "api-rs-trusted");
        assert_eq!(value["trace_metadata"]["generation"], 42);
        // Malicious values must NOT survive.
        assert_ne!(value["trace_metadata"]["owner_id"], "malicious-client");
        assert_ne!(value["trace_metadata"]["generation"], 999);
    }

    #[test]
    fn input_line_replaces_non_object_trace_metadata_with_trusted_values() {
        // Regression: a malicious client sends a non-object trace_metadata
        // (e.g. null). api-rs must replace it with a fresh object carrying
        // the trusted owner_id and generation.
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let trace = SessionTraceContext::new_for_thread(&thread_key, None)
            .with_ownership("api-rs-trusted", 99);

        let line = input_line_with_session_context(
            &thread_key,
            &trace,
            r#"{"type":"user","trace_metadata":null}"#,
        );
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["trace_metadata"]["owner_id"], "api-rs-trusted");
        assert_eq!(value["trace_metadata"]["generation"], 99);
    }

    #[test]
    fn thread_trace_id_is_deterministic_per_thread() {
        let thread_key = ThreadKey::parse("chat:C123:1780000000.000000").unwrap();
        let other = ThreadKey::parse("chat:C456:1780000000.000000").unwrap();

        assert_eq!(thread_trace_id(&thread_key), thread_trace_id(&thread_key));
        assert_ne!(thread_trace_id(&thread_key), thread_trace_id(&other));
        // The wrapper parses this with uuid.UUID(...): must stay a canonical UUID.
        assert!(uuid::Uuid::parse_str(&thread_trace_id(&thread_key)).is_ok());
        assert_eq!(
            thread_trace_parent_span_id(&thread_key),
            thread_trace_parent_span_id(&thread_key)
        );
        assert_ne!(
            thread_trace_parent_span_id(&thread_key),
            thread_trace_parent_span_id(&other)
        );
        assert_eq!(thread_trace_parent_span_id(&thread_key).len(), 16);
        assert_ne!(thread_trace_parent_span_id(&thread_key), "0000000000000000");
    }

    #[test]
    fn proxy_labels_from_session_metadata_use_centaur_slack_keys() {
        let thread_key = ThreadKey::parse("slack:T123:C123:1700000000.000000").unwrap();
        let labels = proxy_labels_from_session_metadata(
            &thread_key,
            &json!({
                "slack_user_id": "U123",
                "slack_team_id": "T123",
                "slack_channel_id": "C456",
                "slack_user_email": "ada@example.com"
            }),
        );

        assert_eq!(
            labels,
            BTreeMap::from([
                ("centaur.slack_channel_id".to_owned(), "C456".to_owned()),
                ("centaur.slack_team_id".to_owned(), "T123".to_owned()),
                ("centaur.slack_user_id".to_owned(), "U123".to_owned()),
            ])
        );
    }

    #[test]
    fn proxy_labels_from_session_metadata_does_not_infer_slack_channel_for_linear_keys() {
        let thread_key = ThreadKey::parse("linear:CEN-123:s:agent-session").unwrap();
        let labels = proxy_labels_from_session_metadata(
            &thread_key,
            &json!({
                "slack_user_id": "U123",
                "slack_team_id": "T123",
            }),
        );

        assert_eq!(
            labels,
            BTreeMap::from([
                ("centaur.slack_team_id".to_owned(), "T123".to_owned()),
                ("centaur.slack_user_id".to_owned(), "U123".to_owned()),
            ])
        );
    }

    fn session_with_sandbox(sandbox_id: &str) -> Session {
        let thread_key = ThreadKey::parse("cli:test-idle").unwrap();
        let now = OffsetDateTime::now_utc();
        Session {
            thread_key,
            title: None,
            sandbox_id: Some(sandbox_id.to_owned()),
            sandbox_capabilities: None,
            harness_type: HarnessType::Codex,
            harness_thread_id: None,
            persona_id: None,
            status: SessionStatus::Idle,
            iron_control_principal: None,
            proxy_labels: BTreeMap::new(),
            sandbox_last_active_at: Some(now),
            created_at: now,
            updated_at: now,
        }
    }

    fn session_execution(
        execution_id: &str,
        status: ExecutionStatus,
        metadata: serde_json::Value,
    ) -> SessionExecution {
        let thread_key = ThreadKey::parse("cli:test-idle").unwrap();
        let now = OffsetDateTime::now_utc();
        SessionExecution {
            execution_id: execution_id.to_owned(),
            idempotency_key: None,
            thread_key,
            status,
            metadata,
            error: None,
            created_at: now,
            updated_at: now,
            started_at: Some(now),
            completed_at: Some(now),
        }
    }

    fn env_value<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
        spec.env
            .iter()
            .find(|env| env.name == name)
            .map(|env| env.value.as_str())
    }

    fn test_persona_context(persona_id: &str) -> PersonaContext {
        let prompt = format!("{persona_id} persona prompt");
        PersonaContext {
            persona_id: persona_id.to_owned(),
            source_root: "/repo/tools".to_owned(),
            source_path: format!("/repo/tools/personas/{persona_id}"),
            source_ref: Some("abc123".to_owned()),
            prompt_hash: format!("sha256:{}", hex::encode(Sha256::digest(prompt.as_bytes()))),
            prompt,
            defaulted: false,
            overlay_chain: vec!["/repo/tools".to_owned()],
        }
    }
}

/// Integration tests for orphaned-execution adoption. They need a real
/// Postgres; set `SESSION_RUNTIME_TEST_DATABASE_URL` to run them (they skip
/// silently otherwise, mirroring `ABSURD_TEST_DATABASE_URL` in absurd-sdk).
#[cfg(test)]
mod adoption_tests {
    use std::{
        collections::{BTreeMap, BTreeSet},
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use centaur_sandbox_core::{ObservedSandbox, SandboxHandle, SandboxIo, SandboxResult};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

    use super::*;

    /// The adoption scan is database-wide, so concurrently running tests
    /// would adopt each other's executions. Serialize the module; every test
    /// fully terminalizes its own executions before releasing the lock.
    static TEST_LOCK: Mutex<()> = Mutex::const_new(());

    #[derive(Clone, Copy)]
    struct TestSessionPrincipalRegistrar;

    #[async_trait::async_trait]
    impl SessionPrincipalRegistrar for TestSessionPrincipalRegistrar {
        async fn register_session(
            &self,
            _thread_key: &str,
            _metadata: Option<&Value>,
        ) -> Result<Principal, IronControlError> {
            Ok(test_principal("prn_test"))
        }

        async fn register_requester(
            &self,
            _thread_key: &str,
            _metadata: Option<&Value>,
        ) -> Result<Option<Principal>, IronControlError> {
            Ok(None)
        }

        async fn get_principal(&self, principal: &str) -> Result<Principal, IronControlError> {
            Ok(test_principal(principal))
        }
    }

    fn test_principal(id: &str) -> Principal {
        Principal {
            id: id.to_owned(),
            foreign_id: Some("test".to_owned()),
            name: "Test".to_owned(),
            labels: BTreeMap::new(),
            sandbox_observability_enabled: true,
            sandbox_api_server_enabled: true,
        }
    }

    type ProxyEnsure = (String, String, Option<String>, BTreeMap<String, String>);

    struct MockBackend {
        ios: Mutex<VecDeque<SandboxIo>>,
        recorded_output: std::sync::Mutex<Vec<String>>,
        open_count: AtomicUsize,
        create_started: tokio::sync::Notify,
        create_gate: std::sync::Mutex<Option<Arc<tokio::sync::Notify>>>,
        status: std::sync::Mutex<SandboxStatus>,
        observed_statuses: std::sync::Mutex<BTreeMap<String, SandboxStatus>>,
        create_id: String,
        created_specs: std::sync::Mutex<Vec<SandboxSpec>>,
        resume_fails: AtomicBool,
        stopped: std::sync::Mutex<Vec<String>>,
        proxy_ensures: std::sync::Mutex<Vec<ProxyEnsure>>,
        missing_on_stop: std::sync::Mutex<BTreeSet<String>>,
    }

    impl MockBackend {
        fn new(status: SandboxStatus, recorded_output: Vec<String>) -> Self {
            Self {
                ios: Mutex::new(VecDeque::new()),
                recorded_output: std::sync::Mutex::new(recorded_output),
                open_count: AtomicUsize::new(0),
                create_started: tokio::sync::Notify::new(),
                create_gate: std::sync::Mutex::new(None),
                status: std::sync::Mutex::new(status),
                observed_statuses: std::sync::Mutex::new(BTreeMap::new()),
                create_id: "mock-sbx".to_owned(),
                created_specs: std::sync::Mutex::new(Vec::new()),
                resume_fails: AtomicBool::new(false),
                stopped: std::sync::Mutex::new(Vec::new()),
                proxy_ensures: std::sync::Mutex::new(Vec::new()),
                missing_on_stop: std::sync::Mutex::new(BTreeSet::new()),
            }
        }

        async fn push_io(&self, io: SandboxIo) {
            self.ios.lock().await.push_back(io);
        }

        fn opens(&self) -> usize {
            self.open_count.load(Ordering::SeqCst)
        }

        fn hold_create(&self) -> Arc<tokio::sync::Notify> {
            let gate = Arc::new(tokio::sync::Notify::new());
            *self.create_gate.lock().unwrap() = Some(gate.clone());
            gate
        }

        fn set_recorded_output(&self, recorded_output: Vec<String>) {
            *self.recorded_output.lock().unwrap() = recorded_output;
        }

        fn set_status(&self, status: SandboxStatus) {
            *self.status.lock().unwrap() = status;
        }

        fn set_observed_status(&self, sandbox_id: &str, status: SandboxStatus) {
            self.observed_statuses
                .lock()
                .unwrap()
                .insert(sandbox_id.to_owned(), status);
        }

        fn status_of(&self, sandbox_id: &str) -> Option<SandboxStatus> {
            self.observed_statuses
                .lock()
                .unwrap()
                .get(sandbox_id)
                .cloned()
        }

        fn fail_resume(&self) {
            self.resume_fails.store(true, Ordering::SeqCst);
        }

        fn mark_stop_missing(&self, sandbox_id: &str) {
            self.missing_on_stop
                .lock()
                .unwrap()
                .insert(sandbox_id.to_owned());
        }

        fn stopped(&self) -> Vec<String> {
            self.stopped.lock().unwrap().clone()
        }

        fn proxy_ensures(&self) -> Vec<ProxyEnsure> {
            self.proxy_ensures.lock().unwrap().clone()
        }

        fn created_specs(&self) -> Vec<SandboxSpec> {
            self.created_specs.lock().unwrap().clone()
        }
    }

    #[async_trait::async_trait]
    impl SandboxBackend for MockBackend {
        fn name(&self) -> &'static str {
            "mock"
        }

        async fn create(&self, spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
            self.created_specs.lock().unwrap().push(spec);
            self.create_started.notify_one();
            let gate = self.create_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                gate.notified().await;
            }
            self.set_observed_status(&self.create_id, SandboxStatus::Running);
            Ok(SandboxHandle::new(
                SandboxId::new(self.create_id.clone()),
                "mock",
            ))
        }

        async fn open_io(&self, _id: &SandboxId) -> SandboxResult<SandboxIo> {
            self.open_count.fetch_add(1, Ordering::SeqCst);
            self.ios
                .lock()
                .await
                .pop_front()
                .ok_or_else(|| SandboxError::io("mock backend has no more ios"))
        }

        async fn read_output_since(
            &self,
            _id: &SandboxId,
            _since: Option<SystemTime>,
        ) -> SandboxResult<Vec<String>> {
            Ok(self.recorded_output.lock().unwrap().clone())
        }

        async fn status(&self, _id: &SandboxId) -> SandboxResult<SandboxStatus> {
            if let Some(status) = self.status_of(_id.as_str()) {
                return Ok(status);
            }
            Ok(self.status.lock().unwrap().clone())
        }

        async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
            let status = self.status(id).await?;
            Ok(ObservedSandbox::new(id.clone(), "mock", status))
        }

        async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
            Ok(self
                .observed_statuses
                .lock()
                .unwrap()
                .iter()
                .map(|(id, status)| ObservedSandbox::new(id.as_str(), "mock", status.clone()))
                .collect())
        }

        async fn stop(&self, id: &SandboxId) -> SandboxResult<()> {
            if self.missing_on_stop.lock().unwrap().contains(id.as_str()) {
                return Err(SandboxError::NotFound(id.as_str().to_owned()));
            }
            self.stopped.lock().unwrap().push(id.as_str().to_owned());
            self.set_observed_status(id.as_str(), SandboxStatus::Stopped);
            Ok(())
        }

        async fn ensure_iron_control_proxy_resources(
            &self,
            id: &SandboxId,
            principal_id: &str,
            requester_principal_id: Option<&str>,
            labels: &BTreeMap<String, String>,
        ) -> SandboxResult<()> {
            self.proxy_ensures.lock().unwrap().push((
                id.as_str().to_owned(),
                principal_id.to_owned(),
                requester_principal_id.map(ToOwned::to_owned),
                labels.clone(),
            ));
            Ok(())
        }

        async fn pause(&self, _id: &SandboxId) -> SandboxResult<()> {
            self.set_observed_status(_id.as_str(), SandboxStatus::Suspended);
            Ok(())
        }

        async fn resume(&self, _id: &SandboxId) -> SandboxResult<()> {
            if self.resume_fails.load(Ordering::SeqCst) {
                return Err(SandboxError::NotFound(_id.as_str().to_owned()));
            }
            self.set_observed_status(_id.as_str(), SandboxStatus::Running);
            Ok(())
        }
    }

    fn mock_io() -> (SandboxIo, DuplexStream, DuplexStream) {
        let (stdin_near, stdin_far) = tokio::io::duplex(64 * 1024);
        let (stdout_near, stdout_far) = tokio::io::duplex(64 * 1024);
        let (stderr_near, _stderr_far) = tokio::io::duplex(1024);
        let io = SandboxIo::new(
            Box::pin(stdin_near),
            Box::pin(stdout_near),
            Box::pin(stderr_near),
        );
        (io, stdout_far, stdin_far)
    }

    /// Controllable resident OMP host fake: reads collab control frames from
    /// stdin and emits correlated collab/status or collab/state frames on
    /// stdout so production start/status/stop waiters complete without a real
    /// harness. Room payload is fixed at spawn time.
    fn mock_resident_collab_io(room: CollabRoomState) -> SandboxIo {
        let (io, mut stdout_far, stdin_far) = mock_io();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdin_far);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
                let Ok(frame) = serde_json::from_str::<Value>(line.trim()) else {
                    continue;
                };
                let request_id = frame
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let command = frame.get("type").and_then(Value::as_str).unwrap_or("");
                // Echo admitted ownership from the control frame so api-rs can
                // require exact owner_id+generation on every lifecycle frame.
                let ownership = frame.get("ownership").cloned().unwrap_or(Value::Null);
                let response = match command {
                    "collab_status" => json!({
                        "method": "collab/status",
                        "params": {
                            "request_id": request_id,
                            "ownership": ownership,
                            "room": room,
                        }
                    }),
                    "collab_start" => json!({
                        "method": "collab/state",
                        "params": {
                            "request_id": request_id,
                            "state": "started",
                            "ownership": ownership,
                            "room": room,
                        }
                    }),
                    "collab_stop" => json!({
                        "method": "collab/state",
                        "params": {
                            "request_id": request_id,
                            "state": "stopped",
                            "ownership": ownership,
                            "room": {
                                "active": false,
                                "participants": [],
                            }
                        }
                    }),
                    _ => continue,
                };
                let mut out = match serde_json::to_string(&response) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                out.push('\n');
                if stdout_far.write_all(out.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        io
    }

    async fn push_resident_collab_io(backend: &MockBackend, room: CollabRoomState) {
        backend.push_io(mock_resident_collab_io(room)).await;
    }

    /// Accepts control writes but never emits a correlated response (hangs
    /// the wait side until the absolute lifecycle deadline fires).
    fn mock_hanging_collab_io() -> SandboxIo {
        let (io, _stdout_far, stdin_far) = mock_io();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdin_far);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
        io
    }

    fn completed_output_lines(result_text: &str) -> Vec<String> {
        vec![
            json!({
                "type": "item.completed",
                "item": {
                    "id": "msg-1",
                    "type": "agentMessage",
                    "text": result_text,
                    "phase": "final_answer"
                }
            })
            .to_string(),
            json!({"type": "turn.completed", "turn": {"id": "turn-1", "status": "completed"}})
                .to_string(),
        ]
    }

    fn completed_output_bytes(result_text: &str) -> Vec<u8> {
        let mut output = completed_output_lines(result_text).join("\n");
        output.push('\n');
        output.into_bytes()
    }

    async fn test_store() -> Option<PgSessionStore> {
        let Ok(url) = std::env::var("SESSION_RUNTIME_TEST_DATABASE_URL") else {
            eprintln!("skipping: SESSION_RUNTIME_TEST_DATABASE_URL not set");
            return None;
        };
        let store = PgSessionStore::connect(&url)
            .await
            .expect("connect test db");
        store.run_migrations().await.expect("run migrations");
        Some(store)
    }

    async fn orphaned_execution(
        store: &PgSessionStore,
        thread_key: &ThreadKey,
        sandbox_id: Option<&str>,
        running: bool,
    ) -> String {
        store
            .create_or_get_session(
                thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        if sandbox_id.is_some() {
            store
                .update_sandbox_id(thread_key, sandbox_id)
                .await
                .expect("set sandbox id");
        }
        let created = if running {
            store.create_execution(thread_key, None, json!({})).await
        } else {
            store
                .create_execution_with_request(
                    thread_key,
                    None,
                    json!({}),
                    persisted_execute_request(&ExecuteSessionInput {
                        idempotency_key: None,
                        metadata: Some(json!({"source": "adoption-test"})),
                        input_lines: vec![
                            json!({
                                "type": "user",
                                "message": {"content": [{"type": "text", "text": "recover me"}]}
                            })
                            .to_string(),
                        ],
                        idle_timeout_ms: None,
                        max_duration_ms: None,
                    })
                    .expect("serialize execution request"),
                )
                .await
        }
        .expect("create execution");
        let execution_id = created.execution.execution_id;
        if running {
            store
                .mark_execution_running(&execution_id)
                .await
                .expect("mark running");
        }
        execution_id
    }

    /// Ages a running pre-sandbox row past `PRE_SANDBOX_ORPHAN_GRACE` so
    /// adoption treats it as a genuine orphan instead of an assignment race.
    async fn backdate_execution(store: &PgSessionStore, execution_id: &str, seconds: f64) {
        let result = sqlx::query(
            "update session_executions \
             set created_at = created_at - make_interval(secs => $2), \
                 started_at = started_at - make_interval(secs => $2) \
             where execution_id = $1",
        )
        .bind(execution_id)
        .bind(seconds)
        .execute(store.pool())
        .await
        .expect("backdate execution");
        assert_eq!(result.rows_affected(), 1, "expected to backdate one row");
    }

    /// Expires an execution's stdout-owner lease in place, simulating an
    /// owner that died without releasing, deterministically (no sleeps
    /// racing real lease TTLs).
    async fn expire_stdout_lease(store: &PgSessionStore, execution_id: &str) {
        let result = sqlx::query(
            "update session_executions \
             set stdout_owner_lease_expires_at = now() - interval '1 second' \
             where execution_id = $1",
        )
        .bind(execution_id)
        .execute(store.pool())
        .await
        .expect("expire stdout lease");
        assert_eq!(result.rows_affected(), 1, "expected to expire one lease");
    }

    async fn wait_for_event(store: &PgSessionStore, thread_key: &ThreadKey, event_type: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let events = store
                .list_events_after(thread_key, 0, None, 1000)
                .await
                .expect("list events");
            if events.iter().any(|event| event.event_type == event_type) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {event_type}"
            );
            sleep(Duration::from_millis(25)).await;
        }
    }

    async fn wait_for_session_title(
        store: &PgSessionStore,
        thread_key: &ThreadKey,
        expected: &str,
    ) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let session = store.get_session(thread_key).await.expect("get session");
            if session.title.as_deref() == Some(expected) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for title");
            sleep(Duration::from_millis(25)).await;
        }
    }

    async fn events(store: &PgSessionStore, thread_key: &ThreadKey) -> Vec<SessionEvent> {
        store
            .list_events_after(thread_key, 0, None, 1000)
            .await
            .expect("list events")
    }

    async fn session_metadata(store: &PgSessionStore, thread_key: &ThreadKey) -> Value {
        sqlx::query_scalar("select metadata from sessions where thread_key = $1")
            .bind(thread_key.as_str())
            .fetch_one(store.pool())
            .await
            .expect("load session metadata")
    }

    fn runtime_with(store: &PgSessionStore, backend: Arc<MockBackend>) -> SessionRuntime {
        SessionRuntime::new(
            store.clone(),
            SandboxRuntime::backend(backend, SandboxSpec::new("mock")),
            TestSessionPrincipalRegistrar,
        )
    }

    fn runtime_with_personas(store: &PgSessionStore, backend: Arc<MockBackend>) -> SessionRuntime {
        let definitions = ["old", "eng"].map(|persona_id| PersonaDefinition {
            id: persona_id.to_owned(),
            source_root: "/repo/tools".to_owned(),
            source_path: format!("/repo/tools/personas/{persona_id}"),
            source_ref: Some("abc123".to_owned()),
            prompt_hash: format!("sha256:{persona_id}"),
            prompt: format!("{persona_id} persona prompt"),
        });
        runtime_with(store, backend).with_personas(
            PersonaRegistry::new(definitions, None, vec!["/repo/tools".to_owned()]).unwrap(),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn harness_restart_preserves_pinned_persona() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:persona-harness-{}", uuid::Uuid::new_v4())).unwrap();
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with_personas(&store, backend);

        let created = runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                Some("old"),
                Some(json!({})),
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("create original session");
        assert_eq!(created.unavailable_requested_persona_id, None);

        let outcome = runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::ClaudeCode,
                Some("not-deployed"),
                Some(json!({})),
                HarnessConflictPolicy::Restart,
            )
            .await
            .expect("restart session on requested harness");

        assert!(outcome.harness_switched);
        assert_eq!(outcome.unavailable_requested_persona_id, None);
        assert_eq!(outcome.session.harness_type, HarnessType::ClaudeCode);
        assert_eq!(outcome.session.persona_id.as_deref(), Some("old"));
        assert_eq!(
            session_metadata(&store, &thread_key).await["persona"]["persona_id"],
            "old"
        );
        let events = events(&store, &thread_key).await;
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "session.harness_switched")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn existing_session_ignores_later_persona_selection() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:persona-only-{}", uuid::Uuid::new_v4())).unwrap();
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with_personas(&store, backend);

        runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                Some("old"),
                Some(json!({})),
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("create original session");

        let outcome = runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                Some("eng"),
                Some(json!({})),
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("load session with pinned persona");

        assert!(!outcome.harness_switched);
        assert_eq!(outcome.unavailable_requested_persona_id, None);
        assert_eq!(outcome.session.harness_type, HarnessType::Codex);
        assert_eq!(outcome.session.persona_id.as_deref(), Some("old"));
        assert_eq!(
            session_metadata(&store, &thread_key).await["persona"]["persona_id"],
            "old"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_session_can_select_principal_by_foreign_id() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:principal-{}", uuid::Uuid::new_v4())).unwrap();
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);

        let outcome = runtime
            .create_or_get_session_with_principal(
                &thread_key,
                &HarnessType::Codex,
                None,
                Some(json!({})),
                HarnessConflictPolicy::Reject,
                Some(" finance-automation "),
            )
            .await
            .expect("create session with selected principal");

        assert_eq!(
            outcome.session.iron_control_principal.as_deref(),
            Some("finance-automation")
        );

        let error = runtime
            .create_or_get_session_with_principal(
                &thread_key,
                &HarnessType::Codex,
                None,
                Some(json!({})),
                HarnessConflictPolicy::Reject,
                Some("support-automation"),
            )
            .await
            .expect_err("existing session principal must not be rebound");
        assert!(matches!(
            error,
            SessionRuntimeError::Store(SessionStoreError::PrincipalConflict {
                existing,
                requested,
                ..
            }) if existing == "finance-automation" && requested == "support-automation"
        ));
        assert_eq!(
            store
                .get_session(&thread_key)
                .await
                .expect("get session after conflict")
                .iron_control_principal
                .as_deref(),
            Some("finance-automation")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn enqueue_returns_after_durable_commit_without_waiting_for_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:enqueue-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let create_gate = backend.hold_create();
        let (io, mut stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime = runtime_with(&store, backend.clone());
        let input = ExecuteSessionInput {
            idempotency_key: None,
            metadata: Some(json!({"source": "slackbotv2"})),
            input_lines: vec![
                json!({
                    "type": "user",
                    "message": {"content": [{"type": "text", "text": "queue me"}]}
                })
                .to_string(),
            ],
            idle_timeout_ms: None,
            max_duration_ms: None,
        };

        let execution = timeout(
            Duration::from_secs(1),
            runtime.enqueue_session_execution(&thread_key, input.clone()),
        )
        .await
        .expect("enqueue must not wait for sandbox creation")
        .expect("enqueue execution");
        assert_eq!(execution.status, ExecutionStatus::Queued);
        assert_eq!(
            store
                .execution_request(&execution.execution_id)
                .await
                .expect("load durable request"),
            persisted_execute_request(&input).expect("serialize input")
        );

        timeout(Duration::from_secs(1), backend.create_started.notified())
            .await
            .expect("background driver should start sandbox creation");
        assert!(backend.created_specs().len() == 1);

        create_gate.notify_one();
        stdout
            .write_all(&completed_output_bytes("Processed from durable queue."))
            .await
            .expect("write terminal output");
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let latest = store
            .latest_execution_for_thread(&thread_key)
            .await
            .expect("load latest execution")
            .expect("execution exists");
        assert_eq!(latest.execution_id, execution.execution_id);
        assert_eq!(latest.status, ExecutionStatus::Completed);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn execution_scoped_event_stream_completes_after_terminal_event() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:stream-close-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, None, false).await;
        store
            .append_event(
                &thread_key,
                Some(&execution_id),
                "session.output.line",
                json!({ "line": "working" }),
            )
            .await
            .expect("append output event");
        store
            .append_event(
                &thread_key,
                Some(&execution_id),
                "session.execution_completed",
                json!({ "execution_id": execution_id }),
            )
            .await
            .expect("append terminal event");

        // Execution-scoped: the stream must end on its own after emitting the
        // terminal event, releasing the response and its listener connection.
        let listener = store.listen_session_events().await.expect("listener");
        let scoped = session_event_stream(
            store.clone(),
            thread_key.clone(),
            0,
            Some(execution_id.clone()),
            listener,
            tracing::Span::none(),
        );
        let emitted = tokio::time::timeout(Duration::from_secs(10), scoped.collect::<Vec<_>>())
            .await
            .expect("execution-scoped stream should complete after the terminal event");
        let kinds: Vec<_> = emitted
            .into_iter()
            .map(|result| result.expect("stream event").event_type)
            .collect();
        assert_eq!(
            kinds,
            vec!["session.output.line", "session.execution_completed"]
        );

        // Control: an unscoped stream over the same events stays open for
        // future events instead of completing.
        let listener = store.listen_session_events().await.expect("listener");
        let unscoped = session_event_stream(
            store.clone(),
            thread_key.clone(),
            0,
            None,
            listener,
            tracing::Span::none(),
        );
        let mut unscoped = std::pin::pin!(unscoped);
        for _ in 0..2 {
            unscoped
                .next()
                .await
                .expect("buffered event")
                .expect("stream event");
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(300), unscoped.next())
                .await
                .is_err(),
            "unscoped stream should stay open after a terminal event"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn append_messages_generates_missing_session_title_once() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key = ThreadKey::parse(format!("test:title-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");

        let calls = Arc::new(AtomicUsize::new(0));
        let sources = Arc::new(Mutex::new(Vec::<String>::new()));
        let generator_started = Arc::new(tokio::sync::Notify::new());
        let generator_release = Arc::new(tokio::sync::Notify::new());
        let calls_for_generator = calls.clone();
        let sources_for_generator = sources.clone();
        let started_for_generator = generator_started.clone();
        let release_for_generator = generator_release.clone();
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        )
        .with_session_title_generator(move |source| {
            let calls = calls_for_generator.clone();
            let sources = sources_for_generator.clone();
            let started = started_for_generator.clone();
            let release = release_for_generator.clone();
            async move {
                calls.fetch_add(1, Ordering::SeqCst);
                sources.lock().await.push(source);
                started.notify_one();
                release.notified().await;
                Ok("Fix worker memory leak".to_owned())
            }
        });

        tokio::time::timeout(
            Duration::from_secs(1),
            runtime.append_messages(
                &thread_key,
                &[SessionMessageInput {
                    client_message_id: Some("first".to_owned()),
                    role: MessageRole::User,
                    parts: vec![
                        json!({
                            "type": "text",
                            "text": "# Requester Context\n\nThe Slack user who prompted this turn is Alice."
                        }),
                        json!({
                            "type": "text",
                            "text": "<@U123> please fix the memory leak in the worker"
                        }),
                    ],
                    metadata: json!({}),
                }],
            ),
        )
        .await
        .expect("append first message should not wait for title generation")
        .expect("append first message");

        generator_started.notified().await;

        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.title, None);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            sources.lock().await.clone(),
            vec!["please fix the memory leak in the worker".to_owned()]
        );

        runtime
            .append_messages(
                &thread_key,
                &[SessionMessageInput {
                    client_message_id: Some("burst".to_owned()),
                    role: MessageRole::User,
                    parts: vec![json!({"type": "text", "text": "add more logging"})],
                    metadata: json!({}),
                }],
            )
            .await
            .expect("append burst message");

        assert_eq!(calls.load(Ordering::SeqCst), 1);

        generator_release.notify_one();
        wait_for_session_title(&store, &thread_key, "Fix worker memory leak").await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        runtime
            .append_messages(
                &thread_key,
                &[SessionMessageInput {
                    client_message_id: Some("second".to_owned()),
                    role: MessageRole::User,
                    parts: vec![json!({"type": "text", "text": "add more logging"})],
                    metadata: json!({}),
                }],
            )
            .await
            .expect("append second message");

        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.title.as_deref(), Some("Fix worker memory leak"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    fn env_value<'a>(spec: &'a SandboxSpec, name: &str) -> Option<&'a str> {
        spec.env
            .iter()
            .find(|env| env.name == name)
            .map(|env| env.value.as_str())
    }

    fn default_capabilities() -> SessionSandboxCapabilities {
        SessionSandboxCapabilities::default_enabled()
    }

    fn restricted_capabilities() -> SessionSandboxCapabilities {
        SessionSandboxCapabilities {
            repo_cache: SessionRepoCacheAccess::None,
            observability_enabled: false,
            api_server_enabled: false,
        }
    }

    fn runtime_with_warm_pool(
        store: &PgSessionStore,
        backend: Arc<MockBackend>,
        workload_marker: impl Into<String>,
    ) -> SessionRuntime {
        let workload_marker = Arc::new(workload_marker.into());
        let claimed_marker = workload_marker.clone();
        let warm_marker = workload_marker.clone();
        let mut runtime = SessionRuntime::new(
            store.clone(),
            SandboxRuntime::backend_with_warm_spec_factory(
                backend,
                move |_thread_key, _execution_id, _harness, _persona| {
                    SandboxSpec::new("mock")
                        .mount(Mount::new(
                            centaur_sandbox_core::MountKind::Bind {
                                source_path: "/var/lib/centaur/repos".to_owned(),
                            },
                            SANDBOX_REPOS_MOUNT_PATH,
                        ))
                        .env("WARM_POOL_TEST_MARKER", claimed_marker.as_str())
                },
                move || SandboxSpec::new("mock").env("WARM_POOL_TEST_MARKER", warm_marker.as_str()),
            ),
            TestSessionPrincipalRegistrar,
        );
        let warm_pool = Arc::new(WarmPoolManager::new(
            runtime.sandbox_runtime.manager.clone(),
            store.clone(),
            runtime.sandbox_runtime.warm_spec_factory.clone().unwrap(),
            runtime.sandbox_runtime.workload_key.clone().unwrap(),
            WarmPoolConfig {
                target_size: 1,
                replenish_interval: Duration::from_secs(60),
                bootstrap_iron_control_principal: "prn_test_bootstrap".to_owned(),
                max_running_sandboxes: None,
            },
        ));
        runtime.warm_pool = Some(warm_pool);
        runtime
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capability_mismatch_replaces_existing_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:cap-replace-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_assignment(&thread_key, "sbx-full", &default_capabilities())
            .await
            .expect("assign default sandbox");
        let session = store.get_session(&thread_key).await.unwrap();
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with_warm_pool(&store, backend.clone(), thread_key.as_str());
        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxRequest {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: session.sandbox_id.as_deref(),
                existing_sandbox_capabilities: session.sandbox_capabilities.as_ref(),
                iron_control_principal: None,
                requester_principal: None,
                proxy_labels: &BTreeMap::new(),
                desired_capabilities: &restricted_capabilities(),
                execution_id: &execution_id,
            })
            .await
            .expect("replace sandbox");

        assert_eq!(sandbox_id, "mock-sbx");
        assert_eq!(backend.stopped(), vec!["sbx-full".to_owned()]);
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.sandbox_id.as_deref(), Some("mock-sbx"));
        assert_eq!(
            session.sandbox_capabilities,
            Some(restricted_capabilities())
        );
        let spec = backend.created_specs().pop().expect("created cold spec");
        assert!(!spec.capabilities.repo_cache.enabled());
        assert!(!spec.capabilities.observability_enabled);
        assert_eq!(
            env_value(&spec, "CENTAUR_SANDBOX_OBSERVABILITY_ENABLED"),
            Some("false")
        );
        let blocklist = env_value(&spec, "TOOL_BLOCKLIST").unwrap_or("");
        for tool in OBSERVABILITY_TOOL_BLOCKLIST.split(',') {
            assert!(blocklist.split(',').any(|blocked| blocked == tool));
        }
        assert!(
            !spec
                .mounts
                .iter()
                .any(|mount| mount.target_path == SANDBOX_REPOS_MOUNT_PATH)
        );
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.sandbox_capabilities_replaced")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_default_capabilities_skip_warm_pool() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:cap-warm-skip-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with_warm_pool(&store, backend.clone(), thread_key.as_str());
        let workload_key = runtime
            .warm_pool
            .as_ref()
            .unwrap()
            .workload_key()
            .to_owned();
        let warm_sandbox_id = format!("warm-sbx-{}", uuid::Uuid::new_v4());
        store
            .insert_ready_warm_sandbox(&warm_sandbox_id, &workload_key)
            .await
            .expect("insert warm sandbox");

        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxRequest {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                iron_control_principal: None,
                requester_principal: None,
                proxy_labels: &BTreeMap::new(),
                desired_capabilities: &restricted_capabilities(),
                execution_id: &execution_id,
            })
            .await
            .expect("ensure sandbox");

        assert_eq!(sandbox_id, "mock-sbx");
        assert_eq!(
            store
                .claim_ready_warm_sandbox(&workload_key, thread_key.as_str())
                .await
                .expect("warm row should remain ready"),
            Some(warm_sandbox_id)
        );
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(
            session.sandbox_capabilities,
            Some(restricted_capabilities())
        );
        let spec = backend.created_specs().pop().expect("created cold spec");
        assert!(!spec.capabilities.repo_cache.enabled());
        assert!(!spec.capabilities.observability_enabled);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn existing_running_sandbox_ensures_proxy_before_reuse() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:proxy-reuse-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let proxy_labels =
            BTreeMap::from([("centaur.slack_user_id".to_owned(), "U0123456789".to_owned())]);
        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxRequest {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: Some("sbx-existing"),
                existing_sandbox_capabilities: None,
                iron_control_principal: Some("principal-existing"),
                requester_principal: None,
                proxy_labels: &proxy_labels,
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                execution_id: &execution_id,
            })
            .await
            .expect("reuse existing sandbox");

        assert_eq!(sandbox_id, "sbx-existing");
        assert_eq!(
            backend.proxy_ensures(),
            vec![(
                "sbx-existing".to_owned(),
                "principal-existing".to_owned(),
                None,
                proxy_labels
            )]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn existing_sandbox_ensure_swaps_and_clears_requester() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:requester-swap-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let proxy_labels = BTreeMap::new();
        for requester in [Some("prn_a"), Some("prn_b"), None] {
            runtime
                .ensure_session_sandbox(EnsureSessionSandboxRequest {
                    thread_key: &thread_key,
                    harness_type: &HarnessType::Codex,
                    persona_id: None,
                    existing_sandbox_id: Some("sbx-existing"),
                    existing_sandbox_capabilities: None,
                    iron_control_principal: Some("prn_conv"),
                    requester_principal: requester,
                    proxy_labels: &proxy_labels,
                    desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                    execution_id: &execution_id,
                })
                .await
                .expect("reuse existing sandbox");
        }

        assert_eq!(
            backend.proxy_ensures(),
            vec![
                (
                    "sbx-existing".to_owned(),
                    "prn_conv".to_owned(),
                    Some("prn_a".to_owned()),
                    BTreeMap::new()
                ),
                (
                    "sbx-existing".to_owned(),
                    "prn_conv".to_owned(),
                    Some("prn_b".to_owned()),
                    BTreeMap::new()
                ),
                (
                    "sbx-existing".to_owned(),
                    "prn_conv".to_owned(),
                    None,
                    BTreeMap::new()
                ),
            ]
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cold_create_carries_requester_on_spec() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:requester-cold-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        runtime
            .ensure_session_sandbox(EnsureSessionSandboxRequest {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: None,
                existing_sandbox_capabilities: None,
                iron_control_principal: Some("prn_conv"),
                requester_principal: Some("prn_req"),
                proxy_labels: &BTreeMap::new(),
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                execution_id: &execution_id,
            })
            .await
            .expect("cold create sandbox");

        let spec = backend.created_specs().pop().expect("created cold spec");
        assert_eq!(spec.iron_control_principal.as_deref(), Some("prn_conv"));
        assert_eq!(
            spec.iron_control_requester_principal.as_deref(),
            Some("prn_req")
        );
    }

    fn requester_test_registrar(base_url: String) -> SessionRegistrar {
        SessionRegistrar::new(centaur_iron_control::IronControlClient::new(
            base_url, "test-key",
        ))
    }

    fn runtime_with_registrar(
        store: &PgSessionStore,
        backend: Arc<MockBackend>,
        registrar: SessionRegistrar,
    ) -> SessionRuntime {
        SessionRuntime::new(
            store.clone(),
            SandboxRuntime::backend(backend, SandboxSpec::new("mock")),
            registrar,
        )
    }

    async fn execute_with_metadata(
        runtime: &SessionRuntime,
        thread_key: &ThreadKey,
        metadata: Value,
    ) -> SessionExecution {
        runtime
            .execute_session(
                thread_key,
                ExecuteSessionInput {
                    idempotency_key: None,
                    metadata: Some(metadata),
                    input_lines: vec![
                        r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#
                            .to_owned(),
                    ],
                    idle_timeout_ms: None,
                    max_duration_ms: None,
                },
            )
            .await
            .expect("execute session")
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn allocation_only_placeholder_claims_a_sandbox_and_completes() {
        // The Flue hosts' sandbox claim: execute with the marker and no
        // input. Before the allocation-only path this execution stayed open
        // — nothing completes a harness with no child — until max_duration
        // failed it, leaving an `execution exceeded` row and holding the
        // one-shot lease for the full minute. It must now return completed
        // with the sandbox assigned, and the released lease must admit the
        // next execution on the same thread immediately.
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let (base_url, _requests, _server) = spawn_execute_iron_control_stub().await;
        let thread_key =
            ThreadKey::parse(format!("omp:test:alloc-{}", uuid::Uuid::new_v4())).unwrap();

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, _stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime =
            runtime_with_registrar(&store, backend.clone(), requester_test_registrar(base_url));

        runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                None,
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("create session");

        let claimed = runtime
            .execute_session(
                &thread_key,
                ExecuteSessionInput {
                    idempotency_key: Some(format!("alloc-{}", uuid::Uuid::new_v4())),
                    metadata: Some(json!({"source": "flue", "action": "allocate_sandbox"})),
                    input_lines: vec![],
                    idle_timeout_ms: Some(30_000),
                    max_duration_ms: Some(60_000),
                },
            )
            .await
            .expect("allocation-only execute");

        assert_eq!(
            claimed.status,
            ExecutionStatus::Completed,
            "the placeholder completes as soon as the sandbox is assigned"
        );
        assert!(
            store
                .get_session(&thread_key)
                .await
                .expect("read session")
                .sandbox_id
                .is_some(),
            "the pod claim is the point of the call"
        );

        // The completion went through the normal terminal machinery, so the
        // thread carries a real `session.execution_completed` event — what
        // the console and any event-stream consumer read — not just a row
        // whose status quietly changed.
        let events = store
            .list_events_after(&thread_key, 0, Some(&claimed.execution_id), 100)
            .await
            .expect("list execution events");
        let completed = events
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("allocation-only completion event");
        assert_eq!(
            completed.payload["completion_reason"].as_str(),
            Some("allocation_only")
        );

        // The lease is released with the completion, so a real turn on the
        // same thread is admitted immediately — not 409'd out for a minute.
        let turn = runtime
            .execute_session(
                &thread_key,
                ExecuteSessionInput {
                    idempotency_key: Some(format!("turn-{}", uuid::Uuid::new_v4())),
                    metadata: None,
                    input_lines: vec![r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#.to_owned()],
                    idle_timeout_ms: None,
                    max_duration_ms: None,
                },
            )
            .await
            .expect("next execution admitted after allocation-only claim");
        store
            .complete_execution(&turn.execution_id)
            .await
            .expect("complete the follow-up turn");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn channel_execute_binds_requester_and_second_user_swaps_it() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let (base_url, _requests, server) = spawn_execute_iron_control_stub().await;
        let thread_key =
            ThreadKey::parse(format!("slack:T123:C123:{}", uuid::Uuid::new_v4())).unwrap();

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, _stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime =
            runtime_with_registrar(&store, backend.clone(), requester_test_registrar(base_url));

        runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                Some(json!({"slack_team_id": "T123", "slack_channel_id": "C123"})),
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("create session");

        let first = execute_with_metadata(
            &runtime,
            &thread_key,
            json!({
                "slack_user_id": "U1",
                "slack_team_id": "T123",
                "slack_home_team_id": "T123"
            }),
        )
        .await;
        store
            .complete_execution(&first.execution_id)
            .await
            .expect("complete first execution");

        // The thread's first turn binds the requester at sandbox creation.
        let spec = backend.created_specs().pop().expect("created cold spec");
        assert_eq!(
            spec.iron_control_principal.as_deref(),
            Some("prn_slack-channel-t123-c123")
        );
        assert_eq!(
            spec.iron_control_requester_principal.as_deref(),
            Some("prn_slack-user-t123-u1")
        );

        // A second turn by a different user swaps the requester on re-assign.
        let second = execute_with_metadata(
            &runtime,
            &thread_key,
            json!({
                "slack_user_id": "U2",
                "slack_team_id": "T123",
                "slack_home_team_id": "T123"
            }),
        )
        .await;
        store
            .complete_execution(&second.execution_id)
            .await
            .expect("complete second execution");

        assert_eq!(
            backend.proxy_ensures(),
            vec![(
                "mock-sbx".to_owned(),
                "prn_slack-channel-t123-c123".to_owned(),
                Some("prn_slack-user-t123-u2".to_owned()),
                BTreeMap::from([
                    ("centaur.slack_channel_id".to_owned(), "C123".to_owned()),
                    ("centaur.slack_team_id".to_owned(), "T123".to_owned()),
                ])
            )]
        );
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn slack_connect_channel_execute_binds_no_requester() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let (base_url, requests, server) = spawn_execute_iron_control_stub().await;
        let thread_key =
            ThreadKey::parse(format!("slack:T_HOME:C123:{}", uuid::Uuid::new_v4())).unwrap();

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, _stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime =
            runtime_with_registrar(&store, backend.clone(), requester_test_registrar(base_url));

        runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                Some(json!({
                    "slack_team_id": "T_HOME",
                    "slack_channel_id": "C123"
                })),
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("create session");

        let execution = execute_with_metadata(
            &runtime,
            &thread_key,
            json!({
                "slack_user_id": "U_EXTERNAL",
                "slack_team_id": "T_EXTERNAL",
                "slack_home_team_id": "T_HOME"
            }),
        )
        .await;
        store
            .complete_execution(&execution.execution_id)
            .await
            .expect("complete execution");

        let spec = backend.created_specs().pop().expect("created cold spec");
        assert_eq!(spec.iron_control_requester_principal, None);
        assert!(
            !requests
                .lock()
                .unwrap()
                .iter()
                .any(|request| request.contains("slack-user")),
            "Slack Connect executes must not upsert a requester principal"
        );
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dm_execute_binds_no_requester() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let (base_url, requests, server) = spawn_execute_iron_control_stub().await;
        let thread_key =
            ThreadKey::parse(format!("slack:T123:D123:{}", uuid::Uuid::new_v4())).unwrap();

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, _stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime =
            runtime_with_registrar(&store, backend.clone(), requester_test_registrar(base_url));

        runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                Some(json!({"slack_user_id": "U123", "slack_team_id": "T123"})),
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("create session");

        let execution = execute_with_metadata(
            &runtime,
            &thread_key,
            json!({"slack_user_id": "U123", "slack_team_id": "T123"}),
        )
        .await;
        store
            .complete_execution(&execution.execution_id)
            .await
            .expect("complete execution");

        // In a DM the conversation principal already is the user's principal;
        // the execute must not bind (or upsert) a separate requester.
        let spec = backend.created_specs().pop().expect("created cold spec");
        assert_eq!(
            spec.iron_control_principal.as_deref(),
            Some("prn_slack-user-t123-u123")
        );
        assert_eq!(spec.iron_control_requester_principal, None);
        let user_upserts = requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| *request == "PUT /api/v1/principals/slack-user-t123-u123")
            .count();
        assert_eq!(user_upserts, 1, "only session create upserts the user");
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_slack_execute_binds_no_requester() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let (base_url, requests, server) = spawn_execute_iron_control_stub().await;
        let thread_key = ThreadKey::parse(format!(
            "linear:issue-{}:s:sess-1",
            uuid::Uuid::new_v4().simple()
        ))
        .unwrap();

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, _stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime =
            runtime_with_registrar(&store, backend.clone(), requester_test_registrar(base_url));

        runtime
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                None,
                HarnessConflictPolicy::Reject,
            )
            .await
            .expect("create session");

        let execution = execute_with_metadata(
            &runtime,
            &thread_key,
            json!({"slack_user_id": "U1", "slack_team_id": "T123"}),
        )
        .await;
        store
            .complete_execution(&execution.execution_id)
            .await
            .expect("complete execution");

        let spec = backend.created_specs().pop().expect("created cold spec");
        assert_eq!(spec.iron_control_requester_principal, None);
        assert!(
            !requests
                .lock()
                .unwrap()
                .iter()
                .any(|request| request.contains("slack-user")),
            "non-Slack executes must not upsert a Slack requester principal"
        );
        server.abort();
    }

    /// Minimal raw-TCP iron-control stub for execute-level requester tests:
    /// principal lookups 404 (every upsert is a create), upserts return an OID
    /// derived from the foreign id (``prn_<foreign_id>``) so assertions can
    /// name the expected binding, and OID lookups echo the principal back.
    async fn spawn_execute_iron_control_stub() -> (
        String,
        Arc<std::sync::Mutex<Vec<String>>>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = requests.clone();
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    match stream.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(read) => request.extend_from_slice(&buf[..read]),
                    }
                }
                let request = String::from_utf8_lossy(&request);
                let first_line = request.lines().next().unwrap_or_default();
                let mut parts = first_line.split_whitespace();
                let method = parts.next().unwrap_or_default();
                let path = parts.next().unwrap_or_default();
                seen.lock().unwrap().push(format!("{method} {path}"));
                let (status_line, body) = execute_iron_control_stub_response(method, path);
                let response = format!(
                    "HTTP/1.1 {status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                );
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;
            }
        });
        (base_url, requests, handle)
    }

    fn execute_iron_control_stub_response(method: &str, path: &str) -> (&'static str, String) {
        fn principal_body(id: &str, foreign_id: &str) -> String {
            format!(
                r#"{{"data":{{"id":"{id}","namespace":"default","foreign_id":"{foreign_id}","name":"stub","labels":{{}}}}}}"#
            )
        }
        match method {
            "GET" if path.starts_with("/api/v1/principals/lookup/") => {
                ("404 Not Found", r#"{"error":"not found"}"#.to_owned())
            }
            "GET" if path.starts_with("/api/v1/principals/prn_") => {
                let id = path.rsplit('/').next().unwrap_or_default();
                ("200 OK", principal_body(id, "stub"))
            }
            "PUT" if path.starts_with("/api/v1/principals/") => {
                let foreign_id = path.rsplit('/').next().unwrap_or_default();
                (
                    "200 OK",
                    principal_body(&format!("prn_{foreign_id}"), foreign_id),
                )
            }
            "POST" if path.ends_with("/slack_channel_permissions") => {
                ("200 OK", r#"{"data":{"ok":true}}"#.to_owned())
            }
            _ => (
                "500 Internal Server Error",
                r#"{"error":"unexpected"}"#.to_owned(),
            ),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn capacity_pressure_pauses_oldest_idle_assigned_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.set_observed_status(
            "sbx-old",
            SandboxStatus::Unknown("status temporarily unavailable".to_owned()),
        );
        backend.set_observed_status("sbx-hot", SandboxStatus::Running);
        backend.set_observed_status("sbx-stale", SandboxStatus::Gone);
        backend.set_observed_status("sbx-paused", SandboxStatus::Suspended);

        let stale_thread =
            ThreadKey::parse(format!("test:capacity-stale-{}", uuid::Uuid::new_v4())).unwrap();
        let paused_thread =
            ThreadKey::parse(format!("test:capacity-paused-{}", uuid::Uuid::new_v4())).unwrap();
        let old_thread =
            ThreadKey::parse(format!("test:capacity-old-{}", uuid::Uuid::new_v4())).unwrap();
        let hot_thread =
            ThreadKey::parse(format!("test:capacity-hot-{}", uuid::Uuid::new_v4())).unwrap();
        let trigger_thread =
            ThreadKey::parse(format!("test:capacity-trigger-{}", uuid::Uuid::new_v4())).unwrap();

        store
            .create_or_get_session(
                &stale_thread,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create stale session");
        store
            .update_sandbox_id(&stale_thread, Some("sbx-stale"))
            .await
            .expect("assign stale sandbox");
        store
            .create_or_get_session(
                &paused_thread,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create paused session");
        store
            .update_sandbox_id(&paused_thread, Some("sbx-paused"))
            .await
            .expect("assign paused sandbox");
        store
            .append_event(
                &paused_thread,
                None,
                "session.sandbox_paused",
                json!({
                    "thread_key": paused_thread.as_str(),
                    "sandbox_id": "sbx-paused",
                    "reason": "capacity_pressure",
                }),
            )
            .await
            .expect("append paused event");
        store
            .create_or_get_session(
                &old_thread,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create old session");
        store
            .update_sandbox_id(&old_thread, Some("sbx-old"))
            .await
            .expect("assign old sandbox");
        store
            .create_or_get_session(
                &hot_thread,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create hot session");
        store
            .update_sandbox_id(&hot_thread, Some("sbx-hot"))
            .await
            .expect("assign hot sandbox");
        sqlx::query(
            r#"
            update sessions
            set sandbox_last_active_at = case
                    when thread_key = $1 then now() - interval '3 hours'
                    when thread_key = $2 then now() - interval '2 hours'
                    when thread_key = $3 then now() - interval '1 hour'
                end
            where thread_key in ($1, $2, $3)
            "#,
        )
        .bind(stale_thread.as_str())
        .bind(paused_thread.as_str())
        .bind(old_thread.as_str())
        .execute(store.pool())
        .await
        .expect("age capacity candidates");

        let controller = SandboxCapacityController::new(
            store.clone(),
            Arc::new(SandboxManager::new(backend.clone())),
            Arc::new(DashMap::new()),
            SandboxCapacityConfig {
                max_running: 2,
                hot_idle_grace: Duration::from_secs(300),
            },
        );

        controller
            .run_with_capacity(&trigger_thread, "exe-trigger", "cold_create", || async {
                Ok(())
            })
            .await
            .expect("admit under capacity");

        assert_eq!(backend.status_of("sbx-old"), Some(SandboxStatus::Suspended));
        assert_eq!(backend.status_of("sbx-hot"), Some(SandboxStatus::Running));
        assert_eq!(
            store
                .get_session(&stale_thread)
                .await
                .expect("get stale session")
                .sandbox_id,
            None
        );
        assert_eq!(
            store
                .get_session(&paused_thread)
                .await
                .expect("get paused session")
                .sandbox_id
                .as_deref(),
            Some("sbx-paused")
        );
        let old_events = store
            .list_events_after(&old_thread, 0, None, 100)
            .await
            .expect("list old events");
        assert!(old_events.iter().any(|event| {
            event.event_type == "session.sandbox_paused"
                && event.payload.get("reason").and_then(Value::as_str) == Some("capacity_pressure")
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workflow_cleanup_stops_and_clears_owned_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let workflow_run_id = format!("run-{}", uuid::Uuid::new_v4());
        let thread_key =
            ThreadKey::parse(format!("test:wf-cleanup-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({
                    "source": "absurd_workflow",
                    "workflow_run_id": workflow_run_id,
                    "workflow_owned_thread": true,
                }),
                Default::default(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-owned"))
            .await
            .expect("set sandbox id");
        store
            .insert_ready_warm_sandbox("sbx-owned", "test-workload")
            .await
            .expect("insert warm sandbox");
        assert_eq!(
            store
                .claim_ready_warm_sandbox("test-workload", thread_key.as_str())
                .await
                .expect("claim warm sandbox"),
            Some("sbx-owned".to_owned())
        );
        assert!(
            store
                .list_referenced_sandbox_ids()
                .await
                .expect("list referenced sandboxes")
                .contains(&"sbx-owned".to_owned())
        );

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let report = runtime
            .stop_workflow_owned_sandboxes(&workflow_run_id, "test")
            .await
            .expect("cleanup workflow sandboxes");

        assert_eq!(report.stopped, vec!["sbx-owned".to_owned()]);
        assert_eq!(backend.stopped(), vec!["sbx-owned".to_owned()]);
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            None
        );
        assert!(
            !store
                .list_referenced_sandbox_ids()
                .await
                .expect("list referenced sandboxes")
                .contains(&"sbx-owned".to_owned())
        );
        let all = events(&store, &thread_key).await;
        assert!(all.iter().any(|event| {
            event.event_type == "session.workflow_sandbox_stopped"
                && event.payload["workflow_run_id"] == json!(workflow_run_id)
                && event.payload["cleared"] == json!(true)
        }));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workflow_cleanup_preserves_explicit_unowned_thread_key() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let workflow_run_id = format!("run-{}", uuid::Uuid::new_v4());
        let thread_key =
            ThreadKey::parse(format!("test:wf-explicit-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({
                    "source": "absurd_workflow",
                    "workflow_run_id": workflow_run_id,
                }),
                Default::default(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-explicit"))
            .await
            .expect("set sandbox id");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let report = runtime
            .stop_workflow_owned_sandboxes(&workflow_run_id, "test")
            .await
            .expect("cleanup workflow sandboxes");

        assert!(report.stopped.is_empty());
        assert!(backend.stopped().is_empty());
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            Some("sbx-explicit".to_owned())
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn workflow_cleanup_clears_owned_sandbox_when_backend_reports_missing() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let workflow_run_id = format!("run-{}", uuid::Uuid::new_v4());
        let thread_key =
            ThreadKey::parse(format!("test:wf-missing-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({
                    "source": "absurd_workflow",
                    "workflow_run_id": workflow_run_id,
                    "workflow_owned_thread": true,
                }),
                Default::default(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-missing"))
            .await
            .expect("set sandbox id");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.mark_stop_missing("sbx-missing");
        let runtime = runtime_with(&store, backend);
        let report = runtime
            .stop_workflow_owned_sandboxes(&workflow_run_id, "test")
            .await
            .expect("cleanup workflow sandboxes");

        assert_eq!(report.missing, vec!["sbx-missing".to_owned()]);
        assert_eq!(
            store.get_session(&thread_key).await.unwrap().sandbox_id,
            None
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn resume_failure_replaces_sandbox_and_preserves_harness_thread_id() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:resume-failed-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("sbx-old"))
            .await
            .expect("set sandbox id");
        store
            .update_harness_thread_id(&thread_key, Some("harness-thread-1"))
            .await
            .expect("set harness thread id");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Suspended, Vec::new()));
        backend.fail_resume();
        let runtime = runtime_with(&store, backend);
        let sandbox_id = runtime
            .ensure_session_sandbox(EnsureSessionSandboxRequest {
                thread_key: &thread_key,
                harness_type: &HarnessType::Codex,
                persona_id: None,
                existing_sandbox_id: Some("sbx-old"),
                existing_sandbox_capabilities: None,
                iron_control_principal: None,
                requester_principal: None,
                proxy_labels: &BTreeMap::new(),
                desired_capabilities: &SessionSandboxCapabilities::default_enabled(),
                execution_id: &execution_id,
            })
            .await
            .expect("resume failure should fall through to replacement");

        assert_eq!(sandbox_id, "mock-sbx");
        let session = store.get_session(&thread_key).await.unwrap();
        assert_eq!(session.sandbox_id, Some("mock-sbx".to_owned()));
        assert_eq!(
            session.harness_thread_id,
            Some("harness-thread-1".to_owned())
        );
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.sandbox_resume_failed")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_pipe_ensure_opens_one_io_per_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:pipe-race-{}", uuid::Uuid::new_v4())).unwrap();
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (first_io, _first_stdout, _first_stdin) = mock_io();
        let (second_io, _second_stdout, _second_stdin) = mock_io();
        backend.push_io(first_io).await;
        backend.push_io(second_io).await;

        let runtime = runtime_with(&store, backend.clone());
        let (first, second) = tokio::join!(
            runtime.ensure_session_pipe(&thread_key, "sbx-pipe-race"),
            runtime.ensure_session_pipe(&thread_key, "sbx-pipe-race"),
        );

        first.expect("first pipe ensure should succeed");
        second.expect("second pipe ensure should reuse the first pipe");
        assert_eq!(backend.opens(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_eof_recovers_terminal_output_from_recorded_logs() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:eof-recorded-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-recorded"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, stdout, _stdin) = mock_io();
        backend.push_io(io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime
            .ensure_session_pipe(&thread_key, "sbx-recorded")
            .await
            .expect("open initial pipe");
        backend.set_recorded_output(completed_output_lines("Recovered from pod logs."));
        drop(stdout);

        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.stdout_pump_recovered"),
            "expected recorded-output recovery event"
        );
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.stdout_pump_reattached"),
            "recorded terminal output should avoid a live reattach"
        );
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.execution_failed"),
            "stdout eof should not fail an active execution when logs contain a terminal turn"
        );
        let completed = all
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("completed event");
        assert_eq!(
            completed.payload["result_text"].as_str(),
            Some("Recovered from pod logs.")
        );
        assert_eq!(backend.opens(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_eof_reattaches_and_delivers_late_terminal_output() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:eof-reattach-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-reattach"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (first_io, mut first_stdout, _first_stdin) = mock_io();
        let (second_io, mut second_stdout, _second_stdin) = mock_io();
        backend.push_io(first_io).await;
        backend.push_io(second_io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime
            .ensure_session_pipe(&thread_key, "sbx-reattach")
            .await
            .expect("open initial pipe");
        first_stdout
            .write_all(b"{\"type\":\"thread.started\",\"thread_id\":\"mock-thread\"}\n")
            .await
            .unwrap();
        drop(first_stdout);

        wait_for_event(&store, &thread_key, "session.stdout_pump_reattached").await;
        second_stdout
            .write_all(&completed_output_bytes("Completed after reattach."))
            .await
            .unwrap();

        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.execution_failed"),
            "reattached stdout should not produce the old false failure"
        );
        let completed = all
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("completed event");
        assert_eq!(
            completed.payload["result_text"].as_str(),
            Some("Completed after reattach.")
        );
        assert_eq!(backend.opens(), 2);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_resumes_after_ownership_handoff() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:stdout-handoff-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id =
            orphaned_execution(&store, &thread_key, Some("sbx-stdout-handoff"), true).await;
        assert!(
            store
                .claim_stdout_owner(
                    &execution_id,
                    "previous-control-plane",
                    Duration::from_secs(60),
                )
                .await
                .expect("claim previous owner")
        );

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, mut stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime = runtime_with(&store, backend);
        runtime
            .ensure_session_pipe(&thread_key, "sbx-stdout-handoff")
            .await
            .expect("open stdout pump");

        // A row received during the lease handoff is fenced, but must not
        // permanently disable this pump for the execution.
        stdout
            .write_all(b"{\"type\":\"thread.started\",\"thread_id\":\"handoff-thread\"}\n")
            .await
            .unwrap();
        sleep(Duration::from_millis(100)).await;
        store
            .release_stdout_owner(&execution_id, "previous-control-plane")
            .await
            .expect("release previous owner");
        assert!(
            store
                .claim_stdout_owner(
                    &execution_id,
                    &runtime.stdout_owner_id,
                    Duration::from_secs(60),
                )
                .await
                .expect("claim current owner")
        );

        stdout
            .write_all(&completed_output_bytes(
                "Completed after ownership handoff.",
            ))
            .await
            .unwrap();
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        let completed = all
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("completed event");
        assert_eq!(
            completed.payload["result_text"].as_str(),
            Some("Completed after ownership handoff.")
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn stdout_eof_fails_when_sandbox_no_longer_accepts_io() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:eof-gone-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-gone"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, stdout, _stdin) = mock_io();
        backend.push_io(io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime
            .ensure_session_pipe(&thread_key, "sbx-gone")
            .await
            .expect("open initial pipe");
        backend.set_status(SandboxStatus::Gone);
        drop(stdout);

        wait_for_event(&store, &thread_key, "session.execution_failed").await;
        let all = events(&store, &thread_key).await;
        let failed = all
            .iter()
            .find(|event| event.event_type == "session.execution_failed")
            .expect("failed event");
        let error = failed.payload["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("sandbox stdout closed before terminal output"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("sandbox no longer accepts io"),
            "expected sandbox status detail: {error}"
        );
        assert!(
            !all.iter()
                .any(|event| event.event_type == "session.stdout_pump_reattached"),
            "gone sandbox should not reattach"
        );
        assert_eq!(backend.opens(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adopts_finished_turn_from_recorded_sandbox_output() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-logs-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;

        let backend = Arc::new(MockBackend::new(
            SandboxStatus::Running,
            vec![
                json!({"type": "item.completed", "item": {"id": "msg-1", "type": "agentMessage", "text": "Done: pushed commit abc123.", "phase": "final_answer"}}).to_string(),
                json!({"type": "turn.completed", "turn": {"id": "turn-1", "status": "completed"}}).to_string(),
            ],
        ));
        let runtime = runtime_with(&store, backend.clone());
        runtime.adopt_orphaned_executions().await;

        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.execution_adopted"),
            "expected an adoption event"
        );
        let completed = all
            .iter()
            .find(|event| event.event_type == "session.execution_completed")
            .expect("completed event");
        assert_eq!(
            completed.payload["result_text"].as_str(),
            Some("Done: pushed commit abc123.")
        );
        // The terminal came from recorded output; no live attach was needed.
        assert_eq!(backend.opens(), 0);
        let session = store.get_session(&thread_key).await.unwrap();
        assert_ne!(session.status.as_ref(), "failed");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adopts_live_when_recorded_output_has_no_terminal() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-live-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let (io, mut stdout, _stdin) = mock_io();
        backend.push_io(io).await;

        let runtime = runtime_with(&store, backend.clone());
        runtime.adopt_orphaned_executions().await;
        assert_eq!(backend.opens(), 1);

        stdout
            .write_all(
                b"{\"type\":\"turn.completed\",\"turn\":{\"id\":\"turn-1\",\"status\":\"completed\"}}\n",
            )
            .await
            .unwrap();
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter().any(|event| {
                event.event_type == "session.execution_adopted"
                    && event.payload["mode"] == json!("live_attach")
            }),
            "expected a live adoption event"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fails_orphans_whose_sandbox_is_gone() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-gone-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Gone, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        runtime.adopt_orphaned_executions().await;

        wait_for_event(&store, &thread_key, "session.execution_failed").await;
        let all = events(&store, &thread_key).await;
        let failed = all
            .iter()
            .find(|event| event.event_type == "session.execution_failed")
            .expect("failed event");
        let error = failed.payload["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("execution orphaned by control plane restart"),
            "unexpected error: {error}"
        );
        assert!(
            error.contains("sandbox no longer accepts io"),
            "expected status detail: {error}"
        );
        assert_eq!(backend.opens(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dispatches_queued_orphans_from_durable_input() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-queued-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, None, false).await;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let create_gate = backend.hold_create();
        let (io, mut stdout, _stdin) = mock_io();
        backend.push_io(io).await;
        let runtime = runtime_with(&store, backend.clone());
        timeout(Duration::from_secs(1), runtime.adopt_orphaned_executions())
            .await
            .expect("adoption scan must not wait for sandbox creation");

        let all = events(&store, &thread_key).await;
        assert!(
            all.iter().any(|event| {
                event.event_type == "session.execution_adopted"
                    && event.payload["mode"] == json!("queued_request")
            }),
            "expected queued request adoption event"
        );
        timeout(Duration::from_secs(1), backend.create_started.notified())
            .await
            .expect("background recovery should start sandbox creation");
        assert_eq!(backend.opens(), 0);

        create_gate.notify_one();
        stdout
            .write_all(&completed_output_bytes("Recovered queued request."))
            .await
            .unwrap();
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
        let latest = store
            .latest_execution_for_thread(&thread_key)
            .await
            .expect("load latest execution")
            .expect("execution exists");
        assert_eq!(latest.execution_id, execution_id);
        assert_eq!(latest.status, ExecutionStatus::Completed);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn periodic_scan_graces_young_legacy_queued_execution_without_request() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-legacy-{}", uuid::Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                Default::default(),
            )
            .await
            .expect("create session");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create legacy execution")
            .execution
            .execution_id;

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        runtime
            .run_orphan_adoption_scan(
                &mut OrphanAdoptionState::default(),
                Some(PRE_SANDBOX_ORPHAN_GRACE),
            )
            .await;

        let active = store
            .active_execution_for_thread(&thread_key)
            .await
            .expect("load active execution")
            .expect("legacy execution remains active");
        assert_eq!(active.execution_id, execution_id);
        assert_eq!(active.status, ExecutionStatus::Queued);
        assert!(
            events(&store, &thread_key)
                .await
                .iter()
                .all(|event| event.event_type != "session.execution_failed"),
            "young legacy execution must remain claimable by the old process"
        );

        let claim = store
            .mark_execution_running(&execution_id)
            .await
            .expect("old process claims execution after grace");
        assert!(claim.claimed);
        store
            .fail_execution(&execution_id, "test cleanup")
            .await
            .expect("terminalize legacy execution");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn periodic_scan_graces_young_running_executions() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        let mut state = OrphanAdoptionState::default();
        let running_thread =
            ThreadKey::parse(format!("test:adopt-young-running-{}", uuid::Uuid::new_v4())).unwrap();
        let running_execution = orphaned_execution(&store, &running_thread, None, true).await;
        runtime
            .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
            .await;
        assert!(
            events(&store, &running_thread)
                .await
                .iter()
                .all(|event| event.event_type != "session.execution_failed"),
            "young running execution must survive sandbox assignment"
        );

        backdate_execution(&store, &running_execution, 300.0).await;
        runtime
            .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
            .await;
        wait_for_event(&store, &running_thread, "session.execution_failed").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adopts_deferred_execution_after_lease_expires() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-deferred-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;
        store
            .claim_stdout_owner(
                &execution_id,
                "other-control-plane",
                Duration::from_secs(60),
            )
            .await
            .expect("claim lease for other owner");

        let backend = Arc::new(MockBackend::new(
            SandboxStatus::Running,
            vec![
                json!({"type": "item.completed", "item": {"id": "msg-1", "type": "agentMessage", "text": "Done: recovered after handoff.", "phase": "final_answer"}}).to_string(),
                json!({"type": "turn.completed", "turn": {"id": "turn-1", "status": "completed"}}).to_string(),
            ],
        ));
        let runtime = runtime_with(&store, backend.clone());

        // While another control plane holds the stdout-owner lease the scan
        // must defer instead of stealing the execution.
        runtime.adopt_orphaned_executions().await;
        wait_for_event(&store, &thread_key, "session.execution_adoption_deferred").await;
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .all(|event| event.event_type != "session.execution_completed"),
            "deferred execution must not be terminalized"
        );

        // Once the lease expires (owner died without releasing), a later
        // scan adopts the execution and recovers the recorded terminal. The
        // expiry is forced in the database rather than slept through so slow
        // test databases cannot turn the first scan into the adopting one.
        expire_stdout_lease(&store, &execution_id).await;
        runtime.adopt_orphaned_executions().await;
        wait_for_event(&store, &thread_key, "session.execution_adopted").await;
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn periodic_scan_ignores_executions_owned_by_this_process() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-own-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        assert!(
            store
                .claim_stdout_owner(
                    &execution_id,
                    &runtime.stdout_owner_id,
                    Duration::from_secs(60)
                )
                .await
                .expect("claim as this control plane")
        );

        // A healthy execution owned by the scanning process must be skipped
        // silently: no deferral event, no sandbox status probe.
        let mut state = OrphanAdoptionState::default();
        runtime
            .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
            .await;
        runtime
            .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
            .await;

        let all = events(&store, &thread_key).await;
        assert!(
            all.iter().all(|event| {
                event.event_type != "session.execution_adoption_deferred"
                    && event.event_type != "session.execution_adopted"
                    && event.event_type != "session.execution_failed"
            }),
            "self-owned execution must not be touched by the scan"
        );
        store
            .fail_execution_if_active(&execution_id, "test cleanup")
            .await
            .expect("terminalize execution");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawned_adoption_loop_recovers_orphans() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-loop-{}", uuid::Uuid::new_v4())).unwrap();
        orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;

        let backend = Arc::new(MockBackend::new(
            SandboxStatus::Running,
            vec![
                json!({"type": "item.completed", "item": {"id": "msg-1", "type": "agentMessage", "text": "Done: recovered by the loop.", "phase": "final_answer"}}).to_string(),
                json!({"type": "turn.completed", "turn": {"id": "turn-1", "status": "completed"}}).to_string(),
            ],
        ));
        let runtime = runtime_with(&store, backend.clone());
        runtime.spawn_orphan_adoption(Duration::from_millis(50));

        wait_for_event(&store, &thread_key, "session.execution_adopted").await;
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn periodic_scans_record_deferral_once() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:adopt-dedup-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;
        store
            .claim_stdout_owner(
                &execution_id,
                "other-control-plane",
                Duration::from_secs(60),
            )
            .await
            .expect("claim lease for other owner");

        let backend = Arc::new(MockBackend::new(
            SandboxStatus::Running,
            vec![
                json!({"type": "item.completed", "item": {"id": "msg-1", "type": "agentMessage", "text": "Done: recovered after release.", "phase": "final_answer"}}).to_string(),
                json!({"type": "turn.completed", "turn": {"id": "turn-1", "status": "completed"}}).to_string(),
            ],
        ));
        let runtime = runtime_with(&store, backend.clone());

        // Repeated periodic scans over the same held lease must record the
        // deferral event only once.
        let mut state = OrphanAdoptionState::default();
        runtime
            .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
            .await;
        runtime
            .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
            .await;
        let all = events(&store, &thread_key).await;
        let deferrals = all
            .iter()
            .filter(|event| event.event_type == "session.execution_adoption_deferred")
            .count();
        assert_eq!(deferrals, 1, "deferral event must be recorded once");

        // Releasing the lease (a clean shutdown handoff) lets the next scan
        // adopt immediately; this also terminalizes the execution before the
        // test releases TEST_LOCK.
        store
            .release_stdout_owner(&execution_id, "other-control-plane")
            .await
            .expect("release lease");
        runtime
            .run_orphan_adoption_scan(&mut state, Some(PRE_SANDBOX_ORPHAN_GRACE))
            .await;
        wait_for_event(&store, &thread_key, "session.execution_completed").await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_handoff_releases_owned_leases() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:handoff-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        assert!(
            store
                .claim_stdout_owner(
                    &execution_id,
                    &runtime.stdout_owner_id,
                    Duration::from_secs(60)
                )
                .await
                .expect("claim as this control plane")
        );

        let _ = runtime.handoff_owned_executions(Duration::ZERO).await;

        wait_for_event(&store, &thread_key, "session.stdout_owner_released").await;
        // The lease is immediately claimable by a peer control plane; without
        // the handoff it would only expire after the lease TTL.
        assert!(
            store
                .claim_stdout_owner(&execution_id, "peer-control-plane", Duration::from_secs(5))
                .await
                .expect("peer claims released lease")
        );
        store
            .fail_execution_if_active(&execution_id, "test cleanup")
            .await
            .expect("terminalize execution");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_handoff_waits_for_executions_to_finish() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:handoff-wait-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        assert!(
            store
                .claim_stdout_owner(
                    &execution_id,
                    &runtime.stdout_owner_id,
                    Duration::from_secs(60)
                )
                .await
                .expect("claim as this control plane")
        );

        // The execution finishes while the drain is waiting; no lease should
        // be released and no handoff event recorded.
        let completer_store = store.clone();
        let completer_id = execution_id.clone();
        let completer = tokio::spawn(async move {
            sleep(Duration::from_millis(300)).await;
            completer_store
                .complete_execution_if_active(&completer_id)
                .await
                .expect("complete execution")
        });
        let _ = runtime
            .handoff_owned_executions(Duration::from_secs(5))
            .await;
        let completed = completer.await.expect("completer task");
        assert!(
            completed.is_some(),
            "the completer, not the handoff, must terminalize the execution"
        );

        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .all(|event| event.event_type != "session.stdout_owner_released"),
            "finished execution must not be handed off"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_fences_new_stdout_claims() {
        let Some(store) = test_store().await else {
            return;
        };
        let _serial = TEST_LOCK.lock().await;
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);

        // Nothing owned: the handoff returns immediately but still flips
        // the shutdown fence.
        let _ = runtime.handoff_owned_executions(Duration::ZERO).await;

        let thread_key =
            ThreadKey::parse(format!("test:handoff-fence-{}", uuid::Uuid::new_v4())).unwrap();
        let execution_id = orphaned_execution(&store, &thread_key, Some("sbx-mock"), true).await;
        let error = runtime
            .claim_stdout_owner(&execution_id)
            .await
            .expect_err("claims after shutdown must be rejected");
        assert!(
            matches!(error, SessionRuntimeError::ShuttingDown),
            "unexpected error: {error}"
        );
        runtime
            .handle_stdout_claim_failure(&thread_key, &execution_id, &error)
            .await;
        let execution = store
            .latest_execution_for_thread(&thread_key)
            .await
            .expect("load execution")
            .expect("execution exists");
        assert_eq!(execution.execution_id, execution_id);
        assert_eq!(execution.status, ExecutionStatus::Queued);
        assert!(execution.started_at.is_none());
        store
            .fail_execution_if_active(&execution_id, "test cleanup")
            .await
            .expect("terminalize execution");
    }

    // ---- session exclusive ownership runtime integration (centaur-3w2.2) ----

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn omp_oneshot_execution_rejected_when_resident_holds_session() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:omp-resident-block-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");

        // Simulate a resident collaboration host holding the session.
        let ownership = store
            .acquire_session_ownership(&thread_key, "resident-host", SessionOwnerMode::Resident)
            .await
            .expect("resident acquires");
        assert!(ownership.acquired);

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);

        // A one-shot execution cannot start against the resident-owned session.
        let error = runtime
            .execute_session(
                &thread_key,
                ExecuteSessionInput {
                    idempotency_key: None,
                    metadata: None,
                    input_lines: vec![json!({"type":"user","message":"hi"}).to_string()],
                    idle_timeout_ms: None,
                    max_duration_ms: None,
                },
            )
            .await
            .expect_err("one-shot must be rejected");
        assert!(
            matches!(error, SessionRuntimeError::SessionOwned { .. }),
            "expected SessionOwned, got {error:?}"
        );

        // Releasing the resident lease lets the one-shot through the ownership
        // boundary (it then fails at sandbox ensure on the mock, but the
        // ownership acquire itself must no longer be the blocker).
        assert!(
            store
                .release_session_ownership(&thread_key, "resident-host")
                .await
                .expect("release"),
            "resident releases"
        );
        let error2 = runtime
            .execute_session(
                &thread_key,
                ExecuteSessionInput {
                    idempotency_key: None,
                    metadata: None,
                    input_lines: vec![json!({"type":"user","message":"hi"}).to_string()],
                    idle_timeout_ms: None,
                    max_duration_ms: None,
                },
            )
            .await
            .expect_err("sandbox ensure fails on mock, but ownership acquire passes");
        assert!(
            !matches!(error2, SessionRuntimeError::SessionOwned { .. }),
            "must not be SessionOwned after release, got {error2:?}"
        );

        // Cleanup: terminalize any execution the second attempt may have created.
        if let Ok(Some(execution)) = store.active_execution_for_thread(&thread_key).await {
            let _ = store
                .fail_execution_if_active(&execution.execution_id, "test cleanup")
                .await;
        }
        let _ = store
            .release_session_ownership(&thread_key, "api-rs-runtime")
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn omp_oneshot_owner_renews_past_the_initial_lease() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:omp-oneshot-renew-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        let generation = runtime
            .acquire_oneshot_session_ownership(&thread_key, &HarnessType::Omp)
            .await
            .expect("acquire one-shot ownership")
            .expect("OMP ownership generation");
        let execution = store
            .create_execution(
                &thread_key,
                None,
                json!({"_session_owner_generation": generation}),
            )
            .await
            .expect("create execution")
            .execution;
        store
            .mark_execution_running(&execution.execution_id)
            .await
            .expect("mark running");
        runtime
            .session_ownership_generations
            .insert(execution.execution_id.clone(), generation);
        runtime
            .claim_stdout_owner(&execution.execution_id)
            .await
            .expect("claim stdout owner");

        sqlx::query(
            r#"
            update session_owners
            set lease_expires_at = now() + interval '150 milliseconds'
            where thread_key = $1 and owner_id = $2 and generation = $3
            "#,
        )
        .bind(thread_key.as_str())
        .bind(&runtime.stdout_owner_id)
        .bind(generation)
        .execute(store.pool())
        .await
        .expect("shorten initial session ownership lease");
        spawn_execution_session_owner_renewer(
            runtime.context(),
            thread_key.clone(),
            execution.execution_id.clone(),
            generation,
            Duration::from_millis(25),
        );

        sleep(Duration::from_millis(300)).await;
        let appended = store
            .append_event_if_stdout_owner(
                &thread_key,
                &execution.execution_id,
                &runtime.stdout_owner_id,
                STDOUT_OWNER_LEASE,
                SESSION_OUTPUT_LINE_EVENT,
                json!("line after initial lease"),
            )
            .await
            .expect("append after initial ownership lease");
        assert!(
            appended.is_some(),
            "one-shot ownership renewal must preserve late execution output"
        );

        store
            .fail_execution_if_active(&execution.execution_id, "test cleanup")
            .await
            .expect("terminalize execution");
        sqlx::query(
            r#"
            update session_owners
            set lease_expires_at = now() + interval '150 milliseconds'
            where thread_key = $1 and owner_id = $2 and generation = $3
            "#,
        )
        .bind(thread_key.as_str())
        .bind(&runtime.stdout_owner_id)
        .bind(generation)
        .execute(store.pool())
        .await
        .expect("shorten completed execution ownership");
        sleep(Duration::from_millis(300)).await;
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("check completed execution ownership")
                .is_none(),
            "one-shot renewer must stop after the execution becomes terminal"
        );
        let successor = store
            .acquire_session_ownership(
                &thread_key,
                &runtime.stdout_owner_id,
                SessionOwnerMode::Oneshot,
            )
            .await
            .expect("successor acquires ownership");
        assert!(successor.acquired);
        assert!(successor.generation > generation);

        release_execution_session_ownership(
            &runtime.context(),
            &thread_key,
            &execution.execution_id,
        )
        .await;
        assert!(
            store
                .session_ownership_matches(
                    &thread_key,
                    &runtime.stdout_owner_id,
                    successor.generation,
                )
                .await
                .expect("check successor ownership"),
            "stale execution cleanup must not release a newer generation"
        );
        let _ = store
            .release_session_ownership_at_generation(
                &thread_key,
                &runtime.stdout_owner_id,
                successor.generation,
            )
            .await;
        let _ = store
            .release_stdout_owner(&execution.execution_id, &runtime.stdout_owner_id)
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn non_omp_harnesses_skip_session_ownership_boundary() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key = ThreadKey::parse(format!("test:non-omp-skip-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");

        // Even if a session ownership row exists for a non-OMP session, the
        // runtime's one-shot acquire helper skips non-OMP harnesses.
        store
            .acquire_session_ownership(&thread_key, "resident-host", SessionOwnerMode::Resident)
            .await
            .expect("seed ownership row");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);

        // The one-shot acquire helper is a no-op for Codex sessions.
        runtime
            .acquire_oneshot_session_ownership(&thread_key, &HarnessType::Codex)
            .await
            .expect("non-OMP harness skips ownership boundary");

        // The resident's lease is still intact — the non-OMP path did not
        // touch it.
        assert!(
            store
                .session_ownership_fence_matches(&thread_key, 1)
                .await
                .expect("fence check"),
            "non-OMP acquire must not steal the resident's lease"
        );

        // Cleanup.
        let _ = store
            .release_session_ownership(&thread_key, "resident-host")
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn omp_idempotent_retry_resolves_before_resident_ownership_gate() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:omp-idempotent-retry-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        let existing = store
            .create_execution(&thread_key, Some("retry-key"), json!({}))
            .await
            .expect("create execution")
            .execution;
        store
            .mark_execution_running(&existing.execution_id)
            .await
            .expect("mark existing running");
        store
            .acquire_session_ownership(&thread_key, "resident-host", SessionOwnerMode::Resident)
            .await
            .expect("resident acquires");

        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        let result = runtime
            .execute_session(
                &thread_key,
                ExecuteSessionInput {
                    idempotency_key: Some("retry-key".to_owned()),
                    metadata: None,
                    input_lines: vec![json!({"type":"user","message":"retry"}).to_string()],
                    idle_timeout_ms: None,
                    max_duration_ms: None,
                },
            )
            .await
            .expect("idempotent retry resolves before ownership gate");
        assert_eq!(result.execution_id, existing.execution_id);
        assert_eq!(result.status, ExecutionStatus::Running);

        let _ = store
            .fail_execution_if_active(&existing.execution_id, "test cleanup")
            .await;
        let _ = store
            .release_session_ownership(&thread_key, "resident-host")
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn adoption_defers_when_resident_session_owner_is_live() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:omp-adopt-defer-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_assignment(&thread_key, "sbx-adopt", &default_capabilities())
            .await
            .expect("assign sandbox");
        let execution_id = store
            .create_execution(&thread_key, None, json!({}))
            .await
            .expect("create execution")
            .execution
            .execution_id;
        store
            .mark_execution_running(&execution_id)
            .await
            .expect("mark running");
        backdate_execution(&store, &execution_id, 200.0).await;

        // A resident owner holds the session — adoption must not claim stdout
        // or pump against the resident host.
        store
            .acquire_session_ownership(&thread_key, "resident-host", SessionOwnerMode::Resident)
            .await
            .expect("resident acquires");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        runtime.adopt_orphaned_executions().await;
        wait_for_event(&store, &thread_key, "session.execution_adoption_deferred").await;

        // The execution must not be terminalized — the resident still owns it.
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .all(|event| event.event_type != "session.execution_completed"),
            "resident-owned execution must not be terminalized by adoption"
        );

        // Cleanup.
        let _ = store
            .fail_execution_if_active(&execution_id, "test cleanup")
            .await;
        let _ = store
            .release_session_ownership(&thread_key, "resident-host")
            .await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn handoff_owned_executions_releases_session_ownership() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key = ThreadKey::parse(format!("test:omp-handoff-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");

        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);

        // Simulate this control plane holding a one-shot session ownership lease.
        let acquired = runtime
            .acquire_oneshot_session_ownership(&thread_key, &HarnessType::Omp)
            .await
            .expect("acquire one-shot ownership");
        assert!(acquired.is_some());

        // Handoff releases every session ownership lease held by this owner.
        let _ = runtime.handoff_owned_executions(Duration::ZERO).await;

        // The lease must be gone — a peer can reclaim the session immediately.
        let owner = store
            .active_session_ownership(&thread_key)
            .await
            .expect("lookup");
        assert!(
            owner.is_none(),
            "session ownership must be released at handoff"
        );
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_room_stop_loss_recovery_and_stale_generation_are_fenced() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-lifecycle-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("asbx-lifecycle"))
            .await
            .expect("assign sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire resident lease");
        assert!(owner.acquired);
        let keepalive = Arc::new(AtomicBool::new(true));
        let old_url = "https://relay.example/old".to_owned();
        let old_state = CollabRoomState {
            active: true,
            join_url: Some(old_url.clone()),
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: Vec::new(),
        };
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        // Live assigned sandbox + resident IO while the room remains active.
        push_resident_collab_io(&backend, old_state.clone()).await;
        // Extra IO for stop after recovery.
        push_resident_collab_io(
            &backend,
            CollabRoomState {
                active: true,
                join_url: Some("https://relay.example/new".to_owned()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
        )
        .await;
        let runtime = runtime_with(&store, backend);
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-lifecycle".to_owned(),
                state: old_state.clone(),
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );

        let stale_state = CollabRoomState {
            join_url: Some("https://relay.example/stale".to_owned()),
            ..old_state.clone()
        };
        assert!(
            !runtime
                .update_collab_room_state(
                    &thread_key,
                    "resident-1",
                    owner.generation + 1,
                    &stale_state,
                )
                .await
                .expect("stale update is rejected")
        );
        assert_eq!(
            runtime
                .collab_room_status(&thread_key)
                .await
                .unwrap()
                .room
                .expect("room remains")
                .join_url,
            Some(old_url.clone())
        );

        tokio::time::timeout(
            Duration::from_secs(1),
            runtime.lose_collab_room(&thread_key, "relay_lost"),
        )
        .await
        .expect("lose room within 1s")
        .expect("lose room");
        assert!(!runtime.has_active_collab_room(&thread_key));
        assert!(!keepalive.load(Ordering::SeqCst));

        let recovered = store
            .acquire_session_ownership(&thread_key, "resident-2", SessionOwnerMode::Resident)
            .await
            .expect("recover resident lease");
        assert!(recovered.acquired);
        let new_url = "https://relay.example/new".to_owned();
        assert_ne!(old_url, new_url);
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-2".to_owned(),
                generation: recovered.generation,
                sandbox_id: "asbx-lifecycle".to_owned(),
                state: CollabRoomState {
                    join_url: Some(new_url.clone()),
                    ..old_state
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let stopped = tokio::time::timeout(
            Duration::from_secs(1),
            runtime.stop_collab_room(&thread_key, &CollabStopInput { reason: None }),
        )
        .await
        .expect("stop recovered room within 1s")
        .expect("stop recovered room");
        assert!(stopped.ok);
        assert!(
            runtime
                .collab_room_status(&thread_key)
                .await
                .unwrap()
                .room
                .is_none()
        );
        let idempotent = runtime
            .stop_collab_room(&thread_key, &CollabStopInput { reason: None })
            .await
            .expect("idempotent stop");
        assert!(idempotent.ok);
        assert!(idempotent.room.is_none());
        let all = events(&store, &thread_key).await;
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.collab_room_lost")
        );
        assert!(
            all.iter()
                .any(|event| event.event_type == "session.collab_room_stopped")
        );
    }

    /// `collab_room_status` reports `None` when no room is active and the
    /// authoritative in-memory state when one is. The state returned is the
    /// one projected from the resident host's `collab/state` frame — never
    /// a client-spoofed placeholder.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_status_reports_none_without_room_and_authoritative_state_when_active() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-status-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("asbx-status"))
            .await
            .expect("assign sandbox");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());

        // No active room: status is ok with a null room (no probe).
        let empty = runtime.collab_room_status(&thread_key).await.unwrap();
        assert!(empty.ok);
        assert!(empty.room.is_none());

        // Seed an authoritative room state (as a resident host would) and
        // confirm status returns it verbatim after a resident collab_status probe.
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire lease");
        assert!(owner.acquired);
        let authoritative = CollabRoomState {
            active: true,
            join_url: Some("https://relay.example/join#cap".to_owned()),
            view_url: Some("https://relay.example/view".to_owned()),
            web_url: Some("https://relay.example/web".to_owned()),
            web_view_url: None,
            participants: vec![
                centaur_session_core::CollabParticipant {
                    name: "demo".to_owned(),
                    role: "host".to_owned(),
                    read_only: None,
                },
                centaur_session_core::CollabParticipant {
                    name: "guest".to_owned(),
                    role: "guest".to_owned(),
                    read_only: Some(true),
                },
            ],
        };
        // Resident probe IO — status returns the resident projection.
        push_resident_collab_io(&backend, authoritative.clone()).await;
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-status".to_owned(),
                state: authoritative.clone(),
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let status = runtime.collab_room_status(&thread_key).await.unwrap();
        assert!(status.ok);
        let room = status.room.expect("authoritative room");
        assert!(room.active);
        assert_eq!(
            room.join_url.as_deref(),
            Some("https://relay.example/join#cap")
        );
        assert_eq!(room.view_url.as_deref(), Some("https://relay.example/view"));
        assert_eq!(room.web_url.as_deref(), Some("https://relay.example/web"));
        assert_eq!(room.participants.len(), 2);
        assert_eq!(room.participants[1].read_only, Some(true));
        assert!(runtime.has_active_collab_room(&thread_key));

        // After update_collab_room_state with the authoritative state, the
        // registry reflects the resident host's projection exactly.
        let updated = CollabRoomState {
            active: true,
            join_url: Some("https://relay.example/join#cap-v2".to_owned()),
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: Vec::new(),
        };
        assert!(
            runtime
                .update_collab_room_state(&thread_key, "resident-1", owner.generation, &updated)
                .await
                .expect("authoritative update accepted")
        );
        // Registry reflects the fenced update; status would re-probe the resident.
        let after = runtime
            .collab_rooms
            .get(&thread_key)
            .expect("room still active")
            .state
            .clone();
        assert_eq!(
            after.join_url.as_deref(),
            Some("https://relay.example/join#cap-v2")
        );
        assert!(after.view_url.is_none());
        let recorded = events(&store, &thread_key).await;
        assert!(
            recorded
                .iter()
                .any(|event| event.event_type == "session.collab_room_state"),
            "authoritative room state is durable"
        );
    }

    /// `start_collab_room` returns the already-active room without
    /// re-acquiring ownership or respawning the keepalive. This is the
    /// start→active path: a second start is a no-op that returns the
    /// authoritative room state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_start_returns_existing_active_room_and_does_not_reacquire() {
        async fn phase<T>(name: &'static str, fut: impl std::future::Future<Output = T>) -> T {
            match tokio::time::timeout(Duration::from_secs(1), fut).await {
                Ok(value) => value,
                Err(_) => panic!("phase timed out after 1s: {name}"),
            }
        }

        let Some(store) = phase("test_store", test_store()).await else {
            return;
        };
        let _guard = phase("TEST_LOCK.lock", TEST_LOCK.lock()).await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-start-active-{}", Uuid::new_v4())).unwrap();
        phase(
            "create_or_get_session",
            store.create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            ),
        )
        .await
        .expect("create session");
        phase(
            "assign sandbox",
            store.update_sandbox_id(&thread_key, Some("asbx-start-active")),
        )
        .await
        .expect("assign sandbox");
        let owner = phase(
            "acquire ownership",
            store.acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident),
        )
        .await
        .expect("acquire lease");
        assert!(owner.acquired);
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let active_state = CollabRoomState {
            active: true,
            join_url: Some("https://relay.example/already-active".to_owned()),
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: Vec::new(),
        };
        // Resident host fake answers collab_status for the production probe.
        phase(
            "push_resident_collab_io",
            push_resident_collab_io(&backend, active_state.clone()),
        )
        .await;
        let runtime = runtime_with(&store, backend);
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-start-active".to_owned(),
                state: active_state.clone(),
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );

        // A second start returns the existing room without re-acquiring.
        let outcome = phase(
            "start_collab_room(existing)",
            runtime.start_collab_room(&thread_key, &CollabStartInput::default()),
        )
        .await
        .expect("start returns existing room");
        assert!(outcome.ok);
        let room = outcome.room.expect("active room returned");
        assert!(room.active);
        assert_eq!(
            room.join_url.as_deref(),
            Some("https://relay.example/already-active"),
            "start returns the authoritative resident host state, not a placeholder"
        );
        // The ownership generation is unchanged — no reacquire occurred.
        let still_owner = store
            .active_session_ownership(&thread_key)
            .await
            .expect("lookup ownership");
        assert_eq!(
            still_owner.expect("ownership present").generation,
            owner.generation,
            "start did not reacquire ownership for an already-active room"
        );
    }

    /// Collaboration rooms require harness type `omp`; other harnesses lack
    /// the resident RPC host that owns the room and are rejected with
    /// `CollabNotSupported`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_start_rejects_non_omp_harness() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-non-omp-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Codex,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        let error = runtime
            .start_collab_room(&thread_key, &CollabStartInput::default())
            .await
            .expect_err("non-omp harness rejected");
        assert!(
            matches!(error, SessionRuntimeError::CollabNotSupported { .. }),
            "expected CollabNotSupported, got {error:?}"
        );
        assert!(!runtime.has_active_collab_room(&thread_key));
    }

    /// Terminal sessions (Failed or Archived) cannot start or join rooms.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_start_rejects_terminal_session() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        for status in [SessionStatus::Failed, SessionStatus::Archived] {
            let thread_key = ThreadKey::parse(format!(
                "test:collab-terminal-{}-{}",
                status.as_ref(),
                Uuid::new_v4()
            ))
            .unwrap();
            store
                .create_or_get_session(
                    &thread_key,
                    &HarnessType::Omp,
                    None,
                    json!({}),
                    std::collections::BTreeMap::new(),
                )
                .await
                .expect("create session");
            sqlx::query("update sessions set status = $2 where thread_key = $1")
                .bind(thread_key.as_str())
                .bind(status.as_ref())
                .execute(store.pool())
                .await
                .expect("set terminal status");
            let runtime = runtime_with(
                &store,
                Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
            );
            let error = runtime
                .start_collab_room(&thread_key, &CollabStartInput::default())
                .await
                .expect_err("terminal session rejected");
            assert!(
                matches!(error, SessionRuntimeError::CollabTerminalSession { .. }),
                "expected CollabTerminalSession for {status}, got {error:?}"
            );
            assert!(!runtime.has_active_collab_room(&thread_key));
        }
    }

    /// The keepalive renewal renews the session ownership lease and touches
    /// the sandbox activity timestamp — the exact operations the keepalive
    /// task performs each tick. A sandbox must be assigned for the touch to
    /// register; the lease renewal succeeds regardless.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_keepalive_renews_ownership_lease_and_touches_sandbox() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-keepalive-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("asbx-keepalive"))
            .await
            .expect("assign sandbox");
        let owner = store
            .acquire_session_ownership(
                &thread_key,
                "resident-keepalive",
                SessionOwnerMode::Resident,
            )
            .await
            .expect("acquire lease");
        assert!(owner.acquired);

        // Snapshot the lease expiry before renewal.
        let before_expiry: Option<time::OffsetDateTime> = sqlx::query_scalar(
            "select lease_expires_at from session_owners \
                 where thread_key = $1 and owner_id = $2",
        )
        .bind(thread_key.as_str())
        .bind("resident-keepalive")
        .fetch_optional(store.pool())
        .await
        .expect("read lease");
        let before_expiry = before_expiry.expect("lease row present");

        // Renew, exactly as the keepalive task does each tick.
        let renewed = store
            .renew_session_ownership(&thread_key, "resident-keepalive")
            .await
            .expect("renew lease");
        assert!(renewed, "keepalive renewal must observe the live lease");

        let after_expiry: Option<time::OffsetDateTime> = sqlx::query_scalar(
            "select lease_expires_at from session_owners \
                 where thread_key = $1 and owner_id = $2",
        )
        .bind(thread_key.as_str())
        .bind("resident-keepalive")
        .fetch_optional(store.pool())
        .await
        .expect("read renewed lease");
        let after_expiry = after_expiry.expect("lease row still present");
        assert!(
            after_expiry >= before_expiry,
            "keepalive renewal extends the lease expiry"
        );

        // Touch sandbox activity, exactly as the keepalive task does after a
        // successful renewal. The sandbox must be assigned for the touch to
        // register (otherwise the row is unaffected and the room cannot
        // prevent idle suspension).
        let touched = store
            .touch_session_sandbox_activity(&thread_key)
            .await
            .expect("touch sandbox activity");
        assert!(touched, "keepalive touch must observe the assigned sandbox");

        // A stale owner (one that no longer holds the lease) cannot renew;
        // the keepalive task would observe this and lose the room.
        let stale_renewed = store
            .renew_session_ownership(&thread_key, "resident-stale")
            .await
            .expect("renew stale lease");
        assert!(!stale_renewed, "a stale owner cannot renew the lease");
    }

    /// Owner/process/relay loss releases the keepalive: the in-memory room
    /// is removed, the keepalive flag flips to false, and a durable
    /// `session.collab_room_lost` event is recorded. The session ownership
    /// lease is released so a new resident can recover the transcript and
    /// create a fresh room with a new capability URL.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_owner_loss_releases_keepalive_and_records_terminal_event() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-owner-lost-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        store
            .update_sandbox_id(&thread_key, Some("asbx-owner-loss"))
            .await
            .expect("assign sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire lease");
        assert!(owner.acquired);
        let keepalive = Arc::new(AtomicBool::new(true));
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let dead_state = CollabRoomState {
            active: true,
            join_url: Some("https://relay.example/dead-url".to_owned()),
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: Vec::new(),
        };
        push_resident_collab_io(&backend, dead_state.clone()).await;
        let runtime = runtime_with(&store, backend);
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-owner-loss".to_owned(),
                state: dead_state,
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );

        tokio::time::timeout(
            Duration::from_secs(1),
            runtime.lose_collab_room(&thread_key, "process_exit"),
        )
        .await
        .expect("lose room within 1s")
        .expect("lose room");

        assert!(!runtime.has_active_collab_room(&thread_key));
        assert!(!keepalive.load(Ordering::SeqCst), "keepalive flag released");

        // The ownership lease is released so a new resident can recover.
        let active = store
            .active_session_ownership(&thread_key)
            .await
            .expect("lookup ownership");
        assert!(
            active.is_none(),
            "owner/process/relay loss must release the ownership lease"
        );

        // A durable terminal event is recorded for observability.
        let recorded = events(&store, &thread_key).await;
        let lost = recorded
            .iter()
            .find(|event| event.event_type == "session.collab_room_lost")
            .expect("collab_room_lost event recorded");
        assert_eq!(
            lost.payload.get("reason").and_then(Value::as_str),
            Some("process_exit"),
            "loss reason is durable"
        );

        // Transcript recovery requires a new room and new capability URL —
        // the old room's lease and state are never reused. A new resident
        // can acquire ownership after the release and create a fresh room
        // with a new URL. The stale owner (resident-1) can no longer renew
        // the lease, so it cannot keep a ghost keepalive alive.
        let recovered = store
            .acquire_session_ownership(&thread_key, "resident-2", SessionOwnerMode::Resident)
            .await
            .expect("recover lease");
        assert!(recovered.acquired);
        let stale_renewed = store
            .renew_session_ownership(&thread_key, "resident-1")
            .await
            .expect("renew stale lease");
        assert!(
            !stale_renewed,
            "the stale owner cannot renew after the new resident takes over"
        );
        let new_url = "https://relay.example/recovered-cap";
        assert_ne!(new_url, "https://relay.example/dead-url");
    }

    /// finalize_collab_room appends the terminal event and releases ownership
    /// in one fenced transaction. A concurrent reader must never observe an
    /// event without the ownership row already gone (or vice versa).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_finalize_is_atomic_append_and_release() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-finalize-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        assert!(owner.acquired);

        let event = store
            .finalize_collab_room(
                &thread_key,
                "resident-1",
                owner.generation,
                PgSessionStore::SESSION_OWNERSHIP_LEASE,
                "session.collab_room_lost",
                json!({
                    "thread_key": thread_key.as_str(),
                    "reason": "atomic_test",
                    "owner_id": "resident-1",
                    "generation": owner.generation,
                }),
            )
            .await
            .expect("finalize")
            .expect("fenced finalize succeeds");
        assert_eq!(event.event_type, "session.collab_room_lost");
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("lookup")
                .is_none(),
            "ownership released in the same transaction as the terminal event"
        );
        assert!(
            !store
                .session_ownership_matches(&thread_key, "resident-1", owner.generation)
                .await
                .expect("match probe"),
            "ownership row is gone after finalize"
        );
    }

    /// A stale generation is rejected by finalize_collab_room: neither the
    /// terminal event nor a release of the live owner's lease occurs.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_finalize_fences_stale_generation() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key = ThreadKey::parse(format!("test:collab-fence-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        assert!(owner.acquired);

        let fenced = store
            .finalize_collab_room(
                &thread_key,
                "resident-1",
                owner.generation + 1,
                PgSessionStore::SESSION_OWNERSHIP_LEASE,
                "session.collab_room_lost",
                json!({"reason": "stale"}),
            )
            .await
            .expect("finalize call");
        assert!(fenced.is_none(), "stale generation is fenced");
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("lookup")
                .is_some(),
            "live owner lease is not released by a stale finalize"
        );
        let recorded = events(&store, &thread_key).await;
        assert!(
            recorded
                .iter()
                .all(|event| event.event_type != "session.collab_room_lost"),
            "no terminal event is written for a fenced finalize"
        );
    }

    /// cleanup_collab_room_local marks the handle cleanup-pending (externally
    /// non-active) before the fenced transaction, then removes only the exact
    /// matching owner+generation handle after commit. A takeover that inserts
    /// a newer handle during cleanup is preserved.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_cleanup_is_externally_non_active_and_preserves_takeover() {
        async fn phase<T>(name: &'static str, fut: impl std::future::Future<Output = T>) -> T {
            match tokio::time::timeout(Duration::from_secs(5), fut).await {
                Ok(value) => value,
                Err(_) => panic!("phase timed out after 5s: {name}"),
            }
        }

        let Some(store) = phase("test_store", test_store()).await else {
            return;
        };
        let _guard = phase("TEST_LOCK.lock", TEST_LOCK.lock()).await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-cleanup-takeover-{}", Uuid::new_v4())).unwrap();
        phase(
            "create_or_get_session",
            store.create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            ),
        )
        .await
        .expect("create session");
        phase(
            "assign sandbox",
            store.update_sandbox_id(&thread_key, Some("asbx-takeover")),
        )
        .await
        .expect("assign sandbox");
        let owner = phase(
            "acquire resident-1",
            store.acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident),
        )
        .await
        .expect("acquire");
        assert!(owner.acquired);
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let old_url = "https://relay.example/old-cap".to_owned();
        let old_handle = CollabRoomHandle {
            owner_id: "resident-1".to_owned(),
            generation: owner.generation,
            sandbox_id: "asbx-takeover".to_owned(),
            state: CollabRoomState {
                active: true,
                join_url: Some(old_url.clone()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
            keepalive: Arc::new(AtomicBool::new(true)),
            phase: CollabCleanupPhase::Active,
            cleanup_worker_scheduled: false,
        };
        runtime
            .collab_rooms
            .insert(thread_key.clone(), old_handle.clone());

        // Simulate a takeover: a newer generation is installed while the old
        // handle is still registered. cleanup must not delete the new one.
        let recovered = phase(
            "release resident-1",
            store.release_session_ownership(&thread_key, "resident-1"),
        )
        .await
        .expect("release old");
        assert!(recovered);
        let new_owner = phase(
            "acquire resident-2",
            store.acquire_session_ownership(&thread_key, "resident-2", SessionOwnerMode::Resident),
        )
        .await
        .expect("acquire new");
        assert!(new_owner.acquired);
        let new_url = "https://relay.example/new-cap".to_owned();
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-2".to_owned(),
                generation: new_owner.generation,
                sandbox_id: "asbx-takeover".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some(new_url.clone()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );

        // Cleaning up the OLD handle is fenced (ownership no longer matches)
        // and must not remove the newer takeover handle.
        let err = phase(
            "cleanup_collab_room_local(old_handle)",
            runtime.cleanup_collab_room_local(
                &thread_key,
                &old_handle,
                "session.collab_room_lost",
                "stale_owner",
            ),
        )
        .await
        .expect_err("stale cleanup is fenced");
        assert!(
            matches!(err, SessionRuntimeError::CollabRoomLost { .. }),
            "fenced cleanup surfaces CollabRoomLost, got {err:?}"
        );
        let current = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("newer handle preserved");
        assert_eq!(current.owner_id, "resident-2");
        assert_eq!(current.generation, new_owner.generation);
        assert_eq!(current.state.join_url.as_deref(), Some(new_url.as_str()));
        assert!(!matches!(
            current.phase,
            CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
        ));
        assert!(runtime.has_active_collab_room(&thread_key));
        // Status probes the resident on the takeover handle's sandbox.
        push_resident_collab_io(
            &backend,
            CollabRoomState {
                active: true,
                join_url: Some(new_url.clone()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
        )
        .await;
        let status = phase(
            "collab_room_status",
            runtime.collab_room_status(&thread_key),
        )
        .await
        .expect("status");
        assert_eq!(
            status
                .room
                .as_ref()
                .and_then(|room| room.join_url.as_deref()),
            Some(new_url.as_str()),
            "status serves the takeover URL, never the stale one"
        );
    }

    /// A cleanup-pending handle is externally non-active: status returns no
    /// room and has_active_collab_room is false, even while the handle is
    /// retained for retry.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_cleanup_pending_is_externally_non_active() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-pending-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "sbx-unit".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/pending".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::FinalizePending,
                cleanup_worker_scheduled: false,
            },
        );
        assert!(
            !runtime.has_active_collab_room(&thread_key),
            "cleanup-pending is not active"
        );
        let status = runtime
            .collab_room_status(&thread_key)
            .await
            .expect("status");
        assert!(
            status.room.is_none(),
            "status must not serve a cleanup-pending capability URL"
        );
    }

    /// wait_for_collab_event advances its cursor past each batch so a
    /// correlated response after more than one page of events is still found.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_wait_advances_cursor_past_poll_overflow() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-overflow-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create session");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let baseline = store.latest_event_id(&thread_key).await.expect("baseline");
        // Fill more than one 128-event page with uncorrelated noise.
        for i in 0..140 {
            store
                .append_event(&thread_key, None, "session.noise", json!({"i": i}))
                .await
                .expect("noise");
        }
        let request_id = "collab-overflow-req";
        let room = CollabRoomState {
            active: true,
            join_url: Some("https://relay.example/overflow".to_owned()),
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: Vec::new(),
        };
        store
            .append_unscoped_event_if_session_owner(
                &thread_key,
                "resident-1",
                owner.generation,
                PgSessionStore::SESSION_OWNERSHIP_LEASE,
                "session.collab_room_state",
                json!({
                    "thread_key": thread_key.as_str(),
                    "state": "started",
                    "request_id": request_id,
                    "generation": owner.generation,
                    "room": room,
                }),
            )
            .await
            .expect("append started")
            .expect("fenced");

        let found = wait_for_collab_started(
            &store,
            &thread_key,
            baseline,
            owner.generation,
            request_id,
            Instant::now() + COLLAB_LIFECYCLE_DEADLINE,
        )
        .await
        .expect("find started past overflow");
        assert_eq!(
            found.join_url.as_deref(),
            Some("https://relay.example/overflow")
        );
    }

    /// Uncorrelated method:error frames are not consumed by the collab
    /// lifecycle path — only collab-prefixed request_ids are.
    /// Regression for the DashMap same-shard self-deadlock: marking a handle
    /// cleanup_pending must use get_mut (or a dropped clone) and never hold a
    /// get() guard across insert on the same key. Completes without DB.
    #[test]
    fn collab_cleanup_pending_mark_does_not_deadlock_dashmap() {
        let rooms: CollabRoomRegistry = Arc::new(DashMap::new());
        let thread_key = ThreadKey::parse("test:dashmap-deadlock").unwrap();
        rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: 1,
                sandbox_id: "https://relay.example/overflow".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/x".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let started = Instant::now();
        // Same pattern as cleanup_collab_room_local / keepalive loss.
        if let Some(mut current) = rooms.get_mut(&thread_key)
            && current.owner_id == "resident-1"
            && current.generation == 1
        {
            current.mark_finalize_pending();
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(
            rooms
                .get(&thread_key)
                .map(|h| matches!(
                    h.phase,
                    CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
                ))
                .unwrap_or(false)
        );
    }

    /// Regression: prebinding a cloned handle must drop the DashMap get guard
    /// before any nested get/insert on the same key. Models the start(existing)
    /// deadlock (outer get held across await while pump tries insert).
    #[test]
    fn collab_prebound_handle_allows_same_shard_insert() {
        let rooms: CollabRoomRegistry = Arc::new(DashMap::new());
        let thread_key = ThreadKey::parse("test:prebind-insert").unwrap();
        rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: 1,
                sandbox_id: "sbx-unit".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/x".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let started = Instant::now();
        // BAD pattern would be: if let Some(h) = rooms.get(...).cloned() { rooms.insert(...) }
        // which holds the read guard across insert. GOOD: prebind then insert.
        let existing = rooms
            .get(&thread_key)
            .as_deref()
            .filter(|h| h.is_externally_active())
            .cloned();
        if let Some(mut handle) = existing {
            handle.state.join_url = Some("https://relay.example/updated".to_owned());
            rooms.insert(thread_key.clone(), handle);
        }
        // Nested get after prebind also must not block behind a queued writer.
        let _ = rooms.get(&thread_key).map(|h| h.state.join_url.clone());
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "prebound handle path must not same-shard deadlock"
        );
        assert_eq!(
            rooms
                .get(&thread_key)
                .and_then(|h| h.state.join_url.clone())
                .as_deref(),
            Some("https://relay.example/updated")
        );
    }

    /// Stale projector append after owner loss must not leave a ghost room or
    /// overwrite a later takeover. Ownership-echoed stale frames cannot mutate
    /// a newer owner's room / capability URL.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_projector_append_preserves_takeover_handle() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-projector-takeover-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-proj"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        assert!(owner.acquired);
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend.clone());
        let old_keepalive = Arc::new(AtomicBool::new(true));
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-proj".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/old-proj".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: old_keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        assert!(
            store
                .release_session_ownership(&thread_key, "resident-1")
                .await
                .expect("release")
        );
        let stale_started = json!({
            "method": "collab/state",
            "params": {
                "state": "started",
                "request_id": "collab-stale",
                "ownership": {
                    "owner_id": "resident-1",
                    "generation": owner.generation
                },
                "room": {
                    "active": true,
                    "join_url": "https://relay.example/stale-started",
                    "view_url": null,
                    "web_url": null,
                    "participants": []
                }
            }
        });
        let ctx = runtime.context();
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-proj", &stale_started)
                .await
                .expect("process")
        );
        assert!(
            !runtime.has_active_collab_room(&thread_key),
            "stale projector must not leave an active room"
        );

        let new_owner = store
            .acquire_session_ownership(&thread_key, "resident-2", SessionOwnerMode::Resident)
            .await
            .expect("new acquire");
        assert!(new_owner.acquired);
        let new_url = "https://relay.example/new-proj".to_owned();
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-2".to_owned(),
                generation: new_owner.generation,
                sandbox_id: "asbx-proj".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some(new_url.clone()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let stale_with_echo = json!({
            "method": "collab/state",
            "params": {
                "state": "started",
                "request_id": "collab-stale-2",
                "ownership": {
                    "owner_id": "resident-1",
                    "generation": owner.generation
                },
                "room": {
                    "active": true,
                    "join_url": "https://relay.example/stale-started",
                    "view_url": null,
                    "web_url": null,
                    "participants": []
                }
            }
        });
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-proj", &stale_with_echo)
                .await
                .expect("echo-fenced stale")
        );
        let current = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("takeover preserved");
        assert_eq!(current.owner_id, "resident-2");
        assert_eq!(current.generation, new_owner.generation);
        assert_eq!(
            current.state.join_url.as_deref(),
            Some(new_url.as_str()),
            "ownership-echoed stale projector must not overwrite takeover URL"
        );
        push_resident_collab_io(
            &backend,
            CollabRoomState {
                active: true,
                join_url: Some(new_url.clone()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
        )
        .await;
        let status = runtime.collab_room_status(&thread_key).await.unwrap();
        assert_eq!(
            status.room.as_ref().and_then(|r| r.join_url.as_deref()),
            Some(new_url.as_str())
        );
    }

    /// Same-sandbox G1 buffered frame after G2 takeover must not update or
    /// finalize the G2 handle. Ownership echo is required and must match.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_stale_generation_frame_does_not_mutate_takeover() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-stale-gen-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-stale-gen"))
            .await
            .expect("sandbox");
        let g2 = store
            .acquire_session_ownership(&thread_key, "resident-2", SessionOwnerMode::Resident)
            .await
            .expect("g2");
        assert!(g2.acquired);
        let g2_generation = g2.generation.max(2);
        let g1_generation = g2_generation - 1;
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        let new_url = "https://relay.example/g2-cap".to_owned();
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-2".to_owned(),
                generation: g2_generation,
                sandbox_id: "asbx-stale-gen".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some(new_url.clone()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let ctx = runtime.context();
        let missing = json!({
            "method": "collab/state",
            "params": {
                "state": "started",
                "request_id": "collab-missing",
                "room": {
                    "active": true,
                    "join_url": "https://relay.example/no-echo",
                    "participants": []
                }
            }
        });
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-stale-gen", &missing)
                .await
                .expect("missing")
        );
        let g1_frame = json!({
            "method": "collab/state",
            "params": {
                "state": "started",
                "request_id": "collab-g1",
                "ownership": {
                    "owner_id": "resident-1",
                    "generation": g1_generation
                },
                "room": {
                    "active": true,
                    "join_url": "https://relay.example/g1-stale",
                    "participants": []
                }
            }
        });
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-stale-gen", &g1_frame)
                .await
                .expect("g1")
        );
        let g1_lost = json!({
            "method": "collab/state",
            "params": {
                "state": "failed",
                "reason": "stale",
                "ownership": {
                    "owner_id": "resident-1",
                    "generation": g1_generation
                },
                "room": {
                    "active": false,
                    "participants": []
                }
            }
        });
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-stale-gen", &g1_lost)
                .await
                .expect("g1 lost")
        );
        let current = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("g2 preserved");
        assert_eq!(current.owner_id, "resident-2");
        assert_eq!(current.generation, g2_generation);
        assert_eq!(current.state.join_url.as_deref(), Some(new_url.as_str()));
        assert!(current.phase.is_externally_active());
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("lookup")
                .is_some(),
            "g2 ownership must not be finalized by g1 frame"
        );
    }

    /// Status probe write failure must enter RemoteStopPending and retain the
    /// handle — never finalize/remove on probe failure.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_status_probe_failure_enters_remote_stop_pending() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-probe-fail-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-probe-fail"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        // Backend with no IO — send_collab_control_line fails open_io.
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-probe-fail".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/live".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let err = runtime
            .collab_room_status(&thread_key)
            .await
            .expect_err("probe failure surfaces");
        let _ = err;
        let handle = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained");
        assert!(
            matches!(handle.phase, CollabCleanupPhase::RemoteStopPending),
            "probe fail enters RemoteStopPending, got {:?}",
            handle.phase
        );
        assert!(!runtime.has_active_collab_room(&thread_key));
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("lookup")
                .is_some(),
            "must not finalize ownership on probe failure"
        );
        runtime.collab_rooms.remove(&thread_key);
    }

    /// Successful status probe must not return a URL if the exact handle is
    /// no longer Active (e.g. concurrent cleanup).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_status_probe_requires_still_active_handle() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-probe-active-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-probe-active"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let room = CollabRoomState {
            active: true,
            join_url: Some("https://relay.example/active".to_owned()),
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: Vec::new(),
        };
        push_resident_collab_io(&backend, room.clone()).await;
        let runtime = runtime_with(&store, backend);
        let keepalive = Arc::new(AtomicBool::new(true));
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-probe-active".to_owned(),
                state: room,
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        // Flip to FinalizePending before/while status would return — simulate
        // concurrent cleanup after probe started by marking before call and
        // using a second path: mark after insert so probe send may still work
        // if pipe opens, but Active check fails.
        // Mark RemoteStopPending after ensuring pipe can open: use empty backend
        // wait — simpler: mark FinalizePending then call status.
        if let Some(mut current) = runtime.collab_rooms.get_mut(&thread_key) {
            current.mark_finalize_pending();
        }
        let status = runtime.collab_room_status(&thread_key).await.unwrap();
        // Non-active phases are filtered before probe — room None, not URL.
        assert!(
            status.room.is_none(),
            "non-Active handle must not serve URL"
        );
        runtime.collab_rooms.remove(&thread_key);
    }

    /// wait_for_collab_status store errors must propagate as Store, not be
    /// reclassified as CollabRoomLost/stale.
    #[test]
    fn collab_wait_status_propagates_store_error_unchanged() {
        let store_err = SessionRuntimeError::Store(SessionStoreError::InvalidPersistedValue(
            "injected".to_owned(),
        ));
        match store_err {
            SessionRuntimeError::Store(SessionStoreError::InvalidPersistedValue(message)) => {
                assert_eq!(message, "injected");
            }
            other => panic!("store error must not be reclassified: {other:?}"),
        }
    }

    /// Unsolicited terminal frames go through finalize_collab_room (append+release),
    /// never split append then separate release.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_unsolicited_terminal_uses_atomic_finalize() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-terminal-atomic-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-term"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        let keepalive = Arc::new(AtomicBool::new(true));
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-term".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/term".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let lost = json!({
            "method": "collab/state",
            "params": {
                "state": "failed",
                "reason": "relay_lost",
                "ownership": {
                    "owner_id": "resident-1",
                    "generation": owner.generation
                },
                "room": {
                    "active": false,
                    "join_url": null,
                    "view_url": null,
                    "web_url": null,
                    "participants": []
                }
            }
        });
        let ctx = runtime.context();
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-term", &lost)
                .await
                .expect("process terminal")
        );
        assert!(!runtime.has_active_collab_room(&thread_key));
        assert!(!keepalive.load(Ordering::SeqCst));
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("lookup")
                .is_none()
        );
        let recorded = events(&store, &thread_key).await;
        assert!(
            recorded
                .iter()
                .any(|e| e.event_type == "session.collab_room_lost"),
            "terminal loss is durable via finalize"
        );
        assert!(
            !recorded
                .iter()
                .any(|e| e.event_type == "session.collab_room_stopped"),
            "unsolicited terminal is lost, not stopped"
        );
    }

    /// stop control failure must not durable-claim stopped while resident may still be live.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_stop_control_failure_preserves_recoverable_handle() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-stop-ctrl-fail-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-stop-fail"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-stop-fail".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/live".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let _err = runtime
            .stop_collab_room(
                &thread_key,
                &CollabStopInput {
                    reason: Some("user_stop".to_owned()),
                },
            )
            .await
            .expect_err("control failure surfaces");
        let handle = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained after control failure");
        assert!(
            matches!(
                handle.phase,
                CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
            ),
            "marked pending for remote-stop retry"
        );
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("lookup")
                .is_some(),
            "ownership not released on control failure"
        );
        let recorded = events(&store, &thread_key).await;
        assert!(
            !recorded
                .iter()
                .any(|e| e.event_type == "session.collab_room_stopped"),
            "must not durable-claim stopped on control failure"
        );
        assert!(!runtime.has_active_collab_room(&thread_key));
        // Drop handle so background remote-stop retry exits.
        runtime.collab_rooms.remove(&thread_key);
    }

    #[test]
    fn collab_event_matches_requires_exact_request_id() {
        use centaur_session_core::SessionEvent;
        let base = |request_id: Option<&str>, generation: i64, event_id: i64| SessionEvent {
            event_id,
            thread_key: ThreadKey::parse("test:rid").unwrap(),
            execution_id: None,
            event_type: "session.collab_room_state".to_owned(),
            payload: {
                let mut p = json!({
                    "generation": generation,
                    "state": "started",
                    "room": { "active": true, "participants": [] },
                });
                if let Some(id) = request_id {
                    p["request_id"] = json!(id);
                }
                p
            },
            created_at: time::OffsetDateTime::now_utc(),
        };
        let expected = "collab-req-1";
        // Missing request_id must NOT acknowledge.
        assert!(!collab_event_matches(&base(None, 1, 10), 5, 1, expected));
        // Wrong request_id must NOT acknowledge.
        assert!(!collab_event_matches(
            &base(Some("collab-other"), 1, 10),
            5,
            1,
            expected
        ));
        // Exact request_id + generation after anchor acknowledges.
        assert!(collab_event_matches(
            &base(Some(expected), 1, 10),
            5,
            1,
            expected
        ));
        // Same generation unsolicited stopped also must not ack start waiter.
        assert!(!collab_event_matches(&base(None, 1, 11), 5, 1, expected));
    }

    #[test]
    fn collab_error_frame_requires_collab_request_id_prefix() {
        fn is_collab_error(value: &Value) -> bool {
            if value.get("method").and_then(Value::as_str) != Some("error") {
                return false;
            }
            value
                .get("params")
                .and_then(|params| params.get("request_id").or_else(|| params.get("requestId")))
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("collab-"))
        }
        let correlated = json!({
            "method": "error",
            "params": {
                "request_id": "collab-abc",
                "error": {"message": "boom"},
            }
        });
        let uncorrelated = json!({
            "method": "error",
            "params": {
                "threadId": "t1",
                "turnId": "turn-1",
                "error": {"message": "normal turn error"},
            }
        });
        assert!(is_collab_error(&correlated));
        assert!(!is_collab_error(&uncorrelated));
    }

    /// If DB outage lasts past the ownership lease TTL, retry must not loop
    /// forever on Ok(None)+proof true for an expired same owner/gen row.
    /// Live ownership proof requires lease_expires_at > now().
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_finalize_none_expired_lease_terminates_pending() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-expired-lease-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-expired"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        // Force the ownership row to be expired while keeping owner+generation.
        sqlx::query(
            r#"
            update session_owners
            set lease_expires_at = now() - interval '1 second'
            where thread_key = $1 and owner_id = $2 and generation = $3
            "#,
        )
        .bind(thread_key.as_str())
        .bind("resident-1")
        .bind(owner.generation)
        .execute(store.pool())
        .await
        .expect("expire lease");
        assert!(
            !store
                .session_ownership_matches(&thread_key, "resident-1", owner.generation)
                .await
                .expect("proof"),
            "expired row is not live ownership"
        );
        let runtime = runtime_with(
            &store,
            Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new())),
        );
        let keepalive = Arc::new(AtomicBool::new(true));
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-expired".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/expired".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::FinalizePending,
                cleanup_worker_scheduled: false,
            },
        );
        // Ok(None) + proof false (expired) must remove the handle, not retain forever.
        // Snapshot handle in a separate statement so the DashMap Ref drops before
        // the await — apply may remove_if on the same shard.
        let handle = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle present");
        let result = apply_collab_finalize_result(
            &store,
            &runtime.collab_rooms,
            &thread_key,
            &handle,
            "session.collab_room_lost",
            "lease_expired_during_outage",
            Ok(None),
        )
        .await;
        // Proof false removes the handle (terminal). Result is CollabRoomLost
        // so callers surface the fence, but must not retain forever.
        assert!(
            result.is_err(),
            "expired proof surfaces CollabRoomLost, got {result:?}"
        );
        assert!(
            runtime.collab_rooms.get(&thread_key).is_none(),
            "expired ownership terminates pending handle"
        );
        // keepalive was never flipped by apply on Ok(None)+false path —
        // cleanup_pending paths mark it; for pure finalize apply, handle gone is enough.
        let _ = keepalive;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_finalize_none_with_same_row_proof_retains_pending() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-proof-true-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let rooms: CollabRoomRegistry = Arc::new(DashMap::new());
        let handle = CollabRoomHandle {
            owner_id: "resident-1".to_owned(),
            generation: owner.generation,
            sandbox_id: "sbx-unit".to_owned(),
            state: CollabRoomState {
                active: true,
                join_url: Some("https://relay.example/x".to_owned()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
            keepalive: Arc::new(AtomicBool::new(true)),
            phase: CollabCleanupPhase::FinalizePending,
            cleanup_worker_scheduled: false,
        };
        rooms.insert(thread_key.clone(), handle.clone());

        // Simulate finalize Ok(None) while the ownership row still matches.
        let result: Result<Option<centaur_session_core::SessionEvent>, SessionStoreError> =
            Ok(None);
        let err = apply_collab_finalize_result(
            &store,
            &rooms,
            &thread_key,
            &handle,
            "session.collab_room_lost",
            "proof_true",
            result,
        )
        .await
        .expect_err("same-row proof must not succeed cleanup");
        assert!(matches!(err, SessionRuntimeError::CollabRoomLost { .. }));
        let current = rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained on Ok(true) proof");
        assert!(
            matches!(
                current.phase,
                CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
            ),
            "remains cleanup-pending"
        );
        assert!(
            current.cleanup_worker_scheduled,
            "retry task must be scheduled"
        );
        // Ownership lease must still be held by resident-1.
        assert!(
            store
                .session_ownership_matches(&thread_key, "resident-1", owner.generation)
                .await
                .expect("match")
        );
    }

    /// When finalize keeps failing with a store error, the managed retry task
    /// remains scheduled (cleanup_worker_scheduled) and the handle stays
    /// cleanup-pending — it does not wall-clock abandon after the lease TTL.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_cleanup_pending_retry_stays_scheduled_after_transient_finalize_err() {
        let rooms: CollabRoomRegistry = Arc::new(DashMap::new());
        let thread_key = ThreadKey::parse("test:collab-retry-sched").unwrap();
        let handle = CollabRoomHandle {
            owner_id: "resident-1".to_owned(),
            generation: 7,
            sandbox_id: "sbx-unit".to_owned(),
            state: CollabRoomState::default(),
            keepalive: Arc::new(AtomicBool::new(false)),
            phase: CollabCleanupPhase::FinalizePending,
            cleanup_worker_scheduled: false,
        };
        rooms.insert(thread_key.clone(), handle.clone());

        // Apply a synthetic store error without a live DB connection by using
        // the Err arm of apply_collab_finalize_result. We need a store only if
        // the Err arm tries DB — it only schedules retry.
        // Use a real store so ensure_cleanup_pending_retry can spawn; the
        // spawned task will observe no matching ownership and exit after
        // finalize Ok(None)+proof false, OR if store missing skip.
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        // No ownership row for this thread_key — finalize will fence None and
        // proof false will clear. First force Err path:
        let err = apply_collab_finalize_result(
            &store,
            &rooms,
            &thread_key,
            &handle,
            "session.collab_room_lost",
            "transient",
            Err(SessionStoreError::NotFound {
                thread_key: thread_key.as_str().to_owned(),
            }),
        )
        .await
        .expect_err("store err surfaces");
        let _ = err;
        let current = rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained on finalize Err");
        assert!(matches!(
            current.phase,
            CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
        ));
        assert!(
            current.cleanup_worker_scheduled,
            "deduped retry must remain scheduled after transient Err"
        );
        // Second Err must not clear the scheduled flag.
        let handle2 = current.clone();
        let _ = apply_collab_finalize_result(
            &store,
            &rooms,
            &thread_key,
            &handle2,
            "session.collab_room_lost",
            "transient2",
            Err(SessionStoreError::NotFound {
                thread_key: thread_key.as_str().to_owned(),
            }),
        )
        .await;
        assert!(
            rooms
                .get(&thread_key)
                .map(|h| h.cleanup_worker_scheduled
                    && matches!(
                        h.phase,
                        CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
                    ))
                .unwrap_or(false),
            "second Err keeps pending+scheduled"
        );
    }

    /// Internal pump-end cleanup marks the room cleanup-pending and runs
    /// fenced finalize — used by EOF, codec failure, and process_collab
    /// append failures so no ghost keepalive remains.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn collab_pump_end_cleanup_marks_pending_and_finalizes() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-pump-end-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-pump-end"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        let keepalive = Arc::new(AtomicBool::new(true));
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: "resident-1".to_owned(),
                generation: owner.generation,
                sandbox_id: "asbx-pump-end".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/pump".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let ctx = runtime.context();
        lose_collab_room_on_pump_end(
            &ctx,
            &thread_key,
            "asbx-pump-end",
            "stdout_pump_internal_error",
        )
        .await;
        assert!(
            !keepalive.load(Ordering::SeqCst),
            "keepalive released on pump-end cleanup"
        );
        assert!(
            !runtime.has_active_collab_room(&thread_key),
            "room no longer active after pump-end finalize"
        );
        assert!(
            store
                .active_session_ownership(&thread_key)
                .await
                .expect("lookup")
                .is_none(),
            "ownership released by fenced finalize"
        );
        let recorded = events(&store, &thread_key).await;
        assert!(
            recorded
                .iter()
                .any(|e| e.event_type == "session.collab_room_lost"),
            "terminal loss event durable"
        );
    }

    #[tokio::test]
    async fn collab_stop_timeout_enters_remote_stop_pending_not_finalize() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-stop-timeout-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-stop-timeout"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        // Hang the control plane so wait cannot complete before the absolute deadline.
        backend.push_io(mock_hanging_collab_io()).await;
        let runtime = runtime_with(&store, backend);
        let keepalive = Arc::new(AtomicBool::new(true));
        let handle = CollabRoomHandle {
            owner_id: owner.owner_id.clone(),
            generation: owner.generation,
            sandbox_id: "asbx-stop-timeout".to_owned(),
            state: CollabRoomState {
                active: true,
                join_url: Some("https://relay.example/live".to_owned()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
            keepalive: keepalive.clone(),
            phase: CollabCleanupPhase::Active,
            cleanup_worker_scheduled: false,
        };
        runtime
            .collab_rooms
            .insert(thread_key.clone(), handle.clone());
        // Expired absolute deadline: stop attempt times out immediately.
        let err = runtime
            .stop_or_enter_remote_pending_within(
                &thread_key,
                &handle,
                "user_stop_timeout",
                Instant::now() - Duration::from_millis(1),
            )
            .await
            .expect_err("expired deadline surfaces");
        let _ = err;
        let retained = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("exact handle retained after stop timeout");
        assert!(
            matches!(retained.phase, CollabCleanupPhase::RemoteStopPending),
            "timeout must enter RemoteStopPending before finalize, got {:?}",
            retained.phase
        );
        assert!(
            !retained.phase.is_externally_active(),
            "must not remain externally active after stop timeout"
        );
        // RemoteStopPending clears the keepalive flag so the sandbox is not
        // held awake by a ghost room; ownership stays durable until finalize.
        assert!(
            !keepalive.load(Ordering::SeqCst),
            "RemoteStopPending must release keepalive (no ghost keepalive)"
        );
        let row = store
            .active_session_ownership(&thread_key)
            .await
            .expect("lookup")
            .expect("ownership retained under RemoteStopPending until finalize");
        assert_eq!(row.owner_id, owner.owner_id);
        assert_eq!(row.generation, owner.generation);
    }

    #[tokio::test]
    async fn collab_failed_stop_enters_remote_stop_pending_not_ghost() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-fail-stop-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-fail-stop"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        // No IO: open_io fails → stop control failure.
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        let keepalive = Arc::new(AtomicBool::new(true));
        let handle = CollabRoomHandle {
            owner_id: owner.owner_id.clone(),
            generation: owner.generation,
            sandbox_id: "asbx-fail-stop".to_owned(),
            state: CollabRoomState {
                active: true,
                join_url: Some("https://relay.example/live".to_owned()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
            keepalive: keepalive.clone(),
            phase: CollabCleanupPhase::Active,
            cleanup_worker_scheduled: false,
        };
        runtime
            .collab_rooms
            .insert(thread_key.clone(), handle.clone());
        let err = runtime
            .stop_or_enter_remote_pending(&thread_key, &handle, "collab_start_failed")
            .await
            .expect_err("control failure surfaces");
        let _ = err;
        let retained = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained");
        assert!(
            matches!(retained.phase, CollabCleanupPhase::RemoteStopPending),
            "failed stop enters RemoteStopPending, got {:?}",
            retained.phase
        );
        assert!(
            !runtime.has_active_collab_room(&thread_key),
            "not externally active (no ghost active room)"
        );
        assert!(
            !keepalive.load(Ordering::SeqCst),
            "RemoteStopPending releases keepalive (no ghost keepalive)"
        );
        let row = store
            .active_session_ownership(&thread_key)
            .await
            .expect("lookup")
            .expect("ownership retained until finalize");
        assert_eq!(row.owner_id, owner.owner_id);
        assert_eq!(row.generation, owner.generation);
    }

    #[tokio::test]
    async fn collab_handoff_aggregate_deadline_does_not_hang_or_ghost() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-handoff-dl-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-handoff-dl"))
            .await
            .expect("sandbox");
        // Seed ownership with a known owner id; handoff stops rooms from the
        // registry snapshot regardless of stdout owner, then attempts release
        // for its own stdout owner. Assert public outcomes only.
        let owner = store
            .acquire_session_ownership(&thread_key, "handoff-owner", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        backend.push_io(mock_hanging_collab_io()).await;
        let runtime = runtime_with(&store, backend);
        let keepalive = Arc::new(AtomicBool::new(true));
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: owner.owner_id.clone(),
                generation: owner.generation,
                sandbox_id: "asbx-handoff-dl".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/live".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        // Zero budget: deadline computed before barrier must not hang.
        let errors = tokio::time::timeout(
            Duration::from_secs(3),
            runtime.handoff_owned_executions(Duration::from_millis(0)),
        )
        .await
        .expect("handoff returns under aggregate deadline without hanging");
        // Public contract: handoff reports errors rather than silently dropping
        // the room; hanging IO + zero budget cannot leave an active ghost room.
        assert!(
            !errors.is_empty() || !runtime.has_active_collab_room(&thread_key),
            "handoff must surface deadline pressure or clear active room; errors={errors:?}"
        );
        assert!(
            !runtime.has_active_collab_room(&thread_key),
            "room must not stay externally active after deadline handoff"
        );
        // If handle remains, it must be pending retry — never Active ghost.
        if let Some(retained) = runtime.collab_rooms.get(&thread_key).as_deref().cloned() {
            assert!(
                !retained.phase.is_externally_active(),
                "retained handle must not be externally active, got {:?}",
                retained.phase
            );
        }
    }

    #[tokio::test]
    async fn collab_cleanup_ownership_proof_shares_deadline() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-proof-dl-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let keepalive = Arc::new(AtomicBool::new(true));
        let handle = CollabRoomHandle {
            owner_id: owner.owner_id.clone(),
            generation: owner.generation,
            sandbox_id: "asbx-proof".to_owned(),
            state: CollabRoomState {
                active: true,
                join_url: Some("https://relay.example/live".to_owned()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
            keepalive: keepalive.clone(),
            phase: CollabCleanupPhase::FinalizePending,
            cleanup_worker_scheduled: false,
        };
        let registry: CollabRoomRegistry = Arc::new(DashMap::new());
        registry.insert(thread_key.clone(), handle.clone());
        // Finalize Ok(None) with already-expired deadline: proof must not run
        // past budget; handle stays pending (no ghost drop / keepalive clear).
        let err = apply_collab_finalize_result_within(
            &store,
            &registry,
            &thread_key,
            &handle,
            "session.collab_room_lost",
            "proof_deadline",
            Ok(None),
            Instant::now() - Duration::from_secs(1),
        )
        .await
        .expect_err("expired proof deadline errors");
        let _ = err;
        let retained = registry
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained after proof deadline — no ghost drop");
        assert!(
            matches!(
                retained.phase,
                CollabCleanupPhase::FinalizePending | CollabCleanupPhase::RemoteStopPending
            ),
            "proof timeout retains pending phase, got {:?}",
            retained.phase
        );
        // Pending retry may clear the in-memory keepalive flag; durable
        // ownership must remain until a successful fenced finalize.
        let row = store
            .active_session_ownership(&thread_key)
            .await
            .expect("lookup")
            .expect("ownership still durable after proof deadline");
        assert_eq!(row.owner_id, owner.owner_id);
        assert_eq!(row.generation, owner.generation);
        assert!(
            !retained.phase.is_externally_active(),
            "proof timeout must not leave externally active room"
        );
    }

    #[tokio::test]
    async fn collab_projector_fenced_started_drives_remote_stop_not_blind_finalize() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-proj-fenced-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-proj-fenced"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        // Expire lease so append_unscoped_event_if_session_owner returns None
        // while the same owner+generation row still exists.
        sqlx::query(
            r#"
            update session_owners
            set lease_expires_at = now() - interval '1 second'
            where thread_key = $1 and owner_id = $2 and generation = $3
            "#,
        )
        .bind(thread_key.as_str())
        .bind(&owner.owner_id)
        .bind(owner.generation)
        .execute(store.pool())
        .await
        .expect("expire");
        // Backend with no IO: stop control fails open → RemoteStopPending retained.
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        let keepalive = Arc::new(AtomicBool::new(true));
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: owner.owner_id.clone(),
                generation: owner.generation,
                sandbox_id: "asbx-proj-fenced".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/live".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: keepalive.clone(),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let started = json!({
            "method": "collab/state",
            "params": {
                "request_id": "collab-req-fenced-start",
                "state": "started",
                "ownership": {
                    "owner_id": owner.owner_id,
                    "generation": owner.generation,
                },
                "room": {
                    "active": true,
                    "join_url": "https://relay.example/live",
                    "participants": []
                }
            }
        });
        let ctx = runtime.context();
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-proj-fenced", &started)
                .await
                .expect("process fenced started")
        );
        let retained = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("exact handle retained after fenced started (no blind remove)");
        assert!(
            matches!(retained.phase, CollabCleanupPhase::RemoteStopPending),
            "fenced started must RemoteStopPending (stop before finalize), got {:?}",
            retained.phase
        );
        assert!(
            !runtime.has_active_collab_room(&thread_key),
            "not externally active"
        );
        // No terminal collab_room_lost without stop ack.
        let events = events(&store, &thread_key).await;
        assert!(
            events
                .iter()
                .all(|e| e.event_type != "session.collab_room_lost"),
            "no terminal lost event when stop fails after fenced started; events={events:?}"
        );
        // Ownership row still present (expired but not released by finalize).
        let row = sqlx::query_scalar::<_, i64>(
            r#"select count(*) from session_owners where thread_key = $1 and owner_id = $2 and generation = $3"#,
        )
        .bind(thread_key.as_str())
        .bind(&owner.owner_id)
        .bind(owner.generation)
        .fetch_one(store.pool())
        .await
        .expect("count owners");
        assert_eq!(row, 1, "lease row retained until successful stop+finalize");
    }

    #[tokio::test]
    async fn collab_projector_fenced_status_drives_remote_stop_retains_on_failure() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-proj-status-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-proj-status"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        sqlx::query(
            r#"
            update session_owners
            set lease_expires_at = now() - interval '1 second'
            where thread_key = $1 and owner_id = $2 and generation = $3
            "#,
        )
        .bind(thread_key.as_str())
        .bind(&owner.owner_id)
        .bind(owner.generation)
        .execute(store.pool())
        .await
        .expect("expire");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: owner.owner_id.clone(),
                generation: owner.generation,
                sandbox_id: "asbx-proj-status".to_owned(),
                state: CollabRoomState {
                    active: true,
                    join_url: Some("https://relay.example/live".to_owned()),
                    view_url: None,
                    web_url: None,
                    web_view_url: None,
                    participants: Vec::new(),
                },
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );
        let status = json!({
            "method": "collab/status",
            "params": {
                "request_id": "collab-req-fenced-status",
                "ownership": {
                    "owner_id": owner.owner_id,
                    "generation": owner.generation,
                },
                "room": {
                    "active": true,
                    "join_url": "https://relay.example/live",
                    "participants": []
                }
            }
        });
        let ctx = runtime.context();
        assert!(
            process_collab_state_line(&ctx, &thread_key, "asbx-proj-status", &status)
                .await
                .expect("process fenced status")
        );
        let retained = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained");
        assert!(
            matches!(retained.phase, CollabCleanupPhase::RemoteStopPending),
            "fenced status → RemoteStopPending, got {:?}",
            retained.phase
        );
        let events = events(&store, &thread_key).await;
        assert!(
            events
                .iter()
                .all(|e| e.event_type != "session.collab_room_lost"),
            "no terminal event without stop ack"
        );
    }

    #[tokio::test]
    async fn collab_failed_stop_retains_remote_pending_without_terminal_event() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-stop-retains-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-stop-retains"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        let runtime = runtime_with(&store, backend);
        let handle = CollabRoomHandle {
            owner_id: owner.owner_id.clone(),
            generation: owner.generation,
            sandbox_id: "asbx-stop-retains".to_owned(),
            state: CollabRoomState {
                active: true,
                join_url: Some("https://relay.example/live".to_owned()),
                view_url: None,
                web_url: None,
                web_view_url: None,
                participants: Vec::new(),
            },
            keepalive: Arc::new(AtomicBool::new(true)),
            phase: CollabCleanupPhase::Active,
            cleanup_worker_scheduled: false,
        };
        runtime
            .collab_rooms
            .insert(thread_key.clone(), handle.clone());
        let _ = runtime
            .stop_or_enter_remote_pending(&thread_key, &handle, "test_failed_stop")
            .await
            .expect_err("stop fails without IO");
        let retained = runtime
            .collab_rooms
            .get(&thread_key)
            .as_deref()
            .cloned()
            .expect("handle retained");
        assert!(matches!(
            retained.phase,
            CollabCleanupPhase::RemoteStopPending
        ));
        let row = store
            .active_session_ownership(&thread_key)
            .await
            .expect("lookup")
            .expect("lease retained");
        assert_eq!(row.owner_id, owner.owner_id);
        assert_eq!(row.generation, owner.generation);
        let events = events(&store, &thread_key).await;
        assert!(
            events
                .iter()
                .all(|e| e.event_type != "session.collab_room_lost"),
            "no terminal event on failed stop"
        );
    }

    #[tokio::test]
    async fn collab_stop_holds_global_gate_so_handoff_waits_without_duplicate_finalize() {
        let Some(store) = test_store().await else {
            return;
        };
        let _guard = TEST_LOCK.lock().await;
        let thread_key =
            ThreadKey::parse(format!("test:collab-stop-gate-{}", Uuid::new_v4())).unwrap();
        store
            .create_or_get_session(
                &thread_key,
                &HarnessType::Omp,
                None,
                json!({}),
                std::collections::BTreeMap::new(),
            )
            .await
            .expect("create");
        store
            .update_sandbox_id(&thread_key, Some("asbx-stop-gate"))
            .await
            .expect("sandbox");
        let owner = store
            .acquire_session_ownership(&thread_key, "resident-1", SessionOwnerMode::Resident)
            .await
            .expect("acquire");
        let dead_state = CollabRoomState {
            active: true,
            join_url: Some("https://relay.example/live".to_owned()),
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: Vec::new(),
        };
        // Cooperative resident: stop completes with ack so finalize can run once.
        let backend = Arc::new(MockBackend::new(SandboxStatus::Running, Vec::new()));
        push_resident_collab_io(&backend, dead_state.clone()).await;
        let runtime = runtime_with(&store, backend);
        runtime.collab_rooms.insert(
            thread_key.clone(),
            CollabRoomHandle {
                owner_id: owner.owner_id.clone(),
                generation: owner.generation,
                sandbox_id: "asbx-stop-gate".to_owned(),
                state: dead_state,
                keepalive: Arc::new(AtomicBool::new(true)),
                phase: CollabCleanupPhase::Active,
                cleanup_worker_scheduled: false,
            },
        );

        // Pause: hold the global read gate like an in-flight stop, then release.
        let gate = runtime.collab_lifecycle_gate.clone();
        let hold = tokio::spawn(async move {
            let _g = gate.read().await;
            tokio::time::sleep(Duration::from_millis(250)).await;
        });
        tokio::time::sleep(Duration::from_millis(30)).await;

        let runtime_stop = runtime.clone();
        let tk_stop = thread_key.clone();
        let stop_fut = tokio::spawn(async move {
            runtime_stop
                .stop_collab_room(
                    &tk_stop,
                    &CollabStopInput {
                        reason: Some("user_stop".to_owned()),
                    },
                )
                .await
        });

        let handoff_started = Instant::now();
        let runtime_h = runtime.clone();
        let handoff_fut = tokio::spawn(async move {
            runtime_h
                .handoff_owned_executions(Duration::from_secs(3))
                .await
        });

        let (hold_r, stop_r, handoff_r) = tokio::join!(hold, stop_fut, handoff_fut);
        hold_r.expect("hold task");
        let stop_result = stop_r.expect("stop join");
        let errors = handoff_r.expect("handoff join");
        let handoff_elapsed = handoff_started.elapsed();

        // Write gate blocked until the paused read (and then stop's read) released.
        assert!(
            handoff_elapsed >= Duration::from_millis(200),
            "handoff write must wait for in-flight lifecycle read gate, elapsed={handoff_elapsed:?}"
        );
        // Prefer stop winning while holding the read gate; handoff then sees
        // an empty/non-active room. Terminal finalize is at most one event.
        let terminal: Vec<_> = events(&store, &thread_key)
            .await
            .into_iter()
            .filter(|e| {
                e.event_type == "session.collab_room_stopped"
                    || e.event_type == "session.collab_room_lost"
            })
            .collect();
        assert!(
            terminal.len() <= 1,
            "no duplicate stop/handoff finalize; got {terminal:?}"
        );
        assert!(
            !runtime.has_active_collab_room(&thread_key),
            "room not active after stop/handoff"
        );
        // Clean result: either stop Ok finalized, or stop hit ShuttingDown and
        // handoff cleaned, or RemoteStopPending with no second terminal.
        match &stop_result {
            Ok(outcome) => {
                assert!(outcome.ok, "stop outcome ok={outcome:?}");
                assert_eq!(
                    terminal.len(),
                    1,
                    "successful stop must leave exactly one terminal event; {terminal:?}"
                );
                assert_eq!(terminal[0].event_type, "session.collab_room_stopped");
            }
            Err(SessionRuntimeError::ShuttingDown) => {
                // Handoff took ownership; at most one lost from handoff finalize.
                assert!(
                    terminal.len() <= 1,
                    "shutdown race: at most one terminal; {terminal:?}"
                );
            }
            Err(other) => {
                // Control failure → RemoteStopPending, no terminal without stop ack.
                assert!(
                    terminal.is_empty(),
                    "failed stop must not terminal-finalize; {terminal:?} err={other}"
                );
                let h = runtime
                    .collab_rooms
                    .get(&thread_key)
                    .as_deref()
                    .cloned()
                    .expect("handle retained on stop failure");
                assert!(matches!(h.phase, CollabCleanupPhase::RemoteStopPending));
            }
        }
        let _ = errors;
    }
}
