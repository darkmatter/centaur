---
title: Operator Rollout
description: A step-by-step rollout checklist for installing and maintaining Centaur in a team or organization.
---

# Operator Rollout

Use this guide when you are responsible for taking Centaur from "the stack
boots" to "a team can depend on it." The goal is a working deployment with a
clear operator, scoped access, useful first workflows, and a maintenance loop.

## Step 1. Qualify The Deployment

Answer these before choosing an infra path:

| Question | Why it matters |
|----------|----------------|
| Who is the operator? | Someone must own secrets, upgrades, incidents, and access reviews. |
| What infra can the team run? | Determines VM, bare metal, EKS, or GKE path. |
| What Slack workspace and channels matter? | Defines the first permission boundary. |
| What repos should agents work on? | Determines GitHub token scope and repo cache needs. |
| What tools or data sources matter first? | Keeps setup focused on one useful loop. |
| What is sensitive? | Determines private channels, tool scopes, and review requirements. |
| What is the first success case? | Keeps the deployment from becoming a generic chatbot. |

Good first deployments have urgent engineering, research, support, security,
data, or operations workflows where agents can call real tools.

## Step 2. Choose The Infra Path

| Team capability | Start here |
|-----------------|------------|
| Can run one VM | AWS EC2 or GCP Compute Engine. |
| Runs own servers | Bare metal with Cloudflare Tunnel or host TLS. |
| Already runs Kubernetes | EKS or GKE with Iron Proxy. |
| Cannot run infra | Do not start with self-hosted Centaur yet. |

Use [Who Should Run Centaur](/ops/who-should-run) to decide whether the team is
ready.

## Step 3. Install The Core Stack

Follow the provider guide:

| Provider | Guide |
|----------|-------|
| AWS VM | [Deploy on AWS EC2](/ops/aws/ec2) |
| AWS Kubernetes | [Deploy on AWS EKS](/ops/aws/eks) |
| GCP VM | [Deploy on GCP Compute Engine](/ops/gcp/vm) |
| GCP Kubernetes | [Deploy on GCP GKE](/ops/gcp/gke) |
| Owned infra | [Deploy on Bare Metal](/ops/bare-metal) |

Minimum production setup:

1. Slack app and webhook.
2. Slack signing secret validation.
3. Slackbot API key with `agent` scope.
4. One harness credential, usually `AMP_API_KEY`.
5. GitHub token with minimum repo permissions.
6. One useful tool or workflow.
7. Logs and health checks.

## Step 4. Create The Overlay

Create an organization overlay repo:

```text
centaur-overlay/
|-- tools/
|-- workflows/
|-- .agents/skills/
|-- personas/
`-- services/sandbox/SYSTEM_PROMPT.md
```

Rules:

- Keep deployment-specific tools out of OSS core.
- Keep experiments in apps when they do not need shared agent discovery.
- Review overlay changes like production infra.
- Version the overlay independently from core.

See [Overlay Operating Model](/ops/overlays).

## Step 5. Build The First Use Cases

Pick one to three narrow workflows:

| Use case type | Example |
|---------------|---------|
| Engineering | "Find the failing test, patch it, and open a PR." |
| Research | "Monitor this topic daily and summarize changes." |
| Operations | "Collect service health, logs, and open incidents." |
| Support | "Search approved knowledge sources and draft a reply." |
| Data workflow | "Pull approved tables and render charts in Slack." |

Each use case should have:

1. A Slack entrypoint or API call.
2. A tool/workflow/skill owner.
3. A smoke test.
4. A rollback path.
5. Logs that show what happened.

## Step 6. Handoff

Before broadening the deployment, record:

| Artifact | Owner |
|----------|-------|
| Infra values file | Deployment operator |
| Secret inventory | Deployment operator |
| Slack app config | Slack workspace admin |
| Overlay repo | Deployment operator |
| API keys and scopes | Deployment operator |
| Runbook | Deployment operator |
| First use-case docs | Workflow owners |

## 30-Day Success Criteria

A deployment is working if, after 30 days:

1. The bot is used by more than one person.
2. At least one internal tool or workflow is used repeatedly.
3. The operator can rotate secrets and restart services.
4. Failures are visible in logs.
5. One overlay change has been shipped safely.
6. One app or workflow has a named owner.
7. The team can name the next three workflows it wants.

## Weekly Maintenance Rhythm

| Cadence | Work |
|---------|------|
| Weekly | Check failed runs, tool errors, proxy audit logs, and Slack delivery failures. |
| Weekly | Review new app and overlay changes. |
| Biweekly | Rotate or review API keys with broad scopes. |
| Monthly | Test restore procedures and deployment upgrade. |
| Monthly | Decide whether proven apps/workflows should become shared overlay capabilities. |

The operator's job is to leave behind a repeatable operating loop, not a
one-time demo.
