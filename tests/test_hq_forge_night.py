"""Phase G night workshop: normal mode only, idle-aware, never interrupts. Temp roots, mock Forge only."""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge as F  # noqa: E402
import hq_forge_gallery as G  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_night as N  # noqa: E402
from test_hq_forge_jobs import Transport, _body  # noqa: E402
import test_hq_forge_fleet as TF  # noqa: E402

BUSY = {"progress": 0.5, "state": {"job": "owner", "job_count": 1, "sampling_step": 3, "sampling_steps": 20}}


def at(hour: int, minute: int = 0, day: int = 22) -> float:
    return datetime(2026, 10, day, hour, minute).timestamp()


class Clock:
    def __init__(self, epoch: float):
        self.now = epoch

    def __call__(self):
        return self.now


def settings(**extra):
    body = _body(**extra)
    for key in ("n_iter", "batch_size"):
        body.pop(key, None)
    return body


class Night(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        J.set_poll_interval_for_tests(0.05)
        N.disable_thread_for_tests()
        self.clock = Clock(at(23))
        N.set_clock_for_tests(self.clock)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        N.set_clock_for_tests(None)
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def add(self, when="tonight", **extra):
        status, payload = N.add(self.root, {"when": when, "settings": settings(**extra)})
        self.assertEqual(status, 201, payload)
        return payload["entry"]["id"]

    def run_until(self, transport, wanted="done", timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            N.tick(self.root, transport=transport)
            entries = N.state(self.root)[1]["entries"]
            if entries and all(e["state"] in N.TERMINAL for e in entries):
                return entries
            time.sleep(0.05)
        self.fail(N.state(self.root)[1])

    def stored(self) -> str:
        path = self.root / ".hq-forge" / "night.json"
        return path.read_text(encoding="utf-8") if path.exists() else ""

    def test_private_is_never_queued_and_leaves_nothing(self):
        for body in ({"when": "tonight", "destination": "private", "settings": settings(prompt="secret coffre")},
                     {"when": "idle", "private": True, "settings": settings(prompt="secret coffre")}):
            status, payload = N.add(self.root, body)
            self.assertEqual((status, payload["code"]), (403, "private"))
            self.assertIn("jamais mises en file", payload["error"])
        self.assertNotIn("secret coffre", self.stored())
        self.assertEqual(N.state(self.root)[1]["entries"], [])
        # A queued entry is always sent as a normal job, whatever its settings say.
        self.add(prompt="normal", destination="private")
        self.assertNotIn('"destination"', self.stored())

    def test_validation_and_queue_cap(self):
        for body in ({"when": "later", "settings": settings()}, {"when": "idle", "settings": settings(prompt=" ")},
                     {"when": "idle", "settings": settings(checkpoint="")}, {"when": "idle"}, []):
            self.assertEqual(N.add(self.root, body)[0], 400)
        for index in range(N.QUEUE_MAX):
            self.add(prompt=f"p{index}")
        status, payload = N.add(self.root, {"when": "idle", "settings": settings()})
        self.assertEqual((status, payload["code"]), (409, "full"))

    def test_tonight_waits_for_the_window_then_runs_and_summarises_once(self):
        self.clock.now = at(15)
        self.add("tonight", prompt="phare de nuit")
        transport = Transport(progress={"progress": 0, "state": {"job": "", "job_count": 0}})
        self.assertEqual(N.tick(self.root, transport=transport), "idle")
        self.assertFalse(any(u.endswith("/txt2img") for u in transport.calls))
        self.clock.now = at(23, 30)
        entries = self.run_until(transport)
        self.assertEqual(entries[0]["state"], "done")
        self.assertEqual(len(entries[0]["images"]), 1)
        summary = N.state(self.root)[1]["summary"]
        self.assertEqual(summary["counts"]["done"], 1)
        self.assertEqual(summary["images"], entries[0]["images"])
        self.assertEqual(N.ack(self.root)[0], 200)
        self.assertIsNone(N.state(self.root)[1]["summary"], "shown once, then quiet")
        self.assertFalse(any("interrupt" in u or "/sdapi/v1/skip" in u for u in transport.calls))

    def test_busy_forge_or_gpu_means_wait_never_interrupt(self):
        self.add("idle", prompt="quand libre")
        busy = Transport(progress=BUSY)
        for _ in range(3):
            self.assertEqual(N.tick(self.root, transport=busy), "wait")
        self.assertFalse(any(u.endswith("/txt2img") for u in busy.calls))
        self.assertFalse(any("interrupt" in u or "/sdapi/v1/skip" in u for u in busy.calls))
        self.assertEqual(N.state(self.root)[1]["entries"][0]["state"], "queued")
        # A fleet task on the local GPU (GPU sharing) holds it too.
        J.set_external_busy(lambda: True)
        try:
            self.assertEqual(N.tick(self.root, transport=Transport(progress={"progress": 0, "state": {"job": "", "job_count": 0}})), "wait")
        finally:
            J.set_external_busy(None)
        entries = self.run_until(Transport(progress={"progress": 0, "state": {"job": "", "job_count": 0}}))
        self.assertEqual(entries[0]["state"], "done")

    def test_window_end_and_night_budget_expire_the_rest(self):
        self.clock.now = at(23)
        self.add("tonight", prompt="trop tard")
        self.clock.now = at(7, 1, day=23)
        N.tick(self.root, transport=Transport(progress=BUSY))
        entry = N.state(self.root)[1]["entries"][0]
        self.assertEqual((entry["state"], entry["message"]), ("expired", N.MESSAGES["expired_window"]))
        self.clock.now = at(22, 30, day=23)
        self.add("idle", prompt="budget")
        data = N._load(self.root)
        data["night_started"] = self.clock.now - N.NIGHT_MAX_SEC - 1
        N._save(self.root, data)
        N.tick(self.root, transport=Transport(progress=BUSY))
        last = N.state(self.root)[1]["entries"][-1]
        self.assertEqual((last["state"], last["message"]), ("expired", N.MESSAGES["expired_budget"]))
        self.assertEqual(N.state(self.root)[1]["summary"]["counts"]["expired"], 2)

    def test_cancel_only_before_sending(self):
        first = self.add("idle", prompt="un")
        second = self.add("idle", prompt="deux")
        third = self.add("idle", prompt="trois")
        self.assertEqual(N.cancel(self.root, second), (200, {"cancelled": 1}))
        self.assertEqual(N.cancel(self.root, "nt-" + "0" * 24)[0], 404)
        hold = Transport(progress={"progress": 0, "state": {"job": "", "job_count": 0}}, post=lambda body: (time.sleep(0.6), (200, json.dumps({"images": [], "info": "{}"}).encode()))[1])
        self.assertEqual(N.tick(self.root, transport=hold), "started")
        status, payload = N.cancel(self.root, first)
        self.assertEqual((status, payload["code"]), (409, "not_queued"))
        self.assertEqual(N.cancel(self.root, None), (200, {"cancelled": 1}))
        states = {e["id"]: e["state"] for e in N.state(self.root)[1]["entries"]}
        self.assertEqual((states[second], states[third]), ("cancelled", "cancelled"))
        self.assertFalse(any("interrupt" in u or "/sdapi/v1/skip" in u for u in hold.calls))

    def test_finish_all_kept_queues_a_hires_finish_per_kept_image(self):
        self.add("idle", prompt="brouillon")
        entries = self.run_until(Transport(progress={"progress": 0, "state": {"job": "", "job_count": 0}}))
        image_id = entries[0]["images"][0]
        self.assertEqual(N.finish_kept(self.root, {"when": "idle", "scale": 2.0, "upscaler": "R-ESRGAN 4x+"})[1]["code"], "none_kept")
        G.set_triage(self.root, image_id, "keep")
        self.assertEqual(N.finish_kept(self.root, {"when": "idle", "scale": 3, "upscaler": "R-ESRGAN 4x+"})[0], 400)
        status, payload = N.finish_kept(self.root, {"when": "tonight", "scale": 1.5, "upscaler": "R-ESRGAN 4x+"})
        self.assertEqual((status, payload["added"]), (201, 1))
        entry = N._load(self.root)["entries"][-1]
        self.assertEqual((entry["kind"], entry["finish_of"]), ("finish", image_id))
        self.assertEqual((entry["settings"]["enable_hr"], entry["settings"]["hr_scale"], entry["settings"]["denoising_strength"]), (True, 1.5, 0.4))
        self.assertEqual(N.finish_kept(self.root, {"when": "idle", "scale": 2.0, "upscaler": "R-ESRGAN 4x+"})[1]["code"], "none_kept", "not queued twice")
        done = self.run_until(Transport(progress={"progress": 0, "state": {"job": "", "job_count": 0}}))
        finish = [e for e in done if e["kind"] == "finish"][0]
        self.assertEqual(finish["state"], "done", finish)
        self.assertEqual(G.get(self.root, finish["images"][0])["origin"]["finish_of"], image_id)


class NightHttp(TF.FleetHttp):
    def test_night_routes_are_admin_csrf_with_404s(self):
        body = {"when": "idle", "settings": dict(TF.SETTINGS)}
        N.disable_thread_for_tests()
        for path, payload in (("/api/forge/night", body), ("/api/forge/night/ack", {}), ("/api/forge/night/cancel-all", {}),
                              ("/api/forge/night/finish-kept", {"when": "idle", "scale": 2.0, "upscaler": "x"}),
                              ("/api/forge/night/nt-" + "0" * 24 + "/cancel", {})):
            with self.subTest(path=path):
                self.assertEqual(self.post(path, payload, client=self.anon)[0], 401)
                self.assertEqual(self.post(path, payload, client=self.upload)[0], 403)
                status, _h, _b = self.admin.req(path, "POST", json.dumps(payload).encode(), {"Origin": "http://evil.example", "Content-Type": "application/json"}, origin=False)
                self.assertEqual(status, 403)
        self.assertEqual(self.anon.json("/api/forge/night")[0], 401)
        self.assertEqual(self.upload.json("/api/forge/night")[0], 403)
        self.assertEqual(self.post("/api/forge/night/nt-" + "0" * 24 + "/cancel", {})[0], 404)
        self.assertEqual(self.post("/api/forge/night/not-an-id/cancel", {})[0], 404)
        self.assertEqual(self.post("/api/forge/night/other", {})[0], 404)
        self.assertEqual(N.state(B_root(self))[1]["entries"], [], "no refused call stored anything")
        status, payload = self.post("/api/forge/night", body)
        self.assertEqual(status, 201, payload)
        status, payload = self.admin.json("/api/forge/night")
        self.assertEqual((status, len(payload["entries"])), (200, 1))
        status, payload = self.post("/api/forge/night", dict(body, destination="private"))
        self.assertEqual(status, 403)


def B_root(case):
    return TF.B.ROOT


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(Night))
    suite.addTest(NightHttp("test_night_routes_are_admin_csrf_with_404s"))
    return suite


if __name__ == "__main__":
    unittest.main()