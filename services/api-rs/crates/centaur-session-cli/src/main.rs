use std::str::FromStr;

use centaur_api_server::{
    client::{CentaurClient, SseEventStream},
    types::{AppendMessagesRequest, CreateSessionRequest, ExecuteSessionRequest},
};
use centaur_session_core::{HarnessType, MessageRole, SessionMessageInput, ThreadKey};
use clap::Parser;
use eyre::{Result, WrapErr, bail};
use futures_util::StreamExt;
use serde_json::{Value, json};
use uuid::Uuid;

const DEFAULT_MESSAGE: &str = "Reply with exactly PONG and nothing else.";
const SOURCE: &str = "centaur-session-cli";

#[derive(Debug, Parser)]
#[command(about = "Create, execute, or attach to a Centaur session")]
struct Args {
    #[arg(long, env = "CENTAUR_API_URL", default_value = "http://127.0.0.1:8080")]
    api_url: ApiBaseUrl,

    #[arg(long)]
    thread_key: Option<ThreadKey>,

    #[arg(long)]
    attach: bool,

    #[arg(long, default_value = "codex")]
    harness_type: HarnessType,

    #[arg(long)]
    message: Option<String>,

    #[arg(long = "input-line")]
    input_lines: Vec<String>,

    #[arg(long, default_value_t = 1_000)]
    idle_timeout_ms: u64,

    #[arg(long, default_value_t = 60_000)]
    max_duration_ms: u64,

    #[arg(long, default_value_t = 0)]
    after_event_id: i64,

    #[arg(long)]
    all_events: bool,

    #[arg(long)]
    exit_on_terminal: bool,

    #[arg(long, value_parser = non_empty_value)]
    exit_on_output_type: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let attach_mode = attach_mode(&args);
    validate_mode(&args, attach_mode)?;
    let (thread_key, generated_thread_key) = thread_key_arg(&args, attach_mode)?;
    if generated_thread_key {
        eprintln!("thread_key={}", thread_key.as_str());
    }
    let client = CentaurClient::new(args.api_url.as_str());

    if attach_mode {
        let events = client
            .stream_events(&thread_key, args.after_event_id)
            .await
            .wrap_err("open event stream")?;
        return stream_output_lines(events, stream_run_options(&args)).await;
    }

    client
        .create_session(
            &thread_key,
            CreateSessionRequest {
                harness_type: args.harness_type,
                metadata: Some(json!({
                    "source": SOURCE,
                })),
            },
        )
        .await
        .wrap_err("create session")?;

    let input_lines = session_input_lines(&args)?;
    let message = message_text(&args);
    client
        .append_messages(
            &thread_key,
            AppendMessagesRequest {
                messages: vec![SessionMessageInput {
                    role: MessageRole::User,
                    parts: vec![json!({"type": "text", "text": message})],
                    metadata: json!({
                        "source": SOURCE,
                    }),
                }],
            },
        )
        .await
        .wrap_err("append message")?;

    let events = client
        .stream_events(&thread_key, args.after_event_id)
        .await
        .wrap_err("open event stream")?;

    client
        .execute_session(
            &thread_key,
            ExecuteSessionRequest {
                metadata: Some(json!({
                    "source": SOURCE,
                })),
                input_lines,
                idle_timeout_ms: Some(args.idle_timeout_ms),
                max_duration_ms: Some(args.max_duration_ms),
            },
        )
        .await
        .wrap_err("execute initial turn")?;

    stream_output_lines(events, stream_run_options(&args)).await
}

fn stream_run_options(args: &Args) -> StreamRunOptions {
    StreamRunOptions {
        all_events: args.all_events,
        exit_on_terminal: args.exit_on_terminal,
        exit_on_output_type: args.exit_on_output_type.clone(),
    }
}

fn attach_mode(args: &Args) -> bool {
    args.attach
        || (args.after_event_id > 0
            && args.thread_key.is_some()
            && args.message.is_none()
            && args.input_lines.is_empty())
}

fn validate_mode(args: &Args, attach_mode: bool) -> Result<()> {
    if attach_mode && args.thread_key.is_none() {
        bail!("attach mode requires --thread-key");
    }
    if args.attach && (args.message.is_some() || !args.input_lines.is_empty()) {
        bail!("--attach does not accept --message or --input-line");
    }
    Ok(())
}

fn thread_key_arg(args: &Args, attach_mode: bool) -> Result<(ThreadKey, bool)> {
    match (&args.thread_key, attach_mode) {
        (Some(thread_key), _) => Ok((thread_key.clone(), false)),
        (None, true) => bail!("--attach requires --thread-key"),
        (None, false) => Ok((
            ThreadKey::parse(format!("cli:{}", Uuid::new_v4().simple()))?,
            true,
        )),
    }
}

#[derive(Clone, Debug)]
struct StreamRunOptions {
    all_events: bool,
    exit_on_terminal: bool,
    exit_on_output_type: Option<String>,
}

async fn stream_output_lines(mut events: SseEventStream, options: StreamRunOptions) -> Result<()> {
    while let Some(event) = events.next().await {
        let event = event.wrap_err("read event stream")?;

        if event.event == "session.output.line" {
            println!("{}\t{}", event_id_or_unknown(&event.id), event.data);
            if output_type_matches(&event.data, options.exit_on_output_type.as_deref()) {
                return Ok(());
            }
        } else if options.all_events {
            let data = parse_json_or_string(&event.data);
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "sse_event": event.event,
                    "id": optional_event_id(&event.id),
                    "data": data,
                }))?
            );
        }

        if options.exit_on_terminal && is_terminal_event(&event.event) {
            return Ok(());
        }
    }

    Ok(())
}

fn event_id_or_unknown(event_id: &str) -> &str {
    optional_event_id(event_id).unwrap_or("unknown")
}

fn optional_event_id(event_id: &str) -> Option<&str> {
    (!event_id.is_empty()).then_some(event_id)
}

pub(crate) fn output_type_matches(data: &str, expected_type: Option<&str>) -> bool {
    let Some(expected_type) = expected_type else {
        return false;
    };
    serde_json::from_str::<Value>(data)
        .ok()
        .and_then(|value| {
            value
                .get("type")
                .and_then(Value::as_str)
                .map(|event_type| event_type == expected_type)
        })
        .unwrap_or(false)
}

fn session_input_lines(args: &Args) -> Result<Vec<String>> {
    if !args.input_lines.is_empty() {
        return Ok(args.input_lines.clone());
    }
    let message = message_text(args);
    Ok(vec![user_input_line(message)?])
}

pub(crate) fn user_input_line(text: &str) -> Result<String> {
    Ok(serde_json::to_string(&json!({
        "type": "user",
        "message": {
            "content": [{"type": "text", "text": text}],
        },
    }))?)
}

fn message_text(args: &Args) -> &str {
    args.message.as_deref().unwrap_or(DEFAULT_MESSAGE)
}

pub(crate) fn parse_json_or_string(data: &str) -> Value {
    serde_json::from_str(data).unwrap_or_else(|_| Value::String(data.to_owned()))
}

pub(crate) fn is_terminal_event(event: &str) -> bool {
    matches!(
        event,
        "session.execution_completed" | "session.execution_failed" | "session.execution_cancelled"
    )
}

#[derive(Clone, Debug)]
struct ApiBaseUrl(String);

impl ApiBaseUrl {
    fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl FromStr for ApiBaseUrl {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let value = value.trim_end_matches('/');
        if value.is_empty() {
            return Err("api_url must not be empty".to_owned());
        }
        Ok(Self(value.to_owned()))
    }
}

fn non_empty_value(value: &str) -> std::result::Result<String, String> {
    if value.trim().is_empty() {
        Err("value must not be empty".to_owned())
    } else {
        Ok(value.to_owned())
    }
}
