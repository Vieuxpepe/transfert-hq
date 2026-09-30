"""Carnet Stage 05: engineering sources (families + editions), stored apart from the notebook.

Runtime state lives at ``<ROOT>/.hq-carnet/sources.json`` (own file, own revisions):

- a source FAMILY (e.g. "Machinery's Handbook") groups EDITIONS (29th, 30th, ...);
- an EDITION is the unit citations point to. It is never mutated into another edition:
  ``edition`` label, ``year`` and ``family_id`` are immutable; a newer edition is a NEW record and
  the old one gets ``superseded_by`` (explicit) — old citations stay correct forever;
- nothing is ever deleted: archive/tombstone only, so a historical citation can never dangle;
- every record has its own ``rev`` (optimistic concurrency, 409 on stale updates); the file-level
  ``sources_rev`` only counts changes. Sources never touch ``notebook_rev`` or any page ``rev``.

A local PDF is a CONFINED relative reference (``Inbox|Uni|Print/.../x.pdf``), validated with the
same rules as HQ files and checked on disk without following links; absolute paths, ``..``, drive
letters, UNC/backslash tricks and symlink/junction escapes are refused, and no filesystem path is
ever put in an error message. Calibration maps a semantic (printed) page to the actual PDF page
index only through an explicit, user-defined pair (printed N == PDF page M); it is never inferred.

Writes go through ``hq_state.write_json_atomic`` under ``hq_state.path_lock``; a malformed or
unsupported file is preserved (never repaired, never overwritten). Source text never goes to logs.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
import unicodedata
from pathlib import Path
from typing import Any

import hq_carnet_rich as rich
import hq_state

DIR_NAME = ".hq-carnet"
FILE_NAME = "sources.json"
VERSION = 1

FAMILIES_MAX = 500
EDITIONS_MAX = 2000
NAME_MAX = 120
TITLE_MAX = 200
AUTHOR_MAX = 120
EDITION_MAX = 40
PUBLISHER_MAX = 120
IDENT_MAX = 60
URL_MAX = 2048
NOTES_MAX = 2000
PROJECT_IDS_MAX = 32
FILE_REF_MAX = 400
PAGE_MAX = 100000
YEAR_MIN, YEAR_MAX = 1400, 2200

TYPES = ("book", "standard", "article", "datasheet", "catalogue", "procedure", "web", "other")
LOCATOR_KINDS = ("page", "section", "clause", "chapter", "figure", "table", "custom")

ACTIONS = (
    "source_family_create",
    "source_family_update",
    "source_family_archive",
    "source_edition_create",
    "source_edition_update",
    "source_edition_archive",
    "source_edition_supersede",
    "source_edition_calibrate",
)

_ID_RE = {
    "srcf": re.compile(r"^srcf-[A-Za-z0-9_-]{1,64}\Z"),
    "srce": re.compile(r"^srce-[A-Za-z0-9_-]{1,64}\Z"),
    "proj": re.compile(r"^proj-[A-Za-z0-9_-]{1,64}\Z"),
}
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f-\x9f]")

_cb: dict[str, Any] = {}


class SourceError(ValueError):
    status = 400
    code = "validation_error"


class SourceNotFound(SourceError):
    status = 404
    code = "not_found"


class SourceConflict(RuntimeError):
    status = 409

    def __init__(self, payload: dict):
        super().__init__(str(payload.get("error") or "Conflit"))
        self.payload = payload


class SourceStorageError(RuntimeError):
    code = "storage_error"

    def __init__(self, message: str, status: int = 409):
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
        raise SourceStorageError("Carnet non initialisé", 503)
    return Path(os.path.abspath(os.fspath(root)))


def _folders() -> tuple[str, ...]:
    fn = _cb.get("folders")
    try:
        got = tuple(str(x) for x in fn()) if callable(fn) else ()
    except Exception:
        got = ()
    return got or ("Inbox", "Uni", "Print")


def _system_names() -> frozenset[str]:
    try:
        return frozenset(str(x).lower() for x in (_cb.get("system_names") or ()))
    except TypeError:
        return frozenset()


# ---------------------------------------------------------------- confined storage path


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    junction = getattr(os.path, "isjunction", None)
    return bool(junction and junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


_ESCAPED = "Emplacement des sources redirigé — refusé, fichier conservé"


def sources_path(root: Path | str | None = None) -> Path:
    base = Path(os.path.abspath(os.fspath(root if root is not None else _root())))
    return base / DIR_NAME / FILE_NAME


def confined_path(root: Path | str | None = None) -> Path:
    """``sources_path`` after refusing any redirection (symlink/junction) of the folder, file or tmp."""
    path = sources_path(root)
    base = path.parent
    try:
        real_base = os.path.join(os.path.realpath(base.parent), DIR_NAME)
        if _is_link(base) or not _same(os.path.realpath(base), real_base):
            raise SourceStorageError(_ESCAPED)
        for name in (FILE_NAME, FILE_NAME + ".tmp"):
            item = base / name
            if _is_link(item) or not _same(os.path.realpath(item), os.path.join(real_base, name)):
                raise SourceStorageError(_ESCAPED)
    except OSError as e:
        raise SourceStorageError("Sources inaccessibles", 503) from e
    return path


# ---------------------------------------------------------------- field validation


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _text(value: Any, limit: int, label: str, *, required: bool = False, multiline: bool = False) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise SourceError(f"{label} invalide")
    out = value.strip() if multiline else rich.norm_ws(re.sub(r"[\t\n\r\x0b\x0c]+", " ", value))  # ASCII line/tab whitespace folds as before
    if required and not out:
        raise SourceError(f"{label} requis")
    if (_CTRL_RE.search(out.replace("\n", "")) if multiline else _CTRL_RE.search(out)) or (multiline and "\r" in out):
        raise SourceError(f"{label} invalide")
    try:
        out.encode("utf-8")
    except UnicodeEncodeError as e:
        raise SourceError(f"{label} invalide") from e
    out = unicodedata.normalize("NFC", out)
    if rich.u16_len(out) > limit:  # UTF-16 units, the unit the notes (JS and server) use for citation snapshots
        raise SourceError(f"{label} trop long (max {limit})")
    return out


def _year(value: Any) -> int | None:
    if value is None or value == "":
        return None
    if not _is_int(value) or not (YEAR_MIN <= value <= YEAR_MAX):
        raise SourceError("Année invalide")
    return value


def _url(value: Any) -> str:
    if value is None or value == "":
        return ""
    try:
        return rich.safe_href(value)  # http/https only, never fetched
    except rich.ContentError as e:
        raise SourceError("URL non autorisée (http/https uniquement)") from e


def _project_ids(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > PROJECT_IDS_MAX:
        raise SourceError("Projets invalides")
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not _ID_RE["proj"].match(item):
            raise SourceError("Projets invalides")
        if item not in out:
            out.append(item)
    return out


def check_file_ref(ref: Any, *, must_exist: bool = True) -> str:
    """Validate a confined relative PDF reference; optionally require it to exist as a plain file.

    Structural rules are the HQ ones (root folder, no dot/system names, no ``..``/backslash/drive
    letter/UNC/percent tricks). The disk check walks the path below the real ROOT one component at a
    time and refuses links/junctions and any component that resolves elsewhere. Errors never carry
    a path.
    """
    if ref is None or ref == "":
        return ""
    if not isinstance(ref, str) or len(ref) > FILE_REF_MAX or not ref.lower().endswith(".pdf"):
        raise SourceError("Référence PDF invalide")
    try:
        rich._valid_rel(ref, _folders(), _system_names())
    except rich.ContentError as e:
        raise SourceError("Référence PDF invalide") from e
    if must_exist and _file_state(ref) != "ok":
        raise SourceError("Fichier PDF introuvable ou non sûr")
    return ref


def _file_state(ref: str) -> str:
    """``ok`` | ``missing`` | ``unsafe`` for a structurally valid reference (never raises)."""
    try:
        cur = _root()
        real_cur = os.path.realpath(cur)
        parts = ref.split("/")
        for index, part in enumerate(parts):
            nxt = cur / part
            if not os.path.lexists(nxt):
                return "missing"
            if _is_link(nxt):
                return "unsafe"
            real_nxt = os.path.realpath(nxt)
            if not _same(real_nxt, os.path.join(real_cur, part)):
                return "unsafe"
            if index < len(parts) - 1 and not nxt.is_dir():
                return "missing"
            cur, real_cur = nxt, real_nxt
        return "ok" if cur.is_file() else "missing"
    except (OSError, SourceStorageError):
        return "missing"


def check_calibration(value: Any) -> dict | None:
    """``{printed, pdf}``: printed page N is PDF page index M (1-based). Explicit pair only."""
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {"printed", "pdf"}:
        raise SourceError("Calibration invalide")
    printed, pdf = value["printed"], value["pdf"]
    if not _is_int(printed) or not _is_int(pdf) or not (1 <= printed <= PAGE_MAX) or not (1 <= pdf <= PAGE_MAX):
        raise SourceError("Calibration invalide")
    return {"printed": printed, "pdf": pdf}


def resolve_pdf_page(edition: dict, locator: dict, pdf: int | None = None) -> int | None:
    """Actual PDF page for a citation: the explicit index, else the calibrated printed page, else None.

    Deterministic and conservative: only a numeric ``page`` locator can be mapped, and only through
    the edition's explicit calibration; the result must be a valid page. Never guessed.
    """
    if pdf is not None:
        return pdf
    cal = edition.get("calibration")
    if not cal or locator.get("kind") != "page":
        return None
    text = str(locator.get("text") or "").strip()
    if not (text.isascii() and text.isdigit()):
        return None
    page = int(text) + (cal["pdf"] - cal["printed"])
    return page if 1 <= page <= PAGE_MAX else None


# ---------------------------------------------------------------- persisted shape


_TOP = {"version", "sources_rev", "families", "editions"}
_FAMILY = {"id", "name", "rev", "archived", "created_at", "updated_at"}
_EDITION = {
    "id", "family_id", "rev", "type", "title", "author", "edition", "year", "publisher", "identifier", "url",
    "file_ref", "notes", "archived", "superseded_by", "project_ids", "calibration", "created_at", "updated_at",
}


def _num(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value


def _usable(data: Any) -> bool:
    try:
        if not isinstance(data, dict) or set(data) != _TOP or data["version"] != VERSION:
            return False
        if not _is_int(data["sources_rev"]) or data["sources_rev"] < 1:
            return False
        families, editions = data["families"], data["editions"]
        if not isinstance(families, list) or not isinstance(editions, list):
            return False
        if len(families) > FAMILIES_MAX or len(editions) > EDITIONS_MAX:
            return False
        seen: set[str] = set()
        fam_ids: set[str] = set()
        for fam in families:
            if not isinstance(fam, dict) or set(fam) != _FAMILY or not isinstance(fam["id"], str):
                return False
            if not _ID_RE["srcf"].match(fam["id"]) or fam["id"] in seen:
                return False
            seen.add(fam["id"])
            fam_ids.add(fam["id"])
            if not isinstance(fam["name"], str) or not fam["name"] or rich.u16_len(fam["name"]) > NAME_MAX:
                return False
            if not _is_int(fam["rev"]) or fam["rev"] < 1 or not isinstance(fam["archived"], bool):
                return False
            if not _num(fam["created_at"]) or not _num(fam["updated_at"]):
                return False
        ed_ids = {e.get("id") for e in editions if isinstance(e, dict)}
        for ed in editions:
            if not isinstance(ed, dict) or set(ed) != _EDITION or not isinstance(ed["id"], str):
                return False
            if not _ID_RE["srce"].match(ed["id"]) or ed["id"] in seen:
                return False
            seen.add(ed["id"])
            if ed["family_id"] not in fam_ids or not _is_int(ed["rev"]) or ed["rev"] < 1:
                return False
            if ed["type"] not in TYPES or not isinstance(ed["archived"], bool):
                return False
            for key, limit in (("title", TITLE_MAX), ("author", AUTHOR_MAX), ("edition", EDITION_MAX), ("publisher", PUBLISHER_MAX),
                               ("identifier", IDENT_MAX), ("url", URL_MAX), ("file_ref", FILE_REF_MAX), ("notes", NOTES_MAX)):
                if not isinstance(ed[key], str) or rich.u16_len(ed[key]) > limit:
                    return False
            if not ed["title"]:
                return False
            if ed["year"] is not None and (not _is_int(ed["year"]) or not (YEAR_MIN <= ed["year"] <= YEAR_MAX)):
                return False
            if ed["url"]:
                rich.safe_href(ed["url"])
            if ed["file_ref"]:
                rich._valid_rel(ed["file_ref"], None, frozenset())  # structural only: a later config change never poisons the file
                if not ed["file_ref"].lower().endswith(".pdf"):
                    return False
            sup = ed["superseded_by"]
            if sup is not None and (not isinstance(sup, str) or sup not in ed_ids or sup == ed["id"]):
                return False
            pids = ed["project_ids"]
            if not isinstance(pids, list) or len(pids) > PROJECT_IDS_MAX or any(not isinstance(x, str) or not _ID_RE["proj"].match(x) for x in pids):
                return False
            if ed["calibration"] is not None and check_calibration(ed["calibration"]) != ed["calibration"]:
                return False
            if not _num(ed["created_at"]) or not _num(ed["updated_at"]):
                return False
        by_id = {e["id"]: e for e in editions}
        for ed in editions:  # supersession graph: same family, live target, no cycle
            sup = ed["superseded_by"]
            if sup is None:
                continue
            target = by_id[sup]
            if target["family_id"] != ed["family_id"] or target["archived"]:
                return False
            seen_ids = {ed["id"]}
            cursor = target
            while cursor is not None:
                if cursor["id"] in seen_ids:
                    return False
                seen_ids.add(cursor["id"])
                nxt = cursor["superseded_by"]
                cursor = by_id.get(nxt) if nxt else None
        return True
    except (SourceError, rich.ContentError, KeyError, TypeError):
        return False


def _read_state() -> tuple[dict | None, str | None]:
    path = confined_path()
    try:
        is_file, exists = path.is_file(), os.path.lexists(path)
    except OSError:
        return None, "sources.json inaccessible — fichier conservé"
    if not is_file:
        return None, ("sources.json n'est pas un fichier — conservé" if exists else None)
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):  # JSONDecodeError is a ValueError; so is the int-digits limit
        return None, "sources.json illisible — fichier conservé"
    if isinstance(raw, dict) and raw.get("version") != VERSION:
        return None, "sources.json version non prise en charge — fichier conservé"
    if not _usable(raw):
        return None, "sources.json illisible — fichier conservé"
    return raw, None


def _empty() -> dict:
    return {"version": VERSION, "sources_rev": 1, "families": [], "editions": []}


def _load_locked() -> dict:
    state, problem = _read_state()
    if problem:
        raise SourceStorageError(problem)
    return state if state is not None else _empty()


def _write(state: dict) -> None:
    path = confined_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(path, state)
    except RuntimeError as e:
        raise SourceStorageError(str(e)) from e
    except OSError as e:
        raise SourceStorageError("Écriture des sources impossible — dernière version conservée", 503) from e


def _copy(obj: Any) -> Any:
    return json.loads(json.dumps(obj, ensure_ascii=False))


def _new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(12)}"


# ---------------------------------------------------------------- reads


def _public_edition(ed: dict) -> dict:
    out = _copy(ed)
    out["file_state"] = _file_state(ed["file_ref"]) if ed["file_ref"] else None
    return out


def get_sources() -> dict:
    with hq_state.path_lock(confined_path()):
        state = _load_locked()
    return {
        "ok": True,
        "version": VERSION,
        "sources_rev": state["sources_rev"],
        "families": _copy(state["families"]),
        "editions": [_public_edition(e) for e in state["editions"]],
        "limits": limits(),
    }


def limits() -> dict:
    return {
        "families": FAMILIES_MAX, "editions": EDITIONS_MAX, "title": TITLE_MAX, "notes": NOTES_MAX,
        "types": list(TYPES), "locator_kinds": list(LOCATOR_KINDS), "page_max": PAGE_MAX,
    }


# ---------------------------------------------------------------- helpers


def _only(data: dict, allowed: set[str]) -> None:
    extra = set(data) - allowed
    if extra:
        raise SourceError("Champ non autorisé : " + ", ".join(sorted(str(k)[:40] for k in extra)))


def _req_id(data: dict, key: str, kind: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not _ID_RE[kind].match(value):
        raise SourceError(f"{key} invalide")
    return value


def _req_rev(data: dict, key: str = "expected_rev") -> int:
    value = data.get(key)
    if not _is_int(value) or value < 1:
        raise SourceError(f"{key} requis")
    return value


def _find(items: list[dict], item_id: str, label: str) -> dict:
    for item in items:
        if item["id"] == item_id:
            return item
    raise SourceNotFound(f"{label} introuvable")


def _check_rev(state: dict, record: dict, expected: int, kind: str) -> None:
    if expected != record["rev"]:
        payload = {"error": "Source modifiée ailleurs", "code": "source_revision_conflict", "kind": kind, "sources_rev": state["sources_rev"]}
        payload["record"] = _public_edition(record) if kind == "edition" else _copy(record)
        raise SourceConflict(payload)


def _bump(state: dict, record: dict, now: float) -> None:
    record["rev"] += 1
    record["updated_at"] = now
    state["sources_rev"] += 1


def _fold(s: str) -> str:
    return unicodedata.normalize("NFKD", s).casefold()


# ---------------------------------------------------------------- actions


def _family_create(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "name"})
    name = _text(data.get("name"), NAME_MAX, "Nom de famille", required=True)
    if len(state["families"]) >= FAMILIES_MAX:
        raise SourceError(f"Trop de familles (max {FAMILIES_MAX})")
    if any(_fold(f["name"]) == _fold(name) for f in state["families"]):
        raise SourceError("Famille déjà existante")
    fam = {"id": _new_id("srcf"), "name": name, "rev": 1, "archived": False, "created_at": now, "updated_at": now}
    state["families"].append(fam)
    state["sources_rev"] += 1
    return {"family": fam}


def _family_update(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "id", "expected_rev", "name"})
    fam = _find(state["families"], _req_id(data, "id", "srcf"), "Famille")
    expected = _req_rev(data)
    _check_rev(state, fam, expected, "family")  # a stale write is a conflict whatever else is wrong with it
    name = _text(data.get("name"), NAME_MAX, "Nom de famille", required=True)
    if any(f is not fam and _fold(f["name"]) == _fold(name) for f in state["families"]):
        raise SourceError("Famille déjà existante")
    fam["name"] = name
    _bump(state, fam, now)
    return {"family": fam}


def _family_archive(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "id", "expected_rev", "archived"})
    fam = _find(state["families"], _req_id(data, "id", "srcf"), "Famille")
    expected = _req_rev(data)
    _check_rev(state, fam, expected, "family")
    if not isinstance(data.get("archived"), bool):
        raise SourceError("archived invalide")
    fam["archived"] = data["archived"]
    _bump(state, fam, now)
    return {"family": fam}


_EDIT_KEYS = {"type", "title", "author", "publisher", "identifier", "url", "file_ref", "notes", "project_ids"}


def _apply_edit(ed: dict, data: dict) -> None:
    if "type" in data:
        if data["type"] not in TYPES:
            raise SourceError("Type de source invalide")
        ed["type"] = data["type"]
    if "title" in data:
        ed["title"] = _text(data["title"], TITLE_MAX, "Titre", required=True)
    if "author" in data:
        ed["author"] = _text(data["author"], AUTHOR_MAX, "Auteur")
    if "publisher" in data:
        ed["publisher"] = _text(data["publisher"], PUBLISHER_MAX, "Éditeur")
    if "identifier" in data:
        ed["identifier"] = _text(data["identifier"], IDENT_MAX, "Identifiant")
    if "url" in data:
        ed["url"] = _url(data["url"])
    if "file_ref" in data:
        ed["file_ref"] = check_file_ref(data["file_ref"])
    if "notes" in data:
        ed["notes"] = _text(data["notes"], NOTES_MAX, "Notes", multiline=True)
    if "project_ids" in data:
        ed["project_ids"] = _project_ids(data["project_ids"])


def _edition_create(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "family_id", "edition", "year"} | _EDIT_KEYS)
    fam = _find(state["families"], _req_id(data, "family_id", "srcf"), "Famille")
    if len(state["editions"]) >= EDITIONS_MAX:
        raise SourceError(f"Trop d'éditions (max {EDITIONS_MAX})")
    label = _text(data.get("edition"), EDITION_MAX, "Édition")
    if any(e["family_id"] == fam["id"] and _fold(e["edition"]) == _fold(label) for e in state["editions"]):
        raise SourceError("Édition déjà existante pour cette famille")
    if "title" not in data:
        raise SourceError("Titre requis")
    ed = {
        "id": _new_id("srce"), "family_id": fam["id"], "rev": 1, "type": "other", "title": "", "author": "", "edition": label,
        "year": _year(data.get("year")), "publisher": "", "identifier": "", "url": "", "file_ref": "", "notes": "",
        "archived": False, "superseded_by": None, "project_ids": [], "calibration": None, "created_at": now, "updated_at": now,
    }
    _apply_edit(ed, data)
    state["editions"].append(ed)
    state["sources_rev"] += 1
    return {"edition": _public_edition(ed)}


def _edition_update(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "id", "expected_rev"} | _EDIT_KEYS)
    ed = _find(state["editions"], _req_id(data, "id", "srce"), "Édition")
    expected = _req_rev(data)
    _check_rev(state, ed, expected, "edition")
    _apply_edit(ed, data)
    _bump(state, ed, now)
    return {"edition": _public_edition(ed)}


def _edition_archive(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "id", "expected_rev", "archived"})
    ed = _find(state["editions"], _req_id(data, "id", "srce"), "Édition")
    expected = _req_rev(data)
    _check_rev(state, ed, expected, "edition")
    if not isinstance(data.get("archived"), bool):
        raise SourceError("archived invalide")
    if data["archived"] and any(e["superseded_by"] == ed["id"] for e in state["editions"]):
        raise SourceError("Édition désignée comme remplaçante : retire d'abord le remplacement")
    ed["archived"] = data["archived"]  # citations keep pointing at it: archive is a tombstone, never a delete
    _bump(state, ed, now)
    return {"edition": _public_edition(ed)}


def _edition_supersede(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "id", "expected_rev", "newer_id"})
    ed = _find(state["editions"], _req_id(data, "id", "srce"), "Édition")
    expected = _req_rev(data)
    newer_id = data.get("newer_id")
    _check_rev(state, ed, expected, "edition")
    if newer_id is None:
        ed["superseded_by"] = None
    else:
        if not isinstance(newer_id, str) or not _ID_RE["srce"].match(newer_id):
            raise SourceError("newer_id invalide")
        newer = _find(state["editions"], newer_id, "Édition plus récente")
        if newer["id"] == ed["id"] or newer["family_id"] != ed["family_id"]:
            raise SourceError("L'édition plus récente doit être une autre édition de la même famille")
        if newer["archived"]:
            raise SourceError("Édition plus récente archivée")
        cursor, hops = newer, 0
        while cursor is not None and hops < len(state["editions"]) + 1:  # no cycles
            if cursor["id"] == ed["id"]:
                raise SourceError("Supersession circulaire")
            nxt = cursor["superseded_by"]
            cursor = _find(state["editions"], nxt, "Édition") if nxt else None
            hops += 1
        ed["superseded_by"] = newer["id"]  # the OLD record is annotated; nothing is copied or renumbered
    _bump(state, ed, now)
    return {"edition": _public_edition(ed)}


def _edition_calibrate(state: dict, data: dict, now: float) -> dict:
    _only(data, {"action", "id", "expected_rev", "calibration"})
    ed = _find(state["editions"], _req_id(data, "id", "srce"), "Édition")
    expected = _req_rev(data)
    _check_rev(state, ed, expected, "edition")
    ed["calibration"] = check_calibration(data.get("calibration"))
    _bump(state, ed, now)
    return {"edition": _public_edition(ed)}


_HANDLERS = {
    "source_family_create": _family_create,
    "source_family_update": _family_update,
    "source_family_archive": _family_archive,
    "source_edition_create": _edition_create,
    "source_edition_update": _edition_update,
    "source_edition_archive": _edition_archive,
    "source_edition_supersede": _edition_supersede,
    "source_edition_calibrate": _edition_calibrate,
}


def mutate(data: Any) -> dict:
    """Apply one source action atomically. Nothing is written on error; malformed bytes are kept."""
    if not isinstance(data, dict):
        raise SourceError("Requête invalide")
    action = data.get("action")
    handler = _HANDLERS.get(action) if isinstance(action, str) else None
    if handler is None:
        raise SourceError("action invalide")
    path = confined_path()
    with hq_state.path_lock(path):
        state = _load_locked()
        result = handler(state, data, _now())
        _write(state)
        out = {"ok": True, "sources_rev": state["sources_rev"]}
        out.update(_copy(result))
    return out


# ---------------------------------------------------------------- backup


def snapshot_bytes(root: Path | str) -> tuple[bytes | None, bool]:
    """Committed ``sources.json`` bytes (under the path lock) and whether they validate; ``(None, True)``
    when there is no sources file. A redirected path is refused (SourceStorageError)."""
    src = sources_path(root)
    with hq_state.path_lock(src):
        confined_path(root)
        if not os.path.lexists(src):
            return None, True
        if not src.is_file():
            raise SourceStorageError("sources.json n'est pas un fichier — conservé")
        payload = src.read_bytes()
    try:
        return payload, _usable(json.loads(payload.decode("utf-8")))
    except (UnicodeDecodeError, ValueError):
        return payload, False
