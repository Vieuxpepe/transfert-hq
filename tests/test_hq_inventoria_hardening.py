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
        self.assertIn("batch_place_not_empty", codes)

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

    def _codes(self, proposals: list[dict]) -> set[str]:
        op_id = self._session_op(proposals)
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        return {i.get("code") for i in val["validation"]["issues"]}

    def test_adjust_then_occupied_place_delete_rejected(self) -> None:
        inv.apply({
            "action": "item.update",
            "id": self.item_id,
            "rev": self.item_rev,
            "place": self.place_id,
        })
        place_rev = next(p for p in inv.snapshot()["places"] if p["id"] == self.place_id)["rev"]
        qty = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        codes = self._codes([
            {
                "op": "item.adjust",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "delta": -1},
                "label_fr": "adj",
            },
            {
                "op": "place.delete",
                "refs": {"place_id": self.place_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.place_id, "rev": place_rev},
                "label_fr": "pdel",
            },
        ])
        self.assertIn("batch_place_not_empty", codes)
        self.assertEqual(next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"], qty)

    def test_adjust_then_place_cycle_rejected(self) -> None:
        place_rev = next(p for p in inv.snapshot()["places"] if p["id"] == self.place_id)["rev"]
        qty = inv.snapshot()["items"][0]["qty"]
        codes = self._codes([
            {
                "op": "item.adjust",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "delta": -1},
                "label_fr": "adj",
            },
            {
                "op": "place.update",
                "refs": {"place_id": self.place_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.place_id, "rev": place_rev, "parent": self.place_id},
                "label_fr": "cycle",
            },
        ])
        self.assertIn("batch_place_cycle", codes)
        self.assertEqual(inv.snapshot()["items"][0]["qty"], qty)

    def test_two_place_updates_same_rev_rejected(self) -> None:
        place_rev = next(p for p in inv.snapshot()["places"] if p["id"] == self.place_id)["rev"]
        codes = self._codes([
            {
                "op": "place.update",
                "refs": {"place_id": self.place_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.place_id, "rev": place_rev, "name": "Shelf A"},
                "label_fr": "n1",
            },
            {
                "op": "place.update",
                "refs": {"place_id": self.place_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.place_id, "rev": place_rev, "name": "Shelf B"},
                "label_fr": "n2",
            },
        ])
        self.assertIn("stale_place_rev", codes)
        self.assertEqual(
            next(p for p in inv.snapshot()["places"] if p["id"] == self.place_id)["name"],
            "Shelf",
        )

    def test_place_delete_with_child_rejected(self) -> None:
        child = inv.apply({
            "action": "place.create",
            "name": "Bin",
            "kind": "box",
            "parent": self.place_id,
        })["place"]
        place_rev = next(p for p in inv.snapshot()["places"] if p["id"] == self.place_id)["rev"]
        codes = self._codes([{
            "op": "place.delete",
            "refs": {"place_id": self.place_id},
            "resolved": {"confidence": "high"},
            "payload": {"id": self.place_id, "rev": place_rev},
            "label_fr": "pdel",
        }])
        self.assertIn("batch_place_not_empty", codes)
        self.assertTrue(any(p["id"] == child["id"] for p in inv.snapshot()["places"]))

    def test_independent_adjust_and_place_rename(self) -> None:
        place_rev = next(p for p in inv.snapshot()["places"] if p["id"] == self.place_id)["rev"]
        op_id = self._session_op([
            {
                "op": "item.adjust",
                "refs": {"item_id": self.item_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.item_id, "delta": -1},
                "label_fr": "adj",
            },
            {
                "op": "place.update",
                "refs": {"place_id": self.place_id},
                "resolved": {"confidence": "high"},
                "payload": {"id": self.place_id, "rev": place_rev, "name": "Top"},
                "label_fr": "ren",
            },
        ])
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        self.assertTrue(val["validation"]["ok"], val)
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "indep-ok"})
        self.assertEqual(c, 200, out)
        snap = inv.snapshot()
        self.assertEqual(snap["items"][0]["qty"], 2)
        self.assertEqual(next(p for p in snap["places"] if p["id"] == self.place_id)["name"], "Top")

    def test_move_ref_item_mismatch(self) -> None:
        other = inv.apply({"action": "item.create", "name": "Beta", "qty": 1})["item"]["id"]
        codes = self._codes([{
            "op": "item.move",
            "refs": {"item_id": self.item_id},
            "resolved": {"confidence": "high"},
            "payload": {"ids": [other], "place": self.place_id},
            "label_fr": "mv",
        }])
        self.assertIn("ref_payload_mismatch", codes)

    def test_move_ref_place_mismatch(self) -> None:
        other = inv.apply({"action": "place.create", "name": "Bin", "kind": "box"})["place"]["id"]
        codes = self._codes([{
            "op": "item.move",
            "refs": {"item_id": self.item_id, "place_id": self.place_id},
            "resolved": {"confidence": "high"},
            "payload": {"ids": [self.item_id], "place": other},
            "label_fr": "mv",
        }])
        self.assertIn("ref_payload_mismatch", codes)

    def test_multi_item_move_preview_lists_targets(self) -> None:
        other = inv.apply({"action": "item.create", "name": "Beta", "qty": 2})["item"]["id"]
        op_id = self._session_op([{
            "op": "item.move",
            "refs": {"place_id": self.place_id},
            "resolved": {"confidence": "high"},
            "payload": {"ids": [self.item_id, other], "place": self.place_id},
            "label_fr": "mv",
        }])
        _, val = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        self.assertTrue(val["validation"]["ok"], val)
        _, prev = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        change = prev["preview"]["changes"][0]
        self.assertEqual([i["id"] for i in change["items"]], [self.item_id, other])
        self.assertEqual(change["destination"]["id"], self.place_id)
        self.assertEqual(change["destination"]["name"], "Shelf")

    def test_f5_after_apply_stays_in_flight_until_reconcile(self) -> None:
        op_id = self._session_op([{
            "op": "item.adjust",
            "refs": {"item_id": self.item_id},
            "resolved": {"confidence": "high"},
            "payload": {"id": self.item_id, "delta": -1},
            "label_fr": "adj",
        }])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})

        def crash_f5(phase: str) -> None:
            if phase == "F5":
                raise icommit.CommitAbort(phase)

        icommit.set_test_hook(crash_f5)
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "f5-ack-key"})
        icommit.set_test_hook(None)
        self.assertEqual(c, 409, out)
        self.assertEqual(next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"], 2)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        with store.open_store(self.root, readonly=True) as st:
            xop = st.conn.execute("SELECT status, uncertain_inventory, planned_steps_json FROM cross_store_ops").fetchone()
            steps = json.loads(xop[2])
            self.assertEqual(xop[0], "needs_reconcile")
            self.assertEqual(int(xop[1]), 1)
            self.assertEqual(steps[0]["attempt_phase"], "in_flight")
            audit = st.conn.execute(
                "SELECT next_status FROM inventoria_operation_audit WHERE operation_id=? AND action='commit'",
                (op_id,),
            ).fetchone()
            self.assertEqual(audit[0], "needs_reconcile")
        c2, out2 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "f5-ack-key"})
        self.assertEqual(c2, 409, out2)
        self.assertEqual(out2.get("code"), "needs_reconcile")
        self.assertEqual(next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"], 2)
        rev = inv.snapshot()["rev"]
        c3, out3 = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/reconcile",
            {
                "decision": "confirm_already_applied",
                "reason": "operator confirms the adjust landed",
                "evidence": {"inventory_rev": rev},
                "step_index": 0,
            },
        )
        self.assertEqual(c3, 200, out3)
        with store.open_store(self.root, readonly=True) as st:
            op = st.conn.execute(
                "SELECT status FROM inventoria_operations WHERE id=?", (op_id,),
            ).fetchone()
            self.assertEqual(op[0], "committed")
        self.assertEqual(next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"], 2)

    def test_inventory_error_503_after_f3b_durable(self) -> None:
        op_id = self._session_op([{
            "op": "item.adjust",
            "refs": {"item_id": self.item_id},
            "resolved": {"confidence": "high"},
            "payload": {"id": self.item_id, "delta": -1},
            "label_fr": "adj",
        }])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})

        def boom(phase: str) -> None:
            if phase == "F4":
                raise inv.InventoryError("stockage indisponible", 503, "storage_error")

        icommit.set_test_hook(boom)
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "err503-key"})
        icommit.set_test_hook(None)
        self.assertEqual(c, 503, out)
        self.assertEqual(out.get("code"), "needs_reconcile")
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 600.0)
        inv.bind(root=self.root, now=lambda: 600.0)
        with store.open_store(self.root, readonly=True) as st:
            xop = st.conn.execute(
                "SELECT status, uncertain_inventory, planned_steps_json FROM cross_store_ops",
            ).fetchone()
            self.assertEqual(xop[0], "needs_reconcile")
            self.assertEqual(int(xop[1]), 1)
            self.assertEqual(json.loads(xop[2])[0]["attempt_phase"], "in_flight")
        c2, out2 = ivo.http_post(f"/api/inventoria/ops/{op_id}/commit", {"idempotency_key": "err503-key"})
        self.assertEqual(c2, 409, out2)
        self.assertEqual(out2.get("code"), "needs_reconcile")
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 3)


if __name__ == "__main__":
    unittest.main()
