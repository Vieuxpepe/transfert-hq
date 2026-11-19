"""Prepare Kohya-style v2 dataset for Else (l'obsidienne) character LoRA (multi-aspect, deduplicated, per-image Danbooru captions)."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT_DEFAULT = ROOT / ".hq-ai" / "else_lora_dataset" / "10_else"

TRIGGER_PREFIX = "else_char, 1girl, solo"

# Curated, visually-verified multi-aspect dataset entries for Else:
# (relative_path_from_ROOT, optional_crop_box, per_image_variable_tags)
CURATED_DATASET: list[tuple[str, tuple[int, int, int, int] | None, str]] = [
    (
        "assets/companion/else-portrait.jpg",
        None,
        "upper body, cowboy shot, looking at viewer, neutral expression, closed mouth, black cybernetic bodysuit, glowing pink circuit lines, sheer chest cutout, purple rhombus chest gem, long sleeves, dark background, neon purple and cyan energy lines",
    ),
    (
        "assets/companion/else-chip-busy@2x.webp",
        (80, 0, 1232, 1152),
        "upper body, close-up, looking down, furrowed brow, serious focused expression, closed mouth, purple hairclip, black cybernetic bodysuit, glowing pink circuit lines, sheer chest cutout, purple rhombus chest gem, dark background, neon purple energy lines",
    ),
    (
        "assets/companion/else-chip-listening@2x.webp",
        (64, 0, 1216, 1152),
        "upper body, close-up, looking at viewer, gentle smile, blush, attentive expression, black cybernetic bodysuit, glowing pink circuit lines, sheer chest cutout, purple rhombus chest gem, dark background, glowing pink aura, neon energy lines",
    ),
    (
        "assets/companion/else-chip-proactive@2x.webp",
        (64, 48, 1216, 1200),
        "upper body, close-up, head tilt, looking at viewer, confident smirk, sparkling eyes, blue hairclip, black cybernetic bodysuit, sheer chest cutout, purple rhombus chest gem, dark background, neon purple and cyan energy lines",
    ),
    (
        "assets/companion/else-chip-sister@2x.webp",
        None,
        "upper body, close-up, looking at viewer, warm affectionate smile, blush, black cybernetic bodysuit, glowing pink circuit lines, sheer chest cutout, purple rhombus chest gem, dark background, neon purple energy lines",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_01_workshop_bodysuit.jpg",
        None,
        "cowboy shot, standing, looking at viewer, slight confident smile, shoulder-length hair, black cybernetic bodysuit, glowing pink circuit lines, sheer chest cutout, purple rhombus chest gem, high-tech industrial robotics workshop, violet and cyan rim lighting",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_02_closeup_portrait.jpg",
        None,
        "close-up, portrait, face focus, head tilt, looking at viewer, calm analytical expression, subtle smile, black high-collar cybernetic bodysuit, purple rhombus chest gem, glowing neon bokeh background",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_03_side_profile_terminal.jpg",
        None,
        "upper body, side view, looking over shoulder at viewer, cool focused expression, shoulder-length hair, black cybernetic bodysuit, glowing pink circuit lines, glowing blue holographic computer monitors, server room",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_04_lab_coat_glasses.jpg",
        None,
        "cowboy shot, sitting on metal workbench, crossed legs, wearing semi-rimless glasses, holding two wrenches, slight smirk, looking at viewer, shoulder-length hair, open white lab coat, black cybernetic bikini top, midriff, industrial lab, warm and cool lighting",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_05_casual_turtleneck.jpg",
        None,
        "upper body, sitting by window at night, holding black coffee mug, gentle serene smile, looking at viewer, shoulder-length hair, sleeveless black ribbed turtleneck sweater, rainy city window, warm indoor lighting",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_06_evening_dress.jpg",
        None,
        "cowboy shot, standing on rooftop terrace at night, three-quarter view, looking back at viewer, confident poised expression, shoulder-length hair, silver and black backless evening gown, bare back, sideboob, neon city skyline",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_07_boudoir_lingerie.jpg",
        None,
        "cowboy shot, kneeling on dark silk bed, leaning forward, looking at viewer, blush, parted lips, black straps and violet lace lingerie, garter belt, black thighhighs, purple neon ambient lighting",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_08_pov_from_above.jpg",
        None,
        "upper body, pov from above, lying on back on dark sheets, hair spread on pillow, looking up at viewer, heavy blush, parted lips, black lace bra, cleavage, soft violet lighting",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_09_all_fours_lookback.jpg",
        None,
        "full body, on all fours on dark bed, from behind, arched back, looking back over shoulder at viewer, blush, seductive expression, sheer black bodysuit lingerie, ass focus, neon violet rim light",
    ),
    (
        ".hq-ai/else_lora_v2_test/else_gen_10_nude_shower.jpg",
        None,
        "upper body, standing in dark slate shower, wet skin, water droplets, steam, arms at sides, looking at viewer, calm sultry expression, blush, nude, bare breasts, nipples, soft cyan and warm spotlight",
    ),
]


def _fit_bucket_multiple(im: Image.Image, step: int = 64, min_side: int = 768, max_side: int = 1216) -> Image.Image:
    """Preserve native aspect ratio (rounded to 64px bucket multiples)."""
    im = im.convert("RGB")
    w, h = im.size
    if min(w, h) < min_side:
        scale = min_side / float(min(w, h))
        w = int(round(w * scale))
        h = int(round(h * scale))
    if max(w, h) > max_side:
        scale = max_side / float(max(w, h))
        w = int(round(w * scale))
        h = int(round(h * scale))
    target_w = max(step, int(round(w / step)) * step)
    target_h = max(step, int(round(h / step)) * step)
    if (target_w, target_h) != im.size:
        im = im.resize((target_w, target_h), Image.Resampling.LANCZOS)
    return im


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)

    for old_file in out.iterdir():
        if old_file.is_file() and old_file.suffix.lower() in (".jpg", ".png", ".webp", ".txt", ".npz"):
            old_file.unlink()

    seen_hashes: set[str] = set()
    manifest = []
    idx = 0

    for rel_path, crop_box, variable_tags in CURATED_DATASET:
        src = ROOT / rel_path
        if not src.is_file():
            print(f"Skipping missing optional source: {rel_path}")
            continue
        raw_hash = hashlib.sha256(src.read_bytes()).hexdigest()
        if raw_hash in seen_hashes:
            print(f"Skipping duplicate hash: {rel_path}")
            continue
        seen_hashes.add(raw_hash)

        im = Image.open(src).convert("RGB")
        if crop_box is not None:
            im = im.crop(crop_box)
        im = _fit_bucket_multiple(im, step=64, min_side=768, max_side=1216)

        stem = f"{idx:03d}_{src.stem.replace('@2x', '')}"[:80]
        dest_img = out / f"{stem}.jpg"
        dest_txt = out / f"{stem}.txt"
        caption = f"{TRIGGER_PREFIX}, {variable_tags}".strip()

        im.save(dest_img, quality=94, optimize=True)
        dest_txt.write_text(caption + "\n", encoding="utf-8")
        manifest.append(
            {
                "src": rel_path,
                "dest": str(dest_img.relative_to(ROOT)),
                "size": list(im.size),
                "caption": caption,
            }
        )
        idx += 1

    if len(manifest) < 8:
        print(f"Need at least 8 curated images; found {len(manifest)}")
        return 1

    meta = out.parent / "dataset_manifest.json"
    meta.write_text(
        json.dumps(
            {
                "version": 2,
                "character": "else",
                "count": len(manifest),
                "trigger_prefix": TRIGGER_PREFIX,
                "files": manifest,
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"Wrote {len(manifest)} curated multi-aspect pairs -> {out}")
    print(f"Manifest: {meta}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
