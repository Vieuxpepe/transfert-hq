"""Phase J1 prompt bricks: storage, validation, LoRA word suggestions, routes. Temp root, mock Forge only."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge as F  # noqa: E402
import hq_forge_bricks as BR  # noqa: E402
import test_hq_forge_fleet as TF  # noqa: E402

LORAS = [
    {"name": "lanterne_v2", "alias": "Lanterne", "metadata": {"ss_tag_frequency": json.dumps({"10_lantern": {"lanternlight": 40, "glow": 12, "1girl": 3, "bad<tag>": 99}})}},
    {"name": "grain", "alias": "grain", "metadata": {"ss_tag_frequency": {"a": {"film grain": 5}, "b": {"Film Grain": 4, "noise": 2}}}},
    {"name": "bad:name", "alias": "x", "metadata": {}},
    {"name": "plain", "alias": "plain"},
]


class Lora:
    def __init__(self, rows=LORAS):
        self.rows = rows
        self.calls = []

    def __call__(self, method, url, timeout, body=None):
        self.calls.append((method, url))
        if method != "GET" or not url.startswith("http://127.0.0.1:") or not url.endswith("/sdapi/v1/loras"):
            raise AssertionError((method, url))
        return 200, json.dumps(self.rows).encode("utf-8")


class Bricks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)
        F.reset_for_tests()

    def tearDown(self):
        F.reset_for_tests()
        self.tmp.cleanup()

    def post(self, **data):
        return BR.serve_post(self.root, "/api/forge/bricks", data)

    def test_create_update_delete_round_trip(self):
        status, out = self.post(action="create", name="Lanterne", text="warm light", lora={"name": "lanterne_v2", "weight": 0.75}, triggers=["lanternlight", "glow", "Glow"])
        self.assertEqual(status, 200, out)
        brick = out["bricks"][0]
        self.assertEqual((brick["name"], brick["lora"], brick["triggers"]), ("Lanterne", {"name": "lanterne_v2", "weight": 0.75}, ["lanternlight", "glow"]))
        self.assertRegex(brick["id"], r"^brick-[0-9a-f]{16}$")
        status, out = self.post(action="update", id=brick["id"], name="Lanterne douce", text="soft", triggers=[])
        self.assertEqual((status, out["bricks"][0]["name"], out["bricks"][0]["lora"]), (200, "Lanterne douce", None))
        self.assertEqual(BR.list_bricks(self.root)["bricks"][0]["text"], "soft")
        status, out = self.post(action="delete", id=brick["id"])
        self.assertEqual((status, out["bricks"]), (200, []))
        stored = json.loads((self.root / ".hq-forge" / "bricks.json").read_text(encoding="utf-8"))
        self.assertEqual(stored, {"version": 1, "bricks": []})

    def test_validation_duplicates_and_missing(self):
        self.assertEqual(self.post(action="create", name="A", text="x")[0], 200)
        cases = [
            ({"action": "create", "name": "a", "text": "y"}, 409),  # case-insensitive duplicate
            ({"action": "create", "name": "", "text": "y"}, 400),
            ({"action": "create", "name": "B"}, 400),  # empty brick
            ({"action": "create", "name": "B", "text": "x" * 401}, 400),
            ({"action": "create", "name": "B", "text": "a\x00b"}, 400),
            ({"action": "create", "name": "B", "lora": {"name": "x>y", "weight": 1}}, 400),
            ({"action": "create", "name": "B", "lora": {"name": "x:y", "weight": 1}}, 400),
            ({"action": "create", "name": "B", "lora": {"name": "x", "weight": 3}}, 400),
            ({"action": "create", "name": "B", "lora": {"name": "x", "weight": float("nan")}}, 400),
            ({"action": "create", "name": "B", "lora": {"name": "x", "weight": True}}, 400),
            ({"action": "create", "name": "B", "triggers": ["a,b"]}, 400),
            ({"action": "create", "name": "B", "triggers": ["w"] * 9}, 400),
            ({"action": "update", "id": "brick-" + "0" * 16, "name": "C", "text": "z"}, 404),
            ({"action": "delete", "id": "nope"}, 400),
            ({"action": "run"}, 400),
        ]
        for data, expected in cases:
            with self.subTest(data=data):
                self.assertEqual(BR.serve_post(self.root, "/api/forge/bricks", data)[0], expected)
        self.assertEqual(len(BR.list_bricks(self.root)["bricks"]), 1)

    def test_full_list_is_refused(self):
        for i in range(BR.MAX_BRICKS):
            self.assertEqual(self.post(action="create", name=f"b{i}", text="t")[0], 200)
        self.assertEqual(self.post(action="create", name="one more", text="t")[0], 409)

    def test_malformed_file_is_kept_and_blocks_writes(self):
        path = self.root / ".hq-forge" / "bricks.json"
        path.parent.mkdir(parents=True)
        path.write_bytes(b"{not json")
        self.assertEqual(BR.list_bricks(self.root)["storage"], "malformed")
        self.assertEqual(self.post(action="create", name="A", text="x")[0], 409)
        self.assertEqual(path.read_bytes(), b"{not json")

    def test_suggested_words_rank_training_tags_and_drop_unsafe_ones(self):
        self.assertEqual(BR.suggested_words(LORAS[0]["metadata"]), ["lanternlight", "glow", "1girl"])
        self.assertEqual(BR.suggested_words(LORAS[1]["metadata"]), ["film grain", "noise"])
        self.assertEqual(BR.suggested_words({}), [])
        self.assertEqual(BR.suggested_words({"ss_tag_frequency": "not json"}), [])
        self.assertEqual(BR.suggested_words(None), [])

    def test_local_loras_read_only_this_pc(self):
        transport = Lora()
        out = BR.local_loras(transport=transport)
        self.assertEqual(out["forge"], "ready")
        self.assertEqual([l["name"] for l in out["loras"]], ["grain", "lanterne_v2", "plain"], "unsafe names are dropped")
        self.assertEqual(out["loras"][1]["words"][:2], ["lanternlight", "glow"])
        self.assertTrue(all(m == "GET" for m, _u in transport.calls))
        self.assertNotIn("metadata", json.dumps(out))

    def test_local_loras_offline_is_quiet(self):
        def offline(*_a, **_k):
            raise OSError("down")
        self.assertEqual(BR.local_loras(transport=offline), {"forge": "error", "loras": []})

    def test_no_new_forge_route(self):
        self.assertIn(("GET", "/sdapi/v1/loras"), F.ALLOWED_ROUTES)


class BricksHttp(TF.FleetHttp):
    def test_brick_routes_are_admin_csrf_with_404(self):
        body = {"action": "create", "name": "Brume", "text": "brume legere"}
        self.assertEqual(self.post("/api/forge/bricks", body, client=self.anon)[0], 401)
        self.assertEqual(self.post("/api/forge/bricks", body, client=self.upload)[0], 403)
        status, _h, _b = self.admin.req("/api/forge/bricks", "POST", json.dumps(body).encode(), {"Origin": "http://evil.example", "Content-Type": "application/json"}, origin=False)
        self.assertEqual(status, 403)
        self.assertEqual(self.anon.json("/api/forge/bricks")[0], 401)
        self.assertEqual(self.upload.json("/api/forge/bricks")[0], 403)
        self.assertEqual(self.anon.json("/api/forge/bricks/loras")[0], 401)
        self.assertEqual(self.upload.json("/api/forge/bricks/loras")[0], 403)
        self.assertEqual(self.admin.json("/api/forge/bricks/other")[0], 404)
        self.assertEqual(self.post("/api/forge/bricks/other", body)[0], 404)
        self.assertFalse((self.root / ".hq-forge" / "bricks.json").exists(), "refused requests wrote nothing")
        status, out = self.post("/api/forge/bricks", body)
        self.assertEqual((status, out["bricks"][0]["name"]), (200, "Brume"))
        self.assertEqual(self.admin.json("/api/forge/bricks")[1]["bricks"][0]["text"], "brume legere")
        F.set_transport_for_tests(Lora())
        self.addCleanup(F.set_transport_for_tests, None)
        status, out = self.admin.json("/api/forge/bricks/loras")
        self.assertEqual((status, out["forge"], len(out["loras"])), (200, "ready", 3))


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(Bricks))
    suite.addTest(BricksHttp("test_brick_routes_are_admin_csrf_with_404"))
    return suite


if __name__ == "__main__":
    unittest.main()
