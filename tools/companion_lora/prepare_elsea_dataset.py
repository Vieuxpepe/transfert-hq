"""Prepare a canonical-anchored multi-aspect SFW SDXL training dataset for Elsea (elsea_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
CANONICAL_IMG = ROOT / "assets" / "companion" / "elsea-canonical.jpg"
GEN_DIR = ROOT / ".hq-ai" / "elsea_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "elsea_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_elsea"

TRIGGER = "elsea_char, 1girl, solo"
IDENTITY = (
    "chibi, 2.5-head chibi proportions, big head, short torso, short slender legs, thin limbs, "
    "pint-sized fairy sprite, huge expressive glowing magenta-pink eyes, flat chest, "
    "dark-skinned female, dark skin, long pointed elf ears, pastel pink bob hair, blunt bangs, "
    "twin black and pink butterfly hair ornaments, glowing pink and white butterfly fairy wings, strictly sfw"
)
OUTFIT = (
    "modest obsidian high-collar sleeveless cyber-fey dress with glowing white butterfly accents, "
    "flared pleated pink-trimmed skirt, black detached flared sleeves, short dark boots with butterfly trim"
)

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "elsea_gen_01_close_portrait.jpg",
        f"full body, {OUTFIT}, gentle warm smile, standing on glowing pink magic circle, enchanted twilight conservatory background, looking at viewer",
    ),
    (
        "elsea_gen_02_square_hover.jpg",
        f"full body, outstretched hands with glowing white butterflies, {OUTFIT}, cheerful smile, glowing moonlit flower garden, looking at viewer",
    ),
    (
        "elsea_gen_03_three_quarter.jpg",
        f"full body, three-quarter view, standing on a glowing violet magic circle, outstretched hand with glowing butterfly, {OUTFIT}, happy smile, looking at viewer",
    ),
    (
        "elsea_gen_04_sitting_cushion.jpg",
        f"full body, sitting cross-legged on a plush dark purple cushion, {OUTFIT}, reading a small glowing purple magic book, happy expression, looking at viewer",
    ),
    (
        "elsea_gen_05_landscape_desk.jpg",
        f"wide shot, sitting on a dark wood desk pouring glowing pink tea from a teacup, {OUTFIT}, curious expression, looking at viewer",
    ),
    (
        "elsea_gen_06_casual_hoodie.jpg",
        "full body, cute pastel pink cable-knit cardigan sweater over black pleated skirt and pink-laced boots, cozy indoor library, happy smile, looking at viewer",
    ),
    (
        "elsea_gen_07_side_profile.jpg",
        f"full body, three-quarter side view, {OUTFIT}, standing on glowing pink magic circle, glowing pink butterfly wings, twilight arches background, looking at viewer",
    ),
    (
        "elsea_gen_08_moonlit_balcony.jpg",
        f"wide shot, sitting on a stone balcony railing overlooking a starry night sky and glowing city lights, {OUTFIT}, serene smile, looking at viewer",
    ),
    (
        "elsea_gen_09_cyber_lantern.jpg",
        "full body, modest pastel purple and pink tunic dress with black ribbon belt and short boots, holding a glowing pink fairy lantern, enchanted forest, looking at viewer",
    ),
    (
        "elsea_gen_10_backview_wings.jpg",
        f"full body, three-quarter side view standing on glowing pink magic circle, outstretched hand with glowing butterfly, {OUTFIT}, cute smile, looking at viewer",
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
            f"{TRIGGER}, {IDENTITY}, full body, {OUTFIT}, "
            "hovering in enchanted twilight conservatory with glowing blossoms and magic circle, looking at viewer"
        )
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "source": CANONICAL_IMG.name})

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
        caption = f"{TRIGGER}, {IDENTITY}, {scene_caption}"
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "source": fname})

    (OUT_ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Wrote {len(manifest)} curated multi-aspect pairs -> {OUT_IMG_DIR}")


if __name__ == "__main__":
    main()
