"""Readiness must still see feature scripts that are loaded on demand (Carnet, Forge, Dessiner)."""
import unittest
from pathlib import Path

import hq_diagnostics
import iphone_bridge as B


class ReadinessAssetsTests(unittest.TestCase):
    def test_lazy_groups_are_required_assets_and_exist(self):
        names = set(hq_diagnostics.required_assets(B.render_app))
        for must in ("hq-carnet.js", "hq-carnet-media.js", "hq-forge.js", "hq-forge-couch.js", "hq-sketch-core.js", "hq-dessiner.js"):
            self.assertIn(must, names)
        root = Path(B.__file__).resolve().parent / "assets"
        self.assertEqual([n for n in names if not (root / n).is_file()], [])


if __name__ == "__main__":
    unittest.main()
