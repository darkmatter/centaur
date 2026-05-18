---
name: qa
description: "Run comprehensive QA and integration tests against the local Centaur stack. Use when asked to QA the stack, run integration tests, verify a deployment, or check stack health after a refactor."
---

# Centaur QA

Test the Centaur stack in three progressive layers — same core operations at each level, proving successively more surface area works.

## Layers

```
Layer 1: Internal API     kubectl exec → API directly. Proves core works.
Layer 2: External route    curl from host → API route. Proves routing + auth.
Layer 3: User Interfaces   Slackbot webhooks + Thread Viewer UI. Proves E2E UX.
```

If layer 1 passes but layer 2 fails → problem is nginx/auth.
If 1+2 pass but 3 fails → problem is slackbot or web app.

## Execution Pipeline

```
┌─────────────────────────┐
│  Layer 1: Internal API  │  ← Run first, sequential. Must pass before continuing.
│  (services, tools,      │
│   agent/execute,        │
│   personas, logs)       │
└──────────┬──────────────┘
           │ all pass
     ┌─────┴──────┬──────────────┐
     ▼            ▼              ▼
┌─────────┐ ┌──────────┐ ┌────────────┐
│ Layer 2  │ │ Layer 3a │ │ Layer 3b   │   ← Parallel subagents
│ Nginx    │ │ Slackbot │ │ Web App    │
│          │ │          │ │ (dogfood)  │
└─────────┘ └──────────┘ └────────────┘
```

Use the **Task** tool to run layers 2, 3a, and 3b as parallel subagents once layer 1 passes.

## Setup

| Parameter | Default | Example override |
|-----------|---------|-----------------|
| **API Key** | Fetch from secrets service (see below) | |
| **Output directory** | `./tool-qa-output/` | `Output directory: /tmp/qa` |
| **Tool scope** | Sample (~10 tools) | `Full tools` or `Focus on slack, linear` |
| **Layer scope** | All three layers | `Just layer 1` or `Layers 1 and 2` |

**Getting the API key:** `API_SECRET_KEY` is NOT in `.env` — it's in the secrets manager. Fetch it:

```bash
API_KEY=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s http://firewall:8081/secrets/API_SECRET_KEY | python3 -c "import sys,json; print(json.load(sys.stdin)['value'])")
```

Use `$API_KEY` (not `$API_SECRET_KEY`) in all curl commands below.

If the user says "QA", "QA the stack", or "health check", start immediately with defaults (sample tools, all layers). Do not ask clarifying questions.

---

## Layer 1: Internal API

All calls via `kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s http://localhost:8000/...` — bypasses external auth, no key needed.

### 1a. Services & Health

```bash
kubectl get pods -n centaur
```

All required local deployments must be Ready: postgres, secrets, iron-proxy/firewall-manager, and api. Slackbot is disabled in the default dev overlay.

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s http://localhost:8000/health/ready
# → {"status":"ok"}
```

### 1b. Tool Testing

Test tools via `POST /tools/{tool}/{method}`.

**Sample mode (default):** ~10 tools across categories for a fast smoke test:

| Tool | Method | Args | Category |
|------|--------|------|----------|
| demo | echo | `{"message":"hello"}` | internal |
| slack | list_channels | `{"limit":2}` | comms |
| linear | issues | `{"limit":2}` | productivity |
| coingecko | get_price | `{"ids":"bitcoin","vs_currencies":"usd"}` | crypto |
| defillama | list_protocols | `{}` | defi |
| googlenews | search | `{"query":"bitcoin","limit":2}` | news |
| congress | list_bills | `{"limit":2}` | gov |
| etherscan | get_balance | `{"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}` | crypto |
| websearch | search | `{"query":"bitcoin","num_results":2}` | research |
| vlogs | query | `{"query":"*","limit":2}` | infra |

Auth failures on etherscan/websearch are known — note but don't block.

**Full mode** (user says "full tools"): Test every registered tool. See [references/test-inputs.md](references/test-inputs.md) for default inputs. Batch by group, append results incrementally.

**Classifying results:**

| Result | Criteria |
|--------|----------|
| ✅ PASS | Non-error response with plausible data |
| ❌ FAIL (auth) | Missing API key, expired token |
| ❌ FAIL (schema) | Column/field name error |
| ❌ FAIL (connection) | Upstream unreachable |
| ❌ FAIL (runtime) | Other runtime error |
| ⏭️ SKIP | Write operation or complex setup |
| ⚠️ WARN | Empty results but no error |

**Rules:** Never call write/mutate methods. Use `limit: 2`. Chain dependent calls. See [references/test-inputs.md](references/test-inputs.md).

### 1c. Agent Execute (connect + execute protocol)

The API uses a two-wire protocol: `/agent/connect` opens a persistent SSE stream, `/agent/execute` injects messages into stdin. Output appears on the connect wire.

**Step 1: Open connect wire** (run in background, write to file):

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- bash -c "curl -s -N -X POST http://localhost:8000/agent/connect \
  -H 'Content-Type: application/json' \
  -d '{\"thread_key\": \"test:qa-execute\", \"harness\": \"amp\"}' \
  > /tmp/sse_qa.txt 2>&1" &
sleep 5
```

**Step 2: Execute a message:**

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d '{"thread_key":"test:qa-execute","message":"Say hello and nothing else","harness":"amp"}'
# → {"ok": true, "injected": true, "turn_id": 1}
```

Wait ~10s, then check the SSE output:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- cat /tmp/sse_qa.txt
```

**Verify:** SSE output contains `wire.ready`, `system.init`, `assistant` with response text, and exactly one `turn.done` per turn with non-empty `result`.

**Step 3: Back-to-back follow-up** (same thread, same container):

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d '{"thread_key":"test:qa-execute","message":"Now say goodbye"}'
```

**Verify:** Second `turn.done` appears on the connect wire with `turn_id: 2`.

### 1c-ii. Handoff Test

Handoffs are transparent — the amp-wrapper detects handoff tool calls, suppresses handoff noise, kills amp, and chains into the new thread. The API sees one continuous stream.

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d '{"thread_key":"test:qa-execute","message":"handoff and say hi 3 times"}'
```

Wait ~30s, then check SSE output:

**Verify:**
- No `tool_use` or `tool_result` events for the handoff tool visible in the stream
- A new `system.init` with a different `session_id` appears (the chained thread)
- The chained thread's response appears with a `turn.done`
- No duplicate content — user should NOT see the same text twice

### 1c-iii. Auto-chain (context pressure)

The wrapper auto-chains when context usage exceeds 85% (`AMP_CONTEXT_THRESHOLD` env var). To test, use a low threshold. This requires setting the env var on the sandbox container, which isn't easily done via the API — test locally instead:

```bash
cd /tmp && mkdir -p test-autochain && cd test-autochain && git init . 2>/dev/null
(
  echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"say hello"}]}}'
  sleep 30
) | AMP_CONTEXT_THRESHOLD=0.01 timeout 30 python3 services/sandbox/amp-wrapper.py 2>/dev/null
```

**Verify:** Output shows first thread's response + `result`, then seamlessly a new `system.init` with the same `session_id` (continued thread), followed by the chained thread's response.

Clean up: `POST /agent/stop` with `{"thread_key":"test:qa-execute"}`.

### 1d. Personas

Check loaded personas:

```bash
kubectl logs -n centaur deploy/centaur-centaur-api --tail 50 | grep persona_loaded
```

For each persona (typically eng, legal, invest, events):

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d '{
    "thread_key": "test:qa-persona-{NAME}",
    "message": "Run: echo $AGENT_PERSONA && head -3 ~/AGENTS.md 2>/dev/null || echo NO_AGENTS_MD",
    "harness": "{NAME}"
  }'
```

**Verify:** `AGENT_PERSONA` is set, prompt content is persona-specific, different `cache_creation_input_tokens` across personas.

Also test invalid persona — should fall back gracefully.

Clean up all `test:qa-persona-*` containers.

### 1e. Log Pipeline

```bash
# All services present in VictoriaLogs?
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode "query=* | uniq_values(service) limit 1000" --data-urlencode "limit=1"

# _msg field populated (not "missing _msg field")?
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode 'query=service:"api"' --data-urlencode "limit=3"

# Structured fields (level, event) searchable?
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode 'query=service:"api" AND level:"info" AND event:*' --data-urlencode "limit=3"

# Sandbox container logs collected?
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode 'query=container:"pipe-"' --data-urlencode "limit=2"
```

### 1f. Attachments

Test the attachment pipeline: inline extraction, upload endpoint, and sandbox download.

**Inline base64 extraction roundtrip:**

```bash
# Buffer a message with inline base64 image
B64=$(echo -n "FAKE_PNG_BYTES_FOR_QA_TEST" | base64)
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/messages \
  -H "Content-Type: application/json" \
  -d "{
    \"thread_key\": \"test:qa-att-inline\",
    \"messages\": [{
      \"role\": \"user\",
      \"parts\": [
        {\"type\": \"text\", \"text\": \"analyze this\"},
        {\"type\": \"image\", \"source\": {\"type\": \"base64\", \"media_type\": \"image/png\", \"data\": \"$B64\"}}
      ]
    }]
  }"
# → {"ok": true, "inserted": 1}

# List attachments — should have 1 entry
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://localhost:8000/agent/attachments?thread_key=test:qa-att-inline"
# → [{"id":"att-...","name":"image.png","mime_type":"image/png",...}]

# Download and verify bytes
ATT_ID=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://localhost:8000/agent/attachments?thread_key=test:qa-att-inline" | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://localhost:8000/agent/attachments/$ATT_ID/download" | base64 | head -c 40
```

**Verify:** List returns 1 attachment with `mime_type: image/png`. Download returns non-empty bytes. Original message parts in `chat_messages` contain `attachment_ref`, not base64 blob.

**Upload endpoint:**

```bash
B64=$(echo -n "UPLOAD_TEST_CONTENT" | base64)
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/attachments/upload \
  -H "Content-Type: application/json" \
  -d "{
    \"thread_key\": \"test:qa-att-upload\",
    \"name\": \"test-upload.txt\",
    \"mime_type\": \"text/plain\",
    \"data\": \"$B64\"
  }"
# → {"id":"att-...","name":"test-upload.txt","download_url":"/agent/attachments/att-.../download"}

# Download and verify
ATT_ID=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/attachments/upload \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"test:qa-att-upload2\",\"name\":\"verify.txt\",\"mime_type\":\"text/plain\",\"data\":\"$(echo -n hello | base64)\"}" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s "http://localhost:8000/agent/attachments/$ATT_ID/download"
# → hello
```

**Verify:** Upload returns `id`, `name`, `download_url`. Download returns exact bytes uploaded.

**Negative cases:**

```bash
# Missing fields → 422
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/attachments/upload \
  -H "Content-Type: application/json" \
  -d '{"thread_key":"test:qa-att-bad"}'
# → 422

# Nonexistent attachment → 404
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:8000/agent/attachments/att-doesnotexist/download
# → 404
```

**Verify:** Missing fields returns 422. Nonexistent attachment returns 404.

---

## Layer 2: Nginx (parallel subagent)

Same operations as layer 1, but via `curl http://localhost:8000` from the host — goes through nginx → auth → API. Source `.env` for `$API_SECRET_KEY`.

### 2a. Health & Tools

```bash
curl -s http://localhost:8000/health
curl -s http://localhost:8000/tools -H "Authorization: Bearer $API_KEY" | python3 -c "
import sys,json; d=json.load(sys.stdin); print(f'{len(d)} tools via nginx')
"
```

**Watch for:** If `/tools` returns `{"detail":"Invalid API key"}`, the API key is wrong — re-fetch from secrets (see Setup).

### 2b. Tool Calls via Nginx

Run the same sample tool tests from 1b, but via nginx with Bearer auth:

```bash
curl -s -X POST http://localhost:8000/tools/demo/echo \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" -d '{"message":"hello"}'
```

### 2c. Agent Execute via Nginx

```bash
curl -s --max-time 120 -X POST http://localhost:8000/agent/execute \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"thread_key":"test:qa-nginx","message":"What persona are you? One word.","harness":"amp"}'
```

**Verify:** SSE stream arrives (not 502). `turn.done` event has non-empty `result`.

**Known issue (fixed):** The `/agent/` route needs SSE-friendly buffering and timeout settings. Without these, the external route can return 502 while the internal API path works.

### 2d. Agent Execute — Personas via Nginx

Test each persona (eng, events, invest, legal) through nginx:

```bash
for PERSONA in eng events invest legal; do
  echo "=== Persona: $PERSONA ==="
  curl -s --max-time 120 -X POST http://localhost:8000/agent/execute \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"thread_key\":\"test:qa-persona-$PERSONA\",\"message\":\"What persona are you? One word.\",\"harness\":\"$PERSONA\"}" \
    | grep 'turn.done'
  echo ""
done
```

**Verify:** Each returns a persona-specific answer. Do NOT run these in a bash loop with `&` — containers need time to spin up; run sequentially with `--max-time 120`.

### 2e. Message Persistence

After agent execute, verify both user AND assistant messages are in postgres:

```bash
kubectl exec -n centaur statefulset/centaur-centaur-postgres -- psql -U tempo -d ai_v2 -c \
  "SELECT role, substring(parts::text,1,150) FROM chat_messages WHERE thread_key='test:qa-nginx' ORDER BY created_at;"
```

**Verify:** Two rows — one `user`, one `assistant` with the agent's response text.

**Known issue (fixed):** `stream_exec` previously expected `turn.done.result` to be a `dict` with a `.text` field, but it's actually a plain string. This caused assistant messages to never be persisted. If you see user messages but no assistant messages in `chat_messages`, check the result extraction logic in `services/api/api/agent.py` → `stream_exec()`.

### 2f. Fire-and-Forget + Status Poll

Test the async execution flow — fire a job and poll `/agent/status` for completion:

```bash
# Fire (background, don't wait for stream)
curl -s --max-time 5 -X POST http://localhost:8000/agent/execute \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"thread_key":"test:qa-async","message":"Say DONE","harness":"amp"}' > /dev/null 2>&1 &

# Poll status after ~15s
sleep 15
curl -s "http://localhost:8000/agent/status?key=test:qa-async" \
  -H "Authorization: Bearer $API_KEY" | python3 -m json.tool
```

**Verify:** Response includes `"busy": false` and `"last_result": "DONE"` (or similar).

### 2h. Cross-Persona Dispatch (from inside sandbox)

Test that one agent can spawn another persona via `call agent execute`, then poll for results. This is the most important integration test — it proves the full multi-agent orchestration pipeline.

```bash
curl -s --max-time 300 -X POST http://localhost:8000/agent/execute \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_key":"test:qa-cross-persona",
    "message":"Run these commands in order:\n1. call agent execute '\''{ \"thread_key\": \"test:qa-legal-sub\", \"message\": \"What is a SAFE? One sentence.\", \"harness\": \"legal\" }'\''\\n2. sleep 30\\n3. call agent status '\''?key=test:qa-legal-sub'\''\\n4. Show me the last_result.",
    "harness":"eng"
  }'
```

**Verify the SSE trace shows:**
1. eng agent runs `call agent execute` → gets SSE stream back (legal container spawned)
2. eng agent runs `call agent status` → gets `busy: false` + `last_result` with legal's answer
3. eng agent presents the result

**If `call agent execute` returns "Tool 'agent' not found":** The sandbox container has an old `call.sh` without the `agent` case. Fix:
1. Rebuild sandbox image: `just build-one agent`
2. Delete stale sandbox pods: `kubectl delete pod -n centaur -l centaur-agent=true --ignore-not-found`
3. Redeploy API: `just deploy`
4. Wait for rollout, then retry

### 2g. Auth Gate

```bash
# Unauthenticated browser request should redirect to /login
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/
# → 302
```

---

## Layer 3a: Slackbot (parallel subagent)

Test the slackbot by crafting HMAC-signed Slack webhook payloads. This proves the full Slack → slackbot → API → sandbox → response path.

### Automated integration test script

Run the automated integration test suite (URL verification, signature rejection, app_mention with/without file attachments, thread messages, edge cases):

```bash
source .env
{SKILL_DIR}/scripts/integration-slackbot.sh
```

Set `SLACKBOT_URL` if the slackbot is only reachable inside the cluster:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- bash -c 'SLACKBOT_URL=http://slackbot:3001 SLACK_SIGNING_SECRET=<secret> /path/to/integration-slackbot.sh'
```

### 3a-i. URL Verification (signed)

```bash
source .env
SIGNING_SECRET="$SLACK_SIGNING_SECRET"
TIMESTAMP=$(date +%s)
BODY='{"type":"url_verification","challenge":"test-challenge-qa"}'
SIG_BASESTRING="v0:${TIMESTAMP}:${BODY}"
SIGNATURE="v0=$(echo -n "$SIG_BASESTRING" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | awk '{print $2}')"

# Direct to slackbot
curl -s -X POST http://localhost:3001/api/slack/events \
  -H "Content-Type: application/json" \
  -H "x-slack-signature: $SIGNATURE" \
  -H "x-slack-request-timestamp: $TIMESTAMP" \
  -d "$BODY"
# → {"challenge":"test-challenge-qa"}
```

Note: If slackbot is enabled without an external route, use `kubectl exec` to reach it on the internal network:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://slackbot:3001/api/slack/events \
  -H "Content-Type: application/json" \
  -H "x-slack-signature: $SIGNATURE" \
  -H "x-slack-request-timestamp: $TIMESTAMP" \
  -d "$BODY"
```

### 3a-ii. Signature Rejection

```bash
curl -s -X POST http://localhost:3001/api/slack/events \
  -H "Content-Type: application/json" \
  -H "x-slack-signature: v0=bad" \
  -H "x-slack-request-timestamp: $(date +%s)" \
  -d '{"type":"url_verification","challenge":"test"}'
# → 401 {"error":"Invalid Slack signature"}
```

### 3a-iii. Via Nginx (production path)

```bash
# Same signed payload through nginx → API webhook proxy
curl -s -X POST http://localhost:8000/api/webhooks/slack \
  -H "Content-Type: application/json" \
  -H "x-slack-signature: $SIGNATURE" \
  -H "x-slack-request-timestamp: $TIMESTAMP" \
  -d "$BODY"
```

---

## Layer 3b: Web App / Thread Viewer (parallel subagent)

Use the **dogfood** skill to systematically test the thread viewer UI.

```
Load skill: skill("dogfood")
Target: http://localhost:8000
Auth: Log in via /login with UI_PASSWORD from .env
```

**Key flows to test:**
- Login page works, cookie set after auth
- Thread list view loads, shows recent threads
- Thread detail view renders messages, tool calls, dashboard blocks
- Agent execution from the UI (if supported)
- SSE streaming in thread viewer
- Static assets load (_next/ routes)

The dogfood skill produces its own report with screenshots and repro steps.

---

## Report

Copy the template and fill in results:

```bash
cp {SKILL_DIR}/templates/tool-qa-report-template.md {OUTPUT_DIR}/report.md
```

## Known Gotchas

| Symptom | Root Cause | Fix |
|---------|-----------|-----|
| 502 on `/agent/execute` via ingress | Missing SSE directives (`proxy_buffering off`, `proxy_read_timeout`) | Add SSE config to the ingress/route handling `/agent/` |
| Assistant messages missing from `chat_messages` | `stream_exec` result extraction expected dict, got string | Fix in `services/api/api/agent.py` — handle both string and dict `result` |
| `API_SECRET_KEY` empty from `.env` | Key is in secrets manager, not `.env` | Fetch via `curl http://firewall:8081/secrets/API_SECRET_KEY` |
| vlogs tool fails with DNS error | VictoriaLogs is not part of the default local Helm stack | Expected unless observability is installed separately |
| Slackbot is not running locally | Default dev values disable slackbot | Enable it in values only when testing Slack-specific flows |
| `call agent execute` returns "Tool 'agent' not found" | Sandbox pods have old `call.sh` without `agent` case | Rebuild sandbox image, delete stale sandbox pods, redeploy API |
| Sandbox pods stale after sandbox rebuild | `just build-one agent` doesn't update already-running pods | Delete sandbox pods with `kubectl delete pod -n centaur -l centaur-agent=true --ignore-not-found` |
| Duplicate `turn.done` per turn | `is_turn_done` fires on both `end_turn` and `result` events | The amp-wrapper suppresses `result` events — only `end_turn` triggers `turn.done`. If you see doubles, the sandbox has an old wrapper |
| Handoff output invisible / missing | amp-wrapper suppresses handoff tool events and chains transparently | Expected behavior — check for a new `system.init` with a different `session_id` in the stream |
| Agent says "handoffs are disabled" | Sandbox has old SYSTEM_PROMPT.md baked in | Rebuild sandbox: `just build-one agent`, delete stale sandbox pods |

## Issue Investigation

When something fails:

1. **Service crash** — `kubectl logs -n centaur deploy/centaur-centaur-{component} --tail 30`
2. **Schema mismatch** — Check DB/API schema vs tool code
3. **Missing credentials** — `kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s http://centaur-centaur-firewall-manager:8081/secrets/{KEY}` (NOT direct 1Password access)
4. **Connection failure** — Check upstream, tunnel, firewall
5. **Routing issue** — Compare ingress/HTTPRoute config with expected path
6. **Postgres persistence** — Check `chat_messages` table: `kubectl exec -n centaur statefulset/centaur-centaur-postgres -- psql -U tempo -d ai_v2 -c "SELECT role, parts FROM chat_messages WHERE thread_key='...'"` 

Note root cause and suggested fix for each failure.

## Fixing Issues

1. Fix the bug in the relevant service/tool code
2. Tools: commit + push (hot-reload, no restart)
3. Services: `just build-one {service} && just deploy`
4. Re-test, update report from FAIL → PASS (fixed)

## References

| Reference | When to Read |
|-----------|--------------|
| [references/test-inputs.md](references/test-inputs.md) | Before tool testing — default inputs by category |

## Templates

| Template | Purpose |
|----------|---------|
| [templates/tool-qa-report-template.md](templates/tool-qa-report-template.md) | QA report file |
