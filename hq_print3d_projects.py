"""Versioned, atomic `.hq3d` Studio project persistence and source-integrity verification.

Pure-stdlib module importing only ``hq_state`` (no cycle back to ``hq_print3d``
or ``iphone_bridge``). Projects are stored exclusively inside
``<state_dir>/studio_projects/<id>.hq3d`` using JSON encoding (explicitly typed
and versioned, never mislabeled as 3MF).
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import math
import os
from pathlib import Path
import re
import stat
import threading
import time
import uuid
from typing import Any, Iterator

import hq_state

CURRENT_SCHEMA_VERSION = 1
MAX_PROJECTS = 200
MAX_TITLE_LEN = 80
_PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{2,47}$")
_SHA_RE = re.compile(r"^[0-9a-f]{64}$", re.I)
_WIN_ABS_RE = re.compile(r"^[A-Za-z]:[/\\]")
_POSIX_ABS_RE = re.compile(r"^/(?:Users|home|etc|var|opt|mnt|tmp|root)/")

_FORBIDDEN_KEYS = frozenset({
    "pin", "password", "passwd", "code", "access_code", "check_code",
    "token", "auth_token", "session", "cookie", "csrf", "secret",
    "tls", "cert", "private_key", "webhook", "serial", "ip", "host_path",
})

_FILE_ATTRIBUTE_REPARSE_POINT = 0x0400
_TXN_GUARD = threading.Lock()
_TXN_LOCKS: dict[str, threading.RLock] = {}


class ProjectError(ValueError):
    """Project persistence or validation failure mapped cleanly by Controller."""

    def __init__(self, message: str, status: int = 400, code: str = "project_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _is_link_or_reparse(p: Path) -> bool:
    """Return True if ``p`` is a symlink, Windows junction, or reparse point."""
    try:
        if p.is_symlink():
            return True
    except OSError:
        return True
    is_junc = getattr(p, "is_junction", None)
    if callable(is_junc):
        try:
            if is_junc():
                return True
        except OSError:
            return True
    try:
        st = os.lstat(p)
        if stat.S_ISLNK(st.st_mode):
            return True
        attrs = getattr(st, "st_file_attributes", 0)
        if attrs & _FILE_ATTRIBUTE_REPARSE_POINT:
            return True
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return False


def _projects_dir(state_dir: Path) -> Path:
    root = Path(state_dir)
    if _is_link_or_reparse(root):
        raise ProjectError("Lien symbolique ou jonction refusé pour la racine d'état", 403, "invalid_project_id")
    root_res = root.resolve()
    p = root / "studio_projects"
    if p.exists() or _is_link_or_reparse(p):
        if _is_link_or_reparse(p):
            raise ProjectError("Lien symbolique ou jonction refusé pour studio_projects", 403, "invalid_project_id")
    p.mkdir(parents=True, exist_ok=True)
    if _is_link_or_reparse(p):
        raise ProjectError("Lien symbolique ou jonction refusé pour studio_projects", 403, "invalid_project_id")
    p_res = p.resolve()
    if p_res.parent != root_res:
        raise ProjectError("Répertoire studio_projects hors périmètre d'état", 403, "invalid_project_id")
    return p


def _project_path(state_dir: Path, project_id: str) -> Path:
    pid = str(project_id or "").strip().lower()
    if not _PROJECT_ID_RE.fullmatch(pid):
        raise ProjectError(f"Identifiant de projet invalide : {project_id}", 400, "invalid_project_id")
    pdir = _projects_dir(state_dir)
    base = pdir.resolve()
    target = pdir / f"{pid}.hq3d"
    if _is_link_or_reparse(target):
        raise ProjectError("Lien symbolique ou jonction refusé pour projet Studio", 403, "invalid_project_id")
    target_res = target.resolve(strict=False)
    if target_res.parent != base:
        raise ProjectError("Chemin de projet hors périmètre", 403, "invalid_project_id")
    return target_res


def _thread_lock_for(key: str) -> threading.RLock:
    with _TXN_GUARD:
        lk = _TXN_LOCKS.get(key)
        if lk is None:
            lk = threading.RLock()
            _TXN_LOCKS[key] = lk
        return lk


@contextmanager
def _acquire_lock_file(lock_path: Path) -> Iterator[None]:
    """Acquire an in-process RLock and an OS-level advisory lock on ``lock_path``."""
    if _is_link_or_reparse(lock_path):
        raise ProjectError("Fichier verrou projet invalide", 403, "invalid_project_id")
    th_lock = _thread_lock_for(str(lock_path))
    with th_lock:
        fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
        locked = False
        try:
            if os.name == "nt":
                import msvcrt
                deadline = time.monotonic() + 10.0
                while True:
                    try:
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                        locked = True
                        break
                    except OSError as exc:
                        if time.monotonic() >= deadline:
                            raise ProjectError("Verrou transactionnel projet expiré", 409, "project_conflict") from exc
                        time.sleep(0.01)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX)
                locked = True
            yield
        finally:
            if locked:
                try:
                    if os.name == "nt":
                        import msvcrt
                        os.lseek(fd, 0, os.SEEK_SET)
                        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(fd, fcntl.LOCK_UN)
                except OSError:
                    pass
            try:
                os.close(fd)
            except OSError:
                pass


@contextmanager
def _project_transaction(state_dir: Path, project_id: str = "") -> Iterator[None]:
    """Serialize read-check-write mutations across OS threads and processes.

    Always acquires the directory-level quota/creation lock (``.projects.txn.lock``)
    before any per-project lock (``.<pid>.txn.lock``) in a fixed order so that
    concurrent project creations with distinct explicit IDs cannot bypass
    ``MAX_PROJECTS`` and lock acquisition can never deadlock.
    """
    pdir = _projects_dir(state_dir).resolve()
    global_lock = pdir / ".projects.txn.lock"
    pid = str(project_id or "").strip().lower()
    with _acquire_lock_file(global_lock):
        if pid and _PROJECT_ID_RE.fullmatch(pid):
            per_lock = pdir / f".{pid}.txn.lock"
            with _acquire_lock_file(per_lock):
                yield
        else:
            yield


def _finite_float(val: Any, field: str, *, default: float = 0.0, lo: float | None = None, hi: float | None = None) -> float:
    if val is None or val == "":
        num = float(default)
    elif isinstance(val, bool):
        raise ProjectError(f"Champ numérique invalide : {field}", 422, "invalid_numeric_value")
    else:
        try:
            num = float(val)
        except (TypeError, ValueError) as exc:
            raise ProjectError(f"Champ numérique invalide ({field}) : {val!r}", 422, "invalid_numeric_value") from exc
    if not math.isfinite(num):
        raise ProjectError(f"Valeur numérique non finie refusée ({field})", 422, "invalid_numeric_value")
    if lo is not None and num < lo:
        raise ProjectError(f"Valeur hors limites pour {field} ({num} < {lo})", 422, "invalid_numeric_value")
    if hi is not None and num > hi:
        raise ProjectError(f"Valeur hors limites pour {field} ({num} > {hi})", 422, "invalid_numeric_value")
    return num


def _sanitize_value(obj: Any, *, depth: int = 0) -> Any:
    if depth > 8:
        return None
    if isinstance(obj, dict):
        clean: dict[str, Any] = {}
        for k, v in obj.items():
            ks = str(k)
            low = ks.strip().casefold()
            if low in _FORBIDDEN_KEYS or any(bad in low for bad in ("password", "token", "secret", "access_code", "check_code")):
                continue
            sv = _sanitize_value(v, depth=depth + 1)
            if sv is not None:
                clean[ks] = sv
        return clean
    if isinstance(obj, list):
        return [_sanitize_value(x, depth=depth + 1) for x in obj[:64]]
    if isinstance(obj, str):
        if _WIN_ABS_RE.match(obj) or _POSIX_ABS_RE.match(obj):
            return ""
        return obj[:2000]
    if isinstance(obj, bool) or obj is None:
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        if not math.isfinite(obj):
            raise ProjectError("Valeur flottante non finie (NaN/Infinity) refusée dans le projet Studio", 422, "invalid_numeric_value")
        return obj
    return str(obj)[:500]


def _migrate_project(doc: dict[str, Any]) -> dict[str, Any]:
    raw_ver = doc.get("schema_version")
    if raw_ver is None:
        doc["schema_version"] = 0
        raw_ver = 0
    try:
        ver = int(raw_ver)
    except (TypeError, ValueError):
        raise ProjectError("Version de projet .hq3d illisible", 422, "unsupported_project_version") from None
    if ver < 0 or ver > CURRENT_SCHEMA_VERSION:
        raise ProjectError(
            f"Version de projet .hq3d v{ver} non supportée (max v{CURRENT_SCHEMA_VERSION})",
            422, "unsupported_project_version",
        )
    if ver == 0:
        doc = dict(doc)
        doc["schema_version"] = 1
        doc.setdefault("revision", 1)
    return doc


def _read_project_file(path: Path) -> dict[str, Any]:
    if not path.is_file() or _is_link_or_reparse(path):
        raise ProjectError("Projet introuvable", 404, "not_found")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProjectError("Fichier projet .hq3d corrompu ou illisible", 422, "corrupt_project") from exc
    if not isinstance(raw, dict):
        raise ProjectError("Fichier projet .hq3d corrompu ou illisible", 422, "corrupt_project")
    return _migrate_project(raw)


def _normalize_project_payload(
    payload: dict[str, Any],
    *,
    project_id: str,
    created_at: float,
    revision: int,
) -> dict[str, Any]:
    now = time.time()
    title = str(payload.get("title") or "Projet sans titre").strip()[:MAX_TITLE_LEN] or "Projet sans titre"

    raw_target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    target = {
        "printer_model": str(raw_target.get("printer_model") or payload.get("printer_model") or "").strip()[:60],
        "printer_id": str(raw_target.get("printer_id") or payload.get("printer_id") or "").strip()[:48],
        "nozzle": str(raw_target.get("nozzle") or "0.4").strip()[:12],
        "plate_type": str(raw_target.get("plate_type") or "textured_pei").strip()[:32],
    }
    if isinstance(raw_target.get("bed"), dict):
        target["bed"] = _sanitize_value(raw_target["bed"])

    settings = _sanitize_value(payload.get("settings") if isinstance(payload.get("settings"), dict) else {})
    raw_tools = payload.get("tools") if isinstance(payload.get("tools"), list) else []
    tools: list[dict[str, Any]] = []
    for t in raw_tools[:16]:
        if isinstance(t, dict):
            tools.append({
                "slot_label": str(t.get("slot_label") or "")[:24],
                "material": str(t.get("material") or "PLA")[:32],
                "color": str(t.get("color") or "#38BDF8")[:16],
                "preset": str(t.get("preset") or "")[:120],
                "station_slot": t.get("station_slot"),
                "spool_id": str(t.get("spool_id") or "")[:48],
            })

    raw_items = payload.get("items") if isinstance(payload.get("items"), list) else []
    if len(raw_items) > 16:
        raise ProjectError("Maximum 16 objets par projet Studio", 422, "too_many_items")
    items: list[dict[str, Any]] = []
    for idx, it in enumerate(raw_items):
        if not isinstance(it, dict):
            continue
        mid = str(it.get("model_id") or "").strip()[:64]
        if not mid:
            continue
        raw_sha = it.get("source_sha256")
        if raw_sha in (None, ""):
            raw_sha = it.get("sourceVersion")
        sha_str = str(raw_sha or "").strip().lower()
        if sha_str and not _SHA_RE.fullmatch(sha_str):
            raise ProjectError(
                f"Empreinte source_sha256 invalide pour l'objet '{mid}' (64 caractères hexadécimaux requis)",
                422, "invalid_source_sha256",
            )
        tool_val = int(_finite_float(it.get("tool"), "tool", default=0.0, lo=0.0, hi=15.0))
        row: dict[str, Any] = {
            "uid": it.get("uid", idx + 1),
            "model_id": mid,
            "model_name": str(it.get("model_name") or it.get("name") or "")[:160],
            "model_rel": str(it.get("model_rel") or "")[:240],
            "local_name": str(it.get("local_name") or it.get("localName") or it.get("name") or "")[:64],
            "ext": str(it.get("ext") or "stl").lower()[:16],
            "source_sha256": sha_str,
            "x": _finite_float(it.get("x"), "x", default=0.0, lo=-2000.0, hi=2000.0),
            "y": _finite_float(it.get("y"), "y", default=0.0, lo=-2000.0, hi=2000.0),
            "z": _finite_float(it.get("z"), "z", default=0.0, lo=-2000.0, hi=2000.0),
            "rot_x": _finite_float(it.get("rot_x"), "rot_x", default=0.0, lo=-3600.0, hi=3600.0),
            "rot_y": _finite_float(it.get("rot_y"), "rot_y", default=0.0, lo=-3600.0, hi=3600.0),
            "rot_z": _finite_float(it.get("rot_z"), "rot_z", default=0.0, lo=-3600.0, hi=3600.0),
            "scale": _finite_float(
                it.get("scale") if it.get("scale") is not None else 1.0,
                "scale", default=1.0, lo=0.05, hi=100.0,
            ),
            "tool": tool_val,
            "visible": it.get("visible") is not False,
            "overrides": _sanitize_value(it.get("overrides") if isinstance(it.get("overrides"), dict) else {}),
        }
        if isinstance(it.get("custom_meta"), dict):
            row["custom_meta"] = _sanitize_value(it["custom_meta"])
        items.append(row)

    cam = _sanitize_value(payload.get("camera")) if isinstance(payload.get("camera"), dict) else None
    slice_ref = _sanitize_value(payload.get("slice_ref")) if isinstance(payload.get("slice_ref"), dict) else None
    extra = _sanitize_value(payload.get("extra")) if isinstance(payload.get("extra"), dict) else {}

    doc: dict[str, Any] = {
        "schema_version": CURRENT_SCHEMA_VERSION,
        "format": "atelier3d.hq3d",
        "id": project_id,
        "title": title,
        "revision": revision,
        "created_at": created_at,
        "updated_at": now,
        "target": target,
        "settings": settings,
        "tools": tools,
        "items": items,
    }
    if isinstance(payload.get("prime_tower"), dict):
        doc["prime_tower"] = _sanitize_value(payload["prime_tower"])
    if cam:
        doc["camera"] = cam
    if slice_ref:
        doc["slice_ref"] = slice_ref
    if extra:
        doc["extra"] = extra
    # Secondary fail-closed standards-compliant JSON barrier (allow_nan=False)
    try:
        json.dumps(doc, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ProjectError("Sérialisation JSON stricte refusée (valeur non finie détectée)", 422, "invalid_numeric_value") from exc
    return doc


def list_projects(state_dir: Path, *, limit: int = 100) -> list[dict[str, Any]]:
    pdir = _projects_dir(state_dir)
    rows: list[dict[str, Any]] = []
    for p in pdir.glob("*.hq3d"):
        if _is_link_or_reparse(p):
            continue
        try:
            doc = _read_project_file(p)
        except ProjectError:
            continue
        target = doc.get("target") or {}
        rows.append({
            "id": doc.get("id") or p.stem,
            "title": doc.get("title") or p.stem,
            "schema_version": int(doc.get("schema_version") or CURRENT_SCHEMA_VERSION),
            "revision": int(doc.get("revision") or 1),
            "printer_model": str(target.get("printer_model") or ""),
            "nozzle": str(target.get("nozzle") or "0.4"),
            "item_count": len(doc.get("items") or []),
            "created_at": float(doc.get("created_at") or 0),
            "updated_at": float(doc.get("updated_at") or 0),
        })
    rows.sort(key=lambda r: (-r["updated_at"], r["title"].casefold()))
    return rows[: max(1, min(limit, MAX_PROJECTS))]


def save_project(state_dir: Path, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ProjectError("Charge utile projet invalide", 400, "invalid_payload")
    raw_force = payload.get("force_overwrite")
    if raw_force is not None and not isinstance(raw_force, bool):
        raise ProjectError("force_overwrite doit être un booléen JSON strict (true/false)", 400, "invalid_payload")
    force_ov = (raw_force is True)
    exp_rev = payload.get("expected_revision")
    exp_rev_int: int | None = None
    if exp_rev is not None:
        if isinstance(exp_rev, bool):
            raise ProjectError("expected_revision invalide", 400, "invalid_payload")
        try:
            exp_rev_int = int(exp_rev)
        except (TypeError, ValueError) as exc:
            raise ProjectError("expected_revision invalide", 400, "invalid_payload") from exc
        if exp_rev_int < 0:
            raise ProjectError("expected_revision invalide", 400, "invalid_payload")

    raw_id = str(payload.get("id") or "").strip().lower()
    if not raw_id:
        if exp_rev_int not in (None, 0) and not force_ov:
            raise ProjectError("expected_revision non nul interdit lors de la création d'un nouveau projet", 409, "project_conflict")
        raw_id = "prj_" + uuid.uuid4().hex[:12]
        is_new = True
    else:
        is_new = False
    path = _project_path(state_dir, raw_id)
    with _project_transaction(state_dir, raw_id):
        now = time.time()
        if path.exists():
            existing = _read_project_file(path)
            cur_rev = int(existing.get("revision") or 1)
            if exp_rev_int is None and not force_ov:
                raise ProjectError(
                    f"expected_revision requis pour mettre à jour le projet '{existing.get('title')}' (révision actuelle {cur_rev})",
                    409, "project_conflict",
                )
            if exp_rev_int is not None and exp_rev_int != cur_rev:
                raise ProjectError(
                    f"Conflit d'édition sur '{existing.get('title')}' (révision serveur {cur_rev} != {exp_rev_int})",
                    409, "project_conflict",
                )
            created_at = float(existing.get("created_at") or now)
            next_rev = cur_rev + 1
        else:
            # Target file does not exist: refuse stale updates against a deleted project (exp_rev >= 1)
            if exp_rev_int not in (None, 0) and not force_ov:
                raise ProjectError(
                    f"Conflit d'édition : le projet '{raw_id}' a été supprimé (révision attendue {exp_rev_int})",
                    409, "project_conflict",
                )
            # Enforce MAX_PROJECTS quota across ALL new project creations (auto-ID or explicit ID)
            existing_count = sum(1 for p in _projects_dir(state_dir).glob("*.hq3d") if not _is_link_or_reparse(p))
            if existing_count >= MAX_PROJECTS:
                raise ProjectError(f"Limite de {MAX_PROJECTS} projets Studio atteinte", 422, "too_many_projects")
            created_at = now
            next_rev = 1
        doc = _normalize_project_payload(payload, project_id=raw_id, created_at=created_at, revision=next_rev)
        hq_state.write_json_atomic(path, doc)
        return doc


def open_project(state_dir: Path, project_id: str, library: Any = None) -> dict[str, Any]:
    path = _project_path(state_dir, project_id)
    doc = _read_project_file(path)

    # Verify source model existence and SHA-256 identity per item
    lib_rows = library.scan() if library is not None else []
    by_id = {r["id"]: r for r in lib_rows if isinstance(r, dict) and r.get("id")}
    by_rel = {r.get("rel"): r for r in lib_rows if isinstance(r, dict) and r.get("rel")}
    missing_count = 0
    replaced_count = 0
    unverifiable_count = 0

    for it in doc.get("items") or []:
        mid = str(it.get("model_id") or "")
        saved_sha = str(it.get("source_sha256") or "").strip().lower()
        found_row = by_id.get(mid) or (by_rel.get(it.get("model_rel")) if it.get("model_rel") else None)
        if not found_row or library is None:
            it["source_status"] = "missing"
            missing_count += 1
            continue
        try:
            detail = library.get(found_row["id"])
        except Exception:
            it["source_status"] = "missing"
            missing_count += 1
            continue
        cur_sha = str(detail.get("source_sha256") or "").strip().lower()
        it["resolved_model_id"] = detail.get("id")
        it["current_sha256"] = cur_sha
        it["current_bounds_mm"] = detail.get("bounds_mm")
        if not saved_sha or not _SHA_RE.fullmatch(saved_sha) or not cur_sha or not _SHA_RE.fullmatch(cur_sha):
            it["source_status"] = "unverifiable"
            unverifiable_count += 1
        elif cur_sha != saved_sha:
            it["source_status"] = "replaced"
            replaced_count += 1
        else:
            it["source_status"] = "ok"

    # Never report a reopened project as print-ready unless sliced artifact & provenance match cleanly
    slice_ref = doc.get("slice_ref") if isinstance(doc.get("slice_ref"), dict) else {}
    slice_valid = False
    slice_reason = "not_sliced"
    if slice_ref.get("sliced_model_id") and library is not None:
        if missing_count or replaced_count or unverifiable_count:
            slice_reason = "source_unverifiable" if unverifiable_count and not (missing_count or replaced_count) else "source_changed"
        else:
            smid = str(slice_ref["sliced_model_id"])
            exp_slice_sha = str(slice_ref.get("slice_sha256") or "").strip().lower()
            try:
                prov = library.get_slice_provenance(smid)
                actual_path = library.resolve(smid)
                import hq_print3d_models as _m
                actual_slice_sha = _m.file_sha256(actual_path).lower()
                if prov and str(prov.get("slice_sha256") or "").lower() == actual_slice_sha and (
                    not exp_slice_sha or exp_slice_sha == actual_slice_sha
                ):
                    slice_valid = True
                    slice_reason = "verified"
                else:
                    slice_reason = "provenance_mismatch"
            except Exception:
                slice_reason = "sliced_artifact_missing"

    return {
        "ok": True,
        "project": doc,
        "integrity": {
            "missing_count": missing_count,
            "replaced_count": replaced_count,
            "unverifiable_count": unverifiable_count,
            "slice_valid": slice_valid,
            "slice_reason": slice_reason,
        },
    }


def duplicate_project(state_dir: Path, project_id: str, new_title: str = "") -> dict[str, Any]:
    path = _project_path(state_dir, project_id)
    with _project_transaction(state_dir, project_id):
        doc = _read_project_file(path)
    title = str(new_title or "").strip() or f"{doc.get('title') or 'Projet'} (copie)"
    clone = dict(doc)
    clone.pop("id", None)
    clone.pop("expected_revision", None)
    clone["title"] = title[:MAX_TITLE_LEN]
    return save_project(state_dir, clone)


def rename_project(
    state_dir: Path,
    project_id: str,
    new_title: str,
    expected_revision: int | None = None,
    *,
    force_overwrite: Any = False,
) -> dict[str, Any]:
    if force_overwrite is not None and not isinstance(force_overwrite, bool):
        raise ProjectError("force_overwrite doit être un booléen JSON strict (true/false)", 400, "invalid_payload")
    force_ov = (force_overwrite is True)
    title = str(new_title or "").strip()[:MAX_TITLE_LEN]
    if not title:
        raise ProjectError("Titre du projet requis", 400, "invalid_title")
    path = _project_path(state_dir, project_id)
    with _project_transaction(state_dir, project_id):
        doc = _read_project_file(path)
        cur_rev = int(doc.get("revision") or 1)
        if expected_revision is None and not force_ov:
            raise ProjectError(
                f"expected_revision requis lors du renommage (révision actuelle {cur_rev})",
                409, "project_conflict",
            )
        if expected_revision is not None and int(expected_revision) != cur_rev:
            raise ProjectError(
                f"Conflit d'édition lors du renommage (révision {cur_rev} != {expected_revision})",
                409, "project_conflict",
            )
        doc["title"] = title
        doc["revision"] = cur_rev + 1
        doc["updated_at"] = time.time()
        hq_state.write_json_atomic(path, doc)
        return doc


def delete_project(
    state_dir: Path,
    project_id: str,
    expected_revision: int | None = None,
    *,
    force_overwrite: Any = False,
) -> bool:
    if force_overwrite is not None and not isinstance(force_overwrite, bool):
        raise ProjectError("force_overwrite doit être un booléen JSON strict (true/false)", 400, "invalid_payload")
    force_ov = (force_overwrite is True)
    path = _project_path(state_dir, project_id)
    with _project_transaction(state_dir, project_id):
        if not path.is_file():
            return False
        try:
            doc = _read_project_file(path)
            cur_rev = int(doc.get("revision") or 1)
        except ProjectError:
            cur_rev = 1
        if expected_revision is None and not force_ov:
            raise ProjectError(
                f"expected_revision requis lors de la suppression (révision actuelle {cur_rev})",
                409, "project_conflict",
            )
        if expected_revision is not None and int(expected_revision) != cur_rev:
            raise ProjectError(
                f"Conflit de révision lors de la suppression (révision serveur {cur_rev} != {expected_revision})",
                409, "project_conflict",
            )
        os.unlink(path)
        return True
