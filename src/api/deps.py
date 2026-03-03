from __future__ import annotations

import ipaddress
import os
import secrets
import socket
import threading
import time
from typing import Annotated

import asyncpg
from fastapi import Depends, Header, HTTPException, Request
from openai import AsyncOpenAI

from shared.tool_sdk import _sm_read

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


def _is_loopback_ip(client_ip: str) -> bool:
    if not client_ip:
        return False
    try:
        return ipaddress.ip_address(client_ip).is_loopback
    except ValueError:
        return client_ip.startswith(_TRUSTED_PREFIXES)


def _get_api_secret_key() -> str:
    return _sm_read("API_SECRET_KEY") or ""


async def get_pool(request: Request) -> asyncpg.Pool:
    return request.app.state.pool


async def get_embedding_service(
    pool: Annotated[asyncpg.Pool, Depends(get_pool)],
) -> EmbeddingService:
    return EmbeddingService(pool=pool)


async def verify_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header()] = None,
) -> str:
    client_ip = request.client.host if request.client else ""
    if _is_loopback_ip(client_ip):
        return "localhost-bypass"

    api_key = _get_api_secret_key()
    if not api_key:
        raise HTTPException(status_code=500, detail="API key not configured")

    token = x_api_key
    if not token:
        auth = request.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            token = auth[7:]

    if not token or not secrets.compare_digest(token, api_key):
        raise HTTPException(status_code=401, detail="Invalid API key")
    return token


async def verify_ui_or_api_key(
    request: Request,
    x_api_key: Annotated[str | None, Header()] = None,
) -> str:
    """Accept nginx-forwarded auth or an API key.

    Trust model for /api/threads (UI) routes:
    - Nginx sets X-Forwarded-User via auth_request → trusted if from Docker bridge IP
    - External callers must provide a valid API key (Bearer token)

    Sandbox containers use verify_api_key (agent/tools routes) which does NOT
    include any bridge-network bypass.
    """
    client_ip = request.client.host if request.client else ""

    # Localhost always trusted
    if _is_loopback_ip(client_ip):
        return "localhost-bypass"

    forwarded_user = request.headers.get("x-forwarded-user")
    if forwarded_user and _is_trusted_nginx_ip(client_ip):
        return "nginx"

    return await verify_api_key(request, x_api_key)


class EmbeddingService:
    def __init__(self, pool: asyncpg.Pool) -> None:
        self.pool = pool
        self.client = AsyncOpenAI(api_key=_sm_read("OPENAI_API_KEY") or "")

    async def embed(self, text: str) -> list[float]:
        resp = await self.client.embeddings.create(
            input=text,
            model="text-embedding-3-small",
        )
        return resp.data[0].embedding
