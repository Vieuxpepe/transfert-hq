"""Carnet Phase 12: the engineering reasoning register (decisions & assumptions) — the store. Stdlib only.

    Evidence tells us what we know. Assumptions tell us what we are temporarily accepting. Decisions tell us what we chose.

A DECISION records what was chosen. An ASSUMPTION records what is being taken as true for now. NEITHER is evidence: their statement, rationale and
status never feed Ask, search, snapshots, history, intel or portals (no such module imports this one) and nothing here ever modifies a page, a
block, a source, a drawing, a snapshot, a Review Pack, an annotation or a verification. Evidence MAY inform a record (``evidence[]``, identity-only,
the same canonical identities as Phase 11); a Phase 11 verification may be LINKED (``verification_ids[]``) but is a workflow object, never evidence,
and its status never changes a record's status.

This is NOT the Phase 5 journal ``decision`` BLOCK (a timestamped line in a note: contemporaneous notebook content). Every kind that can meet that
vocabulary in a shared namespace is therefore explicit: records are ``reasoning_decision`` / ``reasoning_assumption``; actions are ``reasoning_*``.

Runtime state: ``<ROOT>/.hq-carnet/reasoning/{dec,asm}-<24 hex>.json`` — one sealed file per record::

    {"schema", "id", "rev", "kind", "project_id", "request_id", "statement", "rationale", "status", "evidence": [{"id", "ref", "added_at"}],
     "verification_ids": [{"id", "added_at"}], "supersedes", "superseded_by", "history": [event, ...], "created_at", "updated_at", "seal"}

Status (explicit, human actions only; there is no reopen from a historical state — a changed premise is a NEW record):
  decision    active -> withdrawn | superseded
  assumption  active -> confirmed | invalidated | retired | superseded ;  confirmed -> invalidated | retired | superseded
``confirmed`` is workflow state, not evidence: it needs >= 1 evidence ref AND every ref currently observable (two consistent observations A == B;
archived-but-readable is fine; missing / unknown / corrupt blocks it). Every other terminal transition stays possible when evidence cannot be
inspected: its capture is best-effort (``missing`` / ``unknown`` / ``corrupt`` are RECORDED, never an error).
Historical states (anything but ``active``) are read-only: statement, rationale, evidence set and verification links.

Every status transition appends a ``history`` event carrying a bounded identity / state / seal capture of the evidence and its own deterministic
``content_sha256`` (record id, pre-transition rev, event, statement, rationale, evidence identities and observations, verification links, time).
This is tamper detection, NOT a legal signature and NOT identity: nothing here knows who acted.

Supersession (``reasoning_supersede``): the canonical relation is the SUCCESSOR's (``B.supersedes = A``); ``A.superseded_by`` / ``A.status`` are
reflections written second. B is written first, then A: a crash between the two leaves ``supersession_pending`` (A read-only, never "safely
active"); replaying the same ``request_id`` finishes A; another successor is refused. A successor that is corrupt while A is not yet updated
gives ``supersession_indeterminate`` (a corrupt file can never resurrect an old record). A syntactically unreadable file carries no attributable
relation: that limit is documented, not hidden.

Per-record seal; a corrupt / invalid record is listed read-only and never edited, transitioned, superseded or deleted, and is never repaired.
The in-process header index is a CACHE keyed by ``lstat`` identity: dropping it rebuilds the same answers from the files.
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
import hq_carnet_reviews as reviews
import hq_carnet_verifications as ver
import hq_state

REASONING_DIR = "reasoning"
SCHEMA = 1
STATEMENT_MAX = 4000
RATIONALE_MAX = 8000
EVIDENCE_MAX = 100
VERIFICATIONS_MAX = 100
CREATE_EVIDENCE_MAX = 10
TOTAL_MAX = 5000
PROJECT_MAX = 1000
LIST_MAX = 100
TARGETS_PER_RELATED_MAX = 10
RESOLVE_IDS_MAX = 25
FILE_BYTES_MAX = 4 * 1024 * 1024
KIND_DECISION = "reasoning_decision"
KIND_ASSUMPTION = "reasoning_assumption"
KINDS = (KIND_DECISION, KIND_ASSUMPTION)
PREFIX = {KIND_DECISION: "dec", KIND_ASSUMPTION: "asm"}
STATUSES = {KIND_DECISION: ("active", "superseded", "withdrawn"), KIND_ASSUMPTION: ("active", "confirmed", "invalidated", "retired", "superseded")}
ALL_STATUSES = ("active", "confirmed", "superseded", "withdrawn", "invalidated", "retired")
EFFECTIVE_EXTRA = ("supersession_pending", "supersession_indeterminate")
TRANSITIONS = {
    KIND_DECISION: {("active", "withdrawn"), ("active", "superseded")},
    KIND_ASSUMPTION: {("active", "confirmed"), ("active", "invalidated"), ("active", "retired"), ("active", "superseded"), ("confirmed", "invalidated"),
                      ("confirmed", "retired"), ("confirmed", "superseded")},
}
EVIDENCE_KINDS = ver.KINDS
ID_RE = re.compile(r"^(?:dec|asm)-[0-9a-f]{24}\Z")
EVID_RE = re.compile(r"^re-[0-9a-f]{16}\Z")
HIST_RE = re.compile(r"^rh-[0-9a-f]{16}\Z")
REQ_RE = ver.REQ_RE
_SHA_RE = ver._SHA_RE
_CTRL = ver._CTRL
OBS_STATES = ("ok", "archived", "missing", "unknown", "corrupt")
UNCONFIRMABLE = ("missing", "unknown", "corrupt")
_ESCAPED = "Dossier du registre redirigé — refusé"
SUPERSESSION_INDETERMINATE = "État de supersession indéterminé — successeur altéré"
UNAVAILABLE_MESSAGE = "Impossible de confirmer l'hypothèse : certaines preuves ne peuvent pas être vérifiées actuellement."
DISCLOSURE = ("Registre local : une décision ou une hypothèse n'est pas une preuve ; aucune identité d'auteur authentifiée n'est associée.")


class ReasoningError(ValueError):
    status = 400
    code = "validation_error"

    def __init__(self, message: str, code: str | None = None, status: int | None = None, **extra: Any):
        super().__init__(message)
        if code:
            self.code = code
        if status:
            self.status = status
        self.payload = {"error": message, "code": self.code, **extra}


class ReasoningNotFound(ReasoningError):
    status = 404
    code = "not_found"


class ReasoningConflict(ReasoningError):
    status = 409
    code = "reasoning_conflict"


class ReasoningStorageError(RuntimeError):
    code = "reasoning_unavailable"

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
        raise ReasoningStorageError("Carnet non initialisé") from e


def _hc():
    import hq_carnet

    return hq_carnet


def canon_bytes(obj: Any) -> bytes:
    return ann.canon_bytes(obj)


def _sha(obj: Any) -> str:
    return hashlib.sha256(canon_bytes(obj)).hexdigest()


def store_lock(root: Path | str | None = None):
    return hq_state.path_lock(ann.store_dir(root if root is not None else _root(), REASONING_DIR))


def _confined(root: Path, *, create: bool = False) -> Path:
    try:
        return ann.confined_store(root, REASONING_DIR, create=create, escaped=_ESCAPED)
    except ann.AnnotationStorageError as e:
        raise ReasoningStorageError(str(e), e.status) from e


def limits() -> dict:
    return {"statement_max": STATEMENT_MAX, "rationale_max": RATIONALE_MAX, "evidence_max": EVIDENCE_MAX, "verifications_max": VERIFICATIONS_MAX,
            "total_max": TOTAL_MAX, "project_max": PROJECT_MAX, "list_max": LIST_MAX, "related_targets_max": TARGETS_PER_RELATED_MAX,
            "create_evidence_max": CREATE_EVIDENCE_MAX, "file_bytes_max": FILE_BYTES_MAX}


def kind_of_id(rid: str) -> str:
    return KIND_DECISION if rid.startswith("dec-") else KIND_ASSUMPTION


def _conflict_code(kind: str) -> str:
    return "decision_request_conflict" if kind == KIND_DECISION else "assumption_request_conflict"


# ---------------------------------------------------------------- text


def _text(value: Any, what: str, *, required: bool, maximum: int) -> str:
    """Plain text, stored exactly as typed. ``\\n`` / ``\\t`` allowed; other control characters refused; whitespace-only = empty."""
    if not isinstance(value, str) or len(value) > maximum or _CTRL.search(value):
        raise ReasoningError(f"{what} invalide")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise ReasoningError(f"{what} invalide") from e
    if not value.strip():
        if required:
            raise ReasoningError(f"{what} requis")
        return ""
    return value


def _statement(v: Any) -> str:
    return _text(v, "Énoncé", required=True, maximum=STATEMENT_MAX)


def _rationale(v: Any) -> str:
    return _text(v, "Justification", required=False, maximum=RATIONALE_MAX)


# ---------------------------------------------------------------- identities (shared with Phase 11, errors translated)


def _wrap(fn, *a):
    try:
        return fn(*a)
    except ver.VerificationNotFound as e:
        raise ReasoningNotFound("Cette preuve n'existe pas — rien n'est enregistré", code="reasoning_evidence_missing") from e
    except ver.VerificationConflict as e:
        raise ReasoningConflict("Cette preuve est altérée — rien n'est enregistré", code="reasoning_evidence_unavailable") from e
    except ver.VerificationStorageError as e:
        raise ReasoningStorageError(str(e)) from e
    except ver.VerificationError as e:
        raise ReasoningError("Preuve invalide") from e


def parse_ref(raw: Any, mode: str) -> dict:
    ref = _wrap(ver.parse_ref, raw, mode)
    return ref


def ref_ok(ref: Any) -> bool:
    return ver.ref_ok(ref)


def relation_key(ref: dict) -> str:
    return ver.relation_key(ref)


def _complete(ref: dict, world: "ev.World") -> dict:
    return _wrap(ver.complete_ref, ref, world)[0]


def _ident_key(ref: dict) -> bytes:
    """Identity for de-duplication / replay comparison: a review item is identified by (review, item); its captured fingerprint is not part of it."""
    return canon_bytes({k: v for k, v in ref.items() if k != "item_fingerprint"})


def _ev_project(ref: dict, world: "ev.World") -> str | None:
    """The canonical project of project-owned evidence; ``None`` for the project-neutral kinds (source, drawing)."""
    kind = ref["kind"]
    try:
        if kind in ("page", "block", "citation"):
            return world.pages[ref["page_id"]]["project_id"]
        if kind == "snapshot":
            return world.snapshot(ref["snapshot_id"])[1]["project"]["id"]
        if kind == "review_item":
            return reviews.get(ref["review_id"])["review"]["project_id"]
    except (KeyError, TypeError, reviews.ReviewError, reviews.ReviewStorageError) as e:
        raise ReasoningConflict("Cette preuve est inaccessible actuellement", code="reasoning_evidence_unavailable") from e
    return None


def _check_project(ref: dict, project_id: str, world: "ev.World") -> None:
    owner = _ev_project(ref, world)
    if owner is not None and owner != project_id:
        raise ReasoningError("Cette preuve appartient à un autre projet", code="reasoning_project_mismatch")


# ---------------------------------------------------------------- records, seals, event hashes


REC_KEYS = {"schema", "id", "rev", "kind", "project_id", "request_id", "statement", "rationale", "status", "evidence", "verification_ids", "supersedes",
            "superseded_by", "history", "created_at", "updated_at", "seal"}
EVENT_KEYS = {"id", "event", "at", "rev_before", "successor_id", "evidence", "content_sha256"}
CAP_KEYS = {"evidence_id", "kind", "identity", "state", "seal"}


def seal(rec: dict) -> str:
    return hashlib.sha256(canon_bytes({k: v for k, v in rec.items() if k != "seal"})).hexdigest()


def _event_hash(rec: dict, e: dict) -> str:
    """Deterministic fingerprint of one transition: bound to the record id and to the record's (by then immutable) content. Live-resolved titles
    never enter it."""
    return _sha({"record_id": rec["id"], "rev_before": e["rev_before"], "event": e["event"], "at": e["at"], "successor_id": e["successor_id"],
                 "statement": rec["statement"], "rationale": rec["rationale"],
                 "evidence_identities": sorted(canon_bytes(x["ref"]).decode("ascii") for x in rec["evidence"]),
                 "capture": e["evidence"], "verification_ids": sorted(v["id"] for v in rec["verification_ids"])})


def _cap_ok(c: Any) -> bool:
    try:
        return bool(isinstance(c, dict) and set(c) == CAP_KEYS and isinstance(c["evidence_id"], str) and EVID_RE.match(c["evidence_id"]) and ref_ok(c["identity"])
                    and c["kind"] == c["identity"]["kind"] and c["state"] in OBS_STATES
                    and ((c["state"] in ("ok", "archived")) == isinstance(c["seal"], dict)) and (c["seal"] is None or isinstance(c["seal"], dict)))
    except Exception:  # noqa: BLE001
        return False


def _event_shape_ok(e: Any, kind: str) -> bool:
    try:
        if not isinstance(e, dict) or set(e) != EVENT_KEYS or not isinstance(e["id"], str) or not HIST_RE.match(e["id"]):
            return False
        allowed = {t for _f, t in TRANSITIONS[kind]}
        if e["event"] not in allowed or not _is_int(e["at"]) or not _is_int(e["rev_before"]) or e["rev_before"] < 1:
            return False
        if (e["event"] == "superseded") != (e["successor_id"] is not None):
            return False
        if e["successor_id"] is not None and not (isinstance(e["successor_id"], str) and ID_RE.match(e["successor_id"]) and kind_of_id(e["successor_id"]) == kind):
            return False
        caps = e["evidence"]
        return bool(isinstance(caps, list) and len(caps) <= EVIDENCE_MAX and all(_cap_ok(c) for c in caps) and isinstance(e["content_sha256"], str)
                    and _SHA_RE.match(e["content_sha256"])
                    and (e["event"] != "confirmed" or (caps and all(c["state"] in ("ok", "archived") for c in caps))))
    except Exception:  # noqa: BLE001
        return False


def _history_shape_ok(rec: dict) -> bool:
    state = "active"
    ids = []
    for e in rec["history"]:
        if not _event_shape_ok(e, rec["kind"]) or (state, e["event"]) not in TRANSITIONS[rec["kind"]]:
            return False
        state = e["event"]
        ids.append(e["id"])
    last = rec["history"][-1] if rec["history"] else None
    return bool(state == rec["status"] and len(set(ids)) == len(ids)
                and (rec["status"] == "superseded") == (rec["superseded_by"] is not None)
                and (last is None or last["successor_id"] == rec["superseded_by"]))


def _history_ok(rec: dict) -> bool:
    return all(e["content_sha256"] == _event_hash(rec, e) for e in rec["history"])


def _structure_ok(rec: Any, expected_id: str | None) -> bool:
    hc = _hc()
    try:
        if not isinstance(rec, dict) or set(rec) != REC_KEYS or rec["schema"] != SCHEMA or rec["kind"] not in KINDS:
            return False
        kind = rec["kind"]
        rid = rec["id"]
        ev_ids = [e.get("id") for e in rec["evidence"]] if isinstance(rec["evidence"], list) else None
        keys = [_ident_key(e["ref"]) for e in rec["evidence"]] if ev_ids is not None else None
        vlist = rec["verification_ids"]
        vids = [v.get("id") for v in vlist] if isinstance(vlist, list) else None
        link_ok = lambda x: x is None or (isinstance(x, str) and ID_RE.match(x) and kind_of_id(x) == kind and x != rid)  # noqa: E731
        return bool(
            isinstance(rid, str) and ID_RE.match(rid) and kind_of_id(rid) == kind and (expected_id is None or rid == expected_id)
            and _is_int(rec["rev"]) and rec["rev"] >= 1
            and isinstance(rec["project_id"], str) and hc._ID_RE["proj"].match(rec["project_id"])
            and isinstance(rec["request_id"], str) and REQ_RE.match(rec["request_id"])
            and isinstance(rec["statement"], str) and rec["statement"].strip() and len(rec["statement"]) <= STATEMENT_MAX and not _CTRL.search(rec["statement"])
            and isinstance(rec["rationale"], str) and len(rec["rationale"]) <= RATIONALE_MAX and not _CTRL.search(rec["rationale"])
            and rec["status"] in STATUSES[kind]
            and ev_ids is not None and len(rec["evidence"]) <= EVIDENCE_MAX
            and all(isinstance(e, dict) and set(e) == {"id", "ref", "added_at"} and isinstance(e["id"], str) and EVID_RE.match(e["id"]) and ref_ok(e["ref"])
                    and _is_int(e["added_at"]) for e in rec["evidence"])
            and len(set(ev_ids)) == len(ev_ids) and len(set(keys)) == len(keys)  # type: ignore[arg-type]
            and vids is not None and len(vlist) <= VERIFICATIONS_MAX
            and all(isinstance(v, dict) and set(v) == {"id", "added_at"} and isinstance(v["id"], str) and ver.ID_RE.match(v["id"]) and _is_int(v["added_at"])
                    for v in vlist) and len(set(vids)) == len(vids)
            and link_ok(rec["supersedes"]) and link_ok(rec["superseded_by"])
            and (rec["supersedes"] is None or rec["supersedes"] != rec["superseded_by"])
        ) and bool(
            _is_int(rec["created_at"]) and _is_int(rec["updated_at"]) and isinstance(rec["seal"], str) and _SHA_RE.match(rec["seal"])
            and isinstance(rec["history"], list) and len(rec["history"]) <= 4 and _history_shape_ok(rec)
        )
    except Exception:  # noqa: BLE001 - a hostile stored value is "invalid", never an exception
        return False


def _read_one(directory: Path, rid: str) -> tuple[dict | None, str]:
    """``(record or None, integrity)``: ``ok`` | ``corrupt`` (structure fine, seal / history-hash mismatch) | ``invalid`` (preserved, never repaired).
    ``FileNotFoundError`` = absent; an unreadable file raises ``ReasoningStorageError``."""
    try:
        raw = canon.read_regular(directory / (rid + ".json"), FILE_BYTES_MAX)
    except FileNotFoundError:
        raise
    except canon.Noncanonical:
        return None, "invalid"
    except OSError as e:
        raise ReasoningStorageError("Enregistrement illisible") from e
    try:
        rec = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "invalid"
    if not _structure_ok(rec, rid):
        return None, "invalid"
    return rec, ("ok" if rec["seal"] == seal(rec) and _history_ok(rec) else "corrupt")


def _names(directory: Path) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise ReasoningStorageError("Registre inaccessible") from e
    return sorted(n[:-5] for n in names if n.endswith(".json") and ID_RE.match(n[:-5]))


def _write(directory: Path, rec: dict) -> None:
    rec["seal"] = seal(rec)
    raw = canon_bytes(rec)
    if len(raw) > FILE_BYTES_MAX:
        raise ReasoningConflict("Enregistrement trop volumineux", code="reasoning_limit")
    ann.publish(directory, rec["id"] + ".json", raw, "Enregistrement du registre")
    _forget(directory, rec["id"])


# ---------------------------------------------------------------- supersession claim marker (write-ahead; its FILENAME names the predecessor)
#
# claim durable -> successor B durable -> predecessor A updated -> claim removed. The marker is what keeps an old record from being resurrected when B
# later becomes UNREADABLE (an unparseable file carries no relation of its own): the marker's canonical filename alone says "A is in a supersession".
# It also reserves the request id and carries the successor's content so the SAME request can finish a crash that happened before B was written.

CLAIM_SCHEMA = "reasoning-claim-1"
CLAIM_KEYS = {"schema", "predecessor_id", "successor_id", "request_id", "kind", "project_id", "statement", "rationale", "pred_rev", "created_at", "seal"}
CLAIM_BYTES_MAX = 128 * 1024
CLAIM_STEM_RE = re.compile(r"^(?:dec|asm)-[0-9a-f]{24}\.claim\Z")


def _claim_file(pid: str) -> str:
    return pid + ".claim.json"


def _claim_ok(c: Any, pid: str) -> bool:
    hc = _hc()
    try:
        return bool(
            isinstance(c, dict) and set(c) == CLAIM_KEYS and c["schema"] == CLAIM_SCHEMA and c["predecessor_id"] == pid and ID_RE.match(pid)
            and isinstance(c["successor_id"], str) and ID_RE.match(c["successor_id"]) and c["successor_id"] != pid
            and kind_of_id(c["successor_id"]) == kind_of_id(pid) and c["kind"] == kind_of_id(pid)
            and isinstance(c["request_id"], str) and REQ_RE.match(c["request_id"])
            and isinstance(c["project_id"], str) and hc._ID_RE["proj"].match(c["project_id"])
            and isinstance(c["statement"], str) and c["statement"].strip() and len(c["statement"]) <= STATEMENT_MAX and not _CTRL.search(c["statement"])
            and isinstance(c["rationale"], str) and len(c["rationale"]) <= RATIONALE_MAX and not _CTRL.search(c["rationale"])
            and _is_int(c["pred_rev"]) and c["pred_rev"] >= 1 and _is_int(c["created_at"]) and isinstance(c["seal"], str) and _SHA_RE.match(c["seal"])
        )
    except Exception:  # noqa: BLE001 - a hostile stored value is "invalid", never an exception
        return False


def _read_claim(directory: Path, pid: str) -> tuple[dict | None, str]:
    """``(claim or None, integrity)``; ``FileNotFoundError`` = absent. Same three states as a record; the file is never repaired."""
    try:
        raw = canon.read_regular(directory / _claim_file(pid), CLAIM_BYTES_MAX)
    except FileNotFoundError:
        raise
    except canon.Noncanonical:
        return None, "invalid"
    except OSError as e:
        raise ReasoningStorageError("Marqueur de remplacement illisible") from e
    try:
        c = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None, "invalid"
    if not _claim_ok(c, pid):
        return None, "invalid"
    return c, ("ok" if c["seal"] == seal(c) else "corrupt")


def _mark_names(directory: Path) -> list[str]:
    try:
        names = os.listdir(directory)
    except FileNotFoundError:
        return []
    except OSError as e:
        raise ReasoningStorageError("Registre inaccessible") from e
    return sorted(n[: -len(".claim.json")] for n in names if n.endswith(".claim.json") and CLAIM_STEM_RE.match(n[:-5]))


def _marks(directory: Path) -> dict[str, dict]:
    """predecessor id -> ``{integrity, successor_id, request_id, kind, project_id, statement, rationale, pred_rev, created_at}`` for EVERY marker file
    (an unparseable one keeps only its predecessor id — which is the point)."""
    out: dict[str, dict] = {}
    for pid in _mark_names(directory):
        try:
            c, integ = _read_claim(directory, pid)
        except FileNotFoundError:
            continue
        row = {k: None for k in CLAIM_KEYS - {"seal"}}
        if c is not None:
            row.update({k: c[k] for k in row})
        row["integrity"] = integ
        row["predecessor_id"] = pid
        out[pid] = row
    return out


def _write_claim(directory: Path, claim: dict) -> None:
    claim["seal"] = seal(claim)
    ann.publish(directory, _claim_file(claim["predecessor_id"]), canon_bytes(claim), "Marqueur de remplacement")


def _drop_marker(directory: Path, pid: str) -> None:
    """Best effort: a stale marker next to a COMPLETED supersession is harmless (A is ``superseded``), so a failure here is never an error."""
    path = directory / _claim_file(pid)
    try:
        st = os.lstat(path)
        if _stat.S_ISREG(st.st_mode):
            os.unlink(path)
    except OSError:
        pass


# ---------------------------------------------------------------- header index (a CACHE: lstat-keyed, rebuilt from the files)

_idx: dict[tuple[str, str], tuple[tuple, dict]] = {}
_idx_lock = threading.Lock()
_IDX_MAX = TOTAL_MAX + 64


def _sig(st: os.stat_result) -> tuple:
    return (st.st_mtime_ns, st.st_ctime_ns, st.st_size, st.st_ino, st.st_dev)


def _forget(directory: Path, rid: str | None = None) -> None:
    with _idx_lock:
        if rid is None:
            for k in [k for k in _idx if k[0] == str(directory)]:
                _idx.pop(k, None)
        else:
            _idx.pop((str(directory), rid), None)


def drop_index() -> None:
    """Drop the whole cache (tests / operators). The next call rebuilds identical answers from the files."""
    with _idx_lock:
        _idx.clear()


def header(rec: dict, integ: str) -> dict:
    return {
        "id": rec["id"], "kind": rec["kind"], "rev": rec["rev"], "integrity": integ, "project_id": rec["project_id"], "request_id": rec["request_id"],
        "status": rec["status"], "statement": rec["statement"][:300], "evidence_count": len(rec["evidence"]), "verification_count": len(rec["verification_ids"]),
        "history_count": len(rec["history"]), "supersedes": rec["supersedes"], "superseded_by": rec["superseded_by"], "created_at": rec["created_at"],
        "updated_at": rec["updated_at"], "rel": sorted({relation_key(e["ref"]) for e in rec["evidence"]}),
        "verification_ids": [v["id"] for v in rec["verification_ids"]],
    }


def _blank_header(rid: str) -> dict:
    return {"id": rid, "kind": kind_of_id(rid), "rev": None, "integrity": "invalid", "project_id": None, "request_id": None, "status": None, "statement": "",
            "evidence_count": 0, "verification_count": 0, "history_count": 0, "supersedes": None, "superseded_by": None, "created_at": None, "updated_at": None,
            "rel": [], "verification_ids": []}


def _raw_headers(root: Path) -> list[dict]:
    """Every file's header, read-only. Cold: one bounded read per file; warm: ``lstat`` only. A corrupt / invalid file never poisons the others."""
    directory = _confined(root)
    out: list[dict] = []
    names = _names(directory)
    if len(names) > TOTAL_MAX + 50:
        raise ReasoningStorageError("Trop d'enregistrements")
    seen = set()
    with store_lock(root):
        for rid in names:
            key = (str(directory), rid)
            seen.add(key)
            try:
                st = os.lstat(directory / (rid + ".json"))
            except FileNotFoundError:
                continue
            except OSError as e:
                raise ReasoningStorageError("Registre inaccessible") from e
            sig = _sig(st)
            with _idx_lock:
                hit = _idx.get(key)
            if hit and hit[0] == sig and _stat.S_ISREG(st.st_mode):
                out.append(hit[1])
                continue
            try:
                rec, integ = _read_one(directory, rid)
            except FileNotFoundError:
                continue
            h = _blank_header(rid) if rec is None else header(rec, integ)
            with _idx_lock:
                if len(_idx) >= _IDX_MAX:
                    _idx.clear()
                _idx[key] = (sig, h)
            out.append(h)
    with _idx_lock:
        for k in [k for k in _idx if k[0] == str(directory) and k not in seen]:
            _idx.pop(k, None)
    return out


class _ClaimMap(dict):
    """predecessor id -> claimant headers, plus ``marks`` (predecessor id -> marker row) and ``by_id`` (every header)."""

    marks: dict[str, dict]
    by_id: dict[str, dict]


def _claims(rows: list[dict], marks: dict[str, dict] | None = None) -> _ClaimMap:
    """predecessor id -> the headers that CLAIM to supersede it (a corrupt file whose structure still parses is counted). An unparseable successor carries
    no relation of its own: the write-ahead MARKER (``marks``) is what still attributes it to its predecessor."""
    out = _ClaimMap()
    out.marks = marks or {}
    out.by_id = {h["id"]: h for h in rows}
    for h in rows:
        if h["supersedes"] is not None and h["integrity"] in ("ok", "corrupt"):
            out.setdefault(h["supersedes"], []).append(h)
    return out


def _effective(h: dict, claims: dict[str, list[dict]]) -> tuple[str | None, str | None]:
    """``(effective_status, successor_state)``. A record whose stored status is not yet ``superseded`` but which a durable marker or a successor claims
    is ``supersession_pending`` (healable by replaying the same request) or ``supersession_indeterminate`` (a corrupt / unreadable / foreign successor,
    a corrupt marker, several claimants) — NEVER active again."""
    if h["integrity"] != "ok":
        return None, None
    cl = claims.get(h["id"], [])
    succ_state = None
    if h["status"] == "superseded":
        mine = next((c for c in cl if c["id"] == h["superseded_by"]), None)
        succ_state = "missing" if mine is None else mine["integrity"]
        return "superseded", succ_state  # a stale marker next to a completed supersession is ignored
    mk = getattr(claims, "marks", {}).get(h["id"])
    if mk is not None:
        if mk["integrity"] != "ok" or len(cl) > 1:
            return "supersession_indeterminate", "corrupt"
        b = getattr(claims, "by_id", {}).get(mk["successor_id"])
        if b is None:  # the marker is durable, B is not (yet): the same request can still finish it
            return ("supersession_indeterminate", "corrupt") if cl else ("supersession_pending", "missing")
        if b["integrity"] != "ok" or b["supersedes"] != h["id"] or (cl and cl[0]["id"] != b["id"]):
            return "supersession_indeterminate", "corrupt"
        return "supersession_pending", "ok"
    if not cl:
        return h["status"], None
    if len(cl) > 1 or any(c["integrity"] != "ok" for c in cl):
        return "supersession_indeterminate", "corrupt"
    return "supersession_pending", "ok"


def _scan(root: Path) -> tuple[list[dict], dict[str, list[dict]]]:
    rows = _raw_headers(root)
    with store_lock(root):
        marks = _marks(_confined(root))
    return rows, _claims(rows, marks)


def _public_header(h: dict, claims: dict[str, list[dict]]) -> dict:
    eff, succ = _effective(h, claims)
    out = {k: v for k, v in h.items() if k not in ("rel", "request_id", "verification_ids")}
    out["effective_status"] = eff
    out["successor_state"] = succ
    return out


# ---------------------------------------------------------------- verification links (a summary, never evidence)


def _ver_rows(ids: list[str]) -> list[dict]:
    try:
        found = ver.headers_for(ids)
    except (ver.VerificationError, ver.VerificationStorageError):
        found = None
    rows = []
    for i in ids:
        h = None if found is None else found.get(i)
        if found is None:
            rows.append({"id": i, "state": "unknown", "status": None, "question": ""})
        elif h is None:
            rows.append({"id": i, "state": "missing", "status": None, "question": ""})
        elif h["integrity"] != "ok":
            rows.append({"id": i, "state": h["integrity"], "status": None, "question": ""})
        else:
            rows.append({"id": i, "state": "ok", "status": h["status"], "question": h["question"]})
    return rows


def ver_summary(rows: list[dict]) -> dict:
    """``{count, verified, unavailable, by_status}``: only a display summary — it never changes a status."""
    by = {s: sum(1 for r in rows if r["state"] == "ok" and r["status"] == s) for s in ver.STATUSES}
    return {"count": len(rows), "verified": by["verified"], "unavailable": sum(1 for r in rows if r["state"] != "ok"), "by_status": by}


# ---------------------------------------------------------------- freshness (read-only, on demand, never persisted)


def _compare(kind: str, cap: dict | None, obs: dict) -> str:
    """Current observation vs the entry captured at the LAST transition. ``not_captured`` = that entry could not be observed back then."""
    st = obs["state"]
    if st in ("unknown", "corrupt"):
        return st
    if st == "missing":
        if kind == "citation":
            return "changed_or_removed" if obs["reason"] == "citation_changed_or_removed" else "unavailable"
        return "missing"
    if cap is None:
        return "added_since"
    if cap["state"] not in ("ok", "archived"):
        return "not_captured"
    if obs["seal"] == cap["seal"]:
        return "unchanged"
    return "integrity_anomaly" if kind == "drawing" else "changed"


def resolve(rec: dict, integ: str = "ok", world: "ev.World | None | bool" = False) -> dict:
    """READ-ONLY, batched: the CURRENT state of every evidence ref (one World, per-entry failure isolation) plus the linked verifications' summary.
    While the record is active only existence is reported; afterwards every entry is compared with the capture of the LAST transition."""
    if world is False:
        try:
            world = ev.World()
        except Exception:  # noqa: BLE001
            world = None
    last = rec["history"][-1] if rec["history"] else None
    cap = {c["evidence_id"]: c for c in last["evidence"]} if last else {}
    rows = []
    for e in rec["evidence"]:
        obs = ver.observe_ref(e["ref"], world) if world is not None else ver._ob("unknown", None, "notebook_unavailable")
        rows.append({"evidence_id": e["id"], "kind": e["ref"]["kind"], "ref": e["ref"], "exists": obs["state"], "reason": obs["reason"],
                     "freshness": _compare(e["ref"]["kind"], cap.get(e["id"]), obs) if last else None})
    overall = None
    if last is not None:
        states = [r["freshness"] for r in rows]
        overall = "unchanged" if not states else ver._worst([("changed" if s == "not_captured" else s) for s in states])
    vrows = _ver_rows([v["id"] for v in rec["verification_ids"]])
    return {"evidence": rows, "overall": overall, "has_capture": last is not None, "captured_event": last["event"] if last else None,
            "captured_at": last["at"] if last else None, "verifications": vrows, "verification_summary": ver_summary(vrows), "integrity": integ}


# ---------------------------------------------------------------- public shapes


def _public(rec: dict, integ: str, root: Path) -> dict:
    out = {k: v for k, v in rec.items() if k != "seal"}
    rows, claims = _scan(root)
    mine = next((h for h in rows if h["id"] == rec["id"]), None)
    eff, succ = _effective(mine, claims) if mine is not None else (rec["status"], None)
    out["integrity"] = integ
    out["effective_status"] = eff if integ == "ok" else None
    out["successor_state"] = succ
    out["claimed_by"] = [c["id"] for c in claims.get(rec["id"], [])]
    return out


def _get_locked(directory: Path, rid: str) -> tuple[dict, str]:
    try:
        rec, integ = _read_one(directory, rid)
    except FileNotFoundError as e:
        raise ReasoningNotFound("Enregistrement introuvable") from e
    if rec is None:
        raise ReasoningConflict("Enregistrement invalide — conservé tel quel", code="reasoning_corrupt")
    return rec, integ


def _need_ok(integ: str) -> None:
    if integ != "ok":
        raise ReasoningConflict("Enregistrement altéré — lecture seule, conservé tel quel", code="reasoning_corrupt")


def _req_id(data: dict, key: str = "id") -> str:
    v = data.get(key)
    if not isinstance(v, str) or not ID_RE.match(v):
        raise ReasoningError("Enregistrement invalide")
    return v


def _req_rev(data: dict) -> int:
    v = data.get("expected_rev")
    if not _is_int(v) or v < 1:
        raise ReasoningError("expected_rev invalide")
    return v


def _req_request(data: dict) -> str:
    v = data.get("request_id")
    if not isinstance(v, str) or not REQ_RE.match(v):
        raise ReasoningError("Identifiant de requête invalide")
    return v


def _only(data: dict, allowed: set[str]) -> None:
    _hc()._only_keys(data, allowed)


def _project_id(v: Any) -> str:
    if not isinstance(v, str) or not _hc()._ID_RE["proj"].match(v):
        raise ReasoningError("Projet invalide")
    return v


def _stale(rec: dict) -> ReasoningConflict:
    return ReasoningConflict("Cet enregistrement a changé — rechargez avant de continuer", code="reasoning_conflict", current_rev=rec["rev"])


def _supersession_block(root: Path, rec: dict) -> None:
    """Pending / indeterminate records are read-only for EVERYTHING: a corrupt successor must never make an old record editable again."""
    rows, claims = _scan(root)
    mine = next((h for h in rows if h["id"] == rec["id"]), None)
    if mine is None:
        return
    eff, _succ = _effective(mine, claims)
    if eff == "supersession_indeterminate":
        raise ReasoningConflict(SUPERSESSION_INDETERMINATE, code="reasoning_supersession_indeterminate", kind=rec["kind"])
    if eff == "supersession_pending":
        raise ReasoningConflict("Supersession en cours — rejouez la même requête pour la terminer", code="reasoning_supersession_pending",
                                successor_id=(claims[rec["id"]][0]["id"] if claims.get(rec["id"]) else claims.marks[rec["id"]]["successor_id"]))


# ---------------------------------------------------------------- reads


def _filters(data: dict) -> tuple[str | None, str | None, str | None]:
    kind, status, pid = data.get("kind"), data.get("status"), data.get("project_id")
    if kind is not None and kind not in KINDS:
        raise ReasoningError("Type invalide")
    if status is not None and status not in ALL_STATUSES + EFFECTIVE_EXTRA:
        raise ReasoningError("Statut invalide")
    if pid is not None:
        _project_id(pid)
    return kind, status, pid


def list_records(data: Any) -> dict:
    """READ-ONLY. ``{action, project_id?, kind?, status?}`` -> at most ``LIST_MAX`` headers (corrupt / invalid ones are listed read-only)."""
    if not isinstance(data, dict):
        raise ReasoningError("Requête invalide")
    _only(data, {"action", "project_id", "kind", "status"})
    kind, status, pid = _filters(data)
    rows, claims = _scan(_root())
    shaped = [(h, _effective(h, claims)[0]) for h in rows]
    bad = [h for h, _e in shaped if h["integrity"] != "ok"]
    good = [(h, e) for h, e in shaped if h["integrity"] == "ok" and (kind is None or h["kind"] == kind) and (pid is None or h["project_id"] == pid)
            and (status is None or e == status)]
    good.sort(key=lambda x: (-x[0]["updated_at"], x[0]["id"]))
    unfiltered = kind is None and status is None and pid is None
    ordered = [_public_header(h, claims) for h, _e in good] + ([_public_header(h, claims) for h in bad] if unfiltered else [])
    counts: dict[str, dict[str, int]] = {k: {} for k in KINDS}
    for h, e in shaped:
        if h["integrity"] == "ok" and (pid is None or h["project_id"] == pid):
            counts[h["kind"]][e] = counts[h["kind"]].get(e, 0) + 1
    return {"ok": True, "read_only": True, "records": ordered[:LIST_MAX], "truncated": len(ordered) > LIST_MAX, "counts": counts, "unavailable": len(bad),
            "total": len(rows), "limits": limits(), "disclosure": DISCLOSURE}


def get(data: Any) -> dict:
    """READ-ONLY. One record in full (corrupt ones too: read-only)."""
    if not isinstance(data, dict):
        raise ReasoningError("Requête invalide")
    _only(data, {"action", "id"})
    rid = _req_id(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, rid)
    return {"ok": True, "read_only": True, "record": _public(rec, integ, root), "limits": limits(), "disclosure": DISCLOSURE}


def resolve_one(data: Any) -> dict:
    """READ-ONLY. The current state of the evidence of one record (``id``) or of up to ``RESOLVE_IDS_MAX`` of them (``ids``, one shared observation
    world, per-record failure isolation)."""
    if not isinstance(data, dict):
        raise ReasoningError("Requête invalide")
    _only(data, {"action", "id", "ids"})
    root = _root()
    directory = _confined(root)
    if "ids" in data:
        ids = data["ids"]
        if "id" in data or not isinstance(ids, list) or not (1 <= len(ids) <= RESOLVE_IDS_MAX) or any(not isinstance(i, str) or not ID_RE.match(i) for i in ids):
            raise ReasoningError("Requête invalide")
        try:
            world: Any = ev.World()
        except Exception:  # noqa: BLE001
            world = None
        results = []
        for rid in dict.fromkeys(ids):
            try:
                with store_lock(root):
                    rec, integ = _get_locked(directory, rid)
                results.append({"id": rid, "resolved": resolve(rec, integ, world)})
            except ReasoningNotFound:
                results.append({"id": rid, "error": "not_found"})
            except (ReasoningError, ReasoningStorageError) as e:
                results.append({"id": rid, "error": e.payload.get("code", "error")})
        return {"ok": True, "read_only": True, "results": results}
    rid = _req_id(data)
    with store_lock(root):
        rec, integ = _get_locked(directory, rid)
    return {"ok": True, "read_only": True, "id": rid, "resolved": resolve(rec, integ)}


def related(data: Any) -> dict:
    """READ-ONLY. ``{action, targets:[ref...]}`` (1..``TARGETS_PER_RELATED_MAX``) -> per ref the records whose EVIDENCE it is, from the header index
    only (evidence is never resolved here; the linked-verification summary comes from one read of the verification headers). Untrusted files are
    counted, never related."""
    if not isinstance(data, dict) or set(data) != {"action", "targets"} or not isinstance(data["targets"], list) or not (1 <= len(data["targets"]) <= TARGETS_PER_RELATED_MAX):
        raise ReasoningError("Requête invalide")
    refs: list[dict] = []
    for raw in data["targets"]:
        r = parse_ref(raw, "lookup")
        if r not in refs:
            refs.append(r)
    rows, claims = _scan(_root())
    untrusted = sum(1 for h in rows if h["integrity"] != "ok")
    good = [h for h in rows if h["integrity"] == "ok"]
    out, left, truncated = [], LIST_MAX, False
    all_ids = sorted({v for h in good for v in h["verification_ids"]})
    vfound = None
    for r in refs:
        key = relation_key(r)
        hits = []
        for h in sorted((h for h in good if key in h["rel"]), key=lambda h: (-h["updated_at"], h["id"])):
            if left <= 0:
                truncated = True
                continue
            if vfound is None:
                vfound = {x["id"]: x for x in _ver_rows(all_ids)}
            sm = ver_summary([vfound[v] for v in h["verification_ids"] if v in vfound])
            hits.append({**_public_header(h, claims), "verification_summary": sm})
            left -= 1
        counts: dict[str, dict[str, int]] = {k: {} for k in KINDS}
        for h in hits:
            counts[h["kind"]][h["effective_status"]] = counts[h["kind"]].get(h["effective_status"], 0) + 1
        out.append({"target": r, "records": hits, "counts": counts})
    return {"ok": True, "read_only": True, "results": out, "truncated": truncated, "unavailable": untrusted, "limits": limits()}


# ---------------------------------------------------------------- create


def _projects(world: "ev.World") -> set[str]:
    return {p["id"] for p in world.state["projects"]}


def _new_id(directory: Path, kind: str) -> str:
    rid = PREFIX[kind] + "-" + secrets.token_hex(12)
    while os.path.lexists(directory / (rid + ".json")):
        rid = PREFIX[kind] + "-" + secrets.token_hex(12)
    return rid


def _check_room(rows: list[dict], project_id: str) -> None:
    if len(rows) >= TOTAL_MAX:
        raise ReasoningConflict(f"Limite atteinte : {TOTAL_MAX} enregistrements", code="reasoning_limit")
    if sum(1 for h in rows if h["project_id"] == project_id) >= PROJECT_MAX:
        raise ReasoningConflict(f"Limite atteinte : {PROJECT_MAX} enregistrements par projet", code="reasoning_limit")


def _evidence_entries(refs: list[dict]) -> list[dict]:
    now = _now()
    return [{"id": "re-" + secrets.token_hex(8), "ref": r, "added_at": now} for r in refs]


def _create(data: dict) -> dict:
    _only(data, {"action", "request_id", "kind", "project_id", "statement", "rationale", "evidence"})
    request_id = _req_request(data)
    kind = data.get("kind")
    if kind not in KINDS:
        raise ReasoningError("Type invalide")
    project_id = _project_id(data.get("project_id"))
    statement = _statement(data.get("statement"))
    rationale = _rationale(data.get("rationale", ""))
    raw_ev = data.get("evidence", [])
    if not isinstance(raw_ev, list) or len(raw_ev) > CREATE_EVIDENCE_MAX:
        raise ReasoningError("Preuves invalides")
    parsed: list[dict] = []
    for raw in raw_ev:
        r = parse_ref(raw, "create")
        if any(_ident_key(r) == _ident_key(x) for x in parsed):
            raise ReasoningError("Preuve en double")
        parsed.append(r)
    root = _root()
    directory = _confined(root)
    want = sorted(_ident_key(r) for r in parsed)

    def replay() -> dict | None:
        for h in _raw_headers(root):
            if h["request_id"] != request_id:
                continue
            if h["integrity"] == "corrupt":  # a structurally readable but seal-corrupt owner still RESERVES its request id: never a second object
                raise ReasoningConflict("Une requête de ce numéro existe déjà dans un enregistrement altéré — réutilisation refusée, rien n'est créé ni réparé", code="reasoning_request_corrupt")
            if h["integrity"] != "ok":
                continue
            rec, integ = _get_locked(directory, h["id"])
            if (rec["kind"] != kind or rec["project_id"] != project_id or rec["statement"] != statement or rec["rationale"] != rationale
                    or rec["supersedes"] is not None or sorted(_ident_key(e["ref"]) for e in rec["evidence"]) != want):
                raise ReasoningConflict("Cette requête existe déjà avec un autre contenu", code=_conflict_code(rec["kind"]))
            return {"ok": True, "replayed": True, "record": _public(rec, integ, root)}
        for mk in _marks(directory).values():  # an in-flight supersession owns its request id too (cross-action single use)
            if mk["request_id"] == request_id:
                raise ReasoningConflict("Cette requête existe déjà avec un autre contenu", code=(_conflict_code(mk["kind"]) if mk["integrity"] == "ok" else "reasoning_request_corrupt"))
        return None

    with store_lock(root):
        got = replay()
    if got is not None:
        return got
    world = ev.World()
    if project_id not in _projects(world):
        raise ReasoningNotFound("Projet introuvable")
    refs = [_complete(r, world) for r in parsed]
    for r in refs:
        _check_project(r, project_id, world)
    directory = _confined(root, create=True)
    with store_lock(root):
        got = replay()
        if got is not None:
            return got
        _check_room(_raw_headers(root), project_id)
        now = _now()
        rec = {"schema": SCHEMA, "id": _new_id(directory, kind), "rev": 1, "kind": kind, "project_id": project_id, "request_id": request_id,
               "statement": statement, "rationale": rationale, "status": "active", "evidence": _evidence_entries(refs), "verification_ids": [],
               "supersedes": None, "superseded_by": None, "history": [], "created_at": now, "updated_at": now, "seal": "0" * 64}
        _write(directory, rec)
    return {"ok": True, "replayed": False, "record": _public(rec, "ok", root)}


# ---------------------------------------------------------------- locked edits (active records only)


def _locked_edit(data: dict, fn) -> dict:
    rid = _req_id(data)
    expected = _req_rev(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, rid)
        _need_ok(integ)
        if rec["rev"] != expected:
            raise _stale(rec)
        _supersession_block(root, rec)
        if rec["status"] != "active":
            raise ReasoningConflict("Un enregistrement historique est en lecture seule", code="reasoning_state_invalid", status_now=rec["status"])
        fn(rec)
        rec["rev"] += 1
        rec["updated_at"] = _now()
        _write(directory, rec)
    return {"ok": True, "record": _public(rec, "ok", root)}


def _update(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "statement", "rationale"})
    if "statement" not in data and "rationale" not in data:
        raise ReasoningError("Aucune modification")
    statement = _statement(data["statement"]) if "statement" in data else None
    rationale = _rationale(data["rationale"]) if "rationale" in data else None

    def apply(rec: dict) -> None:
        if statement is not None:
            rec["statement"] = statement
        if rationale is not None:
            rec["rationale"] = rationale  # commentary: never evidence, never part of any freshness

    return _locked_edit(data, apply)


def _evidence_add(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "ref"})
    ref = parse_ref(data.get("ref"), "create")
    world = ev.World()
    ref = _complete(ref, world)
    rid = _req_id(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec0, integ0 = _get_locked(directory, rid)
    _need_ok(integ0)
    _check_project(ref, rec0["project_id"], world)

    def apply(rec: dict) -> None:
        if any(_ident_key(e["ref"]) == _ident_key(ref) for e in rec["evidence"]):
            raise ReasoningConflict("Cette preuve est déjà liée", code="reasoning_duplicate_evidence")
        if len(rec["evidence"]) >= EVIDENCE_MAX:
            raise ReasoningConflict(f"Limite atteinte : {EVIDENCE_MAX} preuves", code="reasoning_limit")
        rec["evidence"].extend(_evidence_entries([ref]))

    return _locked_edit(data, apply)


def _evidence_remove(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "evidence_id"})
    evid = data.get("evidence_id")
    if not isinstance(evid, str) or not EVID_RE.match(evid):
        raise ReasoningError("Preuve invalide")

    def apply(rec: dict) -> None:
        keep = [e for e in rec["evidence"] if e["id"] != evid]
        if len(keep) == len(rec["evidence"]):
            raise ReasoningNotFound("Preuve introuvable")
        rec["evidence"] = keep

    return _locked_edit(data, apply)


def _verification_link(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "verification_id"})
    vid = data.get("verification_id")
    if not isinstance(vid, str) or not ver.ID_RE.match(vid):
        raise ReasoningError("Vérification invalide")
    rid = _req_id(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec0, integ0 = _get_locked(directory, rid)
    _need_ok(integ0)
    try:
        h = ver.headers_for([vid]).get(vid)
    except (ver.VerificationError, ver.VerificationStorageError) as e:
        raise ReasoningStorageError("Vérifications inaccessibles") from e
    if h is None:
        raise ReasoningNotFound("Vérification introuvable", code="reasoning_verification_missing")
    if h["integrity"] != "ok":
        raise ReasoningConflict("Vérification altérée — liaison impossible", code="reasoning_verification_corrupt")
    if h["project_id"] != rec0["project_id"]:
        raise ReasoningError("Cette vérification appartient à un autre projet", code="reasoning_project_mismatch")

    def apply(rec: dict) -> None:
        if any(v["id"] == vid for v in rec["verification_ids"]):
            raise ReasoningConflict("Cette vérification est déjà liée", code="reasoning_duplicate_verification")
        if len(rec["verification_ids"]) >= VERIFICATIONS_MAX:
            raise ReasoningConflict(f"Limite atteinte : {VERIFICATIONS_MAX} vérifications liées", code="reasoning_limit")
        rec["verification_ids"].append({"id": vid, "added_at": _now()})

    return _locked_edit(data, apply)


def _verification_unlink(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "verification_id"})
    vid = data.get("verification_id")
    if not isinstance(vid, str) or not ver.ID_RE.match(vid):
        raise ReasoningError("Vérification invalide")

    def apply(rec: dict) -> None:
        keep = [v for v in rec["verification_ids"] if v["id"] != vid]
        if len(keep) == len(rec["verification_ids"]):
            raise ReasoningNotFound("Liaison introuvable")
        rec["verification_ids"] = keep

    return _locked_edit(data, apply)


# ---------------------------------------------------------------- transition capture


def _capture(rec: dict) -> dict[str, dict]:
    """ONE observation round of every evidence ref from a FRESH World. Never raises: an uninspectable entry is that entry's own ``unknown``."""
    try:
        world: Any = ev.World()
    except Exception:  # noqa: BLE001
        world = None
    out = {}
    for e in rec["evidence"]:
        out[e["id"]] = ver.observe_ref(e["ref"], world) if world is not None else ver._ob("unknown", None, "notebook_unavailable")
    return out


def _cap_entries(rec: dict, obs: dict[str, dict]) -> list[dict]:
    return sorted(({"evidence_id": e["id"], "kind": e["ref"]["kind"], "identity": e["ref"], "state": obs[e["id"]]["state"], "seal": obs[e["id"]]["seal"]}
                   for e in rec["evidence"]), key=lambda c: canon_bytes(c["identity"]))


def _append_event(rec: dict, event: str, entries: list[dict], successor_id: str | None) -> None:
    """Apply a terminal transition to ``rec`` (call under the lock): status, history event with its own deterministic hash, rev bump."""
    e = {"id": "rh-" + secrets.token_hex(8), "event": event, "at": _now(), "rev_before": rec["rev"], "successor_id": successor_id, "evidence": entries,
         "content_sha256": "0" * 64}
    e["content_sha256"] = _event_hash(rec, e)
    rec["history"].append(e)
    rec["status"] = event
    if event == "superseded":
        rec["superseded_by"] = successor_id
    rec["rev"] += 1
    rec["updated_at"] = e["at"]


def _unconfirmable(rec: dict, obs: dict[str, dict]) -> list[dict]:
    return [{"evidence_id": eid, "state": o["state"], "reason": o["reason"]} for eid, o in obs.items() if o["state"] in UNCONFIRMABLE]


def _status(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "status"})
    rid = _req_id(data)
    expected = _req_rev(data)
    target = data.get("status")
    kind = kind_of_id(rid)
    if target == "superseded":
        raise ReasoningError("« Remplacé » n'est atteint que par l'opération de remplacement", code="reasoning_supersede_required")
    if target not in STATUSES[kind] or target == "active":
        raise ReasoningError("Statut invalide")
    root = _root()
    directory = _confined(root)

    def preflight(rec: dict, integ: str) -> None:
        _need_ok(integ)
        if rec["rev"] != expected:
            raise _stale(rec)
        _supersession_block(root, rec)
        if (rec["status"], target) not in TRANSITIONS[kind]:
            raise ReasoningConflict("Transition de statut non autorisée", code="reasoning_state_invalid", status_now=rec["status"])
        if target == "confirmed" and not rec["evidence"]:
            raise ReasoningConflict("Au moins une preuve est requise avant de confirmer", code="reasoning_no_evidence")

    with store_lock(root):
        rec, integ = _get_locked(directory, rid)
        preflight(rec, integ)
    # observations run OUTSIDE the lock (other stores' locks are taken inside them); the commit re-checks everything
    obs_b = _capture(rec)
    if target == "confirmed":
        obs_a = _capture(rec)  # confirm = two consistent observations A == B, fail closed; every other transition = one best-effort observation
        if _cap_cmp(obs_a) != _cap_cmp(obs_b):
            raise ReasoningConflict("Les preuves ont changé pendant la confirmation — rien n'est enregistré", code="reasoning_capture_race")
        bad = _unconfirmable(rec, obs_b) or _unconfirmable(rec, obs_a)
        if bad:
            raise ReasoningConflict(UNAVAILABLE_MESSAGE, code="reasoning_evidence_unavailable", entries=bad)
    with store_lock(root):
        rec2, integ2 = _get_locked(directory, rid)
        preflight(rec2, integ2)
        if seal(rec2) != seal(rec):
            raise ReasoningConflict("L'enregistrement a changé pendant la transition — rien n'est enregistré", code="reasoning_capture_race")
        _append_event(rec2, target, _cap_entries(rec2, obs_b), None)
        _write(directory, rec2)
    return {"ok": True, "record": _public(rec2, "ok", root)}


def _cap_cmp(obs: dict[str, dict]) -> dict:
    return {k: (o["state"], o["seal"]) for k, o in obs.items()}


# ---------------------------------------------------------------- supersession


def _finish_supersession(root: Path, directory: Path, pred_id: str, succ_id: str) -> dict:
    """Second half: write the predecessor's reflection of ``B.supersedes = A``. Idempotent (a completed one is returned as is); the capture of A's
    evidence is best-effort (never a failure)."""
    with store_lock(root):
        a, integ = _get_locked(directory, pred_id)
        _need_ok(integ)
        if a["status"] == "superseded":
            if a["superseded_by"] != succ_id:
                raise ReasoningConflict("Cet enregistrement est déjà remplacé par un autre", code="reasoning_already_superseded")
            _drop_marker(directory, pred_id)
            return a
        if (a["status"], "superseded") not in TRANSITIONS[a["kind"]]:
            raise ReasoningConflict("Transition de statut non autorisée", code="reasoning_state_invalid", status_now=a["status"])
    obs = _capture(a)
    with store_lock(root):
        a2, integ2 = _get_locked(directory, pred_id)
        _need_ok(integ2)
        if a2["status"] == "superseded":
            _drop_marker(directory, pred_id)
            return a2
        if seal(a2) != seal(a):
            raise ReasoningConflict("L'enregistrement a changé pendant le remplacement — rejouez la même requête", code="reasoning_capture_race")
        _append_event(a2, "superseded", _cap_entries(a2, obs), succ_id)
        _write(directory, a2)
        _drop_marker(directory, pred_id)  # the supersession is complete: the write-ahead marker has done its job
        return a2


def _supersede(data: dict) -> dict:
    _only(data, {"action", "predecessor_id", "expected_rev", "request_id", "statement", "rationale"})
    pred_id = _req_id(data, "predecessor_id")
    expected = _req_rev(data)
    request_id = _req_request(data)
    statement = _statement(data.get("statement"))
    rationale = _rationale(data.get("rationale", ""))
    root = _root()
    directory = _confined(root)

    def replay() -> dict | None:
        for h in _raw_headers(root):
            if h["request_id"] != request_id:
                continue
            if h["integrity"] == "corrupt":  # a readable but seal-corrupt owner still RESERVES the request id (no second successor, no reuse elsewhere)
                raise ReasoningConflict("Une requête de ce numéro existe déjà dans un enregistrement altéré — réutilisation refusée, rien n'est créé ni réparé", code="reasoning_request_corrupt")
            if h["integrity"] != "ok":
                continue
            b, b_integ = _get_locked(directory, h["id"])
            if (b["supersedes"] != pred_id or b["statement"] != statement or b["rationale"] != rationale):
                raise ReasoningConflict("Cette requête existe déjà avec un autre contenu", code=_conflict_code(b["kind"]))
            return b
        return None

    def marker_replay() -> dict | None:
        """The same request, interrupted AFTER the write-ahead marker and BEFORE B: the marker carries everything needed to write B."""
        for mk in _marks(directory).values():
            if mk["request_id"] != request_id:
                continue
            if mk["integrity"] != "ok":
                raise ReasoningConflict("Une requête de ce numéro existe déjà dans un enregistrement altéré — réutilisation refusée, rien n'est créé ni réparé", code="reasoning_request_corrupt")
            if mk["predecessor_id"] != pred_id or mk["statement"] != statement or mk["rationale"] != rationale:
                raise ReasoningConflict("Cette requête existe déjà avec un autre contenu", code=_conflict_code(mk["kind"]))
            return mk
        return None

    def materialise(mk: dict) -> dict:
        path = directory / (mk["successor_id"] + ".json")
        if os.path.lexists(path):  # B exists but is not readable as a record: never overwritten, never repaired
            raise ReasoningConflict(SUPERSESSION_INDETERMINATE, code="reasoning_supersession_indeterminate", kind=mk["kind"])
        b = {"schema": SCHEMA, "id": mk["successor_id"], "rev": 1, "kind": mk["kind"], "project_id": mk["project_id"], "request_id": mk["request_id"],
             "statement": mk["statement"], "rationale": mk["rationale"], "status": "active", "evidence": [], "verification_ids": [], "supersedes": pred_id,
             "superseded_by": None, "history": [], "created_at": mk["created_at"], "updated_at": mk["created_at"], "seal": "0" * 64}
        _write(directory, b)
        return b

    with store_lock(root):
        b = replay()
        mk = None if b is not None else marker_replay()
        if b is None and mk is not None:
            b = materialise(mk)
    if b is not None:
        a = _finish_supersession(root, directory, pred_id, b["id"])  # replay of a lost / interrupted answer: heals a pending predecessor
        return {"ok": True, "replayed": True, "predecessor": _public(a, "ok", root), "successor": _public(b, "ok", root)}
    with store_lock(root):
        a, integ = _get_locked(directory, pred_id)
        _need_ok(integ)
    world = ev.World()
    if a["project_id"] not in _projects(world):
        raise ReasoningNotFound("Projet introuvable")
    directory = _confined(root, create=True)
    with store_lock(root):
        b = replay()
        if b is None:
            a, integ = _get_locked(directory, pred_id)
            _need_ok(integ)
            if a["rev"] != expected:
                raise _stale(a)
            rows, claims = _scan(root)
            if claims.get(a["id"]) or claims.marks.get(a["id"]):
                if a["status"] != "superseded":
                    _supersession_block(root, a)  # pending / indeterminate: another successor is refused with the precise reason
            if a["status"] == "superseded" or claims.get(a["id"]):
                raise ReasoningConflict("Cet enregistrement est déjà remplacé", code="reasoning_already_superseded")
            if (a["status"], "superseded") not in TRANSITIONS[a["kind"]]:
                raise ReasoningConflict("Un enregistrement historique ne peut pas être remplacé", code="reasoning_state_invalid", status_now=a["status"])
            _check_room(rows, a["project_id"])
            now = _now()
            sid = _new_id(directory, a["kind"])
            claim = {"schema": CLAIM_SCHEMA, "predecessor_id": a["id"], "successor_id": sid, "request_id": request_id, "kind": a["kind"],
                     "project_id": a["project_id"], "statement": statement, "rationale": rationale, "pred_rev": a["rev"], "created_at": now, "seal": "0" * 64}
            _write_claim(directory, claim)  # write-ahead: from here on A can never look safely active again, whatever happens to B
            b = {"schema": SCHEMA, "id": sid, "rev": 1, "kind": a["kind"], "project_id": a["project_id"], "request_id": request_id,
                 "statement": statement, "rationale": rationale, "status": "active", "evidence": [], "verification_ids": [], "supersedes": a["id"],
                 "superseded_by": None, "history": [], "created_at": now, "updated_at": now, "seal": "0" * 64}
            _write(directory, b)  # the canonical relation is durable before A is touched
    a = _finish_supersession(root, directory, pred_id, b["id"])
    return {"ok": True, "replayed": False, "predecessor": _public(a, "ok", root), "successor": _public(b, "ok", root)}


# ---------------------------------------------------------------- delete


def _delete(data: dict) -> dict:
    _only(data, {"action", "id", "expected_rev", "confirm"})
    if data.get("confirm") is not True:
        raise ReasoningError("Confirmation requise", code="reasoning_confirm_required")
    rid = _req_id(data)
    expected = _req_rev(data)
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, rid)
        _need_ok(integ)
        if rec["rev"] != expected:
            raise _stale(rec)
        rows, claims = _scan(root)
        if (rec["status"] != "active" or rec["history"] or rec["supersedes"] is not None or rec["superseded_by"] is not None or claims.get(rid) or claims.marks.get(rid)):
            raise ReasoningConflict("Cet enregistrement a un historique de transitions ou de remplacement — suppression refusée", code="reasoning_has_history")
        path = directory / (rid + ".json")
        try:
            st = os.lstat(path)
            if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode):
                raise ReasoningConflict("Enregistrement non canonique — suppression refusée", code="reasoning_corrupt")
            os.unlink(path)
        except FileNotFoundError as e:
            raise ReasoningNotFound("Enregistrement introuvable") from e
        except OSError as e:
            raise ReasoningStorageError("Suppression impossible") from e
        _forget(directory, rid)
    return {"ok": True, "deleted": rid}


# ---------------------------------------------------------------- dispatch


_MUTATIONS = {
    "reasoning_create": _create, "reasoning_supersede": _supersede, "reasoning_update": _update, "reasoning_evidence_add": _evidence_add,
    "reasoning_evidence_remove": _evidence_remove, "reasoning_verification_link": _verification_link, "reasoning_verification_unlink": _verification_unlink,
    "reasoning_status": _status, "reasoning_delete": _delete,
}
_READS = {"reasoning_list": list_records, "reasoning_get": get, "reasoning_resolve": resolve_one, "reasoning_related": related}
ACTIONS = tuple(_MUTATIONS) + tuple(_READS)


def mutate(data: Any) -> dict:
    if not isinstance(data, dict) or data.get("action") not in _MUTATIONS:
        raise ReasoningError("Action invalide")
    return _MUTATIONS[data["action"]](data)


def read(data: Any) -> dict:
    if not isinstance(data, dict) or data.get("action") not in _READS:
        raise ReasoningError("Action invalide")
    return _READS[data["action"]](data)


# ---------------------------------------------------------------- report / backup

STATUS_LABELS = {"active": "Actif", "confirmed": "Confirmée", "superseded": "Remplacé", "withdrawn": "Retiré", "invalidated": "Invalidée", "retired": "Retirée",
                 "supersession_pending": "Remplacement en cours", "supersession_indeterminate": "Remplacement indéterminé"}
ASSUMPTION_STATUS_LABELS = {"active": "Active", "confirmed": "Confirmée", "superseded": "Remplacée", "invalidated": "Invalidée", "retired": "Retirée",
                            "supersession_pending": "Remplacement en cours", "supersession_indeterminate": "Remplacement indéterminé"}
KIND_LABELS = {KIND_DECISION: "Décision", KIND_ASSUMPTION: "Hypothèse"}
REPORT_HEADING = "Registre des décisions et hypothèses"


def report_summary(rid: str) -> dict:
    """What a deterministic report states about ONE record: stored facts only (no evaluation, no freshness, no conclusion)."""
    root = _root()
    directory = _confined(root)
    with store_lock(root):
        rec, integ = _get_locked(directory, rid)
    _need_ok(integ)
    pub = _public(rec, integ, root)
    vrows = _ver_rows([v["id"] for v in rec["verification_ids"]])
    projects = {}
    try:
        projects = {p["id"]: p for p in ev.World().state["projects"]}
    except Exception:  # noqa: BLE001
        pass
    return {"id": rec["id"], "kind": rec["kind"], "statement": rec["statement"], "rationale": rec["rationale"], "status": pub["effective_status"],
            "project_id": rec["project_id"], "project_name": (projects.get(rec["project_id"]) or {}).get("name"), "evidence": [e["ref"] for e in rec["evidence"]],
            "verifications": [{"id": r["id"], "state": r["state"], "status": r["status"]} for r in vrows], "verification_summary": ver_summary(vrows),
            "supersedes": rec["supersedes"], "superseded_by": rec["superseded_by"]}


def render_markdown(s: dict) -> str:
    """Deterministic wording only: stored facts, no interpretation, no 'valid / approved / safe' claim."""
    labels = ASSUMPTION_STATUS_LABELS if s["kind"] == KIND_ASSUMPTION else STATUS_LABELS
    lines = [f"- Type : {KIND_LABELS[s['kind']]} (registre — ni preuve ni blocs Décision du journal)", f"- Énoncé : " + ev._md(s["statement"]),
             f"- Statut : {labels.get(s['status'] or '', 'indéterminé')}",
             "- Projet : " + ev._md(s["project_name"] or s["project_id"])]
    if s["rationale"]:
        lines.append("- Justification : " + ev._md(s["rationale"]))
    if s["supersedes"]:
        lines.append(f"- Remplace : {s['supersedes']}")
    if s["superseded_by"]:
        lines.append(f"- Remplacé par : {s['superseded_by']}")
    lines.append(f"- Preuves liées : {len(s['evidence'])}")
    lines += [f"  - {ver.KIND_LABELS[r['kind']]} · " + ev._md(ver._ident(r)) for r in s["evidence"]]
    sm = s["verification_summary"]
    lines.append(f"- Vérifications liées : {sm['count']} (dont {sm['verified']} au statut « Vérifiée »" + (f" ; {sm['unavailable']} indisponible(s)" if sm["unavailable"] else "") + ")")
    lines += [f"  - {r['id']}" for r in s["verifications"]]
    lines.append("- " + DISCLOSURE)
    return "\n".join(lines)


def closure(root: Path | str) -> dict:
    """The files a backup must carry byte-for-byte: ``{"files", "valid"}``. EVERY ``dec-*`` / ``asm-*`` file is carried; ``valid`` is False when any
    file does not verify. Nothing a record references is followed."""
    directory = ann.store_dir(root, REASONING_DIR)
    files: list[str] = []
    valid = True
    try:
        _confined(Path(root))
        with store_lock(root):
            for rid in _names(directory):
                try:
                    rec, integ = _read_one(directory, rid)
                except FileNotFoundError:
                    continue
                files.append(rid + ".json")
                if rec is None or integ != "ok":
                    valid = False
            for pid in _mark_names(directory):  # a write-ahead marker travels with the register (it is what keeps a pending predecessor from looking active)
                try:
                    _c, cinteg = _read_claim(directory, pid)
                except FileNotFoundError:
                    continue
                files.append(_claim_file(pid))
                if cinteg != "ok":
                    valid = False
    except (ReasoningError, ReasoningStorageError):
        valid = False
    return {"files": files, "valid": valid}


def copy_to(root: Path | str, dest: Path, names: list[str], refused: list | None = None) -> int:
    directory = _confined(Path(root))
    with store_lock(root):
        return canon.copy_canonical(directory, dest, names, lambda stem: bool(ID_RE.match(stem) or CLAIM_STEM_RE.match(stem)), FILE_BYTES_MAX, refused)
