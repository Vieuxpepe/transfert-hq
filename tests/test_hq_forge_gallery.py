"""Gallery confinement, validation, quota, and admin delete."""

from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_gallery as G  # noqa: E402


def _png(width: int = 256, height: int = 256) -> bytes:
    image = Image.new("RGB", (width, height), (12, 24, 36))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _settings() -> dict:
    return {
        "prompt": "a red circle",
        "negative_prompt": "",
        "checkpoint": "example.safetensors [abcd]",
        "sampler_name": "Euler",
        "scheduler": "automatic",
        "width": 512,
        "height": 512,
        "steps": 8,
        "cfg_scale": 5.5,
        "seed": 7,
        "n_iter": 1,
        "batch_size": 1,
    }


class Gallery(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(self.id().replace(".", "_"))
        # Unique temp under the system temp via TemporaryDirectory would be cleaner.
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        G.reset_for_tests()

    def tearDown(self) -> None:
        G.reset_for_tests()
        self.tmp.cleanup()

    def test_store_rewrites_pixels_and_hides_paths(self):
        saved = G.store(self.root, _png(), _settings())
        folder = G.gallery_dir(self.root) / saved["id"]
        self.assertTrue((folder / "original.png").is_file())
        self.assertTrue((folder / "thumb.jpg").is_file())
        blob = (folder / "meta.json").read_text(encoding="utf-8")
        self.assertNotIn("filename", blob)
        self.assertNotIn("\\", blob)
        detail = G.get(self.root, saved["id"])
        self.assertEqual(detail["settings"]["prompt"], "a red circle")
        self.assertTrue(detail["original"].endswith("/original"))

    def test_rejects_non_images_and_paths_in_settings(self):
        with self.assertRaises(G.GalleryError) as raised:
            G.store(self.root, b"not-an-image", _settings())
        self.assertEqual(raised.exception.code, "bad_image")
        bad = _settings()
        bad["checkpoint"] = r"C:\secret\model.safetensors"
        with self.assertRaises(G.GalleryError):
            G.store(self.root, _png(), bad)
        self.assertEqual(list(G.gallery_dir(self.root).glob("img-*")), [])

    def test_quota_does_not_delete_the_existing_image(self):
        G.set_quota_for_tests(image_cap=1)
        first = G.store(self.root, _png(), _settings())
        with self.assertRaises(G.GalleryError) as raised:
            G.store(self.root, _png(), _settings())
        self.assertEqual(raised.exception.code, "quota")
        self.assertTrue((G.gallery_dir(self.root) / first["id"] / "original.png").is_file())

    def test_delete_and_escape_refuse_to_leave_the_gallery(self):
        saved = G.store(self.root, _png(), _settings())
        outside = self.root / "keep.txt"
        outside.write_text("keep", encoding="utf-8")
        self.assertEqual(G.delete(self.root, saved["id"])["deleted"], saved["id"])
        self.assertFalse((G.gallery_dir(self.root) / saved["id"]).exists())
        self.assertTrue(outside.is_file())
        with self.assertRaises(G.GalleryError):
            G.delete(self.root, "../keep.txt")
        with self.assertRaises(G.GalleryError):
            G.file_bytes(self.root, "img-" + "ab" * 12, "original")

    def test_disk_full_leaves_no_image(self):
        original = G._atomic_bytes

        def boom(path, payload):
            raise G.GalleryError("disk")

        G._atomic_bytes = boom
        try:
            with self.assertRaises(G.GalleryError) as raised:
                G.store(self.root, _png(), _settings())
            self.assertEqual(raised.exception.code, "disk")
        finally:
            G._atomic_bytes = original
        self.assertEqual(list(G.gallery_dir(self.root).glob("img-*")), [])
        ids = [G.store(self.root, _png(64, 64), _settings())["id"] for _ in range(3)]
        first = G.page(self.root, limit=2)
        self.assertEqual(len(first["images"]), 2)
        self.assertIsNotNone(first["next_cursor"])
        second = G.page(self.root, limit=2, cursor=first["next_cursor"])
        self.assertEqual(len(second["images"]), 1)
        self.assertEqual({item["id"] for item in first["images"] + second["images"]}, set(ids))
        payload, ctype, disposition = G.file_bytes(self.root, ids[0], "original")
        self.assertEqual(ctype, "image/png")
        self.assertIn(f'filename="forge-{ids[0]}.png"', disposition)
        self.assertNotIn("secret", disposition)
        self.assertTrue(payload.startswith(b"\x89PNG"))
        text = json.dumps(G.page(self.root, limit=10))
        self.assertNotIn("prompt", text)


if __name__ == "__main__":
    unittest.main()
