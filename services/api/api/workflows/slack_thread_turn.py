"""Workflow: single agent turn in a Slack thread."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Any

from api.runtime_control import ControlPlaneError
from api.workflow_engine import Delivery, WorkflowContext

WORKFLOW_NAME = "slack_thread_turn"

_RECOVERY_COMMANDS = frozenset(
    {
        "continue",
        "finish the job",
        "please continue",
        "please rerun",
        "please resume",
        "please retry",
        "rerun",
        "resume",
        "retry",
        "run it again",
        "try again",
    }
)
_RECOVERY_NORMALIZE_RE = re.compile(r"[^a-z0-9\s]+")
_RECOVERY_CONTEXT_PREFIX = "Previous unresolved user request from this thread:\n"


@dataclass
class Input:
    thread_key: str = ""
    parts: list[dict[str, Any]] = field(default_factory=list)
    text: str | None = None
    message_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    delivery: Delivery = field(default_factory=Delivery)
    prompt_selector: str | None = None
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


def _normalize_recovery_command(text: str) -> str:
    normalized = _RECOVERY_NORMALIZE_RE.sub(" ", text.lower())
    return " ".join(normalized.split())


def _extract_text_parts(parts: Any) -> str | None:
    if not isinstance(parts, list):
        return None
    snippets = [
        part["text"].strip()
        for part in parts
        if isinstance(part, dict)
        and part.get("type") == "text"
        and isinstance(part.get("text"), str)
        and part["text"].strip()
    ]
    if not snippets:
        return None
    return "\n\n".join(snippets)


def _is_recovery_turn(parts: list[dict[str, Any]]) -> bool:
    text = _extract_text_parts(parts)
    if text is None or len(parts) != 1:
        return False
    return _normalize_recovery_command(text) in _RECOVERY_COMMANDS


async def _lookup_last_unresolved_ask(
    ctx: WorkflowContext,
    *,
    thread_key: str,
    user_id: str | None,
    before_message_id: str | None,
) -> tuple[str | None, dict[str, Any]]:
    """Find the latest substantive prior user ask in this thread.

    Bounded by:
    - the current retry message's created_at (so a delayed/replayed workflow
      cannot pull in a later user's substantive ask), and
    - the same user_id when one is provided (so retries by user A don't
      hydrate from user B's request in the same Slack thread).

    Returns (text, provenance_meta) so the caller can persist where the
    context came from.
    """

    cursor_ts = None
    if before_message_id:
        cursor_row = await ctx._pool.fetchrow(
            "SELECT created_at FROM chat_messages WHERE thread_key = $1 AND id = $2",
            thread_key,
            before_message_id,
        )
        if cursor_row:
            cursor_ts = cursor_row["created_at"]

    where_clauses = ["thread_key = $1", "role = 'user'"]
    params: list[Any] = [thread_key]
    if cursor_ts is not None:
        params.append(cursor_ts)
        where_clauses.append(f"created_at < ${len(params)}")
    if user_id:
        params.append(user_id)
        where_clauses.append(f"user_id = ${len(params)}")

    sql = (
        "SELECT id, parts, created_at, user_id FROM chat_messages "
        f"WHERE {' AND '.join(where_clauses)} "
        "ORDER BY created_at DESC LIMIT 25"
    )
    rows = await ctx._pool.fetch(sql, *params)
    for row in rows:
        text = _extract_text_parts(row["parts"])
        if not text:
            continue
        if _normalize_recovery_command(text) in _RECOVERY_COMMANDS:
            continue
        return text, {
            "hydrated_from_message_id": row["id"],
            "hydrated_from_user_id": row["user_id"],
            "hydrated_from_created_at": (
                row["created_at"].isoformat() if row["created_at"] is not None else None
            ),
        }
    return None, {}


async def _hydrate_recovery_turn(
    ctx: WorkflowContext,
    *,
    thread_key: str,
    parts: list[dict[str, Any]],
    user_id: str | None,
    message_id: str | None,
    metadata: dict[str, Any],
) -> list[dict[str, Any]]:
    if not _is_recovery_turn(parts):
        return parts

    prior_ask, provenance = await _lookup_last_unresolved_ask(
        ctx,
        thread_key=thread_key,
        user_id=user_id,
        before_message_id=message_id,
    )
    if not prior_ask:
        return parts

    if isinstance(metadata, dict):
        metadata.setdefault("recovery_hydration", provenance)

    return [
        {"type": "text", "text": f"{_RECOVERY_CONTEXT_PREFIX}{prior_ask}"},
        *parts,
    ]


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

    parts = await _hydrate_recovery_turn(
        ctx,
        thread_key=thread_key,
        parts=inp.effective_parts,
        user_id=inp.user_id,
        message_id=inp.message_id,
        metadata=inp.metadata,
    )

    return await do_agent_turn(
        ctx,
        thread_key=thread_key,
        parts=parts,
        message_id=inp.message_id,
        user_id=inp.user_id,
        metadata=inp.metadata,
        delivery=inp.delivery,
        prompt_selector=inp.prompt_selector,
        agents_md_override=inp.agents_md_override,
    )
