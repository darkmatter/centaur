mod args;
mod output;

use centaur_api_server::{
    client::CentaurClient,
    types::{AppendMessagesRequest, CreateSessionRequest, ExecuteSessionRequest},
};
use centaur_session_core::{MessageRole, SessionMessageInput};
use clap::Parser;
use eyre::{Result, WrapErr};
use serde_json::{Value, json};

use args::{Args, SessionMode};
use output::stream_output_lines;

const SOURCE: &str = "centaur-session-cli";

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mode = args.session_mode();
    let (thread_key, generated_thread_key) = args.thread_key(mode)?;
    if generated_thread_key {
        eprintln!("thread_key={}", thread_key.as_str());
    }

    let client = CentaurClient::new(&args.api_url);

    if mode == SessionMode::Attach {
        let events = client
            .stream_events(&thread_key, args.after_event_id)
            .await
            .wrap_err("open event stream")?;
        return stream_output_lines(
            events,
            args.all_events,
            args.exit_on_terminal,
            args.exit_on_output_type.as_deref(),
        )
        .await;
    }

    client
        .create_session(
            &thread_key,
            CreateSessionRequest {
                harness_type: args.harness_type,
                metadata: Some(source_metadata()),
            },
        )
        .await
        .wrap_err("create session")?;

    let input_lines = args.input_lines()?;
    client
        .append_messages(
            &thread_key,
            AppendMessagesRequest {
                messages: vec![SessionMessageInput {
                    role: MessageRole::User,
                    parts: vec![json!({"type": "text", "text": args.message_text()})],
                    metadata: source_metadata(),
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
                metadata: Some(source_metadata()),
                input_lines,
                idle_timeout_ms: Some(args.idle_timeout_ms),
                max_duration_ms: Some(args.max_duration_ms),
            },
        )
        .await
        .wrap_err("execute initial turn")?;

    stream_output_lines(
        events,
        args.all_events,
        args.exit_on_terminal,
        args.exit_on_output_type.as_deref(),
    )
    .await
}

fn source_metadata() -> Value {
    json!({ "source": SOURCE })
}
