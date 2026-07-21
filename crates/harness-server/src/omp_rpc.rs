//! Resident OMP RPC host adapter.
//!
//! One `omp --mode rpc` process per owned Centaur session, reused across
//! sequential turns. The process continuously drains unsolicited
//! session/agent/collaboration lifecycle frames from its stdout while ordinary
//! commands (prompt/steer/abort/collab_*) are correlated by request id. This
//! mirrors the Codex App Server V2 resident pattern (`codex::run_codex_blocks_server`,
//! `CodexJsonRpcChild`) but against the OMP RPC wire contract rather than the
//! Codex JSON-RPC app-server protocol.
//!
//! Ownership: admission requires the current resident session ownership
//! (`owner_id` + `generation`) and the adapter carries it for the process
//! lifetime. A stale or missing ownership fence rejects every command and
//! prevents durable frame publication. See `OmpRpcOwnership`.
//!
//! # Process lifetime vs session resume
//! Process reuse is within one resident host lifetime (one `OmpRpcChild`).
//! Across resident lifetimes (child death / re-acquire), set
//! `CENTAUR_OMP_SESSION_NAME` so respawn passes `--resume <name>` and the
//! prior JSONL session is continued instead of starting an anonymous one.
//!
//! # Ownership lease recovery
//! This adapter does not release the DB ownership row — api-rs owns the
//! lease (acquire/release around executions). If api-rs crashes without
//! releasing, recovery is the DB row's lease-expiry timeout. See
//! `acquire_oneshot_session_ownership` / `release_session_ownership`.

use std::env;
use std::io::{self, BufRead, Write};
use std::process::{Child, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::omp::OmpStreamEvent;
use crate::server::BlocksCommand;
use crate::turn::CodexTurnNormalizer;
use crate::util::write_value;
use crate::wire::collab_state_wire_value;
use crate::{HarnessServerError, Result};

/// The resident session ownership fence. Admission requires both fields; a
/// stale generation (one that no longer matches the current owner) or a
/// missing owner rejects every command and prevents durable frame publication.
///
/// Lease recovery: the fence is process-local. Durable ownership lives in
/// api-rs's DB row; if the API process dies without release, the lease
/// expires on its timeout and a new owner can re-acquire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OmpRpcOwnership {
    pub owner_id: String,
    pub generation: i64,
}

impl OmpRpcOwnership {
    /// `true` when `other` is the same owner at the same generation. Used to
    /// fence a stale owner: after a loss/reacquire the generation bumps, so a
    /// stale owner's commands no longer match and are rejected.
    pub fn matches(&self, other: &OmpRpcOwnership) -> bool {
        self.owner_id == other.owner_id && self.generation == other.generation
    }
}

/// One frame demultiplexed from the resident `omp --mode rpc` stdout stream.
/// The adapter distinguishes correlated command responses (matched by `id`)
/// from unsolicited session/agent/collaboration lifecycle frames.
#[derive(Debug, Clone)]
pub enum OmpRpcFrame {
    /// Emitted once at startup before any command is accepted.
    Ready,
    /// A correlated command response. `id` echoes the request `id`; `None`
    /// when the request had no id (or for parse/unknown-command errors).
    Response {
        id: Option<String>,
        command: String,
        success: bool,
        data: Option<Value>,
        error: Option<String>,
    },
    /// An `AgentSessionEvent` (`agent_start`, `message_update`, `agent_end`,
    /// …). Reuses the one-shot parser so the normalized event surface is
    /// identical across the one-shot and resident paths.
    Event(OmpStreamEvent),
    /// An unsolicited collaboration lifecycle frame.
    CollabState {
        state: String,
        reason: Option<String>,
        room: Value,
    },
    /// A prompt that was accepted immediately but later resolves as local-only
    /// (no agent turn). `agent_invoked == false` is a completion signal.
    PromptResult {
        #[allow(dead_code)]
        id: Option<String>,
        agent_invoked: bool,
    },
    /// Any other unsolicited frame the adapter does not demultiplex into a
    /// normalized event (extension_error, available_commands_update,
    /// host_tool_*, subagent_*). Forwarded verbatim to the host log.
    Other(Value),
}

impl OmpRpcFrame {
    /// Parse one JSON line from `omp --mode rpc` stdout into a demultiplexed
    /// frame. Unknown shapes degrade to [`OmpRpcFrame::Other`] rather than
    /// erroring so the drain loop never blocks on a novel frame.
    pub fn parse_json_line(line: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(line)?;
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Result<Self> {
        let Some(kind) = value.get("type").and_then(Value::as_str) else {
            return Ok(Self::Other(value));
        };
        match kind {
            "ready" => Ok(Self::Ready),
            "response" => {
                let id = value.get("id").and_then(Value::as_str).map(str::to_owned);
                let command = value
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let success = value
                    .get("success")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let data = value.get("data").cloned().filter(|v| !v.is_null());
                let error = value
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Ok(Self::Response {
                    id,
                    command,
                    success,
                    data,
                    error,
                })
            }
            "collab_state" => {
                let state = value
                    .get("state")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                let reason = value
                    .get("reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let room = value.get("room").cloned().unwrap_or(Value::Null);
                Ok(Self::CollabState {
                    state,
                    reason,
                    room,
                })
            }
            "prompt_result" => {
                let id = value.get("id").and_then(Value::as_str).map(str::to_owned);
                let agent_invoked = value
                    .get("agentInvoked")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Ok(Self::PromptResult { id, agent_invoked })
            }
            // AgentSessionEvent frames reuse the one-shot stream parser so the
            // normalized event surface is identical across paths.
            "session"
            | "agent_start"
            | "agent_end"
            | "turn_start"
            | "turn_end"
            | "message_start"
            | "message_update"
            | "message_end"
            | "tool_execution_start"
            | "tool_execution_update"
            | "tool_execution_end"
            | "error" => Ok(Self::Event(OmpStreamEvent::parse_json_line(
                &value.to_string(),
            )?)),
            _ => Ok(Self::Other(value)),
        }
    }
}

/// A resident `omp --mode rpc` child process. stdout is drained continuously
/// by a background thread into an mpsc channel so unsolicited lifecycle frames
/// never block a pending command. Command responses are correlated by `id` and
/// handed to the waiting caller via a one-shot slot.
pub struct OmpRpcChild {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: Receiver<io::Result<String>>,
    /// Monotonically increasing request id for commands that need correlation.
    next_id: u64,
}

impl OmpRpcChild {
    /// Spawn `omp --mode rpc` (or the override at `CENTAUR_OMP_RPC_BRIDGE_COMMAND`)
    /// with piped stdio. The caller drives the ready handshake and drain loop.
    pub fn spawn() -> Result<Self> {
        let mut command = omp_rpc_command();
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| HarnessServerError::SpawnHarness {
                cwd: env::current_dir().unwrap_or_default(),
                source,
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or(HarnessServerError::HarnessStdinUnavailable)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(HarnessServerError::HarnessStdoutUnavailable)?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or(HarnessServerError::HarnessStderrUnavailable)?;
        thread::spawn(move || {
            // Unlocked handle on purpose: the child outlives each turn, so
            // holding the StderrLock for the copy's lifetime would block every
            // eprintln! in the server until the child exits.
            let mut parent_stderr = io::stderr();
            let _ = io::copy(&mut stderr, &mut parent_stderr);
        });

        let (stdout_tx, stdout_rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = io::BufReader::new(stdout);
            for raw in reader.lines() {
                let should_stop = raw.is_err();
                if stdout_tx.send(raw).is_err() || should_stop {
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdin: Some(stdin),
            stdout: stdout_rx,
            next_id: 1,
        })
    }

    /// Allocate the next request id. OMP RPC accepts optional string ids; the
    /// adapter always sends one so responses can be correlated.
    pub fn next_request_id(&mut self) -> String {
        let id = self.next_id.to_string();
        self.next_id += 1;
        id
    }

    /// Send a JSON command on stdin. The caller supplies the full command
    /// object (including `id` and `type`).
    pub fn send_command(&mut self, command: &Value) -> Result<()> {
        let stdin = self
            .stdin
            .as_mut()
            .ok_or(HarnessServerError::HarnessStdinUnavailable)?;
        serde_json::to_writer(&mut *stdin, command)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    /// Read the next raw stdout line. `Err` on EOF/child exit.
    pub fn read_line(&mut self) -> Result<String> {
        loop {
            let line: io::Result<String> = match self.stdout.recv() {
                Ok(line) => line,
                Err(_) => {
                    let status = self.child.wait()?;
                    return Err(HarnessServerError::HarnessExited {
                        kind: crate::traits::HarnessKind::Omp,
                        status,
                        stderr: String::new(),
                    });
                }
            };
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Ok(trimmed.to_owned());
        }
    }

    /// Try to read the next raw stdout line without blocking longer than
    /// `timeout`. `Ok(None)` on timeout; `Err` on EOF/child exit.
    pub fn read_line_timeout(&mut self, timeout: Duration) -> Result<Option<String>> {
        loop {
            let line: io::Result<String> = match self.stdout.recv_timeout(timeout) {
                Ok(line) => line,
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    let status = self.child.wait()?;
                    return Err(HarnessServerError::HarnessExited {
                        kind: crate::traits::HarnessKind::Omp,
                        status,
                        stderr: String::new(),
                    });
                }
            };
            let line = line?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Ok(Some(trimmed.to_owned()));
        }
    }

    /// Wait for the process to exit and return its status. Used by clean
    /// shutdown after stdin is closed.
    pub fn wait(mut self) -> Result<std::process::ExitStatus> {
        // Closing stdin tells the RPC server to drain pending side-channel
        // requests and exit cleanly (code 0). Bounded: if the child ignores
        // stdin EOF, kill after the timeout rather than hang forever.
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.flush();
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            match self.child.try_wait()? {
                Some(status) => return Ok(status),
                None if std::time::Instant::now() >= deadline => {
                    let _ = self.child.kill();
                    return self.child.wait().map_err(Into::into);
                }
                None => thread::sleep(Duration::from_millis(50)),
            }
        }
    }
}

impl Drop for OmpRpcChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn omp_rpc_command() -> ProcessCommand {
    if let Some(command) = crate::command_from_override("CENTAUR_OMP_RPC_BRIDGE_COMMAND") {
        return command;
    }
    let bin = env::var("OMP_BIN").unwrap_or_else(|_| "omp".to_string());
    let mut command = ProcessCommand::new(bin);
    command.args([
        "--mode",
        "rpc",
        "--auto-approve",
        "--session-dir",
        &crate::omp::omp_session_dir().display().to_string(),
    ]);
    // Resume prior session: read the actual session id written by the first
    // spawn's get_state response. The release resolves --resume by JSONL
    // filename prefix matching.
    let session_marker = crate::omp::omp_session_dir().join(".resident_session_id");
    if let Ok(id) = std::fs::read_to_string(&session_marker)
        && !id.trim().is_empty()
    {
        command.args(["--resume", id.trim()]);
    }
    if let Ok(model) = env::var("OMP_MODEL")
        && !model.is_empty()
    {
        command.args(["--model", &model]);
    }
    command
}

/// After ready, drain the initial frames to find the session_info_update
/// (emitted by the release binary on startup). This yields the actual session
/// id and name that the release assigned, so a respawn can resume the prior
/// session by its JSONL path rather than a display name the release cannot
/// resolve. Frames are forwarded through the normalizer if possible.
/// After `ready`, send `get_state` to obtain the authoritative session id.
/// Returns `Err` if the response is missing, empty, failed, or times out.
/// The id is persisted to `$OMP_SESSION_DIR/.resident_session_id` so a respawn
/// can resume the prior JSONL.
fn query_and_persist_session_state(
    child: &mut OmpRpcChild,
    event_normalizer: &mut crate::omp::OmpEventNormalizer,
    stdout: &mut impl Write,
    admitted: &Option<OmpRpcOwnership>,
) -> Result<String> {
    let id = child.next_request_id();
    child.send_command(&json!({ "id": id, "type": "get_state" }))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let Some(line) = child.read_line_timeout(Duration::from_millis(100))? else {
            continue;
        };
        let frame = OmpRpcFrame::parse_json_line(&line)?;
        match frame {
            OmpRpcFrame::Response {
                id: resp_id,
                command,
                success,
                data,
                error,
            } if resp_id.as_deref() == Some(id.as_str()) && command == "get_state" => {
                if !success {
                    return Err(HarnessServerError::InvalidBlocksInput {
                        message: format!("get_state failed: {}", error.unwrap_or_default()),
                    });
                }
                let Some(d) = data else {
                    return Err(HarnessServerError::InvalidBlocksInput {
                        message: "get_state returned no data".to_string(),
                    });
                };
                let Some(sid) = d.get("sessionId").and_then(Value::as_str) else {
                    return Err(HarnessServerError::InvalidBlocksInput {
                        message: "get_state missing sessionId".to_string(),
                    });
                };
                if sid.is_empty() {
                    return Err(HarnessServerError::InvalidBlocksInput {
                        message: "get_state returned empty sessionId".to_string(),
                    });
                }
                eprintln!("omp rpc: resident session id={sid}");
                let dir = crate::omp::omp_session_dir();
                std::fs::create_dir_all(&dir)?;
                let marker = dir.join(".resident_session_id");
                std::fs::write(&marker, sid)?;
                return Ok(sid.to_owned());
            }
            OmpRpcFrame::Response { .. } => {}
            OmpRpcFrame::Event(event) => {
                use crate::traits::HarnessServer;
                let events = crate::omp::OmpHarness.normalize_events(event_normalizer, event)?;
                use crate::traits::NormalizedEvent;
                for normalized in events {
                    if let NormalizedEvent::CollabState {
                        state,
                        reason,
                        room,
                    } = &normalized
                    {
                        let mut val = collab_state_wire_value(state, reason.as_deref(), room);
                        stamp_ownership(&mut val, admitted);
                        let _ = write_value(stdout, &val);
                    }
                    let _ = normalized;
                }
            }
            _ => {}
        }
    }
    Err(HarnessServerError::InvalidBlocksInput {
        message: "get_state timed out".to_string(),
    })
}

/// Build a `prompt` command. During active streaming, `streaming_behavior`
/// must be `"steer"` or `"followUp"` or the prompt fails.
pub fn prompt_command(id: &str, message: &str, streaming_behavior: Option<&str>) -> Value {
    let mut cmd = json!({ "id": id, "type": "prompt", "message": message });
    if let Some(behavior) = streaming_behavior {
        cmd["streamingBehavior"] = Value::String(behavior.to_owned());
    }
    cmd
}

/// Build a `steer` command (queues a steering message during active streaming).
pub fn steer_command(id: &str, message: &str) -> Value {
    json!({ "id": id, "type": "steer", "message": message })
}

/// Build an `abort` command (interrupts the active turn).
pub fn abort_command(id: &str) -> Value {
    json!({ "id": id, "type": "abort" })
}

/// Build a `collab_start` command.
pub fn collab_start_command(
    id: &str,
    relay_url: Option<&str>,
    display_name: Option<&str>,
    web_url: Option<&str>,
) -> Value {
    let mut cmd = json!({ "id": id, "type": "collab_start" });
    if let Some(relay) = relay_url {
        cmd["relayUrl"] = Value::String(relay.to_owned());
    }
    if let Some(name) = display_name {
        cmd["displayName"] = Value::String(name.to_owned());
    }
    if let Some(web) = web_url {
        cmd["webUrl"] = Value::String(web.to_owned());
    }
    cmd
}

/// Build a `collab_status` command.
pub fn collab_status_command(id: &str) -> Value {
    json!({ "id": id, "type": "collab_status" })
}

/// Build a `collab_stop` command.
pub fn collab_stop_command(id: &str) -> Value {
    json!({ "id": id, "type": "collab_stop" })
}

/// Normalized collaboration room state extracted from a `collab_state` frame
/// or a `collab_*` response `data` payload. Mirrors the fork's
/// `RpcCollabRoomState` so downstream consumers (api-rs durable event
/// projection) never touch the raw JSON.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct OmpCollabRoomState {
    pub active: bool,
    #[serde(default, rename = "joinUrl")]
    pub join_url: Option<String>,
    #[serde(default, rename = "viewUrl")]
    pub view_url: Option<String>,
    #[serde(default, rename = "webUrl")]
    pub web_url: Option<String>,
    #[serde(default, rename = "webViewUrl")]
    pub web_view_url: Option<String>,
    #[serde(default)]
    pub participants: Vec<OmpCollabParticipant>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct OmpCollabParticipant {
    pub name: String,
    pub role: String,
    #[serde(default, rename = "readOnly")]
    pub read_only: Option<bool>,
}

/// Extract the room state from a `collab_*` response `data` payload or a
/// `collab_state` frame's `room` field.
pub fn parse_room_state(value: &Value) -> Result<OmpCollabRoomState> {
    Ok(serde_json::from_value(value.clone())?)
}

/// Project the room state into the api-rs canonical snake_case contract:
/// `{active, join_url?, view_url?, web_url?, participants:[{name, role,
/// read_only?}]}`. The resident host uses upstream camelCase only at the RPC
/// boundary and normalizes to this shape for api-rs.
pub fn room_state_to_api(room: &OmpCollabRoomState) -> Value {
    let mut obj = json!({
        "active": room.active,
        "participants": room.participants.iter().map(|p| {
            let mut participant = json!({ "name": p.name, "role": p.role });
            if let Some(read_only) = p.read_only {
                participant["read_only"] = json!(read_only);
            }
            participant
        }).collect::<Vec<_>>(),
    });
    if let Some(url) = &room.join_url {
        obj["join_url"] = json!(url);
    }
    if let Some(url) = &room.view_url {
        obj["view_url"] = json!(url);
    }
    if let Some(url) = &room.web_url {
        obj["web_url"] = json!(url);
    }
    if let Some(url) = &room.web_view_url {
        obj["web_view_url"] = json!(url);
    }
    obj
}
/// Blocks-mode control commands the resident OMP host accepts in addition to
/// the shared `user`/`interrupt`/`attachment.chunk` commands. Each carries
/// the ownership fence so a stale owner cannot control the room.
#[derive(Debug)]
pub enum OmpBlocksControl {
    CollabStart {
        /// Optional caller-supplied request id for correlation. When present
        /// the adapter uses it as the omp RPC request id and echoes it as
        /// `request_id` on the normalized collab/state notification.
        request_id: Option<String>,
        relay_url: Option<String>,
        display_name: Option<String>,
        web_url: Option<String>,
        ownership: OmpRpcOwnership,
    },
    CollabStatus {
        request_id: Option<String>,
        ownership: OmpRpcOwnership,
    },
    CollabStop {
        request_id: Option<String>,
        ownership: OmpRpcOwnership,
    },
    /// Interrupt the active turn. Carries ownership so the adapter can fence
    /// stale/missing owners before sending abort to the resident process.
    Interrupt {
        request_id: Option<String>,
        ownership: OmpRpcOwnership,
    },
}

/// Parse a blocks line for an OMP-specific control command. Returns `None`
/// when the line is a shared command (`user`/`interrupt`/`attachment.chunk`)
/// handled by the generic blocks reader.
pub fn parse_omp_control_line(line: &str) -> Result<Option<OmpBlocksControl>> {
    let value: Value =
        serde_json::from_str(line).map_err(|source| HarnessServerError::InvalidBlocksInput {
            message: source.to_string(),
        })?;
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // Read ownership from trusted trace_metadata (where api-rs injects it),
    // falling back to a top-level ownership field for legacy callers.
    let ownership = value
        .get("trace_metadata")
        .or_else(|| value.get("ownership"))
        .and_then(|o| {
            let owner_id = o.get("owner_id").and_then(Value::as_str)?;
            let generation = o.get("generation").and_then(Value::as_i64)?;
            Some(OmpRpcOwnership {
                owner_id: owner_id.to_owned(),
                generation,
            })
        })
        .ok_or_else(|| HarnessServerError::InvalidBlocksInput {
            message: "missing ownership (owner_id + generation) in trace_metadata".to_string(),
        })?;
    let request_id = value
        .get("id")
        .or_else(|| value.get("request_id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    match kind {
        "collab_start" => Ok(Some(OmpBlocksControl::CollabStart {
            request_id,
            relay_url: value
                .get("relayUrl")
                .or_else(|| value.get("relay_url"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            display_name: value
                .get("displayName")
                .or_else(|| value.get("display_name"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            web_url: value
                .get("webUrl")
                .or_else(|| value.get("web_url"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            ownership,
        })),
        "collab_status" => Ok(Some(OmpBlocksControl::CollabStatus {
            request_id,
            ownership,
        })),
        "collab_stop" => Ok(Some(OmpBlocksControl::CollabStop {
            request_id,
            ownership,
        })),
        "interrupt" => Ok(Some(OmpBlocksControl::Interrupt {
            request_id,
            ownership,
        })),
        _ => Ok(None),
    }
}

/// Combined input for the resident OMP blocks server. Shared blocks commands
/// (user/interrupt/attachment) and OMP-specific controls (collab_*) flow
/// through a single channel so the main loop can select on one receiver.
enum OmpBlocksInput {
    Command(BlocksCommand),
    Control(OmpBlocksControl),
    /// A control line that failed to parse (e.g. missing ownership).
    /// Carries the error message, optional request id, and command kind
    /// so the error frame can be correlated by the api-rs dispatcher.
    ParseError {
        message: String,
        request_id: Option<String>,
        command: String,
    },
}

/// The resident OMP blocks server. One `omp --mode rpc` process per owned
/// session, reused across sequential turns. Continuously drains unsolicited
/// session/agent/collaboration lifecycle frames while ordinary commands are
/// correlated by id. Requires current resident ownership on admission and
/// fences stale/missing ownership.
///
/// Ownership lease recovery: this process does not touch the DB ownership
/// row. api-rs acquires/releases the lease around executions; if api-rs dies
/// without release, the DB lease-expiry timeout is the recovery path. On
/// clean stdin EOF this server waits (bounded) for the child then exits.
pub fn run_omp_blocks_server() -> Result<()> {
    use crate::omp::OmpEventNormalizer;
    use crate::server::{BlocksState, parse_blocks_line_with_state};
    use crate::turn::BridgeConfig;
    use crate::wire::notification_to_wire_value;
    use std::io::{self, BufRead};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::thread;

    let mut stdout = io::stdout().lock();
    let (input_tx, input_rx) = mpsc::channel::<OmpBlocksInput>();
    let turn_active = Arc::new(AtomicBool::new(false));

    // stdin reader: separates shared blocks commands (user/interrupt) from
    // OMP-specific control commands (collab_*), sending both through one
    // channel so the main loop selects on a single receiver.
    {
        let turn_active = Arc::clone(&turn_active);
        thread::spawn(move || {
            let stdin = io::stdin();
            let mut blocks_state = BlocksState::default();
            for raw in stdin.lock().lines() {
                let Ok(line) = raw else { break };
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Try OMP-specific control first; fall through to shared.
                match parse_omp_control_line(trimmed) {
                    Ok(Some(control)) => {
                        if input_tx.send(OmpBlocksInput::Control(control)).is_err() {
                            break;
                        }
                        continue;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        // Surface parse errors (e.g. missing ownership)
                        // with request_id and command kind for correlation.
                        let (kind, rid) = match serde_json::from_str::<Value>(trimmed) {
                            Ok(v) => (
                                v.get("type")
                                    .and_then(Value::as_str)
                                    .unwrap_or("input")
                                    .to_owned(),
                                v.get("id")
                                    .or_else(|| v.get("request_id"))
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .map(str::to_owned),
                            ),
                            Err(_) => ("input".to_string(), None),
                        };
                        eprintln!("invalid OMP control input: {error}");
                        if input_tx
                            .send(OmpBlocksInput::ParseError {
                                message: error.to_string(),
                                request_id: rid,
                                command: kind,
                            })
                            .is_err()
                        {
                            break;
                        }
                        continue;
                    }
                }
                match parse_blocks_line_with_state(trimmed, &mut blocks_state) {
                    Ok(BlocksCommand::Interrupt) if turn_active.load(Ordering::SeqCst) => {
                        // Interrupt during an active turn: send as a control
                        // so the turn driver can abort the resident process.
                        if input_tx
                            .send(OmpBlocksInput::Command(BlocksCommand::Interrupt))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(command @ BlocksCommand::User { .. }) => {
                        turn_active.store(true, Ordering::SeqCst);
                        if input_tx.send(OmpBlocksInput::Command(command)).is_err() {
                            break;
                        }
                    }
                    Ok(command) => {
                        if input_tx.send(OmpBlocksInput::Command(command)).is_err() {
                            break;
                        }
                    }
                    Err(error) => {
                        eprintln!("invalid OMP blocks input: {error}");
                    }
                }
            }
        });
    }

    let mut child: Option<OmpRpcChild> = None;
    let mut event_normalizer = OmpEventNormalizer;
    let mut admitted_ownership: Option<OmpRpcOwnership> = None;
    let thread_id = format!("omp-{}", uuid::Uuid::new_v4().simple());
    let mut harness_session_id: Option<String> = None;

    let mut respawn_child = false;
    let mut outer_pending: std::collections::VecDeque<OmpBlocksInput> =
        std::collections::VecDeque::new();
    loop {
        let input = if let Some(pending) = outer_pending.pop_front() {
            pending
        } else {
            match input_rx.recv() {
                Ok(input) => input,
                Err(_) => break,
            }
        };
        match input {
            OmpBlocksInput::Command(BlocksCommand::User {
                input,
                client_user_message_id,
                model: _,
                trace_context,
                ..
            }) => {
                // Set turn_active at actual dispatch so concurrent
                // interrupt/steer gates work for pending Users that start
                // after a prior turn cleared the flag.
                turn_active.store(true, Ordering::SeqCst);
                // Admission: require ownership on first turn. The ownership
                // is carried in trace_metadata. A stale or missing fence
                // rejects.
                let ownership = ownership_from_trace(&trace_context);
                // Require ownership on EVERY user command (not just first).
                // A stale or missing fence is rejected; None after admission
                // is also rejected (a non-object trace_metadata cannot bypass).
                let Some(incoming) = &ownership else {
                    write_blocks_error(
                        &mut stdout,
                        &thread_id,
                        "turn",
                        "missing ownership: resident host requires owner_id + generation",
                    )?;
                    continue;
                };
                if let Some(admitted) = &admitted_ownership {
                    if !admitted.matches(incoming) {
                        write_blocks_error(
                            &mut stdout,
                            &thread_id,
                            "turn",
                            "ownership fence mismatch: stale owner",
                        )?;
                        continue;
                    }
                } else {
                    // First admission: pin the ownership fence.
                    admitted_ownership = Some(incoming.clone());
                }

                // Spawn or reuse the resident process.
                if child.is_none() {
                    child = Some(OmpRpcChild::spawn()?);
                    drain_ready(child.as_mut().unwrap())?;
                    query_and_persist_session_state(
                        child.as_mut().unwrap(),
                        &mut event_normalizer,
                        &mut stdout,
                        &admitted_ownership,
                    )?;
                }
                let child = child.as_mut().unwrap();

                let message = prompt_text(&input);

                // Detect steering: api-rs sends a user line with
                // trace_metadata.action == "steer_active_execution" to queue
                // additional context during an active turn. Route it as a
                // steer command rather than a new prompt.
                let is_steer = trace_context.metadata.get("action").and_then(Value::as_str)
                    == Some("steer_active_execution");

                if is_steer {
                    // Steer: send the steer command and wait for its response.
                    // No turn lifecycle — the active turn continues.
                    let id = child.next_request_id();
                    child.send_command(&steer_command(&id, &message))?;
                    drive_omp_steer_response(
                        child,
                        &id,
                        &mut stdout,
                        &thread_id,
                        &admitted_ownership,
                    )?;
                    turn_active.store(false, Ordering::SeqCst);
                    continue;
                }

                // Prompt: send and drive the turn to completion.
                let id = child.next_request_id();
                child.send_command(&prompt_command(&id, &message, None))?;

                let turn_id = format!("turn-{}", uuid::Uuid::new_v4().simple());
                let mut config = BridgeConfig::new(thread_id.clone(), turn_id.clone());
                config.cli_version = "omp".to_string();
                config.model_provider = "omp".to_string();
                let mut normalizer = CodexTurnNormalizer::new(config);

                for notification in normalizer.start_notifications(true)? {
                    write_value(&mut stdout, &notification_to_wire_value(&notification)?)?;
                }
                for notification in
                    normalizer.emit_user_message(client_user_message_id, input.clone())?
                {
                    write_value(&mut stdout, &notification_to_wire_value(&notification)?)?;
                }

                let drive_result = drive_omp_turn(
                    child,
                    &mut event_normalizer,
                    &mut normalizer,
                    &mut stdout,
                    &mut harness_session_id,
                    &id,
                    &turn_id,
                    &thread_id,
                    &input_rx,
                    &admitted_ownership,
                )?;

                turn_active.store(false, Ordering::SeqCst);

                // #4: requeue pending items from the turn driver into the
                // outer VecDeque for FIFO processing before the next recv.
                for input in drive_result.pending {
                    outer_pending.push_back(input);
                }

                // #6: if the child is not reusable, drop it so the next
                // turn spawns a fresh process.
                if !drive_result.child_reusable {
                    // Signal outer scope to respawn. The inner 'child' is
                    // a &mut reference; we kill via Drop by setting a flag.
                    respawn_child = true;
                }
            }
            OmpBlocksInput::Command(BlocksCommand::Interrupt) => {
                // Interrupt without ownership: reject if ownership has been
                // admitted (the process exists and a stale owner must not
                // abort it). If no process exists, there is nothing to abort.
                if admitted_ownership.is_some() {
                    write_blocks_error(
                        &mut stdout,
                        &thread_id,
                        "interrupt",
                        "missing ownership: interrupt requires owner_id + generation",
                    )?;
                    continue;
                }
                if let Some(child) = child.as_mut() {
                    let id = child.next_request_id();
                    child.send_command(&abort_command(&id))?;
                }
            }
            OmpBlocksInput::Control(OmpBlocksControl::Interrupt {
                request_id,
                ownership,
            }) => {
                if !check_ownership_with_request_id(
                    &mut admitted_ownership,
                    &ownership,
                    &mut stdout,
                    &thread_id,
                    request_id.as_deref(),
                    "interrupt",
                ) {
                    continue;
                }
                if let Some(child) = child.as_mut() {
                    let id = resolve_request_id(child, request_id);
                    child.send_command(&abort_command(&id))?;
                }
            }
            OmpBlocksInput::Command(BlocksCommand::AttachmentChunk) => {}
            OmpBlocksInput::ParseError {
                message,
                request_id,
                command,
            } => {
                // Stamp ownership only for collab-* parse errors; interrupt
                // and other non-collab parse errors keep the prior shape.
                let own = if command.starts_with("collab") {
                    admitted_ownership.as_ref()
                } else {
                    None
                };
                write_blocks_error_with_request_id(
                    &mut stdout,
                    &thread_id,
                    &command,
                    &message,
                    request_id.as_deref(),
                    own,
                )?;
            }
            OmpBlocksInput::Control(OmpBlocksControl::CollabStart {
                request_id,
                relay_url,
                display_name,
                web_url,
                ownership,
            }) => {
                if !check_ownership_with_request_id(
                    &mut admitted_ownership,
                    &ownership,
                    &mut stdout,
                    &thread_id,
                    request_id.as_deref(),
                    "collab_start",
                ) {
                    continue;
                }
                if child.is_none() {
                    child = Some(OmpRpcChild::spawn()?);
                    drain_ready(child.as_mut().unwrap())?;
                    query_and_persist_session_state(
                        child.as_mut().unwrap(),
                        &mut event_normalizer,
                        &mut stdout,
                        &admitted_ownership,
                    )?;
                }
                let child = child.as_mut().unwrap();
                let id = resolve_request_id(child, request_id);
                child.send_command(&collab_start_command(
                    &id,
                    relay_url.as_deref(),
                    display_name.as_deref(),
                    web_url.as_deref(),
                ))?;
                let room = drive_collab_command(
                    child,
                    &id,
                    "collab_start",
                    &mut stdout,
                    &thread_id,
                    &admitted_ownership,
                )?;
                if let Some(room) = room {
                    emit_collab_state(
                        &mut stdout,
                        "started",
                        None,
                        &room,
                        Some(&id),
                        &admitted_ownership,
                    )?;
                }
            }
            OmpBlocksInput::Control(OmpBlocksControl::CollabStatus {
                request_id,
                ownership,
            }) => {
                if !check_ownership_with_request_id(
                    &mut admitted_ownership,
                    &ownership,
                    &mut stdout,
                    &thread_id,
                    request_id.as_deref(),
                    "collab_status",
                ) {
                    continue;
                }
                let Some(child) = child.as_mut() else {
                    write_blocks_error_with_request_id(
                        &mut stdout,
                        &thread_id,
                        "collab_status",
                        "no resident process",
                        request_id.as_deref(),
                        Some(&ownership),
                    )?;
                    continue;
                };
                let id = resolve_request_id(child, request_id);
                child.send_command(&collab_status_command(&id))?;
                let room = drive_collab_command(
                    child,
                    &id,
                    "collab_status",
                    &mut stdout,
                    &thread_id,
                    &admitted_ownership,
                )?;
                if let Some(room) = room {
                    // Snapshot shape: same room contract as collab/state, plus
                    // state derived from room.active and request_id for wait
                    // correlation. Distinct method (collab/status) so api-rs
                    // can tell a query snapshot from a lifecycle event.
                    let parsed = parse_room_state(&room)?;
                    let api_room = room_state_to_api(&parsed);
                    let state = if parsed.active { "started" } else { "stopped" };
                    let mut value = collab_state_wire_value(state, None, &api_room);
                    value["method"] = Value::String("collab/status".to_owned());
                    if let Some(params) = value.get_mut("params") {
                        params["request_id"] = Value::String(id.clone());
                    }
                    stamp_ownership(&mut value, &admitted_ownership);
                    write_value(&mut stdout, &value)?;
                }
            }
            OmpBlocksInput::Control(OmpBlocksControl::CollabStop {
                request_id,
                ownership,
            }) => {
                if !check_ownership_with_request_id(
                    &mut admitted_ownership,
                    &ownership,
                    &mut stdout,
                    &thread_id,
                    request_id.as_deref(),
                    "collab_stop",
                ) {
                    continue;
                }
                let Some(child) = child.as_mut() else {
                    write_blocks_error_with_request_id(
                        &mut stdout,
                        &thread_id,
                        "collab_stop",
                        "no resident process",
                        request_id.as_deref(),
                        Some(&ownership),
                    )?;
                    continue;
                };
                let id = resolve_request_id(child, request_id);
                child.send_command(&collab_stop_command(&id))?;
                let room = drive_collab_command(
                    child,
                    &id,
                    "collab_stop",
                    &mut stdout,
                    &thread_id,
                    &admitted_ownership,
                )?;
                if let Some(room) = room {
                    emit_collab_state(
                        &mut stdout,
                        "stopped",
                        None,
                        &room,
                        Some(&id),
                        &admitted_ownership,
                    )?;
                }
            }
        }

        // Handle child respawn after a non-reusable turn.
        if respawn_child {
            if let Some(old_child) = child.take() {
                let _ = old_child.wait();
            }
            respawn_child = false;
        }
    }

    // Clean shutdown: close stdin and wait for the process to exit.
    if let Some(child) = child.take() {
        let _ = child.wait();
    }
    Ok(())
}

/// Check ownership against the admitted fence. Returns `false` (and writes a
/// blocks error) when stale or missing.
/// Prefer a caller-supplied request id; otherwise allocate from the child.
fn resolve_request_id(child: &mut OmpRpcChild, supplied: Option<String>) -> String {
    supplied.unwrap_or_else(|| child.next_request_id())
}

#[allow(dead_code)]
fn check_ownership(
    admitted: &mut Option<OmpRpcOwnership>,
    incoming: &OmpRpcOwnership,
    stdout: &mut impl Write,
    thread_id: &str,
) -> bool {
    check_ownership_with_request_id(admitted, incoming, stdout, thread_id, None, "collab")
}

fn check_ownership_with_request_id(
    admitted: &mut Option<OmpRpcOwnership>,
    incoming: &OmpRpcOwnership,
    stdout: &mut impl Write,
    thread_id: &str,
    request_id: Option<&str>,
    command: &str,
) -> bool {
    match admitted {
        Some(admitted) => {
            if !admitted.matches(incoming) {
                // Ownership stamp only for collab-* control rejections.
                // Interrupt ownership rejections keep the prior error shape.
                let own = if command.starts_with("collab") {
                    Some(incoming)
                } else {
                    None
                };
                let _ = write_blocks_error_with_request_id(
                    stdout,
                    thread_id,
                    command,
                    "ownership fence mismatch: stale owner",
                    request_id,
                    own,
                );
                return false;
            }
            true
        }
        None => {
            *admitted = Some(incoming.clone());
            true
        }
    }
}

/// Drive a collab command to its correlated response, draining unsolicited
/// frames in the meantime. Returns the response `data` (room state) on
/// success, `None` at failure (error already written).
fn drive_collab_command(
    child: &mut OmpRpcChild,
    expected_id: &str,
    _command: &str,
    stdout: &mut impl Write,
    thread_id: &str,
    admitted: &Option<OmpRpcOwnership>,
) -> Result<Option<Value>> {
    loop {
        let line = match child.read_line_timeout(Duration::from_secs(30))? {
            Some(line) => line,
            None => continue,
        };
        let frame = OmpRpcFrame::parse_json_line(&line)?;
        match frame {
            OmpRpcFrame::Response {
                id,
                command: resp_command,
                success,
                data,
                error,
                ..
            } if id.as_deref() == Some(expected_id) => {
                if !success {
                    let cmd = resp_command.as_str();
                    let msg = error.unwrap_or_else(|| format!("{cmd} failed"));
                    write_blocks_error_with_request_id(
                        stdout,
                        thread_id,
                        cmd,
                        &msg,
                        Some(expected_id),
                        admitted.as_ref(),
                    )?;
                    return Ok(None);
                }
                return Ok(data);
            }
            OmpRpcFrame::Response { .. } => {}
            OmpRpcFrame::CollabState {
                state,
                reason,
                room,
            } => {
                let parsed = parse_room_state(&room)?;
                let api_room = room_state_to_api(&parsed);
                let mut val = collab_state_wire_value(&state, reason.as_deref(), &api_room);
                stamp_ownership(&mut val, admitted);
                let _ = write_value(stdout, &val);
            }
            OmpRpcFrame::Event(_)
            | OmpRpcFrame::PromptResult { .. }
            | OmpRpcFrame::Ready
            | OmpRpcFrame::Other(_) => {}
        }
    }
}

/// Drive a steer command to its correlated response, draining unsolicited
/// frames (collab_state, agent events) in the meantime. The steer response
/// is an ack; the active turn continues and its events flow through the
/// turn driver's drain loop.
fn drive_omp_steer_response(
    child: &mut OmpRpcChild,
    expected_id: &str,
    stdout: &mut impl Write,
    thread_id: &str,
    admitted: &Option<OmpRpcOwnership>,
) -> Result<()> {
    loop {
        let line = match child.read_line_timeout(Duration::from_secs(30))? {
            Some(line) => line,
            None => continue,
        };
        let frame = OmpRpcFrame::parse_json_line(&line)?;
        match frame {
            OmpRpcFrame::Response {
                id, success, error, ..
            } if id.as_deref() == Some(expected_id) => {
                if !success {
                    let msg = error.unwrap_or_else(|| "steer failed".to_owned());
                    // Normal steer errors unchanged: no ownership stamp.
                    write_blocks_error_with_request_id(
                        stdout,
                        thread_id,
                        "steer",
                        &msg,
                        Some(expected_id),
                        None,
                    )?;
                }
                return Ok(());
            }
            OmpRpcFrame::Response { .. } => {}
            OmpRpcFrame::CollabState {
                state,
                reason,
                room,
            } => {
                let parsed = parse_room_state(&room)?;
                let api_room = room_state_to_api(&parsed);
                let mut val = collab_state_wire_value(&state, reason.as_deref(), &api_room);
                stamp_ownership(&mut val, admitted);
                write_value(stdout, &val)?;
            }
            OmpRpcFrame::Event(_)
            | OmpRpcFrame::PromptResult { .. }
            | OmpRpcFrame::Ready
            | OmpRpcFrame::Other(_) => {}
        }
    }
}

/// Emit a collab/state notification from a raw room JSON value (already
/// parsed and re-projected to the API contract).

/// Stamp admitted ownership into a collab wire value's params so api-rs can
/// require exact ownership match and reject missing echo on all collab outputs.
fn stamp_ownership(value: &mut Value, admitted: &Option<OmpRpcOwnership>) {
    if let Some(own) = admitted
        && let Some(params) = value.get_mut("params")
    {
        params["ownership"] = json!({
            "owner_id": own.owner_id,
            "generation": own.generation,
        });
    }
}

fn emit_collab_state(
    stdout: &mut impl Write,
    state: &str,
    reason: Option<&str>,
    room: &Value,
    request_id: Option<&str>,
    admitted: &Option<OmpRpcOwnership>,
) -> Result<()> {
    let parsed = parse_room_state(room)?;
    let api_room = room_state_to_api(&parsed);
    let mut value = collab_state_wire_value(state, reason, &api_room);
    if let Some(request_id) = request_id
        && let Some(params) = value.get_mut("params")
    {
        params["request_id"] = Value::String(request_id.to_owned());
    }
    stamp_ownership(&mut value, admitted);
    write_value(stdout, &value)
}

fn ownership_from_trace(trace_context: &crate::otel::TraceContext) -> Option<OmpRpcOwnership> {
    let metadata = &trace_context.metadata;
    let owner_id = metadata.get("owner_id").and_then(Value::as_str)?;
    let generation = metadata.get("generation").and_then(Value::as_i64)?;
    Some(OmpRpcOwnership {
        owner_id: owner_id.to_owned(),
        generation,
    })
}

fn drain_ready(child: &mut OmpRpcChild) -> Result<()> {
    loop {
        let line = child.read_line()?;
        let frame = OmpRpcFrame::parse_json_line(&line)?;
        match frame {
            OmpRpcFrame::Ready => return Ok(()),
            OmpRpcFrame::Event(_)
            | OmpRpcFrame::CollabState { .. }
            | OmpRpcFrame::PromptResult { .. }
            | OmpRpcFrame::Other(_) => {}
            OmpRpcFrame::Response { .. } => {}
        }
    }
}

/// Result of driving an OMP turn. `pending` items are returned to the outer
/// loop for FIFO processing. `child_reusable` is false when the child process
/// is in an unrecoverable state (e.g. timeout abort without clean drain).
struct TurnDriveResult {
    pending: std::collections::VecDeque<OmpBlocksInput>,
    child_reusable: bool,
}

fn drive_omp_turn(
    child: &mut OmpRpcChild,
    event_normalizer: &mut crate::omp::OmpEventNormalizer,
    normalizer: &mut CodexTurnNormalizer,
    stdout: &mut impl Write,
    harness_session_id: &mut Option<String>,
    expected_prompt_id: &str,
    turn_id: &str,
    thread_id: &str,
    active_rx: &mpsc::Receiver<OmpBlocksInput>,
    admitted_ownership: &Option<OmpRpcOwnership>,
) -> Result<TurnDriveResult> {
    use crate::omp::OmpHarness;
    use crate::traits::{HarnessServer, NormalizedEvent};

    let mut pending = std::collections::VecDeque::new();
    let mut terminal = false;
    let mut failed = false;
    let mut aborted = false;
    let mut child_reusable = true;
    let mut prompt_error: Option<String> = None;
    // Settle window: arm only after a terminal assistant stop.
    let mut settle_deadline: Option<std::time::Instant> = None;
    let absolute_deadline = std::time::Instant::now() + Duration::from_secs(300);

    while !terminal {
        // #5: check deadlines unconditionally, regardless of frame flow.
        let now = std::time::Instant::now();
        if now >= absolute_deadline {
            eprintln!("omp rpc: absolute turn timeout, terminating");
            let abort_id = child.next_request_id();
            child.send_command(&abort_command(&abort_id))?;
            // #6: drain correlated abort response + agent_end (up to 2s).
            let drain_deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut got_abort_ack = false;
            let mut got_terminal = false;
            while std::time::Instant::now() < drain_deadline {
                match child.read_line_timeout(Duration::from_millis(50))? {
                    Some(line) => {
                        let frame = OmpRpcFrame::parse_json_line(&line)?;
                        match frame {
                            OmpRpcFrame::Response { id, command, .. }
                                if id.as_deref() == Some(abort_id.as_str())
                                    && command == "abort" =>
                            {
                                got_abort_ack = true;
                            }
                            OmpRpcFrame::Event(event) => {
                                let events =
                                    OmpHarness.normalize_events(event_normalizer, event)?;
                                for normalized in events {
                                    // Require Result (agent_end), not Error.
                                    if matches!(&normalized, NormalizedEvent::Result { .. }) {
                                        got_terminal = true;
                                    }
                                    let _ = normalized;
                                }
                            }
                            _ => {}
                        }
                    }
                    None => {}
                }
                if got_abort_ack && got_terminal {
                    break;
                }
            }
            if !got_abort_ack || !got_terminal {
                child_reusable = false;
            }
            failed = true;
            prompt_error = Some("turn timed out".to_string());
            break;
        }
        if let Some(deadline) = settle_deadline
            && now >= deadline
        {
            eprintln!("omp rpc: settle window expired after terminal stop");
            break;
        }

        // #2,#3,#4: drain active_rx with ownership checks, preserve unmatched.
        loop {
            match active_rx.try_recv() {
                Ok(OmpBlocksInput::Command(BlocksCommand::Interrupt)) => {
                    // #3: missing ownership with admitted → surface error.
                    if admitted_ownership.is_some() {
                        write_blocks_error_with_request_id(
                            stdout,
                            thread_id,
                            turn_id,
                            "missing ownership: interrupt requires owner_id + generation",
                            None,
                            None,
                        )?;
                    } else {
                        let id = child.next_request_id();
                        child.send_command(&abort_command(&id))?;
                        aborted = true;
                    }
                }
                Ok(OmpBlocksInput::Control(OmpBlocksControl::Interrupt { ownership, .. })) => {
                    // #3: stale/missing interrupt → surface error.
                    match admitted_ownership {
                        Some(admitted) if admitted.matches(&ownership) => {
                            let id = child.next_request_id();
                            child.send_command(&abort_command(&id))?;
                            aborted = true;
                        }
                        Some(_) => {
                            // Interrupt ownership errors: no ownership stamp.
                            write_blocks_error_with_request_id(
                                stdout,
                                thread_id,
                                turn_id,
                                "ownership fence mismatch: stale owner",
                                None,
                                None,
                            )?;
                        }
                        None => {
                            write_blocks_error_with_request_id(
                                stdout,
                                thread_id,
                                turn_id,
                                "missing ownership: no admitted owner",
                                None,
                                None,
                            )?;
                        }
                    }
                }
                Ok(OmpBlocksInput::Command(BlocksCommand::User {
                    input,
                    trace_context,
                    ..
                })) if trace_context.metadata.get("action").and_then(Value::as_str)
                    == Some("steer_active_execution") =>
                {
                    // #2: exact-check trace ownership before steer.
                    let steer_ownership = ownership_from_trace(&trace_context);
                    let can_steer = match (&admitted_ownership, &steer_ownership) {
                        (Some(admitted), Some(incoming)) => admitted.matches(incoming),
                        (None, _) => true,
                        _ => false,
                    };
                    if can_steer {
                        let steer_msg = prompt_text(&input);
                        if !steer_msg.is_empty() {
                            let id = child.next_request_id();
                            child.send_command(&steer_command(&id, &steer_msg))?;
                        }
                    } else {
                        write_blocks_error_with_request_id(
                            stdout,
                            thread_id,
                            turn_id,
                            "ownership fence mismatch: stale owner",
                            None,
                            None,
                        )?;
                    }
                }
                Ok(other) => {
                    // #4: preserve unmatched in FIFO order.
                    pending.push_back(other);
                }
                Err(_) => break,
            }
        }

        let line = match child.read_line_timeout(Duration::from_millis(50))? {
            Some(line) => line,
            None => continue,
        };
        let frame = OmpRpcFrame::parse_json_line(&line)?;
        match frame {
            OmpRpcFrame::Response {
                id,
                command: _,
                success,
                data,
                error,
            } if id.as_deref() == Some(expected_prompt_id) => {
                if !success {
                    // #8: preserve actual error message across scope.
                    prompt_error = error
                        .filter(|e| !e.is_empty())
                        .or(Some("omp prompt failed".to_string()));
                    write_blocks_error(
                        stdout,
                        thread_id,
                        turn_id,
                        prompt_error.as_deref().unwrap(),
                    )?;
                    failed = true;
                    terminal = true;
                    continue;
                }
                let agent_invoked = data
                    .as_ref()
                    .and_then(|d| d.get("agentInvoked").and_then(Value::as_bool))
                    .unwrap_or(true);
                if !agent_invoked {
                    terminal = true;
                }
            }
            OmpRpcFrame::Response { success, error, .. } => {
                if !success {
                    let msg = error.unwrap_or_else(|| "omp command failed".to_owned());
                    eprintln!("omp rpc command failed: {msg}");
                }
            }
            OmpRpcFrame::Event(event) => {
                let events = OmpHarness.normalize_events(event_normalizer, event)?;
                for normalized in events {
                    if let NormalizedEvent::CollabState {
                        state,
                        reason,
                        room,
                    } = &normalized
                    {
                        let mut val = collab_state_wire_value(state, reason.as_deref(), room);
                        stamp_ownership(&mut val, admitted_ownership);
                        write_value(stdout, &val)?;
                        continue;
                    }
                    if let Some(sid) = normalized.session_id() {
                        *harness_session_id = Some(sid.to_string());
                    }
                    for notification in normalizer.process_event(&normalized)? {
                        write_value(stdout, &notification_to_wire_value(&notification)?)?;
                    }
                    if normalized.is_terminal_assistant_stop() {
                        if settle_deadline.is_none() {
                            settle_deadline =
                                Some(std::time::Instant::now() + Duration::from_secs(5));
                        }
                    }
                    if normalized.is_terminal() {
                        terminal = true;
                    }
                }
            }
            OmpRpcFrame::CollabState {
                state,
                reason,
                room,
            } => {
                let parsed = parse_room_state(&room)?;
                let api_room = room_state_to_api(&parsed);
                let mut val = collab_state_wire_value(&state, reason.as_deref(), &api_room);
                stamp_ownership(&mut val, admitted_ownership);
                write_value(stdout, &val)?;
            }
            OmpRpcFrame::PromptResult { agent_invoked, .. } if !agent_invoked => {
                terminal = true;
            }
            OmpRpcFrame::PromptResult { .. } => {}
            OmpRpcFrame::Ready => {}
            OmpRpcFrame::Other(value) => {
                if let Some(kind) = value.get("type").and_then(Value::as_str) {
                    eprintln!("omp rpc: unsolicited {kind} frame");
                }
            }
        }
    }

    // #7: finish with correct status.
    if aborted && !failed {
        if let Some(notification) = normalizer.finish_turn_interrupted()? {
            write_value(stdout, &notification_to_wire_value(&notification)?)?;
        }
    } else if failed {
        let reason = prompt_error.unwrap_or_else(|| "omp prompt failed".to_string());
        if let Some(notification) = normalizer.finish_turn(Some(reason))? {
            write_value(stdout, &notification_to_wire_value(&notification)?)?;
        }
    } else if let Some(notification) = normalizer.finish_turn(None)? {
        write_value(stdout, &notification_to_wire_value(&notification)?)?;
    }

    Ok(TurnDriveResult {
        pending,
        child_reusable,
    })
}

fn prompt_text(input: &[codex_app_server_protocol::UserInput]) -> String {
    let parts = crate::util::user_input_to_anthropic_content(input);
    parts
        .into_iter()
        .filter_map(|p| p.get("text").and_then(Value::as_str).map(str::to_owned))
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn write_blocks_error(
    stdout: &mut impl Write,
    thread_id: &str,
    turn_id: &str,
    message: &str,
) -> Result<()> {
    write_blocks_error_with_request_id(stdout, thread_id, turn_id, message, None, None)
}

fn write_blocks_error_with_request_id(
    stdout: &mut impl Write,
    thread_id: &str,
    turn_id: &str,
    message: &str,
    request_id: Option<&str>,
    admitted: Option<&OmpRpcOwnership>,
) -> Result<()> {
    let mut params = serde_json::json!({
        "error": { "message": message, "codexErrorInfo": null, "additionalDetails": null },
        "willRetry": false,
        "threadId": thread_id,
        "turnId": turn_id,
    });
    if let Some(rid) = request_id {
        params["request_id"] = Value::String(rid.to_owned());
    }
    if let Some(own) = admitted {
        params["ownership"] = json!({
            "owner_id": own.owner_id,
            "generation": own.generation,
        });
    }
    write_value(
        stdout,
        &serde_json::json!({
            "method": "error",
            "params": params,
        }),
    )
}

fn notification_to_wire_value(
    notification: &codex_app_server_protocol::ServerNotification,
) -> Result<Value> {
    crate::wire::notification_to_wire_value(notification)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::omp::{OmpEventNormalizer, OmpHarness};
    use crate::traits::{HarnessServer, NormalizedEvent};

    // --- Frame demultiplexing ---------------------------------------------

    #[test]
    fn ready_frame_parses() {
        let frame = OmpRpcFrame::parse_json_line(r#"{"type":"ready"}"#).unwrap();
        assert!(matches!(frame, OmpRpcFrame::Ready));
    }

    #[test]
    fn response_frame_correlates_by_id() {
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"id":"req_1","type":"response","command":"prompt","success":true,"data":{"agentInvoked":false}}"#,
        )
        .unwrap();
        match frame {
            OmpRpcFrame::Response {
                id,
                command,
                success,
                data,
                error,
            } => {
                assert_eq!(id.as_deref(), Some("req_1"));
                assert_eq!(command, "prompt");
                assert!(success);
                assert!(error.is_none());
                assert_eq!(
                    data.as_ref()
                        .and_then(|d| d.get("agentInvoked").and_then(Value::as_bool)),
                    Some(false)
                );
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn failed_response_carries_error() {
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"id":"req_2","type":"response","command":"set_model","success":false,"error":"Model not found: provider/model"}"#,
        )
        .unwrap();
        match frame {
            OmpRpcFrame::Response { success, error, .. } => {
                assert!(!success);
                assert_eq!(error.as_deref(), Some("Model not found: provider/model"));
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn response_without_id_is_still_a_response() {
        // Unknown-command responses echo id: undefined on the wire.
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"type":"response","command":"parse","success":false,"error":"unknown command"}"#,
        )
        .unwrap();
        match frame {
            OmpRpcFrame::Response { id, error, .. } => {
                assert!(id.is_none());
                assert_eq!(error.as_deref(), Some("unknown command"));
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[test]
    fn agent_end_frame_routes_through_one_shot_parser() {
        let frame = OmpRpcFrame::parse_json_line(r#"{"type":"agent_end","messages":[]}"#).unwrap();
        match frame {
            OmpRpcFrame::Event(event) => {
                let mut normalizer = OmpEventNormalizer;
                let events = OmpHarness.normalize_events(&mut normalizer, event).unwrap();
                assert!(matches!(
                    events.as_slice(),
                    [NormalizedEvent::Result { error: None }]
                ));
            }
            other => panic!("expected Event, got {other:?}"),
        }
    }

    #[test]
    fn message_update_event_normalizes_text_delta() {
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"ONE"},"message":{"role":"assistant","content":[{"type":"text","text":"DONE"}],"responseId":"msg_011CcnPBnPUWzpXCn7915U1v"}}"#,
        )
        .unwrap();
        match frame {
            OmpRpcFrame::Event(event) => {
                let mut normalizer = OmpEventNormalizer;
                let events = OmpHarness.normalize_events(&mut normalizer, event).unwrap();
                assert!(matches!(
                    events.as_slice(),
                    [NormalizedEvent::AgentTextDelta { item_id, delta }]
                        if item_id == "msg_011CcnPBnPUWzpXCn7915U1v" && delta == "ONE"
                ));
            }
            other => panic!("expected Event, got {other:?}"),
        }
    }

    #[test]
    fn collab_state_frame_demultiplexes_into_lifecycle() {
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"type":"collab_state","state":"started","room":{"active":true,"joinUrl":"relay.example/r/room.key-and-write-token","viewUrl":"relay.example/r/room.key","participants":[{"name":"host","role":"host"}]}}"#,
        )
        .unwrap();
        match frame {
            OmpRpcFrame::CollabState {
                state,
                reason,
                room,
            } => {
                assert_eq!(state, "started");
                assert!(reason.is_none());
                let parsed = parse_room_state(&room).unwrap();
                assert!(parsed.active);
                assert_eq!(
                    parsed.join_url.as_deref(),
                    Some("relay.example/r/room.key-and-write-token")
                );
                assert_eq!(parsed.view_url.as_deref(), Some("relay.example/r/room.key"));
                assert_eq!(parsed.participants.len(), 1);
                assert_eq!(parsed.participants[0].name, "host");
                assert_eq!(parsed.participants[0].role, "host");
            }
            other => panic!("expected CollabState, got {other:?}"),
        }
    }

    #[test]
    fn collab_state_failed_frame_carries_reason() {
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"type":"collab_state","state":"failed","reason":"relay unreachable","room":{"active":false,"participants":[]}}"#,
        )
        .unwrap();
        match frame {
            OmpRpcFrame::CollabState {
                state,
                reason,
                room,
            } => {
                assert_eq!(state, "failed");
                assert_eq!(reason.as_deref(), Some("relay unreachable"));
                let parsed = parse_room_state(&room).unwrap();
                assert!(!parsed.active);
            }
            other => panic!("expected CollabState, got {other:?}"),
        }
    }

    #[test]
    fn prompt_result_frame_demultiplexes() {
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"type":"prompt_result","id":"req_1","agentInvoked":false}"#,
        )
        .unwrap();
        match frame {
            OmpRpcFrame::PromptResult { id, agent_invoked } => {
                assert_eq!(id.as_deref(), Some("req_1"));
                assert!(!agent_invoked);
            }
            other => panic!("expected PromptResult, got {other:?}"),
        }
    }

    #[test]
    fn unknown_frame_degrades_to_other_without_erroring() {
        let frame =
            OmpRpcFrame::parse_json_line(r#"{"type":"available_commands_update","commands":[]}"#)
                .unwrap();
        assert!(matches!(frame, OmpRpcFrame::Other(_)));
    }

    #[test]
    fn host_tool_call_frame_degrades_to_other() {
        let frame = OmpRpcFrame::parse_json_line(
            r#"{"type":"host_tool_call","id":"host_1","toolCallId":"toolu_123","toolName":"echo_host","arguments":{"message":"hi"}}"#,
        )
        .unwrap();
        assert!(matches!(frame, OmpRpcFrame::Other(_)));
    }

    // --- Ownership fence --------------------------------------------------

    #[test]
    fn ownership_matches_same_owner_and_generation() {
        let a = OmpRpcOwnership {
            owner_id: "resident-host".to_string(),
            generation: 3,
        };
        let b = OmpRpcOwnership {
            owner_id: "resident-host".to_string(),
            generation: 3,
        };
        assert!(a.matches(&b));
    }

    #[test]
    fn ownership_rejects_different_owner_same_generation() {
        let a = OmpRpcOwnership {
            owner_id: "resident-host".to_string(),
            generation: 3,
        };
        let b = OmpRpcOwnership {
            owner_id: "resident-other".to_string(),
            generation: 3,
        };
        assert!(!a.matches(&b));
    }

    #[test]
    fn ownership_rejects_stale_generation_after_reacquire() {
        // After a loss/reacquire the generation bumps; the stale owner's
        // fence no longer matches and its commands are rejected.
        let stale = OmpRpcOwnership {
            owner_id: "resident-host".to_string(),
            generation: 2,
        };
        let current = OmpRpcOwnership {
            owner_id: "resident-host".to_string(),
            generation: 3,
        };
        assert!(!stale.matches(&current));
    }

    // --- Command builders -------------------------------------------------

    #[test]
    fn prompt_command_carries_id_and_optional_streaming_behavior() {
        let cmd = prompt_command("req_1", "hello", None);
        assert_eq!(cmd["type"], "prompt");
        assert_eq!(cmd["id"], "req_1");
        assert_eq!(cmd["message"], "hello");
        assert!(cmd.get("streamingBehavior").is_none());

        let cmd = prompt_command("req_1", "more", Some("steer"));
        assert_eq!(cmd["streamingBehavior"], "steer");
    }

    #[test]
    fn steer_command_builds() {
        let cmd = steer_command("req_2", "also include risks");
        assert_eq!(cmd["type"], "steer");
        assert_eq!(cmd["id"], "req_2");
        assert_eq!(cmd["message"], "also include risks");
    }

    #[test]
    fn abort_command_builds() {
        let cmd = abort_command("req_3");
        assert_eq!(cmd["type"], "abort");
        assert_eq!(cmd["id"], "req_3");
    }

    #[test]
    fn collab_commands_build() {
        let start = collab_start_command(
            "c1",
            Some("wss://relay"),
            Some("host"),
            Some("https://collab.example"),
        );
        assert_eq!(start["type"], "collab_start");
        assert_eq!(start["relayUrl"], "wss://relay");
        assert_eq!(start["displayName"], "host");
        assert_eq!(start["webUrl"], "https://collab.example");

        let status = collab_status_command("c2");
        assert_eq!(status["type"], "collab_status");

        let stop = collab_stop_command("c3");
        assert_eq!(stop["type"], "collab_stop");
    }

    // --- Room state parsing and API projection ----------------------------

    #[test]
    fn parse_room_state_accepts_camelcase_wire_keys() {
        let room = serde_json::json!({
            "active": true,
            "joinUrl": "relay.example/r/room.key-and-write-token",
            "viewUrl": "relay.example/r/room.key",
            "webUrl": "https://collab.example/#relay.example/r/room.key-and-write-token",
            "webViewUrl": "https://collab.example/#relay.example/r/room.key",
            "participants": [
                { "name": "host", "role": "host" },
                { "name": "alice", "role": "guest", "readOnly": true }
            ]
        });
        let parsed = parse_room_state(&room).unwrap();
        assert!(parsed.active);
        assert_eq!(
            parsed.join_url.as_deref(),
            Some("relay.example/r/room.key-and-write-token")
        );
        assert_eq!(parsed.view_url.as_deref(), Some("relay.example/r/room.key"));
        assert_eq!(
            parsed.web_url.as_deref(),
            Some("https://collab.example/#relay.example/r/room.key-and-write-token")
        );
        assert_eq!(parsed.participants.len(), 2);
        assert_eq!(parsed.participants[1].role, "guest");
        assert_eq!(parsed.participants[1].read_only, Some(true));
    }

    #[test]
    fn parse_room_state_inactive_with_no_participants() {
        let room = serde_json::json!({ "active": false, "participants": [] });
        let parsed = parse_room_state(&room).unwrap();
        assert!(!parsed.active);
        assert!(parsed.join_url.is_none());
        assert!(parsed.participants.is_empty());
    }

    #[test]
    fn room_state_to_api_uses_snake_case_contract() {
        let room = OmpCollabRoomState {
            active: true,
            join_url: Some("relay.example/r/room.key-and-write-token".to_string()),
            view_url: Some("relay.example/r/room.key".to_string()),
            web_url: Some(
                "https://collab.example/#relay.example/r/room.key-and-write-token".to_string(),
            ),
            web_view_url: None,
            participants: vec![
                OmpCollabParticipant {
                    name: "host".to_string(),
                    role: "host".to_string(),
                    read_only: None,
                },
                OmpCollabParticipant {
                    name: "alice".to_string(),
                    role: "guest".to_string(),
                    read_only: Some(true),
                },
            ],
        };
        let api = room_state_to_api(&room);
        assert_eq!(api["active"], true);
        assert_eq!(api["join_url"], "relay.example/r/room.key-and-write-token");
        assert_eq!(api["view_url"], "relay.example/r/room.key");
        assert_eq!(
            api["web_url"],
            "https://collab.example/#relay.example/r/room.key-and-write-token"
        );
        assert!(api.get("web_view_url").is_none());
        // snake_case contract: no camelCase keys leak through.
        assert!(api.get("joinUrl").is_none());
        assert!(api.get("viewUrl").is_none());
        assert!(api.get("webUrl").is_none());
        assert_eq!(api["participants"][0]["name"], "host");
        assert_eq!(api["participants"][0]["role"], "host");
        assert!(api["participants"][0].get("read_only").is_none());
        assert_eq!(api["participants"][1]["read_only"], true);
    }

    #[test]
    fn room_state_to_api_inactive_omits_optional_urls() {
        let room = OmpCollabRoomState {
            active: false,
            join_url: None,
            view_url: None,
            web_url: None,
            web_view_url: None,
            participants: vec![],
        };
        let api = room_state_to_api(&room);
        assert_eq!(api["active"], false);
        assert!(api.get("join_url").is_none());
        assert!(api.get("view_url").is_none());
        assert_eq!(api["participants"].as_array().unwrap().len(), 0);
    }
}
