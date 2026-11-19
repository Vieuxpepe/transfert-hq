"""Prepare a canonical-anchored multi-aspect SDXL training dataset for Musica (musica_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
CANONICAL_IMG = ROOT / "assets" / "companion" / "musica-chip-nsfw-full-tight@2x.webp"
GEN_DIR = ROOT / ".hq-ai" / "musica_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "musica_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_musica"

TRIGGER = "musica_char, 1girl, solo"
IDENTITY = (
    "petite, shortstack, chibi-stylized, flat chest, small breasts, "
    "small stature, young-looking anime proportions, fair skin, blush, "
    "emerald green hair, long twintails, curled hair tips, blunt bangs, "
    "big bright green eyes, black and red cat ear headphones, fluffy green cat tail, "
    "playful cat smile"
)

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "musica_gen_01_close_portrait.jpg",
        "upper body, close-up portrait, green form-fitting bodysuit, black choker, heart-shaped pupils, heavy blush, playful winking cat smile, looking at viewer, dark neon purple and red studio bokeh",
    ),
    (
        "musica_gen_02_dj_booth.jpg",
        "full body, standing on tiptoes behind DJ turntable console with vinyl records and red LED equalizers, hand on headphone cup, green bodysuit, black lace-trimmed leather hotpants, cheeky cat smile, looking at viewer",
    ),
    (
        "musica_gen_04_side_profile_vinyl.jpg",
        "cowboy shot, side view, looking back over shoulder at viewer, vinyl record shelves, holding vinyl LP sleeve, green bodysuit, black lace-trimmed hotpants, purple and red rim lighting",
    ),
    (
        "musica_gen_05_casual_hoodie.jpg",
        "cowboy shot, oversized black and emerald cropped hoodie with long sleeves over green bodysuit, black pleated mini skirt, holding smartphone and earbuds, cozy neon bedroom, cute affectionate smile, looking at viewer",
    ),
    (
        "musica_gen_06_idol_stage_tunic.jpg",
        "cowboy shot, cute emerald green and black off-shoulder idol dress with ruffled skirt, choker, holding glowing microphone, penthouse balcony at night, city lights bokeh, cheerful cat smile, looking at viewer",
    ),
    (
        "musica_gen_07_mixing_desk_wide.jpg",
        "wide upper body shot, green bodysuit, black cropped zip jacket, leaning over audio mixing console with glowing faders and studio monitors, looking at viewer",
    ),
    (
        "musica_gen_08_boudoir_nightie.jpg",
        "cowboy shot, kneeling on purple silk bed, leaning forward playfully, cute sheer black lace babydoll nightie, thighhighs, red audio cables, heavy blush, heart-shaped pupils, looking at viewer",
    ),
    (
        "musica_gen_09_from_above_cushion.jpg",
        "high angle shot from above, lying on purple velvet bed with green floor cushion, green bodysuit, black lace-trimmed hotpants, chin resting on hands, heavy blush, heart-shaped pupils, looking up at viewer",
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
            w0, h0 = rgb.size
            # Crop out dark sidebars (left/right ~56px) if 1024x1024
            if w0 == 1024 and h0 == 1024:
                rgb = rgb.crop((56, 0, 968, 1024))
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        caption = (
            f"{TRIGGER}, {IDENTITY}, jack-o pose, lying on stomach on purple bed, "
            "green floor cushion, red audio cables, green bodysuit, black lace-trimmed leather hotpants, "
            "heart-shaped pupils, heavy blush, looking at viewer"
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
