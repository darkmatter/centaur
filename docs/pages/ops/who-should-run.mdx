---
title: Who Should Run Centaur
description: Decide whether Centaur is a fit for your team today, and which deployment path to start with.
---

# Who Should Run Centaur

Centaur is for teams that want shared AI agents on their own infrastructure and
can operate a small production service. The best first users are small to
mid-size technical organizations where Slack, GitHub, and internal APIs already
carry most of the work.

## Good Fit Today

| Signal | What it means |
|--------|---------------|
| 10 to a few hundred employees | The org is large enough to benefit from shared tools, but small enough that Slack and API-key permissioning can be practical. |
| Owns basic infra | The team can run an EC2 box, a GCP VM, bare metal, or a Kubernetes cluster. |
| Uses Slack heavily | Slack can be the first natural agent interface and permission boundary. |
| Has internal APIs or data | Centaur becomes more valuable when agents can call organization-specific tools. |
| Has code workflows | Agents can clone repos, run tests, open PRs, and deploy internal apps. |
| Has an operator | Someone can own secrets, upgrades, incident response, and access reviews. |

Start with a VM for the first shared deployment. Move to Kubernetes when you
need sandbox pods, stronger isolation, warm pools, or production-scale rollout
controls.

## Not A Fit Yet

Centaur is not yet the right default for every organization.

| Situation | Why to wait |
|-----------|-------------|
| Only serverless comfort | If the team can only deploy to Vercel or Cloudflare Workers, start with an easier hosted agent surface first. |
| 10,000-person enterprise | Permissioning, context management, and infra quotas need a deeper architecture than the current default docs cover. |
| Strict centralized app approval | The app plane works best when teams can deploy internal products quickly inside guardrails. |
| No operator for secrets | Slack, GitHub, model, KMS, and tool credentials need a clear owner. |
| No real tools to connect | Without internal tools, workflows, or repo access, Centaur is mostly a generic chat surface. |

## Company Size Guidance

| Size | Recommended posture |
|------|---------------------|
| 5 to 20 people | Run a single VM or bare-metal deployment. Keep tools few and broad. |
| 20 to 200 people | Use Slack entrypoints, scoped API keys, a reviewed overlay, and a small app plane. |
| 200 to 1,000 people | Prefer Kubernetes, Iron Proxy, external Postgres, observability, and explicit tool permission reviews. |
| 1,000+ people | Treat Centaur as a platform component. Expect to solve permissioning, context compaction, quotas, and governance before broad rollout. |

## Choose A Deployment Path

| Starting point | Use this guide |
|----------------|----------------|
| Single AWS VM | [Deploy on AWS EC2](/ops/aws/ec2) |
| Single GCP VM | [Deploy on GCP Compute Engine](/ops/gcp/vm) |
| Your own server or colo host | [Deploy on Bare Metal](/ops/bare-metal) |
| AWS managed Kubernetes | [Deploy on AWS EKS](/ops/aws/eks) |
| GCP managed Kubernetes | [Deploy on GCP GKE](/ops/gcp/gke) |

## First Deployment Goal

The first deployment should prove a narrow loop:

1. Slack mention reaches the webhook.
2. Slackbot validates the Slack signing secret.
3. Centaur creates a sandbox.
4. The harness uses Amp, Claude Code, or Codex through Iron Proxy.
5. The agent can use GitHub and one internal or external tool.
6. Logs, metrics, and final delivery can be inspected by the operator.

After that works, add overlays, apps, and more tools.
