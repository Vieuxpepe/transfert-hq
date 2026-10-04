"""Carnet Phase 10: Review Pack comments — the store (APPEND-ONLY review discussion around a captured item). Stdlib only.

A review comment belongs to the review discussion around ONE captured Review Pack item. It is not a live source annotation and never
becomes one; a live annotation never enters a Review Pack (no automatic copy in either direction).

Why a SEPARATE store (not a field of the pack): ``hq_carnet_reviews.validate`` accepts exactly the Phase 7 key set, so a ``comments`` field
inside the pack would make a rolled-back binary reject every new pack as invalid. A separate directory is simply ignored by an older
binary, and there is still ONE revision authority per object: the pack ``rev`` describes the pack, the thread ``rev`` describes the thread.

Runtime state: ``<ROOT>/.hq-carnet/review-comments/<rvw-id>.json``, one file per pack::

    {"schema": 1, "review_id": "rvw-...", "rev": 4, "comments": [comment, ...], "content_sha256": "..."}
    comment = {"id": "rcm-<16 hex>", "request_id": "<32 hex>", "item": {"item_id", "item_kind", "item_label", "item_fingerprint"},
               "body": "...", "created_at": int, "supersedes": null | "rcm-..."}

(``rcm-`` rather than ``rc-``: ``rc-`` is already the Phase 7 checklist-entry prefix.) ``item`` is a bounded, SERVER-owned captured identity
taken from the pack item at post time (``item_fingerprint`` = sha256 of the canonical kind / key / seal / scope), so a comment about an item
that was later removed or replaced still answers "which captured review evidence was this about?" without copying the evidence itself.

Append-only: there is no edit and no delete. A correction is a NEW comment with ``supersedes`` naming an earlier comment of the same item.
Idempotency: ``request_id`` is bound to ONE intent (review, item, body, supersedes): same id + same intent replays the original comment, same
id + another intent is 409 ``review_comment_request_conflict``. Never an author (there is no identity system).

Bounds: ``PER_ITEM_MAX`` per item, ``PER_PACK_MAX`` per pack, ``FILE_BYTES_MAX`` per file, ``STORE_BYTES_MAX`` overall, ``BODY_MAX`` code points.
Lock order: review-store lock (pack read) -> comment-store lock; pack deletion takes them in the same order and removes the comment file
immediately. A crash between the two unlinks leaves an orphan file that is unreachable (every read goes through an existing pack), is
skipped by backup, and is removed by ``sweep_orphans`` (bounded; called from the deletion path).
"""

from __future__ import annotations

import hashlib
import os
import re
import secrets
import stat as _stat
import time
import json
from pathlib import Path
from typing import Any

import hq_carnet_annotations as ann
import hq_carnet_reviews as reviews

COMMENT_DIR = "review-comments"
SCHEMA = 1
BODY_MAX = ann.BODY_MAX
PER_ITEM_MAX = 100
PER_PACK_MAX = 1000
FILE_BYTES_MAX = 2 * 1024 * 1024
STORE_BYTES_MAX = 100 * 1024 * 1024
SWEEP_MAX = 50
ID_RE = re.compile(r"^rcm-[0-9a-f]{16}\Z")
_SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
_ESCAPED = "Dossier des commentaires de revue redirigé — refusé"
_FILE_KEYS = {"schema", "review_id", "rev", "comments", "content_sha256"}
_COMMENT_KEYS = {"id", "request_id", "item", "body", "created_at", "supersedes"}
_ITEM_KEYS = {"item_id", "item_kind", "item_label", "item_fingerprint"}


def _root() -> Path:
    return ann._root()


def _dir(root: Path | str | None = None, *, create: bool = False) -> Path:
    return ann.confined_store(root, COMMENT_DIR, create=create, escaped=_ESCAPED)


def store_lock(root: Path | str | None = None):
    return ann.hq_state.path_lock(ann.store_dir(root, COMMENT_DIR))


def seal(doc: dict) -> str:
    return hashlib.sha256(ann.canon_bytes({k: v for k, v in doc.items() if k != "content_sha256"})).hexdigest()


def item_fingerprint(item: dict) -> str:
    """Deterministic identity of the CAPTURED item (kind + key + seal + scope): bounded, never the evidence copy."""
    return hashlib.sha256(ann.canon_bytes({"kind": item["kind"], "key": item["key"], "seal": item["seal"], "scope": item["scope"]})).hexdigest()


def _item_identity(item: dict) -> dict:
    return {"item_id": item["id"], "item_kind": item["kind"], "item_label": item["label"][: reviews.LABEL_MAX], "item_fingerprint": item_fingerprint(item)}


def _comment_ok(c: Any) -> bool:
    try:
        return bool(
            isinstance(c, dict) and set(c) == _COMMENT_KEYS and isinstance(c["id"], str) and ID_RE.match(c["id"])
            and isinstance(c["request_id"], str) and reviews.REQ_RE.match(c["request_id"])
            and isinstance(c["item"], dict) and set(c["item"]) == _ITEM_KEYS and isinstance(c["item"]["item_id"], str) and reviews.ITEM_ID_RE.match(c["item"]["item_id"])
            and c["item"]["item_kind"] in reviews.ITEM_KINDS and isinstance(c["item"]["item_label"], str) and len(c["item"]["item_label"]) <= reviews.LABEL_MAX
            and isinstance(c["item"]["item_fingerprint"], str) and _SHA_RE.match(c["item"]["item_fingerprint"])
            and isinstance(c["body"], str) and 0 < len(c["body"]) <= BODY_MAX and not ann._CTRL_LINE.search(c["body"]) and c["body"].strip()
            and ann._is_int(c["created_at"]) and (c["supersedes"] is None or (isinstance(c["supersedes"], str) and ID_RE.match(c["supersedes"])))
        )
    except Exception:  # noqa: BLE001
        return False


def _doc_ok(doc: Any, review_id: str) -> bool:
    if not isinstance(doc, dict) or set(doc) != _FILE_KEYS or doc["schema"] != SCHEMA or doc["review_id"] != review_id:
        return False
    if not ann._is_int(doc["rev"]) or doc["rev"] < 1 or not isinstance(doc["content_sha256"], str) or not _SHA_RE.match(doc["content_sha256"]):
        return False
    if not isinstance(doc["comments"], list) or len(doc["comments"]) > PER_PACK_MAX or not all(_comment_ok(c) for c in doc["comments"]):
        return False
    seen: dict[str, str] = {}
    for c in doc["comments"]:
        if c["id"] in seen:
            return False
        sup = c["supersedes"]
        if sup is not None and seen.get(sup) != c["item"]["item_id"]:
            return False  # a correction names an EARLIER comment of the same item
        seen[c["id"]] = c["item"]["item_id"]
    return True


def _read(directory: Path, review_id: str) -> tuple[dict | None, str]:
    """``(doc or None, state)``: ``absent`` | ``ok`` | ``corrupt`` (well-formed, seal mismatch) | ``invalid``. Unreadable raises."""
    path = directory / (review_id + ".json")
    try:
        raw = ann.read_regular(path, FILE_BYTES_MAX)
    except FileNotFoundError:
        return None, "absent"
    except ann.Noncanonical:
        return None, "invalid"
    except OSError as e:
        raise ann.AnnotationStorageError("Commentaires de revue illisibles") from e
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "invalid"
    if not _doc_ok(doc, review_id):
        return None, "invalid"
    return doc, ("ok" if seal(doc) == doc["content_sha256"] else "corrupt")


def _names(directory: Path) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise ann.AnnotationStorageError("Commentaires de revue inaccessibles") from e
    return sorted(n[:-5] for n in names if n.endswith(".json") and reviews.ID_RE.match(n[:-5]))


def _write(directory: Path, doc: dict, *, replacing: int = 0) -> None:
    doc["content_sha256"] = seal(doc)
    if not _doc_ok(doc, doc["review_id"]):
        raise ann.AnnotationStorageError("Commentaires de revue invalides — écriture refusée", 500)
    raw = ann.canon_bytes(doc)
    if len(raw) > FILE_BYTES_MAX:
        raise ann.AnnotationConflict("Fil de commentaires trop volumineux", code="review_comment_too_large")
    total = 0
    for n in os.listdir(directory):
        if n.endswith(".json"):
            try:
                total += os.lstat(directory / n).st_size
            except OSError:
                pass
    if total - replacing + len(raw) > STORE_BYTES_MAX:
        raise ann.AnnotationConflict("Espace des commentaires de revue épuisé", code="review_comment_store_full")
    ann.publish(directory, doc["review_id"] + ".json", raw, "Commentaires de revue")


def _public(c: dict, present: set[str]) -> dict:
    return {"id": c["id"], "item": dict(c["item"]), "body": c["body"], "created_at": c["created_at"], "supersedes": c["supersedes"],
            "item_present": c["item"]["item_id"] in present}


def _pack(review_id: Any) -> dict:
    """The pack the thread belongs to (must exist and verify: a comment about an untrusted item identity is never recorded)."""
    got = reviews.get(review_id)
    if got["integrity"] != "ok":
        raise ann.AnnotationConflict("Revue altérée — lecture seule, rien n'est modifié", code="review_corrupt")
    return got["review"]


# ---------------------------------------------------------------- list (read-only)


def thread(review_id: Any) -> dict:
    """READ-ONLY. ``{review_id, rev, content_sha256, integrity, comments}`` for an existing pack (any pack integrity: forensics stay readable)."""
    if not isinstance(review_id, str) or not reviews.ID_RE.match(review_id):
        raise ann.AnnotationNotFound("Revue introuvable")
    root = _root()
    got = reviews.get(review_id)  # 404 when the pack does not exist: a comment file without a pack is unreachable
    present = {i["id"] for i in got["review"]["items"]}
    directory = _dir(root)
    with store_lock(root):
        doc, state = _read(directory, review_id)
    if state == "invalid":
        return {"review_id": review_id, "rev": None, "content_sha256": None, "integrity": "invalid", "comments": []}
    if doc is None:
        return {"review_id": review_id, "rev": 0, "content_sha256": None, "integrity": "ok", "comments": []}
    return {"review_id": review_id, "rev": doc["rev"], "content_sha256": doc["content_sha256"], "integrity": state,
            "comments": [_public(c, present) for c in doc["comments"]]}


def list_thread(data: Any) -> dict:
    if not isinstance(data, dict) or set(data) != {"action", "review_id"}:
        raise ann.AnnotationError("Requête invalide")
    return {"ok": True, "read_only": True, **thread(data["review_id"]), "limits": limits()}


def limits() -> dict:
    return {"body": BODY_MAX, "per_item": PER_ITEM_MAX, "per_pack": PER_PACK_MAX}


# ---------------------------------------------------------------- append


def _find_request(directory: Path, request_id: str, intent: tuple, present: set[str]) -> dict | None:
    for rid in _names(directory):
        doc, state = _read(directory, rid)
        if doc is None:
            continue
        for c in doc["comments"]:
            if c["request_id"] != request_id:
                continue
            if (rid, c["item"]["item_id"], c["body"], c["supersedes"]) != intent:
                raise ann.AnnotationConflict("Cette requête de commentaire existe déjà avec un autre contenu", code="review_comment_request_conflict")
            return {"ok": True, "replayed": True, "comment": _public(c, present), "thread": {"rev": doc["rev"], "content_sha256": doc["content_sha256"]}}
    return None


def add(data: Any) -> dict:
    if not isinstance(data, dict):
        raise ann.AnnotationError("Requête invalide")
    ann._hc()._only_keys(data, {"action", "review_id", "item_id", "request_id", "body", "supersedes"})
    review_id, item_id, request_id = data.get("review_id"), data.get("item_id"), data.get("request_id")
    if not isinstance(review_id, str) or not reviews.ID_RE.match(review_id):
        raise ann.AnnotationError("Revue invalide")
    if not isinstance(item_id, str) or not reviews.ITEM_ID_RE.match(item_id):
        raise ann.AnnotationError("Preuve invalide")
    if not isinstance(request_id, str) or not reviews.REQ_RE.match(request_id):
        raise ann.AnnotationError("Identifiant de requête invalide")
    sup = data.get("supersedes")
    if sup is not None and (not isinstance(sup, str) or not ID_RE.match(sup)):
        raise ann.AnnotationError("Commentaire remplacé invalide")
    body = ann.body_text(data.get("body"), "Commentaire de revue")
    intent = (review_id, item_id, body, sup)
    root = _root()
    with reviews.store_lock(root):  # lock order: review store -> comment store (the same as pack deletion)
        pack = _pack(review_id)
        present = {i["id"] for i in pack["items"]}
        directory = _dir(root, create=True)
        with store_lock(root):
            replay = _find_request(directory, request_id, intent, present)
            if replay is not None:
                return replay
            item = next((i for i in pack["items"] if i["id"] == item_id), None)
            if item is None:
                raise ann.AnnotationNotFound("Preuve introuvable dans cette revue")
            doc, state = _read(directory, review_id)
            if state in ("invalid", "corrupt"):
                raise ann.AnnotationConflict("Fil de commentaires altéré — lecture seule, rien n'est ajouté", code="review_comment_corrupt")
            if doc is None:
                doc = {"schema": SCHEMA, "review_id": review_id, "rev": 0, "comments": [], "content_sha256": "0" * 64}
            if sup is not None and not any(c["id"] == sup and c["item"]["item_id"] == item_id for c in doc["comments"]):
                raise ann.AnnotationError("Le commentaire remplacé doit appartenir à la même preuve")
            if sum(1 for c in doc["comments"] if c["item"]["item_id"] == item_id) >= PER_ITEM_MAX:
                raise ann.AnnotationConflict(f"Limite atteinte : {PER_ITEM_MAX} commentaires par preuve", code="review_comment_limit")
            if len(doc["comments"]) >= PER_PACK_MAX:
                raise ann.AnnotationConflict(f"Limite atteinte : {PER_PACK_MAX} commentaires par revue", code="review_comment_limit")
            comment = {"id": "rcm-" + secrets.token_hex(8), "request_id": request_id, "item": _item_identity(item), "body": body,
                       "created_at": int(ann._now()), "supersedes": sup}
            before = os.lstat(directory / (review_id + ".json")).st_size if state == "ok" else 0
            doc["comments"].append(comment)
            doc["rev"] += 1
            _write(directory, doc, replacing=before)
    return {"ok": True, "replayed": False, "comment": _public(comment, present), "thread": {"rev": doc["rev"], "content_sha256": doc["content_sha256"]}}


ACTIONS = {"rcomment_add": add, "rcomment_list": list_thread}


def mutate(data: Any) -> dict:
    if not isinstance(data, dict) or data.get("action") not in ACTIONS:
        raise ann.AnnotationError("Action inconnue")
    return ACTIONS[data["action"]](data)


# ---------------------------------------------------------------- pack deletion, orphans, backup closure


def delete_for_review(root: Path | str, review_id: str) -> bool:
    """Remove the owned thread of a permanently deleted pack, under the normal store lock. True when a file was removed."""
    directory = _dir(root)
    with store_lock(root):
        try:
            os.unlink(directory / (review_id + ".json"))
            return True
        except FileNotFoundError:
            return False
        except OSError as e:
            raise ann.AnnotationStorageError("Suppression des commentaires impossible") from e


def orphans(root: Path | str) -> list[str]:
    """Thread files whose pack no longer exists (a crash between the two unlinks of a pack deletion). Read-only."""
    directory = _dir(root)
    live = set(reviews._ids(reviews.confined_dir(root))) if os.path.isdir(reviews.rev_dir(root)) else set()
    return [n for n in _names(directory) if n not in live]


def sweep_orphans(root: Path | str, limit: int = SWEEP_MAX) -> int:
    """Remove at most ``limit`` orphan thread files. Bounded and explicit; returns how many were removed."""
    removed = 0
    directory = _dir(root)
    with store_lock(root):
        for name in orphans(root)[:limit]:
            try:
                os.unlink(directory / (name + ".json"))
                removed += 1
            except OSError:
                pass
    return removed


def closure(root: Path | str) -> dict:
    """The thread files a backup must carry, byte-for-byte: ``{"files", "valid"}``. Only threads whose pack exists (an orphan is
    unreachable and skipped). ``valid`` is False when any carried thread does not verify. Referenced evidence is not followed."""
    files: list[str] = []
    valid = True
    try:
        directory = _dir(root)
        with reviews.store_lock(root):
            live = set(reviews._ids(reviews.confined_dir(root))) if os.path.isdir(reviews.rev_dir(root)) else set()
            with store_lock(root):
                for rid in _names(directory):
                    if rid not in live:
                        continue
                    doc, state = _read(directory, rid)
                    files.append(rid + ".json")
                    if state != "ok":
                        valid = False
    except (ann.AnnotationError, ann.AnnotationStorageError, reviews.ReviewError, reviews.ReviewStorageError):
        valid = False
    return {"files": files, "valid": valid}


def copy_to(root: Path | str, dest: Path, names: list[str], refused: list | None = None) -> int:
    directory = _dir(root)
    with store_lock(root):
        return ann.copy_canonical(directory, dest, names, reviews.ID_RE.match, FILE_BYTES_MAX, refused)
