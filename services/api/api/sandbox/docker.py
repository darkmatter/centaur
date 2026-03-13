"""Docker sandbox backend — runs agent containers via aiodocker (fully async)."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import aiodocker
import structlog

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


_HARNESS_STUB_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AMP_API_KEY", "GITHUB_TOKEN")


def _build_harness_cmd(engine: str, model: str | None = None) -> list[str]:
    """Build the container CMD for a given harness engine."""
    if engine == "amp":
        # amp-wrapper handles follow-handoff chaining transparently
        cmd = ["amp-wrapper"]
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


async def _wait_ready(client: aiodocker.Docker, container_id: str, timeout: int = 15) -> float:
    """Wait for the entrypoint to signal readiness (touch ~/.ready)."""
    t0 = time.monotonic()
    deadline = t0 + timeout
    while time.monotonic() < deadline:
        try:
            info = await client.containers.get(container_id)
            state = (await info.show()).get("State", {})
            status = state.get("Status", "")
        except Exception:
            await asyncio.sleep(0.1)
            continue
        if status and status not in {"created", "running"}:
            detail = f"sandbox exited before ready (status={status})"
            raise RuntimeError(detail)
        try:
            container = await client.containers.get(container_id)
            exec_obj = await container.exec(
                cmd=["test", "-f", "/home/agent/.ready"], stdout=True, stderr=True,
            )
            stream = exec_obj.start(detach=False)
            async with stream:
                while await stream.read_out() is not None:
                    pass
            exec_info = await exec_obj.inspect()
            if exec_info.get("ExitCode") == 0:
                return round(time.monotonic() - t0, 3)
        except Exception:
            pass
        await asyncio.sleep(0.1)
    raise TimeoutError(f"sandbox readiness timed out after {timeout}s")


# ── Docker backend ───────────────────────────────────────────────────────────


class DockerSandboxBackend(SandboxBackend):
    """Runs agent sandboxes as local Docker containers (fully async via aiodocker)."""

    def __init__(self) -> None:
        self._client: aiodocker.Docker | None = None

    def _get_client(self) -> aiodocker.Docker:
        if self._client is None:
            docker_host = os.getenv("DOCKER_HOST")
            if docker_host:
                self._client = aiodocker.Docker(url=docker_host)
            else:
                self._client = aiodocker.Docker()
        return self._client

    @property
    def name(self) -> str:
        return "docker"

    @property
    def supports_warm_pool(self) -> bool:
        return True

    async def create(
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

        # Remove stale container with the same name
        with contextlib.suppress(Exception):
            stale = await client.containers.get(container_name)
            await stale.delete(force=True)

        labels = {
            "centaur-agent": "true",
            "ai2.pipe": "true",
            "ai2.thread": thread_key,
            "ai2.harness": harness,
            "ai2.engine": engine,
        }
        if warm:
            labels["ai2.warm"] = "true"

        # Build bind mounts
        binds = [
            f"{repos_dir}:/home/agent/github:ro",
        ]
        vol = os.getenv("FIREWALL_CERTS_VOLUME", "firewall-certs")
        binds.append(f"{vol}:/firewall-certs:ro")

        # Bind-mount base system prompt
        repo_host = _repo_host_dir()
        base_prompt_host = os.path.join(repo_host, "services", "sandbox", "SYSTEM_PROMPT.md")
        binds.append(f"{base_prompt_host}:/home/agent/AGENTS_BASE.md:ro")

        # Bind-mount persona directory if selected
        if persona:
            from api.app import get_tool_manager

            persona_info = get_tool_manager().get_persona(persona)
            if persona_info and persona_info.tool_dir.is_dir():
                rel = persona_info.tool_dir.relative_to(Path("/app"))
                persona_host = os.path.join(repo_host, str(rel))
                binds.append(f"{persona_host}:/home/agent/tools/personas/{persona}:ro")

        cmd = _build_harness_cmd(engine, model)
        network = os.getenv("AGENT_NETWORK", "centaur_agent_net")

        config: dict[str, Any] = {
            "Image": _image(),
            "Cmd": cmd,
            "OpenStdin": True,
            "Tty": False,
            "AttachStdin": True,
            "AttachStdout": True,
            "AttachStderr": True,
            "Env": env,
            "WorkingDir": "/home/agent",
            "Labels": labels,
            "HostConfig": {
                "Binds": binds,
                "Memory": 4 * 1024**3,
                "NanoCpus": int(2 * 1e9),
                "NetworkMode": network,
            },
        }

        container = await client.containers.create_or_replace(
            name=container_name,
            config=config,
        )
        await container.start()
        container_id = container.id

        await _wait_ready(client, container_id)

        session = SandboxSession(
            sandbox_id=container_id,
            thread_key=thread_key,
            harness=harness,
            engine=engine,
            started_at=time.time(),
            backend_name=self.name,
        )
        log.info(
            "sandbox_spawned",
            thread_key=thread_key,
            container_id=container_id[:12],
            container_name=container_name,
            harness=harness,
            engine=engine,
            warm=warm,
        )
        return session

    async def attach(self, session: SandboxSession, *, logs: bool = False) -> None:
        rt = _get_rt(session)
        if rt.stream is not None:
            return
        client = self._get_client()
        container = await client.containers.get(session.sandbox_id)
        rt.stream = container.attach(stdin=True, stdout=True, stderr=False, logs=logs)

    async def write_stdin(self, session: SandboxSession, obj: dict) -> None:
        rt = _get_rt(session)
        if rt.stream is None:
            raise RuntimeError("not attached")
        payload = json.dumps(obj, separators=(",", ":")) + "\n"
        await rt.stream.write_in(payload.encode())

    async def stream_stdout(self, session: SandboxSession) -> AsyncIterator[str]:
        rt = _get_rt(session)
        if rt.stream is None:
            raise RuntimeError("not attached")
        buf = ""
        while True:
            msg = await rt.stream.read_out()
            if msg is None:
                break
            # msg.stream: 1=stdout, 2=stderr; we only attached stdout
            buf += msg.data.decode("utf-8", errors="replace")
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                stripped = line.strip()
                if stripped:
                    yield stripped

    async def stop(self, session: SandboxSession) -> None:
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = await client.containers.get(session.sandbox_id)
            await container.kill(signal="SIGINT")
        await self.close_streams(session)
        with contextlib.suppress(Exception):
            container = await client.containers.get(session.sandbox_id)
            await container.stop(t=5)
            await container.delete()
        log.info(
            "sandbox_stopped",
            thread_key=session.thread_key,
            container_id=session.sandbox_id[:12],
            reason="explicit_stop",
        )

    async def status(self, session: SandboxSession) -> str:
        return await self.status_by_id(session.sandbox_id)

    async def status_by_id(self, sandbox_id: str) -> str:
        """Check container status by ID (no session needed)."""
        client = self._get_client()
        try:
            container = await client.containers.get(sandbox_id)
            info = await container.show()
            return info.get("State", {}).get("Status", "unknown")
        except aiodocker.exceptions.DockerError as exc:
            if exc.status == 404:
                return "gone"
            raise

    async def stop_by_id(self, sandbox_id: str) -> None:
        """Stop and remove a container by ID (no session needed)."""
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = await client.containers.get(sandbox_id)
            await container.stop(t=5)
            await container.delete()

    async def close_streams(self, session: SandboxSession) -> None:
        rt = _get_rt(session)
        if rt.stream is not None:
            with contextlib.suppress(Exception):
                await rt.stream.close()
            rt.stream = None

    async def rename_by_id(self, sandbox_id: str, new_name: str) -> None:
        """Rename a container by ID (no session needed)."""
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = await client.containers.get(sandbox_id)
            await container.rename(new_name)

    async def refresh_token_by_id(self, sandbox_id: str, new_token: str) -> None:
        """Write a fresh API token into a running container by ID."""
        exit_code, _ = await self.exec_run(
            sandbox_id,
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

    async def exec_run(
        self, sandbox_id: str, cmd: list[str], *, environment: dict | None = None, user: str = ""
    ) -> tuple[int, bytes]:
        """Run a command inside a container and return (exit_code, output)."""
        client = self._get_client()
        container = await client.containers.get(sandbox_id)
        exec_obj = await container.exec(
            cmd=cmd,
            stdout=True,
            stderr=True,
            environment=environment,
            user=user,
        )
        stream = exec_obj.start(detach=False)
        output = b""
        async with stream:
            while True:
                msg = await stream.read_out()
                if msg is None:
                    break
                output += msg.data
        info = await exec_obj.inspect()
        return info.get("ExitCode", -1), output

    async def recover_warm(self, pool_harness: str) -> list[SandboxSession]:
        """Recover existing warm containers from Docker on API restart."""
        client = self._get_client()
        sessions: list[SandboxSession] = []
        try:
            containers = await client.containers.list(
                filters=json.dumps({"label": ["ai2.warm=true"]}),
            )
        except Exception:
            return sessions
        for container in containers:
            info = await container.show()
            labels = info.get("Config", {}).get("Labels", {})
            thread_key = labels.get("ai2.thread", "")
            if not thread_key.startswith("warm-"):
                continue
            status = info.get("State", {}).get("Status", "")
            if status != "running":
                with contextlib.suppress(Exception):
                    await container.delete(force=True)
                continue
            sessions.append(
                SandboxSession(
                    sandbox_id=container.id,
                    thread_key="",
                    harness=labels.get("ai2.harness", pool_harness),
                    engine=labels.get("ai2.engine", "amp"),
                    started_at=time.time(),
                    backend_name=self.name,
                )
            )
        return sessions
