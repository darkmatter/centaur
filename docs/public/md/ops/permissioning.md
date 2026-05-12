---
title: Permissioning Model
description: The current Centaur access model, how Slack channel boundaries are used, and what remains unsolved at larger org scale.
---

# Permissioning Model

Centaur uses pragmatic permissioning today. It is designed for small and
mid-size teams first, where Slack channels, scoped API keys, tool allowlists,
and operator review can cover the first deployment. It is not yet a full
enterprise RBAC system for a 10,000-person organization.

## Current Boundaries

| Boundary | Mechanism | What it protects |
|----------|-----------|------------------|
| Slack to Slackbot | Slack signing secret | Rejects forged Slack webhook requests. |
| Slackbot to Centaur API | `SLACKBOT_API_KEY` with `agent` scope | Lets Slackbot run agent turns without exposing admin APIs. |
| External app/client to API | DB-backed `aiv2_*` API keys | Scopes API access by key. |
| Sandbox to API | Short-lived `sbx1.*` token | Limits sandbox calls to its assigned thread and allowed scopes. |
| Sandbox to third-party APIs | Iron Proxy/firewall injection map | Injects credentials only for allowed hosts. |
| Tool secrets | `secret("NAME")` and tool manifests | Keeps tool credentials out of code and sandbox env. |

## Slack Permissions

Slack is the first practical access boundary. A Centaur Slack turn begins in a
channel or thread. The initial deployment should assume:

1. Users can only ask Centaur questions in Slack places where the bot is
   installed.
2. The Slack channel membership is the first user-facing boundary.
3. Sensitive workflows should live in private channels or narrow API surfaces.
4. Operators should avoid installing broad-data tools in channels where the
   membership is too wide.

This works well for compact teams. It is not enough for every data problem.

## API Key Scopes

Use scoped API keys for apps and automations:

```bash
curl -s -X POST "$CENTAUR_API_URL/admin/api-keys" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $ADMIN_KEY" \
  -d '{
    "name": "app:research-console",
    "scopes": ["agent:execute", "tools:chart", "tools:websearch"],
    "created_by": "operator"
  }'
```

Prefer the narrowest scope that works:

| Need | Scope shape |
|------|-------------|
| Run agent turns | `agent` or narrower `agent:execute` |
| Call one tool | `tools:<name>` |
| Call many tools | `tools:*` only for trusted apps/operators |
| Manage keys | `admin` |
| Read thread history | `threads:read` |

## Tool Access

Tool-level permissioning should be explicit for sensitive tools.

| Tool type | Default posture |
|-----------|-----------------|
| Public web/search tools | Broad access is usually acceptable. |
| Slack search | Treat as sensitive; constrain by channel or deployment policy. |
| Internal database tools | Require review and narrow scopes. |
| Sensitive business tools | Require owner approval and audit logging. |
| Mutating tools | Require narrow scopes and workflow-level guardrails. |

If a tool exposes tables or records with different sensitivity levels, the
tool should enforce those checks itself. Do not rely only on the agent prompt.

## Known Gaps

| Gap | Current posture |
|-----|-----------------|
| Cross-channel Slack search | Needs explicit filtering strategy. A practical pattern is to intersect channel membership before exposing results. |
| Table-level data permissions | Tool code must enforce it today. Core does not yet provide row/table RBAC. |
| Principal-based overrides | Not a default feature. Avoid broad "principal can search everything" behavior until audited. |
| Per-skill permissioning | Skills are instructions; tools and API keys enforce real boundaries. |
| Enterprise org hierarchy | Not solved in core. Large deployments need a deeper model. |
| App-plane governance | Current model assumes scoped keys and operator review, not a full app marketplace policy system. |

## Recommended First Policy

For a first production deployment:

1. Keep `admin` keys operator-only.
2. Give Slackbot only `agent` scope.
3. Give apps dedicated keys with narrow tool scopes.
4. Put sensitive tools behind private Slack channels and narrow API keys.
5. Audit every tool that can read internal data.
6. Log tool calls and proxy audit events.
7. Review permission gaps before expanding beyond the first teams.

Next: [Scaling Centaur](/ops/scaling) and [Operator Rollout](/ops/rollout).
