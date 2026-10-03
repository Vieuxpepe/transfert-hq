"""Carnet Phase 5: read-only service layer for the engineering-review views (cockpit, baselines, diff).

Reads the notebook / sources / history / snapshot store under their own locks, hands PURE data to ``hq_carnet_intel`` and
returns path-free JSON. Nothing here writes anything.

Baselines are explicit ids only (``hev-…`` checkpoint, ``snap-…`` snapshot). ``baselines`` lists them and, for ``at=<epoch>``,
resolves "the nearest surviving checkpoint/snapshot at or before" that instant and says exactly which one it resolved to;
the diff itself never takes a date.
"""

from __future__ import annotations

import copy
import os
from pathlib import Path
from typing import Any

import hq_carnet_ask as ask_mod
import hq_carnet_history as history
import hq_carnet_intel as intel
import hq_carnet_links as links
import hq_carnet_rich as rich
import hq_carnet_snapshots as snaps
import hq_state

IDENTITY_NOTE = (
    "La comparaison est exacte (identifiant de bloc + contenu). Un bloc dont l'identifiant a changé — par exemple recréé par une "
    "restauration — apparaît comme supprimé puis ajouté. Les déplacements de blocs ne sont pas signalés. Aucun auteur n'est enregistré."
)


def _hc():
    import hq_carnet

    return hq_carnet


def _err(message: str):
    return _hc().CarnetError(message)


def _make_ctx(hc, state: dict, root: Path, editions: dict[str, dict] | None) -> intel.Ctx:
    page_ids = {p["id"] for p in state["pages"] if p["deleted_at"] is None}
    project_ids = {p["id"] for p in state["projects"]}

    def title(page: dict) -> str:
        return hc.derive_title(rich.flat_text(page["content"]))

    def ref_state(kind: str, ident: str) -> str:
        if kind == "note":
            return "ok" if ident in page_ids else "missing"
        if kind == "project":
            return "ok" if ident in project_ids else "missing"
        if kind == "source":
            if editions is None:
                return "unknown"
            return "ok" if ident in editions else "missing"
        if kind == "drawing":
            return "ok" if links._plain_file(root / "Inbox" / "Drawings", ident + ".hqdraw.json") else "missing"
        if kind in ("asset", "voice"):  # canonical sources of derived (OCR / transcript) text
            return "ok" if snaps._locate(kind, ident, root) is not None else "missing"
        return "ok" if links._plain_file(root, ident) else "missing"

    def source_info(ident: str) -> dict | None:
        ed = (editions or {}).get(ident)
        if ed is None:
            return None
        fr = ed.get("file_ref")
        file_state = None
        if isinstance(fr, str) and fr:
            file_state = "ok" if links._plain_file(root, fr) else "missing"
        return {"title": ed["title"], "archived": bool(ed.get("archived")), "file_state": file_state}

    return intel.Ctx(title, ref_state, source_info)


def _editions() -> dict[str, dict] | None:
    import hq_carnet_sources as sources

    try:
        with hq_state.path_lock(sources.confined_path()):
            return {e["id"]: e for e in copy.deepcopy(sources._load_locked())["editions"]}
    except Exception:  # noqa: BLE001 - unreadable sources are "unknown", the cockpit still works
        return None


def _load_state():
    hc = _hc()
    with hq_state.path_lock(hc._path()):
        return copy.deepcopy(hc._load_locked(create=False))


def cockpit(project_id: Any) -> dict:
    hc = _hc()
    if project_id == "none":
        pid = None
    elif isinstance(project_id, str) and hc._ID_RE["proj"].match(project_id):
        pid = project_id
    else:
        raise _err("Projet invalide")
    state = _load_state()
    project = None
    if pid is not None:
        project = next((p for p in state["projects"] if p["id"] == pid), None)
        if project is None:
            raise hc.CarnetNotFound("Projet introuvable")
    pages = [p for p in state["pages"] if p["deleted_at"] is None and p["project_id"] == pid]
    root = Path(os.path.abspath(os.fspath(hc._cb["root"])))
    ctx = _make_ctx(hc, state, root, _editions())
    events: list[dict] = []
    history_ok = True
    try:
        ids = {p["id"] for p in pages}
        for ev in history.list_events(None, history.EVENTS_MAX)["events"]:
            if ev["kind"] == "checkpoint" and ev["status"] == "applied" and ev["page_id"] in ids:
                events.append(ev)
    except (history.HistoryError, history.HistoryStorageError):
        history_ok = False  # failure isolation: the cockpit works without history
    snap_rows: list[dict] = []
    snap_ok = True
    if pid is not None:
        try:
            snap_rows = snaps.list_snapshots(pid)["snapshots"]
        except (snaps.SnapshotError, snaps.SnapshotStorageError):
            snap_ok = False
    out = intel.cockpit(project, pages, ctx, events, state["notebook_rev"])
    out["history_available"] = history_ok
    out["snapshots_available"] = snap_ok
    out["snapshots"] = snap_rows[:PER_VIEW_SNAPSHOTS]
    out["snapshots_total"] = len(snap_rows)
    return out


PER_VIEW_SNAPSHOTS = snaps.PER_PROJECT_MAX


# ---------------------------------------------------------------- baselines


def baselines(project_id: Any, page_id: Any, at: Any) -> dict:
    """Candidates for "since last review". ``page_id`` -> that page's checkpoints; ``project_id`` -> its snapshots
    (plus, for convenience, the checkpoints of its pages). ``at`` resolves the nearest one at or before that instant."""
    hc = _hc()
    if page_id is not None and (not isinstance(page_id, str) or not hc._ID_RE["page"].match(page_id)):
        raise _err("Page invalide")
    if project_id is not None and (not isinstance(project_id, str) or not hc._ID_RE["proj"].match(project_id)):
        raise _err("Projet invalide")
    if page_id is None and project_id is None:
        raise _err("Page ou projet requis")
    if at is not None:
        try:
            at = int(at)
        except (TypeError, ValueError) as e:
            raise _err("Date invalide") from e
        if at < 0 or at > 4102444800:
            raise _err("Date invalide")
    cps: list[dict] = []
    if page_id is not None:
        for ev in history.list_events(page_id, history.EVENTS_MAX)["events"]:
            if ev["kind"] == "checkpoint" and ev["status"] == "applied" and ev["page_id"] == page_id:
                cps.append({"kind": "checkpoint", "id": ev["id"], "at": ev["at"], "label": ev["label"], "page_id": ev["page_id"], "page_rev": ev["page_rev"]})
    sn: list[dict] = []
    if project_id is not None:
        for h in snaps.list_snapshots(project_id)["snapshots"]:
            sn.append({"kind": "snapshot", "id": h["id"], "at": h["created_at"], "label": h["label"], "project_id": h["project_id"], "integrity": h["integrity"]})
    out: dict[str, Any] = {
        "ok": True, "checkpoints": cps, "snapshots": sn,
        "latest_checkpoint": cps[0] if cps else None, "latest_snapshot": sn[0] if sn else None,
    }
    if at is not None:
        def nearest(rows):
            ok = [r for r in rows if r["at"] <= at]
            return max(ok, key=lambda r: (r["at"], r["id"])) if ok else None

        out["resolved"] = {"at": at, "checkpoint": nearest(cps), "snapshot": nearest(sn)}
    return out


# ---------------------------------------------------------------- diff


def _checkpoint_base(ev_id: str) -> tuple[dict, dict]:
    ev = history.get_event(ev_id)
    if ev["kind"] != "checkpoint" or ev["status"] != "applied":
        raise _err("Ce point de restauration n'est pas un checkpoint")
    d = ev["data"]
    return {"kind": "checkpoint", "id": ev["id"], "at": ev["at"], "label": d["label"], "page_id": d["page_id"], "page_rev": d["page_rev"]}, d["content"]


def diff(base: Any, to: Any, page_id: Any, project_id: Any) -> dict:
    hc = _hc()
    if not isinstance(base, str):
        raise _err("Baseline requise")
    state = _load_state()
    root = Path(os.path.abspath(os.fspath(hc._cb["root"])))
    ctx = _make_ctx(hc, state, root, _editions())
    live = {p["id"]: p for p in state["pages"]}
    if history._EVENT_ID_RE.match(base):
        if to is not None or project_id is not None:
            raise _err("Un checkpoint se compare à la version actuelle d'une page")
        info, content = _checkpoint_base(base)
        if page_id is not None and page_id != info["page_id"]:
            raise _err("Ce checkpoint concerne une autre page")
        page = live.get(info["page_id"])
        if page is None:
            raise hc.CarnetNotFound("Page introuvable")
        d = intel.diff_page(content, page["content"])
        return {
            "ok": True, "scope": "page", "base": info, "to": {"kind": "current", "page_id": page["id"], "page_rev": page["rev"], "trashed": page["deleted_at"] is not None},
            "page_id": page["id"], "diff": d, "note": IDENTITY_NOTE,
        }
    if not snaps.ID_RE.match(base):
        raise _err("Baseline invalide")
    got = snaps.get(base)
    if got["integrity"] != "ok":
        raise snaps.SnapshotStorageError("Intégrité du jalon compromise — comparaison refusée", 503)
    snap = got["snapshot"]
    base_info = {"kind": "snapshot", "id": snap["id"], "at": snap["created_at"], "label": snap["label"], "project_id": snap["project"]["id"]}
    if to is not None:
        if not isinstance(to, str) or not snaps.ID_RE.match(to):
            raise _err("Cible invalide")
        other = snaps.get(to)
        if other["integrity"] != "ok":
            raise snaps.SnapshotStorageError("Intégrité du jalon compromise — comparaison refusée", 503)
        if other["snapshot"]["project"]["id"] != snap["project"]["id"]:
            raise _err("Les deux jalons doivent appartenir au même projet")
        cur_pages = other["snapshot"]["pages"]
        to_info = {"kind": "snapshot", "id": to, "at": other["snapshot"]["created_at"], "label": other["snapshot"]["label"], "project_id": snap["project"]["id"]}
        gone = lambda pid: "absent"  # noqa: E731
    else:
        pid = snap["project"]["id"]
        cur_pages = [p for p in state["pages"] if p["deleted_at"] is None and p["project_id"] == pid]
        to_info = {"kind": "current", "project_id": pid, "fingerprint": intel.fingerprint(cur_pages)}

        def gone(page: str) -> str:
            p = live.get(page)
            if p is None:
                return "deleted"
            if p["deleted_at"] is not None:
                return "trashed"
            return "moved"
    res = intel.diff_pages(snap["pages"], cur_pages, gone, ctx)
    if page_id is not None:
        if not isinstance(page_id, str) or not hc._ID_RE["page"].match(page_id):
            raise _err("Page invalide")
        res["pages"] = [r for r in res["pages"] if r["page_id"] == page_id]
    return {"ok": True, "scope": "project", "base": base_info, "to": to_info, **res, "note": IDENTITY_NOTE}


# ---------------------------------------------------------------- snapshot view (derived cockpit of a frozen state)


def snapshot_cockpit(snap_id: Any, trusted: bool = False) -> dict:
    """The cockpit of a frozen snapshot: the SAME derivation over the frozen pages. Reference states are those observed NOW.
    ``trusted=False`` is forensic inspection (a broken seal is shown, flagged ``integrity``); ``trusted=True`` is use as frozen project
    state (reports) and REFUSES a snapshot whose seal does not match."""
    hc = _hc()
    got = snaps.get(snap_id)
    if trusted and got["integrity"] != "ok":
        raise snaps.SnapshotStorageError("Intégrité du jalon compromise — utilisation comme état figé refusée", 503)
    snap = got["snapshot"]
    state = _load_state()
    root = Path(os.path.abspath(os.fspath(hc._cb["root"])))
    ctx = _make_ctx(hc, state, root, _editions())
    project = dict(snap["project"], created_at=0, updated_at=0)
    out = intel.cockpit(project, copy.deepcopy(snap["pages"]), ctx, None, snap["notebook_rev"])
    out["snapshot"] = snaps.header(snap, got["integrity"])
    out["snapshot_refs"] = snaps.ref_summary(snap)
    return out


# ---------------------------------------------------------------- Ask Carnet (Phase 6): evidence-only, nothing stored


def _scope(hc, state: dict, raw: Any) -> tuple[dict, list[dict], dict | None, dict | None, dict | None]:
    """``(scope echo, pages, frozen info or None, live blocks or None, the verified snapshot or None)``; raises on anything not exactly valid."""
    if not isinstance(raw, dict) or raw.get("kind") not in ask_mod.SCOPES:
        raise _err("Périmètre invalide")
    kind = raw["kind"]
    allowed = {"kind"} if kind == "notebook" else {"kind", "id"}
    if set(raw) != allowed:
        raise _err("Périmètre invalide")
    live = [p for p in state["pages"] if p["deleted_at"] is None]
    if kind == "notebook":
        return {"kind": "notebook", "id": None, "label": "Tout le carnet"}, live, None, None, None
    ident = raw["id"]
    if not isinstance(ident, str):
        raise _err("Périmètre invalide")
    if kind == "page":
        if not hc._ID_RE["page"].match(ident):
            raise _err("Note invalide")
        page = next((p for p in live if p["id"] == ident), None)
        if page is None:
            raise hc.CarnetNotFound("Note introuvable")
        return {"kind": "page", "id": ident, "label": hc.derive_title(rich.flat_text(page["content"]))}, [page], None, None, None
    if kind == "project":
        if ident == "none":
            return {"kind": "project", "id": "none", "label": "Sans projet"}, [p for p in live if p["project_id"] is None], None, None, None
        if not hc._ID_RE["proj"].match(ident):
            raise _err("Projet invalide")
        project = next((p for p in state["projects"] if p["id"] == ident), None)
        if project is None:
            raise hc.CarnetNotFound("Projet introuvable")
        return {"kind": "project", "id": ident, "label": project["name"]}, [p for p in live if p["project_id"] == ident], None, None, None
    got = snaps.get(ident)  # snapshot: used as frozen project state => its seal MUST verify
    if got["integrity"] != "ok":
        raise snaps.SnapshotStorageError("Intégrité du jalon compromise — recherche refusée", 503)
    snap = got["snapshot"]
    pid = snap["project"]["id"]
    frozen = {"snapshot_id": snap["id"], "label": snap["label"], "created_at": snap["created_at"], "fingerprint": snap["fingerprint"], "project_id": pid}
    live_blocks = {}
    for page in live:
        if page["project_id"] == pid:
            for b in (page["content"].get("blocks") or []):
                if isinstance(b, dict) and b.get("id"):
                    live_blocks[(page["id"], b["id"])] = b
    pages = [{"id": p["id"], "rev": p["rev"], "content": p["content"], "project_id": p["project_id"], "category_id": p.get("category_id"),
              "updated_at": p["updated_at"], "created_at": p["created_at"], "deleted_at": None} for p in copy.deepcopy(snap["pages"])]
    return {"kind": "snapshot", "id": ident, "label": snap["label"]}, pages, frozen, live_blocks, snap


def _frozen_ctx(live: intel.Ctx, snap: dict):
    """``(ctx, sources, current)`` describing the SNAPSHOT: reference states and source metadata as sealed at freeze time."""
    sealed: dict[tuple[str, str], str] = {}
    for bucket, kind, field in (("drawings", "drawing", "stem"), ("assets", "asset", "id"), ("voices", "voice", "id")):
        for row in snap["refs"][bucket]:
            sealed[(kind, row[field])] = row["state"]
    for row in snap["refs"]["files"]:  # file-family links keep their ORIGINAL kind (file / model / media): that is the key evidence asks with
        sealed[(row["kind"], row["path"])] = row["state"]
    infos: dict[str, dict] = {}
    for row in snap["refs"]["sources"]:
        sealed[("source", row["id"])] = row["state"]
        if not row.get("missing") and row.get("state") == "ok":
            infos[row["id"]] = row

    def ref_state(kind: str, ident: str) -> str:
        return sealed.get((kind, ident)) or live.state(kind, ident)

    def source_info(ident: str) -> dict | None:
        row = infos.get(ident)
        if row is None:
            return None
        return {"title": row.get("title"), "archived": bool(row.get("archived")), "file_state": (row.get("file") or {}).get("state")}

    ctx = intel.Ctx(live.title, ref_state, source_info)
    sources = {k: {f: v.get(f) for f in ("title", "author", "year", "edition")} for k, v in infos.items()}
    return ctx, sources, live.state


def ask(data: Any) -> dict:
    """``{action: "ask", question, scope: {kind, id?}, limit?}`` -> evidence cards. Read-only: writes nothing, stores nothing."""
    hc = _hc()
    if not isinstance(data, dict):
        raise _err("Requête invalide")
    hc._only_keys(data, {"action", "question", "scope", "limit"})
    question = data.get("question")
    if not isinstance(question, str) or len(question) > ask_mod.LIMITS["question_chars"] or any(ord(c) < 32 or 0x7F <= ord(c) <= 0x9F for c in question):
        raise _err(f"Question invalide (texte de {ask_mod.LIMITS['question_chars']} caractères au plus)")
    limit = data.get("limit", ask_mod.LIMITS["cards_default"])
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= ask_mod.LIMITS["cards"]:
        raise _err("Limite invalide")
    state = _load_state()
    scope, pages, frozen, live_blocks, snap = _scope(hc, state, data.get("scope"))
    root = Path(os.path.abspath(os.fspath(hc._cb["root"])))
    editions = _editions()
    ctx = _make_ctx(hc, state, root, editions)
    sources = {k: {f: v.get(f) for f in ("title", "author", "year", "edition")} for k, v in (editions or {}).items()}
    current = None
    if snap is not None:
        # a frozen scope speaks of the frozen state: source metadata and reference states are those SEALED in the snapshot;
        # what exists NOW is reported separately (current_state), never mixed in
        ctx, sources, current = _frozen_ctx(ctx, snap)
    out = ask_mod.search(question, pages, ctx, scope=scope, sources=sources, limit=limit, frozen=frozen, live_blocks=live_blocks,
                         notebook_rev=state["notebook_rev"], current=current)
    out["sources_available"] = editions is not None
    return out
