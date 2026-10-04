"""Carnet Phase 10: live evidence annotations — the store (mutable, user-authored, optimistic revisions). Stdlib only.

An annotation is COMMENTARY attached to canonical evidence. It is never part of the evidence and never mutates it: this module reads the
notebook and the sources list (read-only) to decide whether a target still exists, and writes only its own files.

Runtime state: ``<ROOT>/.hq-carnet/annotations/ant-<24 hex>.json``, ONE shard per target (the shard name is derived from the canonical
target), never mixed into the notebook / sources / snapshot / review files::

    {"schema": 1, "target": {...}, "records": [record, ...]}

Target = OWNERSHIP identity, nothing else (the anchor is "where the human was looking" and never part of identity or of the shard)::

    {"kind": "source", "source_id": "srce-..."}
    {"kind": "citation", "page_id": "page-...", "block_id": "block-...", "citation_fingerprint": "<sha256>"}

The citation fingerprint is SERVER-OWNED: the client submits the citation value it sees, the server canonicalizes it, confirms that exact
citation exists in that page / block, and only ``sha256(cite_key(...))`` is persisted. There is no ordinal: two identical citations in one
block are the same evidence value and share one target. There is no fuzzy matching, no retargeting, no "nearest clause".

Record (each carries its OWN ``rev`` and ``seal``, so one corrupt record never suppresses the others)::

    {"id", "rev", "project_id" (citations; null for a source), "source_id", "target", "anchor" (null | {"loc","pdf"}), "body", "status"
     (open | resolved: always manual), "request_id", "created_at", "updated_at", "seal"}

No author is stored (there is no identity system): annotations are unattributed within the local system.

Contract: every mutation but create carries ``expected_rev`` (409 ``annotation_conflict`` + ``current_rev`` on any mismatch; the losing text is
never stored; nothing is retried or merged). Create carries a ``request_id`` bound to ONE intent (target, anchor, body): same id + same
intent = the original record, same id + another intent = 409 ``annotation_request_conflict``. A record whose seal does not verify is
``corrupt``: listed, never edited, never repaired. Bounds: ``PER_TARGET_MAX`` per target, ``TOTAL_MAX`` per notebook, ``BODY_MAX`` code
points, ``LIST_MAX`` records and ``TARGETS_PER_LIST_MAX`` targets per list request; there is no notebook-wide scan endpoint.
Lock order: notebook / sources locks (target verification) -> released -> annotation-store lock.
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
from typing import Any

import hq_carnet_rich as rich
import hq_state

DIR_NAME = ".hq-carnet"
ANN_DIR = "annotations"
SCHEMA = 1
BODY_MAX = 4000
PER_TARGET_MAX = 100
TOTAL_MAX = 5000
LIST_MAX = 100
TARGETS_PER_LIST_MAX = 10
SHARD_BYTES_MAX = 8 * 1024 * 1024
STORE_BYTES_MAX = 100 * 1024 * 1024
STATUSES = ("open", "resolved")
SOURCE_STATES = ("available", "archived", "missing", "unknown")
CITATION_STATES = ("unchanged", "changed_or_removed", "unavailable")
ID_RE = re.compile(r"^ann-[0-9a-f]{24}\Z")
SHARD_RE = re.compile(r"^ant-[0-9a-f]{24}\Z")
REQ_RE = re.compile(r"^[0-9a-f]{32}\Z")
_SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
_CTRL_LINE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")  # a body may hold \n and \t
_ESCAPED = "Dossier des annotations redirigé — refusé"

_cb: dict[str, Any] = {}


class AnnotationError(ValueError):
    status = 400
    code = "validation_error"

    def __init__(self, message: str, code: str | None = None, status: int | None = None, **extra: Any):
        super().__init__(message)
        if code:
            self.code = code
        if status:
            self.status = status
        self.payload = {"error": message, "code": self.code, **extra}


class AnnotationNotFound(AnnotationError):
    status = 404
    code = "not_found"


class AnnotationConflict(AnnotationError):
    """409. ``annotation_conflict`` carries ``current_rev`` so the client can refresh explicitly; nothing is retried or merged."""

    status = 409
    code = "annotation_limit"


class AnnotationStorageError(RuntimeError):
    code = "annotations_unavailable"

    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status
        self.payload = {"error": message, "code": self.code}


def bind(**kwargs: Any) -> None:
    _cb.update(kwargs)


def _now() -> int:
    fn = _cb.get("now")
    return int(fn()) if callable(fn) else int(time.time())


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise AnnotationStorageError("Carnet non initialisé")
    return Path(os.path.abspath(os.fspath(root)))


def _hc():
    import hq_carnet

    return hq_carnet


# ---------------------------------------------------------------- shared confinement / publish (also used by the review-comment store)


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    junction = getattr(os.path, "isjunction", None)
    return bool(junction and junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def store_dir(root: Path | str | None, sub: str) -> Path:
    base = Path(os.path.abspath(os.fspath(root if root is not None else _root())))
    return base / DIR_NAME / sub


def confined_store(root: Path | str | None, sub: str, *, create: bool = False, escaped: str = _ESCAPED) -> Path:
    """``<root>/.hq-carnet/<sub>`` after refusing any redirection (symlink / junction / escape) of ``.hq-carnet`` or ``sub``."""
    target = store_dir(root, sub)
    base = target.parent
    try:
        real_root = os.path.realpath(base.parent)
        for index, item in enumerate((base, target)):
            if os.path.lexists(item):
                if _is_link(item) or not item.is_dir():
                    raise AnnotationStorageError(escaped, 409)
            elif create:
                item.mkdir()
            else:
                continue
            want = os.path.join(real_root, DIR_NAME) if index == 0 else os.path.join(real_root, DIR_NAME, sub)
            if _is_link(item) or not _same(os.path.realpath(item), want):
                raise AnnotationStorageError(escaped, 409)
    except OSError as e:
        raise AnnotationStorageError("Stockage inaccessible") from e
    return target


class Noncanonical(Exception):
    """The named store file is not a plain regular file of acceptable size (symlink, directory, device, oversize, or swapped while opening)."""


def read_regular(path: Path, limit: int) -> bytes:
    """Read ONE canonical store file bound to the descriptor actually opened: ``lstat`` (refuse symlink / non-regular / oversize), open with
    ``O_NOFOLLOW`` (+ ``O_NONBLOCK`` so a FIFO cannot hang us), ``fstat`` must be the SAME regular file (device + inode), and the bytes come from
    that descriptor only. ``FileNotFoundError`` = absent; anything redirected or swapped raises ``Noncanonical`` and is NEVER followed."""
    st = os.lstat(path)
    if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode) or st.st_size > limit + 4096:
        raise Noncanonical()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0)
    try:
        fd = os.open(path, flags)
    except FileNotFoundError:
        raise
    except OSError as e:  # ELOOP (symlink swapped in), ENXIO, EISDIR ...
        raise Noncanonical() from e
    try:
        fst = os.fstat(fd)
        if not _stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino) or fst.st_size > limit + 4096:
            raise Noncanonical()
        chunks, left = [], limit + 4097
        while left > 0:
            chunk = os.read(fd, min(left, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            left -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > limit + 4096:
            raise Noncanonical()
        return raw
    finally:
        os.close(fd)


def copy_canonical(directory: Path, dest: Path, names: list[str], name_ok, limit: int, refused: list | None = None) -> int:
    """Byte-for-byte copy of the named canonical files (each bound to its own opened descriptor). A redirected / replaced / vanished file is
    NEVER followed: it is skipped and named in ``refused`` (the caller then reports the backup as not valid). Corrupt-but-regular bytes copy as they are."""
    total = 0
    for name in names:
        if not name.endswith(".json") or not name_ok(name[:-5]):
            continue
        try:
            raw = read_regular(directory / name, limit)
        except (FileNotFoundError, Noncanonical, OSError):
            if refused is not None:
                refused.append(name)
            continue
        (dest / name).write_bytes(raw)
        total += len(raw)
    return total


def canon_bytes(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def publish(directory: Path, filename: str, raw: bytes, what: str) -> None:
    """Atomic write: unique O_EXCL temp file, fsync, replace, fsync of the directory. Refuses to replace a non-regular file."""
    final = directory / filename
    tmp = directory / (".tmp-" + filename + "-" + secrets.token_hex(4))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        if os.path.lexists(final):
            st = os.lstat(final)
            if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode):
                raise AnnotationStorageError(what + " non canonique — écriture refusée", 409)
        fd = os.open(tmp, flags, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, final)
    except AnnotationStorageError:
        raise
    except OSError as e:
        raise AnnotationStorageError("Écriture impossible — dernière version conservée") from e
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


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def body_text(value: Any, what: str) -> str:
    """Plain text only: no HTML / Markdown rendering is ever applied. ``BODY_MAX`` Unicode code points; ``\\n`` and ``\\t`` allowed, other
    control characters refused; a whitespace-only body is refused. The text is stored exactly as typed (never trimmed or rewritten)."""
    if not isinstance(value, str) or len(value) > BODY_MAX or _CTRL_LINE.search(value):
        raise AnnotationError(f"{what} invalide")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise AnnotationError(f"{what} invalide") from e
    if not value.strip():
        raise AnnotationError(f"{what} requis")
    return value


# ---------------------------------------------------------------- targets, anchors, fingerprints


def fingerprint(cite: dict) -> str:
    return hashlib.sha256(rich.cite_key(cite).encode("utf-8")).hexdigest()


def shard_id(target: dict) -> str:
    return "ant-" + hashlib.sha256(canon_bytes(target)).hexdigest()[:24]


def _target_ok(t: Any) -> bool:
    hc = _hc()
    if not isinstance(t, dict):
        return False
    if t.get("kind") == "source":
        return set(t) == {"kind", "source_id"} and isinstance(t["source_id"], str) and bool(rich._EDITION_ID_RE.match(t["source_id"]))
    if t.get("kind") == "citation":
        return (set(t) == {"kind", "page_id", "block_id", "citation_fingerprint"} and isinstance(t["page_id"], str) and bool(hc._ID_RE["page"].match(t["page_id"]))
                and isinstance(t["block_id"], str) and bool(hc._ID_RE["block"].match(t["block_id"]))
                and isinstance(t["citation_fingerprint"], str) and bool(_SHA_RE.match(t["citation_fingerprint"])))
    return False


def parse_target(raw: Any, *, allow_cite: bool) -> tuple[dict, dict | None]:
    """``(canonical target, canonical cite or None)``. A citation target arrives either as ``{..., "cite": <citation>}`` (the server
    fingerprints it: ``allow_cite``) or as ``{..., "citation_fingerprint"}`` (a locator for an existing record). Never both."""
    hc = _hc()
    if not isinstance(raw, dict):
        raise AnnotationError("Cible invalide")
    if raw.get("kind") == "source":
        t = {"kind": "source", "source_id": raw.get("source_id")}
        if set(raw) != {"kind", "source_id"} or not _target_ok(t):
            raise AnnotationError("Cible invalide")
        return t, None
    if raw.get("kind") != "citation":
        raise AnnotationError("Cible invalide")
    page_id, block_id = raw.get("page_id"), raw.get("block_id")
    if not isinstance(page_id, str) or not hc._ID_RE["page"].match(page_id) or not isinstance(block_id, str) or not hc._ID_RE["block"].match(block_id):
        raise AnnotationError("Cible invalide")
    if allow_cite and set(raw) == {"kind", "page_id", "block_id", "cite"}:
        try:
            cite = rich.check_cite(raw["cite"])
        except rich.ContentError as e:
            raise AnnotationError("Citation invalide") from e
        return {"kind": "citation", "page_id": page_id, "block_id": block_id, "citation_fingerprint": fingerprint(cite)}, cite
    t = {"kind": "citation", "page_id": page_id, "block_id": block_id, "citation_fingerprint": raw.get("citation_fingerprint")}
    if set(raw) != {"kind", "page_id", "block_id", "citation_fingerprint"} or not _target_ok(t):
        raise AnnotationError("Cible invalide")
    return t, None


def parse_anchor(raw: Any) -> dict | None:
    """``None`` | ``{"loc": str|None, "pdf": int|None}`` (at least one set). Anchors are commentary position only: never evidence."""
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {"loc", "pdf"}:
        raise AnnotationError("Ancrage invalide")
    try:
        loc = None if raw["loc"] is None else rich._cite_text(raw["loc"], rich.LOCATOR_TEXT_MAX, "Emplacement", required=True)
        pdf = rich._check_pdf(raw["pdf"])
    except rich.ContentError as e:
        raise AnnotationError("Ancrage invalide") from e
    if loc is None and pdf is None:
        return None
    return {"loc": loc, "pdf": pdf}


def _anchor_ok(a: Any) -> bool:
    try:
        return a is None or (a == parse_anchor(a) and a is not None)
    except AnnotationError:
        return False


# ---------------------------------------------------------------- records, seals, shards

REC_KEYS = {"id", "rev", "project_id", "source_id", "target", "anchor", "body", "status", "request_id", "created_at", "updated_at", "seal"}


def seal(rec: dict) -> str:
    return hashlib.sha256(canon_bytes({k: v for k, v in rec.items() if k != "seal"})).hexdigest()


def _rec_structure_ok(rec: Any, target: dict) -> bool:
    hc = _hc()
    if not isinstance(rec, dict) or set(rec) != REC_KEYS:
        return False
    try:
        return bool(
            isinstance(rec["id"], str) and ID_RE.match(rec["id"]) and _is_int(rec["rev"]) and rec["rev"] >= 1
            and (rec["project_id"] is None or (isinstance(rec["project_id"], str) and hc._ID_RE["proj"].match(rec["project_id"])))
            and isinstance(rec["source_id"], str) and rich._EDITION_ID_RE.match(rec["source_id"])
            and rec["target"] == target and _target_ok(rec["target"]) and _anchor_ok(rec["anchor"])
            and isinstance(rec["body"], str) and 0 < len(rec["body"]) <= BODY_MAX and not _CTRL_LINE.search(rec["body"]) and rec["body"].strip()
            and rec["status"] in STATUSES and isinstance(rec["request_id"], str) and REQ_RE.match(rec["request_id"])
            and _is_int(rec["created_at"]) and _is_int(rec["updated_at"]) and isinstance(rec["seal"], str) and _SHA_RE.match(rec["seal"])
        )
    except Exception:  # noqa: BLE001 - a hostile stored value is "invalid", never an exception
        return False


def record_state(rec: Any, target: dict) -> str:
    """``ok`` | ``corrupt`` (well-formed, seal does not verify) | ``invalid`` (malformed)."""
    if not _rec_structure_ok(rec, target):
        return "invalid"
    return "ok" if seal(rec) == rec["seal"] else "corrupt"


def _read_shard(directory: Path, sid: str) -> tuple[dict | None, str]:
    """``(shard or None, state)``: ``missing`` | ``ok`` | ``invalid`` (whole file malformed: preserved, never repaired). Unreadable raises."""
    path = directory / (sid + ".json")
    try:
        raw = read_regular(path, SHARD_BYTES_MAX)
    except FileNotFoundError:
        return None, "missing"
    except Noncanonical:
        return None, "invalid"
    except OSError as e:
        raise AnnotationStorageError("Annotations illisibles") from e
    try:
        shard = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "invalid"
    if (not isinstance(shard, dict) or set(shard) != {"schema", "target", "records"} or shard["schema"] != SCHEMA or not _target_ok(shard["target"])
            or shard_id(shard["target"]) != sid or not isinstance(shard["records"], list) or len(shard["records"]) > PER_TARGET_MAX):
        return None, "invalid"
    return shard, "ok"


def _shard_names(directory: Path) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise AnnotationStorageError("Annotations inaccessibles") from e
    return sorted(n[:-5] for n in names if n.endswith(".json") and SHARD_RE.match(n[:-5]))


def _write_shard(directory: Path, shard: dict, *, replacing: int = 0) -> None:
    sid = shard_id(shard["target"])
    if not shard["records"]:
        try:
            os.unlink(directory / (sid + ".json"))
        except FileNotFoundError:
            pass
        except OSError as e:
            raise AnnotationStorageError("Suppression impossible") from e
        return
    for rec in shard["records"]:
        if record_state(rec, shard["target"]) == "invalid":
            raise AnnotationStorageError("Annotation invalide — écriture refusée", 500)
    raw = canon_bytes(shard)
    if len(raw) > SHARD_BYTES_MAX:
        raise AnnotationConflict("Trop d'annotations volumineuses pour cette cible", code="annotation_too_large")
    if _store_bytes(directory) - replacing + len(raw) > STORE_BYTES_MAX:
        raise AnnotationConflict("Espace des annotations épuisé", code="annotation_store_full")
    publish(directory, sid + ".json", raw, "Annotations")


def _store_bytes(directory: Path) -> int:
    total = 0
    try:
        for n in os.listdir(directory):
            if n.endswith(".json"):
                try:
                    total += os.lstat(directory / n).st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


def _size(directory: Path, sid: str) -> int:
    try:
        return os.lstat(directory / (sid + ".json")).st_size
    except OSError:
        return 0


def store_lock(root: Path | str | None = None):
    return hq_state.path_lock(store_dir(root, ANN_DIR))


def _public(rec: dict, state: str) -> dict:
    return {k: rec[k] for k in ("id", "rev", "project_id", "source_id", "target", "anchor", "body", "status", "created_at", "updated_at")} | {"integrity": state}


def limits() -> dict:
    return {"body": BODY_MAX, "per_target": PER_TARGET_MAX, "total": TOTAL_MAX, "list": LIST_MAX, "targets_per_list": TARGETS_PER_LIST_MAX}


# ---------------------------------------------------------------- reading the target (read-only, never written)


def _notebook() -> dict:
    import hq_carnet_reviews as reviews

    return reviews._load_notebook()


def _editions() -> dict | None:
    import hq_carnet_review as review

    return review._editions()


def _find_block(state: dict, page_id: str, block_id: str) -> tuple[str, dict | None, str | None]:
    """``("page_missing" | "block_missing" | "ok", block, project_id)``."""
    page = next((p for p in state["pages"] if p["id"] == page_id and p.get("deleted_at") is None), None)
    if page is None:
        return "page_missing", None, None
    content = page.get("content") or {}
    if content.get("version") != rich.CONTENT_VERSION:
        return "block_missing", None, page["project_id"]
    block = next((b for b in content.get("blocks", []) if b.get("id") == block_id), None)
    return ("ok", block, page["project_id"]) if block is not None else ("block_missing", None, page["project_id"])


def _block_cites(block: dict) -> list[dict]:
    return [m["cite"] for m in (block.get("marks") or []) if isinstance(m, dict) and m.get("type") == "citation" and isinstance(m.get("cite"), dict)]


def citation_state(state: dict, target: dict) -> tuple[str, int]:
    """``(unchanged | changed_or_removed | unavailable, identical_count)``. No guessing: 'changed' and 'removed' cannot be told apart
    without a heuristic, so they are one state, and nothing is ever retargeted to a similar citation."""
    where, block, _pid = _find_block(state, target["page_id"], target["block_id"])
    if where != "ok" or block is None:
        return "unavailable", 0
    n = sum(1 for c in _block_cites(block) if fingerprint(c) == target["citation_fingerprint"])
    return ("unchanged", n) if n else ("changed_or_removed", 0)


def source_state(editions: dict | None, source_id: str) -> str:
    if editions is None:
        return "unknown"
    ed = editions.get(source_id)
    if ed is None:
        return "missing"
    return "archived" if ed.get("archived") else "available"


# ---------------------------------------------------------------- list (read-only, batched by target)


def _check_keys(data: dict, allowed: set[str]) -> None:
    _hc()._only_keys(data, allowed)


def list_targets(data: Any) -> dict:
    """READ-ONLY. ``{action, targets:[...]}`` (1..TARGETS_PER_LIST_MAX targets) -> one result per target, in request order, with the target
    state observed NOW. At most ``LIST_MAX`` records are returned per request (``truncated`` says so)."""
    if not isinstance(data, dict) or set(data) != {"action", "targets"} or not isinstance(data["targets"], list) or not (1 <= len(data["targets"]) <= TARGETS_PER_LIST_MAX):
        raise AnnotationError("Requête invalide")
    targets = []
    for raw in data["targets"]:
        t, _cite = parse_target(raw, allow_cite=True)
        if t not in targets:
            targets.append(t)
    root = _root()
    directory = confined_store(root, ANN_DIR)
    nb = _notebook() if any(t["kind"] == "citation" for t in targets) else None
    editions = _editions() if any(t["kind"] == "source" for t in targets) else None
    out, left, truncated = [], LIST_MAX, False
    for t in targets:
        with store_lock(root):
            shard, st = _read_shard(directory, shard_id(t))
        rows, unavailable = [], 0
        if st == "invalid":
            unavailable = 1
        elif shard is not None:
            for rec in shard["records"]:
                state = record_state(rec, t)
                if state == "invalid":
                    unavailable += 1
                    continue
                if left <= 0:
                    truncated = True
                    continue
                rows.append(_public(rec, state))
                left -= 1
        rows.sort(key=lambda r: (r["status"] != "open", -r["updated_at"], r["id"]))  # open first
        if t["kind"] == "source":
            res = {"target": t, "target_state": source_state(editions, t["source_id"]), "identical_count": None}
        else:
            ts, n = citation_state(nb, t)
            res = {"target": t, "target_state": ts, "identical_count": n}
        out.append({**res, "annotations": rows, "unavailable": unavailable})
    return {"ok": True, "read_only": True, "results": out, "truncated": truncated, "limits": limits()}


# ---------------------------------------------------------------- mutations


def _find_request(directory: Path, request_id: str, intent: tuple) -> dict | None:
    for sid in _shard_names(directory):
        shard, st = _read_shard(directory, sid)
        if shard is None:
            continue
        for rec in shard["records"]:
            if isinstance(rec, dict) and rec.get("request_id") == request_id:
                state = record_state(rec, shard["target"])
                if state == "invalid":
                    continue
                stored = (canon_bytes(rec["target"]), canon_bytes(rec["anchor"]), rec["body"])
                if stored != intent:
                    raise AnnotationConflict("Cette requête d'annotation existe déjà avec un autre contenu", code="annotation_request_conflict")
                return {"ok": True, "replayed": True, "annotation": _public(rec, state)}
    return None


def _total(directory: Path) -> int:
    n = 0
    for sid in _shard_names(directory):
        shard, _st = _read_shard(directory, sid)
        if shard is not None:
            n += len(shard["records"])
    return n


def _create(data: dict) -> dict:
    _check_keys(data, {"action", "request_id", "target", "anchor", "body"})
    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not REQ_RE.match(request_id):
        raise AnnotationError("Identifiant de requête invalide")
    target, cite = parse_target(data.get("target"), allow_cite=True)
    if target["kind"] == "citation" and cite is None:
        raise AnnotationError("Citation requise")  # a fingerprint alone is never authority for a NEW annotation
    anchor = parse_anchor(data.get("anchor"))
    body = body_text(data.get("body"), "Annotation")
    intent = (canon_bytes(target), canon_bytes(anchor), body)
    root = _root()
    directory = confined_store(root, ANN_DIR)
    with store_lock(root):
        replay = _find_request(directory, request_id, intent)
    if replay is not None:
        return replay
    project_id: str | None = None
    if target["kind"] == "citation":
        where, block, project_id = _find_block(_notebook(), target["page_id"], target["block_id"])
        if where != "ok" or block is None or not any(fingerprint(c) == target["citation_fingerprint"] for c in _block_cites(block)):
            raise AnnotationNotFound("Cette citation n'existe plus dans ce bloc — rien n'est annoté", code="annotation_target_unavailable")
        source_id = cite["src"]  # type: ignore[index]
    else:
        editions = _editions()
        if editions is None:
            raise AnnotationStorageError("Sources inaccessibles — annotation impossible", 503)
        if target["source_id"] not in editions:
            raise AnnotationNotFound("Source introuvable", code="annotation_target_unavailable")
        source_id = target["source_id"]
    directory = confined_store(root, ANN_DIR, create=True)
    with store_lock(root):
        replay = _find_request(directory, request_id, intent)
        if replay is not None:
            return replay
        sid = shard_id(target)
        shard, st = _read_shard(directory, sid)
        if st == "invalid":
            raise AnnotationStorageError("Annotations de cette cible invalides — conservées telles quelles", 503)
        if shard is None:
            shard = {"schema": SCHEMA, "target": target, "records": []}
        if len(shard["records"]) >= PER_TARGET_MAX:
            raise AnnotationConflict(f"Limite atteinte : {PER_TARGET_MAX} annotations par cible", code="annotation_limit")
        if _total(directory) >= TOTAL_MAX:
            raise AnnotationConflict(f"Limite atteinte : {TOTAL_MAX} annotations", code="annotation_limit")
        now = _now()
        rec = {
            "id": "ann-" + secrets.token_hex(12), "rev": 1, "project_id": project_id, "source_id": source_id, "target": target, "anchor": anchor,
            "body": body, "status": "open", "request_id": request_id, "created_at": now, "updated_at": now, "seal": "0" * 64,
        }
        rec["seal"] = seal(rec)
        shard["records"].append(rec)
        _write_shard(directory, shard, replacing=_size(directory, sid))
    return {"ok": True, "replayed": False, "annotation": _public(rec, "ok")}


def _req_rev(data: dict) -> int:
    rev = data.get("expected_rev")
    if not _is_int(rev) or rev < 1:
        raise AnnotationError("expected_rev invalide")
    return rev


def _req_id(data: dict) -> str:
    value = data.get("id")
    if not isinstance(value, str) or not ID_RE.match(value):
        raise AnnotationError("Annotation invalide")
    return value


def _locked_record(data: dict, fn) -> dict:
    """Locate ONE record (shard from the supplied locator, record by id), refuse a stale ``expected_rev`` (409 + current_rev, nothing
    retried), apply ``fn(shard, index, rec, now)`` and publish atomically."""
    aid = _req_id(data)
    target, _ = parse_target(data.get("target"), allow_cite=False)
    expected = _req_rev(data)
    root = _root()
    directory = confined_store(root, ANN_DIR)
    with store_lock(root):
        sid = shard_id(target)
        shard, st = _read_shard(directory, sid)
        if st == "invalid":
            raise AnnotationStorageError("Annotations de cette cible invalides — conservées telles quelles", 503)
        idx = None if shard is None else next((i for i, r in enumerate(shard["records"]) if isinstance(r, dict) and r.get("id") == aid), None)
        if shard is None or idx is None:
            raise AnnotationNotFound("Annotation introuvable")
        rec = shard["records"][idx]
        state = record_state(rec, target)
        if state == "invalid":
            raise AnnotationStorageError("Annotation invalide — conservée telle quelle", 503)
        if rec["rev"] != expected:
            raise AnnotationConflict("L'annotation a changé depuis ta lecture — recharge-la", code="annotation_conflict", current_rev=rec["rev"])
        now = _now()
        before = _size(directory, sid)
        fn(shard, idx, rec, now, state)
        _write_shard(directory, shard, replacing=before)
        out = shard["records"][idx] if idx < len(shard["records"]) and shard["records"][idx].get("id") == aid else None
    return {"ok": True, "annotation": _public(out, "ok") if out else None, "deleted": aid if out is None else None}


def _update(data: dict) -> dict:
    _check_keys(data, {"action", "id", "target", "expected_rev", "body", "status", "anchor"})
    changes = {k for k in ("body", "status", "anchor") if k in data}
    if not changes:
        raise AnnotationError("Rien à modifier")
    body = body_text(data["body"], "Annotation") if "body" in data else None
    status = data.get("status")
    if "status" in data and status not in STATUSES:
        raise AnnotationError("Statut invalide")
    anchor = parse_anchor(data["anchor"]) if "anchor" in data else None

    def apply(shard: dict, idx: int, rec: dict, now: int, state: str) -> None:
        if state != "ok":
            raise AnnotationConflict("Annotation altérée — lecture seule, rien n'est modifié", code="annotation_corrupt")
        new = dict(rec)
        if body is not None:
            new["body"] = body
        if "status" in data:
            new["status"] = status  # explicit user action: nothing else ever writes this field
        if "anchor" in data:
            new["anchor"] = anchor
        new["rev"] = rec["rev"] + 1
        new["updated_at"] = max(now, rec["updated_at"])
        new["seal"] = seal(new)
        shard["records"][idx] = new

    return _locked_record(data, apply)


def _delete(data: dict) -> dict:
    _check_keys(data, {"action", "id", "target", "expected_rev", "confirm"})
    if data.get("confirm") is not True:
        raise AnnotationError("Suppression à confirmer")

    def apply(shard: dict, idx: int, rec: dict, now: int, state: str) -> None:
        if state != "ok":  # deletion is a mutation: the integrity boundary is enforced here, not by the UI
            raise AnnotationConflict("Annotation altérée — lecture seule, rien n'est modifié", code="annotation_corrupt")
        del shard["records"][idx]  # ONLY the annotation: never the citation, source, PDF, page, block or any review

    return _locked_record(data, apply)


ACTIONS = {"annotation_create": _create, "annotation_update": _update, "annotation_delete": _delete, "annotation_list": list_targets}


def mutate(data: Any) -> dict:
    if not isinstance(data, dict) or data.get("action") not in ACTIONS:
        raise AnnotationError("Action inconnue")
    return ACTIONS[data["action"]](data)


# ---------------------------------------------------------------- backup closure (read-only)


def closure(root: Path | str) -> dict:
    """The shard files a backup must carry, byte-for-byte: ``{"files", "valid"}``. EVERY ``ant-*.json`` is carried (a corrupt or invalid
    record is user data too); ``valid`` is False when any shard or record does not verify. Nothing referenced (source, PDF, page) is followed."""
    directory = store_dir(root, ANN_DIR)
    files: list[str] = []
    valid = True
    try:
        confined_store(root, ANN_DIR)
        with store_lock(root):
            for sid in _shard_names(directory):
                shard, st = _read_shard(directory, sid)
                files.append(sid + ".json")
                if shard is None:
                    valid = False
                    continue
                if any(record_state(r, shard["target"]) != "ok" for r in shard["records"]):
                    valid = False
    except (AnnotationError, AnnotationStorageError):
        valid = False
    return {"files": files, "valid": valid}


def copy_to(root: Path | str, dest: Path, names: list[str], refused: list | None = None) -> int:
    """Copy the named shard files byte-for-byte into ``dest`` (an existing directory). Returns the byte count; redirected files go to ``refused``."""
    directory = confined_store(root, ANN_DIR)
    with store_lock(root):
        return copy_canonical(directory, dest, names, SHARD_RE.match, SHARD_BYTES_MAX, refused)
