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
# The file is shared by every partner of one assistant: a cap on the whole file
# alone let one chatty pair push all the others out inside the hour.
PER_OTHER = 8
LIMIT = 48
CLOCK_SLACK = 86400  # a clock stepped back must not erase what was just written
MAX_LINES = 12
MAX_TEXT = 400
_lock = threading.RLock()
_UNREADABLE = object()
_SOCIAL = re.compile(
    r"\b(?:bonjour|salut|hello|hey|hi there|ca va|comment vas|how are you|how's it going|what's up|"
    r"quoi de neuf|tu te souviens|do you remember|remember|souvenir|memory of|derniere fois|last time|"
    r"derniere[s]? visite[s]?|last visits?|revoir|visits?|visites?|passe|passage|stopped by|dropped by|"
    r"avez-vous parle|de quoi.*parle|what did.*talk|what were you (?:two )?(?:talking|chatting))\b",
    re.I,
)
_CLOSING = re.compile(
    r"\b(?:je te laisse|je vous laisse|je retourne|je repars|je file|je m'efface|"
    r"je m'en vais|je dois y aller|je vais y aller|a bientot|à bientôt|au revoir|"
    r"bonne suite|bonne journee|bonne journée|a plus|à plus|bye|goodbye|"
    r"i'll leave you|i will leave you|i'm going back|i am going back|back to (?:the|my) \w+|"
    r"i'm off|i am off|i'm leaving|i have to go|i need to go|see you|take care|"
    r"i'll let you|catch you later|talk later|fading out)\b",
    re.I,
)
_GREETING = re.compile(r"^\s*(?:bonjour|bonsoir|salut|coucou|hello|hey|hi|good (?:morning|evening|afternoon))\b", re.I)


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
    """A short unfinished point a later visit can pick up, never a transcript.

    A closing line ("Je retourne à l'atelier.") is not a thread: feeding it back
    made every later visit answer a goodbye. Greetings are skipped for the same
    reason, and when nothing remains the visit simply has no thread.

    The last line of a visit is its departure (the generation prompt asks for it,
    in words no phrase list can anticipate), so it is only a thread when it is
    itself a question left open.
    """
    body = list(lines)
    if len(body) >= 2 and "?" not in str(body[-1].get("text") or ""):
        body = body[:-1]
    for line in reversed(body):
        text = re.sub(r"\s+", " ", str(line.get("text") or "")).strip()
        if not text or _CLOSING.search(text):
            continue
        if _GREETING.match(text) and len(text.split()) < 6:
            continue
        if "?" in text or len(text.split()) >= 4:
            return text[:200]
    return ""


def thread_of(lines: list[dict[str, str]]) -> str:
    """The thread a visit leaves, for callers outside this module."""
    return _thread(lines)


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
        if row.get("source", "") not in ("", "gemini", "nvidia", "canned"):
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
    return [row for row in rows if -CLOCK_SLACK <= now - float(row["at"]) <= RETENTION]


def _trim(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The newest PER_OTHER visits with each partner, newest LIMIT overall."""
    seen: dict[str, int] = {}
    keep: list[dict[str, Any]] = []
    for row in reversed(rows):
        other = str(row.get("other") or "")
        seen[other] = seen.get(other, 0) + 1
        if seen[other] <= PER_OTHER:
            keep.append(row)
    keep.reverse()
    return keep[-LIMIT:]


def _write(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(path, {"v": 1, "visits": _trim(rows)})


def record(path: Path, *, self_key: str, other_key: str, other_name: str, lines: list[dict[str, Any]],
           now: float | None = None, source: str = "", visit_id: str = "",
           answer: dict[str, str] | None = None) -> dict[str, Any] | None:
    """Append one completed visit to this assistant's own file.

    Lines use real assistant keys in ``who``. Invalid input is ignored; an
    unreadable file is preserved and nothing is written. A ``visit_id`` already in
    the file is the same visit posted again (a retry whose answer was lost): it is
    returned with ``duplicate`` set and nothing is written.
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
        if visit_id:
            known = next((r for r in rows if r.get("vid") == visit_id), None)
            if known is not None:
                return {**known, "duplicate": True}
        thread = _thread(clean)
        previous = max((r for r in rows if r.get("self") == self_key and r.get("other") == other_key),
                       key=lambda r: float(r["at"]), default=None)
        # How many visits in a row this thread has come back: it deepens while the
        # new exchange still touches the last open point, and starts over otherwise.
        depth = 0
        if previous and previous.get("thread") and (
                _words(previous["thread"]) & _words(" ".join(line["text"] for line in clean))):
            depth = min(9, int(previous.get("depth") or 0) + 1)
        row = {"at": stamp, "self": self_key, "other": other_key,
               "other_name": str(other_name or other_key).strip()[:80] or other_key, "lines": clean,
               "thread": thread, "depth": depth,
               "source": source if source in ("gemini", "nvidia", "canned") else ""}
        if visit_id:
            row["vid"] = visit_id
        if isinstance(answer, dict) and answer.get("q") and answer.get("a"):
            row["answer"] = {"q": _clean_text(answer["q"])[:120], "a": _clean_text(answer["a"])[:60]}
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
            "thread": row.get("thread") or "", "source": row.get("source") or "",
            "depth": int(row.get("depth") or 0),
            "answer": row.get("answer") if isinstance(row.get("answer"), dict) else None,
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
    # A scripted fallback line is not a shared memory: it is kept in the log for
    # the daily record, but never offered as a recall.
    mine = [row for row in rows if row.get("self") == self_key and row.get("source") != "canned"]
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
    answer = row.get("answer") if isinstance(row.get("answer"), dict) else None
    date = time.strftime("%d/%m/%Y", time.localtime(float(row["at"])))
    age = max(0.0, stamp - float(row["at"]))
    stale = stale_after is not None and age > float(stale_after)
    # His own message coming back to this visit is what makes an old one current:
    # the reopen is then his, not something she does on her own.
    touched = bool(words & _words(" ".join(str(line.get("text") or "") for line in row["lines"])))
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
    if answer and answer.get("q") and answer.get("a"):
        # What he actually said to her question: true whoever wrote the lines.
        parts.append(f"Elle lui avait demandé « {_clean_text(answer['q'])[:120]} » ; "
                     f"il avait répondu « {_clean_text(answer['a'])[:60]} ».")
    if stale:
        parts.append("Il y revient maintenant : tu peux la reprendre, sans réciter." if touched
                     else "Ne pas la rouvrir de soi-même ; à reprendre seulement si le fil y revient.")
    else:
        parts.append("Tu peux y faire un clin d'œil si le fil s'y prête, sans réciter.")
    return " ".join(parts), age, repeats


def hint(path: Path, *, self_key: str, query: Any, now: float | None = None,
         stale_after: float | None = None) -> str:
    """One compact recall block, only when the query invites it."""
    return hint_detail(path, self_key=self_key, query=query, now=now, stale_after=stale_after)[0]
