---
title: Application Plane
description: How Centaur separates stable core infrastructure, reviewed overlays, and fast internal app deployment.
---

# Application Plane

The application plane is where teams build internal products on top of Centaur
without changing core infrastructure or the deployment overlay.

Centaur has three operating surfaces:

| Surface | Stability | Owner | Examples |
|---------|-----------|-------|----------|
| Core | Stable | Centaur maintainers | API, runtime, workflow engine, auth, proxy, chart. |
| Overlay | Reviewed | Deployment owner | Private tools, personas, skills, workflows, prompt additions. |
| Apps | Fast | App owner | Dashboards, queues, consoles, research UIs, workflow controls. |

The app plane should be the fast surface. It gives teams a way to create
purpose-built interfaces without touching the core repo or the overlay every
time someone has an idea.

## Why It Exists

If every useful internal product requires a core PR, the platform slows down.
If every experiment lands in the overlay, the overlay becomes critical
infrastructure that changes too often. Apps create a third path:

1. Keep core stable.
2. Keep the overlay reviewed and deployment-specific.
3. Let app builders deploy focused products through the Apps API.

## What Belongs In An App

| Use case | Why app plane fits |
|----------|--------------------|
| Review queue | Humans need a custom interface over workflow state. |
| Research console | Users need saved prompts, files, charts, and API calls in one surface. |
| Operations dashboard | Operators need service state, logs, and controls. |
| Team-specific tool | A team needs a specific workflow without broad platform changes. |
| Experiment | The idea may be useful, but should not land in core or overlay yet. |

## What Does Not Belong In An App

| Change | Better home |
|--------|-------------|
| New durable workflow primitive | Core |
| New auth or permission model | Core |
| Shared org data connector | Overlay tool |
| Reusable agent procedure | Skill |
| Long-running scheduled automation | Workflow |

## App Deployment Loop

Apps deploy from Git repositories:

```bash
curl -s -X POST "$CENTAUR_API_URL/apps" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $APP_DEPLOY_KEY" \
  -d '{
    "name": "research-console",
    "repo_url": "https://github.com/your-org/research-console",
    "port": 3000,
    "env": {"API_URL": "http://api:8000"}
  }'
```

Inside Centaur infrastructure, apps can call `http://api:8000` directly. From
outside, they use the public Centaur URL and a scoped API key.

## Guardrails

| Guardrail | Why |
|-----------|-----|
| Use scoped app API keys | Apps should not get admin keys by default. |
| Keep app secrets out of Git | Store them in the deployment secret manager. |
| Make logs inspectable | Operators need to debug app failures without SSH. |
| Prefer app-specific repos | Do not crowd the core repo with product experiments. |
| Promote successful patterns | When an app proves repeatable, extract common parts into tools, workflows, or skills. |

The app plane is how a Centaur deployment becomes an internal platform instead
of a single bot.
