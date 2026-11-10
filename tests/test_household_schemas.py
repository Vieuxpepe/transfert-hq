"""Household Intelligence foundations — schema validators (PR #30)."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

import hq_household_schemas as H

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "schemas" / "household"


def _hex16(n: int = 1) -> str:
    return f"{n:016x}"


def _sha(n: int = 1) -> str:
    return f"{n:064x}"


class CentsTests(unittest.TestCase):
    def test_accepts_int(self):
        self.assertEqual(H.require_cents(349), 349)
        self.assertEqual(H.require_cents(-1200), -1200)

    def test_rejects_float_and_bool(self):
        with self.assertRaises(H.SchemaError):
            H.require_cents(3.49)
        with self.assertRaises(H.SchemaError):
            H.require_cents(True)
        with self.assertRaises(H.SchemaError):
            H.require_cents("349")


class CalendarDateTests(unittest.TestCase):
    def test_rejects_impossible_day(self):
        with self.assertRaises(H.SchemaError):
            H.require_iso_date("2026-02-30", "d")

    def test_accepts_real_day(self):
        self.assertEqual(H.require_iso_date("2026-02-28", "d"), "2026-02-28")


class BoolTests(unittest.TestCase):
    def test_strict_bool(self):
        self.assertTrue(H.require_bool(True, "f"))
        with self.assertRaises(H.SchemaError):
            H.require_bool(1, "f")
        with self.assertRaises(H.SchemaError):
            H.require_bool(0, "f")


class FinancesTests(unittest.TestCase):
    def test_transaction_ok(self):
        tx = {
            "id": "tx-" + _hex16(1),
            "household_id": "hhold-" + _hex16(1),
            "account_id": "acct-" + _hex16(1),
            "category_id": "cat-" + _hex16(1),
            "booked_on": "2026-11-09",
            "amount_cents": -1250,
            "status": "posted",
            "source": "manual",
            "rev": 1,
            "idempotency_key": "idem-tx-0001",
        }
        self.assertEqual(H.validate_transaction(tx)["amount_cents"], -1250)

    def test_import_requires_idempotency(self):
        tx = {
            "id": "tx-" + _hex16(3),
            "household_id": "hhold-" + _hex16(1),
            "account_id": "acct-" + _hex16(1),
            "category_id": "cat-" + _hex16(1),
            "booked_on": "2026-11-09",
            "amount_cents": -100,
            "status": "posted",
            "source": "import",
            "rev": 1,
        }
        with self.assertRaises(H.SchemaError):
            H.validate_transaction(tx)

    def test_transaction_rejects_float_amount(self):
        tx = {
            "id": "tx-" + _hex16(2),
            "household_id": "hhold-" + _hex16(1),
            "account_id": "acct-" + _hex16(1),
            "category_id": "cat-" + _hex16(1),
            "booked_on": "2026-11-09",
            "amount_cents": 12.50,
            "status": "posted",
            "source": "manual",
            "rev": 1,
        }
        with self.assertRaises(H.SchemaError):
            H.validate_transaction(tx)


class GroceryTests(unittest.TestCase):
    def test_food_lot_usable_bound(self):
        lot = {
            "id": "lot-" + _hex16(1),
            "product_id": "prd-" + _hex16(1),
            "qty_milli": 1000000,
            "usable_qty_milli": 1000001,
            "canonical_unit": "g",
            "rev": 1,
        }
        with self.assertRaises(H.SchemaError):
            H.validate_food_lot(lot)

    def test_food_lot_links_inventory_ids(self):
        lot = {
            "id": "lot-" + _hex16(2),
            "product_id": "prd-" + _hex16(1),
            "qty_milli": 500000,
            "usable_qty_milli": 500000,
            "canonical_unit": "ml",
            "item_id": "itm-" + _hex16(9),
            "place_id": "plc-" + _hex16(9),
            "expires_on": "2026-12-01",
            "rev": 1,
        }
        self.assertEqual(H.validate_food_lot(lot)["item_id"], "itm-" + _hex16(9))

    def test_actual_purchase_requires_idempotency(self):
        pur = {
            "id": "pur-" + _hex16(1),
            "merchant_id": "mch-" + _hex16(1),
            "qty_milli": 1000,
            "unit": "each",
            "paid_cents": 199,
            "purchased_on": "2026-11-09",
            "fingerprint": "mch|prd|199|line1",
            "rev": 1,
        }
        with self.assertRaises(H.SchemaError):
            H.validate_actual_purchase(pur)


class MealsTests(unittest.TestCase):
    def test_recipe_ok(self):
        rcp = {
            "id": "rcp-" + _hex16(1),
            "title": "Pâtes simples",
            "servings": 2,
            "ingredients": [{"name": "pâtes", "qty_milli": 200000, "unit": "g"}],
            "steps": ["Bouillir", "Servir"],
            "leftover_policy": "plan_next",
            "rev": 1,
        }
        self.assertEqual(H.validate_recipe(rcp)["servings"], 2)


class InventoriaTests(unittest.TestCase):
    def _proposal(self, **over):
        base = {
            "op": "item.adjust",
            "refs": {"name_hint": "lait"},
            "resolved": {"item_id": "itm-" + _hex16(3), "confidence": "high"},
            "payload": {"id": "itm-" + _hex16(3), "delta": -1},
            "label_fr": "Stock · lait −1",
        }
        base.update(over)
        return base

    def test_pipeline_constant(self):
        self.assertEqual(H.PIPELINE, ("propose", "validate", "preview", "commit", "audit"))

    def test_operation_commit_needs_rev_expectations(self):
        op = {
            "id": "iop-" + _hex16(1),
            "session_id": "ivo-" + _hex16(1),
            "status": "committing",
            "proposals": [self._proposal()],
            "idempotency_key": "idem-ivo-0001",
            "created_at": 1.0,
            "updated_at": 1.0,
        }
        with self.assertRaises(H.SchemaError):
            H.validate_inventoria_operation(op)

    def test_operation_ok_with_store_rev(self):
        op = {
            "id": "iop-" + _hex16(2),
            "session_id": "ivo-" + _hex16(1),
            "status": "previewed",
            "proposals": [self._proposal()],
            "idempotency_key": "idem-ivo-0002",
            "expected_inventory_rev": 12,
            "created_at": 1.0,
            "updated_at": 2.0,
        }
        self.assertEqual(H.validate_inventoria_operation(op)["status"], "previewed")

    def test_rejects_arbitrary_llm_payload(self):
        with self.assertRaises(H.SchemaError):
            H.validate_inventoria_proposal(self._proposal(payload={"id": "itm-" + _hex16(3), "delta": -1, "hack": True}))
        with self.assertRaises(H.SchemaError):
            H.validate_inventoria_proposal(self._proposal(op="item.update", payload={"id": "itm-" + _hex16(3)}))

    def test_item_update_payload_requires_rev(self):
        p = self._proposal(
            op="item.update",
            payload={"id": "itm-" + _hex16(3), "rev": 2, "name": "Lait"},
            label_fr="Maj lait",
        )
        self.assertEqual(H.validate_inventoria_proposal(p)["op"], "item.update")


class CrossStoreJournalTests(unittest.TestCase):
    def _op(self, **over):
        base = {
            "id": "xop-" + _hex16(1),
            "kind": "inventoria_commit",
            "status": "preparing",
            "idempotency_key": "idem-xop-0001",
            "request_hash": _sha(1),
            "planned_steps": [
                {
                    "store": "inventory",
                    "action": "item.adjust",
                    "attempt_phase": "not_started",
                    "payload": {"id": "itm-" + _hex16(3), "delta": -1},
                }
            ],
            "step_index": 0,
            "uncertain_inventory": 0,
        }
        base.update(over)
        return base

    def test_op_ok(self):
        self.assertEqual(H.validate_cross_store_op(self._op())["status"], "preparing")

    def test_id_and_hash_format(self):
        with self.assertRaises(H.SchemaError):
            H.validate_cross_store_op(self._op(id="xop-bad"))
        with self.assertRaises(H.SchemaError):
            H.validate_cross_store_op(self._op(request_hash="abc"))

    def test_step_index_bounds(self):
        with self.assertRaises(H.SchemaError):
            H.validate_cross_store_op(self._op(step_index=2))
        ok = self._op(status="committed", step_index=1, planned_steps=[
            {"store": "sqlite", "action": "mark_lot"},
        ])
        self.assertEqual(H.validate_cross_store_op(ok)["step_index"], 1)

    def test_committed_with_uncertain_forbidden(self):
        with self.assertRaises(H.SchemaError):
            H.validate_cross_store_op(self._op(status="committed", step_index=1, uncertain_inventory=1))

    def test_uncertain_rejects_bool(self):
        with self.assertRaises(H.SchemaError):
            H.validate_cross_store_op(self._op(uncertain_inventory=True))

    def test_in_flight_adjust_never_auto_replay(self):
        self.assertFalse(
            H.may_auto_replay_inventory_step(
                action="item.adjust", uncertain_inventory=0, attempt_phase="in_flight"
            )
        )
        self.assertEqual(
            H.recovery_for_inventory_step(action="item.adjust", attempt_phase="in_flight"),
            "needs_reconcile",
        )

    def test_not_started_may_start_once(self):
        self.assertTrue(
            H.may_auto_replay_inventory_step(
                action="item.adjust", uncertain_inventory=0, attempt_phase="not_started"
            )
        )
        self.assertEqual(
            H.recovery_for_inventory_step(action="item.adjust", attempt_phase="not_started"),
            "may_start_once",
        )

    def test_acknowledged_skip(self):
        self.assertFalse(
            H.may_auto_replay_inventory_step(
                action="item.adjust", uncertain_inventory=0, attempt_phase="acknowledged"
            )
        )
        self.assertEqual(
            H.recovery_for_inventory_step(action="item.adjust", attempt_phase="acknowledged"),
            "skip_already_acknowledged",
        )

    def test_global_rev_not_an_api_parameter(self):
        # recovery helpers must not accept inventory_rev — signature check
        import inspect
        sig = inspect.signature(H.recovery_for_inventory_step)
        self.assertNotIn("inventory_rev", sig.parameters)
        self.assertNotIn("rev", sig.parameters)


class PriceOfferTests(unittest.TestCase):
    def _offer(self, **over):
        price, qty = 349, 1000000
        base = {
            "schema_version": 1,
            "id": "off-" + _hex16(1),
            "merchant_id": "mch-" + _hex16(1),
            "merchant_name": "Marché local",
            "product_name": "Lait 1L",
            "price_cents": price,
            "qty_milli": qty,
            "unit": "ml",
            "unit_price_ratio": H.unit_price_ratio(price, qty),
            "promo": {"kind": "none"},
            "tax_included": False,
            "deposit_cents": 0,
            "collected_at": 1790000000.0,
            "collected_on": "2026-11-01",
            "valid_to": "2026-11-16",
            "provenance": {
                "kind": "manual",
                "provider_id": "manual",
                "source_label": "saisie",
                "verifiable": True,
            },
            "reliability": 80,
            "stale_after_days": 14,
            "rev": 1,
        }
        base.update(over)
        return base

    def test_offer_ok(self):
        self.assertEqual(H.validate_price_offer(self._offer())["reliability"], 80)

    def test_ratio_preserves_small_unit_prices(self):
        # 199¢ for 500g → must not collapse to 0¢/g
        price, qty = 199, 500_000
        ratio = H.unit_price_ratio(price, qty)
        self.assertEqual(ratio["cents_num"], 199)
        self.assertEqual(ratio["qty_milli_den"], 500_000)
        disp = H.format_unit_price_display(price, qty, "g")
        self.assertEqual(disp["display_per"], "kg")
        self.assertGreater(disp["display_cents"], 0)
        # deprecated truncating helper must fail closed
        with self.assertRaises(H.SchemaError):
            H.unit_price_cents(price, qty)

    def test_compare_ratios_exact(self):
        a = H.unit_price_ratio(100, 1000)
        b = H.unit_price_ratio(200, 2000)
        self.assertEqual(H.compare_unit_price_ratios(a, b), 0)
        c = H.unit_price_ratio(101, 1000)
        self.assertEqual(H.compare_unit_price_ratios(c, a), 1)

    def test_ratio_mismatch(self):
        with self.assertRaises(H.SchemaError):
            H.validate_price_offer(self._offer(unit_price_ratio={"cents_num": 1, "qty_milli_den": 1}))

    def test_freshness_expired_stale_fresh(self):
        self.assertEqual(H.offer_freshness(self._offer(), now_day="2026-11-20"), "expired")
        # valid_to still ok, but age > stale_after_days (14) from 2026-11-01
        self.assertEqual(H.offer_freshness(self._offer(valid_to=None), now_day="2026-11-20"), "stale")
        self.assertEqual(H.offer_freshness(self._offer(), now_day="2026-11-05"), "fresh")


class ContractDescriptorTests(unittest.TestCase):
    def test_seven_descriptors_load(self):
        docs = H.load_contract_descriptors(ROOT)
        self.assertEqual(len(docs), 7)
        for name, doc in docs.items():
            path = SCHEMAS / name
            self.assertTrue(path.is_file(), name)
            self.assertEqual(doc.get("contract_format"), "hq-custom-descriptor", name)
            self.assertIs(doc.get("not_json_schema"), True, name)

    def test_concordance_statuses_and_phases(self):
        cross = json.loads((SCHEMAS / "cross_store_op.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(set(cross["statuses"]), H.CROSS_STORE_STATUSES)
        self.assertEqual(set(cross["terminal"]), H.CROSS_STORE_TERMINAL)
        self.assertEqual(set(cross["kinds"]), H.CROSS_STORE_KINDS)
        self.assertEqual(set(cross["inventory_attempt_phases"]), H.INVENTORY_ATTEMPT_PHASES)
        common = json.loads((SCHEMAS / "common.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(set(common["canonical_units"]), H.CANONICAL_UNITS)
        price = json.loads((SCHEMAS / "price_offer.v1.json").read_text(encoding="utf-8"))
        self.assertIn("unit_price_ratio", price["required"])
        self.assertNotIn("unit_price_cents_per_canonical", price["required"])
        inv = json.loads((SCHEMAS / "inventoria.v1.json").read_text(encoding="utf-8"))
        self.assertEqual(tuple(inv["pipeline"]), H.PIPELINE)


if __name__ == "__main__":
    unittest.main()
