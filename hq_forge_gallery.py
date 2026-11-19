"""HQ-owned Forge gallery. Forge's own output folders are never read or written."""

from __future__ import annotations

import hashlib
import io
import json
import math
import os
import re
import shutil
import tempfile
import threading
import time
import zipfile
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
# One backup archive, written to a temporary file on the gallery's own volume (entries
# are streamed from disk, never held in memory) and bounded by that volume's free space
# instead of a fixed cap: a full 2 GiB gallery must still be exportable. The plan route
# reports the projected size and that limit before a download starts.
# Restore follows the quota instead of a fixed 512 MiB: a full 2 GiB gallery must be
# restorable. The upload is streamed to disk by the bridge and checked against the
# remaining slots/bytes before the first image is written, so a refused restore leaves
# nothing behind.
IMPORT_MAX = 3 * 1024 * 1024 * 1024
RESTORE_OVERHEAD = 16 * 1024
BACKUP_FILE = "backup.json"
EXPORT_MARGIN = 32 * 1024 * 1024
EXPORT_TTL_SEC = 6 * 60 * 60
EXPORT_DIR = "exports"
ZIP_MANIFEST = "gallery.json"
ZIP_MAX_ENTRIES = QUOTA_IMAGES * 2 + 4

_LOCK = threading.Lock()
# One archive at a time: two concurrent 2 GiB exports would each pass the free-space
# check and then fill the disk together. Generation keeps running (this is not _LOCK).
_EXPORT_LOCK = threading.Lock()
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
    for key, limit in      (("worker_id", 40), ("worker_name", 40), ("batch_id", 40), ("task_id", 40), ("checkpoint_sha256", 64), ("finish_of", 40), ("inpaint_of", 40), ("outpaint_of", 40)):
        item = value.get(key)
        if item is None:
            continue
        if not isinstance(item, str) or len(item) > limit or any(ord(ch) < 32 for ch in item):
            raise GalleryError("bad_image")
        if key in ("finish_of", "inpaint_of", "outpaint_of") and not IMG_RE.fullmatch(item):
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
                "sha256": hashlib.sha256(png).hexdigest(),
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
        # Enough for a readable card caption (model, steps). Never the prompt:
        # the gallery listing stays a thumbnail index, not a prompt dump.
        stored = item.get("settings") if isinstance(item.get("settings"), dict) else {}
        public.append({
            "id": image_id,
            "created": item.get("created"),
            "width": item.get("width"),
            "height": item.get("height"),
            "triage": triage_of(item),
            "thumb": f"/api/forge/gallery/{image_id}/thumb",
            "settings": {"checkpoint": stored.get("checkpoint"), "steps": stored.get("steps")},
        })
    next_cursor = public[-1]["id"] if len(rows) > limit and public else None
    return {"images": public, "next_cursor": next_cursor, "usage": usage(root)}


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


def _wanted_ids(ids) -> set[str] | None:
    """None means the whole gallery. A subset must come from the caller's own ids, so
    every entry is validated before it can steer a file read."""
    if ids is None:
        return None
    if not isinstance(ids, (list, tuple, set)) or len(ids) > QUOTA_IMAGES:
        raise GalleryError("bad_id")
    wanted = set()
    for item in ids:
        if not isinstance(item, str) or not IMG_RE.fullmatch(item):
            raise GalleryError("bad_id")
        wanted.add(item)
    return wanted


def _export_bytes(root: Path, ids=None) -> tuple[int, int]:
    """(images, bytes that will enter the ZIP): original.png + meta.json only, the
    thumbnails are rebuilt on import. Sizes are read from the directory entries, so no
    pixel is loaded just to announce the size of a backup. ids limits the archive to a
    selection (archive-and-free), still without loading any pixel."""
    wanted = _wanted_ids(ids)
    base = gallery_dir(root)
    if not base.is_dir() or base.is_symlink():
        return 0, 0
    images = 0
    total = 0
    for child in base.iterdir():
        if child.is_symlink() or not child.is_dir() or not IMG_RE.fullmatch(child.name):
            continue
        if wanted is not None and child.name not in wanted:
            continue
        original = child / "original.png"
        meta = child / "meta.json"
        if not original.is_file() or original.is_symlink() or not meta.is_file() or meta.is_symlink():
            continue
        try:
            size = original.stat().st_size + meta.stat().st_size
        except OSError:
            continue
        images += 1
        total += size
    return images, total


def _free_bytes(root: Path) -> int:
    try:
        return int(shutil.disk_usage(Path(root)).free)
    except OSError:
        return 0


def export_limit(root: Path) -> int:
    """Largest archive the gallery's own volume can still hold: its free space minus a
    working margin, so building the ZIP never fills the disk the gallery lives on."""
    base = Path(root) / ".hq-forge"
    return max(0, _free_bytes(base if base.is_dir() else root) - EXPORT_MARGIN)


def export_plan(root: Path, ids=None) -> dict:
    """What a backup would write and where its limit stands, before anything starts."""
    images, needed = _export_bytes(root, ids)
    limit = export_limit(root)
    return {"images": images, "bytes": needed, "limit_bytes": limit,
            "allowed": images > 0 and needed <= limit}


def mark_backup(root: Path, plan: dict) -> dict:
    """Remember the last gallery archive whose bytes were fully delivered to the client.
    Call only after a successful HTTP body write; never when export archive creation alone
    finished or when the stream aborted mid-transfer."""
    payload = {"at": _now(), "images": int(plan.get("images") or 0), "bytes": int(plan.get("bytes") or 0)}
    base = Path(root) / ".hq-forge"
    base.mkdir(parents=True, exist_ok=True)
    _atomic_bytes(base / BACKUP_FILE, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    return payload


def backup_status(root: Path) -> dict:
    """Last backup plus the images created since it, read from meta only (no pixels)."""
    path = Path(root) / ".hq-forge" / BACKUP_FILE
    at, images, size = None, 0, 0
    if path.is_file() and not path.is_symlink():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        if isinstance(data.get("at"), str) and 0 < len(data["at"]) <= 40:
            at = data["at"]
            try:
                images = int(data.get("images") or 0)
                size = int(data.get("bytes") or 0)
            except (TypeError, ValueError):
                images = size = 0  # a corrupt marker reads as an old backup, never a 500
    since = 0
    base = gallery_dir(root)
    if base.is_dir() and not base.is_symlink():
        for child in base.iterdir():
            if child.is_symlink() or not IMG_RE.fullmatch(child.name):
                continue
            try:
                created = _meta(root, child.name).get("created")
            except GalleryError:
                continue
            if not at or (isinstance(created, str) and created > at):
                since += 1
    return {"at": at, "images": images, "bytes": size, "since_images": since}


def usage(root: Path) -> dict:
    """Images and bytes against the fixed quota. The bin counts too: its images still
    occupy the gallery until they are put back or deleted. The export figures let the
    page state the backup limit before the owner asks for a ZIP; the backup block says
    when the last full archive left and how many images are newer."""
    images, used = _usage(root)
    export_images, export_bytes = _export_bytes(root)
    return {"images": images, "bytes": used, "quota_images": _quota_images, "quota_bytes": _quota_bytes,
            "export_images": export_images, "export_bytes": export_bytes, "export_limit_bytes": export_limit(root),
            "backup": backup_status(root)}


def empty_trash(root: Path) -> dict:
    """Permanent delete of every rejected image, one folder at a time. Only images
    carrying the reversible reject flag are touched; the gallery and the vault never
    are. Returns how many slots were freed."""
    base = gallery_dir(root)
    if not base.is_dir() or base.is_symlink():
        return {"deleted": 0}
    removed = 0
    for child in list(base.iterdir()):
        if child.is_symlink() or not IMG_RE.fullmatch(child.name):
            continue
        try:
            if triage_of(_meta(root, child.name)) != "reject":
                continue
            shutil.rmtree(_child(root, child.name))
        except (GalleryError, OSError):
            continue
        removed += 1
    return {"deleted": removed}


def _export_dir(root: Path) -> Path:
    base = Path(root) / ".hq-forge" / EXPORT_DIR
    base.mkdir(parents=True, exist_ok=True)
    if base.is_symlink():
        raise GalleryError("disk")
    return base.resolve()


def cleanup_exports(root: Path, max_age: int = EXPORT_TTL_SEC) -> None:
    """A crashed download must not leave an archive behind forever. Only this module's
    own temporary files are touched."""
    base = Path(root) / ".hq-forge" / EXPORT_DIR
    if not base.is_dir() or base.is_symlink():
        return
    cutoff = time.time() - max_age
    for child in base.iterdir():
        if child.is_symlink() or not child.name.startswith("export-") or not child.name.endswith(".zip"):
            continue
        try:
            if child.stat().st_mtime < cutoff:
                child.unlink(missing_ok=True)
        except OSError:
            continue


def export_archive(root: Path, ids=None) -> Path:
    """Write the normal gallery (or the selected ids) to a ZIP on disk and return its
    path; the caller streams it and deletes it. Each member is copied from its file by
    zipfile, so the archive never exists in memory and the images are not read twice.
    Nothing from the vault is ever included."""
    wanted = _wanted_ids(ids)
    if not _EXPORT_LOCK.acquire(blocking=False):
        raise GalleryError("busy")
    try:
        cleanup_exports(root)
        plan = export_plan(root, ids)
        if plan["images"] == 0:
            raise GalleryError("empty")
        if not plan["allowed"]:
            raise GalleryError("too_large")
        target = _export_dir(root) / ("export-" + os.urandom(8).hex() + ".zip")
        base = gallery_dir(root)
        try:
            with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
                archive.writestr(ZIP_MANIFEST, json.dumps(
                    {"kind": "hq-forge-gallery", "version": 1, "exported": _now(), "images": plan["images"]},
                    ensure_ascii=False))
                for child in sorted(base.iterdir()):
                    if child.is_symlink() or not IMG_RE.fullmatch(child.name):
                        continue
                    if wanted is not None and child.name not in wanted:
                        continue
                    original = child / "original.png"
                    meta = child / "meta.json"
                    if not original.is_file() or original.is_symlink() or not meta.is_file() or meta.is_symlink():
                        continue
                    try:
                        archive.write(meta, child.name + "/meta.json")
                        archive.write(original, child.name + "/original.png")
                    except FileNotFoundError:
                        # The gallery moved while this long write was running: a backup
                        # that silently misses an image would be worse than a retry.
                        raise GalleryError("changed") from None
        except OSError:
            target.unlink(missing_ok=True)
            raise GalleryError("disk") from None
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return target
    finally:
        _EXPORT_LOCK.release()


def _restore_meta(root: Path, image_id: str, source: dict) -> None:
    """Keep the backup's date and sort flag. The id, the pixels and the settings stay
    HQ's own: store() already validated and re-encoded them."""
    with _LOCK:
        data = _meta(root, image_id)
        created = source.get("created")
        if isinstance(created, str) and 0 < len(created) <= 40 and created.isascii():
            data["created"] = created
        flag = source.get("triage")
        if flag in TRIAGE and flag != "none":
            data["triage"] = flag
        _atomic_bytes(_child(root, image_id) / "meta.json", json.dumps(data, ensure_ascii=False).encode("utf-8"))


def _zip_pairs(archive: zipfile.ZipFile) -> tuple[list[tuple[str, dict]], int, int]:
    """Group a backup's members by image id, refusing anything outside the two known
    names. Returns (complete pairs, incomplete images, uncompressed bytes)."""
    infos = archive.infolist()
    if not infos or len(infos) > ZIP_MAX_ENTRIES:
        raise GalleryError("bad_zip")
    members: dict[str, dict] = {}
    total = 0
    for info in infos:
        if info.is_dir() or info.filename == ZIP_MANIFEST:
            continue
        parts = info.filename.split("/")
        if len(parts) != 2 or not IMG_RE.fullmatch(parts[0]) or parts[1] not in ("meta.json", "original.png"):
            raise GalleryError("bad_zip")
        limit = MAX_BYTES + 65536 if parts[1] == "original.png" else 2 * 1024 * 1024
        size = int(info.file_size)
        if size < 0 or size > limit:
            raise GalleryError("bad_zip")
        total += size
        if total > IMPORT_MAX:
            raise GalleryError("bad_zip")
        members.setdefault(parts[0], {})[parts[1]] = info
    pairs: list[tuple[str, dict]] = []
    incomplete = 0
    for image_id in sorted(members):
        pair = members[image_id]
        if "meta.json" in pair and "original.png" in pair:
            pairs.append((image_id, pair))
        else:
            incomplete += 1
    return pairs, incomplete, total


def _restore_plan(root: Path, pairs: list, total: int, skipped: int) -> dict:
    images, used = _usage(root)
    needed = total + RESTORE_OVERHEAD * len(pairs)
    remaining_images = max(0, _quota_images - images)
    remaining_bytes = max(0, _quota_bytes - used)
    return {"images": len(pairs), "bytes": total, "needed_bytes": needed, "skipped": skipped,
            "remaining_images": remaining_images, "remaining_bytes": remaining_bytes,
            "allowed": bool(pairs) and len(pairs) <= remaining_images and needed <= remaining_bytes}


def restore_plan_path(root: Path, path: Path) -> dict:
    """Read only the archive's directory and compare it with the remaining quota: a
    restore that cannot fit is refused before the first image is written."""
    try:
        with zipfile.ZipFile(path) as archive:
            pairs, skipped, total = _zip_pairs(archive)
    except (zipfile.BadZipFile, ValueError, OSError):
        raise GalleryError("bad_zip") from None
    return _restore_plan(root, pairs, total, skipped)


def _hash_index(root: Path) -> set[str]:
    """Content hashes already in the gallery, to skip duplicates on restore. New metas
    carry their own sha256; older images are read once (the whole gallery is <= 2 GiB)."""
    known: set[str] = set()
    base = gallery_dir(root)
    if not base.is_dir() or base.is_symlink():
        return known
    for child in base.iterdir():
        if child.is_symlink() or not IMG_RE.fullmatch(child.name):
            continue
        try:
            data = _meta(root, child.name)
        except GalleryError:
            continue
        digest = data.get("sha256")
        if isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest):
            known.add(digest)
            continue
        original = child / "original.png"
        if not original.is_file() or original.is_symlink():
            continue
        try:
            hasher = hashlib.sha256()
            with original.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    hasher.update(chunk)
            known.add(hasher.hexdigest())
        except OSError:
            continue
    return known


def import_zip_path(root: Path, path: Path, *, verify: bool = False, preflight: bool = True, dedupe: bool = True) -> dict:
    """Restore a backup already streamed to disk. The plan is checked against the
    remaining quota first, so a refused restore is atomic. Valid images go through
    store() (HQ's own ids and size rules); byte-identical duplicates are skipped. In
    verify mode every member is read so its CRC is checked, and nothing is stored."""
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, ValueError, OSError):
        raise GalleryError("bad_zip") from None
    with archive:
        pairs, skipped, total = _zip_pairs(archive)
        plan = _restore_plan(root, pairs, total, skipped)
        if verify:
            checked = 0
            for _image_id, pair in pairs:
                try:
                    data = json.loads(archive.read(pair["meta.json"]).decode("utf-8"))
                    if not isinstance(data, dict):
                        raise ValueError("meta")
                    _settings(data.get("settings"))
                    _origin(data.get("origin"))
                    if not archive.read(pair["original.png"]):
                        raise ValueError("empty")
                except (KeyError, OSError, ValueError, UnicodeError, zipfile.BadZipFile, GalleryError):
                    skipped += 1
                    continue
                checked += 1
            return {"verified": checked, "imported": 0, "duplicates": 0, "skipped": skipped,
                    "quota": False, "plan": plan}
        if preflight and not plan["allowed"]:
            raise GalleryError("quota" if len(pairs) > plan["remaining_images"] else "too_large")
        known = _hash_index(root) if dedupe else set()
        imported = duplicates = 0
        full = False
        for _image_id, pair in pairs:
            try:
                data = json.loads(archive.read(pair["meta.json"]).decode("utf-8"))
                raw = archive.read(pair["original.png"])
                if not isinstance(data, dict):
                    raise GalleryError("bad_image")
                settings = _settings(data.get("settings"))
                origin = _origin(data.get("origin"))
            except (KeyError, OSError, ValueError, UnicodeError, zipfile.BadZipFile, GalleryError):
                skipped += 1
                continue
            digest = hashlib.sha256(raw).hexdigest()
            if dedupe and digest in known:
                duplicates += 1
                continue
            try:
                saved = store(root, raw, settings, origin=origin)
            except GalleryError as exc:
                if exc.code == "quota":
                    full = True
                    break
                skipped += 1
                continue
            _restore_meta(root, saved["id"], data)
            known.add(digest)
            imported += 1
    return {"imported": imported, "skipped": skipped, "duplicates": duplicates, "quota": full, "plan": plan}


def import_zip(root: Path, payload: bytes) -> dict:
    """Backwards-compatible in-memory entry point for the unit tests. The HTTP route
    streams to disk and uses import_zip_path; this wrapper keeps the original partial
    quota semantics for callers that already hold the archive in memory."""
    if not isinstance(payload, (bytes, bytearray)) or not payload or len(payload) > IMPORT_MAX:
        raise GalleryError("bad_zip")
    base = Path(root) / ".hq-forge"
    base.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="restore-", suffix=".zip", dir=str(base))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(bytes(payload))
        return import_zip_path(root, Path(name), preflight=False, dedupe=False)
    finally:
        Path(name).unlink(missing_ok=True)


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
    # A thumbnail never changes for its image id, so the browser may keep it: private keeps it out of
    # shared caches and the lifetime makes reopening the gallery free. The original stays no-store.
    cache = "private, max-age=31536000, immutable" if kind == "thumb" else "private, no-store"
    return 200, payload, ctype, [("Content-Disposition", disposition), ("Cache-Control", cache)]
