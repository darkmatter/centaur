#!/usr/bin/env python3
"""Print the union of pyproject dependencies for tools under a directory.

Used by the agent image build (base tools) and the sandbox entrypoint (overlay
tools) to assemble the ``centaur-tool`` runner's venv. Every tool runs as a
local CLI, so both callers collect all deps; the optional allowlist arg is a
narrowing escape hatch, not part of the normal flow.

Usage:
    collect-tool-deps <tools_root> [allowlist]

    <tools_root>  directory scanned recursively for ``**/pyproject.toml``.
    allowlist     optional, comma-separated tool names:
                    - omitted or ""  -> every tool (the default)
                    - "all"          -> every tool
                    - "a,b,c"        -> only tools whose directory name is listed

Persona entries (``[tool.centaur] type = "persona"``) are always skipped. One
dependency specifier is printed per line, sorted and de-duplicated.
"""

from __future__ import annotations

import pathlib
import sys
import tomllib


def collect(tools_root: str, allowlist: str) -> list[str]:
    root = pathlib.Path(tools_root)
    allow = allowlist.strip()
    no_filter = allow in ("", "all")
    allowed = {name.strip() for name in allow.split(",") if name.strip()}

    deps: set[str] = set()
    for pyproject in root.glob("**/pyproject.toml"):
        # A tool's name is its directory name (categories sit one level up),
        # matching how the runner resolves tools.
        if not (no_filter or pyproject.parent.name in allowed):
            continue
        try:
            with open(pyproject, "rb") as fh:
                conf = tomllib.load(fh)
        except Exception:
            continue
        if conf.get("tool", {}).get("centaur", {}).get("type") == "persona":
            continue
        deps.update(conf.get("project", {}).get("dependencies", []))

    return sorted(dep for dep in deps if dep.strip())


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: collect-tool-deps <tools_root> [allowlist]", file=sys.stderr)
        return 2
    tools_root = argv[0]
    allowlist = argv[1] if len(argv) > 1 else ""
    print("\n".join(collect(tools_root, allowlist)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
