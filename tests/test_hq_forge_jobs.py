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


if __name__ == "__main__":
    unittest.main()
