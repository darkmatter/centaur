from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

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


async def _noop(_: str) -> None:
    return


async def _noop_phase(_phase: Phase, _label: str) -> None:
    return


async def _noop_event(_event: dict[str, Any]) -> None:
    return


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
    def _task_complexity_score(task: str) -> int:
        score = 0
        task_lower = task.lower()
        if len(task) > 120:
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
        )
        score += sum(1 for marker in complexity_markers if marker in task_lower)
        return score

    def _research_branch_count(self, task: str) -> int:
        complexity = self._task_complexity_score(task)
        desired = self.settings.research_parallel_branches_min + (1 if complexity >= 3 else 0)
        desired += 1 if complexity >= 6 else 0
        return self._clamp(
            desired,
            self.settings.research_parallel_branches_min,
            self.settings.research_parallel_branches_max,
        )

    def _plan_branch_count(self, task: str) -> int:
        complexity = self._task_complexity_score(task)
        desired = self.settings.plan_parallel_branches_min + (1 if complexity >= 4 else 0)
        desired += 1 if complexity >= 7 else 0
        return self._clamp(
            desired,
            self.settings.plan_parallel_branches_min,
            self.settings.plan_parallel_branches_max,
        )

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
        return all(section in text for section in expected)

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

    async def _run_parallel_candidates(
        self,
        *,
        phase_name: str,
        branch_count: int,
        run_branch: Callable[[int], Awaitable[AgentLoopResult]],
        is_acceptable: Callable[[str], bool],
        score: Callable[[str], int],
        session: EngineerSession,
    ) -> AgentLoopResult:
        tasks = [asyncio.create_task(run_branch(index)) for index in range(branch_count)]
        completed: list[AgentLoopResult] = []
        acceptable: list[AgentLoopResult] = []
        early_stop_triggered = False

        for finished in asyncio.as_completed(tasks):
            try:
                result = await asyncio.wait_for(
                    finished, timeout=float(self.settings.branch_timeout_seconds)
                )
            except Exception as exc:
                log.warning("parallel_branch_failed", phase=phase_name, error=str(exc))
                continue
            completed.append(result)
            if is_acceptable(result.text):
                acceptable.append(result)
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

        if not completed:
            raise AgentLoopError(f"{phase_name} phase failed across all parallel branches")

        winners = acceptable or completed
        return max(winners, key=lambda item: score(item.text))

    async def run(
        self,
        session: EngineerSession,
        *,
        post_message: MessageCallback | None = None,
        on_event: EventCallback | None = None,
        on_phase: PhaseCallback | None = None,
    ) -> EngineerResult:
        """Drive the full engineer workflow."""
        send = post_message or _noop
        emit = on_event or _noop_event
        notify_phase = on_phase or _noop_phase
        repo_guidance = load_repo_guidance(self.repo_root)
        effort = self.settings.anthropic_effort
        max_tokens = self.settings.anthropic_max_tokens

        try:
            model = self._effective_model(session)
            use_harness = self._is_harness_model(model)
            if session.model_preference or self.model_preference:
                await send(f"Using model: `{model}` (effort: {effort})")

            thread_name = await self._generate_thread_name(session.task, model)
            if thread_name:
                session.thread_name = thread_name

            branch = (
                f"{self.settings.branch_prefix}/{session.run_id[:8]}"
                f"/{slugify(session.task, max_len=32)}"
            )
            session.branch_name = branch
            session.worktree = await create_worktree(
                self.repo_root, branch, self.settings.github_base_branch
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
                )

            session.phase = Phase.RESEARCH
            await notify_phase(Phase.RESEARCH, session.task)
            session.research_branch_count = (
                1 if use_harness else self._research_branch_count(session.task)
            )
            await send(
                f"Researching the codebase with {session.research_branch_count} parallel branches..."
            )

            async def _run_research_branch(index: int) -> AgentLoopResult:
                return await _run_phase_loop(
                    system_prompt=researcher_prompt(repo_guidance),
                    user_prompt=(
                        f"Task: {session.task}{self._preference_hint(session)}\n\n"
                        f"Branch focus: {self._research_focus(index)}"
                    ),
                    tools=RESEARCH_TOOLS,
                    execute_tool=executor.execute,
                    guard_state=self._phase_guard(),
                )

            research = await self._run_parallel_candidates(
                phase_name="research",
                branch_count=session.research_branch_count,
                run_branch=_run_research_branch,
                is_acceptable=self._is_structured_research,
                score=self._score_research,
                session=session,
            )
            session.research_brief = research.text or f"Implement task: {session.task}"
            await send(
                f"Research complete ({research.turns} turns, {research.tool_calls} tool calls)"
            )

            session.phase = Phase.PLAN
            await notify_phase(Phase.PLAN, "")
            session.plan_branch_count = 1 if use_harness else self._plan_branch_count(session.task)
            await send(
                f"Planning implementation with {session.plan_branch_count} parallel branches..."
            )

            async def _run_plan_branch(index: int) -> AgentLoopResult:
                return await _run_phase_loop(
                    system_prompt=planner_prompt(repo_guidance),
                    user_prompt=(
                        f"Task: {session.task}\n\n"
                        f"Research findings:\n{session.research_brief}\n\n"
                        f"Branch focus: {self._plan_focus(index)}"
                    ),
                    tools=[],
                    execute_tool=None,
                    guard_state=self._phase_guard(max_turns=4),
                )

            plan_result = await self._run_parallel_candidates(
                phase_name="plan",
                branch_count=session.plan_branch_count,
                run_branch=_run_plan_branch,
                is_acceptable=self._is_structured_plan,
                score=self._score_plan,
                session=session,
            )
            session.plan = plan_result.text or ""
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
                session.spec = await self._clarify_loop(session, repo_guidance, send)

            session.phase = Phase.IMPLEMENT
            feedback = ""

            for iteration in range(self.settings.max_iterations):
                session.iteration = iteration + 1
                await notify_phase(
                    Phase.IMPLEMENT,
                    f"iteration {session.iteration}",
                )
                await send(
                    f"Implementing (iteration {session.iteration}/{self.settings.max_iterations})..."
                )

                _ = await _run_phase_loop(
                    system_prompt=engineer_prompt(
                        repo_guidance, session.spec, session.plan, feedback
                    ),
                    user_prompt=f"Implement: {session.task}{self._preference_hint(session)}",
                    tools=ENGINEER_TOOLS,
                    execute_tool=executor.execute,
                    guard_state=self._phase_guard(),
                )

                await send("Running validation...")
                report = await run_validation(session.worktree)
                validation_feedback = (
                    "All checks passed." if report.success else report.to_feedback()
                )
                if not report.success:
                    feedback = validation_feedback
                    await send(
                        f"Validation failed, iterating...\n```\n{validation_feedback[:1000]}\n```"
                    )
                    continue

                diff_text = await get_diff(session.worktree)
                if not diff_text.strip():
                    feedback = "No code diff found. Apply concrete code changes."
                    await send("No diff produced, iterating...")
                    continue

                await send(f"Diff: {diff_text.count(chr(10))} lines changed")

                session.phase = Phase.REVIEW
                await notify_phase(Phase.REVIEW, "")
                await send("Reviewing changes...")
                review = await _run_phase_loop(
                    system_prompt=reviewer_prompt(repo_guidance, session.spec, session.plan),
                    user_prompt=(
                        f"Review the changes on this branch.\n\n"
                        f"Validation results: {validation_feedback}\n\n"
                        f"Diff:\n```\n{diff_text}\n```"
                    ),
                    tools=RESEARCH_TOOLS,
                    execute_tool=executor.execute,
                    guard_state=self._phase_guard(max_turns=12),
                )

                review_text = review.text.strip()
                if review_text.upper().startswith("APPROVED"):
                    await send("Review: APPROVED")
                    break
                feedback = f"Reviewer feedback:\n{review_text}"
                session.phase = Phase.IMPLEMENT
                await send(f"Review: CHANGES_REQUESTED\n{review_text[:500]}")
            else:
                session.phase = Phase.FAILED
                session.error = "Review loop did not reach approval"
                return EngineerResult(
                    run_id=session.run_id,
                    success=False,
                    status="failed",
                    branch_name=session.branch_name,
                    error=session.error,
                )

            if not await has_changes(session.worktree):
                session.phase = Phase.FAILED
                session.error = "No changes to commit"
                return EngineerResult(
                    run_id=session.run_id,
                    success=False,
                    status="failed",
                    branch_name=session.branch_name,
                    error=session.error,
                )

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

            user_reply = await session.wait_for_user_reply(
                timeout=float(self.settings.max_wall_time_seconds)
            )
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
