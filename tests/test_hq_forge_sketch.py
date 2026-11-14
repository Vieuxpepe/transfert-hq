"""« Forge peint » : unmasked img2img of a Dessiner sketch on this PC's Forge only. Mock Forge, temp root."""

from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image, ImageDraw

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge as F  # noqa: E402
import hq_forge_gallery as G  # noqa: E402
import hq_forge_inpaint as I  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_sketch as K  # noqa: E402
from test_hq_forge_jobs import Transport  # noqa: E402

IDLE = {"progress": 0, "state": {"job": "", "job_count": 0}}
REMOVED = ("override_settings", "override_settings_restore_afterwards", "script_name", "script_args", "alwayson_scripts",
           "mask", "mask_blur", "inpainting_fill", "inpaint_full_res", "enable_hr")


def sketch(size=(768, 576), blank=False) -> str:
    img = Image.new("RGBA", size, (255, 255, 255, 255))
    if not blank:
        ImageDraw.Draw(img).rectangle((120, 100, 500, 400), outline=(0, 0, 0, 255), width=4)
    out = io.BytesIO()
    img.save(out, format="PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")


class Base(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        I.reset_for_tests()
        K.reset_for_tests()
        K.set_poll_interval_for_tests(0.05)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name) / "hq"
        self.root.mkdir()

    def tearDown(self) -> None:
        K.reset_for_tests()
        I.reset_for_tests()
        J.set_external_busy(None)
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def wait(self, entry_id: str) -> dict:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _s, payload = K.get(entry_id)
            if payload["sketch"]["state"] in ("completed", "failed"):
                return payload["sketch"]
            time.sleep(0.05)
        self.fail(K.get(entry_id))

    def data(self, **extra):
        out = {"sketch": sketch(), "prompt": "une cabane dans les bois", "fidelity": 0.6, "seed": 42}
        out.update(extra)
        return out


class Painting(Base):
    def test_posts_only_unmasked_img2img_to_the_local_forge_and_keeps_the_result_in_memory(self):
        transport = Transport(progress=IDLE)
        status, payload = K.create(self.root, self.data(), transport=transport)
        self.assertEqual(status, 202, payload)
        done = self.wait(payload["sketch"]["id"])
        self.assertEqual(done["state"], "completed", done)
        self.assertTrue(done["has_image"])
        self.assertTrue(any(u == "http://127.0.0.1:7860/sdapi/v1/img2img" for u in transport.calls))
        self.assertFalse([u for u in transport.calls if u.endswith("/txt2img") or "interrupt" in u or u.endswith("/skip")])
        self.assertEqual(len(transport.bodies), 1, "one POST: the painting")
        sent = json.loads(transport.bodies[0])
        self.assertEqual(set(sent), set(K.BODY_KEYS), "exactly the whitelist")
        for key in REMOVED:
            self.assertNotIn(key, sent, "no mask, no model switch, no script")
        self.assertEqual((sent["save_images"], sent["do_not_save_samples"], sent["do_not_save_grid"], sent["include_init_images"]), (False, True, True, False))
        self.assertEqual((sent["width"], sent["height"], sent["seed"]), (768, 576, 42))
        self.assertEqual(sent["denoising_strength"], K.denoise_for(0.6))
        init = Image.open(io.BytesIO(base64.b64decode(sent["init_images"][0])))
        self.assertEqual((init.size, init.mode), ((768, 576), "RGB"), "the sketch is flattened on white")
        self.assertEqual(G._usage(self.root)[0], 0, "nothing reaches the gallery without « Garder »")
        code, png = K.image(done["id"])
        self.assertEqual(code, 200)
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_keep_puts_the_painting_in_the_gallery_once(self):
        transport = Transport(progress=IDLE)
        _s, payload = K.create(self.root, self.data(), transport=transport)
        done = self.wait(payload["sketch"]["id"])
        code, kept = K.keep(self.root, done["id"])
        self.assertEqual(code, 200, kept)
        self.assertEqual(G._usage(self.root)[0], 1)
        meta = G.get(self.root, kept["image_id"])
        self.assertEqual(meta["settings"]["prompt"], "une cabane dans les bois")
        self.assertEqual(meta["settings"]["checkpoint"], "example.safetensors [abcd]", "the record names the loaded model")
        again = K.keep(self.root, done["id"])
        self.assertEqual((again[0], again[1]["image_id"]), (200, kept["image_id"]), "keeping twice does not duplicate")
        self.assertEqual(K.keep(self.root, "skt-" + "0" * 24)[0], 404)

    def test_fidelity_maps_to_strength(self):
        self.assertEqual(K.denoise_for(0), 0.95)
        self.assertEqual(K.denoise_for(1), 0.5)
        self.assertEqual(K.denoise_for(5), 0.5)

    def test_client_fields_never_reach_forge(self):
        transport = Transport(progress=IDLE)
        extra = {"override_settings": {"sd_model_checkpoint": "x"}, "script_name": "evil", "alwayson_scripts": {"x": {}},
                 "save_images": True, "do_not_save_samples": False, "mask": "x", "enable_hr": True, "checkpoint": "client [eeee]"}
        status, payload = K.create(self.root, self.data(**extra), transport=transport)
        self.assertEqual(status, 202, payload)
        self.wait(payload["sketch"]["id"])
        sent = json.loads(transport.bodies[0])
        self.assertEqual(set(sent), set(K.BODY_KEYS))
        self.assertEqual((sent["save_images"], sent["do_not_save_samples"]), (False, True))


class Refusals(Base):
    def test_busy_gpu_is_refused_and_nothing_is_sent(self):
        J.set_external_busy(lambda: True)
        transport = Transport(progress=IDLE)
        status, payload = K.create(self.root, self.data(), transport=transport)
        self.assertEqual((status, payload["code"]), (409, "busy"))
        self.assertEqual(transport.bodies, [])

    def test_a_painting_holds_the_gpu_for_jobs_and_retouches(self):
        release = []

        def slow(body):
            while not release:
                time.sleep(0.02)
            return 200, json.dumps({"images": [K.base64.b64encode(_png()).decode()], "parameters": {}, "info": json.dumps({"all_seeds": [1]})}).encode()

        transport = Transport(progress=IDLE, post=slow)
        status, payload = K.create(self.root, self.data(), transport=transport)
        self.assertEqual(status, 202, payload)
        try:
            deadline = time.monotonic() + 3
            while not K.active() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(J.local_active(self.root), "HQ jobs see the GPU as busy")
            self.assertTrue(J._external_active(), "fleet tasks and retouches see it busy too")
            self.assertEqual(K.create(self.root, self.data(), transport=transport)[1]["code"], "active", "one painting at a time")
        finally:
            release.append(1)
        self.wait(payload["sketch"]["id"])
        self.assertFalse(J.local_active(self.root))

    def test_validation(self):
        t = Transport(progress=IDLE)
        self.assertEqual(K.create(self.root, self.data(prompt="  "), transport=t)[1]["code"], "prompt")
        self.assertEqual(K.create(self.root, self.data(sketch=sketch(blank=True)), transport=t)[1]["code"], "empty")
        self.assertEqual(K.create(self.root, self.data(sketch=sketch(size=(700, 576))), transport=t)[1]["code"], "size")
        self.assertEqual(K.create(self.root, self.data(sketch=sketch(size=(1280, 768))), transport=t)[1]["code"], "size")
        self.assertEqual(K.create(self.root, self.data(sketch="data:image/png;base64,AAAA"), transport=t)[1]["code"], "sketch")
        self.assertEqual(K.create(self.root, self.data(fidelity=2), transport=t)[1]["code"], "validation")
        self.assertEqual(K.create(self.root, self.data(steps=99), transport=t)[1]["code"], "validation")
        self.assertEqual(t.bodies, [], "nothing was sent")

    def test_unknown_loaded_model_is_refused(self):
        transport = Transport(progress=IDLE)
        with mock.patch.object(F, "status", return_value={"forge": "ready", "model": "absent.safetensors", "code": "ready"}):
            status, payload = K.create(self.root, self.data(), transport=transport)
        self.assertEqual((status, payload["code"]), (409, "no_model"))
        self.assertEqual(transport.bodies, [])

    def test_routes(self):
        self.assertEqual(K.serve_get("/api/forge/sketch"), (200, {"sketch": None}))
        self.assertEqual(K.serve_get("/api/forge/sketch/nope")[0], 404)
        self.assertEqual(K.serve_get("/api/forge/sketch/skt-" + "0" * 24 + "/image")[0], 404)
        self.assertEqual(K.serve_post(self.root, "/api/forge/sketch/x/keep", {})[0], 404)
        self.assertIsNone(K.serve_get("/api/forge/other"))


def _png() -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (768, 576), (10, 120, 60)).save(out, format="PNG")
    return out.getvalue()


if __name__ == "__main__":
    unittest.main()
