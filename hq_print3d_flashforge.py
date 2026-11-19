"""Flashforge LAN adapter (Adventurer 5M / AD5X / Creator 5 family) — stdlib only.

Primary: the local HTTP API on port 8898. Every call carries the printer's
serial number and its "check code" (shown on the printer's network screen):
``POST /detail`` returns the live status, ``POST /control`` runs a command.

Fallback for older firmware: the legacy TCP G-code port 8899 (``~M601`` login,
then ``~M119`` / ``~M105`` / ``~M27``), status only.

Camera: the printer serves MJPEG, usually ``http://<ip>:8080/?action=stream``.
We only ever connect to the pinned private IPv4 from the config.
"""
from __future__ import annotations

import http.client
import json
import re
import socket
import threading
import time
from typing import Any, Callable

HTTP_PORT = 8898
TCP_PORT = 8899
CAMERA_PORT = 8080
TIMEOUT = 6.0
MAX_BODY = 256 * 1024
MAX_FRAME = 4 << 20
POLL_INTERVAL = 5.0

_STATE_MAP = {"ready": "idle", "printing": "printing", "paused": "paused", "pausing": "paused",
              "completed": "finished", "error": "failed", "busy": "preparing", "heating": "preparing",
              "calibrate_doing": "preparing", "cancel": "unknown"}

_CONTROL = {
    "pause": {"cmd": "jobCtl_cmd", "args": {"jobID": "", "action": "pause"}},
    "resume": {"cmd": "jobCtl_cmd", "args": {"jobID": "", "action": "continue"}},
    "stop": {"cmd": "jobCtl_cmd", "args": {"jobID": "", "action": "cancel"}},
    "light_on": {"cmd": "lightControl_cmd", "args": {"status": "open"}},
    "light_off": {"cmd": "lightControl_cmd", "args": {"status": "close"}},
}


class FlashforgeError(Exception):
    """Fixed, safe message only."""


def _num(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None


def _post(ip: str, path: str, body: dict[str, Any]) -> dict[str, Any]:
    conn = http.client.HTTPConnection(ip, HTTP_PORT, timeout=TIMEOUT)
    try:
        conn.request("POST", path, body=json.dumps(body), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        raw = resp.read(MAX_BODY + 1)
    except (OSError, http.client.HTTPException) as exc:
        raise FlashforgeError("Imprimante injoignable") from exc
    finally:
        conn.close()
    if resp.status != 200 or len(raw) > MAX_BODY:
        raise FlashforgeError("Réponse imprimante inattendue")
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise FlashforgeError("Réponse imprimante illisible") from exc
    if not isinstance(data, dict) or data.get("code") not in (0, "0"):
        raise FlashforgeError("Code de contrôle refusé")
    return data


def normalise_detail(detail: dict[str, Any]) -> dict[str, Any]:
    status = str(detail.get("status") or "").lower()
    progress = _num(detail.get("printProgress"))
    if progress is not None and progress <= 1.0:
        progress = round(progress * 100, 1)
    est = _num(detail.get("estimatedTime"))
    elapsed = _num(detail.get("printDuration"))
    remaining = None
    if est is not None:
        remaining = int(max(0.0, est - (elapsed or 0.0))) if elapsed is not None and est > (elapsed or 0) else int(est)
    nozzle = _num(detail.get("rightTemp"))
    nozzle_target = _num(detail.get("rightTargetTemp"))
    if nozzle is None:
        nozzle = _num(detail.get("leftTemp"))
        nozzle_target = _num(detail.get("leftTargetTemp"))
    slots = []
    for i, row in enumerate((detail.get("matlStationInfo") or {}).get("slotInfos") or []):
        if isinstance(row, dict):
            colour = str(row.get("materialColor") or "")
            material = str(row.get("materialName") or "")[:24]
            # Trust the printer's flag when it sends one; some firmware omits it, and then a
            # named material is the only evidence there is a spool in the slot.
            flag = row.get("hasFilament")
            slots.append({"slot": int(row.get("slotId") or i + 1),
                          "material": material,
                          "colour": colour.upper() if re.fullmatch(r"#[0-9a-fA-F]{6}", colour) else "",
                          "remain": None, "active": False,
                          "loaded": bool(flag) if flag is not None else bool(material.strip())})
    light = detail.get("lightStatus")
    return {
        "state": _STATE_MAP.get(status, "unknown"),
        "job": str(detail.get("printFileName") or "")[:160],
        "progress": progress,
        "layer": _num(detail.get("printLayer")),
        "total_layers": _num(detail.get("targetPrintLayer")),
        "remaining_sec": remaining,
        "nozzle": nozzle,
        "nozzle_target": nozzle_target,
        "bed": _num(detail.get("platTemp")),
        "bed_target": _num(detail.get("platTargetTemp")),
        "light": (light == "open") if isinstance(light, str) else None,
        "speed_level": None,
        "ams": slots,
        "external_spool": None,
        "error_code": None if not detail.get("errorCode") else str(detail.get("errorCode"))[:24],
        "hms_count": 0,
        "wifi": "",
        "plate": None,
        **_filament_fields(detail),
    }


def _filament_fields(detail: dict[str, Any]) -> dict[str, Any]:
    """The printer's own estimate for the running job (it reads 0 when idle) and its lifetime counter."""
    weight = (_num(detail.get("estimatedRightWeight")) or 0) + (_num(detail.get("estimatedLeftWeight")) or 0)
    length = (_num(detail.get("estimatedRightLen")) or 0) + (_num(detail.get("estimatedLeftLen")) or 0)
    # The length unit is not documented: PLA is ~0.33 m per gram, so a ratio above 50 means millimetres.
    if weight > 0 and length / weight > 50:
        length /= 1000.0
    elif weight <= 0 and length > 5000:
        length /= 1000.0
    types = []
    for key in ("rightFilamentType", "leftFilamentType"):
        types += [t.strip() for t in str(detail.get(key) or "").split(";") if t.strip()]
    counter = _num(detail.get("cumulativeFilament"))
    return {"est_weight_g": round(weight, 2) if weight > 0 else None,
            "est_len_m": round(length, 3) if length > 0 else None,
            "materials": types[:4], "counter_m": counter}


def detail(ip: str, serial: str, check_code: str) -> dict[str, Any]:
    data = _post(ip, "/detail", {"serialNumber": serial, "checkCode": check_code})
    d = data.get("detail")
    if not isinstance(d, dict):
        raise FlashforgeError("Réponse imprimante illisible")
    return d


def control(ip: str, serial: str, check_code: str, name: str) -> None:
    payload = _CONTROL.get(name)
    if payload is None:
        raise FlashforgeError("Commande inconnue")
    _post(ip, "/control", {"serialNumber": serial, "checkCode": check_code,
                           "payload": json.loads(json.dumps(payload))})


MAX_UPLOAD = 200 * 1024 * 1024
UPLOAD_TIMEOUT = 120.0


def _hex_color(value: Any, default: str = "#FFFFFF") -> str:
    s = str(value or "").strip()
    return s[:7].upper() if re.fullmatch(r"#[0-9A-Fa-f]{6}", s[:7]) else default


def _clean_material_mappings(mappings: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    if not isinstance(mappings, list):
        return []
    out: list[dict[str, Any]] = []
    seen_tools: set[int] = set()
    for row in mappings[:16]:
        if not isinstance(row, dict):
            continue
        try:
            tool_id = max(0, min(15, int(row.get("toolId", 0))))
            slot_id = max(1, min(16, int(row.get("slotId", 1))))
        except (TypeError, ValueError):
            continue
        if tool_id in seen_tools:
            continue
        seen_tools.add(tool_id)
        mat = re.sub(r"[^A-Za-z0-9_+ .-]", "", str(row.get("materialName") or "PLA")).strip()[:32] or "PLA"
        out.append({
            "toolId": tool_id,
            "slotId": slot_id,
            "materialName": mat,
            "toolMaterialColor": _hex_color(row.get("toolMaterialColor")),
            "slotMaterialColor": _hex_color(row.get("slotMaterialColor")),
        })
    return out


def upload_and_print(ip: str, serial: str, check_code: str, local_path: str, remote_name: str,
                     *, leveling: bool = True, flow_calibration: bool = False,
                     use_matl_station: bool = False, gcode_tool_cnt: int = 0,
                     material_mappings: list[dict[str, Any]] | None = None,
                     connection: Callable[..., Any] | None = None) -> None:
    """``POST /uploadGcode`` with ``printNow``: the printer stores the file and starts it."""
    import base64
    import os
    if not re.fullmatch(r"[A-Za-z0-9 ._()-]{1,120}", remote_name):
        raise FlashforgeError("Nom de fichier refusé")
    size = os.path.getsize(local_path)
    if size <= 0 or size > MAX_UPLOAD:
        raise FlashforgeError("Fichier trop grand")
    clean_maps = _clean_material_mappings(material_mappings)
    try:
        tool_cnt = max(0, min(16, int(gcode_tool_cnt)))
    except (TypeError, ValueError):
        tool_cnt = 0
    if clean_maps and tool_cnt < len(clean_maps):
        tool_cnt = len(clean_maps)
    boundary = "----hqprint" + os.urandom(8).hex()
    head = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"gcodeFile\"; filename=\"{remote_name}\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n").encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    headers = {
        "Content-Type": f"multipart/form-data; boundary={boundary}",
        "Content-Length": str(len(head) + size + len(tail)),
        "serialNumber": serial, "checkCode": check_code, "fileSize": str(size),
        "printNow": "true", "levelingBeforePrint": "true" if leveling else "false",
        "flowCalibration": "true" if flow_calibration else "false",
        "useMatlStation": "true" if use_matl_station else "false",
        "gcodeToolCnt": str(tool_cnt),
        "materialMappings": base64.b64encode(json.dumps(clean_maps, separators=(",", ":")).encode("utf-8")).decode("ascii"),
    }
    conn = (connection or http.client.HTTPConnection)(ip, HTTP_PORT, timeout=UPLOAD_TIMEOUT)
    try:
        conn.putrequest("POST", "/uploadGcode")
        for key, value in headers.items():
            conn.putheader(key, value)
        conn.endheaders()
        conn.send(head)
        with open(local_path, "rb") as fh:
            while True:
                chunk = fh.read(64 * 1024)
                if not chunk:
                    break
                conn.send(chunk)
        conn.send(tail)
        resp = conn.getresponse()
        raw = resp.read(MAX_BODY + 1)
    except (OSError, http.client.HTTPException) as exc:
        raise FlashforgeError("Envoi du fichier impossible") from exc
    finally:
        conn.close()
    if resp.status != 200:
        raise FlashforgeError("Envoi refusé par l'imprimante")
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as exc:
        raise FlashforgeError("Réponse imprimante illisible") from exc
    if not isinstance(data, dict) or data.get("code") not in (0, "0"):
        raise FlashforgeError("Envoi refusé par l'imprimante")


# ── Legacy TCP fallback (status only) ──────────────────────────────────────

def parse_legacy(m119: str, m105: str, m27: str) -> dict[str, Any]:
    machine = (re.search(r"MachineStatus:\s*(\w+)", m119) or [None, ""])[1].upper()
    move = (re.search(r"MoveMode:\s*(\w+)", m119) or [None, ""])[1].upper()
    state = {"READY": "idle", "BUILDING_FROM_SD": "printing", "BUILDING_COMPLETED": "finished",
             "PAUSED": "paused"}.get(machine, "unknown")
    if move == "PAUSED":
        state = "paused"
    temps = re.search(r"T0:\s*([\d.]+)\s*/\s*([\d.]+)", m105)
    bed = re.search(r"B:\s*([\d.]+)\s*/\s*([\d.]+)", m105)
    prog = re.search(r"(\d+)\s*/\s*(\d+)", m27)
    layer = re.search(r"Layer:\s*(\d+)\s*/\s*(\d+)", m27)
    pct = None
    if prog and int(prog.group(2)):
        pct = round(int(prog.group(1)) * 100 / int(prog.group(2)), 1)
    job = (re.search(r"CurrentFile:\s*(.+)", m119) or [None, ""])[1].strip()
    return {"state": state, "job": job[:160], "progress": pct,
            "layer": float(layer.group(1)) if layer else None,
            "total_layers": float(layer.group(2)) if layer else None,
            "remaining_sec": None,
            "nozzle": float(temps.group(1)) if temps else None,
            "nozzle_target": float(temps.group(2)) if temps else None,
            "bed": float(bed.group(1)) if bed else None,
            "bed_target": float(bed.group(2)) if bed else None,
            "light": None, "speed_level": None, "ams": [], "external_spool": None,
            "error_code": None, "hms_count": 0, "wifi": ""}


def legacy_status(ip: str) -> dict[str, Any]:
    def ask(sock: socket.socket, cmd: str) -> str:
        sock.sendall(f"~{cmd}\r\n".encode())
        buf = b""
        deadline = time.monotonic() + TIMEOUT
        while b"ok" not in buf and time.monotonic() < deadline and len(buf) < 8192:
            chunk = sock.recv(1024)
            if not chunk:
                break
            buf += chunk
        return buf.decode("utf-8", "replace")

    try:
        with socket.create_connection((ip, TCP_PORT), timeout=TIMEOUT) as sock:
            sock.settimeout(TIMEOUT)
            ask(sock, "M601 S1")
            m119, m105, m27 = ask(sock, "M119"), ask(sock, "M105"), ask(sock, "M27")
            ask(sock, "M602")
    except OSError as exc:
        raise FlashforgeError("Imprimante injoignable") from exc
    return parse_legacy(m119, m105, m27)


# ── Poller (one per printer) ───────────────────────────────────────────────

class FlashforgeLink:
    def __init__(self, ip: str, serial: str, check_code: str,
                 on_status: Callable[[dict[str, Any]], None],
                 on_link: Callable[[bool, str], None]) -> None:
        self.ip, self.serial, self._code = ip, serial, check_code
        self._on_status, self._on_link = on_status, on_link
        self._stop = threading.Event()
        self._legacy = False
        self._http_fail = 0
        self._polls = 0
        self.camera_path = "/?action=stream"
        self._thread = threading.Thread(target=self._run, name=f"flashforge-{serial[-4:]}", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def alive(self) -> bool:
        return self._thread.is_alive()

    def stop(self) -> None:
        self._stop.set()

    def command(self, name: str) -> None:
        if not self._code or not self.serial:
            raise FlashforgeError("Code de contrôle requis pour commander")
        control(self.ip, self.serial, self._code, name)

    def start_print(self, local_path: str, remote_name: str, **kwargs: Any) -> None:
        if not self._code or not self.serial:
            raise FlashforgeError("Code de contrôle requis pour imprimer")
        upload_and_print(self.ip, self.serial, self._code, local_path, remote_name, **kwargs)

    def _poll_once(self) -> dict[str, Any]:
        self._polls += 1
        if not (self.serial and self._code):
            return legacy_status(self.ip)
        # On the legacy fallback, give the HTTP API another chance every 12 polls.
        if not self._legacy or self._polls % 12 == 0:
            try:
                d = detail(self.ip, self.serial, self._code)
                url = str(d.get("cameraStreamUrl") or "")
                m = re.fullmatch(r"http://[\d.]+:8080(/[\x21-\x7e]{0,120})", url)
                if m:
                    self.camera_path = m.group(1)
                self._http_fail, self._legacy = 0, False
                return normalise_detail(d)
            except FlashforgeError as exc:
                if str(exc) == "Code de contrôle refusé":
                    raise
                self._http_fail += 1
                if self._http_fail < 3 and not self._legacy:
                    raise                      # one hiccup is not "the API is gone"
        status = legacy_status(self.ip)
        self._legacy = True
        return status

    def _run(self) -> None:
        failures = 0
        while not self._stop.is_set():
            try:
                self._on_status(self._poll_once())
                self._on_link(True, "")
                failures = 0
            except FlashforgeError as exc:
                failures += 1
                self._on_link(False, str(exc))
            except Exception:
                failures += 1
                self._on_link(False, "Erreur de liaison")
            self._stop.wait(POLL_INTERVAL if failures < 3 else min(60.0, POLL_INTERVAL * failures))


# ── Camera ─────────────────────────────────────────────────────────────────

def split_jpegs(buffer: bytearray) -> list[bytes]:
    """Pull complete JPEGs (SOI..EOI) out of an MJPEG byte stream, in place."""
    frames = []
    while True:
        start = buffer.find(b"\xff\xd8")
        if start < 0:
            if len(buffer) > 2:
                del buffer[:-2]
            return frames
        end = buffer.find(b"\xff\xd9", start + 2)
        if end < 0:
            if start:
                del buffer[:start]
            if len(buffer) > MAX_FRAME:
                buffer.clear()
            return frames
        frames.append(bytes(buffer[start:end + 2]))
        del buffer[:end + 2]


def camera_frames(ip: str, path: str, stop: threading.Event, on_frame: Callable[[bytes], None]) -> None:
    conn = http.client.HTTPConnection(ip, CAMERA_PORT, timeout=10)
    try:
        try:
            conn.request("GET", path if path.startswith("/") else "/?action=stream")
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException):
            raise FlashforgeError("Caméra occupée ou injoignable : elle n'accepte qu'un seul client à la fois (Flash Studio, Bambu Studio ou l'app mobile l'ont peut-être ouverte)") from None
        if resp.status != 200:
            raise FlashforgeError("Caméra indisponible")
        buf = bytearray()
        while not stop.is_set():
            chunk = resp.read1(65536) if hasattr(resp, "read1") else resp.read(65536)
            if not chunk:
                break
            buf.extend(chunk)
            for frame in split_jpegs(buf):
                on_frame(frame)
    finally:
        conn.close()
