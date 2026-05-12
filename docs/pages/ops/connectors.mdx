---
title: Connector Setup
description: "Configure the external systems Centaur needs: Slack, GitHub, harnesses, secret stores, tools, and apps."
---

# Connector Setup

Centaur is useful when it can connect to the systems where work already
happens. Use this as the operator checklist for a new deployment.

## Connector Inventory

| Connector | Required for | Secret or setting |
|-----------|--------------|-------------------|
| Slack app | Slack mentions and assistant threads | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` |
| Centaur API key for Slackbot | Slackbot to API calls | `SLACKBOT_API_KEY` |
| GitHub | Repo clone, branch, PR, and API work | `GITHUB_TOKEN` |
| Amp | Default harness | `AMP_API_KEY` |
| Claude Code | Anthropic-backed harness | `ANTHROPIC_API_KEY` |
| Codex | OpenAI-backed harness | `OPENAI_API_KEY` |
| 1Password | Default shared secret backend | `OP_SERVICE_ACCOUNT_TOKEN`, `OP_VAULT` |
| AWS/GCP secret store | KMS-backed production secret storage | Provider sync into Kubernetes Secret or provider-native backend |
| Tool-specific APIs | Custom tools | Tool-defined `secret("NAME")` keys |
| Apps API | Internal app plane | Scoped app deploy key |

## Slack

1. Create a Slack app.
2. Add the scopes from `services/slackbot/slack-app-manifest.yml`.
3. Install the app to the workspace.
4. Store the Bot User OAuth Token as `SLACK_BOT_TOKEN`.
5. Store the Signing Secret as `SLACK_SIGNING_SECRET`.
6. Set Event Subscriptions Request URL:

```text
https://centaur.example.com/api/webhooks/slack
```

7. Subscribe to the events listed in [Set Up Centaur](/setup).
8. Create `SLACKBOT_API_KEY` with `agent` scope.

Slack authenticates the webhook with `SLACK_SIGNING_SECRET`. Do not put Centaur
API-key auth or Cloudflare Access in front of `/api/webhooks/slack`.

## GitHub

Use a fine-grained token or GitHub App token:

```bash
GITHUB_TOKEN=github_pat_...
```

Scope it to the repos agents need. For code-writing agents, grant contents and
pull request permissions only on the relevant repositories.

## Harnesses

At minimum, configure Amp:

```bash
AMP_API_KEY=...
```

For Claude Code and Codex:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

For the detailed Iron Proxy and KMS setup, use [Configure Agent Harnesses](/ops/harnesses).

## Secret Stores

Choose one:

| Backend | Use when |
|---------|----------|
| `.env` / `env` | Local or disposable deployments. |
| 1Password | Shared deployment using 1Password as the source of truth. |
| AWS Secrets Manager + KMS | AWS deployment with cloud-managed secret storage. |
| Google Secret Manager + Cloud KMS | GCP deployment with cloud-managed secret storage. |

The secret names should stay stable across backends: `AMP_API_KEY`,
`SLACK_BOT_TOKEN`, `GITHUB_TOKEN`, and tool-specific names.

## Tool APIs

For each custom tool:

1. Read its `pyproject.toml` for required secrets.
2. Store each secret with the exact env-var name.
3. Verify discovery:

```bash
curl -s "$CENTAUR_API_URL/tools/<tool>" \
  -H "X-Api-Key: $CENTAUR_API_KEY" | jq
```

4. Make one real call with a scoped key.

## Apps

Create a scoped key for app deployment:

```bash
curl -s -X POST "$CENTAUR_API_URL/admin/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ADMIN_KEY" \
  -d '{
    "name": "app-deployer:research-console",
    "scopes": ["agent:execute", "tools:chart"],
    "created_by": "operator"
  }'
```

Deploy the app through [Build a Web App](/tutorials/app) or [Deploy on Your Infrastructure](/tutorials/deploy).

## Verification Checklist

| Check | Command or surface |
|-------|--------------------|
| API health | `curl https://centaur.example.com/health` |
| Runtime credentials | `GET /health/runtime-credentials?refresh=true` |
| Slack webhook | Slack Event Subscriptions verifier |
| GitHub auth | Agent turn that runs `gh auth status` or opens a test PR |
| Harness | One `PONG` turn per enabled harness |
| Tool | Discover and call one method |
| App | Load app URL and inspect app logs |

Use [Golden Path](/tutorials/golden-path) for a full first deployment path.
