"""Item sheet, minimum, history, spending, recipes, barcodes list and duplicate-safe retries (the data behind the Suivi tab)."""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_dedupe as dedupe
import hq_inventoria_habits as habits
import hq_inventoria_links as links
import hq_inventory as inv
import hq_meals


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-suivi-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        hq_meals.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0, llm_adapter=lambda text, session_id=None: {"reply": "ok"})
        inv.apply({"action": "place.create", "name": "Atelier", "kind": "shelf"})
        self.place = inv.snapshot()["places"][0]["id"]
        inv.apply({"action": "item.create", "name": "Lait", "qty": 5, "unit": "L", "min": 2, "place": self.place, "tags": ["frais"]})
        inv.apply({"action": "item.create", "name": "Filament PLA", "qty": 1000, "unit": "g", "place": self.place})
        self.ids = {i["name"]: i["id"] for i in inv.snapshot()["items"]}
        self.sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def qty(self, name: str) -> int:
        return next(i["qty"] for i in inv.snapshot()["items"] if i["name"] == name)


class ItemSheetTests(_Base):
    def test_the_sheet_gathers_everything_about_one_item(self) -> None:
        lait = self.ids["Lait"]
        soon = time.strftime("%Y-%m-%d", time.localtime(time.time() + 3 * 86400))
        links.set_expiry(self.root, lait, soon)
        habits.link_barcode(self.root, "0123456789012", lait)
        habits.set_alias(self.root, "Lolo", lait, item_name="Lait")
        links.record_prices(self.root, "Maxi", [{"item_id": lait, "qty": 2, "total_cents": 700}], inv.snapshot(), date="2026-11-02")
        code, out = ivo.http_get(f"/api/inventoria/item/{lait}")
        self.assertEqual(code, 200, out)
        self.assertEqual((out["item"]["name"], out["item"]["min"], out["item"]["where"]), ("Lait", 2, "Atelier"))
        self.assertEqual((out["expiry"], out["expiry_days"]), (soon, 3))
        self.assertEqual((out["barcodes"], out["aliases"]), (["0123456789012"], ["Lolo"]))
        self.assertEqual(out["price"]["cheapest"]["store"], "Maxi")
        self.assertEqual(out["unit_dim"], "ml")
        self.assertIsNone(out["filament"])
        self.assertEqual(ivo.http_get("/api/inventoria/item/itm-0000000000000000")[0], 404)
        self.assertEqual(ivo.http_get("/api/inventoria/item/not-an-id")[0], 404)

    def test_a_filament_item_reports_its_material(self) -> None:
        links.link_filament(self.root, "PLA", self.ids["Filament PLA"])
        out = ivo.http_get(f"/api/inventoria/item/{self.ids['Filament PLA']}")[1]
        self.assertEqual((out["filament"], out["unit_dim"]), ("PLA", "g"))


class MinimumTests(_Base):
    def test_the_threshold_can_be_set_cleared_and_is_validated(self) -> None:
        lait = self.ids["Lait"]
        code, out = ivo.http_post("/api/inventoria/min", {"item_id": lait, "min": 7})
        self.assertEqual((code, out["item"]["min"]), (200, 7))
        self.assertEqual(self.qty("Lait"), 5)                                   # a threshold is not a stock change
        self.assertIsNone(ivo.http_post("/api/inventoria/min", {"item_id": lait, "min": None})[1]["item"]["min"])
        self.assertEqual(ivo.http_post("/api/inventoria/min", {"item_id": lait, "min": -1})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/min", {"item_id": lait, "min": 2.5})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/min", {"item_id": lait, "min": True})[0], 400)
        self.assertEqual(ivo.http_post("/api/inventoria/min", {"item_id": "itm-0000000000000000", "min": 1})[0], 404)


class HistoryTests(_Base):
    def test_history_lists_applied_batches_and_one_tap_undo_marks_them(self) -> None:
        lait = self.ids["Lait"]
        ivo.http_post("/api/inventoria/quick", {"session_id": self.sid, "item_id": lait, "delta": -1})
        code, out = ivo.http_get("/api/inventoria/history")
        self.assertEqual(code, 200, out)
        (row,) = out["items"]
        self.assertTrue(row["auto"] and row["undoable"] and not row["undone"] and not row["is_undo"])
        self.assertIn("Lait", row["labels"][0])
        code, undone = ivo.http_post(f"/api/inventoria/ops/{row['id']}/undo", {"apply": True})
        self.assertEqual(code, 200, undone)
        self.assertEqual(self.qty("Lait"), 5)
        rows = {r["id"]: r for r in ivo.http_get("/api/inventoria/history")[1]["items"]}
        self.assertTrue(rows[row["id"]]["undone"] and not rows[row["id"]]["undoable"])
        newest = ivo.http_get("/api/inventoria/history")[1]["items"][0]
        self.assertTrue(newest["is_undo"] and not newest["undoable"])           # the undo itself is listed, but cannot be undone again
        self.assertEqual(len(ivo.http_get("/api/inventoria/history", {"limit": ["1"]})[1]["items"]), 1)


class SpendingAndRecipesTests(_Base):
    def test_spending_route_returns_the_month_and_the_months_available(self) -> None:
        links.record_prices(self.root, "Maxi", [{"item_id": self.ids["Lait"], "qty": 2, "total_cents": 700}], inv.snapshot(), date="2026-11-02")
        out = ivo.http_get("/api/inventoria/spending", {"month": ["2026-11"]})[1]
        self.assertEqual((out["total_cents"], out["months"], out["by_category"]), (700, ["2026-11"], {"frais": 700}))
        self.assertEqual(ivo.http_get("/api/inventoria/spending", {"month": ["nope"]})[0], 400)

    def test_recipes_list_and_cook_check_by_id(self) -> None:
        st = store.open_store(self.root)
        try:
            hh = fin.ensure_default_household(st.conn, create=True)
            with st.transaction():
                r = hq_meals.create_recipe(st.conn, hh, {"title": "Riz au lait", "servings": 2, "leftover_policy": "none", "steps": ["cuire"],
                                                         "ingredients": [{"name": "Lait", "qty_milli": 1_000_000, "unit": "ml"}]})
        finally:
            st.close()
        self.assertEqual(ivo.http_get("/api/inventoria/recipes")[1]["items"][0]["title"], "Riz au lait")
        code, out = ivo.http_post("/api/inventoria/cook-check", {"recipe_id": r["id"], "servings": 4})
        self.assertEqual((code, out["ok"], out["servings"]), (200, True, 4))
        self.assertEqual(out["rows"][0]["need_in_item_unit"], 2.0)             # 2 L for 4 people, from 5 L in stock
        self.assertEqual(ivo.http_post("/api/inventoria/cook-check", {"recipe_id": "rcp-000000000000"})[0], 404)
        self.assertEqual(ivo.http_post("/api/inventoria/cook-check", {})[0], 400)


class StatusBarcodesTests(_Base):
    def test_status_lists_every_linked_code_with_its_item(self) -> None:
        habits.link_barcode(self.root, "111122223333", self.ids["Lait"])
        rows = ivo.status()["barcodes"]
        self.assertEqual([(b["code"], b["item_name"]) for b in rows], [("111122223333", "Lait")])
        self.assertTrue(ivo.http_post("/api/inventoria/barcode", {"action": "unlink", "code": "111122223333"})[1]["removed"])
        self.assertEqual(ivo.status()["barcodes"], [])


class DuplicateSafeRetryTests(_Base):
    def test_a_retried_quick_request_lands_once(self) -> None:
        body = {"session_id": self.sid, "item_id": self.ids["Lait"], "delta": -1, "client_id": "cid-0000000001"}
        code, first = ivo.http_post("/api/inventoria/quick", body)
        self.assertEqual((code, len(first["applied"]), self.qty("Lait")), (200, 1, 4))
        code, again = ivo.http_post("/api/inventoria/quick", body)
        self.assertEqual((code, again["duplicate"], self.qty("Lait")), (200, True, 4))
        self.assertEqual(again["applied"][0]["operation_id"], first["applied"][0]["operation_id"])

    def test_without_a_valid_client_id_nothing_is_deduplicated(self) -> None:
        for cid in (None, "short", "bad id with spaces!"):
            body = {"session_id": self.sid, "item_id": self.ids["Lait"], "delta": -1}
            if cid:
                body["client_id"] = cid
            ivo.http_post("/api/inventoria/quick", body)
        self.assertEqual(self.qty("Lait"), 2)

    def test_purchased_and_cooked_are_protected_too(self) -> None:
        body = {"session_id": self.sid, "items": [{"id": self.ids["Lait"], "qty": 2}], "client_id": "cid-purchased-1"}
        ivo.http_post("/api/inventoria/purchased", body)
        self.assertTrue(ivo.http_post("/api/inventoria/purchased", body)[1]["duplicate"])
        self.assertEqual(self.qty("Lait"), 7)

    def test_an_unreadable_seen_file_is_preserved(self) -> None:
        p = self.root / ".hq-inventoria" / "seen.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("{broken", encoding="utf-8")
        ivo.http_post("/api/inventoria/quick", {"session_id": self.sid, "item_id": self.ids["Lait"], "delta": -1, "client_id": "cid-0000000002"})
        self.assertEqual(p.read_text(encoding="utf-8"), "{broken")
        self.assertEqual(self.qty("Lait"), 4)                                   # the change still applied; only the memory was skipped

    def test_old_entries_expire_and_the_file_stays_bounded(self) -> None:
        dedupe.remember(self.root, "cid-old-00001", {"applied": []}, now=1000.0)
        self.assertIsNone(dedupe.seen(self.root, "cid-old-00001", now=1000.0 + dedupe.TTL + 5))
        for i in range(dedupe.MAX_ENTRIES + 20):
            dedupe.remember(self.root, f"cid-fill-{i:06d}", {"applied": []}, now=2000.0 + i)
        data = json.loads((self.root / ".hq-inventoria" / "seen.json").read_text(encoding="utf-8"))
        self.assertLessEqual(len(data), dedupe.MAX_ENTRIES)


if __name__ == "__main__":
    unittest.main()
