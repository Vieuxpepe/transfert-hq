"""Rebuild dangling-member.png with SDF edge feather (no Gaussian mush)."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
SRC = (
    Path.home()
    / ".cursor/projects/c-Transfert/assets/Dangling_cock-f260bb55-7ef3-4893-9a49-cac7be456f76.png"
)
OUT = ROOT / "assets" / "dangling-member.png"
CROP = (226, 0, 379, 486)
FEATHER_PX = 7.0
ALPHA_CUTOFF = 20


def smootherstep(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return x * x * x * (x * (x * 6.0 - 15.0) + 10.0)


def sdf_alpha(mask: np.ndarray, feather: float) -> np.ndarray:
    inside = distance_transform_edt(mask)
    outside = distance_transform_edt(~mask)
    sdf = inside - outside
    # Wider transition band; smootherstep eases the outer halo.
    t = (sdf + feather * 0.55) / (feather * 1.1)
    return (smootherstep(t) * 255.0).astype(np.uint8)


def main() -> None:
    src = SRC if SRC.is_file() else ROOT / "assets" / "dangling-member.png"
    im = Image.open(src).convert("RGBA")
    if src == SRC:
        im = im.crop(CROP)

    arr = np.array(im, dtype=np.float32)
    rgb = arr[:, :, :3]
    old_a = arr[:, :, 3]

    mask = old_a > ALPHA_CUTOFF
    new_a = sdf_alpha(mask, FEATHER_PX)

    core = new_a >= 248
    if np.any(core):
        skin = rgb[core].mean(axis=0)
    else:
        skin = np.array([148.0, 112.0, 100.0], dtype=np.float32)

    rim = (new_a > 0) & (new_a < 255)
    w = np.power(1.0 - (new_a.astype(np.float32) / 255.0), 0.85)
    blend = np.where(rim, w * np.where(rgb.max(axis=2) < 36, 1.0, 0.62), 0.0)[:, :, np.newaxis]
    rgb = rgb * (1.0 - blend) + skin * blend

    out = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), new_a])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out).save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({im.size[0]}x{im.size[1]}) feather={FEATHER_PX}px sdf")


if __name__ == "__main__":
    main()
