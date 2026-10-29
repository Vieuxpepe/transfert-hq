"""Accueil 'Aujourd'hui': what happened since yesterday, one calm list.

Pure: the bridge passes the sources in (events, Forge jobs, Carnet page metadata, companion devices,
Inbox file times). Nothing is read here directly except the bounded Inbox scan helper, and nothing is
written. Lines carry counts, never file names, prompts or note text. Private Forge jobs are skipped
entirely (the vault stays out of every summary).
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

WINDOW_SEC = 24 * 3600
MAX_ITEMS = 12
INBOX_SCAN_MAX = 5000  # directory entries looked at, at most, per request


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


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
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.timestamp()
    return None


def inbox_times(inbox: Path, since: float, *, limit: int = INBOX_SCAN_MAX) -> list[float]:
    """Modification times (>= since) of files in Inbox and its direct subfolders. Hidden and
    underscore entries are skipped; links are not followed; at most `limit` entries are looked at."""
    out: list[float] = []
    seen = 0
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
                folders.append(entry.path)
            elif entry.is_file(follow_symlinks=False):
                mtime = entry.stat(follow_symlinks=False).st_mtime
                if mtime >= since:
                    out.append(mtime)
        except OSError:
            continue
    for folder in folders:
        try:
            children = os.scandir(folder)
        except OSError:
            continue
        with children:
            for entry in children:
                seen += 1
                if seen > limit:
                    return out
                if entry.name.startswith((".", "_")):
                    continue
                try:
                    if entry.is_file(follow_symlinks=False):
                        mtime = entry.stat(follow_symlinks=False).st_mtime
                        if mtime >= since:
                            out.append(mtime)
                except OSError:
                    continue
    return out


def build(*, now: float, events=(), jobs=(), pages=(), devices=(), inbox=(), window: float = WINDOW_SEC) -> dict:
    """The 'Depuis hier' list, newest first. Each item: at (seconds), kind, level (info|warn), text, and nav
    (the view a tap opens: fichiers, forge, carnet, ops; empty when there is nothing more to see)."""
    since = now - window
    items: list[dict] = []

    def add(at: float, kind: str, text: str, nav: str, level: str = "info") -> None:
        items.append({"at": at, "kind": kind, "level": level, "text": text, "nav": nav})

    arrived = [t for t in inbox if isinstance(t, (int, float)) and since <= t <= now + 60]
    if arrived:
        add(max(arrived), "inbox", _plural(len(arrived), "fichier arrivé", "fichiers arrivés") + " dans Inbox", "fichiers")

    done_images = done_jobs = failed = 0
    done_at = failed_at = 0.0
    for job in jobs or ():
        if not isinstance(job, dict) or job.get("destination") == "private":
            continue  # the vault never reaches a summary
        at = _ts(job.get("updated")) or _ts(job.get("created"))
        if at is None or at < since:
            continue
        state = job.get("state")
        if state == "completed":
            done_jobs += 1
            done_images += sum(1 for image in job.get("images") or () if isinstance(image, dict))
            done_at = max(done_at, at)
        elif state == "failed":
            failed += 1
            failed_at = max(failed_at, at)
    if done_jobs:
        add(done_at, "forge", "Forge : " + _plural(done_images or done_jobs, "image terminée", "images terminées"), "forge")
    if failed:
        add(failed_at, "forge_failed", "Forge : " + _plural(failed, "génération a échoué", "générations ont échoué"), "forge", "warn")

    changed = [p for p in pages or () if isinstance(p, dict) and not p.get("deleted_at")
               and isinstance(p.get("updated_at"), (int, float)) and p["updated_at"] >= since]
    if changed:
        add(max(p["updated_at"] for p in changed), "carnet",
            "Carnet : " + _plural(len(changed), "page modifiée", "pages modifiées"), "carnet")

    for device in devices or ():
        if not isinstance(device, dict) or device.get("revoked") or device.get("online"):
            continue
        seen = _ts(device.get("last_seen"))
        if seen is None or seen <= 0 or seen < since:
            continue  # offline for longer than the window: not news today
        name = str(device.get("name") or device.get("hostname") or "Un PC")[:40]
        add(seen, "device", f"{name} hors ligne", "", "warn")  # Appareils is already on Accueil

    backups = [e for e in events or () if isinstance(e, dict) and e.get("kind") == "backup"]
    alerts = [e for e in events or () if isinstance(e, dict) and e.get("kind") == "alert" and e.get("level") in ("warning", "error")]
    runs = [e for e in events or () if isinstance(e, dict) and e.get("kind") in ("scene", "automation", "calendar_run")]
    recent = lambda rows: [e for e in rows if isinstance(e.get("ts"), (int, float)) and e["ts"] >= since]
    backups, alerts, runs = recent(backups), recent(alerts), recent(runs)
    if backups:
        last = max(backups, key=lambda e: e["ts"])
        bad = last.get("level") in ("warning", "error")
        add(last["ts"], "backup", "Sauvegarde : problème signalé" if bad else "Sauvegarde terminée", "ops", "warn" if bad else "info")
    if alerts:
        add(max(e["ts"] for e in alerts), "alert", _plural(len(alerts), "alerte", "alertes") + " dans le journal", "ops", "warn")
    if runs:
        add(max(e["ts"] for e in runs), "runs", _plural(len(runs), "scène ou automatisme lancé", "scènes ou automatismes lancés"), "ops")

    items.sort(key=lambda item: item["at"], reverse=True)
    return {"since": since, "now": now, "items": items[:MAX_ITEMS]}
