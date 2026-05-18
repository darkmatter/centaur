"""Regression tests for the sandbox `slack-upload` helper."""

from __future__ import annotations

import json
import stat
import subprocess
from pathlib import Path


SLACK_UPLOAD_SH = Path(__file__).resolve().parents[2] / "sandbox" / "slack-upload.sh"


def _write_fake_call(path: Path, body: str) -> None:
    path.write_text(body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


def _run_helper(
    tmp_path: Path,
    file_path: Path,
    *,
    call_response: str = '{"permalink":"https://slack.com/archives/C123/p456"}',
) -> subprocess.CompletedProcess[str]:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()

    script = f"""#!/bin/bash
set -euo pipefail
printf '%s' "$3" > {json.dumps(str(tmp_path / 'body.json'))}
jq -e '.filename == "artifact.mp4" and (.content_base64 | length > 0) and (.file_path | not)' {json.dumps(str(tmp_path / 'body.json'))} >/dev/null
printf '%s\\n' {json.dumps(call_response)}
"""
    _write_fake_call(fake_bin / "call", script)

    env = {
        "PATH": f"{fake_bin}:/usr/bin:/bin",
        "SLACK_CHANNEL": "C123",
        "SLACK_THREAD_TS": "123.456",
    }

    return subprocess.run(
        ["bash", str(SLACK_UPLOAD_SH), str(file_path)],
        check=False,
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env=env,
    )


def test_slack_upload_uses_inline_content_for_sandbox_local_artifacts(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    artifact = artifact_dir / "artifact.mp4"
    artifact.write_bytes(b"video-bytes")

    result = _run_helper(tmp_path, Path("artifacts/artifact.mp4"))

    assert result.returncode == 0, result.stderr or result.stdout
    assert result.stdout.strip() == "https://slack.com/archives/C123/p456"

    payload = json.loads((tmp_path / "body.json").read_text())
    assert payload["channel"] == "C123"
    assert payload["thread_ts"] == "123.456"
    assert payload["filename"] == "artifact.mp4"
    assert "file_path" not in payload


def test_slack_upload_extracts_permalink_from_toon_response(tmp_path: Path) -> None:
    artifact_dir = tmp_path / "artifacts"
    artifact_dir.mkdir()
    artifact = artifact_dir / "artifact.mp4"
    artifact.write_bytes(b"video-bytes")

    result = _run_helper(
        tmp_path,
        Path("artifacts/artifact.mp4"),
        call_response="permalink: https://slack.com/archives/C123/p789",
    )

    assert result.returncode == 0, result.stderr or result.stdout
    assert result.stdout.strip() == "https://slack.com/archives/C123/p789"


def test_slack_upload_does_not_trust_permalink_from_failed_call(tmp_path: Path) -> None:
    artifact = tmp_path / "artifact.mp4"
    artifact.write_bytes(b"video-bytes")

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    script = """#!/bin/bash
set -euo pipefail
printf '%s\n' 'error: https://slack.com/archives/C123/pbad'
exit 1
"""
    _write_fake_call(fake_bin / "call", script)

    result = subprocess.run(
        ["bash", str(SLACK_UPLOAD_SH), str(artifact)],
        check=False,
        capture_output=True,
        text=True,
        cwd=tmp_path,
        env={
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "SLACK_CHANNEL": "C123",
            "SLACK_THREAD_TS": "123.456",
        },
    )

    assert result.returncode == 1
    assert "https://slack.com/archives/C123/pbad" not in result.stdout
    assert "upload_failed" in result.stderr
