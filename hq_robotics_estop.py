"""Monitored E-stop contact over a fixed HTTP endpoint.

The monitor is a small local device or bridge with one job: report whether its
normally-closed safety contact is closed. HQ talks to the pinned private IPv4
and `/estop` only; this module cannot reach an arbitrary URL. A closed contact
means healthy. An open contact, a missing token, a malformed reply or an
unreachable monitor is reported as unhealthy, never inferred from silence.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import ipaddress
import json
import secrets

from hq_robotics_arm import DeviceError

PATH = "/estop"
MAX_REPLY = 512


def monitor_ip(value):
    """Pin a private or loopback IPv4 address. No URL, hostname or public host."""
    if not isinstance(value, str) or not value or len(value) > 15:
        raise ValueError("Adresse IPv4 du moniteur E-stop requise")
    try:
        address = ipaddress.IPv4Address(value)
    except ValueError:
        raise ValueError("Adresse IPv4 du moniteur E-stop requise") from None
    if not (address.is_private or address.is_loopback):
        raise ValueError("Adresse IPv4 privée requise pour le moniteur E-stop")
    return str(address)


class HttpEstop:
    """Read the monitor's closed contact. Every call closes its connection.

    Note: this HTTP check is supervisory telemetry only, never a safety-rated circuit.
    When `require_signed=True` (or when the monitor returns `nonce`/`seq`/`hmac`),
    replies are verified with HMAC-SHA256 over `<nonce>:<seq>:<0|1>` using `token`
    and a strictly monotonic `seq`.
    """

    def __init__(self, address, port, token, timeout, *, require_signed=False):
        self.address = monitor_ip(address)
        try:
            self.port = int(port)
        except (TypeError, ValueError):
            raise ValueError("Port du moniteur E-stop invalide") from None
        if not 1 <= self.port <= 65535:
            raise ValueError("Port du moniteur E-stop invalide")
        if not isinstance(token, str) or len(token) > 128 or any(not 32 <= ord(ch) < 127 for ch in token):
            raise ValueError("Jeton du moniteur E-stop invalide")
        if require_signed and not token:
            raise ValueError("Jeton requis pour un moniteur E-stop signé")
        self.token = token
        self.timeout = timeout
        self.require_signed = bool(require_signed)
        self._last_seq = None

    def read(self):
        nonce = secrets.token_hex(16)
        connection = http.client.HTTPConnection(self.address, self.port, timeout=self.timeout)
        headers = {"Accept": "application/json", "Connection": "close", "X-HQ-Estop-Nonce": nonce}
        if self.token:
            headers["X-HQ-Estop-Token"] = self.token
        try:
            connection.request("GET", PATH, headers=headers)
            with connection.getresponse() as response:
                raw = response.read(MAX_REPLY + 1)
                status = response.status
        except (OSError, http.client.HTTPException):
            raise DeviceError("Moniteur E-stop injoignable") from None
        finally:
            connection.close()
        if len(raw) > MAX_REPLY:
            raise DeviceError("Réponse du moniteur E-stop trop grande")
        if status != 200:
            raise DeviceError("Moniteur E-stop refusé")
        try:
            value = json.loads(raw)
        except ValueError:
            raise DeviceError("Réponse du moniteur E-stop invalide") from None
        if not isinstance(value, dict) or type(value.get("closed")) is not bool:
            raise DeviceError("Réponse du moniteur E-stop invalide")
        has_sig = any(k in value for k in ("nonce", "seq", "hmac"))
        signed = False
        if self.require_signed or has_sig:
            if not self.token:
                raise DeviceError("Jeton requis pour vérifier la signature E-stop")
            r_nonce = value.get("nonce")
            r_seq = value.get("seq")
            r_hmac = value.get("hmac")
            if (not isinstance(r_nonce, str) or not hmac.compare_digest(r_nonce, nonce)
                    or type(r_seq) is not int or r_seq < 0
                    or (self._last_seq is not None and r_seq <= self._last_seq)
                    or not isinstance(r_hmac, str)):
                raise DeviceError("Réponse E-stop non fraîche ou rejouée")
            expected = hmac.new(
                self.token.encode(),
                f"{nonce}:{r_seq}:{int(value['closed'])}".encode(),
                hashlib.sha256,
            ).hexdigest()
            if not hmac.compare_digest(r_hmac.lower(), expected):
                raise DeviceError("Signature du moniteur E-stop invalide")
            self._last_seq = r_seq
            signed = True
        result = {"closed": value["closed"], "healthy": value["closed"]}
        if signed:
            result["signed"] = True
        return result
