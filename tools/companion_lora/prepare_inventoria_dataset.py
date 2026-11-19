"""Prepare a canonical-anchored multi-aspect SDXL training dataset for Inventoria (inventoria_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
COMPANION_DIR = ROOT / "assets" / "companion"
GEN_DIR = ROOT / ".hq-ai" / "inventoria_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "inventoria_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_inventoria"

TRIGGER = "inventoria_char, 1girl, solo"
IDENTITY = (
    "petite, shortstack, chibi-stylized, flat chest, small breasts, fair skin, "
    "pale silver-mint hair, short bob cut, chunky blunt bangs, "
    "sharp lime green eyes, slit pupils, heavy black eyeliner, smug cat-like grin, blush"
)

# (source_path, crop_box_or_none, scene_tags)
CANONICAL_SOURCES: list[tuple[Path, tuple[int, int, int, int] | None, str]] = [
    (
        COMPANION_DIR / "inventoria-chip-busy@2x.webp",
        None,
        "upper body, hands on hips, glossy emerald-teal high-cut leotard, black choker collar, emerald diamond chest gem, mechanical elbow joints, teal forearm gauntlets, black gloves, modern kitchen, looking at viewer",
    ),
    (
        COMPANION_DIR / "inventoria-chip-sister@2x.webp",
        None,
        "cowboy shot, sitting on kitchen counter, glossy white and teal high-cut leotard, emerald diamond chest gem, mechanical shoulder joints, teal forearm gauntlets, black gloves, mischievous cat smile, looking at viewer",
    ),
    (
        COMPANION_DIR / "inventoria-chip-listening@2x.webp",
        None,
        "cowboy shot, leaning forward on kitchen counter, glossy emerald-teal leotard, emerald diamond chest gem, teal forearm gauntlets, black gloves, pointed elf ears, green ribbon bow, looking at viewer",
    ),
    (
        COMPANION_DIR / "inventoria-chip@2x.webp",
        (256, 0, 1024, 1024),  # crop out dwarf head on far left
        "full body, standing barefoot, hands on counter, glossy emerald-teal high-cut leotard, emerald diamond chest gem, mechanical shoulder joints, teal forearm gauntlets, black gloves, smug grin, looking at viewer",
    ),
]

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "inventoria_gen_01_close_portrait.jpg",
        "upper body, close-up portrait, glossy emerald-teal strapless leotard, black choker collar, emerald diamond chest gem, mechanical elbow joints, teal forearm gauntlets, black gloves, smug playful smirk, looking at viewer, dark emerald bokeh background",
    ),
    (
        "inventoria_gen_02_pantry_tablet.jpg",
        "full body, standing barefoot, glossy emerald-teal high-cut leotard, black collar, emerald diamond chest gem, mechanical elbow joints, teal forearm gauntlets, black gloves, holding small clipboard and pen, pantry shelves with jars, hands on hips, smug cheeky grin, looking at viewer",
    ),
    (
        "inventoria_gen_03_sitting_counter.jpg",
        "sitting on kitchen counter, glossy white and teal high-cut leotard, emerald diamond chest gem, mechanical shoulder joints, teal forearm gauntlets, black gloves, cheeky cat-like grin, looking at viewer, modern kitchen",
    ),
    (
        "inventoria_gen_04_stockroom_wide.jpg",
        "cowboy shot, glossy emerald-teal high-cut leotard, emerald diamond chest gem, mechanical elbow joints, teal forearm gauntlets, black gloves, leaning over stockroom counter with labeled storage bins, mischievous smirk, looking at viewer",
    ),
    (
        "inventoria_gen_05_casual_sweater.jpg",
        "cowboy shot, oversized white knit sweater off one shoulder, emerald pendant necklace, black short shorts, holding ceramic mug, cozy sunlit kitchen, cheeky affectionate smile, looking at viewer",
    ),
    (
        "inventoria_gen_06_apron_kitchen.jpg",
        "cute teal apron over glossy black leotard, black collar, mechanical elbow joints, teal forearm gauntlets, black gloves, standing in bright modern kitchen, hands on hips, smug playful grin, looking at viewer",
    ),
    (
        "inventoria_gen_07_boudoir_lingerie.jpg",
        "cowboy shot, sitting on dark silk bed, emerald green and black lace lingerie bralette and panties, black thighhighs, cat ears, cat tail, warm bedside lamp glow, heavy blush, teasing smug smile, looking at viewer",
    ),
    (
        "inventoria_gen_08_backview_stockroom.jpg",
        "cowboy shot, seen from behind, looking back over shoulder at viewer, glossy emerald-teal backless high-cut leotard, bare back, mechanical elbow joints, teal forearm gauntlets, black gloves, modern kitchen pantry, smug cheeky grin",
    ),
]


def main() -> None:
    OUT_IMG_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_IMG_DIR.glob("*"):
        if old.is_file():
            old.unlink()

    manifest: list[dict] = []
    idx = 0

    for src, crop_box, scene_tags in CANONICAL_SOURCES:
        if not src.is_file():
            print(f"SKIP missing {src}")
            continue
        idx += 1
        stem = f"{idx:03d}_{src.stem}"
        out_img = OUT_IMG_DIR / f"{stem}.png"
        out_txt = OUT_IMG_DIR / f"{stem}.txt"
        with Image.open(src) as im:
            rgb = im.convert("RGB")
            if crop_box is not None:
                rgb = rgb.crop(crop_box)
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        caption = f"{TRIGGER}, {IDENTITY}, {scene_tags}"
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
