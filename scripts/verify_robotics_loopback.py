#!/usr/bin/env python3
"""Loopback end-to-end checks for the Robotique hardware paths.

Starts a local E-stop monitor and a local ONVIF PTZ endpoint on 127.0.0.1,
then drives the real `HttpEstop`, `Ptz` and `Robotics` preview/arm code against
them. A fake arm/camera supplies the non-network hardware side. No physical
device is needed.

Covered:
- E-stop closed, open, wrong/missing token, malformed body, timeout and refused
  connection, including the controller's `healthy:false` and arm refusal.
- Hardware-mode keep-out preview using real feedback state; no arm command.
- Tapo preset list/save/recall/delete against a loopback ONVIF server, plus
  malformed/fault/HTTP-error replies and a bad camera password.

Usage:
    python scripts/verify_robotics_loopback.py
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import socket
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_robotics as robotics  # noqa: E402
import hq_robotics_arm as arm  # noqa: E402
from hq_robotics_estop import HttpEstop  # noqa: E402
from hq_robotics_ptz import Ptz  # noqa: E402
from tests.test_hq_robotics import FakeArm, FakeCamera  # noqa: E402


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


@contextmanager
def serve(handler):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=2)


def unused_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class EstopHandler(BaseHTTPRequestHandler):
    state = {"closed": True, "token": "loop-secret", "delay": 0.0, "reply": None,
             "status": 200, "seen": []}

    def log_message(self, *_):
        pass

    def send_body(self, status, body, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    def do_GET(self):
        state = self.state
        state["seen"].append({"path": self.path,
                              "token": self.headers.get("X-HQ-Estop-Token")})
        if self.path != "/estop":
            self.send_body(404, b'{"error":"route"}')
            return
        if state["token"] is not None and self.headers.get("X-HQ-Estop-Token") != state["token"]:
            self.send_body(401, b'{"error":"token"}')
            return
        if state["delay"]:
            time.sleep(state["delay"])
        if state["status"] != 200:
            self.send_body(state["status"], b'{"error":"refused"}')
            return
        body = state["reply"] if state["reply"] is not None else json.dumps(
            {"closed": state["closed"]}).encode()
        self.send_body(200, body)


class OnvifHandler(BaseHTTPRequestHandler):
    state = {"presets": {"wide": "Vue large"}, "user": "viewer", "password": "secret",
             "mode": "ok", "delay": 0.0, "fault_verb": "", "seen": [], "paths": []}

    def log_message(self, *_):
        pass

    def send_body(self, status, body, content_type="application/soap+xml; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except OSError:
            pass

    @staticmethod
    def envelope(inner):
        return ('<?xml version="1.0" encoding="utf-8"?>'
                '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
                f'<s:Body>{inner}</s:Body></s:Envelope>').encode()

    def fault(self):
        self.send_body(200, self.envelope(
            '<s:Fault><s:Code><s:Value>s:Receiver</s:Value></s:Code>'
            '<s:Reason><s:Text xml:lang="en">fixture fault</s:Text></s:Reason></s:Fault>'))

    def auth_ok(self, root):
        fields = {local_name(element.tag): element.text
                  for element in root.iter() if element.text}
        if fields.get("Username") != self.state["user"] or not fields.get("Password"):
            return False
        try:
            nonce = base64.b64decode(fields["Nonce"])
            expected = base64.b64encode(hashlib.sha1(
                nonce + fields["Created"].encode() + self.state["password"].encode()).digest()).decode()
        except (KeyError, TypeError, ValueError):
            return False
        return fields["Password"] == expected

    def do_POST(self):
        state = self.state
        raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        state["paths"].append(self.path)
        if state["delay"]:
            time.sleep(state["delay"])
        if state["mode"] == "malformed":
            self.send_body(200, b"<r")
            return
        if state["mode"] == "fault":
            self.fault()
            return
        if state["mode"] == "http500":
            self.send_body(500, b"<r><Fault/></r>")
            return
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            self.send_body(400, b"<r/>")
            return
        body = next((element for element in root.iter() if local_name(element.tag) == "Body"), None)
        operation = next(iter(body), None) if body is not None else None
        verb = local_name(operation.tag) if operation is not None else ""
        state["seen"].append(verb)
        if state["mode"] != "ok":
            self.fault()
            return
        if verb != "GetSystemDateAndTime" and not self.auth_ok(root):
            self.send_body(401, b"<r><NotAuthorized/></r>")
            return
        if state["fault_verb"] == verb:
            self.fault()
            return
        if verb == "GetSystemDateAndTime":
            now = datetime.now(timezone.utc)
            inner = ('<GetSystemDateAndTimeResponse><UTCDateTime><Time>'
                     f'<Hour>{now.hour}</Hour><Minute>{now.minute}</Minute><Second>{now.second}</Second>'
                     f'</Time><Date><Year>{now.year}</Year><Month>{now.month}</Month><Day>{now.day}</Day>'
                     '</Date></UTCDateTime></GetSystemDateAndTimeResponse>')
        elif verb == "GetCapabilities":
            inner = ('<GetCapabilitiesResponse><Capabilities><Media>'
                     '<XAddr>http://127.0.0.1/onvif/service</XAddr></Media><PTZ>'
                     '<XAddr>http://127.0.0.1/onvif/service</XAddr></PTZ>'
                     '</Capabilities></GetCapabilitiesResponse>')
        elif verb == "GetProfiles":
            inner = '<GetProfilesResponse><Profiles token="profile_1" fixed="true"><Name>x</Name></Profiles></GetProfilesResponse>'
        elif verb == "GetPresets":
            inner = '<GetPresetsResponse>' + ''.join(
                f'<Preset token="{token}"><Name>{name}</Name></Preset>'
                for token, name in state["presets"].items()) + '</GetPresetsResponse>'
        elif verb == "SetPreset":
            name = next((element.text for element in root.iter()
                         if local_name(element.tag) == "PresetName"), "")
            token = "preset_loop"
            if not name:
                self.fault()
                return
            state["presets"][token] = name
            inner = f'<SetPresetResponse><Preset token="{token}"/></SetPresetResponse>'
        elif verb == "GotoPreset":
            token = next((element.text for element in root.iter()
                          if local_name(element.tag) == "PresetToken"), "")
            if token not in state["presets"]:
                self.fault()
                return
            inner = '<GotoPresetResponse/>'
        elif verb == "RemovePreset":
            token = next((element.text for element in root.iter()
                          if local_name(element.tag) == "PresetToken"), "")
            state["presets"].pop(token, None)
            inner = '<RemovePresetResponse/>'
        else:
            self.fault()
            return
        self.send_body(200, self.envelope(inner))


def check(condition, label, checks):
    checks[0] += 1
    if not condition:
        raise AssertionError(label)
    print("  OK", label)


def controller_checks(port, checks):
    with tempfile.TemporaryDirectory(prefix="hq-robotics-loopback-") as temp:
        now = [100.0]
        fake = FakeArm()
        fake.follow = True
        lab = robotics.Robotics(Path(temp), clock=lambda: now[0],
                                arm_factory=lambda *_: fake, camera=FakeCamera())
        lab.stream_threaded = False
        lab.stream_sleep = lambda seconds: now.__setitem__(0, now[0] + seconds)

        def call(action, data=None, method="POST"):
            return lab.dispatch(action, method, data or {}, "loopback", local=True,
                                physical=True, authorized=lambda: True)

        blocked = {**arm.HOME, "base": 4}
        point = arm.position(blocked)
        zone = {"name": "Boucle locale",
                "x": [max(arm.WORKSPACE["x"][0], point["x"] - 30),
                      min(arm.WORKSPACE["x"][1], point["x"] + 30)],
                "y": [max(arm.WORKSPACE["y"][0], point["y"] - 30),
                      min(arm.WORKSPACE["y"][1], point["y"] + 30)],
                "z": [max(arm.WORKSPACE["z"][0], point["z"] - 30),
                      min(arm.WORKSPACE["z"][1], point["z"] + 30)]}
        call("settings", {
            "mode": "hardware", "arm_ip": "192.168.4.15", "camera_required": False,
            "estop_ip": "127.0.0.1", "estop_port": port, "estop_token": "loop-secret",
            "estop_required": True, "keepout": [zone],
        })
        cfg = lab.config()
        lab.write(lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        call("telemetry")
        status = call("status", method="GET")
        check(status["estop"] == {"mode": "hardware", "healthy": True},
              "live E-stop read returns healthy", checks)
        entries = call("blackbox", method="GET")["entries"]
        check(entries[0]["estop"] == {"mode": "hardware", "healthy": True},
              "black box records the live E-stop", checks)
        lease = call("arm")["lease"]
        check(bool(lease), "healthy live monitor allows arming", checks)
        ticket = call("status", {"lease": lease}, method="GET")["ticket"]
        before = [entry for entry in fake.calls if entry[0] == "move"]
        try:
            call("preview", {"kind": "joints", "pose": blocked})
            raise AssertionError("keep-out preview was accepted")
        except robotics.Rejected as error:
            check(error.code == "robotics_keepout", "live keep-out preview refuses a target", checks)
        after = [entry for entry in fake.calls if entry[0] == "move"]
        check(before == after == [], "keep-out preview sends no arm command", checks)
        call("cancel", {"lease": lease})

        # Open contact: status must be false and a fresh arm must be refused.
        EstopHandler.state["closed"] = False
        now[0] += 1.1
        check(call("status", method="GET")["estop"]["healthy"] is False,
              "open contact is visible as healthy:false", checks)
        entries = call("blackbox", method="GET")["entries"]
        check(entries[0]["estop"] == {"mode": "hardware", "healthy": False},
              "black box records the open E-stop", checks)
        try:
            call("arm")
            raise AssertionError("open contact allowed arming")
        except robotics.Rejected as error:
            check(error.code == "robotics_estop", "open contact refuses arming", checks)

        # Bad token when the monitor requires one.
        EstopHandler.state["closed"] = True
        EstopHandler.state["token"] = "rotated"
        now[0] += .6
        check(call("status", method="GET")["estop"]["healthy"] is False,
              "wrong token is healthy:false", checks)
        try:
            call("arm")
            raise AssertionError("wrong token allowed arming")
        except robotics.Rejected as error:
            check(error.code == "robotics_estop", "wrong token refuses arming", checks)
        EstopHandler.state["token"] = "loop-secret"

        # Malformed monitor body.
        EstopHandler.state["reply"] = b"{"
        now[0] += .6
        check(call("status", method="GET")["estop"]["healthy"] is False,
              "malformed monitor body is healthy:false", checks)
        EstopHandler.state["reply"] = None

        # Server-side delay beyond the monitor timeout.
        EstopHandler.state["delay"] = .6
        now[0] += .6
        started = time.monotonic()
        check(call("status", method="GET")["estop"]["healthy"] is False,
              "timed-out monitor is healthy:false", checks)
        elapsed = time.monotonic() - started
        check(elapsed < 1.2, "timed-out monitor returns bounded", checks)
        EstopHandler.state["delay"] = 0

        # Refused connection.
        closed_port = unused_port()
        call("settings", {"estop_port": closed_port})
        cfg = lab.config()
        lab.write(lab.commission_path, {"revision": cfg["revision"], "profile": robotics.PROFILE})
        now[0] += .3
        call("telemetry")
        started = time.monotonic()
        check(call("status", method="GET")["estop"]["healthy"] is False,
              "unreachable monitor is healthy:false", checks)
        check(time.monotonic() - started < 1.2, "unreachable monitor returns bounded", checks)
        try:
            call("arm")
            raise AssertionError("unreachable monitor allowed arming")
        except robotics.Rejected as error:
            check(error.code == "robotics_estop", "unreachable monitor refuses arming", checks)

        try:
            HttpEstop("127.0.0.1", port, "", .3).read()
            raise AssertionError("missing token was accepted")
        except arm.DeviceError as error:
            check("refusé" in str(error), "missing token is refused", checks)


def ptz_checks(port, checks):
    state = OnvifHandler.state
    state.update({"presets": {"wide": "Vue large"}, "mode": "ok", "seen": [], "paths": []})
    control = Ptz("127.0.0.1", "viewer", "secret", .5, port=port)
    presets = control.presets()
    check(presets == [{"token": "wide", "name": "Vue large"}], "ONVIF preset list", checks)
    saved = control.save_preset("Vue vérif")
    check(saved["token"] == "preset_loop", "ONVIF preset save", checks)
    check(state["presets"].get("preset_loop") == "Vue vérif", "ONVIF preset stored", checks)
    control.goto_preset(saved["token"])
    check("GotoPreset" in state["seen"], "ONVIF preset recall", checks)
    control.delete_preset(saved["token"])
    check(saved["token"] not in state["presets"], "ONVIF preset delete removes it", checks)
    check(control.presets() == [{"token": "wide", "name": "Vue large"}],
          "ONVIF original remains and temporary preset is gone", checks)

    state["mode"] = "fault"
    try:
        control.presets()
        raise AssertionError("SOAP fault was silently accepted")
    except arm.DeviceError as error:
        check("erreur" in str(error), "SOAP fault is refused", checks)
    state["mode"] = "malformed"
    try:
        control.presets()
        raise AssertionError("malformed ONVIF reply was silently accepted")
    except arm.DeviceError as error:
        check("invalide" in str(error), "malformed ONVIF reply is refused", checks)
    state["mode"] = "http500"
    try:
        control.presets()
        raise AssertionError("HTTP 500 was silently accepted")
    except arm.DeviceError:
        check(True, "ONVIF HTTP error is refused", checks)
    state["mode"] = "ok"
    state["fault_verb"] = "GetCapabilities"
    try:
        Ptz("127.0.0.1", "viewer", "secret", .5, port=port).presets()
        raise AssertionError("capabilities SOAP fault was silently accepted")
    except arm.DeviceError as error:
        check("erreur" in str(error), "capabilities SOAP fault is refused", checks)
    state["fault_verb"] = ""
    try:
        Ptz("127.0.0.1", "viewer", "wrong", .5, port=port).presets()
        raise AssertionError("wrong camera password was accepted")
    except arm.DeviceError as error:
        check("refusé" in str(error), "wrong camera password is refused", checks)

    state["delay"] = .6
    control.timeout = .1
    started = time.monotonic()
    try:
        control.presets()
        raise AssertionError("timed-out ONVIF request succeeded")
    except arm.DeviceError as error:
        check("injoignable" in str(error), "ONVIF timeout is refused", checks)
        check(time.monotonic() - started < 1.2, "ONVIF timeout returns bounded", checks)
    finally:
        control.timeout = .5
        state["delay"] = 0

    closed_port = unused_port()
    try:
        Ptz("127.0.0.1", "viewer", "secret", .2, port=closed_port).presets()
        raise AssertionError("unreachable ONVIF endpoint succeeded")
    except arm.DeviceError as error:
        check("injoignable" in str(error), "unreachable ONVIF endpoint is refused", checks)


def main():
    checks = [0]
    EstopHandler.state.update({"closed": True, "token": "loop-secret", "delay": 0,
                               "reply": None, "status": 200, "seen": []})
    try:
        with serve(EstopHandler) as estop_port, serve(OnvifHandler) as onvif_port:
            print("loopback E-stop: controller and monitor")
            controller_checks(estop_port, checks)
            print("loopback ONVIF: Tapo presets")
            ptz_checks(onvif_port, checks)
    except (AssertionError, OSError, arm.DeviceError, robotics.Rejected, ValueError) as error:
        print("verify_robotics_loopback: FAILED:", error, file=sys.stderr)
        return 1
    print(f"verify_robotics_loopback: OK ({checks[0]} checks; no physical hardware)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
