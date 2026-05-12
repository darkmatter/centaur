# Workflows API

Create, monitor, and manage durable workflow runs. Workflows are checkpoint/replay automations that can sleep, retry, run agents, and survive crashes.

**Base URL:** `https://api.acme.com`

**Auth:** `X-Api-Key: $CENTAUR_API_KEY` or `Authorization: Bearer $CENTAUR_API_KEY`

---

## POST /workflows/runs

Start a new workflow run.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `workflow_name` | string | Yes | Name of the workflow to run (e.g., `"morning_briefing"`). |
| `input` | object | Yes | Input parameters for the workflow handler. |
| `trigger_key` | string | No | Idempotency key — prevents duplicate runs for the same trigger. |
| `eager_start` | bool | No | If `true`, attempt to start the run immediately rather than queueing. |

### Response

```json
{
  "run_id": "run_abc123",
  "status": "queued"
}
```

### Example

```bash
curl -s -X POST https://api.acme.com/workflows/runs \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "workflow_name": "morning_briefing",
    "input": {"topic": "ethereum", "slack_channel": "daily-news"}
  }'
```

---

## GET /workflows/runs

List workflow runs with optional filters.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow_name` | string | No | Filter by workflow name. |
| `status` | string | No | Filter by status: `queued`, `running`, `sleeping`, `waiting`, `completed`, `failed`, `cancelled`. |
| `thread_key` | string | No | Filter by associated thread key. |
| `parent_run_id` | string | No | Filter by parent run (for child workflows). |
| `limit` | int | No | Maximum number of results to return. |

### Example

```bash
# List all running workflows
curl -s "https://api.acme.com/workflows/runs?status=running" \
  -H "X-Api-Key: $CENTAUR_API_KEY"

# List runs for a specific workflow
curl -s "https://api.acme.com/workflows/runs?workflow_name=morning_briefing&limit=10" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## GET /workflows/runs/\{run_id\}

Get detailed status for a workflow run, including checkpoints and what the run is currently waiting on.

### Response

```json
{
  "run_id": "run_abc123",
  "workflow_name": "morning_briefing",
  "status": "running",
  "input": {"topic": "ethereum"},
  "checkpoints": [...],
  "waiting_on": null
}
```

### Example

```bash
curl -s "https://api.acme.com/workflows/runs/run_abc123" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## GET /workflows/runs/\{run_id\}/children

List child workflow runs spawned by a parent run.

### Example

```bash
curl -s "https://api.acme.com/workflows/runs/run_abc123/children" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## GET /workflows/runs/\{run_id\}/checkpoints

Inspect all checkpoints for a run. Each checkpoint represents a completed `ctx.step()` with its cached result.

### Example

```bash
curl -s "https://api.acme.com/workflows/runs/run_abc123/checkpoints" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## POST /workflows/runs/\{run_id\}/cancel

Cancel a workflow run. Idempotent for runs already in a terminal state.

### Example

```bash
curl -s -X POST "https://api.acme.com/workflows/runs/run_abc123/cancel" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{}'
```

---

## POST /workflows/events

Deliver an external event to wake a workflow that is suspended via `ctx.wait_for_event()`. The event is matched by `event_type` and `correlation_id`.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `event_type` | string | Yes | Type of event (must match what the workflow is waiting for). |
| `correlation_id` | string | Yes | Correlation ID to match the waiting workflow step. |
| `payload` | object | No | Arbitrary JSON payload delivered to the workflow. |

### Example

```bash
curl -s -X POST https://api.acme.com/workflows/events \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "event_type": "approval",
    "correlation_id": "review-42",
    "payload": {"approved": true, "reviewer": "alice"}
  }'
```
