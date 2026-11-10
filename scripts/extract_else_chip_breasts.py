#!/usr/bin/env python3
"""Extract Else chip breast layers (ellipse cups + hair/gem carve)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets" / "companion" / "else-chip@2x.jpg"
OUT = ROOT / "assets" / "companion"
SIZE = 1280


def ellipse_mask(cx: float, cy: float, rx: float, ry: float, rot: float = 0.0) -> np.ndarray:
    ys, xs = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    ang = np.deg2rad(rot)
    X = xs - cx
    Y = ys - cy
    xr = X * np.cos(ang) + Y * np.sin(ang)
    yr = -X * np.sin(ang) + Y * np.cos(ang)
    dist = np.sqrt((xr / rx) ** 2 + (yr / ry) ** 2)
    soft = np.clip(1.0 - (dist - 0.86) / (1.0 - 0.86), 0, 1)
    soft = np.where(dist <= 0.86, 1.0, soft)
    soft = np.where(dist >= 1.0, 0.0, soft)
    return soft.astype(np.float32)


def piping_gate() -> np.ndarray:
    upper = np.full(SIZE, 760.0, dtype=np.float32)
    for x in range(300, 641):
        t = np.clip((x - 450) / (620 - 450), 0, 1)
        upper[x] = 745 + t * 55
    for x in range(640, 1000):
        upper[x] = 800 if x < 700 else 800 - np.clip((x - 700) / (870 - 700), 0, 1) * 50
    ys = np.arange(SIZE, dtype=np.float32)[:, None]
    return ys >= (upper[None, :] - 4)


def feather(mask: np.ndarray, radius: float = 1.6) -> np.ndarray:
    img = Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8), "L")
    img = img.filter(ImageFilter.GaussianBlur(radius=radius))
    return np.asarray(img, dtype=np.float32) / 255.0


def cut_rgba(src: np.ndarray, mask: np.ndarray) -> Image.Image:
    rgba = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    rgba[:, :, :3] = src
    rgba[:, :, 3] = np.clip(mask * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")


def underpaint(src: np.ndarray, mask: np.ndarray) -> np.ndarray:
    m = mask > 0.08
    dil = np.asarray(
        Image.fromarray((m.astype(np.uint8) * 255), "L").filter(ImageFilter.MaxFilter(15)),
        dtype=np.uint8,
    ) > 0
    ring = dil & ~m
    fill = src[ring].mean(axis=0).astype(np.float32) if ring.any() else np.array([20.0, 10.0, 26.0])
    w = np.clip(mask * 1.15, 0.0, 1.0)[:, :, None]
    out = src.astype(np.float32) * (1.0 - w) + fill.reshape(1, 1, 3) * w
    blur = np.asarray(Image.fromarray(out.astype(np.uint8)).filter(ImageFilter.GaussianBlur(radius=2.0))).astype(
        np.float32
    )
    soft = np.clip(mask * 0.8, 0.0, 1.0)[:, :, None]
    return (out * (1.0 - soft) + blur * soft).astype(np.uint8)


def main() -> int:
    src = np.asarray(Image.open(SRC).convert("RGB").resize((SIZE, SIZE), Image.Resampling.LANCZOS))
    r = src[:, :, 0].astype(np.float32)
    g = src[:, :, 1].astype(np.float32)
    b = src[:, :, 2].astype(np.float32)
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b

    left_m = ellipse_mask(470, 885, 150, 138, 6)
    right_m = ellipse_mask(810, 882, 152, 140, -6)
    gate = piping_gate()
    left_m *= gate
    right_m *= gate

    hair = (r > 160) & (g > 90) & (b > 100) & (r > g + 15) & (luma > 130)
    hair = np.asarray(
        Image.fromarray((hair.astype(np.uint8) * 255), "L").filter(ImageFilter.MaxFilter(7)),
        dtype=np.uint8,
    ) > 0
    xs = np.arange(SIZE, dtype=np.float32)[None, :]
    ys = np.arange(SIZE, dtype=np.float32)[:, None]
    gem = ((xs - 648) ** 2) / (62 ** 2) + ((ys - 770) ** 2) / (72 ** 2) < 1.0
    left_m[hair | gem] = 0
    right_m[hair | gem] = 0

    left_m = feather(left_m)
    right_m = feather(right_m)
    overlap = np.minimum(left_m, right_m)
    left_m = np.clip(left_m - overlap * 0.7, 0, 1)
    right_m = np.clip(right_m - overlap * 0.7, 0, 1)

    left = cut_rgba(src, left_m)
    right = cut_rgba(src, right_m)
    left.save(OUT / "else-chip-breast-left.png")
    right.save(OUT / "else-chip-breast-right.png")
    # The chip renders at 120-136 CSS px, so the page loads these small derivatives
    # (208 px for 1x-1.5x, 416 px for 2x-3x); the 1280 px files above stay as masters.
    body = underpaint(src, np.maximum(left_m, right_m))
    body_img = Image.fromarray(body)
    body_img.save(OUT / "else-chip-body.jpg", quality=92, optimize=True)
    for tag, px in (("@1x", 208), ("@2x", 416)):
        left.resize((px, px), Image.Resampling.LANCZOS).save(OUT / f"else-chip-breast-left{tag}.png", optimize=True)
        right.resize((px, px), Image.Resampling.LANCZOS).save(OUT / f"else-chip-breast-right{tag}.png", optimize=True)
        body_img.resize((px, px), Image.Resampling.LANCZOS).save(
            OUT / f"else-chip-body{tag}.jpg", quality=88, optimize=True, progressive=True
        )

    cell = 28
    chk = Image.new("RGB", (SIZE, SIZE))
    px = chk.load()
    for y in range(SIZE):
        for x in range(SIZE):
            px[x, y] = (205, 205, 205) if ((x // cell) + (y // cell)) % 2 == 0 else (145, 145, 145)
    base = chk.convert("RGBA")
    base.alpha_composite(left)
    base.alpha_composite(right)
    base.convert("RGB").crop((300, 720, 980, 1020)).save(OUT / "else-chip-bust-checker.jpg", quality=92)

    arr = src.copy()
    la = left_m > 0.12
    ra = right_m > 0.12
    arr[la, 0] = np.clip(arr[la, 0].astype(np.int16) * 0.35 + 200, 0, 255).astype(np.uint8)
    arr[ra, 2] = np.clip(arr[ra, 2].astype(np.int16) * 0.35 + 220, 0, 255).astype(np.uint8)
    Image.fromarray(arr).crop((300, 720, 980, 1020)).save(OUT / "else-chip-bust-overlay-crop.jpg", quality=92)

    print("left", int(la.sum()), "right", int(ra.sum()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
