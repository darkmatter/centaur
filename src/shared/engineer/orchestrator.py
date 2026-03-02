from __future__ import annotations

import asyncio
import re
import time
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any, Literal, cast

import structlog

from shared.engineer.agent_loop import (
    AgentLoopError,
    AgentLoopResult,
    EventCallback,
    run_agent_loop,
)
from shared.engineer.git_ops import (
    GitOperationError,
    cleanup_worktree,
    commit_all,
    create_worktree,
    get_diff,
    has_changes,
    push_branch,
    slugify,
)
from shared.engineer.github_pr import GitHubPRError, create_pull_request
from shared.engineer.harness_loop import run_harness_phase
from shared.engineer.loop_guards import LoopGuardState
from shared.engineer.models import EngineerResult, Phase
from shared.engineer.prompts import (
    clarifier_prompt,
    engineer_prompt,
    load_repo_guidance,
    planner_prompt,
    researcher_prompt,
    reviewer_prompt,
)
from shared.engineer.session import EngineerSession
from shared.engineer.settings import EngineerSettings, engineer_settings
from shared.engineer.tools import ENGINEER_TOOLS, RESEARCH_TOOLS, ToolExecutor
from shared.engineer.validation_gate import run_validation

log = structlog.get_logger()

MessageCallback = Callable[[str], Awaitable[None]]
PhaseCallback = Callable[[Phase, str], Awaitable[None]]
WaitingCallback = Callable[[bool], Awaitable[None]]
_REVIEW_DIFF_MAX_CHARS = 80000
_FEEDBACK_MAX_CHARS = 12000
_REVIEW_DIFF_EXCLUDED_FILENAMES = {
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "uv.lock",
    "Cargo.lock",
    "poetry.lock",
    "Pipfile.lock",
}
BudgetMode = Literal["simple", "auto", "complex"]
_LANE_LABELS: dict[BudgetMode, str] = {
    "simple": "fast",
    "auto": "adaptive",
    "complex": "deep",
}


async def _noop(_: str) -> None:
    return


async def _noop_phase(_phase: Phase, _label: str) -> None:
    return


async def _noop_waiting(_waiting: bool) -> None:
    return


async def _noop_event(_event: dict[str, Any]) -> None:
    return


def _truncate_middle(text: str, max_chars: int, label: str) -> str:
    if len(text) <= max_chars:
        return text
    half = max_chars // 2
    return (
        f"{text[:half]}\n\n"
        f"... [{label} truncated, total {len(text)} chars] ...\n\n"
        f"{text[-half:]}"
    )


def _is_excluded_review_file(path: str) -> bool:
    filename = path.rsplit("/", 1)[-1]
    return filename in _REVIEW_DIFF_EXCLUDED_FILENAMES


def _prepare_review_diff(diff_text: str) -> str:
    sections = re.split(r"(?=^diff --git )", diff_text, flags=re.MULTILINE)
    kept_sections: list[str] = []
    excluded_count = 0
    for section in sections:
        chunk = section.strip()
        if not chunk:
            continue
        first_line = chunk.splitlines()[0]
        match = re.match(r"diff --git a/(.+?) b/(.+)$", first_line)
        path = match.group(2) if match else ""
        if path and _is_excluded_review_file(path):
            excluded_count += 1
            continue
        kept_sections.append(chunk)

    prepared = "\n\n".join(kept_sections).strip()
    if excluded_count:
        note = (
            f"# Review note\nExcluded {excluded_count} generated/lockfile diff section(s) "
            "from review context to keep prompt size bounded.\n\n"
        )
        prepared = note + (prepared or "(No non-generated diff sections remain.)")
    if not prepared:
        prepared = diff_text
    return _truncate_middle(prepared, _REVIEW_DIFF_MAX_CHARS, "review diff")


class EngineerOrchestrator:
    def __init__(
        self,
        *,
        settings: EngineerSettings | None = None,
        dry_run: bool = False,
        skip_clarify: bool = False,
        model_preference: str | None = None,
    ) -> None:
        self.settings = settings or engineer_settings
        self.repo_root = Path(__file__).resolve().parents[3]
        self.dry_run = dry_run
        self.skip_clarify = skip_clarify
        self.model_preference = model_preference

    async def _generate_thread_name(self, task: str, model: str) -> str | None:
        """Quick single-shot call to name the thread from the task description."""
        try:
            from anthropic import AsyncAnthropic

            client = AsyncAnthropic(api_key=self.settings.anthropic_api_key)
            response = await asyncio.wait_for(
                client.messages.create(
                    model=model,
                    max_tokens=30,
                    system=(
                        "Write a short human-readable title (3-6 words) for this coding task. "
                        "Use sentence case, no period. "
                        "Examples: 'Add user authentication', 'Fix retry logic in Slack bot', "
                        "'Refactor database queries', 'Update thread viewer UI'. "
                        "Reply with ONLY the title, nothing else."
                    ),
                    messages=[{"role": "user", "content": task}],
                ),
                timeout=8.0,
            )
            name = ""
            for block in response.content:
                if getattr(block, "type", "") == "text":
                    name += getattr(block, "text", "")
            name = name.strip().strip('"').strip("'").rstrip(".")[:60]
            return name if name else None
        except Exception:
            log.debug("thread_name_generation_failed", task=task[:60])
            return None

    def _effective_model(self, session: EngineerSession) -> str:
        preference = (session.model_preference or self.model_preference or "").strip().lower()
        if preference in {"claude", "claude-code"}:
            return self.settings.anthropic_model
        if preference in {"amp", "codex", "pi-mono"}:
            return preference
        if preference in {"fallback", "use-fallback"}:
            return self.settings.anthropic_model_fallback
        if preference.startswith("claude-"):
            return preference
        return self.settings.anthropic_model

    def _preference_hint(self, session: EngineerSession) -> str:
        preference = (session.model_preference or self.model_preference or "").strip()
        if not preference:
            return ""
        return f"\nOperator model preference: {preference}"

    @staticmethod
    def _is_harness_model(model: str) -> bool:
        return model in {"amp", "codex", "pi-mono"}

    def _phase_guard(self, *, max_turns: int | None = None) -> LoopGuardState:
        requested_turns = max_turns or self.settings.max_turns_per_phase
        return LoopGuardState(
            max_turns=requested_turns,
            max_tool_calls_total=self.settings.max_tool_calls_total,
            max_wall_time_seconds=self.settings.max_wall_time_seconds,
            max_consecutive_tool_failures=self.settings.max_consecutive_tool_failures,
        )

    @staticmethod
    def _clamp(value: int, lower: int, upper: int) -> int:
        return max(lower, min(value, upper))

    @staticmethod
    def _task_complexity_score(
        task: str, research_brief: str | None = None, plan: str | None = None
    ) -> int:
        score = 0
        task_lower = task.lower()
        if len(task) > 300:
            score += 2
        elif len(task) > 120:
            score += 1
        complexity_markers = (
            "refactor",
            "migrate",
            "architecture",
            "parallel",
            "performance",
            "multi",
            "api",
            "database",
            "slack",
            "integration",
            "auth",
        )
        score += sum(1 for marker in complexity_markers if marker in task_lower)
        if research_brief:
            research_lower = research_brief.lower()
            if research_brief.count("## ") >= 4:
                score += 1
            if any(token in research_lower for token in ("complex", "cross-cutting", "multiple systems")):
                score += 1
        if plan:
            plan_lower = plan.lower()
            bullets = plan.count("\n- ") + plan.count("\n1.")
            if bullets >= 5:
                score += 1
            if any(token in plan_lower for token in ("phased", "incremental", "rollout")):
                score += 1
        return score

    def _compute_turn_budgets(self, complexity_score: float) -> dict[str, int]:
        if not self.settings.adaptive_turn_budgets_enabled:
            fixed = self.settings.max_turns_per_phase
            return {"research": fixed, "plan": 4, "implement": fixed, "review": 12}

        scale = max(1, self.settings.turn_budget_score_full_scale)
        ratio = min(max(complexity_score, 0.0) / float(scale), 1.0)

        def _interp(floor: int, cap: int) -> int:
            return self._clamp(round(floor + (cap - floor) * ratio), floor, cap)

        research_cap = min(self.settings.turn_budget_research_cap, self.settings.research_max_turns)
        return {
            "research": _interp(self.settings.turn_budget_research_floor, research_cap),
            "plan": _interp(self.settings.turn_budget_plan_floor, self.settings.turn_budget_plan_cap),
            "implement": _interp(
                self.settings.turn_budget_implement_floor, self.settings.turn_budget_implement_cap
            ),
            "review": _interp(self.settings.turn_budget_review_floor, self.settings.turn_budget_review_cap),
        }

    @staticmethod
    def _normalize_budget_mode(value: str | None) -> BudgetMode | None:
        if not value:
            return None
        normalized = value.strip().lower()
        if normalized in {"simple", "auto", "complex"}:
            return cast(BudgetMode, normalized)
        return None

    def _effective_budget_mode(self, session: EngineerSession) -> BudgetMode:
        direct = self._normalize_budget_mode(session.budget_mode)
        if direct:
            return direct
        source_override = None
        if session.source == "slack":
            source_override = self.settings.slack_budget_preset
        elif session.source == "cli":
            source_override = self.settings.cli_budget_preset
        return (
            self._normalize_budget_mode(source_override)
            or self._normalize_budget_mode(self.settings.budget_preset)
            or "auto"
        )

    def _turn_budgets_for_mode(self, mode: BudgetMode, complexity_score: float) -> dict[str, int]:
        if mode == "simple":
            return {
                "research": min(self.settings.research_max_turns, 6),
                "plan": 2,
                "implement": 8,
                "review": 3,
            }
        if mode == "complex":
            return {
                "research": min(self.settings.research_max_turns, self.settings.turn_budget_research_cap),
                "plan": self.settings.turn_budget_plan_cap,
                "implement": self.settings.turn_budget_implement_cap,
                "review": self.settings.turn_budget_review_cap,
            }
        return self._compute_turn_budgets(complexity_score)

    def _max_iterations_for_mode(self, mode: BudgetMode) -> int:
        if mode == "simple":
            return min(self.settings.max_iterations, 2)
        return self.settings.max_iterations

    def _research_branch_count(self, task: str) -> int:
        complexity = self._task_complexity_score(task)
        desired = self.settings.research_parallel_branches_min + (1 if complexity >= 3 else 0)
        desired += 1 if complexity >= 6 else 0
        return self._clamp(
            desired,
            self.settings.research_parallel_branches_min,
            self.settings.research_parallel_branches_max,
        )

    def _research_branch_count_for_mode(self, mode: BudgetMode, task: str) -> int:
        if mode == "simple":
            return 1
        if mode == "complex":
            return self.settings.research_parallel_branches_max
        return self._research_branch_count(task)

    def _plan_branch_count(self, task: str) -> int:
        complexity = self._task_complexity_score(task)
        desired = self.settings.plan_parallel_branches_min + (1 if complexity >= 4 else 0)
        desired += 1 if complexity >= 7 else 0
        return self._clamp(
            desired,
            self.settings.plan_parallel_branches_min,
            self.settings.plan_parallel_branches_max,
        )

    def _plan_branch_count_for_mode(self, mode: BudgetMode, task: str) -> int:
        if mode == "simple":
            return 1
        if mode == "complex":
            return self.settings.plan_parallel_branches_max
        return self._plan_branch_count(task)

    @staticmethod
    def _research_focus(index: int) -> str:
        focuses = [
            "Map the core call graph and directly impacted files.",
            "Prioritize integration risks, edge cases, and regression vectors.",
            "Prioritize testing and validation strategy from existing project patterns.",
            "Prioritize performance, latency, and scaling considerations for this change.",
            "Prioritize security, secrets handling, and safety constraints.",
        ]
        return focuses[index % len(focuses)]

    @staticmethod
    def _plan_focus(index: int) -> str:
        focuses = [
            "Prefer lowest-risk incremental rollout steps.",
            "Prefer fastest path to working implementation with strict correctness checks.",
            "Prioritize testability and observability in every step.",
            "Prioritize maintainability and long-term simplicity.",
        ]
        return focuses[index % len(focuses)]

    @staticmethod
    def _is_structured_research(text: str) -> bool:
        expected = (
            "## Affected Files",
            "## Patterns to Follow",
            "## Testing Strategy",
            "## Risks",
        )
        present = sum(1 for section in expected if section in text)
        return present >= 3

    @staticmethod
    def _is_structured_plan(text: str) -> bool:
        expected = ("## Approach", "## Plan", "## Verification")
        return all(section in text for section in expected)

    @staticmethod
    def _score_research(text: str) -> int:
        return (
            len(text)
            + (400 if "## Affected Files" in text else 0)
            + (400 if "## Testing Strategy" in text else 0)
        )

    @staticmethod
    def _score_plan(text: str) -> int:
        return (
            len(text)
            + (500 if "## Plan" in text else 0)
            + (300 if "## Verification" in text else 0)
        )

    @staticmethod
    def _is_review_approved(text: str) -> bool:
        normalized = text.strip().upper()
        return normalized.startswith("APPROVED") or normalized.startswith("LGTM")

    async def _run_parallel_candidates(
        self,
        *,
        phase_name: str,
        branch_count: int,
        run_branch: Callable[[int], Awaitable[AgentLoopResult]],
        is_acceptable: Callable[[str], bool],
        score: Callable[[str], int],
        session: EngineerSession,
        emit: EventCallback,
        model_name: str = "",
    ) -> AgentLoopResult:
        timeout_seconds = float(self.settings.branch_timeout_seconds)
        concurrency_limit = self._clamp(
            self.settings.subagent_max_concurrency,
            1,
            max(1, branch_count),
        )
        semaphore = asyncio.Semaphore(concurrency_limit)

        async def _run_with_lifecycle(index: int) -> tuple[int, AgentLoopResult]:
            branch_number = index + 1
            subagent_id = f"{phase_name}-{branch_number}"
            branch_name = f"{phase_name} branch {branch_number}"
            started_at = time.monotonic()
            await emit(
                {
                    "type": "subagent",
                    "phase": phase_name,
                    "status": "started",
                    "subagent_id": subagent_id,
                    "name": branch_name,
                    "branch_index": branch_number,
                    "total_branches": branch_count,
                    "max_parallel": concurrency_limit,
                    "model": model_name or None,
                }
            )
            try:
                async with semaphore:
                    result = await asyncio.wait_for(run_branch(index), timeout=timeout_seconds)
            except asyncio.CancelledError:
                await emit(
                    {
                        "type": "subagent",
                        "phase": phase_name,
                        "status": "cancelled",
                        "subagent_id": subagent_id,
                        "name": branch_name,
                        "branch_index": branch_number,
                        "duration_s": round(time.monotonic() - started_at, 3),
                    }
                )
                raise
            except Exception as exc:
                await emit(
                    {
                        "type": "subagent",
                        "phase": phase_name,
                        "status": "failed",
                        "subagent_id": subagent_id,
                        "name": branch_name,
                        "branch_index": branch_number,
                        "duration_s": round(time.monotonic() - started_at, 3),
                        "error": str(exc),
                    }
                )
                raise

            summary_line = (result.text.strip().splitlines() or [""])[0][:220]
            await emit(
                {
                    "type": "subagent",
                    "phase": phase_name,
                    "status": "completed",
                    "subagent_id": subagent_id,
                    "name": branch_name,
                    "branch_index": branch_number,
                    "duration_s": round(time.monotonic() - started_at, 3),
                    "turns": result.turns,
                    "tool_calls": result.tool_calls,
                    "input_tokens": result.input_tokens,
                    "output_tokens": result.output_tokens,
                    "total_tokens": result.input_tokens + result.output_tokens,
                    "model": model_name or None,
                    "is_acceptable": is_acceptable(result.text),
                    "acceptable": is_acceptable(result.text),
                    "summary": summary_line,
                }
            )
            return index, result

        tasks = [asyncio.create_task(_run_with_lifecycle(index)) for index in range(branch_count)]
        completed: list[tuple[int, AgentLoopResult]] = []
        acceptable: list[tuple[int, AgentLoopResult]] = []
        failures: list[str] = []
        early_stop_triggered = False

        for finished in asyncio.as_completed(tasks):
            try:
                index, result = await finished
            except Exception as exc:
                log.warning("parallel_branch_failed", phase=phase_name, error=str(exc))
                failures.append(str(exc))
                continue
            completed.append((index, result))
            if is_acceptable(result.text):
                acceptable.append((index, result))
            await emit(
                {
                    "type": "subagent",
                    "phase": phase_name,
                    "status": "progress",
                    "subagent_id": f"{phase_name}-coordinator",
                    "name": f"{phase_name} coordinator",
                    "completed": len(completed),
                    "acceptable": len(acceptable),
                    "failed": len(failures),
                    "completed_count": len(completed),
                    "acceptable_count": len(acceptable),
                    "failed_count": len(failures),
                    "total_branches": branch_count,
                    "input_tokens": sum(item.input_tokens for _, item in completed),
                    "output_tokens": sum(item.output_tokens for _, item in completed),
                    "model": model_name or None,
                }
            )
            enough_results = (
                len(completed) >= self.settings.parallel_min_completed_before_early_stop
            )
            if acceptable and enough_results:
                early_stop_triggered = True
                break

        if early_stop_triggered:
            session.early_stop_count += 1
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await emit(
                {
                    "type": "subagent",
                    "phase": phase_name,
                    "status": "early_stop",
                    "subagent_id": f"{phase_name}-coordinator",
                    "name": f"{phase_name} coordinator",
                    "completed": len(completed),
                    "acceptable": len(acceptable),
                    "failed": len(failures),
                    "completed_count": len(completed),
                    "acceptable_count": len(acceptable),
                    "failed_count": len(failures),
                    "total_branches": branch_count,
                    "model": model_name or None,
                }
            )

        if not completed:
            detail = "; ".join(msg for msg in failures[:3] if msg.strip())
            if detail:
                raise AgentLoopError(
                    f"{phase_name} phase failed across all parallel branches: {detail}"
                )
            raise AgentLoopError(f"{phase_name} phase failed across all parallel branches")

        winners = acceptable or completed
        winner_index, winner_result = max(winners, key=lambda item: score(item[1].text))
        await emit(
            {
                "type": "subagent",
                "phase": phase_name,
                "status": "selected",
                "subagent_id": f"{phase_name}-{winner_index + 1}",
                "name": f"{phase_name} branch {winner_index + 1}",
                "total_branches": branch_count,
                "model": model_name or None,
            }
        )
        return winner_result

    async def run(
        self,
        session: EngineerSession,
        *,
        post_message: MessageCallback | None = None,
        on_event: EventCallback | None = None,
        on_phase: PhaseCallback | None = None,
        on_waiting_for_reply: WaitingCallback | None = None,
    ) -> EngineerResult:
        """Drive the full engineer workflow."""
        send = post_message or _noop
        emit = on_event or _noop_event
        notify_phase = on_phase or _noop_phase
        notify_waiting = on_waiting_for_reply or _noop_waiting
        repo_guidance = load_repo_guidance(self.repo_root)
        effort = self.settings.anthropic_effort
        max_tokens = self.settings.anthropic_max_tokens

        try:
            model = self._effective_model(session)
            use_harness = self._is_harness_model(model)
            if use_harness:
                await send(f"Using harness: `{model}`")
            else:
                await send(f"Using model: `{model}` (effort: {effort})")

            thread_name = (
                None
                if use_harness
                else await self._generate_thread_name(session.task, model)
            )
            if thread_name:
                session.thread_name = thread_name

            budget_mode = self._effective_budget_mode(session)
            session.budget_mode = budget_mode
            max_iterations = self._max_iterations_for_mode(budget_mode)
            session.complexity_score = float(self._task_complexity_score(session.task))
            session.turn_budgets = self._turn_budgets_for_mode(budget_mode, session.complexity_score)

            branch = (
                f"{self.settings.branch_prefix}/{session.run_id[:8]}"
                f"/{slugify(session.task, max_len=32)}"
            )
            session.branch_name = branch
            session.worktree = await create_worktree(
                self.repo_root,
                branch,
                self.settings.github_base_branch,
                github_owner=self.settings.github_repo_owner,
                github_repo=self.settings.github_repo_name,
                github_token=self.settings.github_token,
                allow_local_clone_without_token=self.dry_run,
            )
            executor = ToolExecutor(
                session.worktree,
                command_allowlist=self.settings.command_allowlist_set,
                protected_paths=self.settings.protected_write_path_list,
            )

            async def _run_phase_loop(
                *,
                system_prompt: str,
                user_prompt: str,
                tools: list[dict[str, Any]],
                execute_tool: Callable[[str, dict[str, Any]], Awaitable[str]] | None,
                guard_state: LoopGuardState,
            ) -> AgentLoopResult:
                if use_harness:
                    harness_result = await run_harness_phase(
                        harness=model,
                        system_prompt=system_prompt,
                        user_prompt=user_prompt,
                        worktree_root=session.worktree,
                        timeout_seconds=self.settings.max_wall_time_seconds,
                        thread_id=session.harness_thread_id,
                        on_event=emit,
                    )
                    session.harness_thread_id = harness_result.thread_id
                    return harness_result.result
                return await run_agent_loop(
                    api_key=self.settings.anthropic_api_key,
                    model=model,
                    max_tokens=max_tokens,
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    tools=tools,
                    execute_tool=execute_tool,
                    guard_state=guard_state,
                    effort=effort,
                    max_parallel_tool_calls=self.settings.max_parallel_tool_calls,
                    tool_call_timeout_seconds=self.settings.tool_call_timeout_seconds,
                    request_timeout_seconds=self.settings.anthropic_request_timeout_seconds,
                    on_event=emit,
                    fail_soft_on_budget=self.settings.turn_budget_fail_soft,
                )

            session.phase = Phase.RESEARCH
            await notify_phase(Phase.RESEARCH, session.task)
            session.research_branch_count = (
                1 if use_harness else self._research_branch_count_for_mode(budget_mode, session.task)
            )
            await send(
                f"Researching the codebase with {session.research_branch_count} parallel branches..."
            )
            await send(
                f"Execution lane: {_LANE_LABELS[budget_mode]} (mode: {budget_mode})\n"
                "Turn budgets: "
                f"research={session.turn_budgets['research']}, "
                f"plan={session.turn_budgets['plan']}, "
                f"implement={session.turn_budgets['implement']}, "
                f"review={session.turn_budgets['review']}"
            )

            async def _run_research_branch(index: int) -> AgentLoopResult:
                return await _run_phase_loop(
                    system_prompt=researcher_prompt(repo_guidance),
                    user_prompt=(
                        f"Task: {session.task}{self._preference_hint(session)}\n\n"
                        f"BRANCH FOCUS (prioritize in your analysis): {self._research_focus(index)}\n\n"
                        "When you have enough evidence for required headings, output and stop."
                    ),
                    tools=RESEARCH_TOOLS,
                    execute_tool=executor.execute,
                    guard_state=self._phase_guard(max_turns=session.turn_budgets["research"]),
                )

            research = await self._run_parallel_candidates(
                phase_name="research",
                branch_count=session.research_branch_count,
                run_branch=_run_research_branch,
                is_acceptable=self._is_structured_research,
                score=self._score_research,
                session=session,
                emit=emit,
                model_name=model,
            )
            session.phase_turns_used["research"] = research.turns
            session.phase_budget_exceeded["research"] = (
                research.stop_reason == "turn_budget_exceeded"
            )
            session.research_brief = research.text or f"Implement task: {session.task}"
            session.complexity_score = float(
                self._task_complexity_score(session.task, session.research_brief)
            )
            session.turn_budgets = self._turn_budgets_for_mode(budget_mode, session.complexity_score)
            await send(
                f"Research complete ({research.turns} turns, {research.tool_calls} tool calls)"
            )

            session.phase = Phase.PLAN
            await notify_phase(Phase.PLAN, "")
            session.plan_branch_count = (
                1 if use_harness else self._plan_branch_count_for_mode(budget_mode, session.task)
            )
            await send(
                f"Planning implementation with {session.plan_branch_count} parallel branches..."
            )

            async def _run_plan_branch(index: int) -> AgentLoopResult:
                return await _run_phase_loop(
                    system_prompt=planner_prompt(repo_guidance),
                    user_prompt=(
                        f"Task: {session.task}\n\n"
                        f"Research findings:\n{session.research_brief}\n\n"
                        f"BRANCH FOCUS: {self._plan_focus(index)}\n\n"
                        "Output format: include exactly ## Approach, ## Plan, ## Verification."
                    ),
                    tools=[],
                    execute_tool=None,
                    guard_state=self._phase_guard(max_turns=session.turn_budgets["plan"]),
                )

            plan_result = await self._run_parallel_candidates(
                phase_name="plan",
                branch_count=session.plan_branch_count,
                run_branch=_run_plan_branch,
                is_acceptable=self._is_structured_plan,
                score=self._score_plan,
                session=session,
                emit=emit,
                model_name=model,
            )
            session.phase_turns_used["plan"] = plan_result.turns
            session.phase_budget_exceeded["plan"] = plan_result.stop_reason == "turn_budget_exceeded"
            session.plan = plan_result.text or ""
            session.complexity_score = float(
                self._task_complexity_score(session.task, session.research_brief, session.plan)
            )
            session.turn_budgets = self._turn_budgets_for_mode(budget_mode, session.complexity_score)
            await send("Plan ready.")

            if self.skip_clarify:
                session.spec = (
                    f"Task: {session.task}\n\n"
                    f"Research brief:\n{session.research_brief}\n\n"
                    f"Plan:\n{session.plan}"
                )
                await send("Skipping clarification, using research + plan as spec.")
            else:
                session.phase = Phase.CLARIFY
                await notify_phase(Phase.CLARIFY, "")
                session.spec = await self._clarify_loop(
                    session, repo_guidance, send, notify_waiting
                )

            session.phase = Phase.IMPLEMENT
            feedback = ""
            no_diff_streak = 0
            no_diff_exit_after = max(1, self.settings.no_diff_exit_after)

            for iteration in range(max_iterations):
                session.iteration = iteration + 1
                await notify_phase(
                    Phase.IMPLEMENT,
                    f"iteration {session.iteration}",
                )
                await send(
                    f"Implementing (iteration {session.iteration}/{max_iterations})..."
                )
                feedback_for_prompt = (
                    _truncate_middle(feedback, _FEEDBACK_MAX_CHARS, "feedback")
                    if feedback
                    else ""
                )

                implement_result = await _run_phase_loop(
                    system_prompt=engineer_prompt(
                        repo_guidance, session.spec, session.plan, feedback_for_prompt
                    ),
                    user_prompt=f"Implement: {session.task}{self._preference_hint(session)}",
                    tools=ENGINEER_TOOLS,
                    execute_tool=executor.execute,
                    guard_state=self._phase_guard(max_turns=session.turn_budgets["implement"]),
                )
                session.phase_turns_used["implement"] = (
                    session.phase_turns_used.get("implement", 0) + implement_result.turns
                )
                if implement_result.stop_reason == "turn_budget_exceeded":
                    session.phase_budget_exceeded["implement"] = True

                await send("Running validation...")
                report = await run_validation(session.worktree)
                validation_feedback = (
                    "All checks passed." if report.success else report.to_feedback()
                )
                if not report.success:
                    feedback = validation_feedback
                    no_diff_streak = 0
                    await send(
                        f"Validation failed, iterating...\n```\n{validation_feedback[:1000]}\n```"
                    )
                    continue

                diff_text = await get_diff(session.worktree)
                if not diff_text.strip():
                    no_diff_streak += 1
                    feedback = "No code diff found. Apply concrete code changes."
                    terminal_iteration = iteration >= max_iterations - 1
                    if no_diff_streak >= no_diff_exit_after or terminal_iteration:
                        if self.dry_run:
                            await send(
                                "No diff produced after repeated attempts. Treating this as a no-op dry run."
                            )
                            session.phase = Phase.DONE
                            return EngineerResult(
                                run_id=session.run_id,
                                success=True,
                                status="completed",
                                branch_name=session.branch_name,
                                summary=(
                                    "No-op dry run completed — no code changes were required "
                                    "for the requested task."
                                ),
                                no_op=True,
                            )
                        await send(
                            "No diff produced after repeated attempts. "
                            "Task appears already satisfied; ending run without PR."
                        )
                        session.phase = Phase.DONE
                        return EngineerResult(
                            run_id=session.run_id,
                            success=True,
                            status="completed",
                            branch_name=session.branch_name,
                            summary=(
                                "No code changes were required for this task, "
                                "so no PR was created."
                            ),
                            no_op=True,
                        )
                    await send("No diff produced, iterating...")
                    continue

                no_diff_streak = 0
                await send(f"Diff: {diff_text.count(chr(10))} lines changed")
                review_diff = _prepare_review_diff(diff_text)

                session.phase = Phase.REVIEW
                await notify_phase(Phase.REVIEW, "")
                await send("Reviewing changes...")
                review = await _run_phase_loop(
                    system_prompt=reviewer_prompt(repo_guidance, session.spec, session.plan),
                    user_prompt=(
                        f"Review the changes on this branch.\n\n"
                        f"Validation results: {validation_feedback}\n\n"
                        f"Diff:\n```\n{review_diff}\n```"
                    ),
                    tools=RESEARCH_TOOLS,
                    execute_tool=executor.execute,
                    guard_state=self._phase_guard(max_turns=session.turn_budgets["review"]),
                )
                session.phase_turns_used["review"] = (
                    session.phase_turns_used.get("review", 0) + review.turns
                )
                if review.stop_reason == "turn_budget_exceeded":
                    session.phase_budget_exceeded["review"] = True

                review_text = review.text.strip()
                if self._is_review_approved(review_text):
                    await send("Review: APPROVED")
                    break
                if not review_text:
                    await send(
                        "Review returned no actionable feedback; "
                        "proceeding because validation passed and diff is present."
                    )
                    break
                feedback = f"Reviewer feedback:\n{review_text}"
                session.phase = Phase.IMPLEMENT
                await send(f"Review: CHANGES_REQUESTED\n{review_text[:500]}")
            else:
                raise RuntimeError("Review loop did not reach approval")

            if not await has_changes(session.worktree):
                raise RuntimeError("No changes to commit")

            session.phase = Phase.PUBLISH
            await notify_phase(Phase.PUBLISH, "")
            commit_msg = f"feat: {slugify(session.task, max_len=60)}"
            await commit_all(session.worktree, commit_msg)
            await send(f"Committed: {commit_msg}")

            if self.dry_run:
                await send(
                    f"DRY RUN — skipping push/PR.\n"
                    f"Worktree preserved at: {session.worktree}\n"
                    f"Branch: {session.branch_name}\n"
                    f"Inspect with: cd {session.worktree} && git log --oneline -3 && git diff HEAD~1"
                )
                session.phase = Phase.DONE
                return EngineerResult(
                    run_id=session.run_id,
                    success=True,
                    status="completed",
                    branch_name=session.branch_name,
                    summary="Dry run completed — changes committed locally, PR skipped.",
                )

            await send("Pushing branch and opening PR...")
            await push_branch(session.worktree, session.branch_name)
            pr_url = await create_pull_request(
                token=self.settings.github_token,
                owner=self.settings.github_repo_owner,
                repo=self.settings.github_repo_name,
                base_branch=self.settings.github_base_branch,
                head_branch=session.branch_name,
                title=f"feat: {session.task[:72]}",
                body=(
                    f"## Task\n{session.task}\n\n"
                    f"## Plan\n{session.plan[:2000]}\n\n"
                    f"## Specification\n{session.spec[:2000]}\n\n"
                    f"Run ID: `{session.run_id}`\n"
                    f"Iterations: {session.iteration}\n"
                ),
            )
            if not pr_url.strip():
                raise RuntimeError("PR creation returned empty URL")

            session.pr_url = pr_url
            session.phase = Phase.DONE
            return EngineerResult(
                run_id=session.run_id,
                success=True,
                status="completed",
                branch_name=session.branch_name,
                pr_url=pr_url,
                summary="Engineer workflow completed successfully",
            )

        except (AgentLoopError, GitOperationError, GitHubPRError, RuntimeError) as exc:
            log.exception("engineer_run_failed", run_id=session.run_id, error=str(exc))
            session.phase = Phase.FAILED
            session.error = str(exc)
            return EngineerResult(
                run_id=session.run_id,
                success=False,
                status="failed",
                branch_name=session.branch_name,
                error=str(exc),
            )
        except Exception as exc:
            # Keep the run resilient if any phase raises an unexpected exception type.
            log.exception("engineer_run_failed", run_id=session.run_id, error=str(exc))
            session.phase = Phase.FAILED
            session.error = f"{exc.__class__.__name__}: {exc}"
            return EngineerResult(
                run_id=session.run_id,
                success=False,
                status="failed",
                branch_name=session.branch_name,
                error=session.error,
            )
        finally:
            should_cleanup = (
                session.worktree is not None and self.settings.cleanup_worktree and not self.dry_run
            )
            if should_cleanup:
                assert session.worktree is not None
                await cleanup_worktree(self.repo_root, session.worktree)

    async def _clarify_loop(
        self,
        session: EngineerSession,
        repo_guidance: str,
        send: MessageCallback,
        notify_waiting: WaitingCallback,
    ) -> str:
        """Run the clarification interview loop. Returns the final spec."""
        from anthropic import AsyncAnthropic

        messages: list[dict[str, str]] = [
            {
                "role": "user",
                "content": (
                    f"Task: {session.task}{self._preference_hint(session)}\n\n"
                    f"Research brief:\n{session.research_brief}\n\n"
                    f"Plan:\n{session.plan}"
                ),
            }
        ]

        system = clarifier_prompt(repo_guidance, session.research_brief)
        client = AsyncAnthropic(api_key=self.settings.anthropic_api_key)
        max_tokens = self.settings.anthropic_max_tokens

        for _ in range(10):
            response = await asyncio.wait_for(
                client.messages.create(
                    model=self._effective_model(session),
                    max_tokens=max_tokens,
                    system=system,
                    messages=messages,  # type: ignore[arg-type]
                ),
                timeout=float(self.settings.anthropic_request_timeout_seconds),
            )

            assistant_text = ""
            for block in response.content:
                if getattr(block, "type", "") == "text":
                    assistant_text += getattr(block, "text", "")
            assistant_text = assistant_text.strip()

            if assistant_text.startswith("SPEC_COMPLETE"):
                spec = assistant_text[len("SPEC_COMPLETE") :].strip()
                await send(f"Specification finalized:\n```\n{spec[:2000]}\n```")
                return spec

            await send(assistant_text)
            messages.append({"role": "assistant", "content": assistant_text})

            session.waiting_for_reply = True
            await notify_waiting(True)
            try:
                user_reply = await session.wait_for_user_reply(
                    timeout=float(self.settings.max_wall_time_seconds)
                )
            finally:
                session.waiting_for_reply = False
                await notify_waiting(False)
            if user_reply is None:
                await send("Timed out waiting for reply. Proceeding with current information.")
                return self._fallback_spec(session, messages)

            session.clarify_history.append({"role": "user", "content": user_reply})
            messages.append({"role": "user", "content": user_reply})

        return self._fallback_spec(session, messages)

    @staticmethod
    def _fallback_spec(session: EngineerSession, messages: list[dict[str, str]]) -> str:
        return (
            f"Task: {session.task}\n\n"
            f"Research brief:\n{session.research_brief}\n\n"
            f"Plan:\n{session.plan}\n\n"
            "Conversation:\n" + "\n".join(f"{m['role']}: {m['content'][:500]}" for m in messages)
        )
