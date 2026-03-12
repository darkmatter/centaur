"""Tool discovery, loading, and registration."""

from __future__ import annotations

import asyncio
import base64
import importlib.util
import inspect
import json
import os
import re
import sys
import threading
import time
import tomllib
import types
from collections.abc import Callable
from dataclasses import asdict, dataclass, is_dataclass
from enum import Enum
from pathlib import Path
from typing import Any, ClassVar

import httpx
import structlog
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import PlainTextResponse
from toon_format import encode as toon_encode

from api.api_keys import check_scope
from api.deps import get_key_info, verify_api_key
from centaur_sdk import ToolContext, reset_tool_context, set_tool_context

log = structlog.get_logger()

_FIREWALL_URL = os.environ.get("FIREWALL_HEALTH_URL", "http://firewall:8081")
_secret_cache: dict[str, tuple[str, float]] = {}
_SECRET_CACHE_TTL = 60


async def _resolve_secrets(keys: list[str]) -> dict[str, str]:
    """Fetch secrets from the firewall sidecar, with a short TTL cache."""
    now = time.monotonic()
    result: dict[str, str] = {}
    missing: list[str] = []
    for k in keys:
        cached = _secret_cache.get(k)
        if cached and (now - cached[1]) < _SECRET_CACHE_TTL:
            result[k] = cached[0]
        else:
            missing.append(k)
    if not missing:
        return result
    async with httpx.AsyncClient(timeout=5) as client:
        for k in missing:
            try:
                resp = await client.get(f"{_FIREWALL_URL}/secrets/{k}")
                if resp.status_code == 200:
                    val = resp.json().get("value", "")
                    if val:
                        result[k] = val
                        _secret_cache[k] = (val, now)
            except Exception:
                pass
    return result

_MAX_INLINE_TOOL_BINARY_BYTES = max(
    1024, int(os.getenv("TOOL_BINARY_INLINE_MAX_BYTES", str(1 * 1024 * 1024)))
)
_TOOL_BINARY_PREVIEW_BYTES = max(128, int(os.getenv("TOOL_BINARY_PREVIEW_BYTES", str(32 * 1024))))


class ToolMethod:
    def __init__(self, method_name: str, fn: Callable):
        self.method_name = method_name
        self.fn = fn


_LIFECYCLE_METHODS = frozenset({"close", "connect", "disconnect", "shutdown"})


def _normalize_for_serialization(data: Any) -> Any:
    """Normalize rich Python values into JSON-friendly structures."""
    if data is None or isinstance(data, (str, int, float, bool)):
        return data
    if isinstance(data, bytes):
        if len(data) > _MAX_INLINE_TOOL_BINARY_BYTES:
            return {
                "encoding": "base64_preview",
                "byte_length": len(data),
                "content_base64": base64.b64encode(data[:_TOOL_BINARY_PREVIEW_BYTES]).decode(),
            }
        return {
            "encoding": "base64",
            "byte_length": len(data),
            "content_base64": base64.b64encode(data).decode(),
        }
    if isinstance(data, Enum):
        return data.value
    if is_dataclass(data):
        return _normalize_for_serialization(asdict(data))
    if isinstance(data, dict):
        return {str(key): _normalize_for_serialization(value) for key, value in data.items()}
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


def _friendly_type_name(annotation: Any) -> str:
    """Convert a Python type annotation to a clean, human-readable string.

    Avoids raw ``<class 'str'>`` output by using simple names for built-in types
    and ``str()`` for union / generic forms.
    """
    if annotation in _BUILTIN_TYPE_NAMES:
        return _BUILTIN_TYPE_NAMES[annotation]
    origin = getattr(annotation, "__origin__", None)
    args = getattr(annotation, "__args__", None)
    # typing.Optional / Union
    if (
        origin is types.UnionType or (origin is not None and str(origin) == "typing.Union")
    ) and args:
        parts = [_friendly_type_name(a) for a in args]
        return " | ".join(parts)
    # list[X], dict[K, V], etc.
    if origin is not None and args:
        base = _BUILTIN_TYPE_NAMES.get(origin, getattr(origin, "__name__", str(origin)))
        inner = ", ".join(_friendly_type_name(a) for a in args)
        return f"{base}[{inner}]"
    # Plain class — use __name__ if available
    name = getattr(annotation, "__name__", None)
    if name:
        return name
    # Fallback
    return str(annotation)


class LoadedTool:
    def __init__(
        self,
        name: str,
        description: str,
        ctx: ToolContext,
        methods: list[ToolMethod],
        hosts: list[str] | None = None,
        secrets_keys: list[str] | None = None,
    ):
        self.name = name
        self.description = description
        self.ctx = ctx
        self.methods = methods
        self.hosts: list[str] = hosts or []
        self.secrets_keys: list[str] = secrets_keys or []


@dataclass
class LoadedPersona:
    name: str
    description: str
    engine: str
    default_repo: str | None
    prompt_content: str
    prompt_file: str
    has_custom_executor: bool  # True if run.py exists in the persona dir
    tool_dir: Path


def load_plugins_config(config_path: Path) -> list[Path]:
    """Read a tools.toml and return resolved plugin directory paths.

    The TOML file is expected to contain a ``plugin_dirs`` key whose value is a
    list of directory paths (strings).  Relative paths are resolved against the
    config file's parent directory.  Returns an empty list when the file does not
    exist.
    """
    if not config_path.exists():
        return []
    base = config_path.parent
    with open(config_path, "rb") as f:
        data = tomllib.load(f)
    dirs: list[Path] = []
    for entry in data.get("plugin_dirs", []):
        p = Path(entry)
        dirs.append(p if p.is_absolute() else (base / p).resolve())
    return dirs


class ToolManager:
    def __init__(
        self,
        tools_dir: Path | list[Path],
    ):
        if isinstance(tools_dir, list):
            self.tools_dirs: list[Path] = list(tools_dir)
        else:
            self.tools_dirs = [tools_dir]
        self.tools: dict[str, LoadedTool] = {}
        self.personas: dict[str, LoadedPersona] = {}
        self.load_failures: list[dict[str, str]] = []
        self._reload_lock = threading.Lock()

    def _collect_tools(self) -> list[tuple[Path, dict]]:
        """Read pyproject.toml from each tool dir.

        Directories in ``self.tools_dirs`` are scanned in order.  When the same
        tool name appears in a later directory it shadows the earlier one (useful
        for private-overrides-public).

        Supports one level of category subdirectories: if a child directory has
        no ``pyproject.toml`` it is treated as a category folder and its children
        are scanned for tools (e.g. ``tools/crypto/alchemy/``).
        """
        seen: dict[str, int] = {}
        tools: list[tuple[Path, dict]] = []
        for dir_idx, base_dir in enumerate(self.tools_dirs):
            if not base_dir.exists():
                continue
            # Collect candidate tool dirs, expanding category subdirectories
            candidates: list[Path] = []
            for child in sorted(base_dir.iterdir()):
                if not child.is_dir() or child.name.startswith((".", "_")):
                    continue
                if (child / "pyproject.toml").exists():
                    candidates.append(child)
                else:
                    # Category dir — scan its children
                    for sub in sorted(child.iterdir()):
                        if sub.is_dir() and not sub.name.startswith((".", "_")):
                            candidates.append(sub)

            for tool_dir in candidates:
                pyproject_path = tool_dir / "pyproject.toml"
                if not pyproject_path.exists():
                    continue

                with open(pyproject_path, "rb") as f:
                    pyproject = tomllib.load(f)

                project = pyproject.get("project", {})
                tool_conf = pyproject.get("tool", {}).get("ai-v2", {})

                name = tool_dir.name
                hosts = tool_conf.get("hosts", [])
                secrets_keys = tool_conf.get("secrets", [])

                # Validate host patterns
                for h in hosts:
                    if h in ("*", "*.com", "*.org", "*.net", "*.io"):
                        log.warning("tool_invalid_host", tool=name, host=h,
                                    reason="catch-all domain not allowed")
                    elif re.match(r"^\d+\.\d+\.\d+\.\d+$", h):
                        log.warning("tool_invalid_host", tool=name, host=h,
                                    reason="IP addresses not allowed")

                # Skip persona entries — they are loaded separately
                if tool_conf.get("type") == "persona":
                    continue

                meta = {
                    "name": name,
                    "description": project.get("description", ""),
                    "module": tool_conf.get("module", "client.py"),
                    "hosts": hosts,
                    "secrets_keys": secrets_keys,
                }

                if name in seen:
                    prev_idx = seen[name]
                    prev_pos = next(i for i, (_, m) in enumerate(tools) if m["name"] == name)
                    log.info(
                        "tool_shadowed",
                        tool=name,
                        shadowed_dir=str(self.tools_dirs[prev_idx]),
                        by_dir=str(base_dir),
                    )
                    tools[prev_pos] = (tool_dir, meta)
                else:
                    tools.append((tool_dir, meta))
                seen[name] = dir_idx
        return tools

    def _collect_personas(self) -> list[tuple[Path, dict, dict]]:
        """Scan tools dirs for persona entries (type=persona in pyproject.toml)."""
        personas: list[tuple[Path, dict, dict]] = []
        for base_dir in self.tools_dirs:
            if not base_dir.exists():
                continue
            for child in sorted(base_dir.iterdir()):
                if not child.is_dir() or child.name.startswith((".", "_")):
                    continue
                # Check direct children and category subdirectories
                candidates: list[Path] = []
                if (child / "pyproject.toml").exists():
                    candidates.append(child)
                else:
                    for sub in sorted(child.iterdir()):
                        if sub.is_dir() and not sub.name.startswith((".", "_")):
                            if (sub / "pyproject.toml").exists():
                                candidates.append(sub)

                for tool_dir in candidates:
                    with open(tool_dir / "pyproject.toml", "rb") as f:
                        pyproject = tomllib.load(f)
                    project = pyproject.get("project", {})
                    tool_conf = pyproject.get("tool", {}).get("ai-v2", {})
                    if tool_conf.get("type") != "persona":
                        continue
                    personas.append((tool_dir, project, tool_conf))
        return personas

    def _load_persona(self, tool_dir: Path, project: dict, tool_conf: dict) -> LoadedPersona:
        """Load a single persona from its directory."""
        name = tool_dir.name
        prompt_file = tool_conf.get("prompt", "PROMPT.md")
        prompt_path = tool_dir / prompt_file
        prompt_content = prompt_path.read_text() if prompt_path.exists() else ""
        has_custom_executor = (tool_dir / "run.py").exists()
        return LoadedPersona(
            name=name,
            description=project.get("description", ""),
            engine=tool_conf.get("engine", "amp"),
            default_repo=tool_conf.get("default_repo"),
            prompt_content=prompt_content,
            prompt_file=prompt_file,
            has_custom_executor=has_custom_executor,
            tool_dir=tool_dir,
        )

    def get_persona(self, name: str) -> LoadedPersona | None:
        """Return a loaded persona by name, or None."""
        return self.personas.get(name)

    def discover(self) -> list[LoadedTool]:
        """Discover and load all tools and personas."""
        existing = [d for d in self.tools_dirs if d.exists()]
        if not existing:
            self.load_failures = []
            log.info("tools_dirs_missing", paths=[str(d) for d in self.tools_dirs])
            return []

        tool_entries = self._collect_tools()

        # Load each tool
        loaded = []
        load_failures: list[dict[str, str]] = []
        for tool_dir, meta in tool_entries:
            try:
                lt = self._load_tool(tool_dir, meta)
                if lt:
                    loaded.append(lt)
            except Exception as exc:
                tool_name = str(meta.get("name", tool_dir.name))
                load_failures.append({"name": tool_name, "error": str(exc)})
                log.warning(
                    "tool_load_failed",
                    tool=tool_name,
                    error=str(exc),
                )

        self.load_failures = load_failures
        self.tools = {p.name: p for p in loaded}

        # Load personas
        personas: dict[str, LoadedPersona] = {}
        for tool_dir, project, tool_conf in self._collect_personas():
            try:
                persona = self._load_persona(tool_dir, project, tool_conf)
                personas[persona.name] = persona
                log.info("persona_loaded", persona=persona.name, engine=persona.engine)
            except Exception as exc:
                log.warning("persona_load_failed", persona=tool_dir.name, error=str(exc))
        self.personas = personas

        log.info(
            "tools_discovery_complete",
            loaded=len(loaded),
            failed=len(load_failures),
            failed_tools=[f["name"] for f in load_failures],
            personas=list(personas.keys()),
        )
        return loaded

    # Hardcoded infrastructure entries for the injection map.
    _INFRA_INJECTION_MAP: ClassVar[dict[str, list[str]]] = {
        "api.anthropic.com": ["ANTHROPIC_API_KEY"],
        "api.openai.com": ["OPENAI_API_KEY"],
        "api.x.ai": ["XAI_API_KEY"],
        "generativelanguage.googleapis.com": ["GEMINI_API_KEY"],
        "ampcode.com": ["AMP_API_KEY"],
        "github.com": ["GITHUB_TOKEN"],
        "api.github.com": ["GITHUB_TOKEN"],
        "*.slack.com": ["SLACK_BOT_TOKEN"],
    }

    def build_injection_map(self) -> dict[str, list[str]]:
        """Build host→allowed_keys injection map from tool manifests + infra entries."""
        result: dict[str, set[str]] = {}

        # 1. Hardcoded infra entries
        for host, keys in self._INFRA_INJECTION_MAP.items():
            result.setdefault(host, set()).update(keys)

        # 2. Dynamic tool entries
        for lt in self.tools.values():
            if not lt.hosts or not lt.secrets_keys:
                continue
            for host in lt.hosts:
                result.setdefault(host, set()).update(lt.secrets_keys)

        return {host: sorted(keys) for host, keys in sorted(result.items())}

    def reload(self) -> dict[str, Any]:
        """Reload all tools by clearing module caches and re-discovering."""
        with self._reload_lock:
            stale = [k for k in sys.modules if k.startswith("shared.tools_runtime.")]
            for k in stale:
                del sys.modules[k]

            loaded = self.discover()
            return {
                "reloaded": len(loaded),
                "tools": [p.name for p in loaded],
            }

    def _load_tool(self, tool_dir: Path, manifest: dict) -> LoadedTool | None:
        name = manifest["name"]
        ctx = ToolContext(name=name, secrets={})

        # Register the tool dir as a package so relative imports work
        pkg_name = f"shared.tools_runtime.{name}"
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
            # Create a virtual package
            pkg_mod = types.ModuleType(pkg_name)
            pkg_mod.__path__ = [str(tool_dir)]  # type: ignore[attr-defined]
            sys.modules[pkg_name] = pkg_mod

        # Ensure parent namespaces exist
        if "shared" not in sys.modules:
            ns = types.ModuleType("shared")
            ns.__path__ = []  # type: ignore[attr-defined]
            sys.modules["shared"] = ns
        if "shared.tools_runtime" not in sys.modules:
            ns = types.ModuleType("shared.tools_runtime")
            ns.__path__ = []  # type: ignore[attr-defined]
            sys.modules["shared.tools_runtime"] = ns

        # Import the tool module
        module_file = manifest.get("module", "client.py")
        module_path = tool_dir / module_file
        if not module_path.exists():
            log.warning("tool_module_missing", tool=name, module=module_file)
            return None

        mod_name = f"{pkg_name}.{Path(module_file).stem}"
        spec = importlib.util.spec_from_file_location(mod_name, module_path)
        if not spec or not spec.loader:
            return None
        module = importlib.util.module_from_spec(spec)
        module.__package__ = pkg_name  # type: ignore[attr-defined]
        sys.modules[mod_name] = module

        # Set tool context so _client() factories can call secret()
        token = set_tool_context(ctx)
        try:
            spec.loader.exec_module(module)
            methods = self._collect_methods(module)
        finally:
            reset_tool_context(token)

        description = manifest.get("description", "")
        loaded_tool = LoadedTool(
            name=name,
            description=description,
            ctx=ctx,
            methods=methods,
            hosts=manifest.get("hosts", []),
            secrets_keys=manifest.get("secrets_keys", []),
        )
        log.info(
            "tool_loaded",
            tool=name,
            methods=[m.method_name for m in methods],
        )
        return loaded_tool

    @staticmethod
    def _collect_methods(module: Any) -> list[ToolMethod]:
        """Collect tools from a tool module.

        The module must have a _client() factory. Call it once to get a cached
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

    def describe_tool(self, tool_name: str) -> dict[str, Any]:
        """Return full method schemas for a tool's methods."""
        lt = self.tools.get(tool_name)
        if not lt:
            return {
                "error": f"Tool '{tool_name}' not found",
                "available": sorted(self.tools.keys()),
            }
        method_schemas: list[dict[str, Any]] = []
        for method in sorted(lt.methods, key=lambda m: m.method_name):
            try:
                sig = inspect.signature(method.fn)
            except (TypeError, ValueError) as exc:
                method_schemas.append(
                    {
                        "name": method.method_name,
                        "description": (method.fn.__doc__ or "").strip().split("\n")[0],
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
                    "description": (method.fn.__doc__ or "").strip().split("\n")[0],
                    "parameters": params,
                }
            )
        return {
            "tool": lt.name,
            "description": lt.description,
            "methods": method_schemas,
        }

    async def call_tool(self, tool_name: str, method_name: str, args: dict[str, Any]) -> str:
        """Call a tool method by name and return the result as a TOON string."""
        lt = self.tools.get(tool_name)
        if not lt:
            return json.dumps(
                {"error": f"Tool '{tool_name}' not found", "available": sorted(self.tools.keys())}
            )

        method = next((m for m in lt.methods if m.method_name == method_name), None)
        if not method:
            return json.dumps(
                {
                    "error": f"Method '{method_name}' not found in tool '{tool_name}'",
                    "available_methods": sorted(m.method_name for m in lt.methods),
                }
            )

        t0 = time.monotonic()
        log.info("tool_call_started", tool_name=tool_name, tool_method=method_name)

        # Resolve real secrets for tools that declare them
        ctx = lt.ctx
        if lt.secrets_keys:
            resolved = await _resolve_secrets(lt.secrets_keys)
            log.info("tool_secrets_resolved", tool=tool_name, keys=list(resolved.keys()),
                     declared=lt.secrets_keys)
            if resolved:
                ctx = ToolContext(name=lt.name, secrets={**lt.ctx.secrets, **resolved})

        token = set_tool_context(ctx)
        try:
            if inspect.iscoroutinefunction(method.fn):
                result = await method.fn(**args)
            else:
                result = await asyncio.to_thread(method.fn, **args)
            duration_ms = round((time.monotonic() - t0) * 1000)
            log.info(
                "tool_call_completed",
                tool_name=tool_name,
                tool_method=method_name,
                duration_ms=duration_ms,
                success=True,
            )
            if isinstance(result, str):
                return result
            return _to_toon(result)
        except (SystemExit, Exception) as e:
            duration_ms = round((time.monotonic() - t0) * 1000)
            error_msg = f"sys.exit({e.code})" if isinstance(e, SystemExit) else str(e)
            log.warning(
                "tool_call_completed",
                tool_name=tool_name,
                tool_method=method_name,
                duration_ms=duration_ms,
                success=False,
                error=error_msg,
            )
            return json.dumps({"error": error_msg, "tool": tool_name, "method": method_name})
        finally:
            reset_tool_context(token)

    def create_rest_router(self) -> APIRouter:
        """Create a stable FastAPI router that dispatches to tools via live lookup.

        Routes are fixed at registration time — tool calls resolve through
        ``self.tools`` at request time so hot-reloads take effect without
        swapping routes.
        """
        pm = self
        router = APIRouter(
            prefix="/tools",
            dependencies=[Depends(verify_api_key)],
        )

        def _require_tool_scope(request: Request, tool_name: str) -> None:
            key_info = get_key_info(request)
            if not check_scope(key_info, "tools", tool_name):
                raise HTTPException(
                    status_code=403,
                    detail=f"API key does not have access to tool '{tool_name}'",
                )

        @router.get("")
        async def list_tools(request: Request) -> dict:
            key_info = get_key_info(request)
            result = {}
            for name, p in pm.tools.items():
                if not check_scope(key_info, "tools", name):
                    continue
                result[name] = {
                    "description": p.description,
                    "methods": [m.method_name for m in p.methods],
                }
            return result

        # ── Persona endpoints (registered before catch-all /{tool_name}) ─────

        @router.get("/personas")
        async def list_personas() -> dict:
            return {
                name: {
                    "description": p.description,
                    "engine": p.engine,
                    "default_repo": p.default_repo,
                    "has_custom_executor": p.has_custom_executor,
                }
                for name, p in pm.personas.items()
            }

        @router.get("/personas/{name}")
        async def get_persona_detail(name: str) -> dict:
            p = pm.personas.get(name)
            if not p:
                raise HTTPException(status_code=404, detail=f"Persona '{name}' not found")
            return {
                "name": p.name,
                "description": p.description,
                "engine": p.engine,
                "default_repo": p.default_repo,
                "prompt_file": p.prompt_file,
                "has_custom_executor": p.has_custom_executor,
                "tool_dir": str(p.tool_dir),
            }

        @router.get("/personas/{name}/prompt")
        async def get_persona_prompt(name: str):
            p = pm.personas.get(name)
            if not p:
                raise HTTPException(status_code=404, detail=f"Persona '{name}' not found")
            return PlainTextResponse(p.prompt_content)

        # ── Tool endpoints ───────────────────────────────────────────────────

        @router.get("/{tool_name}")
        async def describe_tool(tool_name: str, request: Request) -> dict:
            _require_tool_scope(request, tool_name)
            return pm.describe_tool(tool_name)

        @router.post("/{tool_name}/{method_name}")
        async def call_tool(tool_name: str, method_name: str, request: Request):
            raw_body = await request.body()
            body: dict[str, Any] = {}
            if raw_body:
                try:
                    body = json.loads(raw_body)
                except json.JSONDecodeError as exc:
                    raise HTTPException(status_code=400, detail="Request body must be valid JSON") from exc
                if not isinstance(body, dict):
                    raise HTTPException(status_code=400, detail="Request body must be a JSON object")
            _require_tool_scope(request, tool_name)
            result = await pm.call_tool(tool_name, method_name, body)
            if "text/plain" in request.headers.get("accept", ""):
                return PlainTextResponse(result)
            return {"tool": tool_name, "method": method_name, "result": result}

        return router



