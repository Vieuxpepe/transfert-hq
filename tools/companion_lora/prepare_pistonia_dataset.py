"""Prepare a canonical-anchored multi-aspect SDXL training dataset for Pistonia (pistonia_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
CANONICAL_IMG = ROOT / "assets" / "companion" / "pistonia-chip@2x.webp"
GEN_DIR = ROOT / ".hq-ai" / "pistonia_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "pistonia_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_pistonia"

TRIGGER = "pistonia_char, 1girl, solo"
IDENTITY = (
    "adult woman, mature female, fair warm skin, "
    "auburn hair, high ponytail, orange hair streaks, messy bangs, "
    "golden amber eyes, half-lidded eyes, confident smirk, "
    "orange-tinted mechanic goggles on head, "
    "large breasts, narrow waist, wide hips, athletic curvy figure"
)

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "pistonia_gen_01_close_portrait.jpg",
        "upper body, close-up portrait, black cropped tank top, dark teal mechanic overalls with brown suspenders, leather wrist cuff, engine grease smudge on cheek, warm golden engine room glow, looking at viewer",
    ),
    (
        "pistonia_gen_02_engine_room_wrench.jpg",
        "cowboy shot, black sports bra, dark teal mechanic cargo overalls unzipped at waist with hanging brown suspenders, black fingerless mechanic glove, giant steel wrench over shoulder, industrial engine room, looking at viewer",
    ),
    (
        "pistonia_gen_03_side_profile_gauge.jpg",
        "cowboy shot, side view, looking back over shoulder at viewer, dark teal mechanic coveralls tied around waist over black tank top, brass pressure gauge on steam pipe, wrench, warm amber machine room lighting",
    ),
    (
        "pistonia_gen_04_sitting_workbench.jpg",
        "cowboy shot, sitting on steel mechanic workbench, legs crossed, white cropped tank top, dark teal mechanic cargo pants, brown lace-up work boots, diagnostic tablet and wrench, looking at viewer",
    ),
    (
        "pistonia_gen_05_casual_jacket.jpg",
        "cowboy shot, cropped brown leather bomber jacket over black bralette, high-waisted dark denim jeans, holding steaming coffee mug, cozy lounge, warm lamp light, looking at viewer",
    ),
    (
        "pistonia_gen_06_evening_dress.jpg",
        "cowboy shot, sleek black and copper-gold halter evening dress, cleavage, high side slit, penthouse balcony railing at night, city lights bokeh, looking at viewer",
    ),
    (
        "pistonia_gen_07_control_console_wide.jpg",
        "wide upper body shot, black sleeveless turtleneck, dark teal mechanic overalls, engine telemetry console with glowing amber monitors and analog dials, looking at viewer",
    ),
    (
        "pistonia_gen_08_boudoir_lingerie.jpg",
        "cowboy shot, sitting on dark silk bed, leaning back on hands, black and copper-gold lace lingerie set, garter belt, black sheer thighhighs, warm bedside lamp glow, soft blush, looking at viewer",
    ),
    (
        "pistonia_gen_09_from_above_relaxing.jpg",
        "high angle shot from above, lying back on leather sofa, fitted black cropped tank top, dark teal cargo pants, one arm behind head, looking up at viewer",
    ),
    (
        "pistonia_gen_10_backview_garage.jpg",
        "cowboy shot, seen from behind, looking back over shoulder at viewer, fitted black halter top, dark teal mechanic cargo pants with tool belt, steel wrench, warm lit engine bay",
    ),
]


def main() -> None:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_IMG_DIR.glob("*"):
        if old.is_file():
            old.unlink()

    manifest: list[dict] = []
    idx = 0

    if CANONICAL_IMG.is_file():
        idx += 1
        stem = f"{idx:03d}_{CANONICAL_IMG.stem}"
        out_img = OUT_IMG_DIR / f"{stem}.png"
        out_txt = OUT_IMG_DIR / f"{stem}.txt"
        with Image.open(CANONICAL_IMG) as im:
            rgb = im.convert("RGB")
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        caption = (
            f"{TRIGGER}, {IDENTITY}, full body, standing, topless, bare chest, "
            "dark teal mechanic cargo overalls unzipped at waist with hanging brown suspenders, "
            "brown lace-up work boots, black fingerless glove, leather wrist cuff, "
            "giant steel wrench over shoulder, industrial engine room archway, looking at viewer"
        )
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "caption": caption})

    for fname, scene_tags in GENERATED_SOURCES:
        src = GEN_DIR / fname
        if not src.is_file():
            print(f"SKIP missing {src}")
            continue
        idx += 1
        stem = f"{idx:03d}_{src.stem}"
        out_img = OUT_IMG_DIR / f"{stem}.png"
        out_txt = OUT_IMG_DIR / f"{stem}.txt"
        with Image.open(src) as im:
            rgb = im.convert("RGB")
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        caption = f"{TRIGGER}, {IDENTITY}, {scene_tags}"
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "caption": caption})

    (OUT_ROOT / "dataset_manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Wrote {len(manifest)} curated multi-aspect pairs -> {OUT_IMG_DIR}")
    print(f"Manifest: {OUT_ROOT / 'dataset_manifest.json'}")


if __name__ == "__main__":
    main()
