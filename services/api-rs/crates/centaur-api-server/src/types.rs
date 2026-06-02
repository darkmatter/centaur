use axum::response::sse::Event;
use centaur_session_core::{HarnessType, SessionEvent, SessionMessageInput, ThreadKey};
use centaur_session_runtime::SESSION_OUTPUT_LINE_EVENT;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const SESSION_STREAM_ERROR_EVENT: &str = "session.stream_error";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CreateSessionRequest {
    pub harness_type: HarnessType,
    pub metadata: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AppendMessagesRequest {
    pub messages: Vec<SessionMessageInput>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AppendMessagesResponse {
    pub ok: bool,
    pub message_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExecuteSessionRequest {
    pub metadata: Option<Value>,
    #[serde(default)]
    pub input_lines: Vec<String>,
    pub idle_timeout_ms: Option<u64>,
    pub max_duration_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ExecuteSessionResponse {
    pub ok: bool,
    pub execution_id: String,
    pub thread_key: ThreadKey,
    pub status: String,
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct EventsQuery {
    pub after_event_id: Option<i64>,
}

pub struct SessionSseEvent(Event);

impl TryFrom<SessionEvent> for SessionSseEvent {
    type Error = SessionEventConversionError;

    fn try_from(event: SessionEvent) -> Result<Self, Self::Error> {
        let event_id = event.event_id;
        let event_type = event.event_type;
        let output_line = event_type == SESSION_OUTPUT_LINE_EVENT;
        let sse = Event::default().id(event_id.to_string()).event(event_type);

        let sse = if output_line {
            let Some(line) = event.payload.as_str() else {
                return Err(SessionEventConversionError::OutputLinePayload { event_id });
            };
            sse.data(line)
        } else {
            sse.json_data(event.payload)
                .map_err(|source| SessionEventConversionError::JsonData { event_id, source })?
        };

        Ok(Self(sse))
    }
}

impl From<SessionSseEvent> for Event {
    fn from(value: SessionSseEvent) -> Self {
        value.0
    }
}

pub fn stream_error_sse(message: impl Into<String>) -> Event {
    Event::default()
        .event(SESSION_STREAM_ERROR_EVENT)
        .json_data(serde_json::json!({ "error": message.into() }))
        .unwrap_or_else(|_| {
            Event::default()
                .event(SESSION_STREAM_ERROR_EVENT)
                .data("{}")
        })
}

#[derive(Debug, Error)]
pub enum SessionEventConversionError {
    #[error("session.output.line event {event_id} payload must be a string")]
    OutputLinePayload { event_id: i64 },
    #[error("failed to serialize session event {event_id} payload as SSE JSON: {source}")]
    JsonData { event_id: i64, source: axum::Error },
}
