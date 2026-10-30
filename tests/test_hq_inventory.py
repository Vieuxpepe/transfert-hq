"""Inventaire store (hq_inventory.py): validation, revisions, nesting, fail-closed storage."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_inventory as inv  # noqa: E402

ASSET = "asset-" + "a" * 24


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.known = {ASSET}
        inv.bind(root=self.root, now=lambda: 1790000000.0, asset_exists=lambda a: a in self.known)

    def tearDown(self):
        self.tmp.cleanup()

    def place(self, name="Garage", parent=None, kind="room"):
        return inv.apply({"action": "place.create", "name": name, "parent": parent, "kind": kind})["place"]

    def item(self, name="Vis", place=None, **kw):
        return inv.apply(dict({"action": "item.create", "name": name, "place": place}, **kw))["item"]

    def err(self, data):
        with self.assertRaises(inv.InventoryError) as cm:
            inv.apply(data)
        return cm.exception

    def test_empty_store_reads_without_writing(self):
        code, out = inv.http_get({})
        self.assertEqual(code, 200)
        self.assertEqual((out["rev"], out["places"], out["items"]), (0, [], []))
        self.assertFalse(inv.inventory_path(self.root).exists())

    def test_create_nested_places_and_items(self):
        g = self.place()
        s = self.place("Étagère 2", g["id"], "shelf")
        b = self.place("Boîte visserie", s["id"], "box")
        self.assertRegex(b["code"], r"^[23456789A-HJKMNP-Z]{4}$")
        i = self.item("Vis M4×12", b["id"], qty=140, unit="pcs", min=50, tags=["Visserie", "#visserie", "M4"])
        self.assertEqual(i["tags"], ["visserie", "m4"])
        doc = inv.snapshot()
        self.assertEqual([p["name"] for p in inv.place_path(doc, b["id"])], ["Garage", "Étagère 2", "Boîte visserie"])
        self.assertEqual(doc["rev"], 4)
        self.assertTrue(inv.validate_doc(json.loads(inv.inventory_path(self.root).read_text("utf-8"))))

    def test_codes_are_unique(self):
        codes = {self.place("P%d" % n)["code"] for n in range(60)}
        self.assertEqual(len(codes), 60)

    def test_names_are_one_line_and_bounded(self):
        p = self.place("  Gar\nage   du\tfond ")
        self.assertEqual(p["name"], "Gar age du fond")
        self.assertEqual(self.err({"action": "place.create", "name": "   "}).status, 400)
        self.assertEqual(self.err({"action": "place.create", "name": "x" * 121}).status, 400)
        self.assertEqual(self.err({"action": "place.create", "name": "x", "kind": "castle"}).status, 400)

    def test_quantities(self):
        i = self.item(qty=3)
        for bad in (-1, 1.5, True, "3", inv.QTY_MAX + 1):
            self.assertEqual(self.err({"action": "item.update", "id": i["id"], "rev": i["rev"], "qty": bad}).status, 400)
        out = inv.apply({"action": "item.adjust", "id": i["id"], "delta": -10})
        self.assertEqual(out["item"]["qty"], 0, "never below zero")
        out = inv.apply({"action": "item.adjust", "id": i["id"], "delta": 5})
        self.assertEqual(out["item"]["qty"], 5)
        self.assertEqual(self.err({"action": "item.adjust", "id": i["id"], "delta": 0}).status, 400)

    def test_adjust_needs_no_revision_but_update_does(self):
        i = self.item(qty=10)
        inv.apply({"action": "item.adjust", "id": i["id"], "delta": 1})
        e = self.err({"action": "item.update", "id": i["id"], "rev": i["rev"], "name": "Autre"})
        self.assertEqual(e.status, 409)
        self.assertEqual(e.extra["item"]["qty"], 11, "the conflict returns the current record")
        self.assertEqual(self.err({"action": "item.update", "id": i["id"], "name": "x"}).status, 400, "rev is required")

    def test_cycles_and_depth_are_refused(self):
        a = self.place("A")
        b = self.place("B", a["id"])
        e = self.err({"action": "place.update", "id": a["id"], "rev": a["rev"], "parent": b["id"]})
        self.assertEqual(e.code, "cycle")
        e = self.err({"action": "place.update", "id": a["id"], "rev": a["rev"], "parent": a["id"]})
        self.assertEqual(e.code, "cycle")
        chain = [a, b]
        while len(chain) < inv.DEPTH_MAX:
            chain.append(self.place("L%d" % len(chain), chain[-1]["id"]))
        self.assertEqual(self.err({"action": "place.create", "name": "trop", "parent": chain[-1]["id"]}).code, "too_deep")
        # moving a 2-level subtree under a deep place counts the subtree's height
        x = self.place("X")
        self.place("Y", x["id"])
        self.assertEqual(self.err({"action": "place.update", "id": x["id"], "rev": x["rev"], "parent": chain[-2]["id"]}).code, "too_deep")

    def test_delete_place_refuses_contents_unless_asked(self):
        g = self.place()
        s = self.place("Étagère", g["id"])
        i = self.item("Marteau", s["id"])
        e = self.err({"action": "place.delete", "id": s["id"], "rev": s["rev"]})
        self.assertEqual((e.status, e.code, e.extra), (409, "not_empty", {"places": 0, "items": 1}))
        out = inv.apply({"action": "place.delete", "id": s["id"], "rev": s["rev"], "contents": "parent"})
        self.assertEqual(out["moved"], {"places": [], "items": [i["id"]], "to": g["id"]})
        self.assertEqual(inv.snapshot()["items"][0]["place"], g["id"], "contents go up one level, never lost")

    def test_restore_after_delete(self):
        g = self.place()
        i = self.item("Pince", g["id"], photos=[ASSET])
        gone = inv.apply({"action": "item.delete", "id": i["id"], "rev": i["rev"]})["deleted"]
        back = inv.apply({"action": "item.restore", "item": gone})["item"]
        self.assertEqual((back["id"], back["place"], back["photos"]), (i["id"], g["id"], [ASSET]))
        self.assertEqual(self.err({"action": "item.restore", "item": gone}).code, "exists")
        pg = inv.apply({"action": "place.delete", "id": g["id"], "rev": g["rev"], "contents": "parent"})["deleted"]
        pb = inv.apply({"action": "place.restore", "place": pg})["place"]
        self.assertEqual((pb["id"], pb["code"]), (g["id"], g["code"]), "same id and same label code")

    def test_restore_into_a_vanished_place_lands_unplaced(self):
        g = self.place()
        i = self.item("Clé", g["id"])
        gone = inv.apply({"action": "item.delete", "id": i["id"], "rev": i["rev"]})["deleted"]
        inv.apply({"action": "place.delete", "id": g["id"], "rev": g["rev"]})
        self.assertIsNone(inv.apply({"action": "item.restore", "item": gone})["item"]["place"])

    def test_photos_must_exist_in_the_image_store(self):
        self.assertEqual(self.err({"action": "item.create", "name": "x", "photos": ["asset-" + "b" * 24]}).code, "missing_photo")
        self.assertEqual(self.err({"action": "item.create", "name": "x", "photos": ["../../etc/passwd"]}).status, 400)
        self.assertEqual(self.err({"action": "item.create", "name": "x", "photos": [ASSET] * 7}).status, 400)

    def test_bulk_move(self):
        a, b = self.place("A"), self.place("B")
        ids = [self.item("i%d" % n, a["id"])["id"] for n in range(3)]
        out = inv.apply({"action": "item.move", "ids": ids, "place": b["id"]})
        self.assertTrue(all(x["place"] == b["id"] for x in out["items"]))
        self.assertEqual(self.err({"action": "item.move", "ids": ids + ["itm-" + "0" * 16], "place": a["id"]}).status, 404)
        self.assertTrue(all(i["place"] == b["id"] for i in inv.snapshot()["items"]), "all or nothing")

    def test_low_stock_and_summary(self):
        self.item("a", qty=2, min=5)
        self.item("b", qty=9, min=5)
        self.item("c", qty=0)
        self.assertEqual(inv.summary(), {"places": 0, "items": 3, "low": 1})

    def test_since_short_circuits(self):
        self.place()
        code, out = inv.http_get({"since": ["1"]})
        self.assertEqual(out, {"ok": True, "rev": 1, "unchanged": True})
        code, out = inv.http_get({"since": ["0"]})
        self.assertIn("places", out)

    def test_malformed_file_is_never_rewritten(self):
        path = inv.inventory_path(self.root)
        path.parent.mkdir(parents=True)
        path.write_bytes(b"{not json")
        code, out = inv.http_post({"action": "place.create", "name": "x"})
        self.assertEqual((code, out["code"]), (503, "storage_error"))
        self.assertEqual(path.read_bytes(), b"{not json")
        bad = inv._empty()
        bad["places"].append({"id": "plc-" + "0" * 16, "parent": "plc-" + "1" * 16, "name": "x", "kind": "box", "code": "AAAA", "note": "",
                              "photos": [], "created_at": 1.0, "updated_at": 1.0, "rev": 1})
        path.write_text(json.dumps(bad), "utf-8")
        self.assertEqual(inv.http_get({})[0], 503, "a dangling parent is refused, file kept")

    @unittest.skipUnless(hasattr(os, "symlink"), "symlinks")
    def test_redirected_folder_is_refused(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()
        try:
            os.symlink(elsewhere, self.root / inv.DIR_NAME, target_is_directory=True)
        except OSError:
            self.skipTest("no symlink permission")
        code, out = inv.http_post({"action": "place.create", "name": "x"})
        self.assertEqual(code, 503)
        self.assertEqual(list(elsewhere.iterdir()), [])

    def test_unknown_action(self):
        self.assertEqual(inv.http_post({"action": "drop_tables"})[0], 400)
        self.assertEqual(inv.http_post({"action": "item.update", "id": "itm-x", "rev": 1})[0], 404)


class WiringTests(unittest.TestCase):
    def test_bridge_routes_and_assets(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertEqual(src.count('raw == "/api/inventory"'), 2)
        self.assertIn('<script src="/assets/hq-inventory.js"></script>', src)
        self.assertIn('data-nav="inventaire"', src)
        self.assertIn('data-panel="inventaire"', src)

    def test_stdlib_only(self):
        import ast
        tree = ast.parse((Path(__file__).resolve().parents[1] / "hq_inventory.py").read_text(encoding="utf-8"))
        mods = set()
        for n in ast.walk(tree):
            if isinstance(n, ast.Import):
                mods |= {a.name.split(".")[0] for a in n.names}
            elif isinstance(n, ast.ImportFrom):
                mods.add((n.module or "").split(".")[0])
        self.assertTrue(mods <= {"__future__", "json", "os", "re", "secrets", "threading", "time", "pathlib", "typing"}, mods)


if __name__ == "__main__":
    unittest.main()
