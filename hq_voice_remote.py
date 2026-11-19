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
TEXT_QUIET = 5.0           # no text job within this many seconds of a voice request: a sentence is never made to wait for one
TEXT_QUEUE_WAIT = 12.0     # a text job not claimed by then is dropped: the next provider answers instead
TEXT_BREAKER_PAUSE = 120.0
TEXT_MAX_MESSAGES = 24
TEXT_MAX_CHARS = 12_000    # the worker's LLM runs with a 4096-token window
TEXT_MAX_TOKENS = 400
EMBED_MAX_TEXTS = 16       # texts per job (the worker's CPU model takes ~0.6 s per 800-character text)
EMBED_MAX_CHARS = 1500
EMBED_MAX_DIM = 4096
EMBED_QUIET = 2.0          # a query typed by the owner may follow a sentence this closely; batch indexing waits TEXT_QUIET
MAX_RESULT_B64 = 9_000_000  # ~6.5 MB of WAV: one sentence at 24 kHz is far below this
MAX_VOICE_B64 = 24_000_000  # a ~30 s reference clip at 24 kHz is ~3 MB of WAV (4.2 MB base64); this allows ~18 MB
ENROLL_MAX = 6              # per ip per 10 minutes
VOICE_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

_cond = threading.Condition()
_jobs: dict[str, dict[str, Any]] = {}
_live: dict[str, Any] = {"seen": 0.0, "info": {}, "busy": None, "last_ms": None, "last_error": None, "done": 0}
_breaker: dict[str, Any] = {"fails": 0, "until": 0.0}
_text_breaker: dict[str, Any] = {"fails": 0, "until": 0.0}
_embed_breaker: dict[str, Any] = {"fails": 0, "until": 0.0}
_STARTED = time.time()     # a bridge restart forgets the last poll: silence is counted from here at the earliest
OFFLINE_ALERT_AFTER = 600.0  # seconds of silence before HQ flags a paired worker (the laptop's task relaunches it within ~6 min)
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


def offline_alert() -> dict[str, Any] | None:
    """A paired, enabled worker that has been silent for OFFLINE_ALERT_AFTER seconds: ``{"name", "quiet_sec"}`` for the
    Accueil attention list. None when it is fine, off, not paired, or HQ itself has only just started."""
    worker = _worker()
    if not worker or not _state().get("enabled", True) or _alive():
        return None
    quiet = time.time() - max(float(_live["seen"]), _STARTED)
    if quiet < OFFLINE_ALERT_AFTER:
        return None
    return {"name": str(worker.get("name") or "PC voix")[:40], "quiet_sec": int(quiet)}


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
        "llm": bool(info.get("llm")), "embed": bool(info.get("embed")), "text_done": int(_live.get("text_done") or 0),
        "text_breaker_open": now < float(_text_breaker["until"]),
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
    _live["voice_last"] = time.time()                   # a conversation is under way: text jobs keep out of its way
    with _cond:
        wav = _await(job, work, queue_cap)
    if wav:
        _breaker["fails"] = 0
        return wav
    _fail()
    return None


def _await(job: dict[str, Any], work: float, queue_cap: float) -> Any:
    """Queue ``job`` and wait for it (call with ``_cond`` held). Its result (wav or text), or None when it was
    abandoned (too slow, nobody polling), failed or came back empty. The caller counts the failure."""
    for stale in [k for k, v in _jobs.items() if time.time() - v["created"] > JOB_MAX_AGE]:
        _jobs.pop(stale, None)
    _jobs[job["id"]] = job
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
            _cond.notify_all()
            return None
        _cond.wait(min(left, 1.0))
    kind = job.get("kind")
    result = (job.get("text") if kind == "text" else job.get("vectors") if kind == "embed" else job["wav"]) if job["state"] == "done" else None
    _jobs.pop(job["id"], None)
    return result


# ---- the text path: a small local LLM on the same PC, only while the voice is idle ----------------------------------

def llm_ready() -> bool:
    """A worker that says it has a language model, answering lately, text breaker closed."""
    if not _state().get("enabled", True) or not _worker() or not (_live["info"] or {}).get("llm"):
        return False
    return online() and time.time() >= float(_text_breaker["until"])


def _clean_messages(messages: Any) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    total = 0
    for m in (messages if isinstance(messages, list) else [])[-TEXT_MAX_MESSAGES:]:
        if not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant"):
            continue
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        total += len(content)
        out.append({"role": str(m["role"]), "content": content})
    return out if total <= TEXT_MAX_CHARS and any(m["role"] == "user" for m in out) else []


def generate_text(messages: Any, *, temperature: float = 0.7, max_tokens: int = 256, timeout: float = 25.0,
                  json_mode: bool = False) -> str | None:
    """One short completion on the worker's LLM. The text, or None (not available, voice busy, failed, too slow) and
    the caller goes on to the next provider. Voice always wins: nothing is sent while a sentence is queued, being
    made, or was asked for in the last ``TEXT_QUIET`` seconds (the LLM shares the GPU with Chatterbox and the worker
    does one job at a time)."""
    clean = _clean_messages(messages)
    if not clean or not llm_ready():
        return None
    now = time.time()
    if now - float(_live.get("voice_last") or 0.0) < TEXT_QUIET:
        return None
    job_id = secrets.token_hex(8)
    job = {"id": job_id, "kind": "text", "state": "queued", "created": now, "voice_stamp": 0,
           "payload": {"messages": clean, "temperature": max(0.0, min(1.5, float(temperature))),
                       "max_tokens": max(16, min(TEXT_MAX_TOKENS, int(max_tokens))), "json": bool(json_mode)},
           "text": None, "error": None}
    work = max(5.0, float(timeout))
    with _cond:
        if any(j["state"] in ("queued", "claimed") for j in _jobs.values()):
            return None  # the worker is busy: do not stack text behind a sentence
        text = _await(job, work, time.monotonic() + TEXT_QUEUE_WAIT)
    if text:
        _text_breaker["fails"] = 0
        return text
    _text_fail()
    return None


def embed_ready() -> bool:
    """A worker that says it has an embedding model, answering lately, embed breaker closed."""
    if not _state().get("enabled", True) or not _worker() or not (_live["info"] or {}).get("embed"):
        return False
    return online() and time.time() >= float(_embed_breaker["until"])


def embed(texts: Any, *, timeout: float = 30.0, urgent: bool = False) -> list[list[float]] | None:
    """Vectors for ``texts`` (same order, one per text) from the worker's embedding model, or None (not available, voice
    busy, failed, too slow, malformed answer) and the caller simply has no semantic result. ``urgent`` is a query the owner is
    waiting for: it only waits ``EMBED_QUIET`` after a sentence instead of ``TEXT_QUIET``. CPU only on the worker, so it never
    takes VRAM from Chatterbox, but the worker does one job at a time and a sentence is always claimed first."""
    if not isinstance(texts, list) or not 0 < len(texts) <= EMBED_MAX_TEXTS or not embed_ready():
        return None
    clean = [t.strip()[:EMBED_MAX_CHARS] if isinstance(t, str) else "" for t in texts]
    if not all(clean):
        return None
    now = time.time()
    if now - float(_live.get("voice_last") or 0.0) < (EMBED_QUIET if urgent else TEXT_QUIET):
        return None
    job = {"id": secrets.token_hex(8), "kind": "embed", "state": "queued", "created": now, "voice_stamp": 0,
           "payload": {"texts": clean}, "vectors": None, "error": None}
    with _cond:
        if any(j["state"] in ("queued", "claimed") for j in _jobs.values()):
            return None
        vectors = _await(job, max(5.0, float(timeout)), time.monotonic() + TEXT_QUEUE_WAIT)
    if vectors:
        _embed_breaker["fails"] = 0
        return vectors
    _embed_breaker["fails"] = int(_embed_breaker["fails"]) + 1
    if _embed_breaker["fails"] >= BREAKER_FAILS:
        _embed_breaker.update(until=time.time() + TEXT_BREAKER_PAUSE, fails=0)
    return None


def _clean_vectors(raw: Any, count: int) -> list[list[float]] | None:
    """``count`` finite vectors of one common length, or None (a malformed worker answer is a failed job)."""
    if not isinstance(raw, list) or len(raw) != count:
        return None
    out: list[list[float]] = []
    for row in raw:
        if not isinstance(row, list) or not 8 <= len(row) <= EMBED_MAX_DIM:
            return None
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or x != x or x in (float("inf"), float("-inf")) for x in row):
            return None
        out.append([float(x) for x in row])
    return out if len({len(r) for r in out}) == 1 else None


def _text_fail() -> None:
    _text_breaker["fails"] = int(_text_breaker["fails"]) + 1
    if _text_breaker["fails"] >= BREAKER_FAILS:
        _text_breaker.update(until=time.time() + TEXT_BREAKER_PAUSE, fails=0)


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
    for key in ("ready", "llm", "embed"):
        if isinstance(raw.get(key), bool):
            out[key] = raw[key]
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
                job = next((j for j in sorted(_jobs.values(), key=lambda j: (j.get("kind") in ("text", "embed"), j["created"]))
                            if j["state"] == "queued"), None)  # a sentence always goes before a text job
                if job:
                    job["state"] = "claimed"
                    job["claimed_mono"] = time.monotonic()
                    _live["busy"] = job["id"]
                    _live["busy_since"] = time.time()
                    _live["seen"] = time.time()
                    return 200, {"job": {"id": job["id"], "kind": job.get("kind", "voice"), "voice_stamp": job["voice_stamp"],
                                         **job["payload"]}}
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
            if job.get("kind") == "embed":
                vectors = _clean_vectors(data.get("vectors"), len(job["payload"]["texts"])) if data.get("ok") is True else None
                if vectors:
                    job.update(state="done", vectors=vectors)
                    _live["text_done"] = int(_live.get("text_done") or 0) + 1
                else:
                    job.update(state="failed", error=str(data.get("error") or "vecteurs invalides")[:160])
                    _live["last_error"] = job["error"]
                _cond.notify_all()
                return 200, {"ok": True}
            if job.get("kind") == "text":
                text = str(data.get("text") or "").strip()[:4000] if data.get("ok") is True else ""
                if text:
                    job.update(state="done", text=text)
                    _live["text_done"] = int(_live.get("text_done") or 0) + 1
                else:
                    job.update(state="failed", error=str(data.get("error") or "")[:160])
                    _live["last_error"] = job["error"] or "échec"
                _cond.notify_all()
                return 200, {"ok": True}
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
