"""Phase J2 lineage tree: gallery links only (finish_of, inpaint_of), never the vault. Temp root."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_forge_gallery as G  # noqa: E402
import hq_forge_lineage as L  # noqa: E402
import test_hq_forge_fleet as TF  # noqa: E402
from test_hq_forge_inpaint import png, settings  # noqa: E402


def _edit_meta(root, image_id, change):
    path = G.gallery_dir(root) / image_id / "meta.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    change(data)
    path.write_text(json.dumps(data), encoding="utf-8")


class Lineage(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def store(self, origin=None):
        return G.store(self.root, png(), settings(), origin=origin)["id"]

    def test_tree_from_any_node_starts_at_the_oldest_ancestor(self):
        a = self.store()
        b = self.store({"finish_of": a})
        c = self.store({"inpaint_of": b})
        d = self.store({"inpaint_of": a})
        other = self.store()
        for focus in (a, b, c, d):
            status, out = L.lineage(self.root, focus)
            self.assertEqual(status, 200)
            self.assertEqual(out["root"], a)
            self.assertEqual(out["focus"], focus)
            byid = {n["id"]: n for n in out["nodes"]}
            self.assertEqual(set(byid), {a, b, c, d}, "an unrelated image is not in the tree")
            self.assertEqual((byid[a]["parent"], byid[a]["relation"], byid[a]["depth"]), (None, None, 0))
            self.assertEqual((byid[b]["parent"], byid[b]["relation"], byid[b]["depth"]), (a, "finish", 1))
            self.assertEqual((byid[c]["parent"], byid[c]["relation"], byid[c]["depth"]), (b, "inpaint", 2))
            self.assertEqual((byid[d]["relation"], byid[d]["depth"]), ("inpaint", 1))
        status, out = L.lineage(self.root, other)
        self.assertEqual((status, [n["id"] for n in out["nodes"]]), (200, [other]))
        self.assertNotIn("settings", json.dumps(out), "no prompt or settings in the tree")
        self.assertNotIn("prompt", json.dumps(out))

    def test_deleted_parent_and_cycles_are_safe(self):
        a = self.store()
        b = self.store({"finish_of": a})
        c = self.store({"inpaint_of": b})
        shutil.rmtree(G.gallery_dir(self.root) / a)
        status, out = L.lineage(self.root, c)
        self.assertEqual((status, out["root"], out["root_parent_missing"]), (200, b, True))
        _edit_meta(self.root, b, lambda m: m.setdefault("origin", {}).update({"finish_of": c}))
        status, out = L.lineage(self.root, c)
        self.assertEqual(status, 200)
        self.assertEqual(sorted(n["id"] for n in out["nodes"]), sorted({b, c}), "a cycle ends, each image once")

    def test_unknown_and_private_ids_are_404(self):
        for bad in ("img-" + "0" * 24, "pvt-" + "0" * 24, "../x", "", "img-XYZ"):
            with self.subTest(bad=bad):
                self.assertEqual(L.lineage(self.root, bad)[0], 404)
        self.assertIsNone(L.serve_get(self.root, "/api/forge/gallery/img-" + "0" * 24 + "/thumb"))

    def test_rejected_images_are_flagged_not_hidden(self):
        a = self.store()
        b = self.store({"finish_of": a})
        G.set_triage(self.root, b, "reject")
        out = L.lineage(self.root, a)[1]
        self.assertEqual({n["id"]: n["triage"] for n in out["nodes"]}, {a: "none", b: "reject"})


class LineageHttp(TF.FleetHttp):
    def test_lineage_route_is_admin_with_404(self):
        a = G.store(self.root, png(), settings())["id"]
        b = G.store(self.root, png(), settings(), origin={"inpaint_of": a})["id"]
        path = f"/api/forge/gallery/{b}/lineage"
        self.assertEqual(self.anon.json(path)[0], 401)
        self.assertEqual(self.upload.json(path)[0], 403)
        self.assertEqual(self.admin.json("/api/forge/gallery/img-" + "0" * 24 + "/lineage")[0], 404)
        self.assertEqual(self.admin.json("/api/forge/gallery/pvt-" + "0" * 24 + "/lineage")[0], 404)
        status, out = self.admin.json(path)
        self.assertEqual((status, out["root"], len(out["nodes"])), (200, a, 2))
        self.assertEqual(self.post(path, {})[0], 404, "read-only: no POST")


def load_tests(loader, tests, pattern):
    suite = unittest.TestSuite()
    suite.addTests(loader.loadTestsFromTestCase(Lineage))
    suite.addTest(LineageHttp("test_lineage_route_is_admin_with_404"))
    return suite


if __name__ == "__main__":
    unittest.main()
