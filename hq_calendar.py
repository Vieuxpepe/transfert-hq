"""HQ-native calendar: manual events stored as local JSON.

Scheduled operations are not stored here. A malformed state file is left
untouched. Linked scenes and actions are never started by the clock.
"""

from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import hq_state

CALENDAR_NAME = "hq_calendar.json"
VERSION = 1
EVENTS_MAX = 2000
REMINDER_FIRED_MAX = 4000
TITLE_MAX = 120
NOTES_MAX = 4000
LOCATION_MAX = 200
LINK_MAX = 80
RANGE_MAX_DAYS = 366
REMINDERS_MAX = 3
REMINDER_CATCHUP_SEC = 5 * 60
# All-day reminders anchor at 08:00 HQ local on the start date.
ALL_DAY_REMINDER_HOUR = 8
ALL_DAY_REMINDER_MINUTE = 0
SCHEDULE_BLOCK_MIN = 30

CATEGORIES = ("personal", "study", "appointment", "maintenance", "hq", "other")
REMINDER_CHOICES = (0, 5, 15, 30, 60, 120, 1440)
GRID_WHENS = ("daily", "weekdays", "weekly", "once")
CONDITIONAL_WHENS = ("on-online", "online", "wake")

_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_MINUTE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$")
_CAL_ID_RE = re.compile(r"^cal-[a-f0-9]{16}$")
_LINK_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
# Names that must never be stored or interpreted on an event.
_FORBIDDEN = {
    "cmd",
    "command",
    "shell",
    "host",
    "exec",
    "terminal_id",
    "url",
    "python",
    "script",
    "pin",
    "password",
    "token",
    "rrule",
    "recurrence",
    "cron",
}

_cb: dict[str, Any] = {}
_ready = False
_guard = threading.Lock()


class CalendarError(ValueError):
    """Validation failure (HTTP 400)."""


class CalendarConflict(RuntimeError):
    """Revision mismatch or unreadable state (HTTP 409)."""


def bind(**kwargs: Any) -> None:
    global _ready
    with _guard:
        _cb.update(kwargs)
        _ready = _cb.get("root") is not None


def ready() -> bool:
    return _ready and _cb.get("root") is not None


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise CalendarError("Calendrier non initialisé")
    return Path(root)


def _path() -> Path:
    return _root() / CALENDAR_NAME


def _now() -> float:
    fn = _cb.get("now")
    if callable(fn):
        return float(fn())
    return time.time()


def _local_now() -> datetime:
    fn = _cb.get("local_now")
    if callable(fn):
        moment = fn()
        if isinstance(moment, datetime):
            return moment.replace(tzinfo=None)
    return datetime.now()


def _journal(kind: str, message: str, *, level: str = "info") -> None:
    fn = _cb.get("journal")
    if not callable(fn):
        return
    try:
        fn(kind, message[:240], level=level)
    except TypeError:
        try:
            fn(kind, message[:240])
        except Exception:
            pass
    except Exception:
        pass


def _alert(title: str, detail: str) -> None:
    fn = _cb.get("alert")
    if not callable(fn):
        return
    try:
        fn(title[:120], detail[:400])
    except Exception:
        pass


def clock() -> dict[str, Any]:
    wall = _local_now().replace(second=0, microsecond=0)
    aware = datetime.now().astimezone()
    offset = aware.utcoffset() or timedelta(0)
    return {
        "server_now": wall.strftime("%Y-%m-%dT%H:%M"),
        "server_date": wall.strftime("%Y-%m-%d"),
        "server_utc_offset_min": int(offset.total_seconds() // 60),
    }


def parse_date(text: str) -> datetime | None:
    match = _DATE_RE.match(text or "")
    if not match:
        return None
    try:
        return datetime(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def parse_minute(text: str) -> datetime | None:
    match = _MINUTE_RE.match(text or "")
    if not match:
        return None
    try:
        return datetime(
            int(match.group(1)),
            int(match.group(2)),
            int(match.group(3)),
            int(match.group(4)),
            int(match.group(5)),
        )
    except ValueError:
        return None


def parse_bound(text: str) -> datetime:
    raw = (text or "").strip()
    parsed = parse_minute(raw)
    if parsed is None:
        parsed = parse_date(raw)
    if parsed is None:
        raise CalendarError("Plage invalide")
    return parsed


def assert_span(start: datetime, end: datetime) -> None:
    if end <= start:
        raise CalendarError("Plage invalide")
    if (end - start).total_seconds() > RANGE_MAX_DAYS * 86400:
        raise CalendarError("Plage trop longue")


def _fmt_minute(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M")


def _fmt_date(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%d")


def _fmt_stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%S")


def _reject_forbidden(payload: dict) -> None:
    if not isinstance(payload, dict):
        raise CalendarError("Événement invalide")
    for key in payload:
        if str(key).strip().lower() in _FORBIDDEN:
            raise CalendarError("Champ refusé")


def _clean_text(value: Any, limit: int, *, label: str, required: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise CalendarError(f"{label} invalide")
    text = value.replace("\x00", "").strip()
    if required and not text:
        raise CalendarError(f"{label} requis")
    if len(text) > limit:
        raise CalendarError(f"{label} trop long")
    return text


def _link(value: Any) -> str | None:
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise CalendarError("Lien invalide")
    text = value.strip()
    if not text:
        return None
    if not _LINK_RE.match(text):
        raise CalendarError("Lien invalide")
    return text


def _reminders(value: Any) -> list[int]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise CalendarError("Rappels invalides")
    if len(value) > REMINDERS_MAX:
        raise CalendarError("Trois rappels maximum")
    out: list[int] = []
    for item in value:
        if isinstance(item, bool) or not isinstance(item, int):
            raise CalendarError("Rappel invalide")
        if item not in REMINDER_CHOICES:
            raise CalendarError("Rappel invalide")
        if item not in out:
            out.append(item)
    return out


def _event_bounds(event: dict) -> tuple[datetime, datetime]:
    if event.get("all_day"):
        start = parse_date(str(event.get("start") or ""))
        end = parse_date(str(event.get("end") or ""))
    else:
        start = parse_minute(str(event.get("start") or ""))
        end = parse_minute(str(event.get("end") or ""))
    if start is None or end is None or end <= start:
        raise CalendarError("Horaire invalide")
    return start, end


def validate_event(payload: dict, *, existing: dict | None = None) -> dict:
    """Return a stored manual event. Server assigns id, rev, and timestamps."""
    _reject_forbidden(payload)
    all_day = payload.get("all_day")
    if not isinstance(all_day, bool):
        raise CalendarError("Journée entière invalide")
    title = _clean_text(payload.get("title"), TITLE_MAX, label="Titre", required=True)
    title = " ".join(title.split())
    if not title:
        raise CalendarError("Titre requis")
    category = str(payload.get("category") or "other")
    if category not in CATEGORIES:
        raise CalendarError("Catégorie invalide")
    start_raw = payload.get("start")
    end_raw = payload.get("end")
    if not isinstance(start_raw, str) or not isinstance(end_raw, str):
        raise CalendarError("Horaire invalide")
    if all_day:
        start = parse_date(start_raw.strip())
        end = parse_date(end_raw.strip())
        if start is None or end is None or end <= start:
            raise CalendarError("La fin doit être après le début")
        start_s, end_s = _fmt_date(start), _fmt_date(end)
    else:
        start = parse_minute(start_raw.strip())
        end = parse_minute(end_raw.strip())
        if start is None or end is None or end <= start:
            raise CalendarError("La fin doit être après le début")
        start_s, end_s = _fmt_minute(start), _fmt_minute(end)
    notes = _clean_text(payload.get("notes") or "", NOTES_MAX, label="Notes")
    location = _clean_text(payload.get("location") or "", LOCATION_MAX, label="Lieu")
    wall = _local_now()
    stamp = _fmt_stamp(wall)
    if existing:
        event_id = str(existing.get("id") or "")
        created = str(existing.get("created_at") or stamp)
        rev = int(existing.get("rev") or 1) + 1
    else:
        event_id = "cal-" + uuid.uuid4().hex[:16]
        created = stamp
        rev = 1
    stored: dict[str, Any] = {
        "id": event_id,
        "title": title,
        "all_day": all_day,
        "start": start_s,
        "end": end_s,
        "category": category,
        "notes": notes,
        "location": location,
        "reminders_min": _reminders(payload.get("reminders_min")),
        "created_at": created,
        "updated_at": stamp,
        "rev": rev,
    }
    scene_id = _link(payload.get("scene_id"))
    action_id = _link(payload.get("action_id"))
    device_id = _link(payload.get("device_id"))
    if scene_id:
        stored["scene_id"] = scene_id
    if action_id:
        stored["action_id"] = action_id
    if device_id:
        stored["device_id"] = device_id
    return stored


def _blank() -> dict:
    return {"version": VERSION, "events": [], "reminder_fired": {}}


def _usable_state(data: Any) -> dict | None:
    if not isinstance(data, dict):
        return None
    version = data.get("version", VERSION)
    if version != VERSION:
        return None
    events = data.get("events", [])
    fired = data.get("reminder_fired", {})
    if not isinstance(events, list) or not isinstance(fired, dict):
        return None
    if any(not isinstance(item, dict) for item in events):
        return None
    if any(not isinstance(value, dict) for value in fired.values()):
        return None
    return data


def _read_state() -> tuple[dict | None, bool]:
    """Return (state, malformed). Missing file is (None, False)."""
    path = _path()
    if not path.is_file():
        return None, False
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, True
    parsed = _usable_state(raw)
    if parsed is None:
        return None, True
    return parsed, False


def malformed() -> bool:
    if not ready():
        return False
    _state, bad = _read_state()
    return bad


def _load_for_write() -> dict:
    state, bad = _read_state()
    if bad:
        raise CalendarConflict("hq_calendar.json illisible — fichier conservé")
    if state is None:
        return _blank()
    return {
        "version": VERSION,
        "events": list(state.get("events") or []),
        "reminder_fired": dict(state.get("reminder_fired") or {}),
    }


def _write_state(state: dict) -> None:
    """Replace state. Caller holds the calendar lock. Refuses a bad file."""
    path = _path()
    if path.is_file():
        _current, bad = _read_state()
        if bad or _current is None:
            raise CalendarConflict("hq_calendar.json illisible — fichier conservé")
    state["version"] = VERSION
    state["events"] = list(state.get("events") or [])[:EVENTS_MAX]
    fired = dict(state.get("reminder_fired") or {})
    if len(fired) > REMINDER_FIRED_MAX:
        ranked = sorted(fired.items(), key=lambda item: float(item[1].get("at") or 0))
        fired = dict(ranked[-REMINDER_FIRED_MAX:])
    state["reminder_fired"] = fired
    hq_state.write_json_atomic(path, state)


def _find(events: list[dict], event_id: str) -> dict | None:
    for event in events:
        if str(event.get("id") or "") == event_id:
            return event
    return None


def _expect_rev(expected_rev: Any, current: int) -> None:
    if isinstance(expected_rev, bool) or not isinstance(expected_rev, int):
        raise CalendarError("expected_rev requis")
    if expected_rev != current:
        raise CalendarConflict("Conflit de révision")


def _drop_reminder_keys(fired: dict, event_id: str, keep: set[str] | None = None) -> None:
    prefix = event_id + "|"
    for key in list(fired):
        if str(key).startswith(prefix) and (keep is None or key not in keep):
            fired.pop(key, None)


def _reminder_keys(event: dict) -> set[str]:
    start = str(event.get("start") or "")
    event_id = str(event.get("id") or "")
    return {f"{event_id}|{start}|{offset}" for offset in (event.get("reminders_min") or [])}


def save_event(payload: dict, expected_rev: Any = None) -> dict:
    if not isinstance(payload, dict):
        raise CalendarError("Événement invalide")
    _reject_forbidden(payload)
    raw_id = payload.get("id")
    path = _path()
    lock = hq_state.path_lock(path)
    with lock:
        state = _load_for_write()
        events: list[dict] = state["events"]
        if raw_id in (None, ""):
            if expected_rev not in (None, 0):
                raise CalendarError("expected_rev invalide")
            if len(events) >= EVENTS_MAX:
                raise CalendarError("Calendrier plein")
            stored = validate_event(payload)
            events.append(stored)
            verb = "créé"
        else:
            if not isinstance(raw_id, str) or not _CAL_ID_RE.match(raw_id):
                raise CalendarError("Identifiant invalide")
            current = _find(events, raw_id)
            if current is None:
                raise CalendarError("Événement introuvable")
            _expect_rev(expected_rev, int(current.get("rev") or 1))
            stored = validate_event(payload, existing=current)
            stored["id"] = raw_id
            keep = _reminder_keys(stored)
            _drop_reminder_keys(state["reminder_fired"], raw_id, keep)
            index = events.index(current)
            events[index] = stored
            verb = "modifié"
        _write_state(state)
    _journal("calendar", f"Événement {verb}: {stored['title'][:80]}")
    return stored


def delete_event(event_id: str, expected_rev: Any) -> dict:
    if not isinstance(event_id, str) or not _CAL_ID_RE.match(event_id):
        raise CalendarError("Identifiant invalide")
    path = _path()
    lock = hq_state.path_lock(path)
    with lock:
        state = _load_for_write()
        current = _find(state["events"], event_id)
        if current is None:
            raise CalendarError("Événement introuvable")
        _expect_rev(expected_rev, int(current.get("rev") or 1))
        title = str(current.get("title") or "")[:80]
        state["events"] = [item for item in state["events"] if item.get("id") != event_id]
        _drop_reminder_keys(state["reminder_fired"], event_id, None)
        _write_state(state)
    _journal("calendar", f"Événement supprimé: {title}")
    return {"ok": True, "id": event_id}


def _overlaps(event: dict, start: datetime, end: datetime) -> bool:
    try:
        ev_start, ev_end = _event_bounds(event)
    except CalendarError:
        return False
    return ev_start < end and ev_end > start


def manual_between(start: datetime, end: datetime) -> tuple[list[dict], bool]:
    """Manual events overlapping [start, end). Does not create the state file."""
    state, bad = _read_state()
    if bad or state is None:
        return [], bad
    found = []
    for event in state.get("events") or []:
        if isinstance(event, dict) and _overlaps(event, start, end):
            item = dict(event)
            item["source"] = "manual"
            item["read_only"] = False
            found.append(item)
    found.sort(key=lambda item: (0 if item.get("all_day") else 1, str(item.get("start") or ""), str(item.get("id") or "")))
    return found, False

