"""Musique — recaps built from the listening journal: Wrapped (week / month / year), « Ce jour-là » and the taste map.

Read-only over ``hq_music_journal`` (local files, nothing leaves the PC). Every number comes from recorded plays;
the taste map links artists that were played back to back (within ``LINK_GAP_MIN`` minutes) and groups them.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from typing import Any

import hq_music as music
import hq_music_journal as journal

PERIODS = ("week", "month", "year")
EST_TRACK_MS = 3 * 60 * 1000 + 30 * 1000  # a play without a known duration counts as 3 min 30
LINK_GAP_MIN = 25
MAP_ARTISTS = 24
MAP_EDGES = 60
DAYS_FR = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]


class WrappedError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _months_between(start: date, end: date) -> list[str]:
    out, cursor = [], date(start.year, start.month, 1)
    while cursor <= end:
        out.append(cursor.strftime("%Y-%m"))
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
    return out


def _plays(start: date, end: date) -> list[tuple[date, datetime, dict[str, Any]]]:
    """(local day, local time, row) for every play between two local days (inclusive), oldest first."""
    available = set(journal.months())
    out = []
    for month in _months_between(start, end):
        if month not in available:
            continue
        for row in journal.plays(month):
            moment = journal._parse_time(row.get("t"))
            if moment is None:
                continue
            local = moment.astimezone()
            if start <= local.date() <= end:
                out.append((local.date(), local, row))
    out.sort(key=lambda item: item[1])
    return out


def period_bounds(period: str, ref: date | None = None) -> tuple[date, date, str]:
    """(start, end, label) of the week (Monday-based), month or year containing ``ref``."""
    if period not in PERIODS:
        raise WrappedError("Période inconnue (week, month, year)")
    ref = ref or date.today()
    if period == "week":
        start = ref - timedelta(days=ref.weekday())
        end = start + timedelta(days=6)
        return start, end, f"Semaine du {start.day} {MONTHS_FR[start.month - 1]}"
    if period == "month":
        start = date(ref.year, ref.month, 1)
        end = (date(ref.year + (ref.month == 12), ref.month % 12 + 1, 1)) - timedelta(days=1)
        return start, end, f"{MONTHS_FR[ref.month - 1].capitalize()} {ref.year}"
    return date(ref.year, 1, 1), date(ref.year, 12, 31), str(ref.year)


def _shift(period: str, start: date) -> date:
    """A day inside the previous period (for the comparison)."""
    if period == "week":
        return start - timedelta(days=7)
    if period == "month":
        return start - timedelta(days=1)
    return date(start.year - 1, 1, 1)


def _stats(items: list[tuple[date, datetime, dict[str, Any]]]) -> dict[str, Any]:
    artists: Counter[str] = Counter()
    names: dict[str, str] = {}
    tracks: Counter[str] = Counter()
    track_info: dict[str, dict[str, Any]] = {}
    days: set[date] = set()
    weekday: Counter[int] = Counter()
    hours: Counter[int] = Counter()
    ms = 0
    for day, local, row in items:
        days.add(day)
        weekday[day.weekday()] += 1
        hours[local.hour] += 1
        ms += int(row.get("d") or EST_TRACK_MS)
        for artist in row.get("a") or []:
            artists[artist.casefold()] += 1
            names.setdefault(artist.casefold(), artist)
        key = journal._track_key(row)
        tracks[key] += 1
        track_info.setdefault(key, {"name": row.get("n"), "artists": row.get("a") or [], "uri": row.get("u")})
    return {"plays": len(items), "hours": round(ms / 3600000, 1), "days": days, "artists": artists, "names": names,
            "tracks": tracks, "track_info": track_info, "weekday": weekday, "hours_hist": hours}


def wrapped(period: str = "month", ref: date | None = None) -> dict[str, Any]:
    """The recap for a period: counts, top artists / tracks, new artists, streak, rhythm, and the previous period."""
    start, end, label = period_bounds(period, ref)
    today = date.today()
    stats = _stats(_plays(start, min(end, today)))
    prev_start, prev_end, _ = period_bounds(period, _shift(period, start))
    prev = _stats(_plays(prev_start, prev_end))
    index = music._load(journal.INDEX_FILE, {"artists": {}}).get("artists") or {}
    new_artists = []
    for key, count in stats["artists"].items():
        entry = index.get(key) or {}
        first = journal._parse_time(entry.get("first"))
        if first and start <= first.astimezone().date() <= end:
            new_artists.append({"name": stats["names"][key], "plays": count,
                                "first_heard": first.astimezone().date().isoformat()})
    new_artists.sort(key=lambda a: (-a["plays"], a["name"]))
    top_artists = [{"name": stats["names"][k], "plays": c} for k, c in stats["artists"].most_common(5)]
    top_tracks = [{**{k: stats["track_info"][key].get(k) for k in ("name", "artists", "uri")}, "plays": c}
                  for key, c in stats["tracks"].most_common(5)]
    busiest_day = stats["weekday"].most_common(1)
    busiest_hour = stats["hours_hist"].most_common(1)
    plays = stats["plays"]
    return {"ok": True, "period": period, "label": label, "start": start.isoformat(), "end": end.isoformat(),
            "empty": plays == 0, "plays": plays, "hours": stats["hours"], "active_days": len(stats["days"]),
            "longest_streak": journal._longest_streak(stats["days"]), "unique_artists": len(stats["artists"]),
            "top_artists": top_artists, "top_tracks": top_tracks, "new_artists": new_artists[:5],
            "new_artist_count": len(new_artists),
            "busiest_weekday": DAYS_FR[busiest_day[0][0]] if busiest_day else None,
            "busiest_hour": busiest_hour[0][0] if busiest_hour else None,
            "previous": {"plays": prev["plays"], "hours": prev["hours"], "delta": plays - prev["plays"]},
            "recap_for_share": {"headline": f"{plays} écoutes · {stats['hours']} h", "top": [a["name"] for a in top_artists[:3]]}}


def on_this_day(today: date | None = None, years: int = 5) -> dict[str, Any]:
    """What was played on today's date in earlier years (±1 day), grouped by year."""
    today = today or date.today()
    out = []
    for back in range(1, years + 1):
        try:
            anchor = today.replace(year=today.year - back)
        except ValueError:  # 29 February
            anchor = today.replace(year=today.year - back, day=28)
        items = _plays(anchor - timedelta(days=1), anchor + timedelta(days=1))
        if not items:
            continue
        exact = [i for i in items if i[0] == anchor] or items
        counter: Counter[str] = Counter()
        info: dict[str, dict[str, Any]] = {}
        for _day, _local, row in exact:
            key = journal._track_key(row)
            counter[key] += 1
            info.setdefault(key, {"name": row.get("n"), "artists": row.get("a") or [], "uri": row.get("u")})
        out.append({"year": anchor.year, "date": anchor.isoformat(), "plays": len(exact), "years_ago": back,
                    "tracks": [{**info[k], "plays": c} for k, c in counter.most_common(5)]})
    return {"ok": True, "today": today.isoformat(), "years": out, "empty": not out}


def _clusters(nodes: list[str], weight: dict[tuple[str, str], int]) -> dict[str, int]:
    """Deterministic label propagation: each artist adopts the label most of its links carry."""
    neighbours: dict[str, dict[str, int]] = defaultdict(dict)
    for (a, b), w in weight.items():
        neighbours[a][b] = w
        neighbours[b][a] = w
    label = {n: i for i, n in enumerate(nodes)}
    for _ in range(8):
        changed = False
        for node in nodes:
            votes: Counter[int] = Counter()
            for other, w in neighbours[node].items():
                votes[label[other]] += w
            if votes:
                best = max(votes.items(), key=lambda kv: (kv[1], -kv[0]))[0]
                if best != label[node]:
                    label[node] = best
                    changed = True
        if not changed:
            break
    remap = {old: new for new, old in enumerate(sorted(set(label.values())))}
    return {n: remap[label[n]] for n in nodes}


def taste_map(days: int = 90, today: date | None = None) -> dict[str, Any]:
    """Artists you actually play, linked when played back to back, grouped into clusters — plus the ones that went quiet."""
    today = today or date.today()
    start = today - timedelta(days=max(7, min(days, 365)))
    items = _plays(start, today)
    counts: Counter[str] = Counter()
    names: dict[str, str] = {}
    for _d, _l, row in items:
        lead = (row.get("a") or [""])[0]
        if lead:
            counts[lead.casefold()] += 1
            names.setdefault(lead.casefold(), lead)
    top = [k for k, _c in counts.most_common(MAP_ARTISTS)]
    keep = set(top)
    weight: Counter[tuple[str, str]] = Counter()
    previous: tuple[str, datetime] | None = None
    for _d, local, row in items:
        lead = (row.get("a") or [""])[0].casefold()
        if not lead:
            continue
        if previous and lead != previous[0] and lead in keep and previous[0] in keep \
                and (local - previous[1]).total_seconds() <= LINK_GAP_MIN * 60:
            weight[tuple(sorted((lead, previous[0])))] += 1
        previous = (lead, local)
    edges = weight.most_common(MAP_EDGES)
    linked = {a for (a, b), _w in edges} | {b for (a, b), _w in edges}
    cluster = _clusters(top, dict(edges))
    groups: dict[int, list[str]] = defaultdict(list)
    for key in top:
        groups[cluster[key]].append(key)
    # the quiet ones: well played in the 90 days before this window, nothing in the last 30
    older = _plays(start - timedelta(days=90), start - timedelta(days=1))
    older_counts: Counter[str] = Counter()
    for _d, _l, row in older:
        lead = (row.get("a") or [""])[0]
        if lead:
            older_counts[lead.casefold()] += 1
            names.setdefault(lead.casefold(), lead)
    recent = {(row.get("a") or [""])[0].casefold() for d, _l, row in items if d >= today - timedelta(days=30)}
    quiet = [{"name": names[k], "plays": c} for k, c in older_counts.most_common() if k not in recent and c >= 3][:6]
    return {"ok": True, "days": (today - start).days, "empty": not top,
            "nodes": [{"id": k, "name": names[k], "plays": counts[k], "cluster": cluster[k], "linked": k in linked} for k in top],
            "edges": [{"a": a, "b": b, "weight": w} for (a, b), w in edges],
            "clusters": [{"id": cid, "size": len(members), "members": [names[m] for m in members[:5]]}
                         for cid, members in sorted(groups.items(), key=lambda kv: -len(kv[1]))],
            "loners": [names[k] for k in top if k not in linked][:8], "quiet": quiet}
