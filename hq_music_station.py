"""DJ Musica as a station: a weekly programme grid, « previously on Musica » and what she knows about his taste.

The grid is a short list of slots (a show kind, days, a time). The bridge tick airs a due slot the same way the
morning show does (on the PC speakers when the station is on, otherwise a notification and a « ready » entry the
page can launch). ``view`` is the compact payload the Accueil card and the Musique tab read; it never calls the
model and never touches Spotify. Shared state (the show, the lock, drops) stays in ``hq_music_dj``, reached lazily
so this module has no import cycle.
"""

from __future__ import annotations

import hashlib
import time
from datetime import date, datetime, timedelta
from typing import Any

import hq_music as music

STATION_FILE = "station.json"
MAX_SLOTS = 14
READY_TTL = 3 * 3600  # a « ready » show that nobody launched is forgotten after three hours
WINDOW_MIN = 45       # a slot stays due for 45 minutes after its time (same as the morning show)

# kind -> (label, icon). The first four are real show kinds of hq_music_dj.start().
KINDS: dict[str, tuple[str, str]] = {
    "dj": ("Émission libre", "🎧"),
    "matinale": ("Matinale", "🌅"),
    "focus": ("Session focus", "🎯"),
    "recap": ("Récap", "📊"),
    "duel": ("Soirée duel", "⚔️"),
    "daily": ("Défi du jour", "🔥"),
    "tournament": ("Tournoi", "🏆"),
}
SHOW_KINDS = ("dj", "matinale", "focus", "recap")
DAY_NAMES = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")


class StationError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _dj():
    import hq_music_dj as dj
    return dj


def _load() -> dict[str, Any]:
    raw = music._load(STATION_FILE, {})
    return raw if isinstance(raw, dict) else {}


def _save(state: dict[str, Any]) -> None:
    music._write(STATION_FILE, state)


# ---- the grid ------------------------------------------------------------------------------------------------------

def suggested() -> list[dict[str, Any]]:
    """A programme worth airing, offered (never applied on its own). The morning show and the Sunday recap keep
    their own switches in the settings and are not repeated here."""
    return [
        {"label": "Défi du jour", "kind": "daily", "days": [0, 1, 2, 3, 4, 5, 6], "time": "19:00", "enabled": True},
        {"label": "Soirée duel", "kind": "duel", "days": [4], "time": "20:00", "enabled": True},
        {"label": "Samedi en musique", "kind": "dj", "days": [5], "time": "11:00", "enabled": True},
        {"label": "Tournoi du dimanche", "kind": "tournament", "days": [6], "time": "15:00", "enabled": True},
    ]


def _clean_slot(raw: Any, taken: set[str]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise StationError("Créneau invalide")
    kind = raw.get("kind")
    if kind not in KINDS:
        raise StationError("Type d’émission invalide")
    time_text = raw.get("time")
    try:
        hh, mm = (int(x) for x in str(time_text).split(":"))
        if not (0 <= hh < 24 and 0 <= mm < 60) or len(str(time_text)) != 5:
            raise ValueError
    except ValueError:
        raise StationError("Heure invalide (HH:MM)") from None
    days = raw.get("days")
    if not isinstance(days, list) or not days or any(isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= 6 for d in days):
        raise StationError("Jours invalides (0 = lundi … 6 = dimanche)")
    label = " ".join(str(raw.get("label") or KINDS[kind][0]).split())[:40] or KINDS[kind][0]
    slot_id = raw.get("id") if isinstance(raw.get("id"), str) and raw["id"].isalnum() and len(raw["id"]) <= 16 else ""
    if not slot_id or slot_id in taken:
        slot_id = hashlib.sha1(f"{time.time()}{label}{len(taken)}".encode()).hexdigest()[:8]
    taken.add(slot_id)
    return {"id": slot_id, "label": label, "kind": kind, "days": sorted(set(days)), "time": f"{hh:02d}:{mm:02d}",
            "enabled": raw.get("enabled") is not False}


def slots() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    taken: set[str] = set()
    for raw in _load().get("slots") or []:
        try:
            out.append(_clean_slot(raw, taken))
        except StationError:
            continue
    return out[:MAX_SLOTS]


def save_slots(raw_slots: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_slots, list) or len(raw_slots) > MAX_SLOTS:
        raise StationError(f"Au plus {MAX_SLOTS} créneaux")
    taken: set[str] = set()
    clean = [_clean_slot(raw, taken) for raw in raw_slots]
    state = _load()
    state["slots"] = clean
    state["runs"] = {k: v for k, v in (state.get("runs") or {}).items() if k in taken}
    state["ready"] = [r for r in state.get("ready") or [] if r.get("id") in taken]
    _save(state)
    return clean


def apply_suggested() -> list[dict[str, Any]]:
    return save_slots(suggested())


# ---- when things air -----------------------------------------------------------------------------------------------

def _due(slot: dict[str, Any], now: datetime, last: str | None) -> bool:
    if not slot.get("enabled") or last == now.date().isoformat() or now.weekday() not in slot["days"]:
        return False
    hh, mm = (int(x) for x in slot["time"].split(":"))
    start = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    return start <= now < start + timedelta(minutes=WINDOW_MIN)


def _legacy(settings: dict[str, Any]) -> list[dict[str, Any]]:
    """The morning show and the Sunday recap, which keep their switches in the DJ settings."""
    rows = []
    morning = settings.get("morning") or {}
    if morning.get("enabled"):
        rows.append({"id": "matinale", "label": "Matinale", "kind": "matinale", "days": list(morning.get("days") or range(7)),
                     "time": morning.get("time") or "07:30", "enabled": True, "source": "settings"})
    recap = settings.get("recap") or {}
    if recap.get("enabled"):
        rows.append({"id": "recap", "label": "Récap de la semaine", "kind": "recap", "days": [6],
                     "time": recap.get("time") or "18:00", "enabled": True, "source": "settings"})
    return rows


def upcoming(now: datetime | None = None, limit: int = 6, *, settings: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """The next occurrences over the coming week (grid + the two settings shows), soonest first. An occurrence
    already aired today is not listed again."""
    now = now or datetime.now()
    state = _load()
    runs = state.get("runs") or {}
    legacy_runs = _dj()._state().get("last_runs") or {}
    out: list[dict[str, Any]] = []
    for slot in slots() + _legacy(settings if settings is not None else _dj().settings()):
        if not slot["enabled"]:
            continue
        last = runs.get(slot["id"]) if slot.get("source") != "settings" else legacy_runs.get(slot["id"])
        hh, mm = (int(x) for x in slot["time"].split(":"))
        for offset in range(8):
            day = now + timedelta(days=offset)
            if day.weekday() not in slot["days"]:
                continue
            at = day.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if at + timedelta(minutes=WINDOW_MIN) <= now or (offset == 0 and last == now.date().isoformat()):
                continue
            label, icon = KINDS[slot["kind"]]
            out.append({"id": slot["id"], "label": slot["label"], "kind": slot["kind"], "kind_label": label, "icon": icon,
                        "at": at.isoformat(timespec="minutes"), "ts": int(at.timestamp()),
                        "today": at.date() == now.date(), "source": slot.get("source") or "grid"})
            break  # one occurrence per slot is enough for the strip
    return sorted(out, key=lambda r: r["ts"])[:limit]


def tick(now: datetime | None = None) -> None:
    """Bridge hook (called from ``hq_music_dj.tick``): air the first due grid slot. Never raises."""
    try:
        dj = _dj()
        now = now or datetime.now()
        st = dj.settings()
        with dj._lock:
            state = _load()
            runs = state.setdefault("runs", {})
            due = next((s for s in slots() if _due(s, now, runs.get(s["id"]))), None)
            if not due:
                return
            runs[due["id"]] = now.date().isoformat()
            ready = [r for r in state.get("ready") or [] if time.time() - float(r.get("at") or 0) < READY_TTL]
            ready.append({"id": due["id"], "label": due["label"], "kind": due["kind"], "at": time.time()})
            state["ready"] = ready[-6:]
            _save(state)
        if st["station"] and dj._local_device_playing_or_ready():
            try:
                _begin(due["kind"], {})
                _forget_ready(due["id"])
                music.notify("DJ Musica", f"{due['label']} commence sur le PC.")
                return
            except Exception:  # noqa: BLE001 — the notification below still tells him it is ready
                pass
        music.notify("DJ Musica", f"{due['label']} est prête — ouvre Musique.")
    except Exception:  # noqa: BLE001
        pass


def _begin(kind: str, body: dict[str, Any]) -> dict[str, Any]:
    dj = _dj()
    if kind in SHOW_KINDS:
        return dj.start({**body, "show": kind})
    return {"duel": dj.start_duel, "daily": dj.start_daily, "tournament": dj.start_tournament}[kind](body)


def _forget_ready(slot_id: str) -> None:
    state = _load()
    state["ready"] = [r for r in state.get("ready") or [] if r.get("id") != slot_id]
    _save(state)


def launch(slot_id: Any, device_id: Any = None) -> dict[str, Any]:
    """« Lancer » on a ready (or any) grid slot: starts it through the same background preparation as the buttons."""
    slot = next((s for s in slots() if s["id"] == slot_id), None)
    if not slot:
        raise StationError("Créneau introuvable", 404, "not_found")
    _forget_ready(slot["id"])
    body: dict[str, Any] = {"device_id": device_id} if isinstance(device_id, str) else {}
    if slot["kind"] in SHOW_KINDS:
        return _dj().begin("start", {**body, "show": slot["kind"]})
    return _dj().begin(slot["kind"], body)


def dismiss(slot_id: Any) -> dict[str, Any]:
    _forget_ready(str(slot_id))
    return {"ok": True}


# ---- previously on Musica ------------------------------------------------------------------------------------------

def mark_seen() -> dict[str, Any]:
    state = _load()
    state["seen"] = time.time()
    _save(state)
    return {"ok": True}


def previously(now: float | None = None) -> dict[str, Any]:
    """What happened since his last visit, from local data only (a plain sentence, no model call)."""
    import hq_music_dj_archive as archive

    now = now or time.time()
    seen = float(_load().get("seen") or 0)
    dj = _dj()
    state = dj._state()
    items: list[str] = []
    try:
        episodes = [row for row in archive.summary() if row[0] > seen]  # newest first
    except Exception:  # noqa: BLE001
        episodes = []
    if episodes:
        items.append(f"{len(episodes)} show{'s' if len(episodes) > 1 else ''} since: \u201c{episodes[0][1] or 'untitled'}\u201d most recently")
    duels = state.get("duels") or {}
    champion = duels.get("champion")
    if champion and champion.get("name"):
        n = int(champion.get("defenses") or 0)
        items.append(f"{champion['name']} holds the Duel title" + (f" ({n} defence{'s' if n > 1 else ''})" if n else ""))
    fresh_votes = [h for h in duels.get("history") or [] if (h.get("at") or 0) > seen]
    if fresh_votes:
        items.append(f"{len(fresh_votes)} vote{'s' if len(fresh_votes) > 1 else ''} cast")
    bracket = state.get("tournament")
    if bracket and bracket.get("done") and (bracket.get("champion") or {}).get("name"):
        items.append(f"Last tournament: {bracket['champion']['name']} won it")
    daily = dj.daily_view(state)
    if daily["streak"]:
        items.append(f"daily challenge streak: {daily['streak']} day{'s' if daily['streak'] > 1 else ''}" + ("" if daily["done_today"] else " (to play today)"))
    days = int((now - seen) // 86400) if seen else None
    if not items:
        line = "Nothing new since your last visit: the stage is yours." if seen else "Welcome to Musica: start a show, a duel or the daily challenge."
    else:
        line = ("Since your last visit" + (f" ({days} d)" if days else "") + ": " + " · ".join(items) + ".")
    return {"line": line, "items": items, "since_days": days, "first_visit": not seen}


# ---- what she knows about his taste --------------------------------------------------------------------------------

def memory() -> dict[str, Any]:
    """A readable page of what she has learned, with the two corrections that are safe: stop suggesting an artist,
    or start again (the existing « reset learned » route)."""
    dj = _dj()
    profile = dj.taste_profile()
    taste = music.get_taste()
    duels = (dj._state().get("duels") or {})
    labels = lambda keys: [dj.POOL_LABELS.get(k, k) for k in keys]
    return {
        "ok": True,
        "loves": profile["artists"][:12],
        "cooling": profile["cooling"][:6],
        "banned": list(taste.get("banned_artists") or [])[-40:],
        "dayparts": profile["dayparts"],
        "finishes": labels(profile["pools_liked"]),
        "skips": labels(profile["pools_skipped"]),
        "steers": [s.get("text") for s in profile["steers"] if s.get("text")][-5:],
        "duels": {"played": int(duels.get("played") or 0), "right": int(duels.get("right") or 0)},
        "history_sharing": bool(taste.get("history_sharing", True)),
    }


def correct(body: dict[str, Any]) -> dict[str, Any]:
    if "ban" in body:
        music.update_taste({"ban": body["ban"]})
    elif "unban" in body:
        music.update_taste({"unban": body["unban"]})
    else:
        raise StationError("Correction inconnue")
    return memory()


# ---- the compact payload -------------------------------------------------------------------------------------------

def view(now: datetime | None = None) -> dict[str, Any]:
    """Everything the Accueil card, the « coming up » strip and the moments bubble need, in one cheap read."""
    dj = _dj()
    now = now or datetime.now()
    st = dj.settings()
    state = dj._state()
    seg = state.get("segment") or {}
    on_air = None
    if state.get("active") and seg:
        track = (seg.get("tracks") or [{}])[0]
        blind = bool((state.get("duel") or {}).get("blind") and not (state.get("duel") or {}).get("vote"))
        on_air = {"show": seg.get("show"), "title": seg.get("title") or KINDS.get(seg.get("show"), ("Émission",))[0],
                  "track": None if blind else track.get("name"), "artist": None if blind else (track.get("artists") or [""])[0]}
    bracket = dj.tournament_view(state)
    tournament = None
    if bracket and not bracket.get("done"):
        tournament = {"round": bracket.get("round"), "kind_label": bracket.get("kind_label")}
    ready = [r for r in _load().get("ready") or [] if time.time() - float(r.get("at") or 0) < READY_TTL]
    return {"ok": True, "on_air": on_air, "station_on": bool(st.get("station")), "moments": bool(st.get("moments", True)),
            "upcoming": upcoming(now, settings=st), "ready": ready, "daily": dj.daily_view(state), "tournament": tournament,
            "slots": slots(), "kinds": {k: {"label": v[0], "icon": v[1]} for k, v in KINDS.items()},
            "suggested": suggested(), "previously": previously(now.timestamp())}


def day_label(ts: int, now: datetime | None = None) -> str:
    """« aujourd’hui 19:00 », « demain 11:00 », « vendredi 20:00 » (used by the notification texts and tests)."""
    now = now or datetime.now()
    at = datetime.fromtimestamp(ts)
    delta = (at.date() - date(now.year, now.month, now.day)).days
    day = "aujourd’hui" if delta == 0 else "demain" if delta == 1 else DAY_NAMES[at.weekday()]
    return f"{day} {at:%H:%M}"
