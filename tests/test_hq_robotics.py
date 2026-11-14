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
import hq_robotics_arm as arm
import hq_robotics_camera as camera


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
        self.feedback_gate = None

    def feedback(self):
        self.calls.append("feedback")
        if self.feedback_gate:
            self.feedback_gate()
        if self.error == "feedback":
            raise arm.DeviceError("device timeout")
        return {"source": "hardware", "actual": self.actual.copy(), "xyz": arm.position(self.actual),
                "load": {}, "torque": {}, "voltage": None}

    def move(self, pose, speed, acceleration):
        self.calls.append(("move", pose, speed, acceleration))
        if self.error == "move":
            raise arm.DeviceError("device timeout")

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
        self.permitted = True

    def call(self, action, data=None, *, method="POST", session="a", local=True):
        return self.lab.dispatch(action, method, data or {}, session,
                                 local=local, physical=local, authorized=lambda: self.permitted)

    def status(self, lease="", **kwargs):
        return self.call("status", {"lease": lease}, method="GET", **kwargs)

    def arm_keys(self):
        lease = self.call("arm")["lease"]
        return {"lease": lease, "ticket": self.status(lease)["ticket"]}

    def hardware(self, *, commissioned=True, video=True):
        cfg = self.call("settings", {"mode": "hardware", "arm_ip": "192.168.4.15"})["config"]
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


class Transport(unittest.TestCase):
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
                for raw in (b"{", b'{"T":1051}', b'{"T":0}', b"timeout"):
                    reply[0] = raw
                    with self.assertRaises(arm.DeviceError):
                        robot.feedback()

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
