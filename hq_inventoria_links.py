# -*- coding: utf-8 -*-
"""What accurate stock makes possible: where things are, can I cook/build it, prices, use-soon dates, spot-checks, filament.

State lives in .hq-inventoria/links.json (atomic writes through hq_state; an unreadable file is preserved and treated as empty
for reads, never overwritten). Stock itself only changes through Inventoria's own pipeline, except the opt-in filament sync,
which subtracts what a finished 3D print used from the item the Master linked to that material.
"""
from __future__ import annotations

import json
import math
import re
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "links.json"
PRICES_MAX = 4000
DRIFT_MAX = 400
EVENTS_MAX = 30
SPOT_DAYS = 7
USE_SOON_DAYS = 5
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_lock = threading.RLock()


class LinkError(ValueError):
    """Bad input for a link (price, date, material...)."""


def _norm(text: Any) -> str:
    t = "".join(c for c in unicodedata.normalize("NFD", str(text or "").lower()) if unicodedata.category(c) != "Mn")
    return " ".join(re.sub(r"[^a-z0-9]+", " ", t).split())


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict:
    try:
        data = json.loads(_path(root).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return {"_unreadable": True}
    return data if isinstance(data, dict) else {"_unreadable": True}


def _save(root: Any, data: dict) -> None:
    if data.get("_unreadable"):
        raise LinkError("links.json illisible : rien n'est écrasé")
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(p, data)


def _sec(data: dict, key: str, kind: type = dict) -> Any:
    val = data.get(key)
    if not isinstance(val, kind):
        val = kind()
        data[key] = val
    return val


def _today(now: float | None = None) -> str:
    return time.strftime("%Y-%m-%d", time.localtime(now if now is not None else time.time()))


def _check_date(v: Any) -> str:
    if not isinstance(v, str) or not DATE_RE.match(v):
        raise LinkError("date attendue au format AAAA-MM-JJ")
    try:
        time.strptime(v, "%Y-%m-%d")
    except ValueError as exc:
        raise LinkError("date invalide") from exc
    return v


def _days_between(a: str, b: str) -> int:
    ta = time.mktime(time.strptime(a, "%Y-%m-%d"))
    tb = time.mktime(time.strptime(b, "%Y-%m-%d"))
    return int(round((tb - ta) / 86400))


def place_path(inv: dict, pid: Any) -> str:
    places = {p["id"]: p for p in inv.get("places") or [] if isinstance(p, dict)}
    chain, cur, seen = [], pid, set()
    while isinstance(cur, str) and cur in places and cur not in seen and len(chain) < 12:
        seen.add(cur)
        chain.append(str(places[cur].get("name") or ""))
        cur = places[cur].get("parent")
    return " > ".join(reversed(chain))


# ---------------------------------------------------------------- matching an item by name (nickname first)

def find_items(inv: dict, name: Any, root: Any = None, limit: int = 3) -> list[tuple[float, dict]]:
    import hq_inventoria_ai as ai
    items = [i for i in inv.get("items") or [] if isinstance(i, dict)]
    nick = None
    if root is not None:
        try:
            import hq_inventoria_habits as habits
            nick = habits.alias_item(root, name)
        except Exception:
            nick = None
    scored = sorted(((1.0 if i["id"] == nick else ai.match_score(str(name), str(i.get("name") or "")), i) for i in items),
                    key=lambda x: -x[0])
    return [(s, i) for s, i in scored[:limit] if s >= 0.6]


def _best(inv: dict, name: Any, root: Any) -> dict | None:
    """One clear match (nickname, or a score well ahead of the runner-up), else None."""
    ranked = find_items(inv, name, root, limit=2)
    if not ranked:
        return None
    if ranked[0][0] >= 0.99 or (ranked[0][0] >= 0.75 and (len(ranked) < 2 or ranked[1][0] < ranked[0][0] - 0.1)):
        return ranked[0][1]
    return None


# ---------------------------------------------------------------- 1. where is it?

def where_is(inv: dict, query: Any, root: Any = None) -> dict:
    q = str(query or "").strip()
    if not q:
        raise LinkError("quoi chercher ?")
    rows = []
    for score, it in find_items(inv, q, root, limit=4):
        photos = [p for p in it.get("photos") or [] if isinstance(p, str)]
        place_photo = None
        if not photos and it.get("place"):
            pl = next((p for p in inv.get("places") or [] if p.get("id") == it.get("place")), None)
            place_photo = (pl or {}).get("photos", [None])[0] if pl and pl.get("photos") else None
        rows.append({"id": it["id"], "name": it.get("name"), "qty": it.get("qty"), "unit": it.get("unit") or "",
                     "place_id": it.get("place"), "where": place_path(inv, it.get("place")) or None,
                     "photo": photos[0] if photos else place_photo, "photo_of": "item" if photos else ("place" if place_photo else None),
                     "score": round(score, 3)})
    return {"query": q, "matches": rows}


# ---------------------------------------------------------------- 2/3. quantities with units (parts lists, recipes)

_DIM = {
    "g": ("g", 1.0), "gr": ("g", 1.0), "gramme": ("g", 1.0), "grammes": ("g", 1.0), "kg": ("g", 1000.0), "kilo": ("g", 1000.0), "kilos": ("g", 1000.0),
    "ml": ("ml", 1.0), "cl": ("ml", 10.0), "dl": ("ml", 100.0), "l": ("ml", 1000.0), "litre": ("ml", 1000.0), "litres": ("ml", 1000.0),
    "": ("each", 1.0), "each": ("each", 1.0), "pcs": ("each", 1.0), "pc": ("each", 1.0), "piece": ("each", 1.0), "pieces": ("each", 1.0),
    "unite": ("each", 1.0), "unites": ("each", 1.0), "u": ("each", 1.0), "x": ("each", 1.0),
    "serving": ("serving", 1.0), "portion": ("serving", 1.0), "portions": ("serving", 1.0),
}


def unit_dim(unit: Any) -> tuple[str, float] | None:
    return _DIM.get(_norm(unit).replace(" ", ""))


def to_item_units(amount: float, unit: Any, item_unit: Any) -> float | None:
    """``amount`` of ``unit`` expressed in the item's unit, or None when the two cannot be compared (kg vs rolls)."""
    a, b = unit_dim(unit), unit_dim(item_unit)
    if a is None or b is None:
        return amount if _norm(unit) == _norm(item_unit) else None
    if a[0] != b[0]:
        return None
    return amount * a[1] / b[1]


def check_parts(inv: dict, parts: Any, root: Any = None) -> dict:
    """[{name, qty, unit?}] -> each row: have / short / missing / unclear / unit_mismatch, with what is on hand."""
    if not isinstance(parts, list) or not parts or len(parts) > 80:
        raise LinkError("parts : liste de 1 à 80 éléments")
    rows, ok = [], True
    for raw in parts:
        if not isinstance(raw, dict) or not str(raw.get("name") or "").strip():
            raise LinkError("chaque élément demande un name")
        need = raw.get("qty", 1)
        if isinstance(need, bool) or not isinstance(need, (int, float)) or need <= 0:
            raise LinkError("qty doit être un nombre positif")
        name = str(raw["name"]).strip()[:160]
        row: dict[str, Any] = {"name": name, "need": need, "unit": str(raw.get("unit") or "")}
        it = _best(inv, name, root)
        if it is None:
            cands = find_items(inv, name, root)
            row["status"] = "unclear" if cands else "missing"
            if cands:
                row["candidates"] = [{"id": c["id"], "name": c.get("name")} for _, c in cands]
            ok = False
            rows.append(row)
            continue
        row.update({"item_id": it["id"], "item": it.get("name"), "have": it.get("qty"), "item_unit": it.get("unit") or "",
                    "where": place_path(inv, it.get("place")) or None})
        need_items = to_item_units(float(need), raw.get("unit") or it.get("unit"), it.get("unit"))
        if need_items is None:
            row["status"] = "unit_mismatch"
            ok = False
        else:
            row["need_in_item_unit"] = round(need_items, 3)
            have = float(it.get("qty") or 0)
            row["status"] = "have" if have >= need_items - 1e-9 else "short"
            if row["status"] == "short":
                row["missing"] = round(need_items - have, 3)
                ok = False
        rows.append(row)
    return {"ok": ok, "rows": rows}


def _recipes(conn: Any, household_id: str) -> list[dict]:
    import hq_meals
    out, cursor = [], None
    for _ in range(10):
        page = hq_meals.list_recipes(conn, household_id, {"cursor": [cursor]} if cursor else {})
        out += page.get("items", [])
        cursor = page.get("next_cursor")
        if not cursor:
            break
    return out


def find_recipe(conn: Any, household_id: str, title: Any) -> dict | None:
    import hq_inventoria_ai as ai
    recipes = _recipes(conn, household_id)
    ranked = sorted(((ai.match_score(str(title), str(r.get("title") or "")), r) for r in recipes), key=lambda x: -x[0])
    return ranked[0][1] if ranked and ranked[0][0] >= 0.7 else None


def recipe_parts(recipe: dict, servings: Any = None) -> list[dict]:
    base = int(recipe.get("servings") or 1)
    scale = (float(servings) / base) if isinstance(servings, (int, float)) and not isinstance(servings, bool) and servings > 0 else 1.0
    return [{"name": ing["name"], "qty": round(ing["qty_milli"] / 1000.0 * scale, 3), "unit": ing.get("unit") or "",
             "optional": bool(ing.get("optional"))}
            for ing in recipe.get("ingredients") or [] if isinstance(ing, dict) and ing.get("qty_milli")]


def cook_check(inv: dict, conn: Any, household_id: str, title: Any, servings: Any = None, root: Any = None) -> dict:
    recipe = find_recipe(conn, household_id, title)
    if recipe is None:
        return {"found": False, "note": "no saved recipe by that name; pass its ingredients to check_parts instead"}
    parts = recipe_parts(recipe, servings)
    res = check_parts(inv, [{"name": p["name"], "qty": p["qty"], "unit": p["unit"]} for p in parts], root) if parts else {"ok": True, "rows": []}
    for row, p in zip(res["rows"], parts):
        row["optional"] = p["optional"]
    res["ok"] = all(r["status"] == "have" or r.get("optional") for r in res["rows"])
    return {"found": True, "recipe": recipe.get("title"), "recipe_id": recipe.get("id"), "servings": servings or recipe.get("servings"), **res}


def cooked_proposals(inv: dict, recipe: dict, servings: Any = None, root: Any = None) -> tuple[list[dict], list[dict]]:
    """Ingredient use as item.adjust proposals (whole item units, never below zero) + what was skipped and why."""
    props, skipped = [], []
    for p in recipe_parts(recipe, servings):
        it = _best(inv, p["name"], root)
        if it is None:
            skipped.append({"name": p["name"], "why": "no clear stock item"})
            continue
        amount = to_item_units(p["qty"], p["unit"], it.get("unit"))
        if amount is None:
            skipped.append({"name": p["name"], "why": f"unit {p['unit'] or '?'} vs {it.get('unit') or '?'}"})
            continue
        use = min(int(math.floor(amount + 0.5)), int(it.get("qty") or 0))
        if use <= 0:
            skipped.append({"name": p["name"], "why": "too small to count in " + (it.get("unit") or "units") if amount > 0 else "none in stock"})
            continue
        props.append({"op": "item.adjust", "refs": {"item_id": it["id"]}, "resolved": {"confidence": "high"},
                      "payload": {"id": it["id"], "delta": -use},
                      "label_fr": f"Cuisiné ({str(recipe.get('title') or '')[:60]}) : {it.get('name')} de {-use:+d}"})
    return props, skipped


# ---------------------------------------------------------------- 3b. prices from receipts

def record_prices(root: Any, store: Any, lines: Any, inv: dict, *, date: Any = None, now: float | None = None) -> dict:
    store_name = str(store or "").strip()[:60]
    if not store_name:
        raise LinkError("store requis (en-tête du ticket)")
    day = _check_date(date) if date else _today(now)
    if not isinstance(lines, list) or not lines or len(lines) > 80:
        raise LinkError("lines : 1 à 80 lignes")
    by_id = {i["id"]: i for i in inv.get("items") or []}
    saved, skipped = 0, []
    with _lock:
        d = _load(root)
        log = _sec(d, "prices", list)
        seen = {(r.get("store"), r.get("date"), r.get("item_id"), r.get("total_cents")) for r in log if isinstance(r, dict)}
        for ln in lines:
            if not isinstance(ln, dict):
                continue
            iid, total, qty = ln.get("item_id"), ln.get("total_cents"), ln.get("qty", 1)
            if iid not in by_id or isinstance(total, bool) or not isinstance(total, int) or not 0 <= total <= 10_000_000 \
                    or isinstance(qty, bool) or not isinstance(qty, (int, float)) or qty <= 0:
                skipped.append(str(ln.get("item_name") or iid or "?")[:60])
                continue
            key = (store_name, day, iid, total)
            if key in seen:
                continue
            seen.add(key)
            log.append({"store": store_name, "date": day, "item_id": iid, "qty": qty, "unit": by_id[iid].get("unit") or "",
                        "total_cents": total, "at": now if now is not None else time.time()})
            saved += 1
        del log[:-PRICES_MAX]
        _save(root, d)
    return {"saved": saved, "skipped": skipped}


def price_info(root: Any, item_id: str) -> dict:
    rows = [r for r in _load(root).get("prices", []) if isinstance(r, dict) and r.get("item_id") == item_id]
    if not rows:
        return {"item_id": item_id, "count": 0}
    unit = lambda r: r["total_cents"] / float(r["qty"])   # noqa: E731
    by_store: dict[str, list[float]] = {}
    for r in rows:
        by_store.setdefault(r["store"], []).append(unit(r))
    stores = sorted(({"store": s, "avg_unit_cents": round(sum(v) / len(v), 1), "seen": len(v)} for s, v in by_store.items()),
                    key=lambda x: x["avg_unit_cents"])
    recent = sorted(rows, key=lambda r: (r["date"], r.get("at", 0)))[-12:]
    return {"item_id": item_id, "count": len(rows), "cheapest": stores[0], "stores": stores,
            "history": [{"date": r["date"], "store": r["store"], "unit_cents": round(unit(r), 1)} for r in recent]}


def spending(root: Any, inv: dict, month: Any = None, now: float | None = None) -> dict:
    """Receipt totals Inventoria read, by category (the item's first tag, else its top-level place), for one month."""
    m = str(month or _today(now)[:7])
    if not re.match(r"^\d{4}-\d{2}$", m):
        raise LinkError("month attendu au format AAAA-MM")
    by_id = {i["id"]: i for i in inv.get("items") or []}
    cats: dict[str, int] = {}
    stores: dict[str, int] = {}
    total = 0
    for r in _load(root).get("prices", []):
        if not isinstance(r, dict) or not str(r.get("date", "")).startswith(m):
            continue
        it = by_id.get(r.get("item_id")) or {}
        tags = [t for t in it.get("tags") or [] if isinstance(t, str) and t]
        cat = tags[0] if tags else (place_path(inv, it.get("place")).split(" > ")[0] or "autre")
        cats[cat] = cats.get(cat, 0) + int(r["total_cents"])
        stores[r["store"]] = stores.get(r["store"], 0) + int(r["total_cents"])
        total += int(r["total_cents"])
    return {"month": m, "total_cents": total, "by_category": dict(sorted(cats.items(), key=lambda kv: -kv[1])),
            "by_store": dict(sorted(stores.items(), key=lambda kv: -kv[1])),
            "note": "Only receipts Inventoria read; the Finances ledger is separate."}


# ---------------------------------------------------------------- 4. use-soon dates

def set_expiry(root: Any, item_id: str, date: Any) -> dict:
    with _lock:
        d = _load(root)
        sec = _sec(d, "expiry")
        if date in (None, ""):
            sec.pop(item_id, None)
        else:
            sec[item_id] = _check_date(date)
        _save(root, d)
        return {"item_id": item_id, "expires_on": sec.get(item_id)}


def get_expiry(root: Any, item_id: str) -> str | None:
    day = (_load(root).get("expiry") or {}).get(item_id)
    return day if isinstance(day, str) and DATE_RE.match(day) else None


def days_left(day: str, now: float | None = None) -> int:
    return _days_between(_today(now), day)


def price_months(root: Any) -> list[str]:
    return sorted({str(r.get("date", ""))[:7] for r in _load(root).get("prices", []) if isinstance(r, dict) and r.get("date")}, reverse=True)[:24]


def filament_material(root: Any, item_id: str) -> str | None:
    for mat, iid in filament_links(root).items():
        if iid == item_id:
            return mat
    return None


def cook_check_recipe(inv: dict, recipe: dict, servings: Any = None, root: Any = None) -> dict:
    """cook_check for a recipe already loaded (by id): each ingredient have / short / missing, optional ones never block."""
    parts = recipe_parts(recipe, servings)
    res = check_parts(inv, [{"name": p["name"], "qty": p["qty"], "unit": p["unit"]} for p in parts], root) if parts else {"ok": True, "rows": []}
    for row, p in zip(res["rows"], parts):
        row["optional"] = p["optional"]
    res["ok"] = all(r["status"] == "have" or r.get("optional") for r in res["rows"])
    return {"found": True, "recipe": recipe.get("title"), "recipe_id": recipe.get("id"),
            "servings": servings or recipe.get("servings"), **res}


def use_soon(root: Any, inv: dict, *, days: int = USE_SOON_DAYS, now: float | None = None, conn: Any = None,
             household_id: str | None = None) -> list[dict]:
    """Items (and food lots of the Meals/Grocery module, when reachable) that expire within ``days``, soonest first."""
    today = _today(now)
    rows = []
    by_id = {i["id"]: i for i in inv.get("items") or []}
    for iid, day in (_load(root).get("expiry") or {}).items():
        it = by_id.get(iid)
        if not it or not isinstance(day, str) or not DATE_RE.match(day) or float(it.get("qty") or 0) <= 0:
            continue
        left = _days_between(today, day)
        if left <= days:
            rows.append({"source": "inventory", "item_id": iid, "name": it.get("name"), "qty": it.get("qty"),
                         "unit": it.get("unit") or "", "expires_on": day, "days_left": left})
    if conn is not None and household_id:
        try:
            limit = time.strftime("%Y-%m-%d", time.localtime(time.mktime(time.strptime(today, "%Y-%m-%d")) + days * 86400))
            for r in conn.execute(
                    "SELECT l.expires_on, l.usable_qty_milli, l.canonical_unit, p.name FROM food_lots l JOIN products p ON p.id = l.product_id "
                    "WHERE l.household_id = ? AND l.expires_on IS NOT NULL AND l.expires_on <= ? AND l.usable_qty_milli > 0 "
                    "ORDER BY l.expires_on LIMIT 40", (household_id, limit)).fetchall():
                rows.append({"source": "food_lot", "name": r["name"], "qty": r["usable_qty_milli"] / 1000.0, "unit": r["canonical_unit"],
                             "expires_on": r["expires_on"], "days_left": _days_between(today, r["expires_on"])})
        except Exception:
            pass
    return sorted(rows, key=lambda r: (r["days_left"], str(r["name"]).lower()))


# ---------------------------------------------------------------- 5. spot-checks and drift

def record_count(root: Any, inv: dict, rows: Any, now: float | None = None) -> dict:
    """A photo count of a shelf (count mode): how far each recorded quantity was from what was really there."""
    now = now if now is not None else time.time()
    by_id = {i["id"]: i for i in inv.get("items") or []}
    entries, places = [], {}
    for r in rows or []:
        if not isinstance(r, dict) or r.get("item_id") not in by_id:
            continue
        counted = r.get("qty")
        if isinstance(counted, bool) or not isinstance(counted, (int, float)) or counted < 0:
            continue
        it = by_id[r["item_id"]]
        entries.append({"at": now, "item_id": it["id"], "recorded": it.get("qty"), "counted": counted})
        if it.get("place"):
            places[it["place"]] = places.get(it["place"], 0) + 1
    if not entries:
        return {"recorded": 0}
    with _lock:
        d = _load(root)
        drift = _sec(d, "drift", list)
        drift.extend(entries)
        del drift[:-DRIFT_MAX]
        checks = _sec(d, "checks")
        for pid in places:
            checks[pid] = now
        item_checks = _sec(d, "item_checks")                 # "Checked ✓" on the sheet: a counted item, right or corrected
        for e in entries:
            item_checks[e["item_id"]] = now
        if len(item_checks) > DRIFT_MAX * 5:
            for k in sorted(item_checks, key=item_checks.get)[:len(item_checks) - DRIFT_MAX * 5]:
                del item_checks[k]
        _save(root, d)
    return {"recorded": len(entries), "places": list(places)}


def last_count_days(root: Any, now: float | None = None) -> int | None:
    """Whole days since any shelf was last counted, None when none ever was."""
    now = now if now is not None else time.time()
    vals = [float(v) for v in (_load(root).get("checks") or {}).values() if isinstance(v, (int, float))]
    return max(0, int((now - max(vals)) // 86400)) if vals else None


def item_checked_days(root: Any, item_id: str, now: float | None = None) -> int | None:
    now = now if now is not None else time.time()
    at = (_load(root).get("item_checks") or {}).get(item_id)
    return max(0, int((now - float(at)) // 86400)) if isinstance(at, (int, float)) else None


def accuracy(root: Any, now: float | None = None, window_days: int = 90) -> dict | None:
    now = now if now is not None else time.time()
    rows = [r for r in _load(root).get("drift", []) if isinstance(r, dict) and now - float(r.get("at", 0)) <= window_days * 86400]
    if not rows:
        return None
    close = 0
    total_off = 0.0
    for r in rows:
        rec, cnt = float(r.get("recorded") or 0), float(r.get("counted") or 0)
        off = abs(rec - cnt)
        total_off += off
        if off <= max(1.0, 0.1 * max(rec, cnt)):
            close += 1
    return {"checked": len(rows), "accurate_pct": round(100.0 * close / len(rows)), "avg_off": round(total_off / len(rows), 2),
            "window_days": window_days}


def spot_check(root: Any, inv: dict, now: float | None = None) -> dict | None:
    """This week's shelf to count: the place with items that was counted longest ago (never counted first)."""
    now = now if now is not None else time.time()
    checks = _load(root).get("checks") or {}
    holding: dict[str, int] = {}
    for it in inv.get("items") or []:
        if it.get("place"):
            holding[it["place"]] = holding.get(it["place"], 0) + 1
    places = [p for p in inv.get("places") or [] if p.get("id") in holding]
    if not places:
        return None
    pick = min(places, key=lambda p: (float(checks.get(p["id"], 0)), str(p.get("name") or "").lower()))
    last = checks.get(pick["id"])
    if last and now - float(last) < SPOT_DAYS * 86400:
        return None                                          # every place was counted this week
    return {"place_id": pick["id"], "name": pick.get("name"), "code": pick.get("code"), "items": holding[pick["id"]],
            "days_since": int((now - float(last)) // 86400) if last else None}


# ---------------------------------------------------------------- 3c. Atelier 3D filament

def filament_links(root: Any) -> dict[str, str]:
    raw = _load(root).get("filament") or {}
    return {k: v["item_id"] for k, v in raw.items() if isinstance(v, dict) and isinstance(v.get("item_id"), str)}


def link_filament(root: Any, material: Any, item_id: str | None, now: float | None = None) -> dict:
    mat = str(material or "").strip().upper()[:24]
    if not re.match(r"^[A-Z0-9+\-]{2,24}$", mat):
        raise LinkError("matière invalide (ex. PLA, PETG)")
    with _lock:
        d = _load(root)
        sec = _sec(d, "filament")
        if item_id:
            sec[mat] = {"item_id": item_id, "since": now if now is not None else time.time()}   # never retroactive
        else:
            sec.pop(mat, None)
        _save(root, d)
    return filament_links(root)


def _print_jobs(root: Any) -> list[dict]:
    try:
        data = json.loads((Path(root) / ".hq-print3d" / "history.json").read_text(encoding="utf-8"))
    except Exception:
        return []
    jobs = data.get("jobs") if isinstance(data, dict) else None
    return [j for j in jobs or [] if isinstance(j, dict)]


def sync_filament(root: Any, inv: dict, apply: Any, now: float | None = None) -> list[dict]:
    """Subtract the grams of finished/stopped prints (after the link was made) from the linked filament items.
    ``apply`` is hq_inventory.apply. Each job is applied once; grams are converted to the item's unit (g / kg)."""
    with _lock:
        d = _load(root)
        if d.get("_unreadable"):
            return []
        links = d.get("filament") or {}
        if not links:
            return []
        done = _sec(d, "filament_done", list)
        done_set = set(done)
        by_id = {i["id"]: i for i in inv.get("items") or []}
        events = []
        changed = False
        for job in _print_jobs(root):
            jid = str(job.get("id") or "")
            fil = job.get("filament") if isinstance(job.get("filament"), dict) else None
            if not jid or jid in done_set or not fil or job.get("outcome") not in ("finished", "stopped"):
                continue
            for mat, use in (fil.get("by_material") or {}).items():
                link = links.get(str(mat).upper())
                if not isinstance(link, dict) or float(job.get("at") or 0) < float(link.get("since") or 0):
                    continue
                it = by_id.get(link.get("item_id"))
                grams = float((use or {}).get("g") or 0)
                if not it or grams <= 0:
                    continue
                amount = to_item_units(grams, "g", it.get("unit") or "g")
                if amount is None:
                    continue
                delta = min(int(math.floor(amount + 0.5)), int(it.get("qty") or 0))
                if delta <= 0:
                    continue
                try:
                    apply({"action": "item.adjust", "id": it["id"], "delta": -delta})
                except Exception:
                    continue
                it["qty"] = int(it.get("qty") or 0) - delta
                events.append({"at": now if now is not None else time.time(), "job": str(job.get("job") or "")[:80],
                               "item_id": it["id"], "item": it.get("name"), "delta": -delta, "material": str(mat)})
            done.append(jid)
            done_set.add(jid)
            changed = True
        if changed:
            del done[:-3000]
            log = _sec(d, "events", list)
            log.extend(events)
            del log[:-EVENTS_MAX]
            _save(root, d)
        return events


def recent_events(root: Any, limit: int = 8) -> list[dict]:
    return list(_load(root).get("events") or [])[-limit:]
