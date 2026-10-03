"""Carnet Phase 5: write-once project snapshots ("Design Freeze"). Own store, stdlib only.

Runtime state: ``<ROOT>/.hq-carnet/snapshots/<snap-id>.json``, ONE file per snapshot, written exactly once.

What a snapshot IS: an immutable notebook/project-state freeze with integrity-pinned external references. It freezes the
full canonical content of the project's (non-trashed) pages, their ids and revisions, the project/category relationship,
the exact drawing stems, the canonical image/voice asset ids, the source edition information and the file references.

What it is NOT: a self-contained archival release bundle. Referenced binaries are NOT copied. For every reference the
snapshot records what was OBSERVED at creation: SHA-256 over the ACTUAL canonical file bytes (streamed, never loaded whole),
the byte size and an existence state (``ok`` | ``missing``). Later, ``verify`` re-hashes the same references and reports
``unchanged`` | ``modified`` | ``missing``; it never pretends an externally changed binary is still reproducible.
Drawing underlay assets (the one-hop closure used by backups) are not hashed here.

Why a store at all: page history is pruned, checkpoints are per page and capped, and restoring re-mints block ids, so no
combination of current revisions can reconstruct an old project state.

Contract: create is atomic (capture -> validate refs -> hash -> build the whole object -> limits -> publish ONE file); no edit
route, no delete route, no silent update, no "latest drawing" auto-follow. A reference that is already canonically absent is
recorded ``state: missing``; an ambiguous I/O or validation failure ABORTS the creation (nothing is published).
``content_sha256`` seals the snapshot itself; reading re-verifies it and a mismatch is reported ``corrupt`` (never repaired).

Bounds: ``PER_PROJECT_MAX`` snapshots per project, ``SNAPSHOT_BYTES_MAX`` serialized bytes each, ``STORE_BYTES_MAX`` for the
whole store (binaries are outside it), ``HASH_FILE_MAX`` bytes per hashed file and ``HASH_TOTAL_MAX`` per snapshot.
Lock order: notebook lock -> (released) -> snapshot-store lock. Hashing never holds the notebook lock.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat as _stat
import time
from pathlib import Path
from typing import Any, Callable

import hq_carnet_intel as intel
import hq_carnet_rich as rich
import hq_state

DIR_NAME = ".hq-carnet"
SNAP_DIR = "snapshots"
VERSION = 1
PER_PROJECT_MAX = 50
SNAPSHOT_BYTES_MAX = 2 * 1024 * 1024
STORE_BYTES_MAX = 100 * 1024 * 1024
HASH_FILE_MAX = 1024 * 1024 * 1024
HASH_TOTAL_MAX = 4 * 1024 * 1024 * 1024
LABEL_MAX = 80
NOTE_MAX = 400
CHUNK = 1024 * 1024
ID_RE = re.compile(r"^snap-[0-9a-f]{24}\Z")
REQ_RE = re.compile(r"^[0-9a-f]{32}\Z")
_SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ESCAPED = "Dossier des jalons redirigé — refusé"

_cb: dict[str, Any] = {}


class SnapshotError(ValueError):
    status = 400
    code = "validation_error"


class SnapshotNotFound(SnapshotError):
    status = 404
    code = "not_found"


class SnapshotConflict(SnapshotError):
    status = 409
    code = "snapshot_limit"

    def __init__(self, message: str, code: str | None = None):
        super().__init__(message)
        if code:
            self.code = code


class SnapshotStorageError(RuntimeError):
    """Store unreadable / not writable / an ambiguous reference. Maps to 503 ``snapshots_unavailable``."""

    code = "snapshots_unavailable"

    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


def bind(**kwargs: Any) -> None:
    _cb.update(kwargs)


def _now() -> int:
    fn = _cb.get("now")
    return int(fn()) if callable(fn) else int(time.time())


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise SnapshotStorageError("Carnet non initialisé")
    return Path(os.path.abspath(os.fspath(root)))


def _hc():
    import hq_carnet

    return hq_carnet


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    junction = getattr(os.path, "isjunction", None)
    return bool(junction and junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def snap_dir(root: Path | str | None = None) -> Path:
    base = Path(os.path.abspath(os.fspath(root if root is not None else _root())))
    return base / DIR_NAME / SNAP_DIR


def confined_dir(root: Path | str | None = None, *, create: bool = False) -> Path:
    """``snap_dir`` after refusing any redirection (symlink/junction/escape) of ``.hq-carnet`` or ``snapshots``."""
    target = snap_dir(root)
    base = target.parent
    try:
        real_root = os.path.realpath(base.parent)
        for index, item in enumerate((base, target)):
            if os.path.lexists(item):
                if _is_link(item) or not item.is_dir():
                    raise SnapshotStorageError(_ESCAPED, 409)
            elif create:
                item.mkdir()
            else:
                continue
            want = os.path.join(real_root, DIR_NAME) if index == 0 else os.path.join(real_root, DIR_NAME, SNAP_DIR)
            if _is_link(item) or not _same(os.path.realpath(item), want):
                raise SnapshotStorageError(_ESCAPED, 409)
    except OSError as e:
        raise SnapshotStorageError("Jalons inaccessibles") from e
    return target


def store_lock(root: Path | str | None = None):
    return hq_state.path_lock(snap_dir(root))


# ---------------------------------------------------------------- hashing the REAL canonical bytes (streaming)


def hash_file(path: Path, cap: int = HASH_FILE_MAX) -> tuple[str, int] | None:
    """``(sha256 hex, size)`` of a regular, non-link file, streamed in chunks. ``None`` ONLY when the file does not exist.
    Anything else that is not a clean read (link, directory, I/O error, over ``cap``, changed while reading — size, mtime or identity differ before/after, or the path no longer resolves to the opened file — raises)."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise SnapshotStorageError("Référence illisible — jalon non créé") from e
    if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode):
        raise SnapshotStorageError("Référence non canonique — jalon non créé")
    if st.st_size > cap:
        raise SnapshotStorageError("Fichier référencé trop volumineux pour être scellé — jalon non créé")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise SnapshotStorageError("Référence illisible — jalon non créé") from e
    digest = hashlib.sha256()
    total = 0
    changed = SnapshotStorageError("Référence modifiée pendant la création du jalon — jalon non créé")

    def _ident(x: os.stat_result) -> tuple:
        return (x.st_size, x.st_mtime_ns, x.st_ino, x.st_dev)

    try:
        with os.fdopen(fd, "rb") as handle:
            fst = os.fstat(handle.fileno())
            if not _stat.S_ISREG(fst.st_mode):
                raise SnapshotStorageError("Référence non canonique — jalon non créé")
            if fst.st_size > cap:
                raise SnapshotStorageError("Fichier référencé trop volumineux pour être scellé — jalon non créé")
            before = _ident(fst)
            while True:
                chunk = handle.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > cap:
                    raise SnapshotStorageError("Fichier référencé trop volumineux pour être scellé — jalon non créé")
                digest.update(chunk)
            # ONE stable observation: the opened file must be byte-for-byte the file whose size/mtime/identity we recorded before reading.
            after = os.fstat(handle.fileno())
            if _ident(after) != before or total != before[0]:
                raise changed
            # ...and the PATH must still be that very file: an atomic replace (or a delete) while we hashed leaves our descriptor intact, so
            # the digest would describe bytes the canonical path no longer holds.
            try:
                now = os.lstat(path)
            except OSError as e:
                raise changed from e
            if _stat.S_ISLNK(now.st_mode) or not _stat.S_ISREG(now.st_mode) or _ident(now) != before:
                raise changed
    except SnapshotStorageError:
        raise
    except OSError as e:
        raise SnapshotStorageError("Référence illisible — jalon non créé") from e
    return digest.hexdigest(), total


def _rel_file(root: Path, rel: str) -> Path | None:
    """A stored RELATIVE reference resolved below ROOT; ``None`` when it would leave ROOT (never hashed)."""
    if not isinstance(rel, str) or not rel or "\x00" in rel or rel.startswith(("/", "\\")) or ":" in rel.split("/")[0]:
        return None
    parts = rel.replace("\\", "/").split("/")
    if any(p in ("", ".", "..") for p in parts):
        return None
    path = root.joinpath(*parts)
    try:
        if not path.parent.resolve().is_relative_to(root.resolve()):  # the link itself is judged by lstat in hash_file
            return None
    except (OSError, ValueError):
        return None
    return path


class _Budget:
    def __init__(self) -> None:
        self.total = 0

    def add(self, size: int) -> None:
        self.total += size
        if self.total > HASH_TOTAL_MAX:
            raise SnapshotStorageError("Trop de données référencées à sceller — jalon non créé")


def _observe(path: Path | None, budget: _Budget | None) -> dict:
    if path is None:
        return {"state": "missing", "sha256": None, "size": None}
    got = hash_file(path)
    if got is None:
        return {"state": "missing", "sha256": None, "size": None}
    if budget is not None:
        budget.add(got[1])
    return {"state": "ok", "sha256": got[0], "size": got[1]}


def _locate(kind: str, ident: str, root: Path) -> Path | None:
    """The canonical file of one reference, WITHOUT reading it. ``None`` = no such canonical file."""
    import hq_carnet_media as media
    import hq_carnet_voice as voice
    import hq_drawings as drawings

    if kind == "asset":
        return media._find_file(media.confined_assets_dir(root), ident)
    if kind == "voice":
        return voice._find_file(voice.confined_voice_dir(root), ident)
    if kind == "drawing":
        try:
            stem = drawings.valid_stem(ident)
        except drawings.DrawingError:
            return None
        directory = drawings.drawings_dir(root, create=False)
        return None if directory is None else directory / (stem + drawings.DOC_SUFFIX)
    return _rel_file(root, ident)


def observe_refs(refs: dict, root: Path, budget: _Budget | None = None) -> dict:
    """Hash every reference of ``refs`` (``{drawings,assets,voices,files}`` lists of dicts with their identity) and return
    the same shape with ``state/sha256/size`` filled. Raises on any ambiguous failure."""
    budget = budget or _Budget()
    out: dict[str, list] = {}
    keys = {"drawings": ("drawing", "stem"), "assets": ("asset", "id"), "voices": ("voice", "id"), "files": ("file", "path")}
    for bucket, (kind, field) in keys.items():
        rows = []
        for ref in refs[bucket]:
            row = dict(ref)
            real_kind = kind if bucket != "files" else "file"
            row.update(_observe(_locate(real_kind, ref[field], root), budget))
            rows.append(row)
        out[bucket] = rows
    return out


# ---------------------------------------------------------------- building a snapshot


def _canon_bytes(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def seal(obj: dict) -> str:
    return hashlib.sha256(_canon_bytes({k: v for k, v in obj.items() if k != "content_sha256"})).hexdigest()


def _clean_text(value: Any, limit: int, what: str, required: bool) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str) or len(value) > limit or _CTRL_RE.search(value):
        raise SnapshotError(f"{what} invalide")
    value = value.strip()
    if required and not value:
        raise SnapshotError(f"{what} requis")
    return value


def collect_refs(pages: list[dict]) -> dict:
    """The identities (no bytes yet) referenced by ``pages``. Everything is bounded by the page limits."""
    drawings: set[str] = set()
    assets: dict[str, None] = {}
    voices: set[str] = set()
    files: set[tuple[str, str]] = set()
    for page in pages:
        content = page["content"]
        if content.get("version") == rich.CONTENT_VERSION:
            for a in rich.assets_of(content):
                assets[a["id"]] = None
            for b in content["blocks"]:
                for x in rich.block_provenance_assets(b):
                    assets[x] = None
                for ref in intel.block_refs(b) + intel.portal_refs(b):
                    if ref["kind"] == "drawing":
                        drawings.add(ref["id"])
                    elif ref["kind"] in ("file", "model", "media"):
                        files.add((ref["kind"], ref["id"]))
            voices.update(rich.voices_of(content))
    return {
        "drawings": [{"stem": s} for s in sorted(drawings)],
        "assets": [{"id": i} for i in sorted(assets)],
        "voices": [{"id": i} for i in sorted(voices)],
        "files": [{"kind": k, "path": p} for k, p in sorted(files)],
    }


def _edition_info(ed: dict) -> dict:
    keys = ("id", "title", "author", "edition", "year", "publisher", "identifier", "type", "url", "file_ref", "archived")
    return {k: ed.get(k) for k in keys}


def build(project: dict, pages: list[dict], categories: list[dict], notebook_rev: int, editions: dict[str, dict], label: str, note: str, root: Path, captured_at: int | None = None, request_id: str = "") -> dict:
    """The complete snapshot object (sealed). Hashes referenced bytes; raises on ambiguity. Pure of any publishing."""
    refs = collect_refs(pages)
    cited: dict[str, dict] = {}
    for page in pages:
        content = page["content"]
        if content.get("version") != rich.CONTENT_VERSION:
            continue
        for b in content["blocks"]:
            for ref in intel.block_refs(b) + intel.portal_refs(b):
                if ref["kind"] == "source":
                    ed = editions.get(ref["id"])
                    cited[ref["id"]] = _edition_info(ed) if ed else {"id": ref["id"], "missing": True}
    budget = _Budget()
    observed = observe_refs(refs, root, budget)
    sources = []
    for ident in sorted(cited):
        info = dict(cited[ident])
        if info.get("missing"):
            info.update(state="missing", file=None)
        else:
            info["state"] = "ok"
            fr = info.get("file_ref")
            info["file"] = _observe(_rel_file(root, fr), budget) if isinstance(fr, str) and fr else None
        sources.append(info)
    cat_ids = {p["category_id"] for p in pages if p.get("category_id")}
    snap = {
        "version": VERSION,
        "id": "snap-" + secrets.token_hex(12),
        "project": {"id": project["id"], "name": project["name"], "archived": bool(project.get("archived"))},
        "label": label,
        "note": note,
        "created_at": _now() if captured_at is None else captured_at,  # when the NOTEBOOK STATE was captured, not when hashing finished
        "request_id": request_id,
        "notebook_rev": notebook_rev,
        "fingerprint": intel.fingerprint(pages),
        "categories": [{"id": c["id"], "name": c["name"]} for c in categories if c["id"] in cat_ids],
        "pages": [{
            "id": p["id"], "rev": p["rev"], "project_id": p["project_id"], "category_id": p.get("category_id"), "pinned": bool(p.get("pinned")),
            "created_at": p["created_at"], "updated_at": p["updated_at"], "content": p["content"],
        } for p in sorted(pages, key=lambda p: p["id"])],
        "refs": {**observed, "sources": sources},
    }
    snap["content_sha256"] = seal(snap)
    return snap


# ---------------------------------------------------------------- validation of STORED snapshots


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _obs_ok(row: Any, extra: set[str]) -> bool:
    if not isinstance(row, dict) or set(row) != extra | {"state", "sha256", "size"}:
        return False
    if row["state"] == "ok":
        return isinstance(row["sha256"], str) and bool(_SHA_RE.match(row["sha256"])) and _is_int(row["size"]) and row["size"] >= 0
    return row["state"] == "missing" and row["sha256"] is None and row["size"] is None


def validate(snap: Any, expected_id: str | None = None) -> dict:
    """Strict structural validation of a stored snapshot. Raises ``SnapshotError``; never repairs."""
    bad = SnapshotError("Jalon invalide")
    if not isinstance(snap, dict) or set(snap) != {"version", "id", "project", "label", "note", "created_at", "request_id", "notebook_rev", "fingerprint", "categories", "pages", "refs", "content_sha256"}:
        raise bad
    if snap["version"] != VERSION or not isinstance(snap["id"], str) or not ID_RE.match(snap["id"]) or (expected_id and snap["id"] != expected_id):
        raise bad
    proj = snap["project"]
    if not isinstance(proj, dict) or set(proj) != {"id", "name", "archived"} or not isinstance(proj["id"], str) or not _hc()._ID_RE["proj"].match(proj["id"]):
        raise bad
    if not isinstance(snap["label"], str) or not snap["label"] or len(snap["label"]) > LABEL_MAX or not isinstance(snap["note"], str) or len(snap["note"]) > NOTE_MAX:
        raise bad
    if not isinstance(snap["request_id"], str) or not REQ_RE.match(snap["request_id"]):
        raise bad
    if not _is_int(snap["created_at"]) or not _is_int(snap["notebook_rev"]) or not isinstance(snap["fingerprint"], str):
        raise bad
    if not isinstance(snap["pages"], list) or not isinstance(snap["categories"], list):
        raise bad
    for p in snap["pages"]:
        if not isinstance(p, dict) or set(p) != {"id", "rev", "project_id", "category_id", "pinned", "created_at", "updated_at", "content"}:
            raise bad
        if not isinstance(p["id"], str) or not _hc()._ID_RE["page"].match(p["id"]) or not _is_int(p["rev"]) or p["rev"] < 1 or p["project_id"] != proj["id"]:
            raise bad
        if not (rich.valid_v2(p["content"]) or rich.valid_v1(p["content"])):
            raise bad
    refs = snap["refs"]
    if not isinstance(refs, dict) or set(refs) != {"drawings", "assets", "voices", "files", "sources"}:
        raise bad
    shapes = {"drawings": {"stem"}, "assets": {"id"}, "voices": {"id"}, "files": {"kind", "path"}}
    for bucket, extra in shapes.items():
        if not isinstance(refs[bucket], list) or not all(_obs_ok(r, extra) for r in refs[bucket]):
            raise bad
    if not isinstance(refs["sources"], list) or not all(isinstance(s, dict) and isinstance(s.get("id"), str) for s in refs["sources"]):
        raise bad
    if not isinstance(snap["content_sha256"], str) or not _SHA_RE.match(snap["content_sha256"]):
        raise bad
    return snap


def _read_one(directory: Path, snap_id: str) -> tuple[dict | None, str]:
    """``(snapshot or None, integrity)`` with integrity ``ok`` | ``corrupt`` | ``invalid``. Unreadable bytes raise."""
    path = directory / (snap_id + ".json")
    try:
        st = os.lstat(path)
        if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode) or st.st_size > SNAPSHOT_BYTES_MAX + 4096:
            return None, "invalid"
        raw = path.read_bytes()
    except FileNotFoundError as e:
        raise SnapshotNotFound("Jalon introuvable") from e
    except OSError as e:
        raise SnapshotStorageError("Jalon illisible") from e
    try:
        data = json.loads(raw.decode("utf-8"))
        validate(data, snap_id)
    except (UnicodeDecodeError, json.JSONDecodeError, SnapshotError):
        return None, "invalid"
    return data, ("ok" if seal(data) == data["content_sha256"] else "corrupt")


def _ids(directory: Path) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise SnapshotStorageError("Jalons inaccessibles") from e
    return sorted(n[:-5] for n in names if n.endswith(".json") and ID_RE.match(n[:-5]))


def header(snap: dict, integrity: str = "ok") -> dict:
    return {
        "id": snap["id"], "project_id": snap["project"]["id"], "project_name": snap["project"]["name"], "label": snap["label"], "note": snap["note"],
        "created_at": snap["created_at"], "notebook_rev": snap["notebook_rev"], "pages": len(snap["pages"]), "fingerprint": snap["fingerprint"],
        "integrity": integrity,
    }


def list_snapshots(project_id: str | None = None) -> dict:
    root = _root()
    directory = confined_dir(root)
    with store_lock(root):
        rows, invalid, used = [], 0, 0
        for sid in _ids(directory):
            try:
                snap, integ = _read_one(directory, sid)
            except SnapshotNotFound:
                continue
            if snap is None:
                invalid += 1
                continue
            used += 1
            if project_id is None or snap["project"]["id"] == project_id:
                rows.append(header(snap, integ))
    rows.sort(key=lambda r: (-r["created_at"], r["id"]))
    return {"ok": True, "snapshots": rows, "invalid": invalid, "limits": {"per_project": PER_PROJECT_MAX, "bytes": SNAPSHOT_BYTES_MAX, "store_bytes": STORE_BYTES_MAX}}


def get(snap_id: Any) -> dict:
    if not isinstance(snap_id, str) or not ID_RE.match(snap_id):
        raise SnapshotNotFound("Jalon introuvable")
    root = _root()
    directory = confined_dir(root)
    with store_lock(root):
        snap, integ = _read_one(directory, snap_id)
    if snap is None:
        raise SnapshotStorageError("Jalon invalide — conservé tel quel", 503)
    return {"snapshot": snap, "integrity": integ}


def _store_usage(directory: Path) -> tuple[int, dict[str, int]]:
    total, per = 0, {}
    for sid in _ids(directory):
        path = directory / (sid + ".json")
        try:
            size = os.lstat(path).st_size
        except OSError as e:
            raise SnapshotStorageError("Jalons inaccessibles") from e
        total += size
        try:
            snap, _ = _read_one(directory, sid)
        except SnapshotNotFound:
            continue
        if snap is not None:
            per[snap["project"]["id"]] = per.get(snap["project"]["id"], 0) + 1
    return total, per


# ---------------------------------------------------------------- create (atomic, write-once)


def _publish(directory: Path, snap: dict, raw: bytes) -> None:
    final = directory / (snap["id"] + ".json")
    tmp = directory / (".tmp-" + snap["id"] + "-" + secrets.token_hex(4))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(tmp, flags, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.link(tmp, final)  # fails if it exists: write-once, never replaced
    except FileExistsError as e:
        raise SnapshotStorageError("Identifiant de jalon déjà utilisé", 409) from e
    except OSError as e:
        raise SnapshotStorageError("Écriture du jalon impossible — rien n'a été publié") from e
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    try:
        dfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except OSError:
        pass


def _find_request(request_id: str, pid: str, label: str, note: str, directory: Path) -> dict | None:
    """The snapshot already published for this ``request_id`` (it is sealed INSIDE the snapshot, so a bridge restart changes nothing).
    Caller holds the store lock. Same request + same project/label/note -> that snapshot, flagged ``replayed``. Same request + anything
    else -> a controlled 409. Invalid files are skipped (they can never answer for a request); I/O ambiguity is never swallowed."""
    for sid in _ids(directory):
        try:
            snap, integ = _read_one(directory, sid)
        except SnapshotNotFound:
            continue
        if snap is None or snap["request_id"] != request_id:
            continue
        if integ != "ok":
            raise SnapshotConflict("Le jalon de cette requête est altéré — rien n'a été recréé", code="snapshot_corrupt")
        if snap["project"]["id"] != pid or snap["label"] != label or snap["note"] != note:
            raise SnapshotConflict("Cette requête de jalon existe déjà avec un contenu différent", code="snapshot_request_conflict")
        return {"ok": True, "replayed": True, "snapshot": header(snap), "refs": ref_summary(snap), "bytes": len(_canon_bytes(snap))}
    return None


def create(data: Any) -> dict:
    hc = _hc()
    if not isinstance(data, dict):
        raise SnapshotError("Requête invalide")
    hc._only_keys(data, {"action", "project_id", "label", "note", "request_id"})
    pid = data.get("project_id")
    if not isinstance(pid, str) or not hc._ID_RE["proj"].match(pid):
        raise SnapshotError("Projet invalide")
    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not REQ_RE.match(request_id):
        raise SnapshotError("Identifiant de requête invalide")
    label = _clean_text(data.get("label"), LABEL_MAX, "Libellé", True)
    note = _clean_text(data.get("note"), NOTE_MAX, "Note", False)
    root = _root()
    import hq_carnet_sources as sources

    with store_lock(root):
        replay = _find_request(request_id, pid, label, note, confined_dir(root))  # a retry after a lost response: the ORIGINAL, no write
    if replay is not None:
        return replay
    with hq_state.path_lock(hc._path()):  # ONE consistent capture of the pages
        state = hc._load_locked(create=False)
        project = next((p for p in state["projects"] if p["id"] == pid), None)
        if project is None:
            raise hc.CarnetNotFound("Projet introuvable")
        import copy

        pages = copy.deepcopy([p for p in state["pages"] if p["project_id"] == pid and p["deleted_at"] is None])
        categories = copy.deepcopy(state["categories"])
        notebook_rev = state["notebook_rev"]
        captured_at = _now()
        project = copy.deepcopy(project)
    if not pages:
        raise SnapshotError("Ce projet ne contient aucune note à figer")
    try:
        with hq_state.path_lock(sources.confined_path()):
            sstate = copy.deepcopy(sources._load_locked())
    except sources.SourceStorageError as e:
        raise SnapshotStorageError(str(e), e.status) from e
    editions = {e["id"]: e for e in sstate["editions"]}
    snap = build(project, pages, categories, notebook_rev, editions, label, note, root, captured_at, request_id)  # hashing: no lock held
    raw = _canon_bytes(snap)
    if len(raw) > SNAPSHOT_BYTES_MAX:
        raise SnapshotConflict("Jalon trop volumineux — réduis le projet ou fige moins de notes")
    directory = confined_dir(root, create=True)
    with store_lock(root):
        replay = _find_request(request_id, pid, label, note, directory)  # a concurrent identical request may have published meanwhile
        if replay is not None:
            return replay
        total, per = _store_usage(directory)
        if per.get(pid, 0) >= PER_PROJECT_MAX:
            raise SnapshotConflict(f"Limite de {PER_PROJECT_MAX} jalons par projet atteinte")
        if total + len(raw) > STORE_BYTES_MAX:
            raise SnapshotConflict("Espace des jalons plein")
        _publish(directory, snap, raw)
    return {"ok": True, "snapshot": header(snap), "refs": ref_summary(snap), "bytes": len(raw)}


def ref_summary(snap: dict) -> dict:
    r = snap["refs"]
    out = {}
    for bucket in ("drawings", "assets", "voices", "files"):
        out[bucket] = {"total": len(r[bucket]), "missing": sum(1 for x in r[bucket] if x["state"] == "missing")}
    out["sources"] = {"total": len(r["sources"]), "missing": sum(1 for x in r["sources"] if x.get("state") == "missing")}
    return out


# ---------------------------------------------------------------- verify (re-hash the SAME references; on demand only)


def verify(snap_id: Any) -> dict:
    """Compare what the snapshot observed with what is canonical NOW: ``unchanged`` | ``modified`` | ``missing`` (was ok, gone)
    | ``still_missing`` | ``appeared`` (was missing, now present). An ambiguous read fails the call (503), never guesses."""
    got = get(snap_id)
    snap, root = got["snapshot"], _root()
    out: dict[str, list] = {}
    counts = {"unchanged": 0, "modified": 0, "missing": 0, "still_missing": 0, "appeared": 0}
    budget = _Budget()
    shapes = {"drawings": ("drawing", "stem"), "assets": ("asset", "id"), "voices": ("voice", "id"), "files": ("file", "path")}
    entries = []
    for bucket, (kind, field) in shapes.items():
        entries += [(bucket, kind, r[field], r) for r in snap["refs"][bucket]]
    for s in snap["refs"]["sources"]:
        if isinstance(s.get("file"), dict) and isinstance(s.get("file_ref"), str):
            entries.append(("sources", "file", s["file_ref"], dict(s["file"], id=s["id"])))
    for bucket, kind, ident, was in entries:
        now = _observe(_locate(kind, ident, root), budget)
        if was["state"] == "ok":
            status = "missing" if now["state"] == "missing" else ("unchanged" if (now["sha256"], now["size"]) == (was["sha256"], was["size"]) else "modified")
        else:
            status = "still_missing" if now["state"] == "missing" else "appeared"
        counts[status] += 1
        out.setdefault(bucket, []).append({"ref": ident, "status": status, "was": {k: was[k] for k in ("state", "sha256", "size")}, "now": now})
    return {"ok": True, "id": snap["id"], "integrity": got["integrity"], "refs": out, "counts": counts}


# ---------------------------------------------------------------- backup closure (read-only)


def closure(root: Path | str) -> dict:
    """What the backup must also carry for the stored snapshots: ``{"ids","voices","stems","files","valid"}``.
    ``valid`` is False when ANY snapshot is unreadable/invalid (the caller refuses retention rather than back up half a store)."""
    directory = snap_dir(root)
    assets: set[str] = set()
    voices: set[str] = set()
    stems: set[str] = set()
    files: list[str] = []
    valid = True
    try:
        confined_dir(root)
        with store_lock(root):
            for sid in _ids(directory):
                snap, integ = _read_one(directory, sid)
                if snap is None or integ != "ok":
                    valid = False
                    continue
                files.append(sid + ".json")
                # only what the snapshot observed PRESENT: a reference already missing at freeze time is not a backup failure
                assets.update(r["id"] for r in snap["refs"]["assets"] if r["state"] == "ok")
                voices.update(r["id"] for r in snap["refs"]["voices"] if r["state"] == "ok")
                stems.update(r["stem"] for r in snap["refs"]["drawings"] if r["state"] == "ok")
    except (SnapshotError, SnapshotStorageError):
        valid = False
    return {"assets": assets, "voices": voices, "stems": stems, "files": files, "valid": valid}


def copy_to(root: Path | str, dest: Path, names: list[str]) -> int:
    """Copy the named snapshot files byte-for-byte into ``dest`` (an existing directory). Returns the byte count."""
    directory = confined_dir(root)
    total = 0
    for name in names:
        if not name.endswith(".json") or not ID_RE.match(name[:-5]):
            continue
        raw = (directory / name).read_bytes()
        (dest / name).write_bytes(raw)
        total += len(raw)
    return total
