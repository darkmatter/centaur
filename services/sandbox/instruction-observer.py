#!/usr/bin/env python3
"""Observe instruction-sensitive sandbox commands without blocking them."""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path


CONVENTIONAL_RE = re.compile(
    r"^(feat|fix|docs|refactor|test|chore)(\([^)]+\))?: .+"
)


def find_repo_root(cwd: Path) -> Path | None:
    current = cwd.resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".git").exists():
            return candidate
    return None


def loaded_agents_path(repo_root: Path | None, cwd: Path) -> Path | None:
    candidates: list[Path] = []
    if repo_root is not None:
        candidates.append(repo_root / "AGENTS.md")
    candidates.append(cwd / "AGENTS.md")
    candidates.append(Path.home() / "workspace" / "AGENTS.md")
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def has_conventional_instruction(path: Path | None) -> bool:
    if path is None:
        return False
    try:
        text = path.read_text(errors="replace")
    except OSError:
        return False
    return "Conventional commits" in text


def value_after(args: list[str], names: set[str]) -> str | None:
    for index, arg in enumerate(args):
        if arg in names and index + 1 < len(args):
            return args[index + 1]
        for name in names:
            prefix = f"{name}="
            if arg.startswith(prefix):
                return arg[len(prefix) :]
    return None


def git_commit_message(args: list[str]) -> str | None:
    if not args or args[0] != "commit":
        return None
    message = value_after(args, {"-m", "--message"})
    if message is not None:
        return message.splitlines()[0]
    file_arg = value_after(args, {"-F", "--file"})
    if file_arg is None:
        return None
    try:
        return Path(file_arg).read_text(errors="replace").splitlines()[0]
    except OSError:
        return None


def gh_pr_title(args: list[str]) -> str | None:
    if len(args) < 2 or args[0] != "pr" or args[1] not in {"create", "edit"}:
        return None
    return value_after(args[2:], {"--title", "-t"})


def append_log(event: dict[str, object]) -> None:
    state_dir = Path(os.environ.get("CENTAUR_STATE_DIR") or Path.home() / "state")
    log_path = state_dir / "instruction-actions.jsonl"
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, sort_keys=True) + "\n")
    except OSError:
        return


def observe(tool: str, args: list[str]) -> None:
    cwd = Path.cwd()
    repo_root = find_repo_root(cwd)
    agents = loaded_agents_path(repo_root, cwd)
    instruction_present = has_conventional_instruction(agents)
    message: str | None = None
    action: str | None = None

    if tool == "git":
        message = git_commit_message(args)
        action = "git_commit" if message is not None else None
    elif tool == "gh":
        message = gh_pr_title(args)
        action = f"gh_pr_{args[1]}" if message is not None and len(args) >= 2 else None

    if action is None or message is None:
        return

    matches = CONVENTIONAL_RE.match(message) is not None
    event = {
        "ts": datetime.now(UTC).isoformat(),
        "action": action,
        "cwd": str(cwd),
        "repo_root": str(repo_root) if repo_root is not None else None,
        "agents_path": str(agents) if agents is not None else None,
        "conventional_instruction_present": instruction_present,
        "message": message,
        "conventional_match": matches,
        "thread_id": os.environ.get("CODEX_THREAD_ID"),
        "centaur_trace_id": os.environ.get("CENTAUR_TRACE_ID"),
    }
    append_log(event)

    if instruction_present and not matches:
        print(
            "warning: AGENTS.md mentions Conventional commits, but this "
            f"{action} message is non-conventional: {message!r}",
            file=sys.stderr,
        )


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: instruction-observer.py <git|gh> [args...]", file=sys.stderr)
        raise SystemExit(2)
    tool = sys.argv[1]
    args = sys.argv[2:]
    real = {
        "git": os.environ.get("CENTAUR_REAL_GIT", "/usr/bin/git"),
        "gh": os.environ.get("CENTAUR_REAL_GH", "/usr/bin/gh"),
    }.get(tool)
    if real is None:
        print(f"unsupported tool: {tool}", file=sys.stderr)
        raise SystemExit(2)
    observe(tool, args)
    os.execv(real, [tool, *args])


if __name__ == "__main__":
    main()
