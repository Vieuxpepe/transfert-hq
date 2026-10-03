"""Carnet Phase 8 — portal resolver: a READ-ONLY, bounded, batched window onto objects owned elsewhere.

    A portal block stores only ``{ref: {kind, id}, view}``. This module turns such references into a validated presentation model,
    live, on demand. It never writes anything (no notebook, no source, no review, no snapshot, no file), keeps no cache across
    calls, resolves nothing recursively, and isolates every reference: one broken target is that portal's own ``unknown`` /
    ``missing`` / ``corrupt`` and never affects the others.

    ``portal_resolve`` is a POST only because a 100-reference batch does not fit a GET query string. It is READ-ONLY by
    contract: no revision moves, no history entry, no side effect (pinned by tests).

Canonical owners (this module owns none of them):
    source -> Sources (edition id) · file/model/media -> the file system through the existing reference rules ·
    snapshot -> Snapshots · review -> Review Packs · drawing -> Dessiner (understood here for reports / review freshness only;
    it is NOT a valid portal block kind: the drawing block stays the one drawing embed).

States are explicit text. ``unknown`` (a lookup failed) is never reported as ``missing``.
"""

from __future__ import annotations

import hashlib
import os
import re
import stat as _stat
import urllib.parse
from pathlib import Path
from typing import Any

import hq_carnet_rich as rich
import hq_carnet_snapshots as snaps

REFS_MAX = 100
TITLE_MAX = 240
VALUE_MAX = 240
KINDS = rich.PORTAL_KINDS + ("drawing",)
STATES = ("available", "missing", "unknown", "corrupt", "archived", "anomaly")
_SHA_RE = re.compile(r"^[0-9a-f]{64}\Z")
_IMAGE_EXT = (".jpg", ".jpeg", ".png", ".webp", ".gif")  # what a browser shows safely; heic/video/audio get a metadata card
_DRAWINGS = ("Inbox", "Drawings")

# Fixed, kind-specific vocabulary (French). Never user text.
LABELS: dict[str, dict[str, str]] = {
    "source": {"available": "Disponible", "archived": "Archivée", "missing": "Introuvable", "unknown": "État inconnu"},
    "file": {"available": "Disponible", "missing": "Introuvable", "unknown": "État inconnu"},
    "model": {"available": "Disponible", "missing": "Introuvable", "unknown": "État inconnu"},
    "media": {"available": "Disponible", "missing": "Introuvable", "unknown": "État inconnu"},
    "snapshot": {"available": "Valide", "corrupt": "Altéré", "invalid": "Invalide", "missing": "Introuvable", "unknown": "État inconnu"},
    "review": {"available": "Disponible", "corrupt": "Altéré", "invalid": "Invalide", "missing": "Introuvable", "unknown": "État inconnu"},
    "drawing": {"available": "Disponible", "missing": "Introuvable", "unknown": "État inconnu", "anomaly": "Anomalie d’intégrité"},
}
KIND_LABEL = {**rich.PORTAL_LABEL, "drawing": "Croquis"}
REVIEW_STATUS = {"draft": "Brouillon", "in_review": "En revue", "needs_followup": "À suivre", "reviewed": "Revue terminée"}
SOURCE_TYPE_LABEL_MAX = 40


class PortalError(ValueError):
    status = 400
    code = "validation_error"


def _hc():
    import hq_carnet

    return hq_carnet


def _root() -> Path:
    root = _hc()._cb.get("root")
    if root is None:
        raise RuntimeError("Carnet non initialisé")
    return Path(os.path.abspath(os.fspath(root)))


def _clip(value: Any, limit: int = VALUE_MAX) -> str:
    text = " ".join(str(value if value is not None else "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _row(label: str, value: Any, kind: str = "text") -> dict:
    return {"label": label, "value": value if kind in ("time", "bytes") else _clip(value), "type": kind}


def _result(ref: dict, state: str, **extra: Any) -> dict:
    """The strict, kind-agnostic response row. ``state`` is one of STATES; ``label`` its fixed French text for this kind."""
    kind = ref["kind"]
    integrity = extra.pop("integrity", None)
    labels = LABELS[kind]
    label_key = extra.pop("label_key", state)
    out = {
        "ref": {"kind": kind, "id": ref["id"]},
        "kind_label": KIND_LABEL[kind],
        "state": state,
        "state_label": labels.get(label_key, labels["unknown"]),
        "title": _clip(extra.pop("title", ref["id"]), TITLE_MAX),
        "subtitle": _clip(extra.pop("subtitle", ""), TITLE_MAX),
        "metadata": extra.pop("metadata", []),
        "actions": extra.pop("actions", []),
        "integrity": integrity,
        "thumb_url": extra.pop("thumb_url", None),
        "open_url": extra.pop("open_url", None),
    }
    if extra:
        out.update(extra)
    return out


def _unknown(ref: dict, reason: str) -> dict:
    return _result(ref, "unknown", subtitle=ref["id"], metadata=[_row("Raison", reason)], actions=[])


# ---------------------------------------------------------------- per-kind resolution (each one read-only)


class _NonCanonical(Exception):
    """The path exists but is not a plain regular file under the HQ root (symlink / junction / directory / escaping or redirected parent)."""


def _plain_regular(root: Path, rel: str) -> os.stat_result | None:
    """Tri-state probe, never following an unsafe target. Returns the ``lstat`` of a canonical regular file; returns None ONLY for a
    genuinely absent path (missing file or missing parent); raises ``_NonCanonical`` for a symlink / junction / reparse point /
    directory / non-regular file or a path whose parents redirect elsewhere (state ``unknown``, never ``missing``); raises OSError for
    any other lookup failure (also ``unknown``). The redirected target is never opened or read."""
    parts = rel.split("/")
    cur = root
    for part in parts[:-1]:  # the parent chain is validated BEFORE a missing leaf can be called "missing"; nothing is ever followed
        cur = cur / part
        try:
            pst = os.lstat(cur)
        except (FileNotFoundError, NotADirectoryError):
            return None  # every earlier component was a canonical directory: this is genuine absence
        if _stat.S_ISLNK(pst.st_mode) or not _stat.S_ISDIR(pst.st_mode) or getattr(pst, "st_file_attributes", 0) & 0x400:
            raise _NonCanonical(rel)  # symlink (also a broken one), junction / reparse point, or a non-directory in the middle
    path = root / rel
    try:
        st = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return None
    if _stat.S_ISLNK(st.st_mode) or not _stat.S_ISREG(st.st_mode) or getattr(st, "st_file_attributes", 0) & 0x400:
        raise _NonCanonical(rel)
    try:
        resolved = path.resolve()
        base = root.resolve()
    except (OSError, RuntimeError) as err:
        raise _NonCanonical(rel) from err
    if resolved != base.joinpath(*rel.split("/")):  # any redirected parent (inside or outside the root) is non-canonical
        raise _NonCanonical(rel)
    return st


_CONFINED = bool(getattr(os, "O_NOFOLLOW", 0) and getattr(os, "O_DIRECTORY", 0) and os.open in getattr(os, "supports_dir_fd", ()))


def _identity(st: os.stat_result) -> tuple:
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns)


def _hash_confined(root: Path, rel: str) -> tuple[str, int] | None:
    """``(sha256, size)`` of ``rel`` below ``root``, bound to the SAME directory / file objects that were validated.
    POSIX: every component is opened with ``O_NOFOLLOW`` relative to the previous directory handle (``dir_fd``) and the file is
    read through its own handle, so a parent swapped for a symlink after any earlier probe is simply never followed.
    Elsewhere (no ``dir_fd`` / ``O_NOFOLLOW``): probe, hash, then re-probe and compare identity; any change -> OSError (``unknown``);
    that fallback narrows the race but cannot make "never opened beyond a redirect" absolute.
    None = genuinely absent; ``_NonCanonical`` = redirected / non-regular; OSError = any other failure or a change while reading."""
    parts = rel.split("/")
    if not _CONFINED:
        before = _plain_regular(root, rel)
        if before is None:
            return None
        got = snaps.hash_file(root / rel)
        after = _plain_regular(root, rel)
        if got is None or after is None or _identity(before) != _identity(after):
            raise OSError("cible modifiée pendant la lecture")
        return got
    dflags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fds: list[int] = []
    try:
        cur = os.open(root, os.O_RDONLY | os.O_DIRECTORY)  # the HQ root itself is trusted
        fds.append(cur)
        for part in parts[:-1]:
            try:
                cur = os.open(part, dflags, dir_fd=cur)
            except FileNotFoundError:
                return None
            except OSError as err:  # ELOOP (symlink), ENOTDIR (not a directory, or a redirected one)
                raise _NonCanonical(rel) from err
            fds.append(cur)
        try:
            ffd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_BINARY", 0), dir_fd=cur)
        except FileNotFoundError:
            return None
        except OSError as err:
            raise _NonCanonical(rel) from err
        fds.append(ffd)
        st = os.fstat(ffd)
        if not _stat.S_ISREG(st.st_mode):
            raise _NonCanonical(rel)
        if st.st_size > snaps.HASH_FILE_MAX:
            raise OSError("fichier trop volumineux")
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(ffd, 1 << 20)
            if not chunk:
                break
            total += len(chunk)
            if total > snaps.HASH_FILE_MAX:
                raise OSError("fichier trop volumineux")
            digest.update(chunk)
        end = os.fstat(ffd)
        if _identity(end) != _identity(st) or total != st.st_size:
            raise OSError("cible modifiée pendant la lecture")
        return digest.hexdigest(), total
    finally:
        for fd in fds:
            try:
                os.close(fd)
            except OSError:
                pass


def _quote(rel: str) -> str:
    return "/".join(urllib.parse.quote(part, safe="") for part in rel.split("/"))


def _file_like(ref: dict, root: Path) -> dict:
    rel = ref["id"]
    name = rel.rsplit("/", 1)[-1]
    ext = os.path.splitext(name)[1].lower().lstrip(".").upper()
    try:
        st = _plain_regular(root, rel)
    except _NonCanonical:
        return _unknown(ref, "cible non canonique (lien, dossier ou chemin redirigé)")
    except OSError:
        return _unknown(ref, "lecture impossible")
    if st is None:
        return _result(ref, "missing", title=name, subtitle=rel, metadata=[_row("Chemin", rel)], actions=[])
    meta = [_row("Chemin", rel), _row("Type", ext or "—"), _row("Taille", st.st_size, "bytes")]
    kind = ref["kind"]
    thumb = "/files/" + _quote(rel) if kind == "media" and rel.lower().endswith(_IMAGE_EXT) else None
    return _result(ref, "available", title=name, subtitle=rel, metadata=meta, actions=["open", "inspect"], thumb_url=thumb, open_url="/files/" + _quote(rel))


def _drawing(ref: dict, root: Path, expect_sha: str | None) -> dict:
    stem = ref["id"]
    rel = "/".join(_DRAWINGS + (stem + ".hqdraw.json",))
    try:
        st = _plain_regular(root, rel)
    except _NonCanonical:
        return _unknown(ref, "cible non canonique (lien, dossier ou chemin redirigé)")
    except OSError:
        return _unknown(ref, "lecture impossible")
    if st is None:
        return _result(ref, "missing", title=rich.drawing_label(stem), subtitle=stem, metadata=[_row("Identifiant", stem)], actions=[])
    state, key = "available", "available"
    meta = [_row("Identifiant", stem), _row("Taille", st.st_size, "bytes")]
    if expect_sha is not None:  # an anomaly is only ever claimed against a seal that SOMETHING ELSE owns (a snapshot, a review item)
        try:
            got = _hash_confined(root, rel)  # validation and hashing are bound to the same handles (no re-resolution of the path)
        except _NonCanonical:
            return _unknown(ref, "cible non canonique (lien, dossier ou chemin redirigé)")
        except Exception:  # noqa: BLE001
            return _unknown(ref, "lecture impossible")
        if got is None:
            return _result(ref, "missing", title=rich.drawing_label(stem), subtitle=stem, metadata=meta, actions=[])
        if got[0] != expect_sha:
            state, key = "anomaly", "anomaly"
            meta.append(_row("Intégrité", "Les octets ne correspondent plus au sceau attendu"))
    return _result(ref, state, title=rich.drawing_label(stem), subtitle=stem, metadata=meta, actions=["open", "inspect"], label_key=key)


def _sources_by_id(cache: dict) -> dict | None:
    if "sources" not in cache:
        import hq_carnet_review as review

        cache["sources"] = review._editions()  # None when sources.json is unreadable: every source portal is then "unknown"
    return cache["sources"]


def _source(ref: dict, root: Path, cache: dict) -> dict:
    editions = _sources_by_id(cache)
    if editions is None:
        return _unknown(ref, "sources inaccessibles")
    ed = editions.get(ref["id"])
    if ed is None:
        return _result(ref, "missing", subtitle=ref["id"], metadata=[_row("Identifiant", ref["id"])], actions=[])
    meta = [_row("Identifiant", ed["id"])]
    for label, key in (("Auteur", "author"), ("Édition", "edition"), ("Année", "year"), ("Éditeur", "publisher"), ("Référence", "identifier"), ("Type", "type")):
        if ed.get(key) not in (None, ""):
            meta.append(_row(label, ed[key]))
    fr = ed.get("file_ref")
    if isinstance(fr, str) and fr:
        try:
            meta.append(_row("Fichier PDF", "Disponible" if _plain_regular(root, fr) is not None else "Introuvable"))
        except (OSError, _NonCanonical):
            meta.append(_row("Fichier PDF", "État inconnu"))
    if ed.get("superseded_by"):
        meta.append(_row("Remplacée par", ed["superseded_by"]))
    archived = bool(ed.get("archived"))
    state = "archived" if archived else "available"
    return _result(ref, state, title=ed.get("title") or ed["id"], subtitle=_clip(" · ".join(x for x in (str(ed.get("edition") or ""), str(ed.get("year") or "")) if x)), metadata=meta, actions=["open", "inspect"])


def _snapshot_storage_state(e: Exception) -> str:
    return "invalid" if str(e).startswith("Jalon invalide") else "unknown"


def _snapshot(ref: dict, cache: dict) -> dict:
    try:
        got = snaps.get(ref["id"])
    except snaps.SnapshotNotFound:
        return _result(ref, "missing", subtitle=ref["id"], metadata=[_row("Identifiant", ref["id"])], actions=[])
    except snaps.SnapshotStorageError as e:
        if _snapshot_storage_state(e) == "invalid":
            return _result(ref, "corrupt", label_key="invalid", subtitle=ref["id"], metadata=[_row("Identifiant", ref["id"])], integrity="invalid", actions=[])
        return _unknown(ref, "stockage inaccessible")
    except snaps.SnapshotError:
        return _unknown(ref, "lecture impossible")
    if got["integrity"] != "ok":  # an altered seal is NEVER presented as trusted frozen evidence: no summary is shown
        return _result(ref, "corrupt", subtitle=ref["id"], metadata=[_row("Identifiant", ref["id"])], integrity=got["integrity"], actions=["inspect"])
    snap = got["snapshot"]
    h = snaps.header(snap, "ok")
    meta = [_row("Projet", h["project_name"]), _row("Figé le", h["created_at"], "time"), _row("Pages", h["pages"]), _row("Identifiant", h["id"])]
    return _result(ref, "available", title=h["label"], subtitle=h["project_name"], metadata=meta, integrity="ok", actions=["open", "inspect"])


def _project_name(cache: dict, project_id: str) -> str:
    if "projects" not in cache:
        try:
            import hq_carnet_review as review

            cache["projects"] = {p["id"]: p["name"] for p in review._load_state()["projects"]}
        except Exception:  # noqa: BLE001
            cache["projects"] = {}
    return cache["projects"].get(project_id, project_id)


def _review(ref: dict, cache: dict, detail: bool) -> dict:
    import hq_carnet_reviews as reviews

    try:
        got = reviews.get(ref["id"])
    except reviews.ReviewNotFound:
        return _result(ref, "missing", subtitle=ref["id"], metadata=[_row("Identifiant", ref["id"])], actions=[])
    except reviews.ReviewStorageError as e:
        if str(e).startswith("Revue invalide"):
            return _result(ref, "corrupt", label_key="invalid", subtitle=ref["id"], metadata=[_row("Identifiant", ref["id"])], integrity="invalid", actions=[])
        return _unknown(ref, "stockage inaccessible")
    except reviews.ReviewError:
        return _unknown(ref, "lecture impossible")
    pack = got["review"]
    if got["integrity"] != "ok":  # the pack's contents are not trusted: only its identity is shown
        return _result(ref, "corrupt", subtitle=ref["id"], metadata=[_row("Identifiant", ref["id"])], integrity=got["integrity"], actions=["inspect"])
    checked = sum(1 for c in pack["checklist"] if c["checked"])
    meta = [
        _row("Projet", _project_name(cache, pack["project_id"])),
        _row("Statut", REVIEW_STATUS.get(pack["status"], pack["status"])),
        _row("Révision", pack["rev"]),
        _row("Éléments de preuve", len(pack["items"])),
        _row("Liste de contrôle", f"{checked}/{len(pack['checklist'])}"),
        _row("Questions", len(pack["questions"])),
        _row("Identifiant", pack["id"]),
    ]
    out = _result(ref, "available", title=pack["title"], subtitle=REVIEW_STATUS.get(pack["status"], pack["status"]), metadata=meta, integrity="ok", actions=["open", "inspect"])
    if detail:  # the freshness summary is observed live (never stored) and only for a single, inspected reference
        import hq_carnet_evidence as evidence

        try:
            fresh = evidence.freshness(pack)
            counts = {k: fresh["counts"].get(k, 0) for k in ("unchanged", "changed", "missing", "unknown")}
            out["freshness"] = counts
        except Exception:  # noqa: BLE001
            out["freshness"] = None
    return out


# ---------------------------------------------------------------- the batch


def _check_request(data: Any) -> tuple[list[dict], bool]:
    """Exact schema: ``{action, refs:[{kind,id[,expect_sha256 (drawing only)]}], detail?: bool (one ref only)}``."""
    if not isinstance(data, dict) or not set(data) <= {"action", "refs", "detail"} or "refs" not in data:
        raise PortalError("Requête de portail invalide")
    refs = data["refs"]
    if not isinstance(refs, list) or not refs or len(refs) > REFS_MAX:
        raise PortalError(f"Entre 1 et {REFS_MAX} références")
    detail = data.get("detail", False)
    if not isinstance(detail, bool) or (detail and len(refs) != 1):
        raise PortalError("Requête de portail invalide")
    out = []
    for raw in refs:
        if not isinstance(raw, dict) or not {"kind", "id"} <= set(raw) or not set(raw) <= {"kind", "id", "expect_sha256"}:
            raise PortalError("Référence de portail invalide")
        expect = raw.get("expect_sha256")
        if "expect_sha256" in raw and (raw["kind"] != "drawing" or not isinstance(expect, str) or not _SHA_RE.match(expect)):
            raise PortalError("Référence de portail invalide")
        kind = raw["kind"]
        if kind == "drawing":
            if not isinstance(raw["id"], str) or not rich._STEM_RE.match(raw["id"]):
                raise PortalError("Référence de portail invalide")
            clean = {"kind": "drawing", "id": raw["id"]}
        else:
            try:
                clean = rich.check_portal({"ref": {"kind": kind, "id": raw["id"]}, "view": "card"}, None)["ref"]
            except rich.ContentError as e:
                raise PortalError("Référence de portail invalide") from e
        if expect is not None:
            clean["expect_sha256"] = expect
        out.append(clean)
    return out, detail


def resolve_one(ref: dict, root: Path, cache: dict, detail: bool = False) -> dict:
    kind = ref["kind"]
    try:
        if kind in ("file", "model", "media"):
            return _file_like(ref, root)
        if kind == "drawing":
            return _drawing(ref, root, ref.get("expect_sha256"))
        if kind == "source":
            return _source(ref, root, cache)
        if kind == "snapshot":
            return _snapshot(ref, cache)
        return _review(ref, cache, detail)
    except Exception:  # noqa: BLE001 - failure isolation: this portal alone becomes "unknown"
        return _unknown({"kind": kind, "id": ref["id"]}, "résolution impossible")


def resolve(data: Any) -> dict:
    """READ-ONLY. One result per requested reference, in request order; identical references are resolved ONCE."""
    refs, detail = _check_request(data)
    root = _root()
    cache: dict = {}
    memo: dict[tuple, dict] = {}
    results = []
    lookups = 0
    for ref in refs:
        key = (ref["kind"], ref["id"], ref.get("expect_sha256"))
        if key not in memo:
            memo[key] = resolve_one(ref, root, cache, detail)
            lookups += 1
        results.append(memo[key])
    return {"ok": True, "read_only": True, "results": results, "resolved": lookups, "limits": {"refs": REFS_MAX, "title": TITLE_MAX}}
