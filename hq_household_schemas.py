"""Transfert HQ — Household Intelligence schema validators (foundations only).

Stdlib-only contracts for Finances / Grocery / Meals / Inventoria / price offers.
No persistence, no bridge routes, no LLM calls. Money is integer cents; quantities
use non-negative milli-units of an explicit canonical unit.
"""

from __future__ import annotations

import re
from typing import Any

SCHEMA_VERSION = 1

CANONICAL_UNITS = frozenset({"g", "ml", "each", "serving"})
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")
ID_RES = {
    "household": re.compile(r"^hhold-[0-9a-f]{16}\Z"),
    "account": re.compile(r"^acct-[0-9a-f]{16}\Z"),
    "category": re.compile(r"^cat-[0-9a-f]{16}\Z"),
    "transaction": re.compile(r"^tx-[0-9a-f]{16}\Z"),
    "envelope": re.compile(r"^env-[0-9a-f]{16}\Z"),
    "goal": re.compile(r"^goal-[0-9a-f]{16}\Z"),
    "product": re.compile(r"^prd-[0-9a-f]{16}\Z"),
    "lot": re.compile(r"^lot-[0-9a-f]{16}\Z"),
    "merchant": re.compile(r"^mch-[0-9a-f]{16}\Z"),
    "offer": re.compile(r"^off-[0-9a-f]{16}\Z"),
    "recipe": re.compile(r"^rcp-[0-9a-f]{16}\Z"),
    "meal_plan": re.compile(r"^mpl-[0-9a-f]{16}\Z"),
    "grocery_list": re.compile(r"^glst-[0-9a-f]{16}\Z"),
    "purchase": re.compile(r"^pur-[0-9a-f]{16}\Z"),
    "inventoria_session": re.compile(r"^ivo-[0-9a-f]{16}\Z"),
    "inventoria_op": re.compile(r"^iop-[0-9a-f]{16}\Z"),
    "inventory_item": re.compile(r"^itm-[0-9a-f]{16}\Z"),
    "inventory_place": re.compile(r"^plc-[0-9a-f]{16}\Z"),
}

INVENTORIA_OP_STATUS = frozenset({
    "draft", "validated", "previewed", "committing", "committed",
    "needs_reconcile", "cancelled", "failed",
})
INVENTORIA_PROPOSAL_OPS = frozenset({
    "item.adjust", "item.create", "item.update", "item.move", "item.delete",
    "place.create", "place.update", "place.delete",
})
PIPELINE = ("propose", "validate", "preview", "commit", "audit")

CROSS_STORE_STATUSES = frozenset({
    "accepted",
    "preparing",
    "applying_sqlite",
    "applying_inventory",
    "finalizing",
    "committed",
    "needs_reconcile",
    "failed",
    "cancelled",
})
CROSS_STORE_TERMINAL = frozenset({"committed", "needs_reconcile", "failed", "cancelled"})
CROSS_STORE_KINDS = frozenset({
    "inventoria_commit",
    "grocery_purchase",
    "lot_consume",
})
# item.adjust must never be auto-replayed when uncertain_inventory is set.
NO_AUTO_REPLAY_INVENTORY_ACTIONS = frozenset({"item.adjust"})


class SchemaError(ValueError):
    """Invalid household contract payload."""

    def __init__(self, msg: str, *, code: str = "validation_error"):
        super().__init__(msg)
        self.code = code


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def require_cents(v: Any, field: str = "amount_cents", *, min_value: int | None = None) -> int:
    """Refuse floats/bools — balances must stay integer cents."""
    if isinstance(v, float):
        raise SchemaError(f"{field} refuse les flottants — utiliser des centimes entiers")
    if not _is_int(v):
        raise SchemaError(f"{field} doit être un entier (centimes)")
    if min_value is not None and v < min_value:
        raise SchemaError(f"{field} hors bornes")
    return v


def require_qty_milli(v: Any, field: str = "qty_milli", *, min_value: int = 0) -> int:
    if isinstance(v, float):
        raise SchemaError(f"{field} refuse les flottants — utiliser des milli-unités entières")
    if not _is_int(v) or v < min_value:
        raise SchemaError(f"{field} invalide")
    return v


def require_id(v: Any, kind: str, field: str = "id") -> str:
    rx = ID_RES[kind]
    if not isinstance(v, str) or rx.match(v) is None:
        raise SchemaError(f"{field} invalide ({kind})")
    return v


def require_iso_date(v: Any, field: str) -> str:
    if not isinstance(v, str) or ISO_DATE.match(v) is None:
        raise SchemaError(f"{field} doit être AAAA-MM-JJ")
    return v


def require_unit(v: Any, field: str = "unit") -> str:
    if not isinstance(v, str) or v not in CANONICAL_UNITS:
        raise SchemaError(f"{field} doit être une unité canonique {sorted(CANONICAL_UNITS)}")
    return v


def require_idempotency_key(v: Any, field: str = "idempotency_key") -> str:
    if not isinstance(v, str) or not (8 <= len(v) <= 128):
        raise SchemaError(f"{field} requis (8–128 caractères)")
    return v


def unit_price_cents(price_cents: int, qty_milli: int) -> int:
    """Integer unit price: cents per canonical unit (floor division)."""
    if qty_milli <= 0:
        raise SchemaError("qty_milli doit être > 0 pour un prix unitaire")
    return (price_cents * 1000) // qty_milli


def validate_household(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("household invalide")
    if doc.get("schema_version") != SCHEMA_VERSION:
        raise SchemaError("schema_version household doit être 1")
    require_id(doc.get("id"), "household")
    if not isinstance(doc.get("name"), str) or not (0 < len(doc["name"]) <= 120):
        raise SchemaError("name household invalide")
    if doc.get("currency") not in ("CAD", "USD", "EUR"):
        raise SchemaError("currency invalide")
    return doc


def validate_transaction(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("transaction invalide")
    require_id(doc.get("id"), "transaction")
    require_id(doc.get("household_id"), "household", "household_id")
    require_id(doc.get("account_id"), "account", "account_id")
    require_id(doc.get("category_id"), "category", "category_id")
    require_iso_date(doc.get("booked_on"), "booked_on")
    require_cents(doc.get("amount_cents"))
    if doc.get("status") not in ("posted", "pending", "void"):
        raise SchemaError("status transaction invalide")
    if doc.get("source") not in ("manual", "import", "grocery_purchase", "inventoria", "correction"):
        raise SchemaError("source transaction invalide")
    if not _is_int(doc.get("rev")) or doc["rev"] < 1:
        raise SchemaError("rev transaction invalide")
    if doc.get("idempotency_key") is not None:
        require_idempotency_key(doc["idempotency_key"])
    return doc


def validate_food_lot(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("food_lot invalide")
    require_id(doc.get("id"), "lot")
    require_id(doc.get("product_id"), "product", "product_id")
    qty = require_qty_milli(doc.get("qty_milli"))
    usable = require_qty_milli(doc.get("usable_qty_milli"))
    if usable > qty:
        raise SchemaError("usable_qty_milli ne peut pas dépasser qty_milli")
    require_unit(doc.get("canonical_unit"), "canonical_unit")
    if doc.get("item_id") is not None:
        require_id(doc["item_id"], "inventory_item", "item_id")
    if doc.get("place_id") is not None:
        require_id(doc["place_id"], "inventory_place", "place_id")
    if doc.get("expires_on") is not None:
        require_iso_date(doc["expires_on"], "expires_on")
    if not _is_int(doc.get("rev")) or doc["rev"] < 1:
        raise SchemaError("rev food_lot invalide")
    return doc


def validate_actual_purchase(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("actual_purchase invalide")
    require_id(doc.get("id"), "purchase")
    require_id(doc.get("merchant_id"), "merchant", "merchant_id")
    require_qty_milli(doc.get("qty_milli"), min_value=1)
    require_unit(doc.get("unit"))
    require_cents(doc.get("paid_cents"), "paid_cents", min_value=0)
    if "taxed_cents" in doc:
        require_cents(doc.get("taxed_cents"), "taxed_cents", min_value=0)
    if "deposit_cents" in doc:
        require_cents(doc.get("deposit_cents"), "deposit_cents", min_value=0)
    require_iso_date(doc.get("purchased_on"), "purchased_on")
    if not isinstance(doc.get("fingerprint"), str) or not (1 <= len(doc["fingerprint"]) <= 200):
        raise SchemaError("fingerprint requis")
    require_idempotency_key(doc.get("idempotency_key"))
    if not _is_int(doc.get("rev")) or doc["rev"] < 1:
        raise SchemaError("rev actual_purchase invalide")
    return doc


def validate_recipe(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("recipe invalide")
    require_id(doc.get("id"), "recipe")
    if not isinstance(doc.get("title"), str) or not (0 < len(doc["title"]) <= 160):
        raise SchemaError("title recipe invalide")
    if not _is_int(doc.get("servings")) or not (1 <= doc["servings"] <= 100):
        raise SchemaError("servings invalide")
    if not isinstance(doc.get("ingredients"), list) or len(doc["ingredients"]) > 100:
        raise SchemaError("ingredients invalides")
    for ing in doc["ingredients"]:
        if not isinstance(ing, dict):
            raise SchemaError("ingredient invalide")
        require_qty_milli(ing.get("qty_milli"), "ingredient.qty_milli")
        require_unit(ing.get("unit"), "ingredient.unit")
    if not isinstance(doc.get("steps"), list) or len(doc["steps"]) > 80:
        raise SchemaError("steps invalides")
    if doc.get("leftover_policy") not in ("none", "freeze", "plan_next"):
        raise SchemaError("leftover_policy invalide")
    if not _is_int(doc.get("rev")) or doc["rev"] < 1:
        raise SchemaError("rev recipe invalide")
    return doc


def validate_inventoria_operation(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("inventoria operation invalide")
    require_id(doc.get("id"), "inventoria_op")
    require_id(doc.get("session_id"), "inventoria_session", "session_id")
    if doc.get("status") not in INVENTORIA_OP_STATUS:
        raise SchemaError("status inventoria invalide")
    require_idempotency_key(doc.get("idempotency_key"))
    proposals = doc.get("proposals")
    if not isinstance(proposals, list) or len(proposals) > 20:
        raise SchemaError("proposals invalides (max 20)")
    for p in proposals:
        validate_inventoria_proposal(p)
    if doc["status"] in ("committing", "committed") and doc.get("expected_inventory_rev") is None:
        # recommended; soft check — still allow if item_rev_expectations present
        if not doc.get("item_rev_expectations"):
            raise SchemaError("commit inventoria exige expected_inventory_rev ou item_rev_expectations")
    return doc


def validate_inventoria_proposal(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("proposal invalide")
    if doc.get("op") not in INVENTORIA_PROPOSAL_OPS:
        raise SchemaError("op proposal inconnue")
    if not isinstance(doc.get("refs"), dict) or not isinstance(doc.get("resolved"), dict):
        raise SchemaError("refs/resolved requis")
    conf = doc["resolved"].get("confidence")
    if conf not in ("high", "medium", "low"):
        raise SchemaError("resolved.confidence invalide")
    if not isinstance(doc.get("payload"), dict):
        raise SchemaError("payload proposal requis")
    if not isinstance(doc.get("label_fr"), str) or not doc["label_fr"].strip():
        raise SchemaError("label_fr requis")
    return doc


def validate_price_offer(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("price_offer invalide")
    if doc.get("schema_version") != SCHEMA_VERSION:
        raise SchemaError("schema_version price_offer doit être 1")
    require_id(doc.get("id"), "offer")
    require_id(doc.get("merchant_id"), "merchant", "merchant_id")
    if not isinstance(doc.get("merchant_name"), str) or not doc["merchant_name"].strip():
        raise SchemaError("merchant_name requis")
    if not isinstance(doc.get("product_name"), str) or not doc["product_name"].strip():
        raise SchemaError("product_name requis")
    price = require_cents(doc.get("price_cents"), "price_cents", min_value=0)
    qty = require_qty_milli(doc.get("qty_milli"), min_value=1)
    require_unit(doc.get("unit"))
    expected = unit_price_cents(price, qty)
    got = require_cents(doc.get("unit_price_cents_per_canonical"), "unit_price_cents_per_canonical", min_value=0)
    if got != expected:
        raise SchemaError(
            f"unit_price_cents_per_canonical incohérent (attendu {expected}, reçu {got})"
        )
    promo = doc.get("promo")
    if not isinstance(promo, dict) or promo.get("kind") not in ("none", "percent", "bogo", "multi", "other"):
        raise SchemaError("promo invalide")
    if doc.get("tax_included") not in (True, False):
        raise SchemaError("tax_included invalide")
    require_cents(doc.get("deposit_cents"), "deposit_cents", min_value=0)
    if not isinstance(doc.get("collected_at"), (int, float)) or isinstance(doc.get("collected_at"), bool):
        raise SchemaError("collected_at invalide")
    prov = doc.get("provenance")
    if not isinstance(prov, dict) or prov.get("kind") not in ("manual", "file_import", "provider"):
        raise SchemaError("provenance invalide")
    if not isinstance(prov.get("provider_id"), str) or not prov["provider_id"]:
        raise SchemaError("provenance.provider_id requis")
    if prov.get("verifiable") not in (True, False):
        raise SchemaError("provenance.verifiable invalide")
    if not _is_int(doc.get("reliability")) or not (0 <= doc["reliability"] <= 100):
        raise SchemaError("reliability invalide")
    if not _is_int(doc.get("stale_after_days")) or not (1 <= doc["stale_after_days"] <= 365):
        raise SchemaError("stale_after_days invalide")
    if not _is_int(doc.get("rev")) or doc["rev"] < 1:
        raise SchemaError("rev price_offer invalide")
    return doc


def validate_cross_store_op(doc: Any) -> dict:
    """Journal row for SQLite↔inventory JSON coordination (foundations contract)."""
    if not isinstance(doc, dict):
        raise SchemaError("cross_store_op invalide")
    if not isinstance(doc.get("id"), str) or not doc["id"].startswith("xop-"):
        # allow full hex check loosely via length
        if not (isinstance(doc.get("id"), str) and len(doc["id"]) >= 8):
            raise SchemaError("id cross_store_op invalide")
    if doc.get("kind") not in CROSS_STORE_KINDS:
        raise SchemaError("kind cross_store_op invalide")
    if doc.get("status") not in CROSS_STORE_STATUSES:
        raise SchemaError("status cross_store_op invalide")
    require_idempotency_key(doc.get("idempotency_key"))
    if not isinstance(doc.get("request_hash"), str) or len(doc["request_hash"]) < 32:
        raise SchemaError("request_hash requis")
    if not isinstance(doc.get("planned_steps"), list):
        raise SchemaError("planned_steps requis")
    if not _is_int(doc.get("step_index")) or doc["step_index"] < 0:
        raise SchemaError("step_index invalide")
    uncertain = doc.get("uncertain_inventory", 0)
    if uncertain not in (0, 1, False, True):
        raise SchemaError("uncertain_inventory invalide")
    uncertain_flag = 1 if uncertain in (1, True) else 0
    if uncertain_flag and doc.get("status") not in ("needs_reconcile", "applying_inventory", "finalizing"):
        # once uncertain, only reconcile-oriented statuses (or still mid-flight before mark)
        if doc.get("status") in CROSS_STORE_TERMINAL - {"needs_reconcile"}:
            raise SchemaError("uncertain_inventory incompatible avec status terminal non-reconcile")
    if uncertain_flag and doc.get("status") == "committed":
        raise SchemaError("committed interdit si uncertain_inventory")
    return doc


def may_auto_replay_inventory_step(*, action: str, uncertain_inventory: bool) -> bool:
    """False when replaying would risk double-applying an inventory delta."""
    if uncertain_inventory and action in NO_AUTO_REPLAY_INVENTORY_ACTIONS:
        return False
    if uncertain_inventory:
        return False
    return True


def offer_freshness(offer: dict, *, now_day: str) -> str:
    """Return fresh|stale|expired for a validated offer (date-only)."""
    validate_price_offer(offer)
    require_iso_date(now_day, "now_day")
    valid_to = offer.get("valid_to")
    if isinstance(valid_to, str) and valid_to < now_day:
        return "expired"
    # Age vs stale_after_days is caller-supplied via collected_at in runtime;
    # foundations expose the hook only — treat missing valid_to as fresh here.
    return "fresh"
