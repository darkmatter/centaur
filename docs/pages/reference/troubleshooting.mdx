---
title: FAQ & Troubleshooting
description: Common Centaur setup questions, failure modes, recovery commands, and where to inspect state.
---

# FAQ & Troubleshooting

Use this page when a local stack, Slack turn, API request, tool call, workflow, or sandbox harness does not behave as expected.

## Quick checks

Run these first from the repo root:

```bash
just status
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -fsS http://localhost:8000/health
kubectl get pods -n centaur -l centaur-agent=true
```

If the API is healthy but agent turns fail, check runtime credentials:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- \
  curl -fsS "http://localhost:8000/health/runtime-credentials?refresh=true"
```

## Frequently asked questions

### What should I run first?

Run [Quickstart](/quickstart). It boots the local Kubernetes stack and proves one durable agent turn. Do not start with Slack, overlays, or custom tools unless you already have a known-good API turn.

### Does local testing require an API key?

Not when the request runs from inside the API deployment against `http://localhost:8000`. That path is used for local E2E validation and is the recommended way to prove control-plane behavior before exposing external routes.

External clients should use DB-backed API keys with the narrowest useful scopes.

### Which harness should I use first?

Use Amp first unless your deployment has standardized on another harness. The API value is `amp`, and Slack prompts can route with `--amp`. Add Claude Code or Codex after the default harness is working.

### Where should secrets live?

Infra bootstrap values are created as Kubernetes Secrets through `just bootstrap-secrets`. Application-level model and tool secrets should live in the configured secret backend, usually 1Password for shared deployments. Sandboxes should receive placeholders, not raw provider tokens.

### How do I know whether a failed turn was saved?

Inspect the execution row:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s \
  "http://localhost:8000/agent/executions/${EXECUTION_ID}" | jq
```

Then replay events:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -N \
  "http://localhost:8000/agent/threads/${THREAD_KEY}/events?execution_id=${EXECUTION_ID}&after_event_id=0"
```

## Common failures

| Symptom | Likely cause | What to check |
|---------|--------------|---------------|
| `just up` fails during bootstrap | Required env vars missing | `OP_SERVICE_ACCOUNT_TOKEN`, `OP_VAULT`, Slack tokens, `SLACKBOT_API_KEY` |
| API pod is not ready | Image build, migration, secret, or dependency failure | `just logs api`, `kubectl describe pod -n centaur <api-pod>` |
| Sandbox pod never appears | Runtime assignment or warm-pool issue | API logs, `kubectl get pods -n centaur -l centaur-agent=true` |
| Harness auth error | Missing runtime secret or broken proxy injection | `/health/runtime-credentials?refresh=true`, [Agent Harnesses](/ops/harnesses) |
| Slack event verifier fails | Wrong public URL or signing secret | Slack app Event Subscriptions and `SLACK_SIGNING_SECRET` |
| Slack mention is received but no reply appears | Slackbot API key, event dispatch, or final delivery issue | `just logs slackbot`, execution state, final delivery outbox logs |
| Tool discovery misses a tool | Plugin path, import error, or missing dependency | API logs and `GET /tools` |
| Workflow re-runs a completed step | Step name changed or checkpoint set differs | Workflow checkpoints and code diff |
| Event stream disconnects | Client/network disconnect | Reconnect with the last seen `event_id` |

## Recovery flows

### Local stack reset

Use this when the local namespace is disposable:

```bash
just down
just up
```

Then rerun the [Quickstart](/quickstart) `PONG` turn.

### API turn recovery

1. Keep `THREAD_KEY` and `EXECUTION_ID`.
2. Read execution state.
3. Replay events with `after_event_id=0`.
4. If the turn is still running but unwanted, cancel it.
5. Release the thread assignment only when you are done with that runtime.

Cancel:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST \
  "http://localhost:8000/agent/executions/${EXECUTION_ID}/cancel" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Release:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST \
  "http://localhost:8000/agent/threads/${THREAD_KEY}/release" \
  -H "Content-Type: application/json" \
  -d "{\"release_id\":\"rel-${THREAD_KEY}\",\"cancel_inflight\":true}"
```

### Slack recovery

1. Confirm the Slack app is installed in the workspace and channel.
2. Confirm Event Subscriptions point at the deployed Slackbot route.
3. Confirm `SLACK_SIGNING_SECRET` matches the app.
4. Confirm `SLACKBOT_API_KEY` exists and has agent scope.
5. Check `just logs slackbot`.
6. Find the thread key in logs, then inspect the Agent API execution state.

### Harness recovery

1. Verify the sandbox has placeholders, not raw values.
2. Verify the secrets backend has the real token.
3. Verify the firewall or Iron Proxy injection map includes the upstream host.
4. Run one `PONG` turn for the specific harness.

See [Configure Agent Harnesses](/ops/harnesses) for the full credential path.

## Where state lives

| State | Table or surface |
|-------|------------------|
| Thread runtime pin | `agent_runtime_assignments` |
| Inbound messages | `agent_message_requests` |
| Execution rows | `agent_execution_requests` |
| Replayable output | `agent_execution_events` |
| Final delivery obligation | `agent_final_delivery_outbox` |
| Workflow runs | `workflow_runs` |
| Workflow checkpoints | `workflow_checkpoints` |
| Attachments | `attachments` |

## When to read source

- Agent API behavior: `services/api/api/routers/agent.py` and `services/api/api/runtime_control.py`
- Sandbox harness translation: `services/sandbox/harness_session.py`
- Workflow replay semantics: `services/api/api/workflow_engine.py`
- Slack delivery: `services/slackbot/src/lib/slack/`
- Tool discovery: `services/api/api/tool_manager.py`

If source and docs disagree, trust the source and update the docs in the same change.
