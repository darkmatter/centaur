---
name: qa
description: "Run Centaur end-to-end QA against staging, preview deployments, or local stacks using prompt-driven smoke tests, concurrent agent turns, tool calls, Slack/thread context, attachments, scheduler checks, and database/log verification. Use when asked to QA Centaur, verify staging or previews, run E2E smoke tests, test deployment readiness, or check for deadlocks/regressions before prod promotion."
---

# Centaur QA

Run prompt-driven QA against the same surface users exercise: Slack or the workflow/API entrypoint backed by a staging or preview deployment. The goal is not just unit coverage; it is proof that agents can receive realistic prompts, call tools, persist state, handle files/thread context, and return useful artifacts without deadlocks.

## Default Behavior

If the user says "QA", "run smoke tests", "verify staging", "test the preview", or "check deploy readiness", start with the default smoke suite. Do not ask clarifying questions unless the target deployment or credentials are missing.

Default target order:

1. Explicit user-provided staging/preview URL or thread.
2. Current deployment environment variables and `centaur-tools list`.
3. Local stack only when the request says local or no deployed target is available.

Always produce a short pass/fail report with the target, commit/build if known, flows tested, failures, and evidence links or trace IDs.

## Safety Rules

- Prefer read-only operations. Skip or dry-run mutating tools unless the user explicitly requested the mutation test.
- Use test-only Slack threads, test files, and synthetic data.
- Keep tool payloads small unless testing large-file behavior.
- When a check depends on internal state, verify via the canonical owning source: API, Postgres, vlogs, workflow status, or Slack surface.
- Do not claim the deployment is ready if the exact user-visible surface was not verified.

## Smoke Suite

Run these checks for every staging or preview candidate before marking it ready for production.

### 1. Deployment Health

Verify the target is serving traffic and the expected Centaur components are healthy.

- Health/readiness endpoint returns OK.
- API can list live tools/capabilities.
- Runtime can start an agent turn.
- vlogs or deployment logs show no fresh critical errors during the run.
- Record the deployment URL, namespace/environment, commit/build, and timestamp.

Useful commands when available:

```bash
centaur-tools list
vlogs service_health
vlogs errors --start 1h
```

### 2. Concurrent Agent E2E

Simulate 5 users talking to the API or Slackbot at once. Repeat 5-10 rounds when checking for deadlocks.

Each synthetic user should ask for a different realistic task:

- Call 2-3 tools in parallel and summarize the results.
- Search for something current or internal, depending on available tools.
- Read thread history and answer a question about prior messages.
- Inspect an attachment and reply with a generated attachment.
- Query internal Paradigm/Centaur data through the sanctioned tool/API.

Pass criteria:

- Every run reaches a terminal success/failure state; no stuck busy state.
- Assistant response is delivered to the user-visible surface.
- Tool calls complete or fail with surfaced errors, not silent hangs.
- Postgres records user and assistant messages for each thread.
- vlogs/thread traces show one coherent execution per prompt, without duplicate final delivery.

### 3. Tool Calls

Run a representative read-only tool set through agent prompts, not only direct curl calls. Include at minimum:

- Slack/thread history or Slack search.
- Web/search tool.
- Internal Paradigm/Centaur database lookup.
- Observability/log lookup.
- One external API-backed tool if credentials are expected in that environment.

Pass criteria:

- The agent can discover and call tools from inside the sandbox.
- Results are grounded in actual tool output.
- Credential failures are classified separately from code failures.
- A failed tool call does not poison later calls in the same turn.

For direct tool inventory audits, use the separate `tool-qa` skill. This `qa` skill tests whether real agent workflows can use tools end to end.

### 4. Attachments

Cover the attachment flows called out in the staging discussion.

Required cases:

- Upload any small file and verify the agent can read it.
- Agent replies with any attachment and the file is downloadable from Slack/user surface.
- Image attachment.
- Video attachment or binary file when the target surface supports it.
- Large file near the configured practical limit.
- Multiple files in one message.
- Mid-thread message with an attachment.
- Thread A references Thread B where Thread B contains an attachment.

Pass criteria:

- Uploaded files are stored as attachments, not raw base64 in chat history.
- Sandbox can download attachment refs.
- Generated/downloaded attachment bytes are non-empty and match expected MIME/name metadata.
- Slack/user-visible attachment renders or downloads successfully.

### 5. Thread History And User Context

Verify context construction in realistic Slack thread shapes.

Required cases:

- Bot mention in thread root receives full relevant thread history.
- Bot mention in the middle of a thread receives earlier thread history.
- Interrupted or resumed thread passes the correct interrupt message plus prior context.
- User Slack username/display name is present in requester context.
- Bot can mention/tag the requesting user when asked.
- GitHub handle is present only when actually available in verified user context; missing handles must not be invented.

Pass criteria:

- The response uses prior thread facts accurately.
- The agent does not confuse root messages, replies, or adjacent linked threads.
- Requester metadata matches Slack/API-owned context.

### 6. Search And Internal DB

At minimum, verify:

- "Can search anything": run a real search via the deployed search tool or CLI and cite/return grounded results.
- "Can check internal Paradigm DB": run the sanctioned internal data tool/API and confirm the result came from the canonical source.
- Postgres has expected execution, message, attachment, and delivery rows after the turn.

Pass criteria:

- Search produces non-empty grounded results or a classified upstream failure.
- Internal DB check succeeds through the owning source, not cached repo context.
- Postgres state matches the user-visible response.

### 7. Scheduler

Run when the deployment includes scheduler workflows, alerts, cron jobs, or background smoke loops.

Required cases:

- Scheduler correctly runs cron workflows.
- Scheduler does not create a new tick when a tick is already pending or running for that job.
- Scheduler does not create catch-up ticks all the way to current time when the last tick is far in the past; it should create only the most recent eligible tick.

Pass criteria:

- Workflow/tick table has exactly the expected rows.
- Duplicate prevention is verified from canonical scheduler state.
- Logs show the scheduler decision path for skipped duplicate/catch-up ticks.

### 8. Promotion Gate

A commit/build is ready only when:

- Smoke suite passes on staging or preview.
- Failures are either fixed or explicitly accepted by the owner.
- The same commit/build is the one being promoted.
- Report includes enough trace IDs, Slack permalinks, workflow IDs, or SQL snippets for another engineer to verify.

## Suggested Prompt Pack

Use these prompts as agent-facing E2E tests. Run them across 5 concurrent test threads and repeat 5-10 times for deadlock checks.

```text
1. Search for a current public fact, call at least two tools in parallel, and summarize with sources.
2. Read the earlier messages in this thread and answer what test flows were requested.
3. Inspect the attached file and reply with a short text file containing your conclusion.
4. Look up one internal Centaur/Paradigm database fact using the approved internal data surface and state which source you queried.
5. Check recent logs for this thread/execution, summarize errors if any, and continue even if one tool fails.
```

## Report Format

Use this compact format in Slack or the PR comment:

```markdown
QA target: <environment / URL / commit>
Status: PASS | FAIL | PARTIAL
Ran at: <timestamp>

Passed:
- <flow> - <evidence>

Failed:
- <flow> - <symptom>; <trace/log/db evidence>; <owner/fix if known>

Skipped:
- <flow> - <reason>

Promotion recommendation: ready | blocked | needs owner acceptance
```

## Failure Triage

When a flow fails, inspect runtime evidence before redesigning.

- Thread/execution stuck: check workflow status, `agent_execution_requests`, `agent_execution_events`, and `vlogs thread_trace`.
- Missing Slack response: check final delivery outbox, Slackbot logs, and Slack file/message surface.
- Missing attachment: check attachments table, API download endpoint, sandbox logs, and Slack rendered file.
- Tool failure: compare tool schema, credentials, upstream reachability, and whether a later call still works.
- Context bug: inspect `chat_messages`, requester context, thread root/reply ordering, and attachment refs.
- Scheduler bug: inspect scheduler-owned tables/workflow state and logs for duplicate or catch-up decisions.

Use the repo or code only after live evidence identifies the failing boundary.
