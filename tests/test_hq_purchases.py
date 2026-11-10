"""Actual grocery purchases — SQLite-only posting."""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

import hq_finances as fin
import hq_grocery as gr
import hq_household_store as store
import hq_purchases as pur


def _setup(root: Path) -> None:
    store.set_acl_for_tests(False)
    fin.bind(root=root, actor=lambda: "tester", now=lambda: 1_900_000_200.0)
    gr.bind(
        root=root,
        actor=lambda: "tester",
        now=lambda: 1_900_000_200.0,
        inventory_snapshot=lambda: {"version": 1, "rev": 1, "items": [], "places": []},
    )
    pur.bind(root=root, actor=lambda: "tester", now=lambda: 1_900_000_200.0)


class PurchasesDomainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-pur-")
        self.root = Path(self.tmp.name)
        _setup(self.root)
        with store.open_store(self.root) as st:
            with st.transaction():
                self.hid = fin.ensure_default_household(st.conn)

    def tearDown(self) -> None:
        pur.reset_for_tests()
        gr.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _merchant(self) -> dict:
        code, out = gr.http_post("/api/grocery/merchants", {"name": "Metro"})
        self.assertEqual(code, 200, out)
        return out["merchant"]

    def _product(self) -> dict:
        code, out = gr.http_post(
            "/api/grocery/products",
            {"name": "Milk", "canonical_unit": "ml", "default_qty_milli": 1000},
        )
        self.assertEqual(code, 200, out)
        return out["product"]

    def _finance_setup(self) -> tuple[str, str]:
        with store.open_store(self.root) as st:
            with st.transaction():
                acct = fin.create_account(
                    st.conn,
                    self.hid,
                    {"name": "Cheq", "kind": "cash", "opening_balance_cents": 50_000, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st.conn, self.hid, {"name": "Groceries", "kind": "expense"})["id"]
        return acct, cat

    def _purchase_body(self, **kw) -> dict:
        mch = self._merchant()
        prod = self._product()
        base = {
            "planned_id": None,
            "product_id": prod["id"],
            "merchant_id": mch["id"],
            "qty_milli": 1_000_000,
            "unit": "ml",
            "paid_cents": 499,
            "taxed_cents": 50,
            "deposit_cents": 0,
            "purchased_on": "2026-11-09",
            "fingerprint": "mch|milk|2026-11-09|499|line1",
            "idempotency_key": "pur-test-1",
            "post_finance": False,
            "create_lot": False,
        }
        base.update(kw)
        return base

    def test_minimal_purchase_and_list(self) -> None:
        body = self._purchase_body()
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 200, out)
        pid = out["purchase"]["id"]
        code2, page = pur.http_get("/api/grocery/purchases/actual")
        self.assertEqual(code2, 200)
        self.assertEqual(page["items"][0]["id"], pid)

    def test_post_finance_and_lot_atomic(self) -> None:
        acct, cat = self._finance_setup()
        body = self._purchase_body(
            idempotency_key="pur-fin-lot",
            fingerprint="mch|milk|2026-11-10|899|line2",
            post_finance=True,
            account_id=acct,
            category_id=cat,
            create_lot=True,
        )
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 200, out)
        self.assertTrue(out.get("transaction_id"))
        self.assertTrue(out.get("food_lot_id"))
        with store.open_store(self.root, readonly=True) as st:
            tx = st.conn.execute(
                "SELECT source, external_fingerprint FROM transactions WHERE id = ?",
                (out["transaction_id"],),
            ).fetchone()
            self.assertEqual(tx[0], "grocery_purchase")
            self.assertEqual(tx[1], body["fingerprint"])

    def test_paid_cents_covers_tax_and_deposit(self) -> None:
        body = self._purchase_body(
            idempotency_key="pur-bad-money",
            fingerprint="bad-money",
            paid_cents=10,
            taxed_cents=20,
        )
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)
        self.assertEqual(out["code"], "validation_error")

    def test_planned_id_rejected(self) -> None:
        body = self._purchase_body(planned_id="pur-fake000000000001", idempotency_key="pur-plan")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_unit_mismatch_product(self) -> None:
        body = self._purchase_body(unit="g", idempotency_key="pur-unit", fingerprint="unit-mismatch")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_fingerprint_conflict(self) -> None:
        body = self._purchase_body(idempotency_key="pur-fp-a", fingerprint="same-fp")
        code, _ = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 200)
        body2 = self._purchase_body(idempotency_key="pur-fp-b", fingerprint="same-fp")
        code2, out2 = pur.http_post("/api/grocery/purchases/actual", body2)
        self.assertEqual(code2, 409, out2)

    def test_idempotency_replay(self) -> None:
        body = self._purchase_body(idempotency_key="idem-replay", fingerprint="idem-fp-1")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 200)
        code2, out2 = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code2, 200)
        self.assertEqual(out2["purchase"]["id"], out["purchase"]["id"])

    def test_idempotency_body_conflict(self) -> None:
        body = self._purchase_body(idempotency_key="idem-conflict", fingerprint="idem-fp-2")
        pur.http_post("/api/grocery/purchases/actual", body)
        body["fingerprint"] = "other"
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 409, out)

    def test_post_finance_requires_expense_category(self) -> None:
        acct, _ = self._finance_setup()
        with store.open_store(self.root) as st:
            with st.transaction():
                cat = fin.upsert_category(st.conn, self.hid, {"name": "xfer", "kind": "transfer"})["id"]
        body = self._purchase_body(
            post_finance=True,
            account_id=acct,
            category_id=cat,
            idempotency_key="pur-xfer-cat",
            fingerprint="xfer-cat",
        )
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_adjust_inventory_not_implemented(self) -> None:
        body = self._purchase_body(adjust_inventory=True, idempotency_key="pur-adj", fingerprint="adj")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 501, out)
        self.assertEqual(out["code"], "not_implemented")

    def test_unknown_field_rejected(self) -> None:
        body = self._purchase_body(extra_field=True, idempotency_key="pur-unk", fingerprint="unk")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)


if __name__ == "__main__":
    unittest.main()
