"""Transactional hardening O–R — batch preflight, finalize gates, durable errors."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventoria_commit as icommit
import hq_inventory as inv


class InventoriaHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-hard-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.apply({"action": "item.create", "name": "Alpha", "qty": 3})
        inv.apply({"action": "place.create", "name": "Shelf", "kind": "shelf"})
        snap = inv.snapshot()
        self.item_id = snap["items"][0]["id"]
        self.place_id = snap["places"][0]["id"]
        self.item_rev = snap["items"][0]["rev"]
        icommit.set_test_hook(None)

    def tearDown(self) -> None:
        icommit.set_test_hook(None)
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _session_op(self, proposals: list[dict]) -> str:
        _, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        _, o2 = ivo.http_post(
            f"/api/inventoria/sessions/{sid}/message",
            {"proposals": proposals},
        )
        return o2["operation"]["id"]

    def test_delete_then_update_rejected_at_validate(self) -> None:
        op_id = self._session_op([
            {
                "op": "item.delete",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "rev": self.item_rev},
                "label_fr": "del",
            },
            {
                "op": "item.update",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "rev": self.item_rev, "name": "Beta"},
                "label_fr": "upd",
            },
        ])
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        codes = {i.get("code") for i in val["validation"]["issues"]}
        self.assertIn("batch_use_after_delete", codes)

    def test_double_delete_rejected_at_validate(self) -> None:
        op_id = self._session_op([
            {
                "op": "item.delete",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "rev": self.item_rev},
                "label_fr": "del1",
            },
            {
                "op": "item.delete",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "rev": self.item_rev + 1},
                "label_fr": "del2",
            },
        ])
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        codes = {i.get("code") for i in val["validation"]["issues"]}
        self.assertIn("batch_duplicate_delete", codes)

    def test_place_delete_then_move_rejected_at_validate(self) -> None:
        inv.apply({
            "action": "item.update",
            "id": self.item_id,
            "rev": self.item_rev,
            "place": self.place_id,
        })
        place_rev = next(p for p in inv.snapshot()["places"] if p["id"] == self.place_id)["rev"]
        op_id = self._session_op([
            {
                "op": "place.delete",
                "refs": {"place_id": self.place_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.place_id, "rev": place_rev},
                "label_fr": "pdel",
            },
            {
                "op": "item.move",
                "refs": {"place_id": self.place_id},
                "resolved": {"confidence": "high"},
                "payload": {"ids": [self.item_id], "place": self.place_id},
                "label_fr": "mv",
            },
        ])
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        codes = {i.get("code") for i in val["validation"]["issues"]}
        self.assertIn("batch_place_unavailable", codes)

    def test_reconcile_rejects_bool_inventory_rev(self) -> None:
        op_id = self._session_op([{
            "op": "item.adjust",
            "refs": {"item_id": self.item_id},
            "resolved": {"confidence": "high"},
            "payload": {"id": self.item_id, "delta": -1},
            "label_fr": "adj",
        }])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})

        def crash_f4(phase: str) -> None:
            if phase == "F4":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(crash_f4)
        ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "bool-rev"})
        icommit.set_test_hook(None)
        c, _ = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/reconcile",
            {
                "decision": "confirm_already_applied",
                "reason": "operator evidence with bad rev type",
                "evidence": {"inventory_rev": True},
                "step_index": 0,
            },
        )
        self.assertEqual(c, 400)

    def test_delete_then_adjust_rejected_at_validate(self) -> None:
        op_id = self._session_op([
            {
                "op": "item.delete",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "rev": self.item_rev},
                "label_fr": "del",
            },
            {
                "op": "item.adjust",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "delta": -1},
                "label_fr": "adj",
            },
        ])
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        codes = {i.get("code") for i in val["validation"]["issues"]}
        self.assertIn("batch_use_after_delete", codes)
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 3)

    def test_abort_then_commit_cannot_finalize(self) -> None:
        op_id = self._session_op([{
            "op": "item.adjust",
            "refs": {"item_id": self.item_id},
            "resolved": {"confidence": "high"},
            "payload": {"id": self.item_id, "delta": -1},
            "label_fr": "adj",
        }])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        body = {"idempotency_key": "hard-p-key"}

        def f6_crash(phase: str) -> None:
            if phase == "F6":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(f6_crash)
        ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        icommit.set_test_hook(None)
        ivo.http_post(
            f"/api/inventoria/ops/{op_id}/reconcile",
            {"decision": "abort_compensate", "reason": "operator aborts after uncertain"},
        )
        c2, out2 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", body)
        self.assertEqual(c2, 409, out2)
        with store.open_store(self.root, readonly=True) as st:
            op = st.conn.execute(
                "SELECT status FROM inventoria_operations WHERE id = ?", (op_id,),
            ).fetchone()
            xop = st.conn.execute("SELECT status, uncertain_inventory FROM cross_store_ops LIMIT 1").fetchone()
            self.assertEqual(op[0], "needs_reconcile")
            self.assertEqual(xop[0], "needs_reconcile")
            self.assertEqual(int(xop[1]), 1)

    def test_apply_error_after_in_flight_durable(self) -> None:
        op_id = self._session_op([{
            "op": "item.adjust",
            "refs": {"item_id": self.item_id},
            "resolved": {"confidence": "high"},
            "payload": {"id": self.item_id, "delta": -1},
            "label_fr": "adj",
        }])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})

        def crash_f4(phase: str) -> None:
            if phase == "F4":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(crash_f4)
        c, _ = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/commit",
            {"idempotency_key": "durable-q"},
        )
        icommit.set_test_hook(None)
        self.assertEqual(c, 409)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        with store.open_store(self.root, readonly=True) as st:
            steps = json.loads(
                st.conn.execute("SELECT planned_steps_json FROM cross_store_ops LIMIT 1").fetchone()[0],
            )
            self.assertEqual(steps[0]["attempt_phase"], "in_flight")
            op_st = st.conn.execute(
                "SELECT status FROM inventoria_operations WHERE id=?", (op_id,),
            ).fetchone()
            self.assertEqual(op_st[0], "needs_reconcile")
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 3)


if __name__ == "__main__":
    unittest.main()
