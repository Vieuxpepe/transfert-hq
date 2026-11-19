"""Intent-first Dessiner: spec -> exact v6 solid -> parameter edit -> rebuild, and DFM.

The exact tests use OpenCascade (OCP), the same engine the v6 document uses. They are skipped when
the optional runtime is absent, exactly like tests/test_hq_solid_occ.py.
"""
from __future__ import annotations

import importlib.util
import json
import math
import tempfile
import unittest
from pathlib import Path

import hq_dfm
import hq_drawings
import hq_intent
import hq_inventory
import hq_params
import hq_print3d_filament
import hq_projects
import hq_solid
import hq_solid_occ
import hq_solid_ops
from tests.test_hq_solid import edge_counts, volume

EXAMPLE = "plate 100x60x6, four M6 holes 10mm from the edges, 3mm fillets"


def plate_volume(width=100.0, depth=60.0, thickness=6.0, radius=3.0, holes=4, diameter=6.6):
    area = width * depth - (4 - math.pi) * radius * radius - holes * math.pi * (diameter / 2) ** 2
    return area * thickness


class ParsingTests(unittest.TestCase):
    def test_natural_plate_spec_and_named_assumptions(self):
        spec = hq_intent.parse_intent(EXAMPLE)
        self.assertEqual((spec["width"], spec["depth"], spec["thickness"]), (100.0, 60.0, 6.0))
        self.assertEqual((spec["hole_count"], spec["hole_standard"], spec["hole_fit"]), (4, "M6", "clearance"))
        self.assertEqual(spec["hole_inset"], 10.0)
        self.assertEqual(spec["fillet_radius"], 3.0)
        self.assertEqual(spec["material"], "PLA")
        built = hq_intent.build_document(EXAMPLE)
        names = [a["name"] for a in built["doc"]["assumptions"]]
        self.assertTrue(any("Mati" in n for n in names))
        self.assertTrue(any("Orientation" in n for n in names))
        self.assertTrue(any("Cong" in n for n in names))
        self.assertTrue(all(a["id"].startswith("asm-") for a in built["doc"]["assumptions"]))

    def test_structured_spec_is_checked_and_unknown_fields_are_refused(self):
        spec = hq_intent.parse_intent({
            "kind": "plate", "width": "120", "depth": "80,5", "thickness": 5,
            "holes": {"count": 4, "standard": "M4", "fit": "clearance", "inset": 12},
            "fillet_radius": 2, "material": "PETG", "print_orientation": "z", "quantity": 2,
        })
        self.assertEqual((spec["width"], spec["depth"]), (120.0, 80.5))
        self.assertEqual(spec["material"], "PETG")
        self.assertEqual(spec["quantity"], 2)
        self.assertFalse(spec["assumed"]["material"])
        self.assertFalse(spec["assumed"]["no_holes"])
        with self.assertRaisesRegex(hq_intent.IntentError, "inconnu"):
            hq_intent.parse_intent({"kind": "plate", "width": 10, "depth": 10, "thickness": 2, "magic": 1})
        with self.assertRaisesRegex(hq_intent.IntentError, "non pris en charge"):
            hq_intent.parse_intent("gear 100x60x6")

    def test_parameter_expressions_use_the_document_language(self):
        values = hq_params.parameter_values({"params": [
            {"id": "p1", "name": "width", "expr": "100"},
            {"id": "p2", "name": "inset", "expr": "10"},
            {"id": "p3", "name": "pitch", "expr": "width - 2*inset"},
        ]})
        self.assertEqual(values["pitch"], 80.0)
        with self.assertRaisesRegex(hq_params.ParamError, "inconnue"):
            hq_params.parameter_values({"params": [{"id": "p1", "name": "x", "expr": "missing + 1"}]})

    def test_l_bracket_and_bosses_are_structured_with_named_assumptions(self):
        bracket = hq_intent.parse_intent("L bracket 80x60x6, four M6 holes 10mm from the edges")
        self.assertEqual((bracket["kind"], bracket["width"], bracket["depth"], bracket["height"],
                          bracket["thickness"]), ("l_bracket", 20.0, 80.0, 60.0, 6.0))
        self.assertFalse(bracket["assumed"]["height"])
        explicit = hq_intent.parse_intent({
            "kind": "L bracket", "width": 40, "depth": 90, "height": 70, "thickness": 5,
            "holes": {"count": 2, "standard": "M4", "inset": 12},
            "bosses": {"count": 2, "diameter": 12, "height": 4, "inset": 12},
        })
        self.assertEqual((explicit["kind"], explicit["height"]), ("l_bracket", 70.0))
        self.assertEqual((explicit["boss_count"], explicit["boss_diameter"], explicit["boss_height"]),
                         (2, 12.0, 4.0))
        natural = hq_intent.parse_intent(
            "plate 100x60x6, four M6 holes 10mm from the edges, "
            "four cylindrical bosses 10mm diameter 5mm high")
        self.assertEqual((natural["boss_count"], natural["boss_diameter"], natural["boss_height"]),
                         (4, 10.0, 5.0))
        with self.assertRaisesRegex(hq_intent.IntentError, "dépasser"):
            hq_intent.parse_intent({"kind": "plate", "width": 100, "depth": 60, "thickness": 6,
                                    "holes": {"count": 4, "standard": "M6", "inset": 10},
                                    "bosses": {"count": 4, "diameter": 7, "height": 4, "inset": 10}})
        rounded = hq_intent.parse_intent({"kind": "l_bracket", "width": 40, "depth": 90, "height": 70,
                                          "thickness": 5, "fillet_radius": 2})
        self.assertEqual(rounded["fillet_radius"], 2.0)


@unittest.skipUnless(importlib.util.find_spec("OCP") and hq_solid_occ.available(),
                     "cadquery-ocp-novtk optional runtime package")
class ExactIntentTests(unittest.TestCase):
    def test_spec_builds_an_ordinary_editable_v6_document(self):
        built = hq_intent.build_document(EXAMPLE)
        doc, mesh, solid = built["doc"], built["mesh"], built["solid"]
        self.assertEqual((doc["format"], doc["version"], doc["units"]), ("transfert-hq-sketch", 6, "mm"))
        self.assertEqual([p["name"] for p in doc["params"]],
                         ["width", "depth", "thickness", "hole_inset", "fillet_radius"])
        self.assertTrue(doc["constraints"])
        self.assertEqual([f["type"] for f in doc["features"]], ["extrude", "hole"])
        self.assertEqual([f["name"] for f in doc["features"]], ["Plaque de base", "Perçages M6"])
        self.assertEqual(doc["features"][0]["driven"], {"depth": "thickness"})
        self.assertTrue(solid["valid"])
        self.assertEqual(solid["solids"], 1)
        self.assertTrue(all(n == 2 for n in edge_counts(mesh).values()))
        self.assertAlmostEqual(volume(mesh), solid["volume_mm3"], delta=solid["volume_mm3"] * 2e-3)
        self.assertAlmostEqual(solid["volume_mm3"], plate_volume(), delta=2.0)
        box = solid["bounds"]
        self.assertAlmostEqual(box[3] - box[0], 100.0, places=3)
        self.assertAlmostEqual(box[4] - box[1], 60.0, places=3)
        self.assertAlmostEqual(box[5] - box[2], 6.0, places=3)
        # The document is accepted by the normal v6 validator, which builds the same exact solid.
        checked = hq_drawings.validate_document(doc)
        self.assertEqual(checked["version"], 6)
        self.assertAlmostEqual(hq_solid_occ.mass_properties(checked)["volume"], solid["volume_mm3"], delta=1.0)

    def test_parameter_edit_6_to_8_rebuilds_through_the_normal_validator(self):
        built = hq_intent.build_document(EXAMPLE)
        six = built["solid"]["volume_mm3"]
        edited = hq_intent.set_parameter(built["doc"], "thickness", "8")
        self.assertAlmostEqual(edited["solid"]["volume_mm3"], plate_volume(thickness=8.0), delta=2.0)
        self.assertGreater(edited["solid"]["volume_mm3"], six)
        self.assertEqual(edited["solid"]["bounds"][5] - edited["solid"]["bounds"][2], 8.0)
        self.assertIn({"id": "param-thickness", "name": "thickness", "expr": "8"}, edited["doc"]["params"])
        # Changing a sketch dimension also regenerates the profile and the hole positions.
        wider = hq_intent.set_parameter(edited["doc"], "width", "120")
        box = wider["solid"]["bounds"]
        self.assertAlmostEqual(box[3] - box[0], 120.0, places=3)
        self.assertAlmostEqual(wider["solid"]["volume_mm3"], plate_volume(width=120.0, thickness=8.0), delta=4.0)
        hp1 = next(p for p in wider["doc"]["points"] if p["id"] == "hp1")
        self.assertEqual(hp1["x"], 110.0)  # right-hand hole follows width - inset

    def test_l_bracket_rebuilds_its_leg_and_height_from_parameters(self):
        built = hq_intent.build_document({"kind": "l_bracket", "width": 80, "depth": 60,
                                          "height": 50, "thickness": 6})
        volume = lambda w, d, h, t: w * t * (d + h - t)
        self.assertAlmostEqual(built["solid"]["volume_mm3"], volume(80, 60, 50, 6), delta=1.0)
        self.assertEqual((built["solid"]["bounds"][3], built["solid"]["bounds"][4],
                          built["solid"]["bounds"][5]), (80.0, 60.0, 50.0))
        self.assertEqual([f["id"] for f in built["doc"]["features"]], ["f-base", "f-leg"])
        self.assertEqual([p["name"] for p in built["doc"]["params"]],
                         ["width", "depth", "height", "thickness", "hole_inset", "fillet_radius"])
        deeper = hq_intent.set_parameter(built["doc"], "thickness", "8")
        self.assertAlmostEqual(deeper["solid"]["volume_mm3"], volume(80, 60, 50, 8), delta=1.0)
        taller = hq_intent.set_parameter(deeper["doc"], "height", "70")
        self.assertAlmostEqual(taller["solid"]["volume_mm3"], volume(80, 60, 70, 8), delta=1.0)
        self.assertAlmostEqual(taller["solid"]["bounds"][5], 70.0, places=3)
        wider = hq_intent.set_parameter(taller["doc"], "width", "100")
        self.assertAlmostEqual(wider["solid"]["volume_mm3"], volume(100, 60, 70, 8), delta=1.0)
        self.assertAlmostEqual(wider["solid"]["bounds"][3], 100.0, places=3)
        rounded = hq_intent.build_document({"kind": "l_bracket", "width": 80, "depth": 60, "height": 50,
                                            "thickness": 6, "fillet_radius": 3})
        self.assertTrue(rounded["solid"]["valid"])
        self.assertEqual(rounded["solid"]["solids"], 1)
        self.assertLess(rounded["solid"]["volume_mm3"], built["solid"]["volume_mm3"])
        rounded_more = hq_intent.set_parameter(rounded["doc"], "fillet_radius", "6")
        self.assertTrue(rounded_more["solid"]["valid"])
        self.assertLess(rounded_more["solid"]["volume_mm3"], rounded["solid"]["volume_mm3"])

    def test_cylindrical_bosses_keep_one_exact_solid_through_parameter_edits(self):
        intent = {"kind": "plate", "width": 100, "depth": 60, "thickness": 6,
                  "fillet_radius": 3,
                  "holes": {"count": 4, "standard": "M6", "fit": "clearance", "inset": 10},
                  "bosses": {"count": 4, "diameter": 12, "height": 5, "inset": 10}}
        built = hq_intent.build_document(intent)
        area = 100 * 60 - (4 - math.pi) * 3 * 3
        hole_r = hq_solid_ops.hole_geometry("M6", "clearance", "mm")["r"]
        def expected(thickness, boss_height=5.0, boss_diameter=12.0):
            return (area * thickness + 4 * math.pi * (boss_diameter / 2) ** 2 * boss_height
                    - 4 * math.pi * hole_r ** 2 * (thickness + boss_height))
        self.assertAlmostEqual(built["solid"]["volume_mm3"], expected(6.0), delta=2.0)
        self.assertEqual(built["solid"]["solids"], 1)
        self.assertTrue(built["solid"]["valid"])
        self.assertEqual([f["id"] for f in built["doc"]["features"]],
                         ["f-base", "f-boss-0", "f-boss-1", "f-boss-2", "f-boss-3", "f-holes"])
        self.assertEqual([s["id"] for s in built["doc"]["sketches"]], ["sk-main", "sk-boss"])
        thicker = hq_intent.set_parameter(built["doc"], "thickness", "8")
        self.assertAlmostEqual(thicker["solid"]["volume_mm3"], expected(8.0), delta=2.0)
        taller = hq_intent.set_parameter(thicker["doc"], "boss_height", "8")
        self.assertAlmostEqual(taller["solid"]["volume_mm3"], expected(8.0, boss_height=8.0), delta=2.0)
        larger = hq_intent.set_parameter(taller["doc"], "boss_diameter", "13")
        self.assertAlmostEqual(larger["solid"]["volume_mm3"], expected(8.0, boss_height=8.0, boss_diameter=13.0), delta=2.0)
        moved = hq_intent.set_parameter(larger["doc"], "boss_inset", "15")
        bp0 = next(p for p in moved["doc"]["points"] if p["id"] == "bp0")
        self.assertEqual((bp0["x"], bp0["y"]), (15.0, 15.0))
        checked = hq_drawings.validate_document(moved["doc"])
        self.assertAlmostEqual(hq_solid_occ.mass_properties(checked)["volume"],
                               moved["solid"]["volume_mm3"], delta=1.0)

    def test_stale_numeric_depth_is_overridden_by_the_parameter_on_validation(self):
        built = hq_intent.build_document(EXAMPLE)
        raw = json.loads(json.dumps(built["doc"]))
        for feature in raw["features"]:
            feature["depth"] = 6
        for param in raw["params"]:
            if param["name"] == "thickness":
                param["expr"] = "10"
        checked = hq_drawings.validate_document(raw, build=False)
        self.assertEqual(next(f["depth"] for f in checked["features"] if f["id"] == "f-base"), 10.0)
        shape, mesh, solid = hq_intent._solid_info(checked)
        self.assertAlmostEqual(solid["volume_mm3"], plate_volume(thickness=10.0), delta=3.0)
        self.assertAlmostEqual(volume(mesh), solid["volume_mm3"], delta=solid["volume_mm3"] * 2e-3)

    def test_invalid_profile_is_refused_before_any_artifact_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(hq_intent.IntentError, "congé|trou"):
                hq_intent.build_document({
                    "kind": "plate", "width": 40, "depth": 30, "thickness": 4,
                    "holes": {"count": 4, "standard": "M6", "inset": 2}, "fillet_radius": 2,
                })
            self.assertEqual(list(Path(tmp).iterdir()), [])

    def test_thin_plate_is_flagged_and_not_silently_accepted(self):
        thin = hq_intent.build_document({
            "kind": "plate", "width": 100, "depth": 60, "thickness": 0.6,
            "holes": {"count": 4, "standard": "M6", "inset": 10}, "fillet_radius": 3,
        })
        report = hq_dfm.analyze(thin["doc"], thin["mesh"], bounds=thin["solid"]["bounds"],
                                orientation="Z", min_wall_mm=1.2, required_fit="clearance",
                                valid=thin["solid"]["valid"])
        self.assertFalse(report["ok"])
        self.assertFalse(report["wall"]["pass"])
        self.assertAlmostEqual(report["wall"]["measured_mm"], 0.6, places=2)
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(hq_intent.ManufacturingError) as raised:
                hq_intent.manufacture(
                    {"kind": "plate", "width": 100, "depth": 60, "thickness": 0.6,
                     "holes": {"count": 4, "standard": "M6", "inset": 10}, "fillet_radius": 3},
                    Path(tmp))
            self.assertIn("paroi", str(raised.exception))
            self.assertFalse(raised.exception.report["ok"])
            self.assertEqual(list(Path(tmp).glob("*.stl")), [])
            self.assertEqual(len(list(Path(tmp).glob("*.dfm.json"))), 1)

    def test_hole_clearance_uses_the_standard_fastener_table(self):
        built = hq_intent.build_document(EXAMPLE)
        report = hq_dfm.analyze(built["doc"], built["mesh"], bounds=built["solid"]["bounds"],
                                orientation="Z", required_fit="clearance", valid=built["solid"]["valid"])
        self.assertTrue(report["holes"]["ok"])
        self.assertEqual(report["holes"]["count"], 4)
        hole = report["holes"]["holes"][0]
        self.assertEqual((hole["standard"], hole["fit"]), ("M6", "clearance"))
        self.assertEqual(hole["actual_diameter_mm"], 6.6)
        self.assertEqual(hole["clearance_diameter_mm"], 6.6)
        self.assertGreater(hole["edge_margin_mm"], 1.2)
        self.assertGreater(report["holes"]["minimum_ligament_mm"], 1.2)
        tapped = hq_intent.build_document({
            "kind": "plate", "width": 100, "depth": 60, "thickness": 6,
            "holes": {"count": 4, "standard": "M6", "fit": "tap", "inset": 10},
        })
        wrong = hq_dfm.analyze(tapped["doc"], tapped["mesh"], bounds=tapped["solid"]["bounds"],
                               orientation="Z", required_fit="clearance", valid=tapped["solid"]["valid"])
        self.assertFalse(wrong["holes"]["ok"])
        self.assertFalse(wrong["holes"]["holes"][0]["pass"])

    def test_overhangs_bridges_and_bed_faces(self):
        def box(x0, x1, y0, y1, z0, z1):
            v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                 (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
            faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
            out = []
            for a, b, c, d in faces:
                out += [(v[a], v[b], v[c]), (v[a], v[c], v[d])]
            return out

        # A wall plus an arm whose underside is 8 mm above the build plate.
        mesh = box(0, 2, 0, 5, 0, 10) + box(2, 10, 0, 5, 8, 10)
        report = hq_dfm.analyze({"version": 6, "units": "mm", "features": []}, mesh,
                                bounds=(0, 0, 0, 10, 5, 10), orientation="Z")
        self.assertGreater(report["overhang"]["area_mm2"], 30)
        self.assertGreater(report["overhang"]["bridge_area_mm2"], 30)
        self.assertTrue(report["overhang"]["needs_support"])
        self.assertFalse(report["positioning"]["support_free"])
        # The same faces sitting on the bed are not overhangs.
        flat = box(0, 10, 0, 10, 0, 10)
        bed = hq_dfm.analyze({"version": 6, "units": "mm", "features": []}, flat,
                             bounds=(0, 0, 0, 10, 10, 10), orientation="Z")
        self.assertEqual(bed["overhang"]["area_mm2"], 0.0)
        self.assertFalse(bed["overhang"]["needs_support"])

    def test_one_action_writes_printable_artifacts_and_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = root / ".hq-agent-state"
            state.mkdir()
            (state / "print3d.json").write_text(json.dumps({
                "printers": [], "filament": {"currency": "$", "prices": {"PLA": 22.0},
                                             "default_price_kg": 25.0, "spool_g": 1000},
            }), encoding="utf-8")
            (state / "spools.json").write_text(json.dumps({"spools": [{
                "id": "s-abc123", "material": "PLA", "colour": "#FF0000", "initial_g": 1000,
                "remaining_g": 800, "name": "PLA rouge", "price_kg": 22.0,
            }]}), encoding="utf-8")
            old = dict(hq_inventory._cb)
            old_projects = dict(hq_projects._cb)
            hq_inventory.bind(root=root)
            hq_projects.bind(root=root)
            try:
                hq_inventory.apply({"action": "item.create", "name": "Filament PLA rouge", "qty": 500,
                                    "unit": "g", "tags": ["filament", "pla"]})
                hq_inventory.apply({"action": "item.create", "name": "Vis M6 x 16", "qty": 10,
                                    "unit": "pcs", "tags": ["visserie"]})
                project = hq_projects.apply({"action": "project.create", "name": "Plaque démo"})["project"]
                hq_projects.apply({"action": "bom.add", "id": project["id"], "rev": project["rev"],
                                   "bom": {"name": "Vis M6 x 16", "qty": 4, "unit": "pcs", "status": "have"}})
                report = hq_intent.manufacture(EXAMPLE, root / "out", root=root, project="Plaque démo")
            finally:
                hq_inventory._cb.clear()
                hq_inventory._cb.update(old)
                hq_projects._cb.clear()
                hq_projects._cb.update(old_projects)
            self.assertTrue(report["ok"])
            self.assertTrue(report["dfm"]["wall"]["pass"])
            self.assertTrue(report["dfm"]["holes"]["ok"])
            self.assertEqual(report["manufacturing"]["material"], "PLA")
            self.assertGreater(report["manufacturing"]["mass_g"], 0)
            self.assertGreater(report["manufacturing"]["cost"], 0)
            stock = report["manufacturing"]["stock"]
            self.assertTrue(stock["enough"])
            self.assertEqual(stock["spool_remaining_g"], 800.0)
            self.assertEqual(len(stock["material_items"]), 1)
            self.assertEqual(stock["fastener_qty"], 10)
            self.assertEqual([line["name"] for line in report["manufacturing"]["bom"]],
                             ["Filament PLA", "Vis M6"])
            self.assertEqual(report["manufacturing"]["project"]["name"], "Plaque démo")
            self.assertEqual(report["manufacturing"]["project"]["bom"][0]["name"], "Vis M6 x 16")
            self.assertTrue(report["assumptions"])
            files = {k: Path(v) for k, v in report["artifacts"].items()}
            for kind, path in files.items():
                self.assertTrue(path.is_file(), kind)
            self.assertTrue(files["stl"].read_bytes().startswith(b"Transfert"))
            self.assertTrue(files["step"].read_bytes().startswith(b"ISO-10303-21"))
            pdf = files["pdf"].read_bytes()
            self.assertTrue(pdf.startswith(b"%PDF"))
            self.assertIn(b"A1", pdf)  # the named assumptions reach the shop sheet
            self.assertIn(b"BOM", pdf)  # material/cost/stock summary on the shop sheet
            saved = json.loads(files["document"].read_text(encoding="utf-8"))
            self.assertEqual(saved["version"], 6)
            self.assertTrue(saved["assumptions"])
            self.assertTrue(saved["features"])


if __name__ == "__main__":
    unittest.main()
