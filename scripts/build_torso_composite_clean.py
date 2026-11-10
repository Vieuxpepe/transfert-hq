"""Build torso-composite-clean.webp: the composite torso (torso-composite.jpg) without baked hair.

torso-composite.jpg is the base body under the animated breast layers. It equals the original torso
above the shoulders and only repaints the chest (natural chest, jacket off the shoulders), but it
still carries the default hair and earrings. Hair-variant looks need a base without them, so this
script starts from torso-clean.svg (bald, no earrings) and copies in the composite's chest wherever
the composite differs from the original torso, below the hair curls that rest on the shoulders.

    python scripts/build_torso_composite_clean.py
"""
from __future__ import annotations

import base64
import io
import re
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

RIG = Path(__file__).resolve().parents[1] / "assets" / "companion" / "rig-neutral-v1"
OUT = RIG / "torso-composite-clean.webp"


def embedded(svg: Path) -> Image.Image:
    text = svg.read_text(encoding="utf-8")
    return Image.open(io.BytesIO(base64.b64decode(re.search(r'base64,([^"]+)', text).group(1)))).convert("RGB")


def build() -> Image.Image:
    torso = np.asarray(embedded(RIG / "torso.svg")).astype(np.int16)
    clean_img = embedded(RIG / "torso-clean.svg")
    comp_img = Image.open(RIG / "torso-composite.jpg").convert("RGB")
    comp = np.asarray(comp_img).astype(np.int16)
    # Where the composite repaints the original torso (JPEG noise stays under the threshold).
    changed = np.abs(comp - torso).sum(axis=2) > 36
    changed_img = Image.fromarray((changed * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.MinFilter(9))
    # The composite still shows the default hair curls lying on both shoulders (down to y~290) and the
    # baked necklace line. Keep the clean torso there: take the composite only below the curls, and
    # from the collarbone down in the gap between them.
    ys, xs = np.mgrid[0:512, 0:512]
    below_hair = ys > np.where((xs >= 226) & (xs <= 300), 248, 296)
    mask = (np.asarray(changed_img) > 127) & below_hair
    mask_img = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))
    return Image.composite(comp_img, clean_img, mask_img)


if __name__ == "__main__":
    image = build()
    image.save(OUT, format="WEBP", lossless=True, method=6)
    print(f"{OUT.name} written ({image.size[0]}x{image.size[1]})")
