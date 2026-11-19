"""Filament usage and cost for the Atelier 3D — pure functions, no I/O.

Where a job's figures come from, best first (``source``):

* ``slice``   — the sliced file's own numbers (Bambu ``slice_info.config``: grams and metres
                per filament), found in the Print library or on the printer's storage;
* ``printer`` — the printer's own estimate while it prints (Flashforge ``estimatedRight*``);
* ``ams``     — the drop of the AMS spool percentages between start and end (coarse: 1 % of a
                1 kg spool is 10 g);
* ``counter`` — the drop of the printer's lifetime filament counter, when nothing else exists;
* ``manual``  — a figure the Master typed over the estimate.

A stopped or failed job is the full estimate scaled by the progress it reached. Cost is never
stored: it is computed from the price table when the stats are read, so a price change
re-prices the history.
"""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone
from typing import Any

FILAMENT_DIAMETER_MM = 1.75
AREA_MM2 = math.pi * (FILAMENT_DIAMETER_MM / 2) ** 2
DENSITY = {"PLA": 1.24, "PETG": 1.27, "ABS": 1.04, "ASA": 1.07, "TPU": 1.21, "PA": 1.14,
           "PC": 1.20, "PVA": 1.19, "HIPS": 1.04, "PP": 0.90}
DEFAULT_MATERIAL = "PLA"
DEFAULT_PRICES = {"PLA": 22.0, "PETG": 24.0, "ABS": 24.0, "ASA": 26.0, "TPU": 32.0, "PA": 45.0, "PC": 40.0}
DEFAULTS = {"currency": "$", "default_price_kg": 25.0, "prices": dict(DEFAULT_PRICES), "spool_g": 1000}
SOURCES = ("slice", "printer", "ams", "counter", "manual")
_MAT_RE = re.compile(r"^[A-Z0-9+\-]{1,16}$")
MAX_PRICES = 24


class FilamentError(ValueError):
    pass


def base_material(name: Any) -> str:
    """``"PLA-S"`` / ``"pla basic"`` → ``"PLA"``; empty → the default material."""
    text = str(name or "").strip().upper()
    if not text:
        return DEFAULT_MATERIAL
    for known in sorted(DENSITY, key=len, reverse=True):
        if text == known or re.match(rf"^{re.escape(known)}[\s\-+_]", text):
            return known
    return re.split(r"[\s\-+_]", text)[0][:16] or DEFAULT_MATERIAL


def density(material: str) -> float:
    return DENSITY.get(base_material(material), DENSITY[DEFAULT_MATERIAL])


def grams_to_metres(grams: float, material: str) -> float:
    return grams / (AREA_MM2 * density(material))          # mm² × 1 m = cm³


def metres_to_grams(metres: float, material: str) -> float:
    return metres * AREA_MM2 * density(material)


def clean_settings(raw: Any, current: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validate the price table; unknown keys are dropped, bad values refused."""
    base = {**DEFAULTS, "prices": dict(DEFAULTS["prices"])}
    if isinstance(current, dict):
        base.update({k: v for k, v in current.items() if k in base})
        base["prices"] = dict(current.get("prices") or base["prices"])
    if not isinstance(raw, dict):
        return base
    if "currency" in raw:
        cur = str(raw["currency"] or "").strip()
        if not 1 <= len(cur) <= 4 or any(ord(c) < 32 for c in cur):
            raise FilamentError("Devise invalide")
        base["currency"] = cur
    for key, low, high in (("default_price_kg", 0, 1000), ("spool_g", 100, 10000)):
        if key in raw:
            try:
                value = float(raw[key])
            except (TypeError, ValueError):
                raise FilamentError("Valeur invalide : " + key) from None
            if not (low <= value <= high) or value != value:
                raise FilamentError("Valeur hors limites : " + key)
            base[key] = round(value, 2) if key == "default_price_kg" else int(value)
    if "prices" in raw:
        if not isinstance(raw["prices"], dict) or len(raw["prices"]) > MAX_PRICES:
            raise FilamentError("Table de prix invalide")
        prices: dict[str, float] = {}
        for name, value in raw["prices"].items():
            key = str(name).strip().upper()
            if not _MAT_RE.fullmatch(key):
                raise FilamentError("Nom de matériau invalide")
            try:
                price = float(value)
            except (TypeError, ValueError):
                raise FilamentError("Prix invalide") from None
            if not (0 <= price <= 1000) or price != price:
                raise FilamentError("Prix hors limites")
            prices[key] = round(price, 2)
        base["prices"] = prices
    return base


def price_per_kg(material: str, settings: dict[str, Any]) -> float:
    prices = settings.get("prices") or {}
    name = str(material or "").strip().upper()
    for key in (name, base_material(name)):
        if key in prices:
            return float(prices[key])
    return float(settings.get("default_price_kg") or 0)


# ── Estimates ──────────────────────────────────────────────────────────────

def estimate_from_slice(filaments: list[dict[str, Any]]) -> dict[str, Any] | None:
    """``filaments`` as ``parse_slice_info`` returns them (type, g, m)."""
    rows = []
    for f in filaments or []:
        grams, metres = f.get("g"), f.get("m")
        material = base_material(f.get("type"))
        if not grams and not metres:
            continue
        if not grams:
            grams = metres_to_grams(metres, material)
        if not metres:
            metres = grams_to_metres(grams, material)
        rows.append({"material": material, "g": float(grams), "m": float(metres)})
    return {"source": "slice", "filaments": rows} if rows else None


def estimate_from_printer(status: dict[str, Any]) -> dict[str, Any] | None:
    grams, metres = status.get("est_weight_g"), status.get("est_len_m")
    if not (isinstance(grams, (int, float)) and grams > 0) and not (isinstance(metres, (int, float)) and metres > 0):
        return None
    material = base_material((status.get("materials") or [DEFAULT_MATERIAL])[0])
    grams = float(grams) if grams else metres_to_grams(float(metres), material)
    metres = float(metres) if metres else grams_to_metres(grams, material)
    return {"source": "printer", "filaments": [{"material": material, "g": grams, "m": metres}]}


def ams_snapshot(slots: Any) -> dict[int, dict[str, Any]]:
    out: dict[int, dict[str, Any]] = {}
    for s in slots or []:
        try:
            remain = float(s.get("remain"))
        except (TypeError, ValueError):
            continue
        if remain >= 0 and s.get("slot"):
            out[int(s["slot"])] = {"remain": remain, "material": base_material(s.get("material"))}
    return out


def usage_from_ams(start: dict[int, dict[str, Any]], end: dict[int, dict[str, Any]], spool_g: float) -> dict[str, Any] | None:
    rows = []
    for slot, before in (start or {}).items():
        after = (end or {}).get(slot)
        if after is None:
            continue
        drop = before["remain"] - after["remain"]
        if drop > 0:
            grams = drop / 100.0 * spool_g
            rows.append({"material": before["material"], "g": grams, "m": grams_to_metres(grams, before["material"])})
    return {"source": "ams", "filaments": rows} if rows else None


def compute(estimate: dict[str, Any] | None, fraction: float | None, *, ams_start: dict | None = None,
            ams_end: dict | None = None, spool_g: float = 1000, counter_start: float | None = None,
            counter_end: float | None = None, materials: list[str] | None = None) -> dict[str, Any] | None:
    """The job's filament record, or None when nothing at all can be said."""
    source, rows, scaled = "", [], True
    if estimate and estimate.get("filaments"):
        source, rows = estimate["source"], [dict(r) for r in estimate["filaments"]]
        frac = 1.0 if fraction is None else max(0.0, min(1.0, fraction))
    else:
        used = usage_from_ams(ams_start or {}, ams_end or {}, spool_g)     # already measured, never scaled
        if used:
            source, rows, scaled, frac = "ams", used["filaments"], False, 1.0
        elif (isinstance(counter_start, (int, float)) and isinstance(counter_end, (int, float))
              and 0 < counter_end - counter_start < 5000):
            material = base_material((materials or [DEFAULT_MATERIAL])[0])
            metres = float(counter_end - counter_start)
            source, scaled, frac = "counter", False, 1.0
            rows = [{"material": material, "g": metres_to_grams(metres, material), "m": metres}]
    if not rows:
        return None
    by_material: dict[str, dict[str, float]] = {}
    for r in rows:
        slot = by_material.setdefault(r["material"], {"g": 0.0, "m": 0.0})
        slot["g"] += r["g"] * (frac if scaled else 1.0)
        slot["m"] += r["m"] * (frac if scaled else 1.0)
    for slot in by_material.values():
        slot["g"], slot["m"] = round(slot["g"], 2), round(slot["m"], 3)
    return {"source": source, "estimated": True,
            "g": round(sum(v["g"] for v in by_material.values()), 2),
            "m": round(sum(v["m"] for v in by_material.values()), 3), "by_material": by_material}


def with_manual_grams(filament: dict[str, Any] | None, grams: float) -> dict[str, Any]:
    """The Master's own figure replaces the estimate; materials keep their proportions."""
    if not (0 < grams <= 20000):
        raise FilamentError("Poids invalide")
    old = (filament or {}).get("by_material") or {}
    total = sum(v.get("g", 0) for v in old.values())
    if not old or total <= 0:
        old, total = {DEFAULT_MATERIAL: {"g": grams, "m": 0}}, grams
    out: dict[str, dict[str, float]] = {}
    for mat, v in old.items():
        share = v.get("g", 0) / total
        g = round(grams * share, 2)
        out[mat] = {"g": g, "m": round(grams_to_metres(g, mat), 3)}
    return {"source": "manual", "estimated": False, "g": round(grams, 2),
            "m": round(sum(v["m"] for v in out.values()), 3), "by_material": out}


def job_cost(filament: dict[str, Any] | None, settings: dict[str, Any]) -> float | None:
    if not filament:
        return None
    return round(sum(v.get("g", 0) / 1000.0 * price_per_kg(mat, settings)
                     for mat, v in (filament.get("by_material") or {}).items()), 2)


# ── Statistics ─────────────────────────────────────────────────────────────

def summarize(jobs: list[dict[str, Any]], settings: dict[str, Any], *, since: float = 0,
              now: float | None = None) -> dict[str, Any]:
    now = time.time() if now is None else now
    total = {"jobs": 0, "with_data": 0, "g": 0.0, "m": 0.0, "cost": 0.0, "finished": 0, "failed": 0, "stopped": 0,
             "wasted_g": 0.0, "wasted_cost": 0.0, "without_data": 0}
    by_material: dict[str, dict[str, float]] = {}
    by_printer: dict[str, dict[str, Any]] = {}
    by_day: dict[str, dict[str, float]] = {}
    for job in jobs:
        at = job.get("at") or 0
        if at < since:
            continue
        total["jobs"] += 1
        outcome = job.get("outcome")
        if outcome in ("finished", "failed", "stopped"):
            total[outcome] += 1
        fil = job.get("filament")
        if not fil:
            continue
        cost = job_cost(fil, settings) or 0.0
        total["with_data"] += 1
        total["g"] += fil.get("g", 0)
        total["m"] += fil.get("m", 0)
        total["cost"] += cost
        if outcome in ("failed", "stopped"):
            total["wasted_g"] += fil.get("g", 0)
            total["wasted_cost"] += cost
        for mat, v in (fil.get("by_material") or {}).items():
            row = by_material.setdefault(mat, {"g": 0.0, "m": 0.0, "cost": 0.0, "price_kg": price_per_kg(mat, settings)})
            row["g"] += v.get("g", 0)
            row["m"] += v.get("m", 0)
            row["cost"] += v.get("g", 0) / 1000.0 * row["price_kg"]
        name = job.get("printer_name") or job.get("printer") or "?"
        prow = by_printer.setdefault(name, {"jobs": 0, "g": 0.0, "m": 0.0, "cost": 0.0})
        prow["jobs"] += 1
        prow["g"] += fil.get("g", 0)
        prow["m"] += fil.get("m", 0)
        prow["cost"] += cost
        day = datetime.fromtimestamp(at, timezone.utc).strftime("%Y-%m-%d")
        drow = by_day.setdefault(day, {"g": 0.0, "cost": 0.0})
        drow["g"] += fil.get("g", 0)
        drow["cost"] += cost

    total["without_data"] = total["jobs"] - total["with_data"]

    def rounded(d: dict[str, Any]) -> dict[str, Any]:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in d.items()}

    return {"totals": rounded(total),
            "by_material": [{"material": k, **rounded(v)} for k, v in sorted(by_material.items(), key=lambda kv: -kv[1]["g"])],
            "by_printer": [{"printer": k, **rounded(v)} for k, v in sorted(by_printer.items(), key=lambda kv: -kv[1]["g"])],
            "by_day": [{"day": k, **rounded(v)} for k, v in sorted(by_day.items())],
            "currency": settings.get("currency") or "$"}


# ── Spool inventory (optional Inventoria / Finances link) ──────────────────

SPOOLS_FILE = "spools.json"


def _read_spools(state_dir: Path) -> list[dict[str, Any]]:
    import json
    path = state_dir / SPOOLS_FILE
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        rows = data.get("spools") if isinstance(data, dict) else data
        return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []
    except (OSError, ValueError):
        return []


def _write_spools(state_dir: Path, spools: list[dict[str, Any]]) -> None:
    import hq_state
    state_dir.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(state_dir / SPOOLS_FILE, {"spools": spools[:128]})


def list_spools(state_dir: Path) -> list[dict[str, Any]]:
    return _read_spools(state_dir)


def save_spool(state_dir: Path, data: dict[str, Any]) -> dict[str, Any]:
    import secrets
    import hq_state
    with hq_state.path_lock(state_dir / SPOOLS_FILE):
        spools = _read_spools(state_dir)
        sid = str(data.get("id") or "").strip()
        if not sid or not re.fullmatch(r"s-[0-9a-f]{6}", sid):
            sid = "s-" + secrets.token_hex(3)
        mat = base_material(data.get("material") or "PLA") or "PLA"
        col = str(data.get("colour") or "#FFFFFF").strip().upper()
        if not re.fullmatch(r"#[0-9A-F]{6}", col):
            col = "#FFFFFF"
        init_g = max(1.0, min(10000.0, float(data.get("initial_g") or 1000.0)))
        rem_g = max(0.0, min(10000.0, float(data.get("remaining_g") if data.get("remaining_g") is not None else init_g)))
        row = {
            "id": sid,
            "name": str(data.get("name") or f"{mat} {col}")[:80],
            "material": mat,
            "colour": col,
            "initial_g": round(init_g, 1),
            "remaining_g": round(rem_g, 1),
            "price_kg": round(max(0.0, float(data.get("price_kg") or 0.0)), 2) if data.get("price_kg") is not None else None,
            "inventoria_id": str(data.get("inventoria_id") or "")[:64],
            "finance_ref": str(data.get("finance_ref") or "")[:64],
            "updated_at": int(time.time()),
        }
        spools = [s for s in spools if s.get("id") != sid]
        spools.append(row)
        _write_spools(state_dir, spools)
        return row


def delete_spool(state_dir: Path, spool_id: str) -> bool:
    import hq_state
    with hq_state.path_lock(state_dir / SPOOLS_FILE):
        spools = _read_spools(state_dir)
        kept = [s for s in spools if s.get("id") != spool_id]
        if len(kept) == len(spools):
            return False
        _write_spools(state_dir, kept)
        return True


def consume_spool(state_dir: Path, material: str, colour: str, grams: float) -> dict[str, Any] | None:
    import hq_state
    if not grams or grams <= 0:
        return None
    with hq_state.path_lock(state_dir / SPOOLS_FILE):
        spools = _read_spools(state_dir)
        mat = base_material(material)
        col = str(colour or "")[:7].upper()
        pick = next((s for s in spools if s.get("material") == mat and s.get("colour") == col and float(s.get("remaining_g") or 0) > 0), None) \
            or next((s for s in spools if s.get("material") == mat and float(s.get("remaining_g") or 0) > 0), None)
        if pick is None:
            return None
        pick["remaining_g"] = round(max(0.0, float(pick.get("remaining_g") or 0) - float(grams)), 1)
        pick["updated_at"] = int(time.time())
        _write_spools(state_dir, spools)
        return pick
