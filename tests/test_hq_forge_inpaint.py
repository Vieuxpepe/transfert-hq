"""Phase I finger inpainting: masked img2img to this PC's Forge only. Mock Forge, temp root and vault."""

from __future__ import annotations

import base64
import io
import json
import os
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
import hq_forge_vault as V  # noqa: E402
import hq_forge_worker as W  # noqa: E402
from test_hq_forge_jobs import Transport, _png_b64  # noqa: E402
from test_hq_forge_vault import PASS, _token  # noqa: E402
import test_hq_forge_fleet as TF  # noqa: E402

IDLE = {"progress": 0, "state": {"job": "", "job_count": 0}}
BUSY = {"progress": 0.5, "state": {"job": "owner", "job_count": 1, "sampling_step": 3, "sampling_steps": 20}}
SECRET = "lanterne rouge du coffre secret"
MODEL = "example.safetensors [abcd]"


def png(size=(512, 512), color=(200, 30, 40)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, color).save(out, format="PNG")
    return out.getvalue()


def mask(size=(512, 512), box=(100, 100, 220, 220), empty=False) -> str:
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    if not empty:
        ImageDraw.Draw(img).ellipse(box, fill=(255, 255, 255, 255))
    out = io.BytesIO()
    img.save(out, format="PNG")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode("ascii")


def settings(prompt="un phare") -> dict:
    return {"prompt": prompt, "negative_prompt": "", "checkpoint": MODEL, "sampler_name": "Euler", "scheduler": "automatic",
            "width": 512, "height": 512, "steps": 8, "n_iter": 1, "batch_size": 1, "seed": 7, "cfg_scale": 6.0}


class Base(unittest.TestCase):
    def setUp(self) -> None:
        V.bind_session_checker(None)
        F.reset_for_tests()
        J.reset_for_tests()
        I.reset_for_tests()
        I.set_poll_interval_for_tests(0.05)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name) / "hq"
        self.store = Path(self.tmp.name) / "vault"
        self.root.mkdir()
        self.store.mkdir()
        V.set_root_for_tests(self.store)
        V.set_acl_for_tests(False)

    def tearDown(self) -> None:
        I.reset_for_tests()
        J.set_external_busy(None)
        J.reset_for_tests()
        F.reset_for_tests()
        V.set_private_generation_for_tests(False)
        V.reset_for_tests()
        self.tmp.cleanup()

    def wait(self, entry_id: str) -> dict:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _s, payload = I.get(entry_id)
            if payload["inpaint"]["state"] in ("completed", "failed"):
                return payload["inpaint"]
            time.sleep(0.05)
        self.fail(I.get(entry_id))

    def body(self, source, **extra):
        data = {"source": source, "mask": mask(), "prompt": "une lanterne", "denoising_strength": 0.7, "mask_blur": 6,
                "inpainting_fill": 1, "inpaint_full_res": True, "inpaint_full_res_padding": 32}
        data.update(extra)
        return data


class Inpaint(Base):
    def normal_source(self) -> str:
        return G.store(self.root, png(), settings())["id"]

    def test_normal_inpaint_posts_only_img2img_to_local_forge_and_saves_to_gallery(self):
        source = self.normal_source()
        transport = Transport(progress=IDLE)
        status, payload = I.create(self.root, self.body({"kind": "normal", "id": source}), None, transport=transport)
        self.assertEqual(status, 202, payload)
        done = self.wait(payload["inpaint"]["id"])
        self.assertEqual(done["state"], "completed", done)
        posts = [u for u, b in zip(transport.calls, [None] * len(transport.calls))]
        self.assertTrue(any(u == "http://127.0.0.1:7860/sdapi/v1/img2img" for u in transport.calls))
        self.assertFalse(any(u.endswith("/txt2img") or "interrupt" in u or "/sdapi/v1/skip" in u or u.endswith("/options") and False for u in transport.calls))
        self.assertEqual(len(transport.bodies), 1)
        sent = json.loads(transport.bodies[0])
        for key in ("init_images", "mask", "mask_blur", "inpainting_fill", "inpaint_full_res", "denoising_strength"):
            self.assertIn(key, sent)
        self.assertEqual((sent["mask_blur"], sent["inpainting_fill"], sent["inpaint_full_res"], sent["inpaint_full_res_padding"]), (6, 1, True, 32))
        self.assertEqual((sent["save_images"], sent["include_init_images"], sent["width"], sent["height"]), (False, False, 512, 512))
        self.assertEqual(sent["override_settings"], {"sd_model_checkpoint": MODEL}, "model handling is submission_body's")
        self.assertTrue(sent["override_settings_restore_afterwards"])
        self.assertNotIn("enable_hr", sent)
        mask_img = Image.open(io.BytesIO(base64.b64decode(sent["mask"])))
        self.assertEqual((mask_img.size, mask_img.mode, sorted(set(mask_img.tobytes()))), ((512, 512), "L", [0, 255]))
        result = G.get(self.root, done["image_id"])
        self.assertEqual(result["origin"]["inpaint_of"], source)
        self.assertEqual(result["settings"]["prompt"], "une lanterne")

    def test_img2img_body_is_exactly_the_whitelist(self):
        source = self.normal_source()
        transport = Transport(progress=IDLE)
        status, payload = I.create(self.root, self.body({"kind": "normal", "id": source}), None, transport=transport)
        self.assertEqual(status, 202, payload)
        self.wait(payload["inpaint"]["id"])
        sent = json.loads(transport.bodies[0])
        self.assertEqual(set(sent), set(I.BODY_KEYS))
        self.assertEqual((sent["do_not_save_samples"], sent["do_not_save_grid"], sent["save_images"]), (True, True, False))

    def test_unknown_client_fields_are_dropped(self):
        source = self.normal_source()
        transport = Transport(progress=IDLE)
        extra = {"script_name": "evil", "alwayson_scripts": {"x": {}}, "enable_hr": True, "hr_scale": 2,
                 "do_not_save_samples": False, "save_images": True, "outpath_samples": "C:/x", "sampler_index": "x",
                 "override_settings": {"samples_save": True}, "subseed": 3, "subseed_strength": 0.5,
                 "interrupt": True, "skip": True, "options": {"a": 1}, "styles": ["s"], "unknown_field": 1}
        status, payload = I.create(self.root, self.body({"kind": "normal", "id": source}, **extra), None, transport=transport)
        self.assertEqual(status, 202, payload)
        self.wait(payload["inpaint"]["id"])
        sent = json.loads(transport.bodies[0])
        self.assertLessEqual(set(sent), set(I.BODY_KEYS))
        for key in ("enable_hr", "hr_scale", "outpath_samples", "sampler_index", "subseed", "subseed_strength",
                    "interrupt", "skip", "options", "styles", "unknown_field"):
            self.assertNotIn(key, sent)
        self.assertEqual((sent["script_name"], sent["alwayson_scripts"], sent["script_args"]), ("", {}, []))
        self.assertEqual((sent["save_images"], sent["do_not_save_samples"], sent["do_not_save_grid"]), (False, True, True))
        self.assertEqual(sent["override_settings"], {"sd_model_checkpoint": MODEL})

    def test_private_inpaint_body_never_saves_and_never_interrupts(self):
        V.set_private_generation_for_tests(True)
        token = _token("admin")
        V.setup(self.root, PASS, PASS)
        V.unlock(self.root, token, PASS)
        source = V.store_image(self.root, token, png(), settings(SECRET))["id"]
        transport = Transport(progress=IDLE)
        status, payload = I.create(self.root, self.body({"kind": "private", "id": source}, do_not_save_grid=False), token, transport=transport)
        self.assertEqual(status, 202, payload)
        self.assertEqual(self.wait(payload["inpaint"]["id"])["state"], "completed")
        sent = json.loads(transport.bodies[0])
        self.assertEqual(set(sent), set(I.BODY_KEYS))
        self.assertIs(sent["do_not_save_samples"], True)
        self.assertIs(sent["do_not_save_grid"], True)
        self.assertIs(sent["save_images"], False)
        self.assertEqual(len(transport.bodies), 1, "the only POST is img2img (options is only ever read)")
        self.assertFalse([u for u in transport.calls if u.endswith("/interrupt") or u.endswith("/skip")], transport.calls)
        for key in ("interrupt", "skip", "options"):
            self.assertNotIn(key, sent)
        self.assertNotIn(SECRET, json.dumps(payload))

    def test_validation_and_404(self):
        source = self.normal_source()
        cases = [
            (self.body({"kind": "normal", "id": source}, mask=mask(empty=True)), 400, "mask"),
            (self.body({"kind": "normal", "id": source}, mask=mask(size=(256, 256))), 400, "mask_size"),
            (self.body({"kind": "normal", "id": source}, mask="data:image/png;base64,!!!"), 400, "mask"),
            (self.body({"kind": "normal", "id": source}, mask="A" * (I.MASK_MAX_BYTES * 2)), 400, "mask"),
            (self.body({"kind": "normal", "id": source}, inpainting_fill=7), 400, "validation"),
            (self.body({"kind": "normal", "id": source}, mask_blur=-1), 400, "validation"),
            (self.body({"kind": "normal", "id": source}, denoising_strength=1.5), 400, "validation"),
            (self.body({"kind": "elsewhere", "id": source}), 400, "validation"),
            (self.body({"kind": "normal", "id": "img-" + "0" * 24}), 404, "not_found"),
            (self.body({"kind": "normal", "id": "../x"}), 404, "not_found"),
        ]
        odd = G.store(self.root, png(size=(500, 512)), dict(settings(), width=512))["id"] if False else None
        transport = Transport(progress=IDLE)
        for data, code, name in cases:
            with self.subTest(name=name, code=code):
                status, payload = I.create(self.root, data, None, transport=transport)
                self.assertEqual((status, payload["code"]), (code, name))
        self.assertEqual(transport.bodies, [], "nothing was sent")

    def test_busy_gpu_is_refused_never_interrupted_and_inpaint_holds_the_gpu(self):
        source = self.normal_source()
        busy = Transport(progress=BUSY)
        status, payload = I.create(self.root, self.body({"kind": "normal", "id": source}), None, transport=busy)
        self.assertEqual((status, payload["code"]), (409, "busy"))
        J.set_external_busy(lambda: True)
        status, payload = I.create(self.root, self.body({"kind": "normal", "id": source}), None, transport=Transport(progress=IDLE))
        self.assertEqual((status, payload["code"]), (409, "busy"))
        J.set_external_busy(None)
        self.assertEqual(busy.bodies, [])
        self.assertFalse(any("interrupt" in u or "/sdapi/v1/skip" in u for u in busy.calls))
        slow = Transport(progress=IDLE, post=lambda body: (time.sleep(0.8), (200, json.dumps({"images": [_png_b64()], "info": "{}"}).encode()))[1])
        status, payload = I.create(self.root, self.body({"kind": "normal", "id": source}), None, transport=slow)
        self.assertEqual(status, 202)
        self.assertTrue(J.local_active(self.root), "fleet local tasks see this GPU busy")
        status, job = J.create_job(self.root, {**settings(), "seed": -1}, "idem-inpaint-busy", transport=Transport(progress=IDLE))
        self.assertEqual((status, job["code"]), (409, "active"), "an HQ job is refused while the retouch runs")
        status, again = I.create(self.root, self.body({"kind": "normal", "id": source}), None, transport=slow)
        self.assertEqual((status, again["code"]), (409, "active"))
        self.wait(payload["inpaint"]["id"])
        self.assertFalse(J.local_active(self.root))

    def test_private_inpaint_stays_in_memory_and_in_the_vault(self):
        V.set_private_generation_for_tests(True)
        token = _token("admin")
        V.setup(self.root, PASS, PASS)
        V.unlock(self.root, token, PASS)
        plain = png(color=(11, 222, 33))
        source = V.store_image(self.root, token, plain, settings(SECRET))["id"]
        before = {p for p in Path(self.tmp.name).rglob("*")}
        opened = []
        real_open = open

        def spy(file, mode="r", *args, **kwargs):
            if any(flag in mode for flag in "wax+"):
                opened.append(str(file))
            return real_open(file, mode, *args, **kwargs)

        transport = Transport(progress=IDLE)
        with mock.patch("tempfile.NamedTemporaryFile", side_effect=AssertionError("temp file")), \
                mock.patch("tempfile.mkstemp", side_effect=AssertionError("temp file")), \
                mock.patch("builtins.open", side_effect=spy):
            status, payload = I.create(self.root, self.body({"kind": "private", "id": source}, prompt=SECRET + " retouch\u00e9e"), token, transport=transport)
            self.assertEqual(status, 202, payload)
            done = self.wait(payload["inpaint"]["id"])
        self.assertEqual(done["state"], "completed", done)
        self.assertEqual(done["destination"], "private")
        self.assertTrue(V.ID_RE.fullmatch(done["image_id"]))
        self.assertEqual(V.detail(self.root, token, done["image_id"])["settings"]["prompt"], SECRET + " retouch\u00e9e")
        self.assertTrue(all(str(self.store) in path for path in opened), opened)
        sent = json.loads(transport.bodies[0])
        self.assertEqual(base64.b64decode(sent["init_images"][0]), plain, "source decrypted in memory for the request only")
        self.assertEqual(transport.calls.count("http://127.0.0.1:7860/sdapi/v1/img2img"), 1)
        # Nothing outside the vault: no gallery image, no job, no stats, no history; no plaintext anywhere on disk.
        after = {p for p in Path(self.tmp.name).rglob("*")} - before
        new_files = [p for p in after if p.is_file()]
        self.assertTrue(new_files and all(str(p).startswith(str(self.store)) for p in new_files), sorted(map(str, after)))
        self.assertTrue(all(not any(p.iterdir()) for p in after if p.is_dir() and not str(p).startswith(str(self.store))))
        self.assertFalse(G.gallery_dir(self.root).exists() and any(G.gallery_dir(self.root).iterdir()))
        self.assertFalse((self.root / ".hq-forge" / "jobs.json").exists())
        blob = b"".join(p.read_bytes() for p in Path(self.tmp.name).rglob("*") if p.is_file())
        for needle in (SECRET.encode("utf-8"), b"lanterne", plain[:64], b"\x89PNG", b"IHDR"):
            self.assertNotIn(needle, blob, needle[:20])
        self.assertNotIn(SECRET, json.dumps(I.get(done["id"])[1]))

    def test_private_needs_an_unlocked_vault_and_the_private_gate(self):
        token = _token("admin")
        V.setup(self.root, PASS, PASS)
        V.unlock(self.root, token, PASS)
        source = V.store_image(self.root, token, png(), settings(SECRET))["id"]
        V.set_private_generation_for_tests(False)
        status, payload = I.create(self.root, self.body({"kind": "private", "id": source}), token, transport=Transport(progress=IDLE))
        self.assertEqual((status, payload["code"]), (403, "disabled"))
        V.set_private_generation_for_tests(True)
        V.lock(token)
        status, payload = I.create(self.root, self.body({"kind": "private", "id": source}), token, transport=Transport(progress=IDLE))
        self.assertEqual((status, payload["code"]), (401, "locked"))
        V.unlock(self.root, token, PASS)
        status, payload = I.create(self.root, self.body({"kind": "private", "id": "pvt-" + "0" * 24}), token, transport=Transport(progress=IDLE))
        self.assertEqual(status, 404)
        status, payload = I.create(self.root, self.body({"kind": "private", "id": source}), _token("other"), transport=Transport(progress=IDLE))
        self.assertEqual(status, 401, "another session cannot use this unlock")

    def test_payload_caps_and_worker_never_inpaints(self):
        with self.assertRaises(F._Probe):
            F.post_json(F.INPAINT_PATH, {"init_images": ["A" * (F.MAX_INPAINT_BODY + 10)]}, timeout=1, transport=Transport(progress=IDLE))
        with self.assertRaises(F._Probe):
            F.post_json("/sdapi/v1/interrupt", {}, timeout=1, transport=Transport(progress=IDLE))
        self.assertNotIn("/sdapi/v1/img2img", W.FORGE_ROUTES)
        with self.assertRaises(ValueError):
            W.ForgeLocal(7999, transport=lambda *a: (200, b"{}"))._get("/sdapi/v1/img2img")


class InpaintHttp(TF.FleetHttp):
    def test_inpaint_routes_are_admin_csrf_with_404_and_413(self):
        body = {"source": {"kind": "normal", "id": "img-" + "0" * 24}, "mask": mask()}
        self.assertEqual(self.post("/api/forge/inpaint", body, client=self.anon)[0], 401)
        self.assertEqual(self.post("/api/forge/inpaint", body, client=self.upload)[0], 403)
        status, _h, _b = self.admin.req("/api/forge/inpaint", "POST", json.dumps(body).encode(), {"Origin": "http://evil.example", "Content-Type": "application/json"}, origin=False)
        self.assertEqual(status, 403)
        self.assertEqual(self.anon.json("/api/forge/inpaint")[0], 401)
        self.assertEqual(self.upload.json("/api/forge/inpaint")[0], 403)
        self.assertEqual(self.post("/api/forge/inpaint", body)[0], 404, "unknown source image")
        self.assertEqual(self.admin.json("/api/forge/inpaint/inp-" + "0" * 24)[0], 404)
        self.assertEqual(self.admin.json("/api/forge/inpaint/whatever")[0], 404)
        self.assertEqual(self.post("/api/forge/inpaint/cancel", {})[0], 404, "no cancel: Forge is never interrupted")
        big = {"source": body["source"], "mask": "A" * (3 * 1024 * 1024 + 10)}
        self.assertEqual(self.post("/api/forge/inpaint", big)[0], 413)
        self.assertEqual(self.admin.json("/api/forge/inpaint"), (200, {"inpaint": None}))


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(Inpaint))
    suite.addTest(InpaintHttp("test_inpaint_routes_are_admin_csrf_with_404_and_413"))
    return suite


if __name__ == "__main__":
    unittest.main()