---
title: Set Up Centaur
description: Configure baseline secrets, Slack, GitHub, model credentials, and the first API keys for a Centaur deployment.
---

# Set Up Centaur

Use this checklist before the first local boot or when preparing a new
deployment. Centaur needs baseline service secrets, a Slack app if you want
Slack entrypoints, GitHub credentials if agents should change repos, and model
credentials for the harnesses you run.

For the shortest hands-on path, start with [Quickstart](/quickstart). This page
is the fuller operator checklist.

## Step 1. Choose the secret backend

Centaur services read secrets through the secrets service. Use one backend per
deployment:

| Backend | Use when | Configure |
|---------|----------|-----------|
| `env` | Local development or a disposable stack. | Put values in local environment variables or a Kubernetes Secret projected into the secrets service. |
| `onepassword` | Shared or production deployment. | Put each secret in a 1Password vault and give the secrets service an `OP_SERVICE_ACCOUNT_TOKEN`. |

For local development, set:

```bash
SECRET_MANAGER_BACKEND=env
```

For 1Password-backed deployments:

```bash
SECRET_MANAGER_BACKEND=onepassword
OP_SERVICE_ACCOUNT_TOKEN=ops_...
OP_VAULT=ai-agents
```

`OP_SERVICE_ACCOUNT_TOKEN` is the bootstrap credential for reading the vault, so
store it in your deployer environment or CI secret store, not inside the same
vault it unlocks.

## Step 2. Add baseline service secrets

Create these as `.env` variables for local `env` mode, or as 1Password items
with the exact item title shown below for `onepassword` mode. The 1Password
backend normalizes item titles to `ENV_VAR` names, but exact names avoid
surprises.

| Secret | Required for | Notes |
|--------|--------------|-------|
| `DATABASE_URL` | API | App connection string. In the Helm chart this usually points at PgBouncer. |
| `PGBOUNCER_DATABASE_URL` | PgBouncer | PgBouncer upstream connection string. In local Kubernetes this points at Postgres. |
| `FIREWALL_CONTROL_TOKEN` | Firewall/API/PgBouncer/Slackbot control calls | Generate with `openssl rand -hex 32`. |
| `SANDBOX_SIGNING_KEY` | Sandbox API tokens | Generate with `openssl rand -hex 32`; keeps sandbox tokens valid across API restarts. |
| `LOCAL_DEV_API_KEY` | Optional local admin/API access | Bootstrapped into Postgres with `admin`, `agent`, `threads`, and `tools:*` scopes. |

Local examples:

```bash
FIREWALL_CONTROL_TOKEN=$(openssl rand -hex 32)
SANDBOX_SIGNING_KEY=$(openssl rand -hex 32)
LOCAL_DEV_API_KEY="aiv2_local_$(openssl rand -hex 24)"
```

Export the generated values before running `just bootstrap-secrets`, or store
them in the deployment secret source used by the chart.

## Step 3. Configure model and agent credentials

Add the credentials for the harnesses and providers you plan to run:

| Secret | Used by |
|--------|---------|
| `AMP_API_KEY` | Amp harness and `ampcode.com` traffic. |
| `ANTHROPIC_API_KEY` | Claude/Anthropic calls and Anthropic-backed tools. |
| `OPENAI_API_KEY` | Codex/OpenAI calls and OpenAI-backed tools. |
| `XAI_API_KEY` | xAI-backed model calls if enabled. |
| `GEMINI_API_KEY` | Gemini-backed model calls if enabled. |

In normal sandbox mode, containers receive placeholder values such as
`OPENAI_API_KEY=OPENAI_API_KEY`. The firewall or Iron Proxy replaces those
placeholders with real secrets only for allowed upstream hosts.

For the operator steps for Amp, Claude Code, Codex, 1Password, and AWS/GCP
secret-store deployments, see [Configure Agent Harnesses](/ops/harnesses).

## Step 4. Configure GitHub for agents

Create a GitHub fine-grained personal access token or GitHub App token for the
repositories agents should work on. Store it as:

```bash
GITHUB_TOKEN=github_pat_...
```

Agents use this token for `git`, `gh`, repository cloning, branch pushes, PR
creation, and GitHub API calls. Scope it to the minimum repositories and
permissions needed. For code-writing agents, that usually means repository
contents read/write and pull request read/write.

## Step 5. Configure Slack

Create a Slack app at `https://api.slack.com/apps`.

1. Add the bot scopes from `services/slackbot/slack-app-manifest.yml`.
2. Install the app to the workspace.
3. Store the Bot User OAuth Token as `SLACK_BOT_TOKEN`.
4. Store the app Signing Secret as `SLACK_SIGNING_SECRET`.
5. Enable Event Subscriptions.
6. Set the Request URL to `https://<your-host>/api/webhooks/slack`.
7. Subscribe to `app_mention`, `assistant_thread_started`, `assistant_thread_context_changed`, `message.channels`, `message.groups`, and `message.im`.

Slack signs webhook requests with `SLACK_SIGNING_SECRET`. Do not put Centaur
API-key auth in front of `/api/webhooks/slack`; the Slackbot validates Slack's
signature and then calls the Centaur API separately.

## Step 6. Create the Slackbot API key

After Postgres and the API are up, create the key the Slackbot uses to call the
Agent API. From the local Kubernetes stack:

```bash
SLACKBOT_API_KEY=$(kubectl exec -n centaur deploy/centaur-centaur-api -- curl -s -X POST http://localhost:8000/admin/api-keys \
  -H "Content-Type: application/json" \
  -d '{
    "name": "service:slackbot",
    "scopes": ["agent"],
    "created_by": "bootstrap"
  }' | jq -r .key)

printf '%s\n' "$SLACKBOT_API_KEY"
```

Store it as `SLACKBOT_API_KEY` in your shell environment, Kubernetes Secret, or
1Password. If you are bootstrapping from a clean shell, export the value and run
`just bootstrap-secrets` again so the Slackbot deployment receives it.

## Step 7. Create keys for API users

Centaur can also be used as an authenticated API surface by apps and external
clients. Create scoped keys through the [Admin API](/api/admin):

```bash
AGENT_CLIENT_KEY=$(curl -s -X POST "$CENTAUR_API_URL/admin/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ADMIN_KEY" \
  -d '{
    "name": "client:research-console",
    "scopes": ["agent:execute", "tools:*"],
    "created_by": "operator"
  }' | jq -r .key)
```

Use narrow scopes for people and apps that only need one tool, for example
`["tools:slack"]`.

## Step 8. Boot and verify

```bash
just up
```

Check the API:

```bash
kubectl exec -n centaur deploy/centaur-centaur-api -- \
  curl -fsS http://localhost:8000/health
```

Check tool discovery with a scoped key:

```bash
curl -s "$CENTAUR_API_URL/tools" \
  -H "X-Api-Key: $LOCAL_DEV_API_KEY" | jq
```

Check Slack by mentioning the bot in a channel where it is installed. The
Slackbot logs should include `webhook_received` and `webhook_dispatched`.

## Baseline secret list

| Store in `.env` for local | Store in 1Password for deployment |
|---------------------------|-----------------------------------|
| `SECRET_MANAGER_BACKEND` | Deployment env / CI secret |
| `OP_SERVICE_ACCOUNT_TOKEN` if using 1Password | Deployment env / CI secret |
| `OP_VAULT` if using 1Password | Deployment env / CI secret |
| `DATABASE_URL` | `DATABASE_URL` |
| `PGBOUNCER_DATABASE_URL` | `PGBOUNCER_DATABASE_URL` |
| `FIREWALL_CONTROL_TOKEN` | Deployment env / generated Kubernetes secret |
| `SANDBOX_SIGNING_KEY` | `SANDBOX_SIGNING_KEY` |
| `LOCAL_DEV_API_KEY` | Optional |
| `SLACK_BOT_TOKEN` | `SLACK_BOT_TOKEN` |
| `SLACK_SIGNING_SECRET` | `SLACK_SIGNING_SECRET` |
| `SLACKBOT_API_KEY` | `SLACKBOT_API_KEY` |
| `GITHUB_TOKEN` | `GITHUB_TOKEN` |
| `AMP_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | Same exact secret names in 1Password, AWS Secrets Manager, Google Secret Manager, or the synced Kubernetes Secret |

Add tool-specific credentials with the exact names the tool calls via
`secret("NAME")`.
