"""Transfert HQ — Household Intelligence schema validators (foundations only).

Stdlib-only contracts for Finances / Grocery / Meals / Inventoria / price offers.
No persistence, no bridge routes, no LLM calls. Money is integer cents; quantities
use non-negative milli-units of an explicit canonical unit.

The JSON files under ``schemas/household/*.v1.json`` are **custom contract
descriptors** (HQ-shaped docs), **not** JSON Schema Draft-07/2020-12 documents.
Python validators in this module are the enforceable source of truth.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

# Custom contract descriptor filenames (not JSON Schema). Keep in sync with CI.
CONTRACT_DESCRIPTOR_FILES = (
    "common.v1.json",
    "cross_store_op.v1.json",
    "finances.v1.json",
    "grocery.v1.json",
    "inventoria.v1.json",
    "meals.v1.json",
    "price_offer.v1.json",
)

CANONICAL_UNITS = frozenset({"g", "ml", "each", "serving"})
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}\Z")
SHA256_HEX = re.compile(r"^[0-9a-f]{64}\Z")
XOP_RE = re.compile(r"^xop-[0-9a-f]{16}\Z")
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
    "cross_store_op": XOP_RE,
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
CROSS_STORE_STORES = frozenset({"sqlite", "inventory"})
INVENTORY_ATTEMPT_PHASES = frozenset({"not_started", "in_flight", "acknowledged"})
# item.adjust must never be auto-replayed when uncertain or mid-flight.
NO_AUTO_REPLAY_INVENTORY_ACTIONS = frozenset({"item.adjust"})

PLACE_KINDS = frozenset({"room", "furniture", "shelf", "drawer", "box", "bag", "other"})
ASSET_RE = re.compile(r"^asset-[0-9a-f]{24}\Z")

# Allowlists mirror hq_inventory mutation fields (id/rev added where required).
ITEM_UPDATE_FIELDS = frozenset({"place", "name", "qty", "unit", "min", "tags", "note", "photos"})
PLACE_UPDATE_FIELDS = frozenset({"parent", "name", "kind", "note", "photos"})
ITEM_CREATE_FIELDS = frozenset({"name", "qty", "unit", "place", "min", "tags", "note", "photos"})
PLACE_CREATE_FIELDS = frozenset({"name", "kind", "parent", "note", "photos"})
ITEM_ADJUST_FIELDS = frozenset({"id", "delta"})
ITEM_DELETE_FIELDS = frozenset({"id", "rev"})
PLACE_DELETE_FIELDS = frozenset({"id", "rev"})
ITEM_MOVE_FIELDS = frozenset({"ids", "place"})
ITEM_UPDATE_REQUIRED = frozenset({"id", "rev"})
PLACE_UPDATE_REQUIRED = frozenset({"id", "rev"})

OFFER_FRESHNESS_STATES = frozenset({"scheduled", "fresh", "stale", "expired"})


class SchemaError(ValueError):
    """Invalid household contract payload."""

    def __init__(self, msg: str, *, code: str = "validation_error"):
        super().__init__(msg)
        self.code = code


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def require_bool(v: Any, field: str) -> bool:
    if v is not True and v is not False:
        raise SchemaError(f"{field} doit être un booléen strict (True/False)")
    return v


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
    """Require AAAA-MM-JJ that is a real calendar date (rejects 2026-02-30)."""
    if not isinstance(v, str) or ISO_DATE.match(v) is None:
        raise SchemaError(f"{field} doit être AAAA-MM-JJ")
    try:
        date.fromisoformat(v)
    except ValueError as exc:
        raise SchemaError(f"{field} n'est pas une date calendaire valide") from exc
    return v


def require_unit(v: Any, field: str = "unit") -> str:
    if not isinstance(v, str) or v not in CANONICAL_UNITS:
        raise SchemaError(f"{field} doit être une unité canonique {sorted(CANONICAL_UNITS)}")
    return v


def require_idempotency_key(v: Any, field: str = "idempotency_key") -> str:
    if not isinstance(v, str) or not (8 <= len(v) <= 128):
        raise SchemaError(f"{field} requis (8–128 caractères)")
    return v


def require_sha256_hex(v: Any, field: str = "request_hash") -> str:
    if not isinstance(v, str) or SHA256_HEX.match(v) is None:
        raise SchemaError(f"{field} doit être un SHA-256 hex (64 caractères)")
    return v


# ---------------------------------------------------------------- unit price (exact ratio)

def unit_price_ratio(price_cents: int, qty_milli: int) -> dict[str, int]:
    """Exact rational unit price: price_cents / qty_milli (no float, no early truncate).

    Comparisons must use ``compare_unit_price_ratios`` (cross-multiply).
    Display uses ``format_unit_price_display`` ($/kg, $/L, or $/unité).
    """
    if not _is_int(price_cents) or price_cents < 0:
        raise SchemaError("price_cents invalide pour ratio")
    if not _is_int(qty_milli) or qty_milli <= 0:
        raise SchemaError("qty_milli doit être > 0 pour un prix unitaire")
    return {"cents_num": price_cents, "qty_milli_den": qty_milli}


def compare_unit_price_ratios(a: dict, b: dict) -> int:
    """Return -1, 0, 1 like cmp using exact integer cross-multiply."""
    an, ad = a["cents_num"], a["qty_milli_den"]
    bn, bd = b["cents_num"], b["qty_milli_den"]
    left, right = an * bd, bn * ad
    return (left > right) - (left < right)


def format_unit_price_display(price_cents: int, qty_milli: int, unit: str) -> dict[str, Any]:
    """Normalized display cents for UI only — not a source of truth for comparisons.

    - g  → cents per kg  (×1e6 / qty_milli)
    - ml → cents per L   (×1e6 / qty_milli)
    - each|serving → cents per unit (×1000 / qty_milli)
    """
    require_unit(unit)
    ratio = unit_price_ratio(price_cents, qty_milli)
    if unit in ("g", "ml"):
        display_unit = "kg" if unit == "g" else "L"
        # floor for display labels only
        display_cents = (price_cents * 1_000_000) // qty_milli
    else:
        display_unit = "unité"
        display_cents = (price_cents * 1000) // qty_milli
    return {
        "ratio": ratio,
        "display_cents": display_cents,
        "display_per": display_unit,
        "note": "display_cents is floored for labels; comparisons use ratio",
    }


# Deprecated name kept as explicit failure so call sites migrate.
def unit_price_cents(price_cents: int, qty_milli: int) -> int:
    raise SchemaError(
        "unit_price_cents est retiré — utiliser unit_price_ratio + format_unit_price_display"
    )


# ---------------------------------------------------------------- domain validators

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
    """Financial write contract.

    Idempotence: ``idempotency_key`` scopes **one client submission**. Same key +
    same normalized body → same tx id. Same key + different body → conflict.
    A missing key is allowed only for interactive admin POSTs that the server
    then stamps; import/grocery paths must supply a key.

    Legitimate repeated purchases (buy milk twice) are **new** transactions with
    new keys; ``actual_purchase.fingerprint`` blocks duplicate *receipt lines*,
    not intentional second trips (fingerprints must include a line discriminator).
    """
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
    if doc.get("source") in ("import", "grocery_purchase"):
        require_idempotency_key(doc.get("idempotency_key"))
    elif doc.get("idempotency_key") is not None:
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
    """Purchase posting.

    ``fingerprint`` must uniquely identify a receipt line (include merchant,
    product/barcode, day, paid_cents, qty, and a line index or receipt id).
    Buying the same SKU on two trips → two fingerprints. Replaying the same
    receipt line → 409 via fingerprint uniqueness + idempotency_key.
    """
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


def _reject_extra(payload: dict, allowed: frozenset[str], op: str) -> None:
    extra = set(payload) - allowed
    if extra:
        raise SchemaError(f"payload {op} champs interdits: {sorted(extra)}")


def _validate_optional_name(v: Any, field: str = "payload.name") -> str:
    if not isinstance(v, str) or not (0 < len(v) <= 120):
        raise SchemaError(f"{field} invalide")
    return v


def _validate_optional_unit(v: Any) -> None:
    if v is None:
        return
    if not isinstance(v, str) or len(v) > 16:
        raise SchemaError("payload.unit invalide")


def _validate_optional_note(v: Any) -> None:
    if v is None:
        return
    if not isinstance(v, str) or len(v) > 2000:
        raise SchemaError("payload.note invalide")


def _validate_optional_tags(v: Any) -> None:
    if v is None:
        return
    if not isinstance(v, list) or len(v) > 12:
        raise SchemaError("payload.tags invalide")
    for t in v:
        if not isinstance(t, str) or not (0 < len(t) <= 32):
            raise SchemaError("payload.tags élément invalide")


def _validate_optional_photos(v: Any) -> None:
    if v is None:
        return
    if not isinstance(v, list) or len(v) > 6:
        raise SchemaError("payload.photos invalide")
    for p in v:
        if not isinstance(p, str) or ASSET_RE.match(p) is None:
            raise SchemaError("payload.photos id asset invalide")


def _validate_optional_place_ref(v: Any, field: str) -> None:
    if v is None:
        return
    require_id(v, "inventory_place", field)


def _validate_optional_min(v: Any) -> None:
    if v is None:
        return
    require_qty_milli(v, "payload.min", min_value=0)


def _validate_item_mutable_fields(payload: dict, *, require_any: bool) -> None:
    if "name" in payload:
        _validate_optional_name(payload["name"])
    if "unit" in payload:
        _validate_optional_unit(payload["unit"])
    if "note" in payload:
        _validate_optional_note(payload["note"])
    if "tags" in payload:
        _validate_optional_tags(payload["tags"])
    if "photos" in payload:
        _validate_optional_photos(payload["photos"])
    if "place" in payload:
        _validate_optional_place_ref(payload["place"], "payload.place")
    if "qty" in payload:
        require_qty_milli(payload["qty"], "payload.qty", min_value=0)
    if "min" in payload:
        _validate_optional_min(payload["min"])
    if require_any and not (set(payload) & ITEM_UPDATE_FIELDS):
        raise SchemaError("payload item.update exige au moins un champ mutable")


def _validate_place_mutable_fields(payload: dict, *, require_any: bool) -> None:
    if "name" in payload:
        _validate_optional_name(payload["name"])
    if "kind" in payload:
        if payload["kind"] not in PLACE_KINDS:
            raise SchemaError("payload.kind invalide")
    if "note" in payload:
        _validate_optional_note(payload["note"])
    if "photos" in payload:
        _validate_optional_photos(payload["photos"])
    if "parent" in payload:
        _validate_optional_place_ref(payload["parent"], "payload.parent")
    if require_any and not (set(payload) & PLACE_UPDATE_FIELDS):
        raise SchemaError("payload place.update exige au moins un champ mutable")


def _validate_inventoria_payload(op: str, payload: dict) -> None:
    """Structured payload per op — arbitrary LLM JSON is never apply-ready."""
    if op == "item.adjust":
        _reject_extra(payload, ITEM_ADJUST_FIELDS, op)
        require_id(payload.get("id"), "inventory_item", "payload.id")
        delta = payload.get("delta")
        if not _is_int(delta) or delta == 0 or abs(delta) > 1_000_000:
            raise SchemaError("payload.delta invalide pour item.adjust")
        return
    if op == "item.create":
        _reject_extra(payload, ITEM_CREATE_FIELDS, op)
        _validate_optional_name(payload.get("name"))
        require_qty_milli(payload.get("qty", 1), "payload.qty", min_value=0)
        if "unit" in payload:
            _validate_optional_unit(payload["unit"])
        if "place" in payload:
            _validate_optional_place_ref(payload["place"], "payload.place")
        if "min" in payload:
            _validate_optional_min(payload["min"])
        if "tags" in payload:
            _validate_optional_tags(payload["tags"])
        if "note" in payload:
            _validate_optional_note(payload["note"])
        if "photos" in payload:
            _validate_optional_photos(payload["photos"])
        return
    if op == "item.update":
        _reject_extra(payload, ITEM_UPDATE_REQUIRED | ITEM_UPDATE_FIELDS, op)
        require_id(payload.get("id"), "inventory_item", "payload.id")
        if not _is_int(payload.get("rev")) or payload["rev"] < 1:
            raise SchemaError("payload.rev requis pour item.update")
        _validate_item_mutable_fields(payload, require_any=True)
        return
    if op == "item.delete":
        _reject_extra(payload, ITEM_DELETE_FIELDS, op)
        require_id(payload.get("id"), "inventory_item", "payload.id")
        if not _is_int(payload.get("rev")) or payload["rev"] < 1:
            raise SchemaError("payload.rev requis pour item.delete")
        return
    if op == "item.move":
        _reject_extra(payload, ITEM_MOVE_FIELDS, op)
        ids = payload.get("ids")
        if not isinstance(ids, list) or not ids or len(ids) > 500:
            raise SchemaError("payload.ids invalide pour item.move")
        for i, iid in enumerate(ids):
            require_id(iid, "inventory_item", f"payload.ids[{i}]")
        if "place" not in payload:
            raise SchemaError("payload.place requis pour item.move (null = sans emplacement)")
        _validate_optional_place_ref(payload["place"], "payload.place")
        return
    if op == "place.create":
        _reject_extra(payload, PLACE_CREATE_FIELDS, op)
        _validate_optional_name(payload.get("name"))
        if "kind" in payload and payload["kind"] not in PLACE_KINDS:
            raise SchemaError("payload.kind invalide")
        if "parent" in payload:
            _validate_optional_place_ref(payload["parent"], "payload.parent")
        if "note" in payload:
            _validate_optional_note(payload["note"])
        if "photos" in payload:
            _validate_optional_photos(payload["photos"])
        return
    if op == "place.update":
        _reject_extra(payload, PLACE_UPDATE_REQUIRED | PLACE_UPDATE_FIELDS, op)
        require_id(payload.get("id"), "inventory_place", "payload.id")
        if not _is_int(payload.get("rev")) or payload["rev"] < 1:
            raise SchemaError("payload.rev requis pour place.update")
        _validate_place_mutable_fields(payload, require_any=True)
        return
    if op == "place.delete":
        _reject_extra(payload, PLACE_DELETE_FIELDS, op)
        require_id(payload.get("id"), "inventory_place", "payload.id")
        if not _is_int(payload.get("rev")) or payload["rev"] < 1:
            raise SchemaError("payload.rev requis pour place.delete")
        return
    raise SchemaError("op inventoria inconnue")


def validate_inventoria_proposal(doc: Any) -> dict:
    if not isinstance(doc, dict):
        raise SchemaError("proposal invalide")
    op = doc.get("op")
    if op not in INVENTORIA_PROPOSAL_OPS:
        raise SchemaError("op proposal inconnue")
    if not isinstance(doc.get("refs"), dict) or not isinstance(doc.get("resolved"), dict):
        raise SchemaError("refs/resolved requis")
    conf = doc["resolved"].get("confidence")
    if conf not in ("high", "medium", "low"):
        raise SchemaError("resolved.confidence invalide")
    payload = doc.get("payload")
    if not isinstance(payload, dict):
        raise SchemaError("payload proposal requis")
    _validate_inventoria_payload(op, payload)
    if not isinstance(doc.get("label_fr"), str) or not doc["label_fr"].strip():
        raise SchemaError("label_fr requis")
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
        if not doc.get("item_rev_expectations"):
            raise SchemaError("commit inventoria exige expected_inventory_rev ou item_rev_expectations")
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
    unit = require_unit(doc.get("unit"))
    ratio = doc.get("unit_price_ratio")
    expected = unit_price_ratio(price, qty)
    if not isinstance(ratio, dict):
        raise SchemaError("unit_price_ratio requis {cents_num, qty_milli_den}")
    if ratio.get("cents_num") != expected["cents_num"] or ratio.get("qty_milli_den") != expected["qty_milli_den"]:
        raise SchemaError(
            f"unit_price_ratio incohérent (attendu {expected}, reçu {ratio})"
        )
    promo = doc.get("promo")
    if not isinstance(promo, dict) or promo.get("kind") not in ("none", "percent", "bogo", "multi", "other"):
        raise SchemaError("promo invalide")
    require_bool(doc.get("tax_included"), "tax_included")
    require_cents(doc.get("deposit_cents"), "deposit_cents", min_value=0)
    if not isinstance(doc.get("collected_at"), (int, float)) or isinstance(doc.get("collected_at"), bool):
        raise SchemaError("collected_at invalide")
    require_iso_date(doc.get("collected_on"), "collected_on")
    if doc.get("valid_from") is not None:
        require_iso_date(doc["valid_from"], "valid_from")
    if doc.get("valid_to") is not None:
        require_iso_date(doc["valid_to"], "valid_to")
    if doc.get("valid_from") is not None and doc.get("valid_to") is not None:
        if doc["valid_from"] > doc["valid_to"]:
            raise SchemaError("valid_from ne peut pas être après valid_to")
    prov = doc.get("provenance")
    if not isinstance(prov, dict) or prov.get("kind") not in ("manual", "file_import", "provider"):
        raise SchemaError("provenance invalide")
    if not isinstance(prov.get("provider_id"), str) or not prov["provider_id"]:
        raise SchemaError("provenance.provider_id requis")
    require_bool(prov.get("verifiable"), "provenance.verifiable")
    if not _is_int(doc.get("reliability")) or not (0 <= doc["reliability"] <= 100):
        raise SchemaError("reliability invalide")
    if not _is_int(doc.get("stale_after_days")) or not (1 <= doc["stale_after_days"] <= 365):
        raise SchemaError("stale_after_days invalide")
    if not _is_int(doc.get("rev")) or doc["rev"] < 1:
        raise SchemaError("rev price_offer invalide")
    # touch display helper so contract stays wired
    format_unit_price_display(price, qty, unit)
    return doc


def validate_planned_step(step: Any, *, index: int) -> dict:
    if not isinstance(step, dict):
        raise SchemaError(f"planned_steps[{index}] invalide")
    store = step.get("store")
    if store not in CROSS_STORE_STORES:
        raise SchemaError(f"planned_steps[{index}].store invalide")
    action = step.get("action")
    if not isinstance(action, str) or not action.strip() or len(action) > 64:
        raise SchemaError(f"planned_steps[{index}].action invalide")
    if store == "inventory":
        if action not in INVENTORIA_PROPOSAL_OPS:
            raise SchemaError(f"planned_steps[{index}].action inventaire inconnue")
        if "attempt_phase" not in step:
            raise SchemaError(f"planned_steps[{index}].attempt_phase explicite requis")
        phase = step.get("attempt_phase")
        if phase not in INVENTORY_ATTEMPT_PHASES:
            raise SchemaError(f"planned_steps[{index}].attempt_phase invalide")
        if "payload" not in step or not isinstance(step.get("payload"), dict):
            raise SchemaError(f"planned_steps[{index}].payload valide requis")
        _validate_inventoria_payload(action, step["payload"])
    else:
        # sqlite domain steps: action free-form within bounds; payload object if present
        if "payload" in step and step["payload"] is not None and not isinstance(step["payload"], dict):
            raise SchemaError(f"planned_steps[{index}].payload invalide")
        if "attempt_phase" in step and step["attempt_phase"] is not None:
            raise SchemaError(f"planned_steps[{index}].attempt_phase réservé à inventory")
    return step


def validate_cross_store_op(doc: Any) -> dict:
    """Journal row for SQLite↔inventory JSON coordination (foundations contract)."""
    if not isinstance(doc, dict):
        raise SchemaError("cross_store_op invalide")
    require_id(doc.get("id"), "cross_store_op")
    if doc.get("kind") not in CROSS_STORE_KINDS:
        raise SchemaError("kind cross_store_op invalide")
    status = doc.get("status")
    if status not in CROSS_STORE_STATUSES:
        raise SchemaError("status cross_store_op invalide")
    require_idempotency_key(doc.get("idempotency_key"))
    require_sha256_hex(doc.get("request_hash"))
    steps = doc.get("planned_steps")
    if not isinstance(steps, list) or len(steps) > 50:
        raise SchemaError("planned_steps requis (liste ≤ 50)")
    for i, step in enumerate(steps):
        validate_planned_step(step, index=i)
    step_index = doc.get("step_index")
    if not _is_int(step_index) or step_index < 0 or step_index > len(steps):
        raise SchemaError("step_index hors bornes (0..len(planned_steps))")
    uncertain = doc.get("uncertain_inventory")
    if not _is_int(uncertain) or uncertain not in (0, 1):
        raise SchemaError("uncertain_inventory doit être 0 ou 1 (entier strict)")
    # State invariants
    if uncertain == 1 and status == "committed":
        raise SchemaError("committed interdit si uncertain_inventory")
    if uncertain == 1 and status in ("failed", "cancelled"):
        raise SchemaError("uncertain_inventory incompatible avec failed/cancelled — utiliser needs_reconcile")
    if status == "committed" and step_index != len(steps):
        raise SchemaError("committed exige step_index == len(planned_steps)")
    if status == "committed":
        for i, step in enumerate(steps):
            if step.get("store") == "inventory" and step.get("attempt_phase") != "acknowledged":
                raise SchemaError(
                    f"committed exige planned_steps[{i}].attempt_phase=acknowledged"
                )
    if status == "applying_inventory":
        if not any(s.get("store") == "inventory" for s in steps):
            raise SchemaError("applying_inventory sans étape inventory")
    # Mid-flight adjust without ack ⇒ must not look "safe"
    for i, step in enumerate(steps):
        if step.get("store") != "inventory":
            continue
        phase = step["attempt_phase"]
        if phase == "in_flight" and step.get("action") in NO_AUTO_REPLAY_INVENTORY_ACTIONS:
            if status == "committed":
                raise SchemaError("adjust in_flight incompatible avec committed")
            if uncertain != 1 and status not in ("applying_inventory", "needs_reconcile", "finalizing"):
                raise SchemaError("adjust in_flight exige uncertain_inventory=1 ou status reconcile/applying")
    return doc


def may_auto_replay_inventory_step(
    *,
    action: str,
    uncertain_inventory: bool | int,
    attempt_phase: str,
) -> bool:
    """True only when it is safe to call hq_inventory.apply for this step on resume.

    Rules:
    - ``not_started`` + not uncertain → may start once.
    - ``in_flight`` → never auto-replay (especially ``item.adjust``); go reconcile.
    - ``acknowledged`` → never replay.
    - Global inventory ``rev`` alone must never decide this (caller must not pass rev).
    """
    if attempt_phase not in INVENTORY_ATTEMPT_PHASES:
        return False
    if attempt_phase in ("in_flight", "acknowledged"):
        return False
    if uncertain_inventory in (1, True):
        return False
    if attempt_phase != "not_started":
        return False
    return True


def recovery_for_inventory_step(
    *,
    action: str,
    attempt_phase: str,
    uncertain_inventory: bool | int = 0,
) -> str:
    """Boot recovery decision for one inventory step. Never uses store rev."""
    if attempt_phase == "acknowledged":
        return "skip_already_acknowledged"
    if attempt_phase == "in_flight":
        return "needs_reconcile"
    if attempt_phase == "not_started":
        if uncertain_inventory in (1, True):
            return "needs_reconcile"
        if may_auto_replay_inventory_step(
            action=action,
            uncertain_inventory=False,
            attempt_phase="not_started",
        ):
            return "may_start_once"
        return "needs_reconcile"
    return "needs_reconcile"


def offer_freshness(offer: dict, *, now_day: str) -> str:
    """Return scheduled|fresh|stale|expired using calendar dates only.

    Order:
    1. ``valid_from`` present and ``now_day < valid_from`` → ``scheduled``
       (promotion not yet started — not eligible for auto suggestions).
    2. ``valid_to`` present and ``now_day > valid_to`` → ``expired``.
    3. age from ``collected_on`` > ``stale_after_days`` → ``stale``.
    4. else ``fresh``.
    """
    validate_price_offer(offer)
    today = date.fromisoformat(require_iso_date(now_day, "now_day"))
    valid_from = offer.get("valid_from")
    if isinstance(valid_from, str) and today < date.fromisoformat(valid_from):
        return "scheduled"
    valid_to = offer.get("valid_to")
    if isinstance(valid_to, str) and date.fromisoformat(valid_to) < today:
        return "expired"
    collected = date.fromisoformat(offer["collected_on"])
    age_days = (today - collected).days
    if age_days > int(offer["stale_after_days"]):
        return "stale"
    return "fresh"


def load_contract_descriptors(root: Path | None = None) -> dict[str, Any]:
    """Read the seven custom contract descriptor JSON files (not JSON Schema)."""
    base = (root or Path(__file__).resolve().parent) / "schemas" / "household"
    out: dict[str, Any] = {}
    for name in CONTRACT_DESCRIPTOR_FILES:
        path = base / name
        raw = path.read_text(encoding="utf-8")
        out[name] = json.loads(raw)
    if len(out) != 7:
        raise SchemaError("attendu exactement 7 descripteurs de contrat")
    return out


def utc_today() -> str:
    return datetime.now(timezone.utc).date().isoformat()
