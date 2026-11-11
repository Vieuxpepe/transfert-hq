"""Pure household view checks. The browser render lives in visual_household_views_playwright.py."""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class HouseholdViewPureTests(unittest.TestCase):
    def test_node_contracts(self) -> None:
        completed = subprocess.run(
            ["node", str(ROOT / "tests" / "hq_household_views.test.mjs")],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_views_do_not_touch_shared_navigation(self) -> None:
        meals = (ROOT / "assets" / "hq-household-meals.js").read_text(encoding="utf-8")
        budget = (ROOT / "assets" / "hq-household-budget.js").read_text(encoding="utf-8")
        self.assertIn('label: "Repas"', meals)
        self.assertIn('label: "Budget"', budget)
        self.assertIn("unmount", meals)
        self.assertIn("unmount", budget)
        self.assertNotIn("iphone_bridge", meals)
        self.assertNotIn("iphone_bridge", budget)


if __name__ == "__main__":
    unittest.main()
