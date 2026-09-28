"""Face sketches must produce connected, closed, correctly sized solids."""
import copy
import importlib.util
import tempfile
import unittest
from pathlib import Path

import hq_drawings as D
import hq_solid as S
from tests.test_hq_solid import edge_counts, sample, volume


@unittest.skipUnless(importlib.util.find_spec("manifold3d"), "manifold3d optional runtime package")
class FaceSolidTests(unittest.TestCase):
    def feature(self, kind="extrude", *, side=False, depth=5, extent="blind"):
        plane = ({"origin": [100, 0, 0], "u": [0, 1, 0], "v": [0, 0, 1], "normal": [1, 0, 0]}
                 if side else {"origin": [0, 0, 20], "u": [1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, 1]})
        ring = [[10, 5], [20, 5], [20, 15], [10, 15]] if side else [[10, 10], [20, 10], [20, 20], [10, 20]]
        return {"id": "ff1", "type": kind, "extent": extent, "depth": depth, "plane": plane, "profile": ring}

    def document(self, feature):
        doc = sample()
        doc["version"] = 3
        doc["faceFeatures"] = [feature]
        return doc

    def check_mesh(self, doc, expected_volume):
        clean = D.validate_document(doc)
        mesh = S.build_mesh(clean)
        self.assertAlmostEqual(volume(mesh), expected_volume, places=2)
        self.assertTrue(all(count == 2 for count in edge_counts(mesh).values()))
        self.assertEqual(clean["faceFeatures"], doc["faceFeatures"])
        return mesh

    def test_top_and_side_additions(self):
        for side in (False, True):
            with self.subTest(side=side):
                self.check_mesh(self.document(self.feature(side=side)), 120500)

    def test_top_and_side_cuts(self):
        for side in (False, True):
            with self.subTest(side=side):
                self.check_mesh(self.document(self.feature("cut", side=side)), 119500)

    def test_bottom_face_add_and_cut(self):
        for kind, expected in (("extrude", 120500), ("cut", 119500)):
            with self.subTest(kind=kind):
                feature = self.feature(kind)
                feature["plane"] = {"origin": [100, 0, 0], "u": [-1, 0, 0], "v": [0, 1, 0], "normal": [0, 0, -1]}
                self.check_mesh(self.document(feature), expected)

    def test_side_through_cut(self):
        feature = self.feature("cut", side=True, extent="throughAll")
        self.check_mesh(self.document(feature), 110000)

    def test_stacked_face_feature(self):
        doc = self.document(self.feature())
        next_face = copy.deepcopy(self.feature(side=True))
        next_face["id"] = "ff2"
        next_face["plane"]["origin"] = [20, 10, 20]
        next_face["plane"]["u"] = [0, 1, 0]
        next_face["plane"]["v"] = [0, 0, 1]
        next_face["plane"]["normal"] = [1, 0, 0]
        next_face["profile"] = [[1, 1], [5, 1], [5, 4], [1, 4]]
        doc["faceFeatures"].append(next_face)
        # A second sketch can attach to the side of a newly added boss.
        self.check_mesh(doc, 120560)

    def test_reject_floating_or_outside_profile(self):
        for edit in (lambda f: f["plane"]["origin"].__setitem__(2, 21),
                     lambda f: f.__setitem__("profile", [[90, 10], [110, 10], [110, 20], [90, 20]])):
            f = self.feature()
            edit(f)
            with self.assertRaises(D.DrawingError):
                D.validate_document(self.document(f))

    def test_reject_bad_plane(self):
        f = self.feature()
        f["plane"]["normal"] = [0, 0, 2]
        with self.assertRaises(D.DrawingError):
            D.validate_document(self.document(f))

    def test_save_and_reopen_stl(self):
        doc = self.document(self.feature(side=True))
        png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlXKxEAAAAASUVORK5CYII="
        with tempfile.TemporaryDirectory() as td:
            result = D.save_drawing(Path(td), {"doc": doc, "name": "side", "source": "desktop", "png": png})
            self.assertIn("stl", result["files"])
            saved = D.open_drawing(Path(td), result["stem"])
            self.assertEqual(saved["doc"]["faceFeatures"], doc["faceFeatures"])


if __name__ == "__main__":
    unittest.main()
