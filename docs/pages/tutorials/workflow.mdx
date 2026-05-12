---
title: Build a Workflow
description: Write durable Python automation that checkpoints, sleeps, retries, and runs agents.
---

# Build a Workflow

Use a workflow when a process must outlive one agent turn: scheduled digests, monitors, approvals, retries, long sleeps, fan-out/fan-in work, or anything that should resume after a worker restart.

## Core idea

The handler is normal Python. The engine replays it after interruptions. Completed `ctx.step(...)` calls return cached results instead of running again.

```diagram
╭──────────────╮      ╭──────────────╮      ╭──────────────╮
│ handler code │─────▶│ checkpoint   │─────▶│ replay skips │
│ runs top→down│      │ each step    │      │ done work    │
╰──────────────╯      ╰──────────────╯      ╰──────────────╯
```

## Minimal workflow

Create `workflows/daily_digest.py`:

```python
"""Workflow: produce a daily topic digest."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from typing import Any

from api.workflow_engine import WorkflowContext

WORKFLOW_NAME = "daily_digest"


@dataclass
class Input:
    topic: str
    max_iterations: int = 1


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    iteration = 0
    last_result: Any = None

    while inp.max_iterations == 0 or iteration < inp.max_iterations:
        iteration += 1
        last_result = await ctx.run_agent(
            f"research_{iteration}",
            text=(
                f"Find the most important developments about {inp.topic} from the last day. "
                "Return five bullets with source links and why each item matters."
            ),
        )

        if inp.max_iterations != 0 and iteration >= inp.max_iterations:
            break

        await ctx.sleep(f"wait_{iteration}", dt.timedelta(days=1))

    return {"iterations": iteration, "last_result": last_result}
```

## Primitives

| Primitive | Use it for |
|-----------|------------|
| `ctx.step(name, fn)` | Run deterministic or external work once and cache the result. |
| `ctx.sleep(name, duration)` | Suspend the workflow for a duration. |
| `ctx.sleep_until(name, when)` | Suspend until a specific timestamp. |
| `ctx.run_agent(name, text=...)` | Run an agent turn and wait for the terminal result. |
| `ctx.start_agent(name, text=...)` | Start an agent turn without waiting. |
| `ctx.wait_for_event(name, event_type, correlation_id)` | Pause until an external event arrives. |
| `ctx.run_workflow(name, workflow_name, input)` | Start a child workflow and wait for it. |

## Validate before deploy

Syntax/import check:

```bash
python3 -m py_compile workflows/daily_digest.py
```

If the workflow imports `api.workflow_engine`, run the check in the API environment or mock that import for a local structural test.

Test the core agent prompt separately through the [Agent API](/api/agent). If the prompt is bad as a one-shot turn, it will be bad inside a workflow too.

## Trigger a run

```bash
curl -s -X POST "https://api.acme.com/workflows/runs" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "workflow_name": "daily_digest",
    "input": {"topic": "ethereum", "max_iterations": 1},
    "trigger_key": "daily-digest-ethereum-smoke"
  }' | python3 -m json.tool
```

Check status:

```bash
curl -s "https://api.acme.com/workflows/runs/<run_id>" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool
```

## Approval pattern

```python
draft = await ctx.run_agent("draft", text="Draft the launch note")

approval = await ctx.wait_for_event(
    "approval",
    event_type="launch.approval",
    correlation_id=f"launch-{ctx.run_id}",
)

final = await ctx.run_agent("final", text=f"Revise this draft with approval payload: {approval}")
```

Wake the workflow:

```bash
curl -s -X POST "https://api.acme.com/workflows/events" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "event_type": "launch.approval",
    "correlation_id": "launch-run_123",
    "payload": {"approved": true, "reviewer": "alice"}
  }'
```

## Checklist

- [ ] `WORKFLOW_NAME` is unique and stable.
- [ ] `Input` dataclass has safe defaults where possible.
- [ ] Step names are deterministic across replay.
- [ ] External side effects are inside `ctx.step(...)` or are idempotent.
- [ ] Long loops have a smoke-test mode such as `max_iterations: 1`.
- [ ] Status and checkpoints were inspected after deploy.
