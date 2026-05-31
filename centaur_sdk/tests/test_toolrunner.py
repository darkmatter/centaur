"""Tests for the shared tool-invocation core + local runner.

These exercise ``centaur_sdk.toolrunner`` without any dependency on ``api`` so
they run in the agent-image environment too. A parity test that compares the
runner against ``api.tool_manager.ToolManager`` lives in the API test suite.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from centaur_sdk import toolrunner
from centaur_sdk.backends import registry
from centaur_sdk.backends.stub import StubBackend

FAKE_TOOL_CLIENT = '''
from centaur_sdk import secret


class FakeClient:
    def sync_echo(self, text: str) -> dict:
        return {"mode": "sync", "text": text}

    async def async_echo(self, text: str) -> dict:
        return {"mode": "async", "text": text}

    def secret_values(self) -> dict:
        return {
            "required": secret("REQ_TOKEN"),
            "optional": secret("OPT_TOKEN", default="missing"),
        }

    def make_blob(self, size: int) -> dict:
        import base64

        return {
            "filename": "out.bin",
            "mime_type": "application/octet-stream",
            "data": base64.b64encode(b"x" * size).decode(),
        }

    def boom(self) -> dict:
        raise RuntimeError("kaboom")

    def _private(self):
        return "hidden"

    def close(self):
        return "lifecycle"

    @property
    def computed(self):
        return "not a method"


def _client():
    return FakeClient()
'''


def _write_tool(
    tools_dir: Path,
    name: str,
    client_code: str = FAKE_TOOL_CLIENT,
    *,
    secrets: list | None = None,
    optional_secrets: list | None = None,
    timeout_s=None,
    description: str = "Fake test tool",
) -> Path:
    tool_dir = tools_dir / name
    tool_dir.mkdir(parents=True)
    lines = [
        "[project]",
        f'name = "{name}"',
        'version = "0.1.0"',
        f'description = "{description}"',
        "",
        "[tool.centaur]",
        'module = "client.py"',
        'hosts = ["api.example.com"]',
        f"secrets = {secrets or []!r}",
        f"optional_secrets = {optional_secrets or []!r}",
    ]
    if isinstance(timeout_s, str):
        lines.append(f'timeout_s = "{timeout_s}"')
    elif timeout_s is not None:
        lines.append(f"timeout_s = {timeout_s}")
    lines.append("")
    tool_dir.joinpath("pyproject.toml").write_text("\n".join(lines))
    tool_dir.joinpath("client.py").write_text(client_code)
    return tool_dir


@pytest.fixture(autouse=True)
def _stub_backend(monkeypatch: pytest.MonkeyPatch):
    # Mirror server mode: StubBackend returns the key name as the placeholder
    # (env-first), which is what iron-proxy swaps on the wire.
    monkeypatch.setattr(registry, "_backend", StubBackend())


def test_run_tool_sync_and_async_toon(tmp_path: Path):
    tool_dir = _write_tool(tmp_path, "alpha")
    out = toolrunner.run_tool(tool_dir, "alpha", "sync_echo", {"text": "hi"})
    # TOON for a flat dict; the runner picks TOON or compact JSON, whichever is
    # shorter — assert by decoding the semantics rather than exact bytes here.
    assert "sync" in out and "hi" in out

    out_async = toolrunner.run_tool(tool_dir, "alpha", "async_echo", {"text": "yo"})
    assert "async" in out_async and "yo" in out_async


def test_run_tool_resolves_replace_mode_http_secret_placeholders(tmp_path: Path):
    tool_dir = _write_tool(
        tmp_path,
        "alpha",
        secrets=["REQ_TOKEN"],
        optional_secrets=["OPT_TOKEN"],
    )
    text, ok = toolrunner.run_tool_status(
        tool_dir, "alpha", "secret_values", {}, fmt="json"
    )
    assert ok
    assert json.loads(text) == {"required": "REQ_TOKEN", "optional": "OPT_TOKEN"}


def test_run_tool_method_not_found_envelope(tmp_path: Path):
    tool_dir = _write_tool(tmp_path, "alpha")
    text, ok = toolrunner.run_tool_status(tool_dir, "alpha", "nope", {})
    assert not ok
    payload = json.loads(text)
    assert payload["error"] == "Method 'nope' not found in tool 'alpha'"
    assert "sync_echo" in payload["available_methods"]


def test_run_tool_unexpected_arg_validation(tmp_path: Path):
    tool_dir = _write_tool(tmp_path, "alpha")
    text, ok = toolrunner.run_tool_status(
        tool_dir, "alpha", "sync_echo", {"texts": "oops"}
    )
    assert not ok
    payload = json.loads(text)
    assert payload["error"] == "tool_argument_validation_failed"
    assert payload["unexpected_args"] == ["texts"]


def test_run_tool_forbidden_output_path_arg(tmp_path: Path):
    tool_dir = _write_tool(tmp_path, "alpha")
    text, ok = toolrunner.run_tool_status(
        tool_dir, "alpha", "sync_echo", {"output_path": "/tmp/x"}
    )
    assert not ok
    assert json.loads(text)["forbidden_args"] == ["output_path"]


def test_run_tool_exception_envelope(tmp_path: Path):
    tool_dir = _write_tool(tmp_path, "alpha")
    text, ok = toolrunner.run_tool_status(tool_dir, "alpha", "boom", {})
    assert not ok
    assert json.loads(text) == {"error": "kaboom", "tool": "alpha", "method": "boom"}


def test_run_tool_timeout_envelope(tmp_path: Path):
    client = '''
import time


class FakeClient:
    def slow(self) -> dict:
        time.sleep(2)
        return {"ok": True}


def _client():
    return FakeClient()
'''
    tool_dir = _write_tool(tmp_path, "slowtool", client, timeout_s=1)
    text, ok = toolrunner.run_tool_status(tool_dir, "slowtool", "slow", {})
    assert not ok
    payload = json.loads(text)
    assert payload["tool"] == "slowtool"
    assert "timed out" in payload["error"]


def test_run_tool_large_output_extracted_to_attachment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    captured: dict = {}

    def fake_save_attachment(*, name, data, mime_type=None, source_url=None):
        captured["name"] = name
        captured["size"] = len(data)
        return {
            "attachment_id": "att-xyz",
            "download_url": "/agent/attachments/att-xyz/download",
        }

    monkeypatch.setattr(toolrunner, "save_attachment", fake_save_attachment)
    tool_dir = _write_tool(tmp_path, "alpha")
    text, ok = toolrunner.run_tool_status(
        tool_dir, "alpha", "make_blob", {"size": 100 * 1024}, fmt="json"
    )
    assert ok
    payload = json.loads(text)
    assert "data" not in payload
    assert payload["attachment_id"] == "att-xyz"
    assert payload["download_url"] == "/agent/attachments/att-xyz/download"
    assert captured["name"] == "out.bin"


def test_import_failure_reports_error_and_exits_nonzero(
    tmp_path: Path, monkeypatch, capsys
):
    # A local load failure (bad import) is reported as a parseable envelope and
    # fails — there is no sidecar fallback.
    tool_dir = _write_tool(
        tmp_path, "brokentool", 'raise RuntimeError("bad import")\n'
    )
    text, ok = toolrunner.run_tool_status(tool_dir, "brokentool", "anything", {})
    assert not ok
    assert json.loads(text) == {
        "error": "bad import",
        "tool": "brokentool",
        "method": "anything",
    }

    monkeypatch.setenv("CENTAUR_TOOL_DIRS", str(tmp_path))
    rc = toolrunner.main(["brokentool", "anything"])
    assert rc == toolrunner._CLI_TOOL_ERROR
    assert json.loads(capsys.readouterr().out)["error"] == "bad import"


def test_describe_tool_shape(tmp_path: Path):
    tool_dir = _write_tool(tmp_path, "alpha", description="Alpha tool")
    desc = toolrunner.describe_tool(tool_dir, "alpha")
    assert desc["tool"] == "alpha"
    assert desc["description"] == "Alpha tool"
    names = {m["name"] for m in desc["methods"]}
    assert names == {"async_echo", "boom", "make_blob", "secret_values", "sync_echo"}
    sync_echo = next(m for m in desc["methods"] if m["name"] == "sync_echo")
    assert sync_echo["parameters"]["text"] == {"type": "string", "required": True}


def test_list_tools_shape(tmp_path: Path):
    _write_tool(tmp_path, "alpha", description="Alpha tool")
    _write_tool(tmp_path, "beta", description="Beta tool")
    listing = toolrunner.list_tools([tmp_path])
    assert set(listing) == {"alpha", "beta"}
    assert listing["alpha"]["description"] == "Alpha tool"
    assert "sync_echo" in listing["alpha"]["methods"]


def test_find_tool_dir_overlay_shadows_base(tmp_path: Path):
    base = tmp_path / "base"
    overlay = tmp_path / "overlay"
    _write_tool(base, "alpha", description="base alpha")
    _write_tool(overlay, "alpha", description="overlay alpha")
    found = toolrunner.find_tool_dir([base, overlay], "alpha")
    assert found is not None
    _, _ = toolrunner.read_tool_conf(found)
    desc = toolrunner.describe_tool(found, "alpha")
    assert desc["description"] == "overlay alpha"


def test_find_tool_dir_expands_category_subdirs(tmp_path: Path):
    base = tmp_path / "tools"
    _write_tool(base / "crypto", "coingecko", description="cg")
    found = toolrunner.find_tool_dir([base], "coingecko")
    assert found is not None and found.name == "coingecko"


def test_replace_mode_http_placeholders_excludes_non_http():
    tool_conf = {
        "secrets": [
            "RAW_STRING_KEY",
            {"name": "HTTP_REPLACE", "type": "http"},
            {"name": "HTTP_CUSTOM", "type": "http", "replacer": "PLACEHOLDER"},
            {"name": "HTTP_INJECT", "type": "http", "mode": "inject", "inject_header": "X"},
            {"name": "DB_DSN", "type": "pg_dsn", "database": "x"},
            {"name": "GCP", "type": "gcp_auth"},
        ],
        "optional_secrets": [{"name": "OPT_HTTP", "type": "http"}],
    }
    placeholders = toolrunner.replace_mode_http_placeholders(tool_conf)
    assert placeholders == {
        "RAW_STRING_KEY": "RAW_STRING_KEY",
        "HTTP_REPLACE": "HTTP_REPLACE",
        "HTTP_CUSTOM": "PLACEHOLDER",
        "OPT_HTTP": "OPT_HTTP",
    }


def test_main_describe_and_call(tmp_path: Path, monkeypatch, capsys):
    _write_tool(tmp_path, "alpha")
    monkeypatch.setenv("CENTAUR_TOOL_DIRS", str(tmp_path))
    monkeypatch.delenv("CENTAUR_THREAD_KEY", raising=False)

    assert toolrunner.main(["__describe", "alpha"]) == 0
    desc = json.loads(capsys.readouterr().out)
    assert desc["tool"] == "alpha"

    assert toolrunner.main(["alpha", "sync_echo", '{"text":"hi"}']) == 0
    out = capsys.readouterr().out
    assert "hi" in out

    # A failed call exits non-zero and prints the error envelope.
    assert toolrunner.main(["alpha", "missing"]) == toolrunner._CLI_TOOL_ERROR
    err = json.loads(capsys.readouterr().out)
    assert err["error"].startswith("Method 'missing' not found")

    # An unknown tool also fails (and reports which tools are available).
    assert toolrunner.main(["ghost", "x"]) == toolrunner._CLI_TOOL_ERROR
    err = json.loads(capsys.readouterr().out)
    assert err["error"] == "Tool 'ghost' not found"


def test_emit_tool_metric_is_inert_without_opt_in(monkeypatch):
    monkeypatch.delenv("CENTAUR_TOOL_METRICS", raising=False)
    monkeypatch.setenv("CENTAUR_API_KEY", "sbx1.tok")
    called: list[int] = []
    monkeypatch.setattr(
        toolrunner.urllib.request, "urlopen", lambda *a, **k: called.append(1)
    )
    toolrunner._emit_tool_metric("t", "m", True, 0.1)
    assert called == []  # gated off → no network


def test_emit_tool_metric_posts_when_enabled(monkeypatch):
    monkeypatch.setenv("CENTAUR_TOOL_METRICS", "1")
    monkeypatch.setenv("CENTAUR_API_KEY", "sbx1.tok")
    monkeypatch.setenv("CENTAUR_API_URL", "http://api:9000")
    captured: dict = {}

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["data"] = json.loads(req.data)
        captured["auth"] = req.headers.get("Authorization")
        return _Resp()

    monkeypatch.setattr(toolrunner.urllib.request, "urlopen", fake_urlopen)
    toolrunner._emit_tool_metric("coingecko", "price", True, 0.42)
    assert captured["url"] == "http://api:9000/agent/tools-data/tool-call-metric"
    assert captured["data"] == {
        "tool": "coingecko",
        "method": "price",
        "success": True,
        "duration_s": 0.42,
    }
    assert captured["auth"] == "Bearer sbx1.tok"
