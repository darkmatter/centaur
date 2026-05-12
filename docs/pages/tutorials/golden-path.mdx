---
title: Golden Path
description: "The first complete Centaur deployment path: host, Slack, harness credentials, GitHub, API keys, one tool, one app, and verification."
---

# Golden Path

This is the first complete path for a new Centaur deployment. It is the route
to prove the system end to end before adding more tools, workflows, overlays,
or apps.

If you only need the local smoke path, run [Quickstart](/quickstart) first.

## Step 1. Pick The Host

Choose one:

| Host | Guide |
|------|-------|
| AWS EC2 | [Deploy on AWS EC2](/ops/aws/ec2) |
| GCP Compute Engine | [Deploy on GCP Compute Engine](/ops/gcp/vm) |
| Bare metal or private VM | [Deploy on Bare Metal](/ops/bare-metal) |
| AWS EKS | [Deploy on AWS EKS](/ops/aws/eks) |
| GCP GKE | [Deploy on GCP GKE](/ops/gcp/gke) |

For a first operator-run deployment, EC2 or GCP Compute Engine is usually the
fastest path. Use Kubernetes when you need sandbox pods, warm pools, and
stronger production boundaries.

## Step 2. Configure Secrets

Follow [Set Up Centaur](/setup). Minimum bootstrap secrets:

```bash
OP_SERVICE_ACCOUNT_TOKEN=...
OP_VAULT=...
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
SLACKBOT_API_KEY=...
```

Minimum runtime secrets in the configured secret backend:

```bash
GITHUB_TOKEN=...
AMP_API_KEY=...
```

Add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` if you want Claude Code and
Codex.

## Step 3. Configure Slack

1. Create the Slack app.
2. Install it to the workspace.
3. Set the Request URL:

```text
https://centaur.example.com/api/webhooks/slack
```

4. Confirm the Slack Event Subscriptions verifier succeeds.
5. Mention the bot in a private test channel.

The webhook is validated by Slack signing secret. Slackbot then calls Centaur
with `SLACKBOT_API_KEY`.

## Step 4. Configure Harnesses

For the default path:

1. Store the Amp auth token as `AMP_API_KEY`.
2. Make sure the sandbox receives only `AMP_API_KEY=AMP_API_KEY`.
3. Make sure Iron Proxy or the firewall injects the real token on outbound
   `ampcode.com` calls.

See [Configure Agent Harnesses](/ops/harnesses) for Claude Code, Codex,
1Password, AWS Secrets Manager, and Google Secret Manager.

## Step 5. Boot The Stack

For the local Kubernetes stack:

```bash
just up
just status
```

For a production Kubernetes deployment, lint the chart and apply your
environment-specific values file with `helm upgrade --install`:

```bash
helm lint contrib/chart
helm upgrade --install centaur contrib/chart \
  --namespace centaur \
  --create-namespace \
  -f values.production.yaml
```

## Step 6. Verify Runtime Credentials

```bash
curl -s "$CENTAUR_API_URL/health/runtime-credentials?refresh=true" \
  -H "X-Api-Key: $ADMIN_KEY" | jq
```

The report should show required keys present. If `ANTHROPIC_API_KEY` or
`OPENAI_API_KEY` are required, provider probes should be `ok` or rate-limited,
not invalid.

## Step 7. Run One Agent Turn

From inside the API deployment:

```bash
THREAD_KEY=golden-path-amp

SPAWN=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/spawn \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"harness\":\"amp\"}")
ASSIGNMENT_GENERATION=$(printf '%s' "$SPAWN" | jq -r '.assignment_generation')

kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/message \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"role\":\"user\",\"parts\":[{\"type\":\"text\",\"text\":\"Reply with exactly PONG.\"}]}"

EXECUTE=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/agent/execute \
  -H "Content-Type: application/json" \
  -d "{\"thread_key\":\"${THREAD_KEY}\",\"assignment_generation\":${ASSIGNMENT_GENERATION},\"harness\":\"amp\",\"delivery\":{\"platform\":\"dev\"}}")
EXECUTION_ID=$(printf '%s' "$EXECUTE" | jq -r '.execution_id')

kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s \
  "http://localhost:8000/agent/executions/${EXECUTION_ID}" | jq
```

Then run the same prompt through Slack:

```text
--amp reply with exactly PONG
```

## Step 8. Add One Tool

Build or enable one useful tool. Verify discovery:

```bash
curl -s "$CENTAUR_API_URL/tools/<tool>" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | jq
```

Then ask the agent to use it in Slack. The first deployment should include at
least one tool that makes the agent organization-specific.

## Step 9. Deploy One App

Deploy a small app so the app plane is proven:

```bash
curl -s -X POST "$CENTAUR_API_URL/apps" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $APP_DEPLOY_KEY" \
  -d '{
    "name": "ops-console",
    "repo_url": "https://github.com/your-org/ops-console",
    "port": 3000,
    "env": {"API_URL": "http://api:8000"}
  }' | jq
```

Check logs:

```bash
curl -s "$CENTAUR_API_URL/apps/_manage/ops-console/logs" \
  -H "X-Api-Key: $APP_DEPLOY_KEY" | jq
```

## Step 10. Capture The Operating Loop

Before expanding:

1. Identify the operator.
2. Record where secrets live.
3. Record how to restart the stack.
4. Record the first working Slack channel.
5. Record the first enabled harness.
6. Record the first useful tool.
7. Record the first app owner.
8. Record how to inspect logs.

Then move to [Operator Rollout](/ops/rollout), [Overlay Operating Model](/ops/overlays), and [Scaling Centaur](/ops/scaling).
