"""Prepare Kohya-style v2 dataset for Forgia (l'alchimiste) character LoRA (multi-aspect, deduplicated, per-image Danbooru captions)."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
OUT_DEFAULT = ROOT / ".hq-ai" / "forgia_lora_dataset" / "10_forgia"

TRIGGER_PREFIX = "forgia_char, 1girl, solo"

# Curated, visually-verified multi-aspect dataset entries for Forgia:
CURATED_DATASET: list[tuple[str, tuple[int, int, int, int] | None, str]] = [
    (
        "assets/companion/forgia-body-nsfw.webp",
        None,
        "full body, standing, looking at viewer, playful confident smile, blush, holding tongs, black leather blacksmith apron, sideboob, black garter straps, black thighhighs, black ankle boots, dark foundry background, floating embers and fire",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_01_close_portrait.jpg",
        None,
        "close-up, portrait, face focus, looking at viewer, confident warm smile, brown and black alchemist coat, glowing golden collar emblem, floating embers bokeh background",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_02_anvil_apron.jpg",
        None,
        "cowboy shot, standing by glowing forge anvil, holding blacksmith hammer, looking at viewer, playful confident smirk, black leather blacksmith apron over fitted top, warm firelight and flying sparks",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_03_side_profile_workbench.jpg",
        None,
        "upper body, three-quarter view, leaning over wooden drafting table with glowing blueprints, looking over shoulder at viewer, focused analytical expression, brown alchemist jacket, warm lantern light",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_04_sitting_anvil.jpg",
        None,
        "cowboy shot, sitting on stone ledge in foundry workshop, crossed legs, looking at viewer, teasing smile, black leather apron, black thighhighs, warm orange and gold lighting",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_05_casual_sweater.jpg",
        None,
        "upper body, sitting at cozy cafe table, holding espresso cup, gentle affectionate smile, looking at viewer, off-shoulder cream knit sweater, warm golden afternoon light",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_06_evening_dress.jpg",
        None,
        "cowboy shot, standing on candlelit balcony at night, looking at viewer, poised sultry smile, elegant black and gold evening gown, cleavage, warm bokeh lights",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_07_alchemist_library.jpg",
        None,
        "upper body, standing in grand steampunk library studio, holding glowing glass vial, looking at viewer, curious enthusiastic expression, open brown alchemist coat, black corset top, warm brass lamps",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_08_boudoir_corset.jpg",
        None,
        "cowboy shot, sitting on dark velvet bed, leaning forward slightly, looking at viewer, blush, soft seductive smile, black and gold lace corset, garter straps, black thighhighs, warm candlelight",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_09_from_above_relaxing.jpg",
        None,
        "upper body, high angle view, reclining on velvet couch, looking up at viewer, warm affectionate gaze, blush, black silk camisole, cleavage, warm fireplace glow",
    ),
    (
        ".hq-ai/forgia_lora_v2_test/forgia_gen_10_workshop_backview.jpg",
        None,
        "cowboy shot, standing in forge workshop, from behind, looking back over shoulder at viewer, confident smile, backless black leather apron, bare back, warm glowing furnace light",
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
                "character": "forgia",
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
