"""Quantity history and a deliberately modest "runs out in about N days" estimate.

``observe`` records a point whenever an item's quantity differs from the last recorded one (called when the chip refreshes and by the
background watcher). ``estimate`` averages only the *decreases* over the observed span (restocks are ignored) and refuses to guess with
less than five days of history or fewer than two decreases. The result is always an estimate, never a promise.
"""
from __future__ import annotations

import json
import math
import threading
import time
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "history.json"
MAX_POINTS = 60
WINDOW_DAYS = 60
MIN_SPAN_DAYS = 5.0
MIN_DECREASES = 2
_lock = threading.RLock()


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict[str, list]:
    try:
        rows = json.loads(_path(root).read_text(encoding="utf-8")).get("items", {})
    except Exception:
        return {}
    return rows if isinstance(rows, dict) else {}


def observe(root: Any, inv: dict, now: float | None = None) -> bool:
    """Record quantity changes. Returns True when something was written."""
    now = float(now if now is not None else time.time())
    with _lock:
        rows = _load(root)
        changed = False
        live = set()
        for it in inv.get("items", []):
            if not isinstance(it, dict) or not isinstance(it.get("qty"), (int, float)) or isinstance(it.get("qty"), bool):
                continue
            iid = it["id"]
            live.add(iid)
            pts = rows.setdefault(iid, [])
            if not pts or pts[-1][1] != it["qty"]:
                pts.append([now, it["qty"]])
                del pts[:-MAX_POINTS]
                changed = True
        for gone in [k for k in rows if k not in live]:
            del rows[gone]
            changed = True
        if changed:
            p = _path(root)
            p.parent.mkdir(parents=True, exist_ok=True)
            hq_state.write_json_atomic(p, {"version": 1, "items": rows})
        return changed


def estimate_from(points: list, qty: float, now: float) -> dict | None:
    pts = [p for p in points if isinstance(p, list) and len(p) == 2 and now - p[0] <= WINDOW_DAYS * 86400]
    if len(pts) < 3 or qty <= 0:
        return None
    span = (pts[-1][0] - pts[0][0]) / 86400.0
    drops = [pts[i - 1][1] - pts[i][1] for i in range(1, len(pts)) if pts[i][1] < pts[i - 1][1]]
    if span < MIN_SPAN_DAYS or len(drops) < MIN_DECREASES:
        return None
    rate = sum(drops) / span
    if rate <= 0:
        return None
    return {"rate_per_day": round(rate, 3), "days_left": max(0, math.floor(qty / rate)), "estimate": True}


def estimates(root: Any, inv: dict, now: float | None = None) -> dict[str, dict]:
    now = float(now if now is not None else time.time())
    with _lock:
        rows = _load(root)
    out: dict[str, dict] = {}
    for it in inv.get("items", []):
        if isinstance(it, dict) and it.get("id") in rows and isinstance(it.get("qty"), (int, float)):
            e = estimate_from(rows[it["id"]], it["qty"], now)
            if e:
                out[it["id"]] = e
    return out
