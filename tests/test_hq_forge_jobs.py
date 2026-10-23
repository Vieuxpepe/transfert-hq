"""Generation jobs: validation, single flight, progress, and no global interrupt."""

from __future__ import annotations

import base64
import io
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402


def _png_b64() -> str:
    image = Image.new("RGB", (256, 256), (30, 40, 50))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def _catalog() -> dict:
    return {
        ("GET", "/sdapi/v1/sd-models"): [{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd", "sha256": None}],
        ("GET", "/sdapi/v1/samplers"): [{"name": "Euler"}],
        ("GET", "/sdapi/v1/schedulers"): [{"name": "automatic", "label": "Automatic"}],
        ("GET", "/sdapi/v1/upscalers"): [{"name": "R-ESRGAN 4x+"}, {"name": "None"}],
        ("GET", "/sdapi/v1/options"): {"sd_model_checkpoint": "example.safetensors"},
        ("GET", "/internal/pending-tasks"): {"size": 0, "tasks": ["task(foreign)"]},
    }


class Transport:
    def __init__(self, *, progress=None, post=None, fail_post=None):
        self.progress = progress or {"progress": 0.4, "state": {"job": "", "job_count": 0, "sampling_step": 4, "sampling_steps": 10}}
        self.post = post
        self.fail_post = fail_post
        self.calls = []
        self.bodies = []
        self._lock = threading.Lock()

    def __call__(self, method, url, timeout, body=None):
        with self._lock:
            self.calls.append(url)
            if body is not None:
                self.bodies.append(body)
        if not url.startswith("http://127.0.0.1:"):
            raise AssertionError(url)
        path = url.split("://", 1)[1]
        path = path[path.find("/"):]
        if "interrupt" in path:
            raise AssertionError(path)
        if method == "POST":
            if self.fail_post is not None:
                raise self.fail_post
            if callable(self.post):
                return self.post(body)
            payload = {"images": [_png_b64()], "parameters": {}, "info": json.dumps({"all_seeds": [9]})}
            return 200, json.dumps(payload).encode("utf-8")
        key = path.split("?", 1)[0]
        table = _catalog()
        if key == "/sdapi/v1/progress":
            return 200, json.dumps(self.progress).encode("utf-8")
        if (method, key) not in table and key not in {item[1] for item in table}:
            raise AssertionError(key)
        return 200, json.dumps(table[("GET", key)]).encode("utf-8")


def _body(**extra):
    data = {
        "prompt": "a red circle",
        "negative_prompt": "blur",
        "checkpoint": "example.safetensors [abcd]",
        "sampler_name": "Euler",
        "scheduler": "automatic",
        "width": 512,
        "height": 512,
        "steps": 8,
        "cfg_scale": 6,
        "seed": -1,
        "n_iter": 1,
        "batch_size": 1,
    }
    data.update(extra)
    return data


class Jobs(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        J.set_poll_interval_for_tests(0.05)

    def tearDown(self) -> None:
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def _wait(self, job_id: str) -> dict:
        deadline = time.monotonic() + 5
        last = {}
        while time.monotonic() < deadline:
            _code, payload = J.get_job(self.root, job_id)
            last = payload["job"]
            if last["state"] in J.TERMINAL:
                return last
            time.sleep(0.05)
        self.fail(last)

    def test_empty_checkpoint_is_rejected(self):
        transport = Transport()
        code, payload = J.create_job(self.root, _body(checkpoint=""), "idempo-empty-ckpt", transport=transport)
        self.assertEqual(code, 400)
        self.assertEqual(payload.get("code"), "validation")
        self.assertFalse(any(url.endswith("/sdapi/v1/txt2img") for url in transport.calls))

    def test_submission_never_enables_scripts_or_saving(self):
        body = J.submission_body(_body(), "task(hq-" + "ab" * 12 + ")")
        self.assertNotIn("enable_hr", body)
        self.assertEqual(body["save_images"], False)
        self.assertEqual(body["send_images"], True)
        self.assertEqual(body["batch_size"], 1)
        self.assertEqual(body["alwayson_scripts"], {})
        self.assertEqual(body["override_settings"], {"sd_model_checkpoint": "example.safetensors [abcd]"})
        self.assertTrue(body["override_settings_restore_afterwards"])

    def test_completed_job_strips_the_upstream_and_keeps_the_seed(self):
        transport = Transport()
        code, payload = J.create_job(self.root, _body(), "idem-key-1", transport=transport)
        self.assertEqual(code, 202)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["seed_used"], 9)
        self.assertEqual(len(job["images"]), 1)
        blob = json.dumps(job)
        self.assertNotIn("foreign", blob)
        self.assertNotRegex(blob, r"[A-Za-z]:\\\\")
        self.assertNotIn("filename", blob)
        self.assertFalse(any("interrupt" in url for url in transport.calls))
        sent = json.loads(transport.bodies[0].decode("utf-8"))
        self.assertNotIn("enable_hr", sent)
        self.assertEqual(sent["n_iter"], 1)

    def test_same_key_replays_and_a_second_key_conflicts(self):
        held = threading.Event()
        release = threading.Event()

        def before(_job_id):
            held.set()
            release.wait(2)

        J.set_before_submit_for_tests(before)
        transport = Transport()
        code, first = J.create_job(self.root, _body(), "idem-key-2", transport=transport)
        self.assertEqual(code, 202)
        self.assertTrue(held.wait(2))
        again_code, again = J.create_job(self.root, _body(), "idem-key-2", transport=transport)
        self.assertEqual(again_code, 200)
        self.assertEqual(again["job"]["job_id"], first["job"]["job_id"])
        other_code, other = J.create_job(self.root, _body(), "idem-key-3", transport=transport)
        self.assertEqual(other_code, 409)
        self.assertEqual(other["active_job_id"], first["job"]["job_id"])
        cancel_code, cancel = J.cancel_job(self.root, first["job"]["job_id"])
        self.assertEqual(cancel_code, 200)
        self.assertEqual(cancel["cancel"], "cancelled")
        release.set()
        job = self._wait(first["job"]["job_id"])
        self.assertEqual(job["state"], "cancelled")
        self.assertFalse(any(url.endswith("/sdapi/v1/txt2img") for url in transport.calls))

    def test_connection_loss_does_not_interrupt(self):
        transport = Transport(fail_post=ConnectionRefusedError())
        _code, payload = J.create_job(self.root, _body(), "idem-key-10", transport=transport)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["error"], "stopped")
        self.assertFalse(any("interrupt" in url for url in transport.calls))
        transport = Transport(fail_post=TimeoutError())
        _code, payload = J.create_job(self.root, _body(), "idem-key-4", transport=transport)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "unknown")
        self.assertEqual(job["error"], "forge_timeout")
        self.assertNotIn("interrupt", json.dumps(transport.calls))

    def test_in_flight_cancel_is_deferred(self):
        started = threading.Event()
        release = threading.Event()

        def post(_body):
            started.set()
            release.wait(2)
            payload = {"images": [_png_b64()], "info": json.dumps({"seed": 3})}
            return 200, json.dumps(payload).encode("utf-8")

        transport = Transport(post=post)
        _code, payload = J.create_job(self.root, _body(), "idem-key-5", transport=transport)
        self.assertTrue(started.wait(2))
        cancel_code, cancel = J.cancel_job(self.root, payload["job"]["job_id"])
        self.assertEqual(cancel_code, 200)
        self.assertEqual(cancel["cancel"], "deferred")
        self.assertIn("autre travail", cancel["message"])
        release.set()
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "completed")
        self.assertFalse(any("interrupt" in url for url in transport.calls))

    def test_forge_busy_does_not_create_a_job(self):
        transport = Transport(progress={"progress": 0.2, "state": {"job": "scripts_txt2img", "job_count": 1}})
        code, payload = J.create_job(self.root, _body(), "idem-key-6", transport=transport)
        self.assertEqual(code, 409)
        self.assertEqual(payload["forge"], "busy")
        self.assertFalse((self.root / ".hq-forge" / "jobs.json").exists() and "job-" in (self.root / ".hq-forge" / "jobs.json").read_text(encoding="utf-8"))

    # ------------------------------------------------------------------ B: politeness
    BUSY = {"progress": 0.2, "state": {"job": "scripts_txt2img", "job_count": 1, "sampling_step": 3, "sampling_steps": 20}}
    IDLE = {"progress": 0.0, "state": {"job": "", "job_count": 0, "sampling_step": 0, "sampling_steps": 20}}

    def _posts(self, transport):
        return [url for url in transport.calls if url.endswith("/sdapi/v1/txt2img")]

    def _no_forbidden(self, transport):
        paths = [url.split("?", 1)[0] for url in transport.calls]
        self.assertFalse([p for p in paths if p.endswith(("/interrupt", "/skip"))])
        # The only body ever sent is the txt2img submission (no options POST, no model switch).
        self.assertEqual(len(transport.bodies), len(self._posts(transport)))

    def test_busy_forge_holds_a_normal_job_then_sends_it_when_idle(self):
        transport = Transport(progress=dict(self.BUSY))
        code, payload = J.create_job(self.root, _body(wait_if_busy=True), "polite-key-1", transport=transport)
        self.assertEqual(code, 202, payload)
        job = payload["job"]
        self.assertTrue(job["waiting"])
        self.assertEqual(job["state"], "queued")
        self.assertEqual(job["message"], "Forge occup\u00e9, en attente.")
        time.sleep(0.3)
        self.assertEqual(self._posts(transport), [], "nothing is sent while Forge works for someone else")
        other_code, other = J.create_job(self.root, _body(wait_if_busy=True), "polite-key-2", transport=transport)
        self.assertEqual(other_code, 409, "still one HQ job at a time")
        transport.progress = dict(self.IDLE)
        done = self._wait(job["job_id"])
        self.assertEqual(done["state"], "completed")
        self.assertFalse(done["waiting"])
        self.assertEqual(len(self._posts(transport)), 1)
        self._no_forbidden(transport)

    def test_waiting_job_times_out_without_sending(self):
        J.set_wait_timeout_for_tests(0.3)
        transport = Transport(progress=dict(self.BUSY))
        _code, payload = J.create_job(self.root, _body(wait_if_busy=True), "polite-key-3", transport=transport)
        done = self._wait(payload["job"]["job_id"])
        self.assertEqual(done["state"], "failed")
        self.assertEqual(done["error"], "busy_timeout")
        self.assertEqual(done["message"], "Forge est rest\u00e9 occup\u00e9. Rien n'a \u00e9t\u00e9 envoy\u00e9.")
        self.assertEqual(self._posts(transport), [])
        self._no_forbidden(transport)

    def test_waiting_job_can_be_cancelled_locally(self):
        transport = Transport(progress=dict(self.BUSY))
        _code, payload = J.create_job(self.root, _body(wait_if_busy=True), "polite-key-4", transport=transport)
        code, cancel = J.cancel_job(self.root, payload["job"]["job_id"])
        self.assertEqual(cancel["cancel"], "cancelled")
        transport.progress = dict(self.IDLE)
        time.sleep(0.3)
        self.assertEqual(self._posts(transport), [])
        self.assertEqual(self._wait(payload["job"]["job_id"])["state"], "cancelled")

    def test_start_now_queues_behind_without_interrupting(self):
        transport = Transport(progress=dict(self.BUSY))
        _code, payload = J.create_job(self.root, _body(wait_if_busy=True), "polite-key-5", transport=transport)
        job_id = payload["job"]["job_id"]
        code, forced = J.serve_post(self.root, f"/api/forge/jobs/{job_id}/start-now", {}, "")
        self.assertEqual(code, 200)
        self.assertTrue(forced["job"]["forced"])
        done = self._wait(job_id)
        self.assertEqual(done["state"], "completed")
        self.assertEqual(len(self._posts(transport)), 1, "sent once, Forge queues it behind its own work")
        self._no_forbidden(transport)
        again_code, again = J.start_now(self.root, job_id)
        self.assertEqual(again_code, 409)
        self.assertEqual(again["code"], "not_waiting")
        self.assertEqual(J.start_now(self.root, "job-nope")[0], 404)

    def test_private_and_opt_out_keep_the_plain_busy_refusal(self):
        transport = Transport(progress=dict(self.BUSY))
        code, payload = J.create_job(self.root, _body(), "polite-key-6", transport=transport)
        self.assertEqual((code, payload["code"]), (409, "forge_busy"))
        code, payload = J.create_job(self.root, _body(wait_if_busy="yes"), "polite-key-7", transport=transport)
        self.assertEqual((code, payload["code"]), (409, "forge_busy"))

    # ------------------------------------------------------------------ C: explore around
    def test_variation_strip_keeps_the_seed_and_records_each_subseed(self):
        import hq_forge_gallery as G

        def post(body):
            data = json.loads(body.decode("utf-8"))
            n = data["n_iter"]
            info = {"seed": data["seed"], "all_seeds": [data["seed"]] * n, "subseed": data["subseed"],
                    "all_subseeds": [data["subseed"] + i for i in range(n)], "subseed_strength": data["subseed_strength"]}
            return 200, json.dumps({"images": [_png_b64()] * n, "info": json.dumps(info)}).encode("utf-8")

        transport = Transport(post=post)
        code, payload = J.create_job(self.root, _body(seed=42, subseed=100, subseed_strength=0.25, n_iter=6), "vary-key-1", transport=transport)
        self.assertEqual(code, 202, payload)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "completed")
        self.assertEqual(len(job["images"]), 6)
        sent = json.loads(transport.bodies[0].decode("utf-8"))
        self.assertEqual((sent["seed"], sent["subseed"], sent["subseed_strength"], sent["n_iter"]), (42, 100, 0.25, 6))
        metas = [G.get(self.root, image["id"]) for image in job["images"]]
        self.assertEqual(sorted(m["settings"]["subseed"] for m in metas), [100, 101, 102, 103, 104, 105])
        self.assertTrue(all(m["settings"]["seed"] == 42 and m["settings"]["subseed_strength"] == 0.25 for m in metas))
        text = G.infotext(metas[0]["settings"]) if hasattr(G, "infotext") else ""
        if text:
            self.assertIn("Variation seed strength: 0.25", text)

    def test_variation_validation(self):
        transport = Transport()
        bad = [dict(seed=-1, subseed=5, subseed_strength=0.3), dict(seed=1, subseed_strength=1.5),
               dict(seed=1, subseed_strength=0.3, n_iter=7), dict(seed=1, n_iter=3), dict(seed=1, subseed=4),
               dict(seed=1, subseed_strength=True)]
        for index, extra in enumerate(bad):
            code, payload = J.create_job(self.root, _body(**extra), f"vary-bad-{index:02d}", transport=transport)
            self.assertEqual(code, 400, extra)
        self.assertEqual(self._posts(transport), [])
        drawn = J._variation({"subseed_strength": 0.5})
        self.assertTrue(0 <= drawn["subseed"] < 2**32)
        self.assertEqual(J._variation({}), {})
        body = J.submission_body(dict(J._validate(_body(), {"samplers": [{"name": "Euler"}], "schedulers": [{"name": "automatic"}], "models": [{"title": "example.safetensors [abcd]"}]})), "task(hq-" + "ab" * 12 + ")")
        self.assertNotIn("subseed", body, "plain jobs are unchanged")

    def test_bad_image_and_validation(self):
        def post(_body):
            return 200, json.dumps({"images": ["aaaa"]}).encode("utf-8")

        transport = Transport(post=post)
        _code, payload = J.create_job(self.root, _body(), "idem-key-7", transport=transport)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "failed")
        self.assertEqual(job["error"], "bad_image")
        code, rejected = J.create_job(self.root, _body(width=100, enable_hr=True), "idem-key-8", transport=transport)
        self.assertEqual(code, 400)
        self.assertNotIn("job", rejected)

    def test_restart_does_not_resubmit(self):
        path = self.root / ".hq-forge"
        path.mkdir(parents=True)
        job_id = "job-" + "cd" * 12
        (path / "jobs.json").write_text(json.dumps({
            "jobs": [{"id": job_id, "state": "generating", "submitted": True, "settings": {}, "images": []}],
            "idempotency": {"idem-old-1": job_id},
        }), encoding="utf-8")
        J.reset_for_tests()
        J.recover(self.root)
        job = J.get_job(self.root, job_id)[1]["job"]
        self.assertEqual(job["state"], "unknown")
        J.recover(self.root)
        self.assertEqual(J.get_job(self.root, job_id)[1]["job"]["state"], "unknown")

    def test_progress_is_visible_without_a_preview(self):
        started = threading.Event()
        release = threading.Event()

        def post(_body):
            started.set()
            release.wait(2)
            return 200, json.dumps({"images": [_png_b64()], "info": "{\"seed\": 1}"}).encode("utf-8")

        transport = Transport(post=post)
        _code, payload = J.create_job(self.root, _body(), "idem-key-9", transport=transport)
        self.assertTrue(started.wait(2))
        time.sleep(0.15)
        job = J.get_job(self.root, payload["job"]["job_id"])[1]["job"]
        self.assertEqual(job["state"], "generating")
        self.assertEqual(job["step"], 4)
        self.assertNotIn("current_image", json.dumps(job))
        release.set()
        self.assertEqual(self._wait(payload["job"]["job_id"])["state"], "completed")

    def test_http_failure_keeps_only_a_safe_diagnostic(self):
        secret = "PRIVATE-PROMPT-NOT-IN-DIAGNOSTIC"

        def post(_body):
            return 422, json.dumps({"detail": "raw-upstream-body", "prompt": secret}).encode("utf-8")

        transport = Transport(post=post)
        _code, payload = J.create_job(self.root, _body(prompt=secret), "idem-http-safe-01", transport=transport)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["error"], "forge_http")
        self.assertEqual(job["diagnostic"], {
            "classification": "forge_http",
            "http_status": 422,
            "elapsed_ms": job["diagnostic"]["elapsed_ms"],
        })
        self.assertIsInstance(job["diagnostic"]["elapsed_ms"], int)
        blob = json.dumps(job["diagnostic"])
        self.assertNotIn(secret, blob)
        self.assertNotIn("raw-upstream-body", blob)
        stored = (self.root / ".hq-forge" / "jobs.json").read_text(encoding="utf-8")
        self.assertNotIn("raw-upstream-body", stored)

    def test_malformed_and_schema_stay_distinct(self):
        transport = Transport(post=lambda _body: (200, b"not-json"))
        _code, payload = J.create_job(self.root, _body(), "idem-malformed-01", transport=transport)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["error"], "forge_malformed")
        self.assertEqual(job["diagnostic"]["http_status"], 200)
        self.assertNotIn("not-json", json.dumps(job["diagnostic"]))

        transport = Transport(post=lambda _body: (200, json.dumps({"images": 1}).encode("utf-8")))
        _code, payload = J.create_job(self.root, _body(), "idem-schema-0001", transport=transport)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["error"], "forge_schema")
        self.assertNotIn("images", json.dumps(job["diagnostic"]))

    def test_one_idempotency_key_makes_one_upstream_post(self):
        gate = threading.Event()
        transport = Transport()
        original = transport.__call__

        def delayed(method, url, timeout, body=None):
            if method == "GET" and url.endswith("/sdapi/v1/sd-models"):
                gate.wait(2)
            return original(method, url, timeout, body)

        transport.__call__ = delayed
        results = []
        errors = []

        def go() -> None:
            try:
                results.append(J.create_job(self.root, _body(), "idem-shared-0001", transport=transport))
            except Exception as exc:  # noqa: BLE001 - the test records it
                errors.append(exc)

        threads = [threading.Thread(target=go) for _ in range(2)]
        for thread in threads:
            thread.start()
        time.sleep(0.05)
        gate.set()
        for thread in threads:
            thread.join(5)
        self.assertEqual(errors, [])
        self.assertEqual(sorted(item[0] for item in results), [200, 202])
        ids = {item[1]["job"]["job_id"] for item in results}
        self.assertEqual(len(ids), 1)
        self.assertEqual(self._wait(ids.pop())["state"], "completed")
        posts = [url for url in transport.calls if url.endswith("/sdapi/v1/txt2img")]
        self.assertEqual(len(posts), 1)

    def test_a_second_key_cannot_start_while_one_job_is_active(self):
        started = threading.Event()
        release = threading.Event()

        def post(_body):
            started.set()
            release.wait(2)
            return 200, json.dumps({"images": [_png_b64()], "info": "{\"seed\": 1}"}).encode("utf-8")

        transport = Transport(post=post)
        _code, payload = J.create_job(self.root, _body(), "idem-active-0001", transport=transport)
        self.assertTrue(started.wait(2))
        code, rejected = J.create_job(self.root, _body(), "idem-active-0002", transport=transport)
        self.assertEqual((code, rejected["code"]), (409, "active"))
        self.assertEqual(rejected["active_job_id"], payload["job"]["job_id"])
        posts = [url for url in transport.calls if url.endswith("/sdapi/v1/txt2img")]
        self.assertEqual(len(posts), 1)
        release.set()
        self.assertEqual(self._wait(payload["job"]["job_id"])["state"], "completed")

    # ------------------------------------------------------------------ E: finish a kept draft
    HR = {"enable_hr": True, "hr_scale": 1.5, "hr_upscaler": "R-ESRGAN 4x+", "hr_second_pass_steps": 0, "denoising_strength": 0.4}

    def _draft(self) -> str:
        import hq_forge_gallery as G
        raw = base64.b64decode(_png_b64())
        return G.store(self.root, raw, dict(_body(seed=321), n_iter=1, batch_size=1))["id"]

    def test_finish_renders_hires_locally_and_links_the_draft(self):
        import hq_forge_gallery as G
        draft = self._draft()
        transport = Transport()
        code, payload = J.create_job(self.root, _body(seed=321, finish_of=draft, **self.HR), "idem-finish-1", transport=transport)
        self.assertEqual(code, 202, payload)
        self.assertEqual(payload["job"]["finish_of"], draft)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "completed")
        sent = json.loads(transport.bodies[0].decode("utf-8"))
        self.assertTrue(sent["enable_hr"])
        self.assertEqual((sent["hr_scale"], sent["seed"], sent["denoising_strength"]), (1.5, 321, 0.4))
        self.assertNotIn("finish_of", sent, "the link never reaches Forge")
        meta = G.get(self.root, job["images"][0]["id"])
        self.assertEqual(meta["origin"], {"finish_of": draft})
        self.assertTrue(meta["settings"]["enable_hr"])
        self.assertFalse(any("interrupt" in url for url in transport.calls))

    def test_finish_is_refused_before_forge_when_invalid(self):
        draft = self._draft()
        cases = [
            (_body(finish_of=draft), 400),                                   # a finish is always high resolution
            (_body(finish_of="img-nope", **self.HR), 400),
            (_body(finish_of=["x"], **self.HR), 400),
            (_body(finish_of="img-" + "0" * 24, **self.HR), 404),            # unknown image
            (_body(finish_of=draft, destination="private"), 400),            # never in the vault
            (_body(finish_of=draft, destination="private", **self.HR), 403),  # private hires stays refused
        ]
        for index, (body, status) in enumerate(cases):
            transport = Transport()
            with self.subTest(index=index):
                code, payload = J.create_job(self.root, body, f"idem-finish-bad-{index}", transport=transport)
                self.assertEqual(code, status, payload)
                self.assertFalse(transport.bodies, "nothing was sent to Forge")

    def test_hires_batch_and_seed_bounds(self):
        plain = J.submission_body(_body(), "task(hq-" + "ab" * 12 + ")")
        self.assertNotIn("enable_hr", plain)
        self.assertEqual(plain["n_iter"], 1)
        self.assertEqual(plain["batch_size"], 1)
        self.assertNotIn("sd_vae", plain)
        self.assertNotIn("CLIP_stop_at_last_layers", plain.get("override_settings", {}))

        transport = Transport()
        code, rejected = J.create_job(
            self.root,
            _body(destination="private", enable_hr=True, hr_scale=2, hr_upscaler="R-ESRGAN 4x+", hr_second_pass_steps=0, denoising_strength=0.5),
            "idem-hr-private1",
            transport=transport,
        )
        self.assertEqual((code, rejected["code"]), (403, "private_restricted"))
        self.assertFalse(transport.calls)

        for index, extra in enumerate((
            {"batch_size": 2},
            {"batch_size": 0},
            {"n_iter": 3},
            {"n_iter": 0},
            {"seed": -2},
            {"seed": 2**32},
            {"width": 192},
            {"width": 128},
            {"height": 1600},
            {"steps": 41},
            {"cfg_scale": 16},
            {"enable_hr": True, "hr_scale": 3, "hr_upscaler": "R-ESRGAN 4x+", "hr_second_pass_steps": 0, "denoising_strength": 0.5},
            {"enable_hr": True, "hr_scale": 2, "hr_upscaler": "Missing", "hr_second_pass_steps": 0, "denoising_strength": 0.5},
            {"enable_hr": True, "hr_scale": 2, "hr_upscaler": "R-ESRGAN 4x+", "hr_second_pass_steps": 21, "denoising_strength": 0.5},
            {"enable_hr": True, "hr_scale": 2, "hr_upscaler": "R-ESRGAN 4x+", "hr_second_pass_steps": 0, "denoising_strength": 0.9},
            {"width": 1536, "height": 1536, "enable_hr": True, "hr_scale": 2, "hr_upscaler": "R-ESRGAN 4x+", "hr_second_pass_steps": 0, "denoising_strength": 0.5},
            {"sd_vae": "Automatic"},
            {"clip_skip": 2},
        )):
            code, rejected = J.create_job(self.root, _body(**extra), f"idem-bound-{index:02d}xxxx", transport=Transport())
            self.assertEqual(code, 400, extra)
            self.assertEqual(rejected["code"], "validation")

        transport = Transport()
        code, payload = J.create_job(
            self.root,
            _body(n_iter=2, seed=7, enable_hr=True, hr_scale=1.5, hr_upscaler="R-ESRGAN 4x+", hr_second_pass_steps=8, denoising_strength=0.4),
            "idem-hr-normal01",
            transport=transport,
        )
        self.assertEqual(code, 202)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "completed")
        posted = json.loads(transport.bodies[-1])
        self.assertEqual(posted["enable_hr"], True)
        self.assertEqual(posted["hr_scale"], 1.5)
        self.assertEqual(posted["hr_upscaler"], "R-ESRGAN 4x+")
        self.assertEqual(posted["hr_second_pass_steps"], 8)
        self.assertEqual(posted["denoising_strength"], 0.4)
        self.assertEqual(posted["n_iter"], 2)
        self.assertEqual(posted["batch_size"], 1)
        self.assertEqual(posted["seed"], 7)
        self.assertEqual(posted["save_images"], False)
        self.assertEqual(posted["alwayson_scripts"], {})
        self.assertEqual(posted["hr_resize_x"], 0)
        self.assertNotIn("sd_vae", posted.get("override_settings", {}))

    def test_non_finite_hires_numbers_are_rejected_before_forge(self):
        transport = Transport()
        code, payload = J.create_job(
            self.root,
            _body(enable_hr=True, hr_scale=2, hr_upscaler="R-ESRGAN 4x+", hr_second_pass_steps=0, denoising_strength=0.5),
            "idem-finite-ok1",
            transport=transport,
        )
        self.assertEqual(code, 202)
        kept = self._wait(payload["job"]["job_id"])
        self.assertEqual(kept["state"], "completed")
        self.assertEqual(kept["settings"]["denoising_strength"], 0.5)
        before = (self.root / ".hq-forge" / "jobs.json").read_bytes()
        posts = [url for url in transport.calls if url.endswith("/sdapi/v1/txt2img")]
        self.assertEqual(len(posts), 1)
        for index, value in enumerate((float("nan"), float("inf"), float("-inf"))):
            for field in ("denoising_strength", "hr_scale"):
                attempt = Transport()
                body = _body(enable_hr=True, hr_scale=2, hr_upscaler="R-ESRGAN 4x+", hr_second_pass_steps=0, denoising_strength=0.5)
                body[field] = value
                code, rejected = J.create_job(
                    self.root,
                    body,
                    f"idem-nf-{index}-{field[:1]}",
                    transport=attempt,
                )
                self.assertEqual(code, 400, (field, value))
                self.assertEqual(rejected["code"], "validation")
                self.assertNotIn("job", rejected)
                self.assertFalse(any(url.endswith("/sdapi/v1/txt2img") for url in attempt.calls))
        self.assertEqual((self.root / ".hq-forge" / "jobs.json").read_bytes(), before)
        private = Transport()
        code, rejected = J.create_job(
            self.root,
            _body(destination="private", enable_hr=True, hr_scale=float("nan"), hr_upscaler="R-ESRGAN 4x+", hr_second_pass_steps=0, denoising_strength=float("nan")),
            "idem-nf-private1",
            transport=private,
        )
        self.assertEqual((code, rejected["code"]), (403, "private_restricted"))
        self.assertFalse(private.calls)
        self.assertEqual((self.root / ".hq-forge" / "jobs.json").read_bytes(), before)


def _png_b64_sized(edge: int, color=(30, 40, 50)) -> str:
    image = Image.new("RGB", (edge, edge), color)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class RealSeedPerImage(unittest.TestCase):
    """V1/F1: each stored image carries the seed Forge really used."""

    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        J.set_poll_interval_for_tests(0.05)

    def tearDown(self) -> None:
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def _run(self, payload: dict, **body) -> tuple[dict, list[dict]]:
        import hq_forge_gallery as G
        transport = Transport(post=lambda _body: (200, json.dumps(payload).encode("utf-8")))
        code, created = J.create_job(self.root, _body(**body), "seed-key-" + str(len(body)) + "x", transport=transport)
        self.assertEqual(code, 202, created)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _c, got = J.get_job(self.root, created["job"]["job_id"])
            if got["job"]["state"] in J.TERMINAL:
                break
            time.sleep(0.05)
        job = got["job"]
        metas = [G.get(self.root, image["id"]) for image in job["images"]]
        return job, metas

    def test_all_seeds_present_gives_one_seed_per_image(self):
        payload = {"images": [_png_b64(), _png_b64()], "info": json.dumps({"seed": 101, "all_seeds": [101, 102]})}
        job, metas = self._run(payload, n_iter=2)
        self.assertEqual(job["state"], "completed")
        self.assertEqual([m["settings"]["seed"] for m in metas], [101, 102])
        self.assertEqual(job["seed_used"], 101)

    def test_all_seeds_absent_keeps_unknown_for_random(self):
        payload = {"images": [_png_b64()], "info": json.dumps({})}
        job, metas = self._run(payload)
        self.assertEqual(metas[0]["settings"]["seed"], -1)
        self.assertIsNone(job["seed_used"])

    def test_all_seeds_absent_uses_info_seed_then_forge_increment(self):
        payload = {"images": [_png_b64(), _png_b64()], "info": {"seed": 40}}
        _job, metas = self._run(payload, n_iter=2)
        self.assertEqual([m["settings"]["seed"] for m in metas], [40, 41])

    def test_all_seeds_absent_with_a_fixed_seed_keeps_it(self):
        payload = {"images": [_png_b64()], "info": "not json"}
        job, metas = self._run(payload, seed=777)
        self.assertEqual(metas[0]["settings"]["seed"], 777)
        self.assertEqual(job["seed_used"], 777)

    def test_leading_grid_is_skipped_and_seeds_align(self):
        grid = _png_b64_sized(512, (200, 0, 0))
        payload = {"images": [grid, _png_b64(), _png_b64()],
                   "info": json.dumps({"all_seeds": [5, 6], "index_of_first_image": 1})}
        job, metas = self._run(payload, n_iter=2)
        self.assertEqual(len(job["images"]), 2)
        self.assertTrue(all(m["width"] == 256 for m in metas), "the grid must not be stored")
        self.assertEqual([m["settings"]["seed"] for m in metas], [5, 6])

    def test_without_a_grid_index_zero_is_the_first_image(self):
        payload = {"images": [_png_b64(), _png_b64(), _png_b64_sized(512)],
                   "info": json.dumps({"all_seeds": [8, 9], "index_of_first_image": 0})}
        job, metas = self._run(payload, n_iter=2)
        self.assertEqual(len(job["images"]), 2)
        self.assertTrue(all(m["width"] == 256 for m in metas), "trailing extra images are ignored")
        self.assertEqual([m["settings"]["seed"] for m in metas], [8, 9])

    def test_bad_index_and_bad_seeds_fall_back_safely(self):
        payload = {"images": [_png_b64()], "info": json.dumps({"all_seeds": [True, -3], "index_of_first_image": 9})}
        job, metas = self._run(payload)
        self.assertEqual(job["state"], "completed")
        self.assertEqual(metas[0]["settings"]["seed"], -1)


if __name__ == "__main__":
    unittest.main()
