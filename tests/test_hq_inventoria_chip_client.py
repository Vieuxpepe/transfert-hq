"""Static client contracts for Inventoria forge chip."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHIP_JS = ROOT / "assets" / "hq-inventoria-chip.js"
SCALE_JS = ROOT / "assets" / "hq-image-chip-scale.js"
CSS = ROOT / "assets" / "hq-companion.css"
PORTRAITS = ROOT / "assets" / "companion"


class InventoriaChipClientContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.js = CHIP_JS.read_text(encoding="utf-8")
        cls.css = CSS.read_text(encoding="utf-8")

    def test_portrait_assets_exist(self) -> None:
        self.assertTrue((PORTRAITS / "inventoria-chip.webp").is_file())
        self.assertTrue((PORTRAITS / "inventoria-chip@2x.webp").is_file())
        self.assertIn("inventoria-chip.webp", self.js)

    def test_sfw_portrait_assets_exist(self) -> None:
        for mood in ("", "-listening", "-speaking", "-proactive", "-sister", "-busy"):
            base = "inventoria-chip" + mood + "-sfw.webp"
            self.assertTrue((PORTRAITS / base).is_file(), base)
        self.assertIn("PORTRAIT_SFW_BY_MOOD", self.js)

    def test_mood_portrait_assets_exist(self) -> None:
        for mood in ("listening", "speaking", "proactive", "sister", "busy"):
            self.assertTrue((PORTRAITS / f"inventoria-chip-{mood}.webp").is_file(), mood)
            self.assertTrue((PORTRAITS / f"inventoria-chip-{mood}@2x.webp").is_file(), mood)
            self.assertIn(f"inventoria-chip-{mood}.webp", self.js)

    def test_left_dock_and_intime_hide(self) -> None:
        self.assertIn("hq-inventoria", self.js)
        self.assertIn("hqSessionIsAdmin", self.js)
        self.assertIn('view === "intime"', self.js)
        self.assertIn(".hq-inventoria{", self.css)
        self.assertIn("safe-area-inset-left", self.css)

    def test_public_api(self) -> None:
        self.assertIn("win.HqInventoria", self.js)
        self.assertIn("hq:inventoria-open", self.js)
        self.assertIn("setChipScale", self.js)
        self.assertIn("setMood", self.js)
        self.assertIn("PORTRAIT_BY_MOOD", self.js)
        self.assertIn("hq:inventoria-mood", self.js)
        self.assertIn("mood_listening", self.js)
        for mood in ("idle", "listening", "speaking", "proactive", "busy", "sister"):
            self.assertIn(f"inventoria-chip-{mood}" if mood != "idle" else "inventoria-chip.webp", self.js)
        self.assertIn("hq_inventoria_chip_scale_v1", self.js)
        self.assertTrue(SCALE_JS.is_file())
        self.assertIn("hq-inventoria-chip-menu", self.css)


if __name__ == "__main__":
    unittest.main()
