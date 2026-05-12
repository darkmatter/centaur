# Agent API

The agent lifecycle API: spawn a runtime, send messages, execute, and stream results.

**Base URL:** `https://api.acme.com`

**Auth:** `X-Api-Key: $CENTAUR_API_KEY` or `Authorization: Bearer $CENTAUR_API_KEY`

Most agent routes require `agent:execute` or the broader `agent` scope. Operators
create scoped keys through the [Admin API](/api/admin).

---

## POST /agent/spawn

Assign (or reuse) a runtime for a thread. Returns the current `assignment_generation`, which you pass to subsequent calls.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `thread_key` | string | Yes | Unique identifier for the conversation thread. |
| `harness` | string | No | Agent harness to use. Default: `"amp"`. Options: `amp`, `claude-code`, `codex`. |

### Response

```json
{
  "thread_key": "my-thread-1",
  "runtime_id": "rtm_123",
  "assignment_generation": 12,
  "state": "assigned_idle"
}
```

### Example

```bash
curl -s -X POST https://api.acme.com/agent/spawn \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "thread_key": "my-thread-1",
    "harness": "amp"
  }'
```

---

## POST /agent/message

Persist a user message to the thread transcript. Inline base64 image/document blocks are extracted into attachments and rewritten to lightweight `attachment_ref` parts.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `thread_key` | string | Yes | Thread identifier (must match a spawned thread). |
| `assignment_generation` | int | Yes | Generation returned by `/agent/spawn`. |
| `role` | string | Yes | Message role. Use `"user"`. |
| `parts` | array | Yes | Array of content parts. Each part: `{"type": "text", "text": "..."}`. |
| `user_id` | string | No | Caller's user ID (for audit). |
| `metadata` | object | No | Arbitrary metadata (e.g., `{"user_name": "alice", "platform": "slack"}`). |

### Response

```json
{
  "ok": true,
  "message_id": "msg_123"
}
```

### Example

```bash
curl -s -X POST https://api.acme.com/agent/message \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "thread_key": "my-thread-1",
    "assignment_generation": 12,
    "role": "user",
    "parts": [{"type": "text", "text": "What tools do you have access to?"}]
  }'
```

---

## POST /agent/execute

Enqueue an execution for the thread. The worker drives the attached container; the response is just the execution handle.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `thread_key` | string | Yes | Thread identifier. |
| `assignment_generation` | int | Yes | Generation returned by `/agent/spawn`. |
| `harness` | string | Yes | Agent harness (`"amp"`, `"claude-code"`, `"codex"`). |
| `delivery` | object | Yes | Delivery config. Use `{"platform": "dev"}` for API callers. |

### Response

```json
{
  "ok": true,
  "execution_id": "exe_123",
  "status": "queued"
}
```

### Example

```bash
curl -s -X POST https://api.acme.com/agent/execute \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "thread_key": "my-thread-1",
    "assignment_generation": 12,
    "harness": "amp",
    "delivery": {"platform": "dev"}
  }'
```

---

## GET /agent/threads/\{thread_key\}/events

Stream durable execution events as Server-Sent Events (SSE). On disconnect, reconnect with the last seen event ID. If the execution already finished, the endpoint emits the terminal `execution_state` snapshot.

### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `execution_id` | string | Yes | Execution to stream events for. |
| `after_event_id` | int | No | Resume from this event ID (for reconnect). Use `0` to start from the beginning. |

### Response (SSE stream)

```
event: amp_raw_event
data: {"type":"assistant","message":{...}}

event: turn.done
data: {"type":"turn.done","result":"..."}

event: execution_state
data: {"status":"completed","result_text":"..."}
```

### Example

```bash
curl -s -N "https://api.acme.com/agent/threads/my-thread-1/events?execution_id=exe_123&after_event_id=0" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## GET /agent/executions/\{execution_id\}

Get the current status and details of an execution.

### Example

```bash
curl -s "https://api.acme.com/agent/executions/exe_123" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

---

## POST /agent/executions/\{execution_id\}/cancel

Cancel a running execution. Idempotent for executions already in a terminal state.

### Example

```bash
curl -s -X POST "https://api.acme.com/agent/executions/exe_123/cancel" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{}'
```

---

## POST /agent/threads/\{thread_key\}/release

Release the thread-to-runtime assignment. Optionally cancels any non-terminal execution still tied to this assignment generation.

### Request Body

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `release_id` | string | Yes | Unique identifier for this release operation. |
| `cancel_inflight` | bool | No | If `true`, cancel any running execution on this thread. Default: `false`. |

### Example

```bash
curl -s -X POST "https://api.acme.com/agent/threads/my-thread-1/release" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "release_id": "rel-cleanup-1",
    "cancel_inflight": true
  }'
```

---

## End-to-End Example

A complete conversation loop: spawn a runtime, send a message, execute, and stream the result.

```bash
export CENTAUR_API_KEY="aiv2_your_key_here"
THREAD_KEY="demo-$(date +%s)"

# 1. Spawn — assign a runtime to the thread
SPAWN=$(curl -s -X POST https://api.acme.com/agent/spawn \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")
ASSIGNMENT_GENERATION=$(echo "$SPAWN" | python3 -c "import sys,json; print(json.load(sys.stdin)['assignment_generation'])")

# 2. Message — persist the user turn
curl -s -X POST https://api.acme.com/agent/message \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"What tools do you have access to? List the top 10.\"}]}"

# 3. Execute — enqueue the agent turn
EXECUTE=$(curl -s -X POST https://api.acme.com/agent/execute \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")
EXECUTION_ID=$(echo "$EXECUTE" | python3 -c "import sys,json; print(json.load(sys.stdin)['execution_id'])")

# 4. Stream — tail durable events (reconnect with last event ID on disconnect)
curl -s -N "https://api.acme.com/agent/threads/${THREAD_KEY}/events?execution_id=${EXECUTION_ID}&after_event_id=0" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```
