from __future__ import annotations

import re
import unittest
from pathlib import Path


OMP_MODELS = Path(__file__).parents[2] / "harness" / "omp" / "models.yml"


class OmpConfigTest(unittest.TestCase):
    def test_gateway_glm_uses_native_tool_calls(self) -> None:
        models = OMP_MODELS.read_text()
        match = re.search(
            r"(?m)^      - id: glm-5\.2-fp8$(?P<body>(?:\n        .*)*)",
            models,
        )

        self.assertIsNotNone(match)
        self.assertIn("        supportsTools: true", match.group("body"))


if __name__ == "__main__":
    unittest.main()
