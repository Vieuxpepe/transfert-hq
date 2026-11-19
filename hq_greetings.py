"""Accueil greeting bank: short French lines written ahead of time by the small LLM on the voice-worker PC.

The line shown over the hour's light ("De retour ?") is a static list in ``assets/hq-home.js``. This module adds a
second pool next to it: while the laptop is idle HQ asks it for a few lines per moment of the day, keeps the ones that
pass a strict filter in one JSON file, and the page mixes them in with the built-in lines. Nothing here ever runs on
page load: the page reads the file; the laptop is only asked in a background thread, a few times a day at most. If the
laptop is off or slow, nothing is generated and the page keeps using its own lines.

Only the local model is used (``ask``), never Gemini: this is decoration and must not spend a quota.
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Callable

import hq_state

BUCKETS = {
    "early": "tôt le matin (entre 5 h et 9 h)",
    "morning": "en matinée (entre 9 h et 12 h)",
    "noon": "à l'heure du midi",
    "afternoon": "dans l'après-midi",
    "evening": "en soirée (entre 18 h et 22 h)",
    "late": "tard le soir (entre 22 h et 2 h)",
    "night": "au cœur de la nuit",
    "return": "quand il revient sur l'écran après l'avoir quitté un moment le même jour",
}
EXAMPLES = {  # a few lines to set the register; the model must not copy them
    "early": ["Bon matin, doucement", "Tôt levé ?"], "morning": ["Bonjour, Marc-Antoine", "On s'y met ?"],
    "noon": ["Bon appétit", "Pause méritée ?"], "afternoon": ["Bon après-midi", "On avance bien"],
    "evening": ["Bonsoir, Marc-Antoine", "Belle soirée"], "late": ["Encore debout ?", "Il se fait tard"],
    "night": ["La nuit est longue", "Le sommeil t'attend"], "return": ["Te revoilà", "De retour ?"],
}
TARGET = 10          # lines kept per moment
ASK = 10             # lines asked for per call (the filter drops some)
MIN_LEN, MAX_LEN = 4, 28   # the longest built-in line is 28 characters: the header never wraps
MAX_WORDS = 5
MIN_GAP = 1800.0     # seconds between two refill attempts
FILE_V = 1
_LINE_RE = re.compile(r"^[A-Za-zÀ-ÖØ-öø-ÿŒœ][A-Za-zÀ-ÖØ-öø-ÿŒœ'’ ,\-?!…]*$")
_BANNED = re.compile(r"\b(ma[iî]tre|master|monsieur|madame|vous|votre|vos)\b", re.I)
_ENGLISH = {"the", "you", "your", "hello", "hi", "hey", "good", "welcome", "back", "morning", "evening", "night", "again",
            "and", "with", "for", "time", "sleep", "coffee"}
_lock = threading.Lock()
_state: dict[str, Any] = {"last_try": 0.0, "running": False}


def clean_line(raw: Any) -> str | None:
    """One acceptable greeting, or None. French only, short, no emoji, markup, digits, full stop or formal address."""
    if not isinstance(raw, str):
        return None
    text = " ".join(raw.replace(" ", " ").split()).strip(" \"«»")
    if not (MIN_LEN <= len(text) <= MAX_LEN) or not _LINE_RE.fullmatch(text) or _BANNED.search(text):
        return None
    words = re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿŒœ'’\-]+", text)
    if not words or len(words) > MAX_WORDS or any(w.lower() in _ENGLISH for w in words):
        return None
    if text.endswith(","):
        return None
    text = re.sub(r"\s*\?", " ?", text)  # French typography, like the built-in lines: a space before the question mark
    return text[0].upper() + text[1:]


def empty() -> dict:
    return {"v": FILE_V, "generated": 0, "lines": {name: [] for name in BUCKETS}}


def normalize(data: Any) -> dict:
    out = empty()
    if not isinstance(data, dict) or not isinstance(data.get("lines"), dict):
        return out
    for name in BUCKETS:
        seen: list[str] = []
        for raw in data["lines"].get(name) if isinstance(data["lines"].get(name), list) else []:
            line = clean_line(raw)
            if line and line.lower() not in (s.lower() for s in seen):
                seen.append(line)
        out["lines"][name] = seen[-TARGET * 2:]
    if isinstance(data.get("generated"), (int, float)) and not isinstance(data.get("generated"), bool):
        out["generated"] = int(data["generated"])
    return out


def load(path: Path) -> dict:
    try:
        return normalize(json.loads(Path(path).read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return empty()


def save(path: Path, data: dict) -> dict:
    bank = normalize(data)
    with hq_state.path_lock(Path(path)):
        hq_state.write_json_atomic(Path(path), bank)
    return bank


def needs_refill(bank: dict) -> list[str]:
    return [name for name in BUCKETS if len(bank["lines"].get(name, [])) < TARGET]


def examples_from_js(js_path: Path) -> dict[str, list[str]]:
    """The built-in lines of ``assets/hq-home.js`` (GREETINGS per moment and RETURNS), as register examples for the model.
    Empty when the file cannot be read or parsed: ``EXAMPLES`` is then used."""
    try:
        src = Path(js_path).read_text(encoding="utf-8")
    except OSError:
        return {}
    person = re.search(r'const PERSON = "([^"]+)"', src)
    person = person.group(1) if person else "Marc-Antoine"

    def split_outside_strings(text: str, sep: str) -> list[str]:
        parts, cur, quoted = [], [], False
        for ch in text:
            if ch == '"':
                quoted = not quoted
            if ch == sep and not quoted:
                parts.append("".join(cur))
                cur = []
            else:
                cur.append(ch)
        parts.append("".join(cur))
        return parts

    def lines(block: str) -> list[str]:
        out = []
        for element in split_outside_strings(block, ","):
            pieces = [x.strip() for x in split_outside_strings(element, "+") if x.strip()]
            text = "".join(person if x == "PERSON" else x.strip('"') for x in pieces)
            line = clean_line(text)
            if line:
                out.append(line)
        return out

    found: dict[str, list[str]] = {}
    table = re.search(r"const GREETINGS = \{(.*?)\n  \};", src, re.S)
    for match in re.finditer(r"(\w+): \[(.*?)\],?\s*(?=\w+: \[|$)", table.group(1) if table else "", re.S):
        found[match.group(1)] = lines(match.group(2))
    ret = re.search(r"const RETURNS = \[(.*?)\];", src, re.S)
    if ret:
        found["return"] = lines(ret.group(1))
    return {k: v for k, v in found.items() if k in BUCKETS and v}


def _messages(name: str, have: list[str], person: str, examples: list[str] | None = None) -> list[dict]:
    system = (
        f"Tu écris des phrases d'accueil très courtes pour l'écran d'accueil d'une console personnelle, adressées à {person}. "
        "Tutoiement toujours. Chaque phrase fait 2 à 5 mots et 26 caractères au plus. Ton simple, calme et naturel, comme "
        "quelqu'un qui te salue, pas de poésie, pas de métaphore, pas de grandes phrases. Peu de questions : "
        "au plus 2 phrases sur 10 se terminent par un point d'interrogation, aucune par un point. Pas d'emoji, pas de "
        "guillemets. Écris uniquement en français et varie les débuts de phrase.")
    shown = (examples or EXAMPLES[name])[:12] + have[-4:]
    user = (f"Moment : {BUCKETS[name]}.\nVoici des phrases du même style (n'en recopie aucune) :\n- " + "\n- ".join(shown) +
            f"\nÉcris {ASK} nouvelles phrases différentes. Réponds par un objet JSON : " + '{"lines": ["…"]}')
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _parse(text: str) -> list[str]:
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return []
    lines = data.get("lines") if isinstance(data, dict) else data
    return [x for x in lines if isinstance(x, str)] if isinstance(lines, list) else []


def refill(path: Path, ask: Callable[..., Any], *, person: str = "Marc-Antoine") -> dict:
    """Top up every moment that is short of lines, one call each. Stops at the first call the laptop cannot answer
    (offline, busy with voice, slow): the next attempt carries on. Lines that fail ``clean_line`` are dropped."""
    bank = load(path)
    added = 0
    shown = examples_from_js(Path(path).parent / "assets" / "hq-home.js")
    for name in needs_refill(bank):
        have = bank["lines"][name]
        try:
            text = ask(_messages(name, have, person, shown.get(name)), 0.8, 320, 25.0, json_mode=True)
        except Exception:  # noqa: BLE001 — decoration must never raise
            text = None
        if not text:
            break
        for raw in _parse(text):
            line = clean_line(raw)
            if line and line.lower() not in (s.lower() for s in have):
                have.append(line)
                added += 1
        bank["lines"][name] = have[-TARGET * 2:]
    if added:
        bank["generated"] = int(time.time())
        bank = save(path, bank)
    return {"added": added, "missing": needs_refill(bank)}


def kick(path: Path, ask: Callable[..., Any], ready: Callable[[], bool]) -> bool:
    """Start a background refill when the bank is short, the laptop is ready and the last attempt is not recent.
    Never blocks the caller; at most one runs at a time. True when a thread was started."""
    now = time.time()
    with _lock:
        if _state["running"] or now - float(_state["last_try"]) < MIN_GAP:
            return False
        try:
            if not ready() or not needs_refill(load(path)):
                return False
        except Exception:  # noqa: BLE001
            return False
        _state.update(running=True, last_try=now)

    def work() -> None:
        try:
            refill(path, ask)
        finally:
            with _lock:
                _state["running"] = False

    threading.Thread(target=work, daemon=True, name="hq-greetings").start()
    return True


def snapshot(path: Path) -> dict:
    bank = load(path)
    return {"v": bank["v"], "generated": bank["generated"], "lines": bank["lines"]}
