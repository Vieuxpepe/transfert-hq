"""Inventoria multi-step batch simulation and F6 finalize."""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_schemas as schemas
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_commit as icommit
import hq_inventory as inv


class InventoriaBatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-batch-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 400.0)
        inv.bind(root=self.root, now=lambda: 400.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 400.0)
        inv.apply({"action": "item.create", "name": "Stock", "qty": 5})
        self.item_id = inv.snapshot()["items"][0]["id"]
        icommit.set_test_hook(None)

    def tearDown(self) -> None:
        icommit.set_test_hook(None)
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _adj(self, delta: int, iid: str | None = None) -> dict:
        iid = iid or self.item_id
        return {
            "op": "item.adjust",
            "refs": {"item_id": iid},
            "resolved": {"confidence": "high"},
            "payload": {"id": iid, "delta": delta},
            "label_fr": f"adj {delta}",
        }

    def _through(self, proposals: list[dict]) -> str:
        c, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        _, out2 = ivo.http_post(
            f"/api/inventoria/sessions/{sid}/message",
            {"proposals": proposals},
        )
        op_id = out2["operation"]["id"]
        v, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        self.assertEqual(v, 200, val)
        self.assertTrue(val["validation"]["ok"], val["validation"])
        p, _ = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        self.assertEqual(p, 200)
        return op_id

    def test_two_decrements_jointly_exceed_stock_rejected(self) -> None:
        c, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        _, o2 = ivo.http_post(
            f"/api/inventoria/sessions/{sid}/message",
            {"proposals": [self._adj(-3), self._adj(-3)]},
        )
        op_id = o2["operation"]["id"]
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        self.assertFalse(val["validation"]["ok"])
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 5)

    def test_update_then_adjust_same_item(self) -> None:
        item = inv.snapshot()["items"][0]
        proposals = [
            {
                "op": "item.update",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "rev": item["rev"], "qty": 8},
                "label_fr": "qty 8",
            },
            self._adj(1),
        ]
        op_id = self._through(proposals)
        c, _ = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/commit",
            {"idempotency_key": "batch-02-key"},
        )
        self.assertEqual(c, 200)
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 9)

    def test_ref_payload_mismatch_rejected(self) -> None:
        other = self.item_id
        inv.apply({"action": "item.create", "name": "B", "qty": 1})
        other2 = inv.snapshot()["items"][1]["id"]
        c, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        _, o2 = ivo.http_post(
            f"/api/inventoria/sessions/{sid}/message",
            {"proposals": [{
                "op": "item.adjust",
                "refs": {"item_id": other},
                "resolved": {"confidence": "high"},
                "payload": {"id": other2, "delta": -1},
                "label_fr": "mismatch",
            }]},
        )
        op_id = o2["operation"]["id"]
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        self.assertFalse(val["validation"]["ok"])

    def test_cancel_refused_after_in_flight(self) -> None:
        op_id = self._through([self._adj(-1)])

        def boom(phase: str) -> None:
            if phase == "F4":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(boom)
        ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "cancel-f4"})
        icommit.set_test_hook(None)
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/cancel", {})
        self.assertEqual(c, 409, out)
        with store.open_store(self.root, readonly=True) as st:
            row = st.conn.execute(
                "SELECT status FROM inventoria_operations WHERE id = ?", (op_id,),
            ).fetchone()
            self.assertEqual(row[0], "needs_reconcile")

    def test_f6_after_unrelated_inventory_change(self) -> None:
        op_id = self._through([self._adj(-1)])
        body = {"idempotency_key": "f6-final"}

        def crash_f6(phase: str) -> None:
            if phase == "F6":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(crash_f6)
        ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        qty_adj = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        self.assertEqual(qty_adj, 4)
        inv.apply({"action": "item.create", "name": "side", "qty": 1})
        icommit.set_test_hook(None)
        c2, out2 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c2, 200, out2)
        self.assertEqual(len(inv.snapshot()["items"]), 2)
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 4)

    def test_abort_compensate_keeps_needs_reconcile(self) -> None:
        op_id = self._through([self._adj(-1)])

        def crash_f4(phase: str) -> None:
            if phase == "F4":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(crash_f4)
        ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "abort-2-k"})
        icommit.set_test_hook(None)
        c, out = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/reconcile",
            {"decision": "abort_compensate", "reason": "operator aborts uncertain step"},
        )
        self.assertEqual(c, 200, out)
        with store.open_store(self.root, readonly=True) as st:
            xop = st.conn.execute("SELECT * FROM cross_store_ops LIMIT 1").fetchone()
            doc = icommit._cross_store_doc_from_row(xop)  # noqa: SLF001
            schemas.validate_cross_store_op(doc)
            self.assertEqual(xop["status"], "needs_reconcile")
            self.assertEqual(int(xop["uncertain_inventory"]), 1)
            op_st = st.conn.execute(
                "SELECT status FROM inventoria_operations WHERE id = ?", (op_id,),
            ).fetchone()
            self.assertEqual(op_st[0], "needs_reconcile")


class InventoriaConcurrentCommits(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-par-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 500.0)
        inv.bind(root=self.root, now=lambda: 500.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 500.0)
        inv.apply({"action": "item.create", "name": "A", "qty": 10})
        inv.apply({"action": "item.create", "name": "B", "qty": 10})
        self.ids = [i["id"] for i in inv.snapshot()["items"]]

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _prep(self, iid: str) -> tuple[str, str]:
        c, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        prop = {
            "op": "item.adjust",
            "refs": {"item_id": iid},
            "resolved": {"confidence": "high"},
            "payload": {"id": iid, "delta": -1},
            "label_fr": "a",
        }
        _, o2 = ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"proposals": [prop]})
        op_id = o2["operation"]["id"]
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        return op_id, iid

    def test_parallel_commits_distinct_ops(self) -> None:
        op_a, id_a = self._prep(self.ids[0])
        op_b, id_b = self._prep(self.ids[1])
        results: list[tuple[int, dict]] = []

        def run(op_id: str, key: str) -> None:
            fin.bind(root=self.root)
            ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 500.0)
            inv.bind(root=self.root)
            results.append(
                ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": key}),
            )

        t1 = threading.Thread(target=run, args=(op_a, "parallel-a"))
        t2 = threading.Thread(target=run, args=(op_b, "parallel-b"))
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        successes = [c for c, _ in results if c == 200]
        self.assertEqual(len(results), 2)
        for c, _ in results:
            self.assertIn(c, (200, 409))
        doc = inv.snapshot()
        by_id = {i["id"]: i["qty"] for i in doc["items"]}
        total_adj = (10 - by_id[id_a]) + (10 - by_id[id_b])
        self.assertEqual(total_adj, len(successes))
        self.assertLessEqual(total_adj, 2)
        with store.open_store(self.root, readonly=True) as st:
            n = int(st.conn.execute("SELECT COUNT(*) FROM cross_store_ops").fetchone()[0])
        self.assertGreaterEqual(n, len(successes))


if __name__ == "__main__":
    unittest.main()
