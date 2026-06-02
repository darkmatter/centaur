use serde::{Deserialize, Serialize};
use serde_json::Value;
use strum::{AsRefStr, Display, EnumString};
use time::OffsetDateTime;

use crate::{ThreadKey, empty_object};

#[derive(
    Clone, Copy, Debug, Eq, PartialEq, Hash, Serialize, Deserialize, AsRefStr, Display, EnumString,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum HarnessType {
    Codex,
    Amp,
    ClaudeCode,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, AsRefStr, Display, EnumString)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum SessionStatus {
    Active,
    Idle,
    Executing,
    Failed,
    Archived,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub thread_key: ThreadKey,
    pub sandbox_id: Option<String>,
    pub harness_type: HarnessType,
    pub harness_thread_id: Option<String>,
    pub status: SessionStatus,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, AsRefStr, Display, EnumString)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionMessageInput {
    pub role: MessageRole,
    pub parts: Vec<Value>,
    #[serde(default = "empty_object")]
    pub metadata: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionMessage {
    pub message_id: String,
    pub thread_key: ThreadKey,
    pub role: MessageRole,
    pub parts: Vec<Value>,
    pub metadata: Value,
    pub created_at: OffsetDateTime,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize, AsRefStr, Display, EnumString)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ExecutionStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionExecution {
    pub execution_id: String,
    pub thread_key: ThreadKey,
    pub status: ExecutionStatus,
    pub metadata: Value,
    pub error: Option<String>,
    pub created_at: OffsetDateTime,
    pub updated_at: OffsetDateTime,
    pub started_at: Option<OffsetDateTime>,
    pub completed_at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionEvent {
    pub event_id: i64,
    pub thread_key: ThreadKey,
    pub execution_id: Option<String>,
    pub event_type: String,
    pub payload: Value,
    pub created_at: OffsetDateTime,
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use super::HarnessType;

    #[test]
    fn harness_type_accepts_supported_values() {
        assert_eq!(HarnessType::from_str("codex").unwrap(), HarnessType::Codex);
        assert_eq!(HarnessType::from_str("amp").unwrap(), HarnessType::Amp);
        assert_eq!(
            HarnessType::from_str("claudecode").unwrap(),
            HarnessType::ClaudeCode
        );
    }

    #[test]
    fn harness_type_serializes_as_wire_value() {
        assert_eq!(
            serde_json::to_value(HarnessType::ClaudeCode).unwrap(),
            serde_json::json!("claudecode")
        );
        assert_eq!(
            serde_json::from_value::<HarnessType>(serde_json::json!("codex")).unwrap(),
            HarnessType::Codex
        );
    }

    #[test]
    fn harness_type_rejects_unsupported_values() {
        assert!(HarnessType::from_str("claude-code").is_err());
    }
}
