"""Tool SDK — what tool authors import."""

from __future__ import annotations

import contextlib
import logging
from contextvars import ContextVar
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)


@dataclass
class ToolContext:
    name: str
    secrets: dict[str, str] = field(default_factory=dict)
    thread_key: str | None = None
    container_id: str | None = None


_tool_ctx: ContextVar[ToolContext] = ContextVar("_tool_ctx")


def set_tool_context(ctx: ToolContext) -> Any:
    return _tool_ctx.set(ctx)


def reset_tool_context(token: Any) -> None:
    _tool_ctx.reset(token)


def get_tool_context() -> ToolContext:
    return _tool_ctx.get()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def secret(key: str, default: str | None = None) -> str:
    """Get a secret. Resolution order: tool context → pluggable backend → default.

    - **ToolContext**: Set by ToolManager, populated from .env files (if any).
    - **Pluggable backend**: Configured via ``centaur_sdk.backends.registry``
      (env vars, HTTP sidecar, etc.).
    """
    # 1. Check tool context if available (server mode)
    try:
        ctx = _tool_ctx.get()
        val = ctx.secrets.get(key)
        if val is not None:
            return val
    except LookupError:
        pass

    # 2. Pluggable secret backend
    from centaur_sdk.backends.registry import get_backend

    val = get_backend().get_sync(key)
    if val is not None:
        return val

    if default is not None:
        return default

    ctx_name = ""
    with contextlib.suppress(LookupError):
        ctx_name = f" for tool '{_tool_ctx.get().name}'"
    raise KeyError(f"Missing secret '{key}'{ctx_name}")
