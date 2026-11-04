"""Perf12/13: avatar dangling-member glisten loop idles/parks instead of running every frame."""
import os
import re
import unittest
from pathlib import Path

JS = Path(os.environ.get("HQ_DANGLING_JS") or Path(__file__).resolve().parents[1] / "assets" / "hq-dangling-member.js")


class AvatarIdlePerf12Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = JS.read_text(encoding="utf-8")

    def test_idle_throttle_constant(self):
        m = re.search(r"GLISTEN_IDLE_MS\s*=\s*(\d+)", self.src)
        self.assertIsNotNone(m)
        self.assertTrue(50 <= int(m.group(1)) <= 90)  # ~11-20 fps shimmer

    def test_loop_has_busy_check_and_wake(self):
        for name in ("function glistenBusy", "function wakeGlisten", "function glistenLoop", "function glistenQueue"):
            self.assertIn(name, self.src)

    def test_busy_covers_pointer_and_oral_states(self):
        body = self.src[self.src.index("function glistenBusy"):]
        body = body[: body.index("function glistenQueue")]
        for name in ("running", "dragging", "ptr.active", "oralEngaged", "oralPhase", "oralDepthSm", "restName", "throbStart", "nodStart", "warmth", "give"):
            self.assertIn(name, body)

    def test_parks_when_hidden_and_offscreen(self):
        self.assertRegex(self.src, r"addEventListener\(\s*[\"']visibilitychange[\"']")
        self.assertIn("IntersectionObserver", self.src)
        self.assertRegex(self.src, r"\.hidden")

    def test_ensure_tick_wakes_glisten(self):
        body = self.src[self.src.index("function ensureTick"):]
        body = body[: body.index("\n  }\n") if "\n  }\n" in body else 600]
        self.assertIn("wakeGlisten()", body)

    def test_body_feel_writes_deduped(self):
        self.assertIn("getPropertyValue(\"--cock-give\")", self.src.replace("'", '"'))
        self.assertIn("classList.contains(\"is-cock-on-tit\")", self.src.replace("'", '"'))

    def test_reduced_motion_still_respected(self):
        self.assertIn("prefers-reduced-motion", self.src)


if __name__ == "__main__":
    unittest.main()
