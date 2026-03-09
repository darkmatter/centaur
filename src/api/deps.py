from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import os
import secrets
import socket
import threading
import time
from collections.abc import Callable
from typing import Annotated

import structlog
from fastapi import Header, HTTPException, Request

from api.api_keys import APIKeyInfo, check_scope, lookup_key

log = structlog.get_logger()

# Only localhost is trusted without an API key (e.g. health checks).
# All other callers — including sandbox containers on agent_net — must
# present a valid API key.  The previous "all private IPs" bypass was
# too broad and allowed sandboxes to hit admin/secrets endpoints.
_TRUSTED_PREFIXES = ("127.",)

# Trust X-Forwarded-User only when caller IP maps to nginx.
_NGINX_TRUSTED_IPS = tuple(
    ip.strip() for ip in os.environ.get("NGINX_TRUSTED_IPS", "").split(",") if ip.strip()
)
_NGINX_TRUSTED_IP_PREFIX = os.environ.get("NGINX_TRUSTED_IP_PREFIX", "").strip()
_NGINX_TRUSTED_HOSTS = tuple(
    host.strip() for host in os.environ.get("NGINX_TRUSTED_HOSTS", "nginx").split(",") if host.strip()
)
_NGINX_RESOLVE_TTL_S = max(5, int(os.environ.get("NGINX_RESOLVE_TTL_S", "60")))
_nginx_ips_cache_lock = threading.Lock()
_nginx_ips_cache: tuple[str, ...] = tuple(sorted(_NGINX_TRUSTED_IPS))
_nginx_ips_cache_expires_at = 0.0
_SANDBOX_ALLOWED_PATH_PREFIXES = ("/agent", "/pipe", "/tools")
_TRUSTED_SERVICE_HOSTS = tuple(
    host.strip() for host in os.environ.get("TRUSTED_SERVICE_HOSTS", "nginx,slackbot,auth").split(",") if host.strip()
)
_trusted_service_ips_cache_lock = threading.Lock()
_trusted_service_ips_cache: tuple[str, ...] = ()
_trusted_service_ips_cache_expires_at = 0.0


def _resolve_nginx_ips_uncached() -> tuple[str, ...]:
    resolved: set[str] = set(_NGINX_TRUSTED_IPS)
    for host in _NGINX_TRUSTED_HOSTS:
        try:
            infos = socket.getaddrinfo(host, None, family=socket.AF_UNSPEC)
        except OSError:
            continue
        for info in infos:
            sockaddr = info[4]
            if isinstance(sockaddr, tuple) and sockaddr and isinstance(sockaddr[0], str):
                resolved.add(sockaddr[0])
    return tuple(sorted(resolved))


def _resolved_nginx_ips() -> tuple[str, ...]:
    global _nginx_ips_cache_expires_at, _nginx_ips_cache
    now = time.monotonic()
    with _nginx_ips_cache_lock:
        if _nginx_ips_cache and now < _nginx_ips_cache_expires_at:
            return _nginx_ips_cache
        resolved = _resolve_nginx_ips_uncached()
        if resolved:
            _nginx_ips_cache = resolved
            _nginx_ips_cache_expires_at = now + _NGINX_RESOLVE_TTL_S
        else:
            # Preserve last known-good addresses on transient DNS failures.
            _nginx_ips_cache_expires_at = now + min(5, _NGINX_RESOLVE_TTL_S)
        return _nginx_ips_cache


def _is_trusted_nginx_ip(client_ip: str) -> bool:
    if not client_ip:
        return False
    if client_ip in _resolved_nginx_ips():
        return True
    if not _NGINX_TRUSTED_IP_PREFIX:
        return False
    if _NGINX_TRUSTED_IP_PREFIX.endswith("."):
        return client_ip.startswith(_NGINX_TRUSTED_IP_PREFIX)
    return client_ip == _NGINX_TRUSTED_IP_PREFIX


def _resolve_trusted_service_ips_uncached() -> tuple[str, ...]:
    resolved: set[str] = set()
    for host in _TRUSTED_SERVICE_HOSTS:
        try:
            infos = socket.getaddrinfo(host, None, family=socket.AF_UNSPEC)
        except OSError:
            continue
        for info in infos:
            sockaddr = info[4]
            if isinstance(sockaddr, tuple) and sockaddr and isinstance(sockaddr[0], str):
                resolved.add(sockaddr[0])
    return tuple(sorted(resolved))


def _resolved_trusted_service_ips() -> tuple[str, ...]:
    global _trusted_service_ips_cache_expires_at, _trusted_service_ips_cache
    now = time.monotonic()
    with _trusted_service_ips_cache_lock:
        if _trusted_service_ips_cache and now < _trusted_service_ips_cache_expires_at:
            return _trusted_service_ips_cache
        resolved = _resolve_trusted_service_ips_uncached()
        if resolved:
            _trusted_service_ips_cache = resolved
            _trusted_service_ips_cache_expires_at = now + _NGINX_RESOLVE_TTL_S
        else:
            _trusted_service_ips_cache_expires_at = now + min(5, _NGINX_RESOLVE_TTL_S)
        return _trusted_service_ips_cache


def _is_trusted_service_ip(client_ip: str) -> bool:
    if not client_ip:
        return False
    return client_ip in _resolved_trusted_service_ips()


def _is_loopback_ip(client_ip: str) -> bool:
    if not client_ip:
        return False
    try:
        return ipaddress.ip_address(client_ip).is_loopback
    except ValueError:
        return client_ip.startswith(_TRUSTED_PREFIXES)


def _get_api_secret_key() -> str:
    return os.environ.get("API_SECRET_KEY", "")


# ---------------------------------------------------------------------------
# Scoped sandbox tokens (HMAC-SHA256, sbx1.* format)
# ---------------------------------------------------------------------------


def mint_sandbox_token(thread_key: str, container_id: str, ttl_s: int = 7200) -> str:
    """Create a short-lived sandbox token signed with API_SECRET_KEY."""
    api_key = _get_api_secret_key()
    if not api_key:
        raise RuntimeError("API_SECRET_KEY not configured")

    now = int(time.time())
    payload = {
        "thread_key": thread_key,
        "container_id": container_id,
        "created_at": now,
        "expires_at": now + ttl_s,
    }
    payload_b64 = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    sig = hmac.new(api_key.encode(), payload_b64.encode(), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode()
    return f"sbx1.{payload_b64}.{sig_b64}"


def verify_sandbox_token(token: str) -> dict | None:
    """Validate signature and expiry of a sandbox token. Returns claims or None."""
    api_key = _get_api_secret_key()
    if not api_key:
        return None

    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "sbx1":
        return None

    payload_b64 = parts[1]
    sig_b64 = parts[2]

    expected_sig = hmac.new(api_key.encode(), payload_b64.encode(), hashlib.sha256).digest()
    try:
        provided_sig = base64.urlsafe_b64decode(sig_b64)
    except Exception:
        return None

    if not hmac.compare_digest(expected_sig, provided_sig):
        return None

    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
    except Exception:
        return None

    if time.time() > payload.get("expires_at", 0):
        return None

    return payload


def _is_sandbox_allowed_path(path: str) -> bool:
    return path.startswith(_SANDBOX_ALLOWED_PATH_PREFIXES)



async def verify_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header()] = None,
) -> str:
    client_ip = request.client.host if request.client else ""
    if _is_loopback_ip(client_ip):
        request.state.api_key_info = APIKeyInfo(
            id="localhost", name="localhost", key_prefix="", scopes=["*"], created_by="system",
            source="localhost",
        )
        return "localhost-bypass"

    api_key = _get_api_secret_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="API key not configured")

    token = x_api_key
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:]

    # Scoped sandbox tokens (sbx1.* format)
    if token and token.startswith("sbx1."):
        claims = verify_sandbox_token(token)
        if claims is not None:
            request.state.api_key_info = APIKeyInfo(
                id=claims["container_id"], name="sandbox", key_prefix="sbx1",
                scopes=["agent", "tools:*"], created_by="system", source="sandbox",
            )
            return f"sandbox:{claims['container_id']}"
        log.warning(
            "sbx_token_rejected",
            token_prefix=token[:20] if token else "",
            reason="invalid_signature_or_expired",
            client_ip=client_ip,
            path=str(request.url.path),
        )
        raise HTTPException(status_code=401, detail="Invalid or expired sandbox token")

    # Root key check
    if token and secrets.compare_digest(token, api_key):
        request.state.api_key_info = APIKeyInfo(
            id="root", name="root", key_prefix="root", scopes=["*"], created_by="system",
            source="root",
        )
        if _is_trusted_service_ip(client_ip):
            return token
        if not _is_trusted_nginx_ip(client_ip) and not _is_sandbox_allowed_path(request.url.path):
            raise HTTPException(status_code=403, detail="API key scope does not permit this route")
        return token

    # DB key lookup
    if token:
        pool = request.app.state.db_pool
        key_info = await lookup_key(pool, token)
        if key_info is not None:
            request.state.api_key_info = key_info
            return f"key:{key_info.key_prefix}"

    raise HTTPException(status_code=401, detail="Invalid API key")


def get_key_info(request: Request) -> APIKeyInfo:
    """Retrieve the APIKeyInfo attached during verify_api_key."""
    info = getattr(request.state, "api_key_info", None)
    if info is None:
        return APIKeyInfo(
            id="unknown", name="unknown", key_prefix="", scopes=["*"],
            created_by="system", source="unknown",
        )
    return info


def require_scope(scope: str) -> Callable:
    """Return a FastAPI dependency that checks the caller has the given scope.

    Usage::

        @router.post("/execute", dependencies=[Depends(require_scope("agent:execute"))])
        async def execute(...): ...
    """

    async def _check(request: Request) -> None:
        key_info = get_key_info(request)
        if not check_scope(key_info, scope):
            raise HTTPException(
                status_code=403,
                detail=f"API key scope does not permit '{scope}'",
            )

    return _check


async def verify_operator_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header()] = None,
) -> str:
    token = await verify_api_key(request, x_api_key)
    key_info = get_key_info(request)
    if key_info.source == "localhost":
        return token
    client_ip = request.client.host if request.client else ""
    if _is_trusted_nginx_ip(client_ip) and check_scope(key_info, "admin"):
        return token
    if check_scope(key_info, "admin"):
        return token
    raise HTTPException(status_code=403, detail="Operator route requires admin scope")


async def verify_ui_or_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header()] = None,
) -> str:
    """Accept nginx-forwarded auth or an API key."""
    client_ip = request.client.host if request.client else ""

    if _is_loopback_ip(client_ip):
        request.state.api_key_info = APIKeyInfo(
            id="localhost", name="localhost", key_prefix="", scopes=["*"],
            created_by="system", source="localhost",
        )
        return "localhost-bypass"

    forwarded_user = request.headers.get("x-forwarded-user")
    if forwarded_user and not _is_trusted_nginx_ip(client_ip):
        raise HTTPException(status_code=403, detail="Untrusted forwarded identity header")
    if forwarded_user and _is_trusted_nginx_ip(client_ip):
        request.state.api_key_info = APIKeyInfo(
            id="nginx", name=forwarded_user, key_prefix="", scopes=["*"],
            created_by="nginx", source="nginx",
        )
        return "nginx"

    return await verify_api_key(request, x_api_key)
