"""Workflow: daily Paradigm Pulse digest."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any

from api.runtime_control import ControlPlaneError
from api.workflow_engine import Delivery, WorkflowContext

WORKFLOW_NAME = "paradigm_pulse_daily"

# Schedule — set PARADIGM_PULSE_THREAD_KEY to enable.
# Delivery is auto-derived from thread_key; no need to specify channel/thread_ts.
SCHEDULE = {
    "cron": os.getenv("PARADIGM_PULSE_SCHEDULE", "45 7 * * *"),
    "timezone": os.getenv("PARADIGM_PULSE_TIMEZONE", "America/Los_Angeles"),
    "enabled": os.getenv("PARADIGM_PULSE_ENABLED", "1"),
    "thread_key": os.getenv("PARADIGM_PULSE_THREAD_KEY", ""),
    "input": {
        "prompt_selector": os.getenv("PARADIGM_PULSE_PROMPT_SELECTOR", "") or None,
    },
}


@dataclass
class Input:
    thread_key: str = ""
    user_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    delivery: Delivery = field(default_factory=Delivery)
    prompt_selector: str | None = None
    agents_md_override: str | None = None


def _prompt() -> str:
    return (
        "Generate today's Paradigm Pulse digest for Paradigm I&R and "
        "Marketing. Use Centaur tools to gather fresh signals across "
        "Paradigm mentions, Paradigm team activity, portfolio company "
        "momentum, relevant market/news signals, and notable "
        "influential-circle content.\n\n"
        "Output concise Slack-ready markdown with these sections when "
        "there is signal:\n"
        "- News\n"
        "- Trending\n"
        "- Paradigm & Team\n"
        "- Holdings\n"
        "- Influential Circles\n\n"
        "Avoid low-signal filler. Reuse the existing thread context to "
        "avoid repeating items that were already posted recently unless "
        "they changed materially. Prefer links inline and keep the "
        "final answer readable in Slack."
    )


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Generate the daily Paradigm Pulse digest via an agent turn."""
    from api.workflow_engine import do_agent_turn, text_part

    if not inp.thread_key.strip():
        raise ControlPlaneError(
            "INVALID_WORKFLOW_INPUT",
            "paradigm_pulse_daily requires thread_key",
            422,
        )

    return await do_agent_turn(
        ctx,
        thread_key=inp.thread_key.strip(),
        parts=[text_part(_prompt())],
        user_id=inp.user_id,
        metadata={
            **inp.metadata,
            "source": "workflow_schedule",
            "workflow_name": "paradigm_pulse_daily",
        },
        delivery=inp.delivery,
        prompt_selector=inp.prompt_selector,
        agents_md_override=inp.agents_md_override,
    )
