# -*- coding: utf-8 -*-
"""Transfert HQ — Household grocery core (PR #33).

Products, food lots, merchants in household SQLite v4. Inventoria links are soft references
validated via ``hq_inventory.snapshot()`` at write time only — no ``apply()`` or JSON writes.

API contract: ``schemas/household/grocery.v1.json`` (``schema_version`` 1). SQLite ``user_version``
4 adds grocery tables; not a contract version bump.

Barcodes: trimmed whitespace only; leading zeros preserved. Unique per household when set.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import time
from typing import Any, Callable

import hq_finances as finances
import hq_household_schemas as schemas
import hq_household_store as hstore
import hq_inventory

BODY_MAX = 1_048_576
PAGE_MAX = 200
SQLITE_INT_MIN = -(2**63)
SQLITE_INT_MAX = 2**63 - 1

POST_PRODUCT_KEYS = frozenset({
    "id", "rev", "name", "brand", "barcode", "canonical_unit", "default_qty_milli",
    "category_tags", "inventory_item_id", "archived",
})
POST_LOT_KEYS = frozenset({
    "id", "rev", "product_id", "item_id", "place_id", "qty_milli", "usable_qty_milli",
    "canonical_unit", "expires_on", "opened_on", "source_purchase_id",
})
POST_MERCHANT_KEYS = frozenset({
    "id", "rev", "name", "location_label", "provider_id",
})
POST_LIST_KEYS = frozenset({
    "id", "rev", "meal_plan_id", "status", "lines",
})

PRODUCT_CURSOR_SEP = "|"
LOT_CURSOR_SEP = "|"

_LOT_SORT_BUCKET = "CASE WHEN expires_on IS NULL OR expires_on = '' THEN 1 ELSE 0 END"


def _parse_name_id_cursor(cursor: str) -> tuple[str, str]:
    if PRODUCT_CURSOR_SEP not in cursor:
        raise GroceryError("cursor invalide", code="validation_error")
    cname, cid = cursor.rsplit(PRODUCT_CURSOR_SEP, 1)
    if not cname or not cid:
        raise GroceryError("cursor invalide", code="validation_error")
    return cname, cid


def _encode_name_id_cursor(name: str, eid: str) -> str:
    return f"{name}{PRODUCT_CURSOR_SEP}{eid}"


def _lot_sort_bucket(expires_on: str | None) -> int:
    return 1 if not expires_on else 0


def _encode_lot_cursor(expires_on: str | None, lot_id: str) -> str:
    bucket = _lot_sort_bucket(expires_on)
    return f"{bucket}:{expires_on or ''}{LOT_CURSOR_SEP}{lot_id}"


def _parse_lot_cursor(cursor: str) -> tuple[int, str, str]:
    if LOT_CURSOR_SEP not in cursor:
        raise GroceryError("cursor invalide", code="validation_error")
    head, lid = cursor.rsplit(LOT_CURSOR_SEP, 1)
    if ":" not in head or not lid:
        raise GroceryError("cursor invalide", code="validation_error")
    bucket_s, _, exp = head.partition(":")
    try:
        bucket = int(bucket_s)
    except ValueError:
        raise GroceryError("cursor invalide", code="validation_error") from None
    if bucket not in (0, 1):
        raise GroceryError("cursor invalide", code="validation_error")
    return bucket, exp, lid


def _lot_cursor_where(bucket: int, expires_on: str, lot_id: str) -> tuple[str, list[Any]]:
    sql = (
        f"(({_LOT_SORT_BUCKET} > ?) OR "
        f"({_LOT_SORT_BUCKET} = ? AND COALESCE(expires_on, '') > ?) OR "
        f"({_LOT_SORT_BUCKET} = ? AND COALESCE(expires_on, '') = ? AND id > ?))"
    )
    return sql, [bucket, bucket, expires_on, bucket, expires_on, lot_id]


ID_PREFIX = {
    "product": "prd",
    "lot": "lot",
    "merchant": "mch",
    "grocery_list": "glst",
}

_cb: dict[str, Any] = {}
_guard = threading.Lock()


class GroceryError(Exception):
    def __init__(self, msg: str, *, status: int = 400, code: str = "validation_error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    with _guard:
        for key in ("root", "actor", "now", "inventory_snapshot"):
            if key in kwargs:
                _cb[key] = kwargs[key]


def reset_for_tests() -> None:
    with _guard:
        _cb.clear()


def _root() -> Any:
    root = _cb.get("root")
    if root is None:
        raise GroceryError("module grocery non initialisé", status=503, code="storage_error")
    return root


def _actor() -> str:
    fn = _cb.get("actor")
    return str(fn()) if callable(fn) else "admin"


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def _new_id(kind: str) -> str:
    pre = ID_PREFIX.get(kind)
    if not pre:
        raise GroceryError("kind id inconnu", code="validation_error")
    return f"{pre}-{secrets.token_hex(8)}"


def _open_store(*, readonly: bool = False) -> hstore.HouseholdStore:
    return hstore.open_store(_root(), create=True, readonly=readonly)


def _reject_unknown_fields(data: dict, allowed: frozenset[str]) -> None:
    extra = set(data) - allowed
    if extra:
        sample = ", ".join(sorted(extra)[:8])
        raise GroceryError(f"Champs inconnus ({sample})", code="validation_error")


def _require_qty_milli(v: Any, field: str = "qty_milli", *, min_value: int = 0) -> int:
    try:
        q = schemas.require_qty_milli(v, field, min_value=min_value)
    except schemas.SchemaError as exc:
        raise GroceryError(str(exc), code=exc.code) from exc
    if q < SQLITE_INT_MIN or q > SQLITE_INT_MAX:
        raise GroceryError(f"{field} hors plage SQLite INTEGER", code="validation_error")
    return q


def _optional_text(v: Any, field: str, max_len: int) -> str | None:
    if v is None:
        return None
    if isinstance(v, (dict, list, tuple, set)):
        raise GroceryError(f"{field} invalide", code="validation_error")
    if not isinstance(v, str):
        raise GroceryError(f"{field} invalide", code="validation_error")
    s = v.strip()
    if not s:
        return None
    if len(s) > max_len:
        raise GroceryError(f"{field} trop long", code="validation_error")
    return s


def _normalize_barcode(v: Any) -> str | None:
    if v is None:
        return None
    if isinstance(v, (dict, list, tuple, set)):
        raise GroceryError("barcode invalide", code="validation_error")
    if not isinstance(v, str):
        raise GroceryError("barcode invalide", code="validation_error")
    s = v.strip()
    if not s:
        return None
    if len(s) > 32:
        raise GroceryError("barcode trop long", code="validation_error")
    return s


def _category_tags(v: Any) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list):
        raise GroceryError("category_tags invalide", code="validation_error")
    if len(v) > 12:
        raise GroceryError("category_tags trop long", code="validation_error")
    out: list[str] = []
    for i, item in enumerate(v):
        if not isinstance(item, str):
            raise GroceryError("category_tags invalide", code="validation_error")
        t = item.strip()
        if not t:
            raise GroceryError("category_tags invalide", code="validation_error")
        if len(t) > 32:
            raise GroceryError("category_tags invalide", code="validation_error")
        out.append(t)
    return out


def _inventory_snapshot() -> dict:
    fn = _cb.get("inventory_snapshot")
    if callable(fn):
        try:
            snap = fn()
        except Exception as exc:
            raise GroceryError("inventaire indisponible", status=503, code="storage_error") from exc
        if not isinstance(snap, dict):
            raise GroceryError("inventaire indisponible", status=503, code="storage_error")
        return snap
    try:
        return hq_inventory.snapshot()
    except Exception as exc:
        raise GroceryError("inventaire indisponible", status=503, code="storage_error") from exc


def _inventory_index(snap: dict) -> tuple[set[str], set[str]]:
    items: set[str] = set()
    places: set[str] = set()
    for it in snap.get("items") or []:
        if isinstance(it, dict) and isinstance(it.get("id"), str):
            items.add(it["id"])
    for pl in snap.get("places") or []:
        if isinstance(pl, dict) and isinstance(pl.get("id"), str):
            places.add(pl["id"])
    return items, places


def _validate_inventory_refs(item_id: str | None, place_id: str | None) -> None:
    if item_id is not None:
        try:
            schemas.require_id(item_id, "inventory_item", "item_id")
        except schemas.SchemaError as exc:
            raise GroceryError(str(exc), code=exc.code) from exc
    if place_id is not None:
        try:
            schemas.require_id(place_id, "inventory_place", "place_id")
        except schemas.SchemaError as exc:
            raise GroceryError(str(exc), code=exc.code) from exc
    if item_id is None and place_id is None:
        return
    snap = _inventory_snapshot()
    items, places = _inventory_index(snap)
    if item_id is not None and item_id not in items:
        raise GroceryError("item inventaire introuvable", status=404, code="not_found")
    if place_id is not None and place_id not in places:
        raise GroceryError("emplacement inventaire introuvable", status=404, code="not_found")


def _require_unit(v: Any, field: str = "canonical_unit") -> str:
    try:
        return schemas.require_unit(v, field)
    except schemas.SchemaError as exc:
        raise GroceryError(str(exc), code=exc.code) from exc


def _optional_iso_date(v: Any, field: str) -> str | None:
    if v is None:
        return None
    try:
        return schemas.require_iso_date(v, field)
    except schemas.SchemaError as exc:
        raise GroceryError(str(exc), code=exc.code) from exc


def _product_row_to_api(row: sqlite3.Row, snap: dict | None = None) -> dict:
    tags = json.loads(row["category_tags_json"] or "[]")
    item_id = row["inventory_item_id"]
    out: dict[str, Any] = {
        "id": row["id"],
        "household_id": row["household_id"],
        "name": row["name"],
        "brand": row["brand"],
        "barcode": row["barcode"],
        "canonical_unit": row["canonical_unit"],
        "default_qty_milli": int(row["default_qty_milli"]),
        "category_tags": tags if isinstance(tags, list) else [],
        "inventory_item_id": item_id,
        "archived": bool(int(row["archived"])),
        "rev": int(row["rev"]),
        "schema_version": 1,
    }
    if snap is not None and item_id:
        items, _ = _inventory_index(snap)
        out["inventory_item_resolved"] = item_id in items
    return out


def _lot_row_to_api(row: sqlite3.Row, snap: dict | None = None) -> dict:
    item_id = row["item_id"]
    place_id = row["place_id"]
    out: dict[str, Any] = {
        "id": row["id"],
        "household_id": row["household_id"],
        "product_id": row["product_id"],
        "item_id": item_id,
        "place_id": place_id,
        "qty_milli": int(row["qty_milli"]),
        "usable_qty_milli": int(row["usable_qty_milli"]),
        "canonical_unit": row["canonical_unit"],
        "expires_on": row["expires_on"],
        "opened_on": row["opened_on"],
        "source_purchase_id": row["source_purchase_id"],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }
    if snap is not None:
        items, places = _inventory_index(snap)
        if item_id:
            out["inventory_item_resolved"] = item_id in items
        if place_id:
            out["inventory_place_resolved"] = place_id in places
    return out


def _merchant_row_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "name": row["name"],
        "location_label": row["location_label"],
        "provider_id": row["provider_id"],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def _qs_first(qs: dict | None, key: str, default: str = "") -> str:
    if not qs:
        return default
    v = qs.get(key)
    if v is None:
        return default
    if isinstance(v, list):
        return str(v[0]) if v else default
    return str(v)


def _page_limit(qs: dict | None) -> int:
    try:
        return min(PAGE_MAX, max(1, int(_qs_first(qs, "limit", "50"))))
    except (TypeError, ValueError):
        return 50


def _assert_household_row(conn: sqlite3.Connection, table: str, eid: str, household_id: str) -> sqlite3.Row:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (eid,)).fetchone()
    if row is None:
        raise GroceryError("introuvable", status=404, code="not_found")
    if str(row["household_id"]) != household_id:
        raise GroceryError("accès refusé", status=404, code="not_found")
    return row


def create_product(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_PRODUCT_KEYS)
    name = _optional_text(data.get("name"), "name", 160)
    if not name:
        raise GroceryError("name invalide")
    unit = _require_unit(data.get("canonical_unit"))
    default_qty = _require_qty_milli(data.get("default_qty_milli"), min_value=0)
    barcode = _normalize_barcode(data.get("barcode"))
    brand = _optional_text(data.get("brand"), "brand", 120)
    tags = _category_tags(data.get("category_tags"))
    inv_item = data.get("inventory_item_id")
    if inv_item is not None:
        _validate_inventory_refs(inv_item, None)
    archived = False
    if "archived" in data:
        archived = schemas.require_bool(data["archived"], "archived")
    now = _now()
    pid = _new_id("product")
    try:
        conn.execute(
            "INSERT INTO products("
            "id, household_id, name, brand, barcode, canonical_unit, default_qty_milli, "
            "category_tags_json, inventory_item_id, archived, created_at, updated_at, rev"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
            (
                pid, household_id, name, brand, barcode, unit, default_qty,
                json.dumps(tags, ensure_ascii=False), inv_item, 1 if archived else 0, now, now,
            ),
        )
    except sqlite3.IntegrityError as exc:
        if barcode:
            raise GroceryError("barcode déjà utilisé", status=409, code="conflict") from exc
        raise GroceryError("produit invalide", code="validation_error") from exc
    row = conn.execute("SELECT * FROM products WHERE id = ?", (pid,)).fetchone()
    return _product_row_to_api(row)


def update_product(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_PRODUCT_KEYS)
    schemas.require_id(data.get("id"), "product")
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise GroceryError("rev invalide")
    row = _assert_household_row(conn, "products", data["id"], household_id)
    if int(row["rev"]) != rev:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    lot_count = int(conn.execute(
        "SELECT COUNT(*) FROM food_lots WHERE product_id = ?", (data["id"],),
    ).fetchone()[0])
    if lot_count > 0 and data.get("archived") is False and int(row["archived"]) == 1:
        pass
    name = row["name"]
    if "name" in data:
        name = _optional_text(data.get("name"), "name", 160)
        if not name:
            raise GroceryError("name invalide")
    brand = row["brand"]
    if "brand" in data:
        brand = _optional_text(data.get("brand"), "brand", 120)
    barcode = row["barcode"]
    if "barcode" in data:
        barcode = _normalize_barcode(data.get("barcode"))
    unit = row["canonical_unit"]
    if "canonical_unit" in data:
        new_unit = _require_unit(data.get("canonical_unit"))
        if lot_count > 0 and new_unit != row["canonical_unit"]:
            raise GroceryError(
                "canonical_unit verrouillée lorsque des lots existent",
                code="validation_error",
            )
        unit = new_unit
    default_qty = int(row["default_qty_milli"])
    if "default_qty_milli" in data:
        default_qty = _require_qty_milli(data.get("default_qty_milli"), min_value=0)
    tags_json = row["category_tags_json"]
    if "category_tags" in data:
        tags_json = json.dumps(_category_tags(data.get("category_tags")), ensure_ascii=False)
    inv_item = row["inventory_item_id"]
    if "inventory_item_id" in data:
        inv_item = data.get("inventory_item_id")
        if inv_item is not None:
            _validate_inventory_refs(inv_item, None)
    archived = bool(int(row["archived"]))
    if "archived" in data:
        archived = schemas.require_bool(data["archived"], "archived")
    now = _now()
    try:
        cur = conn.execute(
            "UPDATE products SET name = ?, brand = ?, barcode = ?, canonical_unit = ?, "
            "default_qty_milli = ?, category_tags_json = ?, inventory_item_id = ?, archived = ?, "
            "updated_at = ?, rev = ? WHERE id = ? AND household_id = ? AND rev = ?",
            (
                name, brand, barcode, unit, default_qty, tags_json, inv_item,
                1 if archived else 0, now, rev + 1, data["id"], household_id, rev,
            ),
        )
    except sqlite3.IntegrityError as exc:
        if barcode:
            raise GroceryError("barcode déjà utilisé", status=409, code="conflict") from exc
        raise GroceryError("produit invalide", code="validation_error") from exc
    if cur.rowcount != 1:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    row2 = conn.execute("SELECT * FROM products WHERE id = ?", (data["id"],)).fetchone()
    return _product_row_to_api(row2)


def upsert_product(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    if data.get("id"):
        return update_product(conn, household_id, data)
    return create_product(conn, household_id, data)


def list_products(conn: sqlite3.Connection, household_id: str, qs: dict | None) -> dict:
    limit = _page_limit(qs)
    cursor = _qs_first(qs, "cursor")
    barcode = _normalize_barcode(_qs_first(qs, "barcode") or None)
    q = _qs_first(qs, "q").strip()
    include_archived = _qs_first(qs, "include_archived") in ("1", "true", "yes")
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    if not include_archived:
        clauses.append("archived = 0")
    if barcode:
        clauses.append("barcode = ?")
        params.append(barcode)
    elif q:
        clauses.append("(name LIKE ? OR IFNULL(brand,'') LIKE ?)")
        like = f"%{q}%"
        params.extend([like, like])
    if cursor:
        cname, cid = _parse_name_id_cursor(cursor)
        clauses.append("(name > ? OR (name = ? AND id > ?))")
        params.extend([cname, cname, cid])
    sql = "SELECT * FROM products WHERE " + " AND ".join(clauses)
    sql += " ORDER BY name ASC, id ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    snap: dict | None = None
    try:
        snap = _inventory_snapshot()
    except GroceryError:
        snap = None
    items = [_product_row_to_api(r, snap) for r in rows]
    next_cursor = None
    if len(items) == limit:
        last = items[-1]
        next_cursor = _encode_name_id_cursor(last["name"], last["id"])
    return {"ok": True, "items": items, "next_cursor": next_cursor}


def sum_usable_qty_milli(conn: sqlite3.Connection, household_id: str, product_id: str) -> int:
    _assert_household_row(conn, "products", product_id, household_id)
    row = conn.execute(
        "SELECT COALESCE(SUM(usable_qty_milli), 0) FROM food_lots "
        "WHERE product_id = ? AND household_id = ?",
        (product_id, household_id),
    ).fetchone()
    return int(row[0] or 0)


def create_lot(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_LOT_KEYS)
    schemas.require_id(data.get("product_id"), "product", "product_id")
    _assert_household_row(conn, "products", data["product_id"], household_id)
    qty = _require_qty_milli(data.get("qty_milli"), min_value=0)
    if data.get("usable_qty_milli") is None:
        usable = qty
    else:
        usable = _require_qty_milli(data.get("usable_qty_milli"), min_value=0)
    if usable > qty:
        raise GroceryError("usable_qty_milli > qty_milli", code="validation_error")
    unit = _require_unit(data.get("canonical_unit"))
    prod = conn.execute(
        "SELECT canonical_unit FROM products WHERE id = ?", (data["product_id"],),
    ).fetchone()
    if unit != prod["canonical_unit"]:
        raise GroceryError("canonical_unit incompatible avec le produit", code="validation_error")
    item_id = data.get("item_id")
    place_id = data.get("place_id")
    _validate_inventory_refs(item_id, place_id)
    expires = _optional_iso_date(data.get("expires_on"), "expires_on")
    opened = _optional_iso_date(data.get("opened_on"), "opened_on")
    source_purchase = data.get("source_purchase_id")
    if source_purchase is not None:
        try:
            schemas.require_id(source_purchase, "purchase", "source_purchase_id")
        except schemas.SchemaError as exc:
            raise GroceryError(str(exc), code=exc.code) from exc
    now = _now()
    lid = _new_id("lot")
    conn.execute(
        "INSERT INTO food_lots("
        "id, household_id, product_id, item_id, place_id, qty_milli, usable_qty_milli, "
        "canonical_unit, expires_on, opened_on, source_purchase_id, created_at, updated_at, rev"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        (
            lid, household_id, data["product_id"], item_id, place_id, qty, usable, unit,
            expires, opened, source_purchase, now, now,
        ),
    )
    row = conn.execute("SELECT * FROM food_lots WHERE id = ?", (lid,)).fetchone()
    return _lot_row_to_api(row)


def update_lot(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_LOT_KEYS)
    schemas.require_id(data.get("id"), "lot")
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise GroceryError("rev invalide")
    row = _assert_household_row(conn, "food_lots", data["id"], household_id)
    if int(row["rev"]) != rev:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    product_id = row["product_id"]
    if "product_id" in data:
        schemas.require_id(data["product_id"], "product", "product_id")
        _assert_household_row(conn, "products", data["product_id"], household_id)
        product_id = data["product_id"]
    qty = int(row["qty_milli"])
    if "qty_milli" in data:
        qty = _require_qty_milli(data.get("qty_milli"), min_value=0)
    usable = int(row["usable_qty_milli"])
    if "usable_qty_milli" in data:
        usable = _require_qty_milli(data.get("usable_qty_milli"), min_value=0)
    elif "qty_milli" in data and qty < usable:
        raise GroceryError(
            "qty_milli inférieure à usable_qty_milli — fournir usable_qty_milli",
            code="validation_error",
        )
    if usable > qty:
        raise GroceryError("usable_qty_milli > qty_milli", code="validation_error")
    unit = row["canonical_unit"]
    if "canonical_unit" in data:
        unit = _require_unit(data.get("canonical_unit"))
    prod = conn.execute("SELECT canonical_unit FROM products WHERE id = ?", (product_id,)).fetchone()
    if unit != prod["canonical_unit"]:
        raise GroceryError("canonical_unit incompatible avec le produit", code="validation_error")
    item_id = row["item_id"]
    if "item_id" in data:
        item_id = data.get("item_id")
    place_id = row["place_id"]
    if "place_id" in data:
        place_id = data.get("place_id")
    if "item_id" in data or "place_id" in data:
        _validate_inventory_refs(item_id, place_id)
    expires = row["expires_on"]
    if "expires_on" in data:
        expires = _optional_iso_date(data.get("expires_on"), "expires_on")
    opened = row["opened_on"]
    if "opened_on" in data:
        opened = _optional_iso_date(data.get("opened_on"), "opened_on")
    source_purchase = row["source_purchase_id"]
    if "source_purchase_id" in data:
        source_purchase = data.get("source_purchase_id")
        if source_purchase is not None:
            try:
                schemas.require_id(source_purchase, "purchase", "source_purchase_id")
            except schemas.SchemaError as exc:
                raise GroceryError(str(exc), code=exc.code) from exc
    now = _now()
    cur = conn.execute(
        "UPDATE food_lots SET product_id = ?, item_id = ?, place_id = ?, qty_milli = ?, "
        "usable_qty_milli = ?, canonical_unit = ?, expires_on = ?, opened_on = ?, "
        "source_purchase_id = ?, updated_at = ?, rev = ? "
        "WHERE id = ? AND household_id = ? AND rev = ?",
        (
            product_id, item_id, place_id, qty, usable, unit, expires, opened,
            source_purchase, now, rev + 1, data["id"], household_id, rev,
        ),
    )
    if cur.rowcount != 1:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    row2 = conn.execute("SELECT * FROM food_lots WHERE id = ?", (data["id"],)).fetchone()
    return _lot_row_to_api(row2)


def upsert_lot(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    if data.get("id"):
        return update_lot(conn, household_id, data)
    return create_lot(conn, household_id, data)


def list_lots(conn: sqlite3.Connection, household_id: str, qs: dict | None) -> dict:
    limit = _page_limit(qs)
    cursor = _qs_first(qs, "cursor")
    product_id = _qs_first(qs, "product_id")
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    if product_id:
        try:
            schemas.require_id(product_id, "product", "product_id")
        except schemas.SchemaError as exc:
            raise GroceryError(str(exc), code=exc.code) from exc
        _assert_household_row(conn, "products", product_id, household_id)
        clauses.append("product_id = ?")
        params.append(product_id)
    if cursor:
        bucket, exp, lid = _parse_lot_cursor(cursor)
        lot_sql, lot_params = _lot_cursor_where(bucket, exp, lid)
        clauses.append(lot_sql)
        params.extend(lot_params)
    sql = "SELECT * FROM food_lots WHERE " + " AND ".join(clauses)
    sql += f" ORDER BY {_LOT_SORT_BUCKET}, expires_on ASC, id ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    snap: dict | None = None
    try:
        snap = _inventory_snapshot()
    except GroceryError:
        snap = None
    items = [_lot_row_to_api(r, snap) for r in rows]
    next_cursor = None
    if len(items) == limit:
        last = items[-1]
        next_cursor = _encode_lot_cursor(last.get("expires_on"), last["id"])
    total_usable = sum_usable_qty_milli(conn, household_id, product_id) if product_id else None
    out: dict[str, Any] = {"ok": True, "items": items, "next_cursor": next_cursor}
    if product_id and total_usable is not None:
        out["total_usable_qty_milli"] = total_usable
    return out


def create_merchant(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_MERCHANT_KEYS)
    name = _optional_text(data.get("name"), "name", 160)
    if not name:
        raise GroceryError("name invalide")
    location = _optional_text(data.get("location_label"), "location_label", 200)
    provider = _optional_text(data.get("provider_id"), "provider_id", 64)
    now = _now()
    mid = _new_id("merchant")
    conn.execute(
        "INSERT INTO merchants(id, household_id, name, location_label, provider_id, created_at, updated_at, rev) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        (mid, household_id, name, location, provider, now, now),
    )
    row = conn.execute("SELECT * FROM merchants WHERE id = ?", (mid,)).fetchone()
    return _merchant_row_to_api(row)


def update_merchant(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_MERCHANT_KEYS)
    schemas.require_id(data.get("id"), "merchant")
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise GroceryError("rev invalide")
    row = _assert_household_row(conn, "merchants", data["id"], household_id)
    if int(row["rev"]) != rev:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    name = row["name"]
    if "name" in data:
        name = _optional_text(data.get("name"), "name", 160)
        if not name:
            raise GroceryError("name invalide")
    location = row["location_label"]
    if "location_label" in data:
        location = _optional_text(data.get("location_label"), "location_label", 200)
    provider = row["provider_id"]
    if "provider_id" in data:
        provider = _optional_text(data.get("provider_id"), "provider_id", 64)
    now = _now()
    cur = conn.execute(
        "UPDATE merchants SET name = ?, location_label = ?, provider_id = ?, updated_at = ?, rev = ? "
        "WHERE id = ? AND household_id = ? AND rev = ?",
        (name, location, provider, now, rev + 1, data["id"], household_id, rev),
    )
    if cur.rowcount != 1:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    row2 = conn.execute("SELECT * FROM merchants WHERE id = ?", (data["id"],)).fetchone()
    return _merchant_row_to_api(row2)


def upsert_merchant(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    if data.get("id"):
        return update_merchant(conn, household_id, data)
    return create_merchant(conn, household_id, data)


def list_merchants(conn: sqlite3.Connection, household_id: str, qs: dict | None) -> dict:
    limit = _page_limit(qs)
    cursor = _qs_first(qs, "cursor")
    q = _qs_first(qs, "q").strip()
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    if q:
        clauses.append("name LIKE ?")
        params.append(f"%{q}%")
    if cursor:
        cname, cid = _parse_name_id_cursor(cursor)
        clauses.append("(name > ? OR (name = ? AND id > ?))")
        params.extend([cname, cname, cid])
    sql = "SELECT * FROM merchants WHERE " + " AND ".join(clauses)
    sql += " ORDER BY name ASC, id ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    items = [_merchant_row_to_api(r) for r in rows]
    next_cursor = None
    if len(items) == limit:
        last = items[-1]
        next_cursor = _encode_name_id_cursor(last["name"], last["id"])
    return {"ok": True, "items": items, "next_cursor": next_cursor}


def _grocery_list_row_to_api(row: sqlite3.Row) -> dict:
    lines = json.loads(row["lines_json"] or "[]")
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "meal_plan_id": row["meal_plan_id"],
        "status": row["status"],
        "lines": lines if isinstance(lines, list) else [],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def _parse_grocery_lines(
    conn: sqlite3.Connection,
    household_id: str,
    raw: Any,
) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > 500:
        raise GroceryError("lines invalides", code="validation_error")
    out: list[dict] = []
    for i, line in enumerate(raw):
        if not isinstance(line, dict):
            raise GroceryError(f"lines[{i}] invalide", code="validation_error")
        name = _optional_text(line.get("name"), f"lines[{i}].name", 160)
        if not name:
            raise GroceryError(f"lines[{i}].name invalide", code="validation_error")
        qty = _require_qty_milli(line.get("qty_milli"), f"lines[{i}].qty_milli")
        unit = _require_unit(line.get("unit"), f"lines[{i}].unit")
        product_id = line.get("product_id")
        if product_id is not None:
            schemas.require_id(product_id, "product", f"lines[{i}].product_id")
            _assert_household_row(conn, "products", product_id, household_id)
        merchant_id = line.get("merchant_id")
        if merchant_id is not None:
            schemas.require_id(merchant_id, "merchant", f"lines[{i}].merchant_id")
            _assert_household_row(conn, "merchants", merchant_id, household_id)
        estimated_cents = line.get("estimated_cents")
        if estimated_cents is not None:
            try:
                estimated_cents = schemas.require_cents(estimated_cents, f"lines[{i}].estimated_cents", min_value=0)
            except schemas.SchemaError as exc:
                raise GroceryError(str(exc), code=exc.code) from exc
        checked = False
        if "checked" in line:
            checked = schemas.require_bool(line["checked"], f"lines[{i}].checked")
        out.append({
            "product_id": product_id,
            "name": name,
            "qty_milli": qty,
            "unit": unit,
            "merchant_id": merchant_id,
            "estimated_cents": estimated_cents,
            "checked": checked,
        })
    return out


def create_grocery_list(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_LIST_KEYS)
    meal_plan_id = data.get("meal_plan_id")
    if meal_plan_id is not None:
        try:
            schemas.require_id(meal_plan_id, "meal_plan", "meal_plan_id")
        except schemas.SchemaError as exc:
            raise GroceryError(str(exc), code=exc.code) from exc
        row = conn.execute(
            "SELECT household_id FROM meal_plans WHERE id = ?", (meal_plan_id,),
        ).fetchone()
        if row is None or str(row["household_id"]) != household_id:
            raise GroceryError("meal_plan introuvable", status=404, code="not_found")
    status = data.get("status", "open")
    if status not in schemas.GROCERY_LIST_STATUS:
        raise GroceryError("status invalide", code="validation_error")
    lines = _parse_grocery_lines(conn, household_id, data.get("lines"))
    gid = _new_id("grocery_list")
    doc = {"id": gid, "status": status, "lines": lines, "rev": 1}
    if meal_plan_id:
        doc["meal_plan_id"] = meal_plan_id
    schemas.validate_grocery_list(doc)
    now = _now()
    conn.execute(
        "INSERT INTO grocery_lists(id, household_id, meal_plan_id, status, lines_json, created_at, updated_at, rev) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        (gid, household_id, meal_plan_id, status, json.dumps(lines, ensure_ascii=False), now, now),
    )
    row = conn.execute("SELECT * FROM grocery_lists WHERE id = ?", (gid,)).fetchone()
    return _grocery_list_row_to_api(row)


def update_grocery_list(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_LIST_KEYS)
    schemas.require_id(data.get("id"), "grocery_list")
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise GroceryError("rev invalide")
    row = _assert_household_row(conn, "grocery_lists", data["id"], household_id)
    if int(row["rev"]) != rev:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    meal_plan_id = row["meal_plan_id"]
    if "meal_plan_id" in data:
        meal_plan_id = data.get("meal_plan_id")
        if meal_plan_id is not None:
            schemas.require_id(meal_plan_id, "meal_plan", "meal_plan_id")
            mrow = conn.execute(
                "SELECT household_id FROM meal_plans WHERE id = ?", (meal_plan_id,),
            ).fetchone()
            if mrow is None or str(mrow["household_id"]) != household_id:
                raise GroceryError("meal_plan introuvable", status=404, code="not_found")
    status = row["status"]
    if "status" in data:
        status = data["status"]
        if status not in schemas.GROCERY_LIST_STATUS:
            raise GroceryError("status invalide", code="validation_error")
    lines = json.loads(row["lines_json"] or "[]")
    if "lines" in data:
        lines = _parse_grocery_lines(conn, household_id, data.get("lines"))
    doc = {"id": data["id"], "status": status, "lines": lines, "rev": rev + 1}
    if meal_plan_id:
        doc["meal_plan_id"] = meal_plan_id
    schemas.validate_grocery_list(doc)
    now = _now()
    cur = conn.execute(
        "UPDATE grocery_lists SET meal_plan_id = ?, status = ?, lines_json = ?, updated_at = ?, rev = ? "
        "WHERE id = ? AND household_id = ? AND rev = ?",
        (meal_plan_id, status, json.dumps(lines, ensure_ascii=False), now, rev + 1, data["id"], household_id, rev),
    )
    if cur.rowcount != 1:
        raise GroceryError("rev obsolète", status=409, code="conflict")
    row2 = conn.execute("SELECT * FROM grocery_lists WHERE id = ?", (data["id"],)).fetchone()
    return _grocery_list_row_to_api(row2)


def upsert_grocery_list(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    if data.get("id"):
        return update_grocery_list(conn, household_id, data)
    return create_grocery_list(conn, household_id, data)


def list_grocery_lists(conn: sqlite3.Connection, household_id: str, qs: dict | None) -> dict:
    limit = _page_limit(qs)
    cursor = _qs_first(qs, "cursor")
    lid = _qs_first(qs, "id")
    if lid:
        try:
            schemas.require_id(lid, "grocery_list")
        except schemas.SchemaError as exc:
            raise GroceryError(str(exc), code=exc.code) from exc
        row = _assert_household_row(conn, "grocery_lists", lid, household_id)
        return {"ok": True, "items": [_grocery_list_row_to_api(row)], "next_cursor": None}
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    status = _qs_first(qs, "status")
    if status:
        if status not in schemas.GROCERY_LIST_STATUS:
            raise GroceryError("status invalide", code="validation_error")
        clauses.append("status = ?")
        params.append(status)
    if cursor:
        cname, cid = _parse_name_id_cursor(cursor)
        clauses.append("(status > ? OR (status = ? AND id > ?))")
        params.extend([cname, cname, cid])
    sql = "SELECT * FROM grocery_lists WHERE " + " AND ".join(clauses)
    sql += " ORDER BY status ASC, id ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    items = [_grocery_list_row_to_api(r) for r in rows]
    next_cursor = None
    if len(items) == limit:
        last = items[-1]
        next_cursor = _encode_name_id_cursor(last["status"], last["id"])
    return {"ok": True, "items": items, "next_cursor": next_cursor}


def redact_for_logs(payload: Any) -> dict:
    if not isinstance(payload, dict):
        return {"redacted": True}
    out: dict[str, Any] = {"ok": payload.get("ok")}
    if payload.get("code"):
        out["code"] = payload["code"]
    if isinstance(payload.get("items"), list):
        out["count"] = len(payload["items"])
    return out


def _err(exc: BaseException) -> tuple[int, dict]:
    if isinstance(exc, schemas.SchemaError):
        return 400, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, hstore.HouseholdStoreError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, GroceryError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    return 500, {"ok": False, "error": "erreur interne", "code": "internal"}


def http_get(path: str, qs: dict | None = None) -> tuple[int, dict]:
    try:
        st = _open_store(readonly=True)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=False)
            if path == "/api/grocery/products":
                return 200, list_products(conn, household_id, qs or {})
            if path == "/api/grocery/lots":
                return 200, list_lots(conn, household_id, qs or {})
            if path == "/api/grocery/merchants":
                return 200, list_merchants(conn, household_id, qs or {})
            if path == "/api/grocery/lists":
                return 200, list_grocery_lists(conn, household_id, qs or {})
            raise GroceryError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (GroceryError, schemas.SchemaError, hstore.HouseholdStoreError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}


def http_post(path: str, data: Any) -> tuple[int, dict]:
    try:
        if isinstance(data, list):
            raise GroceryError("JSON objet requis", code="validation_error")
        if not isinstance(data, dict):
            raise GroceryError("JSON objet requis", code="validation_error")
        if len(json.dumps(data, ensure_ascii=False)) > BODY_MAX:
            raise GroceryError("corps trop volumineux", status=413, code="validation_error")
        st = _open_store(readonly=False)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=True)
            if path == "/api/grocery/products":
                with st.transaction():
                    out = upsert_product(conn, household_id, data)
                return 200, {"ok": True, "product": out}
            if path == "/api/grocery/lots":
                with st.transaction():
                    out = upsert_lot(conn, household_id, data)
                return 200, {"ok": True, "lot": out}
            if path == "/api/grocery/merchants":
                with st.transaction():
                    out = upsert_merchant(conn, household_id, data)
                return 200, {"ok": True, "merchant": out}
            if path == "/api/grocery/lists":
                with st.transaction():
                    out = upsert_grocery_list(conn, household_id, data)
                return 200, {"ok": True, "grocery_list": out}
            raise GroceryError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (GroceryError, schemas.SchemaError, hstore.HouseholdStoreError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}
