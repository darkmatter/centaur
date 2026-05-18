"""Root conftest — ensure centaur_sdk is importable for editable installs."""

import sys
from pathlib import Path

# Add repo root so `import centaur_sdk` resolves to ../../centaur_sdk/
_repo_root = str(Path(__file__).resolve().parent.parent.parent)
if _repo_root not in sys.path:
    sys.path.insert(0, _repo_root)
