from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field
from typing import Any


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _as_int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return 0
    return 0


def _as_float(value: Any) -> float:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return 0.0
    return 0.0


def payload_size_bytes(value: Any) -> int:
    try:
        return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str).encode("utf-8"))
    except Exception:
        return len(str(value).encode("utf-8", errors="replace"))


def summarize_message_parts(parts: list[dict[str, Any]]) -> dict[str, Any]:
    summary = {
        "part_count": len(parts),
        "text_part_count": 0,
        "text_chars": 0,
        "attachment_ref_count": 0,
        "image_part_count": 0,
        "document_part_count": 0,
        "tool_use_count": 0,
        "other_part_count": 0,
    }
    for part in parts:
        part_type = _as_str(part.get("type"))
        if part_type == "text":
            summary["text_part_count"] += 1
            summary["text_chars"] += len(_as_str(part.get("text")))
        elif part_type == "attachment_ref":
            summary["attachment_ref_count"] += 1
        elif part_type == "image":
            summary["image_part_count"] += 1
        elif part_type == "document":
            summary["document_part_count"] += 1
        elif part_type == "tool_use":
            summary["tool_use_count"] += 1
        else:
            summary["other_part_count"] += 1
    return summary


def extract_usage_metrics(usage: dict[str, Any], model: str | None = None) -> dict[str, Any]:
    parsed = {
        "model": model or None,
        "input_tokens": _as_int(usage.get("input_tokens")),
        "output_tokens": _as_int(usage.get("output_tokens")),
        "cache_creation_input_tokens": _as_int(usage.get("cache_creation_input_tokens")),
        "cache_read_input_tokens": _as_int(usage.get("cache_read_input_tokens")),
        "cost_usd": round(_as_float(usage.get("cost_usd")), 6),
    }
    parsed["total_tokens"] = (
        parsed["input_tokens"]
        + parsed["output_tokens"]
        + parsed["cache_creation_input_tokens"]
        + parsed["cache_read_input_tokens"]
    )
    return parsed


def project_execution_observations(
    event: dict[str, Any],
    *,
    execution_id: str,
    thread_key: str,
    assignment_generation: int,
    harness: str,
    engine: str | None,
    persona_id: str | None,
    prompt_ref: str | None,
    prompt_sha: str | None,
) -> list[tuple[str, dict[str, Any]]]:
    base = {
        "execution_id": execution_id,
        "thread_key": thread_key,
        "assignment_generation": assignment_generation,
        "harness": harness,
        "engine": engine,
        "persona_id": persona_id,
        "prompt_ref": prompt_ref,
        "prompt_sha": prompt_sha,
    }
    event_type = _as_str(event.get("type"))
    observations: list[tuple[str, dict[str, Any]]] = []

    if event_type == "assistant":
        message = _as_dict(event.get("message"))
        content = _as_list(message.get("content"))
        text_blocks = [block for block in content if _as_str(_as_dict(block).get("type")) == "text"]
        tool_blocks = [block for block in content if _as_str(_as_dict(block).get("type")) == "tool_use"]
        text_chars = sum(len(_as_str(_as_dict(block).get("text"))) for block in text_blocks)
        if text_blocks:
            observations.append(
                (
                    "assistant_text_observed",
                    {
                        **base,
                        "type": "obs.assistant_text",
                        "text_block_count": len(text_blocks),
                        "text_chars": text_chars,
                    },
                )
            )
        for block in tool_blocks:
            tool_block = _as_dict(block)
            tool_input = _as_dict(tool_block.get("input"))
            observations.append(
                (
                    "assistant_tool_use_observed",
                    {
                        **base,
                        "type": "obs.assistant_tool_use",
                        "tool_use_id": _as_str(tool_block.get("id")),
                        "tool_name": _as_str(tool_block.get("name")),
                        "input_keys": sorted(tool_input.keys()),
                        "input_size_bytes": payload_size_bytes(tool_input),
                    },
                )
            )
        usage = _as_dict(message.get("usage"))
        if usage:
            usage_payload = extract_usage_metrics(usage, model=_as_str(message.get("model")) or None)
            observations.append(
                (
                    "usage_observed",
                    {
                        **base,
                        "type": "obs.usage",
                        **usage_payload,
                        "authoritative": bool(event.get("authoritative")),
                    },
                )
            )
        return observations

    if event_type == "tool":
        for block in _as_list(event.get("content")):
            tool_result = _as_dict(block)
            observations.append(
                (
                    "tool_result_observed",
                    {
                        **base,
                        "type": "obs.tool_result",
                        "tool_use_id": _as_str(tool_result.get("tool_use_id")),
                        "is_error": bool(tool_result.get("is_error")),
                        "content_size_bytes": payload_size_bytes(tool_result.get("content")),
                    },
                )
            )
        return observations

    if event_type == "usage":
        usage_payload = extract_usage_metrics(
            _as_dict(event.get("usage")),
            model=_as_str(event.get("model")) or None,
        )
        observations.append(
            (
                "usage_observed",
                {
                    **base,
                    "type": "obs.usage",
                    **usage_payload,
                    "authoritative": bool(event.get("authoritative")),
                },
            )
        )
        return observations

    if event_type == "reasoning":
        observations.append(
            (
                "reasoning_observed",
                {
                    **base,
                    "type": "obs.reasoning",
                    "text_chars": len(_as_str(event.get("text"))),
                },
            )
        )
        return observations

    if event_type == "command_execution":
        command = _as_str(event.get("command"))
        observations.append(
            (
                "command_execution_observed",
                {
                    **base,
                    "type": "obs.command_execution",
                    "command": command[:200],
                    "command_size_bytes": len(command.encode("utf-8", errors="replace")),
                    "output_size_bytes": len(_as_str(event.get("aggregated_output")).encode("utf-8", errors="replace")),
                    "exit_code": event.get("exit_code"),
                    "status": event.get("status"),
                },
            )
        )
        return observations

    if event_type == "file_change":
        observations.append(
            (
                "file_change_observed",
                {
                    **base,
                    "type": "obs.file_change",
                    "change_count": len(_as_list(event.get("changes"))),
                },
            )
        )
        return observations

    if event_type == "subagent":
        activities = _as_list(event.get("activities"))
        observations.append(
            (
                "subagent_status_observed",
                {
                    **base,
                    "type": "obs.subagent_status",
                    "subagent_id": _as_str(event.get("subagent_id")),
                    "status": _as_str(event.get("status")),
                    "name": _as_str(event.get("name")) or None,
                    "activity_count": len(activities),
                    "summary_chars": len(_as_str(event.get("summary"))),
                    "error_chars": len(_as_str(event.get("error"))),
                },
            )
        )
        return observations

    if event_type == "result":
        observations.append(
            (
                "result_observed",
                {
                    **base,
                    "type": "obs.result",
                    "text_chars": len(_as_str(event.get("text"))),
                },
            )
        )
        return observations

    if event_type == "error":
        observations.append(
            (
                "error_observed",
                {
                    **base,
                    "type": "obs.error",
                    "error_chars": len(_as_str(event.get("error"))),
                },
            )
        )
        return observations

    if event_type == "system":
        observations.append(
            (
                "system_event_observed",
                {
                    **base,
                    "type": "obs.system",
                    "subtype": _as_str(event.get("subtype")),
                    "session_id": _as_str(event.get("session_id")) or None,
                },
            )
        )
        return observations

    return observations


@dataclass
class ExecutionObservationAccumulator:
    raw_event_count: int = 0
    observation_event_count: int = 0
    assistant_text_events: int = 0
    assistant_text_chars: int = 0
    assistant_tool_use_events: int = 0
    tool_result_events: int = 0
    tool_error_events: int = 0
    usage_events: int = 0
    reasoning_events: int = 0
    command_events: int = 0
    command_error_events: int = 0
    file_change_events: int = 0
    subagent_events: int = 0
    subagent_failures: int = 0
    result_events: int = 0
    error_events: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    total_cost_usd: float = 0.0
    models: set[str] = field(default_factory=set)
    tools: Counter[str] = field(default_factory=Counter)
    tool_errors: Counter[str] = field(default_factory=Counter)
    tool_use_to_name: dict[str, str] = field(default_factory=dict)

    def observe(self, event_kind: str, payload: dict[str, Any]) -> None:
        self.observation_event_count += 1
        if event_kind == "assistant_text_observed":
            self.assistant_text_events += 1
            self.assistant_text_chars += _as_int(payload.get("text_chars"))
        elif event_kind == "assistant_tool_use_observed":
            self.assistant_tool_use_events += 1
            tool_use_id = _as_str(payload.get("tool_use_id"))
            tool_name = _as_str(payload.get("tool_name"))
            if tool_name:
                self.tools[tool_name] += 1
                if tool_use_id:
                    self.tool_use_to_name[tool_use_id] = tool_name
        elif event_kind == "tool_result_observed":
            self.tool_result_events += 1
            if payload.get("is_error"):
                self.tool_error_events += 1
                tool_name = self.tool_use_to_name.get(_as_str(payload.get("tool_use_id")))
                if tool_name:
                    self.tool_errors[tool_name] += 1
        elif event_kind == "usage_observed":
            self.usage_events += 1
            self.input_tokens += _as_int(payload.get("input_tokens"))
            self.output_tokens += _as_int(payload.get("output_tokens"))
            self.cache_creation_input_tokens += _as_int(payload.get("cache_creation_input_tokens"))
            self.cache_read_input_tokens += _as_int(payload.get("cache_read_input_tokens"))
            self.total_cost_usd += _as_float(payload.get("cost_usd"))
            model = _as_str(payload.get("model"))
            if model:
                self.models.add(model)
        elif event_kind == "reasoning_observed":
            self.reasoning_events += 1
        elif event_kind == "command_execution_observed":
            self.command_events += 1
            exit_code = payload.get("exit_code")
            if exit_code not in (None, 0, "0"):
                self.command_error_events += 1
        elif event_kind == "file_change_observed":
            self.file_change_events += 1
        elif event_kind == "subagent_status_observed":
            self.subagent_events += 1
            if _as_str(payload.get("status")) == "failed":
                self.subagent_failures += 1
        elif event_kind == "result_observed":
            self.result_events += 1
        elif event_kind == "error_observed":
            self.error_events += 1

    def build_summary(
        self,
        *,
        execution_id: str,
        thread_key: str,
        assignment_generation: int,
        harness: str,
        engine: str | None,
        persona_id: str | None,
        prompt_ref: str | None,
        prompt_sha: str | None,
        status: str,
        terminal_reason: str,
        duration_s: float | None = None,
    ) -> dict[str, Any]:
        total_tokens = (
            self.input_tokens
            + self.output_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
        )
        return {
            "type": "obs.execution_summary",
            "execution_id": execution_id,
            "thread_key": thread_key,
            "assignment_generation": assignment_generation,
            "harness": harness,
            "engine": engine,
            "persona_id": persona_id,
            "prompt_ref": prompt_ref,
            "prompt_sha": prompt_sha,
            "status": status,
            "terminal_reason": terminal_reason,
            "duration_s": round(duration_s, 3) if duration_s is not None else None,
            "raw_event_count": self.raw_event_count,
            "observation_event_count": self.observation_event_count,
            "assistant_text_events": self.assistant_text_events,
            "assistant_text_chars": self.assistant_text_chars,
            "assistant_tool_use_events": self.assistant_tool_use_events,
            "tool_result_events": self.tool_result_events,
            "tool_error_events": self.tool_error_events,
            "reasoning_events": self.reasoning_events,
            "command_events": self.command_events,
            "command_error_events": self.command_error_events,
            "file_change_events": self.file_change_events,
            "subagent_events": self.subagent_events,
            "subagent_failures": self.subagent_failures,
            "result_events": self.result_events,
            "error_events": self.error_events,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cache_creation_input_tokens": self.cache_creation_input_tokens,
            "cache_read_input_tokens": self.cache_read_input_tokens,
            "total_tokens": total_tokens,
            "cost_usd": round(self.total_cost_usd, 6),
            "models": sorted(self.models),
            "tool_calls_by_name": dict(self.tools),
            "tool_errors_by_name": dict(self.tool_errors),
        }
