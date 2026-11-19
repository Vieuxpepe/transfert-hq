"""Phase 1 tests for Atelier 3D OrcaSlicer preset resolution, profiles, preflight, and live CLI slicing."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import zipfile

import hq_print3d
import hq_print3d_models as models
import hq_print3d_slicer as slicer_cfg


def _write_cube_stl(path: Path, size_xy: float = 20.0, height_z: float = 10.0) -> None:
    s = float(size_xy)
    h = float(height_z)
    tris = [
        ((0, 0, -1), [(0, 0, 0), (s, s, 0), (s, 0, 0)]),
        ((0, 0, -1), [(0, 0, 0), (0, s, 0), (s, s, 0)]),
        ((0, 0, 1), [(0, 0, h), (s, 0, h), (s, s, h)]),
        ((0, 0, 1), [(0, 0, h), (s, s, h), (0, s, h)]),
        ((0, -1, 0), [(0, 0, 0), (s, 0, 0), (s, 0, h)]),
        ((0, -1, 0), [(0, 0, 0), (s, 0, h), (0, 0, h)]),
        ((0, 1, 0), [(0, s, 0), (s, s, h), (s, s, 0)]),
        ((0, 1, 0), [(0, s, 0), (0, s, h), (s, s, h)]),
        ((-1, 0, 0), [(0, 0, 0), (0, 0, h), (0, s, h)]),
        ((-1, 0, 0), [(0, 0, 0), (0, s, h), (0, s, 0)]),
        ((1, 0, 0), [(s, 0, 0), (s, s, h), (s, 0, h)]),
        ((1, 0, 0), [(s, 0, 0), (s, s, 0), (s, s, h)]),
    ]
    buf = bytearray(b"test cube".ljust(80, b" ") + struct.pack("<I", len(tris)))
    for n, vs in tris:
        buf += struct.pack("<fff", *n)
        for v in vs:
            buf += struct.pack("<fff", *v)
        buf += struct.pack("<H", 0)
    path.write_bytes(bytes(buf))


class SlicerConfigResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        _write_cube_stl(self.share / "cube.stl")
        self._patches = [
            patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
            patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None),
        ]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()

    def test_canonical_printer_profiles_and_capabilities(self) -> None:
        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["Creator 5"]["bed"], (256.0, 256.0, 256.0))
        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["Creator 5"]["physical_extruders"], 4)
        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["Creator 5"]["max_tools"], 4)
        self.assertNotIn("0.2", slicer_cfg.CANONICAL_PROFILES["Creator 5"]["nozzles"])

        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["AD5X"]["bed"], (220.0, 220.0, 220.0))
        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["AD5X"]["physical_extruders"], 1)
        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["AD5X"]["max_tools"], 4)

        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["AD5M"]["bed"], (220.0, 220.0, 220.0))
        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["AD5M"]["origin"], (-110.0, -110.0))
        self.assertEqual(slicer_cfg.CANONICAL_PROFILES["AD5M"]["max_tools"], 1)

    def test_negative_profile_and_preset_validation_cases(self) -> None:
        # Unknown & generic profile names must fail closed
        for bad_model in ("NoSuchModel", "bambu", "flashforge", ""):
            with self.assertRaises(slicer_cfg.SlicerConfigError, msg=bad_model) as ctx:
                slicer_cfg.resolve_slicer_config(bad_model)
            self.assertEqual(ctx.exception.code, "unknown_printer_profile")

        # Unsupported nozzle for Creator 5 (no 0.2 nozzle)
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("Creator 5", nozzle="0.2")
        self.assertEqual(ctx.exception.code, "unsupported")

        # Unsupported nozzle / layer height combo (0.50 mm on 0.4 mm nozzle)
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("A1", nozzle="0.4", layer_height=0.50)
        self.assertEqual(ctx.exception.code, "unsupported")

        # Tool count mismatch (AD5M single-toolhead refuses 2 tools)
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("AD5M", used_tool_count=2)
        self.assertEqual(ctx.exception.code, "tool_out_of_range")

        # Unknown plate type
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("A1", plate_type="wood_plate")
        self.assertEqual(ctx.exception.code, "unsupported")

        # Broken inheritance chain & cycle & malformed JSON in custom profile root
        bad_root = self.root / "bad_profiles"
        for sub in ("machine", "process", "filament"):
            (bad_root / sub).mkdir(parents=True)
        (bad_root / "machine" / "m.json").write_text(json.dumps({
            "type": "machine",
            "name": "Bambu Lab A1 0.4 nozzle",
            "printer_model": "Bambu Lab A1",
            "nozzle_diameter": ["0.4"],
            "inherits": "MissingAncestor",
        }), encoding="utf-8")
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("A1", profile_roots=[bad_root])
        self.assertEqual(ctx.exception.code, "invalid_profile")

        # Inheritance cycle
        (bad_root / "machine" / "m.json").write_text(json.dumps({
            "type": "machine", "name": "Bambu Lab A1 0.4 nozzle",
            "printer_model": "Bambu Lab A1", "nozzle_diameter": ["0.4"], "inherits": "CycleB",
        }), encoding="utf-8")
        (bad_root / "machine" / "b.json").write_text(json.dumps({
            "type": "machine", "name": "CycleB", "inherits": "Bambu Lab A1 0.4 nozzle",
        }), encoding="utf-8")
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("A1", profile_roots=[bad_root])
        self.assertEqual(ctx.exception.code, "invalid_profile")

        # Malformed JSON
        (bad_root / "machine" / "b.json").write_text("{not valid json", encoding="utf-8")
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("A1", profile_roots=[bad_root])
        self.assertEqual(ctx.exception.code, "invalid_profile")

    def test_first_layer_height_is_not_silently_forced(self) -> None:
        # Uses synthetic clean root so test is independent of external profile install
        syn = self.root / "syn_profiles"
        for sub in ("machine", "process", "filament"):
            (syn / sub).mkdir(parents=True)
        (syn / "machine" / "a1.json").write_text(json.dumps({
            "type": "machine", "name": "Bambu Lab A1 0.4 nozzle",
            "printer_model": "Bambu Lab A1", "nozzle_diameter": ["0.4"],
            "default_print_profile": "0.12mm Standard @BBL A1",
        }), encoding="utf-8")
        (syn / "process" / "p.json").write_text(json.dumps({
            "type": "process", "name": "0.12mm Standard @BBL A1",
            "compatible_printers": ["Bambu Lab A1 0.4 nozzle"],
            "initial_layer_print_height": "0.14",
        }), encoding="utf-8")
        (syn / "filament" / "pla.json").write_text(json.dumps({
            "type": "filament", "name": "Bambu PLA Basic @BBL A1",
            "compatible_printers": ["Bambu Lab A1 0.4 nozzle"],
            "filament_type": ["PLA"], "cool_plate_temp": ["35"],
        }), encoding="utf-8")
        (syn / "filament" / "petg.json").write_text(json.dumps({
            "type": "filament", "name": "Bambu PETG Basic @BBL A1",
            "compatible_printers": ["Bambu Lab A1 0.4 nozzle"],
            "filament_type": ["PETG"], "cool_plate_temp": ["0"], "textured_plate_temp": ["70"],
        }), encoding="utf-8")

        res_auto = slicer_cfg.resolve_slicer_config("A1", material="PLA", layer_height=0.12, profile_roots=[syn])
        self.assertEqual(res_auto.process["initial_layer_print_height"], "0.14")

        res_explicit = slicer_cfg.resolve_slicer_config(
            "A1", material="PLA", layer_height=0.12, first_layer_height=0.16, profile_roots=[syn]
        )
        self.assertEqual(res_explicit.process["initial_layer_print_height"], "0.16")

        # PETG + Cool Plate explicitly refused when cool_plate_temp == 0
        with self.assertRaises(slicer_cfg.SlicerConfigError) as ctx:
            slicer_cfg.resolve_slicer_config("A1", material="PETG", plate_type="cool", profile_roots=[syn])
        self.assertEqual(ctx.exception.code, "unsupported")

    def test_preflight_dialect_rules_and_safety_boundaries(self) -> None:
        # Valid Bambu cutter non-extruding move + G2 arc + M191 chamber temp <= 70 pass
        ok_bambu = self.share / "ok_bambu.gcode"
        ok_bambu.write_text(
            "G90\nM83\nG17\nM191 S45\nM201.2 X10000 Y10000\n"
            "G1 X-48.2 Y254 F12000\nG1 X267 Y262.5 F12000\n"
            "G1 X120 Y120 Z0.2 F6000\nG2 X130 Y130 I5 J5 E0.8\nM983 F2.6 A0.3 H0.4\n",
            encoding="utf-8",
        )
        models.preflight_gcode(ok_bambu, 1, models.PRINTER_PROFILES["A1"])

        # Extruding at cutter X=-48.2 on A1 MUST fail (only non-extruding travel reaches cutter)
        bad_ext = self.share / "bad_cutter_ext.gcode"
        bad_ext.write_text("G90\nM83\nG1 X-48.2 Y254 E2.5 F1200\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as ctx:
            models.preflight_gcode(bad_ext, 1, models.PRINTER_PROFILES["A1"])
        self.assertEqual(ctx.exception.code, "out_of_bounds")

        # AD5M centered [-110..110] passes centered moves and rejects [0..220] out-of-range moves
        ok_ad5m = self.share / "ok_ad5m.gcode"
        ok_ad5m.write_text(
            "G90\nM83\nSET_VELOCITY_LIMIT ACCEL=5000\nG1 X-55 Y-110 F3000\nG1 X55 Y50 E1.2\n",
            encoding="utf-8",
        )
        models.preflight_gcode(ok_ad5m, 1, models.PRINTER_PROFILES["AD5M"])

        bad_ad5m = self.share / "bad_ad5m.gcode"
        bad_ad5m.write_text("G90\nM83\nG1 X130 Y10 E1.0\n", encoding="utf-8")
        with self.assertRaises(models.ModelError) as ctx:
            models.preflight_gcode(bad_ad5m, 1, models.PRINTER_PROFILES["AD5M"])
        self.assertEqual(ctx.exception.code, "out_of_bounds")

        # AD5X Klipper EXCLUDE_OBJECT_* passes; unsafe Klipper or extreme accel or Bambu M9833 rejected
        ok_ad5x = self.share / "ok_ad5x.gcode"
        ok_ad5x.write_text(
            "EXCLUDE_OBJECT_DEFINE NAME=cube_1 CENTER=110,110 POLYGON=[[100,100],[120,100]]\n"
            "SET_VELOCITY_LIMIT VELOCITY=300 ACCEL=8000\nSET_PRESSURE_ADVANCE ADVANCE=0.04\nG1 X110 Y110 E1.0\n",
            encoding="utf-8",
        )
        models.preflight_gcode(ok_ad5x, 1, models.PRINTER_PROFILES["AD5X"])

        # Valid Flashforge M104 N0/N1 preheat and Creator 5 EXCLUDE_OBJECT_* pass under marlin_ff
        ok_c5 = self.share / "ok_c5_flags.gcode"
        ok_c5.write_text(
            "EXCLUDE_OBJECT_DEFINE NAME=cube_1 CENTER=110,110 POLYGON=[[100,100],[120,100]]\n"
            "M104 T0 S220 N0\nM109 T1 S235 N1\nG1 X120 Y120 E1.0\n",
            encoding="utf-8",
        )
        models.preflight_gcode(ok_c5, 2, models.PRINTER_PROFILES["Creator 5"])

        for label, bad_body in (
            ("shutdown", "SHUTDOWN\n"),
            ("huge_accel", "SET_VELOCITY_LIMIT ACCEL=999999\n"),
            ("bambu_on_ad5x", "M9833\n"),
            ("chamber_hot", "M191 S120\n"),
            ("excl_bad_name", "EXCLUDE_OBJECT_DEFINE NAME=bad$cmd CENTER=10,10\n"),
            ("excl_bad_param", "EXCLUDE_OBJECT_DEFINE NAME=cube SCRIPT=evil\n"),
            ("m104_bad_n", "M104 T0 S220 N2\n"),
            ("m104_n_overtemp", "M104 T0 S350 N0\n"),
        ):
            gp = self.share / f"bad_{label}.gcode"
            gp.write_text(bad_body, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=label):
                models.preflight_gcode(gp, 2, models.PRINTER_PROFILES["AD5X"])

        for label, bad_bambu in (
            ("excl_on_bambu", "EXCLUDE_OBJECT_DEFINE NAME=cube_1 CENTER=100,100 POLYGON=[[90,90],[110,90]]\n"),
            ("m104_n_on_bambu", "M104 S220 N0\n"),
        ):
            gp = self.share / f"bad_{label}.gcode"
            gp.write_text(bad_bambu, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=label):
                models.preflight_gcode(gp, 1, models.PRINTER_PROFILES["A1"])

    def test_slicer_failure_non_utf8_stderr_and_timeout_handled_cleanly(self) -> None:
        mid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "cube.stl")
        syn = self.root / "syn2"
        for sub in ("machine", "process", "filament"):
            (syn / sub).mkdir(parents=True)
        (syn / "machine" / "m.json").write_text(json.dumps({
            "type": "machine", "name": "Bambu Lab A1 0.4 nozzle",
            "printer_model": "Bambu Lab A1", "nozzle_diameter": ["0.4"],
        }), encoding="utf-8")
        (syn / "process" / "p.json").write_text(json.dumps({
            "type": "process", "name": "0.20mm Standard @BBL A1",
            "compatible_printers": ["Bambu Lab A1 0.4 nozzle"],
        }), encoding="utf-8")
        (syn / "filament" / "f.json").write_text(json.dumps({
            "type": "filament", "name": "Bambu PLA Basic @BBL A1",
            "compatible_printers": ["Bambu Lab A1 0.4 nozzle"], "filament_type": ["PLA"],
        }), encoding="utf-8")

        # Non-UTF-8 byte stderr + nonzero rc
        fake_fail = type("P", (), {"returncode": 4294967291, "stderr": b"Erreur trancheur \x82\xff", "stdout": b""})()
        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", return_value=fake_fail):
            with self.assertRaises(models.ModelError) as ctx:
                self.ctl.library.slice_model(mid, "A1", profile_roots=[syn])
            self.assertEqual(ctx.exception.code, "slice_failed")

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=subprocess.TimeoutExpired("orca-slicer", 180)):
            with self.assertRaises(models.ModelError) as ctx:
                self.ctl.library.assemble_and_slice_plate([{"model_id": mid, "x": 100, "y": 100}], "A1", profile_roots=[syn])
            self.assertEqual(ctx.exception.code, "slice_failed")

    def test_controller_http_slice_uses_authoritative_stored_model(self) -> None:
        cfg = self.ctl.save_printer({
            "name": "Bureau", "kind": "flashforge", "model": "AD5M",
            "ip": "192.168.1.91", "serial": "SNAD5M001", "code": "1234",
        })
        pid = cfg["printers"][0]["id"]
        self.assertEqual(cfg["printers"][0]["model"], "AD5M")
        self.assertEqual(cfg["printers"][0]["bed"], {"x": 220.0, "y": 220.0, "z": 220.0})
        self.assertEqual(cfg["printers"][0]["capabilities"]["origin"], {"x": -110.0, "y": -110.0})
        self.assertIn("printer_catalog", cfg)

        mid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "cube.stl")
        seen: dict[str, str] = {}

        def fake_assemble(items, printer_model="", settings=None, bed=None, **_kw):
            seen["model"] = printer_model
            seen["bed"] = str(bed)
            seen["mat"] = str((settings or {}).get("material") or "")
            return {"model": {"id": mid, "name": "cube_studio.gcode.3mf"}, "info": {}}

        with patch.object(self.ctl.library, "assemble_and_slice_plate", side_effect=fake_assemble):
            # Calling /studio/slice with printer_id (no printer_model) resolves stored "AD5M"
            code, _ = self.ctl.http_post("/api/print3d/studio/slice", {
                "items": [{"model_id": mid, "x": 110, "y": 110}],
                "printer_id": pid,
                "settings": {"material": "PETG", "plate_type": "textured_pei"},
            })
            self.assertEqual(code, 200)
            self.assertEqual(seen["model"], "AD5M")
            self.assertEqual(seen["mat"], "PETG")

            # Mismatched client printer_model vs printer_id fails closed
            with self.assertRaises(hq_print3d.Print3dError) as ctx:
                self.ctl.http_post("/api/print3d/studio/slice", {
                    "items": [{"model_id": mid, "x": 110, "y": 110}],
                    "printer_id": pid,
                    "printer_model": "A1",
                })
            self.assertEqual(ctx.exception.code, "printer_mismatch")

            # Missing both printer_id and printer_model fails closed (never defaults to A1)
            with self.assertRaises(hq_print3d.Print3dError) as ctx2:
                self.ctl.http_post("/api/print3d/models/slice", {"id": mid})
            self.assertEqual(ctx2.exception.code, "missing_printer_model")

    def _synthetic_roots(self) -> list[Path]:
        syn = self.root / "syn_all"
        for sub in ("machine", "process", "filament"):
            (syn / sub).mkdir(parents=True, exist_ok=True)
        for mname, mod, noz in (
            ("Bambu Lab A1 0.4 nozzle", "Bambu Lab A1", "0.4"),
            ("Flashforge Adventurer 5M 0.4 nozzle", "Flashforge Adventurer 5M", "0.4"),
        ):
            (syn / "machine" / f"{mod}.json").write_text(json.dumps({
                "type": "machine", "name": mname, "printer_model": mod, "nozzle_diameter": [noz],
            }), encoding="utf-8")
            (syn / "process" / f"p_{mod}.json").write_text(json.dumps({
                "type": "process", "name": f"0.20mm Standard @{mod}", "compatible_printers": [mname],
            }), encoding="utf-8")
            for mat in ("PLA", "PETG"):
                (syn / "filament" / f"{mod}_{mat}.json").write_text(json.dumps({
                    "type": "filament", "name": f"Generic {mat} @{mod}",
                    "compatible_printers": [mname], "filament_type": [mat],
                }), encoding="utf-8")
        return [syn]

    def test_preflight_arc_geometry_and_fail_closed(self) -> None:
        a1 = models.PRINTER_PROFILES["A1"]
        c5 = models.PRINTER_PROFILES["Creator 5"]
        # Positive ordinary OrcaSlicer interior G2/G3 arcs + full interior circle + Creator 5 helical retract pass
        for label, gbody, prof in (
            ("ok_minor_cw", "G90\nM83\nG17\nG1 X100 Y100 Z0.2 F3000\nG2 X110 Y110 I10 J0 E0.8 F1200\n", a1),
            ("ok_r_format", "G90\nM83\nG17\nG1 X100 Y100 Z0.2\nG3 X110 Y110 R10 E0.6\n", a1),
            ("ok_full_circle", "G90\nM83\nG1 X128 Y128 Z0.2\nG2 I10 J0 P1 E2.5\n", a1),
            ("ok_c5_helical_retract", "G90\nM83\nG17\nG1 X128 Y128 Z10.0\nG2 Z10.4 I-0.731 J-1.673 P1 E-1 F30000\n", c5),
        ):
            p = self.share / f"{label}.gcode"
            p.write_text(gbody, encoding="utf-8")
            models.preflight_gcode(p, 1, prof)

        # P0 adversarial cases: endpoints inside bounds, arc sweeps outside bed (I/J, R, full circle) + invalid/ambiguous arcs
        bad_cases = (
            ("major_cw_ij_escape_x", "G90\nM83\nG1 X10 Y10 Z0.2 F3000\nG2 X10 Y20 I-15 J5 E2 F1200\n", "out_of_bounds"),
            ("major_cw_r_neg_escape_x", "G90\nM83\nG1 X10 Y10 Z0.2 F3000\nG2 X10 Y20 R-15.8114 E2 F1200\n", "out_of_bounds"),
            ("major_ccw_r_neg_escape_x", "G90\nM83\nG1 X250 Y10 Z0.2 F3000\nG3 X250 Y20 R-15.8114 E2 F1200\n", "out_of_bounds"),
            ("minor_ccw_ij_escape_y", "G90\nM83\nG1 X20 Y2 Z0.2\nG3 X30 Y2 I5 J-10 E1.0\n", "out_of_bounds"),
            ("full_circle_edge_escape", "G90\nM83\nG1 X250 Y128 Z0.2\nG2 I10 J0 E2.0\n", "out_of_bounds"),
            ("arc_g18_rejected", "G18\nG1 X100 Y100 Z10\nG2 X110 Y110 I5 J0\n", "unsafe_gcode"),
            ("arc_k_in_g17", "G17\nG1 X100 Y100 Z10\nG2 X110 Y110 I5 K2 E0.5\n", "unsafe_gcode"),
            ("arc_r_and_ij_mixed", "G90\nM83\nG1 X100 Y100 Z0.2\nG2 X110 Y110 I5 J0 R10 E0.5\n", "unsafe_gcode"),
            ("arc_r_zero_chord", "G90\nM83\nG1 X100 Y100 Z0.2\nG2 X100 Y100 R10 E0.5\n", "unsafe_gcode"),
            ("arc_impossible_r", "G90\nM83\nG1 X100 Y100 Z0.2\nG2 X140 Y100 R5 E0.5\n", "unsafe_gcode"),
            ("arc_radius_mismatch", "G90\nM83\nG1 X100 Y100 Z0.2\nG2 X130 Y100 I1 J0 E0.5\n", "unsafe_gcode"),
            ("arc_rel_g91_escape_x", "G90\nM83\nG1 X10 Y10 Z0.2\nG91\nG2 X0 Y10 I-15 J5 E2 F1200\n", "out_of_bounds"),
            ("arc_helical_z_oob_high", "G90\nM83\nG1 X100 Y100 Z255\nG2 X110 Y110 Z262 I5 J5 E1.0\n", "out_of_bounds"),
            ("arc_helical_z_oob_low", "G90\nM83\nG1 X100 Y100 Z2\nG3 X110 Y110 Z-5 I5 J5 E1.0\n", "out_of_bounds"),
            ("arc_duplicate_axis", "G90\nM83\nG1 X100 Y100 Z0.2\nG2 X110 X10 Y100 I5 J0 E1.0\n", "unsafe_gcode"),
        )
        for label, gbody, expected_code in bad_cases:
            p = self.share / f"{label}.gcode"
            p.write_text(gbody, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=label) as ctx:
                models.preflight_gcode(p, 1, a1)
            self.assertEqual(ctx.exception.code, expected_code, msg=label)

    def test_immutable_slice_artifacts_and_concurrent_uniqueness(self) -> None:
        syn = self._synthetic_roots()
        mid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "cube.stl")
        call_n = {"v": 0}
        lock = threading.Lock()

        def fake_slice(cmd, **kw):
            load_settings = cmd[cmd.index("--load-settings") + 1].split(";")
            proc_cfg = json.loads(Path(load_settings[1]).read_text(encoding="utf-8"))
            infill = proc_cfg.get("sparse_infill_density", "15%")
            with lock:
                call_n["v"] += 1
                seq = call_n["v"]
            out_dir = Path(cmd[cmd.index("--outputdir") + 1])
            out_name = cmd[cmd.index("--export-3mf") + 1]
            with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
                zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1", "sparse_infill_density": infill}))
                zf.writestr("Metadata/plate_1.gcode", f"; infill={infill} seq={seq}\nG90\nM83\nG1 X100 Y100 Z0.2\nG1 X110 Y100 E0.5\n")
            return type("P", (), {"returncode": 0, "stderr": b"", "stdout": b""})()

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_slice):
            r1 = self.ctl.library.assemble_and_slice_plate(
                [{"model_id": mid, "x": 128, "y": 128}], "A1", {"infill": 10}, profile_roots=syn,
            )
            b1 = self.ctl.library.resolve(r1["model"]["id"]).read_bytes()
            r2 = self.ctl.library.assemble_and_slice_plate(
                [{"model_id": mid, "x": 128, "y": 128}], "A1", {"infill": 90}, profile_roots=syn,
            )
            b2 = self.ctl.library.resolve(r2["model"]["id"]).read_bytes()

        self.assertNotEqual(r1["model"]["id"], r2["model"]["id"])
        self.assertNotEqual(r1["model"]["name"], r2["model"]["name"])
        self.assertEqual(self.ctl.library.resolve(r1["model"]["id"]).read_bytes(), b1)
        self.assertNotEqual(b1, b2)
        self.assertEqual(r1["model"]["slice_settings"]["infill"], "10%")
        self.assertEqual(r2["model"]["slice_settings"]["infill"], "90%")

        # Concurrent slices produce distinct immutable artifacts without collisions
        results: list[dict] = []
        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_slice):
            def worker(inf_val: int) -> None:
                results.append(self.ctl.library.slice_model(mid, "A1", infill=inf_val, profile_roots=syn))
            t1 = threading.Thread(target=worker, args=(25,))
            t2 = threading.Thread(target=worker, args=(65,))
            t1.start(); t2.start(); t1.join(); t2.join()
        self.assertEqual(len(results), 2)
        self.assertNotEqual(results[0]["id"], results[1]["id"])
        self.assertNotEqual(results[0]["slice_sha256"], results[1]["slice_sha256"])

        # No leftover dot-temp files visible in share or index; plan_print verifies SHA-256 and detects tampering
        self.assertEqual([p for p in self.share.glob(".hq-slice-*")], [])
        cfg_a1 = self.ctl.save_printer({"name": "A1 Check", "kind": "bambu", "model": "A1",
                                        "ip": "192.168.1.92", "serial": "03919A777777", "code": "12345678"})
        a1_id = cfg_a1["printers"][-1]["id"]
        self.ctl._on_link(a1_id, True, "")
        self.ctl._on_status(a1_id, {"state": "idle", "ams": [{"slot": 1, "material": "PLA", "colour": "#FFFFFF"}]})
        plan = self.ctl.plan_print(a1_id, r1["model"]["id"], 1)
        self.assertEqual(plan["sha256"], r1["model"]["slice_sha256"])
        # Mutating the published sliced artifact after indexing fails plan_print with slice_tampered
        tampered_path = self.ctl.library.resolve(r1["model"]["id"])
        with zipfile.ZipFile(tampered_path, "w") as zf:
            zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
            zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
            zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X120 Y120 Z0.2\n")
        with self.assertRaises(hq_print3d.Print3dError) as tctx:
            self.ctl.plan_print(a1_id, r1["model"]["id"], 1)
        self.assertEqual(tctx.exception.code, "slice_tampered")

        # Valid immutable r2 stages into private 0600 copy and uploaded bytes match slice_sha256
        uploaded: dict[str, bytes] = {}
        fake_link = type("FakeLink", (), {"start_print": lambda _self, *a, **kw: None})()
        self.ctl._links[a1_id] = fake_link
        def fake_upload(_ip, _code, fpath, _remote):
            uploaded["bytes"] = Path(fpath).read_bytes()
        with patch("hq_print3d.bambu.upload", side_effect=fake_upload):
            self.ctl.start_print(a1_id, r2["model"]["id"], 1, {"bed_levelling": True})
        self.assertEqual(models.file_sha256(self.ctl.library.resolve(r2["model"]["id"])), r2["model"]["slice_sha256"])
        self.assertEqual(__import__("hashlib").sha256(uploaded["bytes"]).hexdigest(), r2["model"]["slice_sha256"])

        # Fallback atomic replace (when os.link raises OSError) never publishes empty placeholder and preserves bytes
        with patch("os.link", side_effect=OSError("no hardlinks")):
            src_dummy = self.share / "fallback_src.gcode.3mf"
            src_dummy.write_bytes(b"PK\x03\x04test-immutable-fallback-payload")
            pub_path, pub_digest = models._publish_immutable_slice(src_dummy, self.share, "fb", "sliced")
            self.assertEqual(pub_path.read_bytes(), b"PK\x03\x04test-immutable-fallback-payload")
            self.assertEqual(models.file_sha256(pub_path), pub_digest)
            self.assertEqual([p for p in self.share.glob(".hq-slice-*")], [])

    def test_inflated_custom_bed_rejected_and_centered_origin_preserved(self) -> None:
        syn = self._synthetic_roots()
        # 1. save_printer refuses inflated bed dimensions > canonical physical bed
        with self.assertRaises(hq_print3d.Print3dError) as ctx:
            self.ctl.save_printer({
                "name": "A1 Gonflée", "kind": "bambu", "model": "A1",
                "ip": "192.168.1.90", "serial": "03919A999999", "code": "12345678",
                "bed": {"x": 2000, "y": 2000, "z": 2000},
            })
        self.assertEqual(ctx.exception.code, "out_of_bounds")

        # 2. Direct resolve_slicer_config rejects oversized bed_override
        with self.assertRaises(slicer_cfg.SlicerConfigError) as sctx:
            slicer_cfg.resolve_slicer_config("A1", bed_override=(2000.0, 2000.0, 2000.0), profile_roots=syn)
        self.assertEqual(sctx.exception.code, "out_of_bounds")

        # 3. Smaller user limit on AD5M preserves centered origin (-90, -90) consistently
        narrow = slicer_cfg.resolve_slicer_config("AD5M", bed_override=(180.0, 180.0, 200.0), profile_roots=syn)
        self.assertEqual(narrow.profile["bed"], (180.0, 180.0, 200.0))
        self.assertEqual(narrow.profile["origin"], (-90.0, -90.0))
        self.assertEqual(narrow.machine["printable_area"], ["-90x-90", "90x-90", "90x90", "-90x90"])

        # 4. Legacy oversized config.json entry is clamped to canonical bounds by _resolve_slice_printer
        cfg = self.ctl.save_printer({
            "name": "A1 Legacy", "kind": "bambu", "model": "A1",
            "ip": "192.168.1.91", "serial": "03919A888888", "code": "12345678",
        })
        pid = cfg["printers"][-1]["id"]
        raw_cfg = self.ctl._read_config()
        raw_cfg["printers"][-1]["bed"] = {"x": 2000.0, "y": 2000.0, "z": 2000.0}
        self.ctl._write_config(raw_cfg)
        resolved_model, clamped_bed = self.ctl._resolve_slice_printer({"printer_id": pid})
        self.assertEqual(resolved_model, "A1")
        self.assertEqual(clamped_bed, (256.0, 256.0, 256.0))

    def test_slice_registration_failure_and_provenance_policy(self) -> None:
        syn = self._synthetic_roots()
        mid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "cube.stl")

        def fake_slice(cmd, **kw):
            out_dir = Path(cmd[cmd.index("--outputdir") + 1])
            out_name = cmd[cmd.index("--export-3mf") + 1]
            with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
                zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
                zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X100 Y100 Z0.2\nG1 X110 Y100 E0.5\n")
            return type("P", (), {"returncode": 0, "stderr": b"", "stdout": b""})()

        # H1: Persistence write error must fail closed AND clean up unregistered slice artifacts
        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_slice), \
             patch("sqlite3.connect", side_effect=sqlite3.OperationalError("simulated disk error")):
            with self.assertRaises(models.ModelError) as ctx1:
                self.ctl.library.assemble_and_slice_plate(
                    [{"model_id": mid, "x": 128, "y": 128}], "A1", {"infill": 20}, profile_roots=syn,
                )
            self.assertEqual(ctx1.exception.code, "slice_registration_failed")
            with self.assertRaises(models.ModelError) as ctx2:
                self.ctl.library.slice_model(mid, "A1", infill=20, profile_roots=syn)
            self.assertEqual(ctx2.exception.code, "slice_registration_failed")

        # No orphaned internal slice files left in Print/
        self.assertEqual([p for p in self.share.glob("*_studio_*.gcode.3mf")], [])
        self.assertEqual([p for p in self.share.glob("*_sliced_*.gcode.3mf")], [])

        # Set up Bambu printer for plan_print provenance policy checks
        cfg_a1 = self.ctl.save_printer({"name": "A1 Policy", "kind": "bambu", "model": "A1",
                                        "ip": "192.168.1.93", "serial": "03919A666666", "code": "12345678"})
        a1_id = cfg_a1["printers"][-1]["id"]
        self.ctl._on_link(a1_id, True, "")
        self.ctl._on_status(a1_id, {"state": "idle", "ams": [{"slot": 1, "material": "PLA", "colour": "#FFFFFF"}]})

        # Unregistered internal Studio artifact (missing slice_provenance.db entry) MUST fail closed
        rogue = self.share / "rogue_studio_12345678_abcdef.gcode.3mf"
        with zipfile.ZipFile(rogue, "w") as zf:
            zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
            zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
            zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X100 Y100 Z0.2\nG1 X110 Y100 E0.5\n")
        rogue_id = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == rogue.name)
        with self.assertRaises(hq_print3d.Print3dError) as pctx:
            self.ctl.plan_print(a1_id, rogue_id, 1)
        self.assertEqual(pctx.exception.code, "missing_slice_provenance")

        # External user-imported Bambu 3MF passes under explicit external_preflight_only policy
        ext_mf = self.share / "external_user_model.gcode.3mf"
        with zipfile.ZipFile(ext_mf, "w") as zf:
            zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
            zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
            zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X100 Y100 Z0.2\nG1 X110 Y100 E0.5\n")
        ext_id = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == ext_mf.name)
        ext_plan = self.ctl.plan_print(a1_id, ext_id, 1)
        self.assertEqual(ext_plan["provenance_policy"], "external_preflight_only")

    def test_multiprocess_slice_provenance_no_lost_updates(self) -> None:
        # H2: Two isolated OS processes registering distinct slice artifacts concurrently retain BOTH records
        art1 = self.share / "mp_a_studio_11111111_aaaaaa.gcode.3mf"
        art2 = self.share / "mp_b_studio_22222222_bbbbbb.gcode.3mf"
        for p, zpos in ((art1, "0.2"), (art2, "0.3")):
            with zipfile.ZipFile(p, "w") as zf:
                zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
                zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
                zf.writestr("Metadata/plate_1.gcode", f"G90\nM83\nG1 X100 Y100 Z{zpos}\nG1 X110 Y100 E0.5\n")
        sha1 = models.file_sha256(art1)
        sha2 = models.file_sha256(art2)
        rows = {r["name"]: r["id"] for r in self.ctl.library.scan(force=True)}
        id1, id2 = rows[art1.name], rows[art2.name]

        child_code = (
            "import sys, time, pathlib, hq_print3d_models as m\n"
            "state_dir, share_dir, mid, sha, infill, ready_f, go_f = sys.argv[1:8]\n"
            "lib = m.Library(pathlib.Path(state_dir), lambda: {'share': pathlib.Path(share_dir)})\n"
            "pathlib.Path(ready_f).write_text('ready', encoding='utf-8')\n"
            "deadline = time.monotonic() + 10.0\n"
            "while not pathlib.Path(go_f).exists():\n"
            "    if time.monotonic() > deadline: raise RuntimeError('barrier timeout')\n"
            "    time.sleep(0.01)\n"
            "lib._record_slice_meta(mid, sha, {'infill': infill}, rel_path=mid, source_kind='studio')\n"
        )
        r1 = self.root / "ready1.flag"
        r2 = self.root / "ready2.flag"
        go = self.root / "go.flag"
        state_dir = str(self.root / ".hq-print3d")
        repo_dir = str(Path(__file__).resolve().parents[1])
        p1 = subprocess.Popen([sys.executable, "-c", child_code, state_dir, str(self.share), id1, sha1, "15%", str(r1), str(go)], cwd=repo_dir)
        p2 = subprocess.Popen([sys.executable, "-c", child_code, state_dir, str(self.share), id2, sha2, "90%", str(r2), str(go)], cwd=repo_dir)
        deadline = __import__("time").monotonic() + 10.0
        while not (r1.is_file() and r2.is_file()):
            if __import__("time").monotonic() > deadline:
                p1.kill(); p2.kill()
                self.fail("worker processes did not reach barrier")
            __import__("time").sleep(0.01)
        go.write_text("go", encoding="utf-8")
        self.assertEqual(p1.wait(timeout=10), 0)
        self.assertEqual(p2.wait(timeout=10), 0)

        m1 = self.ctl.library.get(id1)
        m2 = self.ctl.library.get(id2)
        self.assertEqual(m1["slice_sha256"], sha1)
        self.assertEqual(m2["slice_sha256"], sha2)
        self.assertEqual(m1["slice_settings"]["infill"], "15%")
        self.assertEqual(m2["slice_settings"]["infill"], "90%")

        cfg_a1 = self.ctl.save_printer({"name": "A1 MP", "kind": "bambu", "model": "A1",
                                        "ip": "192.168.1.94", "serial": "03919A555555", "code": "12345678"})
        a1_id = cfg_a1["printers"][-1]["id"]
        self.ctl._on_link(a1_id, True, "")
        self.ctl._on_status(a1_id, {"state": "idle", "ams": [{"slot": 1, "material": "PLA", "colour": "#FFFFFF"}]})
        plan1 = self.ctl.plan_print(a1_id, id1, 1)
        plan2 = self.ctl.plan_print(a1_id, id2, 1)
        self.assertEqual(plan1["sha256"], sha1)
        self.assertEqual(plan2["sha256"], sha2)
        self.assertEqual(plan1["provenance_policy"], "verified_slice_sha256")
        self.assertEqual(plan2["provenance_policy"], "verified_slice_sha256")

    def test_stl_bounds_ascii_and_bbox_centering_parity(self) -> None:
        # Build asymmetric L-shaped ASCII STL (X: 0..60, Y: 0..40, Z: 5..25)
        # Heavy triangle density at left leg so vertex-mean != bbox-center (30, 20)
        ascii_tris = [
            ((0, 0, 5), (10, 0, 5), (10, 40, 5)),
            ((0, 0, 5), (10, 40, 5), (0, 40, 5)),
            ((0, 0, 5), (10, 0, 5), (10, 40, 5)),
            ((0, 0, 5), (10, 40, 5), (0, 40, 5)),
            ((10, 0, 25), (60, 0, 25), (60, 10, 25)),
        ]
        ascii_lines = ["solid l_bracket"]
        for tri in ascii_tris:
            ascii_lines.append("  facet normal 0 0 1\n    outer loop")
            for vx, vy, vz in tri:
                ascii_lines.append(f"      vertex {vx} {vy} {vz}")
            ascii_lines.append("    endloop\n  endfacet")
        ascii_lines.append("endsolid l_bracket\n")
        astl = self.share / "bracket_ascii.stl"
        astl.write_text("\n".join(ascii_lines), encoding="utf-8")

        binfo = models.stl_bounds(astl)
        self.assertIsNotNone(binfo)
        self.assertEqual(binfo["dims_mm"], [60.0, 40.0, 20.0])
        self.assertEqual(binfo["triangles"], 5)

        mid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == astl.name)
        meta_row = self.ctl.library.get(mid)
        self.assertEqual(meta_row["bounds_mm"], [60.0, 40.0, 20.0])

        # Slice transformed ASCII STL (scale 1.5, rot_z 90) centered at (128, 128)
        # Verify assembled STL input centers bounding box at (128, 128), Z_min == 0, size (60, 90, 30)
        syn = self._synthetic_roots()
        captured = {}

        def fake_slice(cmd, **kw):
            inp = Path(cmd[-1])
            tris = models.parse_stl_triangles(inp.read_bytes())
            xs = [p[0] for t in tris for p in t]
            ys = [p[1] for t in tris for p in t]
            zs = [p[2] for t in tris for p in t]
            captured["cx"] = round((min(xs) + max(xs)) * 0.5, 2)
            captured["cy"] = round((min(ys) + max(ys)) * 0.5, 2)
            captured["z0"] = round(min(zs), 2)
            captured["dims"] = (round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round(max(zs) - min(zs), 2))
            out_dir = Path(cmd[cmd.index("--outputdir") + 1])
            out_name = cmd[cmd.index("--export-3mf") + 1]
            with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
                zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
                zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X120 Y120 Z0.2\nG1 X140 Y120 E1.0\n")
            return type("P", (), {"returncode": 0, "stderr": b"", "stdout": b""})()

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_slice):
            self.ctl.library.assemble_and_slice_plate(
                [{"model_id": mid, "x": 128, "y": 128, "rot_z": 90, "scale": 1.5}],
                "A1", {"infill": 20}, profile_roots=syn,
            )
        self.assertEqual(captured["cx"], 128.0)
        self.assertEqual(captured["cy"], 128.0)
        self.assertEqual(captured["z0"], 0.0)
        self.assertEqual(captured["dims"], (60.0, 90.0, 30.0))

    def test_plate_collision_and_rotated_oob_detection(self) -> None:
        syn = self._synthetic_roots()
        _write_cube_stl(self.share / "c1.stl", size_xy=40.0, height_z=20.0)
        _write_cube_stl(self.share / "c2.stl", size_xy=40.0, height_z=20.0)
        rows = {r["name"]: r["id"] for r in self.ctl.library.scan(force=True)}

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"):
            # Overlapping two 40x40 cubes (centers 100 and 120 -> 20mm overlap) raises 422 collision
            with self.assertRaises(models.ModelError) as cctx:
                self.ctl.library.assemble_and_slice_plate(
                    [
                        {"model_id": rows["c1.stl"], "x": 100, "y": 128},
                        {"model_id": rows["c2.stl"], "x": 120, "y": 128},
                    ],
                    "A1", profile_roots=syn,
                )
            self.assertEqual(cctx.exception.code, "collision")

            # Rotating 40x40 cube 45deg near right edge (x=232 -> corner ~260.3 > 256+1) raises out_of_bounds
            with self.assertRaises(models.ModelError) as octx:
                self.ctl.library.assemble_and_slice_plate(
                    [{"model_id": rows["c1.stl"], "x": 232, "y": 128, "rot_z": 45}],
                    "A1", profile_roots=syn,
                )
            self.assertEqual(octx.exception.code, "out_of_bounds")

    def test_library_get_refuses_symlink_stl_bounds_leak(self) -> None:
        # Phase 2.1 High #1: symlinks / outside-root targets MUST NOT leak bounds_mm via Library.get()
        tiny = self.share / "tiny.stl"
        _write_cube_stl(tiny, size_xy=1.0, height_z=8.0)
        ext_dir = self.root / "outside"
        ext_dir.mkdir()
        ext_stl = ext_dir / "secret.stl"
        _write_cube_stl(ext_stl, size_xy=93.0, height_z=8.0)

        mid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "tiny.stl")
        self.assertEqual(self.ctl.library.get(mid)["bounds_mm"], [1.0, 1.0, 8.0])

        # Try real symlink when OS privilege allows, plus deterministic _is_link simulation for Windows non-admin
        try:
            tiny.unlink()
            os.symlink(ext_stl, tiny)
            sym_created = True
        except OSError:
            sym_created = False
            _write_cube_stl(tiny, size_xy=1.0, height_z=8.0)

        if sym_created:
            self.assertNotIn("bounds_mm", self.ctl.library.get(mid))
            self.assertIsNone(models.stl_bounds(tiny))
            with self.assertRaises(models.ModelError) as rctx:
                self.ctl.library.resolve(mid)
            self.assertEqual(rctx.exception.status, 403)
        else:
            with patch("hq_print3d_models._is_link", side_effect=lambda p: Path(p).name == "tiny.stl"):
                meta_row = self.ctl.library.get(mid)
                self.assertNotIn("bounds_mm", meta_row)
                self.assertIsNone(models.stl_bounds(tiny))
                with self.assertRaises(models.ModelError) as rctx:
                    self.ctl.library.resolve(mid)
                self.assertEqual(rctx.exception.status, 403)

    def test_ascii_stl_decimal_forms_and_strict_facet_rejection(self) -> None:
        # Phase 2.1 High #2: leading-dot/trailing-dot decimals work and malformed facets fail closed (never drop/regroup)
        dot_ascii = (
            "solid decimals\n"
            "  facet normal 0 0 1\n"
            "    outer loop\n"
            "      vertex .5 .5 0.\n"
            "      vertex 5. .5 0\n"
            "      vertex .5 5. 0\n"
            "    endloop\n"
            "  endfacet\n"
            "  facet normal 0 0 1\n"
            "    outer loop\n"
            "      vertex .6 .6 .7\n"
            "      vertex 2.5 .6 .7\n"
            "      vertex .6 2.5 .7\n"
            "    endloop\n"
            "  endfacet\n"
            "  facet normal 0 0 1\n"
            "    outer loop\n"
            "      vertex -.5 -.5 1.5\n"
            "      vertex 1.5 -.5 1.5\n"
            "      vertex -.5 1.5 1.5\n"
            "    endloop\n"
            "  endfacet\n"
            "endsolid decimals\n"
        )
        p_ok = self.share / "decimals_ok.stl"
        p_ok.write_text(dot_ascii, encoding="utf-8")
        tris = models.parse_stl_triangles(p_ok.read_bytes())
        self.assertEqual(len(tris), 3)
        b_ok = models.stl_bounds(p_ok)
        self.assertEqual(b_ok, {"dims_mm": [5.5, 5.5, 1.5], "triangles": 3})

        # Malformed ASCII STLs (bad literal, 2-vertex facet, 4-vertex facet, skipped keyword) MUST fail closed
        for label, bad_ascii in (
            ("bad_vertex_num", dot_ascii.replace("vertex .6 .6 .7", "vertex bad .6 .7")),
            ("two_vertices_in_facet", dot_ascii.replace("      vertex .6 2.5 .7\n", "")),
            ("four_vertices_in_facet", dot_ascii.replace("      vertex .6 2.5 .7\n", "      vertex .6 2.5 .7\n      vertex 1 1 1\n")),
            ("non_finite_nan", dot_ascii.replace("vertex .6 .6 .7", "vertex nan .6 .7")),
        ):
            p_bad = self.share / f"{label}.stl"
            p_bad.write_text(bad_ascii, encoding="utf-8")
            with self.assertRaises(models.ModelError, msg=label):
                models.parse_stl_triangles(p_bad.read_bytes())
            self.assertIsNone(models.stl_bounds(p_bad), msg=label)

    def test_stl_bounds_300k_triangles_streaming_fast(self) -> None:
        # Phase 2.1 Medium #4: O(1) memory streaming handles max 300k-triangle binary STL quickly
        import time as _t
        n_tri = 300000
        big = self.share / "big300k.stl"
        tri_rec = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, 100, 0, 0, 0, 50, 25, 0)
        with open(big, "wb") as fh:
            fh.write(b"300k streaming benchmark".ljust(80, b" "))
            fh.write(struct.pack("<I", n_tri))
            fh.write(tri_rec * n_tri)
        t0 = _t.monotonic()
        info = models.stl_bounds(big)
        dt = _t.monotonic() - t0
        self.assertIsNotNone(info)
        self.assertEqual(info["triangles"], 300000)
        self.assertEqual(info["dims_mm"], [100.0, 50.0, 25.0])
        self.assertLess(dt, 2.0)

    def test_phase3_canonical_transform_rot_xyz_scale_z_and_lay_flat(self) -> None:
        # Asymmetric wedge/L fixture: raw X [0..40], Y [0..20], Z [5..15] -> dims (40, 20, 10)
        raw_tris = [
            ((0.0, 0.0, 5.0), (40.0, 0.0, 5.0), (10.0, 20.0, 5.0)),
            ((0.0, 0.0, 5.0), (10.0, 20.0, 5.0), (0.0, 20.0, 5.0)),
            ((0.0, 0.0, 15.0), (40.0, 0.0, 5.0), (0.0, 20.0, 15.0)),
            ((0.0, 0.0, 5.0), (0.0, 20.0, 5.0), (0.0, 0.0, 15.0)),
            ((0.0, 20.0, 5.0), (0.0, 20.0, 15.0), (0.0, 0.0, 15.0)),
        ]
        # 1. Below plate z < -0.25 must raise 422 below_plate
        with self.assertRaises(models.ModelError) as bctx:
            models.transform_stl_triangles(raw_tris, z=-1.0, x=128.0, y=128.0)
        self.assertEqual(bctx.exception.code, "below_plate")

        # 2. Pure Rx=90° tilts Y (20) into Z and Z (10) into Y, centered at (128, 128)
        rx90 = models.transform_stl_triangles(raw_tris, rot_x=90.0, x=128.0, y=128.0, z=4.0)
        self.assertEqual([round(v, 3) for v in rx90["tilted_dims"]], [40.0, 10.0, 20.0])
        wmin_x, wmin_y, wmin_z, wmax_x, wmax_y, wmax_z = rx90["world_bounds"]
        self.assertAlmostEqual((wmin_x + wmax_x) * 0.5, 128.0, places=3)
        self.assertAlmostEqual((wmin_y + wmax_y) * 0.5, 128.0, places=3)
        self.assertAlmostEqual(wmin_z, 4.0, places=3)
        self.assertAlmostEqual(wmax_z, 24.0, places=3)

        # 3. Scale + Rx + Ry + Rz + Translation preserves triangle count, seats Z_min, and preserves OBB pivot (90, 140)
        comb = models.transform_stl_triangles(raw_tris, scale=1.5, rot_x=37.0, rot_y=-22.5, rot_z=48.0, x=90.0, y=140.0, z=2.5)
        self.assertEqual(len(comb["triangles"]), 5)
        obb_cx = (comb["obb"][0][0] + comb["obb"][2][0]) * 0.5
        obb_cy = (comb["obb"][0][1] + comb["obb"][2][1]) * 0.5
        self.assertAlmostEqual(obb_cx, 90.0, places=3)
        self.assertAlmostEqual(obb_cy, 140.0, places=3)
        self.assertAlmostEqual(comb["world_bounds"][2], 2.5, places=3)

        # 4. Lay-flat from arbitrary sloped face normal (e.g. hypotenuse of wedge) aligns normal to (0, 0, -1)
        ang = models.lay_flat_angles_for_normal(0.5, 0.25, 0.829)
        t_sloped = [((0.0, 0.0, 0.0), (10.0, 0.0, 0.0), (0.0, 10.0, 0.0))]
        # Construct tilted triangle whose outward normal is (1, 1, 1)
        nx, ny, nz = 1.0, 1.0, 1.0
        rx_deg, ry_deg = models.lay_flat_angles_for_normal(nx, ny, nz)
        import math as _m
        rxs, rys = _m.radians(rx_deg), _m.radians(ry_deg)
        l = _m.hypot(nx, ny, nz)
        ux, uy, uz = nx / l, ny / l, nz / l
        y1 = uy * _m.cos(rxs) - uz * _m.sin(rxs)
        z1 = uy * _m.sin(rxs) + uz * _m.cos(rxs)
        x2 = ux * _m.cos(rys) + z1 * _m.sin(rys)
        z2 = -ux * _m.sin(rys) + z1 * _m.cos(rys)
        self.assertAlmostEqual(x2, 0.0, places=3)
        self.assertAlmostEqual(y1, 0.0, places=3)
        self.assertAlmostEqual(z2, -1.0, places=3)
        self.assertTrue(all(_m.isfinite(a) for a in ang))

        # 5. assemble_and_slice_plate passes combined X/Y/Z/RotX/RotY/RotZ/Scale into slicer STL & reuses parsed_cache
        astl = self.share / "wedge.stl"
        _lines = ["solid wedge"]
        for tri in raw_tris:
            _lines.append("  facet normal 0 0 1\n    outer loop")
            for p in tri:
                _lines.append(f"      vertex {p[0]} {p[1]} {p[2]}")
            _lines.append("    endloop\n  endfacet")
        _lines.append("endsolid wedge\n")
        astl.write_text("\n".join(_lines), encoding="utf-8")
        wid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "wedge.stl")
        syn = self._synthetic_roots()
        captured = {}
        def fake_run(cmd, **kw):
            inp = Path(cmd[-1])
            captured["tris"] = models.parse_stl_triangles(inp.read_bytes())
            out_dir = Path(cmd[cmd.index("--outputdir") + 1])
            out_name = cmd[cmd.index("--export-3mf") + 1]
            with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
                zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
                zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X80 Y120 Z0.2\nG1 X160 Y120 E1.0\n")
            return type("P", (), {"returncode": 0, "stderr": b"", "stdout": b""})()

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_run):
            self.ctl.library.assemble_and_slice_plate(
                [
                    {"model_id": wid, "x": 80, "y": 128, "z": 0, "rot_x": 90, "rot_y": 0, "rot_z": 180, "scale": 1.0, "tool": 0},
                    {"model_id": wid, "x": 170, "y": 128, "z": 0, "rot_x": 0, "rot_y": 90, "rot_z": 270, "scale": 1.25, "tool": 0},
                ],
                "A1", {"infill": 20}, profile_roots=syn,
            )
        self.assertEqual(len(captured["tris"]), 10)
        # Verify below_plate rejection via HTTP/assemble entrypoint
        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"):
            with self.assertRaises(models.ModelError) as zctx:
                self.ctl.library.assemble_and_slice_plate(
                    [{"model_id": wid, "x": 128, "y": 128, "z": -3.0}], "A1", {"infill": 15}, profile_roots=syn
                )
            self.assertEqual(zctx.exception.code, "below_plate")

    def test_same_path_replacement_updates_sha_bounds_and_rejects_stale_expected_sha256(self) -> None:
        syn = self._synthetic_roots()
        target = self.share / "reused.stl"

        def single_tri_stl(dx: float) -> bytes:
            header = b"single".ljust(80, b" ")
            rec = struct.pack("<12fH", 0, 0, 1, 0, 0, 0, dx, 0, 0, 0, 10, 10, 0)
            return header + struct.pack("<I", 1) + rec

        b10 = single_tri_stl(10.0)
        sha10 = hashlib.sha256(b10).hexdigest()
        target.write_bytes(b10)
        rows1 = self.ctl.library.scan(force=True)
        mid1 = next(r["id"] for r in rows1 if r["name"] == "reused.stl")
        detail1 = self.ctl.library.get(mid1)
        self.assertEqual(detail1["source_sha256"], sha10)
        self.assertEqual(detail1["version"], sha10)
        self.assertEqual(round(detail1["bounds_mm"][0], 2), 10.0)

        # Overwrite same file path with SAME triangle count (1) but different dimensions (90 mm)
        b90 = single_tri_stl(90.0)
        sha90 = hashlib.sha256(b90).hexdigest()
        target.write_bytes(b90)
        os.utime(target, (time.time() + 5, time.time() + 5))

        detail2 = self.ctl.library.get(mid1)
        self.assertEqual(detail2["id"], mid1)
        self.assertEqual(detail2["source_sha256"], sha90)
        self.assertEqual(detail2["version"], sha90)
        self.assertEqual(round(detail2["bounds_mm"][0], 2), 90.0)
        fobj, _ln, _mime, fd_sha = self.ctl.library.open_file_with_sha(mid1)
        try:
            self.assertEqual(fd_sha, sha90)
        finally:
            fobj.close()

        def fake_run(cmd, **kw):
            out_dir = Path(cmd[cmd.index("--outputdir") + 1])
            out_name = cmd[cmd.index("--export-3mf") + 1]
            with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
                zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
                zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X80 Y120 Z0.2\nG1 X160 Y120 E1.0\n")
            return type("P", (), {"returncode": 0, "stderr": b"", "stdout": b""})()

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_run):
            with self.assertRaises(models.ModelError) as stale_ctx:
                self.ctl.library.assemble_and_slice_plate(
                    [{"model_id": mid1, "x": 128, "y": 128, "z": 0, "expected_sha256": sha10}],
                    "A1",
                    {"infill": 15},
                    profile_roots=syn,
                )
            self.assertEqual(stale_ctx.exception.status, 409)
            self.assertEqual(stale_ctx.exception.code, "source_changed")

            ok_res = self.ctl.library.assemble_and_slice_plate(
                [{"model_id": mid1, "x": 128, "y": 128, "z": 0, "expected_sha256": sha90}],
                "A1",
                {"infill": 15},
                profile_roots=syn,
            )
            self.assertEqual(ok_res["model"]["slice_settings"]["source_hashes"][mid1], sha90)

    def test_elevated_z_and_tight_negative_z_fail_closed(self) -> None:
        syn = self._synthetic_roots()
        _write_cube_stl(self.share / "tight_z.stl")
        tid = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "tight_z.stl")

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"):
            with self.assertRaises(models.ModelError) as neg_ctx:
                self.ctl.library.assemble_and_slice_plate(
                    [{"model_id": tid, "x": 128, "y": 128, "z": -0.1}], "A1", {"infill": 15}, profile_roots=syn
                )
            self.assertEqual(neg_ctx.exception.code, "below_plate")

            with self.assertRaises(models.ModelError) as elev_ctx:
                self.ctl.library.assemble_and_slice_plate(
                    [{"model_id": tid, "x": 128, "y": 128, "z": 2.5}], "A1", {"infill": 15}, profile_roots=syn
                )
            self.assertEqual(elev_ctx.exception.status, 422)
            self.assertEqual(elev_ctx.exception.code, "unsupported_z")


@unittest.skipUnless(models.Library.find_slicer(), "OrcaSlicer CLI requis pour les tests réels")
class OrcaSlicerLiveIntegrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        _write_cube_stl(self.share / "cube.stl")
        _write_cube_stl(self.share / "cube_b.stl", size_xy=14.0, height_z=8.0)
        self._patches = [
            patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
            patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None),
        ]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)

    def tearDown(self) -> None:
        for p in self._patches:
            p.stop()

    def _model_id(self, name: str) -> str:
        return next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == name)

    @staticmethod
    def _read_proj_settings(three_mf: Path) -> dict:
        with zipfile.ZipFile(three_mf) as zf:
            return json.loads(zf.read("Metadata/project_settings.config").decode("utf-8", "replace"))

    def test_real_orca_slice_all_supported_models_and_parameter_deltas(self) -> None:
        mid = self._model_id("cube.stl")
        mid_b = self._model_id("cube_b.stl")

        # 1. Bambu A1 baseline + parameter-delta verification (PETG / 0.12 / 35% / supports / brim vs draft)
        res_petg = self.ctl.library.assemble_and_slice_plate(
            [{"model_id": mid, "x": 128, "y": 128, "tool": 0}],
            "A1",
            {
                "material": "PETG",
                "plate_type": "textured_pei",
                "nozzle": "0.4",
                "layer_height": 0.12,
                "first_layer_height": 0.16,
                "wall_loops": 4,
                "infill": 35,
                "infill_pattern": "gyroid",
                "supports": True,
                "support_type": "tree",
                "brim": True,
            },
        )
        self.assertEqual(res_petg["info"]["printer_model"], "A1")
        out_3mf = self.ctl.library.resolve(res_petg["model"]["id"])
        ps_petg = self._read_proj_settings(out_3mf)
        self.assertEqual(ps_petg["printer_model"], "Bambu Lab A1")
        self.assertEqual(ps_petg["curr_bed_type"], "Textured PEI Plate")
        self.assertEqual(ps_petg["filament_type"], ["PETG"])
        self.assertEqual(ps_petg["layer_height"], "0.12")
        self.assertEqual(ps_petg["initial_layer_print_height"], "0.16")
        self.assertEqual(ps_petg["wall_loops"], "4")
        self.assertEqual(ps_petg["sparse_infill_density"], "35%")
        self.assertEqual(ps_petg["enable_support"], "1")
        self.assertEqual(ps_petg["brim_type"], "outer_only")

        # Verify plan_print accepts on A1 controller and rejects on A1 mini controller (offline, no start)
        cfg_a1 = self.ctl.save_printer({"name": "Atelier A1", "kind": "bambu", "model": "A1",
                                       "ip": "192.168.1.41", "serial": "03919A111111", "code": "12345678"})
        a1_id = cfg_a1["printers"][0]["id"]
        self.ctl._on_link(a1_id, True, "")
        self.ctl._on_status(a1_id, {"state": "idle", "ams": [{"slot": 1, "material": "PETG", "colour": "#FFFFFF"}]})
        plan_ok = self.ctl.plan_print(a1_id, res_petg["model"]["id"], 1)
        self.assertEqual(plan_ok["sliced_for"], "A1")

        cfg_mini = self.ctl.save_printer({"name": "Atelier Mini", "kind": "bambu", "model": "A1 mini",
                                         "ip": "192.168.1.42", "serial": "0309DA111111", "code": "12345678"})
        mini_id = next(p["id"] for p in cfg_mini["printers"] if p["model"] == "A1 mini")
        self.ctl._on_link(mini_id, True, "")
        self.ctl._on_status(mini_id, {"state": "idle", "ams": [{"slot": 1, "material": "PETG", "colour": "#FFFFFF"}]})
        with self.assertRaises(hq_print3d.Print3dError) as mctx:
            self.ctl.plan_print(mini_id, res_petg["model"]["id"], 1)
        self.assertEqual(mctx.exception.code, "printer_mismatch")

        # Compare against quick slice_model with different layer/infill/material
        res_pla = self.ctl.library.slice_model(
            mid, "A1", material="PLA", layer_height=0.28, infill=10, supports=False, brim=False
        )
        ps_pla = self._read_proj_settings(self.ctl.library.resolve(res_pla["id"]))
        self.assertEqual(ps_pla["filament_type"], ["PLA"])
        self.assertEqual(ps_pla["layer_height"], "0.28")
        self.assertEqual(ps_pla["sparse_infill_density"], "10%")

        # 2. A1 mini (0.2 mm nozzle, Smooth PEI -> High Temp Plate) + P1S
        res_mini = self.ctl.library.assemble_and_slice_plate(
            [{"model_id": mid, "x": 90, "y": 90, "tool": 0}],
            "A1 mini",
            {"material": "PLA", "plate_type": "smooth_pei", "nozzle": "0.2", "layer_height": 0.10, "infill": 20},
        )
        ps_mini = self._read_proj_settings(self.ctl.library.resolve(res_mini["model"]["id"]))
        self.assertEqual(res_mini["info"]["printer_model"], "A1 mini")
        self.assertEqual(ps_mini["curr_bed_type"], "High Temp Plate")
        self.assertEqual(ps_mini["nozzle_diameter"], ["0.2"])

        res_p1s = self.ctl.library.slice_model(mid, "P1S", material="PLA", layer_height=0.20)
        ps_p1s = self._read_proj_settings(self.ctl.library.resolve(res_p1s["id"]))
        self.assertEqual(ps_p1s["printer_model"], "Bambu Lab P1S")

        # 3. Flashforge AD5M (centered origin -110..-110..110) & AD5X (220x220 Klipper)
        res_ad5m = self.ctl.library.assemble_and_slice_plate(
            [{"model_id": mid, "x": 110, "y": 110, "tool": 0}],
            "AD5M",
            {"material": "PLA", "plate_type": "textured_pei", "nozzle": "0.4", "layer_height": 0.20},
        )
        self.assertEqual(res_ad5m["info"]["printer_model"], "AD5M")

        res_ad5x = self.ctl.library.slice_model(mid, "AD5X", material="PLA", nozzle="0.4", layer_height=0.20)
        self.assertEqual(self._read_proj_settings(self.ctl.library.resolve(res_ad5x["id"]))["printer_model"], "Flashforge AD5X")

        # 4. Flashforge Creator 5 multi-object / multi-material (T0 PLA + T1 PETG)
        res_c5 = self.ctl.library.assemble_and_slice_plate(
            [
                {"model_id": mid, "x": 85, "y": 128, "tool": 0},
                {"model_id": mid_b, "x": 165, "y": 128, "tool": 1},
            ],
            "Creator 5",
            {
                "plate_type": "textured_pei",
                "nozzle": "0.4",
                "layer_height": 0.20,
                "tools": [{"material": "PLA", "color": "#38BDF8"}, {"material": "PETG", "color": "#F97316"}],
            },
        )
        self.assertEqual(res_c5["info"]["printer_model"], "Creator 5")
        ps_c5 = self._read_proj_settings(self.ctl.library.resolve(res_c5["model"]["id"]))
        self.assertEqual(ps_c5["filament_type"][:2], ["PLA", "PETG"])
        layers_c5 = self.ctl.library.gcode_layers(res_c5["model"]["id"], 1)
        self.assertTrue(len(layers_c5["layers"]) >= 5)

        # 5. Phase 3 End-to-End Real OrcaSlicer 2.5.1 slice of tilted + rotated + scaled asymmetric part
        # Raw cube (20x20x10) rotated rot_x=90 -> tilted dims (20, 10, 20), scaled 1.5 -> (30, 15, 30), rot_z=90 -> footprint (15 x 30), height 30mm
        res_tilt = self.ctl.library.assemble_and_slice_plate(
            [{"model_id": mid, "x": 128, "y": 128, "z": 0, "rot_x": 90, "rot_y": 0, "rot_z": 90, "scale": 1.5, "tool": 0}],
            "A1",
            {"material": "PLA", "plate_type": "textured_pei", "nozzle": "0.4", "layer_height": 0.20, "infill": 15},
        )
        layers_tilt = self.ctl.library.gcode_layers(res_tilt["model"]["id"], 1)
        max_layer_z = max(float(l.get("z") or 0) for l in layers_tilt["layers"])
        self.assertGreater(max_layer_z, 25.0)
        bx0, by0, bx1, by1 = layers_tilt["bounds"]
        self.assertGreater(bx1 - bx0, 12.0)
        self.assertGreater(by1 - by0, 25.0)
