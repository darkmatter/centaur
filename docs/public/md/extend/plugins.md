---
title: Plugin Model
description: How Centaur is extended through tools, skills, workflows, apps, and overlays.
---

# Plugin Model

Most Centaur work should not require changing the API server. Add a tool for a new API, a skill for a repeatable process, a workflow for a long-running job, an app for a human interface, or an overlay for deployment-specific behavior.

| Extension | Use it when | Location |
|-----------|-------------|----------|
| Tool | An agent or app needs a new API/data source/action. | `tools/<name>/` |
| Skill | The agent needs a repeatable set of instructions. | `.agents/skills/<name>/SKILL.md` |
| Workflow | The job must sleep, retry, wait for events, or run on a schedule. | `workflows/<name>.py` |
| App | Humans need a dedicated web interface on top of Centaur. | External Git repo via `POST /apps` |
| Overlay | A deployment needs private tools, prompts, skills, personas, or workflows. | Mounted checkout or overlay image |

## Tools: Python methods as REST

A tool is a Python client with a `_client()` factory. Public methods become REST endpoints and agent-callable actions.

```text
tools/hackernews/
|-- __init__.py
|-- client.py
`-- pyproject.toml
```

Rules that matter:

- Keep imports at the top.
- Expose only methods that are safe for agents and apps to call.
- Give public methods precise docstrings; discovery uses them.
- Read credentials with `secret("NAME")` from `centaur_sdk.tool_sdk`.
- Put dependencies in `pyproject.toml`.

Full guide: [Build a Tool](/tutorials/tool).

## Skills: process as markdown

A skill is a compact instruction bundle. Use it when the agent needs a recipe: how to research, how to write a memo, how to run a checklist, or how to combine existing tools.

```text
.agents/skills/company-brief/
|-- SKILL.md
`-- reference/
```

Good skills are direct: what triggers the skill, which tools to call, what to verify, and how to format the output. If a skill needs heavy computation, keep the skill as instructions and move the computation into a tool.

Full guide: [Build a Skill](/tutorials/skill).

## Workflows: Python jobs that can pause

Workflows are Python functions with saved steps.

```python
WORKFLOW_NAME = "daily_digest"

async def handler(inp, ctx):
    research = await ctx.run_agent("research", text="Find the important overnight news")
    await ctx.sleep("wait_until_tomorrow", timedelta(days=1))
    return {"latest": research}
```

Use workflows for anything that should keep going after the worker process exits: recurring jobs, approval gates, monitors, fan-out/fan-in agent runs, and long-running data collection.

Full guide: [Build a Workflow](/tutorials/workflow).

## Apps: human surfaces

Apps are normal web services deployed from Git repositories. They can be dashboards, chat surfaces, review queues, admin tools, or single-purpose internal products. From inside Centaur infra, apps call `http://api:8000` directly.

Full guide: [Build a Web App](/tutorials/app).

## Overlays: private deployment layers

Overlays keep the base repo clean while letting a deployment add private tools, prompts, skills, personas, and workflows.

```text
deployment/
|-- centaur/
`-- centaur-overlay/
    |-- tools/
    |-- workflows/
    |-- .agents/skills/
    `-- services/sandbox/SYSTEM_PROMPT.md
```

Later overlay entries win on name collisions. This lets a deployment override prompts, add private personas, or ship internal tools without forking Centaur.

Full guide: [Overlay Operating Model](/ops/overlays).

## Choose the smallest extension

| If you are about to... | Prefer... |
|------------------------|-----------|
| Add one API call | Tool |
| Teach an agent an operating procedure | Skill |
| Schedule or pause work | Workflow |
| Give humans a custom UI | App |
| Customize one deployment | Overlay |
| Change assignment, execution, auth, or event semantics | Core API change |

Next: write a [tool](/tutorials/tool), [skill](/tutorials/skill), or [workflow](/tutorials/workflow).
