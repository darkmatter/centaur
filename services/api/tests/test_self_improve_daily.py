"""Unit tests for the pure helpers in workflows.self_improve_daily.

These target the pieces of the nightly self-improvement workflow that do
not require a WorkflowContext: scorecard rendering, Slack link
formatting, user-name extraction, child-result annotation, and the
slack_narrative privacy strip that runs before the implementing child
workflow ever sees the fix packet.
"""

from __future__ import annotations

from workflows.self_improve_daily import (
    SLACK_ONLY_FIX_FIELDS,
    _annotate_child_results_with_narratives,
    _attribution_suffix,
    _build_flair_digest,
    _build_scorecard_markdown,
    _classify_child_entries,
    _first_name_from_user_name,
    _is_auto_merge_safe_path,
    _merge_review_batches,
    _message_user_display,
    _render_source_thread_links,
    _selection_limit,
    _slack_pr_link,
    _slack_thread_archive_url,
    _strip_mentions,
    _strip_mentions_multiline,
    _strip_slack_only_fields,
    _validate_source_user_names,
    _validation_has_failing_check,
)


def test_slack_pr_link_uses_angle_bracket_format() -> None:
    # Slack renders `<url|text>` as a link; GitHub-style `[text](url)` is
    # surfaced as literal characters, which is the bug we saw in the
    # first rendered nightly scorecard post.
    link = _slack_pr_link(322, "https://github.com/example/centaur/pull/322")
    assert link == "<https://github.com/example/centaur/pull/322|#322>"


def test_slack_pr_link_handles_missing_pieces() -> None:
    assert _slack_pr_link("", "") == ""
    assert _slack_pr_link(322, "") == "#322"
    assert _slack_pr_link("", "https://example.test/pr") == "<https://example.test/pr>"


def test_message_user_display_prefers_user_name_then_name_then_username() -> None:
    assert (
        _message_user_display(
            {"metadata": {"user_name": "Josie", "name": "ignored", "username": "j"}}
        )
        == "Josie"
    )
    assert (
        _message_user_display(
            {"metadata": {"name": "Josie Kim", "username": "j"}}
        )
        == "Josie Kim"
    )
    assert _message_user_display({"metadata": {"username": "josie"}}) == "josie"
    assert _message_user_display({"metadata": {}}) == ""
    assert _message_user_display({}) == ""


def test_message_user_display_falls_back_to_user_id_cache() -> None:
    # The slackbot only persists `user_id` in metadata — this is the real
    # production shape. The cache resolves those IDs to Slack usernames.
    message = {"metadata": {"user_id": "U076CL29AP5"}}
    cache = {"U076CL29AP5": "arjun", "U01XYZ": "josie"}
    assert _message_user_display(message, cache) == "arjun"


def test_message_user_display_prefers_explicit_name_over_cache() -> None:
    message = {"metadata": {"user_id": "U01XYZ", "user_name": "Josie Kim"}}
    cache = {"U01XYZ": "josie"}
    assert _message_user_display(message, cache) == "Josie Kim"


def test_message_user_display_cache_miss_returns_empty() -> None:
    message = {"metadata": {"user_id": "U_UNKNOWN"}}
    cache = {"U01XYZ": "josie"}
    assert _message_user_display(message, cache) == ""
    # With no cache at all, no crash and no fake name.
    assert _message_user_display(message) == ""


def test_first_name_from_user_name_normalizes_display_and_cache_values() -> None:
    positives = {
        "Josie Kim": "Josie",
        "  Matt   Huang  ": "Matt",
        "katie.kim": "katie",
        "ricardo_ops": "ricardo",
        "Brandon/Research": "Brandon",
        "Taylor (Contractor)": "Taylor",
        "Zoe-Lou Hart": "Zoe-Lou",
    }
    for raw, expected in positives.items():
        assert _first_name_from_user_name(raw) == expected

    negatives = ["", "   ", None]
    for raw in negatives:
        assert _first_name_from_user_name(raw) == ""  # type: ignore[arg-type]


def test_validate_source_user_names_hydrates_normalizes_and_reports_gaps() -> None:
    tasks = [
        {"task_id": "t1", "source_user_id": "U1", "source_user_name": ""},
        {"task_id": "t2", "source_user_id": "U2", "source_user_name": "Josie Kim"},
        {"task_id": "t3", "source_user_id": "U3", "source_user_name": "matt.huang"},
        {"task_id": "t4", "source_user_id": "U4", "source_user_name": ""},
        {"task_id": "t5", "source_user_id": "", "source_user_name": ""},
    ]

    normalized, stats = _validate_source_user_names(
        tasks,
        user_name_by_id={
            "U1": "arjun.sharma",
            "U4": "",
        },
    )

    by_task = {task["task_id"]: task for task in normalized}
    assert by_task["t1"]["source_user_name"] == "arjun"
    assert by_task["t2"]["source_user_name"] == "Josie"
    assert by_task["t3"]["source_user_name"] == "matt"
    assert by_task["t4"]["source_user_name"] == ""
    assert by_task["t5"]["source_user_name"] == ""

    assert stats == {
        "hydrated_count": 1,
        "normalized_count": 2,
        "missing_name_count": 1,
        "unresolved_user_ids": ["U4"],
        "complete": False,
    }


def test_slack_thread_archive_url_strips_dot_from_ts() -> None:
    url = _slack_thread_archive_url("C0A82R7S80N", "1776374169.372999")
    assert url == "https://slack.com/archives/C0A82R7S80N/p1776374169372999"


def test_slack_thread_archive_url_handles_missing_pieces() -> None:
    assert _slack_thread_archive_url("", "1776374169.372999") == ""
    assert _slack_thread_archive_url("C0A82R7S80N", "") == ""
    assert _slack_thread_archive_url("", "") == ""


def test_render_source_thread_links_renders_slack_format_link_text() -> None:
    single = _render_source_thread_links(
        [{"channel": "C0A82R7S80N", "thread_ts": "1776374169.372999"}]
    )
    assert single == "<https://slack.com/archives/C0A82R7S80N/p1776374169372999|thread>"


def test_render_source_thread_links_joins_multiple_threads() -> None:
    multi = _render_source_thread_links(
        [
            {"channel": "C0A82R7S80N", "thread_ts": "1776374169.372999"},
            {"channel": "C0ASR4NFLPR", "thread_ts": "1776222625.548429"},
        ]
    )
    assert (
        multi
        == "<https://slack.com/archives/C0A82R7S80N/p1776374169372999|thread>, "
        "<https://slack.com/archives/C0ASR4NFLPR/p1776222625548429|thread>"
    )


def test_render_source_thread_links_skips_entries_missing_channel_or_ts() -> None:
    # Defense in depth: a malformed entry should not leak `|thread>` with an
    # empty URL into the Slack post.
    partial = _render_source_thread_links(
        [
            {"channel": "C0A82R7S80N"},
            {"thread_ts": "1776374169.372999"},
            {"channel": "C0A82R7S80N", "thread_ts": "1776374169.372999"},
        ]
    )
    assert partial == "<https://slack.com/archives/C0A82R7S80N/p1776374169372999|thread>"


def test_render_source_thread_links_empty_returns_empty_string() -> None:
    assert _render_source_thread_links([]) == ""
    assert _render_source_thread_links(None) == ""


def test_strip_slack_only_fields_removes_narrative_but_keeps_rest() -> None:
    packet = {
        "title": "Tighten verification reminder",
        "fix_type": "prompt_tweak",
        "target_surface": "tools/personas/eng/PROMPT.md",
        "what_to_change": "Add lint check reminder.",
        "slack_narrative": "Josie hit this on Tuesday.",
    }

    stripped = _strip_slack_only_fields(packet)

    assert "slack_narrative" not in stripped
    for field in SLACK_ONLY_FIX_FIELDS:
        assert field not in stripped
    assert stripped["title"] == "Tighten verification reminder"
    # Input must not be mutated — callers still need the narrative for Slack.
    assert packet["slack_narrative"] == "Josie hit this on Tuesday."


def test_annotate_child_results_with_narratives_pairs_by_position() -> None:
    selected_fixes = [
        {
            "title": "Tighten verification reminder",
            "fix_type": "prompt_tweak",
            "dominant_failure_mode": "verification_miss",
            "slack_narrative": "Josie hit the lint gap Tuesday; Matt Thursday.",
            "source_threads": [
                {
                    "thread_key": "C0A82R7S80N:1776374169.372999",
                    "channel": "C0A82R7S80N",
                    "thread_ts": "1776374169.372999",
                }
            ],
        },
        {
            "title": "Add triage-first guidance",
            "fix_type": "workflow_fix",
            "dominant_failure_mode": "intent_miss",
            "slack_narrative": "Asher asked why morning-brief never posted.",
        },
    ]
    child_results = [
        {"pr_number": 42, "pr_url": "https://example.test/pr/42", "title": "Add lint check"},
        {"error": "child workflow timed out", "child_run_id": "wfr_abc"},
    ]

    annotated = _annotate_child_results_with_narratives(
        child_results=child_results,
        selected_fixes=selected_fixes,
    )

    assert annotated[0]["slack_narrative"].startswith("Josie hit the lint")
    assert annotated[0]["fix_type"] == "prompt_tweak"
    assert annotated[0]["dominant_failure_mode"] == "verification_miss"
    # Source threads must travel with the narrative so the scorecard can
    # render clickable `thread` links under each opened PR.
    assert annotated[0]["source_threads"][0]["channel"] == "C0A82R7S80N"
    # Title that already exists on the child result must win over the
    # upstream fix title (the child's PR title is what shipped).
    assert annotated[0]["title"] == "Add lint check"
    assert annotated[1]["slack_narrative"].startswith("Asher asked")
    # Missing PR data still gets paired with its narrative so the
    # failure line in the scorecard can explain what we were trying.
    assert annotated[1]["error"] == "child workflow timed out"


def test_annotate_child_results_tolerates_length_mismatch() -> None:
    # Reality: one of the kids failed to start and never produced an
    # output_json. The annotator must not crash and must leave the
    # fixes-we-actually-have alone.
    annotated = _annotate_child_results_with_narratives(
        child_results=[
            {"pr_number": 1, "pr_url": "https://x.test/1"},
            {"pr_number": 2, "pr_url": "https://x.test/2"},
            {"error": "bad"},
        ],
        selected_fixes=[
            {"title": "Fix A", "slack_narrative": "A narrative."},
        ],
    )

    assert annotated[0]["slack_narrative"] == "A narrative."
    assert "slack_narrative" not in annotated[1]
    assert "slack_narrative" not in annotated[2]


def test_selection_limit_uses_all_available_when_requested_is_zero() -> None:
    assert _selection_limit(0, 7) == 7
    assert _selection_limit(-1, 7) == 7
    assert _selection_limit(3, 7) == 3


def test_merge_review_batches_aggregates_counts_and_failure_modes() -> None:
    merged = _merge_review_batches(
        [
            {
                "below_bar_count": 1,
                "task_reviews": [
                    {"task_id": "t1", "overall": "below_bar"},
                    {"task_id": "t2", "overall": "above_bar"},
                ],
                "top_failure_modes": [
                    {
                        "failure_mode": "verification_miss",
                        "count": 1,
                        "representative_threads": ["C1:1"],
                    }
                ],
                "selected_fixes": [{"title": "Fix A"}],
            },
            {
                "below_bar_count": 2,
                "task_reviews": [
                    {"task_id": "t3", "overall": "below_bar"},
                ],
                "top_failure_modes": [
                    {
                        "failure_mode": "verification_miss",
                        "count": 2,
                        "representative_threads": ["C1:1", "C2:2"],
                    },
                    {
                        "failure_mode": "intent_miss",
                        "count": 1,
                        "representative_threads": ["C3:3"],
                    },
                ],
                "selected_fixes": [{"title": "Fix B"}],
            },
        ],
        tasks_reviewed=3,
    )

    assert merged["below_bar_count"] == 3
    assert merged["below_bar_rate"] == 1.0
    assert [task["task_id"] for task in merged["task_reviews"]] == ["t1", "t2", "t3"]
    assert [fix["title"] for fix in merged["selected_fixes"]] == ["Fix A", "Fix B"]
    assert merged["top_failure_modes"][0]["failure_mode"] == "verification_miss"
    assert merged["top_failure_modes"][0]["count"] == 3
    assert merged["top_failure_modes"][0]["representative_threads"] == ["C1:1", "C2:2"]


def _scorecard_review_fixture() -> dict:
    return {
        "tasks_reviewed": 8,
        "below_bar_count": 3,
        "below_bar_rate": 0.375,
        "task_reviews": [
            {"composite_score": 82},
            {"composite_score": 60},
            {"composite_score": 55},
        ],
        "top_failure_modes": [
            {"failure_mode": "verification_miss", "count": 3},
            {"failure_mode": "intent_miss", "count": 2},
        ],
        "selected_fixes": [
            {
                "title": "Tighten verification reminder",
                "fix_type": "prompt_tweak",
                "slack_narrative": (
                    "Arjun's code-change task shipped without lint and a teammate "
                    "hit the same gap later, so code-change tasks keep bypassing "
                    "ruff."
                ),
                "source_threads": [
                    {
                        "thread_key": "C111111:1700100000.000000",
                        "channel": "C111111",
                        "thread_ts": "1700100000.000000",
                    }
                ],
            },
            {
                "title": "Add triage-first workflow guidance",
                "fix_type": "workflow_fix",
                "slack_narrative": (
                    "A teammate asked why the morning-brief workflow never posted and the "
                    "agent proposed a redesign instead of checking logs."
                ),
                "source_threads": [
                    {
                        "thread_key": "C222222:1700200000.000000",
                        "channel": "C222222",
                        "thread_ts": "1700200000.000000",
                    }
                ],
            },
        ],
    }


def _scorecard_synthesis_fixture() -> dict:
    return {
        "opportunities_found": 2,
        "opportunities": [
            {
                "opportunity_type": "new_persona",
                "title": "Editorial persona for decision memos",
            },
            {
                "opportunity_type": "new_workflow_idea",
                "title": "Guided bootstrap for policy-news monitors",
            },
        ],
        "selected_builds": [
            {
                "opportunity_type": "new_persona",
                "title": "Editorial persona for decision memos",
                "slack_narrative": (
                    "Arjun and another teammate both asked for crisper decision memos "
                    "last week; no existing persona covers that stance."
                ),
                "source_threads": [
                    {
                        "thread_key": "C333333:1700300000.000000",
                        "channel": "C333333",
                        "thread_ts": "1700300000.000000",
                    },
                    {
                        "thread_key": "C444444:1700400000.000000",
                        "channel": "C444444",
                        "thread_ts": "1700400000.000000",
                    },
                ],
            },
        ],
    }


def test_build_scorecard_markdown_has_clean_indentation() -> None:
    # Regression guard for the first rendered nightly: textwrap.dedent
    # with multi-line f-string substitutions lost its common prefix on
    # continuation lines and left an 8-space indent on top-level
    # lines. Every line must start at column 0 (top-level) or column 2
    # (sub-bullet).
    child_results = [
        {
            "pr_number": 322,
            "pr_url": "https://github.com/example/centaur/pull/322",
            "title": "Tighten verification",
            "why_now": "Code-change tasks keep bypassing ruff.",
            "fix_type": "prompt_tweak",
        },
    ]

    md = _build_scorecard_markdown(
        review=_scorecard_review_fixture(),
        synthesis=_scorecard_synthesis_fixture(),
        child_results=child_results,
        merged_prs_24h=1,
    )

    for line in md.splitlines():
        if not line.strip():
            continue
        leading_spaces = len(line) - len(line.lstrip(" "))
        assert leading_spaces in {0, 2}, (
            f"unexpected leading whitespace ({leading_spaces} spaces) on line: {line!r}"
        )


def test_build_scorecard_markdown_uses_slack_link_format_not_markdown_link() -> None:
    md = _build_scorecard_markdown(
        review={"tasks_reviewed": 0, "selected_fixes": []},
        synthesis={"opportunities": [], "selected_builds": []},
        child_results=[
            {
                "pr_number": 322,
                "pr_url": "https://github.com/example/centaur/pull/322",
                "title": "Tighten verification",
                "why_now": "Code-change tasks were bypassing ruff.",
            }
        ],
    )

    assert "<https://github.com/example/centaur/pull/322|#322>" in md
    # GitHub-style markdown would be the bug. Make sure it is truly gone.
    assert "[#322]" not in md
    assert "](https://github.com" not in md


def test_build_scorecard_markdown_emits_italic_summary_at_top() -> None:
    # Last night's post buried the reviewed/below-bar stats at the
    # bottom; the new layout merges them into a single italic line
    # directly under the section header.
    md = _build_scorecard_markdown(
        review={
            "tasks_reviewed": 20,
            "below_bar_count": 6,
            "selected_fixes": [],
        },
        synthesis={"selected_builds": []},
        child_results=[],
        coverage={"reconstructed_thread_count": 7},
        merged_prs_24h=3,
    )

    lines = md.splitlines()
    assert lines[0] == "*Nightly gap analysis*"
    assert lines[1].startswith("_") and lines[1].endswith("_"), (
        f"summary must be italic: {lines[1]!r}"
    )
    assert "Reviewed 20 tasks across 7 threads" in lines[1]
    assert "6 below the bar" in lines[1]
    assert "3 self-improve PRs merged in the last 24h" in lines[1]


def test_build_scorecard_markdown_uses_polished_body_over_raw_field() -> None:
    # The polish LLM writes the final bullet body; the renderer must
    # use that verbatim instead of the raw framing field. This is the
    # core of the shift away from heuristic first-sentence / clip
    # truncation that was cutting asks off mid-word.
    md = _build_scorecard_markdown(
        review={
            "tasks_reviewed": 3,
            "below_bar_count": 0,
            "selected_fixes": [
                {
                    "title": "Tighten verification",
                    "why_now": "Raw framing text that should not appear.",
                }
            ],
        },
        synthesis={"selected_builds": []},
        child_results=[],
        polished_bodies={
            "gap-0": "Centaur keeps skipping ruff on code-change tasks; the prompt should require it."
        },
    )

    assert "Centaur keeps skipping ruff on code-change tasks" in md
    # Raw field does NOT leak into the bullet when a polished body wins.
    assert "Raw framing text that should not appear" not in md


def test_build_scorecard_markdown_separates_shipped_from_in_review() -> None:
    # Auto-merged PRs land under *Shipped tonight*; the rest land under
    # *In review*. Child errors and the old source-threads-notified /
    # PRs-merged-last-24h bullets are gone entirely.
    child_results = [
        {
            "pr_number": 333,
            "pr_url": "https://github.com/example/centaur/pull/333",
            "title": "Market Exposure Screen",
            "fix_type": "new_skill",
            "why_now": "Portfolio reviews happen daily.",
            "auto_merge_status": "merged",
        },
        {
            "pr_number": 331,
            "pr_url": "https://github.com/example/centaur/pull/331",
            "title": "Runtime control hardening",
            "fix_type": "bug_fix",
            "why_now": "Control plane had a race.",
            "auto_merge_status": "skipped_by_policy",
        },
        {"error": "child workflow timed out", "child_run_id": "wfr_abc"},
    ]

    md = _build_scorecard_markdown(
        review={"tasks_reviewed": 5, "below_bar_count": 1, "selected_fixes": []},
        synthesis={"selected_builds": []},
        child_results=child_results,
    )

    assert "*Shipped tonight*" in md
    assert "*In review*" in md
    shipped_section = md.split("*Shipped tonight*", 1)[1].split("*In review*", 1)[0]
    in_review_section = md.split("*In review*", 1)[1]

    assert "Market Exposure Screen" in shipped_section
    assert "<https://github.com/example/centaur/pull/333|#333>" in shipped_section
    assert "Market Exposure Screen" not in in_review_section
    assert "Runtime control hardening" in in_review_section
    assert "<https://github.com/example/centaur/pull/331|#331>" in in_review_section

    # Removed bullets must stay gone.
    assert "Child workflow errors" not in md
    assert "child workflow timed out" not in md
    assert "Source threads notified" not in md
    assert "PRs merged in last 24h" not in md
    assert "PRs deployed in last 24h" not in md


def test_build_scorecard_markdown_handles_empty_state() -> None:
    md = _build_scorecard_markdown(
        review={"tasks_reviewed": 0, "selected_fixes": []},
        synthesis={"opportunities": [], "selected_builds": []},
        child_results=[],
    )

    # Empty runs still produce a postable message — summary and flair
    # at minimum. Sections with nothing to show are simply omitted
    # rather than padded with "none selected" bullets.
    assert md.startswith("*Nightly gap analysis*")
    lines = md.splitlines()
    assert lines[1].startswith("_") and lines[1].endswith("_")
    assert "none selected" not in md
    assert "none opened" not in md


def test_build_scorecard_markdown_renders_thread_links_in_all_sections() -> None:
    # Every gap fix / growth build that carries source_threads renders
    # a clickable `· <url|thread>` suffix. Shipped / in-review entries
    # use the PR link instead (tested separately).
    md = _build_scorecard_markdown(
        review=_scorecard_review_fixture(),
        synthesis=_scorecard_synthesis_fixture(),
        child_results=[],
    )

    assert "<https://slack.com/archives/C111111/p1700100000000000|thread>" in md
    assert "<https://slack.com/archives/C222222/p1700200000000000|thread>" in md
    assert "<https://slack.com/archives/C333333/p1700300000000000|thread>" in md
    assert "<https://slack.com/archives/C444444/p1700400000000000|thread>" in md


def test_build_scorecard_markdown_never_emits_github_thread_link_syntax() -> None:
    md = _build_scorecard_markdown(
        review=_scorecard_review_fixture(),
        synthesis=_scorecard_synthesis_fixture(),
        child_results=[],
    )

    # Guard against regressing into `[thread](https://slack.com/...)` form,
    # which Slack renders as literal text.
    assert "[thread](https://slack.com" not in md
    assert "](https://slack.com" not in md


def test_build_scorecard_markdown_never_emits_raw_slack_mentions() -> None:
    # Safety net: even if a polished body or credit_line slips a raw
    # `<@UXXXX>` through, the final multi-line mention strip
    # guarantees the public post never leaks a Slack user ID.
    md = _build_scorecard_markdown(
        review={
            "tasks_reviewed": 1,
            "below_bar_count": 0,
            "selected_fixes": [
                {
                    "title": "Tighten verification",
                    "why_now": "When <@U12345> noticed the ruff gap this mattered.",
                    "credit_line": "nice spot from <@U12345>",
                    "source_threads": [],
                }
            ],
        },
        synthesis={"selected_builds": []},
        child_results=[],
        polished_bodies={
            "gap-0": "Centaur kept skipping ruff when <@U12345> kicked off code-change tasks."
        },
    )

    assert "<@U" not in md


# ────────────────────────────────────────────────────────────────────────
# Auto-merge gate — CRITICAL correctness. A false-positive here would
# squash-merge a platform PR without human review, which is the single
# biggest blast-radius risk on this branch. Tests intentionally exercise
# both the "obviously safe" cases and neighboring paths that look
# similar but are NOT safe.
# ────────────────────────────────────────────────────────────────────────


def test_is_auto_merge_safe_path_accepts_skills() -> None:
    # Skills: anywhere under .agents/skills/** is allowed (SKILL.md,
    # references/*, examples/*, anything the agent authored).
    assert _is_auto_merge_safe_path(".agents/skills/portfolio-market-overlay/SKILL.md") is True
    assert _is_auto_merge_safe_path(".agents/skills/people-landscape/references/rubric.md") is True
    assert _is_auto_merge_safe_path(".agents/skills/deep/nested/path/file.md") is True


def test_is_auto_merge_safe_path_accepts_persona_prompts_and_pyprojects() -> None:
    # Personas: only PROMPT.md and pyproject.toml — NOT the persona's
    # runner.py or other code files. This is the highest-leverage guard.
    assert _is_auto_merge_safe_path("tools/personas/eng/PROMPT.md") is True
    assert _is_auto_merge_safe_path("tools/personas/eng/pyproject.toml") is True
    # Persona runner code is NOT safe.
    assert _is_auto_merge_safe_path("tools/personas/eng/runner.py") is False
    assert _is_auto_merge_safe_path("tools/personas/eng/__init__.py") is False
    assert _is_auto_merge_safe_path("tools/personas/eng/tools.py") is False


def test_is_auto_merge_safe_path_accepts_sandbox_system_prompts_only() -> None:
    # Sandbox prompts — SYSTEM_PROMPT*.md files are safe. Arbitrary code
    # under services/sandbox/ is NOT safe.
    assert _is_auto_merge_safe_path("services/sandbox/SYSTEM_PROMPT.md") is True
    assert _is_auto_merge_safe_path("services/sandbox/SYSTEM_PROMPT_ENG.md") is True
    # Code files under services/sandbox/ must NEVER auto-merge.
    assert _is_auto_merge_safe_path("services/sandbox/amp-wrapper.py") is False
    assert _is_auto_merge_safe_path("services/sandbox/Dockerfile") is False


def test_is_auto_merge_safe_path_rejects_platform_and_infra() -> None:
    # Explicit "never auto-merge" cases. These are the paths that, if
    # auto-merged, could break the system end-to-end.
    assert _is_auto_merge_safe_path("services/api/api/runtime_control.py") is False
    assert _is_auto_merge_safe_path("services/api/api/agent.py") is False
    assert _is_auto_merge_safe_path("tools/crypto/alchemy/client.py") is False
    assert _is_auto_merge_safe_path("workflows/self_improve_daily.py") is False
    assert _is_auto_merge_safe_path("workflows/agent_loop.py") is False
    assert _is_auto_merge_safe_path(".github/workflows/deploy.yml") is False
    assert _is_auto_merge_safe_path("contrib/chart/templates/workloads.yaml") is False
    assert _is_auto_merge_safe_path("db/migrations/001_init.sql") is False


def test_is_auto_merge_safe_path_rejects_malformed_input() -> None:
    # Defensive: empty paths, whitespace-only, None → NOT safe. We err
    # on the "leave the PR open" side rather than merging something we
    # can't classify.
    assert _is_auto_merge_safe_path("") is False
    assert _is_auto_merge_safe_path("   ") is False


def test_validation_has_failing_check_detects_passed_false() -> None:
    assert _validation_has_failing_check(
        {"checks": [{"command": "ruff", "passed": False}]}
    )
    assert not _validation_has_failing_check(
        {"checks": [{"command": "ruff", "passed": True}]}
    )


def test_validation_has_failing_check_detects_status_shapes() -> None:
    # The child agent's JSON is free-form so we defensively handle
    # multiple "failed" encodings.
    assert _validation_has_failing_check({"checks": [{"status": "fail"}]})
    assert _validation_has_failing_check({"checks": [{"status": "failed"}]})
    assert _validation_has_failing_check({"checks": [{"status": "error"}]})
    assert _validation_has_failing_check({"checks": [{"result": "error"}]})
    assert _validation_has_failing_check({"checks": [{"ok": False}]})
    assert _validation_has_failing_check({"checks": [{"success": False}]})


def test_validation_has_failing_check_returns_false_on_missing_or_malformed() -> None:
    # Missing evidence ≠ evidence of failure. A well-formed "all pass"
    # validation or missing validation both pass this gate (other gate
    # checks still have to pass before merge).
    assert not _validation_has_failing_check({"checks": []})
    assert not _validation_has_failing_check({"checks": None})
    assert not _validation_has_failing_check({})
    assert not _validation_has_failing_check(None)
    assert not _validation_has_failing_check(
        {"checks": [{"passed": True}, {"status": "ok"}, {"success": True}]}
    )


def test_classify_child_entries_splits_by_auto_merge_status() -> None:
    # Only entries explicitly marked "merged" land in Shipped. Everything
    # else with a PR goes to In review. Errors are dropped entirely.
    shipped, in_review = _classify_child_entries(
        [
            {
                "pr_number": 1,
                "pr_url": "https://x.test/1",
                "auto_merge_status": "merged",
            },
            {
                "pr_number": 2,
                "pr_url": "https://x.test/2",
                "auto_merge_status": "skipped_by_policy",
            },
            {
                "pr_number": 3,
                "pr_url": "https://x.test/3",
                "auto_merge_status": "failed",
            },
            {
                "pr_number": 4,
                "pr_url": "https://x.test/4",
                # No auto_merge_status at all (defensive) → in_review.
            },
            {"error": "child workflow timed out", "child_run_id": "wfr_abc"},
            None,  # type: ignore[list-item]
            "not-a-dict",  # type: ignore[list-item]
        ]
    )

    assert [entry["pr_number"] for entry in shipped] == [1]
    assert [entry["pr_number"] for entry in in_review] == [2, 3, 4]


# ────────────────────────────────────────────────────────────────────────
# Mention stripping — keeps raw Slack IDs out of public posts.
# ────────────────────────────────────────────────────────────────────────


def test_strip_mentions_removes_slack_id_patterns() -> None:
    assert _strip_mentions("hello <@U12345> world") == "hello world"
    assert _strip_mentions("<@U12345> first") == "first"
    assert _strip_mentions("last <@U12345>") == "last"
    assert _strip_mentions("no mentions") == "no mentions"
    assert _strip_mentions("") == ""
    assert _strip_mentions(None) == ""  # type: ignore[arg-type]


def test_strip_mentions_collapses_residual_double_space_on_single_line() -> None:
    # Mid-sentence mention leaves a "  " gap; single-line strip collapses.
    assert _strip_mentions("good catch from <@U12345> on this") == "good catch from on this"


def test_strip_mentions_multiline_preserves_bullet_indentation() -> None:
    # The final scorecard pass uses the multi-line variant so sub-bullet
    # indentation and blank separators survive. A regression here would
    # flatten the whole scorecard to one column.
    original = "*Title*\n• top bullet\n  • sub bullet one\n  • sub bullet two"
    assert _strip_mentions_multiline(original) == original
    # And still strips mentions.
    with_mention = "• bullet with <@U12345> mention\n  • clean sub"
    assert _strip_mentions_multiline(with_mention) == "• bullet with  mention\n  • clean sub"


# ────────────────────────────────────────────────────────────────────────
# Attribution — never "anonymous", never raw IDs.
# ────────────────────────────────────────────────────────────────────────


def test_attribution_suffix_prefers_credit_line() -> None:
    suffix = _attribution_suffix(
        {"credit_line": "good catch from Katie", "source_threads": []}, {},
    )
    assert suffix == " · good catch from Katie"


def test_attribution_suffix_strips_mention_from_credit_line() -> None:
    # Even if the LLM slipped a mention into credit_line, the suffix
    # never leaks it into the post.
    suffix = _attribution_suffix(
        {"credit_line": "good catch from <@U12345>", "source_threads": []}, {},
    )
    assert "<@U" not in suffix


def test_attribution_suffix_falls_back_to_plain_name() -> None:
    suffix = _attribution_suffix(
        {
            "source_threads": [
                {"thread_key": "C1:100.000", "channel": "C1", "thread_ts": "100.000"}
            ]
        },
        {"C1:100.000": "Arjun"},
    )
    assert suffix == " · from Arjun"


def test_attribution_suffix_returns_empty_when_name_unknown() -> None:
    # Never "anonymous", never "a user" — attribution is simply omitted.
    assert _attribution_suffix({"source_threads": []}, {}) == ""
    assert (
        _attribution_suffix(
            {
                "source_threads": [
                    {"thread_key": "C1:100.000", "channel": "C1", "thread_ts": "100.000"}
                ]
            },
            {},  # no name in the map
        )
        == ""
    )


# ────────────────────────────────────────────────────────────────────────
# Flair digest — the input the polish LLM uses to anchor the opener.
# ────────────────────────────────────────────────────────────────────────


def test_build_flair_digest_dedupes_by_thread_and_caps_items() -> None:
    # One entry per unique thread so a chatty single thread can't
    # dominate the signal. Cap at limit so the prompt stays small.
    digest = _build_flair_digest(
        [
            {
                "thread_key": "C1:100.000",
                "source_user_name": "Katie",
                "ask_text": "First ask in thread A",
                "status": "completed",
            },
            {
                "thread_key": "C1:100.000",  # same thread → deduped
                "source_user_name": "Katie",
                "ask_text": "Follow-up in thread A",
                "status": "completed",
            },
            {
                "thread_key": "C2:200.000",
                "source_user_name": "Matt",
                "ask_text": "Thread B",
                "status": "failed",
            },
            {
                "thread_key": "",  # no thread_key → kept (can't dedupe)
                "source_user_name": "Arjun",
                "ask_text": "Thread C",
                "status": "completed",
            },
            {
                # Malformed / missing ask → skipped.
                "thread_key": "C3:300.000",
                "source_user_name": "Georgios",
                "ask_text": "",
                "status": "completed",
            },
        ],
        limit=10,
    )

    assert [item["user"] for item in digest] == ["Katie", "Matt", "Arjun"]
    assert [item["outcome"] for item in digest] == ["completed", "failed", "completed"]


def test_build_flair_digest_clips_long_asks_and_strips_mentions() -> None:
    long_ask = "Long ask " * 50  # ~500 chars
    digest = _build_flair_digest(
        [
            {
                "thread_key": "C1:100.000",
                "source_user_name": "Katie",
                "ask_text": long_ask,
                "status": "completed",
            },
            {
                "thread_key": "C2:200.000",
                "source_user_name": "Matt",
                "ask_text": "hey <@U12345> can you help here",
                "status": "completed",
            },
        ]
    )

    assert len(digest[0]["ask"]) <= 160
    assert "<@U" not in digest[1]["ask"]


def test_build_flair_digest_handles_empty_input() -> None:
    assert _build_flair_digest([]) == []
    # Also handles non-dict entries defensively.
    assert _build_flair_digest([None, "not-a-dict", 42]) == []  # type: ignore[list-item]


# ────────────────────────────────────────────────────────────────────────
# Defensive: scorecard must never crash on malformed upstream data —
# the nightly post MUST go out even when an earlier step returned
# something weird. Regression guard for the six failure shapes we hit
# during the stress-test pass on this branch.
# ────────────────────────────────────────────────────────────────────────


def test_build_scorecard_markdown_survives_none_arguments() -> None:
    md = _build_scorecard_markdown(
        review=None,  # type: ignore[arg-type]
        synthesis=None,  # type: ignore[arg-type]
        child_results=None,  # type: ignore[arg-type]
    )
    assert md.startswith("*Nightly gap analysis*")


def test_build_scorecard_markdown_survives_wrong_types() -> None:
    md = _build_scorecard_markdown(
        review=[],  # type: ignore[arg-type]
        synthesis=42,  # type: ignore[arg-type]
        child_results="nope",  # type: ignore[arg-type]
        coverage="bad",  # type: ignore[arg-type]
        thread_user_names=42,  # type: ignore[arg-type]
        polished_bodies=None,
    )
    assert md.startswith("*Nightly gap analysis*")


def test_build_scorecard_markdown_survives_non_dict_list_items() -> None:
    # If the LLM returns selected_fixes with non-dict entries mixed in,
    # we skip them rather than crash.
    md = _build_scorecard_markdown(
        review={
            "tasks_reviewed": 3,
            "selected_fixes": [
                "not-a-dict",  # type: ignore[list-item]
                None,  # type: ignore[list-item]
                {"title": "real one", "why_now": "because"},
            ],
        },
        synthesis={"selected_builds": [42, None]},  # type: ignore[list-item]
        child_results=[
            None,  # type: ignore[list-item]
            "nope",  # type: ignore[list-item]
            {"pr_number": 1, "pr_url": "https://x.test", "title": "ok"},
        ],
    )
    assert "real one" in md
    assert "https://x.test" in md


def test_build_scorecard_markdown_survives_null_source_threads() -> None:
    # A fix where source_threads is None (not just missing) used to
    # blow up the render path; confirm it degrades cleanly.
    md = _build_scorecard_markdown(
        review={
            "tasks_reviewed": 1,
            "selected_fixes": [{"title": "x", "source_threads": None}],
        },
        synthesis={"selected_builds": []},
        child_results=[],
    )
    assert "*Nightly gap analysis*" in md


def test_build_scorecard_markdown_survives_garbage_polished_bodies() -> None:
    # If upstream polish returned a non-dict in the bodies field, we
    # silently fall back to raw-field-derived bodies rather than
    # crashing.
    md = _build_scorecard_markdown(
        review={
            "tasks_reviewed": 5,
            "selected_fixes": [{"title": "t", "why_now": "w"}],
        },
        synthesis={"selected_builds": []},
        child_results=[],
        polished_bodies="not-a-dict",  # type: ignore[arg-type]
    )
    assert "*Nightly gap analysis*" in md
    # Raw why_now should appear via fallback.
    assert "w" in md
