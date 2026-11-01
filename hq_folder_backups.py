"""Transfert HQ — automatic folder backups with a rolling window. Stdlib only.

A job watches one folder (a root like Uni, or any folder inside Inbox/Uni/Print) and copies it every hour, day or
week to ``<backup_dir>/Dossiers/<name> (<id>)/<AAAAMMJJ_HHMMSS>/<name>/``. Only the newest ``keep`` copies (10 by
default) are kept: after each new copy, the older copies of THAT job are deleted, and nothing else ever is. A folder is
deleted only if its name is a stamp, it sits directly in the job's folder, it holds this job's marker and it contains no
link or junction.

A copy is skipped when nothing changed since the last one (same files, sizes and dates), so the ten copies are ten
different states of the folder rather than ten identical ones. Files that cannot be read (open in another program) are
listed and skipped; the copy still happens. Copies are written to ``<stamp>.partial`` and renamed when complete, so a
crash never leaves a half copy that counts.

Restoring never overwrites: the copy comes back next to the folder as « <name> (sauvegarde du 31 oct. 16 h 49) ».

Jobs live in ``<ROOT>/.hq-backups/jobs.json`` (never rewritten when unreadable). Automatic runs obey
``backup_auto_paused``; « Sauvegarder maintenant » always runs. Work happens on one background thread.
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import secrets
import shutil
import stat as statmod
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Any

STORE_DIR = ".hq-backups"
JOBS = "jobs.json"
SUBDIR = "Dossiers"
MARKER = ".hq-backup.json"
EVERY = {"hour": 3600, "day": 86400, "week": 7 * 86400}
KEEP_DEFAULT = 10
KEEP_MAX = 50
JOBS_MAX = 40
RETRY_SEC = 3600
SPARE_BYTES = 64 * 1024 * 1024
SKIPPED_SHOWN = 20
ID_RE = re.compile(r"^bk-[0-9a-f]{8}\Z")
STAMP_RE = re.compile(r"^\d{8}_\d{6}\Z")
PARTIAL_RE = re.compile(r"^\d{8}_\d{6}\.partial\Z")
BAD_LABEL = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]

_cb: dict[str, Any] = {}
_lock = threading.RLock()
_queue: "queue.Queue[tuple]" = queue.Queue()
_queued: set[str] = set()
_running: dict[str, dict] = {}
_worker: threading.Thread | None = None


class BackupError(ValueError):
    def __init__(self, msg: str, status: int = 400, code: str = "validation_error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    """``root``; ``parse_rel(rel) -> list|None``; ``resolve_dir(rel) -> Path|None`` (an existing folder under a root);
    ``resolve_writable_dir(rel, create)``; ``unique_in_dir(dir, name) -> Path``; ``target() -> {ok, dir, error}``;
    ``paused() -> bool``; ``remove_folder(path) -> None|reason``; optional ``is_link_stat``, ``system_names``,
    ``log(kind, message, level)``, ``alert(title, detail)``, ``now``; ``sync=True`` runs work inline (tests)."""
    _cb.update(kwargs)


# ---------------------------------------------------------------- small helpers

def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise BackupError("Sauvegardes non initialisées", 503, "storage_error")
    return Path(os.path.abspath(os.fspath(root)))


def _is_link_stat(st: os.stat_result) -> bool:
    fn = _cb.get("is_link_stat")
    if callable(fn):
        return bool(fn(st))
    return statmod.S_ISLNK(st.st_mode) or bool(getattr(st, "st_file_attributes", 0) & 0x400)


def _is_link(path: Path | str) -> bool:
    try:
        return _is_link_stat(os.lstat(path))
    except OSError:
        return False


def _log(message: str, level: str = "info") -> None:
    fn = _cb.get("log")
    if callable(fn):
        try:
            fn("backup", message, level)
        except Exception:
            pass


def _alert(title: str, detail: str) -> None:
    fn = _cb.get("alert")
    if callable(fn):
        try:
            fn(title, detail)
        except Exception:
            pass


def label_for(name: str) -> str:
    """A folder name safe on any drive (the job folder in the backup drive)."""
    s = BAD_LABEL.sub("_", str(name or "")).strip().strip(".")
    return (s or "Dossier")[:60]


def stamp_label(stamp: str) -> str:
    """20261031_164900 -> « 31 oct. 2026 16 h 49 »."""
    try:
        d = datetime.strptime(stamp, "%Y%m%d_%H%M%S")
    except ValueError:
        return stamp
    return f"{d.day} {MONTHS[d.month - 1]} {d.year} {d.hour} h {d.minute:02d}"


def due(job: dict, now: float) -> bool:
    """An enabled job is due once its interval has passed since its last run (a copy or « rien n'a changé »); after a
    failure it retries at most every hour."""
    if not job.get("enabled", True):
        return False
    every = EVERY.get(job.get("every"), EVERY["day"])
    last_run = float(job.get("last_run_at") or 0)
    last_try = float(job.get("last_try_at") or 0)
    return now - last_run >= every and now - last_try >= min(every, RETRY_SEC)


# ---------------------------------------------------------------- jobs store

def _store(create: bool = False) -> Path:
    base = _root() / STORE_DIR
    if os.path.lexists(base):
        if _is_link(base) or not base.is_dir():
            raise BackupError("Dossier des sauvegardes redirigé — refusé", 503, "storage_error")
    elif create:
        base.mkdir(parents=True, exist_ok=True)
    return base


def _load() -> list[dict]:
    path = _store() / JOBS
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise BackupError("jobs.json illisible — conservé", 503, "storage_error") from e
    jobs = data.get("jobs") if isinstance(data, dict) else None
    if not isinstance(jobs, list):
        raise BackupError("jobs.json illisible — conservé", 503, "storage_error")
    return [j for j in jobs if isinstance(j, dict) and isinstance(j.get("id"), str) and ID_RE.match(j["id"]) and isinstance(j.get("rel"), str)]


def _save(jobs: list[dict]) -> None:
    base = _store(create=True)
    tmp = base / (JOBS + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "jobs": jobs}, f, ensure_ascii=False, indent=1)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, base / JOBS)


def _find(jobs: list[dict], jid: Any) -> dict:
    if not isinstance(jid, str) or not ID_RE.match(jid):
        raise BackupError("Sauvegarde invalide")
    for j in jobs:
        if j["id"] == jid:
            return j
    raise BackupError("Sauvegarde introuvable", 404, "not_found")


def _update(jid: str, **fields: Any) -> dict | None:
    with _lock:
        jobs = _load()
        for j in jobs:
            if j["id"] == jid:
                j.update(fields)
                _save(jobs)
                return j
    return None


# ---------------------------------------------------------------- the backup drive

def _target_base(create: bool = False) -> Path:
    """``<backup_dir>/Dossiers`` — refused when the drive is missing or the folder is a link."""
    fn = _cb.get("target")
    t = fn() if callable(fn) else {"ok": False, "error": "backup_dir non configuré"}
    if not t.get("ok"):
        raise BackupError(t.get("error") or "Destination des sauvegardes indisponible", 503, "target_unavailable")
    raw = Path(str(t["dir"]))
    if not raw.is_absolute():
        raise BackupError("backup_dir doit être un chemin absolu", 503, "target_unavailable")
    base = raw / SUBDIR
    for p in (raw, base):
        if os.path.lexists(p) and (_is_link(p) or not os.path.isdir(p)):
            raise BackupError(f"{p} est un lien ou n'est pas un dossier — refusé", 503, "target_unavailable")
    if create:
        base.mkdir(parents=True, exist_ok=True)
    return base


def _job_dir(job: dict, create: bool = False) -> Path:
    base = _target_base(create)
    d = base / job["dir"]
    if os.path.lexists(d) and (_is_link(d) or not os.path.isdir(d)):
        raise BackupError(f"{d} est un lien — refusé", 503, "target_unavailable")
    if create:
        d.mkdir(exist_ok=True)
    return d


def _marker(folder: Path) -> dict | None:
    m = folder / MARKER
    try:
        st = os.lstat(m)
        if _is_link_stat(st) or not statmod.S_ISREG(st.st_mode) or st.st_size > 65536:
            return None
        data = json.loads(m.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def snapshots(job: dict) -> list[dict]:
    """This job's complete copies, newest first. A folder counts only with a stamp name, no link, and our marker."""
    try:
        d = _job_dir(job)
    except BackupError:
        return []
    if not d.is_dir():
        return []
    out = []
    try:
        entries = list(os.scandir(d))
    except OSError:
        return []
    for e in entries:
        if not STAMP_RE.match(e.name):
            continue
        try:
            st = os.lstat(e.path)
        except OSError:
            continue
        if _is_link_stat(st) or not statmod.S_ISDIR(st.st_mode):
            continue
        m = _marker(Path(e.path))
        if not m or m.get("job") != job["id"] or m.get("id") != e.name:
            continue
        out.append({"id": e.name, "label": stamp_label(e.name), "at": m.get("at"), "files": m.get("files", 0), "bytes": m.get("bytes", 0),
                    "skipped": m.get("skipped", 0), "name": m.get("name") or ""})
    out.sort(key=lambda s: s["id"], reverse=True)
    return out


# ---------------------------------------------------------------- copying

def _skip_name(name: str) -> bool:
    low = name.lower()
    hidden = {n.lower() for n in (_cb.get("system_names") or ())}
    return low.startswith(".hq-") or low in hidden or low.endswith(".tmp") or low == ".tmp"


def scan(src: Path) -> tuple[list[tuple[str, str, int, int]], str]:
    """[(kind, relpath, size, mtime_ns)] (kind "d" or "f"), links and junctions skipped; plus a signature."""
    items: list[tuple[str, str, int, int]] = []
    stack = [("", str(src))]
    while stack:
        rel, path = stack.pop()
        try:
            entries = list(os.scandir(path))
        except OSError:
            continue
        for e in entries:
            if _skip_name(e.name):
                continue
            try:
                st = os.lstat(e.path)
            except OSError:
                continue
            if _is_link_stat(st):
                continue
            r = rel + "/" + e.name if rel else e.name
            if statmod.S_ISDIR(st.st_mode):
                items.append(("d", r, 0, 0))
                stack.append((r, e.path))
            elif statmod.S_ISREG(st.st_mode):
                items.append(("f", r, st.st_size, st.st_mtime_ns))
    items.sort(key=lambda x: x[1])
    h = hashlib.sha1()
    for k, r, s, m in items:
        h.update(f"{k}\t{r}\t{s}\t{m}\n".encode("utf-8", "surrogatepass"))
    return items, h.hexdigest()


def _clean_partials(d: Path) -> None:
    if not d.is_dir():
        return
    for e in os.scandir(d):
        if PARTIAL_RE.match(e.name) and not _is_link(e.path):
            _cb["remove_folder"](e.path)


def _purge(job: dict) -> list[str]:
    keep = max(1, min(int(job.get("keep") or KEEP_DEFAULT), KEEP_MAX))
    removed = []
    for s in snapshots(job)[keep:]:
        path = _job_dir(job) / s["id"]
        err = _cb["remove_folder"](str(path))
        if err:
            _log(f"Sauvegarde « {job['name']} » : ancienne copie {s['id']} non supprimée ({err})", "warning")
        else:
            removed.append(s["id"])
    return removed


def run_job(jid: str, *, manual: bool = False) -> dict:
    """One backup of one job. Raises BackupError on failure (recorded on the job)."""
    with _lock:
        job = _find(_load(), jid)
    now = _now()
    _update(jid, last_try_at=now)
    try:
        src = _cb["resolve_dir"](job["rel"])
        if not src or not Path(src).is_dir():
            raise BackupError(f"Dossier « {job['rel']} » introuvable (déplacé ou supprimé ?)", 404, "not_found")
        src = Path(src)
        jdir = _job_dir(job)
        if os.path.normcase(os.path.realpath(jdir)).startswith(os.path.normcase(os.path.realpath(src)) + os.sep):
            raise BackupError("La destination est dans le dossier sauvegardé — refusé")
        jdir = _job_dir(job, create=True)
        _clean_partials(jdir)
        items, sig = scan(src)
        snaps = snapshots(job)
        if snaps and job.get("last_sig") == sig and snaps[0]["id"] == job.get("last_id"):
            _update(jid, last_run_at=now, last_error=None, alerted=False, last_result="unchanged")
            _purge(job)
            return {"ok": True, "unchanged": True}
        total = sum(s for k, _, s, _ in items if k == "f")
        try:
            free = shutil.disk_usage(jdir).free
        except OSError:
            free = None
        if free is not None and free < total + SPARE_BYTES:
            raise BackupError(f"Pas assez de place sur la destination ({free // 1048576} Mo libres, {total // 1048576} Mo à copier)", 507, "quota")
        stamp = datetime.fromtimestamp(now).strftime("%Y%m%d_%H%M%S")
        bump = 0
        while os.path.lexists(jdir / stamp) or os.path.lexists(jdir / (stamp + ".partial")):
            bump += 1
            stamp = datetime.fromtimestamp(now + bump).strftime("%Y%m%d_%H%M%S")
        partial = jdir / (stamp + ".partial")
        partial.mkdir()
        name = src.name
        dest = partial / name
        dest.mkdir()
        prog = {"kind": "backup", "done": 0, "total": sum(1 for k, *_ in items if k == "f"), "bytes": 0}
        _running[jid] = prog
        copied = 0
        size = 0
        skipped: list[str] = []
        try:
            for k, r, s, _m in items:
                target = dest.joinpath(*r.split("/"))
                if k == "d":
                    target.mkdir(exist_ok=True)
                    continue
                try:
                    shutil.copy2(src.joinpath(*r.split("/")), target)
                    copied += 1
                    size += s
                except OSError:
                    skipped.append(r)
                prog["done"] += 1
                prog["bytes"] = size
            (partial / MARKER).write_text(json.dumps({"job": jid, "id": stamp, "rel": job["rel"], "name": name, "at": now, "files": copied,
                                                       "bytes": size, "skipped": len(skipped), "skipped_files": skipped[:SKIPPED_SHOWN]},
                                                      ensure_ascii=False), encoding="utf-8")
            os.replace(partial, jdir / stamp)
        except BaseException:
            _cb["remove_folder"](str(partial))
            raise
    except BackupError as e:
        _fail(job, str(e))
        raise
    except OSError as e:
        _fail(job, f"Copie impossible : {e}")
        raise BackupError(f"Copie impossible : {e}", 500, "storage_error") from e
    finally:
        _running.pop(jid, None)
    _update(jid, last_run_at=now, last_backup_at=now, last_id=stamp, last_sig=sig, last_error=None, alerted=False,
            last_result="copied", last_skipped=skipped[:SKIPPED_SHOWN])
    with _lock:
        job = _find(_load(), jid)
    removed = _purge(job)
    _log(f"Sauvegarde « {job['name']} » → {jdir / stamp} ({copied} fichiers{', ' + str(len(skipped)) + ' ignorés' if skipped else ''})"
         + (f" · {len(removed)} ancienne(s) copie(s) retirée(s)" if removed else ""), "warning" if skipped else "info")
    return {"ok": True, "id": stamp, "files": copied, "bytes": size, "skipped": skipped[:SKIPPED_SHOWN], "removed": removed}


def _fail(job: dict, msg: str) -> None:
    j = _update(job["id"], last_error=msg[:300], last_result="error")
    _log(f"Sauvegarde « {job.get('name')} » impossible : {msg}", "warning")
    if j and not j.get("alerted"):
        _update(job["id"], alerted=True)
        _alert("Sauvegarde automatique impossible", f"{job.get('name')} : {msg}"[:300])


def restore(jid: str, snap: str) -> dict:
    """Copy one snapshot back next to its folder under a new name. Never overwrites anything."""
    with _lock:
        job = _find(_load(), jid)
    if not isinstance(snap, str) or not STAMP_RE.match(snap):
        raise BackupError("Copie invalide")
    s = next((x for x in snapshots(job) if x["id"] == snap), None)
    if not s:
        raise BackupError("Copie introuvable", 404, "not_found")
    src = _job_dir(job) / snap / (s["name"] or "")
    if not s["name"] or not src.is_dir() or _is_link(src):
        raise BackupError("Copie illisible", 404, "not_found")
    parts = _cb["parse_rel"](job["rel"]) or []
    if not parts:
        raise BackupError("Dossier d'origine invalide")
    parent = "/".join(parts[:-1]) if len(parts) > 1 else parts[0]  # a root comes back inside itself
    dest_dir = _cb["resolve_writable_dir"](parent, create=True)
    if not dest_dir:
        raise BackupError("Dossier d'origine invalide")
    d = datetime.strptime(snap, "%Y%m%d_%H%M%S")
    name = f"{s['name']} (sauvegarde du {d.day} {MONTHS[d.month - 1]} {d.hour} h {d.minute:02d})"
    target = Path(dest_dir) / name
    if target.exists():
        target = _cb["unique_in_dir"](Path(dest_dir), name)
    items, _sig = scan(src)
    _running[jid] = prog = {"kind": "restore", "done": 0, "total": sum(1 for k, *_ in items if k == "f"), "bytes": 0}
    try:
        target.mkdir()
        for k, r, size, _m in items:
            t = target.joinpath(*r.split("/"))
            if k == "d":
                t.mkdir(exist_ok=True)
            else:
                shutil.copy2(src.joinpath(*r.split("/")), t)
                prog["done"] += 1
                prog["bytes"] += size
    except OSError as e:
        raise BackupError(f"Restauration impossible : {e}", 500, "storage_error") from e
    finally:
        _running.pop(jid, None)
    rel = "/".join(target.resolve().relative_to(_root().resolve()).parts)
    _update(jid, last_restore={"rel": rel, "at": _now(), "from": snap})
    _log(f"Sauvegarde « {job['name']} » : copie du {stamp_label(snap)} restaurée dans {rel}")
    return {"ok": True, "rel": rel}


def _drop_copies(job: dict) -> int:
    n = 0
    for s in snapshots(job):
        if not _cb["remove_folder"](str(_job_dir(job) / s["id"])):
            n += 1
    try:
        d = _job_dir(job)
        _clean_partials(d)
        if d.is_dir() and not any(os.scandir(d)):
            os.rmdir(d)
    except (OSError, BackupError):
        pass
    return n


# ---------------------------------------------------------------- background work

def _work(item: tuple) -> None:
    kind, jid = item[0], item[1]
    try:
        if kind == "backup":
            run_job(jid, manual=bool(item[2]) if len(item) > 2 else False)
        elif kind == "restore":
            try:
                restore(jid, item[2])
            except BackupError as e:
                _update(jid, last_restore={"error": str(e), "at": _now(), "from": item[2]})
        elif kind == "purge":
            with _lock:
                job = _find(_load(), jid)
            _purge(job)
        elif kind == "drop":
            _drop_copies(item[2])
    except BackupError:
        pass  # recorded on the job
    except Exception as e:  # pragma: no cover - never let the worker die
        _log(f"Sauvegarde : erreur inattendue ({e})", "warning")
    finally:
        _queued.discard(jid)


def _loop() -> None:
    while True:
        item = _queue.get()
        _work(item)


def _enqueue(item: tuple) -> bool:
    global _worker
    jid = item[1]
    if item[0] in ("backup", "restore") and (jid in _queued or jid in _running):
        return False
    _queued.add(jid)
    if _cb.get("sync"):
        _work(item)
        return True
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_loop, name="hq-folder-backups", daemon=True)
        _worker.start()
    _queue.put(item)
    return True


def tick() -> int:
    """Called by the bridge monitor (every ~20 s): queue the jobs that are due. Nothing while backups are paused."""
    paused = _cb.get("paused")
    if callable(paused) and paused():
        return 0
    try:
        jobs = _load()
    except BackupError:
        return 0
    now = _now()
    n = 0
    for j in jobs:
        if due(j, now) and _enqueue(("backup", j["id"], False)):
            n += 1
    return n


def moved(old_rel: str, new_rel: str) -> int:
    """A folder was renamed or moved in Fichiers: its jobs (and jobs of folders inside it) follow it."""
    if not old_rel or not new_rel or old_rel == new_rel:
        return 0
    with _lock:
        try:
            jobs = _load()
        except BackupError:
            return 0
        n = 0
        for j in jobs:
            r = j["rel"]
            if r == old_rel or r.startswith(old_rel + "/"):
                j["rel"] = new_rel + r[len(old_rel):]
                if r == old_rel:
                    j["name"] = new_rel.split("/")[-1]
                n += 1
        if n:
            _save(jobs)
    return n


# ---------------------------------------------------------------- HTTP

def _public(job: dict, now: float) -> dict:
    snaps = snapshots(job)
    src = _cb["resolve_dir"](job["rel"])
    out = {k: job.get(k) for k in ("id", "rel", "name", "every", "keep", "enabled", "created_at", "last_run_at", "last_backup_at", "last_try_at",
                                   "last_error", "last_result", "last_skipped", "last_restore", "dir")}
    every = EVERY.get(job.get("every"), EVERY["day"])
    out["next_at"] = (float(job.get("last_run_at") or 0) + every) if job.get("last_run_at") else None
    out["missing"] = not (src and Path(src).is_dir())
    out["snapshots"] = snaps
    out["running"] = dict(_running[job["id"]]) if job["id"] in _running else (({"kind": "queued"}) if job["id"] in _queued else None)
    return out


def listing() -> dict:
    with _lock:
        jobs = _load()
    fn = _cb.get("target")
    t = fn() if callable(fn) else {"ok": False}
    paused = _cb.get("paused")
    now = _now()
    return {"ok": True, "now": now, "target": {"ok": bool(t.get("ok")), "dir": str(Path(str(t.get("dir") or "")) / SUBDIR) if t.get("dir") else "",
                                               "error": t.get("error"), "paused": bool(callable(paused) and paused())},
            "keep_default": KEEP_DEFAULT, "keep_max": KEEP_MAX, "jobs": [_public(j, now) for j in jobs]}


def _keep(v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) or not 1 <= int(v) <= KEEP_MAX:
        raise BackupError(f"Nombre de copies : 1 à {KEEP_MAX}")
    return int(v)


def _every(v: Any) -> str:
    if v not in EVERY:
        raise BackupError("Fréquence : hour, day ou week")
    return v


def apply(data: dict) -> tuple[int, dict]:
    action = data.get("action") if isinstance(data, dict) else None
    if action == "create":
        rel = data.get("rel")
        parts = _cb["parse_rel"](rel) if isinstance(rel, str) else None
        if not parts:
            raise BackupError("Dossier invalide")
        rel = "/".join(parts)
        src = _cb["resolve_dir"](rel)
        if not src or not Path(src).is_dir():
            raise BackupError("Dossier introuvable", 404, "not_found")
        every = _every(data.get("every", "day"))
        keep = _keep(data.get("keep", KEEP_DEFAULT))
        with _lock:
            jobs = _load()
            if any(j["rel"] == rel for j in jobs):
                raise BackupError("Ce dossier a déjà une sauvegarde automatique", 409, "conflict")
            if len(jobs) >= JOBS_MAX:
                raise BackupError(f"{JOBS_MAX} sauvegardes au maximum", 507, "quota")
            jid = "bk-" + secrets.token_hex(4)
            name = Path(src).name
            job = {"id": jid, "rel": rel, "name": name, "dir": f"{label_for(name)} ({jid})", "every": every, "keep": keep, "enabled": True,
                   "created_at": _now()}
            jobs.append(job)
            _save(jobs)
        _log(f"Sauvegarde automatique activée pour « {rel} » ({every}, {keep} copies)")
        _enqueue(("backup", jid, True))  # the first copy right away
        return 200, {"ok": True, "job": _public(_find(_load(), jid), _now())}
    if action == "update":
        with _lock:
            jobs = _load()
            job = _find(jobs, data.get("id"))
            if "every" in data:
                job["every"] = _every(data["every"])
            if "keep" in data:
                job["keep"] = _keep(data["keep"])
            if "enabled" in data:
                if not isinstance(data["enabled"], bool):
                    raise BackupError("enabled : vrai ou faux")
                job["enabled"] = data["enabled"]
            _save(jobs)
        if "keep" in data:
            _enqueue(("purge", job["id"]))
        return 200, {"ok": True, "job": _public(_find(_load(), job["id"]), _now())}
    if action == "delete":
        with _lock:
            jobs = _load()
            job = _find(jobs, data.get("id"))
            _save([j for j in jobs if j["id"] != job["id"]])
        if data.get("copies") is True:
            _enqueue(("drop", job["id"], job))
        _log(f"Sauvegarde automatique arrêtée pour « {job['rel']} »" + (" (copies supprimées)" if data.get("copies") is True else " (copies gardées)"))
        return 200, {"ok": True}
    if action == "run":
        with _lock:
            job = _find(_load(), data.get("id"))
        _enqueue(("backup", job["id"], True))
        return 202, {"ok": True, "queued": True, "job": _public(_find(_load(), job["id"]), _now())}
    if action == "restore":
        with _lock:
            job = _find(_load(), data.get("id"))
        snap = data.get("snap")
        if not isinstance(snap, str) or not any(s["id"] == snap for s in snapshots(job)):
            raise BackupError("Copie introuvable", 404, "not_found")
        if job["id"] in _running or job["id"] in _queued:
            raise BackupError("Une sauvegarde de ce dossier est en cours — réessaie dans un instant", 409, "busy")
        _update(job["id"], last_restore=None)
        _enqueue(("restore", job["id"], snap))
        return 202, {"ok": True, "queued": True}
    raise BackupError("Action inconnue")


def http_get(_qs: dict) -> tuple[int, dict]:
    try:
        return 200, listing()
    except BackupError as e:
        return e.status, {"error": str(e), "code": e.code}


def http_post(data: dict) -> tuple[int, dict]:
    try:
        return apply(data)
    except BackupError as e:
        return e.status, {"error": str(e), "code": e.code}
