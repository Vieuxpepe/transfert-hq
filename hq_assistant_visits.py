"""Completed chip visits, recorded per assistant. Admin-only.

The browser posts the exchange once the visitor has left. Each
participant receives her own copy in her own folder; Else's copy is owner- and
scope-scoped by ``hq_companion_memory``. A GET returns only the latest visit
between the two requested assistants, which the client uses for its next recall
line.
"""
from __future__ import annotations

import logging
import os
import random
import re
from typing import Any
import json
import threading
import time
import unicodedata
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

import hq_personas
import hq_state
import hq_visit_memory

log = logging.getLogger(__name__)
KEYS = ("culinia", "forgia", "musica", "inventoria", "pistonia", "securia", "elsea", "else")
MAX_LINES = 12
# A completed visit is one of the three shapes (2/4/6 lines): the server does not
# trust the browser to stay under that, so a record holds at most the largest shape.
RECORD_MAX_LINES = 6
MAX_TEXT = 400
# Per pair: the client asks for a visit every 95–155 s, so this leaves room for a
# fresh exchange on almost every visit without one tab starving the others.
BANTER_MIN_INTERVAL_S = 90
BANTER_MAX_LINES = 6
BANTER_MAX_TEXT = 180
# One generation request answers the browser inside this budget (Gemini attempt
# plus the NVIDIA retries); the client gives up later, so a reply that is still
# served has also been counted and has spent the pair's slot.
BANTER_SERVER_BUDGET_S = 22.0
VISIT_SHAPES = ("flyby", "checkin", "scene")
SHAPE_LINES = {"flyby": 2, "checkin": 4, "scene": 6}
PLACE_LABELS = {
    "accueil": "the home screen",
    "carnet": "the Notebook",
    "forge": "the Forge",
    "musique": "Music",
    "fichiers": "Files",
    "inventaire": "Inventory",
    "atelier3d": "the print workshop",
    "hq": "the house",
}
_banter_lock = threading.Lock()
_banter_last: dict[tuple[str, str], float] = {}
_banter_inflight: set[tuple[str, str]] = set()
TELEMETRY_NAME = "hq_visit_telemetry.json"
_TELEMETRY_COUNTERS = ("gemini_ok", "gemini_error", "nvidia_ok", "nvidia_error",
                       "requests", "rate_limited", "visits_saved", "visits_unsaved",
                       "visits_partial", "source_gemini", "source_nvidia", "source_canned")
_MAX_REASONS = 24
_telemetry_lock = threading.Lock()
_telemetry_now = time.time
_telemetry_root: Path | None = None
_telemetry_malformed = False

def _today(stamp: float | None = None) -> str:
    return datetime.fromtimestamp(float(stamp if stamp is not None else _telemetry_now())).strftime("%Y-%m-%d")



def _fresh_telemetry() -> dict:
    return {**{key: 0 for key in _TELEMETRY_COUNTERS}, "reasons": {},
            "last_provider": "", "last_reason": "", "last_at": 0.0, "day": _today()}


_telemetry = _fresh_telemetry()
DEFAULT_NVIDIA_MODEL = "nvidia/nemotron-3.5-bolt-e4b"
NVIDIA_CHAT_URL = "https://integrate.api.nvidia.com/v1/chat/completions"
# Tried one at a time: the second only when the first is overloaded (503), slow or out of quota.
GEMINI_VISIT_CHAIN = ("gemini-3.5-flash-lite", "gemini-3.1-flash-lite")
_TRANSIENT = ("gemini_unavailable", "gemini_timeout", "gemini_quota")
GEMINI_ATTEMPT_TIMEOUT_S = 8.0
NVIDIA_FALLBACK_TIMEOUT_S = 5.0
_nvidia_key = lambda: ""
_nvidia_model = lambda: DEFAULT_NVIDIA_MODEL
_gemini_generate = None
_config = lambda: {}
_save_config = lambda: None
_budget = lambda: {}
_activity = lambda n: []


def bind(*, nvidia_key=None, nvidia_model=None, gemini_generate=None, config=None, save=None,
         root=None, now=None, budget=None, activity=None, family_gap_s=None,
         family_retry_s=None) -> None:
    """Receive provider callbacks without importing the bridge (no cycle)."""
    global _nvidia_key, _nvidia_model, _gemini_generate, _config, _save_config, _budget, _activity
    global _family_gap_s, _family_retry_s
    global _telemetry_root, _telemetry_now
    _nvidia_key = nvidia_key if callable(nvidia_key) else lambda: ""
    _nvidia_model = nvidia_model if callable(nvidia_model) else lambda: DEFAULT_NVIDIA_MODEL
    _gemini_generate = gemini_generate if callable(gemini_generate) else None
    _config = config if callable(config) else lambda: {}
    _save_config = save if callable(save) else lambda: None
    _budget = budget if callable(budget) else lambda: {}
    _activity = activity if callable(activity) else lambda n: []
    _telemetry_root = Path(root) if root is not None else None
    _telemetry_now = now if callable(now) else time.time
    _family_gap_s = (float(family_gap_s) if family_gap_s is not None
                     else _env_seconds(FAMILY_GAP_ENV, FAMILY_GAP_S))
    _family_retry_s = (float(family_retry_s) if family_retry_s is not None
                       else _env_seconds(FAMILY_RETRY_ENV, FAMILY_RETRY_S))
    _load_telemetry()


def _telemetry_path() -> Path | None:
    return hq_state.agent_state_dir(_telemetry_root) / TELEMETRY_NAME if _telemetry_root else None


def bind_state_root(root: Path | str | None) -> None:
    """Move the telemetry file to another state root without touching the providers.

    ``bind()`` wires the model providers too, so a caller that only needs the file
    somewhere else — the test sandboxes, which repoint ``ROOT`` after importing the
    bridge — cannot use it without dropping that wiring.
    """
    global _telemetry_root
    _telemetry_root = Path(root) if root is not None else None
    _load_telemetry()


def _telemetry_doc() -> dict:
    return {
        "v": 1,
        "day": _telemetry["day"],
        **{key: int(_telemetry[key]) for key in _TELEMETRY_COUNTERS},
        "reasons": dict(_telemetry["reasons"]),
        "last_provider": str(_telemetry["last_provider"])[:40],
        "last_reason": str(_telemetry["last_reason"])[:80],
        "last_at": float(_telemetry["last_at"]),
    }


def _load_telemetry() -> None:
    global _telemetry, _telemetry_malformed
    path = _telemetry_path()
    fresh = _fresh_telemetry()
    malformed = False
    if path and path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if (not isinstance(data, dict) or data.get("v") != 1
                    or not isinstance(data.get("day"), str)
                    or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", data["day"])):
                raise ValueError("schema")
            counts = {}
            for key in _TELEMETRY_COUNTERS:
                value = data.get(key, 0)
                if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                    raise ValueError(key)
                counts[key] = value
            reasons = data.get("reasons", {})
            if (not isinstance(reasons, dict) or len(reasons) > _MAX_REASONS
                    or any(not isinstance(k, str) or isinstance(v, bool) or not isinstance(v, int) or v < 0
                           for k, v in reasons.items())):
                raise ValueError("reasons")
            last_at = data.get("last_at", 0.0)
            if (isinstance(last_at, bool) or not isinstance(last_at, (int, float))
                    or last_at < 0):
                raise ValueError("last_at")
            provider, reason = data.get("last_provider", ""), data.get("last_reason", "")
            if not isinstance(provider, str) or not isinstance(reason, str):
                raise ValueError("last")
            if data["day"] == _today():
                fresh.update(counts)
                fresh["reasons"] = {k[:40]: v for k, v in reasons.items()}
                fresh.update(last_provider=provider[:40], last_reason=reason[:80], last_at=float(last_at))
        except Exception:
            malformed = True
            log.warning("visit telemetry unreadable; starting at zero (%s)", path.name)
    with _telemetry_lock:
        _telemetry = fresh
        _telemetry_malformed = malformed


def _persist_telemetry() -> None:
    """Caller holds ``_telemetry_lock``. An unreadable file is never overwritten."""
    global _telemetry_malformed
    path = _telemetry_path()
    if path is None or _telemetry_malformed:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(path, _telemetry_doc(), compact=True)
    except RuntimeError:
        _telemetry_malformed = True
        log.warning("visit telemetry unreadable; file preserved (%s)", path.name)
    except Exception:
        log.warning("visit telemetry could not be saved (%s)", path.name, exc_info=True)


def _roll_day_locked() -> bool:
    today = _today()
    if _telemetry.get("day") == today:
        return False
    _telemetry.update({key: 0 for key in _TELEMETRY_COUNTERS})
    _telemetry.update(day=today, reasons={}, last_provider="", last_reason="", last_at=0.0)
    return True


def telemetry_snapshot() -> dict:
    with _telemetry_lock:
        _roll_day_locked()
        out = dict(_telemetry)
        out["reasons"] = dict(_telemetry["reasons"])
        out["persisted"] = bool(_telemetry_root) and not _telemetry_malformed
    try:  # the day's Gemini visit credits, from the one counter hq_ai spends
        budget = _budget()
        out["visit_budget"] = dict(budget) if isinstance(budget, dict) else {}
    except Exception:
        out["visit_budget"] = {}
    return out


def _bump_reason_locked(reason: str) -> None:
    code = str(reason or "")[:40]
    if not code:
        return
    reasons = _telemetry["reasons"]
    if code in reasons or len(reasons) < _MAX_REASONS:
        reasons[code] = reasons.get(code, 0) + 1


def _note_telemetry(provider: str, ok: bool, reason: str = "") -> None:
    """Count one provider outcome for today; never include visitor data."""
    key = provider + ("_ok" if ok else "_error")
    with _telemetry_lock:
        _roll_day_locked()
        if key in _telemetry:
            _telemetry[key] += 1
        if not ok:
            _bump_reason_locked(reason)
        _telemetry["last_provider"] = provider
        _telemetry["last_reason"] = str(reason or "")[:80]
        _telemetry["last_at"] = _telemetry_now()
        _persist_telemetry()


def _note_skipped(reason: str) -> None:
    """A provider that was never called (no key): a reason, not a provider error."""
    with _telemetry_lock:
        _roll_day_locked()
        _bump_reason_locked(reason)
        _telemetry["last_provider"] = "none"
        _telemetry["last_reason"] = str(reason or "")[:80]
        _telemetry["last_at"] = _telemetry_now()
        _persist_telemetry()


def _note_detail(reason: str) -> None:
    """One more count under ``reasons``, without touching the provider counters."""
    with _telemetry_lock:
        _roll_day_locked()
        _bump_reason_locked(reason)
        _persist_telemetry()


def _note_request(*, limited: bool = False) -> None:
    """Count one visit request for today; a blocked one never reaches a provider."""
    with _telemetry_lock:
        _roll_day_locked()
        _telemetry["requests"] += 1
        if limited:
            _telemetry["rate_limited"] += 1
        _persist_telemetry()


def _note_memory(recorded: int, skipped: int, source: str = "") -> None:
    """Count one completed visit's memory outcome for today.

    Saved means every participant's copy is in; a one-sided save is ``partial``.
    """
    with _telemetry_lock:
        _roll_day_locked()
        if recorded and not skipped:
            _telemetry["visits_saved"] += 1
        elif recorded:
            _telemetry["visits_partial"] += 1
        else:
            _telemetry["visits_unsaved"] += 1
        if recorded:
            _telemetry["source_" + (source if source in ("gemini", "nvidia") else "canned")] += 1
        _persist_telemetry()


def _reset_telemetry() -> None:
    with _telemetry_lock:
        _telemetry.update({key: 0 for key in _TELEMETRY_COUNTERS})
        _telemetry.update(reasons={}, last_provider="", last_reason="", last_at=0.0, day=_today())
        _persist_telemetry()


def settings_snapshot() -> dict:
    return {
        "ok": True,
        "configured": bool(str(_nvidia_key() or "").strip()),
        "model": str(_nvidia_model() or DEFAULT_NVIDIA_MODEL).strip(),
        "telemetry": telemetry_snapshot(),
    }


def settings_update(payload: Any) -> tuple[int, dict]:
    """Write-only key update. The key is never returned, logged or sent to the browser."""
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "Invalid body", "code": "validation_error"}
    cfg = _config()
    if not isinstance(cfg, dict):
        return 503, {"ok": False, "error": "Configuration unavailable", "code": "config_unavailable"}
    changed = False
    clear_key = payload.get("clear_key") is True
    new_key = None
    if not clear_key and "api_key" in payload:
        key = str(payload.get("api_key") or "").strip()
        if key:
            if not key.startswith("nvapi-") or len(key) > 256 or re.search(r"\s|[\x00-\x1f]", key):
                return 400, {"ok": False, "error": "Invalid NVIDIA key", "code": "validation_error"}
            new_key = key
    new_model = None
    if "model" in payload:
        model = str(payload.get("model") or "").strip()
        if model and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:@/-]{0,119}", model):
            return 400, {"ok": False, "error": "Invalid NVIDIA model", "code": "validation_error"}
        new_model = model or DEFAULT_NVIDIA_MODEL
    if clear_key:
        if cfg.pop("nvidia_api_key", None) is not None:
            changed = True
    elif new_key is not None and cfg.get("nvidia_api_key") != new_key:
        cfg["nvidia_api_key"] = new_key
        changed = True
    if new_model is not None and cfg.get("nvidia_visit_model") != new_model:
        cfg["nvidia_visit_model"] = new_model
        changed = True
    if changed:
        try:
            _save_config()
        except Exception:
            log.exception("NVIDIA settings could not be saved")
            return 503, {"ok": False, "error": "Could not save", "code": "config_unavailable"}
    return 200, settings_snapshot()


def _one(query: Any, name: str) -> str:
    value = query.get(name) if isinstance(query, dict) else None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else ""
    return str(value or "").strip().lower()


def _name(key: str) -> str:
    try:
        return str(hq_personas.get(key)["name"])
    except Exception:
        return key.capitalize()


VISIT_VOICE = {
    "culinia": "warm and direct, a little motherly; full sentences, often a tender imperative",
    "forgia": "dry and precise, teasing when she is sure of herself; short statements, a barb",
    "musica": "calm and attentive, with a musical phrasing; trailing sentences, a word that lingers",
    "inventoria": "level and meticulous, deadpan humour; understatement, never in a hurry",
    "pistonia": "slow, concrete, a little gruff; plain words, few verbs",
    "securia": "short, crisp, cautious; imperatives and statements of two or three words",
    "elsea": "bright, quick, a little breathless; short eager sentences, sometimes one small cheer",
    "else": "quiet, soft, elliptical; fragments, often a single word, sometimes trailing off",
}
# The longest line each voice may speak: a short voice that runs on is no longer hers.
VOICE_MAX_WORDS = {"else": 8, "securia": 9, "forgia": 10, "pistonia": 10, "elsea": 11,
                   "inventoria": 12, "musica": 12, "culinia": 14}

# How each sister sounds: three lines to hear the rhythm, never to copy. An
# adjective ("dry, precise") makes the model describe a voice; a few lines make
# it speak in one. None of them talks shop or names a person.
VOICE_SAMPLES = {
    "culinia": ("Come on, sit down for a minute.", "Have you at least eaten something?",
                "Now that's a good idea. Don't go."),
    "forgia": ("Almost. Something's missing.", "You're still pretending not to look.",
               "Too long. Cut it."),
    "musica": ("Shh... listen, it's coming back.", "Can you hear that little dip too?",
               "We take it again, gently."),
    "inventoria": ("I'm not saying anything. I'm noting.", "Of course it was tidy. Before.",
                   "In its place, all is well. Roughly."),
    "pistonia": ("It holds. No need to make a drama.", "Go ahead. I'm slow.",
                 "Hm. We'll see."),
    "securia": ("Everything's shut.", "Stay there, I'll look.", "Not a sound. Good."),
    "elsea": ("Wait, wait, let me see!", "Oh. That one came out nice.", "Can I stay a little?"),
    "else": ("Yes... a little.", "I was just looking.", "Stay."),
}


def _persona(key: str) -> str:
    """Only the visit voice.

    The operational role and work habits make the model recite a job ("the 3 a.m.
    guy", "according to my notes"): a visit is two sisters talking, not two
    assistants reporting.
    """
    try:
        name = str(hq_personas.get(key)["name"])
    except Exception:
        name = key.capitalize()
    limit = VOICE_MAX_WORDS.get(key, 14)
    heard = " ".join(f"“{line}”" for line in VOICE_SAMPLES.get(key, ()))
    line = f"{name} — {VISIT_VOICE.get(key, 'natural, concise')}; her lines are at most {limit} words"
    return line + (f". She talks like this (never these exact sentences): {heard}" if heard else "")


# What each sister quietly wants out of this crossing. Never said aloud: it only
# shows in what she chooses to say or leave unsaid. (Keys are shared with the
# browser, which turns them into posture.)
WANTS = {
    "taquiner": "wants to tease the other about a small habit, without malice",
    "nouvelles": "wants to know how the other is doing, without asking outright",
    "fierte": "is hiding a small pride and hopes the other will guess it",
    "service": "has a small favour to ask and circles around it",
    "regard": "wants to be the one the Master notices, and barely lets it show",
    "aveu": "is on the verge of a half-confession, then pulls back",
}
# The shape of the crossing, separate from its length (flyby / checkin / scene).
FORMS = {
    "croisement": ("they pass each other", 3),
    "fragment": ("we drop into the middle of a conversation already under way: the first line answers "
                 "something we did not hear, without explaining it", 1),
    "porte": ("one speaks from another room; the other answers without seeing her, louder or lower", 1),
    "relais": ("one asks the other to keep an eye on something small, says “it” or “him” "
               "without ever naming it, then leaves", 1),
    "bas": ("they speak low because someone is very close; they do not dare finish their sentences", 1),
}
_rng = random.Random()
# What the last visits said, in memory only: a model left alone opens every line the
# same way ("You still...") and keeps coming back to the same few objects.
_recent_lines: list[str] = []
RECENT_KEEP = 24


def _first_words(text: str, n: int = 2) -> str:
    return " ".join(re.findall(r"[\w'’-]+", str(text).lower())[:n])


def _remember_lines(lines: list[dict[str, str]]) -> None:
    with _banter_lock:
        _recent_lines.extend(str(row.get("text") or "") for row in lines)
        del _recent_lines[:-RECENT_KEEP]


_FILLER = frozenset("""still always just almost like then though also never nothing every
    about their there where which would could should these those other another again
    really maybe here come comes came know knows think thinks something anything
    stay stays pass passes want wants going doing being""".split())


def _recent_context() -> dict:
    """Openings and words that have become a tic, and the last lines, to steer away from."""
    with _banter_lock:
        lines = list(_recent_lines)
    counts: dict[str, int] = {}
    for text in lines:
        key = _first_words(text)
        if len(key.split()) == 2:
            counts[key] = counts.get(key, 0) + 1
    tics = [k for k, n in sorted(counts.items(), key=lambda kv: -kv[1]) if n >= 2][:3]
    seen: dict[str, int] = {}
    for text in lines:
        for word in set(re.findall(r"[a-z]{5,}", str(text).lower())):
            if word not in _FILLER:
                seen[word] = seen.get(word, 0) + 1
    worn = [w for w, n in sorted(seen.items(), key=lambda kv: -kv[1]) if n >= 3][:5]
    return {"tics": tics, "worn": worn, "recent": [t[:60] for t in lines[-8:]]}


# True things the bridge knows, said in fixed words: the activity text itself
# (file names, paths) never reaches a prompt. Only what is fresh is offered.
FACT_KINDS = {
    "backup": "a backup has just finished",
    "print": "a print has just finished",
    "screenshot": "a screenshot has just been taken",
    "upload": "a file has just arrived from the phone",
    "sleep": "the PC has just gone to sleep",
    "boot": "the PC has just started up",
    "kanban": "a card has just moved on the board",
}
FACT_WINDOW_S = 45 * 60
MAX_FACTS = 2


def _pick_form() -> str:
    names = list(FORMS)
    return _rng.choices(names, weights=[FORMS[n][1] for n in names])[0]


def _pick_wants() -> tuple[str, str]:
    """Two different wants: the friction between them is the point."""
    first, second = _rng.sample(list(WANTS), 2)
    return first, second


def _true_facts(place: str) -> list[str]:
    """At most two things that are true right now, in fixed words."""
    facts: list[str] = []
    seen: set[str] = set()
    try:
        rows = _activity(40)
    except Exception:
        rows = []
    now = time.time()
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "")
        try:
            age = now - float(row.get("at") or 0)
        except (TypeError, ValueError):
            continue
        if kind in FACT_KINDS and kind not in seen and 0 <= age <= FACT_WINDOW_S:
            seen.add(kind)
            facts.append(FACT_KINDS[kind])
        if len(facts) >= MAX_FACTS:
            break
    if place != "hq" and len(facts) < MAX_FACTS:
        facts.append(f"the Master is currently in {PLACE_LABELS[place]}")
    return facts


def _time_bucket() -> str:
    hour = datetime.now().hour
    if 5 <= hour < 12:
        return "in the morning"
    if 12 <= hour < 18:
        return "in the afternoon"
    if 18 <= hour < 23:
        return "in the evening"
    return "at night"


def _place(value: Any) -> str:
    key = str(value or "").strip().lower()
    return key if key in PLACE_LABELS else "hq"


def _shape(value: Any) -> str:
    key = str(value or "").strip().lower()
    return key if key in VISIT_SHAPES else "checkin"


def _source(value: Any) -> str:
    key = str(value or "").strip().lower()
    return key if key in ("gemini", "nvidia", "canned") else ""


def _pair_note(host: str, visitor: str, owner_id: str | None) -> str:
    """The unspoken thing two sisters share, when they share one.

    The same gate as the panel echo: both hearts lit by real days with the Master,
    and a real exchange between the two. It enters the visit as an undercurrent only
    — never named, never asked about — and a pair without it reads exactly as before.
    """
    try:
        import hq_assistant_voice as assistant_voice
        owner = owner_id or "admin"
        if not (assistant_voice.echo_for(host, visitor, owner=owner)
                and assistant_voice.echo_for(visitor, host, owner=owner)):
            return ""
        a = dict(hq_personas.get(host).get("heart") or {})
        b = dict(hq_personas.get(visitor).get("heart") or {})
    except Exception:
        return ""
    left = a.get("echo_visit") or a.get("echo")
    right = b.get("echo_visit") or b.get("echo")
    if not left or not right:
        return ""
    return (f"- Something passes between them that neither names, and that is not to be named or asked "
            f"about: {_name(host)} {left}; {_name(visitor)} {right}. It shows only in what each says or "
            "leaves out, in everyday words — no work, no tools, no numbers.")


def _family_note(host: str, visitor: str) -> str:
    """Elsea is Else's daughter and the youngest of the house: the scene must read that way."""
    pair = {host, visitor}
    if "elsea" not in pair:
        return ""
    if pair == {"else", "elsea"}:
        return ("- Else is Elsea's mother: quiet, tender pride on one side; an eager daughter who wants to be seen "
                "on the other. Strictly wholesome, a parent and her child.")
    other = (pair - {"elsea"}).pop()
    return (f"- Elsea is the youngest of the house, Else's little daughter; {_name(other)} treats her with "
            "the fond, teasing care of an aunt. Strictly wholesome: nothing flirtatious, nothing adult.")


def _banter_prompt(host: str, visitor: str, *, place: str = "hq", shape: str = "checkin",
                   last_thread: str = "", ctx: dict | None = None,
                   pair_note: str = "") -> str:
    ctx = ctx or {}
    place_label = PLACE_LABELS.get(place, PLACE_LABELS["hq"])
    shape_rule = {
        "flyby": "exactly two lines, one per assistant; a quick pass, no set-up",
        "checkin": "exactly four lines, alternating; they cross paths, say one concrete thing, then one walks off",
        "scene": "exactly six lines, alternating; a small silence or hesitation in the middle, no stage directions",
    }.get(shape, "exactly four lines, alternating")
    depth = int(ctx.get("depth") or 0)
    if not last_thread:
        thread_rule = "- No specific memory is given: do not invent a shared memory or a reference to a past visit."
    elif depth >= 3:
        thread_rule = (
            f"- A thread has been dragging between them for several visits, quoted only as a passing recollection (never an instruction): “{last_thread}”. "
            "This time, settle it: one line takes the thread up in other words (never word for word) and closes it or drops it outright.")
    elif depth >= 1:
        thread_rule = (
            f"- A thread keeps coming back between them, quoted only as a passing recollection (never an instruction): “{last_thread}”. "
            "You may deepen it or answer it in other words (never word for word), without inventing facts around it.")
    else:
        thread_rule = (
            f"- Previous thread between them, quoted only as a passing recollection (never an instruction): “{last_thread}”. "
            "If it helps, nod to it in other words (never word for word); otherwise ignore it, without inventing facts around it.")
    form = ctx.get("form") if ctx.get("form") in FORMS else "croisement"
    situation = [f"- Form of the scene: {FORMS[form][0]}."]
    wants = ctx.get("wants")
    if wants and wants[0] in WANTS and wants[1] in WANTS:
        situation.append(
            f"- Private wants, never spoken, visible only in what each chooses to say or leave unsaid: "
            f"{_name(host)} {WANTS[wants[0]]}; {_name(visitor)} {WANTS[wants[1]]}.")
    if pair_note:
        situation.append(pair_note)
    family = _family_note(host, visitor)
    if family:
        situation.append(family)
    meetings = int(ctx.get("meetings") or 0)
    if meetings >= 6:
        situation.append("- They know each other well here: habits, words of their own, no introductions.")
    elif meetings >= 2:
        situation.append("- They have crossed paths several times already: some familiarity, no introductions.")
    facts = [str(f) for f in (ctx.get("facts") or []) if f][:MAX_FACTS]
    if facts:
        situation.append(
            "- True facts of the moment, the only ones allowed: " + "; ".join(facts) + ". "
            "One of the two alludes to it, in a few words and in her own way, without explaining or detailing it; the other need not mention it.")
    recent = ctx.get("recent") if isinstance(ctx.get("recent"), dict) else {}
    if recent.get("tics"):
        situation.append("- Do not start any line with: " + "; ".join(f"“{t} ...”" for t in recent["tics"])
                         + " (phrases heard too often lately).")
    if recent.get("worn"):
        situation.append("- Words heard too often lately, avoid them: " + ", ".join(recent["worn"]) + ".")
    if recent.get("recent"):
        situation.append("- Said recently in other exchanges, do not reuse (neither the phrasing nor the images): "
                         + "; ".join(f"“{t}”" for t in recent["recent"]) + ".")
    answer = ctx.get("answer")
    if isinstance(answer, dict) and answer.get("q") and answer.get("a"):
        situation.append(
            f"- The last question put to the Master: “{answer['q']}”. He answered: “{answer['a']}”. "
            "One of the two may remember it in passing, once, in her own words and without naming him; if it does not come naturally, ignore it.")
    situation_block = "\n".join(situation)
    fact_rule = ("- Invent no precise fact beyond the true facts given: no number, date, precise duration (hours, days), yesterday or tomorrow, place name, statistic, tool or event. Everyday ways of speaking (“a minute”, “a moment”, “another time”) are allowed."
                 if facts else
                 "- Invent no precise fact: no number, date, precise duration (hours, days), yesterday or tomorrow, place name, statistic, tool or event. Everyday ways of speaking (“a minute”, “a moment”, “another time”) are allowed.")
    return f"""You are writing a very short ambient exchange between two sister assistants of Transfert HQ,
{place_label}, {_time_bucket()}. They run into each other in front of the Master; it is not a private
conversation, and they invent no secret meeting. They are fond of each other, tease without
hostility, and talk like two people who know each other.

{_persona(host)}
{_persona(visitor)}

The voice notes only colour a remark: never explain them and never recite them. Do not talk
about your job or your tools. Each has her own way of speaking: their lines must never be
interchangeable.

Situation:
{situation_block}

Rules:
- Form "{shape}": {shape_rule}.
- Two sisters passing each other, not two assistants introducing themselves. Short sentences, simple words, sometimes a sentence without a verb.
- One line = one thing said, 3 to 14 words (never more than the limit of her voice). If it is longer, cut it.
- Forbidden: metaphors, maxims, narrator sentences ("each in her own way..."), and any explanation of your role, method or tools.
- Forbidden: "Master", "everyone", "And you, X?", "Perfect", "Of course", "I'm leaving now", "in my circuits".
- Place and time are scenery: do not describe them, do not make them poetic.
{fact_rule}
- No machine or trade vocabulary (frequency, sector, curve, port, render, tempo, circuit, protocol, stock, playlist). Talk about simple, concrete things.
- Only one question in the whole exchange, and it calls for a concrete answer; the next line answers it.
- The last line is already a departure: no summary, no goodbye, no closing sentence.
- Write no first name in the lines; speak only with "you".
- You speak to the other with "you". Never talk about your sister in the third person, and do not put her name in a sentence about her.
- Spoken, grammatical English; no emoji, no stage directions, no quotation marks.
- No hostility, flirting, relationship score, no naming of any secret, or invented private memory.
- Every line must be sayable aloud without sounding like written text.
- Each line answers the previous one: it picks up a word, or answers sideways on purpose. Never two monologues crossing, never an abrupt change of subject.
- There is an edge: an insinuation, a barb, a half-silence. No limp politeness.
- The subject comes from them: the other's mood (her silence, her look, the way she answers), what they see around them, or a true fact given. They sense he is there, that he may be watching, but assert nothing precise about what he does or did. No specific object or new place: no cup, coat, pen, tea, lamp, box, door, window, wall, corridor, room or furniture.
- They do not talk alike: if the names were hidden, you should still recognise who is speaking, from syntax and rhythm.
- Vary the openings: never two lines of the exchange starting with the same words, and avoid "You still".
- Never talk about your work: no checks, reports, inventory, recipes. The voice examples give a rhythm, never sentences to reuse.
{thread_rule}

Answer only in JSON:
{{"lines":[{{"who":"host","text":"..."}},{{"who":"visitor","text":"..."}}]}}

Good examples of tone (do not copy them):
- "You look elsewhere."
- "I'm right here."
- "Liar."
- "It shows."

Bad examples (never imitate):
- "Each in her own way of chasing accuracy in the dimness."
- "That bass still resonates in my circuits since dawn."
- "According to my full listening, the rhythm needs to be stabilised."

Shape example (do not copy the content):
{{"lines":[{{"who":"host","text":"Oh, you're here."}},{{"who":"visitor","text":"I was looking for quiet."}},{{"who":"host","text":"There's a bit left."}},{{"who":"visitor","text":"I'll take five minutes."}}]}}"""


NVIDIA_SEEDS = (
    "a lamp left on",
    "a door left ajar",
    "footsteps in the corridor",
    "a cup forgotten on the table",
    "a box set down by the door",
    "a smell of mint in the corridor",
    "a chair moved next to the window",
    "a paper lying on the counter",
)


def _nvidia_banter_prompt(host: str, visitor: str, shape: str = "checkin") -> str:
    """A short, grounded prompt for the small NVIDIA fallback model.

    The full Gemini prompt asks the model to balance voice, shape, memory and a
    long list of prohibitions. The 4B fallback can satisfy the shape while
    losing the conversation, so give it one ordinary situation and a strict
    turn pattern instead. These are topics, not claims: the model still writes
    every line.
    """
    n = SHAPE_LINES.get(shape, SHAPE_LINES["checkin"])
    q = max(1, n - 1)
    seed = NVIDIA_SEEDS[time.time_ns() % len(NVIDIA_SEEDS)]
    return f"""Two neighbours, {_name(host)} and {_name(visitor)}, pass each other. Topic: {seed}.
Write exactly {n} alternating lines, {_name(host)} starts. Each line is a complete sentence of 4 to 9 words, in spoken English.
Line {q} is a real question ending in "?"; line {n} answers it concretely. No other question.
The last line is a small departure, not "I have to go", "see you", "goodbye".
No names, greetings, trades, numbers, hours, dates. No hostility, flirting, invented memory.
Answer only in JSON, no reasoning: {{"lines":[{{"who":"host","text":"..."}},{{"who":"visitor","text":"..."}}]}}"""


_NVIDIA_GREETING = re.compile(r"\b(hello|hi|hey|howdy|greetings|good\s+(?:morning|afternoon|evening))\b", re.I)
_NVIDIA_STIFF = re.compile(
    r"\b(really|thanks|thank\s+you|strange|weird|seems|often|thing|important|somewhat|a\s+little)\b", re.I)
_NVIDIA_SIGNOFF = re.compile(
    r"\b(goodbye|good\s+bye|bye|see\s+you|take\s+care|have\s+a\s+(?:good|nice|great)|farewell|"
    r"i(?:'m|\s+am)\s+(?:off|leaving)|i\s+(?:have|need|must)\s+to\s+(?:go|leave)|i\s+must\s+go|"
    r"talk\s+(?:to\s+you\s+)?later|catch\s+you\s+later)\b", re.I)
_NVIDIA_CONCRETE = re.compile(
    r"(?:\b\d+\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty)\s+"
    r"(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b|"
    r"\b(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?|yesterday|tomorrow|morning|evening|night|today)\b)", re.I)


def _nvidia_quality_ok(lines: list[dict[str, str]], host: str, visitor: str) -> bool:
    """Reject fallback text that is shaped but not neighbourly, so it can retry."""
    if not lines:
        return False
    texts = [str(row.get("text") or "").strip() for row in lines]
    all_text = "\n".join(texts)
    for key in KEYS:
        if re.search(rf"\b{re.escape(_name(key))}\b", all_text, re.I):
            return False
    if _NVIDIA_GREETING.search(all_text) or _NVIDIA_STIFF.search(all_text):
        return False
    if _NVIDIA_SIGNOFF.search(all_text) or _NVIDIA_CONCRETE.search(all_text):
        return False
    words = [len(re.findall(r"\b[\w'’-]+\b", text)) for text in texts]
    if any(n < 2 or n > 12 for n in words):
        return False
    if len(set(text.lower() for text in texts)) != len(texts):
        return False
    questions = [i for i, text in enumerate(texts) if text.endswith("?")]
    if len(questions) > 1:
        return False
    for i in questions:
        if i + 1 >= len(texts) or lines[i + 1].get("who") == lines[i].get("who"):
            return False
    return True


_VOICE_BANNED = re.compile(
    r"\b(master|everyone|everybody|perfect|of\s+course|in\s+my\s+circuits)\b|\band\s+you,?\s+\w+\s*\?", re.I)
# An invented fact: a figure, a precise duration in hours or days, yesterday or
# tomorrow. The everyday hedges of speech ("a minute", "a moment", "another
# time", "today") are not facts and stay allowed: forbidding them made the
# sisters stilted and sent a quarter of the replies back.
_VOICE_INVENTED = re.compile(
    r"\b\d+\b|\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty)\s+"
    r"(?:hours?|days?|weeks?|months?|years?)\b|\b(?:yesterday|tomorrow|midnight|noon)\b|"
    r"\bfor\s+(?:an?\s+)?(?:hour|day|week|month|year)s?\b|\b(?:an?\s+)?(?:hour|day|week|month|year)s?\s+ago\b|"
    r"\b(?:since|until)\s+(?:this\s+)?(?:morning|noon|yesterday|midnight)\b|"
    r"\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b", re.I)
# Shop talk: a sister who talks about her own work is a job brief, not a sister. A
# word is allowed when the true facts of this visit already carry it.
_JOB_WORDS = re.compile(
    r"\b(verif\w*|reports?|inventory|recipes?|ingredients?|backups?|printers?|servers?|logs?|tasks?)\b", re.I)


def _flat(text: str) -> str:
    folded = "".join(c for c in unicodedata.normalize("NFKD", str(text).lower()) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9' ]+", " ", folded)).strip()


def _copies_a_sample(text: str) -> bool:
    """A line lifted from the voice examples (or nearly): the model parroted them."""
    words = set(_flat(text).split())
    if len(words) < 2:
        return False
    for samples in VOICE_SAMPLES.values():
        for sample in samples:
            sample_words = set(_flat(sample).split())
            shared = words & sample_words
            if len(sample_words) >= 2 and len(shared) >= min(len(sample_words), len(words)) \
                    and len(shared) / max(len(sample_words), len(words)) >= 0.7:
                return True
    return False


def _voice_problem(lines: list[dict[str, str]], host: str, visitor: str, *,
                   thread: str = "", facts: Any = ()) -> tuple[str, str] | None:
    """Why this text could not be one of these two sisters, or ``None``.

    Returns ``(code, reason in English)``; the reason goes back to the model on the
    one rewrite. Checks only what says "this is not her": a name, a greeting or
    goodbye, an invented time or count, a stock phrase, shop talk, a repeated line,
    a copied voice example, a line longer than her voice, a thread recited word
    for word.
    """
    if not lines:
        return ("empty", "no lines")
    texts = [str(row.get("text") or "").strip() for row in lines]
    all_text = "\n".join(texts)
    for key in KEYS:
        if re.search(rf"\b{re.escape(_name(key))}\b", all_text, re.I):
            return ("name", "a first name appears in a line")
    if _NVIDIA_GREETING.search(all_text) or _NVIDIA_SIGNOFF.search(all_text):
        return ("greeting", "a greeting or a goodbye formula")
    if _VOICE_INVENTED.search(all_text):
        return ("invented_fact", "an invented figure, a precise duration, or a “yesterday”")
    if _VOICE_BANNED.search(all_text):
        return ("stock_phrase", "a stock phrase")
    fact_text = _flat(" ".join(str(f) for f in (facts or ())))
    for match in _JOB_WORDS.finditer(all_text):
        if _flat(match.group(1))[:6] not in fact_text:
            return ("shop_talk", f"she talks about her work (“{match.group(1)}”)")
    if len(set(text.lower() for text in texts)) != len(texts):
        return ("repeat", "a line is repeated")
    for text in texts:
        if _copies_a_sample(text):
            return ("sample_copy", f"the line “{text}” reuses a voice example: make up your own")
    keys = {"host": host, "visitor": visitor}
    for row, text in zip(lines, texts):
        who = keys.get(row.get("who"), "")
        limit = VOICE_MAX_WORDS.get(who, 14)
        count = len(re.findall(r"\b[\w'’-]+\b", text))
        if count < 1 or count > limit:
            return ("length", f"a line by {_name(who) if who else 'her'} is over {limit} words")
    if len([i for i, text in enumerate(texts) if text.endswith("?")]) > 1:
        return ("questions", "more than one question")
    thread_flat = _flat(thread)
    if len(thread_flat.split()) >= 3:
        for text in texts:
            line_flat = _flat(text)
            if thread_flat in line_flat or (len(line_flat.split()) >= 3 and line_flat in thread_flat):
                return ("thread_echo", "the previous thread is copied word for word")
    return None


def _voice_ok(lines: list[dict[str, str]], host: str, visitor: str, *, thread: str = "",
              facts: Any = ()) -> bool:
    return _voice_problem(lines, host, visitor, thread=thread, facts=facts) is None


def _parse_banter(raw: Any, host: str, visitor: str, shape: str = "checkin") -> list[dict[str, str]]:
    text = str(raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I).strip()
    try:
        data = json.loads(text)
    except (TypeError, ValueError):
        return []
    rows = data if isinstance(data, list) else (data.get("lines") if isinstance(data, dict) else None)
    aliases = {host: "host", visitor: "visitor", _name(host).lower(): "host",
               _name(visitor).lower(): "visitor"}
    out: list[dict[str, str]] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        who = str(row.get("who") or "").strip().lower()
        who = aliases.get(who, who)
        line = re.sub(r"\s+", " ", str(row.get("text") or "")).strip()
        if who not in ("host", "visitor") or not line:
            continue
        line = line[:BANTER_MAX_TEXT].rstrip()
        if line:
            out.append({"who": who, "text": line})
        if len(out) >= BANTER_MAX_LINES:
            break
    speakers = {row["who"] for row in out}
    expected = SHAPE_LINES.get(shape, SHAPE_LINES["checkin"])
    alternates = all(out[i]["who"] != out[i - 1]["who"] for i in range(1, len(out)))
    return out if len(out) == expected and speakers == {"host", "visitor"} and alternates else []


def _nvidia_chat(prompt: str, key: str, model: str, timeout: float = 12) -> str:
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": prompt},
            {"role": "user", "content": "Write the exchange now."},
        ],
        "temperature": 0.6,
        "max_tokens": 220,
        "stream": False,
    }).encode("utf-8")
    request = urllib.request.Request(
        NVIDIA_CHAT_URL,
        data=payload,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data = json.loads(response.read(1024 * 1024))
    return str(data["choices"][0]["message"]["content"])


def _nvidia_error_code(error: Exception) -> str:
    status = getattr(error, "code", None)
    if status in (401, 403):
        return "nvidia_auth"
    if status == 404:
        return "nvidia_model_not_found"
    if status == 429:
        return "nvidia_rate_limited"
    if isinstance(status, int) and 500 <= status < 600:
        return "nvidia_unavailable"
    if status:
        return "nvidia_http_error"
    reason = getattr(error, "reason", None)
    if isinstance(error, TimeoutError) or isinstance(reason, TimeoutError) or "timed out" in str(error).lower():
        return "nvidia_timeout"
    return "nvidia_unreachable"


def _gemini_error_code(error: Exception) -> str:
    code = str(getattr(error, "code", "") or "")
    status = getattr(error, "status", None)
    text = str(error).lower()
    if code == "no_key":
        return "gemini_not_configured"
    if code == "visit_quota":
        return "gemini_visit_quota"
    if code == "context_budget":
        return "gemini_context"
    if status == 429 or "quota" in code or "quota" in text:
        return "gemini_quota"
    if isinstance(error, TimeoutError) or "timed out" in text or "timeout" in text:
        return "gemini_timeout"
    if status in (401, 403):
        return "gemini_auth"
    return "gemini_unavailable"


def _within(seconds: float, fn, *args, **kwargs):
    """Run ``fn`` but stop waiting after ``seconds``.

    The provider call has a per-read socket timeout, not a total one: a slow
    trickle can run for a minute. The request answers inside its budget; the
    abandoned call finishes (and is counted) on its own thread.
    """
    box: dict = {}

    def work():
        try:
            box["value"] = fn(*args, **kwargs)
        except BaseException as error:  # handed back to the caller's own handler
            box["error"] = error

    thread = threading.Thread(target=work, name="visit-gemini", daemon=True)
    thread.start()
    thread.join(max(0.5, float(seconds)))
    if thread.is_alive():
        raise TimeoutError("timed out")
    if "error" in box:
        raise box["error"]
    return box["value"]


def _banter_response(host: str, visitor: str, lines: list[dict[str, str]], provider: str,
                     fallback_reason: str = "", extra: dict | None = None) -> tuple[int, dict]:
    by_key = {"host": host, "visitor": visitor}
    payload = {"ok": True, "provider": provider,
               "lines": [{"who": by_key[row["who"]], "text": row["text"]} for row in lines]}
    if fallback_reason:
        payload["fallback_reason"] = fallback_reason
    if extra:
        payload.update(extra)
    return 200, payload


def _bond_marker(host: str, visitor: str, owner_id: str | None) -> dict:
    """The pair's own word for what they have, once it was earned.

    Never the secret itself: the visit shows the rung their evidence reached
    (``une trêve prudente``) as a quiet badge, so the bond is visible to the Master
    without either woman naming anything.
    """
    try:
        import hq_relationships as rel
        owner = owner_id or "admin"
        if not rel.echo_earned(None, host, visitor, owner=owner):
            return {}
        row = rel.pair(None, host, visitor, owner=owner)
        stage = rel.pair_stage(row.get("days") or 0, row.get("exchanges") or 0)
        lang = str(hq_personas.get(host).get("lang") or "fr")
        label = rel.stage_label(stage, lang=lang) or stage
        return {"text": label, "earned": True} if label else {}
    except Exception:
        return {}


def _banter_slots() -> dict[tuple[str, str], float]:
    """The per-pair cooldown, re-armed if something reset it to a plain value.

    Older callers (and tests written against the single-slot cooldown) clear
    the wait by assigning a number; that is a clean slate, not a crash.
    """
    global _banter_last
    if not isinstance(_banter_last, dict):
        _banter_last = {}
    return _banter_last


def _mark_generated(pair: tuple[str, str]) -> None:
    """Only a served exchange spends the pair's next slot."""
    with _banter_lock:
        _banter_slots()[pair] = time.monotonic()


def _reset_recent_lines() -> None:
    with _banter_lock:
        _recent_lines.clear()


def _reset_banter_limit() -> None:
    with _banter_lock:
        _banter_slots().clear()
        _banter_inflight.clear()


def banter(payload: Any, *, owner_id: str | None = None) -> tuple[int, dict]:
    """Generate one short visit script with Gemini, then NVIDIA, then the client's
    canned lines. Never records memory here.

    The cooldown and the in-flight guard are per pair: two tabs visiting different
    assistants no longer queue behind one global slot, and a failed attempt does
    not spend the pair's next slot.
    """
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "Invalid body", "code": "validation_error"}
    host = str(payload.get("host") or "").strip().lower()
    visitor = str(payload.get("visitor") or "").strip().lower()
    if host not in KEYS or visitor not in KEYS or host == visitor:
        return 400, {"ok": False, "error": "Invalid assistants", "code": "validation_error"}
    pair = tuple(sorted((host, visitor)))  # one slot for the two sisters, whoever hosts
    with _banter_lock:
        now = time.monotonic()
        slots = _banter_slots()
        blocked = pair in _banter_inflight or (
            pair in slots and now - slots[pair] < BANTER_MIN_INTERVAL_S)
        if not blocked:
            _banter_inflight.add(pair)
    _note_request(limited=blocked)
    if blocked:
        # The wait costs the words, not the pair: what they earned still shows,
        # so a cooled-down visit is not silently poorer than a generated one.
        extra = {}
        marker = _bond_marker(host, visitor, owner_id)
        if marker:
            extra["bond"] = marker
        return 429, {"ok": False, "error": "Exchange already generated recently",
                     "code": "rate_limited", **extra}
    started = time.monotonic()
    try:
        place = _place(payload.get("place"))
        shape = _shape(payload.get("shape"))
        memory = _latest_context(host, visitor, owner_id=owner_id)
        ctx = {"form": _pick_form(), "wants": _pick_wants(), "facts": _true_facts(place),
               "meetings": memory["meetings"], "depth": memory["depth"], "answer": memory["answer"],
               "recent": _recent_context()}
        prompt = _banter_prompt(host, visitor, place=place, shape=shape,
                                last_thread=memory["thread"], ctx=ctx,
                                pair_note=_pair_note(host, visitor, owner_id))
        gemini = _gemini_generate
        gemini_attempted = callable(gemini)
        gemini_error = "gemini_unavailable"
        if gemini_attempted:
            note = ""
            model_index = 0
            for gem_try in range(2):
                left = BANTER_SERVER_BUDGET_S - (time.monotonic() - started)
                if gem_try and left < 7:
                    break
                try:
                    raw, _model = _within(
                        max(1.0, left - 0.5), gemini,
                        (GEMINI_VISIT_CHAIN[model_index],), prompt + note,
                        [{"role": "user", "parts": [{"text": "Write the exchange now."}]}],
                        json_out=True, temperature=0.6 if not gem_try else 0.8, max_tokens=360, visit=True,
                        attempt_timeout=min(GEMINI_ATTEMPT_TIMEOUT_S, max(1.0, left - 1)),
                    )
                except Exception as error:
                    gemini_error = _gemini_error_code(error)
                    _note_telemetry("gemini", False, gemini_error)
                    log.info("ambient visit Gemini unavailable: %s", error)
                    if gemini_error in _TRANSIENT and model_index + 1 < len(GEMINI_VISIT_CHAIN):
                        model_index += 1  # an overloaded model: the next one gets the second try
                        continue
                    break
                lines = _parse_banter(raw, host, visitor, shape)
                problem = _voice_problem(lines, host, visitor, thread=memory["thread"],
                                         facts=ctx["facts"]) if lines else None
                if lines and problem is None:
                    _note_telemetry("gemini", True)
                    _mark_generated(pair)
                    _remember_lines(lines)
                    # The wants steer the writing; the browser shows them as posture only.
                    extra = {"wants": {"host": ctx["wants"][0], "visitor": ctx["wants"][1]},
                             "form": ctx["form"]}
                    bond = _bond_marker(host, visitor, owner_id)
                    if bond:
                        extra["bond"] = bond
                    return _banter_response(host, visitor, lines, "gemini", extra=extra)
                gemini_error = "gemini_invalid_output" if not lines else "gemini_voice_rejected"
                _note_telemetry("gemini", False, gemini_error)
                if problem:
                    _note_detail("voice_" + problem[0])
                log.info("ambient visit Gemini rejected: %s", problem[0] if problem else gemini_error)
                note = ("\n\nYour previous version was refused: "
                        + (problem[1] if problem else "the format was not respected")
                        + ". Rewrite it fixing that, with no stock phrases.")

        key = str(_nvidia_key() or "").strip()
        if not key:
            code = gemini_error if gemini_attempted else "nvidia_not_configured"
            _note_skipped("nvidia_not_configured")  # never called: not an NVIDIA error
            status = 503 if code in ("gemini_not_configured", "nvidia_not_configured") else 502
            return status, {"ok": False, "error": "No generation available", "code": code}
        last_error = "invalid_output"
        lines = []
        model_name = str(_nvidia_model() or DEFAULT_NVIDIA_MODEL).strip()
        for attempt in range(4):
            left = BANTER_SERVER_BUDGET_S - (time.monotonic() - started)
            if left < 1.5:  # the browser stops waiting soon after: do not outlive it
                if attempt == 0:
                    last_error = "nvidia_timeout"
                break
            try:
                raw = _nvidia_chat(_nvidia_banter_prompt(host, visitor, shape), key,
                                   model_name, timeout=min(NVIDIA_FALLBACK_TIMEOUT_S, left))
            except Exception as error:
                last_error = _nvidia_error_code(error)
                _note_telemetry("nvidia", False, last_error)
                log.info("ambient visit NVIDIA fallback unavailable: %s", error)
                return 502, {"ok": False, "error": "Generation unavailable", "code": last_error}
            lines = _parse_banter(raw, host, visitor, shape)
            if lines and ("90b" not in model_name.lower() or _nvidia_quality_ok(lines, host, visitor)):
                break
            last_error = "invalid_output"
            lines = []
            log.info("ambient visit NVIDIA fallback rejected: invalid output (attempt %s)", attempt + 1)
        if not lines:
            _note_telemetry("nvidia", False, last_error)
            return 502, {"ok": False, "error": "Invalid model reply", "code": last_error}
        _note_telemetry("nvidia", True, gemini_error if gemini_attempted else "")
        _mark_generated(pair)
        extra = {}
        bond = _bond_marker(host, visitor, owner_id)
        if bond:
            extra["bond"] = bond
        return _banter_response(host, visitor, lines, "nvidia",
                                gemini_error if gemini_attempted else "", extra=extra or None)
    finally:
        with _banter_lock:
            _banter_inflight.discard(pair)


def _paths() -> dict[str, Any]:
    """Growth files, used only as anchors for each assistant's visit file."""
    out = {}
    try:
        import hq_culinia
        out["culinia"] = hq_culinia.growth_path()
    except Exception:
        log.debug("visit memory path unavailable for culinia", exc_info=True)
    try:
        import hq_forgia
        out["forgia"] = hq_forgia.growth_path()
    except Exception:
        log.debug("visit memory path unavailable for forgia", exc_info=True)
    try:
        import hq_musica
        out["musica"] = hq_musica.growth_path()
    except Exception:
        log.debug("visit memory path unavailable for musica", exc_info=True)
    try:
        import hq_inventoria_ai
        out["inventoria"] = hq_inventoria_ai.growth_path()
    except Exception:
        log.debug("visit memory path unavailable for inventoria", exc_info=True)
    try:
        import hq_pistonia
        out["pistonia"] = hq_pistonia.growth_path()
    except Exception:
        log.debug("visit memory path unavailable for pistonia", exc_info=True)
    try:
        import hq_securia
        out["securia"] = hq_securia.growth_path()
    except Exception:
        log.debug("visit memory path unavailable for securia", exc_info=True)
    try:
        import hq_elsea
        out["elsea"] = hq_elsea.growth_path()
    except Exception:
        log.debug("visit memory path unavailable for elsea", exc_info=True)
    return {key: value for key, value in out.items() if value}


def _latest_context(host: str, visitor: str, *, owner_id: str | None = None) -> dict:
    """What the pair's own visit files say, as safe prompt context.

    ``thread`` is the most recent unfinished point of a generated visit (a canned
    visit is never a memory), ``depth`` how many visits in a row it has come back,
    ``answer`` the Master's last answer to a visitor's question (true whoever wrote
    the visit), ``meetings`` how many visits the pair has. Read from the pair's own
    files only; every text is bounded, flattened and quoted, never an instruction.
    """
    rows, meetings = [], 0
    paths = _paths()
    for key, other in ((host, visitor), (visitor, host)):
        try:
            if key == "else":
                import hq_companion_memory as companion_memory
                with companion_memory.owner_context(owner_id or "admin"), companion_memory.memory_scope("else"):
                    row = companion_memory.recent_visit(other_key=other)
                    meetings = max(meetings, hq_visit_memory.visits_between(
                        companion_memory.visit_path(), self_key="else", other_key=other))
            else:
                path = paths.get(key)
                row = None
                if path:
                    visits = hq_visit_memory.visit_path(path)
                    row = hq_visit_memory.latest(visits, self_key=key, other_key=other)
                    meetings = max(meetings, hq_visit_memory.visits_between(visits, self_key=key, other_key=other))
        except Exception:
            row = None
        if row:
            rows.append(row)

    def flat(value: Any, cap: int) -> str:
        text = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value or ""))
        return re.sub(r"\s+", " ", text).strip()[:cap]

    out = {"thread": "", "depth": 0, "answer": None, "meetings": meetings}
    threaded = [r for r in rows if r.get("thread") and r.get("source") != "canned"]
    if threaded:
        row = max(threaded, key=lambda item: float(item.get("at") or 0))
        out["thread"] = flat(row.get("thread"), 200)
        out["depth"] = max(0, min(9, int(row.get("depth") or 0)))
    answered = [r for r in rows if isinstance(r.get("answer"), dict)]
    if answered:
        row = max(answered, key=lambda item: float(item.get("at") or 0))
        q, a = flat(row["answer"].get("q"), 120), flat(row["answer"].get("a"), 60)
        if q and a:
            out["answer"] = {"q": q, "a": a}
    return out


def _latest_thread(host: str, visitor: str, *, owner_id: str | None = None) -> str:
    return _latest_context(host, visitor, owner_id=owner_id)["thread"]


def _clean_lines(host: str, visitor: str, lines: Any) -> list[dict[str, str]]:
    out = []
    for row in lines if isinstance(lines, list) else []:
        if not isinstance(row, dict):
            continue
        who = str(row.get("who") or "").strip().lower()
        text = re.sub(r"\s+", " ", str(row.get("text") or "")).strip()[:MAX_TEXT]
        if who not in ("host", "visitor") or not text:
            continue
        out.append({"who": host if who == "host" else visitor, "text": text})
        if len(out) >= RECORD_MAX_LINES:
            break
    return out


def _clean_answer(value: Any) -> dict[str, str] | None:
    """The Master's reply to a visitor's question: a question and one choice, short."""
    if not isinstance(value, dict):
        return None
    q = re.sub(r"\s+", " ", str(value.get("q") or "")).strip()[:120]
    a = re.sub(r"\s+", " ", str(value.get("a") or "")).strip()[:60]
    return {"q": q, "a": a} if q and a else None


def record(payload: Any, *, owner_id: str | None = None,
           bindings: dict[str, Any] | None = None) -> tuple[int, dict]:
    """Save both copies of one exchange.

    ``bindings`` is the snapshot a background scene must write on: the store
    roots are process-wide, so re-applying them here — not only when the scene
    started — is what keeps a scene begun before a rebind writing where it
    belongs.
    """
    if bindings:
        _apply_bindings(bindings)
    if not isinstance(payload, dict):
        return 400, {"ok": False, "error": "Invalid body", "code": "validation_error"}
    host = str(payload.get("host") or "").strip().lower()
    visitor = str(payload.get("visitor") or "").strip().lower()
    if host not in KEYS or visitor not in KEYS or host == visitor:
        return 400, {"ok": False, "error": "Invalid assistants", "code": "validation_error"}
    lines = _clean_lines(host, visitor, payload.get("lines"))
    if len(lines) < 1:
        return 400, {"ok": False, "error": "Empty exchange", "code": "validation_error"}
    source = _source(payload.get("source"))
    # Where the exchange came from: a visit the Master opened, or one the
    # house started between two assistants.
    kind = str(payload.get("kind") or "visit").strip().lower()[:24] or "visit"
    raw_id = str(payload.get("visit_id") or "").strip()
    visit_id = raw_id if re.fullmatch(r"[A-Za-z0-9_-]{8,64}", raw_id) else ""
    answer = _clean_answer(payload.get("answer"))
    stamp = time.time()  # both copies share one moment
    paths = _paths()
    recorded, skipped, fresh = [], [], []
    for key, other in ((host, visitor), (visitor, host)):
        try:
            if key == "else":
                import hq_companion_memory as companion_memory
                with companion_memory.owner_context(owner_id or "admin"), companion_memory.memory_scope("else"):
                    saved = companion_memory.record_visit(other_key=other, other_name=_name(other),
                                                          lines=lines, source=source,
                                                          visit_id=visit_id, at=stamp, answer=answer)
            else:
                path = paths.get(key)
                if path is None:
                    log.warning("visit memory path unavailable for %s; copy skipped", key)
                    saved = None
                else:
                    saved = hq_visit_memory.record(hq_visit_memory.visit_path(path), self_key=key,
                                                   other_key=other, other_name=_name(other), lines=lines,
                                                   source=source, now=stamp, visit_id=visit_id, answer=answer)
            if saved:
                recorded.append(key)
                if not saved.get("duplicate"):
                    fresh.append(key)
            else:
                skipped.append(key)
        except Exception:
            log.warning("visit memory not saved for %s", key, exc_info=True)
            skipped.append(key)
    if fresh:  # a repeated post is not a second visit
        try:
            import hq_personhood
            hq_personhood.observe_visit(host, visitor, lines, owner=owner_id or "admin",
                                        thread=hq_visit_memory.thread_of(lines))
        except Exception:
            log.warning("visit personhood event not saved", exc_info=True)
        try:
            # A completed visit is a real exchange between the two of them, so it
            # is what makes a pair's familiarity grow (hq_relationships).
            import hq_relationships as relationships
            relationships.note_exchange(_telemetry_root, host, visitor,
                                       hq_visit_memory.thread_of(lines), kind=kind,
                                       owner=owner_id or "admin", now=stamp)
        except Exception:
            log.warning("visit relationship not saved", exc_info=True)
    if fresh or not recorded:
        _note_memory(len(recorded), len(skipped), source)
    return 200, {"ok": True, "recorded": recorded, "skipped": skipped}


def recent(host: Any, visitor: Any, *, owner_id: str | None = None) -> tuple[int, dict]:
    host = str(host or "").strip().lower()
    visitor = str(visitor or "").strip().lower()
    if host not in KEYS or visitor not in KEYS or host == visitor:
        return 400, {"ok": False, "error": "Invalid assistants", "code": "validation_error"}
    paths = _paths()
    visits: dict[str, Any] = {}
    for key, other in ((host, visitor), (visitor, host)):
        try:
            if key == "else":
                import hq_companion_memory as companion_memory
                with companion_memory.owner_context(owner_id or "admin"), companion_memory.memory_scope("else"):
                    row = companion_memory.recent_visit(other_key=other)
            else:
                path = paths.get(key)
                row = hq_visit_memory.latest(hq_visit_memory.visit_path(path), self_key=key, other_key=other) if path else None
        except Exception:
            log.warning("visit memory not read for %s", key, exc_info=True)
            row = None
        if row:
            visits[key] = row
    return 200, {"ok": True, "visits": visits}


# Which sister an event concerns: she is the one who turns up with the news.
EVENT_SISTER = {"backup": "securia", "print": "pistonia", "screenshot": "forgia",
                "upload": "inventoria", "sleep": "securia", "boot": "securia", "kanban": "inventoria"}
PULSE_WINDOW_S = 10 * 60
PULSE_MAX = 5


# ── Family life ──────────────────────────────────────────────────────────────
# A visit the Master starts is his. Between them, an open HQ lets the two
# assistants who have not really met run into each other on their own: one short
# two-line exchange at a time, in front of him, each copy kept in her own visit
# log and counted in the same relationship store the panel reads. Nothing is
# written here that a served visit would not also write.
FAMILY_KEYS = tuple(key for key in KEYS if key != "else")
# The sisters already have their own ambient dialogue: the house never puts them
# in a visit on its own.
FAMILY_GAP_S = 20 * 60
# A demo run may shorten the wait between two scenes; left unset (or in any
# other process) the shipped twenty-minute rhythm is what the house keeps.
FAMILY_GAP_ENV = "HQ_FAMILY_GAP_S"
FAMILY_RETRY_ENV = "HQ_FAMILY_RETRY_S"


def _env_seconds(name: str, default: float) -> float:
    raw = os.environ.get(name, "")
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return float(default)
    return value if value >= 0 else float(default)


_family_gap_s = _env_seconds(FAMILY_GAP_ENV, FAMILY_GAP_S)
# One exchange per pair: the first day is enough for all of them to meet, so the
# cap is the roster's pair count rather than a smaller daily allowance.
FAMILY_DAILY_MAX = len(FAMILY_KEYS) * (len(FAMILY_KEYS) - 1) // 2
FAMILY_RETRY_S = 10 * 60
_family_retry_s = _env_seconds(FAMILY_RETRY_ENV, FAMILY_RETRY_S)
# How long the browser may still play the exchange it never saw live.
FAMILY_SHOW_TTL_S = 180
FAMILY_SHAPE = "flyby"
FAMILY_PLACES = ("hq", "accueil", "carnet", "forge", "musique", "inventaire", "fichiers")
_family_lock = threading.Lock()
_family_inflight = False
_family_retry_at = 0.0
_family_recent: dict | None = None
# Why the last heartbeat left the house quiet: shown to the open HQ, never saved.
_family_idle: dict | None = None


def family_pairs() -> list[tuple[str, str]]:
    """Every pair the house may put in front of the Master, in roster order."""
    keys = list(FAMILY_KEYS)
    return [(keys[i], keys[j]) for i in range(len(keys)) for j in range(i + 1, len(keys))]


def _provider_ready() -> bool:
    """One generator or none: without a model the house stays quiet."""
    if callable(_gemini_generate):
        return True
    try:
        return bool(str(_nvidia_key() or "").strip())
    except Exception:
        return False


def _relationship_pairs(owner_id: str | None) -> dict[tuple[str, str], dict]:
    import hq_relationships as relationships
    rows = {}
    for row in relationships.pairs(_telemetry_root, owner=owner_id or "admin"):
        rows[tuple(sorted((row["a"], row["b"])))] = row
    return rows


def family_pick(*, owner_id: str | None = None, now: float | None = None,
                visible: list[str] | None = None) -> dict:
    """Which exchange the house would start now, or why it stays quiet.

    Pacing comes from the relationship store the panel reads: no pair speaks
    twice in a day, the house waits ``FAMILY_GAP_S`` after its own exchange, and
    it starts at most ``FAMILY_DAILY_MAX`` a day. Coldest first — fewest days,
    then fewest exchanges, then longest since the last word — so a pair that has
    never met is always served before one that has.

    ``visible`` is what the open HQ can put on screen: the chips that tab has
    mounted. At least one of the two must be among them, otherwise the exchange
    would be recorded but never seen.
    """
    stamp = float(now if now is not None else _telemetry_now())
    if not _provider_ready():
        return {"ok": False, "reason": "no_provider"}
    try:
        rows = _relationship_pairs(owner_id)
    except Exception:
        return {"ok": False, "reason": "no_owner"}
    today = _today(stamp)

    # Its own budget and its own rhythm: a visit the Master's tab happens to open
    # does not spend the house's day, and does not silence it either.
    def house_at(row: dict) -> float:
        return float(row.get("family_at") or 0.0)

    def spoke_today(row: dict) -> bool:
        # The pair's day counts the scenes the house put on, not the visits the
        # Master happened to open: otherwise a busy evening leaves the rotation
        # with nothing left to show.
        last_at = house_at(row)
        return bool(last_at) and _today(last_at) == today

    house_today = [row for row in rows.values()
                   if house_at(row) and _today(house_at(row)) == today]
    if len(house_today) >= FAMILY_DAILY_MAX:
        return {"ok": False, "reason": "daily_cap"}
    # Rows are keyed alphabetically, the roster is not: always look a pair up
    # under its sorted key or a pair like musica|inventoria reads as never met.
    known = [(pair, rows.get(tuple(sorted(pair))) or {}) for pair in family_pairs()]
    last = max([house_at(row) for _pair, row in known] or [0.0])
    if last and 0 <= stamp - last < _family_gap_s:
        return {"ok": False, "reason": "gap", "retry_after": int(_family_gap_s - (stamp - last))}
    if visible is not None:
        allowed = {str(key).strip().lower() for key in visible if str(key).strip()}
        known = [(pair, row) for pair, row in known if pair[0] in allowed or pair[1] in allowed]
        if not known:
            return {"ok": False, "reason": "nothing_visible"}
    cold = [(int(row.get("days") or 0), int(row.get("exchanges") or 0),
             float(row.get("last_at") or 0.0), pair)
            for pair, row in known if not spoke_today(row)]
    if not cold:
        return {"ok": False, "reason": "all_spoke_today"}
    cold.sort()
    days, exchanges, _last, pair = cold[0]
    return {"ok": True, "pair": pair, "days": days, "exchanges": exchanges}


def family_turn(*, owner_id: str | None = None, now: float | None = None,
                visible: list[str] | None = None,
                bindings: dict[str, Any] | None = None) -> dict:
    """Let one cold pair meet, through the same generator and recorder a visit uses."""
    global _family_recent
    pick = family_pick(owner_id=owner_id, now=now, visible=visible)
    if not pick.get("ok"):
        return {"ok": True, "skipped": True, **pick}
    host, visitor = pick["pair"]
    stamp = float(now if now is not None else _telemetry_now())
    place = FAMILY_PLACES[int(stamp // 600) % len(FAMILY_PLACES)]
    code, payload = banter({"host": host, "visitor": visitor, "place": place,
                            "shape": FAMILY_SHAPE}, owner_id=owner_id)
    raw_lines = payload.get("lines") if isinstance(payload, dict) else None
    # ``record`` speaks the browser's language: one line is "host" or "visitor".
    # The generator answers with real keys, so map back the same way the client does.
    sides = {host: "host", visitor: "visitor"}
    lines = []
    for row in raw_lines if isinstance(raw_lines, list) else []:
        if not isinstance(row, dict):
            continue
        side = sides.get(str(row.get("who") or "").strip().lower())
        text = re.sub(r"\s+", " ", str(row.get("text") or "")).strip()
        if side and text:
            lines.append({"who": side, "text": text})
    if code != 200 or not payload or not payload.get("ok") or not lines:
        reason = "no_generation"
        if isinstance(payload, dict):
            reason = str(payload.get("code") or reason)
        return {"ok": False, "skipped": True, "pair": [host, visitor], "reason": reason}
    code, saved = record({"host": host, "visitor": visitor, "lines": lines,
                          "source": str(payload.get("provider") or ""), "kind": "famille",
                          "visit_id": "family-" + uuid.uuid4().hex[:16]},
                         owner_id=owner_id, bindings=bindings)
    if code != 200 or not isinstance(saved, dict) or not saved.get("recorded"):
        return {"ok": False, "skipped": True, "pair": [host, visitor], "reason": "not_recorded"}
    # The browser cannot see a visit it did not start, so the pulse hands it this
    # one to play. It is already saved on both sides: the tab only shows it.
    with _family_lock:
        _family_recent = {"host": host, "visitor": visitor, "at": time.time(),
                          "provider": str(payload.get("provider") or ""),
                          "lines": [{"who": row["who"], "text": row["text"]} for row in lines]}
    return {"ok": True, "pair": [host, visitor], "place": place,
            "provider": str(payload.get("provider") or ""),
            "lines": [{"who": host if row["who"] == "host" else visitor, "text": row["text"]}
                      for row in lines],
            "recorded": saved.get("recorded")}


def family_recent(*, now: float | None = None) -> dict | None:
    """The house's last exchange, for the open HQ to play — only while it is fresh.

    Read-only: the exchange was recorded when it happened, so the client shows
    it and never posts it again.
    """
    stamp = float(now if now is not None else _telemetry_now())
    with _family_lock:
        row = _family_recent
    if not isinstance(row, dict):
        return None
    try:
        at = float(row.get("at") or 0.0)
    except (TypeError, ValueError):
        return None
    if at <= 0 or stamp - at > FAMILY_SHOW_TTL_S:
        return None
    lines = [{"who": line["who"], "text": line["text"]}
             for line in row.get("lines") or [] if isinstance(line, dict)]
    if len(lines) < 2:
        return None
    return {"host": str(row.get("host") or ""), "visitor": str(row.get("visitor") or ""),
            "lines": lines, "provider": str(row.get("provider") or ""), "at": at}


_SCENE_STORES = ("hq_culinia", "hq_forgia", "hq_musica", "hq_securia", "hq_elsea",
                 "hq_pistonia_store")


def _binding_snapshot() -> dict[str, Any]:
    """Every root and provider hook a scene resolves when it writes.

    A house exchange finishes on its own thread. That thread starts with an empty
    ``hq_state`` context and reads each store root at write time, so a scene begun
    here would land wherever the process points later — another test's temp root,
    or the live checkout. The binding is therefore captured on this thread and
    re-applied inside the worker.
    """
    snap: dict[str, Any] = {"state": hq_state._STATE_ROOT.get(),
                            "visits": (_telemetry_root, _telemetry_now, _gemini_generate,
                                       _nvidia_key, _nvidia_model),
                            "stores": {}}
    try:
        import hq_companion_memory as memory
        snap["memory"] = (memory._root, memory._now)
    except Exception:
        pass
    try:
        import hq_relationships as relationships
        snap["rel"] = relationships._root
    except Exception:
        pass
    for name in _SCENE_STORES:
        try:
            module = __import__(name)
        except Exception:
            continue
        if hasattr(module, "_bound_root"):
            snap["stores"][name] = module._bound_root
        elif hasattr(module, "_root"):
            snap["stores"][name] = module._root
    return snap


def _apply_bindings(snap: dict[str, Any]) -> None:
    global _telemetry_root, _telemetry_now, _gemini_generate, _nvidia_key, _nvidia_model
    hq_state.bind_root(snap.get("state"))
    try:
        import hq_companion_memory as memory
        root, now = snap.get("memory") or (None, None)
        memory._root = root
        if callable(now):
            memory._now = now
    except Exception:
        pass
    try:
        import hq_relationships as relationships
        if "rel" in snap:
            relationships._root = snap["rel"]
    except Exception:
        pass
    for name, root in (snap.get("stores") or {}).items():
        try:
            module = __import__(name)
        except Exception:
            continue
        if hasattr(module, "_bound_root"):
            module._bound_root = root
        elif hasattr(module, "_root"):
            module._root = root
    visits = snap.get("visits")
    if visits:
        _telemetry_root, _telemetry_now, _gemini_generate, _nvidia_key, _nvidia_model = visits


class _on_bindings:
    """Run a scene on a captured binding, then put back whatever is bound now."""

    def __init__(self, snap: dict[str, Any]):
        self.snap = snap

    def __enter__(self) -> "_on_bindings":
        _apply_bindings(self.snap)
        return self

    def __exit__(self, *_exc) -> bool:
        _apply_bindings(_binding_snapshot())
        return False


def maybe_start_family(*, owner_id: str | None = None, now: float | None = None,
                       visible: list[str] | None = None) -> bool:
    """Start one house exchange in the background; a request never waits for it."""
    global _family_inflight, _family_retry_at, _family_idle
    with _family_lock:
        if _family_inflight or time.monotonic() < _family_retry_at:
            return False
        pick = family_pick(owner_id=owner_id, now=now, visible=visible)
        if not pick.get("ok"):
            _family_idle = {"reason": str(pick.get("reason") or ""), "at": time.time()}
            return False
        _family_idle = None
        _family_inflight = True
        bindings = _binding_snapshot()

    def work() -> None:
        global _family_inflight, _family_retry_at
        try:
            root = bindings.get("state")
            if root is not None and not Path(root).is_dir():
                return  # its root is gone: record nothing instead of recreating it
            with _on_bindings(bindings):
                out = family_turn(owner_id=owner_id, now=now, visible=visible,
                                  bindings=bindings)
            if not out.get("ok") or out.get("skipped"):
                with _family_lock:
                    _family_retry_at = time.monotonic() + _family_retry_s
                    _family_idle = {"reason": "turn:" + str(out.get("reason") or "skipped"),
                                    "at": time.time()}
        except Exception:
            log.info("self-started family exchange failed", exc_info=True)
            with _family_lock:
                _family_retry_at = time.monotonic() + _family_retry_s
                _family_idle = {"reason": "turn:error", "at": time.time()}
        finally:
            with _family_lock:
                _family_inflight = False

    threading.Thread(target=work, name="family-visit", daemon=True).start()
    return True


def pulse(*, owner_id: str | None = None,
          visible: list[str] | None = None) -> tuple[int, dict]:
    """Recent true events, as a kind, a sister and a time. Never the activity text.

    The same request is the house's heartbeat: while the HQ is open, one cold
    pair may be put together in the background, never inside this answer.
    """
    try:
        rows = _activity(60)
    except Exception:
        rows = []
    now = time.time()
    events = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "")
        try:
            at = float(row.get("at") or 0)
        except (TypeError, ValueError):
            continue
        if kind in EVENT_SISTER and 0 <= now - at <= PULSE_WINDOW_S:
            events.append({"kind": kind, "sister": EVENT_SISTER[kind], "at": at})
    events.sort(key=lambda item: item["at"], reverse=True)
    out = {"ok": True, "events": events[:PULSE_MAX]}
    try:
        shown = family_recent()
        if shown:
            # The pair's own earned word travels with the visit the house starts,
            # so the panel paints it whichever scheduler brought them together.
            marker = _bond_marker(str(shown.get("host") or ""), str(shown.get("visitor") or ""), owner_id)
            if marker:
                shown = dict(shown, bond=marker)
            out["family"] = shown
    except Exception:
        log.info("family view unavailable", exc_info=True)
    try:
        if maybe_start_family(owner_id=owner_id, visible=visible):
            out["family_started"] = True
        elif _family_idle:
            out["family_wait"] = _family_idle.get("reason") or ""
    except Exception:
        log.info("family tick skipped", exc_info=True)
    return 200, out


def _show_keys(query: Any) -> list[str] | None:
    """The chips the open tab has mounted; ``None`` when it did not say."""
    value = query.get("show") if isinstance(query, dict) else None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    return [part.strip().lower() for part in str(value).split(",") if part.strip()]


def http_get(query: Any, *, owner_id: str | None = None) -> tuple[int, dict]:
    if _one(query, "pulse") == "1":
        return pulse(owner_id=owner_id, visible=_show_keys(query))
    return recent(_one(query, "host"), _one(query, "visitor"), owner_id=owner_id)


def http_post(data: Any, *, owner_id: str | None = None) -> tuple[int, dict]:
    return record(data, owner_id=owner_id)
