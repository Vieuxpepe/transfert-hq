# -*- coding: utf-8 -*-
"""Mini-Quêtes — bounded simulated playground quests for Transfert HQ.

Three conceptual quests (no shell, no terminal, no hardware control):

* ``simmer`` — timed warm-up via ``time.sleep`` on a worker thread (never a busy-wait).
* ``pulse`` — synthetic beat reading; always labelled simulated, never a sensor.
* ``gear_whisper`` — one explicit sanitized log line (never auto-logs HTTP traffic).

Long work stays off the HTTP thread. Duration, concurrency, body size and log
volume are hard-capped. Secrets and control characters are scrubbed before disk.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

import hq_diagnostics

DIR_NAME = ".hq-mini-quests"
LOG_NAME = "quest_log.txt"
LOG_ROTATE_BYTES = 64 * 1024
LOG_LINE_MAX = 240
CONTEXT_MAX = 160
BODY_MAX = 4096
JOB_ID_RE = re.compile(r"^[0-9a-f]{16}\Z")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ONE_LINE_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

SIMMER_DEFAULT_SEC = 1.0
SIMMER_MIN_SEC = 0.1
SIMMER_MAX_SEC = 3.0
MAX_CONCURRENT = 2
JOBS_MAX = 40
JOB_TTL_SEC = 300.0

QUESTS = (
    {
        "id": "simmer",
        "label": "Simmer",
        "summary": "Échauffement borné (attente, jamais de busy-wait CPU).",
        "method": "POST",
        "path": "/api/mini-quests/simmer",
        "async": True,
        "simulated": True,
    },
    {
        "id": "pulse",
        "label": "Pulse",
        "summary": "Lecture synthétique — pas un capteur biologique ni matériel.",
        "method": "POST",
        "path": "/api/mini-quests/pulse",
        "async": False,
        "simulated": True,
    },
    {
        "id": "gear_whisper",
        "label": "Gear whisper",
        "summary": "Une ligne de journal explicite, nettoyée et bornée.",
        "method": "POST",
        "path": "/api/mini-quests/whisper",
        "async": False,
        "simulated": True,
    },
)

_cb: dict[str, Any] = {}
_guard = threading.Lock()
_jobs_lock = threading.RLock()
_log_lock = threading.Lock()
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_jobs: dict[str, dict[str, Any]] = {}
_worker: Callable[..., None] | None = None


class QuestError(ValueError):
    status = 400
    code = "validation_error"

    def __init__(self, msg: str, status: int | None = None, code: str | None = None):
        super().__init__(msg)
        if status is not None:
            self.status = status
        if code is not None:
            self.code = code


def bind(**kwargs: Any) -> None:
    """``root`` required; optional ``now``, ``sleep`` (tests), ``worker_start``."""
    with _guard:
        _cb.update({k: v for k, v in kwargs.items() if k in ("root", "now", "sleep", "worker_start")})


def reset_for_tests() -> None:
    """Drop in-memory jobs and release any held slots (unit tests only)."""
    with _jobs_lock:
        _jobs.clear()
    # Drain then refill the semaphore so leftover acquires cannot leak across tests.
    while _slots.acquire(blocking=False):
        pass
    for _ in range(MAX_CONCURRENT):
        try:
            _slots.release()
        except ValueError:
            break


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def _sleep(seconds: float) -> None:
    fn = _cb.get("sleep")
    if callable(fn):
        fn(seconds)
    else:
        time.sleep(seconds)


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise QuestError("Mini-Quêtes non initialisées", 503, "storage_error")
    return Path(os.path.abspath(os.fspath(root)))


def _is_link(path: Path | str) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def log_path(root: Path | str | None = None) -> Path:
    base = Path(os.path.abspath(os.fspath(root if root is not None else _root())))
    return base / DIR_NAME / LOG_NAME


def _ensure_log_dir(path: Path) -> Path:
    parent = path.parent
    base = parent.parent
    if _is_link(base) or (os.path.lexists(parent) and _is_link(parent)):
        raise QuestError("Journal Mini-Quêtes redirigé — refusé", 503, "storage_error")
    os.makedirs(parent, exist_ok=True)
    if _is_link(parent) or (os.path.lexists(path) and _is_link(path)):
        raise QuestError("Journal Mini-Quêtes redirigé — refusé", 503, "storage_error")
    return path


def _sanitize_line(message: str, *, root: Path | None = None) -> str:
    """Single-line, control-free, secret-scrubbed text. Never raises."""
    try:
        scrubbed = hq_diagnostics.scrub(message, root if root is not None else _cb.get("root"), LOG_LINE_MAX)
    except Exception:
        scrubbed = "note"
    # scrub already collapses controls; enforce one line again for belt-and-braces.
    scrubbed = _ONE_LINE_RE.sub(" ", scrubbed)
    scrubbed = re.sub(r"\s+", " ", scrubbed).strip()
    if not scrubbed:
        scrubbed = "note"
    return scrubbed[:LOG_LINE_MAX]


def _append_log(message: str) -> None:
    """Append one sanitized line; rotate when the file exceeds LOG_ROTATE_BYTES."""
    root = _root()
    path = _ensure_log_dir(log_path(root))
    line = _sanitize_line(message, root=root)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(_now()))
    payload = f"[{stamp}] {line}\n"
    with _log_lock:
        try:
            if path.is_file() and path.stat().st_size > LOG_ROTATE_BYTES:
                bak = path.with_name(path.name + ".1")
                try:
                    os.replace(path, bak)
                except OSError as e:
                    # Fail-closed: never keep appending into an unrotatable full log.
                    raise QuestError(
                        "Journal Mini-Quêtes plein — rotation impossible",
                        503,
                        "storage_error",
                    ) from e
            with path.open("a", encoding="utf-8", newline="\n") as fh:
                fh.write(payload)
        except QuestError:
            raise
        except OSError as e:
            raise QuestError("Journal Mini-Quêtes inaccessible", 503, "storage_error") from e


def _prune_jobs_locked(now: float) -> None:
    stale = [jid for jid, job in _jobs.items() if float(job.get("updated_at") or 0) + JOB_TTL_SEC < now]
    for jid in stale:
        _jobs.pop(jid, None)
    if len(_jobs) > JOBS_MAX:
        ordered = sorted(_jobs.items(), key=lambda kv: float(kv[1].get("updated_at") or 0))
        for jid, _ in ordered[: max(0, len(_jobs) - JOBS_MAX)]:
            _jobs.pop(jid, None)


def _job_public(job: dict[str, Any]) -> dict[str, Any]:
    out = {
        "id": job["id"],
        "quest": job["quest"],
        "status": job["status"],
        "simulated": True,
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
    }
    if job.get("result") is not None:
        out["result"] = job["result"]
    if job.get("error"):
        out["error"] = job["error"]
    if job.get("duration_sec") is not None:
        out["duration_sec"] = job["duration_sec"]
    return out


def catalog() -> dict[str, Any]:
    with _jobs_lock:
        _prune_jobs_locked(_now())
        active = sum(1 for j in _jobs.values() if j.get("status") == "running")
        jobs = [_job_public(j) for j in list(_jobs.values())[-12:]]
    return {
        "ok": True,
        "quests": list(QUESTS),
        "limits": {
            "body_max": BODY_MAX,
            "context_max": CONTEXT_MAX,
            "simmer_min_sec": SIMMER_MIN_SEC,
            "simmer_max_sec": SIMMER_MAX_SEC,
            "max_concurrent": MAX_CONCURRENT,
            "log_rotate_bytes": LOG_ROTATE_BYTES,
        },
        "active": active,
        "jobs": jobs,
        "note": "Toutes les Mini-Quêtes sont simulées. Aucune mesure matérielle ou biologique.",
    }


def get_job(job_id: str) -> dict[str, Any]:
    if not isinstance(job_id, str) or not JOB_ID_RE.match(job_id):
        raise QuestError("Identifiant de tâche invalide", 400, "validation_error")
    with _jobs_lock:
        _prune_jobs_locked(_now())
        job = _jobs.get(job_id)
        if job is None:
            raise QuestError("Tâche introuvable", 404, "not_found")
        return {"ok": True, "job": _job_public(job)}


def simmer(*, duration_sec: float | None = None) -> dict[str, Any]:
    """Start a bounded warm-up on a worker thread. Never busy-waits the CPU."""
    if duration_sec is None:
        duration = SIMMER_DEFAULT_SEC
    else:
        if isinstance(duration_sec, bool) or not isinstance(duration_sec, (int, float)):
            raise QuestError("duration_sec invalide", 400, "validation_error")
        duration = float(duration_sec)
        if duration != duration or duration in (float("inf"), float("-inf")):
            raise QuestError("duration_sec invalide", 400, "validation_error")
        if duration < SIMMER_MIN_SEC or duration > SIMMER_MAX_SEC:
            raise QuestError(
                f"duration_sec hors bornes ({SIMMER_MIN_SEC}–{SIMMER_MAX_SEC})",
                400,
                "validation_error",
            )

    if not _slots.acquire(blocking=False):
        raise QuestError("Trop de Mini-Quêtes en cours", 429, "busy")

    job_id = secrets.token_hex(8)
    now = _now()
    job = {
        "id": job_id,
        "quest": "simmer",
        "status": "running",
        "created_at": now,
        "updated_at": now,
        "duration_sec": round(duration, 3),
        "result": None,
        "error": None,
    }
    with _jobs_lock:
        _prune_jobs_locked(now)
        _jobs[job_id] = job

    try:
        starter = _cb.get("worker_start")
        if callable(starter):
            starter(_simmer_worker, job_id, duration)
        else:
            threading.Thread(
                target=_simmer_worker,
                args=(job_id, duration),
                name=f"mini-quest-simmer-{job_id[:8]}",
                daemon=True,
            ).start()
    except Exception as e:
        # Worker never started: release the slot and settle the job so capacity cannot leak.
        with _jobs_lock:
            failed = _jobs.get(job_id)
            if failed is not None:
                failed["status"] = "error"
                failed["updated_at"] = _now()
                failed["error"] = hq_diagnostics.scrub(str(e), _cb.get("root"), 120) or "démarrage impossible"
            else:
                _jobs.pop(job_id, None)
        try:
            _slots.release()
        except ValueError:
            pass
        raise QuestError("Démarrage de la Mini-Quête impossible", 503, "worker_error") from e

    return {
        "ok": True,
        "quest": "simmer",
        "status": "running",
        "simulated": True,
        "job": _job_public(job),
    }


def _simmer_worker(job_id: str, duration: float) -> None:
    try:
        _sleep(duration)  # cooperative wait — never a spin loop
        _append_log("simmer quest completed – torque warmed (simulated)")
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None:
                job["status"] = "done"
                job["updated_at"] = _now()
                job["result"] = {
                    "message": "simmer done",
                    "simulated": True,
                    "cpu_busy_wait": False,
                }
    except Exception as e:
        with _jobs_lock:
            job = _jobs.get(job_id)
            if job is not None:
                job["status"] = "error"
                job["updated_at"] = _now()
                job["error"] = hq_diagnostics.scrub(str(e), _cb.get("root"), 120) or "erreur"
    finally:
        try:
            _slots.release()
        except ValueError:
            pass


def pulse() -> dict[str, Any]:
    """Synthetic pulse only. Never reads a biological or hardware sensor."""
    beat = 0.85
    _append_log(f"pulse emitted – synthetic beat {beat}")
    return {
        "ok": True,
        "quest": "pulse",
        "status": "done",
        "simulated": True,
        "kind": "synthetic",
        "sensor": False,
        "biological": False,
        "hardware": False,
        "beat": beat,
        "note": "Lecture synthétique de terrain de jeu — pas un capteur.",
    }


def gear_whisper(context: str = "") -> dict[str, Any]:
    """Log one explicit sanitized note. Never called for ambient HTTP traffic."""
    if context is None:
        context = ""
    if not isinstance(context, str):
        raise QuestError("context doit être une chaîne", 400, "validation_error")
    if len(context) > CONTEXT_MAX:
        raise QuestError(f"context trop long (max {CONTEXT_MAX})", 400, "validation_error")
    if _CTRL_RE.search(context):
        # Refuse control / line-injection characters rather than silently rewriting caller intent.
        raise QuestError("context contient des caractères de contrôle", 400, "validation_error")
    note = context.strip() or "generic"
    _append_log(f"gear whisper – {note}")
    return {
        "ok": True,
        "quest": "gear_whisper",
        "status": "done",
        "simulated": True,
        "logged": True,
    }


# ---------------------------------------------------------------- HTTP surface

def _err(exc: QuestError) -> tuple[int, dict[str, Any]]:
    return int(exc.status), {"ok": False, "error": str(exc)[:200], "code": exc.code, "status": "refused" if exc.status in (401, 403, 429) else "error"}


def http_get(path: str, qs: dict | None = None) -> tuple[int, dict[str, Any]]:
    """GET: catalog or job status. No state changes."""
    del qs  # reserved; unused today
    try:
        if path in ("/api/mini-quests", "/api/mini-quests/"):
            return 200, catalog()
        if path.startswith("/api/mini-quests/jobs/"):
            job_id = path[len("/api/mini-quests/jobs/") :]
            if "/" in job_id or not job_id:
                raise QuestError("Route inconnue", 404, "not_found")
            return 200, get_job(job_id)
        raise QuestError("Route inconnue", 404, "not_found")
    except QuestError as e:
        return _err(e)


def http_post(path: str, data: Any) -> tuple[int, dict[str, Any]]:
    """POST: side-effecting quests. Strict JSON object; no shell or hardware."""
    try:
        if not isinstance(data, dict):
            raise QuestError("JSON objet requis", 400, "validation_error")
        unknown = set(data) - {"duration_sec", "context"}
        if unknown:
            raise QuestError("Champs inconnus", 400, "validation_error")

        if path == "/api/mini-quests/simmer":
            duration = data.get("duration_sec", None)
            payload = simmer(duration_sec=duration)
            return 202, payload
        if path == "/api/mini-quests/pulse":
            if "duration_sec" in data or "context" in data:
                raise QuestError("Champs inconnus pour pulse", 400, "validation_error")
            return 200, pulse()
        if path == "/api/mini-quests/whisper":
            if "duration_sec" in data:
                raise QuestError("Champs inconnus pour whisper", 400, "validation_error")
            return 200, gear_whisper(data.get("context", ""))
        if path in ("/api/mini-quests", "/api/mini-quests/"):
            raise QuestError("POST sur une sous-route explicite (simmer|pulse|whisper)", 405, "method_not_allowed")
        raise QuestError("Route inconnue", 404, "not_found")
    except QuestError as e:
        return _err(e)


def source_has_busy_wait() -> bool:
    """True if this module's simmer path still contains a busy-wait pattern (guard for tests)."""
    try:
        text = Path(__file__).read_text(encoding="utf-8")
    except OSError:
        return True
    # Detect the old prototype pattern without matching this docstring/helper name.
    return bool(re.search(r"while\s+time\.time\s*\(\s*\)\s*<\s*end", text))
