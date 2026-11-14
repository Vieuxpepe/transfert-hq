"""DJ Musica — Rembobiner: aired shows kept as replayable episodes.

An episode is one run of the show (from « Lancer » or a steer until the antenna is given back): its segments
in airing order, with her lines and the names of the mixed drops. Pure local store in
``.hq-music/dj-archive.json``; ``hq_music_dj`` records segments as they air, spares the archived drops when it
prunes its cache, and rebuilds a missing drop from the archived line on replay.
"""
from __future__ import annotations

import copy
import re
import threading
import time
from typing import Any

import hq_music as music

FILE = "dj-archive.json"
KEEP_EPISODES = 30
MAX_SEGMENTS = 16
_lock = threading.RLock()


def _load() -> dict[str, Any]:
    doc = music._load(FILE, {"episodes": []})
    if not isinstance(doc.get("episodes"), list):
        doc["episodes"] = []
    return doc


def record(episode_id: str, segment: dict[str, Any]) -> None:
    """Add the segment to its episode, or refresh it (drops and bet results arrive after it aired)."""
    if not episode_id or not segment.get("id") or not segment.get("tracks"):
        return
    snap = copy.deepcopy(segment)
    with _lock:
        doc = _load()
        episode = next((e for e in doc["episodes"] if e.get("id") == episode_id), None)
        if episode is None:
            episode = {"id": episode_id, "started": time.time(), "show": snap.get("show"),
                       "title": snap.get("title"), "segments": []}
            doc["episodes"].append(episode)
        segments = episode["segments"]
        for i, old in enumerate(segments):
            if old.get("id") == snap["id"]:
                segments[i] = snap
                break
        else:
            if len(segments) >= MAX_SEGMENTS:
                return
            segments.append(snap)
        doc["episodes"] = sorted(doc["episodes"], key=lambda e: e.get("started") or 0)[-KEEP_EPISODES:]
        music._write(FILE, doc)


def refresh(segment: dict[str, Any]) -> None:
    """Update a segment already in the archive, whichever episode holds it (no-op when it is not archived)."""
    with _lock:
        for episode in _load()["episodes"]:
            if any(s.get("id") == segment.get("id") for s in episode.get("segments") or []):
                record(episode["id"], segment)
                return


def episode(episode_id: Any) -> dict[str, Any] | None:
    with _lock:
        return next((e for e in _load()["episodes"] if e.get("id") == episode_id), None)


def segment(episode_id: Any, index: int) -> dict[str, Any] | None:
    found = episode(episode_id)
    segments = (found or {}).get("segments") or []
    return copy.deepcopy(segments[index]) if 0 <= index < len(segments) else None


def drop_names() -> set[str]:
    """Every drop file an archived episode still needs (the DJ cache keeps these)."""
    names: set[str] = set()
    try:
        with _lock:
            episodes = _load()["episodes"]
    except music.MusicError:
        return names
    for ep in episodes:
        for seg in ep.get("segments") or []:
            names.update(n for n in (seg.get("intro_drop"), (seg.get("guest") or {}).get("drop")) if n)
            names.update(t["drop"] for t in seg.get("tracks") or [] if t.get("drop"))
    return names


_TAG_RE = re.compile(r"\[(?:neutral|warm|hype|playful|tender|mysterious)\]\s*", re.I)  # voice stage directions


def _spoken(text: Any) -> str:
    return " ".join(_TAG_RE.sub("", str(text or "")).split())


_summary_cache: dict[str, Any] = {"stamp": None, "rows": []}


def summary() -> list[tuple[float, str]]:
    """(started, title) of every episode, newest first, from a cache keyed on the file's mtime and size: no segment is
    rebuilt, and nothing is parsed while the file has not changed (view() costs ~12 ms with a full archive)."""
    try:
        stat = music._path(FILE).stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        return []
    with _lock:
        if _summary_cache["stamp"] != stamp:
            rows = [(float(e.get("started") or 0), str(e.get("title") or "")) for e in _load()["episodes"]]
            _summary_cache.update(stamp=stamp, rows=sorted(rows, reverse=True))
        return list(_summary_cache["rows"])


def view() -> dict[str, Any]:
    """Newest first, slim: what the Rembobiner list shows."""
    out = []
    with _lock:
        episodes = _load()["episodes"]
    for ep in sorted(episodes, key=lambda e: -(e.get("started") or 0)):
        segments = []
        for seg in ep.get("segments") or []:
            segments.append({"title": seg.get("title"), "theme": seg.get("theme"), "show": seg.get("show"),
                             "intro": _spoken(seg.get("intro")),
                             "guest": {"who": seg["guest"].get("who"), "line": _spoken(seg["guest"].get("line"))}
                             if seg.get("guest") else None,
                             "tracks": [{**{k: t.get(k) for k in ("uri", "name", "artists", "pick", "pick_result", "pool")},
                                         "line": _spoken(t.get("line")) or None}
                                        for t in seg.get("tracks") or []]})
        out.append({"id": ep["id"], "started": ep.get("started"), "show": ep.get("show"), "title": ep.get("title"),
                    "segments": segments, "tracks": sum(len(s["tracks"]) for s in segments)})
    return {"ok": True, "episodes": out}
