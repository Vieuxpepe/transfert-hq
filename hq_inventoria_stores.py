"""Where each item is usually bought ("duct tape: Quincaillerie"), used to group the shopping list by store.

Own small state file; never touches stock. Inventoria sets it with her ``set_store`` tool when the Master says where they buy something.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "stores.json"
MAX_STORES = 400
_lock = threading.RLock()
_ITEM_RE = re.compile(r"^itm-[0-9a-f]{16}$")


class StoreError(ValueError):
    pass


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict[str, str]:
    import json
    try:
        rows = json.loads(_path(root).read_text(encoding="utf-8")).get("stores", {})
    except Exception:
        return {}
    return {k: v for k, v in rows.items() if _ITEM_RE.match(k) and isinstance(v, str) and v}


def clean(name: Any) -> str:
    return " ".join(re.sub(r"[\x00-\x1f\x7f<>]+", " ", str(name or "")).split())[:60]


def all_stores(root: Any) -> dict[str, str]:
    with _lock:
        return _load(root)


def set_store(root: Any, item_id: Any, store: Any) -> str | None:
    """Set (or, with an empty store, clear) the usual store of an item. Returns the stored name or None."""
    if not isinstance(item_id, str) or not _ITEM_RE.match(item_id):
        raise StoreError("article invalide")
    name = clean(store)
    with _lock:
        rows = _load(root)
        if not name:
            rows.pop(item_id, None)
        else:
            if item_id not in rows and len(rows) >= MAX_STORES:
                raise StoreError("trop de magasins enregistrés")
            rows[item_id] = name
        p = _path(root)
        p.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(p, {"version": 1, "stores": rows})
        return name or None
