---
title: Creating Skills
description: Add reusable sandbox-agent skills through overlay .agents/skills directories.
---

# Creating Skills

Skills are reusable instructions that sandbox agents can load when a task
matches the skill's purpose. They are not API tools and they do not grant new
network access by themselves. Use them for repeatable procedures, repo-specific
operating knowledge, QA playbooks, investigation steps, or formatting rules.

Put organization skills in an overlay repo under `.agents/skills/`. See
[Using an overlay](/extend/overlay) for packaging, mount paths, and chart
configuration.

Skills are loaded from the sandbox overlay. In an overlay deployment, they must
exist under `/home/agent/overlay/org/.agents/skills` in the sandbox container.
The sandbox entrypoint copies those skills into the agent workspace during
startup.

## Write SKILL.md

Keep the entrypoint concise and action-oriented:

```markdown
# Incident Response

Use this skill when investigating a production incident, failed rollout, or
service outage.

## Workflow

1. Identify the affected service, namespace, and timeframe.
2. Check rollout history and current pod health.
3. Inspect logs around the first failure.
4. State root cause, blast radius, and recovery path.
```

Add references only when they save context. Put long runbooks in
`references/`, scripts in `scripts/`, and examples in `examples/`.

## What belongs in a skill

Good skills:

- encode a repeated workflow
- say when they should be used
- point at local scripts or references
- keep the first page short
- avoid secrets and credentials

Avoid using skills for tool credentials, API clients, or durable automation.
Those belong in tools, secret configuration, and workflows.

## Verify

Start an agent with the overlay loaded and ask it to inspect available skills.
For a running sandbox, the agent can confirm overlay state with:

```bash
echo "$CENTAUR_OVERLAY_DIR"
ls "$CENTAUR_OVERLAY_DIR/.agents/skills"
```

If a skill is missing, check the overlay image contents and that the directory
contains `SKILL.md`.
