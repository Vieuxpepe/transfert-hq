"""Prepare a canonical-anchored multi-aspect SDXL training dataset for Kinetia (kinetia_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
CANONICAL_IMG = ROOT / "assets" / "companion" / "kinetia-canonical.jpg"
GEN_DIR = ROOT / ".hq-ai" / "kinetia_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "kinetia_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_kinetia"

TRIGGER = "kinetia_char, 1girl, solo"
IDENTITY = (
    "adult woman, mature female, athletic slender curvy figure, fair skin, "
    "symmetrical platinum silver-white hair with cobalt blue underside, geometric bob cut, "
    "twin side braids, precision blunt bangs, vivid electric-indigo eyes, dryly amused wry smirk, "
    "symmetrical white and cobalt servo headband earpieces"
)
OUTFIT = (
    "cropped open white high-tech lab jacket with rolled sleeves, black and cyan choker, "
    "fitted glossy dark cybernetic bodysuit with glowing cyan joint-axis markings, "
    "white utility belt with pouches, black fingerless calibration gloves"
)

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "kinetia_gen_01_close_portrait.jpg",
        f"upper body, close-up portrait, {OUTFIT}, one gloved finger adjusting servo earpiece, glowing cyan robotics lab monitors bokeh, looking at viewer",
    ),
    (
        "kinetia_gen_02_roarm_bench.jpg",
        f"cowboy shot, {OUTFIT}, standing beside desktop 4-axis robotic arm on test bench, holding digital calipers, holographic XYZ trajectory plot, looking at viewer",
    ),
    (
        "kinetia_gen_03_sitting_workbench.jpg",
        f"full body, sitting on edge of metal robotics workbench, legs crossed, {OUTFIT}, white tech boots, holding glowing cyan diagnostic tablet, looking at viewer",
    ),
    (
        "kinetia_gen_04_side_profile_lab.jpg",
        f"cowboy shot, side view, looking back over shoulder at viewer, {OUTFIT}, calibrating wall-mounted servo rail with glowing stylus, cobalt and cyan rim lighting",
    ),
    (
        "kinetia_gen_05_casual_hoodie.jpg",
        f"cowboy shot, oversized cropped white and cobalt tech hoodie off one shoulder over black bralette, black athletic shorts, holding coffee mug, apartment workbench, looking at viewer",
    ),
    (
        "kinetia_gen_06_evening_dress.jpg",
        f"cowboy shot, sleek midnight-cobalt and silver halter evening dress with high side slit, crystal cocktail glass, glass balcony at night, city lights bokeh, looking at viewer",
    ),
    (
        "kinetia_gen_07_console_wide.jpg",
        f"wide upper body shot, {OUTFIT}, leaning over dual-monitor robotics simulation console showing symmetrical XY trajectory curves, looking at viewer",
    ),
    (
        "kinetia_gen_08_boudoir_lingerie.jpg",
        f"cowboy shot, sitting on dark slate silk bed, leaning back on hands, black and cobalt-blue lace lingerie set, garter belt, black sheer thighhighs, warm bedside lamp glow, soft blush, looking at viewer",
    ),
    (
        "kinetia_gen_09_from_above_blueprint.jpg",
        f"high angle shot from above, leaning over glowing glass drafting table with symmetrical robotic joint blueprints, dark bodysuit, open white lab jacket, chin resting on gloved hand, looking up at viewer",
    ),
    (
        "kinetia_gen_10_backview_lab.jpg",
        f"cowboy shot, seen from behind, looking back over shoulder at viewer, fitted dark cybernetic bodysuit with glowing cyan spine axis lines, cropped white lab jacket, blue robotics corridor",
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
            f"{TRIGGER}, {IDENTITY}, cowboy shot, {OUTFIT}, holding calibration tool, "
            "white knee-high tech armor, glowing cyan robotics lab monitors background, looking at viewer"
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
        out_txt.write_text(f"{TRIGGER}, {IDENTITY}, {scene_caption}", encoding="utf-8")
        manifest.append({"file": out_img.name, "size": f"{w}x{h}", "source": fname})

    manifest_path = OUT_ROOT / "dataset_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(manifest)} curated multi-aspect pairs -> {OUT_IMG_DIR}")
    print(f"Manifest: {manifest_path}")


if __name__ == "__main__":
    main()
