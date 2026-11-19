"""Paramètres nommés et cotes pilotantes côté serveur: ce qui s'enregistre est ce qui se reconstruit."""

import unittest

import hq_drawings as D


def base(**kw):
    doc = {
        "format": D.FORMAT,
        "version": 6,
        "units": "mm",
        "points": [{"id": "p1", "x": 0, "y": 0}, {"id": "p2", "x": 10, "y": 0}],
        "objects": [{"id": "l1", "type": "line", "p1": "p1", "p2": "p2"}],
        "constraints": [],
    }
    doc.update(kw)
    return doc


def dim(**kw):
    item = {"id": "d1", "type": "dim_linear", "a": [0, 0], "b": [10, 0], "offset": 5, "label": "10"}
    item.update(kw)
    return item


class ParamTests(unittest.TestCase):
    def test_parameters_round_trip(self):
        out = D.validate_document(base(params=[{"id": "v1", "name": "largeur", "expr": " 120 "},
                                               {"id": "v2", "name": "marge", "expr": "largeur/10"}]))
        self.assertEqual(out["params"], [
            {"id": "v1", "name": "largeur", "expr": "120"},
            {"id": "v2", "name": "marge", "expr": "largeur/10"},
        ])

    def test_no_parameters_means_no_key(self):
        self.assertNotIn("params", D.validate_document(base()))

    def test_bad_parameters_are_refused(self):
        bad = [
            [{"id": "v1", "name": "2a", "expr": "1"}],
            [{"id": "v1", "name": "a", "expr": ""}],
            [{"id": "v1", "name": "a", "expr": "x" * 200}],
            [{"id": "v1", "name": "a", "expr": "1"}, {"id": "v2", "name": "a", "expr": "2"}],
            [{"id": "p1", "name": "a", "expr": "1"}],  # identifiant déjà pris par un point
            [{"name": "a", "expr": "1"}],
            [{"id": "v1", "name": "a", "expr": "1\n2"}],
            [{"id": f"v{i}", "name": f"p{i}", "expr": "1"} for i in range(41)],
        ]
        for params in bad:
            with self.subTest(params=params[:2]):
                with self.assertRaises(D.DrawingError):
                    D.validate_document(base(params=params))

    def test_parameters_need_version_6(self):
        with self.assertRaises(D.DrawingError):
            D.validate_document(base(version=5, params=[{"id": "v1", "name": "a", "expr": "1"}]))


class DrivenDimTests(unittest.TestCase):
    def test_driven_linear_dim_round_trips(self):
        out = D.validate_document(base(params=[{"id": "v1", "name": "largeur", "expr": "120"}],
                                       objects=[{"id": "l1", "type": "line", "p1": "p1", "p2": "p2"},
                                                dim(drive={"expr": "largeur", "points": ["p1", "p2"]})]))
        obj = [o for o in out["objects"] if o["id"] == "d1"][0]
        self.assertEqual(obj["drive"], {"expr": "largeur", "points": ["p1", "p2"]})

    def test_keep_label_is_kept(self):
        out = D.validate_document(base(objects=[dim(drive={"expr": "12", "points": ["p1", "p2"], "keepLabel": True})]))
        self.assertTrue(out["objects"][0]["drive"]["keepLabel"])

    def test_angle_dim_drive_needs_two_lines(self):
        angle = {"id": "d2", "type": "dim_angle", "c": [0, 0], "a": [10, 0], "b": [0, 10], "r": 5, "label": "90°"}
        out = D.validate_document(base(objects=[
            {"id": "l1", "type": "line", "p1": "p1", "p2": "p2"},
            {"id": "l2", "type": "line", "p1": "p1", "p2": "p2"},
            dict(angle, drive={"expr": "60", "lines": ["l1", "l2"], "vertex": "p1"}),
        ]))
        drv = [o for o in out["objects"] if o["id"] == "d2"][0]["drive"]
        self.assertEqual((drv["expr"], drv["vertex"], drv["lines"]), ("60", "p1", ["l1", "l2"]))

    def test_bad_drives_are_refused(self):
        cases = [
            dict(drive={"expr": "12", "points": ["p1"]}),
            dict(drive={"expr": "12", "points": ["p1", "pz"]}),
            dict(drive={"expr": ""}),
            dict(drive={"expr": "1", "points": ["p1", "p1"]}),
            dict(drive="12"),
            {"id": "l1", "type": "line", "p1": "p1", "p2": "p2", "drive": {"expr": "12", "points": ["p1", "p2"]}},
        ]
        for item in cases:
            with self.subTest(item=item):
                objs = [item] if item.get("type") == "line" else [dim(**item)]
                with self.assertRaises(D.DrawingError):
                    D.validate_document(base(objects=objs))

    def test_drive_needs_version_6(self):
        with self.assertRaises(D.DrawingError):
            D.validate_document(base(version=5, objects=[dim(drive={"expr": "12", "points": ["p1", "p2"]})]))

    def test_a_driven_dim_without_its_parameter_still_saves(self):
        # une expression peut nommer un paramètre retiré: la cote reste, la reconstruction le dira
        out = D.validate_document(base(objects=[dim(drive={"expr": "disparu", "points": ["p1", "p2"]})]))
        self.assertEqual(out["objects"][0]["drive"]["expr"], "disparu")


if __name__ == "__main__":
    unittest.main()
