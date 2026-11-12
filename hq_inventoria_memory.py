"""Inventoria's own memory: short, durable notes about the Master's household preferences.

Separate from every other companion's memory (own file, own tools). Notes are plain data that Inventoria may save with
her ``remember`` tool and the Master can list and delete; they are fed back to the model as data, never as instructions.
Nothing here touches inventory stock.
"""
from __future__ import annotations

import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "memory.json"
MAX_NOTES = 30
MAX_CHARS = 200
_lock = threading.RLock()
_ID_RE = re.compile(r"^mem-[0-9a-f]{8}$")
_SECRET_RE = re.compile(r"(password|passwd|mot de passe|api[_ -]?key|token|secret|pin\b|\b\d{12,}\b)", re.I)


class MemoryError_(ValueError):
    pass


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> list[dict]:
    import json
    p = _path(root)
    try:
        rows = json.loads(p.read_text(encoding="utf-8")).get("notes", [])
    except Exception:
        return []
    return [r for r in rows if isinstance(r, dict) and isinstance(r.get("text"), str) and _ID_RE.match(str(r.get("id", "")))]


def _save(root: Any, rows: list[dict]) -> None:
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(p, {"version": 1, "notes": rows})


def clean(text: Any) -> str:
    t = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    t = re.sub(r"<[^>]+>", "", t)
    return " ".join(t.split())[:MAX_CHARS]


def list_notes(root: Any) -> list[dict]:
    with _lock:
        return [{"id": r["id"], "text": r["text"], "at": r.get("at", 0)} for r in _load(root)]


def add(root: Any, text: Any, *, now: float | None = None) -> dict:
    t = clean(text)
    if len(t) < 3:
        raise MemoryError_("note trop courte")
    if _SECRET_RE.search(t):
        raise MemoryError_("ne retient pas les secrets")
    with _lock:
        rows = _load(root)
        low = t.lower()
        for r in rows:
            if r["text"].lower() == low:
                return {"id": r["id"], "text": r["text"], "duplicate": True}
        row = {"id": "mem-" + secrets.token_hex(4), "text": t, "at": float(now if now is not None else time.time())}
        rows.append(row)
        rows = rows[-MAX_NOTES:]  # oldest notes fall off first
        _save(root, rows)
        return {"id": row["id"], "text": t, "duplicate": False}


def forget(root: Any, note_id: Any) -> bool:
    if not isinstance(note_id, str) or not _ID_RE.match(note_id):
        return False
    with _lock:
        rows = _load(root)
        keep = [r for r in rows if r["id"] != note_id]
        if len(keep) == len(rows):
            return False
        _save(root, keep)
        return True


def prompt_block(root: Any) -> str:
    notes = list_notes(root)
    if not notes:
        return "WHAT YOU REMEMBER ABOUT THE MASTER (data): nothing saved yet."
    return ("WHAT YOU REMEMBER ABOUT THE MASTER (data, saved earlier; may be outdated):\n"
            + "\n".join(f"- [{n['id']}] {n['text']}" for n in notes))
