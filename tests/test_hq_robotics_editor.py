"""3D editor scripts: dry-run check, import into the library, and the Kinétia -> reviewer -> Maître order."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_robotics as robotics  # noqa: E402
import hq_robotics_arm as arm  # noqa: E402
import hq_robotics_assistant as assistant  # noqa: E402
from tests.test_hq_robotics import FakeArm, FakeCamera  # noqa: E402


def fake_model(verdict="pass"):
    return lambda chain, system, payload, seconds=36: ({"verdict": verdict, "notes": "notes"}, chain[0])


class EditorScripts(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="hq-robotics-editor-")
        self.addCleanup(temp.cleanup)
        self.lab = robotics.Robotics(Path(temp.name), clock=lambda: 100.0,
                                    arm_factory=lambda *_: FakeArm(), camera=FakeCamera())
        self.addCleanup(self.lab.close)
        self.start = arm.HOME.copy()
        self.steps = [{**arm.HOME, "base": 20}, {**arm.HOME, "base": 20, "hand": 120}, arm.HOME.copy()]

    def send(self, action, data):
        return assistant.dispatch(self.lab, action, "POST", data, "owner", lambda: True)

    def payload(self, **extra):
        return {"title": "Balayage", "summary": "Tourne la base de 20° et ouvre la pince.",
                "start": self.start, "steps": self.steps, **extra}

    def stored(self):
        return assistant.load(assistant.store_path(self.lab, "owner"))

    def test_dry_run_checks_without_saving(self):
        result = self.send("import", self.payload(dry_run=True))
        self.assertTrue(result["valid"])
        self.assertEqual(result["step_count"], 3)
        self.assertGreater(result["estimated_seconds"], 0)
        self.assertEqual(self.stored()["scripts"], {})

    def test_dry_run_names_the_failing_leg(self):
        self.steps[1] = {**arm.HOME, "shoulder": 80}
        result = self.send("import", self.payload(dry_run=True))
        self.assertFalse(result["valid"])
        self.assertEqual(result["leg"], 2)
        self.assertTrue(result["reason"].startswith("Étape 2"))
        # A failing script is never stored, even without dry_run.
        self.assertFalse(self.send("import", self.payload())["valid"])
        self.assertEqual(self.stored()["scripts"], {})

    def test_keepout_on_the_swept_path_is_a_leg_failure(self):
        self.lab.dispatch("settings", "POST", {"keepout": [{"name": "Bac", "x": [200, 360], "y": [60, 200],
                                                             "z": [150, 320]}]},
                          "a", local=True, physical=True, authorized=lambda: True)
        self.steps = [{**arm.HOME, "base": 30}]
        result = self.send("import", self.payload(dry_run=True))
        self.assertFalse(result["valid"])
        self.assertIn("Bac", result["reason"])

    def test_import_then_kinetia_then_reviewer_then_maitre(self):
        thread = self.send("import", self.payload())
        key = thread["imported"]
        script = self.stored()["scripts"][key]
        self.assertEqual(script["origin"], "editor")
        self.assertTrue(script["saved"])
        self.assertEqual(script["draft_model"], assistant.EDITOR_MODEL)
        version = {"id": key, "digest": script["digest"]}
        # The reviewer model may not go first, and approval is refused without both passes.
        with mock.patch.object(assistant, "model_json", fake_model()):
            with self.assertRaises(robotics.Rejected):
                self.send("review", version)
        with self.assertRaises(robotics.Rejected):
            self.send("approve", {**version, "confirmed": True})
        with mock.patch.object(assistant, "model_json", fake_model()):
            self.send("review-kinetia", version)
            self.assertEqual(self.stored()["scripts"][key]["kinetia_review"]["verdict"], "pass")
            self.send("review", version)
        stored = self.stored()["scripts"][key]
        self.assertTrue(assistant.model_approved(stored))
        self.send("approve", {**version, "confirmed": True})
        approval = self.stored()["scripts"][key]["approval"]
        self.assertFalse(approval["manual"])

    def test_kinetia_revise_blocks_model_approval_but_manual_stays_possible(self):
        key = self.send("import", self.payload())["imported"]
        version = {"id": key, "digest": self.stored()["scripts"][key]["digest"]}
        with mock.patch.object(assistant, "model_json", fake_model("revise")):
            self.send("review-kinetia", version)
        with mock.patch.object(assistant, "model_json", fake_model()):
            with self.assertRaises(robotics.Rejected):
                self.send("review", version)
        self.assertFalse(assistant.model_approved(self.stored()["scripts"][key]))
        self.send("approve", {**version, "confirmed": True, "manual": True})
        self.assertTrue(self.stored()["scripts"][key]["approval"]["manual"])

    def test_kinetia_review_is_only_for_editor_scripts(self):
        key = self.send("import", self.payload())["imported"]
        state = self.stored()
        state["scripts"][key]["origin"] = None
        self.lab.write(assistant.store_path(self.lab, "owner"), state)
        with mock.patch.object(assistant, "model_json", fake_model()):
            with self.assertRaises(robotics.Rejected):
                self.send("review-kinetia", {"id": key, "digest": state["scripts"][key]["digest"]})

    # ---- shaped legs
    def tip(self, pose):
        point = arm.position(pose)
        return (point["x"], point["y"], point["z"])

    def shaped(self, legs, steps=None):
        self.steps = steps or [{**arm.HOME, "base": 30}]
        thread = self.send("import", self.payload(legs=legs))
        self.assertTrue(thread.get("valid", True), thread)
        return self.stored()["scripts"][thread["imported"]]

    def test_linear_leg_keeps_the_gripper_on_the_straight_line(self):
        script = self.shaped([{"type": "linear"}])
        a, b = self.tip(self.start), self.tip(self.steps[0])
        self.assertGreater(len(script["steps"]), 5)
        self.assertEqual(script["steps"][-1], self.steps[0])
        ab = [q - p for p, q in zip(a, b)]
        for pose in script["steps"]:
            ap = [q - p for p, q in zip(a, self.tip(pose))]
            cross = [ab[1]*ap[2] - ab[2]*ap[1], ab[2]*ap[0] - ab[0]*ap[2], ab[0]*ap[1] - ab[1]*ap[0]]
            distance = sum(c * c for c in cross) ** .5 / sum(c * c for c in ab) ** .5
            self.assertLess(distance, .5)
        self.assertEqual(script["plan"]["legs"], [{"type": "linear"}])

    def test_arc_leg_passes_near_its_via_point_and_a_full_turn_is_longer(self):
        a, b = self.tip(self.start), self.tip({**arm.HOME, "base": 30})
        via = {"x": (a[0] + b[0]) / 2, "y": (a[1] + b[1]) / 2, "z": a[2] + 60}
        script = self.shaped([{"type": "arc", "via": via}])
        closest = min(sum((p - q) ** 2 for p, q in zip(self.tip(pose), (via["x"], via["y"], via["z"]))) ** .5
                      for pose in script["steps"])
        self.assertLess(closest, assistant.LEG_SAMPLE_MM)
        loop = self.shaped([{"type": "arc", "via": via, "turns": 1}])
        self.assertGreater(len(loop["steps"]), len(script["steps"]))

    def test_aligned_arc_and_unknown_type_are_named_failures(self):
        a, b = self.tip(self.start), self.tip({**arm.HOME, "base": 30})
        via = {"x": (a[0] + b[0]) / 2, "y": (a[1] + b[1]) / 2, "z": a[2]}
        self.steps = [{**arm.HOME, "base": 30}]
        result = self.send("import", self.payload(legs=[{"type": "arc", "via": via}], dry_run=True))
        self.assertFalse(result["valid"])
        self.assertEqual(result["leg"], 1)
        unknown = self.send("import", self.payload(legs=[{"type": "spiral"}], dry_run=True))
        self.assertFalse(unknown["valid"])
        self.assertIn("Type de trajectoire inconnu", unknown["reason"])
        missing = self.send("import", self.payload(legs=[], dry_run=True))
        self.assertFalse(missing["valid"])
        self.assertIn("Une trajectoire par étape", missing["reason"])
        no_via = self.send("import", self.payload(legs=[{"type": "arc"}], dry_run=True))
        self.assertFalse(no_via["valid"])
        self.assertIn("Point de passage", no_via["reason"])

    def test_smooth_legs_and_the_generated_pose_cap(self):
        steps = [{**arm.HOME, "base": 25}, {**arm.HOME, "base": 25, "shoulder": 15}, arm.HOME.copy()]
        script = self.shaped([{"type": "smooth"}] * 3, steps)
        self.assertGreater(len(script["steps"]), assistant.MAX_STEPS)
        with mock.patch.object(assistant, "MAX_EXPANDED", 10):
            self.steps = steps
            result = self.send("import", self.payload(legs=[{"type": "smooth"}] * 3, dry_run=True))
        self.assertFalse(result["valid"])
        self.assertIn("poses générées", result["reason"])

    def test_plan_is_part_of_the_version_and_long_scripts_finish_review(self):
        script = self.shaped([{"type": "linear"}])
        self.assertIn("plan", script)
        changed = {**script, "plan": {**script["plan"], "legs": [{"type": "smooth"}]}}
        self.assertNotEqual(assistant.script_digest(changed), script["digest"])
        legacy = {key: value for key, value in script.items() if key != "plan"}
        self.assertEqual(assistant.script_digest(legacy), assistant.script_digest({**legacy, "plan": None}))
        key = next(k for k, v in self.stored()["scripts"].items() if v["digest"] == script["digest"])
        version = {"id": key, "digest": script["digest"]}
        with mock.patch.object(assistant, "model_json", fake_model()):
            self.send("review-kinetia", version)
            self.send("review", version)
        self.send("approve", {**version, "confirmed": True})
        self.assertIsNotNone(self.stored()["scripts"][key]["approval"])

    def test_json_edit_of_a_long_editor_script_still_reviews(self):
        steps = [{**arm.HOME, "base": 25}, {**arm.HOME, "base": 25, "shoulder": 15}, arm.HOME.copy()]
        script = self.shaped([{"type": "smooth"}] * 3, steps)
        key = next(k for k, v in self.stored()["scripts"].items() if v["digest"] == script["digest"])
        self.assertGreater(len(script["steps"]), assistant.MAX_STEPS)
        edited = [dict(step) for step in script["steps"]]
        edited[3]["hand"] = 150
        self.send("library/edit", {"id": key, "digest": script["digest"], "script": {"steps": edited}})
        fresh_key, fresh = next((k, v) for k, v in self.stored()["scripts"].items() if v.get("parent") == key)
        self.assertEqual(fresh["origin"], "editor")
        self.assertNotIn("plan", fresh)
        with mock.patch.object(assistant, "model_json", fake_model()):
            self.send("review-kinetia", {"id": fresh_key, "digest": fresh["digest"]})
            self.send("review", {"id": fresh_key, "digest": fresh["digest"]})

    def test_a_leg_that_would_swing_the_elbow_between_branches_is_refused(self):
        # elbow below the IK branch (~7 deg): the shaped leg cannot follow it without a configuration jump
        low = {**arm.HOME, "shoulder": 30, "elbow": -20}  # reachable, and its joint path stays in the workspace
        self.assertTrue(self.reachable(low))
        self.steps = [low]
        result = self.send("import", self.payload(legs=[{"type": "linear"}], dry_run=True))
        self.assertFalse(result["valid"])
        self.assertIn("discontinue", result["reason"])
        self.assertEqual(result["leg"], 1)
        # the same target is fine as an articulaire leg
        self.assertTrue(self.send("import", self.payload(legs=[{"type": "joint"}], dry_run=True))["valid"])

    def reachable(self, pose):
        cfg = self.lab.config()
        try:
            arm.validate_pose(pose, cfg["joint_limits"], cfg["workspace"])
            arm.validate_path(arm.HOME, pose, cfg["joint_limits"], cfg["workspace"])
        except ValueError:
            return False
        return True

    def test_browser_shapes_match_the_servers(self):
        import json
        import shutil
        import subprocess
        node = shutil.which("node")
        if not node:
            self.skipTest("node is not installed")
        a = self.tip(self.start)
        b = self.tip({**arm.HOME, "base": 30})
        via = {"x": round((a[0] + b[0]) / 2, 1), "y": round((a[1] + b[1]) / 2, 1), "z": round(a[2] + 60, 1)}
        points = [{**arm.HOME, "base": 30}, {**arm.HOME, "base": 30, "shoulder": 15, "hand": 120}, arm.HOME.copy()]
        cases = {"linear": [{"type": "linear"}] * 3,
                 "arc": [{"type": "arc", "via": via, "turns": 0}, {"type": "smooth"}, {"type": "joint"}],
                 "turn": [{"type": "arc", "via": via, "turns": 1}, {"type": "linear"}, {"type": "smooth"}]}
        cfg = self.lab.config()
        with tempfile.TemporaryDirectory(prefix="hq-3d-parity-") as folder:
            path = Path(folder) / "cases.json"
            path.write_text(json.dumps({name: {"start": self.start, "points": points, "legs": legs}
                                        for name, legs in cases.items()}), encoding="utf-8")
            done = subprocess.run([node, str(ROOT / "tests" / "check_hq_robotics_3d.mjs"), str(path)],
                                  capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        browser = json.loads(done.stdout)
        for name, legs in cases.items():
            server, _ = assistant.expand_legs(cfg, self.start, points, [assistant.leg(item) for item in legs])
            self.assertEqual(len(browser[name]), len(server), name)
            for mine, theirs in zip(browser[name], server):
                for key in ("base", "shoulder", "elbow", "hand"):
                    self.assertAlmostEqual(mine[key], theirs[key], delta=.01, msg=f"{name} {key}")

    def test_a_step_that_does_not_move_is_a_warning_not_an_error(self):
        self.steps = [{**arm.HOME, "base": 20}, {**arm.HOME, "base": 20.1}, {**arm.HOME, "base": 40}]
        result = self.send("import", self.payload(dry_run=True))
        self.assertTrue(result["valid"])
        self.assertEqual(result["warnings"], ["Étape 2 identique à la précédente : aucun mouvement."])
        self.steps = [{**arm.HOME, "base": 20}]
        self.assertEqual(self.send("import", self.payload(dry_run=True))["warnings"], [])
        self.steps = [arm.HOME.copy()]
        self.assertEqual(len(self.send("import", self.payload(dry_run=True))["warnings"]), 1)

    def test_bad_title_and_step_count_are_refused(self):
        bad_title = self.send("import", self.payload(title=""))
        self.assertFalse(bad_title["valid"])
        self.assertIn("Titre", bad_title["reason"])
        self.assertEqual(self.stored()["scripts"], {})  # a refused script is never stored
        self.steps = []
        no_steps = self.send("import", self.payload(dry_run=True))
        self.assertFalse(no_steps["valid"])
        self.assertIn("1 à 16", no_steps["reason"])

    def test_per_leg_speed_pct_and_dwell_scale_duration_and_resolve_step(self):
        fast = self.send("import", self.payload(legs=[{"type": "joint"}, {"type": "joint"}, {"type": "joint"}], dry_run=True))
        slow_dwell = self.send("import", self.payload(
            legs=[{"type": "joint", "speed_pct": 50, "dwell": 1.5}, {"type": "joint"}, {"type": "joint"}],
            dry_run=True,
        ))
        self.assertTrue(fast["valid"])
        self.assertTrue(slow_dwell["valid"])
        self.assertGreater(slow_dwell["estimated_seconds"], fast["estimated_seconds"] + 1.4)
        thread = self.send("import", self.payload(
            legs=[{"type": "joint", "speed_pct": 50, "dwell": 1.5}, {"type": "joint"}, {"type": "joint"}]
        ))
        key = thread["imported"]
        script = self.stored()["scripts"][key]
        version = {"id": key, "digest": script["digest"]}
        with mock.patch.object(assistant, "model_json", fake_model()):
            self.send("review-kinetia", version)
            self.send("review", version)
        self.send("approve", {**version, "confirmed": True})
        _pose, step_spd, _info = assistant.resolve_step(self.lab, self.lab.config(), "owner", {**version, "index": 0})
        self.assertEqual(step_spd, 50)
        self.assertEqual(assistant.leg_spec_for_step(self.stored()["scripts"][key], 0)["dwell"], 1.5)

    def test_synthesize_transfer_pallet_and_inspect_plans(self):
        tx = self.send("import", {
            "synthesize": "transfer",
            "source": {"x": 240, "y": -80, "z": 75},
            "dest": {"x": 240, "y": 80, "z": 75},
            "clearance_z": 50,
            "dry_run": True,
        })
        self.assertTrue(tx["valid"], tx)
        self.assertEqual(tx["authored_steps"], 8)
        self.assertIn("synthesized", tx)
        pal = self.send("import", {
            "synthesize": "pallet",
            "rows": 2,
            "cols": 3,
            "corner_a": {"x": 200, "y": -70, "z": 70},
            "corner_b": {"x": 280, "y": 70, "z": 70},
            "dry_run": True,
        })
        self.assertTrue(pal["valid"], pal)
        self.assertEqual(len(pal["synthesized"]["cells"]), 6)
        insp = self.send("import", {
            "synthesize": "inspect",
            "stops": 5,
            "span_deg": 25,
            "dwell": 1.0,
            "dry_run": True,
        })
        self.assertTrue(insp["valid"], insp)
        self.assertEqual(insp["authored_steps"], 6)


class WholeArmZones(unittest.TestCase):
    """A box 28 mm beside the gripper: the gripper point never enters it, the bare 22 mm forearm tube
    misses it, the gripper (fingers ~34 mm sideways) does not."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="hq-robotics-zones-")
        self.addCleanup(temp.cleanup)
        self.lab = robotics.Robotics(Path(temp.name), clock=lambda: 100.0,
                                    arm_factory=lambda *_: FakeArm(), camera=FakeCamera())
        self.addCleanup(self.lab.close)
        tcp = arm.position(arm.HOME)
        self.zone = {"name": "Bord", "x": [tcp["x"] - 5, tcp["x"] + 5], "y": [28, 40],
                     "z": [tcp["z"] - 5, tcp["z"] + 5]}
        self.call("settings", {"keepout": [self.zone]})
        self.near = {**arm.HOME, "base": .5}

    def call(self, action, data=None, method="POST"):
        return self.lab.dispatch(action, method, data or {}, "a", local=True, physical=True, authorized=lambda: True)

    def test_gripper_shape_is_checked_not_only_the_point(self):
        self.assertIsNotNone(arm.async_box_clearance(arm.HOME, self.near, [self.zone])["collision_zone"])
        with mock.patch.object(arm, "GRIPPER_EXTRA", 0.0):
            self.assertIsNone(arm.async_box_clearance(arm.HOME, self.near, [self.zone])["collision_zone"])

    def test_simulation_move_and_preview_use_the_whole_arm(self):
        lease = self.call("arm")["lease"]
        ticket = self.call("status", {"lease": lease}, method="GET")["ticket"]
        with self.assertRaises(robotics.Rejected) as caught:
            self.call("move", {"lease": lease, "ticket": ticket, "kind": "joints", "pose": self.near})
        self.assertEqual(caught.exception.code, "robotics_keepout")
        with self.assertRaises(robotics.Rejected):
            self.call("preview", {"kind": "joints", "pose": self.near})

    def test_streamed_targets_use_the_whole_arm(self):
        cfg = self.lab.config()
        with self.assertRaises(robotics.Rejected):
            self.lab._validate_stream_waypoints(cfg, arm.HOME.copy(), {**arm.HOME, "base": 1.0}, 1.0)


if __name__ == "__main__":
    unittest.main()
