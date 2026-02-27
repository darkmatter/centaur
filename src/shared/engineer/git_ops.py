from __future__ import annotations

import asyncio
import re
from pathlib import Path


class GitOperationError(RuntimeError):
    pass


def slugify(value: str, *, max_len: int = 48) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return (slug or "task")[:max_len]


async def _run(argv: list[str], cwd: Path) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    return (
        proc.returncode if proc.returncode is not None else -1,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
    )


async def create_worktree(repo_root: Path, branch_name: str, base_ref: str) -> Path:
    root = repo_root.parent / ".engineer-worktrees"
    root.mkdir(parents=True, exist_ok=True)
    worktree = root / branch_name.replace("/", "-")

    code, _, err = await _run(
        ["git", "worktree", "add", "-b", branch_name, str(worktree), base_ref],
        cwd=repo_root,
    )
    if code != 0:
        raise GitOperationError(f"Failed to create worktree: {err}")
    return worktree


async def get_diff(worktree: Path) -> str:
    """Stage all changes and return the diff (catches new + modified files)."""
    await _run(["git", "add", "-A"], cwd=worktree)
    code, out, err = await _run(["git", "diff", "--cached"], cwd=worktree)
    if code != 0:
        raise GitOperationError(f"Failed to get diff: {err}")
    return out


async def has_changes(worktree: Path) -> bool:
    code, out, err = await _run(["git", "status", "--porcelain"], cwd=worktree)
    if code != 0:
        raise GitOperationError(f"Failed to check changes: {err}")
    return bool(out.strip())


async def commit_all(worktree: Path, message: str) -> None:
    code, _, err = await _run(["git", "add", "-A"], cwd=worktree)
    if code != 0:
        raise GitOperationError(f"git add failed: {err}")

    code, _, err = await _run(["git", "commit", "-m", message], cwd=worktree)
    if code != 0:
        raise GitOperationError(f"git commit failed: {err}")


async def push_branch(worktree: Path, branch_name: str) -> None:
    code, _, err = await _run(["git", "push", "-u", "origin", branch_name], cwd=worktree)
    if code != 0:
        raise GitOperationError(f"git push failed: {err}")


async def cleanup_worktree(repo_root: Path, worktree: Path) -> None:
    await _run(["git", "worktree", "remove", "--force", str(worktree)], cwd=repo_root)
