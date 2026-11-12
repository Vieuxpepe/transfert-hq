"""Fingerprints of photos already analysed, to warn before the same picture is processed (and applied) twice.

Only a SHA-256 of the image data is kept (never the image), with the time and the chat session. 60 entries, 30 days.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "photos.json"
MAX_ENTRIES = 60
TTL_SECONDS = 30 * 86400
_lock = threading.RLock()


def fingerprint(image: dict) -> str:
    return hashlib.sha256(str(image.get("data", "")).encode("ascii", "ignore")).hexdigest()[:32]


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict[str, dict]:
    try:
        rows = json.loads(_path(root).read_text(encoding="utf-8")).get("photos", {})
    except Exception:
        return {}
    return rows if isinstance(rows, dict) else {}


def seen(root: Any, fp: str, now: float | None = None) -> dict | None:
    now = float(now if now is not None else time.time())
    with _lock:
        rec = _load(root).get(fp)
    if isinstance(rec, dict) and now - float(rec.get("at", 0)) <= TTL_SECONDS:
        return rec
    return None


def record(root: Any, fp: str, session_id: str, now: float | None = None) -> None:
    now = float(now if now is not None else time.time())
    with _lock:
        rows = {k: v for k, v in _load(root).items() if isinstance(v, dict) and now - float(v.get("at", 0)) <= TTL_SECONDS}
        rows.pop(fp, None)
        rows[fp] = {"at": now, "session": str(session_id)[:40]}
        while len(rows) > MAX_ENTRIES:
            rows.pop(next(iter(rows)))
        p = _path(root)
        p.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(p, {"version": 1, "photos": rows})
