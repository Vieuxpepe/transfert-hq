"""Build lower-body and arm PNG layers for rig-neutral-v1 (aligned to source.jpg)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
RIG = ROOT / "assets" / "companion" / "rig-neutral-v1"
SOURCE = ROOT / "assets" / "companion" / "transferania-adult-neutral.jpg"
FULLBODY_GEN = RIG / "gen-fullbody-neutral-v1.jpg"
LOWER_GEN = RIG / "gen-lower-body.jpg"
CANVAS = 512
Y_SEAM = 402


def load_rgba(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGBA")
    if im.size != (CANVAS, CANVAS):
        im = im.resize((CANVAS, CANVAS), Image.Resampling.LANCZOS)
    return im


def white_key(im: Image.Image, thresh: int = 248) -> Image.Image:
    rgba = im.convert("RGBA")
    arr = np.array(rgba, dtype=np.uint8)
    rgb = arr[:, :, :3].astype(np.int16)
    white = (rgb.min(axis=2) >= thresh) | (rgb.mean(axis=2) >= thresh - 6)
    arr[white, 3] = 0
    return Image.fromarray(arr, "RGBA")


def align_vertical(full: Image.Image, src: Image.Image) -> Image.Image:
    """Keep registration stable; small shifts only so hips stay on-canvas."""
    f = np.array(full.convert("RGB"), dtype=np.float32)
    s = np.array(src.convert("RGB"), dtype=np.float32)
    y0, y1 = 40, 260
    best_dy = 0
    best_score = float("inf")
    for dy in range(-6, 7):
        scores: list[float] = []
        for y in range(y0, y1):
            fy = y + dy
            if fy < 0 or fy >= CANVAS:
                continue
            scores.append(float(np.mean((f[fy, :, :] - s[y, :, :]) ** 2)))
        if not scores:
            continue
        score = float(np.mean(scores))
        if score < best_score:
            best_score = score
            best_dy = dy
    if best_dy == 0:
        return full
    out = Image.new("RGBA", full.size, (0, 0, 0, 0))
    out.paste(full, (0, best_dy))
    return out


def skin_mask(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    return (
        (r > 125)
        & (r < 245)
        & (g > 95)
        & (g < 215)
        & (b > 85)
        & (b < 215)
        & ((r - g) < 60)
        & ((r - b) < 85)
    )


def lace_mask(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    dark = (r < 95) & (g < 95) & (b < 105)
    purple_hair = (r < 120) & (g < 90) & (b > 110)
    return dark & ~purple_hair


def background_mask(rgb: np.ndarray) -> np.ndarray:
    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    window = (r > 210) & (g > 175) & (b > 120) & (b < 210)
    wall = (r > 175) & (g > 155) & (b > 130) & (r - b < 40)
    wood = (r > 118) & (r < 205) & (g > 78) & (g < 170) & (b > 55) & (b < 130) & (r - g > 8)
    return window | wall | wood


def feather_alpha(alpha: np.ndarray, y0: int, band: int = 14) -> np.ndarray:
    out = alpha.astype(np.float32)
    for i in range(band):
        y = y0 + i
        if y >= CANVAS:
            break
        t = (i + 1) / band
        out[y, :] *= t
    return np.clip(out, 0, 255).astype(np.uint8)


def in_bust_overlap(x: int, y: int) -> bool:
    if y >= 472:
        return False
    return ((x - 256) / 118) ** 2 + ((y - 392) / 88) ** 2 < 1.0


def extract_from_fullbody(full: Image.Image, src: Image.Image) -> tuple[Image.Image, Image.Image, Image.Image]:
    full = align_vertical(full, src)
    f = np.array(full, dtype=np.uint8)
    rgb = f[:, :, :3]
    hair = (rgb[:, :, 0] < 105) & (rgb[:, :, 1] < 82) & (rgb[:, :, 2] > 108)
    bg = background_mask(rgb)

    lower = np.zeros((CANVAS, CANVAS, 4), dtype=np.uint8)
    arm_l = np.zeros_like(lower)
    arm_r = np.zeros_like(lower)

    for y in range(Y_SEAM, CANVAS):
        for x in range(CANVAS):
            if bg[y, x] or hair[y, x]:
                continue
            if in_bust_overlap(x, y):
                continue
            lower[y, x] = f[y, x]

    for y in range(248, 505):
        for x in range(96, 196):
            if bg[y, x] or hair[y, x] or in_bust_overlap(x, y):
                continue
            if not (skin_mask(rgb)[y, x] or lace_mask(rgb)[y, x]):
                continue
            arm_l[y, x] = f[y, x]
        for x in range(316, 416):
            if bg[y, x] or hair[y, x] or in_bust_overlap(x, y):
                continue
            if not (skin_mask(rgb)[y, x] or lace_mask(rgb)[y, x]):
                continue
            arm_r[y, x] = f[y, x]

    lower[:, :, 3] = feather_alpha(lower[:, :, 3], Y_SEAM, band=20)
    return Image.fromarray(lower, "RGBA"), Image.fromarray(arm_l, "RGBA"), Image.fromarray(arm_r, "RGBA")


def build_lower_fallback() -> Image.Image:
    gen = white_key(load_rgba(LOWER_GEN), 235)
    gen = gen.filter(ImageFilter.GaussianBlur(radius=0.35))
    gen = white_key(gen, 242)
    target_w = 332
    scale = target_w / gen.width
    target_h = max(1, int(round(gen.height * scale)))
    gen = gen.resize((target_w, target_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    x = (CANVAS - target_w) // 2
    y = CANVAS - target_h + 8
    canvas.alpha_composite(gen, (x, y))
    arr = np.array(canvas)
    arr[:, :, 3] = feather_alpha(arr[:, :, 3], max(Y_SEAM, y))
    return Image.fromarray(arr, "RGBA")


def main() -> None:
    src = load_rgba(SOURCE)
    if FULLBODY_GEN.is_file():
        full = load_rgba(FULLBODY_GEN)
        lower, arm_l, arm_r = extract_from_fullbody(full, src)
    else:
        if not LOWER_GEN.is_file():
            raise SystemExit("Need gen-fullbody-neutral-v1.jpg or gen-lower-body.jpg in rig-neutral-v1/")
        lower = build_lower_fallback()
        arm_l = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        arm_r = arm_l.copy()

    lower.save(RIG / "lower-body.png", optimize=True)
    arm_l.save(RIG / "arm-left.png", optimize=True)
    arm_r.save(RIG / "arm-right.png", optimize=True)
    print("Wrote lower-body.png, arm-left.png, arm-right.png (fullbody-aligned)")


if __name__ == "__main__":
    main()
