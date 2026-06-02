#!/usr/bin/env python3
"""Build a regression matrix from the Slackbot fuzz corpus."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


DEFAULT_CORPUS_DIR = Path("local-corpus/slackbot-fuzz")

FAILURES: list[dict[str, Any]] = [
    {
        "failure_id": "slack_plan_only_error_no_db_events",
        "priority": "p0",
        "repro_status": "local_repro",
        "surfaces": ["slack", "api-rs", "sse"],
        "summary": (
            "Sandbox setup failure leaves Slack with only an error-state plan/Thinking block "
            "while DB/SSE has no replayable terminal event."
        ),
        "local_issue_labels": [
            "db_no_terminal_output",
            "slack_plan_only_thread_without_final",
            "slack_plan_task_error_status",
        ],
        "production_issue_labels": [
            "raw_interactive_elements_fallback_text",
            "plan_only_thread_without_final",
            "plan_task_error",
        ],
        "db_thread_keys": ["slack:C0APUQ8U5T9:1780412340.324149"],
        "regression_targets": [
            "api-rs session failure persistence",
            "Slackbot v2 stream/error rendering",
            "centaur-session-cli replay of terminal failures",
        ],
        "expected_assertions": [
            "pre-ready sandbox failures insert a terminal session.execution_failed event",
            "execution status is not left running when no sandbox is assigned",
            "Slack emits visible error markdown instead of only a task error",
        ],
    },
    {
        "failure_id": "slack_continue_followup_no_final_no_db_events",
        "priority": "p0",
        "repro_status": "local_repro",
        "surfaces": ["slack", "api-rs", "sse"],
        "summary": (
            "A production-shaped --claude continue reply during startup produced raw interactive "
            "fallback text and no DB events."
        ),
        "local_issue_labels": [
            "db_no_terminal_output",
            "slack_plan_only_thread_without_final",
            "slack_plan_task_error_status",
            "slack_raw_interactive_elements_fallback_text",
        ],
        "production_issue_labels": [
            "raw_interactive_elements_fallback_text",
            "user_nudge_after_poor_or_slow_response",
        ],
        "db_thread_keys": ["slack:C0APUQ8U5T9:1780412997.105889"],
        "regression_targets": [
            "Slackbot subscribed-thread append path",
            "api-rs startup failure lifecycle",
            "SSE replay after failed Slack turns",
        ],
        "expected_assertions": [
            "follow-up append while startup is active does not force-release into a stuck running execution",
            "thread replay contains the same terminal failure Slack shows",
            "raw Slack fallback text is not the only visible bot response",
        ],
    },
    {
        "failure_id": "slack_steering_followup_not_applied",
        "priority": "p0",
        "repro_status": "local_repro",
        "surfaces": ["slack", "sandbox stdin"],
        "summary": "Mid-run Slack replies are persisted as history but do not steer the active harness.",
        "local_issue_labels": ["slack_steering_followup_ignored"],
        "production_issue_labels": ["user_nudge_after_poor_or_slow_response"],
        "db_thread_keys": ["slack:C0APUQ8U5T9:1780412223.418579", "slack:C0APUQ8U5T9:1780412340.324149"],
        "regression_targets": [
            "Slackbot active execution steering",
            "api-rs session stdin append/interrupt semantics",
        ],
        "expected_assertions": [
            "a reply posted while active_execution=true reaches the attached sandbox stdin",
            "final answer reflects the steering sentinel when the harness remains healthy",
        ],
    },
    {
        "failure_id": "db_execution_completed_before_terminal_output",
        "priority": "p0",
        "repro_status": "local_repro",
        "surfaces": ["api-rs", "sse", "cli"],
        "summary": (
            "api-rs records session.execution_completed when input is accepted, before terminal "
            "assistant output is emitted."
        ),
        "local_issue_labels": ["db_execution_completed_before_terminal_output"],
        "regression_targets": [
            "api-rs execution lifecycle",
            "SSE client completion semantics",
            "centaur-session-cli exit-on-terminal",
        ],
        "expected_assertions": [
            "execution_completed is written only after terminal harness output is observed",
            "clients do not stop before the final assistant message",
        ],
    },
    {
        "failure_id": "slack_command_failure_rendered_complete",
        "priority": "p1",
        "repro_status": "local_repro_with_user_feedback",
        "surfaces": ["slack", "renderer"],
        "summary": "Nonzero shell commands render as complete tasks and expose exit-code text as output.",
        "local_issue_labels": ["db_nonzero_commands_map_to_complete_tasks"],
        "feedback_case_ids": ["slack-00-command_nonzero_final"],
        "regression_targets": [
            "packages/rendering command task status",
            "Slackbot v2 plan block mapping",
        ],
        "expected_assertions": [
            "nonzero command events render as failed/error task state",
            "stdout remains visible without prepending exit-code boilerplate as output text",
        ],
    },
    {
        "failure_id": "slack_command_output_block_shape",
        "priority": "p2",
        "repro_status": "local_repro_with_user_feedback",
        "surfaces": ["slack", "renderer"],
        "summary": "Simple sequential command output renders as noisy code/backtick fragments instead of one clean text block.",
        "feedback_case_ids": ["slack-00-command_sleep_stdout"],
        "regression_targets": [
            "packages/rendering command output normalization",
            "Slackbot v2 rich_text/markdown block conversion",
        ],
        "expected_assertions": [
            "stdout for step-1/step-2/step-3 is rendered as one clean text block",
            "task details do not duplicate code fences around simple stdout",
        ],
    },
    {
        "failure_id": "api_max_duration_ignored",
        "priority": "p1",
        "repro_status": "local_repro",
        "surfaces": ["api-rs"],
        "summary": "max_duration_ms is accepted but a 3s request can run 12s and complete.",
        "local_issue_labels": ["api_max_duration_ignored"],
        "regression_targets": ["api-rs execution timeout enforcement"],
        "expected_assertions": [
            "execution is cancelled or failed when max_duration_ms elapses",
            "timeout terminal state is persisted and replayable",
        ],
    },
    {
        "failure_id": "api_same_thread_execute_race_500",
        "priority": "p1",
        "repro_status": "local_repro",
        "surfaces": ["api-rs"],
        "summary": "Concurrent execute calls for one thread leak a DB unique-constraint error as HTTP 500.",
        "local_issue_labels": ["api_same_thread_execute_race_error"],
        "regression_targets": ["api-rs execute serialization/conflict handling"],
        "expected_assertions": [
            "second active execute returns an intentional conflict/queued response",
            "raw database constraint text is never exposed to clients",
        ],
    },
    {
        "failure_id": "slackbot_parser_stops_before_final_answer",
        "priority": "p0",
        "repro_status": "synthetic_repro",
        "surfaces": ["slackbotv2", "chat-sdk"],
        "summary": "Slackbot parser can stop on malformed/plain output or early terminal markers before later final answer deltas.",
        "synthetic_case_ids": ["plain_output_line_stops_before_answer", "terminal_before_final_delta"],
        "regression_targets": [
            "services/slackbotv2 session event parser tests",
            "Chat SDK stream emulator tests",
        ],
        "expected_assertions": [
            "plain output lines do not stop consumption before a later terminal answer",
            "turn.completed does not cause the final answer delta to be dropped",
        ],
    },
    {
        "failure_id": "renderer_final_text_missing_or_in_thinking",
        "priority": "p0",
        "repro_status": "synthetic_repro",
        "surfaces": ["renderer", "slackbotv2"],
        "summary": "Final-looking answer text can be lost or rendered only inside a Thinking task.",
        "synthetic_case_ids": [
            "nested_terminal_result_loses_final_text",
            "final_text_classified_as_commentary",
        ],
        "production_issue_labels": ["visible_thinking_text", "tiny_fragment_message"],
        "regression_targets": [
            "packages/rendering final answer normalization",
            "Slackbot v2 markdown_text emission",
        ],
        "expected_assertions": [
            "nested terminal result text is normalized into visible markdown_text",
            "answer text is never present only inside task details",
        ],
    },
    {
        "failure_id": "renderer_execution_failed_error_not_markdown",
        "priority": "p0",
        "repro_status": "synthetic_repro_plus_local_seed",
        "surfaces": ["renderer", "slackbotv2"],
        "summary": "Renderer produces an error close event, but Slack-visible chunks have no markdown error text.",
        "synthetic_case_ids": ["execution_failed_error_not_markdown"],
        "local_issue_labels": ["slack_plan_task_error_status"],
        "production_issue_labels": ["plan_task_error", "raw_interactive_elements_fallback_text"],
        "regression_targets": [
            "packages/rendering error finalization",
            "Slackbot v2 task/error block conversion",
        ],
        "expected_assertions": [
            "execution failure emits visible final markdown error text",
            "task error state is supplementary, not the only user-visible response",
        ],
    },
    {
        "failure_id": "no_rollout_found_after_retry_or_idle",
        "priority": "p0",
        "repro_status": "production_seed_backlog",
        "surfaces": ["slack", "runtime lookup", "pause-resume"],
        "summary": (
            "Idle/retry production threads later receive internal 'no rollout found' messages. "
            "Likely tied to stale runtime state or future pause/resume behavior."
        ),
        "production_issue_labels": ["no_rollout_found_message"],
        "regression_targets": [
            "sandbox auto-pause/resume",
            "runtime/session lookup after idle",
            "Slackbot final error redaction",
        ],
        "expected_assertions": [
            "reply after idle resumes or recreates from durable thread history",
            "Slack never exposes 'no rollout found for thread id'",
            "resume failures persist terminal session.execution_failed events",
        ],
    },
    {
        "failure_id": "api_idle_resume_no_final_after_pause",
        "priority": "p0",
        "repro_status": "local_repro_current_stack_passed_stress",
        "surfaces": ["api-rs", "pause-resume", "sse", "cli"],
        "summary": (
            "After an idle timeout pause, api-rs previously resumed the sandbox but the next "
            "Codex app-server turn failed before producing a final answer; the current stack "
            "passed a 5-turn pause/resume stress run, so this remains an intermittent regression "
            "target."
        ),
        "regression_targets": [
            "api-rs suspended sandbox resume/recreate policy",
            "Codex app-server readiness after resume",
            "SSE replay of failed resume turns",
        ],
        "expected_assertions": [
            "reply after idle pause produces a final answer or recreates from durable history",
            "resume emits a durable healthy terminal state, not only startup/user events then turn.failed",
            "Slack does not show a thinking-only error block for resume failures",
        ],
    },
    {
        "failure_id": "slack_subscribed_idle_reply_does_not_execute",
        "priority": "p0",
        "repro_status": "local_slack_repro_fixed",
        "surfaces": ["slack", "slackbotv2", "api-rs"],
        "summary": (
            "A reply in a subscribed Slack thread after the session is idle was appended to "
            "history without executing a new turn or producing a bot response; the local fix "
            "now executes inactive subscribed replies and keeps active-stream replies append-only."
        ),
        "regression_targets": [
            "Slackbot subscribed-thread idle reply policy",
            "Slackbot append-vs-execute routing",
            "Slack-visible response for idle follow-ups",
        ],
        "expected_assertions": [
            "idle subscribed-thread replies either execute a new turn or receive an explicit visible response",
            "Slackbot does not silently append an idle user reply with open_stream=false",
            "DB and Slack readback agree on whether a follow-up produced an execution",
        ],
    },
    {
        "failure_id": "blank_response_then_cancelled",
        "priority": "p1",
        "repro_status": "production_seed",
        "surfaces": ["slack", "renderer"],
        "summary": "Production seed shows an empty bot reply followed by Request cancelled after a user reports blank response.",
        "production_issue_labels": ["empty_bot_message", "request_cancelled_message"],
        "regression_targets": [
            "Slackbot blank-final guard",
            "cancellation terminal-state mapping",
        ],
        "expected_assertions": [
            "empty assistant messages are not posted as final Slack replies",
            "Request cancelled is only emitted for explicit cancel or durable cancellation",
        ],
    },
    {
        "failure_id": "agent_request_failed_before_execution_started",
        "priority": "p1",
        "repro_status": "production_seed",
        "surfaces": ["slack", "api-rs startup"],
        "summary": "Production seeds contain repeated pre-execution failure messages, runtime issues, and stream-without-assistant errors.",
        "production_issue_labels": [
            "agent_request_failed_before_start",
            "runtime_issue_visible_text",
            "stream_without_assistant_message",
            "runtime_start_failure_visible_text",
        ],
        "regression_targets": [
            "api-rs startup/runtime terminal failure persistence",
            "Slackbot retry deduplication",
        ],
        "expected_assertions": [
            "pre-execution failures are durable terminal states",
            "retries do not duplicate identical failure messages in one thread",
        ],
    },
]


def main() -> int:
    args = parse_args()
    corpus_dir = Path(args.corpus_dir)
    sources = load_sources(corpus_dir)
    matrix = build_matrix(corpus_dir, sources)

    json_path = Path(args.output_json)
    md_path = Path(args.output_md)
    json_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(matrix, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(render_markdown(matrix), encoding="utf-8")
    print(json_path)
    print(md_path)
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", default=str(DEFAULT_CORPUS_DIR))
    parser.add_argument(
        "--output-json",
        default=str(DEFAULT_CORPUS_DIR / "regression-matrix.json"),
    )
    parser.add_argument(
        "--output-md",
        default=str(DEFAULT_CORPUS_DIR / "REGRESSION_MATRIX.md"),
    )
    return parser.parse_args()


def load_sources(corpus_dir: Path) -> dict[str, Any]:
    synthetic_observed_path = corpus_dir / "synthetic-rendering-observed.json"
    synthetic_observed = load_optional(synthetic_observed_path)
    if synthetic_observed:
        synthetic_observed["_path"] = str(synthetic_observed_path)
    return {
        "fuzz_summaries": load_fuzz_summaries(corpus_dir),
        "production_summaries": load_production_summaries(corpus_dir),
        "synthetic_observed": synthetic_observed,
        "feedback_summary": load_latest(corpus_dir.glob("feedback-refresh-*/summary.json")),
        "db_snapshot": load_latest(corpus_dir.glob("db-snapshot-*.json")),
        "api_rs_checks": load_api_rs_checks(corpus_dir),
        "slack_checks": load_slack_checks(corpus_dir),
    }


def load_fuzz_summaries(corpus_dir: Path) -> list[dict[str, Any]]:
    summaries = []
    for path in sorted(corpus_dir.glob("*/summary.json")):
        data = load_optional(path)
        if data.get("schema") == "centaur.slackbot_fuzz_summary.v1":
            summaries.append({**data, "_path": str(path)})
    return summaries


def load_production_summaries(corpus_dir: Path) -> list[dict[str, Any]]:
    summaries = []
    for path in sorted(corpus_dir.glob("production-seeds-*/summary.json")):
        data = load_optional(path)
        if data.get("schema") == "centaur.slackbot_seed_summary.v1":
            summaries.append({**data, "_path": str(path)})
    return summaries


def load_api_rs_checks(corpus_dir: Path) -> list[dict[str, Any]]:
    checks = []
    for path in sorted(corpus_dir.glob("api-rs-regression-check-*.json")):
        data = load_optional(path)
        if data.get("schema") == "centaur.api_rs_regression_check.v1":
            checks.append({**data, "_path": str(path)})
    return checks


def load_slack_checks(corpus_dir: Path) -> list[dict[str, Any]]:
    checks = []
    for path in sorted(corpus_dir.glob("slack-regression-check-*.json")):
        data = load_optional(path)
        if data.get("schema") == "centaur.slack_regression_check.v1":
            checks.append({**data, "_path": str(path)})
    return checks


def load_latest(paths: Any) -> dict[str, Any]:
    existing = sorted([path for path in paths if path.exists()], key=lambda path: path.stat().st_mtime)
    if not existing:
        return {}
    data = load_optional(existing[-1])
    data["_path"] = str(existing[-1])
    return data


def load_optional(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def build_matrix(corpus_dir: Path, sources: dict[str, Any]) -> dict[str, Any]:
    entries = []
    for failure in FAILURES:
        entry = {
            key: value
            for key, value in failure.items()
            if key
            not in {
                "local_issue_labels",
                "production_issue_labels",
                "synthetic_case_ids",
                "db_thread_keys",
                "feedback_case_ids",
            }
        }
        entry["evidence"] = build_evidence(corpus_dir, failure, sources)
        entries.append(entry)

    return {
        "schema": "centaur.slackbot_regression_matrix.v1",
        "created_at": datetime.now(UTC).isoformat(),
        "source_paths": source_paths(sources),
        "counts": {
            "failure_count": len(entries),
            "by_priority": dict(Counter(entry["priority"] for entry in entries)),
            "by_repro_status": dict(Counter(entry["repro_status"] for entry in entries)),
        },
        "failures": entries,
    }


def build_evidence(
    corpus_dir: Path,
    failure: dict[str, Any],
    sources: dict[str, Any],
) -> dict[str, Any]:
    local_labels = set(failure.get("local_issue_labels") or [])
    production_labels = set(failure.get("production_issue_labels") or [])
    synthetic_ids = set(failure.get("synthetic_case_ids") or [])
    db_thread_keys = set(failure.get("db_thread_keys") or [])
    feedback_case_ids = set(failure.get("feedback_case_ids") or [])
    failure_id = str(failure["failure_id"])

    local_cases = collect_local_cases(corpus_dir, sources["fuzz_summaries"], local_labels)
    production_seeds = collect_production_seeds(sources["production_summaries"], production_labels)
    synthetic_cases = collect_synthetic_cases(sources["synthetic_observed"], synthetic_ids)
    db_cases = collect_db_cases(sources["db_snapshot"], db_thread_keys or {case["thread_key"] for case in local_cases})
    feedback = collect_feedback(sources["feedback_summary"], feedback_case_ids or {case["case_id"] for case in local_cases})
    api_rs_checks = collect_api_rs_checks(sources["api_rs_checks"], failure_id)
    slack_checks = collect_slack_checks(sources["slack_checks"], failure_id)

    return {
        "local_cases": local_cases,
        "production_seeds": production_seeds,
        "synthetic_cases": synthetic_cases,
        "db_snapshot_cases": db_cases,
        "user_feedback": feedback,
        "api_rs_checks": api_rs_checks,
        "slack_checks": slack_checks,
    }


def collect_local_cases(
    corpus_dir: Path,
    summaries: list[dict[str, Any]],
    labels: set[str],
) -> list[dict[str, Any]]:
    if not labels:
        return []
    cases: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for summary in summaries:
        run_id = str(summary.get("run_id") or "")
        result_artifacts = {
            str(result.get("case_id")): result.get("artifacts") or {}
            for result in summary.get("results") or []
        }
        for issue in summary.get("issues") or []:
            issue_labels = set(issue.get("issues") or [])
            if not labels.intersection(issue_labels):
                continue
            key = (run_id, str(issue.get("case_id") or ""))
            if key in seen:
                continue
            seen.add(key)
            case_id = key[1]
            artifact_dir = corpus_dir / run_id / case_id if run_id and case_id else None
            cases.append(
                compact_dict(
                    {
                        "run_id": run_id,
                        "case_id": case_id,
                        "surface": issue.get("surface"),
                        "thread_key": issue.get("thread_key"),
                        "matched_issues": sorted(labels.intersection(issue_labels)),
                        "all_issues": sorted(issue_labels),
                        "artifact_dir": str(artifact_dir) if artifact_dir and artifact_dir.exists() else None,
                        "artifacts": result_artifacts.get(case_id) or None,
                        "error": issue.get("error"),
                    }
                )
            )
    return cases


def collect_production_seeds(summaries: list[dict[str, Any]], labels: set[str]) -> list[dict[str, Any]]:
    if not labels:
        return []
    seeds = []
    for summary in summaries:
        for seed in summary.get("seeds") or []:
            issue_labels = set(seed.get("issues") or [])
            if labels.intersection(issue_labels):
                seeds.append(
                    {
                        "summary": summary.get("_path"),
                        "file": seed.get("file"),
                        "thread_key": seed.get("thread_key"),
                        "matched_issues": sorted(labels.intersection(issue_labels)),
                        "all_issues": sorted(issue_labels),
                    }
                )
    return seeds


def collect_synthetic_cases(observed: dict[str, Any], case_ids: set[str]) -> list[dict[str, Any]]:
    if not case_ids:
        return []
    cases = []
    for case in observed.get("observed") or []:
        if str(case.get("case_id")) not in case_ids:
            continue
        cases.append(
            {
                "case_id": case.get("case_id"),
                "observed_issues": case.get("observed_issues") or [],
                "markdown_text": case.get("markdown_text") or "",
                "slackbot_stopped_before_all_events": bool(case.get("slackbot_stopped_before_all_events")),
                "slackbot_consumed_event_count": case.get("slackbot_consumed_event_count"),
                "input_event_count": case.get("input_event_count"),
                "expected_regression_assertion": case.get("expected_regression_assertion"),
            }
        )
    return cases


def collect_db_cases(snapshot: dict[str, Any], thread_keys: set[str]) -> list[dict[str, Any]]:
    if not thread_keys:
        return []
    cases = []
    for case in snapshot.get("cases") or []:
        if str(case.get("thread_key")) not in thread_keys:
            continue
        db = case.get("db") or {}
        session = db.get("session") or {}
        event_range = db.get("event_range") or {}
        executions = db.get("executions") or []
        cases.append(
            {
                "case_id": case.get("case_id"),
                "thread_key": case.get("thread_key"),
                "session_status": session.get("status"),
                "sandbox_id": session.get("sandbox_id"),
                "execution_statuses": [execution.get("status") for execution in executions],
                "event_count": event_range.get("event_count"),
                "terminal_event_count": len(db.get("terminal_events") or []),
                "event_counts": db.get("event_counts") or {},
            }
        )
    return cases


def collect_feedback(summary: dict[str, Any], case_ids: set[str]) -> list[dict[str, Any]]:
    if not case_ids:
        return []
    feedback = []
    for thread in summary.get("threads") or []:
        if str(thread.get("case_id")) not in case_ids:
            continue
        messages = thread.get("feedback_like_messages") or []
        if not messages:
            continue
        feedback.append(
            {
                "case_id": thread.get("case_id"),
                "thread_key": thread.get("thread_key"),
                "messages": messages,
            }
        )
    return feedback


def collect_api_rs_checks(summaries: list[dict[str, Any]], failure_id: str) -> list[dict[str, Any]]:
    checks = []
    for summary in summaries:
        for check in summary.get("checks") or []:
            if str(check.get("failure_id")) != failure_id:
                continue
            checks.append({**check, "file": summary.get("_path")})
    return checks


def collect_slack_checks(summaries: list[dict[str, Any]], failure_id: str) -> list[dict[str, Any]]:
    checks = []
    for summary in summaries:
        for check in summary.get("checks") or []:
            if str(check.get("failure_id")) != failure_id:
                continue
            checks.append(
                {
                    **check,
                    "thread_key": summary.get("thread_key"),
                    "channel_id": summary.get("channel_id"),
                    "file": summary.get("_path"),
                }
            )
    return checks


def source_paths(sources: dict[str, Any]) -> dict[str, Any]:
    return {
        "fuzz_summaries": [summary.get("_path") for summary in sources["fuzz_summaries"]],
        "production_summaries": [
            summary.get("_path") for summary in sources["production_summaries"]
        ],
        "synthetic_observed": sources["synthetic_observed"].get("_path"),
        "synthetic_input": sources["synthetic_observed"].get("input"),
        "feedback_summary": sources["feedback_summary"].get("_path"),
        "db_snapshot": sources["db_snapshot"].get("_path"),
        "api_rs_checks": [check.get("_path") for check in sources["api_rs_checks"]],
        "slack_checks": [check.get("_path") for check in sources["slack_checks"]],
    }


def compact_dict(data: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in data.items() if value not in (None, "", [], {})}


def render_markdown(matrix: dict[str, Any]) -> str:
    lines = [
        "# Slackbot Regression Matrix",
        "",
        f"Generated: `{matrix['created_at']}`",
        "",
        "## Sources",
        "",
    ]
    for name, value in matrix["source_paths"].items():
        if isinstance(value, list):
            rendered = ", ".join(f"`{item}`" for item in value if item) or "_none_"
        else:
            rendered = f"`{value}`" if value else "_none_"
        lines.append(f"- `{name}`: {rendered}")

    lines.extend(
        [
            "",
            "## Failures",
            "",
            "| Priority | Failure | Repro | Evidence | Primary Test Targets |",
            "| --- | --- | --- | --- | --- |",
        ]
    )
    for entry in matrix["failures"]:
        evidence = entry["evidence"]
        counts = {
            "local": len(evidence["local_cases"]),
            "prod": len(evidence["production_seeds"]),
            "synthetic": len(evidence["synthetic_cases"]),
            "db": len(evidence["db_snapshot_cases"]),
            "feedback": len(evidence["user_feedback"]),
            "api-rs": len(evidence["api_rs_checks"]),
            "slack": len(evidence["slack_checks"]),
        }
        evidence_text = ", ".join(f"{name}:{count}" for name, count in counts.items() if count)
        if not evidence_text:
            evidence_text = "backlog only"
        targets = "<br>".join(entry["regression_targets"])
        lines.append(
            "| {priority} | `{failure_id}`<br>{summary} | `{repro_status}` | {evidence} | {targets} |".format(
                priority=entry["priority"],
                failure_id=entry["failure_id"],
                summary=escape_table(entry["summary"]),
                repro_status=entry["repro_status"],
                evidence=evidence_text,
                targets=escape_table(targets),
            )
        )

    lines.extend(["", "## Assertions", ""])
    for entry in matrix["failures"]:
        lines.append(f"### {entry['failure_id']}")
        for assertion in entry["expected_assertions"]:
            lines.append(f"- {assertion}")
        lines.append("")
    return "\n".join(lines)


def escape_table(text: str) -> str:
    return text.replace("|", "\\|")


if __name__ == "__main__":
    raise SystemExit(main())
