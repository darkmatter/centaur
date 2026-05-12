---
title: Tips & Best Practices
description: Practical guidance for operating and extending Centaur without making the platform harder to run.
---

# Tips & Best Practices

Centaur is most useful when the first working loop stays small and every new capability has an owner, a secret path, and a verification step. Scan the sections below and use the parts that match what you are doing.

## Getting the best results

### Start with one clean turn

Before adding Slack, overlays, multiple harnesses, cron, or apps, run a single API turn that replies with `PONG`. It proves the control plane, runtime assignment, sandbox launch, harness execution, event persistence, and final state path.

### Add one capability at a time

When something breaks, you want to know which layer changed. Add a connector, tool, workflow, skill, app, or overlay in separate steps and verify each one before moving on.

### Prefer the smallest extension point

| Need | Use |
|------|-----|
| Call an external API or internal service | Tool |
| Teach an agent a repeatable procedure | Skill |
| Sleep, retry, schedule, or wait for events | Workflow |
| Put a human in the loop | App |
| Customize one deployment | Overlay |
| Change durable execution, auth, or sandbox semantics | Core |

Most team-specific work should not require core changes.

## Prompting Centaur agents

### Give the agent the target surface

Say which surface you expect it to use: Slack, Agent API, tool call, workflow, app, or repo change. That keeps the agent from solving the right problem through the wrong path.

Good:

```text
Use the Agent API. Spawn a dev turn and verify the event stream reaches completed.
```

Less useful:

```text
Make sure agents work.
```

### Include file paths and IDs

For repo work, include filenames, command output, stack traces, thread keys, execution IDs, or run IDs. Centaur is durable, so these identifiers let people and agents reconnect to the exact state later.

### Keep Slack prompts operational

Slack is a good command surface for shared work, but long setup sessions are easier to debug through the API. Use Slack for real tasks after the API path has already been proven.

## Tool and workflow design

### Make tools boring

A good tool method has a narrow name, typed inputs, a docstring, deterministic error behavior, and one clear external dependency. Discovery text comes from public method names and docstrings, so write them for an agent that is deciding whether to call the tool.

### Keep secrets out of tool code

Tool clients read secrets with `secret("NAME")`. Store values in the deployment secret backend with stable env-var names. Do not call `load_dotenv()` in `client.py`; reserve that for optional standalone CLIs.

### Use workflows for durable coordination

Use the workflow engine when a job needs to checkpoint, wait for an external event, sleep until later, retry, or coordinate child agent turns. A plain Agent API call is better for one immediate answer.

### Verify the exact surface

For a tool, call the REST method. For a workflow, create a run and inspect checkpoints. For an app, load the app and inspect logs. For a harness, run a `PONG` turn with that harness selector.

## Operating safely

### Keep raw credentials out of sandboxes

Sandboxes should receive placeholder values such as `OPENAI_API_KEY=OPENAI_API_KEY`. The firewall or Iron Proxy injects real secrets only for approved upstream hosts.

If you can print a raw provider token from inside a sandbox, stop and fix the deployment before taking user traffic.

### Give every deployment an operator

The operator owns secrets, Slack configuration, API keys, deployment upgrades, incident response, sensitive tools, and permission reviews. Without that owner, keep Centaur in local development until the operating model is clear.

### Use scoped API keys

Use broad keys only for bootstrap and administration. Apps, tools, and external clients should get the smallest useful scopes, such as `agent:execute`, `tools:chart`, or `tools:<tool>`.

### Treat overlays as production code

Overlays can add private prompts, tools, workflows, skills, and personas. Review them like production changes because they affect how every agent in that deployment behaves.

## Debugging habits

### Follow durable IDs

Most debugging starts with one of:

- `thread_key`
- `assignment_generation`
- `execution_id`
- `run_id`
- `event_id`

Use those IDs when checking API rows, logs, event streams, and final state.

### Reconnect instead of restarting first

For event streams, reconnect with the last seen `event_id`. For workflow runs, inspect checkpoints before rerunning. Durable state is there to tell you what already happened.

### Keep a recovery command set

```bash
just status
just logs api
just logs slackbot
kubectl get pods -n centaur -l centaur-agent=true
kubectl exec -n centaur deploy/centaur-centaur-api -- curl -fsS http://localhost:8000/health
```

If those checks look healthy, return to the smallest failing call and work forward.

## Documentation habits

### Write guides around outcomes

Start a guide by saying who it is for, what success looks like, and the smallest path to get there. Put exhaustive details in reference pages.

### Include expected shapes

For every curl command, show the important response fields or the expected state transition. Readers should know whether they are done without reading source code.

### Keep LLM-readable docs current

The docs build generates `/llms.txt`, `/llms-full.txt`, and plain Markdown under `/md/`. When you add or rename pages, make sure the sidebar and build output still expose them.
