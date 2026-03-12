---
name: qa
description: "Run comprehensive QA and integration tests against the local Centaur stack. Use when asked to QA the stack, run integration tests, verify a deployment, or check stack health after a refactor."
---

# Centaur QA

Test the Centaur stack in three progressive layers — same core operations at each level, proving successively more surface area works.

## Layers

```
Layer 1: Internal API     docker exec → API directly. Proves core works.
Layer 2: Nginx             curl from host → nginx → API. Proves routing + auth.
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
| **Tool scope** | Sample (~10 tools) | `Full tools` or `Focus on slack, paradigmdb` |
| **Layer scope** | All three layers | `Just layer 1` or `Layers 1 and 2` |

**Getting the API key:** `API_SECRET_KEY` is NOT in `.env` — it's in the secrets manager. Fetch it:

```bash
API_KEY=$(docker exec centaur-api-1 curl -s http://firewall:8081/secrets/API_SECRET_KEY | python3 -c "import sys,json; print(json.load(sys.stdin)['value'])")
```

Use `$API_KEY` (not `$API_SECRET_KEY`) in all curl commands below.

If the user says "QA", "QA the stack", or "health check", start immediately with defaults (sample tools, all layers). Do not ask clarifying questions.

---

## Layer 1: Internal API

All calls via `docker exec centaur-api-1 curl -s http://localhost:8000/...` — bypasses nginx, no auth needed.

### 1a. Services & Health

```bash
docker compose ps -a --format '{{.Name}}\t{{.Status}}'
```

All must be Up (healthy where applicable): postgres, pgbouncer, secrets, firewall, api, docker-socket-proxy, nginx, auth, alloy, victorialogs, prometheus, grafana, slackbot, web.

```bash
docker exec centaur-api-1 curl -s http://localhost:8000/health/ready
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

### 1c. Agent Execute

```bash
docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d '{"thread_key":"test:qa-execute","message":"Say hello and nothing else","harness":"amp"}'
```

**Verify:** SSE stream with `type: turn.done`, non-empty `result`, `session_id` starts with `T-`.

Clean up: `POST /agent/stop` with `{"thread_key":"test:qa-execute"}`.

### 1d. Personas

Check loaded personas:

```bash
docker compose logs api --tail 50 | grep persona_loaded
```

For each persona (typically eng, legal, invest, events):

```bash
docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/execute \
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
docker exec centaur-api-1 curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode "query=* | uniq_values(service) limit 1000" --data-urlencode "limit=1"

# _msg field populated (not "missing _msg field")?
docker exec centaur-api-1 curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode 'query=service:"api"' --data-urlencode "limit=3"

# Structured fields (level, event) searchable?
docker exec centaur-api-1 curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode 'query=service:"api" AND level:"info" AND event:*' --data-urlencode "limit=3"

# Sandbox container logs collected?
docker exec centaur-api-1 curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode 'query=container:"pipe-"' --data-urlencode "limit=2"
```

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

**Known issue (fixed):** The `/agent/` nginx location needs `proxy_buffering off`, `proxy_cache off`, and `proxy_read_timeout 300s` for SSE streaming. Without these, nginx returns 502. If you see 502 on agent execute through nginx but it works via `docker exec`, check `services/nginx/nginx.conf` for missing SSE directives on the `/agent/` location.

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
docker exec centaur-postgres-1 psql -U tempo -d ai_v2 -c \
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

### 2g. Auth Gate

```bash
# Unauthenticated browser request should redirect to /login
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/
# → 302
```

---

## Layer 3a: Slackbot (parallel subagent)

Test the slackbot by crafting HMAC-signed Slack webhook payloads. This proves the full Slack → slackbot → API → sandbox → response path.

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

Note: If slackbot isn't port-mapped, use `docker exec` to reach it on the internal network:

```bash
docker exec centaur-api-1 curl -s -X POST http://slackbot:3001/api/slack/events \
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
| PgBouncer unhealthy on startup | `pg_isready` healthcheck defaults to user `postgres` but pgbouncer only knows `tempo` | Add `-U tempo` to healthcheck in `docker-compose.yml` |
| 502 on `/agent/execute` via nginx | Missing SSE directives (`proxy_buffering off`, `proxy_read_timeout`) | Add SSE config to `/agent/` location in `nginx.conf` |
| Assistant messages missing from `chat_messages` | `stream_exec` result extraction expected dict, got string | Fix in `services/api/api/agent.py` — handle both string and dict `result` |
| `API_SECRET_KEY` empty from `.env` | Key is in secrets manager, not `.env` | Fetch via `curl http://firewall:8081/secrets/API_SECRET_KEY` |
| Port 3001 already allocated (OrbStack) | Ghost binding from previous container survives OrbStack restart | Remove host port mapping for `web` (nginx proxies internally) |
| vlogs tool fails with DNS error | VictoriaLogs is on `obs_net`, not reachable from API's network | Expected — tool needs network config or internal proxy |
| Slackbot port not mapped to host | `web` service removed host port binding | Use `docker exec` to reach slackbot internally at `slackbot:3001` |

## Issue Investigation

When something fails:

1. **Service crash** — `docker compose logs {service} --tail 30`
2. **Schema mismatch** — Check DB/API schema vs tool code
3. **Missing credentials** — `docker exec centaur-api-1 curl -s http://firewall:8081/secrets/{KEY}` (NOT `http://secrets:8100` — API can't reach secrets directly, use firewall proxy)
4. **Connection failure** — Check upstream, tunnel, firewall
5. **Routing issue** — Compare nginx config with expected path
6. **Postgres persistence** — Check `chat_messages` table: `docker exec centaur-postgres-1 psql -U tempo -d ai_v2 -c "SELECT role, parts FROM chat_messages WHERE thread_key='...'"`

Note root cause and suggested fix for each failure.

## Fixing Issues

1. Fix the bug in the relevant service/tool code
2. Tools: commit + push (hot-reload, no restart)
3. Services: `docker compose up -d --build {service}`
4. Re-test, update report from FAIL → PASS (fixed)

## References

| Reference | When to Read |
|-----------|--------------|
| [references/test-inputs.md](references/test-inputs.md) | Before tool testing — default inputs by category |

## Templates

| Template | Purpose |
|----------|---------|
| [templates/tool-qa-report-template.md](templates/tool-qa-report-template.md) | QA report file |
