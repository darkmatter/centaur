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

# API auth key (generate one: openssl rand -hex 32)
API_SECRET_KEY=your-api-key-here

# Slack app (from https://api.slack.com/apps)
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACKBOT_API_KEY=your-api-key-here

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
docker build -t centaur-agent:latest services/sandbox/
```

### 3. Test

```bash
source .env
curl -s -X POST http://localhost:8000/agent/execute \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_key": "test:hello",
    "message": "Hello, what can you do?",
    "harness": "amp"
  }'
```

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
               │ + Redis   │    sandbox_sessions, chat_messages
               └──────────┘
```

### End-to-End Request Flow

1. User mentions bot in Slack → webhook → nginx → slackbot → api
2. API spawns/reuses Docker container (`centaur-agent:latest`) for that thread
3. Executes harness (amp/claude-code/codex) via `docker exec`
4. Harness calls tools via `curl` back to API at `http://api:8000` (REST, NOT MCP)
5. LLM API calls route through firewall proxy which injects real credentials
6. Results stream as JSON events → posted to Slack

### Network Isolation

| Network | Scope | Services |
|---------|-------|----------|
| `secrets_net` | internal | firewall → secrets |
| `secrets_egress` | external | secrets → 1Password SDK |
| `agent_net` | internal | sandbox containers ↔ firewall ↔ api |
| `app_net` | internal | api ↔ slackbot ↔ auth |
| `control_net` | internal | api ↔ pgbouncer ↔ firewall |
| `data_net` | internal | postgres, redis, pgbouncer ↔ api |
| `obs_net` | internal | prometheus, victorialogs, promtail, grafana |

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
│   ├── prometheus/       # Prometheus config
│   └── promtail/         # Promtail log shipping config
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

- **Chat SDK** always refers to the [Vercel Chat SDK](https://github.com/vercel/chat) (`~/github/vercel/chat`)

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

- **API auth**: Bearer token via `verify_api_key` dependency; Docker bridge IPs bypass auth for container→API calls
- **Slack**: HMAC-SHA256 signature verification on all webhooks
- **UI**: Password-based HMAC session cookie; nginx `auth_request` gates all UI routes
- **Sandbox isolation**: Containers get stub keys only; real keys injected by firewall proxy in-flight
- **Filesystem**: Host repos mounted read-only by default; only working repo is read-write
- **Docker socket**: Proxied via `tecnativa/docker-socket-proxy` — only container/network/exec ops allowed

## Secret Manager

The secrets service (`services/secrets/app.py`) loads all secrets from a 1Password vault on startup and refreshes periodically. Item titles are normalized to ENV_VAR style (e.g., "Claude API" → `ANTHROPIC_API_KEY`).

For local development without 1Password, set `SECRET_MANAGER_BACKEND=env` and provide secrets directly in `.env`.

## Observability & Audit Logs

### Architecture

All services write structured JSON logs to **stdout**. Docker captures container logs. **Promtail** discovers all Docker containers (including dynamically spawned agent sandboxes) via the Docker socket and forwards logs to **VictoriaLogs** via the Loki-compatible push API. **Grafana** provides the query UI with a provisioned VictoriaLogs datasource.

```
Service → stdout (JSON) → Docker log driver → Promtail → VictoriaLogs → Grafana
```

This design means ephemeral sandbox containers are captured automatically — no per-container logging config needed.

### Components

| Component | Role | Config |
|-----------|------|--------|
| **VictoriaLogs** | Log storage + query engine | 7-day retention, `obs_net` |
| **Promtail** | Container log collector | Docker SD, `services/promtail/promtail.yml` |
| **Grafana** | Dashboards + log explorer | VictoriaLogs datasource provisioned |
| **Prometheus** | Metrics collection | `services/prometheus/prometheus.yml` |

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
| `services/sandbox/**` | `docker build -t centaur-agent:latest services/sandbox/` |
| `docker-compose.yml`, `services/api/Dockerfile` | Rebuild API |

**Tool hot-reload:** The API watches bind-mounted `tools/` directories via `watchfiles`. When tool files change, the API auto-reloads within seconds — no container restart needed.

## E2E Testing (without Slack)

### 1. Bring up the stack

```bash
docker compose up -d postgres api
docker build -t centaur-agent:latest services/sandbox/
source .env
```

### 2. Execute a message (auto-spawns container)

```bash
curl -s -X POST http://localhost:8000/agent/execute \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_key": "test:e2e-1",
    "message": "Hello, what can you do?",
    "harness": "amp"
  }'
```

### 3. Follow-up (same container, same session)

```bash
curl -s -X POST http://localhost:8000/agent/execute \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "thread_key": "test:e2e-1",
    "message": "now summarize the key topics"
  }'
```

### 4. Inspect / Clean up

```bash
curl -s "http://localhost:8000/agent/status?key=test:e2e-1" \
  -H "Authorization: Bearer $API_SECRET_KEY" | jq

curl -s -X POST http://localhost:8000/agent/stop \
  -H "Authorization: Bearer $API_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"thread_key": "test:e2e-1"}'
```

### Debugging

```bash
docker ps --filter label=centaur-agent=true
docker exec <container_id> curl -s -H "Authorization: Bearer $CENTAUR_API_KEY" http://api:8000/health
```
