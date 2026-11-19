"""Noms de fonctions et valeurs pilotées côté serveur: ce que l'atelier 3D enregistre doit revenir intact."""

import unittest
from unittest import mock

import hq_drawings as D

# Validation ends by building the part, which needs OpenCascade for a version-6 drawing. These tests are about the
# document fields, not the geometry: the mesh builder is stood in for so they run everywhere.
#
def no_mesh():
    return mock.patch("hq_solid.build_mesh", return_value=[])


def doc(feature_extra=None, params=None, version=6):
    base = {
        "format": D.FORMAT,
        "version": version,
        "units": "mm",
        "points": [{"id": "p1", "x": 0, "y": 0}, {"id": "p2", "x": 40, "y": 0},
                   {"id": "p3", "x": 40, "y": 20}, {"id": "p4", "x": 0, "y": 20}],
        "objects": [
            {"id": "l1", "type": "line", "p1": "p1", "p2": "p2"},
            {"id": "l2", "type": "line", "p1": "p2", "p2": "p3"},
            {"id": "l3", "type": "line", "p1": "p3", "p2": "p4"},
            {"id": "l4", "type": "line", "p1": "p4", "p2": "p1"},
        ],
        "features": [dict({"id": "f1", "type": "extrude", "profile": ["l1", "l2", "l3", "l4"],
                           "depth": 6, "extent": "blind"}, **(feature_extra or {}))],
    }
    if params:
        base["params"] = params
    return base


class FeatureNameTests(unittest.TestCase):
    def setUp(self):
        self._mesh = no_mesh()
        self._mesh.start()
        self.addCleanup(self._mesh.stop)

    def test_name_round_trips(self):
        out = D.validate_document(doc({"name": "  Semelle  "}))
        self.assertEqual(out["features"][0]["name"], "Semelle")

    def test_names_do_not_need_version_6(self):
        out = D.validate_document(doc({"name": "Base"} | {}, version=2))
        self.assertEqual(out["features"][0]["name"], "Base")

    def test_bad_names_are_refused(self):
        for name in ["", "   ", "x" * 41, "a\nb", 12, ["a"]]:
            with self.subTest(name=name):
                with self.assertRaises(D.DrawingError):
                    D.validate_document(doc({"name": name}))

    def test_absent_name_adds_no_key(self):
        self.assertNotIn("name", D.validate_document(doc())["features"][0])


class DrivenFeatureTests(unittest.TestCase):
    def setUp(self):
        self._mesh = no_mesh()
        self._mesh.start()
        self.addCleanup(self._mesh.stop)

    def test_driven_value_round_trips(self):
        out = D.validate_document(doc({"driven": {"depth": " epaisseur * 2 "}},
                                      params=[{"id": "v1", "name": "epaisseur", "expr": "3"}]))
        self.assertEqual(out["features"][0]["driven"], {"depth": "epaisseur * 2"})
        # the number stays the last resolved one: the mesh builder never sees an expression
        self.assertEqual(out["features"][0]["depth"], 6)

    def test_bad_driven_values_are_refused(self):
        cases = [
            {"driven": {}},
            {"driven": {"depth": ""}},
            {"driven": {"depth": "x" * 200}},
            {"driven": {"colour": "1"}},
            {"driven": {"depth": 12}},
            {"driven": "depth=2"},
            {"driven": {"depth": "a\nb"}},
        ]
        for extra in cases:
            with self.subTest(extra=extra):
                with self.assertRaises(D.DrawingError):
                    D.validate_document(doc(extra))

    def test_driven_needs_version_6(self):
        with self.assertRaises(D.DrawingError):
            D.validate_document(doc({"driven": {"depth": "3"}}, version=5))

    def test_a_feature_without_driven_adds_no_key(self):
        self.assertNotIn("driven", D.validate_document(doc())["features"][0])


class LiveDocTests(unittest.TestCase):
    """The shared-drawing hub validates a head without building geometry."""

    def test_live_doc_does_not_build(self):
        with mock.patch("hq_solid.build_mesh", side_effect=AssertionError("mesh built")):
            out = D.live_doc(doc({"name": "Semelle", "driven": {"depth": "3 + 3"}},
                                 params=[{"id": "v1", "name": "epaisseur", "expr": "3"}]))
        self.assertEqual(out["features"][0]["name"], "Semelle")
        self.assertEqual(out["features"][0]["driven"], {"depth": "3 + 3"})

    def test_live_doc_refuses_bad_fields(self):
        cases = [{"name": "x" * 41}, {"name": "a\tb"}, {"driven": {"depth": "x" * 200}},
                 {"driven": {"colour": "1"}}]
        for extra in cases:
            with self.subTest(extra=extra):
                with self.assertRaises(D.DrawingError):
                    D.live_doc(doc(extra))


if __name__ == "__main__":
    unittest.main()
