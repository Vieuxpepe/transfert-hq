"""Robotics safety and transport tests. Every device is fake or loopback."""

from contextlib import contextmanager
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import hq_robotics as robotics
import hq_robotics_assistant as assistant
import hq_robotics_arm as arm
import hq_robotics_camera as camera
import hq_robotics_estop as estop
import hq_robotics_ptz as ptz
import hq_robotics_tapo as tapo


class FakeCamera:
    def __init__(self):
        self.stopped = 0

    def stop(self):
        self.stopped += 1


class FakeArm:
    def __init__(self):
        self.actual = arm.HOME.copy()
        self.calls = []
        self.error = None
        self.follow = False  # True: the fake arm reaches every goal at once, like a fast servo
        self.feedback_gate = None
        self.torque = {key: 1 for key in arm.JOINTS}

    def feedback(self):
        self.calls.append("feedback")
        if self.feedback_gate:
            self.feedback_gate()
        if self.error == "feedback":
            raise arm.DeviceError("device timeout")
        return {"source": "hardware", "actual": self.actual.copy(), "xyz": arm.position(self.actual),
                "load": {}, "torque": dict(self.torque), "voltage": None}

    def move(self, pose, speed, acceleration):
        self.calls.append(("move", pose, speed, acceleration))
        if self.error == "move":
            raise arm.DeviceError("device timeout")
        if self.follow:
            self.actual = {key: pose[key] for key in arm.JOINTS}

    def emergency_stop(self):
        self.calls.append("stop")


class Controller(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hq-robotics-")
        self.addCleanup(self.temp.cleanup)
        self.now = 100.0
        self.arm = FakeArm()
        self.cam = FakeCamera()
        self.lab = robotics.Robotics(Path(self.temp.name), clock=lambda: self.now,
                                    arm_factory=lambda *_: self.arm, camera=self.cam)
        self.addCleanup(self.lab.close)
        self.permitted = True
        # Streamed moves run inline here and advance the fake clock instead of sleeping.
        self.lab.stream_threaded = False
        self.lab.stream_sleep = lambda seconds: setattr(self, "now", self.now + seconds)

    def call(self, action, data=None, *, method="POST", session="a", local=True):
        return self.lab.dispatch(action, method, data or {}, session,
                                 local=local, physical=local, authorized=lambda: self.permitted)

    def status(self, lease="", **kwargs):
        return self.call("status", {"lease": lease}, method="GET", **kwargs)

    def arm_keys(self):
        lease = self.call("arm")["lease"]
        return {"lease": lease, "ticket": self.status(lease)["ticket"]}

    def hardware(self, *, commissioned=True, video=True, camera_required=True):
        cfg = self.call("settings", {"mode": "hardware", "arm_ip": "192.168.4.15",
                                     "camera_required": camera_required})["config"]
        if commissioned:
            self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        if video:
            self.lab.video = robotics.Stream("a", "stream", "standard", self.now + 10,
                                             True, self.now, self.now)
        self.call("telemetry")
        self.arm.calls.clear()

    def test_simulation_validation_ownership_and_replay(self):
        initial = self.status()
        self.assertFalse(initial["armed"])
        self.assertEqual(initial["feedback"]["source"], "simulation")
        with self.assertRaisesRegex(robotics.Rejected, "Armer"):
            self.call("move", {"kind": "home"})
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, "occupé"):
            self.call("arm", session="b")
        with self.assertRaises(robotics.Rejected):
            self.call("move", {**keys, "kind": "home"}, session="b")
        for bad in (math.nan, math.inf, -math.inf, True, "2", 81):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": bad}})
        target = {**arm.HOME, "base": 5}
        self.assertTrue(self.call("move", {**keys, "kind": "joints", "pose": target})["moving"])
        self.now += 2
        self.assertEqual(self.status(keys["lease"])["feedback"]["actual"], target)
        with self.assertRaisesRegex(robotics.Rejected, "expirée"):
            self.call("move", {**keys, "kind": "home"})
        self.assertEqual(self.arm.calls, [])

    def test_expiry_stop_preset_and_sequence(self):
        keys = self.arm_keys()
        self.now += robotics.TICKET_SECONDS
        with self.assertRaisesRegex(robotics.Rejected, "expirée"):
            self.call("move", {**keys, "kind": "home"})
        self.now += robotics.LEASE_SECONDS
        self.assertFalse(self.status(keys["lease"])["armed"])
        item = self.call("presets", {"action": "save", "name": "Repos", "kind": "home"})["presets"]
        key = next(iter(item))
        self.assertEqual(item[key]["profile"], robotics.PROFILE)
        self.call("presets", {"action": "rename", "id": key, "name": "Neutre"})
        self.assertEqual(self.call("preview", {"kind": "preset", "id": key})["pose"], arm.HOME)
        self.assertEqual(len(self.call("sequence", {"steps": [{"kind": "preset", "id": key}]})["steps"]), 1)
        self.call("presets", {"action": "delete", "id": key})
        self.assertTrue(self.call("stop")["stop_latched"])
        with self.assertRaisesRegex(robotics.Rejected, "Inspection"):
            self.call("arm")
        self.call("reset")
        self.assertTrue(self.arm_keys()["ticket"])

    def test_recorded_scripts_are_validated_named_and_removable(self):
        recording = self.call("recordings", {"action": "save", "name": "Balayage",
                                             "start": dict(arm.HOME),
                                             "steps": [{**arm.HOME, "base": 2},
                                                       {**arm.HOME, "base": 4}]})["recordings"]
        key = next(iter(recording))
        self.assertEqual([step["base"] for step in recording[key]["steps"]], [2, 4])
        self.assertEqual(recording[key]["profile"], robotics.PROFILE)
        self.assertEqual(len(recording[key]["trace"]), 3)
        self.assertAlmostEqual(recording[key]["trace"][0]["x"], arm.position(arm.HOME)["x"], places=2)
        self.assertAlmostEqual(recording[key]["trace"][2]["x"],
                               arm.position({**arm.HOME, "base": 4})["x"], places=2)
        self.call("recordings", {"action": "rename", "id": key, "name": "Plan"})
        self.call("recordings", {"action": "update", "id": key,
                                 "steps": [{**arm.HOME, "base": 6}]})
        edited = self.call("recordings", method="GET")["recordings"][key]
        self.assertEqual([step["base"] for step in edited["steps"]], [6])
        self.assertEqual(edited["name"], "Plan")
        self.assertEqual(edited["start"], arm.HOME)
        self.assertEqual(len(edited["trace"]), 2)
        self.assertAlmostEqual(edited["trace"][1]["x"],
                               arm.position({**arm.HOME, "base": 6})["x"], places=2)
        with self.assertRaises(ValueError):
            self.call("recordings", {"action": "update", "id": key, "steps": []})
        for bad in ([], [{**arm.HOME, "base": 900}], [{**arm.HOME, "base": math.nan}]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.call("recordings", {"action": "save", "name": "Invalide",
                                         "start": dict(arm.HOME), "steps": bad})
        with self.assertRaises(robotics.Rejected):
            self.call("recordings", {"action": "delete", "id": "inconnu"})
        self.call("recordings", {"action": "delete", "id": key})
        self.assertEqual(self.call("recordings", method="GET")["recordings"], {})

    def test_keepout_blackbox_load_limits_and_saved_routines(self):
        # A TCP exclusion box rejects the target and the sampled path, but not a pose outside it.
        self.call("settings", {"keepout": [{"name": "Table", "x": [200, 300], "y": [80, 220],
                                               "z": [25, 300]}]})
        self.assertTrue(self.call("preview", {"kind": "home"})["pose"])
        blocked = {**arm.HOME, "base": 20}
        with self.assertRaisesRegex(robotics.Rejected, "Table"):
            self.call("preview", {"kind": "joints", "pose": blocked})
        with self.assertRaisesRegex(robotics.Rejected, "Table"):
            self.call("sequence", {"steps": [{"kind": "joints", "pose": blocked}]})
        with self.assertRaises(robotics.Rejected):
            self.call("routines", {"action": "save", "name": "Bloquée",
                                   "steps": [{"kind": "joints", "pose": blocked}]})
        with self.assertRaises(ValueError):
            self.call("settings", {"keepout": [{"name": "Table", "x": [200, 300],
                                                "y": [80, 220], "z": [25, 300]},
                                               {"name": "table", "x": [100, 150],
                                                "y": [80, 220], "z": [25, 300]}]})
        with self.assertRaises(ValueError):
            self.call("settings", {"load_warn": 900, "load_critical": 800})

        self.call("settings", {"keepout": [], "load_warn": 600, "load_critical": 850})
        self.now += 1
        self.status()
        entries = self.call("blackbox", method="GET")["entries"]
        self.assertGreaterEqual(len(entries), 1)
        self.assertEqual(entries[0]["estop"], {"mode": "simulation", "healthy": True})
        self.assertEqual(self.status()["config"]["load_warn"], 600)

        saved = self.call("routines", {"action": "save", "name": "Balayage",
                                       "parameters": {"base_delta": 2, "repeats": 2},
                                       "steps": [{"kind": "joints", "pose": {**arm.HOME, "base": 2}},
                                                 {"kind": "joints", "pose": {**arm.HOME, "base": 4}}]})
        key = next(iter(saved["routines"]))
        self.assertEqual(saved["routines"][key]["name"], "Balayage")
        self.assertEqual(saved["routines"][key]["parameters"], {"base_delta": 2, "repeats": 2})
        self.assertEqual(len(saved["routines"][key]["steps"]), 2)
        self.assertEqual(len(self.call("routines", method="GET")["routines"]), 1)
        self.call("routines", {"action": "delete", "id": key})
        self.assertEqual(self.call("routines", method="GET")["routines"], {})
        class PresetPtz:
            def __init__(self):
                self.calls = []

            def presets(self):
                return [{"token": "wide", "name": "Vue large"}]

            def save_preset(self, name):
                self.calls.append(("save", name))
                return {"token": "wide", "name": name}

            def goto_preset(self, token):
                self.calls.append(("goto", token))

        fake_ptz = PresetPtz()
        self.lab.ptz_factory = lambda *_: fake_ptz
        self.call("settings", {"camera_ip": "192.168.4.20", "camera_user": "viewer",
                               "camera_password": "secret"})
        self.assertEqual(self.call("camera/ptz-preset", {"op": "list"})["presets"][0]["token"], "wide")
        self.assertEqual(self.call("camera/ptz-preset", {"op": "save", "name": "Vue large"})["preset"]["token"], "wide")
        self.assertTrue(self.call("camera/ptz-preset", {"op": "goto", "token": "wide"})["ok"])
        self.assertEqual(fake_ptz.calls, [("save", "Vue large"), ("goto", "wide")])
        self.hardware(camera_required=False)
        self.assertEqual(self.status()["estop"], {"mode": "unmonitored", "healthy": None})

    def test_monitored_estop_gates_hardware_arming_and_keeps_fallbacks(self):
        class Monitor:
            closed = True
            error = None

            def __init__(self, *args):
                self.args = args

            def read(self):
                if self.error:
                    raise arm.DeviceError(self.error)
                return {"closed": self.closed, "healthy": self.closed}

        monitor = Monitor()
        self.lab.estop_factory = lambda *_args: monitor
        self.assertEqual(self.status()["estop"], {"mode": "simulation", "healthy": True})
        self.hardware(camera_required=False)
        self.assertEqual(self.status()["estop"], {"mode": "unmonitored", "healthy": None})
        lease = self.call("arm")["lease"]
        self.call("cancel", {"lease": lease})

        self.now += .3
        self.call("settings", {"estop_required": True})
        cfg = self.lab.config()
        self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        self.now += .3
        self.call("telemetry")
        with self.assertRaisesRegex(robotics.Rejected, "Moniteur"):
            self.call("arm")

        self.now += .3
        self.call("settings", {"estop_ip": "127.0.0.1", "estop_port": 8080,
                                "estop_required": True})
        cfg = self.lab.config()
        self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        self.now += .3
        self.call("telemetry")
        state = self.status()
        self.assertEqual(state["estop"], {"mode": "hardware", "healthy": True})
        self.assertTrue(state["config"]["estop_configured"])
        self.assertNotIn("estop_token", state["config"])
        lease = self.call("arm")["lease"]
        ticket = self.status(lease)["ticket"]
        monitor.closed = False
        self.now += .6
        with self.assertRaisesRegex(robotics.Rejected, "urgence"):
            self.call("move", {"lease": lease, "ticket": ticket, "kind": "home"})
        # Opening a monitored E-stop while armed latches unsafe and requires manual reset.
        self.assertTrue(self.status()["stop_latched"])
        monitor.closed = True
        self.now += .6
        self.call("reset", {"inspected": True})
        self.now += .3
        self.call("telemetry")

        monitor.closed = False
        self.now += 1
        self.assertEqual(self.status()["estop"]["healthy"], False)
        entries = self.call("blackbox", method="GET")["entries"]
        self.assertEqual(entries[0]["estop"], {"mode": "hardware", "healthy": False})
        with self.assertRaisesRegex(robotics.Rejected, "urgence"):
            self.call("arm")

        monitor.closed = True
        monitor.error = "Moniteur E-stop injoignable"
        self.now += 1.1
        self.assertEqual(self.status()["estop"]["healthy"], False)
        entries = self.call("blackbox", method="GET")["entries"]
        self.assertEqual(entries[0]["estop"]["error"], "Moniteur E-stop injoignable")
        self.assertNotIn("estop_token", entries[0]["estop"])

    def test_accepted_move_renews_the_lease_but_idle_arming_lapses(self):
        keys = self.arm_keys()
        self.now += 15
        keys["ticket"] = self.status(keys["lease"])["ticket"]
        self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 2}})
        self.now += 8  # past the original 20 s window
        self.assertTrue(self.status(keys["lease"])["armed"])
        self.now += robotics.LEASE_SECONDS
        self.assertFalse(self.status(keys["lease"])["armed"])

    def test_hardware_is_local_commissioned_and_video_gated(self):
        self.hardware(commissioned=False)
        with self.assertRaisesRegex(robotics.Rejected, "PC HQ"):
            self.call("arm", local=False)
        with self.assertRaisesRegex(robotics.Rejected, "service"):
            self.call("arm")
        self.assertEqual(self.arm.calls, [])
        self.now += robotics.MIN_INTERVAL
        self.hardware(video=False)
        with self.assertRaisesRegex(robotics.Rejected, "vidéo"):
            self.call("arm")
        self.assertEqual(self.arm.calls, [])

    def test_hardware_confirmation_and_uncertain_restart(self):
        self.hardware()
        keys = self.arm_keys()
        pose = {**arm.HOME, "base": 3}
        with self.assertRaisesRegex(robotics.Rejected, "éloignée"):
            self.call("move", {**keys, "kind": "joints", "pose": {**pose, "base": 10}})
        self.now += .6
        keys["ticket"] = self.status(keys["lease"])["ticket"]
        self.assertTrue(self.call("move", {**keys, "kind": "joints", "pose": pose})["moving"])
        self.assertTrue(self.lab.requires_inspection.exists())
        self.assertEqual(self.arm.calls[-1], ("move", pose, 100, 4))
        self.now += .6
        self.arm.actual = pose
        self.assertFalse(self.call("telemetry")["moving"])
        self.assertFalse(self.lab.requires_inspection.exists())
        self.arm.error = "move"
        keys["ticket"] = self.status(keys["lease"])["ticket"]
        with self.assertRaises(arm.DeviceError):
            self.call("move", {**keys, "kind": "home"})
        self.assertTrue(self.status()["uncertain"])
        self.lab = robotics.Robotics(Path(self.temp.name), clock=lambda: self.now,
                                    arm_factory=lambda *_: self.arm, camera=self.cam)
        self.addCleanup(self.lab.close)
        count = len(self.arm.calls)
        self.assertTrue(self.status()["uncertain"])
        self.assertEqual(len(self.arm.calls), count)
        with self.assertRaisesRegex(robotics.Rejected, "Inspection"):
            self.call("arm")
        result = self.call("stop")
        self.assertEqual(result["stop_result"], "torque_release_requested")
        self.assertEqual(self.arm.calls[-1], "stop")

    def test_disconnect_and_cancel_before_send(self):
        self.hardware()
        keys = self.arm_keys()
        self.arm.feedback_gate = lambda: self.call("cancel", {"lease": keys["lease"]})
        with self.assertRaisesRegex(robotics.Rejected, "relâchée"):
            self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 3}})
        self.assertEqual(self.arm.calls, ["feedback"])
        self.arm.feedback_gate = None
        self.now += .6
        keys = self.arm_keys()
        self.arm.error = "feedback"
        with self.assertRaises(arm.DeviceError):
            self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 3}})
        self.assertFalse(self.status(keys["lease"])["armed"])
        self.arm.error = None
        self.now += 3
        self.call("telemetry")
        self.assertFalse(self.status()["armed"])
        self.assertTrue(all(call == "feedback" for call in self.arm.calls))

    def test_camera_is_optional_only_when_disabled(self):
        with self.assertRaises(ValueError):
            self.call("settings", {"camera_required": "no"})
        cfg = self.call("settings", {"mode": "hardware", "arm_ip": "192.168.4.15",
                                     "camera_required": False})["config"]
        self.assertFalse(cfg["camera_required"])
        self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        self.call("telemetry")
        keys = self.arm_keys()
        self.now += .6
        keys["ticket"] = self.status(keys["lease"])["ticket"]
        self.assertTrue(self.status(keys["lease"])["armed"])
        pose = {**arm.HOME, "base": 3}
        self.assertTrue(self.call("move", {**keys, "kind": "joints", "pose": pose})["moving"])

    def test_idle_telemetry_miss_is_tolerated_but_third_disarms(self):
        self.hardware()
        keys = self.arm_keys()
        self.arm.error = "feedback"
        for _ in range(robotics.READ_FAILURES - 1):
            self.now += .6
            with self.assertRaises(arm.DeviceError):
                self.call("telemetry")
            self.assertTrue(self.status(keys["lease"])["armed"])
        self.now += .6
        with self.assertRaises(arm.DeviceError):
            self.call("telemetry")
        self.assertFalse(self.status(keys["lease"])["armed"])

    def test_sub_quarter_degree_move_is_not_sent(self):
        self.hardware()
        keys = self.arm_keys()
        result = self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": .2}})
        self.assertFalse(result["moving"])
        self.assertFalse(any(isinstance(call, tuple) for call in self.arm.calls))
        self.now += .6
        keys["ticket"] = self.status(keys["lease"])["ticket"]
        result = self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": .5}})
        self.assertTrue(result["moving"])
        self.assertTrue(any(isinstance(call, tuple) for call in self.arm.calls))

    def live_fixture(self, steps):
        """Hardware without a camera, plus an approved stored script; returns its version."""
        cfg = self.call("settings", {"mode": "hardware", "arm_ip": "192.168.4.15", "camera_required": False})["config"]
        self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        self.call("telemetry")
        self.arm.calls.clear()
        script = {"profile": robotics.PROFILE, "revision": cfg["revision"], "title": "t", "request": "r",
                  "conversation": [], "start": arm.HOME.copy(), "steps": steps, "speed": 100,
                  "draft_model": assistant.DRAFT_MODELS[0], "review": None, "approval": None, "saved": False,
                  "label": "", "summary": "", "saved_at": None, "last_played_at": None, "play_count": 0}
        script["digest"] = assistant.script_digest(script)
        script["review"] = {"digest": script["digest"], "model": assistant.REVIEW_MODELS[0],
                            "verdict": "pass", "notes": "ok", "at": 0}
        script["approval"] = {"digest": script["digest"], "at": 0}
        self.lab.write(assistant.store_path(self.lab, "owner"), {"messages": [], "scripts": {"k": script}})
        return {"id": "k", "digest": script["digest"]}

    def live_move(self, keys, version, index=0):
        return self.lab.dispatch("move", "POST", {**keys, **version, "kind": "reviewed_script", "index": index},
                                 "a", local=True, physical=True, authorized=lambda: True, owner="owner")

    def confirm_live(self, keys, version, fluid=False):
        return assistant.dispatch(self.lab, "live", "POST", {**version, "lease": keys["lease"], "confirmed": True,
                                                             "fluid": fluid}, "owner", lambda: True)

    def test_live_script_needs_confirmation_then_moves_in_measured_substeps(self):
        version = self.live_fixture([{**arm.HOME, "base": 20}])
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, "vrai bras"):
            self.live_move(keys, version)
        self.assertEqual(self.arm.calls, [])
        with self.assertRaises(robotics.Rejected):
            assistant.dispatch(self.lab, "live", "POST", {**version, "lease": "wrong", "confirmed": True},
                               "owner", lambda: True)
        with self.assertRaises(robotics.Rejected):
            assistant.dispatch(self.lab, "live", "POST", {**version, "lease": keys["lease"]}, "owner", lambda: True)
        self.confirm_live(keys, version)
        limit = self.lab.config()["step_limit"] - .5
        sent = []
        for _ in range(10):
            status = self.live_move(keys, version)
            pose = [call for call in self.arm.calls if isinstance(call, tuple)][-1][1]
            sent.append(pose["base"])
            self.arm.actual = {key: pose[key] for key in arm.JOINTS}
            self.now += .6
            self.call("telemetry")
            keys["ticket"] = self.status(keys["lease"])["ticket"]
            if status["script"]["gap"] <= .25:
                break
        self.assertLessEqual(status["script"]["gap"], .25)
        self.assertAlmostEqual(sent[0], limit, places=3)
        self.assertTrue(all(b - a <= limit + 1e-6 for a, b in zip([0, *sent], sent)))
        self.assertAlmostEqual(self.arm.actual["base"], 20, places=3)
        stored = assistant.load(assistant.store_path(self.lab, "owner"))["scripts"]["k"]
        self.assertEqual(stored["play_count"], 1)

    def test_fluid_live_script_sends_the_whole_step_when_its_path_passes(self):
        version = self.live_fixture([{**arm.HOME, "base": 20}])
        self.arm.follow = True
        keys = self.arm_keys()
        self.confirm_live(keys, version, fluid=True)
        status = self.live_move(keys, version)
        sent = [call for call in self.arm.calls if isinstance(call, tuple)][-1][1]
        self.assertAlmostEqual(sent["base"], 20, places=3)  # ends on the approved step, not on a 4.5 deg sub-step
        self.assertGreater(len([c for c in self.arm.calls if isinstance(c, tuple)]), 3)  # streamed along a curve
        self.assertEqual(status["script"]["gap"], 0)
        self.assertEqual(assistant.load(assistant.store_path(self.lab, "owner"))["scripts"]["k"]["play_count"], 1)
        self.assertGreaterEqual(self.lab.lease.expires - self.now, robotics.LEASE_SECONDS - 1)

    def test_fluid_live_script_falls_back_to_substeps_when_the_whole_path_fails(self):
        version = self.live_fixture([{**arm.HOME, "base": 70}])
        keys = self.arm_keys()
        self.confirm_live(keys, version, fluid=True)
        status = self.live_move(keys, version)
        sent = [call for call in self.arm.calls if isinstance(call, tuple)][-1][1]
        self.assertAlmostEqual(sent["base"], self.lab.config()["step_limit"] - .5, places=3)
        self.assertGreater(status["script"]["gap"], 1)

    def test_live_script_refuses_a_pose_off_the_approved_path_and_clears_on_disarm(self):
        version = self.live_fixture([{**arm.HOME, "base": 20}])
        keys = self.arm_keys()
        self.confirm_live(keys, version)
        self.arm.actual = {**arm.HOME, "base": 40}
        self.now += .6
        self.call("telemetry")
        with self.assertRaisesRegex(robotics.Rejected, "trajectoire"):
            self.live_move(keys, version)
        self.assertFalse(any(isinstance(call, tuple) for call in self.arm.calls))
        self.arm.actual = arm.HOME.copy()
        self.now += .6
        self.call("telemetry")
        self.call("cancel", {"lease": keys["lease"]})
        self.assertIsNone(self.lab.live_script)
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, "vrai bras"):
            self.live_move(keys, version)

    def test_live_confirmation_is_refused_in_simulation(self):
        keys = self.arm_keys()
        with self.assertRaises(robotics.Rejected):
            assistant.dispatch(self.lab, "live", "POST", {"id": "k", "digest": "x", "lease": keys["lease"],
                                                         "confirmed": True}, "owner", lambda: True)

    def test_home_near_the_workspace_edge_uses_a_shrunk_step_instead_of_failing(self):
        self.hardware()
        self.arm.actual = {"base": 76.7, "shoulder": -11.4, "elbow": 100.4, "hand": 180.0}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        status = self.call("move", {**keys, "kind": "home"})
        self.assertTrue(status["moving"])
        self.assertEqual(status["script"]["index"], "home")
        sent = [call for call in self.arm.calls if isinstance(call, tuple)][-1][1]
        step = max(abs(sent[k] - self.arm.actual[k]) for k in arm.JOINTS)
        self.assertLessEqual(step, self.lab.config()["step_limit"] - .5)
        self.assertGreater(step, robotics.NOOP_DEGREES)
        self.assertGreater(status["script"]["gap"], 1)

    def test_direct_home_is_one_confirmed_slow_move_that_skips_only_the_step_checks(self):
        self.hardware(camera_required=False)
        self.arm.follow = True
        self.arm.actual = {"base": 76.7, "shoulder": -11.4, "elbow": 100.4, "hand": 180.0}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, "Confirmez"):
            self.call("move", {**keys, "kind": "home_direct"})
        self.assertFalse(any(isinstance(call, tuple) for call in self.arm.calls))
        status = self.call("move", {**keys, "kind": "home_direct", "confirmed": True})
        moves = [call for call in self.arm.calls if isinstance(call, tuple)]
        self.assertEqual(moves[-1][1], arm.HOME)  # the stream ends exactly on neutral
        self.assertGreater(len(moves), 20)  # goals along a curve, not one jump
        bases = [m[1]["base"] for m in moves]
        self.assertTrue(all(a >= b for a, b in zip(bases, bases[1:])))
        speeds = [m[2] for m in moves]
        self.assertLessEqual(max(speeds), self.lab.config()["speed"] * robotics.STREAM_SPD_GAIN + 1)  # never above the cap
        self.assertTrue(all(robotics.STREAM_SPD_FLOOR <= m[2] <= 400 for m in moves))  # never below the stutter floor
        self.assertGreaterEqual(self.lab.lease.expires - self.now, robotics.LEASE_SECONDS - 1)
        # A stepped move far from the arm still obeys the step limit.
        self.arm.actual = arm.HOME.copy()
        self.now += 20
        self.call("telemetry")
        self.assertFalse(self.status()["moving"])

    def test_a_servo_that_rests_a_little_short_still_counts_as_arrived(self):
        self.hardware()
        keys = self.arm_keys()
        pose = {**arm.HOME, "elbow": 93}
        self.assertTrue(self.call("move", {**keys, "kind": "joints", "pose": pose})["moving"])
        self.arm.actual = {**arm.HOME, "elbow": 91.7}  # 1.3 deg short, like the real elbow
        self.now += .6
        status = self.call("telemetry")
        self.assertFalse(status["moving"])
        self.assertFalse(status["uncertain"])
        self.assertFalse(self.lab.requires_inspection.exists())

    def test_stepped_home_sends_the_next_substep_before_the_arm_has_fully_stopped(self):
        self.hardware()
        self.arm.actual = {**arm.HOME, "base": 40}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "home"})
        sent = [c for c in self.arm.calls if isinstance(c, tuple)][-1][1]
        self.arm.actual = {**arm.HOME, "base": sent["base"] + 3}  # 3 deg short: inside the blend window
        self.now += .6
        status = self.call("telemetry", {"lease": keys["lease"]})
        self.assertTrue(status["moving"])
        self.assertTrue(status["blend"])
        keys["ticket"] = status["ticket"]
        self.assertTrue(keys["ticket"])
        second = self.call("move", {**keys, "kind": "home"})
        self.assertTrue(second["moving"])
        again = [c for c in self.arm.calls if isinstance(c, tuple)][-1][1]
        self.assertNotEqual(again["base"], sent["base"])
        # Only stepped approaches may overlap; a different move kind is refused while one is under way.
        self.now += .6
        self.arm.actual = {**arm.HOME, "base": again["base"] + 3}
        status = self.call("telemetry", {"lease": keys["lease"]})
        keys["ticket"] = status["ticket"]
        with self.assertRaisesRegex(robotics.Rejected, "en cours"):
            self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 20}})

    def test_a_streamed_move_stops_sending_when_the_arming_is_released(self):
        self.hardware(camera_required=False)
        self.arm.follow = True
        self.arm.actual = {**arm.HOME, "base": 40}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        ticks = []

        def sleep(seconds):
            self.now += seconds
            ticks.append(1)
            if len(ticks) == 4:
                self.call("cancel", {"lease": keys["lease"]})

        self.lab.stream_sleep = sleep
        self.call("move", {**keys, "kind": "home_direct", "confirmed": True})
        moves = [call for call in self.arm.calls if isinstance(call, tuple)]
        self.assertLessEqual(len(moves), 4)  # nothing is sent after the release
        self.assertNotEqual(moves[-1][1], arm.HOME)
        self.assertIsNone(self.lab.lease)

    def test_direct_home_never_overlaps_a_second_move(self):
        self.hardware(camera_required=False)
        self.arm.actual = {**arm.HOME, "base": 12}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "home_direct", "confirmed": True})
        self.arm.actual = {**arm.HOME, "base": 3}
        self.now += .6
        status = self.call("telemetry")
        self.assertTrue(status["moving"])
        self.assertFalse(status["blend"])

    def test_camera_pan_tilt_route_is_local_validated_and_never_blocks_the_controller(self):
        pulses = []

        class FakePtz:
            def __init__(self, address, user, password, timeout):
                self.args = (address, user, password)

            def pulse(self, direction, seconds):
                pulses.append((self.args[0], direction, seconds))
                if direction == "up":
                    raise arm.DeviceError("Caméra injoignable")

            def stop(self):
                pulses.append((self.args[0], "stop", 0))

        self.lab.ptz_factory = FakePtz
        with self.assertRaisesRegex(robotics.Rejected, "réglages"):
            self.call("camera/ptz", {"direction": "left"})  # no camera account yet
        self.call("settings", {"camera_ip": "192.168.2.187", "camera_user": "u", "camera_password": "p"})
        with self.assertRaises(robotics.Rejected):
            self.call("camera/ptz", {"direction": "left"}, local=False)
        with self.assertRaises(ValueError):
            self.call("camera/ptz", {"direction": "diagonal"})
        with self.assertRaises(ValueError):
            self.call("camera/ptz", {"direction": "left", "ms": 5000})
        self.assertEqual(self.call("camera/ptz", {"direction": "left", "ms": 300}), {"ok": True})
        self.assertEqual(pulses[-1], ("192.168.2.187", "left", .3))
        self.call("camera/ptz", {"direction": "stop"})
        self.assertEqual(pulses[-1][1], "stop")
        with self.assertRaisesRegex(robotics.Rejected, "injoignable"):
            self.now += 1
            self.call("camera/ptz", {"direction": "up"})
        # The lock is free during a pulse, so STOP and status are not delayed by the camera.
        self.assertFalse(self.lab.ptz_lock.locked())
        self.assertTrue(self.status()["ok"])

    def test_a_refused_tapo_login_pauses_further_tries_instead_of_hammering_the_camera(self):
        attempts = []

        class Refusing:
            def __init__(self, address, user, password, timeout):
                self.address, self.user, self.password = address, user, password

            def night_mode(self, mode=None):
                attempts.append(1)
                raise arm.DeviceError("Compte caméra refusé")

        self.lab.tapo_factory = Refusing
        self.call("settings", {"camera_ip": "192.168.2.187", "camera_cloud_password": "wrong"})
        with self.assertRaisesRegex(robotics.Rejected, "refusé"):
            self.call("camera/night", {"mode": "read"})
        self.assertEqual(len(attempts), 1)  # no second login attempt in the same request
        self.now += 5
        with self.assertRaisesRegex(robotics.Rejected, "attendez"):
            self.call("camera/night", {"mode": "read"})
        self.assertEqual(len(attempts), 1)  # and none while paused
        self.now += 100
        with self.assertRaisesRegex(robotics.Rejected, "refusé"):
            self.call("camera/night", {"mode": "read"})
        self.assertEqual(len(attempts), 2)

    def test_camera_night_route_needs_the_cloud_password_and_stays_local(self):
        calls = []

        class FakeTapo:
            def __init__(self, address, user, password, timeout):
                self.address, self.user, self.password = address, user, password
                self.mode = "auto"

            def night_mode(self, mode=None):
                calls.append((self.user, mode))
                if mode == "explode":
                    raise arm.DeviceError("Mode nuit refusé par la caméra")
                self.mode = mode or self.mode
                return self.mode

        self.lab.tapo_factory = FakeTapo
        with self.assertRaisesRegex(robotics.Rejected, "cloud"):
            self.call("camera/night", {"mode": "read"})
        result = self.call("settings", {"camera_ip": "192.168.2.187", "camera_cloud_password": "TESTCLOUD"})
        self.assertNotIn("TESTCLOUD", json.dumps(result))  # never returned
        self.assertTrue(result["config"]["camera_cloud_configured"])
        with self.assertRaises(robotics.Rejected):
            self.call("camera/night", {"mode": "on"}, local=False)
        with self.assertRaises(ValueError):
            self.call("camera/night", {"mode": "disco"})
        self.assertEqual(self.call("camera/night", {"mode": "read"}), {"ok": True, "mode": "auto"})
        self.now += 1
        self.assertEqual(self.call("camera/night", {"mode": "on"})["mode"], "on")
        self.assertEqual(calls[-1], ("admin", "on"))  # the settings API takes the cloud account, not the camera account

    def test_camera_session_expiry_and_credentials(self):
        result = self.call("settings", {"camera_ip": "192.168.4.5", "camera_user": "TESTUSER",
                                        "camera_password": "TESTPASSWORD"})
        self.assertNotIn("TEST", json.dumps(result))
        with patch.object(robotics, "executable", return_value="fake-go2rtc"):
            key = self.call("camera/start")["stream"]
        with self.assertRaises(robotics.Rejected):
            self.lab.open_video("b", key, True)
        cfg, stream = self.lab.open_video("a", key, True)
        self.assertEqual(cfg["camera_password"], "TESTPASSWORD")
        self.lab.video_bytes(stream)
        self.call("camera/frame", {"stream": key})
        self.assertTrue(self.status()["camera_live"])
        self.now += 3
        self.assertFalse(self.status()["camera_live"])
        self.lab.close_video(stream, True)
        self.assertIn("interrompu", self.status()["camera_error"])

    def test_config_failures_and_ssrf(self):
        for host in ("http://192.168.0.5", "127.0.0.1", "8.8.8.8", "100.101.1.1", "192.168.4.15:80"):
            with self.subTest(host=host), self.assertRaises(ValueError):
                self.call("settings", {"arm_ip": host})
        with patch.object(arm.socket, "getaddrinfo", return_value=[(None, None, None, "", ("192.168.2.4", 0))]):
            self.assertEqual(self.call("settings", {"arm_ip": "roarm.local"})["config"]["arm_ip"], "192.168.2.4")
        self.lab.config_path.write_bytes(b"{")
        with self.assertRaises(robotics.Rejected):
            self.call("settings", {"mode": "simulation"})
        self.assertEqual(self.lab.config_path.read_bytes(), b"{")

    def test_geometry_ik_and_workspace(self):
        pose = {**arm.HOME, "base": -12, "shoulder": 3, "elbow": 81}
        solved = arm.cartesian(arm.position(pose), arm.LIMITS, arm.WORKSPACE)
        for key in arm.JOINTS:
            self.assertAlmostEqual(solved[key], pose[key])
        with self.assertRaises(ValueError):
            arm.cartesian({"x": 499, "y": 300, "z": 489, "t": 180}, arm.LIMITS, arm.WORKSPACE)
        with self.assertRaises(ValueError):
            arm.validate_path(arm.HOME, {**arm.HOME, "shoulder": 55}, arm.LIMITS, arm.WORKSPACE)


class SafetyRegression(unittest.TestCase):
    """Deterministic fake-hardware regression tests for R-01 through R-06."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="hq-robotics-safety-")
        self.addCleanup(self.temp.cleanup)
        self.now = 100.0
        self.arm = FakeArm()
        self.cam = FakeCamera()
        self.estop_closed = True
        self.estop_error = None
        self.estop_reads = 0

        class Monitor:
            def __init__(self, outer):
                self.outer = outer

            def read(self):
                self.outer.estop_reads += 1
                if self.outer.estop_error:
                    raise arm.DeviceError(self.outer.estop_error)
                return {"closed": self.outer.estop_closed, "healthy": self.outer.estop_closed}

        self.lab = robotics.Robotics(
            Path(self.temp.name),
            clock=lambda: self.now,
            arm_factory=lambda *_: self.arm,
            camera=self.cam,
            estop_factory=lambda *_: Monitor(self),
        )
        self.addCleanup(self.lab.close)
        self.lab.stream_threaded = False
        self.lab.stream_sleep = lambda seconds: setattr(self, "now", self.now + max(0.0, seconds))

    def call(self, action, data=None, *, method="POST", session="a"):
        return self.lab.dispatch(action, method, data or {}, session,
                                 local=True, physical=True, authorized=lambda: True)

    def setup_hardware(self, *, estop=False, torque_required=True, speed=100):
        payload = {
            "mode": "hardware",
            "arm_ip": "192.168.4.15",
            "camera_required": False,
            "torque_telemetry_required": torque_required,
            "speed": speed,
        }
        if estop:
            payload.update({"estop_ip": "127.0.0.1", "estop_port": 8080, "estop_required": True})
        cfg = self.call("settings", payload)["config"]
        self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        self.call("telemetry")
        self.arm.calls.clear()
        return cfg

    def arm_keys(self):
        lease = self.call("arm")["lease"]
        return {"lease": lease, "ticket": self.call("status", {"lease": lease}, method="GET")["ticket"]}

    def test_r01_estop_open_mid_stream_latches_unsafe_and_halts_dispatch(self):
        self.setup_hardware(estop=True)
        self.arm.follow = True
        self.arm.actual = {**arm.HOME, "base": 15.0}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        post_open_moves = []
        orig_move = self.arm.move

        def logged_move(pose, speed, acc):
            orig_move(pose, speed, acc)
            if not self.estop_closed:
                post_open_moves.append(pose)

        self.arm.move = logged_move

        def step(seconds):
            self.now += max(.1, seconds)
            if self.now >= self.start_time + .3:
                self.estop_closed = False

        self.start_time = self.now
        self.lab.stream_sleep = step
        cfg = self.lab.config()
        completed = self.lab.stream(cfg, "a", keys["lease"], self.arm.actual, arm.HOME, 1.0, 60)
        self.assertFalse(completed)
        self.assertEqual(post_open_moves, [])
        self.assertGreater(self.estop_reads, 1)
        status = self.call("status", method="GET")
        self.assertTrue(status["stop_latched"])
        self.assertTrue(status["uncertain"])
        self.assertFalse(status["armed"])
        self.assertEqual(status["stop_state"], "unconfirmed")
        with self.assertRaisesRegex(robotics.Rejected, "Inspection"):
            self.call("arm")

    def test_r01_estop_supervisor_latches_without_ui_polling(self):
        self.setup_hardware(estop=True)
        with patch.object(robotics, "ESTOP_SUPERVISOR_INTERVAL", 0.02):
            self.call("arm")
            self.estop_closed = False
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline and not self.lab.stop_latched:
                time.sleep(0.01)
            self.assertTrue(self.lab.stop_latched)
            self.assertIsNone(self.lab.lease)
            with self.assertRaisesRegex(robotics.Rejected, "Inspection"):
                self.call("arm")

    def test_r02_cancel_during_hardware_motion_marks_unconfirmed_without_torque_release(self):
        self.setup_hardware()
        self.arm.follow = True
        self.arm.actual = {**arm.HOME, "base": 20.0}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        ticks = []

        def step(seconds):
            self.now += seconds
            ticks.append(1)
            if len(ticks) == 3:
                self.call("cancel", {"lease": keys["lease"]})

        self.lab.stream_sleep = step
        status = self.call("move", {**keys, "kind": "home_direct", "confirmed": True})
        self.assertNotIn("stop", self.arm.calls)
        self.assertTrue(status["uncertain"])
        self.assertFalse(status["moving"])
        self.assertFalse(status["armed"])
        self.assertEqual(status["stop_state"], "unconfirmed")
        with self.assertRaisesRegex(robotics.Rejected, "Inspection"):
            self.call("arm")

    def test_r02_failed_emergency_stop_still_latches_unsafe(self):
        self.setup_hardware()
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 3.0}})

        def fail_stop():
            raise arm.DeviceError("stop tx failed")

        self.arm.emergency_stop = fail_stop
        with self.assertRaises(arm.DeviceError):
            self.call("stop")
        status = self.call("status", method="GET")
        self.assertTrue(status["stop_latched"])
        self.assertTrue(status["uncertain"])
        self.assertFalse(self.lab.stop_pending)
        self.assertEqual(status["stop_state"], "unconfirmed")

    def test_r03_epoch_fencing_blocks_blocked_io_stream_after_cancel_or_stop(self):
        cfg = self.setup_hardware()
        self.arm.actual = {**arm.HOME, "base": 10.0}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        epoch = self.lab.epoch
        entered_wait = threading.Event()
        self.lab.stream_sleep = lambda _s: entered_wait.set()
        self.lab.io.acquire()
        self.lab.motion = self.now + 10
        worker = threading.Thread(
            target=self.lab.stream,
            args=(cfg, "a", keys["lease"], self.arm.actual, arm.HOME, 0.2, 60),
            kwargs={"epoch": epoch},
        )
        worker.start()
        self.assertTrue(entered_wait.wait(2.0))
        self.call("cancel", {"lease": keys["lease"]})
        self.lab.io.release()
        worker.join(timeout=2.0)
        self.assertFalse(worker.is_alive())
        moves = [c for c in self.arm.calls if isinstance(c, tuple)]
        self.assertEqual(moves, [])

    def test_r04_direct_home_rejects_workspace_ceiling_counterexample(self):
        self.setup_hardware()
        # Valid pose (z=489.64 <= 490), but straight joint path to HOME exceeds z=490 (~492.17).
        self.arm.actual = {"base": -8.12, "shoulder": 21.28, "elbow": -23.94, "hand": 134.43}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        with self.assertRaises(ValueError):
            self.call("move", {**keys, "kind": "home_direct", "confirmed": True})
        moves = [c for c in self.arm.calls if isinstance(c, tuple)]
        self.assertEqual(moves, [])

    def test_r05_stream_speed_never_exceeds_configured_ceiling(self):
        cfg = self.setup_hardware(speed=100)
        self.arm.follow = True
        self.arm.actual = {**arm.HOME, "base": 35.0}
        self.now += .6
        self.call("telemetry")
        _seconds, planned_speed = self.lab.stream_plan(cfg, self.arm.actual, arm.HOME, 100)
        self.assertLessEqual(planned_speed, 100)
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "home_direct", "confirmed": True})
        speeds = [c[2] for c in self.arm.calls if isinstance(c, tuple)]
        self.assertTrue(speeds)
        self.assertLessEqual(max(speeds), 100)

    def test_r06_missing_or_partial_torque_telemetry_handled_truthfully(self):
        self.setup_hardware(torque_required=True)
        self.arm.torque = {}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, r"[Cc]ouple"):
            self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 2.0}})
        self.call("cancel", {"lease": keys["lease"]})
        self.call("reset", {"inspected": True})

        self.now += .6
        self.arm.torque = {"base": 1}
        self.call("telemetry")
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, r"[Cc]ouple"):
            self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 2.0}})
        self.call("cancel", {"lease": keys["lease"]})
        self.call("reset", {"inspected": True})

        # Commissioned explicit unknown-torque mode allows {} and reports torque_state="unknown",
        # while still rejecting partial or disabled switches.
        self.now += .6
        self.setup_hardware(torque_required=False)
        self.arm.torque = {}
        self.now += .6
        status = self.call("telemetry")
        self.assertEqual(status["torque_state"], "unknown")
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 2.0}})
        self.call("cancel", {"lease": keys["lease"]})
        self.call("reset", {"inspected": True})

        self.now += .6
        self.arm.torque = {"base": 1, "shoulder": 1, "elbow": 1, "hand": 0}
        self.call("telemetry")
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, r"[Cc]ouple"):
            self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 3.0}})

    def test_r07_signed_estop_challenge_rejects_replay_and_bad_hmac(self):
        import hmac as _hmac
        import hashlib as _hashlib

        class SignedHandler(BaseHTTPRequestHandler):
            seq = 1
            mode = "ok"

            def log_message(self, *_):
                pass

            def do_GET(self):
                nonce = self.headers.get("X-HQ-Estop-Nonce", "")
                if self.mode == "replay":
                    seq = 1
                else:
                    SignedHandler.seq += 1
                    seq = SignedHandler.seq
                closed = True
                sig = _hmac.new(
                    b"top-secret",
                    f"{nonce}:{seq}:{int(closed)}".encode(),
                    _hashlib.sha256,
                ).hexdigest()
                if self.mode == "bad_hmac":
                    sig = "0" * 64
                elif self.mode == "unsigned":
                    body = json.dumps({"closed": True}).encode()
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(body)
                    return
                body = json.dumps({"closed": closed, "nonce": nonce, "seq": seq, "hmac": sig}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

        with serve(SignedHandler) as port:
            client = estop.HttpEstop("127.0.0.1", port, "top-secret", 1.0, require_signed=True)
            reading = client.read()
            self.assertTrue(reading["healthy"])
            self.assertTrue(reading["signed"])

            SignedHandler.mode = "replay"
            with self.assertRaisesRegex(arm.DeviceError, "rejouée"):
                client.read()

            SignedHandler.mode = "bad_hmac"
            with self.assertRaisesRegex(arm.DeviceError, "Signature"):
                client.read()

            SignedHandler.mode = "unsigned"
            with self.assertRaisesRegex(arm.DeviceError, "rejouée"):
                client.read()

    def test_r08_onvif_continuous_move_includes_device_timeout(self):
        seen = []

        class PtzHandler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length).decode()
                seen.append(body)
                if "GetSystemDateAndTime" in body:
                    inner = "<GetSystemDateAndTimeResponse><SystemDateAndTime><UTCDateTime><Time><Hour>0</Hour><Minute>0</Minute><Second>0</Second></Time><Date><Year>2026</Year><Month>11</Month><Day>16</Day></Date></UTCDateTime></SystemDateAndTime></GetSystemDateAndTimeResponse>"
                elif "GetCapabilities" in body:
                    inner = "<GetCapabilitiesResponse><Capabilities/></GetCapabilitiesResponse>"
                elif "GetProfiles" in body:
                    inner = '<GetProfilesResponse><Profiles token="p1"/></GetProfilesResponse>'
                elif "ContinuousMove" in body:
                    inner = "<ContinuousMoveResponse/>"
                else:
                    inner = "<StopResponse/>"
                xml = f'<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>{inner}</s:Body></s:Envelope>'.encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(xml)

        with serve(PtzHandler) as port:
            ptz_client = ptz.Ptz("127.0.0.1", "viewer", "secret", 2.0, port=port)
            ptz_client.pulse("left", 0.2)
            move_xml = next(b for b in seen if "ContinuousMove" in b)
            self.assertIn("<Timeout>PT", move_xml)
            self.assertTrue(any("<Stop " in b for b in seen))

    def test_r09_tapo_tls_sha256_pinning_validates_format_and_rejects_mismatch(self):
        with self.assertRaises(ValueError):
            tapo.Tapo("192.168.4.15", "admin", "pw", 1.0, tls_sha256="not-hex")

        class FakeSock:
            def getpeercert(self, binary_form=False):
                return b"wrong-cert-bytes" if binary_form else {}

        class FakeConn:
            sock = FakeSock()

            def connect(self):
                pass

            def request(self, *_):
                pass

            def close(self):
                pass

        client = tapo.Tapo("192.168.4.15", "admin", "pw", 1.0, tls_sha256="a" * 64)
        with patch.object(tapo.http.client, "HTTPSConnection", return_value=FakeConn()):
            with self.assertRaisesRegex(arm.DeviceError, "Certificat"):
                client._http_bytes("/test", b"{}", {})

    def test_r11_incident_persists_redacted_blackbox_across_restart(self):
        self.setup_hardware(estop=True)
        self.call("arm")
        self.estop_closed = False
        self.lab.trip_estop(self.lab.config())
        self.assertTrue(self.lab.blackbox_path.exists())
        raw = self.lab.blackbox_path.read_text(encoding="utf-8")
        self.assertNotIn("estop_token", raw)
        # A newly constructed Robotics instance on the same state root reloads the incident.
        restarted = robotics.Robotics(Path(self.temp.name))
        self.addCleanup(restarted.close)
        self.assertTrue(any(entry.get("incident") == "estop" for entry in restarted.blackbox))

    def test_r12_review_policy_version_blocks_stale_or_unrecognized_models(self):
        import hq_robotics_assistant as assistant

        script = {
            "digest": "abc",
            "draft_model": assistant.DRAFT_MODELS[0],
            "review": {
                "digest": "abc",
                "model": assistant.REVIEW_MODELS[0],
                "verdict": "pass",
                "notes": "ok",
                "policy_version": assistant.REVIEW_POLICY_VERSION,
            },
        }
        self.assertEqual(assistant.review_policy_state(script), "current")
        self.assertTrue(assistant.model_approved(script))

        script["review"]["policy_version"] = 999
        self.assertEqual(assistant.review_policy_state(script), "stale_policy")
        self.assertFalse(assistant.model_approved(script))

        script["review"] = {
            "digest": "abc",
            "model": "unknown-legacy-model",
            "verdict": "pass",
            "notes": "ok",
        }
        self.assertEqual(assistant.review_policy_state(script), "stale_policy")
        self.assertFalse(assistant.model_approved(script))

    def test_phase2_3d_link_positions_and_swept_capsule_clearance(self):
        links = arm.link_positions(arm.HOME)
        self.assertEqual(links["shoulder"], {"x": 0.0, "y": 0.0, "z": 0.0})
        tcp = arm.position(arm.HOME)
        for axis in ("x", "y", "z"):
            self.assertAlmostEqual(links["tcp"][axis], tcp[axis], places=6)

        # Place a keep-out box directly over the elbow/forearm midpoint (TCP stays outside).
        mid_x = (links["elbow"]["x"] + links["tcp"]["x"]) / 2
        mid_z = (links["elbow"]["z"] + links["tcp"]["z"]) / 2
        zone = {
            "name": "Capteur",
            "x": [mid_x - 10, mid_x + 10],
            "y": [-20, 20],
            "z": [mid_z - 10, mid_z + 10],
        }
        clearance = arm.swept_clearance(arm.HOME, {**arm.HOME, "base": 2.0}, [zone])
        self.assertEqual(clearance["collision_zone"], "Capteur")
        self.assertLessEqual(clearance["min_clearance_mm"], 0.0)

        preview = self.call("preview", {"kind": "joints", "pose": {**arm.HOME, "base": 2.0}})
        self.assertIn("links", preview)
        self.assertIn("clearance", preview)

    def test_phase2_shadow_diagnostics_tracks_error_and_latency_percentiles(self):
        self.setup_hardware()
        self.arm.actual = {**arm.HOME, "base": 4.5}
        self.now += .6
        self.call("telemetry")
        self.lab.target = arm.HOME.copy()
        self.arm.error = "feedback"
        self.now += .6
        with self.assertRaises(arm.DeviceError):
            self.call("telemetry")
        self.arm.error = None
        self.now += .6
        status = self.call("telemetry")
        shadow = status["shadow"]
        self.assertAlmostEqual(shadow["tracking_error_deg"]["base"], 4.5)
        self.assertAlmostEqual(shadow["max_error_deg"], 4.5)
        self.assertEqual(shadow["telemetry_misses"], 1)
        self.assertGreaterEqual(shadow["latency_samples"], 2)
        self.assertIsNotNone(shadow["latency_p50_ms"])
        self.assertIsNotNone(shadow["latency_p95_ms"])

    def test_phase2_teach_and_repeat_preflight_resamples_and_checks_clearance(self):
        saved = self.call("recordings", {
            "action": "save",
            "name": "Balayage",
            "start": arm.HOME.copy(),
            "steps": [{**arm.HOME, "base": 12.0}],
        })
        rec_id = next(iter(saved["recordings"]))
        preflight = self.call("recordings", {
            "action": "preflight",
            "id": rec_id,
            "max_step_deg": 4.0,
        })
        self.assertTrue(preflight["ok"])
        self.assertEqual(preflight["step_count"], 3)
        self.assertGreater(preflight["estimated_seconds"], 0)
        self.assertEqual(preflight["steps"][-1]["base"], 12.0)

    def test_phase2_kinetia_plan_safety_report_deterministic(self):
        cfg = self.lab.config()
        script = {
            "start": arm.HOME.copy(),
            "speed": 80,
            "steps": [{**arm.HOME, "base": 6.0}, {**arm.HOME, "base": 12.0}],
        }
        report = assistant.plan_safety_report(cfg, script)
        self.assertEqual(report["step_count"], 2)
        self.assertAlmostEqual(report["max_joint_delta_deg"], 6.0)
        self.assertGreater(report["estimated_seconds"], 0.0)

    def test_estop_supervisor_unexpected_exception_latches_unsafe(self):
        self.setup_hardware(estop=True)
        with patch.object(robotics, "ESTOP_SUPERVISOR_INTERVAL", 0.02):
            self.call("arm")
            with patch.object(self.lab, "estop_health", side_effect=RuntimeError("unexpected")):
                deadline = time.monotonic() + 1.0
                while time.monotonic() < deadline and not self.lab.stop_latched:
                    time.sleep(0.01)
            self.assertTrue(self.lab.stop_latched)
            self.assertIsNone(self.lab.lease)

    def test_close_during_active_motion_invalidates_epoch(self):
        self.setup_hardware()
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 2.0}})
        epoch_before = self.lab.epoch
        self.lab.close()
        self.assertGreater(self.lab.epoch, epoch_before)
        self.assertTrue(self.lab.stop_latched)
        self.assertTrue(self.lab.uncertain)
        self.assertIsNone(self.lab.lease)

    def test_shutdown_persists_unconfirmed_inspection(self):
        self.setup_hardware()
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 2.0}})
        self.lab.close()
        self.assertTrue(self.lab.requires_inspection.exists())
        restarted = robotics.Robotics(Path(self.temp.name))
        self.addCleanup(restarted.close)
        self.assertTrue(restarted.requires_inspection.exists())
        self.assertTrue(any(e.get("incident") == "shutdown" for e in restarted.blackbox))

    def test_cancel_between_final_epoch_check_and_arm_send(self):
        cfg = self.setup_hardware()
        keys = self.arm_keys()
        epoch = self.lab.epoch
        self.lab.io.acquire()
        try:
            self.call("cancel", {"lease": keys["lease"]})
            sent = self.lab._dispatch_arm_move(cfg, "a", keys["lease"], epoch, arm.HOME, 60, 4)
            self.assertFalse(sent)
            self.assertEqual([c for c in self.arm.calls if isinstance(c, tuple)], [])
        finally:
            self.lab.io.release()

    def test_stop_between_stream_estop_read_and_arm_send(self):
        self.setup_hardware(estop=True)
        cfg = self.lab.config()
        self.arm.actual = {**arm.HOME, "base": 10.0}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        epoch = self.lab.epoch
        paused = threading.Event()
        resumed = threading.Event()
        orig_health = self.lab.estop_health

        def hook(c, *, force=False):
            res = orig_health(c, force=force)
            if threading.current_thread().name == "stream-toctou":
                paused.set()
                resumed.wait(2.0)
            return res

        self.lab.estop_health = hook
        worker = threading.Thread(
            target=self.lab.stream,
            args=(cfg, "a", keys["lease"], self.arm.actual, arm.HOME, 0.2, 60),
            kwargs={"epoch": epoch},
            name="stream-toctou",
        )
        worker.start()
        self.assertTrue(paused.wait(2.0))
        self.call("stop")
        resumed.set()
        worker.join(timeout=2.0)
        self.assertEqual([c for c in self.arm.calls if isinstance(c, tuple)], [])

    def test_cancel_after_feedback_arrival_but_before_physical_settling(self):
        self.setup_hardware()
        keys = self.arm_keys()
        self.call("move", {**keys, "kind": "joints", "pose": {**arm.HOME, "base": 2.0}})
        self.lab.motion = None  # Simulate motion cleared, physical_command_sent still True
        status = self.call("cancel", {"lease": keys["lease"]})
        self.assertTrue(status["uncertain"])
        self.assertEqual(status["stop_state"], "unconfirmed")

    def test_direct_home_rejects_async_axis_workspace_counterexample(self):
        self.setup_hardware()
        # Finding C: valid pose (z=70.27mm), coordinated path valid, but asynchronous (52.58, 90) hits z=-102.42mm.
        self.arm.actual = {"base": -35.47, "shoulder": 52.58, "elbow": 47.66, "hand": 180.0}
        self.now += .6
        self.call("telemetry")
        keys = self.arm_keys()
        with self.assertRaises(ValueError):
            self.call("move", {**keys, "kind": "home_direct", "confirmed": True})
        self.assertEqual([c for c in self.arm.calls if isinstance(c, tuple)], [])

    def test_swept_clearance_detects_thin_box_between_spatial_samples(self):
        # Finding D: narrow box between 6-sample points on stationary HOME lower arm.
        thin = {"name": "ThinSensor", "x": [146.5314, 146.9314], "y": [-0.5, 0.5], "z": [236.32, 237.32]}
        res = arm.swept_clearance(arm.HOME, arm.HOME, [thin])
        self.assertEqual(res["collision_zone"], "ThinSensor")
        self.assertLess(res["min_clearance_mm"], 0.0)

    def test_signed_estop_sequence_survives_new_transport_instance(self):
        import hmac as _hmac
        import hashlib as _hashlib

        class ReplayHandler(BaseHTTPRequestHandler):
            seq = 10
            force_seq = None
            saw_secret_header = False

            def log_message(self, *_):
                pass

            def do_GET(self):
                nonce = self.headers.get("X-HQ-Estop-Nonce", "")
                if "X-HQ-Estop-Token" in self.headers:
                    ReplayHandler.saw_secret_header = True
                if self.force_seq is not None:
                    seq = self.force_seq
                else:
                    ReplayHandler.seq += 1
                    seq = ReplayHandler.seq
                sig = _hmac.new(b"secret", f"{nonce}:{seq}:1".encode(), _hashlib.sha256).hexdigest()
                body = json.dumps({"closed": True, "nonce": nonce, "seq": seq, "hmac": sig}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

        with serve(ReplayHandler) as port:
            self.lab.estop_factory = estop.HttpEstop
            self.setup_hardware(estop=False)
            cfg = self.call("settings", {
                "estop_ip": "127.0.0.1", "estop_port": port, "estop_token": "secret",
                "estop_required": True, "estop_require_signed": True,
            })["config"]
            self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
            first = self.lab.estop_health(self.lab.config(), force=True)
            self.assertTrue(first["healthy"])
            self.assertTrue(first.get("signed"))
            self.assertFalse(ReplayHandler.saw_secret_header)
            ReplayHandler.force_seq = 11  # replayed/non-monotonic seq across a fresh HttpEstop instance
            second = self.lab.estop_health(self.lab.config(), force=True)
            self.assertFalse(second["healthy"])

    def test_tapo_pin_change_invalidates_cached_session(self):
        created = []

        class FakeTapo:
            def __init__(self, address, user, password, timeout, *, tls_sha256=""):
                self.address = address
                self.password = password
                self.tls_sha256 = tls_sha256
                created.append(tls_sha256)

            def night_mode(self, mode=None):
                return "auto"

        self.lab.tapo_factory = FakeTapo
        self.call("settings", {
            "camera_ip": "192.168.4.5", "camera_user": "admin", "camera_password": "pw",
            "camera_cloud_password": "cloud", "camera_tls_sha256": "a" * 64,
        })
        self.call("camera/night", {"mode": "read"})
        self.call("settings", {"camera_tls_sha256": "b" * 64})
        self.call("camera/night", {"mode": "read"})
        self.assertEqual(created, ["a" * 64, "b" * 64])

    def test_preflight_respects_commissioned_step_limit(self):
        saved = self.call("recordings", {
            "action": "save",
            "name": "StepCheck",
            "start": arm.HOME.copy(),
            "steps": [{**arm.HOME, "base": 10.0}],
        })
        rec_id = next(iter(saved["recordings"]))
        with self.assertRaises(ValueError):
            self.call("recordings", {"action": "preflight", "id": rec_id, "max_step_deg": 8.0})

    def test_incident_preserves_last_known_feedback(self):
        self.setup_hardware(estop=True)
        self.arm.actual = {**arm.HOME, "base": 7.5}
        self.now += .6
        self.call("telemetry")
        self.call("arm")
        self.lab.trip_estop(self.lab.config())
        entries = self.call("blackbox", method="GET")["entries"]
        self.assertEqual(entries[0]["incident"], "estop")
        self.assertAlmostEqual(entries[0]["actual"]["base"], 7.5)

    def test_cancel_after_in_tolerance_feedback_stays_unconfirmed(self):
        self.setup_hardware()
        keys = self.arm_keys()
        # FakeArm.follow is False: hardware has not moved.
        self.call("move", {
            **keys,
            "kind": "joints",
            "pose": {**arm.HOME, "base": 1.0},
        })
        self.now += 0.6
        self.call("telemetry")  # Actual remains HOME, within 2° tolerance.
        status = self.call("cancel", {"lease": keys["lease"]})
        self.assertTrue(status["uncertain"])
        self.assertEqual(status["stop_state"], "unconfirmed")

    def test_swept_clearance_detects_midpoint_capsule_collision(self):
        start = {**arm.HOME, "base": -1.0}
        end = {**arm.HOME, "base": 1.0}
        zone = {
            "name": "mid_sweep",
            "x": [331.99, 332.01],
            "y": [-0.01, 0.01],
            "z": [236.81, 236.83],
        }
        result = arm.swept_clearance(start, end, [zone])
        self.assertEqual(result["collision_zone"], "mid_sweep")
        self.assertLessEqual(result["min_clearance_mm"], 0)

    def test_concurrent_signed_estop_sequence_is_monotonic(self):
        import hmac as _hmac
        import hashlib as _hashlib

        class ConcurrentHandler(BaseHTTPRequestHandler):
            seq = 0
            gate = threading.Event()

            def log_message(self, *_):
                pass

            def do_GET(self):
                nonce = self.headers.get("X-HQ-Estop-Nonce", "")
                ConcurrentHandler.seq += 1
                my_seq = ConcurrentHandler.seq
                if my_seq == 1:
                    ConcurrentHandler.gate.wait(0.2)
                sig = _hmac.new(b"secret", f"{nonce}:{my_seq}:1".encode(), _hashlib.sha256).hexdigest()
                body = json.dumps({"closed": True, "nonce": nonce, "seq": my_seq, "hmac": sig}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(body)

        with serve(ConcurrentHandler) as port:
            self.lab.estop_factory = estop.HttpEstop
            self.setup_hardware(estop=False)
            cfg = self.call("settings", {
                "estop_ip": "127.0.0.1", "estop_port": port, "estop_token": "secret",
                "estop_required": True, "estop_require_signed": True,
            })["config"]
            self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
            live_cfg = self.lab.config()
            results = []
            t1 = threading.Thread(target=lambda: results.append(self.lab.estop_health(live_cfg, force=True)))
            t2 = threading.Thread(target=lambda: results.append(self.lab.estop_health(live_cfg, force=True)))
            t1.start()
            t2.start()
            ConcurrentHandler.gate.set()
            t1.join(timeout=2.0)
            t2.join(timeout=2.0)
            self.assertEqual(len(results), 2)
            self.assertTrue(all(r["healthy"] for r in results))
            self.assertEqual(self.lab.estop_last_seq, 2)

    def test_two_unmoved_feedback_reads_must_not_confirm_physical_stop(self):
        self.setup_hardware()
        keys = self.arm_keys()
        # FakeArm.follow is False, so actual remains at HOME.
        self.call("move", {
            **keys,
            "kind": "joints",
            "pose": {**arm.HOME, "base": 1.0},
        })
        for _ in range(2):
            self.now += 0.6
            self.call("telemetry")
        status = self.call("cancel", {"lease": keys["lease"]})
        self.assertTrue(status["uncertain"])
        self.assertEqual(status["stop_state"], "unconfirmed")

    def test_async_joint_keepout_counterexample(self):
        start = {**arm.HOME, "base": -2.5, "shoulder": -2.5, "elbow": 87.5}
        end = {**arm.HOME, "base": 2.5, "shoulder": 2.5, "elbow": 92.5}
        async_pose = {**arm.HOME, "base": -2.5, "shoulder": 2.5, "elbow": 92.5}
        tcp = arm.link_positions(async_pose)["tcp"]
        zone = {
            "name": "async_only",
            **{axis: [tcp[axis] - 0.1, tcp[axis] + 0.1] for axis in ("x", "y", "z")},
        }
        coordinated = arm.swept_clearance(start, end, [zone])
        self.assertIsNone(coordinated["collision_zone"])

        async_res = arm.async_box_clearance(start, end, [zone])
        self.assertEqual(async_res["collision_zone"], "async_only")
        self.assertLessEqual(async_res["min_clearance_mm"], 0.0)

        self.setup_hardware()
        cfg = self.call("settings", {"keepout": [zone]})["config"]
        self.lab.write(self.lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        self.arm.actual = dict(start)
        self.now += 0.6
        self.call("telemetry")
        keys = self.arm_keys()
        with self.assertRaisesRegex(robotics.Rejected, "async_only"):
            self.call("move", {**keys, "kind": "joints", "pose": end})
        self.assertEqual([c for c in self.arm.calls if isinstance(c, tuple)], [])

    def test_old_stream_finally_cannot_clear_newer_stream_active_state(self):
        cfg = self.setup_hardware()
        self.arm.follow = True
        self.arm.actual = {**arm.HOME, "base": 10.0}
        self.now += 0.6
        self.call("telemetry")
        keys = self.arm_keys()
        old_sleeping = threading.Event()
        old_release = threading.Event()

        def sleep_old(_seconds):
            if threading.current_thread().name == "old-stream":
                old_sleeping.set()
                old_release.wait(2.0)

        self.lab.stream_sleep = sleep_old
        old_thread = threading.Thread(
            target=self.lab.stream,
            args=(cfg, "a", keys["lease"], self.arm.actual, arm.HOME, 0.2, 60),
            kwargs={"epoch": self.lab.epoch, "stream_id": 1},
            name="old-stream",
        )
        self.lab.stream_generation = 1
        self.lab.active_stream_id = 1
        old_thread.start()
        self.assertTrue(old_sleeping.wait(2.0))

        # Newer stream generation 2 takes over active_stream_id; old stream wakes & exits.
        with self.lab.lock:
            self.lab.stream_generation = 2
            self.lab.active_stream_id = 2
        old_release.set()
        old_thread.join(timeout=2.0)
        self.assertEqual(self.lab.active_stream_id, 2)

    def test_swept_clearance_terminal_interval_fails_closed(self):
        # Tiny interval (0.01 deg) near a box at exact 22.05 mm distance: c_mid > 0,
        # but c_mid - half_arc < 0 at terminal subdivision -> must fail closed.
        start = {**arm.HOME, "base": -0.005}
        end = {**arm.HOME, "base": 0.005}
        tcp = arm.link_positions(arm.HOME)["tcp"]
        zone = {
            "name": "near_edge",
            "x": [tcp["x"] + 22.02, tcp["x"] + 23.02],
            "y": [-0.5, 0.5],
            "z": [tcp["z"] - 0.5, tcp["z"] + 0.5],
        }
        res = arm.swept_clearance(start, end, [zone])
        self.assertTrue(res["clearance_uncertain"])
        self.assertEqual(res["collision_zone"], "near_edge")
        self.assertLessEqual(res["min_clearance_mm"], 0.0)


@contextmanager
def serve(handler):
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield server.server_address[1]
        finally:
            server.shutdown()
            worker.join()


class EstopTransport(unittest.TestCase):
    def test_monitor_contract_token_and_safe_failures(self):
        state = {"closed": True, "reply": None}

        class Monitor(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path != "/estop":
                    self.send_response(404)
                    self.end_headers()
                    return
                if self.headers.get("X-HQ-Estop-Token") != "s3cret":
                    self.send_response(401)
                    self.end_headers()
                    return
                raw = state["reply"] if state["reply"] is not None else json.dumps(
                    {"closed": state["closed"]}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(raw)

        with serve(Monitor) as port:
            monitor = estop.HttpEstop("127.0.0.1", port, "s3cret", .5)
            self.assertEqual(monitor.read(), {"closed": True, "healthy": True})
            state["closed"] = False
            self.assertEqual(monitor.read(), {"closed": False, "healthy": False})
            state["reply"] = b"{\"closed\": 1}"
            with self.assertRaisesRegex(arm.DeviceError, "invalide"):
                monitor.read()
            state["reply"] = b"{"
            with self.assertRaisesRegex(arm.DeviceError, "invalide"):
                monitor.read()
            with self.assertRaisesRegex(arm.DeviceError, "refusé"):
                estop.HttpEstop("127.0.0.1", port, "wrong", .5).read()
        with self.assertRaises(ValueError):
            estop.HttpEstop("8.8.8.8", 80, "", .5)
        with self.assertRaises(ValueError):
            estop.HttpEstop("http://127.0.0.1", 80, "", .5)
        with self.assertRaises(ValueError):
            estop.HttpEstop("127.0.0.1", 80, "tök", .5)


class Transport(unittest.TestCase):
    def test_onvif_preset_delete_is_bounded_and_needs_a_profile(self):
        control = ptz.Ptz("192.168.2.187", "viewer", "secret", 1)
        control.token = "profile_1"
        with patch.object(control, "_post") as post:
            control.delete_preset("wide")
        body = post.call_args.args[1]
        self.assertIn("<RemovePreset", body)
        self.assertIn("<PresetToken>wide</PresetToken>", body)
        with self.assertRaisesRegex(arm.DeviceError, "Vue"):
            control.delete_preset("bad token")

    def test_mock_roarm_http_protocol_bad_replies_and_timeout(self):
        requests = []
        reply = [None]

        class Firmware(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                uri = urlsplit(self.path)
                payload = json.loads(parse_qs(uri.query)["json"][0])
                requests.append((uri.path, payload))
                result = reply[0]
                if result is None:
                    result = {"T": 1051, **{k: v for k, v in arm.position(arm.HOME).items() if k != "t"},
                              "b": 0, "s": 0, "e": math.pi / 2, "t": math.pi, "v": 1200} if payload["T"] == 105 else {}
                    result = json.dumps(result).encode()
                if result == b"timeout":
                    time.sleep(.3)
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(result)

        with serve(Firmware) as port:
            with patch.object(arm.http.client, "HTTPConnection", side_effect=lambda _host, _port, timeout:
                              original_connection("127.0.0.1", port, timeout=timeout)):
                robot = arm.HttpArm("192.168.1.4", .1)
                self.assertEqual(robot.feedback()["voltage"], 12)
                robot.move(arm.HOME, 100, 4)
                robot.emergency_stop()
                self.assertEqual([r[1]["T"] for r in requests], [105, 102, 210])
                self.assertEqual(requests[-1], ("/js", {"T": 210, "cmd": 0}))
                for raw in (b"{", b'{"T":1051}', b'{"T":0}', b"timeout", b"null", b""):
                    reply[0] = raw
                    with self.assertRaises(arm.DeviceError):
                        robot.feedback()
                for raw in (b"null", b"", b"{}"):  # the real firmware acknowledges a command with null
                    reply[0] = raw
                    robot.move(arm.HOME, 100, 4)
                    robot.emergency_stop()
                for raw in (b'{"x":1}', b"[]", b"{"):
                    reply[0] = raw
                    with self.assertRaises(arm.DeviceError):
                        robot.move(arm.HOME, 100, 4)

    def test_onvif_ptz_digest_auth_pinned_paths_and_the_stop_that_always_follows(self):
        import base64, hashlib, re
        seen = []
        mode = ["ok"]

        class Camera(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"])).decode()
                verb = re.search(r"<(?:\w+:)?(GetSystemDateAndTime|GetCapabilities|GetProfiles|ContinuousMove|Stop|GetPresets|SetPreset|GotoPreset|RemovePreset)\b", body).group(1)
                auth = None
                if "<Username>" in body:
                    user = re.search(r"<Username>(.*?)</Username>", body).group(1)
                    digest = re.search(r"PasswordDigest\">(.*?)</Password>", body).group(1)
                    nonce = base64.b64decode(re.search(r"<Nonce>(.*?)</Nonce>", body).group(1))
                    created = re.search(r"<Created[^>]*>(.*?)</Created>", body).group(1)
                    expect = base64.b64encode(hashlib.sha1(nonce + created.encode() + b"S3cret&<>").digest()).decode()
                    auth = (user, digest == expect)
                seen.append((self.path, verb, auth, body))
                if mode[0] == "denied" and verb != "GetSystemDateAndTime":
                    reply, status = b"<Fault>Sender not Authorized</Fault>", 400
                elif verb == "GetSystemDateAndTime":
                    reply, status = (b"<r><UTCDateTime><Time><Hour>10</Hour><Minute>0</Minute><Second>0</Second></Time>"
                                     b"<Date><Year>2026</Year><Month>11</Month><Day>14</Day></Date></UTCDateTime></r>"), 200
                elif verb == "GetCapabilities":
                    reply, status = (b"<r><Capabilities><Media><XAddr>http://10.9.9.9:2020/onvif/service</XAddr></Media>"
                                     b"<PTZ><XAddr>http://10.9.9.9:2020/onvif/ptz_service</XAddr></PTZ></Capabilities></r>"), 200
                elif verb == "GetProfiles":
                    reply, status = b'<r><Profiles token="profile_1" fixed="true"><Name>x</Name></Profiles></r>', 200
                elif verb == "GetPresets":
                    reply, status = b'<r><Preset token="wide"><Name>Vue large</Name></Preset></r>', 200
                elif verb == "SetPreset":
                    reply, status = b'<r><Preset token="wide"/></r>', 200
                else:
                    reply, status = b"<r/>", 200
                self.send_response(status)
                self.end_headers()
                self.wfile.write(reply)

        with serve(Camera) as port:
            with patch.object(ptz.http.client, "HTTPConnection", side_effect=lambda host, _port, timeout:
                              original_connection("127.0.0.1", port, timeout=timeout)) as connect:
                with patch.object(ptz.time, "sleep"):
                    camera_control = ptz.Ptz("192.168.2.187", "cam<user>", "S3cret&<>", 1)
                    camera_control.pulse("left", .4)
                self.assertTrue(all(call.args[0] == "192.168.2.187" for call in connect.call_args_list))  # pinned host
                verbs = [item[1] for item in seen]
                self.assertEqual(verbs, ["GetSystemDateAndTime", "GetCapabilities", "GetProfiles", "ContinuousMove", "Stop"])
                self.assertIsNone(seen[0][2])  # the clock request needs no account
                self.assertTrue(all(item[2] and item[2][1] for item in seen[1:]))  # valid digests for the escaped password
                self.assertEqual(seen[-1][0], "/onvif/ptz_service")  # path taken from the camera, host never
                self.assertIn('x="-0.5"', seen[3][3])
                self.assertIn("cam&lt;user&gt;", seen[1][3])
                self.assertEqual(camera_control.presets(), [{"token": "wide", "name": "Vue large"}])
                self.assertEqual(camera_control.save_preset("Vue large"), {"token": "wide", "name": "Vue large"})
                camera_control.goto_preset("wide")
                camera_control.delete_preset("wide")
                self.assertEqual([item[1] for item in seen[-4:]],
                                 ["GetPresets", "SetPreset", "GotoPreset", "RemovePreset"])
                with self.assertRaises(arm.DeviceError):
                    ptz.Ptz("192.168.2.187", "u", "p", 1).pulse("sideways", .4)
                # A move that fails midway still ends with a stop request.
                seen.clear()
                with patch.object(ptz.time, "sleep", side_effect=RuntimeError("interrupted")):
                    with self.assertRaises(RuntimeError):
                        ptz.Ptz("192.168.2.187", "cam<user>", "S3cret&<>", 1).pulse("up", .4)
                self.assertEqual([item[1] for item in seen][-2:], ["ContinuousMove", "Stop"])
                mode[0] = "denied"
                with self.assertRaisesRegex(arm.DeviceError, "refusé"):
                    ptz.Ptz("192.168.2.187", "cam<user>", "wrong", 1).pulse("up", .4)
        with self.assertRaises(ValueError):
            ptz.Ptz("8.8.8.8", "u", "p", 1)

    def test_tapo_aes_matches_the_standard_vectors_and_rejects_bad_padding(self):
        key = bytes(range(16))
        self.assertEqual(tapo._encrypt_block(bytes.fromhex("00112233445566778899aabbccddeeff"), tapo._expand(key)).hex(),
                         "69c4e0d86a7b0430d8cdb78070b4c55a")  # FIPS-197 appendix C.1
        k = bytes.fromhex("2b7e151628aed2a6abf7158809cf4f3c")
        iv = bytes.fromhex("000102030405060708090a0b0c0d0e0f")
        self.assertEqual(tapo.aes_cbc_encrypt(k, iv, bytes.fromhex("6bc1bee22e409f96e93d7e117393172a"))[:16].hex(),
                         "7649abac8119b246cee98e9b12e9197d")  # SP 800-38A F.2.1
        message = '{"é":"x"}'.encode()
        self.assertEqual(tapo.aes_cbc_decrypt(k, iv, tapo.aes_cbc_encrypt(k, iv, message)), message)
        sealed = bytearray(tapo.aes_cbc_encrypt(k, iv, message))
        sealed[-1] ^= 1
        with self.assertRaises(arm.DeviceError):
            tapo.aes_cbc_decrypt(k, iv, bytes(sealed))
        with self.assertRaises(arm.DeviceError):
            tapo.aes_cbc_decrypt(k, iv, b"short")

    def test_tapo_login_and_night_mode_against_a_simulated_camera(self):
        import hashlib as hl
        password, state = "cloud-pass", {"mode": "auto", "seen": []}

        class Device(tapo.Tapo):
            """Plays the camera's side of the protocol over the real client's own framing."""

            def _http(self, path, body, headers=None):
                request = json.loads(body)
                if path == "/":
                    params = request["params"]
                    if params.get("sub_method") == "discover":
                        return {"error_code": -40413, "result": {"data": {"encrypt_type": ["3"]}}}
                    nonce = "N" * 16
                    if "digest_passwd" not in params:
                        confirm = tapo.digest(params["cnonce"] + hl.sha256(password.encode()).hexdigest().upper() + nonce) + nonce + params["cnonce"]
                        return {"error_code": -40413, "result": {"data": {"nonce": nonce, "device_confirm": confirm}}}
                    hashed = hl.sha256(password.encode()).hexdigest().upper()
                    if params["digest_passwd"] != tapo.digest(hashed + params["cnonce"] + nonce) + params["cnonce"] + nonce:
                        return {"error_code": -40411}
                    state["cnonce"], state["nonce"], state["hashed"] = params["cnonce"], nonce, hashed
                    return {"error_code": 0, "result": {"stok": "STOK123", "start_seq": 7}}
                key = tapo.digest(state["cnonce"] + state["hashed"] + state["nonce"])
                lsk = hl.sha256(("lsk" + state["cnonce"] + state["nonce"] + key).encode()).digest()[:16]
                ivb = hl.sha256(("ivb" + state["cnonce"] + state["nonce"] + key).encode()).digest()[:16]
                expect_tag = hl.sha256((tapo.digest(state["hashed"] + state["cnonce"]) + body + headers["Seq"]).encode()).hexdigest().upper()
                assert headers["Tapo_tag"] == expect_tag, "tag"
                assert path == "/stok=STOK123/ds"
                inner = json.loads(tapo.aes_cbc_decrypt(lsk, ivb, tapo.base64.b64decode(request["params"]["request"])))
                state["seen"].append((int(headers["Seq"]), inner))
                call = inner["params"]["requests"][0]
                if call["method"] == "setDayNightModeConfig":
                    state["mode"] = call["params"]["image"]["common"]["inf_type"]
                    result = {"error_code": 0}
                else:
                    result = {"error_code": 0, "result": {"image": {"common": {"inf_type": state["mode"]}}}}
                sealed = tapo.aes_cbc_encrypt(lsk, ivb, json.dumps({"error_code": 0, "result": {"responses": [result]}}).encode())
                return {"error_code": 0, "result": {"response": tapo.base64.b64encode(sealed).decode()}}

        camera = Device("192.168.2.187", "admin", password, 1)
        self.assertEqual(camera.night_mode(), "auto")
        self.assertEqual(camera.night_mode("on"), "on")
        self.assertEqual(state["mode"], "on")
        self.assertEqual([seq for seq, _ in state["seen"]], [7, 8])  # the sequence number advances
        with self.assertRaises(arm.DeviceError):
            camera.night_mode("sunny")
        with self.assertRaisesRegex(arm.DeviceError, "refusé"):
            Device("192.168.2.187", "admin", "wrong", 1).night_mode()

    def test_tapo_tpap_session_reads_and_sets_night_mode_without_relogin(self):
        password = "fixture-owner-password"
        registration = {
            "dev_salt": "AAECAwQFBgcICQoLDA0ODw==",
            "dev_random": "REREREREREREREREREREREREREREREREREREREREREQ=",
            "dev_share": "BPdp971eFphmJwzsjt0/Ls/8mn/0vQrvrdZt+ipmcWgoDqVbQZpqGN39OO6eQwRFSX2umwh3FW7/s/0P4KBDX0M=",
            "iterations": 1000,
            "extra_crypt": {"type": "password_shadow", "params": {"passwd_id": 5, "passwd_prefix": "$5$fixturesalt$"}},
        }
        expected_share = "BLnNMasRMenGOoyEhGu2rgM/F5t+tqcWfM79AbATxIKcVpsuMWoE2xxU3zgqRVp7bysr4vRNwAR5TSGlqIU4cZc="
        expected_proof = "VFlDscc6NumPzv9OdVpZ4HDbTFsOjc2y6vJ+oySzSMQ="
        # Synthetic transcript generated with the upstream SPAKE2+ client and fixed randomness.
        server_proof = "EvdUTfZToraMBphIrbYf2fy60IZ0lEgAFVsTHb7af1w="
        key = bytes.fromhex("2ed36d657f02cf9a8d7c17dbc0f32c54")
        nonce_prefix = bytes.fromhex("4cace782e359b510")
        case = self

        class Device(tapo.Tapo):
            def __init__(self, credential):
                super().__init__("192.168.2.187", "admin", credential, 1)
                self.steps = []
                self.mode = "off"

            def _http(self, path, body, headers=None):
                case.assertEqual(path, "/")
                params = json.loads(body)["params"]
                step = params["sub_method"]
                self.steps.append(step)
                if step == "discover":
                    return {"error_code": 0, "result": {"tpap": {"pake": [2]}}}
                case.assertEqual(headers["requestByApp"], "true")
                if step == "pake_register":
                    case.assertEqual(params["username"], "21232f297a57a5a743894a0e4a801fc3")
                    case.assertEqual(tapo.base64.b64decode(params["user_random"]), b"R" * 32)
                    case.assertEqual(params["encryption"], ["aes_128_ccm"])
                    return {"error_code": 0, "result": registration}
                case.assertEqual(step, "pake_share")
                if params["user_confirm"] != expected_proof:
                    return {"error_code": -40401}
                case.assertEqual(params["user_share"], expected_share)
                return {"error_code": 0, "result": {"dev_confirm": server_proof, "stok": "STOK~V4", "start_seq": 7}}

            def _http_bytes(self, path, body, headers):
                case.assertEqual(path, "/stok=STOK~V4/ds")
                case.assertEqual(headers["Content-Type"], "application/octet-stream")
                seq = body[:4]
                self.steps.append(int.from_bytes(seq, "big"))
                nonce = nonce_prefix + seq
                payload = json.loads(tapo._ccm_decrypt(key, nonce, body[4:]))
                case.assertEqual(payload["method"], "multipleRequest")
                request = payload["params"]["requests"][0]
                result = {"error_code": 0}
                if request["method"] == "getDayNightModeConfig":
                    case.assertEqual(request["params"]["image"]["name"], "common")
                    result["result"] = {"image": {"common": {"inf_type": self.mode}}}
                else:
                    case.assertEqual(request["method"], "setDayNightModeConfig")
                    self.mode = request["params"]["image"]["common"]["inf_type"]
                reply = {"error_code": 0, "result": {"responses": [result]}}
                return seq + tapo._ccm_encrypt(key, nonce, json.dumps(reply).encode())

        device = Device(password)
        rejected = Device("wrong")
        with patch.object(tapo.secrets, "token_bytes", return_value=b"R" * 32), \
             patch.object(tapo.secrets, "randbelow", return_value=12):
            self.assertEqual(device.night_mode(), "off")
            self.assertEqual(device.night_mode("on"), "on")
            self.assertEqual(device.night_mode(), "on")
            with self.assertRaisesRegex(arm.DeviceError, "refusé"):
                rejected.night_mode()
        exchange = ["discover", "pake_register", "pake_share"]
        self.assertEqual(device.steps, [*exchange, 7, 8, 9])
        self.assertEqual(rejected.steps, exchange)

    def test_tapo_login_lockout_is_reported_with_the_wait_and_not_retried(self):
        class Locked(tapo.Tapo):
            tries = 0

            def _http(self, path, body, headers=None):
                Locked.tries += 1
                return {"error_code": -40401, "data": {"code": -40404, "sec_left": 1708}}

        with self.assertRaisesRegex(arm.DeviceError, r"suspendue encore 29 min"):
            Locked("192.168.2.187", "admin", "pw", 1).night_mode()
        self.assertEqual(Locked.tries, 1)

    def test_rtsp_relay_rejects_redirect(self):
        gateway, g = socket.socketpair()
        camera_socket, c = socket.socketpair()
        stopped = threading.Event()
        with gateway, g, camera_socket, c:
            gateway.settimeout(1)
            errors = []

            def relay():
                try:
                    camera.relay_rtsp(g, c, stopped)
                except ValueError:
                    errors.append("redirect rejected")

            worker = threading.Thread(target=relay)
            worker.start()
            try:
                good = b"RTSP/1.0 200 OK\r\nContent-Length: 3\r\n\r\nabc$\x00\x00\x02ab"
                camera_socket.sendall(good)
                received = b""
                while len(received) < len(good):
                    received += gateway.recv(1024)
                self.assertEqual(received, good)
                camera_socket.sendall(b"RTSP/1.0 302 Found\r\nLocation: rtsp://elsewhere/\r\n\r\n")
                worker.join(1)
                self.assertEqual(errors, ["redirect rejected"])
            finally:
                stopped.set()
                worker.join(1)


original_connection = http.client.HTTPConnection


if __name__ == "__main__":
    unittest.main()
