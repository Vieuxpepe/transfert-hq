#!/usr/bin/env python3
"""Hardware-in-the-loop rehearsal for Robotique without a physical arm.

This drives the real Robotics state machine through the same DISPATCH paths as the
bridge, with a fake arm/camera and injected telemetry faults. It is deliberately
not a substitute for the physical commissioning checklist.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_robotics as robotics  # noqa: E402
import hq_robotics_arm as arm  # noqa: E402
from tests.test_hq_robotics import FakeArm, FakeCamera  # noqa: E402


def main() -> int:
    checks = 0
    with tempfile.TemporaryDirectory(prefix="hq-robotics-hil-") as temp:
        now = [100.0]
        lab = robotics.Robotics(Path(temp), clock=lambda: now[0],
                                arm_factory=lambda *_: FakeArm(), camera=FakeCamera())
        lab.stream_threaded = False
        lab.stream_sleep = lambda seconds: now.__setitem__(0, now[0] + seconds)

        def call(action, data=None, method="POST", session="bench"):
            return lab.dispatch(action, method, data or {}, session, local=True,
                                physical=True, authorized=lambda: True)

        def check(condition, label):
            nonlocal checks
            checks += 1
            if not condition:
                raise AssertionError(label)
            print("  OK", label)

        print("simulation: limits, keep-out and black box", flush=True)
        call("settings", {"keepout": [{"name": "Table", "x": [200, 300],
                                        "y": [80, 220], "z": [25, 300]}]})
        blocked = {**arm.HOME, "base": 20}
        try:
            call("preview", {"kind": "joints", "pose": blocked})
            raise AssertionError("keep-out target was accepted")
        except robotics.Rejected as error:
            check(error.code == "robotics_keepout", "keep-out rejects a target")
        call("settings", {"keepout": [], "load_warn": 600, "load_critical": 850})
        now[0] += 1
        status = call("status", method="GET")
        check(status["config"]["load_warn"] == 600, "load thresholds survive status")
        check(status["estop"]["mode"] == "simulation", "E-stop is explicitly simulated")
        entries = call("blackbox", method="GET")["entries"]
        check(len(entries) >= 1, "black box samples status")
        check(entries[0]["estop"] == {"mode": "simulation", "healthy": True},
              "black box records the simulated E-stop")

        print("simulation: routines and STOP latch", flush=True)
        saved = call("routines", {"action": "save", "name": "Bench",
                                   "steps": [{"kind": "joints", "pose": {**arm.HOME, "base": 2}}]})
        routine = next(iter(saved["routines"]))
        check(saved["routines"][routine]["name"] == "Bench", "routine saved")
        check(call("stop")["stop_latched"], "STOP latches in simulation")
        try:
            call("arm")
            raise AssertionError("arm accepted after STOP")
        except robotics.Rejected:
            check(True, "arm refused until reset")
        call("reset")
        lease = call("arm")["lease"]
        check(bool(lease), "reset allows arm again")
        call("cancel", {"lease": lease})

        print("fake hardware: feedback fault and torque-release stop", flush=True)
        fake = FakeArm()
        fake.follow = True
        lab.arm_factory = lambda *_: fake
        call("settings", {"mode": "hardware", "arm_ip": "192.168.4.15",
                          "camera_required": False})
        cfg = lab.config()
        lab.write(lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        call("telemetry")
        check(call("status", method="GET")["feedback"]["source"] == "hardware", "hardware feedback accepted")
        fake.error = "feedback"
        for _ in range(3):
            now[0] += .3
            try:
                call("telemetry")
            except arm.DeviceError:
                pass
        check(not call("status", method="GET")["armed"], "repeated feedback faults disarm")
        fake.error = None
        now[0] += .3
        call("telemetry")
        lease = call("arm")["lease"]
        check(bool(lease), "re-armed after feedback recovery")
        now[0] += 2.1
        result = call("stop", {"lease": lease})
        check(result.get("stop_result") == "latched", "idle STOP latches without torque release")
        check(result["stop_latched"], "hardware STOP is visible")
        call("reset", {"inspected": True})

    print(f"verify_robotics_hil: OK ({checks} checks; no hardware attached)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
