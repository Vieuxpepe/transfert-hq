"""Tapo C200 local API (HTTPS, port 443) for the settings ONVIF does not expose, such as night vision.

Python standard library only. Current C200 V5 firmware uses TPAP (SPAKE2+ with AES-128-CCM).
Older firmware uses an encrypt_type 3 challenge with AES-128-CBC. All requests go to the pinned camera IP.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.client
import json
import re
import secrets
import ssl
import string

from hq_robotics_arm import DeviceError, pinned_ip
from hq_robotics_tpap import N, Spake2pClient, c200_credential, md5_hex, sha256_hex_upper

PORT = 443
MAX_REPLY = 65536
NIGHT_MODES = {"auto": "auto", "on": "on", "off": "off"}  # inf_type: infrared always on, always off, or automatic


# ----------------------------------------------------------------------------- AES-128-CBC (pure Python)
def _sbox():
    box, p, q = [0] * 256, 1, 1
    while True:
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)
        q ^= q << 1
        q ^= q << 2
        q ^= q << 4
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        x = q ^ ((q << 1) | (q >> 7)) & 0xFF ^ ((q << 2) | (q >> 6)) & 0xFF ^ ((q << 3) | (q >> 5)) & 0xFF ^ ((q << 4) | (q >> 4)) & 0xFF
        box[p] = (x ^ 0x63) & 0xFF
        if p == 1:
            break
    box[0] = 0x63
    return box


SBOX = _sbox()
INV_SBOX = [0] * 256
for _i, _v in enumerate(SBOX):
    INV_SBOX[_v] = _i


def _xtime(a):
    return ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else a << 1


def _mul(a, b):
    out = 0
    while b:
        if b & 1:
            out ^= a
        a, b = _xtime(a), b >> 1
    return out


def _expand(key):
    words = [list(key[i:i + 4]) for i in range(0, 16, 4)]
    rcon = 1
    for i in range(4, 44):
        word = list(words[i - 1])
        if i % 4 == 0:
            word = [SBOX[b] for b in word[1:] + word[:1]]
            word[0] ^= rcon
            rcon = _xtime(rcon)
        words.append([a ^ b for a, b in zip(words[i - 4], word)])
    return [sum(words[r * 4:r * 4 + 4], []) for r in range(11)]


def _add(state, key):
    return [a ^ b for a, b in zip(state, key)]


def _encrypt_block(block, keys):
    state = _add(list(block), keys[0])
    for rnd in range(1, 11):
        state = [SBOX[b] for b in state]
        state = [state[(i + 4 * (i % 4)) % 16] for i in range(16)]  # ShiftRows on a column-major state
        if rnd < 10:
            cols = []
            for c in range(0, 16, 4):
                a = state[c:c + 4]
                cols += [_xtime(a[0]) ^ _xtime(a[1]) ^ a[1] ^ a[2] ^ a[3],
                         a[0] ^ _xtime(a[1]) ^ _xtime(a[2]) ^ a[2] ^ a[3],
                         a[0] ^ a[1] ^ _xtime(a[2]) ^ _xtime(a[3]) ^ a[3],
                         _xtime(a[0]) ^ a[0] ^ a[1] ^ a[2] ^ _xtime(a[3])]
            state = cols
        state = _add(state, keys[rnd])
    return bytes(state)


def _decrypt_block(block, keys):
    state = _add(list(block), keys[10])
    for rnd in range(9, -1, -1):
        state = [state[(i - 4 * (i % 4)) % 16] for i in range(16)]  # InvShiftRows
        state = [INV_SBOX[b] for b in state]
        state = _add(state, keys[rnd])
        if rnd > 0:
            cols = []
            for c in range(0, 16, 4):
                a = state[c:c + 4]
                cols += [_mul(a[0], 14) ^ _mul(a[1], 11) ^ _mul(a[2], 13) ^ _mul(a[3], 9),
                         _mul(a[0], 9) ^ _mul(a[1], 14) ^ _mul(a[2], 11) ^ _mul(a[3], 13),
                         _mul(a[0], 13) ^ _mul(a[1], 9) ^ _mul(a[2], 14) ^ _mul(a[3], 11),
                         _mul(a[0], 11) ^ _mul(a[1], 13) ^ _mul(a[2], 9) ^ _mul(a[3], 14)]
            state = cols
    return bytes(state)


def aes_cbc_encrypt(key, iv, data):
    keys = _expand(key)
    pad = 16 - len(data) % 16
    data += bytes([pad]) * pad
    out, prev = b"", iv
    for i in range(0, len(data), 16):
        prev = _encrypt_block(bytes(a ^ b for a, b in zip(data[i:i + 16], prev)), keys)
        out += prev
    return out


def aes_cbc_decrypt(key, iv, data):
    if not data or len(data) % 16:
        raise DeviceError("Réponse de la caméra invalide")
    keys = _expand(key)
    out, prev = b"", iv
    for i in range(0, len(data), 16):
        block = data[i:i + 16]
        out += bytes(a ^ b for a, b in zip(_decrypt_block(block, keys), prev))
        prev = block
    pad = out[-1]
    if not 1 <= pad <= 16 or out[-pad:] != bytes([pad]) * pad:
        raise DeviceError("Réponse de la caméra invalide")
    return out[:-pad]


# TPAP fixes the CCM parameters at a 12-byte nonce, a 16-byte tag and no associated data.
def _xor_bytes(left, right):
    return bytes(a ^ b for a, b in zip(left, right))


def _ccm_ctr(nonce, data, keys):
    for offset in range(0, len(data), 16):
        counter = (offset // 16 + 1).to_bytes(3, "big")
        mask = _encrypt_block(b"\x02" + nonce + counter, keys)
        yield _xor_bytes(data[offset:offset + 16], mask)


def _ccm_tag(nonce, plain, keys):
    mac = _encrypt_block(b"\x3a" + nonce + len(plain).to_bytes(3, "big"), keys)
    for offset in range(0, len(plain), 16):
        block = plain[offset:offset + 16].ljust(16, b"\0")
        mac = _encrypt_block(_xor_bytes(mac, block), keys)
    return _xor_bytes(mac, _encrypt_block(b"\x02" + nonce + b"\0" * 3, keys))


def _ccm_encrypt(key, nonce, plain):
    keys = _expand(key)
    return b"".join(_ccm_ctr(nonce, plain, keys)) + _ccm_tag(nonce, plain, keys)


def _ccm_decrypt(key, nonce, sealed):
    keys = _expand(key)
    plain = b"".join(_ccm_ctr(nonce, sealed[:-16], keys))
    if not hmac.compare_digest(_ccm_tag(nonce, plain, keys), sealed[-16:]):
        raise DeviceError("Réponse de la caméra invalide")
    return plain


# ----------------------------------------------------------------------------- the camera
def digest(text):
    return hashlib.sha256(text.encode()).hexdigest().upper()


class Tapo:
    """One logged-in session to the pinned camera."""

    def __init__(self, address, user, password, timeout, *, tls_sha256=""):
        self.address = pinned_ip(address)
        self.user, self.password = user, password
        self.timeout = timeout
        self.tls_sha256 = (tls_sha256 or "").strip().lower()
        if self.tls_sha256 and not re.fullmatch(r"[0-9a-f]{64}", self.tls_sha256):
            raise ValueError("Empreinte TLS SHA-256 invalide")
        self.stok = self.seq = None
        self.lsk = self.ivb = b""
        self.tag_prefix = ""
        self.tpap_keys = None
        self.trace = []  # (step, camera error_code) of the latest login, for the server log; never secrets.
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        context.check_hostname = False
        # The camera's certificate is self-signed on the local robotics subnet;
        # when tls_sha256 is configured we pin the leaf certificate's SHA-256.
        context.verify_mode = ssl.CERT_NONE
        try:
            context.set_ciphers("DEFAULT:@SECLEVEL=0")
        except ssl.SSLError:
            pass
        self.context = context

    def _http_bytes(self, path, body, headers):
        connection = http.client.HTTPSConnection(self.address, PORT, timeout=self.timeout, context=self.context)
        try:
            connection.connect()
            if self.tls_sha256:
                sock = getattr(connection, "sock", None)
                der = sock.getpeercert(binary_form=True) if sock is not None else None
                if not der or not hmac.compare_digest(hashlib.sha256(der).hexdigest().lower(), self.tls_sha256):
                    raise DeviceError("Certificat caméra non conforme")
            connection.request("POST", path, body, {"Connection": "close", **headers})
            with connection.getresponse() as response:
                raw = response.read(MAX_REPLY + 1)
        except DeviceError:
            raise
        except (OSError, http.client.HTTPException):
            raise DeviceError("Caméra injoignable") from None
        finally:
            connection.close()
        if len(raw) > MAX_REPLY:
            raise DeviceError("Réponse de la caméra trop grande")
        return raw

    def _http(self, path, body, headers=None):
        raw = self._http_bytes(path, body.encode(), {"Content-Type": "application/json; charset=UTF-8",
                                                     **(headers or {})})
        try:
            value = json.loads(raw)
        except ValueError:
            raise DeviceError("Réponse de la caméra invalide") from None
        if not isinstance(value, dict):
            raise DeviceError("Réponse de la caméra invalide")
        try:
            sent = json.loads(body)
            params = sent.get("params") or {}
            step = params.get("sub_method") or ("digest" if "digest_passwd" in params else
                                                "challenge" if "cnonce" in params else sent.get("method"))
        except (ValueError, AttributeError):
            step = "request"
        self.trace = self.trace[-7:] + [(step, value.get("error_code"))]
        return value

    def _app_headers(self, content_type):
        return {"requestByApp": "true", "Referer": f"https://{self.address}:{PORT}",
                "User-Agent": "Tapo CameraClient Android", "Accept": content_type, "Content-Type": content_type}

    @staticmethod
    def _check_login_lockout(reply):
        result = reply.get("result")
        for data in (reply.get("error_info"), reply.get("data"),
                     result.get("data") if isinstance(result, dict) else None):
            if isinstance(data, dict):
                left = data.get("sec_left")
                minutes = (left + 59) // 60 if isinstance(left, int) and left > 0 else data.get("lockedMinute")
                if isinstance(minutes, int) and minutes > 0:
                    raise DeviceError(f"Connexion à la caméra suspendue encore {minutes} min (trop d’essais)")
                if data.get("code") == -40404:
                    raise DeviceError("Connexion à la caméra suspendue (trop d’essais)")
        if reply.get("error_code") == -40404:
            raise DeviceError("Connexion à la caméra suspendue (trop d’essais)")

    def _tpap_login(self, info):
        """Use the cloud credential with the C200 V5 password-shadow exchange."""
        if not self.password:
            raise DeviceError("Compte caméra refusé")
        headers = self._app_headers("application/json")
        user_random = base64.b64encode(secrets.token_bytes(32)).decode()
        username = sha256_hex_upper("admin") if info.get("user_hash_type") == 1 else md5_hex("admin")
        register = self._http("/", json.dumps({"method": "login", "params": {
            "sub_method": "pake_register", "username": username, "user_random": user_random,
            "cipher_suites": [1], "encryption": ["aes_128_ccm"], "passcode_type": "userpw",
        }}), headers)
        self._check_login_lockout(register)
        if register.get("error_code") != 0:
            raise DeviceError(f"Compte caméra refusé (inscription, code {register.get('error_code')})")
        try:
            registration = register["result"]
            credential = c200_credential(self.password, registration["extra_crypt"])
            client = Spake2pClient(registration, user_random, credential, secrets.randbelow(N - 1))
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
            raise DeviceError("Compte caméra refusé") from None
        try:
            share = self._http("/", json.dumps({"method": "login", "params": {
                "sub_method": "pake_share", "user_share": base64.b64encode(client.Xb).decode(),
                "user_confirm": base64.b64encode(client.user_confirm).decode(),
            }}), headers)
        except DeviceError:
            # A lost reply leaves the outcome unknown. Do not start another login.
            raise DeviceError("Connexion à la caméra refusée (réponse de connexion indisponible)") from None
        self._check_login_lockout(share)
        if share.get("error_code") != 0:
            raise DeviceError(f"Compte caméra refusé (échange, code {share.get('error_code')})")
        try:
            result = share["result"]
            stok, seq = result["stok"], int(result["start_seq"])
            if not re.fullmatch(r"[A-Za-z0-9._~!$&'()*+,;=-]{1,128}", stok):
                raise ValueError("invalid token")
            if not client.device_confirm_ok(base64.b64decode(result["dev_confirm"], validate=True)):
                raise ValueError("invalid camera proof")
        except (KeyError, TypeError, ValueError, OverflowError):
            raise DeviceError("Compte caméra refusé") from None
        self.tpap_keys = client.session_key_and_nonce()
        self.stok, self.seq = stok, seq

    def login(self):
        discovery = self._http("/", json.dumps({"method": "login", "params": {"sub_method": "discover"}}))
        self._check_login_lockout(discovery)
        if discovery.get("error_code") == -40401:
            raise DeviceError("Connexion à la caméra suspendue (trop d’essais)")
        result = discovery.get("result")
        info = result.get("tpap") if isinstance(result, dict) else None
        if isinstance(info, dict) and isinstance(info.get("pake"), list) and 2 in info["pake"]:
            self._tpap_login(info)
            return
        cnonce = "".join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
        first = self._http("/", json.dumps({"method": "login", "params": {"encrypt_type": "3", "username": self.user,
                                                                            "cnonce": cnonce}}))
        self._check_login_lockout(first)
        if first.get("error_code") == -40211:
            self._tpap_login({})
            return
        data = (first.get("result") or {}).get("data") or first.get("data") or {}
        if first.get("error_code") == -40401:
            raise DeviceError("Connexion à la caméra suspendue (trop d’essais)")
        nonce, confirm = data.get("nonce"), data.get("device_confirm")
        if first.get("error_code") != -40413 or not isinstance(nonce, str) or not isinstance(confirm, str):
            raise DeviceError(f"Compte caméra refusé (défi, code {first.get('error_code')})")
        hashed = None
        for candidate in (hashlib.sha256(self.password.encode()).hexdigest().upper(),
                          hashlib.md5(self.password.encode()).hexdigest().upper()):
            if confirm == digest(cnonce + candidate + nonce) + nonce + cnonce:
                hashed = candidate
                break
        if hashed is None:
            raise DeviceError("Compte caméra refusé")  # The camera does not know this password.
        passwd = digest(hashed + cnonce + nonce) + cnonce + nonce
        second = self._http("/", json.dumps({"method": "login", "params": {
            "cnonce": cnonce, "encrypt_type": "3", "digest_passwd": passwd, "username": self.user}}))
        self._check_login_lockout(second)
        result = second.get("result") or {}
        if not isinstance(result.get("stok"), str) or not result["stok"].isalnum():
            raise DeviceError("Compte caméra refusé")
        key = digest(cnonce + hashed + nonce)
        self.lsk = hashlib.sha256(("lsk" + cnonce + nonce + key).encode()).digest()[:16]
        self.ivb = hashlib.sha256(("ivb" + cnonce + nonce + key).encode()).digest()[:16]
        self.tag_prefix = digest(hashed + cnonce)
        self.stok = result["stok"]
        self.seq = int(result.get("start_seq", 0))
        self.tpap_keys = None

    def _tpap_request(self, payload):
        key, nonce = self.tpap_keys
        seq = (self.seq & 0xffffffff).to_bytes(4, "big")
        self.seq += 1
        plain = json.dumps(payload, separators=(",", ":")).encode()
        body = seq + _ccm_encrypt(key, nonce[:8] + seq, plain)
        raw = self._http_bytes(f"/stok={self.stok}/ds", body, self._app_headers("application/octet-stream"))
        if raw.startswith(b"{"):
            try:
                rejection = json.loads(raw)
            except ValueError:
                rejection = None  # A binary frame can start with the same byte.
            if isinstance(rejection, dict):
                if rejection.get("error_code") in (-40401, -40421):
                    raise DeviceError("Session de la caméra expirée")
                raise DeviceError("Commande refusée par la caméra")
        try:
            if len(raw) < 20:
                raise ValueError("short TPAP reply")
            reply = json.loads(_ccm_decrypt(key, nonce[:8] + raw[:4], raw[4:]))
        except ValueError:
            raise DeviceError("Réponse de la caméra invalide") from None
        if not isinstance(reply, dict):
            raise DeviceError("Réponse de la caméra invalide")
        return reply

    def request(self, payload):
        """Send one encrypted request and return the decrypted reply."""
        if self.stok is None:
            self.login()
        if self.tpap_keys is not None:
            return self._tpap_request(payload)
        plain = json.dumps(payload).encode()
        wrapper = json.dumps({"method": "securePassthrough", "params": {
            "request": base64.b64encode(aes_cbc_encrypt(self.lsk, self.ivb, plain)).decode()}})
        headers = {"Seq": str(self.seq),
                   "Tapo_tag": hashlib.sha256((self.tag_prefix + wrapper + str(self.seq)).encode()).hexdigest().upper()}
        self.seq += 1
        reply = self._http(f"/stok={self.stok}/ds", wrapper, headers)
        sealed = (reply.get("result") or {}).get("response")
        if not isinstance(sealed, str):
            raise DeviceError("Commande refusée par la caméra")
        try:
            inner = json.loads(aes_cbc_decrypt(self.lsk, self.ivb, base64.b64decode(sealed, validate=True)))
        except (ValueError, TypeError):
            raise DeviceError("Réponse de la caméra invalide") from None
        if not isinstance(inner, dict):
            raise DeviceError("Réponse de la caméra invalide")
        return inner

    def night_mode(self, mode=None):
        """Read the day/night mode, or set it to auto, on (infrared always on) or off. Returns the mode."""
        if mode is None:
            if self.stok is None:
                self.login()
            name = "common" if self.tpap_keys is not None else ["common"]
            reply = self.request({"method": "multipleRequest", "params": {"requests": [
                {"method": "getDayNightModeConfig", "params": {"image": {"name": name}}}]}})
            try:
                value = reply["result"]["responses"][0]["result"]["image"]["common"]["inf_type"]
            except (KeyError, IndexError, TypeError):
                raise DeviceError("Mode nuit illisible") from None
            return value if value in NIGHT_MODES else "auto"
        if mode not in NIGHT_MODES:
            raise DeviceError("Mode nuit inconnu")
        reply = self.request({"method": "multipleRequest", "params": {"requests": [
            {"method": "setDayNightModeConfig", "params": {"image": {"common": {"inf_type": NIGHT_MODES[mode]}}}}]}})
        try:
            code = reply["result"]["responses"][0]["error_code"]
        except (KeyError, IndexError, TypeError):
            raise DeviceError("Réponse de la caméra invalide") from None
        if code != 0:
            raise DeviceError("Mode nuit refusé par la caméra")
        return mode
