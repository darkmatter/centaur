# Slackbot Regression Matrix

Generated: `2026-06-02T17:04:30.431814+00:00`

## Sources

- `fuzz_summaries`: `local-corpus/slackbot-fuzz/20260602T144627Z/summary.json`, `local-corpus/slackbot-fuzz/20260602T144627Z-timeout-probe/summary.json`, `local-corpus/slackbot-fuzz/20260602T1500Z-steering-load/summary.json`, `local-corpus/slackbot-fuzz/20260602T1510Z-steering-only/summary.json`, `local-corpus/slackbot-fuzz/20260602T1535Z-production-shaped/summary.json`, `local-corpus/slackbot-fuzz/20260602Tterminal-completion-check/summary.json`
- `production_summaries`: `local-corpus/slackbot-fuzz/production-seeds-20260602T1530Z/summary.json`, `local-corpus/slackbot-fuzz/production-seeds-20260602T1540Z/summary.json`
- `synthetic_observed`: `local-corpus/slackbot-fuzz/synthetic-rendering-observed.json`
- `synthetic_input`: `local-corpus/slackbot-fuzz/synthetic-rendering-cases.json`
- `feedback_summary`: `local-corpus/slackbot-fuzz/feedback-refresh-20260602Tfeedback/summary.json`
- `db_snapshot`: `local-corpus/slackbot-fuzz/db-snapshot-20260602Tdb.json`
- `api_rs_checks`: `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1549Z.json`, `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1600Z.json`, `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1610Z.json`, `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1616Z.json`, `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1633Z.json`, `local-corpus/slackbot-fuzz/api-rs-regression-check-20260602T1702Z.json`
- `slack_checks`: `local-corpus/slackbot-fuzz/slack-regression-check-20260602T1640Z.json`, `local-corpus/slackbot-fuzz/slack-regression-check-20260602T1653Z.json`

## Failures

| Priority | Failure | Repro | Evidence | Primary Test Targets |
| --- | --- | --- | --- | --- |
| p0 | `slack_plan_only_error_no_db_events`<br>Sandbox setup failure leaves Slack with only an error-state plan/Thinking block while DB/SSE has no replayable terminal event. | `local_repro` | local:2, prod:10, db:1, api-rs:1 | api-rs session failure persistence<br>Slackbot v2 stream/error rendering<br>centaur-session-cli replay of terminal failures |
| p0 | `slack_continue_followup_no_final_no_db_events`<br>A production-shaped --claude continue reply during startup produced raw interactive fallback text and no DB events. | `local_repro` | local:2, prod:14, db:1 | Slackbot subscribed-thread append path<br>api-rs startup failure lifecycle<br>SSE replay after failed Slack turns |
| p0 | `slack_steering_followup_not_applied`<br>Mid-run Slack replies are persisted as history but do not steer the active harness. | `local_repro` | local:1, prod:11, db:2, api-rs:1 | Slackbot active execution steering<br>api-rs session stdin append/interrupt semantics |
| p0 | `db_execution_completed_before_terminal_output`<br>api-rs records session.execution_completed when input is accepted, before terminal assistant output is emitted. | `local_repro` | local:41, db:13, feedback:2, api-rs:1 | api-rs execution lifecycle<br>SSE client completion semantics<br>centaur-session-cli exit-on-terminal |
| p1 | `slack_command_failure_rendered_complete`<br>Nonzero shell commands render as complete tasks and expose exit-code text as output. | `local_repro_with_user_feedback` | local:9, db:3, feedback:1 | packages/rendering command task status<br>Slackbot v2 plan block mapping |
| p2 | `slack_command_output_block_shape`<br>Simple sequential command output renders as noisy code/backtick fragments instead of one clean text block. | `local_repro_with_user_feedback` | feedback:1 | packages/rendering command output normalization<br>Slackbot v2 rich_text/markdown block conversion |
| p1 | `api_max_duration_ignored`<br>max_duration_ms is accepted but a 3s request can run 12s and complete. | `local_repro` | local:2, api-rs:1 | api-rs execution timeout enforcement |
| p1 | `api_same_thread_execute_race_500`<br>Concurrent execute calls for one thread leak a DB unique-constraint error as HTTP 500. | `local_repro` | local:2, api-rs:1 | api-rs execute serialization/conflict handling |
| p0 | `slackbot_parser_stops_before_final_answer`<br>Slackbot parser can stop on malformed/plain output or early terminal markers before later final answer deltas. | `synthetic_repro` | synthetic:2 | services/slackbotv2 session event parser tests<br>Chat SDK stream emulator tests |
| p0 | `renderer_final_text_missing_or_in_thinking`<br>Final-looking answer text can be lost or rendered only inside a Thinking task. | `synthetic_repro` | prod:3, synthetic:2 | packages/rendering final answer normalization<br>Slackbot v2 markdown_text emission |
| p0 | `renderer_execution_failed_error_not_markdown`<br>Renderer produces an error close event, but Slack-visible chunks have no markdown error text. | `synthetic_repro_plus_local_seed` | local:2, prod:10, synthetic:1, db:2 | packages/rendering error finalization<br>Slackbot v2 task/error block conversion |
| p0 | `no_rollout_found_after_retry_or_idle`<br>Idle/retry production threads later receive internal 'no rollout found' messages. Likely tied to stale runtime state or future pause/resume behavior. | `production_seed_backlog` | prod:7 | sandbox auto-pause/resume<br>runtime/session lookup after idle<br>Slackbot final error redaction |
| p0 | `api_idle_resume_no_final_after_pause`<br>After an idle timeout pause, api-rs previously resumed the sandbox but the next Codex app-server turn failed before producing a final answer; the current stack passed a 5-turn pause/resume stress run, so this remains an intermittent regression target. | `local_repro_current_stack_passed_stress` | api-rs:2 | api-rs suspended sandbox resume/recreate policy<br>Codex app-server readiness after resume<br>SSE replay of failed resume turns |
| p0 | `slack_subscribed_idle_reply_does_not_execute`<br>A reply in a subscribed Slack thread after the session is idle was appended to history without executing a new turn or producing a bot response; the local fix now executes inactive subscribed replies and keeps active-stream replies append-only. | `local_slack_repro_fixed` | slack:2 | Slackbot subscribed-thread idle reply policy<br>Slackbot append-vs-execute routing<br>Slack-visible response for idle follow-ups |
| p1 | `blank_response_then_cancelled`<br>Production seed shows an empty bot reply followed by Request cancelled after a user reports blank response. | `production_seed` | prod:3 | Slackbot blank-final guard<br>cancellation terminal-state mapping |
| p1 | `agent_request_failed_before_execution_started`<br>Production seeds contain repeated pre-execution failure messages, runtime issues, and stream-without-assistant errors. | `production_seed` | prod:4 | api-rs startup/runtime terminal failure persistence<br>Slackbot retry deduplication |

## Assertions

### slack_plan_only_error_no_db_events
- pre-ready sandbox failures insert a terminal session.execution_failed event
- execution status is not left running when no sandbox is assigned
- Slack emits visible error markdown instead of only a task error

### slack_continue_followup_no_final_no_db_events
- follow-up append while startup is active does not force-release into a stuck running execution
- thread replay contains the same terminal failure Slack shows
- raw Slack fallback text is not the only visible bot response

### slack_steering_followup_not_applied
- a reply posted while active_execution=true reaches the attached sandbox stdin
- final answer reflects the steering sentinel when the harness remains healthy

### db_execution_completed_before_terminal_output
- execution_completed is written only after terminal harness output is observed
- clients do not stop before the final assistant message

### slack_command_failure_rendered_complete
- nonzero command events render as failed/error task state
- stdout remains visible without prepending exit-code boilerplate as output text

### slack_command_output_block_shape
- stdout for step-1/step-2/step-3 is rendered as one clean text block
- task details do not duplicate code fences around simple stdout

### api_max_duration_ignored
- execution is cancelled or failed when max_duration_ms elapses
- timeout terminal state is persisted and replayable

### api_same_thread_execute_race_500
- second active execute returns an intentional conflict/queued response
- raw database constraint text is never exposed to clients

### slackbot_parser_stops_before_final_answer
- plain output lines do not stop consumption before a later terminal answer
- turn.completed does not cause the final answer delta to be dropped

### renderer_final_text_missing_or_in_thinking
- nested terminal result text is normalized into visible markdown_text
- answer text is never present only inside task details

### renderer_execution_failed_error_not_markdown
- execution failure emits visible final markdown error text
- task error state is supplementary, not the only user-visible response

### no_rollout_found_after_retry_or_idle
- reply after idle resumes or recreates from durable thread history
- Slack never exposes 'no rollout found for thread id'
- resume failures persist terminal session.execution_failed events

### api_idle_resume_no_final_after_pause
- reply after idle pause produces a final answer or recreates from durable history
- resume emits a durable healthy terminal state, not only startup/user events then turn.failed
- Slack does not show a thinking-only error block for resume failures

### slack_subscribed_idle_reply_does_not_execute
- idle subscribed-thread replies either execute a new turn or receive an explicit visible response
- Slackbot does not silently append an idle user reply with open_stream=false
- DB and Slack readback agree on whether a follow-up produced an execution

### blank_response_then_cancelled
- empty assistant messages are not posted as final Slack replies
- Request cancelled is only emitted for explicit cancel or durable cancellation

### agent_request_failed_before_execution_started
- pre-execution failures are durable terminal states
- retries do not duplicate identical failure messages in one thread
