"""Carnet Phase 7: review packs — the store (mutable, user-authored, optimistic revisions). Stdlib only.

Runtime state: ``<ROOT>/.hq-carnet/reviews/<rvw-id>.json``, ONE file per pack, never mixed into the notebook file.

What a pack IS: an explicit, user-created collection of evidence for ONE engineering review of ONE project. It stores bounded review
metadata (title, note, status), the items the user selected (each = a canonical identity + a seal taken by the SERVER at selection
time + a bounded, clearly captured display copy), a manual checklist and manual open questions.

What it is NOT: a copy of the notebook, a dashboard, an approval engine. ``status`` is set only by an explicit user action; nothing
here (and nothing in ``hq_carnet_evidence``) infers status, approval, risk, completion or resolution from evidence, checklists or
freshness. The stored item answers "what did I review?"; ``hq_carnet_evidence.freshness`` answers "what exists now?" and never writes.

Contract: every mutation carries ``expected_rev`` (409 on any mismatch, never retried, never merged), is applied to ONE pack under the
store lock, re-validated as a whole, sealed (``content_sha256``) and published atomically (unique O_EXCL temp file, fsync, replace).
A pack whose seal does not verify is listed ``corrupt``: readable for forensics, never edited, never repaired. A structurally invalid
file is listed ``invalid`` and preserved byte-for-byte.

Bounds: ``PER_PROJECT_MAX`` packs per project, ``ITEMS_MAX`` items, ``CHECKS_MAX`` checklist entries, ``QUESTIONS_MAX`` questions,
``REFS_MAX`` evidence refs per entry, ``PACK_BYTES_MAX`` serialized bytes per pack, ``ITEM_BYTES_MAX`` per item, ``STORE_BYTES_MAX`` overall.
Lock order: notebook / sources / snapshot locks (inside the evidence resolver) -> released -> review-store lock.
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

import hq_state

DIR_NAME = ".hq-carnet"
REV_DIR = "reviews"
VERSION = 1
PER_PROJECT_MAX = 100
ITEMS_MAX = 250
CHECKS_MAX = 100
QUESTIONS_MAX = 100
REFS_MAX = 20
SUPERSEDES_MAX = 5
TITLE_MAX = 120
NOTE_MAX = 2000
CHECK_TEXT_MAX = 500
QUESTION_TEXT_MAX = 1000
RESOLUTION_MAX = 1000
LABEL_MAX = 240
PACK_BYTES_MAX = 2 * 1024 * 1024
ITEM_BYTES_MAX = 16 * 1024
STORE_BYTES_MAX = 100 * 1024 * 1024
STATUSES = ("draft", "in_review", "needs_followup", "reviewed")
QUESTION_STATES = ("open", "resolved")
ITEM_KINDS = ("page", "block", "decision", "measurement", "drawing", "source", "snapshot", "project_overview", "ask_result", "diff")
# per kind: the exact key fields (identity) and seal fields (what the SERVER observed at selection)
KIND_FIELDS: dict[str, tuple[frozenset, frozenset]] = {
    "page": (frozenset({"page_id"}), frozenset({"content_sha256", "rev"})),
    "block": (frozenset({"page_id", "block_id"}), frozenset({"block_sha256", "type"})),
    "decision": (frozenset({"page_id", "block_id"}), frozenset({"block_sha256", "type"})),
    "measurement": (frozenset({"page_id", "block_id"}), frozenset({"block_sha256", "type"})),
    "drawing": (frozenset({"stem"}), frozenset({"sha256", "size"})),
    "source": (frozenset({"edition_id"}), frozenset({"metadata_sha256"})),
    "snapshot": (frozenset({"snapshot_id"}), frozenset({"content_sha256"})),
    "project_overview": (frozenset({"project_id", "snapshot_id"}), frozenset({"fingerprint"})),
    "ask_result": (frozenset({"question", "scope", "limit"}), frozenset({"fingerprint"})),
    "diff": (frozenset({"base", "to", "page_id", "project_id"}), frozenset({"diff_sha256", "target"})),
}
ID_RE = re.compile(r"^rvw-[0-9a-f]{24}\Z")
ITEM_ID_RE = re.compile(r"^ri-[0-9a-f]{16}\Z")
CHECK_ID_RE = re.compile(r"^rc-[0-9a-f]{16}\Z")
QUESTION_ID_RE = re.compile(r"^rq-[0-9a-f]{16}\Z")
REQ_RE = re.compile(r"^[0-9a-f]{32}\Z")
_SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
_CTRL_LINE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")  # a note may hold \n and \t
_CTRL_ONE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ESCAPED = "Dossier des revues redirigé — refusé"

_cb: dict[str, Any] = {}


class ReviewError(ValueError):
    status = 400
    code = "validation_error"


class ReviewNotFound(ReviewError):
    status = 404
    code = "not_found"


class ReviewConflict(ReviewError):
    """409. ``review_conflict`` carries the server revision so the client can reload explicitly; nothing is retried or merged."""

    status = 409
    code = "review_limit"

    def __init__(self, message: str, code: str | None = None, **extra: Any):
        super().__init__(message)
        if code:
            self.code = code
        self.payload = {"error": message, "code": self.code, **extra}


class ReviewStorageError(RuntimeError):
    code = "reviews_unavailable"

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
        raise ReviewStorageError("Carnet non initialisé")
    return Path(os.path.abspath(os.fspath(root)))


def _hc():
    import hq_carnet

    return hq_carnet


# ---------------------------------------------------------------- confinement


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    junction = getattr(os.path, "isjunction", None)
    return bool(junction and junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def rev_dir(root: Path | str | None = None) -> Path:
    base = Path(os.path.abspath(os.fspath(root if root is not None else _root())))
    return base / DIR_NAME / REV_DIR


def confined_dir(root: Path | str | None = None, *, create: bool = False) -> Path:
    """``rev_dir`` after refusing any redirection (symlink/junction/escape) of ``.hq-carnet`` or ``reviews``."""
    target = rev_dir(root)
    base = target.parent
    try:
        real_root = os.path.realpath(base.parent)
        for index, item in enumerate((base, target)):
            if os.path.lexists(item):
                if _is_link(item) or not item.is_dir():
                    raise ReviewStorageError(_ESCAPED, 409)
            elif create:
                item.mkdir()
            else:
                continue
            want = os.path.join(real_root, DIR_NAME) if index == 0 else os.path.join(real_root, DIR_NAME, REV_DIR)
            if _is_link(item) or not _same(os.path.realpath(item), want):
                raise ReviewStorageError(_ESCAPED, 409)
    except OSError as e:
        raise ReviewStorageError("Revues inaccessibles") from e
    return target


def store_lock(root: Path | str | None = None):
    return hq_state.path_lock(rev_dir(root))


# ---------------------------------------------------------------- canonical bytes and seal


def canon_bytes(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode("ascii")


def seal(pack: dict) -> str:
    return hashlib.sha256(canon_bytes({k: v for k, v in pack.items() if k != "content_sha256"})).hexdigest()


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _text(value: Any, limit: int, what: str, *, required: bool = False, multiline: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str) or len(value) > limit or (_CTRL_LINE if multiline else _CTRL_ONE).search(value):
        raise ReviewError(f"{what} invalide")
    value = value.strip()
    if required and not value:
        raise ReviewError(f"{what} requis")
    return value


# ---------------------------------------------------------------- validation of STORED packs


def _json_value_ok(value: Any, depth: int = 0) -> bool:
    if depth > 8:
        return False
    if value is None or isinstance(value, (str, bool)) or _is_int(value):
        return True
    if isinstance(value, float):
        return value == value and value not in (float("inf"), float("-inf"))
    if isinstance(value, list):
        return len(value) <= 2000 and all(_json_value_ok(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return len(value) <= 200 and all(isinstance(k, str) and _json_value_ok(v, depth + 1) for k, v in value.items())
    return False


def _scope_ok(scope: Any) -> bool:
    if not isinstance(scope, dict):
        return False
    if scope == {"kind": "live"}:
        return True
    return (set(scope) == {"kind", "id", "seal"} and scope["kind"] == "snapshot" and isinstance(scope["id"], str) and bool(_hc().snapshots.ID_RE.match(scope["id"]))
            and isinstance(scope["seal"], str) and bool(_SHA_RE.match(scope["seal"])))


def _baseline_ok(b: Any) -> bool:
    if b == {"kind": "live"}:
        return True
    return (isinstance(b, dict) and set(b) == {"kind", "snapshot_id", "seal", "label"} and b["kind"] == "snapshot" and isinstance(b["snapshot_id"], str)
            and bool(_hc().snapshots.ID_RE.match(b["snapshot_id"])) and isinstance(b["seal"], str) and bool(_SHA_RE.match(b["seal"]))
            and isinstance(b["label"], str) and len(b["label"]) <= 200)


def _item_ok(it: Any) -> bool:
    if not isinstance(it, dict) or set(it) != {"id", "kind", "added_at", "scope", "label", "key", "seal", "copy", "supersedes"}:
        return False
    if not isinstance(it["id"], str) or not ITEM_ID_RE.match(it["id"]) or it["kind"] not in ITEM_KINDS or not _is_int(it["added_at"]):
        return False
    if not _scope_ok(it["scope"]) or not isinstance(it["label"], str) or len(it["label"]) > LABEL_MAX:
        return False
    key_fields, seal_fields = KIND_FIELDS[it["kind"]]
    if not isinstance(it["key"], dict) or set(it["key"]) != key_fields or not isinstance(it["seal"], dict) or set(it["seal"]) != seal_fields:
        return False
    if not _json_value_ok(it["key"]) or not _json_value_ok(it["seal"]) or not (it["copy"] is None or (isinstance(it["copy"], dict) and _json_value_ok(it["copy"]))):
        return False
    sup = it["supersedes"]
    if not isinstance(sup, list) or len(sup) > SUPERSEDES_MAX or (sup and it["kind"] != "ask_result"):
        return False
    for s in sup:
        if not isinstance(s, dict) or set(s) != {"fingerprint", "replaced_at"} or not isinstance(s["fingerprint"], str) or not _is_int(s["replaced_at"]):
            return False
    return len(canon_bytes(it)) <= ITEM_BYTES_MAX + 1024


def _refs_ok(refs: Any, item_ids: set[str]) -> bool:
    return isinstance(refs, list) and len(refs) <= REFS_MAX and len(set(refs)) == len(refs) and all(isinstance(r, str) and r in item_ids for r in refs)


def validate(pack: Any, expected_id: str | None = None) -> dict:
    """Strict structural validation of a stored pack. Raises ``ReviewError``; never repairs."""
    bad = ReviewError("Revue invalide")
    keys = {"version", "id", "rev", "project_id", "title", "note", "status", "created_at", "updated_at", "request_id", "baseline", "items", "checklist", "questions", "content_sha256"}
    if not isinstance(pack, dict) or set(pack) != keys:
        raise bad
    if pack["version"] != VERSION or not isinstance(pack["id"], str) or not ID_RE.match(pack["id"]) or (expected_id and pack["id"] != expected_id):
        raise bad
    if not _is_int(pack["rev"]) or pack["rev"] < 1 or not isinstance(pack["project_id"], str) or not _hc()._ID_RE["proj"].match(pack["project_id"]):
        raise bad
    if not isinstance(pack["title"], str) or not pack["title"] or len(pack["title"]) > TITLE_MAX or not isinstance(pack["note"], str) or len(pack["note"]) > NOTE_MAX:
        raise bad
    if pack["status"] not in STATUSES or not _is_int(pack["created_at"]) or not _is_int(pack["updated_at"]):
        raise bad
    if not isinstance(pack["request_id"], str) or not REQ_RE.match(pack["request_id"]) or not _baseline_ok(pack["baseline"]):
        raise bad
    if not isinstance(pack["items"], list) or len(pack["items"]) > ITEMS_MAX or not all(_item_ok(i) for i in pack["items"]):
        raise bad
    ids = [i["id"] for i in pack["items"]]
    if len(set(ids)) != len(ids):
        raise bad
    item_ids = set(ids)
    if not isinstance(pack["checklist"], list) or len(pack["checklist"]) > CHECKS_MAX or not isinstance(pack["questions"], list) or len(pack["questions"]) > QUESTIONS_MAX:
        raise bad
    seen: set[str] = set()
    for c in pack["checklist"]:
        if (not isinstance(c, dict) or set(c) != {"id", "text", "checked", "refs", "created_at", "updated_at"} or not isinstance(c["id"], str) or not CHECK_ID_RE.match(c["id"])
                or c["id"] in seen or not isinstance(c["text"], str) or not c["text"] or len(c["text"]) > CHECK_TEXT_MAX or not isinstance(c["checked"], bool)
                or not _refs_ok_stored(c["refs"]) or not _is_int(c["created_at"]) or not _is_int(c["updated_at"])):
            raise bad
        seen.add(c["id"])
    seen = set()
    for q in pack["questions"]:
        if (not isinstance(q, dict) or set(q) != {"id", "text", "state", "resolution_note", "refs", "created_at", "updated_at"} or not isinstance(q["id"], str)
                or not QUESTION_ID_RE.match(q["id"]) or q["id"] in seen or not isinstance(q["text"], str) or not q["text"] or len(q["text"]) > QUESTION_TEXT_MAX
                or q["state"] not in QUESTION_STATES or not isinstance(q["resolution_note"], str) or len(q["resolution_note"]) > RESOLUTION_MAX
                or not _refs_ok_stored(q["refs"]) or not _is_int(q["created_at"]) or not _is_int(q["updated_at"])):
            raise bad
        seen.add(q["id"])
    if not isinstance(pack["content_sha256"], str) or not _SHA_RE.match(pack["content_sha256"]):
        raise bad
    return pack


def _refs_ok_stored(refs: Any) -> bool:
    # stored refs may dangle after an item was removed (shown as such); they must still be well-formed, unique and bounded
    return isinstance(refs, list) and len(refs) <= REFS_MAX and len(set(refs)) == len(refs) and all(isinstance(r, str) and ITEM_ID_RE.match(r) for r in refs)


# ---------------------------------------------------------------- reading


def _read_one(directory: Path, rid: str) -> tuple[dict | None, str]:
    """``(pack or None, integrity)`` with integrity ``ok`` | ``corrupt`` | ``invalid``. Unreadable bytes raise."""
    path = directory / (rid + ".json")
    try:
        st = os.lstat(path)
        if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode) or st.st_size > PACK_BYTES_MAX + 4096:
            return None, "invalid"
        raw = path.read_bytes()
    except FileNotFoundError as e:
        raise ReviewNotFound("Revue introuvable") from e
    except OSError as e:
        raise ReviewStorageError("Revue illisible") from e
    try:
        data = json.loads(raw.decode("utf-8"))
        validate(data, rid)
    except (UnicodeDecodeError, json.JSONDecodeError, ReviewError):
        return None, "invalid"
    return data, ("ok" if seal(data) == data["content_sha256"] else "corrupt")


def _ids(directory: Path) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise ReviewStorageError("Revues inaccessibles") from e
    return sorted(n[:-5] for n in names if n.endswith(".json") and ID_RE.match(n[:-5]))


def header(pack: dict, integrity: str = "ok") -> dict:
    return {
        "id": pack["id"], "project_id": pack["project_id"], "title": pack["title"], "status": pack["status"], "rev": pack["rev"],
        "created_at": pack["created_at"], "updated_at": pack["updated_at"], "baseline": pack["baseline"]["kind"],
        "items": len(pack["items"]), "checklist": len(pack["checklist"]), "checked": sum(1 for c in pack["checklist"] if c["checked"]),
        "questions": len(pack["questions"]), "open_questions": sum(1 for q in pack["questions"] if q["state"] == "open"), "integrity": integrity,
    }


def limits() -> dict:
    return {
        "per_project": PER_PROJECT_MAX, "items": ITEMS_MAX, "checklist": CHECKS_MAX, "questions": QUESTIONS_MAX, "refs": REFS_MAX,
        "title": TITLE_MAX, "note": NOTE_MAX, "check_text": CHECK_TEXT_MAX, "question_text": QUESTION_TEXT_MAX, "item_bytes": ITEM_BYTES_MAX,
        "pack_bytes": PACK_BYTES_MAX, "store_bytes": STORE_BYTES_MAX,
    }


def list_reviews(project_id: str | None = None) -> dict:
    root = _root()
    directory = confined_dir(root)
    with store_lock(root):
        rows, unavailable = [], []
        for rid in _ids(directory):
            try:
                pack, integ = _read_one(directory, rid)
            except ReviewNotFound:
                continue
            if pack is None:
                unavailable.append({"id": rid, "integrity": "invalid"})  # preserved, never repaired, never hidden
                continue
            if project_id is None or pack["project_id"] == project_id:
                rows.append(header(pack, integ))
    rows.sort(key=lambda r: (-r["updated_at"], r["id"]))
    return {"ok": True, "reviews": rows, "unavailable": unavailable, "limits": limits()}


def get(review_id: Any) -> dict:
    """``{"review": pack, "integrity": ok|corrupt}``; a structurally invalid file is a 503 (kept as found)."""
    if not isinstance(review_id, str) or not ID_RE.match(review_id):
        raise ReviewNotFound("Revue introuvable")
    root = _root()
    directory = confined_dir(root)
    with store_lock(root):
        pack, integ = _read_one(directory, review_id)
    if pack is None:
        raise ReviewStorageError("Revue invalide — conservée telle quelle", 503)
    return {"review": pack, "integrity": integ}


# ---------------------------------------------------------------- writing (atomic, one pack)


def _store_bytes(directory: Path) -> int:
    total = 0
    for rid in _ids(directory):
        try:
            total += os.lstat(directory / (rid + ".json")).st_size
        except OSError as e:
            raise ReviewStorageError("Revues inaccessibles") from e
    return total


def _publish(directory: Path, pack: dict, raw: bytes) -> None:
    final = directory / (pack["id"] + ".json")
    tmp = directory / (".tmp-" + pack["id"] + "-" + secrets.token_hex(4))
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        if os.path.lexists(final):
            st = os.lstat(final)
            if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode):
                raise ReviewStorageError("Revue non canonique — écriture refusée", 409)
        fd = os.open(tmp, flags, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, final)
    except ReviewStorageError:
        raise
    except OSError as e:
        raise ReviewStorageError("Écriture de la revue impossible — dernière version conservée") from e
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


def _write(directory: Path, pack: dict, *, replacing: int = 0) -> dict:
    pack["content_sha256"] = seal(pack)
    validate(pack, pack["id"])
    raw = canon_bytes(pack)
    if len(raw) > PACK_BYTES_MAX:
        raise ReviewConflict("Revue trop volumineuse — retire des preuves ou des notes", code="review_too_large")
    if _store_bytes(directory) - replacing + len(raw) > STORE_BYTES_MAX:
        raise ReviewConflict("Espace des revues épuisé", code="review_store_full")
    _publish(directory, pack, raw)
    return pack


# ---------------------------------------------------------------- the actions


def _new_id(prefix: str, nbytes: int) -> str:
    return prefix + secrets.token_hex(nbytes)


def _only(data: dict, allowed: set[str]) -> None:
    _hc()._only_keys(data, allowed)


def _req_rev(data: dict) -> int:
    rev = data.get("expected_rev")
    if not _is_int(rev) or rev < 1:
        raise ReviewError("expected_rev invalide")
    return rev


def _req_id(data: dict, key: str, regex: re.Pattern, what: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not regex.match(value):
        raise ReviewError(f"{what} invalide")
    return value


def _refs(value: Any, item_ids: set[str]) -> list[str]:
    if value is None:
        return []
    if not _refs_ok(value, item_ids):
        raise ReviewError("Références de preuves invalides (preuves de cette revue uniquement, 20 au plus)")
    return list(value)


def _project_exists(project_id: str) -> None:
    hc = _hc()
    state = _load_notebook()
    if not any(p["id"] == project_id for p in state["projects"]):
        raise hc.CarnetNotFound("Projet introuvable")


def _load_notebook() -> dict:
    import copy

    hc = _hc()
    with hq_state.path_lock(hc._path()):
        return copy.deepcopy(hc._load_locked(create=False))


def _baseline_from(raw: Any, project_id: str) -> dict:
    """``{"kind":"live"}`` or a snapshot baseline — the snapshot must verify (a corrupt seal is never a NEW baseline)."""
    if raw is None or raw == {"kind": "live"}:
        return {"kind": "live"}
    if not isinstance(raw, dict) or set(raw) != {"kind", "snapshot_id"} or raw["kind"] != "snapshot":
        raise ReviewError("Contexte invalide")
    snaps = _hc().snapshots
    got = snaps.get(raw["snapshot_id"])
    if got["integrity"] != "ok":
        raise snaps.SnapshotStorageError("Intégrité du jalon compromise — il ne peut pas servir de contexte", 503)
    snap = got["snapshot"]
    if snap["project"]["id"] != project_id:
        raise ReviewError("Le jalon appartient à un autre projet")
    return {"kind": "snapshot", "snapshot_id": snap["id"], "seal": snap["content_sha256"], "label": snap["label"][:200]}


def _baseline_key(raw: Any) -> str | None:
    """The identity of a requested baseline WITHOUT touching the snapshot store (a replay must not depend on it): ``None`` = live."""
    if raw is None or raw == {"kind": "live"}:
        return None
    if not isinstance(raw, dict) or set(raw) != {"kind", "snapshot_id"} or raw["kind"] != "snapshot" or not isinstance(raw["snapshot_id"], str):
        raise ReviewError("Contexte invalide")
    return raw["snapshot_id"]


def _create(data: dict) -> dict:
    _only(data, {"action", "project_id", "title", "note", "request_id", "baseline"})
    hc = _hc()
    pid = data.get("project_id")
    if not isinstance(pid, str) or not hc._ID_RE["proj"].match(pid):
        raise ReviewError("Projet invalide")
    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not REQ_RE.match(request_id):
        raise ReviewError("Identifiant de requête invalide")
    title = _text(data.get("title"), TITLE_MAX, "Titre", required=True)
    note = _text(data.get("note"), NOTE_MAX, "Note", multiline=True)
    intent = (pid, title, note, _baseline_key(data.get("baseline")))
    root = _root()
    directory = confined_dir(root)
    with store_lock(root):
        replay = _find_request(request_id, intent, directory)
    if replay is not None:
        return replay
    _project_exists(pid)
    baseline = _baseline_from(data.get("baseline"), pid)
    directory = confined_dir(root, create=True)
    with store_lock(root):
        replay = _find_request(request_id, intent, directory)
        if replay is not None:
            return replay
        count = 0
        for rid in _ids(directory):
            try:
                pack, _ = _read_one(directory, rid)
            except ReviewNotFound:
                continue
            if pack is not None and pack["project_id"] == pid:
                count += 1
        if count >= PER_PROJECT_MAX:
            raise ReviewConflict(f"Limite atteinte : {PER_PROJECT_MAX} revues par projet", code="review_limit")
        now = _now()
        pack = {
            "version": VERSION, "id": _new_id("rvw-", 12), "rev": 1, "project_id": pid, "title": title, "note": note, "status": "draft",
            "created_at": now, "updated_at": now, "request_id": request_id, "baseline": baseline, "items": [], "checklist": [], "questions": [],
            "content_sha256": "0" * 64,
        }
        _write(directory, pack)
    return {"ok": True, "replayed": False, "review": pack, "integrity": "ok"}


def _find_request(request_id: str, intent: tuple, directory: Path) -> dict | None:
    """A ``request_id`` is bound to ONE creation intent (project, title, note, baseline). Same id + same intent = the original pack
    (a lost response is safe to retry); same id + a different intent is refused, never silently answered with the old pack."""
    for rid in _ids(directory):
        try:
            pack, integ = _read_one(directory, rid)
        except ReviewNotFound:
            continue
        if pack is None or pack["request_id"] != request_id:
            continue
        stored = (pack["project_id"], pack["title"], pack["note"], None if pack["baseline"]["kind"] == "live" else pack["baseline"]["snapshot_id"])
        if stored != intent:
            raise ReviewConflict("Cette requête de revue existe déjà avec un autre contenu (projet, titre, note ou contexte)", code="review_request_conflict")
        return {"ok": True, "replayed": True, "review": pack, "integrity": integ}
    return None


def _locked_edit(review_id: str, expected: int, fn, *, replacing_size: bool = True) -> dict:
    """Read ONE pack under the store lock, refuse a stale ``expected_rev`` (409, nothing retried), apply ``fn(pack, now)``, bump the
    revision, seal and publish atomically."""
    root = _root()
    directory = confined_dir(root)
    with store_lock(root):
        pack, integ = _read_one(directory, review_id)
        if pack is None:
            raise ReviewStorageError("Revue invalide — conservée telle quelle", 503)
        if integ != "ok":
            raise ReviewConflict("Revue altérée — lecture seule, rien n'est modifié", code="review_corrupt")
        if pack["rev"] != expected:
            raise ReviewConflict("La revue a changé depuis ta lecture — recharge-la", code="review_conflict", rev=pack["rev"])
        now = _now()
        size_before = os.lstat(directory / (review_id + ".json")).st_size
        fn(pack, now)
        pack["rev"] += 1
        pack["updated_at"] = max(now, pack["updated_at"])
        _write(directory, pack, replacing=size_before)
    return {"ok": True, "review": pack, "integrity": "ok"}


def _update(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "title", "note", "status", "baseline"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    changes = {k for k in ("title", "note", "status", "baseline") if k in data}
    if not changes:
        raise ReviewError("Rien à modifier")
    title = _text(data["title"], TITLE_MAX, "Titre", required=True) if "title" in data else None
    note = _text(data["note"], NOTE_MAX, "Note", multiline=True) if "note" in data else None
    status = data.get("status")
    if "status" in data and status not in STATUSES:
        raise ReviewError("Statut invalide")
    current = get(rid)["review"]  # the project is needed to validate a baseline; the locked edit re-checks the revision
    baseline = _baseline_from(data["baseline"], current["project_id"]) if "baseline" in data else None

    def apply(pack: dict, now: int) -> None:
        if title is not None:
            pack["title"] = title
        if note is not None:
            pack["note"] = note
        if "status" in data:
            pack["status"] = status  # explicit user action, nothing else ever writes this field
        if baseline is not None:
            if pack["items"] and baseline != pack["baseline"]:
                raise ReviewConflict("Le contexte ne peut plus changer une fois des preuves ajoutées", code="review_baseline_locked")
            pack["baseline"] = baseline

    return _locked_edit(rid, expected, apply)


def _delete(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "confirm"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    if data.get("confirm") is not True:
        raise ReviewError("Suppression à confirmer")
    root = _root()
    directory = confined_dir(root)
    with store_lock(root):
        pack, integ = _read_one(directory, rid)
        if pack is None:
            raise ReviewStorageError("Revue invalide — conservée telle quelle (suppression refusée)", 503)
        if pack["rev"] != expected:
            raise ReviewConflict("La revue a changé depuis l'ouverture de la confirmation — rien n'est supprimé", code="review_conflict", rev=pack["rev"])
        try:
            os.unlink(directory / (rid + ".json"))
        except OSError as e:
            raise ReviewStorageError("Suppression impossible") from e
        # Phase 10: the pack is gone FIRST (the safe crash direction: an orphan thread is unreachable; the reverse could destroy comments of a
        # live pack). The owned thread is removed immediately, under the same lock order (review -> comment); bounded orphan sweep alongside.
        cleanup = "none"
        try:
            import hq_carnet_rcomments as rcomments

            cleanup = "removed" if rcomments.delete_for_review(_root(), rid) else "none"
            rcomments.sweep_orphans(_root())
        except Exception:  # noqa: BLE001 - the deletion itself succeeded; a leftover thread is unreachable and skipped by backup
            cleanup = "failed"
    return {"ok": True, "deleted": rid, "comments": cleanup}


def _item_add(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "item"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    current = get(rid)
    if current["integrity"] != "ok":
        raise ReviewConflict("Revue altérée — lecture seule, rien n'est modifié", code="review_corrupt")
    pack = current["review"]
    if pack["rev"] != expected:
        raise ReviewConflict("La revue a changé depuis ta lecture — recharge-la", code="review_conflict", rev=pack["rev"])
    import hq_carnet_evidence as evidence

    item = evidence.build_item(data.get("item"), pack)  # server-owned identity, seal and captured copy; the client never supplies them
    item["id"] = _new_id("ri-", 8)
    item["added_at"] = _now()

    def apply(p: dict, now: int) -> None:
        if len(p["items"]) >= ITEMS_MAX:
            raise ReviewConflict(f"Limite atteinte : {ITEMS_MAX} preuves par revue", code="review_limit")
        if len(canon_bytes(item)) > ITEM_BYTES_MAX:
            raise ReviewConflict("Cette preuve est trop volumineuse pour une revue", code="review_item_too_large")
        if any(i["kind"] == item["kind"] and i["scope"] == item["scope"] and i["key"] == item["key"] and i["seal"] == item["seal"] for i in p["items"]):
            raise ReviewConflict("Cette preuve est déjà dans la revue", code="review_duplicate")
        p["items"].append(item)

    return _locked_edit(rid, expected, apply)


def _item_replace(data: dict) -> dict:
    """Explicit replacement of an ask_result by a NEW search (the old fingerprint stays in ``supersedes``)."""
    _only(data, {"action", "id", "expected_rev", "item_id", "item"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    item_id = _req_id(data, "item_id", ITEM_ID_RE, "Preuve")
    current = get(rid)
    if current["integrity"] != "ok":
        raise ReviewConflict("Revue altérée — lecture seule, rien n'est modifié", code="review_corrupt")
    pack = current["review"]
    if pack["rev"] != expected:
        raise ReviewConflict("La revue a changé depuis ta lecture — recharge-la", code="review_conflict", rev=pack["rev"])
    old = next((i for i in pack["items"] if i["id"] == item_id), None)
    if old is None:
        raise ReviewNotFound("Preuve introuvable")
    if old["kind"] != "ask_result":
        raise ReviewError("Seuls les résultats Ask Carnet peuvent être remplacés")
    import hq_carnet_evidence as evidence

    spec = data.get("item")
    if not isinstance(spec, dict) or spec.get("kind") != "ask_result":
        raise ReviewError("Preuve invalide")
    new = evidence.build_item(spec, pack)
    new["id"] = _new_id("ri-", 8)
    new["added_at"] = _now()

    def apply(p: dict, now: int) -> None:
        pos = next((n for n, i in enumerate(p["items"]) if i["id"] == item_id), None)
        if pos is None:
            raise ReviewNotFound("Preuve introuvable")
        prior = p["items"][pos]
        new["supersedes"] = ([{"fingerprint": prior["seal"]["fingerprint"], "replaced_at": now}] + prior["supersedes"])[:SUPERSEDES_MAX]
        if len(canon_bytes(new)) > ITEM_BYTES_MAX:
            raise ReviewConflict("Cette preuve est trop volumineuse pour une revue", code="review_item_too_large")
        p["items"][pos] = new
        for entry in p["checklist"] + p["questions"]:  # references follow the replacement explicitly requested by the user
            entry["refs"] = [new["id"] if r == item_id else r for r in entry["refs"]]

    return _locked_edit(rid, expected, apply)


def _item_remove(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "item_id"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    item_id = _req_id(data, "item_id", ITEM_ID_RE, "Preuve")

    def apply(p: dict, now: int) -> None:
        before = len(p["items"])
        p["items"] = [i for i in p["items"] if i["id"] != item_id]
        if len(p["items"]) == before:
            raise ReviewNotFound("Preuve introuvable")
        # checklist entries / questions keep their refs (they now dangle, visibly): removing evidence never edits user-authored state

    return _locked_edit(rid, expected, apply)


def _check_add(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "text", "refs"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    text = _text(data.get("text"), CHECK_TEXT_MAX, "Texte", required=True)

    def apply(p: dict, now: int) -> None:
        if len(p["checklist"]) >= CHECKS_MAX:
            raise ReviewConflict(f"Limite atteinte : {CHECKS_MAX} points de contrôle", code="review_limit")
        p["checklist"].append({"id": _new_id("rc-", 8), "text": text, "checked": False, "refs": _refs(data.get("refs"), {i["id"] for i in p["items"]}), "created_at": now, "updated_at": now})

    return _locked_edit(rid, expected, apply)


def _check_update(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "check_id", "text", "checked", "refs"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    cid = _req_id(data, "check_id", CHECK_ID_RE, "Point de contrôle")
    if not ({"text", "checked", "refs"} & set(data)):
        raise ReviewError("Rien à modifier")
    text = _text(data["text"], CHECK_TEXT_MAX, "Texte", required=True) if "text" in data else None
    if "checked" in data and not isinstance(data["checked"], bool):
        raise ReviewError("État invalide")

    def apply(p: dict, now: int) -> None:
        c = next((x for x in p["checklist"] if x["id"] == cid), None)
        if c is None:
            raise ReviewNotFound("Point de contrôle introuvable")
        if text is not None:
            c["text"] = text
        if "checked" in data:
            c["checked"] = data["checked"]  # only ever the user's explicit action
        if "refs" in data:
            c["refs"] = _refs(data["refs"], {i["id"] for i in p["items"]})
        c["updated_at"] = now

    return _locked_edit(rid, expected, apply)


def _check_remove(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "check_id"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    cid = _req_id(data, "check_id", CHECK_ID_RE, "Point de contrôle")

    def apply(p: dict, now: int) -> None:
        before = len(p["checklist"])
        p["checklist"] = [c for c in p["checklist"] if c["id"] != cid]
        if len(p["checklist"]) == before:
            raise ReviewNotFound("Point de contrôle introuvable")  # evidence is never touched

    return _locked_edit(rid, expected, apply)


def _question_add(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "text", "refs"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    text = _text(data.get("text"), QUESTION_TEXT_MAX, "Question", required=True, multiline=True)

    def apply(p: dict, now: int) -> None:
        if len(p["questions"]) >= QUESTIONS_MAX:
            raise ReviewConflict(f"Limite atteinte : {QUESTIONS_MAX} questions", code="review_limit")
        p["questions"].append({"id": _new_id("rq-", 8), "text": text, "state": "open", "resolution_note": "", "refs": _refs(data.get("refs"), {i["id"] for i in p["items"]}), "created_at": now, "updated_at": now})

    return _locked_edit(rid, expected, apply)


def _question_update(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "question_id", "text", "state", "resolution_note", "refs"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    qid = _req_id(data, "question_id", QUESTION_ID_RE, "Question")
    if not ({"text", "state", "resolution_note", "refs"} & set(data)):
        raise ReviewError("Rien à modifier")
    text = _text(data["text"], QUESTION_TEXT_MAX, "Question", required=True, multiline=True) if "text" in data else None
    note = _text(data["resolution_note"], RESOLUTION_MAX, "Note de résolution", multiline=True) if "resolution_note" in data else None
    if "state" in data and data["state"] not in QUESTION_STATES:
        raise ReviewError("État invalide")

    def apply(p: dict, now: int) -> None:
        q = next((x for x in p["questions"] if x["id"] == qid), None)
        if q is None:
            raise ReviewNotFound("Question introuvable")
        if text is not None:
            q["text"] = text
        if "state" in data:
            q["state"] = data["state"]  # only ever the user's explicit action
        if note is not None:
            q["resolution_note"] = note
        if "refs" in data:
            q["refs"] = _refs(data["refs"], {i["id"] for i in p["items"]})
        q["updated_at"] = now

    return _locked_edit(rid, expected, apply)


def _question_remove(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "question_id"})
    rid = _req_id(data, "id", ID_RE, "Revue")
    expected = _req_rev(data)
    qid = _req_id(data, "question_id", QUESTION_ID_RE, "Question")

    def apply(p: dict, now: int) -> None:
        before = len(p["questions"])
        p["questions"] = [q for q in p["questions"] if q["id"] != qid]
        if len(p["questions"]) == before:
            raise ReviewNotFound("Question introuvable")

    return _locked_edit(rid, expected, apply)


ACTIONS = {
    "review_create": _create, "review_update": _update, "review_delete": _delete,
    "review_item_add": _item_add, "review_item_replace": _item_replace, "review_item_remove": _item_remove,
    "review_check_add": _check_add, "review_check_update": _check_update, "review_check_remove": _check_remove,
    "review_question_add": _question_add, "review_question_update": _question_update, "review_question_remove": _question_remove,
}


def mutate(data: Any) -> dict:
    if not isinstance(data, dict) or data.get("action") not in ACTIONS:
        raise ReviewError("Action inconnue")
    return ACTIONS[data["action"]](data)


# ---------------------------------------------------------------- backup closure (read-only)


def closure(root: Path | str) -> dict:
    """The review files a backup must carry, byte-for-byte: ``{"files", "valid"}``. EVERY ``rvw-*.json`` is carried (a corrupt or
    invalid pack is user data too); ``valid`` is False when any of them does not verify, so the caller reports it instead of
    pretending the store is sound. Referenced canonical material follows the existing notebook / snapshot closure rules."""
    directory = rev_dir(root)
    files: list[str] = []
    valid = True
    try:
        confined_dir(root)
        with store_lock(root):
            for rid in _ids(directory):
                try:
                    pack, integ = _read_one(directory, rid)
                except ReviewNotFound:
                    continue
                files.append(rid + ".json")
                if pack is None or integ != "ok":
                    valid = False
    except (ReviewError, ReviewStorageError):
        valid = False
    return {"files": files, "valid": valid}


def copy_to(root: Path | str, dest: Path, names: list[str]) -> int:
    """Copy the named review files byte-for-byte into ``dest`` (an existing directory). Returns the byte count."""
    directory = confined_dir(root)
    total = 0
    for name in names:
        if not name.endswith(".json") or not ID_RE.match(name[:-5]):
            continue
        raw = (directory / name).read_bytes()
        (dest / name).write_bytes(raw)
        total += len(raw)
    return total
