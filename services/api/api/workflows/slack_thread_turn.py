"""Workflow: single agent turn in a Slack thread."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any

from api.runtime_control import ControlPlaneError
from api.workflow_engine import Delivery, WorkflowContext

WORKFLOW_NAME = "slack_thread_turn"

_EXECUTION_HARNESSES = frozenset({"amp", "claude-code", "codex", "pi-mono"})
_PROMPT_FLAG_ALIASES = {
    "claude": "claude-code",
    "pi": "pi-mono",
}
_PROMPT_FLAG_SKIP = frozenset({"engine", "model", "opus", "sonnet", "haiku"})
_PROMPT_FLAG_VALUE_SKIP = frozenset({"engine", "model"})
_PROMPT_FLAG_RE = re.compile(
    r"(^|\s)(`?)(--|[\u2013\u2014])([a-z][a-z0-9-]*)(?=\s|`|$)",
    re.IGNORECASE,
)
_BARE_PERSONA_PROMPT = (
    "Briefly introduce yourself using your active persona instructions and ask what "
    "we should work on."
)
_PROMPT_SWITCH_CONTEXT_NOTE = (
    "You are being invoked mid-thread with a new active persona. Use the preceding "
    "Slack thread history as context, then answer the latest user request in that persona."
)


@dataclass(frozen=True)
class PromptSelection:
    """Result of parsing ``--harness``/``--persona`` flags from a Slack turn.

    Both fields are optional and orthogonal: ``--invest`` sets only
    ``persona``, ``--claude`` sets only ``harness``, and ``--invest --claude``
    sets both. The downstream resolver applies ``harness`` as the engine
    override and ``persona`` as the system-prompt overlay.
    """

    harness: str | None
    persona: str | None
    parts: list[dict[str, Any]]


@dataclass
class Input:
    thread_key: str = ""
    parts: list[dict[str, Any]] = field(default_factory=list)
    text: str | None = None
    message_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    history_messages: list[dict[str, Any]] = field(default_factory=list)
    delivery: Delivery = field(default_factory=Delivery)
    harness: str | None = None
    persona: str | None = None
    agents_md_override: str | None = None

    @property
    def effective_parts(self) -> list[dict[str, Any]]:
        if self.parts:
            return [p for p in self.parts if isinstance(p, dict)]
        if self.text and self.text.strip():
            return [{"type": "text", "text": self.text.strip()}]
        raise ControlPlaneError(
            "INVALID_WORKFLOW_INPUT",
            "workflow input must include non-empty parts or text",
            422,
        )


def _known_personas() -> set[str]:
    try:
        from api.app import get_tool_manager

        return set(get_tool_manager().personas)
    except Exception:
        # Workflow unit tests and early startup paths may not have the app-level
        # tool manager available. Harness selectors still work; persona
        # selectors will be validated once the app is fully loaded.
        return set()


def _strip_ranges(text: str, ranges: list[tuple[int, int]]) -> str:
    cleaned = text
    for start, end in sorted(ranges, reverse=True):
        cleaned = f"{cleaned[:start]} {cleaned[end:]}"
    return re.sub(r"\s+", " ", cleaned).strip()


def _extend_value_skip(text: str, end: int) -> int:
    match = re.match(r"\s+[A-Za-z0-9._/-]+", text[end:])
    return end + match.end() if match else end


def _classify_flag(flag: str, personas: set[str]) -> tuple[str | None, str | None]:
    """Map a flag name to ``(harness, persona)``; ``(None, None)`` if unknown."""
    resolved = _PROMPT_FLAG_ALIASES.get(flag, flag)
    if resolved in _EXECUTION_HARNESSES:
        return resolved, None
    if resolved in personas or flag in personas:
        return None, resolved
    return None, None


def _extract_prompt_selection_from_text(
    text: str,
    *,
    personas: set[str],
) -> tuple[str | None, str | None, str]:
    """Strip known flags and return ``(harness, persona, cleaned_text)``."""

    harness: str | None = None
    persona: str | None = None
    ranges: list[tuple[int, int]] = []
    for match in _PROMPT_FLAG_RE.finditer(text):
        leading = match.group(1) or ""
        opening_tick = match.group(2) or ""
        marker = match.group(3) or ""
        flag = match.group(4).lower()

        flag_start = match.start() + len(leading) + len(opening_tick)
        flag_end = flag_start + len(marker) + len(flag)
        strip_start = flag_start - len(opening_tick) if opening_tick else flag_start
        strip_end = (
            flag_end + 1 if flag_end < len(text) and text[flag_end] == "`" else flag_end
        )
        if flag in _PROMPT_FLAG_VALUE_SKIP:
            strip_end = _extend_value_skip(text, strip_end)
        closing_tick = -1
        if opening_tick and strip_end < len(text):
            if text[strip_end] == "`":
                strip_end += 1
            else:
                closing_tick = text.find("`", strip_end)

        is_skip = flag in _PROMPT_FLAG_SKIP
        classified_harness, classified_persona = _classify_flag(flag, personas)
        recognized = is_skip or classified_harness or classified_persona
        if not recognized:
            continue

        ranges.append((strip_start, strip_end))
        if closing_tick > strip_end:
            ranges.append((closing_tick, closing_tick + 1))
        if classified_harness:
            harness = classified_harness
        if classified_persona:
            persona = classified_persona

    cleaned = _strip_ranges(text, ranges) if ranges else text.strip()
    return harness, persona, cleaned


def _extract_prompt_selection(
    parts: list[dict[str, Any]],
    *,
    explicit_harness: str | None = None,
    explicit_persona: str | None = None,
    personas: set[str] | None = None,
) -> PromptSelection:
    """Strip ``--harness``/``--persona`` flags and return what survived.

    Caller-supplied ``explicit_harness``/``explicit_persona`` win over any
    flag the user typed inline.
    """
    known_personas = personas if personas is not None else _known_personas()
    harness: str | None = None
    persona: str | None = None
    cleaned_parts: list[dict[str, Any]] = []
    has_non_text_part = False

    for part in parts:
        if part.get("type") != "text" or not isinstance(part.get("text"), str):
            cleaned_parts.append(part)
            has_non_text_part = True
            continue

        part_harness, part_persona, cleaned_text = _extract_prompt_selection_from_text(
            part["text"],
            personas=known_personas,
        )
        if part_harness:
            harness = part_harness
        if part_persona:
            persona = part_persona
        if cleaned_text:
            cleaned_parts.append({**part, "text": cleaned_text})

    harness = (explicit_harness or harness or "").strip().lower() or None
    persona = (explicit_persona or persona or "").strip().lower() or None
    if harness:
        harness = _PROMPT_FLAG_ALIASES.get(harness, harness)

    # A bare persona selector with no remaining prose deserves a friendly
    # intro turn instead of failing the workflow.
    if persona and not harness and not cleaned_parts and not has_non_text_part:
        cleaned_parts.append({"type": "text", "text": _BARE_PERSONA_PROMPT})

    # Do not turn a model-only hint like "--opus" into an invalid empty turn.
    if not cleaned_parts:
        cleaned_parts = parts

    return PromptSelection(harness=harness, persona=persona, parts=cleaned_parts)


def _with_prompt_switch_context_note(
    parts: list[dict[str, Any]],
    *,
    switched: bool,
    history_messages: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    if not switched or not history_messages:
        return parts
    return [{"type": "text", "text": _PROMPT_SWITCH_CONTEXT_NOTE}, *parts]


async def _release_for_prompt_switch(
    ctx: WorkflowContext,
    *,
    thread_key: str,
    message_id: str | None,
) -> None:
    from api.runtime_control import release_assignment

    release_id = f"prompt-switch:{message_id or ctx.run_id}"
    await release_assignment(
        ctx._pool,
        thread_key=thread_key,
        release_id=release_id,
        cancel_inflight=True,
        stop_runtime_background=True,
    )
    await ctx._pool.execute(
        "UPDATE sandbox_sessions SET "
        "state = 'stopped', "
        "agent_thread_id = NULL, last_delivered_id = NULL, "
        "inflight_turn_id = NULL, inflight_turn_input = NULL, inflight_attempts = 0, "
        "last_result = NULL, last_result_at = NULL, updated_at = NOW() "
        "WHERE thread_key = $1",
        thread_key,
    )


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Spawn → message → execute → wait for terminal result."""
    from api.workflow_engine import do_agent_turn

    thread_key = inp.thread_key.strip()
    if not thread_key:
        raise ControlPlaneError(
            "INVALID_WORKFLOW_INPUT",
            "slack_thread_turn requires thread_key",
            422,
        )

    selection = _extract_prompt_selection(
        inp.effective_parts,
        explicit_harness=inp.harness,
        explicit_persona=inp.persona,
    )
    selection_changed = bool(selection.harness or selection.persona)
    if selection_changed:
        await _release_for_prompt_switch(
            ctx,
            thread_key=thread_key,
            message_id=inp.message_id,
        )

    parts = selection.parts
    parts = _with_prompt_switch_context_note(
        parts,
        switched=selection_changed,
        history_messages=inp.history_messages,
    )
    return await do_agent_turn(
        ctx,
        thread_key=thread_key,
        parts=parts,
        history_messages=inp.history_messages,
        message_id=inp.message_id,
        user_id=inp.user_id,
        metadata=inp.metadata,
        delivery=inp.delivery,
        harness=selection.harness,
        persona=selection.persona,
        agents_md_override=inp.agents_md_override,
    )
