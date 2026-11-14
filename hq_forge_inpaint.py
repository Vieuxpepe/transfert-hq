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
- The inpaint runs on whatever model Forge has loaded: no override_settings, so it never
  switches models; the stored settings record that loaded model. HQ never touches options,
  interrupt or skip.
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
OUTPAINT_MAX = 1024
INPAINT_RE = re.compile(r"^inp-[0-9a-f]{24}$")
FILLS = (0, 1, 2, 3)  # Forge: fill, original, latent noise, latent nothing
SETTING_KEYS = ("prompt", "negative_prompt", "sampler_name", "scheduler", "steps", "cfg_scale", "seed")
# The img2img request is built from this fixed set only (never a passthrough of client fields).
# No override_settings (the loaded model is used, never switched) and no script fields.
BODY_KEYS = frozenset({
    "prompt", "negative_prompt", "seed", "sampler_name", "scheduler", "steps", "cfg_scale",
    "width", "height", "batch_size", "n_iter",
    "save_images", "send_images", "do_not_save_samples", "do_not_save_grid", "force_task_id",
    "init_images", "mask", "mask_blur", "inpainting_fill", "inpaint_full_res", "inpaint_full_res_padding",
    "inpainting_mask_invert", "denoising_strength", "resize_mode", "include_init_images",
})

MESSAGES = {
    "validation": "Les r\u00e9glages de retouche ne sont pas accept\u00e9s.",
    "mask": "Masque illisible ou vide : peignez la zone \u00e0 refaire.",
    "mask_size": "Le masque ne correspond pas \u00e0 la taille de l'image.",
    "size": "Cette image ne peut pas \u00eatre retouch\u00e9e (c\u00f4t\u00e9s multiples de 64, 1536 px au plus).",
    "outpaint": "L'extension demand\u00e9e d\u00e9passe 1536 px ou n'est pas un multiple de 64.",
    "not_found": "Image introuvable.",
    "busy": "Forge ou le GPU est occup\u00e9. Rien n'a \u00e9t\u00e9 envoy\u00e9 : r\u00e9essayez quand il sera libre.",
    "active": "Une retouche est d\u00e9j\u00e0 en cours.",
    "no_model": "Forge n'indique aucun mod\u00e8le charg\u00e9 connu. Rien n'a \u00e9t\u00e9 envoy\u00e9.",
}


def _loaded_title(model, catalog: dict) -> str | None:
    """Catalog title of the model Forge reports as loaded (options sd_model_checkpoint)."""
    if not isinstance(model, str) or not model:
        return None
    for item in catalog.get("models") or []:
        if not isinstance(item, dict):
            continue
        title = item.get("title") or ""
        if model in (title, item.get("model_name")) or title.split(" [")[0] == model.split(" [")[0]:
            return title
    return None

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
    return {key: entry.get(key) for key in ("id", "state", "destination", "progress", "step", "steps", "message", "image_id", "source_id", "operation")}


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


def _outpaint_canvas(png: bytes, spec: dict):
    """Expand a source into a larger canvas and paint the new border white in the mask.

    The source is pasted at its original size. New bands repeat the nearest edge
    pixels; Forge repaints those bands through the normal img2img path. No file is written.
    """
    from PIL import Image, ImageDraw
    if not isinstance(spec, dict):
        return None
    edges = {}
    for side in ("left", "right", "top", "bottom"):
        value = _number(spec.get(side, 0), 0, OUTPAINT_MAX, integer=True)
        if value is None or value % 64:
            return None
        edges[side] = value
    if not any(edges.values()):
        return None
    try:
        with Image.open(io.BytesIO(png)) as opened:
            img = opened.convert("RGB")
    except Exception:
        return None
    width, height = img.size
    new_width = width + edges["left"] + edges["right"]
    new_height = height + edges["top"] + edges["bottom"]
    if new_width % 64 or new_height % 64 or max(new_width, new_height) > MAX_SIDE or min(new_width, new_height) < 256:
        return None
    canvas = Image.new("RGB", (new_width, new_height), img.getpixel((0, 0)))
    canvas.paste(img, (edges["left"], edges["top"]))
    if edges["left"]:
        canvas.paste(img.crop((0, 0, 1, height)).resize((edges["left"], height)), (0, edges["top"]))
    if edges["right"]:
        canvas.paste(img.crop((width - 1, 0, width, height)).resize((edges["right"], height)),
                     (edges["left"] + width, edges["top"]))
    if edges["top"]:
        canvas.paste(img.crop((0, 0, width, 1)).resize((width, edges["top"])), (edges["left"], 0))
    if edges["bottom"]:
        canvas.paste(img.crop((0, height - 1, width, height)).resize((width, edges["bottom"])),
                     (edges["left"], edges["top"] + height))
    # Corners: repeat the nearest source corner so no transparent or black seam appears.
    if edges["left"] and edges["top"]:
        canvas.paste(Image.new("RGB", (edges["left"], edges["top"]), img.getpixel((0, 0))), (0, 0))
    if edges["right"] and edges["top"]:
        canvas.paste(Image.new("RGB", (edges["right"], edges["top"]), img.getpixel((width - 1, 0))),
                     (edges["left"] + width, 0))
    if edges["left"] and edges["bottom"]:
        canvas.paste(Image.new("RGB", (edges["left"], edges["bottom"]), img.getpixel((0, height - 1))),
                     (0, edges["top"] + height))
    if edges["right"] and edges["bottom"]:
        canvas.paste(Image.new("RGB", (edges["right"], edges["bottom"]), img.getpixel((width - 1, height - 1))),
                     (edges["left"] + width, edges["top"] + height))
    mask = Image.new("L", (new_width, new_height), 0)
    draw = ImageDraw.Draw(mask)
    if edges["left"]:
        draw.rectangle([0, 0, edges["left"] - 1, new_height - 1], fill=255)
    if edges["right"]:
        draw.rectangle([new_width - edges["right"], 0, new_width - 1, new_height - 1], fill=255)
    if edges["top"]:
        draw.rectangle([edges["left"], 0, edges["left"] + width - 1, edges["top"] - 1], fill=255)
    if edges["bottom"]:
        draw.rectangle([edges["left"], edges["top"] + height, edges["left"] + width - 1, new_height - 1], fill=255)
    out = io.BytesIO()
    canvas.save(out, format="PNG")
    mask_out = io.BytesIO()
    mask.save(mask_out, format="PNG")
    return out.getvalue(), mask_out.getvalue(), (new_width, new_height), edges


def _source(root: Path, kind: str, image_id: str, token: str | None, vid: str | None = None):
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
    meta = vault.detail(root, token, image_id, vid=vid)  # VaultError("locked"/"bad_id") propagates
    png, _ctype, _disp = vault.file_bytes(root, token, image_id, "original", vid=vid)
    return png, meta.get("settings") or {}


def _private_gate(root: Path, token: str | None, vid: str | None = None):
    if not vault.confirm_private_generation(root, vid=vid):
        return 403, {"error": jobs._MESSAGES["disabled"], "code": "disabled"}
    info = vault.status(root, token, vid=vid)
    if info.get("code") in ("use_vaults", "bad_vault", "registry"):
        return vault.http_status(info["code"]), {"error": vault.public_error(info["code"]), "code": info["code"]}
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
    outpaint = data.get("outpaint") if data.get("outpaint") is not None else None
    if outpaint is not None and not isinstance(outpaint, dict):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    denoise = _number(data.get("denoising_strength", 0.75), 0.05, 1.0)
    blur = _number(data.get("mask_blur", 4), 0, 64, integer=True)
    fill = data.get("inpainting_fill", 1)
    full_res = data.get("inpaint_full_res", True)
    padding = _number(data.get("inpaint_full_res_padding", 32), 0, 256, integer=True)
    if denoise is None or blur is None or padding is None or fill not in FILLS or isinstance(fill, bool) or not isinstance(full_res, bool):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    vid = source.get("vault")
    if vid is not None and (kind != "private" or not isinstance(vid, str) or not vault.registry.VID_RE.fullmatch(vid)):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    if kind == "private":
        # Multi-vault V2.4: the retouch is written to the source image's vault, nowhere else.
        refused = _private_gate(root, session_token, vid)
        if refused:
            return refused
    with _LOCK:
        if _current is not None and _current["state"] in ("sending", "generating", "saving"):
            return 409, {"error": MESSAGES["active"], "code": "active"}
    try:
        got = _source(root, kind, source.get("id"), session_token, vid)
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
    if outpaint is not None:
        expanded = _outpaint_canvas(png, outpaint)
        if expanded is None:
            return 400, {"error": MESSAGES["outpaint"], "code": "outpaint"}
        png, mask_png, size, _edges = expanded
    else:
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
    # GPU sharing: an HQ job, a fleet task on this GPU or Forge working for its owner -> refuse, never wait or interrupt.
    if jobs.local_active(root) or jobs._external_active():
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    try:
        upstream = forge.status(transport=transport)
    except Exception:
        upstream = {"forge": "error"}
    if upstream.get("forge") != "ready":
        return 409, {"error": MESSAGES["busy"], "code": "busy"}
    # The model is whatever Forge has loaded (read from the status probe), never the client's or the source's.
    loaded = _loaded_title(upstream.get("model"), catalog)
    if loaded is None:
        return 409, {"error": MESSAGES["no_model"], "code": "no_model"}
    merged["checkpoint"] = loaded
    validated = jobs._validate(merged, catalog)
    if isinstance(validated, tuple):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    entry = {"id": "inp-" + os.urandom(12).hex(), "state": "sending", "destination": kind, "progress": 0.0, "step": 0,
             "steps": validated["steps"], "message": "Envoy\u00e9 \u00e0 Forge (ce PC).", "image_id": None,
             "source_id": source.get("id"), "operation": "outpaint" if outpaint is not None else "inpaint"}
    with _LOCK:
        if _current is not None and _current["state"] in ("sending", "generating", "saving"):
            return 409, {"error": MESSAGES["active"], "code": "active"}
        _current = entry
    task_id = "task(hq-" + os.urandom(12).hex() + ")"
    body = build_body(validated, task_id, png, mask_png, blur=blur, fill=fill, full_res=full_res,
                      padding=padding, denoise=denoise)
    del png, mask_png
    origin = {"outpaint_of" if outpaint is not None else "inpaint_of": source.get("id")} if kind == "normal" else None
    threading.Thread(target=_run, args=(root, entry, body, validated, kind, origin, session_token, transport, vid),
                     name="hq-forge-inpaint", daemon=True).start()
    return 202, {"inpaint": _public(entry)}


def build_body(settings: dict, task_id: str, png: bytes, mask_png: bytes, *, blur: int, fill: int,
               full_res: bool, padding: int, denoise: float) -> dict:
    """The img2img request: exactly BODY_KEYS.

    Forge never writes the result or a grid to its outputs folder (do_not_save_samples and
    do_not_save_grid, for every inpaint and so always for a private one). No override_settings
    (the loaded model is used as is), no hires fix, no subseed, no script, no interrupt/skip/options.
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


def _run(root, entry, body, settings, kind, origin, session_token, transport, vid=None) -> None:
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
            stored = vault.store_image(root, session_token, raw, per_image, vid=vid)  # encrypted straight into the source's vault
        else:
            stored = gallery.store(root, raw, per_image, origin=origin)
    except vault.VaultError as exc:
        _set(entry, state="failed", message=jobs._MESSAGES["vault_locked" if exc.code == "locked" else "bad_image"])
        return
    except Exception:
        _set(entry, state="failed", message=jobs._MESSAGES["bad_image"])
        return
    _set(entry, state="completed", progress=1.0, image_id=stored["id"],
         message="Extension termin\u00e9e." if entry.get("operation") == "outpaint" else "Retouche termin\u00e9e.")


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