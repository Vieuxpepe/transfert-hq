"""Carnet Stage 08: explicit restore points and restore (stdlib only).

``history_checkpoint`` stores the CURRENT persisted content of one page as an explicit "point de restauration"
(identical to the latest checkpoint of that page => no new event). ``history_restore`` puts a checkpoint (or the
pre-restore content kept by an earlier restore) back as the page's NEW current revision:

* it goes through the normal ``page_save`` validation and revision semantics (size limits, media checks, block ids);
* the current revision must match ``expected_rev`` (409 + the current page otherwise: fail closed on stale state);
* the content it replaces is kept in the ``restore`` event (``pre_content``), later history is never deleted, and the
  event records ``from_event`` (the restored-from reference), so a restore is itself restorable and auditable;
* order of writes: validate in memory -> history event ``pending`` -> notebook -> event ``applied``.
"""

from __future__ import annotations

import copy
from typing import Any

import hq_carnet_history as history
import hq_carnet_rich as rich
import hq_state

_PAGE_KEYS = {"action", "page_id", "expected_rev", "label"}


def _hc():
    import hq_carnet

    return hq_carnet


def _err(message: str):
    return _hc().CarnetError(message)


def _label(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str) or len(value) > history.LABEL_MAX or any(ord(c) < 32 or 0x7F <= ord(c) <= 0x9F for c in value):
        raise _err("Libellé invalide")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise _err("Libellé invalide") from e
    return value.strip()


def checkpoint(data: Any) -> dict:
    hc = _hc()
    if not isinstance(data, dict):
        raise _err("Requête invalide")
    hc._only_keys(data, _PAGE_KEYS)
    page_id = hc._req_id(data, "page_id", "page")
    expected = hc._req_int(data, "expected_rev")
    label = _label(data.get("label"))
    with hq_state.path_lock(hc._path()):
        state = hc._load_locked(create=False)
        page = hc._find(state["pages"], page_id, "Page")
        hc._check_page_rev(state, page, expected)
        if page["deleted_at"] is not None:
            raise _err("Page dans la corbeille — restaure-la d'abord")
        content = copy.deepcopy(page["content"])
        latest = history.latest_snapshot(page_id)
        if latest is not None and latest["data"]["content"] == content and latest["data"]["label"] == label:
            return {"ok": True, "duplicate": True, "event_id": latest["id"], "page_rev": page["rev"]}
        title = hc.derive_title(rich.flat_text(content))
        event_id = history.append(
            "checkpoint", "applied", ("Point de restauration" + (f" : {label}" if label else "")),
            {"page_id": page_id, "page_rev": page["rev"], "title": title, "label": label, "content": content},
        )
    return {"ok": True, "duplicate": False, "event_id": event_id, "page_rev": expected}


def _restorable(snapshot: dict, page: dict) -> dict:
    """Snapshot content in a shape ``page_save`` accepts for ``page``: only block ids that still belong to the page survive."""
    current = page["content"]
    if snapshot["version"] == rich.LEGACY_CONTENT_VERSION:
        text = snapshot["blocks"][0]["text"]
        if current["version"] == rich.LEGACY_CONTENT_VERSION:
            return {"version": rich.LEGACY_CONTENT_VERSION, "blocks": [{"id": current["blocks"][0]["id"], "type": "text", "text": text, "marks": []}]}
        return {"version": rich.CONTENT_VERSION, "blocks": [{"type": "paragraph", "text": line, "marks": []} for line in text.split("\n")]}
    own = set(rich.content_ids(current))
    claimed: set[str] = set()
    blocks = []
    for block in copy.deepcopy(snapshot["blocks"]):
        if block["id"] in own and block["id"] not in claimed:
            claimed.add(block["id"])
        else:
            del block["id"]
        blocks.append(block)
    return {"version": rich.CONTENT_VERSION, "blocks": blocks}


def restore(data: Any) -> dict:
    hc = _hc()
    if not isinstance(data, dict):
        raise _err("Requête invalide")
    hc._only_keys(data, {"action", "page_id", "event_id", "expected_rev", "confirm"})
    page_id = hc._req_id(data, "page_id", "page")
    expected = hc._req_int(data, "expected_rev")
    event_id = data.get("event_id")
    if not isinstance(event_id, str) or not history._EVENT_ID_RE.match(event_id):
        raise _err("Événement invalide")
    if data.get("confirm") is not True:
        raise _err("Confirmation explicite requise")
    event = history.get_event(event_id)
    if event["status"] != "applied" or event["kind"] not in ("checkpoint", "restore") or event["data"]["page_id"] != page_id:
        raise _err("Cette version ne peut pas être restaurée")
    snapshot = event["data"]["content"] if event["kind"] == "checkpoint" else event["data"]["pre_content"]
    now = hc._now()
    with hq_state.path_lock(hc._path()):
        state = hc._load_locked(create=False)
        page = hc._find(state["pages"], page_id, "Page")
        hc._check_page_rev(state, page, expected)
        if page["deleted_at"] is not None:
            raise _err("Page dans la corbeille — restaure-la d'abord")
        pre_content = copy.deepcopy(page["content"])
        rev_before = page["rev"]
        try:
            hc._page_save(state, {"action": "page_save", "id": page_id, "expected_rev": expected, "content": _restorable(snapshot, page)}, now)
        except rich.ContentError as e:
            raise _err(str(e)) from e
        if page["rev"] == rev_before:
            raise _err("Cette version est déjà la version actuelle")
        event_new = history.append(
            "restore", "pending", "Version restaurée",
            {"page_id": page_id, "from_event": event_id, "rev_before": rev_before, "rev_after": page["rev"], "pre_content": pre_content},
        )
        try:
            hc._write(state)
        except Exception:
            try:
                history.set_status(event_new, "failed")
            except history.HistoryStorageError:
                pass
            raise
        confirmed = True
        try:
            history.set_status(event_new, "applied")
        except history.HistoryStorageError:
            confirmed = False
        return {"ok": True, "page": copy.deepcopy(page), "notebook_rev": state["notebook_rev"], "event_id": event_new, "restored_from": event_id, "history_confirmed": confirmed}
