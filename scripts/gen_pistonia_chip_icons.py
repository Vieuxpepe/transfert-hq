#!/usr/bin/env python3
"""Pistonia SFW chip icon: amber squircle, cream gear with a piston in its hub.

Writes assets/companion/pistonia-chip-sfw.webp (640 px) and pistonia-chip-sfw@2x.webp (1280 px), the same naming as the other
SFW chip icons. The adult-mode portrait is NOT generated here: drop your image at assets/companion/pistonia-chip.webp
(+ pistonia-chip@2x.webp) and the chip uses it automatically when adult mode is on (see docs/companion/pistonia-chip.md).
"""
from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "companion"
SS = 3                       # supersampling for clean edges


def _lerp(a, b, t):
    return tuple(int(x + (y - x) * t) for x, y in zip(a, b))


def draw(size: int) -> Image.Image:
    s = size * SS
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    m = max(6, s // 14)
    rad = s // 5

    # squircle with a vertical rust -> amber gradient, drawn through a mask
    grad = Image.new("RGBA", (s, s))
    gd = ImageDraw.Draw(grad)
    top, bottom = (124, 45, 18), (245, 158, 11)
    for y in range(s):
        gd.line([(0, y), (s, y)], fill=_lerp(top, bottom, y / s) + (255,))
    mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((m, m, s - m, s - m), radius=rad, fill=255)
    im.paste(grad, (0, 0), mask)
    d.rounded_rectangle((m, m, s - m, s - m), radius=rad, outline=(251, 191, 36, 255), width=max(2, s // 56))

    # gear
    cx = cy = s // 2
    r_out, r_root, teeth = int(s * 0.33), int(s * 0.265), 10
    pts = []
    for i in range(teeth):
        a0 = 2 * math.pi * i / teeth
        step = 2 * math.pi / teeth
        for frac, r in ((-0.30, r_root), (-0.17, r_out), (0.17, r_out), (0.30, r_root)):
            a = a0 + frac * step
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    d.polygon(pts, fill=(255, 247, 237, 255))
    hole = int(s * 0.135)
    d.ellipse((cx - hole - s // 60, cy - hole - s // 60, cx + hole + s // 60, cy + hole + s // 60), fill=(194, 65, 12, 255))
    d.ellipse((cx - hole, cy - hole, cx + hole, cy + hole), fill=(124, 45, 18, 255))

    # piston in the hub: head + rod + crank pin
    hw, hh = int(hole * 0.78), int(hole * 0.5)
    d.rounded_rectangle((cx - hw, cy - hole * 0.82, cx + hw, cy - hole * 0.82 + hh), radius=s // 90, fill=(253, 186, 116, 255))
    rod_w = max(3, s // 70)
    d.rectangle((cx - rod_w, cy - hole * 0.82 + hh, cx + rod_w, cy + hole * 0.35), fill=(255, 237, 213, 255))
    pin = int(hole * 0.24)
    d.ellipse((cx - pin, cy + hole * 0.35 - pin, cx + pin, cy + hole * 0.35 + pin), fill=(251, 191, 36, 255))

    # spark: the accent gem, top-right, like the other chips' corner dot
    g = max(6, s // 20)
    gx, gy = int(s * 0.80), int(s * 0.20)
    d.polygon([(gx, gy - g), (gx + g, gy), (gx, gy + g), (gx - g, gy)], fill=(253, 224, 71, 255), outline=(120, 53, 15, 255))
    return im.resize((size, size), Image.Resampling.LANCZOS)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for side, tag in ((640, ""), (1280, "@2x")):
        draw(side).save(OUT / f"pistonia-chip-sfw{tag}.webp", "WEBP", quality=92, method=6)
        print("wrote", f"pistonia-chip-sfw{tag}.webp")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
