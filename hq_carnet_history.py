"""Carnet Stage 08: bounded version history (own file, own revision, stdlib only).

Runtime state lives at ``<ROOT>/.hq-carnet/history.json``: a SEPARATE file, so that

- a history write never changes the notebook or sources revisions;
- a damaged history never blocks writing notes (only the history features fail closed, ``503 history_unavailable``);
- history has its own size budget and its own ``history_rev``.

Shape::

    {"version": 1, "history_rev": 1, "pruned_total": 0, "events": [ {event}, ... ]}   # oldest first

    event = {"id": "hev-<24 hex>", "at": <epoch>, "kind": "checkpoint|restore|bulk|undo|lifecycle",
             "status": "applied|pending|failed", "summary": "<=200 chars", "data": {...}}

What creates an event (and ONLY this; ordinary typing / autosave never does)::

    checkpoint  an explicit "point de restauration" of one page (full page content)
    restore     restoring a checkpoint onto the page (the pre-restore content is kept in the event)
    bulk        one successful (even partial) bulk operation: exactly what was applied/skipped/conflicted/failed,
                plus the BEFORE-state of every applied target (what Undo needs; never a periodic snapshot)
    undo        one bounded Undo of a bulk event
    lifecycle   a single-page trash / restore / permanent delete (metadata only, best effort)

Only notebook-domain data is stored (validated page content, ids, revisions, short counts/labels): no tokens, no
absolute paths, no session data. Bounds: ``EVENTS_MAX`` events, ``SNAPSHOTS_PER_PAGE_MAX`` content snapshots per page,
``HISTORY_BYTES_MAX`` serialized bytes, ``EVENT_BYTES_MAX`` per event. When a new event does not fit, the OLDEST
unprotected events are pruned (the ``UNDO_WINDOW`` newest bulk events that can still be undone are protected);
``pruned_total`` keeps the pruning visible. If it still does not fit, the operation that needed the event is REFUSED
(nothing is applied). Malformed bytes are never repaired or overwritten.

Concurrency: every write happens under ``hq_state.path_lock`` of the history file and replaces it atomically.
Lock order across Carnet files: notebook lock (outer) -> history lock (inner); sources lock -> history lock.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Any

import hq_carnet_rich as rich
import hq_state

DIR_NAME = ".hq-carnet"
FILE_NAME = "history.json"
VERSION = 1

EVENTS_MAX = 200
SNAPSHOTS_PER_PAGE_MAX = 20
HISTORY_BYTES_MAX = 4 * 1024 * 1024
EVENT_BYTES_MAX = 1024 * 1024
SNAPSHOT_BYTES_MAX = 256 * 1024
UNDO_WINDOW = 10
SUMMARY_MAX = 200
LABEL_MAX = 80
TARGETS_MAX = 64
REASON_MAX = 160

KINDS = ("checkpoint", "restore", "bulk", "undo", "lifecycle")
STATUSES = ("applied", "pending", "failed")
TARGET_STATUSES = ("applied", "skipped", "conflicted", "failed")
LIFECYCLE_ACTIONS = ("trash", "restore", "delete_permanent")

_EVENT_ID_RE = re.compile(r"^hev-[0-9a-f]{24}\Z")
_PAGE_ID_RE = re.compile(r"^page-[A-Za-z0-9_-]{1,64}\Z")
_EDITION_ID_RE = re.compile(r"^srce-[A-Za-z0-9_-]{1,64}\Z")
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_ESCAPED = "Emplacement de l'historique redirigé — refusé, fichier conservé"

_cb: dict[str, Any] = {}


class HistoryError(ValueError):
    """Invalid request (HTTP 400)."""

    status = 400
    code = "validation_error"


class HistoryNotFound(HistoryError):
    status = 404
    code = "not_found"


class HistoryStorageError(RuntimeError):
    """History unreadable / not writable / full. Maps to 503 ``history_unavailable``; bytes are preserved."""

    code = "history_unavailable"

    def __init__(self, message: str, status: int = 503):
        super().__init__(message)
        self.status = status


def bind(**kwargs: Any) -> None:
    _cb.update(kwargs)


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise HistoryStorageError("Carnet non initialisé")
    return Path(os.path.abspath(os.fspath(root)))


# ---------------------------------------------------------------- confined storage path


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    junction = getattr(os.path, "isjunction", None)
    return bool(junction and junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def history_path(root: Path | str | None = None) -> Path:
    base = Path(os.path.abspath(os.fspath(root if root is not None else _root())))
    return base / DIR_NAME / FILE_NAME


def confined_path(root: Path | str | None = None) -> Path:
    """``history_path`` after refusing any redirection (symlink/junction) of the folder, file or tmp sibling."""
    path = history_path(root)
    base = path.parent
    try:
        real_base = os.path.join(os.path.realpath(base.parent), DIR_NAME)
        if _is_link(base) or not _same(os.path.realpath(base), real_base):
            raise HistoryStorageError(_ESCAPED)
        for name in (FILE_NAME, FILE_NAME + ".tmp"):
            item = base / name
            if _is_link(item) or not _same(os.path.realpath(item), os.path.join(real_base, name)):
                raise HistoryStorageError(_ESCAPED)
    except OSError as e:
        raise HistoryStorageError("Historique inaccessible") from e
    return path


# ---------------------------------------------------------------- validation of STORED state


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and abs(value) != float("inf")


def _short(value: Any, limit: int) -> bool:
    return isinstance(value, str) and len(value) <= limit and not _CTRL_RE.search(value)


def _size(obj: Any) -> int:
    return len(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8", "surrogatepass"))


def _content_ok(content: Any) -> bool:
    return rich.valid_v2(content) or rich.valid_v1(content)


def _target_ok(t: Any) -> bool:
    if not isinstance(t, dict) or set(t) != {"kind", "id", "status", "reason", "rev_before", "rev_after", "before"}:
        return False
    if t["kind"] == "page":
        if not isinstance(t["id"], str) or not _PAGE_ID_RE.match(t["id"]):
            return False
    elif t["kind"] == "edition":
        if not isinstance(t["id"], str) or not _EDITION_ID_RE.match(t["id"]):
            return False
    else:
        return False
    if t["status"] not in TARGET_STATUSES or not _short(t["reason"], REASON_MAX):
        return False
    for key in ("rev_before", "rev_after"):
        if t[key] is not None and (not _is_int(t[key]) or t[key] < 1):
            return False
    if t["before"] is not None and not isinstance(t["before"], dict):
        return False
    if t["status"] == "applied" and (t["before"] is None or t["rev_before"] is None or t["rev_after"] is None):
        return False
    return True


def _counts_ok(counts: Any) -> bool:
    return isinstance(counts, dict) and set(counts) == set(TARGET_STATUSES) and all(_is_int(counts[k]) and counts[k] >= 0 for k in counts)


def _event_data_ok(kind: str, data: Any) -> bool:
    if not isinstance(data, dict):
        return False
    if kind == "checkpoint":
        return (
            set(data) == {"page_id", "page_rev", "title", "label", "content"}
            and isinstance(data["page_id"], str) and bool(_PAGE_ID_RE.match(data["page_id"]))
            and _is_int(data["page_rev"]) and data["page_rev"] >= 1
            and isinstance(data["title"], str) and len(data["title"]) <= 300
            and _short(data["label"], LABEL_MAX)
            and _content_ok(data["content"])
        )
    if kind == "restore":
        return (
            set(data) == {"page_id", "from_event", "rev_before", "rev_after", "pre_content"}
            and isinstance(data["page_id"], str) and bool(_PAGE_ID_RE.match(data["page_id"]))
            and isinstance(data["from_event"], str) and bool(_EVENT_ID_RE.match(data["from_event"]))
            and all(_is_int(data[k]) and data[k] >= 1 for k in ("rev_before", "rev_after"))
            and _content_ok(data["pre_content"])
        )
    if kind == "bulk":
        if set(data) != {"op", "params", "targets", "counts", "undone"}:
            return False
        if not isinstance(data["op"], str) or not isinstance(data["params"], dict):
            return False
        targets = data["targets"]
        if not isinstance(targets, list) or len(targets) > TARGETS_MAX or not all(_target_ok(t) for t in targets):
            return False
        if not _counts_ok(data["counts"]):
            return False
        undone = data["undone"]
        return undone is None or (isinstance(undone, dict) and set(undone) == {"at", "event_id", "counts"} and _is_num(undone["at"]) and _counts_ok(undone["counts"]))
    if kind == "undo":
        if set(data) != {"of", "targets", "counts"}:
            return False
        targets = data["targets"]
        return (
            isinstance(data["of"], str) and bool(_EVENT_ID_RE.match(data["of"]))
            and isinstance(targets, list) and len(targets) <= TARGETS_MAX
            and all(_target_ok(t) for t in targets) and _counts_ok(data["counts"])
        )
    if kind == "lifecycle":
        return (
            set(data) == {"page_id", "action", "rev_after"}
            and isinstance(data["page_id"], str) and bool(_PAGE_ID_RE.match(data["page_id"]))
            and data["action"] in LIFECYCLE_ACTIONS
            and (data["rev_after"] is None or (_is_int(data["rev_after"]) and data["rev_after"] >= 1))
        )
    return False


def _event_ok(event: Any) -> bool:
    if not isinstance(event, dict) or set(event) != {"id", "at", "kind", "status", "summary", "data"}:
        return False
    return (
        isinstance(event["id"], str) and bool(_EVENT_ID_RE.match(event["id"]))
        and _is_num(event["at"])
        and event["kind"] in KINDS
        and event["status"] in STATUSES
        and _short(event["summary"], SUMMARY_MAX)
        and _event_data_ok(event["kind"], event["data"])
    )


def _usable(data: Any) -> bool:
    if not isinstance(data, dict) or set(data) != {"version", "history_rev", "pruned_total", "events"} or data["version"] != VERSION:
        return False
    if not _is_int(data["history_rev"]) or data["history_rev"] < 1 or not _is_int(data["pruned_total"]) or data["pruned_total"] < 0:
        return False
    events = data["events"]
    if not isinstance(events, list):
        return False
    seen: set[str] = set()
    for event in events:
        if not _event_ok(event) or event["id"] in seen:
            return False
        seen.add(event["id"])
    return True


# ---------------------------------------------------------------- load / write


def _empty() -> dict:
    return {"version": VERSION, "history_rev": 1, "pruned_total": 0, "events": []}


def _read_state() -> tuple[dict | None, str | None]:
    """(state, problem). A missing file is ``(None, None)``. Never writes, never repairs."""
    path = confined_path()
    try:
        exists, is_file = os.path.lexists(path), path.is_file()
    except OSError:
        return None, "history.json inaccessible — fichier conservé"
    if not is_file:
        return None, ("history.json n'est pas un fichier — conservé" if exists else None)
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None, "history.json illisible — fichier conservé"
    if isinstance(raw, dict) and raw.get("version") != VERSION:
        return None, "history.json version non prise en charge — fichier conservé"
    if not _usable(raw):
        return None, "history.json illisible — fichier conservé"
    return raw, None


def _load_locked() -> dict:
    state, problem = _read_state()
    if problem:
        raise HistoryStorageError(problem)
    return state if state is not None else _empty()


def _write(state: dict) -> None:
    path = confined_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(path, state)
    except RuntimeError as e:
        raise HistoryStorageError(str(e)) from e
    except OSError as e:
        raise HistoryStorageError("Écriture de l'historique impossible — dernière version conservée") from e


def lock():
    return hq_state.path_lock(confined_path())


def available() -> bool:
    """True when the history can be read (missing file counts as available). Never raises."""
    try:
        with lock():
            _load_locked()
        return True
    except (HistoryStorageError, OSError):
        return False


# ---------------------------------------------------------------- pruning


def _protected_ids(events: list[dict]) -> set[str]:
    """The newest ``UNDO_WINDOW`` bulk events that are still undoable are never pruned."""
    out: list[str] = []
    for event in reversed(events):
        if event["kind"] == "bulk" and event["status"] == "applied" and event["data"]["undone"] is None:
            out.append(event["id"])
            if len(out) >= UNDO_WINDOW:
                break
    return set(out)


def _snapshot_page(event: dict) -> str | None:
    if event["kind"] in ("checkpoint", "restore"):
        return event["data"]["page_id"]
    return None


def _prune(state: dict, incoming: dict) -> int:
    """Drop the oldest unprotected events until ``state`` + ``incoming`` fits every bound. Returns the count.

    ``incoming`` is already in ``state["events"]`` (last). Raises HistoryStorageError when it still cannot fit.
    """
    dropped = 0
    events = state["events"]

    def drop(index: int) -> None:
        nonlocal dropped
        del events[index]
        dropped += 1

    # per-page snapshot bound: drop that page's oldest snapshots first
    page = _snapshot_page(incoming)
    if page is not None:
        while sum(1 for e in events if _snapshot_page(e) == page) > SNAPSHOTS_PER_PAGE_MAX:
            idx = next(i for i, e in enumerate(events) if _snapshot_page(e) == page and e is not incoming)
            drop(idx)
    while len(events) > EVENTS_MAX or _size(state) > HISTORY_BYTES_MAX:
        protected = _protected_ids(events)
        idx = next((i for i, e in enumerate(events) if e is not incoming and e["id"] not in protected), None)
        if idx is None:
            raise HistoryStorageError("Historique plein — l'opération est refusée (rien n'a été modifié)", 409)
        drop(idx)
    state["pruned_total"] += dropped
    return dropped


# ---------------------------------------------------------------- events


def new_event_id() -> str:
    return "hev-" + secrets.token_hex(12)


def append(kind: str, status: str, summary: str, data: dict, *, now: float | None = None) -> str:
    """Append one event (caller may hold the notebook / sources lock: lock order is documented above).

    Returns the event id. Raises HistoryStorageError (nothing written) when the history is unreadable, the event is
    over ``EVENT_BYTES_MAX`` or it cannot fit even after pruning.
    """
    event = {"id": new_event_id(), "at": float(_now() if now is None else now), "kind": kind, "status": status, "summary": summary, "data": data}
    if not _event_ok(event):
        raise HistoryStorageError("Événement d'historique invalide", 500)
    if _size(event) > EVENT_BYTES_MAX:
        raise HistoryStorageError("Opération trop volumineuse pour l'historique — réduis la sélection", 409)
    if kind in ("checkpoint", "restore"):
        content = data["content"] if kind == "checkpoint" else data["pre_content"]
        if _size(content) > SNAPSHOT_BYTES_MAX:
            raise HistoryStorageError("Page trop volumineuse pour un point de restauration", 409)
    with lock():
        state = _load_locked()
        state["events"].append(event)
        state["history_rev"] += 1
        _prune(state, event)
        _write(state)
    return event["id"]


def _update_event(event_id: str, mutate) -> None:
    with lock():
        state = _load_locked()
        for event in state["events"]:
            if event["id"] == event_id:
                mutate(event)
                break
        else:
            raise HistoryNotFound("Événement introuvable")
        if not _event_ok(event):
            raise HistoryStorageError("Événement d'historique invalide", 500)
        state["history_rev"] += 1
        _write(state)


def set_status(event_id: str, status: str, targets: list[dict] | None = None, counts: dict | None = None) -> None:
    """Finalize a ``pending`` event (``applied`` / ``failed``). Optionally refreshes its target results."""

    def apply(event: dict) -> None:
        event["status"] = status
        if targets is not None:
            event["data"]["targets"] = targets
        if counts is not None:
            event["data"]["counts"] = counts

    _update_event(event_id, apply)


def mark_undone(event_id: str, undo_event_id: str, counts: dict, now: float | None = None) -> None:
    def apply(event: dict) -> None:
        event["data"]["undone"] = {"at": float(_now() if now is None else now), "event_id": undo_event_id, "counts": counts}

    _update_event(event_id, apply)


def get_event(event_id: str) -> dict:
    with lock():
        state = _load_locked()
    for event in state["events"]:
        if event["id"] == event_id:
            return json.loads(json.dumps(event))
    raise HistoryNotFound("Événement introuvable (peut-être élagué)")


def latest_snapshot(page_id: str) -> dict | None:
    """The newest content snapshot (checkpoint or restore pre-image) of a page, or None."""
    with lock():
        state = _load_locked()
    for event in reversed(state["events"]):
        if event["kind"] == "checkpoint" and event["data"]["page_id"] == page_id and event["status"] == "applied":
            return json.loads(json.dumps(event))
    return None


def undo_candidates() -> list[str]:
    """Ids of the bulk events that Undo may still address (the ``UNDO_WINDOW`` newest bulk events)."""
    with lock():
        state = _load_locked()
    bulk = [e["id"] for e in state["events"] if e["kind"] == "bulk"]
    return bulk[-UNDO_WINDOW:]


def _row(event: dict, window: set[str]) -> dict:
    data = event["data"]
    row: dict[str, Any] = {"id": event["id"], "at": event["at"], "kind": event["kind"], "status": event["status"], "summary": event["summary"]}
    kind = event["kind"]
    if kind == "checkpoint":
        row.update(page_id=data["page_id"], page_rev=data["page_rev"], label=data["label"], title=data["title"], restorable=True)
    elif kind == "restore":
        row.update(page_id=data["page_id"], from_event=data["from_event"], rev_before=data["rev_before"], rev_after=data["rev_after"], restorable=True)
    elif kind == "bulk":
        row.update(op=data["op"], counts=data["counts"], undone=data["undone"], undoable=event["status"] == "applied" and data["undone"] is None and event["id"] in window)
    elif kind == "undo":
        row.update(of=data["of"], counts=data["counts"])
    elif kind == "lifecycle":
        row.update(page_id=data["page_id"], action=data["action"], rev_after=data["rev_after"])
    return row


def list_events(page_id: str | None = None, limit: int = 100) -> dict:
    """Newest first, without heavy payloads. ``page_id`` keeps the events that concern that page."""
    if page_id is not None and (not isinstance(page_id, str) or not _PAGE_ID_RE.match(page_id)):
        raise HistoryError("page invalide")
    limit = max(1, min(int(limit), EVENTS_MAX))
    with lock():
        state = _load_locked()
    window = {e["id"] for e in [x for x in state["events"] if x["kind"] == "bulk"][-UNDO_WINDOW:]}
    out = []
    for event in reversed(state["events"]):
        if page_id is not None and not _concerns(event, page_id):
            continue
        out.append(_row(event, window))
        if len(out) >= limit:
            break
    return {
        "ok": True, "history_rev": state["history_rev"], "pruned_total": state["pruned_total"], "events": out,
        "limits": limits(),
    }


def _concerns(event: dict, page_id: str) -> bool:
    data = event["data"]
    kind = event["kind"]
    if kind in ("checkpoint", "restore", "lifecycle"):
        return data["page_id"] == page_id
    if kind in ("bulk", "undo"):
        return any(t["kind"] == "page" and t["id"] == page_id for t in data["targets"])
    return False


def limits() -> dict:
    return {
        "events": EVENTS_MAX, "snapshots_per_page": SNAPSHOTS_PER_PAGE_MAX, "bytes": HISTORY_BYTES_MAX,
        "event_bytes": EVENT_BYTES_MAX, "undo_window": UNDO_WINDOW, "bulk_targets": TARGETS_MAX,
    }


# ---------------------------------------------------------------- backup


def referenced_drawings(data: Any) -> set[str]:
    """Drawing stems that a restore of any retained checkpoint / restore pre-image would bring back (backup closure, read-only)."""
    out: set[str] = set()
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        return out
    for event in data["events"]:
        if not isinstance(event, dict) or event.get("status") == "failed" or not isinstance(event.get("data"), dict):
            continue
        field = {"checkpoint": "content", "restore": "pre_content"}.get(event.get("kind"))
        content = event["data"].get(field) if field else None
        if not isinstance(content, dict) or content.get("version") != rich.CONTENT_VERSION or not isinstance(content.get("blocks"), list):
            continue
        for block in content["blocks"]:
            out.update(rich.block_drawings(block))
    return out


def referenced_assets(data: Any) -> set[str]:
    """Image asset ids that a restore of any retained checkpoint / restore pre-image would bring back (Stage 08 backup closure).

    Only well-formed V2 content is read and only ids with the strict asset-id shape are returned; anything else is ignored
    (the caller already validated ``data`` with ``_usable``). Read-only, no I/O.
    """
    out: set[str] = set()
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        return out
    for event in data["events"]:
        if not isinstance(event, dict) or event.get("status") == "failed" or not isinstance(event.get("data"), dict):
            continue
        field = {"checkpoint": "content", "restore": "pre_content"}.get(event.get("kind"))
        content = event["data"].get(field) if field else None
        if not isinstance(content, dict) or content.get("version") != rich.CONTENT_VERSION or not isinstance(content.get("blocks"), list):
            continue
        for block in content["blocks"]:
            for asset in rich.block_assets(block):  # single images AND image-group children (Phase 2)
                ident = asset.get("id")
                if isinstance(ident, str) and rich.ASSET_ID_RE.match(ident):
                    out.add(ident)
            out.update(rich.block_provenance_assets(block))  # Phase 4: an OCR source stays part of the restore closure
    return out


def referenced_voices(data: Any) -> set[str]:
    """Voice asset ids a restore of any retained checkpoint / restore pre-image would bring back (Phase 4 backup closure)."""
    out: set[str] = set()
    if not isinstance(data, dict) or not isinstance(data.get("events"), list):
        return out
    for event in data["events"]:
        if not isinstance(event, dict) or event.get("status") == "failed" or not isinstance(event.get("data"), dict):
            continue
        field = {"checkpoint": "content", "restore": "pre_content"}.get(event.get("kind"))
        content = event["data"].get(field) if field else None
        if not isinstance(content, dict) or content.get("version") != rich.CONTENT_VERSION or not isinstance(content.get("blocks"), list):
            continue
        for block in content["blocks"]:
            out.update(rich.block_voices(block))
    return out


def snapshot_bytes(root: Path | str) -> tuple[bytes | None, bool]:
    """Committed ``history.json`` bytes (under its lock) and whether they validate; ``(None, True)`` when absent.

    A redirected path is refused (HistoryStorageError). Malformed bytes are returned as they are (valid False).
    """
    src = history_path(root)
    with hq_state.path_lock(src):
        confined_path(root)
        if not os.path.lexists(src):
            return None, True
        if not src.is_file():
            raise HistoryStorageError("history.json n'est pas un fichier — conservé")
        payload = src.read_bytes()
    try:
        return payload, _usable(json.loads(payload.decode("utf-8")))
    except (UnicodeDecodeError, ValueError):
        return payload, False
