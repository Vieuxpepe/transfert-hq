"""Prepare a canonical-anchored multi-aspect SFW SDXL training dataset for Securia (securia_char)."""
from __future__ import annotations

import json
from pathlib import Path
from PIL import Image

ROOT = Path(r"C:\Transfert")
CANONICAL_IMG = ROOT / "assets" / "companion" / "securia-canonical.jpg"
GEN_DIR = ROOT / ".hq-ai" / "securia_lora_v2_test"
OUT_ROOT = ROOT / ".hq-ai" / "securia_lora_dataset"
OUT_IMG_DIR = OUT_ROOT / "10_securia"

TRIGGER = "securia_char, 1girl, solo"
IDENTITY = (
    "chibi, very petite, pint-sized, 3-head chibi proportions, fair pale skin, "
    "electric cyan-blue hair, short bob cut, blunt bangs, "
    "large glowing cyan eyes, HUD reticle pupils, deadpan unamused expression, "
    "black cybernetic comms headphones with glowing cyan emblem"
)
OUTFIT = (
    "oversized dark navy tactical sentinel coat with bright cyan inner collar lining and long sleeves, "
    "black turtleneck bodysuit, chest harness clasp, black pleated tactical skirt, "
    "utility belt with hanging digital keycard badge, double thigh straps, black leggings, chunky laced combat boots"
)

GENERATED_SOURCES: list[tuple[str, str]] = [
    (
        "securia_gen_02_hologram_shield.jpg",
        f"full body, {OUTFIT}, holding translucent glowing cyan holographic digital padlock shield in right hand, glowing cyan grid floor, dark server corridor, looking at viewer",
    ),
    (
        "securia_gen_03_sitting_server_rack.jpg",
        f"full body, sitting on black server rack cabinet, dangling legs, {OUTFIT}, holding glowing cyan diagnostic tablet, dark data center, looking at viewer",
    ),
    (
        "securia_gen_04_side_profile_keycard.jpg",
        f"cowboy shot, side view, looking back over shoulder at viewer, {OUTFIT}, swiping glowing cyan keycard against locked vault door panel, cyan and indigo rim lighting",
    ),
    (
        "securia_gen_05_casual_hoodie.jpg",
        f"full body, oversized dark charcoal zip hoodie with cyan trim and sleeves covering hands, black pleated skirt, black leggings, chunky boots, holding steaming coffee mug, cozy dim desk lamp room, looking at viewer",
    ),
    (
        "securia_gen_07_clipboard_check.jpg",
        f"full body, {OUTFIT}, holding large glowing cyan digital clipboard with both hands, standing beside locked steel blast door, deadpan inspecting gaze, looking at viewer",
    ),
    (
        "securia_gen_08_rain_night_patrol.jpg",
        f"full body, {OUTFIT}, holding translucent glowing cyan cyber umbrella at night, wet neon pavement, raindrops, city lights bokeh, looking at viewer",
    ),
    (
        "securia_gen_09_from_above_desk.jpg",
        f"high angle shot from above, sitting in oversized dark gaming chair at security desk, {OUTFIT}, surrounded by glowing cyan firewall monitors, chin resting on sleeve, looking up at viewer",
    ),
    (
        "securia_gen_10_backview_corridor.jpg",
        f"full body, seen from behind, looking back over shoulder at viewer, {OUTFIT}, oversized tactical coat billowing slightly with sleeve patches visible, glowing cyan grid server corridor",
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
            "holding translucent glowing cyan holographic digital shield in right hand, "
            "glowing cyan grid floor, dark server corridor, looking at viewer"
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
