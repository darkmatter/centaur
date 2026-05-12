---
title: Deploy on Your Infrastructure
description: Deploy Centaur tools, skills, workflows, apps, docs, chart rendering, and infrastructure changes safely.
---

# Deploy on Your Infrastructure

Use this guide when you are moving Centaur changes from local work into a
running deployment.

For a first deployment from zero, start with the
[Golden Path](/tutorials/golden-path), then return here when you need to ship
tools, workflows, apps, docs, or infrastructure changes.

For first-time Slack, GitHub, model, and baseline secret setup, complete
[Set Up Centaur](/setup) before deploying user-facing workflows.

For a team rollout, use [Operator Rollout](/ops/rollout) to scope the first
workflows, overlay, handoff, and maintenance loop.

To create the host first, use [Deploy on AWS EC2](/ops/aws/ec2),
[Deploy on GCP Compute Engine](/ops/gcp/vm), or
[Deploy on Bare Metal](/ops/bare-metal). For managed Kubernetes, use
[Deploy on AWS EKS](/ops/aws/eks) or [Deploy on GCP GKE](/ops/gcp/gke).

## Step 1. Choose the artifact

| Artifact | Deploy path | Runtime behavior |
|----------|-------------|------------------|
| Tool | PR to `tools/<name>/` | Exposed as `/tools/{name}` and hot-reloaded. |
| Skill | PR to `.agents/skills/<name>/` | Available to fresh agent sessions after deployment. |
| Workflow | PR to `workflows/<name>.py` | Available through `/workflows/runs` after hot-reload. |
| Chart rendering | PR to `centaur_charts/` or `tools/infra/chart/` | Rendered through `/tools/chart/render_chart` as PNG output. |
| Web app | `POST /apps` | Cloned, built, and run as a long-lived app container. |
| Docs | `centaur-docs` build plus Wrangler deploy | Static Vocs output served by Cloudflare Worker assets. |
| Core/API/infra | PR plus CI/CD plus Helm promotion | Validated locally, then rolled out through the chart. |

## Step 2. Validate locally

Run the affected service before pushing a deployment change.

```bash
docker compose build api
docker compose up -d postgres api
```

For sandbox or agent-runtime changes, also rebuild the sandbox image:

```bash
docker compose build sandbox
```

For Helm changes, validate the chart:

```bash
helm lint contrib/chart
helm template centaur contrib/chart -f values.production.yaml >/tmp/centaur-rendered.yaml
```

## Step 3. Ship tools, skills, and workflows through Git

1. Put the change in the smallest correct directory.
2. Run the local test or smoke command for that artifact.
3. Open a PR with the validation output.
4. Merge after review and CI.
5. Verify discovery or execution in the target deployment.

Tool verification:

```bash
curl -s "$CENTAUR_API_URL/tools/my-tool" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool

curl -s -X POST "$CENTAUR_API_URL/tools/my-tool/my_method" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{"sample": true}' | python3 -m json.tool
```

Workflow verification:

```bash
curl -s -X POST "$CENTAUR_API_URL/workflows/runs" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{"workflow_name":"my_workflow","input":{},"eager_start":true}' | python3 -m json.tool
```

## Step 4. Include chart output

Use the chart tool for dashboards, Slack output, and app visuals. It routes all
supported chart families through `centaur_charts`, so outputs share the same
styling and mobile-readable PNG defaults.

```bash
curl -s -X POST "$CENTAUR_API_URL/tools/chart/render_chart" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "chart_type": "horizontal_bar",
    "title": "Tool calls by integration",
    "data": [
      {"tool": "slack", "calls": 128},
      {"tool": "websearch", "calls": 94},
      {"tool": "chart", "calls": 31}
    ],
    "x": "tool",
    "y": "calls",
    "source": "Centaur tool call logs"
  }' | python3 -c 'import json,sys; result=json.load(sys.stdin)["result"]; print(f"rendered chart: {len(result)} base64 chars")'
```

Supported chart families are included in the [step-by-step API guide](/first-call#step-5-render-a-chart).

## Step 5. Deploy an app

Apps deploy through the Apps API, not by landing in the Centaur repo.

```bash
curl -s -X POST "$CENTAUR_API_URL/apps" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d '{
    "name": "research-console",
    "repo_url": "https://github.com/your-org/research-console",
    "port": 3000,
    "env": {"API_URL": "http://api:8000"}
  }' | python3 -m json.tool
```

Check status and logs:

```bash
curl -s "$CENTAUR_API_URL/apps/_manage/research-console" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool

curl -s "$CENTAUR_API_URL/apps/_manage/research-console/logs" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool
```

Restart after pushing app code:

```bash
curl -s -X POST "$CENTAUR_API_URL/apps/_manage/research-console/restart" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | python3 -m json.tool
```

## Step 6. Deploy docs

```bash
cd centaur-docs
npm install
npm run build
npm run deploy
```

The docs app uses Vocs main via `https://pkg.pr.new/vocs@main` and deploys
`dist/` through Wrangler static assets.

## Step 7. Deploy infrastructure

Use the Helm chart for API, worker, sandbox, proxy, and database changes. A
typical production values file selects Kubernetes sandboxes and enables Iron
Proxy:

```yaml
api:
  sandboxBackend: kubernetes
  executionWorkerEnabled: true
  warmPoolEnabled: true
  runtimeCredentialGuardEnabled: true

ironProxy:
  enabled: true
  manager:
    secretSource: onepassword

sandbox:
  runtimeClassName: gvisor
```

Render, lint, and apply:

```bash
helm lint contrib/chart
helm template centaur contrib/chart -f values.production.yaml >/tmp/centaur-rendered.yaml

helm upgrade --install centaur contrib/chart \
  --namespace centaur-system \
  --create-namespace \
  -f values.production.yaml
```

After rollout, verify Kubernetes sandboxes and a credential-backed tool call.

## Step 8. Create API keys for API callers

Centaur can be used as an authenticated API surface for apps, automations, and
other agent clients. Operators create DB-backed keys through the Admin API and
choose scopes per recipient.

Create the first admin key from the API container using localhost bypass:

```bash
ADMIN_KEY=$(docker exec centaur-api-1 curl -s -X POST http://localhost:8000/admin/api-keys \
  -H "Content-Type: application/json" \
  -d '{
    "name": "operator:alice",
    "scopes": ["admin"],
    "created_by": "bootstrap"
  }' | jq -r .key)
```

Create a key for an app that should use Centaur as an authenticated agent and
tool control plane:

```bash
AGENT_CLIENT_KEY=$(curl -s -X POST "$CENTAUR_API_URL/admin/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ADMIN_KEY" \
  -d '{
    "name": "client:research-console",
    "scopes": ["agent:execute", "tools:*"],
    "created_by": "alice"
  }' | jq -r .key)
```

Create narrower keys for specific tools:

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

List and revoke keys:

```bash
curl -s "$CENTAUR_API_URL/admin/api-keys" \
  -H "X-Api-Key: $ADMIN_KEY" | jq

curl -s -X DELETE "$CENTAUR_API_URL/admin/api-keys/$KEY_ID" \
  -H "X-Api-Key: $ADMIN_KEY" | jq
```

Full scope details are in the [Admin API reference](/api/admin).

## Step 9. Configure the Slackbot webhook

Slack talks to Centaur over a webhook, not over the Agent API directly. The
Slack Events API posts to the Slackbot route:

```text
https://api.acme.com/api/webhooks/slack
```

The Slackbot validates each request with Slack's signing secret, then calls the
Centaur Agent API with `SLACKBOT_API_KEY`.

1. Create a Slack app at `https://api.slack.com/apps`.
2. Add the bot scopes from `services/slackbot/slack-app-manifest.yml`, including `app_mentions:read`, `chat:write`, channel/group/DM history scopes, file scopes, reaction scopes, and `assistant:write` if you use Slack assistant surfaces.
3. Enable Event Subscriptions.
4. Set the Request URL to `https://api.acme.com/api/webhooks/slack`.
5. Subscribe to bot events: `app_mention`, `assistant_thread_started`, `assistant_thread_context_changed`, `message.channels`, `message.groups`, and `message.im`.
6. Install the app to the workspace and copy the Bot User OAuth Token into `SLACK_BOT_TOKEN`.
7. Copy the Slack app Signing Secret into `SLACK_SIGNING_SECRET`.
8. Create or store a Centaur API key with `agent` scope as `SLACKBOT_API_KEY`.
9. Restart the Slackbot service.

Example service secrets:

```bash
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
SLACKBOT_API_KEY=aiv2_...
```

Slack signs webhooks with `X-Slack-Signature` and
`X-Slack-Request-Timestamp`. The Slackbot rejects events that fail signing
secret validation, so do not put Centaur API-key auth in front of
`/api/webhooks/slack`.

Verify the setup:

1. In Slack's Event Subscriptions page, confirm the Request URL verifies.
2. Mention the bot in a channel where it is installed.
3. Check Slackbot logs for `webhook_received` and `webhook_dispatched`.
4. Check API logs for the spawned agent execution.

## Step 10. Verify the deployed artifact

| Artifact | Verification |
|----------|--------------|
| Tool | `GET /tools/{name}`, then `POST /tools/{name}/{method}`. |
| Skill | Start a fresh agent session and ask for the skill by name or trigger. |
| Workflow | `POST /workflows/runs` with smoke input, then inspect status/checkpoints. |
| Chart rendering | `POST /tools/chart/render_chart` for each chart family your workflow emits. |
| API keys | Create a narrow key, confirm it can access only its intended routes, then revoke it. |
| Slackbot | Verify Slack Request URL, mention the bot, and confirm signed events reach the Slackbot. |
| App | Load the public URL and check `/apps/_manage/{name}/logs`. |
| Docs | Load the Worker URL and run `npm run build` locally or in CI. |
| Kubernetes backend | Run `scripts/smoke-k8s-sandbox-backend.sh`. |
| Iron Proxy | Call a tool that uses `secret("NAME")` and confirm the sandbox never receives the raw value. |

## Step 11. Roll out secrets

1. Pick the env var name the code will call with `secret("NAME")`.
2. Add the value to the deployment secret manager.
3. If production uses Iron Proxy, confirm the proxy manager can resolve the secret.
4. Verify the secret-backed tool call before merging code that depends on it.
5. Keep the secret out of docs, PR descriptions, logs, and agent prompts.

## Step 12. Ask an agent to do the Git work

If your deployment provides a Centaur agent with repository access, send it a
precise shipping task. Include the target artifact, files, validation command,
and whether you want a PR or a merge.

```bash
THREAD_KEY="deploy-$(date +%s)"

SPAWN=$(curl -s -X POST "$CENTAUR_API_URL/agent/spawn" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")

GEN=$(printf '%s' "$SPAWN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["assignment_generation"])')

PROMPT='Add a tool named hackernews under tools/hackernews. Include client.py and pyproject.toml. Validate by importing _client() and calling top_stories(limit=1). Open a PR; do not merge.'
PROMPT_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.stdin.read().rstrip("\n")))' <<< "$PROMPT")

curl -s -X POST "$CENTAUR_API_URL/agent/message" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${GEN},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":${PROMPT_JSON}}]}"

EXECUTE=$(curl -s -X POST "$CENTAUR_API_URL/agent/execute" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $CENTAUR_API_KEY" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${GEN},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")

EXECUTION_ID=$(printf '%s' "$EXECUTE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["execution_id"])')

curl -s -N "$CENTAUR_API_URL/agent/threads/${THREAD_KEY}/events?execution_id=${EXECUTION_ID}&after_event_id=0" \
  -H "X-Api-Key: $CENTAUR_API_KEY"
```

Ask for merge or production deploy only when you want that action taken.
