from __future__ import annotations

import contextlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

import install_tool_shims


class CopyPublishedToolsTest(unittest.TestCase):
    def test_copies_tool_dirs_and_skips_duplicate_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            published = root / "published"
            target = root / "target"

            (target / "research" / "sensortower").mkdir(parents=True)
            (target / "research" / "sensortower" / "pyproject.toml").write_text("base\n")
            (target / "research" / "websearch").mkdir(parents=True)
            (target / "research" / "websearch" / "pyproject.toml").write_text("old project\n")
            (target / "research" / "websearch" / "old.py").write_text("old\n")

            (published / "research" / "websearch").mkdir(parents=True)
            (published / "research" / "websearch" / "pyproject.toml").write_text("new project\n")
            (published / "research" / "websearch" / "new.py").write_text("new\n")
            (published / "research" / "company").mkdir(parents=True)
            (published / "research" / "company" / "pyproject.toml").write_text("company\n")

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                install_tool_shims._copy_published_tools(target, published)

            self.assertEqual(
                (target / "research" / "sensortower" / "pyproject.toml").read_text(),
                "base\n",
            )
            self.assertIn("skipping duplicate tool websearch", stderr.getvalue())
            self.assertEqual(
                (target / "research" / "websearch" / "pyproject.toml").read_text(),
                "old project\n",
            )
            self.assertEqual((target / "research" / "websearch" / "old.py").read_text(), "old\n")
            self.assertFalse((target / "research" / "websearch" / "new.py").exists())
            self.assertEqual((target / "research" / "company" / "pyproject.toml").read_text(), "company\n")


class CentaurToolsCallTest(unittest.TestCase):
    def test_call_loads_flat_hyphenated_tool_by_client_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_fake_centaur_sdk(root)
            tool_dir = root / "internal-apps"
            tool_dir.mkdir()
            (tool_dir / "__init__.py").write_text("")
            (tool_dir / "client.py").write_text(
                "def echo(value):\n"
                "    return {'value': value, 'loader': __name__}\n"
            )
            (tool_dir / "cli.py").write_text("def app():\n    pass\n")
            (tool_dir / "pyproject.toml").write_text(
                """
[project]
name = "internal-apps"
version = "0.1.0"
requires-python = ">=3.11"

[project.scripts]
internal-apps = "cli:app"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
only-include = ["__init__.py", "client.py", "cli.py"]
""".lstrip()
            )

            result = self._run_catalog_call(
                root,
                {
                    "name": "internal-apps",
                    "project_dir": str(tool_dir),
                    "entrypoint": "cli:app",
                    "client_module": "client.py",
                },
                "echo",
                {"value": "ok"},
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout),
                {"value": "ok", "loader": "_centaur_tool_client"},
            )

    def test_call_uses_declared_package_entrypoint_for_relative_imports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            self._write_fake_centaur_sdk(root)
            tool_dir = root / "standard-metrics"
            tool_dir.mkdir()
            (tool_dir / "__init__.py").write_text("")
            (tool_dir / "helper.py").write_text("VALUE = 'from-helper'\n")
            (tool_dir / "client.py").write_text(
                "from .helper import VALUE\n\n"
                "def echo(value):\n"
                "    return {'value': value, 'helper': VALUE, 'loader': __name__}\n"
            )
            (tool_dir / "cli.py").write_text("def app():\n    pass\n")
            (tool_dir / "pyproject.toml").write_text(
                """
[project]
name = "standard-metrics"
version = "0.1.0"
requires-python = ">=3.11"

[project.scripts]
standard-metrics = "centaur_tool_standard_metrics.cli:app"

[tool.hatch.build.targets.wheel]
packages = ["."]

[tool.hatch.build.targets.wheel.sources]
"." = "centaur_tool_standard_metrics"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
""".lstrip()
            )

            result = self._run_catalog_call(
                root,
                {
                    "name": "standard-metrics",
                    "project_dir": str(tool_dir),
                    "entrypoint": "centaur_tool_standard_metrics.cli:app",
                    "client_module": "client.py",
                },
                "echo",
                {"value": "ok"},
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(
                json.loads(result.stdout),
                {
                    "value": "ok",
                    "helper": "from-helper",
                    "loader": "centaur_tool_standard_metrics.client",
                },
            )

    def _run_catalog_call(
        self,
        root: Path,
        tool: dict[str, str],
        method: str,
        payload: dict[str, str],
    ) -> subprocess.CompletedProcess[str]:
        bin_dir = root / "bin"
        bin_dir.mkdir()
        index_path = bin_dir / ".centaur-tools.json"
        index_path.write_text(json.dumps([tool]))
        catalog_path = bin_dir / "centaur-tools"
        install_tool_shims._write_catalog(catalog_path, index_path, str(root))
        return subprocess.run(
            [str(catalog_path), "call", tool["name"], method, json.dumps(payload)],
            text=True,
            capture_output=True,
            check=False,
            cwd=root,
        )

    def _write_fake_centaur_sdk(self, root: Path) -> None:
        sdk = root / "centaur_sdk"
        sdk.mkdir()
        (sdk / "__init__.py").write_text("")
        (sdk / "tool_sdk.py").write_text(
            "class ToolContext:\n"
            "    def __init__(self, name, thread_key):\n"
            "        self.name = name\n"
            "        self.thread_key = thread_key\n\n"
            "def set_tool_context(ctx):\n"
            "    return None\n\n"
            "def reset_tool_context(token):\n"
            "    return None\n"
        )


if __name__ == "__main__":
    unittest.main()
