"""Restore reference hair from hair.svg, adding only its missing crown.

Run with Python, Pillow and numpy. Option (a): 100px headroom above the
1254px rig canvas; the existing CSS offset keeps registration unchanged.
The old embedded hair has the exact reference shape, colour and alpha.
The completed generated hair supplies only the cap, registered by 18 SIFT
inliers (affine fit); crossfade to original pixels in the top 16/512 of rig.
No face, torso or bust assets are modified.
"""
from pathlib import Path
import argparse
import base64
import io
import re
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
SIZE, HEADROOM = 1254, 100


def build(source, output):
    image = Image.open(source).convert("RGBA")
    if image.size != (SIZE, SIZE):
        raise ValueError("Hair source must be 1254x1254")
    embedded = re.search(r'href="data:image/[^;]+;base64,([^\"]+)',
                         (ROOT / "hair.svg").read_text())[1]
    original = Image.open(io.BytesIO(base64.b64decode(embedded))).convert("RGBA")
    original = original.resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    registered = Image.new("RGBA", (SIZE, SIZE+HEADROOM))
    registered.paste(original, (0, HEADROOM))
    # Generated source -> reference's 512px registration, then -> 1254px.
    forward = np.array([[.333840507, .0105065338, 45.7076148],
                        [-.00947515212, .341642339, -39.5050392],
                        [0, 0, 1]])
    forward[:2] *= SIZE/512
    forward[1, 2] += HEADROOM
    inverse = np.linalg.inv(forward)
    crown = image.transform(registered.size, Image.Transform.AFFINE,
                            tuple(inverse[:2].flat), Image.Resampling.BICUBIC)
    old = np.asarray(registered).astype(float)/255
    new = np.asarray(crown).astype(float)/255
    # Match cap RGB to the original in the overlap, then crossfade in
    # premultiplied alpha so transparent RGB cannot create dark seams.
    band = (old[HEADROOM:HEADROOM+40, :, 3]>.9) & (new[HEADROOM:HEADROOM+40, :, 3]>.9)
    for c in range(3):
        a = old[HEADROOM:HEADROOM+40, :, c][band]
        b = new[HEADROOM:HEADROOM+40, :, c][band]
        gain = np.median(a/np.maximum(b, .02))
        new[:, :, c] = np.clip(new[:, :, c]*gain, 0, 1)
    weight = np.clip((np.arange(SIZE+HEADROOM)-HEADROOM)/(16*SIZE/512), 0, 1)[:, None, None]
    alpha = old[:, :, 3:4]*weight + new[:, :, 3:4]*(1-weight)
    rgb = (old[:, :, :3]*old[:, :, 3:4]*weight + new[:, :, :3]*new[:, :, 3:4]*(1-weight))/np.maximum(alpha, 1e-9)
    result = Image.fromarray(np.rint(np.clip(np.concatenate([rgb, alpha], axis=2),0,1)*255).astype("uint8"))
    result.save(output, optimize=True)
    print(f"{output}: {result.size}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "hair-complete.png")
    parser.add_argument("--output", type=Path, default=ROOT / "hair-new-baked.png")
    args = parser.parse_args()
    build(args.source, args.output)
