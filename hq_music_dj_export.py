"""DJ Musica — episode export and archive search.

Rembobiner already keeps every aired segment (her lines, the mixed drops, the bets). This module takes one episode
out of HQ: the drops of the episode are concatenated in airing order into a single MP3, with chapter marks computed
from their real durations, and a plain text search looks through the archived titles, lines and tracks — no model
call and no network.

Files: ``.hq-music/dj-export.json`` (the exports, newest ``KEEP_EXPORTS``) and
``.hq-music/dj-cache/episode-<episode>-<hash>.mp3``, served by the existing DJ audio route.
"""
from __future__ import annotations

import hashlib
import subprocess
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import hq_music as music
import hq_music_dj_archive as archive

STATE_FILE = "dj-export.json"
KEEP_EXPORTS = 20
MAX_SEARCH_RESULTS = 12
MAX_MATCHES = 20
_lock = threading.Lock()
_job: dict[str, Any] = {"running": False}


# ---- state ---------------------------------------------------------------------------------------------------------

def _exports(doc: dict[str, Any] | None = None) -> dict[str, Any]:
    """episode id -> export entry (the dict belongs to ``doc``: mutate it, then write ``doc``)."""
    doc = doc if doc is not None else music._load(STATE_FILE, {"exports": {}})
    exports = doc.get("exports") if isinstance(doc.get("exports"), dict) else {}
    return exports


def drop_names() -> set[str]:
    """Files still needed by an export: the DJ cache pruning spares them."""
    try:
        return {str(v.get("file")) for v in _exports().values() if v.get("file")}
    except music.MusicError:
        return set()


def view() -> dict[str, Any]:
    with _lock:
        exports = sorted(_exports().values(), key=lambda e: -(e.get("created_ts") or 0))
        job = {k: _job.get(k) for k in ("running", "episode", "stage", "error", "entry")}
    return {"ok": True, "exports": exports, "job": job}


def _stage(label: str) -> None:
    with _lock:
        _job.update(stage=label)


# ---- audio ---------------------------------------------------------------------------------------------------------

def _sequence(episode: dict[str, Any]) -> list[tuple[str, str]]:
    """(label, drop file) in airing order: her intro, the guest, the tracks, her answer to the guest."""
    out: list[tuple[str, str]] = []
    for index, seg in enumerate(episode.get("segments") or []):
        title = str(seg.get("title") or f"Segment {index + 1}")
        guest = seg.get("guest") or {}
        items = [(seg.get("intro_drop"), title),
                 (guest.get("drop"), "Invitée : " + str(guest.get("who") or "")),
                 *[(t.get("drop"), str(t.get("name") or title)) for t in seg.get("tracks") or []],
                 (guest.get("reply_drop"), "Musica répond")]
        for name, label in items:
            if name and str(name).startswith("drop-"):
                out.append((label or title, str(name)))
    return out


def _concat(names: list[str], out: Path) -> bool:
    import hq_music_dj as dj

    listing = out.with_suffix(".concat.txt")
    try:
        lines = []
        for name in names:
            path = dj.drop_path(name)  # validated name, existing plain file
            lines.append("file '" + str(path).replace("'", "'\\''") + "'")
        listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-codec:a", "libmp3lame", "-q:a", "4", str(out)],
                       check=True, timeout=300, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return out.is_file()
    except (OSError, subprocess.SubprocessError, dj.DjError):
        return False
    finally:
        listing.unlink(missing_ok=True)


def _remove_file(name: Any) -> None:
    import hq_music_dj as dj

    try:
        if name:
            dj.drop_path(str(name)).unlink(missing_ok=True)
    except (dj.DjError, OSError):
        pass


def export_episode(episode_id: Any, *, force: bool = False) -> dict[str, Any]:
    """One MP3 for the whole episode, with chapter marks. Re-exporting the same episode reuses the file."""
    import hq_music_dj as dj

    episode = archive.episode(episode_id)
    if not episode:
        raise dj.DjError("Émission introuvable dans les archives", 404, "not_found")
    sequence = _sequence(episode)
    if not sequence:
        raise dj.DjError("Cette émission n'a plus de fichiers audio à exporter", 409, "export_empty")
    names = [name for _label, name in sequence]
    digest = hashlib.sha1("|".join(names).encode()).hexdigest()[:8]
    stem = "episode-" + str(episode_id)[:12] + "-" + digest
    with _lock:
        known = dict(_exports().get(str(episode_id)) or {})
    out = dj._cache_dir() / (stem + ".mp3")
    if known.get("file") == out.name and not force and out.is_file():
        return known
    _stage("Je rassemble les morceaux de l'émission…")
    if not _concat(names, out):
        raise dj.DjError("L'export audio a échoué", 500, "export_failed")
    chapters, at = [], 0.0
    for label, name in sequence:
        chapters.append({"title": label, "at": round(at)})
        at += dj._drop_seconds([name])
    entry = {"episode": str(episode_id), "title": episode.get("title") or "Émission", "show": episode.get("show"),
             "file": out.name, "audio_url": "/api/musica/dj/audio/" + out.name,
             "seconds": round(at), "chapters": chapters, "drops": len(sequence),
             "segments": len(episode.get("segments") or []), "created": datetime.now().isoformat(timespec="seconds"),
             "created_ts": time.time()}
    with _lock:
        doc = music._load(STATE_FILE, {"exports": {}})
        exports = _exports(doc)
        exports[str(episode_id)] = entry
        for stale in sorted(exports.values(), key=lambda e: -(e.get("created_ts") or 0))[KEEP_EXPORTS:]:
            _remove_file(stale.get("file"))
            exports.pop(str(stale.get("episode")), None)
        doc["exports"] = exports
        music._write(STATE_FILE, doc)
    if known.get("file") and known.get("file") != out.name:
        _remove_file(known.get("file"))
    return entry


def begin(episode_id: Any, *, force: bool = False) -> dict[str, Any]:
    """Start the export in the background: mixing a long episode is not an HTTP request."""
    with _lock:
        busy = bool(_job.get("running"))
        if not busy:
            _job.clear()
            _job.update(running=True, episode=str(episode_id), stage="Je prépare l'export…", error=None, entry=None)
    if busy:
        return {**view(), "started": False}

    def run() -> None:
        try:
            entry = export_episode(episode_id, force=force)
            with _lock:
                _job.update(running=False, stage="Prêt", error=None, entry=entry)
        except Exception as exc:  # noqa: BLE001 — shown on the card
            with _lock:
                _job.update(running=False, error=str(exc)[:200])

    threading.Thread(target=run, daemon=True, name="dj-export").start()
    return {**view(), "started": True}


# ---- search --------------------------------------------------------------------------------------------------------

def _norm(text: Any) -> str:
    return " ".join(str(text or "").casefold().split())


def search(query: Any, *, limit: int = MAX_SEARCH_RESULTS) -> dict[str, Any]:
    """Plain text search in the archive: titles, themes, her lines and the tracks she played."""
    key = _norm(query)[:120]
    if not key:
        return {"ok": True, "query": "", "results": [], "count": 0}
    tokens = [t for t in key.split() if len(t) > 1] or [key]
    results: list[dict[str, Any]] = []
    matches = 0
    for episode in archive.view().get("episodes") or []:
        found: list[dict[str, Any]] = []
        for index, segment in enumerate(episode.get("segments") or []):
            guest = segment.get("guest") or {}
            haystacks: list[tuple[str, str, str]] = [
                ("segment", str(segment.get("title") or ""), str(segment.get("theme") or "")),
                ("intro", str(segment.get("intro") or ""), ""),
            ]
            if guest.get("line"):
                haystacks.append(("guest", str(guest.get("line") or ""), "Invitée : " + str(guest.get("who") or "")))
            for track in segment.get("tracks") or []:
                haystacks.append(("track", " ".join([str(track.get("name") or ""),
                                                     ", ".join(str(a) for a in track.get("artists") or [])]),
                                  str(track.get("line") or "")))
            for kind, text, extra in haystacks:
                if not (text or extra):
                    continue
                blob = _norm(text + " " + extra)
                if all(token in blob for token in tokens):
                    found.append({"kind": kind, "segment": index, "segment_title": segment.get("title"),
                                  "text": (text or extra)[:240]})
                    matches += 1
                    if matches >= MAX_MATCHES:
                        break
            if matches >= MAX_MATCHES:
                break
        if found:
            results.append({"id": episode.get("id"), "title": episode.get("title"),
                            "started": episode.get("started"), "show": episode.get("show"), "matches": found})
            if len(results) >= limit:
                break
    return {"ok": True, "query": str(query)[:120], "results": results, "count": matches}
