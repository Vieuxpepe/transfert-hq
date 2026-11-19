"""Prepare Kohya-style v2 dataset for Transferania character LoRA (multi-aspect, deduplicated, per-image Danbooru captions)."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "companion"
GEN_V2 = ROOT / ".hq-ai" / "lora_v2_test"
OUT_DEFAULT = ROOT / ".hq-ai" / "companion_lora_dataset" / "10_transferania"

TRIGGER_PREFIX = "transferania, 1girl, solo"

# Curated, visually-verified multi-aspect dataset entries:
# (relative_path_from_ROOT, optional_crop_box, per_image_variable_tags)
CURATED_DATASET: list[tuple[str, tuple[int, int, int, int] | None, str]] = [
    (
        "artifacts/companion-source/Transferania-source.jpg",
        None,
        "close-up, upper body, from below, looking at viewer, confident smile, closed mouth, black lace bra, cleavage, gold earrings, sunlit room, window, warm lighting",
    ),
    (
        "assets/companion/rig-neutral-v1/gen-fullbody-neutral-v1.jpg",
        (192, 0, 832, 1024),
        "cowboy shot, standing, looking at viewer, slight smile, black lace bra, black lace panties, lingerie, navel, thigh gap, gold earrings, sunlit room, window, warm lighting",
    ),
    (
        "assets/companion/companion-forge-reference.jpg",
        None,
        "close-up, upper body, looking at viewer, parted lips, blush, black lace bra, off-shoulder lace sleeves, cleavage, dark bedroom, curtains, candlelight, purple ambient lighting",
    ),
    (
        "assets/companion/chat/against-glass.jpg",
        None,
        "upper body, close-up, hands on glass, pressed against glass, looking at viewer, parted lips, heavy blush, sweat, steam, black lace bra, cleavage, night, city lights, skyscraper window",
    ),
    (
        "assets/companion/chat/cowgirl-straddle.jpg",
        None,
        "cowboy shot, pov, straddling, sitting on lap, leaning forward, looking down at viewer, parted lips, blush, black lace lingerie, garter straps, thighhighs, bedroom, bedside lamp, warm lighting",
    ),
    (
        "assets/companion/chat/kneeling-collar.jpg",
        None,
        "full body, kneeling on bed, three-quarter view, arched back, looking at viewer, parted lips, blush, black lace choker, black lace bra, garter belt, black thighhighs, high heels, gold earrings, ring, purple bedsheets, spotlight",
    ),
    (
        "assets/companion/chat/doggystyle-lookback.jpg",
        None,
        "full body, on all fours, from behind, looking back at viewer, arched back, ass focus, blush, parted lips, black lace lingerie, sheer lace sleeves, black thong, bed, white bedsheets, bedroom lamp",
    ),
    (
        "assets/companion/transferania-adult-lewd.jpg",
        None,
        "cowboy shot, kneeling on bed, hands on bed, leaning forward, looking at viewer, open mouth, smile, blush, sweat, black lace bra, black lace panties, purple bedsheets, night, city lights, window",
    ),
    (
        "assets/companion/transferania-adult-hc-missionary.jpg",
        None,
        "cowboy shot, pov from above, lying on back, spread legs, head on pillow, looking at viewer, parted lips, heavy blush, sweat, nude, nipples, pussy, purple bedsheets, sunlit bedroom",
    ),
    (
        "assets/companion/transferania-adult-hc-paizuri.jpg",
        None,
        "upper body, close-up, pov, looking up at viewer, tongue out, licking, blush, sweat, nude, breasts pressed together, paizuri, penis, night, rainy window, neon city lights",
    ),
    (
        "assets/companion/transferania-adult-hc-spread.jpg",
        None,
        "cowboy shot, pov, lying on back, legs up, spreading pussy, fingers on pussy, pink nails, looking at viewer, parted lips, heavy blush, sweat, black lace bra, bottomless, purple pillow, candlelight",
    ),
    (
        "assets/companion/transferania-adult-hx-prone-bone.jpg",
        None,
        "cowboy shot, from above, from behind, lying on stomach, arms raised, head turned, side view, closed eyes, parted lips, blush, bare back, black lace thong, ass focus, purple bedsheets",
    ),
    (
        ".hq-ai/lora_v2_test/gen_white_sweater.jpg",
        None,
        "cowboy shot, standing, looking at viewer, warm smile, white off-shoulder cable knit sweater dress, cleavage, long sleeves, gold earrings, red nails, sunlit living room, window, framed picture, potted plant",
    ),
    (
        ".hq-ai/lora_v2_test/gen_closeup_smile.jpg",
        None,
        "close-up, portrait, face focus, head tilt, looking at viewer, smile, parted lips, blush, black ribbed turtleneck sweater, gold chandelier earrings, warm indoor lighting, bokeh",
    ),
    (
        ".hq-ai/lora_v2_test/gen_side_profile.jpg",
        None,
        "upper body, side view, from behind, looking over shoulder at viewer, half-closed eyes, parted lips, blush, red halter evening dress, bare back, sideboob, gold earring, balcony at night, cityscape, city lights, rim lighting",
    ),
    (
        ".hq-ai/lora_v2_test/gen_office_shirt.jpg",
        None,
        "cowboy shot, sitting on desk, crossed legs, hand on glasses, wearing red-framed glasses, looking at viewer, smile, unbuttoned white collared shirt, deep cleavage, black leather miniskirt, red nails, office, chalkboard, window sunlight",
    ),
    (
        ".hq-ai/lora_v2_test/gen_silk_robe.jpg",
        None,
        "cowboy shot, standing by window, holding coffee mug, looking at viewer, smile, open grey bathrobe, black lace bra, cleavage, bedroom, bright morning sunlight",
    ),
    (
        ".hq-ai/lora_v2_test/gen_from_above_bed.jpg",
        None,
        "upper body, pov from above, lying on back on bed, hair spread on white pillow, looking up at viewer, parted lips, heavy blush, black camisole, cleavage, warm lamp light",
    ),
    (
        ".hq-ai/lora_v2_test/gen_outdoor_cafe.jpg",
        None,
        "upper body, sitting at outdoor cafe table, hand on chin, looking at viewer, wink, one eye closed, smile, black leather jacket, low-cut black top, cleavage, gold earrings, sunset, golden hour",
    ),
    (
        ".hq-ai/lora_v2_test/gen_bath_towel.jpg",
        None,
        "upper body, wet hair, water droplets on skin, wrapped in white bath towel, cleavage, bare shoulders, looking at viewer, shy smile, blush, steamy bathroom, warm lighting",
    ),
    (
        ".hq-ai/lora_v2_test/gen_nude_standing.jpg",
        None,
        "cowboy shot, standing, arms behind back, looking at viewer, parted lips, blush, nude, nipples, bare breasts, dimly lit bedroom, moonlight, window, rim lighting",
    ),
]


def _fit_bucket_multiple(im: Image.Image, step: int = 64, min_side: int = 768) -> Image.Image:
    """Preserve native aspect ratio (rounded to 64px bucket multiples) and upscale 512px sources cleanly."""
    im = im.convert("RGB")
    w, h = im.size
    if min(w, h) < min_side:
        scale = min_side / float(min(w, h))
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

    # Purge stale images, captions, and cached .npz latents so old square crops cannot leak into training
    for old_file in out.iterdir():
        if old_file.is_file() and old_file.suffix.lower() in (".jpg", ".png", ".txt", ".npz"):
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
        im = _fit_bucket_multiple(im, step=64, min_side=768)

        stem = f"{idx:03d}_{src.stem}"[:80]
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
