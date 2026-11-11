"""Inventoria audit corrective — confirmation, stale preview, validation, exploits."""

from __future__ import annotations

import secrets
import tempfile
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventory as inv


class InventoriaAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-audit-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 300.0)
        inv.bind(root=self.root, now=lambda: 300.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 300.0)
        inv.apply({"action": "item.create", "name": "Milk", "qty": 5})
        inv.apply({"action": "item.create", "name": "Milk", "qty": 3})
        self.items = inv.snapshot()["items"]

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _adj(self, item_id: str, delta: int = -1) -> dict:
        return {
            "op": "item.adjust",
            "refs": {"item_id": item_id},
            "resolved": {"confidence": "high"},
            "payload": {"id": item_id, "delta": delta},
            "label_fr": "adj",
        }

    def _op_with_proposals(self, proposals: list[dict]) -> str:
        c, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d"})
        sid = out["session"]["id"]
        _, out2 = ivo.http_post(
            f"/api/inventoria/sessions/{sid}/message",
            {"proposals": proposals},
        )
        return out2["operation"]["id"]

    def test_preview_without_confirm_rejects_commit(self) -> None:
        op_id = self._op_with_proposals([self._adj(self.items[0]["id"])])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        rev = inv.snapshot()["rev"]
        c, _ = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {})
        self.assertEqual(c, 200)
        self.assertEqual(inv.snapshot()["rev"], rev)
        c2, out2 = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/commit",
            {"idempotency_key": "no-confirm-key"},
        )
        self.assertEqual(c2, 409, out2)
        self.assertEqual(out2.get("code"), "conflict")

    def test_preview_confirm_rejects_string_false(self) -> None:
        op_id = self._op_with_proposals([self._adj(self.items[0]["id"])])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": "false"})
        self.assertEqual(c, 400, out)

    def test_client_cannot_override_persisted_rev_on_commit(self) -> None:
        op_id = self._op_with_proposals([self._adj(self.items[0]["id"])])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        rev = inv.snapshot()["rev"]
        inv.apply({"action": "item.create", "name": "Z", "qty": 1})
        self.assertNotEqual(inv.snapshot()["rev"], rev)
        c, out = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/commit",
            {"idempotency_key": "stale-rev"},
        )
        self.assertEqual(c, 409, out)
        self.assertEqual(out.get("code"), "conflict")
        self.assertEqual(inv.snapshot()["rev"], rev + 1)

    def test_ambiguous_name_blocks_validation(self) -> None:
        op_id = self._op_with_proposals([{
            "op": "item.adjust",
            "refs": {"name_hint": "Milk"},
            "resolved": {"confidence": "high"},
            "payload": {"id": self.items[0]["id"], "delta": -1},
            "label_fr": "milk",
        }])
        _, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        self.assertFalse(out["validation"]["ok"])
        c2, _ = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        self.assertEqual(c2, 409)

    def test_negative_adjust_blocked_at_preview(self) -> None:
        op_id = self._op_with_proposals([self._adj(self.items[0]["id"], delta=-100)])
        ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        self.assertEqual(c, 409, out)
        self.assertEqual(inv.snapshot()["items"][0]["qty"], 5)


if __name__ == "__main__":
    unittest.main()
