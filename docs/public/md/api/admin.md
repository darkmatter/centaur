---
title: Admin API
description: Create, list, and revoke scoped Centaur API keys for operators, apps, Slackbot, and external API clients.
---

# Admin API

Use the Admin API when you manage a Centaur deployment or issue API access to
another person, app, automation, or service. API keys are DB-backed, start with
`aiv2_`, and are stored hashed in Postgres. The plaintext key is returned once
when you create it.

Admin routes require one of:

- a request from API loopback, such as `docker exec centaur-api-1 curl http://localhost:8000/admin/...`,
- an API key with the `admin` scope.

## Scope model

| Scope | Grants |
|-------|--------|
| `*` | Everything. Use only for break-glass operators. |
| `admin` | Admin routes, including API key creation, listing, revocation, and operator health checks. |
| `agent` | All agent actions, including spawn, message, execute, stream, cancel, release, status, and stop. |
| `agent:execute` | Agent turn and workflow execution routes. |
| `agent:status` | Agent status and thread inspection routes. |
| `agent:stop` | Stop routes. |
| `tools:*` | Discover and call every available tool. |
| `tools:<name>` | Discover and call one tool, for example `tools:slack` or `tools:chart`. |
| `threads` | Thread-oriented access reserved for thread APIs. |

A bare category grants sub-actions. For example, `agent` grants
`agent:execute`, `agent:status`, and `agent:stop`.

## Step 1. Create the first admin key

From the machine running the local Centaur stack, use the API container's
localhost bypass:

```bash
ADMIN_KEY=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/admin/api-keys \
  -H "Content-Type: application/json" \
  -d '{
    "name": "operator:alice",
    "scopes": ["admin"],
    "created_by": "bootstrap"
  }' | jq -r .key)

printf '%s\n' "$ADMIN_KEY"
```

Save the key in your password manager. It will not be shown again.

## Step 2. List keys

```bash
curl -s "$CENTAUR_API_URL/admin/api-keys" \
  -H "X-Api-Key: $ADMIN_KEY" | jq
```

The list includes key IDs, names, prefixes, scopes, creator, and revocation
state. It never returns plaintext keys or key hashes.

## Step 3. Create a tool-only key

Use a tool-only key when an app should call a specific integration but should
not run agents.

```bash
SLACK_TOOL_KEY=$(curl -s -X POST "$CENTAUR_API_URL/admin/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ADMIN_KEY" \
  -d '{
    "name": "app:slack-reader",
    "scopes": ["tools:slack"],
    "created_by": "alice"
  }' | jq -r .key)
```

Verify what the key can discover:

```bash
curl -s "$CENTAUR_API_URL/tools" \
  -H "X-Api-Key: $SLACK_TOOL_KEY" | jq
```

## Step 4. Create an agent API key

Use an agent key when a client should use Centaur like an authenticated agent
control plane: create a thread, send messages, execute work, and stream output.

```bash
AGENT_KEY=$(curl -s -X POST "$CENTAUR_API_URL/admin/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ADMIN_KEY" \
  -d '{
    "name": "client:research-console",
    "scopes": ["agent:execute", "tools:*"],
    "created_by": "alice"
  }' | jq -r .key)
```

This is the closest Centaur shape to an authenticated MCP-style server: clients
can discover tool methods through `/tools`, call authorized tools through
`/tools/{name}/{method}`, and run an agent loop through `/agent/*`.

## Step 5. Create the Slackbot service key

Slack webhooks are authenticated with Slack signatures, but the Slackbot still
needs a Centaur API key when it calls the Agent API after a Slack event is
validated.

```bash
SLACKBOT_API_KEY=$(curl -s -X POST "$CENTAUR_API_URL/admin/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ADMIN_KEY" \
  -d '{
    "name": "service:slackbot",
    "scopes": ["agent"],
    "created_by": "alice"
  }' | jq -r .key)
```

Store that value as `SLACKBOT_API_KEY` in the deployment secret manager, then
restart the Slackbot service.

## Step 6. Revoke a key

Find the key ID:

```bash
curl -s "$CENTAUR_API_URL/admin/api-keys" \
  -H "X-Api-Key: $ADMIN_KEY" | jq '.keys[] | {id, name, key_prefix, scopes, revoked_at}'
```

Revoke it:

```bash
curl -s -X DELETE "$CENTAUR_API_URL/admin/api-keys/$KEY_ID" \
  -H "X-Api-Key: $ADMIN_KEY" | jq
```

Revocation invalidates the key for future requests. Existing in-flight requests
may finish.

## Step 7. Give someone the right key

| Recipient | Suggested scopes |
|-----------|------------------|
| Tool-only app | `["tools:<name>"]` |
| Analytics or dashboard app | `["tools:*"]` or the specific tools it needs |
| Agent client | `["agent:execute", "tools:*"]` |
| Slackbot service | `["agent"]` |
| Operator | `["admin"]` |
| Temporary break-glass operator | `["*"]` |

Prefer narrow scopes and descriptive key names. Treat the plaintext key like a
password: store it once, do not paste it into Slack, and revoke it when the
integration no longer needs access.
