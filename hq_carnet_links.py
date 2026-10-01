"""Carnet Stage 08: "Liée depuis…" — backlinks DERIVED from the structured references already stored in the notes.

There is no second source of truth: nothing is persisted and viewing a backlink list never mutates the notebook. The
references come from the stored, validated structures only: ``link`` marks with a ``ref`` (note / project / file /
drawing / model / media), ``citation`` marks (-> the source edition ``cite.src``) and the optional ``link`` of a
``measure`` block. Free text and URLs are never parsed.

Strategy (explicit complexity): LAZY and INCREMENTAL. Nothing runs on typing or on save. When the panel asks, the
notebook is read once (O(file)) and every page's reference multiset is taken from an in-process memo keyed by
``(notebook path, page id, page rev, updated_at)``: unchanged pages cost one dictionary lookup, a changed page is
re-extracted exactly once (O(its blocks + marks)). Pages that disappeared are dropped from the memo, which is bounded.
The memo is a cache only: dropping it (restart, restore from backup) rebuilds the same answer.

Lifecycle: a trashed page's links are listed apart (``trashed``) and never mixed into ``items``; archived projects
are not special (their pages are active pages). The target may be missing / trashed: the list is still derived and
``target_exists`` says so. Paths in references are the stored RELATIVE ones; nothing absolute ever appears.
"""

from __future__ import annotations

import threading
from collections import Counter
from pathlib import Path
from typing import Any

import hq_carnet_rich as rich
import hq_state

KINDS = rich.REF_KINDS + ("source",)
MEMO_MAX = 1024
ITEMS_MAX = 256

_memo: dict[tuple, Counter] = {}
_lock = threading.Lock()
stats = {"extracted": 0, "hits": 0}  # observable in tests (complexity expectations)


def _hc():
    import hq_carnet

    return hq_carnet


def refs_of_content(content: dict) -> Counter:
    """Multiset of ``(kind, id)`` referenced by one page's stored content. A legacy V1 page has none."""
    out: Counter = Counter()
    if content.get("version") != rich.CONTENT_VERSION:
        return out
    for block in content["blocks"]:
        for mark in block["marks"]:
            if mark["type"] == "link" and "ref" in mark:
                out[(mark["ref"]["kind"], mark["ref"]["id"])] += 1
            elif mark["type"] == "citation":
                out[("source", mark["cite"]["src"])] += 1
        if block["type"] == rich.DRAWING_TYPE:  # Phase 3: a drawing block is a reference like a drawing link mark
            out[("drawing", block["drawing"]["id"])] += 1
        if block["type"] == "measure":
            link = block["measure"].get("link")
            if isinstance(link, dict) and isinstance(link.get("kind"), str) and isinstance(link.get("id"), str):
                out[(link["kind"], link["id"])] += 1
    return out


def _page_refs(path_key: str, page: dict) -> Counter:
    key = (path_key, page["id"], page["rev"], page["updated_at"])
    with _lock:
        got = _memo.get(key)
        if got is not None:
            stats["hits"] += 1
            return got
    refs = refs_of_content(page["content"])
    with _lock:
        stats["extracted"] += 1
        _memo[key] = refs
    return refs


def _forget(path_key: str, pages: list[dict]) -> None:
    live = {(path_key, p["id"], p["rev"], p["updated_at"]) for p in pages}
    with _lock:
        for key in [k for k in _memo if k[0] == path_key and k not in live]:
            del _memo[key]
        while len(_memo) > MEMO_MAX:
            _memo.pop(next(iter(_memo)))


def clear() -> None:
    with _lock:
        _memo.clear()
        stats.update(extracted=0, hits=0)


def check_target(kind: Any, ident: Any) -> tuple[str, str]:
    hc = _hc()
    if kind not in KINDS or not isinstance(ident, str):
        raise hc.CarnetError("Cible invalide")
    if kind == "source":
        import hq_carnet_sources as sources

        if not sources._ID_RE["srce"].match(ident):
            raise hc.CarnetError("Cible invalide")
        return kind, ident
    try:
        ref = rich.check_ref({"kind": kind, "id": ident}, hc._folders(), hc._system_names())
    except rich.ContentError as e:
        raise hc.CarnetError("Cible invalide") from e
    return ref["kind"], ref["id"]


def _plain_file(root: Path, rel: str) -> bool:
    """A regular, non-link file below ``root`` (read-only existence check; the reference was already validated)."""
    try:
        path = root / rel
        if path.is_symlink() or not path.is_file():
            return False
        return path.resolve().is_relative_to(root.resolve())
    except (OSError, ValueError):
        return False


def _target_state(hc: Any, kind: str, ident: str, state: dict) -> tuple[bool | None, bool]:
    """``(exists, archived)``. ``exists`` is True/False for every kind; None ONLY when the lookup itself failed (storage
    unreadable) - an explicit "unknown", never a silent default. Read-only, no path ever leaves this function."""
    if kind == "note":
        return any(p["id"] == ident and p["deleted_at"] is None for p in state["pages"]), False
    if kind == "project":
        proj = next((p for p in state["projects"] if p["id"] == ident), None)
        return proj is not None, bool(proj and proj.get("archived"))
    if kind == "source":
        import hq_carnet_sources as sources

        try:
            with hq_state.path_lock(sources.confined_path()):
                sstate = sources._load_locked()
        except Exception:  # unreadable sources.json: the answer is "unknown", not "present"
            return None, False
        ed = next((e for e in sstate["editions"] if e["id"] == ident), None)
        return ed is not None, bool(ed and ed.get("archived"))
    root = hc._cb.get("root")
    if root is None:
        return None, False
    root = Path(root)
    if kind == "drawing":
        return _plain_file(root / "Inbox" / "Drawings", ident + ".hqdraw.json"), False
    return _plain_file(root, ident), False  # file / model / media: stored RELATIVE path


def backlinks(kind: Any, ident: Any) -> dict:
    hc = _hc()
    kind, ident = check_target(kind, ident)
    path = hc._path()
    with hq_state.path_lock(path):
        state = hc._load_locked(create=False)  # viewing never writes
    key = str(path)
    _forget(key, state["pages"])
    items: list[dict] = []
    trashed: list[dict] = []
    for page in state["pages"]:
        count = _page_refs(key, page).get((kind, ident), 0)
        if not count:
            continue
        row = {"page_id": page["id"], "title": hc.derive_title(rich.flat_text(page["content"])), "project_id": page["project_id"], "count": count, "updated_at": page["updated_at"]}
        (trashed if page["deleted_at"] is not None else items).append(row)
    items.sort(key=lambda r: -r["updated_at"])
    trashed.sort(key=lambda r: -r["updated_at"])
    exists, archived = _target_state(hc, kind, ident, state)
    return {
        "ok": True, "target": {"kind": kind, "id": ident}, "target_exists": exists, "target_archived": archived,
        "items": items[:ITEMS_MAX], "total": len(items), "trashed": trashed[:ITEMS_MAX], "trashed_total": len(trashed),
        "notebook_rev": state["notebook_rev"],
    }
