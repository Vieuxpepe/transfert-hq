"""F2: PNG 'parameters' text in normal downloads, never in vault images by default."""

from __future__ import annotations

import io
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge as F  # noqa: E402
import hq_forge_gallery as G  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_vault as V  # noqa: E402

PASS = "correct horse battery"


def _png(meta: str | None = None) -> bytes:
    from PIL.PngImagePlugin import PngInfo
    image = Image.new("RGB", (256, 256), (40, 90, 160))
    buffer = io.BytesIO()
    info = None
    if meta:
        info = PngInfo()
        info.add_text("parameters", meta)
    image.save(buffer, format="PNG", pnginfo=info)
    return buffer.getvalue()


def _settings(**extra) -> dict:
    data = {
        "prompt": "a lighthouse, at dusk", "negative_prompt": "blur",
        "checkpoint": "sub/example.safetensors [abcd1234]", "sampler_name": "Euler a", "scheduler": "automatic",
        "width": 512, "height": 768, "steps": 24, "cfg_scale": 6.5, "seed": 123456, "n_iter": 1, "batch_size": 1,
    }
    data.update(extra)
    return data


def _text(png: bytes) -> dict:
    image = Image.open(io.BytesIO(png))
    image.load()
    return dict(getattr(image, "text", {}) or {})


class Infotext(unittest.TestCase):
    def test_a1111_layout(self):
        lines = G.infotext(_settings()).split("\n")
        self.assertEqual(lines[0], "a lighthouse, at dusk")
        self.assertEqual(lines[1], "Negative prompt: blur")
        self.assertEqual(lines[2], "Steps: 24, Sampler: Euler a, Schedule type: Automatic, CFG scale: 6.5, Seed: 123456, "
                                   "Size: 512x768, Model hash: abcd1234, Model: example")

    def test_hires_fields_and_unknown_seed(self):
        text = G.infotext(_settings(seed=-1, negative_prompt="", enable_hr=True, hr_scale=2.0, hr_upscaler="R-ESRGAN 4x+",
                                    hr_second_pass_steps=10, denoising_strength=0.45))
        self.assertNotIn("Negative prompt", text)
        self.assertNotIn("Seed:", text)
        self.assertIn("Denoising strength: 0.45, Hires upscale: 2, Hires steps: 10, Hires upscaler: R-ESRGAN 4x+", text)

    def test_values_with_commas_are_quoted(self):
        self.assertIn('Sampler: "DPM++ 2M, Karras"', G.infotext(_settings(sampler_name="DPM++ 2M, Karras")))


class GalleryRoundTrip(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_original_download_carries_parameters(self):
        saved = G.store(self.root, _png(), _settings())
        code, payload, ctype, headers = G.serve_file(self.root, f"/api/forge/gallery/{saved['id']}/original")
        self.assertEqual((code, ctype), (200, "image/png"))
        self.assertEqual(_text(payload).get("parameters"), G.infotext(_settings()))
        self.assertIn(("Cache-Control", "private, no-store"), headers)

    def test_incoming_metadata_is_replaced_not_copied(self):
        saved = G.store(self.root, _png("injected upstream text"), _settings())
        payload, _ctype, _disp = G.file_bytes(self.root, saved["id"], "original")
        self.assertNotIn("injected", _text(payload).get("parameters", ""))

    def test_unicode_prompt_survives(self):
        saved = G.store(self.root, _png(), _settings(prompt="phare \u00e0 l'aube \u2014 \u6771\u4eac"))
        payload, _ctype, _disp = G.file_bytes(self.root, saved["id"], "original")
        self.assertTrue(_text(payload)["parameters"].startswith("phare \u00e0 l'aube \u2014 \u6771\u4eac\n"))

    def test_thumb_has_no_parameters(self):
        saved = G.store(self.root, _png(), _settings())
        payload, _ctype, _disp = G.file_bytes(self.root, saved["id"], "thumb")
        self.assertNotIn(b"lighthouse", payload)


class VaultStaysClean(unittest.TestCase):
    def setUp(self) -> None:
        # iphone_bridge (imported by other suites) binds its session checker globally.
        V.bind_session_checker(None)
        F.reset_for_tests()
        J.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.hq = Path(self.tmp.name) / "hq"
        self.store = Path(self.tmp.name) / "vault"
        self.hq.mkdir()
        self.store.mkdir()
        V.set_root_for_tests(self.store)
        V.set_acl_for_tests(False)
        self.admin = "session-admin-0123456789abcdef"
        V.setup(self.hq, PASS, PASS)
        V.unlock(self.hq, self.admin, PASS)

    def tearDown(self) -> None:
        V.bind_session_checker(None)
        V.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def test_private_original_has_no_parameters_by_default(self):
        stored = V.store_image(self.hq, self.admin, _png("leaky upstream text"), _settings(prompt="secret private prompt"))
        payload, _ctype, _disp = V.file_bytes(self.hq, self.admin, stored["id"], "original")
        self.assertEqual(_text(payload), {})
        self.assertNotIn(b"secret private prompt", payload)
        self.assertNotIn(b"leaky", payload)

    def test_explicit_export_flag_includes_parameters(self):
        stored = V.store_image(self.hq, self.admin, _png(), _settings(prompt="secret private prompt"))
        payload, _ctype, _disp = V.file_bytes(self.hq, self.admin, stored["id"], "original", include_parameters=True)
        self.assertTrue(_text(payload)["parameters"].startswith("secret private prompt\n"))
        again, _c, _d = V.file_bytes(self.hq, self.admin, stored["id"], "original")
        self.assertEqual(_text(again), {}, "the stored object stays clean after an export")

    def test_truthy_non_bool_flag_is_ignored(self):
        stored = V.store_image(self.hq, self.admin, _png(), _settings())
        payload, _c, _d = V.file_bytes(self.hq, self.admin, stored["id"], "original", include_parameters="1")
        self.assertEqual(_text(payload), {})


if __name__ == "__main__":
    unittest.main()
