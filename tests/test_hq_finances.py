"""Household finances core — ledger, migration hooks, idempotency, budgets."""

from __future__ import annotations

import json
import sqlite3
import tempfile
import threading
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

import hq_finances as fin
import hq_household_store as store


def _setup(root: Path) -> None:
    store.set_acl_for_tests(False)
    fin.bind(root=root, actor=lambda: "tester", now=lambda: 1_800_000_000.0)


class FinanceDomainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-fin-")
        self.root = Path(self.tmp.name)
        _setup(self.root)
        with store.open_store(self.root) as st:
            with st.transaction():
                self.hid = fin.ensure_default_household(st.conn)

    def tearDown(self) -> None:
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _cat(self, kind: str = "expense") -> str:
        with store.open_store(self.root) as st:
            with st.transaction():
                return fin.upsert_category(st.conn, self.hid, {"name": kind, "kind": kind})["id"]

    def _account(self, opening: int = 0) -> str:
        with store.open_store(self.root) as st:
            with st.transaction():
                return fin.create_account(
                    st.conn, self.hid, {"name": "Main", "kind": "checking", "opening_balance_cents": opening, "currency": "CAD"}
                )["id"]

    def test_exact_balance_after_many_postings(self) -> None:
        acct = self._account(1_000_000)
        cat = self._cat()
        with store.open_store(self.root) as st:
            for i in range(1000):
                fin.post_transaction(
                    st,
                    {
                        "account_id": acct,
                        "category_id": cat,
                        "amount_cents": -1,
                        "booked_on": "2026-01-01",
                        "idempotency_key": f"k-{i:08d}-post",
                        "status": "posted",
                    },
                )
        with store.open_store(self.root) as st:
            bal = fin.account_balance_cents(st.conn, acct)
        self.assertEqual(bal, 1_000_000 - 1000)

    def test_reject_float_and_bool_amounts(self) -> None:
        acct = self._account()
        cat = self._cat()
        with store.open_store(self.root) as st:
            for bad in (1.5, True, "10"):
                with self.subTest(bad=bad):
                    code, body = fin.http_post(
                        "/api/finances/transactions",
                        {
                            "account_id": acct,
                            "category_id": cat,
                            "amount_cents": bad,
                            "booked_on": "2026-01-02",
                            "idempotency_key": "bad-amount-key",
                        },
                    )
                    self.assertEqual(code, 400, body)
                    self.assertEqual(body.get("code"), "validation_error")

    def test_idempotent_retry(self) -> None:
        acct = self._account()
        cat = self._cat()
        body = {
            "account_id": acct,
            "category_id": cat,
            "amount_cents": -500,
            "booked_on": "2026-01-03",
            "idempotency_key": "idem-once-key",
        }
        with store.open_store(self.root) as st:
            r1 = fin.post_transaction(st, body)
            r2 = fin.post_transaction(st, body)
        self.assertEqual(r1["transaction"]["id"], r2["transaction"]["id"])
        with store.open_store(self.root) as st:
            n = st.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        self.assertEqual(n, 1)

    def test_idempotency_conflict_on_body_mismatch(self) -> None:
        acct = self._account()
        cat = self._cat()
        with store.open_store(self.root) as st:
            fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -10,
                    "booked_on": "2026-01-04",
                    "idempotency_key": "idem-conflict",
                },
            )
            with self.assertRaises(fin.FinanceError) as ctx:
                fin.post_transaction(
                    st,
                    {
                        "account_id": acct,
                        "category_id": cat,
                        "amount_cents": -99,
                        "booked_on": "2026-01-04",
                        "idempotency_key": "idem-conflict",
                    },
                )
            self.assertEqual(ctx.exception.code, "conflict")

    def test_concurrent_idempotency_single_row(self) -> None:
        acct = self._account()
        cat = self._cat()
        body = {
            "account_id": acct,
            "category_id": cat,
            "amount_cents": -2500,
            "booked_on": "2026-01-05",
            "idempotency_key": "idem-race-key",
        }
        results: list[str] = []
        errors: list[BaseException] = []

        def worker() -> None:
            try:
                with store.open_store(self.root) as st:
                    out = fin.post_transaction(st, body)
                    results.append(out["transaction"]["id"])
            except BaseException as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=30)
        self.assertEqual(errors, [])
        self.assertEqual(len(set(results)), 1)
        with store.open_store(self.root) as st:
            n = st.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
        self.assertEqual(n, 1)

    def test_transfer_balanced_pair(self) -> None:
        a1 = self._account(10_000)
        a2 = self._account(0)
        cat = self._cat("transfer")
        with store.open_store(self.root) as st:
            out = fin.post_transfer(
                st,
                {
                    "from_account_id": a1,
                    "to_account_id": a2,
                    "amount_cents": 10_000,
                    "category_id": cat,
                    "booked_on": "2026-01-06",
                    "idempotency_key": "xfer-one-key",
                },
            )
        legs = [t["amount_cents"] for t in out["transactions"]]
        self.assertEqual(sum(legs), 0)
        self.assertEqual(sorted(legs), [-10_000, 10_000])
        with store.open_store(self.root) as st:
            self.assertEqual(fin.account_balance_cents(st.conn, a1), 0)
            self.assertEqual(fin.account_balance_cents(st.conn, a2), 10_000)

    def test_transfer_rollback_on_audit_failure(self) -> None:
        a1 = self._account(5000)
        a2 = self._account(0)
        cat = self._cat("transfer")
        with store.open_store(self.root) as st:
            real = fin.write_audit
            calls = {"n": 0}

            def boom(*_a, **_k):
                calls["n"] += 1
                if calls["n"] >= 2:
                    raise RuntimeError("audit-inject")
                return real(*_a, **_k)

            with mock.patch.object(fin, "write_audit", side_effect=boom):
                with self.assertRaises(RuntimeError):
                    fin.post_transfer(
                        st,
                        {
                            "from_account_id": a1,
                            "to_account_id": a2,
                            "amount_cents": 1000,
                            "category_id": cat,
                            "booked_on": "2026-01-07",
                            "idempotency_key": "xfer-audit-fail",
                        },
                    )
        with store.open_store(self.root) as st:
            n = st.conn.execute("SELECT COUNT(*) FROM transactions").fetchone()[0]
            self.assertEqual(n, 0)

    def test_correction_preserves_history(self) -> None:
        acct = self._account(2000)
        cat = self._cat()
        with store.open_store(self.root) as st:
            orig = fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -300,
                    "booked_on": "2026-01-08",
                    "idempotency_key": "orig-tx-key",
                },
            )["transaction"]["id"]
            fin.correct_transaction(
                st,
                {"correction_of": orig, "amount_cents": 300, "idempotency_key": "corr-tx-key", "reason": "fix"},
            )
        with store.open_store(self.root) as st:
            rows = st.conn.execute("SELECT id, correction_of FROM transactions").fetchall()
        self.assertEqual(len(rows), 2)
        by_id = {r[0]: r[1] for r in rows}
        self.assertIsNone(by_id[orig])
        self.assertEqual(sum(1 for v in by_id.values() if v == orig), 1)

    def test_pending_and_void_excluded_from_balance(self) -> None:
        acct = self._account(0)
        cat = self._cat()
        with store.open_store(self.root) as st:
            for status, key in (("pending", "pending-key"), ("void", "void-key")):
                fin.post_transaction(
                    st,
                    {
                        "account_id": acct,
                        "category_id": cat,
                        "amount_cents": 500,
                        "booked_on": "2026-01-09",
                        "status": status,
                        "idempotency_key": key,
                    },
                )
        with store.open_store(self.root) as st:
            self.assertEqual(fin.account_balance_cents(st.conn, acct), 0)

    def test_envelope_period_boundary(self) -> None:
        acct = self._account(0)
        cat = self._cat()
        with store.open_store(self.root) as st:
            with st.transaction():
                fin.upsert_envelope(
                    st.conn,
                    self.hid,
                    {"category_id": cat, "period_start": "2026-01-01", "period_end": "2026-01-31", "allocated_cents": 10_000},
                )
            fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -1000,
                    "booked_on": "2026-01-31",
                    "idempotency_key": "env-edge-key",
                },
            )
            fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -500,
                    "booked_on": "2026-02-01",
                    "idempotency_key": "env-next-key",
                },
            )
        with store.open_store(self.root, readonly=True) as st:
            envs = fin.list_envelopes(st.conn, self.hid, {})
        self.assertEqual(envs[0]["spent_cents"], 1000)

    def _account_currency(self, opening: int, currency: str, name: str) -> str:
        with store.open_store(self.root) as st:
            with st.transaction():
                return fin.create_account(
                    st.conn,
                    self.hid,
                    {
                        "name": name,
                        "kind": "checking",
                        "opening_balance_cents": opening,
                        "currency": currency,
                    },
                )["id"]

    def test_summary_separate_balances_by_currency(self) -> None:
        self._account_currency(100_00, "CAD", "CAD")
        self._account_currency(200_00, "USD", "USD")
        with store.open_store(self.root) as st:
            summary = fin.finances_summary(st)
        self.assertNotIn("total_balance_cents", summary)
        self.assertEqual(summary["balances_by_currency"], {"CAD": 100_00, "USD": 200_00})

    def test_envelope_net_spend_refunds_corrections_transfers(self) -> None:
        acct = self._account(50_000)
        cat = self._cat("expense")
        xfer_cat = self._cat("transfer")
        acct2 = self._account(0)
        with store.open_store(self.root) as st:
            with st.transaction():
                fin.upsert_envelope(
                    st.conn,
                    self.hid,
                    {
                        "category_id": cat,
                        "period_start": "2026-03-01",
                        "period_end": "2026-03-31",
                        "allocated_cents": 20_000,
                    },
                )
            fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -10_000,
                    "booked_on": "2026-03-10",
                    "idempotency_key": "spend-a-key",
                },
            )
            fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": 4_000,
                    "booked_on": "2026-03-11",
                    "idempotency_key": "refund-a-key",
                },
            )
            fin.post_transfer(
                st,
                {
                    "from_account_id": acct,
                    "to_account_id": acct2,
                    "amount_cents": 2_000,
                    "category_id": xfer_cat,
                    "booked_on": "2026-03-12",
                    "idempotency_key": "xfer-env-key",
                },
            )
            orig = fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -1_000,
                    "booked_on": "2026-03-15",
                    "idempotency_key": "to-correct",
                },
            )["transaction"]["id"]
            fin.correct_transaction(
                st,
                {
                    "correction_of": orig,
                    "amount_cents": 1_000,
                    "booked_on": "2026-03-16",
                    "idempotency_key": "corr-full-key",
                },
            )
        with store.open_store(self.root) as st:
            spent = fin.envelope_spent_cents(st.conn, cat, "2026-03-01", "2026-03-31")
        self.assertEqual(spent, 6_000)

    def test_correction_out_of_period_and_overlap(self) -> None:
        acct = self._account(10_000)
        cat = self._cat()
        with store.open_store(self.root) as st:
            with st.transaction():
                fin.upsert_envelope(
                    st.conn,
                    self.hid,
                    {
                        "category_id": cat,
                        "period_start": "2026-04-01",
                        "period_end": "2026-04-15",
                        "allocated_cents": 5_000,
                    },
                )
                fin.upsert_envelope(
                    st.conn,
                    self.hid,
                    {
                        "category_id": cat,
                        "period_start": "2026-04-10",
                        "period_end": "2026-04-30",
                        "allocated_cents": 5_000,
                    },
                )
            orig = fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -2_000,
                    "booked_on": "2026-04-12",
                    "idempotency_key": "overlap-tx",
                },
            )["transaction"]["id"]
            fin.correct_transaction(
                st,
                {
                    "correction_of": orig,
                    "amount_cents": 500,
                    "booked_on": "2026-04-20",
                    "idempotency_key": "overlap-corr",
                },
            )
        with store.open_store(self.root) as st:
            april1 = fin.envelope_spent_cents(st.conn, cat, "2026-04-01", "2026-04-15")
            april2 = fin.envelope_spent_cents(st.conn, cat, "2026-04-10", "2026-04-30")
        self.assertEqual(april1, 2_000)
        self.assertEqual(april2, 1_500)

    def test_generic_post_rejects_reserved_fields(self) -> None:
        acct = self._account()
        cat = self._cat()
        base = {
            "account_id": acct,
            "category_id": cat,
            "amount_cents": -100,
            "booked_on": "2026-05-01",
            "idempotency_key": "generic-reserved",
        }
        cases = (
            ({"transfer_pair_id": "tx-0123456789abcdef"}, "xfer-pair-key"),
            ({"correction_of": "tx-0123456789abcdef"}, "corr-of-key"),
            ({"source": "correction"}, "src-corr-key"),
            ({"source": "import"}, "src-imp-key"),
        )
        for extra, ikey in cases:
            with self.subTest(extra=extra):
                with store.open_store(self.root) as st:
                    with self.assertRaises(fin.FinanceError) as ctx:
                        fin.post_transaction(st, {**base, **extra, "idempotency_key": ikey})
                    self.assertEqual(ctx.exception.code, "validation_error")

    def test_idempotency_cross_operation_conflict(self) -> None:
        acct = self._account(1_000)
        cat = self._cat()
        xfer = self._cat("transfer")
        acct2 = self._account(0)
        key = "shared-idem-key"
        with store.open_store(self.root) as st:
            fin.post_transaction(
                st,
                {
                    "account_id": acct,
                    "category_id": cat,
                    "amount_cents": -10,
                    "booked_on": "2026-05-02",
                    "idempotency_key": key,
                },
            )
            with self.assertRaises(fin.FinanceError) as ctx:
                fin.post_transfer(
                    st,
                    {
                        "from_account_id": acct,
                        "to_account_id": acct2,
                        "amount_cents": 10,
                        "category_id": xfer,
                        "booked_on": "2026-05-03",
                        "idempotency_key": key,
                    },
                )
            self.assertEqual(ctx.exception.code, "conflict")

    def test_idempotency_wait_uses_monotonic_not_business_clock(self) -> None:
        acct = self._account(100)
        cat = self._cat()
        mono = {"t": 0.0}

        def fake_mono():
            return mono["t"]

        fin.bind(root=self.root, actor=lambda: "tester", now=lambda: 1_800_000_000.0)
        body = {
            "account_id": acct,
            "category_id": cat,
            "amount_cents": -1,
            "booked_on": "2026-05-04",
            "idempotency_key": "mono-clock-key",
        }
        with store.open_store(self.root) as st:
            with st.transaction():
                fin.idempotency_store(
                    st.conn,
                    key="mono-clock-key",
                    operation="transaction.post",
                    request_hash=fin._body_hash(body),
                    entity_type="_pending",
                    entity_id="_pending",
                    response={"ok": True, "pending": True},
                    pin=False,
                )
            slept: list[float] = []
            mono["t"] = 0.0

            def tick(s: float) -> None:
                slept.append(s)
                mono["t"] += s

            with mock.patch.object(fin.time, "monotonic", side_effect=fake_mono):
                with mock.patch.object(fin.time, "sleep", side_effect=tick):
                    with self.assertRaises(fin.FinanceError):
                        fin.idempotency_claim(st.conn, key="mono-clock-key", operation="transaction.post", body=body)
            self.assertTrue(slept)

    def test_sqlite_integer_amount_rejected(self) -> None:
        with self.assertRaises(fin.FinanceError):
            fin.require_finance_cents(fin.SQLITE_INT_MAX + 1)
        with self.assertRaises(fin.FinanceError):
            fin.require_finance_cents(fin.SQLITE_INT_MIN - 1)

    def test_transaction_cursor_chronological(self) -> None:
        acct = self._account()
        cat = self._cat()
        with store.open_store(self.root) as st:
            for day, key in (("2026-06-01", "cur-a-key"), ("2026-06-03", "cur-b-key")):
                fin.post_transaction(
                    st,
                    {
                        "account_id": acct,
                        "category_id": cat,
                        "amount_cents": -10,
                        "booked_on": day,
                        "idempotency_key": key,
                    },
                )
        with store.open_store(self.root, readonly=True) as st:
            page1 = fin.list_transactions(st.conn, self.hid, {"limit": "1"})
            self.assertEqual(page1["items"][0]["booked_on"], "2026-06-03")
            self.assertIsNotNone(page1["next_cursor"])
            page2 = fin.list_transactions(st.conn, self.hid, {"limit": "1", "cursor": page1["next_cursor"]})
            self.assertEqual(page2["items"][0]["booked_on"], "2026-06-01")


if __name__ == "__main__":
    unittest.main()
