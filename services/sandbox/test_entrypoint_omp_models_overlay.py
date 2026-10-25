"""Behaviour tests for OMP_MODELS_OVERLAY provisioning in entrypoint.sh."""

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

REGISTRY = (
    "providers:\n"
    "  litellm:\n"
    "    baseUrl: __OMP_LITELLM_BASE_URL__\n"
    "    api: openai-completions\n"
    "    models:\n"
    "      - id: glm-5.2-fp8\n"
    "        supportsTools: true\n"
)


def mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


class EntrypointOmpModelsOverlayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.harness = self.root / "harness"
        (self.harness / "codex").mkdir(parents=True)
        (self.harness / "codex" / "config.toml").write_text('model = "fixture"\n')
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
        extra_env: dict[str, str] | None = None,
        check: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        home.mkdir(exist_ok=True)
        (home / "AGENTS.md").write_text("Provider-free entrypoint test.\n")
        env = {
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "HOME": str(home),
            # Nonexistent state dir keeps ~/.omp a real directory (no PVC symlink).
            "CENTAUR_STATE_DIR": str(self.root / "no-state"),
            "CENTAUR_HARNESS_CONFIG_DIR": str(self.harness),
            "CENTAUR_TOOLS_AUTO_RELOAD": "false",
            "GOOGLE_APPLICATION_CREDENTIALS": "/dev/null",
        }
        if extra_env:
            env.update(extra_env)
        return subprocess.run(
            ["bash", str(SANDBOX / "entrypoint.sh"), "sh", "-c", "exit 0"],
            env=env,
            check=check,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def assert_no_temp_files(self, directory: Path) -> None:
        self.assertEqual(
            [p.name for p in directory.iterdir() if p.name.startswith(".models.yml.")],
            [],
        )

    def test_writes_native_registry_with_private_permissions(self) -> None:
        home = self.root / "home"
        agent_dir = home / ".omp" / "agent"
        agent_dir.mkdir(parents=True)
        persistent_config = "providers:\n  webSearch: auto\n"
        (agent_dir / "config.yml").write_text(persistent_config)
        existing_pi_files = self.root / "existing-pi.yml"
        existing_pi_files.write_text("retry:\n  maxRetries: 1\n")

        self.boot(
            home,
            {
                "OMP_MODELS_OVERLAY": REGISTRY,
                "OMP_LITELLM_BASE_URL": "https://gateway.internal/v1",
                "PI_CONFIG_FILES": str(existing_pi_files),
            },
        )

        models = (agent_dir / "models.yml").read_text()
        self.assertIn("baseUrl: https://gateway.internal/v1\n", models)
        self.assertNotIn("__OMP_LITELLM_BASE_URL__", models)
        self.assertIn("id: glm-5.2-fp8\n", models)
        self.assertEqual(mode(agent_dir / "models.yml"), 0o600)
        self.assertEqual((agent_dir / "config.yml").read_text(), persistent_config)
        self.assertEqual(
            existing_pi_files.read_text(), "retry:\n  maxRetries: 1\n"
        )
        self.assertFalse((home / ".config" / "centaur").exists())
        self.assert_no_temp_files(agent_dir)

    def test_respects_pi_coding_agent_dir(self) -> None:
        home = self.root / "home"
        override = self.root / "custom-agent-dir"

        self.boot(
            home,
            {
                "PI_CODING_AGENT_DIR": str(override),
                "OMP_MODELS_OVERLAY": "providers:\n  litellm:\n    baseUrl: https://gw/v1\n",
            },
        )

        self.assertEqual(mode(override / "models.yml"), 0o600)
        self.assertIn("baseUrl: https://gw/v1\n", (override / "models.yml").read_text())
        self.assertFalse((home / ".omp" / "agent" / "models.yml").exists())

    def test_unset_or_empty_leaves_existing_registry_alone(self) -> None:
        for label, value in [("unset", None), ("empty", "")]:
            with self.subTest(label=label):
                home = self.root / f"home-{label}"
                agent_dir = home / ".omp" / "agent"
                agent_dir.mkdir(parents=True)
                existing = "providers:\n  litellm:\n    baseUrl: https://existing/v1\n"
                (agent_dir / "models.yml").write_text(existing)
                env = {}
                if value is not None:
                    env["OMP_MODELS_OVERLAY"] = value

                self.boot(home, env)

                self.assertEqual((agent_dir / "models.yml").read_text(), existing)
                self.assert_no_temp_files(agent_dir)

    def test_placeholder_without_base_url_fails_closed(self) -> None:
        home = self.root / "home"
        result = self.boot(home, {"OMP_MODELS_OVERLAY": REGISTRY}, check=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("OMP_LITELLM_BASE_URL is unset", result.stderr)
        self.assertFalse((home / ".omp" / "agent" / "models.yml").exists())


if __name__ == "__main__":
    unittest.main()
