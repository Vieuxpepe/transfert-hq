"""The companion face the page loads (face.webp) must match its source artwork (face.svg / face.png)."""
from __future__ import annotations

import base64
import re
import sys
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import companion_face_assets as face  # noqa: E402

CSS = ROOT / "assets" / "hq-companion.css"


class CompanionFaceAssets(unittest.TestCase):
    def test_face_svg_embeds_face_png(self) -> None:
        text = face.FACE_SVG.read_text(encoding="utf-8")
        embedded = base64.b64decode(re.search(r'base64,([^"]+)', text).group(1))
        self.assertEqual(embedded, face.FACE_PNG.read_bytes(), "face.svg is stale: re-encode it from face.png")

    def test_face_svg_keeps_the_rig_placement(self) -> None:
        _, at, box = face.read_face_svg()
        self.assertEqual(box, (512.0, 512.0))
        self.assertEqual(at, {k: float(v) for k, v in face.FACE_PLACEMENT.items()})

    def test_face_webp_is_the_laid_out_face_svg(self) -> None:
        # A raw copy of the PNG is not enough: the page stretches the image to the whole rig box,
        # so the WebP must carry the SVG wrapper's placement or the nose lands under the mouth.
        want = face.layout_face()
        with Image.open(face.FACE_WEBP) as have:
            self.assertEqual(have.size, want.size)
            self.assertEqual(have.convert("RGBA").tobytes(), want.tobytes(),
                             "face.webp is stale: run python scripts/companion_face_assets.py")
        self.assertTrue(face.face_webp_is_current())

    def test_laid_out_face_matches_the_wrapper_geometry(self) -> None:
        image, at, (box_w, box_h) = face.read_face_svg()
        canvas = face.layout_face()
        # Same aspect as the SVG box once the image's own scale is applied (rounded to whole pixels).
        self.assertAlmostEqual(canvas.width / (box_w * image.width / at["width"]), 1, places=3)
        self.assertAlmostEqual(canvas.height / (box_h * image.height / at["height"]), 1, places=3)
        left, top = round(at["x"] * image.width / at["width"]), round(at["y"] * image.height / at["height"])
        probe = (image.width // 2, image.height // 3)
        self.assertEqual(canvas.getpixel((probe[0] + left, probe[1] + top)), image.getpixel(probe))

    def test_both_scripts_share_one_cache_tag(self) -> None:
        tag = face.current_tag()  # raises when the two files disagree
        for path in face.TAGGED_JS:
            self.assertIn(f"face.webp?v=px{tag}" if "mouth" in path.name else f'".webp?v=px{tag}"',
                          path.read_text(encoding="utf-8"), path.name)

    def test_brow_layers_stop_above_the_eyelids(self) -> None:
        # The brow layers are moving copies of the face: their clip must end under the brow,
        # before the eyelid (left lid starts near 20.4% of the rig box, right near 17.6%).
        css = CSS.read_text(encoding="utf-8")
        for side, limit in (("left", 20.4), ("right", 17.6)):
            rule = re.search(r"\.hq-companion-rig-face-brow-%s\{([^}]*)\}" % side, css).group(1)
            top, _right, bottom, _left = (float(v) for v in re.search(
                r"clip-path:inset\(([\d.]+)% ([\d.]+)% ([\d.]+)% ([\d.]+)%\)", rule).groups())
            self.assertLessEqual(100 - bottom, limit, side)
            self.assertLess(top, 100 - bottom, side)
            fade = re.search(r"mask-image:linear-gradient\(to bottom,#000 0 ([\d.]+)%,transparent ([\d.]+)%\)", rule)
            self.assertIsNotNone(fade, side)
            self.assertLessEqual(float(fade.group(2)), 100 - bottom + 0.01, side)
            self.assertGreater(float(fade.group(1)), top, side)

    def test_base_body_is_the_composite_torso(self) -> None:
        # The body under the animated breast layers is torso-composite.jpg (natural chest, jacket);
        # hair-variant looks use its hair-free twin built by scripts/build_torso_composite_clean.py.
        js = (ROOT / "assets" / "hq-companion.js").read_text(encoding="utf-8")
        for name in ("torso-composite.jpg", "torso-composite-clean.webp"):
            self.assertTrue((face.RIG / name).is_file(), name)
            self.assertIn(name + "?v=", js)
        self.assertNotIn("torso-clean.svg", js)
        with Image.open(face.RIG / "torso-composite.jpg") as base, Image.open(face.RIG / "torso-composite-clean.webp") as clean:
            self.assertEqual(base.size, clean.size)
            # Same chest (centre, below the collarbone), different head (hair removed).
            chest = (236, 330, 276, 370)
            diff = sum(abs(a - b) for a, b in zip(base.convert("RGB").crop(chest).tobytes(), clean.convert("RGB").crop(chest).tobytes()))
            self.assertLess(diff / (40 * 40 * 3), 6)
            crown = (230, 20, 290, 60)
            self.assertNotEqual(base.convert("RGB").crop(crown).tobytes(), clean.convert("RGB").crop(crown).tobytes())


if __name__ == "__main__":
    unittest.main()
