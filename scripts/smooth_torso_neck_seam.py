"""Smooth the neck join in the composite torso and write torso-composite-smooth.jpg.

torso-composite.jpg was made by pasting a new chest under the original portrait. At the base of the
neck the two meet along a hard, jagged line: darker neck shading above, brighter chest below, with a
thin pink edge. This script finds that join (where the composite starts to differ from torso.svg),
paints out the thin edge and blends the two sides over a few pixels. torso-composite.jpg stays the
untouched source; the rig loads the smoothed copy, and build_torso_composite_clean.py starts from it.

    python scripts/smooth_torso_neck_seam.py
"""
from __future__ import annotations

import base64
import io
import re
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

RIG = Path(__file__).resolve().parents[1] / "assets" / "companion" / "rig-neutral-v1"
SRC = RIG / "torso-composite.jpg"
OUT = RIG / "torso-composite-smooth.jpg"
NECK = (214, 236, 312, 268)  # x0, y0, x1, y1 in the 512 grid: the base of the neck


def _embedded(svg: Path) -> np.ndarray:
    text = svg.read_text(encoding="utf-8")
    data = base64.b64decode(re.search(r'base64,([^"]+)', text).group(1))
    return np.asarray(Image.open(io.BytesIO(data)).convert("RGB")).astype(np.int16)


def seam_mask(comp: np.ndarray, torso: np.ndarray) -> np.ndarray:
    """Pixels on the upper edge of the pasted chest, inside the neck box."""
    changed = np.abs(comp.astype(np.int16) - torso).sum(axis=2) > 36
    changed = ndimage.binary_closing(changed, iterations=2)
    edge = changed & ~ndimage.binary_erosion(changed, iterations=1)
    box = np.zeros(changed.shape, bool)
    x0, y0, x1, y1 = NECK
    box[y0:y1, x0:x1] = True
    # keep only the upper boundary: an edge pixel with unchanged pixels just above it
    above = np.zeros_like(changed)
    above[1:] = ~changed[:-1]
    return edge & box & ndimage.binary_dilation(above, iterations=1)


def hair_mask(rgb: np.ndarray) -> np.ndarray:
    """Dark regions big enough to be hair (the join line itself has only tiny dark specks)."""
    dark = rgb.astype(int).mean(axis=2) < 70
    lab, n = ndimage.label(dark)
    sizes = ndimage.sum(dark, lab, range(1, n + 1))
    return np.isin(lab, 1 + np.flatnonzero(sizes >= 200))


def smooth(comp: np.ndarray, seam: np.ndarray) -> np.ndarray:
    line = cv2.dilate(seam.astype(np.uint8) * 255, np.ones((3, 3), np.uint8), iterations=1)
    hair = hair_mask(comp)
    line[hair] = 0  # hair outline pixels are not part of the join
    painted = cv2.inpaint(comp, line, 3, cv2.INPAINT_TELEA)
    blurred = cv2.GaussianBlur(painted, (0, 0), sigmaX=1.2, sigmaY=3.0)
    dist = ndimage.distance_transform_edt(~seam)
    # never soften the hair beside the neck: skip dark pixels and fade out near them
    near_hair = ndimage.distance_transform_edt(~hair)
    weight = (np.clip(1 - dist / 7.0, 0, 1) * np.clip((near_hair - 2) / 4.0, 0, 1))[..., None]
    out = painted * (1 - weight) + blurred * weight
    return np.clip(out, 0, 255).astype(np.uint8)


def build() -> Image.Image:
    comp = np.asarray(Image.open(SRC).convert("RGB"))
    torso = _embedded(RIG / "torso.svg")
    return Image.fromarray(smooth(comp, seam_mask(comp, torso)))


if __name__ == "__main__":
    image = build()
    image.save(OUT, format="JPEG", quality=95, subsampling=0, optimize=True)
    print(f"{OUT.name} written ({image.size[0]}x{image.size[1]}, {OUT.stat().st_size // 1024} KB)")
