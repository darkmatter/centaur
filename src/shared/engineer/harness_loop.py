from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from shared.engineer.agent_loop import AgentLoopError, AgentLoopResult

EventCallback = Callable[[dict[str, Any]], Awaitable[None]]


async def _noop_event(_: dict[str, Any]) -> None:
    return


@dataclass
class HarnessRunResult:
    result: AgentLoopResult
    thread_id: str | None


def _build_command(harness: str, prompt: str, thread_id: str | None) -> list[str]:
    if harness == "codex":
        return [
            "codex",
            "exec",
            "--json",
            "--full-auto",
            "--skip-git-repo-check",
            *(["resume", thread_id] if thread_id else []),
            prompt,
        ]
    if harness == "pi-mono":
        return [
            "pi",
            "--mode",
            "json",
            *(["--session", thread_id] if thread_id else []),
            prompt,
        ]
    return [
        "amp",
        "--no-ide",
        "--no-notifications",
        "--dangerously-allow-all",
        "--stream-json",
        *(["threads", "continue", thread_id] if thread_id else []),
        "-x",
        prompt,
    ]


def _extract_result(
    raw_lines: list[str], harness: str, stderr_lines: list[str]
) -> tuple[str, str | None]:
    result_text = ""
    agent_thread_id: str | None = None

    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        if harness == "codex":
            etype = event.get("type", "")
            if etype == "thread.started":
                agent_thread_id = event.get("thread_id")
            elif etype == "item.completed":
                item = event.get("item", {})
                if item.get("type") == "agent_message":
                    result_text = item.get("text", result_text)
            elif etype == "turn.completed":
                for item in event.get("items", []):
                    if item.get("type") == "agent_message":
                        result_text = item.get("text", result_text)
            elif etype == "error":
                result_text = f"❌ {event.get('message', 'Unknown error')}"
            continue

        if harness == "pi-mono":
            etype = event.get("type", "")
            if etype == "session":
                agent_thread_id = event.get("id")
            elif etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for part in msg.get("content", []):
                        if isinstance(part, dict) and part.get("type") == "text":
                            result_text = part.get("text", result_text)
                        elif isinstance(part, str):
                            result_text = part
            elif etype == "agent_end":
                for msg in event.get("messages", []):
                    if msg.get("role") == "assistant":
                        for part in msg.get("content", []):
                            if isinstance(part, dict) and part.get("type") == "text":
                                result_text = part.get("text", result_text)
                            elif isinstance(part, str):
                                result_text = part
            continue

        # amp format
        etype = event.get("type", "")
        if etype == "system" and event.get("subtype") == "init":
            agent_thread_id = event.get("session_id")
        elif etype == "result":
            result_text = event.get("result", result_text)
        elif etype == "assistant" and event.get("message", {}).get("content"):
            for part in event["message"]["content"]:
                if part.get("type") == "text" and part.get("text"):
                    result_text = part["text"]
        elif etype == "error":
            result_text = f"❌ {event.get('error', 'Unknown error')}"

    if not result_text and stderr_lines:
        tail = [line for line in stderr_lines[-10:] if line.strip()]
        if tail:
            result_text = "❌ Harness produced no output. Stderr:\n" + "\n".join(tail)

    return result_text, agent_thread_id


async def run_harness_phase(
    *,
    harness: str,
    system_prompt: str,
    user_prompt: str,
    worktree_root: Path,
    timeout_seconds: int,
    thread_id: str | None = None,
    on_event: EventCallback | None = None,
) -> HarnessRunResult:
    emit = on_event or _noop_event
    prompt = f"{system_prompt}\n\n{user_prompt}"
    cmd = _build_command(harness, prompt, thread_id)

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(worktree_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise AgentLoopError(f"Harness CLI not found for '{harness}': {exc}") from exc

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=float(timeout_seconds))
    except TimeoutError as exc:
        proc.kill()
        await proc.wait()
        raise AgentLoopError(f"Harness '{harness}' timed out after {timeout_seconds}s") from exc

    stdout_text = stdout.decode("utf-8", errors="replace")
    stderr_text = stderr.decode("utf-8", errors="replace")
    raw_lines = stdout_text.splitlines()
    stderr_lines = stderr_text.splitlines()
    result_text, next_thread_id = _extract_result(raw_lines, harness, stderr_lines)

    for line in raw_lines:
        stripped = line.strip()
        if not stripped:
            continue
        try:
            await emit(json.loads(stripped))
        except json.JSONDecodeError:
            await emit({"type": "raw", "text": stripped})

    if proc.returncode not in (0, None) and not result_text:
        result_text = f"❌ Harness exited with code {proc.returncode}"
    if not result_text:
        result_text = "Harness returned no structured output."

    return HarnessRunResult(
        result=AgentLoopResult(text=result_text, turns=1, tool_calls=0, stop_reason="harness"),
        thread_id=next_thread_id or thread_id,
    )
