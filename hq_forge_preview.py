"""Seed constellation: cheap local txt2img previews, kept in memory only.

The owner opens a seed and asks HQ for nine low-step candidates. They are sent
to THIS PC's Forge as one normal-mode txt2img batch with a deliberately cheap
recipe (six steps, about 320 px on the long side). Forge uses consecutive seeds
from the requested base and reports the actual seeds; HQ keeps those exact values
for each tile. Nothing is written to the gallery, jobs.json, stats.json, the vault
or the browser's storage.

Guards mirror « Forge peint »:
- admin + CSRF are enforced by the bridge before this module is called;
- one preview at a time, refused (never queued) while Forge or the local GPU is
  busy with another owner, an HQ job, a retouch, a painting or a fleet task;
- while a preview runs, HQ jobs / retouches / local fleet tasks see the GPU busy;
- the upstream route is the already-approved POST /sdapi/v1/txt2img. No new Forge
  route and no write to Forge options;
- the latest sixteen previews are held in process memory, then dropped. The
  prompt is cleared as soon as the request has been sent.
"""

from __future__ import annotations

import base64
import os
import re
import threading
from pathlib import Path

import hq_forge as forge
import hq_forge_gallery as gallery
import hq_forge_jobs as jobs

PREVIEW_ID_RE = re.compile(r"^prv-[0-9a-f]{24}$")
MAX_PREVIEWS = 16
PREVIEW_STEPS = 6
PREVIEW_LONG_SIDE = 320
PREVIEW_MAX_SIDE = 512
PREVIEW_MIN_SIDE = 256
PREVIEW_TIMEOUT_SEC = 120.0
PREVIEW_BATCH_MAX = 9
REQUEST_KEYS = frozenset({
    "prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler",
    "width", "height", "cfg_scale", "seed", "count",
})
ACTIVE_STATES = {"sending", "generating", "saving"}

MESSAGES = {
    "validation": "Les réglages de l'aperçu ne sont pas acceptés.",
    "prompt": "Décris l'image avant de demander une constellation.",
    "busy": "Forge ou le GPU est occupé. Rien n'a été envoyé.",
    "active": "Une constellation se prépare déjà.",
    "forge_error": "Forge n'a pas pu préparer l'aperçu.",
    "forge_timeout": "L'aperçu a pris trop de temps. Forge n'a pas été interrompu.",
    "bad_image": "Forge a renvoyé un aperçu inutilisable.",
}

_LOCK = threading.Lock()
_entries: dict[str, dict] = {}
_order: list[str] = []
_poll_interval = 1.0
_job_timeout = PREVIEW_TIMEOUT_SEC


def reset_for_tests() -> None:
    global _poll_interval, _job_timeout
    with _LOCK:
        _entries.clear()
        _order.clear()
    _poll_interval = 1.0
    _job_timeout = PREVIEW_TIMEOUT_SEC


def set_poll_interval_for_tests(seconds: float | None) -> None:
    global _poll_interval
    _poll_interval = 1.0 if seconds is None else float(seconds)


def set_timeout_for_tests(seconds: float | None) -> None:
    global _job_timeout
    _job_timeout = PREVIEW_TIMEOUT_SEC if seconds is None else float(seconds)


def active() -> bool:
    with _LOCK:
        return any(entry.get("state") in ACTIVE_STATES for entry in _entries.values())


# HQ jobs, retouches and local fleet tasks must see the preview as GPU work.
jobs.add_gpu_hold(active)


def preview_size(width, height) -> tuple[int, int] | None:
    """A small, multiple-of-64 preview that keeps the final image's rough shape."""
    if isinstance(width, bool) or isinstance(height, bool):
        return None
    if not isinstance(width, int) or not isinstance(height, int):
        return None
    if not (256 <= width <= 1536 and 256 <= height <= 1536 and width % 64 == 0 and height % 64 == 0):
        return None
    scale = PREVIEW_LONG_SIDE / max(width, height)
    w = max(PREVIEW_MIN_SIDE, min(PREVIEW_MAX_SIDE, int(round(width * scale / 64.0)) * 64))
    h = max(PREVIEW_MIN_SIDE, min(PREVIEW_MAX_SIDE, int(round(height * scale / 64.0)) * 64))
    if w % 64 or h % 64:
        return None
    return w, h


def _public(entry: dict | None) -> dict | None:
    if entry is None:
        return None
    return {
        "id": entry.get("id"),
        "seed": entry.get("seed"),
        "state": entry.get("state"),
        "progress": entry.get("progress") or 0,
        "step": entry.get("step") or 0,
        "steps": entry.get("steps") or PREVIEW_STEPS,
        "width": entry.get("width"),
        "height": entry.get("height"),
        "message": entry.get("message") or "",
        "has_image": entry.get("png") is not None,
    }


def _prune() -> None:
    while len(_order) > MAX_PREVIEWS:
        oldest = _order.pop(0)
        _entries.pop(oldest, None)


def _set(entry_id: str, **fields) -> None:
    with _LOCK:
        entry = _entries.get(entry_id)
        if entry is not None:
            entry.update(fields)


def create(root: Path, data: dict, *, transport=None) -> tuple[int, dict]:
    """Start one preview or one batch of up to nine previews.

    Forge applies consecutive seeds from the requested base. Its ``all_seeds``
    answer is authoritative, so each tile can still select the seed that was
    actually rendered.
    """
    if not isinstance(data, dict) or set(data) - REQUEST_KEYS:
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return 400, {"error": MESSAGES["prompt"], "code": "prompt"}
    width, height = data.get("width"), data.get("height")
    size = preview_size(width, height)
    if size is None:
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    seed = data.get("seed")
    if isinstance(seed, bool) or not isinstance(seed, int) or not (0 <= seed < 2 ** 32):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    count = data.get("count", 1)
    if isinstance(count, bool) or not isinstance(count, int) or not (1 <= count <= PREVIEW_BATCH_MAX):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        if any(entry.get("state") in ACTIVE_STATES for entry in _entries.values()):
            return 409, {"error": MESSAGES["active"], "code": "active"}
    try:
        catalog = forge.catalog(transport=transport)
    except Exception:
        return 503, {"error": jobs._MESSAGES["forge_error"], "code": "forge_error"}
    if catalog.get("forge") != "ready":
        code = catalog.get("code") or "forge_error"
        return 409, {"error": jobs._MESSAGES.get(code, MESSAGES["forge_error"]), "code": code}
    merged = {
        "prompt": prompt,
        "negative_prompt": data.get("negative_prompt", ""),
        "checkpoint": data.get("checkpoint"),
        "sampler_name": data.get("sampler_name"),
        "scheduler": data.get("scheduler") or "automatic",
        "width": size[0],
        "height": size[1],
        "steps": PREVIEW_STEPS,
        "cfg_scale": data.get("cfg_scale"),
        "seed": seed,
        "n_iter": 1,
        "batch_size": 1,
        "enable_hr": False,
    }
    validated = jobs._validate(merged, catalog)
    if isinstance(validated, tuple):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    if jobs.local_active(root) or jobs._external_active():
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    try:
        upstream = forge.status(transport=transport)
    except Exception:
        upstream = {"forge": "error"}
    if upstream.get("forge") != "ready":
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    entries = [
        {
            "id": "prv-" + os.urandom(12).hex(),
            "seed": (seed + offset) % (2 ** 32),
            "state": "sending",
            "progress": 0.0,
            "step": 0,
            "steps": PREVIEW_STEPS,
            "width": size[0],
            "height": size[1],
            "message": "Aperçu en préparation.",
            "png": None,
        }
        for offset in range(count)
    ]
    with _LOCK:
        if any(item.get("state") in ACTIVE_STATES for item in _entries.values()):
            return 409, {"error": MESSAGES["active"], "code": "active"}
        for entry in entries:
            _entries[entry["id"]] = entry
            _order.append(entry["id"])
        _prune()
    task_id = "task(hq-" + os.urandom(12).hex() + ")"
    entry_ids = tuple(entry["id"] for entry in entries)
    threading.Thread(target=_run, args=(entry_ids, validated, task_id, transport, seed, count),
                     name="hq-forge-preview", daemon=True).start()
    if count == 1:
        return 202, {"preview": _public(entries[0])}
    return 202, {"previews": [_public(entry) for entry in entries]}


def _run(entry_ids: tuple[str, ...], settings: dict, task_id: str, transport,
         requested_seed: int, count: int) -> None:
    stop = threading.Event()

    def set_all(**fields) -> None:
        for entry_id in entry_ids:
            _set(entry_id, **fields)

    def poll() -> None:
        while not stop.wait(_poll_interval):
            try:
                progress = forge.read_progress(transport=transport)
            except forge._Probe:
                continue
            state = progress.get("state") if isinstance(progress.get("state"), dict) else {}
            value = progress.get("progress")
            value = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0
            set_all(progress=max(0.0, min(1.0, value)),
                    step=state.get("sampling_step") if isinstance(state.get("sampling_step"), int) else 0)

    set_all(state="generating", message="Forge esquisse…")
    threading.Thread(target=poll, name="hq-forge-preview-progress", daemon=True).start()
    body = None
    try:
        body = jobs.submission_body(settings, task_id)
        body["batch_size"] = count
        body.update({"do_not_save_samples": True, "do_not_save_grid": True})
        parsed = forge.post_json(forge.SUBMIT_PATH, body, timeout=_job_timeout, transport=transport)
    except forge._Probe as exc:
        code = "forge_timeout" if exc.code == "forge_timeout" else (exc.code if exc.code in MESSAGES else "forge_error")
        set_all(state="failed", message=MESSAGES[code])
        return
    except Exception:
        set_all(state="failed", message=MESSAGES["forge_error"])
        return
    finally:
        stop.set()
        if isinstance(body, dict):
            body.clear()
    images = jobs._result_images(parsed, count)
    if len(images) != count:
        set_all(state="failed", message=MESSAGES["bad_image"])
        return
    seeds = jobs._seeds_used(parsed, requested_seed, count)
    set_all(state="saving", message="Réception.")
    for index, (entry_id, encoded, actual_seed) in enumerate(zip(entry_ids, images, seeds)):
        if (isinstance(actual_seed, bool) or not isinstance(actual_seed, int)
                or not (0 <= actual_seed < 2 ** 32)):
            actual_seed = (requested_seed + index) % (2 ** 32)
        try:
            raw = base64.b64decode(encoded, validate=True) if isinstance(encoded, str) else None
            if raw is None:
                raise ValueError("image")
            png, _thumb, width, height = gallery.prepare_image(raw)
        except Exception:
            _set(entry_id, state="failed", message=MESSAGES["bad_image"])
            continue
        _set(entry_id, state="completed", progress=1.0, step=PREVIEW_STEPS, png=png,
             seed=actual_seed, width=width, height=height, message="Aperçu prêt.")


def get(entry_id: str) -> tuple[int, dict]:
    with _LOCK:
        if not PREVIEW_ID_RE.fullmatch(entry_id or "") or entry_id not in _entries:
            return 404, {"error": "Introuvable", "code": "not_found"}
        return 200, {"preview": _public(_entries[entry_id])}


def image(entry_id: str) -> tuple[int, dict | bytes]:
    with _LOCK:
        entry = _entries.get(entry_id)
        if entry is None or not PREVIEW_ID_RE.fullmatch(entry_id or "") or entry.get("png") is None:
            return 404, {"error": "Introuvable", "code": "not_found"}
        return 200, entry["png"]


def serve_get(raw: str) -> tuple[int, dict | bytes] | None:
    if raw == "/api/forge/preview":
        with _LOCK:
            return 200, {"previews": [_public(_entries[key]) for key in _order[-MAX_PREVIEWS:]]}
    prefix = "/api/forge/preview/"
    if raw.startswith(prefix):
        rest = raw[len(prefix):]
        if rest.endswith("/image"):
            return image(rest[:-len("/image")])
        return get(rest)
    return None


def serve_post(root: Path, raw: str, data: dict) -> tuple[int, dict] | None:
    if raw == "/api/forge/preview":
        return create(root, data)
    if raw.startswith("/api/forge/preview/"):
        return 404, {"error": "Inconnu", "code": "not_found"}
    return None
