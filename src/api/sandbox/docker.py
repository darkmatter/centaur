"""Docker sandbox backend — runs agent containers via the Docker SDK."""

from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Iterator
from typing import Any

import docker
import structlog
from docker.errors import NotFound

from api.deps import mint_sandbox_token
from api.sandbox.base import SandboxBackend, SandboxSession

log = structlog.get_logger()


# ── Helpers (module-level, not backend methods) ──────────────────────────────


def _image() -> str:
    return os.getenv("AGENT_IMAGE", "agent2:latest")


def _repos_host_dir() -> str:
    return os.getenv("REPOS_HOST_DIR", os.path.expanduser("~/github"))


def _get_injection_key_names() -> list[str]:
    """Get all secret key names from the tool manager's injection map."""
    try:
        from api.app import get_tool_manager

        tm = get_tool_manager()
        injection_map = tm.build_injection_map()
        keys: set[str] = set()
        for key_list in injection_map.values():
            keys.update(key_list)
        return sorted(keys)
    except Exception:
        log.warning("failed to get injection key names from tool manager")
        return []


def _container_env(
    thread_key: str,
    container_name: str,
    harness: str,
    engine: str,
) -> list[str]:
    """Build env vars for sandbox containers."""
    local_dev = os.getenv("AGENT_LOCAL_DEV", "").lower() in ("1", "true")

    # Mint a scoped, time-limited sandbox token instead of the root API key.
    try:
        api_key = mint_sandbox_token(thread_key, container_name)
    except Exception:
        # Fallback to root key if minting fails (e.g. API_SECRET_KEY not configured)
        log.warning("sandbox_token_mint_failed, falling back to root key", thread_key=thread_key)
        api_key = os.getenv("API_SECRET_KEY", "")

    env = [
        f"AI_V2_API_URL={os.getenv('AGENT_API_URL', 'http://api:8000')}",
        f"AI_V2_API_KEY={api_key}",
        f"AGENT_ENGINE={engine}",
    ]
    if harness in ("eng", "engineer"):
        env.append("AGENT_PERSONA=engineer")
    elif harness == "legal":
        env.append("AGENT_PERSONA=legal")

    if local_dev:
        # In local dev mode, real secrets come from environment
        for key in _get_injection_key_names():
            real = os.getenv(key, "").strip()
            if real:
                env.append(f"{key}={real}")
    else:
        firewall_host = os.getenv("FIREWALL_HOST", "firewall")
        for key in _get_injection_key_names():
            env.append(f"{key}={key}")
        env.extend(
            [
                f"HTTPS_PROXY=http://{firewall_host}:8080",
                f"HTTP_PROXY=http://{firewall_host}:8080",
                f"https_proxy=http://{firewall_host}:8080",
                f"http_proxy=http://{firewall_host}:8080",
                "NO_PROXY=localhost,127.0.0.1",
                "no_proxy=localhost,127.0.0.1",
                "NODE_EXTRA_CA_CERTS=/firewall-certs/ca-cert.pem",
                "REQUESTS_CA_BUNDLE=/firewall-certs/ca-cert.pem",
                "SSL_CERT_FILE=/firewall-certs/ca-cert.pem",
                "GIT_SSL_CAINFO=/firewall-certs/ca-cert.pem",
            ]
        )

    return env


def _container_recent_logs(container: Any, tail: int = 40, max_chars: int = 2000) -> str:
    try:
        raw = container.logs(tail=tail)
    except Exception:
        return ""
    text = (
        raw.decode("utf-8", errors="replace") if isinstance(raw, (bytes, bytearray)) else str(raw)
    )
    text = text.strip()
    return text[-max_chars:] if len(text) > max_chars else text


def _wait_ready(container: Any, timeout: int = 15) -> float:
    """Wait for the entrypoint to signal readiness (touch ~/.ready)."""
    t0 = time.monotonic()
    deadline = t0 + timeout
    while time.monotonic() < deadline:
        with contextlib.suppress(Exception):
            container.reload()
        status = str(getattr(container, "status", "") or "")
        if status and status not in {"created", "running"}:
            logs = _container_recent_logs(container)
            detail = f"sandbox exited before ready (status={status})"
            if logs:
                detail += f"; last logs: {logs}"
            raise RuntimeError(detail)
        try:
            exit_code, _ = container.exec_run(["test", "-f", "/home/agent/.ready"], demux=False)
        except Exception:
            time.sleep(0.1)
            continue
        if exit_code == 0:
            return round(time.monotonic() - t0, 3)
        time.sleep(0.1)
    raise TimeoutError(f"sandbox readiness timed out after {timeout}s")


# ── Docker backend ───────────────────────────────────────────────────────────


class DockerSandboxBackend(SandboxBackend):
    """Runs agent sandboxes as local Docker containers."""

    def __init__(self) -> None:
        self._client: docker.DockerClient | None = None

    def _get_client(self) -> docker.DockerClient:
        if self._client is None:
            docker_host = os.getenv("DOCKER_HOST")
            if docker_host:
                self._client = docker.DockerClient(base_url=docker_host)
            else:
                self._client = docker.from_env()
        return self._client

    @property
    def name(self) -> str:
        return "docker"

    @property
    def supports_warm_pool(self) -> bool:
        return True

    def create(
        self,
        thread_key: str,
        harness: str,
        engine: str,
        *,
        warm: bool = False,
    ) -> SandboxSession:
        client = self._get_client()
        repos_dir = os.path.abspath(_repos_host_dir())

        container_name = f"pipe-{thread_key.replace(':', '-').replace('.', '-')[:40]}"
        env = _container_env(thread_key, container_name, harness, engine)

        # Remove stale container with same name
        with contextlib.suppress(Exception):
            stale = client.containers.get(container_name)
            stale.remove(force=True)

        labels = {
            "agent2": "true",
            "ai2.pipe": "true",
            "ai2.thread": thread_key,
            "ai2.harness": harness,
            "ai2.engine": engine,
        }
        if warm:
            labels["ai2.warm"] = "true"

        volumes: dict[str, dict[str, str]] = {
            repos_dir: {"bind": "/home/agent/github", "mode": "ro"},
        }
        vol = os.getenv("FIREWALL_CERTS_VOLUME", "firewall-certs")
        volumes[vol] = {"bind": "/firewall-certs", "mode": "ro"}

        container = client.containers.run(
            _image(),
            detach=True,
            stdin_open=True,
            tty=False,
            network=os.getenv("AGENT_NETWORK", "ai_v2_agent_net"),
            mem_limit="4g",
            nano_cpus=int(2 * 1e9),
            environment=env,
            working_dir="/home/agent",
            volumes=volumes,
            labels=labels,
            name=container_name,
        )
        _wait_ready(container)

        session = SandboxSession(
            sandbox_id=container.id,
            thread_key=thread_key,
            harness=harness,
            engine=engine,
            started_at=time.time(),
            backend_name=self.name,
        )
        log.info(
            "sandbox_spawned",
            thread_key=thread_key,
            container_id=container.id[:12],
            container_name=container_name,
            harness=harness,
            engine=engine,
            warm=warm,
        )
        return session

    def attach(self, session: SandboxSession, *, logs: bool = False) -> None:
        if session.metadata.get("_stdin_sock") and session.metadata.get("_stdout_sock"):
            return
        client = self._get_client()
        api = client.api

        stdin_attach = api.attach_socket(session.sandbox_id, params={"stdin": True, "stream": True})
        session.metadata["_stdin_sock"] = stdin_attach._sock

        container = client.containers.get(session.sandbox_id)
        session.metadata["_stdout_sock"] = container.attach(
            stdout=True, stderr=False, stream=True, logs=logs
        )

    def write_stdin(self, session: SandboxSession, obj: dict) -> None:
        sock = session.metadata.get("_stdin_sock")
        if sock is None:
            raise RuntimeError("stdin not attached")
        payload = json.dumps(obj, separators=(",", ":")) + "\n"
        sock.sendall(payload.encode())

    def stream_stdout(self, session: SandboxSession) -> Iterator[str]:
        stdout_sock = session.metadata.get("_stdout_sock")
        if stdout_sock is None:
            raise RuntimeError("stdout not attached")
        buf = ""
        for chunk in stdout_sock:
            buf += chunk.decode("utf-8", errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                stripped = line.strip()
                if stripped:
                    yield stripped

    def stop(self, session: SandboxSession) -> None:
        # Send interrupt and close sockets
        with contextlib.suppress(Exception):
            self.write_stdin(session, {"type": "interrupt"})
        self.close_streams(session)
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = client.containers.get(session.sandbox_id)
            container.stop(timeout=5)
            container.remove()
        log.info(
            "sandbox_stopped",
            thread_key=session.thread_key,
            container_id=session.sandbox_id[:12],
            reason="explicit_stop",
        )

    def status(self, session: SandboxSession) -> str:
        client = self._get_client()
        try:
            container = client.containers.get(session.sandbox_id)
            return container.status
        except NotFound:
            return "gone"

    def recover(self) -> list[SandboxSession]:
        client = self._get_client()
        sessions: list[SandboxSession] = []
        try:
            containers = client.containers.list(filters={"label": "ai2.pipe=true"})
        except Exception as exc:
            log.warning("docker_recover_failed", error=str(exc))
            return sessions

        for container in containers:
            thread_key = container.labels.get("ai2.thread", "")
            is_warm = container.labels.get("ai2.warm") == "true"
            # Skip truly warm (unclaimed) containers — managed by warm_pool.py
            if is_warm and thread_key.startswith("warm-"):
                continue
            if not thread_key:
                continue
            if container.status != "running":
                continue
            sessions.append(
                SandboxSession(
                    sandbox_id=container.id,
                    thread_key=thread_key,
                    harness=container.labels.get("ai2.harness", "amp"),
                    engine=container.labels.get("ai2.engine", "amp"),
                    started_at=time.time(),
                    backend_name=self.name,
                )
            )
        return sessions

    def close_streams(self, session: SandboxSession) -> None:
        sock = session.metadata.pop("_stdin_sock", None)
        if sock is not None:
            with contextlib.suppress(Exception):
                sock.close()
        stdout = session.metadata.pop("_stdout_sock", None)
        if stdout is not None and hasattr(stdout, "close"):
            with contextlib.suppress(Exception):
                stdout.close()

    def recent_logs(self, session: SandboxSession, tail: int = 40) -> str:
        client = self._get_client()
        try:
            container = client.containers.get(session.sandbox_id)
            return _container_recent_logs(container, tail=tail)
        except Exception:
            return ""

    def rename(self, session: SandboxSession, new_name: str) -> None:
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = client.containers.get(session.sandbox_id)
            container.rename(new_name)

    def refresh_token(self, session: SandboxSession, new_token: str) -> None:
        """Write a fresh API token into a running sandbox container.

        Uses an env var to pass the token safely, avoiding shell injection.
        """
        client = self._get_client()
        container = client.containers.get(session.sandbox_id)
        exit_code, _ = container.exec_run(
            ["sh", "-c", 'printf "%s" "$_TOKEN" > /home/agent/.api_key'],
            environment={"_TOKEN": new_token},
            user="agent",
        )
        if exit_code != 0:
            log.warning(
                "sandbox_token_refresh_failed",
                sandbox=session.sandbox_id[:12],
                exit_code=exit_code,
            )

    def recover_warm(self, pool_harness: str) -> list[SandboxSession]:
        """Recover existing warm containers from Docker on API restart."""
        client = self._get_client()
        sessions: list[SandboxSession] = []
        try:
            containers = client.containers.list(filters={"label": "ai2.warm=true"})
        except Exception:
            return sessions
        for container in containers:
            thread_key = container.labels.get("ai2.thread", "")
            # Only recover truly unclaimed warm containers
            if not thread_key.startswith("warm-"):
                continue
            if container.status != "running":
                with contextlib.suppress(Exception):
                    container.remove(force=True)
                continue
            sessions.append(
                SandboxSession(
                    sandbox_id=container.id,
                    thread_key="",
                    harness=container.labels.get("ai2.harness", pool_harness),
                    engine=container.labels.get("ai2.engine", "amp"),
                    started_at=time.time(),
                    backend_name=self.name,
                )
            )
        return sessions

    def verify_running(self, sandbox_id: str) -> bool:
        """Check if a container is still running. Returns False if gone."""
        client = self._get_client()
        try:
            container = client.containers.get(sandbox_id)
            return container.status == "running"
        except NotFound:
            return False

    def force_remove(self, sandbox_id: str) -> None:
        """Force-remove a container by ID."""
        client = self._get_client()
        with contextlib.suppress(Exception):
            c = client.containers.get(sandbox_id)
            c.stop(timeout=3)
            c.remove()
