# -*- coding: utf-8 -*-
"""Transfert HQ — Actual grocery purchases (PR #36).

SQLite-only posting: optional finance transaction + food lot in one SQLite
transaction. Reference currency for purchase amounts is the **household** currency
(``households.currency``); when ``post_finance`` is true the account must use the
same currency (no implicit FX).

**Inventoria / cross-store:** ``adjust_inventory`` returns **501** — no
``hq_inventory.apply()``, no ``item.adjust`` best-effort. Table ``cross_store_ops``
is preparatory only; SQLite↔Inventoria reconciliation criteria are **not** met
and no Inventoria sync runs in this delivery.

API: ``POST/GET /api/grocery/purchases/actual``.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
from typing import Any

import hq_finances as finances
import hq_grocery as grocery
import hq_household_schemas as schemas
import hq_household_store as hstore

BODY_MAX = 1_048_576
PAGE_MAX = 200
SQLITE_INT_MIN = -(2**63)
SQLITE_INT_MAX = 2**63 - 1
IDEM_WAIT_SEC = 2.0

FINANCE_OPTIONAL_KEYS = frozenset({"account_id", "category_id", "payee", "memo"})
LOT_OPTIONAL_KEYS = frozenset({"link_item_id", "place_id", "opened_on", "expires_on"})

POST_ACTUAL_KEYS = frozenset({
    "id", "rev", "planned_id", "product_id", "merchant_id", "qty_milli", "unit",
    "paid_cents", "taxed_cents", "deposit_cents", "purchased_on", "fingerprint",
    "idempotency_key", "post_finance", "account_id", "category_id", "create_lot",
    "adjust_inventory", "link_item_id", "place_id", "opened_on", "expires_on",
    "payee", "memo",
})

PURCHASE_OP = "actual_purchase"
PURCHASE_CURSOR_RE = re.compile(
    r"^(?P<d>\d{4}-\d{2}-\d{2})~(?P<id>pur-[0-9a-f]{16})$",
)
ID_PREFIX = {"purchase": "pur"}

_cb: dict[str, Any] = {}
_guard = threading.Lock()


class PurchasesError(Exception):
    def __init__(self, msg: str, *, status: int = 400, code: str = "validation_error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    with _guard:
        for key in ("root", "actor", "now"):
            if key in kwargs:
                _cb[key] = kwargs[key]


def reset_for_tests() -> None:
    with _guard:
        _cb.clear()


def _root() -> Any:
    root = _cb.get("root")
    if root is None:
        raise PurchasesError("module achats non initialisé", status=503, code="storage_error")
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
        raise PurchasesError("kind id inconnu", code="validation_error")
    return f"{pre}-{secrets.token_hex(8)}"


def _open_store(*, readonly: bool = False) -> hstore.HouseholdStore:
    return hstore.open_store(_root(), create=not readonly, readonly=readonly)


def _reject_unknown_fields(data: dict, allowed: frozenset[str]) -> None:
    extra = set(data) - allowed
    if extra:
        sample = ", ".join(sorted(extra)[:8])
        raise PurchasesError(f"Champs inconnus ({sample})", code="validation_error")


def _body_hash(payload: dict) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _safe_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


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


def _require_qty_milli(v: Any, field: str = "qty_milli", *, min_value: int = 1) -> int:
    try:
        q = schemas.require_qty_milli(v, field, min_value=min_value)
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc
    if q < SQLITE_INT_MIN or q > SQLITE_INT_MAX:
        raise PurchasesError(f"{field} hors plage SQLite INTEGER", code="validation_error")
    return q


def _require_unit(v: Any) -> str:
    try:
        return schemas.require_unit(v)
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc


def _require_cents(v: Any, field: str, *, min_value: int = 0) -> int:
    try:
        cents = schemas.require_cents(v, field, min_value=min_value)
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc
    if cents < SQLITE_INT_MIN or cents > SQLITE_INT_MAX:
        raise PurchasesError(f"{field} hors plage SQLite INTEGER", code="validation_error")
    return cents


def _optional_bool(data: dict, field: str) -> bool:
    if field not in data:
        return False
    try:
        return schemas.require_bool(data[field], field)
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc


def _require_payee_memo(v: Any, field: str, *, max_len: int = 200) -> str:
    if v is None:
        return ""
    if isinstance(v, (dict, list, tuple, set)):
        raise PurchasesError(f"{field} doit être une chaîne", code="validation_error")
    if not isinstance(v, str):
        raise PurchasesError(f"{field} doit être une chaîne", code="validation_error")
    if len(v) > max_len:
        raise PurchasesError(f"{field} trop long (max {max_len})", code="validation_error")
    return v


def _assert_purchase_cents_sum(paid: int, taxed: int, deposit: int) -> None:
    try:
        need = taxed + deposit
    except OverflowError:
        raise PurchasesError("taxed_cents + deposit_cents déborde", code="validation_error") from None
    if need < SQLITE_INT_MIN or need > SQLITE_INT_MAX:
        raise PurchasesError("taxed_cents + deposit_cents hors plage SQLite INTEGER", code="validation_error")
    if paid < need:
        raise PurchasesError(
            "paid_cents doit couvrir taxed_cents + deposit_cents",
            code="validation_error",
        )


def _household_reference_currency(conn: sqlite3.Connection, household_id: str) -> str:
    row = conn.execute("SELECT currency FROM households WHERE id = ?", (household_id,)).fetchone()
    if row is None:
        raise PurchasesError("foyer introuvable", status=404, code="not_found")
    return str(row["currency"])


def _assert_finance_refs(
    conn: sqlite3.Connection,
    household_id: str,
    *,
    account_id: str,
    category_id: str,
) -> None:
    acc = conn.execute(
        "SELECT household_id, currency, archived FROM accounts WHERE id = ?", (account_id,),
    ).fetchone()
    if acc is None or str(acc["household_id"]) != household_id:
        raise PurchasesError("compte introuvable", status=404, code="not_found")
    if int(acc["archived"]):
        raise PurchasesError("compte archivé", code="validation_error")
    cat = conn.execute(
        "SELECT household_id, kind, archived FROM budget_categories WHERE id = ?", (category_id,),
    ).fetchone()
    if cat is None or str(cat["household_id"]) != household_id:
        raise PurchasesError("catégorie introuvable", status=404, code="not_found")
    if int(cat["archived"]):
        raise PurchasesError("catégorie archivée", code="validation_error")
    if str(cat["kind"]) != "expense":
        raise PurchasesError("catégorie expense requise", code="validation_error")
    ref = _household_reference_currency(conn, household_id)
    if str(acc["currency"]) != ref:
        raise PurchasesError(
            "devise du compte incompatible avec la devise de référence du foyer",
            code="validation_error",
        )


def _assert_household_row(conn: sqlite3.Connection, table: str, eid: str, household_id: str) -> sqlite3.Row:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (eid,)).fetchone()
    if row is None:
        raise PurchasesError("introuvable", status=404, code="not_found")
    if str(row["household_id"]) != household_id:
        raise PurchasesError("accès refusé", status=404, code="not_found")
    return row


def purchase_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "planned_id": row["planned_id"],
        "product_id": row["product_id"],
        "merchant_id": row["merchant_id"],
        "qty_milli": int(row["qty_milli"]),
        "unit": row["unit"],
        "paid_cents": int(row["paid_cents"]),
        "taxed_cents": int(row["taxed_cents"] or 0),
        "deposit_cents": int(row["deposit_cents"] or 0),
        "purchased_on": row["purchased_on"],
        "fingerprint": row["fingerprint"],
        "finance_tx_id": row["finance_tx_id"],
        "food_lot_id": row["food_lot_id"],
        "idempotency_key": row["idempotency_key"],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def _purchase_idem_row(conn: sqlite3.Connection, household_id: str, key: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT operation, request_hash, response_json, entity_id FROM purchase_idempotency "
        "WHERE household_id = ? AND idempotency_key = ?",
        (household_id, key),
    ).fetchone()


def _purchase_idem_lookup(
    conn: sqlite3.Connection,
    household_id: str,
    *,
    key: str,
    operation: str,
    request_hash: str,
) -> dict | None:
    row = _purchase_idem_row(conn, household_id, key)
    if row is None:
        return None
    if str(row["operation"]) != operation:
        raise PurchasesError("idempotency_key réservée pour une autre opération", status=409, code="conflict")
    if str(row["entity_id"]) == "_pending":
        return None
    if str(row["request_hash"]) != request_hash:
        raise PurchasesError("idempotency_key déjà utilisée avec un autre corps", status=409, code="conflict")
    try:
        return json.loads(str(row["response_json"]))
    except json.JSONDecodeError:
        raise PurchasesError("idempotence corrompue", status=503, code="storage_error")


def _purchase_idem_claim(
    conn: sqlite3.Connection,
    household_id: str,
    *,
    key: str,
    operation: str,
    body: dict,
) -> dict | None:
    schemas.require_idempotency_key(key)
    h = _body_hash(body)
    deadline = time.monotonic() + IDEM_WAIT_SEC
    while time.monotonic() < deadline:
        cached = _purchase_idem_lookup(conn, household_id, key=key, operation=operation, request_hash=h)
        if cached is not None:
            return cached
        try:
            conn.execute(
                "INSERT INTO purchase_idempotency"
                "(household_id, idempotency_key, operation, request_hash, entity_type, entity_id, response_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    household_id, key, operation, h, "purchase", "_pending",
                    _safe_json({"ok": True, "pending": True}), _now(),
                ),
            )
            return None
        except sqlite3.IntegrityError:
            row = _purchase_idem_row(conn, household_id, key)
            if row is None:
                continue
            if str(row["operation"]) != operation:
                raise PurchasesError("idempotency_key réservée pour une autre opération", status=409, code="conflict")
            if str(row["request_hash"]) != h:
                raise PurchasesError("idempotency_key déjà utilisée avec un autre corps", status=409, code="conflict")
        time.sleep(0.01)
    raise PurchasesError("idempotency occupée — réessayez", status=409, code="conflict")


def _purchase_idem_finalize(
    conn: sqlite3.Connection,
    household_id: str,
    *,
    key: str,
    operation: str,
    body: dict,
    entity_id: str,
    response: dict,
) -> None:
    h = _body_hash(body)
    conn.execute(
        "UPDATE purchase_idempotency SET operation = ?, request_hash = ?, entity_type = ?, entity_id = ?, response_json = ? "
        "WHERE household_id = ? AND idempotency_key = ?",
        (operation, h, "purchase", entity_id, _safe_json(response), household_id, key),
    )


def validate_post_body_static(data: dict) -> dict:
    """Fail-closed validation — no DB, safe before opening a writable store."""
    _reject_unknown_fields(data, POST_ACTUAL_KEYS)
    if _optional_bool(data, "adjust_inventory"):
        raise PurchasesError(
            "adjust_inventory non implémenté — Inventoria reste hors chemin (aucun apply)",
            status=501,
            code="not_implemented",
        )
    planned = data.get("planned_id")
    if planned is not None:
        raise PurchasesError(
            "planned_id non supporté — table planned absente en v6",
            code="validation_error",
        )
    post_finance = _optional_bool(data, "post_finance")
    create_lot = _optional_bool(data, "create_lot")
    if not post_finance:
        bad = FINANCE_OPTIONAL_KEYS & set(data)
        if bad:
            sample = ", ".join(sorted(bad)[:6])
            raise PurchasesError(
                f"paramètres finances interdits quand post_finance=false ({sample})",
                code="validation_error",
            )
    if post_finance:
        for fld in ("account_id", "category_id"):
            if not data.get(fld):
                raise PurchasesError(f"{fld} requis quand post_finance", code="validation_error")
            try:
                schemas.require_id(data[fld], fld.replace("_id", ""), fld)
            except schemas.SchemaError as exc:
                raise PurchasesError(str(exc), code=exc.code) from exc
        _require_payee_memo(data.get("payee"), "payee", max_len=finances.PAYEE_MAX)
        _require_payee_memo(data.get("memo"), "memo", max_len=finances.MEMO_MAX)
    if not create_lot:
        bad_lot = LOT_OPTIONAL_KEYS & set(data)
        if bad_lot:
            sample = ", ".join(sorted(bad_lot)[:6])
            raise PurchasesError(
                f"paramètres lot interdits quand create_lot=false ({sample})",
                code="validation_error",
            )
    if create_lot and not data.get("product_id"):
        raise PurchasesError("product_id requis quand create_lot", code="validation_error")
    qty = _require_qty_milli(data.get("qty_milli"))
    unit = _require_unit(data.get("unit"))
    paid = _require_cents(data.get("paid_cents"), "paid_cents")
    taxed = _require_cents(data.get("taxed_cents", 0), "taxed_cents")
    deposit = _require_cents(data.get("deposit_cents", 0), "deposit_cents")
    _assert_purchase_cents_sum(paid, taxed, deposit)
    try:
        schemas.require_iso_date(data.get("purchased_on"), "purchased_on")
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc
    fp = data.get("fingerprint")
    if not isinstance(fp, str) or not (1 <= len(fp.strip()) <= 200):
        raise PurchasesError("fingerprint requis", code="validation_error")
    try:
        schemas.require_idempotency_key(data.get("idempotency_key"))
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc
    try:
        schemas.require_id(data.get("merchant_id"), "merchant", "merchant_id")
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc
    product_id = data.get("product_id")
    if product_id is not None:
        try:
            schemas.require_id(product_id, "product", "product_id")
        except schemas.SchemaError as exc:
            raise PurchasesError(str(exc), code=exc.code) from exc
    pid = data.get("id")
    if pid is not None:
        try:
            schemas.require_id(pid, "purchase")
        except schemas.SchemaError as exc:
            raise PurchasesError(str(exc), code=exc.code) from exc
    rev = data.get("rev", 1)
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise PurchasesError("rev invalide", code="validation_error")
    return {
        "qty_milli": qty,
        "unit": unit,
        "paid_cents": paid,
        "taxed_cents": taxed,
        "deposit_cents": deposit,
        "fingerprint": fp.strip(),
        "post_finance": post_finance,
        "create_lot": create_lot,
        "rev": rev,
        "payee": _require_payee_memo(data.get("payee"), "payee", max_len=finances.PAYEE_MAX) if post_finance else "",
        "memo": _require_payee_memo(data.get("memo"), "memo", max_len=finances.MEMO_MAX) if post_finance else "",
    }


def _validate_post_body(data: dict) -> dict:
    return validate_post_body_static(data)


def list_actual_purchases(conn: sqlite3.Connection, household_id: str, qs: dict | None) -> dict:
    limit = _page_limit(qs)
    cursor = _qs_first(qs, "cursor")
    merchant_id = _qs_first(qs, "merchant_id")
    product_id = _qs_first(qs, "product_id")
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    if merchant_id:
        schemas.require_id(merchant_id, "merchant", "merchant_id")
        clauses.append("merchant_id = ?")
        params.append(merchant_id)
    if product_id:
        schemas.require_id(product_id, "product", "product_id")
        clauses.append("product_id = ?")
        params.append(product_id)
    if cursor:
        m = PURCHASE_CURSOR_RE.match(cursor)
        if not m:
            raise PurchasesError("cursor achats invalide", code="validation_error")
        po, pid = m.group("d"), m.group("id")
        schemas.require_id(pid, "purchase", "cursor")
        clauses.append("(purchased_on < ? OR (purchased_on = ? AND id < ?))")
        params.extend([po, po, pid])
    sql = "SELECT * FROM actual_purchases WHERE " + " AND ".join(clauses)
    sql += " ORDER BY purchased_on DESC, id DESC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    items = [purchase_to_api(r) for r in rows]
    next_cursor = None
    if len(items) == limit:
        last = items[-1]
        next_cursor = f"{last['purchased_on']}~{last['id']}"
    return {"ok": True, "items": items, "next_cursor": next_cursor, "limit": limit}


def post_actual_purchase(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    norm = _validate_post_body(data)
    key = str(data["idempotency_key"])
    body_for_hash = dict(data)
    cached = _purchase_idem_claim(conn, household_id, key=key, operation=PURCHASE_OP, body=body_for_hash)
    if cached is not None:
        return cached

    _assert_household_row(conn, "merchants", data["merchant_id"], household_id)
    product_id = data.get("product_id")
    if product_id:
        prod = _assert_household_row(conn, "products", product_id, household_id)
        if norm["unit"] != prod["canonical_unit"]:
            raise PurchasesError(
                "unit incompatible avec canonical_unit du produit",
                code="validation_error",
            )

    dup = conn.execute(
        "SELECT id FROM actual_purchases WHERE household_id = ? AND fingerprint = ?",
        (household_id, norm["fingerprint"]),
    ).fetchone()
    if dup is not None:
        raise PurchasesError("fingerprint déjà enregistré", status=409, code="conflict")

    if norm["post_finance"]:
        _assert_finance_refs(
            conn, household_id,
            account_id=str(data["account_id"]),
            category_id=str(data["category_id"]),
        )

    pid = data.get("id") or _new_id("purchase")
    now = _now()
    finance_tx_id = None
    food_lot_id = None

    try:
        schemas.validate_actual_purchase({
            "id": pid,
            "merchant_id": data["merchant_id"],
            "qty_milli": norm["qty_milli"],
            "unit": norm["unit"],
            "paid_cents": norm["paid_cents"],
            "taxed_cents": norm["taxed_cents"],
            "deposit_cents": norm["deposit_cents"],
            "purchased_on": data["purchased_on"],
            "fingerprint": norm["fingerprint"],
            "idempotency_key": key,
            "rev": norm["rev"],
        })
    except schemas.SchemaError as exc:
        raise PurchasesError(str(exc), code=exc.code) from exc

    try:
        conn.execute(
            "INSERT INTO actual_purchases("
            "id, household_id, planned_id, product_id, merchant_id, qty_milli, unit, "
            "paid_cents, taxed_cents, deposit_cents, purchased_on, fingerprint, "
            "finance_tx_id, food_lot_id, idempotency_key, created_at, updated_at, rev"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                pid, household_id, None, product_id, data["merchant_id"],
                norm["qty_milli"], norm["unit"], norm["paid_cents"], norm["taxed_cents"],
                norm["deposit_cents"], data["purchased_on"], norm["fingerprint"],
                None, None, key, now, now, norm["rev"],
            ),
        )
    except sqlite3.IntegrityError:
        raise PurchasesError("fingerprint déjà enregistré", status=409, code="conflict")

    if norm["post_finance"]:
        mch = conn.execute("SELECT name FROM merchants WHERE id = ?", (data["merchant_id"],)).fetchone()
        payee = norm["payee"] or (mch["name"] if mch else "")
        memo = norm["memo"]
        tx_key = f"{key}:grocery-tx"
        tx = finances.insert_transaction(
            conn,
            household_id,
            {
                "account_id": data["account_id"],
                "category_id": data["category_id"],
                "booked_on": data["purchased_on"],
                "amount_cents": -norm["paid_cents"],
                "payee": payee,
                "memo": memo,
                "idempotency_key": tx_key,
                "external_fingerprint": norm["fingerprint"],
                "source": "grocery_purchase",
            },
            pin_idem=True,
            via="grocery_purchase",
        )
        finance_tx_id = tx["id"]
        conn.execute(
            "UPDATE actual_purchases SET finance_tx_id = ?, updated_at = ? WHERE id = ?",
            (finance_tx_id, _now(), pid),
        )

    if norm["create_lot"]:
        lot_body: dict[str, Any] = {
            "product_id": product_id,
            "qty_milli": norm["qty_milli"],
            "usable_qty_milli": norm["qty_milli"],
            "canonical_unit": norm["unit"],
            "source_purchase_id": pid,
        }
        if data.get("link_item_id"):
            lot_body["item_id"] = data["link_item_id"]
        if data.get("place_id"):
            lot_body["place_id"] = data["place_id"]
        if data.get("opened_on"):
            lot_body["opened_on"] = data["opened_on"]
        if data.get("expires_on"):
            lot_body["expires_on"] = data["expires_on"]
        lot = grocery.create_lot(conn, household_id, lot_body)
        food_lot_id = lot["id"]
        conn.execute(
            "UPDATE actual_purchases SET food_lot_id = ?, updated_at = ? WHERE id = ?",
            (food_lot_id, _now(), pid),
        )

    row = conn.execute("SELECT * FROM actual_purchases WHERE id = ?", (pid,)).fetchone()
    out_purchase = purchase_to_api(row)
    resp = {"ok": True, "purchase": out_purchase}
    if finance_tx_id:
        resp["transaction_id"] = finance_tx_id
    if food_lot_id:
        resp["food_lot_id"] = food_lot_id
    _purchase_idem_finalize(
        conn, household_id, key=key, operation=PURCHASE_OP, body=body_for_hash,
        entity_id=pid, response=resp,
    )
    return resp


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
    if isinstance(exc, finances.FinanceError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, grocery.GroceryError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, PurchasesError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    return 500, {"ok": False, "error": "erreur interne", "code": "internal"}


def http_get(path: str, qs: dict | None = None) -> tuple[int, dict]:
    try:
        st = _open_store(readonly=True)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=False)
            if path == "/api/grocery/purchases/actual":
                return 200, list_actual_purchases(conn, household_id, qs or {})
            raise PurchasesError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (PurchasesError, schemas.SchemaError, hstore.HouseholdStoreError, finances.FinanceError, grocery.GroceryError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}


def http_post(path: str, data: Any) -> tuple[int, dict]:
    try:
        if isinstance(data, list):
            raise PurchasesError("JSON objet requis", code="validation_error")
        if not isinstance(data, dict):
            raise PurchasesError("JSON objet requis", code="validation_error")
        if len(json.dumps(data, ensure_ascii=False)) > BODY_MAX:
            raise PurchasesError("corps trop volumineux", status=413, code="validation_error")
        if path == "/api/grocery/purchases/actual":
            validate_post_body_static(data)
        st = _open_store(readonly=False)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=True)
            if path == "/api/grocery/purchases/actual":
                with st.transaction():
                    out = post_actual_purchase(conn, household_id, data)
                return 200, out
            raise PurchasesError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (PurchasesError, schemas.SchemaError, hstore.HouseholdStoreError, finances.FinanceError, grocery.GroceryError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}
