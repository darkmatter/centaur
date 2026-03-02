from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any, cast

from shared.engineer.loop_guards import GuardrailStopError, LoopGuardState
from shared.engineer.tool_protocol import (
    build_tool_result_blocks,
    extract_tool_uses,
    to_assistant_blocks,
    tool_signature,
)


class AgentLoopError(RuntimeError):
    pass


@dataclass
class AgentLoopResult:
    text: str
    turns: int
    tool_calls: int
    stop_reason: str
    input_tokens: int = 0
    output_tokens: int = 0


SAFE_PARALLEL_TOOL_NAMES = {
    "think",
    "read_file",
    "list_directory",
    "grep_search",
    "run_validation",
}
_MAX_TOOL_RESULT_CHARS = 12000
_MAX_HISTORY_CHARS = 500000
_COMPACT_KEEP_RECENT_MESSAGES = 12


def _extract_text(content_blocks: list[Any]) -> str:
    parts: list[str] = []
    for block in content_blocks:
        if getattr(block, "type", "") == "text":
            parts.append(getattr(block, "text", ""))
    return "".join(parts).strip()


def _last_user_message_is_continuation(messages: list[dict[str, Any]]) -> bool:
    """True if the last user message is a continuation prompt (avoids infinite retries)."""
    if not messages:
        return False
    last = messages[-1]
    if last.get("role") != "user":
        return False
    content = last.get("content")
    if isinstance(content, str):
        return content.strip().lower() in ("please continue", "please continue.")
    if isinstance(content, list):
        for block in content:
            if block.get("type") == "text":
                return block.get("text", "").strip().lower() in (
                    "please continue",
                    "please continue.",
                )
    return False


def _truncate(text: str, max_chars: int = _MAX_TOOL_RESULT_CHARS) -> str:
    if len(text) <= max_chars:
        return text
    half = max_chars // 2
    return f"{text[:half]}\n\n...truncated...\n\n{text[-half:]}"


def _is_unsupported_output_config_error(exc: Exception) -> bool:
    text = str(exc).lower()
    output_config_hint = "output_config" in text or "effort parameter" in text
    return output_config_hint and any(
        marker in text
        for marker in ("unknown", "invalid", "unexpected", "not allowed", "does not support")
    )


def _is_unsupported_thinking_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "thinking" in text and any(
        marker in text
        for marker in ("not supported", "unsupported", "invalid_request_error", "not available")
    )


def _is_retryable_request_error(exc: Exception) -> bool:
    if isinstance(exc, TimeoutError):
        return True
    # Anthropic SDK/network errors can vary by version; rely on stable type names.
    retryable_type_names = {
        "APITimeoutError",
        "APIConnectionError",
        "RateLimitError",
        "InternalServerError",
    }
    return exc.__class__.__name__ in retryable_type_names


def _is_context_overflow_error(exc: Exception) -> bool:
    text = str(exc).lower()
    if not any(marker in text for marker in ("invalid_request_error", "badrequesterror", "400")):
        return False
    return any(
        marker in text
        for marker in (
            "prompt is too long",
            "context",
            "tokens >",
            "maximum",
            "too many tokens",
            "exceed",
        )
    )


def _estimate_messages_chars(messages: list[dict[str, Any]]) -> int:
    total = 0
    for message in messages:
        try:
            total += len(json.dumps(message, ensure_ascii=False, default=str))
        except TypeError:
            total += len(str(message))
    return total


def _compact_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(messages) <= _COMPACT_KEEP_RECENT_MESSAGES + 1:
        return messages
    head = messages[0]
    tail = messages[-_COMPACT_KEEP_RECENT_MESSAGES:]
    marker = {
        "role": "user",
        "content": (
            "Context window guard: earlier turns were omitted to fit model limits. "
            "Continue from the latest context and rerun tools if older details are needed."
        ),
    }
    return [head, marker, *tail]


def _format_request_error(exc: Exception, request_timeout_seconds: int) -> str:
    if isinstance(exc, TimeoutError):
        return f"TimeoutError: request timed out after {request_timeout_seconds}s"
    detail = str(exc).strip()
    if detail:
        return f"{exc.__class__.__name__}: {detail}"
    return exc.__class__.__name__


def _can_parallelize_tool_calls(tool_calls: list[dict[str, Any]]) -> bool:
    if len(tool_calls) <= 1:
        return False
    return all(call["name"] in SAFE_PARALLEL_TOOL_NAMES for call in tool_calls)


async def _execute_single_tool_call(
    *,
    call: dict[str, Any],
    execute_tool: Callable[[str, dict[str, Any]], Awaitable[str]],
    guard_state: LoopGuardState,
    tool_call_timeout_seconds: int,
) -> tuple[str, str]:
    signature = tool_signature(call["name"], call["input"])
    try:
        guard_state.add_tool_call(signature)
        if tool_call_timeout_seconds > 0:
            output = await asyncio.wait_for(
                execute_tool(call["name"], call["input"]),
                timeout=float(tool_call_timeout_seconds),
            )
        else:
            output = await execute_tool(call["name"], call["input"])
        guard_state.mark_tool_success()
    except GuardrailStopError:
        raise
    except TimeoutError:
        try:
            guard_state.mark_tool_failure()
        except GuardrailStopError:
            raise
        output = f"Tool error: timeout after {tool_call_timeout_seconds}s"
    except Exception as exc:
        try:
            guard_state.mark_tool_failure()
        except GuardrailStopError:
            raise
        output = f"Tool error: {exc}"
    return call["id"], _truncate(output)


async def _execute_tool_calls_parallel(
    *,
    tool_calls: list[dict[str, Any]],
    execute_tool: Callable[[str, dict[str, Any]], Awaitable[str]],
    guard_state: LoopGuardState,
    max_parallel_tool_calls: int,
    tool_call_timeout_seconds: int,
) -> list[tuple[str, str]]:
    semaphore = asyncio.Semaphore(max(1, max_parallel_tool_calls))

    async def run_one(call: dict[str, Any]) -> tuple[str, str]:
        async with semaphore:
            return await _execute_single_tool_call(
                call=call,
                execute_tool=execute_tool,
                guard_state=guard_state,
                tool_call_timeout_seconds=tool_call_timeout_seconds,
            )

    return await asyncio.gather(*(run_one(call) for call in tool_calls))


EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


async def _noop_event(_: dict[str, Any]) -> None:
    return


async def run_agent_loop(
    *,
    api_key: str,
    model: str,
    max_tokens: int,
    system_prompt: str,
    user_prompt: str,
    tools: list[dict[str, Any]],
    execute_tool: Callable[[str, dict[str, Any]], Awaitable[str]] | None,
    guard_state: LoopGuardState,
    effort: str = "max",
    max_parallel_tool_calls: int = 4,
    tool_call_timeout_seconds: int = 180,
    request_timeout_seconds: int = 240,
    on_event: EventCallback | None = None,
    fail_soft_on_budget: bool = False,
) -> AgentLoopResult:
    try:
        from anthropic import AsyncAnthropic
    except Exception as exc:  # pragma: no cover
        raise AgentLoopError("anthropic package is required for engineer loop") from exc

    if not api_key:
        raise AgentLoopError("Missing ANTHROPIC_API_KEY")

    emit = on_event or _noop_event
    client = AsyncAnthropic(api_key=api_key)
    messages: list[dict[str, Any]] = [{"role": "user", "content": user_prompt}]
    last_stop_reason = "unknown"
    last_text = ""
    total_input_tokens = 0
    total_output_tokens = 0

    create_kwargs: dict[str, Any] = {
        "model": model,
        "max_tokens": max_tokens,
        "system": [
            {
                "type": "text",
                "text": system_prompt,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        "thinking": {"type": "adaptive"},
        "output_config": {"effort": effort},
    }
    if tools:
        create_kwargs["tools"] = tools

    while True:
        try:
            guard_state.check_turn()
        except GuardrailStopError as exc:
            if fail_soft_on_budget and "max turns" in str(exc).lower():
                return AgentLoopResult(
                    text=last_text,
                    turns=guard_state.turns,
                    tool_calls=guard_state.tool_calls,
                    stop_reason="turn_budget_exceeded",
                    input_tokens=total_input_tokens,
                    output_tokens=total_output_tokens,
                )
            raise AgentLoopError(str(exc)) from exc

        if _estimate_messages_chars(messages) > _MAX_HISTORY_CHARS:
            messages = _compact_messages(messages)

        response = None
        max_attempts = 2
        for attempt in range(1, max_attempts + 1):
            try:
                async with asyncio.timeout(float(request_timeout_seconds)):
                    async with client.messages.stream(
                        **create_kwargs,
                        messages=cast(Any, messages),
                    ) as stream:
                        response = await stream.get_final_message()
                break
            except Exception as exc:
                if "output_config" in create_kwargs and _is_unsupported_output_config_error(exc):
                    create_kwargs.pop("output_config", None)
                    break
                if "thinking" in create_kwargs and _is_unsupported_thinking_error(exc):
                    create_kwargs.pop("thinking", None)
                    break
                if _is_context_overflow_error(exc) and attempt < max_attempts:
                    messages = _compact_messages(messages)
                    await asyncio.sleep(0.5)
                    continue
                if _is_context_overflow_error(exc):
                    raise AgentLoopError(
                        "Model request exceeded context window after compaction. "
                        "Reduce prompt/diff size and retry."
                    ) from exc
                if _is_retryable_request_error(exc) and attempt < max_attempts:
                    await asyncio.sleep(1.0)
                    continue
                detail = _format_request_error(exc, request_timeout_seconds)
                raise AgentLoopError(f"Model request failed: {detail}") from exc
        if response is None:
            continue

        last_stop_reason = str(getattr(response, "stop_reason", "unknown"))
        content_blocks = list(getattr(response, "content", []))
        tool_calls = extract_tool_uses(content_blocks)
        candidate_text = _extract_text(content_blocks)
        if candidate_text:
            last_text = candidate_text

        assistant_blocks = to_assistant_blocks(content_blocks)
        usage_payload: dict[str, int] | None = None
        if hasattr(response, "usage") and response.usage:
            usage_payload = {
                "input_tokens": int(getattr(response.usage, "input_tokens", 0) or 0),
                "output_tokens": int(getattr(response.usage, "output_tokens", 0) or 0),
                "cache_read_input_tokens": int(
                    getattr(response.usage, "cache_read_input_tokens", 0) or 0
                ),
                "cache_creation_input_tokens": int(
                    getattr(response.usage, "cache_creation_input_tokens", 0) or 0
                ),
            }
            total_input_tokens += (
                usage_payload["input_tokens"]
                + usage_payload["cache_read_input_tokens"]
                + usage_payload["cache_creation_input_tokens"]
            )
            total_output_tokens += usage_payload["output_tokens"]
        await emit(
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": assistant_blocks,
                    "model": getattr(response, "model", None),
                    "usage": usage_payload,
                },
            }
        )

        if tool_calls:
            if execute_tool is None:
                raise AgentLoopError("Model requested tools but no executor was provided")

            messages.append({"role": "assistant", "content": assistant_blocks})

            try:
                if _can_parallelize_tool_calls(tool_calls):
                    tool_results = await _execute_tool_calls_parallel(
                        tool_calls=tool_calls,
                        execute_tool=execute_tool,
                        guard_state=guard_state,
                        max_parallel_tool_calls=max_parallel_tool_calls,
                        tool_call_timeout_seconds=tool_call_timeout_seconds,
                    )
                else:
                    tool_results = []
                    for call in tool_calls:
                        tool_results.append(
                            await _execute_single_tool_call(
                                call=call,
                                execute_tool=execute_tool,
                                guard_state=guard_state,
                                tool_call_timeout_seconds=tool_call_timeout_seconds,
                            )
                        )
            except GuardrailStopError as exc:
                if fail_soft_on_budget and "max turns" in str(exc).lower():
                    return AgentLoopResult(
                        text=last_text,
                        turns=guard_state.turns,
                        tool_calls=guard_state.tool_calls,
                        stop_reason="turn_budget_exceeded",
                        input_tokens=total_input_tokens,
                        output_tokens=total_output_tokens,
                    )
                raise AgentLoopError(str(exc)) from exc

            result_blocks = build_tool_result_blocks(list(tool_results))
            await emit({"type": "tool", "content": result_blocks})
            messages.append({"role": "user", "content": result_blocks})
            continue

        text = candidate_text
        # Continuation handling per Anthropic best practices
        if not _last_user_message_is_continuation(messages):
            if not text and last_stop_reason == "end_turn":
                # Empty response: send continuation prompt (do not retry same request)
                messages.append({"role": "user", "content": "Please continue."})
                continue
            if last_stop_reason == "max_tokens":
                # Truncated: append partial assistant, then continuation prompt
                messages.append({"role": "assistant", "content": assistant_blocks})
                messages.append({"role": "user", "content": "Please continue."})
                continue

        return AgentLoopResult(
            text=text,
            turns=guard_state.turns,
            tool_calls=guard_state.tool_calls,
            stop_reason=last_stop_reason,
            input_tokens=total_input_tokens,
            output_tokens=total_output_tokens,
        )
