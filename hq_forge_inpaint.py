"""Forge Studio phase I: finger inpainting on THIS PC's Forge (masked img2img).

- The only Forge route used is POST /sdapi/v1/img2img (approved allowlist addition), always
  to the local Forge through hq_forge.post_json; never to a worker.
- One inpaint at a time, refused (never queued, never interrupting) while Forge is busy, an HQ
  job runs, or a fleet task holds the local GPU. While it runs, HQ jobs and local fleet tasks
  see the GPU as busy (hq_forge_jobs.set_inpaint_busy).
- State is kept in memory only. A normal result goes to the gallery (origin inpaint_of); a
  private one is encrypted straight into the vault. For a private source the source pixels,
  the mask and the request exist only in memory: no job record, no gallery, history, stats,
  log line, temp file or browser storage.
- Model handling is submission_body's (override_settings sd_model_checkpoint restored
  afterwards); HQ never touches options, interrupt or skip.
"""

from __future__ import annotations

import base64
import binascii
import io
import os
import re
import threading
import time
from pathlib import Path

import hq_forge as forge
import hq_forge_gallery as gallery
import hq_forge_jobs as jobs
import hq_forge_vault as vault

MASK_MAX_BYTES = 2 * 1024 * 1024
SOURCE_MAX_BYTES = 12 * 1024 * 1024
MAX_SIDE = 1536
INPAINT_RE = re.compile(r"^inp-[0-9a-f]{24}$")
FILLS = (0, 1, 2, 3)  # Forge: fill, original, latent noise, latent nothing
SETTING_KEYS = ("prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler", "steps", "cfg_scale", "seed")
# The img2img request is built from this fixed set only (never a passthrough of client fields).
# override_settings is present only when a checkpoint is known; nothing else is optional.
BODY_KEYS = frozenset({
    "prompt", "negative_prompt", "seed", "sampler_name", "scheduler", "steps", "cfg_scale",
    "width", "height", "batch_size", "n_iter",
    "save_images", "send_images", "do_not_save_samples", "do_not_save_grid",
    "script_name", "script_args", "alwayson_scripts", "force_task_id",
    "override_settings", "override_settings_restore_afterwards",
    "init_images", "mask", "mask_blur", "inpainting_fill", "inpaint_full_res", "inpaint_full_res_padding",
    "inpainting_mask_invert", "denoising_strength", "resize_mode", "include_init_images",
})

MESSAGES = {
    "validation": "Les r\u00e9glages de retouche ne sont pas accept\u00e9s.",
    "mask": "Masque illisible ou vide : peignez la zone \u00e0 refaire.",
    "mask_size": "Le masque ne correspond pas \u00e0 la taille de l'image.",
    "size": "Cette image ne peut pas \u00eatre retouch\u00e9e (c\u00f4t\u00e9s multiples de 64, 1536 px au plus).",
    "not_found": "Image introuvable.",
    "busy": "Forge ou le GPU est occup\u00e9. Rien n'a \u00e9t\u00e9 envoy\u00e9 : r\u00e9essayez quand il sera libre.",
    "active": "Une retouche est d\u00e9j\u00e0 en cours.",
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


jobs.set_inpaint_busy(active)


def _public(entry: dict | None) -> dict | None:
    if entry is None:
        return None
    return {key: entry.get(key) for key in ("id", "state", "destination", "progress", "step", "steps", "message", "image_id", "source_id")}


def _number(value, low, high, *, integer=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if integer and int(value) != value:
        return None
    value = int(value) if integer else float(value)
    return value if low <= value <= high else None


def _decode_mask(text, size):
    """Canvas PNG (data URL or base64) -> 1-bit L mask (white = repaint), same size as the image."""
    from PIL import Image
    if not isinstance(text, str) or len(text) > MASK_MAX_BYTES * 4 // 3 + 64:
        return None, "mask"
    if text.startswith("data:image/png;base64,"):
        text = text[len("data:image/png;base64,"):]
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        return None, "mask"
    if not raw.startswith(b"\x89PNG\r\n\x1a\n") or len(raw) > MASK_MAX_BYTES:
        return None, "mask"
    try:
        with Image.open(io.BytesIO(raw)) as img:
            if img.size != size:
                return None, "mask_size"
            if img.mode in ("RGBA", "LA"):
                alpha = img.getchannel("A")
            else:
                alpha = img.convert("L")
            mask = alpha.point(lambda v: 255 if v >= 128 else 0).convert("L")
    except Exception:
        return None, "mask"
    if not mask.getbbox():
        return None, "mask"
    out = io.BytesIO()
    mask.save(out, format="PNG")
    return out.getvalue(), None


def _source(root: Path, kind: str, image_id: str, token: str | None):
    """Source pixels and settings, in memory. A private source is decrypted here and never written."""
    if kind == "normal":
        if not isinstance(image_id, str) or not gallery.IMG_RE.fullmatch(image_id):
            return None
        try:
            meta = gallery.get(root, image_id)
            png, _ctype, _disp = gallery.file_bytes(root, image_id, "original")
        except Exception:
            return None
        return png, meta.get("settings") or {}
    if not isinstance(image_id, str) or not vault.ID_RE.fullmatch(image_id):
        return None
    meta = vault.detail(root, token, image_id)  # VaultError("locked"/"bad_id") propagates
    png, _ctype, _disp = vault.file_bytes(root, token, image_id, "original")
    return png, meta.get("settings") or {}


def _private_gate(root: Path, token: str | None):
    if not vault.confirm_private_generation(root):
        return 403, {"error": jobs._MESSAGES["disabled"], "code": "disabled"}
    info = vault.status(root, token)
    if not info.get("private_generation"):
        return 403, {"error": jobs._MESSAGES["disabled"], "code": "disabled"}
    if not info.get("configured"):
        return 409, {"error": jobs._MESSAGES["missing"], "code": "missing"}
    if not info.get("unlocked"):
        return 401, {"error": jobs._MESSAGES["locked"], "code": "locked"}
    return None


def create(root: Path, data: dict, session_token: str | None, *, transport=None) -> tuple[int, dict]:
    global _current
    from PIL import Image
    if not isinstance(data, dict):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    source = data.get("source") if isinstance(data.get("source"), dict) else {}
    kind = source.get("kind")
    if kind not in ("normal", "private"):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    denoise = _number(data.get("denoising_strength", 0.75), 0.05, 1.0)
    blur = _number(data.get("mask_blur", 4), 0, 64, integer=True)
    fill = data.get("inpainting_fill", 1)
    full_res = data.get("inpaint_full_res", True)
    padding = _number(data.get("inpaint_full_res_padding", 32), 0, 256, integer=True)
    if denoise is None or blur is None or padding is None or fill not in FILLS or isinstance(fill, bool) or not isinstance(full_res, bool):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    if kind == "private":
        refused = _private_gate(root, session_token)
        if refused:
            return refused
    with _LOCK:
        if _current is not None and _current["state"] in ("sending", "generating", "saving"):
            return 409, {"error": MESSAGES["active"], "code": "active"}
    try:
        got = _source(root, kind, source.get("id"), session_token)
    except vault.VaultError as exc:
        return vault.http_status(exc.code), {"error": vault.public_error(exc.code), "code": exc.code}
    if got is None:
        return 404, {"error": MESSAGES["not_found"], "code": "not_found"}
    png, stored_settings = got
    if len(png) > SOURCE_MAX_BYTES:
        return 400, {"error": MESSAGES["size"], "code": "size"}
    try:
        with Image.open(io.BytesIO(png)) as img:
            size = img.size
    except Exception:
        return 400, {"error": MESSAGES["size"], "code": "size"}
    if size[0] % 64 or size[1] % 64 or max(size) > MAX_SIDE or min(size) < 256:
        return 400, {"error": MESSAGES["size"], "code": "size"}
    mask_png, problem = _decode_mask(data.get("mask"), size)
    if problem:
        return 400, {"error": MESSAGES[problem], "code": problem}
    wanted = {key: data[key] for key in SETTING_KEYS if key in data}
    # An imported image stores empty values (steps 0, cfg 0): those are "unknown", not settings.
    base = {key: stored_settings.get(key) for key in SETTING_KEYS if stored_settings.get(key) not in (None, "", 0)}
    merged = {**base, **wanted, "width": size[0], "height": size[1], "n_iter": 1, "batch_size": 1}
    try:
        catalog = forge.catalog(transport=transport)
    except Exception:
        return 503, {"error": jobs._MESSAGES["forge_error"], "code": "forge_error"}
    if catalog.get("forge") != "ready":
        code = catalog.get("code") or "forge_error"
        return 409, {"error": jobs._MESSAGES.get(code, jobs._MESSAGES["forge_error"]), "code": code}
    validated = jobs._validate(merged, catalog)
    if isinstance(validated, tuple):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    # GPU sharing: an HQ job, a fleet task on this GPU or Forge working for its owner -> refuse, never wait or interrupt.
    if jobs.local_active(root) or jobs._external_active():
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    try:
        upstream = forge.status(transport=transport)
    except Exception:
        upstream = {"forge": "error"}
    if upstream.get("forge") != "ready":
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    entry = {"id": "inp-" + os.urandom(12).hex(), "state": "sending", "destination": kind, "progress": 0.0, "step": 0,
             "steps": validated["steps"], "message": "Envoy\u00e9 \u00e0 Forge (ce PC).", "image_id": None,
             "source_id": source.get("id")}
    with _LOCK:
        if _current is not None and _current["state"] in ("sending", "generating", "saving"):
            return 409, {"error": MESSAGES["active"], "code": "active"}
        _current = entry
    task_id = "task(hq-" + os.urandom(12).hex() + ")"
    body = build_body(validated, task_id, png, mask_png, blur=blur, fill=fill, full_res=full_res,
                      padding=padding, denoise=denoise)
    del png, mask_png
    origin = {"inpaint_of": source.get("id")} if kind == "normal" else None
    threading.Thread(target=_run, args=(root, entry, body, validated, kind, origin, session_token, transport),
                     name="hq-forge-inpaint", daemon=True).start()
    return 202, {"inpaint": _public(entry)}


def build_body(settings: dict, task_id: str, png: bytes, mask_png: bytes, *, blur: int, fill: int,
               full_res: bool, padding: int, denoise: float) -> dict:
    """The img2img request: exactly BODY_KEYS (override_settings only with a checkpoint).

    Forge never writes the result or a grid to its outputs folder (do_not_save_samples and
    do_not_save_grid, for every inpaint and so always for a private one). No hires fix, no
    subseed, no script, no interrupt/skip/options.
    """
    base = jobs.submission_body(settings, task_id)
    body = {key: base[key] for key in BODY_KEYS if key in base}
    body.update({
        "save_images": False,
        "do_not_save_samples": True,
        "do_not_save_grid": True,
        "init_images": [base64.b64encode(png).decode("ascii")],
        "mask": base64.b64encode(mask_png).decode("ascii"),
        "mask_blur": blur,
        "inpainting_fill": fill,
        "inpaint_full_res": full_res,
        "inpaint_full_res_padding": padding,
        "inpainting_mask_invert": 0,  # the page inverts the painted mask itself when asked
        "denoising_strength": denoise,
        "resize_mode": 0,
        "include_init_images": False,
    })
    assert set(body) <= BODY_KEYS
    return body


def _set(entry: dict, **fields) -> None:
    with _LOCK:
        entry.update(fields)


def _run(root, entry, body, settings, kind, origin, session_token, transport) -> None:
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

    _set(entry, state="generating")
    threading.Thread(target=poll, name="hq-forge-inpaint-progress", daemon=True).start()
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
        body.clear()  # source and mask leave memory with the request
    _set(entry, state="saving", message="Enregistrement.")
    images = jobs._result_images(parsed, 1)
    try:
        raw = base64.b64decode(images[0], validate=True) if images and isinstance(images[0], str) else None
        if raw is None:
            raise gallery.GalleryError("bad_image")
        seeds = jobs._seeds_used(parsed, settings["seed"], 1)
        per_image = {**settings, "seed": seeds[0]}
        if kind == "private":
            stored = vault.store_image(root, session_token, raw, per_image)  # encrypted straight into the vault
        else:
            stored = gallery.store(root, raw, per_image, origin=origin)
    except vault.VaultError as exc:
        _set(entry, state="failed", message=jobs._MESSAGES["vault_locked" if exc.code == "locked" else "bad_image"])
        return
    except Exception:
        _set(entry, state="failed", message=jobs._MESSAGES["bad_image"])
        return
    _set(entry, state="completed", progress=1.0, image_id=stored["id"], message="Retouche termin\u00e9e.")


def get(entry_id: str) -> tuple[int, dict]:
    with _LOCK:
        if not INPAINT_RE.fullmatch(entry_id or "") or _current is None or _current["id"] != entry_id:
            return 404, {"error": "Introuvable"}
        return 200, {"inpaint": _public(_current)}


def serve_get(raw: str) -> tuple[int, dict] | None:
    prefix = "/api/forge/inpaint/"
    if raw.startswith(prefix):
        return get(raw[len(prefix):])
    if raw == "/api/forge/inpaint":
        with _LOCK:
            return 200, {"inpaint": _public(_current)}
    return None


def serve_post(root: Path, raw: str, data: dict, session_token: str | None) -> tuple[int, dict] | None:
    if raw == "/api/forge/inpaint":
        return create(root, data, session_token)
    if raw.startswith("/api/forge/inpaint/"):
        return 404, {"error": "Inconnu"}
    return None