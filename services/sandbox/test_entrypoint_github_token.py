"""Behaviour tests for the GitHub App installation-token wiring in entrypoint.sh."""

from __future__ import annotations

import os
import shlex
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


SANDBOX = Path(__file__).parent

TOKEN = "ghs_fixture_installation_token"
APP_KEY = "-----BEGIN RSA PRIVATE KEY-----fixture-key-material"


class EntrypointGithubTokenTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.harness = self.root / "harness"
        (self.harness / "codex").mkdir(parents=True)
        (self.harness / "codex" / "config.toml").write_text('model = "fixture"\n')
        self.gitconfig = self.root / "gitconfig"
        self.gitconfig.touch()
        self.command("install-tool-shims", "exit 0\n")
        self.command(
            "compose-system-prompt",
            f"exec {shlex.quote(sys.executable)} "
            f"{shlex.quote(str(SANDBOX / 'compose_system_prompt.py'))} \"$@\"\n",
        )
        self.gh_calls = self.root / "gh-calls.txt"
        self.command("gh", f'printf "%s\\n" "$*" >> {shlex.quote(str(self.gh_calls))}\n')

    def command(self, name: str, body: str) -> Path:
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)
        return path

    def boot(
        self,
        home: Path,
        extra_env: dict[str, str] | None = None,
        command: str | None = None,
        check: bool = True,
    ) -> SimpleNamespace:
        home.mkdir(exist_ok=True)
        (home / "AGENTS.md").write_text("Provider-free entrypoint test.\n")
        command = command or (
            "printf '%s|%s' \"${GITHUB_TOKEN-<unset>}\" \"${GH_TOKEN-<unset>}\""
            f" > {shlex.quote(str(self.root / 'env-seen.txt'))}"
        )
        env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(home),
            "CENTAUR_STATE_DIR": str(self.root / "no-state"),
            "CENTAUR_HARNESS_CONFIG_DIR": str(self.harness),
            "CENTAUR_TOOLS_AUTO_RELOAD": "false",
            "GOOGLE_APPLICATION_CREDENTIALS": "/dev/null",
            "GIT_CONFIG_GLOBAL": str(self.gitconfig),
            "GIT_CONFIG_SYSTEM": "/dev/null",
        }
        if extra_env:
            env.update(extra_env)
        out = self.root / "stdout.txt"
        err = self.root / "stderr.txt"
        with out.open("w") as out_fh, err.open("w") as err_fh:
            proc = subprocess.Popen(
                ["bash", str(SANDBOX / "entrypoint.sh"), "sh", "-c", command],
                env=env,
                stdout=out_fh,
                stderr=err_fh,
                start_new_session=True,
                text=True,
            )
            try:
                returncode = proc.wait(timeout=30)
            finally:
                # The token refresh loop is a background child that outlives the
                # exec'd command; reap the whole session so tests do not leak it.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        result = SimpleNamespace(
            returncode=returncode, stdout=out.read_text(), stderr=err.read_text()
        )
        if check and returncode != 0:
            raise AssertionError(
                f"entrypoint exited {returncode}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
            )
        return result

    def test_app_credentials_mint_file_sources_and_drop_env(self) -> None:
        home = self.root / "home"
        self.command("bun", f"printf '%s' {shlex.quote(TOKEN)}\n")

        result = self.boot(
            home,
            {
                "GITHUB_APP_ID": "123456",
                "GITHUB_APP_PRIVATE_KEY": APP_KEY,
                # Stale/stub env must not shadow the refreshed file source.
                "GITHUB_TOKEN": "stale-placeholder",
                "GH_TOKEN": "stale-placeholder",
            },
        )

        token_file = home / ".centaur" / "github-token"
        self.assertEqual(token_file.read_text(), TOKEN)
        self.assertEqual(stat.S_IMODE(token_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((home / ".centaur").stat().st_mode), 0o700)
        err_file = home / ".centaur" / "mint-github-token.err"
        self.assertEqual(stat.S_IMODE(err_file.stat().st_mode), 0o600)

        credentials = home / ".git-credentials"
        self.assertEqual(
            credentials.read_text(), f"https://x-access-token:{TOKEN}@github.com\n"
        )
        self.assertEqual(stat.S_IMODE(credentials.stat().st_mode), 0o600)

        self.assertEqual((self.root / "env-seen.txt").read_text(), "<unset>|<unset>")
        self.assertIn("github installation token minted", result.stderr)
        self.assertNotIn(TOKEN, result.stderr)
        self.assertNotIn("fixture-key-material", result.stderr)
        self.assertEqual(err_file.read_text(), "")

    def test_no_app_credentials_keeps_upstream_placeholder_env(self) -> None:
        home = self.root / "home"

        self.boot(home, {"GITHUB_TOKEN": "nominal-placeholder-env"})

        self.assertEqual(
            (self.root / "env-seen.txt").read_text(), "nominal-placeholder-env|<unset>"
        )
        self.assertFalse((home / ".centaur").exists())
        self.assertFalse((home / ".git-credentials").exists())
        self.assertIn("auth setup-git", self.gh_calls.read_text())

    def test_failed_mint_does_not_block_boot_or_leak_the_key(self) -> None:
        home = self.root / "home"
        self.command("bun", "echo 'mint-github-token: installations 403: denied' >&2; exit 1\n")
        # Skip the linear backoff so the five boot attempts are instant.
        self.command("sleep", "exit 0\n")

        result = self.boot(
            home,
            {"GITHUB_APP_ID": "123456", "GITHUB_APP_PRIVATE_KEY": APP_KEY},
        )

        self.assertFalse((home / ".centaur" / "github-token").exists())
        self.assertFalse((home / ".git-credentials").exists())
        self.assertIn("mint failed after 5 attempts", result.stderr)
        self.assertIn("installations 403: denied", result.stderr)
        self.assertNotIn("fixture-key-material", result.stderr)
        self.assertEqual((self.root / "env-seen.txt").read_text(), "<unset>|<unset>")


if __name__ == "__main__":
    unittest.main()
