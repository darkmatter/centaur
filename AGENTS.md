# Centaur — Developer Guide

## Quick Start

### 1. Clone and configure

```bash
git clone https://github.com/paradigmxyz/centaur
cd centaur
cp .env.example .env
```

Centaur needs a small set of secrets to boot. You have two options:

**Option A: Environment variables (simplest, good for dev)**

Set `SECRET_MANAGER_BACKEND=env` in `.env`, then provide secrets directly:

```bash
SECRET_MANAGER_BACKEND=env

# Postgres (auto-created by docker compose)
DATABASE_URL=postgresql://tempo:tempo_dev@pgbouncer:5432/centaur

# Slack app (from https://api.slack.com/apps)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...

# Web UI auth gate
UI_PASSWORD=pick-a-password
AUTH_COOKIE_KEY=random-hmac-key       # openssl rand -hex 32

# At least one LLM key (for the agent harness)
ANTHROPIC_API_KEY=sk-ant-...
```

**Option B: 1Password (recommended for production)**

Set `OP_SERVICE_ACCOUNT_TOKEN` and `OP_VAULT`, then store the same secrets as items in your 1Password vault. The secrets manager sidecar loads them automatically.

### 2. Boot the stack

```bash
docker compose up -d
docker compose build sandbox
```

### 3. Test

From inside the API container (localhost bypass — no key needed):

```bash
THREAD_KEY=test-e2e-1

SPAWN=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/spawn \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")
ASSIGNMENT_GENERATION=$(printf '%s' "$SPAWN" | jq -r '.assignment_generation')

docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/message \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Reply with exactly PONG and nothing else.\"}]}"

EXECUTE=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")
EXECUTION_ID=$(printf '%s' "$EXECUTE" | jq -r '.execution_id')

docker exec centaur-api-1 curl -s "http://localhost:8000/agent/executions/${EXECUTION_ID}" | jq
```

Or create a DB-backed key for external use (see [API Key Management](#api-key-management)).

## Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │              nginx (:8000)                  │
                         │  Reverse proxy + auth gate (auth_request)   │
                         │  /, /_next → slackbot | /grafana → grafana │
                         │  /api/*, /agent/*, /tools/* → api          │
                         └──────┬──────────┬──────────┬───────────────┘
                                │          │          │
                    ┌───────────┘          │          └───────────┐
                    ▼                      ▼                      ▼
             ┌────────────┐       ┌──────────────┐       ┌──────────────┐
             │ auth (:4000)│       │  api (:8000)  │       │  slackbot    │
             │ Starlette   │       │  FastAPI      │       │  Next.js     │
             │ HMAC cookie │       │               │       │  (:3001)     │
             └────────────┘       │  routers/     │       └──────────────┘
                                  │  ├ agent.py    │
                    ┌──── Slack ──│  ├ internal.py │
                    │  webhooks   │  ├ admin.py    │
                    │             │  └ health.py   │
                    │             │                │
                    │             │  agent.py ─── Docker lifecycle │
                    │             └───────┬────────┘
                    │                     │ Docker socket proxy
                    │                     ▼
                    │             ┌──────────────┐       ┌──────────────┐
                    │             │  sandbox     │──────►│  firewall    │
                    │             │  centaur-agent:latest│ HTTPS │  mitmproxy   │
                    │             │  amp/claude/  │ proxy │  injects     │
                    │             │  codex        │       │  real keys   │
                    │             └──────┬────────┘       └──────┬───────┘
                    │                    │ curl REST              │
                    │                    └──► /tools/* /search    │
                    │                         /query /agent       │
                    │                                             │
                    │             ┌──────────────┐
                    │             │  secrets      │
                    │             │  (:8100)      │
                    │             │  1Password    │
                    │             │  cache        │
                    │             └──────────────┘
                    │
                    ▼
               ┌──────────┐
               │ Postgres  │    pgvector, raw_records JSONB
               │           │    sandbox_sessions, chat_messages
               └──────────┘
```

### End-to-End Request Flow

1. User mentions bot in Slack → webhook → nginx → slackbot → api
2. API spawns/reuses Docker container (`centaur-agent:latest`) for that thread
3. Executes harness (amp/claude-code/codex) via `docker exec`
4. Harness calls tools via `curl` back to API at `http://api:8000` (REST, NOT MCP)
5. LLM API calls route through firewall proxy which injects real credentials
6. Results stream as JSON events → posted to Slack

### Service Interface Contracts

Centaur is a modular service architecture. Each service communicates through well-defined interfaces. As long as you implement these interfaces, you can swap or extend any layer independently.

**Client → API** (durable control-plane protocol):

Clients (slackbot, web app, CLI) should stay thin. They persist input with `spawn -> message -> execute`, stream or replay output from the durable events endpoint, and only fall back to durable terminal state when the live stream is gone. The API owns runtime assignment, execution serialization, cancellation, and final-delivery recovery; Postgres is the source of truth.

**Step 1: Assign or reuse a runtime** (`POST /agent/spawn`)

Pins one warm runtime to the thread and returns the current `assignment_generation`.

```
POST /agent/spawn
{
  "thread_key": "slack:C0AJ07U8Z1N:1773364194.179929",
  "harness": "amp"
}

← {
    "thread_key": "slack:C0AJ07U8Z1N:1773364194.179929",
    "runtime_id": "rtm_123",
    "assignment_generation": 12,
    "state": "assigned_idle"
  }
```

**Step 2: Persist the user turn** (`POST /agent/message`)

Writes one durable transcript event. Inline base64 image/document blocks are extracted into `attachments` and rewritten to lightweight `attachment_ref` parts.

```
POST /agent/message
{
  "thread_key": "slack:C0AJ07U8Z1N:1773364194.179929",
  "assignment_generation": 12,
  "role": "user",
  "parts": [{"type": "text", "text": "analyze this"}],
  "user_id": "U123",
  "metadata": {"user_name": "alice", "platform": "slack"}
}

← {"ok": true, "message_id": "msg_123"}
```

**Step 3: Enqueue execution** (`POST /agent/execute`)

Creates a durable execution request plus final-delivery obligation. The worker drives the attached container; the response is just the execution handle.

```
POST /agent/execute
{
  "thread_key": "slack:C0AJ07U8Z1N:1773364194.179929",
  "assignment_generation": 12,
  "harness": "amp",
  "delivery": {"platform": "slack"}
}

← {"ok": true, "execution_id": "exe_123", "status": "queued"}
```

**Step 4: Stream or replay output** (`GET /agent/threads/{thread_key}/events`)

Consumers tail durable events for one execution. On disconnect, reconnect with the last seen event id. If the execution already finished and no more rows remain, the API emits the terminal `execution_state` snapshot.

```
GET /agent/threads/slack:C0AJ07U8Z1N:1773364194.179929/events?execution_id=exe_123&after_event_id=0

← SSE event: amp_raw_event
← data: {"type":"assistant","message":{...}}
← SSE event: turn.done
← data: {"type":"turn.done","result":"..."}
← SSE event: execution_state
← data: {"status":"completed","result_text":"..."}
```

**Step 5: Release only when you really want to end the assignment** (`POST /agent/threads/{thread_key}/release`)

Releases the thread-to-runtime pin and optionally cancels any non-terminal execution still tied to that assignment generation.

**Durable state written for one turn:**

| Table | What |
|-------|------|
| `agent_runtime_assignments` | Thread-to-runtime pin and active assignment generation |
| `agent_message_requests` | Durable inbound transcript events |
| `attachments` | Extracted attachment bytes for inline multimodal content |
| `agent_execution_requests` | Queued/running/terminal execution row |
| `agent_execution_events` | Replayable raw + projected execution events |
| `agent_final_delivery_outbox` | Final-result delivery obligation for reconnect/retry paths |

`POST /agent/connect` and `POST /agent/reconnect` are legacy endpoints now kept only as explicit `410 LEGACY_ENDPOINT_REMOVED` stubs. Do not build new clients on them.

**API → Sandbox** (Docker stdin/stdout, NDJSON):

The API communicates with sandbox containers over Docker attach sockets. The wire format is **Anthropic message format** — this is the canonical protocol between the API and all sandboxes, regardless of which harness runs inside.

```
→ stdin:  {"type":"turn.start","turn_id":1,"text":"analyze this"}
→ stdin:  {"type":"turn.start","turn_id":2,"content":[             // Anthropic content blocks
             {"type":"text","text":"what is this?"},
             {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}
           ]}
→ stdin:  {"type":"interrupt"}

← stdout: {"type":"system","subtype":"init","session_id":"T-..."}
← stdout: {"type":"assistant","message":{"role":"assistant","content":[...]}}
← stdout: {"type":"result","subtype":"success","result":"..."}
← stdout: {"type":"turn.done","turn_id":1,"result":"..."}
```

**Sandbox harness adapter** (`services/sandbox/harness_session.py`):

The sandbox's `harness_session.py` translates the standard Anthropic format into whatever each harness CLI actually accepts:

| Harness | Translation |
|---------|-------------|
| **claude-code** | Pass through directly (native Anthropic format) |
| **amp** | Materialize image/document blocks to files on disk, replace with `@/path` text mentions (Amp stdin only accepts text blocks) |
| **codex / pi-mono** | Extract text from content blocks, pass as CLI argument |

This means clients and the API never need to know about harness-specific quirks. They speak Anthropic format; the sandbox adapter handles the rest.

**Sandbox → API** (REST over Docker network):

Agents call tools via `curl http://api:8000/tools/<tool>/<method>` over the `agent_net` Docker network. Auth is via `CENTAUR_API_KEY` injected at container creation.

### Network Isolation

| Network | Scope | Services |
|---------|-------|----------|
| `secrets_net` | internal | firewall → secrets |
| `secrets_egress` | external | secrets → 1Password SDK |
| `agent_net` | internal | sandbox containers ↔ firewall ↔ api |
| `app_net` | internal | api ↔ slackbot ↔ auth |
| `control_net` | internal | api ↔ pgbouncer ↔ firewall |
| `data_net` | internal | postgres, pgbouncer ↔ api |
| `obs_net` | internal | victoriametrics, victorialogs, fluentbit, grafana |

## Directory Structure

```
centaur/
├── services/
│   ├── api/              # FastAPI control plane (standalone service)
│   │   ├── api/          # Python package (routers/, agent.py, app.py, tool_manager.py)
│   │   ├── Dockerfile
│   │   ├── entrypoint.sh
│   │   ├── pyproject.toml
│   │   ├── ruff.toml
│   │   └── tools.toml    # Tool plugin directory config
│   ├── secrets/          # Pluggable secrets manager (standalone service)
│   │   ├── app.py
│   │   ├── Dockerfile
│   │   └── pyproject.toml
│   ├── firewall/         # mitmproxy addon — credential injection proxy
│   ├── sandbox/          # Agent container image (Ubuntu 24.04 + uv + gh + node + amp)
│   ├── slackbot/         # Next.js + Slack Bolt event listener (pnpm)
│   ├── auth/             # Starlette password-session auth sidecar (:4000)
│   ├── nginx/            # nginx reverse proxy config
│   ├── pgbouncer/        # PgBouncer connection pooler
│   ├── grafana/          # Grafana dashboards + provisioning
│   ├── fluentbit/        # Fluent Bit log shipping config
│   └── alloy/            # Grafana Alloy config
├── centaur_sdk/          # Standalone SDK (pip install centaur-sdk)
├── tools/                # Open-source tool plugins (by category)
│   ├── comms/            # Telegram, Twitter
│   ├── crypto/           # Alchemy, Allium, Dune, Etherscan, Nansen, …
│   ├── finance/          # Databento, EODHD, Standard Metrics
│   ├── gov/              # Congress, FedReg, LegiStorm, OpenFEC
│   ├── infra/            # Grafana, PostHog, reth, VLogs, …
│   ├── media/            # Nano Banana, Transcriber, Veo3
│   ├── productivity/     # Figma, Linear, Notion, OpenTable
│   └── research/         # Archiver, Crunchbase, Google News, Websearch, …
├── scripts/              # Operational scripts
└── docker-compose.yml    # Full stack
```

## Debugging

**Always check logs first.** When debugging any issue with the deployed stack (agent misbehavior, tool failures, request errors), your first step should be querying VictoriaLogs on the deploy box — not guessing, reading source code, or theorizing. Logs tell you what actually happened.

```bash
# Look up logs for a specific Slack thread
ssh ubuntu@206.223.235.69 "docker exec centaur-api-1 curl -s 'http://victorialogs:9428/select/logsql/query' \
  --data-urlencode 'query=thread_key:<THREAD_KEY>' --data-urlencode 'limit=50'"

# API errors in the last hour
ssh ubuntu@206.223.235.69 "docker exec centaur-api-1 curl -s 'http://victorialogs:9428/select/logsql/query' \
  --data-urlencode 'query=_stream:{service=\"api\"} AND level:error' --data-urlencode 'limit=20'"

# Sandbox container logs (agent harness output)
ssh ubuntu@206.223.235.69 "docker logs <container_id> 2>&1 | tail -100"
```

Only after reviewing logs should you dig into source code or try to reproduce locally.

## Terminology

- **Chat SDK** always refers to the [Vercel Chat SDK](https://github.com/vercel/chat) (`~/github/vercel/chat`). When you need to understand how the Chat SDK or `@chat-adapter/*` packages work, **always read the source at `~/github/vercel/chat`** — never dig through `node_modules`.

## Testing Before Pushing

**NEVER push changes without testing them locally first.** Testing means actually running the affected service and proving the change works end-to-end — not just linting or reasoning about it.

1. **Build the affected service:** `docker compose build <service>`
2. **Bring it up:** `docker compose up -d <service>`
3. **Make a real request** that exercises the change and show the output
4. **Only then** commit and push

For tool changes: tools hot-reload, so just verify via `curl -X POST http://localhost:8000/tools/<tool>/<method>` from inside the API container. For Dockerfile/infra changes: rebuild, restart, and verify the binary/service is present and functional. For firewall changes: test from inside a sandbox container through the proxy.

## Local-First Testing — Never Touch the Deploy Box

**All testing and E2E validation MUST happen on the local stack** (`docker compose up` on this machine). Never SSH into the deploy box (`206.223.235.69`) to run tests, rebuild services, or make ad-hoc changes unless explicitly told to do so by the user.

The deploy box is **production**. Changes reach it via `git push` → GitHub Actions auto-deploy. The only reasons to SSH into it are:
- Checking logs (`docker logs`, VictoriaLogs queries) for debugging production issues
- Emergency manual intervention — **only when the user explicitly asks**

For E2E testing, always:
1. `docker compose build <service>` locally
2. `docker compose up -d <service>` locally
3. Run curl commands against `localhost` (or `docker exec centaur-api-1 curl ...`)
4. Verify results locally
5. Only then commit, push, and let CI/CD handle production

## Code Conventions

- Python 3.11+, `uv` for deps, `ruff` for lint/format (line-length=100)
- `services/slackbot` uses `pnpm` only (single lockfile: `pnpm-lock.yaml`)
- All imports at top of file, never inside functions
- Absolute imports only: `from api.X`, `from centaur_sdk.X`
- All secrets via env vars or secret manager, never hardcode
- `asyncpg` for Postgres, `pgvector` for embeddings
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`

## Lint & Test

Each service has its own `pyproject.toml` and `ruff.toml`. From the repo root:

```bash
uv run ruff check .          # lint
uv run ruff format .         # auto-fix
uv run pytest                # tests
```

## Tool Conventions

Tools live in `tools/` organized by category and are discovered via `services/api/tools.toml`. Each tool is a directory with `client.py` (class + `_client()` factory), `pyproject.toml`, and optional `cli.py`. The API auto-discovers tools on startup and hot-reloads on file changes.

- `client.py`: NO `load_dotenv()`. Secrets via `secret()` from `centaur_sdk.tool_sdk`.
- `cli.py`: YES `load_dotenv()` at top. Thin typer wrapper for standalone use.
- Methods starting with `_` are excluded from registration.
- Tool dependencies declared in `pyproject.toml` are installed at image build time.

Example:

```python
# tools/research/my-tool/client.py
import httpx

class MyToolClient:
    def search(self, query: str, limit: int = 10) -> dict:
        """Search for something."""
        resp = httpx.get(f"https://api.example.com/search?q={query}&limit={limit}")
        return resp.json()

def _client():
    return MyToolClient()
```

### Private overlay

Organizations can extend Centaur with private tools without forking. Use the submodule + docker-compose override pattern:

```
your-org-internal/
├── centaur/                         # git submodule → paradigmxyz/centaur
├── tools-private/                   # Your proprietary tools
├── docker-compose.override.yml      # Adds your services + tool mounts
└── tools.toml                       # plugin_dirs = ["./centaur/tools", "./tools-private"]
```

```bash
docker compose -f centaur/docker-compose.yml -f docker-compose.override.yml up -d
```

## Agent Sandbox

### Overview

1 conversation = 1 Docker container. The API spawns containers running harness CLIs (amp, claude-code, codex). Inside the container, the harness calls back to the API via `curl` over REST.

### How the System Prompt Works

The sandbox image bakes `services/sandbox/SYSTEM_PROMPT.md` into `~/AGENTS.md` at build time. On container startup, `entrypoint.sh` copies it into the workspace root as `workspace/AGENTS.md` — this is the file that AI harnesses (Amp, Claude Code, Codex) read as their system instructions.

The system prompt tells the agent:
- **Identity**: it's running inside a Docker sandbox, calling back to the API for tool access
- **Tools**: three kinds — harness built-ins (Read, Bash, etc.), API tools via the `call` helper, and a headless browser
- **`call` helper** (`/usr/local/bin/call`): a bash wrapper around `curl` that provides a concise syntax for API tool calls. `call slack get_channel_history '{"channel":"general"}'` instead of a full curl command. Returns TOON format for token efficiency.
- **Slack messaging**: the agent's stdout IS the Slack reply — never call `send_message` on the active thread
- **Dashboard blocks**: fenced code blocks with `dashboard` language tag render interactive tables, charts, and KPI cards in the thread viewer UI
- **Rules**: never display secrets, show your work, lead with the answer

The `call` helper (`services/sandbox/call.sh`) handles routing:
- `call <tool> <method> [json]` → `POST /tools/<tool>/<method>`
- `call discover <tool>` → `GET /tools/<tool>`

Legacy `call search` / `call sql` shorthands were removed. Sandbox agents should call the concrete tool directly, for example `call websearch search '{"query":"..."}'` or `call paradigmdb db_query '{"query":"SELECT ..."}'`.

### Persona System

The entrypoint supports persona variants via `AGENT_PERSONA` env var. If set to e.g. `legal`, it looks for `~/AGENTS_LEGAL.md` and uses that instead of the base prompt. This allows different system prompts for different use cases without rebuilding the image.

### Container Config

- Joins `agent_net` Docker network → API reachable at `http://api:8000`
- Entrypoint injects `CENTAUR_API_URL` and `CENTAUR_API_KEY` env vars
- Stub API keys so harnesses init in API-key mode (not browser login)
- `HTTPS_PROXY=http://firewall:8080` routes LLM calls through the firewall
- Resource limits: 4GB memory, 2 CPUs
- Image tagged `centaur-agent:latest`
- Labels: `centaur-agent=true`, `ai2.thread`, `ai2.harness` for discovery/recovery

### Credential Injection (Firewall)

Sandbox containers never see real API keys. The firewall (`services/firewall/addon.py`) intercepts HTTPS and injects credentials from the secrets service:

| Target host | Header | Format |
|-------------|--------|--------|
| `api.anthropic.com` | `x-api-key` | raw |
| `api.openai.com` | `authorization` | bearer |
| `ampcode.com` | `authorization` | bearer |
| `api.github.com` | `authorization` | token |
| `github.com` | `authorization` | basic auth |

### Session Persistence

- **`sandbox_sessions`** table: tracks sandbox ID, harness, engine, state, thread key, and thread title
- **`chat_messages`** table: stores persisted user/assistant messages for the thread viewer and Slackbot surfaces
- On API restart, sandbox ownership is re-read from `sandbox_sessions`; process-local queues and sockets are rebuilt lazily per sandbox
- Containers are still discoverable via Docker labels even if DB state needs reconciliation

## Security Model

- **API auth**: All callers authenticate with DB-backed API keys (`aiv2_*` prefix, stored in `api_keys` table). Docker bridge IPs (localhost) bypass auth for container→API calls.
- **Sandbox auth**: Sandbox containers get auto-issued HMAC-signed tokens (`sbx1.*` prefix) minted by the API. These are short-lived (2h TTL) and scoped to `agent` + `tools:*`.
- **Slack**: HMAC-SHA256 signature verification on all webhooks
- **UI**: Password-based HMAC session cookie; nginx `auth_request` gates all UI routes
- **Sandbox isolation**: Containers get stub keys only; real keys injected by firewall proxy in-flight
- **Filesystem**: Host repos mounted read-only by default; only working repo is read-write
- **Docker socket**: Proxied via `tecnativa/docker-socket-proxy` — only container/network/exec ops allowed

## API Key Management

All API authentication uses **DB-backed keys** stored in the `api_keys` Postgres table. Keys are managed via the admin API (localhost-only, or requires `admin` scope).

### Getting a valid API key for testing

From the deploy box (localhost bypass):

```bash
# List all keys (shows name, prefix, scopes — never the key itself)
ssh ubuntu@206.223.235.69 "docker exec centaur-api-1 curl -s http://localhost:8000/admin/api-keys" | jq

# Create a new key
ssh ubuntu@206.223.235.69 "docker exec centaur-api-1 curl -s -X POST http://localhost:8000/admin/api-keys \
  -H 'Content-Type: application/json' \
  -d '{\"name\": \"my-test-key\", \"scopes\": [\"*\"]}'" | jq
# → returns the plaintext key (only shown once!)

# Revoke a key
ssh ubuntu@206.223.235.69 "docker exec centaur-api-1 curl -s -X DELETE http://localhost:8000/admin/api-keys/<key-id>"
```

### Key types

| Type | Prefix | Issued by | Used by | Scopes |
|------|--------|-----------|---------|--------|
| DB keys | `aiv2_*` | Admin API | Slackbot, web app, CLI, external callers | Per-key (e.g. `["*"]`, `["agent:execute"]`) |
| Sandbox tokens | `sbx1.*` | API (automatic) | Sandbox containers → API tool calls | `["agent", "tools:*"]` |

### How services get their keys

- **Slackbot**: `SLACKBOT_API_KEY` env var, bootstrapped from secrets service (1Password item name: `SLACKBOT_API_KEY`)
- **Web app**: `WEB_API_KEY` env var, same bootstrap
- **Sandbox containers**: Auto-issued `sbx1.*` token injected as `CENTAUR_API_KEY` at container creation
- **Local testing**: Use localhost bypass (no key needed from inside the API container), or create a key via admin API

## Secret Manager

The secrets service (`services/secrets/app.py`) loads all secrets from a 1Password vault on startup and refreshes periodically. Item titles are normalized to ENV_VAR style (e.g., "Claude API" → `ANTHROPIC_API_KEY`).

For local development without 1Password, set `SECRET_MANAGER_BACKEND=env` and provide secrets directly in `.env`.

## Observability & Audit Logs

### Architecture

All services write structured JSON logs to **stdout**. Docker captures container logs. **Fluent Bit** discovers all Docker containers (including dynamically spawned agent sandboxes) and forwards logs to **VictoriaLogs**. **VictoriaMetrics** receives metrics via push from the API service. **Grafana** provides the query UI with provisioned VictoriaLogs and VictoriaMetrics datasources.

```
Service → stdout (JSON) → Docker log driver → Fluent Bit → VictoriaLogs → Grafana
```

This design means ephemeral sandbox containers are captured automatically — no per-container logging config needed.

### Components

| Component | Role | Config |
|-----------|------|--------|
| **VictoriaLogs** | Log storage + query engine | 7-day retention, `obs_net` |
| **VictoriaMetrics** | Metrics storage + query engine | Push-based, `obs_net` |
| **Grafana** | Dashboards + log explorer | VictoriaLogs datasource provisioned |
| **Fluent Bit** | Container log collector | `services/fluentbit/fluent-bit.conf` |

### Querying logs

Via Grafana: navigate to **Explore → VictoriaLogs** and use [LogsQL](https://docs.victoriametrics.com/victorialogs/logsql/).

Via CLI (from inside the Docker network):

```bash
# All logs for a specific thread
docker exec centaur-api-1 curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode "query=thread_key:C042WDDP89Y" --data-urlencode "limit=50"

# API errors in the last hour
docker exec centaur-api-1 curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode "query=_stream:{service=\"api\"} AND level:error" --data-urlencode "limit=20"

# Firewall audit trail for a time range
docker exec centaur-api-1 curl -s "http://victorialogs:9428/select/logsql/query" \
  --data-urlencode "query=_stream:{service=\"firewall\"} AND event:proxy_audit" \
  --data-urlencode "start=2026-03-10T00:00:00Z" --data-urlencode "end=2026-03-11T00:00:00Z"
```

### Audit logging

The **firewall** emits a structured audit event for every outbound request from sandbox containers: method, host, path, status code, request/response bytes, duration, and source container IP. These are searchable via `event:proxy_audit` in VictoriaLogs.

The **API** logs tool calls (`event:tool_call_started`, `event:tool_call_completed`), session lifecycle (`event:warm_container_claimed`), and HTTP requests with thread context.

### Logging contract

Services must write single-line JSON to stdout with these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `timestamp` | Yes | ISO 8601 timestamp |
| `level` | Yes | `debug`, `info`, `warning`, `error` |
| `service` | Yes | Service name (`api`, `firewall`, `secrets`) |
| `event` | Yes | Machine-readable event name |
| `msg` | No | Human-readable message |
| `thread_key` | No | Thread identifier (when applicable) |

> **Never log secret values, auth headers, or raw tokens.**

## Deployment

The deploy box (self-hosted GitHub Actions runner) is accessible via SSH:

```bash
ssh ubuntu@206.223.235.69
```

The canonical checkout lives at `/home/ubuntu/github/paradigmxyz/centaur` on the box.

All deploys happen automatically via GitHub Actions on merge to `main`.

| Change | Deploy action |
|--------|--------------|
| `tools/**` only | Zero-downtime hot-reload (file watcher auto-detects, no restart) |
| `services/api/**` | `docker compose up -d --build api` |
| `services/slackbot/**` | `docker compose up -d --build slackbot` |
| `services/sandbox/**` | `docker compose build sandbox` |
| `docker-compose.yml`, `services/api/Dockerfile` | Rebuild API |

**Tool hot-reload:** The API watches bind-mounted `tools/` directories via `watchfiles`. When tool files change, the API auto-reloads within seconds — no container restart needed.

## E2E Testing (without Slack)

### 1. Bring up the stack

```bash
docker compose up -d postgres api
docker compose build sandbox
```

All E2E curl commands below use `docker exec` for localhost bypass (no API key needed).
To test from outside the container, create a DB-backed key via the [admin API](#api-key-management).

### 2. Spawn a runtime assignment

```bash
THREAD_KEY=test-e2e-1

SPAWN=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/spawn \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")
ASSIGNMENT_GENERATION=$(printf '%s' "$SPAWN" | jq -r '.assignment_generation')
```

### 3. Persist a message

```bash
docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/message \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Reply with exactly PONG and nothing else.\"}]}"
```

### 4. Enqueue execution

```bash
EXECUTE=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")
EXECUTION_ID=$(printf '%s' "$EXECUTE" | jq -r '.execution_id')
```

### 5. Tail durable events (or reconnect later)

```bash
docker exec centaur-api-1 curl -s -N \
  "http://localhost:8000/agent/threads/${THREAD_KEY}/events?execution_id=${EXECUTION_ID}&after_event_id=0"
```

If this stream disconnects, reconnect with the last seen `event_id` as `after_event_id`. If the execution already finished, the endpoint emits the terminal `execution_state` snapshot.

### 6. Inspect or cancel

```bash
docker exec centaur-api-1 curl -s "http://localhost:8000/agent/executions/${EXECUTION_ID}" | jq

docker exec centaur-api-1 curl -s -X POST \
  "http://localhost:8000/agent/executions/${EXECUTION_ID}/cancel" \
  -H "Content-Type: application/json" \
  -d '{}'
```

### 7. Release the assignment when finished

```bash
docker exec centaur-api-1 curl -s -X POST "http://localhost:8000/agent/threads/${THREAD_KEY}/release" \
  -H "Content-Type: application/json" \
  -d '{"release_id":"rel-test-e2e-1","cancel_inflight":true}'
```

### Debugging

```bash
docker ps --filter label=centaur-agent=true
docker exec <container_id> curl -s http://api:8000/health
```
