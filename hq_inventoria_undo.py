"""Undo journal for Inventoria commits.

Just before each commit the touched items are snapshotted; right after it, the items the batch created are noted. An *undo* never
edits stock by itself: it builds an inverse **draft** (adjust -delta, restore edited fields, move back, delete created items) that the
Master previews and confirms like any other draft. The journal is small (40 batches) and lives in Inventoria's own state folder.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-inventoria"
FILE = "undo.json"
MAX_ENTRIES = 40
_lock = threading.RLock()
_KEEP = ("name", "qty", "unit", "min", "place", "note", "tags", "rev")


def _path(root: Any) -> Path:
    return Path(root) / STATE_FOLDER / FILE


def _load(root: Any) -> dict[str, dict]:
    try:
        rows = json.loads(_path(root).read_text(encoding="utf-8")).get("entries", {})
    except Exception:
        return {}
    return rows if isinstance(rows, dict) else {}


def _save(root: Any, rows: dict[str, dict]) -> None:
    while len(rows) > MAX_ENTRIES:
        rows.pop(next(iter(rows)))
    p = _path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    hq_state.write_json_atomic(p, {"version": 1, "entries": rows})


def touched_ids(proposals: list[dict]) -> set[str]:
    out: set[str] = set()
    for p in proposals:
        pl = p.get("payload") or {}
        if p.get("op") in ("item.adjust", "item.update", "item.delete") and isinstance(pl.get("id"), str):
            out.add(pl["id"])
        elif p.get("op") == "item.move":
            out.update(i for i in pl.get("ids", []) if isinstance(i, str))
    return out


def _items(inv: dict) -> dict[str, dict]:
    return {i["id"]: i for i in inv.get("items", []) if isinstance(i, dict) and "id" in i}


def record(root: Any, op_id: str, proposals: list[dict], inv_before: dict, inv_after: dict, *, now: float | None = None) -> None:
    before = _items(inv_before)
    after = _items(inv_after)
    snap = {iid: {k: before[iid].get(k) for k in _KEEP} for iid in touched_ids(proposals) if iid in before}
    created = [{"id": iid, "name": it.get("name")} for iid, it in after.items() if iid not in before]
    slim = [{"op": p.get("op"), "label_fr": p.get("label_fr", ""), "payload": p.get("payload") or {}} for p in proposals]
    with _lock:
        rows = _load(root)
        rows[op_id] = {"at": float(now if now is not None else time.time()), "before": snap, "created": created, "proposals": slim}
        _save(root, rows)


def get(root: Any, op_id: str) -> dict | None:
    with _lock:
        return _load(root).get(op_id)


def mark_undo(root: Any, op_id: str, undo_op_id: str) -> None:
    with _lock:
        rows = _load(root)
        if op_id in rows:
            rows[op_id]["undone_by"] = undo_op_id
            _save(root, rows)


def clear_undo_mark(root: Any, op_id: str) -> None:
    with _lock:
        rows = _load(root)
        if op_id in rows and "undone_by" in rows[op_id]:
            del rows[op_id]["undone_by"]
            _save(root, rows)


def _prop(op: str, refs: dict, payload: dict, label: str) -> dict:
    return {"op": op, "refs": refs, "resolved": {"confidence": "high"}, "payload": payload, "label_fr": label[:200]}


def inverse(entry: dict, inv_now: dict) -> tuple[list[dict], list[str]]:
    """(inverse proposals, human-readable reasons for anything that cannot be undone)."""
    cur = _items(inv_now)
    props: list[dict] = []
    skipped: list[str] = []
    moves: dict[Any, list[str]] = {}
    for p in entry.get("proposals", []):
        op, pl, label = p.get("op"), p.get("payload") or {}, p.get("label_fr") or ""
        if op == "item.adjust":
            iid = pl.get("id")
            if iid not in cur:
                skipped.append(label or "ajustement"); continue
            props.append(_prop("item.adjust", {"item_id": iid}, {"id": iid, "delta": -int(pl.get("delta", 0))},
                               f"Annuler : {label}" if label else "Annuler un ajustement"))
        elif op == "item.update":
            iid = pl.get("id")
            old = (entry.get("before") or {}).get(iid)
            if iid not in cur or not old:
                skipped.append(label or "modification"); continue
            payload: dict[str, Any] = {"id": iid, "rev": cur[iid]["rev"]}
            for k in pl:
                if k in ("id", "rev", "photos"):
                    continue
                if k in ("name", "qty", "unit", "min", "place", "note", "tags"):
                    payload[k] = old.get(k)
            if len(payload) <= 2:
                skipped.append(label or "modification"); continue
            props.append(_prop("item.update", {"item_id": iid}, payload, f"Annuler : {label}" if label else "Annuler une modification"))
        elif op == "item.move":
            for iid in pl.get("ids", []):
                old = (entry.get("before") or {}).get(iid)
                if iid in cur and old is not None:
                    moves.setdefault(old.get("place"), []).append(iid)
                else:
                    skipped.append(label or "déplacement")
        else:
            if op not in ("item.create",):
                skipped.append(label or str(op))
    for place, ids in moves.items():
        props.append(_prop("item.move", {}, {"ids": ids, "place": place}, f"Annuler : déplacer {len(ids)} article(s) à leur place d'origine"))
    for c in entry.get("created", []):
        if c["id"] in cur:
            props.append(_prop("item.delete", {"item_id": c["id"]}, {"id": c["id"], "rev": cur[c["id"]]["rev"]},
                               f"Annuler : retirer {c.get('name') or 'article créé'}"))
        else:
            skipped.append(f"création de {c.get('name')} (déjà retirée)")
    return props, skipped
