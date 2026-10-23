"""Multi-device Forge generation. Disposable root, fake PINs, mock Forges, simulated workers.

Never touches the live root, the real Forge on 7860, the real vault, or ports 8765/8766/8776.
"""

from __future__ import annotations

import base64
import json
import os
import re
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import unittest
import contextlib
import io
from unittest import mock
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_diagnostics as D  # noqa: E402
import hq_forge as F  # noqa: E402
import hq_forge_fleet as FL  # noqa: E402
import hq_forge_gallery as G  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_worker as W  # noqa: E402
import iphone_bridge as B  # noqa: E402
from forge_fleet_mocks import FORBIDDEN_PORTS, MODEL, MockForge, SimWorker, png_bytes, safe_server  # noqa: E402
from test_hq_forge_http import ADMIN_PIN, UPLOAD_PIN, Client  # noqa: E402

# Explicit test-only opt-in: unprotected worker secrets, honoured only under a temp root.
os.environ[FL.TEST_PLAIN_ENV] = "1"

SETTINGS = {
    "prompt": "un phare au crépuscule", "negative_prompt": "", "checkpoint": MODEL, "sampler_name": "Euler",
    "scheduler": "automatic", "width": 256, "height": 256, "steps": 10, "cfg_scale": 7, "seed": 1000,
}


def wait_for(predicate, timeout: float = 15.0, step: float = 0.05):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(step)
    raise AssertionError("timeout")


def local_offline(method, url, timeout, body=None):
    raise ConnectionRefusedError()


class FleetHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.saved_poll = (W.POLL_SEC, W.IDLE_MAX_SEC, W.PROGRESS_SEC)
        W.POLL_SEC, W.IDLE_MAX_SEC, W.PROGRESS_SEC = 0.05, 0.1, 0.1
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG), dict(B._DIAG_STATE))

        class Quiet(B.Handler):
            def log_message(self, *_args):
                pass

        cls.httpd = safe_server(Quiet)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        assert cls.httpd.server_address[1] not in FORBIDDEN_PORTS
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        FL.reset_for_tests()
        F.reset_for_tests()
        W.POLL_SEC, W.IDLE_MAX_SEC, W.PROGRESS_SEC = cls.saved_poll
        B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH = cls.saved[0], cls.saved[1], cls.saved[2]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[3])
        B._DIAG_STATE.clear()
        B._DIAG_STATE.update(cls.saved[4])

    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp(prefix="forge-fleet-")
        self.root = Path(self.tmp) / "root"
        self.root.mkdir()
        for name in ("Inbox", "Uni", "Print"):
            (self.root / name).mkdir()
        shutil.copytree(SOURCE / "assets", self.root / "assets")
        B.ROOT = self.root
        B.SESSIONS_PATH = self.root / "bridge_sessions.json"
        B.CONFIG_PATH = self.root / "bridge_config.json"
        B.CONFIG_PATH.write_text("{}", encoding="utf-8")
        B.CONFIG.update({"pin": "", "users": [
            {"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
            {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"},
        ]})
        B.bind_cc_ext()
        B.bind_hq()
        D.ERRORS.clear_for_tests()
        F.reset_for_tests()
        J.reset_for_tests()
        FL.reset_for_tests(lease_sec=5)
        F.set_transport_for_tests(local_offline)
        self.forges: list[MockForge] = []
        self.workers: list[SimWorker] = []
        self.admin = Client(self.base, ADMIN_PIN)
        self.upload = Client(self.base, UPLOAD_PIN)
        self.anon = Client(self.base, None)

    def tearDown(self) -> None:
        for worker in self.workers:
            worker.stop()
        FL.reset_for_tests()
        for mock in self.forges:
            mock.close()
        F.set_transport_for_tests(None)
        G.reset_for_tests()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # helpers
    def post(self, path: str, body: dict, client=None, key: str | None = None):
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Idempotency-Key"] = key
        return (client or self.admin).json(path, "POST", data=json.dumps(body).encode(), headers=headers)

    def code(self) -> str:
        status, payload = self.post("/api/forge/devices/enroll", {})
        self.assertEqual(status, 200)
        return payload["code"]

    def worker(self, name: str, *, start: bool = True, **forge_kwargs) -> SimWorker:
        mock = MockForge(**forge_kwargs)
        self.forges.append(mock)
        sim = SimWorker(self.base, self.code(), name, mock)
        self.workers.append(sim)
        if start:
            sim.start()
            wait_for(lambda: self.device(sim.id)["state"] == "available")
        return sim

    def device(self, worker_id: str) -> dict:
        status, payload = self.admin.json("/api/forge/devices")
        self.assertEqual(status, 200)
        return next(row for row in payload["devices"] if row["id"] == worker_id)

    def batch(self, workers, count: int, key: str, **overrides):
        settings = dict(SETTINGS, **overrides)
        return self.post("/api/forge/batches", {"workers": workers, "count": count, "settings": settings, "destination": "normal"}, key=key)

    def finished(self, batch_id: str) -> dict:
        def done():
            status, payload = self.admin.json(f"/api/forge/batches/{batch_id}")
            return payload["batch"] if payload["batch"]["state"] not in ("running", "cancelling") else None
        return wait_for(done, timeout=30)

    def gallery_ids(self) -> list[str]:
        base = G.gallery_dir(self.root)
        return sorted(p.name for p in base.iterdir() if p.is_dir() and G.IMG_RE.fullmatch(p.name)) if base.is_dir() else []

    # ------------------------------------------------------------------ auth and enrollment
    def test_routes_require_admin_session(self):
        for path in ("/api/forge/devices", "/api/forge/batches"):
            self.assertEqual(self.anon.req(path)[0], 401)
            self.assertEqual(self.upload.req(path)[0], 403)
        self.assertEqual(self.post("/api/forge/devices/enroll", {}, client=self.upload)[0], 403)
        self.assertEqual(self.post("/api/forge/devices/enroll", {}, client=self.anon)[0], 401)
        # CSRF still applies to the browser routes.
        self.assertEqual(self.admin.req("/api/forge/devices/enroll", "POST", b"{}", {"Content-Type": "application/json"}, origin=False)[0], 403)
        # Worker prefix: GET refused, unsigned poll refused.
        self.assertEqual(self.anon.req("/forge-worker/v1/poll")[0], 405)
        self.assertEqual(self.anon.req("/forge-worker/v1/poll", "POST", b"{}", {"Content-Type": "application/json"})[0], 401)

    def test_enroll_code_is_one_time_short_lived_and_hash_only(self):
        code = self.code()
        stored = (self.root / ".hq-forge" / "workers.json").read_text(encoding="utf-8")
        self.assertNotIn(code, stored)
        self.assertNotIn(code.replace("-", ""), stored)
        mock = MockForge()
        self.forges.append(mock)
        sim = SimWorker(self.base, code, "PC salon", mock)
        self.assertRegex(sim.id, r"^wk_[0-9a-f]{16}$")
        self.assertNotIn(sim.creds["secret"], (self.root / ".hq-forge" / "workers.json").read_text(encoding="utf-8")
                         if FL._wrap else "")
        with self.assertRaises(W.HQError) as reused:
            W.pair(self.base, code, "Encore", dev=True, hardware={})
        self.assertEqual(reused.exception.status, 403)
        late = self.code()
        real = time.time
        FL.set_clock_for_tests(lambda: real() + FL.CODE_TTL_SEC + 5)
        try:
            with self.assertRaises(W.HQError) as expired:
                W.pair(self.base, late, "Tard", dev=True, hardware={})
            self.assertEqual(expired.exception.status, 403)
        finally:
            FL.set_clock_for_tests(None)
        with self.assertRaises(W.HQError):
            W.pair(self.base, "AAAA-BBBB-CCCC", "Faux", dev=True, hardware={})

    def test_worker_cli_refuses_code_in_argv_and_plain_http(self):
        import contextlib
        import io
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            W.main(["pair", "--hq", "https://hq.example.ts.net", "--code", "ABCD"])
        with self.assertRaises(ValueError):
            W.validate_hq_url("http://hq.example.ts.net", dev=False)
        with self.assertRaises(ValueError):
            W.validate_hq_url("http://192.168.1.5:8765", dev=True)
        self.assertEqual(W.validate_hq_url("https://hq.example.ts.net/", dev=False), "https://hq.example.ts.net")

    def test_hmac_rejects_bad_signature_replay_skew_and_revoked(self):
        sim = self.worker("PC A", start=False)
        path = W.PREFIX + "/poll"
        body = json.dumps({"forge": {"state": "offline"}}).encode()
        url = self.base + path

        def send(headers):
            return W.http_transport("POST", url, 5, body, {"Content-Type": "application/json", **headers}, 65536)[0]

        good = W.signed_headers(sim.id, sim.creds["secret"], "POST", path, body)
        self.assertEqual(send(good), 200)
        self.assertEqual(send(good), 401, "replayed nonce must be refused")
        bad = W.signed_headers(sim.id, "0" * 64, "POST", path, body)
        self.assertEqual(send(bad), 401)
        tampered = W.signed_headers(sim.id, sim.creds["secret"], "POST", path, b"{}")
        self.assertEqual(send(tampered), 401, "body hash is covered")
        skewed = W.signed_headers(sim.id, sim.creds["secret"], "POST", path, body, now=time.time() - 600)
        self.assertEqual(send(skewed), 401)
        other_path = W.signed_headers(sim.id, sim.creds["secret"], "POST", W.PREFIX + "/progress", body)
        self.assertEqual(send(other_path), 401, "path is covered")
        self.assertEqual(self.post(f"/api/forge/devices/{sim.id}/remove", {})[0], 200)
        self.assertEqual(send(W.signed_headers(sim.id, sim.creds["secret"], "POST", path, body)), 401)

    def test_rename_disable_remove(self):
        sim = self.worker("PC A")
        status, payload = self.post(f"/api/forge/devices/{sim.id}/rename", {"name": "Bureau"})
        self.assertEqual((status, payload["device"]["name"]), (200, "Bureau"))
        self.assertEqual(self.post(f"/api/forge/devices/{sim.id}/rename", {"name": "<script>"})[0], 400)
        self.assertEqual(self.post(f"/api/forge/devices/{sim.id}/disable", {})[0], 200)
        self.assertEqual(self.device(sim.id)["state"], "disabled")
        status, payload = self.batch([sim.id], 1, "disabled-key-1")
        self.assertEqual(status, 409)
        self.assertEqual(self.post(f"/api/forge/devices/{sim.id}/enable", {})[0], 200)
        wait_for(lambda: self.device(sim.id)["state"] == "available")
        self.assertEqual(self.post(f"/api/forge/devices/{sim.id}/remove", {})[0], 200)
        status, payload = self.admin.json("/api/forge/devices")
        self.assertEqual([row["id"] for row in payload["devices"]], ["local"])

    # ------------------------------------------------------------------ health
    def test_hardware_health_and_offline(self):
        sim = self.worker("PC A")
        row = self.device(sim.id)
        self.assertTrue(row["online"])
        self.assertEqual(row["forge"], "ready")
        self.assertEqual(row["hardware"]["gpus"][0]["vram_mb"], 8192)
        self.assertEqual(row["hardware"]["ram_mb"], 32768)
        self.assertIn(MODEL, row["catalog"]["models"])
        self.assertEqual(row["model"], MODEL)
        self.assertNotIn("secret", json.dumps(row))
        sim.forge_mock.mode = "offline"
        sim.worker.forge._catalog = None
        wait_for(lambda: self.device(sim.id)["state"] == "forge_down")
        self.assertTrue(self.device(sim.id)["online"], "HQ link stays online while Forge is down")
        sim.stop()
        real = time.time
        FL.set_clock_for_tests(lambda: real() + FL.ONLINE_SEC + 5)
        try:
            row = self.device(sim.id)
            self.assertEqual((row["state"], row["state_label"], row["online"]), ("offline", "Hors ligne", False))
        finally:
            FL.set_clock_for_tests(None)

    def test_local_device_is_listed_and_unknown_hardware_stays_unknown(self):
        status, payload = self.admin.json("/api/forge/devices")
        local = payload["devices"][0]
        self.assertEqual((local["id"], local["kind"]), ("local", "local"))
        self.assertEqual(local["state"], "forge_down")
        self.assertIsNone(local["hardware"]["ram_mb"])
        self.assertEqual(local["hardware"]["gpus"], [])

    def test_hardware_detection_never_fabricates_vram_from_cim(self):
        saved = W._run
        try:
            W._run = lambda args, timeout=8.0: None if args[0] == "nvidia-smi" else "NVIDIA GeForce RTX 4090\n"
            gpus = W._nvidia() or W._cim_gpus()
            if gpus:
                self.assertIsNone(gpus[0]["vram_mb"])
            W._run = lambda args, timeout=8.0: "NVIDIA GeForce RTX 4090, 24564\n" if args[0] == "nvidia-smi" else None
            self.assertEqual(W._nvidia()[0]["vram_mb"], 24564)
        finally:
            W._run = saved

    # ------------------------------------------------------------------ generation
    def test_single_worker_batch_lands_in_gallery_with_seeds_and_provenance(self):
        sim = self.worker("PC A")
        status, payload = self.batch([sim.id], 3, "single-key-1")
        self.assertEqual(status, 202, payload)
        again = self.batch([sim.id], 3, "single-key-1")
        self.assertEqual(again[1]["batch"]["batch_id"], payload["batch"]["batch_id"], "idempotent submit")
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["state"], "completed")
        self.assertEqual(done["counts"]["done"], 3)
        self.assertEqual([task["seed"] for task in done["tasks"]], [1000, 1001, 1002])
        self.assertEqual(sorted(call["seed"] for call in sim.forge_mock.calls), [1000, 1001, 1002])
        self.assertEqual(len(sim.forge_mock.calls), 3)
        ids = self.gallery_ids()
        self.assertEqual(len(ids), 3)
        meta = G.get(self.root, ids[0])
        self.assertEqual(meta["origin"]["worker_id"], sim.id)
        self.assertEqual(meta["origin"]["worker_name"], "PC A")
        self.assertEqual(meta["origin"]["batch_id"], done["batch_id"])
        self.assertIn(meta["settings"]["seed"], (1000, 1001, 1002))
        self.assertEqual(sim.forge_mock.interrupts, 0)
        body = sim.forge_mock.calls[0]["body"]
        self.assertEqual(body["override_settings"], {"sd_model_checkpoint": MODEL})
        self.assertEqual(body["n_iter"], 1)

    def test_random_seed_is_drawn_per_image_and_recorded(self):
        sim = self.worker("PC A")
        status, payload = self.batch([sim.id], 2, "random-key-1", seed=-1)
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["seed_mode"], "random")
        seeds = [task["seed"] for task in done["tasks"]]
        self.assertTrue(all(0 <= seed < 2**32 for seed in seeds))
        self.assertEqual(sorted(seeds), sorted(call["seed"] for call in sim.forge_mock.calls))

    def test_two_workers_generate_concurrently(self):
        a = self.worker("PC A", delay=0.8)
        b = self.worker("PC B", delay=0.8, colour=(200, 40, 40))
        status, payload = self.batch([a.id, b.id], 4, "parallel-key-1")
        self.assertEqual(status, 202, payload)
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["counts"]["done"], 4)
        self.assertEqual(len(a.forge_mock.calls) + len(b.forge_mock.calls), 4)
        self.assertGreaterEqual(len(a.forge_mock.calls), 1)
        self.assertGreaterEqual(len(b.forge_mock.calls), 1)
        overlap = any(x["start"] < y["end"] and y["start"] < x["end"] for x in a.forge_mock.calls for y in b.forge_mock.calls)
        self.assertTrue(overlap, "the two workers must run at the same time")
        self.assertEqual({row["worker_id"]: row["done"] for row in done["workers"]},
                         {a.id: len(a.forge_mock.calls), b.id: len(b.forge_mock.calls)})
        self.assertEqual(len(self.gallery_ids()), 4)
        self.assertEqual(sorted(task["seed"] for task in done["tasks"]), [1000, 1001, 1002, 1003])

    def test_partial_failure_keeps_completed_images(self):
        a = self.worker("PC A", delay=0.3)
        b = self.worker("PC B", delay=0.3, mode="fail")
        status, payload = self.batch([a.id, b.id], 4, "partial-key-1")
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["state"], "partial")
        self.assertGreaterEqual(done["counts"]["done"], 1)
        self.assertGreaterEqual(done["counts"]["failed"], 1)
        self.assertEqual(done["counts"]["done"] + done["counts"]["failed"], 4)
        self.assertEqual(len(self.gallery_ids()), done["counts"]["done"])
        failed = [task for task in done["tasks"] if task["state"] == "failed"]
        self.assertTrue(all(task["worker_id"] == b.id and task["error"] == "forge_error" for task in failed))
        self.assertTrue(all(task["message"] for task in failed))

    def test_disconnect_after_dispatch_becomes_uncertain_and_is_not_rerun(self):
        FL._lease_sec = 0.5
        a = self.worker("PC A", start=False)
        b = self.worker("PC B", start=False)
        a.worker.poll_once()
        b.worker.poll_once()
        status, payload = self.batch([a.id, b.id], 2, "disconnect-key-1")
        task = a.worker.poll_once()
        self.assertIsNotNone(task)
        # PC A vanishes without running it. PC B runs everything it is given.
        b.start()
        done = self.finished(payload["batch"]["batch_id"])
        states = {row["id"]: row["state"] for row in done["tasks"]}
        self.assertEqual(states[task["task_id"]], "uncertain")
        self.assertEqual(done["counts"]["done"], 1)
        self.assertEqual(len(b.forge_mock.calls), 1, "the uncertain task is not re-run elsewhere")
        self.assertEqual(len(a.forge_mock.calls), 0)
        lost = [row for row in done["tasks"] if row["id"] == task["task_id"]][0]
        row_a = [row for row in done["workers"] if row["worker_id"] == a.id][0]
        self.assertEqual((row_a["uncertain"], row_a["failed"], row_a["done"]), (1, 1, 0), "per-worker rows split out uncertain")
        self.assertIn("pas relancée", lost["message"])

    def test_retry_rebuilds_only_missing_images_and_accepts_a_late_upload(self):
        a = self.worker("PC A", start=False)
        b = self.worker("PC B", start=False)
        a.worker.poll_once()
        b.worker.poll_once()
        status, payload = self.batch([a.id, b.id], 2, "retry-src-key-1", seed=500)
        self.assertEqual(status, 202, payload)
        source_id = payload["batch"]["batch_id"]
        lost = a.worker.poll_once()
        self.assertIsNotNone(lost)
        self.assertEqual(self.post(f"/api/forge/batches/{source_id}/retry", {}, key="retry-early-key")[0], 409,
                         "a running batch cannot be retried")
        b.start()
        wait_for(lambda: self.admin.json(f"/api/forge/batches/{source_id}")[1]["batch"]["counts"]["done"] == 1)
        b.stop()
        real = time.time
        FL.set_clock_for_tests(lambda: real() + FL._lease_sec + 5)  # PC A's lease expires
        try:
            done = self.finished(source_id)
        finally:
            FL.set_clock_for_tests(None)
        task = next(row for row in done["tasks"] if row["id"] == lost["task_id"])
        self.assertEqual(task["state"], "uncertain")
        self.assertEqual((done["retryable"], done["retry_uncertain"]), (1, 1))
        # A bad signature changes nothing, in memory or on disk.
        before_mem = json.dumps(FL._batches, sort_keys=True)
        before_disk = (FL._dir() / "batches.json").read_bytes()
        body = json.dumps({"task_id": lost["task_id"], "image_b64": base64.b64encode(png_bytes()).decode()}).encode()
        forged = W.signed_headers(a.id, "0" * 64, "POST", W.PREFIX + "/result", body)
        sent = W.http_transport("POST", self.base + W.PREFIX + "/result", 5, body, {"Content-Type": "application/json", **forged}, 65536)[0]
        self.assertEqual(sent, 401)
        self.assertEqual(json.dumps(FL._batches, sort_keys=True), before_mem)
        self.assertEqual((FL._dir() / "batches.json").read_bytes(), before_disk)
        # Retry: one task, same seed and settings, idempotent per key.
        status, retried = self.post(f"/api/forge/batches/{source_id}/retry", {}, key="retry-key-0001")
        self.assertEqual(status, 202, retried)
        new = retried["batch"]
        self.assertEqual(new["retry_of"], source_id)
        self.assertEqual([(t["index"], t["seed"]) for t in new["tasks"]], [(task["index"], task["seed"])])
        self.assertEqual(new["settings"]["prompt"], SETTINGS["prompt"])
        self.assertEqual(self.post(f"/api/forge/batches/{source_id}/retry", {}, key="retry-key-0001")[1]["batch"]["batch_id"], new["batch_id"])
        self.assertEqual(self.post(f"/api/forge/batches/{source_id}/retry", {}, key="retry-key-0002")[0], 409, "nothing left to retry")
        self.assertEqual(self.admin.json(f"/api/forge/batches/{source_id}")[1]["batch"]["retryable"], 0)
        job = b.worker.poll_once()
        self.assertIsNotNone(job)
        b.worker.run_task(job)
        finished = self.finished(new["batch_id"])
        self.assertEqual(finished["state"], "completed")
        self.assertEqual(b.forge_mock.calls[-1]["seed"], task["seed"])
        # The first device finally answers: accepted on the original task as an extra image.
        a.worker.run_task(lost)
        late = self.admin.json(f"/api/forge/batches/{source_id}")[1]["batch"]
        late_task = next(row for row in late["tasks"] if row["id"] == lost["task_id"])
        self.assertEqual(late_task["state"], "completed")
        self.assertEqual(len(self.gallery_ids()), 3)
        origins = [G.get(self.root, image_id).get("origin") or {} for image_id in self.gallery_ids()]
        self.assertIn(lost["task_id"], [o.get("task_id") for o in origins])
        # Counts stay coherent: the source reports both of its images, the retry batch its own one.
        self.assertEqual(sum(v for k, v in late["counts"].items() if k != "total"), late["counts"]["total"])
        self.assertEqual((late["counts"]["done"], late["retryable"]), (2, 0))
        again = self.admin.json(f"/api/forge/batches/{new['batch_id']}")[1]["batch"]
        self.assertEqual((again["counts"]["done"], again["count"], again["retry_of"]), (1, 1, source_id))
        # One retry per image: even if the retry task had failed, it is not offered again.
        with FL._LOCK:
            FL._find_batch(new["batch_id"])["tasks"][0]["state"] = "failed"
        self.assertEqual(self.admin.json(f"/api/forge/batches/{new['batch_id']}")[1]["batch"]["retryable"], 0)
        self.assertEqual(self.post(f"/api/forge/batches/{new['batch_id']}/retry", {}, key="retry-key-0003")[0], 409)
        self.assertEqual(a.forge_mock.interrupts + b.forge_mock.interrupts, 0)

    def test_uncertain_tasks_get_an_explicit_choice_never_an_automatic_relaunch(self):
        a = self.worker("PC A", start=False)
        b = self.worker("PC B", start=False)
        c = self.worker("PC C", start=False)
        for sim in (a, b, c):
            sim.worker.poll_once()
        status, payload = self.batch([a.id, b.id, c.id], 3, "resolve-src-key-1")
        self.assertEqual(status, 202, payload)
        source_id = payload["batch"]["batch_id"]
        lost_a = a.worker.poll_once()
        lost_c = c.worker.poll_once()
        self.assertIsNotNone(lost_a)
        self.assertIsNotNone(lost_c)
        b.start()
        wait_for(lambda: self.admin.json(f"/api/forge/batches/{source_id}")[1]["batch"]["counts"]["done"] == 1)
        b.stop()
        real = time.time
        FL.set_clock_for_tests(lambda: real() + FL._lease_sec + 5)
        try:
            done = self.finished(source_id)
        finally:
            FL.set_clock_for_tests(None)
        self.assertEqual(done["retryable"], 2)
        self.assertTrue(all("attempt" in t and "resolution" in t for t in done["tasks"]), "journal fields are public")
        calls = len(b.forge_mock.calls)
        path = f"/api/forge/batches/{source_id}/tasks/" + lost_a["task_id"] + "/resolve"
        self.assertEqual(self.post(path, {"action": "relaunch"})[0], 400)
        status, kept = self.post(path, {"action": "lost"})
        self.assertEqual(status, 200, kept)
        row = next(t for t in kept["batch"]["tasks"] if t["id"] == lost_a["task_id"])
        self.assertEqual((row["state"], row["resolution"]), ("uncertain", "lost"))
        self.assertEqual(kept["batch"]["retryable"], 1)
        self.assertEqual(self.post(path, {"action": "keep"})[0], 200, "the choice can be changed while still uncertain")
        done_task = next(t for t in done["tasks"] if t["state"] == "completed")
        self.assertEqual(self.post(f"/api/forge/batches/{source_id}/tasks/{done_task['id']}/resolve", {"action": "lost"})[0], 409)
        self.assertEqual(self.post(f"/api/forge/batches/{source_id}/tasks/tk-" + "0" * 24 + "/resolve", {"action": "lost"})[0], 404)
        time.sleep(0.3)
        self.assertEqual(len(b.forge_mock.calls), calls, "resolving never relaunches anything")
        # Relancer one image: only that task goes into the retry batch.
        status, retried = self.post(f"/api/forge/batches/{source_id}/retry", {"tasks": [lost_c["task_id"]]}, key="resolve-retry-key-1")
        self.assertEqual(status, 202, retried)
        self.assertEqual([t["retry_of_task"] for t in retried["batch"]["tasks"]], [lost_c["task_id"]])
        self.assertEqual(retried["batch"]["tasks"][0]["attempt"], 2)
        self.assertEqual(self.post(f"/api/forge/batches/{source_id}/retry", {}, key="resolve-retry-key-2")[0], 409, "the kept task is not offered again")
        self.assertEqual(self.post(f"/api/forge/batches/{source_id}/tasks/" + lost_c["task_id"] + "/resolve", {"action": "lost"})[0], 409)

    def test_resolve_route_needs_admin_csrf_and_known_ids(self):
        path = "/api/forge/batches/bt-" + "0" * 24 + "/tasks/tk-" + "0" * 24 + "/resolve"
        self.assertEqual(self.post(path, {"action": "lost"}, client=self.upload)[0], 403)
        self.assertIn(self.post(path, {"action": "lost"}, client=self.anon)[0], (401, 403))
        self.assertEqual(self.post(path, {"action": "lost"})[0], 404)
        self.assertEqual(self.post("/api/forge/batches/nope/tasks/x/resolve", {"action": "lost"})[0], 404)
        forged = self.admin.json(path, "POST", data=b'{"action": "lost"}', headers={"Content-Type": "application/json", "Origin": "http://evil.example"})
        self.assertEqual(forged[0], 403)

    def test_retry_routes_need_admin_csrf_and_known_batches(self):
        self.assertEqual(self.post("/api/forge/batches/bt-" + "0" * 24 + "/retry", {}, client=self.upload, key="retry-up-key")[0], 403)
        self.assertIn(self.post("/api/forge/batches/bt-" + "0" * 24 + "/retry", {}, client=self.anon, key="retry-anon-key")[0], (401, 403))
        self.assertEqual(self.post("/api/forge/batches/bt-" + "0" * 24 + "/retry", {}, key="retry-404-key")[0], 404)
        self.assertEqual(self.post("/api/forge/batches/bt-" + "0" * 24 + "/retry", {}, key="bad")[0], 400)
        forged = self.admin.json("/api/forge/batches/bt-" + "0" * 24 + "/retry", "POST", data=b"{}",
                                 headers={"Content-Type": "application/json", "Idempotency-Key": "retry-csrf-key", "Origin": "http://evil.example"})
        self.assertEqual(forged[0], 403, "a cross-origin retry is refused by CSRF")

    def test_retry_refuses_when_no_device_of_the_batch_is_usable(self):
        a = self.worker("PC A", start=False, mode="fail")
        a.worker.poll_once()
        status, payload = self.batch([a.id], 1, "retry-none-key-1")
        job = a.worker.poll_once()
        a.worker.run_task(job)
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["state"], "failed")
        self.assertEqual(self.post(f"/api/forge/devices/{a.id}/disable", {})[0], 200)
        status, refused = self.post(f"/api/forge/batches/{done['batch_id']}/retry", {}, key="retry-none-key-2")
        self.assertEqual((status, refused["code"]), (409, "retry_none"))
        self.assertEqual(self.admin.json(f"/api/forge/batches/{done['batch_id']}")[1]["batch"]["retryable"], 1, "a refused retry marks nothing")

    def test_worker_restart_reports_lost_task_as_uncertain(self):
        a = self.worker("PC A", start=False)
        a.worker.poll_once()
        status, payload = self.batch([a.id], 2, "lost-key-1")
        first = a.worker.poll_once()
        second = a.worker.poll_once()  # new process: no current task, the first is lost
        self.assertIsNotNone(first)
        batch = self.admin.json(f"/api/forge/batches/{payload['batch']['batch_id']}")[1]["batch"]
        states = {row["id"]: row["state"] for row in batch["tasks"]}
        self.assertEqual(states[first["task_id"]], "uncertain")
        self.assertIsNotNone(second)
        self.assertNotEqual(second["task_id"], first["task_id"])

    def test_hq_restart_resumes_queued_and_marks_dispatched_uncertain(self):
        a = self.worker("PC A", start=False)
        a.worker.poll_once()
        status, payload = self.batch([a.id], 3, "restart-key-1")
        batch_id = payload["batch"]["batch_id"]
        dispatched = a.worker.poll_once()
        self.assertIsNotNone(dispatched)
        # Simulate an HQ restart: forget memory, keep files, bind again.
        FL.reset_for_tests(lease_sec=5)
        FL.bind(self.root)
        status, payload = self.admin.json(f"/api/forge/batches/{batch_id}")
        states = {row["id"]: row for row in payload["batch"]["tasks"]}
        self.assertEqual(states[dispatched["task_id"]]["state"], "uncertain")
        self.assertEqual(states[dispatched["task_id"]]["error"], "hq_restart")
        self.assertEqual(sum(1 for row in states.values() if row["state"] == "queued"), 2)
        a.start()
        done = self.finished(batch_id)
        self.assertEqual(done["counts"]["done"], 2)
        self.assertEqual(done["counts"]["uncertain"], 1)
        self.assertEqual(len(a.forge_mock.calls), 2)

    def test_bad_png_is_rejected_and_nothing_is_stored(self):
        a = self.worker("PC A", start=False)
        a.worker.poll_once()
        status, payload = self.batch([a.id], 2, "badpng-key-1")
        task = a.worker.poll_once()
        with self.assertRaises(W.HQError) as refused:
            a.client.call("/result", {"task_id": task["task_id"], "image_b64": base64.b64encode(b"GIF89a....").decode()}, max_body=1 << 20)
        self.assertEqual(refused.exception.status, 422)
        self.assertEqual(self.gallery_ids(), [])
        # Oversized dimensions are refused too.
        task2 = a.worker.poll_once()
        with self.assertRaises(W.HQError):
            a.client.call("/result", {"task_id": task2["task_id"], "image_b64": base64.b64encode(png_bytes(1024, 1024)).decode()}, max_body=1 << 22)
        self.assertEqual(self.gallery_ids(), [])
        batch = self.admin.json(f"/api/forge/batches/{payload['batch']['batch_id']}")[1]["batch"]
        self.assertEqual([row["error"] for row in batch["tasks"]], ["bad_image", "bad_image"])
        # A worker whose Forge returns garbage never uploads it.
        b = self.worker("PC B", mode="badpng")
        status, payload = self.batch([b.id], 1, "badpng-key-2")
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["tasks"][0]["error"], "bad_image")
        self.assertEqual(self.gallery_ids(), [])

    def test_gallery_quota_gives_partial_success_without_deleting(self):
        G.set_quota_for_tests(image_cap=2)
        a = self.worker("PC A")
        status, payload = self.batch([a.id], 3, "quota-key-1")
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["state"], "partial")
        self.assertEqual(done["counts"]["done"], 2)
        self.assertEqual([row["error"] for row in done["tasks"] if row["state"] == "failed"], ["quota"])
        self.assertEqual(len(self.gallery_ids()), 2)

    def test_incompatible_model_is_refused_with_french_reason_and_no_substitution(self):
        a = self.worker("PC A")
        b = self.worker("PC B", models=("other.safetensors [ffff]",))
        status, payload = self.batch([a.id, b.id], 2, "compat-key-1")
        self.assertEqual(status, 409)
        self.assertEqual(payload["code"], "incompatible")
        problem = payload["problems"][0]
        self.assertEqual(problem["worker_id"], b.id)
        self.assertIn("Modèle « example.safetensors [abcd] » absent.", problem["reasons"])
        status, payload = self.batch([a.id], 1, "compat-key-2", sampler_name="DPM++ 2M")
        self.assertEqual(status, 409)
        self.assertIn("Échantillonneur « DPM++ 2M » absent.", payload["problems"][0]["reasons"])
        self.assertEqual(len(a.forge_mock.calls) + len(b.forge_mock.calls), 0)

    # ------------------------------------------------------------------ statistics (phase A)
    def test_batch_tasks_record_device_duration_outcome_and_attempt(self):
        import hq_forge_stats as S
        sim = self.worker("PC A", fail_first=1)
        status, payload = self.batch([sim.id], 2, "stats-batch-1", prompt="zq-fleet-stat-prompt")
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual((done["counts"]["done"], done["counts"]["failed"]), (1, 1))
        status, retry = self.post(f"/api/forge/batches/{done['batch_id']}/retry", {}, key="stats-retry-1")
        self.assertIn(status, (200, 202), retry)
        self.finished(retry["batch"]["batch_id"])
        rows = [r for r in S.records(self.root) if r["kind"] == "batch"]
        self.assertEqual(sorted((r["outcome"], r["attempt"]) for r in rows), [("completed", 1), ("completed", 2), ("failed", 1)])
        ok = [r for r in rows if r["outcome"] == "completed"]
        self.assertTrue(all(r["device_name"] == "PC A" and r["device_id"] == sim.id and "duration_s" in r and r["image_id"] for r in ok))
        self.assertNotIn("zq-fleet-stat-prompt", (self.root / ".hq-forge" / "stats.json").read_text(encoding="utf-8"))

    # ------------------------------------------------------------------ parity (A)
    def _excluded_run(self, key, b_kwargs, **overrides):
        a = self.worker("PC A")
        b = self.worker("PC B", **b_kwargs)
        status, payload = self.batch([a.id, b.id], 2, key, **overrides)
        self.assertEqual(status, 202, payload)
        excluded = payload["batch"]["excluded"]
        self.assertEqual([row["worker_id"] for row in excluded], [b.id])
        self.assertTrue(excluded[0]["message"].startswith("PC B : "))
        self.assertTrue(excluded[0]["message"].endswith(", exclu."))
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["counts"]["done"], 2)
        self.assertEqual(len(a.forge_mock.calls), 2)
        self.assertEqual(len(b.forge_mock.calls), 0, "an excluded device never renders")
        return a, b, excluded[0], done

    def test_same_filename_but_other_hash_is_excluded_with_a_plain_message(self):
        a, b, row, done = self._excluded_run("parity-hash", {"hashes": {MODEL: "f" * 64}})
        self.assertIn("autre version du mod\u00e8le", row["message"])
        self.assertEqual(done["excluded"][0]["worker_id"], b.id)
        meta = G.get(self.root, self.gallery_ids()[0])
        self.assertEqual(meta["origin"]["worker_name"], "PC A", "rendering device is recorded")
        self.assertEqual(meta["origin"]["checkpoint_sha256"], a.forge_mock.hashes[MODEL])

    def test_vae_mismatch_is_excluded(self):
        _a, _b, row, _ = self._excluded_run("parity-vae", {"vae": ("other-vae.safetensors",)})
        self.assertIn("VAE diff\u00e9rent", row["message"])

    def _lora_batch(self, key, a_loras, b_loras):
        a = self.worker("PC A", loras=a_loras)
        b = self.worker("PC-2", loras=b_loras)
        status, payload = self.batch([a.id, b.id], 2, key, prompt="un phare <lora:grain:0.6>")
        self.assertEqual(status, 202, payload)
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["counts"]["done"], 2)
        return a, b, payload["batch"]["excluded"]

    def test_missing_lora_excludes_the_pc_with_a_plain_message(self):
        g = {"name": "grain", "alias": "grain", "metadata": {}}
        a, b, excluded = self._lora_batch("lora-missing", [g], [])
        self.assertEqual(excluded[0]["message"], "PC-2 n'a pas le LoRA \u00ab grain \u00bb, exclu.")
        self.assertEqual(len(b.forge_mock.calls), 0)

    def test_same_lora_content_hash_splits_and_metadata_never_leaves_the_worker(self):
        g = {"name": "grain", "alias": "grain", "metadata": {"sshs_model_hash": "c" * 64, "ss_tag_frequency": {"secret-tag": 3}}}
        a, b, excluded = self._lora_batch("lora-same", [g], [dict(g, name="grain_v1")])
        self.assertEqual(excluded, [])
        self.assertGreaterEqual(len(b.forge_mock.calls), 1)
        status, payload = self.admin.json("/api/forge/devices")
        self.assertNotIn("secret-tag", json.dumps(payload))

    def test_other_lora_hash_is_excluded(self):
        g = {"name": "grain", "alias": "grain", "metadata": {"sshs_model_hash": "c" * 64}}
        _a, b, excluded = self._lora_batch("lora-hash", [g], [{"name": "grain", "alias": "grain", "metadata": {"sshs_model_hash": "d" * 64}}])
        self.assertEqual(excluded[0]["message"], "PC-2 : autre version du LoRA \u00ab grain \u00bb, exclu.")
        self.assertEqual(len(b.forge_mock.calls), 0)

    def test_without_hash_name_and_alias_must_match(self):
        g = {"name": "grain", "alias": "grain", "metadata": {}}
        _a, b, excluded = self._lora_batch("lora-name-ok", [g], [g])
        self.assertEqual(excluded, [])

    def test_without_hash_a_different_file_name_is_excluded(self):
        g = {"name": "grain", "alias": "grain", "metadata": {}}
        _a, b, excluded = self._lora_batch("lora-name-bad", [dict(g, name="grain_old")], [dict(g, name="grain_new")])
        self.assertEqual(excluded[0]["message"], "PC-2 : LoRA \u00ab grain \u00bb diff\u00e9rent, exclu.")

    def test_unreadable_lora_list_excludes(self):
        g = {"name": "grain", "alias": "grain", "metadata": {}}
        _a, b, excluded = self._lora_batch("lora-unread", [g], None)
        self.assertEqual(excluded[0]["message"], "PC-2 : liste des LoRA illisible, exclu.")
        self.assertEqual(len(b.forge_mock.calls), 0)
        # A prompt without LoRA ignores the list entirely.
        cat = {"hashes": {MODEL: "a" * 64}, "vae": [], "loras": None}
        kept, excl, _ = FL.parity_split({"checkpoint": MODEL, "prompt": "x"}, ["w1", "w2"], {"w1": cat, "w2": cat}, {})
        self.assertEqual((kept, excl), (["w1", "w2"], []))

    def test_dispatch_rechecks_the_lora(self):
        ref = {"name": "grain", "alias": "grain", "hash": "c" * 64}
        parity = {"reference": "w1", "checkpoint_sha256": "a" * 64, "vae": [], "loras": {"grain": ref}}
        batch = {"parity": parity, "settings": {"checkpoint": MODEL}}
        good = {"hashes": {MODEL: "a" * 64}, "vae": [], "loras": {"items": [ref], "truncated": False}}
        self.assertTrue(FL._parity_ok(batch, "w2", good))
        self.assertFalse(FL._parity_ok(batch, "w2", dict(good, loras={"items": [], "truncated": False})))
        self.assertFalse(FL._parity_ok(batch, "w2", dict(good, loras=None)))
        self.assertEqual(W.lora_list([{"name": "a", "alias": "b", "metadata": {"sshs_model_hash": "E" * 64, "x": "y"}}, {"name": ""}]),
                         {"items": [{"name": "a", "alias": "b", "hash": "e" * 64}], "truncated": True})

    def test_unknown_hash_is_excluded_never_assumed_equal(self):
        _a, _b, row, _ = self._excluded_run("parity-nohash", {"hashes": {MODEL: None}})
        self.assertIn("empreinte du mod\u00e8le", row["message"])

    def test_matching_devices_still_split_and_parity_split_is_pure(self):
        a = self.worker("PC A")
        b = self.worker("PC B")
        status, payload = self.batch([a.id, b.id], 4, "parity-same")
        self.assertEqual(payload["batch"]["excluded"], [])
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(len(a.forge_mock.calls) + len(b.forge_mock.calls), 4)
        cat = {"hashes": {MODEL: "a" * 64}, "vae": []}
        kept, excluded, parity = FL.parity_split({"checkpoint": MODEL, "prompt": "x"}, ["w1", "w2"],
                                                 {"w1": cat, "w2": dict(cat, vae=None)}, {"w2": "PC-2"})
        self.assertEqual(kept, ["w1"])
        self.assertEqual(excluded[0]["message"], "PC-2 : VAE inconnu, exclu.")
        self.assertTrue(FL._parity_ok({"parity": parity, "settings": {"checkpoint": MODEL}}, "w2", cat))
        self.assertFalse(FL._parity_ok({"parity": parity, "settings": {"checkpoint": MODEL}}, "w2", {"hashes": {MODEL: "b" * 64}, "vae": []}))

    def test_worker_refuses_a_task_whose_model_hash_differs(self):
        import types
        sent, posted = [], []
        forge = types.SimpleNamespace(catalog=lambda force=False: {"models": [MODEL], "hashes": {MODEL: "a" * 64}},
                                      txt2img=lambda body: posted.append(body))
        hq = types.SimpleNamespace(call=lambda path, payload, **kw: sent.append((path, payload)))
        fake = types.SimpleNamespace(_lock=threading.Lock(), current=None, forge=forge, hq=hq, last_error="",
                                     stop=threading.Event(), _progress_loop=lambda *a: None)
        fake._fail = lambda task_id, code: W.Worker._fail(fake, task_id, code)
        task = {"task_id": "tk-parity1", "settings": dict(SETTINGS), "checkpoint_sha256": "e" * 64}
        self.assertEqual(W.Worker.run_task(fake, task), "model_mismatch")
        self.assertEqual(posted, [], "nothing is sent to Forge")
        self.assertEqual(sent, [("/fail", {"task_id": "tk-parity1", "code": "model_mismatch"})])
        self.assertEqual(W.model_hashes([{"title": MODEL, "sha256": "A" * 64}, {"title": "x"}]), {MODEL: "a" * 64, "x": None})
        self.assertEqual(W.vae_names({"forge_additional_modules": ["C:/m/vae/b.safetensors", "a.pt"], "sd_vae": "Automatic"}), ["a.pt", "b.safetensors"])

    # ------------------------------------------------------------------ variations (C)
    def test_variation_fans_out_with_one_subseed_per_image(self):
        a = self.worker("PC A")
        b = self.worker("PC B")
        status, payload = self.batch([a.id, b.id], 4, "vary-fleet-1", seed=77, subseed=500, subseed_strength=0.4)
        self.assertEqual(status, 202, payload)
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["seed_mode"], "variation")
        self.assertEqual([t["seed"] for t in done["tasks"]], [77] * 4)
        self.assertEqual([t["subseed"] for t in done["tasks"]], [500, 501, 502, 503])
        bodies = [c["body"] for c in a.forge_mock.calls + b.forge_mock.calls]
        self.assertEqual(sorted(x["subseed"] for x in bodies), [500, 501, 502, 503])
        self.assertTrue(all(x["seed"] == 77 and x["subseed_strength"] == 0.4 and x["n_iter"] == 1 for x in bodies))
        subs = sorted(G.get(self.root, i)["settings"]["subseed"] for i in self.gallery_ids())
        self.assertEqual(subs, [500, 501, 502, 503])

    def test_variation_leaves_out_old_workers_and_stays_off_private(self):
        cat = {"hashes": {MODEL: "a" * 64}, "vae": []}
        kept, excluded, _ = FL.parity_split({"checkpoint": MODEL, "subseed_strength": 0.3}, ["w1", "w2"],
                                            {"w1": {"hashes": {}, "vae": None}, "w2": cat}, {"w1": "PC-1"})
        self.assertEqual(kept, ["w2"])
        self.assertEqual(excluded[0]["message"], "PC-1 : pas encore \u00e0 jour pour les variations, exclu.")
        status, payload = self.post("/api/forge/batches", {"workers": ["w1"], "count": 2, "destination": "private",
                                                           "settings": dict(SETTINGS, subseed=1, subseed_strength=0.3)}, key="vary-private-1")
        self.assertEqual(status, 403)

    def test_cancel_drops_queued_and_defers_running_without_interrupt(self):
        a = self.worker("PC A", delay=1.0)
        status, payload = self.batch([a.id], 4, "cancel-key-1")
        batch_id = payload["batch"]["batch_id"]
        wait_for(lambda: a.forge_mock.active == 1)
        status, cancelled = self.post(f"/api/forge/batches/{batch_id}/cancel", {})
        self.assertEqual(status, 200)
        self.assertEqual((cancelled["dropped"], cancelled["deferred"]), (3, 1))
        done = self.finished(batch_id)
        self.assertEqual(done["counts"]["cancelled"], 3)
        self.assertEqual(done["counts"]["done"], 1)
        self.assertEqual(len(a.forge_mock.calls), 1)
        self.assertEqual(a.forge_mock.interrupts, 0)
        self.assertTrue(any(task["cancel_deferred"] for task in done["tasks"]))

    def test_private_is_refused_for_remote_and_prompt_never_reaches_workers(self):
        a = self.worker("PC A")
        secret_prompt = "prompt privé ultra confidentiel"
        status, payload = self.post("/api/forge/batches", {"workers": [a.id], "count": 1, "destination": "private",
                                                           "settings": dict(SETTINGS, prompt=secret_prompt)}, key="private-key-1")
        self.assertEqual((status, payload["code"]), (403, "private_remote"))
        status, payload = self.post("/api/forge/batches", {"workers": ["local", a.id], "count": 1, "destination": "private",
                                                           "settings": dict(SETTINGS, prompt=secret_prompt)}, key="private-key-2")
        self.assertEqual(status, 403)
        # The single-job private path never enters the fleet either (vault disabled here, so it is refused).
        status, _ = self.post("/api/forge/jobs", dict(SETTINGS, prompt=secret_prompt, destination="private"), key="private-key-3")
        self.assertIn(status, (401, 403, 409))
        time.sleep(0.4)
        self.assertEqual(a.forge_mock.calls, [])
        self.assertFalse(any(secret_prompt.encode() in body for body in a.forge_mock.bodies))
        batches = (self.root / ".hq-forge" / "batches.json")
        self.assertFalse(batches.exists() and secret_prompt in batches.read_text(encoding="utf-8"))

    def test_local_worker_uses_local_forge_and_shares_the_single_job_gate(self):
        import io
        local_calls = []
        gate = threading.Event()

        def transport(method, url, timeout, body=None):
            path = url.split("://", 1)[-1]
            path = path[path.find("/"):].split("?", 1)[0]
            if method == "POST":
                local_calls.append(json.loads(body))
                gate.wait(5)
                return 200, json.dumps({"images": [base64.b64encode(png_bytes()).decode()]}).encode()
            table = {
                "/sdapi/v1/samplers": [{"name": "Euler"}],
                "/sdapi/v1/schedulers": [{"name": "automatic", "label": "Automatic"}],
                "/sdapi/v1/upscalers": [{"name": "R-ESRGAN 4x+"}],
                "/sdapi/v1/sd-models": [{"title": MODEL, "model_name": "example", "hash": "abcd", "sha256": None}],
                "/sdapi/v1/options": {"sd_model_checkpoint": MODEL},
                "/sdapi/v1/progress": {"progress": 0, "state": {"job": "", "job_count": 0, "sampling_step": 0, "sampling_steps": 0}},
                "/internal/pending-tasks": {"size": 0, "tasks": []},
            }
            return (200, json.dumps(table[path]).encode()) if path in table else (404, b"{}")

        F.set_transport_for_tests(transport)
        wait_for(lambda: self.device("local")["state"] == "available")
        status, payload = self.batch(["local"], 2, "local-key-1")
        self.assertEqual(status, 202, payload)
        wait_for(lambda: len(local_calls) == 1)
        # While the batch holds the local Forge, the single-job path refuses a new job.
        status, refused = self.post("/api/forge/jobs", dict(SETTINGS), key="local-key-2")
        self.assertEqual((status, refused.get("code")), (409, "active"))
        gate.set()
        done = self.finished(payload["batch"]["batch_id"])
        self.assertEqual(done["counts"]["done"], 2)
        self.assertEqual([call["seed"] for call in local_calls], [1000, 1001])
        self.assertTrue(all(call["n_iter"] == 1 for call in local_calls))
        meta = G.get(self.root, self.gallery_ids()[0])
        self.assertEqual(meta["origin"]["worker_id"], "local")
        # Single-device generation still works unchanged once the batch is done.
        status, job = self.post("/api/forge/jobs", dict(SETTINGS), key="local-key-3")
        self.assertEqual(status, 202, job)
        job_id = job["job"]["job_id"]
        final = wait_for(lambda: (lambda p: p if p["job"]["state"] in J.TERMINAL else None)(self.admin.json(f"/api/forge/jobs/{job_id}")[1]))
        self.assertEqual(final["job"]["state"], "completed")

    # ------------------------------------------------------------------ Windows secret storage
    def _sddl(self, path: Path) -> str:
        out = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", f"(Get-Acl -LiteralPath '{path}').Sddl"],
                             capture_output=True, timeout=30, check=True)
        return out.stdout.decode("utf-8", "replace").strip()

    def _assert_protected(self, path: Path) -> None:
        sddl = self._sddl(path)
        dacl = sddl.split("D:", 1)[1]
        self.assertTrue(dacl.startswith("P") or dacl.startswith("PAI"), sddl)
        sids = set(re.findall(r";;;([^)]+)\)", dacl))
        user = W.current_user_sid()
        self.assertTrue(sids <= {"SY", "BA", "S-1-5-18", "S-1-5-32-544", user}, sddl)
        self.assertIn(user, sids)
        self.assertIsNone(re.search(r"\(A;[A-Z]*ID[A-Z]*;", dacl), "no inherited ACE: " + sddl)

    # ------------------------------------------------------------------ diagnostics (real telemetry only)
    def codes(self, worker_id: str) -> list[str]:
        return [d["code"] for d in self.device(worker_id)["diagnostics"]]

    def test_diagnostics_mapping_is_actionable_and_never_guesses(self):
        now = 1_000_000.0
        hw = {"gpus": [{"name": "RTX", "vram_mb": 8192}], "cpu": "CPU", "ram_mb": 16000}
        base = {"kind": "remote", "secret_ok": True, "disabled": False, "seen": now - 1, "online": True, "forge": "ready",
                "catalog_known": True, "own_task": False, "last_error": "", "hardware": hw}
        def run(**over):
            return FL.diagnose(dict(base, **over), now)
        self.assertEqual(run(), [])
        stale = run(seen=now - 600, online=False)
        self.assertEqual([d["code"] for d in stale], ["worker_stale"])
        self.assertIn("Le service worker ne r\u00e9pond plus depuis 10 min", stale[0]["title"])
        self.assertNotIn("Tailscale", stale[0]["title"], "a silent worker is not claimed to be a Tailscale outage")
        self.assertIn("pas forc\u00e9ment une panne Tailscale", stale[0]["action"])
        self.assertEqual([d["code"] for d in run(net={"since": int(now) - 120, "until": int(now) - 10})], ["network"])
        self.assertEqual(run(net={"since": int(now) - 9000, "until": int(now) - 7200}), [], "an old network spell is not shown")
        self.assertEqual([d["code"] for d in run(forge="offline")], ["forge_down"])
        self.assertEqual([d["code"] for d in run(forge="busy")], ["forge_busy"])
        self.assertEqual(run(forge="busy", own_task=True), [], "busy with our own task is not a problem")
        self.assertEqual([d["code"] for d in run(last_error="model_missing")], ["model_missing"])
        self.assertEqual([d["code"] for d in run(secret_ok=False)], ["secret_unprotected"])
        self.assertEqual([d["code"] for d in run(disabled=True)], ["disabled"])
        self.assertEqual([d["code"] for d in run(seen=0, online=False, hardware={})][:1], ["never_seen"])
        self.assertEqual([d["code"] for d in run(online=False, seen=now - 600, auth_fail_at=now - 5)], ["auth_refused", "worker_stale"])
        self.assertEqual([d["code"] for d in run(online=False, seen=now - 600, skew_at=now - 5)], ["clock_skew", "worker_stale"])
        self.assertEqual(run(auth_fail_at=now - 5), [], "a stray bad signature is ignored while the worker is healthy")
        unknown = run(hardware={"gpus": [{"name": "Iris", "vram_mb": None}], "cpu": None, "ram_mb": None})
        self.assertEqual([d["code"] for d in unknown], ["hardware_unknown"])
        self.assertIn("VRAM inconnue, CPU inconnu, RAM inconnue", unknown[0]["title"])
        for code in ("secret_unprotected", "auth_refused", "clock_skew", "disabled", "never_seen", "worker_stale", "network",
                     "forge_down", "forge_busy", "catalog_unknown", "model_missing", "hardware_unknown", "forge_timeout", "quota"):
            item = FL._diag(code, ago="1 min", span="2 min", fields="GPU inconnu")
            self.assertTrue(item["title"] and item["action"] and item["level"] in ("error", "warn", "info"), code)
        local = FL.diagnose({"kind": "local", "online": True, "seen": now, "forge": "offline", "catalog_known": False, "hardware": hw}, now)
        self.assertEqual([d["code"] for d in local], ["forge_down"])

    def test_live_diagnostics_from_worker_telemetry(self):
        down = self.worker("Sans Forge", start=False, mode="offline")
        down.start()
        self.assertEqual(down.forge_mock.mode, "offline")
        wait_for(lambda: "forge_down" in self.codes(down.id))
        busy = self.worker("Occup\u00e9", start=False, mode="busy")
        busy.worker.poll_once()
        self.assertEqual(self.codes(busy.id), ["forge_busy"])
        bare = self.worker("Sans pilote", start=False)
        bare.worker.hardware = {"gpus": [], "cpu": None, "ram_mb": None}
        bare.worker.poll_once()
        self.assertEqual(self.codes(bare.id), ["hardware_unknown"])

    def test_bad_signature_and_clock_skew_are_diagnosed_without_secrets(self):
        bad = self.worker("Refus\u00e9", start=False)
        bad.worker.poll_once()
        real_secret = bad.client.secret
        bad.client.secret = "0" * 64
        with self.assertRaises(W.HQError):
            bad.worker.poll_once()
        skew = self.worker("D\u00e9cal\u00e9", start=False)
        skew.worker.poll_once()
        orig = W.signed_headers
        with mock.patch.object(W, "signed_headers", lambda *a, **k: orig(*a, now=time.time() - 4000)):
            with self.assertRaises(W.HQError):
                skew.worker.poll_once()
        real = time.time
        FL.set_clock_for_tests(lambda: real() + FL.ONLINE_SEC + 5)
        try:
            self.assertEqual(self.codes(bad.id), ["auth_refused", "worker_stale"])
            self.assertEqual(self.codes(skew.id)[0], "clock_skew")
            raw = self.admin.req("/api/forge/devices")[2].decode("utf-8")
            self.assertNotIn(real_secret, raw)
        finally:
            FL.set_clock_for_tests(None)
        bad.client.secret = real_secret
        bad.worker.poll_once()
        self.assertNotIn("auth_refused", self.codes(bad.id), "a good signature clears the diagnosis")

    def test_network_report_is_backward_compatible_and_validated(self):
        sim = self.worker("R\u00e9seau", start=False)
        sim.worker.poll_once()  # no "net" field: an older worker
        self.assertEqual(self.codes(sim.id), [])
        stamp = int(time.time())
        for bad in ({"code": "hq_unreachable", "since": "x", "until": stamp}, {"code": "hq_unreachable", "since": stamp, "until": stamp + 9999},
                    {"code": "other", "since": stamp - 5, "until": stamp}, {"code": "hq_unreachable", "since": stamp, "until": stamp - 50}):
            sim.worker.net_report = bad
            sim.worker.poll_once()
            self.assertEqual(self.codes(sim.id), [], bad)
        sim.worker.net_report = {"code": "hq_unreachable", "since": stamp - 200, "until": stamp - 20}
        sim.worker.poll_once()
        diag = self.device(sim.id)["diagnostics"]
        self.assertEqual([d["code"] for d in diag], ["network"])
        self.assertIn("3 min", diag[0]["title"])

    def test_worker_records_an_hq_outage_and_reports_it_once_back(self):
        sim = self.worker("Coupure", start=False)
        real = sim.client.transport
        state = {"fails": 2}
        def flaky(*args, **kwargs):
            if state["fails"] > 0:
                state["fails"] -= 1
                raise ConnectionRefusedError("hq down")
            return real(*args, **kwargs)
        sim.client.transport = flaky
        sim.start()
        wait_for(lambda: "network" in self.codes(sim.id), timeout=20)
        report = sim.worker.net_report
        self.assertEqual(report["code"], "hq_unreachable")
        self.assertLessEqual(report["since"], report["until"])

    def test_copy_commands_never_include_the_pairing_code(self):
        js = (SOURCE / "assets" / "hq-forge.js").read_text(encoding="utf-8")
        for name in ("snippet", "runSnippet"):
            body = re.search(r"function " + name + r"\(\) \{(.*?)\n  \}", js, re.S).group(1)
            self.assertNotIn("forge-device-code", body)
            self.assertNotIn("code", body.lower().replace("encode", ""))
        copy = re.search(r"const copyTexts = \{([^}]*)\}", js).group(1)
        self.assertEqual(sorted(part.split(":")[0].strip() for part in copy.split(",")), ["pair", "run"])
        self.assertNotIn("localStorage.setItem(\"hqForgeCode", js)

    # ------------------------------------------------------------------ secret protection fails closed
    def _disk(self) -> str:
        folder = self.root / ".hq-forge"
        return "".join(p.read_text(encoding="utf-8", errors="replace") for p in sorted(folder.glob("*")) if p.is_file()) if folder.is_dir() else ""

    def test_test_plain_opt_in_needs_env_and_temp_root(self):
        self.code()  # binds the temp root
        self.assertTrue(FL._test_plain_allowed())
        with mock.patch.dict(os.environ, {FL.TEST_PLAIN_ENV: "0"}):
            self.assertFalse(FL._test_plain_allowed())
        saved = FL._root
        try:
            FL._root = SOURCE
            self.assertFalse(FL._test_plain_allowed(), "a non-temp root never allows plaintext")
            FL._root = Path(tempfile.gettempdir())
            self.assertFalse(FL._test_plain_allowed(), "the temp dir itself is not a test root")
        finally:
            FL._root = saved
        FL._wrap = True
        self.assertFalse(FL._test_plain_allowed(), "production mode never allows plaintext")

    def test_dpapi_failure_refuses_pairing_with_no_record_and_nothing_written(self):
        FL.reset_for_tests(wrap=True, lease_sec=5)
        code = self.code()
        before = (self.root / ".hq-forge" / "workers.json").read_bytes()
        with mock.patch.object(FL, "_dpapi", return_value=None):
            with self.assertRaises(W.HQError) as failed:
                W.pair(self.base, code, "PC A", dev=True, hardware={})
            self.assertEqual(failed.exception.status, 503)
            status, payload = self.admin.json("/api/forge/devices")
        self.assertEqual(status, 200)
        self.assertEqual([row["id"] for row in payload["devices"]], [FL.LOCAL_ID], "no worker record")
        self.assertEqual(payload["pending_codes"], 1, "the code is not consumed on failure")
        self.assertEqual((self.root / ".hq-forge" / "workers.json").read_bytes(), before, "nothing written")
        self.assertEqual(FL._live, {}, "no partial live state")
        self.assertNotRegex(self._disk(), r'"(test-)?plain"')
        # Non-Windows (or no DPAPI) without the opt-in also refuses: no implicit fallback.
        with mock.patch.object(FL.os, "name", "posix"):
            with self.assertRaises(FL.SecretProtectionError):
                FL._wrap_secret("ab" * 32)
        FL._wrap = False
        with mock.patch.dict(os.environ, {FL.TEST_PLAIN_ENV: ""}), mock.patch.object(FL, "_dpapi", return_value=None):
            with self.assertRaises(FL.SecretProtectionError):
                FL._wrap_secret("ab" * 32)
        FL._wrap = True
        if os.name == "nt":  # the same code still pairs once DPAPI works
            sim = SimWorker(self.base, code, "PC A", self.forges.append(MockForge()) or self.forges[-1])
            self.workers.append(sim)
            self.assertIn('"dpapi"', self._disk())
            self.assertNotIn(sim.creds["secret"], self._disk())

    def test_legacy_plaintext_record_is_rejected_never_converted_or_echoed(self):
        sim = self.worker("PC ancien", start=False)
        secret = sim.creds["secret"]
        path = self.root / ".hq-forge" / "workers.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["workers"][0]["secret"] = {"kind": "plain", "value": secret}
        path.write_text(json.dumps(data), encoding="utf-8")
        legacy = path.read_bytes()
        FL.reset_for_tests(lease_sec=5)  # next request reloads the legacy file from disk
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            with self.assertRaises(W.HQError) as refused:
                sim.worker.poll_once()
            self.assertEqual(refused.exception.status, 401)
            status, _h, raw = self.admin.req("/api/forge/devices")
            card = self.device(sim.id)
            batch_status, batch = self.batch([sim.id], 1, "legacy-1")
        self.assertEqual(status, 200)
        self.assertEqual(card["state"], "error")
        self.assertEqual(card["last_error"], "secret_unprotected")
        self.assertIn("Secret non prot\u00e9g\u00e9", card["last_error_label"])
        self.assertIn("r\u00e9associer", card["last_error_label"])
        self.assertNotEqual(batch_status, 200, batch)
        self.assertEqual(path.read_bytes(), legacy, "the legacy record is not silently converted")
        text = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
        self.assertNotIn(secret, text + json.dumps(batch) + out.getvalue() + err.getvalue())
        for file in self.root.rglob("*"):
            if file.is_file() and file != path and file.suffix in (".json", ".log", ".txt", ".jsonl"):
                self.assertNotIn(secret, file.read_text(encoding="utf-8", errors="replace"), str(file))

    @unittest.skipUnless(os.name == "nt", "DPAPI and DACLs are Windows-only")
    def test_windows_worker_secret_is_dpapi_wrapped_and_files_are_protected(self):
        FL.reset_for_tests(acl=True, wrap=True, lease_sec=5)
        sim = self.worker("PC A", start=False)
        registry = self.root / ".hq-forge" / "workers.json"
        text = registry.read_text(encoding="utf-8")
        self.assertNotIn(sim.creds["secret"], text)
        self.assertIn('"dpapi"', text)
        self.assertIsNone(sim.worker.poll_once())  # HMAC still verifies through the wrapped secret
        self._assert_protected(registry)
        creds = Path(self.tmp) / "creds" / "forge-worker.json"
        state = W.save_credentials(creds, sim.creds)
        self.assertEqual(state, "restricted")
        self._assert_protected(creds)


if __name__ == "__main__":
    unittest.main()
