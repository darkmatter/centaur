"""API key management — create, verify, revoke, and scope-check keys."""

from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass, field
from threading import Lock

import asyncpg
import structlog

log = structlog.get_logger()

# Prefix for generated keys so they're recognizable
_KEY_PREFIX_LEN = 8
_KEY_BYTES = 32  # 256-bit random keys


@dataclass
class APIKeyInfo:
    """Resolved key metadata returned after verification."""

    id: str
    name: str
    key_prefix: str
    scopes: list[str]
    created_by: str
    source: str = "db"  # "db" | "root" | "sandbox" | "localhost"


def generate_key() -> tuple[str, str, str]:
    """Generate a new API key. Returns (plaintext_key, key_prefix, key_hash)."""
    raw = secrets.token_urlsafe(_KEY_BYTES)
    key = f"aiv2_{raw}"
    prefix = key[:_KEY_PREFIX_LEN]
    key_hash = hashlib.sha256(key.encode()).hexdigest()
    return key, prefix, key_hash


def hash_key(key: str) -> str:
    """Hash a plaintext key for comparison."""
    return hashlib.sha256(key.encode()).hexdigest()


# ---------------------------------------------------------------------------
# In-memory cache of active keys (refreshed periodically)
# ---------------------------------------------------------------------------


@dataclass
class _KeyCache:
    """Thread-safe cache of active API keys."""

    keys: dict[str, APIKeyInfo] = field(default_factory=dict)  # hash → info
    lock: Lock = field(default_factory=Lock)
    expires_at: float = 0.0


_cache = _KeyCache()
_CACHE_TTL = 30.0  # seconds


async def refresh_cache(pool: asyncpg.Pool) -> int:
    """Reload active keys from Postgres into memory."""
    rows = await pool.fetch(
        "SELECT id, name, key_prefix, key_hash, scopes, created_by "
        "FROM api_keys WHERE revoked_at IS NULL"
    )
    new_keys: dict[str, APIKeyInfo] = {}
    for r in rows:
        info = APIKeyInfo(
            id=str(r["id"]),
            name=r["name"],
            key_prefix=r["key_prefix"],
            scopes=list(r["scopes"]),
            created_by=r["created_by"],
        )
        new_keys[r["key_hash"]] = info
    with _cache.lock:
        _cache.keys = new_keys
        _cache.expires_at = time.monotonic() + _CACHE_TTL
    return len(new_keys)


async def lookup_key(pool: asyncpg.Pool, token: str) -> APIKeyInfo | None:
    """Look up a key by its plaintext value. Uses cache, falls back to DB."""
    h = hash_key(token)

    # Check cache first
    now = time.monotonic()
    with _cache.lock:
        if now < _cache.expires_at:
            info = _cache.keys.get(h)
            if info is not None:
                return info
            # Cache is fresh but key not found — definitely not valid
            return None

    # Cache expired — refresh
    await refresh_cache(pool)
    with _cache.lock:
        return _cache.keys.get(h)


async def create_key(
    pool: asyncpg.Pool,
    name: str,
    scopes: list[str],
    created_by: str = "",
) -> tuple[str, APIKeyInfo]:
    """Create a new API key. Returns (plaintext_key, info)."""
    plaintext, prefix, key_hash = generate_key()
    row = await pool.fetchrow(
        "INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by) "
        "VALUES ($1, $2, $3, $4, $5) "
        "RETURNING id",
        name,
        prefix,
        key_hash,
        scopes,
        created_by,
    )
    info = APIKeyInfo(
        id=str(row["id"]),
        name=name,
        key_prefix=prefix,
        scopes=scopes,
        created_by=created_by,
    )
    # Invalidate cache
    with _cache.lock:
        _cache.expires_at = 0.0
    log.info("api_key_created", name=name, prefix=prefix, scopes=scopes)
    return plaintext, info


async def revoke_key(pool: asyncpg.Pool, key_id: str) -> bool:
    """Revoke a key by ID. Returns True if revoked, False if not found."""
    result = await pool.execute(
        "UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL",
        key_id,
    )
    revoked = result == "UPDATE 1"
    if revoked:
        with _cache.lock:
            _cache.expires_at = 0.0
        log.info("api_key_revoked", key_id=key_id)
    return revoked


async def list_keys(pool: asyncpg.Pool) -> list[dict]:
    """List all keys (active and revoked) — never exposes the hash."""
    rows = await pool.fetch(
        "SELECT id, name, key_prefix, scopes, created_by, created_at, revoked_at "
        "FROM api_keys ORDER BY created_at DESC"
    )
    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "key_prefix": r["key_prefix"],
            "scopes": list(r["scopes"]),
            "created_by": r["created_by"],
            "created_at": r["created_at"].isoformat() if r["created_at"] else None,
            "revoked_at": r["revoked_at"].isoformat() if r["revoked_at"] else None,
            "active": r["revoked_at"] is None,
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Per-service bootstrap keys
# ---------------------------------------------------------------------------

SERVICE_KEYS: dict[str, dict] = {
    "slackbot": {
        "secret_name": "SLACKBOT_API_KEY",
        "scopes": ["agent:execute", "agent:status", "agent:stop"],
    },
    "web": {
        "secret_name": "WEB_API_KEY",
        "scopes": ["agent:execute", "agent:status", "agent:stop", "threads:read"],
    },
}


async def ensure_service_keys(pool: asyncpg.Pool) -> dict[str, str]:
    """Ensure per-service API keys exist in the database.

    Returns a dict of {service_name: "created" | "exists"} for logging.
    Newly created keys are logged once for the operator to store in 1Password.
    """
    result: dict[str, str] = {}
    for service_name, config in SERVICE_KEYS.items():
        existing = await pool.fetchrow(
            "SELECT id FROM api_keys WHERE name = $1 AND revoked_at IS NULL",
            service_name,
        )
        if existing:
            result[service_name] = "exists"
            continue

        raw_key = f"aiv2_{service_name}_{secrets.token_urlsafe(_KEY_BYTES)}"
        key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
        key_prefix = raw_key[:_KEY_PREFIX_LEN]

        await pool.execute(
            "INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by) "
            "VALUES ($1, $2, $3, $4, $5)",
            service_name,
            key_prefix,
            key_hash,
            config["scopes"],
            "system:bootstrap",
        )
        # Invalidate cache so the new key is immediately usable
        with _cache.lock:
            _cache.expires_at = 0.0

        result[service_name] = "created"
        log.warning(
            "service_key_created",
            service=service_name,
            secret_name=config["secret_name"],
            key_prefix=key_prefix,
            instruction=f"Store this key in 1Password as '{config['secret_name']}': {raw_key}",
        )

    return result


# ---------------------------------------------------------------------------
# Scope checking
# ---------------------------------------------------------------------------


def check_scope(key_info: APIKeyInfo, required: str, resource: str = "") -> bool:
    """Check if a key's scopes permit the requested action.

    Scope format examples:
      - "*"                    → everything
      - "admin"                → /admin routes
      - "agent"                → all /agent routes
      - "agent:execute"        → only /agent/execute
      - "agent:execute,status" → /agent/execute and /agent/status
      - "tools:*"              → all tools
      - "tools:slack"          → only the slack tool
      - "tools:slack,twitter"  → slack and twitter
      - "threads"              → all thread viewer routes
      - "threads:read"         → read-only thread access

    The `required` argument uses "category" or "category:action" format.
    A scope of "agent" grants access to all agent sub-actions.
    A scope of "agent:execute" only grants the execute sub-action.

    Arguments:
      required: the scope to check, e.g. "agent:execute", "admin", "tools"
      resource: for tools scope, the tool name being accessed
    """
    scopes = key_info.scopes

    # Wildcard — full access
    if "*" in scopes:
        return True

    # Parse required into category + optional action
    if ":" in required and not required.startswith("tools:"):
        category, action = required.split(":", 1)
    else:
        category = required
        action = ""

    if category == "tools":
        for scope in scopes:
            if scope == "tools:*":
                return True
            if scope.startswith("tools:"):
                allowed = {t.strip() for t in scope[6:].split(",")}
                if resource in allowed:
                    return True
        return False

    # For all other categories (admin, agent, threads, etc.):
    # - Bare category scope (e.g. "agent") grants all sub-actions
    # - Sub-scoped (e.g. "agent:execute") grants only that action
    for scope in scopes:
        # Exact match: "agent" matches required "agent" or "agent:execute"
        if scope == category:
            return True
        # Sub-scope match: "agent:execute" matches required "agent:execute"
        if action and scope == required:
            return True
        # Comma-delimited sub-scope: "agent:execute,status" matches "agent:execute"
        if action and scope.startswith(f"{category}:"):
            allowed = {a.strip() for a in scope[len(category) + 1 :].split(",")}
            if action in allowed:
                return True

    return False
