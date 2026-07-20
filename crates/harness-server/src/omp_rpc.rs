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

use std::env;
use std::io::{self, BufRead, Write};
use std::process::{Child, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::omp::OmpStreamEvent;
use crate::turn::CodexTurnNormalizer;
use crate::util::write_value;
use crate::{HarnessServerError, Result};

/// The resident session ownership fence. Admission requires both fields; a
/// stale generation (one that no longer matches the current owner) or a
/// missing owner rejects every command and prevents durable frame publication.
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
        // requests and exit cleanly (code 0).
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.flush();
        }
        self.child.wait().map_err(Into::into)
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
    if let Ok(model) = env::var("OMP_MODEL")
        && !model.is_empty()
    {
        command.args(["--model", &model]);
    }
    command
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
) -> Value {
    let mut cmd = json!({ "id": id, "type": "collab_start" });
    if let Some(relay) = relay_url {
        cmd["relayUrl"] = Value::String(relay.to_owned());
    }
    if let Some(name) = display_name {
        cmd["displayName"] = Value::String(name.to_owned());
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
        relay_url: Option<String>,
        display_name: Option<String>,
        ownership: OmpRpcOwnership,
    },
    CollabStatus {
        ownership: OmpRpcOwnership,
    },
    CollabStop {
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
    let ownership = value
        .get("ownership")
        .and_then(|o| {
            let owner_id = o.get("owner_id").and_then(Value::as_str)?;
            let generation = o.get("generation").and_then(Value::as_i64)?;
            Some(OmpRpcOwnership {
                owner_id: owner_id.to_owned(),
                generation,
            })
        })
        .ok_or_else(|| HarnessServerError::InvalidBlocksInput {
            message: "missing ownership (owner_id + generation)".to_string(),
        })?;
    match kind {
        "collab_start" => Ok(Some(OmpBlocksControl::CollabStart {
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
            ownership,
        })),
        "collab_status" => Ok(Some(OmpBlocksControl::CollabStatus { ownership })),
        "collab_stop" => Ok(Some(OmpBlocksControl::CollabStop { ownership })),
        _ => Ok(None),
    }
}

/// The resident OMP blocks server. One `omp --mode rpc` process per owned
/// session, reused across sequential turns. Continuously drains unsolicited
/// session/agent/collaboration lifecycle frames while ordinary commands are
/// correlated by id. Requires current resident ownership on admission and
/// fences stale/missing ownership.
pub fn run_omp_blocks_server() -> Result<()> {
    use crate::omp::{OmpEventNormalizer, OmpHarness};
    use crate::server::{BlocksCommand, BlocksState, parse_blocks_line_with_state};
    use crate::turn::{BridgeConfig, CodexTurnNormalizer};
    use crate::wire::notification_to_wire_value;
    use std::io::{self, BufRead, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Receiver};
    use std::thread;

    let mut stdout = io::stdout().lock();
    let (command_tx, command_rx) = mpsc::channel();
    let (control_tx, control_rx) = mpsc::channel();
    let turn_active = Arc::new(AtomicBool::new(false));

    // stdin reader: separates shared blocks commands (user/interrupt) from
    // OMP-specific control commands (collab_*).
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
                        if control_tx.send(Ok(control)).is_err() {
                            break;
                        }
                        continue;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        // Not an OMP control — may still be a shared command.
                    }
                }
                match parse_blocks_line_with_state(trimmed, &mut blocks_state) {
                    Ok(BlocksCommand::Interrupt) if turn_active.load(Ordering::SeqCst) => {
                        if control_tx
                            .send(Err("interrupt while turn active".to_string()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Ok(command @ BlocksCommand::User { .. }) => {
                        turn_active.store(true, Ordering::SeqCst);
                        if command_tx.send(command).is_err() {
                            break;
                        }
                    }
                    Ok(command) => {
                        if command_tx.send(command).is_err() {
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
    let mut thread_id = format!("omp-{}", uuid::Uuid::new_v4().simple());
    let mut harness_session_id: Option<String> = None;

    while let Ok(input) = command_rx.recv() {
        match input {
            BlocksCommand::User {
                input,
                client_user_message_id,
                model,
                trace_context,
                ..
            } => {
                // Admission: require ownership on first turn. The ownership is
                // carried in trace_metadata (the same path api-rs uses for
                // one-shot generation). A stale or missing fence rejects.
                let ownership = ownership_from_trace(&trace_context);
                if let Some(admitted) = &admitted_ownership
                    && let Some(incoming) = &ownership
                    && !admitted.matches(incoming)
                {
                    write_blocks_error(
                        &mut stdout,
                        &thread_id,
                        "turn",
                        "ownership fence mismatch: stale owner",
                    )?;
                    continue;
                }
                if admitted_ownership.is_none() {
                    if let Some(own) = &ownership {
                        admitted_ownership = Some(own.clone());
                    } else {
                        write_blocks_error(
                            &mut stdout,
                            &thread_id,
                            "turn",
                            "missing ownership: resident host requires owner_id + generation",
                        )?;
                        continue;
                    }
                }

                // Spawn or reuse the resident process.
                if child.is_none() {
                    child = Some(OmpRpcChild::spawn()?);
                    // Drain the ready frame.
                    drain_ready(child.as_mut().unwrap())?;
                }
                let child = child.as_mut().unwrap();

                // Send the prompt and drive the turn to completion.
                let id = child.next_request_id();
                let message = prompt_text(&input);
                child.send_command(&prompt_command(&id, &message, None))?;

                let turn_id = format!("turn-{}", uuid::Uuid::new_v4().simple());
                let mut config = BridgeConfig::new(thread_id.clone(), turn_id.clone());
                config.cli_version = "omp".to_string();
                config.model_provider = "omp".to_string();
                let mut normalizer = CodexTurnNormalizer::new(config);

                // Emit start notifications.
                for notification in normalizer.start_notifications(true)? {
                    write_value(&mut stdout, &notification_to_wire_value(&notification)?)?;
                }
                for notification in
                    normalizer.emit_user_message(client_user_message_id, input.clone())?
                {
                    write_value(&mut stdout, &notification_to_wire_value(&notification)?)?;
                }

                drive_omp_turn(
                    child,
                    &mut event_normalizer,
                    &mut normalizer,
                    &mut stdout,
                    &mut harness_session_id,
                    &thread_id,
                    &turn_id,
                )?;

                turn_active.store(false, Ordering::SeqCst);
            }
            BlocksCommand::Interrupt => {
                if let Some(child) = child.as_mut() {
                    let id = child.next_request_id();
                    child.send_command(&abort_command(&id))?;
                }
            }
            BlocksCommand::AttachmentChunk => {}
        }
    }

    // Clean shutdown: close stdin and wait for the process to exit.
    if let Some(child) = child.take() {
        let _ = child.wait();
    }
    Ok(())
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
            // Unsolicited frames before ready are unlikely but tolerated.
            OmpRpcFrame::Event(_)
            | OmpRpcFrame::CollabState { .. }
            | OmpRpcFrame::PromptResult { .. }
            | OmpRpcFrame::Other(_) => {}
            OmpRpcFrame::Response { .. } => {}
        }
    }
}

fn drive_omp_turn(
    child: &mut OmpRpcChild,
    event_normalizer: &mut crate::omp::OmpEventNormalizer,
    normalizer: &mut CodexTurnNormalizer,
    stdout: &mut impl Write,
    harness_session_id: &mut Option<String>,
    thread_id: &str,
    turn_id: &str,
) -> Result<()> {
    use crate::omp::OmpHarness;
    use crate::traits::{HarnessServer, NormalizedEvent};
    use crate::wire::collab_state_wire_value;

    let mut terminal = false;
    let mut pending_response_id: Option<String> = None;
    while !terminal {
        let line = match child.read_line_timeout(std::time::Duration::from_millis(50))? {
            Some(line) => line,
            None => continue,
        };
        let frame = OmpRpcFrame::parse_json_line(&line)?;
        match frame {
            OmpRpcFrame::Response {
                id, success, error, ..
            } => {
                if !success {
                    let msg = error.unwrap_or_else(|| "omp command failed".to_owned());
                    eprintln!("omp rpc command failed: {msg}");
                }
                // The prompt response is an ack; the turn completes on agent_end.
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
                        write_value(
                            stdout,
                            &collab_state_wire_value(state, reason.as_deref(), room),
                        )?;
                        continue;
                    }
                    if let Some(sid) = normalized.session_id() {
                        *harness_session_id = Some(sid.to_string());
                    }
                    for notification in normalizer.process_event(&normalized)? {
                        write_value(stdout, &notification_to_wire_value_pub(&notification)?)?;
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
                write_value(
                    stdout,
                    &collab_state_wire_value(&state, reason.as_deref(), &api_room),
                )?;
            }
            OmpRpcFrame::PromptResult { .. } => {
                // Local-only prompt completion hint; the turn is already done.
            }
            OmpRpcFrame::Ready => {
                // Unexpected re-ready; ignore.
            }
            OmpRpcFrame::Other(value) => {
                // Log unsolicited non-event frames (host_tool_call, extension_error, etc.).
                if let Some(kind) = value.get("type").and_then(Value::as_str) {
                    eprintln!("omp rpc: unsolicited {kind} frame");
                }
            }
        }
    }

    // Finish the turn.
    if let Some(notification) = normalizer.finish_turn(None)? {
        write_value(stdout, &notification_to_wire_value_pub(&notification)?)?;
    }
    Ok(())
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
    write_value(
        stdout,
        &serde_json::json!({
            "method": "error",
            "params": {
                "error": { "message": message, "codexErrorInfo": null, "additionalDetails": null },
                "willRetry": false,
                "threadId": thread_id,
                "turnId": turn_id,
            },
        }),
    )
}

// Re-export the wire helper for use in the turn driver without importing
// the private server module.
fn notification_to_wire_value_pub(
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
        let start = collab_start_command("c1", Some("wss://relay"), Some("host"));
        assert_eq!(start["type"], "collab_start");
        assert_eq!(start["relayUrl"], "wss://relay");
        assert_eq!(start["displayName"], "host");

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
