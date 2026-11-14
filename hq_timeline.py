"""Time machine: every moment of the last day or week, on one track, for the scrub bar.

Pure apart from the bounded Inbox scan helper (``inbox_files``): the bridge passes the other sources in (journal events,
public Forge gallery rows, Carnet page metadata, manual calendar events). Nothing is written.

Privacy: the private vault never reaches this module (the bridge passes the PUBLIC gallery only, and private Forge jobs are
not a source at all). Forge moments carry an image thumbnail, never a prompt. Carnet moments carry the page title (the same
title the Ctrl+K palette already shows). Files carry their name and folder, like Fichiers.

Each moment: ``{at, lane, kind, title, sub, thumb, open}`` where ``open`` is a palette-shaped hit the client already knows
how to open (``page``, ``prompt``, ``event``, ``file``) or None.
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

SPANS = {"day": 24 * 3600, "week": 7 * 24 * 3600}
LANES = ("forge", "carnet", "fichiers", "calendrier", "systeme")
MAX_MOMENTS = 600
MAX_PER_LANE = 240
INBOX_SCAN_MAX = 6000
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
AUDIO_EXTS = {".m4a", ".mp3", ".wav", ".ogg", ".opus", ".webm", ".flac", ".aac"}
VIDEO_EXTS = {".mp4", ".mov", ".m4v"}
DRAWING_SUFFIX = ".hqdraw.json"
# Journal kinds worth a moment. The rest (presence pings, debug chatter) would only bury the day.
EVENT_KINDS = {
    "backup": "Sauvegarde",
    "alert": "Alerte",
    "scene": "Scène",
    "automation": "Automatisme",
    "calendar_run": "Rappel",
    "print": "Impression",
    "upload": "Envoi",
    "transfer": "Transfert",
    "device": "Appareil",
}


def _ts(value) -> float | None:
    """Seconds since the epoch from a number or an ISO string ('Z' or offset); None otherwise."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str) and value:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.astimezone()  # naive stamps are local wall time
        return parsed.timestamp()
    return None


def _clip(text, limit: int) -> str:
    return " ".join(str(text or "").split())[:limit]


def span_seconds(name) -> int:
    if name not in SPANS:
        raise ValueError("span invalide")
    return SPANS[name]


def inbox_files(inbox: Path, since: float, *, limit: int = INBOX_SCAN_MAX) -> list[dict]:
    """Files of Inbox and its direct subfolders modified at or after ``since``: ``{rel, name, dir, mtime}``.
    Hidden and underscore entries are skipped, links are not followed, at most ``limit`` entries are looked at."""
    out: list[dict] = []
    seen = 0
    base = inbox.name

    def take(entry, folder_rel: str) -> None:
        try:
            if not entry.is_file(follow_symlinks=False):
                return
            mtime = entry.stat(follow_symlinks=False).st_mtime
        except OSError:
            return
        if mtime >= since:
            out.append({"rel": folder_rel + "/" + entry.name, "name": entry.name, "dir": folder_rel, "mtime": mtime})

    try:
        top = list(os.scandir(inbox))
    except OSError:
        return out
    folders = []
    for entry in top:
        seen += 1
        if seen > limit:
            return out
        if entry.name.startswith((".", "_")):
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                folders.append(entry)
                continue
        except OSError:
            continue
        take(entry, base)
    for folder in folders:
        try:
            children = os.scandir(folder.path)
        except OSError:
            continue
        with children:
            for entry in children:
                seen += 1
                if seen > limit:
                    return out
                if not entry.name.startswith((".", "_")):
                    take(entry, base + "/" + folder.name)
    return out


def _file_moments(files, since: float, now: float) -> list[dict]:
    """One moment per arrived file. A drawing (``x.hqdraw.json`` + its PNG/DXF/STL companions) is ONE moment."""
    out: list[dict] = []
    drawings: dict[str, dict] = {}
    for f in files or ():
        if not isinstance(f, dict):
            continue
        at, rel, name, folder = f.get("mtime"), f.get("rel"), f.get("name"), f.get("dir")
        if not isinstance(at, (int, float)) or not (since <= at <= now + 60):
            continue
        if not all(isinstance(v, str) and v for v in (rel, name, folder)):
            continue
        low = name.lower()
        if folder.endswith("/Drawings"):
            stem = name[: -len(DRAWING_SUFFIX)] if low.endswith(DRAWING_SUFFIX) else os.path.splitext(name)[0]
            d = drawings.setdefault(stem, {"at": at, "dir": folder, "png": None})
            d["at"] = max(d["at"], at)
            if low.endswith(".png"):
                d["png"] = rel
            continue
        ext = os.path.splitext(low)[1]
        kind = "photo" if ext in IMAGE_EXTS else "audio" if ext in AUDIO_EXTS else "video" if ext in VIDEO_EXTS else "file"
        out.append({
            "at": at, "lane": "fichiers", "kind": kind, "title": _clip(name, 80), "sub": folder.replace("/", " / "),
            "thumb": "/files/" + rel if kind == "photo" else None,
            "open": {"kind": "file", "id": rel, "dir": folder},
        })
    for stem, d in drawings.items():
        out.append({
            "at": d["at"], "lane": "fichiers", "kind": "drawing", "title": _clip(stem.replace("_", " "), 80), "sub": "Dessin",
            "thumb": "/files/" + d["png"] if d["png"] else None,
            "open": {"kind": "file", "id": d["dir"] + "/" + stem, "dir": d["dir"]},
        })
    return out


def build(*, now: float, span: str = "day", events=(), gallery=(), pages=(), files=(), calendar=()) -> dict:
    """Moments in ``[now - span, now]`` (calendar events may extend a little past now: the rest of today), oldest first."""
    width = span_seconds(span)
    since = now - width
    moments: list[dict] = []

    for image in gallery or ():
        if not isinstance(image, dict) or not isinstance(image.get("id"), str):
            continue
        at = _ts(image.get("created"))
        if at is None or not (since <= at <= now + 60):
            continue
        moments.append({
            "at": at, "lane": "forge", "kind": "image", "title": "Image Forge", "sub": "",
            "thumb": image.get("thumb") if isinstance(image.get("thumb"), str) else None,
            "open": {"kind": "prompt", "id": image["id"]},
        })

    for page in pages or ():
        if not isinstance(page, dict) or page.get("deleted_at") or not isinstance(page.get("id"), str):
            continue
        title = _clip(page.get("title"), 80) or "Page sans titre"
        created, updated = page.get("created_at"), page.get("updated_at")
        if isinstance(created, (int, float)) and since <= created <= now + 60:
            moments.append({"at": float(created), "lane": "carnet", "kind": "page_new", "title": title, "sub": "Nouvelle page",
                            "thumb": None, "open": {"kind": "page", "id": page["id"]}})
        if isinstance(updated, (int, float)) and since <= updated <= now + 60 and (
                not isinstance(created, (int, float)) or updated - created > 60):
            moments.append({"at": float(updated), "lane": "carnet", "kind": "page_edit", "title": title, "sub": "Modifiée",
                            "thumb": None, "open": {"kind": "page", "id": page["id"]}})

    moments.extend(_file_moments(files, since, now))

    for item in calendar or ():
        if not isinstance(item, dict):
            continue
        at = item.get("at")
        if not isinstance(at, (int, float)) or not (since <= at <= now + width * 0.25):
            continue
        day = item.get("day") if isinstance(item.get("day"), str) else ""
        moments.append({"at": float(at), "lane": "calendrier", "kind": "event", "title": _clip(item.get("title"), 80) or "Événement",
                        "sub": "Toute la journée" if item.get("all_day") else "", "thumb": None,
                        "open": {"kind": "event", "id": str(item.get("id") or "")[:64], "at": day}})

    for event in events or ():
        if not isinstance(event, dict):
            continue
        kind = str(event.get("kind") or "")
        at = event.get("ts")
        if kind not in EVENT_KINDS or not isinstance(at, (int, float)) or not (since <= at <= now + 60):
            continue
        level = event.get("level")
        moments.append({"at": float(at), "lane": "systeme", "kind": kind, "title": _clip(event.get("message"), 100) or EVENT_KINDS[kind],
                        "sub": EVENT_KINDS[kind], "thumb": None, "open": None,
                        "level": "warn" if level in ("warning", "error") else "info"})

    # Newest win when a lane overflows: the track always reaches 'now'.
    moments.sort(key=lambda m: m["at"], reverse=True)
    kept: list[dict] = []
    per_lane: dict[str, int] = {}
    for m in moments:
        n = per_lane.get(m["lane"], 0)
        if n >= MAX_PER_LANE:
            continue
        per_lane[m["lane"]] = n + 1
        kept.append(m)
        if len(kept) >= MAX_MOMENTS:
            break
    kept.sort(key=lambda m: m["at"])
    counts = {lane: per_lane.get(lane, 0) for lane in LANES}
    return {"ok": True, "span": span, "since": since, "now": now, "moments": kept, "counts": counts,
            "truncated": len(kept) < len(moments)}


def calendar_rows(events) -> list[dict]:
    """Manual calendar events (``hq_calendar.manual_between`` rows) as ``{at, title, id, day, all_day}``.
    ``start`` is local wall time: 'YYYY-MM-DDTHH:MM', or 'YYYY-MM-DD' for an all-day event (placed at local midnight)."""
    out = []
    for e in events or ():
        if not isinstance(e, dict):
            continue
        start = str(e.get("start") or "").strip()
        all_day = bool(e.get("all_day"))
        try:
            moment = datetime.strptime(start[:10], "%Y-%m-%d") if all_day else datetime.strptime(start[:16].replace(" ", "T"), "%Y-%m-%dT%H:%M")
        except ValueError:
            continue
        out.append({"at": moment.astimezone().timestamp(), "title": e.get("title"), "id": e.get("id"), "day": start[:10], "all_day": all_day})
    return out


__all__ = ["SPANS", "LANES", "build", "inbox_files", "calendar_rows", "span_seconds"]
