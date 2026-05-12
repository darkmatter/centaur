---
title: Operating Model
description: How Centaur separates core infrastructure, deployment overlays, and fast app development.
---

# Operating Model

Centaur is a control plane for shared AI agents on infrastructure you operate.
It combines Slack and API entrypoints, durable agent execution, isolated
sandboxes, tools, workflows, and proxy-based credential injection.

The operating model is intentionally simple:

1. Keep the core platform stable.
2. Put deployment-specific behavior in an overlay.
3. Let teams build focused apps and workflows on top.

## What Centaur Is For

| Outcome | What changes |
|---------|--------------|
| Shared agent access | Slack threads and API clients use the same durable agent runtime. |
| Connected tools | Agents can call approved APIs, internal services, and workflows. |
| Isolated execution | Each thread gets a sandbox instead of running directly in shared service code. |
| Controlled credentials | Sandboxes use placeholder names; the proxy injects real credentials only for allowed upstreams. |
| Repeatable extension | Tools, skills, workflows, overlays, and apps add capability without changing the core API. |

## The Three Layers

| Layer | Owner | Change rate | Examples |
|-------|-------|-------------|----------|
| Core | Platform maintainers | Slow | API, sandbox runtime, workflow engine, auth, proxy, Helm chart. |
| Overlay | Deployment operator | Medium | Private tools, prompts, personas, skills, and workflows. |
| App plane | App/workflow owners | Fast | Dashboards, review queues, research consoles, admin tools. |

Core changes should be rare and heavily tested. Overlay changes should be
reviewed because they affect the whole deployment. Apps and workflows are the
fast path for team-specific product work.

## Deployment Boundary

Each deployment should have a clear operator who owns:

- secrets and API keys,
- Slack app configuration,
- deployment upgrades,
- incident response,
- tool and workflow ownership,
- permission reviews for sensitive data sources.

If a team does not have an operator, start with local development or a smaller
hosted surface before running Centaur as shared infrastructure.

## Extension Boundary

Use the smallest extension that fits the job:

| Need | Use |
|------|-----|
| Add an API or data source | Tool |
| Teach a repeatable agent procedure | Skill |
| Schedule, pause, retry, or wait for events | Workflow |
| Build a human UI | App |
| Customize one deployment | Overlay |
| Change auth, execution, sandbox, or event semantics | Core |

This keeps the platform understandable as more people build on it.

Next: [Architecture](/concepts/architecture), [Overlay Operating Model](/ops/overlays), and [Application Plane](/concepts/application-plane).
