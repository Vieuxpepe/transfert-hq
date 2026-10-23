"""Forge Studio phase G: the night workshop.

A small queue of NORMAL-mode generations that HQ sends to this PC's Forge "tonight"
(22:00-07:00, local time) or "when Forge is free". Private prompts are never queued:
the request is refused and nothing of it is stored. Each entry becomes an ordinary HQ job
through hq_forge_jobs.create_job, so the existing idle detection decides (Forge busy for
someone else, an HQ job or a fleet task on the local GPU -> the entry simply waits).
Nothing is ever interrupted or skipped on Forge; cancelling only affects entries not yet sent.

Guard rails: at most QUEUE_MAX entries, a night budget of NIGHT_MAX_SEC from the first
start (later entries expire), "tonight" entries expire at 07:00 if not reached, and one
quiet morning summary that the UI shows once until it is acknowledged.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

import hq_forge_gallery as gallery
import hq_forge_jobs as jobs

QUEUE_MAX = 24
KEEP_DONE = 60
NIGHT_START_HOUR = 22
NIGHT_END_HOUR = 7
NIGHT_MAX_SEC = 6 * 3600
TICK_SEC = 20.0
ENTRY_RE = re.compile(r"^nt-[0-9a-f]{24}$")
WHEN = ("tonight", "idle")
TERMINAL = {"done", "failed", "cancelled", "expired"}
FINISH_SCALES = (1.5, 2.0)
# Fields a queued generation may carry: the single-job body, minus anything about destination.
SETTING_KEYS = ("prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler", "width", "height", "steps",
                "cfg_scale", "seed", "enable_hr", "hr_scale", "hr_upscaler", "hr_second_pass_steps", "denoising_strength")

MESSAGES = {
    "private": "Les g\u00e9n\u00e9rations priv\u00e9es ne sont jamais mises en file : leur prompt ne doit pas rester sur le disque. Lancez-les vous-m\u00eame, coffre ouvert.",
    "full": "La file de nuit est pleine (24 au plus).",
    "validation": "R\u00e9glages incomplets : il faut au moins un prompt et un mod\u00e8le.",
    "none_kept": "Aucune image gard\u00e9e \u00e0 finir.",
    "not_queued": "Cette entr\u00e9e est d\u00e9j\u00e0 partie ou termin\u00e9e : elle n'est pas interrompue.",
    "expired_window": "Pas atteinte avant 7 h.",
    "expired_budget": "Limite de dur\u00e9e de la nuit atteinte.",
}

_LOCK = threading.Lock()
_clock = time.time
_thread_started = False
_thread_enabled = True


def set_clock_for_tests(clock) -> None:
    global _clock
    _clock = clock or time.time


def disable_thread_for_tests(disabled: bool = True) -> None:
    global _thread_enabled
    _thread_enabled = not disabled


def _path(root: Path) -> Path:
    folder = Path(root) / ".hq-forge"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "night.json"


def _empty() -> dict:
    return {"entries": [], "night_started": None, "summary_seen": None}


def _load(root: Path) -> dict:
    path = _path(root)
    if not path.is_file():
        return _empty()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return _empty()
    if not isinstance(data, dict) or not isinstance(data.get("entries"), list):
        return _empty()
    data.setdefault("night_started", None)
    data.setdefault("summary_seen", None)
    return data


def _save(root: Path, data: dict) -> None:
    path = _path(root)
    temporary = path.with_suffix(".json.partial")
    with temporary.open("wb") as handle:
        handle.write(json.dumps(data, ensure_ascii=False).encode("utf-8"))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="seconds")


def in_window(epoch: float) -> bool:
    hour = datetime.fromtimestamp(epoch).hour
    return hour >= NIGHT_START_HOUR or hour < NIGHT_END_HOUR


def window_end(epoch: float) -> float:
    """The 07:00 that closes the night this moment belongs to (today before 07:00, else tomorrow)."""
    moment = datetime.fromtimestamp(epoch)
    end = moment.replace(hour=NIGHT_END_HOUR, minute=0, second=0, microsecond=0)
    if moment.hour >= NIGHT_END_HOUR:
        end += timedelta(days=1)
    return end.timestamp()


def _clean_settings(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {key: raw[key] for key in SETTING_KEYS if key in raw}
    prompt = out.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
        return None
    if not isinstance(out.get("checkpoint"), str) or not out["checkpoint"]:
        return None
    return out


def _public(entry: dict) -> dict:
    settings = entry.get("settings") or {}
    return {
        "id": entry["id"], "kind": entry["kind"], "when": entry["when"], "state": entry["state"],
        "created": entry.get("created"), "started": entry.get("started"), "ended": entry.get("ended"),
        "message": entry.get("message") or "", "job_id": entry.get("job_id"), "images": entry.get("images") or [],
        "finish_of": entry.get("finish_of"),
        "label": (settings.get("prompt") or "")[:80],
    }


def _summary(data: dict) -> dict | None:
    """The quiet morning summary: entries that ended since the last acknowledgement."""
    seen = data.get("summary_seen") or ""
    ended = [e for e in data["entries"] if e["state"] in TERMINAL and e.get("ended") and e["ended"] > seen and e.get("ran_or_expired")]
    if not ended:
        return None
    counts = {state: sum(1 for e in ended if e["state"] == state) for state in ("done", "failed", "cancelled", "expired")}
    images = [image for e in ended for image in (e.get("images") or [])][:24]
    return {"counts": counts, "images": images, "until": max(e["ended"] for e in ended)}


def state(root: Path) -> tuple[int, dict]:
    with _LOCK:
        data = _load(root)
    now = _clock()
    return 200, {
        "entries": [_public(e) for e in data["entries"]],
        "window": {"start_hour": NIGHT_START_HOUR, "end_hour": NIGHT_END_HOUR, "now_in_window": in_window(now),
                   "max_hours": NIGHT_MAX_SEC // 3600, "queue_max": QUEUE_MAX},
        "summary": _summary(data),
    }


def _new_entry(kind: str, when: str, settings: dict, finish_of: str | None = None) -> dict:
    now = _clock()
    return {
        "id": "nt-" + os.urandom(12).hex(), "kind": kind, "when": when, "state": "queued", "settings": settings,
        "created": _iso(now), "deadline": window_end(now) if when == "tonight" else None,
        **({"finish_of": finish_of} if finish_of else {}),
    }


def _trim(data: dict) -> None:
    live = [e for e in data["entries"] if e["state"] not in TERMINAL]
    done = [e for e in data["entries"] if e["state"] in TERMINAL][-KEEP_DONE:]
    data["entries"] = done + live


def add(root: Path, body: dict) -> tuple[int, dict]:
    if not isinstance(body, dict):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    if body.get("destination", "normal") != "normal" or body.get("private") is not None:
        return 403, {"error": MESSAGES["private"], "code": "private"}  # nothing of it is kept
    when = body.get("when")
    settings = _clean_settings(body.get("settings"))
    if when not in WHEN or settings is None:
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        data = _load(root)
        if sum(1 for e in data["entries"] if e["state"] not in TERMINAL) >= QUEUE_MAX:
            return 409, {"error": MESSAGES["full"], "code": "full"}
        entry = _new_entry("generate", when, settings)
        data["entries"].append(entry)
        _trim(data)
        _save(root, data)
    ensure_thread(root)
    return 201, {"entry": _public(entry)}


def finish_kept(root: Path, body: dict) -> tuple[int, dict]:
    """E's 'finition' for every kept image, queued (jobs stay single-flight, so it is a queue)."""
    when = body.get("when") if isinstance(body, dict) else None
    scale = body.get("scale", 2.0) if isinstance(body, dict) else None
    upscaler = body.get("upscaler") if isinstance(body, dict) else None
    if when not in WHEN or scale not in FINISH_SCALES or not isinstance(upscaler, str) or not 0 < len(upscaler) <= 120:
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    kept = sorted(image_id for image_id, flag in gallery.triage_map(root).items() if flag in ("keep", "favorite"))
    with _LOCK:
        data = _load(root)
        queued = {e.get("finish_of") for e in data["entries"] if e["state"] not in TERMINAL}
        room = QUEUE_MAX - sum(1 for e in data["entries"] if e["state"] not in TERMINAL)
        added = []
        for image_id in kept:
            if image_id in queued:
                continue
            if len(added) >= room:
                break
            try:
                settings = gallery.get(root, image_id)["settings"]
            except Exception:
                continue
            settings = _clean_settings(settings)
            if settings is None:
                continue
            settings.update(enable_hr=True, hr_scale=scale, hr_upscaler=upscaler, hr_second_pass_steps=0, denoising_strength=0.4)
            entry = _new_entry("finish", when, settings, finish_of=image_id)
            data["entries"].append(entry)
            added.append(entry)
        if not added:
            return 409, {"error": MESSAGES["full"] if kept and room <= 0 else MESSAGES["none_kept"], "code": "full" if kept and room <= 0 else "none_kept"}
        _trim(data)
        _save(root, data)
    ensure_thread(root)
    return 201, {"added": len(added), "entries": [_public(e) for e in added]}


def cancel(root: Path, entry_id: str | None) -> tuple[int, dict]:
    """Cancels queued entries only (one, or all with entry_id None). A sent entry runs to its end."""
    now = _iso(_clock())
    with _LOCK:
        data = _load(root)
        targets = [e for e in data["entries"] if entry_id is None or e["id"] == entry_id]
        if entry_id is not None and not targets:
            return 404, {"error": "Introuvable"}
        if entry_id is not None and targets[0]["state"] != "queued":
            return 409, {"error": MESSAGES["not_queued"], "code": "not_queued"}
        count = 0
        for entry in targets:
            if entry["state"] == "queued":
                entry.update(state="cancelled", ended=now, message="Annul\u00e9e avant l'envoi.")
                count += 1
        _save(root, data)
    return 200, {"cancelled": count}


def ack(root: Path) -> tuple[int, dict]:
    with _LOCK:
        data = _load(root)
        ended = [e["ended"] for e in data["entries"] if e["state"] in TERMINAL and e.get("ended")]
        data["summary_seen"] = max(ended + [data.get("summary_seen") or ""])
        _save(root, data)
    return 200, {"ok": True}


def _expire(data: dict, now: float) -> None:
    started = data.get("night_started")
    for entry in data["entries"]:
        if entry["state"] != "queued":
            continue
        if entry["when"] == "tonight" and entry.get("deadline") and now >= entry["deadline"]:
            entry.update(state="expired", ended=_iso(now), message=MESSAGES["expired_window"], ran_or_expired=True)
        elif started and now - started > NIGHT_MAX_SEC:
            entry.update(state="expired", ended=_iso(now), message=MESSAGES["expired_budget"], ran_or_expired=True)
    if started and not any(e["state"] in ("queued", "running") for e in data["entries"]):
        data["night_started"] = None


def tick(root: Path, *, transport=None) -> str:
    """One scheduling step. Returns what it did (for tests): 'idle', 'wait', 'started', 'tracked'."""
    now = _clock()
    with _LOCK:
        data = _load(root)
        _expire(data, now)
        running = next((e for e in data["entries"] if e["state"] == "running"), None)
        _save(root, data)
    if running is not None:
        status, payload = jobs.get_job(root, running["job_id"])
        job = payload.get("job") if status == 200 else None
        job_state = job.get("state") if job else "unknown"
        if job_state in jobs.ACTIVE:
            return "tracked"
        with _LOCK:
            data = _load(root)
            entry = next((e for e in data["entries"] if e["id"] == running["id"]), None)
            if entry is not None and entry["state"] == "running":
                ok = job_state == "completed"
                entry.update(state="done" if ok else "failed", ended=_iso(_clock()), ran_or_expired=True,
                             images=[image["id"] for image in (job or {}).get("images") or [] if isinstance(image, dict) and image.get("id")],
                             message="Termin\u00e9e." if ok else ((job or {}).get("message") or "\u00c9chec."))
                _save(root, data)
        return "tracked"
    with _LOCK:
        data = _load(root)
        ready = [e for e in data["entries"] if e["state"] == "queued" and (e["when"] == "idle" or in_window(now))]
    if not ready:
        return "idle"
    entry = ready[0]
    # The existing single-job path does the idle checks: an HQ job, a fleet task on this GPU,
    # or Forge busy for its owner -> a 409 and the entry just waits for the next tick.
    body = dict(entry["settings"], destination="normal", **({"finish_of": entry["finish_of"]} if entry.get("finish_of") else {}))
    status, payload = jobs.create_job(root, body, "night-" + entry["id"][3:], transport=transport)
    with _LOCK:
        data = _load(root)
        current = next((e for e in data["entries"] if e["id"] == entry["id"]), None)
        if current is None or current["state"] != "queued":
            return "wait"
        if status in (200, 202):
            current.update(state="running", job_id=payload["job"]["job_id"], started=_iso(now), message="Envoy\u00e9e \u00e0 Forge.")
            data["night_started"] = data.get("night_started") or now
            _save(root, data)
            return "started"
        if status == 409 or status >= 500:
            current["message"] = "En attente : Forge ou le GPU est occup\u00e9."
            _save(root, data)
            return "wait"
        current.update(state="failed", ended=_iso(now), ran_or_expired=True, message=payload.get("error") or "R\u00e9glages refus\u00e9s.")
        _save(root, data)
        return "failed"


def _loop(root: Path) -> None:
    while True:
        time.sleep(TICK_SEC)
        try:
            tick(root)
        except Exception:
            pass  # never crash the bridge; the next tick retries


def ensure_thread(root: Path) -> None:
    global _thread_started
    if not _thread_enabled or _thread_started:
        return
    _thread_started = True
    threading.Thread(target=_loop, args=(Path(root),), name="hq-forge-night", daemon=True).start()


def serve_get(root: Path, raw: str) -> tuple[int, dict] | None:
    if raw == "/api/forge/night":
        ensure_thread(root)
        return state(root)
    return None


def serve_post(root: Path, raw: str, data: dict) -> tuple[int, dict] | None:
    if raw == "/api/forge/night":
        return add(root, data)
    if raw == "/api/forge/night/finish-kept":
        return finish_kept(root, data)
    if raw == "/api/forge/night/cancel-all":
        return cancel(root, None)
    if raw == "/api/forge/night/ack":
        return ack(root)
    prefix, suffix = "/api/forge/night/", "/cancel"
    if raw.startswith(prefix) and raw.endswith(suffix):
        entry_id = raw[len(prefix):-len(suffix)]
        if not ENTRY_RE.fullmatch(entry_id):
            return 404, {"error": "Introuvable"}
        return cancel(root, entry_id)
    if raw.startswith(prefix):
        return 404, {"error": "Inconnu"}
    return None