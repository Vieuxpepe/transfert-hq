import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_culinia
import hq_finances
import hq_grocery
import hq_inventory
import hq_meals


class TestHqCulinia(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_root = Path(self._tmp.name)
        hq_culinia.bind(root=self.tmp_root)

    def tearDown(self) -> None:
        hq_culinia.bind(root=ROOT)
        self._tmp.cleanup()

    def test_meal_plan_persistence_and_status_summary(self) -> None:
        code, st0 = hq_culinia.http_get("/api/culinia/status")
        self.assertEqual(code, 200)
        self.assertEqual(st0["planned_days"], 0)

        res = hq_culinia._execute_tool(
            "save_meal_plan",
            {"days": {"Lundi": "Poulet rôti", "Mardi": "Pâtes pesto"}, "note": "Semaine test"},
        )
        self.assertTrue(res["ok"])
        self.assertEqual(res["result"]["days"]["lundi"], "Poulet rôti")

        got = hq_culinia._execute_tool("get_meal_plan", {})
        self.assertTrue(got["ok"])
        self.assertEqual(got["result"]["days"]["mardi"], "Pâtes pesto")
        self.assertEqual(got["result"]["note"], "Semaine test")

        code, st1 = hq_culinia.http_get("/api/culinia/status")
        self.assertEqual(code, 200)
        self.assertEqual(st1["planned_days"], 2)

    def test_grocery_tools_proxy_to_hq_grocery(self) -> None:
        with patch.object(
            hq_grocery,
            "http_get",
            side_effect=[
                (200, {"products": [{"name": "Tomates"}]}),
                (200, {"lots": [{"qty": 3}]}),
            ],
        ):
            p = hq_culinia._execute_tool("list_products", {})
            l = hq_culinia._execute_tool("list_lots", {})

        self.assertTrue(p["ok"])
        self.assertEqual(p["result"]["products"][0]["name"], "Tomates")
        self.assertTrue(l["ok"])
        self.assertEqual(l["result"]["lots"][0]["qty"], 3)

    def test_chat_tool_roundtrip_and_clear(self) -> None:
        fake_responses = [
            (json.dumps({"reply": "Je regarde le plan...", "tools": [{"name": "get_meal_plan", "args": {}}]}), "gemini-mock"),
            (json.dumps({"reply": "Voici ton menu, Maître.", "tools": []}), "gemini-mock"),
        ]
        with patch("hq_ai.generate", side_effect=fake_responses):
            code, payload = hq_culinia.http_post("/api/culinia/chat", {"message": "Quel est le menu ?"})

        self.assertEqual(code, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["reply"], "Voici ton menu, Maître.")
        self.assertEqual(payload["tools_used"], ["get_meal_plan"])
        self.assertEqual(len(payload["messages"]), 2)

        code, cleared = hq_culinia.http_post("/api/culinia/clear", {})
        self.assertEqual(code, 200)
        self.assertEqual(cleared["messages"], [])

        code, empty_resp = hq_culinia.http_post("/api/culinia/chat", {"message": "   "})
        self.assertEqual(code, 400)
        self.assertFalse(empty_resp["ok"])

    def test_list_recipes_and_ambient_bubble(self) -> None:
        with patch.object(hq_meals, "http_get", return_value=(200, {"items": [{"title": "Risotto aux champignons"}]})):
            r = hq_culinia._execute_tool("list_recipes", {})
            self.assertTrue(r["ok"])
            self.assertEqual(r["result"]["items"][0]["title"], "Risotto aux champignons")

            with patch("hq_ai.generate", return_value=("Saisis bien les champignons avant de mouiller au bouillon, Maître !", "gemini-mock")):
                code, amb = hq_culinia.http_post(
                    "/api/culinia/ambient",
                    {"trigger": "recipe", "recipe_title": "Risotto aux champignons", "nsfw": False},
                )
            self.assertEqual(code, 200)
            self.assertTrue(amb["ok"])
            self.assertIn("champignons", amb["line"])

            with patch("hq_ai.generate", side_effect=RuntimeError("offline")):
                code2, amb2 = hq_culinia.http_post(
                    "/api/culinia/ambient",
                    {"trigger": "recipe", "recipe_title": "Magret de canard", "nsfw": True},
                )
            self.assertEqual(code2, 200)
            self.assertTrue(amb2["ok"])
            self.assertIn("Magret de canard", amb2["line"])

    def test_list_inventory_tool(self) -> None:
        fake_inv = {
            "ok": True,
            "places": [{"id": "p1", "name": "Congélateur"}],
            "items": [{"name": "Saumon", "qty": 2, "unit": "filets", "place_id": "p1", "tags": ["poisson"], "note": ""}],
        }
        with patch.object(hq_inventory, "http_get", return_value=(200, fake_inv)):
            res = hq_culinia._execute_tool("list_inventory", {})
        self.assertTrue(res["ok"])
        self.assertEqual(res["result"]["count"], 1)
        self.assertEqual(res["result"]["items"][0]["name"], "Saumon")
        self.assertEqual(res["result"]["items"][0]["place"], "Congélateur")

    def test_create_recipe_scale_calendar_build_and_budget(self) -> None:
        with patch.object(hq_meals, "http_post", return_value=(200, {"ok": True, "recipe": {"id": "rcp-1", "title": "Pâtes ail"}})) as mpost:
            r = hq_culinia._execute_tool(
                "create_meal_recipe",
                {
                    "title": "Pâtes ail",
                    "servings": 2,
                    "ingredients": [{"name": "Spaghetti", "qty": 200, "unit": "g"}],
                    "steps": ["Cuire al dente"],
                },
            )
            self.assertTrue(r["ok"])
            sent = mpost.call_args[0][1]
            self.assertEqual(sent["ingredients"][0]["qty_milli"], 200000)

        sample_recipe = {
            "id": "rcp-1",
            "rev": 1,
            "title": "Pâtes ail",
            "servings": 2,
            "leftover_policy": "none",
            "ingredients": [{"name": "Spaghetti", "qty_milli": 200000, "unit": "g"}],
            "steps": ["Cuire"],
        }
        with patch.object(hq_meals, "http_get", return_value=(200, {"items": [sample_recipe]})):
            sc = hq_culinia._execute_tool("scale_recipe_portions", {"recipe_id": "rcp-1", "target_servings": 4, "save": False})
        self.assertTrue(sc["ok"])
        self.assertEqual(sc["result"]["ingredients"][0]["qty_milli"], 400000)

        with patch.object(hq_meals, "http_get", return_value=(200, {"items": []})), \
             patch.object(hq_meals, "http_post", return_value=(200, {"ok": True, "meal_plan": {"id": "mpl-1"}})) as ppost:
            cal = hq_culinia._execute_tool(
                "save_meal_calendar",
                {"period_start": "2026-11-09", "period_end": "2026-11-15", "slots": [{"date": "2026-11-12", "meal": "dinner", "recipe_id": "rcp-1"}]},
            )
            self.assertTrue(cal["ok"])
            self.assertEqual(ppost.call_args[0][0], "/api/meals/plans")

        with patch.object(hq_meals, "http_post", return_value=(200, {"ok": True, "missing": [{"name": "Ail"}]})):
            bl = hq_culinia._execute_tool("build_plan_grocery_list", {"plan_id": "mpl-1", "mode": "preview"})
        self.assertTrue(bl["ok"])

        with patch.object(
            hq_finances,
            "http_get",
            side_effect=[
                (200, {"ok": True, "month": "2026-11", "spent_cents": 25000}),
                (200, {"ok": True, "items": [{"name": "Épicerie", "limit_cents": 60000}]}),
            ],
        ):
            bg = hq_culinia._execute_tool("get_food_budget", {"month": "2026-11"})
        self.assertTrue(bg["ok"])
        self.assertEqual(bg["result"]["envelopes"][0]["name"], "Épicerie")

    def test_preferences_and_product_id_automatch(self) -> None:
        saved = hq_culinia._execute_tool(
            "save_preferences",
            {
                "likes": ["ail", "saumon"],
                "dislikes": ["coriandre"],
                "equipment": ["air fryer"],
                "household_size": 2,
            },
        )
        self.assertTrue(saved["ok"])
        got = hq_culinia._execute_tool("get_preferences", {})
        self.assertEqual(got["result"]["dislikes"], ["coriandre"])
        self.assertIn("air fryer", hq_culinia._prefs_prompt_block())

        products = [{"id": "prd-ail", "name": "Ail", "canonical_unit": "g"}]
        with patch.object(hq_grocery, "http_get", return_value=(200, {"items": products})), \
             patch.object(hq_meals, "http_post", return_value=(200, {"ok": True, "recipe": {"id": "rcp-2"}})) as mpost:
            res = hq_culinia._execute_tool(
                "create_meal_recipe",
                {
                    "title": "Poulet à l'ail",
                    "servings": 2,
                    "ingredients": [{"name": "Ail", "qty": 20, "unit": "g"}],
                    "steps": ["Rôtir"],
                },
            )
        self.assertTrue(res["ok"])
        self.assertEqual(mpost.call_args[0][1]["ingredients"][0]["product_id"], "prd-ail")

    def test_fetch_recipe_image_cache_and_chat_attachment(self) -> None:
        fake_mealdb = {"meals": [{"strMeal": "Salmon Risotto", "strMealThumb": "https://example.com/risotto.jpg"}]}

        class _FakeResp:
            status = 200
            headers = {"Content-Type": "image/jpeg"}

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self, n=-1):
                return b"\xff\xd8\xff\xe0FAKEJPEG"

        fake_ai = [
            (json.dumps({"reply": "Je cherche une photo...", "tools": [{"name": "fetch_recipe_image", "args": {"query": "Salmon Risotto"}}]}), "gemini-mock"),
            (json.dumps({"reply": "Regarde comme c'est appétissant, Maître.", "tools": []}), "gemini-mock"),
        ]
        with patch.object(hq_culinia, "_http_get_json_ext", return_value=fake_mealdb), \
             patch("urllib.request.urlopen", return_value=_FakeResp()), \
             patch("hq_ai.generate", side_effect=fake_ai):
            code, payload = hq_culinia.http_post("/api/culinia/chat", {"message": "Montre-moi un risotto"})

        self.assertEqual(code, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["images"]), 1)
        url = payload["images"][0]["url"]
        self.assertTrue(url.startswith("/api/culinia/image/"))
        p = hq_culinia.image_path(url.rsplit("/", 1)[-1])
        self.assertTrue(p.is_file())
        with self.assertRaises(hq_culinia.CuliniaError):
            hq_culinia.image_path("../secret.jpg")


if __name__ == "__main__":
    unittest.main()
