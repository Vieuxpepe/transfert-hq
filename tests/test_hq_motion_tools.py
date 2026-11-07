"""Outils + coordinator wiring for HQ motion modes."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
COMP = (ROOT / "assets" / "hq-companion.js").read_text(encoding="utf-8")
COORD = (ROOT / "assets" / "hq-motion-coordinator.js").read_text(encoding="utf-8")
CSS = (ROOT / "assets" / "hq-companion.css").read_text(encoding="utf-8")


class MotionTools(unittest.TestCase):
    def test_outils_motion_select(self):
        self.assertIn("hq-companion-motion-perf", COMP)
        self.assertIn("Fluidité HQ", COMP)
        self.assertIn("HqMotion.setMode", COMP)

    def test_css_idle_portrait(self):
        self.assertIn("is-css-idle-portrait", COMP)
        self.assertIn("hq-companion-css-idle-sway", CSS)

    def test_html_tier_css_hooks(self):
        chrome = (ROOT / "assets" / "hq-chrome.css").read_text(encoding="utf-8")
        self.assertIn("data-hq-motion-tier", CSS + chrome)

    def test_dangle_png_until_armed(self):
        dang = (ROOT / "assets" / "hq-dangling-member.js").read_text(encoding="utf-8")
        self.assertIn("danglePaintArmed", dang)
        self.assertIn(':not(.is-softbody) .hq-dangling-member-canvas', CSS)

    def test_animation_workflow_tracks_bridge_and_home_css(self):
        workflow = (ROOT / ".github" / "workflows" / "animation-perf.yml").read_text(encoding="utf-8")
        for required in ("iphone_bridge.py", "assets/hq-home-fx.css", ".github/workflows/animation-perf.yml"):
            self.assertEqual(workflow.count(f'"{required}"'), 2, required)


if __name__ == "__main__":
    unittest.main()
