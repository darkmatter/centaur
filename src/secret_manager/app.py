"""Secret Manager — cached mirror of 1Password secrets.

A lightweight sidecar service that loads all secrets from a 1Password vault
on startup and serves them over HTTP.  Other services (API, ETL) query this
instead of talking to 1Password directly, so they can restart without
re-fetching.

Uses the official 1Password Python SDK with a service account token.
The SDK maintains its own authenticated session and refreshes it
automatically — no CLI or manual signin needed.

Requires ``OP_SERVICE_ACCOUNT_TOKEN`` in the environment.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import secrets as _secrets_mod
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from onepassword.client import Client

from shared.json_logging import JsonFormatter, configure_json_logger

log = configure_json_logger("secret_manager", "secret_manager")

# Uvicorn access/error log → JSON stdout (same schema as app logs)
_uvi_fmt = JsonFormatter("secret_manager")
_uvi_handler = logging.StreamHandler(sys.stdout)
_uvi_handler.setFormatter(_uvi_fmt)
for _uvi_name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
    _uvi_logger = logging.getLogger(_uvi_name)
    _uvi_logger.handlers = [_uvi_handler]
    _uvi_logger.propagate = False

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_VAULT_NAME = os.environ.get("OP_VAULT") or "ai-agents"
_REFRESH_INTERVAL = int(os.environ.get("SECRET_REFRESH_SECONDS", "300"))  # 5 min
_REFRESH_RETRY_INTERVAL = int(os.environ.get("SECRET_REFRESH_RETRY_SECONDS", "15"))

# In-memory cache: key → value
_cache: dict[str, str] = {}
_last_refresh_error: str | None = None

# SDK client — initialised once at startup
_client: Client | None = None

# Optional Bearer token for authenticating requests to sensitive endpoints.
_SECRET_MANAGER_TOKEN = os.environ.get("SECRET_MANAGER_TOKEN", "")


# ---------------------------------------------------------------------------
# 1Password SDK helpers
# ---------------------------------------------------------------------------


def _normalize(title: str) -> str:
    """Convert a human-readable title to an ENV_VAR_NAME."""
    return re.sub(r"[^A-Z0-9]", "_", title.upper()).strip("_")


# All vault items are now named with canonical ENV_VAR names directly.
_ALIASES: dict[str, list[str]] = {}


async def _init_client() -> Client:
    """Create and authenticate a 1Password SDK client."""
    token = os.environ.get("OP_SERVICE_ACCOUNT_TOKEN", "")
    if not token:
        raise RuntimeError("OP_SERVICE_ACCOUNT_TOKEN is not set")
    return await Client.authenticate(
        auth=token,
        integration_name="ai-v2-secret-manager",
        integration_version="1.0.0",
    )


async def _find_vault_id(client: Client, name: str) -> str:
    """Find a vault ID by name."""
    # onepassword-sdk versions expose either list() or list_all().
    vaults = await _list_vaults(client)
    for v in vaults:
        title = getattr(v, "title", "")
        vid = getattr(v, "id", "")
        if title == name or vid == name:
            return v.id

    # If the service account only has access to one vault, prefer it.
    if len(vaults) == 1:
        only = vaults[0]
        log.warning(
            "vault '%s' not found; using only accessible vault '%s'",
            name,
            getattr(only, "title", getattr(only, "id", "<unknown>")),
        )
        return only.id

    available = ", ".join(str(getattr(v, "title", getattr(v, "id", "<unknown>"))) for v in vaults)
    raise RuntimeError(f"Vault '{name}' not found (available: {available})")


async def _list_vaults(client: Client) -> list[Any]:
    list_all = getattr(client.vaults, "list_all", None)
    if callable(list_all):
        vault_iter = await list_all()
        return [v async for v in vault_iter]
    return list(await client.vaults.list())


async def _list_items(client: Client, vault_id: str) -> list[Any]:
    list_all = getattr(client.items, "list_all", None)
    if callable(list_all):
        item_iter = await list_all(vault_id)
        return [item async for item in item_iter]
    return list(await client.items.list(vault_id))


# Preferred field IDs to extract a secret value from a full Item, in priority order.
_FIELD_IDS = ("password", "credential", "api_key", "key", "token", "secret", "value", "notesPlain")

# Built-in field IDs that should not be treated as named sub-fields.
_BUILTIN_FIELD_IDS = frozenset(_FIELD_IDS) | frozenset(("username", "url"))

# items.get_all() supports up to 50 items per call.
_GET_ALL_BATCH = 50


def _extract_value(item: Any) -> str | None:
    """Pick the best secret value from a fully-fetched Item's fields."""
    fields = getattr(item, "fields", []) or []
    # Try by field id first (most reliable), then by title.
    for target in _FIELD_IDS:
        for f in fields:
            if getattr(f, "id", "") == target and getattr(f, "value", ""):
                return f.value
    for target in _FIELD_IDS:
        for f in fields:
            if getattr(f, "title", "").lower() == target and getattr(f, "value", ""):
                return f.value
    # Fall back to notes.
    notes = getattr(item, "notes", "")
    if notes:
        return notes
    return None


def _extract_named_fields(item: Any) -> dict[str, str]:
    """Extract individually-named fields from a multi-field item.

    Returns a dict of {field_title: field_value} for custom fields that have
    meaningful titles (not built-in IDs like "password" or "notesPlain").
    """
    fields = getattr(item, "fields", []) or []
    result: dict[str, str] = {}
    for f in fields:
        field_title = getattr(f, "title", "").strip()
        field_value = getattr(f, "value", "")
        field_id = getattr(f, "id", "")
        if not field_title or not field_value:
            continue
        if field_id in _BUILTIN_FIELD_IDS or field_title.lower() in _BUILTIN_FIELD_IDS:
            continue
        result[field_title] = field_value
    return result


async def _load_all() -> int:
    """Fetch every item from the vault and populate the cache.

    Uses ``items.get_all()`` to batch-fetch full items (up to 50 per call)
    instead of resolving each field individually, cutting load time from
    ~27 s to ~2-3 s.

    Returns the number of secrets loaded.
    """
    global _client, _cache, _last_refresh_error
    if _client is None:
        _client = await _init_client()

    vault_id = await _find_vault_id(_client, _VAULT_NAME)
    items = await _list_items(_client, vault_id)

    # Collect item IDs and titles from the overview list.
    overviews: list[tuple[str, str]] = []
    for item_overview in items:
        item_id = getattr(item_overview, "id", "")
        item_title = getattr(item_overview, "title", "")
        if item_id:
            overviews.append((item_id, item_title))

    # Batch-fetch full items via get_all (50 per call).
    full_items: list[Any] = []
    for i in range(0, len(overviews), _GET_ALL_BATCH):
        batch_ids = [oid for oid, _ in overviews[i : i + _GET_ALL_BATCH]]
        resp = await _client.items.get_all(vault_id, batch_ids)
        for r in resp.individual_responses:
            if r.content is not None:
                full_items.append(r.content)

    new_cache: dict[str, str] = {}
    for item in full_items:
        title = getattr(item, "title", "")

        # Multi-field items: each named field becomes its own cache key.
        named = _extract_named_fields(item)
        if named:
            for field_name, field_value in named.items():
                new_cache[field_name] = field_value
                norm = _normalize(field_name)
                if norm != field_name:
                    new_cache[norm] = field_value

        # Single-value fallback: store under item title.
        value = _extract_value(item)
        if not value and not named:
            log.debug("skipping item %s — no resolvable field", title)
            continue
        if value:
            new_cache[title] = value
            norm = _normalize(title)
            if norm != title:
                new_cache[norm] = value

    # Apply aliases: if a canonical env var name is missing, resolve it
    # from known 1Password item names.
    for alias, sources in _ALIASES.items():
        if alias not in new_cache:
            for source in sources:
                if source in new_cache:
                    new_cache[alias] = new_cache[source]
                    break

    # Atomic swap — avoids readers seeing an empty cache during refresh
    _cache = new_cache
    _last_refresh_error = None
    log.info(
        "loaded %d keys from vault '%s': %s",
        len(_cache),
        _VAULT_NAME,
        ", ".join(sorted(_cache.keys())),
    )
    return len(_cache)


# ---------------------------------------------------------------------------
# Background refresh
# ---------------------------------------------------------------------------


async def _refresh_loop(initial_delay: int) -> None:
    global _last_refresh_error
    delay = initial_delay
    while True:
        await asyncio.sleep(delay)
        try:
            await _load_all()
            delay = _REFRESH_INTERVAL
        except Exception as exc:
            _last_refresh_error = str(exc)
            log.exception("refresh failed")
            delay = _REFRESH_RETRY_INTERVAL


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    global _last_refresh_error
    token = os.environ.get("OP_SERVICE_ACCOUNT_TOKEN", "")
    if not token:
        log.critical(
            "OP_SERVICE_ACCOUNT_TOKEN is not set. "
            "The secrets container MUST be started via CI (GitHub Actions) "
            "which injects this token. NEVER manually recreate this container. "
            "Run: gh workflow run deploy.yml --repo paradigmxyz/ai_v2"
        )
        raise SystemExit(1)

    log.info("loading secrets from vault '%s' ...", _VAULT_NAME)
    initial_delay = _REFRESH_INTERVAL
    try:
        await _load_all()
    except Exception as exc:
        _last_refresh_error = str(exc)
        # Start in degraded mode so API/ETL can boot; background refresh retries.
        log.exception("initial secret load failed; starting in degraded mode")
        initial_delay = _REFRESH_RETRY_INTERVAL

    task = asyncio.create_task(_refresh_loop(initial_delay))
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="Secret Manager", version="0.1.0", lifespan=lifespan)


async def verify_internal_token(
    authorization: str | None = Header(None),
) -> None:
    """Require a valid Bearer token on sensitive endpoints.

    If SECRET_MANAGER_TOKEN is not set, auth is skipped (backwards compatible).
    """
    if not _SECRET_MANAGER_TOKEN:
        return
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization[7:]
    if not _secrets_mod.compare_digest(token, _SECRET_MANAGER_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid token")


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if _last_refresh_error is None else "degraded",
        "cached_keys": len(_cache),
        "last_refresh_error": _last_refresh_error,
    }


@app.get("/keys", dependencies=[Depends(verify_internal_token)])
def list_keys() -> dict:
    """List all cached key names (values are never exposed)."""
    return {"keys": sorted(_cache.keys()), "count": len(_cache)}


@app.post("/reload", dependencies=[Depends(verify_internal_token)])
async def reload_secrets() -> dict:
    """Force an immediate refresh from 1Password."""
    count = await _load_all()
    return {"status": "ok", "cached_keys": count}


@app.get("/secrets/{key}", dependencies=[Depends(verify_internal_token)])
async def get_secret(key: str) -> dict:
    value = _cache.get(key)
    if value is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"value": value}
