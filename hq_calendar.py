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
RECURRENCE_FREQUENCIES = ("daily", "weekdays", "weekly")
RECURRENCE_COUNT_MAX = 1000
OCCURRENCE_QUERY_MAX = 10000
# All-day reminders anchor at 08:00 HQ local on the start date.
ALL_DAY_REMINDER_HOUR = 8
ALL_DAY_REMINDER_MINUTE = 0
SCHEDULE_BLOCK_MIN = 30

DEFAULT_CATEGORIES = (
    ("personal", "Personnel", "#7aa2ff"),
    ("study", "Étude", "#3dbe7a"),
    ("appointment", "Rendez-vous", "#e6b450"),
    ("maintenance", "Maintenance", "#e85d4c"),
    ("hq", "HQ", "#9274cf"),
    ("other", "Autre", "#7d8794"),
)
CATEGORIES = tuple(key for key, _label, _color in DEFAULT_CATEGORIES)
CATEGORY_MAX = 24
CATEGORY_LABEL_MAX = 32
REMINDER_CHOICES = (0, 5, 15, 30, 60, 120, 1440)
GRID_WHENS = ("daily", "weekdays", "weekly", "once")
CONDITIONAL_WHENS = ("on-online", "online", "wake")

_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_MINUTE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$")
_CAL_ID_RE = re.compile(r"^cal-[a-f0-9]{16}$")
_CATEGORY_ID_RE = re.compile(r"^custom-[a-f0-9]{12}$")
_CATEGORY_COLOR_RE = re.compile(r"^#[a-fA-F0-9]{6}$")
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
    """HQ alert and journal/Web Push. Calendar reminders do not post to Discord."""
    fn = _cb.get("alert")
    if not callable(fn):
        return
    try:
        fn(title[:120], detail[:400], discord=False)
    except TypeError:
        try:
            fn(title[:120], detail[:400])
        except Exception:
            pass
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


def _recurrence_pattern(value: Any, start: datetime) -> dict | None:
    """Validate the small structured recurrence pattern stored on one event.

    This is deliberately not an RRULE parser: only frequency, a weekly weekday
    selection, and one end condition are accepted. Raw scheduling strings stay
    rejected by _reject_forbidden.
    """
    if value is None or value == {}:
        return None
    if not isinstance(value, dict):
        raise CalendarError("Récurrence invalide")
    allowed = {"frequency", "weekdays", "until", "count"}
    if set(value) - allowed:
        raise CalendarError("Récurrence invalide")
    frequency = value.get("frequency")
    if frequency not in RECURRENCE_FREQUENCIES:
        raise CalendarError("Fréquence de récurrence invalide")
    raw_days = value.get("weekdays")
    if raw_days is None:
        raw_days = []
    if not isinstance(raw_days, list):
        raise CalendarError("Jours de récurrence invalides")
    weekdays: list[int] = []
    for day in raw_days:
        if isinstance(day, bool) or not isinstance(day, int) or day < 0 or day > 6:
            raise CalendarError("Jours de récurrence invalides")
        if day not in weekdays:
            weekdays.append(day)
    weekdays.sort()
    if frequency == "weekly":
        if not weekdays:
            raise CalendarError("Choisis au moins un jour de la semaine")
    elif weekdays:
        raise CalendarError("Jours de récurrence invalides")
    until_raw = value.get("until")
    until: str | None = None
    if until_raw not in (None, ""):
        if not isinstance(until_raw, str):
            raise CalendarError("Date de fin invalide")
        parsed_until = parse_date(until_raw.strip())
        if parsed_until is None:
            raise CalendarError("Date de fin invalide")
        if parsed_until.date() < start.date():
            raise CalendarError("La fin de la récurrence doit suivre le début")
        until = _fmt_date(parsed_until)
    count = value.get("count")
    if count is not None:
        if isinstance(count, bool) or not isinstance(count, int):
            raise CalendarError("Nombre d'occurrences invalide")
        if count < 1 or count > RECURRENCE_COUNT_MAX:
            raise CalendarError("Nombre d'occurrences invalide")
    if until is not None and count is not None:
        raise CalendarError("Choisis une seule fin de récurrence")
    return {
        "frequency": frequency,
        "weekdays": weekdays,
        "until": until,
        "count": count,
    }


def validate_event(payload: dict, *, existing: dict | None = None, categories=CATEGORIES) -> dict:
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
    if category not in categories:
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
    recurrence = _recurrence_pattern(payload.get("recurrence"), start)
    done = payload.get("done", False)
    if not isinstance(done, bool):
        raise CalendarError("Fait invalide")
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
    if recurrence is not None:
        stored["recurrence"] = recurrence
    scene_id = _link(payload.get("scene_id"))
    action_id = _link(payload.get("action_id"))
    device_id = _link(payload.get("device_id"))
    if scene_id and scene_id not in _catalog_ids("scenes"):
        raise CalendarError("Scène inconnue")
    if action_id and action_id not in _catalog_ids("actions"):
        raise CalendarError("Action inconnue")
    if scene_id:
        stored["scene_id"] = scene_id
    if action_id:
        stored["action_id"] = action_id
    if device_id:
        stored["device_id"] = device_id
    if done:
        stored["done"] = True
    return stored


def _blank() -> dict:
    return {"version": VERSION, "events": [], "reminder_fired": {}}


def _categories(state: dict) -> list[dict]:
    if "categories" in state:
        return state["categories"]
    return [{"id": key, "label": label, "color": color} for key, label, color in DEFAULT_CATEGORIES]


def _category_catalog(state: dict) -> dict:
    return {"categories": _categories(state), "categories_rev": state.get("categories_rev", 0),
            "schedule_category": state.get("schedule_category", "hq")}


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
    if "categories" in data:
        rows, rev = data["categories"], data.get("categories_rev")
        if not isinstance(rows, list) or not 1 <= len(rows) <= CATEGORY_MAX or type(rev) is not int or rev < 1:
            return None
        ids = set()
        for row in rows:
            if not isinstance(row, dict):
                return None
            key, label, color = row.get("id"), row.get("label"), row.get("color")
            if (not isinstance(key, str) or key in ids or (key not in CATEGORIES and not _CATEGORY_ID_RE.fullmatch(key))
                    or not isinstance(label, str) or not label.strip() or len(label) > CATEGORY_LABEL_MAX
                    or not isinstance(color, str) or not _CATEGORY_COLOR_RE.fullmatch(color)):
                return None
            ids.add(key)
        schedule_key = data.get("schedule_category", "hq")
        if "other" not in ids or not isinstance(schedule_key, str) or schedule_key not in ids:
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
    result = {
        "version": VERSION,
        "events": list(state.get("events") or []),
        "reminder_fired": dict(state.get("reminder_fired") or {}),
    }
    if "categories" in state:
        result.update(_category_catalog(state))
    return result


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
        category_ids = {row["id"] for row in _categories(state)}
        if raw_id in (None, ""):
            if expected_rev not in (None, 0):
                raise CalendarError("expected_rev invalide")
            if len(events) >= EVENTS_MAX:
                raise CalendarError("Calendrier plein")
            stored = validate_event(payload, categories=category_ids)
            events.append(stored)
            verb = "créé"
        else:
            if not isinstance(raw_id, str) or not _CAL_ID_RE.match(raw_id):
                raise CalendarError("Identifiant invalide")
            current = _find(events, raw_id)
            if current is None:
                raise CalendarError("Événement introuvable")
            _expect_rev(expected_rev, int(current.get("rev") or 1))
            stored = validate_event(payload, existing=current, categories=category_ids)
            stored["id"] = raw_id
            keep = _reminder_keys(stored)
            _drop_reminder_keys(state["reminder_fired"], raw_id, keep)
            index = events.index(current)
            events[index] = stored
            verb = "modifié"
        _write_state(state)
    _journal("calendar", f"Événement {verb}: {stored['title'][:80]}")
    return stored


def change_category(action: str, payload: dict, expected_rev: Any) -> dict:
    if action not in ("category_save", "category_delete"):
        raise CalendarError("Action invalide")
    with hq_state.path_lock(_path()):
        state = _load_for_write()
        rev = state.get("categories_rev", 0)
        _expect_rev(expected_rev, rev)
        rows = _categories(state)
        key = payload.get("id")
        current = next((row for row in rows if row["id"] == key), None)
        if action == "category_delete":
            if current is None or key == "other":
                raise CalendarError("Cette catégorie ne peut pas être supprimée")
            replacement = payload.get("replacement")
            if replacement == key or not any(row["id"] == replacement for row in rows):
                raise CalendarError("Choisis une catégorie de destination")
            rows.remove(current)
            if state.get("schedule_category", "hq") == key:
                state["schedule_category"] = replacement
            stamp = _fmt_stamp(_local_now())
            for event in state["events"]:
                if event.get("category") == key:
                    event.update(category=replacement, rev=int(event.get("rev") or 1) + 1, updated_at=stamp)
        else:
            if key and current is None:
                raise CalendarError("Catégorie introuvable")
            label = " ".join(_clean_text(payload.get("label"), CATEGORY_LABEL_MAX, label="Nom", required=True).split())
            color = payload.get("color")
            if not isinstance(color, str) or not _CATEGORY_COLOR_RE.fullmatch(color):
                raise CalendarError("Couleur invalide")
            if any(row is not current and row["label"].casefold() == label.casefold() for row in rows):
                raise CalendarError("Ce nom de catégorie existe déjà")
            if current is None:
                if len(rows) >= CATEGORY_MAX:
                    raise CalendarError("Nombre maximal de catégories atteint")
                current = {"id": "custom-" + uuid.uuid4().hex[:12]}
                rows.append(current)
            current.update(label=label, color=color.lower())
        state["categories"] = rows
        state["categories_rev"] = rev + 1
        _write_state(state)
        return _category_catalog(state)


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
    return _manual_items(state or {}, start, end), bad


def _recurrence_day_matches(day: datetime, recurrence: dict) -> bool:
    frequency = recurrence.get("frequency")
    if frequency == "daily":
        return True
    if frequency == "weekdays":
        return day.weekday() < 5
    return day.weekday() in (recurrence.get("weekdays") or [])


def _occurrence_spans(event: dict, start: datetime, end: datetime):
    """Yield (start, end) for projected occurrences overlapping [start, end).

    Iteration is bounded by the query window for open-ended series and by the
    stored count for counted series. The base event is never moved: every
    occurrence keeps the same duration, including multi-day all-day events.
    """
    recurrence = event.get("recurrence")
    if not isinstance(recurrence, dict):
        return
    try:
        series_start, series_end = _event_bounds(event)
    except CalendarError:
        return
    duration = series_end - series_start
    first_day = series_start.date()
    count = recurrence.get("count")
    until = parse_date(str(recurrence.get("until") or ""))

    def projected(day: datetime) -> tuple[datetime, datetime]:
        occurrence_start = datetime.combine(day, series_start.time())
        return occurrence_start, occurrence_start + duration

    if isinstance(count, int) and not isinstance(count, bool) and count >= 1:
        day = first_day
        emitted = 0
        while emitted < count:
            if _recurrence_day_matches(day, recurrence):
                emitted += 1
                occurred_start, occurred_end = projected(day)
                if occurred_start < end and occurred_end > start:
                    yield occurred_start, occurred_end
            day += timedelta(days=1)
        return

    # A timed occurrence can begin before the window and still overlap it;
    # one extra day of lookback is enough for any event shorter than a day,
    # plus duration.days for multi-day events.
    lookback = max(1, duration.days + 1)
    lower = max(first_day, (start - timedelta(days=lookback)).date())
    upper = end.date()
    if until is not None:
        upper = min(upper, until.date())
    day = lower
    while day <= upper:
        if _recurrence_day_matches(day, recurrence):
            occurred_start, occurred_end = projected(day)
            if occurred_start < end and occurred_end > start:
                yield occurred_start, occurred_end
        day += timedelta(days=1)


def _occurrence_items(event: dict, start: datetime, end: datetime, remaining: int) -> list[dict]:
    recurrence = event.get("recurrence")
    base_id = str(event.get("id") or "")
    out: list[dict] = []
    for occurred_start, occurred_end in _occurrence_spans(event, start, end):
        if len(out) >= remaining:
            break
        if event.get("all_day"):
            suffix = occurred_start.strftime("%Y%m%d")
            item_start = _fmt_date(occurred_start)
            item_end = _fmt_date(occurred_end)
        else:
            suffix = occurred_start.strftime("%Y%m%dT%H%M")
            item_start = _fmt_minute(occurred_start)
            item_end = _fmt_minute(occurred_end)
        item = dict(event)
        item.update({
            "id": f"{base_id}@{suffix}",
            "start": item_start,
            "end": item_end,
            "series_id": base_id,
            "series_start": str(event.get("start") or ""),
            "series_end": str(event.get("end") or ""),
            "recurrence": dict(recurrence),
            "source": "manual",
            "read_only": False,
        })
        out.append(item)
    return out


def _manual_items(state: dict, start: datetime, end: datetime) -> list[dict]:
    found: list[dict] = []
    for event in state.get("events") or []:
        if not isinstance(event, dict):
            continue
        recurrence = event.get("recurrence")
        if isinstance(recurrence, dict):
            found.extend(_occurrence_items(event, start, end, OCCURRENCE_QUERY_MAX - len(found)))
            if len(found) >= OCCURRENCE_QUERY_MAX:
                break
            continue
        if _overlaps(event, start, end):
            item = dict(event)
            item["source"] = "manual"
            item["read_only"] = False
            found.append(item)
    found.sort(key=_item_sort)
    return found


def _item_sort(item: dict) -> tuple:
    return (0 if item.get("all_day") else 1, str(item.get("start") or ""), str(item.get("title") or ""), str(item.get("id") or ""))


def _queue_items() -> list:
    fn = _cb.get("queue_load")
    if not callable(fn):
        return []
    try:
        data = fn()
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return data


def _safe_piece(value: Any) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:40]
    return cleaned or "job"


def _schedule_item(job: dict, slot: datetime) -> dict:
    end = slot + timedelta(minutes=SCHEDULE_BLOCK_MIN)
    item: dict[str, Any] = {
        "source": "schedule",
        "read_only": True,
        "id": f"sched-{_safe_piece(job.get('id'))}-{slot.strftime('%Y%m%dT%H%M')}",
        "schedule_id": str(job.get("id") or "")[:48],
        "title": str(job.get("label") or "Planifié")[:TITLE_MAX],
        "all_day": False,
        "start": _fmt_minute(slot),
        "end": _fmt_minute(end),
        "when": str(job.get("when") or ""),
        "job_type": str(job.get("type") or "")[:40],
        "status": str(job.get("status") or "pending")[:20],
    }
    scene_id = job.get("scene_id")
    action_id = job.get("action_id")
    if isinstance(scene_id, str) and _LINK_RE.match(scene_id):
        item["scene_id"] = scene_id
    if isinstance(action_id, str) and _LINK_RE.match(action_id):
        item["action_id"] = action_id
    return item


def _conditional_item(job: dict) -> dict:
    item: dict[str, Any] = {
        "source": "schedule",
        "read_only": True,
        "id": f"cond-{_safe_piece(job.get('id'))}",
        "schedule_id": str(job.get("id") or "")[:48],
        "title": str(job.get("label") or "Conditionnel")[:TITLE_MAX],
        "when": str(job.get("when") or ""),
        "job_type": str(job.get("type") or "")[:40],
        "status": str(job.get("status") or "pending")[:20],
    }
    device_id = job.get("device_id")
    if isinstance(device_id, str) and _LINK_RE.match(device_id):
        item["device_id"] = device_id
    return item


def _project(start: datetime, end: datetime) -> tuple[list[dict], list[dict]]:
    """Project queue jobs. The queue list and its dicts are not modified."""
    import hq_automation

    scheduled: list[dict] = []
    conditional: list[dict] = []
    for job in _queue_items():
        if not isinstance(job, dict):
            continue
        when = str(job.get("when") or "")
        if when in CONDITIONAL_WHENS:
            if str(job.get("status") or "pending") in ("pending", "armed", "error"):
                conditional.append(_conditional_item(job))
            continue
        if when not in GRID_WHENS:
            continue
        snapshot = dict(job)
        for slot in hq_automation.project_schedule_slots(snapshot, start, end):
            scheduled.append(_schedule_item(job, slot))
    conditional = conditional[:40]
    return scheduled, conditional


def _catalog_ids(key: str) -> set[str]:
    """Live scene or action ids. Not capped: save must accept any real catalog id."""
    fn = _cb.get(key)
    raw = fn() if callable(fn) else []
    found: set[str] = set()
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        ident = item.get("id")
        if isinstance(ident, str) and _LINK_RE.match(ident):
            found.add(ident)
    return found


def _catalog() -> dict[str, list[dict]]:
    def rows(key: str, label_key: str) -> list[dict]:
        fn = _cb.get(key)
        raw = fn() if callable(fn) else []
        out = []
        for item in raw or []:
            if not isinstance(item, dict):
                continue
            ident = item.get("id")
            if not isinstance(ident, str) or not _LINK_RE.match(ident):
                continue
            label = item.get(label_key) or item.get("label") or ident
            out.append({"id": ident, "label": str(label)[:80]})
            if len(out) >= 40:
                break
        return out

    return {
        "scenes": rows("scenes", "label"),
        "actions": rows("actions", "label"),
        "devices": rows("devices", "name"),
    }


def _hq_local_minute(ts: Any) -> str | None:
    """Unix ts as HQ wall-clock minute. The browser must not convert this itself."""
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return None
    try:
        moment = datetime.fromtimestamp(float(ts))
    except (OSError, OverflowError, ValueError):
        return None
    return _fmt_minute(moment)


def _activity(start: datetime, end: datetime) -> list[dict]:
    limit = 50
    fn = _cb.get("events_between")
    rows: list = []
    if callable(fn):
        try:
            rows = list(fn(start, end, limit) or [])
        except Exception:
            rows = []
    else:
        rows = _journal_between(start, end)
    markers = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        marker: dict[str, Any] = {
            "kind": str(row.get("kind") or "")[:40],
            "message": str(row.get("message") or "")[:80],
        }
        at = row.get("at") if isinstance(row.get("at"), str) else row.get("at_h")
        if isinstance(at, str) and at:
            marker["at"] = at[:8]
        local_at = _hq_local_minute(row.get("ts"))
        if local_at:
            marker["local_at"] = local_at
        markers.append(marker)
        if len(markers) >= limit:
            break
    return markers


def _journal_between(start: datetime, end: datetime) -> list[dict]:
    try:
        import hq_events
    except Exception:
        return []
    if not hq_events.enabled():
        return []
    listed = hq_events.list_events(limit=200, offset=0)
    start_ts = start.timestamp()
    end_ts = end.timestamp()
    found = []
    for event in listed.get("events") or []:
        if not isinstance(event, dict):
            continue
        try:
            ts = float(event.get("ts") or 0)
        except (TypeError, ValueError):
            continue
        if start_ts <= ts < end_ts:
            found.append(event)
    found.sort(key=lambda event: float(event.get("ts") or 0))
    return found


def query(start: datetime, end: datetime, *, include_activity: bool = False, with_catalog: bool = True) -> dict:
    assert_span(start, end)
    state, bad = _read_state()
    state = state or {}
    manual = _manual_items(state, start, end)
    scheduled, conditional = _project(start, end)
    items = list(manual) + scheduled
    items.sort(key=_item_sort)
    body: dict[str, Any] = {
        "ok": not bad,
        "malformed": bad,
        "from": _fmt_minute(start),
        "to": _fmt_minute(end),
        "items": items,
        "conditional": conditional,
        "catalog": _catalog() if with_catalog else {"scenes": [], "actions": [], "devices": []},
    }
    body.update(clock())
    body["recent"] = recent_titles()
    body["next"] = next_manual()
    body.update(_category_catalog(state))
    body["streak"] = streak()
    if include_activity:
        body["activity"] = _activity(start, end)
    return body


def recent_titles(limit: int = 6) -> list[dict]:
    """The owner's latest distinct titles, with the usual time and length (quick add chips)."""
    state, bad = _read_state()
    if bad or state is None:
        return []
    events = [e for e in reversed(state.get("events") or []) if isinstance(e, dict) and e.get("title")]  # ties: newest first
    events.sort(key=lambda e: str(e.get("updated_at") or e.get("created_at") or ""), reverse=True)
    seen: set[str] = set()
    out: list[dict] = []
    for event in events:
        title = str(event.get("title") or "")[:TITLE_MAX]
        key = title.casefold()
        if key in seen:
            continue
        seen.add(key)
        row: dict[str, Any] = {"title": title, "category": str(event.get("category") or "other")}
        if not event.get("all_day"):
            try:
                start, end = _event_bounds(event)
            except CalendarError:
                start = end = None
            if start and end:
                row["time"] = start.strftime("%H:%M")
                row["minutes"] = int((end - start).total_seconds() // 60)
        out.append(row)
        if len(out) >= limit:
            break
    return out


def next_manual(days: int = 7) -> dict | None:
    """The manual event in progress or coming next (timed, within `days`), for the countdown card."""
    state, bad = _read_state()
    if bad or state is None:
        return None
    wall = _local_now().replace(second=0, microsecond=0)
    horizon = wall + timedelta(days=days)
    best: tuple[datetime, dict] | None = None
    for item in _manual_items(state, wall, horizon):
        if item.get("all_day"):
            continue
        try:
            start, _end = _event_bounds(item)
        except CalendarError:
            continue
        if best is None or start < best[0]:
            best = (start, item)
    if best is None:
        return None
    event = best[1]
    out = _compact(event)
    out["rev"] = event.get("rev")
    return out


def streak(days: int = 120) -> dict:
    """Days in a row (back from today) where every finished timed event was ticked done.
    Days with nothing finished neither count nor break it; today in progress does not break it."""
    state, bad = _read_state()
    if bad or state is None:
        return {"days": 0, "today": False}
    wall = _local_now().replace(second=0, microsecond=0)
    per_day: dict[Any, list[bool]] = {}
    for event in state.get("events") or []:
        if not isinstance(event, dict) or event.get("all_day"):
            continue
        if isinstance(event.get("recurrence"), dict):
            continue  # a series is not ticked off occurrence by occurrence, so it cannot make a streak

        try:
            start, end = _event_bounds(event)
        except CalendarError:
            continue
        if end > wall:
            continue
        per_day.setdefault(start.date(), []).append(bool(event.get("done")))
    count = 0
    today_ok = False
    day = wall.date()
    for _ in range(days):
        rows = per_day.get(day)
        if rows:
            if all(rows):
                count += 1
                today_ok = today_ok or day == wall.date()
            elif day != wall.date():
                break
        day -= timedelta(days=1)
    return {"days": count, "today": today_ok}


def _compact(item: dict) -> dict:
    out: dict[str, Any] = {
        "id": item.get("id"),
        "title": str(item.get("title") or "")[:TITLE_MAX],
        "start": item.get("start"),
        "end": item.get("end"),
        "all_day": bool(item.get("all_day")),
        "source": item.get("source") or "manual",
        "read_only": bool(item.get("read_only")),
    }
    if item.get("category"):
        out["category"] = item.get("category")
    if item.get("when"):
        out["when"] = item.get("when")
    # A projected occurrence stays a series event when the home/countdown card
    # carries it: without these, opening it would edit or delete one occurrence.
    for key in ("series_id", "series_start", "series_end"):
        if item.get(key):
            out[key] = item.get(key)
    if isinstance(item.get("recurrence"), dict):
        out["recurrence"] = dict(item["recurrence"])
    return out


def _item_start(item: dict) -> datetime | None:
    if item.get("all_day"):
        return parse_date(str(item.get("start") or ""))
    return parse_minute(str(item.get("start") or ""))


def summary() -> dict:
    """Today and the next upcoming item. Reads local files only."""
    wall = _local_now().replace(second=0, microsecond=0)
    day_start = wall.replace(hour=0, minute=0, second=0, microsecond=0)
    horizon = day_start + timedelta(days=15)
    try:
        body = query(day_start, horizon, include_activity=False, with_catalog=False)
    except CalendarError:
        body = {"items": [], "malformed": False}
    day_end = day_start + timedelta(days=1)
    today_rows = []
    for item in body.get("items") or []:
        if not isinstance(item, dict):
            continue
        try:
            if _overlaps(item, day_start, day_end):
                today_rows.append(item)
        except CalendarError:
            continue
    upcoming: list[tuple[datetime, dict]] = []
    for item in body.get("items") or []:
        if not isinstance(item, dict):
            continue
        start = _item_start(item)
        if start is not None and start >= wall:
            upcoming.append((start, item))
    upcoming.sort(key=lambda pair: (pair[0], str(pair[1].get("id") or "")))
    nxt = upcoming[0][1] if upcoming else None
    info = clock()
    return {
        "today": [_compact(item) for item in today_rows[:5]],
        "next": _compact(nxt) if nxt else None,
        "next_mine": next_manual(),  # the owner's own events only (HQ schedules left out)
        "server_now": info["server_now"],
        "server_date": info["server_date"],
        "malformed": bool(body.get("malformed")),
    }


def run_linked(event_id: str, target: str) -> dict:
    """Run a linked scene or action. Explicit call only — never from the clock."""
    if target not in ("scene", "action"):
        raise CalendarError("Cible invalide")
    if not isinstance(event_id, str) or not _CAL_ID_RE.match(event_id):
        raise CalendarError("Identifiant invalide")
    state, bad = _read_state()
    if bad:
        raise CalendarConflict("hq_calendar.json illisible — fichier conservé")
    event = _find(list((state or {}).get("events") or []), event_id)
    if event is None:
        raise CalendarError("Événement introuvable")
    title = str(event.get("title") or "")[:80]
    if target == "scene":
        ident = event.get("scene_id")
        known = _catalog_ids("scenes")
        missing = "Aucune scène liée"
        unknown = "Scène inconnue"
        runner_key = "run_scene"
    else:
        ident = event.get("action_id")
        known = _catalog_ids("actions")
        missing = "Aucune action liée"
        unknown = "Action inconnue"
        runner_key = "run_action"
    if not isinstance(ident, str) or not ident:
        raise CalendarError(missing)
    if ident not in known:
        raise CalendarError(unknown)
    fn = _cb.get(runner_key)
    if not callable(fn):
        raise CalendarError("Exécution indisponible")
    try:
        result = fn(ident)
    except CalendarError:
        raise
    except Exception as exc:
        raise CalendarError(str(exc)[:200]) from exc
    ok = True if not isinstance(result, dict) else bool(result.get("ok", True))
    _journal("calendar_run", f"Exécution {target}: {title}")
    return {"ok": ok, "id": event_id, "target": target}


def _reminder_anchor(event: dict) -> datetime | None:
    if event.get("all_day"):
        day = parse_date(str(event.get("start") or ""))
        if day is None:
            return None
        return day.replace(
            hour=ALL_DAY_REMINDER_HOUR,
            minute=ALL_DAY_REMINDER_MINUTE,
            second=0,
            microsecond=0,
        )
    return parse_minute(str(event.get("start") or ""))


def _reminder_instances(event: dict, now: datetime) -> list[tuple[datetime, str]]:
    """Anchors and occurrence start keys that can have a reminder around `now`.

    One-off events keep their single anchor. A series is projected only over the
    small window in which one of its reminders can become due, including a
    reminder one day before an upcoming occurrence.
    """
    recurrence = event.get("recurrence")
    if not isinstance(recurrence, dict):
        anchor = _reminder_anchor(event)
        return [(anchor, str(event.get("start") or ""))] if anchor is not None else []
    offsets = [
        int(offset) for offset in (event.get("reminders_min") or [])
        if isinstance(offset, int) and not isinstance(offset, bool)
    ]
    if not offsets:
        return []
    latest = max(offsets)
    window_start = now - timedelta(seconds=REMINDER_CATCHUP_SEC)
    window_end = now + timedelta(minutes=latest) + timedelta(minutes=1)
    out: list[tuple[datetime, str]] = []
    for occurrence_start, _occurrence_end in _occurrence_spans(event, window_start, window_end):
        if event.get("all_day"):
            anchor = occurrence_start.replace(
                hour=ALL_DAY_REMINDER_HOUR,
                minute=ALL_DAY_REMINDER_MINUTE,
                second=0,
                microsecond=0,
            )
            start_key = _fmt_date(occurrence_start)
        else:
            anchor = occurrence_start
            start_key = _fmt_minute(occurrence_start)
        out.append((anchor, start_key))
    return out


def tick() -> list[dict]:
    """Fire due reminders once. Never starts a linked scene or action.

    A reminder is due at the anchor minus its offset. Timed anchors are the
    start minute. All-day anchors are 08:00 HQ local on the start date.
    If the process wakes up more than 5 minutes late, the reminder is skipped.
    """
    if not ready():
        return []
    path = _path()
    lock = hq_state.path_lock(path)
    due: list[dict] = []
    with lock:
        state, bad = _read_state()
        if bad or state is None:
            return []
        state = {
            "version": VERSION,
            "events": list(state.get("events") or []),
            "reminder_fired": dict(state.get("reminder_fired") or {}),
        }
        now = _local_now().replace(microsecond=0)
        changed = False
        for event in state["events"]:
            if not isinstance(event, dict):
                continue
            event_id = str(event.get("id") or "")
            for anchor, start_key in _reminder_instances(event, now):
                for offset in event.get("reminders_min") or []:
                    if isinstance(offset, bool) or not isinstance(offset, int):
                        continue
                    fire_at = anchor - timedelta(minutes=int(offset))
                    key = f"{event_id}|{start_key}|{offset}"
                    if key in state["reminder_fired"]:
                        continue
                    delta = (now - fire_at).total_seconds()
                    if delta < 0:
                        continue
                    status = "fired" if delta <= REMINDER_CATCHUP_SEC else "skipped"
                    state["reminder_fired"][key] = {"at": _now(), "status": status}
                    changed = True
                    if status == "fired":
                        due.append(
                            {
                                "id": event_id,
                                "title": str(event.get("title") or "Événement")[:TITLE_MAX],
                                "start": start_key,
                                "offset": int(offset),
                            }
                        )
        if changed:
            _write_state(state)
    for item in due:
        _alert("Rappel", f"{item['title']} · {item['start']}")
        _journal("calendar_reminder", f"Rappel: {item['title']}")
    return due

