//! OMP harness: drives `omp --mode rpc --no-ui`, OMP's long-lived JSONL protocol.
//!
//! Thinking streams as it arrives; text renders from `message_end`, because only
//! then is it known whether it is commentary or the final answer.
//!
//! One process serves the thread across turns. A `prompt` ends on `prompt_result`,
//! or on `session_settled` when background work still owes a follow-up. OMP saves
//! the session in a per-thread directory, so a respawn after an interrupt, crash,
//! or model switch resumes the conversation.
//!
//! OMP reads provider API keys from the environment, where the sandbox holds
//! iron-proxy placeholders that the proxy replaces on the wire.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::pi::{command_line, message_text, thinking_level, token_usage, tool_result};
use crate::protocol::UserInput;
use crate::{
    HarnessChild, HarnessKind, HarnessServer, HarnessServerError, InterruptOutcome,
    NormalizedContent, NormalizedEvent, NormalizedToolResult, Result, StdoutLimits, ThreadState,
    TurnHold,
};

/// Budget for `ready` after spawn. A cold start loads a large binary and, in a
/// fresh home, unpacks its native modules first.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(180);
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// Budget for OMP to acknowledge a written prompt (`response` or
/// `prompt_result`); a run that never acknowledges is stuck.
const PROMPT_ACK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long an aborted turn gets to settle before its process is replaced.
const ABORT_GRACE: Duration = Duration::from_secs(5);
/// Physical stdout lines: 1 MiB of JSON plus framing slack. Larger frames
/// arrive as `rpc_chunk` groups.
const MAX_FRAME_BYTES: usize = 1024 * 1024 + 1024;
/// Live events buffered between the reader thread and the turn loop.
const EVENT_QUEUE_DEPTH: usize = 256;
const MAX_REASSEMBLED_BYTES: usize = 64 * 1024 * 1024;
const CHUNK_BYTES: usize = 256 * 1024;
/// Bound on any single rendered text payload (command output, notice).
const MAX_RENDERED_TEXT_BYTES: usize = 1024 * 1024;
/// A level that leaves each session's saved thinking level alone.
const INHERIT_THINKING_LEVEL: &str = "inherit";
/// Thread-level model provider before any turn names one. Bare models then
/// resolve their provider from the session instead.
const NO_MODEL_PROVIDER: &str = "omp";

#[derive(Debug, Default)]
pub struct OmpHarness;

#[derive(Debug)]
pub struct OmpEventNormalizer {
    chunks: Option<PendingChunks>,
    /// Reassembly ceiling advertised by OMP's `ready` frame.
    max_reassembled: usize,
    waiting_for_settle: bool,
    /// Reasoning items opened by streamed thinking, closed by their message's end.
    streamed_reasoning: Vec<String>,
    /// Command output that arrived before the turn showed whether it invokes
    /// the agent: local-only output renders as the answer, agent output as a
    /// tool call.
    pending_command_output: String,
    agent_started: bool,
    command_output_items: usize,
    /// Failure reported while the run was still going (extension error, error
    /// notice). It fails the turn at the run's own settlement instead of
    /// ending it early and leaving OMP's output to feed the next turn.
    deferred_error: Option<String>,
    /// The run in flight cannot hand its session to the next turn: end the
    /// turn and replace the process (failed prompt/steer, persistence failure).
    process_must_restart: bool,
    /// OMP acknowledged the prompt in flight.
    acknowledged: bool,
}

impl Default for OmpEventNormalizer {
    fn default() -> Self {
        Self {
            chunks: None,
            max_reassembled: MAX_REASSEMBLED_BYTES,
            waiting_for_settle: false,
            streamed_reasoning: Vec::new(),
            pending_command_output: String::new(),
            agent_started: false,
            command_output_items: 0,
            deferred_error: None,
            process_must_restart: false,
            acknowledged: false,
        }
    }
}

impl HarnessServer for OmpHarness {
    type Event = Value;
    type EventNormalizer = OmpEventNormalizer;

    fn kind(&self) -> HarnessKind {
        HarnessKind::Omp
    }
    fn cli_version(&self) -> &'static str {
        "omp"
    }
    fn default_model(&self) -> String {
        env::var("OMP_MODEL").unwrap_or_default()
    }
    fn default_model_provider(&self) -> &'static str {
        NO_MODEL_PROVIDER
    }

    fn command_for_turn(&self, _state: &ThreadState, _input: &[UserInput]) -> ProcessCommand {
        let bin = env::var("OMP_BIN").unwrap_or_else(|_| "omp".to_string());
        let mut command = ProcessCommand::new(bin);
        command.args(["--mode", "rpc", "--no-ui"]);
        // harness-server reports this turn's telemetry; OMP would otherwise
        // export its own duplicate spans to the sandbox's OTLP endpoint.
        command.env("OTEL_SDK_DISABLED", "true");
        command
    }

    fn on_process_start(&self, state: &ThreadState, process: &mut HarnessChild) -> Result<()> {
        let dir = session_dir(state);
        fs::create_dir_all(&dir)?;
        let mut normalizer = OmpEventNormalizer::default();
        await_ready(process, &mut normalizer)?;

        let mut command = |kind: &str, fields: Value| -> Result<Value> {
            let response = startup_command(process, &mut normalizer, kind, fields)?;
            if response["success"] != true {
                let error = response["error"].as_str().unwrap_or("command failed");
                // open_session and set_model check a requested model the same
                // way, so both report an unavailable model here.
                if matches!(kind, "open_session" | "set_model")
                    && error.starts_with("Model not found:")
                {
                    return Err(HarnessServerError::UnknownModel {
                        message: format!("unsupported model `{}` for OMP: {error}", state.model),
                    });
                }
                return Err(protocol_error(format!("{kind}: {error}")));
            }
            Ok(response["data"].clone())
        };

        let negotiated = command("negotiate_protocol", json!({"protocolVersion": 2}))?;
        if negotiated["protocolVersion"] != 2 {
            return Err(protocol_error(
                "negotiate_protocol: expected protocolVersion 2",
            ));
        }
        // `command_output`, `notice`, `prompt_result`, and `session_settled`
        // are not session events and arrive regardless of this filter.
        command(
            "set_event_filter",
            json!({"events": ["agent_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end"], "messageUpdates": "delta"}),
        )?;
        // OMP resumes the session on its saved model, and refuses to when that
        // model is no longer available, so the turn's model goes in the same
        // call when it names its own provider.
        let requested = requested_model(state);
        let mut open = json!({"sessionDir": dir});
        if let Some((provider, model_id)) = requested.as_ref() {
            open["provider"] = json!(provider);
            open["modelId"] = json!(model_id);
        }
        let opened = command("open_session", open)?;
        if opened["cancelled"] == true {
            return Err(protocol_error("open_session: cancelled"));
        }
        // A bare model id inherits the provider of whichever model the resumed
        // session restored, exactly as it does when applied with set_model.
        if requested.is_none() && !state.model.is_empty() {
            let restored = command("get_state", json!({}))?;
            let provider = restored["model"]["provider"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            command(
                "set_model",
                json!({"provider": provider, "modelId": state.model}),
            )?;
        }
        // A respawned process inherits the session's saved thinking level, so
        // an explicit level from an earlier turn would otherwise leak into a
        // turn that names none. Per-turn effort still overrides this.
        command(
            "set_thinking_level",
            json!({"level": INHERIT_THINKING_LEVEL}),
        )?;
        command("set_cache_warming", json!({"mode": "off"}))?;
        Ok(())
    }

    /// The model is bound when the session is opened, so the next turn's model
    /// needs a new process over the same session directory.
    fn restart_on_model_change(&self) -> bool {
        true
    }

    /// The blocks protocol names the provider beside a bare model id, which
    /// OMP's `open_session` takes as its own field.
    fn accepts_provider_override(&self) -> bool {
        true
    }

    /// Accepts a bare `modelId` or `provider/modelId`; OMP reports an unknown
    /// model itself when the session opens.
    fn validate_model(&self, model: &str) -> std::result::Result<(), String> {
        let shaped = !model.is_empty()
            && !model.chars().any(char::is_whitespace)
            && (!model.contains('/') || split_model(model).is_some());
        shaped.then_some(()).ok_or_else(|| {
            format!("unsupported model `{model}` for OMP: expected `modelId` or `provider/modelId`")
        })
    }

    fn stdin_for_turn(&self, input: &[UserInput]) -> Result<Vec<u8>> {
        prompt_command("prompt", input)
    }
    fn stdin_for_steer(&self, input: &[UserInput]) -> Result<Vec<u8>> {
        prompt_command("steer", input)
    }

    fn reasoning_effort(&self, requested: &str) -> Option<String> {
        if let Some(level) = thinking_level(requested) {
            return Some(level.to_string());
        }
        eprintln!("ignoring unsupported OMP thinking level {requested:?}");
        None
    }

    /// The level is saved in the session, so a turn without an override
    /// restores the configured default instead of inheriting the last turn's.
    fn stdin_for_reasoning_effort(&self, effort: Option<&str>) -> Result<Vec<u8>> {
        command_line(json!({
            "type": "set_thinking_level",
            "level": effort.unwrap_or(INHERIT_THINKING_LEVEL),
        }))
    }

    /// An abort settles the turn in-band, so the process and its session stay
    /// live; only an unsettled background turn needs a fresh process.
    ///
    /// Retention needs this abort's own `prompt_result`: OMP emits a trailing
    /// `session_settled` after the previous stretch's result, and that stale
    /// frame must not keep a process whose aborted run is still in flight.
    fn interrupt_turn(&self, process: &mut HarnessChild) -> Result<InterruptOutcome> {
        process
            .stdin
            .write_all(&command_line(json!({"type": "abort"}))?)?;
        process.stdin.flush()?;
        let deadline = Instant::now() + ABORT_GRACE;
        let mut saw_aborted_result = false;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                process.kill_and_wait()?;
                return Ok(InterruptOutcome::Restart);
            }
            match process.stdout.recv_timeout(remaining) {
                Ok(Ok(line)) => {
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let frame: Value = match serde_json::from_str(trimmed) {
                        Ok(frame) => frame,
                        // The turn is being finished either way; a frame this
                        // process already garbled cannot be reported anywhere.
                        Err(_) => continue,
                    };
                    match frame["type"].as_str() {
                        Some("prompt_result") if frame["status"].as_str() == Some("aborted") => {
                            if frame["sessionSettled"] != false {
                                return Ok(InterruptOutcome::Retain);
                            }
                            saw_aborted_result = true;
                        }
                        // Only this abort's settlement can keep the process.
                        Some("session_settled") if saw_aborted_result => {
                            return Ok(InterruptOutcome::Retain);
                        }
                        _ => {}
                    }
                }
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => {
                    process.kill_and_wait()?;
                    return Ok(InterruptOutcome::Restart);
                }
            }
        }
    }

    /// A prompt OMP never acknowledges is a stuck run: fail the turn (which
    /// replaces the process) instead of waiting for a result that is not
    /// coming.
    fn prompt_ack_timeout(&self) -> Option<Duration> {
        Some(PROMPT_ACK_TIMEOUT)
    }

    fn prompt_acknowledged(&self, normalizer: &OmpEventNormalizer) -> bool {
        normalizer.acknowledged
    }

    /// OMP stderr can carry provider responses and authorization failures;
    /// keep it out of pod logs and report only its size.
    fn redact_stderr(&self) -> bool {
        true
    }

    /// Bounded frames and a bounded queue: a noisy child cannot grow the
    /// server's memory, and an oversized frame is a protocol error.
    fn stdout_limits(&self) -> Option<StdoutLimits> {
        Some(StdoutLimits {
            max_line_bytes: MAX_FRAME_BYTES,
            queue_depth: EVENT_QUEUE_DEPTH,
        })
    }

    fn parse_stdout_line(&self, line: &str) -> Result<Value> {
        Ok(serde_json::from_str(line)?)
    }

    fn normalize_events(
        &self,
        normalizer: &mut OmpEventNormalizer,
        event: Value,
    ) -> Result<Vec<NormalizedEvent>> {
        normalizer.normalize(event)
    }

    fn turn_hold(&self, normalizer: &OmpEventNormalizer) -> TurnHold {
        // Background work still owes output, or the run in flight must not be
        // handed to the next turn: either way the process is replaced with the
        // turn's end.
        if normalizer.waiting_for_settle || normalizer.process_must_restart {
            TurnHold::Waiting
        } else {
            TurnHold::Released
        }
    }
}

/// The per-thread native session directory: `CENTAUR_OMP_SESSION_ROOT`, else
/// `~/.omp/centaur-sessions`, then the SHA-256 of the Centaur thread key (or
/// the thread id when no key is known). The hash keeps arbitrary thread keys —
/// `slack:C123:123.456` — a single portable path segment, and addresses the
/// sessions written by earlier releases.
fn session_dir(state: &ThreadState) -> PathBuf {
    let root = env::var_os("CENTAUR_OMP_SESSION_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| state.cwd.clone())
                .join(".omp/centaur-sessions")
        });
    let key = state.thread_key.as_deref().unwrap_or(&state.id);
    let digest: [u8; 32] = Sha256::digest(key.as_bytes()).into();
    let mut name = String::with_capacity(64);
    for byte in digest {
        let _ = write!(name, "{byte:02x}");
    }
    root.join(name)
}

/// The provider and model id the session opens on, when the turn names both.
/// A bare model id with no provider of its own is applied after the session
/// restores its saved model, whose provider is then kept.
fn requested_model(state: &ThreadState) -> Option<(&str, &str)> {
    if state.model.is_empty() {
        return None;
    }
    if let Some((provider, model_id)) = split_model(&state.model) {
        return Some((provider, model_id));
    }
    let provider = state.model_provider.trim();
    (!provider.is_empty() && provider != NO_MODEL_PROVIDER)
        .then_some((provider, state.model.as_str()))
}

fn await_ready(process: &mut HarnessChild, normalizer: &mut OmpEventNormalizer) -> Result<()> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(protocol_error("ready frame timed out"));
        }
        let line = process
            .stdout
            .recv_timeout(remaining)
            .map_err(|error| protocol_error(format!("ready frame failed: {error}")))??;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(frame) = normalizer.frame(serde_json::from_str(trimmed)?)? else {
            continue;
        };
        if frame["type"] == "ready" {
            return Ok(());
        }
    }
}

fn startup_command(
    process: &mut HarnessChild,
    normalizer: &mut OmpEventNormalizer,
    kind: &str,
    mut fields: Value,
) -> Result<Value> {
    let id = format!("centaur-{kind}");
    fields["id"] = json!(id);
    fields["type"] = json!(kind);
    process.stdin.write_all(&command_line(fields)?)?;
    process.stdin.flush()?;
    let deadline = Instant::now() + COMMAND_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(protocol_error(format!("{kind} acknowledgement timed out")));
        }
        let line = process
            .stdout
            .recv_timeout(remaining)
            .map_err(|error| protocol_error(format!("{kind} acknowledgement failed: {error}")))??;
        if line.trim().is_empty() {
            continue;
        }
        let Some(frame) = normalizer.frame(serde_json::from_str(line.trim())?)? else {
            continue;
        };
        if frame["type"] == "response" && frame["id"] == id && frame["command"] == kind {
            return Ok(frame);
        }
    }
}

impl OmpEventNormalizer {
    fn normalize(&mut self, event: Value) -> Result<Vec<NormalizedEvent>> {
        let Some(event) = self.frame(event)? else {
            return Ok(Vec::new());
        };
        let kind = event["type"].as_str().unwrap_or_default();
        if let Some(host_request) = host_request_kind(kind) {
            return Err(protocol_error(format!(
                "unexpected OMP host request {host_request}"
            )));
        }
        Ok(match kind {
            "response" => self.response(&event),
            "message_update" if event["assistantMessageEvent"]["type"] == "thinking_delta" => {
                let update = &event["assistantMessageEvent"];
                let message_id = event["messageId"].as_str().unwrap_or_default();
                let index = update["contentIndex"].as_u64().unwrap_or_default();
                let item_id = format!("omp-{message_id}-{index}");
                if !self.streamed_reasoning.contains(&item_id) {
                    self.streamed_reasoning.push(item_id.clone());
                }
                vec![NormalizedEvent::ReasoningTextDelta {
                    item_id,
                    delta: update["delta"].as_str().unwrap_or_default().to_string(),
                }]
            }
            "message_end" if event["message"]["role"] == "assistant" => {
                self.agent_started = true;
                let mut events = self.flush_command_output(false);
                events.extend(self.assistant_message(&event));
                events
            }
            // The agent has started, so buffered command output belongs to a
            // turn that invokes it: render it as a tool call, before the first
            // model item.
            "agent_start" | "tool_execution_start" => {
                self.agent_started = true;
                let mut events = self.flush_command_output(false);
                if kind == "tool_execution_start" {
                    events.push(NormalizedEvent::AssistantMessage {
                        partial: false,
                        stop_reason: None,
                        content: vec![NormalizedContent::ToolUse {
                            raw_id: event["toolCallId"].as_str().unwrap_or_default().to_string(),
                            tool: event["toolName"].as_str().unwrap_or_default().to_string(),
                            arguments: event["args"].clone(),
                        }],
                    });
                }
                events
            }
            "tool_execution_end" => {
                let mut events = self.flush_command_output(false);
                events.push(NormalizedEvent::ToolResults(vec![NormalizedToolResult {
                    exit_code: event["result"]["details"]["exitCode"]
                        .as_i64()
                        .and_then(|code| i32::try_from(code).ok()),
                    ..tool_result(&event)
                }]));
                events
            }
            "command_output" => {
                let text = event["text"]
                    .as_str()
                    .ok_or_else(|| protocol_error("command_output omitted its text field"))?;
                if self.agent_started {
                    return Ok(self.command_output(text, false));
                }
                if self.pending_command_output.len().saturating_add(text.len())
                    > MAX_RENDERED_TEXT_BYTES
                {
                    return Err(protocol_error(
                        "pending OMP command output exceeds its size limit",
                    ));
                }
                self.pending_command_output.push_str(text);
                Vec::new()
            }
            "notice" => {
                if event["level"].as_str() != Some("error") {
                    return Ok(Vec::new());
                }
                if event["source"].as_str() == Some("session-persistence") {
                    // Fatal and unrecoverable: the session cannot be handed to
                    // the next turn, so fail now (the turn error replaces the
                    // process) rather than wait for a settlement that may
                    // never persist.
                    return Err(protocol_error("session persistence failed"));
                }
                let message = event["message"]
                    .as_str()
                    .map(bounded_text)
                    .unwrap_or_else(|| "OMP reported an error notice".to_string());
                self.defer_error(message);
                Vec::new()
            }
            "extension_error" => {
                let message = event["message"]
                    .as_str()
                    .or_else(|| event["error"].as_str())
                    .map(bounded_text)
                    .unwrap_or_else(|| "OMP extension error".to_string());
                self.defer_error(message);
                Vec::new()
            }
            "prompt_result" => {
                self.acknowledged = true;
                let agent_invoked = event["agentInvoked"] == true;
                let mut events = self.flush_command_output(!agent_invoked);
                self.waiting_for_settle = event["sessionSettled"] == false;
                let error = match event["status"].as_str() {
                    Some("completed") => None,
                    Some("error") => Some(
                        event["error"]["message"]
                            .as_str()
                            .unwrap_or("OMP prompt failed")
                            .to_string(),
                    ),
                    Some("aborted") => Some("OMP prompt aborted".to_string()),
                    _ => Some(format!(
                        "OMP prompt failed: unknown status {}",
                        event["status"]
                    )),
                };
                // A run that still owes background output settles later; a
                // deferred failure waits for that settlement too, so the turn
                // ends only once nothing of this run can reach the next one.
                if self.waiting_for_settle && (error.is_none() || self.deferred_error.is_some()) {
                    return Ok(events);
                }
                events.push(self.settled(error));
                events
            }
            "session_settled" if self.waiting_for_settle => {
                self.waiting_for_settle = false;
                vec![self.settled(None)]
            }
            _ => Vec::new(),
        })
    }

    fn response(&mut self, event: &Value) -> Vec<NormalizedEvent> {
        let command = event["command"].as_str().unwrap_or_default();
        if command == "prompt" {
            self.acknowledged = true;
        }
        if event["success"] == false {
            let error = event["error"].as_str().unwrap_or("command failed");
            match command {
                // A rejected prompt never started a run, so the process can
                // stay. A failed steer or abort leaves the run going with no
                // way to steer it: end the turn and replace the process so
                // none of that run's output reaches the next turn.
                "prompt" | "parse" => {
                    return vec![NormalizedEvent::Error {
                        message: format!("omp {command}: {error}"),
                    }];
                }
                "steer" | "abort" => {
                    self.process_must_restart = true;
                    return vec![NormalizedEvent::Error {
                        message: format!("omp {command}: {error}"),
                    }];
                }
                _ => eprintln!("omp {command} failed: {error}"),
            }
        } else if command == "prompt" && event["data"]["agentInvoked"] == false {
            // Handled locally (a slash command, extension, or empty input):
            // no prompt_result follows, so the turn ends here and its output
            // is the answer.
            let mut events = self.flush_command_output(true);
            events.push(self.settled(None));
            return events;
        }
        Vec::new()
    }

    fn assistant_message(&mut self, event: &Value) -> Vec<NormalizedEvent> {
        let message = &event["message"];
        let mut out = vec![NormalizedEvent::TokenUsage {
            usage: token_usage(message),
        }];
        let streamed = std::mem::take(&mut self.streamed_reasoning);
        let stop_reason = message["stopReason"].as_str().unwrap_or_default();
        if matches!(stop_reason, "error" | "aborted") {
            // A failed attempt renders nothing new, but thinking it already
            // streamed still completes, with the text it streamed.
            if !streamed.is_empty() {
                out.push(NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason: None,
                    content: streamed
                        .into_iter()
                        .map(|item_id| NormalizedContent::ReasoningText {
                            item_id,
                            text: String::new(),
                        })
                        .collect(),
                });
            }
            return out;
        }
        let stop_reason = match stop_reason {
            "toolUse" => Some("tool_use".to_string()),
            "stop" => Some("end_turn".to_string()),
            _ => None,
        };
        let message_id = event["messageId"].as_str().unwrap_or_default();
        let mut content = Vec::new();
        for (index, block) in message["content"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let item_id = format!("omp-{message_id}-{index}");
            match block["type"].as_str() {
                Some("text") => {
                    let text = block["text"].as_str().unwrap_or_default().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    out.push(NormalizedEvent::AgentMessageStarted {
                        item_id: item_id.clone(),
                        stop_reason: stop_reason.clone(),
                    });
                    content.push(NormalizedContent::AgentText { item_id, text });
                }
                Some("thinking") => content.push(NormalizedContent::ReasoningText {
                    item_id,
                    text: block["thinking"].as_str().unwrap_or_default().to_string(),
                }),
                _ => {}
            }
        }
        out.push(NormalizedEvent::AssistantMessage {
            partial: false,
            stop_reason,
            content,
        });
        out
    }

    /// Records a failure reported mid-run. The first one stands: it is the
    /// cause of the failing turn, and later frames of the same run add nothing.
    fn defer_error(&mut self, message: String) {
        if self.deferred_error.is_none() {
            self.deferred_error = Some(message);
        }
    }

    /// The terminal event for the run: a deferred failure outranks the run's
    /// own result, because the run is not trustworthy even if it completed.
    fn settled(&mut self, result_error: Option<String>) -> NormalizedEvent {
        match self.deferred_error.take() {
            Some(message) => NormalizedEvent::Error { message },
            None => NormalizedEvent::Result {
                error: result_error,
            },
        }
    }

    /// Renders buffered command output, as the turn's answer when nothing
    /// invoked the agent and as a tool call otherwise.
    fn flush_command_output(&mut self, local_only: bool) -> Vec<NormalizedEvent> {
        let output = std::mem::take(&mut self.pending_command_output);
        self.command_output(&output, local_only)
    }

    fn command_output(&mut self, output: &str, local_only: bool) -> Vec<NormalizedEvent> {
        if output.is_empty() {
            return Vec::new();
        }
        self.command_output_items += 1;
        let item_id = format!("omp-command-output-{}", self.command_output_items);
        let output = bounded_text(output);
        if local_only {
            vec![
                NormalizedEvent::AgentMessageStarted {
                    item_id: item_id.clone(),
                    stop_reason: Some("end_turn".to_string()),
                },
                NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason: Some("end_turn".to_string()),
                    content: vec![NormalizedContent::AgentText {
                        item_id,
                        text: output,
                    }],
                },
            ]
        } else {
            vec![
                NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason: Some("tool_use".to_string()),
                    content: vec![NormalizedContent::ToolUse {
                        raw_id: item_id.clone(),
                        tool: "omp_command".to_string(),
                        arguments: Value::Null,
                    }],
                },
                NormalizedEvent::ToolResults(vec![NormalizedToolResult {
                    tool_use_id: item_id,
                    content: output,
                    is_error: false,
                    exit_code: None,
                }]),
            ]
        }
    }

    /// Mirrors OMP v18.8.6 packages/coding-agent/src/modes/rpc/rpc-frame.ts:
    /// one contiguous base64 chunk group, bounded size, exact metadata and JSON.
    fn frame(&mut self, frame: Value) -> Result<Option<Value>> {
        if frame["type"] != "rpc_chunk" {
            if self.chunks.is_some() {
                return Err(protocol_error("rpc_chunk sequence interrupted"));
            }
            if !frame.is_object() {
                return Err(protocol_error("frame must be an object"));
            }
            if frame["type"] == "ready" {
                self.max_reassembled = ready_reassembly_limit(&frame)?;
            }
            return Ok(Some(frame));
        }
        let chunk: Chunk = serde_json::from_value(frame)?;
        if chunk.chunk_id.is_empty()
            || chunk.chunk_id.len() > 128
            || chunk.count < 2
            || chunk.count > self.max_reassembled / CHUNK_BYTES
            || chunk.index >= chunk.count
            || chunk.byte_length < 1024 * 1024
            || chunk.byte_length > self.max_reassembled
        {
            return Err(protocol_error("invalid rpc_chunk metadata"));
        }
        if self.chunks.is_none() {
            if chunk.index != 0 {
                return Err(protocol_error("rpc_chunk sequence must start at index 0"));
            }
            self.chunks = Some(PendingChunks {
                chunk_id: chunk.chunk_id,
                next_index: 0,
                count: chunk.count,
                byte_length: chunk.byte_length,
                // decode_vec may reserve two padding bytes beyond the result.
                bytes: Vec::with_capacity(chunk.byte_length + 3),
            });
        } else if self.chunks.as_ref().is_some_and(|pending| {
            pending.chunk_id != chunk.chunk_id
                || pending.next_index != chunk.index
                || pending.count != chunk.count
                || pending.byte_length != chunk.byte_length
        }) {
            return Err(protocol_error("rpc_chunk sequence mismatch"));
        }
        let pending = self.chunks.as_mut().expect("chunk sequence initialized");
        if chunk.data.is_empty() || chunk.data.len() > CHUNK_BYTES.div_ceil(3) * 4 {
            return Err(protocol_error("invalid rpc_chunk data length"));
        }
        let before = pending.bytes.len();
        BASE64_STANDARD
            .decode_vec(&chunk.data, &mut pending.bytes)
            .map_err(|_| protocol_error("invalid rpc_chunk base64"))?;
        if pending.bytes.len() - before > CHUNK_BYTES || pending.bytes.len() > pending.byte_length {
            return Err(protocol_error("rpc_chunk exceeds declared length"));
        }
        pending.next_index += 1;
        if pending.next_index < pending.count {
            return Ok(None);
        }
        let pending = self.chunks.take().expect("chunk sequence initialized");
        if pending.bytes.len() != pending.byte_length {
            return Err(protocol_error("rpc_chunk byteLength mismatch"));
        }
        let text = std::str::from_utf8(&pending.bytes)
            .map_err(|_| protocol_error("rpc_chunk is not strict UTF-8"))?;
        let frame: Value = serde_json::from_str(text)?;
        if !frame.is_object() {
            return Err(protocol_error("rpc_chunk must contain an object"));
        }
        Ok(Some(frame))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    chunk_id: String,
    index: usize,
    count: usize,
    byte_length: usize,
    data: String,
}

#[derive(Debug)]
struct PendingChunks {
    chunk_id: String,
    next_index: usize,
    count: usize,
    byte_length: usize,
    bytes: Vec<u8>,
}

/// Validates `ready`: the harness drives protocol v2 only, and the advertised
/// reassembly ceiling must stay within what this process will allocate.
fn ready_reassembly_limit(frame: &Value) -> Result<usize> {
    if !frame["supportedProtocolVersions"]
        .as_array()
        .is_some_and(|versions| versions.iter().any(|version| version.as_u64() == Some(2)))
    {
        return Err(protocol_error(
            "RPC protocol v2 unavailable: the omp harness requires omp >= 18.3.1",
        ));
    }
    frame["maxReassembledFrameBytes"]
        .as_u64()
        .and_then(|limit| usize::try_from(limit).ok())
        .filter(|limit| *limit > 0 && *limit <= MAX_REASSEMBLED_BYTES)
        .ok_or_else(|| protocol_error("invalid maxReassembledFrameBytes"))
}

fn host_request_kind(kind: &str) -> Option<&str> {
    matches!(
        kind,
        "extension_ui_request"
            | "extension_ui_cancel"
            | "host_tool_call"
            | "host_tool_cancel"
            | "host_uri_request"
            | "host_uri_cancel"
    )
    .then_some(kind)
}

fn protocol_error(message: impl std::fmt::Display) -> HarnessServerError {
    HarnessServerError::Protocol(format!("omp {message}"))
}

fn split_model(model: &str) -> Option<(&str, &str)> {
    let (provider, id) = model.split_once('/')?;
    (!provider.is_empty() && !id.is_empty() && !model.chars().any(char::is_whitespace))
        .then_some((provider, id))
}

fn prompt_command(kind: &str, input: &[UserInput]) -> Result<Vec<u8>> {
    let mut command = json!({"type": kind, "message": message_text(input)});
    let images: Vec<Value> = input.iter().filter_map(image).collect();
    if !images.is_empty() {
        command["images"] = Value::Array(images);
    }
    command_line(command)
}

fn image(input: &UserInput) -> Option<Value> {
    let (data, mime) = match input {
        UserInput::LocalImage { path, .. } => {
            let mime = match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
                "png" => "image/png",
                "jpg" | "jpeg" => "image/jpeg",
                "webp" => "image/webp",
                "gif" => "image/gif",
                _ => return None,
            };
            if !fs::metadata(path).ok()?.is_file() {
                return None;
            }
            (
                BASE64_STANDARD.encode(fs::read(path).ok()?),
                mime.to_string(),
            )
        }
        UserInput::Image { url, .. } => {
            let (header, data) = url.strip_prefix("data:")?.split_once(',')?;
            let mime = header.strip_suffix(";base64")?;
            if !matches!(
                mime,
                "image/png" | "image/jpeg" | "image/webp" | "image/gif"
            ) {
                return None;
            }
            let mut decoded = base64::read::DecoderReader::new(data.as_bytes(), &BASE64_STANDARD);
            io::copy(&mut decoded, &mut io::sink()).ok()?;
            (data.to_string(), mime.to_string())
        }
        _ => return None,
    };
    Some(json!({"type": "image", "data": data, "mimeType": mime}))
}

fn bounded_text(text: &str) -> String {
    if text.len() <= MAX_RENDERED_TEXT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_RENDERED_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[OMP output truncated]", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_thinking_deltas_stream_with_the_final_block_id() {
        let mut normalizer = OmpEventNormalizer::default();
        let mut update = json!({"type": "message_update", "messageId": "msg-7",
            "assistantMessageEvent": {"type": "text_delta", "contentIndex": 2, "delta": "visible"}});
        assert!(normalizer.normalize(update.clone()).unwrap().is_empty());
        update["assistantMessageEvent"]["type"] = json!("thinking_delta");
        let events = normalizer.normalize(update).unwrap();
        assert!(
            matches!(events.as_slice(), [NormalizedEvent::ReasoningTextDelta { item_id, delta }]
            if item_id == "omp-msg-7-2" && delta == "visible")
        );
    }

    #[test]
    fn models_are_structural_not_an_allowlist() {
        assert_eq!(
            split_model("custom/new-model"),
            Some(("custom", "new-model"))
        );
        assert_eq!(
            split_model("openrouter/anthropic/model"),
            Some(("openrouter", "anthropic/model"))
        );
        for invalid in ["/model", "provider/", " provider/model", "p/model id"] {
            assert!(OmpHarness.validate_model(invalid).is_err(), "{invalid}");
        }
        for valid in ["bare", "glm-5.2-fp8", "custom/new-model"] {
            assert_eq!(OmpHarness.validate_model(valid), Ok(()), "{valid}");
        }
    }

    #[test]
    fn bare_models_keep_the_thread_provider_and_skip_the_sentinel() {
        let mut state = ThreadState {
            id: "thread".to_string(),
            cwd: PathBuf::from("/tmp"),
            model: "glm-5.2-fp8".to_string(),
            model_provider: "litellm".to_string(),
            service_tier: None,
            reasoning_effort: None,
            harness_session_id: None,
            thread_key: None,
            completed_turns: Vec::new(),
            process: None,
            thread_started_sent: false,
        };
        assert_eq!(requested_model(&state), Some(("litellm", "glm-5.2-fp8")));
        state.model_provider = NO_MODEL_PROVIDER.to_string();
        assert_eq!(requested_model(&state), None);
        state.model = "litellm/glm-5.2-fp8".to_string();
        assert_eq!(requested_model(&state), Some(("litellm", "glm-5.2-fp8")));
        state.model.clear();
        assert_eq!(requested_model(&state), None);
    }

    #[test]
    fn local_only_command_output_renders_as_the_answer() {
        let mut normalizer = OmpEventNormalizer::default();
        assert!(
            normalizer
                .normalize(json!({"type": "command_output", "text": "help text\n"}))
                .unwrap()
                .is_empty()
        );
        let events = normalizer
            .normalize(
                json!({"type": "response", "command": "prompt", "success": true,
                "data": {"agentInvoked": false}}),
            )
            .unwrap();
        assert!(matches!(
            events.as_slice(),
            [
                NormalizedEvent::AgentMessageStarted { stop_reason: Some(reason), .. },
                NormalizedEvent::AssistantMessage { content, .. },
                NormalizedEvent::Result { error: None },
            ] if reason == "end_turn"
                && matches!(content.as_slice(), [NormalizedContent::AgentText { text, .. }] if text == "help text\n")
        ));
    }

    #[test]
    fn command_output_of_an_agent_turn_is_a_tool_call() {
        let mut normalizer = OmpEventNormalizer::default();
        normalizer
            .normalize(json!({"type": "command_output", "text": "listing\n"}))
            .unwrap();
        let events = normalizer
            .normalize(json!({"type": "agent_start"}))
            .unwrap();
        assert!(matches!(
            events.as_slice(),
            [
                NormalizedEvent::AssistantMessage { content, .. },
                NormalizedEvent::ToolResults(results),
            ] if matches!(content.as_slice(), [NormalizedContent::ToolUse { tool, .. }] if tool == "omp_command")
                && results[0].content == "listing\n"
        ));
        // Later output in the same turn is agent output and renders directly.
        let events = normalizer
            .normalize(json!({"type": "command_output", "text": "again"}))
            .unwrap();
        assert_eq!(events.len(), 2);
    }

    #[test]
    fn error_notices_defer_to_the_settlement_and_session_persistence_is_fatal() {
        let mut normalizer = OmpEventNormalizer::default();
        assert!(matches!(
            normalizer
                .normalize(json!({"type": "notice", "level": "info", "message": "hi"}))
                .unwrap()
                .as_slice(),
            []
        ));
        assert!(matches!(
            normalizer
                .normalize(json!({"type": "notice", "level": "error", "message": "gone"}))
                .unwrap()
                .as_slice(),
            []
        ));
        // The failure ends the turn at the run's settlement, not mid-run, so
        // OMP's remaining frames never land in the next turn. A later failure
        // or a successful result does not displace the first cause.
        assert!(matches!(
            normalizer
                .normalize(json!({"type": "extension_error", "message": "later"}))
                .unwrap()
                .as_slice(),
            []
        ));
        assert!(matches!(
            normalizer
                .normalize(json!({"type": "prompt_result", "status": "completed",
                    "sessionSettled": true}))
                .unwrap()
                .as_slice(),
            [NormalizedEvent::Error { message }] if message == "gone"
        ));
        assert!(matches!(
            normalizer
                .normalize(json!({"type": "prompt_result", "status": "completed",
                    "sessionSettled": true}))
                .unwrap()
                .as_slice(),
            [NormalizedEvent::Result { error: None }]
        ));
        assert!(
            normalizer
                .normalize(json!({"type": "notice", "level": "error",
                    "source": "session-persistence", "message": "gone"}))
                .is_err()
        );
    }

    #[test]
    fn host_requests_are_rejected_instead_of_ignored() {
        let mut normalizer = OmpEventNormalizer::default();
        assert!(
            normalizer
                .normalize(json!({"type": "host_tool_call", "id": "1"}))
                .is_err()
        );
    }

    fn chunks(frame: &Value) -> Vec<Value> {
        let bytes = serde_json::to_vec(frame).unwrap();
        let count = bytes.len().div_ceil(CHUNK_BYTES);
        bytes
            .chunks(CHUNK_BYTES)
            .enumerate()
            .map(|(index, part)| {
                json!({
                    "type": "rpc_chunk", "chunkId": "frame", "index": index, "count": count,
                    "byteLength": bytes.len(), "data": BASE64_STANDARD.encode(part),
                })
            })
            .collect()
    }

    fn ready(max_reassembled: usize) -> Value {
        json!({
            "type": "ready",
            "supportedProtocolVersions": [1, 2],
            "maxReassembledFrameBytes": max_reassembled,
        })
    }

    #[test]
    fn chunks_reassemble_utf8_across_byte_boundaries() {
        let frame = json!({"type": "message_end", "text": "é".repeat(600_000)});
        let parts = chunks(&frame);
        let mut normalizer = OmpEventNormalizer::default();
        for part in &parts[..parts.len() - 1] {
            assert_eq!(normalizer.frame(part.clone()).unwrap(), None);
        }
        assert_eq!(
            normalizer.frame(parts.last().unwrap().clone()).unwrap(),
            Some(frame)
        );
    }

    #[test]
    fn chunks_reject_invalid_order_metadata_encoding_and_truncation() {
        let parts = chunks(&json!({"type": "message_end", "text": "x".repeat(1_100_000)}));
        for field in ["count", "byteLength", "chunkId", "index", "data"] {
            let mut normalizer = OmpEventNormalizer::default();
            normalizer.frame(parts[0].clone()).unwrap();
            let mut next = parts[1].clone();
            next[field] = match field {
                "count" => json!(999),
                "byteLength" => json!(MAX_REASSEMBLED_BYTES + 1),
                "chunkId" => json!("other"),
                "index" => json!(0),
                _ => json!("!!!!"),
            };
            assert!(normalizer.frame(next).is_err(), "{field}");
        }
        let mut normalizer = OmpEventNormalizer::default();
        assert!(normalizer.frame(parts[1].clone()).is_err());
        normalizer.frame(parts[0].clone()).unwrap();
        assert!(normalizer.frame(json!({"type": "prompt_result"})).is_err());
        let mut oversized = parts[0].clone();
        oversized["byteLength"] = json!(MAX_REASSEMBLED_BYTES + 1);
        assert!(OmpEventNormalizer::default().frame(oversized).is_err());
    }

    #[test]
    fn ready_bounds_the_reassembly_ceiling() {
        let mut normalizer = OmpEventNormalizer::default();
        normalizer.frame(ready(8 * 1024 * 1024)).unwrap();
        assert_eq!(normalizer.max_reassembled, 8 * 1024 * 1024);
        let parts = chunks(&json!({"type": "message_end", "text": "x".repeat(9 * 1024 * 1024)}));
        assert!(normalizer.frame(parts[0].clone()).is_err());

        for invalid in [
            json!({"type": "ready", "supportedProtocolVersions": [1], "maxReassembledFrameBytes": 1}),
            ready(0),
            ready(MAX_REASSEMBLED_BYTES + 1),
            json!({"type": "ready", "supportedProtocolVersions": [2]}),
        ] {
            assert!(
                OmpEventNormalizer::default()
                    .frame(invalid.clone())
                    .is_err(),
                "{invalid}"
            );
        }
    }
}
