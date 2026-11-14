"""Long-term listening journal for Musique: every Spotify play HQ sees, kept locally beyond Spotify's 50.

Spotify's recently-played endpoint only remembers the last 50 plays. The bridge's background tick calls
``tick()``; at most every ``SYNC_INTERVAL`` it reads that window and appends the plays it has not stored yet
(``played_at`` newer than the saved cursor). Plays live in one atomic JSON file per month
(``.hq-music/journal-YYYY-MM.json``) plus a small first/last/count index for artists and tracks, so
"first heard on…" and "not played since…" claims rest on the journal rather than on a 50-play sample.

Local only: nothing here calls a model. The journal can be switched off; Musica reads it only when history
sharing is on (enforced in hq_musica).
"""
from __future__ import annotations

import re
import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from typing import Any

import hq_music as music

SETTINGS_FILE = "journal.json"
INDEX_FILE = "journal-index.json"
SYNC_INTERVAL = 20 * 60
MANUAL_SYNC_MIN = 90
MONTH_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MAX_MONTH_PLAYS = 20000
_lock = threading.RLock()


def _month_file(month: str) -> str:
    if not MONTH_RE.fullmatch(month or ""):
        raise music.MusicError("Mois invalide (AAAA-MM)")
    return f"journal-{month}.json"


def settings() -> dict[str, Any]:
    raw = music._load(SETTINGS_FILE, {})
    return {"enabled": raw.get("enabled", True) is not False, "cursor": str(raw.get("cursor") or ""),
            "last_sync": float(raw.get("last_sync") or 0), "last_error": raw.get("last_error"),
            "since": raw.get("since")}


def set_enabled(enabled: Any) -> dict[str, Any]:
    if type(enabled) is not bool:
        raise music.MusicError("Choix requis")
    with _lock:
        state = music._load(SETTINGS_FILE, {})
        state["enabled"] = enabled
        music._write(SETTINGS_FILE, state)
    return settings()


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _row(track: dict[str, Any], played: datetime) -> dict[str, Any] | None:
    name = str(track.get("name") or "").strip()[:200]
    if not name:
        return None
    artists = [str(a)[:120] for a in (track.get("artists") or []) if isinstance(a, str) and a.strip()][:6]
    duration = track.get("duration_ms")
    return {"t": _iso(played), "u": track.get("uri") if isinstance(track.get("uri"), str) else None,
            "n": name, "a": artists, "al": str(track.get("album") or "")[:200] or None,
            "d": duration if isinstance(duration, int) and 0 < duration < 3 * 3600 * 1000 else None}


def _track_key(row: dict[str, Any]) -> str:
    return row.get("u") or (row["n"].casefold() + "||" + "|".join(a.casefold() for a in row.get("a") or []))


def _index_add(index: dict[str, Any], row: dict[str, Any]) -> None:
    stamp = row["t"]
    for name in row.get("a") or []:
        entry = index["artists"].setdefault(name.casefold(), {"name": name, "first": stamp, "last": stamp, "count": 0})
        entry["count"] += 1
        entry["first"] = min(entry["first"], stamp)
        entry["last"] = max(entry["last"], stamp)
    key = _track_key(row)
    entry = index["tracks"].setdefault(key, {"name": row["n"], "artists": row.get("a") or [], "uri": row.get("u"),
                                             "first": stamp, "last": stamp, "count": 0})
    entry["count"] += 1
    entry["first"] = min(entry["first"], stamp)
    entry["last"] = max(entry["last"], stamp)


def record(tracks: list[dict[str, Any]]) -> dict[str, Any]:
    """Store plays newer than the cursor. ``tracks`` are hq_spotify catalog rows carrying ``played_at``."""
    with _lock:
        state = music._load(SETTINGS_FILE, {})
        cursor = _parse_time(state.get("cursor"))
        fresh = []
        for track in tracks or []:
            if not isinstance(track, dict):
                continue
            played = _parse_time(track.get("played_at"))
            if played is None or (cursor is not None and played <= cursor):
                continue
            row = _row(track, played)
            if row:
                fresh.append(row)
        fresh.sort(key=lambda r: r["t"])
        if fresh:
            index = music._load(INDEX_FILE, {"artists": {}, "tracks": {}})
            index.setdefault("artists", {})
            index.setdefault("tracks", {})
            by_month: dict[str, list[dict[str, Any]]] = {}
            for row in fresh:
                local = _parse_time(row["t"]).astimezone()
                by_month.setdefault(local.strftime("%Y-%m"), []).append(row)
                _index_add(index, row)
            for month, rows in by_month.items():
                data = music._load(_month_file(month), {"version": 1, "plays": []})
                plays = list(data.get("plays") or []) + rows
                plays.sort(key=lambda r: r.get("t") or "")
                music._write(_month_file(month), {"version": 1, "plays": plays[-MAX_MONTH_PLAYS:]})
            music._write(INDEX_FILE, index)
            state["cursor"] = fresh[-1]["t"]
            state.setdefault("since", fresh[0]["t"])
        state["last_sync"] = time.time()
        state["last_error"] = None
        music._write(SETTINGS_FILE, state)
        return {"added": len(fresh), "cursor": state.get("cursor")}


def sync(*, force: bool = False) -> dict[str, Any]:
    import hq_spotify as spotify

    current = settings()
    if not current["enabled"]:
        return {"ok": True, "skipped": "disabled", "added": 0}
    elapsed = time.time() - current["last_sync"]
    if elapsed < (MANUAL_SYNC_MIN if force else SYNC_INTERVAL):
        return {"ok": True, "skipped": "recent", "added": 0}
    if not spotify.status().get("connected"):
        return {"ok": True, "skipped": "spotify_disconnected", "added": 0}
    try:
        data = spotify.recently_played(50, retry_429=False)
    except spotify.SpotifyError as exc:
        with _lock:
            state = music._load(SETTINGS_FILE, {})
            state.update(last_sync=time.time(), last_error=exc.code)
            music._write(SETTINGS_FILE, state)
        return {"ok": False, "code": exc.code, "added": 0}
    return {"ok": True, **record(data.get("tracks") or [])}


def tick() -> None:
    """Background hook (bridge monitor loop). Never raises."""
    try:
        sync()
    except Exception:  # noqa: BLE001 — a background tick must not break the bridge loop
        pass


def months() -> list[str]:
    base = music._path(SETTINGS_FILE).parent
    if not base.is_dir():
        return []
    found = []
    for path in base.iterdir():
        m = re.fullmatch(r"journal-(\d{4}-\d{2})\.json", path.name)
        if m and MONTH_RE.fullmatch(m.group(1)) and path.is_file() and not path.is_symlink():
            found.append(m.group(1))
    return sorted(found, reverse=True)


def plays(month: str) -> list[dict[str, Any]]:
    return [r for r in music._load(_month_file(month), {"plays": []}).get("plays") or [] if isinstance(r, dict)]


def _local_day(row: dict[str, Any]) -> date | None:
    moment = _parse_time(row.get("t"))
    return moment.astimezone().date() if moment else None


def _longest_streak(days: set[date]) -> int:
    best = run = 0
    previous = None
    for day in sorted(days):
        run = run + 1 if previous and day - previous == timedelta(days=1) else 1
        best = max(best, run)
        previous = day
    return best


def current_streak(today: date | None = None) -> int:
    today = today or date.today()
    days: set[date] = set()
    for month in months()[:3]:
        days |= {d for d in (_local_day(r) for r in plays(month)) if d}
    start = today if today in days else today - timedelta(days=1)
    streak = 0
    while start in days:
        streak += 1
        start -= timedelta(days=1)
    return streak


def recap(month: str | None = None) -> dict[str, Any]:
    month = month or datetime.now().strftime("%Y-%m")
    rows = plays(month)
    index = music._load(INDEX_FILE, {"artists": {}, "tracks": {}})
    artists: Counter[str] = Counter()
    names: dict[str, str] = {}
    tracks: Counter[str] = Counter()
    track_rows: dict[str, dict[str, Any]] = {}
    heat = [[0] * 24 for _ in range(7)]
    days: set[date] = set()
    minutes = 0.0
    for row in rows:
        moment = _parse_time(row.get("t"))
        if not moment:
            continue
        local = moment.astimezone()
        heat[local.weekday()][local.hour] += 1
        days.add(local.date())
        minutes += (row.get("d") or 0) / 60000
        for name in row.get("a") or []:
            artists[name.casefold()] += 1
            names.setdefault(name.casefold(), name)
        key = _track_key(row)
        tracks[key] += 1
        track_rows.setdefault(key, row)
    first_of = index.get("artists") or {}
    top_artists = [{"name": names[k], "plays": c, "first_heard": (first_of.get(k) or {}).get("first")}
                   for k, c in artists.most_common(10)]
    top_tracks = [{"name": track_rows[k]["n"], "artists": track_rows[k].get("a") or [], "uri": track_rows[k].get("u"),
                   "plays": c} for k, c in tracks.most_common(10)]
    new_artists = sorted(({"name": entry.get("name"), "first_heard": entry.get("first")}
                          for entry in first_of.values()
                          if isinstance(entry, dict) and _parse_time(entry.get("first"))
                          and _parse_time(entry["first"]).astimezone().strftime("%Y-%m") == month),
                         key=lambda e: e["first_heard"])
    busiest = max(((d, h) for d in range(7) for h in range(24)), key=lambda dh: heat[dh[0]][dh[1]], default=None)
    return {
        "month": month,
        "months": months(),
        "plays": len(rows),
        "minutes": round(minutes),
        "active_days": len(days),
        "longest_streak": _longest_streak(days),
        "current_streak": current_streak(),
        "distinct_artists": len(artists),
        "distinct_tracks": len(tracks),
        "top_artists": top_artists,
        "top_tracks": top_tracks,
        "new_artists": new_artists[:20],
        "new_artists_count": len(new_artists),
        "heatmap": heat,
        "busiest": {"weekday": busiest[0], "hour": busiest[1]} if busiest and heat[busiest[0]][busiest[1]] else None,
        "settings": settings(),
    }


def lookup(*, artist: str = "", track: str = "") -> dict[str, Any]:
    """First/last/count from the full journal (Musica tool). Says how far back the journal goes."""
    index = music._load(INDEX_FILE, {"artists": {}, "tracks": {}})
    current = settings()
    out: dict[str, Any] = {"ok": True, "journal_since": current.get("since"), "journal_enabled": current["enabled"]}
    if artist.strip():
        entry = (index.get("artists") or {}).get(artist.strip().casefold())
        out["artist"] = entry or {"name": artist.strip(), "count": 0}
    if track.strip():
        needle = track.strip().casefold()
        hits = [e for e in (index.get("tracks") or {}).values()
                if isinstance(e, dict) and needle in str(e.get("name") or "").casefold()
                and (not artist.strip() or any(a.casefold() == artist.strip().casefold() for a in e.get("artists") or []))]
        out["tracks"] = sorted(hits, key=lambda e: e.get("count", 0), reverse=True)[:10]
    if not artist.strip() and not track.strip():
        top = sorted((e for e in (index.get("artists") or {}).values() if isinstance(e, dict)),
                     key=lambda e: e.get("count", 0), reverse=True)[:15]
        out["top_artists_all_time"] = top
    return out
