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
        self.assertIn("autoLite", self.src)

    def test_coordinator_html_dataset(self):
        self.assertIn("dataset.hqMotionTier", self.src)
        self.assertIn("dataset.hqMotionMode", self.src)

    def test_bridge_load_order(self):
        home = BRIDGE.index("hq-home-fx.js")
        coord = BRIDGE.index("hq-motion-coordinator.js")
        self.assertLess(coord, home, "coordinator must load before home-fx")


if __name__ == "__main__":
    unittest.main()
