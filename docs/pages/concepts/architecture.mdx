---
title: Architecture
description: How Centaur runs agents with an API, Postgres, sandbox pods, tools, workflows, and Iron Proxy.
---

# Architecture

Centaur is the server around your agents. It accepts Slack and API requests,
stores the turn, assigns an isolated runtime, exposes approved tools, injects
credentials through a proxy, and keeps an event trail clients can replay.

<figure className="architecture-figure">
  <img src="/architecture-2.0.svg" alt="Centaur architecture 2.0 diagram" />
  <figcaption>Architecture 2.0: ingress, durable control plane, isolated execution, tools, workflows, and controlled egress.</figcaption>
</figure>

## Planes

| Plane | Responsibility | Main components |
|-------|----------------|-----------------|
| Ingress | Accept user and app input. | Slack Events API, Slackbot webhook, external API clients, apps. |
| Control | Persist requests and coordinate runtime state. | FastAPI, Postgres, PgBouncer, execution worker. |
| Execution | Run one assigned agent session per thread. | Docker container locally, Kubernetes sandbox pod in production. |
| Capabilities | Give agents and apps approved actions. | Tool plugins, workflow engine, Apps API, overlays. |
| Secrets and egress | Let agents call third-party APIs without receiving raw keys. | Secret manager, Iron Proxy, firewall compatibility path. |

## API lifecycle

Clients do not manage containers or keep long-running processes alive. They call
the API and follow the event stream.

| Step | Endpoint | What it saves |
|------|----------|----------------|
| Start or reuse a sandbox | `POST /agent/spawn` | The thread's current sandbox assignment. |
| Persist input | `POST /agent/message` | Writes the user turn and extracts large multimodal attachments. |
| Run the agent | `POST /agent/execute` | A run row with status and final result. |
| Follow output | `GET /agent/threads/{thread}/events` | Tool calls, model output, status changes, and final text. |
| Clean up | `POST /agent/threads/{thread}/release` | Releases the sandbox and can cancel running work. |

Because each step is stored, a Slack reconnect, browser refresh, API restart,
pod replacement, or worker failover does not erase the run.

## Slackbot ingress

Slack talks to Centaur through the Slack Events API. The public request URL is
the Slackbot webhook, usually:

```text
https://api.acme.com/api/webhooks/slack
```

The webhook does not use a Centaur API key. Slack signs every request with
`X-Slack-Signature` and `X-Slack-Request-Timestamp`; the Slackbot validates
that HMAC signature with `SLACK_SIGNING_SECRET` before it routes the event to
the API. After validation, the Slackbot calls Centaur's agent API with
`SLACKBOT_API_KEY`.

That gives the Slack path two separate trust boundaries:

| Boundary | Credential | Used by |
|----------|------------|---------|
| Slack to Slackbot | `SLACK_SIGNING_SECRET` | Verify webhook authenticity and reject forged Slack events. |
| Slackbot to Centaur API | `SLACKBOT_API_KEY` with `agent` scope | Spawn, message, execute, stream, and deliver Slack thread turns. |

## Execution path

Docker is the fastest local loop. Kubernetes is the production path. The API
creates or claims a sandbox, attaches to it, and runs the requested agent CLI.

| Harness | Adapter behavior |
|---------|------------------|
| Amp | Materializes image/document blocks to files and passes text plus file references. |
| Claude Code | Passes the Anthropic-shaped content through directly. |
| Codex / pi-mono | Extracts text blocks for CLIs that accept a plain prompt. |

The pod receives the prompt files, CLI command, internal API URL, proxy CA, and proxy settings. It does not need Kubernetes credentials or long-lived third-party API keys.

## Tool and workflow layer

Tools are Python plugin directories. Each public client method becomes a REST
method at `/tools/{name}/{method}`. Agents discover tools when they start, and
external apps can call the same endpoints.

Use tools for search, Slack, GitHub, market data, calendars, internal systems, and deployment-specific APIs. Tool code should read credentials with `secret("NAME")` so the same code works locally and in production.

Workflows are Python handlers that save step results. When a worker restarts, the handler runs again, but `ctx.step(...)` returns cached results for completed work.

Use workflows for:

- scheduled digests and monitoring loops,
- jobs that sleep for minutes or days,
- approval gates via `ctx.wait_for_event(...)`,
- running several agents,
- parent/child workflow trees.

## Secrets and outbound requests

Agents and tools refer to credentials by name, such as `OPENAI_API_KEY` or
`secret("CRM_API_TOKEN")`. The secret manager resolves those names from the
configured backend. In production, Iron Proxy swaps names for real keys on
outbound requests.

Prompts, transcripts, sandbox files, and logs can contain secret names without
containing the raw credential. The proxy injects the real value for allowlisted
hosts and can redact leaked values from responses.

## Deployment model

Local development uses Docker Compose and Docker sandboxes. Production uses the
Helm chart with sandbox pods, the secret-manager service, and Iron Proxy for
third-party API calls. The older firewall can run during rollout, but new
deployments should use Kubernetes pods plus Iron Proxy.

The base repo stays generic. Overlays layer in organization-specific tools,
workflows, skills, personas, and prompt changes without forcing a fork.

## Failure model

| Failure | Expected recovery |
|---------|-------------------|
| Client disconnects | Reconnect to the event stream with `after_event_id`. |
| API restarts | Reload assignments, executions, and terminal state from Postgres. |
| Sandbox pod dies | Mark the execution terminal and preserve the event trail. |
| Workflow worker restarts | Re-run the handler and skip completed checkpoints. |
| Proxy restarts | Rebuild the key-injection map from the secret-manager cache. |
| Tool changes | Discovery reloads plugin metadata; agents see the updated methods. |

Next: [call the API](/first-call), [write a plugin](/extend/plugins), or [operate on Kubernetes](/ops/kubernetes).
