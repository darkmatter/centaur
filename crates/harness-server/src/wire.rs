use codex_app_server_protocol::{JSONRPCMessage, JSONRPCNotification, ServerNotification};
use serde_json::Value;

use crate::Result;

pub fn is_known_untyped_server_notification(method: &str) -> bool {
    matches!(method, "remoteControl/status/changed" | "collab/state")
}

pub fn notification_to_jsonrpc(notification: &ServerNotification) -> Result<JSONRPCNotification> {
    let value = serde_json::to_value(notification)?;
    Ok(serde_json::from_value(value)?)
}

pub fn notification_to_wire_value(notification: &ServerNotification) -> Result<Value> {
    let rpc = notification_to_jsonrpc(notification)?;
    Ok(serde_json::to_value(JSONRPCMessage::Notification(rpc))?)
}

/// Build an untyped `collab/state` notification value. The App Server V2
/// protocol has no typed collaboration variant, so the resident OMP host
/// emits lifecycle frames as an untyped notification (like
/// `remoteControl/status/changed`) carrying the api-rs snake_case room
/// contract in `params`.
pub fn collab_state_wire_value(state: &str, reason: Option<&str>, room: &Value) -> Value {
    let mut params = serde_json::json!({
        "state": state,
        "room": room,
    });
    if let Some(reason) = reason {
        params["reason"] = serde_json::json!(reason);
    }
    serde_json::json!({
        "method": "collab/state",
        "params": params,
    })
}
