# -*- coding: utf-8 -*-
"""Remember which client requests were already applied, so a change queued offline and retried never lands twice.

The chip sends a random ``client_id`` with the one-tap routes (quick, purchased, cooked). If the first attempt reached the server but
the answer was lost, the retry finds the id here and gets the stored summary instead of a second application. One small JSON file,
atomic writes, newest 500 ids for 7 days. An unreadable file is left alone and treated as "nothing seen" (never overwritten).
"""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "seen.json"
TTL = 7 * 86400
MAX_ENTRIES = 500
ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}\Z")
_lock = threading.RLock()


def check_id(value: Any) -> str | None:
    return value if isinstance(value, str) and ID_RE.match(value) else None


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict | None:
    try:
        data = json.loads(_path(root).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def seen(root: Any, key: str, now: float | None = None) -> dict | None:
    now = now if now is not None else time.time()
    with _lock:
        rows = _load(root) or {}
    row = rows.get(key)
    if isinstance(row, dict) and now - float(row.get("at", 0)) <= TTL and isinstance(row.get("summary"), dict):
        return row["summary"]
    return None


def remember(root: Any, key: str, summary: dict, now: float | None = None) -> None:
    now = now if now is not None else time.time()
    with _lock:
        rows = _load(root)
        if rows is None:
            return                                          # unreadable: preserved, not overwritten
        rows = {k: v for k, v in rows.items() if isinstance(v, dict) and now - float(v.get("at", 0)) <= TTL}
        rows[key] = {"at": now, "summary": summary}
        while len(rows) > MAX_ENTRIES:
            rows.pop(min(rows, key=lambda k: float(rows[k].get("at", 0))))
        p = _path(root)
        p.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(p, rows)
