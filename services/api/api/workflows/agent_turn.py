"""Workflow: single durable agent turn with optional generated thread key."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from api.runtime_control import ControlPlaneError
from api.workflow_engine import Delivery, WorkflowContext

WORKFLOW_NAME = "agent_turn"


@dataclass
class Input:
    thread_key: str = ""
    parts: list[dict[str, Any]] = field(default_factory=list)
    text: str | None = None
    message_id: str | None = None
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
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


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Spawn -> message -> execute -> wait for a terminal agent result."""
    from api.workflow_engine import do_agent_turn

    thread_key = inp.thread_key.strip() or f"workflow:{ctx.run_id}:agent"
    return await do_agent_turn(
        ctx,
        thread_key=thread_key,
        parts=inp.effective_parts,
        message_id=inp.message_id,
        user_id=inp.user_id,
        metadata=inp.metadata,
        delivery=inp.delivery,
        harness=inp.harness,
        persona=inp.persona,
        agents_md_override=inp.agents_md_override,
    )
