"""Static checks for hq-motion-coordinator.js (shared animation tier + budgets)."""
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
JS = ROOT / "assets" / "hq-motion-coordinator.js"
BRIDGE = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")


class MotionCoordinator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = JS.read_text(encoding="utf-8")

    def test_file_exists(self):
        self.assertTrue(JS.is_file())

    def test_exports_api(self):
        for name in (
            "tier",
            "setMode",
            "live2dMinGap",
            "companionLive2dShouldRun",
            "dangleShouldRun",
            "homeEffectsPaused",
            "noteCost",
        ):
            self.assertIn(name + ":", self.src, name)

    def test_modes_and_storage(self):
        self.assertIn('hq-motion-mode', self.src)
        self.assertRegex(self.src, r'mode === "lite"')
        self.assertRegex(self.src, r'mode === "smooth"')

    def test_auto_lite_from_ema(self):
        self.assertIn("emaLive2d", self.src)
        self.assertIn("emaDangle", self.src)
        self.assertIn("autoLite", self.src)
        dangle = self.src[self.src.index('if (subsystem === "dangle")'):]
        dangle = dangle[:dangle.index("if (root.hqPerfMark")]
        self.assertIn("evaluatePressure", dangle)

    def test_page_frame_pressure_and_hysteresis(self):
        for name in (
            "function frameProbe",
            "emaFrameGap",
            "frameBadScore",
            "AUTO_LITE_HOLD_MS",
            "RECOVERY_FRAMES",
            "autoLiteUntil",
        ):
            self.assertIn(name, self.src)
        self.assertIn("AUTO_LITE_HOLD_MS = 30000", self.src)
        self.assertIn("RECOVERY_FRAMES = 450", self.src)
        self.assertRegex(self.src, r"frameSamples\s*>=\s*12")
        self.assertRegex(self.src, r"recoveryFrames\s*>=\s*RECOVERY_FRAMES")

    def test_direct_manipulation_keeps_full_quality(self):
        body = self.src[self.src.index("function live2dMinGap"):]
        body = body[:body.index("function companionLive2dShouldRun")]
        self.assertLess(body.index("if (ctx.hot) return 0"), body.index("const t = tier()"))
        dangle = self.src[self.src.index("function dangleShouldRun"):]
        dangle = dangle[:dangle.index("function homeEffectsPaused")]
        self.assertNotIn('"lite"', dangle)

    def test_coordinator_html_dataset(self):
        self.assertIn("dataset.hqMotionTier", self.src)
        self.assertIn("dataset.hqMotionMode", self.src)

    def test_bridge_load_order(self):
        home = BRIDGE.index("hq-home-fx.js")
        coord = BRIDGE.index("hq-motion-coordinator.js")
        self.assertLess(coord, home, "coordinator must load before home-fx")


if __name__ == "__main__":
    unittest.main()
