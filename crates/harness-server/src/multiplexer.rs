use std::{
    collections::{HashMap, VecDeque},
    io::{self, BufRead, Write},
    sync::{Arc, Condvar, Mutex},
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::Result;
use crate::codemode::{CodeModeExecConfig, CodeModeRunInput, run_codemode};

#[derive(Clone, Debug)]
pub struct MultiplexerConfig {
    pub codemode: CodeModeExecConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MultiplexerRequest {
    pub id: String,
    #[serde(flatten)]
    pub command: MultiplexerCommand,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum MultiplexerCommand {
    #[serde(rename = "codemode.run_python")]
    CodeModeRunPython {
        script: String,
        #[serde(default)]
        timeout_seconds: Option<u64>,
        #[serde(default)]
        max_output_bytes: Option<usize>,
        #[serde(default)]
        principal: Option<String>,
    },
    #[serde(rename = "session.start")]
    SessionStart {
        session_id: String,
        harness: HarnessProcessKind,
        cwd: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        model_provider: Option<String>,
        #[serde(default)]
        metadata: Value,
    },
    #[serde(rename = "turn.start")]
    TurnStart {
        session_id: String,
        turn_id: String,
        input: Value,
        #[serde(default)]
        metadata: Value,
    },
    #[serde(rename = "turn.steer")]
    TurnSteer {
        session_id: String,
        turn_id: String,
        input: Value,
        #[serde(default)]
        metadata: Value,
    },
    #[serde(rename = "turn.interrupt")]
    TurnInterrupt { session_id: String, turn_id: String },
    #[serde(rename = "session.stop")]
    SessionStop { session_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessProcessKind {
    Codex,
    ClaudeCode,
    Amp,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct MultiplexerEvent {
    pub id: String,
    #[serde(flatten)]
    pub event: MultiplexerEventKind,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum MultiplexerEventKind {
    #[serde(rename = "codemode.result")]
    CodeModeResult { output: String, is_error: bool },
    #[serde(rename = "session.started")]
    SessionStarted {
        session_id: String,
        harness: HarnessProcessKind,
        cwd: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        model_provider: Option<String>,
    },
    #[serde(rename = "turn.event")]
    TurnEvent {
        session_id: String,
        turn_id: String,
        event: Value,
    },
    #[serde(rename = "turn.completed")]
    TurnCompleted { session_id: String, turn_id: String },
    #[serde(rename = "session.stopped")]
    SessionStopped { session_id: String },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MultiplexerSession {
    session_id: String,
    harness: HarnessProcessKind,
    cwd: String,
    model: Option<String>,
    model_provider: Option<String>,
    metadata: Value,
}

pub fn run_multiplexer_server(config: MultiplexerConfig) -> Result<()> {
    run_multiplexer_io(config, io::stdin().lock(), io::stdout())
}

pub(crate) fn run_multiplexer_io<R, W>(config: MultiplexerConfig, input: R, output: W) -> Result<()>
where
    R: BufRead,
    W: Write + Send + 'static,
{
    let config = Arc::new(config);
    let limiter = Arc::new(ConcurrencyLimiter::new(
        config.codemode.max_concurrency.max(1),
    ));
    let stdout = Arc::new(Mutex::new(output));
    let sessions = Arc::new(Mutex::new(HashMap::new()));
    let mut workers = VecDeque::new();

    for raw in input.lines() {
        let raw = raw?;
        if raw.trim().is_empty() {
            continue;
        }
        let request = match serde_json::from_str::<MultiplexerRequest>(&raw) {
            Ok(request) => request,
            Err(error) => {
                write_event(
                    &stdout,
                    &MultiplexerEvent::error(
                        "parse-error",
                        format!("invalid multiplexer request JSON: {error}"),
                    ),
                )?;
                continue;
            }
        };

        match request.command {
            MultiplexerCommand::CodeModeRunPython {
                script,
                timeout_seconds,
                max_output_bytes,
                principal,
            } => {
                let permit = limiter.acquire();
                let worker_config = Arc::clone(&config);
                let worker_stdout = Arc::clone(&stdout);
                workers.push_back(thread::spawn(move || {
                    let output = run_codemode(
                        &worker_config.codemode,
                        CodeModeRunInput {
                            script,
                            timeout_seconds,
                            max_output_bytes,
                            principal,
                        },
                    );
                    let event = MultiplexerEvent {
                        id: request.id,
                        event: MultiplexerEventKind::CodeModeResult {
                            output: output.output,
                            is_error: output.is_error,
                        },
                    };
                    if let Err(error) = write_event(&worker_stdout, &event) {
                        eprintln!("multiplexer: failed to write CodeMode result: {error}");
                    }
                    drop(permit);
                }));
            }
            MultiplexerCommand::SessionStart {
                session_id,
                harness,
                cwd,
                model,
                model_provider,
                metadata,
            } => {
                let session = MultiplexerSession {
                    session_id: session_id.clone(),
                    harness: harness.clone(),
                    cwd: cwd.clone(),
                    model: model.clone(),
                    model_provider: model_provider.clone(),
                    metadata,
                };
                sessions
                    .lock()
                    .expect("session registry lock poisoned")
                    .insert(session_id.clone(), session);
                write_event(
                    &stdout,
                    &MultiplexerEvent {
                        id: request.id,
                        event: MultiplexerEventKind::SessionStarted {
                            session_id,
                            harness,
                            cwd,
                            model,
                            model_provider,
                        },
                    },
                )?;
            }
            MultiplexerCommand::SessionStop { session_id } => {
                sessions
                    .lock()
                    .expect("session registry lock poisoned")
                    .remove(&session_id);
                write_event(
                    &stdout,
                    &MultiplexerEvent {
                        id: request.id,
                        event: MultiplexerEventKind::SessionStopped { session_id },
                    },
                )?;
            }
            MultiplexerCommand::TurnStart {
                session_id,
                turn_id: _,
                input: _,
                metadata: _,
            } => {
                write_session_turn_error(
                    &stdout,
                    &sessions,
                    request.id,
                    &session_id,
                    "turn.start",
                )?;
            }
            MultiplexerCommand::TurnSteer {
                session_id,
                turn_id: _,
                input: _,
                metadata: _,
            } => {
                write_session_turn_error(
                    &stdout,
                    &sessions,
                    request.id,
                    &session_id,
                    "turn.steer",
                )?;
            }
            MultiplexerCommand::TurnInterrupt {
                session_id,
                turn_id: _,
            } => {
                write_session_turn_error(
                    &stdout,
                    &sessions,
                    request.id,
                    &session_id,
                    "turn.interrupt",
                )?;
            }
        }

        while workers.front().is_some_and(thread::JoinHandle::is_finished) {
            let worker = workers.pop_front().expect("front checked");
            let _ = worker.join();
        }
    }

    for worker in workers {
        let _ = worker.join();
    }
    Ok(())
}

impl MultiplexerSession {
    fn description(&self) -> String {
        let model = self.model.as_deref().unwrap_or("default");
        let provider = self.model_provider.as_deref().unwrap_or("default");
        let metadata_state = if self.metadata.is_null() {
            "without metadata"
        } else {
            "with metadata"
        };
        format!(
            "session {} ({:?}, provider {provider}, model {model}, cwd {}, {metadata_state})",
            self.session_id, self.harness, self.cwd
        )
    }
}

impl MultiplexerCommand {
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::CodeModeRunPython { .. } => "codemode.run_python",
            Self::SessionStart { .. } => "session.start",
            Self::TurnStart { .. } => "turn.start",
            Self::TurnSteer { .. } => "turn.steer",
            Self::TurnInterrupt { .. } => "turn.interrupt",
            Self::SessionStop { .. } => "session.stop",
        }
    }
}

fn write_session_turn_error<W: Write>(
    stdout: &Arc<Mutex<W>>,
    sessions: &Arc<Mutex<HashMap<String, MultiplexerSession>>>,
    request_id: String,
    session_id: &str,
    command: &str,
) -> Result<()> {
    let message = {
        let sessions = sessions.lock().expect("session registry lock poisoned");
        match sessions.get(session_id) {
            Some(session) => format!(
                "{command} is not implemented yet for {}",
                session.description()
            ),
            None => format!("{command} references unknown session {session_id}"),
        }
    };
    write_event(stdout, &MultiplexerEvent::error(request_id, message))
}

impl MultiplexerEvent {
    pub fn error(id: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            event: MultiplexerEventKind::Error {
                message: message.into(),
            },
        }
    }
}

fn write_event<W: Write>(stdout: &Arc<Mutex<W>>, event: &MultiplexerEvent) -> Result<()> {
    let mut stdout = stdout.lock().expect("stdout lock poisoned");
    serde_json::to_writer(&mut *stdout, event)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}

struct ConcurrencyLimiter {
    inner: Mutex<usize>,
    available: Condvar,
}

struct Permit {
    limiter: Arc<ConcurrencyLimiter>,
}

impl ConcurrencyLimiter {
    fn new(max: usize) -> Self {
        Self {
            inner: Mutex::new(max),
            available: Condvar::new(),
        }
    }

    fn acquire(self: &Arc<Self>) -> Permit {
        let mut slots = self.inner.lock().expect("limiter lock poisoned");
        while *slots == 0 {
            slots = self.available.wait(slots).expect("limiter lock poisoned");
        }
        *slots -= 1;
        Permit {
            limiter: Arc::clone(self),
        }
    }
}

impl Drop for Permit {
    fn drop(&mut self) {
        let mut slots = self.limiter.inner.lock().expect("limiter lock poisoned");
        *slots += 1;
        self.limiter.available.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, time::Duration};

    use super::*;

    #[derive(Clone)]
    struct SharedOutput(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedOutput {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .expect("shared output lock poisoned")
                .extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn codemode_request_round_trips_with_dotted_type() {
        let raw = r#"{"id":"req_1","type":"codemode.run_python","script":"print(1)","timeout_seconds":5,"max_output_bytes":200,"principal":"user-1"}"#;
        let parsed: MultiplexerRequest = serde_json::from_str(raw).expect("request parses");
        assert_eq!(parsed.id, "req_1");
        assert_eq!(
            parsed.command,
            MultiplexerCommand::CodeModeRunPython {
                script: "print(1)".to_owned(),
                timeout_seconds: Some(5),
                max_output_bytes: Some(200),
                principal: Some("user-1".to_owned()),
            }
        );
        let encoded = serde_json::to_value(parsed).expect("request serializes");
        assert_eq!(encoded["type"], "codemode.run_python");
    }

    #[test]
    fn future_session_request_shapes_are_typed() {
        let raw = r#"{"id":"req_2","type":"session.start","session_id":"boxsess_1","harness":"codex","cwd":"/workspace","model":"gpt-5","model_provider":"openai"}"#;
        let parsed: MultiplexerRequest = serde_json::from_str(raw).expect("request parses");
        assert_eq!(
            parsed.command,
            MultiplexerCommand::SessionStart {
                session_id: "boxsess_1".to_owned(),
                harness: HarnessProcessKind::Codex,
                cwd: "/workspace".to_owned(),
                model: Some("gpt-5".to_owned()),
                model_provider: Some("openai".to_owned()),
                metadata: Value::Null,
            }
        );
    }

    #[test]
    fn error_event_uses_request_id() {
        let event = MultiplexerEvent::error("req_3", "not ready");
        let encoded = serde_json::to_value(event).expect("event serializes");
        assert_eq!(encoded["id"], "req_3");
        assert_eq!(encoded["type"], "error");
        assert_eq!(encoded["message"], "not ready");
    }

    #[test]
    fn session_start_records_harness_model_and_turns_reference_session() {
        let input = concat!(
            r#"{"id":"req_1","type":"session.start","session_id":"boxsess_1","harness":"codex","cwd":"/workspace","model":"gpt-5","model_provider":"openai"}"#,
            "\n",
            r#"{"id":"req_2","type":"turn.start","session_id":"boxsess_1","turn_id":"turn_1","input":{"text":"hi"}}"#,
            "\n",
            r#"{"id":"req_3","type":"turn.start","session_id":"missing","turn_id":"turn_2","input":{"text":"hi"}}"#,
            "\n",
        );
        let output = Arc::new(Mutex::new(Vec::new()));

        run_multiplexer_io(
            test_config(),
            input.as_bytes(),
            SharedOutput(output.clone()),
        )
        .expect("multiplexer runs");

        let text = String::from_utf8(output.lock().expect("shared output lock poisoned").clone())
            .expect("output is utf8");
        let events = text
            .lines()
            .map(|line| serde_json::from_str::<MultiplexerEvent>(line).expect("event parses"))
            .collect::<Vec<_>>();
        assert_eq!(events.len(), 3);
        assert_eq!(
            events[0].event,
            MultiplexerEventKind::SessionStarted {
                session_id: "boxsess_1".to_owned(),
                harness: HarnessProcessKind::Codex,
                cwd: "/workspace".to_owned(),
                model: Some("gpt-5".to_owned()),
                model_provider: Some("openai".to_owned()),
            }
        );
        let MultiplexerEventKind::Error { message } = &events[1].event else {
            panic!("expected turn error");
        };
        assert!(message.contains("turn.start is not implemented yet"));
        assert!(message.contains("provider openai"));
        assert!(message.contains("model gpt-5"));

        let MultiplexerEventKind::Error { message } = &events[2].event else {
            panic!("expected unknown-session error");
        };
        assert_eq!(message, "turn.start references unknown session missing");
    }

    fn test_config() -> MultiplexerConfig {
        MultiplexerConfig {
            codemode: CodeModeExecConfig {
                proxy_dir: PathBuf::from("/tmp/proxy"),
                env_dir: PathBuf::from("/tmp/env"),
                max_output_bytes: 10_000,
                default_timeout: Duration::from_secs(1),
                max_concurrency: 1,
            },
        }
    }
}
