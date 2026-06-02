use centaur_api_server::client::SseEventStream;
use eyre::{Result, WrapErr};
use futures_util::StreamExt;
use serde_json::{Value, json};

pub(crate) async fn stream_output_lines(
    mut events: SseEventStream,
    all_events: bool,
    exit_on_terminal: bool,
    exit_on_output_type: Option<&str>,
) -> Result<()> {
    while let Some(event) = events.next().await {
        let event = event.wrap_err("read event stream")?;

        if event.event == "session.output.line" {
            println!("{}\t{}", event_id_or_unknown(&event.id), event.data);
            if output_type_matches(&event.data, exit_on_output_type) {
                return Ok(());
            }
        } else if all_events {
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

        if exit_on_terminal && is_terminal_event(&event.event) {
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

fn output_type_matches(data: &str, expected_type: Option<&str>) -> bool {
    let Some(expected_type) = expected_type else {
        return false;
    };
    serde_json::from_str::<Value>(data)
        .is_ok_and(|value| value.get("type").and_then(Value::as_str) == Some(expected_type))
}

fn parse_json_or_string(data: &str) -> Value {
    serde_json::from_str(data).unwrap_or_else(|_| Value::String(data.to_owned()))
}

fn is_terminal_event(event: &str) -> bool {
    matches!(
        event,
        "session.execution_completed" | "session.execution_failed" | "session.execution_cancelled"
    )
}
