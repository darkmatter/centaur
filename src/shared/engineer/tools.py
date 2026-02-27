from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any

THINK_TOOL: dict[str, Any] = {
    "name": "think",
    "description": (
        "Use this tool to pause and reason before acting. "
        "Call it to plan your approach, verify assumptions after reading tool results, "
        "check that your planned action is correct, or reconsider when stuck. "
        "The content is logged but has no side effects."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "thought": {
                "type": "string",
                "description": "Your reasoning, analysis, or plan.",
            },
        },
        "required": ["thought"],
    },
}

RESEARCH_TOOLS: list[dict[str, Any]] = [
    THINK_TOOL,
    {
        "name": "read_file",
        "description": (
            "Read a file from the worktree. Use offset/limit for large files "
            "to read specific line ranges instead of the whole file."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "offset": {"type": "integer", "description": "1-indexed start line"},
                "limit": {"type": "integer", "description": "Number of lines to read"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_directory",
        "description": "List files and directories under a path. Use recursive=true sparingly.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "recursive": {"type": "boolean"},
            },
        },
    },
    {
        "name": "grep_search",
        "description": (
            "Search code with ripgrep. Preferred for exact symbol/string lookups. "
            "Use glob to filter by file type (e.g. '*.py')."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "glob": {"type": "string"},
            },
            "required": ["pattern"],
        },
    },
]

ENGINEER_TOOLS: list[dict[str, Any]] = [
    *RESEARCH_TOOLS,
    {
        "name": "write_file",
        "description": "Write full contents to a file path. Parent directories are created automatically.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "str_replace",
        "description": (
            "Replace one exact text occurrence in a file. The old text must match exactly "
            "(including whitespace/indentation). Fails if not found or not unique."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old": {"type": "string"},
                "new": {"type": "string"},
            },
            "required": ["path", "old", "new"],
        },
    },
    {
        "name": "shell",
        "description": "Run an approved shell command in the worktree.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeout_seconds": {"type": "integer"},
            },
            "required": ["command"],
        },
    },
    {
        "name": "run_validation",
        "description": (
            "Run linting and type-checking on changed files (ruff check, ruff format --check, mypy, and TS checks for Slackbot changes). "
            "Returns structured results. Call this proactively after making changes to catch errors early."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
]


class ToolExecutionError(RuntimeError):
    pass


class ToolExecutor:
    def __init__(
        self,
        worktree_root: Path,
        *,
        command_allowlist: set[str],
        protected_paths: list[str],
    ) -> None:
        self.worktree_root = worktree_root
        self.command_allowlist = command_allowlist
        self.protected_paths = protected_paths

    async def execute(self, name: str, tool_input: dict[str, Any]) -> str:
        if name == "think":
            return "Thought recorded."
        if name == "read_file":
            return self._read_file(tool_input)
        if name == "list_directory":
            return self._list_directory(tool_input)
        if name == "grep_search":
            return await self._grep_search(tool_input)
        if name == "write_file":
            return self._write_file(tool_input)
        if name == "str_replace":
            return self._str_replace(tool_input)
        if name == "shell":
            return await self._shell(tool_input)
        if name == "run_validation":
            return await self._run_validation()
        raise ToolExecutionError(f"Unknown tool '{name}'")

    def _resolve_path(self, value: str) -> Path:
        root = self.worktree_root.resolve()
        path = (root / value).resolve()
        try:
            path.relative_to(root)
        except ValueError:
            raise ToolExecutionError("Path escapes worktree root") from None
        return path

    def _is_protected(self, path: Path) -> bool:
        rel = str(path.resolve().relative_to(self.worktree_root.resolve()))
        return any(rel == item or rel.startswith(f"{item}/") for item in self.protected_paths)

    @staticmethod
    def _truncate(text: str, max_chars: int = 30000) -> str:
        if len(text) <= max_chars:
            return text
        half = max_chars // 2
        return f"{text[:half]}\n\n...truncated...\n\n{text[-half:]}"

    def _read_file(self, tool_input: dict[str, Any]) -> str:
        path = self._resolve_path(str(tool_input["path"]))
        if not path.exists():
            raise ToolExecutionError(f"File not found: {path}")

        text = path.read_text(encoding="utf-8")
        offset = int(tool_input.get("offset", 1))
        limit = tool_input.get("limit")
        if limit is None:
            return self._truncate(text)

        lines = text.splitlines()
        start = max(offset - 1, 0)
        end = start + int(limit)
        return self._truncate("\n".join(lines[start:end]))

    def _list_directory(self, tool_input: dict[str, Any]) -> str:
        path_value = str(tool_input.get("path", "."))
        recursive = bool(tool_input.get("recursive", False))
        path = self._resolve_path(path_value)
        if not path.exists():
            raise ToolExecutionError(f"Path not found: {path}")

        entries: list[str] = []
        if recursive:
            for item in sorted(path.rglob("*")):
                entries.append(str(item.relative_to(self.worktree_root)))
                if len(entries) >= 400:
                    break
        else:
            for item in sorted(path.iterdir()):
                entries.append(str(item.relative_to(self.worktree_root)))
        return "\n".join(entries)

    async def _grep_search(self, tool_input: dict[str, Any]) -> str:
        import asyncio

        pattern = str(tool_input["pattern"])
        path_value = str(tool_input.get("path", "."))
        glob = tool_input.get("glob")
        target = self._resolve_path(path_value)

        cmd = ["rg", "--line-number", pattern, str(target)]
        if glob:
            cmd.extend(["--glob", str(glob)])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(self.worktree_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()
        output = stdout.decode("utf-8", errors="replace")
        if proc.returncode not in (0, 1):
            raise ToolExecutionError(stderr.decode("utf-8", errors="replace"))
        return self._truncate(output)

    def _write_file(self, tool_input: dict[str, Any]) -> str:
        path = self._resolve_path(str(tool_input["path"]))
        if self._is_protected(path):
            raise ToolExecutionError(f"Writes are blocked for protected path: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(str(tool_input["content"]), encoding="utf-8")
        return "ok"

    def _str_replace(self, tool_input: dict[str, Any]) -> str:
        path = self._resolve_path(str(tool_input["path"]))
        if self._is_protected(path):
            raise ToolExecutionError(f"Writes are blocked for protected path: {path}")
        if not path.exists():
            raise ToolExecutionError(f"File not found: {path}")

        old = str(tool_input["old"])
        new = str(tool_input["new"])
        text = path.read_text(encoding="utf-8")
        occurrences = text.count(old)
        if occurrences == 0:
            raise ToolExecutionError("Old text not found")
        if occurrences > 1:
            raise ToolExecutionError(
                "Old text is not unique; provide a longer exact snippet for replacement"
            )
        path.write_text(text.replace(old, new, 1), encoding="utf-8")
        return "ok"

    async def _shell(self, tool_input: dict[str, Any]) -> str:
        import asyncio

        command = str(tool_input["command"])
        timeout_seconds = int(tool_input.get("timeout_seconds", 120))
        argv = shlex.split(command)
        if not argv:
            raise ToolExecutionError("Empty command")
        if argv[0] not in self.command_allowlist:
            raise ToolExecutionError(f"Command '{argv[0]}' is not allowed")

        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(self.worktree_root),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        except TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise ToolExecutionError("Command timed out") from exc

        data = {
            "exit_code": proc.returncode,
            "stdout": stdout.decode("utf-8", errors="replace"),
            "stderr": stderr.decode("utf-8", errors="replace"),
        }
        return self._truncate(json.dumps(data, indent=2))

    async def _run_validation(self) -> str:
        from shared.engineer.validation_gate import run_validation

        report = await run_validation(self.worktree_root)
        if report.success:
            return "All checks passed."
        return report.to_feedback()
