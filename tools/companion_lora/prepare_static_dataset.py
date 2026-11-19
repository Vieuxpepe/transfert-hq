"""Prepare a canonical-anchored multi-aspect SDXL training dataset for Static (static_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
CANONICAL_IMG = ROOT / "assets" / "companion" / "static-canonical.jpg"
GEN_DIR = ROOT / ".hq-ai" / "static_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "static_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_static"

TRIGGER = "static_char, 1girl, solo"
IDENTITY = (
    "adult petite female android, short-stature compact android, "
    "dark gunmetal slate metal skin, oversized olive-gunmetal cranial housing helmet, "
    "glowing yellow starburst crest light on top of helmet, "
    "enormous glowing yellow eyes with bright pupils, mischievous bratty smirk, "
    "long glowing yellow fiber-optic hair strands, black choker collar, "
    "narrow shoulders, flat chest, safety-yellow accent seams"
)
OUTFIT = (
    "black diamond-mesh cybernetic bodysuit with safety-yellow joint seams, "
    "compact gunmetal android limbs"
)

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "static_gen_01_close_portrait.jpg",
        "close-up portrait, upper body, black diamond-mesh chest panel, teasing half-lidded gaze, dark teal workshop bokeh, looking at viewer",
    ),
    (
        "static_gen_02_workshop_stand.jpg",
        f"cowboy shot, standing, {OUTFIT}, hands on hips, bratty smirk, dark server lab background, looking at viewer",
    ),
    (
        "static_gen_03_fullbody_front.jpg",
        f"full body, standing, {OUTFIT}, compact gunmetal boots, dark tech floor, looking at viewer",
    ),
    (
        "static_gen_04_sitting_bench.jpg",
        f"full body, sitting on edge of metal server rack, dangling legs, {OUTFIT}, compact gunmetal boots, mischievous grin, looking at viewer",
    ),
    (
        "static_gen_05_side_profile.jpg",
        f"cowboy shot, side view looking back over shoulder at viewer, {OUTFIT}, glowing yellow fiber-optic hair cascading down back, neon yellow rim light",
    ),
    (
        "static_gen_06_oversized_hoodie.jpg",
        "cowboy shot, oversized dark olive and safety-yellow tech hoodie worn off one shoulder over black diamond-mesh top, playful pout, holding glowing yellow diagnostic tablet, looking at viewer",
    ),
    (
        "static_gen_07_console_wide.jpg",
        "wide upper body shot, leaning over glowing holographic circuit console, black diamond-mesh chest panel, mischievous sidelong glance at viewer, dark teal and yellow lighting",
    ),
    (
        "static_gen_08_high_angle.jpg",
        f"high angle shot looking down at her, looking up at viewer with flirty bratty smirk, {OUTFIT}, dark workshop background",
    ),
    (
        "static_gen_09_back_over_shoulder.jpg",
        f"cowboy shot, seen from behind, looking back over shoulder at viewer, {OUTFIT}, glowing yellow fiber-optic hair",
    ),
    (
        "static_gen_10_alluring_lean.jpg",
        "cowboy shot, leaning forward toward viewer, alluring bratty half-lidded gaze, black diamond-mesh lingerie-inspired cybernetic bodysuit with safety-yellow trim, warm rim light",
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
            f"{TRIGGER}, {IDENTITY}, portrait, upper body, black diamond-mesh chest panel, "
            "teasing bratty smirk, dark teal workshop bokeh, looking at viewer"
        )
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": [w, h], "caption": caption})

    for fname, scene in GENERATED_SOURCES:
        src = GEN_DIR / fname
        if not src.is_file():
            raise FileNotFoundError(f"Missing generated source: {src}")
        idx += 1
        stem = f"{idx:03d}_{src.stem}"
        out_img = OUT_IMG_DIR / f"{stem}.png"
        out_txt = OUT_IMG_DIR / f"{stem}.txt"
        with Image.open(src) as im:
            rgb = im.convert("RGB")
            rgb.save(out_img, format="PNG")
            w, h = rgb.size
        caption = f"{TRIGGER}, {IDENTITY}, {scene}"
        out_txt.write_text(caption, encoding="utf-8")
        manifest.append({"file": out_img.name, "size": [w, h], "caption": caption})

    (OUT_ROOT / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"Prepared {len(manifest)} pairs in {OUT_IMG_DIR}")


if __name__ == "__main__":
    main()
