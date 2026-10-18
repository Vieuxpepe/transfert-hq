"""HQ-managed Forge text-to-image jobs.

Live cancellation is deferred. Forge's interrupt flag is process-wide and
can stop a job HQ does not own, so a timeout or a cancel after submit never
calls it. A job still queued inside HQ can be cancelled locally.
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
import threading
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path

import hq_forge as forge
import hq_forge_gallery as gallery
import hq_forge_vault as vault

TERMINAL = {"completed", "failed", "cancelled", "unknown"}
ACTIVE = {"queued", "starting", "generating", "saving"}
JOB_RE = re.compile(r"^job-[0-9a-f]{24}$")
KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,80}$")
TASK_RE = re.compile(r"^task\(hq-[0-9a-f]{24}\)$")
BODY_KEYS = {
    "prompt", "negative_prompt", "checkpoint", "sampler_name", "scheduler",
    "width", "height", "steps", "cfg_scale", "seed", "n_iter", "batch_size",
    "enable_hr", "hr_scale", "hr_upscaler", "hr_second_pass_steps", "denoising_strength",
    "destination",
}

_LOCK = threading.Lock()
_generation = 0
_recovered = False
_before_submit = None
_admission_hook = None
_prepared_token: str | None = None
_admission_timeout_ms = 10000
_job_timeout = forge.JOB_TIMEOUT_SEC
_poll_interval = 1.0

# The lifecycle listener is a different process from HQ. This mutex is the
# cross-process admission boundary. The product name stays unarmed in tests;
# a shared root derives one Local\TransfertHQ-M1-Admission-* name instead.
PRODUCT_ADMISSION_MUTEX = "Local\\TransfertHQ-Forge-Admission"
_WAIT_OBJECT_0 = 0
_WAIT_ABANDONED = 0x00000080
_kernel = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
_kernel.CreateMutexW.restype = wintypes.HANDLE
_kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
_kernel.WaitForSingleObject.restype = wintypes.DWORD
_kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
_kernel.ReleaseMutex.restype = wintypes.BOOL
_kernel.CloseHandle.argtypes = [wintypes.HANDLE]
_kernel.CloseHandle.restype = wintypes.BOOL


class _AdmissionBusy(Exception):
    pass

_MESSAGES = {
    "forge_offline": "Forge n'est pas démarré.",
    "api_disabled": "Forge est ouvert, mais son API n'est pas activée.",
    "catalog_empty": "Forge répond, mais le catalogue utilisable est vide.",
    "forge_timeout": "HQ a cessé d'attendre. Forge n'a pas été interrompu.",
    "forge_busy": "Forge est déjà en train de générer.",
    "bad_image": "Forge a renvoyé une image inutilisable.",
    "quota": "Le quota de la galerie est atteint. Rien n'a été effacé.",
    "disk": "Espace disque insuffisant.",
    "forge_error": "Forge a renvoyé une réponse inutilisable.",
    "forge_http": "Forge a répondu par un code d'erreur.",
    "forge_malformed": "Forge a renvoyé un JSON illisible.",
    "forge_schema": "Forge a renvoyé un résultat inattendu.",
    "hq_restart": "HQ a redémarré pendant ce travail. Il n'a pas été relancé.",
    "stopped": "Forge s'est arrêté.",
    "cancelled": "Annulé avant l'envoi à Forge.",
    "deferred": "HQ ne peut pas arrêter une génération déjà envoyée à Forge. L'interruption globale pourrait couper un autre travail.",
    "active": "Une génération HQ est déjà en cours.",
    "lifecycle_busy": "Un redémarrage Forge est en préparation. Aucune nouvelle génération n'est acceptée.",
    "validation": "Les réglages ne sont pas acceptés.",
    "private_restricted": "Hires. fix n'est pas disponible en génération privée.",
    "disabled": vault.public_error("disabled"),
    "locked": vault.public_error("locked"),
    "missing": vault.public_error("missing"),
    "vault_locked": "Le coffre s'est verrouillé avant l'enregistrement. L'image n'a pas été conservée.",
}


def reset_for_tests() -> None:
    global _generation, _recovered, _before_submit, _admission_hook, _prepared_token, _admission_timeout_ms, _job_timeout, _poll_interval
    _generation += 1
    _recovered = False
    _before_submit = None
    _admission_hook = None
    _prepared_token = None
    _admission_timeout_ms = 10000
    _job_timeout = forge.JOB_TIMEOUT_SEC
    _poll_interval = 1.0
    gallery.reset_for_tests()
    vault.reset_for_tests()


def set_before_submit_for_tests(callback) -> None:
    global _before_submit
    _before_submit = callback


def set_admission_hook_for_tests(callback) -> None:
    """Runs while the admission mutex is held. Tests use it as a barrier."""
    global _admission_hook
    _admission_hook = callback


def set_admission_timeout_for_tests(milliseconds: int) -> None:
    global _admission_timeout_ms
    _admission_timeout_ms = int(milliseconds)


def prepared_claim_token() -> str | None:
    """Token chosen for the claim in progress. It is not on disk until the write."""
    return _prepared_token


def admission_mutex_name(root: Path) -> str:
    """Name shared by every process that admits jobs or prepares a restart for this root."""
    key = os.path.normcase(str(Path(root).resolve()))
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return "Local\\TransfertHQ-M1-Admission-" + digest


def set_job_timeout_for_tests(seconds: float | None) -> None:
    global _job_timeout
    _job_timeout = forge.JOB_TIMEOUT_SEC if seconds is None else float(seconds)


def set_poll_interval_for_tests(seconds: float | None) -> None:
    global _poll_interval
    _poll_interval = 1.0 if seconds is None else float(seconds)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _store_path(root: Path) -> Path:
    folder = Path(root) / ".hq-forge"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "jobs.json"


def _load(root: Path) -> dict:
    path = _store_path(root)
    if not path.is_file():
        return {"jobs": [], "idempotency": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"jobs": [], "idempotency": {}}
    if not isinstance(data, dict) or not isinstance(data.get("jobs"), list) or not isinstance(data.get("idempotency"), dict):
        return {"jobs": [], "idempotency": {}}
    return data


def _save(root: Path, data: dict) -> None:
    path = _store_path(root)
    temporary = path.with_suffix(".json.partial")
    payload = json.dumps(data, ensure_ascii=False).encode("utf-8")
    with temporary.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def recover(root: Path) -> None:
    global _recovered
    with _LOCK:
        if _recovered:
            return
        _recovered = True
        gallery.cleanup_partials(root)
        vault.cleanup_partials(root)
        data = _load(root)
        changed = False
        for job in data["jobs"]:
            if isinstance(job, dict) and job.get("state") not in TERMINAL:
                job["state"] = "unknown"
                job["error"] = "hq_restart"
                job["message"] = _MESSAGES["hq_restart"]
                job["updated"] = _now()
                changed = True
        if changed:
            _save(root, data)


def _public(job: dict, *, unlocked: bool = False) -> dict:
    private = job.get("destination") == "private"
    images = []
    for item in job.get("images") or []:
        if not isinstance(item, dict):
            continue
        image_id = str(item.get("id") or "")
        if private:
            if not unlocked or not vault.ID_RE.fullmatch(image_id):
                continue
        elif not gallery.IMG_RE.fullmatch(image_id):
            continue
        images.append({"id": image_id, "width": item.get("width"), "height": item.get("height")})
    return {
        "job_id": job.get("id"),
        "state": job.get("state"),
        "destination": "private" if private else "normal",
        "progress": job.get("progress") or 0,
        "step": job.get("step") or 0,
        "steps": job.get("steps") or 0,
        "progress_stale": bool(job.get("progress_stale")),
        "message": job.get("message") or "",
        "error": job.get("error") or "",
        "images": images,
        "settings": {} if private else (job.get("settings") or {}),
        "seed_used": None if private and not unlocked else job.get("seed_used"),
        "cancel": "unchanged" if job.get("state") in TERMINAL else ("deferred" if job.get("submitted") else "local"),
        "locked": bool(private and not unlocked),
        "created": job.get("created"),
        "updated": job.get("updated"),
        "diagnostic": _diagnostic(job.get("diagnostic")),
    }


def _session_open(root: Path, token: str | None) -> bool:
    if not token:
        return False
    try:
        return bool(vault.status(root, token).get("unlocked"))
    except Exception:
        return False


def _find(data: dict, job_id: str) -> dict | None:
    for job in data["jobs"]:
        if isinstance(job, dict) and job.get("id") == job_id:
            return job
    return None


def _mutate(root: Path, job_id: str, token: int, **fields) -> None:
    if token != _generation:
        return
    with _LOCK:
        if token != _generation:
            return
        data = _load(root)
        job = _find(data, job_id)
        if job is None:
            return
        if job.get("state") == "cancelled" and fields.get("state") == "completed":
            return
        if job.get("state") in TERMINAL and fields.get("state") not in TERMINAL and "state" in fields:
            return
        job.update(fields)
        job["updated"] = _now()
        _save(root, data)


def _text(value, limit: int, *, required: bool) -> str | None:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        return None
    text = value.replace("\r\n", "\n").strip()
    if any(ord(ch) < 32 and ch not in "\n\t" for ch in text):
        return None
    if len(text) > limit or (required and not text):
        return None
    return text


def _int(value, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < low or value > high:
        return None
    return value


def submission_body(settings: dict, task_id: str) -> dict:
    if not TASK_RE.fullmatch(task_id):
        raise ValueError("task")
    body = {
        "prompt": settings["prompt"],
        "negative_prompt": settings.get("negative_prompt") or "",
        "seed": settings["seed"],
        "sampler_name": settings["sampler_name"],
        "scheduler": settings.get("scheduler") or "automatic",
        "steps": settings["steps"],
        "cfg_scale": settings["cfg_scale"],
        "width": settings["width"],
        "height": settings["height"],
        "batch_size": 1,
        "n_iter": settings["n_iter"],
        "save_images": False,
        "send_images": True,
        "script_name": "",
        "script_args": [],
        "alwayson_scripts": {},
        "force_task_id": task_id,
        "override_settings_restore_afterwards": True,
    }
    if settings.get("checkpoint"):
        body["override_settings"] = {"sd_model_checkpoint": settings["checkpoint"]}
    if settings.get("enable_hr"):
        body["enable_hr"] = True
        body["hr_scale"] = settings["hr_scale"]
        body["hr_upscaler"] = settings["hr_upscaler"]
        body["hr_second_pass_steps"] = settings["hr_second_pass_steps"]
        body["denoising_strength"] = settings["denoising_strength"]
        body["hr_resize_x"] = 0
        body["hr_resize_y"] = 0
    return body


def _finite(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return number


def _scale(value) -> float | None:
    number = _finite(value)
    if number is None:
        return None
    if abs(number - 1.5) < 1e-6:
        return 1.5
    if abs(number - 2.0) < 1e-6:
        return 2.0
    return None


def _denoise(value) -> float | None:
    number = _finite(value)
    if number is None:
        return None
    number = round(number, 2)
    if number < 0.2 or number > 0.7:
        return None
    return number


def _hires(data: dict, catalog: dict, width: int, height: int) -> dict | tuple:
    enabled = data.get("enable_hr", False)
    if enabled in (False, None):
        return {
            "enable_hr": False,
            "hr_scale": 2.0,
            "hr_upscaler": "",
            "hr_second_pass_steps": 0,
            "denoising_strength": 0.5,
        }
    if enabled is not True:
        return ("validation",)
    scale = _scale(data.get("hr_scale", 2))
    second = _int(data.get("hr_second_pass_steps", 0), 0, 20)
    denoise = _denoise(data.get("denoising_strength", 0.5))
    upscaler = data.get("hr_upscaler")
    names = {item.get("name") for item in catalog.get("upscalers") or [] if isinstance(item, dict)}
    if scale is None or second is None or denoise is None:
        return ("validation",)
    if not isinstance(upscaler, str) or not upscaler or upscaler not in names:
        return ("validation",)
    if round(width * scale) > 2048 or round(height * scale) > 2048:
        return ("validation",)
    return {
        "enable_hr": True,
        "hr_scale": scale,
        "hr_upscaler": upscaler,
        "hr_second_pass_steps": second,
        "denoising_strength": denoise,
    }


def _validate(data: dict, catalog: dict) -> dict | tuple:
    if not isinstance(data, dict) or set(data) - BODY_KEYS:
        return ("validation",)
    prompt = _text(data.get("prompt"), 2000, required=True)
    negative = _text(data.get("negative_prompt", ""), 1000, required=False)
    width = _int(data.get("width", 512), 256, 1536)
    height = _int(data.get("height", 512), 256, 1536)
    steps = _int(data.get("steps", 20), 1, 40)
    n_iter = _int(data.get("n_iter", 1), 1, 2)
    seed = _int(data.get("seed", -1), -1, 2**32 - 1)
    batch = _int(data.get("batch_size", 1), 1, 1)
    cfg = data.get("cfg_scale", 7)
    if isinstance(cfg, bool) or not isinstance(cfg, (int, float)) or not 1 <= float(cfg) <= 15:
        cfg = None
    if None in (prompt, negative, width, height, steps, n_iter, seed, batch, cfg):
        return ("validation",)
    if width % 64 or height % 64:
        return ("validation",)
    names = {item.get("name") for item in catalog.get("samplers") or [] if isinstance(item, dict)}
    schedulers = {item.get("name") for item in catalog.get("schedulers") or [] if isinstance(item, dict)}
    sampler = data.get("sampler_name")
    scheduler = data.get("scheduler") or "automatic"
    if not isinstance(sampler, str) or sampler not in names:
        return ("validation",)
    if not isinstance(scheduler, str) or scheduler not in schedulers:
        return ("validation",)
    checkpoint = data.get("checkpoint") or ""
    titles = {item.get("title") for item in catalog.get("models") or [] if isinstance(item, dict)}
    if not isinstance(checkpoint, str) or not checkpoint or checkpoint not in titles:
        return ("validation",)
    hires = _hires(data, catalog, width, height)
    if isinstance(hires, tuple):
        return hires
    return {
        "prompt": prompt,
        "negative_prompt": negative,
        "checkpoint": checkpoint,
        "sampler_name": sampler,
        "scheduler": scheduler,
        "width": width,
        "height": height,
        "steps": steps,
        "cfg_scale": float(cfg),
        "seed": seed,
        "n_iter": n_iter,
        "batch_size": 1,
        **hires,
    }


def _active_job(data: dict) -> dict | None:
    for job in data["jobs"]:
        if isinstance(job, dict) and job.get("state") in ACTIVE:
            return job
    return None


def _restart_block_reason(data: dict) -> str | None:
    for job in data["jobs"]:
        if not isinstance(job, dict):
            continue
        if job.get("state") in ACTIVE:
            return "active"
        if job.get("progress_stale") and job.get("state") not in TERMINAL:
            return "progress_stale"
    return None


_GATE_FIELDS = frozenset({"version", "pending", "signaled", "sealed", "token", "epoch"})
_GATE_TOKEN = re.compile(r"^[0-9a-f]{32}$")
_GATE_EPOCH_MAX = 2_147_483_647


def _gate_path(root: Path) -> Path:
    return Path(root) / ".hq-forge" / "restart-gate.json"


def _closed_gate() -> dict:
    """Fail closed. Callers must not treat this as a record they may rewrite."""
    return {"pending": True, "signaled": True, "sealed": True, "token": "", "epoch": 0, "valid": False}


def _gate_blocks(gate: dict) -> bool:
    return bool(gate.get("pending") or gate.get("signaled") or gate.get("sealed") or gate.get("valid") is False)


def _valid_gate_record(data: object) -> dict | None:
    """Return a normalized record, or None when the file must not be trusted."""
    if not isinstance(data, dict) or set(data) != _GATE_FIELDS:
        return None
    version = data["version"]
    pending = data["pending"]
    signaled = data["signaled"]
    sealed = data["sealed"]
    token = data["token"]
    epoch = data["epoch"]
    if type(version) is not int or version != 1:
        return None
    if type(pending) is not bool or type(signaled) is not bool or type(sealed) is not bool:
        return None
    if type(token) is not str or type(epoch) is not int:
        return None
    if epoch < 0 or epoch > _GATE_EPOCH_MAX:
        return None
    if signaled and not sealed:
        return None
    if (signaled or sealed) and not pending:
        return None
    if pending:
        if epoch < 1 or _GATE_TOKEN.fullmatch(token) is None:
            return None
    elif signaled or sealed or token != "":
        return None
    return {
        "pending": pending,
        "signaled": signaled,
        "sealed": sealed,
        "token": token,
        "epoch": epoch,
        "valid": True,
    }


def _read_gate(root: Path) -> dict:
    path = _gate_path(root)
    if not path.is_file():
        return {"pending": False, "signaled": False, "sealed": False, "token": "", "epoch": 0, "valid": True}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return _closed_gate()
    parsed = _valid_gate_record(data)
    if parsed is None:
        return _closed_gate()
    return parsed


def _write_gate(root: Path, *, pending: bool, signaled: bool, sealed: bool = False, token: str = "", epoch: int = 0) -> None:
    folder = Path(root) / ".hq-forge"
    folder.mkdir(parents=True, exist_ok=True)
    path = _gate_path(root)
    temporary = path.with_suffix(".tmp")
    payload = json.dumps({
        "version": 1,
        "pending": pending,
        "signaled": signaled,
        "sealed": sealed,
        "token": token,
        "epoch": int(epoch),
    }).encode("utf-8")
    with temporary.open("wb") as handle:
        handle.write(payload)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def _token_matches(gate: dict, token: str | None) -> bool:
    expected = gate.get("token") or ""
    given = token or ""
    if not expected or not given or len(expected) != len(given):
        return False
    return hmac.compare_digest(expected, given)


def _acquire_admission(root: Path):
    name = admission_mutex_name(root)
    if name == PRODUCT_ADMISSION_MUTEX:
        raise _AdmissionBusy()
    handle = _kernel.CreateMutexW(None, False, name)
    if not handle:
        raise _AdmissionBusy()
    waited = int(_kernel.WaitForSingleObject(handle, _admission_timeout_ms))
    if waited not in (_WAIT_OBJECT_0, _WAIT_ABANDONED):
        _kernel.CloseHandle(handle)
        raise _AdmissionBusy()
    return handle


def _release_admission(handle) -> None:
    if not handle:
        return
    _kernel.ReleaseMutex(handle)
    _kernel.CloseHandle(handle)


def _hook(point: str) -> None:
    hook = _admission_hook
    if hook is not None:
        hook(point)


def claim_restart(root: Path) -> tuple[bool, str, str | None]:
    """Set restart pending only when no HQ job is already admitted.

    The eligibility check and the gate write share the cross-process mutex.
    The returned token is required to clear this preparation.
    """
    global _prepared_token
    try:
        hold = _acquire_admission(root)
    except _AdmissionBusy:
        return False, "lifecycle_busy", None
    try:
        with _LOCK:
            _hook("claim_enter")
            reason = _restart_block_reason(_load(root))
            if reason:
                return False, reason, None
            gate = _read_gate(root)
            if _gate_blocks(gate):
                return False, "restart_pending", None
            token = secrets.token_hex(16)
            _prepared_token = token
            _hook("before_gate_write")
            _write_gate(
                root,
                pending=True,
                signaled=False,
                sealed=False,
                token=token,
                epoch=int(gate.get("epoch") or 0) + 1,
            )
            _hook("after_gate_write")
            _hook("claim_held")
            return True, "ok", token
    finally:
        _prepared_token = None
        _release_admission(hold)


def release_restart(root: Path, token: str | None = None) -> bool:
    """Clear a preparation this caller still owns. A stale token does not write."""
    try:
        hold = _acquire_admission(root)
    except _AdmissionBusy:
        return False
    try:
        with _LOCK:
            gate = _read_gate(root)
            if gate.get("valid") is False:
                return False
            if not gate["pending"]:
                return True
            if gate["signaled"] or gate["sealed"] or not _token_matches(gate, token):
                return False
            _write_gate(root, pending=False, signaled=False, sealed=False, token="", epoch=gate["epoch"] + 1)
            return True
    finally:
        _release_admission(hold)


def finish_signaled_restart(root: Path, token: str | None = None) -> bool:
    """Open admission after the signaled restart this token owns has finished."""
    try:
        hold = _acquire_admission(root)
    except _AdmissionBusy:
        return False
    try:
        with _LOCK:
            gate = _read_gate(root)
            if gate.get("valid") is False or not gate["signaled"] or not _token_matches(gate, token):
                return False
            _write_gate(root, pending=False, signaled=False, sealed=False, token="", epoch=gate["epoch"] + 1)
            return True
    finally:
        _release_admission(hold)


def confirm_restart(root: Path, token: str | None = None) -> tuple[bool, str]:
    """Re-check the owned gate and HQ jobs before any signal."""
    try:
        hold = _acquire_admission(root)
    except _AdmissionBusy:
        return False, "lifecycle_busy"
    try:
        with _LOCK:
            gate = _read_gate(root)
            if gate.get("valid") is False or not _token_matches(gate, token):
                return False, "uncertain"
            if gate["signaled"] or gate["sealed"] or not gate["pending"]:
                return False, "uncertain"
            reason = _restart_block_reason(_load(root))
            if reason:
                _write_gate(root, pending=False, signaled=False, sealed=False, token="", epoch=gate["epoch"] + 1)
                return False, reason
            return True, "ok"
    finally:
        _release_admission(hold)


def mark_restart_signaled(root: Path, token: str | None = None) -> bool:
    """Record that termination was requested. A different token cannot do this."""
    try:
        hold = _acquire_admission(root)
    except _AdmissionBusy:
        return False
    try:
        with _LOCK:
            gate = _read_gate(root)
            if gate.get("valid") is False or not gate["pending"] or gate["sealed"] or not _token_matches(gate, token):
                return False
            _write_gate(root, pending=True, signaled=True, sealed=True, token=token or "", epoch=gate["epoch"] + 1)
            return True
    finally:
        _release_admission(hold)


def seal_restart(root: Path, token: str | None = None) -> bool:
    """Keep admission closed when ownership cannot be proved. No signal was sent."""
    try:
        hold = _acquire_admission(root)
    except _AdmissionBusy:
        return False
    try:
        with _LOCK:
            gate = _read_gate(root)
            if gate.get("valid") is False or not _token_matches(gate, token):
                return False
            _write_gate(root, pending=True, signaled=False, sealed=True, token=token or "", epoch=gate["epoch"] + 1)
            return True
    finally:
        _release_admission(hold)


def abort_unsignaled_restart(root: Path, token: str | None = None) -> bool:
    """Clear an interrupted preparation only when the token matches and nothing was sealed."""
    return release_restart(root, token)


def restart_gate(root: Path) -> dict:
    try:
        hold = _acquire_admission(root)
    except _AdmissionBusy:
        return {"pending": True, "signaled": True, "sealed": True, "token": "", "epoch": 0}
    try:
        with _LOCK:
            gate = _read_gate(root)
            return {key: gate[key] for key in ("pending", "signaled", "sealed", "epoch")}
    finally:
        _release_admission(hold)


def _trim_keys(data: dict) -> None:
    pairs = []
    for key, job_id in data["idempotency"].items():
        job = _find(data, job_id)
        if job is None or job.get("state") in TERMINAL:
            pairs.append((job.get("updated") if job else "", key))
    if len(data["idempotency"]) <= 200:
        return
    pairs.sort()
    for _stamp, key in pairs:
        if len(data["idempotency"]) <= 200:
            break
        data["idempotency"].pop(key, None)


def _seed_used(parsed: dict, requested: int) -> int | None:
    info = parsed.get("info")
    if isinstance(info, str):
        try:
            info = json.loads(info)
        except json.JSONDecodeError:
            info = None
    if isinstance(info, dict):
        seeds = info.get("all_seeds")
        if isinstance(seeds, list) and seeds and isinstance(seeds[0], int) and not isinstance(seeds[0], bool) and seeds[0] >= 0:
            return seeds[0]
        if isinstance(info.get("seed"), int) and not isinstance(info.get("seed"), bool) and info["seed"] >= 0:
            return info["seed"]
    if requested >= 0:
        return requested
    return None


def _diagnostic(value) -> dict | None:
    """Safe failure details only. Upstream bodies and prompts never qualify."""
    if not isinstance(value, dict):
        return None
    status = value.get("http_status")
    elapsed = value.get("elapsed_ms")
    classification = value.get("classification")
    if not isinstance(classification, str) or not classification.isascii() or len(classification) > 40:
        classification = ""
    return {
        "classification": classification,
        "http_status": status if isinstance(status, int) and not isinstance(status, bool) and 100 <= status <= 599 else None,
        "elapsed_ms": elapsed if isinstance(elapsed, int) and not isinstance(elapsed, bool) and 0 <= elapsed <= 3_600_000 else None,
    }


def _fail(root: Path, job_id: str, token: int, code: str, *, http_status: int | None = None, elapsed_ms: int | None = None) -> None:
    diagnostic = _diagnostic({
        "classification": code,
        "http_status": http_status,
        "elapsed_ms": elapsed_ms,
    })
    _mutate(
        root, job_id, token,
        state="failed",
        error=code,
        message=_MESSAGES.get(code, _MESSAGES["forge_error"]),
        progress_stale=False,
        diagnostic=diagnostic,
    )


def _run(root: Path, job_id: str, token: int, transport, inline_settings=None, session_token: str | None = None) -> None:
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None or job.get("state") != "queued":
            return
        job["state"] = "starting"
        job["updated"] = _now()
        _save(root, data)
        settings = dict(inline_settings) if inline_settings is not None else dict(job["settings"])
        destination = job.get("destination") or "normal"
        task_id = job["task_id"]
    if _before_submit is not None:
        _before_submit(job_id)
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None or job.get("state") == "cancelled":
            return
        job["submitted"] = True
        job["state"] = "generating"
        job["updated"] = _now()
        _save(root, data)
    stop = threading.Event()

    def poll() -> None:
        misses = 0
        while not stop.wait(_poll_interval):
            try:
                progress = forge.read_progress(transport=transport)
            except forge._Probe:
                misses += 1
                if misses >= 3:
                    _mutate(root, job_id, token, progress_stale=True)
                continue
            misses = 0
            state = progress.get("state") if isinstance(progress.get("state"), dict) else {}
            step = state.get("sampling_step") if isinstance(state.get("sampling_step"), int) else 0
            steps = state.get("sampling_steps") if isinstance(state.get("sampling_steps"), int) else 0
            value = progress.get("progress")
            if not isinstance(value, (int, float)) or isinstance(value, bool):
                value = 0
            value = max(0.0, min(1.0, float(value)))
            _mutate(root, job_id, token, progress=value, step=step, steps=steps, progress_stale=False)

    threading.Thread(target=poll, name="hq-forge-progress", daemon=True).start()
    try:
        body = submission_body(settings, task_id)
        parsed = forge.post_json(forge.SUBMIT_PATH, body, timeout=_job_timeout, transport=transport)
    except forge._Probe as exc:
        stop.set()
        code = "stopped" if exc.code == "forge_offline" else exc.code
        if code not in _MESSAGES:
            code = "forge_error"
        if exc.code == "forge_timeout":
            _mutate(
                root, job_id, token,
                state="unknown",
                error="forge_timeout",
                message=_MESSAGES["forge_timeout"],
                diagnostic=_diagnostic({
                    "classification": "forge_timeout",
                    "http_status": exc.http_status,
                    "elapsed_ms": exc.elapsed_ms,
                }),
            )
        else:
            _fail(root, job_id, token, code, http_status=exc.http_status, elapsed_ms=exc.elapsed_ms)
        return
    except Exception:
        stop.set()
        _fail(root, job_id, token, "forge_error")
        return
    finally:
        stop.set()
    _mutate(root, job_id, token, state="saving")
    images = parsed.get("images")
    if not isinstance(images, list) or not images:
        _fail(root, job_id, token, "bad_image")
        return
    stored = []
    try:
        for item in images[: settings["n_iter"]]:
            if not isinstance(item, str):
                raise gallery.GalleryError("bad_image")
            raw = base64.b64decode(item, validate=True)
            if destination == "private":
                stored.append(vault.store_image(root, session_token, raw, settings))
            else:
                stored.append(gallery.store(root, raw, settings))
    except vault.VaultError as exc:
        code = "vault_locked" if exc.code == "locked" else exc.code
        _fail(root, job_id, token, code if code in _MESSAGES else "bad_image")
        return
    except gallery.GalleryError as exc:
        _fail(root, job_id, token, exc.code if exc.code in _MESSAGES else "bad_image")
        return
    except Exception:
        _fail(root, job_id, token, "bad_image")
        return
    _mutate(
        root, job_id, token,
        state="completed",
        error="",
        message="Terminé.",
        images=stored,
        seed_used=_seed_used(parsed, settings["seed"]),
        progress=1,
        progress_stale=False,
    )


def _destination(data: dict) -> str | None:
    if not isinstance(data, dict):
        return None
    value = data.get("destination", "normal")
    if value not in ("normal", "private"):
        return None
    return value


def create_job(root: Path, data: dict, idempotency_key: str, *, transport=None, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not KEY_RE.fullmatch(idempotency_key or ""):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    destination = _destination(data)
    if destination is None:
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    if destination == "private" and data.get("enable_hr") is True:
        return 403, {"error": _MESSAGES["private_restricted"], "code": "private_restricted"}
    with _LOCK:
        stored = _load(root)
        found = stored["idempotency"].get(idempotency_key)
        existing = _find(stored, found) if isinstance(found, str) else None
    if existing is not None:
        if (existing.get("destination") or "normal") != destination:
            return 409, {"error": "Cette clé correspond déjà à une autre destination.", "code": "destination"}
        return 200, {"job": _public(existing, unlocked=_session_open(root, session_token))}
    if destination == "private":
        if not vault.confirm_private_generation(root):
            return 403, {"error": _MESSAGES["disabled"], "code": "disabled"}
        info = vault.status(root, session_token)
        if not info.get("private_generation"):
            return 403, {"error": _MESSAGES["disabled"], "code": "disabled"}
        if info.get("code") == "bad_root":
            return 503, {"error": vault.public_error("bad_root"), "code": "bad_root"}
        if not info.get("configured"):
            return 409, {"error": _MESSAGES["missing"], "code": "missing"}
        if not info.get("unlocked"):
            return 401, {"error": _MESSAGES["locked"], "code": "locked"}
    try:
        catalog = forge.catalog(transport=transport)
    except Exception:
        return 503, {"error": _MESSAGES["forge_error"], "code": "forge_error"}
    if catalog.get("forge") != "ready":
        code = catalog.get("code") or "forge_error"
        return 409, {"error": _MESSAGES.get(code, _MESSAGES["forge_error"]), "code": code, "forge": catalog.get("forge")}
    validated = _validate(data, catalog)
    if isinstance(validated, tuple):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    try:
        upstream = forge.status(transport=transport)
    except Exception:
        return 503, {"error": _MESSAGES["forge_error"], "code": "forge_error"}
    try:
        admission = _acquire_admission(root)
    except _AdmissionBusy:
        return 409, {"error": _MESSAGES["lifecycle_busy"], "code": "lifecycle_busy"}
    try:
        with _LOCK:
            stored = _load(root)
            existing = stored["idempotency"].get(idempotency_key)
            if isinstance(existing, str):
                job = _find(stored, existing)
                if job is not None:
                    if (job.get("destination") or "normal") != destination:
                        return 409, {"error": "Cette clé correspond déjà à une autre destination.", "code": "destination"}
                    return 200, {"job": _public(job, unlocked=_session_open(root, session_token))}
            if _gate_blocks(_read_gate(root)):
                return 409, {"error": _MESSAGES["lifecycle_busy"], "code": "lifecycle_busy"}
            active = _active_job(stored)
            if active is not None:
                return 409, {"error": _MESSAGES["active"], "code": "active", "active_job_id": active.get("id")}
            if upstream.get("forge") == "busy":
                return 409, {"error": _MESSAGES["forge_busy"], "code": "forge_busy", "forge": "busy"}
            if upstream.get("forge") != "ready":
                code = upstream.get("code") or "forge_error"
                return 409, {"error": _MESSAGES.get(code, _MESSAGES["forge_error"]), "code": code, "forge": upstream.get("forge")}
            _hook("before_admit")
            stored = _load(root)
            if _gate_blocks(_read_gate(root)):
                return 409, {"error": _MESSAGES["lifecycle_busy"], "code": "lifecycle_busy"}
            active = _active_job(stored)
            if active is not None:
                return 409, {"error": _MESSAGES["active"], "code": "active", "active_job_id": active.get("id")}
            job_id = "job-" + os.urandom(12).hex()
            task_id = "task(hq-" + os.urandom(12).hex() + ")"
            job = {
                "id": job_id,
                "task_id": task_id,
                "state": "queued",
                "created": _now(),
                "updated": _now(),
                "idempotency_key": idempotency_key,
                "destination": destination,
                "settings": {} if destination == "private" else validated,
                "submitted": False,
                "progress": 0,
                "step": 0,
                "steps": validated["steps"],
                "progress_stale": False,
                "message": "En file.",
                "error": "",
                "images": [],
                "seed_used": None,
            }
            stored["jobs"].append(job)
            stored["jobs"] = stored["jobs"][-200:]
            stored["idempotency"][idempotency_key] = job_id
            _trim_keys(stored)
            _save(root, stored)
            token = _generation
    finally:
        _release_admission(admission)
    inline = validated if destination == "private" else None
    threading.Thread(
        target=_run,
        args=(root, job_id, token, transport, inline, session_token),
        name="hq-forge-job",
        daemon=True,
    ).start()
    return 202, {"job": _public(job, unlocked=destination == "private")}


def get_job(root: Path, job_id: str, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not JOB_RE.fullmatch(job_id):
        return 404, {"error": "Introuvable"}
    with _LOCK:
        job = _find(_load(root), job_id)
    if job is None:
        return 404, {"error": "Introuvable"}
    unlocked = _session_open(root, session_token) if job.get("destination") == "private" else False
    return 200, {"job": _public(job, unlocked=unlocked)}


def find_idempotency(root: Path, key: str, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not KEY_RE.fullmatch(key or ""):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        data = _load(root)
        job_id = data["idempotency"].get(key)
        job = _find(data, job_id) if isinstance(job_id, str) else None
    if job is None:
        return 404, {"error": "Introuvable"}
    unlocked = _session_open(root, session_token) if job.get("destination") == "private" else False
    return 200, {"job": _public(job, unlocked=unlocked)}


def list_jobs(root: Path, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    with _LOCK:
        jobs = [job for job in _load(root)["jobs"] if isinstance(job, dict)]
    jobs.sort(key=lambda job: job.get("created") or "", reverse=True)
    opened = _session_open(root, session_token)
    return 200, {"jobs": [_public(job, unlocked=opened) for job in jobs[:30]]}


def cancel_job(root: Path, job_id: str, session_token: str | None = None) -> tuple[int, dict]:
    recover(root)
    if not JOB_RE.fullmatch(job_id):
        return 404, {"error": "Introuvable"}
    opened = _session_open(root, session_token)
    with _LOCK:
        data = _load(root)
        job = _find(data, job_id)
        if job is None:
            return 404, {"error": "Introuvable"}
        if job.get("state") in TERMINAL or job.get("submitted"):
            kind = "unchanged" if job.get("state") in TERMINAL else "deferred"
            if kind == "deferred":
                job["message"] = _MESSAGES["deferred"]
                job["updated"] = _now()
                _save(root, data)
            return 200, {"cancel": kind, "message": _MESSAGES["deferred"] if kind == "deferred" else job.get("message") or "", "job": _public(job, unlocked=opened)}
        job["state"] = "cancelled"
        job["error"] = "cancelled"
        job["message"] = _MESSAGES["cancelled"]
        job["updated"] = _now()
        _save(root, data)
        snapshot = _public(job, unlocked=opened)
    return 200, {"cancel": "cancelled", "message": _MESSAGES["cancelled"], "job": snapshot}


def serve_get(root: Path, raw: str, query: str, session_token: str | None = None) -> tuple[int, dict] | None:
    if raw == "/api/forge/jobs":
        from urllib.parse import parse_qs
        key = (parse_qs(query or "").get("idempotency_key") or [""])[0]
        if key:
            return find_idempotency(root, key, session_token)
        return list_jobs(root, session_token)
    prefix = "/api/forge/jobs/"
    if raw.startswith(prefix) and "/" not in raw[len(prefix):]:
        return get_job(root, raw[len(prefix):], session_token)
    return None


def serve_post(root: Path, raw: str, data: dict, idempotency_key: str, session_token: str | None = None) -> tuple[int, dict] | None:
    if raw == "/api/forge/jobs":
        return create_job(root, data, idempotency_key, session_token=session_token)
    prefix = "/api/forge/jobs/"
    suffix = "/cancel"
    if raw.startswith(prefix) and raw.endswith(suffix):
        return cancel_job(root, raw[len(prefix):-len(suffix)], session_token)
    return None
