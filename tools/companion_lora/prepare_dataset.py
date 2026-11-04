"""Prepare Kohya-style dataset from companion Forge assets (captions + 1024 tiles)."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "companion"
OUT_DEFAULT = ROOT / ".hq-ai" / "companion_lora_dataset" / "10_transferania"

CAPTION = (
    "transferania, 1woman, solo, same character, mature adult, fair skin, warm undertone, "
    "long wavy purple hair, magenta hair, amber eyes, golden eyes, full lips, dark red lipstick, "
    "voluptuous, large breasts, narrow waist, wide hips"
)

GLOB_PATTERNS = (
    "transferania-adult-*.jpg",
    "forge-*.jpg",
    "companion-forge-reference.jpg",
)
SKIP = {"companion-character-sheet.jpg"}


def _resize_square(im: Image.Image, size: int) -> Image.Image:
    im = im.convert("RGB")
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    im = im.crop((left, top, left + side, top + side))
    return im.resize((size, size), Image.Resampling.LANCZOS)


def collect_sources() -> list[Path]:
    found: list[Path] = []
    seen: set[str] = set()
    for pat in GLOB_PATTERNS:
        for p in sorted(ASSETS.glob(pat)):
            if p.name in SKIP or not p.is_file():
                continue
            if p.name in seen:
                continue
            seen.add(p.name)
            found.append(p)
    chat = ASSETS / "chat"
    if chat.is_dir():
        for p in sorted(chat.glob("*.jpg")):
            if p.name in seen:
                continue
            seen.add(p.name)
            found.append(p)
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--caption", default=CAPTION)
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    sources = collect_sources()
    if len(sources) < 4:
        print(f"Need at least 4 images; found {len(sources)} under {ASSETS}")
        return 1
    manifest = []
    for i, src in enumerate(sources):
        stem = f"{i:03d}_{src.stem}"[:80]
        dest_img = out / f"{stem}.jpg"
        dest_txt = out / f"{stem}.txt"
        im = Image.open(src)
        im = _resize_square(im, args.size)
        im.save(dest_img, quality=92, optimize=True)
        dest_txt.write_text(args.caption.strip() + "\n", encoding="utf-8")
        manifest.append({"src": str(src.relative_to(ROOT)), "dest": str(dest_img.relative_to(ROOT))})
    meta = out.parent / "dataset_manifest.json"
    meta.write_text(json.dumps({"count": len(manifest), "caption": args.caption, "files": manifest}, indent=2), encoding="utf-8")
    print(f"Wrote {len(manifest)} pairs -> {out}")
    print(f"Manifest: {meta}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
