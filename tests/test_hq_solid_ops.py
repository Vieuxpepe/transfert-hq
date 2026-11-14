"""Dessiner v5 features (hq_solid_ops): revolve, holes, shell, patterns, validation. Needs manifold3d (Python 3.13 here)."""
import importlib.util
import math
import unittest

import hq_drawings as D
import hq_solid as S
import hq_solid_ops as O
from tests.test_hq_solid import edge_counts, rectangle, sample, volume


def circle(doc, cx, cy, r, cid):
    doc["points"].append({"id": cid + "c", "x": cx, "y": cy})
    doc["objects"].append({"id": cid, "type": "circle", "center": cid + "c", "r": r})
    return cid


def v5(doc):
    doc["version"] = 5
    return doc


@unittest.skipUnless(importlib.util.find_spec("manifold3d"), "manifold3d optional runtime package")
class SolidOpsTests(unittest.TestCase):
    def build(self, doc):
        mesh = S.build_mesh(D.validate_document(doc))
        self.assertTrue(mesh)
        self.assertTrue(all(n == 2 for n in edge_counts(mesh).values()), "watertight")
        return mesh

    def test_legacy_drawings_keep_the_legacy_builder(self):
        doc = sample()
        self.assertFalse(O.uses_v5(doc))
        self.assertAlmostEqual(volume(S.build_mesh(D.validate_document(doc))), 100 * 60 * 20, places=3)

    def test_through_hole_removes_a_cylinder(self):
        doc = v5(sample())
        circle(doc, 30, 30, 5, "h1")
        doc["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M4", "fit": "clearance", "extent": "throughAll", "depth": 0})
        mesh = self.build(doc)
        r = O.HOLES_MM["M4"]["clearance"] / 2
        hole = 48 * 0.5 * r * r * math.sin(2 * math.pi / 48) * 20  # the 48-sided prism
        self.assertAlmostEqual(volume(mesh), 120000 - hole, delta=1e-3)

    def test_countersunk_insert_and_tap_holes(self):
        for fit, extent in (("countersunk", "throughAll"), ("insert", "blind"), ("tap", "blind")):
            doc = v5(sample())
            circle(doc, 50, 30, 5, "h1")
            doc["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M3", "fit": fit, "extent": extent,
                                    "depth": 8 if fit == "tap" else 0})
            removed = 120000 - volume(self.build(doc))
            self.assertGreater(removed, 0, fit)
        doc = v5(sample())
        circle(doc, 50, 30, 5, "h1")
        doc["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M3", "fit": "countersunk", "extent": "throughAll", "depth": 0})
        plain = v5(sample())
        circle(plain, 50, 30, 5, "h1")
        plain["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M3", "fit": "clearance", "extent": "throughAll", "depth": 0})
        self.assertLess(volume(self.build(doc)), volume(self.build(plain)), "the countersink takes more")

    def test_hole_units_follow_the_document(self):
        self.assertAlmostEqual(O.hole_geometry("M3", "clearance", "cm")["r"], 0.17)
        self.assertAlmostEqual(O.hole_geometry("M3", "insert", "mm")["insert_depth"], 5.7)

    def test_open_and_closed_shell(self):
        doc = v5(sample())
        doc["features"].append({"id": "f2", "type": "shell", "thickness": 2, "open": True})
        opened = volume(self.build(doc))
        self.assertAlmostEqual(opened, 120000 - 96 * 56 * 18, delta=1e-3)
        doc["features"][1]["open"] = False
        closed = volume(self.build(doc))
        self.assertAlmostEqual(closed, 120000 - 96 * 56 * 16, delta=1e-3)

    def test_linear_and_circular_patterns(self):
        doc = v5(sample())
        circle(doc, 10, 10, 2, "h1")
        doc["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M3", "fit": "clearance", "extent": "throughAll", "depth": 0})
        one = 120000 - volume(self.build(doc))
        doc["features"].append({"id": "f3", "type": "pattern", "source": "f2", "mode": "linear", "count": 4, "dx": 20, "dy": 0})
        self.assertAlmostEqual(120000 - volume(self.build(doc)), 4 * one, delta=1e-3)
        doc["features"][-1] = {"id": "f3", "type": "pattern", "source": "f2", "mode": "circular", "count": 6, "cx": 50, "cy": 30, "angle": 360}
        doc["features"][1]["at"] = ["h1"]
        doc["points"][-1]["x"], doc["points"][-1]["y"] = 50, 45
        self.assertAlmostEqual(120000 - volume(self.build(doc)), 6 * one, delta=1e-2)

    def test_revolve_makes_a_cylinder_resting_on_the_table(self):
        doc = v5({"format": D.FORMAT, "version": 5, "units": "mm", "mode": "construction",
                  "grid": {"spacing": 10, "visible": True, "snap": True}, "snap": {"angle": True, "angleStep": 15},
                  "points": [{"id": "a1", "x": 0, "y": 0}, {"id": "a2", "x": 0, "y": 40}], "objects": [], "constraints": [], "features": []})
        doc["objects"].append({"id": "ax", "type": "centerline", "p1": "a1", "p2": "a2"})
        prof = rectangle(doc, 0, 0, 10, 40, "r")
        doc["features"].append({"id": "f1", "type": "revolve", "profile": prof, "axis": "ax", "angle": 360})
        mesh = self.build(doc)
        self.assertAlmostEqual(volume(mesh), 96 * 0.5 * 100 * math.sin(2 * math.pi / 96) * 40, delta=1e-2)
        zs = [p[2] for t in mesh for p in t]
        self.assertAlmostEqual(min(zs), 0, places=6)
        ys = [p[1] for t in mesh for p in t]
        self.assertAlmostEqual(min(ys), 0, places=6)
        self.assertAlmostEqual(max(ys), 40, places=6, msg="the part lies along its axis, in sketch coordinates")
        doc["features"].append({"id": "f2", "type": "shell", "thickness": 2, "open": False})
        self.assertLess(volume(self.build(doc)), volume(mesh))

    def test_refusals(self):
        doc = v5(sample())
        doc["features"].append({"id": "f2", "type": "pattern", "source": "f1", "mode": "linear", "count": 3, "dx": 5, "dy": 0})
        with self.assertRaises(D.DrawingError):
            D.validate_document(doc)
        doc = sample()
        doc["features"].append({"id": "f2", "type": "shell", "thickness": 2, "open": True})
        with self.assertRaises(D.DrawingError):
            D.validate_document(doc)  # version 2 cannot hold a v5 feature
        doc = v5(sample())
        doc["features"].append({"id": "f2", "type": "shell", "thickness": 40, "open": True})
        with self.assertRaisesRegex(D.DrawingError, "trop épaisse"):
            D.validate_document(doc)  # validation builds the part: kernel refusals come back as DrawingError
        doc = v5(sample())
        circle(doc, 300, 300, 5, "h1")
        doc["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M3", "fit": "clearance", "extent": "throughAll", "depth": 0})
        with self.assertRaisesRegex(D.DrawingError, "aucune matière"):
            D.validate_document(doc)


if __name__ == "__main__":
    unittest.main()
