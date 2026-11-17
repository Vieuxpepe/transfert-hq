"""SPAKE2+ (P-256, RFC 9383) and the C200 password shadow for local TPAP login."""

# Based on the MIT-licensed pytapo SPAKE2+ implementation and freeKC's reference.
# https://github.com/JurajNyiri/pytapo/blob/main/pytapo/transport/tpap/spake2p.py
# https://github.com/freeKC/tapo-v4-protocol
#
# MIT License
#
# Copyright (c) 2020 Juraj Nyíri
# Copyright (c) 2026 freeKC
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import base64
import hashlib
import hmac
import re
import struct

# --------------------------------------------------------------------------- #
#  P-256 affine point arithmetic
# --------------------------------------------------------------------------- #
P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
A = P - 3
B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
G_POINT = (
    0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
    0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5,
)


def _inv(x):
    return pow(x % P, P - 2, P)


def pt_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2 and (y1 + y2) % P == 0:
        return None
    if p1 == p2:
        m = (3 * x1 * x1 + A) * _inv(2 * y1) % P
    else:
        m = (y2 - y1) * _inv(x2 - x1) % P
    x3 = (m * m - x1 - x2) % P
    return (x3, (m * (x1 - x3) - y1) % P)


def pt_mul(k, p):
    k %= N
    result, addend = None, p
    while k:
        if k & 1:
            result = pt_add(result, addend)
        addend = pt_add(addend, addend)
        k >>= 1
    return result


def pt_neg(p):
    return None if p is None else (p[0], (-p[1]) % P)


def decode_point(data):
    """Decode a SEC1 P-256 point and verify it is on the curve."""
    x = int.from_bytes(data[1:33], "big")
    rhs = (pow(x, 3, P) + A * x + B) % P
    if len(data) == 65 and data[0] == 4:
        y = int.from_bytes(data[33:], "big")
    elif len(data) == 33 and data[0] in (2, 3):
        y = pow(rhs, (P + 1) // 4, P)
        if (y & 1) != (data[0] & 1):
            y = P - y
    else:
        raise ValueError("bad point encoding")
    if not (0 <= x < P and 0 <= y < P) or y * y % P != rhs:
        raise ValueError("point is outside the curve")
    return x, y


def encode_point(p):
    return b"\x04" + p[0].to_bytes(32, "big") + p[1].to_bytes(32, "big")


M_POINT = decode_point(
    bytes.fromhex("02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f")
)
N_POINT = decode_point(
    bytes.fromhex("03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49")
)

CONTEXT_TAG = b"PAKE V1"


def hkdf_sha256(ikm, salt, info, length):
    if salt is None:
        salt = b"\x00" * 32
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    out, t, i = b"", b"", 1
    while len(out) < length:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        out += t
        i += 1
    return out[:length]


def _len_prefixed(*chunks):
    return b"".join(struct.pack("<Q", len(c)) + c for c in chunks)


# --------------------------------------------------------------------------- #
#  Credential transforms
# --------------------------------------------------------------------------- #
def md5_hex(text):
    return hashlib.md5(text.encode()).hexdigest()


def sha256_hex_upper(text):
    return hashlib.sha256(text.encode()).hexdigest().upper()


_CRYPT_B64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_CRYPT_ORDER = [
    (0, 10, 20),
    (21, 1, 11),
    (12, 22, 2),
    (3, 13, 23),
    (24, 4, 14),
    (15, 25, 5),
    (6, 16, 26),
    (27, 7, 17),
    (18, 28, 8),
    (9, 19, 29),
]


def _to64(value, n):
    out = ""
    for _ in range(n):
        out += _CRYPT_B64[value & 0x3F]
        value >>= 6
    return out


def _repeat(digest, length):
    return (digest * (length // 32 + 1))[:length]


def sha256_crypt(key, prefix):
    """SHA-256-crypt ("$5$", Drepper) exactly as Spake2pExtraCryptBean.sha256Shadow:
    salt and optional rounds come from the prefix, the salt is cut to 16 chars,
    and the full "$5$[rounds=N$]salt$hash" string is returned."""
    rest = prefix[3:] if prefix.startswith("$5$") else prefix
    rounds, explicit = 5000, False
    if rest.startswith("rounds="):
        head, _, tail = rest.partition("$")
        if tail:
            rounds = max(1000, min(999_999_999, int(head[7:])))
            rest, explicit = tail, True
    end = rest.find("$")
    salt = rest[: min(end if end > 0 else len(rest), 16)]
    k, s = key.encode(), salt.encode()

    b = hashlib.sha256(k + s + k).digest()
    a = hashlib.sha256(k + s + _repeat(b, len(k)))
    n = len(k)
    while n:
        a.update(b if n & 1 else k)
        n >>= 1
    a = a.digest()
    p = _repeat(hashlib.sha256(k * len(k)).digest(), len(k))
    sb = _repeat(hashlib.sha256(s * (16 + a[0])).digest(), len(s))

    c = a
    for i in range(rounds):
        h = hashlib.sha256(p if i & 1 else c)
        if i % 3:
            h.update(sb)
        if i % 7:
            h.update(p)
        h.update(c if i & 1 else p)
        c = h.digest()

    enc = "".join(
        _to64((c[x] << 16) | (c[y] << 8) | c[z], 4) for x, y, z in _CRYPT_ORDER
    )
    enc += _to64((c[31] << 8) | c[30], 3)
    rounds_part = f"rounds={rounds}$" if explicit else ""
    return f"$5${rounds_part}{salt}${enc}"


def c200_credential(password, extra_crypt):
    """Apply the password shadow requested by the C200 V5 on TPAP."""
    params = extra_crypt.get("params") or {}
    prefix = params.get("passwd_prefix")
    if extra_crypt.get("type") != "password_shadow" or params.get("passwd_id") != 5:
        raise ValueError("unsupported password shadow")
    if not isinstance(prefix, str) or not re.fullmatch(
        r"\$5\$(?:rounds=[0-9]{1,5}\$)?[./A-Za-z0-9]{1,16}\$?", prefix
    ):
        raise ValueError("invalid password shadow prefix")
    return sha256_crypt(sha256_hex_upper(password), prefix)


# --------------------------------------------------------------------------- #
#  One SPAKE2+ exchange
# --------------------------------------------------------------------------- #
class Spake2pClient:
    """Holds the client side of one pake_register -> pake_share exchange."""

    def __init__(self, register_result, user_random, credential, random_scalar):
        res = register_result
        dev_salt = base64.b64decode(res["dev_salt"], validate=True)
        dev_random = base64.b64decode(res["dev_random"], validate=True)
        iterations = int(res["iterations"])
        if not dev_salt or not 1 <= iterations <= 200_000 or len(dev_random) != 32:
            raise ValueError("invalid SPAKE2+ challenge")
        Y = decode_point(base64.b64decode(res["dev_share"], validate=True))
        dk = hashlib.pbkdf2_hmac("sha256", credential.encode(), dev_salt, iterations, 80)
        w0 = int.from_bytes(dk[:40], "big") % N
        w1 = int.from_bytes(dk[40:], "big") % N
        x = random_scalar % (N - 1) + 1
        X = pt_add(pt_mul(x, G_POINT), pt_mul(w0, M_POINT))
        H = pt_add(Y, pt_neg(pt_mul(w0, N_POINT)))
        self.Xb, Yb = encode_point(X), encode_point(Y)
        context = hashlib.sha256(
            CONTEXT_TAG
            + base64.b64decode(user_random)
            + dev_random
        ).digest()
        transcript = _len_prefixed(
            context,
            b"",
            b"",
            encode_point(M_POINT),
            encode_point(N_POINT),
            self.Xb,
            Yb,
            encode_point(pt_mul(x, H)),
            encode_point(pt_mul(w1, H)),
            w0.to_bytes(32, "big"),
        )
        ke = hashlib.sha256(transcript).digest()
        conf = hkdf_sha256(ke, None, b"ConfirmationKeys", 64)
        self._kcb = conf[32:]
        self.user_confirm = hmac.new(conf[:32], Yb, hashlib.sha256).digest()
        self.shared_key = hkdf_sha256(ke, None, b"SharedKey", 32)

    def device_confirm_ok(self, dev_confirm):
        expected = hmac.new(self._kcb, self.Xb, hashlib.sha256).digest()
        return hmac.compare_digest(dev_confirm, expected)

    def session_key_and_nonce(self):
        key = hkdf_sha256(
            self.shared_key, b"tp-kdf-salt-aes128-key", b"tp-kdf-info-aes128-key", 32
        )[:16]
        nonce = hkdf_sha256(
            self.shared_key, b"tp-kdf-salt-aes128-iv", b"tp-kdf-info-aes128-iv", 32
        )[:12]
        return key, nonce
