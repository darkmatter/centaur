"""Firewall addon — stateless header-value credential replacement.

Intercepts ALL outgoing HTTPS requests from sandbox containers. Scans
every header value for known secret key names (fetched from the secret
manager) and replaces them with real secrets on the fly.

Container env vars contain the key name as the value (e.g.
``OPENAI_API_KEY=OPENAI_API_KEY``), so when a CLI sends
``Authorization: Bearer OPENAI_API_KEY`` the firewall replaces it with
``Authorization: Bearer sk-proj-real...``.

Amp routes LLM calls through ampcode.com/api/provider/{provider}/... which
requires a paid plan. To bypass this, the firewall rewrites these requests
to go directly to the real API endpoint (e.g. api.anthropic.com) with
key-name placeholders that the replacement logic resolves.
"""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import logging
import math
import os
import re
import socket
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import OrderedDict
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

from mitmproxy import http


class _JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, object] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname.lower(),
            "service": "firewall",
            "event": getattr(record, "event", record.funcName or record.name),
            "msg": record.getMessage(),
        }
        for k, v in record.__dict__.items():
            if k not in _RESERVED_LOG_KEYS and k not in payload:
                payload[k] = v
        if record.exc_info and record.exc_info[0] is not None:
            payload["stack"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


_RESERVED_LOG_KEYS = {
    "name", "msg", "args", "created", "relativeCreated", "exc_info", "exc_text",
    "stack_info", "lineno", "funcName", "pathname", "filename", "module",
    "levelno", "levelname", "msecs", "thread", "threadName", "process",
    "processName", "taskName", "message", "asctime",
}

_log_handler = logging.StreamHandler(sys.stdout)
_log_handler.setFormatter(_JsonFormatter())
log = logging.getLogger("firewall")
log.handlers = [_log_handler]
log.setLevel(logging.INFO)
log.propagate = False

SECRET_MANAGER_URL = os.environ.get("SECRET_MANAGER_URL", "http://secrets:8100")
SECRET_MANAGER_TOKEN = os.environ.get("SECRET_MANAGER_TOKEN", "")
CACHE_TTL = int(os.environ.get("FIREWALL_CACHE_TTL", "30"))
HEALTH_PORT = int(os.environ.get("HEALTH_PORT", "8081"))
KEYS_REFRESH_INTERVAL = int(os.environ.get("KEYS_REFRESH_INTERVAL", "60"))

_DEFAULT_INJECTION_HOSTS = (
    "api.openai.com,"
    "api.anthropic.com,"
    "api.together.ai,"
    "api.exa.ai,"
    "generativelanguage.googleapis.com,"
    "api.x.ai,"
    "ampcode.com"
)

# Hosts that need POST/PUT/DELETE but don't get secret injection.
# These are essential sandbox services (git, GitHub API).
_DEFAULT_UNRESTRICTED_METHOD_HOSTS = (
    "github.com,"
    "api.github.com,"
    "ampcode.com"
)
SECRET_INJECTION_HOSTS: frozenset[str] = frozenset(
    h.strip().lower()
    for h in os.environ.get(
        "FIREWALL_SECRET_INJECTION_HOSTS", _DEFAULT_INJECTION_HOSTS
    ).split(",")
    if h.strip()
)

_PRIVATE_NETWORKS = (
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
)

SENSITIVE_INBOUND_HEADERS: frozenset[str] = frozenset(
    {"x-api-key", "x-forwarded-user"}
)

# HTTP method restrictions: hosts not in this set are limited to safe methods only.
# LLM API hosts (SECRET_INJECTION_HOSTS) are always allowed all methods.
UNRESTRICTED_METHOD_HOSTS: frozenset[str] = frozenset(
    h.strip().lower()
    for h in os.environ.get(
        "FIREWALL_UNRESTRICTED_METHOD_HOSTS", _DEFAULT_UNRESTRICTED_METHOD_HOSTS
    ).split(",")
    if h.strip()
)

SAFE_METHODS: frozenset[str] = frozenset({"GET", "HEAD", "OPTIONS"})

# Allowed outbound request headers — anything not in this set is stripped.
ALLOWED_OUTBOUND_HEADERS: frozenset[str] = frozenset({
    "host", "content-type", "content-length", "accept", "accept-encoding",
    "accept-language", "authorization", "x-api-key", "anthropic-version",
    "anthropic-beta", "openai-organization", "openai-project",
    "x-request-id", "x-stainless-arch", "x-stainless-os",
    "x-stainless-lang", "x-stainless-runtime", "x-stainless-runtime-version",
    "x-stainless-package-version", "x-stainless-retry-count",
    "connection", "transfer-encoding", "te",
    "cache-control", "pragma", "if-none-match", "if-modified-since",
    "range", "cookie",
})

FIXED_USER_AGENT = "ai-v2-sandbox/1.0"

RATE_LIMIT = int(os.environ.get("FIREWALL_RATE_LIMIT", "500"))
RATE_WINDOW = 60  # seconds

BODY_INSPECTION_ENABLED = os.environ.get("FIREWALL_BODY_INSPECTION", "0") == "1"

# ---------------------------------------------------------------------------
# Unicode normalization (anti-homoglyph bypass)
# ---------------------------------------------------------------------------

_HOMOGLYPH_MAP: dict[str, str] = {
    "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p",
    "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i",
    "\u0458": "j", "\u04bb": "h", "\u0455": "s", "\u0460": "w",
    "\u0501": "d", "\u051b": "q", "\u051d": "w",
    # Greek lookalikes
    "\u03bf": "o", "\u03b1": "a", "\u03b5": "e", "\u03c1": "p",
    "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03c4": "t",
}

_ZERO_WIDTH_RE = re.compile(
    "[\u200b-\u200f\u2028-\u202e\ufeff\u00ad\u2060\u180e]"
)


def _normalize_text(text: str) -> str:
    """NFKC + strip combining marks + zero-width chars + homoglyph map."""
    text = unicodedata.normalize("NFKC", text)
    text = "".join(c for c in text if unicodedata.category(c) != "Mn")
    text = _ZERO_WIDTH_RE.sub("", text)
    return text.translate(str.maketrans(_HOMOGLYPH_MAP))


# ---------------------------------------------------------------------------
# Prompt injection patterns (audit-only body inspection)
# ---------------------------------------------------------------------------

_INJECTION_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    "injection": [
        re.compile(r"ignore\s+(all\s+)?previous\s+instructions", re.I),
        re.compile(r"\[SYSTEM\]", re.I),
        re.compile(r"jailbreak", re.I),
        re.compile(r"you\s+are\s+now\s+(in\s+)?DAN\b", re.I),
        re.compile(r"disregard\s+(all\s+)?(prior|above)\s+", re.I),
    ],
    "execution": [
        re.compile(r"curl\s.*\|\s*(ba)?sh", re.I),
        re.compile(r"rm\s+-rf\s+/", re.I),
        re.compile(r"\beval\s*\(", re.I),
        re.compile(r"subprocess\.", re.I),
    ],
    "encoding": [
        re.compile(r"base64\s+-d", re.I),
        re.compile(r"\$\(.*\)", re.I),
    ],
}

_PATTERN_WEIGHTS: dict[str, float] = {
    "injection": 4.0,
    "execution": 3.0,
    "encoding": 2.0,
}


class _LRUCache:
    """Thread-safe LRU cache with max size."""

    def __init__(self, maxsize: int = 5000) -> None:
        self._cache: OrderedDict[str, object] = OrderedDict()
        self._maxsize = maxsize
        self._lock = threading.Lock()

    def get(self, key: str) -> object | None:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def put(self, key: str, value: object) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self._maxsize:
                self._cache.popitem(last=False)

# Amp provider proxy rewriting: ampcode.com/api/provider/{provider}/...
# is rewritten to call the real API directly with key-name placeholders.
# prefix_to_strip → (real_host, header_name, header_value_template)
# Templates use the key name directly so the replacement logic resolves them.
_PROVIDER_REWRITES: dict[str, tuple[str, str, str]] = {
    "/api/provider/anthropic/": ("api.anthropic.com", "x-api-key", "ANTHROPIC_API_KEY"),
    "/api/provider/openai/": ("api.openai.com", "authorization", "Bearer OPENAI_API_KEY"),
}


def _is_private_ip(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return any(ip in net for net in _PRIVATE_NETWORKS)


def _resolve_host(host: str) -> list[str]:
    try:
        results = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        return list({r[4][0] for r in results})
    except socket.gaierror:
        return []


class CredentialInjector:
    def __init__(self) -> None:
        self._cache: dict[str, tuple[str | None, float]] = {}
        self._lock = threading.Lock()
        self._known_keys: set[str] = set()
        self._canonicalize_google_key = False
        self._keys_lock = threading.Lock()
        # Rate limiting: source_ip → list of timestamps
        self._rate_tracker: dict[str, list[float]] = {}
        self._rate_lock = threading.Lock()
        self._rate_last_prune = time.monotonic()
        # Reverse secret map for response scanning: secret_value → key_name
        self._reverse_secrets: dict[str, str] = {}
        self._reverse_lock = threading.Lock()
        # Body inspection LRU cache
        self._body_cache = _LRUCache(5000)
        log.info("credential injector started (stateless header-value replacement)")
        log.info("secret injection allowlist: %s", SECRET_INJECTION_HOSTS)
        self._start_health_server()
        self._start_keys_refresh()

    # ------------------------------------------------------------------
    # Health server
    # ------------------------------------------------------------------

    def _start_health_server(self) -> None:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                if self.path == "/health":
                    with parent._lock:
                        cached = sum(1 for v, _ in parent._cache.values() if v is not None)
                    with parent._keys_lock:
                        known = len(parent._known_keys)
                    body = json.dumps(
                        {
                            "status": "ok",
                            "secrets_cached": cached,
                            "known_keys": known,
                        }
                    )
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body.encode())
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, fmt: str, *args: object) -> None:
                pass

        def serve() -> None:
            server = HTTPServer(("0.0.0.0", HEALTH_PORT), Handler)
            server.serve_forever()

        threading.Thread(target=serve, daemon=True).start()

    # ------------------------------------------------------------------
    # Known keys refresh (background thread)
    # ------------------------------------------------------------------

    def _start_keys_refresh(self) -> None:
        def loop() -> None:
            while True:
                self._refresh_keys()
                time.sleep(KEYS_REFRESH_INTERVAL)

        threading.Thread(target=loop, daemon=True).start()

    def _sm_request(self, path: str, timeout: int = 5) -> bytes:
        """Make an authenticated request to the secret manager."""
        url = f"{SECRET_MANAGER_URL}{path}"
        req = urllib.request.Request(url)
        if SECRET_MANAGER_TOKEN:
            req.add_header("Authorization", f"Bearer {SECRET_MANAGER_TOKEN}")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()

    def _refresh_keys(self) -> None:
        try:
            data = json.loads(self._sm_request("/keys").decode())
            keys = set(data.get("keys", []))
            canonicalize_google_key = False
            if {"GOOGLE_API_KEY", "GEMINI_API_KEY"}.issubset(keys):
                google_key = self._get_secret("GOOGLE_API_KEY")
                gemini_key = self._get_secret("GEMINI_API_KEY")
                canonicalize_google_key = bool(
                    google_key and gemini_key and google_key == gemini_key
                )
            with self._keys_lock:
                self._known_keys = keys
                self._canonicalize_google_key = canonicalize_google_key
            if canonicalize_google_key:
                log.info("canonicalizing GOOGLE_API_KEY to GEMINI_API_KEY for header injection")
            log.info("refreshed known keys: %d keys", len(keys))

            # Build reverse map (secret_value → key_name) for response scanning
            reverse: dict[str, str] = {}
            for key_name in keys:
                secret = self._get_secret(key_name)
                if secret and len(secret) >= 8:
                    reverse[secret] = key_name
            with self._reverse_lock:
                self._reverse_secrets = reverse
        except Exception:
            log.warning("failed to refresh known keys from secret manager")

    # ------------------------------------------------------------------
    # Secret fetching (cached)
    # ------------------------------------------------------------------

    def _get_secret(self, key: str) -> str | None:
        now = time.monotonic()
        with self._lock:
            cached = self._cache.get(key)
            if cached and (now - cached[1]) < CACHE_TTL:
                return cached[0]

        try:
            raw = self._sm_request(f"/secrets/{urllib.parse.quote(key, safe='')}", timeout=3)
            val = json.loads(raw.decode()).get("value")
        except Exception:
            val = None

        with self._lock:
            self._cache[key] = (val, now)

        if val is None:
            log.warning("secret %s: not found in secret manager", key)
        return val

    # ------------------------------------------------------------------
    # Header-value replacement
    # ------------------------------------------------------------------

    def _replace_key_names(self, value: str) -> str:
        """Replace any known key names in a header value with real secrets.

        Applies unicode normalization before matching to defeat homoglyph
        and zero-width character bypass attempts.
        """
        with self._keys_lock:
            keys = self._known_keys
            canonicalize_google_key = self._canonicalize_google_key

        # Normalize to catch homoglyph/zero-width smuggling
        normalized = _normalize_text(value)
        if normalized != value:
            log.warning("unicode normalization changed header value (possible bypass attempt)")
            value = normalized

        if canonicalize_google_key and "GOOGLE_API_KEY" in value:
            value = value.replace("GOOGLE_API_KEY", "GEMINI_API_KEY")

        for key_name in keys:
            if key_name not in value:
                continue
            secret = self._get_secret(key_name)
            if secret is not None:
                value = value.replace(key_name, secret)
        return value

    def _replace_in_headers(self, flow: http.HTTPFlow) -> None:
        """Scan all header values and replace key names with real secrets."""
        with self._keys_lock:
            keys = self._known_keys
        if not keys:
            return

        for header_name in list(flow.request.headers.keys()):
            value = flow.request.headers[header_name]

            # Handle Basic auth: base64-decode, replace, re-encode
            if value.startswith("Basic "):
                try:
                    decoded = base64.b64decode(value[6:]).decode()
                except Exception:
                    continue
                has_key = any(k in decoded for k in keys)
                if not has_key:
                    continue
                replaced = self._replace_key_names(decoded)
                if replaced != decoded:
                    flow.request.headers[header_name] = (
                        "Basic " + base64.b64encode(replaced.encode()).decode()
                    )
                continue

            # Regular header value scan
            has_key = any(k in value for k in keys)
            if not has_key:
                continue
            replaced = self._replace_key_names(value)
            if replaced != value:
                flow.request.headers[header_name] = replaced

    def _strip_key_placeholders(self, flow: http.HTTPFlow) -> None:
        """Remove any header values that contain known key placeholders."""
        with self._keys_lock:
            keys = self._known_keys
        if not keys:
            return

        for header_name in list(flow.request.headers.keys()):
            value = flow.request.headers[header_name]
            if any(k in value for k in keys):
                log.warning(
                    "stripping header %s containing secret placeholder for non-allowlisted host",
                    header_name,
                )
                del flow.request.headers[header_name]

    # ------------------------------------------------------------------
    # SSRF protection
    # ------------------------------------------------------------------

    def _is_blocked_host(self, hostname: str) -> bool:
        """Return True if hostname is or resolves to a private/internal IP."""
        if _is_private_ip(hostname):
            return True
        resolved = _resolve_host(hostname)
        return any(_is_private_ip(addr) for addr in resolved)

    def _block_private_ip(self, flow: http.HTTPFlow, host: str) -> bool:
        """Resolve host and block if any resolved IP is private/internal."""
        if _is_private_ip(host):
            flow.response = http.Response.make(
                403,
                b"Blocked by SSRF protection: private IP",
                {"content-type": "text/plain"},
            )
            log.warning("SSRF blocked: direct private IP %s", host)
            return True

        resolved = _resolve_host(host)
        for addr in resolved:
            if _is_private_ip(addr):
                flow.response = http.Response.make(
                    403,
                    b"Blocked by SSRF protection: hostname resolves to private IP",
                    {"content-type": "text/plain"},
                )
                log.warning("SSRF blocked: %s resolves to private IP %s", host, addr)
                return True
        return False

    # ------------------------------------------------------------------
    # Provider rewriting
    # ------------------------------------------------------------------

    def _try_provider_rewrite(self, flow: http.HTTPFlow, host: str) -> bool:
        """Rewrite amp provider proxy calls to go directly to the real API.

        Sets headers with key-name placeholders — the replacement logic
        resolves them afterward.

        Returns True if the request was rewritten.
        """
        if host not in ("ampcode.com", "api.ampcode.com"):
            return False

        path = flow.request.path
        for prefix, (real_host, header_name, header_value) in _PROVIDER_REWRITES.items():
            if not path.startswith(prefix):
                continue

            # Rewrite: /api/provider/anthropic/v1/messages → /v1/messages
            new_path = path[len(prefix) - 1 :]  # keep the leading /
            flow.request.host = real_host
            flow.request.port = 443
            flow.request.scheme = "https"
            flow.request.path = new_path
            flow.request.headers["host"] = real_host
            flow.request.headers[header_name] = header_value

            # Remove amp-specific auth header since we're going direct
            if header_name != "authorization" and "authorization" in flow.request.headers:
                del flow.request.headers["authorization"]

            log.info(
                "provider rewrite: %s%s → %s%s",
                host,
                path,
                real_host,
                new_path,
            )
            return True

        return False

    # ------------------------------------------------------------------
    # Outbound header sanitization
    # ------------------------------------------------------------------

    def _sanitize_outbound_headers(self, flow: http.HTTPFlow) -> None:
        """Strip non-whitelisted headers and force a fixed User-Agent."""
        flow.request.headers["user-agent"] = FIXED_USER_AGENT

        to_remove = []
        for header_name in flow.request.headers:
            if header_name.lower() not in ALLOWED_OUTBOUND_HEADERS and header_name.lower() != "user-agent":
                to_remove.append(header_name)

        for header_name in to_remove:
            log.debug("stripped outbound header: %s", header_name)
            del flow.request.headers[header_name]

    # ------------------------------------------------------------------
    # Rate limiting (sliding window per source IP)
    # ------------------------------------------------------------------

    _RATE_PRUNE_INTERVAL = 300  # prune stale IPs every 5 min

    def _check_rate_limit(self, flow: http.HTTPFlow) -> bool:
        """Return True and set 429 response if source exceeds rate limit."""
        source_ip = flow.client_conn.peername[0] if flow.client_conn.peername else "unknown"
        now = time.monotonic()
        with self._rate_lock:
            # Periodically prune IPs with no recent activity
            if now - self._rate_last_prune > self._RATE_PRUNE_INTERVAL:
                cutoff_prune = now - RATE_WINDOW
                stale = [
                    ip for ip, ts in self._rate_tracker.items()
                    if not ts or ts[-1] < cutoff_prune
                ]
                for ip in stale:
                    del self._rate_tracker[ip]
                self._rate_last_prune = now

            timestamps = self._rate_tracker.get(source_ip, [])
            cutoff = now - RATE_WINDOW
            timestamps = [t for t in timestamps if t > cutoff]
            if len(timestamps) >= RATE_LIMIT:
                self._rate_tracker[source_ip] = timestamps
                flow.response = http.Response.make(
                    429,
                    b"Rate limit exceeded",
                    {"content-type": "text/plain", "retry-after": "60"},
                )
                log.warning(
                    "rate_limited",
                    extra={"event": "rate_limited", "source_ip": source_ip,
                           "count": len(timestamps)},
                )
                return True
            timestamps.append(now)
            self._rate_tracker[source_ip] = timestamps
        return False

    # ------------------------------------------------------------------
    # Response body secret scanning
    # ------------------------------------------------------------------

    _SCANNABLE_CONTENT_TYPES = frozenset({
        "application/json", "text/plain", "text/event-stream",
        "text/html", "application/x-ndjson",
    })

    def _scan_response_body(self, flow: http.HTTPFlow) -> None:
        """Scan LLM API response bodies for leaked secret values and redact."""
        if not flow.response or not flow.response.content:
            return
        host = flow.request.pretty_host.lower().rstrip(".")
        if host not in SECRET_INJECTION_HOSTS:
            return
        content_type = flow.response.headers.get("content-type", "").split(";")[0].strip()
        if content_type not in self._SCANNABLE_CONTENT_TYPES:
            return

        with self._reverse_lock:
            reverse = self._reverse_secrets.copy()
        if not reverse:
            return

        body = flow.response.content
        try:
            text = body.decode("utf-8", errors="replace")
        except Exception:
            return

        modified = False
        for secret_value, key_name in reverse.items():
            if secret_value in text:
                text = text.replace(secret_value, f"[REDACTED:{key_name}]")
                modified = True
                log.warning(
                    "secret_leaked_in_response",
                    extra={"event": "secret_leaked_in_response", "key": key_name,
                           "host": host, "path": flow.request.path[:200]},
                )
        if modified:
            flow.response.content = text.encode("utf-8")

    # ------------------------------------------------------------------
    # Request body inspection (audit-only prompt injection detection)
    # ------------------------------------------------------------------

    def _inspect_request_body(self, flow: http.HTTPFlow) -> None:
        """Scan LLM request bodies for prompt injection patterns. Audit only."""
        if not BODY_INSPECTION_ENABLED:
            return
        if flow.request.method != "POST":
            return
        host = flow.request.pretty_host.lower().rstrip(".")
        if host not in SECRET_INJECTION_HOSTS:
            return
        content_type = flow.request.headers.get("content-type", "").split(";")[0].strip()
        if content_type != "application/json":
            return
        if not flow.request.content:
            return

        body_hash = hashlib.sha256(flow.request.content).hexdigest()
        cache_key = f"body:{body_hash}"
        cached = self._body_cache.get(cache_key)
        if cached is not None:
            return  # Already scanned this exact body

        try:
            text = flow.request.content.decode("utf-8", errors="replace")
        except Exception:
            return

        normalized = _normalize_text(text)
        risk_score = 0.0
        detected: list[str] = []

        for category, patterns in _INJECTION_PATTERNS.items():
            match_count = 0
            for pat in patterns:
                if pat.search(normalized):
                    match_count += 1
                    detected.append(f"{category}:{pat.pattern[:60]}")
            if match_count > 0:
                cat_score = _PATTERN_WEIGHTS[category] * (1 + math.log(match_count))
                risk_score += min(cat_score, _PATTERN_WEIGHTS[category] * 3)

        self._body_cache.put(cache_key, risk_score)

        if risk_score >= 2.0:
            source_ip = (
                flow.client_conn.peername[0] if flow.client_conn.peername else "unknown"
            )
            log.warning(
                "prompt_injection_detected",
                extra={
                    "event": "prompt_injection_detected",
                    "risk_score": round(risk_score, 2),
                    "patterns": detected,
                    "host": host,
                    "path": flow.request.path[:200],
                    "container_ip": source_ip,
                    "text_sample": normalized[:100],
                },
            )

    # ------------------------------------------------------------------
    # mitmproxy request hook
    # ------------------------------------------------------------------

    def request(self, flow: http.HTTPFlow) -> None:
        host = flow.request.pretty_host.lower().rstrip(".")

        # 0. Rate limiting (before any processing)
        if self._check_rate_limit(flow):
            return

        # 1. Strip sensitive inbound headers from sandbox requests
        for h in SENSITIVE_INBOUND_HEADERS:
            if h in flow.request.headers:
                del flow.request.headers[h]

        # 2. Sanitize outbound headers: strip non-whitelisted, fix User-Agent
        self._sanitize_outbound_headers(flow)

        # 3. SSRF protection: resolve destination IP, block if private/internal
        if self._block_private_ip(flow, host):
            return

        # 4. Check for amp provider proxy rewrite (before method filtering
        #    so ampcode.com POSTs can be rewritten to LLM API hosts)
        rewritten = self._try_provider_rewrite(flow, host)

        # Re-read host after potential provider rewrite
        host = flow.request.pretty_host.lower().rstrip(".")

        # 5. HTTP method filtering: hosts not in the unrestricted set are
        #    limited to safe methods only (GET/HEAD/OPTIONS).  LLM API hosts
        #    and essential services (github, ampcode) are unrestricted.
        #    Skip if we just rewrote the request (it's now targeting an LLM host).
        if not rewritten and host not in SECRET_INJECTION_HOSTS and host not in UNRESTRICTED_METHOD_HOSTS:
            method = flow.request.method.upper()
            if method not in SAFE_METHODS:
                flow.response = http.Response.make(
                    403,
                    f"Blocked by method filter: {method} not allowed for {host}".encode(),
                    {"content-type": "text/plain"},
                )
                log.warning("method_blocked: %s not allowed for %s", method, host)
                return

        # 6. Secret injection: replace known key placeholders in ALL outbound
        #    requests.  Security is enforced by method filtering (step 5) and
        #    SSRF protection (step 3), not by restricting which hosts receive
        #    real credentials.  This avoids maintaining a static host allowlist
        #    that breaks whenever a new provider or tool API is added.
        self._replace_in_headers(flow)

        # 7. Audit-only body inspection for prompt injection patterns
        self._inspect_request_body(flow)

    # ------------------------------------------------------------------
    # mitmproxy response hook — block redirects to internal IPs
    # ------------------------------------------------------------------

    def response(self, flow: http.HTTPFlow) -> None:
        """Block redirects, scan for leaked secrets, and audit-log every request."""
        if flow.response and flow.response.status_code in (301, 302, 303, 307, 308):
            location = flow.response.headers.get("location", "")
            if location:
                try:
                    parsed = urllib.parse.urlparse(location)
                    if parsed.hostname and self._is_blocked_host(parsed.hostname):
                        flow.response = http.Response.make(
                            403,
                            b"Redirect to blocked destination",
                            {"content-type": "text/plain"},
                        )
                        log.warning("blocked redirect to %s", parsed.hostname)
                except Exception:
                    pass

        # Scan response body for leaked secret values and redact
        self._scan_response_body(flow)

        # Structured audit log with risk scoring
        req = flow.request
        resp = flow.response
        host = req.pretty_host.lower().rstrip(".")
        status = resp.status_code if resp else 0
        req_bytes = len(req.content) if req.content else 0
        resp_bytes = len(resp.content) if resp and resp.content else 0

        # Compute risk score
        risk_score = 0
        if req.method.upper() not in SAFE_METHODS:
            risk_score += 1
        if host in SECRET_INJECTION_HOSTS:
            risk_score += 2
        if req_bytes > 100_000:
            risk_score += 1
        if 400 <= status < 600:
            risk_score += 3

        # Categorize
        if host in SECRET_INJECTION_HOSTS:
            category = "llm_api"
        elif host in UNRESTRICTED_METHOD_HOSTS:
            category = "github"
        else:
            category = "general"

        source_ip = (
            flow.client_conn.peername[0] if flow.client_conn.peername else "unknown"
        )

        # Duration
        duration_ms = None
        if (
            resp
            and hasattr(resp, "timestamp_end")
            and resp.timestamp_end
            and hasattr(req, "timestamp_start")
            and req.timestamp_start
        ):
            duration_ms = round((resp.timestamp_end - req.timestamp_start) * 1000)

        log.info(
            "proxy_audit",
            extra={
                "event": "proxy_audit",
                "method": req.method,
                "host": req.pretty_host,
                "path": req.path[:200],
                "status": status,
                "resp_bytes": resp_bytes,
                "req_bytes": req_bytes,
                "risk_score": risk_score,
                "category": category,
                "container_ip": source_ip,
                "duration_ms": duration_ms,
            },
        )


addons = [CredentialInjector()]
