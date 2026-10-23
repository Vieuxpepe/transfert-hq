"""Forge Studio phase J3: house style, read from the images the owner kept.

The suggestion is the most common value of each technical setting among normal gallery
images sorted 'keep' or 'favorite' (a favourite counts twice). It needs at least
MIN_KEPT kept images. It is labelled Indicatif in the page: it describes what was kept,
not why.

Applying it only fills the form's technical fields (sampler, scheduler, size, steps, CFG);
nothing is generated. The most kept model is shown but never applied: HQ never changes the
model for the owner. The most common negative prompt is offered separately, as text the owner
may copy into the field.

Only the normal gallery is read (meta.json, never pixels). The private vault is never read,
so private settings and prompts never shape the house style.
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

import hq_forge_gallery as gallery

MIN_KEPT = 5
MAX_NEGATIVE = 1000
FIELDS = ("sampler_name", "scheduler", "steps", "cfg_scale")


def _kept(root: Path) -> list:
    rows = []
    base = gallery.gallery_dir(root)
    if not base.is_dir() or base.is_symlink():
        return rows
    for child in base.iterdir():
        if child.is_symlink() or not gallery.IMG_RE.fullmatch(child.name):
            continue
        try:
            meta = gallery._meta(root, child.name)
        except gallery.GalleryError:
            continue
        flag = gallery.triage_of(meta)
        if flag not in ("keep", "favorite"):
            continue
        settings = meta.get("settings") if isinstance(meta.get("settings"), dict) else {}
        rows.append((2 if flag == "favorite" else 1, settings))
    return rows


def _usable(field: str, value):
    if field in ("sampler_name", "scheduler", "checkpoint"):
        return value if isinstance(value, str) and 0 < len(value) <= 200 else None
    if field == "steps":
        return value if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 150 else None
    if field == "cfg_scale":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 1 <= value <= 30:
            return None
        return round(float(value), 1)
    return None


def _mode(counter: Counter, total: int):
    if not counter:
        return None
    value, count = sorted(counter.items(), key=lambda item: (-item[1], str(item[0])))[0]
    return {"value": value, "count": count, "of": total}


def house_style(root: Path) -> dict:
    rows = _kept(root)
    images = len(rows)
    total = sum(weight for weight, _s in rows)
    out = {"kept": images, "minimum": MIN_KEPT, "enough": images >= MIN_KEPT, "indicative": True,
           "style": {}, "model": None, "negative_prompt": None}
    if images < MIN_KEPT:
        return out
    counters = {field: Counter() for field in FIELDS}
    sizes, models, negatives = Counter(), Counter(), Counter()
    for weight, settings in rows:
        for field in FIELDS:
            value = _usable(field, settings.get(field))
            if value is not None:
                counters[field][value] += weight
        w, h = settings.get("width"), settings.get("height")
        if isinstance(w, int) and isinstance(h, int) and not isinstance(w, bool) and not isinstance(h, bool) and 64 <= w <= 2048 and 64 <= h <= 2048:
            sizes[(w, h)] += weight
        model = _usable("checkpoint", settings.get("checkpoint"))
        if model:
            models[model] += weight
        negative = settings.get("negative_prompt")
        if isinstance(negative, str) and negative.strip() and len(negative) <= MAX_NEGATIVE:
            negatives[negative] += weight
    for field in FIELDS:
        picked = _mode(counters[field], total)
        if picked:
            out["style"][field] = picked
    size = _mode(sizes, total)
    if size:
        out["style"]["size"] = {"value": {"width": size["value"][0], "height": size["value"][1]}, "count": size["count"], "of": total}
    out["model"] = _mode(models, total)
    negative = _mode(negatives, total)
    # Offer a negative prompt only when it is the habit (at least 40 % of the kept weight).
    if negative and negative["count"] * 10 >= total * 4:
        out["negative_prompt"] = negative
    return out


def serve_get(root: Path, raw: str) -> tuple[int, dict] | None:
    if raw == "/api/forge/house-style":
        return 200, house_style(root)
    if raw.startswith("/api/forge/house-style/"):
        return 404, {"error": "Inconnu"}
    return None


def serve_post(root: Path, raw: str, data: dict) -> tuple[int, dict] | None:
    if raw == "/api/forge/house-style" or raw.startswith("/api/forge/house-style/"):
        return 404, {"error": "Inconnu"}  # read-only: applying happens in the page and only fills fields
    return None
