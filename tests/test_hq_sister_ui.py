"""Sister UI stage director — syntax + Node helper checks."""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class SisterUiChecks(unittest.TestCase):
    def test_sister_assets_syntax(self) -> None:
        for rel in ("assets/hq-sister.js", "assets/hq-else-chip.js", "assets/hq-companion.js"):
            path = ROOT / rel
            self.assertTrue(path.is_file(), rel)
            subprocess.run(["node", "--check", str(path)], check=True, cwd=ROOT)

    def test_sister_core_helpers_with_node(self) -> None:
        script = ROOT / "tests" / "check_hq_sister.mjs"
        out = subprocess.run(["node", str(script)], capture_output=True, text=True, cwd=ROOT, timeout=30)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("hq-sister checks passed", out.stdout)


if __name__ == "__main__":
    unittest.main()
