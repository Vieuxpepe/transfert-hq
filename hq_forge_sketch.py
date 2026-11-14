"""Forge paints the sketch: an unmasked img2img of a Dessiner sketch on THIS PC's Forge.

Same route and the same guards as phase I inpainting (hq_forge_inpaint), so no route is added to the allowlist:
- The only Forge route used is POST /sdapi/v1/img2img, always to the local Forge through hq_forge.post_json,
  never to a worker.
- One painting at a time, refused (never queued, never interrupting) while Forge is busy, an HQ job or a retouch
  runs, or a fleet task holds the local GPU. While it runs, HQ jobs, retouches and local fleet tasks see the GPU as
  busy (hq_forge_jobs.add_gpu_hold).
- The model is whatever Forge has loaded: no override_settings, never switched. The body is built from the fixed
  BODY_KEYS below (no mask, no script fields) and always sets do_not_save_samples / do_not_save_grid.
- The sketch and the painting stay in memory. Only the latest painting is kept, and it reaches the gallery only
  when the owner asks (POST .../keep). No job record, history, stats or temp file.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
import re
import threading
from pathlib import Path

import hq_forge as forge
import hq_forge_gallery as gallery
import hq_forge_jobs as jobs

SKETCH_MAX_BYTES = 2 * 1024 * 1024
RESULT_MAX_BYTES = 16 * 1024 * 1024
MIN_SIDE, MAX_SIDE = 256, 1024
SKETCH_RE = re.compile(r"^skt-[0-9a-f]{24}$")
# The img2img request is built from this fixed set only (inpainting's set without the mask fields).
BODY_KEYS = frozenset({
    "prompt", "negative_prompt", "seed", "sampler_name", "scheduler", "steps", "cfg_scale",
    "width", "height", "batch_size", "n_iter",
    "save_images", "send_images", "do_not_save_samples", "do_not_save_grid", "force_task_id",
    "init_images", "denoising_strength", "resize_mode", "include_init_images",
})
SAMPLER_PREFERENCE = ("DPM++ 2M", "Euler a", "Euler", "DPM++ 2M Karras")

MESSAGES = {
    "validation": "Les réglages ne sont pas acceptés.",
    "prompt": "Décris en quelques mots ce que représente le croquis.",
    "sketch": "Croquis illisible.",
    "empty": "Le croquis est vide : dessine quelque chose d'abord.",
    "size": "Taille de croquis refusée (côtés multiples de 64, de 256 à 1024 px).",
    "busy": "Forge ou le GPU est occupé. Rien n'a été envoyé : réessaie quand il sera libre.",
    "active": "Forge peint déjà ce croquis.",
    "no_model": "Forge n'indique aucun modèle chargé connu. Rien n'a été envoyé.",
    "not_ready": "Aucune peinture à garder.",
    "kept": "Déjà dans la galerie.",
}

_LOCK = threading.Lock()
_current: dict | None = None
_poll_interval = 1.0


def reset_for_tests() -> None:
    global _current, _poll_interval
    with _LOCK:
        _current = None
    _poll_interval = 1.0


def set_poll_interval_for_tests(seconds: float | None) -> None:
    global _poll_interval
    _poll_interval = 1.0 if seconds is None else float(seconds)


def active() -> bool:
    with _LOCK:
        return _current is not None and _current["state"] in ("sending", "generating", "saving")


jobs.add_gpu_hold(active)


def _public(entry: dict | None) -> dict | None:
    if entry is None:
        return None
    out = {key: entry.get(key) for key in ("id", "state", "progress", "step", "steps", "message", "kept_id", "fidelity")}
    out["has_image"] = entry.get("png") is not None
    return out


def _number(value, low, high, *, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if integer and int(value) != value:
        return None
    value = int(value) if integer else float(value)
    return value if low <= value <= high else None


def denoise_for(fidelity: float) -> float:
    """« Fidélité au croquis » 0..1 -> img2img strength: 0 = free interpretation (0.95), 1 = close to the lines (0.5)."""
    return round(0.95 - 0.45 * max(0.0, min(1.0, fidelity)), 2)


def _decode_sketch(text):
    """Canvas PNG (data URL or base64) -> (RGB PNG bytes, size), flattened on white. Refuses blank sketches."""
    from PIL import Image
    if not isinstance(text, str) or len(text) > SKETCH_MAX_BYTES * 4 // 3 + 64:
        return None, None, "sketch"
    if text.startswith("data:image/png;base64,"):
        text = text[len("data:image/png;base64,"):]
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None, None, "sketch"
    if not raw.startswith(b"\x89PNG\r\n\x1a\n") or len(raw) > SKETCH_MAX_BYTES:
        return None, None, "sketch"
    try:
        with Image.open(io.BytesIO(raw)) as img:
            size = img.size
            if size[0] % 64 or size[1] % 64 or min(size) < MIN_SIDE or max(size) > MAX_SIDE:
                return None, None, "size"
            rgba = img.convert("RGBA")
            flat = Image.new("RGB", size, (255, 255, 255))
            flat.paste(rgba, mask=rgba.getchannel("A"))
    except Exception:
        return None, None, "sketch"
    # something drawn: some pixels clearly darker than paper
    if flat.convert("L").point(lambda v: 255 if v < 200 else 0).getbbox() is None:
        return None, None, "empty"
    out = io.BytesIO()
    flat.save(out, format="PNG")  # re-encoded: no client metadata travels to Forge
    return out.getvalue(), size, None


def _sampler(catalog: dict) -> str | None:
    names = [item.get("name") for item in catalog.get("samplers") or [] if isinstance(item, dict) and isinstance(item.get("name"), str)]
    for name in SAMPLER_PREFERENCE:
        if name in names:
            return name
    return names[0] if names else None


def _scheduler(catalog: dict) -> str | None:
    names = [item.get("name") for item in catalog.get("schedulers") or [] if isinstance(item, dict) and isinstance(item.get("name"), str)]
    if "automatic" in names:
        return "automatic"
    return names[0] if names else None


def create(root: Path, data: dict, *, transport=None) -> tuple[int, dict]:
    global _current
    if not isinstance(data, dict):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    prompt = data.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        return 400, {"error": MESSAGES["prompt"], "code": "prompt"}
    fidelity = _number(data.get("fidelity", 0.6), 0.0, 1.0)
    steps = _number(data.get("steps", 16), 4, 30, integer=True)
    seed = _number(data.get("seed", -1), -1, 2**32 - 1, integer=True)
    negative = data.get("negative_prompt", "")
    if fidelity is None or steps is None or seed is None or not isinstance(negative, str):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        if _current is not None and _current["state"] in ("sending", "generating", "saving"):
            return 409, {"error": MESSAGES["active"], "code": "active"}
    png, size, problem = _decode_sketch(data.get("sketch"))
    if problem:
        return 400, {"error": MESSAGES[problem], "code": problem}
    try:
        catalog = forge.catalog(transport=transport)
    except Exception:
        return 503, {"error": jobs._MESSAGES["forge_error"], "code": "forge_error"}
    if catalog.get("forge") != "ready":
        code = catalog.get("code") or "forge_error"
        return 409, {"error": jobs._MESSAGES.get(code, jobs._MESSAGES["forge_error"]), "code": code}
    # GPU sharing: an HQ job, a retouch, a fleet task on this GPU or Forge working for its owner -> refuse, never wait.
    if jobs.local_active(root) or jobs._external_active():
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    try:
        upstream = forge.status(transport=transport)
    except Exception:
        upstream = {"forge": "error"}
    if upstream.get("forge") != "ready":
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    loaded = None
    model = upstream.get("model")
    for item in catalog.get("models") or []:
        if isinstance(item, dict) and isinstance(model, str) and model:
            title = item.get("title") or ""
            if model in (title, item.get("model_name")) or title.split(" [")[0] == model.split(" [")[0]:
                loaded = title
                break
    if loaded is None:
        return 409, {"error": MESSAGES["no_model"], "code": "no_model"}
    sampler, scheduler = _sampler(catalog), _scheduler(catalog)
    if sampler is None or scheduler is None:
        return 409, {"error": jobs._MESSAGES["forge_error"], "code": "forge_error"}
    merged = {"prompt": prompt, "negative_prompt": negative, "sampler_name": sampler, "scheduler": scheduler,
              "steps": steps, "cfg_scale": 6.0, "seed": seed, "width": size[0], "height": size[1],
              "n_iter": 1, "batch_size": 1, "checkpoint": loaded}
    validated = jobs._validate(merged, catalog)
    if isinstance(validated, tuple):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    entry = {"id": "skt-" + os.urandom(12).hex(), "state": "sending", "progress": 0.0, "step": 0,
             "steps": validated["steps"], "message": "Envoyé à Forge (ce PC).", "png": None,
             "settings": None, "kept_id": None, "fidelity": fidelity}
    with _LOCK:
        if _current is not None and _current["state"] in ("sending", "generating", "saving"):
            return 409, {"error": MESSAGES["active"], "code": "active"}
        _current = entry  # the previous painting (if any) is dropped here
    task_id = "task(hq-" + os.urandom(12).hex() + ")"
    body = build_body(validated, task_id, png, denoise_for(fidelity))
    del png
    threading.Thread(target=_run, args=(entry, body, validated, transport), name="hq-forge-sketch", daemon=True).start()
    return 202, {"sketch": _public(entry)}


def build_body(settings: dict, task_id: str, png: bytes, denoise: float) -> dict:
    """The img2img request: exactly BODY_KEYS. Forge never writes the result or a grid to its outputs folder;
    no override_settings (the loaded model is used as is), no hires fix, no subseed, no script."""
    base = jobs.submission_body(settings, task_id)
    body = {key: base[key] for key in BODY_KEYS if key in base}
    body.update({
        "save_images": False,
        "do_not_save_samples": True,
        "do_not_save_grid": True,
        "init_images": [base64.b64encode(png).decode("ascii")],
        "denoising_strength": denoise,
        "resize_mode": 0,
        "include_init_images": False,
    })
    assert set(body) <= BODY_KEYS
    return body


def _set(entry: dict, **fields) -> None:
    with _LOCK:
        entry.update(fields)


def _run(entry, body, settings, transport) -> None:
    stop = threading.Event()

    def poll() -> None:
        while not stop.wait(_poll_interval):
            try:
                progress = forge.read_progress(transport=transport)
            except forge._Probe:
                continue
            state = progress.get("state") if isinstance(progress.get("state"), dict) else {}
            value = progress.get("progress")
            value = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0
            _set(entry, progress=max(0.0, min(1.0, value)),
                 step=state.get("sampling_step") if isinstance(state.get("sampling_step"), int) else 0)

    _set(entry, state="generating", message="Forge peint…")
    threading.Thread(target=poll, name="hq-forge-sketch-progress", daemon=True).start()
    try:
        parsed = forge.post_json(forge.INPAINT_PATH, body, timeout=jobs._job_timeout, transport=transport)
    except forge._Probe as exc:
        code = exc.code if exc.code in jobs._MESSAGES else "forge_error"
        _set(entry, state="failed", message=jobs._MESSAGES["forge_timeout" if code == "forge_timeout" else code])
        return
    except Exception:
        _set(entry, state="failed", message=jobs._MESSAGES["forge_error"])
        return
    finally:
        stop.set()
        body.clear()  # the sketch leaves memory with the request
    _set(entry, state="saving", message="Réception.")
    images = jobs._result_images(parsed, 1)
    try:
        raw = base64.b64decode(images[0], validate=True) if images and isinstance(images[0], str) else None
        if raw is None or len(raw) > RESULT_MAX_BYTES:
            raise ValueError("image")
        png = gallery.prepare_image(raw)[0]  # re-encoded without metadata, refused if it is not an image
    except Exception:
        _set(entry, state="failed", message=jobs._MESSAGES["bad_image"])
        return
    seeds = jobs._seeds_used(parsed, settings["seed"], 1)
    _set(entry, state="completed", progress=1.0, png=png, settings={**settings, "seed": seeds[0]}, message="Peinture prête.")


def keep(root: Path, entry_id: str) -> tuple[int, dict]:
    """Copy the latest painting into the gallery (it is never stored unless asked)."""
    with _LOCK:
        entry = _current
        if entry is None or entry["id"] != entry_id:
            return 404, {"error": "Introuvable", "code": "not_found"}
        if entry.get("kept_id"):
            return 200, {"sketch": _public(entry), "image_id": entry["kept_id"], "message": MESSAGES["kept"]}
        if entry["state"] != "completed" or entry.get("png") is None:
            return 409, {"error": MESSAGES["not_ready"], "code": "not_ready"}
        png, settings = entry["png"], dict(entry["settings"] or {})
    try:
        stored = gallery.store(root, png, settings)
    except gallery.GalleryError as exc:
        code = getattr(exc, "code", "bad_image")
        return (507 if code in ("quota", "disk") else 400), {"error": jobs._MESSAGES.get(code, jobs._MESSAGES["bad_image"]), "code": code}
    _set(entry, kept_id=stored["id"])
    return 200, {"sketch": _public(entry), "image_id": stored["id"]}


def get(entry_id: str) -> tuple[int, dict]:
    with _LOCK:
        if not SKETCH_RE.fullmatch(entry_id or "") or _current is None or _current["id"] != entry_id:
            return 404, {"error": "Introuvable", "code": "not_found"}
        return 200, {"sketch": _public(_current)}


def image(entry_id: str) -> tuple[int, dict | bytes]:
    with _LOCK:
        if not SKETCH_RE.fullmatch(entry_id or "") or _current is None or _current["id"] != entry_id or _current.get("png") is None:
            return 404, {"error": "Introuvable", "code": "not_found"}
        return 200, _current["png"]


def serve_get(raw: str) -> tuple[int, dict | bytes] | None:
    prefix = "/api/forge/sketch/"
    if raw == "/api/forge/sketch":
        with _LOCK:
            return 200, {"sketch": _public(_current)}
    if raw.startswith(prefix):
        rest = raw[len(prefix):]
        if rest.endswith("/image"):
            return image(rest[: -len("/image")])
        return get(rest)
    return None


def serve_post(root: Path, raw: str, data: dict) -> tuple[int, dict] | None:
    if raw == "/api/forge/sketch":
        return create(root, data)
    prefix = "/api/forge/sketch/"
    if raw.startswith(prefix):
        rest = raw[len(prefix):]
        if rest.endswith("/keep") and SKETCH_RE.fullmatch(rest[: -len("/keep")]):
            return keep(root, rest[: -len("/keep")])
        return 404, {"error": "Inconnu", "code": "not_found"}
    return None
