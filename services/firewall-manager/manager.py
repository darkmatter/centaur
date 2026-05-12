"""firewall-manager: control-plane sidecar for iron-proxy.

Polls the API for the host→keys injection map, rewrites the iron-proxy YAML
config when the map changes, and triggers a hot reload through iron-proxy's
management API.

Endpoints:
  GET  /health         — liveness, no auth
  GET  /health/ready   — readiness, no auth; ready after first map apply
  GET  /health/detail  — bearer-auth, last-reload state
  POST /injection-map  — bearer-auth, deprecated manual override;
                         replaces the host→keys allowlist;
                         rewrites proxy.yaml and POSTs /v1/reload to iron-proxy
"""

from __future__ import annotations

import json
import os
import random
import signal
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

import httpx
import structlog
import yaml

CONTROL_TOKEN = os.environ.get("FIREWALL_CONTROL_TOKEN", "").strip()
HEALTH_PORT = int(os.environ.get("FIREWALL_MANAGER_PORT", "8081"))
IRON_PROXY_CONFIG_PATH = Path(
    os.environ.get("IRON_PROXY_CONFIG_PATH", "/etc/iron-proxy/proxy.yaml")
)
IRON_PROXY_MANAGEMENT_URL = os.environ.get(
    "IRON_PROXY_MANAGEMENT_URL", "http://iron-proxy:9092"
).rstrip("/")
IRON_MANAGEMENT_API_KEY = os.environ.get("IRON_MANAGEMENT_API_KEY", "").strip()
INJECTION_MAP_URL = os.environ.get(
    "FIREWALL_MANAGER_INJECTION_MAP_URL",
    "http://api:8000/internal/injection-map",
).strip()
POLL_INTERVAL_S = float(os.environ.get("FIREWALL_MANAGER_POLL_INTERVAL_SECONDS", "30"))
POLL_JITTER_S = float(os.environ.get("FIREWALL_MANAGER_POLL_JITTER_SECONDS", "10"))
POLL_TIMEOUT_S = float(os.environ.get("FIREWALL_MANAGER_POLL_TIMEOUT_SECONDS", "5"))
STARTUP_BACKOFF_INITIAL_S = float(
    os.environ.get("FIREWALL_MANAGER_STARTUP_BACKOFF_INITIAL_SECONDS", "0.5")
)
STARTUP_BACKOFF_MAX_S = float(
    os.environ.get("FIREWALL_MANAGER_STARTUP_BACKOFF_MAX_SECONDS", "5")
)
SECRET_SOURCE = os.environ.get("FIREWALL_MANAGER_SECRET_SOURCE", "env").strip().lower()
SECRET_TTL = os.environ.get("FIREWALL_MANAGER_SECRET_TTL", "10m").strip()
OP_VAULT = os.environ.get("OP_VAULT", "ai-agents").strip()

# Headers iron-proxy will scan for proxy_value placeholders.  Literal
# strings match a single header name; values wrapped in /.../ are
# interpreted as regexes.
DEFAULT_MATCH_HEADERS: tuple[str, ...] = (
    "Authorization",
    "Proxy-Authorization",
    "Api-Key",
    "Anthropic-Api-Key",
    "Auth-Token",
    "Jwt",
    "Cookie",
    "Apikey",
    "AccessKey",
    "Api-Access-Key",
    "Api-Signature",
    "FX-ACCESS-KEY",
    "FX-ACCESS-SIGN",
    "FX-ACCESS-PASSPHRASE",
    "X-CB-ACCESS-PASSPHRASE",
    "X-CB-ACCESS-SIGNATURE",
    "/^x-[a-z0-9-]*(api-key|apikey|secret|token|auth|key)$/",
)

log = structlog.get_logger("firewall-manager")


def _build_source(key: str) -> dict[str, str]:
    """Translate a centaur key name to iron-proxy's secret source schema.

    1Password items are named after the env var (``key``) with the secret
    on the ``credential`` field, so the ref is built deterministically from
    the key name. iron-proxy resolves the source itself.
    """
    if SECRET_SOURCE == "onepassword":
        return {
            "type": "1password",
            "secret_ref": f"op://{OP_VAULT}/{key}/credential",
            "ttl": SECRET_TTL,
        }
    return {"type": "env", "var": key}


def _build_secret_transform(
    injection_map: dict[str, list[str]],
) -> dict[str, Any] | None:
    """Convert {host: [keys]} → an iron-proxy `secrets` transform block.

    Inverts the map so each key gets one entry with all its allowed hosts as
    rules.  Returns None when the map is empty so callers can omit the
    transform entirely.
    """
    by_key: dict[str, list[str]] = {}
    for host, keys in injection_map.items():
        for key in keys:
            by_key.setdefault(key, []).append(host)

    if not by_key:
        return None

    secrets = []
    for key in sorted(by_key):
        hosts = sorted(set(by_key[key]))
        secrets.append(
            {
                "source": _build_source(key),
                "proxy_value": key,
                "match_headers": list(DEFAULT_MATCH_HEADERS),
                "rules": [{"host": h} for h in hosts],
            }
        )

    return {"name": "secrets", "config": {"secrets": secrets}}


def _render_config(injection_map: dict[str, list[str]]) -> str:
    """Load proxy.yaml, splice the new `secrets` transform in, dump as YAML.

    Other transforms (allowlist, log config, listeners) are preserved
    verbatim so this service stays a single-purpose translator.
    """
    with IRON_PROXY_CONFIG_PATH.open("r") as f:
        cfg = yaml.safe_load(f) or {}

    transforms = list(cfg.get("transforms") or [])
    transforms = [t for t in transforms if (t or {}).get("name") != "secrets"]

    secret_transform = _build_secret_transform(injection_map)
    if secret_transform is not None:
        for index, transform in enumerate(transforms):
            if (transform or {}).get("name") == "header_allowlist":
                transforms.insert(index, secret_transform)
                break
        else:
            transforms.append(secret_transform)

    cfg["transforms"] = transforms
    return yaml.safe_dump(cfg, sort_keys=False)


def _atomic_write(path: Path, content: str) -> None:
    """Write content to path via a same-directory temp + rename(2)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=".proxy.yaml.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except FileNotFoundError:
            pass
        raise


def _trigger_iron_proxy_reload() -> None:
    headers = (
        {"Authorization": f"Bearer {IRON_MANAGEMENT_API_KEY}"}
        if IRON_MANAGEMENT_API_KEY
        else {}
    )
    with httpx.Client(timeout=30.0) as client:
        resp = client.post(f"{IRON_PROXY_MANAGEMENT_URL}/v1/reload", headers=headers)
        resp.raise_for_status()


def _normalize_injection_map(data: Any) -> dict[str, list[str]]:
    if not isinstance(data, dict):
        raise ValueError("injection map must be a JSON object {host: [keys]}")

    normalized: dict[str, list[str]] = {}
    for host, keys in data.items():
        if not isinstance(host, str) or not isinstance(keys, list):
            raise ValueError("each injection map value must be a list of key names")
        normalized[host] = sorted({k for k in keys if isinstance(k, str)})
    return dict(sorted(normalized.items()))


def _fetch_injection_map() -> dict[str, list[str]]:
    with httpx.Client(timeout=POLL_TIMEOUT_S) as client:
        resp = client.get(INJECTION_MAP_URL)
        resp.raise_for_status()
        return _normalize_injection_map(resp.json())


def _apply_injection_map(
    normalized: dict[str, list[str]], *, force: bool = False
) -> bool:
    """Apply an already-normalized injection map.

    Returns True when iron-proxy was reloaded and False when the map matched
    the currently applied config.
    """
    with state.lock:
        unchanged = state.ever_pushed and normalized == state.last_map
    if unchanged and not force:
        return False

    rendered = _render_config(normalized)
    _atomic_write(IRON_PROXY_CONFIG_PATH, rendered)
    _trigger_iron_proxy_reload()

    with state.lock:
        state.last_map = normalized
        state.last_pushed_wall = time.time()
        state.last_pushed_monotonic = time.monotonic()
        state.consecutive_failures = 0
        state.ever_pushed = True
    log.info(
        "injection_map_applied",
        hosts=len(normalized),
        keys=sum(len(v) for v in normalized.values()),
    )
    return True


def _poll_delay() -> float:
    jitter = random.uniform(0, max(POLL_JITTER_S, 0))
    return max(POLL_INTERVAL_S, 0) + jitter


def _startup_retry_delay(failures: int) -> float:
    exponent = max(failures - 1, 0)
    backoff = max(STARTUP_BACKOFF_INITIAL_S, 0) * (2**exponent)
    capped = min(backoff, max(STARTUP_BACKOFF_MAX_S, 0))
    jitter = random.uniform(0, min(max(POLL_JITTER_S, 0), capped))
    return capped + jitter


def _next_poll_delay() -> float:
    with state.lock:
        loaded = state.ever_pushed
        failures = state.consecutive_failures
    if loaded:
        return _poll_delay()
    return _startup_retry_delay(failures)


class State:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.last_map: dict[str, list[str]] = {}
        self.last_pushed_wall: float | None = None
        self.last_pushed_monotonic: float | None = None
        self.consecutive_failures = 0
        self.ever_pushed = False


state = State()
_stop_event = threading.Event()


def _poll_loop() -> None:
    while not _stop_event.is_set():
        try:
            injection_map = _fetch_injection_map()
            applied = _apply_injection_map(injection_map)
            if not applied:
                with state.lock:
                    state.consecutive_failures = 0
                log.debug("injection_map_unchanged", hosts=len(injection_map))
        except Exception as exc:  # noqa: BLE001 - keep last good proxy config on any poll failure
            with state.lock:
                state.consecutive_failures += 1
                failures = state.consecutive_failures
            log.warning(
                "injection_map_poll_failed",
                url=INJECTION_MAP_URL,
                failures=failures,
                error=str(exc),
            )
        _stop_event.wait(_next_poll_delay())


class Handler(BaseHTTPRequestHandler):
    def _check_auth(self) -> bool:
        if self.headers.get("Authorization", "") == f"Bearer {CONTROL_TOKEN}":
            return True
        self._json(403, {"error": "forbidden"})
        return False

    def _json(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _health_detail(self) -> dict[str, Any]:
        with state.lock:
            last_wall = state.last_pushed_wall
            last_mono = state.last_pushed_monotonic
            failures = state.consecutive_failures
            ever = state.ever_pushed
            host_count = len(state.last_map)
            key_count = sum(len(v) for v in state.last_map.values())
        age_s = (
            round(time.monotonic() - last_mono, 3) if last_mono is not None else None
        )
        return {
            "status": "ok",
            "injection_map_hosts": host_count,
            "injection_map_keys": key_count,
            "injection_map_loaded": ever,
            "injection_map_age_s": age_s,
            "injection_map_last_success_unix": last_wall,
            "injection_map_consecutive_failures": failures,
            "injection_map_url": INJECTION_MAP_URL,
            "iron_proxy_management_url": IRON_PROXY_MANAGEMENT_URL,
        }

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        if self.path == "/health":
            self._json(200, {"status": "ok"})
            return
        if self.path == "/health/ready":
            with state.lock:
                ready = state.ever_pushed
                failures = state.consecutive_failures
            if ready:
                self._json(200, {"status": "ok", "injection_map_loaded": True})
            else:
                self._json(
                    503,
                    {
                        "status": "not_ready",
                        "injection_map_loaded": False,
                        "injection_map_consecutive_failures": failures,
                    },
                )
            return
        if self.path == "/health/detail":
            if not self._check_auth():
                return
            self._json(200, self._health_detail())
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/injection-map":
            self._json(404, {"error": "not found"})
            return
        if not self._check_auth():
            return

        length = int(self.headers.get("Content-Length", 0) or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode())
        except json.JSONDecodeError as exc:
            self._json(400, {"error": f"invalid json: {exc}"})
            return
        try:
            normalized = _normalize_injection_map(data)
        except ValueError as exc:
            self._json(400, {"error": str(exc)})
            return

        try:
            _apply_injection_map(normalized, force=True)
        except FileNotFoundError as exc:
            with state.lock:
                state.consecutive_failures += 1
            log.error(
                "config_missing", path=str(IRON_PROXY_CONFIG_PATH), error=str(exc)
            )
            self._json(
                503,
                {"error": f"iron-proxy config not found at {IRON_PROXY_CONFIG_PATH}"},
            )
            return
        except httpx.HTTPError as exc:
            with state.lock:
                state.consecutive_failures += 1
            log.error("iron_proxy_reload_failed", error=str(exc))
            self._json(502, {"error": f"iron-proxy reload failed: {exc}"})
            return
        except Exception as exc:  # noqa: BLE001 — surface render errors to caller
            with state.lock:
                state.consecutive_failures += 1
            log.error("injection_map_apply_failed", error=str(exc))
            self._json(500, {"error": str(exc)})
            return

        self._json(200, {"status": "ok"})

    def log_request(self, code: int | str = "-", size: int | str = "-") -> None:  # noqa: ARG002
        client = self.client_address[0] if self.client_address else "?"
        log.info(
            "http_request",
            method=getattr(self, "command", "?"),
            path=getattr(self, "path", "?"),
            status=code,
            client=client,
        )

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: ARG002
        return


def main() -> None:
    structlog.configure(
        processors=[
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso", utc=True),
            structlog.processors.JSONRenderer(),
        ]
    )
    if not CONTROL_TOKEN:
        log.error("control_token_missing")
        sys.stderr.write(
            "FIREWALL_CONTROL_TOKEN is not set. Refusing to start: "
            "an empty token would leave /injection-map unauthenticated.\n"
        )
        sys.exit(1)
    if not IRON_MANAGEMENT_API_KEY:
        log.error("iron_management_api_key_missing")
        sys.stderr.write("IRON_MANAGEMENT_API_KEY is not set — refusing to start.\n")
        sys.exit(1)

    log.info(
        "firewall_manager_starting",
        port=HEALTH_PORT,
        config=str(IRON_PROXY_CONFIG_PATH),
        management_url=IRON_PROXY_MANAGEMENT_URL,
        injection_map_url=INJECTION_MAP_URL,
        poll_interval_s=POLL_INTERVAL_S,
        poll_jitter_s=POLL_JITTER_S,
        startup_backoff_initial_s=STARTUP_BACKOFF_INITIAL_S,
        startup_backoff_max_s=STARTUP_BACKOFF_MAX_S,
        secret_source=SECRET_SOURCE,
        op_vault=OP_VAULT if SECRET_SOURCE == "onepassword" else None,
    )
    server = HTTPServer(("0.0.0.0", HEALTH_PORT), Handler)

    def request_shutdown(signum: int, _frame: Any) -> None:
        log.info("shutdown_signal_received", signal=signum)
        _stop_event.set()
        threading.Thread(
            target=server.shutdown,
            name="http-server-shutdown",
            daemon=True,
        ).start()

    signal.signal(signal.SIGTERM, request_shutdown)
    signal.signal(signal.SIGINT, request_shutdown)

    threading.Thread(
        target=_poll_loop, name="injection-map-poller", daemon=True
    ).start()
    try:
        server.serve_forever(poll_interval=0.1)
    finally:
        _stop_event.set()
        server.server_close()
        log.info("firewall_manager_stopped")


if __name__ == "__main__":
    main()
