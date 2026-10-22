"""Phase A: statistics records (no prompt, no vault) and the reversible triage flag."""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge as F  # noqa: E402
import hq_forge_gallery as G  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import hq_forge_stats as S  # noqa: E402
from test_hq_forge_jobs import Transport, _body, _png_b64  # noqa: E402

PROMPT = "zq-stats-prompt-4471"


class Stats(unittest.TestCase):
    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        J.set_poll_interval_for_tests(0.05)
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        J.reset_for_tests()
        F.reset_for_tests()
        self.tmp.cleanup()

    def _wait(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = J.get_job(self.root, job_id)[1]["job"]
            if job["state"] in J.TERMINAL:
                return job
            time.sleep(0.05)
        self.fail("timeout")

    def test_clean_keeps_only_known_technical_fields(self):
        row = S.clean({"outcome": "completed", "prompt": PROMPT, "negative_prompt": "x", "steps": 8, "width": True,
                       "checkpoint": "a" * 300, "duration_s": float("nan"), "attempt": 2})
        self.assertEqual(row, {"outcome": "completed", "steps": 8, "attempt": 2})
        self.assertIsNone(S.clean({"outcome": "bogus"}))

    def test_missing_or_corrupt_store_reads_as_empty_and_is_capped(self):
        self.assertEqual(S.records(self.root), [])
        (self.root / ".hq-forge").mkdir()
        (self.root / ".hq-forge" / "stats.json").write_text("{not json", encoding="utf-8")
        self.assertEqual(S.records(self.root), [])
        (self.root / ".hq-forge" / "stats.json").write_text(json.dumps({"records": [{"outcome": "completed", "old": 1}, "junk"]}), encoding="utf-8")
        self.assertEqual(S.records(self.root), [{"outcome": "completed"}])
        saved = S.MAX_RECORDS
        S.MAX_RECORDS = 3
        try:
            for i in range(5):
                S.record(self.root, {"outcome": "failed", "steps": i + 1})
        finally:
            S.MAX_RECORDS = saved
        self.assertEqual([r["steps"] for r in S.records(self.root)], [3, 4, 5])

    def test_normal_job_records_settings_duration_and_outcome_without_prompt(self):
        def post(body):
            return 200, json.dumps({"images": [_png_b64(), _png_b64()], "info": json.dumps({"all_seeds": [7, 8]})}).encode()
        code, payload = J.create_job(self.root, _body(prompt=PROMPT, n_iter=2, seed=7), "stats-key-1", transport=Transport(post=post))
        self.assertEqual(code, 202)
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual(job["state"], "completed")
        rows = S.records(self.root)
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual((row["kind"], row["device_id"], row["outcome"], row["attempt"]), ("job", "local", "completed", 1))
            self.assertEqual((row["checkpoint"], row["sampler_name"], row["steps"], row["width"], row["height"], row["hires"]),
                             ("example.safetensors [abcd]", "Euler", 8, 512, 512, False))
            self.assertIn("duration_s", row)
            self.assertEqual(row["job_id"], job["job_id"])
        self.assertEqual(sorted(r["image_id"] for r in rows), sorted(i["id"] for i in job["images"]))
        raw = (self.root / ".hq-forge" / "stats.json").read_text(encoding="utf-8")
        self.assertNotIn(PROMPT, raw)
        self.assertNotIn("blur", raw, "the negative prompt is not stored either")
        stored = json.loads((self.root / ".hq-forge" / "jobs.json").read_text(encoding="utf-8"))["jobs"][-1]
        self.assertTrue(stored["started_at"] and stored["finished_at"])
        self.assertIsInstance(stored["duration_ms"], int)

    def test_failures_are_recorded_and_memory_errors_are_named(self):
        def oom(body):
            return 500, json.dumps({"error": "OutOfMemoryError", "detail": "", "errors": "CUDA out of memory " + PROMPT}).encode()
        _code, payload = J.create_job(self.root, _body(prompt=PROMPT), "stats-key-2", transport=Transport(post=oom))
        job = self._wait(payload["job"]["job_id"])
        self.assertEqual((job["state"], job["error"]), ("failed", "forge_oom"))
        self.assertIn("m\u00e9moire", job["message"])
        _code, payload = J.create_job(self.root, _body(), "stats-key-3", transport=Transport(fail_post=TimeoutError()))
        self._wait(payload["job"]["job_id"])
        rows = S.records(self.root)
        self.assertEqual([(r["outcome"], r.get("error"), r.get("uncertain")) for r in rows],
                         [("failed", "forge_oom", False), ("uncertain", "forge_timeout", True)])
        self.assertNotIn("CUDA out of memory", (self.root / ".hq-forge" / "stats.json").read_text(encoding="utf-8"))

    def test_memory_error_detection_reads_only_the_exception_name(self):
        import hq_forge_worker as W
        for fn in (F.oom_error, W._oom):
            self.assertTrue(fn(b'{"error": "OutOfMemoryError", "errors": "x"}'))
            self.assertFalse(fn(b'{"error": "RuntimeError", "errors": "CUDA out of memory"}'), "no guessing from free text")
            self.assertFalse(fn(b"<html>"))

    def test_old_jobs_and_images_without_new_fields_stay_readable(self):
        (self.root / ".hq-forge").mkdir()
        old = {"jobs": [{"id": "job-" + "a" * 24, "task_id": "task(hq-" + "b" * 24 + ")", "state": "completed",
                         "created": "2026-01-01T00:00:00Z", "destination": "normal", "settings": {}, "images": []}],
               "idempotency": {}}
        (self.root / ".hq-forge" / "jobs.json").write_text(json.dumps(old), encoding="utf-8")
        J._recovered = True
        code, payload = J.get_job(self.root, "job-" + "a" * 24)
        self.assertEqual((code, payload["job"]["state"]), (200, "completed"))
        from PIL import Image
        import base64
        image = G.store(self.root, base64.b64decode(_png_b64()), {"prompt": "p", "checkpoint": "c", "sampler_name": "s", "scheduler": "a",
                                                                   "width": 256, "height": 256, "steps": 4, "n_iter": 1, "batch_size": 1, "seed": 1, "cfg_scale": 7})
        self.assertEqual(G.get(self.root, image["id"])["triage"], "none")

    def test_triage_is_reversible_and_reject_only_hides(self):
        import base64
        settings = {"prompt": "p", "checkpoint": "c", "sampler_name": "s", "scheduler": "a", "width": 256, "height": 256,
                    "steps": 4, "n_iter": 1, "batch_size": 1, "seed": 1, "cfg_scale": 7}
        ids = [G.store(self.root, base64.b64decode(_png_b64()), settings)["id"] for _ in range(3)]
        self.assertEqual(G.set_triage(self.root, ids[0], "reject")["previous"], "none")
        G.set_triage(self.root, ids[1], "favorite")
        self.assertNotIn(ids[0], [i["id"] for i in G.page(self.root)["images"]])
        self.assertEqual([i["id"] for i in G.page(self.root, view="trash")["images"]], [ids[0]])
        self.assertEqual([i["id"] for i in G.page(self.root, view="untriaged")["images"]], [ids[2]])
        self.assertTrue((G.gallery_dir(self.root) / ids[0] / "original.png").exists(), "rejected is not deleted")
        G.set_triage(self.root, ids[0], "none")
        self.assertIn(ids[0], [i["id"] for i in G.page(self.root)["images"]])
        self.assertEqual(G.triage_map(self.root)[ids[1]], "favorite")
        with self.assertRaises(G.GalleryError):
            G.set_triage(self.root, ids[1], "trash")
        with self.assertRaises(G.GalleryError):
            G.set_triage(self.root, "img-" + "0" * 24, "keep")


if __name__ == "__main__":
    unittest.main()
