"""Every face image the mouth rig can request must be in the tree and aligned with face.webp."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RIG = ROOT / "assets" / "companion" / "rig-neutral-v1"
NEUTRAL = RIG / "face.webp"


def _runtime_map() -> dict[str, str]:
    raw = subprocess.check_output(
        ["node", "-e", "process.stdout.write(JSON.stringify(require('./assets/hq-companion-mouth.js').EXPRESSION_FACE_BY_PRIMARY))"],
        cwd=ROOT,
        text=True,
    )
    mapping = json.loads(raw)
    if not isinstance(mapping, dict) or not mapping:
        raise AssertionError("expression map is empty")
    return mapping


def _scaled_alpha_box(path: Path) -> tuple[float, float, float, float]:
    image = Image.open(path)
    image.load()
    if image.format != "WEBP":
        raise AssertionError(f"{path.name} decoded as {image.format}")
    pixels = np.asarray(image.convert("RGBA"))
    height, width = pixels.shape[:2]
    ys, xs = np.where(pixels[:, :, 3] > 16)
    if len(xs) == 0:
        raise AssertionError(f"{path.name} has no visible pixels")
    return (
        xs.min() * 512 / width,
        ys.min() * 512 / height,
        xs.max() * 512 / width,
        ys.max() * 512 / height,
    )


class CompanionExpressionFaces(unittest.TestCase):
    def test_every_mapped_expression_image_is_committed_and_aligned(self) -> None:
        mapping = _runtime_map()
        neutral = _scaled_alpha_box(NEUTRAL)
        slugs = set(mapping.values())
        self.assertNotIn("delighted-mid", slugs)
        self.assertNotIn("pleased", mapping)
        for primary, slug in mapping.items():
            path = RIG / f"face-{slug}-v1.webp"
            self.assertTrue(path.is_file(), f"{primary} requests missing {path.name}")
            box = _scaled_alpha_box(path)
            delta = max(abs(a - b) for a, b in zip(neutral, box))
            self.assertLessEqual(delta, 3, f"{path.name} is not aligned with face.webp ({delta:.1f}px)")


if __name__ == "__main__":
    unittest.main()
