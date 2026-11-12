"""Per-item stock watches: "warn me when the screws get down to 30".

A watch is a lightweight alert threshold kept in Inventoria's own state file. It never changes stock or the item's
minimum. The Master can list and remove watches in the chip; Inventoria can set them with her ``watch`` tool.
"""
from __future__ import annotations

import re
import threading
import time
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "watches.json"
MAX_WATCHES = 60
_lock = threading.RLock()
_ITEM_RE = re.compile(r"^itm-[0-9a-f]{16}$")


class WatchError(ValueError):
    pass


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict[str, dict]:
    import json
    try:
        rows = json.loads(_path(root).read_text(encoding="utf-8")).get("watches", {})
    except Exception:
        return {}
    return {k: v for k, v in rows.items()
            if _ITEM_RE.match(k) and isinstance(v, dict) and isinstance(v.get("warn_at"), int)}


def _save(root: Any, rows: dict[str, dict]) -> None:
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(p, {"version": 1, "watches": rows})


def thresholds(root: Any) -> dict[str, int]:
    with _lock:
        return {k: v["warn_at"] for k, v in _load(root).items()}


def set_watch(root: Any, item_id: Any, warn_at: Any, *, name: str = "", now: float | None = None) -> dict:
    if not isinstance(item_id, str) or not _ITEM_RE.match(item_id):
        raise WatchError("item invalide")
    if isinstance(warn_at, bool) or not isinstance(warn_at, (int, float)) or int(warn_at) != warn_at or not (0 <= warn_at <= 1_000_000):
        raise WatchError("seuil invalide (entier >= 0)")
    with _lock:
        rows = _load(root)
        if item_id not in rows and len(rows) >= MAX_WATCHES:
            raise WatchError("trop de surveillances")
        rows[item_id] = {"warn_at": int(warn_at), "name": str(name)[:80], "at": float(now if now is not None else time.time())}
        _save(root, rows)
        return {"item_id": item_id, "warn_at": int(warn_at)}


def remove_watch(root: Any, item_id: Any) -> bool:
    if not isinstance(item_id, str):
        return False
    with _lock:
        rows = _load(root)
        if item_id not in rows:
            return False
        del rows[item_id]
        _save(root, rows)
        return True


def list_watches(root: Any, items: list[dict] | None = None) -> list[dict]:
    """Watches joined with live items (a watch whose item vanished is hidden)."""
    with _lock:
        rows = _load(root)
    by_id = {i["id"]: i for i in (items or []) if isinstance(i, dict) and "id" in i}
    out = []
    for iid, w in rows.items():
        it = by_id.get(iid)
        if items is not None and it is None:
            continue
        out.append({"item_id": iid, "name": (it or {}).get("name") or w.get("name", ""), "warn_at": w["warn_at"],
                    "qty": (it or {}).get("qty")})
    return sorted(out, key=lambda r: r["name"].lower())
