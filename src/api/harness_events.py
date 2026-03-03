"""Normalize harness-specific JSON events into canonical thread events.

The thread UI stream mapper expects a small set of event shapes (`assistant`,
`tool`, `reasoning`, `command_execution`, `file_change`, `result`, `error`).
Each harness emits different raw JSON shapes, so this module converts them into
those canonical events without introducing a heavy abstraction layer.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _parse_dictish(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
        except Exception:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _stable_tool_call_id(name: str, tool_input: Any) -> str:
    payload = {"name": name or "tool", "input": tool_input if isinstance(tool_input, dict) else {}}
    digest = hashlib.sha1(
        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()[:12]
    return f"tool-call-{digest}"


def _assistant_text_event(text: str) -> dict[str, Any]:
    return {"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}}


def _assistant_tool_use_event(tool_call_id: str, name: str, tool_input: Any) -> dict[str, Any]:
    tool_name = _as_text(name) or "tool"
    normalized_input = tool_input if isinstance(tool_input, dict) else {}
    resolved_tool_call_id = _as_text(tool_call_id).strip() or _stable_tool_call_id(
        tool_name, normalized_input
    )
    return {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": resolved_tool_call_id,
                    "name": tool_name,
                    "input": normalized_input,
                }
            ]
        },
    }


def _tool_result_event(tool_use_id: str, content: Any, is_error: bool = False) -> dict[str, Any]:
    return {
        "type": "tool",
        "content": [{"tool_use_id": tool_use_id, "content": content, "is_error": is_error}],
    }


def _subagent_event(
    *,
    status: str,
    subagent_id: str,
    name: str = "",
    summary: str = "",
    error: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "subagent",
        "status": status,
        "subagent_id": subagent_id,
    }
    if name:
        payload["name"] = name
    if summary:
        payload["summary"] = summary
    if error:
        payload["error"] = error
    return payload


def _normalize_amp_like_event(event: dict[str, Any]) -> list[dict[str, Any]]:
    event_type = _as_text(event.get("type"))

    if event_type == "user":
        message = _as_dict(event.get("message"))
        tool_results: list[dict[str, Any]] = []
        for block in _as_list(message.get("content")):
            block_dict = _as_dict(block)
            if _as_text(block_dict.get("type")) != "tool_result":
                continue
            tool_use_id = _as_text(block_dict.get("tool_use_id")) or _as_text(
                event.get("parent_tool_use_id")
            )
            if not tool_use_id:
                continue
            tool_results.append(
                {
                    "tool_use_id": tool_use_id,
                    "content": block_dict.get("content"),
                    "is_error": bool(block_dict.get("is_error")),
                }
            )
        if tool_results:
            return [{"type": "tool", "content": tool_results}]
        return []

    if event_type in {
        "assistant",
        "reasoning",
        "tool",
        "command_execution",
        "file_change",
        "subagent",
        "result",
    }:
        return [event]

    if event_type == "error":
        message = _as_text(event.get("error")) or _as_text(event.get("message")) or "Unknown error"
        return [{"type": "error", "error": message}]

    if event_type == "stream_event":
        nested = _as_dict(event.get("event"))
        nested_type = _as_text(nested.get("type"))
        if nested_type == "error":
            message = _as_text(_as_dict(nested.get("error")).get("message")) or "Unknown error"
            return [{"type": "error", "error": message}]
        if nested_type == "content_block_start":
            block = _as_dict(nested.get("content_block"))
            if _as_text(block.get("type")) == "tool_use":
                tool_id = _as_text(block.get("id"))
                name = _as_text(block.get("name")) or "tool"
                return [_assistant_tool_use_event(tool_id, name, block.get("input"))]
        if nested_type == "content_block_delta":
            delta = _as_dict(nested.get("delta"))
            delta_type = _as_text(delta.get("type"))
            if delta_type == "text_delta":
                text = _as_text(delta.get("text"))
                return [_assistant_text_event(text)] if text else []
            if delta_type == "thinking_delta":
                text = _as_text(delta.get("thinking"))
                return [{"type": "reasoning", "text": text}] if text else []
        return []

    return []


def _codex_tool_name(item: dict[str, Any]) -> str:
    return (
        _as_text(item.get("tool"))
        or _as_text(item.get("toolName"))
        or _as_text(item.get("name"))
        or _as_text(item.get("tool_name"))
        or "tool"
    )


def _codex_tool_input(item: dict[str, Any]) -> dict[str, Any]:
    for key in ("arguments", "input", "args"):
        value = _parse_dictish(item.get(key))
        if value:
            return value
    return {}


def _codex_tool_call_id(item: dict[str, Any]) -> str:
    direct_id = (
        _as_text(item.get("id"))
        or _as_text(item.get("tool_call_id"))
        or _as_text(item.get("tool_use_id"))
        or _as_text(item.get("toolUseId"))
        or _as_text(item.get("toolCallId"))
        or _as_text(item.get("call_id"))
    )
    if direct_id:
        return direct_id
    return _stable_tool_call_id(_codex_tool_name(item), _codex_tool_input(item))


def _normalize_codex_item(item: dict[str, Any], phase: str) -> list[dict[str, Any]]:
    item_type = _as_text(item.get("type"))

    if item_type == "agent_message" and phase == "completed":
        text = _as_text(item.get("text"))
        return [_assistant_text_event(text)] if text else []

    if item_type == "reasoning" and phase in {"updated", "completed"}:
        text = _as_text(item.get("text")) or _as_text(item.get("thinking"))
        return [{"type": "reasoning", "text": text}] if text else []

    if item_type in {"mcp_tool_call", "tool_call", "function_call", "custom_tool_call"}:
        tool_id = _codex_tool_call_id(item)
        tool_name = _codex_tool_name(item)
        if tool_name.strip().lower() == "subagent":
            tool_input = _codex_tool_input(item)
            label = (
                _as_text(tool_input.get("description"))
                or _as_text(tool_input.get("name"))
                or "Delegated subagent"
            )
            if phase == "started":
                return [_subagent_event(status="started", subagent_id=tool_id, name=label)]
            if phase == "completed":
                if item.get("error") is not None:
                    return [
                        _subagent_event(
                            status="failed",
                            subagent_id=tool_id,
                            name=label,
                            error=_as_text(item.get("error")) or "Subagent failed",
                        )
                    ]
                result_summary = _as_text(item.get("result"))
                return [
                    _subagent_event(
                        status="completed",
                        subagent_id=tool_id,
                        name=label,
                        summary=result_summary[:220],
                    )
                ]
            return []
        if phase == "started":
            tool_input = _codex_tool_input(item)
            return [_assistant_tool_use_event(tool_id, tool_name, tool_input)]

        if phase == "completed":
            output = item.get("result")
            if output is None and item.get("error") is not None:
                output = item.get("error")
            return [_tool_result_event(tool_id, output, bool(item.get("error")))]

        return []

    if item_type == "command_execution":
        command = _as_text(item.get("command"))
        if phase == "completed":
            return [
                {
                    "type": "command_execution",
                    "command": command,
                    "aggregated_output": item.get("aggregated_output") or item.get("output") or "",
                    "exit_code": item.get("exit_code"),
                    "status": item.get("status"),
                }
            ]

        return []

    if item_type == "file_change" and phase == "completed":
        changes = item.get("changes")
        return [{"type": "file_change", "changes": changes if isinstance(changes, list) else []}]

    if item_type == "error":
        message = _as_text(item.get("message")) or "Unknown error"
        return [{"type": "error", "error": message}]

    return []


def _normalize_codex_event(event: dict[str, Any]) -> list[dict[str, Any]]:
    event_type = _as_text(event.get("type"))

    if event_type == "thread.started":
        thread_id = _as_text(event.get("thread_id"))
        return [{"type": "system", "subtype": "init", "session_id": thread_id}] if thread_id else []

    if event_type == "error":
        message = _as_text(event.get("message")) or "Unknown error"
        return [{"type": "error", "error": message}]

    if event_type == "turn.failed":
        error = _as_dict(event.get("error"))
        message = _as_text(error.get("message")) or _as_text(event.get("message")) or "Turn failed"
        return [{"type": "error", "error": message}]

    if event_type == "turn.completed":
        # Keep raw turn.completed for usage accounting; detailed item.completed
        # events are normalized separately to avoid duplicate rendering.
        return [event]

    if event_type == "item.started":
        return _normalize_codex_item(_as_dict(event.get("item")), "started")
    if event_type == "item.updated":
        return _normalize_codex_item(_as_dict(event.get("item")), "updated")
    if event_type == "item.completed":
        return _normalize_codex_item(_as_dict(event.get("item")), "completed")

    return []


def _normalize_pi_message_content(message: dict[str, Any]) -> list[dict[str, Any]]:
    content = _as_list(message.get("content"))
    normalized: list[dict[str, Any]] = []
    for block in content:
        block_dict = _as_dict(block)
        block_type = _as_text(block_dict.get("type"))
        if block_type == "text":
            text = _as_text(block_dict.get("text"))
            if text:
                normalized.append(_assistant_text_event(text))
        elif block_type == "thinking":
            text = _as_text(block_dict.get("text")) or _as_text(block_dict.get("thinking"))
            if text:
                normalized.append({"type": "reasoning", "text": text})
        elif block_type in {"tool_call", "toolcall"}:
            tool_call = _as_dict(block_dict.get("toolCall")) or block_dict
            tool_name = (
                _as_text(tool_call.get("name")) or _as_text(block_dict.get("name")) or "tool"
            )
            tool_input = _as_dict(tool_call.get("input")) or _as_dict(block_dict.get("input"))
            tool_id = _as_text(tool_call.get("id")) or _as_text(block_dict.get("id"))
            normalized.append(_assistant_tool_use_event(tool_id, tool_name, tool_input))
    return normalized


def _normalize_pi_event(event: dict[str, Any]) -> list[dict[str, Any]]:
    event_type = _as_text(event.get("type"))

    if event_type == "session":
        session_id = _as_text(event.get("id"))
        return (
            [{"type": "system", "subtype": "init", "session_id": session_id}] if session_id else []
        )

    if event_type == "tool_execution_start":
        tool_name = _as_text(event.get("toolName")) or "tool"
        tool_input = _as_dict(event.get("args"))
        tool_id = _as_text(event.get("toolCallId"))
        if tool_name.strip().lower() == "subagent":
            fallback_id = tool_id or _stable_tool_call_id(tool_name, tool_input)
            label = (
                _as_text(tool_input.get("description"))
                or _as_text(tool_input.get("name"))
                or "Delegated subagent"
            )
            return [_subagent_event(status="started", subagent_id=fallback_id, name=label)]
        return [_assistant_tool_use_event(tool_id, tool_name, tool_input)]

    if event_type == "tool_execution_end":
        tool_id = _as_text(event.get("toolCallId"))
        if not tool_id:
            return []
        if _as_text(event.get("toolName")).strip().lower() == "subagent":
            if bool(event.get("isError")):
                return [
                    _subagent_event(
                        status="failed",
                        subagent_id=tool_id,
                        error=_as_text(event.get("error")) or "Subagent failed",
                    )
                ]
            result_summary = _as_text(event.get("result"))
            return [
                _subagent_event(
                    status="completed",
                    subagent_id=tool_id,
                    summary=result_summary[:220],
                )
            ]
        return [_tool_result_event(tool_id, event.get("result"), bool(event.get("isError")))]

    if event_type == "message_end":
        message = _as_dict(event.get("message"))
        role = _as_text(message.get("role"))
        if role != "assistant":
            return []
        normalized = _normalize_pi_message_content(message)
        stop_reason = _as_text(message.get("stopReason"))
        if stop_reason in {"error", "aborted"}:
            error_text = _as_text(message.get("errorMessage")) or "Assistant run failed"
            normalized.append({"type": "error", "error": error_text})
        return normalized

    if event_type == "agent_end":
        messages = _as_list(event.get("messages"))
        if not messages:
            return []
        assistant_messages = [
            m for m in messages if _as_text(_as_dict(m).get("role")) == "assistant"
        ]
        if not assistant_messages:
            return []
        last_assistant = _as_dict(assistant_messages[-1])
        stop_reason = _as_text(last_assistant.get("stopReason"))
        if stop_reason in {"error", "aborted"}:
            error_text = _as_text(last_assistant.get("errorMessage")) or "Assistant run failed"
            return [{"type": "error", "error": error_text}]
        return []

    return []


def normalize_harness_event(harness: str, event: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert one raw harness event into one or more canonical events."""
    normalized_harness = (harness or "").strip().lower()
    if not normalized_harness:
        event_type = _as_text(event.get("type"))
        if (
            event_type.startswith("item.")
            or event_type.startswith("turn.")
            or event_type == "thread.started"
        ):
            normalized_harness = "codex"
        elif event_type in {
            "session",
            "agent_start",
            "agent_end",
            "message_start",
            "message_update",
            "message_end",
            "tool_execution_start",
            "tool_execution_update",
            "tool_execution_end",
        }:
            normalized_harness = "pi-mono"
        else:
            normalized_harness = "amp"
    if normalized_harness == "codex":
        return _normalize_codex_event(event)
    if normalized_harness == "pi-mono":
        return _normalize_pi_event(event)
    # eng uses claude-code under the hood, same event format as amp/claude-code
    return _normalize_amp_like_event(event)
