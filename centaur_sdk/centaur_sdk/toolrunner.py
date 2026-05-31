"""Shared tool-invocation core + local CLI runner.

This module is the single source of truth for the *pure* mechanics of invoking
a Centaur tool method: argument validation, result normalization, TOON
encoding, method collection, and method-schema description. Both execution
paths import these helpers so they stay behaviorally identical:

- The API's in-process path (``api.tool_manager.ToolManager``) wraps them with
  server-only concerns (FastAPI auth, OTel-from-DB, Slack live-capture,
  DB-backed attachment extraction, Prometheus metrics).
- The local agent runner (``centaur-tool <tool> <method> '<json>'``) wraps them
  with a one-shot process that loads the tool package, sets a ``ToolContext``
  from the sandbox env, and reproduces large-output attachment extraction via
  the SDK ``save_attachment`` HTTP path.

The module deliberately imports nothing from ``api`` so it can run inside the
agent sandbox image, which ships only ``centaur_sdk`` + ``tools/``.
"""

from __future__ import annotations

import asyncio
import base64
import difflib
import importlib.util
import inspect
import json
import os
import re
import sys
import time
import tomllib
import types
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, is_dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from toon_format import encode as toon_encode

from centaur_sdk.logging import stderr_json_logger
from centaur_sdk.tool_sdk import (
    ToolContext,
    reset_tool_context,
    save_attachment,
    set_tool_context,
)

# Diagnostics go to stderr as JSON; the runner's stdout is the tool result.
log = stderr_json_logger()

# ---------------------------------------------------------------------------
# Shared constants (kept in sync with the historical values in tool_manager.py)
# ---------------------------------------------------------------------------

_MAX_INLINE_TOOL_BINARY_BYTES = max(
    1024, int(os.getenv("TOOL_BINARY_INLINE_MAX_BYTES", str(1 * 1024 * 1024)))
)
_TOOL_BINARY_PREVIEW_BYTES = max(
    128, int(os.getenv("TOOL_BINARY_PREVIEW_BYTES", str(32 * 1024)))
)

# Threshold for extracting base64-encoded file data from tool results into
# the attachments store. Anything larger gets stored as an attachment and
# replaced with a download URL so it doesn't bloat the agent context window.
_ATTACHMENT_EXTRACT_MIN_BYTES = 64 * 1024  # 64 KB

# Maximum wall-clock seconds a single tool call may run before being cancelled.
_TOOL_CALL_TIMEOUT_S = float(os.getenv("TOOL_CALL_TIMEOUT_S", "120"))

_LIFECYCLE_METHODS = frozenset({"close", "connect", "disconnect", "shutdown"})

_COMMON_ARGUMENT_ALIASES: dict[str, str] = {
    "channel_id": "channel",
    "count": "limit",
    "max_results": "limit",
    "page_size": "limit",
    "range": "range_notation",
    "sql": "query",
    "table": "table_name",
}

_FORBIDDEN_TOOL_ARGUMENT_NAMES = frozenset(
    {
        "output_path",
        "output_dir",
        "download_path",
        "save_path",
        "dest_path",
        "destination_path",
    }
)

# Mapping from Python built-in types to clean names for schema output
_BUILTIN_TYPE_NAMES: dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
    type(None): "null",
}

_METHOD_DESCRIPTION_MAX_CHARS = 1200
_DOCSTRING_BOUNDARY_MARKERS = (
    "Args:",
    "Arguments:",
    "Returns:",
    "Return:",
    "Yields:",
    "Raises:",
    "Example:",
    "Examples:",
    "Note:",
    "Notes:",
    "Warning:",
    "See Also:",
    "See also:",
)


class ToolMethod:
    def __init__(self, method_name: str, fn: Callable):
        self.method_name = method_name
        self.fn = fn


# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------


def _tool_arg_validation_error(
    method: ToolMethod, args: dict[str, Any]
) -> dict[str, Any] | None:
    """Return a structured argument error before invoking a tool method."""
    forbidden = sorted(set(args) & _FORBIDDEN_TOOL_ARGUMENT_NAMES)
    if forbidden:
        return {
            "error": "tool_argument_validation_failed",
            "message": (
                "Forbidden argument(s): "
                f"{', '.join(forbidden)}. Tools may not write API-process files "
                "to caller-supplied paths; return Centaur attachments instead."
            ),
            "forbidden_args": forbidden,
        }

    sig = inspect.signature(method.fn)
    params = sig.parameters
    accepts_var_kwargs = any(
        p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
    )
    valid_names = {
        name
        for name, param in params.items()
        if param.kind
        in {
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        }
    }
    if not accepts_var_kwargs:
        unexpected = sorted(set(args) - valid_names)
        if unexpected:
            suggestions = {
                key: (
                    _COMMON_ARGUMENT_ALIASES.get(key)
                    if _COMMON_ARGUMENT_ALIASES.get(key) in valid_names
                    else (difflib.get_close_matches(key, valid_names, n=1) or [None])[0]
                )
                for key in unexpected
            }
            return {
                "error": "tool_argument_validation_failed",
                "message": f"Unexpected argument(s): {', '.join(unexpected)}",
                "unexpected_args": unexpected,
                "accepted_args": sorted(valid_names),
                "did_you_mean": {k: v for k, v in suggestions.items() if v},
            }

    missing = sorted(
        name
        for name, param in params.items()
        if param.default is inspect.Parameter.empty
        and param.kind
        in {
            inspect.Parameter.POSITIONAL_OR_KEYWORD,
            inspect.Parameter.KEYWORD_ONLY,
        }
        and name not in args
    )
    if missing:
        return {
            "error": "tool_argument_validation_failed",
            "message": f"Missing required argument(s): {', '.join(missing)}",
            "missing_args": missing,
            "accepted_args": sorted(valid_names),
        }
    return None


# ---------------------------------------------------------------------------
# Result normalization + serialization
# ---------------------------------------------------------------------------


def _normalize_for_serialization(data: Any) -> Any:
    """Normalize rich Python values into JSON-friendly structures."""
    if data is None or isinstance(data, (str, int, float, bool)):
        return data
    if isinstance(data, bytes):
        if len(data) > _MAX_INLINE_TOOL_BINARY_BYTES:
            return {
                "encoding": "base64_preview",
                "byte_length": len(data),
                "content_base64": base64.b64encode(
                    data[:_TOOL_BINARY_PREVIEW_BYTES]
                ).decode(),
            }
        return {
            "encoding": "base64",
            "byte_length": len(data),
            "content_base64": base64.b64encode(data).decode(),
        }
    if isinstance(data, Enum):
        return data.value
    if is_dataclass(data) and not isinstance(data, type):
        return _normalize_for_serialization(asdict(data))
    if isinstance(data, dict):
        return {
            str(key): _normalize_for_serialization(value) for key, value in data.items()
        }
    if isinstance(data, (list, tuple, set)):
        return [_normalize_for_serialization(item) for item in data]

    model_dump = getattr(data, "model_dump", None)
    if callable(model_dump):
        try:
            return _normalize_for_serialization(model_dump())
        except TypeError:
            pass

    to_dict = getattr(data, "to_dict", None)
    if callable(to_dict):
        try:
            return _normalize_for_serialization(to_dict())
        except TypeError:
            pass
    return data


def _to_toon(data: Any) -> str:
    """Encode data as TOON for token-efficient LLM responses, falling back to JSON."""
    normalized = _normalize_for_serialization(data)
    try:
        toon = toon_encode(normalized)
        compact_json = json.dumps(normalized, separators=(",", ":"), default=str)
        return toon if len(toon) <= len(compact_json) else compact_json
    except Exception:
        return json.dumps(normalized, default=str)


def _payload_size_bytes(value: Any) -> int:
    normalized = _normalize_for_serialization(value)
    try:
        return len(
            json.dumps(normalized, separators=(",", ":"), default=str).encode("utf-8")
        )
    except Exception:
        return len(str(normalized).encode("utf-8", errors="replace"))


# ---------------------------------------------------------------------------
# Method collection + description (discovery)
# ---------------------------------------------------------------------------


def collect_methods(module: Any) -> list[ToolMethod]:
    """Collect tools from a tool module.

    The module must have a ``_client()`` factory. Call it once to get a cached
    instance and expose every public method as a tool.
    """
    methods: list[ToolMethod] = []

    factory = getattr(module, "_client", None)
    if factory and callable(factory):
        instance = factory()
        for method_name, descriptor in sorted(
            vars(type(instance)).items(),
            key=lambda item: item[0],
        ):
            if method_name.startswith("_") or method_name in _LIFECYCLE_METHODS:
                continue
            if isinstance(descriptor, property):
                continue
            if not callable(descriptor):
                continue
            method = getattr(instance, method_name, None)
            if not inspect.ismethod(method):
                continue
            methods.append(ToolMethod(method_name, method))

    return methods


def _describe_method_docstring(doc: str | None) -> str:
    """Return the agent-facing description for a tool method's docstring.

    Keeps the full prose summary up to the first Google-style section marker
    (``Args:`` / ``Returns:`` / ``Raises:`` / etc.) or a
    ``_METHOD_DESCRIPTION_MAX_CHARS`` budget, whichever comes first.
    """
    if not doc:
        return ""
    text = inspect.cleandoc(doc)
    if not text:
        return ""
    boundary = len(text)
    for marker in _DOCSTRING_BOUNDARY_MARKERS:
        idx = text.find("\n" + marker)
        if idx == -1 and text.startswith(marker):
            idx = 0
        if 0 <= idx < boundary:
            boundary = idx
    summary = text[:boundary].rstrip()
    if len(summary) > _METHOD_DESCRIPTION_MAX_CHARS:
        summary = summary[: _METHOD_DESCRIPTION_MAX_CHARS - 1].rstrip() + "…"
    return summary


def _friendly_type_name(annotation: Any) -> str:
    """Convert a Python type annotation to a clean, human-readable string."""
    if annotation in _BUILTIN_TYPE_NAMES:
        return _BUILTIN_TYPE_NAMES[annotation]
    origin = getattr(annotation, "__origin__", None)
    args = getattr(annotation, "__args__", None)
    if (
        isinstance(annotation, types.UnionType)
        or (origin is not None and str(origin) == "typing.Union")
    ) and args:
        parts = [_friendly_type_name(a) for a in args]
        return " | ".join(parts)
    if origin is not None and args:
        base = _BUILTIN_TYPE_NAMES.get(origin, getattr(origin, "__name__", str(origin)))
        inner = ", ".join(_friendly_type_name(a) for a in args)
        return f"{base}[{inner}]"
    name = getattr(annotation, "__name__", None)
    if name:
        return name
    return str(annotation)


def describe_methods(methods: list[ToolMethod]) -> list[dict[str, Any]]:
    """Build the per-method schema list shared by ``GET /tools/{tool}`` and the
    local runner's ``__describe`` mode. Output shape is byte-stable across both.
    """
    method_schemas: list[dict[str, Any]] = []
    for method in sorted(methods, key=lambda m: m.method_name):
        description = _describe_method_docstring(method.fn.__doc__)
        try:
            sig = inspect.signature(method.fn)
        except (TypeError, ValueError) as exc:
            method_schemas.append(
                {
                    "name": method.method_name,
                    "description": description,
                    "parameters": {},
                    "signature_error": str(exc),
                }
            )
            continue
        params: dict[str, Any] = {}
        for pname, param in sig.parameters.items():
            if pname == "self":
                continue
            ptype = "any"
            if param.annotation is not inspect.Parameter.empty:
                ptype = _friendly_type_name(param.annotation)
            pinfo: dict[str, Any] = {"type": ptype}
            if param.default is not inspect.Parameter.empty:
                pinfo["default"] = param.default
            else:
                pinfo["required"] = True
            params[pname] = pinfo
        method_schemas.append(
            {
                "name": method.method_name,
                "description": description,
                "parameters": params,
            }
        )
    return method_schemas


# ---------------------------------------------------------------------------
# Local-runner-only: pyproject parsing, tool loading, timeouts, attachments
# ---------------------------------------------------------------------------


def read_tool_conf(tool_dir: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    """Return ``(project, [tool.centaur])`` tables from a tool's pyproject.toml."""
    with open(tool_dir / "pyproject.toml", "rb") as f:
        pyproject = tomllib.load(f)
    project = pyproject.get("project", {})
    tool_conf = pyproject.get("tool", {}).get("centaur", {})
    return project, tool_conf


def replace_mode_http_placeholders(tool_conf: dict[str, Any]) -> dict[str, str]:
    """Return ``{name: replacer}`` for the tool's replace-mode HTTP secrets only.

    This mirrors ``api.tool_manager._resolve_secrets`` for the subset the local
    runner is allowed to put in ``ToolContext.secrets``: replace-mode HTTP
    secrets. Their ``replacer`` placeholder is the token iron-proxy swaps for
    the real credential on the wire. Every other secret kind is deliberately
    excluded:

    - ``pg_dsn`` / other env-delivered values resolve via the StubBackend's
      env-first lookup so the tool gets the *real* DSN, not a placeholder.
    - ``inject``-mode HTTP, ``gcp_auth``, ``oauth_token``, ``brokered_token``,
      and ``hmac_sign`` secrets are applied entirely by iron-proxy and never
      reach the tool.

    A raw-string secret entry (the legacy shim) is a replace-mode HTTP secret
    whose name and replacer are both the literal string.
    """
    placeholders: dict[str, str] = {}
    for key in ("secrets", "optional_secrets"):
        entries = tool_conf.get(key) or []
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if isinstance(entry, str):
                placeholders[entry] = entry
                continue
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            if not isinstance(name, str) or not name:
                continue
            # ``header`` is a deprecated alias for ``http``.
            secret_type = entry.get("type", "http")
            if secret_type not in ("http", "header"):
                continue
            mode = entry.get("mode", "replace")
            if mode != "replace":
                continue
            replacer = entry.get("replacer")
            placeholders[name] = replacer if isinstance(replacer, str) and replacer else name
    return placeholders


def _parse_timeout_s(value: Any, *, default: float | None) -> float | None:
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in {"none", "disabled", "off"}:
        return None
    try:
        timeout_s = float(value)
    except (TypeError, ValueError):
        return default
    if timeout_s <= 0:
        return default
    return timeout_s


def resolve_timeout_s(tool_conf: dict[str, Any]) -> float | None:
    """Resolve a tool's per-call timeout from ``[tool.centaur]``.

    Mirrors ``api.tool_manager._resolve_timeout_s``: ``timeout_s`` (a number, or
    ``"none"`` to disable) overridden by ``timeout_env`` if that env var is set.
    """
    configured = _parse_timeout_s(tool_conf.get("timeout_s"), default=_TOOL_CALL_TIMEOUT_S)
    env_name = tool_conf.get("timeout_env")
    if isinstance(env_name, str) and env_name:
        env_value = os.getenv(env_name)
        if env_value:
            return _parse_timeout_s(env_value, default=configured)
    return configured


def _timeout_label(timeout_s: float | None) -> str:
    return "no timeout" if timeout_s is None else f"{timeout_s:g}s"


def iter_tool_dirs(base_dir: Path):
    """Yield tool directories under ``base_dir``, expanding one level of
    category subdirectories (e.g. ``tools/crypto/alchemy``), matching
    ``ToolManager._collect_tools``.
    """
    if not base_dir.exists():
        return
    for child in sorted(base_dir.iterdir()):
        if not child.is_dir() or child.name.startswith((".", "_")):
            continue
        if (child / "pyproject.toml").exists():
            yield child
        else:
            for sub in sorted(child.iterdir()):
                if (
                    sub.is_dir()
                    and not sub.name.startswith((".", "_"))
                    and (sub / "pyproject.toml").exists()
                ):
                    yield sub


def find_tool_dir(tool_dirs: list[Path], tool_name: str) -> Path | None:
    """Resolve a tool name to its directory across ``tool_dirs``.

    Later directories shadow earlier ones (private-overrides-public), matching
    ``ToolManager._collect_tools`` ordering.
    """
    found: Path | None = None
    for base_dir in tool_dirs:
        for tool_dir in iter_tool_dirs(base_dir):
            if tool_dir.name == tool_name:
                _, tool_conf = read_tool_conf(tool_dir)
                if tool_conf.get("type") == "persona":
                    continue
                found = tool_dir
    return found


def available_tool_names(tool_dirs: list[Path]) -> list[str]:
    names: set[str] = set()
    for base_dir in tool_dirs:
        for tool_dir in iter_tool_dirs(base_dir):
            _, tool_conf = read_tool_conf(tool_dir)
            if tool_conf.get("type") == "persona":
                continue
            names.add(tool_dir.name)
    return sorted(names)


def _ensure_runtime_namespaces() -> None:
    if "shared" not in sys.modules:
        ns = types.ModuleType("shared")
        ns.__path__ = []  # type: ignore[attr-defined]
        sys.modules["shared"] = ns
    if "shared.tools_runtime" not in sys.modules:
        ns = types.ModuleType("shared.tools_runtime")
        ns.__path__ = []  # type: ignore[attr-defined]
        sys.modules["shared.tools_runtime"] = ns


def load_tool_module(tool_dir: Path, tool_name: str, module_file: str = "client.py") -> Any:
    """Import a tool's module as a package so its relative imports resolve.

    Replicates ``ToolManager._load_tool``'s importlib machinery: registers the
    tool dir as ``shared.tools_runtime.<name>`` so ``from .client import X`` and
    ``from centaur_sdk import ...`` both work.
    """
    pkg_name = f"shared.tools_runtime.{tool_name}"
    init_path = tool_dir / "__init__.py"
    if init_path.exists():
        pkg_spec = importlib.util.spec_from_file_location(
            pkg_name,
            init_path,
            submodule_search_locations=[str(tool_dir)],
        )
        if pkg_spec and pkg_spec.loader:
            pkg_mod = importlib.util.module_from_spec(pkg_spec)
            sys.modules[pkg_name] = pkg_mod
            pkg_spec.loader.exec_module(pkg_mod)
    else:
        pkg_mod = types.ModuleType(pkg_name)
        pkg_mod.__path__ = [str(tool_dir)]  # type: ignore[attr-defined]
        sys.modules[pkg_name] = pkg_mod

    _ensure_runtime_namespaces()

    module_path = tool_dir / module_file
    if not module_path.exists():
        raise FileNotFoundError(f"tool module missing: {module_path}")

    mod_name = f"{pkg_name}.{Path(module_file).stem}"
    spec = importlib.util.spec_from_file_location(mod_name, module_path)
    if not spec or not spec.loader:
        raise ImportError(f"cannot load tool module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    module.__package__ = pkg_name  # type: ignore[attr-defined]
    sys.modules[mod_name] = module
    spec.loader.exec_module(module)
    return module


def _extract_tool_attachment(result: dict[str, Any], *, tool_name: str) -> dict[str, Any]:
    """If *result* carries a large base64 ``data`` field, persist it as a
    thread-scoped attachment via the SDK and replace the field with a
    download URL. Mirrors ``api.tool_manager._extract_tool_attachment`` but uses
    the ``save_attachment`` HTTP path (the runner has no DB access).
    """
    data_b64 = result.get("data")
    if not isinstance(data_b64, str) or len(data_b64) < _ATTACHMENT_EXTRACT_MIN_BYTES:
        return result
    if not re.fullmatch(r"[A-Za-z0-9+/=\n\r]+", data_b64[:256]):
        return result
    try:
        raw_bytes = base64.b64decode(data_b64)
    except Exception:
        return result

    mime_type = result.get("mime_type", "application/octet-stream")
    filename = result.get("filename") or f"{tool_name}_output"
    try:
        saved = save_attachment(name=filename, data=raw_bytes, mime_type=mime_type)
    except Exception:
        # Best-effort: if upload fails, leave the inline data rather than crash.
        return result

    out = {k: v for k, v in result.items() if k != "data"}
    if saved.get("attachment_id"):
        out["attachment_id"] = saved["attachment_id"]
    if saved.get("download_url"):
        out["download_url"] = saved["download_url"]
    return out


# ---------------------------------------------------------------------------
# Public runner API
# ---------------------------------------------------------------------------


def describe_tool(tool_dir: Path, tool_name: str | None = None) -> dict[str, Any]:
    """Return the same schema shape as ``GET /tools/{tool}``."""
    name = tool_name or tool_dir.name
    project, tool_conf = read_tool_conf(tool_dir)
    placeholders = replace_mode_http_placeholders(tool_conf)
    ctx = ToolContext(name=name, secrets=placeholders)
    token = set_tool_context(ctx)
    try:
        module = load_tool_module(tool_dir, name, tool_conf.get("module", "client.py"))
        methods = collect_methods(module)
    finally:
        reset_tool_context(token)
    return {
        "tool": name,
        "description": project.get("description", ""),
        "methods": describe_methods(methods),
    }


def list_tools(tool_dirs: list[Path]) -> dict[str, Any]:
    """Return the same schema shape as ``GET /tools`` (best-effort per tool)."""
    result: dict[str, Any] = {}
    for base_dir in tool_dirs:
        for tool_dir in iter_tool_dirs(base_dir):
            project, tool_conf = read_tool_conf(tool_dir)
            if tool_conf.get("type") == "persona":
                continue
            name = tool_dir.name
            placeholders = replace_mode_http_placeholders(tool_conf)
            ctx = ToolContext(name=name, secrets=placeholders)
            token = set_tool_context(ctx)
            try:
                module = load_tool_module(
                    tool_dir, name, tool_conf.get("module", "client.py")
                )
                methods = collect_methods(module)
            except Exception:
                # A tool that fails to import (e.g. a missing dependency in an
                # overlay tool) would otherwise vanish from discovery silently.
                # Log why so it's diagnosable instead of "just not there".
                log.warning(
                    "tool skipped during discovery (failed to load)",
                    extra={
                        "event": "tool_discovery_load_failed",
                        "tool": name,
                        "tool_dir": str(tool_dir),
                    },
                    exc_info=True,
                )
                continue
            finally:
                reset_tool_context(token)
            result[name] = {
                "description": project.get("description", ""),
                "methods": [m.method_name for m in methods],
            }
    return result


def run_tool_status(
    tool_dir: Path,
    tool: str,
    method_name: str,
    args: dict[str, Any],
    *,
    thread_key: str | None = None,
    fmt: str = "toon",
) -> tuple[str, bool]:
    """Invoke a tool method and return ``(rendered_output, ok)``.

    Behaviorally identical to ``ToolManager.call_tool(..., format=fmt)`` for the
    pure-Python path: same TOON success output and same ``{error, tool, method}``
    JSON error envelope. ``ok`` is False for any error envelope so the CLI can
    exit non-zero.
    """
    _, tool_conf = read_tool_conf(tool_dir)
    placeholders = replace_mode_http_placeholders(tool_conf)
    timeout_s = resolve_timeout_s(tool_conf)
    ctx = ToolContext(name=tool, secrets=placeholders, thread_key=thread_key)
    token = set_tool_context(ctx)
    try:
        try:
            module = load_tool_module(
                tool_dir, tool, tool_conf.get("module", "client.py")
            )
            methods = collect_methods(module)
        except Exception as exc:
            # Local load failure (import error, missing dep). Report it as a
            # parseable envelope and fail — the call is final, no fallback.
            return (
                json.dumps({"error": str(exc), "tool": tool, "method": method_name}),
                False,
            )

        method = next((m for m in methods if m.method_name == method_name), None)
        if method is None:
            return (
                json.dumps(
                    {
                        "error": f"Method '{method_name}' not found in tool '{tool}'",
                        "available_methods": sorted(m.method_name for m in methods),
                    }
                ),
                False,
            )

        validation_error = _tool_arg_validation_error(method, args)
        if validation_error is not None:
            return json.dumps(validation_error), False

        try:
            result = _invoke(method, args, timeout_s)
        except (SystemExit, Exception) as e:  # mirror server call_tool semantics
            if isinstance(e, asyncio.TimeoutError):
                error_msg = f"Tool call timed out after {_timeout_label(timeout_s)}"
            elif isinstance(e, SystemExit):
                error_msg = f"sys.exit({e.code})"
            else:
                error_msg = str(e)
            return (
                json.dumps({"error": error_msg, "tool": tool, "method": method_name}),
                False,
            )

        if isinstance(result, dict):
            result = _extract_tool_attachment(result, tool_name=tool)
        if fmt == "toon":
            rendered = result if isinstance(result, str) else _to_toon(result)
        else:
            rendered = json.dumps(_normalize_for_serialization(result), default=str)
        return rendered, True
    finally:
        reset_tool_context(token)


def run_tool(
    tool_dir: Path,
    tool: str,
    method_name: str,
    args: dict[str, Any],
    *,
    thread_key: str | None = None,
    fmt: str = "toon",
) -> str:
    """Convenience wrapper around :func:`run_tool_status` returning just the text."""
    return run_tool_status(
        tool_dir, tool, method_name, args, thread_key=thread_key, fmt=fmt
    )[0]


def _invoke(method: ToolMethod, args: dict[str, Any], timeout_s: float | None) -> Any:
    """Run a tool method (async inline / sync in a thread) under a timeout.

    Drives the coroutine on a private event loop so the runner works from a
    plain CLI. If a loop is already running (e.g. inside an async test or host
    process), the call is offloaded to a worker thread so ``asyncio.run`` is
    safe to use there too.
    """

    async def _call() -> Any:
        if inspect.iscoroutinefunction(method.fn):
            coro = method.fn(**args)
        else:
            coro = asyncio.to_thread(method.fn, **args)
        return await asyncio.wait_for(coro, timeout=timeout_s)

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(_call())

    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, _call()).result()


# ---------------------------------------------------------------------------
# CLI entrypoint
# ---------------------------------------------------------------------------

# Exit codes. A local tool call is final: success exits 0, any failure exits
# non-zero (and always prints a parseable envelope). There is no sidecar
# fallback — if a tool is routed locally and fails, it fails.
_CLI_SUCCESS = 0
_CLI_TOOL_ERROR = 1  # the call failed (not found / validation / exception / timeout / load)
_CLI_USAGE_ERROR = 2  # bad arguments to centaur-tool itself


def _emit_tool_metric(tool: str, method: str, ok: bool, duration_s: float) -> None:
    """Best-effort POST of per-call telemetry to the API metric-ingest endpoint.

    Restores the Prometheus parity that ``api.tool_manager.record_tool_call`` gave
    the sidecar path: a local tool call has no in-process metrics registry, so the
    runner reports ``{tool, method, success, duration_s}`` and the API records the
    same VictoriaMetrics series. Gated on ``CENTAUR_TOOL_METRICS`` so it is inert
    unless the sandbox opts in; never raises and never delays the call materially
    (short timeout, emitted after the result is already printed).
    """
    if os.getenv("CENTAUR_TOOL_METRICS", "").strip().lower() not in ("1", "true", "yes", "on"):
        return
    api_key = (os.getenv("CENTAUR_API_KEY") or "").strip()
    if not api_key:
        return
    try:
        base = (os.getenv("CENTAUR_API_URL") or "http://api:8000").rstrip("/")
        payload = json.dumps(
            {"tool": tool, "method": method, "success": ok, "duration_s": duration_s}
        ).encode()
        request = urllib.request.Request(
            f"{base}/agent/tools-data/tool-call-metric",
            data=payload,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=3):
            pass
    except Exception:
        # Metrics are best-effort and must never fail a tool call, but a
        # persistent failure should be visible rather than silently dropped.
        log.warning(
            "tool metric emission failed",
            extra={"event": "tool_metric_emit_failed", "tool": tool, "method": method},
            exc_info=True,
        )


def _tool_dirs_from_env() -> list[Path]:
    """Resolve the tool search path for the agent sandbox.

    ``CENTAUR_TOOL_DIRS`` (colon-separated) overrides; otherwise default to the
    baked base-tools dir plus the optional overlay dir (org tools), with overlay
    last so it shadows base.
    """
    raw = os.getenv("CENTAUR_TOOL_DIRS")
    if raw:
        return [Path(p) for p in raw.split(":") if p]
    dirs = [Path(os.getenv("CENTAUR_BASE_TOOLS_DIR", "/opt/centaur-tools/tools"))]
    overlay = os.getenv("CENTAUR_OVERLAY_DIR")
    if overlay:
        dirs.append(Path(overlay) / "tools")
    return dirs


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(json.dumps({"error": "usage: centaur-tool <tool> <method> [json]"}))
        return _CLI_USAGE_ERROR

    tool_dirs = _tool_dirs_from_env()

    head = argv[0]
    if head == "__list":
        print(json.dumps(list_tools(tool_dirs)))
        return _CLI_SUCCESS
    if head == "__describe":
        if len(argv) < 2:
            print(json.dumps({"error": "usage: centaur-tool __describe <tool>"}))
            return _CLI_USAGE_ERROR
        name = argv[1]
        tool_dir = find_tool_dir(tool_dirs, name)
        if tool_dir is None:
            print(
                json.dumps(
                    {
                        "error": f"Tool '{name}' not found",
                        "available": available_tool_names(tool_dirs),
                    }
                )
            )
            return _CLI_TOOL_ERROR
        print(json.dumps(describe_tool(tool_dir, name)))
        return _CLI_SUCCESS

    if len(argv) < 2:
        print(json.dumps({"error": "usage: centaur-tool <tool> <method> [json]"}))
        return _CLI_USAGE_ERROR

    tool, method_name = argv[0], argv[1]
    body = argv[2] if len(argv) > 2 else ""
    args: dict[str, Any] = {}
    if body:
        try:
            parsed = json.loads(body)
        except json.JSONDecodeError as exc:
            print(json.dumps({"error": f"invalid_json: {exc}", "tool": tool}))
            return _CLI_TOOL_ERROR
        if not isinstance(parsed, dict):
            print(json.dumps({"error": "body must be a JSON object", "tool": tool}))
            return _CLI_TOOL_ERROR
        args = parsed

    tool_dir = find_tool_dir(tool_dirs, tool)
    if tool_dir is None:
        print(
            json.dumps(
                {
                    "error": f"Tool '{tool}' not found",
                    "available": available_tool_names(tool_dirs),
                }
            )
        )
        return _CLI_TOOL_ERROR

    thread_key = os.getenv("CENTAUR_THREAD_KEY") or None
    t0 = time.monotonic()
    try:
        rendered, ok = run_tool_status(
            tool_dir, tool, method_name, args, thread_key=thread_key, fmt="toon"
        )
    except Exception as exc:  # defensive: run_tool_status already envelopes its errors
        print(json.dumps({"error": str(exc), "tool": tool, "method": method_name}))
        _emit_tool_metric(tool, method_name, False, time.monotonic() - t0)
        return _CLI_TOOL_ERROR
    # A definitive result: print the envelope; exit 0 on success, non-zero on a
    # tool/validation/timeout error.
    print(rendered)
    _emit_tool_metric(tool, method_name, ok, time.monotonic() - t0)
    return _CLI_SUCCESS if ok else _CLI_TOOL_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
