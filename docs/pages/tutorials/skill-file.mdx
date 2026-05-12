---
title: Use with Your AI Agent
description: Give Amp, Claude Code, or another local agent the Centaur operating manual.
---

# Use with Your AI Agent

If you want a local coding agent to build on Centaur, give it a small skill file. The skill teaches the API shape, plugin surfaces, deployment rules, and the key internal-vs-external URL distinction.

You can also point the agent at this site:

> Read the Centaur docs and help me build a tool, workflow, skill, or app.

The skill below is faster and more explicit.

## Install

Amp-style skill directory:

```bash
mkdir -p ~/.config/agents/skills/centaur-builder
$EDITOR ~/.config/agents/skills/centaur-builder/SKILL.md
```

Claude Code project skill directory:

```bash
mkdir -p .claude/skills/centaur-builder
$EDITOR .claude/skills/centaur-builder/SKILL.md
```

## Skill file

Copy this into `SKILL.md`:

````markdown
---
name: centaur-builder
description: "Build and operate on Centaur. Use when asked to call Centaur APIs, add tools, write skills, create workflows, deploy apps, or explain Centaur architecture."
---

# Centaur Builder

Centaur is a production control plane for shared AI agents. Prefer small extension points over core changes.

## URLs and auth

- External API URL: `https://api.acme.com` unless the user provides another deployment.
- Internal API URL from Centaur apps/sandboxes: `http://api:8000`.
- External auth header: `X-Api-Key: $CENTAUR_API_KEY` or `Authorization: Bearer $CENTAUR_API_KEY`.
- Internal callers may not need a public API key; do not invent one.

## Agent turn protocol

Use `spawn → message → execute → events`.

```bash
THREAD_KEY="agent-$(date +%s)"

SPAWN=$(curl -s -X POST "https://api.acme.com/agent/spawn" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")

GEN=$(printf '%s' "$SPAWN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["assignment_generation"])')
```

Then persist a user message, execute, and stream `/agent/threads/{thread_key}/events?execution_id=...&after_event_id=0`.

## Tools

Tools live in `tools/<name>/` and expose public client methods as `/tools/{name}/{method}`.

Required files:

```text
tools/<name>/
├── __init__.py
├── client.py
└── pyproject.toml
```

Rules:

- `client.py` has a `_client()` factory.
- Public methods have docstrings.
- Methods starting with `_` are private.
- Use `secret("NAME")` from `centaur_sdk.tool_sdk` for credentials.
- Validate by importing `_client()` and calling the changed method.

## Skills

Skills live in `.agents/skills/<name>/SKILL.md`.

Rules:

- Frontmatter includes `name` and `description`.
- `name` matches the directory.
- Description includes trigger language.
- Steps state what evidence/tools to use and what output format to produce.

## Workflows

Workflows live in `workflows/<name>.py`.

Rules:

- Export `WORKFLOW_NAME`.
- Define an `Input` dataclass when input is non-trivial.
- Define `async def handler(inp, ctx)`.
- Use `ctx.step`, `ctx.sleep`, `ctx.run_agent`, `ctx.wait_for_event`, or child workflows for durable behavior.
- Validate with syntax/import checks and a one-iteration smoke run when possible.

## Apps

Deploy apps with `POST /apps`:

```bash
curl -s -X POST "https://api.acme.com/apps" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "name": "my-app",
    "repo_url": "https://github.com/ORG/REPO",
    "port": 3000,
    "env": {"API_URL": "http://api:8000"}
  }'
```

Never expose a public API key to browser code. Use a backend route or Worker endpoint.

## Deploy discipline

- For tools/skills/workflows, open a narrow PR to the Centaur repo or overlay.
- Validate before pushing.
- Do not merge unless the user explicitly asks and CI/review gates are satisfied.
- For apps, deploy or restart through the Apps API.
- For docs, build `centaur-docs` and deploy through Wrangler.

## Verification

Always verify the exact changed surface:

- Tool: `GET /tools/{name}` and `POST /tools/{name}/{method}`.
- Skill: fresh agent session triggers or loads it.
- Workflow: `POST /workflows/runs`, then inspect status/checkpoints.
- App: load URL and check logs.
- Kubernetes sandbox backend: run `scripts/smoke-k8s-sandbox-backend.sh`.
````

## Test it

Start a fresh agent session and ask:

> Add a small Centaur tool for a public API. Validate it locally and stop at a PR.

The agent should choose `tools/<name>/`, include `_client()`, avoid secrets unless needed, run a local method check, and avoid merging without explicit approval.
