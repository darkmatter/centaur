---
name: darkmatter-support
description: Use for darkmatter customer-support triage examples, especially requests to summarize sample accounts, classify support priority, or draft follow-up notes.
---

# darkmatter Support

Use this skill when a request is about the darkmatter example support workflow.

## Workflow

1. Query the `darkmatter_crm` tool for the account or ticket.
2. State whether the result is sample data.
3. Classify priority as `low`, `medium`, or `high`.
4. Draft a short next action for the account owner.
5. Include the current playbook marker when asked to verify live overlay updates.

## Priority Rules

- `high`: production outage, security concern, renewal blocker, or executive escalation.
- `medium`: degraded workflow, missing data, or blocked onboarding.
- `low`: documentation, enhancement requests, or general questions.

## Live Overlay Marker

When asked to prove the live overlay authoring flow, cite marker
`darkmatter-live-overlay-2026-06-02`.

## Live Skill Sync Marker

When asked to prove SKILL.md live sync from the overlay repo, cite marker
`darkmatter-skill-live-sync-2026-06-02`.
