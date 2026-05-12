---
title: Quickstart
description: Boot Centaur locally, verify the control plane, run one agent turn, and know where to go next.
---

# Quickstart

This guide gets you from a fresh checkout to a working local Centaur stack. It follows the local Kubernetes path used by the repo: bootstrap secrets, build images, deploy the Helm chart, then run one durable agent turn through the API.

## Who this is for

- You want the shortest path to a working Centaur stack.
- You are evaluating whether Centaur fits your team.
- You need one known-good local environment before changing tools, workflows, prompts, or apps.
- You are debugging a deployment and want to return to the smallest working loop.

## The fastest path

| Goal | Start here | Then prove |
|------|------------|------------|
| Run Centaur locally | `just up` | API readiness and one `PONG` agent turn |
| Configure a team deployment | [Set Up Centaur](/setup) | Slack mention, sandbox, and harness credentials |
| Understand what to read | [Learning Path](/learning-path) | One path that matches your role |
| Call Centaur from an app | [First API Call](/first-call) | Spawn, message, execute, stream |
| Extend a working stack | [Tips & Best Practices](/guides/best-practices) | One tool, workflow, skill, or app |

Rule of thumb: do not add Slack, multiple harnesses, overlays, apps, or scheduled workflows until a plain API turn works.

## 1. Install prerequisites

From the repo root:

```bash
brew install just
```

You also need Docker and a local Kubernetes cluster that can run the Helm chart. The `Justfile` builds the service images locally and deploys `contrib/chart` with `contrib/chart/values.dev.yaml`.

## 2. Export bootstrap secrets

Centaur creates the initial Kubernetes Secrets from your shell environment.

```bash
export OP_SERVICE_ACCOUNT_TOKEN=...
export OP_VAULT=...
export SLACK_BOT_TOKEN=...
export SLACK_SIGNING_SECRET=...
export SLACKBOT_API_KEY=...
```

Application-level model and tool secrets, such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `AMP_API_KEY`, should live in the configured secret backend. For local throwaway testing you can also use an env-backed secret path, but shared deployments should keep raw tokens out of sandboxes.

## 3. Boot the stack

```bash
just up
```

That runs:

1. `just bootstrap-secrets`
2. `just build`
3. `just deploy`

Check the namespace:

```bash
just status
```

## 4. Verify the API

The API exposes localhost inside its own deployment, which is the easiest way to bypass external auth during local E2E tests:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- \
  curl -fsS http://localhost:8000/health
```

Expected shape:

```json
{"status":"ok"}
```

If readiness fails, check [FAQ & Troubleshooting](/reference/troubleshooting) before adding more moving parts.

## 5. Run one agent turn

Use one thread key for the whole turn:

```bash
THREAD_KEY="quickstart-$(date +%s)"

SPAWN=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/spawn \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")
ASSIGNMENT_GENERATION=$(printf '%s' "$SPAWN" | jq -r '.assignment_generation')

kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/message \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Reply with exactly PONG and nothing else.\"}]}"

EXECUTE=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")
EXECUTION_ID=$(printf '%s' "$EXECUTE" | jq -r '.execution_id')

kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s \
  "http://localhost:8000/agent/executions/${EXECUTION_ID}" | jq
```

Success means the execution reaches a terminal state and the final result includes `PONG`.

## 6. Stream durable events

For a live or replayed event stream:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -N \
  "http://localhost:8000/agent/threads/${THREAD_KEY}/events?execution_id=${EXECUTION_ID}&after_event_id=0"
```

Keep the latest `event_id`. If the connection drops, reconnect with `after_event_id=<last_seen_id>`. If the run already finished, Centaur emits the terminal execution state.

## 7. Try Slack after the API works

Only move to Slack after the API loop works. Mention the bot in a test channel where the Slack app is installed:

```text
--amp reply with exactly PONG
```

If Slack receives the mention but no agent runs, inspect Slackbot logs:

```bash
just logs slackbot
```

## 8. Add the next layer

Pick one next step:

| Need | Next doc |
|------|----------|
| Configure all required secrets and connectors | [Set Up Centaur](/setup) |
| Prove a deployment end to end | [Golden Path](/tutorials/golden-path) |
| Add an API or data source | [Build a Tool](/tutorials/tool) |
| Add a recurring or long-running job | [Build a Workflow](/tutorials/workflow) |
| Build a human-facing interface | [Build a Web App](/tutorials/app) |
| Debug a broken local stack | [FAQ & Troubleshooting](/reference/troubleshooting) |

## Common failure modes

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `just up` fails during bootstrap | Required shell env vars are missing | Export the bootstrap secrets and rerun `just bootstrap-secrets` |
| API health fails | Deployment is not ready or image build failed | `just status`, then `kubectl describe pod -n centaur <pod>` |
| Agent turn queues forever | No sandbox could be assigned | Check API logs and sandbox pods with `kubectl get pods -n centaur -l centaur-agent=true` |
| Harness returns auth errors | Runtime credential is missing or proxy injection is not working | Check `/health/runtime-credentials?refresh=true` and [Agent Harnesses](/ops/harnesses) |
| Slack mention is ignored | App scopes, event subscription, signing secret, or `SLACKBOT_API_KEY` is wrong | Re-run [Connector Setup](/ops/connectors) |

## Recovery toolkit

Use this order when the local stack feels unknown:

```bash
just status
just logs api
kubectl get pods -n centaur -l centaur-agent=true
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -fsS http://localhost:8000/health
just smoke
```

Then return to the one-turn `PONG` test before adding features back.
