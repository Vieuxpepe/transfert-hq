"""Cross-store journal — disabled inventory path for purchases v6."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

import hq_finances as fin
import hq_grocery as gr
import hq_household_store as store
import hq_purchases as pur


class CrossStorePurchasesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hh-cs-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        gr.bind(
            root=self.root,
            actor=lambda: "t",
            now=lambda: 1.0,
            inventory_snapshot=lambda: {"version": 1, "rev": 1, "items": [], "places": []},
        )
        pur.bind(root=self.root, actor=lambda: "t", now=lambda: 1.0)
        with store.open_store(self.root) as st:
            store.validate_schema_v6(st.conn)
            self.assertEqual(st.schema_version, 6)

    def tearDown(self) -> None:
        pur.reset_for_tests()
        gr.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def test_cross_store_ops_table_exists_empty(self) -> None:
        with store.open_store(self.root, readonly=True) as st:
            n = int(st.conn.execute("SELECT COUNT(*) FROM cross_store_ops").fetchone()[0])
            self.assertEqual(n, 0)
            info = {r[1] for r in st.conn.execute("PRAGMA table_info(cross_store_ops)")}
            for col in (
                "kind", "status", "idempotency_key", "request_hash",
                "planned_steps_json", "step_index", "uncertain_inventory",
            ):
                self.assertIn(col, info)

    def test_adjust_inventory_does_not_create_journal_row(self) -> None:
        code, out = gr.http_post("/api/grocery/merchants", {"name": "Shop"})
        self.assertEqual(code, 200)
        mch = out["merchant"]["id"]
        code2, out2 = gr.http_post(
            "/api/grocery/products",
            {"name": "Eggs", "canonical_unit": "each", "default_qty_milli": 1},
        )
        self.assertEqual(code2, 200)
        prod = out2["product"]["id"]
        body = {
            "product_id": prod,
            "merchant_id": mch,
            "qty_milli": 1_000,
            "unit": "each",
            "paid_cents": 399,
            "purchased_on": "2026-11-09",
            "fingerprint": "cs|adj|1",
            "idempotency_key": "cs-adj-1",
            "adjust_inventory": True,
        }
        code3, out3 = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code3, 501, out3)
        self.assertEqual(out3["code"], "not_implemented")
        with store.open_store(self.root, readonly=True) as st:
            self.assertEqual(int(st.conn.execute("SELECT COUNT(*) FROM actual_purchases").fetchone()[0]), 0)
            self.assertEqual(int(st.conn.execute("SELECT COUNT(*) FROM cross_store_ops").fetchone()[0]), 0)

    def test_can_insert_journal_row_sqlite_only(self) -> None:
        """Smoke: table accepts a minimal preparing row (no purchase flow uses it yet)."""
        with store.open_store(self.root) as st:
            with st.transaction():
                hid = fin.ensure_default_household(st.conn)
                steps = json.dumps([
                    {"store": "sqlite", "action": "purchase.finalize", "payload": {}},
                ])
                st.conn.execute(
                    "INSERT INTO cross_store_ops("
                    "id, household_id, kind, idempotency_key, status, request_hash, "
                    "planned_steps_json, step_index, step_results_json, uncertain_inventory, "
                    "created_at, updated_at"
                    ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        "xop-" + "a" * 16,
                        hid,
                        "grocery_purchase",
                        "xop-key-smoke",
                        "preparing",
                        "b" * 64,
                        steps,
                        0,
                        "[]",
                        0,
                        1.0,
                        1.0,
                    ),
                )
            row = st.conn.execute("SELECT status, step_index FROM cross_store_ops").fetchone()
            self.assertEqual(row[0], "preparing")
            self.assertEqual(int(row[1]), 0)


if __name__ == "__main__":
    unittest.main()
