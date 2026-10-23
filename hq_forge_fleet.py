"""Multi-device Forge generation: worker registry, enrollment, HMAC auth, batch scheduler.

HQ is the coordinator. Browsers only reach HQ's authenticated admin APIs; HQ
never dials a worker and never accepts a URL or host from the browser. Remote
workers (``hq_forge_worker.py``) poll HQ under ``/forge-worker/v1/`` with an
HMAC-SHA256 signature and run txt2img on their own local Forge.

The HQ machine itself is the built-in worker ``local``. Its tasks go through
the existing local Forge client and share the single-job gate with
``hq_forge_jobs``: one HQ generation at a time on the local Forge.

Scheduling rules
* One image per task. N images are split across the selected workers by
  availability: a free worker takes the next queued task of the oldest batch.
* Seeds are explicit per image. A fixed seed ``s`` gives ``s, s+1, ...``
  (mod 2**32); a random seed (-1) draws one random seed per image, recorded.
* A task handed to a worker is ``dispatched``. If its lease expires or the
  worker reports it no longer has it, the task becomes ``uncertain`` and is
  never re-run automatically. Only never-dispatched tasks wait for a worker.
* On HQ restart, queued tasks resume and dispatched ones become uncertain.
* Cancel drops queued tasks and marks dispatched ones cancel-deferred. Forge
  is never interrupted (its /interrupt is process-wide).
* Private generation never enters this module: private batches are refused.

Secrets: the one-time enrollment code is stored as a SHA-256 hash only. HMAC
needs the worker secret itself, so HQ keeps it wrapped with Windows DPAPI
(current user) where available, in ``.hq-forge/workers.json`` under a
protected DACL (SYSTEM, Administrators, current user). Same caveat as the
companion protocol: the nonce cache is process-local.
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
import hmac
import json
import math
import os
import re
import secrets
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import hq_forge as forge
import hq_forge_gallery as gallery
import hq_forge_jobs as jobs
import hq_forge_stats as stats
import hq_forge_worker as wire

LOCAL_ID = "local"
WORKER_RE = re.compile(r"^wk_[0-9a-f]{16}$")
BATCH_RE = re.compile(r"^bt-[0-9a-f]{24}$")
TASK_RE = re.compile(r"^tk-[0-9a-f]{24}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_TTL_SEC = 600
SKEW_SEC = 90
NONCE_TTL_SEC = 180
ONLINE_SEC = 30
LEASE_SEC = 90
LEASE_MAX_SEC = 660
MAX_WORKERS = 16
MAX_CODES = 4
MAX_BATCHES = 50
MAX_IMAGES = 16
ENROLL_WINDOW_SEC = 600
ENROLL_MAX_PER_IP = 10
ENROLL_MAX_GLOBAL = 30
POLL_MAX = 64 * 1024
RESULT_MAX = 30 * 1024 * 1024
ENROLL_MAX = 16 * 1024

STATE_LABELS = {
    "disabled": "Désactivé",
    "offline": "Hors ligne",
    "forge_down": "Forge indisponible",
    "busy": "Occupé",
    "error": "Erreur",
    "available": "Disponible",
}

MESSAGES = {
    "validation": "Les réglages ne sont pas acceptés.",
    "no_workers": "Choisissez au moins un appareil.",
    "unknown_worker": "Un appareil choisi n'existe plus.",
    "unavailable": "Un appareil choisi n'est pas disponible.",
    "incompatible": "Un appareil choisi ne peut pas produire ces réglages.",
    "retry_running": "Le lot est encore en cours. Relancez une fois qu'il est terminé.",
    "retry_nothing": "Aucune image manquante à relancer.",
    "retry_none": "Aucun appareil du lot n'est disponible pour relancer.",
    "forge_oom": "Forge a manqu\u00e9 de m\u00e9moire GPU pour ces r\u00e9glages.",
    "model_mismatch": "La version du mod\u00e8le sur l'appareil ne correspond plus au lot.",
    "private_remote": "La génération privée reste sur cet HQ. Les autres appareils ne reçoivent jamais un prompt privé.",
    "private_batch": "La génération privée passe par la génération simple de cet HQ.",
    "destination": "Cette clé correspond déjà à une autre demande.",
    "queued": "En attente d'un appareil.",
    "dispatched": "Envoyé à l'appareil.",
    "running": "Génération en cours.",
    "completed": "Terminé.",
    "cancelled": "Annulé avant l'envoi.",
    "cancel_deferred": "Déjà envoyée : l'appareil termine cette image. Forge n'est jamais interrompu.",
    "uncertain_lease": "L'appareil ne répond plus après l'envoi. Résultat incertain, l'image n'est pas relancée.",
    "uncertain_lost": "L'appareil a perdu cette tâche après l'envoi. Elle n'est pas relancée.",
    "hq_restart": "HQ a redémarré pendant cette tâche. Elle n'est pas relancée.",
    "worker_removed": "L'appareil a été retiré pendant cette tâche.",
    "no_worker": "Plus aucun appareil de ce lot n'est utilisable.",
    "bad_image": "L'appareil a renvoyé une image refusée (format, taille ou dimensions).",
    "quota": "Le quota de la galerie est atteint. Rien n'a été effacé.",
    "disk": "Espace disque insuffisant.",
    "model_missing": "Le modèle n'est plus présent sur l'appareil.",
    "forge_timeout": "Forge n'a pas répondu à temps sur l'appareil. Il n'a pas été interrompu.",
    "forge_error": "Forge a renvoyé une erreur sur l'appareil.",
    "forge_offline": "Forge s'est arrêté sur l'appareil.",
    "code_invalid": "Code d'appairage invalide ou expiré.",
    "rate": "Trop d'essais. Réessayez plus tard.",
    "full": "Nombre maximal d'appareils atteint.",
    "name": "Nom invalide.",
    "secret_protect": "Protection du secret impossible (DPAPI). Appairage refusé, rien n'a été enregistré.",
    "secret_unprotected": "Secret non protégé — réassocier l'appareil.",
}

_LOCK = threading.RLock()
_root: Path | None = None
_registry: dict = {"version": 1, "codes": [], "workers": []}
_batches: dict = {"batches": [], "idempotency": {}}
_live: dict[str, dict] = {}
_nonces: dict[str, dict[str, float]] = {}
_enroll_hits: dict[str, list[float]] = {}
_dummy = secrets.token_hex(32)
_clock = time.time
_acl = True
_wrap = True
# Test-only: unprotected secrets are allowed only when the test hook asked for it, this env var
# is set, AND the bound root lives under the system temp dir. Never an implicit fallback.
TEST_PLAIN_ENV = "HQ_FORGE_FLEET_TEST_PLAINTEXT"
TEST_PLAIN_KIND = "test-plain"
_local_hw: dict | None = None
_local_hw_started = False
_local_status: tuple[float, dict] | None = None
_local_task: dict | None = None
_local_thread: threading.Thread | None = None
_stop = threading.Event()
_generation = 0
_local_enabled = True
_lease_sec = LEASE_SEC
_tick = 1.0


def _now_iso(stamp: float | None = None) -> str:
    value = datetime.fromtimestamp(_clock() if stamp is None else stamp, timezone.utc)
    return value.replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------------ test hooks

def reset_for_tests(*, clock=None, acl: bool = False, wrap: bool = False, local_hardware: dict | None = None,
                    local_enabled: bool = True, lease_sec: float | None = None, tick: float = 0.05) -> None:
    global _root, _registry, _batches, _clock, _acl, _wrap, _local_hw, _local_hw_started, _local_status
    global _local_task, _generation, _local_enabled, _lease_sec, _tick, _local_thread
    _stop.set()
    thread = _local_thread
    if thread is not None and thread.is_alive():
        thread.join(timeout=5)
    with _LOCK:
        _generation += 1
        _root = None
        _registry = {"version": 1, "codes": [], "workers": []}
        _batches = {"batches": [], "idempotency": {}}
        _live.clear()
        _nonces.clear()
        _enroll_hits.clear()
        _clock = clock or time.time
        _acl = acl
        _wrap = wrap
        _local_hw = local_hardware if local_hardware is not None else {"gpus": [], "cpu": None, "ram_mb": None}
        _local_hw_started = True
        _local_status = None
        _local_task = None
        _local_enabled = local_enabled
        _lease_sec = LEASE_SEC if lease_sec is None else float(lease_sec)
        _tick = tick
        _local_thread = None
    jobs.set_external_busy(None)


def set_clock_for_tests(clock) -> None:
    global _clock
    _clock = clock or time.time


# ------------------------------------------------------------------ persistence

def _dir() -> Path:
    if _root is None:
        raise RuntimeError("fleet not bound")
    folder = _root / ".hq-forge"
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _write_atomic(path: Path, data: dict, *, protect: bool = False) -> None:
    temporary = path.with_name(path.name + ".partial")
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    fd = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    try:
        os.write(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    if protect and _acl:
        wire.protect_path(temporary)
    os.replace(temporary, path)


def _read(path: Path, default: dict) -> dict:
    if not path.is_file():
        return json.loads(json.dumps(default))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return json.loads(json.dumps(default))
    return data if isinstance(data, dict) else json.loads(json.dumps(default))


def _save_registry() -> None:
    _write_atomic(_dir() / "workers.json", _registry, protect=True)


def _save_batches() -> None:
    _write_atomic(_dir() / "batches.json", _batches)


def _start_local_hw() -> None:
    global _local_hw_started

    def detect() -> None:
        global _local_hw
        try:
            value = wire.detect_hardware()
        except Exception:
            value = {"gpus": [], "cpu": None, "ram_mb": None}
        with _LOCK:
            _local_hw = value

    if not _local_hw_started:
        _local_hw_started = True
        threading.Thread(target=detect, name="hq-forge-local-hw", daemon=True).start()


def bind(root: Path) -> None:
    """Load state once per process. Dispatched tasks from a previous run become uncertain."""
    global _root, _registry, _batches, _local_thread
    with _LOCK:
        if _root is not None and Path(root) == _root:
            return
        _root = Path(root)
        registry = _read(_dir() / "workers.json", {"version": 1, "codes": [], "workers": []})
        if not isinstance(registry.get("workers"), list) or not isinstance(registry.get("codes"), list):
            registry = {"version": 1, "codes": [], "workers": []}
        registry["workers"] = [row for row in registry["workers"] if isinstance(row, dict) and WORKER_RE.fullmatch(str(row.get("id") or ""))]
        registry["codes"] = [row for row in registry["codes"] if isinstance(row, dict)]
        _registry = registry
        batches = _read(_dir() / "batches.json", {"batches": [], "idempotency": {}})
        if not isinstance(batches.get("batches"), list) or not isinstance(batches.get("idempotency"), dict):
            batches = {"batches": [], "idempotency": {}}
        changed = False
        for batch in batches["batches"]:
            for task in batch.get("tasks") or []:
                if task.get("state") in ("dispatched", "running", "saving"):
                    _set_task(task, "uncertain", "hq_restart")
                    changed = True
        _batches = batches
        if changed:
            _save_batches()
        _stop.clear()
        jobs.set_external_busy(lambda: _local_task is not None)
        _start_local_hw()
        token = _generation
        _local_thread = threading.Thread(target=_local_loop, args=(token,), name="hq-forge-local-worker", daemon=True)
        _local_thread.start()


# ------------------------------------------------------------------ secrets

class _Blob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_ulong), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi(data: bytes, protect: bool) -> bytes | None:
    if os.name != "nt":
        return None
    try:
        crypt32 = ctypes.windll.crypt32
        kernel32 = ctypes.windll.kernel32
    except (AttributeError, OSError):
        return None
    buffer = ctypes.create_string_buffer(data, len(data))
    source = _Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    target = _Blob()
    entropy_raw = b"transfert-hq-forge-worker"
    entropy_buf = ctypes.create_string_buffer(entropy_raw, len(entropy_raw))
    entropy = _Blob(len(entropy_raw), ctypes.cast(entropy_buf, ctypes.POINTER(ctypes.c_char)))
    fn = crypt32.CryptProtectData if protect else crypt32.CryptUnprotectData
    ok = fn(ctypes.byref(source), None, ctypes.byref(entropy), None, None, 0x1, ctypes.byref(target))
    if not ok:
        return None
    try:
        return ctypes.string_at(target.pbData, target.cbData)
    finally:
        kernel32.LocalFree(target.pbData)


class SecretProtectionError(RuntimeError):
    """DPAPI is unavailable or failed. Callers must refuse; there is no plaintext fallback."""


def _test_plain_allowed() -> bool:
    if _wrap or os.environ.get(TEST_PLAIN_ENV) != "1" or _root is None:
        return False
    try:
        temp = Path(tempfile.gettempdir()).resolve()
        root = Path(_root).resolve()
    except OSError:
        return False
    return root != temp and temp in root.parents


def _wrap_secret(secret: str) -> dict:
    if _test_plain_allowed():
        return {"kind": TEST_PLAIN_KIND, "value": secret}
    sealed = _dpapi(secret.encode("ascii"), True) if os.name == "nt" else None
    if not sealed:
        raise SecretProtectionError("DPAPI unavailable")
    return {"kind": "dpapi", "value": base64.b64encode(sealed).decode("ascii")}


def _secret_usable(row: dict) -> bool:
    """Shape check only (no decryption). Legacy "plain" records are never usable."""
    stored = row.get("secret") if isinstance(row, dict) else None
    if not isinstance(stored, dict):
        return False
    if stored.get("kind") == "dpapi":
        return bool(stored.get("value"))
    return stored.get("kind") == TEST_PLAIN_KIND and _test_plain_allowed()


def _unwrap_secret(row: dict) -> str:
    stored = row.get("secret")
    if not isinstance(stored, dict):
        return ""
    if stored.get("kind") == TEST_PLAIN_KIND:
        return str(stored.get("value") or "") if _test_plain_allowed() else ""
    if stored.get("kind") == "dpapi":
        try:
            opened = _dpapi(base64.b64decode(str(stored.get("value") or "")), False)
        except (ValueError, TypeError):
            return ""
        return opened.decode("ascii", "replace") if opened else ""
    return ""


def _code_hash(code: str) -> str:
    normal = "".join(ch for ch in (code or "").upper() if ch.isalnum())
    return hashlib.sha256(("hq-forge-enroll|" + normal).encode("utf-8")).hexdigest()


def _same(left: str, right: str) -> bool:
    return hmac.compare_digest(hashlib.sha256((left or "").encode()).digest(), hashlib.sha256((right or "").encode()).digest())


# ------------------------------------------------------------------ registry

def _worker(worker_id: str) -> dict | None:
    for row in _registry["workers"]:
        if row.get("id") == worker_id:
            return row
    return None


def _clean_name(value) -> str | None:
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if not 1 <= len(text) <= 40 or any(ord(ch) < 32 or ch in "<>\"'`\\" for ch in text):
        return None
    return text


def create_code() -> dict:
    """One-time pairing code, shown once. Only its hash is stored."""
    now = _clock()
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(12))
    pretty = "-".join(code[i:i + 4] for i in range(0, 12, 4))
    with _LOCK:
        _registry["codes"] = [row for row in _registry["codes"] if float(row.get("expires") or 0) > now][-(MAX_CODES - 1):]
        _registry["codes"].append({"hash": _code_hash(code), "expires": now + CODE_TTL_SEC})
        _save_registry()
    return {"code": pretty, "expires_at": _now_iso(now + CODE_TTL_SEC), "ttl_sec": CODE_TTL_SEC}


def _rate_ok(ip: str) -> bool:
    now = _clock()
    hits = [stamp for stamp in _enroll_hits.get(ip, []) if now - stamp < ENROLL_WINDOW_SEC]
    total = sum(1 for bucket in _enroll_hits.values() for stamp in bucket if now - stamp < ENROLL_WINDOW_SEC)
    if len(hits) >= ENROLL_MAX_PER_IP or total >= ENROLL_MAX_GLOBAL:
        _enroll_hits[ip] = hits
        return False
    hits.append(now)
    _enroll_hits[ip] = hits
    return True


def _clean_hardware(raw) -> dict:
    out = {"gpus": [], "cpu": None, "ram_mb": None, "os": None}
    if not isinstance(raw, dict):
        return out
    for gpu in (raw.get("gpus") if isinstance(raw.get("gpus"), list) else [])[:4]:
        if not isinstance(gpu, dict):
            continue
        name = wire._clip(gpu.get("name"), 80)
        vram = gpu.get("vram_mb")
        if not name:
            continue
        vram = vram if isinstance(vram, int) and not isinstance(vram, bool) and 0 < vram < 1_048_576 else None
        source = gpu.get("source") if gpu.get("source") in ("nvidia-smi", "cim") else None
        out["gpus"].append({"name": name, "vram_mb": vram, "source": source})
    out["cpu"] = wire._clip(raw.get("cpu"), 120)
    ram = raw.get("ram_mb")
    out["ram_mb"] = ram if isinstance(ram, int) and not isinstance(ram, bool) and 0 < ram < 1 << 30 else None
    out["os"] = wire._clip(raw.get("os"), 60)
    return out


def enroll(body: dict, ip: str) -> tuple[int, dict]:
    with _LOCK:
        if not _rate_ok(ip or "?"):
            return 429, {"error": MESSAGES["rate"], "code": "rate"}
        now = _clock()
        digest = _code_hash(str(body.get("code") or ""))
        match = None
        for row in _registry["codes"]:
            if _same(str(row.get("hash") or ""), digest) and float(row.get("expires") or 0) > now:
                match = row
        if match is None:
            return 403, {"error": MESSAGES["code_invalid"], "code": "code_invalid"}
        name = _clean_name(body.get("name")) or "Appareil"
        if len(_registry["workers"]) >= MAX_WORKERS:
            return 409, {"error": MESSAGES["full"], "code": "full"}
        worker_id = "wk_" + secrets.token_hex(8)
        secret = secrets.token_hex(32)
        # Protect first: on failure nothing changes (no worker, code NOT consumed, nothing written).
        try:
            sealed = _wrap_secret(secret)
        except SecretProtectionError:
            return 503, {"error": MESSAGES["secret_protect"], "code": "secret_protect"}
        _registry["codes"] = [row for row in _registry["codes"] if row is not match and float(row.get("expires") or 0) > now]
        _registry["workers"].append({
            "id": worker_id,
            "name": name,
            "secret": sealed,
            "created": _now_iso(now),
            "disabled": False,
        })
        _live[worker_id] = {"hardware": _clean_hardware(body.get("hardware")), "last_seen": now}
        _save_registry()
    return 200, {"worker_id": worker_id, "secret": secret, "poll_sec": wire.POLL_SEC}


def rename(worker_id: str, name) -> tuple[int, dict]:
    clean = _clean_name(name)
    if clean is None:
        return 400, {"error": MESSAGES["name"], "code": "name"}
    with _LOCK:
        row = _worker(worker_id)
        if row is None:
            return 404, {"error": "Introuvable"}
        row["name"] = clean
        _save_registry()
    return 200, {"device": _device_public(worker_id)}


def set_disabled(worker_id: str, disabled: bool) -> tuple[int, dict]:
    with _LOCK:
        row = _worker(worker_id)
        if row is None:
            return 404, {"error": "Introuvable"}
        row["disabled"] = bool(disabled)
        _save_registry()
    return 200, {"device": _device_public(worker_id)}


def remove(worker_id: str) -> tuple[int, dict]:
    """Revoke and forget. Its secret is gone; a dispatched task becomes uncertain."""
    with _LOCK:
        row = _worker(worker_id)
        if row is None:
            return 404, {"error": "Introuvable"}
        _registry["workers"] = [item for item in _registry["workers"] if item is not row]
        _live.pop(worker_id, None)
        _nonces.pop(worker_id, None)
        _save_registry()
        changed = False
        for batch in _batches["batches"]:
            for task in batch["tasks"]:
                if task.get("worker_id") == worker_id and task["state"] in ("dispatched", "running"):
                    _set_task(task, "uncertain", "worker_removed")
                    changed = True
        if changed:
            _save_batches()
    return 200, {"removed": worker_id}


# ------------------------------------------------------------------ auth

def _remember_nonce(worker_id: str, nonce: str, now: float) -> bool:
    bucket = _nonces.setdefault(worker_id, {})
    for key in [key for key, seen in bucket.items() if now - seen > NONCE_TTL_SEC]:
        bucket.pop(key, None)
    if nonce in bucket:
        return False
    if len(bucket) > 512:
        for key, _seen in sorted(bucket.items(), key=lambda item: item[1])[:128]:
            bucket.pop(key, None)
    bucket[nonce] = now
    return True


def _header(headers, name: str) -> str:
    try:
        value = headers.get(name)
    except Exception:
        value = None
    return str(value or "").strip()[:200]


def authenticate(method: str, path: str, headers, body: bytes) -> dict | None:
    worker_id = _header(headers, wire.HEADER_WORKER)
    stamp_raw = _header(headers, wire.HEADER_TIME)
    nonce = _header(headers, wire.HEADER_NONCE)
    presented = _header(headers, wire.HEADER_SIGNATURE).lower()
    stamp = int(stamp_raw) if stamp_raw.isdigit() and len(stamp_raw) < 12 else None
    now = _clock()
    with _LOCK:
        row = _worker(worker_id) if WORKER_RE.fullmatch(worker_id) else None
        secret = _unwrap_secret(row) if row else ""
        expected = wire.sign(secret or _dummy, method, path, stamp or 0, nonce, body or b"")
        ok = _same(presented, expected) and len(presented) == 64
        if row and (not secret or not ok):
            _live.setdefault(worker_id, {})["auth_fail_at"] = now
        if not row or not secret or not ok or stamp is None:
            return None
        if abs(now - stamp) > SKEW_SEC:
            _live.setdefault(worker_id, {})["skew_at"] = now
            return None
        if not NONCE_RE.fullmatch(nonce):
            return None
        live = _live.setdefault(worker_id, {})
        live.pop("auth_fail_at", None)
        live.pop("skew_at", None)
        if not _remember_nonce(worker_id, nonce, now):
            return None
        return row


# ------------------------------------------------------------------ device views

def _names(values, limit: int = wire.MAX_LIST) -> list[str]:
    out = []
    for value in values if isinstance(values, list) else []:
        if isinstance(value, str) and 0 < len(value) <= 200 and value not in out and not any(ord(ch) < 32 for ch in value):
            out.append(value)
    return out[:limit]


def _clean_catalog(raw, vae=None) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {key: _names(raw.get(key)) for key in ("models", "samplers", "schedulers", "upscalers")}
    out["hashes"] = _clean_hashes(raw.get("hashes"))
    out["vae"] = None if vae is None else _names(vae, 16)
    out["loras"] = _clean_loras(raw.get("loras"))
    return out


def _clean_loras(raw) -> dict | None:
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        return None
    items = []
    for row in raw["items"][:wire.MAX_LORAS]:
        if not isinstance(row, dict):
            continue
        name, alias, sha = row.get("name"), row.get("alias"), row.get("hash")
        if not isinstance(name, str) or not 0 < len(name) <= 120 or any(ord(ch) < 32 for ch in name):
            continue
        alias = alias if isinstance(alias, str) and 0 < len(alias) <= 120 and not any(ord(ch) < 32 for ch in alias) else name
        items.append({"name": name, "alias": alias, "hash": sha if isinstance(sha, str) and _SHA_RE.fullmatch(sha) else None})
    return {"items": items, "truncated": raw.get("truncated") is True}


def _find_lora(loras: dict | None, wanted: str) -> dict | None:
    """The prompt's <lora:X> matches a LoRA by alias or by name, as Forge does."""
    for row in (loras or {}).get("items") or []:
        if row["alias"] == wanted:
            return row
    for row in (loras or {}).get("items") or []:
        if row["name"] == wanted:
            return row
    return None


def _lora_reason(ref_row: dict | None, loras: dict | None, wanted: str) -> str | None:
    if loras is None:
        return "liste des LoRA illisible"
    row = _find_lora(loras, wanted)
    if row is None:
        return ("liste des LoRA incompl\u00e8te (LoRA \u00ab " + wanted + " \u00bb introuvable)") if loras.get("truncated") \
            else ("n'a pas le LoRA \u00ab " + wanted + " \u00bb")
    if ref_row is None:
        return None  # the reference itself lacks it; Forge there decides, nothing to compare
    if ref_row["hash"] and row["hash"]:
        return None if ref_row["hash"] == row["hash"] else "autre version du LoRA \u00ab " + wanted + " \u00bb"
    # No content hash on one side: Forge exposes no file hash or size, so name + alias must match.
    if (row["name"], row["alias"]) != (ref_row["name"], ref_row["alias"]):
        return "LoRA \u00ab " + wanted + " \u00bb diff\u00e9rent"
    return None


_SHA_RE = re.compile(r"^[0-9a-f]{64}$")


def _clean_hashes(raw) -> dict:
    out = {}
    for title, sha in (raw.items() if isinstance(raw, dict) else ()):
        if isinstance(title, str) and 0 < len(title) <= 200 and not any(ord(ch) < 32 for ch in title):
            out[title] = sha if isinstance(sha, str) and _SHA_RE.fullmatch(sha) else None
        if len(out) >= wire.MAX_LIST:
            break
    return out


# ------------------------------------------------------------------ parity (A)
# A batch is split only across devices that render the same thing: same checkpoint
# file (sha256, not its name), same VAE / extra modules, and verifiable LoRAs.
_LORA_RE = re.compile(r"<lora:([^:<>]{1,120})(?::[^<>]*)?>", re.IGNORECASE)


def requested_loras(prompt) -> list[str]:
    out = []
    for name in _LORA_RE.findall(prompt if isinstance(prompt, str) else ""):
        name = name.strip()
        if name and name not in out:
            out.append(name)
    return out[:16]


SWEEP_MAX = 8
SWEEP_AXES = ("cfg_scale", "steps", "sampler_name", "lora_weight")


def set_lora_weight(prompt: str, lora: str, weight: float) -> str:
    """E: rewrite only the weight of <lora:NAME[:w]> for this one LoRA; everything else stays as typed."""
    text = f"{weight:g}"
    return _LORA_RE.sub(lambda m: f"<lora:{m.group(1)}:{text}>" if m.group(1) == lora else m.group(0), prompt)


def sweep_cells(sweep, settings: dict) -> list[dict] | None:
    """E: 'Balayage d'un param\u00e8tre'. One axis, 2 to SWEEP_MAX distinct values, every other setting and
    the seed shared. Returns [{"cell": {...}, "override": {...}}] or None when invalid."""
    if not isinstance(sweep, dict) or set(sweep) - {"axis", "values", "lora"}:
        return None
    axis, values = sweep.get("axis"), sweep.get("values")
    if axis not in SWEEP_AXES or not isinstance(values, list) or not 2 <= len(values) <= SWEEP_MAX:
        return None
    cells = []
    for value in values:
        if axis == "sampler_name":
            if not isinstance(value, str) or not 0 < len(value) <= 80:
                return None
            override = {"sampler_name": value}
        elif axis == "steps":
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 40:
                return None
            override = {"steps": value}
        else:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
                return None
            value = round(float(value), 2)
            if axis == "cfg_scale":
                if not 1 <= value <= 15:
                    return None
                override = {"cfg_scale": value}
            else:
                lora = sweep.get("lora")
                prompt = settings.get("prompt")
                if not -2 <= value <= 2 or not isinstance(lora, str) or not isinstance(prompt, str) or lora not in requested_loras(prompt):
                    return None
                override = {"prompt": set_lora_weight(prompt, lora, value)}
        cells.append({"cell": {"axis": axis, "value": value}, "override": override})
    if len({repr(c["cell"]["value"]) for c in cells}) != len(cells):
        return None
    return cells


def parity_split(settings: dict, fit: list, catalogs: dict, names: dict) -> tuple[list, list, dict]:
    """Keep the reference device (this HQ when chosen, else the first one) and every device
    that matches it; each excluded device gets a plain reason. Never switches a model."""
    excluded = []
    if settings.get("subseed_strength"):
        # C: variations need protocol v2 workers (they report VAE); older ones are left out.
        old = [w for w in fit if w != LOCAL_ID and (catalogs.get(w) or {}).get("vae") is None]
        for worker_id in old:
            name = names.get(worker_id) or worker_id
            reason = "pas encore \u00e0 jour pour les variations"
            excluded.append({"worker_id": worker_id, "name": name, "kind": "parity", "reasons": [reason],
                             "message": f"{name} : {reason}, exclu."})
        fit = [w for w in fit if w not in old]
    if not fit:
        return [], excluded, {"reference": None, "checkpoint_sha256": None, "vae": None}
    reference = LOCAL_ID if LOCAL_ID in fit else fit[0]
    checkpoint = settings.get("checkpoint")
    ref = catalogs.get(reference) or {}
    ref_sha = (ref.get("hashes") or {}).get(checkpoint)
    ref_vae = ref.get("vae")
    ref_loras = ref.get("loras")
    loras = requested_loras(settings.get("prompt"))
    kept = []
    for worker_id in fit:
        if worker_id == reference:
            kept.append(worker_id)
            continue
        cat = catalogs.get(worker_id) or {}
        sha = (cat.get("hashes") or {}).get(checkpoint)
        vae = cat.get("vae")
        reasons = []
        if not ref_sha or not sha:
            reasons.append(f"empreinte du mod\u00e8le \u00ab {checkpoint} \u00bb inconnue")
        elif sha != ref_sha:
            reasons.append(f"autre version du mod\u00e8le \u00ab {checkpoint} \u00bb")
        if vae is None or ref_vae is None:
            reasons.append("VAE inconnu")
        elif vae != ref_vae:
            reasons.append("VAE diff\u00e9rent (" + (", ".join(vae) or "aucun") + " au lieu de " + (", ".join(ref_vae) or "aucun") + ")")
        if loras and ref_loras is None:
            reasons.append("LoRA non comparables : la liste de l'appareil de r\u00e9f\u00e9rence est illisible")
        for lora in (loras if ref_loras is not None else []):
            reason = _lora_reason(_find_lora(ref_loras, lora), cat.get("loras"), lora)
            if reason:
                reasons.append(reason)
        if reasons:
            name = names.get(worker_id) or worker_id
            first = reasons[0]
            message = f"{name} {first}, exclu." if first.startswith("n'a pas") else f"{name} : {first}, exclu."
            excluded.append({"worker_id": worker_id, "name": name, "kind": "parity", "reasons": reasons,
                             "message": message})
        else:
            kept.append(worker_id)
    ref_rows = {lora: _find_lora(ref_loras, lora) for lora in loras}
    return kept, excluded, {"reference": reference, "checkpoint_sha256": ref_sha, "vae": ref_vae, "loras": ref_rows}


def _parity_for(selection_fit: list, settings: dict, hq_job) -> tuple[list, list, dict]:
    catalogs, names = {}, {}
    for worker_id in selection_fit:
        device = _device_public(worker_id, hq_job)
        catalogs[worker_id] = device.get("catalog") or {}
        names[worker_id] = device.get("name") or worker_id
    return parity_split(settings, selection_fit, catalogs, names)


def _parity_ok(batch: dict, worker_id: str, catalog: dict | None) -> bool:
    parity = batch.get("parity")
    if not isinstance(parity, dict) or worker_id == parity.get("reference"):
        return True
    cat = catalog or {}
    sha = (cat.get("hashes") or {}).get(batch["settings"].get("checkpoint"))
    if not (bool(sha) and sha == parity.get("checkpoint_sha256") and cat.get("vae") == parity.get("vae")):
        return False
    refs = parity.get("loras") if isinstance(parity.get("loras"), dict) else {}
    return all(_lora_reason(ref_row, cat.get("loras"), lora) is None for lora, ref_row in refs.items())


def _local_view() -> dict:
    global _local_status
    now = time.monotonic()
    cached = _local_status
    if cached is None or now - cached[0] > 3.0:
        try:
            status = forge.status()
        except Exception:
            status = {"forge": "error"}
        catalog = None
        if status.get("forge") in ("ready", "busy"):
            try:
                raw = forge.catalog()
            except Exception:
                raw = {}
            if raw.get("forge") == "ready":
                catalog = {
                    "models": [row.get("title") for row in raw.get("models") or [] if isinstance(row, dict) and row.get("title")],
                    "samplers": [row.get("name") for row in raw.get("samplers") or [] if isinstance(row, dict) and row.get("name")],
                    "schedulers": [row.get("name") for row in raw.get("schedulers") or [] if isinstance(row, dict) and row.get("name")],
                    "upscalers": [row.get("name") for row in raw.get("upscalers") or [] if isinstance(row, dict) and row.get("name")],
                }
        if catalog is not None:
            catalog["hashes"] = _clean_hashes({row.get("title"): row.get("sha256") for row in raw.get("models") or []
                                               if isinstance(row, dict) and isinstance(row.get("title"), str)})
            try:
                catalog["vae"] = wire.vae_names(forge.read_options())
            except Exception:
                catalog["vae"] = None
            try:
                catalog["loras"] = _clean_loras(wire.lora_list(forge.read_loras()))
            except Exception:
                catalog["loras"] = None
        cached = (now, {"state": status.get("forge"), "model": status.get("model"), "catalog": catalog})
        _local_status = cached
    return cached[1]


def _active_task_for(worker_id: str) -> tuple[dict, dict] | None:
    for batch in _batches["batches"]:
        for task in batch["tasks"]:
            if task.get("worker_id") == worker_id and task["state"] in ("dispatched", "running", "saving"):
                return batch, task
    return None


def _hq_job_active() -> bool:
    """Call without _LOCK held (lock order: jobs._LOCK before _LOCK)."""
    if _root is None:
        return False
    try:
        return jobs.local_active(_root)
    except Exception:
        return False


AUTH_RECENT_SEC = 180
NET_RECENT_SEC = 3600
TASK_ERROR_ACTION = "Regardez la console Forge sur ce PC, puis relancez le lot."
DIAG = {
    "secret_unprotected": ("error", "Secret non prot\u00e9g\u00e9 \u2014 r\u00e9associer l'appareil.",
                           "Retirez l'appareil, puis ajoutez-le avec un nouveau code."),
    "auth_refused": ("error", "HQ refuse les identifiants de ce PC (r\u00e9voqu\u00e9s ou alt\u00e9r\u00e9s).",
                     "Sur ce PC, relancez \u00ab pair \u00bb avec un nouveau code, puis \u00ab run \u00bb."),
    "clock_skew": ("error", "Horloge de ce PC d\u00e9cal\u00e9e : HQ refuse ses signatures.",
                   "Synchronisez l'heure de Windows (Param\u00e8tres > Heure et langue > Synchroniser)."),
    "disabled": ("warn", "D\u00e9sactiv\u00e9 par l'admin.", "R\u00e9activez-le dans \u00ab Caract\u00e9ristiques \u00bb pour le r\u00e9utiliser."),
    "never_seen": ("warn", "Associ\u00e9, mais le service worker n'a encore jamais contact\u00e9 HQ.",
                   "Sur ce PC, lancez \u00ab py -3 .\\hq_forge_worker.py run \u00bb."),
    "worker_stale": ("error", "Le service worker ne r\u00e9pond plus depuis {ago}.",
                     "Sur ce PC, v\u00e9rifiez que le worker tourne (fen\u00eatre ou t\u00e2che planifi\u00e9e) et que le PC n'est pas en veille. "
                     "HQ ne voit que l'absence de signal : ce n'est pas forc\u00e9ment une panne Tailscale."),
    "network": ("warn", "Ce PC a signal\u00e9 ne pas pouvoir joindre HQ pendant {span} (r\u00e9seau ou Tailscale).",
                "Si cela se r\u00e9p\u00e8te, v\u00e9rifiez que Tailscale est connect\u00e9 au m\u00eame tailnet sur ce PC."),
    "forge_down": ("error", "API Forge indisponible sur ce PC.", "D\u00e9marrez Forge avec --api (sans --listen) sur ce PC."),
    "forge_busy": ("info", "Forge est occup\u00e9 par un autre travail sur ce PC.", "Attendez la fin : HQ lui enverra la suite ensuite."),
    "catalog_unknown": ("warn", "Catalogue Forge illisible sur ce PC.", "Red\u00e9marrez Forge sur ce PC, puis attendez quelques secondes."),
    "model_missing": ("warn", "Le mod\u00e8le manquait sur ce PC lors de la derni\u00e8re t\u00e2che.",
                      "Copiez-le dans models\\Stable-diffusion de Forge sur ce PC, ou choisissez un mod\u00e8le pr\u00e9sent."),
    "hardware_unknown": ("info", "Mat\u00e9riel incomplet : {fields}.",
                         "Installez le pilote NVIDIA (nvidia-smi) sur ce PC pour la VRAM. La g\u00e9n\u00e9ration reste possible."),
}
TASK_ERRORS = ("forge_timeout", "forge_error", "forge_offline", "bad_image", "quota", "disk", "upload")


def _span(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 90:
        return f"{seconds} s"
    if seconds < 5400:
        return f"{round(seconds / 60)} min"
    if seconds < 172800:
        return f"{round(seconds / 3600)} h"
    return f"{round(seconds / 86400)} j"


def _diag(code: str, **fmt) -> dict:
    if code in DIAG:
        level, title, action = DIAG[code]
    else:
        level, title, action = "warn", MESSAGES.get(code, code), TASK_ERROR_ACTION
    return {"code": code, "level": level, "title": title.format(**fmt) if fmt else title, "action": action}


def diagnose(t: dict, now: float) -> list[dict]:
    """Map real telemetry to actionable French diagnostics, most important first.

    ``t`` keys: kind, secret_ok, disabled, seen, online, forge, catalog_known, last_error,
    auth_fail_at, skew_at, net (dict since/until), hardware. Nothing is guessed: a stale
    heartbeat is reported as a silent worker, never as a Tailscale outage; a network
    problem is shown only when the worker itself reported it.
    """
    out = []
    remote = t.get("kind") == "remote"
    if remote and not t.get("secret_ok", True):
        out.append(_diag("secret_unprotected"))
    if remote and t.get("auth_fail_at") and now - t["auth_fail_at"] <= AUTH_RECENT_SEC and not t.get("online"):
        out.append(_diag("auth_refused"))
    if remote and t.get("skew_at") and now - t["skew_at"] <= AUTH_RECENT_SEC and not t.get("online"):
        out.append(_diag("clock_skew"))
    if t.get("disabled"):
        out.append(_diag("disabled"))
    if remote and not t.get("seen"):
        out.append(_diag("never_seen"))
    elif remote and not t.get("online"):
        out.append(_diag("worker_stale", ago=_span(now - t["seen"])))
    net = t.get("net")
    if remote and isinstance(net, dict) and now - net.get("until", 0) <= NET_RECENT_SEC:
        out.append(_diag("network", span=_span(net["until"] - net["since"])))
    if t.get("online"):
        forge = t.get("forge")
        if forge in ("offline", "api_disabled", "error", "unknown", None):
            out.append(_diag("forge_down"))
        else:
            if forge == "busy" and not t.get("own_task"):
                out.append(_diag("forge_busy"))
            if not t.get("catalog_known"):
                out.append(_diag("catalog_unknown"))
    error = t.get("last_error") or ""
    if error == "model_missing" or error in TASK_ERRORS:
        out.append(_diag(error))
    hw = t.get("hardware") or {}
    gpus = hw.get("gpus") or []
    missing = []
    if not gpus:
        missing.append("GPU inconnu")
    elif any(g.get("vram_mb") is None for g in gpus):
        missing.append("VRAM inconnue")
    if not hw.get("cpu"):
        missing.append("CPU inconnu")
    if not hw.get("ram_mb"):
        missing.append("RAM inconnue")
    if missing and (t.get("seen") or not remote):
        out.append(_diag("hardware_unknown", fields=", ".join(missing)))
    return out


def _device_public(worker_id: str, hq_job: bool = False) -> dict:
    now = _clock()
    if worker_id == LOCAL_ID:
        view = _local_view()
        hardware = _clean_hardware(_local_hw)
        online = True
        forge_state = view.get("state") or "error"
        catalog = view.get("catalog")
        model = view.get("model")
        name = "Cet HQ"
        disabled = not _local_enabled
        last_seen = _now_iso(now)
        last_error = ""
        if hq_job:
            forge_state = "busy"
    else:
        row = _worker(worker_id) or {}
        live = _live.get(worker_id) or {}
        hardware = live.get("hardware") or _clean_hardware(None)
        seen = float(live.get("last_seen") or 0)
        online = bool(seen) and now - seen <= ONLINE_SEC
        forge_info = live.get("forge") or {}
        forge_state = forge_info.get("state") if online else "unknown"
        catalog = forge_info.get("catalog") if online else None
        model = forge_info.get("model") if online else None
        name = row.get("name") or worker_id
        disabled = bool(row.get("disabled"))
        last_seen = _now_iso(seen) if seen else None
        last_error = live.get("last_error") or row.get("last_error") or ""
        if not _secret_usable(row):
            last_error = "secret_unprotected"
    active = _active_task_for(worker_id)
    if worker_id == LOCAL_ID:
        telemetry = {"kind": "local", "online": True, "seen": now, "forge": forge_state, "catalog_known": catalog is not None,
                     "own_task": bool(active), "hardware": hardware, "disabled": disabled}
    else:
        telemetry = {"kind": "remote", "secret_ok": _secret_usable(row), "disabled": disabled, "seen": seen, "online": online,
                     "forge": forge_state, "catalog_known": catalog is not None, "own_task": bool(active),
                     "last_error": last_error, "auth_fail_at": live.get("auth_fail_at"), "skew_at": live.get("skew_at"),
                     "net": live.get("net"), "hardware": hardware}
    diagnostics = diagnose(telemetry, now)
    if disabled:
        state = "disabled"
    elif last_error == "secret_unprotected":
        state = "error"
    elif not online:
        state = "offline"
    elif forge_state in ("offline", "api_disabled", "error", "unknown", None):
        state = "forge_down"
    elif active or forge_state == "busy":
        state = "busy"
    elif last_error and worker_id != LOCAL_ID:
        state = "error"
    else:
        state = "available"
    current = None
    if active:
        batch, task = active
        current = {"batch_id": batch["id"], "task_id": task["id"], "progress": task.get("progress") or 0,
                   "step": task.get("step") or 0, "steps": task.get("steps") or 0}
    return {
        "id": worker_id,
        "name": name,
        "kind": "local" if worker_id == LOCAL_ID else "remote",
        "state": state,
        "state_label": STATE_LABELS[state],
        "online": online,
        "forge": forge_state or "unknown",
        "disabled": disabled,
        "hardware": hardware,
        "model": model,
        "catalog": catalog,
        "current": current,
        "last_seen": last_seen,
        "last_error": last_error,
        "last_error_label": MESSAGES.get(last_error, last_error) if last_error else "",
        "diagnostics": diagnostics,
    }


def devices() -> dict:
    hq_job = _hq_job_active()
    _local_view()
    with _LOCK:
        _sweep()
        ids = [LOCAL_ID] + [row["id"] for row in _registry["workers"]]
        rows = [_device_public(worker_id, hq_job) for worker_id in ids]
        pending = sum(1 for row in _registry["codes"] if float(row.get("expires") or 0) > _clock())
    return {"devices": rows, "pending_codes": pending}


def _usable(device: dict) -> bool:
    return device["state"] in ("available", "busy", "error") and device.get("last_error") != "secret_unprotected"


# ------------------------------------------------------------------ compatibility

def compat_reasons(settings: dict, catalog: dict | None) -> list[str]:
    if not catalog:
        return ["Catalogue Forge inconnu sur cet appareil."]
    reasons = []
    if settings.get("checkpoint") not in (catalog.get("models") or []):
        reasons.append(f"Modèle « {settings.get('checkpoint')} » absent.")
    if settings.get("sampler_name") not in (catalog.get("samplers") or []):
        reasons.append(f"Échantillonneur « {settings.get('sampler_name')} » absent.")
    if (settings.get("scheduler") or "automatic") not in (catalog.get("schedulers") or []):
        reasons.append(f"Planificateur « {settings.get('scheduler')} » absent.")
    if settings.get("enable_hr") and settings.get("hr_upscaler") not in (catalog.get("upscalers") or []):
        reasons.append(f"Agrandisseur « {settings.get('hr_upscaler')} » absent (Hires. fix).")
    return reasons


def _as_jobs_catalog(catalog: dict) -> dict:
    return {
        "models": [{"title": name} for name in catalog.get("models") or []],
        "samplers": [{"name": name} for name in catalog.get("samplers") or []],
        "schedulers": [{"name": name} for name in catalog.get("schedulers") or []],
        "upscalers": [{"name": name} for name in catalog.get("upscalers") or []],
    }


# ------------------------------------------------------------------ batches

def _set_task(task: dict, state: str, code: str = "", **fields) -> None:
    task["state"] = state
    task["error"] = code if state in ("failed", "uncertain", "cancelled") else task.get("error", "")
    key = code or state
    task["message"] = MESSAGES.get(key, MESSAGES.get(state, ""))
    task["updated"] = _now_iso()
    task.update(fields)
    if "finished_at" in fields and state in ("completed", "failed", "uncertain", "cancelled", "lost"):
        _stat_task(task)


def _stat_task(task: dict) -> None:
    """Phase A: one statistics record per finished task (settings, device, duration, outcome; no prompt).
    Batches are normal-mode only, so nothing from the vault can reach this."""
    found = _find_task(task.get("id"))
    if found is None or _root is None:
        return
    batch = found[0]
    duration = None
    if task.get("state") == "completed" and isinstance(task.get("dispatched_ts"), (int, float)):
        duration = max(0.0, _clock() - task["dispatched_ts"])
    worker_id = task.get("worker_id")
    try:
        stats.record(_root, {
            **stats.from_settings(dict(_task_settings(batch, task), n_iter=1)),  # E: a sweep cell records its own setting
            "kind": "batch", "batch_id": batch.get("id"), "task_id": task.get("id"), "image_id": task.get("image_id"),
            "device_id": worker_id, "device_name": _worker_name(worker_id) if worker_id else None,
            "checkpoint_sha256": (batch.get("parity") or {}).get("checkpoint_sha256"),
            "outcome": task.get("state"), "error": task.get("error") or None, "duration_s": duration,
            "attempt": task.get("attempt", 1), "uncertain": task.get("state") == "uncertain", "count": 1,
        })
    except OSError:
        pass


def _find_batch(batch_id: str) -> dict | None:
    for batch in _batches["batches"]:
        if batch.get("id") == batch_id:
            return batch
    return None


def _find_task(task_id: str) -> tuple[dict, dict] | None:
    for batch in _batches["batches"]:
        for task in batch["tasks"]:
            if task.get("id") == task_id:
                return batch, task
    return None


def _batch_state(batch: dict) -> str:
    states = [task["state"] for task in batch["tasks"]]
    if any(state in ("queued", "dispatched", "running", "saving") for state in states):
        return "cancelling" if batch.get("cancelled") else "running"
    done = states.count("completed")
    if done == len(states):
        return "completed"
    if batch.get("cancelled") and done == 0:
        return "cancelled"
    if done:
        return "partial"
    return "failed"


def _worker_name(worker_id: str | None) -> str:
    if worker_id == LOCAL_ID:
        return "Cet HQ"
    row = _worker(worker_id or "")
    return (row or {}).get("name") or (worker_id or "")


def _batch_public(batch: dict) -> dict:
    counts = {"total": len(batch["tasks"]), "done": 0, "failed": 0, "pending": 0, "running": 0, "uncertain": 0, "cancelled": 0}
    per = {worker_id: {"worker_id": worker_id, "name": _worker_name(worker_id), "done": 0, "failed": 0, "uncertain": 0,
                       "running": 0, "progress": 0, "step": 0, "steps": 0}
           for worker_id in batch["workers"]}
    tasks = []
    retryable = retry_uncertain = 0
    for task in batch["tasks"]:
        state = task["state"]
        bucket = {"completed": "done", "failed": "failed", "queued": "pending", "dispatched": "running", "running": "running",
                  "saving": "running", "uncertain": "uncertain", "cancelled": "cancelled"}.get(state, "failed")
        counts[bucket] += 1
        worker_id = task.get("worker_id")
        if worker_id in per:
            row = per[worker_id]
            if state == "completed":
                row["done"] += 1
            elif state in ("failed", "uncertain"):
                row["failed"] += 1  # failed includes uncertain (kept for older clients)
                if state == "uncertain":
                    row["uncertain"] += 1
            elif state in ("dispatched", "running", "saving"):
                row["running"] += 1
                row["progress"] = task.get("progress") or 0
                row["step"] = task.get("step") or 0
                row["steps"] = task.get("steps") or 0
        tasks.append({
            "id": task["id"], "index": task["index"], "seed": task["seed"], "subseed": task.get("subseed"), "state": state,
            "worker_id": worker_id, "worker_name": _worker_name(worker_id) if worker_id else "",
            "progress": task.get("progress") or 0, "step": task.get("step") or 0, "steps": task.get("steps") or 0,
            "image_id": task.get("image_id"), "error": task.get("error") or "", "message": task.get("message") or "",
            "cancel_deferred": bool(task.get("cancel_deferred")),
            "dispatched_at": task.get("dispatched_at"), "finished_at": task.get("finished_at"),
            "retried": bool(task.get("retried_in")),
            "attempt": int(task.get("attempt", 1)), "retry_of_task": task.get("retry_of_task"),
            "resolution": task.get("resolution") if state == "uncertain" else None,
            "cell": task.get("cell"),
        })
        # One retry per image: a task that is itself a retry is never offered again; a resolved one neither.
        if state in ("failed", "uncertain") and not task.get("retried_in") and not task.get("retry_of_task") and not task.get("resolution"):
            retryable += 1
            if state == "uncertain":
                retry_uncertain += 1
    return {
        "batch_id": batch["id"], "state": _batch_state(batch), "created": batch["created"], "updated": batch.get("updated"),
        "count": len(batch["tasks"]), "seed_mode": batch["seed_mode"], "cancelled": bool(batch.get("cancelled")),
        "workers": list(per.values()), "counts": counts, "tasks": tasks, "settings": batch["settings"],
        "retryable": retryable, "retry_uncertain": retry_uncertain, "retry_of": batch.get("retry_of"),
        "sweep": batch.get("sweep"),
        "excluded": [{"worker_id": row.get("worker_id"), "name": row.get("name"), "message": row.get("message"),
                      "reasons": list(row.get("reasons") or [])} for row in batch.get("excluded") or [] if isinstance(row, dict)],
    }


def create_batch(data: dict, key: str) -> tuple[int, dict]:
    if not KEY_RE.fullmatch(key or "") or not isinstance(data, dict):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    destination = data.get("destination", "normal")
    selection = data.get("workers")
    if not isinstance(selection, list) or not selection or len(selection) > MAX_WORKERS + 1 or not all(isinstance(item, str) for item in selection):
        return 400, {"error": MESSAGES["no_workers"], "code": "no_workers"}
    selection = list(dict.fromkeys(selection))
    if destination == "private":
        if any(item != LOCAL_ID for item in selection):
            return 403, {"error": MESSAGES["private_remote"], "code": "private_remote"}
        return 400, {"error": MESSAGES["private_batch"], "code": "private_batch"}
    if destination != "normal":
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    count = data.get("count")
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_IMAGES:
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    settings_in = data.get("settings")
    if not isinstance(settings_in, dict) or "destination" in settings_in:
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    settings_in = {k: v for k, v in settings_in.items() if k != "n_iter"}
    cells = None
    if "sweep" in data:
        # E: a sweep keeps one seed for every cell (a random one is drawn once) and no variation.
        cells = sweep_cells(data.get("sweep"), settings_in)
        if cells is None or count != len(cells) or settings_in.get("subseed_strength"):
            return 400, {"error": MESSAGES["validation"], "code": "validation"}
        seed_in = settings_in.get("seed", -1)
        if isinstance(seed_in, int) and not isinstance(seed_in, bool) and seed_in < 0:
            settings_in["seed"] = secrets.randbelow(2**32)
    hq_job = _hq_job_active()
    if LOCAL_ID in selection:
        _local_view()
    with _LOCK:
        _sweep()
        found = _batches["idempotency"].get(key)
        existing = _find_batch(found) if isinstance(found, str) else None
        if existing is not None:
            return 200, {"batch": _batch_public(existing)}
        unknown, problems, validated, _fit = _check_workers(selection, settings_in, hq_job)
        for cell in cells or []:
            # Every device must accept every cell (an absent sampler is named, never substituted).
            more_unknown, more, _v, cell_fit = _check_workers(selection, dict(settings_in, **cell["override"]), hq_job)
            unknown = unknown or more_unknown
            seen = {(p["worker_id"], tuple(p["reasons"])) for p in problems}
            problems += [p for p in more if (p["worker_id"], tuple(p["reasons"])) not in seen]
            _fit = [w for w in _fit if w in cell_fit]
        if unknown:
            return 409, {"error": MESSAGES["unknown_worker"], "code": "unknown_worker"}
        if problems:
            code = "incompatible" if any(item["kind"] == "incompatible" for item in problems) else "unavailable"
            return 409, {"error": MESSAGES[code], "code": code, "problems": problems}
        assert validated is not None
        kept, excluded, parity = _parity_for(_fit, validated, hq_job)
        if not kept:
            return 409, {"error": MESSAGES["incompatible"], "code": "incompatible", "problems": excluded}
        selection = kept
        seed = validated["seed"]
        if cells:
            seeds = [seed] * count
            mode = "sweep"
        elif validated.get("subseed_strength"):
            # C: same seed and settings; each image moves its variation seed by one.
            seeds = [seed] * count
            mode = "variation"
        elif seed < 0:
            seeds = [secrets.randbelow(2**32) for _ in range(count)]
            mode = "random"
        else:
            seeds = [(seed + index) % (2**32) for index in range(count)]
            mode = "fixed"
        settings = {k: v for k, v in validated.items() if k not in ("n_iter", "batch_size")}
        now = _now_iso()
        batch = {
            "id": "bt-" + secrets.token_hex(12),
            "key": key,
            "created": now,
            "updated": now,
            "settings": settings,
            "workers": selection,
            "seed_mode": mode,
            "cancelled": False,
            "parity": parity,
            "excluded": excluded,
            "tasks": [{
                "id": "tk-" + secrets.token_hex(12), "index": index, "seed": seeds[index], "state": "queued",
                "worker_id": None, "progress": 0, "step": 0, "image_id": None,
                "steps": cells[index]["override"].get("steps", settings["steps"]) if cells else settings["steps"],
                "error": "", "message": MESSAGES["queued"], "updated": now,
                **({"subseed": (validated["subseed"] + index) % (2**32)} if validated.get("subseed_strength") else {}),
                **({"cell": cells[index]["cell"], "override": cells[index]["override"]} if cells else {}),
            } for index in range(count)],
        }
        if cells:
            sweep = data["sweep"]
            batch["sweep"] = {"axis": sweep["axis"], "values": [c["cell"]["value"] for c in cells],
                              **({"lora": sweep["lora"]} if sweep["axis"] == "lora_weight" else {})}
        _batches["batches"].append(batch)
        _trim()
        _batches["idempotency"][key] = batch["id"]
        _save_batches()
        snapshot = _batch_public(batch)
    return 202, {"batch": snapshot}


def _check_workers(selection: list, settings_in: dict, hq_job) -> tuple[bool, list, dict | None, list]:
    """Availability and compatibility per device, shared by create and retry.
    Returns (unknown_worker, problems, last validated settings, fitting ids). Caller holds _LOCK."""
    problems = []
    validated = None
    fit = []
    for worker_id in selection:
        if worker_id != LOCAL_ID and (not WORKER_RE.fullmatch(worker_id) or _worker(worker_id) is None):
            return True, [], None, []
        device = _device_public(worker_id, hq_job)
        if not _usable(device):
            problems.append({"worker_id": worker_id, "name": device["name"], "kind": "unavailable", "reasons": [device["state_label"] + "."]})
            continue
        checked = jobs._validate(settings_in, _as_jobs_catalog(device["catalog"] or {}))
        if isinstance(checked, tuple):
            reasons = compat_reasons(settings_in, device["catalog"]) or [MESSAGES["validation"]]
            problems.append({"worker_id": worker_id, "name": device["name"], "kind": "incompatible", "reasons": reasons})
            continue
        validated = checked
        fit.append(worker_id)
    return False, problems, validated, fit


def resolve_task(batch_id: str, task_id: str, action) -> tuple[int, dict]:
    """Owner's explicit choice for one uncertain image: 'lost' or 'keep' (as is). No relaunch;
    a late upload from the first device is still accepted on the task."""
    if not BATCH_RE.fullmatch(batch_id or "") or not isinstance(task_id, str) or not task_id.startswith("tk-") or len(task_id) > 40:
        return 404, {"error": "Introuvable"}
    if action not in ("lost", "keep"):
        return 400, {"error": MESSAGES["validation"], "code": "bad_action"}
    with _LOCK:
        batch = _find_batch(batch_id)
        task = next((t for t in (batch or {}).get("tasks", []) if t.get("id") == task_id), None)
        if task is None:
            return 404, {"error": "Introuvable"}
        if task.get("state") != "uncertain" or task.get("retried_in"):
            return 409, {"error": "Cette image n'attend pas de choix.", "code": "not_uncertain"}
        task["resolution"] = "lost" if action == "lost" else "kept"
        task["updated"] = _now_iso()
        batch["updated"] = task["updated"]
        _save_batches()
        snapshot = _batch_public(batch)
    return 200, {"batch": snapshot}


def retry_batch(batch_id: str, key: str, only=None) -> tuple[int, dict]:
    """A new batch for the failed and uncertain images of a finished batch, with
    their seeds and settings. Uncertain images may still arrive late from their
    first device; such an upload is accepted on the original task (an extra image,
    its origin carries that task_id). Nothing is ever re-queued automatically."""
    if not KEY_RE.fullmatch(key or ""):
        return 400, {"error": MESSAGES["validation"], "code": "validation"}
    if not BATCH_RE.fullmatch(batch_id or ""):
        return 404, {"error": "Introuvable"}
    hq_job = _hq_job_active()
    with _LOCK:
        source = _find_batch(batch_id)
        needs_local = source is not None and LOCAL_ID in source["workers"]
    if needs_local:
        _local_view()
    with _LOCK:
        _sweep()
        found = _batches["idempotency"].get(key)
        existing = _find_batch(found) if isinstance(found, str) else None
        if existing is not None:
            if existing.get("retry_of") != batch_id:
                return 409, {"error": MESSAGES["validation"], "code": "validation"}
            return 200, {"batch": _batch_public(existing), "retry_of": batch_id}
        source = _find_batch(batch_id)
        if source is None:
            return 404, {"error": "Introuvable"}
        if _batch_state(source) in ("running", "cancelling"):
            return 409, {"error": MESSAGES["retry_running"], "code": "retry_running"}
        missing = [task for task in source["tasks"] if task["state"] in ("failed", "uncertain")
                   and not task.get("retried_in") and not task.get("retry_of_task") and not task.get("resolution")]
        if isinstance(only, list) and only:
            missing = [task for task in missing if task["id"] in only]
        if not missing:
            return 409, {"error": MESSAGES["retry_nothing"], "code": "retry_nothing"}
        settings_in = dict(source["settings"])
        unknown, problems, validated, fit = _check_workers(
            [w for w in source["workers"] if w == LOCAL_ID or _worker(w) is not None], settings_in, hq_job)
        if unknown or not fit or validated is None:
            return 409, {"error": MESSAGES["retry_none"], "code": "retry_none", "problems": problems}
        settings = {k: v for k, v in validated.items() if k not in ("n_iter", "batch_size")}
        fit, excluded, parity = _parity_for(fit, validated, hq_job)
        now = _now_iso()
        batch = {
            "id": "bt-" + secrets.token_hex(12),
            "key": key,
            "created": now,
            "updated": now,
            "settings": settings,
            "parity": parity,
            "excluded": excluded,
            "workers": fit,
            "seed_mode": source["seed_mode"],
            **({"sweep": source["sweep"]} if "sweep" in source else {}),
            "cancelled": False,
            "retry_of": source["id"],
            "tasks": [{
                "id": "tk-" + secrets.token_hex(12), "index": task["index"], "seed": task["seed"], "state": "queued",
                "worker_id": None, "progress": 0, "step": 0, "steps": settings["steps"], "image_id": None,
                "error": "", "message": MESSAGES["queued"], "updated": now, "retry_of_task": task["id"],
                "attempt": int(task.get("attempt", 1)) + 1,
                **({"subseed": task["subseed"]} if "subseed" in task else {}),
                **({"cell": task["cell"], "override": task["override"]} if "override" in task else {}),
            } for task in missing],
        }
        for task in missing:
            task["retried_in"] = batch["id"]
        source["updated"] = now
        _batches["batches"].append(batch)
        _trim()
        _batches["idempotency"][key] = batch["id"]
        _save_batches()
        snapshot = _batch_public(batch)
    return 202, {"batch": snapshot, "retry_of": batch_id, "skipped": problems}


def _trim() -> None:
    finished = [b for b in _batches["batches"] if _batch_state(b) not in ("running", "cancelling")]
    while len(_batches["batches"]) > MAX_BATCHES and finished:
        victim = finished.pop(0)
        _batches["batches"].remove(victim)
    live_ids = {b["id"] for b in _batches["batches"]}
    _batches["idempotency"] = {k: v for k, v in _batches["idempotency"].items() if v in live_ids}


def get_batch(batch_id: str) -> tuple[int, dict]:
    if not BATCH_RE.fullmatch(batch_id or ""):
        return 404, {"error": "Introuvable"}
    with _LOCK:
        _sweep()
        batch = _find_batch(batch_id)
        if batch is None:
            return 404, {"error": "Introuvable"}
        return 200, {"batch": _batch_public(batch)}


def list_batches() -> tuple[int, dict]:
    with _LOCK:
        _sweep()
        rows = [_batch_public(batch) for batch in reversed(_batches["batches"][-10:])]
    return 200, {"batches": rows}


def cancel_batch(batch_id: str) -> tuple[int, dict]:
    if not BATCH_RE.fullmatch(batch_id or ""):
        return 404, {"error": "Introuvable"}
    with _LOCK:
        batch = _find_batch(batch_id)
        if batch is None:
            return 404, {"error": "Introuvable"}
        batch["cancelled"] = True
        dropped = deferred = 0
        for task in batch["tasks"]:
            if task["state"] == "queued":
                _set_task(task, "cancelled", "cancelled")
                dropped += 1
            elif task["state"] in ("dispatched", "running", "saving"):
                task["cancel_deferred"] = True
                task["message"] = MESSAGES["cancel_deferred"]
                deferred += 1
        batch["updated"] = _now_iso()
        _save_batches()
        return 200, {"dropped": dropped, "deferred": deferred, "batch": _batch_public(batch)}


def _sweep() -> None:
    """Expire leases. Expired dispatched tasks become uncertain; they are never re-queued."""
    now = _clock()
    changed = False
    for batch in _batches["batches"]:
        usable = [w for w in batch["workers"] if w == LOCAL_ID or _worker(w) is not None]
        for task in batch["tasks"]:
            if task["state"] in ("dispatched", "running") and task.get("worker_id") != LOCAL_ID:
                if float(task.get("lease_until") or 0) < now or now - float(task.get("dispatched_ts") or now) > LEASE_MAX_SEC:
                    _set_task(task, "uncertain", "uncertain_lease", finished_at=_now_iso())
                    changed = True
            elif task["state"] == "queued" and not usable:
                _set_task(task, "failed", "no_worker", finished_at=_now_iso())
                changed = True
    if changed:
        _save_batches()


def _next_task(worker_id: str) -> tuple[dict, dict] | None:
    for batch in _batches["batches"]:
        if batch.get("cancelled") or worker_id not in batch["workers"]:
            continue
        for task in batch["tasks"]:
            if task["state"] == "queued":
                return batch, task
    return None


def _dispatch(batch: dict, task: dict, worker_id: str) -> None:
    now = _clock()
    _set_task(task, "dispatched", "", worker_id=worker_id, dispatched_at=_now_iso(now), dispatched_ts=now,
              lease_until=now + _lease_sec, progress=0)
    batch["updated"] = _now_iso(now)
    _save_batches()


def _task_settings(batch: dict, task: dict) -> dict:
    settings = dict(batch["settings"])
    settings["seed"] = task["seed"]
    if "subseed" in task:
        settings["subseed"] = task["subseed"]
    if isinstance(task.get("override"), dict):
        settings.update(task["override"])  # E: this sweep cell's one changed setting
    return settings


def _accept_image(batch: dict, task: dict, raw: bytes, worker_id: str) -> tuple[int, dict]:
    """Validate and store one PNG. Called without _LOCK; the task is in 'saving'."""
    settings = _task_settings(batch, task)
    code = ""
    image = None
    if not isinstance(raw, (bytes, bytearray)) or not raw.startswith(wire.PNG_MAGIC) or len(raw) > gallery.MAX_BYTES:
        code = "bad_image"
    else:
        scale = settings["hr_scale"] if settings.get("enable_hr") else 1
        limit_w, limit_h = round(settings["width"] * scale), round(settings["height"] * scale)
        try:
            png, _thumb, width, height = gallery.prepare_image(bytes(raw))
            if width > limit_w or height > limit_h:
                code = "bad_image"
            else:
                store_settings = dict(settings, n_iter=1, batch_size=1)
                origin = {"worker_id": worker_id, "worker_name": _worker_name(worker_id)[:40], "batch_id": batch["id"], "task_id": task["id"]}
                sha = (batch.get("parity") or {}).get("checkpoint_sha256")
                if isinstance(sha, str):
                    origin["checkpoint_sha256"] = sha
                image = gallery.store(_root, bytes(raw), store_settings, origin=origin)
        except gallery.GalleryError as exc:
            code = exc.code if exc.code in MESSAGES else "bad_image"
        except Exception:
            code = "bad_image"
    with _LOCK:
        if code:
            _set_task(task, "failed", code, finished_at=_now_iso())
        else:
            _set_task(task, "completed", "", image_id=image["id"], progress=1, finished_at=_now_iso())
        batch["updated"] = _now_iso()
        _save_batches()
    if code:
        return 422, {"error": MESSAGES[code], "code": code}
    return 200, {"ok": True, "image_id": image["id"]}


# ------------------------------------------------------------------ worker endpoints

def max_body(path: str) -> int:
    if path == wire.PREFIX + "/result":
        return RESULT_MAX
    if path == wire.PREFIX + "/enroll":
        return ENROLL_MAX
    return POLL_MAX


def _json(body: bytes) -> dict | None:
    try:
        data = json.loads(body.decode("utf-8")) if body else {}
    except (UnicodeError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def handle_worker(method: str, path: str, headers, body: bytes, ip: str) -> tuple[int, dict]:
    if _root is None:
        return 503, {"error": "Indisponible"}
    if method != "POST":
        return 405, {"error": "POST requis"}
    route = path[len(wire.PREFIX):]
    if len(body or b"") > max_body(path):
        return 413, {"error": "Requête trop grande."}
    if route == "/enroll":
        data = _json(body)
        if data is None:
            return 400, {"error": "JSON invalide"}
        return enroll(data, ip)
    if route not in ("/poll", "/progress", "/result", "/fail"):
        return 404, {"error": "Inconnu"}
    row = authenticate(method, path, headers, body)
    if row is None:
        return 401, {"error": "Signature refusée"}
    data = _json(body)
    if data is None:
        return 400, {"error": "JSON invalide"}
    worker_id = row["id"]
    with _LOCK:
        live = _live.setdefault(worker_id, {})
        live["last_seen"] = _clock()
        if route == "/poll":
            return _poll(row, live, data)
        task_id = data.get("task_id")
        found = _find_task(task_id) if isinstance(task_id, str) and TASK_RE.fullmatch(task_id) else None
        if found is None or found[1].get("worker_id") != worker_id:
            return 404, {"error": "Tâche inconnue"}
        batch, task = found
        if route == "/progress":
            if task["state"] not in ("dispatched", "running"):
                return 409, {"error": "Tâche close"}
            value = data.get("progress")
            value = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0
            step = data.get("step") if isinstance(data.get("step"), int) and not isinstance(data.get("step"), bool) else 0
            steps = data.get("steps") if isinstance(data.get("steps"), int) and not isinstance(data.get("steps"), bool) else 0
            task.update(state="running", progress=max(0.0, min(1.0, value)), step=max(0, min(step, 1000)),
                        steps=max(0, min(steps, 1000)), lease_until=_clock() + _lease_sec, message=MESSAGES["running"])
            return 200, {"ok": True, "cancel_deferred": bool(task.get("cancel_deferred"))}
        if route == "/fail":
            if task["state"] not in ("dispatched", "running"):
                return 200, {"ok": True}
            code = data.get("code") if data.get("code") in ("model_missing", "model_mismatch", "forge_timeout", "forge_error", "forge_offline", "forge_oom", "bad_image") else "forge_error"
            _set_task(task, "failed", code, finished_at=_now_iso())
            live["last_error"] = code
            _save_batches()
            return 200, {"ok": True}
        # /result
        if task["state"] == "completed":
            return 200, {"ok": True, "duplicate": True, "image_id": task.get("image_id")}
        if task["state"] not in ("dispatched", "running", "uncertain"):
            return 409, {"error": "Tâche close"}
        if task["state"] == "uncertain" and task.get("error") == "worker_removed":
            return 409, {"error": "Tâche close"}
        image_b64 = data.get("image_b64")
        if not isinstance(image_b64, str):
            return 400, {"error": MESSAGES["bad_image"], "code": "bad_image"}
        try:
            raw = base64.b64decode(image_b64, validate=True)
        except (ValueError, TypeError):
            raw = b""
        task["state"] = "saving"
    code, payload = _accept_image(batch, task, raw, worker_id)
    with _LOCK:
        live = _live.setdefault(worker_id, {})
        live["last_error"] = payload.get("code", "") if code != 200 else ""
    return code, payload


def _poll(row: dict, live: dict, data: dict) -> tuple[int, dict]:
    worker_id = row["id"]
    live["hardware"] = _clean_hardware(data.get("hardware"))
    forge_raw = data.get("forge") if isinstance(data.get("forge"), dict) else {}
    state = forge_raw.get("state") if forge_raw.get("state") in ("ready", "busy", "offline") else "offline"
    model = forge_raw.get("model")
    live["forge"] = {"state": state, "model": model[:200] if isinstance(model, str) else None,
                     "catalog": _clean_catalog(forge_raw.get("catalog"), forge_raw.get("vae") if isinstance(forge_raw.get("vae"), list) else None)}
    error = data.get("last_error")
    live["last_error"] = error if isinstance(error, str) and (error in MESSAGES or error == "upload") else ""
    net = data.get("net")
    if isinstance(net, dict) and net.get("code") == "hq_unreachable":
        since, until = net.get("since"), net.get("until")
        now = _clock()
        if all(isinstance(v, int) and not isinstance(v, bool) for v in (since, until)) and 0 < since <= until <= now + SKEW_SEC \
                and until - since <= 30 * 86400:
            live["net"] = {"since": since, "until": min(until, int(now))}
    current = data.get("current_task")
    changed = False
    for batch in _batches["batches"]:
        for task in batch["tasks"]:
            if task.get("worker_id") == worker_id and task["state"] in ("dispatched", "running") and task["id"] != current:
                _set_task(task, "uncertain", "uncertain_lost", finished_at=_now_iso())
                changed = True
    if changed:
        _save_batches()
    _sweep()
    reply = {"ok": True, "poll_sec": wire.POLL_SEC}
    if row.get("disabled") or state != "ready" or current or _active_task_for(worker_id):
        return 200, reply
    picked = _next_task(worker_id)
    if picked is None:
        return 200, reply
    batch, task = picked
    if compat_reasons(_task_settings(batch, task), live["forge"]["catalog"]) or not _parity_ok(batch, worker_id, live["forge"]["catalog"]):
        return 200, reply
    _dispatch(batch, task, worker_id)
    reply["task"] = {"task_id": task["id"], "batch_id": batch["id"], "settings": _task_settings(batch, task), "lease_sec": _lease_sec}
    sha = (batch.get("parity") or {}).get("checkpoint_sha256")
    if sha:
        reply["task"]["checkpoint_sha256"] = sha
    return 200, reply


# ------------------------------------------------------------------ local worker

def _local_loop(token: int) -> None:
    global _local_task
    while not _stop.wait(_tick):
        if token != _generation:
            return
        with _LOCK:
            if token != _generation or not _local_enabled or _root is None:
                continue
            picked = _next_task(LOCAL_ID)
            if picked is None:
                continue
            root = _root
        try:
            upstream = forge.status()
        except Exception:
            continue
        if upstream.get("forge") != "ready":
            continue
        with jobs._LOCK:
            if jobs._active_job(jobs._load(root)) is not None:
                continue
            with _LOCK:
                if token != _generation:
                    return
                picked = _next_task(LOCAL_ID)
                if picked is None:
                    continue
                batch, task = picked
                _dispatch(batch, task, LOCAL_ID)
                _local_task = task
        try:
            _run_local(batch, task, token)
        finally:
            with _LOCK:
                _local_task = None


def _run_local(batch: dict, task: dict, token: int) -> None:
    settings = _task_settings(batch, task)
    settings["n_iter"] = 1
    stop = threading.Event()

    def poll() -> None:
        while not stop.wait(1.0):
            try:
                progress = forge.read_progress()
            except Exception:
                continue
            state = progress.get("state") if isinstance(progress.get("state"), dict) else {}
            value = progress.get("progress")
            value = float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0.0
            with _LOCK:
                if task["state"] in ("dispatched", "running"):
                    task.update(state="running", progress=max(0.0, min(1.0, value)), message=MESSAGES["running"],
                                step=state.get("sampling_step") if isinstance(state.get("sampling_step"), int) else 0,
                                steps=state.get("sampling_steps") if isinstance(state.get("sampling_steps"), int) else 0)

    threading.Thread(target=poll, name="hq-forge-local-progress", daemon=True).start()
    try:
        body = jobs.submission_body(settings, "task(hq-" + task["id"][3:] + ")")
        parsed = forge.post_json(forge.SUBMIT_PATH, body, timeout=jobs._job_timeout)
    except forge._Probe as exc:
        stop.set()
        with _LOCK:
            if token == _generation:
                if exc.code == "forge_timeout":
                    _set_task(task, "uncertain", "forge_timeout", finished_at=_now_iso())
                else:
                    _set_task(task, "failed", exc.code if exc.code in ("forge_offline", "forge_oom") else "forge_error", finished_at=_now_iso())
                _save_batches()
        return
    except Exception:
        stop.set()
        with _LOCK:
            if token == _generation:
                _set_task(task, "failed", "forge_error", finished_at=_now_iso())
                _save_batches()
        return
    finally:
        stop.set()
    images = parsed.get("images")
    raw = b""
    if isinstance(images, list) and images and isinstance(images[0], str):
        try:
            raw = base64.b64decode(images[0], validate=True)
        except (ValueError, TypeError):
            raw = b""
    if token != _generation:
        return
    with _LOCK:
        task["state"] = "saving"
    _accept_image(batch, task, raw, LOCAL_ID)


# ------------------------------------------------------------------ admin routes

def serve_get(raw: str) -> tuple[int, dict] | None:
    if raw == "/api/forge/devices":
        return 200, devices()
    if raw == "/api/forge/batches":
        return list_batches()
    prefix = "/api/forge/batches/"
    if raw.startswith(prefix) and "/" not in raw[len(prefix):]:
        return get_batch(raw[len(prefix):])
    return None


def serve_post(raw: str, data: dict, key: str) -> tuple[int, dict] | None:
    if raw == "/api/forge/devices/enroll":
        return 200, create_code()
    if raw == "/api/forge/batches":
        return create_batch(data, key)
    prefix = "/api/forge/batches/"
    if raw.startswith(prefix) and raw.endswith("/cancel"):
        return cancel_batch(raw[len(prefix):-len("/cancel")])
    if raw.startswith(prefix) and raw.endswith("/retry"):
        only = data.get("tasks") if isinstance(data, dict) and isinstance(data.get("tasks"), list) else None
        return retry_batch(raw[len(prefix):-len("/retry")], key, [t for t in only if isinstance(t, str)][:64] if only else None)
    if raw.startswith(prefix) and raw.endswith("/resolve") and "/tasks/" in raw:
        batch_id, _, rest = raw[len(prefix):-len("/resolve")].partition("/tasks/")
        return resolve_task(batch_id, rest, data.get("action") if isinstance(data, dict) else None)
    prefix = "/api/forge/devices/"
    if raw.startswith(prefix):
        rest = raw[len(prefix):]
        worker_id, _, action = rest.partition("/")
        if not WORKER_RE.fullmatch(worker_id):
            return 404, {"error": "Introuvable"}
        if action == "rename":
            return rename(worker_id, data.get("name"))
        if action == "disable":
            return set_disabled(worker_id, True)
        if action == "enable":
            return set_disabled(worker_id, False)
        if action == "remove":
            return remove(worker_id)
        return 404, {"error": "Inconnu"}
    return None
