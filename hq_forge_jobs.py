"""HQ-managed Forge text-to-image jobs.

Live cancellation is deferred. Forge's interrupt flag is process-wide and
can stop a job HQ does not own, so a timeout or a cancel after submit never
calls it. A job still queued inside HQ can be cancelled locally.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import hq_forge as forge
import hq_forge_gallery as gallery
import hq_forge_stats as stats
import hq_forge_vault as vault

TERMINAL = {"completed", "failed", "cancelled", "unknown"}
ACTIVE = {"queued", "starting", "generating", "saving"}
JOB_RE = re.compile(r"^job-[0-9a-f]{24}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
TASK_RE = re.compile(r"^task\(hq-[0-9a-f]{24}\)$")
BODY_KEYS = {
    "prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler",
    "width", "height", "steps", "cfg_scale", "seed", "n_iter", "batch_size",
    "enable_hr", "hr_scale", "hr_upscaler", "hr_second_pass_steps", "denoising_strength",
    "destination", "wait_if_busy", "subseed", "subseed_strength",
}

_LOCK = threading.Lock()
_generation = 0
_recovered = False
_before_submit = None
_job_timeout = forge.JOB_TIMEOUT_SEC
_poll_interval = 1.0
_external_busy = None
# B: how long a normal job politely waits for Forge to finish someone else's work.
WAIT_TIMEOUT_SEC = 600.0
_wait_timeout = WAIT_TIMEOUT_SEC

_MESSAGES = {
    "forge_offline": "Forge n'est pas démarré.",
    "api_disabled": "Forge est ouvert, mais son API n'est pas activée.",
    "catalog_empty": "Forge répond, mais le catalogue utilisable est vide.",
    "forge_timeout": "HQ a cessé d'attendre. Forge n'a pas été interrompu.",
    "forge_busy": "Forge est déjà en train de générer.",
    "waiting": "Forge occup\u00e9, en attente.",
    "busy_timeout": "Forge est rest\u00e9 occup\u00e9. Rien n'a \u00e9t\u00e9 envoy\u00e9.",
    "start_now": "Envoy\u00e9 \u00e0 Forge, \u00e0 la suite de son travail en cours.",
    "bad_image": "Forge a renvoyé une image inutilisable.",
    "quota": "Le quota de la galerie est atteint. Rien n'a été effacé.",
    "disk": "Espace disque insuffisant.",
    "forge_error": "Forge a renvoyé une réponse inutilisable.",
    "forge_oom": "Forge a manqu\u00e9 de m\u00e9moire GPU pour ces r\u00e9glages.",
    "forge_http": "Forge a répondu par un code d'erreur.",
    "forge_malformed": "Forge a renvoyé un JSON illisible.",
    "forge_schema": "Forge a renvoyé un résultat inattendu.",
    "hq_restart": "HQ a redémarré pendant ce travail. Il n'a pas été relancé.",
    "stopped": "Forge s'est arrêté.",
    "cancelled": "Annulé avant l'envoi à Forge.",
    "deferred": "HQ ne peut pas arrêter une génération déjà envoyée à Forge. L'interruption globale pourrait couper un autre travail.",
    "active": "Une génération HQ est déjà en cours.",
    "validation": "Les réglages ne sont pas acceptés.",
    "private_restricted": "Hires. fix n'est pas disponible en génération privée.",
    "disabled": vault.public_error("disabled"),
    "locked": vault.public_error("locked"),
    "missing": vault.public_error("missing"),
    "vault_locked": "Le coffre s'est verrouillé avant l'enregistrement. L'image n'a pas été conservée.",
}


def reset_for_tests() -> None:
    global _generation, _recovered, _before_submit, _job_timeout, _poll_interval, _wait_timeout
    _generation += 1
    _wait_timeout = WAIT_TIMEOUT_SEC
    _recovered = False
    _before_submit = None
    _job_timeout = forge.JOB_TIMEOUT_SEC
    _poll_interval = 1.0
    gallery.reset_for_tests()
    vault.reset_for_tests()


def set_external_busy(callback) -> None:
    """Multi-device batches share the local Forge. While one of their local tasks
    runs, the single-job path refuses a new job, exactly as for its own jobs."""
    global _external_busy
    _external_busy = callback


def _external_active() -> bool:
    try:
        return bool(_external_busy()) if _external_busy is not None else False
    except Exception:
        return True


def local_active(root: Path) -> bool:
    """True while an HQ single job is queued or running on the local Forge."""
    with _LOCK:
        return _active_job(_load(root)) is not None


def set_before_submit_for_tests(callback) -> None:
    global _before_submit
    _before_submit = callback


def set_job_timeout_for_tests(seconds: float | None) -> None:
    global _job_timeout
    _job_timeout = forge.JOB_TIMEOUT_SEC if seconds is None else float(seconds)


def set_wait_timeout_for_tests(seconds: float | None) -> None:
    global _wait_timeout
    _wait_timeout = WAIT_TIMEOUT_SEC if seconds is None else float(seconds)


def set_poll_interval_for_tests(seconds: float | None) -> None:
    global _poll_interval
    _poll_interval = 1.0 if seconds is None else float(seconds)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _store_path(root: Path) -> Path:
    folder = Path(root) / ".hq-forge"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "jobs.json"


def _load(root: Path) -> dict:
    path = _store_path(root)
    if not path.is_file():
        return {"jobs": [], "idempotency": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"jobs": [], "idempotency": {}}
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), list) or not isinstance(data.get("idempotency"), dict):
        return {"jobs": [], "idempotency": {}}
    return data


def _save(root: Path, data: dict) -> None:
    path = _store_path(root)
    temporary = path.with_suffix(".json.partial")
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    with temporary.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def recover(root: Path) -> None:
    global _recovered
    with _LOCK:
        if _recovered:
            return
        _recovered = True
        gallery.cleanup_partials(root)
        vault.cleanup_partials(root)
        data = _load(root)
        changed = False
        for job in data["jobs"]:
            if isinstance(job, dict) and job.get("state") not in TERMINAL:
                job["state"] = "unknown"
                job["error"] = "hq_restart"
                job["message"] = _MESSAGES["hq_restart"]
                job["updated"] = _now()
                changed = True
        if changed:
            _save(root, data)


def _public(job: dict, *, unlocked: bool = False) -> dict:
    private = job.get("destination") == "private"
    images = []
    for item in job.get("images") or []:
        if not isinstance(item, dict):
            continue
        image_id = str(item.get("id") or "")
        if private:
            if not unlocked or not vault.ID_RE.fullmatch(image_id):
                continue
        elif not gallery.IMG_RE.fullmatch(image_id):
            continue
        images.append({"id": image_id, "width": item.get("width"), "height": item.get("height")})
    return {
        "job_id": job.get("id"),
        "state": job.get("state"),
        "destination": "private" if private else "normal",
        "progress": job.get("progress") or 0,
        "step": job.get("step") or 0,
        "steps": job.get("steps") or 0,
        "progress_stale": bool(job.get("progress_stale")),
        "eta": _eta_public(job),
        "message": job.get("message") or "",
        "error": job.get("error") or "",
        "images": images,
        "settings": {} if private else (job.get("settings") or {}),
        "seed_used": None if private and not unlocked else job.get("seed_used"),
        "cancel": "unchanged" if job.get("state") in TERMINAL else ("deferred" if job.get("submitted") else "local"),
        "waiting": bool(job.get("waiting") and job.get("state") == "queued" and not job.get("submitted")),
        "forced": bool(job.get("force")),
        "locked": bool(private and not unlocked),
        "created": job.get("created"),
        "updated": job.get("updated"),
        "diagnostic": _diagnostic(job.get("diagnostic")),
        # Phase D journal: times only (no prompt), and the owner's choice for an uncertain job.
        "started_at": job.get("started_at"),
        "finished_at": job.get("finished_at"),
        "duration_ms": job.get("duration_ms"),
        "resolution": job.get("resolution") if job.get("resolution") in ("lost", "kept") else None,
    }


def _eta_public(job: dict) -> float | None:
    if job.get("state") not in ACTIVE or job.get("progress_stale"):
        return None
    return forge.eta_seconds({"eta_relative": job.get("eta")})


DURATION_SAMPLES = 20
DURATION_MIN_SAMPLES = 3
DURATION_MAX_BUCKETS = 64


def _bucket(width, height, steps, hires) -> str | None:
    if not all(isinstance(v, int) and not isinstance(v, bool) for v in (width, height, steps)):
        return None
    if not (64 <= width <= 4096 and 64 <= height <= 4096 and 1 <= steps <= 150):
        return None
    return f"{width}x{height}:{steps}:{'hr' if hires is True else 'base'}"


def _record_duration(root: Path, settings: dict, seconds: float, token: int) -> None:
    """Keep the last 20 wall-clock durations per (width, height, steps, hires).
    Normal jobs only; nothing about a private job is kept here."""
    if token != _generation or not math.isfinite(seconds) or seconds <= 0 or seconds > forge.JOB_TIMEOUT_SEC:
        return
    per_image = seconds / max(1, int(settings.get("n_iter") or 1))
    key = _bucket(settings.get("width"), settings.get("height"), settings.get("steps"), settings.get("enable_hr"))
    if key is None:
        return
    with _LOCK:
        data = _load(root)
        table = data.get("durations") if isinstance(data.get("durations"), dict) else {}
        rows = [v for v in table.get(key, []) if isinstance(v, (int, float)) and not isinstance(v, bool)]
        rows.append(round(per_image, 1))
        table.pop(key, None)
        table[key] = rows[-DURATION_SAMPLES:]
        while len(table) > DURATION_MAX_BUCKETS:
            table.pop(next(iter(table)))
        data["durations"] = table
        _save(root, data)


def usual_duration(root: Path, query: str) -> tuple[int, dict]:
    from urllib.parse import parse_qs
    qs = parse_qs(query or "")
    def number(name):
        try:
            return int((qs.get(name) or [""])[0])
        except ValueError:
            return None
    key = _bucket(number("width"), number("height"), number("steps"), (qs.get("hires") or ["0"])[0] == "1")
    if key is None:
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    count = max(1, min(2, number("n_iter") or 1))
    with _LOCK:
        table = _load(root).get("durations")
    rows = table.get(key, []) if isinstance(table, dict) else []
    rows = sorted(v for v in rows if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v > 0)
    if len(rows) < DURATION_MIN_SAMPLES:
        return 200, {"samples": len(rows), "seconds": None}
    middle = len(rows) // 2
    median = rows[middle] if len(rows) % 2 else (rows[middle - 1] + rows[middle]) / 2
    return 200, {"samples": len(rows), "seconds": round(median * count)}


def _session_open(root: Path, token: str | None) -> bool:
    if not token:
        return False
    try:
        return bool(vault.status(root, token).get("unlocked"))
    except Exception:
        return False


def _find(data: dict, job_id: str) -> dict | None:
    for job in data["jobs"]:
        if isinstance(job, dict) and job.get("id") == job_id:
            return job
    return None


def _mutate(root: Path, job_id: str, token: int, **fields) -> None:
    if token != _generation:
        return
    with _LOCK:
        if token != _generation:
            return
        data = _load(root)
        job = _find(data, job_id)
        if job is None:
            return
        if job.get("state") == "cancelled" and fields.get("state") == "completed":
            return
        if job.get("state") in TERMINAL and fields.get("state") not in TERMINAL and "state" in fields:
            return
        job.update(fields)
        job["updated"] = _now()
        _save(root, data)


def _text(value, limit: int, *, required: bool) -> str | None:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        return None
    text = value.replace("\r\n", "\n").strip()
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in text):
        return None
    if len(text) > limit or (required and not text):
        return None
    return text


def _int(value, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < low or value > high:
        return None
    return value


def submission_body(settings: dict, task_id: str) -> dict:
    if not TASK_RE.fullmatch(task_id):
        raise ValueError("task")
    body = {
        "prompt": settings["prompt"],
        "negative_prompt": settings.get("negative_prompt") or "",
        "seed": settings["seed"],
        "sampler_name": settings["sampler_name"],
        "scheduler": settings.get("scheduler") or "automatic",
        "steps": settings["steps"],
        "cfg_scale": settings["cfg_scale"],
        "width": settings["width"],
        "height": settings["height"],
        "batch_size": 1,
        "n_iter": settings["n_iter"],
        "save_images": False,
        "send_images": True,
        "script_name": "",
        "script_args": [],
        "alwayson_scripts": {},
        "force_task_id": task_id,
        "override_settings_restore_afterwards": True,
    }
    if settings.get("checkpoint"):
        body["override_settings"] = {"sd_model_checkpoint": settings["checkpoint"]}
    if settings.get("subseed_strength"):
        body["subseed"] = settings["subseed"]
        body["subseed_strength"] = settings["subseed_strength"]
    if settings.get("enable_hr"):
        body["enable_hr"] = True
        body["hr_scale"] = settings["hr_scale"]
        body["hr_upscaler"] = settings["hr_upscaler"]
        body["hr_second_pass_steps"] = settings["hr_second_pass_steps"]
        body["denoising_strength"] = settings["denoising_strength"]
        body["hr_resize_x"] = 0
        body["hr_resize_y"] = 0
    return body


def _finite(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number


def _scale(value) -> float | None:
    number = _finite(value)
    if number is None:
        return None
    if abs(number - 1.5) < 1e-6:
        return 1.5
    if abs(number - 2.0) < 1e-6:
        return 2.0
    return None


def _denoise(value) -> float | None:
    number = _finite(value)
    if number is None:
        return None
    number = round(number, 2)
    if number < 0.2 or number > 0.7:
        return None
    return number


def _hires(data: dict, catalog: dict, width: int, height: int) -> dict | tuple:
    enabled = data.get("enable_hr", False)
    if enabled in (False, None):
        return {
            "enable_hr": False,
            "hr_scale": 2.0,
            "hr_upscaler": "",
            "hr_second_pass_steps": 0,
            "denoising_strength": 0.5,
        }
    if enabled is not True:
        return ("validation",)
    scale = _scale(data.get("hr_scale", 2))
    second = _int(data.get("hr_second_pass_steps", 0), 0, 20)
    denoise = _denoise(data.get("denoising_strength", 0.5))
    upscaler = data.get("hr_upscaler")
    names = {item.get("name") for item in catalog.get("upscalers") or [] if isinstance(item, dict)}
    if scale is None or second is None or denoise is None:
        return ("validation",)
    if not isinstance(upscaler, str) or not upscaler or upscaler not in names:
        return ("validation",)
    if round(width * scale) > 2048 or round(height * scale) > 2048:
        return ("validation",)
    return {
        "enable_hr": True,
        "hr_scale": scale,
        "hr_upscaler": upscaler,
        "hr_second_pass_steps": second,
        "denoising_strength": denoise,
    }


def _validate(data: dict, catalog: dict) -> dict | tuple:
    if not isinstance(data, dict) or set(data) - BODY_KEYS:
        return ("validation",)
    prompt = _text(data.get("prompt"), 2000, required=True)
    negative = _text(data.get("negative_prompt", ""), 1000, required=False)
    width = _int(data.get("width", 512), 256, 1536)
    height = _int(data.get("height", 512), 256, 1536)
    steps = _int(data.get("steps", 20), 1, 40)
    variation = _variation(data)
    if variation is None:
        return ("validation",)
    n_iter = _int(data.get("n_iter", 1), 1, VARIATION_MAX if variation else 2)
    seed = _int(data.get("seed", -1), -1, 2**32 - 1)
    if variation and (seed is None or seed < 0):
        return ("validation",)  # a variation always keeps the original, fixed seed
    batch = _int(data.get("batch_size", 1), 1, 1)
    cfg = data.get("cfg_scale", 7)
    if isinstance(cfg, bool) or not isinstance(cfg, (int, float)) or not 1 <= float(cfg) <= 15:
        cfg = None
    if None in (prompt, negative, width, height, steps, n_iter, seed, batch, cfg):
        return ("validation",)
    if width % 64 or height % 64:
        return ("validation",)
    names = {item.get("name") for item in catalog.get("samplers") or [] if isinstance(item, dict)}
    schedulers = {item.get("name") for item in catalog.get("schedulers") or [] if isinstance(item, dict)}
    sampler = data.get("sampler_name")
    scheduler = data.get("scheduler") or "automatic"
    if not isinstance(sampler, str) or sampler not in names:
        return ("validation",)
    if not isinstance(scheduler, str) or scheduler not in schedulers:
        return ("validation",)
    checkpoint = data.get("checkpoint") or ""
    titles = {item.get("title") for item in catalog.get("models") or [] if isinstance(item, dict)}
    if not isinstance(checkpoint, str) or not checkpoint or checkpoint not in titles:
        return ("validation",)
    hires = _hires(data, catalog, width, height)
    if isinstance(hires, tuple):
        return hires
    return {
        "prompt": prompt,
        "negative_prompt": negative,
        "checkpoint": checkpoint,
        "sampler_name": sampler,
        "scheduler": scheduler,
        "width": width,
        "height": height,
        "steps": steps,
        "cfg_scale": float(cfg),
        "seed": seed,
        "n_iter": n_iter,
        "batch_size": 1,
        **hires,
        **variation,
    }


VARIATION_MAX = 6


def _variation(data: dict) -> dict | None:
    """C: 'Explorer autour'. {} when off, None when invalid. A missing variation seed is
    drawn here so every image's subseed is known and recorded."""
    strength = data.get("subseed_strength", 0)
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not math.isfinite(float(strength)):
        return None
    strength = float(strength)
    if strength == 0:
        return {} if data.get("subseed", -1) in (-1, None) else None
    if not 0 < strength <= 1:
        return None
    subseed = _int(data.get("subseed", -1), -1, 2**32 - 1)
    if subseed is None:
        return None
    if subseed < 0:
        subseed = int.from_bytes(os.urandom(4), "big")
    return {"subseed": subseed, "subseed_strength": round(strength, 3)}


def subseeds_used(parsed: dict, settings: dict, count: int) -> list[int]:
    """Forge's rule: all_subseeds = subseed + index (processing.py), seed stays fixed."""
    base = settings.get("subseed")
    listed = _info(parsed).get("all_subseeds")
    out = []
    for index in range(count):
        value = _seed_int(listed[index]) if isinstance(listed, list) and index < len(listed) else None
        out.append(value if value is not None else (base + index) % (2**32))
    return out


def _active_job(data: dict) -> dict | None:
    for job in data["jobs"]:
        if isinstance(job, dict) and job.get("state") in ACTIVE:
            return job
    return None


def _trim_keys(data: dict) -> None:
    pairs = []
    for key, job_id in data["idempotency"].items():
        job = _find(data, job_id)
        if job is None or job.get("state") in TERMINAL:
            pairs.append((job.get("updated") if job else "", key))
    if len(data["idempotency"]) <= 200:
        return
    pairs.sort()
    for _stamp, key in pairs:
        if len(data["idempotency"]) <= 200:
            break
        data["idempotency"].pop(key, None)


def _info(parsed: dict) -> dict:
    info = parsed.get("info")
    if isinstance(info, str):
        try:
            info = json.loads(info)
        except (json.JSONDecodeError, RecursionError):
            info = None
    return info if isinstance(info, dict) else {}


def _seed_int(value) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 2**32:
        return value
    return None


def _result_images(parsed: dict, count: int) -> list:
    """The generated images, without a leading grid.

    Forge puts a grid first and sets ``info.index_of_first_image`` to 1 when it
    returns one; HQ sends ``save_images: false``, which also sets
    ``do_not_save_grid``, so the index is normally 0. Extra images (if any)
    follow the generated ones and are ignored."""
    images = parsed.get("images")
    if not isinstance(images, list):
        return []
    first = _info(parsed).get("index_of_first_image", 0)
    if isinstance(first, bool) or not isinstance(first, int) or first < 0 or first >= len(images):
        first = 0
    return images[first:first + count]


def _seeds_used(parsed: dict, requested: int, count: int) -> list[int]:
    """One seed per stored image; -1 when Forge did not say and none was fixed.

    ``info.all_seeds`` lists one seed per generated image (never the grid). If
    only ``info.seed`` is present, Forge's own rule (seed + index) applies."""
    info = _info(parsed)
    seeds = info.get("all_seeds")
    out: list[int] = []
    for index in range(count):
        value = None
        if isinstance(seeds, list) and index < len(seeds):
            value = _seed_int(seeds[index])
        if value is None:
            base = _seed_int(info.get("seed"))
            if base is None:
                base = _seed_int(requested)
            value = (base + index) % (2**32) if base is not None else -1
        out.append(value)
    return out


def _diagnostic(value) -> dict | None:
    """Safe failure details only. Upstream bodies and prompts never qualify."""
    if not isinstance(value, dict):
        return None
    status = value.get("http_status")
    elapsed = value.get("elapsed_ms")
    classification = value.get("classification")
    if not isinstance(classification, str) or not classification.isascii() or len(classification) > 40:
        classification = ""
    return {
        "classification": classification,
        "http_status": status if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599 else None,
        "elapsed_ms": elapsed if isinstance(elapsed, int) and not isinstance(elapsed, bool) and 0 <= elapsed <= 3_600_000 else None,
    }


def _fail(root: Path, job_id: str, token: int, code: str, *, http_status: int | None = None, elapsed_ms: int | None = None) -> None:
    diagnostic = _diagnostic({
        "classification": code,
        "http_status": http_status,
        "elapsed_ms": elapsed_ms,
    })
    _mutate(
        root, job_id, token,
        state="failed",
        error=code,
        message=_MESSAGES.get(code, _MESSAGES["forge_error"]),
        progress_stale=False,
        diagnostic=diagnostic,
    )


def _wait_for_idle(root: Path, job_id: str, token: int, transport) -> bool:
    """Hold a queued job while Forge works for someone else. Read-only: only GET progress
    is used; nothing is interrupted. Returns False when the job must not be sent."""
    deadline = time.monotonic() + _wait_timeout
    while True:
        with _LOCK:
            job = _find(_load(root), job_id)
            if job is None or job.get("state") != "queued" or token != _generation:
                return False
            if not job.get("waiting") or job.get("force"):
                return True
        try:
            upstream = forge.status(transport=transport)
        except Exception:
            upstream = {"forge": "error"}
        if upstream.get("forge") == "ready":
            _mutate(root, job_id, token, waiting=False, message="En file.")
            return True
        if upstream.get("forge") != "busy":
            code = upstream.get("code") or "forge_error"
            _fail(root, job_id, token, code if code in _MESSAGES else "forge_error")
            return False
        if time.monotonic() >= deadline:
            _fail(root, job_id, token, "busy_timeout")
            return False
        time.sleep(_poll_interval)


def _run(root: Path, job_id: str, token: int, transport, inline_settings=None, session_token: str | None = None) -> None:
    if not _wait_for_idle(root, job_id, token, transport):
        return
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None or job.get("state") != "queued":
            return
        job["state"] = "starting"
        job["updated"] = _now()
        _save(root, data)
        settings = dict(inline_settings) if inline_settings is not None else dict(job["settings"])
        destination = job.get("destination") or "normal"
        task_id = job["task_id"]
    if _before_submit is not None:
        _before_submit(job_id)
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None or job.get("state") == "cancelled":
            return
        job["submitted"] = True
        job["state"] = "generating"
        job["updated"] = _now()
        _save(root, data)
    stop = threading.Event()

    def poll() -> None:
        misses = 0
        while not stop.wait(_poll_interval):
            try:
                progress = forge.read_progress(transport=transport)
            except forge._Probe:
                misses += 1
                if misses >= 3:
                    _mutate(root, job_id, token, progress_stale=True)
                continue
            misses = 0
            state = progress.get("state") if isinstance(progress.get("state"), dict) else {}
            step = state.get("sampling_step") if isinstance(state.get("sampling_step"), int) else 0
            steps = state.get("sampling_steps") if isinstance(state.get("sampling_steps"), int) else 0
            value = progress.get("progress")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                value = 0
            value = max(0.0, min(1.0, float(value)))
            _mutate(root, job_id, token, progress=value, step=step, steps=steps, progress_stale=False,
                    eta=forge.eta_seconds(progress))

    threading.Thread(target=poll, name="hq-forge-progress", daemon=True).start()
    started = time.monotonic()
    started_at = _now()

    def stat(outcome: str, error: str = "", images=None) -> None:
        """Phase A: settings, duration and outcome of a NORMAL job. Private jobs never reach this."""
        if destination != "normal" or token != _generation:
            return
        elapsed = time.monotonic() - started
        _mutate(root, job_id, token, started_at=started_at, finished_at=_now(), duration_ms=int(elapsed * 1000))
        base = {**stats.from_settings(settings), "kind": "job", "job_id": job_id, "device_id": "local",
                "outcome": outcome, "error": error or None, "attempt": 1, "uncertain": outcome == "uncertain"}
        if images:
            for item in images:
                stats.record(root, {**base, "image_id": item.get("id"), "duration_s": elapsed / max(1, len(images)), "count": len(images)})
        else:
            stats.record(root, {**base, "count": settings.get("n_iter")})

    try:
        body = submission_body(settings, task_id)
        parsed = forge.post_json(forge.SUBMIT_PATH, body, timeout=_job_timeout, transport=transport)
    except forge._Probe as exc:
        stop.set()
        code = "stopped" if exc.code == "forge_offline" else exc.code
        if code not in _MESSAGES:
            code = "forge_error"
        stat("uncertain" if exc.code == "forge_timeout" else "failed", code)
        if exc.code == "forge_timeout":
            _mutate(
                root, job_id, token,
                state="unknown",
                error="forge_timeout",
                message=_MESSAGES["forge_timeout"],
                diagnostic=_diagnostic({
                    "classification": "forge_timeout",
                    "http_status": exc.http_status,
                    "elapsed_ms": exc.elapsed_ms,
                }),
            )
        else:
            _fail(root, job_id, token, code, http_status=exc.http_status, elapsed_ms=exc.elapsed_ms)
        return
    except Exception:
        stop.set()
        stat("failed", "forge_error")
        _fail(root, job_id, token, "forge_error")
        return
    finally:
        stop.set()
    _mutate(root, job_id, token, state="saving")
    images = _result_images(parsed, settings["n_iter"])
    if not images:
        stat("failed", "bad_image")
        _fail(root, job_id, token, "bad_image")
        return
    seeds = _seeds_used(parsed, settings["seed"], len(images))
    subseeds = subseeds_used(parsed, settings, len(images)) if settings.get("subseed_strength") else None
    if subseeds is not None:
        seeds = [settings["seed"]] * len(images)
    stored = []
    try:
        for index, item in enumerate(images):
            if not isinstance(item, str):
                raise gallery.GalleryError("bad_image")
            raw = base64.b64decode(item, validate=True)
            per_image = {**settings, "seed": seeds[index]}
            if subseeds is not None:
                per_image["subseed"] = subseeds[index]
            if destination == "private":
                stored.append(vault.store_image(root, session_token, raw, per_image))
            else:
                stored.append(gallery.store(root, raw, per_image))
    except vault.VaultError as exc:
        code = "vault_locked" if exc.code == "locked" else exc.code
        _fail(root, job_id, token, code if code in _MESSAGES else "bad_image")
        return
    except gallery.GalleryError as exc:
        stat("failed", exc.code if exc.code in _MESSAGES else "bad_image")
        _fail(root, job_id, token, exc.code if exc.code in _MESSAGES else "bad_image")
        return
    except Exception:
        stat("failed", "bad_image")
        _fail(root, job_id, token, "bad_image")
        return
    # Before the terminal state: once a job reads completed, this thread writes nothing more.
    if destination == "normal":
        _record_duration(root, settings, time.monotonic() - started, token)
        stat("completed", images=stored)
    _mutate(
        root, job_id, token,
        state="completed",
        error="",
        message="Terminé.",
        images=stored,
        seed_used=seeds[0] if seeds and seeds[0] >= 0 else None,
        progress=1,
        progress_stale=False,
        eta=None,
    )


def _destination(data: dict) -> str | None:
    if not isinstance(data, dict):
        return None
    value = data.get("destination", "normal")
    if value not in ("normal", "private"):
        return None
    return value


def create_job(root: Path, data: dict, idempotency_key: str, *, transport=None, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not KEY_RE.fullmatch(idempotency_key or ""):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    destination = _destination(data)
    if destination is None:
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    if destination == "private" and data.get("enable_hr") is True:
        return 403, {"error": _MESSAGES["private_restricted"], "code": "private_restricted"}
    with _LOCK:
        stored = _load(root)
        found = stored["idempotency"].get(idempotency_key)
        existing = _find(stored, found) if isinstance(found, str) else None
    if existing is not None:
        if (existing.get("destination") or "normal") != destination:
            return 409, {"error": "Cette clé correspond déjà à une autre destination.", "code": "destination"}
        return 200, {"job": _public(existing, unlocked=_session_open(root, session_token))}
    if destination == "private":
        if not vault.confirm_private_generation(root):
            return 403, {"error": _MESSAGES["disabled"], "code": "disabled"}
        info = vault.status(root, session_token)
        if not info.get("private_generation"):
            return 403, {"error": _MESSAGES["disabled"], "code": "disabled"}
        if info.get("code") == "bad_root":
            return 503, {"error": vault.public_error("bad_root"), "code": "bad_root"}
        if not info.get("configured"):
            return 409, {"error": _MESSAGES["missing"], "code": "missing"}
        if not info.get("unlocked"):
            return 401, {"error": _MESSAGES["locked"], "code": "locked"}
    try:
        catalog = forge.catalog(transport=transport)
    except Exception:
        return 503, {"error": _MESSAGES["forge_error"], "code": "forge_error"}
    if catalog.get("forge") != "ready":
        code = catalog.get("code") or "forge_error"
        return 409, {"error": _MESSAGES.get(code, _MESSAGES["forge_error"]), "code": code, "forge": catalog.get("forge")}
    validated = _validate(data, catalog)
    if isinstance(validated, tuple):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    try:
        upstream = forge.status(transport=transport)
    except Exception:
        return 503, {"error": _MESSAGES["forge_error"], "code": "forge_error"}
    with _LOCK:
        stored = _load(root)
        existing = stored["idempotency"].get(idempotency_key)
        if isinstance(existing, str):
            job = _find(stored, existing)
            if job is not None:
                if (job.get("destination") or "normal") != destination:
                    return 409, {"error": "Cette clé correspond déjà à une autre destination.", "code": "destination"}
                return 200, {"job": _public(job, unlocked=_session_open(root, session_token))}
        active = _active_job(stored)
        if active is not None:
            return 409, {"error": _MESSAGES["active"], "code": "active", "active_job_id": active.get("id")}
        if _external_active():
            return 409, {"error": _MESSAGES["active"], "code": "active"}
        waiting = False
        if upstream.get("forge") == "busy":
            # B: a normal job may wait politely; private jobs keep the plain refusal.
            if destination != "normal" or data.get("wait_if_busy") is not True:
                return 409, {"error": _MESSAGES["forge_busy"], "code": "forge_busy", "forge": "busy"}
            waiting = True
        elif upstream.get("forge") != "ready":
            code = upstream.get("code") or "forge_error"
            return 409, {"error": _MESSAGES.get(code, _MESSAGES["forge_error"]), "code": code, "forge": upstream.get("forge")}
        job_id = "job-" + os.urandom(12).hex()
        task_id = "task(hq-" + os.urandom(12).hex() + ")"
        job = {
            "id": job_id,
            "task_id": task_id,
            "state": "queued",
            "created": _now(),
            "updated": _now(),
            "idempotency_key": idempotency_key,
            "destination": destination,
            "settings": {} if destination == "private" else validated,
            "submitted": False,
            "progress": 0,
            "step": 0,
            "steps": validated["steps"],
            "progress_stale": False,
            "message": _MESSAGES["waiting"] if waiting else "En file.",
            "waiting": waiting,
            "error": "",
            "images": [],
            "seed_used": None,
        }
        stored["jobs"].append(job)
        stored["jobs"] = stored["jobs"][-200:]
        stored["idempotency"][idempotency_key] = job_id
        _trim_keys(stored)
        _save(root, stored)
        token = _generation
    inline = validated if destination == "private" else None
    threading.Thread(
        target=_run,
        args=(root, job_id, token, transport, inline, session_token),
        name="hq-forge-job",
        daemon=True,
    ).start()
    return 202, {"job": _public(job, unlocked=destination == "private")}


def get_job(root: Path, job_id: str, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not JOB_RE.fullmatch(job_id):
        return 404, {"error": "Introuvable"}
    with _LOCK:
        job = _find(_load(root), job_id)
    if job is None:
        return 404, {"error": "Introuvable"}
    unlocked = _session_open(root, session_token) if job.get("destination") == "private" else False
    return 200, {"job": _public(job, unlocked=unlocked)}


def find_idempotency(root: Path, key: str, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not KEY_RE.fullmatch(key or ""):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        data = _load(root)
        job_id = data["idempotency"].get(key)
        job = _find(data, job_id) if isinstance(job_id, str) else None
    if job is None:
        return 404, {"error": "Introuvable"}
    unlocked = _session_open(root, session_token) if job.get("destination") == "private" else False
    return 200, {"job": _public(job, unlocked=unlocked)}


def list_jobs(root: Path, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    with _LOCK:
        jobs = [job for job in _load(root)["jobs"] if isinstance(job, dict)]
    jobs.sort(key=lambda job: job.get("created") or "", reverse=True)
    opened = _session_open(root, session_token)
    return 200, {"jobs": [_public(job, unlocked=opened) for job in jobs[:30]]}


def cancel_job(root: Path, job_id: str, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not JOB_RE.fullmatch(job_id):
        return 404, {"error": "Introuvable"}
    opened = _session_open(root, session_token)
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None:
            return 404, {"error": "Introuvable"}
        if job.get("state") in TERMINAL or job.get("submitted"):
            kind = "unchanged" if job.get("state") in TERMINAL else "deferred"
            if kind == "deferred":
                job["message"] = _MESSAGES["deferred"]
                job["updated"] = _now()
                _save(root, data)
            return 200, {"cancel": kind, "message": _MESSAGES["deferred"] if kind == "deferred" else job.get("message") or "", "job": _public(job, unlocked=opened)}
        job["state"] = "cancelled"
        job["error"] = "cancelled"
        job["message"] = _MESSAGES["cancelled"]
        job["updated"] = _now()
        _save(root, data)
        snapshot = _public(job, unlocked=opened)
    return 200, {"cancel": "cancelled", "message": _MESSAGES["cancelled"], "job": snapshot}


def start_now(root: Path, job_id: str, session_token: str | None = None) -> tuple[int, dict]:
    """'Lancer quand m\u00eame': stop waiting and send now. Forge queues it behind its current
    work (its own FIFO lock); nothing is interrupted, skipped or reconfigured."""
    recover(root)
    if not JOB_RE.fullmatch(job_id):
        return 404, {"error": "Introuvable"}
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None:
            return 404, {"error": "Introuvable"}
        if job.get("state") != "queued" or job.get("submitted") or not job.get("waiting"):
            return 409, {"error": "Ce travail n'attend plus Forge.", "code": "not_waiting", "job": _public(job, unlocked=False)}
        job["force"] = True
        job["waiting"] = False
        job["message"] = _MESSAGES["start_now"]
        job["updated"] = _now()
        _save(root, data)
        snapshot = _public(job, unlocked=False)
    return 200, {"job": snapshot}


def resolve(root: Path, job_id: str, action, session_token: str | None = None) -> tuple[int, dict]:
    """The owner's explicit choice for a job whose outcome is unknown: 'lost' (marquer perdue)
    or 'keep' (garder tel quel). Nothing is ever relaunched from here."""
    recover(root)
    if not JOB_RE.fullmatch(job_id):
        return 404, {"error": "Introuvable"}
    if action not in ("lost", "keep"):
        return 400, {"error": "Choix inconnu.", "code": "bad_action"}
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None:
            return 404, {"error": "Introuvable"}
        if job.get("state") != "unknown":
            return 409, {"error": "Ce travail n'est pas incertain.", "code": "not_uncertain"}
        job["resolution"] = "lost" if action == "lost" else "kept"
        job["updated"] = _now()
        _save(root, data)
        snapshot = _public(job, unlocked=False)
    return 200, {"job": snapshot}


def serve_get(root: Path, raw: str, query: str, session_token: str | None = None) -> tuple[int, dict] | None:
    if raw == "/api/forge/jobs/durations":
        return usual_duration(root, query)
    if raw == "/api/forge/jobs":
        from urllib.parse import parse_qs
        key = (parse_qs(query or "").get("idempotency_key") or [""])[0]
        if key:
            return find_idempotency(root, key, session_token)
        return list_jobs(root, session_token)
    prefix = "/api/forge/jobs/"
    if raw.startswith(prefix) and "/" not in raw[len(prefix):]:
        return get_job(root, raw[len(prefix):], session_token)
    return None


def serve_post(root: Path, raw: str, data: dict, idempotency_key: str, session_token: str | None = None) -> tuple[int, dict] | None:
    if raw == "/api/forge/jobs":
        return create_job(root, data, idempotency_key, session_token=session_token)
    prefix = "/api/forge/jobs/"
    suffix = "/cancel"
    if raw.startswith(prefix) and raw.endswith(suffix):
        return cancel_job(root, raw[len(prefix):-len(suffix)], session_token)
    if raw.startswith(prefix) and raw.endswith("/start-now"):
        return start_now(root, raw[len(prefix):-len("/start-now")], session_token)
    if raw.startswith(prefix) and raw.endswith("/resolve"):
        return resolve(root, raw[len(prefix):-len("/resolve")], data.get("action"), session_token)
    return None
