"""Static checks for hq-kinetic-score.js (shared motion phrases)."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
JS = ROOT / "assets" / "hq-kinetic-score.js"
BRIDGE = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")


class KineticScore(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src = JS.read_text(encoding="utf-8")

    def test_file_exists(self):
        self.assertTrue(JS.is_file())

    def test_exports_api(self):
        for name in ("emit", "cancel", "subscribe", "getState", "setManipulating"):
            self.assertIn(name + ":", self.src, name)

    def test_no_idle_loop_without_phrases(self):
        self.assertIn("if (rafId || !active.length) return", self.src)
        self.assertIn("if (!active.length) stopTick()", self.src)

    def test_tier_limits(self):
        self.assertIn('t === "parked"', self.src)
        self.assertIn('t === "lite"', self.src)

    def test_manip_suppresses_member_contact(self):
        self.assertIn("manipActive", self.src)
        self.assertIn('phrase.source === "member"', self.src)

    def test_bridge_load_order(self):
        coord = BRIDGE.index("hq-motion-coordinator.js")
        kinetic = BRIDGE.index("hq-kinetic-score.js")
        home = BRIDGE.index("hq-home-fx.js")
        self.assertLess(coord, kinetic)
        self.assertLess(kinetic, home)

    def test_integrations(self):
        companion = (ROOT / "assets" / "hq-companion.js").read_text(encoding="utf-8")
        home = (ROOT / "assets" / "hq-home-fx.js").read_text(encoding="utf-8")
        dangle = (ROOT / "assets" / "hq-dangling-member.js").read_text(encoding="utf-8")
        self.assertIn("bindKineticScore", companion)
        self.assertIn("HqKinetic.emit", home)
        self.assertIn("HqKinetic.emit", dangle)
        self.assertIn("setManipulating", dangle)


if __name__ == "__main__":
    unittest.main()
