"""Convex edge fillets produce valid solids and reject unsupported geometry."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

import hq_drawings as D
import hq_round_solid as R
import hq_solid as S
from tests.test_hq_face_solid import FaceSolidTests
from tests.test_hq_solid import edge_counts, rectangle, sample, volume


@unittest.skipUnless(importlib.util.find_spec("manifold3d"), "manifold3d optional runtime package")
class RoundSolidTests(unittest.TestCase):
    def base(self):
        doc = sample()
        doc["version"] = 3
        return doc

    def round(self, doc, edge, radius=2):
        doc["roundFeatures"] = [{"id": "rf1", "a": edge["a"], "b": edge["b"], "radius": radius}]
        return D.validate_document(doc)

    def test_box_edge_is_a_real_closed_fillet(self):
        doc = self.base()
        original = S.build_mesh(doc)
        self.assertEqual(len(R.eligible_edges(original)), 12)
        clean = self.round(doc, R.eligible_edges(original)[0])
        rounded = S.build_mesh(clean)
        self.assertLess(volume(rounded), volume(original))
        self.assertTrue(all(n == 2 for n in edge_counts(rounded).values()))
        self.assertEqual(clean["roundFeatures"][0]["radius"], 2)

    def test_round_on_newly_extruded_face(self):
        doc = self.base()
        doc["faceFeatures"] = [FaceSolidTests().feature()]
        original = S.build_mesh(doc)
        edge = next(e for e in R.eligible_edges(original) if all(abs(p[2] - 25) < 1e-6 for p in (e["a"], e["b"])))
        rounded = S.build_mesh(self.round(doc, edge, 1))
        self.assertLess(volume(rounded), volume(original))
        self.assertTrue(all(n == 2 for n in edge_counts(rounded).values()))

    def test_two_separate_rounds(self):
        doc = self.base()
        edges = R.eligible_edges(S.build_mesh(doc))
        first = edges[0]
        second = next(e for e in edges if not set((first["a"], first["b"])) & set((e["a"], e["b"]))
                      and abs(first["a"][2] - e["a"][2]) < 1e-6 and abs(first["b"][2] - e["b"][2]) < 1e-6)
        doc["roundFeatures"] = [{"id": "rf1", "a": first["a"], "b": first["b"], "radius": 1},
                                {"id": "rf2", "a": second["a"], "b": second["b"], "radius": 1}]
        rounded = S.build_mesh(D.validate_document(doc))
        self.assertTrue(all(n == 2 for n in edge_counts(rounded).values()))
        self.assertLess(volume(rounded), volume(S.build_mesh(self.base())))

    def test_concave_pocket_edge_not_offered(self):
        doc = self.base()
        cut = rectangle(doc, 20, 10, 50, 40, "b")
        doc["features"].append({"id": "f2", "type": "cut", "profile": cut, "depth": 8, "extent": "blind"})
        edges = R.eligible_edges(S.build_mesh(doc))
        self.assertFalse(any(all(abs(p[2] - 12) < 1e-6 for p in (e["a"], e["b"])) for e in edges))

    def test_reject_radius_that_crosses_solid(self):
        doc = self.base()
        edge = R.eligible_edges(S.build_mesh(doc))[0]
        with self.assertRaises(D.DrawingError):
            self.round(doc, edge, 50)

    def test_reject_stale_or_interior_edge(self):
        doc = self.base()
        with self.assertRaises(D.DrawingError):
            self.round(doc, {"a": [1, 1, 1], "b": [2, 1, 1]}, 1)

    def test_save_reopen_stl(self):
        doc = self.base()
        edge = R.eligible_edges(S.build_mesh(doc))[0]
        doc = self.round(doc, edge)
        png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlXKxEAAAAASUVORK5CYII="
        with tempfile.TemporaryDirectory() as td:
            result = D.save_drawing(Path(td), {"doc": doc, "name": "round", "source": "desktop", "png": png})
            self.assertIn("stl", result["files"])
            reopened = D.open_drawing(Path(td), result["stem"])
            self.assertEqual(reopened["doc"]["roundFeatures"], doc["roundFeatures"])


if __name__ == "__main__":
    unittest.main()
