---
title: Creating Workflows
description: Add durable Centaur workflows with checkpointed steps, sleeps, events, child workflows, and agent turns.
---

# Creating Workflows

Workflows are Python handlers that run through Centaur's durable workflow
engine. They are useful when the task is longer than one agent turn: polling,
branching, retries, waiting for external events, or coordinating multiple agent
runs.

Put organization workflows in an overlay repo under `workflows/`. See
[Using an overlay](/extend/overlay) for packaging, mount paths, and chart
configuration.

Workflows are loaded from `WORKFLOW_DIRS`. In an overlay deployment, workflow
files must exist under `/app/overlay/org/workflows` in the API container. Files
in those directories are loaded the same way as built-in workflows.

## Define a workflow

Each workflow file exports `WORKFLOW_NAME` and an async `handler(params, ctx)`.
An optional `Input` dataclass gives structured inputs.

```python
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

from api.workflow_engine import WorkflowContext


WORKFLOW_NAME = "nightly_report"


@dataclass
class Input:
    channel: str
    topic: str


async def handler(inp: Input, ctx: WorkflowContext) -> dict[str, Any]:
    data = await ctx.step("collect", lambda: {"topic": inp.topic})
    await ctx.sleep("settle", timedelta(seconds=30))
    result = await ctx.run_agent(
        "summarize",
        text=f"Write a short report about {data['topic']}",
    )
    return {"channel": inp.channel, "report": result}
```

## Durable primitives

| Primitive | Use it for |
|-----------|------------|
| `ctx.step(name, fn)` | Run a side effect once and cache its result. |
| `ctx.sleep(name, duration)` | Suspend and resume later. |
| `ctx.sleep_until(name, when)` | Resume at a specific time. |
| `ctx.wait_for_event(name, event_type, correlation_id)` | Wait for an external event. |
| `ctx.start_workflow(...)` | Start a child workflow and continue immediately. |
| `ctx.wait_for_workflow(...)` | Wait for a child workflow to finish. |
| `ctx.run_workflow(...)` | Start and wait in one call. |
| `ctx.start_agent(...)` | Start an agent turn. |
| `ctx.run_agent(...)` | Start an agent turn and wait for the result. |

The handler may re-execute after a restart. Put external side effects behind
`ctx.step(...)` so completed work is not repeated.

## Run a workflow

Create a run through the API:

```bash
curl -s "$CENTAUR_API_URL/workflows/runs" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "workflow_name": "nightly_report",
    "input": {"channel": "ops", "topic": "open incidents"},
    "eager_start": true
  }' | jq
```

Inspect it:

```bash
curl -s "$CENTAUR_API_URL/workflows/runs/$RUN_ID" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | jq
```

## Verify

After deploying an overlay, check API logs for workflow load events and create a
small run with `eager_start: true`. If the workflow is missing, inspect
`WORKFLOW_DIRS`, the overlay image contents, and whether the file exports
`WORKFLOW_NAME`.
