from __future__ import annotations

import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


ENTRYPOINT = Path(__file__).with_name("entrypoint.sh")


def _omp_entrypoint_block() -> str:
    text = ENTRYPOINT.read_text()
    start = text.index("# ── omp (oh-my-pi) settings")
    end = text.index("# ── GitHub App installation token", start)
    return text[start:end]


class EntrypointOmpMaterializeTest(unittest.TestCase):
    def _run_omp_block(self, script: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", "-c", script],
            check=False,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def test_waits_for_configured_overlay_before_falling_back_to_baked_registry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            baked = home / "harness" / "omp"
            overlay = root / "overlay" / "harness" / "omp"
            agent = root / "agent"
            baked.mkdir(parents=True)
            (baked / "config.yml").write_text("source: baked\nbase: __OMP_LITELLM_BASE_URL__\n")
            (baked / "models.yml").write_text("source: baked\n")

            script = textwrap.dedent(
                f"""
                set -euo pipefail
                HOME_DIR={home}
                HARNESS_CONFIG_DIR={home / "harness"}
                PI_CODING_AGENT_DIR={agent}
                CENTAUR_OVERLAY_OMP_DIR={overlay}
                OMP_LITELLM_BASE_URL=http://litellm.test/v1
                (
                  sleep 1
                  mkdir -p "$CENTAUR_OVERLAY_OMP_DIR"
                  printf 'source: overlay\\nbase: __OMP_LITELLM_BASE_URL__\\n' > "$CENTAUR_OVERLAY_OMP_DIR/config.yml"
                  printf 'source: overlay\\n' > "$CENTAUR_OVERLAY_OMP_DIR/models.yml"
                ) &
                {_omp_entrypoint_block()}
                test "$(cat "$PI_CODING_AGENT_DIR/config.yml")" = "$(printf 'source: overlay\\nbase: http://litellm.test/v1')"
                test "$(cat "$PI_CODING_AGENT_DIR/models.yml")" = "$(printf 'source: overlay')"
                """
            )

            result = self._run_omp_block(script)

            self.assertEqual(result.returncode, 0, result.stderr)

    def test_fails_when_no_omp_model_registry_can_be_materialized(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            home = root / "home"
            baked = home / "harness" / "omp"
            agent = root / "agent"
            baked.mkdir(parents=True)
            (baked / "config.yml").write_text("source: baked\n")

            script = textwrap.dedent(
                f"""
                set -euo pipefail
                HOME_DIR={home}
                HARNESS_CONFIG_DIR={home / "harness"}
                PI_CODING_AGENT_DIR={agent}
                {_omp_entrypoint_block()}
                """
            )

            result = self._run_omp_block(script)

            self.assertNotEqual(result.returncode, 0, result.stderr)
            self.assertIn("missing omp harness config: models.yml", result.stderr)


if __name__ == "__main__":
    unittest.main()
