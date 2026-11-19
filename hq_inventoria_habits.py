# -*- coding: utf-8 -*-
"""What Inventoria learns so the Master types less: preferences, nicknames, barcodes, usual quantities, usual shelf/unit.

One small JSON file (.hq-inventoria/habits.json) written atomically through hq_state. Nothing here changes stock: it only
decides whether a simple change may apply at once (prefs), which item a word or code means, and which defaults to suggest.
"""
from __future__ import annotations

import json
import re
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "habits.json"
DEFAULT_PREFS = {"auto_apply": True, "auto_delta_max": 50}
AUTO_DELTA_CAP = 500
ALIASES_MAX = 200
BARCODES_MAX = 2000
NAMES_MAX = 2000
USUAL_KEYS_MAX = 8
USUAL_MIN_COUNT = 2             # a quantity becomes "usual" once it was used at least this often
ALIAS_RE = re.compile(r"^.{1,60}$", re.S)
BARCODE_RE = re.compile(r"^[A-Za-z0-9.\-]{4,48}$")
_lock = threading.RLock()


class HabitError(ValueError):
    """Bad input for a learned habit (alias, barcode, preference)."""


def norm(text: Any) -> str:
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


_cache: dict[str, tuple[tuple[int, int], dict]] = {}


def _read(root: Any) -> dict:
    """Read-only view, cached on the file's mtime/size: item listings ask for usual amounts once per item."""
    p = _path(root)
    try:
        st = p.stat()
    except FileNotFoundError:
        return {}
    except OSError:
        return _load(root)
    key = (st.st_mtime_ns, st.st_size)
    hit = _cache.get(str(p))
    if hit and hit[0] == key:
        return hit[1]
    data = _load(root)
    _cache[str(p)] = (key, data)
    return data


def _save(root: Any, data: dict) -> None:
    if data.get("_unreadable"):
        raise HabitError("habits.json illisible : rien n'est écrasé")
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(p, data)
    _cache.pop(str(p), None)


def _section(data: dict, key: str) -> dict:
    val = data.get(key)
    if not isinstance(val, dict):
        val = {}
        data[key] = val
    return val


# ---------------------------------------------------------------- preferences

def get_prefs(root: Any) -> dict:
    d = _read(root)
    raw = d.get("prefs") if isinstance(d.get("prefs"), dict) else {}
    out = dict(DEFAULT_PREFS)
    if isinstance(raw.get("auto_apply"), bool):
        out["auto_apply"] = raw["auto_apply"]
    cap = raw.get("auto_delta_max")
    if isinstance(cap, int) and not isinstance(cap, bool) and 1 <= cap <= AUTO_DELTA_CAP:
        out["auto_delta_max"] = cap
    return out


def set_prefs(root: Any, *, auto_apply: Any = None, auto_delta_max: Any = None) -> dict:
    with _lock:
        d = _load(root)
        cur = get_prefs(root)
        if auto_apply is not None:
            if not isinstance(auto_apply, bool):
                raise HabitError("auto_apply doit être un booléen")
            cur["auto_apply"] = auto_apply
        if auto_delta_max is not None:
            if isinstance(auto_delta_max, bool) or not isinstance(auto_delta_max, int) or not 1 <= auto_delta_max <= AUTO_DELTA_CAP:
                raise HabitError(f"auto_delta_max : 1 à {AUTO_DELTA_CAP}")
            cur["auto_delta_max"] = auto_delta_max
        d["prefs"] = cur
        _save(root, d)
        return cur


# ---------------------------------------------------------------- nicknames ("PQ" = papier toilette)

def aliases(root: Any) -> dict[str, dict]:
    d = _read(root)
    raw = d.get("aliases") if isinstance(d.get("aliases"), dict) else {}
    return {k: v for k, v in raw.items() if isinstance(v, dict) and isinstance(v.get("item_id"), str)}


def alias_item(root: Any, text: Any) -> str | None:
    """The item id a nickname means (exact, case/accent-insensitive), else None."""
    key = norm(text)
    if not key or root is None:
        return None
    row = aliases(root).get(key)
    return row["item_id"] if row else None


def set_alias(root: Any, alias: Any, item_id: str, *, item_name: str = "") -> dict:
    if not isinstance(alias, str) or not ALIAS_RE.match(alias.strip()) or not norm(alias):
        raise HabitError("surnom invalide (1 à 60 caractères)")
    key = norm(alias)
    if key == norm(item_name):
        raise HabitError("ce surnom est déjà le nom de l'article")
    with _lock:
        d = _load(root)
        sec = _section(d, "aliases")
        if key not in sec and len(sec) >= ALIASES_MAX:
            raise HabitError(f"trop de surnoms (max {ALIASES_MAX}) : oublie-en un d'abord")
        sec[key] = {"alias": alias.strip()[:60], "item_id": item_id, "item_name": str(item_name)[:160], "at": time.time()}
        _save(root, d)
        return sec[key]


def remove_alias(root: Any, alias: Any) -> bool:
    key = norm(alias)
    with _lock:
        d = _load(root)
        sec = _section(d, "aliases")
        if key not in sec:
            return False
        sec.pop(key)
        _save(root, d)
        return True


def alias_lines(root: Any, inv: dict | None = None, limit: int = 40) -> list[str]:
    """'PQ -> Papier toilette [itm-…]' for the prompt; nicknames of deleted items are left out."""
    live = {i["id"]: i.get("name") for i in (inv or {}).get("items", []) if isinstance(i, dict)} if inv else None
    rows = []
    for row in aliases(root).values():
        if live is not None and row["item_id"] not in live:
            continue
        name = live.get(row["item_id"]) if live is not None else row.get("item_name")
        rows.append(f"{row.get('alias')} -> {name} [{row['item_id']}]")
    return sorted(rows)[:limit]


# ---------------------------------------------------------------- barcodes

def check_code(code: Any) -> str:
    if not isinstance(code, str) or not BARCODE_RE.match(code.strip()):
        raise HabitError("code-barres invalide")
    return code.strip()


def barcode_item(root: Any, code: Any) -> str | None:
    try:
        code = check_code(code)
    except HabitError:
        return None
    d = _read(root)
    row = (d.get("barcodes") or {}).get(code) if isinstance(d.get("barcodes"), dict) else None
    return row.get("item_id") if isinstance(row, dict) and isinstance(row.get("item_id"), str) else None


def link_barcode(root: Any, code: Any, item_id: str) -> None:
    code = check_code(code)
    with _lock:
        d = _load(root)
        sec = _section(d, "barcodes")
        if code not in sec and len(sec) >= BARCODES_MAX:
            raise HabitError(f"trop de codes-barres (max {BARCODES_MAX})")
        sec[code] = {"item_id": item_id, "at": time.time()}
        _save(root, d)


def barcodes_for(root: Any, item_id: str) -> list[str]:
    d = _read(root)
    sec = d.get("barcodes") if isinstance(d.get("barcodes"), dict) else {}
    return sorted(c for c, row in sec.items() if isinstance(row, dict) and row.get("item_id") == item_id)


def all_barcodes(root: Any, limit: int = 300) -> list[dict]:
    d = _read(root)
    sec = d.get("barcodes") if isinstance(d.get("barcodes"), dict) else {}
    rows = [{"code": c, "item_id": row["item_id"], "at": row.get("at", 0)} for c, row in sec.items()
            if isinstance(row, dict) and isinstance(row.get("item_id"), str)]
    return sorted(rows, key=lambda r: -float(r["at"] or 0))[:limit]


def aliases_for(root: Any, item_id: str) -> list[str]:
    return sorted(str(r.get("alias")) for r in aliases(root).values() if r.get("item_id") == item_id)


def unlink_barcode(root: Any, code: Any) -> bool:
    code = check_code(code)
    with _lock:
        d = _load(root)
        sec = _section(d, "barcodes")
        if code not in sec:
            return False
        sec.pop(code)
        _save(root, d)
        return True


# ---------------------------------------------------------------- usual quantities, shelf and unit

def record_commit(root: Any, proposals: list[dict], inv_before: dict | None) -> None:
    """Learn from an applied batch: how much is usually added/used per item, and where/in what unit a name usually lives."""
    by_item = {i["id"]: i for i in (inv_before or {}).get("items", []) if isinstance(i, dict)}
    with _lock:
        d = _load(root)
        if d.get("_unreadable"):
            return
        usual = _section(d, "usual")
        names = _section(d, "names")
        for p in proposals or []:
            payload = p.get("payload") or {}
            op = p.get("op")
            if op == "item.adjust" and isinstance(payload.get("id"), str) and isinstance(payload.get("delta"), int):
                delta = payload["delta"]
                if delta == 0:
                    continue
                row = usual.setdefault(payload["id"], {})
                side = row.setdefault("add" if delta > 0 else "use", {})
                key = str(abs(delta))
                side[key] = int(side.get(key, 0)) + 1
                if len(side) > USUAL_KEYS_MAX:
                    for k in sorted(side, key=lambda k: side[k])[: len(side) - USUAL_KEYS_MAX]:
                        side.pop(k, None)
                it = by_item.get(payload["id"])
                if it:
                    _remember_name(names, it.get("name"), it.get("place"), it.get("unit"), it["id"])
            elif op == "item.create":
                _remember_name(names, payload.get("name"), payload.get("place"), payload.get("unit"), None)
        if len(names) > NAMES_MAX:
            for k in sorted(names, key=lambda k: names[k].get("at", 0))[: len(names) - NAMES_MAX]:
                names.pop(k, None)
        _save(root, d)


def _remember_name(names: dict, name: Any, place: Any, unit: Any, item_id: str | None) -> None:
    key = norm(name)
    if not key:
        return
    row = names.setdefault(key, {})
    if isinstance(place, str) and place:
        row["place"] = place
    if isinstance(unit, str) and unit.strip():
        row["unit"] = unit.strip()[:20]
    if item_id:
        row["item_id"] = item_id
    row["at"] = time.time()


def usual(root: Any, item_id: str) -> dict:
    """{"add": n | None, "use": n | None}: the most frequent amount once seen USUAL_MIN_COUNT times."""
    d = _read(root)
    row = (d.get("usual") or {}).get(item_id) if isinstance(d.get("usual"), dict) else None
    out: dict[str, int | None] = {"add": None, "use": None}
    if not isinstance(row, dict):
        return out
    for side in ("add", "use"):
        counts = row.get(side) if isinstance(row.get(side), dict) else {}
        best = max(counts.items(), key=lambda kv: (kv[1], -int(kv[0])), default=None)
        if best and int(best[1]) >= USUAL_MIN_COUNT:
            out[side] = int(best[0])
    return out


def name_defaults(root: Any, name: Any) -> dict:
    """Where/in what unit an item of this name usually lives (learned from earlier items): {"place"?, "unit"?}."""
    d = _read(root)
    row = (d.get("names") or {}).get(norm(name)) if isinstance(d.get("names"), dict) else None
    if not isinstance(row, dict):
        return {}
    return {k: row[k] for k in ("place", "unit") if isinstance(row.get(k), str) and row[k]}
