---
title: Scaling Centaur
description: How to grow a Centaur deployment from one VM to larger Kubernetes-backed organizations.
---

# Scaling Centaur

Centaur should scale in stages. Do not start by solving enterprise-wide agent
governance. Start with a compact deployment, prove the operating loop, and add
architecture only when the next bottleneck is real.

## Maturity Stages

| Stage | Shape | Main goal |
|-------|-------|-----------|
| Stage 0 | Local Docker Compose | Develop tools, workflows, prompts, and docs. |
| Stage 1 | Single VM or bare metal | First shared Slackbot and API deployment. |
| Stage 2 | Kubernetes with Iron Proxy | Pod isolation, warm pools, resource limits, and managed rollout. |
| Stage 3 | Multi-team platform | App plane, reviewed overlay, explicit tool ownership, stronger observability. |
| Stage 4 | Large enterprise | Context architecture, permissioning, quotas, governance, and dedicated platform team. |

## Technical Bottlenecks

| Bottleneck | When it appears | Mitigation |
|------------|-----------------|------------|
| Sandbox startup latency | More users and more conversations | Warm pool, Kubernetes backend, pinned images. |
| Docker host contention | Many concurrent agents on one VM | Move to EKS/GKE or self-managed Kubernetes. |
| Postgres durability | Production data matters | External Postgres, backups, restore tests, PgBouncer. |
| Proxy pressure | Many credentialed outbound calls | Iron Proxy, health checks, injection-map monitoring. |
| Logs volume | Many sandboxes and workflows | VictoriaLogs retention and dashboards. |
| App sprawl | Many internal apps | Scoped keys, app owners, logs, restart policy. |
| Overlay churn | Too many org changes in one repo | Move experiments into apps; review overlay changes. |

## Organizational Bottlenecks

| Bottleneck | Why it matters |
|------------|----------------|
| Permissioning | Broad internal tools can expose data to the wrong Slack channel or app. |
| Context management | A single shared AI channel does not scale to thousands of people. Teams need smaller contexts and summaries. |
| Ownership | Every tool, workflow, and app needs an owner who can debug it. |
| Reliability | Shared deployments need incident response and upgrade discipline. |
| Taste drift | Skills and prompts can accumulate confusing behavior unless reviewed. |

## Recommended Scale Path

1. Start with one Slackbot, one harness, one GitHub token, and one useful tool.
2. Add workflow and app examples only after Slack turns are reliable.
3. Move to Kubernetes when concurrency or isolation becomes a real need.
4. Add a reviewed overlay before org-specific tools become numerous.
5. Add app-plane guardrails before many builders deploy apps.
6. Revisit permissioning before installing sensitive tools broadly.

## Readiness Checklist By Size

| Deployment size | Required before expansion |
|-----------------|---------------------------|
| First team | Slack webhook, harness credentials, GitHub token, one smoke test. |
| Multiple teams | Scoped API keys, tool ownership, logs, backups. |
| Whole small company | Overlay repo, app deploy process, incident owner, permission review. |
| Large company pilot | Kubernetes, Iron Proxy, external Postgres, quotas, team-specific channels. |
| Broad enterprise | Dedicated platform team, RBAC/data policy design, context compaction architecture. |

## Explicit Non-Goals Today

Centaur core should not try to solve every large-company platform problem in
the first launch:

- full enterprise RBAC,
- every data warehouse row permission model,
- centralized approval for every app idea,
- a single channel that scales to every employee,
- automatic safe access to every internal system.

Those are real problems, but they are later-stage problems. The first win is a
small or mid-size organization running shared agents on its own infrastructure
with a clear operator and useful connected tools.
