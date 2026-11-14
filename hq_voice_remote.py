"""Chatterbox on another PC: a voice worker that does the GPU work for Musica.

The worker (``hq_voice_worker.py``, copied to the other laptop) polls HQ outbound over Tailscale, takes one
sentence-sized synthesis job at a time, runs it on its own Chatterbox daemon and uploads the WAV. HQ never connects
to the worker and the browser never talks to it. Everything downstream of the audio (joining sentences, mastering,
the cache, the drops) stays on HQ, so the result is the same file a local daemon would have produced.

``generate`` is the one call the synth path uses: it returns WAV bytes, or None when the worker is off, slow or
failing, and the caller then does what it always did (local daemon, then Phonon). A circuit breaker skips the worker
for a minute after two failures, so a dead laptop costs one slow line, not every line.

Trust model: one worker, paired once with a one-time code (10 minutes, stored as a hash). The worker then holds a
random token; HQ keeps only its SHA-256. Every worker route needs ``Authorization: Bearer <worker id>.<token>``.
Traffic rides Tailscale (WireGuard) and Tailscale Serve's TLS. The worker route reads no cookie and takes no CSRF.
Nothing here ever runs a command or reads a path sent by the worker: a job names a voice, never a file.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets
import threading
import time
from typing import Any

import hq_music as music

STATE_FILE = "voice-worker.json"
CODE_TTL = 600
ONLINE_WITHIN = 25.0       # seconds since the last poll for the worker to count as online
BUSY_WITHIN = 75.0         # a worker busy on a job does not poll: it still counts as online for this long
QUEUE_EXTRA = 90.0         # a job may wait this long behind others before it is given up (the timeout runs from its claim)
POLL_WAIT = 8.0            # long poll
JOB_MAX_AGE = 120.0
BREAKER_FAILS = 2
BREAKER_PAUSE = 60.0
MAX_RESULT_B64 = 9_000_000  # ~6.5 MB of WAV: one sentence at 24 kHz is far below this
MAX_VOICE_B64 = 24_000_000  # a ~30 s reference clip at 24 kHz is ~3 MB of WAV (4.2 MB base64); this allows ~18 MB
ENROLL_MAX = 6              # per ip per 10 minutes
VOICE_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

_cond = threading.Condition()
_jobs: dict[str, dict[str, Any]] = {}
_live: dict[str, Any] = {"seen": 0.0, "info": {}, "busy": None, "last_ms": None, "last_error": None, "done": 0}
_breaker: dict[str, Any] = {"fails": 0, "until": 0.0}
_hits: dict[str, list[float]] = {}


def _state() -> dict[str, Any]:
    raw = music._load(STATE_FILE, {})
    return raw if isinstance(raw, dict) else {}


def _save(state: dict[str, Any]) -> None:
    music._write(STATE_FILE, state)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ---- pairing (admin side) ------------------------------------------------------------------------------------------

def create_code() -> dict[str, Any]:
    """A one-time pairing code, shown once; only its hash is stored."""
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
    pretty = "-".join(code[i:i + 4] for i in range(0, 12, 4))
    state = _state()
    state["code"] = {"hash": _hash(code), "expires": time.time() + CODE_TTL}
    _save(state)
    return {"code": pretty, "ttl_sec": CODE_TTL}


def set_enabled(enabled: Any) -> dict[str, Any]:
    if type(enabled) is not bool:
        raise ValueError("Choix requis")
    state = _state()
    state["enabled"] = enabled
    _save(state)
    return status()


def remove() -> dict[str, Any]:
    state = _state()
    state.pop("worker", None)
    state.pop("code", None)
    _save(state)
    with _cond:
        _live.update(seen=0.0, info={}, busy=None)
        for job in _jobs.values():
            if job["state"] in ("queued", "claimed"):
                job["state"] = "failed"
        _cond.notify_all()
    return status()


def _worker() -> dict[str, Any] | None:
    worker = _state().get("worker")
    return worker if isinstance(worker, dict) and worker.get("token_hash") else None


def _alive() -> bool:
    """Polled lately, or busy on a job (the worker does not poll while it synthesizes)."""
    now = time.time()
    if now - float(_live["seen"]) < ONLINE_WITHIN:
        return True
    return bool(_live["busy"]) and now - float(_live.get("busy_since") or 0.0) < BUSY_WITHIN


def online() -> bool:
    return bool(_worker()) and _alive()


def available() -> bool:
    """Should the synth path try the worker? Enabled, paired, answering lately, and the breaker closed."""
    if not _state().get("enabled", True) or not _worker():
        return False
    return online() and time.time() >= float(_breaker["until"])


def status() -> dict[str, Any]:
    state = _state()
    worker = _worker()
    now = time.time()
    seen = float(_live["seen"])
    info = dict(_live["info"] or {})
    code = state.get("code") or {}
    return {
        "ok": True,
        "enabled": bool(state.get("enabled", True)),
        "paired": bool(worker),
        "name": (worker or {}).get("name"),
        "online": bool(worker) and _alive(),
        "seen_sec": round(now - seen, 1) if seen else None,
        "gpu": info.get("gpu"), "vram_mb": info.get("vram_mb"), "device": info.get("device"), "ready": info.get("ready"),
        "last_ms": _live["last_ms"], "last_error": _live["last_error"], "done": int(_live["done"]),
        "breaker_open": now < float(_breaker["until"]),
        "code_pending": float(code.get("expires") or 0) > now,
    }


# ---- the synth path ------------------------------------------------------------------------------------------------

def _fail() -> None:
    _breaker["fails"] = int(_breaker["fails"]) + 1
    if _breaker["fails"] >= BREAKER_FAILS:
        _breaker.update(until=time.time() + BREAKER_PAUSE, fails=0)


def generate(payload: dict[str, Any], voice_stamp: int, timeout: float) -> bytes | None:
    """One synthesis on the worker. WAV bytes, or None (not available, failed, too slow) -> the caller falls back."""
    voice = str(payload.get("voice") or "")
    if not available() or not VOICE_RE.fullmatch(voice):
        return None
    job_id = secrets.token_hex(8)
    job = {"id": job_id, "state": "queued", "created": time.time(), "voice_stamp": int(voice_stamp),
           "payload": {"text": str(payload.get("text") or "")[:600], "voice": voice,
                       "exaggeration": payload.get("exaggeration"), "cfg_weight": payload.get("cfg_weight"),
                       "temperature": payload.get("temperature")},
           "wav": None, "error": None}
    work = max(3.0, float(timeout))                     # the time allowed once the worker has the job
    queue_cap = time.monotonic() + work + QUEUE_EXTRA   # the time allowed behind other jobs
    with _cond:
        for stale in [k for k, v in _jobs.items() if time.time() - v["created"] > JOB_MAX_AGE]:
            _jobs.pop(stale, None)
        _jobs[job_id] = job
        _cond.notify_all()
        while job["state"] in ("queued", "claimed"):
            if job["state"] == "claimed":
                left = job["claimed_mono"] + work - time.monotonic()
            else:
                left = queue_cap - time.monotonic()
                if left > 0 and not _alive():  # queued and nobody is there any more: do not wait for nothing
                    left = 0
            if left <= 0:
                job["state"] = "abandoned"  # a late result is discarded
                _live["last_error"] = "délai dépassé"
                _fail()
                _cond.notify_all()
                return None
            _cond.wait(min(left, 1.0))
        wav = job["wav"] if job["state"] == "done" else None
        _jobs.pop(job_id, None)
    if wav:
        _breaker["fails"] = 0
        return wav
    _fail()
    return None


# ---- the worker API (no cookie, no CSRF: bearer token) --------------------------------------------------------------

def max_body(path: str) -> int:
    return MAX_RESULT_B64 + 4096 if "/result/" in path else 64 * 1024


def _rate_ok(ip: str) -> bool:
    now = time.time()
    hits = [t for t in _hits.get(ip, []) if now - t < 600]
    if len(hits) >= ENROLL_MAX:
        _hits[ip] = hits
        return False
    hits.append(now)
    _hits[ip] = hits
    return True


def _authenticate(headers: Any) -> dict[str, Any] | None:
    raw = str((headers.get("Authorization") if headers is not None else "") or "")
    if not raw.startswith("Bearer ") or "." not in raw:
        return None
    worker_id, _, token = raw[7:].partition(".")
    worker = _worker()
    if not worker or not hmac.compare_digest(str(worker.get("id", "")).encode(), worker_id.encode("utf-8", "replace")):
        return None
    return worker if hmac.compare_digest(worker["token_hash"].encode(), _hash(token).encode()) else None


def _clean_info(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = {}
    for key in ("gpu", "device", "version"):
        if isinstance(raw.get(key), str):
            out[key] = raw[key][:80]
    if isinstance(raw.get("vram_mb"), (int, float)) and not isinstance(raw.get("vram_mb"), bool):
        out["vram_mb"] = int(raw["vram_mb"])
    if isinstance(raw.get("ready"), bool):
        out["ready"] = raw["ready"]
    return out


def handle_worker(method: str, path: str, headers: Any, body: Any, ip: str) -> tuple[int, dict[str, Any]]:
    import json

    if method != "POST":
        return 405, {"error": "POST requis"}
    try:
        data = json.loads(body.decode("utf-8") if body else "{}")
    except (ValueError, UnicodeDecodeError):
        return 400, {"error": "JSON invalide"}
    if not isinstance(data, dict):
        return 400, {"error": "JSON invalide"}
    route = path.split("?", 1)[0].removeprefix("/voice-worker/v1/").strip("/")

    if route == "enroll":
        if not _rate_ok(ip or "?"):
            return 429, {"error": "Trop d’essais", "code": "rate"}
        state = _state()
        row = state.get("code") or {}
        digest = _hash(str(data.get("code") or "").replace("-", "").replace(" ", "").upper())
        if not row or float(row.get("expires") or 0) < time.time() or not hmac.compare_digest(str(row.get("hash")).encode(), digest.encode()):
            return 403, {"error": "Code invalide ou expiré", "code": "code_invalid"}
        worker_id = "vw_" + secrets.token_hex(6)
        token = secrets.token_hex(32)
        name = " ".join(str(data.get("name") or "PC").split())[:40] or "PC"
        state.pop("code", None)  # one use
        state["worker"] = {"id": worker_id, "name": name, "token_hash": _hash(token), "created": time.time()}
        state.setdefault("enabled", True)
        _save(state)
        _live.update(seen=time.time(), info=_clean_info(data.get("info")), busy=None)
        return 200, {"worker_id": worker_id, "token": token, "poll_sec": POLL_WAIT}

    worker = _authenticate(headers)
    if worker is None:
        return 401, {"error": "Non autorisé", "code": "unauthorized"}

    if route == "poll":
        _live["seen"] = time.time()
        _live["info"] = _clean_info(data.get("info")) or _live["info"]
        end = time.monotonic() + POLL_WAIT
        with _cond:
            while True:
                job = next((j for j in sorted(_jobs.values(), key=lambda j: j["created"]) if j["state"] == "queued"), None)
                if job:
                    job["state"] = "claimed"
                    job["claimed_mono"] = time.monotonic()
                    _live["busy"] = job["id"]
                    _live["busy_since"] = time.time()
                    _live["seen"] = time.time()
                    return 200, {"job": {"id": job["id"], "voice_stamp": job["voice_stamp"], **job["payload"]}}
                left = end - time.monotonic()
                if left <= 0:
                    _live["seen"] = time.time()
                    return 200, {"job": None}
                _cond.wait(min(left, 1.0))

    if route.startswith("voice/"):
        name = route.split("/", 1)[1]
        if not VOICE_RE.fullmatch(name):
            return 400, {"error": "Voix invalide"}
        import hq_voice_chatterbox as cb
        if not cb.has_voice(name):
            return 404, {"error": "Voix inconnue", "code": "no_voice"}
        wav = (cb.VOICES_DIR / f"{name}.wav").read_bytes()
        encoded = base64.b64encode(wav).decode("ascii")
        if len(encoded) > MAX_VOICE_B64:
            return 413, {"error": "Voix trop volumineuse"}
        return 200, {"voice": name, "stamp": cb.voice_stamp(name), "wav_b64": encoded}

    if route.startswith("result/"):
        job_id = route.split("/", 1)[1]
        with _cond:
            job = _jobs.get(job_id)
            if not job or job["state"] != "claimed":
                return 200, {"ok": False, "ignored": True}  # abandoned or unknown: nothing to do
            _live["busy"] = None
            _live["seen"] = time.time()
            if data.get("ok") is True and isinstance(data.get("wav_b64"), str):
                try:
                    wav = base64.b64decode(data["wav_b64"], validate=True)
                except ValueError:
                    wav = b""
                if wav[:4] == b"RIFF" and len(wav) > 64:
                    job.update(state="done", wav=wav)
                    _live["done"] = int(_live["done"]) + 1
                    _live["last_ms"] = int(data["ms"]) if isinstance(data.get("ms"), (int, float)) and not isinstance(data.get("ms"), bool) else None
                    _live["last_error"] = None
                    _cond.notify_all()
                    return 200, {"ok": True}
            job.update(state="failed", error=str(data.get("error") or "")[:160])
            _live["last_error"] = job["error"] or "échec"
            _cond.notify_all()
            return 200, {"ok": True}

    return 404, {"error": "Inconnu"}
