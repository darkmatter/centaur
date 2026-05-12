---
title: Why Centaur
description: Why teams deploy Centaur as shared agent infrastructure instead of scattering agents across laptops, SaaS bots, and one-off scripts.
---

# Why Centaur

Useful agents need more than a chat box. They need Slack context, repo access,
tools, credentials, durable execution, logs, and a place to run code. Without a
shared control plane, every team ends up with a different bot, a different
secret path, a different permission model, and no clean way to operate the
system when people start depending on it.

Centaur is the control plane for that work. It lets a team deploy shared AI
agents on infrastructure it controls, expose them through Slack and API
entrypoints, run each thread in an isolated sandbox, and extend the system with
tools, workflows, skills, overlays, and internal apps.

## The Problem

Agent usage usually starts as local scripts and personal CLI sessions. That
works until the work becomes shared:

| Problem | What breaks |
|---------|-------------|
| Personal agents | Context, credentials, and execution history live on one laptop. |
| SaaS-only bots | The team cannot easily control runtime isolation, tool access, or audit logs. |
| One-off scripts | Every integration has its own auth, retry, deployment, and logging path. |
| Direct secrets in sandboxes | Agents can see tokens they should only be allowed to use indirectly. |
| Stateless chat flows | Long jobs, reconnects, final delivery, and replay become fragile. |
| Core forks | Deployment-specific tools and prompts make upgrades painful. |

Centaur makes those concerns explicit instead of hiding them in ad hoc glue.

## What Centaur Changes

| Capability | What Centaur provides |
|------------|-----------------------|
| Shared entrypoints | Slack webhooks and API clients both use the same agent control plane. |
| Durable execution | Turns are persisted as spawn, message, execute, event stream, and final state. |
| Runtime isolation | Each Slack thread or API client gets a sandboxed agent session. |
| Credential boundary | The sandbox receives placeholders; the proxy injects real credentials in-flight. |
| Tool surface | Python tool plugins become authenticated REST endpoints agents can call. |
| Workflow surface | Long-running jobs can checkpoint, sleep, retry, wait for events, and resume. |
| App plane | Teams can ship focused internal UIs without changing core infrastructure. |
| Overlay model | One deployment can add private prompts, personas, tools, and workflows without forking Centaur. |

The result is not a single chatbot. It is shared infrastructure for running
agent work with an operator, a security boundary, and a path for teams to build
on top.

## When It Is Worth Running

Centaur is worth deploying when the organization has real work for agents to do
and can operate a small production service.

| Signal | Why it matters |
|--------|----------------|
| Slack is where work happens | Slack gives the first natural interface and a useful permission boundary. |
| GitHub and internal APIs matter | Agents become valuable when they can inspect repos, call tools, and create artifacts. |
| Multiple people need the same capabilities | Shared tools and workflows beat repeated local setup. |
| Secrets need ownership | Slack, GitHub, model, KMS, and tool credentials need a controlled path. |
| Jobs need to survive disconnects | Durable events and final delivery matter once agents run real tasks. |
| Teams want to build apps on top | The app plane turns Centaur from a bot into an internal platform. |

If the team can only deploy simple serverless apps today, start smaller. If the
team already runs an EC2 box, a GCP VM, bare metal, or a Kubernetes cluster,
Centaur is designed to fit that operating model.

## What Centaur Is Not

| Not this | Use Centaur instead for |
|----------|-------------------------|
| A hosted chatbot | Running shared agents on infrastructure you control. |
| An enterprise IAM replacement | Practical Slack/API/tool permissioning for small to mid-size teams. |
| A generic workflow SaaS | Agent-native workflows that can call tools, run code, and wait durably. |
| A monolithic internal fork | Core services plus overlays and apps with separate ownership boundaries. |
| A local-only CLI wrapper | Durable, observable agent sessions reachable from Slack and APIs. |

## First Decisions

Start with the smallest path that proves the loop.

| Situation | Next page |
|-----------|-----------|
| You are deciding fit. | Read [Who Should Run Centaur](/ops/who-should-run). |
| You are deploying now. | Follow the [Golden Path](/tutorials/golden-path). |
| You are configuring a stack. | Use [Set Up Centaur](/setup). |
| You are extending a working stack. | Start with the [Step-by-Step API Guide](/first-call) or [Application Plane](/concepts/application-plane). |

The first useful deployment should prove one complete path: Slack mention,
signature verification, sandbox creation, harness execution, credentialed tool
call through the proxy, durable output, and operator-visible logs.
