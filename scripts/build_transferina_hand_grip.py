"""Build dorsal (knuckles-forward) transferina-hand-grip.png at 976x352."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "transferina-hand-grip.png"
SHOWCASE = ROOT / "assets" / "transferina-hand-grip-showcase.png"
DOCS_SHOWCASE = ROOT / "docs" / "transferina-hand-grip-showcase.png"
W, H = 976, 352

SKIN = (218, 167, 146)
SKIN_HI = (253, 202, 181)
SKIN_LO = (173, 122, 101)
OUTLINE = (72, 52, 48)
NAIL = (214, 168, 178)
NAIL_HI = (245, 210, 218)


def lerp(a: int, b: int, t: float) -> int:
    return int(a + (b - a) * t)


def skin_grad(draw: ImageDraw.ImageDraw, box, t0: float = 0.0, t1: float = 1.0) -> None:
    x0, y0, x1, y1 = box
    for y in range(y0, y1):
        t = (y - y0) / max(1, y1 - y0)
        c = tuple(lerp(skin_at(t), skin_at(min(1, t + 0.15)), 0.5) for skin_at in (lambda tt: (
            lerp(SKIN_LO[0], SKIN_HI[0], tt),
            lerp(SKIN_LO[1], SKIN_HI[1], tt),
            lerp(SKIN_LO[2], SKIN_HI[2], tt),
        ),))
        draw.line([(x0, y), (x1, y)], fill=c + (255,))


def skin_at(t: float) -> tuple[int, int, int]:
    return (
        lerp(SKIN_LO[0], SKIN_HI[0], t),
        lerp(SKIN_LO[1], SKIN_HI[1], t),
        lerp(SKIN_LO[2], SKIN_HI[2], t),
    )


def stroke(draw: ImageDraw.ImageDraw, *args, **kwargs) -> None:
    kwargs.setdefault("fill", OUTLINE + (255,))
    draw.line(*args, **kwargs)


def build() -> Image.Image:
    base = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    d = ImageDraw.Draw(base)

    gap_cx, gap_cy = 318, 172
    gap_rx, gap_ry = 44, 116

    # Wrist stump (right)
    d.rounded_rectangle([528, 122, 968, 244], radius=56, fill=SKIN + (255,), outline=OUTLINE + (255,), width=3)
    sd.rounded_rectangle([560, 138, 930, 228], fill=(0, 0, 0, 32))

    # Dorsal hand mass — wide shield shape, knuckles at top
    d.polygon(
        [(228, 248), (248, 118), (512, 102), (548, 248), (520, 278), (260, 278)],
        fill=SKIN + (255,),
        outline=OUTLINE + (255,),
    )
    sd.polygon([(260, 130), (500, 118), (520, 230), (280, 240)], fill=(255, 255, 255, 38))

    # Knuckle crests + dorsal nails (viewer sees nail tops, not finger pads)
    knuckle_specs = [
        (268, 108, 58, 36),
        (332, 104, 58, 38),
        (396, 106, 58, 36),
        (458, 112, 54, 34),
    ]
    for i, (kx, ky, kw, kh) in enumerate(knuckle_specs):
        box = [kx - kw // 2, ky - kh // 2, kx + kw // 2, ky + kh // 2]
        d.rounded_rectangle(box, radius=16, fill=SKIN_HI + (255,), outline=OUTLINE + (255,), width=2)
        sd.ellipse([box[0] + 8, box[1] + 4, box[2] - 8, box[3] - 10], fill=(255, 255, 255, 48 - i * 6))
        nail_box = [kx - 20, ky - kh // 2 - 10, kx + 20, ky - kh // 2 + 8]
        d.rounded_rectangle(nail_box, radius=8, fill=NAIL + (255,), outline=OUTLINE + (255,), width=2)
        d.line([(nail_box[0] + 4, nail_box[1] + 3), (nail_box[2] - 4, nail_box[1] + 3)], fill=NAIL_HI + (200,), width=2)

    # Finger backs wrapping gap (left) — vertical strips, dorsal only
    strips = [
        [238, 138, 286, 262],
        [258, 152, 302, 272],
        [278, 166, 318, 280],
        [296, 182, 334, 286],
    ]
    for box in strips:
        d.rounded_rectangle(box, radius=14, fill=SKIN + (255,), outline=OUTLINE + (255,), width=2)

    # Thumb dorsal (right of gap)
    d.polygon(
        [(372, 196), (448, 188), (472, 248), (430, 292), (358, 268)],
        fill=SKIN + (255,),
        outline=OUTLINE + (255,),
    )
    d.rounded_rectangle([388, 188, 448, 212], radius=6, fill=NAIL + (255,), outline=OUTLINE + (255,), width=2)
    sd.polygon([(382, 200), (450, 198), (458, 252), (392, 262)], fill=(255, 255, 255, 28))

    # Crease shadows between metacarpals (dorsal)
    for x in (302, 366, 428):
        sd.line([(x, 118), (x + 8, 248)], fill=(0, 0, 0, 28), width=5)

    # Cut the pole hole (punch through all layers)
    hole = Image.new("L", (W, H), 0)
    hd = ImageDraw.Draw(hole)
    hd.ellipse(
        [gap_cx - gap_rx, gap_cy - gap_ry, gap_cx + gap_rx, gap_cy + gap_ry],
        fill=255,
    )
    for im in (base, shade):
        a = im.split()[3]
        a = ImageChops.subtract(a, hole)
        im.putalpha(a)

    # Inner rim shadow on gap edge
    rim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.ellipse(
        [gap_cx - gap_rx - 4, gap_cy - gap_ry - 4, gap_cx + gap_rx + 4, gap_cy + gap_ry + 4],
        outline=(0, 0, 0, 70),
        width=6,
    )
    rd.ellipse(
        [gap_cx - gap_rx + 2, gap_cy - gap_ry + 2, gap_cx + gap_rx - 2, gap_cy + gap_ry - 2],
        outline=SKIN_LO + (180,),
        width=3,
    )
    base = Image.alpha_composite(base, shade)
    base = Image.alpha_composite(base, rim)

    base = base.filter(ImageFilter.GaussianBlur(0.4))
    return base


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
    SHOWCASE.parent.mkdir(parents=True, exist_ok=True)
    rgb.save(SHOWCASE, optimize=True)
    rgb.save(DOCS_SHOWCASE, optimize=True)


def main() -> None:
    im = build()
    im.save(OUT, optimize=True)
    write_showcase(im)
    print(f"wrote {OUT} ({W}x{H})")
    print(f"wrote {SHOWCASE}")


if __name__ == "__main__":
    main()
