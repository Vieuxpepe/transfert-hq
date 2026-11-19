"""FPS stats regression: idle tail must not deflate reported FPS."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from hq_perf_fps_stats import compute_frame_metrics  # noqa: E402


class HqPerfFpsStatsTests(unittest.TestCase):
    def test_synthetic_60hz_four_second_sample(self):
        """237 rAF ticks ~16.7 ms apart; 15 s idle must not change FPS."""
        start = 1000.0
        dt = 1000.0 / 60.0
        frames = [start + i * dt for i in range(237)]
        sample_elapsed = 4000.0
        wall_elapsed = 4000.0 + 15000.0
        m = compute_frame_metrics(frames, sample_elapsed_ms=sample_elapsed, wall_elapsed_ms=wall_elapsed)
        self.assertAlmostEqual(m["fps"], 60.0, delta=1.5)
        self.assertAlmostEqual(m["p95GapMs"], dt, delta=0.5)
        self.assertEqual(m["gapsOver50ms"], 0)
        self.assertAlmostEqual(m["fpsLegacyIncludingIdle"], 12.5, delta=0.2)
        self.assertGreater(m["fps"], m["fpsLegacyIncludingIdle"] * 4)

    def test_burst_with_rare_long_pauses(self):
        """Low duty-cycle rAF: legacy wall FPS and interval FPS diverge for real reasons."""
        frames = [0.0, 16.0, 32.0, 2032.0, 2048.0, 2064.0]
        m = compute_frame_metrics(frames, sample_elapsed_ms=2100.0, wall_elapsed_ms=2100.0)
        self.assertEqual(m["gapsOver50ms"], 1)
        self.assertGreater(m["maxGapMs"], 1900.0)
        self.assertLess(m["fps"], 10.0)

    def test_empty_frames(self):
        m = compute_frame_metrics([], sample_elapsed_ms=1000.0)
        self.assertEqual(m["fps"], 0.0)
        self.assertEqual(m["rafCallbacks"], 0)


if __name__ == "__main__":
    unittest.main()