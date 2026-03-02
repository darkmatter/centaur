from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path


class GitOperationError(RuntimeError):
    pass


_ENGINEER_GIT_USER_NAME = "Paradigm Code"
_ENGINEER_GIT_USER_EMAIL = "svc_ai@paradigm.xyz"


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


def _sanitize_secret(text: str, secret: str) -> str:
    if not secret:
        return text
    return text.replace(secret, "***")


async def create_worktree(
    repo_root: Path,
    branch_name: str,
    base_ref: str,
    *,
    github_owner: str,
    github_repo: str,
    github_token: str,
    allow_local_clone_without_token: bool = False,
) -> Path:
    """Create an isolated engineer workspace via fresh clone.

    We intentionally avoid `git worktree add` because API containers can run
    without a `.git` checkout. Cloning with a token-authenticated URL makes the
    push/PR path deterministic in containerized environments.
    """
    if not github_token and not allow_local_clone_without_token:
        raise GitOperationError("Missing GITHUB_TOKEN for engineer git workspace setup")

    root = repo_root.parent / ".engineer-worktrees"
    root.mkdir(parents=True, exist_ok=True)
    worktree = root / branch_name.replace("/", "-")
    if worktree.exists():
        shutil.rmtree(worktree, ignore_errors=True)

    if github_token:
        repo_url = f"https://x-access-token:{github_token}@github.com/{github_owner}/{github_repo}.git"
    else:
        repo_url = str(repo_root)
    code, _, err = await _run(
        ["git", "clone", "--branch", base_ref, "--single-branch", repo_url, str(worktree)],
        cwd=root,
    )
    if code != 0:
        raise GitOperationError(f"Failed to clone workspace: {_sanitize_secret(err, github_token)}")

    code, _, err = await _run(["git", "checkout", "-b", branch_name], cwd=worktree)
    if code != 0:
        raise GitOperationError(
            f"Failed to create engineer branch: {_sanitize_secret(err, github_token)}"
        )

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
    if code != 0 and "Author identity unknown" in err:
        cfg_code, _, cfg_err = await _run(
            ["git", "config", "user.name", _ENGINEER_GIT_USER_NAME],
            cwd=worktree,
        )
        if cfg_code != 0:
            raise GitOperationError(f"git config user.name failed: {cfg_err}")
        cfg_code, _, cfg_err = await _run(
            ["git", "config", "user.email", _ENGINEER_GIT_USER_EMAIL],
            cwd=worktree,
        )
        if cfg_code != 0:
            raise GitOperationError(f"git config user.email failed: {cfg_err}")
        code, _, err = await _run(["git", "commit", "-m", message], cwd=worktree)
    if code != 0:
        raise GitOperationError(f"git commit failed: {err}")


async def push_branch(worktree: Path, branch_name: str) -> None:
    code, _, err = await _run(["git", "push", "-u", "origin", branch_name], cwd=worktree)
    if code != 0:
        raise GitOperationError(f"git push failed: {err}")


async def cleanup_worktree(repo_root: Path, worktree: Path) -> None:
    _ = repo_root
    shutil.rmtree(worktree, ignore_errors=True)
