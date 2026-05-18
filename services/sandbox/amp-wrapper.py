#!/usr/bin/env python3
"""amp-wrapper — stable NDJSON bridge for Amp inside sandbox containers.

Responsibilities:
1. Run Amp in streaming JSON mode with deterministic defaults.
2. Keep follow=true handoffs seamless by chaining into the new thread.
3. Recover from transient Amp crashes without killing the container.
4. Optionally continue a prior Amp thread on cold start via AMP_CONTINUE_THREAD_ID.
"""

import json
import os
import re
import signal
import subprocess
import sys
from urllib.parse import unquote, urlparse

TID_RE = re.compile(r"T-[a-f0-9-]+")
GITHUB_REMOTE_RE = re.compile(r"github\.com[:/](?P<owner>[^/]+)/(?P<repo>[^/.]+?)(?:\.git)?$")
CURRENT_PROC: subprocess.Popen[str] | None = None
CURRENT_SESSION_ID: str | None = None
INTERRUPT_REQUESTED = False
REPO_CONTEXT: dict[str, str] | None = None


def _amp_subprocess_env() -> dict[str, str]:
    """Build env for amp child processes.

    Amp currently runs on Bun, and in this sandbox setup Bun does not reliably
    trust the injected firewall CA for HTTPS MITM proxying. Keep the TLS bypass
    scoped to amp-wrapper-managed amp processes so other harnesses are
    unaffected.
    """
    env = os.environ.copy()
    if env.get("HTTPS_PROXY") and "NODE_TLS_REJECT_UNAUTHORIZED" not in env:
        env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0"
    return env


def _amp_base_cmd() -> list[str]:
    mode = (os.environ.get("AMP_MODE") or "deep").strip() or "deep"
    cmd = [
        "amp",
        "--no-ide",
        "--no-notifications",
        "--dangerously-allow-all",
        "--execute",
        "--stream-json",
        "--stream-json-input",
        "--stream-json-thinking",
        "--mode",
        mode,
    ]
    visibility = (os.environ.get("AMP_THREAD_VISIBILITY") or "").strip()
    if visibility:
        cmd.extend(["--visibility", visibility])
    return cmd


AMP_BASE = _amp_base_cmd()
WRAPPER_HEARTBEAT_SUBTYPE = "wrapper_heartbeat"


def emit(line: str) -> None:
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def emit_json(payload: dict) -> None:
    emit(json.dumps(payload, separators=(",", ":"), ensure_ascii=False))


def emit_wrapper_heartbeat(phase: str) -> None:
    emit_json({
        "type": "system",
        "subtype": WRAPPER_HEARTBEAT_SUBTYPE,
        "phase": phase,
    })


def is_end_turn(evt: dict) -> bool:
    return evt.get("message", {}).get("stop_reason") == "end_turn"


def has_handoff(evt: dict) -> bool:
    """Check if an assistant event contains a handoff(follow=true) tool call."""
    for block in evt.get("message", {}).get("content", []):
        if block.get("name") == "handoff" and block.get("input", {}).get("follow"):
            return True
    return False


def extract_handoff_tid(evt: dict) -> str | None:
    """Extract newThreadID from a tool result event."""
    payload = json.dumps(evt)
    if "newThreadID" not in payload:
        return None
    match = TID_RE.search(payload.split("newThreadID", 1)[1])
    return match.group(0) if match else None


def _git_stdout(*args: str) -> str:
    try:
        completed = subprocess.run(
            list(args),
            capture_output=True,
            text=True,
            check=True,
        )
    except Exception:
        return ""
    return completed.stdout.strip()


def _repo_identity(repo_dir: str) -> dict[str, str]:
    remote = _git_stdout("git", "-C", repo_dir, "config", "--get", "remote.origin.url")
    match = GITHUB_REMOTE_RE.search(remote)
    if not match:
        return {}
    return {
        "repo_owner": match.group("owner"),
        "repo_name": match.group("repo"),
    }


def _repo_root(path: str) -> str:
    candidate = path
    if not os.path.isdir(candidate):
        candidate = os.path.dirname(candidate)
    return _git_stdout("git", "-C", candidate, "rev-parse", "--show-toplevel")


def _repo_candidates(cwd: str | None = None, text: str | None = None) -> list[str]:
    candidates: list[str] = []

    def add(path: str | None) -> None:
        if not path:
            return
        root = _repo_root(path)
        if root and root not in candidates:
            candidates.append(root)

    if text:
        for raw_url in re.findall(r"file://[^\s)]+", text):
            parsed = urlparse(raw_url)
            add(unquote(parsed.path.split("#", 1)[0]))

    add(cwd)
    add(os.getcwd())

    agent_repo = (os.environ.get("AGENT_REPO") or "").strip()
    if "/" in agent_repo:
        add(os.path.join(os.path.expanduser("~"), "github", agent_repo))

    return candidates


def _repo_context(cwd: str | None = None, text: str | None = None, *, refresh: bool = False) -> dict[str, str]:
    global REPO_CONTEXT

    if REPO_CONTEXT is not None and not refresh:
        return REPO_CONTEXT

    repo_context: dict[str, str] = {}
    for repo_dir in _repo_candidates(cwd, text):
        git_ref = _git_stdout("git", "-C", repo_dir, "rev-parse", "--abbrev-ref", "HEAD")
        git_commit = _git_stdout("git", "-C", repo_dir, "rev-parse", "HEAD")
        identity = _repo_identity(repo_dir)
        if identity:
            repo_context.update(identity)
        if git_ref and git_ref != "HEAD":
            repo_context["git_ref"] = git_ref
        if git_commit:
            repo_context["git_commit"] = git_commit
        if repo_context.get("git_commit"):
            break

    REPO_CONTEXT = repo_context
    return repo_context


def _event_text(evt: dict) -> str:
    evt_type = evt.get("type")
    if evt_type == "assistant":
        content = evt.get("message", {}).get("content", [])
        texts = [block.get("text", "") for block in content if isinstance(block, dict) and block.get("type") == "text"]
        return "\n".join(text for text in texts if isinstance(text, str))
    if evt_type == "result":
        result = evt.get("result")
        return result if isinstance(result, str) else ""
    if evt_type == "error":
        error = evt.get("error")
        if isinstance(error, str):
            return error
        if isinstance(error, dict):
            message = error.get("message")
            return message if isinstance(message, str) else ""
    return ""


class RunResult:
    __slots__ = ("code", "chain_tid", "resume_tid", "interrupted")

    def __init__(
        self,
        code: int,
        chain_tid: str | None = None,
        resume_tid: str | None = None,
        interrupted: bool = False,
    ):
        self.code = code
        self.chain_tid = chain_tid
        self.resume_tid = resume_tid
        self.interrupted = interrupted


def _exit_wrapper(*_args: object) -> None:
    sys.exit(0)


def _interrupt_current_turn(*_args: object) -> None:
    global INTERRUPT_REQUESTED

    proc = CURRENT_PROC
    if proc is None or proc.poll() is not None:
        return

    INTERRUPT_REQUESTED = True
    try:
        os.killpg(proc.pid, signal.SIGINT)
    except ProcessLookupError:
        pass


def run(cmd: list[str], stdin_data: str | None = None) -> RunResult:
    """Run Amp, stream stdout, and detect handoff chaining."""
    global CURRENT_PROC, CURRENT_SESSION_ID, INTERRUPT_REQUESTED

    kw = dict(
        stdout=subprocess.PIPE,
        stderr=sys.stderr,
        text=True,
        bufsize=1,
        env=_amp_subprocess_env(),
        start_new_session=True,
    )
    if stdin_data:
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, **kw)
        assert proc.stdin is not None
        proc.stdin.write(stdin_data)
        proc.stdin.close()
    else:
        proc = subprocess.Popen(cmd, stdin=sys.stdin, **kw)
    CURRENT_PROC = proc

    handoff_tid = None
    suppressing = False

    while True:
        raw = proc.stdout.readline()
        if not raw:
            break
        line = raw.rstrip("\n")
        if not line:
            continue

        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            if not suppressing:
                emit(line)
            continue

        evt_type = evt.get("type", "")
        session_id = evt.get("session_id")
        if isinstance(session_id, str) and session_id:
            CURRENT_SESSION_ID = session_id

        if evt_type in {"assistant", "result", "error"}:
            terminal_like = evt_type in {"result", "error"} or is_end_turn(evt)
            if terminal_like:
                cwd = evt.get("cwd") if isinstance(evt.get("cwd"), str) else None
                for key, value in _repo_context(cwd, _event_text(evt), refresh=True).items():
                    evt.setdefault(key, value)
                line = json.dumps(evt, separators=(",", ":"), ensure_ascii=False)

        # Keep successful result handling centralized in API _stream_stdout
        # turn.done synthesis. Error results are forwarded so API can persist a
        # terminal state instead of hanging until stream EOF.
        if evt_type == "result" and not suppressing:
            subtype = evt.get("subtype")
            if not evt.get("is_error") and subtype in (None, "", "success"):
                continue

        if not suppressing and evt_type == "assistant" and has_handoff(evt):
            suppressing = True

        if suppressing and not handoff_tid and evt_type in ("user", "tool"):
            handoff_tid = extract_handoff_tid(evt)

        if suppressing:
            # Wait until the handoff turn naturally ends, then chain into new thread.
            if handoff_tid and evt_type == "assistant" and is_end_turn(evt):
                proc.kill()
                break
            continue

        emit(line)

    proc.wait()
    CURRENT_PROC = None
    resume_tid = handoff_tid or CURRENT_SESSION_ID
    if INTERRUPT_REQUESTED:
        INTERRUPT_REQUESTED = False
        return RunResult(0, resume_tid=resume_tid, interrupted=True)
    if handoff_tid:
        return RunResult(0, chain_tid=handoff_tid)
    return RunResult(proc.returncode or 0)


CONTINUE_MSG = json.dumps({
    "type": "user",
    "message": {
        "role": "user",
        "content": [{"type": "text", "text": "continue"}],
    },
}) + "\n"

MAX_CRASH_RESTARTS = 5


def main() -> None:
    signal.signal(signal.SIGTERM, _exit_wrapper)
    signal.signal(signal.SIGINT, _exit_wrapper)
    signal.signal(signal.SIGUSR1, _interrupt_current_turn)

    startup_tid = (os.environ.get("AMP_CONTINUE_THREAD_ID") or "").strip()
    first_cmd = AMP_BASE + ["threads", "continue", startup_tid] if startup_tid else AMP_BASE

    crashes = 0
    code = 0
    next_cmd = first_cmd
    next_phase = "startup_continue" if startup_tid else "startup"

    while True:
        emit_wrapper_heartbeat(next_phase)
        result = run(next_cmd)
        next_cmd = AMP_BASE

        while result.chain_tid:
            crashes = 0
            emit_wrapper_heartbeat("handoff_continue")
            result = run(
                AMP_BASE + ["threads", "continue", result.chain_tid],
                stdin_data=CONTINUE_MSG,
            )

        if result.interrupted:
            crashes = 0
            next_cmd = (
                AMP_BASE + ["threads", "continue", result.resume_tid]
                if result.resume_tid
                else AMP_BASE
            )
            next_phase = "interrupt_continue" if result.resume_tid else "interrupt_restart"
            continue

        if result.code == 0:
            break

        crashes += 1
        if crashes > MAX_CRASH_RESTARTS:
            emit(json.dumps({
                "type": "error",
                "error": {"message": f"amp crashed {crashes} times, giving up"},
            }))
            code = result.code
            break

        emit_json({
            "type": "error",
            "error": {
                "message": (
                    f"amp exited with code {result.code}, "
                    f"restarting ({crashes}/{MAX_CRASH_RESTARTS})"
                )
            },
        })
        next_phase = "crash_restart"

    sys.exit(code)


if __name__ == "__main__":
    main()
