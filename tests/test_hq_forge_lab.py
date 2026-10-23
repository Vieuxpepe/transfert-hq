"""Phase B: Laboratoire views (speed, reliability, keep rate) and their honesty rules."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_lab as L  # noqa: E402
import hq_forge_stats as S  # noqa: E402


def row(i: int, **over) -> dict:
    base = {"kind": "batch", "outcome": "completed", "device_id": "w1", "device_name": "PC salon", "checkpoint": "ckpt-a",
            "sampler_name": "Euler a", "scheduler": "Automatic", "steps": 20, "width": 512, "height": 512, "hires": False,
            "cfg_scale": 7.0, "duration_s": 10.0 + (i % 5), "image_id": "img-" + format(i, "024x"), "attempt": 1, "count": 1}
    base.update(over)
    return S.clean(base)


class Lab(unittest.TestCase):
    def test_under_the_threshold_nothing_is_compared(self):
        groups = L.speed([row(i) for i in range(L.MIN_SAMPLES - 1)])
        item = groups[0]["rows"][0]
        self.assertFalse(item["enough"])
        self.assertIsNone(item["median_s"])
        self.assertEqual(item["samples"], L.MIN_SAMPLES - 1)

    def test_speed_is_grouped_by_comparable_checkpoint_size_and_hires(self):
        rows = [row(i) for i in range(20)] + [row(i, device_name="Portable", device_id="w2", duration_s=30.0) for i in range(20)]
        rows += [row(i, checkpoint="ckpt-b") for i in range(20)] + [row(i, width=768, height=768) for i in range(20)]
        groups = L.speed(rows)
        self.assertEqual(len(groups), 3)
        first = next(g for g in groups if g["checkpoint"] == "ckpt-a" and g["width"] == 512)
        self.assertEqual([r["device"] for r in first["rows"]], ["PC salon", "Portable"])
        self.assertEqual(first["rows"][0]["median_s"], 12.0)
        self.assertEqual(first["rows"][1]["median_s"], 30.0)
        self.assertEqual(first["rows"][0]["settings"], {"width": 512, "height": 512, "steps": 20, "sampler_name": "Euler a",
                                                        "checkpoint": "ckpt-a", "scheduler": "Automatic", "cfg_scale": 7.0})

    def test_reliability_counts_outcomes_and_names_errors_without_guessing(self):
        rows = [row(i) for i in range(17)] + [row(17, outcome="failed", error="forge_oom", duration_s=None),
                                               row(18, outcome="failed", error="forge_oom", duration_s=None),
                                               row(19, outcome="uncertain", error="forge_timeout", duration_s=None)]
        item = L.reliability(rows)[0]["rows"][0]
        self.assertEqual((item["samples"], item["completed"], item["failed"], item["uncertain"], item["enough"]), (20, 17, 2, 1, True))
        self.assertEqual(item["errors"][0], {"code": "forge_oom", "count": 2})
        self.assertNotIn("cause", json.dumps(item))

    def test_keep_rate_only_counts_sorted_images(self):
        rows = [row(i) for i in range(30)]
        flags = {r["image_id"]: ("keep" if i < 12 else "favorite" if i < 15 else "reject" if i < 22 else "none") for i, r in enumerate(rows)}
        item = L.keep_rate(rows, flags)[0]["rows"][0]
        self.assertEqual((item["samples"], item["kept"], item["favorite"], item["rejected"], item["enough"]), (22, 15, 3, 7, True))
        few = L.keep_rate(rows[:10], flags)[0]["rows"][0]
        self.assertFalse(few["enough"])

    def test_confounded_settings_are_named(self):
        rows = [row(i) for i in range(5)] + [row(i, device_name="Portable", checkpoint="ckpt-b") for i in range(5)]
        rows += [row(i, device_name="PC salon", checkpoint="ckpt-b") for i in range(5)]
        found = L.confounded(rows)
        self.assertIn({"kind": "device", "value": "Portable", "with_kind": "checkpoint", "with": "ckpt-b"}, found)
        self.assertFalse(any(f["kind"] == "device" and f["value"] == "PC salon" and f["with_kind"] == "checkpoint" for f in found))

    def test_summary_reads_only_stats_without_prompts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for i in range(3):
                S.record(root, dict(row(i), prompt="zq-lab-prompt", negative_prompt="zq-lab-neg"))
            S.record(root, dict(row(9), kind="private"))
            data = L.summary(root)
            self.assertEqual(data["records"], 3)
            self.assertTrue(data["vault_excluded"])
            self.assertEqual(data["min_samples"], 20)
            self.assertNotIn("zq-lab", json.dumps(data))
            self.assertEqual(L.summary(Path(tmp) / "missing")["speed"], [])


if __name__ == "__main__":
    unittest.main()