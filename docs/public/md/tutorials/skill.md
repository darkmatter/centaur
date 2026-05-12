---
title: Build a Skill
description: Package an agent operating procedure as markdown instructions.
---

# Build a Skill

Skills are markdown instruction bundles. Use them when the capability is mostly judgment and procedure: research flows, launch checklists, incident response, diligence patterns, writing formats, or multi-tool recipes.

## File structure

```text
.agents/skills/company-brief/
├── SKILL.md
└── reference/
    └── examples.md
```

## A useful skill is small

The best skills answer four questions:

1. When should the agent load this?
2. What inputs does it need?
3. What steps should it follow?
4. What should the final output look like?

## Example

````markdown
---
name: company-brief
description: "Prepare a concise company brief. Use when asked for meeting prep, a company overview, or a quick diligence snapshot."
---

# Company Brief

Prepare a concise company brief for a user who needs context quickly.

## Inputs

- Company name or domain
- Meeting context, if provided
- Any known attendees, if provided

## Steps

1. Identify the company and normalize the name.
2. Search for the official website and recent public sources.
3. If available, call approved internal tools for CRM, meetings, or account context.
4. Distinguish sourced facts from interpretation.
5. Write the brief in the output format below.

## Output

Lead with the answer. Keep it under one screen unless the user asks for depth.

```text
## Company
One sentence on what it does.

## Why it matters
Three bullets on market, traction, or strategic relevance.

## What to ask
Five concrete questions for the meeting.

## Sources
Short list of links or tool names used.
```

## Guardrails

- Do not invent funding, revenue, or headcount.
- Mark uncertain facts as uncertain.
- If internal data conflicts with public data, say so.
````

## Test the skill

Before deploying, paste the skill into an agent turn and ask for a realistic output. You are checking whether the instructions are specific enough, not whether the model can read your mind.

Good test prompts:

- `Use this skill to brief me on ExampleCo before a partner meeting.`
- `Run the company-brief process for a company with sparse public data.`
- `Use only public sources and tell me what is uncertain.`

## When to add reference files

Keep `SKILL.md` short. Put bulky examples, rubrics, schemas, or long policy text under `reference/` and tell the agent when to read them.

```text
.agents/skills/company-brief/
├── SKILL.md
└── reference/
    ├── output-examples.md
    └── source-ranking.md
```

## When to add scripts

Use scripts for deterministic local processing, not for hidden business logic.

```text
.agents/skills/company-brief/
├── SKILL.md
└── scripts/
    └── normalize_domain.py
```

Reference scripts with intent: “Run `scripts/normalize_domain.py <url>` before searching.” If the script becomes an API integration, promote it to a [tool](/tutorials/tool).

## Checklist

- [ ] Frontmatter has `name` and `description`.
- [ ] `name` matches the skill directory.
- [ ] Description includes trigger language.
- [ ] Steps name the tools or evidence sources to use.
- [ ] Output format is explicit.
- [ ] Guardrails state what not to invent.
- [ ] Skill was tested on at least one realistic prompt.
