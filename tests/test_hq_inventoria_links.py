"""What accurate stock makes possible: where-is, parts/recipes, cooked meals, prices, use-soon dates, spot-checks, filament."""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_ai as iai
import hq_inventoria_links as links
import hq_inventoria_notify as notify
import hq_inventory as inv
import hq_meals


class _Base(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-links-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        hq_meals.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0, llm_adapter=lambda text, session_id=None: {"reply": "ok"})
        inv.apply({"action": "place.create", "name": "Atelier", "kind": "shelf"})
        inv.apply({"action": "place.create", "name": "Garde-manger", "kind": "shelf"})
        places = {p["name"]: p for p in inv.snapshot()["places"]}
        self.atelier, self.pantry = places["Atelier"]["id"], places["Garde-manger"]["id"]
        self.atelier_code = places["Atelier"]["code"]
        inv.apply({"action": "item.create", "name": "Vis M3", "qty": 40, "unit": "pcs", "place": self.atelier, "tags": ["visserie"]})
        inv.apply({"action": "item.create", "name": "Riz", "qty": 2, "unit": "kg", "place": self.pantry, "tags": ["épicerie"]})
        inv.apply({"action": "item.create", "name": "Lait", "qty": 2000, "unit": "ml", "place": self.pantry})
        inv.apply({"action": "item.create", "name": "Filament PLA", "qty": 1000, "unit": "g", "place": self.atelier})
        self.ids = {i["name"]: i["id"] for i in inv.snapshot()["items"]}
        self.sid = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})[1]["session"]["id"]

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def qty(self, name: str) -> float:
        return next(i["qty"] for i in inv.snapshot()["items"] if i["name"] == name)


class WhereAndPartsTests(_Base):
    def test_where_is_answers_with_the_shelf_without_a_model_call(self) -> None:
        code, out = ivo.http_post("/api/inventoria/where", {"q": "vis m3"})
        self.assertEqual(code, 200, out)
        top = out["matches"][0]
        self.assertEqual((top["name"], top["where"], top["qty"]), ("Vis M3", "Atelier", 40))
        self.assertEqual(ivo.http_post("/api/inventoria/where", {"q": "zzzz"})[1]["matches"], [])
        self.assertEqual(ivo.http_post("/api/inventoria/where", {"q": ""})[0], 400)

    def test_parts_check_converts_units_and_flags_shortfalls(self) -> None:
        code, out = ivo.http_post("/api/inventoria/parts", {"parts": [
            {"name": "Vis M3", "qty": 12}, {"name": "riz", "qty": 500, "unit": "g"},
            {"name": "Lait", "qty": 3, "unit": "L"}, {"name": "Écrous M5", "qty": 4}, {"name": "Lait", "qty": 1, "unit": "rouleaux"}]})
        self.assertEqual(code, 200, out)
        status = [r["status"] for r in out["rows"]]
        self.assertEqual(status, ["have", "have", "short", "missing", "unit_mismatch"])
        self.assertEqual(out["rows"][1]["need_in_item_unit"], 0.5)
        self.assertEqual(out["rows"][2]["missing"], 1000.0)
        self.assertFalse(out["ok"])


class MealTests(_Base):
    def _recipe(self) -> dict:
        st = store.open_store(self.root)
        try:
            hh = fin.ensure_default_household(st.conn, create=True)
            with st.transaction():
                r = hq_meals.create_recipe(st.conn, hh, {
                    "title": "Riz au lait", "servings": 2, "leftover_policy": "none", "steps": ["cuire"],
                    "ingredients": [{"name": "Riz", "qty_milli": 300_000, "unit": "g"},
                                    {"name": "Lait", "qty_milli": 1_000_000, "unit": "ml"},
                                    {"name": "Cannelle", "qty_milli": 1_000, "unit": "g", "optional": True}]})
            return r
        finally:
            st.close()

    def test_can_i_cook_it_reads_the_saved_recipe(self) -> None:
        self._recipe()
        st = store.open_store(self.root, readonly=True)
        try:
            hh = fin.ensure_default_household(st.conn, create=False)
            res = links.cook_check(inv.snapshot(), st.conn, hh, "riz au lait", None, self.root)
        finally:
            st.close()
        self.assertTrue(res["found"])
        self.assertTrue(res["ok"])                       # cinnamon is optional
        self.assertEqual([r["status"] for r in res["rows"]][:2], ["have", "have"])

    def test_cooked_route_removes_the_ingredients_with_undo(self) -> None:
        r = self._recipe()
        code, out = ivo.http_post("/api/inventoria/cooked", {"session_id": self.sid, "recipe_id": r["id"]})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.qty("Lait"), 1000)        # 1000 ml used
        self.assertEqual(self.qty("Riz"), 2)            # 0.3 kg rounds to 0 whole kg: skipped, and said so
        self.assertTrue(any("Riz" == s["name"] for s in out["skipped"]))
        self.assertEqual(len(out["applied"]), 1)
        self.assertEqual(ivo.http_post("/api/inventoria/cooked", {"session_id": self.sid, "recipe": "pizza"})[0], 404)


class PriceTests(_Base):
    def test_receipt_prices_give_history_cheapest_store_and_spending(self) -> None:
        tb = iai.Toolbox()
        res = tb.run("record_prices", {"store": "Maxi", "date": "2026-11-02", "lines": [
            {"item_id": self.ids["Riz"], "item_name": "Riz", "qty": 2, "total_cents": 600},
            {"item_name": "Inconnu", "qty": 1, "total_cents": 100}]})
        self.assertEqual((res["saved"], tb.side_effects), (True, 1))
        tb.run("record_prices", {"store": "Maxi", "date": "2026-11-02", "lines": [
            {"item_id": self.ids["Riz"], "item_name": "Riz", "qty": 2, "total_cents": 600}]})        # same receipt twice: no double
        links.record_prices(self.root, "IGA", [{"item_id": self.ids["Riz"], "qty": 1, "total_cents": 420}], inv.snapshot(), date="2026-11-09")
        info = links.price_info(self.root, self.ids["Riz"])
        self.assertEqual(info["count"], 2)
        self.assertEqual(info["cheapest"]["store"], "Maxi")    # 300 c/kg vs 420 c/kg
        sp = links.spending(self.root, inv.snapshot(), "2026-11")
        self.assertEqual(sp["total_cents"], 1020)
        self.assertEqual(sp["by_category"], {"épicerie": 1020})
        self.assertEqual(sp["by_store"]["Maxi"], 600)


class UseSoonTests(_Base):
    def test_expiry_dates_feed_the_use_soon_list_status_and_digest(self) -> None:
        today = time.strftime("%Y-%m-%d")
        soon = time.strftime("%Y-%m-%d", time.localtime(time.time() + 2 * 86400))
        later = time.strftime("%Y-%m-%d", time.localtime(time.time() + 30 * 86400))
        self.assertEqual(ivo.http_post("/api/inventoria/expiry", {"item_id": self.ids["Lait"], "date": soon})[0], 200)
        ivo.http_post("/api/inventoria/expiry", {"item_id": self.ids["Riz"], "date": later})
        self.assertEqual(ivo.http_post("/api/inventoria/expiry", {"item_id": self.ids["Riz"], "date": "31/12"})[0], 400)
        rows = links.use_soon(self.root, inv.snapshot())
        self.assertEqual([r["name"] for r in rows], ["Lait"])
        self.assertEqual(rows[0]["days_left"], 2)
        self.assertEqual([r["name"] for r in ivo.status()["use_soon"]], ["Lait"])
        self.assertIn("Lait", notify._use_soon_line(self.root, inv.snapshot(), "fr", time.time()))
        inv.apply({"action": "item.adjust", "id": self.ids["Lait"], "delta": -2000})
        self.assertEqual(links.use_soon(self.root, inv.snapshot()), [])        # nothing left: nothing to use
        self.assertTrue(today)

    def test_the_model_sets_a_date_only_through_its_tool(self) -> None:
        tb = iai.Toolbox()
        res = tb.run("set_expiry", {"item_id": self.ids["Lait"], "item_name": "Lait", "date": "2030-01-05"})
        self.assertTrue(res["saved"])
        self.assertEqual(tb.side_effects, 1)


class SpotCheckTests(_Base):
    def test_a_photo_count_logs_drift_and_moves_the_weekly_check(self) -> None:
        first = links.spot_check(self.root, inv.snapshot(), now=1_000_000.0)
        self.assertIsNotNone(first)
        self.assertIsNone(first["days_since"])
        code, out = ivo.http_post("/api/inventoria/detections", {"session_id": self.sid, "mode": "count", "rows": [
            {"item_id": self.ids["Vis M3"], "name": "Vis M3", "qty": 31},
            {"item_id": self.ids["Filament PLA"], "name": "Filament PLA", "qty": 1000}]})
        self.assertEqual(code, 200, out)
        acc = links.accuracy(self.root)
        self.assertEqual((acc["checked"], acc["accurate_pct"]), (2, 50))      # 40 recorded vs 31 counted is off; the filament was right
        nxt = links.spot_check(self.root, inv.snapshot())
        self.assertEqual(nxt["name"], "Garde-manger")                          # the shelf just counted is not asked again this week
        self.assertEqual(ivo.status()["accuracy"]["checked"], 2)


class FilamentTests(_Base):
    def _history(self, jobs: list[dict]) -> None:
        p = self.root / ".hq-print3d" / "history.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"jobs": jobs}), encoding="utf-8")

    def test_finished_prints_after_the_link_subtract_their_grams_once(self) -> None:
        self.assertEqual(ivo.http_post("/api/inventoria/filament", {"material": "pla", "item_id": self.ids["Vis M3"]})[0], 400)
        code, out = ivo.http_post("/api/inventoria/filament", {"material": "pla", "item_id": self.ids["Filament PLA"]})
        self.assertEqual(code, 200, out)
        since = links._load(self.root)["filament"]["PLA"]["since"]
        self._history([
            {"id": "old1", "at": since - 100, "outcome": "finished", "job": "avant", "filament": {"by_material": {"PLA": {"g": 50}}}},
            {"id": "new1", "at": since + 10, "outcome": "finished", "job": "support", "filament": {"by_material": {"PLA": {"g": 42.6}}}},
            {"id": "new2", "at": since + 20, "outcome": "failed", "job": "raté", "filament": {"by_material": {"PLA": {"g": 9}}}},
        ])
        events = links.sync_filament(self.root, inv.snapshot(), inv.apply, now=since + 30)
        self.assertEqual([e["delta"] for e in events], [-43])
        self.assertEqual(self.qty("Filament PLA"), 957)
        self.assertEqual(links.sync_filament(self.root, inv.snapshot(), inv.apply), [])   # applied once
        self.assertEqual(self.qty("Filament PLA"), 957)
        st = ivo.status()
        self.assertEqual(st["filament"][0]["material"], "PLA")
        self.assertEqual(st["events"][-1]["job"], "support")

    def test_without_a_link_nothing_is_subtracted(self) -> None:
        self._history([{"id": "j", "at": 10**10, "outcome": "finished", "filament": {"by_material": {"PLA": {"g": 50}}}}])
        self.assertEqual(links.sync_filament(self.root, inv.snapshot(), inv.apply), [])
        self.assertEqual(self.qty("Filament PLA"), 1000)


class DigestTests(_Base):
    def setUp(self) -> None:
        super().setUp()
        import hq_inventoria_feel as feel
        feel.asks_set(self.root, quiet_start=0, quiet_end=0)

    def test_the_morning_digest_groups_by_store_and_opens_the_shop_tab(self) -> None:
        import hq_inventoria_stores as stores
        notify.save_settings(self.root, enabled=True, instant=False, digest_hour=0, inv=inv.snapshot())
        inv.apply({"action": "item.update", "id": self.ids["Riz"], "rev": next(i["rev"] for i in inv.snapshot()["items"] if i["id"] == self.ids["Riz"]), "min": 5})
        stores.set_store(self.root, self.ids["Riz"], "Maxi")
        sent = []
        notify.tick(self.root, lambda t, b, *, url="/", actions=None: sent.append((t, b, url)), inv=inv.snapshot(), now=time.time())
        (title, body, url) = sent[-1]
        self.assertEqual(url, "/#inventoria-shop")
        self.assertIn("Maxi", body)


class ClientTests(unittest.TestCase):
    JS = (Path(__file__).resolve().parent.parent / "assets" / "hq-inventoria-chip.js").read_text(encoding="utf-8")

    def test_chip_wires_where_insights_and_store_groups(self) -> None:
        for needle in ("/api/inventoria/where", "const WHERE_RE", "renderInsights(r.data)", "hq-inventoria-check-store",
                       "if (!cb || !qty) return;", '"/api/carnet/asset/" + encodeURIComponent(top.photo)', "#inventoria-(say|place|low|open|shop)"):
            self.assertIn(needle, self.JS)


if __name__ == "__main__":
    unittest.main()
