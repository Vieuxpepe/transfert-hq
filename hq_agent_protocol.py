"""Wire format for Transfert HQ companions.

HMAC-SHA256 over a canonical string. No WebSocket, no inbound listener.
The companion calls the controller; the controller does not dial the PC.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from urllib.parse import urlparse

PROTOCOL_VERSION = 1

HEADER_DEVICE = "X-HQ-Device"
HEADER_TIME = "X-HQ-Time"
HEADER_NONCE = "X-HQ-Nonce"
HEADER_SIGNATURE = "X-HQ-Signature"
HEADER_DISPATCH = "X-HQ-Dispatch"
HEADER_JOB = "X-HQ-Job"
HEADER_ARTIFACT_NAME = "X-HQ-Artifact-Name"

SKEW_SEC = 90
NONCE_TTL_SEC = 180
POLL_SEC = 3
IDLE_POLL_SEC = 15
ERROR_BACKOFF_MAX_SEC = 60

NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
DEVICE_ID_RE = re.compile(r"^ag_[a-f0-9]{8,32}$")
JOB_ID_RE = re.compile(r"^job_[a-f0-9]{8,32}$")

# Body caps. Artifact bytes are not JSON.
JSON_BODY_MAX = 64 * 1024
HEARTBEAT_MAX = 8 * 1024
ENROLL_MAX = 16 * 1024
RESULT_MAX = 256 * 1024
ARTIFACT_MAX = 16 * 1024 * 1024
OUTPUT_MAX = 16 * 1024
ARGS_MAX = 8 * 1024


def body_hash(body: bytes) -> str:
    return hashlib.sha256(body or b"").hexdigest()


def canonical(method: str, path: str, timestamp: int, nonce: str, body: bytes) -> bytes:
    text = "\n".join(
        [
            (method or "").upper(),
            path or "",
            str(int(timestamp)),
            nonce or "",
            body_hash(body or b""),
        ]
    )
    return text.encode("utf-8")


def sign(secret: str, method: str, path: str, timestamp: int, nonce: str, body: bytes) -> str:
    mac = hmac.new((secret or "").encode("utf-8"), canonical(method, path, timestamp, nonce, body), hashlib.sha256)
    return mac.hexdigest()


def signatures_equal(presented: str, expected: str) -> bool:
    """Compare MACs in constant time, including when the lengths differ."""
    left = hashlib.sha256((presented or "").encode("utf-8")).digest()
    right = hashlib.sha256((expected or "").encode("utf-8")).digest()
    same = hmac.compare_digest(left, right)
    return bool(same and len(presented or "") == len(expected or "") == 64)


def parse_timestamp(raw: str) -> int | None:
    text = (raw or "").strip()
    if not text or not text.lstrip("-").isdigit():
        return None
    try:
        return int(text)
    except ValueError:
        return None


def validate_controller_url(url: str, *, dev: bool) -> str:
    """Production companions talk HTTPS only. --dev is loopback HTTP/HTTPS."""
    parsed = urlparse((url or "").strip())
    host = (parsed.hostname or "").lower()
    if dev:
        if parsed.scheme not in ("http", "https") or host not in ("127.0.0.1", "localhost", "::1"):
            raise ValueError("mode dev : contrôleur loopback seulement")
        return (url or "").rstrip("/")
    if parsed.scheme != "https" or not host:
        raise ValueError("HTTPS Tailscale requis")
    return (url or "").rstrip("/")


def next_delay(*, poll_sec: float, idle_sec: float, idle_streak: int, error_streak: int) -> float:
    """Connected poll stays in 2–5s. Idle stretches toward 15s. Errors back off, bounded."""
    poll = min(5.0, max(2.0, float(poll_sec or POLL_SEC)))
    idle = min(15.0, max(poll, float(idle_sec or IDLE_POLL_SEC)))
    if error_streak > 0:
        delay = poll * (2 ** min(int(error_streak), 5))
        return min(float(ERROR_BACKOFF_MAX_SEC), max(poll, delay))
    if idle_streak <= 0:
        return poll
    return min(idle, poll + float(idle_streak))
