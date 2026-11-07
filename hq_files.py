"""Transfert HQ — Fichiers helpers: a recycle bin and folder previews. Stdlib only.

Corbeille: « Supprimer » in Fichiers moves the file or folder to ``<ROOT>/.hq-trash/<id>/<name>`` and records where it came
from in ``.hq-trash/trash.json``. « Restaurer » puts it back in its folder (a new name if one is taken; the folder is
re-created if it is gone). Items older than ``KEEP_DAYS`` are emptied when the bin is read. The bin never follows a link:
a redirected bin folder is refused and nothing moves. The older ``/api/delete`` (permanent) is unchanged.

Peek: for a few folders at once, how many files and folders they hold and up to four pictures directly inside, so the
folder tiles can show what is in them without opening them.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Any

TRASH_DIR = ".hq-trash"
INDEX = "trash.json"
KEEP_DAYS = 30
TRASH_MAX = 2000
PEEK_MAX = 60
PEEK_PICS = 4
PEEK_SCAN = 400
PEEK_CACHE_SEC = 4.0
_peek_cache_lock = threading.Lock()
_peek_cache: dict[str, tuple[float, dict]] = {}
IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"}
ID_RE = re.compile(r"^tr-[0-9a-f]{12}\Z")

_cb: dict[str, Any] = {}
_lock = threading.RLock()


class FilesError(ValueError):
    def __init__(self, msg: str, status: int = 400, code: str = "validation_error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    """``root``, ``resolve_rel(rel) -> Path|None`` (existing file or folder under a root), ``resolve_writable_dir(rel, create)``,
    ``parse_rel(rel) -> list|None``, ``unique_in_dir(dir, name) -> Path``, ``system_names`` (set), optional ``now``."""
    _cb.update(kwargs)


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise FilesError("Fichiers non initialisés", 503, "storage_error")
    return Path(os.path.abspath(os.fspath(root)))


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    j = getattr(os.path, "isjunction", None)
    return bool(j and j(path))


def _bin(create: bool = False) -> Path:
    base = _root() / TRASH_DIR
    if os.path.lexists(base):
        if _is_link(base) or not base.is_dir() or os.path.normcase(os.path.realpath(base)) != os.path.normcase(os.path.join(os.path.realpath(_root()), TRASH_DIR)):
            raise FilesError("Corbeille redirigée — refusée", 503, "storage_error")
    elif create:
        base.mkdir(parents=True, exist_ok=True)
    return base


def _load(base: Path) -> list[dict]:
    path = base / INDEX
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise FilesError("Index de la corbeille illisible — conservé", 503, "storage_error") from e
    items = data.get("items") if isinstance(data, dict) else None
    if not isinstance(items, list):
        raise FilesError("Index de la corbeille illisible — conservé", 503, "storage_error")
    return [i for i in items if isinstance(i, dict) and isinstance(i.get("id"), str) and ID_RE.match(i["id"])]


def _save(base: Path, items: list[dict]) -> None:
    path = base / INDEX
    tmp = base / (INDEX + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "items": items}, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def _size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, name))
            except OSError:
                pass
    return total


def _public(item: dict) -> dict:
    return {k: item[k] for k in ("id", "name", "orig", "type", "size", "at") if k in item}


def _expire(base: Path, items: list[dict]) -> list[dict]:
    limit = _now() - KEEP_DAYS * 86400
    keep = []
    for i in items:
        if float(i.get("at") or 0) < limit:
            shutil.rmtree(base / i["id"], ignore_errors=True)
        else:
            keep.append(i)
    return keep


def trash(rel: str) -> dict:
    parse = _cb["parse_rel"]
    parts = parse(rel) if isinstance(rel, str) else None
    if not parts:
        raise FilesError("Chemin invalide")
    path = _cb["resolve_rel"](rel)
    if not path:
        raise FilesError("Introuvable", 404, "not_found")
    if len(parts) == 1:
        raise FilesError("Impossible de supprimer une racine")
    if _is_link(Path(path)):
        raise FilesError("Lien refusé")
    with _lock:
        base = _bin(create=True)
        items = _load(base)
        if len(items) >= TRASH_MAX:
            raise FilesError("Corbeille pleine — vide-la d'abord", 507, "quota")
        tid = "tr-" + secrets.token_hex(6)
        slot = base / tid
        slot.mkdir()
        item = {"id": tid, "name": Path(path).name, "orig": "/".join(parts), "type": "dir" if Path(path).is_dir() else "file", "size": _size(Path(path)), "at": round(_now(), 3)}
        try:
            shutil.move(str(path), str(slot / Path(path).name))
        except OSError as e:
            shutil.rmtree(slot, ignore_errors=True)
            raise FilesError("Impossible de mettre à la corbeille", 500, "storage_error") from e
        items.append(item)
        _save(base, items)
        return _public(item)


def restore(tid: str) -> dict:
    if not isinstance(tid, str) or not ID_RE.match(tid):
        raise FilesError("Élément invalide")
    with _lock:
        base = _bin()
        items = _load(base)
        item = next((i for i in items if i["id"] == tid), None)
        if item is None:
            raise FilesError("Introuvable dans la corbeille", 404, "not_found")
        src = base / tid / item["name"]
        if not os.path.lexists(src) or _is_link(src):
            raise FilesError("Contenu de la corbeille introuvable", 404, "not_found")
        parent = "/".join(str(item["orig"]).split("/")[:-1])
        dest_dir = _cb["resolve_writable_dir"](parent, create=True)
        if not dest_dir:
            raise FilesError("Dossier d'origine invalide", 400)
        target = Path(dest_dir) / item["name"]
        if target.exists():
            target = _cb["unique_in_dir"](Path(dest_dir), item["name"])
        try:
            shutil.move(str(src), str(target))
        except OSError as e:
            raise FilesError("Restauration impossible", 500, "storage_error") from e
        shutil.rmtree(base / tid, ignore_errors=True)
        items = [i for i in items if i["id"] != tid]
        _save(base, items)
        rel = "/".join(Path(target).resolve().relative_to(_root().resolve()).parts)
        return {"ok": True, "rel": rel, "name": Path(target).name}


def purge(tid: str | None) -> dict:
    with _lock:
        base = _bin()
        if not base.exists():
            return {"ok": True, "removed": 0}
        items = _load(base)
        if tid is None:
            for i in items:
                shutil.rmtree(base / i["id"], ignore_errors=True)
            _save(base, [])
            return {"ok": True, "removed": len(items)}
        if not isinstance(tid, str) or not ID_RE.match(tid) or not any(i["id"] == tid for i in items):
            raise FilesError("Introuvable dans la corbeille", 404, "not_found")
        shutil.rmtree(base / tid, ignore_errors=True)
        _save(base, [i for i in items if i["id"] != tid])
        return {"ok": True, "removed": 1}


def listing() -> dict:
    with _lock:
        base = _bin()
        if not base.exists():
            return {"ok": True, "items": [], "size": 0, "keep_days": KEEP_DAYS}
        items = _load(base)
        kept = _expire(base, items)
        if len(kept) != len(items):
            _save(base, kept)
        kept.sort(key=lambda i: -float(i.get("at") or 0))
        return {"ok": True, "items": [_public(i) for i in kept], "size": sum(int(i.get("size") or 0) for i in kept), "keep_days": KEEP_DAYS}


def _peek_folder_fingerprint(path: Path) -> str:
    try:
        st = path.stat()
        raw = f"{st.st_mtime_ns}\0{st.st_dev}\0{st.st_ino}"
    except OSError:
        raw = "missing"
    return hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:24]


def peek(rels: list[str]) -> dict:
    """{rel: {files, dirs, pics: [rel, ...]}} for up to PEEK_MAX folders (direct children only, hidden and system names skipped)."""
    out: dict[str, dict] = {}
    hidden = {n.lower() for n in (_cb.get("system_names") or ())}
    now = time.monotonic()
    for rel in rels[:PEEK_MAX]:
        parts = _cb["parse_rel"](rel) if isinstance(rel, str) else None
        if not parts:
            continue
        path = _cb["resolve_rel"](rel)
        if not path or not Path(path).is_dir():
            continue
        key = "/".join(parts)
        fp = _peek_folder_fingerprint(Path(path))
        with _peek_cache_lock:
            hit = _peek_cache.get(key)
            if hit and hit[0] == fp and now - hit[1][0] < PEEK_CACHE_SEC:
                out[key] = dict(hit[1][1])
                continue
        files = dirs = 0
        pics: list[str] = []
        try:
            with os.scandir(path) as it:
                for k, e in enumerate(it):
                    if k >= PEEK_SCAN:
                        break
                    if e.name.startswith(".") or e.name.lower() in hidden:
                        continue
                    if e.is_dir(follow_symlinks=False):
                        dirs += 1
                    elif e.is_file(follow_symlinks=False):
                        files += 1
                        if len(pics) < PEEK_PICS and os.path.splitext(e.name)[1].lower() in IMAGE_EXT:
                            pics.append("/".join(parts + [e.name]))
        except OSError:
            continue
        row = {"files": files, "dirs": dirs, "pics": sorted(pics)}
        out[key] = row
        with _peek_cache_lock:
            _peek_cache[key] = (fp, (now, row))
    return out


def http_get(raw: str, qs: dict) -> tuple[int, dict]:
    try:
        if raw == "/api/files/trash":
            return 200, listing()
        if raw == "/api/files/peek":
            return 200, {"ok": True, "folders": peek([r for r in qs.get("rel", []) if isinstance(r, str)])}
        return 404, {"error": "Inconnu"}
    except FilesError as e:
        return e.status, {"error": str(e), "code": e.code}


def http_post(data: dict) -> tuple[int, dict]:
    try:
        action = data.get("action") if isinstance(data, dict) else None
        if action == "trash":
            rels = data.get("rels")
            if not isinstance(rels, list) or not rels or len(rels) > 200:
                raise FilesError("Sélection invalide (1 à 200)")
            done, failed = [], []
            for r in rels:
                try:
                    done.append(trash(str(r)))
                except FilesError as e:
                    failed.append({"rel": str(r)[:400], "error": str(e)})
            return (200 if done else 400), {"ok": bool(done), "trashed": done, "failed": failed, **({} if done else {"error": failed[0]["error"] if failed else "Rien à supprimer"})}
        if action == "restore":
            ids = data.get("ids")
            if not isinstance(ids, list) or not ids or len(ids) > 200:
                raise FilesError("Sélection invalide (1 à 200)")
            done, failed = [], []
            for t in ids:
                try:
                    done.append(restore(t))
                except FilesError as e:
                    failed.append({"id": str(t)[:40], "error": str(e)})
            return (200 if done else 400), {"ok": bool(done), "restored": done, "failed": failed, **({} if done else {"error": failed[0]["error"] if failed else "Rien à restaurer"})}
        if action == "purge":
            if not isinstance(data.get("id"), str):  # one item only; emptying the bin is its own action
                raise FilesError("Élément invalide")
            return 200, purge(data["id"])
        if action == "empty":
            return 200, purge(None)
        raise FilesError("Action inconnue")
    except FilesError as e:
        return e.status, {"error": str(e), "code": e.code}
