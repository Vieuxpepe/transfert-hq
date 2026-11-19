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
        if raw == "/api/files/hash":
            rel = (qs.get("rel") or [""])[0]
            return 200, file_hash(rel)
        if raw == "/api/files/duplicates":
            rel = (qs.get("rel") or [""])[0]
            return 200, find_duplicates(rel)
        if raw == "/api/files/recent":
            limit = 15
            try:
                if "limit" in qs and qs["limit"]:
                    limit = int(qs["limit"][0])
            except (ValueError, IndexError):
                pass
            return 200, recent_files(limit)
        return 404, {"error": "Inconnu"}
    except FilesError as e:
        return e.status, {"error": str(e), "code": e.code}


def http_post(data: dict) -> tuple[int, dict]:
    try:
        action = data.get("action") if isinstance(data, dict) else None
        if action == "unzip":
            rel = data.get("rel")
            dest = data.get("dest_rel")
            return 200, unzip(str(rel or ""), str(dest) if dest else None)
        if action == "siphon":
            url = data.get("url")
            folder = data.get("folder") or "Inbox"
            name = data.get("name")
            return 200, siphon_url(str(url or ""), str(folder or "Inbox"), str(name) if name else None)
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


def make_zip(rels: list[str]) -> tuple[int, bytes]:
    """Archive a selection of files or directories under the HQ roots into an in-memory zip."""
    if not isinstance(rels, list) or not rels or len(rels) > 200:
        raise FilesError("Sélection invalide pour ZIP (1 à 200 éléments)", 400)

    resolve_rel = _cb.get("resolve_rel")
    parse_rel = _cb.get("parse_rel")
    if not callable(resolve_rel) or not callable(parse_rel):
        raise FilesError("Fichiers non initialisés", 503, "storage_error")

    import io
    import zipfile

    buf = io.BytesIO()
    added = 0
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in rels:
            if not isinstance(rel, str) or not rel.strip():
                continue
            parts = parse_rel(rel)
            if not parts:
                continue
            path = resolve_rel(rel)
            if not path:
                continue
            p = Path(path)
            if not p.exists() or _is_link(p):
                continue
            if p.is_file():
                arcname = "/".join(parts)
                zf.write(p, arcname=arcname)
                added += 1
            elif p.is_dir():
                for root, _, files in os.walk(p, followlinks=False):
                    for f in files:
                        fp = Path(root) / f
                        if not _is_link(fp) and fp.is_file():
                            rel_to_dir = fp.relative_to(p)
                            arcname = "/".join(parts + [str(rel_to_dir).replace("\\", "/")])
                            zf.write(fp, arcname=arcname)
                            added += 1
    if added == 0:
        raise FilesError("Aucun fichier valide à archiver", 400)
    return 200, buf.getvalue()


def file_hash(rel: str) -> dict:
    """Compute SHA-256 and size for a single file under HQ roots."""
    if not isinstance(rel, str) or not rel.strip():
        raise FilesError("Chemin invalide", 400)
    resolve_rel = _cb.get("resolve_rel")
    parse_rel = _cb.get("parse_rel")
    if not callable(resolve_rel) or not callable(parse_rel):
        raise FilesError("Fichiers non initialisés", 503, "storage_error")
    parts = parse_rel(rel)
    if not parts:
        raise FilesError("Chemin invalide", 400)
    path = resolve_rel(rel)
    if not path:
        raise FilesError("Fichier introuvable", 404)
    p = Path(path)
    if not p.is_file() or _is_link(p):
        raise FilesError("Fichier introuvable", 404)
    h = hashlib.sha256()
    size = 0
    with open(p, "rb") as f:
        while chunk := f.read(65536):
            h.update(chunk)
            size += len(chunk)
    return {"ok": True, "rel": rel, "sha256": h.hexdigest(), "size": size}


def find_duplicates(rel: str) -> dict:
    """Find identical files in directory rel having the same byte size and SHA-256 hash."""
    resolve_rel = _cb.get("resolve_rel")
    parse_rel = _cb.get("parse_rel")
    if not callable(resolve_rel) or not callable(parse_rel):
        raise FilesError("Fichiers non initialisés", 503, "storage_error")
    path = resolve_rel(rel) if rel else (_cb.get("roots", [""])[0] if _cb.get("roots") else None)
    if not path:
        raise FilesError("Dossier introuvable", 404)
    p = Path(path)
    if not p.is_dir() or _is_link(p):
        raise FilesError("Dossier introuvable", 404)

    by_size: dict[int, list[tuple[str, Path]]] = {}
    hidden = {n.lower() for n in (_cb.get("system_names") or ())}
    for entry in p.iterdir():
        if entry.name.lower() in hidden or _is_link(entry):
            continue
        try:
            if entry.is_file():
                sz = entry.stat().st_size
                if sz > 0:
                    entry_rel = f"{rel}/{entry.name}" if rel else entry.name
                    by_size.setdefault(sz, []).append((entry_rel, entry))
        except OSError:
            continue

    dups: list[list[dict]] = []
    for sz, entries in by_size.items():
        if len(entries) < 2:
            continue
        by_hash: dict[str, list[dict]] = {}
        for erel, ep in entries:
            try:
                h = hashlib.sha256()
                with open(ep, "rb") as f:
                    while chunk := f.read(65536):
                        h.update(chunk)
                by_hash.setdefault(h.hexdigest(), []).append({"name": ep.name, "rel": erel, "size": sz})
            except OSError:
                continue
        for hval, group in by_hash.items():
            if len(group) >= 2:
                dups.append(group)
    return {"ok": True, "rel": rel, "duplicates": dups}


def unzip(rel: str, dest_rel: str | None = None) -> dict:
    """Extract a .zip archive into dest_rel or a subfolder in the same directory."""
    if not isinstance(rel, str) or not rel.strip():
        raise FilesError("Archive invalide", 400)
    resolve_rel = _cb.get("resolve_rel")
    parse_rel = _cb.get("parse_rel")
    if not callable(resolve_rel) or not callable(parse_rel):
        raise FilesError("Fichiers non initialisés", 503, "storage_error")
    parts = parse_rel(rel)
    if not parts or not rel.lower().endswith(".zip"):
        raise FilesError("Seules les archives .zip sont supportées", 400)
    src_path = resolve_rel(rel)
    if not src_path:
        raise FilesError("Archive introuvable", 404)
    p_src = Path(src_path)
    if not p_src.is_file() or _is_link(p_src):
        raise FilesError("Archive introuvable", 404)

    resolve_writable_dir = _cb.get("resolve_writable_dir")
    if dest_rel is not None:
        if not isinstance(dest_rel, str) or not dest_rel.strip():
            raise FilesError("Dossier de destination invalide", 400)
        d_parts = parse_rel(dest_rel)
        if not d_parts:
            raise FilesError("Dossier de destination invalide", 400)
        dest_path = resolve_writable_dir(dest_rel, create=True) if callable(resolve_writable_dir) else resolve_rel(dest_rel)
    else:
        parent_rel = "/".join(parts[:-1])
        stem = parts[-1][:-4].strip() or "archive"
        target_rel = f"{parent_rel}/{stem}" if parent_rel else stem
        d_parts = parse_rel(target_rel)
        if not d_parts:
            raise FilesError("Dossier de destination invalide", 400)
        dest_path = resolve_writable_dir(target_rel, create=True) if callable(resolve_writable_dir) else resolve_rel(target_rel)

    if not dest_path:
        raise FilesError("Dossier de destination invalide", 400)
    p_dest = Path(dest_path)
    p_dest.mkdir(parents=True, exist_ok=True)
    p_dest_real = p_dest.resolve()

    import zipfile
    extracted = 0
    total_bytes = 0
    max_bytes = 500 * 1024 * 1024
    max_files = 10000

    try:
        with zipfile.ZipFile(p_src, "r") as zf:
            for member in zf.infolist():
                if extracted >= max_files:
                    raise FilesError("L'archive contient trop de fichiers (> 10000)", 400)
                if (member.external_attr >> 16) & 0o170000 == 0o120000:
                    continue
                filename = member.filename.replace("\\", "/").strip("/")
                if not filename or ".." in filename.split("/"):
                    continue
                target_file = (p_dest / filename).resolve()
                if not target_file.is_relative_to(p_dest_real):
                    continue
                if member.is_dir():
                    target_file.mkdir(parents=True, exist_ok=True)
                    continue
                total_bytes += member.file_size
                if total_bytes > max_bytes:
                    raise FilesError("Volume décompressé trop volumineux (> 500 Mo)", 400)
                target_file.parent.mkdir(parents=True, exist_ok=True)
                with zf.open(member) as sfp, open(target_file, "wb") as dfp:
                    shutil.copyfileobj(sfp, dfp)
                extracted += 1
    except zipfile.BadZipFile:
        raise FilesError("Archive ZIP corrompue ou invalide", 400)

    dest_rel_str = "/".join(d_parts) if d_parts else ""
    return {"ok": True, "extracted": extracted, "dest_rel": dest_rel_str}


def recent_files(limit: int = 15) -> dict:
    root = _root()
    sys_names = set(_cb.get("system_names") or ())
    sys_names.add(TRASH_DIR)
    limit = max(1, min(limit, 50))
    candidates = []

    try:
        top_entries = list(os.scandir(root))
    except OSError as e:
        raise FilesError(f"Lecture racine impossible: {e}", 500)

    for entry in top_entries:
        if entry.name in sys_names or entry.name.startswith((".", "_")):
            continue
        if entry.is_dir(follow_symlinks=False):
            try:
                for dirpath, dirnames, filenames in os.walk(entry.path, followlinks=False):
                    depth = os.path.relpath(dirpath, entry.path).count(os.sep)
                    if depth > 8 or len(candidates) >= 10000:
                        dirnames.clear()
                        continue
                    dirnames[:] = [d for d in dirnames if not d.startswith((".", "_")) and d not in sys_names]
                    for fname in filenames:
                        if fname.startswith((".", "_")):
                            continue
                        fpath = os.path.join(dirpath, fname)
                        try:
                            st = os.stat(fpath)
                            rel = os.path.relpath(fpath, root).replace("\\", "/")
                            candidates.append({
                                "rel": rel,
                                "name": fname,
                                "size": st.st_size,
                                "mtime": st.st_mtime,
                            })
                        except OSError:
                            continue
            except OSError:
                continue

    candidates.sort(key=lambda x: x["mtime"], reverse=True)
    return {"ok": True, "files": candidates[:limit]}


def siphon_url(url: str, folder_rel: str, name: str | None = None) -> dict:
    import urllib.request
    import urllib.parse

    if not url or not (url.startswith("http://") or url.startswith("https://")):
        raise FilesError("URL invalide (doit débuter par http:// ou https://)", 400)

    resolve_writable = _cb.get("resolve_writable_dir")
    parse_rel = _cb.get("parse_rel")
    unique_in_dir = _cb.get("unique_in_dir")

    parts = parse_rel(folder_rel) if callable(parse_rel) else None
    if parts is None:
        raise FilesError("Dossier de destination invalide", 400)

    dest_dir = resolve_writable(folder_rel, create=True) if callable(resolve_writable) else None
    if not dest_dir:
        raise FilesError("Dossier introuvable ou non inscriptible", 400)

    dest_path = Path(dest_dir)

    clean_name = (name or "").strip()
    if not clean_name:
        parsed_url = urllib.parse.urlparse(url)
        path_name = os.path.basename(parsed_url.path)
        clean_name = urllib.parse.unquote(path_name).strip()
    clean_name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", clean_name).strip()
    if not clean_name or clean_name in (".", ".."):
        clean_name = f"siphon_{int(time.time())}.bin"
    if len(clean_name) > 120:
        ext = os.path.splitext(clean_name)[1][:10]
        clean_name = clean_name[:110] + ext

    if not (dest_path / clean_name).resolve().is_relative_to(dest_path.resolve()):
        raise FilesError("Nom de fichier dangereux", 400)

    final_file = unique_in_dir(dest_path, clean_name) if callable(unique_in_dir) else (dest_path / clean_name)
    temp_file = dest_path / f".tmp-siphon-{os.getpid()}-{int(time.time() * 1000)}"

    max_bytes = 100 * 1024 * 1024
    total_bytes = 0

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "TransfertHQ/7.0 (Siphon)"}
    )

    try:
        with urllib.request.urlopen(req, timeout=15) as resp, open(temp_file, "wb") as out_fp:
            while True:
                chunk = resp.read(64 * 1024)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > max_bytes:
                    raise FilesError("Fichier distant trop volumineux (> 100 Mo)", 400)
                out_fp.write(chunk)
        temp_file.replace(final_file)
    except FilesError:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except OSError:
                pass
        raise
    except Exception as e:
        if temp_file.exists():
            try:
                temp_file.unlink()
            except OSError:
                pass
        raise FilesError(f"Échec du téléchargement: {e}", 502)

    rel_dest = ("/".join(parts) + "/" + final_file.name).strip("/") if parts else final_file.name
    return {"ok": True, "rel": rel_dest, "name": final_file.name, "size": total_bytes}


