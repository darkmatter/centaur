"""Secret Manager — pluggable backend for serving secrets over HTTP.

A lightweight sidecar service that loads secrets from a configurable backend
on startup and serves them over HTTP.  Other services (API, ETL) query this
instead of talking to secret stores directly.

Backend selection via ``SECRET_MANAGER_BACKEND`` env var:

- ``onepassword`` (default) — uses 1Password SDK, requires ``OP_SERVICE_ACCOUNT_TOKEN``
- ``env`` — reads from ``os.environ`` (optionally filtered by ``SECRET_ENV_PREFIX``)
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request

from centaur_sdk.logging import configure_json_logging
from secret_manager.backend import SecretEntry, SecretManagerBackend

log = configure_json_logging("secret_manager", uvicorn=True)


def _initialize_laminar() -> None:
    if not (os.environ.get("LMNR_PROJECT_API_KEY") or "").strip():
        return
    try:
        from lmnr import Laminar

        Laminar.initialize(
            project_api_key=os.environ.get("LMNR_PROJECT_API_KEY"),
            base_url=os.environ.get("LMNR_BASE_URL") or "https://api.lmnr.ai",
            http_port=int(os.environ["LMNR_HTTP_PORT"])
            if os.environ.get("LMNR_HTTP_PORT")
            else None,
            grpc_port=int(os.environ["LMNR_GRPC_PORT"])
            if os.environ.get("LMNR_GRPC_PORT")
            else None,
            instruments=set(),
        )
        log.info("laminar initialized")
    except Exception as exc:
        log.warning("laminar initialization failed: %s", exc)


_initialize_laminar()

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

_REFRESH_INTERVAL = int(os.environ.get("SECRET_REFRESH_SECONDS", "300"))  # 5 min
_REFRESH_RETRY_INTERVAL = int(os.environ.get("SECRET_REFRESH_RETRY_SECONDS", "15"))
_AUTH_TOKEN = (os.environ.get("SECRETS_AUTH_TOKEN") or "").strip()
if not _AUTH_TOKEN:
    raise SystemExit(
        "SECRETS_AUTH_TOKEN is not set. Refusing to start: an empty token would "
        "leave the secrets service unauthenticated."
    )


def _require_bearer_token(request: Request) -> None:
    if request.headers.get("authorization", "") == f"Bearer {_AUTH_TOKEN}":
        return
    raise HTTPException(status_code=403, detail="forbidden")

# In-memory cache: key → entry.
_cache: dict[str, SecretEntry] = {}
_last_refresh_error: str | None = None

# Active backend — set during lifespan
_backend: SecretManagerBackend | None = None

# ---------------------------------------------------------------------------
# Backend factory
# ---------------------------------------------------------------------------


def _create_backend() -> SecretManagerBackend:
    """Instantiate the backend based on ``SECRET_MANAGER_BACKEND`` env var."""
    name = os.environ.get("SECRET_MANAGER_BACKEND", "onepassword").lower()

    if name == "onepassword":
        from secret_manager.onepassword import OnePasswordBackend

        return OnePasswordBackend()

    if name == "env":
        from secret_manager.env import EnvSecretManagerBackend

        log.warning(
            "using EnvSecretManagerBackend — secrets are loaded from environment "
            "variables, NOT 1Password. This is intended for local development only."
        )
        prefix = os.environ.get("SECRET_ENV_PREFIX") or None
        return EnvSecretManagerBackend(prefix=prefix)

    raise ValueError(
        f"Unknown SECRET_MANAGER_BACKEND={name!r}. Supported values: 'onepassword', 'env'"
    )


# ---------------------------------------------------------------------------
# Cache management
# ---------------------------------------------------------------------------


async def _load_all() -> int:
    """Fetch secrets from the active backend and populate the cache."""
    global _cache, _last_refresh_error
    assert _backend is not None
    _cache = await _backend.load_all()
    _last_refresh_error = None
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
    global _backend, _last_refresh_error

    _backend = _create_backend()
    backend_name = type(_backend).__name__
    log.info("using backend: %s", backend_name)

    # 1Password requires OP_SERVICE_ACCOUNT_TOKEN — fail fast if missing.
    from secret_manager.onepassword import OnePasswordBackend

    if isinstance(_backend, OnePasswordBackend):
        token = os.environ.get("OP_SERVICE_ACCOUNT_TOKEN", "")
        if not token:
            log.critical(
                "OP_SERVICE_ACCOUNT_TOKEN is not set. "
                "The secrets container MUST be started via CI (GitHub Actions) "
                "which injects this token. NEVER manually recreate this container. "
                "Run: gh workflow run deploy.yml --repo <owner/repo>"
            )
            raise SystemExit(1)

    initial_delay = _REFRESH_INTERVAL
    try:
        await _load_all()
    except Exception as exc:
        _last_refresh_error = str(exc)
        log.exception("initial secret load failed; starting in degraded mode")
        initial_delay = _REFRESH_RETRY_INTERVAL

    # Only start the refresh loop if the backend supports it.
    task = None
    if _backend.supports_refresh:
        task = asyncio.create_task(_refresh_loop(initial_delay))

    try:
        yield
    finally:
        if task is not None:
            task.cancel()


app = FastAPI(title="Secret Manager", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok" if _last_refresh_error is None else "degraded",
        "cached_keys": len(_cache),
        "last_refresh_error": _last_refresh_error,
    }


@app.get("/keys", dependencies=[Depends(_require_bearer_token)])
def list_keys() -> dict:
    """List all cached key names (values are never exposed)."""
    return {"keys": sorted(_cache.keys()), "count": len(_cache)}


@app.post("/reload", dependencies=[Depends(_require_bearer_token)])
async def reload_secrets() -> dict:
    """Force an immediate refresh from the active backend."""
    count = await _load_all()
    return {"status": "ok", "cached_keys": count}


@app.get("/secrets/{key}", dependencies=[Depends(_require_bearer_token)])
async def get_secret(key: str) -> dict:
    entry = _cache.get(key)
    if entry is None:
        raise HTTPException(status_code=404, detail="not found")
    return {"value": entry.value}
