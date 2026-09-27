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
    found.sort(key=_item_sort)
    return found, False


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
    manual, bad = manual_between(start, end)
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
    if include_activity:
        body["activity"] = _activity(start, end)
    return body


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
            anchor = _reminder_anchor(event)
            if anchor is None:
                continue
            start_key = str(event.get("start") or "")
            event_id = str(event.get("id") or "")
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

