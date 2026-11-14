"""Exact (B-rep) Dessiner v6 builder (hq_solid_occ). Needs cadquery-ocp-novtk; skipped otherwise."""
import importlib.util
import math
import unittest

import hq_solid_occ as O
from tests.test_hq_solid import edge_counts, volume


def doc6(**extra):
    d = {"format": "transfert-hq-sketch", "version": 6, "units": "mm", "mode": "construction",
         "grid": {"spacing": 10, "visible": True, "snap": True}, "snap": {"angle": True, "angleStep": 15},
         "points": [], "objects": [], "constraints": [], "features": [], "sketches": []}
    d.update(extra)
    return d


def rect(d, x0, y0, x1, y1, prefix, sketch=None):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for i, (x, y) in enumerate(pts):
        p = {"id": f"{prefix}p{i}", "x": x, "y": y}
        if sketch:
            p["sketch"] = sketch
        d["points"].append(p)
    ids = []
    for i in range(4):
        o = {"id": f"{prefix}l{i}", "type": "line", "p1": f"{prefix}p{i}", "p2": f"{prefix}p{(i + 1) % 4}"}
        if sketch:
            o["sketch"] = sketch
        d["objects"].append(o)
        ids.append(o["id"])
    return ids


def circle(d, cx, cy, r, cid, sketch=None):
    p = {"id": cid + "c", "x": cx, "y": cy}
    o = {"id": cid, "type": "circle", "center": cid + "c", "r": r}
    if sketch:
        p["sketch"] = o["sketch"] = sketch
    d["points"].append(p)
    d["objects"].append(o)
    return cid


@unittest.skipUnless(importlib.util.find_spec("OCP") and O.available(), "cadquery-ocp-novtk optional runtime package")
class OccTests(unittest.TestCase):
    def solid(self, d):
        shape = O.build_shape(d)
        self.assertIsNotNone(shape)
        mesh = O.triangles(shape)
        self.assertTrue(all(n == 2 for n in edge_counts(mesh).values()), "the tessellation is watertight")
        return shape, mesh

    def test_box_hole_fillet_exact(self):
        d = doc6()
        d["features"].append({"id": "f1", "type": "extrude", "profile": rect(d, 0, 0, 100, 60, "a"), "depth": 20, "extent": "blind"})
        circle(d, 30, 30, 4, "h1")
        d["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M3", "fit": "clearance", "extent": "throughAll", "depth": 0})
        shape, mesh = self.solid(d)
        self.assertAlmostEqual(O._volume(shape), 120000 - math.pi * 1.7 ** 2 * 20, places=3)
        self.assertAlmostEqual(volume(mesh), O._volume(shape), delta=O._volume(shape) * 2e-3, msg="the mesh follows the exact solid")
        verticals = [e for e in O.edges_of(shape) if e["line"] and abs(e["a"][0] - e["b"][0]) < 1e-9 and abs(e["a"][1] - e["b"][1]) < 1e-9 and e["a"][0] in (0.0, 100.0)]
        self.assertEqual(len(verticals), 4)
        d["features"].append({"id": "f3", "type": "fillet", "radius": 5, "edges": [{"a": e["a"], "b": e["b"], "m": e["m"]} for e in verticals]})
        shape, _ = self.solid(d)
        self.assertAlmostEqual(O._volume(shape), 120000 - math.pi * 1.7 ** 2 * 20 - 4 * (25 - 25 * math.pi / 4) * 20, places=3)
        round_top = [e for e in O.edges_of(shape) if not e["line"] and abs(e["a"][2] - 20) < 1e-9 and abs(e["m"][0] - 30) < 3]
        d["features"].append({"id": "f4", "type": "chamfer", "distance": 0.5, "edges": [{"a": round_top[0]["a"], "b": round_top[0]["b"], "m": round_top[0]["m"]}]})
        before = O._volume(shape)
        shape, _ = self.solid(d)
        self.assertLess(O._volume(shape), before, "a chamfer on a curved edge removes material")

    def test_shells_are_exact(self):
        for opened, expected in ((True, 120000 - 96 * 56 * 18), (False, 120000 - 96 * 56 * 16)):
            d = doc6()
            d["features"].append({"id": "f1", "type": "extrude", "profile": rect(d, 0, 0, 100, 60, "a"), "depth": 20, "extent": "blind"})
            d["features"].append({"id": "f2", "type": "shell", "thickness": 2, "open": opened})
            shape, _ = self.solid(d)
            self.assertAlmostEqual(O._volume(shape), expected, places=3)

    def test_arc_profile_and_a_boss_on_a_side_plane(self):
        d = doc6(sketches=[{"id": "sk1", "name": "Face avant", "plane": "XZ", "offset": 0}])
        # a 40 x 20 slot: two straight sides and two half circles
        d["points"] += [{"id": "q0", "x": 0, "y": 0}, {"id": "q1", "x": 40, "y": 0}, {"id": "q2", "x": 40, "y": 20}, {"id": "q3", "x": 0, "y": 20},
                        {"id": "c0", "x": 0, "y": 10}, {"id": "c1", "x": 40, "y": 10}]
        d["objects"] += [{"id": "s0", "type": "line", "p1": "q0", "p2": "q1"}, {"id": "a1", "type": "arc", "center": "c1", "p1": "q1", "p2": "q2"},
                         {"id": "s1", "type": "line", "p1": "q2", "p2": "q3"}, {"id": "a0", "type": "arc", "center": "c0", "p1": "q3", "p2": "q0"}]
        d["features"].append({"id": "f1", "type": "extrude", "profile": ["s0", "a1", "s1", "a0"], "depth": 5, "extent": "blind"})
        shape, _ = self.solid(d)
        self.assertAlmostEqual(O._volume(shape), (40 * 20 + math.pi * 100) * 5, places=3)
        # a boss drawn on the XZ plane (y = 0 face) grows along -Y
        rect(d, 10, 1, 20, 4, "b", sketch="sk1")
        d["features"].append({"id": "f2", "type": "extrude", "profile": ["bl0", "bl1", "bl2", "bl3"], "depth": 3, "extent": "blind", "op": "add"})
        shape, _ = self.solid(d)
        box, _span = O._bounds(shape)
        self.assertAlmostEqual(box[1], -3, places=6, msg="the boss sticks out of the front face")
        self.assertAlmostEqual(O._volume(shape), (40 * 20 + math.pi * 100) * 5 + 10 * 3 * 3, places=3)

    def test_revolve_sweep_loft(self):
        d = doc6()
        rect(d, 0, 0, 10, 40, "r")
        d["points"] += [{"id": "x0", "x": 0, "y": -5}, {"id": "x1", "x": 0, "y": 50}]
        d["objects"].append({"id": "ax", "type": "centerline", "p1": "x0", "p2": "x1"})
        d["features"].append({"id": "f1", "type": "revolve", "profile": ["rl0", "rl1", "rl2", "rl3"], "axis": "ax", "angle": 360})
        shape, _ = self.solid(d)
        self.assertAlmostEqual(O._volume(shape), math.pi * 100 * 40, places=2, msg="an exact cylinder, not a 96-gon")
        # sweep a Ø6 circle along an L path drawn on the XZ plane
        s = doc6(sketches=[{"id": "path", "name": "Chemin", "plane": "XZ", "offset": 0}])
        circle(s, 0, 0, 3, "pc")
        s["points"] += [{"id": "w0", "x": 0, "y": 0, "sketch": "path"}, {"id": "w1", "x": 0, "y": 40, "sketch": "path"}, {"id": "w2", "x": 30, "y": 40, "sketch": "path"}]
        s["objects"] += [{"id": "g0", "type": "line", "p1": "w0", "p2": "w1", "sketch": "path"}, {"id": "g1", "type": "line", "p1": "w1", "p2": "w2", "sketch": "path"}]
        s["features"].append({"id": "f1", "type": "sweep", "profile": ["pc"], "path": ["g0", "g1"]})
        shape, _ = self.solid(s)
        self.assertGreater(O._volume(shape), math.pi * 9 * 60)
        # loft a circle into a square 30 mm above
        l = doc6(sketches=[{"id": "top", "name": "Haut", "plane": "XY", "offset": 30}])
        circle(l, 0, 0, 10, "lc")
        sq = rect(l, -8, -8, 8, 8, "t", sketch="top")
        l["features"].append({"id": "f1", "type": "loft", "profiles": [["lc"], sq]})
        shape, _ = self.solid(l)
        self.assertTrue(8000 < O._volume(shape) < 9500)

    def test_suppress_rollback_pattern(self):
        d = doc6()
        d["features"].append({"id": "f1", "type": "extrude", "profile": rect(d, 0, 0, 100, 60, "a"), "depth": 20, "extent": "blind"})
        circle(d, 10, 10, 2, "h1")
        d["features"].append({"id": "f2", "type": "hole", "at": ["h1"], "standard": "M3", "fit": "clearance", "extent": "throughAll", "depth": 0})
        d["features"].append({"id": "f3", "type": "pattern", "source": "f2", "mode": "linear", "count": 4, "dx": 20, "dy": 0})
        one = math.pi * 1.7 ** 2 * 20
        self.assertAlmostEqual(O._volume(O.build_shape(d)), 120000 - 4 * one, places=3)
        d["features"][2]["suppressed"] = True
        self.assertAlmostEqual(O._volume(O.build_shape(d)), 120000 - one, places=3)
        d["features"][2]["suppressed"] = False
        d["rollback"] = 1
        self.assertAlmostEqual(O._volume(O.build_shape(d)), 120000, places=3)

    def test_step_and_mass(self):
        d = doc6(units="cm")
        d["features"].append({"id": "f1", "type": "extrude", "profile": rect(d, 0, 0, 10, 6, "a"), "depth": 2, "extent": "blind"})
        data = O.step_bytes(d)
        self.assertTrue(data.startswith(b"ISO-10303-21;"))
        self.assertIn(b"MILLI", data.upper().replace(b".", b""))
        m = O.mass_properties(d)
        self.assertAlmostEqual(m["volume"], 120, places=6)
        self.assertEqual([round(x, 6) for x in m["size"]], [10, 6, 2])

    def test_refusals(self):
        from hq_solid import SolidError
        d = doc6()
        d["features"].append({"id": "f1", "type": "extrude", "profile": rect(d, 0, 0, 100, 60, "a"), "depth": 20, "extent": "blind"})
        d["features"].append({"id": "f2", "type": "fillet", "radius": 70, "edges": [{"a": [0, 0, 0], "b": [0, 0, 20], "m": [0, 0, 10]}]})  # wider than the 60 mm face
        with self.assertRaises(SolidError):
            O.build_shape(d)
        d["features"][1] = {"id": "f2", "type": "fillet", "radius": 2, "edges": [{"a": [500, 0, 0], "b": [500, 0, 20], "m": [500, 0, 10]}]}
        with self.assertRaisesRegex(SolidError, "Arête introuvable"):
            O.build_shape(d)
        d["features"][1] = {"id": "f2", "type": "shell", "thickness": 40, "open": True}
        with self.assertRaisesRegex(SolidError, "trop épaisse"):
            O.build_shape(d)


if __name__ == "__main__":
    unittest.main()


class V6FormatTests(unittest.TestCase):
    """The v6 document rules (no geometry engine needed: no features)."""

    def base(self):
        d = doc6(sketches=[{"id": "sk1", "name": "Avant", "plane": "XZ", "offset": 5}])
        d["points"] += [{"id": "c", "x": 0, "y": 0}, {"id": "a", "x": 10, "y": 0}, {"id": "b", "x": 0, "y": 10},
                        {"id": "q", "x": 1, "y": 1, "sketch": "sk1"}, {"id": "r", "x": 5, "y": 1, "sketch": "sk1"}]
        d["objects"] += [{"id": "arc1", "type": "arc", "center": "c", "p1": "a", "p2": "b"},
                         {"id": "l1", "type": "line", "p1": "a", "p2": "b"},
                         {"id": "l2", "type": "line", "p1": "q", "p2": "r", "sketch": "sk1"}]
        return d

    def test_valid_v6(self):
        import hq_drawings as D
        d = self.base()
        d["constraints"] = [{"id": "k1", "type": "horizontal", "line": "l2"}, {"id": "k2", "type": "radius", "item": "arc1", "value": 10},
                            {"id": "k3", "type": "tangent", "items": ["l1", "arc1"]}, {"id": "k4", "type": "fixed", "point": "c"}]
        out = D.validate_document(d)
        self.assertEqual(out["sketches"][0]["plane"], "XZ")
        self.assertEqual([o.get("sketch", "") for o in out["objects"]], ["", "", "sk1"])
        self.assertEqual([k["type"] for k in out["constraints"]], ["horizontal", "radius", "tangent", "fixed"])

    def test_face_sketch_side(self):
        import hq_drawings as D
        d = self.base()
        d["sketches"][0]["face"] = -1
        self.assertEqual(D.validate_document(d)["sketches"][0]["face"], -1, "a sketch on a face remembers which way is outward")
        for bad in (0, 2, True, "1"):
            d = self.base()
            d["sketches"][0]["face"] = bad
            with self.assertRaises(D.DrawingError):
                D.validate_document(d)

    def test_refusals(self):
        import hq_drawings as D
        old = self.base()
        old["version"] = 5
        with self.assertRaises(D.DrawingError):
            D.validate_document(old)  # sketches and arcs need v6
        bad = self.base()
        bad["objects"][2]["sketch"] = "nope"
        with self.assertRaises(D.DrawingError):
            D.validate_document(bad)
        mixed = self.base()
        mixed["objects"].append({"id": "l3", "type": "line", "p1": "a", "p2": "q"})  # one end on another plane
        with self.assertRaisesRegex(D.DrawingError, "autre esquisse"):
            D.validate_document(mixed)
        lopsided = self.base()
        lopsided["points"][2]["y"] = 12  # arc ends at different radii
        with self.assertRaisesRegex(D.DrawingError, "même distance"):
            D.validate_document(lopsided)
        k = self.base()
        k["constraints"] = [{"id": "k1", "type": "parallel", "items": ["l1", "arc1"]}]
        with self.assertRaises(D.DrawingError):
            D.validate_document(k)
        r = self.base()
        r["rollback"] = 3
        with self.assertRaises(D.DrawingError):
            D.validate_document(r)


@unittest.skipUnless(importlib.util.find_spec("OCP") and O.available(), "cadquery-ocp-novtk optional runtime package")
class V6RouteTests(unittest.TestCase):
    def test_preview_and_step(self):
        import hq_drawings as D
        d = doc6()
        d["features"].append({"id": "f1", "type": "extrude", "profile": rect(d, 0, 0, 30, 20, "a"), "depth": 10, "extent": "blind"})
        out = D.preview_mesh({"doc": d})
        self.assertTrue(out["exact"])
        self.assertEqual(len(out["edges"]), 12)
        self.assertAlmostEqual(out["mass"]["volume"], 6000, places=6)
        data, name = D.step_file({"doc": d, "name": "support moteur"})
        self.assertTrue(data.startswith(b"ISO-10303-21;"))
        self.assertTrue(name.endswith(".step"))
        legacy = dict(d, version=5)
        with self.assertRaises(D.DrawingError):
            D.step_file({"doc": legacy})
