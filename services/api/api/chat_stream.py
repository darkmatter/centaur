"""Project canonical agent events into Vercel Chat SDK stream chunks.

The output of this module intentionally matches Chat SDK's ``StreamChunk``
surface: ``markdown_text``, ``task_update``, and ``plan_update``. Platform
renderers should be able to pass these chunks directly to ``thread.post()``
without understanding the harness that produced them.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shlex
from typing import Any

CHAT_STREAM_EVENT_KIND = "chat_stream_chunk"
CHAT_STREAM_CHUNK_TYPES = frozenset({"markdown_text", "task_update", "plan_update"})
DEFAULT_CLAUDE_CODE_MODEL = "claude-opus-4-8"

_TERMINAL_EVENT_TYPES = frozenset(
    {"turn.done", "turn.completed", "execution_state", "result"}
)


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _stable_id(prefix: str, *values: Any) -> str:
    payload = json.dumps(values, sort_keys=True, separators=(",", ":"), default=str)
    digest = hashlib.sha1(payload.encode("utf-8")).hexdigest()[:12]
    return f"{prefix}:{digest}"


def _format_json(value: Any) -> str:
    try:
        return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False)
    except Exception:
        return str(value)


def _format_output(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value
        stripped = text.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            try:
                return _format_json(json.loads(stripped))
            except Exception:
                return text
        return text
    return _format_json(value)


def _one_line(value: str, limit: int = 120) -> str:
    normalized = re.sub(r"\s+", " ", value).strip()
    if len(normalized) <= limit:
        return normalized
    return normalized[: max(limit - 3, 1)] + "..."


def _task_status(value: Any, *, done: bool = False, failed: bool = False) -> str:
    if failed:
        return "error"
    raw = str(value or "").strip().lower()
    if raw in {"pending", "queued"}:
        return "pending"
    if raw in {
        "running",
        "working",
        "started",
        "inprogress",
        "in_progress",
        "progress",
    }:
        return "in_progress"
    if raw in {"failed", "failure", "error", "errored", "declined"}:
        return "error"
    if raw in {"completed", "complete", "done", "success", "succeeded"}:
        return "complete"
    return "complete" if done else "in_progress"


def _chat_text_chunk(text: str) -> dict[str, Any] | None:
    if not text:
        return None
    return {"type": "markdown_text", "text": text}


def _overlay_label(image: str | None) -> str | None:
    if not image:
        return None
    tail = image.rsplit("/", 1)[-1].strip()
    return tail or "overlay"


def runtime_model_label(
    *,
    harness: str | None,
    engine: str | None,
    model: str | None = None,
) -> str | None:
    explicit = model.strip() if isinstance(model, str) else ""
    if explicit:
        return explicit
    normalized = (engine or harness or "").strip().lower()
    if normalized == "claude-code":
        return (os.getenv("CLAUDE_MODEL") or DEFAULT_CLAUDE_CODE_MODEL).strip()
    return None


def runtime_header_chunk(
    *,
    harness: str | None,
    engine: str | None,
    persona_id: str | None,
    model: str | None = None,
    overlay_image: str | None = None,
) -> dict[str, Any] | None:
    """Return the compact top-of-stream runtime header for Chat SDK renderers."""

    labels = [persona_id or "base", engine or harness or "unknown"]
    model_label = runtime_model_label(harness=harness, engine=engine, model=model)
    if model_label:
        labels.append(model_label)
    overlay = _overlay_label(overlay_image)
    if overlay:
        labels.append(overlay)
    text = " · ".join(label for label in labels if label)
    return _chat_text_chunk(f"_{text}_\n\n") if text else None


def _task_update(
    *,
    task_id: str,
    title: str,
    status: str,
    output: str | None = None,
) -> dict[str, Any]:
    chunk: dict[str, Any] = {
        "type": "task_update",
        "id": task_id,
        "title": _one_line(title) or "Task",
        "status": status,
    }
    if output:
        chunk["output"] = output
    return chunk


def _content_blocks(event: dict[str, Any]) -> list[dict[str, Any]]:
    message = _as_dict(event.get("message"))
    return [_as_dict(block) for block in _as_list(message.get("content"))]


def _assistant_event_looks_canonical(event: dict[str, Any]) -> bool:
    message = _as_dict(event.get("message"))
    return bool(
        event.get("uuid")
        or event.get("request_id")
        or event.get("session_id")
        or message.get("id")
        or message.get("model")
        or message.get("usage")
    )


def _tool_title(name: str, tool_input: dict[str, Any]) -> str:
    if name == "Bash":
        command = _as_str(tool_input.get("command")) or _as_str(tool_input.get("cmd"))
        return _command_title(command)
    if name == "Read":
        path = _as_str(tool_input.get("file_path")) or _as_str(tool_input.get("path"))
        return f"Read {path}" if path else "Read file"
    if name in {"create_file", "write_file"}:
        return "Create file"
    if name in {"edit_file", "apply_patch"}:
        return "Edit file"
    return f"Use {name or 'tool'}"


def _tool_start_output(name: str, tool_input: dict[str, Any]) -> str:
    if name == "Bash":
        return ""
    if not tool_input:
        return ""
    return f"```json\n{_format_json(tool_input)}\n```"


def _agent_message_event_id(event: dict[str, Any]) -> str:
    item = _as_dict(event.get("item"))
    return (
        _as_str(event.get("itemId"))
        or _as_str(event.get("item_id"))
        or _as_str(item.get("id"))
    )


def _agent_message_phase(item: dict[str, Any]) -> str | None:
    phase = _as_str(item.get("phase")).strip().lower()
    if phase == "commentary":
        return "commentary"
    if phase in {"final_answer", "finalanswer", "answer"}:
        return "final_answer"
    return None


def _extract_delta_text(event: dict[str, Any]) -> str:
    delta = event.get("delta", event.get("text", event.get("content", "")))
    if isinstance(delta, dict):
        return _as_str(delta.get("text")) or _as_str(delta.get("content"))
    return _as_str(delta)


def _terminal_result_text(event: dict[str, Any]) -> str:
    for key in ("result", "result_text", "text", "final_text", "error_text"):
        text = _as_str(event.get(key)).strip()
        if text:
            return text
    return ""


def _command_id(item: dict[str, Any]) -> str:
    return (
        _as_str(item.get("id"))
        or _as_str(item.get("itemId"))
        or _as_str(item.get("item_id"))
        or _as_str(item.get("command_id"))
        or _stable_id(
            "command",
            item.get("command"),
            item.get("aggregated_output"),
            item.get("output"),
        )
    )


def _display_command(command: str) -> str:
    command = command.strip()
    if not command:
        return ""
    try:
        parts = shlex.split(command)
    except ValueError:
        return command

    if len(parts) >= 3 and parts[1] == "-lc":
        shell = parts[0].rsplit("/", 1)[-1]
        if shell in {"bash", "sh", "zsh"}:
            return parts[2]

    if len(parts) >= 4 and parts[0].rsplit("/", 1)[-1] == "env" and parts[2] == "-lc":
        shell = parts[1].rsplit("/", 1)[-1]
        if shell in {"bash", "sh", "zsh"}:
            return parts[3]

    return command


def _command_title(command: str, fallback: str = "Command") -> str:
    return _display_command(command) or fallback


def _command_output(command: str, output: str, exit_code: Any = None) -> str:
    parts: list[str] = []
    if exit_code not in (None, 0, "0"):
        prefix = f"exit code {exit_code}"
        parts.append(prefix if not output else f"{prefix}\n{output}")
    elif output:
        parts.append(output)
    return "\n\n".join(parts)


def _command_item_output(item: dict[str, Any]) -> str:
    for key in ("aggregated_output", "aggregatedOutput", "output", "stdout", "stderr"):
        value = _as_str(item.get(key))
        if value:
            return value
    return ""


def _command_chunk_from_item(
    item: dict[str, Any],
    *,
    event_type: str,
    output_override: str | None = None,
) -> dict[str, Any]:
    command = _as_str(item.get("command"))
    status = _task_status(
        item.get("status"),
        done=event_type == "item.completed",
        failed=event_type == "item.completed"
        and item.get("exit_code", item.get("exitCode")) not in (None, 0, "0"),
    )
    output = (
        output_override if output_override is not None else _command_item_output(item)
    )
    return _task_update(
        task_id=_command_id(item),
        title=_command_title(command),
        status=status,
        output=_command_output(
            command, output, item.get("exit_code", item.get("exitCode"))
        ),
    )


def _file_change_title(changes: list[Any]) -> str:
    paths = []
    for change in changes:
        path = _as_str(_as_dict(change).get("path"))
        if path and path not in paths:
            paths.append(path)
    if len(paths) == 1:
        return f"Edit {paths[0]}"
    if len(paths) > 1:
        return f"Edit {len(paths)} files"
    return "Apply file changes"


def _file_change_output(changes: list[Any]) -> str:
    rendered: list[str] = []
    for change in changes:
        record = _as_dict(change)
        path = _as_str(record.get("path"))
        diff = _as_str(record.get("diff")) or _as_str(record.get("unified_diff"))
        if path and diff:
            rendered.append(f"{path}\n```diff\n{diff}\n```")
        elif path:
            rendered.append(path)
        elif diff:
            rendered.append(f"```diff\n{diff}\n```")
    return "\n\n".join(rendered)


def _plan_step_title(value: Any) -> str:
    if isinstance(value, dict):
        return (
            _as_str(value.get("step"))
            or _as_str(value.get("title"))
            or _as_str(value.get("description"))
            or "Plan step"
        )
    return _as_str(value) or "Plan step"


class ChatStreamProjector:
    """Stateful canonical-event to Chat SDK chunk projector."""

    def __init__(self) -> None:
        self._answer_chars = 0
        self._assistant_answer_text = ""
        self._terminal_result_text = ""
        self._tool_titles: dict[str, str] = {}
        self._open_tasks: dict[str, str] = {}
        self._reasoning_text = ""
        self._last_markdown_tail = ""
        self._pending_text_separator = False
        self._agent_message_phase: str | None = None
        self._agent_message_phase_by_id: dict[str, str] = {}
        self._agent_text_by_id: dict[str, str] = {}
        self._command_output_by_id: dict[str, str] = {}

    def project(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        event_type = _as_str(event.get("type"))
        chunks: list[dict[str, Any]] = []

        if event_type == "assistant":
            chunks.extend(self._project_assistant(event))
        elif event_type == "tool":
            chunks.extend(self._project_tool_results(event))
        elif event_type == "reasoning":
            chunks.extend(self._project_reasoning(event))
        elif event_type == "command_execution":
            chunks.append(self._project_command_execution(event))
        elif event_type == "file_change":
            chunks.append(self._project_file_change(event))
        elif event_type == "subagent":
            chunks.append(self._project_subagent(event))
        elif event_type == "turn.plan.updated":
            chunks.extend(self._project_structured_plan(event))
        elif event_type in {"item.started", "item.updated", "item.completed"}:
            chunks.extend(self._project_codex_item_event(event))
        elif event_type == "item.agentMessage.delta":
            chunk = self._project_codex_agent_message_delta(event)
            if chunk:
                chunks.append(chunk)
        elif event_type == "item.commandExecution.outputDelta":
            chunk = self._project_codex_command_output_delta(event)
            if chunk:
                chunks.append(chunk)
        elif event_type == "item.plan.delta":
            text = _extract_delta_text(event).strip()
            if text:
                chunks.append({"type": "plan_update", "title": _one_line(text)})
        elif event_type == "result":
            text = _terminal_result_text(event)
            if text:
                self._terminal_result_text = text
        elif event_type == "error":
            chunks.append(
                _task_update(
                    task_id=_stable_id("error", event.get("error")),
                    title="Execution error",
                    status="error",
                    output=_as_str(event.get("error")) or "Unknown error",
                )
            )

        if event_type in _TERMINAL_EVENT_TYPES:
            chunks.extend(self._project_terminal(event))

        normalized: list[dict[str, Any]] = []
        for chunk in chunks:
            prepared = self._prepare_chunk(chunk)
            if prepared and self.is_chat_stream_chunk(prepared):
                normalized.append(prepared)
        return normalized

    @staticmethod
    def is_chat_stream_chunk(chunk: dict[str, Any]) -> bool:
        chunk_type = _as_str(chunk.get("type"))
        if chunk_type == "markdown_text":
            return isinstance(chunk.get("text"), str)
        if chunk_type == "plan_update":
            return isinstance(chunk.get("title"), str)
        if chunk_type == "task_update":
            return (
                isinstance(chunk.get("id"), str)
                and isinstance(chunk.get("title"), str)
                and chunk.get("status")
                in {"pending", "in_progress", "complete", "error"}
            )
        return False

    def _prepare_chunk(self, chunk: dict[str, Any]) -> dict[str, Any] | None:
        chunk_type = _as_str(chunk.get("type"))
        if chunk_type == "markdown_text":
            text = _as_str(chunk.get("text"))
            if not text:
                return None
            if (
                self._pending_text_separator
                and self._last_markdown_tail
                and not self._last_markdown_tail[-1].isspace()
                and not text[0].isspace()
            ):
                text = f"\n\n{text}"
            self._pending_text_separator = False
            self._last_markdown_tail = (self._last_markdown_tail + text)[-80:]
            return {**chunk, "text": text}

        if chunk_type in {"task_update", "plan_update"}:
            if self._last_markdown_tail and not self._last_markdown_tail[-1].isspace():
                self._pending_text_separator = True
        return chunk

    def _project_assistant(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        chunks: list[dict[str, Any]] = []
        for block in _content_blocks(event):
            block_type = _as_str(block.get("type"))
            if block_type == "text":
                text = _as_str(block.get("text"))
                chunk = self._assistant_text_chunk(event, text)
                if chunk:
                    chunks.append(chunk)
                continue
            if block_type != "tool_use":
                continue
            tool_id = _as_str(block.get("id")) or _stable_id(
                "tool", block.get("name"), block.get("input")
            )
            name = _as_str(block.get("name")) or "tool"
            tool_input = _as_dict(block.get("input"))
            title = _tool_title(name, tool_input)
            self._tool_titles[tool_id] = title
            self._open_tasks[tool_id] = title
            chunks.append(
                _task_update(
                    task_id=tool_id,
                    title=title,
                    status="in_progress",
                    output=_tool_start_output(name, tool_input),
                )
            )
        return chunks

    def _project_tool_results(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        chunks: list[dict[str, Any]] = []
        for result in _as_list(event.get("content")):
            record = _as_dict(result)
            tool_id = _as_str(record.get("tool_use_id"))
            if not tool_id:
                continue
            title = self._tool_titles.get(tool_id, "Tool result")
            is_error = bool(record.get("is_error"))
            self._open_tasks.pop(tool_id, None)
            chunks.append(
                _task_update(
                    task_id=tool_id,
                    title=title,
                    status="error" if is_error else "complete",
                    output=_format_output(record.get("content")),
                )
            )
        return chunks

    def _project_reasoning(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        text = _as_str(event.get("text"))
        if not text:
            return []
        self._reasoning_text += text
        self._open_tasks["reasoning"] = "Thinking"
        return [
            _task_update(
                task_id="reasoning",
                title="Thinking",
                status="in_progress",
                output=self._reasoning_text,
            )
        ]

    def _project_command_execution(self, event: dict[str, Any]) -> dict[str, Any]:
        command = _as_str(event.get("command"))
        exit_code = event.get("exit_code")
        status = _task_status(
            event.get("status"),
            done=True,
            failed=exit_code not in (None, 0, "0"),
        )
        task_id = _stable_id("command", command)
        self._open_tasks.pop(task_id, None)
        return _task_update(
            task_id=task_id,
            title=_command_title(command),
            status=status,
            output=_command_output(
                command, _as_str(event.get("aggregated_output")), exit_code
            ),
        )

    def _project_file_change(self, event: dict[str, Any]) -> dict[str, Any]:
        changes = _as_list(event.get("changes"))
        return _task_update(
            task_id=_stable_id("file-change", changes),
            title=_file_change_title(changes),
            status="complete",
            output=_file_change_output(changes),
        )

    def _project_subagent(self, event: dict[str, Any]) -> dict[str, Any]:
        subagent_id = _as_str(event.get("subagent_id")) or _stable_id("subagent", event)
        title = _as_str(event.get("name")) or "Subagent"
        status = _task_status(
            event.get("status"), done=_as_str(event.get("status")) == "completed"
        )
        output = (
            _as_str(event.get("error"))
            or _as_str(event.get("summary"))
            or _as_str(event.get("activity"))
        )
        if status in {"complete", "error"}:
            self._open_tasks.pop(f"subagent:{subagent_id}", None)
        else:
            self._open_tasks[f"subagent:{subagent_id}"] = title
        return _task_update(
            task_id=f"subagent:{subagent_id}",
            title=title,
            status=status,
            output=output,
        )

    def _project_structured_plan(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        plan = _as_list(event.get("plan"))
        if not plan:
            return []
        chunks: list[dict[str, Any]] = [
            {"type": "plan_update", "title": "Execution plan"}
        ]
        for index, step in enumerate(plan, start=1):
            record = _as_dict(step)
            status = _task_status(record.get("status"), done=False)
            chunks.append(
                _task_update(
                    task_id=f"plan:{index}",
                    title=_plan_step_title(step),
                    status=status,
                )
            )
        return chunks

    def _project_codex_item_event(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        item = _as_dict(event.get("item"))
        item_type = _as_str(item.get("type"))
        event_type = _as_str(event.get("type"))
        chunks: list[dict[str, Any]] = []

        if item_type in {"agentMessage", "agent_message"}:
            item_id = _agent_message_event_id(event)
            phase = _agent_message_phase(item)
            if phase:
                self._agent_message_phase = phase
                if item_id:
                    self._agent_message_phase_by_id[item_id] = phase
            if event_type == "item.started" and phase == "commentary" and item_id:
                self._open_tasks[f"thinking:{item_id}"] = "Thinking"
                chunks.append(
                    _task_update(
                        task_id=f"thinking:{item_id}",
                        title="Thinking",
                        status="in_progress",
                    )
                )
            if event_type == "item.completed":
                text = _as_str(item.get("text"))
                resolved_phase = phase or self._agent_message_phase_by_id.get(item_id)
                if resolved_phase == "commentary" and item_id:
                    self._agent_text_by_id[item_id] = text
                    self._open_tasks.pop(f"thinking:{item_id}", None)
                    chunks.append(
                        _task_update(
                            task_id=f"thinking:{item_id}",
                            title="Thinking",
                            status="complete",
                            output=text,
                        )
                    )
                elif text:
                    text_chunk = self._codex_final_text_chunk(item_id, text)
                    if text_chunk:
                        chunks.append(text_chunk)
            return chunks

        if item_type in {"commandExecution", "command_execution"}:
            command_id = _command_id(item)
            title = _command_title(_as_str(item.get("command")))
            if event_type != "item.completed":
                self._open_tasks[command_id] = title
            else:
                self._open_tasks.pop(command_id, None)
            chunks.append(_command_chunk_from_item(item, event_type=event_type))
            return chunks

        if item_type in {"fileChange", "file_change"}:
            changes = _as_list(item.get("changes"))
            task_id = (
                _as_str(item.get("id"))
                or _as_str(event.get("itemId"))
                or _as_str(event.get("item_id"))
                or _stable_id("file-change", changes)
            )
            if event_type == "item.completed":
                self._open_tasks.pop(task_id, None)
            else:
                self._open_tasks[task_id] = _file_change_title(changes)
            chunks.append(
                _task_update(
                    task_id=task_id,
                    title=_file_change_title(changes),
                    status=_task_status(
                        item.get("status"), done=event_type == "item.completed"
                    ),
                    output=_file_change_output(changes),
                )
            )
            return chunks

        if item_type == "plan" and event_type == "item.completed":
            text = _as_str(item.get("text")).strip()
            if text:
                chunks.append({"type": "plan_update", "title": _one_line(text)})

        return chunks

    def _project_codex_agent_message_delta(
        self, event: dict[str, Any]
    ) -> dict[str, Any] | None:
        item_id = _agent_message_event_id(event)
        text = _extract_delta_text(event)
        if not item_id or not text:
            return None
        phase = (
            self._agent_message_phase_by_id.get(item_id) or self._agent_message_phase
        )
        self._agent_text_by_id[item_id] = self._agent_text_by_id.get(item_id, "") + text
        if phase == "commentary":
            return _task_update(
                task_id=f"thinking:{item_id}",
                title="Thinking",
                status="in_progress",
                output=self._agent_text_by_id[item_id],
            )
        self._answer_chars += len(text)
        return _chat_text_chunk(text)

    def _assistant_text_chunk(
        self, event: dict[str, Any], text: str
    ) -> dict[str, Any] | None:
        if not text:
            return None
        if _assistant_event_looks_canonical(event):
            previous = self._assistant_answer_text
            if text == previous or previous.endswith(text):
                return None
            if previous and text.startswith(previous):
                delta = text[len(previous) :]
                self._assistant_answer_text = text
                self._answer_chars += len(delta)
                return _chat_text_chunk(delta)
            self._assistant_answer_text = text
        else:
            self._assistant_answer_text += text
        self._answer_chars += len(text)
        return _chat_text_chunk(text)

    def _codex_final_text_chunk(self, item_id: str, text: str) -> dict[str, Any] | None:
        previous = self._agent_text_by_id.get(item_id, "")
        if text == previous or previous.endswith(text):
            self._agent_text_by_id[item_id] = text
            return None
        if previous and text.startswith(previous):
            delta = text[len(previous) :]
            self._agent_text_by_id[item_id] = text
            self._answer_chars += len(delta)
            return _chat_text_chunk(delta)
        self._agent_text_by_id[item_id] = text
        self._answer_chars += len(text)
        return _chat_text_chunk(text)

    def _project_codex_command_output_delta(
        self, event: dict[str, Any]
    ) -> dict[str, Any] | None:
        command_id = _as_str(event.get("itemId")) or _as_str(event.get("item_id"))
        delta = _as_str(event.get("delta"))
        if not command_id or not delta:
            return None
        output = self._command_output_by_id.get(command_id, "") + delta
        self._command_output_by_id[command_id] = output
        title = self._open_tasks.get(command_id, "Command output")
        self._open_tasks[command_id] = title
        return _task_update(
            task_id=command_id,
            title=title,
            status="in_progress",
            output=output,
        )

    def _project_terminal(self, event: dict[str, Any]) -> list[dict[str, Any]]:
        chunks: list[dict[str, Any]] = []
        text = _terminal_result_text(event) or self._terminal_result_text
        if text and self._answer_chars == 0:
            self._answer_chars += len(text)
            text_chunk = _chat_text_chunk(text)
            if text_chunk:
                chunks.append(text_chunk)
        for task_id, title in list(self._open_tasks.items()):
            chunks.append(
                _task_update(
                    task_id=task_id,
                    title=title,
                    status="complete",
                )
            )
            self._open_tasks.pop(task_id, None)
        return chunks
