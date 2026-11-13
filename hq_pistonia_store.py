"""Pistonia's own state, all under ``<root>/.hq-engine/pistonia/``: the conversation, her memory notes, her settings and her alerts.

Everything is small JSON, written atomically, bounded, and never holds a secret (memory refuses secret-looking notes, messages
are clipped). Her memory is separate from every other companion's. Memory notes and alert texts reach the model only as
*data*, never as instructions.
"""
from __future__ import annotations

import json
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Optional

import hq_state

THREAD_MAX = 60               # messages kept
MSG_CHARS = 2000
PROPOSALS_PER_MSG = 4
NOTES_MAX = 30
NOTE_CHARS = 200
ALERTS_MAX = 30
SETTINGS_DEFAULT = {"notify": False, "voice": True}
_lock = threading.RLock()
_root: Optional[Path] = None
_ID_NOTE = re.compile(r"^mem-[0-9a-f]{8}$")
_ID_MSG = re.compile(r"^msg-[0-9a-f]{10}$")
_SECRET = re.compile(r"(password|passwd|mot de passe|api[_ -]?key|token|secret|pin\b|\b\d{12,}\b)", re.I)


class StoreError(ValueError):
    pass


def bind(root: Any) -> None:
    global _root
    _root = Path(root)


def _dir() -> Path:
    if _root is None:
        raise StoreError("Pistonia n'est pas initialisée")
    return _root / ".hq-engine" / "pistonia"


def _read(name: str, default: Any) -> Any:
    try:
        data = json.loads((_dir() / name).read_text(encoding="utf-8"))
    except Exception:
        return default
    return data if isinstance(data, type(default)) else default


def _write(name: str, data: Any) -> None:
    d = _dir()
    d.mkdir(parents=True, exist_ok=True)
    try:
        # hq_state refuses to replace a file that is present but unreadable.
        hq_state.write_json_atomic(d / name, data)
    except RuntimeError as exc:
        raise StoreError(str(exc)) from exc


def unreadable(name: str) -> bool:
    """True when the file exists but cannot be parsed (it is never replaced)."""
    p = _dir() / name
    if not p.is_file():
        return False
    try:
        json.loads(p.read_text(encoding="utf-8"))
        return False
    except Exception:
        return True


def clean_text(text: Any, limit: int) -> str:
    t = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+", " ", str(text or ""))
    return t.strip()[:limit]


# ---- conversation --------------------------------------------------------------------------------------------------------

def thread() -> list[dict]:
    with _lock:
        rows = _read("thread.json", {}).get("messages", []) if isinstance(_read("thread.json", {}), dict) else []
    out = []
    for m in rows if isinstance(rows, list) else []:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("text"), str) and _ID_MSG.match(str(m.get("id", ""))):
            out.append(m)
    return out[-THREAD_MAX:]


def add_message(role: str, text: str, *, kind: str = "chat", proposals: Optional[list] = None, remembered: Optional[list] = None,
                now: Optional[float] = None) -> dict:
    if role not in ("user", "assistant"):
        raise StoreError("role invalide")
    row: dict[str, Any] = {"id": "msg-" + secrets.token_hex(5), "role": role, "text": clean_text(text, MSG_CHARS),
                           "at": float(now if now is not None else time.time()), "kind": kind if kind in ("chat", "alert", "clear", "greeting") else "chat"}
    if proposals:
        row["proposals"] = [p for p in proposals if isinstance(p, dict)][:PROPOSALS_PER_MSG]
    if remembered:
        row["remembered"] = [r for r in remembered if isinstance(r, dict)][:4]
    with _lock:
        rows = thread()
        rows.append(row)
        _write("thread.json", {"version": 1, "messages": rows[-THREAD_MAX:]})
    return row


def resolve_proposals(message_id: str) -> bool:
    """The user applied or dismissed a card: forget its proposals so a reload does not offer them again."""
    if not _ID_MSG.match(str(message_id or "")):
        return False
    with _lock:
        rows = thread()
        hit = False
        for m in rows:
            if m["id"] == message_id and m.get("proposals"):
                m.pop("proposals", None)
                hit = True
        if hit:
            _write("thread.json", {"version": 1, "messages": rows})
        return hit


def last_message_id() -> Optional[str]:
    rows = thread()
    return rows[-1]["id"] if rows else None


def clear_thread() -> None:
    with _lock:
        _write("thread.json", {"version": 1, "messages": []})


def history_for_model(limit: int = 12) -> list[dict]:
    """The last chat turns (alerts count too: she knows what she told the Master), as [{role, text}]."""
    return [{"role": m["role"], "text": m["text"]} for m in thread() if m.get("text")][-limit:]


# ---- memory --------------------------------------------------------------------------------------------------------------

def notes() -> list[dict]:
    with _lock:
        data = _read("memory.json", {})
    rows = data.get("notes", []) if isinstance(data, dict) else []
    return [{"id": r["id"], "text": r["text"], "at": r.get("at", 0)} for r in rows
            if isinstance(r, dict) and isinstance(r.get("text"), str) and _ID_NOTE.match(str(r.get("id", "")))]


def remember(text: Any, *, now: Optional[float] = None) -> dict:
    import hq_inventoria_memory as _m
    t = _m.clean(text)[:NOTE_CHARS]
    if len(t) < 3:
        raise StoreError("note trop courte")
    if _SECRET.search(t):
        raise StoreError("ne retient pas les secrets")
    with _lock:
        rows = notes()
        for r in rows:
            if r["text"].lower() == t.lower():
                return {"id": r["id"], "text": r["text"], "duplicate": True}
        row = {"id": "mem-" + secrets.token_hex(4), "text": t, "at": float(now if now is not None else time.time())}
        rows.append(row)
        evicted = [r["id"] for r in rows[:-NOTES_MAX]]  # reported, not silently dropped
        _write("memory.json", {"version": 1, "notes": rows[-NOTES_MAX:]})
    return {"id": row["id"], "text": t, "duplicate": False, "evicted": evicted}


def forget(note_id: Any) -> bool:
    if not _ID_NOTE.match(str(note_id or "")):
        return False
    with _lock:
        rows = notes()
        keep = [r for r in rows if r["id"] != note_id]
        if len(keep) == len(rows):
            return False
        _write("memory.json", {"version": 1, "notes": keep})
        return True


# ---- settings ------------------------------------------------------------------------------------------------------------

def settings() -> dict:
    with _lock:
        data = _read("settings.json", {})
    out = dict(SETTINGS_DEFAULT)
    for k in SETTINGS_DEFAULT:
        if isinstance(data, dict) and isinstance(data.get(k), bool):
            out[k] = data[k]
    return out


def save_settings(**kw: Any) -> dict:
    with _lock:
        cur = settings()
        for k, v in kw.items():
            if k in SETTINGS_DEFAULT and isinstance(v, bool):
                cur[k] = v
        _write("settings.json", cur)
    return cur


# ---- alerts (what she raised; the detector lives in hq_pistonia_alerts) -------------------------------------------------

def alerts_state() -> dict:
    with _lock:
        data = _read("alerts.json", {})
    if not isinstance(data, dict):
        data = {}
    rows = [a for a in data.get("alerts", []) if isinstance(a, dict) and isinstance(a.get("key"), str)]
    return {"alerts": rows[-ALERTS_MAX:], "cooldown": {k: v for k, v in (data.get("cooldown") or {}).items()
                                                      if isinstance(k, str) and isinstance(v, (int, float))},
            "active": [k for k in (data.get("active") or []) if isinstance(k, str)]}


def save_alerts_state(state: dict) -> None:
    with _lock:
        _write("alerts.json", {"version": 1, "alerts": state.get("alerts", [])[-ALERTS_MAX:],
                               "cooldown": state.get("cooldown", {}), "active": state.get("active", [])})


def unseen_count() -> int:
    return sum(1 for a in alerts_state()["alerts"] if not a.get("seen") and a.get("kind") == "alert")


def mark_seen() -> int:
    with _lock:
        st = alerts_state()
        n = 0
        for a in st["alerts"]:
            if not a.get("seen"):
                a["seen"] = True
                n += 1
        if n:
            save_alerts_state(st)
        return n
