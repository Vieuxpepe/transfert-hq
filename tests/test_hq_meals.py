"""Meals — recipes, plans, build-list preview/commit."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_finances as fin
import hq_grocery as gr
import hq_household_store as store
import hq_meals as meals


def _setup(root: Path) -> None:
    store.set_acl_for_tests(False)
    fin.bind(root=root, actor=lambda: "tester", now=lambda: 1_900_000_100.0)
    gr.bind(root=root, actor=lambda: "tester", now=lambda: 1_900_000_100.0, inventory_snapshot=lambda: {"version": 1, "rev": 1, "items": [], "places": []})
    meals.bind(root=root, actor=lambda: "tester", now=lambda: 1_900_000_100.0)


class MealsDomainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-meals-")
        self.root = Path(self.tmp.name)
        _setup(self.root)
        with store.open_store(self.root) as st:
            with st.transaction():
                self.hid = fin.ensure_default_household(st.conn)

    def tearDown(self) -> None:
        meals.reset_for_tests()
        gr.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _product(self, **kw) -> dict:
        code, out = gr.http_post("/api/grocery/products", {"name": "Rice", "canonical_unit": "g", "default_qty_milli": 1000, **kw})
        self.assertEqual(code, 200, out)
        return out["product"]

    def _recipe(self, **kw) -> dict:
        body = {
            "title": "Rice bowl",
            "servings": 2,
            "ingredients": [{"name": "Rice", "qty_milli": 200_000, "unit": "g"}],
            "steps": ["Cook rice"],
            "leftover_policy": "none",
            **kw,
        }
        code, out = meals.http_post("/api/meals/recipes", body)
        self.assertEqual(code, 200, out)
        return out["recipe"]

    def test_recipe_crud_and_list(self) -> None:
        r = self._recipe()
        code, page = meals.http_get("/api/meals/recipes", {"id": r["id"]})
        self.assertEqual(code, 200)
        self.assertEqual(page["items"][0]["id"], r["id"])
        code, out = meals.http_post("/api/meals/recipes", {"id": r["id"], "rev": r["rev"], "title": "Rice bowl v2"})
        self.assertEqual(code, 200)
        self.assertEqual(out["recipe"]["title"], "Rice bowl v2")
        self.assertEqual(out["recipe"]["rev"], 2)

    def test_recipe_linked_product_unit_mismatch(self) -> None:
        p = self._product()
        code, body = meals.http_post(
            "/api/meals/recipes",
            {
                "title": "Bad",
                "servings": 1,
                "ingredients": [{"product_id": p["id"], "name": "Rice", "qty_milli": 1, "unit": "ml"}],
                "steps": ["x"],
                "leftover_policy": "none",
            },
        )
        self.assertEqual(code, 400, body)

    def test_recipe_rev_conflict(self) -> None:
        r = self._recipe()
        code, body = meals.http_post("/api/meals/recipes", {"id": r["id"], "rev": 99, "title": "Stale"})
        self.assertEqual(code, 409, body)
        self.assertEqual(body["code"], "conflict")

    def test_plan_week_aggregate_build(self) -> None:
        r = self._recipe(ingredients=[{"name": "Rice", "qty_milli": 200_000, "unit": "g"}])
        code, out = meals.http_post(
            "/api/meals/plans",
            {
                "period_start": "2026-11-16",
                "period_end": "2026-11-18",
                "slots": [
                    {"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]},
                    {"date": "2026-11-17", "meal": "dinner", "recipe_id": r["id"]},
                    {"date": "2026-11-18", "meal": "lunch", "recipe_id": r["id"]},
                ],
            },
        )
        self.assertEqual(code, 200, out)
        plan = out["meal_plan"]
        with store.open_store(self.root, readonly=True) as st:
            before = int(st.conn.execute("SELECT COUNT(*) FROM grocery_lists").fetchone()[0])
        code, prev = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})
        self.assertEqual(code, 200, prev)
        self.assertTrue(prev.get("preview"))
        self.assertEqual(len(prev["lines"]), 1)
        self.assertEqual(prev["lines"][0]["qty_milli"], 600_000)
        with store.open_store(self.root, readonly=True) as st:
            after = int(st.conn.execute("SELECT COUNT(*) FROM grocery_lists").fetchone()[0])
        self.assertEqual(before, after)

    def test_unlinked_merge_by_normalized_name(self) -> None:
        r1 = self._recipe(
            title="A",
            ingredients=[{"name": "  Brown   Rice ", "qty_milli": 100_000, "unit": "g"}],
        )
        r2 = self._recipe(
            title="B",
            ingredients=[{"name": "brown rice", "qty_milli": 150_000, "unit": "g"}],
        )
        code, out = meals.http_post(
            "/api/meals/plans",
            {
                "period_start": "2026-11-16",
                "period_end": "2026-11-16",
                "slots": [
                    {"date": "2026-11-16", "meal": "lunch", "recipe_id": r1["id"]},
                    {"date": "2026-11-16", "meal": "dinner", "recipe_id": r2["id"]},
                ],
            },
        )
        plan = out["meal_plan"]
        code, prev = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})
        self.assertEqual(code, 200)
        self.assertEqual(prev["lines"][0]["qty_milli"], 250_000)

    def test_distinct_products_not_merged_by_name(self) -> None:
        p1 = self._product(name="Rice A")
        p2 = self._product(name="Rice B")
        r = self._recipe(
            ingredients=[
                {"product_id": p1["id"], "name": "Rice A", "qty_milli": 100_000, "unit": "g"},
                {"product_id": p2["id"], "name": "Rice B", "qty_milli": 100_000, "unit": "g"},
            ],
        )
        code, out = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )
        plan = out["meal_plan"]
        code, prev = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})
        self.assertEqual(len(prev["lines"]), 2)

    def test_stock_subtract_once(self) -> None:
        p = self._product()
        r = self._recipe(ingredients=[{"product_id": p["id"], "name": "Rice", "qty_milli": 300_000, "unit": "g"}])
        with store.open_store(self.root) as st:
            with st.transaction():
                gr.create_lot(st.conn, self.hid, {"product_id": p["id"], "qty_milli": 500_000, "usable_qty_milli": 500_000, "canonical_unit": "g"})
        code, out = meals.http_post(
            "/api/meals/plans",
            {
                "period_start": "2026-11-16",
                "period_end": "2026-11-17",
                "slots": [
                    {"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]},
                    {"date": "2026-11-17", "meal": "dinner", "recipe_id": r["id"]},
                ],
            },
        )
        plan = out["meal_plan"]
        code, prev = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "preview", "subtract_available_stock": True},
        )
        self.assertEqual(code, 200)
        self.assertEqual(prev["lines"][0]["qty_milli"], 100_000)

    def test_expired_lot_excluded_from_stock(self) -> None:
        p = self._product()
        r = self._recipe(ingredients=[{"product_id": p["id"], "name": "Rice", "qty_milli": 200_000, "unit": "g"}])
        with store.open_store(self.root) as st:
            with st.transaction():
                gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": p["id"], "qty_milli": 500_000, "usable_qty_milli": 500_000, "canonical_unit": "g", "expires_on": "2020-01-01"},
                )
        code, out = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )
        plan = out["meal_plan"]
        code, prev = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "preview", "subtract_available_stock": True},
        )
        self.assertEqual(prev["lines"][0]["qty_milli"], 200_000)

    def test_commit_idempotent(self) -> None:
        r = self._recipe()
        code, out = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )
        plan = out["meal_plan"]
        code, prev = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})
        digest = prev["preview_digest"]
        body = {"mode": "commit", "preview_digest": digest, "idempotency_key": "build-rice-001"}
        code, c1 = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", body)
        self.assertEqual(code, 200, c1)
        code, c2 = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", body)
        self.assertEqual(code, 200, c2)
        self.assertEqual(c1["grocery_list"]["id"], c2["grocery_list"]["id"])
        with store.open_store(self.root, readonly=True) as st:
            n = int(st.conn.execute("SELECT COUNT(*) FROM grocery_lists").fetchone()[0])
        self.assertEqual(n, 1)

    def test_commit_stale_digest(self) -> None:
        r = self._recipe()
        code, out = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )
        plan = out["meal_plan"]
        code, prev = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})
        digest = prev["preview_digest"]
        meals.http_post("/api/meals/recipes", {"id": r["id"], "rev": r["rev"], "title": "Changed"})
        code, body = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "commit", "preview_digest": digest, "idempotency_key": "build-stale-001"},
        )
        self.assertEqual(code, 409, body)

    def test_committed_list_unchanged_when_recipe_edited(self) -> None:
        r = self._recipe(ingredients=[{"name": "Rice", "qty_milli": 100_000, "unit": "g"}])
        code, out = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )
        plan = out["meal_plan"]
        prev = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})[1]
        commit = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "commit", "preview_digest": prev["preview_digest"], "idempotency_key": "snap-001"},
        )[1]
        lid = commit["grocery_list"]["id"]
        meals.http_post(
            "/api/meals/recipes",
            {"id": r["id"], "rev": r["rev"], "ingredients": [{"name": "Rice", "qty_milli": 9_999_000, "unit": "g"}]},
        )
        page = gr.http_get("/api/grocery/lists", {"id": lid})[1]
        self.assertEqual(page["items"][0]["lines"][0]["qty_milli"], 100_000)

    def test_build_product_unit_change_after_recipe_no_lots(self) -> None:
        p = self._product()
        r = self._recipe(ingredients=[{"product_id": p["id"], "name": "Rice", "qty_milli": 100_000, "unit": "g"}])
        with store.open_store(self.root) as st:
            with st.transaction():
                gr.update_product(
                    st.conn, self.hid,
                    {"id": p["id"], "rev": p["rev"], "canonical_unit": "ml"},
                )
        plan = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )[1]["meal_plan"]
        code, body = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})
        self.assertEqual(code, 400, body)

    def test_aggregate_integer_overflow(self) -> None:
        big = meals.SQLITE_INT_MAX
        r = self._recipe(
            ingredients=[
                {"name": "Rice", "qty_milli": big // 2 + 1, "unit": "g"},
                {"name": "rice", "qty_milli": big // 2 + 1, "unit": "g"},
            ],
        )
        plan = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )[1]["meal_plan"]
        code, body = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})
        self.assertEqual(code, 400, body)

    def test_stock_lot_change_same_total_stale_commit(self) -> None:
        p = self._product()
        r = self._recipe(ingredients=[{"product_id": p["id"], "name": "Rice", "qty_milli": 300_000, "unit": "g"}])
        with store.open_store(self.root) as st:
            with st.transaction():
                a = gr.create_lot(st.conn, self.hid, {"product_id": p["id"], "qty_milli": 200_000, "usable_qty_milli": 200_000, "canonical_unit": "g"})
            lot_a = a["id"]
        plan = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )[1]["meal_plan"]
        digest = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "preview", "subtract_available_stock": True},
        )[1]["preview_digest"]
        with store.open_store(self.root) as st:
            with st.transaction():
                row = gr.create_lot(st.conn, self.hid, {"product_id": p["id"], "qty_milli": 200_000, "usable_qty_milli": 200_000, "canonical_unit": "g"})
                gr.update_lot(
                    st.conn, self.hid,
                    {"id": lot_a, "rev": a["rev"], "qty_milli": 0, "usable_qty_milli": 0, "canonical_unit": "g"},
                )
                lot_b = row["id"]
        code, body = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "commit", "preview_digest": digest, "subtract_available_stock": True, "idempotency_key": "lot-shift-001"},
        )
        self.assertEqual(code, 409, body)

    def test_preview_no_db_on_empty_root(self) -> None:
        empty = Path(self.tmp.name) / "empty-preview"
        empty.mkdir()
        meals.bind(root=empty, actor=lambda: "t", now=lambda: 1.9e9)
        fin.bind(root=empty, actor=lambda: "t", now=lambda: 1.0)
        code, body = meals.http_post("/api/meals/plans/mpl-0000000000000001/build-list", {"mode": "preview"})
        self.assertIn(code, (404, 503), body)
        self.assertFalse(store.household_dir(empty).exists())
        _setup(self.root)

    def test_preview_refuses_v4_without_migrating(self) -> None:
        sub = Path(self.tmp.name) / "v4-only"
        sub.mkdir()
        store.set_acl_for_tests(False)
        fin.bind(root=sub, actor=lambda: "t", now=lambda: 1.0)
        meals.bind(root=sub, actor=lambda: "t", now=lambda: 1.9e9)
        base = store.prepare_household_dirs(sub)
        path = base / store.DB_NAME
        conn = sqlite3.connect(str(path))
        try:
            for fn in (store._apply_v1, store._apply_v2, store._apply_v3, store._apply_v4):
                fn(conn)
            conn.commit()
        finally:
            conn.close()
        ver_before = int(sqlite3.connect(str(path)).execute("PRAGMA user_version").fetchone()[0])
        code, _body = meals.http_post("/api/meals/plans/mpl-0000000000000001/build-list", {"mode": "preview"})
        self.assertNotEqual(code, 200)
        ver_after = int(sqlite3.connect(str(path)).execute("PRAGMA user_version").fetchone()[0])
        self.assertEqual(ver_before, ver_after)
        self.assertEqual(ver_before, 4)
        _setup(self.root)

    def test_idempotency_same_key_different_body(self) -> None:
        r = self._recipe()
        plan = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )[1]["meal_plan"]
        d1 = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})[1]["preview_digest"]
        meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "commit", "preview_digest": d1, "idempotency_key": "idem-body-a"},
        )
        d2 = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})[1]["preview_digest"]
        code, body = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "commit", "preview_digest": d2, "idempotency_key": "idem-body-a", "subtract_available_stock": True},
        )
        self.assertEqual(code, 409, body)

    def test_commit_replay_after_recipe_change_returns_original(self) -> None:
        r = self._recipe()
        plan = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )[1]["meal_plan"]
        digest = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})[1]["preview_digest"]
        body = {"mode": "commit", "preview_digest": digest, "idempotency_key": "replay-after-src"}
        first = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", body)[1]
        meals.http_post("/api/meals/recipes", {"id": r["id"], "rev": r["rev"], "title": "Mutated"})
        second = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", body)[1]
        self.assertEqual(first["grocery_list"]["id"], second["grocery_list"]["id"])

    def test_commit_injected_failure_no_partial_list(self) -> None:
        r = self._recipe()
        plan = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )[1]["meal_plan"]
        digest = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})[1]["preview_digest"]
        with store.open_store(self.root, readonly=True) as st:
            before = int(st.conn.execute("SELECT COUNT(*) FROM grocery_lists").fetchone()[0])
            before_idem = int(st.conn.execute("SELECT COUNT(*) FROM grocery_list_build_idempotency").fetchone()[0])
        with mock.patch("hq_grocery.create_grocery_list", side_effect=RuntimeError("inject")):
            with store.open_store(self.root) as st:
                with self.assertRaises(RuntimeError):
                    with st.transaction():
                        meals.build_list_commit(
                            st.conn, self.hid, plan["id"],
                            {"mode": "commit", "preview_digest": digest, "idempotency_key": "inject-fail"},
                        )
        with store.open_store(self.root, readonly=True) as st:
            self.assertEqual(int(st.conn.execute("SELECT COUNT(*) FROM grocery_lists").fetchone()[0]), before)
            self.assertEqual(int(st.conn.execute("SELECT COUNT(*) FROM grocery_list_build_idempotency").fetchone()[0]), before_idem)

    def test_unknown_ingredient_field(self) -> None:
        code, body = meals.http_post(
            "/api/meals/recipes",
            {
                "title": "x",
                "servings": 1,
                "ingredients": [{"name": "a", "qty_milli": 1, "unit": "g", "extra": 1}],
                "steps": ["s"],
                "leftover_policy": "none",
            },
        )
        self.assertEqual(code, 400, body)

    def test_subtract_bool_rejects_string(self) -> None:
        r = self._recipe()
        plan = meals.http_post(
            "/api/meals/plans",
            {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
        )[1]["meal_plan"]
        code, body = meals.http_post(
            f"/api/meals/plans/{plan['id']}/build-list",
            {"mode": "preview", "subtract_available_stock": "yes"},
        )
        self.assertEqual(code, 400, body)

    def test_grocery_list_rev_conflict(self) -> None:
        lst = gr.http_post(
            "/api/grocery/lists",
            {"status": "open", "lines": [{"name": "Salt", "qty_milli": 1, "unit": "g"}]},
        )[1]["grocery_list"]
        code, body = gr.http_post("/api/grocery/lists", {"id": lst["id"], "rev": 99, "status": "open", "lines": lst["lines"]})
        self.assertEqual(code, 409, body)

    def test_no_inventory_apply_on_build(self) -> None:
        with mock.patch("hq_inventory.apply") as m_apply:
            r = self._recipe()
            plan = meals.http_post(
                "/api/meals/plans",
                {"period_start": "2026-11-16", "period_end": "2026-11-16", "slots": [{"date": "2026-11-16", "meal": "dinner", "recipe_id": r["id"]}]},
            )[1]["meal_plan"]
            prev = meals.http_post(f"/api/meals/plans/{plan['id']}/build-list", {"mode": "preview"})[1]
            meals.http_post(
                f"/api/meals/plans/{plan['id']}/build-list",
                {"mode": "commit", "preview_digest": prev["preview_digest"], "idempotency_key": "no-inv-001"},
            )
            m_apply.assert_not_called()


if __name__ == "__main__":
    unittest.main()
