# -*- coding: utf-8 -*-
"""Transfert HQ — Meals recipes, plans, grocery-list builder (PR #34).

Planning only: no hq_inventory.apply, no finance writes, no lot mutations.
API contract: ``schemas/household/meals.v1.json`` (schema_version 1).
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import hq_finances as finances
import hq_grocery as grocery
import hq_household_schemas as schemas
import hq_household_store as hstore

BODY_MAX = 1_048_576
PAGE_MAX = 200
SQLITE_INT_MIN = -(2**63)
SQLITE_INT_MAX = 2**63 - 1
IDEM_WAIT_SEC = 2.0

POST_RECIPE_KEYS = frozenset({
    "id", "rev", "title", "servings", "ingredients", "steps", "leftover_policy",
})
POST_PLAN_KEYS = frozenset({"id", "rev", "period_start", "period_end", "slots"})
BUILD_LIST_KEYS = frozenset({
    "mode", "subtract_available_stock", "preview_digest", "idempotency_key",
})
INGREDIENT_KEYS = frozenset({
    "product_id", "name", "qty_milli", "unit", "optional", "substitutes",
})
SUBSTITUTE_KEYS = frozenset({"product_id", "name"})
SLOT_KEYS = frozenset({"date", "meal", "recipe_id", "notes"})
GROCERY_LIST_LINES_MAX = 500

RECIPE_CURSOR_SEP = "|"
PLAN_CURSOR_SEP = "|"
ID_PREFIX = {"recipe": "rcp", "meal_plan": "mpl"}
BUILD_OP = "meal_plan_build_list"

_cb: dict[str, Any] = {}
_guard = threading.Lock()


class MealsError(Exception):
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
        raise MealsError("module meals non initialisé", status=503, code="storage_error")
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
        raise MealsError("kind id inconnu", code="validation_error")
    return f"{pre}-{secrets.token_hex(8)}"


def _open_store(*, readonly: bool = False, create: bool | None = None) -> hstore.HouseholdStore:
    if create is None:
        create = not readonly
    return hstore.open_store(_root(), create=create, readonly=readonly)


def _reject_unknown_fields(data: dict, allowed: frozenset[str]) -> None:
    extra = set(data) - allowed
    if extra:
        sample = ", ".join(sorted(extra)[:8])
        raise MealsError(f"Champs inconnus ({sample})", code="validation_error")


def _require_qty_milli(v: Any, field: str = "qty_milli", *, min_value: int = 0) -> int:
    try:
        q = schemas.require_qty_milli(v, field, min_value=min_value)
    except schemas.SchemaError as exc:
        raise MealsError(str(exc), code=exc.code) from exc
    if q < SQLITE_INT_MIN or q > SQLITE_INT_MAX:
        raise MealsError(f"{field} hors plage SQLite INTEGER", code="validation_error")
    return q


def _optional_text(v: Any, field: str, max_len: int) -> str | None:
    if v is None:
        return None
    if isinstance(v, (dict, list, tuple, set)):
        raise MealsError(f"{field} invalide", code="validation_error")
    if not isinstance(v, str):
        raise MealsError(f"{field} invalide", code="validation_error")
    s = v.strip()
    if not s:
        return None
    if len(s) > max_len:
        raise MealsError(f"{field} trop long", code="validation_error")
    return s


def _body_hash(payload: dict) -> str:
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _safe_json(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _assert_household_row(conn: sqlite3.Connection, table: str, eid: str, household_id: str) -> sqlite3.Row:
    row = conn.execute(f"SELECT * FROM {table} WHERE id = ?", (eid,)).fetchone()
    if row is None:
        raise MealsError("introuvable", status=404, code="not_found")
    if str(row["household_id"]) != household_id:
        raise MealsError("accès refusé", status=404, code="not_found")
    return row


def _normalize_name_key(name: str) -> str:
    s = name.lower().strip()
    return re.sub(r"\s+", " ", s)


def _parse_name_id_cursor(cursor: str) -> tuple[str, str]:
    if "|" not in cursor:
        raise MealsError("cursor invalide", code="validation_error")
    cname, cid = cursor.rsplit("|", 1)
    if not cname or not cid:
        raise MealsError("cursor invalide", code="validation_error")
    return cname, cid


def _encode_name_id_cursor(name: str, eid: str) -> str:
    return f"{name}|{eid}"


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


def _parse_substitutes(
    conn: sqlite3.Connection,
    household_id: str,
    raw: Any,
    *,
    field_prefix: str,
) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 20:
        raise MealsError(f"{field_prefix}.substitutes invalide", code="validation_error")
    out: list[dict] = []
    for j, sub in enumerate(raw):
        if not isinstance(sub, dict):
            raise MealsError(f"{field_prefix}.substitutes[{j}] invalide", code="validation_error")
        extra = set(sub) - SUBSTITUTE_KEYS
        if extra:
            raise MealsError(f"{field_prefix}.substitutes[{j}] champs interdits", code="validation_error")
        pid = sub.get("product_id")
        if pid is not None:
            try:
                schemas.require_id(pid, "product", f"{field_prefix}.substitutes[{j}].product_id")
            except schemas.SchemaError as exc:
                raise MealsError(str(exc), code=exc.code) from exc
            _assert_household_row(conn, "products", pid, household_id)
        name = sub.get("name")
        if name is not None:
            name = _optional_text(name, f"{field_prefix}.substitutes[{j}].name", 160)
        if pid is None and not name:
            raise MealsError(f"{field_prefix}.substitutes[{j}] vide", code="validation_error")
        out.append({"product_id": pid, "name": name})
    return out


def _add_qty_milli(prev: int, qty: int) -> int:
    nxt = prev + qty
    if nxt > SQLITE_INT_MAX:
        raise MealsError("dépassement capacité INTEGER", code="validation_error")
    return nxt


def _parse_subtract_flag(data: dict) -> bool:
    if "subtract_available_stock" not in data:
        return False
    try:
        return schemas.require_bool(data["subtract_available_stock"], "subtract_available_stock")
    except schemas.SchemaError as exc:
        raise MealsError(str(exc), code=exc.code) from exc


def _parse_ingredients(
    conn: sqlite3.Connection,
    household_id: str,
    raw: Any,
) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > 100:
        raise MealsError("ingredients invalides", code="validation_error")
    out: list[dict] = []
    for i, ing in enumerate(raw):
        if not isinstance(ing, dict):
            raise MealsError("ingredient invalide", code="validation_error")
        extra = set(ing) - INGREDIENT_KEYS
        if extra:
            raise MealsError(f"ingredients[{i}] champs interdits", code="validation_error")
        name = ing.get("name")
        if not isinstance(name, str) or not name.strip():
            raise MealsError(f"ingredients[{i}].name invalide", code="validation_error")
        name = name.strip()
        if len(name) > 160:
            raise MealsError(f"ingredients[{i}].name trop long", code="validation_error")
        qty = _require_qty_milli(ing.get("qty_milli"), f"ingredients[{i}].qty_milli")
        unit = ing.get("unit")
        try:
            unit = schemas.require_unit(unit, f"ingredients[{i}].unit")
        except schemas.SchemaError as exc:
            raise MealsError(str(exc), code=exc.code) from exc
        product_id = ing.get("product_id")
        if product_id is not None:
            try:
                schemas.require_id(product_id, "product", f"ingredients[{i}].product_id")
            except schemas.SchemaError as exc:
                raise MealsError(str(exc), code=exc.code) from exc
            prow = _assert_household_row(conn, "products", product_id, household_id)
            if unit != prow["canonical_unit"]:
                raise MealsError(
                    f"ingredients[{i}].unit incompatible avec le produit",
                    code="validation_error",
                )
        optional = False
        if "optional" in ing:
            optional = schemas.require_bool(ing["optional"], f"ingredients[{i}].optional")
        subs = _parse_substitutes(conn, household_id, ing.get("substitutes"), field_prefix=f"ingredients[{i}]")
        out.append({
            "product_id": product_id,
            "name": name,
            "qty_milli": qty,
            "unit": unit,
            "optional": optional,
            "substitutes": subs,
        })
    return out


def _parse_steps(raw: Any) -> list[str]:
    if not isinstance(raw, list) or len(raw) > 80:
        raise MealsError("steps invalides", code="validation_error")
    out: list[str] = []
    for i, step in enumerate(raw):
        if not isinstance(step, str) or not step.strip():
            raise MealsError(f"steps[{i}] invalide", code="validation_error")
        if len(step) > 2000:
            raise MealsError(f"steps[{i}] trop long", code="validation_error")
        out.append(step.strip())
    return out


def _recipe_row_to_api(row: sqlite3.Row) -> dict:
    ingredients = json.loads(row["ingredients_json"] or "[]")
    steps = json.loads(row["steps_json"] or "[]")
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "title": row["title"],
        "servings": int(row["servings"]),
        "ingredients": ingredients if isinstance(ingredients, list) else [],
        "steps": steps if isinstance(steps, list) else [],
        "leftover_policy": row["leftover_policy"],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def _plan_row_to_api(row: sqlite3.Row) -> dict:
    slots = json.loads(row["slots_json"] or "[]")
    return {
        "id": row["id"],
        "household_id": row["household_id"],
        "period_start": row["period_start"],
        "period_end": row["period_end"],
        "slots": slots if isinstance(slots, list) else [],
        "rev": int(row["rev"]),
        "schema_version": 1,
    }


def create_recipe(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_RECIPE_KEYS)
    title = _optional_text(data.get("title"), "title", 160)
    if not title:
        raise MealsError("title invalide")
    servings = data.get("servings")
    if not isinstance(servings, int) or isinstance(servings, bool) or not (1 <= servings <= 100):
        raise MealsError("servings invalide")
    policy = data.get("leftover_policy")
    if policy not in ("none", "freeze", "plan_next"):
        raise MealsError("leftover_policy invalide")
    ingredients = _parse_ingredients(conn, household_id, data.get("ingredients"))
    steps = _parse_steps(data.get("steps"))
    doc = {
        "id": _new_id("recipe"),
        "title": title,
        "servings": servings,
        "ingredients": ingredients,
        "steps": steps,
        "leftover_policy": policy,
        "rev": 1,
    }
    schemas.validate_recipe({**doc, "id": doc["id"]})
    now = _now()
    conn.execute(
        "INSERT INTO recipes(id, household_id, title, servings, ingredients_json, steps_json, "
        "leftover_policy, created_at, updated_at, rev) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        (
            doc["id"], household_id, title, servings,
            json.dumps(ingredients, ensure_ascii=False),
            json.dumps(steps, ensure_ascii=False),
            policy, now, now,
        ),
    )
    row = conn.execute("SELECT * FROM recipes WHERE id = ?", (doc["id"],)).fetchone()
    return _recipe_row_to_api(row)


def update_recipe(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_RECIPE_KEYS)
    try:
        schemas.require_id(data.get("id"), "recipe")
    except schemas.SchemaError as exc:
        raise MealsError(str(exc), code=exc.code) from exc
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise MealsError("rev invalide")
    row = _assert_household_row(conn, "recipes", data["id"], household_id)
    if int(row["rev"]) != rev:
        raise MealsError("rev obsolète", status=409, code="conflict")
    title = row["title"]
    if "title" in data:
        title = _optional_text(data.get("title"), "title", 160)
        if not title:
            raise MealsError("title invalide")
    servings = int(row["servings"])
    if "servings" in data:
        servings = data["servings"]
        if not isinstance(servings, int) or isinstance(servings, bool) or not (1 <= servings <= 100):
            raise MealsError("servings invalide")
    policy = row["leftover_policy"]
    if "leftover_policy" in data:
        policy = data["leftover_policy"]
        if policy not in ("none", "freeze", "plan_next"):
            raise MealsError("leftover_policy invalide")
    ingredients = json.loads(row["ingredients_json"] or "[]")
    if "ingredients" in data:
        ingredients = _parse_ingredients(conn, household_id, data.get("ingredients"))
    steps = json.loads(row["steps_json"] or "[]")
    if "steps" in data:
        steps = _parse_steps(data.get("steps"))
    schemas.validate_recipe({
        "id": data["id"],
        "title": title,
        "servings": servings,
        "ingredients": ingredients,
        "steps": steps,
        "leftover_policy": policy,
        "rev": rev + 1,
    })
    now = _now()
    cur = conn.execute(
        "UPDATE recipes SET title = ?, servings = ?, ingredients_json = ?, steps_json = ?, "
        "leftover_policy = ?, updated_at = ?, rev = ? WHERE id = ? AND household_id = ? AND rev = ?",
        (
            title, servings,
            json.dumps(ingredients, ensure_ascii=False),
            json.dumps(steps, ensure_ascii=False),
            policy, now, rev + 1, data["id"], household_id, rev,
        ),
    )
    if cur.rowcount != 1:
        raise MealsError("rev obsolète", status=409, code="conflict")
    row2 = conn.execute("SELECT * FROM recipes WHERE id = ?", (data["id"],)).fetchone()
    return _recipe_row_to_api(row2)


def upsert_recipe(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    if data.get("id"):
        return update_recipe(conn, household_id, data)
    return create_recipe(conn, household_id, data)


def get_recipe(conn: sqlite3.Connection, household_id: str, recipe_id: str) -> dict:
    try:
        schemas.require_id(recipe_id, "recipe")
    except schemas.SchemaError as exc:
        raise MealsError(str(exc), code=exc.code) from exc
    row = _assert_household_row(conn, "recipes", recipe_id, household_id)
    return _recipe_row_to_api(row)


def list_recipes(conn: sqlite3.Connection, household_id: str, qs: dict | None) -> dict:
    limit = _page_limit(qs)
    cursor = _qs_first(qs, "cursor")
    rid = _qs_first(qs, "id")
    if rid:
        return {"ok": True, "items": [get_recipe(conn, household_id, rid)], "next_cursor": None}
    q = _qs_first(qs, "q").strip()
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    if q:
        clauses.append("title LIKE ?")
        params.append(f"%{q}%")
    if cursor:
        cname, cid = _parse_name_id_cursor(cursor)
        clauses.append("(title > ? OR (title = ? AND id > ?))")
        params.extend([cname, cname, cid])
    sql = "SELECT * FROM recipes WHERE " + " AND ".join(clauses)
    sql += " ORDER BY title ASC, id ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    items = [_recipe_row_to_api(r) for r in rows]
    next_cursor = None
    if len(items) == limit:
        last = items[-1]
        next_cursor = _encode_name_id_cursor(last["title"], last["id"])
    return {"ok": True, "items": items, "next_cursor": next_cursor}


def _parse_slots(
    conn: sqlite3.Connection,
    household_id: str,
    raw: Any,
    period_start: str,
    period_end: str,
) -> list[dict]:
    if not isinstance(raw, list) or len(raw) > 400:
        raise MealsError("slots invalides", code="validation_error")
    out: list[dict] = []
    for i, slot in enumerate(raw):
        if not isinstance(slot, dict):
            raise MealsError(f"slots[{i}] invalide", code="validation_error")
        extra = set(slot) - SLOT_KEYS
        if extra:
            raise MealsError(f"slots[{i}] champs interdits", code="validation_error")
        try:
            sd = schemas.require_iso_date(slot.get("date"), f"slots[{i}].date")
        except schemas.SchemaError as exc:
            raise MealsError(str(exc), code=exc.code) from exc
        if sd < period_start or sd > period_end:
            raise MealsError(f"slots[{i}].date hors période", code="validation_error")
        meal = slot.get("meal")
        if meal not in schemas.MEAL_SLOT_KINDS:
            raise MealsError(f"slots[{i}].meal invalide", code="validation_error")
        recipe_id = slot.get("recipe_id")
        if recipe_id is not None:
            try:
                schemas.require_id(recipe_id, "recipe", f"slots[{i}].recipe_id")
            except schemas.SchemaError as exc:
                raise MealsError(str(exc), code=exc.code) from exc
            _assert_household_row(conn, "recipes", recipe_id, household_id)
        notes = slot.get("notes")
        if notes is not None:
            notes = _optional_text(notes, f"slots[{i}].notes", 500)
        out.append({"date": sd, "meal": meal, "recipe_id": recipe_id, "notes": notes})
    return out


def create_meal_plan(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_PLAN_KEYS)
    try:
        ps = schemas.require_iso_date(data.get("period_start"), "period_start")
        pe = schemas.require_iso_date(data.get("period_end"), "period_end")
    except schemas.SchemaError as exc:
        raise MealsError(str(exc), code=exc.code) from exc
    if ps > pe:
        raise MealsError("period_start ne peut pas être après period_end", code="validation_error")
    slots = _parse_slots(conn, household_id, data.get("slots"), ps, pe)
    pid = _new_id("meal_plan")
    doc = {"id": pid, "period_start": ps, "period_end": pe, "slots": slots, "rev": 1}
    schemas.validate_meal_plan(doc)
    now = _now()
    conn.execute(
        "INSERT INTO meal_plans(id, household_id, period_start, period_end, slots_json, created_at, updated_at, rev) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
        (pid, household_id, ps, pe, json.dumps(slots, ensure_ascii=False), now, now),
    )
    row = conn.execute("SELECT * FROM meal_plans WHERE id = ?", (pid,)).fetchone()
    return _plan_row_to_api(row)


def update_meal_plan(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    _reject_unknown_fields(data, POST_PLAN_KEYS)
    try:
        schemas.require_id(data.get("id"), "meal_plan")
    except schemas.SchemaError as exc:
        raise MealsError(str(exc), code=exc.code) from exc
    rev = data.get("rev")
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        raise MealsError("rev invalide")
    row = _assert_household_row(conn, "meal_plans", data["id"], household_id)
    if int(row["rev"]) != rev:
        raise MealsError("rev obsolète", status=409, code="conflict")
    ps = row["period_start"]
    pe = row["period_end"]
    if "period_start" in data:
        try:
            ps = schemas.require_iso_date(data["period_start"], "period_start")
        except schemas.SchemaError as exc:
            raise MealsError(str(exc), code=exc.code) from exc
    if "period_end" in data:
        try:
            pe = schemas.require_iso_date(data["period_end"], "period_end")
        except schemas.SchemaError as exc:
            raise MealsError(str(exc), code=exc.code) from exc
    if ps > pe:
        raise MealsError("period_start ne peut pas être après period_end", code="validation_error")
    slots = json.loads(row["slots_json"] or "[]")
    if "slots" in data:
        slots = _parse_slots(conn, household_id, data.get("slots"), ps, pe)
    schemas.validate_meal_plan({
        "id": data["id"],
        "period_start": ps,
        "period_end": pe,
        "slots": slots,
        "rev": rev + 1,
    })
    now = _now()
    cur = conn.execute(
        "UPDATE meal_plans SET period_start = ?, period_end = ?, slots_json = ?, updated_at = ?, rev = ? "
        "WHERE id = ? AND household_id = ? AND rev = ?",
        (ps, pe, json.dumps(slots, ensure_ascii=False), now, rev + 1, data["id"], household_id, rev),
    )
    if cur.rowcount != 1:
        raise MealsError("rev obsolète", status=409, code="conflict")
    row2 = conn.execute("SELECT * FROM meal_plans WHERE id = ?", (data["id"],)).fetchone()
    return _plan_row_to_api(row2)


def upsert_meal_plan(conn: sqlite3.Connection, household_id: str, data: dict) -> dict:
    if data.get("id"):
        return update_meal_plan(conn, household_id, data)
    return create_meal_plan(conn, household_id, data)


def get_meal_plan(conn: sqlite3.Connection, household_id: str, plan_id: str) -> dict:
    try:
        schemas.require_id(plan_id, "meal_plan")
    except schemas.SchemaError as exc:
        raise MealsError(str(exc), code=exc.code) from exc
    row = _assert_household_row(conn, "meal_plans", plan_id, household_id)
    return _plan_row_to_api(row)


def list_meal_plans(conn: sqlite3.Connection, household_id: str, qs: dict | None) -> dict:
    limit = _page_limit(qs)
    cursor = _qs_first(qs, "cursor")
    pid = _qs_first(qs, "id")
    if pid:
        return {"ok": True, "items": [get_meal_plan(conn, household_id, pid)], "next_cursor": None}
    clauses = ["household_id = ?"]
    params: list[Any] = [household_id]
    if cursor:
        cname, cid = _parse_name_id_cursor(cursor)
        clauses.append("(period_start > ? OR (period_start = ? AND id > ?))")
        params.extend([cname, cname, cid])
    sql = "SELECT * FROM meal_plans WHERE " + " AND ".join(clauses)
    sql += " ORDER BY period_start ASC, id ASC LIMIT ?"
    params.append(limit)
    rows = conn.execute(sql, params).fetchall()
    items = [_plan_row_to_api(r) for r in rows]
    next_cursor = None
    if len(items) == limit:
        last = items[-1]
        next_cursor = _encode_name_id_cursor(last["period_start"], last["id"])
    return {"ok": True, "items": items, "next_cursor": next_cursor}


def _household_today(conn: sqlite3.Connection, household_id: str) -> str:
    row = conn.execute("SELECT timezone FROM households WHERE id = ?", (household_id,)).fetchone()
    tz_name = "UTC"
    if row is not None and row["timezone"]:
        tz_name = str(row["timezone"])
    try:
        return datetime.now(ZoneInfo(tz_name)).date().isoformat()
    except Exception:
        return schemas.utc_today()


def _usable_stock_milli(
    conn: sqlite3.Connection,
    household_id: str,
    product_id: str,
    unit: str,
    *,
    as_of_day: str,
) -> int:
    row = conn.execute(
        "SELECT COALESCE(SUM(usable_qty_milli), 0) FROM food_lots "
        "WHERE household_id = ? AND product_id = ? AND canonical_unit = ? "
        "AND (expires_on IS NULL OR expires_on = '' OR expires_on >= ?)",
        (household_id, product_id, unit, as_of_day),
    ).fetchone()
    return int(row[0] or 0)


def _stock_lots_digest(
    conn: sqlite3.Connection,
    household_id: str,
    product_id: str,
    unit: str,
    *,
    as_of_day: str,
) -> str:
    """Incremental SHA-256 over all relevant lots (stable ORDER BY id, no truncation)."""
    h = hashlib.sha256()
    cur = conn.execute(
        "SELECT id, rev, usable_qty_milli, canonical_unit, expires_on FROM food_lots "
        "WHERE household_id = ? AND product_id = ? AND canonical_unit = ? "
        "AND (expires_on IS NULL OR expires_on = '' OR expires_on >= ?) "
        "ORDER BY id ASC",
        (household_id, product_id, unit, as_of_day),
    )
    for r in cur:
        piece = json.dumps(
            {
                "id": r["id"],
                "rev": int(r["rev"]),
                "usable_qty_milli": int(r["usable_qty_milli"]),
                "canonical_unit": r["canonical_unit"],
                "expires_on": r["expires_on"] or None,
            },
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        h.update(piece.encode("utf-8"))
        h.update(b"\n")
    return h.hexdigest()


def _enforce_grocery_line_cap(lines: list[dict]) -> None:
    if len(lines) > GROCERY_LIST_LINES_MAX:
        raise MealsError(
            f"aperçu produit {len(lines)} lignes — maximum {GROCERY_LIST_LINES_MAX}",
            code="validation_error",
        )


def _aggregate_lines(
    conn: sqlite3.Connection,
    household_id: str,
    plan: dict,
) -> tuple[list[dict], list[str]]:
    """Return (lines, warnings)."""
    agg: dict[tuple, dict] = {}
    warnings: list[str] = []
    for slot in plan.get("slots") or []:
        recipe_id = slot.get("recipe_id")
        if not recipe_id:
            continue
        recipe = get_recipe(conn, household_id, recipe_id)
        for ing in recipe.get("ingredients") or []:
            pid = ing.get("product_id")
            unit = ing["unit"]
            qty = int(ing["qty_milli"])
            if pid:
                prow = _assert_household_row(conn, "products", pid, household_id)
                if unit != prow["canonical_unit"]:
                    raise MealsError(
                        f"produit {pid} — unité incompatible avec la recette",
                        code="validation_error",
                    )
                key = ("p", pid, unit)
            else:
                key = ("n", _normalize_name_key(ing["name"]), unit)
            if key not in agg:
                agg[key] = {
                    "product_id": pid,
                    "name": ing["name"],
                    "qty_milli": 0,
                    "unit": unit,
                    "merchant_id": None,
                    "estimated_cents": None,
                    "checked": False,
                    "required_milli": 0,
                }
            agg[key]["qty_milli"] = _add_qty_milli(int(agg[key]["qty_milli"]), qty)
            agg[key]["required_milli"] = agg[key]["qty_milli"]
    lines = sorted(
        agg.values(),
        key=lambda x: (
            x.get("product_id") or "",
            _normalize_name_key(x["name"]),
            x["unit"],
        ),
    )
    for line in lines:
        line.pop("required_milli", None)
    return lines, warnings


def _apply_stock_subtraction(
    conn: sqlite3.Connection,
    household_id: str,
    lines: list[dict],
    *,
    as_of_day: str,
) -> list[dict]:
    out: list[dict] = []
    for line in lines:
        copy = dict(line)
        required = int(copy["qty_milli"])
        available = 0
        if copy.get("product_id"):
            available = _usable_stock_milli(
                conn, household_id, copy["product_id"], copy["unit"], as_of_day=as_of_day,
            )
        copy["required_milli"] = required
        copy["available_milli"] = available
        to_buy = required - available
        if to_buy < 0:
            to_buy = 0
        copy["qty_milli"] = to_buy
        out.append(copy)
    for line in out:
        line.pop("required_milli", None)
        line.pop("available_milli", None)
    return out


def _source_fingerprint(
    conn: sqlite3.Connection,
    household_id: str,
    plan: dict,
    *,
    subtract_available_stock: bool,
    lines: list[dict],
) -> dict:
    recipe_ids = sorted({
        s["recipe_id"] for s in (plan.get("slots") or []) if s.get("recipe_id")
    })
    recipes_meta: list[dict] = []
    product_ids: set[str] = set()
    for rid in recipe_ids:
        row = _assert_household_row(conn, "recipes", rid, household_id)
        recipes_meta.append({"id": rid, "rev": int(row["rev"])})
        recipe = get_recipe(conn, household_id, rid)
        for ing in recipe.get("ingredients") or []:
            if ing.get("product_id"):
                product_ids.add(ing["product_id"])
    products_meta: list[dict] = []
    for pid in sorted(product_ids):
        prow = _assert_household_row(conn, "products", pid, household_id)
        products_meta.append({
            "id": pid,
            "rev": int(prow["rev"]),
            "canonical_unit": prow["canonical_unit"],
        })
    stock: list[dict] = []
    if subtract_available_stock:
        today = _household_today(conn, household_id)
        seen: set[tuple[str, str]] = set()
        for line in lines:
            pid = line.get("product_id")
            if not pid:
                continue
            u = line["unit"]
            key = (pid, u)
            if key in seen:
                continue
            seen.add(key)
            stock.append({
                "product_id": pid,
                "unit": u,
                "lots_digest": _stock_lots_digest(conn, household_id, pid, u, as_of_day=today),
            })
        stock.sort(key=lambda x: (x["product_id"], x["unit"]))
    norm_lines = [
        {
            "product_id": ln.get("product_id"),
            "name": ln["name"],
            "qty_milli": int(ln["qty_milli"]),
            "unit": ln["unit"],
        }
        for ln in lines
    ]
    return {
        "meal_plan_id": plan["id"],
        "meal_plan_rev": int(plan["rev"]),
        "recipes": recipes_meta,
        "products": products_meta,
        "subtract_available_stock": bool(subtract_available_stock),
        "stock": stock,
        "lines": norm_lines,
    }


def compute_preview_digest(fp: dict) -> str:
    text = json.dumps(fp, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_list_preview(
    conn: sqlite3.Connection,
    household_id: str,
    plan_id: str,
    *,
    subtract_available_stock: bool,
) -> dict:
    plan = get_meal_plan(conn, household_id, plan_id)
    lines, warnings = _aggregate_lines(conn, household_id, plan)
    if subtract_available_stock:
        today = _household_today(conn, household_id)
        lines = _apply_stock_subtraction(conn, household_id, lines, as_of_day=today)
    _enforce_grocery_line_cap(lines)
    fp = _source_fingerprint(
        conn, household_id, plan,
        subtract_available_stock=subtract_available_stock,
        lines=lines,
    )
    digest = compute_preview_digest(fp)
    return {
        "ok": True,
        "preview": True,
        "lines": lines,
        "preview_digest": digest,
        "warnings": warnings,
    }


def _build_idem_row(conn: sqlite3.Connection, household_id: str, key: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT operation, request_hash, response_json, entity_id, preview_digest "
        "FROM grocery_list_build_idempotency WHERE household_id = ? AND idempotency_key = ?",
        (household_id, key),
    ).fetchone()


def _build_idem_lookup(
    conn: sqlite3.Connection,
    household_id: str,
    *,
    key: str,
    operation: str,
    request_hash: str,
) -> dict | None:
    row = _build_idem_row(conn, household_id, key)
    if row is None:
        return None
    if str(row["operation"]) != operation:
        raise MealsError("idempotency_key réservée pour une autre opération", status=409, code="conflict")
    if str(row["entity_id"]) == "_pending":
        return None
    if str(row["request_hash"]) != request_hash:
        raise MealsError("idempotency_key déjà utilisée avec un autre corps", status=409, code="conflict")
    try:
        return json.loads(str(row["response_json"]))
    except json.JSONDecodeError:
        raise MealsError("idempotence corrompue", status=503, code="storage_error")


def _build_idem_claim(
    conn: sqlite3.Connection,
    household_id: str,
    *,
    key: str,
    operation: str,
    body: dict,
    preview_digest: str,
) -> dict | None:
    schemas.require_idempotency_key(key)
    h = _body_hash(body)
    deadline = time.monotonic() + IDEM_WAIT_SEC
    while time.monotonic() < deadline:
        cached = _build_idem_lookup(conn, household_id, key=key, operation=operation, request_hash=h)
        if cached is not None:
            return cached
        try:
            conn.execute(
                "INSERT INTO grocery_list_build_idempotency"
                "(household_id, idempotency_key, operation, request_hash, preview_digest, "
                "entity_type, entity_id, response_json, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    household_id, key, operation, h, preview_digest,
                    "_pending", "_pending", _safe_json({"ok": True, "pending": True}), _now(),
                ),
            )
            return None
        except sqlite3.IntegrityError:
            row = _build_idem_row(conn, household_id, key)
            if row is None:
                continue
            if str(row["operation"]) != operation:
                raise MealsError("idempotency_key réservée pour une autre opération", status=409, code="conflict")
            if str(row["request_hash"]) != h:
                raise MealsError("idempotency_key déjà utilisée avec un autre corps", status=409, code="conflict")
        time.sleep(0.01)
    raise MealsError("idempotency occupée — réessayez", status=409, code="conflict")


def _build_idem_finalize(
    conn: sqlite3.Connection,
    household_id: str,
    *,
    key: str,
    operation: str,
    body: dict,
    preview_digest: str,
    entity_type: str,
    entity_id: str,
    response: dict,
) -> None:
    if not key:
        return
    h = _body_hash(body)
    conn.execute(
        "UPDATE grocery_list_build_idempotency SET operation = ?, request_hash = ?, preview_digest = ?, "
        "entity_type = ?, entity_id = ?, response_json = ? "
        "WHERE household_id = ? AND idempotency_key = ?",
        (operation, h, preview_digest, entity_type, entity_id, _safe_json(response), household_id, key),
    )


def build_list_commit(
    conn: sqlite3.Connection,
    household_id: str,
    plan_id: str,
    data: dict,
) -> dict:
    _reject_unknown_fields(data, BUILD_LIST_KEYS)
    mode = data.get("mode")
    if mode != "commit":
        raise MealsError("mode commit requis", code="validation_error")
    preview_digest = data.get("preview_digest")
    if not isinstance(preview_digest, str) or schemas.SHA256_HEX.match(preview_digest) is None:
        raise MealsError("preview_digest invalide", code="validation_error")
    subtract = _parse_subtract_flag(data)
    key = data.get("idempotency_key")
    if not key:
        raise MealsError("idempotency_key requis", code="validation_error")
    body_commit = {
        "mode": "commit",
        "preview_digest": preview_digest,
        "subtract_available_stock": subtract,
        "idempotency_key": key,
        "plan_id": plan_id,
    }
    cached = _build_idem_claim(
        conn, household_id, key=key, operation=BUILD_OP, body=body_commit, preview_digest=preview_digest,
    )
    if cached is not None:
        return cached
    plan = get_meal_plan(conn, household_id, plan_id)
    lines, _warnings = _aggregate_lines(conn, household_id, plan)
    if subtract:
        today = _household_today(conn, household_id)
        lines = _apply_stock_subtraction(conn, household_id, lines, as_of_day=today)
    _enforce_grocery_line_cap(lines)
    fp = _source_fingerprint(
        conn, household_id, plan,
        subtract_available_stock=subtract,
        lines=lines,
    )
    current = compute_preview_digest(fp)
    if current != preview_digest:
        raise MealsError("aperçu obsolète — régénérer le preview", status=409, code="conflict")
    created = grocery.create_grocery_list(
        conn, household_id,
        {"meal_plan_id": plan_id, "status": "open", "lines": lines},
    )
    response = {"ok": True, "committed": True, "grocery_list": created, "preview_digest": preview_digest}
    _build_idem_finalize(
        conn, household_id,
        key=key,
        operation=BUILD_OP,
        body=body_commit,
        preview_digest=preview_digest,
        entity_type="grocery_list",
        entity_id=created["id"],
        response=response,
    )
    return response


def build_list(
    conn: sqlite3.Connection,
    household_id: str,
    plan_id: str,
    data: dict,
) -> dict:
    _reject_unknown_fields(data, BUILD_LIST_KEYS)
    mode = data.get("mode", "preview")
    if mode not in ("preview", "commit"):
        raise MealsError("mode invalide", code="validation_error")
    subtract = _parse_subtract_flag(data)
    if mode == "preview":
        return build_list_preview(conn, household_id, plan_id, subtract_available_stock=subtract)
    if mode == "commit":
        return build_list_commit(conn, household_id, plan_id, data)
    raise MealsError("mode invalide", code="validation_error")


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
    if isinstance(exc, grocery.GroceryError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    if isinstance(exc, MealsError):
        return exc.status, {"ok": False, "error": str(exc)[:200], "code": exc.code}
    return 500, {"ok": False, "error": "erreur interne", "code": "internal"}


def http_get(path: str, qs: dict | None = None) -> tuple[int, dict]:
    try:
        st = _open_store(readonly=True, create=False)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=False)
            if path == "/api/meals/recipes":
                return 200, list_recipes(conn, household_id, qs or {})
            if path == "/api/meals/plans":
                return 200, list_meal_plans(conn, household_id, qs or {})
            raise MealsError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (MealsError, schemas.SchemaError, hstore.HouseholdStoreError, grocery.GroceryError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}


def http_post(path: str, data: Any) -> tuple[int, dict]:
    try:
        if isinstance(data, list):
            raise MealsError("JSON objet requis", code="validation_error")
        if not isinstance(data, dict):
            raise MealsError("JSON objet requis", code="validation_error")
        if len(json.dumps(data, ensure_ascii=False)) > BODY_MAX:
            raise MealsError("corps trop volumineux", status=413, code="validation_error")
        import re as _re

        build_m = _re.fullmatch(r"/api/meals/plans/([^/]+)/build-list", path)
        if build_m and data.get("mode", "preview") == "preview":
            plan_id = build_m.group(1)
            st = _open_store(readonly=True, create=False)
            try:
                conn = st.conn
                household_id = finances.ensure_default_household(conn, create=False)
                out = build_list(conn, household_id, plan_id, data)
            finally:
                st.close()
            return 200, out

        st = _open_store(readonly=False, create=True)
        try:
            conn = st.conn
            household_id = finances.ensure_default_household(conn, create=True)
            if path == "/api/meals/recipes":
                with st.transaction():
                    out = upsert_recipe(conn, household_id, data)
                return 200, {"ok": True, "recipe": out}
            if path == "/api/meals/plans":
                with st.transaction():
                    out = upsert_meal_plan(conn, household_id, data)
                return 200, {"ok": True, "meal_plan": out}
            if build_m:
                plan_id = build_m.group(1)
                with st.transaction():
                    out = build_list_commit(conn, household_id, plan_id, data)
                return 200, out
            raise MealsError("Route inconnue", status=404, code="not_found")
        finally:
            st.close()
    except (MealsError, schemas.SchemaError, hstore.HouseholdStoreError, grocery.GroceryError) as exc:
        return _err(exc)
    except sqlite3.Error:
        return 503, {"ok": False, "error": "stockage indisponible", "code": "storage_error"}
