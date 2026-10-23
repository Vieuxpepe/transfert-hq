"""HQ-owned Forge gallery. Forge's own output folders are never read or written."""

from __future__ import annotations

import io
import json
import math
import os
import re
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

try:
    from PIL import Image, UnidentifiedImageError
    from PIL.PngImagePlugin import PngInfo
except ImportError:  # pragma: no cover - production dependency is proposed, not assumed
    Image = None
    PngInfo = None
    UnidentifiedImageError = OSError

# Forge/A1111 read generation settings from this PNG text key (modules/images.py,
# pnginfo_section_name='parameters').
PARAMETERS_KEY = "parameters"

IMG_RE = re.compile(r"^img-[0-9a-f]{24}$")
QUOTA_BYTES = 2 * 1024 * 1024 * 1024
QUOTA_IMAGES = 400
MAX_EDGE = 2048
MAX_BYTES = 20 * 1024 * 1024
THUMB_EDGE = 384
PAGE_MAX = 48

_LOCK = threading.Lock()
_quota_bytes = QUOTA_BYTES
_quota_images = QUOTA_IMAGES

if Image is not None:
    Image.MAX_IMAGE_PIXELS = MAX_EDGE * MAX_EDGE


class GalleryError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def reset_for_tests() -> None:
    global _quota_bytes, _quota_images
    _quota_bytes = QUOTA_BYTES
    _quota_images = QUOTA_IMAGES


def set_quota_for_tests(byte_cap: int | None = None, image_cap: int | None = None) -> None:
    global _quota_bytes, _quota_images
    _quota_bytes = QUOTA_BYTES if byte_cap is None else int(byte_cap)
    _quota_images = QUOTA_IMAGES if image_cap is None else int(image_cap)


def gallery_dir(root: Path) -> Path:
    return Path(root) / ".hq-forge" / "gallery"


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _base(root: Path) -> Path:
    base = gallery_dir(root)
    base.mkdir(parents=True, exist_ok=True)
    resolved = base.resolve()
    if resolved.is_symlink():
        raise GalleryError("bad_id")
    return resolved


def _child(root: Path, image_id: str) -> Path:
    if not IMG_RE.fullmatch(image_id):
        raise GalleryError("bad_id")
    base = _base(root)
    target = base / image_id
    if target.is_symlink():
        raise GalleryError("bad_id")
    resolved = target.resolve()
    if resolved.parent != base:
        raise GalleryError("bad_id")
    return resolved


def _settings(value: dict) -> dict:
    if not isinstance(value, dict):
        raise GalleryError("bad_image")
    prompt = value.get("prompt")
    negative = value.get("negative_prompt", "")
    if not isinstance(prompt, str) or not isinstance(negative, str):
        raise GalleryError("bad_image")
    if len(prompt) > 2000 or len(negative) > 1000:
        raise GalleryError("bad_image")
    out = {"prompt": prompt, "negative_prompt": negative}
    for key, limit in (("checkpoint", 200), ("sampler_name", 80), ("scheduler", 80)):
        item = value.get(key, "")
        if not isinstance(item, str) or len(item) > limit or "\\" in item or ".." in item:
            raise GalleryError("bad_image")
        out[key] = item
    for key in ("width", "height", "steps", "n_iter", "batch_size", "seed"):
        item = value.get(key)
        if not isinstance(item, int) or isinstance(item, bool):
            raise GalleryError("bad_image")
        out[key] = item
    cfg = value.get("cfg_scale")
    if not isinstance(cfg, (int, float)) or isinstance(cfg, bool):
        raise GalleryError("bad_image")
    out["cfg_scale"] = float(cfg)
    enabled = value.get("enable_hr", False)
    if enabled is True:
        upscaler = value.get("hr_upscaler", "")
        scale = value.get("hr_scale")
        second = value.get("hr_second_pass_steps")
        denoise = value.get("denoising_strength")
        if not isinstance(upscaler, str) or not upscaler or len(upscaler) > 180 or "\\" in upscaler or ".." in upscaler:
            raise GalleryError("bad_image")
        if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not math.isfinite(float(scale)):
            raise GalleryError("bad_image")
        if isinstance(second, bool) or not isinstance(second, int):
            raise GalleryError("bad_image")
        if isinstance(denoise, bool) or not isinstance(denoise, (int, float)) or not math.isfinite(float(denoise)):
            raise GalleryError("bad_image")
        out["enable_hr"] = True
        out["hr_scale"] = float(scale)
        out["hr_upscaler"] = upscaler
        out["hr_second_pass_steps"] = second
        out["denoising_strength"] = float(denoise)
    elif enabled is not False:
        raise GalleryError("bad_image")
    # C: a variation records Forge's variation seed and strength next to the original seed.
    strength = value.get("subseed_strength")
    if strength is not None and strength != 0:
        subseed = value.get("subseed")
        if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not 0 < float(strength) <= 1:
            raise GalleryError("bad_image")
        if isinstance(subseed, bool) or not isinstance(subseed, int) or not 0 <= subseed < 2**32:
            raise GalleryError("bad_image")
        out["subseed"] = subseed
        out["subseed_strength"] = round(float(strength), 3)
    return out


def _usage(root: Path) -> tuple[int, int]:
    base = gallery_dir(root)
    if not base.is_dir():
        return 0, 0
    images = 0
    total = 0
    for child in base.iterdir():
        if child.is_symlink() or not child.is_dir() or not IMG_RE.fullmatch(child.name):
            continue
        original = child / "original.png"
        if not original.is_file() or original.is_symlink():
            continue
        images += 1
        for path in child.iterdir():
            if path.is_symlink() or not path.is_file():
                continue
            try:
                total += path.stat().st_size
            except OSError:
                continue
    return images, total


def cleanup_partials(root: Path) -> None:
    base = gallery_dir(root)
    if not base.is_dir() or base.is_symlink():
        return
    for child in list(base.iterdir()):
        if child.is_symlink():
            continue
        if child.name.endswith(".tmp") or child.name.endswith(".partial"):
            if child.is_dir():
                shutil.rmtree(child, ignore_errors=True)
            else:
                child.unlink(missing_ok=True)


def _infotext_value(value) -> str:
    text = str(value)
    if any(ch in text for ch in ",:\n\""):
        return json.dumps(text, ensure_ascii=False)
    return text


def _number(value) -> str:
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def infotext(settings: dict) -> str:
    """A1111/Forge 'parameters' text from stored settings. Only fields HQ itself
    recorded; nothing from Forge's response is copied."""
    if not isinstance(settings, dict):
        return ""
    lines = [str(settings.get("prompt") or "")]
    negative = str(settings.get("negative_prompt") or "")
    if negative:
        lines.append("Negative prompt: " + negative)
    fields = []
    def add(label, value):
        if value is None or value == "":
            return
        fields.append(label + ": " + _infotext_value(value))
    add("Steps", settings.get("steps"))
    add("Sampler", settings.get("sampler_name"))
    scheduler = settings.get("scheduler")
    add("Schedule type", scheduler.capitalize() if isinstance(scheduler, str) and scheduler == "automatic" else scheduler)
    cfg = settings.get("cfg_scale")
    add("CFG scale", _number(cfg) if isinstance(cfg, (int, float)) and not isinstance(cfg, bool) else None)
    seed = settings.get("seed")
    add("Seed", seed if isinstance(seed, int) and not isinstance(seed, bool) and seed >= 0 else None)
    width, height = settings.get("width"), settings.get("height")
    strength = settings.get("subseed_strength")
    if isinstance(strength, (int, float)) and not isinstance(strength, bool) and strength > 0:
        add("Variation seed", settings.get("subseed"))
        add("Variation seed strength", _number(strength))
    add("Size", f"{width}x{height}" if isinstance(width, int) and isinstance(height, int) else None)
    checkpoint = settings.get("checkpoint")
    if isinstance(checkpoint, str) and checkpoint:
        name, _sep, rest = checkpoint.partition(" [")
        model_hash = rest[:-1] if rest.endswith("]") else ""
        add("Model hash", model_hash or None)
        stem = name.rsplit("/", 1)[-1]
        for ext in (".safetensors", ".ckpt", ".gguf", ".pt"):
            if stem.endswith(ext):
                stem = stem[: -len(ext)]
        add("Model", stem)
    if settings.get("enable_hr") is True:
        add("Denoising strength", _number(settings.get("denoising_strength")))
        add("Hires upscale", _number(settings.get("hr_scale")))
        add("Hires steps", settings.get("hr_second_pass_steps"))
        add("Hires upscaler", settings.get("hr_upscaler"))
    lines.append(", ".join(fields))
    return "\n".join(lines)


def with_parameters(png: bytes, settings: dict) -> bytes:
    """Re-save an HQ PNG with a 'parameters' text chunk. Used for explicit exports."""
    if Image is None or PngInfo is None:
        raise GalleryError("no_pillow")
    try:
        image = Image.open(io.BytesIO(png))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise GalleryError("bad_image") from None
    info = PngInfo()
    info.add_text(PARAMETERS_KEY, infotext(settings))
    out = io.BytesIO()
    image.save(out, format="PNG", pnginfo=info)
    return out.getvalue()


def _decode(raw: bytes, parameters: str | None = None) -> tuple[bytes, bytes, int, int]:
    if Image is None:
        raise GalleryError("no_pillow")
    if not isinstance(raw, (bytes, bytearray)) or not raw or len(raw) > MAX_BYTES:
        raise GalleryError("bad_image")
    try:
        probe = Image.open(io.BytesIO(bytes(raw)))
        probe.verify()
        image = Image.open(io.BytesIO(bytes(raw)))
        image.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise GalleryError("bad_image") from None
    if image.format not in ("PNG", "JPEG", "WEBP"):
        raise GalleryError("bad_image")
    width, height = image.size
    if width < 64 or height < 64 or width > MAX_EDGE or height > MAX_EDGE:
        raise GalleryError("bad_image")
    rgb = image.convert("RGB")
    original = io.BytesIO()
    if parameters and PngInfo is not None:
        info = PngInfo()
        info.add_text(PARAMETERS_KEY, parameters)
        rgb.save(original, format="PNG", pnginfo=info)
    else:
        rgb.save(original, format="PNG")
    thumb = rgb.copy()
    thumb.thumbnail((THUMB_EDGE, THUMB_EDGE))
    thumb_buf = io.BytesIO()
    thumb.save(thumb_buf, format="JPEG", quality=80)
    return original.getvalue(), thumb_buf.getvalue(), width, height


def _atomic_bytes(path: Path, payload: bytes) -> None:
    temporary = path.with_suffix(path.suffix + ".partial")
    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        if getattr(exc, "errno", None) in (28, 112) or getattr(exc, "winerror", None) == 112:
            raise GalleryError("disk") from None
        raise GalleryError("disk") from None


def prepare_image(raw: bytes) -> tuple[bytes, bytes, int, int]:
    """Re-encode a PNG, JPEG, or WEBP without any metadata. Callers store the
    result; nothing is written here. The vault relies on this staying clean."""
    return _decode(raw)


def _origin(value) -> dict | None:
    """Optional provenance for multi-device batches: worker id/name and batch id. Short ASCII-safe text only."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise GalleryError("bad_image")
    out = {}
    for key, limit in (("worker_id", 40), ("worker_name", 40), ("batch_id", 40), ("task_id", 40), ("checkpoint_sha256", 64), ("finish_of", 40)):
        item = value.get(key)
        if item is None:
            continue
        if not isinstance(item, str) or len(item) > limit or any(ord(ch) < 32 for ch in item):
            raise GalleryError("bad_image")
        if key == "finish_of" and not IMG_RE.fullmatch(item):
            raise GalleryError("bad_image")  # E: the gallery image this 'finition' started from
        out[key] = item
    return out or None


def store(root: Path, raw: bytes, settings: dict, *, origin: dict | None = None) -> dict:
    safe = _settings(settings)
    png, thumb, width, height = _decode(raw, infotext(safe))
    provenance = _origin(origin)
    with _LOCK:
        images, used = _usage(root)
        incoming = len(png) + len(thumb) + 4096
        if images >= _quota_images or used + incoming > _quota_bytes:
            raise GalleryError("quota")
        image_id = "img-" + os.urandom(12).hex()
        final = _child(root, image_id)
        temporary = final.with_name(image_id + ".tmp")
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
        temporary.mkdir()
        try:
            _atomic_bytes(temporary / "original.png", png)
            _atomic_bytes(temporary / "thumb.jpg", thumb)
            meta = {
                "id": image_id,
                "created": _now(),
                "width": width,
                "height": height,
                "bytes": len(png),
                "settings": safe,
            }
            if provenance:
                meta["origin"] = provenance
            _atomic_bytes(temporary / "meta.json", json.dumps(meta, ensure_ascii=False).encode("utf-8"))
            os.replace(temporary, final)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
    return {"id": image_id, "width": width, "height": height}


def _meta(root: Path, image_id: str) -> dict:
    folder = _child(root, image_id)
    path = folder / "meta.json"
    if not path.is_file() or path.is_symlink():
        raise GalleryError("bad_id")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        raise GalleryError("bad_id") from None
    if not isinstance(data, dict) or data.get("id") != image_id:
        raise GalleryError("bad_id")
    return data


def get(root: Path, image_id: str) -> dict:
    data = _meta(root, image_id)
    return {
        "id": image_id,
        "created": data.get("created"),
        "width": data.get("width"),
        "height": data.get("height"),
        "settings": data.get("settings") if isinstance(data.get("settings"), dict) else {},
        "origin": data.get("origin") if isinstance(data.get("origin"), dict) else None,
        "triage": triage_of(data),
        "original": f"/api/forge/gallery/{image_id}/original",
        "thumb": f"/api/forge/gallery/{image_id}/thumb",
    }


TRIAGE = ("none", "keep", "reject", "favorite")


def triage_of(meta: dict) -> str:
    """Images stored before Phase A have no flag: they read as 'none' (not sorted)."""
    value = meta.get("triage") if isinstance(meta, dict) else None
    return value if value in TRIAGE else "none"


def set_triage(root: Path, image_id: str, state) -> dict:
    """Reversible sort flag. 'reject' only hides the image in the bin; nothing is deleted."""
    if state not in TRIAGE:
        raise GalleryError("bad_triage")
    with _LOCK:
        data = _meta(root, image_id)
        before = triage_of(data)
        if state == "none":
            data.pop("triage", None)
        else:
            data["triage"] = state
        _atomic_bytes(_child(root, image_id) / "meta.json", json.dumps(data, ensure_ascii=False).encode("utf-8"))
    return {"id": image_id, "triage": state, "previous": before}


def triage_map(root: Path) -> dict:
    """image id -> flag, for statistics (keep rate). Reads meta only, never pixels."""
    out = {}
    base = gallery_dir(root)
    if base.is_dir() and not base.is_symlink():
        for child in base.iterdir():
            if child.is_symlink() or not IMG_RE.fullmatch(child.name):
                continue
            try:
                out[child.name] = triage_of(_meta(root, child.name))
            except GalleryError:
                continue
    return out


def page(root: Path, *, limit: int = 24, cursor: str | None = None, view: str = "") -> dict:
    limit = 24 if not isinstance(limit, int) else max(1, min(PAGE_MAX, limit))
    rows = []
    base = gallery_dir(root)
    if base.is_dir() and not base.is_symlink():
        for child in base.iterdir():
            if child.is_symlink() or not IMG_RE.fullmatch(child.name):
                continue
            try:
                rows.append(_meta(root, child.name))
            except GalleryError:
                continue
    # The bin holds rejected images; every other view hides them. 'untriaged' feeds quick triage.
    if view == "trash":
        rows = [item for item in rows if triage_of(item) == "reject"]
    elif view == "untriaged":
        rows = [item for item in rows if triage_of(item) == "none"]
    else:
        rows = [item for item in rows if triage_of(item) != "reject"]
    rows.sort(key=lambda item: (str(item.get("created") or ""), item.get("id") or ""), reverse=True)
    if cursor:
        if not IMG_RE.fullmatch(cursor):
            raise GalleryError("bad_id")
        ids = [item.get("id") for item in rows]
        if cursor in ids:
            rows = rows[ids.index(cursor) + 1 :]
    chosen = rows[:limit]
    public = []
    for item in chosen:
        image_id = item.get("id")
        if not isinstance(image_id, str):
            continue
        public.append({
            "id": image_id,
            "created": item.get("created"),
            "width": item.get("width"),
            "height": item.get("height"),
            "triage": triage_of(item),
            "thumb": f"/api/forge/gallery/{image_id}/thumb",
        })
    next_cursor = public[-1]["id"] if len(rows) > limit and public else None
    return {"images": public, "next_cursor": next_cursor}


HISTORY_FIELDS = ("prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler", "width", "height",
                  "steps", "cfg_scale", "seed", "n_iter", "enable_hr", "hr_scale", "hr_upscaler",
                  "hr_second_pass_steps", "denoising_strength", "subseed", "subseed_strength")


def history_page(root: Path, *, limit: int = 24, cursor: str | None = None, query: str = "") -> dict:
    """Prompt history for Forge Studio: the normal gallery, newest first, with its
    stored settings and an optional case-insensitive search over every retained
    image. Same rows, retention and deletion as page(); pixels are not read."""
    limit = 24 if not isinstance(limit, int) else max(1, min(PAGE_MAX, limit))
    needle = (query or "").strip().casefold()[:200]
    rows = []
    base = gallery_dir(root)
    if base.is_dir() and not base.is_symlink():
        for child in base.iterdir():
            if child.is_symlink() or not IMG_RE.fullmatch(child.name):
                continue
            try:
                rows.append(_meta(root, child.name))
            except GalleryError:
                continue
    rows.sort(key=lambda item: (str(item.get("created") or ""), item.get("id") or ""), reverse=True)
    if needle:
        def hit(item: dict) -> bool:
            settings = item.get("settings") if isinstance(item.get("settings"), dict) else {}
            return any(needle in str(settings.get(key) or "").casefold() for key in ("prompt", "negative_prompt", "checkpoint"))
        rows = [item for item in rows if hit(item)]
    total = len(rows)
    if cursor:
        if not IMG_RE.fullmatch(cursor):
            raise GalleryError("bad_id")
        ids = [item.get("id") for item in rows]
        if cursor in ids:
            rows = rows[ids.index(cursor) + 1 :]
    chosen = rows[:limit]
    entries = []
    for item in chosen:
        image_id = item.get("id")
        if not isinstance(image_id, str):
            continue
        settings = item.get("settings") if isinstance(item.get("settings"), dict) else {}
        entries.append({
            "id": image_id,
            "created": item.get("created"),
            "thumb": f"/api/forge/gallery/{image_id}/thumb",
            "settings": {key: settings[key] for key in HISTORY_FIELDS if key in settings},
        })
    next_cursor = entries[-1]["id"] if len(rows) > limit and entries else None
    return {"entries": entries, "next_cursor": next_cursor, "total": total}


def file_bytes(root: Path, image_id: str, kind: str) -> tuple[bytes, str, str]:
    folder = _child(root, image_id)
    if kind == "original":
        path = folder / "original.png"
        ctype = "image/png"
        filename = f"forge-{image_id}.png"
        disposition = "attachment"
    elif kind == "thumb":
        path = folder / "thumb.jpg"
        ctype = "image/jpeg"
        filename = f"forge-{image_id}-thumb.jpg"
        disposition = "inline"
    else:
        raise GalleryError("bad_id")
    if not path.is_file() or path.is_symlink():
        raise GalleryError("bad_id")
    return path.read_bytes(), ctype, f'{disposition}; filename="{filename}"'


def delete(root: Path, image_id: str) -> dict:
    folder = _child(root, image_id)
    if not folder.is_dir() or folder.is_symlink():
        raise GalleryError("bad_id")
    shutil.rmtree(folder)
    return {"deleted": image_id}


def serve_file(root: Path, raw: str):
    prefix = "/api/forge/gallery/"
    if not raw.startswith(prefix):
        return None
    rest = raw[len(prefix):]
    if rest.endswith("/original"):
        image_id, kind = rest[: -len("/original")], "original"
    elif rest.endswith("/thumb"):
        image_id, kind = rest[: -len("/thumb")], "thumb"
    else:
        return None
    try:
        payload, ctype, disposition = file_bytes(root, image_id, kind)
    except GalleryError:
        return 404, {"error": "Introuvable"}, "application/json", None
    return 200, payload, ctype, [("Content-Disposition", disposition), ("Cache-Control", "private, no-store")]
