use centaur_session_core::{HarnessType, ThreadKey};
use clap::Parser;
use eyre::{Result, bail};
use serde_json::json;
use uuid::Uuid;

const DEFAULT_MESSAGE: &str = "Reply with exactly PONG and nothing else.";

#[derive(Debug, Parser)]
#[command(about = "Create, execute, or attach to a Centaur session")]
pub(crate) struct Args {
    #[arg(long, env = "CENTAUR_API_URL", default_value = "http://127.0.0.1:8080", value_parser = api_base_url)]
    pub(crate) api_url: String,

    #[arg(long)]
    thread_key: Option<ThreadKey>,

    #[arg(long, requires = "thread_key", conflicts_with_all = ["message", "input_lines"])]
    attach: bool,

    #[arg(long, default_value = "codex")]
    pub(crate) harness_type: HarnessType,

    #[arg(long)]
    message: Option<String>,

    #[arg(long = "input-line")]
    input_lines: Vec<String>,

    #[arg(long, default_value_t = 1_000)]
    pub(crate) idle_timeout_ms: u64,

    #[arg(long, default_value_t = 60_000)]
    pub(crate) max_duration_ms: u64,

    #[arg(long, default_value_t = 0)]
    pub(crate) after_event_id: i64,

    #[arg(long)]
    pub(crate) all_events: bool,

    #[arg(long)]
    pub(crate) exit_on_terminal: bool,

    #[arg(long, value_parser = non_empty_value)]
    pub(crate) exit_on_output_type: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SessionMode {
    Attach,
    Execute,
}

impl Args {
    pub(crate) fn session_mode(&self) -> SessionMode {
        let attach_mode = self.attach
            || (self.after_event_id > 0
                && self.thread_key.is_some()
                && self.message.is_none()
                && self.input_lines.is_empty());
        if attach_mode {
            SessionMode::Attach
        } else {
            SessionMode::Execute
        }
    }

    pub(crate) fn thread_key(&self, mode: SessionMode) -> Result<(ThreadKey, bool)> {
        match (&self.thread_key, mode) {
            (Some(thread_key), _) => Ok((thread_key.clone(), false)),
            (None, SessionMode::Attach) => bail!("--attach requires --thread-key"),
            (None, SessionMode::Execute) => Ok((
                ThreadKey::parse(format!("cli:{}", Uuid::new_v4().simple()))?,
                true,
            )),
        }
    }

    pub(crate) fn input_lines(&self) -> Result<Vec<String>> {
        if !self.input_lines.is_empty() {
            return Ok(self.input_lines.clone());
        }
        Ok(vec![user_input_line(self.message_text())?])
    }

    pub(crate) fn message_text(&self) -> &str {
        self.message.as_deref().unwrap_or(DEFAULT_MESSAGE)
    }
}

fn user_input_line(text: &str) -> Result<String> {
    Ok(serde_json::to_string(&json!({
        "type": "user",
        "message": {
            "content": [{"type": "text", "text": text}],
        },
    }))?)
}

fn api_base_url(value: &str) -> std::result::Result<String, String> {
    let value = value.trim_end_matches('/');
    (!value.is_empty())
        .then(|| value.to_owned())
        .ok_or_else(|| "api_url must not be empty".to_owned())
}

fn non_empty_value(value: &str) -> std::result::Result<String, String> {
    (!value.trim().is_empty())
        .then(|| value.to_owned())
        .ok_or_else(|| "value must not be empty".to_owned())
}
