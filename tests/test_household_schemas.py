"""Household Intelligence foundations — schema validators (PR #30)."""

from __future__ import annotations

import unittest

import hq_household_schemas as H


def _hex16(n: int = 1) -> str:
    return f"{n:016x}"


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
            "fingerprint": "mch|prd|199",
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
    def _proposal(self):
        return {
            "op": "item.adjust",
            "refs": {"name_hint": "lait"},
            "resolved": {"item_id": "itm-" + _hex16(3), "confidence": "high"},
            "payload": {"id": "itm-" + _hex16(3), "delta": -1},
            "label_fr": "Stock · lait −1",
        }

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


class CrossStoreJournalTests(unittest.TestCase):
    def _op(self, **over):
        base = {
            "id": "xop-" + _hex16(1),
            "kind": "inventoria_commit",
            "status": "preparing",
            "idempotency_key": "idem-xop-0001",
            "request_hash": "a" * 64,
            "planned_steps": [{"store": "inventory", "action": "item.adjust"}],
            "step_index": 0,
            "uncertain_inventory": 0,
        }
        base.update(over)
        return base

    def test_op_ok(self):
        self.assertEqual(H.validate_cross_store_op(self._op())["status"], "preparing")

    def test_committed_with_uncertain_forbidden(self):
        with self.assertRaises(H.SchemaError):
            H.validate_cross_store_op(self._op(status="committed", uncertain_inventory=1))

    def test_never_auto_replay_uncertain_adjust(self):
        self.assertFalse(
            H.may_auto_replay_inventory_step(action="item.adjust", uncertain_inventory=True)
        )
        self.assertTrue(
            H.may_auto_replay_inventory_step(action="item.adjust", uncertain_inventory=False)
        )


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
            "unit_price_cents_per_canonical": H.unit_price_cents(price, qty),
            "promo": {"kind": "none"},
            "tax_included": False,
            "deposit_cents": 0,
            "collected_at": 1790000000.0,
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

    def test_unit_price_mismatch(self):
        with self.assertRaises(H.SchemaError):
            H.validate_price_offer(self._offer(unit_price_cents_per_canonical=1))

    def test_freshness_expired(self):
        self.assertEqual(H.offer_freshness(self._offer(), now_day="2026-11-20"), "expired")
        self.assertEqual(H.offer_freshness(self._offer(), now_day="2026-11-10"), "fresh")


if __name__ == "__main__":
    unittest.main()
