"""Accueil layout: the pure normaliser and /api/home-layout (admin only, CSRF, one file shared by
every device). Disposable root, fake PINs; never the live root."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_home as H  # noqa: E402


class Normalize(unittest.TestCase):
    def test_default_and_garbage(self):
        self.assertEqual(H.normalize(None), H.default())
        self.assertEqual(H.normalize({"order": "x", "hidden": 3}), {"order": list(H.KEYS), "hidden": [], "side": list(H.DEFAULT_SIDE)})

    def test_known_keys_once_every_card_placed(self):
        got = H.normalize({"order": ["send", "feed", "send", "evil", 7], "hidden": ["pc", "evil"], "side": ["send", "feed"]})
        self.assertEqual(got["order"][:2], ["send", "feed"])
        self.assertEqual(sorted(got["order"]), sorted(H.KEYS))
        self.assertEqual(got["hidden"], ["pc"])
        self.assertEqual(got["side"], ["send", "feed"])  # in display order

    def test_save_and_load_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hq_home_layout.json"
            self.assertEqual(H.load(path), H.default())
            saved = H.save(path, {"order": ["today"], "hidden": ["send"], "side": []})
            self.assertEqual(H.load(path), saved)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["hidden"], ["send"])
            path.write_text("{not json", encoding="utf-8")
            self.assertEqual(H.load(path), H.default())


try:
    from test_hq_forge_vault_multi_http import JSON, MultiHttp  # noqa: E402
    import iphone_bridge as B  # noqa: E402
except ImportError:  # pragma: no cover
    MultiHttp = None

if MultiHttp is not None:
    class Route(MultiHttp):
        def test_admin_only_csrf_and_shared(self):
            self.assertEqual(self.anon.req("/api/home-layout")[0], 401)
            self.assertEqual(self.upload.req("/api/home-layout")[0], 403)
            status, body = self.admin.json("/api/home-layout")
            self.assertEqual((status, body["layout"]["order"]), (200, list(H.KEYS)))
            layout = {"order": ["today", "carnet"], "hidden": ["send"], "side": ["devices"]}
            body_bytes = json.dumps({"layout": layout}).encode("utf-8")
            self.assertEqual(self.upload.req("/api/home-layout", "POST", body_bytes, JSON)[0], 403)
            self.assertEqual(self.admin.req("/api/home-layout", "POST", body_bytes, {**JSON, "Origin": "http://evil.example"})[0], 403)
            status, body = self.post(self.admin, "/api/home-layout", {"layout": layout})
            self.assertEqual(status, 200, body)
            self.assertEqual(body["layout"]["order"][:2], ["today", "carnet"])
            self.assertEqual(self.admin.json("/api/home-layout")[1]["layout"], body["layout"])  # what another device reads
            self.assertTrue((B.ROOT / "hq_home_layout.json").is_file())
            status, body = self.post(self.admin, "/api/home-layout", {"reset": True})
            self.assertEqual(body["layout"], H.default())


if __name__ == "__main__":
    unittest.main()
