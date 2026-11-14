"""Seed constellation previews: cheap local txt2img, memory only, never a job."""

from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge as F  # noqa: E402
import hq_forge_gallery as G  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_preview as P  # noqa: E402
from test_hq_forge_jobs import Transport  # noqa: E402

IDLE = {"progress": 0, "state": {"job": "", "job_count": 0}}


class Base(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        P.reset_for_tests()
        P.set_poll_interval_for_tests(0.05)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name) / "hq"
        self.root.mkdir()

    def tearDown(self) -> None:
        P.reset_for_tests()
        J.set_external_busy(None)
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def data(self, **extra):
        payload = {
            "prompt": "un phare dans la nuit",
            "negative_prompt": "flou",
            "checkpoint": "example.safetensors [abcd]",
            "sampler_name": "Euler",
            "scheduler": "automatic",
            "width": 768,
            "height": 1152,
            "cfg_scale": 6,
            "seed": 42,
        }
        payload.update(extra)
        return payload

    def wait(self, preview_id: str) -> dict:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _status, payload = P.get(preview_id)
            if payload["preview"]["state"] in ("completed", "failed"):
                return payload["preview"]
            time.sleep(0.05)
        self.fail(P.get(preview_id))


class Previews(Base):
    def batch_post(self, seeds):
        def post(body):
            count = json.loads(body)["batch_size"]
            images = []
            for index in range(count):
                image = Image.new("RGB", (256, 256), ((index * 21) % 255, 80, 50))
                buffer = io.BytesIO()
                image.save(buffer, format="PNG")
                images.append(base64.b64encode(buffer.getvalue()).decode("ascii"))
            info = {"all_seeds": list(seeds), "index_of_first_image": 0}
            return 200, json.dumps({"images": images, "info": json.dumps(info)}).encode("utf-8")
        return post

    def test_one_batch_generates_nine_cheap_local_previews_and_never_stores_them(self):
        seeds = list(range(40, 49))
        transport = Transport(progress=IDLE, post=self.batch_post(seeds))
        status, payload = P.create(self.root, self.data(seed=40, count=9), transport=transport)
        self.assertEqual(status, 202, payload)
        previews = payload["previews"]
        self.assertEqual(len(previews), 9)
        done = [self.wait(preview["id"]) for preview in previews]
        self.assertTrue(all(preview["state"] == "completed" for preview in done))
        self.assertEqual([preview["seed"] for preview in done], seeds)
        self.assertTrue(all(preview["has_image"] for preview in done))
        self.assertEqual(len(transport.bodies), 1, "nine previews use one Forge batch")
        sent = json.loads(transport.bodies[0])
        self.assertEqual(sent["batch_size"], 9)
        self.assertEqual(sent["seed"], 40)
        self.assertEqual(sent["steps"], 6)
        self.assertEqual((sent["width"], sent["height"]), (256, 320))
        self.assertIs(sent["save_images"], False)
        self.assertIs(sent["do_not_save_samples"], True)
        self.assertIs(sent["do_not_save_grid"], True)
        self.assertFalse(any("/interrupt" in call or call.endswith("/skip") for call in transport.calls))
        self.assertEqual(G._usage(self.root)[0], 0, "previews never reach the normal gallery")
        self.assertFalse((self.root / ".hq-forge" / "stats.json").exists(), "previews never skew the lab")
        self.assertFalse((self.root / ".hq-forge" / "jobs.json").exists(), "previews are not jobs")
        status, png = P.image(done[0]["id"])
        self.assertEqual(status, 200)
        self.assertTrue(png.startswith(b"\x89PNG"))

    def test_batch_uses_the_seeds_forge_actually_rendered(self):
        transport = Transport(progress=IDLE, post=self.batch_post([100, 200, 300]))
        status, payload = P.create(self.root, self.data(seed=40, count=3), transport=transport)
        self.assertEqual(status, 202, payload)
        done = [self.wait(preview["id"]) for preview in payload["previews"]]
        self.assertEqual([preview["seed"] for preview in done], [100, 200, 300])

    def test_public_payload_does_not_repeat_the_prompt(self):
        transport = Transport(progress=IDLE)
        status, payload = P.create(self.root, self.data(prompt="secret-preview-prompt"), transport=transport)
        self.assertEqual(status, 202)
        self.assertNotIn("secret-preview-prompt", json.dumps(payload))
        done = self.wait(payload["preview"]["id"])
        self.assertNotIn("prompt", done)
        self.assertNotIn("secret-preview-prompt", json.dumps(P.get(done["id"])[1]))

    def test_preview_size(self):
        self.assertEqual(P.preview_size(768, 1152), (256, 320))
        self.assertEqual(P.preview_size(1152, 768), (320, 256))
        self.assertEqual(P.preview_size(512, 512), (320, 320))
        self.assertIsNone(P.preview_size(100, 512))
        self.assertIsNone(P.preview_size(513, 512))


class Refusals(Base):
    def test_busy_is_refused_without_sending(self):
        J.set_external_busy(lambda: True)
        transport = Transport(progress=IDLE)
        status, payload = P.create(self.root, self.data(), transport=transport)
        self.assertEqual((status, payload["code"]), (409, "busy"))
        self.assertEqual(transport.bodies, [])

    def test_one_preview_at_a_time_and_it_holds_the_gpu(self):
        release = []

        def slow(_body):
            while not release:
                time.sleep(0.02)
            image = Image.new("RGB", (256, 256), (10, 80, 50))
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return 200, json.dumps({
                "images": [base64.b64encode(buffer.getvalue()).decode("ascii")],
                "info": json.dumps({"all_seeds": [42]}),
            }).encode("utf-8")

        transport = Transport(progress=IDLE, post=slow)
        status, payload = P.create(self.root, self.data(), transport=transport)
        self.assertEqual(status, 202, payload)
        try:
            deadline = time.monotonic() + 3
            while not P.active() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(P.active())
            self.assertTrue(J.local_active(self.root), "HQ jobs see the preview GPU hold")
            self.assertTrue(J._external_active(), "retouches and fleet tasks see it")
            self.assertEqual(P.create(self.root, self.data(seed=43), transport=transport)[1]["code"], "active")
        finally:
            release.append(1)
        self.wait(payload["preview"]["id"])
        self.assertFalse(P.active())
        self.assertFalse(J.local_active(self.root))

    def test_validation_refuses_unknown_fields_and_private_destination(self):
        transport = Transport(progress=IDLE)
        cases = [
            self.data(prompt="  "),
            self.data(seed=-1),
            self.data(count=0),
            self.data(count=10),
            self.data(count=True),
            self.data(width=100),
            self.data(destination="private"),
            self.data(script_name="evil"),
            self.data(steps=1),
        ]
        for case in cases:
            status, payload = P.create(self.root, case, transport=transport)
            self.assertEqual(status, 400, (case, payload))
        self.assertEqual(transport.bodies, [])

    def test_routes(self):
        self.assertEqual(P.serve_get("/api/forge/preview")[0], 200)
        self.assertEqual(P.serve_get("/api/forge/preview/nope")[0], 404)
        self.assertEqual(P.serve_get("/api/forge/preview/prv-" + "0" * 24 + "/image")[0], 404)
        self.assertEqual(P.serve_post(self.root, "/api/forge/preview/x", {})[0], 404)
        self.assertIsNone(P.serve_get("/api/forge/other"))


if __name__ == "__main__":
    unittest.main()
