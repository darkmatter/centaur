---
title: Overlay Operating Model
description: Use centaur-X overlay repos to customize Centaur without forking the open-source core.
---

# Overlay Operating Model

Centaur is designed to proliferate through overlay repositories. The base repo
stays generic. Each organization layers its own private tools, workflows,
skills, personas, and prompts on top.

```text
deployment/
|-- centaur/            # OSS core
|-- centaur-acme/       # Organization overlay
`-- centaur-research/   # Team overlay
```

The overlay model lets a deployment customize behavior without turning every
organization-specific change into a core fork.

## What Goes Where

| Change | Put it in |
|--------|-----------|
| Agent assignment, auth, sandbox execution, event streaming | Core `centaur` repo |
| Generic open-source tool useful to many deployments | Core `tools/` |
| Org-private API client or data source | Overlay `tools/` |
| Org-specific workflow | Overlay `workflows/` |
| Org-specific skill | Overlay `.agents/skills/` |
| Persona prompt | Overlay persona directory |
| Deployment system prompt additions | Overlay `services/sandbox/SYSTEM_PROMPT.md` |
| Human-facing internal product | App plane through Apps API |

## Overlay Layout

Use the same directory names as the base repo:

```text
centaur-overlay/
|-- tools/
|   `-- internal-db/
|-- workflows/
|   `-- weekly_research_digest.py
|-- .agents/
|   `-- skills/
|       `-- company-brief/
|           `-- SKILL.md
|-- personas/
|   `-- invest/
|       `-- PROMPT.md
`-- services/
    `-- sandbox/
        `-- SYSTEM_PROMPT.md
```

Later entries win when names collide. That means an overlay can override a
prompt or add a deployment-specific tool without changing the OSS repo.

## Local Compose

The stock Docker Compose setup looks for an overlay at `~/centaur-overlay` by
default. You can point it somewhere else:

```bash
CENTAUR_OVERLAY_HOST_DIR=/srv/centaur/centaur-acme
```

Then restart the API and rebuild sandboxes when prompt or image-level content
changes:

```bash
docker compose up -d api
docker compose build sandbox
```

Tool and workflow discovery can hot-reload, but prompt and sandbox image
changes should be treated as deploy changes and verified with a real turn.

## Kubernetes

For Kubernetes, use either:

| Path | Use when |
|------|----------|
| `overlay.systemPrompt` | You only need a small prompt overlay. |
| `overlay.image` | You need private tools, workflows, skills, personas, or prompt files packaged in an image. |

Example:

```yaml
overlay:
  image:
    repository: ghcr.io/your-org/centaur-overlay
    tag: 2026-05-05
    pullPolicy: IfNotPresent
    sourcePath: /overlay
```

The API mounts the overlay into `/app/overlay/org` and adds overlay tool and
workflow directories after the core directories.

## Review Rules

Treat the overlay as production infrastructure.

| Change | Review expectation |
|--------|--------------------|
| New tool with credentials | Security and data-access review. |
| New workflow | Operator review for retries, schedules, and blast radius. |
| Prompt/persona change | Product owner review and a smoke test. |
| Skill change | Lightweight review unless it changes external actions. |
| App deployment | App owner review; keep it out of core and overlay when possible. |

## Upgrade Flow

1. Pull or deploy the new `centaur` core version.
2. Keep the overlay pinned to its own version.
3. Run discovery checks for tools and workflows.
4. Run one Slack or API smoke turn per enabled harness.
5. Verify one overlay tool or workflow.
6. Promote after logs and final delivery look correct.

This keeps the OSS core upgradeable while preserving the organization-specific
layer that makes the deployment valuable.
