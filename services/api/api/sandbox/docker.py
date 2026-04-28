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
from urllib.parse import urlsplit

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


def _dind_image() -> str:
    return os.getenv("DIND_IMAGE", "docker:dind")


def _dind_name(sandbox_name: str) -> str:
    """Derive the DinD sidecar container name from the sandbox name."""
    return sandbox_name.replace("centaur-sandbox-", "centaur-dind-", 1)


def _repos_host_dir() -> str:
    return os.getenv("REPOS_HOST_DIR", os.path.expanduser("~/github"))


def _repo_host_dir() -> str:
    """Host-side path to the centaur repo root (for bind-mounting prompts/personas)."""
    value = (os.getenv("REPO_HOST_DIR") or "").strip()
    if value:
        return os.path.abspath(os.path.expanduser(value))
    return str(Path(__file__).resolve().parents[4])


def _overlay_container_dir() -> str | None:
    value = (os.getenv("CENTAUR_OVERLAY_DIR") or "").strip()
    return value or None


def _overlay_host_dir() -> str | None:
    value = (os.getenv("CENTAUR_OVERLAY_HOST_DIR") or "").strip()
    if not value:
        return None
    return os.path.abspath(os.path.expanduser(value))


_SANDBOX_OVERLAY_DIR = "/home/agent/overlay/org"


def _resolve_host_bind_path(container_path: Path) -> str | None:
    """Map a container-visible plugin path back to its host bind source."""
    roots: list[tuple[Path, Path]] = []
    overlay_container_dir = _overlay_container_dir()
    overlay_host_dir = _overlay_host_dir()
    if overlay_container_dir and overlay_host_dir:
        roots.append((Path(overlay_container_dir), Path(overlay_host_dir)))
    roots.append((Path("/app"), Path(_repo_host_dir())))
    roots.sort(key=lambda item: len(item[0].parts), reverse=True)

    for container_root, host_root in roots:
        try:
            rel = container_path.relative_to(container_root)
        except ValueError:
            continue
        return str(host_root / rel)
    return None


def _egress_network() -> str | None:
    value = (os.getenv("AGENT_EGRESS_NETWORK") or "").strip()
    return value or None


def _dind_enabled() -> bool:
    return os.getenv("SANDBOX_DIND_ENABLED", "0").strip().lower() in {"1", "true", "yes"}


_HARNESS_STUB_KEYS = ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AMP_API_KEY", "GITHUB_TOKEN")
_AGENT_USER = "1001:1001"


def _build_harness_cmd(engine: str, model: str | None = None) -> list[str]:
    """Build the container CMD for a given harness engine."""
    if engine == "amp":
        return ["amp-wrapper"]
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


def _container_env(
    thread_key: str,
    container_name: str,
    *,
    resume_thread_id: str | None = None,
) -> list[str]:
    """Build env vars for sandbox containers."""
    local_dev = os.getenv("AGENT_LOCAL_DEV", "").lower() in ("1", "true")

    api_key = mint_sandbox_token(thread_key, container_name)
    api_url = os.getenv("AGENT_API_URL", "http://api:8000")

    env = [
        f"CENTAUR_API_URL={api_url}",
        f"CENTAUR_API_KEY={api_key}",
        f"CENTAUR_THREAD_KEY={thread_key}",
        "AMP_MODE=deep",
    ]
    if resume_thread_id:
        env.append(f"AMP_CONTINUE_THREAD_ID={resume_thread_id}")

    if local_dev:
        for key in _HARNESS_STUB_KEYS:
            real = os.getenv(key, "").strip()
            if real:
                env.append(f"{key}={real}")
    else:
        firewall_host = os.getenv("FIREWALL_HOST", "firewall")
        no_proxy_hosts = ["localhost", "127.0.0.1", firewall_host]
        api_host = urlsplit(api_url).hostname
        if api_host:
            no_proxy_hosts.append(api_host)
        no_proxy = ",".join(dict.fromkeys(no_proxy_hosts))
        for key in _HARNESS_STUB_KEYS:
            env.append(f"{key}={key}")
        env.extend(
            [
                f"FIREWALL_HOST={firewall_host}",
                f"HTTPS_PROXY=http://{firewall_host}:8080",
                f"HTTP_PROXY=http://{firewall_host}:8080",
                f"https_proxy=http://{firewall_host}:8080",
                f"http_proxy=http://{firewall_host}:8080",
                f"NO_PROXY={no_proxy}",
                f"no_proxy={no_proxy}",
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
        resume_thread_id: str | None = None,
    ) -> SandboxSession:
        client = self._get_client()
        repos_dir = os.path.abspath(_repos_host_dir())
        repo_host = _repo_host_dir()
        overlay_host = _overlay_host_dir()

        container_name = f"centaur-sandbox-{thread_key.replace(':', '-').replace('.', '-')[:40]}"
        env = _container_env(
            thread_key,
            container_name,
            resume_thread_id=resume_thread_id,
        )
        if persona:
            env.append(f"AGENT_PERSONA={persona}")
        if repo:
            env.append(f"AGENT_REPO={repo}")

        # Remove stale containers with the same name
        dind_name = _dind_name(container_name)
        for stale_name in (container_name, dind_name):
            with contextlib.suppress(Exception):
                stale = await client.containers.get(stale_name)
                await stale.delete(force=True)

        # Spawn Docker-in-Docker sidecar only when explicitly enabled.
        network = os.getenv("AGENT_NETWORK", "centaur_agent_net")
        egress_network = _egress_network()
        if _dind_enabled():
            dind_container = await client.containers.create_or_replace(
                name=dind_name,
                config={
                    "Image": _dind_image(),
                    "Env": ["DOCKER_TLS_CERTDIR="],  # disable TLS (internal network only)
                    "Labels": {
                        "centaur-agent": "true",
                        "ai2.dind": "true",
                        "ai2.thread": thread_key,
                    },
                    "HostConfig": {
                        "Privileged": False,
                        "CapAdd": ["SYS_ADMIN", "NET_ADMIN"],
                        "SecurityOpt": ["apparmor=unconfined"],
                        "NetworkMode": network,
                        "StorageOpt": {"size": "20G"},
                    },
                },
            )
            await dind_container.start()
            if egress_network and egress_network != network:
                # DinD needs the same egress path as the sandbox so `docker pull`
                # and `docker compose up` inside the sandbox can resolve and reach registries.
                egress = await client.networks.get(egress_network)
                await egress.connect({"Container": dind_container.id})

            # Point sandbox Docker CLI at the sidecar
            env.append(f"DOCKER_HOST=tcp://{dind_name}:2375")

            # Ensure Docker CLI traffic to the DinD sidecar bypasses the HTTP proxy
            for i, v in enumerate(env):
                if v.startswith(("NO_PROXY=", "no_proxy=")):
                    env[i] = v + f",{dind_name}"

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
        skills_host = os.path.join(repo_host, ".agents", "skills")
        binds.append(f"{skills_host}:/home/agent/centaur-skills:ro")
        if overlay_host:
            binds.append(f"{overlay_host}:{_SANDBOX_OVERLAY_DIR}:ro")
            env.append(f"CENTAUR_OVERLAY_DIR={_SANDBOX_OVERLAY_DIR}")
            overlay_skills_host = os.path.join(overlay_host, ".agents", "skills")
            if os.path.isdir(overlay_skills_host):
                binds.append(f"{overlay_skills_host}:/home/agent/centaur-overlay-skills:ro")
        vol = os.getenv("FIREWALL_CERTS_VOLUME", "firewall-certs")
        binds.append(f"{vol}:/firewall-certs:ro")

        # Bind-mount base system prompt
        base_prompt_host = os.path.join(repo_host, "services", "sandbox", "SYSTEM_PROMPT.md")
        binds.append(f"{base_prompt_host}:/home/agent/AGENTS_BASE.md:ro")
        if overlay_host:
            overlay_prompt_host = os.path.join(overlay_host, "services", "sandbox", "SYSTEM_PROMPT.md")
            if os.path.isfile(overlay_prompt_host):
                binds.append(f"{overlay_prompt_host}:/home/agent/AGENTS_OVERLAY.md:ro")

        # Bind-mount persona directory if selected
        if persona:
            from api.app import get_tool_manager

            persona_info = get_tool_manager().get_persona(persona)
            if persona_info and persona_info.tool_dir.is_dir():
                persona_host = _resolve_host_bind_path(persona_info.tool_dir)
                if persona_host and os.path.isdir(persona_host):
                    binds.append(f"{persona_host}:/home/agent/tools/personas/{persona}:ro")
                else:
                    log.warning(
                        "persona_bind_path_unresolved",
                        persona=persona,
                        tool_dir=str(persona_info.tool_dir),
                    )

        cmd = _build_harness_cmd(engine, model)

        config: dict[str, Any] = {
            "Image": _image(),
            "Cmd": cmd,
            "OpenStdin": True,
            "Tty": False,
            "AttachStdin": True,
            "AttachStdout": True,
            "AttachStderr": True,
            "Env": env,
            "User": _AGENT_USER,
            "WorkingDir": "/home/agent",
            "Labels": labels,
            "HostConfig": {
                "Binds": binds,
                "CapDrop": ["ALL"],
                "Memory": 4 * 1024**3,
                "NanoCpus": int(2 * 1e9),
                "NetworkMode": network,
                "SecurityOpt": ["no-new-privileges"],
            },
        }

        container = await client.containers.create_or_replace(
            name=container_name,
            config=config,
        )

        if egress_network and egress_network != network:
            egress = await client.networks.get(egress_network)
            await egress.connect({"Container": container.id})

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
        client = self._get_client()
        container = await client.containers.get(session.sandbox_id)
        if rt.stdout_stream is None:
            rt.stdout_stream = container.attach(stdin=False, stdout=True, stderr=False, logs=logs)
        if rt.stdin_stream is None:
            rt.stdin_stream = container.attach(stdin=True, stdout=False, stderr=False)
        log.info(
            "sandbox_attached",
            thread_key=session.thread_key,
            container_id=session.sandbox_id[:12],
            harness=session.harness,
            engine=session.engine,
            logs=logs,
        )

    async def write_stdin(self, session: SandboxSession, obj: dict) -> None:
        rt = _get_rt(session)
        if rt.stdin_stream is None:
            raise RuntimeError("not attached (stdin)")
        payload = json.dumps(obj, separators=(",", ":")) + "\n"
        await rt.stdin_stream.write_in(payload.encode())
        log.info(
            "sandbox_stdin_write",
            thread_key=session.thread_key,
            container_id=session.sandbox_id[:12],
            harness=session.harness,
            engine=session.engine,
            payload_size_bytes=len(payload.encode("utf-8")),
        )

    async def stream_stdout(self, session: SandboxSession) -> AsyncIterator[str]:
        rt = _get_rt(session)
        if rt.stdout_stream is None:
            raise RuntimeError("not attached (stdout)")
        buf = ""
        while True:
            msg = await rt.stdout_stream.read_out()
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
        # Resolve sandbox container name for DinD sidecar cleanup
        sandbox_name: str | None = None
        with contextlib.suppress(Exception):
            container = await client.containers.get(session.sandbox_id)
            info = await container.show()
            sandbox_name = info.get("Name", "").lstrip("/")
            await container.kill(signal="SIGINT")
        await self.close_streams(session)
        with contextlib.suppress(Exception):
            container = await client.containers.get(session.sandbox_id)
            await container.stop(t=5)
            await container.delete()
        # Stop the DinD sidecar
        if sandbox_name:
            await self._stop_dind(sandbox_name)
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
        sandbox_name: str | None = None
        with contextlib.suppress(Exception):
            container = await client.containers.get(sandbox_id)
            info = await container.show()
            sandbox_name = info.get("Name", "").lstrip("/")
            await container.stop(t=5)
            await container.delete()
        if sandbox_name:
            await self._stop_dind(sandbox_name)

    async def interrupt_by_id(self, sandbox_id: str) -> None:
        """Interrupt the current turn while keeping the sandbox container alive."""
        client = self._get_client()
        try:
            container = await client.containers.get(sandbox_id)
            await container.kill(signal="SIGUSR1")
        except aiodocker.exceptions.DockerError as exc:
            if exc.status == 404:
                return
            raise

    async def _stop_dind(self, sandbox_name: str) -> None:
        """Stop and remove the DinD sidecar for a sandbox."""
        client = self._get_client()
        dind_name = _dind_name(sandbox_name)
        with contextlib.suppress(Exception):
            dind = await client.containers.get(dind_name)
            await dind.stop(t=3)
            await dind.delete()

    async def close_streams(self, session: SandboxSession) -> None:
        rt = _get_rt(session)
        if rt.stdout_stream is not None:
            with contextlib.suppress(Exception):
                await rt.stdout_stream.close()
            rt.stdout_stream = None
        if rt.stdin_stream is not None:
            with contextlib.suppress(Exception):
                await rt.stdin_stream.close()
            rt.stdin_stream = None

    async def close_stdin(self, session: SandboxSession) -> None:
        """Close only the stdin stream (leaves stdout reader intact)."""
        rt = _get_rt(session)
        if rt.stdin_stream is not None:
            with contextlib.suppress(Exception):
                await rt.stdin_stream.close()
            rt.stdin_stream = None

    async def reattach_stdin(self, session: SandboxSession) -> None:
        """Re-open only the stdin connection (leaves stdout reader intact)."""
        rt = _get_rt(session)
        if rt.stdin_stream is not None:
            with contextlib.suppress(Exception):
                await rt.stdin_stream.close()
            rt.stdin_stream = None
        client = self._get_client()
        container = await client.containers.get(session.sandbox_id)
        rt.stdin_stream = container.attach(stdin=True, stdout=False, stderr=False)

    async def rename_by_id(self, sandbox_id: str, new_name: str) -> None:
        """Rename a sandbox and its DinD sidecar by ID."""
        client = self._get_client()
        with contextlib.suppress(Exception):
            container = await client.containers.get(sandbox_id)
            info = await container.show()
            old_name = info.get("Name", "").lstrip("/")
            if old_name:
                old_dind = _dind_name(old_name)
                new_dind = _dind_name(new_name)
                with contextlib.suppress(Exception):
                    dind = await client.containers.get(old_dind)
                    await dind.rename(new_dind)
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

    async def list_containers(self, label_filters: dict[str, str]) -> list[dict]:
        """List containers matching label filters. Returns list of {id, name, labels, created, status}."""
        client = self._get_client()
        filters = {"label": [f"{k}={v}" for k, v in label_filters.items()]}
        containers = await client.containers.list(
            all=True,
            filters=json.dumps(filters),
        )
        results = []
        for c in containers:
            info = await c.show()
            labels = info.get("Config", {}).get("Labels", {})
            name = info.get("Name", "").lstrip("/")
            created = info.get("Created", "")
            status = info.get("State", {}).get("Status", "unknown")
            results.append({
                "id": c.id,
                "name": name,
                "labels": labels,
                "created": created,
                "status": status,
            })
        return results
