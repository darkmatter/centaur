from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import uuid4

import structlog

from shared.engineer.models import Phase

log = structlog.get_logger()

MessageCallback = Callable[[str], Awaitable[None]]


async def _noop_message(_: str) -> None:
    return


@dataclass
class EngineerSession:
    """In-memory state for one engineer thread."""

    thread_key: str
    task: str
    model_preference: str | None = None
    run_id: str = field(default_factory=lambda: str(uuid4()))
    phase: Phase = Phase.RESEARCH
    research_brief: str = ""
    plan: str = ""
    spec: str = ""
    clarify_history: list[dict[str, str]] = field(default_factory=list)
    reviewer_feedback: str = ""
    iteration: int = 0
    research_branch_count: int = 0
    plan_branch_count: int = 0
    early_stop_count: int = 0
    thread_name: str | None = None
    harness_thread_id: str | None = None
    branch_name: str | None = None
    worktree: Path | None = None
    pr_url: str | None = None
    error: str | None = None

    _user_reply_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    _pending_user_reply: str = field(default="", repr=False)

    def receive_user_reply(self, text: str) -> None:
        self._pending_user_reply = text
        self._user_reply_event.set()

    async def wait_for_user_reply(self, timeout: float = 1800.0) -> str | None:
        try:
            await asyncio.wait_for(self._user_reply_event.wait(), timeout=timeout)
        except TimeoutError:
            return None
        reply = self._pending_user_reply
        self._pending_user_reply = ""
        self._user_reply_event.clear()
        return reply


_sessions: dict[str, EngineerSession] = {}
_session_tasks: dict[str, asyncio.Task[Any]] = {}


def get_session(thread_key: str) -> EngineerSession | None:
    return _sessions.get(thread_key)


def create_session(thread_key: str, task: str) -> EngineerSession:
    session = EngineerSession(thread_key=thread_key, task=task)
    _sessions[thread_key] = session
    return session


def remove_session(thread_key: str) -> None:
    _sessions.pop(thread_key, None)
    task = _session_tasks.pop(thread_key, None)
    try:
        current = asyncio.current_task()
    except RuntimeError:
        current = None
    if task and not task.done() and task is not current:
        task.cancel()


def register_task(thread_key: str, task: asyncio.Task[Any]) -> None:
    _session_tasks[thread_key] = task


def has_active_session(thread_key: str) -> bool:
    session = _sessions.get(thread_key)
    if session is None:
        return False
    return session.phase not in (Phase.DONE, Phase.FAILED)
