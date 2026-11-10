"""PR #36 audit — isolation, strict bools, atomicity, concurrency."""

from __future__ import annotations

import json
import secrets
import sqlite3
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

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


def _counts(conn: sqlite3.Connection) -> dict[str, int]:
    return {
        "actual_purchases": int(conn.execute("SELECT COUNT(*) FROM actual_purchases").fetchone()[0]),
        "purchase_idempotency": int(conn.execute("SELECT COUNT(*) FROM purchase_idempotency").fetchone()[0]),
        "transactions": int(conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]),
        "food_lots": int(conn.execute("SELECT COUNT(*) FROM food_lots").fetchone()[0]),
        "ledger_audit": int(conn.execute("SELECT COUNT(*) FROM ledger_audit").fetchone()[0]),
        "cross_store_ops": int(conn.execute("SELECT COUNT(*) FROM cross_store_ops").fetchone()[0]),
    }


class PurchasesAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-pur-audit-")
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

    def _merchant(self) -> str:
        code, out = gr.http_post("/api/grocery/merchants", {"name": "Metro"})
        self.assertEqual(code, 200, out)
        return out["merchant"]["id"]

    def _product(self) -> str:
        code, out = gr.http_post(
            "/api/grocery/products",
            {"name": "Milk", "canonical_unit": "ml", "default_qty_milli": 1000},
        )
        self.assertEqual(code, 200, out)
        return out["product"]["id"]

    def _body(self, **kw) -> dict:
        base = {
            "product_id": self._product(),
            "merchant_id": self._merchant(),
            "qty_milli": 1_000_000,
            "unit": "ml",
            "paid_cents": 499,
            "taxed_cents": 50,
            "deposit_cents": 0,
            "purchased_on": "2026-11-09",
            "fingerprint": secrets.token_hex(8),
            "idempotency_key": "pur-audit-" + secrets.token_hex(4),
        }
        base.update(kw)
        return base

    def _second_household_finance(self) -> tuple[str, str, str]:
        now = 1_900_000_200.0
        hid_b = f"hhold-{secrets.token_hex(8)}"
        with store.open_store(self.root) as st:
            with st.transaction():
                st.conn.execute(
                    "INSERT INTO households(id, name, currency, locale, timezone, week_starts, prefs_json, created_at, updated_at, rev) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
                    (hid_b, "Autre", "CAD", "fr-CA", "America/Toronto", "mon", "{}", now, now),
                )
                acct = fin.create_account(
                    st.conn,
                    hid_b,
                    {"name": "B", "kind": "cash", "opening_balance_cents": 0, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st.conn, hid_b, {"name": "G", "kind": "expense"})["id"]
        return hid_b, acct, cat

    def test_cross_household_account_rejected(self) -> None:
        _, acct_b, cat_b = self._second_household_finance()
        with store.open_store(self.root) as st:
            with st.transaction():
                acct_a, cat_a = (
                    fin.create_account(st.conn, self.hid, {"name": "A", "kind": "cash", "opening_balance_cents": 0, "currency": "CAD"})["id"],
                    fin.upsert_category(st.conn, self.hid, {"name": "Gro", "kind": "expense"})["id"],
                )
        body = self._body(
            post_finance=True,
            create_lot=False,
            account_id=acct_b,
            category_id=cat_a,
        )
        with store.open_store(self.root, readonly=True) as st:
            before = _counts(st.conn)
        try:
            with store.open_store(self.root) as st:
                with st.transaction():
                    pur.post_actual_purchase(st.conn, self.hid, body)
            self.fail("expected PurchasesError")
        except pur.PurchasesError as exc:
            self.assertEqual(exc.status, 404)
        with store.open_store(self.root, readonly=True) as st:
            self.assertEqual(_counts(st.conn), before)

    def test_cross_household_category_rejected(self) -> None:
        _, _acct_b, cat_b = self._second_household_finance()
        with store.open_store(self.root) as st:
            with st.transaction():
                acct_a = fin.create_account(
                    st.conn, self.hid,
                    {"name": "A", "kind": "cash", "opening_balance_cents": 0, "currency": "CAD"},
                )["id"]
        body = self._body(post_finance=True, create_lot=False, account_id=acct_a, category_id=cat_b)
        with store.open_store(self.root, readonly=True) as st:
            before = _counts(st.conn)
        try:
            with store.open_store(self.root) as st:
                with st.transaction():
                    pur.post_actual_purchase(st.conn, self.hid, body)
            self.fail("expected PurchasesError")
        except pur.PurchasesError as exc:
            self.assertEqual(exc.status, 404)
        with store.open_store(self.root, readonly=True) as st:
            self.assertEqual(_counts(st.conn), before)

    def test_usd_account_on_cad_household_rejected(self) -> None:
        with store.open_store(self.root) as st:
            with st.transaction():
                acct = fin.create_account(
                    st.conn, self.hid,
                    {"name": "USD", "kind": "cash", "opening_balance_cents": 0, "currency": "USD"},
                )["id"]
                cat = fin.upsert_category(st.conn, self.hid, {"name": "Gro", "kind": "expense"})["id"]
        body = self._body(post_finance=True, create_lot=False, account_id=acct, category_id=cat)
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)
        self.assertEqual(out["code"], "validation_error")

    def test_strict_bool_rejects_string_true(self) -> None:
        body = self._body(post_finance="true")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_strict_bool_absent_is_false(self) -> None:
        body = self._body()
        body.pop("post_finance", None)
        body.pop("create_lot", None)
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 200, out)
        self.assertIsNone(out["purchase"].get("finance_tx_id"))

    def test_finance_fields_rejected_when_post_finance_false(self) -> None:
        with store.open_store(self.root) as st:
            with st.transaction():
                acct = fin.create_account(
                    st.conn, self.hid,
                    {"name": "A", "kind": "cash", "opening_balance_cents": 0, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st.conn, self.hid, {"name": "G", "kind": "expense"})["id"]
        body = self._body(account_id=acct, category_id=cat, post_finance=False)
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_lot_fields_rejected_when_create_lot_false(self) -> None:
        body = self._body(create_lot=False, link_item_id="item-0123456789abcdef")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_payee_must_be_string(self) -> None:
        with store.open_store(self.root) as st:
            with st.transaction():
                acct = fin.create_account(
                    st.conn, self.hid,
                    {"name": "A", "kind": "cash", "opening_balance_cents": 50_000, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st.conn, self.hid, {"name": "G", "kind": "expense"})["id"]
        body = self._body(
            post_finance=True,
            create_lot=False,
            account_id=acct,
            category_id=cat,
            payee={"x": 1},
        )
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_cents_sqlite_max_rejected(self) -> None:
        body = self._body(paid_cents=pur.SQLITE_INT_MAX + 1, taxed_cents=0, deposit_cents=0)
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 400, out)

    def test_adjust_inventory_501_before_store_mutation(self) -> None:
        with store.open_store(self.root, readonly=True) as st:
            before = _counts(st.conn)
        body = self._body(adjust_inventory=True)
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 501, out)
        with store.open_store(self.root, readonly=True) as st:
            self.assertEqual(_counts(st.conn), before)

    def test_rollback_when_finance_fails_after_purchase_insert(self) -> None:
        with store.open_store(self.root) as st:
            with st.transaction():
                acct = fin.create_account(
                    st.conn, self.hid,
                    {"name": "A", "kind": "cash", "opening_balance_cents": 50_000, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st.conn, self.hid, {"name": "G", "kind": "expense"})["id"]
        body = self._body(
            post_finance=True,
            create_lot=False,
            account_id=acct,
            category_id=cat,
        )
        with patch.object(fin, "insert_transaction", side_effect=fin.FinanceError("inject", status=503, code="storage_error")):
            code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertNotEqual(code, 200, out)
        with store.open_store(self.root, readonly=True) as st:
            c = _counts(st.conn)
            self.assertEqual(c["actual_purchases"], 0)
            self.assertEqual(c["transactions"], 0)
            tx_aud = int(
                st.conn.execute(
                    "SELECT COUNT(*) FROM ledger_audit WHERE entity_type = 'transaction'",
                ).fetchone()[0]
            )
            self.assertEqual(tx_aud, 0)

    def test_rollback_when_lot_fails_after_finance(self) -> None:
        with store.open_store(self.root) as st:
            with st.transaction():
                acct = fin.create_account(
                    st.conn, self.hid,
                    {"name": "A", "kind": "cash", "opening_balance_cents": 50_000, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st.conn, self.hid, {"name": "G", "kind": "expense"})["id"]
        body = self._body(
            post_finance=True,
            create_lot=True,
            account_id=acct,
            category_id=cat,
        )
        with patch.object(gr, "create_lot", side_effect=gr.GroceryError("inject", status=503, code="storage_error")):
            code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertNotEqual(code, 200, out)
        with store.open_store(self.root, readonly=True) as st:
            c = _counts(st.conn)
            self.assertEqual(c["actual_purchases"], 0)
            self.assertEqual(c["transactions"], 0)
            self.assertEqual(c["food_lots"], 0)
            tx_aud = int(
                st.conn.execute(
                    "SELECT COUNT(*) FROM ledger_audit WHERE entity_type = 'transaction'",
                ).fetchone()[0]
            )
            self.assertEqual(tx_aud, 0)

    def test_rollback_when_idem_finalize_fails(self) -> None:
        body = self._body()
        with patch.object(pur, "_purchase_idem_finalize", side_effect=RuntimeError("inject-finalize")):
            with self.assertRaises(RuntimeError):
                pur.http_post("/api/grocery/purchases/actual", body)
        with store.open_store(self.root, readonly=True) as st:
            c = _counts(st.conn)
            self.assertEqual(c["actual_purchases"], 0)
            self.assertEqual(c["purchase_idempotency"], 0)

    def test_finance_idem_key_boundary_lengths_post_finance(self) -> None:
        with store.open_store(self.root) as st:
            with st.transaction():
                acct = fin.create_account(
                    st.conn, self.hid,
                    {"name": "A", "kind": "cash", "opening_balance_cents": 50_000, "currency": "CAD"},
                )["id"]
                cat = fin.upsert_category(st.conn, self.hid, {"name": "G", "kind": "expense"})["id"]
        for length in (8, 128):
            idem = "k" * length
            fp = f"idem-boundary-{length}"
            body = self._body(
                idempotency_key=idem,
                fingerprint=fp,
                post_finance=True,
                create_lot=False,
                account_id=acct,
                category_id=cat,
            )
            expected_tx_key = pur.finance_idempotency_key_for_purchase(self.hid, idem)
            self.assertEqual(len(expected_tx_key), 64)
            code, out = pur.http_post("/api/grocery/purchases/actual", body)
            self.assertEqual(code, 200, out)
            code2, out2 = pur.http_post("/api/grocery/purchases/actual", body)
            self.assertEqual(code2, 200, out2)
            self.assertEqual(out2["purchase"]["id"], out["purchase"]["id"])
            with store.open_store(self.root, readonly=True) as st:
                tx = st.conn.execute(
                    "SELECT idempotency_key FROM transactions WHERE id = ?",
                    (out["transaction_id"],),
                ).fetchone()
                self.assertEqual(str(tx[0]), expected_tx_key)

    def test_idempotency_key_blocked_after_cache_purge(self) -> None:
        idem = "persist-" + secrets.token_hex(20)
        body = self._body(idempotency_key=idem, fingerprint="fp-persist-1")
        code, out = pur.http_post("/api/grocery/purchases/actual", body)
        self.assertEqual(code, 200, out)
        pid = out["purchase"]["id"]
        with store.open_store(self.root) as st:
            with st.transaction():
                st.conn.execute(
                    "DELETE FROM purchase_idempotency WHERE household_id = ? AND idempotency_key = ?",
                    (self.hid, idem),
                )
        body2 = self._body(idempotency_key=idem, fingerprint="fp-persist-2")
        code2, out2 = pur.http_post("/api/grocery/purchases/actual", body2)
        self.assertEqual(code2, 409, out2)
        with store.open_store(self.root, readonly=True) as st:
            self.assertEqual(
                int(st.conn.execute("SELECT COUNT(*) FROM actual_purchases WHERE id = ?", (pid,)).fetchone()[0]),
                1,
            )

    def test_concurrent_same_idempotency_single_row(self) -> None:
        body = self._body(idempotency_key="concurrent-idem-key", fingerprint="conc-fp-unique")
        results: list[tuple[int, dict]] = []
        barrier = threading.Barrier(2)

        def worker() -> None:
            barrier.wait()
            results.append(pur.http_post("/api/grocery/purchases/actual", dict(body)))

        t1 = threading.Thread(target=worker)
        t2 = threading.Thread(target=worker)
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)
        codes = [r[0] for r in results]
        self.assertEqual(len(results), 2)
        self.assertTrue(all(c == 200 for c in codes), results)
        pids = {r[1]["purchase"]["id"] for r in results}
        self.assertEqual(len(pids), 1)
        with store.open_store(self.root, readonly=True) as st:
            c = _counts(st.conn)
            self.assertEqual(c["actual_purchases"], 1)
            self.assertEqual(c["purchase_idempotency"], 1)


if __name__ == "__main__":
    unittest.main()
