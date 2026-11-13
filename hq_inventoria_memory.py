"""Inventoria's own memory: short, durable notes about the Master's household preferences.

Separate from every other companion's memory (own file, own tools). Notes are
plain data that Inventoria may save with her ``remember`` tool and the Master can
list and delete; they are fed back to the model as data, never as instructions.
Nothing here touches inventory stock.

Only the notes most relevant to the current message are sent (six at most), so a
full notepad no longer inflates every prompt. An explicit correction replaces the
note it corrects, and a full notepad reports which note fell off. A damaged file
is never overwritten: it stays untouched and is reported unavailable.
"""
from __future__ import annotations

import json
import math
import re
import secrets
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "memory.json"
MAX_NOTES = 30
MAX_CHARS = 200
MAX_PROMPT_NOTES = 6
UNREADABLE = ("MÉMOIRE INDISPONIBLE (fichier illisible ; il est conservé tel quel, "
              "rien n'a été remplacé).")
_lock = threading.RLock()
_ID_RE = re.compile(r"^mem-[0-9a-f]{8}$")
_SECRET_RE = re.compile(r"(password|passwd|mot de passe|api[_ -]?key|token|secret|pin\b|\b\d{12,}\b)", re.I)
# ``non`` is matched as a word (the previous ``non,`` could never match: a word
# boundary after a comma has no word character on either side).
_CORRECTION_RE = re.compile(r"\b(?:actually|instead|correction|en fait|plutot|plutôt|non)\b", re.I)
_STOP = {"the", "and", "for", "with", "that", "this", "from", "les", "des", "une", "dans", "pour",
         "avec", "sur", "aux", "est", "pas", "plus", "toujours", "chevron"}


class MemoryError_(ValueError):
    pass


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _terms(text: Any) -> set[str]:
    lowered = "".join(c for c in unicodedata.normalize("NFKD", str(text or "").lower())
                      if not unicodedata.combining(c))
    return {w for w in re.findall(r"[a-z0-9]{4,}", lowered) if w not in _STOP}


def _read(root: Any) -> tuple[list[dict], bool]:
    """(valid notes, readable). A present-but-unparseable file is never replaced."""
    p = _path(root)
    if not p.is_file():
        return [], True
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and raw.get("version") not in (None, 1):
            raise ValueError("version de mémoire inconnue")
        rows = raw.get("notes") if isinstance(raw, dict) else None
        if not isinstance(rows, list):
            raise ValueError("notes invalides")
        # One damaged row makes the whole file unusable: dropping it here would
        # silently delete it on the next save, so preserve the file instead.
        seen: set[str] = set()
        for row in rows:
            if not (isinstance(row, dict) and isinstance(row.get("text"), str)
                    and _ID_RE.match(str(row.get("id", "")))):
                raise ValueError("note invalide")
            # Duplicate ids would make the correction reordering delete both rows.
            if row["id"] in seen:
                raise ValueError("note dupliquée")
            seen.add(row["id"])
            for field in ("at", "updated_at"):
                if row.get(field) is None:
                    continue
                value = row[field]
                # A numeric string or a bool is not a timestamp this schema wrote.
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError("horodatage invalide")
                if not math.isfinite(float(value)) or float(value) < 0:
                    raise ValueError("horodatage invalide")
    except Exception:
        return [], False
    return list(rows), True


def _load(root: Any) -> list[dict]:
    return _read(root)[0]


def _save(root: Any, rows: list[dict]) -> None:
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    try:
        # hq_state refuses to replace a file that exists but cannot be parsed.
        hq_state.write_json_atomic(p, {"version": 1, "notes": rows})
    except RuntimeError as exc:
        raise MemoryError_(str(exc)) from exc


def clean(text: Any) -> str:
    t = re.sub(r"[\x00-\x1f\x7f]+", " ", str(text or ""))
    t = re.sub(r"<[^>]+>", "", t)
    return " ".join(t.split())[:MAX_CHARS]


def find(root: Any, note_id: Any) -> dict | None:
    """One saved note by id (for an explicit correction preview)."""
    if not isinstance(note_id, str) or not _ID_RE.match(note_id):
        return None
    return next((r for r in _load(root) if r["id"] == note_id), None)


def list_notes(root: Any) -> list[dict]:
    with _lock:
        rows, _ok = _read(root)
        return [{"id": r["id"], "text": r["text"], "at": r.get("at", 0)} for r in rows]


def _stamp(note: dict) -> float:
    """Recency of the fact itself: a correction counts as recent."""
    return max(float(note.get("at") or 0), float(note.get("updated_at") or 0))


def _candidates(rows: list[dict], text: str, limit: int = 3) -> list[str]:
    """Notes that might be the one a correction refers to (ids only, never
    rewritten automatically)."""
    want = _terms(text)
    scored = sorted(((len(want & _terms(r["text"])), _stamp(r), r["id"]) for r in rows),
                    key=lambda item: (-item[0], -item[1]))
    return [rid for score, _stamp_, rid in scored if score][:limit]


def add(root: Any, text: Any, *, now: float | None = None,
        corrects_id: str | None = None, expect: str | None = None) -> dict:
    """Save a note. Only an explicit ``corrects_id`` may replace an existing note.

    Shared vocabulary cannot tell "same fact, new value" from an unrelated fact
    that happens to share a verb and a noun (``master`` + ``range``), so an
    unresolved correction writes nothing at all: it reports ``needs_target`` with
    candidate ids. Writing it first would let a full notepad evict the very fact
    it was meant to correct and would leave two active contradictory notes.

    ``expect`` is mandatory with ``corrects_id``: it must repeat the target note's
    exact saved text. This is a compare-and-swap guard against a stale or wrong
    id, not proof of user intent — the caller must have asked the Master which
    note is wrong.
    """
    t = clean(text)
    if len(t) < 3:
        raise MemoryError_("note trop courte")
    if _SECRET_RE.search(t):
        raise MemoryError_("ne retient pas les secrets")
    stamp = float(now if now is not None else time.time())
    with _lock:
        rows, readable = _read(root)
        if not readable:
            raise MemoryError_("mémoire illisible : fichier conservé, non modifié")
        low = t.lower()
        target = None
        if corrects_id is not None:
            if not isinstance(corrects_id, str) or not _ID_RE.match(corrects_id):
                raise MemoryError_("identifiant de note invalide")
            if not isinstance(expect, str) or not expect.strip():
                raise MemoryError_("texte de la note cible requis (expect)")
            target = next((r for r in rows if r["id"] == corrects_id), None)
            if target is None:
                raise MemoryError_("note à corriger introuvable")
            if expect is not None and str(expect).strip() != target["text"].strip():
                raise MemoryError_("note cible inattendue : relis la note avant de la corriger")
        else:
            # An identical text is the same fact and must not be stored twice.
            for r in rows:
                if r["text"].lower() == low:
                    return {"saved": True, "id": r["id"], "text": r["text"], "duplicate": True}
            if _CORRECTION_RE.search(t):
                # Nothing is written, even with zero keyword candidates: a
                # correction with no match must not evict an unrelated old fact.
                return {"saved": False, "needs_target": True, "pending": t,
                        "candidates": _candidates(rows, t), "duplicate": False}
        if target is not None:
            rows = [r for r in rows if r["id"] != target["id"] and r["text"].lower() != low]
            target["text"] = t
            target["updated_at"] = stamp
            target["at"] = float(target.get("at") or stamp)
            rows.append(target)          # the correction counts as the most recent
            _save(root, rows)
            return {"saved": True, "id": target["id"], "text": t, "duplicate": False,
                    "superseded": target["id"], "corrected": True}
        row = {"id": "mem-" + secrets.token_hex(4), "text": t, "at": stamp}
        rows.append(row)
        evicted = [r["id"] for r in rows[:-MAX_NOTES]]
        rows = rows[-MAX_NOTES:]  # oldest notes fall off first, and are reported
        _save(root, rows)
        return {"saved": True, "id": row["id"], "text": t, "duplicate": False, "evicted": evicted}


def forget(root: Any, note_id: Any) -> bool:
    if not isinstance(note_id, str) or not _ID_RE.match(note_id):
        return False
    with _lock:
        rows, readable = _read(root)
        if not readable:
            raise MemoryError_("mémoire illisible : fichier conservé, non modifié")
        keep = [r for r in rows if r["id"] != note_id]
        if len(keep) == len(rows):
            return False
        _save(root, keep)
        return True


def _select(notes: list[dict], query: Any) -> list[dict]:
    """Relevant notes first, then the newest ones: never more than MAX_PROMPT_NOTES."""
    if not query:
        return sorted(notes, key=_stamp, reverse=True)[:MAX_PROMPT_NOTES]
    want = _terms(query)
    scored = sorted(((len(want & _terms(n["text"])), n) for n in notes),
                    key=lambda item: (-item[0], -_stamp(item[1])))
    chosen = [n for score, n in scored if score][:MAX_PROMPT_NOTES]
    seen = {n["id"] for n in chosen}
    for note in sorted(notes, key=_stamp, reverse=True):   # recent, never a bare subset
        if len(chosen) >= MAX_PROMPT_NOTES:
            break
        if note["id"] not in seen:
            chosen.append(note)
            seen.add(note["id"])
    return chosen


def prompt_block(root: Any, query: Any = "") -> str:
    notes, readable = _read(root)
    if not readable:
        return UNREADABLE
    if not notes:
        return "WHAT YOU REMEMBER ABOUT THE MASTER (data): nothing saved yet."
    fresh = [{"id": r["id"], "text": r["text"], "at": r.get("at", 0),
              "updated_at": r.get("updated_at", 0)} for r in notes]
    chosen = _select(fresh, query)
    return ("WHAT YOU REMEMBER ABOUT THE MASTER (data, saved earlier; may be outdated). "
            f"{len(chosen)} of {len(fresh)} notes, most relevant to this message:\n"
            + "\n".join(f"- [{n['id']}] {n['text']}" for n in chosen))
