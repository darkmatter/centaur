# Slackbot Fuzz Corpus

Local corpus for Slackbot v2 / api-rs mismatches between Slack-visible blocks and durable
`session_events`.

Note: broad raw Slack dumps and full local run directories are intentionally local-only. The PR
tracks the compact matrix/check artifacts below so failure signatures and proofs are reviewable
without committing large channel-history snapshots.

## Live Runs

- `20260602T144627Z/`: first mixed Slack/API pass, 8 Slack threads and 12 direct API sessions.
- `20260602T1500Z-steering-load/`: second mixed pass under heavier load, including timeout and same-thread race probes.
- `20260602T1510Z-steering-only/`: focused steering repro in `#centaur-ai-zygis`.
- `20260602T1535Z-production-shaped/`: focused `--claude continue` repro shaped after
  `#ai-agent` production threads.
- `production-seeds-20260602T1530Z/`: raw Slack thread dumps from `#ai-agent` complaint and
  incomplete-output patterns.
- `production-seeds-20260602T1530Z/summary.json`: machine-readable anomaly summary for the
  production seed dumps. Current labels include `no_rollout_found_message`,
  `raw_interactive_elements_fallback_text`, `visible_thinking_text`, `tiny_fragment_message`,
  `empty_bot_message`, `assistant_duplicate_or_burst_final`, `agent_request_failed_before_start`,
  `request_cancelled_message`, `runtime_issue_visible_text`, and
  `stream_without_assistant_message`.
- `production-seeds-20260602T1540Z/`: connector-only Slack snapshots from another readable
  `#ai-agent` surface where the raw repo `./slack` CLI returned `channel_not_found` for
  `C0A82R7S80N`. These are marked with `raw_dump_available: false` and keep the same message shape
  as raw dumps so the analyzer can label them.
- `production-seeds-20260602T1540Z/summary.json`: machine-readable anomaly summary for the
  connector snapshots. Current labels include `no_rollout_found_message`, `empty_bot_message`,
  `runtime_start_failure_visible_text`, and `user_nudge_after_poor_or_slow_response`.
- `synthetic-rendering-observed.json`: observed Chat SDK chunks/renderer events from synthetic
  Slackbot parser + renderer regression fixtures.
- `feedback-refresh-20260602Tfeedback/summary.json`: refreshed readback of local
  `#centaur-ai-zygis` repro threads and extracted post-bot user feedback.
- `db-snapshot-20260602Tdb.json`: current Postgres snapshot for all local Slack fuzz cases,
  including stuck running executions and zero-event threads.
- `api-rs-regression-check-20260602T1549Z.json`: live local API check showing a second active
  `execute` on a stuck thread now returns HTTP 409 instead of a raw database unique-constraint
  500.
- `api-rs-regression-check-20260602T1600Z.json`: live local API checks showing terminal output now
  precedes `session.execution_completed` on a reused sandbox, and a resource-pressure proxy
  readiness failure now persists `session.execution_failed` instead of leaving zero replayable
  events.
- `api-rs-regression-check-20260602T1610Z.json`: live local API check showing
  `max_duration_ms = 3000` now persists `session.execution_failed` with
  `reason = max_duration_exceeded`, leaves the execution failed, and suppresses late sandbox output
  after the timeout.
- `api-rs-regression-check-20260602T1616Z.json`: live local API check showing a message appended
  while an execution is active is forwarded to the sandbox stdin, echoed as a sandbox
  `userMessage`, and reflected in the final answer.
- `api-rs-regression-check-20260602T1633Z.json`: live local API checks showing
  `idle_timeout_ms` now pauses an idle sandbox after terminal output, plus a reproduced open
  failure where the next turn resumes the sandbox but fails before a final answer.
- `api-rs-regression-check-20260602T1702Z.json`: live local API check showing the current stack
  passed a 5-turn `centaur-session-cli` pause/resume stress run on one thread: every turn emitted
  final text, completed durably, and paused again with no `turn.failed` or
  `session.execution_failed`.
- `slack-regression-check-20260602T1640Z.json`: live Slack check in `#centaur-ai-zygis` showing
  idle pause works through Slackbot v2, a non-mention subscribed-thread reply after idle silently
  appends without executing, and a mention reply after idle resumes and returns a final answer.
- `slack-regression-check-20260602T1653Z.json`: live Slack check in `#centaur-ai-zygis` showing
  the Slackbot v2 fix: a non-mention subscribed-thread reply after idle now starts a second
  execution, resumes the paused sandbox, returns final text, and pauses again.
- `regression-matrix.json` and `REGRESSION_MATRIX.md`: generated failure matrix that maps corpus
  evidence to stable regression test targets and expected assertions.

## Regression Coverage Added

This pass added executable tests for several corpus failures:

- [packages/rendering/src/codex-app-server.test.ts](../../packages/rendering/src/codex-app-server.test.ts):
  - `nested_terminal_result_loses_final_text`
  - `terminal_before_final_delta`
  - `execution_failed_error_not_markdown`
  - `slack_command_failure_rendered_complete`
- [services/slackbotv2/test/chat-sdk-emulate.test.ts](../../services/slackbotv2/test/chat-sdk-emulate.test.ts):
  - malformed/plain `session.output.line` should not stop Slackbot stream consumption before a
    later final answer
  - slash-method `turn/completed` without result text should not close the Slack stream before a
    later final-answer delta
  - subscribed-thread replies execute when the thread is idle, while replies during an active
    stream remain append-only steering updates
- [services/api-rs/crates/centaur-session-runtime/src/lib.rs](../../services/api-rs/crates/centaur-session-runtime/src/lib.rs)
  and [services/api-rs/crates/centaur-session-sqlx/src/lib.rs](../../services/api-rs/crates/centaur-session-sqlx/src/lib.rs):
  - sandbox setup / I/O failures now persist `session.execution_failed` and mark the execution
    failed instead of leaving a running execution with zero events
  - active execution uniqueness is mapped to a typed store error and HTTP 409
  - stdout lines are associated with the active execution, and `session.execution_completed` is
    persisted only after terminal harness output
  - `max_duration_ms` now produces a durable timeout failure instead of allowing long turns to run
    to a normal final answer
  - user messages appended during an active execution are forwarded to the attached sandbox stdin
    and recorded with a durable `session.steering_delivered` event
  - `idle_timeout_ms` is persisted in execution metadata and arms a fenced post-terminal
    `session.sandbox_paused` transition so idle sessions stop holding a running sandbox pod

Current synthetic fixture status after regenerating
`local-corpus/slackbot-fuzz/synthetic-rendering-observed.json`:

- Fixed/no observed synthetic issue: `nested_terminal_result_loses_final_text`,
  `plain_output_line_stops_before_answer`, `terminal_before_final_delta`,
  `execution_failed_error_not_markdown`.
- Still open: `final_text_classified_as_commentary`. This is intentionally not papered over yet;
  blindly copying explicit `phase=commentary` text into final markdown could leak real thinking
  into Slack final answers.

## Failure Cases

### slack_plan_only_error_no_db_events

Artifact:
`local-corpus/slackbot-fuzz/20260602T1510Z-steering-only/slack-00-steer_during_stream/`

Slack thread:
`slack:C0APUQ8U5T9:1780412340.324149`

Observed:
- Slack bot reply text: `This message contains interactive elements.`
- Slack blocks: one `plan` block, title `Something went wrong`, one `Thinking` task with `status: error`.
- DB: zero `session_events` for the thread.
- DB: `session_executions.status = running`, `sessions.sandbox_id = null`.
- api-rs/slackbot logs: `execute` returned 500 because iron-proxy pod stayed Pending before sandbox readiness.

Why this matters:
Slack shows a completed error-looking thinking block, but the durable DB has no failure event and no terminal event. Replay/regression tests should assert that sandbox setup failures persist `session.execution_failed` and that Slack includes visible error text, not only an error-state Thinking task.

### slack_steering_followup_not_applied

Artifacts:
- `local-corpus/slackbot-fuzz/20260602T1500Z-steering-load/slack-00-steer_during_stream/`
- `local-corpus/slackbot-fuzz/20260602T1510Z-steering-only/slack-00-steer_during_stream/`
- Fix proof: `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1616Z.json`

Slack threads:
- `slack:C0APUQ8U5T9:1780412223.418579`
- `slack:C0APUQ8U5T9:1780412340.324149`

Observed:
- A mid-run Slack reply was appended while `activeExecution=true`.
- In one run, final bot text was `steering-end` instead of the follow-up sentinel `FINAL_STEERED_OK`.
- In the focused run, the thread failed before producing final text, so the steering update could not affect the result.
- After the api-rs fix, a reused running sandbox turn on
  `fuzz:20260602T1500Z-steering-load:api-00-api_pong` recorded
  `session.steering_delivered` at event `1347`, echoed the steering update as sandbox
  `userMessage` events `1349`/`1350`, and produced final answer `FINAL_ACTIVE_STEERING_OK`
  before `session.execution_completed` at event `1361`.

Why this matters:
The append path persists steering messages, but active session stdin is not steered. Tests should distinguish "message appended to thread history" from "running harness received steering input."

### slack_continue_followup_no_final_no_db_events

Artifact:
`local-corpus/slackbot-fuzz/20260602T1535Z-production-shaped/slack-00-continue_during_command/`

Slack thread:
`slack:C0APUQ8U5T9:1780412997.105889`

Observed:
- Root prompt asked for a long command and final sentinel `FINAL_CONTINUE_ROOT_OK`.
- Follow-up posted two seconds later: `--claude continue`.
- Slackbot logs show the follow-up took the subscribed-thread append path with
  `active_execution=true`, `open_stream=false`, and then force-released the thread lock.
- The bot's only visible response became text `This message contains interactive elements.`
  with one `plan` block titled `Something went wrong` and one `Thinking` task with
  `status: error`.
- DB has zero `session_events`; `sessions.status = executing`, `sessions.sandbox_id = null`,
  `session_executions.status = running`.
- `centaur-session-cli --attach --thread-key slack:C0APUQ8U5T9:1780412997.105889 --all-events`
  was silent over an 8s attach window, matching the empty DB/SSE side while Slack shows an
  error-looking block.
- Logs show `execute` failed with 500 because the iron-proxy pod stayed Pending:
  `sandbox is not ready: iron-proxy pod ... did not become running before timeout`.

Why this matters:
This reproduces the production-shaped "continue / are you alive?" path locally. A setup failure
after Slack stream creation leaves Slack with only an error-state Thinking block, while durable
state remains running with no terminal failure event for CLI/SSE clients to replay.

### db_execution_completed_before_terminal_output

Artifacts:
- Present in most `case.json` files under `20260602T144627Z/` and `20260602T1500Z-steering-load/`.
- Fix proof: `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1600Z.json`

Observed:
- `session.execution_completed` is written immediately after input is accepted.
- Later `session.output.line` events contain the actual `turn.completed` / final answer.
- After the api-rs fix, a reused running sandbox turn on
  `fuzz:20260602T1500Z-steering-load:api-00-api_pong` produced final answer output through event
  `1264`, then `session.execution_completed` at event `1265` with
  `completion_reason = turn_completed`.

Why this matters:
Any client that treats `session.execution_completed` as answer completion can stop early and miss
the final response. The local api-rs fix now moves completion after terminal output, and regression
coverage should keep Slackbot/session clients from reintroducing early-stop behavior.

### slack_command_failure_rendered_complete

Artifacts:
- `local-corpus/slackbot-fuzz/20260602T144627Z/slack-00-command_nonzero_final/`
- `local-corpus/slackbot-fuzz/20260602T144627Z/slack-00-invalid_command_final/`
- `local-corpus/slackbot-fuzz/20260602T1500Z-steering-load/slack-00-invalid_command_final/`
- Feedback snapshot:
  `local-corpus/slackbot-fuzz/20260602T144627Z/slack-00-command_nonzero_final/slack_thread_with_feedback.json`

Observed:
- Durable event item has command `status: failed` and nonzero `exitCode`.
- Slack plan task renders `status: complete`.
- The failure is only visible inside the output text, prefixed with `exit code N`.
- User feedback on the Slack thread: for `echo before; false`, visible output should focus on `before`,
  not prepend `exit code 1`; the task label may also need a friendlier shell label.

Why this matters:
This matches live user feedback in the test channel: failed shell tasks look completed. Renderer tests should preserve nonzero command failure status distinctly from successful completion.

### api_max_duration_ignored

Artifacts:
- `local-corpus/slackbot-fuzz/20260602T1500Z-steering-load/api-00-api_max_duration_ignored/`
- `local-corpus/slackbot-fuzz/20260602T1500Z-steering-load/api-01-api_max_duration_ignored/`
- Fix proof: `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1610Z.json`

Observed:
- Request set `max_duration_ms = 3000`.
- Prompt slept for 12 seconds and still completed with `API_TIMEOUT_SHOULD_NOT_FINISH`.
- After the api-rs fix, a reused running sandbox turn with `max_duration_ms = 3000` produced
  `session.execution_failed` at event `1305` with `reason = max_duration_exceeded`; after waiting
  past the underlying 12 second command duration, no late output or forbidden final answer was
  appended for that timed-out turn.

Why this matters:
api-rs validates timeout fields but does not enforce them. Regression tests should verify timeout behavior once implemented.

### api_same_thread_execute_race_500

Artifacts:
- `local-corpus/slackbot-fuzz/20260602T1500Z-steering-load/api-00-same_thread_execute_race/`
- `local-corpus/slackbot-fuzz/20260602T1500Z-steering-load/api-01-same_thread_execute_race/`
- `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1549Z.json`

Observed:
- Two concurrent `POST /api/session/{thread_key}/execute` calls on the same thread.
- One succeeds.
- One returns raw 500:
  `duplicate key value violates unique constraint "session_executions_one_active_idx"`.
- After the api-rs fix, a second active execute on stuck local thread
  `slack:C0APUQ8U5T9:1780412340.324149` returns HTTP 409 with
  `session ... already has an active execution`; DB still has only one running execution for that
  thread.

Why this matters:
The schema protects one active execution, but API should map the race to an intentional conflict/serialization response instead of leaking a database constraint error.

### slackbot_parser_stops_before_final_answer

Artifacts:
- `local-corpus/slackbot-fuzz/synthetic-rendering-cases.json`
- `local-corpus/slackbot-fuzz/synthetic-rendering-observed.json`

Synthetic cases:
- `plain_output_line_stops_before_answer`
- `terminal_before_final_delta`

Observed:
- A plain/malformed `session.output.line` is treated as terminal by Slackbot parser semantics.
- A `turn/completed` event is treated as terminal even if a later `item/agentMessage/delta` carries
  the final answer.
- In both synthetic cases, the runner consumed fewer events than were present and emitted no
  `markdown_text` chunk.

Why this matters:
This is a pure parser/renderer fixture that does not depend on sandbox readiness. It can produce
Slack plan/progress without final text even when the DB/SSE stream contains a later final answer.

### renderer_final_text_missing_or_in_thinking

Artifacts:
- `local-corpus/slackbot-fuzz/synthetic-rendering-cases.json`
- `local-corpus/slackbot-fuzz/synthetic-rendering-observed.json`

Synthetic cases:
- `nested_terminal_result_loses_final_text`
- `final_text_classified_as_commentary`

Observed:
- Nested terminal result `{result: {text: "Final answer"}}` closes with empty `answerMarkdown` and
  no `markdown_text` chunk.
- A final-looking answer emitted under `phase=commentary` renders only as a `Thinking` task detail;
  Slack receives task updates but no final markdown.

Why this matters:
These fixtures cover production symptoms where users see `Thinking` or progress blocks but no
final response. Regression tests should assert final answer normalization and prevent answer text
from living only inside a task block.

### renderer_execution_failed_error_not_markdown

Artifact:
`local-corpus/slackbot-fuzz/synthetic-rendering-observed.json`

Synthetic case:
`execution_failed_error_not_markdown`

Observed:
- Renderer emits `renderer.done.error = "sandbox exited"`.
- Chat SDK output includes `chat.session.closed.message.error`.
- `codexAppServerToChatSdkStream` filters non-append outputs, so Slack-visible chunks include only
  an error-state task and no `markdown_text` with the error.

Why this matters:
This matches the live/local `Thinking` error-block symptom. Slack should show visible error text,
not only task status, and DB/SSE should persist a replayable terminal failure event.

### no_rollout_found_after_retry_or_idle

Artifacts:
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/no-rollout-found-1779297412.json`
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/no-rollout-nextfork-1780350113.json`
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/no-rollout-retry-loop-1780331325.json`
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/no-rollout-workflow-1780388269.json`
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1540Z/no-rollout-live-prices-1780340465.connector.json`
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1540Z/no-rollout-newsletter-updates-1780328709.connector.json`
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1540Z/resume-suspended-sandbox-no-rollout-1779992917.connector.json`
- Summary:
  `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/summary.json`
  and `local-corpus/slackbot-fuzz/production-seeds-20260602T1540Z/summary.json`

Observed:
- Production seed summaries currently find `no_rollout_found_message` in 7 dumped or
  connector-snapshotted threads.
- The retry-loop seed `slack:C0A87C21805:1780331325.008179` has normal early answers, then five
  later bot replies of `no rollout found for thread id 019e8404-eb77-7422-9c3b-6bd7e8674475`
  after user `retry` / `please brother` nudges.
- The workflow seed `slack:C0A87C21805:1780388269.132769` includes visible runtime readiness
  failures, raw fallback plan-only messages, and later `no rollout found` replies.
- The connector snapshot `slack:C0A82R7S80N:1779992917.355879` includes both
  `no rollout found for thread id 019e6fd8-7b41-73f0-a368-95e95fd38306` and
  `Failed to start the runtime: failed to resume suspended sandbox: ...`, making it the strongest
  current evidence for an idle/resume or stale-runtime path.

Why this matters:
This is the strongest production evidence for the pause/resume or stale-runtime hypothesis. A
thread returning after idle/retry must recreate or resume from durable state; it should never expose
internal rollout lookup failures in Slack.

### api_idle_resume_no_final_after_pause

Artifact:
- Repro: `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1633Z.json`
- Current-stack stress pass: `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1702Z.json`

Thread:
- Repro: `fuzz:20260602T1500Z-steering-load:api-00-api_pong`
- Current-stack stress pass: `fuzz:resume-stress:20260602T165843Z`

Observed:
- First proof turn used `idle_timeout_ms = 2000` and completed with final answer
  `FINAL_IDLE_PAUSE2_OK`.
- api-rs recorded `session.sandbox_paused` at event `1390`; Kubernetes showed sandbox
  `asbx-1780412127680-30` with `spec.replicas = 0` and the agent pod terminating.
- The next turn on the same thread recorded `session.sandbox_resumed` at event `1392`, emitted
  startup and user-message events, then produced `turn.failed` at event `1400`.
- No final answer was emitted for the resume turn. The durable execution failed at event `1401`
  with `terminal harness output reported failure`; harness text included `Reconnecting... 2/5` and
  `timeout waiting for child process to exit`.
- A later current-stack stress pass sent five sequential `centaur-session-cli` turns on one thread
  with `idle_timeout_ms = 2000`. Turns 2-5 all recorded `session.sandbox_resumed`, all five turns
  emitted final sentinel text `API_RESUME_STRESS_N_OK`, all five persisted
  `session.execution_completed`, and all five paused again. No `turn.failed` or
  `session.execution_failed` appeared.

Why this matters:
This is a local product-path repro for the scale-oriented pause/resume path. Pausing now frees the
running sandbox, but resume has shown at least one prior no-final failure and must remain in the
regression set. The current stack passed a focused stress run, so the next exploration should widen
load/concurrency before changing api-rs resume policy again.

### slack_subscribed_idle_reply_does_not_execute

Artifact:
- Repro: `local-corpus/slackbot-fuzz/slack-regression-check-20260602T1640Z.json`
- Fix proof: `local-corpus/slackbot-fuzz/slack-regression-check-20260602T1653Z.json`

Slack thread:
- Repro: `slack:C0APUQ8U5T9:1780418218.640919`
- Fix proof: `slack:C0APUQ8U5T9:1780419146.814209`

Observed:
- Root Slack mention completed with visible final text `SLACK_IDLE_ROOT2_OK` and then api-rs
  recorded `session.sandbox_paused` at event `1425`.
- A later non-mention reply in the subscribed thread at `1780418277.732419` was accepted by
  Slackbot v2 as `mode=append`, `open_stream=false`, `active_execution=false`.
- No new `session_execution` was created, no DB event appeared after `1425`, and Slack had no bot
  reply for that user message.
- A subsequent mention reply in the same thread did execute, recorded `session.sandbox_resumed` at
  event `1427`, produced `SLACK_IDLE_FORCED_RESUME_OK`, and paused again at event `1448`.
- After the Slackbot v2 fix, a plain non-mention reply at `1780419205.297529` created execution
  `exe_055c9847c50348479a99e6e2c0c0220d` with `is_mention = false`, recorded
  `session.sandbox_resumed` at event `1475`, produced final text `IDLE_SUBSCRIBED_REPLY3_OK`, and
  paused again at event `1496`.

Why this matters:
Users commonly follow up in an already-subscribed thread without re-mentioning the bot. After an
idle pause, silently appending that reply with no execution looks like the bot ignored the user. The
current Slackbot policy now executes subscribed-thread replies when no stream is active and still
keeps active-stream replies append-only so they can steer the running turn.

### blank_response_then_cancelled

Artifacts:
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/blank-response-cancelled-1778715488.json`
- Summary:
  `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/summary.json`

Slack thread:
`slack:C0A87C21805:1778715488.113189`

Observed:
- Bot posted an empty message at `1778718110.218079`.
- User replied `blank response`.
- Bot then posted `Request cancelled. Send another message when you want to retry.`
- A later retry eventually produced a substantive answer.

Why this matters:
This is a production seed for the "empty bot reply" / "cancelled without useful terminal answer"
class. Regression tests should assert that blank assistant messages are never posted as final
state, and cancellation should be tied to an explicit user stop/cancel or a durable terminal event.

### agent_request_failed_before_execution_started

Artifacts:
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/agent-request-failed-before-start-1778876545.json`
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/agent-request-failed-duplicate-1778874924.json`
- Summary:
  `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/summary.json`

Observed:
- Production summary currently finds `agent_request_failed_before_start` in 2 dumped threads.
- `slack:C0A87C21805:1778876545.622099` includes repeated user `again` retries, two
  `Agent request failed before execution started. Please retry.` messages, and multiple
  `Agent hit a runtime issue before finishing` messages.
- The same thread includes `stream ended without producing a Message with role=assistant` and
  `502 bad gateway` variants.
- `slack:C0A87C21805:1778874924.787819` has duplicate pre-execution failure messages within the
  same thread.

Why this matters:
These are production seeds for startup/runtime failures that should be durable terminal failures,
not repeated ephemeral Slack text. They should be replayable through SSE/CLI and should not require
users to spam `again`.

### local_user_feedback_on_rendering

Artifact:
`local-corpus/slackbot-fuzz/feedback-refresh-20260602Tfeedback/summary.json`

Observed:
- `slack:C0APUQ8U5T9:1780411587.948459` (`command_nonzero_final`): user feedback says shell
  output should show just `before`; it should not prepend/show `exit code 1` as output, and the
  task label may need to say `Shell` rather than generic command execution.
- `slack:C0APUQ8U5T9:1780411587.955709` (`command_sleep_stdout`): user feedback says the output
  for `step-1`, `step-2`, `step-3` should render as one clean text block, not with excessive
  backticks/text artifacts.

Why this matters:
These are direct comments on the live test threads and should become renderer regression
expectations, not just subjective notes.

## Production Slack Seeds

Referenced from `#ai-agent` history:

- `slack:C0A87C21805:1780402147.806629`: user asked "u up? What happened"; bot had an interim `_base · codex_, with interactive elements`, later final.
- `slack:C0A87C21805:1780328412.179969`
  (`production-seeds-20260602T1530Z/interactive-elements-continue-1780328412.json`):
  user sent `--claude continue`; bot reply text became `This message contains interactive
  elements.` with plan + fragmented rich text blocks.
- `slack:C0A87C21805:1779899736.944699`
  (`production-seeds-20260602T1530Z/visible-thinking-still-working-1779899736.json`):
  visible `*Thinking*` text was posted as message text, users then asked "finish your thought",
  "Are you still working?", and "AI is lagging or something".
- `slack:C0A87C21805:1778609716.774809`
  (`production-seeds-20260602T1530Z/cancelled-without-user-1778609716.json`):
  plan-only raw fallback, then `Request cancelled` despite the user saying they did not ask
  for cancellation, plus an empty bot message.
- `slack:C0A87C21805:1780061130.781709`
  (`production-seeds-20260602T1530Z/so-nudge-duplicate-finals-1780061130.json`):
  user asked `so?` after interim plan-only messages; bot later posted two close final answers.
- `slack:C0A87C21805:1779297412.157979`
  (`production-seeds-20260602T1530Z/no-rollout-found-1779297412.json`):
  after `so?` / correction follow-up, bot posted duplicate `no rollout found for thread id ...`
  messages for two personas.
- `slack:C0A87C21805:1780239224.703289`
  (`production-seeds-20260602T1530Z/stray-fragment-1780239224.json`):
  user said "this is slop"; thread also contains a tiny stray final message `?”**`, useful for
  final-fragment regression coverage.
- `slack:C0A87C21805:1779982764.302029`
  (`production-seeds-20260602T1530Z/only-interactive-context-1779982764.json`):
  repeated prompt, then only `_base · codex_, with interactive elements` plus a plan block.
- `slack:C0A87C21805:1779993480.356969`
  (`production-seeds-20260602T1530Z/stray-dot-secret-thread-1779993480.json`):
  standalone `.` bot message before a later continuation, plus raw fallback plan messages.
- `slack:C0A87C21805:1779906207.358939`
  (`production-seeds-20260602T1530Z/attachment-workflow-bump-1779906207.json`):
  repeated plan+answer cycles, user `bump`, and a final raw `This message contains interactive
  elements.` plan-only response after the requested fix.
- `slack:C0A87C21805:1780350113.019789`
  (`production-seeds-20260602T1530Z/no-rollout-nextfork-1780350113.json`):
  long thread with repeated raw fallback plans and three later `no rollout found` bot replies after
  `buddy hello`, `help`, and `u useless` user nudges.
- `slack:C0A87C21805:1780388269.132769`
  (`production-seeds-20260602T1530Z/no-rollout-workflow-1780388269.json`):
  visible `Failed to start the runtime: sandbox readiness timed out after 60s`, followed by raw
  fallback and `no rollout found` replies.
- `slack:C0A87C21805:1780331325.008179`
  (`production-seeds-20260602T1530Z/no-rollout-retry-loop-1780331325.json`):
  normal early answers, then repeated `retry` / `please brother` messages all receive
  `no rollout found for thread id ...`.
- `slack:C0A87C21805:1778715488.113189`
  (`production-seeds-20260602T1530Z/blank-response-cancelled-1778715488.json`):
  empty bot message, user `blank response`, then `Request cancelled`.
- `slack:C0A87C21805:1778876545.622099`
  (`production-seeds-20260602T1530Z/agent-request-failed-before-start-1778876545.json`):
  repeated runtime failures, `stream ended without producing a Message with role=assistant`,
  `502 bad gateway`, and pre-execution failure replies.
- `slack:C0A87C21805:1778874924.787819`
  (`production-seeds-20260602T1530Z/agent-request-failed-duplicate-1778874924.json`):
  duplicate `Agent request failed before execution started. Please retry.` replies.

## Follow-Up Investigation Backlog

### sandbox_auto_pause_resume_no_rollout_found

Hypothesis:
The `no rollout found for thread id ...` production failures may be related to unattended threads
whose sandbox/runtime state was wiped, paused, or otherwise detached from Slack thread state.

Desired behavior:
- Threads that go unattended for a few minutes should not keep consuming sandbox resources.
- The runtime should auto-pause or release resources without losing durable thread/session state.
- When a user replies later, the sandbox should resume/recreate cleanly and continue from durable
  history.
- Slack should never show `no rollout found for thread id ...`; resume failures should persist a
  durable `session.execution_failed` event with visible Slack error text.
- Added scale requirement from 2026-06-02 local testing: once resource caps are enforced, unattended
  threads should be paused before they can exhaust sandbox capacity, and the resume path must be
  tested as a first-class Slack + `centaur-session-cli` E2E flow.

Future repro shape:
1. Send a synthetic Slack message tagging the dev bot in `#centaur-ai-zygis`.
2. Let the thread idle long enough to trigger the intended pause/release path.
3. Reply in the same thread.
4. Compare Slack blocks, DB `session_events`, `sessions`, `session_executions`, and
   `centaur-session-cli --attach` replay.
5. Assert no `no rollout found`, no raw `This message contains interactive elements.`, and no
   missing final response after resume.

Current seed evidence:
- `local-corpus/slackbot-fuzz/production-seeds-20260602T1540Z/resume-suspended-sandbox-no-rollout-1779992917.connector.json`
  directly shows a later `failed to resume suspended sandbox` reply after a `no rollout found`
  failure in the same production thread.
