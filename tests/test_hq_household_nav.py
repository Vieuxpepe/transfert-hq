"""Repas and Budget use the existing view switch and do not create Household storage."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import hq_finances as finances
import hq_meals as meals

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")


class HouseholdNavSourceTests(unittest.TestCase):
    def test_views_are_registered_once(self) -> None:
        self.assertEqual(BRIDGE.count('id="nav-repas"'), 1)
        self.assertEqual(BRIDGE.count('id="nav-budget"'), 1)
        self.assertIn('repas: \'Repas\'', BRIDGE)
        self.assertIn('budget: \'Budget\'', BRIDGE)
        self.assertIn('id="hq-repas-app"', BRIDGE)
        self.assertIn('id="hq-budget-app"', BRIDGE)
        self.assertIn('src="/assets/hq-household-meals.js"', BRIDGE)
        self.assertIn('src="/assets/hq-household-budget.js"', BRIDGE)
        self.assertIn('src="/assets/hq-household-nav.js"', BRIDGE)
        self.assertIn('href="/assets/hq-household-meals.css"', BRIDGE)
        self.assertIn('href="/assets/hq-household-budget.css"', BRIDGE)
        self.assertIn("window.hqHouseholdSync(view)", BRIDGE)
        self.assertIn("window.hqHouseholdNoteNavigation(view, prevView)", BRIDGE)
        self.assertIn("window.hqForgeHide", BRIDGE)
        self.assertLess(
            BRIDGE.index("window.hqHouseholdSync(view)"),
            BRIDGE.index("window.hqForgeHide"),
        )

    def test_readonly_open_creates_nothing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hq-nav-") as tmp:
            root = Path(tmp)
            meals.bind(root=root, actor=lambda: "tester", now=lambda: 1.0)
            finances.bind(root=root, actor=lambda: "tester", now=lambda: 1.0)
            try:
                meal_code, meal_body = meals.http_get("/api/meals/recipes")
                money_code, money_body = finances.http_get("/api/finances/summary")
            finally:
                meals.reset_for_tests()
                finances.reset_for_tests()
            self.assertEqual(meal_code, 404)
            self.assertEqual(meal_body["code"], "not_found")
            self.assertEqual(money_code, 404)
            self.assertEqual(money_body["code"], "not_found")
            self.assertEqual(meal_body["error"], "Base household absente")
            self.assertFalse((root / ".hq-household").exists())
            self.assertFalse((root / "inventory.json").exists())

    def test_missing_recipe_is_not_a_missing_store(self) -> None:
        import hq_household_store as store

        with tempfile.TemporaryDirectory(prefix="hq-nav-recipe-") as tmp:
            root = Path(tmp)
            store.set_acl_for_tests(False)
            meals.bind(root=root, actor=lambda: "tester", now=lambda: 1.0)
            finances.bind(root=root, actor=lambda: "tester", now=lambda: 1.0)
            try:
                with store.open_store(root) as opened:
                    with opened.transaction():
                        finances.ensure_default_household(opened.conn)
                code, body = meals.http_get("/api/meals/recipes", {"id": "rcp-0000000000000001"})
            finally:
                meals.reset_for_tests()
                finances.reset_for_tests()
                store.set_acl_for_tests(True)
            self.assertEqual((code, body["code"], body["error"]), (404, "not_found", "introuvable"))


if __name__ == "__main__":
    unittest.main()
