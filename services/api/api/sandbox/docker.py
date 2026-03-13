"""Docker sandbox backend — runs agent containers via the Docker SDK."""

from __future__ import annotations

import contextlib
import json
import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import docker
import structlog
from docker.errors import NotFound

from api.deps import mint_sandbox_token
from api.sandbox.base import SandboxBackend, SandboxSession

log = structlog.get_logger()


# Lazy import to avoid circular dependency — agent.py imports from docker.py
def _get_rt(session: SandboxSession):
    from api.agent import _get_runtime

    return _get_runtime(session.sandbox_id)


# ── Helpers (module-level, not backend methods) ──────────────────────────────


def _image() -> str:
    return os.getenv("AGENT_IMAGE", "centaur-agent:latest")


def _repos_host_dir() -> str:
    return os.getenv("REPOS_HOST_DIR", os.path.expanduser("~/github"))


def _repo_host_dir() -> str:
    """Host-side path to the centaur repo root (for bind-mounting prompts/personas)."""
    return os.getenv("REPO_HOST_DIR", os.path.join(_repos_host_dir(), "paradigmxyz", "centaur"))


_HARNESS_STUB_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AMP_API_KEY")


def _build_harness_cmd(engine: str, model: str | None = None) -> list[str]:
    """Build the container CMD for a given harness engine."""
    if engine == "amp":
        cmd = [
            "amp", "--no-ide", "--no-notifications", "--dangerously-allow-all",
            "--execute", "--stream-json", "--stream-json-input",
        ]
        if model:
            cmd.extend(["--model", model])
        return cmd
    if engine == "claude-code":
        cmd = [
            "claude", "--dangerously-skip-permissions",
            "--output-format", "stream-json", "--input-format", "stream-json",
            "--verbose",
        ]
        if model:
            cmd.extend(["--model", model])
        return cmd
    # codex/pi-mono: container idles, API uses docker exec per turn
    return ["sleep", "infinity"]


def _container_env(thread_key: str, container_name: str) -> list[str]:
    """Build env vars for sandbox containers."""
    local_dev = os.getenv("AGENT_LOCAL_DEV", "").lower() in ("1", "true")

    api_key = mint_sandbox_token(thread_key, container_name)

    env = [
        f"CENTAUR_API_URL={os.getenv('AGENT_API_URL', 'http://api:8000')}",
        f"CENTAUR_API_KEY={api_key}",
        f"CENTAUR_THREAD_KEY={thread_key}",
    ]

    if local_dev:
        for key in _HARNESS_STUB_KEYS:
            real = os.getenv(key, "").strip()
            if real:
                env.append(f"{key}={real}")
    else:
        firewall_host = os.getenv("FIREWALL_HOST", "firewall")
        for key in _HARNESS_STUB_KEYS:
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
        persona: str | None = None,
        repo: str | None = None,
        warm: bool = False,
        model: str | None = None,
    ) -> SandboxSession:
        client = self._get_client()
        repos_dir = os.path.abspath(_repos_host_dir())

        container_name = f"centaur-sandbox-{thread_key.replace(':', '-').replace('.', '-')[:40]}"
        env = _container_env(thread_key, container_name)
        if persona:
            env.append(f"AGENT_PERSONA={persona}")
        if repo:
            env.append(f"AGENT_REPO={repo}")

        with contextlib.suppress(Exception):
            stale = client.containers.get(container_name)
            stale.remove(force=True)

        labels = {
            "centaur-agent": "true",
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

        # Bind-mount base system prompt (so prompt edits don't require image rebuild)
        repo_host = _repo_host_dir()
        base_prompt_host = os.path.join(repo_host, "services", "sandbox", "SYSTEM_PROMPT.md")
        volumes[base_prompt_host] = {"bind": "/home/agent/AGENTS_BASE.md", "mode": "ro"}

        # Bind-mount persona directory if a persona is selected
        if persona:
            from api.app import get_tool_manager

            persona_info = get_tool_manager().get_persona(persona)
            if persona_info and persona_info.tool_dir.is_dir():
                # Resolve host path: tool_dir is /app/tools/personas/<name> inside API container
                # Map back to host via repo root
                rel = persona_info.tool_dir.relative_to(Path("/app"))
                persona_host = os.path.join(repo_host, str(rel))
                volumes[persona_host] = {
                    "bind": f"/home/agent/tools/personas/{persona}",
                    "mode": "ro",
                }

        cmd = _build_harness_cmd(engine, model)
        container = client.containers.run(
            _image(),
            command=cmd,
            detach=True,
            stdin_open=True,
            tty=False,
            network=os.getenv("AGENT_NETWORK", "centaur_agent_net"),
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
        rt = _get_rt(session)
        if rt.stdin_sock and rt.stdout_sock:
            return
        client = self._get_client()
        api = client.api

        stdin_attach = api.attach_socket(session.sandbox_id, params={"stdin": True, "stream": True})
        rt.stdin_sock = stdin_attach._sock

        container = client.containers.get(session.sandbox_id)
        rt.stdout_sock = container.attach(stdout=True, stderr=False, stream=True, logs=logs)

    def write_stdin(self, session: SandboxSession, obj: dict) -> None:
        rt = _get_rt(session)
        if rt.stdin_sock is None:
            raise RuntimeError("stdin not attached")
        payload = json.dumps(obj, separators=(",", ":")) + "\n"
        rt.stdin_sock.sendall(payload.encode())

    def stream_stdout(self, session: SandboxSession) -> Iterator[str]:
        rt = _get_rt(session)
        if rt.stdout_sock is None:
            raise RuntimeError("stdout not attached")
        buf = ""
        for chunk in rt.stdout_sock:
            buf += chunk.decode("utf-8", errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                stripped = line.strip()
                if stripped:
                    yield stripped

    def stop(self, session: SandboxSession) -> None:
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = client.containers.get(session.sandbox_id)
            container.kill(signal="SIGINT")
        self.close_streams(session)
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
        return self.status_by_id(session.sandbox_id)

    def status_by_id(self, sandbox_id: str) -> str:
        """Check container status by ID (no session needed)."""
        client = self._get_client()
        try:
            container = client.containers.get(sandbox_id)
            return container.status
        except NotFound:
            return "gone"

    def stop_by_id(self, sandbox_id: str) -> None:
        """Stop and remove a container by ID (no session needed)."""
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = client.containers.get(sandbox_id)
            container.stop(timeout=5)
            container.remove()

    def close_streams(self, session: SandboxSession) -> None:
        rt = _get_rt(session)
        if rt.stdin_sock is not None:
            with contextlib.suppress(Exception):
                rt.stdin_sock.close()
            rt.stdin_sock = None
        if rt.stdout_sock is not None and hasattr(rt.stdout_sock, "close"):
            with contextlib.suppress(Exception):
                rt.stdout_sock.close()
            rt.stdout_sock = None

    def rename_by_id(self, sandbox_id: str, new_name: str) -> None:
        """Rename a container by ID (no session needed)."""
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = client.containers.get(sandbox_id)
            container.rename(new_name)

    def refresh_token_by_id(self, sandbox_id: str, new_token: str) -> None:
        """Write a fresh API token into a running container by ID."""
        client = self._get_client()
        container = client.containers.get(sandbox_id)
        exit_code, _ = container.exec_run(
            ["sh", "-c", 'printf "%s" "$_TOKEN" > /home/agent/.api_key'],
            environment={"_TOKEN": new_token},
            user="agent",
        )
        if exit_code != 0:
            log.warning(
                "sandbox_token_refresh_failed",
                sandbox=sandbox_id[:12],
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
