"""App container manager — deploy and manage long-lived web app containers."""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import re
import uuid

import aiodocker
import asyncpg
import structlog

log = structlog.get_logger()

_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$")


def _image() -> str:
    return os.getenv("AGENT_IMAGE", "centaur-agent:latest")


def _container_name(app_name: str) -> str:
    return f"centaur-app-{app_name}"


def _container_env(app_name: str, env_json: dict | None = None) -> list[str]:
    """Build env vars for app containers."""
    firewall_host = os.getenv("FIREWALL_HOST", "firewall")
    local_dev = os.getenv("AGENT_LOCAL_DEV", "").lower() in ("1", "true")

    env = [
        f"CENTAUR_API_URL={os.getenv('AGENT_API_URL', 'http://api:8000')}",
        f"CENTAUR_APP_NAME={app_name}",
    ]

    if not local_dev:
        env.extend(
            [
                f"HTTPS_PROXY=http://{firewall_host}:8080",
                f"HTTP_PROXY=http://{firewall_host}:8080",
                f"https_proxy=http://{firewall_host}:8080",
                f"http_proxy=http://{firewall_host}:8080",
                "NO_PROXY=localhost,127.0.0.1,api",
                "no_proxy=localhost,127.0.0.1,api",
                "NODE_EXTRA_CA_CERTS=/firewall-certs/ca-cert.pem",
                "REQUESTS_CA_BUNDLE=/firewall-certs/ca-cert.pem",
                "SSL_CERT_FILE=/firewall-certs/ca-cert.pem",
                "GIT_SSL_CAINFO=/firewall-certs/ca-cert.pem",
                "GITHUB_TOKEN=GITHUB_TOKEN",
            ]
        )

    if env_json:
        for k, v in env_json.items():
            env.append(f"{k}={v}")

    return env


class AppManager:
    """Manages long-lived web app Docker containers."""

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

    async def deploy(
        self,
        pool: asyncpg.Pool,
        *,
        name: str,
        repo_url: str,
        port: int = 3000,
        basic_auth_user: str | None = None,
        basic_auth_pass_hash: str | None = None,
        env_json: dict | None = None,
        build_cmd: str | None = None,
        start_cmd: str | None = None,
        created_by: str | None = None,
    ) -> dict:
        """Deploy a new app: create DB row, spawn container, build & start."""
        if not _NAME_RE.match(name):
            raise ValueError(
                "App name must be lowercase alphanumeric + hyphens, "
                "start/end with alphanumeric"
            )

        app_id = f"app-{uuid.uuid4().hex[:16]}"
        client = self._get_client()
        network = os.getenv("AGENT_NETWORK", "centaur_agent_net")
        container_name = _container_name(name)

        # Remove stale container with same name
        with contextlib.suppress(Exception):
            stale = await client.containers.get(container_name)
            await stale.delete(force=True)

        # Insert DB row
        await pool.execute(
            "INSERT INTO apps (id, name, repo_url, status, port, "
            "basic_auth_user, basic_auth_pass_hash, env_json, build_cmd, start_cmd, created_by) "
            "VALUES ($1, $2, $3, 'building', $4, $5, $6, $7, $8, $9, $10)",
            app_id,
            name,
            repo_url,
            port,
            basic_auth_user,
            basic_auth_pass_hash,
            json.dumps(env_json or {}),
            build_cmd,
            start_cmd,
            created_by,
        )

        env = _container_env(name, env_json)
        local_dev = os.getenv("AGENT_LOCAL_DEV", "").lower() in ("1", "true")

        binds: list[str] = []
        if not local_dev:
            vol = os.getenv("FIREWALL_CERTS_VOLUME", "firewall-certs")
            binds.append(f"{vol}:/firewall-certs:ro")

        config: dict = {
            "Image": _image(),
            "Cmd": ["sleep", "infinity"],
            "Tty": False,
            "Env": env,
            "WorkingDir": "/app",
            "Labels": {
                "centaur-app": "true",
                "centaur-app-name": name,
            },
            "HostConfig": {
                "Binds": binds,
                "Memory": 2 * 1024**3,
                "NanoCpus": int(1 * 1e9),
                "NetworkMode": network,
            },
        }

        try:
            container = await client.containers.create_or_replace(
                name=container_name,
                config=config,
            )
            await container.start()
            container_id = container.id

            await pool.execute(
                "UPDATE apps SET container_id = $1, updated_at = NOW() WHERE id = $2",
                container_id,
                app_id,
            )

            # Run build in background
            asyncio.create_task(
                self._build_and_start(
                    pool,
                    app_id,
                    container_id,
                    repo_url,
                    port,
                    build_cmd=build_cmd,
                    start_cmd=start_cmd,
                )
            )

            return {
                "id": app_id,
                "name": name,
                "status": "building",
                "container_id": container_id[:12],
            }
        except Exception as exc:
            await pool.execute(
                "UPDATE apps SET status = 'failed', error_text = $1, updated_at = NOW() "
                "WHERE id = $2",
                str(exc),
                app_id,
            )
            raise

    async def _build_and_start(
        self,
        pool: asyncpg.Pool,
        app_id: str,
        container_id: str,
        repo_url: str,
        port: int,
        *,
        build_cmd: str | None = None,
        start_cmd: str | None = None,
    ) -> None:
        """Clone, build, and start the app inside the container.

        If build_cmd / start_cmd are not provided, defaults to npm workflow:
            npm install && npm run build / npm start
        Users can override with any shell command (e.g. "pip install -r requirements.txt",
        "cargo build --release", "make build", etc.).
        """
        build_log_parts: list[str] = []
        effective_build = build_cmd or "npm install && npm run build"
        effective_start = start_cmd or "npm start"
        try:
            # Clone
            exit_code, output = await self._exec(
                container_id,
                ["sh", "-c", f"gh repo clone {repo_url} /app -- --depth=1 2>&1"],
            )
            build_log_parts.append(f"=== clone ===\n{output.decode(errors='replace')}")
            if exit_code != 0:
                raise RuntimeError(f"Clone failed (exit {exit_code})")

            # Build (user-provided or default npm install + build)
            exit_code, output = await self._exec(
                container_id,
                ["sh", "-c", f"cd /app && {effective_build} 2>&1"],
            )
            build_log_parts.append(f"=== build ===\n{output.decode(errors='replace')}")
            if exit_code != 0:
                raise RuntimeError(f"Build failed (exit {exit_code})")

            # Start (detached via nohup)
            exit_code, output = await self._exec(
                container_id,
                [
                    "sh",
                    "-c",
                    f"cd /app && PORT={port} nohup {effective_start} > /tmp/app.log 2>&1 &",
                ],
            )
            build_log_parts.append(f"=== start ===\n{output.decode(errors='replace')}")
            if exit_code != 0:
                raise RuntimeError(f"Start failed (exit {exit_code})")

            # Wait briefly for the process to settle
            await asyncio.sleep(2)

            build_log = "\n".join(build_log_parts)
            await pool.execute(
                "UPDATE apps SET status = 'running', build_log = $1, updated_at = NOW() "
                "WHERE id = $2",
                build_log,
                app_id,
            )
            log.info("app_deployed", app_id=app_id, container_id=container_id[:12])

        except Exception as exc:
            build_log = "\n".join(build_log_parts)
            await pool.execute(
                "UPDATE apps SET status = 'failed', build_log = $1, error_text = $2, "
                "updated_at = NOW() WHERE id = $3",
                build_log,
                str(exc),
                app_id,
            )
            log.error("app_build_failed", app_id=app_id, error=str(exc))

    async def _exec(
        self,
        container_id: str,
        cmd: list[str],
    ) -> tuple[int, bytes]:
        """Run a command inside a container and return (exit_code, output)."""
        client = self._get_client()
        container = await client.containers.get(container_id)
        exec_obj = await container.exec(
            cmd=cmd,
            stdout=True,
            stderr=True,
            user="agent",
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

    async def stop_app(self, pool: asyncpg.Pool, name: str) -> None:
        """Stop and remove an app container, delete DB row."""
        row = await pool.fetchrow(
            "SELECT id, container_id FROM apps WHERE name = $1", name
        )
        if not row:
            raise ValueError(f"App '{name}' not found")

        client = self._get_client()
        container_id = row["container_id"]
        if container_id:
            with contextlib.suppress(Exception):
                container = await client.containers.get(container_id)
                await container.stop(t=5)
                await container.delete()

        await pool.execute("DELETE FROM apps WHERE id = $1", row["id"])
        log.info("app_stopped", name=name)

    async def restart_app(self, pool: asyncpg.Pool, name: str) -> dict:
        """Restart an app: stop old container, redeploy."""
        row = await pool.fetchrow(
            "SELECT id, repo_url, port, basic_auth_user, basic_auth_pass_hash, "
            "env_json, build_cmd, start_cmd, created_by FROM apps WHERE name = $1",
            name,
        )
        if not row:
            raise ValueError(f"App '{name}' not found")

        # Remove old
        await self.stop_app(pool, name)

        env_json = row["env_json"]
        if isinstance(env_json, str):
            env_json = json.loads(env_json)

        return await self.deploy(
            pool,
            name=name,
            repo_url=row["repo_url"],
            port=row["port"],
            basic_auth_user=row["basic_auth_user"],
            basic_auth_pass_hash=row["basic_auth_pass_hash"],
            env_json=env_json,
            build_cmd=row["build_cmd"],
            start_cmd=row["start_cmd"],
            created_by=row["created_by"],
        )

    async def get_logs(self, pool: asyncpg.Pool, name: str, tail: int = 200) -> str:
        """Get app container logs."""
        row = await pool.fetchrow(
            "SELECT container_id, build_log FROM apps WHERE name = $1",
            name,
        )
        if not row:
            raise ValueError(f"App '{name}' not found")

        parts: list[str] = []
        if row["build_log"]:
            parts.append(row["build_log"])

        container_id = row["container_id"]
        if container_id:
            try:
                exit_code, output = await self._exec(
                    container_id,
                    [
                        "sh",
                        "-c",
                        f"tail -n {tail} /tmp/app.log 2>/dev/null || echo 'no runtime logs'",
                    ],
                )
                parts.append(f"=== runtime ===\n{output.decode(errors='replace')}")
            except Exception:
                parts.append("=== runtime ===\n(container not accessible)")

        return "\n".join(parts)

    async def get_container_ip(self, container_id: str) -> str | None:
        """Get the container's IP on agent_net."""
        client = self._get_client()
        try:
            container = await client.containers.get(container_id)
            info = await container.show()
            networks = info.get("NetworkSettings", {}).get("Networks", {})
            for net_info in networks.values():
                ip = net_info.get("IPAddress")
                if ip:
                    return ip
        except Exception:
            pass
        return None

    async def recover_apps(self, pool: asyncpg.Pool) -> int:
        """Reconcile DB with running containers on API restart."""
        client = self._get_client()
        recovered = 0

        try:
            containers = await client.containers.list(
                filters=json.dumps({"label": ["centaur-app=true"]}),
            )
        except Exception:
            return 0

        running_names: set[str] = set()
        for container in containers:
            info = await container.show()
            labels = info.get("Config", {}).get("Labels", {})
            app_name = labels.get("centaur-app-name", "")
            status = info.get("State", {}).get("Status", "")
            if app_name and status == "running":
                running_names.add(app_name)

        # Mark DB apps as stopped if container is gone
        db_rows = await pool.fetch(
            "SELECT name, container_id, status FROM apps WHERE status = 'running'"
        )
        for row in db_rows:
            if row["name"] not in running_names:
                await pool.execute(
                    "UPDATE apps SET status = 'stopped', updated_at = NOW() WHERE name = $1",
                    row["name"],
                )
                log.info("app_marked_stopped", name=row["name"])
            else:
                recovered += 1

        return recovered


# Module-level singleton
app_manager = AppManager()
