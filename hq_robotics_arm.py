"""RoArm-M2-S geometry and the fixed Waveshare HTTP transport.

Model: waveshareteam/roarm_m2 c6ccc5b, stock gripper (EEMode 0).
Angles at the HQ boundary are degrees in the firmware convention.
"""

from __future__ import annotations

import http.client
import ipaddress
import json
import math
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


def swept_clearance(start, end, zones, *, link_radius=22.0):
    """Compute minimum capsule-to-keepout clearance (mm) along a joint-space segment."""
    if not zones:
        return {"min_clearance_mm": None, "collision_zone": None}
    delta = {key: end[key] - start[key] for key in JOINTS}
    steps = max(1, math.ceil(max(abs(delta[key]) for key in JOINTS) / 2))
    min_clearance = math.inf
    collision_zone = None
    for index in range(steps + 1):
        t = index / steps
        pose = {key: start[key] + t * delta[key] for key in JOINTS}
        links = link_positions(pose)
        for zone in zones:
            d_upper = _segment_to_aabb_distance(links["shoulder"], links["elbow"], zone) - link_radius
            d_lower = _segment_to_aabb_distance(links["elbow"], links["tcp"], zone) - link_radius
            clearance = min(d_upper, d_lower)
            if clearance < min_clearance:
                min_clearance = clearance
                if clearance <= 0.0:
                    collision_zone = zone["name"]
    return {
        "min_clearance_mm": round(min_clearance, 2) if math.isfinite(min_clearance) else None,
        "collision_zone": collision_zone,
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


class HttpArm:
    """Replaceable device adapter. HTTP success is transport receipt only."""

    def __init__(self, address, timeout):
        self.address = pinned_ip(address)
        self.timeout = timeout

    def _command(self, data, timeout=None):
        budget = timeout or self.timeout
        deadline = time.monotonic() + budget
        connection = http.client.HTTPConnection(self.address, 80, timeout=budget)
        try:
            command = quote(json.dumps(data, separators=(",", ":")), safe="")
            connection.request("GET", "/js?json=" + command, headers={"Connection": "close"})
            with connection.getresponse() as response:
                if response.status != 200:
                    raise DeviceError("Requête refusée par le RoArm")
                raw = response.read(4097)
                if len(raw) > 4096 or time.monotonic() >= deadline:
                    raise DeviceError("Réponse RoArm invalide")
                # The real firmware acknowledges a command with an empty body or `null`, not `{}`.
                value = {} if raw.strip() in (b"", b"null") else json.loads(raw)
                if not isinstance(value, dict):
                    raise DeviceError("Réponse RoArm invalide")
                return value
        except (OSError, ValueError, http.client.HTTPException):
            raise DeviceError("RoArm indisponible ou réponse invalide") from None
        finally:
            connection.close()

    def feedback(self):
        raw = self._command({"T": 105})
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

    def move(self, pose, speed, acceleration):
        if self._command({"T": 102, **{key: math.radians(pose[key]) for key in JOINTS},
                          "spd": speed, "acc": acceleration}):
            raise DeviceError("Réponse inattendue à la commande RoArm")

    def emergency_stop(self):
        # T:0 re-enables torque after ten seconds in the reference firmware.
        # T:210 cmd:0 requests torque release without that timed re-enable.
        if self._command({"T": 210, "cmd": 0}):
            raise DeviceError("Réponse inattendue à la demande de coupure du couple")
