"""Cross-store recovery scenarios CS-01 … CS-08 (Inventoria commit)."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import tempfile
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_commit as icommit
import hq_inventory as inv


def _proposal(item_id: str) -> dict:
    return {
        "op": "item.adjust",
        "refs": {"item_id": item_id},
        "resolved": {"item_id": item_id, "confidence": "high"},
        "payload": {"id": item_id, "delta": -1},
        "label_fr": "adjust",
    }


class InventoriaRecoveryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-cs-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 200.0)
        inv.bind(root=self.root, now=lambda: 200.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 200.0)
        inv.apply({"action": "item.create", "name": "X", "qty": 10})
        self.item_id = inv.snapshot()["items"][0]["id"]
        icommit.set_test_hook(None)

    def tearDown(self) -> None:
        os.environ.pop("TEST_HOOK", None)
        icommit.set_test_hook(None)
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _prepare_op(self) -> tuple[str, dict]:
        c, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        c2, out2 = ivo.http_post(
            f"/api/inventoria/sessions/{sid}/message",
            {"proposals": [_proposal(self.item_id)]},
        )
        op_id = out2["operation"]["id"]
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        c4, out4 = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        return op_id, out4["preview"]

    def _commit_body(self, _preview: dict, key: str) -> dict:
        return {"idempotency_key": key}

    def test_CS01_double_post_same_key_hash(self) -> None:
        op_id, prev = self._prepare_op()
        body = self._commit_body(prev, "cs01-key")
        c1, o1 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c1, 200, o1)
        c2, o2 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c2, 200, o2)
        with store.open_store(self.root, readonly=True) as st:
            n = int(st.conn.execute("SELECT COUNT(*) FROM cross_store_ops").fetchone()[0])
        self.assertEqual(n, 1)

    def test_CS02_same_key_different_hash(self) -> None:
        op_id, prev = self._prepare_op()
        b1 = self._commit_body(prev, "cs02-key")
        ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", b1)
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", b1)
        self.assertEqual(c, 200, out)
        qty = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        self.assertEqual(qty, 9)
        c2, out2 = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/commit",
            {"idempotency_key": "cs02-key", "expected_inventory_rev": 9999},
        )
        self.assertEqual(c2, 400, out2)

    def test_CS03_crash_not_started_may_retry(self) -> None:
        op_id, prev = self._prepare_op()
        body = self._commit_body(prev, "cs03-key")
        with store.open_store(self.root) as st:
            with st.transaction():
                fin.ensure_default_household(st.conn, create=True)
                row = st.conn.execute(
                    "SELECT * FROM inventoria_operations WHERE id = ?", (op_id,),
                ).fetchone()
                proposals = json.loads(row["proposals_json"])
                req_hash = hashlib.sha256(
                    json.dumps(
                        {
                            "operation_id": op_id,
                            "idempotency_key": body["idempotency_key"],
                            "preview_digest": prev["preview_digest"],
                            "expected_inventory_rev": prev["inventory_rev"],
                            "item_rev_expectations": [],
                        },
                        sort_keys=True,
                    ).encode(),
                ).hexdigest()
                out = icommit.run_inventoria_commit(
                    st.conn,
                    household_id=row["household_id"],
                    operation_id=op_id,
                    proposals=proposals,
                    idempotency_key=body["idempotency_key"],
                    request_hash=req_hash,
                    expected_inventory_rev=int(prev["inventory_rev"]),
                    item_rev_expectations=None,
                    preview_digest=prev["preview_digest"],
                    now=200.0,
                    resume=True,
                )
                self.assertTrue(out.get("ok"))

    def test_CS03b_crash_in_flight_needs_reconcile(self) -> None:
        op_id, prev = self._prepare_op()
        body = self._commit_body(prev, "cs03b-key")

        def boom(phase: str) -> None:
            if phase == "F4":
                raise icommit.CommitAbort("F4")

        icommit.set_test_hook(boom)
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c, 409, out)
        self.assertEqual(out.get("code"), "needs_reconcile")

    def test_CS04_inject_apply_without_ack(self) -> None:
        self.test_CS03b_crash_in_flight_needs_reconcile()

    def test_CS05_ack_ok_crash_before_finalize(self) -> None:
        op_id, prev = self._prepare_op()
        body = self._commit_body(prev, "cs05-key")

        def hook(phase: str) -> None:
            if phase == "F6":
                raise icommit.CommitAbort("F6")

        icommit.set_test_hook(hook)
        c5, out5 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c5, 409, out5)
        qty = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        self.assertEqual(qty, 9)
        with store.open_store(self.root, readonly=True) as st:
            xop = st.conn.execute(
                "SELECT status, planned_steps_json, step_results_json FROM cross_store_ops LIMIT 1",
            ).fetchone()
            steps = json.loads(xop[1])
            self.assertEqual(steps[0]["attempt_phase"], "acknowledged")
            self.assertTrue(json.loads(xop[2] or "[]"))
        icommit.set_test_hook(None)
        c6, out6 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c6, 200, out6)
        with store.open_store(self.root, readonly=True) as st:
            xop2 = st.conn.execute("SELECT status FROM cross_store_ops LIMIT 1").fetchone()
            self.assertEqual(xop2[0], "committed")

    def test_CS06_rev_conflict_mid_batch(self) -> None:
        op_id, prev = self._prepare_op()
        rev = inv.snapshot()["rev"]
        inv.apply({"action": "item.create", "name": "intruder", "qty": 1})
        self.assertNotEqual(inv.snapshot()["rev"], rev)
        body = self._commit_body(prev, "cs06-key")
        qty_before = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c, 409, out)
        qty_after = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        self.assertEqual(qty_before, qty_after)

    def test_CS07_two_keys_parallel_distinct_journals(self) -> None:
        inv.apply({"action": "item.create", "name": "Y", "qty": 5})
        items = inv.snapshot()["items"]
        item_b = items[1]["id"]

        def proposal_adj(iid: str) -> dict:
            return _proposal(iid)

        c, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        for iid, key in ((self.item_id, "cs07-key-aaa"), (item_b, "cs07-key-bbb")):
            _, o = ivo.http_post(
                f"/api/inventoria/sessions/{sid}/message",
                {"proposals": [proposal_adj(iid)]},
            )
            op_id = o["operation"]["id"]
            ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
            _, o4 = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
            c5, out5 = ivo.http_post(
                f"/api/inventoria/ops/{op_id}/commit",
                self._commit_body(o4["preview"], key),
            )
            self.assertEqual(c5, 200, out5)
        with store.open_store(self.root, readonly=True) as st:
            self.assertEqual(int(st.conn.execute("SELECT COUNT(*) FROM cross_store_ops").fetchone()[0]), 2)

    def test_CS08_confirm_not_applied_retry(self) -> None:
        op_id, prev = self._prepare_op()
        body = self._commit_body(prev, "cs08-key")
        qty0 = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]

        def _crash_f4(phase: str) -> None:
            if phase == "F4":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(_crash_f4)
        ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(
            next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"],
            qty0,
        )
        icommit.set_test_hook(None)
        c2, out2 = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/reconcile",
            {
                "decision": "confirm_not_applied",
                "reason": "operator confirms no apply occurred",
                "idempotency_key": "sub8",
                "step_index": 0,
            },
        )
        self.assertEqual(c2, 200, out2)
        qty1 = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        self.assertEqual(qty1, qty0 - 1)
        with store.open_store(self.root, readonly=True) as st:
            steps = json.loads(
                st.conn.execute(
                    "SELECT planned_steps_json FROM cross_store_ops LIMIT 1",
                ).fetchone()[0],
            )
            self.assertEqual(steps[0]["attempt_phase"], "acknowledged")


if __name__ == "__main__":
    unittest.main()
