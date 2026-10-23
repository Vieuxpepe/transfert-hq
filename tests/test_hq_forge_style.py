"""Phase J3 house style: modes of kept gallery settings, Indicatif, vault never read. Temp root."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge_gallery as G  # noqa: E402
import hq_forge_style as S  # noqa: E402
import hq_forge_vault as V  # noqa: E402
import test_hq_forge_fleet as TF  # noqa: E402
from test_hq_forge_inpaint import png, settings  # noqa: E402


class Style(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def add(self, flag="keep", **changes):
        image = G.store(self.root, png(), {**settings(), **changes})["id"]
        if flag != "none":
            G.set_triage(self.root, image, flag)
        return image

    def test_not_enough_kept_images(self):
        for _ in range(4):
            self.add()
        self.add("none")
        self.add("reject")
        out = S.house_style(self.root)
        self.assertEqual((out["kept"], out["enough"], out["style"], out["indicative"]), (4, False, {}, True))

    def test_modes_with_favourites_counting_twice(self):
        for _ in range(3):
            self.add(sampler_name="Euler", steps=20, cfg_scale=6.0, negative_prompt="flou")
        self.add("favorite", sampler_name="DPM++ 2M", steps=30, cfg_scale=7.0, width=768, height=512, negative_prompt="flou")
        self.add("favorite", sampler_name="DPM++ 2M", steps=30, cfg_scale=7.0, width=768, height=512)
        for _ in range(3):
            self.add("reject", sampler_name="LMS", steps=5)
        out = S.house_style(self.root)
        self.assertTrue(out["enough"])
        self.assertEqual(out["kept"], 5)
        st = out["style"]
        self.assertEqual((st["sampler_name"]["value"], st["sampler_name"]["count"], st["sampler_name"]["of"]), ("DPM++ 2M", 4, 7))
        self.assertEqual(st["steps"]["value"], 30)
        self.assertEqual(st["cfg_scale"]["value"], 7.0)
        self.assertEqual(st["size"]["value"], {"width": 768, "height": 512})
        self.assertEqual(st["scheduler"]["value"], "automatic")
        self.assertEqual(out["model"]["value"], settings()["checkpoint"])
        self.assertEqual(out["negative_prompt"], {"value": "flou", "count": 5, "of": 7})
        self.assertNotIn("checkpoint", st, "the model is reported apart and never part of what is applied")
        self.assertNotIn("prompt", json.dumps(st))

    def test_rare_negative_prompt_is_not_offered(self):
        self.add(negative_prompt="flou")
        for _ in range(4):
            self.add(negative_prompt="")
        self.assertIsNone(S.house_style(self.root)["negative_prompt"])

    def test_bad_values_are_ignored(self):
        for _ in range(5):
            self.add(steps=0, cfg_scale=99)
        st = S.house_style(self.root)["style"]
        self.assertNotIn("steps", st)
        self.assertNotIn("cfg_scale", st)

    def test_the_vault_is_never_read(self):
        for _ in range(5):
            self.add()
        with mock.patch.object(V, "detail", side_effect=AssertionError("vault read")), \
                mock.patch.object(V, "file_bytes", side_effect=AssertionError("vault read")):
            out = S.house_style(self.root)
        self.assertTrue(out["enough"])
        self.assertNotIn("vault", Path(S.__file__).read_text(encoding="utf-8").split('"""', 2)[2])


class StyleHttp(TF.FleetHttp):
    def test_house_style_route_is_admin_read_only(self):
        self.assertEqual(self.anon.json("/api/forge/house-style")[0], 401)
        self.assertEqual(self.upload.json("/api/forge/house-style")[0], 403)
        self.assertEqual(self.admin.json("/api/forge/house-style/x")[0], 404)
        self.assertEqual(self.post("/api/forge/house-style", {}, client=self.anon)[0], 401)
        self.assertEqual(self.post("/api/forge/house-style", {})[0], 404, "nothing to POST: applying only fills fields")
        status, out = self.admin.json("/api/forge/house-style")
        self.assertEqual((status, out["enough"], out["kept"]), (200, False, 0))


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(Style))
    suite.addTest(StyleHttp("test_house_style_route_is_admin_read_only"))
    return suite


if __name__ == "__main__":
    unittest.main()
