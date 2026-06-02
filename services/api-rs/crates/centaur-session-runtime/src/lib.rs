use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
    },
    time::Duration,
};

use centaur_sandbox_core::{
    Mount, SandboxBackend, SandboxError, SandboxId, SandboxIoGuard, SandboxRead, SandboxSpec,
    SandboxStatus, SandboxWrite,
};
use centaur_sandbox_manager::SandboxManager;
use centaur_session_core::{
    HarnessType, Session, SessionEvent, SessionExecution, SessionMessageInput, ThreadKey,
};
use centaur_session_sqlx::{
    PgSessionStore, SessionEventListener, SessionStoreError, default_metadata,
};
use futures_util::{SinkExt, Stream, StreamExt, stream};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    io,
    sync::{Mutex, broadcast, oneshot},
    time::{Instant, Interval, MissedTickBehavior, interval_at, timeout},
};
use tokio_util::codec::{FramedRead, FramedWrite, LinesCodec, LinesCodecError};
use tracing::warn;

pub const SESSION_OUTPUT_LINE_EVENT: &str = "session.output.line";

const MAX_SESSION_OUTPUT_LINE_BYTES: usize = 1024 * 1024;
const EVENT_STREAM_SAFETY_POLL_INTERVAL: Duration = Duration::from_secs(30);

type SandboxSpecFactory = Arc<dyn Fn(&ThreadKey, &str) -> SandboxSpec + Send + Sync>;
type SessionInputSink = FramedWrite<SandboxWrite, LinesCodec>;

const CODEX_WORKSPACE_DIR: &str = "/home/agent/workspace";
const CODEX_APP_SERVER_RPC_TIMEOUT: Duration = Duration::from_secs(60);
const CODEX_APP_SERVER_INIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExistingSandboxReuse {
    Reused,
    Resumed,
    Missing,
}

#[derive(Clone)]
pub struct SessionRuntime {
    store: PgSessionStore,
    sandbox_runtime: SandboxRuntime,
    sandbox_pipes: Arc<Mutex<HashMap<String, SessionPipe>>>,
}

#[derive(Clone)]
pub struct SandboxRuntime {
    manager: Arc<SandboxManager>,
    spec_factory: SandboxSpecFactory,
    protocol: SandboxProtocol,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SandboxProtocol {
    Line,
    CodexAppServer,
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
    },
}

#[derive(Debug)]
pub struct ExecuteSessionInput {
    pub metadata: Option<Value>,
    pub input_lines: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
}

#[derive(Clone)]
enum SessionPipe {
    Line(LineSessionPipe),
    CodexAppServer(CodexAppServerPipe),
}

#[derive(Clone)]
struct LineSessionPipe {
    stdin: Arc<Mutex<SessionInputSink>>,
}

#[derive(Clone)]
struct CodexAppServerPipe {
    stdin: Arc<Mutex<SessionInputSink>>,
    next_request_id: Arc<AtomicI64>,
    responses: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    notifications: broadcast::Sender<CodexNotification>,
    state: Arc<Mutex<CodexAppServerState>>,
    execute_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug)]
struct CodexNotification {
    terminal: Option<CodexTerminal>,
}

#[derive(Clone, Debug)]
enum CodexTerminal {
    Completed,
    Failed(String),
}

#[derive(Debug, Default)]
struct CodexAppServerState {
    initialized: bool,
    thread_id: Option<String>,
    active_turn_id: Option<String>,
}

struct EventStreamState {
    store: PgSessionStore,
    thread_key: ThreadKey,
    after_event_id: i64,
    pending: VecDeque<SessionEvent>,
    listener: SessionEventListener,
    safety_tick: Interval,
    done: bool,
}

impl SessionRuntime {
    pub fn new(store: PgSessionStore, sandbox_runtime: SandboxRuntime) -> Self {
        Self {
            store,
            sandbox_runtime,
            sandbox_pipes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn create_or_get_session(
        &self,
        thread_key: &ThreadKey,
        harness_type: &HarnessType,
        metadata: Option<Value>,
    ) -> Result<Session, SessionRuntimeError> {
        Ok(self
            .store
            .create_or_get_session(thread_key, harness_type, default_metadata(metadata))
            .await?)
    }

    pub async fn append_messages(
        &self,
        thread_key: &ThreadKey,
        messages: &[SessionMessageInput],
    ) -> Result<Vec<String>, SessionRuntimeError> {
        if messages.is_empty() {
            return Err(SessionRuntimeError::BadRequest(
                "messages must not be empty".to_owned(),
            ));
        }
        Ok(self.store.append_messages(thread_key, messages).await?)
    }

    pub async fn execute_session(
        &self,
        thread_key: &ThreadKey,
        input: ExecuteSessionInput,
    ) -> Result<SessionExecution, SessionRuntimeError> {
        let session = self.store.get_session(thread_key).await?;
        validate_input_lines(&input.input_lines)?;
        validate_duration_options(&input)?;

        let execution = self
            .store
            .create_execution(thread_key, default_metadata(input.metadata.clone()))
            .await?;
        let execution = self
            .store
            .mark_execution_running(&execution.execution_id)
            .await?;
        let sandbox_id = self
            .ensure_session_sandbox(
                thread_key,
                session.sandbox_id.as_deref(),
                &execution.execution_id,
            )
            .await?;

        self.store
            .append_event(
                thread_key,
                Some(&execution.execution_id),
                "session.execution_started",
                json!({
                    "execution_id": execution.execution_id,
                    "thread_key": thread_key.as_str(),
                    "input_line_count": input.input_lines.len(),
                }),
            )
            .await?;

        let execution_result = match self.ensure_session_pipe(thread_key, &sandbox_id).await {
            Ok(SessionPipe::Line(pipe)) => {
                write_line_protocol_turn(&pipe, &input.input_lines).await
            }
            Ok(SessionPipe::CodexAppServer(pipe)) => {
                self.execute_codex_app_server_turn(
                    thread_key,
                    session.harness_thread_id.as_deref(),
                    &pipe,
                    &input,
                )
                .await
            }
            Err(error) => Err(error),
        };

        match execution_result {
            Ok(()) => {}
            Err(error) => {
                let error_message = error.to_string();
                let _ = self
                    .store
                    .append_event(
                        thread_key,
                        Some(&execution.execution_id),
                        "session.execution_failed",
                        json!({
                            "execution_id": execution.execution_id,
                            "thread_key": thread_key.as_str(),
                            "error": error_message,
                        }),
                    )
                    .await;
                let _ = self
                    .store
                    .fail_execution(&execution.execution_id, &error_message)
                    .await;
                return Err(error);
            }
        }

        self.store
            .append_event(
                thread_key,
                Some(&execution.execution_id),
                "session.execution_completed",
                json!({
                    "execution_id": execution.execution_id,
                    "thread_key": thread_key.as_str(),
                    "completion_reason": "terminal_output",
                }),
            )
            .await?;

        Ok(self
            .store
            .complete_execution(&execution.execution_id)
            .await?)
    }

    pub async fn stream_events(
        &self,
        thread_key: &ThreadKey,
        after_event_id: i64,
    ) -> Result<
        impl Stream<Item = Result<SessionEvent, SessionRuntimeError>> + use<>,
        SessionRuntimeError,
    > {
        let session = self.store.get_session(thread_key).await?;
        if let Some(sandbox_id) = session.sandbox_id.as_deref() {
            self.ensure_session_pipe(thread_key, sandbox_id).await?;
        }

        let listener = self.store.listen_session_events().await?;

        Ok(session_event_stream(
            self.store.clone(),
            thread_key.clone(),
            after_event_id,
            listener,
        ))
    }

    async fn ensure_session_sandbox(
        &self,
        thread_key: &ThreadKey,
        existing_sandbox_id: Option<&str>,
        execution_id: &str,
    ) -> Result<String, SessionRuntimeError> {
        if let Some(sandbox_id) = existing_sandbox_id {
            match try_reuse_existing_sandbox(&self.sandbox_runtime.manager, sandbox_id).await? {
                ExistingSandboxReuse::Reused => {
                    return Ok(sandbox_id.to_owned());
                }
                ExistingSandboxReuse::Resumed => {
                    self.sandbox_pipes.lock().await.remove(sandbox_id);
                    return Ok(sandbox_id.to_owned());
                }
                ExistingSandboxReuse::Missing => {}
            }
        }

        let spec = (self.sandbox_runtime.spec_factory)(thread_key, execution_id);
        let handle = self.sandbox_runtime.manager.create_running(spec).await?;
        self.store
            .update_sandbox_id(thread_key, Some(handle.id.as_str()))
            .await?;
        Ok(handle.id.into_string())
    }

    async fn ensure_session_pipe(
        &self,
        thread_key: &ThreadKey,
        sandbox_id: &str,
    ) -> Result<SessionPipe, SessionRuntimeError> {
        if let Some(pipe) = self.sandbox_pipes.lock().await.get(sandbox_id).cloned() {
            return Ok(pipe);
        }

        let io = self
            .sandbox_runtime
            .manager
            .open_io(&SandboxId::new(sandbox_id))
            .await?
            .into_parts();
        let stdin = Arc::new(Mutex::new(FramedWrite::new(
            io.stdin,
            LinesCodec::new_with_max_length(MAX_SESSION_OUTPUT_LINE_BYTES),
        )));

        let store = self.store.clone();
        let thread_key = thread_key.clone();
        let pump_key = sandbox_id.to_owned();
        let sandbox_pipes = self.sandbox_pipes.clone();
        let stdout = io.stdout;
        let stderr = io.stderr;
        let guard = io.guard;
        let stderr_key = pump_key.clone();
        let pipe = match self.sandbox_runtime.protocol {
            SandboxProtocol::Line => {
                let pipe = SessionPipe::Line(LineSessionPipe { stdin });
                self.sandbox_pipes
                    .lock()
                    .await
                    .insert(sandbox_id.to_owned(), pipe.clone());

                tokio::spawn(async move {
                    let result = run_line_stdout_pump(
                        store.clone(),
                        thread_key.clone(),
                        &pump_key,
                        stdout,
                        guard,
                    )
                    .await;
                    if let Err(error) = result {
                        warn!(%pump_key, %error, "session stdout pump failed");
                        let _ = store
                            .append_event(
                                &thread_key,
                                None,
                                "session.stdout_pump_failed",
                                json!({
                                    "sandbox_id": pump_key.as_str(),
                                    "error": error.to_string(),
                                }),
                            )
                            .await;
                    }
                    sandbox_pipes.lock().await.remove(&pump_key);
                });
                pipe
            }
            SandboxProtocol::CodexAppServer => {
                let (notifications, _) = broadcast::channel(256);
                let pipe = SessionPipe::CodexAppServer(CodexAppServerPipe {
                    stdin,
                    next_request_id: Arc::new(AtomicI64::new(1)),
                    responses: Arc::new(Mutex::new(HashMap::new())),
                    notifications,
                    state: Arc::new(Mutex::new(CodexAppServerState::default())),
                    execute_lock: Arc::new(Mutex::new(())),
                });
                self.sandbox_pipes
                    .lock()
                    .await
                    .insert(sandbox_id.to_owned(), pipe.clone());

                let SessionPipe::CodexAppServer(codex_pipe) = pipe.clone() else {
                    unreachable!("constructed codex pipe")
                };
                let pump_store = store.clone();
                let pump_thread_key = thread_key.clone();
                let pump_key = pump_key.clone();
                let pump_responses = codex_pipe.responses.clone();
                let pump_notifications = codex_pipe.notifications.clone();
                let pump_state = codex_pipe.state.clone();
                tokio::spawn(async move {
                    let result = run_codex_app_server_stdout_pump(
                        pump_store.clone(),
                        pump_thread_key.clone(),
                        &pump_key,
                        stdout,
                        guard,
                        pump_responses,
                        pump_notifications,
                        pump_state,
                    )
                    .await;
                    if let Err(error) = result {
                        warn!(%pump_key, %error, "codex app-server stdout pump failed");
                        let _ = pump_store
                            .append_event(
                                &pump_thread_key,
                                None,
                                "session.stdout_pump_failed",
                                json!({
                                    "sandbox_id": pump_key.as_str(),
                                    "error": error.to_string(),
                                }),
                            )
                            .await;
                    }
                    sandbox_pipes.lock().await.remove(&pump_key);
                });
                initialize_codex_app_server(&codex_pipe).await?;
                append_output_line(
                    &self.store,
                    &thread_key,
                    None,
                    &json!({"type": "system", "subtype": "app_server", "phase": "initialized"})
                        .to_string(),
                )
                .await?;
                pipe
            }
        };

        tokio::spawn(async move {
            if let Err(error) = drain_stderr(stderr).await {
                warn!(%stderr_key, %error, "session stderr drain failed");
            }
        });

        Ok(pipe)
    }

    async fn execute_codex_app_server_turn(
        &self,
        thread_key: &ThreadKey,
        resume_thread_id: Option<&str>,
        pipe: &CodexAppServerPipe,
        input: &ExecuteSessionInput,
    ) -> Result<(), SessionRuntimeError> {
        let _execute_guard = pipe.execute_lock.lock().await;
        let thread_id = ensure_codex_thread(pipe, resume_thread_id).await?;
        self.store
            .update_harness_thread_id(thread_key, Some(thread_id.as_str()))
            .await?;
        if resume_thread_id != Some(thread_id.as_str()) {
            append_output_line(
                &self.store,
                thread_key,
                None,
                &json!({"type": "thread.started", "thread_id": thread_id}).to_string(),
            )
            .await?;
        }

        for line in &input.input_lines {
            execute_codex_input_line(&self.store, thread_key, pipe, line, input.max_duration_ms)
                .await?;
        }
        Ok(())
    }
}

async fn try_reuse_existing_sandbox(
    manager: &SandboxManager,
    sandbox_id: &str,
) -> Result<ExistingSandboxReuse, SessionRuntimeError> {
    let id = SandboxId::new(sandbox_id);
    match manager.status(&id).await {
        Ok(SandboxStatus::Running) => Ok(ExistingSandboxReuse::Reused),
        Ok(SandboxStatus::Created | SandboxStatus::Suspended) => {
            manager.resume(&id).await?;
            Ok(ExistingSandboxReuse::Resumed)
        }
        Ok(SandboxStatus::Stopped | SandboxStatus::Gone | SandboxStatus::Unknown(_))
        | Err(SandboxError::NotFound(_)) => Ok(ExistingSandboxReuse::Missing),
        Err(error) => Err(SessionRuntimeError::Sandbox(error)),
    }
}

impl SandboxRuntime {
    pub fn backend(backend: Arc<dyn SandboxBackend>, spec: SandboxSpec) -> Self {
        let spec_factory = move |_thread_key: &ThreadKey, _execution_id: &str| spec.clone();
        Self::backend_with_spec_factory_and_protocol(backend, spec_factory, SandboxProtocol::Line)
    }

    pub fn backend_with_workload(
        backend: Arc<dyn SandboxBackend>,
        workload: SandboxWorkloadMode,
    ) -> Self {
        let protocol = workload.protocol();
        Self::backend_with_spec_factory(backend, move |thread_key, _execution_id| {
            workload.spec(thread_key)
        })
        .with_protocol(protocol)
    }

    pub fn backend_with_spec_factory<F>(backend: Arc<dyn SandboxBackend>, spec_factory: F) -> Self
    where
        F: Fn(&ThreadKey, &str) -> SandboxSpec + Send + Sync + 'static,
    {
        Self::backend_with_spec_factory_and_protocol(backend, spec_factory, SandboxProtocol::Line)
    }

    fn backend_with_spec_factory_and_protocol<F>(
        backend: Arc<dyn SandboxBackend>,
        spec_factory: F,
        protocol: SandboxProtocol,
    ) -> Self
    where
        F: Fn(&ThreadKey, &str) -> SandboxSpec + Send + Sync + 'static,
    {
        Self {
            manager: Arc::new(SandboxManager::new(backend)),
            spec_factory: Arc::new(spec_factory),
            protocol,
        }
    }

    fn with_protocol(mut self, protocol: SandboxProtocol) -> Self {
        self.protocol = protocol;
        self
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
    ) -> Self {
        Self::CodexAppServer {
            image: image.into(),
            env: env.into_iter().collect(),
            mounts: Vec::new(),
        }
    }

    pub fn mount(mut self, mount: Mount) -> Self {
        match &mut self {
            Self::MockAppServer { .. } => {}
            Self::CodexAppServer { mounts, .. } => mounts.push(mount),
        }
        self
    }

    fn spec(&self, _thread_key: &ThreadKey) -> SandboxSpec {
        match self {
            Self::MockAppServer { image } => SandboxSpec::new(image)
                .command(["/bin/sh", "-lc"])
                .args([mock_app_server_script()]),
            Self::CodexAppServer { image, env, mounts } => {
                let mut spec =
                    SandboxSpec::new(image).args(["codex", "app-server", "--listen", "stdio://"]);
                for mount in mounts {
                    spec = spec.mount(mount.clone());
                }
                for (name, value) in env {
                    spec = spec.env(name.clone(), value.clone());
                }
                spec
            }
        }
    }

    fn protocol(&self) -> SandboxProtocol {
        match self {
            Self::MockAppServer { .. } => SandboxProtocol::Line,
            Self::CodexAppServer { .. } => SandboxProtocol::CodexAppServer,
        }
    }
}

fn mock_app_server_script() -> &'static str {
    r#"while IFS= read -r line; do
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
  printf '{"type":"item.agentMessage.delta","turnId":"%s","session_id":"mock-codex-thread","delta":"PONG %s"}\n' "$turn_id" "$turn_index"
  sleep 0.2
  printf '{"type":"turn.completed","turn":{"id":"%s"},"usage":{"input_tokens":0,"output_tokens":1}}\n' "$turn_id"
  sleep 0.2
  turn_index=$((turn_index + 1))
done
done"#
}

async fn initialize_codex_app_server(pipe: &CodexAppServerPipe) -> Result<(), SessionRuntimeError> {
    {
        let state = pipe.state.lock().await;
        if state.initialized {
            return Ok(());
        }
    }
    codex_request(
        pipe,
        "initialize",
        json!({
            "clientInfo": {"name": "centaur", "title": "Centaur", "version": "0.1.0"},
            "capabilities": {"experimentalApi": true},
        }),
        CODEX_APP_SERVER_INIT_TIMEOUT,
    )
    .await?;
    codex_notify(pipe, "initialized", json!({})).await?;
    pipe.state.lock().await.initialized = true;
    Ok(())
}

async fn ensure_codex_thread(
    pipe: &CodexAppServerPipe,
    resume_thread_id: Option<&str>,
) -> Result<String, SessionRuntimeError> {
    if let Some(thread_id) = pipe.state.lock().await.thread_id.clone() {
        return Ok(thread_id);
    }

    let resume_thread_id = resume_thread_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let result = if let Some(thread_id) = resume_thread_id {
        codex_request(
            pipe,
            "thread/resume",
            json!({"threadId": thread_id, "cwd": CODEX_WORKSPACE_DIR}),
            CODEX_APP_SERVER_RPC_TIMEOUT,
        )
        .await?
    } else {
        codex_request(
            pipe,
            "thread/start",
            json!({"cwd": CODEX_WORKSPACE_DIR}),
            CODEX_APP_SERVER_RPC_TIMEOUT,
        )
        .await?
    };
    let thread_id = result
        .get("thread")
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .or(resume_thread_id)
        .ok_or_else(|| {
            SessionRuntimeError::CodexAppServer(
                "thread/start response did not include a thread id".to_owned(),
            )
        })?
        .to_owned();
    pipe.state.lock().await.thread_id = Some(thread_id.clone());
    let _ = pipe
        .notifications
        .send(CodexNotification { terminal: None });
    Ok(thread_id)
}

async fn execute_codex_input_line(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    pipe: &CodexAppServerPipe,
    line: &str,
    max_duration_ms: Option<u64>,
) -> Result<(), SessionRuntimeError> {
    initialize_codex_app_server(pipe).await?;
    let input = codex_input_from_line(line)?;
    let thread_id =
        pipe.state.lock().await.thread_id.clone().ok_or_else(|| {
            SessionRuntimeError::CodexAppServer("missing Codex thread id".to_owned())
        })?;

    match input {
        CodexInput::Interrupt => interrupt_codex_turn(pipe).await,
        CodexInput::User { items } => {
            let (goal, items) = split_goal(items);
            if let Some(goal) = goal {
                let mut terminal_events = pipe.notifications.subscribe();
                codex_request(
                    pipe,
                    "thread/goal/set",
                    json!({"threadId": thread_id, "objective": goal}),
                    CODEX_APP_SERVER_RPC_TIMEOUT,
                )
                .await?;
                let state = pipe.state.lock().await;
                let session_id = state.thread_id.clone();
                drop(state);
                if let Some(session_id) = session_id {
                    let _ = pipe
                        .notifications
                        .send(CodexNotification { terminal: None });
                    emit_codex_synthetic_line(
                        store,
                        thread_key,
                        pipe,
                        json!({
                            "type": "assistant",
                            "session_id": session_id,
                            "message": {"content": [{"type": "text", "text": "Goal set."}]},
                        }),
                    )
                    .await?;
                }
                return wait_for_codex_terminal(&mut terminal_events, max_duration_ms).await;
            }

            let mut terminal_events = pipe.notifications.subscribe();
            let result = codex_request(
                pipe,
                "turn/start",
                json!({"threadId": thread_id, "input": items}),
                CODEX_APP_SERVER_RPC_TIMEOUT,
            )
            .await?;
            let turn_id = result
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .or_else(|| result.get("turnId").and_then(Value::as_str))
                .map(ToOwned::to_owned);
            if let Some(turn_id) = turn_id {
                pipe.state.lock().await.active_turn_id = Some(turn_id);
            }
            wait_for_codex_terminal(&mut terminal_events, max_duration_ms).await
        }
    }
}

async fn interrupt_codex_turn(pipe: &CodexAppServerPipe) -> Result<(), SessionRuntimeError> {
    let state = pipe.state.lock().await;
    let Some(thread_id) = state.thread_id.clone() else {
        return Ok(());
    };
    let Some(turn_id) = state.active_turn_id.clone() else {
        return Ok(());
    };
    drop(state);
    codex_request(
        pipe,
        "turn/interrupt",
        json!({"threadId": thread_id, "turnId": turn_id}),
        Duration::from_secs(5),
    )
    .await?;
    Ok(())
}

async fn wait_for_codex_terminal(
    terminal_events: &mut broadcast::Receiver<CodexNotification>,
    max_duration_ms: Option<u64>,
) -> Result<(), SessionRuntimeError> {
    let wait = async {
        loop {
            match terminal_events.recv().await {
                Ok(CodexNotification {
                    terminal: Some(CodexTerminal::Completed),
                }) => return Ok(()),
                Ok(CodexNotification {
                    terminal: Some(CodexTerminal::Failed(error)),
                }) => return Err(SessionRuntimeError::CodexAppServer(error)),
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => {
                    return Err(SessionRuntimeError::CodexAppServer(
                        "codex app-server notification stream closed".to_owned(),
                    ));
                }
            }
        }
    };

    if let Some(max_duration_ms) = max_duration_ms {
        timeout(Duration::from_millis(max_duration_ms), wait)
            .await
            .map_err(|_| {
                SessionRuntimeError::CodexAppServer(format!(
                    "codex turn did not complete within {max_duration_ms}ms"
                ))
            })?
    } else {
        wait.await
    }
}

async fn codex_request(
    pipe: &CodexAppServerPipe,
    method: &str,
    params: Value,
    request_timeout: Duration,
) -> Result<Value, SessionRuntimeError> {
    let id = pipe.next_request_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    pipe.responses.lock().await.insert(id, tx);
    let send_result = send_codex_json(
        pipe,
        json!({
            "id": id,
            "method": method,
            "params": params,
        }),
    )
    .await;
    if let Err(error) = send_result {
        pipe.responses.lock().await.remove(&id);
        return Err(error);
    }
    let response = timeout(request_timeout, rx)
        .await
        .map_err(|_| {
            SessionRuntimeError::CodexAppServer(format!(
                "codex app-server request {method} timed out"
            ))
        })?
        .map_err(|_| {
            SessionRuntimeError::CodexAppServer(format!(
                "codex app-server request {method} response channel closed"
            ))
        })?;
    if let Some(error) = response.get("error") {
        return Err(SessionRuntimeError::CodexAppServer(format!(
            "codex app-server request {method} failed: {}",
            error_message(error)
        )));
    }
    Ok(response.get("result").cloned().unwrap_or_else(|| json!({})))
}

async fn codex_notify(
    pipe: &CodexAppServerPipe,
    method: &str,
    params: Value,
) -> Result<(), SessionRuntimeError> {
    send_codex_json(
        pipe,
        json!({
            "method": method,
            "params": params,
        }),
    )
    .await
}

async fn send_codex_json(
    pipe: &CodexAppServerPipe,
    payload: Value,
) -> Result<(), SessionRuntimeError> {
    let line = serde_json::to_string(&payload)
        .map_err(|error| SessionRuntimeError::CodexAppServer(error.to_string()))?;
    pipe.stdin
        .lock()
        .await
        .send(line)
        .await
        .map_err(codec_error_to_runtime)
}

async fn emit_codex_synthetic_line(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    pipe: &CodexAppServerPipe,
    payload: Value,
) -> Result<(), SessionRuntimeError> {
    let terminal = match payload.get("type").and_then(Value::as_str) {
        Some("turn.completed") => Some(CodexTerminal::Completed),
        Some("turn.failed") => Some(CodexTerminal::Failed(error_message(&payload))),
        _ => None,
    };
    if terminal.is_some() {
        let _ = pipe.notifications.send(CodexNotification { terminal });
    }
    append_output_line(store, thread_key, None, &payload.to_string()).await?;
    Ok(())
}

fn session_event_stream(
    store: PgSessionStore,
    thread_key: ThreadKey,
    after_event_id: i64,
    listener: SessionEventListener,
) -> impl Stream<Item = Result<SessionEvent, SessionRuntimeError>> {
    stream::unfold(
        EventStreamState {
            store,
            thread_key,
            after_event_id,
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
        },
        |mut state| async move {
            loop {
                if let Some(event) = state.pending.pop_front() {
                    state.after_event_id = event.event_id;
                    return Some((Ok(event), state));
                }
                if state.done {
                    return None;
                }
                match state
                    .store
                    .list_events_after(&state.thread_key, state.after_event_id, 100)
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
                    },
                    Ok(events) => state.pending = events.into(),
                    Err(error) => {
                        state.done = true;
                        return Some((Err(SessionRuntimeError::Store(error)), state));
                    }
                }
            }
        },
    )
}

async fn run_line_stdout_pump(
    store: PgSessionStore,
    thread_key: ThreadKey,
    sandbox_id: &str,
    stdout: SandboxRead,
    _guard: SandboxIoGuard,
) -> Result<(), SessionRuntimeError> {
    let mut stdout = FramedRead::new(
        stdout,
        LinesCodec::new_with_max_length(MAX_SESSION_OUTPUT_LINE_BYTES),
    );
    while let Some(line) = stdout.next().await {
        let line = line.map_err(codec_error_to_runtime)?;
        append_output_line(&store, &thread_key, None, &line).await?;
    }
    store
        .append_event(
            &thread_key,
            None,
            "session.stdout_eof",
            json!({
                "sandbox_id": sandbox_id,
            }),
        )
        .await?;
    Ok(())
}

async fn run_codex_app_server_stdout_pump(
    store: PgSessionStore,
    thread_key: ThreadKey,
    sandbox_id: &str,
    stdout: SandboxRead,
    _guard: SandboxIoGuard,
    responses: Arc<Mutex<HashMap<i64, oneshot::Sender<Value>>>>,
    notifications: broadcast::Sender<CodexNotification>,
    state: Arc<Mutex<CodexAppServerState>>,
) -> Result<(), SessionRuntimeError> {
    let mut stdout = FramedRead::new(
        stdout,
        LinesCodec::new_with_max_length(MAX_SESSION_OUTPUT_LINE_BYTES),
    );
    while let Some(line) = stdout.next().await {
        let line = line.map_err(codec_error_to_runtime)?;
        let msg: Value = serde_json::from_str(&line).map_err(|error| {
            SessionRuntimeError::CodexAppServer(format!(
                "codex app-server emitted invalid JSON: {error}"
            ))
        })?;

        if let Some(id) = msg.get("id").and_then(Value::as_i64) {
            if let Some(tx) = responses.lock().await.remove(&id) {
                let _ = tx.send(msg);
            }
            continue;
        }

        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            continue;
        };
        if let Some((payload, notification)) =
            translate_codex_notification(method, msg.get("params"), &state).await
        {
            append_output_line(&store, &thread_key, None, &payload.to_string()).await?;
            let _ = notifications.send(notification);
        }
    }
    store
        .append_event(
            &thread_key,
            None,
            "session.stdout_eof",
            json!({
                "sandbox_id": sandbox_id,
            }),
        )
        .await?;
    Ok(())
}

async fn drain_stderr(mut stderr: SandboxRead) -> Result<(), SessionRuntimeError> {
    io::copy(&mut stderr, &mut io::sink())
        .await
        .map_err(|err| {
            SessionRuntimeError::Sandbox(SandboxError::Io(format!("drain stderr: {err}")))
        })?;
    Ok(())
}

async fn write_line_protocol_turn(
    pipe: &LineSessionPipe,
    input_lines: &[String],
) -> Result<(), SessionRuntimeError> {
    let mut stdin = pipe.stdin.lock().await;
    for line in input_lines {
        stdin.send(line).await.map_err(codec_error_to_runtime)?;
    }
    Ok(())
}

#[derive(Debug)]
enum CodexInput {
    User { items: Vec<Value> },
    Interrupt,
}

fn codex_input_from_line(line: &str) -> Result<CodexInput, SessionRuntimeError> {
    let parsed = serde_json::from_str::<Value>(line).unwrap_or_else(|_| {
        json!({
            "type": "user",
            "message": {
                "content": [{"type": "text", "text": line}],
            },
        })
    });
    match parsed.get("type").and_then(Value::as_str) {
        Some("interrupt") => Ok(CodexInput::Interrupt),
        Some("user") | None => Ok(CodexInput::User {
            items: input_items_from_turn(&parsed),
        }),
        Some(other) => Err(SessionRuntimeError::BadRequest(format!(
            "unsupported Codex session input type {other:?}"
        ))),
    }
}

fn input_items_from_turn(turn_input: &Value) -> Vec<Value> {
    let content = turn_input
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array);
    let Some(blocks) = content else {
        return vec![json!({"type": "text", "text": "continue"})];
    };
    let text = text_from_content_blocks(blocks);
    vec![json!({"type": "text", "text": if text.is_empty() { "continue" } else { &text }})]
}

fn text_from_content_blocks(blocks: &[Value]) -> String {
    let mut parts = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    parts.push(text.to_owned());
                }
            }
            Some("image") => parts.push(
                "[User sent an image attachment; if needed, ask them to upload it as a file reference.]"
                    .to_owned(),
            ),
            _ => parts.push(block.to_string()),
        }
    }
    parts
        .into_iter()
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn split_goal(items: Vec<Value>) -> (Option<String>, Vec<Value>) {
    if items.len() != 1 || items[0].get("type").and_then(Value::as_str) != Some("text") {
        return (None, items);
    }
    let text = items[0]
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let Some(goal) = text.strip_prefix("/goal") else {
        return (None, items);
    };
    let goal = goal.trim();
    if goal.is_empty() {
        (None, items)
    } else {
        (Some(goal.to_owned()), Vec::new())
    }
}

async fn translate_codex_notification(
    method: &str,
    params: Option<&Value>,
    state: &Arc<Mutex<CodexAppServerState>>,
) -> Option<(Value, CodexNotification)> {
    let params = params
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let dotted_type = method.replace('/', ".");
    let mut payload = serde_json::Map::new();
    payload.insert("type".to_owned(), Value::String(dotted_type));
    let mut terminal = None;

    match method {
        "thread/started" => {
            let thread_id = params
                .get("thread")
                .and_then(|thread| thread.get("id"))
                .and_then(Value::as_str)
                .or_else(|| params.get("threadId").and_then(Value::as_str))
                .map(ToOwned::to_owned);
            if let Some(thread_id) = thread_id {
                state.lock().await.thread_id = Some(thread_id.clone());
                payload.insert(
                    "type".to_owned(),
                    Value::String("thread.started".to_owned()),
                );
                payload.insert("thread_id".to_owned(), Value::String(thread_id));
            }
        }
        "turn/started" => {
            let turn_id = params
                .get("turn")
                .and_then(|turn| turn.get("id"))
                .and_then(Value::as_str)
                .or_else(|| params.get("turnId").and_then(Value::as_str))
                .map(ToOwned::to_owned);
            if let Some(turn_id) = turn_id {
                state.lock().await.active_turn_id = Some(turn_id.clone());
                payload.insert("type".to_owned(), Value::String("turn.started".to_owned()));
                payload.insert("turn_id".to_owned(), Value::String(turn_id));
            }
        }
        "item/agentMessage/delta" => {
            extend_payload(&mut payload, params);
            let thread_id = state.lock().await.thread_id.clone();
            if let Some(thread_id) = thread_id
                && !payload.contains_key("session_id")
                && !payload.contains_key("thread_id")
            {
                payload.insert("session_id".to_owned(), Value::String(thread_id));
            }
        }
        "item/completed" => {
            payload.insert(
                "item".to_owned(),
                params
                    .get("item")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(params)),
            );
        }
        "item/started" | "item/updated" => {
            payload.insert(
                "item".to_owned(),
                params
                    .get("item")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(params)),
            );
        }
        "turn/completed" => {
            let turn = params.get("turn").cloned().unwrap_or_else(|| json!({}));
            payload.insert(
                "type".to_owned(),
                Value::String("turn.completed".to_owned()),
            );
            payload.insert("turn".to_owned(), turn.clone());
            payload.insert(
                "usage".to_owned(),
                params
                    .get("usage")
                    .cloned()
                    .or_else(|| turn.get("usage").cloned())
                    .unwrap_or(Value::Null),
            );
            state.lock().await.active_turn_id = None;
            terminal = Some(CodexTerminal::Completed);
        }
        "turn/failed" | "error" => {
            payload.insert("type".to_owned(), Value::String("turn.failed".to_owned()));
            payload.insert(
                "error".to_owned(),
                params
                    .get("error")
                    .cloned()
                    .unwrap_or_else(|| Value::Object(params.clone())),
            );
            state.lock().await.active_turn_id = None;
            terminal = Some(CodexTerminal::Failed(error_message(&Value::Object(params))));
        }
        "item/commandExecution/outputDelta"
        | "item/fileChange/outputDelta"
        | "item/plan/delta"
        | "item/reasoning/summaryTextDelta"
        | "item/reasoning/summaryPartAdded"
        | "item/reasoning/textDelta"
        | "turn/plan/updated"
        | "thread/goal/updated"
        | "thread/goal/cleared" => extend_payload(&mut payload, params),
        _ => return None,
    }

    Some((Value::Object(payload), CodexNotification { terminal }))
}

fn extend_payload(
    payload: &mut serde_json::Map<String, Value>,
    params: serde_json::Map<String, Value>,
) {
    for (key, value) in params {
        payload.insert(key, value);
    }
}

fn error_message(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| value.get("error").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| value.to_string())
}

async fn append_output_line(
    store: &PgSessionStore,
    thread_key: &ThreadKey,
    execution_id: Option<&str>,
    line: &str,
) -> Result<(), SessionRuntimeError> {
    store
        .append_event(
            thread_key,
            execution_id,
            SESSION_OUTPUT_LINE_EVENT,
            Value::String(line.to_owned()),
        )
        .await?;
    Ok(())
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

fn codec_error_to_runtime(error: LinesCodecError) -> SessionRuntimeError {
    SessionRuntimeError::Sandbox(SandboxError::Io(error.to_string()))
}

fn validate_duration_options(input: &ExecuteSessionInput) -> Result<(), SessionRuntimeError> {
    let idle_timeout = input
        .idle_timeout_ms
        .map(nonzero_duration_millis)
        .transpose()?;
    let max_duration = input
        .max_duration_ms
        .map(nonzero_duration_millis)
        .transpose()?;

    if let (Some(idle_timeout), Some(max_duration)) = (idle_timeout, max_duration)
        && idle_timeout > max_duration
    {
        return Err(SessionRuntimeError::BadRequest(
            "idle_timeout_ms must be less than or equal to max_duration_ms".to_owned(),
        ));
    }

    Ok(())
}

fn nonzero_duration_millis(value: u64) -> Result<Duration, SessionRuntimeError> {
    if value == 0 {
        return Err(SessionRuntimeError::BadRequest(
            "duration values must be greater than zero".to_owned(),
        ));
    }
    Ok(Duration::from_millis(value))
}

#[derive(Debug, Error)]
pub enum SessionRuntimeError {
    #[error("{0}")]
    BadRequest(String),
    #[error("codex app-server: {0}")]
    CodexAppServer(String),
    #[error(transparent)]
    Store(#[from] SessionStoreError),
    #[error(transparent)]
    Sandbox(#[from] SandboxError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use async_trait::async_trait;
    use centaur_sandbox_core::{
        MountKind, ObservedSandbox, SandboxHandle, SandboxIo, SandboxResult,
    };

    #[test]
    fn codex_workload_applies_mounts_and_env_without_per_thread_env() {
        let workload = SandboxWorkloadMode::codex_app_server(
            "centaur-agent:latest",
            [("CENTAUR_API_URL".to_owned(), "http://api:8000".to_owned())],
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
        let thread_key = ThreadKey::parse("test:thread").unwrap();

        let spec = workload.spec(&thread_key);

        assert_eq!(
            spec.args,
            vec!["codex", "app-server", "--listen", "stdio://"]
        );
        assert!(spec.command.is_none());
        assert_eq!(spec.mounts.len(), 1);
        assert_eq!(spec.mounts[0].target_path, "/home/agent/github");
        assert!(spec.mounts[0].read_only);
        assert_eq!(
            spec.mounts[0].kind,
            MountKind::Bind {
                source_path: "/host/github".to_owned(),
            }
        );
        assert!(!spec.env.iter().any(|env| env.name == "CENTAUR_THREAD_KEY"));
        assert!(
            spec.env
                .iter()
                .any(|env| env.name == "CENTAUR_API_URL" && env.value == "http://api:8000")
        );
    }

    #[test]
    fn codex_input_extracts_goal_from_session_user_line() {
        let input = codex_input_from_line(
            r#"{"type":"user","message":{"content":[{"type":"text","text":"/goal ship warm containers"}]}}"#,
        )
        .unwrap();

        let CodexInput::User { items } = input else {
            panic!("expected user input");
        };
        let (goal, remaining) = split_goal(items);
        assert_eq!(goal.as_deref(), Some("ship warm containers"));
        assert!(remaining.is_empty());
    }

    #[tokio::test]
    async fn codex_turn_completed_notification_becomes_terminal_output() {
        let state = Arc::new(tokio::sync::Mutex::new(CodexAppServerState::default()));

        let (payload, notification) = translate_codex_notification(
            "turn/completed",
            Some(&json!({
                "turn": {"id": "turn-1"},
                "usage": {"input_tokens": 1, "output_tokens": 2},
            })),
            &state,
        )
        .await
        .unwrap();

        assert_eq!(payload["type"], "turn.completed");
        assert_eq!(payload["turn"]["id"], "turn-1");
        assert!(matches!(
            notification.terminal,
            Some(CodexTerminal::Completed)
        ));
    }

    #[tokio::test]
    async fn existing_suspended_sandbox_is_resumed_for_warm_reuse() {
        let backend = Arc::new(FakeBackend::new([("sandbox-1", SandboxStatus::Suspended)]));
        let manager = SandboxManager::new(backend.clone());

        let outcome = try_reuse_existing_sandbox(&manager, "sandbox-1")
            .await
            .unwrap();

        assert_eq!(outcome, ExistingSandboxReuse::Resumed);
        assert_eq!(backend.status_of("sandbox-1"), Some(SandboxStatus::Running));
        assert_eq!(backend.operations(), ["resume:sandbox-1"]);
    }

    #[tokio::test]
    async fn missing_existing_sandbox_is_replaced() {
        let backend = Arc::new(FakeBackend::new([]));
        let manager = SandboxManager::new(backend.clone());

        let outcome = try_reuse_existing_sandbox(&manager, "sandbox-1")
            .await
            .unwrap();

        assert_eq!(outcome, ExistingSandboxReuse::Missing);
        assert_eq!(backend.operations(), Vec::<String>::new());
    }

    struct FakeBackend {
        statuses: Mutex<HashMap<SandboxId, SandboxStatus>>,
        operations: Mutex<Vec<String>>,
    }

    impl FakeBackend {
        fn new<const N: usize>(statuses: [(&str, SandboxStatus); N]) -> Self {
            Self {
                statuses: Mutex::new(
                    statuses
                        .into_iter()
                        .map(|(id, status)| (SandboxId::from(id), status))
                        .collect(),
                ),
                operations: Mutex::new(Vec::new()),
            }
        }

        fn status_of(&self, id: &str) -> Option<SandboxStatus> {
            self.statuses
                .lock()
                .expect("status lock poisoned")
                .get(&SandboxId::from(id))
                .cloned()
        }

        fn operations(&self) -> Vec<String> {
            self.operations
                .lock()
                .expect("operations lock poisoned")
                .clone()
        }

        fn set_status(&self, id: &SandboxId, status: SandboxStatus) {
            self.statuses
                .lock()
                .expect("status lock poisoned")
                .insert(id.clone(), status);
        }

        fn push_operation(&self, operation: &str, id: &SandboxId) {
            self.operations
                .lock()
                .expect("operations lock poisoned")
                .push(format!("{operation}:{}", id.as_str()));
        }
    }

    #[async_trait]
    impl SandboxBackend for FakeBackend {
        fn name(&self) -> &'static str {
            "fake"
        }

        async fn create(&self, _spec: SandboxSpec) -> SandboxResult<SandboxHandle> {
            unreachable!("reuse tests should not create sandboxes")
        }

        async fn open_io(&self, _id: &SandboxId) -> SandboxResult<SandboxIo> {
            unreachable!("reuse tests should not open I/O")
        }

        async fn status(&self, id: &SandboxId) -> SandboxResult<SandboxStatus> {
            Ok(self.status_of(id.as_str()).unwrap_or(SandboxStatus::Gone))
        }

        async fn observe(&self, id: &SandboxId) -> SandboxResult<ObservedSandbox> {
            Ok(ObservedSandbox::new(
                id.clone(),
                self.name(),
                self.status(id).await?,
            ))
        }

        async fn list_observed(&self) -> SandboxResult<Vec<ObservedSandbox>> {
            Ok(Vec::new())
        }

        async fn stop(&self, id: &SandboxId) -> SandboxResult<()> {
            self.push_operation("stop", id);
            self.set_status(id, SandboxStatus::Stopped);
            Ok(())
        }

        async fn pause(&self, id: &SandboxId) -> SandboxResult<()> {
            self.push_operation("pause", id);
            self.set_status(id, SandboxStatus::Suspended);
            Ok(())
        }

        async fn resume(&self, id: &SandboxId) -> SandboxResult<()> {
            self.push_operation("resume", id);
            self.set_status(id, SandboxStatus::Running);
            Ok(())
        }
    }
}
