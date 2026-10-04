"""Carnet Phase 7: evidence for review packs — selection (server-owned seals), freshness (read-only), rendering and export. Stdlib only.

Two layers that never mix:
  * the STORED item (``hq_carnet_reviews``): what the user selected and what the SERVER observed at that moment — identity (``key``),
    ``seal`` and a bounded captured ``copy``. Historical; never refreshed, never rewritten by anything in this module.
  * the OBSERVATION (``freshness``): what exists NOW, resolved on demand, per item, isolated (one failing item never discards the
    pack), never written anywhere. States: ``unchanged`` | ``changed`` | ``missing`` | ``unknown``; an item bound to a snapshot also
    reports ``frozen`` and ``current_differs`` (does the live state still match what the snapshot froze?).

Nothing here decides what evidence MEANS: no status, approval, risk, completion or resolution is inferred. Rendering uses a fixed label
vocabulary; user-authored text is reproduced exactly (escaped for Markdown), and no generated timestamp enters the export, so the same
pack + the same observation always yields the same bytes.
"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

import hq_carnet_history as history
import hq_carnet_intel as intel
import hq_carnet_reviews as reviews
import hq_carnet_portals as portals
import hq_carnet_rich as rich
import hq_carnet_snapshots as snaps

DIFF_ROWS_MAX = 200
COPY_TEXT_MAX = 1000
STATES = ("unchanged", "changed", "missing", "unknown")
_STEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\Z")


class _Unknown(Exception):
    """An observation could not be made (store unreadable, snapshot unusable): the item is ``unknown``, never ``missing``."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


def _hc():
    import hq_carnet

    return hq_carnet


def _rv():
    import hq_carnet_review as review

    return review


def sha(value: Any) -> str:
    return hashlib.sha256(reviews.canon_bytes(value)).hexdigest()


def _short(text: Any, limit: int = COPY_TEXT_MAX) -> str:
    text = " ".join(str(text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _err(message: str):
    return reviews.ReviewError(message)


# ---------------------------------------------------------------- the worlds the resolver looks at


class World:
    """A read-only view of "what exists" for ONE operation: memoised (so a batch reads each store once), never writes.
    ``frozen`` worlds are built from a verified snapshot; the live world from the notebook / sources / filesystem."""

    def __init__(self) -> None:
        review = _rv()
        self.hc = _hc()
        self.state = review._load_state()
        self.root = Path(os.path.abspath(os.fspath(self.hc._cb["root"])))
        self._editions: Any = ...
        self._snaps: dict[str, tuple[str, dict | None]] = {}
        self._asks: dict[str, dict] = {}
        self._files: dict[str, Any] = {}
        self.portal_cache: dict = {}
        self._targets: dict[tuple[str, str], dict] = {}
        self.pages = {p["id"]: p for p in self.state["pages"] if p["deleted_at"] is None}

    def editions(self) -> dict[str, dict]:
        if self._editions is ...:
            self._editions = _rv()._editions()
        if self._editions is None:
            raise _Unknown("sources_unavailable")
        return self._editions

    def snapshot(self, snap_id: str) -> tuple[str, dict | None]:
        """``(state, snapshot)`` with state ``ok`` | ``missing`` | ``corrupt`` | ``unavailable``."""
        if snap_id not in self._snaps:
            try:
                got = snaps.get(snap_id)
                self._snaps[snap_id] = ("ok" if got["integrity"] == "ok" else "corrupt", got["snapshot"])
            except snaps.SnapshotNotFound:
                self._snaps[snap_id] = ("missing", None)
            except (snaps.SnapshotError, snaps.SnapshotStorageError):
                self._snaps[snap_id] = ("unavailable", None)
        return self._snaps[snap_id]

    def drawing(self, stem: str) -> tuple[str, int] | None:
        if stem not in self._files:
            try:
                self._files[stem] = snaps.hash_file(self.root / "Inbox" / "Drawings" / (stem + ".hqdraw.json"))
            except snaps.SnapshotStorageError as e:
                raise _Unknown("drawing_unreadable") from e
        return self._files[stem]

    def portal_target(self, kind: str, ident: str) -> dict:
        """The LIVE state of a portal target (read-only, memoised for this one operation). Never part of the stored layer."""
        key = (kind, ident)
        if key not in self._targets:
            row = portals.resolve_one({"kind": kind, "id": ident}, self.root, self.portal_cache)
            self._targets[key] = {"state": row["state"], "state_label": row["state_label"], "integrity": row.get("integrity"), "title": row["title"]}
        return self._targets[key]

    def project_pages(self, project_id: str) -> list[dict]:
        return [p for p in self.pages.values() if p["project_id"] == project_id]


def _page_obs(page: dict) -> dict:
    return {"content_sha256": sha(page["content"]), "rev": page["rev"]}


def _block_of(page: dict, block_id: str) -> dict | None:
    content = page.get("content") or {}
    if content.get("version") != rich.CONTENT_VERSION:
        return None
    return next((b for b in content["blocks"] if isinstance(b, dict) and b.get("id") == block_id), None)


def _block_obs(block: dict) -> dict:
    return {"block_sha256": sha(block), "type": block["type"]}


_BLOCK_TYPES = {"block": None, "decision": "decision", "measurement": "measure"}


def _source_meta(row: dict) -> str:
    return sha({k: row.get(k) for k in ("id", "title", "author", "edition", "year", "publisher", "identifier", "type", "url", "file_ref", "archived")})


# ---------------------------------------------------------------- observation (one item, against live OR a snapshot)


def _frozen_pages(snap: dict) -> dict[str, dict]:
    return {p["id"]: p for p in snap["pages"]}


def _observe(kind: str, key: dict, world: World, snap: dict | None) -> dict | None:
    """The seal fields of the item as they are in ``snap`` (frozen) or in the live world. ``None`` = does not exist there.
    Raises ``_Unknown`` when it cannot be observed."""
    if kind in ("page", "block", "decision", "measurement"):
        pages = _frozen_pages(snap) if snap is not None else world.pages
        page = pages.get(key["page_id"])
        if page is None:
            return None
        if kind == "page":
            return _page_obs(page)
        block = _block_of(page, key["block_id"])
        if block is None or (_BLOCK_TYPES[kind] and block["type"] != _BLOCK_TYPES[kind]):
            return None
        return _block_obs(block)
    if kind == "drawing":
        if snap is not None:
            row = next((r for r in snap["refs"]["drawings"] if r["stem"] == key["stem"]), None)
            if row is None or row.get("state") != "ok":
                return None
            return {"sha256": row["sha256"], "size": row["size"]}
        got = world.drawing(key["stem"])
        return None if got is None else {"sha256": got[0], "size": got[1]}
    if kind == "source":
        if snap is not None:
            row = next((r for r in snap["refs"]["sources"] if r.get("id") == key["edition_id"]), None)
            if row is None or row.get("missing") or row.get("state") != "ok":
                return None
            return {"metadata_sha256": _source_meta(row)}
        ed = world.editions().get(key["edition_id"])
        return None if ed is None else {"metadata_sha256": _source_meta(snaps._edition_info(ed))}
    if kind == "snapshot":
        state, found = world.snapshot(key["snapshot_id"])
        if state == "missing":
            return None
        if state != "ok":
            raise _Unknown("snapshot_" + state)
        return {"content_sha256": found["content_sha256"]}
    if kind == "project_overview":
        if snap is not None:
            return {"fingerprint": snap["fingerprint"]}
        if not any(p["id"] == key["project_id"] for p in world.state["projects"]):
            return None
        return {"fingerprint": intel.fingerprint(world.project_pages(key["project_id"]))}
    raise _Unknown("unsupported_kind")


def _ask_run(world: World, key: dict) -> dict | None:
    memo = sha(key)
    if memo not in world._asks:
        hc = _hc()
        try:
            res = _rv().ask({"action": "ask", "question": key["question"], "scope": key["scope"], "limit": key["limit"]})
        except hc.CarnetNotFound:
            res = None
        except (hc.CarnetError, reviews.ReviewError, snaps.SnapshotError, snaps.SnapshotStorageError) as e:
            raise _Unknown("ask_unavailable") from e
        world._asks[memo] = res  # type: ignore[assignment]
    return world._asks[memo]


def _diff_run(world: World, key: dict) -> dict | None:
    hc = _hc()
    memo = "d" + sha(key)
    if memo not in world._asks:
        base, to = key["base"], key["to"]
        if _STEM_RE.match(base) and _STEM_RE.match(to or "") and not snaps.ID_RE.match(base) and not base.startswith("hev-"):
            res = {"pair": [_drawing_ref(world, base), _drawing_ref(world, to)]}
        else:
            try:
                res = _rv().diff(base, to, key["page_id"], key["project_id"])
            except (hc.CarnetNotFound, snaps.SnapshotNotFound, history.HistoryNotFound):
                res = None
            except (hc.CarnetError, reviews.ReviewError, snaps.SnapshotError, snaps.SnapshotStorageError, history.HistoryError, history.HistoryStorageError) as e:
                raise _Unknown("diff_unavailable") from e
        world._asks[memo] = res  # type: ignore[assignment]
    return world._asks[memo]


def _drawing_ref(world: World, stem: str) -> dict:
    got = world.drawing(stem)
    return {"stem": stem, "state": "missing" if got is None else "ok", "sha256": None if got is None else got[0], "size": None if got is None else got[1]}


def _diff_seal(res: dict) -> dict:
    core = {k: v for k, v in res.items() if k not in ("note", "ok")}
    return {"diff_sha256": sha(core), "target": sha(res.get("to") if "to" in res else res.get("pair"))}


def _observe_ask(item: dict, world: World) -> dict | None:
    res = _ask_run(world, item["key"])
    return None if res is None else {"fingerprint": res["fingerprint"]}


def _observe_diff(item: dict, world: World) -> dict | None:
    res = _diff_run(world, item["key"])
    return None if res is None else _diff_seal(res)


def observe(kind: str, key: dict, world: World) -> dict | None:
    """Public live observation of ONE item (Phase 11 verification capture): the seal fields now, ``None`` = absent; raises ``_Unknown``."""
    return _observe(kind, key, world, None)


def _snapshot_of_scope(item: dict, world: World) -> dict | None:
    sc = item["scope"]
    if sc["kind"] == "live":
        return None
    state, snap = world.snapshot(sc["id"])
    if state == "missing":
        raise _Unknown("frozen_snapshot_missing")
    if state != "ok":
        raise _Unknown("frozen_snapshot_" + state)
    if snap["content_sha256"] != sc["seal"]:
        raise _Unknown("frozen_snapshot_seal_changed")
    return snap


def freshness_of(item: dict, world: World) -> dict:
    """The observation of ONE item. Never raises: any failure is the item's own ``unknown`` (with a reason)."""
    out: dict[str, Any] = {"id": item["id"], "state": "unknown", "reason": None, "observed": None, "frozen": None, "current_differs": None, "anomaly": None, "target": None}
    kind = item["kind"]
    try:
        if kind in ("ask_result", "diff"):
            seen = _observe_ask(item, world) if kind == "ask_result" else _observe_diff(item, world)
            if item["scope"]["kind"] != "live":
                _snapshot_of_scope(item, world)  # the frozen scope itself must still verify
                out["frozen"] = "ok"
        elif item["scope"]["kind"] == "live":
            seen = _observe(kind, item["key"], world, None)
        else:
            snap = _snapshot_of_scope(item, world)
            out["frozen"] = "ok"
            seen = _observe(kind, item["key"], world, snap)
            try:
                live_seen = _observe(kind, item["key"], world, None)
                out["current_differs"] = live_seen != seen
            except _Unknown:
                out["current_differs"] = None
        if seen is None:
            out["state"], out["reason"] = "missing", "absent"
        else:
            out["observed"] = seen
            out["state"] = "unchanged" if seen == item["seal"] else "changed"
            if out["state"] == "changed" and kind == "drawing":
                out["anomaly"] = "drawing_bytes_changed"  # stems are immutable versions: same stem, other bytes = integrity anomaly
            if out["state"] == "changed" and kind == "snapshot":
                out["anomaly"] = "snapshot_seal_changed"
        portal = (item.get("copy") or {}).get("portal") if kind == "block" else None
        if isinstance(portal, dict):  # Phase 8, layer 2: the portal BLOCK (above) and its TARGET (here) are two separate facts
            try:
                out["target"] = world.portal_target(portal["kind"], portal["id"])
            except Exception:  # noqa: BLE001
                out["target"] = {"state": "unknown", "state_label": "État inconnu", "integrity": None, "title": portal.get("id", "")}
    except _Unknown as e:
        out["state"], out["reason"] = "unknown", e.reason
        if out["frozen"] is None and item["scope"]["kind"] != "live":
            out["frozen"] = "unavailable"
    except Exception:  # noqa: BLE001 - failure isolation: one bad item never discards the pack
        out["state"], out["reason"] = "unknown", "resolver_error"
    return out


def freshness(pack: dict) -> dict:
    """``{"items": {item_id: observation}, "counts": {...}}`` — read-only, batched, per-item isolated. Writes nothing."""
    try:
        world = World()
    except Exception:  # noqa: BLE001
        rows = {i["id"]: {"id": i["id"], "state": "unknown", "reason": "notebook_unavailable", "observed": None, "frozen": None, "current_differs": None, "anomaly": None, "target": None} for i in pack["items"]}
        return {"items": rows, "counts": _counts(rows.values())}
    rows = {i["id"]: freshness_of(i, world) for i in pack["items"]}
    return {"items": rows, "counts": _counts(rows.values())}


def _counts(rows) -> dict:
    counts = {s: 0 for s in STATES}
    for r in rows:
        counts[r["state"]] += 1
    return counts


# ---------------------------------------------------------------- selection: the SERVER builds identity, seal and captured copy


def _need_str(spec: dict, key: str, regex: re.Pattern, what: str) -> str:
    value = spec.get(key)
    if not isinstance(value, str) or not regex.match(value):
        raise _err(f"{what} invalide")
    return value


def _baseline_snap(pack: dict, world: World) -> dict | None:
    b = pack["baseline"]
    if b["kind"] == "live":
        return None
    state, snap = world.snapshot(b["snapshot_id"])
    if state != "ok" or snap["content_sha256"] != b["seal"]:
        raise snaps.SnapshotStorageError("Le jalon du contexte n'est pas utilisable — preuve refusée", 503)
    return snap


def _scope_for(pack: dict) -> dict:
    b = pack["baseline"]
    return {"kind": "live"} if b["kind"] == "live" else {"kind": "snapshot", "id": b["snapshot_id"], "seal": b["seal"]}


def _page_title(page: dict) -> str:
    return _hc().derive_title(rich.flat_text(page["content"]))


def build_item(spec: Any, pack: dict) -> dict:
    """A complete stored item (without ``id`` / ``added_at``) built from an IDENTITY-only request. The client never supplies seals."""
    if not isinstance(spec, dict) or spec.get("kind") not in reviews.ITEM_KINDS:
        raise _err("Preuve invalide")
    kind = spec["kind"]
    hc = _hc()
    world = World()
    pid = pack["project_id"]
    scope = _scope_for(pack)
    item: dict[str, Any] = {"kind": kind, "scope": scope, "supersedes": []}
    if kind in ("page", "block", "decision", "measurement"):
        allowed = {"kind", "page_id"} if kind == "page" else {"kind", "page_id", "block_id"}
        hc._only_keys(spec, allowed)
        page_id = _need_str(spec, "page_id", hc._ID_RE["page"], "Note")
        snap = _baseline_snap(pack, world)
        pages = _frozen_pages(snap) if snap is not None else world.pages
        page = pages.get(page_id)
        if page is None or (snap is None and page["project_id"] != pid):
            raise hc.CarnetNotFound("Note introuvable dans ce projet")
        if kind == "page":
            item["key"] = {"page_id": page_id}
            item["seal"] = _page_obs(page)
            item["label"] = _short(_page_title(page), reviews.LABEL_MAX)
            item["copy"] = {"title": _short(_page_title(page), 200), "rev": page["rev"], "updated_at": page["updated_at"], "excerpt": _short(rich.flat_text(page["content"]), 400)}
            return item
        block_id = _need_str(spec, "block_id", hc._ID_RE["block"], "Bloc")
        block = _block_of(page, block_id)
        if block is None:
            raise _err("Bloc introuvable (les notes de format ancien n'ont pas de blocs)")
        if _BLOCK_TYPES[kind] and block["type"] != _BLOCK_TYPES[kind]:
            raise _err("Ce bloc n'est pas du type demandé")
        item["key"] = {"page_id": page_id, "block_id": block_id}
        item["seal"] = _block_obs(block)
        item["label"] = _short(intel.block_summary(block), reviews.LABEL_MAX)
        cp: dict[str, Any] = {"page_title": _short(_page_title(page), 200), "type": block["type"], "summary": intel.block_summary(block)}
        if block["type"] == rich.PORTAL_TYPE:  # the captured IDENTITY of the target (no title/state): its current state is observed separately
            cp["portal"] = {"kind": block["portal"]["ref"]["kind"], "id": block["portal"]["ref"]["id"]}
        if kind == "decision":
            cp.update(text=_short(block["text"]), at=block["decision"]["at"])
        elif kind == "measurement":
            cp["measure"] = copy.deepcopy(block["measure"])
        else:
            cp["text"] = _short(block.get("text", ""))
        item["copy"] = cp
        return item
    if kind == "drawing":
        hc._only_keys(spec, {"kind", "stem"})
        stem = _need_str(spec, "stem", _STEM_RE, "Dessin")
        snap = _baseline_snap(pack, world)
        seen = _observe("drawing", {"stem": stem}, world, snap)
        if seen is None:
            raise hc.CarnetNotFound("Dessin introuvable — il ne peut pas être ajouté")
        item.update(key={"stem": stem}, seal=seen, label=_short(rich.drawing_label(stem), reviews.LABEL_MAX), copy={"stem": stem, "label": rich.drawing_label(stem), "size": seen["size"]})
        return item
    if kind == "source":
        hc._only_keys(spec, {"kind", "edition_id"})
        eid = spec.get("edition_id")
        if not isinstance(eid, str) or not 1 <= len(eid) <= 80 or not re.match(r"^[A-Za-z0-9_-]+\Z", eid):
            raise _err("Édition invalide")
        snap = _baseline_snap(pack, world)
        seen = _observe("source", {"edition_id": eid}, world, snap)
        if seen is None:
            raise hc.CarnetNotFound("Source introuvable")
        if snap is not None:
            row = next(r for r in snap["refs"]["sources"] if r.get("id") == eid)
            info = {k: row.get(k) for k in snaps._edition_info({}).keys()}
        else:
            info = snaps._edition_info(world.editions()[eid])
        item.update(key={"edition_id": eid}, seal=seen, label=_short(info.get("title") or eid, reviews.LABEL_MAX), copy={k: (_short(v, 400) if isinstance(v, str) else v) for k, v in info.items()})
        return item
    if kind == "snapshot":
        hc._only_keys(spec, {"kind", "snapshot_id"})
        sid = _need_str(spec, "snapshot_id", snaps.ID_RE, "Jalon")
        state, snap = world.snapshot(sid)
        if state == "missing":
            raise snaps.SnapshotNotFound("Jalon introuvable")
        if state != "ok":
            raise snaps.SnapshotStorageError("Intégrité du jalon compromise — preuve refusée", 503)
        if snap["project"]["id"] != pid:
            raise _err("Le jalon appartient à un autre projet")
        item["scope"] = {"kind": "live"}
        item.update(key={"snapshot_id": sid}, seal={"content_sha256": snap["content_sha256"]}, label=_short(snap["label"], reviews.LABEL_MAX), copy=snaps.header(snap, "ok"))
        return item
    if kind == "project_overview":
        hc._only_keys(spec, {"kind"})
        snap = _baseline_snap(pack, world)
        if snap is not None:
            item["key"] = {"project_id": pid, "snapshot_id": snap["id"]}
            item["seal"] = {"fingerprint": snap["fingerprint"]}
            ov = _rv().snapshot_cockpit(snap["id"], trusted=True)
            label = f"Vue d'ensemble — {snap['label']}"
        else:
            item["key"] = {"project_id": pid, "snapshot_id": None}
            ov = _rv().cockpit(pid)
            item["seal"] = {"fingerprint": ov["fingerprint"]}
            label = "Vue d'ensemble du projet"
        item["label"] = _short(label, reviews.LABEL_MAX)
        item["copy"] = {"counts": ov["counts"], "fingerprint": ov["fingerprint"], "measurements": ov.get("measurements"), "truncated": ov.get("truncated")}
        return item
    if kind == "ask_result":
        hc._only_keys(spec, {"kind", "question", "scope", "limit", "fingerprint"})
        key = {"question": spec.get("question"), "scope": spec.get("scope"), "limit": spec.get("limit", 10)}
        res = _rv().ask({"action": "ask", **key})
        key["scope"] = {k: v for k, v in (spec["scope"] or {}).items()}
        shown = spec.get("fingerprint")
        if not isinstance(shown, str) or shown != res["fingerprint"]:
            raise reviews.ReviewConflict("Le résultat Ask a changé depuis son affichage — relance la recherche", code="review_evidence_changed", fingerprint=res["fingerprint"])
        sc = res.get("scope") or {}
        item["scope"] = {"kind": "live"} if sc.get("kind") != "snapshot" else _ask_snapshot_scope(world, sc["id"])
        item["key"] = key
        item["seal"] = {"fingerprint": res["fingerprint"]}
        item["label"] = _short(f"Ask Carnet — {key['question']}", reviews.LABEL_MAX)
        item["copy"] = res
        return item
    hc._only_keys(spec, {"kind", "base", "to", "page_id", "project_id"})
    key = {"base": spec.get("base"), "to": spec.get("to"), "page_id": spec.get("page_id"), "project_id": spec.get("project_id")}
    if not isinstance(key["base"], str):
        raise _err("Comparaison invalide")
    res = _diff_run(world, key)
    if res is None:
        raise hc.CarnetNotFound("Comparaison introuvable")
    if "pair" not in res:
        proj = (res.get("base") or {}).get("project_id")
        if proj is not None and proj != pid:
            raise _err("La comparaison concerne un autre projet")
        if res.get("scope") == "page":
            page = world.pages.get(res["page_id"])
            if page is None or page["project_id"] != pid:
                raise _err("La comparaison concerne un autre projet")
    item["scope"] = {"kind": "live"}
    item["key"] = key
    item["seal"] = _diff_seal(res)
    item["label"] = _short(_diff_label(res), reviews.LABEL_MAX)
    item["copy"] = _diff_copy(res)
    return item


def _ask_snapshot_scope(world: World, snap_id: str) -> dict:
    state, snap = world.snapshot(snap_id)
    if state != "ok":
        raise snaps.SnapshotStorageError("Intégrité du jalon compromise — preuve refusée", 503)
    return {"kind": "snapshot", "id": snap_id, "seal": snap["content_sha256"]}


def _diff_label(res: dict) -> str:
    if "pair" in res:
        return f"Dessins : {res['pair'][0]['stem']} ↔ {res['pair'][1]['stem']}"
    b, t = res.get("base") or {}, res.get("to") or {}
    return f"Comparaison — {b.get('label') or b.get('id')} → {t.get('kind')}"


def _diff_copy(res: dict) -> dict:
    """A bounded, explicitly truncated digest of the selected comparison. The complete result is only sealed (``diff_sha256``)."""
    if "pair" in res:
        a, b = res["pair"]
        return {"pair": res["pair"], "identical_bytes": bool(a["sha256"] and a["sha256"] == b["sha256"])}
    rows: list[dict] = []
    total = 0
    pieces = res.get("pages") if res.get("scope") == "project" else [{"page_id": res.get("page_id"), "diff": res.get("diff")}]
    for piece in pieces or []:
        d = piece.get("diff") or {}
        for bucket in ("added", "removed", "changed"):
            for row in d.get(bucket) or []:
                total += 1
                if len(rows) < DIFF_ROWS_MAX:
                    rows.append({"page_id": piece.get("page_id"), "change": bucket, "id": row.get("id"), "type": row.get("type"), "summary": _short(row.get("summary") or "", 160)})
        if not d and piece.get("status") and piece.get("status") != "unchanged":
            total += 1
            if len(rows) < DIFF_ROWS_MAX:
                rows.append({"page_id": piece.get("page_id"), "change": "page_" + str(piece.get("status")), "id": None, "type": None, "summary": ""})
    return {"scope": res.get("scope"), "base": res.get("base"), "to": res.get("to"), "rows": rows, "rows_total": total, "truncated": total > len(rows)}


# ---------------------------------------------------------------- fixed vocabulary, rendering, export

LABELS = {
    "status": {"draft": "Brouillon", "in_review": "En revue", "needs_followup": "À suivre", "reviewed": "Revue terminée"},
    "state": {"unchanged": "Inchangé", "changed": "Modifié depuis la sélection", "missing": "Introuvable", "unknown": "Non vérifiable"},
    "kind": {"page": "Note", "block": "Bloc", "decision": "Décision", "measurement": "Mesure", "drawing": "Dessin", "source": "Source", "snapshot": "Jalon",
             "project_overview": "Vue d'ensemble", "ask_result": "Résultat Ask Carnet", "diff": "Comparaison"},
    "question": {"open": "Ouverte", "resolved": "Marquée résolue par l'utilisateur"},
}
_MD_ESC = re.compile(r"([\\`*_{}\[\]<>#|~])")


def _md(text: Any) -> str:
    return _MD_ESC.sub(r"\\\1", str(text if text is not None else "")).replace("\r", "").replace("\n", " ")


def _md_block(text: str) -> str:
    return "\n".join("> " + _MD_ESC.sub(r"\\\1", ln) for ln in str(text).splitlines()) if text else ""


def _utc(at: Any) -> str:
    import datetime

    try:
        return datetime.datetime.fromtimestamp(int(at), datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    except (OverflowError, OSError, ValueError, TypeError):
        return "?"


def render_markdown(pack: dict, fresh: dict | None, integrity: str = "ok", thread: dict | None = None) -> str:
    """Fixed order: identity, project, status, baseline, observation summary, checklist, open questions, evidence, comparisons, provenance.
    Fixed labels only; user text verbatim. No overall verdict is ever produced."""
    items = pack["items"]
    obs = (fresh or {}).get("items") or {}
    L = [f"# {_md(pack['title'])}", "", "## Identité de la revue", "",
         f"- Identifiant : {pack['id']}", f"- Révision : {pack['rev']}", f"- Projet : {pack['project_id']}",
         f"- Statut (défini par l'utilisateur) : {LABELS['status'][pack['status']]}", f"- Créée : {_utc(pack['created_at'])}", f"- Mise à jour : {_utc(pack['updated_at'])}",
         f"- Sceau : {pack['content_sha256']}", f"- Intégrité du fichier : {'vérifiée' if integrity == 'ok' else 'ALTÉRÉE — lecture seule'}"]
    cm = _comments_by_item(thread)
    if thread and thread.get("comments"):
        L.append(f"- Commentaires de revue : révision {thread['rev']} du fil, sceau {thread['content_sha256']}, intégrité {'vérifiée' if thread['integrity'] == 'ok' else 'ALTÉRÉE'}")
    L.append("")
    if pack["note"]:
        L += ["## Note de l'auteur", "", _md_block(pack["note"]), ""]
    b = pack["baseline"]
    L += ["## Contexte", "", "- Contexte : état courant (non figé)" if b["kind"] == "live" else f"- Contexte figé : jalon {b['snapshot_id']} — {_md(b['label'])} (sceau {b['seal']})", ""]
    L += ["## Observation de fraîcheur (au moment de l'export)", ""]
    if fresh is None:
        L += ["- Fraîcheur non observée.", ""]
    else:
        c = fresh["counts"]
        L += [f"- {LABELS['state'][s]} : {c[s]}" for s in STATES] + [""]
    L += ["## Liste de contrôle (cochée par l'utilisateur)", ""]
    ids = {i["id"] for i in items}
    for c in pack["checklist"]:
        refs = ", ".join(r + ("" if r in ids else " (preuve retirée)") for r in c["refs"])
        L.append(f"- [{'x' if c['checked'] else ' '}] {_md(c['text'])}" + (f" — preuves : {refs}" if refs else ""))
    if not pack["checklist"]:
        L.append("- (aucun point)")
    L += ["", "## Questions ouvertes", ""]
    for q in pack["questions"]:
        refs = ", ".join(r + ("" if r in ids else " (preuve retirée)") for r in q["refs"])
        L.append(f"- [{LABELS['question'][q['state']]}] {_md(q['text'])}" + (f" — preuves : {refs}" if refs else ""))
        if q["resolution_note"]:
            L.append(f"  - Note de l'utilisateur : {_md(q['resolution_note'])}")
    if not pack["questions"]:
        L.append("- (aucune question)")
    L += ["", "## Preuves (copies capturées à la sélection)", ""]
    plain = [i for i in items if i["kind"] not in ("diff",)]
    for i in plain:
        L += _item_md(i, obs.get(i["id"]), cm.get(i["id"]))
    if not plain:
        L.append("(aucune preuve)")
    L += ["", "## Comparaisons", ""]
    diffs = [i for i in items if i["kind"] == "diff"]
    for i in diffs:
        L += _item_md(i, obs.get(i["id"]), cm.get(i["id"]))
    if not diffs:
        L.append("(aucune comparaison)")
    L += _removed_comments_md(cm, {i["id"] for i in items})
    L += ["", "## Détails de provenance", ""]
    for i in items:
        L.append(f"- {i['id']} · {LABELS['kind'][i['kind']]} · ajoutée {_utc(i['added_at'])} · portée : {i['scope']['kind']}" + (f" {i['scope']['id']}" if i["scope"]["kind"] == "snapshot" else "")
                 + f" · clé : {json.dumps(i['key'], sort_keys=True, ensure_ascii=True)} · sceau : {json.dumps(i['seal'], sort_keys=True, ensure_ascii=True)}")
        for s in i["supersedes"]:
            L.append(f"  - remplace une recherche précédente (empreinte {s['fingerprint']}, {_utc(s['replaced_at'])})")
    if not items:
        L.append("(aucune)")
    L.append("")
    return "\n".join(L)


def _comments_by_item(thread: dict | None) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for c in (thread or {}).get("comments", []):
        out.setdefault(c["item"]["item_id"], []).append(c)
    return out


def _comment_md(c: dict) -> list[str]:
    head = f"- {c['id']} · {_utc(c['created_at'])}" + (f" · corrige {c['supersedes']}" if c["supersedes"] else "")
    return [head, _md_block(c["body"])]


def _removed_comments_md(cm: dict[str, list[dict]], present: set[str]) -> list[str]:
    """Review comments about an item that is no longer in the pack are NEVER omitted from the handoff: they are exported under their
    captured item identity (id, kind, label, fingerprint)."""
    gone = {k: v for k, v in cm.items() if k not in present}
    if not gone:
        return []
    out = ["", "## Commentaires sur preuves retirées", ""]
    for item_id in sorted(gone):
        ident = gone[item_id][0]["item"]
        out += [f"### {item_id} · {LABELS['kind'].get(ident['item_kind'], ident['item_kind'])} — {_md(ident['item_label'])}", "",
                f"- Empreinte de la preuve capturée : {ident['item_fingerprint']}", ""]
        for c in gone[item_id]:
            out += _comment_md(c) + [""]
    return out


def _item_md(i: dict, o: dict | None, comments: list[dict] | None = None) -> list[str]:
    state = LABELS["state"][o["state"]] if o else "Non observé"
    out = [f"### {LABELS['kind'][i['kind']]} — {_md(i['label'])}", "", f"- Fraîcheur : {state}" + ("" if not o or not o.get("anomaly") else " — anomalie d'intégrité")]
    if o and o.get("target"):
        out.append(f"- Cible du portail (état actuel, distinct du bloc) : {_md(o['target']['state_label'])}")
    out += [f"- Ajoutée : {_utc(i['added_at'])}", "- Copie capturée à la sélection (jamais actualisée) :"]
    cp = i["copy"] or {}
    if i["kind"] == "ask_result":
        out.append(f"  - Question : {_md(i['key']['question'])}")
        for c in (cp.get("cards") or [])[:20]:
            out.append(f"  - {_md(c.get('title') or c.get('page_title') or '')} : {_md(_short(c.get('excerpt') or c.get('text') or '', 240))}")
    elif i["kind"] == "diff":
        if "pair" in cp:
            out += [f"  - {_md(p['stem'])} : {p['state']} {p['sha256']}" for p in cp["pair"]]
        else:
            for r in cp.get("rows", []):
                out.append(f"  - {r['change']} · {_md(r['type'] or '')} · {_md(r['summary'])}")
            if cp.get("truncated"):
                out.append(f"  - Extrait tronqué : {len(cp['rows'])} lignes affichées sur {cp['rows_total']}.")
    else:
        for k in sorted(cp):
            if isinstance(cp[k], (str, int, float, bool)) or cp[k] is None:
                out.append(f"  - {k} : {_md(cp[k])}")
    if comments:
        out += ["", f"- Commentaires de revue ({len(comments)}) — commentaires de la revue, distincts de la preuve capturée :"]
        for c in comments:
            out += ["  " + line for line in _comment_md(c)]
    out.append("")
    return out


def export_zip(pack: dict, fresh: dict | None, integrity: str = "ok", thread: dict | None = None) -> bytes:
    """The review HANDOFF package (not a self-contained archive): review.json, review.md, manifest.json. Deterministic: stdlib zipfile,
    ZIP_STORED, fixed timestamps and attributes, sorted names, no generated time anywhere in the content."""
    with_comments = bool(thread and thread.get("comments"))
    doc = {"review": pack, "integrity": integrity, "observation": fresh}
    if with_comments:  # a pack without comments exports byte-for-byte as before (no key, no section)
        doc["review_comments"] = {"rev": thread["rev"], "content_sha256": thread["content_sha256"], "integrity": thread["integrity"], "comments": thread["comments"]}
    review_json = reviews.canon_bytes(doc)
    md = render_markdown(pack, fresh, integrity, thread if with_comments else None).encode("utf-8")
    manifest = {
        "kind": "carnet-review-handoff", "version": 1, "review_id": pack["id"], "rev": pack["rev"], "project_id": pack["project_id"],
        "content_sha256": pack["content_sha256"], "integrity": integrity,
        "files": {"review.json": hashlib.sha256(review_json).hexdigest(), "review.md": hashlib.sha256(md).hexdigest()},
        "items": [{"id": i["id"], "kind": i["kind"], "scope": i["scope"], "key": i["key"], "seal": i["seal"],
                   "freshness": ((fresh or {}).get("items") or {}).get(i["id"], {}).get("state")} for i in pack["items"]],
        "note": "Review handoff package: the review file and its references. Referenced canonical binaries are NOT included.",
    }
    if with_comments:  # Review Pack rev N + review-comment thread rev M is the fully identified exported state; live annotations are never included
        manifest["review_comments"] = {"rev": thread["rev"], "content_sha256": thread["content_sha256"], "integrity": thread["integrity"], "count": len(thread["comments"])}
    manifest_b = reviews.canon_bytes(manifest)
    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for name, data in sorted((("manifest.json", manifest_b), ("review.json", review_json), ("review.md", md))):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = 0o100644 << 16
            info.create_system = 3
            zf.writestr(info, data)
    return buf.getvalue()
