#!/usr/bin/env python3
"""SFW chip icons — minimal, distinct: Else (circle + E) vs Inventoria (squircle + grid)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "companion"
MOOD_SUFFIXES = ("", "-listening", "-speaking", "-proactive", "-sister", "-busy")
MOOD_DOT = {
    "": None,
    "-listening": "#60a5fa",
    "-speaking": "#e879f9",
    "-proactive": "#fbbf24",
    "-sister": "#f472b6",
    "-busy": "#94a3b8",
}


def _font(size: int, bold: bool = True):
    for path in (
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def _blend(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(x + (y - x) * t) for x, y in zip(a, b))


def draw_else(size: int, mood: str) -> Image.Image:
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    c = size // 2
    for r in range(c, 0, -3):
        t = r / c
        col = _blend((30, 27, 75), (124, 58, 237), 1 - t ** 0.85)
        draw.ellipse((c - r, c - r, c + r, c + r), fill=col + (255,))
    ring = max(2, size // 48)
    draw.ellipse((ring, ring, size - ring, size - ring), outline=(233, 213, 255, 90), width=ring)
    font = _font(int(size * 0.42))
    draw.text((c, c), "E", fill="#faf5ff", font=font, anchor="mm")
    dot_col = MOOD_DOT.get(mood)
    if dot_col:
        d = max(8, size // 16)
        draw.ellipse((size - d - ring * 2, ring * 2, size - ring * 2, ring * 2 + d), fill=dot_col)
    return im.convert("RGB")


def draw_inventoria(size: int, mood: str) -> Image.Image:
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    m = max(6, size // 14)
    rad = size // 5
    accent = MOOD_DOT.get(mood) or "#2dd4bf"
    draw.rounded_rectangle((m, m, size - m, size - m), radius=rad, fill="#0f766e", outline=accent, width=max(2, size // 56))

    pad = int(size * 0.22)
    inner = size - 2 * pad
    cell = inner // 3
    ox, oy = pad, pad + size // 28
    gap = max(2, size // 80)
    for row in range(3):
        for col in range(3):
            x1 = ox + col * cell + gap
            y1 = oy + row * cell + gap
            x2 = ox + (col + 1) * cell - gap
            y2 = oy + (row + 1) * cell - gap
            fill = "#ecfdf5" if (row + col) % 2 == 0 else "#ccfbf1"
            draw.rounded_rectangle((x1, y1, x2, y2), radius=max(2, size // 64), fill=fill)

    cx, cy = size // 2, oy + inner // 2
    g = max(5, size // 22)
    draw.polygon(
        [(cx, cy - g), (cx + g, cy), (cx, cy + g), (cx - g, cy)],
        fill="#14b8a6",
        outline="#064e3b",
    )
    return im.convert("RGB")


def save(draw_fn, prefix: str) -> None:
    for suffix in MOOD_SUFFIXES:
        base = prefix + suffix
        for side, tag in ((640, ""), (1280, "@2x")):
            img = draw_fn(side, suffix)
            if side != 640:
                img = img.resize((side, side), Image.Resampling.LANCZOS)
            img.save(OUT / f"{base}-sfw{tag}.webp", "WEBP", quality=92, method=6)
        print("wrote", f"{base}-sfw.webp")


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    save(draw_else, "else-chip")
    save(draw_inventoria, "inventoria-chip")
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
