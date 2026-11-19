"""Prepare a canonical-anchored multi-aspect SDXL training dataset for Culinia (culinia_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
CANONICAL_SFW = ROOT / "assets" / "companion" / "culinia-chip-sfw.webp"
CANONICAL_NSFW = ROOT / "assets" / "companion" / "culinia-body-nsfw.webp"
GEN_DIR = ROOT / ".hq-ai" / "culinia_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "culinia_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_culinia"

TRIGGER = "culinia_char, 1girl, solo"
IDENTITY = (
    "adult woman, mature female, fair warm skin, blush, "
    "chestnut brown hair, messy side bun, long face-framing sidelocks, soft parted bangs, "
    "warm golden amber eyes, gentle affectionate smile, curvy hourglass figure, wide hips"
)

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "culinia_gen_01_close_portrait.jpg",
        "upper body, close-up portrait, white chef toque hat with gold pin, white double-breasted chef jacket with black and gold mandarin collar, holding silver tasting spoon, warm bistro kitchen bokeh, looking at viewer",
    ),
    (
        "culinia_gen_02_chef_kitchen.jpg",
        "cowboy shot, white chef toque hat, white chef jacket with black and gold trim, dark skirt, plating gourmet dish on marble counter, warm kitchen lighting, looking at viewer",
    ),
    (
        "culinia_gen_03_naked_apron_stove.jpg",
        "full body, white chef hat, frilly white naked apron tied at waist, white lace-top thighhighs with garter straps, bare shoulders, holding wooden spoon beside simmering pot, warm cozy kitchen, looking at viewer",
    ),
    (
        "culinia_gen_04_side_profile_wine.jpg",
        "cowboy shot, side view, looking back over shoulder at viewer, white chef jacket with black and gold collar, pouring red wine into crystal glass, amber rim lighting",
    ),
    (
        "culinia_gen_05_casual_sweater.jpg",
        "cowboy shot, cozy cream knit sweater off one shoulder, brown waist apron, holding ceramic coffee mug, golden croissants, sunlit kitchen counter, looking at viewer",
    ),
    (
        "culinia_gen_06_evening_dress.jpg",
        "cowboy shot, sleek deep burgundy satin halter evening dress, high side slit, champagne glass, candlelit bistro terrace at night, looking at viewer",
    ),
    (
        "culinia_gen_07_prep_counter_wide.jpg",
        "wide upper body shot, white chef toque hat, white chef jacket with black and gold trim, leaning over wooden prep island with fresh herbs and copper cookware, looking at viewer",
    ),
    (
        "culinia_gen_08_boudoir_lingerie.jpg",
        "cowboy shot, sitting on cream silk bed, leaning back on hands, ivory and gold lace lingerie set, garter belt, white sheer thighhighs, warm bedside lamp glow, soft blush, looking at viewer",
    ),
    (
        "culinia_gen_09_from_above_tasting.jpg",
        "high angle shot from above, leaning forward over kitchen counter, white chef hat, frilly white naked apron, holding bowl of whipped cream and whisk, heavy blush, looking up at viewer",
    ),
    (
        "culinia_gen_10_backview_kitchen.jpg",
        "full body, standing in warm kitchen leaning against counter, white chef hat, white frilly naked apron tied at waist, white lace-top thighhighs with garter straps, looking at viewer",
    ),
]


def main() -> None:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_IMG_DIR.glob("*"):
        if old.is_file():
            old.unlink()

    manifest: list[dict] = []
    idx = 0

    if CANONICAL_SFW.is_file():
        idx += 1
        stem = f"{idx:03d}_{CANONICAL_SFW.stem}"
        out_img = OUT_IMG_DIR / f"{stem}.png"
        out_txt = OUT_IMG_DIR / f"{stem}.txt"
        with Image.open(CANONICAL_SFW) as im:
            rgb = im.convert("RGB")
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        caption = (
            f"{TRIGGER}, {IDENTITY}, close-up portrait, white chef toque hat with gold pin, "
            "white double-breasted chef jacket with black and gold mandarin collar, "
            "holding silver tasting spoon, warm bistro kitchen bokeh, looking at viewer"
        )
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "source": CANONICAL_SFW.name})

    if CANONICAL_NSFW.is_file():
        idx += 1
        stem = f"{idx:03d}_{CANONICAL_NSFW.stem}"
        out_img = OUT_IMG_DIR / f"{stem}.png"
        out_txt = OUT_IMG_DIR / f"{stem}.txt"
        with Image.open(CANONICAL_NSFW) as im:
            rgb = im.convert("RGB")
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        caption = (
            f"{TRIGGER}, {IDENTITY}, full body, white chef hat, frilly white naked apron tied at waist, "
            "white lace-top thighhighs with garter straps, bare shoulders, holding wooden spoon beside simmering pot, "
            "warm kitchen, looking at viewer"
        )
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "source": CANONICAL_NSFW.name})

    for fname, scene_caption in GENERATED_SOURCES:
        src = GEN_DIR / fname
        if not src.is_file():
            continue
        idx += 1
        stem = f"{idx:03d}_{src.stem}"
        out_img = OUT_IMG_DIR / f"{stem}.png"
        out_txt = OUT_IMG_DIR / f"{stem}.txt"
        with Image.open(src) as im:
            rgb = im.convert("RGB")
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        out_txt.write_text(f"{TRIGGER}, {IDENTITY}, {scene_caption}", encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "source": fname})

    manifest_path = OUT_ROOT / "dataset_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(manifest)} curated multi-aspect pairs -> {OUT_IMG_DIR}")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
