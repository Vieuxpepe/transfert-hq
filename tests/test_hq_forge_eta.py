"""F4: ETA from Forge progress and the usual duration per settings bucket. Mock Forge only."""

from __future__ import annotations

import json
import math
import sys
import tempfile
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(SOURCE / "tests"))

import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
from test_hq_forge_jobs import Transport, _body, _png_b64  # noqa: E402


class EtaSanitizer(unittest.TestCase):
    def test_bad_values_are_hidden(self):
        for value in (float("nan"), float("inf"), -float("inf"), -5, 0, 0.0, 3600.5, 1e12, True, "25", None, [], {}):
            self.assertIsNone(F.eta_seconds({"eta_relative": value}), value)
        self.assertIsNone(F.eta_seconds(None))
        self.assertIsNone(F.eta_seconds({}))

    def test_good_values_pass(self):
        self.assertEqual(F.eta_seconds({"eta_relative": 25.04}), 25.0)
        self.assertEqual(F.eta_seconds({"eta_relative": 3600}), 3600.0)
        self.assertEqual(F.eta_seconds({"eta_relative": 0.2}), 0.2)


class JobEta(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        J.set_poll_interval_for_tests(0.03)

    def tearDown(self) -> None:
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def _slow(self, eta, delay=0.4):
        running = {"progress": 0.5, "eta_relative": eta, "state": {"job_count": 1, "sampling_step": 5, "sampling_steps": 10}}
        holder = {}

        def post(_body):
            holder["t"].progress = running  # Forge reports progress only once the job is in
            time.sleep(delay)
            holder["t"].progress = {"progress": 0, "eta_relative": 0, "state": {"job_count": 0, "sampling_step": 0, "sampling_steps": 0}}
            return 200, json.dumps({"images": [_png_b64()], "info": json.dumps({"all_seeds": [1]})}).encode("utf-8")
        holder["t"] = Transport(post=post, progress={"progress": 0, "eta_relative": 0, "state": {"job_count": 0, "sampling_step": 0, "sampling_steps": 0}})
        return holder["t"]

    def _watch(self, job_id):
        seen = []
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _c, payload = J.get_job(self.root, job_id)
            seen.append(payload["job"])
            if payload["job"]["state"] in J.TERMINAL:
                return seen
            time.sleep(0.02)
        self.fail(seen[-1])

    def test_eta_is_shown_while_running_and_cleared_after(self):
        code, created = J.create_job(self.root, _body(), "eta-key-good", transport=self._slow(25))
        self.assertEqual(code, 202)
        seen = self._watch(created["job"]["job_id"])
        self.assertIn(25.0, [job["eta"] for job in seen if job["state"] == "generating"])
        self.assertIsNone(seen[-1]["eta"])

    def test_nan_negative_and_absurd_eta_never_reach_the_client(self):
        for index, value in enumerate((float("nan"), -12, 10**9)):
            J.reset_for_tests()
            J.set_poll_interval_for_tests(0.03)
            code, created = J.create_job(self.root, _body(), f"eta-key-bad-{index}", transport=self._slow(value))
            self.assertEqual(code, 202)
            seen = self._watch(created["job"]["job_id"])
            self.assertTrue(all(job["eta"] is None for job in seen), value)
            raw = (self.root / ".hq-forge" / "jobs.json").read_text(encoding="utf-8")
            self.assertNotIn("NaN", raw)
            self.assertNotIn("Infinity", raw)


class UsualDuration(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def _query(self, **extra):
        q = {"width": 512, "height": 512, "steps": 8, "hires": 0, "n_iter": 1}
        q.update(extra)
        return J.serve_get(self.root, "/api/forge/jobs/durations", "&".join(f"{k}={v}" for k, v in q.items()))

    def test_needs_three_samples_then_returns_the_median(self):
        settings = {"width": 512, "height": 512, "steps": 8, "enable_hr": False, "n_iter": 1}
        token = J._generation
        J._record_duration(self.root, settings, 30.0, token)
        J._record_duration(self.root, settings, 50.0, token)
        self.assertEqual(self._query(), (200, {"samples": 2, "seconds": None}))
        J._record_duration(self.root, settings, 40.0, token)
        self.assertEqual(self._query(), (200, {"samples": 3, "seconds": 40}))
        self.assertEqual(self._query(n_iter=2)[1]["seconds"], 80)
        self.assertEqual(self._query(steps=9)[1], {"samples": 0, "seconds": None})
        self.assertEqual(self._query(hires=1)[1]["samples"], 0)

    def test_keeps_only_the_last_twenty(self):
        settings = {"width": 512, "height": 512, "steps": 8, "enable_hr": False, "n_iter": 2}
        for index in range(30):
            J._record_duration(self.root, settings, float(index + 1) * 2, J._generation)
        data = json.loads((self.root / ".hq-forge" / "jobs.json").read_text(encoding="utf-8"))
        self.assertEqual(len(data["durations"]["512x512:8:base"]), 20)
        self.assertEqual(data["durations"]["512x512:8:base"][0], 11.0, "per-image seconds of the 11th sample")

    def test_absurd_durations_and_bad_queries_are_refused(self):
        settings = {"width": 512, "height": 512, "steps": 8, "enable_hr": False, "n_iter": 1}
        for value in (float("nan"), -1.0, 0.0, 10**7):
            J._record_duration(self.root, settings, value, J._generation)
        self.assertEqual(self._query()[1]["samples"], 0)
        self.assertEqual(J.serve_get(self.root, "/api/forge/jobs/durations", "width=x&height=512&steps=8")[0], 400)
        self.assertEqual(J.serve_get(self.root, "/api/forge/jobs/durations", "width=512&height=512&steps=0")[0], 400)

    def test_completed_normal_jobs_record_and_private_jobs_do_not(self):
        J.set_poll_interval_for_tests(0.05)
        transport = Transport()
        code, created = J.create_job(self.root, _body(), "dur-key-normal", transport=transport)
        self.assertEqual(code, 202)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and J.get_job(self.root, created["job"]["job_id"])[1]["job"]["state"] not in J.TERMINAL:
            time.sleep(0.05)
        time.sleep(0.1)
        data = json.loads((self.root / ".hq-forge" / "jobs.json").read_text(encoding="utf-8"))
        self.assertEqual(len(data.get("durations", {}).get("512x512:8:base", [])), 1)
        self.assertNotIn("a red circle", json.dumps(data.get("durations")))

    def test_durations_survive_other_job_writes(self):
        settings = {"width": 512, "height": 512, "steps": 8, "enable_hr": False, "n_iter": 1}
        for value in (10.0, 11.0, 12.0):
            J._record_duration(self.root, settings, value, J._generation)
        J.recover(self.root)
        J.cancel_job(self.root, "job-" + "0" * 24)
        self.assertEqual(self._query()[1]["samples"], 3)
        self.assertTrue(math.isfinite(self._query()[1]["seconds"]))


if __name__ == "__main__":
    unittest.main()
