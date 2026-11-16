"""Transfert HQ Robotics state machine. The bridge supplies auth and HTTP framing."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import json
import logging
import math
from pathlib import Path
import re
import secrets
import threading
import time

import hq_state
from hq_robotics_arm import (DeviceError, HOME, HttpArm, JOINTS, LIMITS, WORKSPACE, async_box_clearance,
                             cartesian, device_ip, link_positions, number, pinned_ip, position,
                             swept_clearance, validate_async_box, validate_path, validate_pose)
from hq_robotics_camera import Camera, TRACK, executable
from hq_robotics_estop import HttpEstop, monitor_ip
from hq_robotics_ptz import DIRECTIONS as PTZ_DIRECTIONS, Ptz
from hq_robotics_tapo import NIGHT_MODES, Tapo

PREFIX = "/api/robotics/"
PROFILE = "m2s-gripper-v1"
LEASE_SECONDS = 20
TICKET_SECONDS = 4
MIN_INTERVAL = .5
STEP_INTERVAL = .15  # Minimum gap between chained sub-steps of one stepped approach.
PROBE_INTERVAL = .2  # Minimum gap between telemetry reads of the arm.
REACHED_DEGREES = 2.0  # Arrival tolerance: the elbow rests about 1.3 deg off its command (91.3 for 90).
STREAM_TICK = .1  # Seconds between goals of a streamed trajectory (10 Hz suits the arm's controller).
STREAM_PEAK_RATIO = 1.0  # Cruise speed of the streamed move versus the nominal speed, capped at the configured maximum.
STREAM_SPD_FLOOR = 60  # Measured on the arm: goal speeds under ~60 steps/s still run at 4 deg/s or more, so the servo
# overshoots each goal and then waits. Never command less, or the stream stutters.
STREAM_RAMP = .35  # Seconds to reach cruise speed, and to leave it: a short ramp, then constant speed.
STREAM_SPD_GAIN = 1.1  # The goal speed is only a little above what the curve needs, so the servo keeps moving.
STREAM_LOOKAHEAD = .25  # Seconds ahead on the curve that each goal is placed: the servo pursues it without idling.
STREAM_MAX_LAG = 15.0  # Degrees the measured pose may trail the commanded one before the stream is abandoned.
BLEND_DEGREES = 5.0  # Within this of the current sub-step target, the next one may be sent.
NOOP_DEGREES = .25  # Below ~3 servo steps a move is already satisfied; do not send it.
DIRECT_SPEED = 60  # Steps/s for the confirmed direct return to neutral (about 5 deg/s).
ESTOP_SUPERVISOR_INTERVAL = .25  # Seconds between background E-stop monitor polls while armed/moving.
READ_FAILURES = 3  # Consecutive idle telemetry misses tolerated before the post faults.
FEEDBACK_MAX_AGE = 2.5
MAX_PRESETS = 64
MAX_RECORDINGS = 32
MAX_RECORD_STEPS = 64
MAX_KEEPOUT = 12
MAX_ROUTINES = 32
BLACKBOX_SAMPLES = 360
DEFAULTS = {
    "revision": "", "mode": "simulation", "transport": "http", "arm_ip": "",
    "serial_port": "", "arm_timeout": .8, "camera_ip": "", "camera_user": "",
    "camera_password": "", "camera_cloud_password": "", "camera_tls_sha256": "", "camera_timeout": 6, "quality": "standard",
    "joint_limits": LIMITS, "workspace": WORKSPACE, "speed": 100,
    "acceleration": 4, "step_limit": 5, "camera_required": True,
    "estop_ip": "", "estop_port": 80, "estop_token": "", "estop_required": False, "estop_require_signed": False,
    "torque_telemetry_required": True,
    "keepout": [], "load_warn": 700, "load_critical": 900,
}
LABELS = {
    "armed": "Autorisation de mouvement", "disarmed": "Autorisation relâchée",
    "moving": "Cible envoyée", "reached": "Cible atteinte", "cancelled": "Annulation demandée",
    "stopped": "Arrêt logiciel", "uncertain": "Mouvement incertain",
    "settings": "Réglages enregistrés", "feedback_failed": "Retour matériel indisponible",
    "estop": "Arrêt d’urgence ouvert",
}


def approach(start, target, limit):
    """Scale the move toward target so no joint travels more than `limit` degrees."""
    biggest = max(abs(target[k] - start[k]) for k in JOINTS)
    factor = 1 if biggest <= limit else limit / biggest
    pose = {k: start[k] + (target[k] - start[k]) * factor for k in JOINTS}
    return pose, max(abs(target[k] - pose[k]) for k in JOINTS)


def smoother(u):
    """Rest-to-rest easing: zero speed and zero acceleration at both ends."""
    return u * u * u * (u * (6 * u - 15) + 10)


def trapezoid(seconds, ramp):
    """Fraction of the move done at time t: a short ramp up, constant speed, a short ramp down.

    A constant-speed cruise looks continuous on the arm; the ramps only remove the abrupt start and stop."""
    ramp = min(ramp, seconds / 2)
    cruise = 1 / (seconds - ramp)  # fraction per second, so the whole move is covered in `seconds`

    def fraction(t):
        t = min(max(t, 0.0), seconds)
        if t < ramp:
            return .5 * cruise * t * t / ramp
        if t > seconds - ramp:
            left = seconds - t
            return 1 - .5 * cruise * left * left / ramp
        return .5 * cruise * ramp + cruise * (t - ramp)
    return fraction


def fit_step(start, target, limit, limits, workspace):
    """Largest approach toward target that the physical path check accepts.

    The check is conservative near the workspace edge, so a step that is fine at neutral can be
    refused far out. Halve the step until it passes instead of failing the whole move."""
    pose, gap = approach(start, target, limit)
    for _ in range(7):
        try:
            validate_path(start, pose, limits, workspace, independent_axes=True)
            return pose, gap
        except ValueError:
            pose = {k: start[k] + (pose[k] - start[k]) / 2 for k in JOINTS}
            gap = max(abs(target[k] - pose[k]) for k in JOINTS)
    validate_path(start, pose, limits, workspace, independent_axes=True)
    return pose, gap


class Rejected(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code = status, code


def refuse(code, message, status=409):
    raise Rejected(status, code, message)


def read_object(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError):
        refuse("robotics_state_unreadable", "État Robotique illisible, fichier conservé", 503)
    if not isinstance(value, dict):
        refuse("robotics_state_unreadable", "État Robotique invalide, fichier conservé", 503)
    return value


def bounds(raw, outer):
    if not isinstance(raw, dict) or set(raw) != set(outer):
        raise ValueError("Enveloppe incomplète")
    result = {}
    for key, pair in raw.items():
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError("Deux bornes sont requises")
        lo, hi = (number(value, *outer[key]) for value in pair)
        if lo >= hi:
            raise ValueError("Bornes inversées")
        result[key] = (lo, hi)
    return result


def tags(raw):
    """Small, printable labels for finding saved scripts. They do not affect playback."""
    if raw is None:
        return []
    if not isinstance(raw, list) or len(raw) > 6:
        raise ValueError("Six tags au maximum")
    result = []
    for value in raw:
        if not isinstance(value, str):
            raise ValueError("Tag invalide")
        value = value.strip()
        if not 1 <= len(value) <= 24 or not value.isprintable():
            raise ValueError("Tag invalide")
        if value.casefold() not in {item.casefold() for item in result}:
            result.append(value)
    return result


def routine_parameters(raw):
    """Bounded, typed parameters applied to a simulation routine before validation."""
    if raw is None:
        raw = {}
    if not isinstance(raw, dict) or set(raw) - {"base_delta", "repeats"}:
        raise ValueError("Paramètres de routine invalides")
    return {"base_delta": int(number(raw.get("base_delta", 0), -20, 20)),
            "repeats": int(number(raw.get("repeats", 1), 1, 8))}


def keepout(raw):
    """Validate end-effector exclusion boxes. These are soft guards, not a certified safety fence."""
    if not isinstance(raw, list) or len(raw) > MAX_KEEPOUT:
        raise ValueError("Zones d’exclusion invalides")
    result = []
    names = set()
    for zone in raw:
        if not isinstance(zone, dict) or set(zone) != {"name", "x", "y", "z"}:
            raise ValueError("Zone d’exclusion incomplète")
        name = zone["name"]
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40 or not name.isprintable():
            raise ValueError("Nom de zone invalide")
        name = name.strip()
        if name.casefold() in names:
            raise ValueError("Noms de zones en double")
        names.add(name.casefold())
        box = bounds({axis: zone[axis] for axis in ("x", "y", "z")}, WORKSPACE)
        result.append({"name": name, **{axis: list(pair) for axis, pair in box.items()}})
    return result


def settings(raw, previous, *, resolve=False):
    if set(raw) - (set(DEFAULTS) - {"revision"}):
        raise ValueError("Réglage Robotique inconnu")
    cfg = {**previous, **raw}
    if cfg["mode"] not in ("simulation", "hardware") or cfg["transport"] != "http":
        raise ValueError("Mode ou transport indisponible")
    for key in ("arm_ip", "camera_ip"):
        if not isinstance(cfg[key], str):
            raise ValueError("Adresse locale invalide")
        if cfg[key]:
            cfg[key] = device_ip(cfg[key]) if resolve and key in raw else pinned_ip(cfg[key])
    if not isinstance(cfg["estop_ip"], str):
        raise ValueError("Adresse du moniteur E-stop invalide")
    if cfg["estop_ip"]:
        cfg["estop_ip"] = monitor_ip(cfg["estop_ip"])
    cfg["estop_port"] = int(number(cfg["estop_port"], 1, 65535))
    for key, limit in (("camera_user", 64), ("camera_password", 128), ("camera_cloud_password", 128),
                       ("serial_port", 32), ("estop_token", 128)):
        value = cfg[key]
        if not isinstance(value, str) or len(value) > limit or any(ord(ch) < 32 for ch in value):
            raise ValueError("Paramètre de connexion invalide")
    if any(not 32 <= ord(ch) < 127 for ch in cfg["estop_token"]):
        raise ValueError("Jeton du moniteur E-stop invalide")
    if not isinstance(cfg["camera_tls_sha256"], str):
        raise ValueError("Empreinte TLS SHA-256 invalide")
    cfg["camera_tls_sha256"] = cfg["camera_tls_sha256"].strip().lower()
    if cfg["camera_tls_sha256"] and not re.fullmatch(r"[0-9a-f]{64}", cfg["camera_tls_sha256"]):
        raise ValueError("Empreinte TLS SHA-256 invalide")
    if not isinstance(cfg["camera_required"], bool) or not isinstance(cfg["estop_required"], bool) or not isinstance(cfg["estop_require_signed"], bool) or not isinstance(cfg["torque_telemetry_required"], bool):
        raise ValueError("Réglage de sécurité invalide")
    if cfg["estop_require_signed"] and not cfg["estop_token"]:
        raise ValueError("Jeton requis pour un moniteur E-stop signé")
    if not isinstance(cfg["quality"], str) or cfg["quality"] not in TRACK:
        raise ValueError("Qualité vidéo invalide")
    cfg["arm_timeout"] = number(cfg["arm_timeout"], .2, 1.5)
    cfg["camera_timeout"] = number(cfg["camera_timeout"], 2, 12)
    cfg["speed"] = int(number(cfg["speed"], 40, 200))
    cfg["acceleration"] = int(number(cfg["acceleration"], 1, 8))
    cfg["step_limit"] = number(cfg["step_limit"], 1, 8)
    cfg["keepout"] = keepout(cfg["keepout"])
    cfg["load_warn"] = int(number(cfg["load_warn"], 0, 999))
    cfg["load_critical"] = int(number(cfg["load_critical"], cfg["load_warn"] + 1, 1000))
    cfg["joint_limits"] = bounds(cfg["joint_limits"], LIMITS)
    cfg["workspace"] = bounds(cfg["workspace"], WORKSPACE)
    validate_pose(HOME, cfg["joint_limits"], cfg["workspace"])
    return cfg


@dataclass
class Lease:
    session: str
    key: str
    expires: float
    ticket: str = ""
    ticket_until: float = 0


@dataclass
class Stream:
    session: str
    key: str
    quality: str
    expires: float
    opened: bool = False
    last_bytes: float = -math.inf
    last_frame: float = -math.inf


class Robotics:
    def __init__(self, root, *, clock=time.monotonic, arm_factory=HttpArm, camera=None, estop_factory=HttpEstop):
        self.state_dir = hq_state.agent_state_dir(root)
        self.config_path = self.state_dir / "robotics.json"
        self.presets_path = self.state_dir / "robotics-presets.json"
        self.recordings_path = self.state_dir / "robotics-recordings.json"
        self.routines_path = self.state_dir / "robotics-routines.json"
        self.commission_path = self.state_dir / "robotics-commission.json"
        self.blackbox_path = self.state_dir / "robotics-blackbox.json"
        self.camera = camera if camera is not None else Camera(root)
        self.clock = clock
        self.arm_factory = arm_factory
        self.estop_factory = estop_factory
        self.estop_state = None
        self.estop_at = -math.inf
        self.estop_last_seq = None
        self._estop_seq_lock = threading.Lock()
        self.physical_command_sent = False
        self.stream_generation = 0
        self.pending_stream_id = None
        self.active_stream_id = None
        self.commanded_start = None
        self.last_settled_pose = None
        self.last_settled_at = -math.inf
        self.lock = threading.RLock()
        self.io = threading.Lock()
        self.lease = None
        self.video = None
        self.video_error = ""
        self.history = deque(maxlen=24)
        self.blackbox = deque(self._load_blackbox(), maxlen=BLACKBOX_SAMPLES)
        self.blackbox_at = -math.inf
        self.feedback = None
        self.feedback_at = -math.inf
        self.last_probe = -math.inf
        self.last_move = -math.inf
        self.motion = None
        self.target = None
        self.sim_pose = HOME.copy()
        self.uncertain = False
        self.stop_latched = False
        self.last_stop = -math.inf
        self.stop_pending = False
        self.epoch = 0
        self._supervisor_stop = threading.Event()
        self._supervisor_thread = None
        self._supervisor_cfg = None
        self.current_mode = "simulation"
        self.camera_required = True
        self.read_failures = 0
        self.latency_samples = deque(maxlen=60)
        self.telemetry_misses = 0
        self.live_script = None  # Per-run confirmation for an approved script on the real arm.
        self.stream_threaded = True
        self.ptz_factory = Ptz
        self.tapo_factory = Tapo
        self.tapo_session = None
        self.last_tapo = -math.inf
        self.tapo_pause = (-math.inf, "")
        self.ptz_lock = threading.Lock()
        self.last_ptz = -math.inf
        self.stream_sleep = time.sleep
        self.blend = False  # True when a stepped approach is close enough to its target to send the next sub-step.
        self.blendable = False
        self.script_state = None  # Progress of the script step being approached on the real arm.
        self.requires_inspection = self.state_dir / "robotics-inspection.json"

    def config(self):
        raw = read_object(self.config_path)
        try:
            return settings({key: val for key, val in raw.items() if key != "revision"},
                            {**DEFAULTS, "revision": raw.get("revision", "")})
        except (ValueError, TypeError):
            refuse("robotics_state_unreadable", "Réglages Robotique invalides, fichier conservé", 503)

    def public_config(self, cfg):
        return {**{k: v for k, v in cfg.items()
                   if k not in {"camera_user", "camera_password", "camera_cloud_password", "estop_token"}},
                "camera_configured": self.camera_configured(cfg), "camera_cloud_configured": bool(cfg["camera_cloud_password"]),
                "estop_configured": bool(cfg["estop_ip"]), "profile": PROFILE}

    def keepout_path(self, cfg, start, end):
        """Reject a pose or a sampled joint-space path whose end effector enters an exclusion box.

        This is a TCP guard: it catches the selected point entering the box, not the whole arm.
        """
        zones = cfg.get("keepout") or []
        if not zones:
            return
        delta = {key: end[key] - start[key] for key in JOINTS}
        samples = max(1, math.ceil(max(abs(delta[key]) for key in JOINTS) / 2))
        for index in range(samples + 1):
            t = index / samples
            xyz = position({key: start[key] + t * delta[key] for key in JOINTS})
            for zone in zones:
                if all(zone[axis][0] <= xyz[axis] <= zone[axis][1] for axis in ("x", "y", "z")):
                    refuse("robotics_keepout", f"Zone interdite « {zone['name']} » sur la trajectoire", 409)

    def keepout_point(self, cfg, pose):
        zones = cfg.get("keepout") or []
        if not zones:
            return
        xyz = position(pose)
        for zone in zones:
            if all(zone[axis][0] <= xyz[axis] <= zone[axis][1] for axis in ("x", "y", "z")):
                refuse("robotics_keepout", f"Cible dans la zone interdite « {zone['name']} »", 409)

    @staticmethod
    def camera_configured(cfg):
        return bool(cfg["camera_ip"] and cfg["camera_user"] and cfg["camera_password"])

    def estop_health(self, cfg, *, force=False):
        """Read the optional contact monitor; simulation and no-monitor paths stay local."""
        if self.mode == "simulation":
            return {"mode": "simulation", "healthy": True}
        if not cfg.get("estop_ip"):
            return {"mode": "unmonitored", "healthy": None}
        now = self.clock()
        if not force and self.estop_state is not None and now - self.estop_at < .5:
            return dict(self.estop_state)
        try:
            with self._estop_seq_lock:
                kwargs = {}
                if cfg.get("estop_require_signed"):
                    kwargs = {"require_signed": True, "last_seq": self.estop_last_seq}
                elif self.estop_factory is HttpEstop:
                    kwargs = {"last_seq": self.estop_last_seq}
                client = self.estop_factory(cfg["estop_ip"], cfg["estop_port"], cfg["estop_token"],
                                            min(.3, cfg["arm_timeout"]), **kwargs)
                reading = client.read()
                if getattr(client, "_last_seq", None) is not None:
                    self.estop_last_seq = max(self.estop_last_seq or -1, client._last_seq)
            state = {"mode": "hardware", "healthy": reading.get("healthy") is True}
            if reading.get("signed") is True:
                state["signed"] = True
        except (DeviceError, ValueError) as error:
            state = {"mode": "hardware", "healthy": False, "error": str(error)}
        self.estop_state = state
        self.estop_at = now
        return dict(state)

    def _estop_monitored(self, cfg):
        return self.mode == "hardware" and bool(cfg.get("estop_ip") or cfg.get("estop_required"))

    def trip_estop(self, cfg=None):
        """Latch the controller unsafe when a monitored E-stop opens, times out, or fails."""
        with self.lock:
            if not (self.lease or self.motion or self.physical_command_sent) and self.stop_latched:
                return
            self.epoch += 1
            self.pending_stream_id = None
            self.stop_latched = True
            if self.motion or self.physical_command_sent:
                self.uncertain = True
            self.motion = None
            self.lease = None
            self.physical_command_sent = False
            self.live_script = self.script_state = None
            self.record("estop")
            self.record_incident("estop", cfg)
            self.feedback = None
            if self.mode == "hardware":
                try:
                    self.write(self.requires_inspection, {"pending": True, "reason": "estop"})
                except Rejected as err:
                    logging.getLogger("hq_robotics").warning("inspection write failed on estop: %s", err)

    def _start_estop_supervisor(self, cfg):
        if not self._estop_monitored(cfg):
            return
        with self.lock:
            self._supervisor_cfg = dict(cfg)
            if self._supervisor_thread and self._supervisor_thread.is_alive():
                return
            self._supervisor_stop.clear()
            thread = threading.Thread(target=self._estop_supervisor_loop,
                                      name="robotics-estop-supervisor", daemon=True)
            self._supervisor_thread = thread
            thread.start()

    def _estop_supervisor_loop(self):
        while not self._supervisor_stop.wait(ESTOP_SUPERVISOR_INTERVAL):
            try:
                with self.lock:
                    if self.mode != "hardware" or not (self.lease or self.motion):
                        self._supervisor_thread = None
                        return
                    cfg = self._supervisor_cfg
                if not cfg or not self._estop_monitored(cfg):
                    with self.lock:
                        self._supervisor_thread = None
                    return
                estop = self.estop_health(cfg, force=True)
                if estop.get("healthy") is not True:
                    self.trip_estop(cfg)
                    with self.lock:
                        self._supervisor_thread = None
                    return
            except Exception as err:
                logging.getLogger("hq_robotics").error("estop supervisor failed: %s", err)
                self.trip_estop(getattr(self, "_supervisor_cfg", None))
                with self.lock:
                    self._supervisor_thread = None
                return

    def close(self):
        with self.lock:
            if self.mode == "hardware" and (self.lease or self.motion or self.physical_command_sent):
                self.epoch += 1
                self.stop_latched = True
                self.uncertain = True
                self.motion = None
                self.lease = None
                self.physical_command_sent = False
                self.live_script = self.script_state = None
                self.record("uncertain")
                self.record_incident("shutdown")
                self.feedback = None
                try:
                    self.write(self.requires_inspection, {"pending": True, "reason": "shutdown"})
                except Rejected as err:
                    logging.getLogger("hq_robotics").warning("inspection write failed on close: %s", err)
        self._supervisor_stop.set()
        thread = self._supervisor_thread
        if thread and thread.is_alive() and thread is not threading.current_thread():
            thread.join(timeout=1.0)
        if hasattr(self.camera, "close"):
            self.camera.close()

    def commissioned(self, cfg):
        if cfg["mode"] != "hardware" or not cfg["arm_ip"] or not cfg["revision"]:
            return False
        try:
            record = read_object(self.commission_path)
        except Rejected:
            return False
        return record.get("revision") == cfg["revision"] and record.get("profile") == PROFILE

    def record(self, kind):
        self.history.appendleft({"kind": kind, "label": LABELS[kind], "at": time.time()})

    def write(self, path, value):
        try:
            self.state_dir.mkdir(exist_ok=True)
            hq_state.write_json_atomic(path, value)
        except (OSError, RuntimeError):
            refuse("robotics_state_write", "Écriture Robotique impossible", 503)

    def expire(self):
        now = self.clock()
        if self.lease and (now >= self.lease.expires or
                           (self.mode == "hardware" and not self.camera_ok(self.lease.session))):
            self.disarm("disarmed")
        if self.motion:
            if self.mode == "simulation":
                start, end, began, deadline = self.motion
                t = min(1, (now - began) / (deadline - began))
                t = t*t*(3 - 2*t)
                self.sim_pose = {key: start[key] + (end[key] - start[key]) * t for key in JOINTS}
                if now >= deadline:
                    self.motion = None
                    self.record("reached")
            elif now >= self.motion:
                self.fault("uncertain")

    @property
    def mode(self):
        return self.current_mode

    def disarm(self, kind):
        self.epoch += 1
        self.pending_stream_id = None
        uncertain_latched = False
        if self.mode == "simulation" and self.motion:
            self.motion = None
            self.target = self.sim_pose.copy()
        elif self.mode == "hardware" and (self.motion or self.physical_command_sent) and kind in ("cancelled", "disarmed"):
            # RoArm T:102 has no verified controlled-stop command and T:210 cmd:0
            # drops torque (gravity risk). Suppress further commands and require
            # physical inspection instead of claiming the arm stopped.
            self.uncertain = True
            self.motion = None
            self.physical_command_sent = False
            uncertain_latched = True
            try:
                self.write(self.requires_inspection, {"pending": True, "reason": kind})
            except Rejected as err:
                logging.getLogger("hq_robotics").warning("inspection write failed on disarm: %s", err)
        if self.lease or kind != "disarmed":
            self.record(kind)
        self.lease = None
        self.live_script = self.script_state = None
        if uncertain_latched:
            self.record_incident(kind)

    def fault(self, kind):
        self.epoch += 1
        self.pending_stream_id = None
        self.uncertain = self.uncertain or bool(self.motion) or self.physical_command_sent
        self.motion = None
        self.lease = None
        self.physical_command_sent = False
        self.live_script = self.script_state = None
        self.record(kind)
        self.record_incident(kind)
        self.feedback = None

    def owner(self, session, key):
        return bool(self.lease and self.lease.session == session and
                    isinstance(key, str) and self.lease.key == key)

    def camera_ok(self, session):
        return not self.camera_required or self.video_live(session)

    def video_live(self, session):
        now = self.clock()
        return bool(self.video and self.video.session == session and self.video.opened and
                    now < self.video.expires and now - self.video.last_bytes < 3 and
                    now - self.video.last_frame < 2.5)

    def shadow_diagnostics(self, feedback):
        """Read-only joint tracking error and latency percentiles for shadow-mode observability."""
        actual = feedback.get("actual") if isinstance(feedback, dict) else None
        tracking_error = None
        max_error = None
        if isinstance(actual, dict) and isinstance(self.target, dict):
            tracking_error = {
                k: round(abs(self.target[k] - actual[k]), 2)
                for k in JOINTS if k in self.target and k in actual
            }
            if tracking_error:
                max_error = max(tracking_error.values())
        samples = sorted(self.latency_samples)
        p50 = samples[len(samples) // 2] if samples else None
        p95 = samples[min(len(samples) - 1, math.ceil(len(samples) * 0.95) - 1)] if samples else None
        return {
            "tracking_error_deg": tracking_error,
            "max_error_deg": max_error,
            "latency_p50_ms": p50,
            "latency_p95_ms": p95,
            "latency_samples": len(samples),
            "telemetry_misses": self.telemetry_misses,
        }

    def status(self, cfg, session, key, physical, camera_local):
        now = self.clock()
        self.expire()
        estop = self.estop_health(cfg)
        if self._estop_monitored(cfg) and (self.lease or self.motion) and estop.get("healthy") is not True:
            self.trip_estop(cfg)
        owner = self.owner(session, key)
        blending = bool(self.motion and self.blendable and self.blend)
        if (owner and (not self.motion or blending) and now - self.last_move >= (STEP_INTERVAL if blending else MIN_INTERVAL)
                and (not self.lease.ticket or now >= self.lease.ticket_until)):
            self.lease.ticket = secrets.token_urlsafe(18)
            self.lease.ticket_until = now + TICKET_SECONDS
        feedback = self.feedback if now - self.feedback_at < FEEDBACK_MAX_AGE else None
        if self.mode == "simulation":
            feedback = {"source": "simulation", "actual": self.sim_pose.copy(),
                        "xyz": position(self.sim_pose)}
            torque_state = "simulation"
        elif feedback is None:
            torque_state = None
        else:
            torque_state = feedback.get("torque_state")
            if not torque_state:
                torque = feedback.get("torque") or {}
                if not torque:
                    torque_state = "unknown"
                elif set(torque) != set(JOINTS):
                    torque_state = "partial"
                elif all(v == 1 for v in torque.values()):
                    torque_state = "enabled"
                else:
                    torque_state = "disabled"
        uncertain = self.uncertain or (self.mode == "hardware" and not self.motion
                                       and self.requires_inspection.exists())
        if self.mode == "simulation":
            stop_state = "latched" if self.stop_latched else "idle"
        elif uncertain or self.stop_latched:
            stop_state = "unconfirmed"
        else:
            stop_state = "idle"
        self.capture_blackbox(cfg, feedback, owner, estop)
        return {
            "ok": True, "config": self.public_config(cfg), "physical_local": physical,
            "commissioned": physical and self.commissioned(cfg), "camera_local": camera_local,
            "gateway": bool(executable(self.state_dir.parent)), "camera_live": self.video_live(session),
            "camera_error": self.video_error, "feedback": feedback,
            "last_feedback": (time.time() - (now - self.feedback_at)
                              if self.feedback_at > -math.inf and self.mode == "hardware" else None),
            "latency_ms": self.feedback.get("latency_ms") if feedback and self.mode == "hardware" else None,
            "shadow": self.shadow_diagnostics(feedback),
            "target": self.target, "moving": bool(self.motion), "blend": blending, "armed": owner,
            "script": dict(self.script_state) if owner and self.script_state else None,
            "occupied": bool(self.lease and not owner),
            "uncertain": uncertain,
            "stop_latched": self.stop_latched,
            "stop_state": stop_state,
            "torque_state": torque_state,
            "estop": estop,
            "ticket": self.lease.ticket if owner and now < self.lease.ticket_until else "",
            "history": list(self.history),
        }

    def _load_blackbox(self):
        try:
            if self.blackbox_path.exists():
                raw = json.loads(self.blackbox_path.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    return [item for item in raw if isinstance(item, dict)][:BLACKBOX_SAMPLES]
        except (OSError, ValueError):
            pass
        return []

    def _build_blackbox_entry(self, feedback, owner, estop=None, *, incident=None):
        actual = feedback.get("actual") if isinstance(feedback, dict) else None
        xyz = feedback.get("xyz") if isinstance(feedback, dict) else None
        clean_estop = ({key: estop[key] for key in ("mode", "healthy", "error", "signed") if key in estop}
                       if isinstance(estop, dict) else None)
        entry = {
            "at": time.time(), "mode": self.mode, "armed": bool(owner), "moving": bool(self.motion),
            "stop_latched": self.stop_latched, "uncertain": self.uncertain,
            "target": self.target, "actual": actual, "xyz": xyz,
            "load": feedback.get("load") if isinstance(feedback, dict) else None,
            "torque": feedback.get("torque") if isinstance(feedback, dict) else None,
            "latency_ms": feedback.get("latency_ms") if isinstance(feedback, dict) else None,
            "estop": clean_estop,
            "last_event": dict(self.history[0]) if self.history else None,
        }
        if incident:
            entry["incident"] = str(incident)
        return entry

    def record_incident(self, incident, cfg=None):
        """Immediately record and atomically persist a redacted incident sample."""
        with self.lock:
            entry = self._build_blackbox_entry(self.feedback, bool(self.lease), self.estop_state, incident=incident)
            self.blackbox.appendleft(entry)
            try:
                self.state_dir.mkdir(exist_ok=True)
                hq_state.write_json_atomic(self.blackbox_path, list(self.blackbox))
            except (OSError, RuntimeError) as err:
                logging.getLogger("hq_robotics").warning("blackbox write failed: %s", err)

    def capture_blackbox(self, cfg, feedback, owner, estop=None):
        """A bounded, redacted incident history (persisted on incidents, sampled on status)."""
        now = self.clock()
        if now - self.blackbox_at < 1:
            return
        self.blackbox_at = now
        self.blackbox.appendleft(self._build_blackbox_entry(feedback, owner, estop))

    def arm(self, cfg, session, physical, authorized):
        with self.lock:
            self.expire()
            if self.lease or self.motion or self.stop_pending or self.active_stream_id is not None or self.io.locked():
                refuse("robotics_busy", "Poste de commande occupé")
            if self.stop_latched or self.uncertain or (self.mode == "hardware" and self.requires_inspection.exists()):
                refuse("robotics_inspect", "Inspection sur place et réarmement manuel requis")
            if not authorized():
                refuse("robotics_authorization", "Autorisation expirée", 403)
            if self.mode == "hardware":
                self.require_physical(cfg, physical)
                self.require_feedback()
                if not self.camera_ok(session):
                    refuse("robotics_camera_required", "Flux vidéo actif requis pour armer")
                estop = self.estop_health(cfg, force=True)
                if estop["mode"] == "hardware" and estop["healthy"] is not True:
                    refuse("robotics_estop", "Arrêt d’urgence ouvert ou moniteur injoignable")
                if cfg["estop_required"] and estop["mode"] != "hardware":
                    refuse("robotics_estop", "Moniteur d’arrêt d’urgence requis")
            now = self.clock()
            key = secrets.token_urlsafe(24)
            self.lease = Lease(session, key, now + LEASE_SECONDS)
            self.record("armed")
            self._start_estop_supervisor(cfg)
            return {"ok": True, "lease": key}

    def require_physical(self, cfg, physical):
        if not physical:
            refuse("robotics_local_only", "Commande physique réservée au PC HQ", 403)
        if not self.commissioned(cfg):
            refuse("robotics_commission", "Mise en service RoArm requise")

    def require_feedback(self):
        if not self.feedback or self.clock() - self.feedback_at >= FEEDBACK_MAX_AGE:
            refuse("robotics_feedback_required", "Retour RoArm récent requis")
        return self.feedback

    def probe(self, cfg, physical):
        if not physical or not cfg["arm_ip"] or cfg["mode"] != "hardware":
            refuse("robotics_probe_unavailable", "Configurer le RoArm depuis le PC HQ")
        with self.lock:
            self.check_revision(cfg)
            now = self.clock()
            if now - self.last_probe < PROBE_INTERVAL or self.stop_pending or not self.io.acquire(False):
                refuse("robotics_busy", "Lecture RoArm occupée", 429)
            self.last_probe = now
        try:
            self.read_feedback(cfg, tolerate=True)
        finally:
            self.io.release()

    def read_feedback(self, cfg, tolerate=False):
        now = self.clock()
        try:
            value = self.arm_factory(cfg["arm_ip"], cfg["arm_timeout"]).feedback()
        except DeviceError:
            with self.lock:
                self.read_failures += 1
                self.telemetry_misses += 1
                # An idle poll may miss a reply on a weak link; a pre-send read or
                # a read during a motion never gets that grace.
                if not tolerate or self.motion or self.read_failures >= READ_FAILURES:
                    self.read_failures = 0
                    self.fault("feedback_failed")
            raise
        with self.lock:
            self.read_failures = 0
            self.expire()
            self.feedback_at = self.clock()
            latency_ms = round((self.feedback_at - now) * 1000)
            value["latency_ms"] = latency_ms
            if self.mode == "hardware":
                self.latency_samples.append(latency_ms)
            self.feedback = value
            if self.motion and self.blendable and self.target and not self.blend:
                self.blend = max(abs(value["actual"][k] - self.target[k]) for k in JOINTS) <= BLEND_DEGREES
            if self.active_stream_id is None and self.motion and all(abs(value["actual"][k] - self.target[k]) <= REACHED_DEGREES for k in JOINTS):
                now_ts = self.feedback_at
                actual_pose = value["actual"]
                start_dist = (
                    max(abs(self.target[k] - self.commanded_start[k]) for k in JOINTS)
                    if self.commanded_start else math.inf
                )
                now_dist = max(abs(self.target[k] - actual_pose[k]) for k in JOINTS)
                moved_toward = (
                    not self.commanded_start
                    or start_dist <= NOOP_DEGREES
                    or (max(abs(actual_pose[k] - self.commanded_start[k]) for k in JOINTS) >= NOOP_DEGREES
                        and now_dist < start_dist)
                )
                if (moved_toward
                        and self.last_settled_pose is not None
                        and now_ts - self.last_settled_at >= 0.35
                        and max(abs(actual_pose[k] - self.last_settled_pose[k]) for k in JOINTS) <= 0.08):
                    self.clear_inspection()
                    self.motion = None
                    self.physical_command_sent = False
                    self.commanded_start = None
                    self.last_settled_pose = None
                    self.last_settled_at = -math.inf
                    self.record("reached")
                else:
                    self.last_settled_pose = dict(actual_pose)
                    self.last_settled_at = now_ts
            elif self.motion:
                self.last_settled_pose = None
                self.last_settled_at = -math.inf
        return value

    def resolve_pose(self, cfg, data):
        kind = data.get("kind")
        limits, workspace = cfg["joint_limits"], cfg["workspace"]
        if kind == "home":
            return validate_pose(HOME, limits, workspace)
        if kind == "cartesian":
            return cartesian(data.get("xyz"), limits, workspace)
        if kind == "preset":
            item = self.presets().get(data.get("id") if isinstance(data.get("id"), str) else "")
            if not item:
                refuse("robotics_preset_missing", "Position enregistrée introuvable", 404)
            if item.get("profile") != PROFILE:
                refuse("robotics_preset_profile", "Profil de position incompatible")
            return validate_pose(item.get("pose"), limits, workspace)
        if kind != "joints":
            raise ValueError("Type de mouvement inconnu")
        return validate_pose(data.get("pose"), limits, workspace)

    def move(self, cfg, data, session, physical, authorized, owner):
        key, ticket = data.get("lease"), data.get("ticket")
        with self.lock:
            self.check_revision(cfg)
            self.expire()
            if not self.owner(session, key) or not authorized():
                refuse("robotics_disarmed", "Armer les commandes avant le mouvement", 403)
            if self._estop_monitored(cfg):
                estop = self.estop_health(cfg, force=True)
                if estop.get("healthy") is not True:
                    self.trip_estop(cfg)
                    refuse("robotics_estop", "Arrêt d’urgence ouvert ou moniteur injoignable")
            now = self.clock()
            if not isinstance(ticket, str) or not ticket or ticket != self.lease.ticket or now >= self.lease.ticket_until:
                refuse("robotics_stale", "Commande expirée ou déjà utilisée")
            blending = bool(self.motion and self.blendable and self.blend)
            if (self.motion and not blending) or self.stop_pending or self.io.locked() or (
                    now - self.last_move < (STEP_INTERVAL if blending else MIN_INTERVAL)):
                refuse("robotics_busy", "Mouvement ou lecture déjà en cours", 429)
            script = None
            direct = data.get("kind") == "home_direct"
            if direct:
                # One confirmed move to neutral. It skips only the step limit: arming, focus,
                # STOP, torque, fresh feedback, workspace path and joint limits still apply.
                if data.get("confirmed") is not True:
                    refuse("robotics_direct_unconfirmed", "Confirmez le retour direct au neutre.", 403)
                pose = validate_pose(HOME, cfg["joint_limits"], cfg["workspace"])
                speed = min(DIRECT_SPEED, cfg["speed"])
            elif data.get("kind") == "reviewed_script":
                from hq_robotics_assistant import resolve_step
                pose, speed, script = resolve_step(self, cfg, owner, data)
                speed = int(min(cfg["speed"], max(1, speed)))
            else:
                pose = self.resolve_pose(cfg, data)
                speed = int(number(data.get("speed", cfg["speed"]), 40, cfg["speed"]))
            self.keepout_point(cfg, pose)
            if cfg["mode"] == "simulation":
                self.keepout_path(cfg, self.sim_pose, pose)
            elif self.feedback:
                self.keepout_path(cfg, self.feedback["actual"], pose)
            if blending and not (script or data.get("kind") == "home"):
                refuse("robotics_busy", "Mouvement déjà en cours", 429)
            self.lease.ticket = ""
            self.last_move = now
            # Dead-man window: every accepted move renews it, an idle arming still lapses.
            self.lease.expires = now + LEASE_SECONDS
            move_epoch = self.epoch
            if cfg["mode"] == "simulation":
                start = self.sim_pose.copy()
                self.keepout_path(cfg, start, pose)
                validate_path(start, pose, cfg["joint_limits"], cfg["workspace"])
                delta = max(abs(pose[k] - start[k]) for k in JOINTS)
                duration = max(.25, delta / (speed * 360 / 4096))
                self.target = pose
                self.motion = (start, pose, now, now + duration)
                self.record("moving")
                return
            self.require_physical(cfg, physical)
            if not self.camera_ok(session):
                refuse("robotics_camera_required", "Flux vidéo interrompu")
            self.require_feedback()
            if not self.io.acquire(False):
                refuse("robotics_busy", "Mouvement ou lecture déjà en cours", 429)
        stream = None
        try:
            feedback = self.read_feedback(cfg)
            start = feedback["actual"]
            with self.lock:
                self.expire()
                if (not self.owner(session, key) or not authorized() or self.stop_pending
                        or self.stop_latched or self.uncertain or self.epoch != move_epoch):
                    refuse("robotics_disarmed", "Autorisation relâchée avant envoi", 403)
                torque = feedback.get("torque")
                if not isinstance(torque, dict) or (
                        torque and (set(torque) != set(JOINTS) or any(value != 1 for value in torque.values()))):
                    refuse("robotics_torque", "Couple matériel indisponible")
                if not torque and cfg.get("torque_telemetry_required", True):
                    refuse("robotics_torque", "Télémétrie de couple matériel absente")
                finished = whole = False
                # Allow for servo quantization and independent axes.
                limits = {k: (lo + .2, hi - .2) for k, (lo, hi) in cfg["joint_limits"].items()}
                workspace = {k: (lo + 4, hi - 4) for k, (lo, hi) in cfg["workspace"].items()}
                progress = script["index"] if script else ("home" if data.get("kind") == "home" else None)
                if direct:
                    progress = None
                if progress is not None:
                    # Approved script steps and the return to neutral are approached in measured
                    # sub-steps along the straight joint-space line; each still obeys the step limit
                    # and the path checks, shrinking when the pose is close to the workspace edge.
                    target = pose
                    if script and script.get("fluid"):
                        # Fluid mode: the whole approved step as one command when its path passes the
                        # same check; otherwise fall back to the measured sub-steps below.
                        try:
                            validate_path(start, target, limits, workspace, independent_axes=True)
                            pose, gap, whole = target, 0.0, True
                        except ValueError:
                            pass
                    if not whole:
                        pose, gap = fit_step(start, target, max(1.0, cfg["step_limit"] - .5), limits, workspace)
                    self.script_state = {"index": progress, "gap": round(gap, 2)}
                    finished = bool(script and script["last"] and gap <= NOOP_DEGREES)
                    if gap > NOOP_DEGREES and max(abs(pose[k] - start[k]) for k in JOINTS) <= NOOP_DEGREES:
                        refuse("robotics_path_blocked", "Le bras ne peut pas avancer vers la cible sans sortir de l’espace de travail.")
                delta = max(abs(pose[k] - start[k]) for k in JOINTS)
                if delta > cfg["step_limit"] and not (direct or whole):
                    refuse("robotics_step_limit", "Cible trop éloignée pour un déplacement physique")
                self.keepout_path(cfg, start, pose)
                if cfg.get("keepout"):
                    clearance = async_box_clearance(start, pose, cfg["keepout"])
                    if clearance["collision_zone"] or clearance["clearance_uncertain"]:
                        zone_name = clearance["collision_zone"] or "d'exclusion"
                        refuse("robotics_keepout", f"Zone interdite « {zone_name} » sur le volume balayé", 409)
                if direct:
                    validate_path(start, pose, cfg["joint_limits"], cfg["workspace"], independent_axes=False)
                    validate_async_box(start, pose, cfg["joint_limits"], cfg["workspace"])
                elif not whole:
                    validate_path(start, pose, limits, workspace, independent_axes=True)
                if delta <= NOOP_DEGREES:
                    self.target = pose
                    self.record("reached")
                    if finished:
                        self.script_finished(owner, data)
                    return
                self.write(self.requires_inspection, {"pending": True})
                if self.clock() >= self.lease.ticket_until or not self.camera_ok(session) or not authorized():
                    self.clear_inspection()
                    self.disarm("disarmed")
                    refuse("robotics_stale", "Autorisation expirée avant envoi")
                seconds = delta / (speed * 360 / 4096)
                stream_id = None
                if direct or whole:
                    # The arm's controller runs a command at constant speed with abrupt starts and stops
                    # whatever the acceleration setting. Stream a smooth rest-to-rest curve instead.
                    seconds, stream_spd = self.stream_plan(cfg, start, pose, speed)
                    self._validate_stream_waypoints(cfg, start, pose, seconds)
                    self.stream_generation += 1
                    stream_id = self.stream_generation
                    self.pending_stream_id = stream_id
                    stream = (start, pose, seconds, stream_spd)
                self.target = pose
                self.commanded_start = dict(start)
                self.last_settled_pose = None
                self.last_settled_at = -math.inf
                self.motion = self.clock() + max(4, seconds + 3)
                self.blend, self.blendable = False, progress is not None
                if direct or whole:
                    if direct:
                        self.script_state = None
                    # A long move must not outlive the dead-man window it started under.
                    self.lease.expires = max(self.lease.expires, self.clock() + seconds + LEASE_SECONDS)
                self.record("moving")
            try:
                if stream is None:
                    final_speed = int(min(cfg["speed"], max(1, speed)))
                    if not self._dispatch_arm_move(cfg, session, key, move_epoch, pose,
                                                   final_speed, cfg["acceleration"],
                                                   authorized=authorized):
                        refuse("robotics_disarmed", "Autorisation relâchée avant envoi", 403)
            except DeviceError:
                with self.lock:
                    self.fault("uncertain")
                raise
            if finished:
                self.script_finished(owner, data)
        finally:
            self.io.release()
        if stream is not None:
            self.start_stream(cfg, session, key, *stream, epoch=move_epoch, stream_id=stream_id)

    def _dispatch_arm_move(self, cfg, session, key, epoch, goal, goal_spd, acceleration, *,
                           arm_client=None, authorized=None):
        """Serialize hardware move admission + transmission atomically under self.io and self.lock."""
        if self._estop_monitored(cfg):
            estop = self.estop_health(cfg, force=True)
            if estop.get("healthy") is not True:
                self.trip_estop(cfg)
                return False
        client = arm_client if arm_client is not None else self.arm_factory(cfg["arm_ip"], cfg["arm_timeout"])
        safe_spd = int(min(cfg["speed"], max(1, goal_spd)))
        with self.lock:
            if (not self.owner(session, key) or (authorized is not None and not authorized())
                    or self.stop_pending or self.stop_latched or self.uncertain
                    or (epoch is not None and self.epoch != epoch)):
                return False
            self.physical_command_sent = True
            client.move(goal, safe_spd, acceleration)
            return True

    def _validate_stream_waypoints(self, cfg, start, target, seconds):
        """Validate every streamed curve waypoint against limits, workspace, and keep-outs."""
        fraction = trapezoid(seconds, STREAM_RAMP)
        steps = max(1, math.ceil(seconds / STREAM_TICK))
        for index in range(steps + 1):
            f = fraction(min(seconds, index * STREAM_TICK))
            waypoint = target if f >= 1 else {k: start[k] + (target[k] - start[k]) * f for k in JOINTS}
            validate_pose(waypoint, cfg["joint_limits"], cfg["workspace"])
            self.keepout_point(cfg, waypoint)

    def stream_plan(self, cfg, start, target, speed):
        delta = max(abs(target[k] - start[k]) for k in JOINTS)
        cap = int(cfg["speed"])
        floor = min(STREAM_SPD_FLOOR, cap)
        peak = max(floor, min(cap, speed * STREAM_PEAK_RATIO))  # cruise speed, steps/s
        seconds = max(.4, delta / (peak * 360 / 4096) + STREAM_RAMP)
        planned_speed = min(cap, max(floor, math.ceil(peak * STREAM_SPD_GAIN)))
        return seconds, planned_speed

    def start_stream(self, cfg, session, key, start, target, seconds, spd, *, epoch=None, stream_id=None):
        with self.lock:
            if stream_id is None:
                if (not self.owner(session, key) or self.stop_pending or self.stop_latched
                        or self.uncertain or (epoch is not None and self.epoch != epoch)):
                    return False
                self.stream_generation += 1
                stream_id = self.stream_generation
            else:
                expected = self.pending_stream_id == stream_id
                if expected:
                    self.pending_stream_id = None
                if (not expected or not self.owner(session, key) or self.stop_pending or self.stop_latched
                        or self.uncertain or (epoch is not None and self.epoch != epoch)):
                    return False
            self.active_stream_id = stream_id
        try:
            if self.stream_threaded:
                threading.Thread(target=self.stream, args=(cfg, session, key, start, target, seconds, spd),
                                 kwargs={"epoch": epoch, "stream_id": stream_id}, name="robotics-stream", daemon=True).start()
            else:
                self.stream(cfg, session, key, start, target, seconds, spd, epoch=epoch, stream_id=stream_id)
        except Exception:
            with self.lock:
                if self.active_stream_id == stream_id:
                    self.active_stream_id = None
            raise
        return True

    def stream(self, cfg, session, key, start, target, seconds, spd, *, epoch=None, stream_id=None):
        """Send one approved move as goals along a smooth curve, every STREAM_TICK seconds.

        Stops sending as soon as the arming is released, a STOP or E-stop or fault latches,
        the epoch changes, or the measured pose falls far behind the commanded one."""
        with self.lock:
            if stream_id is None:
                self.stream_generation += 1
                stream_id = self.stream_generation
            self.active_stream_id = stream_id
        arm = self.arm_factory(cfg["arm_ip"], cfg["arm_timeout"])
        cap = int(cfg["speed"])
        floor = min(STREAM_SPD_FLOOR, cap)
        began, tick = self.clock(), 0
        try:
            fraction = trapezoid(seconds, STREAM_RAMP)

            def at(elapsed):
                f = fraction(elapsed)
                return target if f >= 1 else {k: start[k] + (target[k] - start[k]) * f for k in JOINTS}
            deg_per_step = 360 / 4096
            while True:
                tick += 1
                self.stream_sleep(max(0.0, began + tick * STREAM_TICK - self.clock()))
                elapsed = self.clock() - began
                with self.lock:
                    if (self.active_stream_id != stream_id or not self.owner(session, key) or self.stop_pending
                            or self.stop_latched or self.uncertain or (epoch is not None and self.epoch != epoch)):
                        return False
                if self._estop_monitored(cfg):
                    estop = self.estop_health(cfg, force=True)
                    if estop.get("healthy") is not True:
                        self.trip_estop(cfg)
                        return False
                here, goal = at(elapsed), at(elapsed + STREAM_LOOKAHEAD)
                span = max(.05, min(seconds, elapsed + STREAM_LOOKAHEAD) - min(seconds, elapsed))
                needed = max(abs(goal[k] - here[k]) for k in JOINTS) / span / deg_per_step  # steps/s
                goal_spd = int(min(cap, spd, max(floor, math.ceil(needed * STREAM_SPD_GAIN))))
                with self.io:
                    if not self._dispatch_arm_move(cfg, session, key, epoch, goal, goal_spd,
                                                   cfg["acceleration"], arm_client=arm):
                        return False
                    if elapsed < seconds and tick % 5 == 0:
                        measured = self.read_feedback(cfg)["actual"]
                        lag = max(abs(measured[k] - here[k]) for k in JOINTS)
                        if lag > STREAM_MAX_LAG:
                            with self.lock:
                                self.fault("uncertain")
                            return False
                if elapsed >= seconds:
                    break
        except DeviceError:
            with self.lock:
                self.fault("uncertain")
            return False
        finally:
            with self.lock:
                if self.active_stream_id == stream_id:
                    self.active_stream_id = None
        with self.lock:
            if self.motion and self.blendable and (epoch is None or self.epoch == epoch):
                self.blend = True  # each step is rest-to-rest, so the next one may begin
        return True

    def script_finished(self, owner, data):
        from hq_robotics_assistant import mark_played
        mark_played(self, owner, data.get("id"))

    def stop(self, cfg, data, session, physical, authorized, *, emergency=False):
        with self.lock:
            self.check_revision(cfg)
            self.expire()
            if not emergency and not self.owner(session, data.get("lease")):
                return
            if self.mode == "hardware" and not physical:
                refuse("robotics_local_only", "Arrêt physique réservé au PC HQ", 403)
            if emergency and self.clock() - self.last_stop < 2:
                refuse("robotics_busy", "Arrêt déjà demandé", 429)
            self.disarm("stopped" if emergency else "cancelled")
            if not emergency:
                return
            if self.mode == "simulation":
                self.last_stop = self.clock()
                self.stop_latched = True
                return
            if not (self.motion or self.uncertain or self.requires_inspection.exists()):
                self.last_stop = self.clock()
                self.stop_latched = True
                return "latched"
            self.require_physical(cfg, physical)
            if self.stop_pending:
                refuse("robotics_busy", "Coupure du couple déjà demandée", 429)
            self.stop_latched = True
            self.uncertain = True
            self.stop_pending = True
            self.epoch += 1
            self.last_stop = self.clock()
            self.motion = None
            self.record_incident("stop", cfg)
            try:
                self.write(self.requires_inspection, {"pending": True, "reason": "stop"})
            except Rejected:
                pass
        try:
            if not self.io.acquire(timeout=3.2):
                raise DeviceError("Coupure du couple non confirmée")
            try:
                if not authorized():
                    refuse("robotics_authorization", "Autorisation expirée", 403)
                self.arm_factory(cfg["arm_ip"], cfg["arm_timeout"]).emergency_stop()
            finally:
                self.io.release()
        finally:
            with self.lock:
                self.stop_pending = False
        return "torque_release_requested"

    def presets(self):
        return read_object(self.presets_path)

    def recordings(self):
        return read_object(self.recordings_path)

    def public_recordings(self, items=None):
        """Recordings plus the XY path the client traces: the start pose, then every step."""
        shown = {}
        for key, item in (self.recordings() if items is None else items).items():
            trace = []
            try:
                for pose in [item.get("start"), *(item.get("steps") or [])]:
                    xyz = position(pose)
                    trace.append({"x": round(xyz["x"], 2), "y": round(xyz["y"], 2)})
            except (AttributeError, TypeError, ValueError, KeyError):
                trace = []
            shown[key] = {**item, "trace": trace}
        return shown

    def check_revision(self, cfg):
        if cfg != self.config():
            refuse("robotics_settings_changed", "Les réglages ont changé, actualiser le poste")

    def clear_inspection(self):
        try:
            self.requires_inspection.unlink(missing_ok=True)
        except OSError:
            self.fault("uncertain")
            refuse("robotics_inspection_write", "Verrou d’inspection conservé", 503)

    def change_presets(self, cfg, data):
        items = self.presets()
        action, key = data.get("action"), data.get("id")
        existing = items.get(key) if isinstance(key, str) else None
        if action in ("rename", "delete") and not existing:
            refuse("robotics_preset_missing", "Position enregistrée introuvable", 404)
        if action == "delete":
            del items[key]
        elif action in ("save", "rename"):
            name = data.get("name")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64 or not name.isprintable():
                raise ValueError("Nom de position invalide")
            if action == "save":
                if len(items) >= MAX_PRESETS:
                    refuse("robotics_preset_limit", "Limite de positions atteinte")
                pose = self.resolve_pose(cfg, data)
                self.keepout_point(cfg, pose)
                key = secrets.token_hex(8)
                items[key] = {"pose": pose, "profile": PROFILE, "revision": cfg["revision"],
                              "created_at": time.time()}
            items[key]["name"] = name.strip()
            items[key]["updated_at"] = time.time()
        else:
            raise ValueError("Action de position inconnue")
        self.write(self.presets_path, items)
        return {"ok": True, "presets": items}

    @staticmethod
    def resample_trajectory(start, steps, *, max_step_deg=5.0):
        """Subdivide recorded segments into bounded <= max_step_deg waypoints."""
        resampled = []
        cursor = dict(start)
        for target in steps:
            delta = {k: target[k] - cursor[k] for k in JOINTS}
            biggest = max(abs(delta[k]) for k in JOINTS)
            parts = max(1, math.ceil(biggest / max(0.5, float(max_step_deg))))
            for index in range(1, parts + 1):
                t = index / parts
                resampled.append({k: round(cursor[k] + delta[k] * t, 3) for k in JOINTS})
            cursor = dict(target)
        return resampled

    def change_recordings(self, cfg, data):
        """Recorded click paths. They skip no check: every replay step goes through move()."""
        items = self.recordings()
        action, key = data.get("action"), data.get("id")
        existing = items.get(key) if isinstance(key, str) else None
        if action in ("rename", "delete", "update", "preflight") and not existing:
            refuse("robotics_recording_missing", "Script enregistré introuvable", 404)
        if action == "preflight":
            max_step = number(data.get("max_step_deg", cfg["step_limit"]), 0.5, cfg["step_limit"])
            start = validate_pose(existing["start"], cfg["joint_limits"], cfg["workspace"])
            raw_steps = [validate_pose(s, cfg["joint_limits"], cfg["workspace"]) for s in existing["steps"]]
            waypoints = self.resample_trajectory(start, raw_steps, max_step_deg=max_step)
            cursor = start
            min_clearance = None
            total_deg = 0.0
            for wp in waypoints:
                self.keepout_path(cfg, cursor, wp)
                validate_path(cursor, wp, cfg["joint_limits"], cfg["workspace"])
                clearance = async_box_clearance(cursor, wp, cfg.get("keepout") or [])
                if clearance["collision_zone"] or clearance.get("clearance_uncertain"):
                    zone_name = clearance["collision_zone"] or "d'exclusion"
                    refuse("robotics_keepout", f"Zone interdite « {zone_name} » sur le volume balayé", 409)
                if clearance["min_clearance_mm"] is not None:
                    min_clearance = clearance["min_clearance_mm"] if min_clearance is None else min(min_clearance, clearance["min_clearance_mm"])
                total_deg += max(abs(wp[k] - cursor[k]) for k in JOINTS)
                cursor = wp
            estimated_seconds = round(max(0.25, total_deg / (cfg["speed"] * 360 / 4096)), 2)
            return {
                "ok": True,
                "steps": waypoints,
                "step_count": len(waypoints),
                "min_clearance_mm": min_clearance,
                "estimated_seconds": estimated_seconds,
            }
        if action == "delete":
            del items[key]
        elif action == "update":
            steps = data.get("steps")
            if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_RECORD_STEPS:
                raise ValueError(f"Script de 1 à {MAX_RECORD_STEPS} poses requis")
            existing["steps"] = [validate_pose(step, cfg["joint_limits"], cfg["workspace"])
                                 for step in steps]
            if "tags" in data:
                existing["tags"] = tags(data["tags"])
            existing["updated_at"] = time.time()
        elif action in ("save", "rename"):
            name = data.get("name")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64 or not name.isprintable():
                raise ValueError("Nom de script invalide")
            if action == "save":
                if len(items) >= MAX_RECORDINGS:
                    refuse("robotics_recording_limit", "Limite de scripts atteinte")
                steps = data.get("steps")
                if not isinstance(steps, list) or not 1 <= len(steps) <= MAX_RECORD_STEPS:
                    raise ValueError(f"Script de 1 à {MAX_RECORD_STEPS} poses requis")
                start = validate_pose(data.get("start"), cfg["joint_limits"], cfg["workspace"])
                poses = [validate_pose(step, cfg["joint_limits"], cfg["workspace"]) for step in steps]
                key = secrets.token_hex(8)
                items[key] = {"name": name.strip(), "start": start, "steps": poses,
                              "tags": tags(data.get("tags")), "profile": PROFILE,
                              "revision": cfg["revision"], "created_at": time.time()}
            items[key]["name"] = name.strip()
            if "tags" in data:
                items[key]["tags"] = tags(data["tags"])
            items[key]["updated_at"] = time.time()
        else:
            raise ValueError("Action de script inconnue")
        self.write(self.recordings_path, items)
        return {"ok": True, "recordings": self.public_recordings(items)}

    def routines(self):
        return read_object(self.routines_path)

    def change_routines(self, cfg, data):
        """Saved simulation sequences. Steps are validated on save; loading copies them client-side."""
        if self.mode != "simulation":
            refuse("robotics_simulation_only", "Routines réservées à la simulation")
        items = self.routines()
        action, key = data.get("action"), data.get("id")
        existing = items.get(key) if isinstance(key, str) else None
        if action in ("rename", "delete") and not existing:
            refuse("robotics_routine_missing", "Routine introuvable", 404)
        if action == "delete":
            del items[key]
        elif action in ("save", "rename"):
            name = data.get("name")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 64 or not name.isprintable():
                raise ValueError("Nom de routine invalide")
            if action == "save":
                if len(items) >= MAX_ROUTINES:
                    refuse("robotics_routine_limit", "Limite de routines atteinte")
                steps = data.get("steps")
                if not isinstance(steps, list) or not 1 <= len(steps) <= 16 or not all(isinstance(s, dict) for s in steps):
                    raise ValueError("Routine de 1 à 16 positions requise")
                start = self.sim_pose.copy()
                poses = []
                for step in steps:
                    target = self.resolve_pose(cfg, step)
                    self.keepout_path(cfg, start, target)
                    validate_path(start, target, cfg["joint_limits"], cfg["workspace"])
                    poses.append(dict(target))
                    start = target
                key = secrets.token_hex(8)
                items[key] = {"name": name.strip(), "steps": [{"kind": "joints", "pose": pose} for pose in poses],
                              "parameters": routine_parameters(data.get("parameters")),
                              "start": self.sim_pose.copy(), "profile": PROFILE, "revision": cfg["revision"],
                              "created_at": time.time()}
            items[key]["name"] = name.strip()
            items[key]["updated_at"] = time.time()
        else:
            raise ValueError("Action de routine inconnue")
        self.write(self.routines_path, items)
        return {"ok": True, "routines": items}

    def sequence(self, cfg, data):
        if self.mode != "simulation":
            refuse("robotics_simulation_only", "Séquences réservées à la simulation")
        steps = data.get("steps")
        if not isinstance(steps, list) or not 1 <= len(steps) <= 16 or not all(isinstance(s, dict) for s in steps):
            raise ValueError("Séquence de 1 à 16 positions requise")
        start = self.sim_pose.copy()
        result = []
        for step in steps:
            target = self.resolve_pose(cfg, step)
            self.keepout_path(cfg, start, target)
            validate_path(start, target, cfg["joint_limits"], cfg["workspace"])
            result.append({"pose": target, "xyz": position(target)})
            start = target
        return {"ok": True, "steps": result}

    def ptz_command(self, cfg, data, local):
        """Pan or tilt the Tapo a little, or stop it. Independent of the arm: it never touches arming."""
        if not local:
            refuse("robotics_local_only", "Caméra réservée au réseau local direct", 403)
        if not self.camera_configured(cfg):
            refuse("robotics_camera_config", "Renseignez l’adresse et le compte de la caméra dans les réglages")
        direction = data.get("direction")
        if direction != "stop" and direction not in PTZ_DIRECTIONS:
            raise ValueError("Direction de caméra inconnue")
        pulse = number(data.get("ms", 400), 100, 800) / 1000
        if not self.ptz_lock.acquire(timeout=1.5):
            refuse("robotics_busy", "La caméra termine un mouvement", 429)
        try:
            if direction != "stop" and self.clock() - self.last_ptz < .15:
                refuse("robotics_busy", "Mouvement de caméra trop rapproché", 429)
            self.last_ptz = self.clock()
            camera = self.ptz_factory(cfg["camera_ip"], cfg["camera_user"], cfg["camera_password"], cfg["camera_timeout"])
            if direction == "stop":
                camera.stop()
            else:
                camera.pulse(direction, pulse)
        except DeviceError as error:
            refuse("robotics_ptz", str(error), 502)
        finally:
            self.ptz_lock.release()
        return {"ok": True}

    def ptz_presets(self, cfg, data, local):
        """List, store or recall absolute Tapo views. The camera keeps the preset; HQ stores no token."""
        if not local:
            refuse("robotics_local_only", "Caméra réservée au réseau local direct", 403)
        if not self.camera_configured(cfg):
            refuse("robotics_camera_config", "Renseignez l’adresse et le compte de la caméra dans les réglages")
        operation = data.get("op")
        if operation not in ("list", "save", "goto"):
            raise ValueError("Action de vue caméra inconnue")
        name = data.get("name")
        if operation == "save" and (not isinstance(name, str) or not 1 <= len(name.strip()) <= 64
                                   or not name.strip().isprintable()):
            raise ValueError("Nom de vue caméra invalide")
        token = data.get("token")
        if operation == "goto" and not isinstance(token, str):
            raise ValueError("Vue caméra invalide")
        if not self.ptz_lock.acquire(timeout=3):
            refuse("robotics_busy", "La caméra termine une commande", 429)
        try:
            camera = self.ptz_factory(cfg["camera_ip"], cfg["camera_user"],
                                      cfg["camera_password"], cfg["camera_timeout"])
            if operation == "list":
                return {"ok": True, "presets": camera.presets()}
            if operation == "save":
                return {"ok": True, "preset": camera.save_preset(name.strip())}
            camera.goto_preset(token)
            return {"ok": True}
        except DeviceError as error:
            refuse("robotics_ptz", str(error), 502)
        finally:
            self.ptz_lock.release()

    def night_command(self, cfg, data, local):
        """Read or set the Tapo's night vision (infrared) mode. Needs the Tapo cloud password: the camera's
        settings API does not accept the local camera account."""
        if not local:
            refuse("robotics_local_only", "Caméra réservée au réseau local direct", 403)
        if not (cfg["camera_ip"] and cfg["camera_cloud_password"]):
            refuse("robotics_camera_config", "Renseignez l’adresse et le mot de passe Tapo (cloud) dans les réglages")
        mode = data.get("mode")
        if mode != "read" and mode not in NIGHT_MODES:
            raise ValueError("Mode nuit inconnu")
        if not self.ptz_lock.acquire(timeout=3):
            refuse("robotics_busy", "La caméra termine une commande", 429)
        try:
            now = self.clock()
            if mode != "read" and now - self.last_tapo < .5:
                refuse("robotics_busy", "Commande de caméra trop rapprochée", 429)
            if now < self.tapo_pause[0]:
                refuse("robotics_camera_api", self.tapo_pause[1], 429)
            self.last_tapo = now
            for attempt in (1, 2):
                session = self.tapo_session
                if session is None or (session.address, session.password, getattr(session, "tls_sha256", "")) != (
                        cfg["camera_ip"], cfg["camera_cloud_password"], cfg["camera_tls_sha256"]):
                    tapo_kwargs = {"tls_sha256": cfg["camera_tls_sha256"]} if cfg.get("camera_tls_sha256") else {}
                    session = self.tapo_session = self.tapo_factory(cfg["camera_ip"], "admin",
                                                                     cfg["camera_cloud_password"], cfg["camera_timeout"],
                                                                     **tapo_kwargs)
                try:
                    return {"ok": True, "mode": session.night_mode(None if mode == "read" else mode)}
                except DeviceError as error:
                    self.tapo_session = None  # A stale session: log in again once, then give up.
                    text = str(error)
                    if "refusé" in text or "suspendue" in text:
                        # A wrong password or a lockout: retrying only makes the camera's lockout longer.
                        self.tapo_pause = (self.clock() + 90, text + ". Vérifiez le mot de passe Tapo (cloud), puis attendez.")
                        refuse("robotics_camera_api", text, 502)
                    if attempt == 2 or "injoignable" in text:
                        refuse("robotics_camera_api", text, 502)
        finally:
            self.ptz_lock.release()

    def video_command(self, cfg, action, data, session, local):
        if not local:
            refuse("robotics_local_only", "Caméra réservée au réseau local direct", 403)
        now = self.clock()
        if action == "camera/start":
            quality = data.get("quality", cfg["quality"])
            if not isinstance(quality, str) or quality not in TRACK:
                raise ValueError("Qualité vidéo invalide")
            if not self.camera_configured(cfg) or not executable(self.state_dir.parent):
                refuse("robotics_camera_config", "Configurer le compte Tapo et installer go2rtc")
            if self.video and now < self.video.expires:
                refuse("robotics_camera_busy", "Un flux caméra est déjà réservé")
            self.camera.stop()
            self.video_error = ""
            self.video = Stream(session, secrets.token_urlsafe(20), quality, now + 12)
            return {"ok": True, "stream": self.video.key}
        if not self.video or self.video.session != session or self.video.key != data.get("stream"):
            refuse("robotics_camera_expired", "Session vidéo expirée")
        if action == "camera/frame":
            if now >= self.video.expires or not self.video.opened or now - self.video.last_bytes >= 3:
                refuse("robotics_camera_expired", "Flux caméra interrompu")
            if now - self.video.last_frame < .4:
                return {"ok": True}
            self.video.last_frame = now
            self.video.expires = now + 5
        elif action == "camera/stop":
            self.video = None
            self.camera.stop()
            if self.mode == "hardware" and self.lease and self.lease.session == session:
                self.disarm("disarmed")
        else:
            refuse("robotics_route", "Route Robotique inconnue", 404)
        return {"ok": True}

    def audio_command(self, cfg, data, session, local, authorized):
        if not local:
            refuse("robotics_local_only", "Caméra réservée au réseau local direct", 403)
        mode = data.get("mode")
        if mode not in ("listen", "talk"):
            raise ValueError("Mode audio inconnu")
        talk = mode == "talk"
        if talk and not cfg["camera_cloud_password"]:
            refuse("robotics_camera_config", "Renseignez le mot de passe Tapo (cloud) dans les réglages")
        with self.lock:
            stream = self.video
            if (not stream or stream.session != session or stream.key != data.get("stream")
                    or not stream.opened or self.clock() >= stream.expires):
                refuse("robotics_camera_expired", "Session vidéo expirée", 403)
        try:
            answer = self.camera.audio_answer(stream.key, data.get("offer"), talk)
        except DeviceError as error:
            refuse("robotics_audio", str(error), 502)
        if not authorized() or not self.video_alive(stream):
            refuse("robotics_camera_expired", "Session vidéo expirée", 403)
        return {"ok": True, "answer": answer}

    def release_session(self, session):
        with self.lock:
            if self.lease and self.lease.session == session:
                self.disarm("disarmed")
            if self.video and self.video.session == session:
                self.video = None
                self.camera.stop()

    def open_video(self, session, key, local):
        with self.lock:
            if (not local or not self.video or self.video.session != session or self.video.key != key
                    or self.clock() >= self.video.expires or self.video.opened):
                refuse("robotics_camera_expired", "Session vidéo expirée", 403)
            self.video.opened = True
            return self.config(), self.video

    def video_alive(self, stream):
        with self.lock:
            return self.video is stream and self.clock() < stream.expires

    def video_bytes(self, stream):
        with self.lock:
            stream.last_bytes = self.clock()

    def close_video(self, stream, failed):
        with self.lock:
            if self.video is stream:
                self.video = None
                self.video_error = "Flux vidéo interrompu" if failed else ""
                if self.mode == "hardware" and self.lease and self.lease.session == stream.session:
                    self.disarm("disarmed")

    def dispatch(self, action, method, data, session, *, physical, local, authorized, owner=""):
        if action in ("camera/ptz", "camera/ptz-preset", "camera/night", "camera/audio") and method == "POST":
            # Camera I/O must never delay STOP or a status read.
            if not authorized():
                self.release_session(session)
                refuse("robotics_authorization", "Autorisation expirée", 403)
            with self.lock:
                cfg = self.config()
            if action == "camera/audio":
                return self.audio_command(cfg, data, session, local, authorized)
            if action == "camera/night":
                return self.night_command(cfg, data, local)
            if action == "camera/ptz-preset":
                return self.ptz_presets(cfg, data, local)
            return self.ptz_command(cfg, data, local)
        with self.lock:
            cfg = self.config()
            self.current_mode = cfg["mode"]
            self.camera_required = cfg["camera_required"]
            self.expire()
            if method == "GET":
                if action == "status":
                    return self.status(cfg, session, data.get("lease"), physical, local)
                if action == "presets":
                    return {"ok": True, "presets": self.presets()}
                if action == "recordings":
                    return {"ok": True, "recordings": self.public_recordings()}
                if action == "routines":
                    return {"ok": True, "routines": self.routines()}
                if action == "blackbox":
                    return {"ok": True, "entries": list(self.blackbox), "capacity": BLACKBOX_SAMPLES}
                refuse("robotics_route", "Route Robotique inconnue", 404)
            if method != "POST":
                refuse("robotics_method", "Méthode Robotique invalide", 405)
            if not authorized():
                self.release_session(session)
                refuse("robotics_authorization", "Autorisation expirée", 403)
            if action == "arm":
                return self.arm(cfg, session, physical, authorized)
            if action == "settings":
                if not physical:
                    refuse("robotics_local_only", "Réglages réservés au PC HQ", 403)
                if (self.lease or self.motion or self.uncertain or self.stop_latched or self.io.locked()
                        or self.requires_inspection.exists()):
                    refuse("robotics_busy", "Terminer le mouvement et désarmer avant les réglages")
                new = settings(data, cfg, resolve=True)
                new["revision"] = secrets.token_hex(12)
                self.write(self.config_path, new)
                self.camera.stop()
                self.epoch += 1
                self.video = self.feedback = self.target = None
                self.feedback_at = -math.inf
                self.estop_state = None
                self.estop_at = -math.inf
                self.sim_pose = HOME.copy()
                self.current_mode = new["mode"]
                self.camera_required = new["camera_required"]
                self.record("settings")
                return {"ok": True, "config": self.public_config(new)}
            if action.startswith("camera/"):
                return self.video_command(cfg, action, data, session, local)
            if action == "presets":
                return self.change_presets(cfg, data)
            if action == "recordings":
                return self.change_recordings(cfg, data)
            if action == "routines":
                return self.change_routines(cfg, data)
            if action == "preview":
                pose = self.resolve_pose(cfg, data)
                self.keepout_point(cfg, pose)
                start = self.sim_pose if cfg["mode"] == "simulation" else (self.feedback or {}).get("actual")
                clearance = None
                if start:
                    self.keepout_path(cfg, start, pose)
                    clearance = async_box_clearance(start, pose, cfg.get("keepout") or [])
                return {
                    "ok": True,
                    "pose": pose,
                    "xyz": position(pose),
                    "links": link_positions(pose),
                    "clearance": clearance,
                }
            if action == "sequence":
                return self.sequence(cfg, data)
            if action == "reset":
                if self.mode == "hardware" and (not physical or data.get("inspected") is not True):
                    refuse("robotics_inspect", "Confirmer l’inspection sur le PC HQ", 403)
                if self.io.locked() or self.motion or self.lease or self.stop_pending or self.active_stream_id is not None:
                    refuse("robotics_busy", "Poste de commande occupé")
                self.epoch += 1
                self.pending_stream_id = None
                self.uncertain = self.stop_latched = False
                self.physical_command_sent = False
                self.commanded_start = None
                self.last_settled_pose = None
                self.last_settled_at = -math.inf
                self.feedback = self.target = None
                self.estop_state = None
                if self.mode == "hardware":
                    self.clear_inspection()
                return {"ok": True}
        stop_result = None
        if action == "telemetry":
            self.probe(cfg, physical)
        elif action == "move":
            self.move(cfg, data, session, physical, authorized, owner)
        elif action in ("cancel", "stop"):
            stop_result = self.stop(cfg, data, session, physical, authorized, emergency=action == "stop")
        else:
            refuse("robotics_route", "Route Robotique inconnue", 404)
        with self.lock:
            status = self.status(self.config(), session, data.get("lease"), physical, local)
            if stop_result:
                status["stop_result"] = stop_result
            return status


_instances = {}
_instances_lock = threading.Lock()


def controller(root):
    with _instances_lock:
        if root not in _instances:
            _instances[root] = Robotics(root)
        return _instances[root]


def shutdown():
    with _instances_lock:
        for lab in _instances.values():
            lab.close()
