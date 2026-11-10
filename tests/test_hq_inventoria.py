"""Inventoria pipeline — state machine and no-write guarantees."""

from __future__ import annotations

import json
import secrets
import tempfile
import unittest
from pathlib import Path

import hq_finances as fin
import hq_household_store as store
import hq_inventoria as ivo
import hq_inventory as inv


def _hex16(n: int) -> str:
    return secrets.token_hex(8)[: n]


class InventoriaPipelineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="ivo-pipe-")
        self.root = Path(self.tmp.name)
        store.set_acl_for_tests(False)
        fin.bind(root=self.root, actor=lambda: "t", now=lambda: 100.0)
        inv.bind(root=self.root, now=lambda: 100.0)
        ivo.bind(root=self.root, actor=lambda: "t", now=lambda: 100.0)
        inv.apply({"action": "item.create", "name": "Lait", "qty": 5, "unit": "pcs"})
        self.item_id = inv.snapshot()["items"][0]["id"]

    def tearDown(self) -> None:
        ivo.reset_for_tests()
        inv.bind(root=self.root)
        fin.reset_for_tests()
        store.set_acl_for_tests(True)
        self.tmp.cleanup()

    def _proposal(self, **kw) -> dict:
        base = {
            "op": "item.adjust",
            "refs": {"name_hint": "Lait"},
            "resolved": {"item_id": self.item_id, "confidence": "high"},
            "payload": {"id": self.item_id, "delta": -1},
            "label_fr": "Lait −1",
        }
        base.update(kw)
        return base

    def _through_preview(self) -> str:
        code, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d1", "owner": "t"})
        self.assertEqual(code, 200, out)
        sid = out["session"]["id"]
        code2, out2 = ivo.http_post(
            f"/api/inventoria/sessions/{sid}/message",
            {"proposals": [self._proposal()]},
        )
        self.assertEqual(code2, 200, out2)
        op_id = out2["operation"]["id"]
        rev_before = inv.snapshot()["rev"]
        c3, _ = ivo.http_post(f"/api/inventoria/ops/{op_id}/validate", {})
        self.assertEqual(c3, 200)
        self.assertEqual(inv.snapshot()["rev"], rev_before)
        c4, out4 = ivo.http_post(f"/api/inventoria/ops/{op_id}/preview", {"confirm": True})
        self.assertEqual(c4, 200, out4)
        self.assertEqual(inv.snapshot()["rev"], rev_before)
        self.assertEqual(out4["operation"]["status"], "previewed")
        return op_id

    def test_state_machine_through_commit(self) -> None:
        op_id = self._through_preview()
        qty0 = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        dig = None
        with store.open_store(self.root, readonly=True) as st:
            row = st.conn.execute(
                "SELECT preview_digest, expected_inventory_rev FROM inventoria_operations WHERE id = ?",
                (op_id,),
            ).fetchone()
            dig = row["preview_digest"]
            exp = row["expected_inventory_rev"]
        c5, out5 = ivo.http_post(
            f"/api/inventoria/ops/{op_id}/commit",
            {"idempotency_key": "idem-ivo-1", "expected_inventory_rev": exp, "preview_digest": dig},
        )
        self.assertEqual(c5, 200, out5)
        qty1 = next(i for i in inv.snapshot()["items"] if i["id"] == self.item_id)["qty"]
        self.assertEqual(qty1, qty0 - 1)
        with store.open_store(self.root, readonly=True) as st:
            st_row = st.conn.execute(
                "SELECT status FROM inventoria_operations WHERE id = ?", (op_id,),
            ).fetchone()
            self.assertEqual(st_row["status"], "committed")

    def test_draft_never_writes_inventory(self) -> None:
        code, out = ivo.http_post("/api/inventoria/sessions", {"device_id": "d1"})
        self.assertEqual(code, 200)
        sid = out["session"]["id"]
        rev = inv.snapshot()["rev"]
        ivo.http_post(f"/api/inventoria/sessions/{sid}/message", {"proposals": [self._proposal()]})
        self.assertEqual(inv.snapshot()["rev"], rev)

    def test_cancel_before_commit(self) -> None:
        op_id = self._through_preview()
        c, out = ivo.http_post(f"/api/inventoria/ops/{op_id}/cancel", {})
        self.assertEqual(c, 200, out)
        self.assertEqual(out["operation"]["status"], "cancelled")
