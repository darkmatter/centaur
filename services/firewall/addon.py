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
import ipaddress
import json
import logging
import os
import socket
import sys
import threading
import time
import urllib.parse
import urllib.request
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
CACHE_TTL = int(os.environ.get("FIREWALL_CACHE_TTL", "30"))
HEALTH_PORT = int(os.environ.get("HEALTH_PORT", "8081"))
KEYS_REFRESH_INTERVAL = int(os.environ.get("KEYS_REFRESH_INTERVAL", "60"))

_DEFAULT_INJECTION_HOSTS = (
    "api.openai.com,"
    "api.anthropic.com,"
    "api.together.ai,"
    "api.exa.ai,"
    "generativelanguage.googleapis.com,"
    "api.x.ai"
)

# Hosts that need POST/PUT/DELETE but don't get secret injection.
# These are essential sandbox services (git, GitHub API).
_DEFAULT_UNRESTRICTED_METHOD_HOSTS = (
    "github.com,"
    "api.github.com"
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

    def _refresh_keys(self) -> None:
        try:
            url = f"{SECRET_MANAGER_URL}/keys"
            with urllib.request.urlopen(url, timeout=5) as resp:
                data = json.loads(resp.read().decode())
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
            url = f"{SECRET_MANAGER_URL}/secrets/{urllib.parse.quote(key, safe='')}"
            with urllib.request.urlopen(url, timeout=3) as resp:
                val = json.loads(resp.read().decode()).get("value")
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
        """Replace any known key names in a header value with real secrets."""
        with self._keys_lock:
            keys = self._known_keys
            canonicalize_google_key = self._canonicalize_google_key

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
    # mitmproxy request hook
    # ------------------------------------------------------------------

    def request(self, flow: http.HTTPFlow) -> None:
        host = flow.request.pretty_host.lower().rstrip(".")

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

        # 5. HTTP method filtering: restrict non-LLM hosts to safe methods
        #    Skip if we just rewrote the request (it's now targeting an LLM host)
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

        # 6. Secret injection: only inject for allowlisted hosts
        if host in SECRET_INJECTION_HOSTS:
            self._replace_in_headers(flow)
        else:
            # Strip any key placeholders from headers for non-allowlisted hosts
            self._strip_key_placeholders(flow)

    # ------------------------------------------------------------------
    # mitmproxy response hook — block redirects to internal IPs
    # ------------------------------------------------------------------

    def response(self, flow: http.HTTPFlow) -> None:
        """Block redirects to internal/private IPs and audit-log every request."""
        if flow.response and flow.response.status_code in (301, 302, 303, 307, 308):
            location = flow.response.headers.get("location", "")
            if location:
                try:
                    from urllib.parse import urlparse
                    parsed = urlparse(location)
                    if parsed.hostname and self._is_blocked_host(parsed.hostname):
                        flow.response = http.Response.make(
                            403,
                            b"Redirect to blocked destination",
                            {"content-type": "text/plain"},
                        )
                        log.warning("blocked redirect to %s", parsed.hostname)
                except Exception:
                    pass

        # Audit log: record every proxied request (no secret values)
        req = flow.request
        resp = flow.response
        content_length = len(resp.content) if resp and resp.content else 0
        log.info(
            "proxy_audit",
            extra={
                "event": "proxy_audit",
                "method": req.method,
                "host": req.pretty_host,
                "path": req.path[:200],
                "status": resp.status_code if resp else 0,
                "resp_bytes": content_length,
                "req_bytes": len(req.content) if req.content else 0,
            },
        )


addons = [CredentialInjector()]
