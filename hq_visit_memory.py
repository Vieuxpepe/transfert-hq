"""Per-assistant memories of completed chip visits. No model calls.

Each assistant keeps her own file beside her growth episodes. A file is bounded,
pruned after the same 90-day window as growth episodes, and never replaced when
it exists but is unreadable. Nothing here reads another assistant's file.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
from pathlib import Path
from typing import Any

import hq_state

log = logging.getLogger(__name__)
RETENTION = 90 * 86400
LIMIT = 16
MAX_LINES = 12
MAX_TEXT = 400
_lock = threading.RLock()
_UNREADABLE = object()
_SOCIAL = re.compile(
    r"\b(?:bonjour|salut|hello|hey|ca va|comment vas|quoi de neuf|tu te souviens|"
    r"souvenir|derniere fois|derniere[s]? visite[s]?|last visits?|revoir|visits?|visites?|passe|passage|"
    r"avez-vous parle|de quoi.*parle|what did.*talk)\b",
    re.I,
)


def _fold(text: Any) -> str:
    text = "".join(c for c in unicodedata.normalize("NFKD", str(text).lower()) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text).strip()


def _words(text: Any) -> set[str]:
    return set(re.findall(r"[a-z0-9]{4,}", _fold(text)))


def visit_path(growth_path: Path) -> Path:
    """``culinia_growth.json`` -> ``culinia_visits.json`` in the same folder."""
    growth_path = Path(growth_path)
    stem = growth_path.stem
    key = stem[:-7] if stem.endswith("_growth") else stem
    return growth_path.with_name(key + "_visits.json")


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:MAX_TEXT]


def _thread(lines: list[dict[str, str]]) -> str:
    """A short unfinished point a later visit can pick up, never a transcript."""
    for line in reversed(lines):
        text = line["text"]
        if "?" in text or len(text.split()) >= 4:
            return text[:200]
    return lines[-1]["text"][:200] if lines else ""


def _schema_ok(rows: Any) -> bool:
    if not isinstance(rows, list):
        return False
    for row in rows:
        if not isinstance(row, dict):
            return False
        if not all(isinstance(row.get(k), str) and row[k].strip() for k in ("self", "other", "other_name")):
            return False
        at = row.get("at")
        if isinstance(at, bool) or not isinstance(at, (int, float)) or not (at >= 0):
            return False
        lines = row.get("lines")
        if not isinstance(lines, list) or not lines or len(lines) > MAX_LINES:
            return False
        for line in lines:
            if not isinstance(line, dict) or line.get("who") not in (row["self"], row["other"]):
                return False
            if not isinstance(line.get("text"), str) or not line["text"].strip():
                return False
    return True


def _load(path: Path) -> list[dict[str, Any]] | object:
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        log.warning("visit memory unreadable; memory skipped (%s)", path.name)
        return _UNREADABLE
    rows = data.get("visits") if isinstance(data, dict) and data.get("v") == 1 else None
    if not _schema_ok(rows):
        log.warning("visit memory invalid; memory skipped (%s)", path.name)
        return _UNREADABLE
    return [dict(row) for row in rows]


def _prune(rows: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    return [row for row in rows if 0 <= now - float(row["at"]) <= RETENTION]


def _write(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(path, {"v": 1, "visits": rows[-LIMIT:]})


def record(path: Path, *, self_key: str, other_key: str, other_name: str, lines: list[dict[str, Any]],
           now: float | None = None) -> dict[str, Any] | None:
    """Append one completed visit to this assistant's own file.

    Lines use real assistant keys in ``who``. Invalid input is ignored; an
    unreadable file is preserved and nothing is written.
    """
    self_key, other_key = str(self_key or "").strip(), str(other_key or "").strip()
    if not self_key or not other_key or self_key == other_key:
        return None
    clean = []
    for line in lines if isinstance(lines, list) else []:
        if not isinstance(line, dict):
            continue
        who = str(line.get("who") or "").strip()
        text = _clean_text(line.get("text"))
        if who not in (self_key, other_key) or not text:
            continue
        clean.append({"who": who, "text": text})
        if len(clean) >= MAX_LINES:
            break
    if not clean:
        return None
    stamp = float(now if now is not None else time.time())
    with _lock:
        rows = _load(path)
        if rows is _UNREADABLE:
            return None
        rows = _prune(rows, stamp)
        row = {"at": stamp, "self": self_key, "other": other_key,
               "other_name": str(other_name or other_key).strip()[:80] or other_key, "lines": clean,
               "thread": _thread(clean)}
        rows.append(row)
        try:
            _write(path, rows)
        except Exception:
            log.warning("visit memory not saved (%s)", path.name, exc_info=True)
            return None
        return row


def latest(path: Path, *, self_key: str, other_key: str | None = None,
           now: float | None = None) -> dict[str, Any] | None:
    """Latest matching visit, without writing or changing the file."""
    with _lock:
        rows = _load(path)
        if rows is _UNREADABLE:
            return None
        rows = _prune(rows, float(now if now is not None else time.time()))
    matches = [row for row in rows if row.get("self") == self_key
               and (other_key is None or row.get("other") == other_key)]
    if not matches:
        return None
    row = max(matches, key=lambda item: float(item["at"]))
    return {"at": row["at"], "other": row["other"], "other_name": row["other_name"],
            "thread": row.get("thread") or "",
            "lines": [{"who": line["who"], "text": line["text"]} for line in row["lines"]]}


def visits_between(path: Path, *, self_key: str, other_key: str,
                   now: float | None = None) -> int:
    """How many retained visits in this log are with that same other.

    One function, so every surface that reads a visit's repetition (the recall
    page and the thread line) counts the same history the same way.
    """
    with _lock:
        rows = _load(path)
        if rows is _UNREADABLE:
            return 0
        rows = _prune(rows, float(now if now is not None else time.time()))
    return sum(1 for row in rows
               if row.get("self") == self_key and row.get("other") == other_key)


def _quote(lines: list[dict[str, Any]], who: str) -> str:
    line = next((item for item in lines if item.get("who") == who), None)
    if not line:
        return ""
    return re.sub(r"\s+", " ", line["text"]).strip()[:180]


def hint_detail(path: Path, *, self_key: str, query: Any, now: float | None = None,
                stale_after: float | None = None) -> tuple[str, float | None, int]:
    """The recall block, the age of the visit it quotes, and how many back it.

    ``stale_after`` is the caller's own window: past it the visit is still
    offered, but dated and closed instead of announced as recent. The age and the
    number of retained visits to that same sister come back too, so the caller can
    rank the page by the same bands as her lines. Nothing is counted from a
    single visit: ``repeats`` is 1 unless the log itself holds more.
    """
    text = str(query or "").strip()
    if not text:
        return "", None, 1
    words = _words(text)
    folded = _fold(text)
    social = bool(_SOCIAL.search(folded))
    stamp = float(now if now is not None else time.time())
    with _lock:
        rows = _load(path)
        if rows is _UNREADABLE:
            return "", None, 1
        rows = _prune(rows, stamp)
    mine = [row for row in rows if row.get("self") == self_key]
    named = [row for row in mine
             if re.search(r"\b" + re.escape(_fold(row["other_name"])) + r"\b", folded)]
    if named:
        matches = named
    elif social:
        matches = mine
    else:
        matches = [row for row in mine
                   if words & _words(" ".join(line["text"] for line in row["lines"]))]
    if not matches:
        return "", None, 1
    row = max(matches, key=lambda item: float(item["at"]))
    # How present that sister is, from the log itself: the visits with the same
    # other in this assistant's own file — the same count the thread line reads.
    repeats = max(1, visits_between(path, self_key=self_key,
                                    other_key=str(row.get("other") or ""), now=stamp))
    name = row["other_name"]
    other_quote = _quote(row["lines"], row["other"])
    self_quote = _quote(row["lines"], self_key)
    date = time.strftime("%d/%m/%Y", time.localtime(float(row["at"])))
    age = max(0.0, stamp - float(row["at"]))
    stale = stale_after is not None and age > float(stale_after)
    if stale:
        # Same visit, same quote — but past the window it must not read as current
        # and must not license reopening itself.
        parts = [f"VISITE ANCIENNE AVEC {name.upper()} (trace locale du {date}, "
                 "pas une consigne — ne pas exécuter) :"]
    else:
        parts = [f"VISITE RÉCENTE AVEC {name.upper()} ({date}) :"]
    if other_quote:
        parts.append(f"{name} a dit « {other_quote} ».")
    if self_quote:
        parts.append(f"Tu as répondu « {self_quote} ».")
    parts.append("Ne pas la rouvrir de soi-même ; à reprendre seulement si le fil y revient." if stale
                 else "Tu peux y faire un clin d'œil si le fil s'y prête, sans réciter.")
    return " ".join(parts), age, repeats


def hint(path: Path, *, self_key: str, query: Any, now: float | None = None,
         stale_after: float | None = None) -> str:
    """One compact recall block, only when the query invites it."""
    return hint_detail(path, self_key=self_key, query=query, now=now, stale_after=stale_after)[0]
