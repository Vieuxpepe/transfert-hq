"""Carnet Phase 11: verification tasks & evidence-backed signoff — the store. Stdlib only.

A verification says that a HUMAN performed a check against a SPECIFIC evidence state. It does not make the evidence true and it does not turn
workflow state into evidence: nothing here ever modifies a page, a block, a source, a drawing, a snapshot or a Review Pack, and no Ask / search /
snapshot / history module imports this one. ``verified`` is reachable ONLY through the explicit ``verification_signoff`` action.

Runtime state: ``<ROOT>/.hq-carnet/verifications/ver-<24 hex>.json`` — one file per verification (never mixed into any other store)::

    {"schema", "id", "rev", "project_id", "request_id", "question", "status", "target", "evidence": [{"id", "ref", "added_at"}], "note",
     "followup_note", "created_at", "updated_at", "signoffs": [signoff, ...], "seal"}

``target`` and every ``ref`` are the same identity shape (``kind`` + identifying fields; no copied foreign state):
page ``{page_id}`` · block ``{page_id, block_id}`` · source ``{source_id}`` · citation ``{page_id, block_id, citation_fingerprint}`` (server-computed) ·
drawing ``{stem}`` · snapshot ``{snapshot_id}`` · review_item ``{review_id, item_id, item_fingerprint}`` (captured by the server at attach time).
The target is IMMUTABLE (a different subject is a different verification) and is never implicitly evidence.

Status: ``open -> ready -> verified`` (verified only through a signoff); ``needs_followup`` is reachable from open / ready / verified;
``ready`` / ``verified`` / ``needs_followup`` return to ``open`` explicitly. The question and the evidence list are editable only in
``open`` / ``needs_followup``; the note is commentary and is editable at any time.

Signoff (append-only, ``SIGNOFFS_MAX``): the server observes the target and every evidence ref TWICE (A then B), requires A == B and records B.
This is "two consistent observations", NOT a global multi-store transaction and NOT an ABA guarantee. Anything missing / unknown / corrupt /
noncanonical fails closed (409 ``verification_evidence_unavailable``); ``archived`` but observable is signable. There is NO identity system: a
signoff is "verification recorded at time T", never "signed by".
``verification_fingerprint`` = sha256(question + target + canonical (sorted) evidence identities); the note, the follow-up note, the status
and the display order of the evidence are excluded, so a historical signoff never changes when commentary changes.

Per-record seal; a corrupt / invalid record is listed read-only and never edited, signed, deleted or repaired. The in-process header index is a
CACHE keyed by ``lstat`` identity: dropping it rebuilds the same answers from the files.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import stat as _stat
import threading
from pathlib import Path
from typing import Any

import hq_carnet_annotations as ann
import hq_carnet_canon as canon
import hq_carnet_evidence as ev
import hq_carnet_rcomments as rcom
import hq_carnet_reviews as reviews
import hq_carnet_rich as rich
import hq_carnet_snapshots as snaps
import hq_state

VER_DIR = "verifications"
SCHEMA = 1
TEXT_MAX = 4000
EVIDENCE_MAX = 100
SIGNOFFS_MAX = 100
TOTAL_MAX = 5000
PROJECT_MAX = 1000
LIST_MAX = 100
TARGETS_PER_RELATED_MAX = 10
FILE_BYTES_MAX = 4 * 1024 * 1024
STATUSES = ("open", "ready", "verified", "needs_followup")
KINDS = ("page", "block", "source", "citation", "drawing", "snapshot", "review_item")
ID_RE = re.compile(r"^ver-[0-9a-f]{24}\Z")
EVID_RE = re.compile(r"^ve-[0-9a-f]{16}\Z")
SIGN_RE = re.compile(r"^vs-[0-9a-f]{16}\Z")
REQ_RE = re.compile(r"^[0-9a-f]{32}\Z")
_SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
_CTRL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
_ESCAPED = "Dossier des vérifications redirigé — refusé"
EDITABLE = ("open", "needs_followup")
UNSIGNABLE = ("missing", "unknown", "corrupt")
DISCLOSURE = "Vérification enregistrée localement ; aucune identité de relecteur authentifiée n'est associée."
UNAVAILABLE_MESSAGE = "Impossible d'enregistrer la vérification : certaines preuves ne peuvent pas être vérifiées actuellement."


class VerificationError(ValueError):
    status = 400
    code = "validation_error"

    def __init__(self, message: str, code: str | None = None, status: int | None = None, **extra: Any):
        super().__init__(message)
        if code:
            self.code = code
        if status:
            self.status = status
        self.payload = {"error": message, "code": self.code, **extra}


class VerificationNotFound(VerificationError):
    status = 404
    code = "not_found"


class VerificationConflict(VerificationError):
    status = 409
    code = "verification_conflict"


class VerificationStorageError(RuntimeError):
    code = "verifications_unavailable"

    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status
        self.payload = {"error": message, "code": self.code}


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _now() -> int:
    return ann._now()


def _root() -> Path:
    try:
        return ann._root()
    except ann.AnnotationStorageError as e:
        raise VerificationStorageError("Carnet non initialisé") from e


def _hc():
    import hq_carnet

    return hq_carnet


def canon_bytes(obj: Any) -> bytes:
    return ann.canon_bytes(obj)


def _sha(obj: Any) -> str:
    return hashlib.sha256(canon_bytes(obj)).hexdigest()


def store_lock(root: Path | str | None = None):
    return hq_state.path_lock(ann.store_dir(root if root is not None else _root(), VER_DIR))


def _confined(root: Path, *, create: bool = False) -> Path:
    try:
        return ann.confined_store(root, VER_DIR, create=create, escaped=_ESCAPED)
    except ann.AnnotationStorageError as e:
        raise VerificationStorageError(str(e), e.status) from e


def limits() -> dict:
    return {"text_max": TEXT_MAX, "evidence_max": EVIDENCE_MAX, "signoffs_max": SIGNOFFS_MAX, "total_max": TOTAL_MAX, "project_max": PROJECT_MAX,
            "list_max": LIST_MAX, "related_targets_max": TARGETS_PER_RELATED_MAX, "file_bytes_max": FILE_BYTES_MAX}


# ---------------------------------------------------------------- text


def _text(value: Any, what: str, *, required: bool) -> str:
    """Plain text, stored exactly as typed. ``\\n`` / ``\\t`` allowed; other control characters refused; whitespace-only = empty."""
    if not isinstance(value, str) or len(value) > TEXT_MAX or _CTRL.search(value):
        raise VerificationError(f"{what} invalide")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise VerificationError(f"{what} invalide") from e
    if not value.strip():
        if required:
            raise VerificationError(f"{what} requis")
        return ""
    return value


# ---------------------------------------------------------------- identities (target / evidence refs)


def _fields(kind: str) -> tuple[str, ...]:
    return {"page": ("page_id",), "block": ("page_id", "block_id"), "source": ("source_id",), "citation": ("page_id", "block_id", "citation_fingerprint"),
            "drawing": ("stem",), "snapshot": ("snapshot_id",), "review_item": ("review_id", "item_id", "item_fingerprint")}[kind]


def _field_ok(name: str, v: Any) -> bool:
    hc = _hc()
    if not isinstance(v, str):
        return False
    rx = {"page_id": hc._ID_RE["page"], "block_id": hc._ID_RE["block"], "source_id": rich._EDITION_ID_RE, "stem": ev._STEM_RE, "snapshot_id": snaps.ID_RE,
          "review_id": reviews.ID_RE, "item_id": reviews.ITEM_ID_RE, "citation_fingerprint": _SHA_RE, "item_fingerprint": _SHA_RE}[name]
    return bool(rx.match(v))


def ref_ok(ref: Any) -> bool:
    """A STORED identity: exactly ``kind`` + that kind's fields, every one well-formed."""
    if not isinstance(ref, dict) or ref.get("kind") not in KINDS:
        return False
    names = _fields(ref["kind"])
    return set(ref) == {"kind", *names} and all(_field_ok(n, ref[n]) for n in names)


def parse_ref(raw: Any, mode: str) -> dict:
    """``mode``: ``create`` (a NEW target / evidence: a citation arrives as its value and is fingerprinted by the server; a review item arrives as
    ``{review_id, item_id}`` and is completed by ``complete_ref``), ``lookup`` (read-only relation queries; a citation by value or fingerprint,
    a review item by ids) or ``stored`` (strict, complete). Returns a canonical identity (a review item may still lack its fingerprint)."""
    if not isinstance(raw, dict) or raw.get("kind") not in KINDS:
        raise VerificationError("Cible invalide")
    kind = raw["kind"]
    if kind == "citation":
        if mode != "stored" and set(raw) == {"kind", "page_id", "block_id", "cite"}:
            try:
                cite = rich.check_cite(raw["cite"])
            except rich.ContentError as e:
                raise VerificationError("Citation invalide") from e
            ref = {"kind": "citation", "page_id": raw["page_id"], "block_id": raw["block_id"], "citation_fingerprint": ann.fingerprint(cite)}
            if not ref_ok(ref):
                raise VerificationError("Cible invalide")
            return ref
        if mode == "create":
            raise VerificationError("Citation requise")  # a fingerprint alone is never authority to attach a NEW citation
    if kind == "review_item" and mode != "stored" and set(raw) == {"kind", "review_id", "item_id"}:
        if not (_field_ok("review_id", raw["review_id"]) and _field_ok("item_id", raw["item_id"])):
            raise VerificationError("Cible invalide")
        return {"kind": "review_item", "review_id": raw["review_id"], "item_id": raw["item_id"]}
    if kind == "review_item" and mode == "create":
        raise VerificationError("Cible invalide")
    if not ref_ok(raw):
        raise VerificationError("Cible invalide")
    return dict(raw)


def relation_key(ref: dict) -> str:
    """Reverse-lookup key: the identity, except that a review item is related by its (review, item) ids, not by its captured fingerprint."""
    r = {k: v for k, v in ref.items() if k != "item_fingerprint"} if ref["kind"] == "review_item" else ref
    return hashlib.sha256(canon_bytes(r)).hexdigest()[:20]


# ---------------------------------------------------------------- observation (target and evidence share ONE observer)


def _ob(state: str, seal: dict | None = None, reason: str | None = None) -> dict:
    return {"state": state, "seal": seal, "reason": reason}


def observe_ref(ref: dict, world: "ev.World") -> dict:
    """``{state, seal, reason}`` of ONE identity in the live world. state: ``ok`` | ``archived`` | ``missing`` | ``unknown`` | ``corrupt``.
    Never raises (failure isolation): a failed observation is that entry's own ``unknown``."""
    kind = ref["kind"]
    try:
        if kind in ("page", "block", "drawing"):
            seen = ev.observe(kind, {k: v for k, v in ref.items() if k != "kind"}, world)
            return _ob("missing", None, "absent") if seen is None else _ob("ok", seen)
        if kind == "source":
            ed = world.editions().get(ref["source_id"])
            if ed is None:
                return _ob("missing", None, "absent")
            seen = ev.observe("source", {"edition_id": ref["source_id"]}, world)
            return _ob("archived" if ed.get("archived") else "ok", seen)
        if kind == "snapshot":
            st, found = world.snapshot(ref["snapshot_id"])
            if st == "missing":
                return _ob("missing", None, "absent")
            if st == "corrupt":
                return _ob("corrupt", None, "snapshot_corrupt")
            if st != "ok":
                return _ob("unknown", None, "snapshot_" + st)
            return _ob("ok", {"content_sha256": found["content_sha256"]})
        if kind == "citation":
            st, _n = ann.citation_state(world.state, ref)
            if st == "unavailable":
                return _ob("missing", None, "citation_unavailable")
            if st == "changed_or_removed":
                return _ob("missing", None, "citation_changed_or_removed")
            return _ob("ok", {"citation_fingerprint": ref["citation_fingerprint"], "present": True})
        if kind == "review_item":
            return _observe_review_item(ref)
    except ev._Unknown as e:
        return _ob("unknown", None, e.reason)
    except Exception:  # noqa: BLE001 - one broken resolver never suppresses the others
        return _ob("unknown", None, "resolver_error")
    return _ob("unknown", None, "unsupported_kind")


def _observe_review_item(ref: dict) -> dict:
    try:
        got = reviews.get(ref["review_id"])
    except reviews.ReviewNotFound:
        return _ob("missing", None, "review_missing")
    except (reviews.ReviewStorageError, reviews.ReviewError):
        return _ob("unknown", None, "review_unavailable")
    if got["integrity"] != "ok":
        return _ob("corrupt", None, "review_corrupt")
    item = next((i for i in got["review"]["items"] if i["id"] == ref["item_id"]), None)
    if item is None:
        return _ob("missing", None, "item_removed")
    fp = rcom.item_fingerprint(item)
    if fp != ref["item_fingerprint"]:
        return _ob("missing", None, "item_replaced")
    return _ob("ok", {"item_fingerprint": fp})


def complete_ref(ref: dict, world: "ev.World") -> tuple[dict, dict]:
    """Complete a NEW ref (the server captures a review item's fingerprint) and require that it currently exists. ``(ref, observation)``."""
    if ref["kind"] == "review_item" and "item_fingerprint" not in ref:
        try:
            got = reviews.get(ref["review_id"])
        except reviews.ReviewNotFound as e:
            raise VerificationNotFound("Cette preuve n'existe pas — rien n'est enregistré", code="verification_target_unavailable") from e
        except (reviews.ReviewStorageError, reviews.ReviewError) as e:
            raise VerificationStorageError("Revue inaccessible — vérification impossible") from e
        if got["integrity"] != "ok":
            raise VerificationConflict("Revue altérée — vérification impossible", code="verification_corrupt")
        item = next((i for i in got["review"]["items"] if i["id"] == ref["item_id"]), None)
        if item is None:
            raise VerificationNotFound("Cet élément de revue n'existe plus — rien n'est enregistré", code="verification_target_unavailable")
        ref = {**ref, "item_fingerprint": rcom.item_fingerprint(item)}
    obs = observe_ref(ref, world)
    if obs["state"] == "missing":
        raise VerificationNotFound("Cette preuve n'existe pas — rien n'est enregistré", code="verification_target_unavailable")
    if obs["state"] == "corrupt":
        raise VerificationConflict("Cette preuve est altérée — rien n'est enregistré", code="verification_evidence_unavailable")
    if obs["state"] == "unknown":
        raise VerificationStorageError("Cette preuve est inaccessible actuellement — rien n'est enregistré")
    return ref, obs


# ---------------------------------------------------------------- records, seals, fingerprints


REC_KEYS = {"schema", "id", "rev", "project_id", "request_id", "question", "status", "target", "evidence", "note", "followup_note", "created_at", "updated_at", "signoffs", "seal"}
SIGN_KEYS = {"id", "request_id", "signed_at", "verification_rev", "verification_fingerprint", "target_seal", "evidence", "content_sha256"}


def seal(rec: dict) -> str:
    return hashlib.sha256(canon_bytes({k: v for k, v in rec.items() if k != "seal"})).hexdigest()


def fingerprint(rec: dict) -> str:
    """Server-owned identity of what a signoff certifies: question + target + CANONICAL (sorted) evidence identities. Excludes the note, the
    follow-up note, the status and the evidence display order."""
    ids = sorted(canon_bytes(e["ref"]).decode("ascii") for e in rec["evidence"])
    return _sha({"question": rec["question"], "target": rec["target"], "evidence": ids})


def _signoff_hash(s: dict) -> str:
    return _sha({k: v for k, v in s.items() if k != "content_sha256"})


def _obs_entry_ok(e: Any, with_id: bool) -> bool:
    keys = {"kind", "identity", "state", "seal"} | ({"evidence_id"} if with_id else set())
    return bool(isinstance(e, dict) and set(e) == keys and ref_ok(e["identity"]) and e["kind"] == e["identity"]["kind"]
                and e["state"] in ("ok", "archived") and isinstance(e["seal"], dict)
                and (not with_id or (isinstance(e["evidence_id"], str) and EVID_RE.match(e["evidence_id"]))))


def _signoff_ok(s: Any) -> bool:
    try:
        return bool(isinstance(s, dict) and set(s) == SIGN_KEYS and isinstance(s["id"], str) and SIGN_RE.match(s["id"])
                    and isinstance(s["request_id"], str) and REQ_RE.match(s["request_id"]) and _is_int(s["signed_at"])
                    and _is_int(s["verification_rev"]) and s["verification_rev"] >= 1 and isinstance(s["verification_fingerprint"], str)
                    and _SHA_RE.match(s["verification_fingerprint"]) and _obs_entry_ok(s["target_seal"], False)
                    and isinstance(s["evidence"], list) and 1 <= len(s["evidence"]) <= EVIDENCE_MAX and all(_obs_entry_ok(e, True) for e in s["evidence"])
                    and s["content_sha256"] == _signoff_hash(s))
    except Exception:  # noqa: BLE001
        return False


def _structure_ok(rec: Any, expected_id: str | None) -> bool:
    hc = _hc()
    try:
        if not isinstance(rec, dict) or set(rec) != REC_KEYS or rec["schema"] != SCHEMA:
            return False
        ev_ids = [e.get("id") for e in rec["evidence"]] if isinstance(rec["evidence"], list) else None
        keys = [canon_bytes(e["ref"]) for e in rec["evidence"]] if ev_ids is not None else None
        return bool(
            isinstance(rec["id"], str) and ID_RE.match(rec["id"]) and (expected_id is None or rec["id"] == expected_id)
            and _is_int(rec["rev"]) and rec["rev"] >= 1
            and (rec["project_id"] is None or (isinstance(rec["project_id"], str) and hc._ID_RE["proj"].match(rec["project_id"])))
            and isinstance(rec["request_id"], str) and REQ_RE.match(rec["request_id"])
            and isinstance(rec["question"], str) and rec["question"].strip() and len(rec["question"]) <= TEXT_MAX and not _CTRL.search(rec["question"])
            and rec["status"] in STATUSES and ref_ok(rec["target"])
            and ev_ids is not None and len(rec["evidence"]) <= EVIDENCE_MAX
            and all(isinstance(e, dict) and set(e) == {"id", "ref", "added_at"} and isinstance(e["id"], str) and EVID_RE.match(e["id"]) and ref_ok(e["ref"])
                    and _is_int(e["added_at"]) for e in rec["evidence"])
            and len(set(ev_ids)) == len(ev_ids) and len(set(keys)) == len(keys)  # type: ignore[arg-type]
            and all(isinstance(rec[k], str) and len(rec[k]) <= TEXT_MAX and not _CTRL.search(rec[k]) for k in ("note", "followup_note"))
            and _is_int(rec["created_at"]) and _is_int(rec["updated_at"]) and isinstance(rec["seal"], str) and _SHA_RE.match(rec["seal"])
            and isinstance(rec["signoffs"], list) and len(rec["signoffs"]) <= SIGNOFFS_MAX
        )
    except Exception:  # noqa: BLE001 - a hostile stored value is "invalid", never an exception
        return False


def _signoffs_ok(rec: dict) -> bool:
    ids = [s.get("id") for s in rec["signoffs"] if isinstance(s, dict)]
    reqs = [s.get("request_id") for s in rec["signoffs"] if isinstance(s, dict)]
    return all(_signoff_ok(s) for s in rec["signoffs"]) and len(set(ids)) == len(ids) == len(rec["signoffs"]) and len(set(reqs)) == len(reqs)


def _read_one(directory: Path, vid: str) -> tuple[dict | None, str]:
    """``(record or None, integrity)``: ``ok`` | ``corrupt`` (structure fine, seal / signoff mismatch) | ``invalid`` (preserved, never repaired).
    ``FileNotFoundError`` = absent; an unreadable file raises ``VerificationStorageError``."""
    try:
        raw = canon.read_regular(directory / (vid + ".json"), FILE_BYTES_MAX)
    except FileNotFoundError:
        raise
    except canon.Noncanonical:
        return None, "invalid"
    except OSError as e:
        raise VerificationStorageError("Vérification illisible") from e
    try:
        rec = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "invalid"
    if not _structure_ok(rec, vid):
        return None, "invalid"
    return rec, ("ok" if rec["seal"] == seal(rec) and _signoffs_ok(rec) else "corrupt")


def _names(directory: Path) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise VerificationStorageError("Vérifications inaccessibles") from e
    return sorted(n[:-5] for n in names if n.endswith(".json") and ID_RE.match(n[:-5]))


def _write(directory: Path, rec: dict) -> None:
    rec["seal"] = seal(rec)
    raw = canon_bytes(rec)
    if len(raw) > FILE_BYTES_MAX:
        raise VerificationConflict("Vérification trop volumineuse", code="verification_limit")
    ann.publish(directory, rec["id"] + ".json", raw, "Vérification")
    _forget(directory, rec["id"])


# ---------------------------------------------------------------- header index (a CACHE: lstat-keyed, rebuilt from the files)

_idx: dict[tuple[str, str], tuple[tuple, dict]] = {}
_idx_lock = threading.Lock()
_IDX_MAX = TOTAL_MAX + 64


def _sig(st: os.stat_result) -> tuple:
    return (st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino, st.st_dev)


def _forget(directory: Path, vid: str | None = None) -> None:
    with _idx_lock:
        if vid is None:
            for k in [k for k in _idx if k[0] == str(directory)]:
                _idx.pop(k, None)
        else:
            _idx.pop((str(directory), vid), None)


def drop_index() -> None:
    """Drop the whole cache (tests / operators). The next call rebuilds identical answers from the files."""
    with _idx_lock:
        _idx.clear()


def header(rec: dict, integ: str) -> dict:
    last = rec["signoffs"][-1] if rec["signoffs"] else None
    return {
        "id": rec["id"], "rev": rec["rev"], "integrity": integ, "project_id": rec["project_id"], "request_id": rec["request_id"], "status": rec["status"],
        "question": rec["question"][:300], "target": rec["target"], "evidence_count": len(rec["evidence"]), "signoff_count": len(rec["signoffs"]),
        "last_signoff_at": last["signed_at"] if last else None, "verification_fingerprint": fingerprint(rec), "created_at": rec["created_at"],
        "updated_at": rec["updated_at"], "rel": sorted({relation_key(rec["target"])} | {relation_key(e["ref"]) for e in rec["evidence"]}),
        "target_key": relation_key(rec["target"]),
    }


def _headers(root: Path) -> list[dict]:
    """Every file's header, read-only. Cold: one bounded read per file; warm: ``lstat`` only. A corrupt / invalid file never poisons the others."""
    directory = _confined(root)
    out: list[dict] = []
    names = _names(directory)
    if len(names) > TOTAL_MAX + 50:
        raise VerificationStorageError("Trop de vérifications")
    seen = set()
    with store_lock(root):
        for vid in names:
            key = (str(directory), vid)
            seen.add(key)
            try:
                st = os.lstat(directory / (vid + ".json"))
            except FileNotFoundError:
                continue
            except OSError as e:
                raise VerificationStorageError("Vérifications inaccessibles") from e
            sig = _sig(st)
            with _idx_lock:
                hit = _idx.get(key)
            if hit and hit[0] == sig and _stat.S_ISREG(st.st_mode):
                out.append(hit[1])
                continue
            try:
                rec, integ = _read_one(directory, vid)
            except FileNotFoundError:
                continue
            h = {"id": vid, "integrity": "invalid", "rev": None, "project_id": None, "request_id": None, "status": None, "question": "", "target": None,
                 "evidence_count": 0, "signoff_count": 0, "last_signoff_at": None, "verification_fingerprint": None, "created_at": None, "updated_at": None,
                 "rel": [], "target_key": None} if rec is None else header(rec, integ)
            with _idx_lock:
                if len(_idx) >= _IDX_MAX:
                    _idx.clear()
                _idx[key] = (sig, h)
            out.append(h)
    with _idx_lock:
        for k in [k for k in _idx if k[0] == str(directory) and k not in seen]:
            _idx.pop(k, None)
    return out


def _public_header(h: dict) -> dict:
    return {k: v for k, v in h.items() if k not in ("rel", "target_key", "request_id")}


# ---------------------------------------------------------------- freshness (read-only, on demand, never persisted)


def _worst(states: list[str]) -> str:
    for s in ("corrupt", "integrity_anomaly", "unknown"):
        if s in states:
            return s
    if any(s in ("changed", "changed_or_removed", "missing", "unavailable", "added_since") for s in states):
        return "changed"
    return "unchanged" if states else "unknown"


def _compare(kind: str, captured: dict | None, obs: dict) -> str:
    st = obs["state"]
    if st in ("unknown", "corrupt"):
        return st
    if st == "missing":
        if kind == "citation":
            return "changed_or_removed" if obs["reason"] == "citation_changed_or_removed" else "unavailable"
        return "missing"
    if captured is None:
        return "added_since"
    if obs["seal"] == captured:
        return "unchanged"
    return "integrity_anomaly" if kind == "drawing" else "changed"


RESOLVE_IDS_MAX = 25


def resolve(rec: dict, integ: str = "ok", world: "ev.World | None | bool" = False) -> dict:
    """READ-ONLY, batched: the CURRENT state of the target and every evidence ref (one World, per-entry failure isolation). Before any signoff only
    existence is reported; afterwards every entry is compared with the LATEST signoff's captured seal."""
    if world is False:
        try:
            world = ev.World()
        except Exception:  # noqa: BLE001
            world = None
    last = rec["signoffs"][-1] if rec["signoffs"] else None

    def one(ref: dict, captured: dict | None, has_capture: bool) -> dict:
        obs = observe_ref(ref, world) if world is not None else _ob("unknown", None, "notebook_unavailable")
        row = {"kind": ref["kind"], "ref": ref, "exists": obs["state"], "reason": obs["reason"], "freshness": None}
        if has_capture:
            row["freshness"] = _compare(ref["kind"], captured, obs)
        return row

    target = one(rec["target"], last["target_seal"]["seal"] if last else None, last is not None)
    cap = {e["evidence_id"]: e for e in last["evidence"]} if last else {}
    rows = []
    for e in rec["evidence"]:
        row = one(e["ref"], cap[e["id"]]["seal"] if e["id"] in cap else None, last is not None)
        row["evidence_id"] = e["id"]
        rows.append(row)
    overall = None
    if last is not None:
        overall = _worst([r["freshness"] for r in [target, *rows]])
        if any(r["freshness"] == "added_since" for r in rows) or fingerprint(rec) != last["verification_fingerprint"]:
            overall = overall if overall != "unchanged" else "changed"
    return {"target": target, "evidence": rows, "overall": overall, "definition_changed": last is not None and fingerprint(rec) != last["verification_fingerprint"],
            "has_signoff": last is not None, "last_signoff_at": last["signed_at"] if last else None, "integrity": integ}


# ---------------------------------------------------------------- public shapes


def _public(rec: dict, integ: str) -> dict:
    out = {k: v for k, v in rec.items() if k != "seal"}
    out["integrity"] = integ
    out["verification_fingerprint"] = fingerprint(rec)
    return out


def _get_locked(directory: Path, vid: str) -> tuple[dict, str]:
    try:
        rec, integ = _read_one(directory, vid)
    except FileNotFoundError as e:
        raise VerificationNotFound("Vérification introuvable") from e
    if rec is None:
        raise VerificationConflict("Vérification invalide — conservée telle quelle", code="verification_corrupt")
    return rec, integ


def _need_ok(integ: str) -> None:
    if integ != "ok":
        raise VerificationConflict("Vérification altérée — lecture seule, conservée telle quelle", code="verification_corrupt")


def _req_id(data: dict) -> str:
    v = data.get("id")
    if not isinstance(v, str) or not ID_RE.match(v):
        raise VerificationError("Vérification invalide")
    return v


def _req_rev(data: dict) -> int:
    v = data.get("expected_rev")
    if not _is_int(v) or v < 1:
        raise VerificationError("expected_rev invalide")
    return v


def _req_request(data: dict) -> str:
    v = data.get("request_id")
    if not isinstance(v, str) or not REQ_RE.match(v):
        raise VerificationError("Identifiant de requête invalide")
    return v


def _only(data: dict, allowed: set[str]) -> None:
    _hc()._only_keys(data, allowed)


def _stale(rec: dict) -> VerificationConflict:
    return VerificationConflict("Cette vérification a changé — rechargez avant de continuer", code="verification_conflict", current_rev=rec["rev"])


# ---------------------------------------------------------------- reads


def list_verifications(data: Any) -> dict:
    """READ-ONLY. ``{action, project_id?, status?, target_kind?}`` -> at most ``LIST_MAX`` headers (corrupt / invalid ones are listed read-only)."""
    if not isinstance(data, dict):
        raise VerificationError("Requête invalide")
    _only(data, {"action", "project_id", "status", "target_kind"})
    status, kind, pid = data.get("status"), data.get("target_kind"), data.get("project_id")
    if status is not None and status not in STATUSES:
        raise VerificationError("Statut invalide")
    if kind is not None and kind not in KINDS:
        raise VerificationError("Type de cible invalide")
    if pid is not None and (not isinstance(pid, str) or not _hc()._ID_RE["proj"].match(pid)):
        raise VerificationError("Projet invalide")
    rows = _headers(_root())
    bad = [h for h in rows if h["integrity"] != "ok"]
    good = [h for h in rows if h["integrity"] == "ok" and (status is None or h["status"] == status) and (kind is None or h["target"]["kind"] == kind)
            and (pid is None or h["project_id"] == pid)]
    good.sort(key=lambda h: (-h["updated_at"], h["id"]))
    shown = (good + (bad if status is None and kind is None and pid is None else []))[:LIST_MAX]
    counts = {s: sum(1 for h in rows if h["integrity"] == "ok" and h["status"] == s) for s in STATUSES}
    return {"ok": True, "read_only": True, "verifications": [_public_header(h) for h in shown], "truncated": len(good) + (len(bad) if status is None and kind is None and pid is None else 0) > LIST_MAX,
            "counts": counts, "unavailable": len(bad), "total": len(rows), "limits": limits(), "disclosure": DISCLOSURE}


def headers_for(ids: list[str]) -> dict[str, dict]:
    """READ-ONLY. ``{id: public header}`` for the given verification ids (absent ids are simply not returned). Used by the Phase 12 reasoning
    register to SUMMARISE linked verifications (status / integrity / project); it never mutates anything and this module never imports it."""
    rows = {h["id"]: h for h in _headers(_root())}
    return {i: _public_header(rows[i]) for i in ids if i in rows}


def get(data: Any) -> dict:
    """READ-ONLY. One verification in full (corrupt ones too: read-only)."""
    if not isinstance(data, dict):
        raise VerificationError("Requête invalide")
    _only(data, {"action", "id"})
    vid = _req_id(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, vid)
    return {"ok": True, "read_only": True, "verification": _public(rec, integ), "limits": limits(), "disclosure": DISCLOSURE}


def resolve_one(data: Any) -> dict:
    """READ-ONLY. The current state of the target and the evidence of one verification (``id``) or of up to ``RESOLVE_IDS_MAX`` of them (``ids``,
    one shared observation world, per-record failure isolation)."""
    if not isinstance(data, dict):
        raise VerificationError("Requête invalide")
    _only(data, {"action", "id", "ids"})
    root = _root()
    directory = _confined(root)
    if "ids" in data:
        ids = data["ids"]
        if "id" in data or not isinstance(ids, list) or not (1 <= len(ids) <= RESOLVE_IDS_MAX) or any(not isinstance(i, str) or not ID_RE.match(i) for i in ids):
            raise VerificationError("Requête invalide")
        try:
            world: Any = ev.World()
        except Exception:  # noqa: BLE001
            world = None
        results = []
        for vid in dict.fromkeys(ids):
            try:
                with store_lock(root):
                    rec, integ = _get_locked(directory, vid)
                results.append({"id": vid, "resolved": resolve(rec, integ, world)})
            except VerificationNotFound:
                results.append({"id": vid, "error": "not_found"})
            except (VerificationError, VerificationStorageError) as e:
                results.append({"id": vid, "error": e.payload.get("code", "error") if hasattr(e, "payload") else "error"})
        return {"ok": True, "read_only": True, "results": results}
    vid = _req_id(data)
    with store_lock(root):
        rec, integ = _get_locked(directory, vid)
    return {"ok": True, "read_only": True, "id": vid, "resolved": resolve(rec, integ)}


def related(data: Any) -> dict:
    """READ-ONLY. ``{action, targets:[ref...]}`` (1..``TARGETS_PER_RELATED_MAX``) -> per ref the verifications whose TARGET or EVIDENCE it is, from
    the header index only: evidence is never resolved here. Untrusted (corrupt / invalid) files are counted, never related."""
    if not isinstance(data, dict) or set(data) != {"action", "targets"} or not isinstance(data["targets"], list) or not (1 <= len(data["targets"]) <= TARGETS_PER_RELATED_MAX):
        raise VerificationError("Requête invalide")
    refs: list[dict] = []
    for raw in data["targets"]:
        r = parse_ref(raw, "lookup")
        if r not in refs:
            refs.append(r)
    rows = _headers(_root())
    untrusted = sum(1 for h in rows if h["integrity"] != "ok")
    good = [h for h in rows if h["integrity"] == "ok"]
    out, left, truncated = [], LIST_MAX, False
    for r in refs:
        key = relation_key(r)
        hits = []
        for h in sorted((h for h in good if key in h["rel"]), key=lambda h: (-h["updated_at"], h["id"])):
            if left <= 0:
                truncated = True
                continue
            hits.append({**_public_header(h), "role": "target" if h["target_key"] == key else "evidence"})
            left -= 1
        counts = {s: sum(1 for h in hits if h["status"] == s) for s in STATUSES}
        out.append({"target": r, "verifications": hits, "counts": counts})
    return {"ok": True, "read_only": True, "results": out, "truncated": truncated, "unavailable": untrusted, "limits": limits()}


# ---------------------------------------------------------------- create


def _create(data: dict) -> dict:
    _only(data, {"action", "request_id", "question", "target", "project_id"})
    request_id = _req_request(data)
    question = _text(data.get("question"), "Question", required=True)
    target = parse_ref(data.get("target"), "create")
    intent = (canon_bytes(target), question)
    root = _root()
    directory = _confined(root)
    supplied = data.get("project_id")
    if supplied is not None and (not isinstance(supplied, str) or not _hc()._ID_RE["proj"].match(supplied)):
        raise VerificationError("Projet invalide")

    def replay() -> dict | None:
        for h in _headers(root):
            if h["integrity"] != "ok" or h["request_id"] != request_id:
                continue
            rec, integ = _get_locked(directory, h["id"])
            if (canon_bytes({k: v for k, v in rec["target"].items() if k != "item_fingerprint"}) != canon_bytes({k: v for k, v in target.items() if k != "item_fingerprint"})
                    or rec["question"] != question
                    # the effective project is part of the intent: source / drawing store the REQUESTED project (omitted == none);
                    # every other kind derives it from canonical evidence, so only an explicit, different request conflicts
                    or (target["kind"] in ("source", "drawing") and supplied != rec["project_id"])
                    or (target["kind"] not in ("source", "drawing") and supplied is not None and supplied != rec["project_id"])):
                raise VerificationConflict("Cette requête de vérification existe déjà avec un autre contenu", code="verification_request_conflict")
            return {"ok": True, "replayed": True, "verification": _public(rec, integ)}
        return None

    with store_lock(root):
        got = replay()
    if got is not None:
        return got
    world = ev.World()
    target, _obs = complete_ref(target, world)
    kind = target["kind"]
    if kind in ("page", "block", "citation"):
        project_id = world.pages[target["page_id"]]["project_id"]
    elif kind == "snapshot":
        project_id = world.snapshot(target["snapshot_id"])[1]["project"]["id"]
    elif kind == "review_item":
        project_id = reviews.get(target["review_id"])["review"]["project_id"]
    else:
        project_id = supplied
        if project_id is not None and not any(p["id"] == project_id for p in world.state["projects"]):
            raise VerificationNotFound("Projet introuvable")
    if supplied is not None and kind not in ("source", "drawing") and supplied != project_id:
        raise VerificationError("Projet invalide")
    directory = _confined(root, create=True)
    with store_lock(root):
        got = replay()
        if got is not None:
            return got
        rows = _headers(root)
        if len(rows) >= TOTAL_MAX:
            raise VerificationConflict(f"Limite atteinte : {TOTAL_MAX} vérifications", code="verification_limit")
        if project_id is not None and sum(1 for h in rows if h["project_id"] == project_id) >= PROJECT_MAX:
            raise VerificationConflict(f"Limite atteinte : {PROJECT_MAX} vérifications par projet", code="verification_limit")
        now = _now()
        vid = "ver-" + secrets.token_hex(12)
        while os.path.lexists(directory / (vid + ".json")):
            vid = "ver-" + secrets.token_hex(12)
        rec = {"schema": SCHEMA, "id": vid, "rev": 1, "project_id": project_id, "request_id": request_id, "question": question, "status": "open", "target": target,
               "evidence": [], "note": "", "followup_note": "", "created_at": now, "updated_at": now, "signoffs": [], "seal": "0" * 64}
        _write(directory, rec)
    return {"ok": True, "replayed": False, "verification": _public(rec, "ok")}


# ---------------------------------------------------------------- locked edits


def _locked_edit(data: dict, fn, *, bump: bool = True) -> dict:
    vid = _req_id(data)
    expected = _req_rev(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, vid)
        _need_ok(integ)
        if rec["rev"] != expected:
            raise _stale(rec)
        fn(rec)
        rec["rev"] += 1
        rec["updated_at"] = _now()
        _write(directory, rec)
    return {"ok": True, "verification": _public(rec, "ok")}


def _update(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "question", "note"})
    if "question" not in data and "note" not in data:
        raise VerificationError("Aucune modification")
    question = _text(data["question"], "Question", required=True) if "question" in data else None
    note = _text(data["note"], "Note", required=False) if "note" in data else None

    def apply(rec: dict) -> None:
        if question is not None:
            if rec["status"] not in EDITABLE:
                raise VerificationConflict("Rouvrez la vérification avant de modifier la question", code="verification_state_invalid", status_now=rec["status"])
            rec["question"] = question
        if note is not None:
            rec["note"] = note  # commentary: editable at any time; never part of a signoff fingerprint

    return _locked_edit(data, apply)


def _evidence_add(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "ref"})
    ref = parse_ref(data.get("ref"), "create")
    world = ev.World()
    ref, _obs = complete_ref(ref, world)

    def apply(rec: dict) -> None:
        if rec["status"] not in EDITABLE:
            raise VerificationConflict("Rouvrez la vérification avant de modifier les preuves", code="verification_state_invalid", status_now=rec["status"])
        if any(e["ref"] == ref for e in rec["evidence"]):
            raise VerificationConflict("Cette preuve est déjà liée", code="verification_duplicate_evidence")
        if len(rec["evidence"]) >= EVIDENCE_MAX:
            raise VerificationConflict(f"Limite atteinte : {EVIDENCE_MAX} preuves", code="verification_limit")
        rec["evidence"].append({"id": "ve-" + secrets.token_hex(8), "ref": ref, "added_at": _now()})

    return _locked_edit(data, apply)


def _evidence_remove(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "evidence_id"})
    evid = data.get("evidence_id")
    if not isinstance(evid, str) or not EVID_RE.match(evid):
        raise VerificationError("Preuve invalide")

    def apply(rec: dict) -> None:
        if rec["status"] not in EDITABLE:
            raise VerificationConflict("Rouvrez la vérification avant de modifier les preuves", code="verification_state_invalid", status_now=rec["status"])
        keep = [e for e in rec["evidence"] if e["id"] != evid]
        if len(keep) == len(rec["evidence"]):
            raise VerificationNotFound("Preuve introuvable")
        rec["evidence"] = keep

    return _locked_edit(data, apply)


_TRANSITIONS = {("open", "ready"), ("open", "needs_followup"), ("ready", "open"), ("ready", "needs_followup"), ("verified", "open"),
                ("verified", "needs_followup"), ("needs_followup", "open"), ("needs_followup", "needs_followup")}


def _status(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "status", "followup_note"})
    target = data.get("status")
    if target == "verified":
        raise VerificationError("« Vérifiée » n'est atteinte que par un enregistrement explicite de vérification", code="verification_signoff_required")
    if target not in STATUSES:
        raise VerificationError("Statut invalide")
    follow = None
    if target == "needs_followup":
        follow = _text(data.get("followup_note"), "Motif de reprise", required=True)
    elif "followup_note" in data:
        raise VerificationError("Motif de reprise non applicable")

    def apply(rec: dict) -> None:
        if (rec["status"], target) not in _TRANSITIONS:
            raise VerificationConflict("Transition de statut non autorisée", code="verification_state_invalid", status_now=rec["status"])
        if target == "ready" and not rec["evidence"]:
            raise VerificationConflict("Au moins une preuve est requise avant « Prête à vérifier »", code="verification_no_evidence")
        rec["status"] = target
        if follow is not None:
            rec["followup_note"] = follow  # the previous reason is replaced only by a NEW explicit needs_followup; leaving the state keeps it

    return _locked_edit(data, apply)


def _delete(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "confirm"})
    if data.get("confirm") is not True:
        raise VerificationError("Confirmation requise", code="verification_confirm_required")
    vid = _req_id(data)
    expected = _req_rev(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, vid)
        _need_ok(integ)
        if rec["rev"] != expected:
            raise _stale(rec)
        if rec["signoffs"]:
            raise VerificationConflict("Cette vérification a un historique d'enregistrements — suppression refusée", code="verification_has_signoff")
        path = directory / (vid + ".json")
        try:
            st = os.lstat(path)
            if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode):
                raise VerificationConflict("Vérification non canonique — suppression refusée", code="verification_corrupt")
            os.unlink(path)
        except FileNotFoundError as e:
            raise VerificationNotFound("Vérification introuvable") from e
        except OSError as e:
            raise VerificationStorageError("Suppression impossible") from e
        _forget(directory, vid)
    return {"ok": True, "deleted": vid}


# ---------------------------------------------------------------- signoff


def _observe_all(rec: dict) -> dict:
    """ONE observation round: the target and every evidence ref, from a FRESH World (nothing memoised across rounds)."""
    world = ev.World()
    return {"target": observe_ref(rec["target"], world), "evidence": {e["id"]: observe_ref(e["ref"], world) for e in rec["evidence"]}}


def _unavailable(obs: dict) -> list[dict]:
    rows = []
    if obs["target"]["state"] in UNSIGNABLE:
        rows.append({"role": "target", "state": obs["target"]["state"], "reason": obs["target"]["reason"]})
    for evid, o in obs["evidence"].items():
        if o["state"] in UNSIGNABLE:
            rows.append({"role": "evidence", "evidence_id": evid, "state": o["state"], "reason": o["reason"]})
    return rows


def _replay_signoff(rec: dict, request_id: str, expected: int, fp_given: str | None) -> dict | None:
    for s in rec["signoffs"]:
        if s["request_id"] == request_id:
            if s["verification_rev"] != expected or (fp_given is not None and fp_given != s["verification_fingerprint"]):
                raise VerificationConflict("Cette requête d'enregistrement existe déjà avec un autre contenu", code="verification_request_conflict")
            return s
    return None


def _signoff(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "request_id", "verification_fingerprint"})
    vid = _req_id(data)
    expected = _req_rev(data)
    request_id = _req_request(data)
    fp_given = data.get("verification_fingerprint")
    if fp_given is not None and (not isinstance(fp_given, str) or not _SHA_RE.match(fp_given)):
        raise VerificationError("Empreinte invalide")
    root = _root()
    directory = _confined(root)

    def preflight(rec: dict, integ: str) -> dict | None:
        _need_ok(integ)
        done = _replay_signoff(rec, request_id, expected, fp_given)  # BEFORE the expected_rev rejection: a lost response must replay, not 409
        if done is not None:
            return {"ok": True, "replayed": True, "verification": _public(rec, integ), "signoff": done}
        if rec["rev"] != expected:
            raise _stale(rec)
        if rec["status"] != "ready" or not rec["evidence"]:
            raise VerificationConflict("La vérification doit être « Prête à vérifier » avec au moins une preuve", code="verification_not_ready", status_now=rec["status"])
        if fp_given is not None and fp_given != fingerprint(rec):
            raise VerificationConflict("La définition de la vérification a changé", code="verification_request_conflict")
        return None

    with store_lock(root):
        rec, integ = _get_locked(directory, vid)
        done = preflight(rec, integ)
    if done is not None:
        return done
    # observation rounds run OUTSIDE the verification lock (other stores' locks are taken inside them); the commit below re-checks everything
    obs_a = _observe_all(rec)
    obs_b = _observe_all(rec)
    if obs_a != obs_b:
        raise VerificationConflict("Les preuves ont changé pendant l'enregistrement — rien n'est enregistré", code="verification_capture_race")
    bad = _unavailable(obs_b)
    if bad:
        raise VerificationConflict(UNAVAILABLE_MESSAGE, code="verification_evidence_unavailable", entries=bad)
    with store_lock(root):
        rec2, integ2 = _get_locked(directory, vid)
        done = preflight(rec2, integ2)
        if done is not None:
            return done
        if seal(rec2) != seal(rec):
            raise VerificationConflict("La vérification a changé pendant l'enregistrement — rien n'est enregistré", code="verification_capture_race")
        if len(rec2["signoffs"]) >= SIGNOFFS_MAX:
            raise VerificationConflict(f"Limite atteinte : {SIGNOFFS_MAX} enregistrements", code="verification_limit")
        so = {"id": "vs-" + secrets.token_hex(8), "request_id": request_id, "signed_at": _now(), "verification_rev": rec2["rev"],
              "verification_fingerprint": fingerprint(rec2),
              "target_seal": {"kind": rec2["target"]["kind"], "identity": rec2["target"], "state": obs_b["target"]["state"], "seal": obs_b["target"]["seal"]},
              "evidence": sorted(({"evidence_id": e["id"], "kind": e["ref"]["kind"], "identity": e["ref"], "state": obs_b["evidence"][e["id"]]["state"],
                                   "seal": obs_b["evidence"][e["id"]]["seal"]} for e in rec2["evidence"]), key=lambda x: canon_bytes(x["identity"])),
              "content_sha256": "0" * 64}
        so["content_sha256"] = _signoff_hash(so)
        rec2["signoffs"].append(so)
        rec2["status"] = "verified"
        rec2["rev"] += 1
        rec2["updated_at"] = _now()
        _write(directory, rec2)
    return {"ok": True, "replayed": False, "verification": _public(rec2, "ok"), "signoff": so}


# ---------------------------------------------------------------- dispatch


_MUTATIONS = {
    "verification_create": _create, "verification_update": _update, "verification_evidence_add": _evidence_add,
    "verification_evidence_remove": _evidence_remove, "verification_status": _status, "verification_signoff": _signoff, "verification_delete": _delete,
}
_READS = {"verification_list": list_verifications, "verification_get": get, "verification_resolve": resolve_one, "verification_related": related}
ACTIONS = tuple(_MUTATIONS) + tuple(_READS)


def mutate(data: Any) -> dict:
    if not isinstance(data, dict) or data.get("action") not in _MUTATIONS:
        raise VerificationError("Action invalide")
    return _MUTATIONS[data["action"]](data)


def read(data: Any) -> dict:
    if not isinstance(data, dict) or data.get("action") not in _READS:
        raise VerificationError("Action invalide")
    return _READS[data["action"]](data)


# ---------------------------------------------------------------- report / backup


def report_summary(vid: str) -> dict:
    """What a deterministic report states about ONE verification: procedural facts only (no note, no conclusion)."""
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, vid)
    _need_ok(integ)
    res = resolve(rec, integ)
    last = rec["signoffs"][-1] if rec["signoffs"] else None
    return {"id": rec["id"], "question": rec["question"], "status": rec["status"], "target": rec["target"], "evidence": [e["ref"] for e in rec["evidence"]],
            "last_signoff_at": last["signed_at"] if last else None, "signoff_count": len(rec["signoffs"]), "overall": res["overall"],
            "definition_changed": res["definition_changed"]}


STATUS_LABELS = {"open": "Ouverte", "ready": "Prête à vérifier", "verified": "Vérifiée", "needs_followup": "À reprendre"}
KIND_LABELS = {"page": "Page", "block": "Bloc", "source": "Source", "citation": "Citation", "drawing": "Croquis", "snapshot": "Jalon", "review_item": "Élément de revue"}
FRESH_LABELS = {"unchanged": "inchangé depuis la vérification", "changed": "modifié depuis la vérification", "unknown": "indéterminé",
                "corrupt": "altéré", "integrity_anomaly": "anomalie d'intégrité"}


def _ident(ref: dict) -> str:
    return " · ".join(str(ref[k]) for k in _fields(ref["kind"]) if k != "item_fingerprint" and k != "citation_fingerprint") + (
        " · empreinte " + ref["citation_fingerprint"][:12] if ref["kind"] == "citation" else "")


def render_markdown(summary: dict) -> str:
    """Deterministic, procedural wording only: no note, no generated conclusion, no claim beyond "a check was recorded"."""
    lines = [f"- État de vérification : {STATUS_LABELS[summary['status']]}", "- Question : " + ev._md(summary["question"]),
             f"- Cible : {KIND_LABELS[summary['target']['kind']]} · " + ev._md(_ident(summary["target"]))]
    if summary["last_signoff_at"] is not None:
        lines.append(f"- Vérification enregistrée : {ev._utc(summary['last_signoff_at'])} ({summary['signoff_count']} enregistrement(s))")
        lines.append("- État actuel des preuves : " + FRESH_LABELS.get(summary["overall"] or "unknown", "indéterminé"))
    else:
        lines.append("- Vérification enregistrée : aucune")
    lines.append(f"- Preuves liées : {len(summary['evidence'])}")
    lines += [f"  - {KIND_LABELS[r['kind']]} · " + ev._md(_ident(r)) for r in summary["evidence"]]
    lines.append("- " + DISCLOSURE)
    return "\n".join(lines)


def closure(root: Path | str) -> dict:
    """The files a backup must carry byte-for-byte: ``{"files", "valid"}``. EVERY ``ver-*.json`` is carried; ``valid`` is False when any file
    does not verify. Nothing a verification references is followed."""
    directory = ann.store_dir(root, VER_DIR)
    files: list[str] = []
    valid = True
    try:
        _confined(Path(root))
        with store_lock(root):
            for vid in _names(directory):
                try:
                    rec, integ = _read_one(directory, vid)
                except FileNotFoundError:
                    continue
                files.append(vid + ".json")
                if rec is None or integ != "ok":
                    valid = False
    except (VerificationError, VerificationStorageError):
        valid = False
    return {"files": files, "valid": valid}


def copy_to(root: Path | str, dest: Path, names: list[str], refused: list | None = None) -> int:
    directory = _confined(Path(root))
    with store_lock(root):
        return canon.copy_canonical(directory, dest, names, ID_RE.match, FILE_BYTES_MAX, refused)
