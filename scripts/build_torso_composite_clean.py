"""Build torso-composite-clean.webp: the composite torso (torso-composite-smooth.jpg) without baked hair.

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
from scipy import ndimage

RIG = Path(__file__).resolve().parents[1] / "assets" / "companion" / "rig-neutral-v1"
OUT = RIG / "torso-composite-clean.webp"


def embedded(svg: Path) -> Image.Image:
    text = svg.read_text(encoding="utf-8")
    return Image.open(io.BytesIO(base64.b64decode(re.search(r'base64,([^"]+)', text).group(1)))).convert("RGB")


def build() -> Image.Image:
    torso = np.asarray(embedded(RIG / "torso.svg")).astype(np.int16)
    clean_img = embedded(RIG / "torso-clean.svg")
    comp_img = Image.open(RIG / "torso-composite-smooth.jpg").convert("RGB")  # neck join smoothed
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
    merged = Image.composite(comp_img, clean_img, mask_img)
    # Across the middle of the chest the bald torso's own collarbones would double the composite's.
    # There, use the composite everywhere except on its hair pixels (the two images share the same
    # geometry, so hair holes are filled with what lies under the hair in the bald torso).
    middle = Image.composite(comp_img, clean_img, _not_hair_mask(comp))
    xs = np.arange(512)
    x0, x1, feather = MIDDLE
    weight = np.tile(np.clip(np.minimum(xs - x0, x1 - xs) / feather, 0, 1), (512, 1))
    weight[:236] = 0
    weight[236:246] *= np.linspace(0, 1, 10)[:, None]
    merged = Image.composite(middle, merged, Image.fromarray((weight * 255).astype(np.uint8)))
    return remove_strap_stubs(merged)


MIDDLE = (205, 320, 14)  # x range (512 grid) and feather of the centre-chest rule


def _not_hair_mask(comp: np.ndarray) -> Image.Image:
    """White where the composite shows body or background, black on the default hair (y >= 240)."""
    b_minus_g = comp[..., 2].astype(int) - comp[..., 1]
    lum = comp.astype(int).mean(axis=2)
    hair = (b_minus_g > 6) | (lum < 50)  # hair is the only thing here with more blue than green
    hair = ndimage.binary_opening(hair, iterations=1)
    lab, n = ndimage.label(hair)
    sizes = ndimage.sum(hair, lab, range(1, n + 1))
    hair = np.isin(lab, 1 + np.flatnonzero(sizes >= 15))
    hair = ndimage.binary_dilation(ndimage.binary_closing(hair, iterations=3), iterations=3)
    ys = np.arange(512)[:, None]
    use = (ys >= 240) & ~hair
    use[330:] = True
    return Image.fromarray((use * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5))


# The clean torso still shows the top of the old bra straps on each shoulder (above the curls line,
# where the composite cannot be used because of its hair). Paint them out with surrounding skin.
STRAP_BOXES = ((138, 272, 178, 302), (362, 272, 389, 308))  # (x0, y0, x1, y1) in the 512 grid


def remove_strap_stubs(image: Image.Image) -> Image.Image:
    import cv2

    rgb = np.asarray(image.convert("RGB")).copy()
    lum = rgb.astype(int).mean(axis=2)
    mask = np.zeros(lum.shape, np.uint8)
    for x0, y0, x1, y1 in STRAP_BOXES:
        box = rgb[y0:y1, x0:x1].astype(int)
        grey = (box.max(axis=2) - box.min(axis=2)) < 28  # strap and its sheen; skin is saturated
        mask[y0:y1, x0:x1] = ((lum[y0:y1, x0:x1] < 120) | grey).astype(np.uint8) * 255
    # small isolated dark specks left from the default hair outline around the base of the neck
    x0, y0, x1, y1 = SPECK_BOX
    dark = lum < 100
    lab, n = ndimage.label(dark[y0:y1, x0:x1])
    sizes = ndimage.sum(dark[y0:y1, x0:x1], lab, range(1, n + 1))
    specks = np.isin(lab, 1 + np.flatnonzero(sizes < 40))
    mask[y0:y1, x0:x1] |= specks.astype(np.uint8) * 255
    # and a faint grey one right of the neck: clearly darker than its surroundings
    x0, y0, x1, y1 = RIGHT_NECK_BOX
    local = ndimage.median_filter(lum, size=9)
    smudge = (lum < local - 22)[y0:y1, x0:x1]
    lab, n = ndimage.label(smudge)
    sizes = ndimage.sum(smudge, lab, range(1, n + 1))
    mask[y0:y1, x0:x1] |= np.isin(lab, 1 + np.flatnonzero(sizes < 40)).astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=1)
    out = cv2.inpaint(rgb, mask, 3, cv2.INPAINT_TELEA)
    return Image.fromarray(out)


SPECK_BOX = (195, 232, 330, 266)  # x0, y0, x1, y1 in the 512 grid
RIGHT_NECK_BOX = (290, 236, 320, 258)


if __name__ == "__main__":
    image = build()
    image.save(OUT, format="WEBP", lossless=True, method=6)
    print(f"{OUT.name} written ({image.size[0]}x{image.size[1]})")
