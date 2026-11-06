"""Import a generated grip image into assets/transferina-hand-grip.png (976x352)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "transferina-hand-grip.png"
SHOWCASE_A = ROOT / "assets" / "transferina-hand-grip-showcase.png"
SHOWCASE_D = ROOT / "docs" / "transferina-hand-grip-showcase.png"
TARGET_W, TARGET_H = 976, 352
GAP_NX = 0.326  # pole gap anchor (normalized x in target canvas)


def key_to_alpha(im: Image.Image, thresh: int = 248) -> Image.Image:
    im = im.convert("RGBA")
    arr = np.array(im, dtype=np.uint8)
    rgb = arr[..., :3].astype(np.int16)
    # white / near-white background
    bright = np.min(rgb, axis=2) > thresh
    # also key very light cream inside hole if present
    lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    bright |= lum > 252
    arr[bright, 3] = 0
    # decontaminate fringes
    edge = arr[..., 3] > 0
    arr[edge, :3] = np.minimum(arr[edge, :3], 245)
    return Image.fromarray(arr, "RGBA")


def trim(im: Image.Image) -> Image.Image:
    bb = im.getbbox()
    return im.crop(bb) if bb else im


def layout_horizontal(im: Image.Image) -> Image.Image:
    """Vertical dorsal art (wrist bottom) -> horizontal sprite (wrist right)."""
    im = im.rotate(-90, expand=True, resample=Image.Resampling.BICUBIC)
    im = trim(im)
    w, h = im.size
    scale = min(TARGET_W * 0.92 / w, TARGET_H * 0.88 / h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (TARGET_W, TARGET_H), (0, 0, 0, 0))
    # align pole gap center to GAP_NX * TARGET_W
    gap_x = int(GAP_NX * TARGET_W)
    paste_x = gap_x - nw // 3  # gap ~ left third in vertical art before rotate; tune after rotate
    paste_y = (TARGET_H - nh) // 2
    paste_x = max(8, min(TARGET_W - nw - 8, paste_x))
    canvas.paste(im, (paste_x, paste_y), im)
    return canvas


def write_showcase(src: Image.Image) -> None:
    w, h = src.size
    bg = Image.new("RGBA", (w, h), (232, 224, 216, 255))
    for y in range(0, h, 24):
        for x in range(0, w, 24):
            if ((x // 24) + (y // 24)) % 2:
                patch = Image.new("RGBA", (min(24, w - x), min(24, h - y)), (210, 202, 194, 255))
                bg.paste(patch, (x, y))
    bg.alpha_composite(src)
    rgb = bg.convert("RGB")
    rgb.save(SHOWCASE_A, optimize=True)
    rgb.save(SHOWCASE_D, optimize=True)


def import_generated(src: Path) -> None:
    im = Image.open(src)
    im = key_to_alpha(im)
    im = layout_horizontal(im)
    im = im.filter(ImageFilter.GaussianBlur(0.35))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    im.save(OUT, optimize=True)
    write_showcase(im)
    print(f"imported {src} -> {OUT}")


def main() -> None:
    if len(sys.argv) < 2:
        print("usage: import_transferina_hand_grip.py <generated-image>")
        raise SystemExit(2)
    import_generated(Path(sys.argv[1]))


if __name__ == "__main__":
    main()
