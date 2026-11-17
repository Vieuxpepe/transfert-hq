#!/usr/bin/env python3
"""Hardware-backed verification for the optional Robotique safety devices.

Default mode uses the real controller/settings/keep-out paths with fake hardware,
including a monitored E-stop contact and a fake ONVIF PTZ. It never touches the
network. `--live` reads the current HQ hardware configuration on the PC HQ:

- reads the RoArm feedback and the configured E-stop monitor;
- previews a target inside the first TCP keep-out box (no arm motion);
- lists the Tapo ONVIF presets. Passing `--ptz-name` additionally saves,
  recalls and removes one verification preset.

Live keep-out preview does not arm or move the arm. PTZ writes do move the
camera and are opt-in. No credential is printed or accepted on the command line.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_robotics as robotics  # noqa: E402
import hq_robotics_arm as arm  # noqa: E402
from hq_robotics_ptz import Ptz  # noqa: E402
from tests.test_hq_robotics import FakeArm, FakeCamera  # noqa: E402


class FakeEstop:
    closed = True

    def __init__(self, *args):
        self.args = args

    def read(self):
        return {"closed": self.closed, "healthy": self.closed}


class FakePtz:
    def __init__(self):
        self.calls = []

    def presets(self):
        self.calls.append(("list",))
        return [{"token": "bench", "name": "Banc"}]

    def save_preset(self, name):
        self.calls.append(("save", name))
        return {"token": "bench", "name": name}

    def goto_preset(self, token):
        self.calls.append(("goto", token))

    def delete_preset(self, token):
        self.calls.append(("delete", token))


def check(condition, label, checks=None):
    if checks is not None:
        checks[0] += 1
    if not condition:
        raise AssertionError(label)
    print("  OK", label)


def fake_check():
    checks = [0]
    with tempfile.TemporaryDirectory(prefix="hq-robotics-hardware-") as temp:
        now = [100.0]
        fake_arm = FakeArm()
        fake_arm.follow = True
        monitor = FakeEstop()
        fake_ptz = FakePtz()
        lab = robotics.Robotics(Path(temp), clock=lambda: now[0],
                                arm_factory=lambda *_: fake_arm, camera=FakeCamera(),
                                estop_factory=lambda *_: monitor)
        lab.stream_threaded = False
        lab.stream_sleep = lambda seconds: now.__setitem__(0, now[0] + seconds)
        lab.ptz_factory = lambda *_: fake_ptz

        def call(action, data=None, method="POST"):
            return lab.dispatch(action, method, data or {}, "bench", local=True,
                                physical=True, authorized=lambda: True)

        blocked = {**arm.HOME, "base": 4}
        point = arm.position(blocked)
        zone = {"name": "Harnais de vérification",
                "x": [max(arm.WORKSPACE["x"][0], point["x"] - 30),
                      min(arm.WORKSPACE["x"][1], point["x"] + 30)],
                "y": [max(arm.WORKSPACE["y"][0], point["y"] - 30),
                      min(arm.WORKSPACE["y"][1], point["y"] + 30)],
                "z": [max(arm.WORKSPACE["z"][0], point["z"] - 30),
                      min(arm.WORKSPACE["z"][1], point["z"] + 30)]}
        call("settings", {
            "mode": "hardware", "arm_ip": "192.168.4.15", "camera_ip": "192.168.4.20",
            "camera_user": "viewer", "camera_password": "fixture",
            "camera_required": False, "estop_ip": "127.0.0.1", "estop_port": 8080,
            "estop_required": True, "keepout": [zone],
        })
        cfg = lab.config()
        lab.write(lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        call("telemetry")
        status = call("status", method="GET")
        check(status["feedback"]["source"] == "hardware", "RoArm feedback is the hardware path")
        check(status["estop"]["mode"] == "hardware" and status["estop"]["healthy"] is True,
              "monitored E-stop is closed")
        lease = call("arm")["lease"]
        check(bool(lease), "monitored hardware arm is allowed")
        ticket = call("status", {"lease": lease}, method="GET")["ticket"]
        before = [item for item in fake_arm.calls if item[0] == "move"]
        try:
            call("move", {"lease": lease, "ticket": ticket, "kind": "joints",
                          "pose": blocked})
            raise AssertionError("keep-out target was accepted")
        except robotics.Rejected as error:
            check(error.code == "robotics_keepout", "hardware keep-out rejects a target")
        after = [item for item in fake_arm.calls if item[0] == "move"]
        check(before == after == [], "keep-out refusal sends no arm command")

        check(call("camera/ptz-preset", {"op": "list"})["presets"][0]["token"] == "bench",
              "Tapo preset list")
        check(call("camera/ptz-preset", {"op": "save", "name": "Vérif"})["preset"]["token"] == "bench",
              "Tapo preset save")
        check(call("camera/ptz-preset", {"op": "goto", "token": "bench"})["ok"], "Tapo preset recall")
        check(fake_ptz.calls == [("list",), ("save", "Vérif"), ("goto", "bench")],
              "Tapo preset commands reached the PTZ adapter")

        call("cancel", {"lease": lease})
        monitor.closed = False
        now[0] += 1
        check(call("status", method="GET")["estop"]["healthy"] is False,
              "open E-stop contact is visible")
        try:
            call("arm")
            raise AssertionError("open E-stop allowed arming")
        except robotics.Rejected as error:
            check(error.code == "robotics_estop", "open E-stop refuses arming")

        simulation = robotics.Robotics(Path(temp) / "simulation", clock=lambda: now[0],
                                       arm_factory=lambda *_: fake_arm, camera=FakeCamera())
        sim_status = simulation.dispatch("status", "GET", {}, "bench", local=True,
                                         physical=True, authorized=lambda: True)
        check(sim_status["estop"] == {"mode": "simulation", "healthy": True},
              "simulation fallback stays explicit")
    print("verify_robotics_hardware: fake hardware OK (no network or hardware)")
    return 0


def live_check(root, ptz_name):
    root = Path(root).resolve()
    if not (root / ".hq-agent-state" / "robotics.json").is_file():
        print("verify_robotics_hardware: no Robotique configuration in", root, file=sys.stderr)
        return 2
    checks = [0]
    lab = robotics.Robotics(root)
    cfg = lab.config()
    if cfg["mode"] != "hardware":
        print("verify_robotics_hardware: switch Robotique to Matériel first", file=sys.stderr)
        return 2

    def call(action, data=None, method="POST"):
        return lab.dispatch(action, method, data or {}, "verify", local=True,
                            physical=True, authorized=lambda: True)

    try:
        status = call("telemetry")
        check(status["feedback"] and status["feedback"]["source"] == "hardware",
              "read-only RoArm feedback", checks)
        estop = status["estop"]
        if estop["mode"] == "hardware":
            check(estop["healthy"] is True, "monitored E-stop contact is closed", checks)
        elif cfg["estop_required"]:
            check(False, "monitored E-stop is required but not configured", checks)
        else:
            print("  SKIP monitored E-stop is not configured")
        if cfg["keepout"]:
            zone = cfg["keepout"][0]
            xyz = {"x": (zone["x"][0] + zone["x"][1]) / 2,
                   "y": (zone["y"][0] + zone["y"][1]) / 2,
                   "z": (zone["z"][0] + zone["z"][1]) / 2, "t": 180}
            try:
                call("preview", {"kind": "cartesian", "xyz": xyz})
                raise AssertionError("keep-out preview was accepted")
            except robotics.Rejected as error:
                check(error.code == "robotics_keepout", "TCP keep-out preview refused a target", checks)
        else:
            print("  SKIP no TCP keep-out box is configured")
        if lab.camera_configured(cfg):
            ptz = Ptz(cfg["camera_ip"], cfg["camera_user"], cfg["camera_password"], cfg["camera_timeout"])
            presets = ptz.presets()
            check(isinstance(presets, list), "Tapo ONVIF presets listed", checks)
            print(f"  Tapo presets: {len(presets)}")
            if ptz_name:
                created = ptz.save_preset(ptz_name)
                token = created.get("token", "")
                try:
                    ptz.goto_preset(token)
                    check(True, "Tapo verification preset recalled", checks)
                finally:
                    ptz.delete_preset(token)
                    check(True, "Tapo verification preset removed", checks)
        elif ptz_name:
            check(False, "Tapo account is required for --ptz-name", checks)
        else:
            print("  SKIP Tapo account is not configured")
    except (robotics.Rejected, arm.DeviceError, ValueError) as error:
        print("verify_robotics_hardware: FAILED:", error, file=sys.stderr)
        return 1
    detail = "PTZ preset cycle" if ptz_name else "read-only"
    print(f"verify_robotics_hardware: live {detail} checks OK ({checks[0]} checks; no arm motion)")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="read the current real HQ configuration")
    parser.add_argument("--root", default=str(ROOT), help="HQ project root for --live")
    parser.add_argument("--ptz-name", default="",
                        help="with --live, save, recall and remove one Tapo preset (moves the camera)")
    args = parser.parse_args(argv)
    if args.ptz_name and not args.live:
        parser.error("--ptz-name requires --live")
    return live_check(args.root, args.ptz_name) if args.live else fake_check()


if __name__ == "__main__":
    raise SystemExit(main())
