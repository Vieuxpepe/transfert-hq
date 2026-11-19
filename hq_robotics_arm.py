"""RoArm-M2-S geometry and the fixed Waveshare HTTP transport.

Model: waveshareteam/roarm_m2 c6ccc5b, stock gripper (EEMode 0).
Angles at the HQ boundary are degrees in the firmware convention.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes
import http.client
import ipaddress
import json
import math
import os
import re
import socket
import time
from urllib.parse import quote

JOINTS = ("base", "shoulder", "elbow", "hand")
HOME = dict(zip(JOINTS, (0.0, 0.0, 90.0, 180.0)))
# Deliberately narrower than the firmware's servo clamps.
LIMITS = dict(zip(JOINTS, ((-80, 80), (-55, 55), (-25, 155), (70, 260))))
WORKSPACE = {"x": (45, 500), "y": (-450, 450), "z": (25, 490)}
UPPER = math.hypot(236.82, 30.0)
LOWER = math.hypot(280.15, 1.73)
OFFSET = math.atan2(30.0, 236.82)
PRIVATE = tuple(ipaddress.IPv4Network(cidr) for cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


class DeviceError(Exception):
    """Only fixed, safe messages cross the transport boundary."""


def number(value, low, high):
    if type(value) not in (int, float) or not low <= value <= high:
        raise ValueError("Valeur hors limites ou non numérique")
    return float(value)


def device_ip(value):
    """Resolve once at configuration time. Persist the pinned IPv4, never a URL."""
    if not isinstance(value, str) or not value or len(value) > 253:
        raise ValueError("Adresse locale invalide")
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", value):
        raise ValueError("Adresse locale invalide")
    try:
        addresses = {ipaddress.IPv4Address(value)}
    except ValueError:
        try:
            addresses = {ipaddress.IPv4Address(row[4][0])
                         for row in socket.getaddrinfo(value, None, socket.AF_INET, socket.SOCK_STREAM)}
        except OSError:
            raise ValueError("Adresse locale introuvable") from None
    if len(addresses) != 1:
        raise ValueError("Une seule adresse IPv4 locale est requise")
    return pinned_ip(str(addresses.pop()))


def pinned_ip(value, *, allow_loopback=False):
    try:
        address = ipaddress.IPv4Address(value)
    except (ValueError, TypeError):
        raise ValueError("Adresse IPv4 locale requise") from None
    if not any(address in network for network in PRIVATE) and not (allow_loopback and address.is_loopback):
        raise ValueError("Adresse IPv4 privée requise")
    return str(address)


def private_peer(value):
    try:
        pinned_ip(value)
    except ValueError:
        return False
    return True


def position(pose):
    base, shoulder, elbow, _hand = map(math.radians, (pose[k] for k in JOINTS))
    # Mode 0 reports the gripper reference point relative to the shoulder axis.
    r = UPPER * math.sin(shoulder + OFFSET) + LOWER * math.sin(shoulder + elbow)
    z = UPPER * math.cos(shoulder + OFFSET) + LOWER * math.cos(shoulder + elbow)
    return {"x": r * math.cos(base), "y": r * math.sin(base), "z": z, "t": pose["hand"]}


def link_positions(pose):
    """Return 3D coordinates (mm) for shoulder, elbow, and TCP gripper reference."""
    base, shoulder, elbow, _hand = map(math.radians, (pose[k] for k in JOINTS))
    cb, sb = math.cos(base), math.sin(base)
    r_elbow = UPPER * math.sin(shoulder + OFFSET)
    z_elbow = UPPER * math.cos(shoulder + OFFSET)
    r_tcp = r_elbow + LOWER * math.sin(shoulder + elbow)
    z_tcp = z_elbow + LOWER * math.cos(shoulder + elbow)
    return {
        "shoulder": {"x": 0.0, "y": 0.0, "z": 0.0},
        "elbow": {"x": r_elbow * cb, "y": r_elbow * sb, "z": z_elbow},
        "tcp": {"x": r_tcp * cb, "y": r_tcp * sb, "z": z_tcp},
    }


def _point_to_aabb_distance(pt, box):
    dx = max(box["x"][0] - pt["x"], 0.0, pt["x"] - box["x"][1])
    dy = max(box["y"][0] - pt["y"], 0.0, pt["y"] - box["y"][1])
    dz = max(box["z"][0] - pt["z"], 0.0, pt["z"] - box["z"][1])
    return math.sqrt(dx * dx + dy * dy + dz * dz)


def _segment_to_aabb_distance(p0, p1, box):
    """Exact minimum Euclidean distance from 3D segment [p0, p1] to axis-aligned box."""
    axes = ("x", "y", "z")
    d = {a: p1[a] - p0[a] for a in axes}
    breakpoints = {0.0, 1.0}
    for a in axes:
        if d[a]:
            for bound in box[a]:
                t = (bound - p0[a]) / d[a]
                if 0.0 < t < 1.0:
                    breakpoints.add(t)
    pts = sorted(breakpoints)
    best_sq = math.inf
    for i in range(len(pts) - 1):
        t0, t1 = pts[i], pts[i + 1]
        tm = 0.5 * (t0 + t1)
        qa = 0.0
        qb = 0.0
        qc = 0.0
        for a in axes:
            pm = p0[a] + tm * d[a]
            lo, hi = box[a]
            if pm < lo:
                diff0 = p0[a] - lo
                qa += d[a] * d[a]
                qb += 2.0 * diff0 * d[a]
                qc += diff0 * diff0
            elif pm > hi:
                diff0 = p0[a] - hi
                qa += d[a] * d[a]
                qb += 2.0 * diff0 * d[a]
                qc += diff0 * diff0
        candidates = (t0, t1)
        if qa > 1e-12:
            t_star = -qb / (2.0 * qa)
            if t0 < t_star < t1:
                candidates = (t0, t_star, t1)
        for tc in candidates:
            val = qa * tc * tc + qb * tc + qc
            if val < best_sq:
                best_sq = val
                if best_sq <= 0.0:
                    return 0.0
    return math.sqrt(max(0.0, best_sq))


GRIPPER_LENGTH = 62.0   # gripper housing and fingers, back from the reference point along the forearm
GRIPPER_EXTRA = 12.0    # fingers reach ~34 mm sideways: link radius 22 + 12
SHOULDER_RADIUS = 50.0  # shoulder block and top of the turret, around the shoulder axis
SHAPE_MARGIN = 40.0     # extra reach of these shapes, added to the arc-length bound below


def _pose_link_clearance(pose, zones, link_radius):
    links = link_positions(pose)
    elbow, tcp = links["elbow"], links["tcp"]
    span = math.sqrt(sum((tcp[a] - elbow[a]) ** 2 for a in "xyz")) or 1.0
    back = min(GRIPPER_LENGTH, span) / span
    wrist = {a: tcp[a] - (tcp[a] - elbow[a]) * back for a in "xyz"}
    best = math.inf
    hit = None
    nearest = None
    nearest_dist = math.inf
    for zone in zones:
        d_upper = _segment_to_aabb_distance(links["shoulder"], links["elbow"], zone) - link_radius
        d_lower = _segment_to_aabb_distance(links["elbow"], links["tcp"], zone) - link_radius
        d_grip = _segment_to_aabb_distance(wrist, tcp, zone) - (link_radius + GRIPPER_EXTRA)
        d_shoulder = _point_to_aabb_distance(links["shoulder"], zone) - SHOULDER_RADIUS
        c = min(d_upper, d_lower, d_grip, d_shoulder)
        if c < nearest_dist:
            nearest_dist = c
            nearest = zone["name"]
        if c < best:
            best = c
            if c <= 0.0:
                hit = zone["name"]
    return best, hit, nearest


def swept_clearance(start, end, zones, *, link_radius=22.0):
    """Conservative continuous capsule-to-keepout clearance (mm) using adaptive subdivision.

    Fails closed (clearance_uncertain=True) if any terminal interval still allows
    a collision within its arc-length bound.
    """
    if not zones:
        return {"min_clearance_mm": None, "collision_zone": None, "clearance_uncertain": False}
    delta = {key: end[key] - start[key] for key in JOINTS}

    def pose_at(t):
        return {key: start[key] + t * delta[key] for key in JOINTS}

    def arc_bound(dt):
        return math.radians(
            (UPPER + LOWER + SHAPE_MARGIN) * (abs(delta["base"]) + abs(delta["shoulder"])) * dt
            + (LOWER + SHAPE_MARGIN) * abs(delta["elbow"]) * dt
        )

    min_clearance = math.inf
    collision_zone = None
    uncertain = False

    for endpoint in (start, end):
        c, hit, _ = _pose_link_clearance(endpoint, zones, link_radius)
        if c < min_clearance:
            min_clearance = c
        if hit and collision_zone is None:
            collision_zone = hit

    stack = [(0.0, 1.0, 0)]
    while stack:
        t0, t1, depth = stack.pop()
        tm = 0.5 * (t0 + t1)
        c_mid, hit, nearest = _pose_link_clearance(pose_at(tm), zones, link_radius)
        if c_mid < min_clearance:
            min_clearance = c_mid
        if hit and collision_zone is None:
            collision_zone = hit
        if c_mid <= 0.0:
            continue
        half_arc = 0.5 * arc_bound(t1 - t0)
        lower_bound = c_mid - half_arc
        if lower_bound > 0.0:
            continue
        if half_arc > 0.125 and depth < 14:
            stack.append((t0, tm, depth + 1))
            stack.append((tm, t1, depth + 1))
        else:
            uncertain = True
            if lower_bound < min_clearance:
                min_clearance = lower_bound
            if collision_zone is None:
                collision_zone = nearest

    return {
        "min_clearance_mm": round(min_clearance, 2) if math.isfinite(min_clearance) else None,
        "collision_zone": collision_zone,
        "clearance_uncertain": uncertain,
    }


def async_box_clearance(start, end, zones, *, link_radius=22.0):
    """Conservative full-link clearance over the entire asynchronous joint box [start, end]."""
    if not zones:
        return {"min_clearance_mm": None, "collision_zone": None, "clearance_uncertain": False}
    box = {k: (min(start[k], end[k]), max(start[k], end[k])) for k in JOINTS}
    min_clearance = math.inf
    collision_zone = None
    uncertain = False

    for b in box["base"]:
        for s in box["shoulder"]:
            for e in box["elbow"]:
                for h in box["hand"]:
                    c, hit, _ = _pose_link_clearance({"base": b, "shoulder": s, "elbow": e, "hand": h}, zones, link_radius)
                    if c < min_clearance:
                        min_clearance = c
                    if hit and collision_zone is None:
                        collision_zone = hit
                    if collision_zone is not None:
                        return {
                            "min_clearance_mm": round(min_clearance, 2),
                            "collision_zone": collision_zone,
                            "clearance_uncertain": False,
                        }

    stack = [(box, 0)]
    while stack:
        cur, depth = stack.pop()
        mid = {k: 0.5 * (cur[k][0] + cur[k][1]) for k in JOINTS}
        c_mid, hit, nearest = _pose_link_clearance(mid, zones, link_radius)
        if c_mid < min_clearance:
            min_clearance = c_mid
        if hit and collision_zone is None:
            collision_zone = hit
        if c_mid <= 0.0:
            continue
        spans = {k: cur[k][1] - cur[k][0] for k in JOINTS}
        half_arc = 0.5 * math.radians(
            (UPPER + LOWER + SHAPE_MARGIN) * (spans["base"] + spans["shoulder"])
            + (LOWER + SHAPE_MARGIN) * spans["elbow"]
        )
        lower_bound = c_mid - half_arc
        if lower_bound > 0.0:
            continue
        widest = max(("base", "shoulder", "elbow"), key=lambda k: spans[k])
        if spans[widest] > 0.25 and depth < 10:
            m = mid[widest]
            left = {**cur, widest: (cur[widest][0], m)}
            right = {**cur, widest: (m, cur[widest][1])}
            stack.append((left, depth + 1))
            stack.append((right, depth + 1))
        else:
            uncertain = True
            if lower_bound < min_clearance:
                min_clearance = lower_bound
            if collision_zone is None:
                collision_zone = nearest

    return {
        "min_clearance_mm": round(min_clearance, 2) if math.isfinite(min_clearance) else None,
        "collision_zone": collision_zone,
        "clearance_uncertain": uncertain,
    }


def validate_pose(raw, limits, workspace):
    if not isinstance(raw, dict) or set(raw) != set(JOINTS):
        raise ValueError("Quatre angles articulaires sont requis")
    pose = {key: number(raw[key], *limits[key]) for key in JOINTS}
    xyz = position(pose)
    for axis, bounds in workspace.items():
        number(xyz[axis], *bounds)
    return pose


def cartesian(raw, limits, workspace):
    if not isinstance(raw, dict) or set(raw) != {"x", "y", "z", "t"}:
        raise ValueError("X, Y, Z et angle de pince sont requis")
    x, y, z = (number(raw[key], *workspace[key]) for key in ("x", "y", "z"))
    hand = number(raw["t"], *limits["hand"])
    r = math.hypot(x, y)
    c = (r*r + z*z - UPPER*UPPER - LOWER*LOWER) / (2 * UPPER * LOWER)
    if not -1 < c < 1:
        raise ValueError("Position inaccessible ou singulière")
    # Same elbow branch as the stock Waveshare gripper-mode IK.
    delta = math.acos(c)
    shoulder = math.atan2(r, z) - math.atan2(LOWER * math.sin(delta), UPPER + LOWER*c) - OFFSET
    pose = dict(zip(JOINTS, (math.degrees(math.atan2(y, x)), math.degrees(shoulder),
                             math.degrees(delta + OFFSET), hand)))
    return validate_pose(pose, limits, workspace)


def validate_path(start, end, limits, workspace, *, independent_axes=False):
    validate_pose(start, limits, workspace)
    validate_pose(end, limits, workspace)
    delta = {key: end[key] - start[key] for key in JOINTS}
    # Bound reference-point displacement by the sum of the affected link arcs.
    motion = math.radians((UPPER + LOWER) * (abs(delta["base"]) + abs(delta["shoulder"]))
                          + LOWER * abs(delta["elbow"]))
    if independent_axes:
        # Servo axes can arrive at different times. Their whole joint box lies
        # within half the arc bound of its midpoint, even with asynchronous axes.
        samples = 1
    else:
        samples = max(1, math.ceil(motion / 4))
    margin = motion / (2 * samples)
    for index in range(samples):
        t = (index + .5) / samples
        point = position({key: start[key] + t * delta[key] for key in JOINTS})
        for axis, (low, high) in workspace.items():
            number(point[axis], low + margin, high - margin)


def validate_async_box(start, end, limits, workspace):
    """Validate asynchronous joint-axis extremes across the [start, end] joint box."""
    validate_pose(start, limits, workspace)
    validate_pose(end, limits, workspace)
    for b in (start["base"], end["base"]):
        for s in (start["shoulder"], end["shoulder"]):
            for e in (start["elbow"], end["elbow"]):
                for h in (start["hand"], end["hand"]):
                    validate_pose({"base": b, "shoulder": s, "elbow": e, "hand": h}, limits, workspace)


def serial_port_name(value):
    """Validate and normalize a local serial port name (COM1..COM256 or /dev/ttyUSB*|ACM*)."""
    if not isinstance(value, str):
        raise ValueError("Port série invalide")
    cleaned = value.strip()
    match = re.fullmatch(r"COM([1-9]\d{0,2})", cleaned, re.IGNORECASE)
    if match and 1 <= int(match.group(1)) <= 256:
        return f"COM{int(match.group(1))}"
    if os.name != "nt" and re.fullmatch(r"/dev/tty(?:USB|ACM)\d{1,3}", cleaned):
        return cleaned
    raise ValueError("Port série invalide")


def list_serial_ports():
    """Return active local serial port names (e.g. ['COM3']) via stdlib winreg on Windows."""
    if os.name != "nt":
        return []
    try:
        import winreg
        ports = []
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DEVICEMAP\SERIALCOMM") as key:
            idx = 0
            while True:
                try:
                    _, val, _ = winreg.EnumValue(key, idx)
                    idx += 1
                    try:
                        ports.append(serial_port_name(str(val)))
                    except ValueError:
                        pass
                except OSError:
                    break
        return sorted(set(ports), key=lambda p: (len(p), p))
    except OSError:
        return []


def _parse_roarm_feedback(raw):
    """Validate and convert a T:1051 RoArm-M2-S telemetry dict."""
    try:
        if raw.get("T") != 1051:
            raise ValueError
        pose = {key: math.degrees(number(raw[field], -math.tau, math.tau))
                for key, field in zip(JOINTS, ("b", "s", "e", "t"))}
        xyz = {key: number(raw[key], -700, 700) for key in ("x", "y", "z")}
        predicted = position(pose)
        if any(abs(xyz[key] - predicted[key]) > 5 for key in xyz):
            raise ValueError
        loads = {key: number(raw[field], -32768, 32767)
                 for key, field in zip(JOINTS, ("torB", "torS", "torE", "torH")) if field in raw}
        torque = {}
        for key, field in zip(JOINTS, ("torswitchB", "torswitchS", "torswitchE", "torswitchH")):
            if field in raw:
                if type(raw[field]) is not int or raw[field] not in (0, 1):
                    raise ValueError
                torque[key] = raw[field]
        if not torque:
            torque_state = "unknown"
        elif set(torque) != set(JOINTS):
            torque_state = "partial"
        elif all(value == 1 for value in torque.values()):
            torque_state = "enabled"
        else:
            torque_state = "disabled"
        volts = number(raw["v"], 1, 3000) / 100 if "v" in raw else None
    except (KeyError, ValueError):
        raise DeviceError("Télémétrie incompatible avec le profil RoArm M2-S pince") from None
    return {"source": "hardware", "actual": pose, "xyz": xyz, "load": loads, "torque": torque,
            "torque_state": torque_state, "voltage": volts}


class _RoArmProtocol:
    """Shared RoArm-M2-S JSON command layer across HTTP and Serial transports."""

    def feedback(self):
        return _parse_roarm_feedback(self._command({"T": 105}))

    def move(self, pose, speed, acceleration):
        if self._command({"T": 102, **{key: math.radians(pose[key]) for key in JOINTS},
                          "spd": speed, "acc": acceleration}):
            raise DeviceError("Réponse inattendue à la commande RoArm")

    def set_torque(self, enabled):
        """Enable or release servo torque without tripping an emergency latch."""
        if self._command({"T": 210, "cmd": 1 if enabled else 0}):
            raise DeviceError("Réponse inattendue à la commande de couple RoArm")

    def emergency_stop(self):
        # T:0 re-enables torque after ten seconds in the reference firmware.
        # T:210 cmd:0 requests torque release without that timed re-enable.
        if self._command({"T": 210, "cmd": 0}):
            raise DeviceError("Réponse inattendue à la demande de coupure du couple")


class HttpArm(_RoArmProtocol):
    """Replaceable device adapter. HTTP success is transport receipt only."""

    def __init__(self, address, timeout):
        self.address = pinned_ip(address)
        self.timeout = timeout
        self._conn = None

    def close(self):
        if self._conn is not None:
            try:
                self._conn.close()
            except OSError:
                pass
            self._conn = None

    def _command(self, data, timeout=None):
        budget = timeout or self.timeout
        deadline = time.monotonic() + budget
        command = quote(json.dumps(data, separators=(",", ":")), safe="")
        for attempt in range(2):
            reused = self._conn is not None
            connection = self._conn if reused else http.client.HTTPConnection(self.address, 80, timeout=budget)
            self._conn = connection
            try:
                connection.timeout = budget
                connection.request("GET", "/js?json=" + command, headers={"Connection": "keep-alive"})
                with connection.getresponse() as response:
                    if response.status != 200:
                        self.close()
                        raise DeviceError("Requête refusée par le RoArm")
                    raw = response.read(4097)
                    if response.will_close:
                        self.close()
                    if len(raw) > 4096 or time.monotonic() >= deadline:
                        self.close()
                        raise DeviceError("Réponse RoArm invalide")
                    # The real firmware acknowledges a command with an empty body or `null`, not `{}`.
                    value = {} if raw.strip() in (b"", b"null") else json.loads(raw)
                    if not isinstance(value, dict):
                        self.close()
                        raise DeviceError("Réponse RoArm invalide")
                    return value
            except DeviceError:
                raise
            except (OSError, ValueError, http.client.HTTPException):
                self.close()
                if reused and attempt == 0 and time.monotonic() < deadline:
                    continue
                raise DeviceError("RoArm indisponible ou réponse invalide") from None


class _Win32DCB(ctypes.Structure):
    _fields_ = [
        ("DCBlength", ctypes.wintypes.DWORD),
        ("BaudRate", ctypes.wintypes.DWORD),
        ("fBinary", ctypes.wintypes.DWORD, 1),
        ("fParity", ctypes.wintypes.DWORD, 1),
        ("fOutxCtsFlow", ctypes.wintypes.DWORD, 1),
        ("fOutxDsrFlow", ctypes.wintypes.DWORD, 1),
        ("fDtrControl", ctypes.wintypes.DWORD, 2),
        ("fDsrSensitivity", ctypes.wintypes.DWORD, 1),
        ("fTXContinueOnXoff", ctypes.wintypes.DWORD, 1),
        ("fOutX", ctypes.wintypes.DWORD, 1),
        ("fInX", ctypes.wintypes.DWORD, 1),
        ("fErrorChar", ctypes.wintypes.DWORD, 1),
        ("fNull", ctypes.wintypes.DWORD, 1),
        ("fRtsControl", ctypes.wintypes.DWORD, 2),
        ("fAbortOnError", ctypes.wintypes.DWORD, 1),
        ("fDummy2", ctypes.wintypes.DWORD, 17),
        ("wReserved", ctypes.wintypes.WORD),
        ("XonLim", ctypes.wintypes.WORD),
        ("XoffLim", ctypes.wintypes.WORD),
        ("ByteSize", ctypes.c_ubyte),
        ("Parity", ctypes.c_ubyte),
        ("StopBits", ctypes.c_ubyte),
        ("XonChar", ctypes.c_char),
        ("XoffChar", ctypes.c_char),
        ("ErrorChar", ctypes.c_char),
        ("EofChar", ctypes.c_char),
        ("EvtChar", ctypes.c_char),
        ("wReserved1", ctypes.wintypes.WORD),
    ]


class _Win32CommTimeouts(ctypes.Structure):
    _fields_ = [
        ("ReadIntervalTimeout", ctypes.wintypes.DWORD),
        ("ReadTotalTimeoutMultiplier", ctypes.wintypes.DWORD),
        ("ReadTotalTimeoutConstant", ctypes.wintypes.DWORD),
        ("WriteTotalTimeoutMultiplier", ctypes.wintypes.DWORD),
        ("WriteTotalTimeoutConstant", ctypes.wintypes.DWORD),
    ]


class _Win32SerialStream:
    """Minimal stdlib Win32 COM port stream (115200 8N1) with no external dependencies."""

    def __init__(self, port, timeout):
        k32 = ctypes.windll.kernel32
        self._k32 = k32
        path = f"\\\\.\\{port}"
        handle = k32.CreateFileW(path, 0xC0000000, 0, None, 3, 0, None)
        if handle in (0, -1, 0xFFFFFFFF, 0xFFFFFFFFFFFFFFFF):
            raise OSError(f"Cannot open {port}")
        self._handle = handle
        try:
            dcb = _Win32DCB()
            dcb.DCBlength = ctypes.sizeof(_Win32DCB)
            if not k32.GetCommState(handle, ctypes.byref(dcb)):
                raise OSError("GetCommState failed")
            dcb.BaudRate = 115200
            dcb.ByteSize = 8
            dcb.Parity = 0
            dcb.StopBits = 0
            dcb.fDtrControl = 1
            dcb.fRtsControl = 1
            if not k32.SetCommState(handle, ctypes.byref(dcb)):
                raise OSError("SetCommState failed")
            ms = max(50, int(timeout * 1000))
            timeouts = _Win32CommTimeouts(50, 0, ms, 0, ms)
            if not k32.SetCommTimeouts(handle, ctypes.byref(timeouts)):
                raise OSError("SetCommTimeouts failed")
            k32.PurgeComm(handle, 0x000F)
        except Exception:
            self.close()
            raise

    def write(self, payload):
        written = ctypes.wintypes.DWORD(0)
        buf = ctypes.create_string_buffer(payload, len(payload))
        if not self._k32.WriteFile(self._handle, buf, len(payload), ctypes.byref(written), None):
            raise OSError("WriteFile failed")
        if written.value != len(payload):
            raise OSError("Short serial write")

    def readline(self, max_bytes=4097):
        chunks = bytearray()
        one = ctypes.create_string_buffer(1)
        read = ctypes.wintypes.DWORD(0)
        while len(chunks) < max_bytes:
            if not self._k32.ReadFile(self._handle, one, 1, ctypes.byref(read), None):
                raise OSError("ReadFile failed")
            if read.value == 0:
                break
            ch = one.raw
            chunks += ch
            if ch == b"\n":
                break
        return bytes(chunks)

    def close(self):
        if self._handle is not None:
            try:
                self._k32.CloseHandle(self._handle)
            except OSError:
                pass
            self._handle = None


class SerialArm(_RoArmProtocol):
    """USB Serial RoArm-M2-S adapter (115200 8N1 newline-delimited JSON)."""

    def __init__(self, port, timeout, *, opener=None):
        self.port = serial_port_name(port)
        self.timeout = timeout
        self._opener = opener
        self._stream = None

    def close(self):
        if self._stream is not None:
            try:
                self._stream.close()
            except OSError:
                pass
            self._stream = None

    def _open_stream(self, budget):
        if self._opener is not None:
            return self._opener(self.port, budget)
        if os.name == "nt":
            return _Win32SerialStream(self.port, budget)
        raise DeviceError("Transport série non supporté sur cet OS")

    def _command(self, data, timeout=None):
        budget = timeout or self.timeout
        deadline = time.monotonic() + budget
        payload = (json.dumps(data, separators=(",", ":")) + "\n").encode("utf-8")
        expect_reply = data.get("T") == 105
        for attempt in range(2):
            reused = self._stream is not None
            try:
                if self._stream is None:
                    self._stream = self._open_stream(budget)
                self._stream.write(payload)
                raw = self._stream.readline(4097)
                if len(raw) > 4096 or time.monotonic() >= deadline:
                    self.close()
                    raise DeviceError("Réponse RoArm invalide")
                stripped = raw.strip()
                if not stripped:
                    if expect_reply:
                        self.close()
                        raise DeviceError("RoArm indisponible ou réponse invalide")
                    return {}
                value = {} if stripped == b"null" else json.loads(stripped)
                if not isinstance(value, dict):
                    self.close()
                    raise DeviceError("Réponse RoArm invalide")
                return value
            except DeviceError:
                raise
            except (OSError, ValueError):
                self.close()
                if reused and attempt == 0 and time.monotonic() < deadline:
                    continue
                raise DeviceError("RoArm indisponible ou réponse invalide") from None
