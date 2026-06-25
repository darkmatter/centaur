from __future__ import annotations

import ast
import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_ROOT = REPO_ROOT / "tools"

# Local/back-compat aliases. The client helpers only return these values when a
# real local env value is present; otherwise they fall back to the canonical
# placeholder that the proxy metadata below can replace.
SECRET_ALIASES: dict[str, dict[str, str]] = {
    "tools/productivity/figma": {"FIGMA": "FIGMA_ACCESS_TOKEN"},
    "tools/research/sensortower": {"SENSORTOWER_AUTH_TOKEN": "SENSOR_TOWER_AUTH_TOKEN"},
    "tools/research/youtube": {"GOOGLE_API_KEY": "YOUTUBE_API_KEY"},
}

# Secret-looking values that intentionally do not map to HTTP proxy metadata.
# Keep this list narrow: adding a wire credential here should include the reason
# it cannot be represented by the current proxy metadata model.
CLASSIFIED_SECRET_USES: dict[str, dict[str, str]] = {
    "tools/comms/telegram": {
        "TELEGRAM_API_HASH": "MTProto user-login credential, not an HTTP proxy placeholder",
        "TELEGRAM_API_ID": "MTProto user-login config, not an HTTP proxy placeholder",
    },
    "tools/infra/centaur_investigator": {
        "CENTAUR_POSTGRES_DSN": "in-process scoped Postgres DSN",
    },
    "tools/infra/grafana": {
        "GRAFANA_PASSWORD": "fallback basic-auth path; token auth is the agent credential",
    },
    "tools/productivity/company_context": {
        "CENTAUR_POSTGRES_DSN": "in-process scoped Postgres DSN",
    },
    "tools/productivity/gsuite": {
        "CENTAUR_API_URL": "non-secret Centaur API endpoint config",
    },
    "tools/productivity/linear": {
        "GITHUB_TOKEN": "optional local GitHub integration fallback",
        "SLACK_BOT_TOKEN": "cross-tool Slack lookup credential",
    },
    "tools/productivity/slack": {
        "SLACK_API_TIMEOUT_SECONDS": "non-secret timeout config",
    },
    "tools/research/preqin": {
        "PREQIN_API_KEY": "pending: Preqin token endpoint sends this as multipart form data",
        "PREQIN_OPERATIONAL_TOKEN": "pending: derived from the multipart form credential flow",
        "PREQIN_USERNAME": "pending: Preqin token endpoint sends this as multipart form data",
    },
}


@dataclass(frozen=True)
class ToolProject:
    path: Path
    rel_dir: str
    data: dict[str, Any]
    centaur: dict[str, Any]


def _tool_projects() -> list[ToolProject]:
    projects: list[ToolProject] = []
    for pyproject in sorted(TOOLS_ROOT.rglob("pyproject.toml")):
        data = tomllib.loads(pyproject.read_text())
        centaur = ((data.get("tool") or {}).get("centaur") or {})
        if not centaur or centaur.get("type") == "persona":
            continue
        projects.append(
            ToolProject(
                path=pyproject,
                rel_dir=pyproject.parent.relative_to(REPO_ROOT).as_posix(),
                data=data,
                centaur=centaur,
            )
        )
    return projects


def _script_names(project: ToolProject) -> list[str]:
    scripts = (project.data.get("project") or {}).get("scripts") or {}
    if not isinstance(scripts, dict):
        return []
    return sorted(str(name) for name in scripts)


def _string_assignments(tree: ast.AST) -> dict[str, str]:
    values: dict[str, str] = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
            if not isinstance(node.value.value, str):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name):
                    values[target.id] = node.value.value
        elif (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            values[node.target.id] = node.value.value
    return values


def _secret_calls(tool_dir: Path) -> set[str]:
    names: set[str] = set()
    for python_file in sorted(tool_dir.rglob("*.py")):
        if python_file.name.startswith("test_") or "tests" in python_file.parts:
            continue
        tree = ast.parse(python_file.read_text())
        assignments = _string_assignments(tree)
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not node.args:
                continue
            func = node.func
            is_secret_call = (
                (isinstance(func, ast.Name) and func.id == "secret")
                or (isinstance(func, ast.Attribute) and func.attr == "secret")
            )
            if not is_secret_call:
                continue
            arg = node.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                names.add(arg.value)
            elif isinstance(arg, ast.Name) and arg.id in assignments:
                names.add(assignments[arg.id])
    return names


def _add_secret_ref(names: set[str], value: Any) -> None:
    if isinstance(value, str):
        names.add(value)
    elif isinstance(value, dict):
        for key in ("name", "secret_ref", "replacer"):
            if isinstance(value.get(key), str):
                names.add(value[key])
        for field_key in ("fields", "token_endpoint_headers"):
            fields = value.get(field_key)
            if not isinstance(fields, dict):
                continue
            for field in fields.values():
                if isinstance(field, str):
                    names.add(field)
                elif isinstance(field, dict) and isinstance(field.get("secret_ref"), str):
                    names.add(field["secret_ref"])


def _declared_secret_refs(project: ToolProject) -> set[str]:
    names: set[str] = set()
    for key in ("secrets", "optional_secrets"):
        entries = project.centaur.get(key) or []
        for entry in entries:
            _add_secret_ref(names, entry)
    return names


def _is_classified_or_alias(project: ToolProject, name: str, declared: set[str]) -> bool:
    canonical = SECRET_ALIASES.get(project.rel_dir, {}).get(name)
    if canonical and canonical in declared:
        return True
    return name in CLASSIFIED_SECRET_USES.get(project.rel_dir, {})


def test_agent_facing_tools_publish_console_scripts() -> None:
    findings: list[str] = []
    for project in _tool_projects():
        if project.centaur.get("agent_facing", True) is False:
            continue
        if not _script_names(project):
            findings.append(
                f"{project.path.relative_to(REPO_ROOT)}: add [project.scripts] "
                "or set [tool.centaur].agent_facing = false"
            )

    assert not findings, "Tool shim audit found no-script tools:\n- " + "\n- ".join(findings)


def test_tool_secret_calls_are_declared_or_classified() -> None:
    findings: list[str] = []
    for project in _tool_projects():
        declared = _declared_secret_refs(project)
        for name in sorted(_secret_calls(project.path.parent)):
            if name in declared or _is_classified_or_alias(project, name, declared):
                continue
            findings.append(
                f"{project.path.relative_to(REPO_ROOT)}: secret({name!r}) is not declared "
                "in [tool.centaur].secrets/optional_secrets or classified in the audit"
            )

    assert not findings, "Tool secret metadata audit found mismatches:\n- " + "\n- ".join(findings)
