"""Build companion-character-sheet.jpg (face ref + body portrait) for ControlNet reference_only."""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets" / "companion"
FACE = ASSETS / "companion-forge-reference.jpg"
BODY_CANDIDATES = (
    ASSETS / "transferania-adult-neutral.jpg",
    ASSETS / "transferania-adult-soft.jpg",
    ASSETS / "transferania-adult-warm.jpg",
)
OUT = ASSETS / "companion-character-sheet.jpg"


def _load(path: Path) -> Image.Image:
    return Image.open(path).convert("RGB")


def _fit(im: Image.Image, w: int, h: int) -> Image.Image:
    im = im.copy()
    im.thumbnail((w, h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGB", (w, h), (24, 18, 22))
    ox = (w - im.width) // 2
    oy = (h - im.height) // 2
    canvas.paste(im, (ox, oy))
    return canvas


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--width", type=int, default=1024)
    ap.add_argument("--height", type=int, default=512)
    args = ap.parse_args()
    if not FACE.is_file():
        print(f"Missing face reference: {FACE}")
        return 1
    body_path = next((p for p in BODY_CANDIDATES if p.is_file()), None)
    if body_path is None:
        print("No body portrait found")
        return 1
    half_w = args.width // 2
    face = _fit(_load(FACE), half_w - 8, args.height - 24)
    body = _fit(_load(body_path), half_w - 8, args.height - 24)
    sheet = Image.new("RGB", (args.width, args.height), (18, 12, 16))
    sheet.paste(face, (4, 12))
    sheet.paste(body, (half_w + 4, 12))
    draw = ImageDraw.Draw(sheet)
    try:
        font = ImageFont.truetype("arial.ttf", 18)
    except OSError:
        font = ImageFont.load_default()
    draw.text((12, 4), "face ref", fill=(200, 180, 190), font=font)
    draw.text((half_w + 12, 4), "body / outfit ref", fill=(200, 180, 190), font=font)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.out, quality=93, optimize=True)
    print(f"Wrote {args.out} ({args.width}x{args.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
