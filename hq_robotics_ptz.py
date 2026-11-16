"""Pan and tilt of the Tapo C200 over ONVIF PTZ.

Fixed endpoint on the pinned camera IPv4 (port 2020 by default, the ONVIF port). The camera account stays on the server.
Nothing here can reach another host: the camera's own advertised addresses are used for their path only.
Loopback is allowed for local verification, with an optional local port; the host stays pinned either way.
"""

from __future__ import annotations

import base64
from datetime import datetime, timedelta, timezone
import hashlib
import http.client
import re
import secrets
import time
import xml.etree.ElementTree as ET

from hq_robotics_arm import DeviceError, pinned_ip

PORT = 2020
MAX_REPLY = 65536
DIRECTIONS = {"left": (-1, 0), "right": (1, 0), "up": (0, 1), "down": (0, -1)}
SPEED = .5  # Fraction of the camera's maximum pan/tilt speed.
MIN_PULSE, MAX_PULSE = .1, .8  # Seconds a move may run before the stop that always follows.
NS = {
    "s": "http://www.w3.org/2003/05/soap-envelope",
    "tds": "http://www.onvif.org/ver10/device/wsdl",
    "trt": "http://www.onvif.org/ver10/media/wsdl",
    "tptz": "http://www.onvif.org/ver20/ptz/wsdl",
    "tt": "http://www.onvif.org/ver10/schema",
}


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


class Ptz:
    """One short-lived controller. Every call opens its own connection to the camera and closes it."""

    def __init__(self, address, user, password, timeout, port=PORT):
        self.address = pinned_ip(address, allow_loopback=True)
        self.user, self.password = user, password
        self.timeout = timeout
        self.offset = timedelta(0)
        self.token = ""
        self.port = int(port)
        if not 1 <= self.port <= 65535:
            raise ValueError("Port ONVIF invalide")
        self.paths = {"device": "/onvif/device_service", "media": "/onvif/service", "ptz": "/onvif/service"}

    def _post(self, path, inner, *, auth=True):
        header = ""
        if auth:
            created = (datetime.now(timezone.utc) + self.offset).strftime("%Y-%m-%dT%H:%M:%S.000Z")
            nonce = secrets.token_bytes(16)
            digest = base64.b64encode(hashlib.sha1(nonce + created.encode() + self.password.encode()).digest()).decode()
            header = (
                '<s:Header><Security xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
                f'<UsernameToken><Username>{xml_text(self.user)}</Username>'
                '<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">'
                f'{digest}</Password><Nonce>{base64.b64encode(nonce).decode()}</Nonce>'
                f'<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">{created}</Created>'
                '</UsernameToken></Security></s:Header>')
        envelope = ('<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">'
                    f'{header}<s:Body>{inner}</s:Body></s:Envelope>')
        connection = http.client.HTTPConnection(self.address, self.port, timeout=self.timeout)
        try:
            connection.request("POST", path, envelope.encode("utf-8"),
                               {"Content-Type": "application/soap+xml; charset=utf-8", "Connection": "close"})
            with connection.getresponse() as response:
                raw = response.read(MAX_REPLY + 1)
                status = response.status
        except (OSError, http.client.HTTPException):
            raise DeviceError("Caméra injoignable") from None
        finally:
            connection.close()
        if len(raw) > MAX_REPLY:
            raise DeviceError("Réponse de la caméra trop grande")
        if status in (401, 403) or b"NotAuthorized" in raw or b"Sender not Authorized" in raw:
            raise DeviceError("Compte caméra refusé")
        if status != 200:
            raise DeviceError("Commande refusée par la caméra")
        reply = parse(raw)
        if any(local_name(element.tag) == "Fault" for element in reply.iter()):
            raise DeviceError("Caméra en erreur")
        return reply

    def connect(self):
        """Learn the camera clock (the digest is time-bound), its service paths and its first profile."""
        reply = self._post(self.paths["device"], '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>',
                           auth=False)
        fields = {local_name(el.tag): el.text for el in reply.iter() if local_name(el.tag) in
                  ("Year", "Month", "Day", "Hour", "Minute", "Second")}
        try:
            stamp = datetime(*(int(fields[k]) for k in ("Year", "Month", "Day", "Hour", "Minute", "Second")),
                             tzinfo=timezone.utc)
            self.offset = stamp - datetime.now(timezone.utc)
        except (KeyError, TypeError, ValueError):
            pass  # Use this PC's clock; most cameras accept a small skew.
        try:
            caps = self._post(self.paths["device"], '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl">'
                              '<Category>All</Category></GetCapabilities>')
            for el in caps.iter():
                name = local_name(el.tag)
                if name == "XAddr" and el.text:
                    parent = next((p for p in caps.iter() if el in list(p)), None)
                    kind = local_name(parent.tag).lower() if parent is not None else ""
                    path = re.fullmatch(r"https?://[^/]+(/[A-Za-z0-9_./-]{1,80})", el.text.strip())
                    if path and kind in ("media", "ptz", "device"):
                        self.paths[kind] = path.group(1)  # The path only: the host stays the pinned camera.
        except DeviceError as error:
            # A missing capabilities reply may be tolerated, but an auth, transport,
            # malformed or SOAP-fault failure must not be mistaken for a usable camera.
            if any(marker in str(error) for marker in ("refusé", "erreur", "invalide", "injoignable", "trop grande")):
                raise
        profiles = self._post(self.paths["media"], '<GetProfiles xmlns="http://www.onvif.org/ver10/media/wsdl"/>')
        for el in profiles.iter():
            if local_name(el.tag) == "Profiles" and el.get("token"):
                self.token = el.get("token")
                break
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", self.token or ""):
            raise DeviceError("Profil caméra introuvable")

    def pulse(self, direction, seconds):
        """Start a move, hold it for a short time, then always stop."""
        if direction not in DIRECTIONS:
            raise DeviceError("Direction inconnue")
        pan, tilt = DIRECTIONS[direction]
        seconds = min(MAX_PULSE, max(MIN_PULSE, float(seconds)))
        if not self.token:
            self.connect()
        device_timeout = max(2, min(10, int(round(seconds)) + 2))
        try:
            self._post(self.paths["ptz"],
                       '<ContinuousMove xmlns="http://www.onvif.org/ver20/ptz/wsdl">'
                       f'<ProfileToken>{self.token}</ProfileToken><Velocity>'
                       f'<PanTilt x="{pan * SPEED}" y="{tilt * SPEED}" xmlns="http://www.onvif.org/ver10/schema"/>'
                       f'</Velocity><Timeout>PT{device_timeout}S</Timeout></ContinuousMove>')
            time.sleep(seconds)
        finally:
            self.stop()

    def stop(self):
        if not self.token:
            self.connect()
        self._post(self.paths["ptz"],
                   '<Stop xmlns="http://www.onvif.org/ver20/ptz/wsdl">'
                   f'<ProfileToken>{self.token}</ProfileToken><PanTilt>true</PanTilt></Stop>')

    def presets(self):
        """Absolute camera views stored on the Tapo itself, not in this process."""
        if not self.token:
            self.connect()
        reply = self._post(self.paths["ptz"],
                           '<GetPresets xmlns="http://www.onvif.org/ver20/ptz/wsdl">'
                           f'<ProfileToken>{self.token}</ProfileToken></GetPresets>')
        found = []
        for element in reply.iter():
            if local_name(element.tag) != "Preset":
                continue
            token = element.get("token", "")
            if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", token):
                continue
            name = next((child.text for child in element if local_name(child.tag) == "Name" and child.text), "")
            found.append({"token": token, "name": name[:64]})
        return found

    def save_preset(self, name):
        """Store the current orientation under a printable name and return its token."""
        if not self.token:
            self.connect()
        reply = self._post(self.paths["ptz"],
                           '<SetPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl">'
                           f'<ProfileToken>{self.token}</ProfileToken>'
                           f'<PresetName>{xml_text(name[:64])}</PresetName></SetPreset>')
        for element in reply.iter():
            if local_name(element.tag) == "Preset":
                token = element.get("token", "")
                if re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", token):
                    return {"token": token, "name": name[:64]}
        raise DeviceError("La caméra n’a pas nommé cette vue")

    def goto_preset(self, token):
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", token or ""):
            raise DeviceError("Vue caméra invalide")
        if not self.token:
            self.connect()
        self._post(self.paths["ptz"],
                   '<GotoPreset xmlns="http://www.onvif.org/ver20/ptz/wsdl">'
                   f'<ProfileToken>{self.token}</ProfileToken>'
                   f'<PresetToken>{token}</PresetToken></GotoPreset>')

    def delete_preset(self, token):
        """Remove a preset created by a verification run; the camera owns the list."""
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", token or ""):
            raise DeviceError("Vue caméra invalide")
        if not self.token:
            self.connect()
        self._post(self.paths["ptz"],
                   '<RemovePreset xmlns="http://www.onvif.org/ver20/ptz/wsdl">'
                   f'<ProfileToken>{self.token}</ProfileToken>'
                   f'<PresetToken>{token}</PresetToken></RemovePreset>')


def xml_text(value):
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def parse(raw):
    # No DTD and no entities: the camera's reply is data, never a way to make this process read or expand anything.
    if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        raise DeviceError("Réponse de la caméra invalide")
    try:
        return ET.fromstring(raw)
    except ET.ParseError:
        raise DeviceError("Réponse de la caméra invalide") from None
