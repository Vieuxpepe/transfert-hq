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
        self.assertIn("movingStars: 8", JS)
        self.assertIn("movingStars: 4", JS)
        self.assertEqual(len(re.findall(r'i < 4 \? " ?is-moving"', JS)), 2)
        self.assertIn(".home-star.is-moving", CSS)
        self.assertIn(".bg-stars span.is-moving", CSS)

    def test_explicit_lite_and_parked_budgets(self):
        self.assertIn("risingLights: 4", JS)
        self.assertIn("risingLights: 0", JS)
        self.assertIn('data-hq-motion-tier="lite"', CSS)
        self.assertIn('data-hq-motion-tier="parked"', CSS)
        self.assertRegex(CSS, r'data-hq-motion-tier="lite"[^}]*\.bg-lights\{display:none\}')

    def test_off_view_stops_scheduled_effects(self):
        self.assertIn("function stopShootingStars", JS)
        self.assertIn('if (off || motionTier() !== "full") stopShootingStars()', JS)
        self.assertIn("if (S.doc.hidden || !onHome())", JS)
        self.assertIn('addEventListener("hq:motion-mode", syncPause)', JS)

    def test_no_expensive_home_filters(self):
        self.assertNotRegex(CSS, r"filter\s*:\s*(?:blur|drop-shadow)\(")
        self.assertNotRegex(CSS, r"backdrop-filter\s*:\s*(?!none)")

if __name__ == "__main__":
    unittest.main()