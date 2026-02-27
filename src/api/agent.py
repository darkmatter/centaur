"""Agent sandbox — 1 Slack thread = 1 Docker container.

Manages container lifecycle and executes harness CLI commands (amp,
claude-code, codex) inside them. Returns the final result text.
"""

import codecs
import contextlib
import json
import os
import subprocess
import time
from datetime import UTC, datetime
from typing import Any

import docker
import psycopg2
import psycopg2.extras
import structlog
from docker.errors import NotFound

log = structlog.get_logger()

HARNESSES = ("amp", "claude-code", "codex", "pi-mono")

# Max seconds to wait for a single exec call before killing it
EXEC_TIMEOUT = int(os.getenv("AGENT_EXEC_TIMEOUT", "600"))

# Number of pre-warmed containers to keep ready
POOL_SIZE = int(os.getenv("AGENT_POOL_SIZE", "0"))

# In-memory session registry: slack_thread_key → session dict
_sessions: dict[str, dict[str, Any]] = {}

# Pool of pre-warmed, unclaimed containers (LIFO)
_pool: list[str] = []  # container IDs
_pool_lock = __import__("threading").Lock()


# ---------------------------------------------------------------------------
# Postgres persistence (best-effort — never breaks Docker operations)
# ---------------------------------------------------------------------------
def _pg_conn():
    """Create a Postgres connection. Returns None if DATABASE_URL not set."""
    url = os.getenv("DATABASE_URL", "")
    if not url:
        return None
    return psycopg2.connect(url, connect_timeout=3)


def _pg_write(sql: str, params: tuple = ()) -> None:
    """Execute a single write against Postgres. Silently skips on failure."""
    try:
        conn = _pg_conn()
        if not conn:
            return
        try:
            with conn.cursor() as cur:
                cur.execute(sql, params)
            conn.commit()
        finally:
            conn.close()
    except Exception as exc:
        log.debug("pg_write_failed", error=str(exc))


def _pg_read(sql: str, params: tuple = ()) -> list[dict]:
    """Execute a read query. Returns list of dicts. Empty list on failure."""
    try:
        conn = _pg_conn()
        if not conn:
            return []
        try:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                return [dict(row) for row in cur.fetchall()]
        finally:
            conn.close()
    except Exception as exc:
        log.debug("pg_read_failed", error=str(exc))
        return []


def _ts(epoch: float) -> datetime:
    return datetime.fromtimestamp(epoch, tz=UTC)


def _persist_session(session: dict[str, Any], key: str) -> None:
    _pg_write(
        """
        INSERT INTO agent_sessions
            (slack_thread_key, container_id, harness, agent_thread_id,
             state, created_at, last_activity)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (slack_thread_key) DO UPDATE SET
            container_id    = EXCLUDED.container_id,
            harness         = EXCLUDED.harness,
            agent_thread_id = EXCLUDED.agent_thread_id,
            state           = EXCLUDED.state,
            last_activity   = EXCLUDED.last_activity
        """,
        (
            key,
            session["container_id"],
            session["harness"],
            session.get("agent_thread_id"),
            session["state"],
            _ts(session["created_at"]),
            _ts(session["last_activity"]),
        ),
    )


def _persist_turn(key: str, turn: dict[str, Any]) -> None:
    events_json = json.dumps(turn.get("events", []), default=str)
    _pg_write(
        """
        INSERT INTO agent_turns
            (slack_thread_key, turn_id, user_message, events, result,
             started_at, finished_at, exit_code, timed_out, duration_s)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (slack_thread_key, turn_id) DO UPDATE SET
            events      = EXCLUDED.events,
            result      = EXCLUDED.result,
            finished_at = EXCLUDED.finished_at,
            exit_code   = EXCLUDED.exit_code,
            timed_out   = EXCLUDED.timed_out,
            duration_s  = EXCLUDED.duration_s
        """,
        (
            key,
            turn["turn_id"],
            turn["user_message"],
            events_json,
            turn["result"],
            _ts(turn["started_at"]),
            _ts(turn["finished_at"]) if turn.get("finished_at") else None,
            turn.get("exit_code"),
            turn.get("timed_out", False),
            turn.get("duration_s", 0),
        ),
    )


def _delete_session(key: str) -> None:
    _pg_write("DELETE FROM agent_sessions WHERE slack_thread_key = %s", (key,))


def _docker_client() -> docker.DockerClient:
    return docker.from_env()


def _wait_ready(container: Any, timeout: int = 15) -> float:
    """Wait for the entrypoint to signal readiness (touch ~/.ready).

    Returns the number of seconds waited.
    """
    t0 = time.monotonic()
    deadline = t0 + timeout
    while time.monotonic() < deadline:
        exit_code, _ = container.exec_run(
            ["test", "-f", "/home/agent/.ready"], demux=False
        )
        if exit_code == 0:
            return round(time.monotonic() - t0, 3)
        time.sleep(0.1)
    log.warning("container_ready_timeout", timeout=timeout)
    return round(time.monotonic() - t0, 3)


def _image() -> str:
    return os.getenv("AGENT_IMAGE", "agent2:latest")


def _repos_host_dir() -> str:
    return os.getenv("REPOS_HOST_DIR", os.path.expanduser("~/github"))


def _create_container(
    client: Any,
    name: str | None = None,
    repo: str | None = None,
    extra_labels: dict[str, str] | None = None,
) -> tuple[Any, dict[str, float]]:
    """Create a ready-to-use agent container.

    Returns (container, timings_dict).
    """
    t0 = time.monotonic()
    workdir = "/home/agent/workspace" if repo else "/home/agent/github"
    env = _container_env()
    if repo:
        env.append(f"AGENT_REPO={repo}")
    labels = {
        "agent2": "true",
        **({"tempo.pool": "true"} if not name else {}),
        **(extra_labels or {}),
    }
    container = client.containers.run(
        _image(),
        detach=True,
        stdin_open=True,
        tty=False,
        network_mode=os.getenv("AGENT_NETWORK", "ai_v2_default"),
        mem_limit="4g",
        nano_cpus=int(2 * 1e9),
        environment=env,
        working_dir=workdir,
        volumes={
            _repos_host_dir(): {"bind": "/home/agent/github", "mode": "rw"},
        },
        labels=labels,
        **({"name": name} if name else {}),
    )
    docker_run_s = round(time.monotonic() - t0, 3)
    wait_ready_s = _wait_ready(container)
    return container, {"docker_run_s": docker_run_s, "wait_ready_s": wait_ready_s}


def _claim_from_pool() -> Any | None:
    """Try to claim a pre-warmed container from the pool."""
    with _pool_lock:
        while _pool:
            cid = _pool.pop()
            try:
                client = _docker_client()
                container = client.containers.get(cid)
                if container.status == "running":
                    # Remove pool label so it won't be reclaimed
                    return container
            except Exception:
                continue
    return None


def _refill_pool() -> None:
    """Top up the pool in a background thread."""
    import threading as _threading

    def _fill() -> None:
        with _pool_lock:
            needed = POOL_SIZE - len(_pool)
        if needed <= 0:
            return
        client = _docker_client()
        for _ in range(needed):
            try:
                container, _timings = _create_container(client)
                with _pool_lock:
                    _pool.append(container.id)
                log.info("pool_container_added", pool_size=len(_pool), **_timings)
            except Exception as exc:
                log.warning("pool_fill_failed", error=str(exc))
                break

    _threading.Thread(target=_fill, daemon=True).start()


def _container_env() -> list[str]:
    """Build env vars to forward into the container."""
    keys = [
        "AMP_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "GITHUB_TOKEN",
    ]
    env = [
        f"AI_V2_API_URL={os.getenv('AGENT_API_URL', 'http://api:8000')}",
        f"AI_V2_API_KEY={os.getenv('API_SECRET_KEY', '')}",
    ]
    for k in keys:
        v = os.getenv(k, "")
        if v:
            env.append(f"{k}={v}")
    # Codex exec uses CODEX_API_KEY (falls back to OPENAI_API_KEY internally,
    # but setting it explicitly avoids issues with some versions)
    openai_key = os.getenv("OPENAI_API_KEY", "")
    if openai_key and not os.getenv("CODEX_API_KEY"):
        env.append(f"CODEX_API_KEY={openai_key}")
    return env


def _build_command(harness: str, message: str, thread_id: str | None) -> list[str]:
    if harness == "claude-code":
        return [
            "claude",
            "--dangerously-skip-permissions",
            "--output-format",
            "stream-json",
            "--verbose",
            *(["--session-id", thread_id] if thread_id else []),
            "-p",
            message,
        ]
    if harness == "codex":
        return [
            "codex",
            "exec",
            "--json",
            "--full-auto",
            "--skip-git-repo-check",
            *(["resume", thread_id] if thread_id else []),
            message,
        ]
    if harness == "pi-mono":
        return [
            "pi",
            "--mode",
            "json",
            *(["--session", thread_id] if thread_id else []),
            message,
        ]
    # Default: amp
    return [
        "amp",
        "--no-ide",
        "--no-notifications",
        "--dangerously-allow-all",
        "--stream-json",
        *(["threads", "continue", thread_id] if thread_id else []),
        "-x",
        message,
    ]


def _extract_result(
    raw_lines: list[str], harness: str, stderr_lines: list[str] | None = None
) -> tuple[str, str | None]:
    """Parse JSON-line output from a harness CLI.

    Returns (result_text, agent_thread_id).
    """
    result_text = ""
    agent_thread_id: str | None = None

    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        # Codex normalization
        if harness == "codex":
            etype = event.get("type", "")
            if etype == "thread.started":
                agent_thread_id = event.get("thread_id")
            elif etype == "item.completed":
                item = event.get("item", {})
                if item.get("type") == "agent_message":
                    result_text = item.get("text", result_text)
            elif etype == "turn.completed":
                # Some codex versions bundle items in turn.completed
                for item in event.get("items", []):
                    if item.get("type") == "agent_message":
                        result_text = item.get("text", result_text)
            elif etype == "error":
                result_text = f"❌ {event.get('message', 'Unknown error')}"
            continue

        # Pi-mono normalization
        if harness == "pi-mono":
            etype = event.get("type", "")
            if etype == "session":
                agent_thread_id = event.get("id")
            elif etype == "message_end":
                msg = event.get("message", {})
                if msg.get("role") == "assistant":
                    for part in msg.get("content", []):
                        if isinstance(part, dict) and part.get("type") == "text":
                            result_text = part.get("text", result_text)
                        elif isinstance(part, str):
                            result_text = part
            elif etype == "agent_end":
                for msg in event.get("messages", []):
                    if msg.get("role") == "assistant":
                        for part in msg.get("content", []):
                            if isinstance(part, dict) and part.get("type") == "text":
                                result_text = part.get("text", result_text)
                            elif isinstance(part, str):
                                result_text = part
            continue

        # Amp / claude-code format
        etype = event.get("type", "")
        if etype == "system" and event.get("subtype") == "init":
            agent_thread_id = event.get("session_id")
        elif etype == "result":
            result_text = event.get("result", result_text)
        elif etype == "assistant" and event.get("message", {}).get("content"):
            for part in event["message"]["content"]:
                if part.get("type") == "text" and part.get("text"):
                    result_text = part["text"]
        elif etype == "error":
            result_text = f"❌ {event.get('error', 'Unknown error')}"

    # Fallback: if no structured output found, use last non-empty stderr
    if not result_text and stderr_lines:
        tail = [line for line in stderr_lines[-10:] if line.strip()]
        if tail:
            result_text = "❌ Agent produced no output. Stderr:\n" + "\n".join(tail)

    return result_text, agent_thread_id


class AgentClient:
    """Manage Docker sandbox containers for agent harness execution."""

    def spawn(
        self,
        slack_thread_key: str,
        harness: str = "amp",
        repo: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Spawn a new sandbox container for a Slack thread.

        Args:
            slack_thread_key: Unique thread ID (e.g. "C04ABC:1234567890.123456")
            harness: Agent CLI to use — amp, claude-code, or codex
            repo: Optional repo path to set as working directory
            request_id: Correlation ID for end-to-end latency tracing
        """
        rid = request_id or ""
        log.info("spawn_start", request_id=rid, thread=slack_thread_key, harness=harness)

        if harness not in HARNESSES:
            raise RuntimeError(f"Unknown harness: {harness}. Use one of {HARNESSES}")

        # Reuse existing container if alive
        existing = _sessions.get(slack_thread_key)
        if existing:
            try:
                client = _docker_client()
                container = client.containers.get(existing["container_id"])
                if container.status == "running":
                    log.info("spawn_done", request_id=rid, thread=slack_thread_key,
                             status="already_running")
                    return {
                        "session_id": slack_thread_key,
                        "container_id": existing["container_id"],
                        "status": "already_running",
                        "harness": existing["harness"],
                    }
                container.start()
                existing["state"] = "running"
                log.info("spawn_done", request_id=rid, thread=slack_thread_key,
                         status="restarted")
                return {
                    "session_id": slack_thread_key,
                    "container_id": existing["container_id"],
                    "status": "restarted",
                    "harness": existing["harness"],
                }
            except NotFound:
                del _sessions[slack_thread_key]

        # Try to claim a pre-warmed container from the pool (skip if repo needed)
        container = None
        status = "started"
        if not repo:
            container = _claim_from_pool()
            if container:
                status = "claimed_from_pool"
                log.info("spawn_pool_claimed", request_id=rid, thread=slack_thread_key)

        # Otherwise create a new one
        if not container:
            log.info("spawn_creating_container", request_id=rid, thread=slack_thread_key)
            client = _docker_client()
            container, create_timings = _create_container(
                client,
                name=f"agent2-{slack_thread_key.replace(':', '-').replace('.', '-')[:40]}",
                repo=repo,
                extra_labels={
                    "tempo.thread": slack_thread_key,
                    "tempo.harness": harness,
                },
            )
            log.info("spawn_container_created", request_id=rid, thread=slack_thread_key,
                     **create_timings)

        # Refill pool in background after claiming
        _refill_pool()

        session = {
            "container_id": container.id,
            "harness": harness,
            "agent_thread_id": None,
            "state": "running",
            "created_at": time.time(),
            "last_activity": time.time(),
            "turns": [],
        }
        _sessions[slack_thread_key] = session
        _persist_session(session, slack_thread_key)

        log.info("spawn_done", request_id=rid, thread=slack_thread_key, status=status)
        return {
            "session_id": slack_thread_key,
            "container_id": container.id,
            "status": status,
            "harness": harness,
        }

    def pool(self) -> dict[str, Any]:
        """Show pool status and trigger a refill if needed."""
        with _pool_lock:
            pool_size = len(_pool)
        _refill_pool()
        return {"pool_size": pool_size, "target": POOL_SIZE}

    def execute(
        self,
        slack_thread_key: str,
        message: str,
        harness: str = "amp",
        repo: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        """Execute a message in a sandbox, spawning one if needed.

        Runs the harness CLI via docker exec, waits for completion,
        and returns the final result text.
        """
        rid = request_id or ""
        session = _sessions.get(slack_thread_key)

        # Auto-spawn if no session or container is gone
        if session:
            client = _docker_client()
            try:
                container = client.containers.get(session["container_id"])
            except NotFound:
                del _sessions[slack_thread_key]
                session = None

        if not session:
            log.info("exec_auto_spawn", request_id=rid, thread=slack_thread_key)
            self.spawn(slack_thread_key, harness, repo, request_id)
            session = _sessions[slack_thread_key]
            client = _docker_client()
            container = client.containers.get(session["container_id"])

        cmd = _build_command(session["harness"], message, session["agent_thread_id"])

        session["state"] = "working"
        session["last_activity"] = time.time()
        started_ts = time.time()
        log.info(
            "exec_start",
            request_id=rid,
            thread=slack_thread_key,
            harness=session["harness"],
        )

        # Create the turn on the session immediately so SSE can stream it live
        live_turn: dict[str, Any] = {
            "turn_id": len(session.get("turns", [])) + 1,
            "user_message": message,
            "events": [],
            "result": "",
            "started_at": started_ts,
            "finished_at": None,
            "exit_code": None,
            "timed_out": False,
            "duration_s": 0,
        }
        session.setdefault("turns", []).append(live_turn)

        # Use low-level exec API for streaming
        api = client.api
        exec_id = api.exec_create(
            container.id,
            cmd,
            stdout=True,
            stderr=True,
        )["Id"]

        output = api.exec_start(exec_id, stream=True, demux=True)

        # Collect stdout and stderr separately
        stdout_decoder = codecs.getincrementaldecoder("utf-8")("replace")
        stderr_decoder = codecs.getincrementaldecoder("utf-8")("replace")
        lines: list[str] = []
        stderr_lines: list[str] = []
        buf = ""
        err_buf = ""
        timed_out = False
        first_output_logged = False
        started = time.monotonic()

        for stdout_chunk, stderr_chunk in output:
            if time.monotonic() - started > EXEC_TIMEOUT:
                timed_out = True
                log.warning("agent_exec_timeout", thread=slack_thread_key, timeout=EXEC_TIMEOUT)
                break
            if stdout_chunk:
                if not first_output_logged:
                    first_output_logged = True
                    log.info("exec_first_output", request_id=rid,
                             thread=slack_thread_key,
                             elapsed_s=round(time.monotonic() - started, 3))
                buf += stdout_decoder.decode(stdout_chunk)
                while "\n" in buf:
                    idx = buf.index("\n")
                    line = buf[:idx]
                    lines.append(line)
                    buf = buf[idx + 1 :]
                    # Append event to live turn in real-time for SSE
                    stripped = line.strip()
                    if stripped:
                        try:
                            live_turn["events"].append(json.loads(stripped))
                        except json.JSONDecodeError:
                            live_turn["events"].append({"type": "raw", "text": stripped})
            if stderr_chunk:
                err_buf += stderr_decoder.decode(stderr_chunk)
                while "\n" in err_buf:
                    idx = err_buf.index("\n")
                    stderr_lines.append(err_buf[:idx])
                    err_buf = err_buf[idx + 1 :]

        # Flush remaining buffers
        if buf.strip():
            lines.append(buf)
            stripped = buf.strip()
            try:
                live_turn["events"].append(json.loads(stripped))
            except json.JSONDecodeError:
                live_turn["events"].append({"type": "raw", "text": stripped})
        if err_buf.strip():
            stderr_lines.append(err_buf)

        # If timed out, kill the exec process
        if timed_out:
            with contextlib.suppress(Exception):
                container.exec_run(["pkill", "-TERM", "-f", session["harness"]], detach=True)

        # Check exec exit code
        exit_code = api.exec_inspect(exec_id).get("ExitCode")

        result_text, agent_thread_id = _extract_result(lines, session["harness"], stderr_lines)

        if timed_out and not result_text:
            result_text = f"❌ Agent timed out after {EXEC_TIMEOUT}s."
        elif exit_code and exit_code != 0 and not result_text:
            result_text = f"❌ Agent exited with code {exit_code}."
            if stderr_lines:
                tail = "\n".join(stderr_lines[-5:])
                result_text += f"\n```\n{tail}\n```"

        if agent_thread_id:
            session["agent_thread_id"] = agent_thread_id

        # Finalize the live turn
        live_turn["result"] = result_text
        live_turn["finished_at"] = time.time()
        live_turn["exit_code"] = exit_code
        live_turn["timed_out"] = timed_out
        live_turn["duration_s"] = round(time.time() - started_ts, 1)

        # Persist to PG in background
        _persist_turn(slack_thread_key, live_turn)

        session["state"] = "idle"
        session["last_activity"] = time.time()
        _persist_session(session, slack_thread_key)
        log.info(
            "exec_done",
            request_id=rid,
            thread=slack_thread_key,
            harness=session["harness"],
            exit_code=exit_code,
            timed_out=timed_out,
            duration_s=live_turn["duration_s"],
            result_len=len(result_text),
        )

        return {
            "session_id": slack_thread_key,
            "result": result_text,
            "agent_thread_id": session["agent_thread_id"],
            "harness": session["harness"],
        }

    def status(self, slack_thread_key: str | None = None) -> dict[str, Any]:
        """Get session status. If no key given, list all sessions."""
        if slack_thread_key:
            session = _sessions.get(slack_thread_key)
            if not session:
                return {"error": f"No session for '{slack_thread_key}'"}
            return {
                "session_id": slack_thread_key,
                **session,
            }

        return {
            "sessions": [{"session_id": k, **v} for k, v in _sessions.items()],
            "count": len(_sessions),
        }

    def stop(self, slack_thread_key: str) -> dict[str, Any]:
        """Stop and remove a sandbox container."""
        session = _sessions.get(slack_thread_key)
        if not session:
            return {"error": f"No session for '{slack_thread_key}'"}

        client = _docker_client()
        try:
            container = client.containers.get(session["container_id"])
            # Clean up git worktree before removing the container
            repo = container.labels.get("tempo.repo", "")
            if repo:
                repos_dir = _repos_host_dir()
                repo_path = os.path.join(repos_dir, repo)
                if os.path.isdir(repo_path):
                    subprocess.run(
                        ["git", "-C", repo_path, "worktree", "prune"],
                        capture_output=True,
                        timeout=10,
                    )
            container.stop(timeout=5)
            container.remove()
        except Exception:
            pass

        del _sessions[slack_thread_key]
        _delete_session(slack_thread_key)
        return {"session_id": slack_thread_key, "status": "stopped"}

    def threads(self) -> dict[str, Any]:
        """List all agent threads with summary info for the thread viewer."""
        result = []
        for key, session in _sessions.items():
            turns = session.get("turns", [])
            result.append(
                {
                    "slack_thread_key": key,
                    "container_id": session["container_id"][:12],
                    "harness": session["harness"],
                    "agent_thread_id": session.get("agent_thread_id"),
                    "state": session["state"],
                    "created_at": session["created_at"],
                    "last_activity": session["last_activity"],
                    "turn_count": len(turns),
                    "last_result": turns[-1]["result"][:200] if turns else "",
                }
            )
        return {"threads": result, "count": len(result)}

    def thread_detail(self, slack_thread_key: str) -> dict[str, Any]:
        """Get full event stream for a specific thread including all turns and tool calls."""
        session = _sessions.get(slack_thread_key)
        if not session:
            return {"error": f"No session for '{slack_thread_key}'"}
        return {
            "slack_thread_key": slack_thread_key,
            "container_id": session["container_id"][:12],
            "harness": session["harness"],
            "agent_thread_id": session.get("agent_thread_id"),
            "state": session["state"],
            "created_at": session["created_at"],
            "last_activity": session["last_activity"],
            "turns": session.get("turns", []),
        }

    def recover_sessions(self) -> dict[str, Any]:
        """Recover sessions from Postgres and reconcile with live Docker state.

        Called on API startup to re-attach to containers that survived a restart.
        Also discovers labeled containers not yet in PG (belt-and-suspenders).
        """
        recovered = 0
        pruned = 0

        # 1. Load active sessions from Postgres
        rows = _pg_read(
            "SELECT * FROM agent_sessions WHERE state NOT IN ('stopped')"
        )
        client = _docker_client()

        for row in rows:
            key = row["slack_thread_key"]
            if key in _sessions:
                continue

            container_id = row["container_id"]
            try:
                container = client.containers.get(container_id)
                if container.status != "running":
                    _pg_write(
                        "UPDATE agent_sessions SET state = 'stopped'"
                        " WHERE slack_thread_key = %s",
                        (key,),
                    )
                    pruned += 1
                    continue
            except (NotFound, Exception):
                _pg_write(
                    "UPDATE agent_sessions SET state = 'stopped'"
                    " WHERE slack_thread_key = %s",
                    (key,),
                )
                pruned += 1
                continue

            # Load turns from PG
            turn_rows = _pg_read(
                "SELECT * FROM agent_turns WHERE slack_thread_key = %s"
                " ORDER BY turn_id",
                (key,),
            )
            turns = []
            for tr in turn_rows:
                events = tr.get("events", [])
                if isinstance(events, str):
                    events = json.loads(events)
                started = tr.get("started_at")
                finished = tr.get("finished_at")
                turns.append({
                    "turn_id": tr["turn_id"],
                    "user_message": tr["user_message"],
                    "events": events,
                    "result": tr.get("result", ""),
                    "started_at": started.timestamp() if started else time.time(),
                    "finished_at": finished.timestamp() if finished else None,
                    "exit_code": tr.get("exit_code"),
                    "timed_out": tr.get("timed_out", False),
                    "duration_s": tr.get("duration_s", 0),
                })

            created = row.get("created_at")
            last_act = row.get("last_activity")
            _sessions[key] = {
                "container_id": container_id,
                "harness": row.get("harness", "amp"),
                "agent_thread_id": row.get("agent_thread_id"),
                "state": "idle",
                "created_at": created.timestamp() if created else time.time(),
                "last_activity": last_act.timestamp() if last_act else time.time(),
                "turns": turns,
            }
            recovered += 1
            log.info("session_recovered", thread=key, turns=len(turns))

        # 2. Discover labeled containers not in PG (e.g. PG write failed)
        try:
            containers = client.containers.list(filters={"label": "agent2=true"})
            for container in containers:
                key = container.labels.get("tempo.thread", "")
                if key and key not in _sessions:
                    _sessions[key] = {
                        "container_id": container.id,
                        "harness": container.labels.get("tempo.harness", "amp"),
                        "agent_thread_id": None,
                        "state": "idle",
                        "created_at": time.time(),
                        "last_activity": time.time(),
                        "turns": [],
                    }
                    _persist_session(_sessions[key], key)
                    recovered += 1
                    log.info("session_recovered_from_docker", thread=key)
        except Exception:
            pass

        log.info("session_recovery_complete", recovered=recovered, pruned=pruned)
        return {"recovered": recovered, "pruned": pruned}

    def interrupt(self, slack_thread_key: str) -> dict[str, Any]:
        """Interrupt the currently running command in a sandbox."""
        session = _sessions.get(slack_thread_key)
        if not session:
            return {"error": f"No session for '{slack_thread_key}'"}

        client = _docker_client()
        try:
            container = client.containers.get(session["container_id"])
            harness = session["harness"]
            target = {
                "amp": "amp",
                "claude-code": "claude",
                "codex": "codex",
                "pi-mono": "pi",
            }.get(harness, "amp")
            container.exec_run(["pkill", "-INT", "-f", target], detach=True)
        except Exception:
            pass

        return {"session_id": slack_thread_key, "status": "interrupted"}


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------
_agent: AgentClient | None = None


def get_agent() -> AgentClient:
    global _agent
    if _agent is None:
        _agent = AgentClient()
        if POOL_SIZE > 0:
            _refill_pool()
    return _agent
