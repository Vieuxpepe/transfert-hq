"""Bambu Lab LAN adapter (A1 / A1 mini / P1) — standard library only.

Status: MQTT 3.1.1 over TLS on port 8883, user ``bblp``, password = the
printer's access code. The printer pushes partial JSON reports on
``device/<serial>/report``; we merge them into one picture.

Camera (A1 / P1): TLS on port 6000, an 80-byte auth packet, then frames of a
16-byte header + one JPEG.

The printer serves a self-signed certificate, so verification is off — the
only defence is that we connect to the pinned private IPv4 from the config and
nothing else. Current firmware accepts third-party LAN clients only in
"LAN only" + "Developer mode".
"""
from __future__ import annotations

import ftplib
import json
import re
import socket
import ssl
import struct
import threading
import time
from typing import Any, Callable

MQTT_PORT = 8883
CAMERA_PORT = 6000
USERNAME = "bblp"
CONNECT_TIMEOUT = 8.0
KEEPALIVE = 30
MAX_PACKET = 1 << 20          # a full pushall report is ~10-40 KiB
MAX_FRAME = 4 << 20

_COMMANDS: dict[str, dict[str, Any]] = {
    "pause": {"print": {"command": "pause", "param": ""}},
    "resume": {"print": {"command": "resume", "param": ""}},
    "stop": {"print": {"command": "stop", "param": ""}},
    "light_on": {"system": {"command": "ledctrl", "led_node": "chamber_light", "led_mode": "on",
                            "led_on_time": 500, "led_off_time": 500, "loop_times": 0,
                            "interval_time": 0}},
    "light_off": {"system": {"command": "ledctrl", "led_node": "chamber_light", "led_mode": "off",
                             "led_on_time": 500, "led_off_time": 500, "loop_times": 0,
                             "interval_time": 0}},
}


class BambuError(Exception):
    """Fixed, safe message only: nothing from the wire crosses into an API reply."""


def _tls_context() -> ssl.SSLContext:
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _open_tls(ip: str, port: int, timeout: float = CONNECT_TIMEOUT,
              *, expected_fp: str = "", on_pin: Callable[[str], None] | None = None) -> ssl.SSLSocket:
    import hashlib
    raw = socket.create_connection((ip, port), timeout=timeout)
    try:
        sock = _tls_context().wrap_socket(raw, server_hostname=None)
    except Exception:
        raw.close()
        raise
    try:
        der = sock.getpeercert(binary_form=True)
        fp = hashlib.sha256(der).hexdigest() if der else ""
        if expected_fp and not fp:
            raise BambuError("Certificat TLS absent (pinning requis)")
        if expected_fp and fp != expected_fp:
            raise BambuError("Certificat TLS de l'imprimante modifié (pinning refusé)")
        if not expected_fp and fp and on_pin is not None:
            on_pin(fp)
    except Exception:
        sock.close()
        raise
    return sock


# ── MQTT packet codec ──────────────────────────────────────────────────────

def encode_length(n: int) -> bytes:
    if n < 0 or n > 268_435_455:
        raise ValueError("MQTT length out of range")
    out = bytearray()
    while True:
        byte = n % 128
        n //= 128
        if n:
            byte |= 0x80
        out.append(byte)
        if not n:
            return bytes(out)


def _utf8(text: str) -> bytes:
    data = text.encode("utf-8")
    return struct.pack("!H", len(data)) + data


def packet(kind: int, body: bytes) -> bytes:
    return bytes([kind]) + encode_length(len(body)) + body


def connect_packet(client_id: str, username: str, password: str, keepalive: int = KEEPALIVE) -> bytes:
    flags = 0x80 | 0x40 | 0x02          # username, password, clean session
    header = _utf8("MQTT") + bytes([4, flags]) + struct.pack("!H", keepalive)
    return packet(0x10, header + _utf8(client_id) + _utf8(username) + _utf8(password))


def subscribe_packet(packet_id: int, topic: str) -> bytes:
    return packet(0x82, struct.pack("!H", packet_id) + _utf8(topic) + b"\x00")


def publish_packet(topic: str, payload: bytes) -> bytes:
    return packet(0x30, _utf8(topic) + payload)


PINGREQ = b"\xc0\x00"


def read_packet(recv: Callable[[int], bytes], first: int | None = None) -> tuple[int, bytes]:
    """Read one packet with ``recv(n)`` (exactly n bytes). Returns (type byte, body).

    ``first`` is the type byte when the caller has already read it (so that an idle timeout
    can only ever happen between two packets, never half-way through one)."""
    if first is None:
        first = recv(1)[0]
    mult, length = 1, 0
    for _ in range(4):
        byte = recv(1)[0]
        length += (byte & 0x7F) * mult
        if not byte & 0x80:
            break
        mult *= 128
    else:
        raise BambuError("Paquet MQTT invalide")
    if length > MAX_PACKET:
        raise BambuError("Paquet MQTT trop grand")
    return first, (recv(length) if length else b"")


def parse_publish(first: int, body: bytes) -> tuple[str, bytes]:
    if len(body) < 2:
        raise BambuError("Paquet MQTT invalide")
    tlen = struct.unpack("!H", body[:2])[0]
    topic = body[2:2 + tlen].decode("utf-8", "replace")
    rest = body[2 + tlen:]
    if (first >> 1) & 0x03:              # QoS > 0 carries a packet id
        rest = rest[2:]
    return topic, rest


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("closed")
        buf.extend(chunk)
    return bytes(buf)


# ── Report merge and normalisation ─────────────────────────────────────────

def deep_merge(base: dict[str, Any], delta: dict[str, Any]) -> dict[str, Any]:
    for key, value in delta.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            deep_merge(base[key], value)
        else:
            base[key] = value
    return base


_STATE_MAP = {"IDLE": "idle", "RUNNING": "printing", "PREPARE": "preparing", "SLICING": "preparing",
              "PAUSE": "paused", "FINISH": "finished", "FAILED": "failed"}


def _num(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def _colour(raw: Any) -> str:
    text = str(raw or "")
    return "#" + text[:6].upper() if len(text) >= 6 and all(c in "0123456789abcdefABCDEF" for c in text[:6]) else ""


def _hms_ecode(entry: dict[str, Any]) -> str:
    try:
        attr, code = int(entry.get("attr")), int(entry.get("code"))
    except (TypeError, ValueError):
        return ""
    if not (0 <= attr <= 0xFFFFFFFF and 0 <= code <= 0xFFFFFFFF):
        return ""
    return f"{attr:08X}{code:08X}"


_STAGE_MAP = {
    0: "En attente",
    1: "Nivellement automatique",
    2: "Préchauffage du plateau",
    3: "Balayage mécanique XY",
    4: "Changement de filament",
    5: "Pause M400",
    6: "Pause — fin de filament",
    7: "Chauffe de la buse",
    8: "Calibration d'extrusion",
    9: "Scan du plateau",
    10: "Inspection première couche",
    11: "Identification du plateau",
    13: "Mise à l'origine",
    14: "Nettoyage de la buse",
    15: "Vérification température buse",
    16: "En pause (utilisateur)",
    17: "Capot avant ouvert",
    19: "Calibration micro-lidar",
    20: "Calibration débit",
    21: "Erreur température buse",
    22: "Erreur température plateau",
}


def _fan_pct(raw: Any) -> int | None:
    v = _num(raw)
    if v is None:
        return None
    if v <= 15:
        return max(0, min(100, round(v * 100.0 / 15.0)))
    return max(0, min(100, round(v)))


def _plate_of(gcode_file: Any) -> int:
    m = re.search(r"plate_(\d{1,2})\.gcode", str(gcode_file or ""))
    return int(m.group(1)) if m else 1


def normalise(report: dict[str, Any]) -> dict[str, Any]:
    """The merged ``print`` block as the common printer status shape."""
    p = report.get("print") if isinstance(report.get("print"), dict) else {}
    state = _STATE_MAP.get(str(p.get("gcode_state") or "").upper(), "unknown")
    light = None
    for row in p.get("lights_report") or []:
        if isinstance(row, dict) and row.get("node") == "chamber_light":
            light = row.get("mode") == "on"
    ams_slots: list[dict[str, Any]] = []
    ams = p.get("ams") if isinstance(p.get("ams"), dict) else {}
    active_tray = str(ams.get("tray_now") or "")
    for unit in ams.get("ams") or []:
        if not isinstance(unit, dict):
            continue
        for tray in unit.get("tray") or []:
            if not isinstance(tray, dict):
                continue
            try:
                global_id = int(unit.get("id") or 0) * 4 + int(tray.get("id") or 0)
            except (TypeError, ValueError):
                continue
            # Some firmwares leave tray_type empty yet name the spool in the sub-brand; the name is
            # proof enough that a spool sits there, so use it instead of declaring the slot empty.
            name = str(tray.get("tray_type") or "").strip()
            if not name:
                name = str(tray.get("tray_sub_brands") or tray.get("tray_id_name") or "").strip()
            ams_slots.append({
                "slot": global_id + 1,
                "material": name[:24],
                "colour": _colour(tray.get("tray_color")),
                "remain": _num(tray.get("remain")),
                "active": active_tray == str(global_id),
                "loaded": bool(name),
            })
    vt = p.get("vt_tray") if isinstance(p.get("vt_tray"), dict) else None
    external = None
    if vt and vt.get("tray_type"):
        external = {"material": str(vt.get("tray_type") or "")[:24], "colour": _colour(vt.get("tray_color"))}
    remaining_min = _num(p.get("mc_remaining_time"))
    hms = [h for h in (p.get("hms") or []) if isinstance(h, dict)]
    hms_codes = [c for c in (_hms_ecode(h) for h in hms) if c][:16]
    err = p.get("print_error")
    stg_raw = _num(p.get("stg_cur"))
    stg_id = int(stg_raw) if stg_raw is not None else None
    stage_label = _STAGE_MAP.get(stg_id, "") if stg_id is not None and stg_id != 255 else ""
    skipped = [int(x) for x in (p.get("s_obj") or []) if isinstance(x, (int, float)) or (isinstance(x, str) and x.isdigit())][:64]
    return {
        "state": state,
        "job": str(p.get("subtask_name") or p.get("gcode_file") or "")[:160],
        "progress": _num(p.get("mc_percent")),
        "layer": _num(p.get("layer_num")),
        "total_layers": _num(p.get("total_layer_num")),
        "remaining_sec": int(remaining_min * 60) if remaining_min is not None else None,
        "nozzle": _num(p.get("nozzle_temper")),
        "nozzle_target": _num(p.get("nozzle_target_temper")),
        "bed": _num(p.get("bed_temper")),
        "bed_target": _num(p.get("bed_target_temper")),
        "light": light,
        "speed_level": _num(p.get("spd_lvl")),
        "stage": stg_id,
        "stage_label": stage_label,
        "fans": {
            "part": _fan_pct(p.get("cooling_fan_speed")),
            "aux": _fan_pct(p.get("big_fan1_speed")),
            "chamber": _fan_pct(p.get("big_fan2_speed")),
        },
        "skipped_objects": skipped,
        "print_type": str(p.get("print_type") or "")[:24],
        "ams": ams_slots,
        "external_spool": external,
        "error_code": int(err) if isinstance(err, int) and err else None,
        "error_ecode": f"{int(err) & 0xFFFFFFFF:08X}" if isinstance(err, int) and not isinstance(err, bool) and err else "",
        "hms": hms_codes,
        "hms_count": len(hms),
        "wifi": str(p.get("wifi_signal") or "")[:12],
        "plate": _plate_of(p.get("gcode_file")),
        "est_weight_g": None, "est_len_m": None, "materials": [], "counter_m": None,
    }


# ── Live link (one per printer) ────────────────────────────────────────────

class BambuLink:
    """Keeps one MQTT session open, reconnecting with backoff, until ``stop()``."""

    def __init__(self, ip: str, serial: str, access_code: str,
                 on_status: Callable[[dict[str, Any]], None],
                 on_link: Callable[[bool, str], None],
                 *, tls_fp: str = "", on_pin: Callable[[str], None] | None = None) -> None:
        self.ip, self.serial, self._code = ip, serial, access_code
        self._on_status, self._on_link = on_status, on_link
        self._tls_fp, self._on_pin = tls_fp, on_pin
        self._report: dict[str, Any] = {}
        self._sock: ssl.SSLSocket | None = None
        self._send_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=f"bambu-{serial[-4:]}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def alive(self) -> bool:
        return self._thread.is_alive()

    def stop(self) -> None:
        self._stop.set()
        sock = self._sock
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass

    def _send(self, data: bytes) -> None:
        sock = self._sock
        if sock is None:
            raise BambuError("Imprimante hors ligne")
        with self._send_lock:
            sock.sendall(data)

    def command(self, name: str) -> None:
        template = _COMMANDS.get(name)
        if template is None:
            raise BambuError("Commande inconnue")
        payload = json.loads(json.dumps(template))
        for block in payload.values():
            block["sequence_id"] = str(int(time.time()) % 100000)
        try:
            self._send(publish_packet(f"device/{self.serial}/request", json.dumps(payload).encode()))
        except OSError as exc:
            raise BambuError("Imprimante injoignable") from exc

    def control(self, action: str, params: dict[str, Any] | None = None) -> None:
        """Direct operator controls beyond the five basic commands."""
        if action in _COMMANDS:
            self.command(action)
            return
        args = params if isinstance(params, dict) else {}
        seq = str(int(time.time()) % 100000)
        if action == "speed":
            try:
                lvl = int(args.get("level"))
            except (TypeError, ValueError):
                raise BambuError("Niveau de vitesse invalide") from None
            if lvl not in (1, 2, 3, 4):
                raise BambuError("Niveau de vitesse invalide (1–4)")
            payload: dict[str, Any] = {"print": {"sequence_id": seq, "command": "print_speed", "param": str(lvl)}}
        elif action == "nozzle_temp":
            try:
                temp = int(args.get("temp"))
            except (TypeError, ValueError):
                raise BambuError("Température buse invalide") from None
            if temp < 0 or temp > 300:
                raise BambuError("Température buse hors limites (0–300 °C)")
            payload = {"print": {"sequence_id": seq, "command": "gcode_line", "param": f"M104 S{temp}\n"}}
        elif action == "bed_temp":
            try:
                temp = int(args.get("temp"))
            except (TypeError, ValueError):
                raise BambuError("Température plateau invalide") from None
            if temp < 0 or temp > 110:
                raise BambuError("Température plateau hors limites (0–110 °C)")
            payload = {"print": {"sequence_id": seq, "command": "gcode_line", "param": f"M140 S{temp}\n"}}
        elif action == "fan":
            fan = str(args.get("fan") or "part").strip().lower()
            fan_idx = {"part": 0, "aux": 2, "chamber": 3}.get(fan)
            if fan_idx is None:
                raise BambuError("Ventilateur inconnu")
            try:
                pct = int(args.get("pct"))
            except (TypeError, ValueError):
                raise BambuError("Vitesse de ventilateur invalide") from None
            if pct < 0 or pct > 100:
                raise BambuError("Pourcentage ventilateur hors limites (0–100)")
            pwm = round(pct * 255 / 100)
            payload = {"print": {"sequence_id": seq, "command": "gcode_line", "param": f"M106 P{fan_idx} S{pwm}\n"}}
        elif action == "skip_objects":
            raw_ids = args.get("ids")
            if not isinstance(raw_ids, list) or not raw_ids:
                raise BambuError("Liste d'objets à ignorer vide")
            try:
                obj_ids = [int(x) for x in raw_ids[:64]]
            except (TypeError, ValueError):
                raise BambuError("Identifiants d'objet invalides") from None
            payload = {"print": {"sequence_id": seq, "command": "skip_objects", "obj_list": obj_ids}}
        elif action == "ams_load":
            cur_state = normalise(self._report).get("state")
            if cur_state != "idle":
                raise BambuError("Chargement AMS autorisé uniquement au repos (idle)")
            try:
                slot = int(args.get("slot"))
            except (TypeError, ValueError):
                raise BambuError("Fente AMS invalide") from None
            if slot < 1 or slot > 16:
                raise BambuError("Fente AMS hors limites (1–16)")
            slots = normalise(self._report).get("ams") or []
            slot_row = next((s for s in slots if s.get("slot") == slot), None)
            if slot_row is None or slot_row.get("loaded") is False:
                raise BambuError(f"Fente AMS {slot} absente ou vide")
            mat = str(slot_row.get("material") or "").strip().upper()
            load_temps = {"PLA": 215, "PETG": 245, "ABS": 260, "ASA": 260, "TPU": 225, "PA": 275, "PC": 275}
            if mat not in load_temps:
                raise BambuError(f"Matériau inconnu dans la fente AMS {slot}")
            load_temp = load_temps[mat]
            target = slot - 1
            payload = {"print": {"sequence_id": seq, "command": "ams_change_filament",
                                 "target": target, "curr_temp": load_temp, "tar_temp": load_temp}}
        elif action == "ams_unload":
            cur_state = normalise(self._report).get("state")
            if cur_state != "idle":
                raise BambuError("Déchargement AMS autorisé uniquement au repos (idle)")
            payload = {"print": {"sequence_id": seq, "command": "unload_filament"}}
        elif action == "ams_set_slot":
            try:
                slot = int(args.get("slot"))
            except (TypeError, ValueError):
                raise BambuError("Fente AMS invalide") from None
            if slot < 1 or slot > 16:
                raise BambuError("Fente AMS hors limites (1–16)")
            ams_id, tray_id = (slot - 1) // 4, (slot - 1) % 4
            material = re.sub(r"[^A-Za-z0-9+ -]", "", str(args.get("material") or "PLA"))[:24] or "PLA"
            colour = str(args.get("colour") or "FFFFFFFF").lstrip("#").upper()
            if not re.fullmatch(r"[0-9A-F]{6}([0-9A-F]{2})?", colour):
                colour = "FFFFFFFF"
            if len(colour) == 6:
                colour += "FF"
            tmin = max(160, min(300, int(args.get("temp_min") or 190)))
            tmax = max(tmin, min(300, int(args.get("temp_max") or 240)))
            payload = {"print": {"sequence_id": seq, "command": "ams_filament_setting",
                                 "ams_id": ams_id, "tray_id": tray_id, "tray_info_idx": "",
                                 "tray_color": colour, "nozzle_temp_min": tmin, "nozzle_temp_max": tmax,
                                 "tray_type": material}}
        else:
            raise BambuError("Commande inconnue")
        try:
            self._send(publish_packet(f"device/{self.serial}/request", json.dumps(payload).encode()))
        except OSError as exc:
            raise BambuError("Imprimante injoignable") from exc

    def start_print(self, payload: dict[str, Any]) -> None:
        try:
            self._send(publish_packet(f"device/{self.serial}/request", json.dumps(payload).encode()))
        except OSError as exc:
            raise BambuError("Imprimante injoignable") from exc

    def _pushall(self) -> None:
        msg = {"pushing": {"sequence_id": "0", "command": "pushall", "version": 1, "push_target": 1}}
        self._send(publish_packet(f"device/{self.serial}/request", json.dumps(msg).encode()))

    def _session(self) -> None:
        def _remember_pin(fp: str) -> None:
            self._tls_fp = fp
            if self._on_pin is not None:
                self._on_pin(fp)

        sock = _open_tls(self.ip, MQTT_PORT, expected_fp=self._tls_fp,
                         on_pin=_remember_pin if not self._tls_fp else None)
        self._sock = sock
        try:
            sock.sendall(connect_packet(f"hq-{self.serial[-6:]}-{int(time.time()) % 10000}",
                                        USERNAME, self._code))
            recv = lambda n: _recv_exact(sock, n)  # noqa: E731
            first, body = read_packet(recv)
            if first >> 4 != 2 or len(body) < 2:
                raise BambuError("Réponse MQTT inattendue")
            if body[1] != 0:
                raise BambuError("Code d'accès refusé" if body[1] in (4, 5) else "Connexion MQTT refusée")
            sock.sendall(subscribe_packet(1, f"device/{self.serial}/report"))
            self._report = {}
            self._pushall()
            self._on_link(True, "")
            last_ping = time.monotonic()
            last_full = time.monotonic()
            while not self._stop.is_set():
                sock.settimeout(KEEPALIVE / 2)
                try:
                    head = sock.recv(1)
                except socket.timeout:
                    head = None                          # idle: nothing started, nothing lost
                if head == b"":
                    raise ConnectionError("closed")
                if head is None:
                    first, body = 0, b""
                else:
                    sock.settimeout(15)                  # a packet has started: it must finish
                    first, body = read_packet(recv, head[0])
                now = time.monotonic()
                if now - last_ping > KEEPALIVE / 2:
                    self._send(PINGREQ)
                    last_ping = now
                if now - last_full > 300:          # resync the whole picture every 5 min
                    self._pushall()
                    last_full = now
                if first >> 4 != 3:
                    continue
                topic, payload = parse_publish(first, body)
                if not topic.endswith("/report"):
                    continue
                try:
                    delta = json.loads(payload.decode("utf-8", "replace"))
                except ValueError:
                    continue
                if isinstance(delta, dict):
                    deep_merge(self._report, delta)
                    self._on_status(normalise(self._report))
        finally:
            self._sock = None
            try:
                sock.close()
            except OSError:
                pass

    def _run(self) -> None:
        backoff = 3.0
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                self._session()
            except BambuError as exc:
                self._on_link(False, str(exc))
            except (OSError, ConnectionError, ssl.SSLError):
                self._on_link(False, "Imprimante injoignable")
            except Exception:
                self._on_link(False, "Erreur de liaison")
            if time.monotonic() - started > 60:
                backoff = 3.0
            self._stop.wait(backoff)
            backoff = min(60.0, backoff * 2)


# ── Start a print (FTPS upload + project_file) ─────────────────────────────

FTPS_PORT = 990
MAX_UPLOAD = 200 * 1024 * 1024


class _ImplicitFTPS(ftplib.FTP_TLS):
    """Bambu printers speak implicit FTPS on 990 and require the data channel to
    reuse the control channel's TLS session."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._sock: ssl.SSLSocket | None = None

    @property
    def sock(self):  # type: ignore[override]
        return self._sock

    @sock.setter
    def sock(self, value):  # type: ignore[override]
        if value is not None and not isinstance(value, ssl.SSLSocket):
            value = self.context.wrap_socket(value)
        self._sock = value

    def ntransfercmd(self, cmd, rest=None):  # type: ignore[override]
        conn, size = ftplib.FTP.ntransfercmd(self, cmd, rest)
        if self._prot_p:
            conn = self.context.wrap_socket(conn, server_hostname=self.host, session=self.sock.session)
        return conn, size


def upload(ip: str, access_code: str, local_path: str, remote_name: str,
           opener: Callable[..., Any] | None = None) -> None:
    """Copy one sliced file to the printer's storage root over implicit FTPS."""
    if not re.fullmatch(r"[A-Za-z0-9 ._()-]{1,120}", remote_name):
        raise BambuError("Nom de fichier refusé")
    try:
        ftp = (opener or _ImplicitFTPS)(context=_tls_context(), timeout=30)
        ftp.connect(ip, FTPS_PORT)
        ftp.login(USERNAME, access_code)
        ftp.prot_p()
        with open(local_path, "rb") as fh:
            ftp.storbinary(f"STOR {remote_name}", fh, blocksize=64 * 1024)
        try:
            ftp.quit()
        except (OSError, ftplib.Error):
            pass
    except ftplib.error_perm as exc:
        raise BambuError("Envoi refusé par l'imprimante (code d'accès ?)") from exc
    except (OSError, ftplib.Error, ssl.SSLError) as exc:
        raise BambuError("Envoi du fichier impossible") from exc


MAX_FETCH = 60 * 1024 * 1024


def fetch_file(ip: str, access_code: str, remote_names: list[str], opener: Callable[..., Any] | None = None) -> bytes:
    """The first of ``remote_names`` found at the printer's storage root, as bytes (bounded).

    Used to read the slice data of a job that was sent from Bambu Studio / Handy: the
    printer keeps the 3MF it was sent. Raises BambuError when none can be read.
    """
    for name in remote_names:
        if not name or "/" in name or "\\" in name or len(name) > 160 or any(ord(c) < 32 for c in name):
            raise BambuError("Nom de fichier refusé")
    ftp = None
    try:
        ftp = (opener or _ImplicitFTPS)(context=_tls_context(), timeout=30)
        ftp.encoding = "utf-8"
        ftp.connect(ip, FTPS_PORT)
        ftp.login(USERNAME, access_code)
        ftp.prot_p()
        for name in remote_names:
            chunks: list[bytes] = []
            size = 0

            def keep(block: bytes) -> None:
                nonlocal size
                size += len(block)
                if size > MAX_FETCH:
                    raise BambuError("Fichier trop grand")
                chunks.append(block)
            try:
                ftp.retrbinary(f"RETR {name}", keep, blocksize=64 * 1024)
            except ftplib.error_perm:
                continue                                  # not there: try the next name
            return b"".join(chunks)
    except ftplib.error_perm as exc:
        raise BambuError("Accès au stockage refusé") from exc
    except (OSError, ftplib.Error, ssl.SSLError) as exc:
        raise BambuError("Stockage de l'imprimante injoignable") from exc
    finally:
        if ftp is not None:
            try:
                ftp.close()
            except (OSError, ftplib.Error):
                pass
    raise BambuError("Fichier introuvable sur l'imprimante")


def list_sd_files(ip: str, access_code: str, opener: Callable[..., Any] | None = None) -> list[dict[str, Any]]:
    """List printable files (.3mf / .gcode) at the printer's SD root over implicit FTPS."""
    ftp = None
    try:
        ftp = (opener or _ImplicitFTPS)(context=_tls_context(), timeout=15)
        ftp.encoding = "utf-8"
        ftp.connect(ip, FTPS_PORT)
        ftp.login(USERNAME, access_code)
        ftp.prot_p()
        names: list[str] = []
        try:
            for name, facts in ftp.mlsd():
                if facts.get("type") == "file" and name.lower().endswith((".3mf", ".gcode")):
                    size = None
                    try:
                        size = int(facts.get("size")) if facts.get("size") else None
                    except (TypeError, ValueError):
                        size = None
                    names.append(name)
                    if len(names) >= 200:
                        break
        except (ftplib.error_perm, AttributeError):
            for name in ftp.nlst():
                leaf = name.rsplit("/", 1)[-1]
                if leaf.lower().endswith((".3mf", ".gcode")):
                    names.append(leaf)
                    if len(names) >= 200:
                        break
        return [{"name": n} for n in sorted(set(names), key=str.lower)]
    except ftplib.error_perm as exc:
        raise BambuError("Accès au stockage refusé") from exc
    except (OSError, ftplib.Error, ssl.SSLError) as exc:
        raise BambuError("Stockage de l'imprimante injoignable") from exc
    finally:
        if ftp is not None:
            try:
                ftp.close()
            except (OSError, ftplib.Error):
                pass


def project_file_command(remote_name: str, plate: int, subtask: str, use_ams: bool,
                         ams_mapping: list[int], *, bed_levelling: bool = True,
                         timelapse: bool = False, flow_cali: bool = False,
                         vibration_cali: bool = False, bed_type: str = "auto",
                         md5: str = "") -> dict[str, Any]:
    payload = {"print": {
        "sequence_id": str(int(time.time()) % 100000), "command": "project_file",
        "param": f"Metadata/plate_{int(plate)}.gcode", "project_id": "0", "profile_id": "0",
        "task_id": "0", "subtask_id": "0", "subtask_name": subtask[:80],
        "file": "", "url": f"file:///sdcard/{remote_name}", "md5": str(md5 or "")[:64],
        "timelapse": bool(timelapse), "bed_type": str(bed_type or "auto")[:24],
        "bed_levelling": bool(bed_levelling), "flow_cali": bool(flow_cali),
        "vibration_cali": bool(vibration_cali), "layer_inspect": False, "use_ams": bool(use_ams),
    }}
    if use_ams:
        payload["print"]["ams_mapping"] = [int(x) for x in ams_mapping]
    return payload


# ── Camera ─────────────────────────────────────────────────────────────────

def camera_auth_packet(access_code: str) -> bytes:
    user = USERNAME.encode().ljust(32, b"\x00")
    code = access_code.encode()[:32].ljust(32, b"\x00")
    return struct.pack("<IIII", 0x40, 0x3000, 0, 0) + user + code


def read_camera_frame(recv: Callable[[int], bytes]) -> bytes:
    header = recv(16)
    size = struct.unpack("<I", header[:4])[0]
    if size <= 0 or size > MAX_FRAME:
        raise BambuError("Image caméra invalide")
    frame = recv(size)
    if not (frame.startswith(b"\xff\xd8") and frame.endswith(b"\xff\xd9")):
        raise BambuError("Image caméra invalide")
    return frame


def camera_frames(ip: str, access_code: str, stop: threading.Event,
                  on_frame: Callable[[bytes], None], *,
                  tls_fp: str = "", on_pin: Callable[[str], None] | None = None) -> None:
    """Push JPEG frames to ``on_frame`` until ``stop`` is set or the link drops."""
    try:
        sock = _open_tls(ip, CAMERA_PORT, expected_fp=tls_fp, on_pin=on_pin)
    except (OSError, ssl.SSLError):
        raise BambuError("Caméra occupée ou injoignable : elle n'accepte qu'un seul client à la fois (Flash Studio, Bambu Studio ou l'app mobile l'ont peut-être ouverte)") from None
    try:
        sock.sendall(camera_auth_packet(access_code))
        sock.settimeout(10)
        recv = lambda n: _recv_exact(sock, n)  # noqa: E731
        while not stop.is_set():
            try:
                on_frame(read_camera_frame(recv))
            except (OSError, ConnectionError, ssl.SSLError):
                raise BambuError("Caméra occupée ou injoignable : elle n'accepte qu'un seul client à la fois (Flash Studio, Bambu Studio ou l'app mobile l'ont peut-être ouverte)") from None
    finally:
        try:
            sock.close()
        except OSError:
            pass
