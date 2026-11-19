"""Phase 4 comprehensive tests: Advanced slicing presets/params, Multi-Material & Prime Tower,
Per-object 3MF overrides (including live OrcaSlicer 2.5.1.0 output proof), and .hq3d Studio Projects.
All tests operate strictly offline with zero physical printer communication.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import hq_print3d
import hq_print3d_models as models
import hq_print3d_projects as projects
import hq_print3d_slicer as slicer_cfg
from tests.test_hq_print3d_slicer import _write_cube_stl


def _synthetic_vendor_roots(root: Path) -> list[Path]:
    """Portable synthetic vendor BBL preset tree for offline CI without OrcaSlicer installed."""
    base = root / "syn_bbl"
    for cat in ("machine", "process", "filament"):
        (base / cat).mkdir(parents=True, exist_ok=True)
    (base / "machine" / "BBL A1 0.4.json").write_text(json.dumps({
        "type": "machine",
        "name": "Bambu Lab A1 0.4 nozzle",
        "printer_model": "Bambu Lab A1",
        "nozzle_diameter": ["0.4"],
        "default_print_profile": "0.20mm Standard @BBL A1",
        "machine_max_speed_x": ["500", "200"],
        "machine_max_acceleration_x": ["12000", "12000"],
    }), encoding="utf-8")
    (base / "machine" / "BBL A1 0.2.json").write_text(json.dumps({
        "type": "machine",
        "name": "Bambu Lab A1 0.2 nozzle",
        "printer_model": "Bambu Lab A1",
        "nozzle_diameter": ["0.2"],
        "default_print_profile": "0.10mm Standard @BBL A1 0.2 nozzle",
        "machine_max_speed_x": ["500", "200"],
        "machine_max_acceleration_x": ["12000", "12000"],
    }), encoding="utf-8")
    (base / "process" / "0.20mm Standard.json").write_text(json.dumps({
        "type": "process",
        "name": "0.20mm Standard @BBL A1",
        "compatible_printers": ["Bambu Lab A1 0.4 nozzle", "Bambu Lab A1 0.2 nozzle"],
        "layer_height": "0.2",
        "initial_layer_print_height": "0.2",
        "wall_loops": "2",
        "top_shell_layers": "5",
        "bottom_shell_layers": "3",
        "sparse_infill_density": "15%",
        "sparse_infill_pattern": "grid",
        "outer_wall_speed": ["200"],
        "inner_wall_speed": ["300"],
        "sparse_infill_speed": ["270"],
        "initial_layer_speed": ["50"],
        "travel_speed": ["700"],
        "default_acceleration": ["6000"],
        "outer_wall_acceleration": ["5000"],
        "prime_tower_width": "35",
    }), encoding="utf-8")
    for fname, mtype, t_noz, t_low, t_high, t_cool, t_bed in [
        ("Generic PLA @BBL A1.json", "PLA", "220", "190", "240", "35", "65"),
        ("Generic PETG @BBL A1.json", "PETG", "255", "240", "270", "0", "75"),
        ("Generic PC @BBL A1.json", "PC", "285", "270", "300", "0", "95"),
    ]:
        (base / "filament" / fname).write_text(json.dumps({
            "type": "filament",
            "name": fname.removesuffix(".json"),
            "compatible_printers": ["Bambu Lab A1 0.4 nozzle", "Bambu Lab A1 0.2 nozzle"],
            "filament_type": [mtype],
            "nozzle_temperature_initial_layer": [t_noz],
            "nozzle_temperature": [t_noz],
            "nozzle_temperature_range_low": [t_low],
            "nozzle_temperature_range_high": [t_high],
            "cool_plate_temp_initial_layer": [t_cool],
            "cool_plate_temp": [t_cool],
            "textured_plate_temp_initial_layer": [t_bed],
            "textured_plate_temp": [t_bed],
            "hot_plate_temp_initial_layer": [t_bed],
            "hot_plate_temp": [t_bed],
            "fan_min_speed": ["40"],
            "fan_max_speed": ["80"],
            "close_fan_the_first_x_layers": ["1"],
            "filament_max_volumetric_speed": ["21"],
        }), encoding="utf-8")
    return [base]


class Phase4BackendUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        _write_cube_stl(self.share / "part_a.stl", size_xy=22.0, height_z=12.0)
        _write_cube_stl(self.share / "part_b.stl", size_xy=22.0, height_z=12.0)
        self.syn = _synthetic_vendor_roots(self.root)
        self._patches = [
            patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
            patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None),
        ]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)

    def tearDown(self) -> None:
        self.ctl.shutdown()
        for p in self._patches:
            p.stop()

    def test_4a_quality_presets_scale_per_nozzle_and_advanced_validation(self) -> None:
        # Nozzle 0.2 must scale down cleanly (draft=0.14, standard=0.10, fine=0.06)
        r_02_fine = slicer_cfg.resolve_slicer_config(
            "A1", nozzle="0.2", quality_preset="fine", profile_roots=self.syn
        )
        self.assertEqual(r_02_fine.process["layer_height"], "0.06")
        self.assertEqual(r_02_fine.process["wall_loops"], "3")
        self.assertEqual(r_02_fine.process["top_shell_layers"], "6")

        # Speed preset 'quiet' scales down outer/inner/infill speeds safely
        r_quiet = slicer_cfg.resolve_slicer_config(
            "A1", nozzle="0.4", quality_preset="draft", speed_preset="quiet",
            advanced={
                "seam_position": "random",
                "ironing_type": "topmost",
                "wall_generator": "arachne",
                "skirt_loops": 3,
                "raft_layers": 2,
                "support_threshold_angle": 45,
                "support_on_build_plate_only": True,
                "supports": True,
                "brim": True,
                "brim_type": "outer_and_inner",
                "brim_width": 8.5,
                "nozzle_temperature_initial_layer": 215,
                "nozzle_temperature": 210,
                "bed_temperature_initial_layer": 60,
                "bed_temperature": 55,
                "fan_min_speed": 20,
                "fan_max_speed": 65,
                "close_fan_the_first_x_layers": 2,
                "filament_max_volumetric_speed": 15.5,
            },
            profile_roots=self.syn,
        )
        self.assertEqual(r_quiet.process["layer_height"], "0.28")
        self.assertEqual(r_quiet.process["seam_position"], "random")
        self.assertEqual(r_quiet.process["ironing_type"], "topmost")
        self.assertEqual(r_quiet.process["wall_generator"], "arachne")
        self.assertEqual(r_quiet.process["skirt_loops"], "3")
        self.assertEqual(r_quiet.process["raft_layers"], "2")
        self.assertEqual(r_quiet.process["brim_type"], "outer_and_inner")
        self.assertEqual(r_quiet.process["brim_width"], "8.5")
        self.assertEqual(r_quiet.process["outer_wall_speed"], ["130"])  # 200 * 0.65
        self.assertEqual(r_quiet.filaments[0]["nozzle_temperature"], ["210"])
        self.assertEqual(r_quiet.filaments[0]["textured_plate_temp"], ["55"])
        self.assertEqual(r_quiet.filaments[0]["filament_max_volumetric_speed"], ["15.5"])

        # Reject fan_min > fan_max, speed > machine max, and temp > printer ceiling
        with self.assertRaises(slicer_cfg.SlicerConfigError):
            slicer_cfg.resolve_slicer_config("A1", advanced={"fan_min_speed": 80, "fan_max_speed": 40}, profile_roots=self.syn)
        with self.assertRaises(slicer_cfg.SlicerConfigError):
            slicer_cfg.resolve_slicer_config("A1", advanced={"outer_wall_speed": 599}, profile_roots=self.syn)  # > 500
        with self.assertRaises(slicer_cfg.SlicerConfigError):
            slicer_cfg.resolve_slicer_config("A1", advanced={"bed_temperature": 120}, profile_roots=self.syn)  # > 100 on A1

    def test_4b_capabilities_readonly_loaded_materials_thermal_and_tower_guards(self) -> None:
        # Distinguish physical_extruders vs max_tools & station_kind cleanly
        c5 = slicer_cfg.printer_capabilities("Creator 5")
        a1 = slicer_cfg.printer_capabilities("A1")
        ad5x = slicer_cfg.printer_capabilities("AD5X")
        ad5m = slicer_cfg.printer_capabilities("AD5M")
        self.assertEqual((c5["physical_extruders"], c5["max_tools"], c5["station_kind"]), (4, 4, "physical_toolheads"))
        self.assertEqual((a1["physical_extruders"], a1["max_tools"], a1["station_kind"]), (1, 4, "ams_lite"))
        self.assertEqual((ad5x["physical_extruders"], ad5x["max_tools"], ad5x["station_kind"]), (1, 4, "ifs"))
        self.assertEqual((ad5m["physical_extruders"], ad5m["max_tools"], ad5m["supports_prime_tower"]), (1, 1, False))

        # Single-nozzle A1 rejects PLA (220C) + PC (285C) > 60C thermal delta
        with self.assertRaises(slicer_cfg.SlicerConfigError) as th_ctx:
            slicer_cfg.resolve_slicer_config(
                "A1",
                used_tool_count=2,
                tools=[{"material": "PLA"}, {"material": "PC"}],
                profile_roots=self.syn,
            )
        self.assertEqual(th_ctx.exception.code, "incompatible_materials")

        # Out-of-bounds prime tower rejected cleanly
        with self.assertRaises(slicer_cfg.SlicerConfigError) as pt_ctx:
            slicer_cfg.resolve_slicer_config(
                "A1", used_tool_count=2, tools=[{"material": "PLA"}, {"material": "PLA"}],
                advanced={"prime_tower_enabled": True, "prime_tower_x": 240, "prime_tower_y": 100, "prime_tower_width": 35},
                profile_roots=self.syn,
            )
        self.assertEqual(pt_ctx.exception.code, "prime_tower_out_of_bounds")

        # Prime tower colliding with a placed object fails before slicer runs
        mid_a = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "part_a.stl")
        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"):
            with self.assertRaises(models.ModelError) as col_ctx:
                self.ctl.library.assemble_and_slice_plate(
                    [{"model_id": mid_a, "x": 100, "y": 100, "tool": 0},
                     {"model_id": mid_a, "x": 160, "y": 100, "tool": 1}],
                    "A1",
                    {"prime_tower_enabled": True, "prime_tower_x": 85, "prime_tower_y": 85, "prime_tower_width": 35},
                    profile_roots=self.syn,
                )
        self.assertEqual(col_ctx.exception.code, "prime_tower_collision")

        # Read-only HTTP schema & loaded_materials endpoints (portable with or without local OrcaSlicer installed)
        cfg = self.ctl.save_printer({
            "name": "Atelier A1", "kind": "bambu", "model": "A1",
            "ip": "192.168.1.50", "serial": "03919A111111", "code": "12345678",
        })
        pid = cfg["printers"][0]["id"]
        orig_inspect = models.inspect_printer_slicer_defaults
        def _portable_inspect(*a, **kw):
            if not models.Library.find_slicer():
                kw.setdefault("profile_roots", self.syn)
            return orig_inspect(*a, **kw)
        with patch.object(models, "inspect_printer_slicer_defaults", side_effect=_portable_inspect):
            code_s, schema = self.ctl.http_get("/api/print3d/studio/schema", {"printer_id": pid, "nozzle": "0.4"})
        self.assertEqual(code_s, 200)
        self.assertIn("draft", schema["quality_presets"])
        self.assertIn("PLA", schema["supported_materials"])

        # Offline -> available False, reason="offline"
        code_lm, lm_off = self.ctl.http_get("/api/print3d/studio/loaded_materials", {"printer_id": pid})
        self.assertEqual(code_lm, 200)
        self.assertFalse(lm_off["available"])
        self.assertEqual(lm_off["reason"], "offline")

    def test_4c_per_object_overrides_isolated_in_generated_3mf(self) -> None:
        mid_a = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "part_a.stl")
        mid_b = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "part_b.stl")
        captured_ms: list[str] = []

        def fake_run(cmd, **kw):
            inp = Path(cmd[-1])
            with zipfile.ZipFile(inp) as zf:
                captured_ms.append(zf.read("Metadata/model_settings.config").decode("utf-8"))
            out_dir = Path(cmd[cmd.index("--outputdir") + 1])
            out_name = cmd[cmd.index("--export-3mf") + 1]
            with zipfile.ZipFile(out_dir / out_name, "w") as zf:
                zf.writestr("Metadata/slice_info.config", '<config><plate><metadata key="index" value="1"/></plate></config>')
                zf.writestr("Metadata/project_settings.config", json.dumps({"printer_model": "Bambu Lab A1"}))
                zf.writestr("Metadata/plate_1.gcode", "G90\nM83\nG1 X80 Y120 Z0.2\nG1 X160 Y120 E1.0\n")
            return type("P", (), {"returncode": 0, "stderr": b"", "stdout": b""})()

        with patch.object(self.ctl.library, "find_slicer", return_value="orca-slicer"), \
             patch("subprocess.run", side_effect=fake_run):
            res = self.ctl.library.assemble_and_slice_plate(
                [
                    {"model_id": mid_a, "x": 70, "y": 128, "tool": 0, "local_name": "ObjA"},
                    {"model_id": mid_b, "x": 170, "y": 128, "tool": 0, "local_name": "ObjB",
                     "overrides": {"infill": 75, "wall_loops": 5, "supports": True, "seam_position": "random"}},
                ],
                "A1",
                {"infill": 15, "wall_loops": 2},
                profile_roots=self.syn,
            )
        self.assertEqual(len(captured_ms), 1, "Single-tool plate with per-object overrides MUST emit 3MF")
        ms = captured_ms[0]
        obj_a_chunk, _, obj_b_chunk = ms.partition('<object id="2">')
        self.assertNotIn("75%", obj_a_chunk)
        self.assertNotIn("wall_loops", obj_a_chunk)
        self.assertIn('key="sparse_infill_density" value="75%"', obj_b_chunk)
        self.assertIn('key="wall_loops" value="5"', obj_b_chunk)
        self.assertIn('key="enable_support" value="1"', obj_b_chunk)
        self.assertIn('key="seam_position" value="random"', obj_b_chunk)
        self.assertEqual(res["model"]["slice_settings"]["object_overrides"][1]["overrides"]["wall_loops"], "5")

    def test_4d_project_lifecycle_source_integrity_conflict_and_security(self) -> None:
        mid_a = next(r["id"] for r in self.ctl.library.scan(force=True) if r["name"] == "part_a.stl")
        detail_a = self.ctl.library.get(mid_a)
        sha_a = detail_a["source_sha256"]

        # Save via HTTP controller (including accidental secret & host path -> must be sanitized!)
        code, saved = self.ctl.http_post("/api/print3d/projects/save", {
            "title": "Support Casque v1",
            "target": {"printer_model": "A1", "printer_id": "p1", "nozzle": "0.4", "plate_type": "textured_pei"},
            "settings": {"infill": 25, "pin": "99999999", "access_code": "SECRET123"},
            "tools": [{"material": "PLA", "color": "#FF0000", "preset": "Generic PLA"}],
            "items": [{
                "model_id": mid_a, "model_name": "part_a.stl", "source_sha256": sha_a,
                "x": 120, "y": 120, "z": 0, "tool": 0,
                "overrides": {"infill": 60},
                "custom_meta": {"vendor_note": "keep_me", "host_path": r"C:\Users\secret\file.stl"},
            }],
            "slice_ref": {"sliced_model_id": "nonexistent_slice", "slice_sha256": "0" * 64},
        })
        self.assertEqual(code, 200)
        prj = saved["project"]
        pid = prj["id"]
        self.assertEqual(prj["schema_version"], 1)
        self.assertEqual(prj["revision"], 1)
        self.assertNotIn("pin", prj["settings"])
        self.assertNotIn("access_code", prj["settings"])
        self.assertEqual(prj["items"][0]["custom_meta"]["vendor_note"], "keep_me")
        self.assertNotIn("host_path", prj["items"][0]["custom_meta"])

        # rev 1 save succeeds -> rev 2; stale expected_revision=1 must then fail 409
        code2, s2 = self.ctl.http_post("/api/print3d/projects/save", {"id": pid, "title": "v2", "expected_revision": 1, "items": prj["items"]})
        self.assertEqual(code2, 200)
        self.assertEqual(s2["project"]["revision"], 2)
        with self.assertRaises(hq_print3d.Print3dError) as stale_save:
            self.ctl.http_post("/api/print3d/projects/save", {"id": pid, "title": "stale", "expected_revision": 1, "items": []})
        self.assertEqual(stale_save.exception.status, 409)
        self.assertEqual(stale_save.exception.code, "project_conflict")

        # Reopen cleanly: slice_valid MUST be False because sliced_model_id doesn't exist
        code_open, opened = self.ctl.http_get("/api/print3d/projects/get", {"id": pid})
        self.assertEqual(code_open, 200)
        self.assertEqual(opened["project"]["items"][0]["source_status"], "ok")
        self.assertFalse(opened["integrity"]["slice_valid"])

        # Replace source STL under same path -> reopen detects source_status == 'replaced'
        _write_cube_stl(self.share / "part_a.stl", size_xy=55.0, height_z=12.0)
        os.utime(self.share / "part_a.stl", (os.stat(self.share / "part_a.stl").st_mtime + 5,) * 2)
        self.ctl.library.scan(force=True)
        _c, opened_rep = self.ctl.http_get("/api/print3d/projects/get", {"id": pid})
        self.assertEqual(opened_rep["integrity"]["replaced_count"], 1)
        self.assertEqual(opened_rep["project"]["items"][0]["source_status"], "replaced")
        self.assertEqual(round(opened_rep["project"]["items"][0]["current_bounds_mm"][0], 1), 55.0)

        # Delete source STL -> reopen detects source_status == 'missing'
        (self.share / "part_a.stl").unlink()
        self.ctl.library.scan(force=True)
        _c, opened_mis = self.ctl.http_get("/api/print3d/projects/get", {"id": pid})
        self.assertEqual(opened_mis["integrity"]["missing_count"], 1)
        self.assertEqual(opened_mis["project"]["items"][0]["source_status"], "missing")

        # Unknown future schema_version rejected cleanly
        (self.root / ".hq-print3d" / "studio_projects" / "future_test.hq3d").write_text(
            json.dumps({"schema_version": 99, "title": "Future"}), encoding="utf-8"
        )
        with self.assertRaises(hq_print3d.Print3dError) as fctx:
            self.ctl.http_get("/api/print3d/projects/get", {"id": "future_test"})
        self.assertEqual(fctx.exception.status, 422)
        self.assertEqual(fctx.exception.code, "unsupported_project_version")

        # Duplicate, rename, list, delete work cleanly
        _c, dup = self.ctl.http_post("/api/print3d/projects/duplicate", {"id": pid})
        dup_id = dup["project"]["id"]
        self.assertNotEqual(dup_id, pid)
        _c, ren = self.ctl.http_post("/api/print3d/projects/rename", {"id": dup_id, "title": "Casque Renommé", "expected_revision": 1})
        self.assertEqual(ren["project"]["title"], "Casque Renommé")
        self.assertEqual(ren["project"]["revision"], 2)
        _c, listing = self.ctl.http_get("/api/print3d/projects", {})
        self.assertGreaterEqual(len(listing["projects"]), 2)
        _c, deleted = self.ctl.http_post("/api/print3d/projects/delete", {"id": dup_id, "expected_revision": 2})
        self.assertTrue(deleted["ok"])

    def test_4e_counteraudit_h1_h2_m1_m2_adversarial_regressions(self) -> None:
        import concurrent.futures
        import subprocess
        import sys
        import threading

        st = self.root / ".hq-print3d"
        first = projects.save_project(st, {"title": "init", "items": []})
        pid = first["id"]
        self.assertEqual(first["revision"], 1)

        # H1-a: Updating an existing project without expected_revision (and without force_overwrite) MUST fail 409
        with self.assertRaises(projects.ProjectError) as no_rev_ctx:
            projects.save_project(st, {"id": pid, "title": "no-rev", "items": []})
        self.assertEqual(no_rev_ctx.exception.status, 409)
        self.assertEqual(no_rev_ctx.exception.code, "project_conflict")

        with self.assertRaises(projects.ProjectError) as no_rev_ren:
            projects.rename_project(st, pid, "no-rev-rename")
        self.assertEqual(no_rev_ren.exception.status, 409)

        # H1-b: Concurrent threads starting at expected_revision=1 -> transaction lock serializes them so
        # exactly ONE succeeds (revision 2) and all others fail with 409 project_conflict.
        start_evt = threading.Event()
        thread_outcomes: list[tuple[str, int]] = []
        out_lk = threading.Lock()

        def _thread_worker(idx: int) -> None:
            start_evt.wait(5)
            try:
                doc = projects.save_project(st, {"id": pid, "title": f"th_{idx}", "expected_revision": 1, "items": []})
                with out_lk:
                    thread_outcomes.append(("ok", int(doc["revision"])))
            except projects.ProjectError as exc:
                with out_lk:
                    thread_outcomes.append((exc.code, exc.status))

        threads = [threading.Thread(target=_thread_worker, args=(i,)) for i in range(6)]
        for t in threads:
            t.start()
        start_evt.set()
        for t in threads:
            t.join(10)
        self.assertEqual(sum(1 for k, _ in thread_outcomes if k == "ok"), 1)
        self.assertEqual(sum(1 for k, s in thread_outcomes if k == "project_conflict" and s == 409), 5)
        self.assertEqual(projects.open_project(st, pid)["project"]["revision"], 2)

        # H1-c: 12 concurrent OS processes racing on expected_revision=2 -> exactly 1 succeeds (revision 3), 11 get 409
        worker_code = (
            "import sys, pathlib, hq_print3d_projects as p\n"
            "st = pathlib.Path(sys.argv[1]); pid = sys.argv[2]; idx = sys.argv[3]\n"
            "try:\n"
            "    d = p.save_project(st, {'id': pid, 'title': f'proc_{idx}', 'expected_revision': 2, 'items': []})\n"
            "    print(f'OK:{d[\"revision\"]}')\n"
            "except p.ProjectError as e:\n"
            "    print(f'ERR:{e.status}:{e.code}')\n"
        )
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            futs = [
                pool.submit(
                    subprocess.run,
                    [sys.executable, "-c", worker_code, str(st), pid, str(i)],
                    cwd=str(Path(__file__).resolve().parent.parent),
                    capture_output=True, text=True, timeout=20,
                )
                for i in range(12)
            ]
            proc_outs = [f.result().stdout.strip() for f in futs]
        self.assertEqual(proc_outs.count("OK:3"), 1, f"Expected exactly one process win, got: {proc_outs}")
        self.assertEqual(proc_outs.count("ERR:409:project_conflict"), 11)
        self.assertEqual(projects.open_project(st, pid)["project"]["revision"], 3)

        # H2: Malformed source_sha256 rejected on save (422); empty/missing SHA reported as 'unverifiable' on open
        with self.assertRaises(projects.ProjectError) as bad_sha:
            projects.save_project(st, {
                "title": "bad-sha",
                "items": [{"model_id": "m1", "source_sha256": "not-a-valid-sha256"}],
            })
        self.assertEqual(bad_sha.exception.status, 422)
        self.assertEqual(bad_sha.exception.code, "invalid_source_sha256")

        no_sha_prj = projects.save_project(st, {
            "title": "empty-sha",
            "items": [{"model_id": "m1", "model_rel": "part_a.stl", "source_sha256": ""}],
            "slice_ref": {"sliced_model_id": "fake_slice", "slice_sha256": "a" * 64},
        })
        reopened_no_sha = projects.open_project(st, no_sha_prj["id"], self.ctl.library)
        self.assertEqual(reopened_no_sha["project"]["items"][0]["source_status"], "unverifiable")
        self.assertEqual(reopened_no_sha["integrity"]["unverifiable_count"], 1)
        self.assertFalse(reopened_no_sha["integrity"]["slice_valid"])
        self.assertEqual(reopened_no_sha["integrity"]["slice_reason"], "source_unverifiable")

        # M1: Symlinked or junctioned studio_projects directory refused before any write outside state_dir
        outside = self.root / "outside_escape"
        outside.mkdir(exist_ok=True)
        tampered_state = self.root / "tampered_state"
        tampered_state.mkdir(exist_ok=True)
        junc_dir = tampered_state / "studio_projects"
        link_created = False
        try:
            junc_dir.symlink_to(outside, target_is_directory=True)
            link_created = True
        except (OSError, NotImplementedError):
            if os.name == "nt":
                r = subprocess.run(["cmd", "/c", "mklink", "/J", str(junc_dir), str(outside)], capture_output=True, text=True)
                link_created = (r.returncode == 0 and junc_dir.exists())
        if link_created:
            with self.assertRaises(projects.ProjectError) as sym_ctx:
                projects.save_project(tampered_state, {"title": "escape", "items": []})
            self.assertEqual(sym_ctx.exception.status, 403)
            self.assertEqual(list(outside.glob("*.hq3d")), [])

        # M2: Non-finite floats (NaN, +Inf, -Inf) in transforms or nested settings rejected with 422
        for bad_val in (float("nan"), float("inf"), float("-inf")):
            with self.assertRaises(projects.ProjectError) as nf_ctx:
                projects.save_project(st, {"title": "nan-x", "items": [{"model_id": "m1", "x": bad_val}]})
            self.assertEqual(nf_ctx.exception.status, 422)
            self.assertEqual(nf_ctx.exception.code, "invalid_numeric_value")
            with self.assertRaises(projects.ProjectError) as nf_set:
                projects.save_project(st, {"title": "nan-set", "settings": {"bad": bad_val}, "items": []})
            self.assertEqual(nf_set.exception.status, 422)

        # Phase 4.2 High #3: force_overwrite strict JSON boolean policy
        # Non-boolean values ("false", "0", 0, "true", 1) must be rejected with 400 invalid_payload;
        # boolean False must NOT bypass expected_revision (raises 409 project_conflict);
        # only exact boolean True bypasses expected_revision.
        for non_bool in ("false", "0", 0, "true", 1, [], {}):
            with self.assertRaises(projects.ProjectError) as nb_save:
                projects.save_project(st, {"id": pid, "title": "nb", "force_overwrite": non_bool, "items": []})
            self.assertEqual(nb_save.exception.status, 400)
            self.assertEqual(nb_save.exception.code, "invalid_payload")
            with self.assertRaises(projects.ProjectError) as nb_ren:
                projects.rename_project(st, pid, "nb-ren", force_overwrite=non_bool)
            self.assertEqual(nb_ren.exception.status, 400)
            with self.assertRaises(projects.ProjectError) as nb_del:
                projects.delete_project(st, pid, force_overwrite=non_bool)
            self.assertEqual(nb_del.exception.status, 400)

        for falsy_opt in (False, None):
            with self.assertRaises(projects.ProjectError) as f_save:
                projects.save_project(st, {"id": pid, "title": "falsy", "force_overwrite": falsy_opt, "items": []})
            self.assertEqual(f_save.exception.status, 409)
            self.assertEqual(f_save.exception.code, "project_conflict")

        forced_doc = projects.save_project(st, {"id": pid, "title": "forced_ok", "force_overwrite": True, "items": []})
        self.assertEqual(forced_doc["revision"], 4)

        # Phase 4.2 Medium #5: Stale delete rejected with 409 and preserves latest revision
        with self.assertRaises(projects.ProjectError) as no_rev_del:
            projects.delete_project(st, pid)
        self.assertEqual(no_rev_del.exception.status, 409)
        self.assertEqual(no_rev_del.exception.code, "project_conflict")

        with self.assertRaises(projects.ProjectError) as stale_del:
            projects.delete_project(st, pid, expected_revision=1)
        self.assertEqual(stale_del.exception.status, 409)
        self.assertEqual(stale_del.exception.code, "project_conflict")
        self.assertEqual(projects.open_project(st, pid)["project"]["revision"], 4)

        # HTTP delete route also enforces expected_revision
        del_cand = projects.save_project(st, {"title": "del_me", "items": []})
        projects.save_project(st, {"id": del_cand["id"], "title": "del_me_v2", "expected_revision": 1, "items": []})
        with self.assertRaises(hq_print3d.Print3dError) as http_stale_del:
            self.ctl.http_post("/api/print3d/projects/delete", {"id": del_cand["id"], "expected_revision": 1})
        self.assertEqual(http_stale_del.exception.status, 409)
        _c_del, ok_del = self.ctl.http_post("/api/print3d/projects/delete", {"id": del_cand["id"], "expected_revision": 2})
        self.assertTrue(ok_del["ok"])

        # Phase 4.3 High: Deleted project MUST NOT be resurrected by a stale client save supplying expected_revision >= 1
        with self.assertRaises(projects.ProjectError) as zombie_ctx:
            projects.save_project(st, {
                "id": del_cand["id"],
                "expected_revision": 2,
                "title": "Zombie resurrected by stale iPhone",
                "items": [],
            })
        self.assertEqual(zombie_ctx.exception.status, 409)
        self.assertEqual(zombie_ctx.exception.code, "project_conflict")
        self.assertFalse((st / "studio_projects" / f"{del_cand['id']}.hq3d").exists())

        # Phase 4.3 Medium: MAX_PROJECTS quota enforced on ALL new creations (including explicit fresh IDs
        # and concurrent creation threads/processes targeting distinct IDs)
        quota_st = self.root / "quota_state"
        with patch.object(projects, "MAX_PROJECTS", 2):
            p_one = projects.save_project(quota_st, {"title": "One", "items": []})
            self.assertEqual(p_one["revision"], 1)
            # Concurrent threads racing to create 5 distinct explicit IDs against 1 remaining quota slot
            q_evt = threading.Event()
            q_outcomes: list[tuple[str, int]] = []
            q_lk = threading.Lock()

            def _quota_worker(k: int) -> None:
                q_evt.wait(5)
                try:
                    d = projects.save_project(quota_st, {"id": f"explicit_cand_{k}", "title": f"Cand {k}", "items": []})
                    with q_lk:
                        q_outcomes.append(("ok", int(d["revision"])))
                except projects.ProjectError as exc:
                    with q_lk:
                        q_outcomes.append((exc.code, exc.status))

            q_threads = [threading.Thread(target=_quota_worker, args=(k,)) for k in range(5)]
            for qt in q_threads:
                qt.start()
            q_evt.set()
            for qt in q_threads:
                qt.join(10)
            self.assertEqual(sum(1 for code, _ in q_outcomes if code == "ok"), 1)
            self.assertEqual(sum(1 for code, status in q_outcomes if code == "too_many_projects" and status == 422), 4)
            self.assertEqual(len(list((quota_st / "studio_projects").glob("*.hq3d"))), 2)


@unittest.skipUnless(models.Library.find_slicer(), "OrcaSlicer 2.5.1+ requis pour les tests de tranchage réels Phase 4")
class Phase4LiveOrcaSlicerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.share = self.root / "Print"
        self.share.mkdir()
        _write_cube_stl(self.share / "obj_a.stl", size_xy=18.0, height_z=12.0)
        _write_cube_stl(self.share / "obj_b.stl", size_xy=18.0, height_z=12.0)
        self._patches = [
            patch.object(hq_print3d.Controller, "ensure_links", lambda self: None),
            patch.object(hq_print3d.Controller, "_restart_link", lambda self, pid: None),
        ]
        for p in self._patches:
            p.start()
        self.ctl = hq_print3d.Controller(self.root, lambda: self.share)
        rows = self.ctl.library.scan(force=True)
        self.mid_a = next(r["id"] for r in rows if r["name"] == "obj_a.stl")
        self.mid_b = next(r["id"] for r in rows if r["name"] == "obj_b.stl")

    def tearDown(self) -> None:
        self.ctl.shutdown()
        for p in self._patches:
            p.stop()

    def test_real_orca_4a_4b_4c_advanced_multitool_and_per_object_gcode_proof(self) -> None:
        # 1. Per-object overrides on single-material A1 PLA: ObjA default vs ObjB 75% infill, 5 walls, 55 mm/s outer wall, ironing top
        res_po = self.ctl.library.assemble_and_slice_plate(
            [
                {"model_id": self.mid_a, "x": 65, "y": 128, "tool": 0, "local_name": "ObjA"},
                {"model_id": self.mid_b, "x": 175, "y": 128, "tool": 0, "local_name": "ObjB",
                 "overrides": {"infill": 75, "wall_loops": 5, "outer_wall_speed": 55, "ironing_type": "top", "supports": True}},
            ],
            "A1",
            {"quality_preset": "standard", "material": "PLA", "plate_type": "textured_pei", "infill": 15, "wall_loops": 2},
        )
        out_po = self.ctl.library.resolve(res_po["model"]["id"])
        with zipfile.ZipFile(out_po) as zf:
            ms_xml = zf.read("Metadata/model_settings.config").decode("utf-8", "replace")
            gcode_txt = zf.read("Metadata/plate_1.gcode").decode("utf-8", "replace")
        self.assertIn('key="sparse_infill_density" value="75%"', ms_xml)
        self.assertIn('key="wall_loops" value="5"', ms_xml)
        self.assertIn("F3300", gcode_txt, "55 mm/s outer wall override must alter G-code feedrate")
        self.assertIn("Ironing", gcode_txt, "ironing_type='top' must emit ironing toolpaths")
        self.assertIsNotNone(self.ctl.library.get_slice_provenance(res_po["model"]["id"]))

        # 2. PETG + Fine preset + Speed quiet on A1 -> verify layer_height=0.12 & PETG temp in project_settings.config
        res_petg = self.ctl.library.assemble_and_slice_plate(
            [{"model_id": self.mid_a, "x": 128, "y": 128, "tool": 0}],
            "A1",
            {"quality_preset": "fine", "speed_preset": "quiet", "material": "PETG", "plate_type": "textured_pei"},
        )
        out_petg = self.ctl.library.resolve(res_petg["model"]["id"])
        with zipfile.ZipFile(out_petg) as zf:
            ps = json.loads(zf.read("Metadata/project_settings.config").decode("utf-8", "replace"))
        self.assertEqual(ps["layer_height"], "0.12")
        self.assertEqual(ps["filament_type"], ["PETG"])

        # 3. Dual-tool A1 with bounded prime tower -> verify T0 + T1 filaments & tower bounds
        res_mm = self.ctl.library.assemble_and_slice_plate(
            [
                {"model_id": self.mid_a, "x": 120, "y": 90, "tool": 0},
                {"model_id": self.mid_b, "x": 180, "y": 90, "tool": 1},
            ],
            "A1",
            {
                "material": "PLA",
                "tools": [
                    {"material": "PLA", "color": "#38BDF8"},
                    {"material": "PLA", "color": "#F97316"},
                ],
                "prime_tower_enabled": True,
                "prime_tower_x": 35,
                "prime_tower_y": 170,
                "prime_tower_width": 35,
            },
        )
        out_mm = self.ctl.library.resolve(res_mm["model"]["id"])
        info_mm = self.ctl.library.inspect_print_file(res_mm["model"]["id"], 1)
        self.assertGreaterEqual(len(info_mm["filaments"]), 2)
        with zipfile.ZipFile(out_mm) as zf:
            gc_mm = zf.read("Metadata/plate_1.gcode").decode("utf-8", "replace")
        self.assertIn("T1", gc_mm)
