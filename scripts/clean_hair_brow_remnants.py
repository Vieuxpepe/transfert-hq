"""Remove leftover pieces of the old eyebrows from the hair-variant images.

The variant hairdos (accessories/hair/hair-*-1354.webp) were cut from portraits that still had the
old thick dark eyebrows; short dark dashes of those brows stayed glued to the strands that cross
the forehead. This script clears them, and only them:

- it only looks inside two bands around where the old brows were;
- a pixel is a remnant if it is dark (old brows are near-black or dark purple) and not part of a
  long, roughly vertical run of hair (a strand), probed with 81 px lines up to 25 degrees off vertical.

Hair images are 1254x1354, the face.png grid shifted down by 70 px. Only the alpha plane of each
file is rewritten; the lossy colour data stays byte-identical. Idempotent: a second pass removes nothing.

    python scripts/clean_hair_brow_remnants.py           # rewrite the images
    python scripts/clean_hair_brow_remnants.py --dry-run # only report pixel counts
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HAIR_DIR = Path(__file__).resolve().parents[1] / "assets" / "companion" / "rig-neutral-v1" / "accessories" / "hair"
OFFSET = 70  # hair image row = face.png row + 70
# (y0, y1, x0, x1) in hair-image pixels: left and right old-brow bands.
BANDS = ((OFFSET + 240, OFFSET + 340, 425, 615), (OFFSET + 200, OFFSET + 290, 625, 815))
LINE, MAX_DEG, STEP = 81, 25, 3


def _line(length: int, deg: float) -> np.ndarray:
    k = np.zeros((length, length), bool)
    c, t = (length - 1) / 2, np.radians(deg)
    for s in np.linspace(-c, c, length * 3):
        k[int(round(c + s * np.cos(t))), int(round(c + s * np.sin(t)))] = True
    return k


def remnant_mask(rgba: np.ndarray) -> np.ndarray:
    a = rgba[..., 3]
    rgb = rgba[..., :3].astype(int)
    lum = rgb.mean(axis=2)
    bg = rgb[..., 2] - rgb[..., 1]
    hair = a > 8
    out = np.zeros(a.shape, bool)
    for y0, y1, x0, x1 in BANDS:
        Y0, Y1, X0, X1 = y0 - 100, y1 + 100, x0 - 50, x1 + 50
        win = hair[Y0:Y1, X0:X1]
        strands = np.zeros_like(win)
        for deg in range(-MAX_DEG, MAX_DEG + 1, STEP):
            strands |= ndimage.binary_opening(win, structure=_line(LINE, deg))
        strands = ndimage.binary_dilation(strands, iterations=1)
        dark = win & ((bg[Y0:Y1, X0:X1] < 10) | ((bg[Y0:Y1, X0:X1] < 18) & (lum[Y0:Y1, X0:X1] < 42)))
        band = np.zeros_like(win)
        band[y0 - Y0:y1 - Y0, x0 - X0:x1 - X0] = True
        rem = dark & ~strands & band
        rem = ndimage.binary_dilation(rem, iterations=1) & win & band & dark
        out[Y0:Y1, X0:X1] |= rem
    return out


def _chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    assert data[:4] == b"RIFF" and data[8:12] == b"WEBP", "not a WebP file"
    out, i = [], 12
    while i < len(data):
        tag, size = data[i:i + 4], int.from_bytes(data[i + 4:i + 8], "little")
        out.append((tag, data[i + 8:i + 8 + size]))
        i += 8 + size + (size & 1)
    return out


def _riff(chunks: list[tuple[bytes, bytes]]) -> bytes:
    body = b"WEBP" + b"".join(t + len(c).to_bytes(4, "little") + c + (b"\x00" if len(c) & 1 else b"") for t, c in chunks)
    return b"RIFF" + len(body).to_bytes(4, "little") + body


def with_new_alpha(data: bytes, alpha: np.ndarray) -> bytes:
    """Return the same WebP with only its alpha plane replaced.

    The hair images are lossy colour (VP8) plus a lossless alpha plane (ALPH). The colour chunk is
    kept byte for byte; a fresh lossless ALPH chunk is taken from a throwaway encode of the new alpha.
    """
    chunks = _chunks(data)
    tags = [t for t, _ in chunks]
    if tags != [b"VP8X", b"ALPH", b"VP8 "]:
        raise ValueError(f"unexpected WebP layout {tags}")
    probe = np.zeros(alpha.shape + (4,), np.uint8)
    probe[..., 3] = alpha
    buf = io.BytesIO()
    Image.fromarray(probe).save(buf, format="WEBP", quality=50, alpha_quality=100, method=6)
    new_alph = dict(_chunks(buf.getvalue()))[b"ALPH"]
    return _riff([(t, new_alph if t == b"ALPH" else c) for t, c in chunks])


def clean(path: Path, write: bool) -> int:
    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as im:
        rgba = np.asarray(im.convert("RGBA"))
    mask = remnant_mask(rgba)
    if write and mask.any():
        alpha = rgba[..., 3].copy()
        alpha[mask] = 0
        out = with_new_alpha(data, alpha)
        with Image.open(io.BytesIO(out)) as check:
            got = np.asarray(check.convert("RGBA"))
        if not np.array_equal(got[..., 3], alpha):
            raise RuntimeError(f"{path.name}: alpha did not round-trip")
        path.write_bytes(out)
    return int(mask.sum())


if __name__ == "__main__":
    write = "--dry-run" not in sys.argv[1:]
    for path in sorted(HAIR_DIR.glob("hair-*-1354.webp")):
        print(f"{path.name}: {clean(path, write)} px {'removed' if write else 'would be removed'}")
