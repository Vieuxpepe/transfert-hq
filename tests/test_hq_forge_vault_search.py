"""Phase H searchable vault: tags, collections and prompt search inside the vault encryption only.

The search index lives in memory on the unlock session and is gone on lock, auto-lock, logout
or any vault write. Synthetic images, temp vault, never the real one."""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge_vault as V  # noqa: E402
from test_hq_forge_vault import PASS, _png, _token  # noqa: E402
import test_hq_forge_fleet as TF  # noqa: E402

SECRET = "renard argent\u00e9 sous la neige"


def settings(prompt: str) -> dict:
    return {"prompt": prompt, "negative_prompt": "", "checkpoint": "example.safetensors [abcd]", "sampler_name": "Euler",
            "scheduler": "automatic", "width": 256, "height": 256, "steps": 8, "n_iter": 1, "batch_size": 1, "seed": 5, "cfg_scale": 6.0}


class VaultSearch(unittest.TestCase):
    def setUp(self) -> None:
        V.bind_session_checker(None)
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.hq = Path(self.tmp.name) / "hq"
        self.store = Path(self.tmp.name) / "vault"
        self.hq.mkdir()
        self.store.mkdir()
        V.set_root_for_tests(self.store)
        V.set_acl_for_tests(False)
        self.admin = _token("admin")
        V.setup(self.hq, PASS, PASS)
        V.unlock(self.hq, self.admin, PASS)
        self.fox = V.store_image(self.hq, self.admin, _png(), settings(SECRET))["id"]
        self.cat = V.store_image(self.hq, self.admin, _png(), settings("chat noir au soleil"))["id"]

    def tearDown(self) -> None:
        V.reset_for_tests()
        self.tmp.cleanup()

    def everything_on_disk(self) -> bytes:
        blob = b""
        for path in list(self.store.rglob("*")) + list(self.hq.rglob("*")):
            if path.is_file():
                blob += path.read_bytes()
        return blob

    def test_prompt_search_is_accent_and_case_insensitive(self):
        found = V.search(self.hq, self.admin, {"q": "ARGENTE neige"})
        self.assertEqual([i["id"] for i in found["images"]], [self.fox])
        self.assertEqual(V.search(self.hq, self.admin, {"q": "renard chat"})["images"], [])
        self.assertEqual(V.search(self.hq, self.admin, {"q": ""})["total"], 2)
        for bad in ({"q": "x" * 121}, {"q": 5}, {"tag": "t" * 33}, {"collection": ["a"]}):
            with self.assertRaises(V.VaultError):
                V.search(self.hq, self.admin, bad)

    def test_tags_and_collections_live_only_in_the_encrypted_index(self):
        out = V.set_labels(self.hq, self.admin, self.fox, ["hiver", "Hiver", "faune"], "S\u00e9rie bor\u00e9ale")
        self.assertEqual(out["tags"], ["hiver", "faune"])
        V.set_labels(self.hq, self.admin, self.cat, ["faune"], "")
        found = V.search(self.hq, self.admin, {"tag": "FAUNE"})
        self.assertEqual({i["id"] for i in found["images"]}, {self.fox, self.cat})
        self.assertEqual([i["id"] for i in V.search(self.hq, self.admin, {"collection": "serie boreale"})["images"]], [self.fox])
        self.assertEqual(dict(found["tags"]), {"faune": 2, "hiver": 1})
        self.assertEqual(found["collections"], [["S\u00e9rie bor\u00e9ale", 1]] if isinstance(found["collections"][0], list) else [("S\u00e9rie bor\u00e9ale", 1)])
        self.assertIn("hiver", [t for i in V.page(self.hq, self.admin)["images"] for t in i["tags"]])
        disk = self.everything_on_disk()
        for word in ("hiver", "faune", "bor\u00e9ale".encode("utf-8").decode("utf-8"), "renard", "argent"):
            self.assertNotIn(word.encode("utf-8"), disk, word)
        for bad in ((["x"] * 13, ""), (["a\x00b"], ""), ([""], ""), (["ok"], "c" * 49), ("hiver", "")):
            with self.assertRaises(V.VaultError):
                V.set_labels(self.hq, self.admin, self.fox, *bad)
        with self.assertRaises(V.VaultError) as ctx:
            V.set_labels(self.hq, self.admin, "pvt-" + "0" * 24, ["a"], "")
        self.assertEqual(ctx.exception.code, "bad_id")

    def test_search_index_is_memory_only_and_gone_on_lock_and_auto_lock(self):
        V.search(self.hq, self.admin, {"q": "renard"})
        self.assertEqual(V.search_cache_size_for_tests(), 2)
        V.lock(self.admin)
        self.assertEqual(V.search_cache_size_for_tests(), 0)
        with self.assertRaises(V.VaultError) as ctx:
            V.search(self.hq, self.admin, {"q": "renard"})
        self.assertEqual(ctx.exception.code, "locked")
        V.set_ttl_for_tests(0.2)
        V.unlock(self.hq, self.admin, PASS)
        V.search(self.hq, self.admin, {"q": "renard"})
        self.assertEqual(V.search_cache_size_for_tests(), 2)
        time.sleep(0.3)
        with self.assertRaises(V.VaultError):
            V.search(self.hq, self.admin, {"q": "renard"})  # auto-lock fired
        self.assertEqual(V.search_cache_size_for_tests(), 0)
        V.set_ttl_for_tests(None)
        V.unlock(self.hq, self.admin, PASS)
        V.search(self.hq, self.admin, {"q": "renard"})
        V.drop_session(self.admin)  # logout
        self.assertEqual(V.search_cache_size_for_tests(), 0)

    def test_writes_rebuild_the_index_and_other_sessions_see_nothing(self):
        V.search(self.hq, self.admin, {"q": "chat"})
        new = V.store_image(self.hq, self.admin, _png(), settings("chat roux"))["id"]
        self.assertEqual(V.search_cache_size_for_tests(), 0, "a store drops the cached index")
        self.assertEqual({i["id"] for i in V.search(self.hq, self.admin, {"q": "chat"})["images"]}, {self.cat, new})
        V.delete(self.hq, self.admin, new)
        self.assertEqual([i["id"] for i in V.search(self.hq, self.admin, {"q": "chat"})["images"]], [self.cat])
        V.set_triage(self.hq, self.admin, self.cat, "reject")
        self.assertEqual(V.search(self.hq, self.admin, {"q": "chat"})["images"], [], "the bin is not searched")
        with self.assertRaises(V.VaultError) as ctx:
            V.search(self.hq, _token("other"), {"q": "renard"})
        self.assertEqual(ctx.exception.code, "locked")

    def test_a_damaged_object_is_skipped_and_a_damaged_index_refuses(self):
        obj = next((self.store).rglob(self.cat + ".bin"))
        obj.write_bytes(b"garbage")
        self.assertEqual([i["id"] for i in V.search(self.hq, self.admin, {"q": "renard"})["images"]], [self.fox])
        index = next(self.store.rglob("index.bin"))
        index.write_bytes(b"garbage")
        with self.assertRaises(V.VaultError) as ctx:
            V.search(self.hq, self.admin, {"q": "renard"})
        self.assertEqual(ctx.exception.code, "corrupt")


class VaultSearchHttp(TF.FleetHttp):
    def test_search_and_labels_are_admin_csrf_post_only(self):
        tmp = Path(self.tmp) / "vault"
        tmp.mkdir()
        V.set_root_for_tests(tmp)
        V.set_acl_for_tests(False)
        try:
            status, made = self.post("/api/forge/vaults/new", {"passphrase": PASS, "confirm": PASS, "label": "Recherche"})
            self.assertEqual(status, 201)
            base = "/api/forge/vaults/" + made["vault"]["id"]  # V4: per-vault routes only
            label = base + "/images/pvt-" + "0" * 24 + "/labels"
            for path, body in ((base + "/search", {"q": "renard"}), (label, {"tags": ["a"]})):
                with self.subTest(path=path):
                    self.assertEqual(self.post(path, body, client=self.anon)[0], 401)
                    self.assertEqual(self.post(path, body, client=self.upload)[0], 403)
                    status, _h, _b = self.admin.req(path, "POST", json.dumps(body).encode(), {"Origin": "http://evil.example", "Content-Type": "application/json"}, origin=False)
                    self.assertEqual(status, 403)
                    self.assertEqual(self.post(path, body)[0], 401, "locked vault")
            self.assertEqual(self.post(base + "/unlock", {"passphrase": PASS})[0], 200)
            self.assertEqual(self.post(label, {"tags": ["a"]})[0], 404)
            self.assertEqual(self.post(base + "/images/not-an-id/labels", {"tags": ["a"]})[0], 404)
            self.assertEqual(self.post(base + "/other", {})[0], 404)
            status, payload = self.post(base + "/search", {"q": "renard"})
            self.assertEqual((status, payload["images"]), (200, []))
            self.assertEqual(self.admin.json(base + "/search")[0], 404, "no GET: the words never go in a URL")
            self.assertEqual(self.post("/api/forge/vaults/lock", {})[0], 200)
            self.assertEqual(V.search_cache_size_for_tests(), 0)
        finally:
            V.reset_for_tests()


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(VaultSearch))
    suite.addTest(VaultSearchHttp("test_search_and_labels_are_admin_csrf_post_only"))
    return suite


if __name__ == "__main__":
    unittest.main()