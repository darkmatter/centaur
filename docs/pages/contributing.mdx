---
title: Contributing
description: How to make small, safe, reviewable changes to Centaur.
---

# Contributing

Centaur is infrastructure. Optimize contributions for narrow diffs, explicit contracts, and verification that exercises the surface you changed.

## Before you change core code

Ask whether the work belongs in an extension point first.

- New external API? Add a [tool](/tutorials/tool).
- New procedure? Add a [skill](/tutorials/skill).
- New recurring or long-running job? Add a [workflow](/tutorials/workflow).
- New UI? Deploy an [app](/tutorials/app).
- Deployment-specific behavior? Use an overlay.

Core API changes are reserved for shared protocol, scheduling, auth, persistence, sandbox, or event semantics.

## Local stack

```bash
just up
```

Run migrations through the wrapper so overlay and core migration sets stay separate:

```bash
./scripts/dbmate status
./scripts/dbmate up
```

## Validation matrix

| Change | Minimum useful proof |
|--------|----------------------|
| Tool | Import `_client()` and call the changed public method. |
| Skill | Re-read frontmatter and run the skill against at least one realistic prompt. |
| Workflow | Syntax/import check plus a one-iteration or targeted workflow test. |
| API route | Targeted pytest or a real local curl against the route. |
| Sandbox/Docker | Rebuild the affected image and run a harness smoke check. |
| Kubernetes/chart | `helm lint contrib/chart` plus the relevant smoke script. |
| Docs | `npm run build` from `docs/`. |

Do not claim a user-visible artifact works until you have verified that exact surface.

## PR shape

A good Centaur PR says:

1. What changed.
2. Which contract or plugin surface changed.
3. How it was verified locally.
4. Whether secrets, overlays, migrations, or deploy steps are required.

Keep unrelated refactors out of plugin PRs. Small diffs are easier to hot-reload, review, and roll back.

## Secrets

Never hardcode credentials. Tool code reads secrets with `secret("ENV_NAME")`; deployed values come from the configured secret-manager backend. Local development can use environment variables with the same names.

## Release behavior

Tools, skills, and workflows go live by landing on `main` and being picked up by discovery/hot-reload. Infrastructure and API changes follow the normal deploy pipeline. See [Deploy on Your Infrastructure](/tutorials/deploy) for the contributor-facing flow.
