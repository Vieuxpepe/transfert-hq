"""Household grocery core — products, food lots, merchants, Inventoria read-only links."""

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


def _setup(root: Path) -> None:
    store.set_acl_for_tests(False)
    fin.bind(root=root, actor=lambda: "tester", now=lambda: 1_900_000_000.0)
    gr.bind(root=root, actor=lambda: "tester", now=lambda: 1_900_000_000.0)


class GroceryDomainTests(unittest.TestCase):
    ITEM = "itm-aaaaaaaaaaaaaaaa"
    PLACE = "plc-bbbbbbbbbbbbbbbb"
    SNAPSHOT = {
        "version": 1,
        "rev": 1,
        "items": [{"id": ITEM, "place": None, "name": "Milk", "qty": 1, "unit": "pcs", "rev": 1}],
        "places": [{"id": PLACE, "parent": None, "name": "Fridge", "kind": "other", "code": "ABCD", "rev": 1}],
    }

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-gro-")
        self.root = Path(self.tmp.name)
        _setup(self.root)
        gr.bind(inventory_snapshot=lambda: dict(self.SNAPSHOT))
        with store.open_store(self.root) as st:
            with st.transaction():
                self.hid = fin.ensure_default_household(st.conn)

    def tearDown(self) -> None:
        gr.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _product(self, **kw) -> dict:
        body = {
            "name": "Milk",
            "canonical_unit": "ml",
            "default_qty_milli": 1_000_000,
            **kw,
        }
        code, out = gr.http_post("/api/grocery/products", body)
        self.assertEqual(code, 200, out)
        return out["product"]

    def test_import_creates_nothing(self) -> None:
        root = Path(self.tmp.name) / "empty-child"
        self.assertFalse(store.household_dir(root).exists())

    def test_product_create_search_barcode_leading_zeros(self) -> None:
        p = self._product(barcode=" 000123456789012 ")
        with store.open_store(self.root, readonly=True) as st:
            page = gr.list_products(st.conn, self.hid, {"barcode": "000123456789012"})
        self.assertEqual(len(page["items"]), 1)
        self.assertEqual(page["items"][0]["id"], p["id"])
        self.assertEqual(page["items"][0]["barcode"], "000123456789012")

    def test_duplicate_barcode_conflict(self) -> None:
        self._product(barcode="042000012345")
        code, body = gr.http_post(
            "/api/grocery/products",
            {"name": "Other", "canonical_unit": "each", "default_qty_milli": 1000, "barcode": "042000012345"},
        )
        self.assertEqual(code, 409, body)

    def test_two_milk_lots_separate_expiry_and_sum(self) -> None:
        prod = self._product()
        with store.open_store(self.root) as st:
            with st.transaction():
                a = gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": prod["id"], "qty_milli": 1_000_000, "canonical_unit": "ml", "expires_on": "2026-10-01"},
                )
                b = gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": prod["id"], "qty_milli": 2_000_000, "usable_qty_milli": 1_500_000,
                     "canonical_unit": "ml", "expires_on": "2026-10-08"},
                )
            lots = gr.list_lots(st.conn, self.hid, {"product_id": prod["id"]})
        self.assertEqual(len(lots["items"]), 2)
        self.assertNotEqual(a["expires_on"], b["expires_on"])
        self.assertEqual(lots["total_usable_qty_milli"], 1_000_000 + 1_500_000)

    def test_usable_gt_qty_refused(self) -> None:
        prod = self._product()
        with store.open_store(self.root) as st:
            with self.assertRaises(gr.GroceryError):
                with st.transaction():
                    gr.create_lot(
                        st.conn, self.hid,
                        {"product_id": prod["id"], "qty_milli": 100, "usable_qty_milli": 200, "canonical_unit": "ml"},
                    )

    def test_bad_qty_types_refused(self) -> None:
        prod = self._product()
        for bad in (1.5, True, -1):
            with self.subTest(bad=bad):
                with store.open_store(self.root) as st:
                    before = int(st.conn.execute("SELECT COUNT(*) FROM food_lots").fetchone()[0])
                    with self.assertRaises(gr.GroceryError):
                        with st.transaction():
                            gr.create_lot(
                                st.conn, self.hid,
                                {"product_id": prod["id"], "qty_milli": bad, "canonical_unit": "ml"},
                            )
                    self.assertEqual(int(st.conn.execute("SELECT COUNT(*) FROM food_lots").fetchone()[0]), before)

    def test_wrong_household_product_refused(self) -> None:
        other = Path(self.tmp.name) / "other"
        other.mkdir()
        fin.bind(root=other, actor=lambda: "x", now=lambda: 1.0)
        gr.bind(root=other, actor=lambda: "x", now=lambda: 1.0, inventory_snapshot=lambda: self.SNAPSHOT)
        with store.open_store(other) as st:
            with st.transaction():
                oh = fin.ensure_default_household(st.conn)
                op = gr.create_product(
                    st.conn, oh, {"name": "Remote", "canonical_unit": "g", "default_qty_milli": 1},
                )
        with store.open_store(self.root) as st:
            with self.assertRaises(gr.GroceryError):
                with st.transaction():
                    gr.create_lot(st.conn, self.hid, {"product_id": op["id"], "qty_milli": 1, "canonical_unit": "g"})
        gr.bind(root=self.root, actor=lambda: "tester", now=lambda: 1_900_000_000.0,
                inventory_snapshot=lambda: dict(self.SNAPSHOT))
        fin.bind(root=self.root, actor=lambda: "tester", now=lambda: 1_900_000_000.0)

    def test_rev_conflict(self) -> None:
        p = self._product()
        with store.open_store(self.root) as st:
            with st.transaction():
                with self.assertRaises(gr.GroceryError) as ctx:
                    gr.update_product(st.conn, self.hid, {"id": p["id"], "rev": 99, "name": "Stale"})
            self.assertEqual(ctx.exception.code, "conflict")

    def test_inventory_item_accepted(self) -> None:
        p = self._product(inventory_item_id=self.ITEM)
        self.assertEqual(p["inventory_item_id"], self.ITEM)
        with store.open_store(self.root) as st:
            with st.transaction():
                lot = gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": p["id"], "qty_milli": 500, "canonical_unit": "ml",
                     "item_id": self.ITEM, "place_id": self.PLACE},
                )
        self.assertEqual(lot["item_id"], self.ITEM)

    def test_inventory_unknown_ids(self) -> None:
        prod = self._product()
        for field, val in (("inventory_item_id", "itm-cccccccccccccccc"), ("item_id", "itm-dddddddddddddddd")):
            with self.subTest(field=field):
                if field == "inventory_item_id":
                    code, body = gr.http_post(
                        "/api/grocery/products",
                        {"name": "X", "canonical_unit": "g", "default_qty_milli": 1, field: val},
                    )
                else:
                    code, body = gr.http_post(
                        "/api/grocery/lots",
                        {"product_id": prod["id"], "qty_milli": 1, "canonical_unit": "ml", field: val},
                    )
                self.assertEqual(code, 404, body)

        code, body = gr.http_post(
            "/api/grocery/lots",
            {"product_id": prod["id"], "qty_milli": 1, "canonical_unit": "ml", "place_id": "plc-eeeeeeeeeeeeeeee"},
        )
        self.assertEqual(code, 404, body)

    def test_inventory_unavailable_no_partial_write(self) -> None:
        gr.bind(inventory_snapshot=lambda: (_ for _ in ()).throw(RuntimeError("down")))
        prod = self._product()
        with store.open_store(self.root) as st:
            before = int(st.conn.execute("SELECT COUNT(*) FROM food_lots").fetchone()[0])
            code, body = gr.http_post(
                "/api/grocery/lots",
                {"product_id": prod["id"], "qty_milli": 1, "canonical_unit": "ml", "item_id": self.ITEM},
            )
            self.assertEqual(code, 503, body)
            self.assertEqual(int(st.conn.execute("SELECT COUNT(*) FROM food_lots").fetchone()[0]), before)
        gr.bind(inventory_snapshot=lambda: dict(self.SNAPSHOT))

    def test_apply_never_called(self) -> None:
        prod = self._product()
        with mock.patch("hq_inventory.apply", side_effect=AssertionError("apply forbidden")):
            code, body = gr.http_post(
                "/api/grocery/lots",
                {"product_id": prod["id"], "qty_milli": 100, "canonical_unit": "ml"},
            )
            self.assertEqual(code, 200, body)

    def test_lot_update_does_not_touch_inventory(self) -> None:
        prod = self._product()
        with store.open_store(self.root) as st:
            with st.transaction():
                lot = gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": prod["id"], "qty_milli": 1000, "usable_qty_milli": 1000, "canonical_unit": "ml"},
                )
        snap_before = json.dumps(self.SNAPSHOT, sort_keys=True)
        with mock.patch("hq_inventory.apply", side_effect=AssertionError("apply forbidden")):
            code, body = gr.http_post(
                "/api/grocery/lots",
                {"id": lot["id"], "rev": lot["rev"], "product_id": prod["id"], "usable_qty_milli": 800,
                 "qty_milli": 1000, "canonical_unit": "ml"},
            )
            self.assertEqual(code, 200, body)
        snap_after = json.dumps(self.SNAPSHOT, sort_keys=True)
        self.assertEqual(snap_before, snap_after)

    def test_unresolved_link_lot_kept(self) -> None:
        prod = self._product()
        with store.open_store(self.root) as st:
            with st.transaction():
                lot = gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": prod["id"], "qty_milli": 100, "canonical_unit": "ml", "item_id": self.ITEM},
                )
        gr.bind(inventory_snapshot=lambda: {"version": 1, "rev": 2, "items": [], "places": []})
        with store.open_store(self.root, readonly=True) as st:
            out = gr.list_lots(st.conn, self.hid, {"product_id": prod["id"]})
        self.assertEqual(len(out["items"]), 1)
        self.assertFalse(out["items"][0].get("inventory_item_resolved", True))
        gr.bind(inventory_snapshot=lambda: dict(self.SNAPSHOT))

    def test_merchant_crud(self) -> None:
        code, body = gr.http_post("/api/grocery/merchants", {"name": "Metro"})
        self.assertEqual(code, 200, body)
        with store.open_store(self.root, readonly=True) as st:
            page = gr.list_merchants(st.conn, self.hid, {"q": "Met"})
        self.assertEqual(len(page["items"]), 1)

    def test_unknown_fields_and_malformed_json(self) -> None:
        code, body = gr.http_post("/api/grocery/products", {"name": "X", "canonical_unit": "g", "default_qty_milli": 1, "extra": 1})
        self.assertEqual(code, 400, body)
        code2, body2 = gr.http_post("/api/grocery/products", ["not", "object"])
        self.assertEqual(code2, 400, body2)

    def test_product_update_partial_rev(self) -> None:
        p = self._product()
        code, body = gr.http_post(
            "/api/grocery/products",
            {"id": p["id"], "rev": p["rev"], "name": "2% Milk", "canonical_unit": "ml", "default_qty_milli": p["default_qty_milli"]},
        )
        self.assertEqual(code, 200, body)
        self.assertEqual(body["product"]["name"], "2% Milk")
        self.assertEqual(body["product"]["rev"], p["rev"] + 1)

    def test_concurrent_product_rev_only_one_wins(self) -> None:
        p = self._product()
        path = store.db_path(self.root)
        c1 = sqlite3.connect(str(path))
        c2 = sqlite3.connect(str(path))
        c1.row_factory = sqlite3.Row
        c2.row_factory = sqlite3.Row
        try:
            for c in (c1, c2):
                c.execute(f"PRAGMA busy_timeout = {store.BUSY_TIMEOUT_MS}")
            c1.execute("BEGIN")
            c2.execute("BEGIN")
            out1 = gr.update_product(c1, self.hid, {"id": p["id"], "rev": p["rev"], "name": "A"})
            c1.commit()
            with self.assertRaises(gr.GroceryError) as ctx:
                gr.update_product(c2, self.hid, {"id": p["id"], "rev": p["rev"], "name": "B"})
            self.assertEqual(ctx.exception.code, "conflict")
            c2.commit()
            row = c1.execute("SELECT name, rev FROM products WHERE id = ?", (p["id"],)).fetchone()
            self.assertEqual(row["name"], out1["name"])
            self.assertEqual(int(row["rev"]), p["rev"] + 1)
        finally:
            c1.close()
            c2.close()

    def test_product_update_cas_two_connections_same_rev(self) -> None:
        p = self._product()
        path = store.db_path(self.root)
        c1 = sqlite3.connect(str(path))
        c2 = sqlite3.connect(str(path))
        try:
            for c in (c1, c2):
                c.execute(f"PRAGMA busy_timeout = {store.BUSY_TIMEOUT_MS}")
            rev = p["rev"]
            pid, hid = p["id"], self.hid
            c1.execute("BEGIN")
            cur1 = c1.execute(
                "UPDATE products SET name = ?, rev = ? WHERE id = ? AND household_id = ? AND rev = ?",
                ("A", rev + 1, pid, hid, rev),
            )
            self.assertEqual(cur1.rowcount, 1)
            c1.commit()
            c2.execute("BEGIN")
            cur2 = c2.execute(
                "UPDATE products SET name = ?, rev = ? WHERE id = ? AND household_id = ? AND rev = ?",
                ("B", rev + 1, pid, hid, rev),
            )
            self.assertEqual(cur2.rowcount, 0)
            c2.commit()
            name = c1.execute("SELECT name FROM products WHERE id = ?", (pid,)).fetchone()[0]
            self.assertEqual(name, "A")
        finally:
            c1.close()
            c2.close()

    def test_canonical_unit_locked_when_lots_exist(self) -> None:
        prod = self._product()
        with store.open_store(self.root) as st:
            with st.transaction():
                gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": prod["id"], "qty_milli": 100, "canonical_unit": "ml"},
                )
            before = st.conn.execute(
                "SELECT canonical_unit FROM products WHERE id = ?", (prod["id"],),
            ).fetchone()[0]
            with self.assertRaises(gr.GroceryError):
                with st.transaction():
                    gr.update_product(
                        st.conn, self.hid,
                        {"id": prod["id"], "rev": prod["rev"], "canonical_unit": "g"},
                    )
            after = st.conn.execute(
                "SELECT canonical_unit FROM products WHERE id = ?", (prod["id"],),
            ).fetchone()[0]
            self.assertEqual(before, after)
            lot_unit = st.conn.execute(
                "SELECT canonical_unit FROM food_lots WHERE product_id = ? LIMIT 1", (prod["id"],),
            ).fetchone()[0]
            self.assertEqual(lot_unit, "ml")

    def test_lot_qty_shrink_without_usable_refused(self) -> None:
        prod = self._product()
        with store.open_store(self.root) as st:
            with st.transaction():
                lot = gr.create_lot(
                    st.conn, self.hid,
                    {"product_id": prod["id"], "qty_milli": 1000, "usable_qty_milli": 800, "canonical_unit": "ml"},
                )
            lid, rev = lot["id"], lot["rev"]
        with store.open_store(self.root) as st:
            before = dict(st.conn.execute("SELECT qty_milli, usable_qty_milli FROM food_lots WHERE id = ?", (lid,)).fetchone())
            with self.assertRaises(gr.GroceryError):
                with st.transaction():
                    gr.update_lot(
                        st.conn, self.hid,
                        {"id": lid, "rev": rev, "qty_milli": 500, "canonical_unit": "ml"},
                    )
            after = dict(st.conn.execute("SELECT qty_milli, usable_qty_milli FROM food_lots WHERE id = ?", (lid,)).fetchone())
            self.assertEqual(before, after)
        with store.open_store(self.root) as st:
            with st.transaction():
                updated = gr.update_lot(
                    st.conn, self.hid,
                    {
                        "id": lid, "rev": rev, "qty_milli": 500, "usable_qty_milli": 400,
                        "canonical_unit": "ml",
                    },
                )
            self.assertEqual(updated["qty_milli"], 500)
            self.assertEqual(updated["usable_qty_milli"], 400)

    def test_product_name_with_pipe_cursor_pagination(self) -> None:
        names = ["A|1", "A|2", "B"]
        with store.open_store(self.root) as st:
            with st.transaction():
                for nm in names:
                    gr.create_product(st.conn, self.hid, {"name": nm, "canonical_unit": "g", "default_qty_milli": 1})
            seen: list[str] = []
            cursor = None
            while True:
                page = gr.list_products(st.conn, self.hid, {"limit": "1", **({"cursor": cursor} if cursor else {})})
                if not page["items"]:
                    break
                self.assertEqual(len(page["items"]), 1)
                seen.append(page["items"][0]["name"])
                cursor = page.get("next_cursor")
                if not cursor:
                    break
            self.assertEqual(seen, names)

    def test_pagination_201_no_duplicates(self) -> None:
        with store.open_store(self.root) as st:
            with st.transaction():
                prod = gr.create_product(
                    st.conn, self.hid, {"name": "P", "canonical_unit": "ml", "default_qty_milli": 1},
                )
                for i in range(201):
                    day = f"2026-01-{(i % 28) + 1:02d}"
                    gr.create_lot(
                        st.conn, self.hid,
                        {"product_id": prod["id"], "qty_milli": 1, "canonical_unit": "ml", "expires_on": day},
                    )
                for i in range(201):
                    gr.create_merchant(st.conn, self.hid, {"name": f"Shop-{i:03d}"})
            lot_ids: list[str] = []
            cursor = None
            while True:
                page = gr.list_lots(
                    st.conn, self.hid, {"limit": "50", "product_id": prod["id"], **({"cursor": cursor} if cursor else {})},
                )
                lot_ids.extend(x["id"] for x in page["items"])
                cursor = page.get("next_cursor")
                if not cursor:
                    break
            self.assertEqual(len(lot_ids), 201)
            self.assertEqual(len(lot_ids), len(set(lot_ids)))
            merch_ids: list[str] = []
            cursor = None
            while True:
                page = gr.list_merchants(st.conn, self.hid, {"limit": "50", **({"cursor": cursor} if cursor else {})})
                merch_ids.extend(x["id"] for x in page["items"])
                cursor = page.get("next_cursor")
                if not cursor:
                    break
            self.assertEqual(len(merch_ids), 201)
            self.assertEqual(len(merch_ids), len(set(merch_ids)))

    def test_foreign_product_id_for_lot_list_refused(self) -> None:
        other = Path(self.tmp.name) / "other2"
        other.mkdir()
        fin.bind(root=other, actor=lambda: "x", now=lambda: 1.0)
        gr.bind(root=other, actor=lambda: "x", now=lambda: 1.0, inventory_snapshot=lambda: self.SNAPSHOT)
        with store.open_store(other) as st:
            with st.transaction():
                oh = fin.ensure_default_household(st.conn)
                remote = gr.create_product(
                    st.conn, oh, {"name": "Remote", "canonical_unit": "g", "default_qty_milli": 1},
                )
        with store.open_store(self.root) as st:
            with self.assertRaises(gr.GroceryError):
                gr.list_lots(st.conn, self.hid, {"product_id": remote["id"]})
        gr.bind(root=self.root, actor=lambda: "tester", now=lambda: 1_900_000_000.0,
                inventory_snapshot=lambda: dict(self.SNAPSHOT))
        fin.bind(root=self.root, actor=lambda: "tester", now=lambda: 1_900_000_000.0)


if __name__ == "__main__":
    unittest.main()
