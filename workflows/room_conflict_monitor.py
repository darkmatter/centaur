"""Workflow: monitors SF conference rooms and alerts #sf-ops-team on double-bookings."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from typing import Any

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "room_conflict_monitor"

ROOM_CALENDARS = [
    "paradigm.xyz_188fm3e1sqa38h6alb7s452fnlu6q6gb74oj0c9o6co3ad9p6k@resource.calendar.google.com",
    "paradigm.xyz_188boiki4jtm2js3n7uq5mfr58k6q6gb74o34cpl70s32chi70@resource.calendar.google.com",
    "paradigm.xyz_188f57ur7em5cimjkten5t7idbboi6ga64sjgd9k6cq36c9p@resource.calendar.google.com",
    "paradigm.xyz_188234cm1s0e2iovm8o8dorookjbi6ga70s32dhn6cpjad1m@resource.calendar.google.com",
    "c_1885pkq3qntfegbci3c612ki3eh6e@resource.calendar.google.com",
    "c_1880lsqsr6ks8irlkssgnfar0if02@resource.calendar.google.com",
]


@dataclass
class Input:
    slack_channel: str = "sf-ops-team"
    check_interval_seconds: int = 60
    lookahead_days: int = 7
    max_iterations: int = 0  # 0 = run forever


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    """Poll all SF conference room calendars and alert on double-bookings."""

    seen_conflict_keys: list[str] = []
    iteration = 0

    while True:
        iteration += 1

        result = await ctx.run_agent(
            f"check_{iteration}",
            text=f"""You are monitoring SF conference rooms for double-bookings. Follow these steps exactly.

ROOMS TO MONITOR:
{chr(10).join(f"- {r}" for r in ROOM_CALENDARS)}

ALREADY-REPORTED CONFLICTS (do NOT alert on these again):
{seen_conflict_keys}

STEPS:

1. For each room calendar above, call the gsuite `calendar_events` tool to fetch all events
   from now through {inp.lookahead_days} days from now.

2. For each room, check every pair of events for a time overlap. Two events overlap when:
     event_a.start < event_b.end  AND  event_a.end > event_b.start

3. For each overlapping pair, compute a conflict key:
     "<calendar_id>::<sorted_event_id_1>|<sorted_event_id_2>"
   (sort the two event IDs alphabetically before joining)

4. Skip any conflict key that appears in the ALREADY-REPORTED CONFLICTS list above.

5. For each NEW conflict:
   a. Determine which event is newer by comparing their `created` timestamps.
      The newer event is the "new booking" (the one causing the conflict).
   b. Post a Slack message to channel #{inp.slack_channel} in this exact format:

      🚨 *Room Conflict Detected*
      *Room:* <room calendar summary/name>
      *New booking by:* <organizer display name of the newer event>
      *Event:* "<newer event title>"
      *Time:* <day of week, date, start time – end time in PT>
      *Conflicts with:* "<older event title>" (organized by <older event organizer>)

6. Return a JSON object with exactly this key:
   {{"new_conflict_keys": ["key1", "key2", ...]}}

   If there are no new conflicts, return {{"new_conflict_keys": []}}
""",
        )

        # Accumulate seen conflicts so we never double-alert
        if isinstance(result, dict):
            new_keys = result.get("new_conflict_keys", [])
            if isinstance(new_keys, list):
                for k in new_keys:
                    if k not in seen_conflict_keys:
                        seen_conflict_keys.append(k)

        if inp.max_iterations > 0 and iteration >= inp.max_iterations:
            return {"status": "done", "iterations": iteration}

        await ctx.sleep(
            f"wait_{iteration}",
            dt.timedelta(seconds=inp.check_interval_seconds),
        )
