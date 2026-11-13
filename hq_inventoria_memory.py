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
        rows = raw.get("notes") if isinstance(raw, dict) else None
        if not isinstance(rows, list):
            raise ValueError("notes invalides")
        # One damaged row makes the whole file unusable: dropping it here would
        # silently delete it on the next save, so preserve the file instead.
        for row in rows:
            if not (isinstance(row, dict) and isinstance(row.get("text"), str)
                    and _ID_RE.match(str(row.get("id", "")))):
                raise ValueError("note invalide")
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


def list_notes(root: Any) -> list[dict]:
    with _lock:
        rows, _ok = _read(root)
        return [{"id": r["id"], "text": r["text"], "at": r.get("at", 0)} for r in rows]


def _stamp(note: dict) -> float:
    """Recency of the fact itself: a correction counts as recent."""
    return max(float(note.get("at") or 0), float(note.get("updated_at") or 0))


def _best_match(rows: list[dict], text: str) -> dict | None:
    """The single note a correction most likely replaces.

    Two shared terms can be coincidental (``master`` + ``range``), so the match
    must also beat every other note outright: on a tie we refuse to correct and
    store the statement as a new note, which is recoverable, unlike rewriting the
    wrong fact.
    """
    want = _terms(text)
    if not want:
        return None
    scores = sorted((len(want & _terms(row["text"])) for row in rows), reverse=True)
    if not scores or scores[0] < 2:
        return None
    if len(scores) > 1 and scores[1] == scores[0]:
        return None
    for row in rows:
        if len(want & _terms(row["text"])) == scores[0]:
            return row
    return None


def add(root: Any, text: Any, *, now: float | None = None) -> dict:
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
        for r in rows:
            if r["text"].lower() == low:
                return {"id": r["id"], "text": r["text"], "duplicate": True}
        if _CORRECTION_RE.search(t):
            corrected = _best_match(rows, t)
            if corrected:
                corrected["text"] = t
                corrected["updated_at"] = stamp
                # Move it to the end so eviction sees the correction as recent.
                rows = [r for r in rows if r["id"] != corrected["id"]] + [corrected]
                _save(root, rows)
                return {"id": corrected["id"], "text": t, "duplicate": False,
                        "superseded": corrected["id"]}
        row = {"id": "mem-" + secrets.token_hex(4), "text": t, "at": stamp}
        rows.append(row)
        evicted = [r["id"] for r in rows[:-MAX_NOTES]]
        rows = rows[-MAX_NOTES:]  # oldest notes fall off first, and are reported
        _save(root, rows)
        return {"id": row["id"], "text": t, "duplicate": False, "evicted": evicted}


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
        return sorted(notes, key=_stamp)[-MAX_PROMPT_NOTES:]
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
