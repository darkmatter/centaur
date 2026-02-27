from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

from shared.engineer.models import ValidationReport, ValidationStep


async def _run_command(
    worktree: Path, argv: list[str], timeout_seconds: int = 600
) -> ValidationStep:
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(worktree),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        success = proc.returncode == 0
    except TimeoutError:
        proc.kill()
        await proc.wait()
        stdout = b""
        stderr = b"Command timed out"
        success = False

    output = (stdout + b"\n" + stderr).decode("utf-8", errors="replace").strip()
    return ValidationStep(command=" ".join(argv), success=success, output=output[:12000])


async def _changed_files(worktree: Path) -> list[str]:
    """Return list of files changed relative to the base branch."""
    proc = await asyncio.create_subprocess_exec(
        "git",
        "diff",
        "--name-only",
        "HEAD",
        cwd=str(worktree),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    staged = await asyncio.create_subprocess_exec(
        "git",
        "diff",
        "--name-only",
        "--cached",
        cwd=str(worktree),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    staged_out, _ = await staged.communicate()
    untracked = await asyncio.create_subprocess_exec(
        "git",
        "ls-files",
        "--others",
        "--exclude-standard",
        cwd=str(worktree),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    untracked_out, _ = await untracked.communicate()

    all_output = stdout + b"\n" + staged_out + b"\n" + untracked_out
    files = [f.strip() for f in all_output.decode().splitlines() if f.strip()]
    return sorted(set(files))


async def run_validation(worktree: Path) -> ValidationReport:
    changed = await _changed_files(worktree)
    py_files = [f for f in changed if f.endswith(".py")]
    slackbot_ts_changes = [
        f
        for f in changed
        if f.startswith("apps/slackbot/")
        and f.endswith((".ts", ".tsx", ".js", ".jsx", ".mts", ".cts"))
    ]

    steps: list[ValidationStep] = []

    if py_files:
        ruff_check = await _run_command(worktree, ["uv", "run", "ruff", "check", *py_files])
        steps.append(ruff_check)
        if not ruff_check.success:
            return ValidationReport(success=False, steps=steps)

        ruff_fmt = await _run_command(
            worktree, ["uv", "run", "ruff", "format", "--check", *py_files]
        )
        steps.append(ruff_fmt)
        if not ruff_fmt.success:
            return ValidationReport(success=False, steps=steps)

        mypy = await _run_command(
            worktree,
            [
                "uv", "run", "mypy",
                "--ignore-missing-imports",
                "--follow-imports=silent",
                *py_files,
            ],
            timeout_seconds=120,
        )
        steps.append(mypy)
        if not mypy.success:
            return ValidationReport(success=False, steps=steps)

    if slackbot_ts_changes:
        if shutil.which("pnpm") is None:
            steps.append(
                ValidationStep(
                    command="pnpm -C apps/slackbot exec tsc --noEmit",
                    success=False,
                    output=(
                        "TypeScript changes detected in apps/slackbot/, "
                        "but pnpm is not installed on this runner."
                    ),
                )
            )
            return ValidationReport(success=False, steps=steps)

        tsc = await _run_command(
            worktree,
            ["pnpm", "-C", "apps/slackbot", "exec", "tsc", "--noEmit"],
            timeout_seconds=180,
        )
        steps.append(tsc)
        if not tsc.success:
            return ValidationReport(success=False, steps=steps)

    steps.append(
        ValidationStep(
            command="changed files check", success=True, output=f"{len(changed)} files changed"
        )
    )
    return ValidationReport(success=True, steps=steps)
