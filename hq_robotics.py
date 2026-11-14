"""Transfert HQ Robotics state machine. The bridge supplies auth and HTTP framing."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import json
import math
from pathlib import Path
import secrets
import threading
import time

import hq_state
from hq_robotics_arm import (DeviceError, HOME, HttpArm, JOINTS, LIMITS, WORKSPACE, cartesian,
                             device_ip, number, pinned_ip, position, validate_path, validate_pose)
from hq_robotics_camera import Camera, TRACK, executable

PREFIX = "/api/robotics/"
PROFILE = "m2s-gripper-v1"
LEASE_SECONDS = 20
TICKET_SECONDS = 4
MIN_INTERVAL = .5
FEEDBACK_MAX_AGE = 2.5
MAX_PRESETS = 64
DEFAULTS = {
    "revision": "", "mode": "simulation", "transport": "http", "arm_ip": "",
    "serial_port": "", "arm_timeout": .8, "camera_ip": "", "camera_user": "",
    "camera_password": "", "camera_timeout": 6, "quality": "standard",
    "joint_limits": LIMITS, "workspace": WORKSPACE, "speed": 100,
    "acceleration": 4, "step_limit": 5,
}
LABELS = {
    "armed": "Autorisation de mouvement", "disarmed": "Autorisation relâchée",
    "moving": "Cible envoyée", "reached": "Cible atteinte", "cancelled": "Annulation demandée",
    "stopped": "Arrêt logiciel", "uncertain": "Mouvement incertain",
    "settings": "Réglages enregistrés", "feedback_failed": "Retour matériel indisponible",
}


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
    for key, limit in (("camera_user", 64), ("camera_password", 128), ("serial_port", 32)):
        value = cfg[key]
        if not isinstance(value, str) or len(value) > limit or any(ord(ch) < 32 for ch in value):
            raise ValueError("Paramètre de connexion invalide")
    if not isinstance(cfg["quality"], str) or cfg["quality"] not in TRACK:
        raise ValueError("Qualité vidéo invalide")
    cfg["arm_timeout"] = number(cfg["arm_timeout"], .2, 1.5)
    cfg["camera_timeout"] = number(cfg["camera_timeout"], 2, 12)
    cfg["speed"] = int(number(cfg["speed"], 40, 200))
    cfg["acceleration"] = int(number(cfg["acceleration"], 1, 8))
    cfg["step_limit"] = number(cfg["step_limit"], 1, 8)
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
    def __init__(self, root, *, clock=time.monotonic, arm_factory=HttpArm, camera=None):
        self.state_dir = hq_state.agent_state_dir(root)
        self.config_path = self.state_dir / "robotics.json"
        self.presets_path = self.state_dir / "robotics-presets.json"
        self.commission_path = self.state_dir / "robotics-commission.json"
        self.camera = camera if camera is not None else Camera(root)
        self.clock = clock
        self.arm_factory = arm_factory
        self.lock = threading.RLock()
        self.io = threading.Lock()
        self.lease = None
        self.video = None
        self.video_error = ""
        self.history = deque(maxlen=24)
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
        self.current_mode = "simulation"
        self.requires_inspection = self.state_dir / "robotics-inspection.json"

    def config(self):
        raw = read_object(self.config_path)
        try:
            return settings({key: val for key, val in raw.items() if key != "revision"},
                            {**DEFAULTS, "revision": raw.get("revision", "")})
        except (ValueError, TypeError):
            refuse("robotics_state_unreadable", "Réglages Robotique invalides, fichier conservé", 503)

    def public_config(self, cfg):
        return {**{k: v for k, v in cfg.items() if k not in {"camera_user", "camera_password"}},
                "camera_configured": self.camera_configured(cfg), "profile": PROFILE}

    @staticmethod
    def camera_configured(cfg):
        return bool(cfg["camera_ip"] and cfg["camera_user"] and cfg["camera_password"])

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
                           (self.mode == "hardware" and not self.video_live(self.lease.session))):
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
        if self.mode == "simulation" and self.motion:
            self.motion = None
            self.target = self.sim_pose.copy()
        if self.lease or kind != "disarmed":
            self.record(kind)
        self.lease = None

    def fault(self, kind):
        self.uncertain = self.uncertain or bool(self.motion)
        self.motion = None
        self.lease = None
        self.feedback = None
        self.record(kind)

    def owner(self, session, key):
        return bool(self.lease and self.lease.session == session and
                    isinstance(key, str) and self.lease.key == key)

    def video_live(self, session):
        now = self.clock()
        return bool(self.video and self.video.session == session and self.video.opened and
                    now < self.video.expires and now - self.video.last_bytes < 3 and
                    now - self.video.last_frame < 2.5)

    def status(self, cfg, session, key, physical, camera_local):
        now = self.clock()
        self.expire()
        owner = self.owner(session, key)
        if (owner and not self.motion and now - self.last_move >= MIN_INTERVAL
                and (not self.lease.ticket or now >= self.lease.ticket_until)):
            self.lease.ticket = secrets.token_urlsafe(18)
            self.lease.ticket_until = now + TICKET_SECONDS
        feedback = self.feedback if now - self.feedback_at < FEEDBACK_MAX_AGE else None
        if self.mode == "simulation":
            feedback = {"source": "simulation", "actual": self.sim_pose.copy(),
                        "xyz": position(self.sim_pose)}
        return {
            "ok": True, "config": self.public_config(cfg), "physical_local": physical,
            "commissioned": physical and self.commissioned(cfg), "camera_local": camera_local,
            "gateway": bool(executable(self.state_dir.parent)), "camera_live": self.video_live(session),
            "camera_error": self.video_error, "feedback": feedback,
            "last_feedback": (time.time() - (now - self.feedback_at)
                              if self.feedback_at > -math.inf and self.mode == "hardware" else None),
            "latency_ms": self.feedback.get("latency_ms") if feedback and self.mode == "hardware" else None,
            "target": self.target, "moving": bool(self.motion), "armed": owner,
            "occupied": bool(self.lease and not owner),
            "uncertain": self.uncertain or (self.mode == "hardware" and not self.motion
                                            and self.requires_inspection.exists()),
            "stop_latched": self.stop_latched,
            "ticket": self.lease.ticket if owner and now < self.lease.ticket_until else "",
            "history": list(self.history),
        }

    def arm(self, cfg, session, physical, authorized):
        with self.lock:
            self.expire()
            if self.lease or self.motion or self.stop_pending or self.io.locked():
                refuse("robotics_busy", "Poste de commande occupé")
            if self.stop_latched or self.uncertain or (self.mode == "hardware" and self.requires_inspection.exists()):
                refuse("robotics_inspect", "Inspection sur place et réarmement manuel requis")
            if not authorized():
                refuse("robotics_authorization", "Autorisation expirée", 403)
            if self.mode == "hardware":
                self.require_physical(cfg, physical)
                self.require_feedback()
                if not self.video_live(session):
                    refuse("robotics_camera_required", "Flux vidéo actif requis pour armer")
            now = self.clock()
            key = secrets.token_urlsafe(24)
            self.lease = Lease(session, key, now + LEASE_SECONDS)
            self.record("armed")
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
            if now - self.last_probe < MIN_INTERVAL or self.stop_pending or not self.io.acquire(False):
                refuse("robotics_busy", "Lecture RoArm occupée", 429)
            self.last_probe = now
        try:
            self.read_feedback(cfg)
        finally:
            self.io.release()

    def read_feedback(self, cfg):
        now = self.clock()
        try:
            value = self.arm_factory(cfg["arm_ip"], cfg["arm_timeout"]).feedback()
        except DeviceError:
            with self.lock:
                self.fault("feedback_failed")
            raise
        with self.lock:
            self.expire()
            self.feedback_at = self.clock()
            value["latency_ms"] = round((self.feedback_at - now) * 1000)
            self.feedback = value
            if self.motion and all(abs(value["actual"][k] - self.target[k]) <= 1.0 for k in JOINTS):
                self.clear_inspection()
                self.motion = None
                self.record("reached")
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
            now = self.clock()
            if not isinstance(ticket, str) or not ticket or ticket != self.lease.ticket or now >= self.lease.ticket_until:
                refuse("robotics_stale", "Commande expirée ou déjà utilisée")
            if self.motion or self.stop_pending or now - self.last_move < MIN_INTERVAL or self.io.locked():
                refuse("robotics_busy", "Mouvement ou lecture déjà en cours", 429)
            if data.get("kind") == "reviewed_script":
                from hq_robotics_assistant import resolve_step
                pose, speed = resolve_step(self, cfg, owner, data)
            else:
                pose = self.resolve_pose(cfg, data)
                speed = int(number(data.get("speed", cfg["speed"]), 40, cfg["speed"]))
            self.lease.ticket = ""
            self.last_move = now
            if cfg["mode"] == "simulation":
                start = self.sim_pose.copy()
                validate_path(start, pose, cfg["joint_limits"], cfg["workspace"])
                delta = max(abs(pose[k] - start[k]) for k in JOINTS)
                duration = max(.25, delta / (speed * 360 / 4096))
                self.target = pose
                self.motion = (start, pose, now, now + duration)
                self.record("moving")
                return
            self.require_physical(cfg, physical)
            if not self.video_live(session):
                refuse("robotics_camera_required", "Flux vidéo interrompu")
            self.require_feedback()
            self.io.acquire()
        try:
            feedback = self.read_feedback(cfg)
            start = feedback["actual"]
            with self.lock:
                self.expire()
                if not self.owner(session, key) or not authorized() or self.stop_pending:
                    refuse("robotics_disarmed", "Autorisation relâchée avant envoi", 403)
                if feedback["torque"] and (set(feedback["torque"]) != set(JOINTS)
                                           or any(value != 1 for value in feedback["torque"].values())):
                    refuse("robotics_torque", "Couple matériel indisponible")
                delta = max(abs(pose[k] - start[k]) for k in JOINTS)
                if delta > cfg["step_limit"]:
                    refuse("robotics_step_limit", "Cible trop éloignée pour un déplacement physique")
                # Allow for servo quantization and independent axes.
                limits = {k: (lo + .2, hi - .2) for k, (lo, hi) in cfg["joint_limits"].items()}
                workspace = {k: (lo + 4, hi - 4) for k, (lo, hi) in cfg["workspace"].items()}
                validate_path(start, pose, limits, workspace, independent_axes=True)
                if delta <= 1.0:
                    self.target = pose
                    self.record("reached")
                    return
                self.write(self.requires_inspection, {"pending": True})
                if self.clock() >= self.lease.ticket_until or not self.video_live(session) or not authorized():
                    self.clear_inspection()
                    self.disarm("disarmed")
                    refuse("robotics_stale", "Autorisation expirée avant envoi")
                self.target = pose
                self.motion = self.clock() + 4
                self.record("moving")
            try:
                self.arm_factory(cfg["arm_ip"], cfg["arm_timeout"]).move(pose, speed, cfg["acceleration"])
            except DeviceError:
                with self.lock:
                    self.fault("uncertain")
                raise
        finally:
            self.io.release()

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
            self.last_stop = self.clock()
            self.motion = None
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
                key = secrets.token_hex(8)
                items[key] = {"pose": pose, "profile": PROFILE, "revision": cfg["revision"],
                              "created_at": time.time()}
            items[key]["name"] = name.strip()
            items[key]["updated_at"] = time.time()
        else:
            raise ValueError("Action de position inconnue")
        self.write(self.presets_path, items)
        return {"ok": True, "presets": items}

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
            validate_path(start, target, cfg["joint_limits"], cfg["workspace"])
            result.append({"pose": target, "xyz": position(target)})
            start = target
        return {"ok": True, "steps": result}

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
        with self.lock:
            cfg = self.config()
            self.current_mode = cfg["mode"]
            self.expire()
            if method == "GET":
                if action == "status":
                    return self.status(cfg, session, data.get("lease"), physical, local)
                if action == "presets":
                    return {"ok": True, "presets": self.presets()}
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
                self.video = self.feedback = self.target = None
                self.feedback_at = -math.inf
                self.sim_pose = HOME.copy()
                self.current_mode = new["mode"]
                self.record("settings")
                return {"ok": True, "config": self.public_config(new)}
            if action.startswith("camera/"):
                return self.video_command(cfg, action, data, session, local)
            if action == "presets":
                return self.change_presets(cfg, data)
            if action == "preview":
                pose = self.resolve_pose(cfg, data)
                return {"ok": True, "pose": pose, "xyz": position(pose)}
            if action == "sequence":
                return self.sequence(cfg, data)
            if action == "reset":
                if self.mode == "hardware" and (not physical or data.get("inspected") is not True):
                    refuse("robotics_inspect", "Confirmer l’inspection sur le PC HQ", 403)
                if self.io.locked() or self.motion or self.lease or self.stop_pending:
                    refuse("robotics_busy", "Poste de commande occupé")
                self.uncertain = self.stop_latched = False
                self.feedback = self.target = None
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
            lab.camera.close()
