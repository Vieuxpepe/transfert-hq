"""Else ↔ Transferania sister integration: dialogue log, awareness, react, prefs.

Memories stay partitioned (``companion_memory.memory_scope``). This module owns the
shared sister dialogue JSON under ``.hq-ai/sister_dialogue/`` and the read-only
awareness block injected into each sister's prompt assembly.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
from pathlib import Path
from typing import Any

import hq_companion_memory as companion_memory

DIALOGUE_DIR = "sister_dialogue"
DIALOGUE_MAX = 40
TURNS_MAX = 4
LINE_MAX_T = 280
LINE_MAX_E = 160
LINE_MAX = LINE_MAX_T
AMBIENT_COOLDOWN_S = 8 * 60
REACT_COOLDOWN_S = 6 * 60
NUDGE_COOLDOWN_S = 40
OPEN_THREAD_TTL_S = 45 * 60
DIALOGUE_CACHE_TTL_S = 12.0
STORE = ".hq-ai"
PASS_BALL_PCT = 4  # of 10 → ~40% after ambient/event banter

# In-process dialogue cache: (mtime_token, json_text) keyed by owner:device.
# Avoids re-reading the same small JSON on ambient + chat + cue in one burst.
_dialogue_cache: dict[str, tuple[float, str]] = {}
_dialogue_cache_lock = threading.Lock()

HINT_T = (
    "DIALOGUE SŒURS : tu parles à Else, ta sœur plus posée, sur le même HQ. "
    "Une à deux phrases max, ton Transferania (vif, tendre, un peu compétitif sans hostilité). "
    "Naturel, pas un briefing. Le Maître peut écouter. Ne parle pas à sa place. "
    "Ne fusionne pas ses souvenirs avec les tiens."
)
HINT_E = (
    "DIALOGUE SŒURS : tu parles à Transferania, ta sœur plus intense. "
    "Une phrase courte, ton Else (mesuré, lucide, chaleureux). Naturel, comme un aparté. "
    "Le Maître peut écouter. Ne parle pas à sa place. Ne fusionne pas ses souvenirs avec les tiens."
)
REACT_HINT_E = (
    "RÉACTION SŒUR : Transferania vient de parler au Maître. Une courte réaction à elle "
    "(pas au Maître), ton Else. Une phrase. Ne récite pas sa ligne verbatim."
)
REACT_HINT_E_ASIDE = (
    "APARTÉ : tu as entendu Transferania parler au Maître. Une phrase courte AU MAÎTRE "
    "(pas à elle) — clin d'œil, observation ou correction douce, ton Else. "
    "Ne récite pas sa ligne. Ne parle pas à sa place."
)
REACT_HINT_T = (
    "RÉACTION SŒUR : Else vient de parler. Une courte réaction à elle, ton Transferania. "
    "Une phrase. Ne récite pas sa ligne verbatim."
)

# Fallback pool when no view/situation is available.
AMBIENT_SEEDS = (
    "un clin d'œil sur la journée",
    "une taquinerie légère entre sœurs",
    "le silence qui traîne un peu trop",
    "qui a la faveur du Maître aujourd'hui (sans drama)",
    "juste dire bonjour à l'autre",
)

# Named mini-events between Else and Transferania (ambient-only).
# Open threads still win; ~half of free ambients roll an event instead of a situation seed.
EVENT_RECENT_MAX = 6
EVENT_ROLL_NUM = 5  # of 10 → ~50% when no open fil
SISTER_EVENTS = (
    {
        "id": "favor_tease",
        "kind": "compete",
        "label": "faveur",
        "weight": 3,
        "turns": 2,
        "seed": "mini-événement : qui a la faveur du Maître en ce moment — taquinerie légère, sans drama",
    },
    {
        "id": "quiet_check",
        "kind": "care",
        "label": "check-in",
        "weight": 3,
        "turns": 1,
        "seed": "mini-événement : un check-in discret entre sœurs — « t'es là ? »",
    },
    {
        "id": "silence_dare",
        "kind": "tease",
        "label": "silence",
        "weight": 2,
        "turns": 2,
        "seed": "mini-événement : le silence a duré trop longtemps — qui casse la glace ?",
    },
    {
        "id": "shared_glance",
        "kind": "observe",
        "label": "regard",
        "weight": 3,
        "turns": 1,
        "seed": "mini-événement : elles croisent le regard du Maître en même temps — aparté bref",
    },
    {
        "id": "soft_invite",
        "kind": "invite",
        "label": "invitation",
        "weight": 2,
        "turns": 2,
        "seed": "mini-événement : une invite douce à parler un peu — pas d'ordre, juste de la présence",
    },
    {
        "id": "forge_spark",
        "kind": "observe",
        "label": "forge",
        "weight": 2,
        "turns": 2,
        "views": ("forge",),
        "seed": "mini-événement : une étincelle à la Forge les fait se regarder — sans jargon",
    },
    {
        "id": "carnet_page",
        "kind": "observe",
        "label": "carnet",
        "weight": 2,
        "turns": 1,
        "views": ("carnet", "lecteur"),
        "seed": "mini-événement : une page encore chaude du Carnet / Lecteur sous leurs yeux",
    },
    {
        "id": "intime_near",
        "kind": "care",
        "label": "proche",
        "weight": 2,
        "turns": 2,
        "views": ("intime",),
        "seed": "mini-événement : trop près en Intime pour feindre — un échange tendre et mesuré",
    },
    {
        "id": "stock_nudge",
        "kind": "tease",
        "label": "stock",
        "weight": 2,
        "turns": 1,
        "views": ("inventaire", "projets", "fichiers"),
        "seed": "mini-événement : un stock / projet / fichier qui traine — taquinerie légère",
    },
    {
        "id": "night_whisper",
        "kind": "care",
        "label": "nuit",
        "weight": 2,
        "turns": 1,
        "hours": ("nuit profonde", "soir"),
        "seed": "mini-événement : le HQ est calme — murmure de sœurs, rien d'urgent",
    },
    {
        "id": "morning_nudge",
        "kind": "tease",
        "label": "matin",
        "weight": 2,
        "turns": 1,
        "hours": ("matin",),
        "seed": "mini-événement : le matin au HQ — qui réveille l'autre en douceur ?",
    },
    {
        "id": "calendar_loom",
        "kind": "observe",
        "label": "date",
        "weight": 1,
        "turns": 1,
        "views": ("calendrier", "accueil"),
        "seed": "mini-événement : une date qui plane sur le calendrier — allusion légère, sans inventer",
    },
)

EVENT_HINT = (
    "ÉVÉNEMENT LÉGER ENTRE SŒURS : c'est un mini-événement partagé (pas un script, pas un ordre). "
    "Réagis naturellement dans ton ton. Une seule allusion suffit."
)

# Soft Master nudges (no model) — presence only; escalate → 1-turn ambient.
NUDGE_SEEDS = (
    "le Maître vient de les pousser un peu l'une vers l'autre — échange bref, naturel",
    "un coup de pouce du Maître : elles se regardent, sans forcer",
    "le Maître attire leur attention mutuelle — une phrase chacune max",
)
SOFT_NUDGE_PEEKS = {
    "else": (
        "Un clin d'œil vers Transferania.",
        "Elle note sa sœur du coin de l'œil.",
        "Else incline à peine la tête — Transferania est dans le cadre.",
    ),
    "transferania": (
        "Elle jette un regard vif vers Else.",
        "Transferania penche vers sa sœur — juste assez.",
        "Un sourire de côté, destinataire : Else.",
    ),
}

VIEW_SITUATIONS = {
    "accueil": (
        "le calme de l'accueil sous leurs yeux",
        "le Maître qui traîne sur l'accueil sans rien lancer",
        "l'accueil trop propre, ça démange",
    ),
    "forge": (
        "la Forge ouverte — étincelles et impatience",
        "un stock ou un projet qui traine à la Forge",
        "la chaleur de la Forge sans jargon",
    ),
    "carnet": (
        "une page du Carnet encore chaude",
        "le Carnet ouvert, le silence autour",
        "une note floue du Carnet, sans inventer le texte",
    ),
    "lecteur": (
        "le Lecteur le soir, lumière basse",
        "une pause lecture partagée du regard",
    ),
    "intime": (
        "le face-à-face Intime, trop près pour feindre",
        "le silence un peu chargé en Intime",
    ),
    "fichiers": (
        "des fichiers ouverts, rien de catastrophique",
        "le Maître qui fouille — elles le voient",
    ),
    "projets": (
        "un projet qui avance trop lentement",
        "la liste des projets sous leurs yeux",
    ),
    "inventaire": (
        "l'inventaire un peu désordonné",
        "un stock bas qui mérite une taquinerie",
    ),
    "calendrier": (
        "le calendrier et ce qui approche",
        "une date qui plane sans être nommée",
    ),
}


def _ai():
    import hq_ai as ai
    return ai


def _root() -> Path:
    ai = _ai()
    return Path(ai._cb["root"])


def _now() -> float:
    return _ai()._now()


def _atomic_write_text(path: Path, text: str) -> None:
    _ai()._atomic_write_text(path, text)


def dialogue_path(device_id: str) -> Path:
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    base = _root() / STORE / DIALOGUE_DIR
    if companion_memory.current_owner() != "admin":
        base = base / "owners" / hashlib.sha256(companion_memory.current_owner().encode()).hexdigest()[:32]
    return base / f"{did}.json"


def _dialogue_cache_key(device_id: str) -> str:
    # Include store root so tests (and multi-root binds) never share stale blobs.
    return str(_root()) + ":" + companion_memory.current_owner() + ":" + str(device_id)


def _normalize_dialogue(data: dict) -> dict:
    data.setdefault("topic", "")
    data.setdefault("last_ambient_at", 0.0)
    data.setdefault("last_react_at", 0.0)
    data.setdefault("open_thread", "")
    data.setdefault("open_thread_until", 0.0)
    data.setdefault("last_speaker", "")
    data.setdefault("last_event_id", "")
    data.setdefault("last_nudge_at", 0.0)
    ids = data.get("recent_event_ids")
    if not isinstance(ids, list):
        data["recent_event_ids"] = []
    else:
        data["recent_event_ids"] = [str(x)[:48] for x in ids if x][-EVENT_RECENT_MAX:]
    return data


def empty_dialogue() -> dict:
    return {
        "v": 1,
        "topic": "",
        "messages": [],
        "last_ambient_at": 0.0,
        "last_react_at": 0.0,
        "open_thread": "",
        "open_thread_until": 0.0,
        "last_speaker": "",
        "last_event_id": "",
        "recent_event_ids": [],
        "last_nudge_at": 0.0,
    }


def _cache_put(device_id: str, payload: dict) -> None:
    raw = json.dumps(payload, ensure_ascii=False)
    with _dialogue_cache_lock:
        _dialogue_cache[_dialogue_cache_key(device_id)] = (_now(), raw)


def _cache_get(device_id: str) -> dict | None:
    key = _dialogue_cache_key(device_id)
    with _dialogue_cache_lock:
        hit = _dialogue_cache.get(key)
        if not hit:
            return None
        ts, raw = hit
        if (_now() - ts) > DIALOGUE_CACHE_TTL_S:
            _dialogue_cache.pop(key, None)
            return None
        raw_copy = raw
    try:
        data = json.loads(raw_copy)
    except ValueError:
        return None
    if isinstance(data, dict) and data.get("v") == 1 and isinstance(data.get("messages"), list):
        return _normalize_dialogue(data)
    return None


def _cache_clear(device_id: str | None = None) -> None:
    with _dialogue_cache_lock:
        if device_id is None:
            _dialogue_cache.clear()
            return
        _dialogue_cache.pop(_dialogue_cache_key(device_id), None)


def load_dialogue(device_id: str) -> dict:
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    cached = _cache_get(did)
    if cached is not None:
        return cached
    p = dialogue_path(did)
    try:
        if not p.is_file():
            empty = empty_dialogue()
            _cache_put(did, empty)
            return empty_dialogue()
        data = json.loads(p.read_text("utf-8"))
        if isinstance(data, dict) and data.get("v") == 1 and isinstance(data.get("messages"), list):
            norm = _normalize_dialogue(data)
            _cache_put(did, norm)
            # Fresh clone so callers can mutate without poisoning the cache blob.
            return json.loads(json.dumps(norm, ensure_ascii=False))
    except (OSError, ValueError):
        pass
    empty = empty_dialogue()
    _cache_put(did, empty)
    return empty_dialogue()


def save_dialogue(data: dict, device_id: str) -> None:
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    p = dialogue_path(did)
    p.parent.mkdir(parents=True, exist_ok=True)
    rows = [m for m in (data.get("messages") or []) if isinstance(m, dict)][-DIALOGUE_MAX:]

    def _f(key: str) -> float:
        try:
            return float(data.get(key) or 0.0)
        except (TypeError, ValueError):
            return 0.0

    recent_ids = data.get("recent_event_ids")
    if not isinstance(recent_ids, list):
        recent_ids = []
    payload = {
        "v": 1,
        "topic": str(data.get("topic") or "")[:200],
        "messages": rows,
        "last_ambient_at": _f("last_ambient_at"),
        "last_react_at": _f("last_react_at"),
        "open_thread": str(data.get("open_thread") or "")[:200],
        "open_thread_until": _f("open_thread_until"),
        "last_speaker": str(data.get("last_speaker") or "")[:24],
        "last_event_id": str(data.get("last_event_id") or "")[:48],
        "recent_event_ids": [str(x)[:48] for x in recent_ids if x][-EVENT_RECENT_MAX:],
        "last_nudge_at": _f("last_nudge_at"),
    }
    _atomic_write_text(p, json.dumps(payload, ensure_ascii=False))
    _cache_put(did, payload)


def history(*, device_id: str) -> dict:
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    data = load_dialogue(did)
    return {"ok": True, "device_id": did, "topic": data.get("topic") or "", "messages": data.get("messages") or [],
            "open_thread": _active_open_thread(data)}


def clear(*, device_id: str) -> dict:
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    save_dialogue(empty_dialogue(), did)
    return {"ok": True, "cleared": True, "device_id": did}


def sister_prefs(device_id: str) -> dict:
    prefs = _ai().load_transferania_prefs(device_id)
    return {
        "sister_ambient_enabled": prefs.get("sister_ambient_enabled") is not False,
        "sister_react_enabled": prefs.get("sister_react_enabled") is not False,
    }


def save_sister_prefs(raw: Any, device_id: str) -> dict:
    ai = _ai()
    payload: dict[str, Any] = {}
    if isinstance(raw, dict):
        if "sister_ambient_enabled" in raw:
            payload["sister_ambient_enabled"] = raw.get("sister_ambient_enabled") is not False
        if "sister_react_enabled" in raw:
            payload["sister_react_enabled"] = raw.get("sister_react_enabled") is not False
    prefs = ai.save_transferania_prefs(payload, device_id) if payload else ai.load_transferania_prefs(device_id)
    return {
        "ok": True,
        "device_id": ai.normalize_device_id(device_id),
        "prefs": {
            "sister_ambient_enabled": prefs.get("sister_ambient_enabled") is not False,
            "sister_react_enabled": prefs.get("sister_react_enabled") is not False,
        },
    }


def _active_open_thread(data: dict) -> str:
    thread = str(data.get("open_thread") or "").strip()
    if not thread:
        return ""
    try:
        until = float(data.get("open_thread_until") or 0)
    except (TypeError, ValueError):
        until = 0.0
    if until and _now() > until:
        return ""
    return thread[:200]


def _touch_open_thread(data: dict, topic: str) -> None:
    text = re.sub(r"\s+", " ", str(topic or "").strip())[:200]
    if not text:
        return
    data["open_thread"] = text
    data["open_thread_until"] = _now() + OPEN_THREAD_TTL_S


def _awareness_from_data(data: dict, *, for_character: str) -> str:
    who = str(for_character or "").strip().lower()
    if who not in ("transferania", "else"):
        return ""
    rows = [m for m in (data.get("messages") or []) if isinstance(m, dict) and m.get("speaker") in ("transferania", "else")]
    open_fil = _active_open_thread(data)
    now = _now()
    fresh = []
    for m in rows[-4:]:
        try:
            ts = float(m.get("ts") or 0)
        except (TypeError, ValueError):
            ts = 0.0
        if ts and (now - ts) <= OPEN_THREAD_TTL_S:
            fresh.append(m)
    if not fresh and not open_fil:
        return ""
    lines = []
    for m in fresh:
        label = "Transferania" if m.get("speaker") == "transferania" else "Else"
        text = re.sub(r"\s+", " ", str(m.get("text") or "").strip())[:180]
        if text:
            lines.append(f"- {label}: « {text} »")
    if not lines and not open_fil:
        return ""
    other = "Else" if who == "transferania" else "Transferania"
    parts = [f"SŒUR PRÉSENTE ({other} sur le même HQ — échange loggé, pas une mémoire fusionnée) :"]
    if open_fil:
        parts.append(f"Fil ouvert entre sœurs (continuité légère) : {open_fil}")
    if lines:
        parts.extend(lines)
    parts.append("Tu peux y faire allusion une fois si naturel; n'invente pas d'autre dialogue privé.")
    return "\n".join(parts)


def awareness_block(device_id: str, *, for_character: str, data: dict | None = None) -> str:
    """Read-only sister context for prompt injection. Never merges memory stores."""
    if data is None:
        data = load_dialogue(device_id)
    return _awareness_from_data(data, for_character=for_character)


def status_snapshot(device_id: str | None) -> dict:
    out = {
        "name": "Else",
        "sister_name": "Transferania",
        "ambient_enabled": True,
        "react_enabled": True,
        "last_ambient_at": None,
        "messages": 0,
        "topic": "",
        "open_thread": "",
        "last_event_id": None,
    }
    if not device_id:
        return out
    try:
        ai = _ai()
        did = ai.normalize_device_id(device_id)
        prefs = sister_prefs(did)
        data = load_dialogue(did)
        out.update({
            "ambient_enabled": prefs["sister_ambient_enabled"],
            "react_enabled": prefs["sister_react_enabled"],
            "last_ambient_at": data.get("last_ambient_at") or None,
            "messages": len([m for m in (data.get("messages") or []) if isinstance(m, dict) and m.get("speaker") in ("transferania", "else")]),
            "topic": str(data.get("topic") or "")[:120],
            "open_thread": _active_open_thread(data),
            "last_event_id": str(data.get("last_event_id") or "")[:48] or None,
            "device_id": did,
        })
    except Exception:
        pass
    return out


def _transcript(rows: list) -> str:
    lines = []
    for m in rows[-12:]:
        if not isinstance(m, dict):
            continue
        who = str(m.get("speaker") or "")
        if who in ("seed",):
            continue
        label = "Transferania" if who == "transferania" else "Else" if who == "else" else "Maître"
        text = re.sub(r"\s+", " ", str(m.get("text") or "").strip())
        if text:
            lines.append(f"{label}: {text}")
    return "\n".join(lines)


def _hour_bucket() -> str:
    try:
        from datetime import datetime
        h = datetime.fromtimestamp(_now()).hour
    except (OSError, OverflowError, ValueError):
        h = int(_now()) % 24
    if h >= 23 or h < 5:
        return "nuit profonde"
    if h < 10:
        return "matin"
    if h < 17:
        return "journée"
    return "soir"


def _situation_seed(view: str, digest: str = "", data: dict | None = None) -> str:
    """Prefer an open fil, then a view/hour situation, then generic pool."""
    data = data or {}
    open_fil = _active_open_thread(data)
    if open_fil:
        return "reprendre le fil : " + open_fil
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    hour = _hour_bucket()
    pool = list(VIEW_SITUATIONS.get(v) or ())
    dig = re.sub(r"\s+", " ", str(digest or "").strip())[:80]
    if dig:
        pool = list(pool) + [f"ce qui se passe sous leurs yeux ({dig})"]
    pool = list(pool) + [f"le rythme du HQ en ce {hour}"]
    recent = []
    for m in reversed(data.get("messages") or []):
        if isinstance(m, dict) and m.get("speaker") == "seed":
            recent.append(str(m.get("text") or ""))
        if len(recent) >= 4:
            break
    choices = [s for s in pool if s not in recent] or pool or list(AMBIENT_SEEDS)
    idx = int(_now() // 17) % len(choices)
    return choices[idx]


def _event_public(ev: dict | None) -> dict | None:
    if not isinstance(ev, dict) or not ev.get("id"):
        return None
    return {
        "id": str(ev.get("id") or "")[:48],
        "kind": str(ev.get("kind") or "observe")[:24],
        "label": str(ev.get("label") or "")[:48],
    }


def _event_roll() -> bool:
    """~50% of free ambients become a named sister event."""
    return (int(_now() * 1000) // 29) % 10 < EVENT_ROLL_NUM


def _event_eligible(
    ev: dict,
    *,
    view: str,
    hour: str,
    recent_ids: list[str],
    ignore_hours: bool = False,
    ignore_views: bool = False,
) -> bool:
    eid = str(ev.get("id") or "")
    if not eid or eid in recent_ids:
        return False
    views = ev.get("views")
    if views and not ignore_views and view not in views:
        return False
    hours = ev.get("hours")
    if hours and not ignore_hours and hour not in hours:
        return False
    return True


def _weighted_event_pick(pool: list[dict]) -> dict | None:
    if not pool:
        return None
    total = 0
    weights: list[int] = []
    for ev in pool:
        try:
            w = max(1, int(ev.get("weight") or 1))
        except (TypeError, ValueError):
            w = 1
        weights.append(w)
        total += w
    if total <= 0:
        return pool[0]
    # Deterministic-ish pick from wall clock (same style as ambient turn bias).
    ticket = (int(_now() * 1000) // 31) % total
    acc = 0
    for ev, w in zip(pool, weights):
        acc += w
        if ticket < acc:
            return ev
    return pool[-1]


def pick_sister_event(data: dict, *, view: str = "accueil", force: bool = False) -> dict | None:
    """Pick a named Else↔Transferania event, or None.

    Skips when an open thread is active. ``force`` bypasses the roll (tests).
    """
    if _active_open_thread(data):
        return None
    if not force and not _event_roll():
        return None
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    hour = _hour_bucket()
    recent = [str(x) for x in (data.get("recent_event_ids") or []) if x][-EVENT_RECENT_MAX:]
    pool = [ev for ev in SISTER_EVENTS if _event_eligible(ev, view=v, hour=hour, recent_ids=recent)]
    if not pool:
        pool = [
            ev for ev in SISTER_EVENTS
            if _event_eligible(ev, view=v, hour=hour, recent_ids=recent, ignore_hours=True)
        ]
    if not pool:
        pool = [
            ev for ev in SISTER_EVENTS
            if _event_eligible(
                ev, view=v, hour=hour, recent_ids=recent, ignore_hours=True, ignore_views=True,
            )
            and not ev.get("views")
        ]
    return _weighted_event_pick(pool)


def _remember_event(data: dict, event: dict | None) -> None:
    if not isinstance(event, dict):
        return
    eid = str(event.get("id") or "").strip()[:48]
    if not eid:
        return
    data["last_event_id"] = eid
    recent = [str(x) for x in (data.get("recent_event_ids") or []) if x and str(x) != eid]
    recent.append(eid)
    data["recent_event_ids"] = recent[-EVENT_RECENT_MAX:]


def _pick_ambient_seed(data: dict, *, view: str = "accueil", digest: str = "") -> tuple[str, dict | None]:
    """Return ``(seed, event_or_none)``. Open fil wins; else maybe a named event."""
    open_fil = _active_open_thread(data)
    if open_fil:
        return "reprendre le fil : " + open_fil, None
    event = pick_sister_event(data, view=view)
    if event:
        return str(event.get("seed") or "").strip()[:200], event
    return _situation_seed(view, digest, data), None


def _ambient_turn_count(requested: int, *, event: dict | None = None) -> int:
    """Bias ambient to a single line (~70%); two turns stay the minority.

    Named events may hint 1 or 2 turns; compete/invite prefer dialogue.
    """
    if isinstance(event, dict):
        try:
            hinted = int(event.get("turns") or 0)
        except (TypeError, ValueError):
            hinted = 0
        if hinted in (1, 2):
            return hinted
    n = max(1, min(2, int(requested or 1)))
    if n == 1:
        return 1
    # Keep 2 only ~30% of the time when the client asked for 2.
    return 2 if (int(_now() * 1000) // 13) % 10 < 3 else 1


def _next_speaker(data: dict, *, ambient: bool) -> str:
    last_sis = next(
        (m for m in reversed(data.get("messages") or []) if isinstance(m, dict) and m.get("speaker") in ("transferania", "else")),
        None,
    )
    if not last_sis:
        stored = str(data.get("last_speaker") or "").strip().lower()
        if stored in ("transferania", "else"):
            # Quiet bias: often let the other open.
            return "else" if stored == "transferania" else "transferania"
        return "transferania"
    other = "else" if last_sis.get("speaker") == "transferania" else "transferania"
    if ambient:
        # ~80% alternate (last stays quiet); ~20% same sister continues (asymmetry).
        if (int(_now() * 1000) // 19) % 10 < 2:
            return str(last_sis.get("speaker") or other)
    return other


def _line_cap(speaker: str) -> int:
    return LINE_MAX_E if speaker == "else" else LINE_MAX_T


def _generate_line(
    *,
    speaker: str,
    did: str,
    view: str,
    transcript: str,
    topic: str,
    nsfw: bool,
    ambient: bool,
    react: bool = False,
    trigger: str = "",
    aside: bool = False,
    aware: str | None = None,
    data: dict | None = None,
    event: dict | None = None,
) -> str:
    ai = _ai()
    who_char = "else" if speaker == "else" else "transferania"
    if aware is None:
        aware = _awareness_from_data(data, for_character=who_char) if data is not None else awareness_block(did, for_character=who_char)
    if speaker == "else":
        with companion_memory.memory_scope("else"):
            system = ai.build_sister_system("else", nsfw=nsfw, view=view, device_id=did)
            if react and aside:
                system += "\n" + REACT_HINT_E_ASIDE
            else:
                system += "\n" + (REACT_HINT_E if react else HINT_E)
            if ambient and event and not react:
                system += "\n" + EVENT_HINT
            if aware:
                system += "\n\n" + aware
    else:
        with companion_memory.memory_scope("transferania"):
            system = ai.build_sister_system("transferania", nsfw=nsfw, view=view, device_id=did)
            system += "\n" + (REACT_HINT_T if react else HINT_T)
            if ambient and event and not react:
                system += "\n" + EVENT_HINT
            if aware:
                system += "\n\n" + aware
    if react:
        if aside and speaker == "else":
            prompt = f"CE QU'ELLE VIENT DE DIRE AU MAÎTRE\n{trigger[:400]}\n\nRéponds au Maître en une phrase courte."
        else:
            prompt = f"LIGNE DE SA SŒUR\n{trigger[:400]}\n\nRéagis en une phrase."
    else:
        prompt = "TRANSCRIPT SŒURS (récent)\n" + (transcript or "(début)")
        if topic:
            if ambient:
                label = "ÉVÉNEMENT PARTAGÉ" if event else "SITUATION PARTAGÉE"
                prompt += f"\n\n{label} (inspiration légère, pas un ordre) : " + topic[:200]
            else:
                prompt += "\n\nSUJET DU MAÎTRE : " + topic[:200]
        elif ambient:
            prompt += "\n\nParlez de ce qui vous passe par la tête — rien d'inventé sur le HQ hors contexte."
        if speaker == "else":
            prompt += "\n\nRéponds maintenant en une phrase courte, à ta sœur."
        else:
            prompt += "\n\nRéponds maintenant en une ou deux phrases, à ta sœur."
    system, contents, _ = ai.build_companion_context("chat", system, prompt)
    max_tok = 120 if speaker == "else" else (180 if react else 220)
    text, _ = ai.generate(
        ai.CHAT_CHAIN if not nsfw else ai.NSFW_CHAIN,
        system,
        contents,
        temperature=0.9 if react else (0.92 if ambient else (0.86 if not nsfw else 0.92)),
        transferania=True,
        max_tokens=max_tok,
        nsfw=nsfw,
    )
    return re.sub(r"\s+", " ", (text or "").strip())[:_line_cap(speaker)] or "…"


def exchange(topic: Any = "", *, turns: Any = 2, view: Any = "accueil", nsfw: bool = False,
             ambient: bool = False, digest: Any = "", signals: Any = None,
             client_ip: Any = None, role: Any = None, device_id: Any = None,
             character: str = "sister") -> dict:
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    if not (ai._api_keys() or [""])[0]:
        raise ai.AiError("Aucune clé : ajoute gemini_api_key dans bridge_config.json puis redémarre le pont", 503, "no_key")
    if not ai.transferania_ok():
        raise ai.AiError("Quota de chat Transferania épuisé pour aujourd'hui", 429, "transferania_quota")
    prefs = sister_prefs(did)
    if ambient and not prefs["sister_ambient_enabled"]:
        return {"ok": True, "skipped": True, "reason": "disabled", "device_id": did, "turns": [], "messages": load_dialogue(did).get("messages") or []}
    use_nsfw = nsfw is True and ai.nsfw_allowed(client_ip, role)
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    try:
        n = int(turns)
    except (TypeError, ValueError):
        n = 2
    seed = re.sub(r"\s+", " ", str(topic or "").strip())[:200]
    dig = re.sub(r"\s+", " ", str(digest or "").strip())[:120]
    data = load_dialogue(did)
    now = _now()
    active_event: dict | None = None
    if ambient:
        last = float(data.get("last_ambient_at") or 0)
        if last and now - last < AMBIENT_COOLDOWN_S:
            wait = int(AMBIENT_COOLDOWN_S - (now - last))
            return {"ok": True, "skipped": True, "reason": "cooldown", "retry_after": wait,
                    "device_id": did, "turns": [], "messages": data.get("messages") or [],
                    "topic": data.get("topic") or "", "open_thread": _active_open_thread(data)}
        if not seed:
            seed, active_event = _pick_ambient_seed(data, view=v, digest=dig)
        data["topic"] = seed
        seed_row: dict[str, Any] = {"speaker": "seed", "text": seed, "ts": now}
        if active_event:
            seed_row["event_id"] = str(active_event.get("id") or "")[:48]
            seed_row["event_kind"] = str(active_event.get("kind") or "")[:24]
            _remember_event(data, active_event)
        data.setdefault("messages", []).append(seed_row)
        data["last_ambient_at"] = now
        _touch_open_thread(data, seed)
        n = _ambient_turn_count(n, event=active_event)
    else:
        n = max(1, min(TURNS_MAX, n))
        if seed:
            data["topic"] = seed
            data.setdefault("messages", []).append({"speaker": "master", "text": seed, "ts": now})
            _touch_open_thread(data, seed)
    produced: list[dict] = []
    next_speaker = _next_speaker(data, ambient=bool(ambient))
    for _ in range(n):
        if not ai.transferania_ok():
            break
        transcript = _transcript(data.get("messages") or [])
        # Awareness from in-memory dialogue — no extra disk read per turn.
        aware = _awareness_from_data(data, for_character=next_speaker)
        line = _generate_line(
            speaker=next_speaker, did=did, view=v, transcript=transcript,
            topic=str(data.get("topic") or seed), nsfw=use_nsfw, ambient=bool(ambient),
            aware=aware, data=data, event=active_event,
        )
        row = {"speaker": next_speaker, "text": line, "ts": _now()}
        if active_event:
            row["event_id"] = str(active_event.get("id") or "")[:48]
        data.setdefault("messages", []).append(row)
        produced.append(row)
        data["last_speaker"] = next_speaker
        scope = "else" if next_speaker == "else" else "transferania"
        with companion_memory.memory_scope(scope):
            try:
                ai._shared_memory(companion_memory.note_sister_line, next_speaker, line, did)
            except ai.AiError:
                pass
        next_speaker = "else" if next_speaker == "transferania" else "transferania"
    if produced:
        _touch_open_thread(data, str(data.get("topic") or seed))
    save_dialogue(data, did)
    out: dict[str, Any] = {
        "ok": True,
        "ambient": bool(ambient),
        "device_id": did,
        "topic": data.get("topic") or "",
        "open_thread": _active_open_thread(data),
        "turns": produced,
        "messages": data.get("messages") or [],
        "transferania_used": ai.transferania_used(),
        "transferania_per_day": ai.daily_limit("chat"),
    }
    pub = _event_public(active_event)
    if pub:
        out["event"] = pub
    return out


def react(*, trigger: Any = "", speaker: Any = "else", view: Any = "accueil", nsfw: bool = False,
          aside: Any = None, client_ip: Any = None, role: Any = None, device_id: Any = None,
          character: str = "sister") -> dict:
    """One-shot reaction from ``speaker`` to the other sister's line."""
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    prefs = sister_prefs(did)
    if not prefs["sister_react_enabled"]:
        return {"ok": True, "skipped": True, "reason": "disabled", "device_id": did, "turns": []}
    if not (ai._api_keys() or [""])[0]:
        raise ai.AiError("Aucune clé : ajoute gemini_api_key dans bridge_config.json puis redémarre le pont", 503, "no_key")
    if not ai.transferania_ok():
        raise ai.AiError("Quota de chat Transferania épuisé pour aujourd'hui", 429, "transferania_quota")
    who = str(speaker or "else").strip().lower()
    if who not in ("else", "transferania"):
        who = "else"
    text = re.sub(r"\s+", " ", str(trigger or "").strip())[:400]
    if not text:
        data = load_dialogue(did)
        other = "transferania" if who == "else" else "else"
        last = next((m for m in reversed(data.get("messages") or []) if isinstance(m, dict) and m.get("speaker") == other), None)
        text = str((last or {}).get("text") or "").strip()
    if not text:
        return {"ok": True, "skipped": True, "reason": "no_trigger", "device_id": did, "turns": []}
    data = load_dialogue(did)
    now = _now()
    last_r = float(data.get("last_react_at") or 0)
    if last_r and now - last_r < REACT_COOLDOWN_S:
        return {"ok": True, "skipped": True, "reason": "cooldown",
                "retry_after": int(REACT_COOLDOWN_S - (now - last_r)), "device_id": did, "turns": []}
    use_nsfw = nsfw is True and ai.nsfw_allowed(client_ip, role)
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    # Else ~40% asides to the Master; Transferania always addresses her sister.
    if aside is None:
        use_aside = who == "else" and ((int(now * 1000) // 23) % 10) < 4
    else:
        use_aside = aside is True and who == "else"
    aware = _awareness_from_data(data, for_character=who)
    line = _generate_line(
        speaker=who, did=did, view=v, transcript="", topic="", nsfw=use_nsfw,
        ambient=False, react=True, trigger=text, aside=bool(use_aside),
        aware=aware, data=data,
    )
    row = {"speaker": who, "text": line, "ts": now, "kind": "react", "aside": bool(use_aside)}
    data.setdefault("messages", []).append(row)
    data["last_react_at"] = now
    data["last_speaker"] = who
    save_dialogue(data, did)
    scope = "else" if who == "else" else "transferania"
    with companion_memory.memory_scope(scope):
        try:
            ai._shared_memory(companion_memory.note_sister_line, who, line, did)
        except ai.AiError:
            pass
    return {
        "ok": True,
        "react": True,
        "aside": bool(use_aside),
        "device_id": did,
        "turns": [row],
        "messages": data.get("messages") or [],
        "transferania_used": ai.transferania_used(),
        "transferania_per_day": ai.daily_limit("chat"),
    }


def maybe_sister_cue(*, idle: bool = False) -> bool:
    """Cheap deterministic-ish cue (~5%) for ambient clients; no I/O."""
    if not idle:
        return False
    return (int(_now() * 1000) // 17) % 20 == 0


def should_pass_ball(*, ambient: bool = False, turns: Any = None, event: Any = None) -> bool:
    """After sister banter, sometimes let the quieter sister answer once more."""
    if not ambient:
        return False
    rows = [t for t in (turns or []) if isinstance(t, dict) and t.get("speaker") in ("else", "transferania") and t.get("text")]
    if not rows:
        return False
    # Named events pass a bit more often; plain ambient stays lighter.
    threshold = PASS_BALL_PCT + (2 if event else 0)
    return (int(_now() * 1000) // 37) % 10 < min(7, threshold)


def _soft_nudge_peek(toward: str) -> str:
    who = toward if toward in SOFT_NUDGE_PEEKS else "else"
    pool = SOFT_NUDGE_PEEKS.get(who) or SOFT_NUDGE_PEEKS["else"]
    idx = int(_now() // 11) % len(pool)
    return pool[idx]


def nudge(
    *,
    toward: Any = "else",
    escalate: bool = False,
    view: Any = "accueil",
    digest: Any = "",
    nsfw: bool = False,
    client_ip: Any = None,
    role: Any = None,
    device_id: Any = None,
) -> dict:
    """Master nudge: soft cross-glance (no model), or escalate into a 1-turn ambient."""
    ai = _ai()
    did = ai.normalize_device_id(device_id)
    prefs = sister_prefs(did)
    who = str(toward or "else").strip().lower()
    if who not in ("else", "transferania"):
        who = "else"
    other = "transferania" if who == "else" else "else"
    data = load_dialogue(did)
    now = _now()
    last_n = float(data.get("last_nudge_at") or 0)
    # Soft nudges cool down; a quick escalate follow-up (≤12s) is allowed.
    if last_n and now - last_n < NUDGE_COOLDOWN_S:
        if not (escalate and (now - last_n) <= 12):
            return {
                "ok": True,
                "skipped": True,
                "reason": "cooldown",
                "retry_after": int(NUDGE_COOLDOWN_S - (now - last_n)),
                "device_id": did,
                "glance": {"from": who, "to": other},
            }
    peek_text = _soft_nudge_peek(who)
    data["last_nudge_at"] = now
    data.setdefault("messages", []).append({
        "speaker": "seed",
        "text": f"nudge → {who}: {peek_text}",
        "ts": now,
        "kind": "nudge",
    })
    save_dialogue(data, did)
    soft = {
        "ok": True,
        "nudge": True,
        "soft": True,
        "device_id": did,
        "toward": who,
        "glance": {"from": who, "to": other},
        "peek": {"speaker": who, "text": peek_text},
        "escalate": False,
    }
    if not escalate:
        return soft
    if not prefs["sister_ambient_enabled"]:
        soft["escalate_skipped"] = "disabled"
        return soft
    seed = NUDGE_SEEDS[int(now // 19) % len(NUDGE_SEEDS)]
    try:
        out = exchange(
            seed,
            turns=1,
            view=view,
            nsfw=nsfw,
            ambient=True,
            digest=digest,
            client_ip=client_ip,
            role=role,
            device_id=did,
            character="sister",
        )
    except Exception:
        soft["escalate_skipped"] = "error"
        return soft
    if out.get("skipped"):
        soft["escalate_skipped"] = out.get("reason") or "skipped"
        soft["retry_after"] = out.get("retry_after")
        return soft
    out["nudge"] = True
    out["soft"] = False
    out["escalate"] = True
    out["toward"] = who
    out["glance"] = {"from": who, "to": other}
    out.setdefault("peek", {"speaker": who, "text": peek_text})
    return out


_SISTERLY_RE = re.compile(
    r"\b(else|sœur|soeur|sœurs|soeurs|sister|transferania|transferina)\b",
    re.I,
)


def should_sister_cue(
    *,
    idle: bool = False,
    line: str = "",
    nsfw: bool = False,
    fallback: bool = False,
    has_event: bool = False,
    device_id: str | None = None,
) -> bool:
    """Quality gate for ambient → Else react (probability + addressability)."""
    if not idle or fallback or nsfw or has_event:
        return False
    text = re.sub(r"\s+", " ", str(line or "").strip())
    if len(text) < 12:
        return False
    if device_id:
        prefs = sister_prefs(device_id)
        if not prefs.get("sister_react_enabled"):
            return False
        data = load_dialogue(device_id)
        try:
            last_r = float(data.get("last_react_at") or 0)
        except (TypeError, ValueError):
            last_r = 0.0
        if last_r and (_now() - last_r) < REACT_COOLDOWN_S:
            return False
    # Sisterly mention: allow when idle/addressable; otherwise rarer ~5%.
    if _SISTERLY_RE.search(text):
        return True
    return maybe_sister_cue(idle=True)


def http_post(data: dict, *, client_ip: Any = None, role: Any = None) -> dict:
    ai = _ai()
    did = ai.device_id_from(data)
    op = str(data.get("op") or "exchange").strip().lower()
    if op in ("clear", "reset"):
        return clear(device_id=did)
    if op in ("history", "get", "load"):
        return history(device_id=did)
    if op in ("prefs", "settings"):
        if data.get("save") is True or isinstance(data.get("prefs"), dict):
            return save_sister_prefs(data.get("prefs") if isinstance(data.get("prefs"), dict) else data, did)
        return {"ok": True, "device_id": did, "prefs": sister_prefs(did)}
    if op == "react":
        return ai.companion_request("chat")(react)(
            trigger=data.get("trigger") or data.get("text") or data.get("message") or "",
            speaker=data.get("speaker") or "else",
            view=data.get("view"),
            nsfw=data.get("nsfw") is True,
            aside=data.get("aside"),
            client_ip=client_ip,
            role=role,
            device_id=did,
            character="sister",
        )
    if op == "nudge":
        escalate = data.get("escalate") is True
        toward = data.get("toward") or data.get("to") or data.get("speaker") or "else"
        if escalate:
            return ai.companion_request("chat")(nudge)(
                toward=toward,
                escalate=True,
                view=data.get("view"),
                digest=data.get("digest") or "",
                nsfw=data.get("nsfw") is True,
                client_ip=client_ip,
                role=role,
                device_id=did,
            )
        return nudge(
            toward=toward,
            escalate=False,
            view=data.get("view"),
            digest=data.get("digest") or "",
            device_id=did,
        )
    if op in ("exchange", "talk", "send", "ambient"):
        ambient = op == "ambient" or data.get("ambient") is True
        return ai.companion_request("chat")(exchange)(
            data.get("topic") or data.get("message") or data.get("text") or "",
            turns=data.get("turns", 2),
            view=data.get("view"),
            nsfw=data.get("nsfw") is True,
            ambient=ambient,
            digest=data.get("digest") or "",
            signals=data.get("signals"),
            client_ip=client_ip,
            role=role,
            device_id=did,
            character="sister",
        )
    raise ai.AiError("Opération sœurs inconnue (op: exchange, ambient, react, nudge, history, prefs, clear)")
