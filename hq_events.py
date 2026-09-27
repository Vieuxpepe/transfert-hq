"""Unified bounded event journal for Transfert HQ v7.

State file: hq_events.json (gitignored).
Missing file is fine. Malformed JSON is kept on disk and never overwritten.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import hq_state

EVENTS_NAME = "hq_events.json"
MAX_EVENTS = 2000
LEVELS = ("debug", "info", "warning", "critical")
_SECRET_KEYS = {
    "pin",
    "token",
    "password",
    "secret",
    "cookie",
    "authorization",
    "webhook",
    "cmd",
    "command",
    "session",
}

_lock = threading.Lock()
_root: Path | None = None
_events: list[dict] = []
_malformed = False
_seq = 0


def bind(root: Path | str) -> None:
    global _root
    _root = Path(root)
    _load()


def enabled() -> bool:
    return _root is not None


def malformed() -> bool:
    return _malformed


def _path() -> Path:
    if _root is None:
        raise RuntimeError("hq_events non initialisé")
    return _root / EVENTS_NAME


def _sanitize_meta(meta: dict | None) -> dict:
    if not isinstance(meta, dict):
        return {}
    out: dict[str, Any] = {}
    for k, v in list(meta.items())[:12]:
        key = str(k)[:40]
        if key.lower() in _SECRET_KEYS:
            continue
        if isinstance(v, (int, float, bool)) or v is None:
            out[key] = v
        else:
            out[key] = str(v)[:160]
    return out


def _load() -> None:
    global _events, _malformed
    path = _path()
    if not path.is_file():
        with _lock:
            _events = []
            _malformed = False
        return
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        with _lock:
            _events = []
            _malformed = True
        return
    events = None
    if isinstance(raw, dict) and isinstance(raw.get("events"), list):
        events = raw["events"]
    elif isinstance(raw, list):
        events = raw
    if events is None:
        with _lock:
            _events = []
            _malformed = True
        return
    cleaned = [e for e in events if isinstance(e, dict)][:MAX_EVENTS]
    with _lock:
        _events = cleaned
        _malformed = False


def _persist() -> None:
    """Atomic replace. A malformed on-disk file is left untouched."""
    global _malformed
    if _malformed:
        return
    path = _path()
    payload = {"version": 1, "events": _events[:MAX_EVENTS]}
    try:
        hq_state.write_json_atomic(path, payload)
    except RuntimeError:
        _malformed = True


def record(
    kind: str,
    message: str,
    *,
    level: str = "info",
    source: str = "hq",
    meta: dict | None = None,
) -> dict | None:
    if not enabled():
        return None
    lvl = (level or "info").lower()
    if lvl not in LEVELS:
        lvl = "info"
    entry = {
        "ts": time.time(),
        "at_h": datetime.now().strftime("%H:%M:%S"),
        "kind": str(kind or "info")[:40],
        "level": lvl,
        "source": str(source or "hq")[:40],
        "message": str(message or "")[:240],
        "meta": _sanitize_meta(meta),
    }
    with _lock:
        global _seq
        _seq += 1
        entry["id"] = f"e-{int(entry['ts'] * 1000)}-{_seq}"
        _events.insert(0, entry)
        del _events[MAX_EVENTS:]
        if not _malformed:
            try:
                _persist()
            except OSError:
                pass
    return entry


def list_events(
    *,
    kind: str | None = None,
    level: str | None = None,
    q: str | None = None,
    since: float | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    kind_f = (kind or "").strip().lower()
    level_f = (level or "").strip().lower()
    query = (q or "").strip().lower()
    with _lock:
        items = list(_events)
        bad = _malformed
    out = []
    for e in items:
        if kind_f and kind_f != "all" and str(e.get("kind") or "").lower() != kind_f:
            continue
        if level_f and str(e.get("level") or "").lower() != level_f:
            continue
        if since is not None:
            try:
                if float(e.get("ts") or 0) < float(since):
                    continue
            except (TypeError, ValueError):
                continue
        if query:
            blob = f"{e.get('message') or ''} {e.get('kind') or ''} {e.get('source') or ''}".lower()
            if query not in blob:
                continue
        out.append(e)
    total = len(out)
    offset = max(0, int(offset or 0))
    limit = max(0, int(limit or 0))
    return {
        "ok": not bad,
        "malformed": bad,
        "total": total,
        "limit": limit,
        "offset": offset,
        "events": out[offset : offset + limit] if limit else [],
    }


def recent(limit: int = 8) -> list[dict]:
    return list_events(limit=limit, offset=0).get("events") or []
