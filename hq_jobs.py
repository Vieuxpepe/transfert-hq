"""Job queue for Transfert HQ companions.

State file: hq_agent_jobs.json (gitignored).
A malformed file is kept and never overwritten. ``confirm`` does not approve.
"""

from __future__ import annotations

import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

import hq_agent_ops as ops
import hq_agent_protocol as proto
import hq_state

JOBS_NAME = "hq_agent_jobs.json"
MAX_JOBS = 400
TERMINAL = frozenset({"succeeded", "failed", "cancelled", "expired", "rejected"})

_lock = threading.RLock()
_root: Path | None = None
_jobs: list[dict] = []
_malformed = False
_now: Callable[[], float] = time.time
_journal: Callable[..., None] | None = None
def bind(root: Path | str, *, journal: Callable[..., None] | None = None, now: Callable[[], float] | None = None) -> None:
    global _root, _journal, _now
    _root = Path(root)
    _root.mkdir(parents=True, exist_ok=True)
    _journal = journal
    _now = now or time.time
    _load()


def bound() -> bool:
    return _root is not None


def malformed() -> bool:
    return _malformed


def _path() -> Path:
    if _root is None:
        raise RuntimeError("hq_jobs non initialisé")
    return _root / JOBS_NAME


def _clock() -> float:
    return float(_now())


def _require_writable() -> None:
    if _root is None:
        raise RuntimeError("hq_jobs non initialisé")
    if _malformed:
        raise RuntimeError("hq_agent_jobs.json illisible — fichier conservé")


def _load() -> None:
    global _jobs, _malformed
    path = _path()
    if not path.is_file():
        with _lock:
            _jobs = []
            _malformed = False
        return
    try:
        import json

        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        with _lock:
            _jobs = []
            _malformed = True
        return
    rows = raw.get("jobs") if isinstance(raw, dict) else None
    if not isinstance(rows, list):
        with _lock:
            _jobs = []
            _malformed = True
        return
    cleaned = [row for row in rows if isinstance(row, dict) and row.get("id")][:MAX_JOBS]
    with _lock:
        _jobs = cleaned
        _malformed = False


def _persist() -> None:
    global _malformed
    _require_writable()
    payload = {"version": 1, "jobs": _jobs[:MAX_JOBS]}
    try:
        hq_state.write_json_atomic(_path(), payload)
    except RuntimeError:
        _malformed = True
        raise


def _audit(kind: str, message: str, meta: dict | None = None) -> None:
    if _journal is None:
        return
    try:
        _journal(kind, message, level="info", source="agent", meta=meta or {})
    except Exception:
        return


def _public(job: dict, *, full: bool = True) -> dict:
    out = {
        "id": job.get("id"),
        "device_id": job.get("device_id"),
        "op": job.get("op"),
        "risk": job.get("risk"),
        "origin": job.get("origin"),
        "state": job.get("state"),
        "approved": bool(job.get("approved")),
        "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at"),
        "expires_at": job.get("expires_at"),
        "timeout_sec": job.get("timeout_sec"),
        "error": job.get("error") or "",
        "summary": (job.get("summary") or "")[:240],
    }
    if full:
        out["args"] = job.get("args") or {}
        output = job.get("output") or ""
        out["output"] = output[: proto.OUTPUT_MAX]
        out["output_truncated"] = bool(job.get("output_truncated"))
        artifact = job.get("artifact")
        if isinstance(artifact, dict):
            out["artifact"] = {
                "rel": str(artifact.get("rel") or "")[:240],
                "name": str(artifact.get("name") or "")[:80],
                "size": int(artifact.get("size") or 0),
                "sha256": str(artifact.get("sha256") or "")[:64],
            }
    return out


def _dispatch_view(job: dict) -> dict:
    return {
        "id": job["id"],
        "op": job["op"],
        "args": job.get("args") or {},
        "risk": job["risk"],
        "timeout_sec": job.get("timeout_sec") or 20,
        "expires_at": job.get("expires_at"),
        "approved": job.get("approved") is True,
    }


def _find(job_id: str) -> dict | None:
    for job in _jobs:
        if job.get("id") == job_id:
            return job
    return None


def sweep() -> int:
    """Expire queued and abandoned work. Returns how many rows changed."""
    if _malformed or _root is None:
        return 0
    now = _clock()
    changed = 0
    with _lock:
        for job in _jobs:
            state = job.get("state")
            if state in TERMINAL:
                continue
            try:
                expires = float(job.get("expires_at") or 0)
            except (TypeError, ValueError):
                expires = 0
            if expires and now > expires and state in ("queued", "awaiting_approval", "dispatched"):
                job["state"] = "expired" if state != "dispatched" else "failed"
                if state == "dispatched":
                    job["error"] = "délai dépassé"
                job["updated_at"] = now
                changed += 1
        if changed:
            _persist()
    return changed


def create_job(
    *,
    device_id: str,
    op: str,
    args: dict | None,
    origin: str,
    ttl_sec: int | None = None,
    timeout_sec: int | None = None,
    granted: list[str] | None = None,
    confirm: Any = None,
) -> dict:
    """Queue a job. ``confirm`` is ignored and never approves destructive work."""
    del confirm  # not an approval channel
    _require_writable()
    if not proto.DEVICE_ID_RE.fullmatch(str(device_id or "")):
        raise ops.AgentOpError("appareil invalide")
    spec = ops.get_op(op)
    clean_args = ops.validate_args(spec.name, args)
    if granted is not None and spec.capability not in granted:
        raise ops.AgentOpError("capacité refusée")
    if ops.needs_approval(origin, spec.risk):
        state = "awaiting_approval"
        approved = False
    else:
        state = "queued"
        approved = True
    now = _clock()
    ttl = ops.clamp_ttl(spec.risk, ttl_sec)
    timeout = ops.clamp_timeout(spec.risk, timeout_sec)
    with _lock:
        job_id = "job_" + secrets.token_hex(8)
        job = {
            "id": job_id,
            "device_id": device_id,
            "op": spec.name,
            "args": clean_args,
            "risk": spec.risk,
            "capability": spec.capability,
            "origin": origin,
            "state": state,
            "approved": approved,
            "created_at": now,
            "updated_at": now,
            "expires_at": now + ttl,
            "timeout_sec": timeout,
            "summary": "",
            "output": "",
            "output_truncated": False,
            "error": "",
            "artifact": None,
        }
        _jobs.insert(0, job)
        try:
            _trim_locked()
            _persist()
        except Exception:
            if job in _jobs:
                _jobs.remove(job)
            raise
    _audit("agent_job", f"{spec.name} · {state}", {"job": job_id, "op": spec.name, "device": device_id, "state": state, "risk": spec.risk})
    return _public(job)


def _trim_locked() -> None:
    if len(_jobs) <= MAX_JOBS:
        return
    terminal = [job for job in _jobs if job.get("state") in TERMINAL]
    while len(_jobs) > MAX_JOBS and terminal:
        victim = terminal.pop()
        _jobs.remove(victim)
    if len(_jobs) > MAX_JOBS:
        raise ops.AgentOpError("file d'attente pleine")


def approve(job_id: str, *, actor: str) -> dict:
    if actor != "human":
        raise PermissionError("le planificateur ne peut pas approuver")
    _require_writable()
    now = _clock()
    with _lock:
        job = _find(str(job_id or ""))
        if job is None:
            raise ops.AgentOpError("travail introuvable")
        if job.get("state") != "awaiting_approval":
            raise ops.AgentOpError("travail non approuvable")
        if float(job.get("expires_at") or 0) < now:
            job["state"] = "expired"
            job["updated_at"] = now
            _persist()
            raise ops.AgentOpError("travail expiré")
        job["approved"] = True
        job["state"] = "queued"
        job["approved_by"] = "human"
        job["approved_at"] = now
        job["updated_at"] = now
        _persist()
        snapshot = _public(job)
    _audit("agent_approve", f"{snapshot['op']} approuvé", {"job": snapshot["id"], "op": snapshot["op"], "device": snapshot["device_id"], "state": "queued"})
    return snapshot


def reject(job_id: str, *, actor: str) -> dict:
    if actor != "human":
        raise PermissionError("le planificateur ne peut pas refuser")
    return _close(job_id, state="rejected", actor=actor)


def cancel(job_id: str, *, actor: str) -> dict:
    if actor not in ops.ORIGINS:
        raise PermissionError("origine invalide")
    return _close(job_id, state="cancelled", actor=actor)


def _close(job_id: str, *, state: str, actor: str) -> dict:
    _require_writable()
    now = _clock()
    with _lock:
        job = _find(str(job_id or ""))
        if job is None:
            raise ops.AgentOpError("travail introuvable")
        if job.get("state") in TERMINAL:
            raise ops.AgentOpError("travail déjà terminé")
        if state == "rejected" and job.get("state") != "awaiting_approval":
            raise ops.AgentOpError("travail non refusable")
        job["state"] = state
        job["updated_at"] = now
        job["closed_by"] = actor
        _persist()
        snapshot = _public(job)
    _audit("agent_job", f"{snapshot['op']} · {state}", {"job": snapshot["id"], "op": snapshot["op"], "device": snapshot["device_id"], "state": state})
    return snapshot


def take_next(device_id: str) -> dict | None:
    """Mark the oldest queued job for this device as dispatched."""
    _require_writable()
    sweep()
    now = _clock()
    with _lock:
        chosen = None
        for job in reversed(_jobs):
            if job.get("device_id") != device_id:
                continue
            if job.get("state") != "queued":
                continue
            if job.get("approved") is not True:
                continue
            if float(job.get("expires_at") or 0) < now:
                continue
            chosen = job
            break
        if chosen is None:
            return None
        chosen["state"] = "dispatched"
        chosen["dispatched_at"] = now
        chosen["updated_at"] = now
        _persist()
        return _dispatch_view(chosen)


def complete(
    device_id: str,
    job_id: str,
    *,
    ok: bool,
    summary: str = "",
    output: str = "",
    error: str = "",
) -> dict:
    _require_writable()
    if not proto.JOB_ID_RE.fullmatch(str(job_id or "")):
        raise ops.AgentOpError("travail introuvable")
    now = _clock()
    text = output if isinstance(output, str) else str(output or "")
    truncated = len(text) > proto.OUTPUT_MAX
    if truncated:
        text = text[: proto.OUTPUT_MAX]
    with _lock:
        job = _find(job_id)
        if job is None or job.get("device_id") != device_id:
            raise ops.AgentOpError("travail introuvable")
        if job.get("state") != "dispatched":
            raise ops.AgentOpError("travail non actif")
        job["state"] = "succeeded" if ok else "failed"
        job["summary"] = str(summary or "")[:240]
        job["output"] = text
        job["output_truncated"] = truncated
        job["error"] = str(error or "")[:300]
        job["updated_at"] = now
        _persist()
        snapshot = _public(job)
    _audit(
        "agent_result",
        f"{snapshot['op']} · {snapshot['state']}",
        {"job": snapshot["id"], "op": snapshot["op"], "device": device_id, "state": snapshot["state"], "ok": bool(ok)},
    )
    return snapshot


def attach_artifact(device_id: str, job_id: str, meta: dict) -> dict:
    """Record artifact metadata only. Bytes never enter the job JSON."""
    _require_writable()
    with _lock:
        job = _find(job_id)
        if job is None or job.get("device_id") != device_id:
            raise ops.AgentOpError("travail introuvable")
        if job.get("state") != "dispatched":
            raise ops.AgentOpError("travail non actif")
        job["artifact"] = {
            "rel": str(meta.get("rel") or "")[:240],
            "name": str(meta.get("name") or "")[:80],
            "size": int(meta.get("size") or 0),
            "sha256": str(meta.get("sha256") or "")[:64],
        }
        job["updated_at"] = _clock()
        _persist()
        return _public(job)


def list_jobs(*, device_id: str | None = None, state: str | None = None, limit: int = 50, offset: int = 0) -> dict:
    sweep()
    device_f = (device_id or "").strip()
    state_f = (state or "").strip()
    with _lock:
        rows = list(_jobs)
        bad = _malformed
    out = []
    for job in rows:
        if device_f and job.get("device_id") != device_f:
            continue
        if state_f and job.get("state") != state_f:
            continue
        out.append(_public(job))
    offset = max(0, int(offset or 0))
    limit = max(0, min(200, int(limit or 0)))
    return {
        "ok": not bad,
        "malformed": bad,
        "total": len(out),
        "jobs": out[offset : offset + limit] if limit else [],
    }


def cancel_device(device_id: str, *, actor: str = "human") -> int:
    """Cancel every non-terminal job for a device. Used when a companion is revoked."""
    if actor not in ops.ORIGINS:
        raise PermissionError("origine invalide")
    _require_writable()
    now = _clock()
    changed = 0
    with _lock:
        for job in _jobs:
            if job.get("device_id") != device_id or job.get("state") in TERMINAL:
                continue
            job["state"] = "cancelled"
            job["updated_at"] = now
            job["closed_by"] = actor
            changed += 1
        if changed:
            _persist()
    return changed


def pending_count() -> int:
    if _malformed or _root is None:
        return 0
    with _lock:
        return sum(1 for job in _jobs if job.get("state") == "awaiting_approval")


def get_job(job_id: str) -> dict | None:
    with _lock:
        job = _find(str(job_id or ""))
        return _public(job) if job else None
