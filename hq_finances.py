# -*- coding: utf-8 -*-
"""Transfert HQ — Household finances core (PR #32).

Integer-cent ledger in household SQLite v2. Admin-only HTTP surface; bridge enforces
session + CSRF. No bank feeds, no auto-post workers, no inventoria writes.

Goals: ``saved_cents`` is a virtual progress tally (manual / UI allocation), not an
automatic mirror of account balances — avoids double-counting when ``account_id`` is set.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
from calendar import monthrange
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

import hq_household_schemas as schemas
import hq_household_store as hstore

BODY_MAX = 1_048_576
PAGE_MAX = 200
TX_LIST_MAX = 2000

ID_PREFIX = {
    "household": "hhold",
    "account": "acct",
    "category": "cat",
    "transaction": "tx",
    "envelope": "env",
    "goal": "goal",
    "recurring": "rpay",
    "audit": "aud",
}

_cb: dict[str, Any] = {}
_guard = threading.Lock()


class FinanceError(Exception):
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


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise FinanceError("module finances non initialisé", status=503, code="storage_error")
    return Path(root)


def _actor() -> str:
    fn = _cb.get("actor")
    return str(fn()) if callable(fn) else "admin"


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def _new_id(kind: str) -> str:
    pre = ID_PREFIX.get(kind)
    if not pre:
        raise FinanceError("kind id inconnu", code="validation_error")
    return f"{pre}-{secrets.token_hex(8)}"


def _open_store(*, readonly: bool = False) -> hstore.HouseholdStore:
    return hstore.open_store(_root(), create=True, readonly=readonly)


def _json_row(row: sqlite3.Row | None) -> dict | None:
    if row is None:
        return None
    return {k: row[k] for k in row.keys()}


def _body_hash(payload: dict) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _safe_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def redact_for_logs(payload: Any) -> dict:
    """Strip cent amounts and payees before bridge / diag logs."""
    if not isinstance(payload, dict):
        return {"redacted": True}
    out: dict[str, Any] = {"ok": payload.get("ok")}
    if payload.get("code"):
        out["code"] = payload["code"]
    if isinstance(payload.get("items"), list):
        out["count"] = len(payload["items"])
    return out


# ---------------------------------------------------------------- default household

def ensure_default_household(conn: sqlite3.Connection, *, create: bool = True) -> str:
    row = conn.execute("SELECT id FROM households ORDER BY created_at LIMIT 1").fetchone()
    if row is not None:
        return str(row[0])
    if not create:
        raise FinanceError("foyer non initialisé", status=404, code="not_found")
    now = _now()
    hid = _new_id("household")
    conn.execute(
        "INSERT INTO households(id, name, currency, locale, timezone, week_starts, prefs_json, created_at, updated_at, rev) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        (hid, "Foyer", "CAD", "fr-CA", "America/Toronto", "mon", '{"soft_budget_warn_pct":80,"hard_block_overspend":false}', now, now),
    )
    return hid


# ---------------------------------------------------------------- balances

def account_balance_cents(conn: sqlite3.Connection, account_id: str) -> int:
    row = conn.execute(
        "SELECT opening_balance_cents FROM accounts WHERE id = ?", (account_id,)
    ).fetchone()
    if row is None:
        raise FinanceError("compte introuvable", status=404, code="not_found")
    opening = int(row[0])
    srow = conn.execute(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM transactions WHERE account_id = ? AND status = 'posted'",
        (account_id,),
    ).fetchone()
    posted = int(srow[0] or 0)
    return opening + posted


# ---------------------------------------------------------------- idempotency

def idempotency_lookup(
    conn: sqlite3.Connection,
    *,
    key: str,
    operation: str,
    request_hash: str,
) -> dict | None:
    row = conn.execute(
        "SELECT request_hash, response_json, entity_id, pinned FROM finance_idempotency "
        "WHERE idempotency_key = ? AND operation = ?",
        (key, operation),
    ).fetchone()
    if row is None:
        return None
    if str(row[2]) == "_pending" and int(row[3]) == 0:
        return None
    if str(row[0]) != request_hash:
        raise FinanceError("idempotency_key déjà utilisée avec un autre corps", status=409, code="conflict")
    try:
        return json.loads(str(row[1]))
    except json.JSONDecodeError:
        raise FinanceError("idempotence corrompue", status=503, code="storage_error")


def idempotency_store(
    conn: sqlite3.Connection,
    *,
    key: str,
    operation: str,
    request_hash: str,
    entity_type: str,
    entity_id: str,
    response: dict,
    pin: bool,
) -> None:
    conn.execute(
        "INSERT INTO finance_idempotency"
        "(idempotency_key, operation, request_hash, entity_type, entity_id, response_json, created_at, pinned) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (key, operation, request_hash, entity_type, entity_id, _safe_json(response), _now(), 1 if pin else 0),
    )


def idempotency_claim(
    conn: sqlite3.Connection,
    *,
    key: str | None,
    operation: str,
    body: dict,
) -> dict | None:
    if not key:
        return None
    schemas.require_idempotency_key(key)
    h = _body_hash(body)
    deadline = _now() + 5.0
    while _now() < deadline:
        cached = idempotency_lookup(conn, key=key, operation=operation, request_hash=h)
        if cached is not None:
            return cached
        try:
            idempotency_store(
                conn,
                key=key,
                operation=operation,
                request_hash=h,
                entity_type="_pending",
                entity_id="_pending",
                response={"ok": True, "pending": True},
                pin=False,
            )
            return None
        except sqlite3.IntegrityError:
            row = conn.execute(
                "SELECT request_hash FROM finance_idempotency WHERE idempotency_key = ? AND operation = ?",
                (key, operation),
            ).fetchone()
            if row and str(row[0]) != h:
                raise FinanceError("idempotency_key déjà utilisée avec un autre corps", status=409, code="conflict")
        time.sleep(0.01)
    raise FinanceError("idempotency occupée — réessayez", status=409, code="conflict")


def idempotency_finalize(
    conn: sqlite3.Connection,
    *,
    key: str | None,
    operation: str,
    body: dict,
    entity_type: str,
    entity_id: str,
    response: dict,
) -> None:
    if not key:
        return
    h = _body_hash(body)
    conn.execute(
        "UPDATE finance_idempotency SET entity_type = ?, entity_id = ?, response_json = ?, pinned = 1 "
        "WHERE idempotency_key = ? AND operation = ? AND request_hash = ?",
        (entity_type, entity_id, _safe_json(response), key, operation, h),
    )


# ---------------------------------------------------------------- audit

def write_audit(
    conn: sqlite3.Connection,
    *,
    action: str,
    entity_type: str,
    entity_id: str,
    before: dict | None = None,
    after: dict | None = None,
    reason: str | None = None,
    ref: str | None = None,
) -> None:
    aid = _new_id("audit")
    conn.execute(
        "INSERT INTO ledger_audit(id, at, actor, action, entity_type, entity_id, before_json, after_json, reason, ref) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            aid,
            _now(),
            _actor()[:120],
            action[:80],
            entity_type[:40],
            entity_id,
            None if before is None else _safe_json(before),
            None if after is None else _safe_json(after),
            None if reason is None else reason[:500],
            None if ref is None else ref[:120],
        ),
    )


# ---------------------------------------------------------------- accounts

def account_row_to_api(row: sqlite3.Row, conn: sqlite3.Connection) -> dict:
    bal = account_balance_cents(conn, str(row["id"]))
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "name": row["name"],
        "kind": row["kind"],
        "opening_balance_cents": int(row["opening_balance_cents"]),
        "currency": row["currency"],
        "archived": bool(int(row["archived"])),
        "balance_cents": bal,
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def list_accounts(conn: sqlite3.Connection, household_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM accounts WHERE household_id = ? ORDER BY name", (household_id,)
    ).fetchall()
    return [account_row_to_api(r, conn) for r in rows]


def create_account(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    name = data.get("name")
    if not isinstance(name, str) or not (0 < len(name) <= 120):
        raise FinanceError("name invalide")
    kind = data.get("kind")
    if kind not in ("cash", "checking", "credit", "savings", "other"):
        raise FinanceError("kind invalide")
    opening = schemas.require_cents(data.get("opening_balance_cents"), "opening_balance_cents")
    currency = data.get("currency") or "CAD"
    if currency not in ("CAD", "USD", "EUR"):
        raise FinanceError("currency invalide")
    now = _now()
    aid = _new_id("account")
    conn.execute(
        "INSERT INTO accounts(id, household_id, name, kind, opening_balance_cents, currency, archived, created_at, updated_at, rev) "
        "VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 1)",
        (aid, household_id, name, kind, opening, currency, now, now),
    )
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (aid,)).fetchone()
    out = account_row_to_api(row, conn)
    write_audit(conn, action="account.create", entity_type="account", entity_id=aid, after=out)
    return out


def update_account(conn: sqlite3.Connection, data: dict) -> dict:
    schemas.require_id(data.get("id"), "account")
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise FinanceError("rev invalide")
    row = conn.execute("SELECT * FROM accounts WHERE id = ?", (data["id"],)).fetchone()
    if row is None:
        raise FinanceError("compte introuvable", status=404, code="not_found")
    if int(row["rev"]) != rev:
        raise FinanceError("rev obsolète", status=409, code="conflict")
    before = account_row_to_api(row, conn)
    name = before["name"]
    kind = before["kind"]
    archived = before["archived"]
    if "name" in data:
        if not isinstance(data["name"], str) or not (0 < len(data["name"]) <= 120):
            raise FinanceError("name invalide")
        name = data["name"]
    if "kind" in data:
        if data["kind"] not in ("cash", "checking", "credit", "savings", "other"):
            raise FinanceError("kind invalide")
        kind = data["kind"]
    if "archived" in data:
        archived = schemas.require_bool(data["archived"], "archived")
    now = _now()
    new_rev = rev + 1
    conn.execute(
        "UPDATE accounts SET name = ?, kind = ?, archived = ?, updated_at = ?, rev = ? WHERE id = ?",
        (name, kind, 1 if archived else 0, now, new_rev, data["id"]),
    )
    row2 = conn.execute("SELECT * FROM accounts WHERE id = ?", (data["id"],)).fetchone()
    out = account_row_to_api(row2, conn)
    write_audit(conn, action="account.update", entity_type="account", entity_id=data["id"], before=before, after=out)
    return out


# ---------------------------------------------------------------- categories

def category_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "name": row["name"],
        "kind": row["kind"],
        "parent_id": row["parent_id"],
        "archived": bool(int(row["archived"])),
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def list_categories(conn: sqlite3.Connection, household_id: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM budget_categories WHERE household_id = ? ORDER BY name",
        (household_id,),
    ).fetchall()
    return [category_to_api(r) for r in rows]


def upsert_category(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    cid = data.get("id")
    if cid is None:
        name = data.get("name")
        if not isinstance(name, str) or not (0 < len(name) <= 120):
            raise FinanceError("name invalide")
        kind = data.get("kind")
        if kind not in ("income", "expense", "transfer"):
            raise FinanceError("kind invalide")
        parent = data.get("parent_id")
        if parent is not None:
            schemas.require_id(parent, "category", "parent_id")
        now = _now()
        cid = _new_id("category")
        conn.execute(
            "INSERT INTO budget_categories(id, household_id, name, kind, parent_id, archived, created_at, updated_at, rev) "
            "VALUES (?, ?, ?, ?, ?, 0, ?, ?, 1)",
            (cid, household_id, name, kind, parent, now, now),
        )
        row = conn.execute("SELECT * FROM budget_categories WHERE id = ?", (cid,)).fetchone()
        out = category_to_api(row)
        write_audit(conn, action="category.create", entity_type="category", entity_id=cid, after=out)
        return out
    schemas.require_id(cid, "category")
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise FinanceError("rev invalide")
    row = conn.execute("SELECT * FROM budget_categories WHERE id = ?", (cid,)).fetchone()
    if row is None:
        raise FinanceError("catégorie introuvable", status=404, code="not_found")
    if int(row["rev"]) != rev:
        raise FinanceError("rev obsolète", status=409, code="conflict")
    before = category_to_api(row)
    name = before["name"]
    kind = before["kind"]
    archived = before["archived"]
    if "name" in data:
        if not isinstance(data["name"], str) or not (0 < len(data["name"]) <= 120):
            raise FinanceError("name invalide")
        name = data["name"]
    if "kind" in data:
        if data["kind"] not in ("income", "expense", "transfer"):
            raise FinanceError("kind invalide")
        kind = data["kind"]
    if "archived" in data:
        archived = schemas.require_bool(data["archived"], "archived")
    now = _now()
    conn.execute(
        "UPDATE budget_categories SET name = ?, kind = ?, archived = ?, updated_at = ?, rev = ? WHERE id = ?",
        (name, kind, 1 if archived else 0, now, rev + 1, cid),
    )
    row2 = conn.execute("SELECT * FROM budget_categories WHERE id = ?", (cid,)).fetchone()
    out = category_to_api(row2)
    write_audit(conn, action="category.update", entity_type="category", entity_id=cid, before=before, after=out)
    return out


# ---------------------------------------------------------------- transactions

def transaction_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "account_id": row["account_id"],
        "booked_on": row["booked_on"],
        "amount_cents": int(row["amount_cents"]),
        "category_id": row["category_id"],
        "payee": row["payee"] or "",
        "memo": row["memo"] or "",
        "transfer_pair_id": row["transfer_pair_id"],
        "status": row["status"],
        "source": row["source"],
        "external_fingerprint": row["external_fingerprint"],
        "correction_of": row["correction_of"],
        "idempotency_key": row["idempotency_key"],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def _validate_tx_payload(data: dict, household_id: str, *, require_key: bool) -> dict:
    doc = dict(data)
    doc["household_id"] = household_id
    doc.setdefault("payee", "")
    doc.setdefault("memo", "")
    if require_key:
        doc["idempotency_key"] = schemas.require_idempotency_key(data.get("idempotency_key"))
    elif data.get("idempotency_key") is not None:
        doc["idempotency_key"] = schemas.require_idempotency_key(data["idempotency_key"])
    if doc.get("id") is None:
        doc["id"] = _new_id("transaction")
    if doc.get("rev") is None:
        doc["rev"] = 1
    if doc.get("status") is None:
        doc["status"] = "posted"
    if doc.get("source") is None:
        doc["source"] = "manual"
    schemas.validate_transaction(doc)
    return doc


def insert_transaction(conn: sqlite3.Connection, household_id: str, data: dict, *, pin_idem: bool) -> dict:
    doc = _validate_tx_payload(data, household_id, require_key=pin_idem)
    acc = conn.execute("SELECT currency FROM accounts WHERE id = ?", (doc["account_id"],)).fetchone()
    if acc is None:
        raise FinanceError("compte introuvable", status=404, code="not_found")
    cat = conn.execute("SELECT id FROM budget_categories WHERE id = ?", (doc["category_id"],)).fetchone()
    if cat is None:
        raise FinanceError("catégorie introuvable", status=404, code="not_found")
    now = _now()
    conn.execute(
        "INSERT INTO transactions(id, household_id, account_id, booked_on, amount_cents, category_id, payee, memo, "
        "transfer_pair_id, status, source, external_fingerprint, correction_of, idempotency_key, created_at, updated_at, rev) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            doc["id"],
            household_id,
            doc["account_id"],
            doc["booked_on"],
            doc["amount_cents"],
            doc["category_id"],
            doc.get("payee") or "",
            doc.get("memo") or "",
            doc.get("transfer_pair_id"),
            doc["status"],
            doc["source"],
            doc.get("external_fingerprint"),
            doc.get("correction_of"),
            doc.get("idempotency_key"),
            now,
            now,
            doc["rev"],
        ),
    )
    row = conn.execute("SELECT * FROM transactions WHERE id = ?", (doc["id"],)).fetchone()
    out = transaction_to_api(row)
    write_audit(conn, action="transaction.create", entity_type="transaction", entity_id=doc["id"], after=out)
    return out


def list_transactions(conn: sqlite3.Connection, household_id: str, qs: dict) -> dict:
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    account = (qs.get("account") or qs.get("account_id") or [""])[0]
    if account:
        schemas.require_id(account, "account", "account_id")
        clauses.append("account_id = ?")
        params.append(account)
    category = (qs.get("category") or qs.get("category_id") or [""])[0]
    if category:
        schemas.require_id(category, "category", "category_id")
        clauses.append("category_id = ?")
        params.append(category)
    fr = (qs.get("from") or [""])[0]
    if fr:
        schemas.require_iso_date(fr, "from")
        clauses.append("booked_on >= ?")
        params.append(fr)
    to = (qs.get("to") or [""])[0]
    if to:
        schemas.require_iso_date(to, "to")
        clauses.append("booked_on <= ?")
        params.append(to)
    try:
        limit = min(PAGE_MAX, max(1, int((qs.get("limit") or ["50"])[0])))
    except (TypeError, ValueError):
        limit = 50
    cursor = (qs.get("cursor") or [""])[0]
    if cursor:
        clauses.append("id > ?")
        params.append(cursor)
    sql = "SELECT * FROM transactions WHERE " + " AND ".join(clauses) + " ORDER BY id LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    items = [transaction_to_api(r) for r in rows]
    next_cursor = items[-1]["id"] if len(items) == limit else None
    return {"ok": True, "items": items, "next_cursor": next_cursor, "limit": limit}


def post_transaction(st: hstore.HouseholdStore, data: dict) -> dict:
    body = dict(data)
    key = body.get("idempotency_key")
    op = "transaction.post"
    with st.transaction():
        conn = st.conn
        household_id = ensure_default_household(conn)
        cached = idempotency_claim(conn, key=key, operation=op, body=body)
        if cached is not None:
            return cached
        require_key = body.get("status", "posted") == "posted"
        tx = insert_transaction(conn, household_id, body, pin_idem=require_key)
        resp = {"ok": True, "transaction": tx}
        idempotency_finalize(
            conn,
            key=key,
            operation=op,
            body=body,
            entity_type="transaction",
            entity_id=tx["id"],
            response=resp,
        )
        return resp


def correct_transaction(st: hstore.HouseholdStore, data: dict) -> dict:
    body = dict(data)
    key = body.get("idempotency_key")
    op = "transaction.correct"
    orig_id = body.get("correction_of")
    schemas.require_id(orig_id, "transaction", "correction_of")
    with st.transaction():
        conn = st.conn
        household_id = ensure_default_household(conn)
        cached = idempotency_claim(conn, key=key, operation=op, body=body)
        if cached is not None:
            return cached
        orig = conn.execute("SELECT * FROM transactions WHERE id = ?", (orig_id,)).fetchone()
        if orig is None:
            raise FinanceError("transaction source introuvable", status=404, code="not_found")
        if str(orig["status"]) != "posted":
            raise FinanceError("seules les transactions postées sont corrigeables")
        delta = body.get("amount_cents")
        amount = schemas.require_cents(delta) if delta is not None else -int(orig["amount_cents"])
        corr = {
            "account_id": body.get("account_id") or orig["account_id"],
            "category_id": body.get("category_id") or orig["category_id"],
            "booked_on": body.get("booked_on") or orig["booked_on"],
            "amount_cents": amount,
            "status": "posted",
            "source": "correction",
            "correction_of": orig_id,
            "payee": body.get("payee") or orig["payee"] or "",
            "memo": body.get("memo") or orig["memo"] or "",
            "idempotency_key": key,
        }
        tx = insert_transaction(conn, household_id, corr, pin_idem=True)
        resp = {"ok": True, "transaction": tx, "original_id": orig_id}
        idempotency_finalize(
            conn, key=key, operation=op, body=body,
            entity_type="transaction", entity_id=tx["id"], response=resp,
        )
        write_audit(conn, action="transaction.correct", entity_type="transaction", entity_id=tx["id"],
                    reason=body.get("reason"), ref=orig_id)
        return resp


# ---------------------------------------------------------------- transfers

def post_transfer(st: hstore.HouseholdStore, data: dict) -> dict:
    body = dict(data)
    op = "transfer.post"
    key = schemas.require_idempotency_key(body.get("idempotency_key"))
    amount = schemas.require_cents(body.get("amount_cents"), min_value=1)
    src = body.get("from_account_id") or body.get("source_account_id")
    dst = body.get("to_account_id") or body.get("dest_account_id")
    schemas.require_id(src, "account", "from_account_id")
    schemas.require_id(dst, "account", "to_account_id")
    if src == dst:
        raise FinanceError("transfert vers le même compte")
    booked = schemas.require_iso_date(body.get("booked_on") or date.today().isoformat(), "booked_on")
    category = body.get("category_id")
    with st.transaction():
        conn = st.conn
        household_id = ensure_default_household(conn)
        cached = idempotency_claim(conn, key=key, operation=op, body=body)
        if cached is not None:
            return cached
        srow = conn.execute("SELECT currency, archived FROM accounts WHERE id = ?", (src,)).fetchone()
        drow = conn.execute("SELECT currency, archived FROM accounts WHERE id = ?", (dst,)).fetchone()
        if srow is None or drow is None:
            raise FinanceError("compte introuvable", status=404, code="not_found")
        if int(srow["archived"]) or int(drow["archived"]):
            raise FinanceError("compte archivé", code="validation_error")
        if srow["currency"] != drow["currency"]:
            raise FinanceError("devises incompatibles", code="validation_error")
        if category is None:
            crow = conn.execute(
                "SELECT id FROM budget_categories WHERE household_id = ? AND kind = 'transfer' LIMIT 1",
                (household_id,),
            ).fetchone()
            if crow is None:
                raise FinanceError("catégorie transfer requise", code="validation_error")
            category = crow[0]
        else:
            schemas.require_id(category, "category", "category_id")
        pair = _new_id("transaction")
        legs = [
            {
                "account_id": src,
                "amount_cents": -amount,
            },
            {
                "account_id": dst,
                "amount_cents": amount,
            },
        ]
        txs: list[dict] = []
        try:
            for leg in legs:
                tx = insert_transaction(
                    conn,
                    household_id,
                    {
                        "account_id": leg["account_id"],
                        "category_id": category,
                        "booked_on": booked,
                        "amount_cents": leg["amount_cents"],
                        "transfer_pair_id": pair,
                        "status": "posted",
                        "source": "manual",
                        "payee": body.get("payee") or "Transfer",
                        "memo": body.get("memo") or "",
                        "idempotency_key": key,
                    },
                    pin_idem=True,
                )
                txs.append(tx)
        except Exception:
            raise
        if sum(t["amount_cents"] for t in txs) != 0:
            raise FinanceError("invariant transfert brisé", status=500, code="storage_error")
        resp = {"ok": True, "transfer_pair_id": pair, "transactions": txs}
        write_audit(conn, action="transfer.post", entity_type="transfer", entity_id=pair, after={"tx": [t["id"] for t in txs]})
        idempotency_finalize(
            conn, key=key, operation=op, body=body,
            entity_type="transfer", entity_id=pair, response=resp,
        )
        return resp


# ---------------------------------------------------------------- envelopes / spent

def envelope_spent_cents(conn: sqlite3.Connection, category_id: str, start: str, end: str) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(-amount_cents), 0) FROM transactions "
        "WHERE category_id = ? AND status = 'posted' AND booked_on >= ? AND booked_on <= ? AND amount_cents < 0",
        (category_id, start, end),
    ).fetchone()
    return max(0, int(row[0] or 0))


def envelope_to_api(row: sqlite3.Row, conn: sqlite3.Connection) -> dict:
    spent = envelope_spent_cents(conn, str(row["category_id"]), str(row["period_start"]), str(row["period_end"]))
    alloc = int(row["allocated_cents"])
    used_pct = (spent * 100) // alloc if alloc > 0 else 0
    return {
        "id": row["id"],
        "category_id": row["category_id"],
        "period_start": row["period_start"],
        "period_end": row["period_end"],
        "allocated_cents": alloc,
        "spent_cents": spent,
        "used_pct": used_pct,
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def list_envelopes(conn: sqlite3.Connection, household_id: str, qs: dict) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM budget_envelopes WHERE household_id = ? ORDER BY period_start DESC",
        (household_id,),
    ).fetchall()
    return [envelope_to_api(r, conn) for r in rows]


def upsert_envelope(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    schemas.require_iso_date(data.get("period_start"), "period_start")
    schemas.require_iso_date(data.get("period_end"), "period_end")
    if data["period_start"] > data["period_end"]:
        raise FinanceError("période invalide")
    alloc = schemas.require_cents(data.get("allocated_cents"), min_value=0)
    schemas.require_id(data.get("category_id"), "category", "category_id")
    eid = data.get("id")
    now = _now()
    if eid is None:
        eid = _new_id("envelope")
        conn.execute(
            "INSERT INTO budget_envelopes(id, household_id, category_id, period_start, period_end, allocated_cents, created_at, updated_at, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
            (eid, household_id, data["category_id"], data["period_start"], data["period_end"], alloc, now, now),
        )
    else:
        schemas.require_id(eid, "envelope")
        rev = data.get("rev")
        if not isinstance(rev, int) or isinstance(rev, bool):
            raise FinanceError("rev invalide")
        row = conn.execute("SELECT rev FROM budget_envelopes WHERE id = ?", (eid,)).fetchone()
        if row is None:
            raise FinanceError("enveloppe introuvable", status=404, code="not_found")
        if int(row[0]) != rev:
            raise FinanceError("rev obsolète", status=409, code="conflict")
        conn.execute(
            "UPDATE budget_envelopes SET category_id = ?, period_start = ?, period_end = ?, allocated_cents = ?, updated_at = ?, rev = ? "
            "WHERE id = ?",
            (data["category_id"], data["period_start"], data["period_end"], alloc, now, rev + 1, eid),
        )
    row = conn.execute("SELECT * FROM budget_envelopes WHERE id = ?", (eid,)).fetchone()
    out = envelope_to_api(row, conn)
    write_audit(conn, action="envelope.upsert", entity_type="envelope", entity_id=eid, after=out)
    return out


# overlapping periods policy: spent is attributed to every envelope whose period contains booked_on.


# ---------------------------------------------------------------- recurring

def _advance_next_on(iso: str, cadence: str) -> str:
    d = date.fromisoformat(iso)
    if cadence == "weekly":
        d = d + timedelta(days=7)
    elif cadence == "biweekly":
        d = d + timedelta(days=14)
    elif cadence == "monthly":
        y, m = d.year, d.month
        m += 1
        if m > 12:
            m = 1
            y += 1
        last = monthrange(y, m)[1]
        d = date(y, m, min(d.day, last))
    elif cadence == "yearly":
        try:
            d = d.replace(year=d.year + 1)
        except ValueError:
            d = d.replace(year=d.year + 1, month=2, day=28)
    else:
        raise FinanceError("cadence invalide")
    return d.isoformat()


def recurring_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "account_id": row["account_id"],
        "category_id": row["category_id"],
        "amount_cents": int(row["amount_cents"]),
        "currency": row["currency"],
        "cadence": row["cadence"],
        "next_on": row["next_on"],
        "auto_post": bool(int(row["auto_post"])),
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def list_recurring(conn: sqlite3.Connection, household_id: str) -> list[dict]:
    rows = conn.execute("SELECT * FROM recurring_payments WHERE household_id = ?", (household_id,)).fetchall()
    return [recurring_to_api(r) for r in rows]


def upsert_recurring(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    amount = schemas.require_cents(data.get("amount_cents"))
    cadence = data.get("cadence")
    if cadence not in ("weekly", "biweekly", "monthly", "yearly"):
        raise FinanceError("cadence invalide")
    next_on = schemas.require_iso_date(data.get("next_on"), "next_on")
    schemas.require_id(data.get("account_id"), "account", "account_id")
    schemas.require_id(data.get("category_id"), "category", "category_id")
    auto_post = data.get("auto_post", False)
    auto_post = schemas.require_bool(auto_post, "auto_post")
    currency = data.get("currency") or "CAD"
    now = _now()
    rid = data.get("id")
    if rid is None:
        rid = _new_id("recurring")
        conn.execute(
            "INSERT INTO recurring_payments(id, household_id, account_id, category_id, amount_cents, currency, cadence, next_on, auto_post, created_at, updated_at, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
            (rid, household_id, data["account_id"], data["category_id"], amount, currency, cadence, next_on, 1 if auto_post else 0, now, now),
        )
    else:
        schemas.require_id(rid, "recurring")
        rev = data.get("rev")
        if not isinstance(rev, int) or isinstance(rev, bool):
            raise FinanceError("rev invalide")
        row = conn.execute("SELECT rev FROM recurring_payments WHERE id = ?", (rid,)).fetchone()
        if row is None:
            raise FinanceError("récurrence introuvable", status=404, code="not_found")
        if int(row[0]) != rev:
            raise FinanceError("rev obsolète", status=409, code="conflict")
        conn.execute(
            "UPDATE recurring_payments SET account_id = ?, category_id = ?, amount_cents = ?, currency = ?, cadence = ?, next_on = ?, auto_post = ?, updated_at = ?, rev = ? WHERE id = ?",
            (data["account_id"], data["category_id"], amount, currency, cadence, next_on, 1 if auto_post else 0, now, rev + 1, rid),
        )
    row = conn.execute("SELECT * FROM recurring_payments WHERE id = ?", (rid,)).fetchone()
    out = recurring_to_api(row)
    write_audit(conn, action="recurring.upsert", entity_type="recurring", entity_id=rid, after=out)
    return out


# ---------------------------------------------------------------- goals

def goal_to_api(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "target_cents": int(row["target_cents"]),
        "saved_cents": int(row["saved_cents"]),
        "due_on": row["due_on"],
        "account_id": row["account_id"],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def list_goals(conn: sqlite3.Connection, household_id: str) -> list[dict]:
    rows = conn.execute("SELECT * FROM goals WHERE household_id = ?", (household_id,)).fetchall()
    return [goal_to_api(r) for r in rows]


def upsert_goal(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    target = schemas.require_cents(data.get("target_cents"), min_value=0)
    saved = schemas.require_cents(data.get("saved_cents", 0), min_value=0)
    name = data.get("name")
    if not isinstance(name, str) or not (0 < len(name) <= 120):
        raise FinanceError("name invalide")
    due = data.get("due_on")
    if due is not None:
        schemas.require_iso_date(due, "due_on")
    account_id = data.get("account_id")
    if account_id is not None:
        schemas.require_id(account_id, "account", "account_id")
    now = _now()
    gid = data.get("id")
    if gid is None:
        gid = _new_id("goal")
        conn.execute(
            "INSERT INTO goals(id, household_id, name, target_cents, saved_cents, due_on, account_id, created_at, updated_at, rev) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
            (gid, household_id, name, target, saved, due, account_id, now, now),
        )
    else:
        schemas.require_id(gid, "goal")
        rev = data.get("rev")
        if not isinstance(rev, int) or isinstance(rev, bool):
            raise FinanceError("rev invalide")
        row = conn.execute("SELECT rev FROM goals WHERE id = ?", (gid,)).fetchone()
        if row is None:
            raise FinanceError("objectif introuvable", status=404, code="not_found")
        if int(row[0]) != rev:
            raise FinanceError("rev obsolète", status=409, code="conflict")
        conn.execute(
            "UPDATE goals SET name = ?, target_cents = ?, saved_cents = ?, due_on = ?, account_id = ?, updated_at = ?, rev = ? WHERE id = ?",
            (name, target, saved, due, account_id, now, rev + 1, gid),
        )
    row = conn.execute("SELECT * FROM goals WHERE id = ?", (gid,)).fetchone()
    out = goal_to_api(row)
    write_audit(conn, action="goal.upsert", entity_type="goal", entity_id=gid, after=out)
    return out


# ---------------------------------------------------------------- summary / audit list

def finances_summary(st: hstore.HouseholdStore) -> dict:
    conn = st.conn
    household_id = ensure_default_household(conn, create=not st.readonly)
    accounts = list_accounts(conn, household_id)
    envelopes = list_envelopes(conn, household_id, {})
    total = sum(a["balance_cents"] for a in accounts if not a["archived"])
    return {
        "ok": True,
        "household_id": household_id,
        "accounts": accounts,
        "envelopes": envelopes,
        "total_balance_cents": total,
    }


def list_audit(conn: sqlite3.Connection, qs: dict) -> dict:
    try:
        limit = min(PAGE_MAX, max(1, int((qs.get("limit") or ["50"])[0])))
    except (TypeError, ValueError):
        limit = 50
    cursor = (qs.get("cursor") or [""])[0]
    params: list[Any] = []
    sql = "SELECT id, at, actor, action, entity_type, entity_id, reason, ref FROM ledger_audit"
    if cursor:
        sql += " WHERE id > ?"
        params.append(cursor)
    sql += " ORDER BY id LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    items = [
        {
            "id": r[0],
            "at": r[1],
            "actor": r[2],
            "action": r[3],
            "entity_type": r[4],
            "entity_id": r[5],
            "reason": r[6],
            "ref": r[7],
        }
        for r in rows
    ]
    return {"ok": True, "items": items, "next_cursor": items[-1]["id"] if len(items) == limit else None}


# ---------------------------------------------------------------- HTTP

def _err(exc: FinanceError | schemas.SchemaError | hstore.HouseholdStoreError) -> tuple[int, dict]:
    if isinstance(exc, schemas.SchemaError):
        return 400, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, hstore.HouseholdStoreError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}


def _qs_list(qs: dict | None, key: str, default: str = "") -> list[str]:
    if not qs:
        return [default]
    return qs.get(key) or [default]


def http_get(path: str, qs: dict | None = None) -> tuple[int, dict]:
    try:
        st = _open_store(readonly=True)
        try:
            conn = st.conn
            household_id = ensure_default_household(conn, create=False)
            if path == "/api/finances/summary":
                return 200, finances_summary(st)
            if path == "/api/finances/accounts":
                return 200, {"ok": True, "items": list_accounts(conn, household_id)}
            if path == "/api/finances/categories":
                return 200, {"ok": True, "items": list_categories(conn, household_id)}
            if path == "/api/finances/transactions":
                return 200, list_transactions(conn, household_id, qs or {})
            if path == "/api/finances/envelopes":
                return 200, {"ok": True, "items": list_envelopes(conn, household_id, qs or {})}
            if path == "/api/finances/recurring":
                return 200, {"ok": True, "items": list_recurring(conn, household_id)}
            if path == "/api/finances/goals":
                return 200, {"ok": True, "items": list_goals(conn, household_id)}
            if path == "/api/finances/audit":
                return 200, list_audit(conn, qs or {})
            raise FinanceError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (FinanceError, schemas.SchemaError, hstore.HouseholdStoreError) as exc:
        return _err(exc)


def http_post(path: str, data: Any) -> tuple[int, dict]:
    try:
        if not isinstance(data, dict):
            raise FinanceError("JSON objet requis")
        if len(json.dumps(data, ensure_ascii=False)) > BODY_MAX:
            raise FinanceError("corps trop volumineux", status=413, code="validation_error")
        st = _open_store(readonly=False)
        try:
            conn = st.conn
            household_id = ensure_default_household(conn, create=True)
            if path == "/api/finances/accounts":
                if data.get("id"):
                    with st.transaction():
                        out = update_account(conn, data)
                    return 200, {"ok": True, "account": out}
                with st.transaction():
                    out = create_account(conn, household_id, data)
                return 200, {"ok": True, "account": out}
            if path == "/api/finances/categories":
                with st.transaction():
                    out = upsert_category(conn, household_id, data)
                return 200, {"ok": True, "category": out}
            if path == "/api/finances/transactions":
                return 200, post_transaction(st, data)
            if path == "/api/finances/transactions/correct":
                return 200, correct_transaction(st, data)
            if path == "/api/finances/transfers":
                return 200, post_transfer(st, data)
            if path == "/api/finances/envelopes":
                with st.transaction():
                    out = upsert_envelope(conn, household_id, data)
                return 200, {"ok": True, "envelope": out}
            if path == "/api/finances/recurring":
                with st.transaction():
                    out = upsert_recurring(conn, household_id, data)
                return 200, {"ok": True, "recurring": out}
            if path == "/api/finances/goals":
                with st.transaction():
                    out = upsert_goal(conn, household_id, data)
                return 200, {"ok": True, "goal": out}
            raise FinanceError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (FinanceError, schemas.SchemaError, hstore.HouseholdStoreError) as exc:
        return _err(exc)
