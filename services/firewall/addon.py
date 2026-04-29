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
import math
import os
import re
import socket
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, HTTPServer

from mitmproxy import http, tls

from centaur_sdk.logging import configure_json_logging

log = configure_json_logging("firewall")

SECRET_MANAGER_URL = os.environ.get("SECRET_MANAGER_URL", "http://secrets:8100")
API_URL = os.environ.get("API_URL", "http://api:8000")
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
    "ampcode.com,"
    "*.ampworkers.com"
)

# Hosts that need POST/PUT/DELETE but don't get secret injection.
# These are essential sandbox services (git, GitHub API).
_DEFAULT_UNRESTRICTED_METHOD_HOSTS = (
    "github.com,"
    "api.github.com,"
    "ampcode.com,"
    "*.ampworkers.com"
)
SECRET_INJECTION_HOSTS: frozenset[str] = frozenset(
    h.strip().lower()
    for h in os.environ.get(
        "FIREWALL_SECRET_INJECTION_HOSTS", _DEFAULT_INJECTION_HOSTS
    ).split(",")
    if h.strip()
)

_PRIVATE_NETWORKS = (
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),
    # IPv6 loopback and private ranges
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("fc00::/7"),
    # IPv4-mapped IPv6 ranges
    ipaddress.ip_network("::ffff:127.0.0.0/104"),
    ipaddress.ip_network("::ffff:10.0.0.0/104"),
    ipaddress.ip_network("::ffff:172.16.0.0/108"),
    ipaddress.ip_network("::ffff:192.168.0.0/112"),
    ipaddress.ip_network("::ffff:169.254.0.0/112"),
    ipaddress.ip_network("::ffff:0.0.0.0/104"),
)

# Internal hosts that sandboxes are allowed to reach despite resolving to
# private IPs.  These are Docker-internal service names on agent_net.
TRUSTED_INTERNAL_HOSTS: frozenset[str] = frozenset(
    h.strip().lower()
    for h in os.environ.get("FIREWALL_TRUSTED_INTERNAL_HOSTS", "api").split(",")
    if h.strip()
)

SENSITIVE_INBOUND_HEADERS: frozenset[str] = frozenset()

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
    "accept-language", "authorization", "x-api-key", "x-browser-use-api-key",
    "anthropic-version",
    "anthropic-beta", "openai-organization", "openai-project",
    "x-request-id", "x-stainless-arch", "x-stainless-os",
    "x-stainless-lang", "x-stainless-runtime", "x-stainless-runtime-version",
    "x-stainless-package-version", "x-stainless-retry-count",
    "connection", "transfer-encoding", "te",
    "upgrade", "origin", "sec-websocket-key", "sec-websocket-version",
    "sec-websocket-protocol", "sec-websocket-extensions",
    "cache-control", "pragma", "if-none-match", "if-modified-since",
    "range", "cookie",
    "notion-version",
    "jwt", "api-version",
})

# Header names that may legitimately carry a secret/placeholder value.
# Only these headers are scanned for key-name placeholders; non-credential
# headers (e.g. Content-Type, Accept) must never have substrings of secret
# names rewritten — that previously mangled `Content-Type: application/json`
# into `Content-Type: application/` when a secret named `json` existed.
CREDENTIAL_HEADER_NAMES: frozenset[str] = frozenset({
    "authorization",
    "proxy-authorization",
    "x-api-key",
    "api-key",
    "anthropic-api-key",
    "x-goog-api-key",
    "x-browser-use-api-key",
    "x-cg-pro-api-key",
    "x-cg-demo-api-key",
    "x-auth-token",
    "x-access-token",
    "auth-token",
    "jwt",
    "cookie",
})

CREDENTIAL_HEADER_SUFFIXES: tuple[str, ...] = (
    "-api-key",
    "-apikey",
    "-secret",
    "-token",
    "-auth",
)


def _is_credential_header(name: str) -> bool:
    """Return True if a header name is allowed to carry a credential placeholder."""
    n = name.lower()
    if n in CREDENTIAL_HEADER_NAMES:
        return True
    if n.startswith("x-") and any(n.endswith(suffix) for suffix in CREDENTIAL_HEADER_SUFFIXES):
        return True
    return False


FIXED_USER_AGENT = "ai-v2-sandbox/1.0"

RATE_LIMIT = int(os.environ.get("FIREWALL_RATE_LIMIT", "500"))
RATE_WINDOW = 60  # seconds

BODY_INSPECTION_ENABLED = os.environ.get("FIREWALL_BODY_INSPECTION", "0") == "1"
CONTROL_TOKEN = os.environ.get("FIREWALL_CONTROL_TOKEN", "")


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


def _load_host_rewrites() -> dict[str, str]:
    raw = os.environ.get("FIREWALL_HOST_REWRITES", "").strip()
    if not raw:
        return {}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            "FIREWALL_HOST_REWRITES must be a JSON object mapping source hosts to upstream hosts"
        ) from exc

    if not isinstance(data, dict):
        raise RuntimeError(
            "FIREWALL_HOST_REWRITES must be a JSON object mapping source hosts to upstream hosts"
        )

    rewrites: dict[str, str] = {}
    for source, target in data.items():
        if not isinstance(source, str) or not isinstance(target, str):
            raise RuntimeError(
                "FIREWALL_HOST_REWRITES must contain only string hostnames"
            )
        source_host = source.strip().lower().rstrip(".")
        target_host = target.strip().lower().rstrip(".")
        if not source_host or not target_host:
            raise RuntimeError("FIREWALL_HOST_REWRITES entries cannot be empty")
        rewrites[source_host] = target_host
    return rewrites


class CredentialInjector:
    def __init__(self) -> None:
        # Fail-closed on unset control token: /secrets/{key} and /injection-map
        # would otherwise serve unauthenticated to anything reachable on the
        # firewall's internal networks (including sandbox containers), which
        # defeats the "agent never sees your secrets" guarantee.
        if not CONTROL_TOKEN:
            raise RuntimeError(
                "FIREWALL_CONTROL_TOKEN is not set. Refusing to start: "
                "an empty token would leave /secrets/{key} and /injection-map "
                "unauthenticated. Set FIREWALL_CONTROL_TOKEN to a random "
                "value (e.g. `openssl rand -hex 32`) on the firewall and on "
                "every service that calls the firewall control plane."
            )
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
        # Injection map: host_pattern → set of allowed key names
        self._injection_map: dict[str, set[str]] = {}
        self._injection_map_lock = threading.Lock()
        log.info("credential injector started (stateless header-value replacement)")
        log.info("secret injection allowlist: %s", SECRET_INJECTION_HOSTS)
        if HOST_REWRITES:
            log.info("host rewrites configured: %d", len(HOST_REWRITES))
        self._start_health_server()
        self._start_keys_refresh()

    # ------------------------------------------------------------------
    # TLS handshake customization
    # ------------------------------------------------------------------

    def tls_start_server(self, tls_start: tls.TlsData) -> None:
        client_sni = tls_start.context.client.sni
        if not client_sni:
            return

        source_host = client_sni.lower().rstrip(".")
        target_host = HOST_REWRITES.get(source_host)
        if not target_host:
            return

        tls_start.conn.sni = target_host
        log.info("tls sni rewrite: %s → %s", source_host, target_host)

    # ------------------------------------------------------------------
    # Health server
    # ------------------------------------------------------------------

    def _start_health_server(self) -> None:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def _check_control_auth(self) -> bool:
                """Verify control token for sensitive endpoints. Returns True if OK."""
                auth = self.headers.get("Authorization", "")
                if auth == f"Bearer {CONTROL_TOKEN}":
                    return True
                self.send_response(403)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "forbidden"}).encode())
                return False

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
                elif self.path.startswith("/secrets/"):
                    if not self._check_control_auth():
                        return
                    key = self.path[len("/secrets/"):]
                    key = urllib.parse.unquote(key)
                    val = parent._get_secret(key)
                    if val is None:
                        self.send_response(404)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps({"error": "not found"}).encode())
                        return
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"value": val}).encode())
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self) -> None:
                if self.path == "/injection-map":
                    if not self._check_control_auth():
                        return
                    length = int(self.headers.get("Content-Length", 0))
                    body = self.rfile.read(length) if length else b""
                    try:
                        data = json.loads(body.decode())
                        new_map: dict[str, set[str]] = {}
                        for host_pattern, key_list in data.items():
                            new_map[host_pattern] = set(key_list)
                        with parent._injection_map_lock:
                            parent._injection_map = new_map
                        log.info(
                            "injection_map_pushed",
                            extra={
                                "event": "injection_map_pushed",
                                "host_count": len(new_map),
                                "key_count": sum(len(v) for v in new_map.values()),
                            },
                        )
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps({"status": "ok"}).encode())
                    except Exception as e:
                        self.send_response(400)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps({"error": str(e)}).encode())
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
            # Fast retry on startup until both keys and injection map are loaded,
            # then settle into the normal refresh interval.  This makes the
            # firewall tolerant of any service startup order.
            backoff = 2
            while True:
                self._refresh_keys()
                self._refresh_injection_map()
                with self._injection_map_lock:
                    map_loaded = bool(self._injection_map)
                with self._keys_lock:
                    keys_loaded = bool(self._known_keys)
                if map_loaded and keys_loaded:
                    break
                log.info("waiting for keys/injection-map, retrying in %ds", backoff)
                time.sleep(backoff)
                backoff = min(backoff * 2, 30)
            # Steady-state refresh. Keep pulling the injection map too so a
            # firewall recreate without an API restart recovers on its own
            # instead of staying fail-closed until the next tool-file change.
            while True:
                time.sleep(KEYS_REFRESH_INTERVAL)
                self._refresh_keys()
                self._refresh_injection_map()

        threading.Thread(target=loop, daemon=True).start()

    def _refresh_injection_map(self) -> None:
        url = f"{API_URL}/internal/injection-map"
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
            new_map: dict[str, set[str]] = {
                host: set(keys) for host, keys in data.items()
            }
            with self._injection_map_lock:
                self._injection_map = new_map
            log.info(
                "injection_map_pulled",
                extra={
                    "event": "injection_map_pulled",
                    "host_count": len(new_map),
                    "key_count": sum(len(v) for v in new_map.values()),
                },
            )
        except Exception as exc:
            log.warning("injection_map_pull_failed: %s", exc)

    def _sm_request(self, path: str, timeout: int = 5) -> bytes:
        """Make a request to the secret manager."""
        url = f"{SECRET_MANAGER_URL}{path}"
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()

    def _host_matches_pattern(self, host: str, pattern: str) -> bool:
        """Check if a host matches a pattern (supports *.domain.com wildcards)."""
        if pattern == host:
            return True
        if pattern.startswith("*."):
            suffix = pattern[1:]  # ".domain.com"
            # Match exact domain: *.domain.com matches domain.com
            if host == pattern[2:]:
                return True
            # Match subdomains: *.domain.com matches sub.domain.com
            if host.endswith(suffix):
                return True
        return False

    def _host_in_patterns(self, host: str, patterns: frozenset[str]) -> bool:
        """Return True when a host matches any configured exact or wildcard pattern."""
        return any(self._host_matches_pattern(host, pattern) for pattern in patterns)

    def _get_allowed_keys_for_host(self, host: str) -> frozenset[str]:
        """Look up allowed keys for a host. Unmatched hosts receive no secrets."""
        with self._injection_map_lock:
            injection_map = self._injection_map.copy()
        if not injection_map:
            return frozenset()  # No map loaded — deny all (fail-closed)
        allowed: set[str] = set()
        for pattern, keys in injection_map.items():
            if self._host_matches_pattern(host, pattern):
                allowed.update(keys)
        return frozenset(allowed)

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

    def _replace_key_names_filtered(
        self,
        value: str,
        host: str,
        allowed_keys: frozenset[str],
        source_ip: str,
    ) -> str:
        """Replace key names with real secrets, respecting the injection map.

        Hosts that are not explicitly allowed receive an empty allowed_keys set,
        so placeholders are stripped instead of being expanded.
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

            if key_name not in allowed_keys:
                log.warning(
                    "injection_map_violation",
                    extra={
                        "event": "injection_map_violation",
                        "key_name": key_name,
                        "host": host,
                        "allowed_keys": sorted(allowed_keys),
                        "container_ip": source_ip,
                    },
                )
                value = value.replace(key_name, "")
                continue

            secret = self._get_secret(key_name)
            if secret is not None:
                value = value.replace(key_name, secret)
        return value

    def _replace_in_headers(self, flow: http.HTTPFlow) -> None:
        """Scan all header values and replace key names with real secrets.

        When an injection map is available, only inject keys that are allowed
        for the destination host. Strip any other key placeholders.
        """
        with self._keys_lock:
            keys = self._known_keys
        if not keys:
            return

        host = flow.request.pretty_host.lower().rstrip(".")
        allowed_keys = self._get_allowed_keys_for_host(host)
        source_ip = flow.client_conn.peername[0] if flow.client_conn.peername else "unknown"

        for header_name in list(flow.request.headers.keys()):
            # Only scan headers whose name is a known credential carrier.
            # This prevents substrings of secret key names (e.g. a secret
            # named "json") from being rewritten inside unrelated headers
            # such as Content-Type or Accept.
            if not _is_credential_header(header_name):
                continue

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
                replaced = self._replace_key_names_filtered(decoded, host, allowed_keys, source_ip)
                if replaced != decoded:
                    flow.request.headers[header_name] = (
                        "Basic " + base64.b64encode(replaced.encode()).decode()
                    )
                continue

            # Regular header value scan
            has_key = any(k in value for k in keys)
            if not has_key:
                continue
            replaced = self._replace_key_names_filtered(value, host, allowed_keys, source_ip)
            if replaced != value:
                flow.request.headers[header_name] = replaced

    def _replace_in_url(self, flow: http.HTTPFlow) -> None:
        """Scan URL path and query for key name placeholders and replace with real secrets.

        Some APIs (e.g. Alchemy) embed the API key in the URL path rather than
        a header.  This method applies the same replacement logic as
        ``_replace_in_headers`` but to the request URL.
        """
        with self._keys_lock:
            keys = self._known_keys
        if not keys:
            return

        url = flow.request.url
        has_key = any(k in url for k in keys)
        if not has_key:
            return

        host = flow.request.pretty_host.lower().rstrip(".")
        allowed_keys = self._get_allowed_keys_for_host(host)
        source_ip = flow.client_conn.peername[0] if flow.client_conn.peername else "unknown"
        replaced = self._replace_key_names_filtered(url, host, allowed_keys, source_ip)
        if replaced != url:
            flow.request.url = replaced

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
        """Resolve host and block if any resolved IP is private/internal.

        Trusted internal hosts (e.g. the API service) are exempt — sandboxes
        are allowed to reach them even though they resolve to private IPs.
        """
        if self._host_in_patterns(host, TRUSTED_INTERNAL_HOSTS):
            return False

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

    def _try_host_rewrite(self, flow: http.HTTPFlow, host: str) -> str | None:
        """Override upstream TLS SNI/Host while keeping the original TCP target."""
        target_host = HOST_REWRITES.get(host)
        if not target_host:
            return None

        flow.request.port = 443
        flow.request.scheme = "https"
        flow.request.headers["host"] = target_host
        flow.server_conn.sni = target_host
        log.info("host rewrite: %s → %s (tcp target unchanged)", host, target_host)
        return target_host

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
        """Strip non-whitelisted headers and force a fixed User-Agent.

        Headers whose values contain a known secret key placeholder are kept
        even if not in the static allowlist — they need to survive until
        ``_replace_in_headers`` swaps the placeholder for the real secret.
        """
        flow.request.headers["user-agent"] = FIXED_USER_AGENT

        to_remove = []
        for header_name in flow.request.headers:
            if header_name.lower() in ALLOWED_OUTBOUND_HEADERS or header_name.lower() == "user-agent":
                continue
            # Keep credential-bearing headers (e.g. x-cg-pro-api-key) so the
            # secret-injection step downstream can rewrite the placeholder.
            if _is_credential_header(header_name):
                continue
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
        # Scan responses from injection hosts and any host in the injection map
        if not self._host_in_patterns(host, SECRET_INJECTION_HOSTS) and not self._get_allowed_keys_for_host(host):
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
        if not self._host_in_patterns(host, SECRET_INJECTION_HOSTS):
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

        # 3. Rewrite exact internal aliases before SSRF so sandbox callers can
        #    keep stable names while the firewall uses the correct upstream SNI.
        host_rewritten_to = self._try_host_rewrite(flow, host)
        if host_rewritten_to:
            host = host_rewritten_to

        # 4. SSRF protection: resolve destination IP, block if private/internal
        if self._block_private_ip(flow, host):
            return

        # 5. Check for amp provider proxy rewrite (before method filtering
        #    so ampcode.com POSTs can be rewritten to LLM API hosts)
        provider_rewritten = self._try_provider_rewrite(flow, host)

        # Re-read host after potential provider rewrite
        host = flow.request.pretty_host.lower().rstrip(".")

        # 5b. Re-check SSRF after provider rewrite — the rewritten host
        # could resolve to a private IP
        if provider_rewritten and self._block_private_ip(flow, host):
            return

        # 6. HTTP method filtering: hosts not in the unrestricted set are
        #    limited to safe methods only (GET/HEAD/OPTIONS).  LLM API hosts,
        #    trusted internal services, and essential services are unrestricted.
        #    Skip if we just rewrote the request (it's now targeting an LLM host).
        #    Also allow hosts in the injection map (they're tool API hosts).
        host_in_injection_map = bool(self._get_allowed_keys_for_host(host))
        host_is_injection = self._host_in_patterns(host, SECRET_INJECTION_HOSTS)
        host_is_unrestricted = self._host_in_patterns(host, UNRESTRICTED_METHOD_HOSTS)
        host_is_trusted = self._host_in_patterns(host, TRUSTED_INTERNAL_HOSTS)
        if not provider_rewritten and not host_in_injection_map and not host_is_injection and not host_is_unrestricted and not host_is_trusted:
            method = flow.request.method.upper()
            if method not in SAFE_METHODS:
                flow.response = http.Response.make(
                    403,
                    f"Blocked by method filter: {method} not allowed for {host}".encode(),
                    {"content-type": "text/plain"},
                )
                log.warning("method_blocked: %s not allowed for %s", method, host)
                return

        # 7. Secret injection: replace known key placeholders only for hosts
        #    that are explicitly allowed by the injection map.
        self._replace_in_headers(flow)
        self._replace_in_url(flow)

        # 8. Audit-only body inspection for prompt injection patterns
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
        host_is_injection = self._host_in_patterns(host, SECRET_INJECTION_HOSTS)
        host_is_unrestricted = self._host_in_patterns(host, UNRESTRICTED_METHOD_HOSTS)
        if host_is_injection:
            risk_score += 2
        if req_bytes > 100_000:
            risk_score += 1
        if 400 <= status < 600:
            risk_score += 3

        # Categorize
        if host_is_injection:
            category = "llm_api"
        elif host_is_unrestricted:
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


HOST_REWRITES = _load_host_rewrites()


addons = [CredentialInjector()]
