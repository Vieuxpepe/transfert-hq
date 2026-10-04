"""Carnet Phase 9 — Reader resolver: a READ-ONLY, shallow, batched answer for inspecting evidence.

    The Reader views evidence; it never transforms, summarises or reinterprets it. ``reader_resolve`` takes IDENTITIES only
    (an edition id, optionally the citation as stored in the page, optionally a frozen context) and answers with three
    explicitly separated parts so the UI never has to infer which side a value belongs to:

        captured   what was written down THEN: the citation snapshot, its locator, its explicit PDF page, whether the
                   LOCATION was checked (``ok`` never means the content / claim was verified), migration provenance,
                   or the frozen metadata of a snapshot / review item. Never replaced by current values.
        current    what is true NOW: source metadata, source state (available | archived | missing | unknown) and file state
                   (ok | missing | unknown | none) through the Phase 8 tri-state probe. A missing FILE is not a missing SOURCE.
        integrity  only for a frozen context: not_applicable | matches_seal | differs_from_seal | sealed_file_missing | unknown.
                   The sealed hash is compared with the current canonical bytes; frozen bytes are never reconstructed.

    A locator is NOT a PDF page: neither is ever derived from the other, and no printed page is inferred (no calibration is
    returned). Nothing is written (no notebook, source, review, snapshot, file or cache); no raw path, URL or ``file://``
    leaves this module: the only file reference is a ``/files/<quoted relative path>`` route built from a confined,
    canonical ``file_ref``. One broken entry never affects the others. A POST only because 100 entries do not fit a query string.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any

import hq_carnet_portals as portals
import hq_carnet_rich as rich
import hq_carnet_snapshots as snaps

ENTRIES_MAX = 100
INTEGRITY = ("not_applicable", "matches_seal", "differs_from_seal", "sealed_file_missing", "unknown")
_META_KEYS = ("title", "author", "edition", "year", "publisher", "identifier", "type")
_COMPARE = ("title", "author", "edition", "year", "identifier")  # the fields a citation snapshot also captures


class ReaderError(ValueError):
    status = 400
    code = "validation_error"


def _check_context(raw: Any) -> dict:
    if not isinstance(raw, dict):
        raise ReaderError("Contexte invalide")
    kind = raw.get("kind")
    if kind == "snapshot" and set(raw) == {"kind", "id"} and isinstance(raw["id"], str) and snaps.ID_RE.match(raw["id"]):
        return {"kind": "snapshot", "id": raw["id"]}
    if kind == "review" and set(raw) == {"kind", "id", "item_id"}:
        import hq_carnet_reviews as reviews

        if isinstance(raw["id"], str) and reviews.ID_RE.match(raw["id"]) and isinstance(raw["item_id"], str) and reviews.ITEM_ID_RE.match(raw["item_id"]):
            return {"kind": "review", "id": raw["id"], "item_id": raw["item_id"]}
    raise ReaderError("Contexte invalide")


def _check_request(data: Any) -> list[dict]:
    """Exact schema: ``{action, entries:[{source_id, citation?, context?}]}``; a context only with exactly one entry."""
    if not isinstance(data, dict) or set(data) != {"action", "entries"}:
        raise ReaderError("Requête du lecteur invalide")
    entries = data["entries"]
    if not isinstance(entries, list) or not entries or len(entries) > ENTRIES_MAX:
        raise ReaderError(f"Entre 1 et {ENTRIES_MAX} entrées")
    out = []
    for raw in entries:
        if not isinstance(raw, dict) or "source_id" not in raw or not set(raw) <= {"source_id", "citation", "context"}:
            raise ReaderError("Entrée du lecteur invalide")
        sid = raw["source_id"]
        if not isinstance(sid, str) or not rich._EDITION_ID_RE.match(sid):
            raise ReaderError("Entrée du lecteur invalide")
        entry: dict[str, Any] = {"source_id": sid, "citation": None, "context": None}
        if "citation" in raw:
            try:
                cite = rich.check_cite(raw["citation"])
            except rich.ContentError as e:
                raise ReaderError("Citation invalide") from e
            if cite["src"] != sid:
                raise ReaderError("La citation ne correspond pas à la source")
            entry["citation"] = cite
        if "context" in raw:
            entry["context"] = _check_context(raw["context"])
            if len(entries) != 1:
                raise ReaderError("Un contexte figé se lit seul (une entrée)")
        out.append(entry)
    return out


# ---------------------------------------------------------------- captured side


def _meta(info: dict) -> dict:
    out = {}
    for k in _META_KEYS:
        v = info.get(k)
        if isinstance(v, str):
            v = portals._clip(v, 400)
        if v not in (None, ""):
            out[k] = v
    return out


def _captured_citation(cite: dict) -> dict:
    snap = cite["snap"]
    meta = {"title": snap["title"]}
    for src_key, key in (("author", "author"), ("edition", "edition"), ("year", "year"), ("ident", "identifier")):
        if src_key in snap:
            meta[key] = snap[src_key]
    origin = cite["from"]
    return {
        "kind": "citation",
        "metadata": meta,
        "locator": {"kind": cite["loc"]["kind"], "text": cite["loc"]["text"]} if cite["loc"]["text"] else None,
        "pdf": cite["pdf"],  # the explicit PDF page index as stored, else None: never derived from the locator
        "location_verified": cite["ok"],  # the LOCATION was checked: never "the source / information / claim is verified"
        "provenance": None if origin is None else {"source_id": origin["src"], "locator": {"kind": origin["loc"]["kind"], "text": origin["loc"]["text"]} if origin["loc"]["text"] else None, "pdf": origin["pdf"], "location_verified": origin["ok"]},
    }


def _captured_frozen(kind: str, info: dict, missing: bool) -> dict:
    return {"kind": kind, "metadata": {} if missing else _meta(info), "missing": bool(missing), "locator": None, "pdf": None, "location_verified": None, "provenance": None}


# ---------------------------------------------------------------- current side


def _file_state(root: Path, file_ref: Any) -> tuple[dict, str | None]:
    """``({state, route}, rel)`` through the Phase 8 tri-state probe. ``route`` only for a canonical, existing, confined PDF."""
    if not isinstance(file_ref, str) or not file_ref:
        return {"state": "none", "route": None}, None
    if snaps._rel_file(root, file_ref) is None or not file_ref.lower().endswith(".pdf"):
        return {"state": "unknown", "route": None}, None
    try:
        st = portals._plain_regular(root, file_ref)
    except portals._NonCanonical:
        return {"state": "unknown", "route": None}, None
    except OSError:
        return {"state": "unknown", "route": None}, None
    if st is None:
        return {"state": "missing", "route": None}, file_ref
    return {"state": "ok", "route": "/files/" + portals._quote(file_ref)}, file_ref


def _current(sid: str, root: Path, cache: dict) -> dict:
    editions = portals._sources_by_id(cache)
    if editions is None:
        return {"state": "unknown", "metadata": None, "file": {"state": "unknown", "route": None}}
    ed = editions.get(sid)
    if ed is None:
        return {"state": "missing", "metadata": None, "file": {"state": "none", "route": None}}
    memo = cache.setdefault("files", {})
    if sid not in memo:
        memo[sid] = _file_state(root, ed.get("file_ref"))[0]
    return {"state": "archived" if ed.get("archived") else "available", "metadata": _meta(ed), "file": memo[sid]}


def _differs(captured_meta: dict, current_meta: dict | None) -> list[str]:
    """Server-computed: the fields a captured copy also holds whose value is not the current one (so the UI never infers it)."""
    if current_meta is None:
        return []
    return [k for k in _COMPARE if k in captured_meta and captured_meta.get(k) != current_meta.get(k)]


# ---------------------------------------------------------------- frozen contexts


def _frozen_row(context: dict, sid: str) -> tuple[dict, dict | None, bool, str]:
    """``(captured_info, sealed_file_row, missing, scope)`` of the edition inside the frozen context (scope: snapshot | live).
    Raises on anything untrusted."""
    if context["kind"] == "snapshot":
        got = snaps.get(context["id"])
        if got["integrity"] != "ok":
            raise ValueError("integrity")
        row = next((r for r in got["snapshot"]["refs"]["sources"] if r.get("id") == sid), None)
        if row is None:
            raise LookupError("source")
        return row, row.get("file"), bool(row.get("missing") or row.get("state") != "ok"), "snapshot"
    import hq_carnet_reviews as reviews

    got = reviews.get(context["id"])
    if got["integrity"] != "ok":
        raise ValueError("integrity")
    item = next((i for i in got["review"]["items"] if i["id"] == context["item_id"]), None)
    if item is None or item["kind"] != "source" or item["key"].get("edition_id") != sid:
        raise LookupError("item")
    scope = item["scope"]
    if scope["kind"] != "snapshot":
        return item["copy"], None, False, "live"  # a live-scope item pins METADATA only: there is no file seal to compare
    snap = snaps.get(scope["id"])
    if snap["integrity"] != "ok":
        raise ValueError("integrity")
    row = next((r for r in snap["snapshot"]["refs"]["sources"] if r.get("id") == sid), None)
    if row is None:
        raise LookupError("source")
    return item["copy"], row.get("file"), bool(row.get("missing") or row.get("state") != "ok"), "snapshot"


def _integrity(root: Path, row_info: dict, sealed: dict | None, missing_row: bool, context: dict | None = None, sid: str = "") -> dict:
    """The sealed bytes against the current canonical bytes at the SEALED file reference. Never reconstructs frozen content."""
    out: dict[str, Any] = {"state": "not_applicable", "route": None, "sealed_sha256": None}
    if missing_row or not isinstance(sealed, dict):
        return out
    sha = sealed.get("sha256")
    out["sealed_sha256"] = sha if isinstance(sha, str) else None
    if sealed.get("state") != "ok" or not isinstance(sha, str):
        return out  # the seal recorded no file: there were never bytes to compare
    fr = row_info.get("file_ref")
    fstate, rel = _file_state(root, fr)
    if fstate["state"] == "unknown":
        out["state"] = "unknown"
        return out
    if fstate["state"] != "ok" or rel is None:
        out["state"] = "sealed_file_missing"
        return out
    try:
        got = portals._hash_confined(root, rel)
    except portals._NonCanonical:
        out["state"] = "unknown"
        return out
    except Exception:  # noqa: BLE001
        out["state"] = "unknown"
        return out
    if got is None:
        out["state"] = "sealed_file_missing"
        return out
    out["state"] = "matches_seal" if got[0] == sha else "differs_from_seal"
    if got[0] == sha:
        # The sealed bytes are NOT served from a pathname the browser reopens later: the verified route re-hashes and streams ONE observation.
        out["route"] = verified_route(context, sid) if context is not None else None
    else:
        out["route"] = fstate["route"]  # a deliberately opened CURRENT file; the UI labels it "différent de l'évidence figée"
    return out


# ---------------------------------------------------------------- verified PDF (hash bound to the served bytes)

PDF_SPOOL_MAX = 256 * 1024 * 1024  # a frozen PDF above this is refused rather than buffered; "Ouvrir dans un onglet" is not affected


def verified_route(context: dict, sid: str) -> str:
    """The canonical, path-free route of the verified frozen PDF. Identities only; the server resolves the seal itself."""
    from urllib.parse import quote

    q = (f"snapshot={quote(context['id'], safe='')}" if context["kind"] == "snapshot"
         else f"review={quote(context['id'], safe='')}&item={quote(context['item_id'], safe='')}")
    return "/api/carnet/reader-pdf?" + q + "&source=" + quote(sid, safe="")


class VerifiedPdfError(ReaderError):
    def __init__(self, message: str, status: int, code: str):
        super().__init__(message)
        self.status = status
        self.code = code


def parse_verified_query(qs: dict) -> tuple[dict, str]:
    """``({kind,id[,item_id]}, source_id)`` from the query string; exact key set, canonical ids only."""
    flat = {}
    for k, v in qs.items():
        if not isinstance(v, list) or len(v) != 1 or not isinstance(v[0], str):
            raise VerifiedPdfError("Requête invalide", 400, "validation_error")
        flat[k] = v[0]
    sid = flat.get("source", "")
    if set(flat) == {"snapshot", "source"}:
        ctx = {"kind": "snapshot", "id": flat["snapshot"]}
    elif set(flat) == {"review", "item", "source"}:
        ctx = {"kind": "review", "id": flat["review"], "item_id": flat["item"]}
    else:
        raise VerifiedPdfError("Requête invalide", 400, "validation_error")
    if not isinstance(sid, str) or not rich._EDITION_ID_RE.match(sid):
        raise VerifiedPdfError("Requête invalide", 400, "validation_error")
    try:
        return _check_context(ctx), sid
    except ReaderError:
        raise VerifiedPdfError("Requête invalide", 400, "validation_error") from None


def open_verified_pdf(context: dict, sid: str) -> tuple[Any, int, str]:
    """``(file, size, name)``. The server resolves the TRUSTED seal itself, reads the canonical file once through the descriptor-bound
    confined chain while hashing the same chunks into a spool, and refuses unless the hash equals the seal. The caller streams the SPOOL:
    the pathname is never reopened between verification and streaming. Raises ``VerifiedPdfError``."""
    try:
        info, sealed, missing, _scope = _frozen_row(context, sid)
    except (ValueError, LookupError, KeyError):
        raise VerifiedPdfError("Évidence figée introuvable ou non fiable", 404, "frozen_unavailable") from None
    except OSError:
        raise VerifiedPdfError("Carnet inaccessible", 503, "storage_error") from None
    sha = sealed.get("sha256") if isinstance(sealed, dict) else None
    if missing or not isinstance(sealed, dict) or sealed.get("state") != "ok" or not isinstance(sha, str):
        raise VerifiedPdfError("Aucun fichier scellé", 404, "no_sealed_file")
    root = portals._root()
    fr = info.get("file_ref")
    rel = snaps._rel_file(root, fr) if isinstance(fr, str) else None
    if rel is None or not fr.lower().endswith(".pdf"):
        raise VerifiedPdfError("Fichier scellé introuvable", 404, "sealed_file_missing")
    spool = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)  # noqa: SIM115 - closed by the caller / on every refusal below
    try:
        try:
            got = portals._hash_confined(root, fr, sink=spool, limit=PDF_SPOOL_MAX)
        except portals._NonCanonical:
            raise VerifiedPdfError("Fichier scellé non canonique", 409, "sealed_file_noncanonical") from None
        except portals._TooLarge:
            raise VerifiedPdfError("Fichier scellé trop volumineux pour être vérifié ici", 413, "sealed_file_too_large") from None
        except OSError:
            raise VerifiedPdfError("Fichier scellé illisible", 409, "sealed_file_unreadable") from None
        if got is None:
            raise VerifiedPdfError("Fichier scellé introuvable", 404, "sealed_file_missing")
        if got[0] != sha:
            raise VerifiedPdfError("Le fichier a changé depuis le scellé", 409, "differs_from_seal")
        spool.seek(0)
        name = Path(fr).name
        return spool, got[1], name
    except BaseException:
        spool.close()
        raise


# ---------------------------------------------------------------- one entry


def _unknown(sid: str) -> dict:
    return {
        "source_id": sid, "captured": None,
        "current": {"state": "unknown", "metadata": None, "file": {"state": "unknown", "route": None}},
        "differs": [], "integrity": {"state": "unknown", "route": None, "sealed_sha256": None}, "frozen": None,
    }


def resolve_one(entry: dict, root: Path, cache: dict) -> dict:
    sid = entry["source_id"]
    try:
        cur = _current(sid, root, cache)
        context = entry["context"]
        integrity = {"state": "not_applicable", "route": None, "sealed_sha256": None}
        frozen = None
        captured = None
        if context is not None:
            try:
                info, sealed, missing, scope = _frozen_row(context, sid)
            except (ValueError, LookupError, OSError, KeyError):
                return {**_unknown(sid), "current": cur, "frozen": {"kind": context["kind"], "available": False}}
            captured = _captured_frozen("snapshot" if context["kind"] == "snapshot" else "review_item", info, missing)
            integrity = _integrity(root, info, sealed, missing, context, sid)
            frozen = {"kind": context["kind"], "available": True, "scope": scope}
        if entry["citation"] is not None:
            cited = _captured_citation(entry["citation"])
            if captured is None:
                captured = cited
            else:
                captured["citation"] = cited
        differs = _differs(captured["metadata"], cur["metadata"]) if captured is not None else []
        return {"source_id": sid, "captured": captured, "current": cur, "differs": differs, "integrity": integrity, "frozen": frozen}
    except Exception:  # noqa: BLE001 - failure isolation: this entry alone becomes unknown
        return _unknown(sid)


def resolve(data: Any) -> dict:
    """READ-ONLY. One result per entry, in request order; identical entries are resolved ONCE; the source list is read once."""
    entries = _check_request(data)
    root = portals._root()
    cache: dict = {}
    memo: dict[str, dict] = {}
    results = []
    lookups = 0
    for e in entries:
        key = json.dumps([e["source_id"], e["citation"], e["context"]], sort_keys=True, ensure_ascii=False)
        if key not in memo:
            memo[key] = resolve_one(e, root, cache)
            lookups += 1
        results.append(memo[key])
    return {"ok": True, "read_only": True, "results": results, "resolved": lookups, "limits": {"entries": ENTRIES_MAX}}
