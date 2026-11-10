"""SFW chip portrait wiring — assets, script order, portrait tables."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BRIDGE = ROOT / "iphone_bridge.py"
SCALE = ROOT / "assets" / "hq-image-chip-scale.js"
ELSE_JS = ROOT / "assets" / "hq-else-chip.js"
INV_JS = ROOT / "assets" / "hq-inventoria-chip.js"
COMPANION_JS = ROOT / "assets" / "hq-companion.js"


def srcs_from_table(js: str, table_name: str) -> list[str]:
    m = re.search(rf"const {table_name} = \{{([\s\S]*?)\n  \}};", js)
    if not m:
        return []
    return re.findall(r'src:\s*"([^"]+)"', m.group(1))


class ChipSfwWiring(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.scale = SCALE.read_text(encoding="utf-8")
        cls.else_js = ELSE_JS.read_text(encoding="utf-8")
        cls.inv_js = INV_JS.read_text(encoding="utf-8")
        cls.bridge = BRIDGE.read_text(encoding="utf-8")
        cls.companion = COMPANION_JS.read_text(encoding="utf-8")

    def test_script_order_on_bridge(self) -> None:
        i_scale = self.bridge.index("hq-image-chip-scale.js")
        i_else = self.bridge.index("hq-else-chip.js")
        i_inv = self.bridge.index("hq-inventoria-chip.js")
        i_companion = self.bridge.index("hq-companion.js")
        self.assertLess(i_companion, i_scale)
        self.assertLess(i_scale, i_else)
        self.assertLess(i_else, i_inv)

    def test_sfw_assets_on_disk(self) -> None:
        for js in (self.else_js, self.inv_js):
            for src in srcs_from_table(js, "PORTRAIT_SFW_BY_MOOD"):
                path = ROOT / Path(src.lstrip("/"))
                self.assertTrue(path.is_file(), src)
                self.assertIn("-sfw.webp", src)

    def test_adult_vs_sfw_paths(self) -> None:
        sfw = srcs_from_table(self.else_js, "PORTRAIT_SFW_BY_MOOD")
        self.assertEqual(len(sfw), 6)
        for s in sfw:
            self.assertIn("-sfw.webp", s)
        self.assertIn('else-chip.webp"', self.else_js)
        self.assertNotIn('else-chip-sfw.webp"', self.else_js.split("PORTRAIT_BY_MOOD")[1].split("PORTRAIT_SFW")[0])

    def test_apply_portrait_uses_adult_gate(self) -> None:
        for js in (self.else_js, self.inv_js):
            self.assertIn("adultChipPortraits", js)
            self.assertIn("bindPortraitMode", js)
        self.assertIn("is-chip-sfw-portraits", self.scale)
        self.assertIn("hq:companion-nsfw", self.scale)

    def test_companion_nsfw_hook(self) -> None:
        self.assertIn("hq:companion-nsfw", self.companion)
        self.assertIn("hqCompanionNsfwOn", self.companion)


if __name__ == "__main__":
    unittest.main()
