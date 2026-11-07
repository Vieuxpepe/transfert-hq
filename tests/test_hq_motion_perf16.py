"""perf16: adaptive Live2D throttling, cast decimation, and perf-lite class."""
import pathlib
import unittest

JS = (pathlib.Path(__file__).resolve().parent.parent / "assets" / "hq-companion.js").read_text(encoding="utf-8")
CSS = (pathlib.Path(__file__).resolve().parent.parent / "assets" / "hq-companion.css").read_text(encoding="utf-8")


class MotionPerf16(unittest.TestCase):
    def test_live2d_helpers(self):
        for name in (
            "function live2dInteractionHot",
            "function shouldCommitBustPullVisuals",
            "function live2dFrameMinGap",
            "function noteLive2dFrameCost",
        ):
            self.assertIn(name, JS)

    def test_idle_desktop_throttle(self):
        self.assertIn("return 15;", JS)
        self.assertIn("live2dFrameMinGap(win, nowMs)", JS)
        self.assertIn("Pointer, typing, and scroll stay on the idle gap", JS)
        self.assertIn("pullContact", JS)
        self.assertIn("const wait = gap > 0 ? Math.max(0, gap - costMs) : 0;", JS)

    def test_cast_decimation(self):
        self.assertIn("st.castFrame", JS)
        self.assertIn("castEvery", JS)

    def test_perf_lite_css(self):
        self.assertIn(".hq-companion.is-perf-lite", CSS)
        self.assertIn("is-user-looking", CSS)


if __name__ == "__main__":
    unittest.main()
