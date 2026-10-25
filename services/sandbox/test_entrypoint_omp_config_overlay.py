from __future__ import annotations

import os
import shlex
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SANDBOX = Path(__file__).parent


class EntrypointOmpConfigOverlayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.harness = self.root / "harness"
        (self.harness / "codex").mkdir(parents=True)
        (self.harness / "codex" / "config.toml").write_text('model = "fixture"\n')
        (self.bin / "python3").symlink_to(sys.executable)
        self.command("install-tool-shims", "exit 0\n")
        self.command(
            "compose-system-prompt",
            f"exec {shlex.quote(sys.executable)} "
            f"{shlex.quote(str(SANDBOX / 'compose_system_prompt.py'))} \"$@\"\n",
        )

    def command(self, name: str, body: str) -> None:
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    def boot(
        self,
        home: Path,
        state: Path,
        command: str,
        extra_env: dict[str, str] | None = None,
    ) -> str:
        home.mkdir(exist_ok=True)
        (home / "AGENTS.md").write_text("Provider-free entrypoint test.\n")
        env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(home),
            "CENTAUR_STATE_DIR": str(state),
            "CENTAUR_HARNESS_CONFIG_DIR": str(self.harness),
            "CENTAUR_TOOLS_AUTO_RELOAD": "false",
            "GOOGLE_APPLICATION_CREDENTIALS": "/dev/null",
        }
        if extra_env:
            env.update(extra_env)
        result = subprocess.run(
            ["bash", str(SANDBOX / "entrypoint.sh"), "sh", "-c", command],
            env=env,
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        return result.stdout

    def test_always_appends_private_overlay_last(self) -> None:
        state = self.root / "state"
        state.mkdir()
        persistent = state / "omp" / "agent" / "config.yml"
        persistent.parent.mkdir(parents=True)
        persistent.write_text("modelRoles:\n  default: persistent/model\n")
        home = self.root / "home"
        runtime_overlay = home / ".config" / "centaur" / "omp-config-overlay.yml"
        later = self.root / "later-overlay.yml"
        later.write_text("modelRoles:\n  smol: later/model\n")
        overlay = (
            "modelRoles:\n"
            "  default: overlay/model\n"
            "  smol: overlay/smol\n"
            "retry:\n"
            "  fallbackChains:\n"
            "    default:\n"
            "      - overlay/fallback\n"
        )
        captured = self.root / "pi-config-files.txt"

        self.boot(
            home,
            state,
            f'printf "%s" "$PI_CONFIG_FILES" > {shlex.quote(str(captured))}',
            {
                "OMP_CONFIG_OVERLAY": overlay,
                "PI_CONFIG_FILES": f"{runtime_overlay}{os.pathsep}{later}",
            },
        )

        self.assertEqual(
            captured.read_text(),
            f"{runtime_overlay}{os.pathsep}{later}{os.pathsep}{runtime_overlay}",
        )
        self.assertEqual(runtime_overlay.read_text(), overlay + "\n")
        self.assertEqual(stat.S_IMODE(runtime_overlay.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(runtime_overlay.parent.stat().st_mode), 0o700)
        self.assertEqual(
            persistent.read_text(), "modelRoles:\n  default: persistent/model\n"
        )

    def test_unset_or_empty_overlay_is_a_noop(self) -> None:
        for label, value in [("unset", None), ("empty", "")]:
            with self.subTest(label=label):
                state = self.root / f"state-{label}"
                state.mkdir()
                persistent = state / "omp" / "agent" / "config.yml"
                persistent.parent.mkdir(parents=True)
                persistent.write_text("modelRoles:\n  default: persistent/model\n")
                existing = self.root / f"existing-{label}.yml"
                existing.write_text("retry:\n  maxRetries: 1\n")
                home = self.root / f"home-{label}"
                captured = self.root / f"pi-config-files-{label}.txt"
                env = {"PI_CONFIG_FILES": str(existing)}
                if value is not None:
                    env["OMP_CONFIG_OVERLAY"] = value

                self.boot(
                    home,
                    state,
                    f'printf "%s" "$PI_CONFIG_FILES" > {shlex.quote(str(captured))}',
                    env,
                )

                self.assertEqual(captured.read_text(), str(existing))
                self.assertFalse((home / ".config" / "centaur").exists())
                self.assertEqual(
                    persistent.read_text(), "modelRoles:\n  default: persistent/model\n"
                )


if __name__ == "__main__":
    unittest.main()
