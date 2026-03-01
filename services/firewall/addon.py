"""Firewall addon — stateless credential injection via secrets service.

Intercepts outgoing HTTP/HTTPS requests from sandbox containers and injects
real API credentials.  The proxy itself holds NO persistent state — credentials
are fetched from the secrets service (backed by 1Password) and cached in
memory with a short TTL.

Architecture::

    Sandbox Container ──► Firewall ──► Upstream API
    (placeholder keys)    (injects real   (sees real
                           credentials)    credentials)

Security properties:
    • Sandboxes never see real API keys (only placeholders)
    • Credentials exist only in-memory in this process
    • Secrets service is the single source of truth (1Password-backed)
    • Firewall is stateless — horizontally scalable
    • Requests to the secrets service are blocked (no exfiltration)
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

from mitmproxy import http

log = logging.getLogger("firewall.secrets")

# ── Configuration ──────────────────────────────────────────────────────────

SECRET_MANAGER_URL = os.environ.get("SECRET_MANAGER_URL", "http://secrets:8100")
CACHE_TTL = int(os.environ.get("FIREWALL_CACHE_TTL", os.environ.get("MITM_CACHE_TTL", "30")))  # seconds
HEALTH_PORT = int(os.environ.get("HEALTH_PORT", "8081"))

# Hosts that sandboxes must NEVER reach through the proxy.
BLOCKED_HOSTS: frozenset[str] = frozenset({
    "secrets",
    "169.254.169.254",  # cloud metadata
})

# ── Injection rules ───────────────────────────────────────────────────────
# host → list of (header_name, value_template)
# Templates use {SECRET_KEY} placeholders resolved from the secrets service.

_DEFAULT_RULES: dict[str, list[tuple[str, str]]] = {
    # LLM providers (used by harness CLIs)
    "api.anthropic.com": [
        ("x-api-key", "{ANTHROPIC_API_KEY}"),
    ],
    "api.openai.com": [
        ("authorization", "Bearer {OPENAI_API_KEY}"),
    ],
    # GitHub (git + gh CLI)
    "api.github.com": [
        ("authorization", "token {GITHUB_TOKEN}"),
    ],
    "github.com": [
        ("authorization", "Basic {_GITHUB_BASIC}"),
    ],
    # Amp CLI (uses ampcode.com, not api.ampcode.com)
    "ampcode.com": [
        ("authorization", "Bearer {AMP_API_KEY}"),
    ],
}

_SECRET_RE = re.compile(r"\{(\w+)\}")


def _load_rules() -> dict[str, list[tuple[str, str]]]:
    """Load injection rules, merging defaults with any FIREWALL_EXTRA_RULES."""
    rules = dict(_DEFAULT_RULES)
    extra = os.environ.get("FIREWALL_EXTRA_RULES", os.environ.get("MITM_EXTRA_RULES"))
    if extra:
        for host, entries in json.loads(extra).items():
            rules[host] = [(h, v) for h, v in entries]
    return rules


# ── Addon ──────────────────────────────────────────────────────────────────


class CredentialInjector:
    """Firewall addon that injects credentials from the secrets service."""

    def __init__(self) -> None:
        self._secrets: dict[str, str] = {}
        self._last_refresh: float = 0.0
        self._lock = threading.Lock()
        self._rules = _load_rules()

        # Collect all secret keys referenced in rules (skip derived _keys)
        self._needed_keys: set[str] = set()
        for entries in self._rules.values():
            for _, template in entries:
                self._needed_keys.update(
                    m.group(1)
                    for m in _SECRET_RE.finditer(template)
                    if not m.group(1).startswith("_")
                )

        log.info(
            "credential injector: %d host rules, %d secrets needed",
            len(self._rules),
            len(self._needed_keys),
        )

        self._start_health_server()

    # ── Health endpoint ───────────────────────────────────────────────

    def _start_health_server(self) -> None:
        parent = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if self.path == "/health":
                    with parent._lock:
                        count = len(parent._secrets)
                    body = json.dumps({"status": "ok", "secrets_loaded": count})
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(body.encode())
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format: str, *args: object) -> None:  # noqa: A002
                pass

        def serve() -> None:
            server = HTTPServer(("0.0.0.0", HEALTH_PORT), Handler)  # noqa: S104
            server.serve_forever()

        threading.Thread(target=serve, daemon=True).start()
        log.info("health server listening on :%d", HEALTH_PORT)

    # ── Secret fetching ───────────────────────────────────────────────

    def _fetch_secret(self, key: str) -> str | None:
        """Fetch a single secret from the secrets service."""
        try:
            url = f"{SECRET_MANAGER_URL}/secrets/{urllib.parse.quote(key, safe='')}"
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                return data.get("value")
        except urllib.error.HTTPError as e:
            log.warning("secret %s: HTTP %d from secret manager", key, e.code)
            return None
        except Exception as e:
            log.warning("secret %s: fetch failed: %s", key, e)
            return None

    def _refresh_if_needed(self) -> None:
        """Refresh the in-memory secret cache if TTL has expired."""
        now = time.monotonic()
        if now - self._last_refresh < CACHE_TTL:
            return
        with self._lock:
            # Double-check after acquiring lock
            if time.monotonic() - self._last_refresh < CACHE_TTL:
                return
            new_secrets: dict[str, str] = {}
            resolved: list[str] = []
            missing: list[str] = []
            for key in self._needed_keys:
                val = self._fetch_secret(key)
                if val:
                    new_secrets[key] = val
                    resolved.append(key)
                else:
                    missing.append(key)

            # Compute derived keys
            gh_token = new_secrets.get("GITHUB_TOKEN", "")
            if gh_token:
                new_secrets["_GITHUB_BASIC"] = base64.b64encode(
                    f"x-access-token:{gh_token}".encode()
                ).decode()

            self._secrets = new_secrets
            self._last_refresh = time.monotonic()
            log.info(
                "refreshed secrets: resolved=[%s], missing=[%s]",
                ", ".join(sorted(resolved)),
                ", ".join(sorted(missing)),
            )

    def _resolve(self, template: str) -> str:
        """Resolve {KEY} placeholders in a template string."""

        def _repl(m: re.Match) -> str:
            key = m.group(1)
            val = self._secrets.get(key)
            if val is None:
                log.warning("secret %s not resolved", key)
                return m.group(0)  # leave placeholder intact
            return val

        return _SECRET_RE.sub(_repl, template)

    # ── mitmproxy hooks (firewall) ──────────────────────────────────

    def request(self, flow: http.HTTPFlow) -> None:
        host = flow.request.pretty_host.lower()

        # Block access to sensitive internal services
        if host.rstrip(".") in BLOCKED_HOSTS:
            flow.response = http.Response.make(
                403,
                b"Blocked by security policy",
                {"content-type": "text/plain"},
            )
            log.warning("blocked request to %s", host)
            return

        # Check if this host has injection rules
        rules = self._rules.get(host)
        if not rules:
            return

        self._refresh_if_needed()

        for header, template in rules:
            value = self._resolve(template)
            if "{" not in value:  # fully resolved (no unresolved placeholders)
                flow.request.headers[header] = value


addons = [CredentialInjector()]
