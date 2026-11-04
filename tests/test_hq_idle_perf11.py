import re, unittest
from pathlib import Path
A = Path(__file__).resolve().parents[1] / "assets"
CSS = (A / "hq-home-fx.css").read_text(encoding="utf-8")
JS = (A / "hq-home-fx.js").read_text(encoding="utf-8")


class IdlePerf11(unittest.TestCase):
    def test_clock_bar_uses_transform(self):
        self.assertIn("transform:scaleX(0)", CSS)
        self.assertIn('S.sec.style.transform = "scaleX("', JS)
        self.assertNotIn("S.sec.style.width", JS)

    def test_pause_class(self):
        self.assertIn("animation-play-state:paused!important", CSS)
        for k in ("syncPause", "visibilitychange", "IntersectionObserver"):
            self.assertIn(k, JS)

    def test_no_filter_or_shadow_keyframes(self):
        for name in ("hf-letter", "hf-breathe"):
            m = re.search(r"@keyframes\s+" + name + r"\s*\{(.*?)\}\s*\}", CSS, re.S)
            self.assertIsNotNone(m, name)
            self.assertNotIn("filter", m.group(1))
            self.assertNotIn("box-shadow", m.group(1))

    def test_star_count(self):
        self.assertIn("starField(18,", JS)


if __name__ == "__main__":
    unittest.main()