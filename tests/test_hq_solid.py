"""3D mesh, STL, and v1 compatibility for Dessiner."""
import copy
import math
import struct
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import hq_drawings as D
import hq_solid as S


def rectangle(doc, x0, y0, x1, y1, prefix):
    ids = [prefix + str(i) for i in range(4)]
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    doc["points"].extend({"id": ids[i], "x": p[0], "y": p[1]} for i, p in enumerate(pts))
    lines = [prefix + "l" + str(i) for i in range(4)]
    doc["objects"].extend({"id": lines[i], "type": "line", "p1": ids[i], "p2": ids[(i + 1) % 4]} for i in range(4))
    return lines


def sample():
    d = {"format": D.FORMAT, "version": 2, "units": "mm", "mode": "construction",
         "grid": {"spacing": 10, "visible": True, "snap": True},
         "snap": {"angle": True, "angleStep": 15}, "points": [], "objects": [], "constraints": [], "features": []}
    outer = rectangle(d, 0, 0, 100, 60, "a")
    d["features"].append({"id": "f1", "type": "extrude", "profile": outer, "depth": 20, "extent": "blind"})
    return d


def volume(mesh):
    total = 0
    for a, b, c in mesh:
        cross = (b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0])
        total += sum(a[i] * cross[i] for i in range(3)) / 6
    return total


def edge_counts(mesh):
    counts = Counter()
    for tri in mesh:
        v = [tuple(round(x, 6) for x in p) for p in tri]
        for a, b in ((0, 1), (1, 2), (2, 0)):
            counts[tuple(sorted((v[a], v[b])))] += 1
    return counts


class SolidTests(unittest.TestCase):
    def check_manifold(self, mesh):
        self.assertTrue(mesh)
        self.assertTrue(all(v == 2 for v in edge_counts(mesh).values()), "every STL edge belongs to two faces")

    def test_base_extrusion(self):
        mesh = S.build_mesh(D.validate_document(sample()))
        self.check_manifold(mesh)
        self.assertAlmostEqual(volume(mesh), 100 * 60 * 20)

    def test_through_cut(self):
        d = sample()
        cut = rectangle(d, 20, 10, 50, 40, "b")
        d["features"].append({"id": "f2", "type": "cut", "profile": cut, "depth": 0, "extent": "throughAll"})
        mesh = S.build_mesh(D.validate_document(d))
        self.check_manifold(mesh)
        self.assertAlmostEqual(volume(mesh), (100 * 60 - 30 * 30) * 20)

    def test_blind_cut(self):
        d = sample()
        cut = rectangle(d, 20, 10, 50, 40, "b")
        d["features"].append({"id": "f2", "type": "cut", "profile": cut, "depth": 8, "extent": "blind"})
        mesh = S.build_mesh(D.validate_document(d))
        self.check_manifold(mesh)
        self.assertAlmostEqual(volume(mesh), 100 * 60 * 20 - 30 * 30 * 8)

    def test_construction_geometry_is_never_a_profile(self):
        d = sample()
        d["objects"][0]["construction"] = True  # one side of the base rectangle is reference only
        with self.assertRaisesRegex((D.DrawingError, S.SolidError), "construction"):
            S.build_mesh(D.validate_document(d))
        raw = sample()
        raw["objects"][0]["construction"] = True
        with self.assertRaisesRegex(S.SolidError, "construction"):
            S.build_mesh(raw)

    def test_circle_cut_and_two_cuts(self):
        d = sample()
        d["points"].append({"id": "center", "x": 30, "y": 30})
        d["objects"].append({"id": "circle", "type": "circle", "center": "center", "r": 10})
        d["features"].append({"id": "f2", "type": "cut", "profile": ["circle"], "depth": 0, "extent": "throughAll"})
        cut = rectangle(d, 60, 10, 80, 25, "b")
        d["features"].append({"id": "f3", "type": "cut", "profile": cut, "depth": 5, "extent": "blind"})
        mesh = S.build_mesh(D.validate_document(d))
        self.check_manifold(mesh)
        self.assertAlmostEqual(volume(mesh), 100 * 60 * 20 - 20 * S._area(S._profile(d, ["circle"])) - 20 * 15 * 5, places=2)

    def test_ellipse_and_closed_spline_rings(self):
        d = {"format": D.FORMAT, "version": 6, "units": "mm", "mode": "construction",
             "grid": {"spacing": 10, "visible": True, "snap": True}, "snap": {"angle": True, "angleStep": 15},
             "points": [{"id": "e0", "x": 0, "y": 0}], "objects": [{"id": "e1", "type": "ellipse", "center": "e0", "rx": 10, "ry": 5}],
             "constraints": [], "features": [], "sketches": []}
        ring = S._profile(d, ["e1"])
        self.assertAlmostEqual(S._area(ring), math.pi * 50, delta=0.5)
        self.assertAlmostEqual(min(x for x, _ in ring), -10, places=6)
        self.assertAlmostEqual(max(y for _, y in ring), 5, places=6)
        bad = copy.deepcopy(d)
        bad["objects"][0]["rx"] = -10
        with self.assertRaisesRegex(S.SolidError, "Ellipse invalide"):
            S._profile(bad, ["e1"])

        pts = [(0, 0), (20, 0), (20, 20), (0, 20)]
        d["points"] += [{"id": f"s{i}", "x": x, "y": y} for i, (x, y) in enumerate(pts)]
        d["objects"].append({"id": "sp", "type": "spline", "pts": [f"s{i}" for i in range(4)], "closed": True})
        curve = S._profile(d, ["sp"])
        self.assertGreater(S._area(curve), 0)
        self.assertGreaterEqual(len(curve), 48, "a closed spline samples its wrap span")
        self.assertTrue(all(math.isfinite(x) and math.isfinite(y) for x, y in curve))

        d["objects"][-1].pop("closed")
        with self.assertRaisesRegex(S.SolidError, "ouverte"):
            S._profile(d, ["sp"])

        d["objects"].append({"id": "l1", "type": "line", "p1": "s0", "p2": "s1"})
        d["objects"][-2]["closed"] = True
        with self.assertRaisesRegex(S.SolidError, "seule"):
            S._profile(d, ["e1", "l1"])

    def test_concave_closed_loop(self):
        d = sample()
        d["points"] = []
        d["objects"] = []
        coords = [(0, 0), (80, 0), (80, 20), (30, 20), (30, 60), (0, 60)]
        d["points"] = [{"id": f"q{i}", "x": x, "y": y} for i, (x, y) in enumerate(coords)]
        d["objects"] = [{"id": f"e{i}", "type": "line", "p1": f"q{i}", "p2": f"q{(i + 1) % 6}"} for i in range(6)]
        d["features"][0]["profile"] = [o["id"] for o in d["objects"]]
        mesh = S.build_mesh(D.validate_document(d))
        self.check_manifold(mesh)
        self.assertAlmostEqual(volume(mesh), (80 * 20 + 30 * 40) * 20)

    def test_invalid_profiles_rejected(self):
        for edit in (lambda d: d["features"][0].update(profile=d["features"][0]["profile"][:3]),
                     lambda d: d["points"][2].update(x=20, y=-10)):
            d = sample()
            edit(d)
            with self.assertRaises(D.DrawingError):
                D.validate_document(d)
        d = sample()
        cut = rectangle(d, 0, 10, 20, 20, "b")
        d["features"].append({"id": "f2", "type": "cut", "profile": cut, "depth": 5, "extent": "blind"})
        with self.assertRaises(D.DrawingError):
            D.validate_document(d)

    def test_stl_units_and_save(self):
        d = sample()
        d["units"] = "cm"
        mesh = S.build_mesh(D.validate_document(d))
        stl = S.binary_stl(mesh, "cm")
        self.assertEqual(len(stl), 84 + 50 * len(mesh))
        self.assertEqual(struct.unpack_from("<I", stl, 80)[0], len(mesh))
        self.assertTrue(max(struct.unpack_from("<12fH", stl, 84)[3:12]) >= 1000)
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlXKxEAAAAASUVORK5CYII="
            result = D.save_drawing(root, {"doc": d, "name": "block", "source": "desktop", "png": png})
            self.assertIn("stl", result["files"])
            raw, ctype, _ = D.read_file(root, result["stem"], "stl")
            self.assertEqual(raw, stl)
            self.assertEqual(ctype, "model/stl")

    def test_v1_has_no_solid(self):
        d = sample()
        d["version"] = 1
        d.pop("features")
        self.assertEqual(D.validate_document(d)["features"], [])
        self.assertEqual(S.build_mesh(d), [])


if __name__ == "__main__":
    unittest.main()
