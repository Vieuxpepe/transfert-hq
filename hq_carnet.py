"""Carnet: one synchronized notebook (PC, iPad, iPhone) stored as local JSON.

Runtime state lives at ``<ROOT>/.hq-carnet/notebook.json`` (fixed server path).
Writes go through ``hq_state.write_json_atomic`` under ``hq_state.path_lock``.
A malformed or unsupported file is never rewritten: its bytes stay untouched.

Content (Stage 04): pages hold structured content V2 (``hq_carnet_rich``: one-line blocks with
inline marks, never HTML) or legacy V1 (one text block). Migration is lazy and per page: reads and
unrelated writes never convert a V1 page; writing a page stores V2 when it fits the line limits, and
a plain page that does not fit stays a compact V1 block (no text lost, no amplification).
``page_export`` writes a confined, no-clobber TXT/Markdown snapshot into Inbox/Uni/Print.

Images (Stage 06, ``hq_carnet_media``): an ``image`` block carries only bounded metadata (asset id, MIME,
dimensions, width %, caption). The bytes live in ``<ROOT>/.hq-carnet/assets/`` (generated names, write-once,
never deleted by Carnet in Stage 06: orphans count against the quota). ``page_save`` verifies every NEWLY
referenced asset against the real file; backup copies exactly the referenced assets; a Markdown export with
images is a package (``<name>.md`` + ``<name>.assets/``).

Revisions:
- every page has its own ``rev`` (``page_save`` checks ``expected_rev``);
- structural actions check ``expected_notebook_rev``;
- a stale request is refused (409) before any disk write.

Note contents never go to logs, URLs or error messages.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

import hq_carnet_media as media
import hq_carnet_rich as rich
import hq_carnet_sources as sources
import hq_state

DIR_NAME = ".hq-carnet"
FILE_NAME = "notebook.json"
VERSION = 1
CONTENT_VERSION = rich.CONTENT_VERSION  # stored page content (V1 is read + migrated, never written)

PAGES_ACTIVE_MAX = 128
# Trash is bounded too: trashing is refused once it holds this many pages.
# Nothing is ever purged automatically (permanent delete stays explicit).
PAGES_TRASH_MAX = 128
PAGE_TEXT_BYTES = 48 * 1024
NOTEBOOK_TEXT_BYTES = 1024 * 1024
CATEGORIES_MAX = 24
PROJECTS_MAX = 128
CATEGORY_NAME_MAX = 40
PROJECT_NAME_MAX = 60
CATEGORY_COLORS = ("blue", "green", "amber", "coral", "violet", "pink", "teal", "graphite")
TITLE_MAX = 120
PREVIEW_MAX = 160
UNTITLED = "Page sans titre"

EXPORT_ACTION = "page_export"  # read-only snapshot into Inbox/Uni/Print; never mutates the notebook
EXPORT_FORMATS = ("txt", "md")
EXPORT_DEPTH_MAX = 6
EXPORT_PART_MAX = 80

ACTIONS = (
    "page_create",
    "page_save",
    "page_trash",
    "page_restore",
    "page_delete_permanent",
    "category_create",
    "category_update",
    "category_delete",
    "project_create",
    "project_update",
    "project_archive",
)

_ID_RE = {
    "page": re.compile(r"^page-[A-Za-z0-9_-]{1,64}\Z"),
    "block": re.compile(r"^block-[A-Za-z0-9_-]{1,64}\Z"),
    "cat": re.compile(r"^cat-[A-Za-z0-9_-]{1,64}\Z"),
    "proj": re.compile(r"^proj-[A-Za-z0-9_-]{1,64}\Z"),
}
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")

_cb: dict[str, Any] = {}
_ready = False
_guard = threading.Lock()


class CarnetError(ValueError):
    """Validation failure (HTTP 400, code validation_error)."""

    status = 400
    code = "validation_error"


class CarnetNotFound(CarnetError):
    """Unknown entity (HTTP 404, code not_found)."""

    status = 404
    code = "not_found"


class CarnetConflict(RuntimeError):
    """Stale revision (HTTP 409). ``payload`` is the full response body."""

    status = 409

    def __init__(self, payload: dict):
        super().__init__(str(payload.get("error") or "Conflit"))
        self.payload = payload


class CarnetStorageError(RuntimeError):
    """Unreadable/unsupported state (409) or failed write (503). Bytes preserved."""

    code = "storage_error"

    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- binding


def bind(**kwargs: Any) -> None:
    global _ready
    with _guard:
        _cb.update(kwargs)
        sources.bind(**kwargs)  # Stage 05: sources share the root / confinement callbacks
        media.bind(**kwargs)  # Stage 06: image storage shares the root
        _ready = _cb.get("root") is not None


def ready() -> bool:
    return _ready and _cb.get("root") is not None


def notebook_path(root: Path | str) -> Path:
    """Fixed server path. Absolute so every caller shares one path lock."""
    return Path(os.path.abspath(os.fspath(root))) / DIR_NAME / FILE_NAME


_ESCAPED = "Emplacement du carnet redirigé — refusé, fichier conservé"


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)  # Python 3.12+: Windows junctions
    return bool(is_junction and is_junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def confined_path(root: Path | str) -> Path:
    """``notebook_path(root)`` after refusing any redirection below ROOT.

    ``.hq-carnet``, ``notebook.json`` and its ``.tmp`` sibling must not be
    symlinks/junctions and must resolve inside ``<real ROOT>/.hq-carnet``.
    Absent entries are fine (normal initialisation). Never touches bytes;
    errors carry no filesystem path.
    """
    path = notebook_path(root)
    base = path.parent
    try:
        real_base = os.path.join(os.path.realpath(base.parent), DIR_NAME)
        if _is_link(base) or not _same(os.path.realpath(base), real_base):
            raise CarnetStorageError(_ESCAPED)
        for name in (FILE_NAME, FILE_NAME + ".tmp"):
            item = base / name
            if _is_link(item) or not _same(os.path.realpath(item), os.path.join(real_base, name)):
                raise CarnetStorageError(_ESCAPED)
    except OSError as e:
        raise CarnetStorageError("Carnet inaccessible", 503) from e
    return path


def _path() -> Path:
    root = _cb.get("root")
    if root is None:
        raise CarnetStorageError("Carnet non initialisé", 503)
    return confined_path(root)


def _now() -> float:
    fn = _cb.get("now")
    if callable(fn):
        return float(fn())
    return time.time()


def limits() -> dict:
    return {
        "page_text_bytes": PAGE_TEXT_BYTES,
        "notebook_text_bytes": NOTEBOOK_TEXT_BYTES,
        "categories": CATEGORIES_MAX,
        "active_pages": PAGES_ACTIVE_MAX,
        "trash_pages": PAGES_TRASH_MAX,
        "projects": PROJECTS_MAX,
        "category_name_chars": CATEGORY_NAME_MAX,
        "project_name_chars": PROJECT_NAME_MAX,
        "category_colors": list(CATEGORY_COLORS),
        "page_blocks": rich.BLOCKS_MAX,
        "notebook_blocks": rich.NOTEBOOK_BLOCKS_MAX,
        "marks_per_block": rich.MARKS_PER_BLOCK_MAX,
        **media.limits(),
    }


def _folders() -> tuple[str, ...]:
    fn = _cb.get("folders")
    try:
        got = tuple(str(x) for x in fn()) if callable(fn) else ()
    except Exception:
        got = ()
    return got or ("Inbox", "Uni", "Print")


def _system_names() -> frozenset[str]:
    names = _cb.get("system_names")
    try:
        return frozenset(str(x).lower() for x in (names or ()))
    except TypeError:
        return frozenset()


def _new_id(prefix: str) -> str:
    return f"{prefix}-{secrets.token_hex(12)}"


# ---------------------------------------------------------------- persisted shape


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_num(value: Any) -> bool:
    return (isinstance(value, (int, float)) and not isinstance(value, bool)) and value == value


def _opt_id(value: Any, kind: str) -> bool:
    return value is None or (isinstance(value, str) and bool(_ID_RE[kind].match(value)))


def _valid_content(content: Any) -> bool:
    return rich.valid_v1(content) or rich.valid_v2(content)


_PAGE_KEYS = {"id", "rev", "project_id", "category_id", "pinned", "deleted_at", "created_at", "updated_at", "content"}
_CAT_KEYS = {"id", "name", "color", "created_at", "updated_at"}
_PROJ_KEYS = {"id", "name", "archived", "created_at", "updated_at"}
_TOP_KEYS = {"version", "notebook_rev", "projects", "categories", "pages"}


def _usable(data: Any) -> bool:
    if not isinstance(data, dict) or set(data) != _TOP_KEYS:
        return False
    if not _is_int(data.get("notebook_rev")) or data["notebook_rev"] < 1:
        return False
    projects, categories, pages = data.get("projects"), data.get("categories"), data.get("pages")
    if not all(isinstance(x, list) for x in (projects, categories, pages)):
        return False
    seen: set[str] = set()
    for proj in projects:
        if not isinstance(proj, dict) or set(proj) != _PROJ_KEYS:
            return False
        if not _opt_id(proj.get("id"), "proj") or proj["id"] is None or proj["id"] in seen:
            return False
        seen.add(proj["id"])
        if not isinstance(proj.get("name"), str) or not isinstance(proj.get("archived"), bool):
            return False
        if not _is_num(proj.get("created_at")) or not _is_num(proj.get("updated_at")):
            return False
    for cat in categories:
        if not isinstance(cat, dict) or set(cat) != _CAT_KEYS:
            return False
        if not _opt_id(cat.get("id"), "cat") or cat["id"] is None or cat["id"] in seen:
            return False
        seen.add(cat["id"])
        if not isinstance(cat.get("name"), str) or cat.get("color") not in CATEGORY_COLORS:
            return False
        if not _is_num(cat.get("created_at")) or not _is_num(cat.get("updated_at")):
            return False
    for page in pages:
        if not isinstance(page, dict) or set(page) != _PAGE_KEYS:
            return False
        if not _opt_id(page.get("id"), "page") or page["id"] is None or page["id"] in seen:
            return False
        seen.add(page["id"])
        if not _is_int(page.get("rev")) or page["rev"] < 1:
            return False
        if not _opt_id(page.get("project_id"), "proj") or not _opt_id(page.get("category_id"), "cat"):
            return False
        if not isinstance(page.get("pinned"), bool):
            return False
        if page.get("deleted_at") is not None and not _is_num(page.get("deleted_at")):
            return False
        if not _is_num(page.get("created_at")) or not _is_num(page.get("updated_at")):
            return False
        if not _valid_content(page.get("content")):
            return False
    return True


def _read_state() -> tuple[dict | None, str | None]:
    """Return (state, problem). Missing file is (None, None). Never writes."""
    path = _path()
    try:
        is_file, exists = path.is_file(), os.path.lexists(path)
    except OSError:
        return None, "notebook.json inaccessible — fichier conservé"
    if not is_file:
        if exists:
            return None, "notebook.json n'est pas un fichier — conservé"
        return None, None
    try:
        raw = json.loads(path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None, "notebook.json illisible — fichier conservé"
    if isinstance(raw, dict) and raw.get("version") != VERSION:
        return None, "notebook.json version non prise en charge — fichier conservé"
    if not _usable(raw):
        return None, "notebook.json illisible — fichier conservé"
    return raw, None


def malformed() -> bool:
    if not ready():
        return False
    try:
        _state, problem = _read_state()
    except CarnetStorageError:
        return True
    return problem is not None


def _blank_page(now: float) -> dict:
    return {
        "id": _new_id("page"),
        "rev": 1,
        "project_id": None,
        "category_id": None,
        "pinned": False,
        "deleted_at": None,
        "created_at": now,
        "updated_at": now,
        "content": {
            "version": CONTENT_VERSION,
            "blocks": [{"id": _new_id("block"), "type": "paragraph", "text": "", "marks": []}],
        },
    }


def _initial(now: float) -> dict:
    return {"version": VERSION, "notebook_rev": 1, "projects": [], "categories": [], "pages": [_blank_page(now)]}


def _write(state: dict) -> None:
    """Replace state. Caller holds the path lock and has validated the file."""
    path = _path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        hq_state.write_json_atomic(path, state)
    except RuntimeError as e:
        raise CarnetStorageError(str(e)) from e
    except OSError as e:
        raise CarnetStorageError("Écriture du carnet impossible — dernière version conservée", 503) from e


def _load_locked(*, create: bool) -> dict:
    """Load under the caller's lock. Missing file: initialise (and write) when ``create``."""
    state, problem = _read_state()
    if problem:
        raise CarnetStorageError(problem)
    if state is None:
        state = _initial(_now())
        if create:
            _write(state)
    return state


# ---------------------------------------------------------------- derived output


def _text(page: dict) -> str:
    return rich.flat_text(page["content"])


def _bytes(text: str) -> int:
    return len(text.encode("utf-8"))


def derive_title(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:TITLE_MAX]
    return UNTITLED


def derive_preview(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    body = " ".join(lines[1:])
    body = " ".join(body.split())
    return body[:PREVIEW_MAX]


def _page_meta(page: dict) -> dict:
    text = _text(page)
    return {
        "id": page["id"],
        "rev": page["rev"],
        "project_id": page["project_id"],
        "category_id": page["category_id"],
        "pinned": page["pinned"],
        "deleted_at": page["deleted_at"],
        "created_at": page["created_at"],
        "updated_at": page["updated_at"],
        "title": derive_title(text),
        "preview": derive_preview(text),
    }


def _copy(obj: Any) -> Any:
    return json.loads(json.dumps(obj, ensure_ascii=False))


# ---------------------------------------------------------------- reads


def get_notebook(*, meta: bool = False) -> dict:
    path = _path()
    with hq_state.path_lock(path):
        state = _load_locked(create=True)
    out = {
        "ok": True,
        "version": VERSION,
        "notebook_rev": state["notebook_rev"],
        "projects": state["projects"],
        "categories": state["categories"],
        "limits": limits(),
    }
    if meta:
        out["pages"] = [_page_meta(page) for page in state["pages"]]
    else:
        out["pages"] = state["pages"]
    return out


# ---------------------------------------------------------------- validation helpers


def _only_keys(data: dict, allowed: set[str]) -> None:
    extra = set(data) - allowed
    if extra:
        raise CarnetError("Champ non autorisé : " + ", ".join(sorted(str(k)[:40] for k in extra)))


def _req_int(data: dict, key: str) -> int:
    value = data.get(key)
    if not _is_int(value) or value < 0:
        raise CarnetError(f"{key} requis")
    return value


def _req_id(data: dict, key: str, kind: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not _ID_RE[kind].match(value):
        raise CarnetError(f"{key} invalide")
    return value


def _opt_ref(data: dict, key: str, kind: str) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not _ID_RE[kind].match(value):
        raise CarnetError(f"{key} invalide")
    return value


def _name(value: Any, limit: int, label: str) -> str:
    if not isinstance(value, str):
        raise CarnetError(f"Nom de {label} requis")
    name = " ".join(value.split())
    if not name:
        raise CarnetError(f"Nom de {label} requis")
    if _CTRL_RE.search(name):
        raise CarnetError(f"Nom de {label} invalide")
    try:
        name.encode("utf-8")
    except UnicodeEncodeError as e:
        raise CarnetError(f"Nom de {label} invalide") from e
    if len(name) > limit:
        raise CarnetError(f"Nom de {label} trop long (max {limit})")
    return name


def _active(state: dict) -> list[dict]:
    return [page for page in state["pages"] if page["deleted_at"] is None]


def _active_text_bytes(state: dict, *, skip: str | None = None) -> int:
    return sum(_bytes(_text(page)) for page in _active(state) if page["id"] != skip)


def _total_blocks(state: dict) -> int:
    return sum(len(page["content"]["blocks"]) for page in state["pages"])


def _block_budget_ok(state: dict, delta: int) -> bool:
    """One invariant for every operation that adds stored blocks (save, create, replacement page).

    Shrinking or keeping the count is always allowed, so a notebook that is over the budget can
    only recover, never grow.
    """
    return delta <= 0 or _total_blocks(state) + delta <= rich.NOTEBOOK_BLOCKS_MAX


def _need_block_budget(state: dict, delta: int) -> None:
    if not _block_budget_ok(state, delta):
        raise CarnetError(f"Carnet trop volumineux (max {rich.NOTEBOOK_BLOCKS_MAX} lignes)")


def _find(items: list[dict], item_id: str, label: str) -> dict:
    for item in items:
        if item["id"] == item_id:
            return item
    raise CarnetNotFound(f"{label} introuvable")


def _check_notebook_rev(state: dict, expected: int) -> None:
    if expected != state["notebook_rev"]:
        raise CarnetConflict(
            {"error": "Carnet modifié ailleurs", "code": "notebook_revision_conflict", "notebook_rev": state["notebook_rev"]}
        )


def _check_page_rev(state: dict, page: dict, expected: int) -> None:
    if expected != page["rev"]:
        raise CarnetConflict(
            {
                "error": "Page modifiée ailleurs",
                "code": "revision_conflict",
                "page": _copy(page),
                "notebook_rev": state["notebook_rev"],
            }
        )


def _project_ref(state: dict, project_id: str | None, *, keep: str | None = None) -> str | None:
    if project_id is None:
        return None
    project = _find(state["projects"], project_id, "Projet")
    if project["archived"] and project_id != keep:
        raise CarnetError("Projet archivé")
    return project_id


def _category_ref(state: dict, category_id: str | None) -> str | None:
    if category_id is None:
        return None
    _find(state["categories"], category_id, "Catégorie")
    return category_id


def _dup_name(items: list[dict], name: str, skip: str | None = None) -> bool:
    folded = name.casefold()
    return any(item["name"].casefold() == folded and item["id"] != skip for item in items)


# ---------------------------------------------------------------- actions


def _page_create(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "expected_notebook_rev", "after_id", "project_id", "category_id"})
    expected = _req_int(data, "expected_notebook_rev")
    after_id = _opt_ref(data, "after_id", "page")
    project_id = _opt_ref(data, "project_id", "proj")
    category_id = _opt_ref(data, "category_id", "cat")
    _check_notebook_rev(state, expected)
    project_id = _project_ref(state, project_id)
    category_id = _category_ref(state, category_id)
    if len(_active(state)) >= PAGES_ACTIVE_MAX:
        raise CarnetError(f"Carnet plein (max {PAGES_ACTIVE_MAX} pages)")
    _need_block_budget(state, 1)
    index = len(state["pages"])
    if after_id is not None:
        after = _find(state["pages"], after_id, "Page")
        if after["deleted_at"] is not None:
            raise CarnetError("Page de référence dans la corbeille")
        index = state["pages"].index(after) + 1
    page = _blank_page(now)
    page["project_id"] = project_id
    page["category_id"] = category_id
    state["pages"].insert(index, page)
    state["notebook_rev"] += 1
    return {"page": page}


def _page_save(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "id", "expected_rev", "project_id", "category_id", "pinned", "content"})
    page_id = _req_id(data, "id", "page")
    expected = _req_int(data, "expected_rev")
    page = _find(state["pages"], page_id, "Page")
    _check_page_rev(state, page, expected)
    if page["deleted_at"] is not None:
        raise CarnetError("Page dans la corbeille — restaure-la d'abord")
    changed = False
    if "project_id" in data:
        project_id = _project_ref(state, _opt_ref(data, "project_id", "proj"), keep=page["project_id"])
        changed = changed or project_id != page["project_id"]
    else:
        project_id = page["project_id"]
    if "category_id" in data:
        category_id = _category_ref(state, _opt_ref(data, "category_id", "cat"))
        changed = changed or category_id != page["category_id"]
    else:
        category_id = page["category_id"]
    if "pinned" in data:
        pinned = data["pinned"]
        if not isinstance(pinned, bool):
            raise CarnetError("pinned invalide")
        changed = changed or pinned != page["pinned"]
    else:
        pinned = page["pinned"]
    new_content = None
    if "content" in data:
        try:
            parsed = rich.parse_content(
                data["content"],
                existing=page["content"],
                folders=_folders(),
                system_names=_system_names(),
                text_limit=PAGE_TEXT_BYTES,
            )
            if not rich.same_as_stored(parsed, page["content"]):
                new_content = rich.store_content(parsed, page["content"], budget_ok=lambda delta: _block_budget_ok(state, delta))
                _verify_media(page["content"], new_content)
        except rich.ContentError as e:
            raise CarnetError(str(e)) from e
        changed = changed or new_content is not None
    if not changed:
        return {"page": page}
    new_bytes = _bytes(rich.flat_text(new_content)) if new_content is not None else _bytes(_text(page))
    if _active_text_bytes(state, skip=page_id) + new_bytes > NOTEBOOK_TEXT_BYTES:
        raise CarnetError(f"Carnet trop volumineux (max {NOTEBOOK_TEXT_BYTES} octets)")
    page["project_id"] = project_id
    page["category_id"] = category_id
    page["pinned"] = pinned
    if new_content is not None:
        page["content"] = new_content
    page["rev"] += 1
    page["updated_at"] = now
    return {"page": page, "_write": True}


def _verify_media(old: dict, new: dict) -> None:
    """Every image file a save newly points at must exist and match the real file (mime/size bounds/dimensions).

    References already stored on the page are not re-verified (a missing file there is preserved state, never a
    reason to block unrelated edits). Assets are write-once, so no assets lock is needed here (lock order:
    the assets lock is always OUTER; ``page_save`` holds only the notebook lock).
    """
    known = {rich.asset_key(a) for a in rich.assets_of(old)} if old["version"] == rich.CONTENT_VERSION else set()
    checked: set[tuple] = set()
    for asset in rich.assets_of(new):
        key = rich.asset_key(asset)
        if key in known or key in checked:
            continue
        checked.add(key)
        try:
            media.verify_asset(asset)
        except media.MediaError as e:
            if e.status >= 500:
                raise CarnetStorageError(str(e), 503) from e
            raise CarnetError(str(e)) from e


def referenced_assets(state: dict) -> set[str]:
    """Asset ids referenced by any page (trash included). Derived, never a stored counter."""
    out: set[str] = set()
    for page in state["pages"]:
        content = page["content"]
        if content.get("version") == rich.CONTENT_VERSION:
            out.update(a["id"] for a in rich.assets_of(content))
    return out


def _structural_page(state: dict, data: dict) -> dict:
    _only_keys(data, {"action", "id", "expected_rev", "expected_notebook_rev"})
    page_id = _req_id(data, "id", "page")
    expected_rev = _req_int(data, "expected_rev")
    expected_nb = _req_int(data, "expected_notebook_rev")
    _check_notebook_rev(state, expected_nb)
    page = _find(state["pages"], page_id, "Page")
    _check_page_rev(state, page, expected_rev)
    return page


def _page_trash(state: dict, data: dict, now: float) -> dict:
    page = _structural_page(state, data)
    if page["deleted_at"] is not None:
        raise CarnetError("Page déjà dans la corbeille")
    trashed = len(state["pages"]) - len(_active(state))
    if trashed >= PAGES_TRASH_MAX:
        raise CarnetError(f"Corbeille pleine (max {PAGES_TRASH_MAX}) — supprime définitivement des pages")
    if len(_active(state)) == 1:
        _need_block_budget(state, 1)  # trashing the last active page creates the blank replacement
    page["deleted_at"] = now
    page["rev"] += 1
    page["updated_at"] = now
    state["notebook_rev"] += 1
    out: dict = {"page": page}
    if not _active(state):
        # Invariant: a usable blank page always exists.
        blank = _blank_page(now)
        state["pages"].append(blank)
        out["replacement_page"] = blank
    return out


def _page_restore(state: dict, data: dict, now: float) -> dict:
    page = _structural_page(state, data)
    if page["deleted_at"] is None:
        raise CarnetError("Page non supprimée")
    if len(_active(state)) >= PAGES_ACTIVE_MAX:
        raise CarnetError(f"Carnet plein (max {PAGES_ACTIVE_MAX} pages)")
    if _active_text_bytes(state) + _bytes(_text(page)) > NOTEBOOK_TEXT_BYTES:
        raise CarnetError(f"Carnet trop volumineux (max {NOTEBOOK_TEXT_BYTES} octets)")
    page["deleted_at"] = None
    page["rev"] += 1
    page["updated_at"] = now
    state["notebook_rev"] += 1
    return {"page": page}


def _page_delete_permanent(state: dict, data: dict, now: float) -> dict:
    page = _structural_page(state, data)
    if page["deleted_at"] is None:
        raise CarnetError("Mets d'abord la page à la corbeille")
    state["pages"].remove(page)
    state["notebook_rev"] += 1
    return {"id": page["id"]}


def _category_create(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "expected_notebook_rev", "name", "color"})
    expected = _req_int(data, "expected_notebook_rev")
    name = _name(data.get("name"), CATEGORY_NAME_MAX, "catégorie")
    color = data.get("color")
    if color not in CATEGORY_COLORS:
        raise CarnetError("Couleur invalide")
    _check_notebook_rev(state, expected)
    if len(state["categories"]) >= CATEGORIES_MAX:
        raise CarnetError(f"Trop de catégories (max {CATEGORIES_MAX})")
    if _dup_name(state["categories"], name):
        raise CarnetError("Catégorie déjà existante")
    category = {"id": _new_id("cat"), "name": name, "color": color, "created_at": now, "updated_at": now}
    state["categories"].append(category)
    state["notebook_rev"] += 1
    return {"category": category}


def _category_update(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "id", "expected_notebook_rev", "name", "color"})
    cat_id = _req_id(data, "id", "cat")
    expected = _req_int(data, "expected_notebook_rev")
    name = _name(data["name"], CATEGORY_NAME_MAX, "catégorie") if "name" in data else None
    color = data.get("color") if "color" in data else None
    if "color" in data and color not in CATEGORY_COLORS:
        raise CarnetError("Couleur invalide")
    _check_notebook_rev(state, expected)
    category = _find(state["categories"], cat_id, "Catégorie")
    if name is not None and _dup_name(state["categories"], name, skip=cat_id):
        raise CarnetError("Catégorie déjà existante")
    if name is not None:
        category["name"] = name
    if color is not None:
        category["color"] = color
    category["updated_at"] = now
    state["notebook_rev"] += 1
    return {"category": category}


def _category_delete(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "id", "expected_notebook_rev"})
    cat_id = _req_id(data, "id", "cat")
    expected = _req_int(data, "expected_notebook_rev")
    _check_notebook_rev(state, expected)
    category = _find(state["categories"], cat_id, "Catégorie")
    state["categories"].remove(category)
    affected = []
    for page in state["pages"]:
        if page["category_id"] == cat_id:
            page["category_id"] = None
            page["rev"] += 1
            page["updated_at"] = now
            affected.append(page["id"])
    state["notebook_rev"] += 1
    return {"category": {"id": cat_id, "deleted": True}, "affected_pages": affected}


def _project_create(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "expected_notebook_rev", "name"})
    expected = _req_int(data, "expected_notebook_rev")
    name = _name(data.get("name"), PROJECT_NAME_MAX, "projet")
    _check_notebook_rev(state, expected)
    if len(state["projects"]) >= PROJECTS_MAX:
        raise CarnetError(f"Trop de projets (max {PROJECTS_MAX})")
    project = {"id": _new_id("proj"), "name": name, "archived": False, "created_at": now, "updated_at": now}
    state["projects"].append(project)
    state["notebook_rev"] += 1
    return {"project": project}


def _project_update(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "id", "expected_notebook_rev", "name"})
    proj_id = _req_id(data, "id", "proj")
    expected = _req_int(data, "expected_notebook_rev")
    name = _name(data.get("name"), PROJECT_NAME_MAX, "projet")
    _check_notebook_rev(state, expected)
    project = _find(state["projects"], proj_id, "Projet")
    project["name"] = name
    project["updated_at"] = now
    state["notebook_rev"] += 1
    return {"project": project}


def _project_archive(state: dict, data: dict, now: float) -> dict:
    _only_keys(data, {"action", "id", "expected_notebook_rev", "archived"})
    proj_id = _req_id(data, "id", "proj")
    expected = _req_int(data, "expected_notebook_rev")
    archived = data.get("archived")
    if not isinstance(archived, bool):
        raise CarnetError("archived invalide")
    _check_notebook_rev(state, expected)
    project = _find(state["projects"], proj_id, "Projet")
    # Notes keep project_id: archiving never touches pages.
    project["archived"] = archived
    project["updated_at"] = now
    state["notebook_rev"] += 1
    return {"project": project}


_HANDLERS = {
    "page_create": _page_create,
    "page_save": _page_save,
    "page_trash": _page_trash,
    "page_restore": _page_restore,
    "page_delete_permanent": _page_delete_permanent,
    "category_create": _category_create,
    "category_update": _category_update,
    "category_delete": _category_delete,
    "project_create": _project_create,
    "project_update": _project_update,
    "project_archive": _project_archive,
}


def mutate(data: Any) -> dict:
    """Apply one action atomically. Raises Carnet* errors; nothing is written on error."""
    if not isinstance(data, dict):
        raise CarnetError("Requête invalide")
    action = data.get("action")
    handler = _HANDLERS.get(action) if isinstance(action, str) else None
    if handler is None:
        raise CarnetError("action invalide")
    path = _path()
    with hq_state.path_lock(path):
        state = _load_locked(create=False)
        now = _now()
        before = state["notebook_rev"]
        result = handler(state, data, now)
        write = result.pop("_write", False) or state["notebook_rev"] != before
        if write:
            _write(state)
        out = {"ok": True, "notebook_rev": state["notebook_rev"]}
        out.update(_copy(result))
    return out


# ---------------------------------------------------------------- export (snapshot copy into Transfert)

_EXPORT_PART_BAD = re.compile(r'[<>"|?*\x00-\x1f\x7f]')


def _export_parts(value: Any) -> list[str]:
    """Validate a relative destination like ``Inbox/Notes``. Never resolves or touches the disk."""
    if not isinstance(value, str) or not value or len(value) > 400:
        raise CarnetError("Dossier invalide")
    if "\\" in value or value.startswith("/") or ":" in value:
        raise CarnetError("Dossier invalide")
    parts = value[:-1].split("/") if value.endswith("/") else value.split("/")
    if not parts or len(parts) > EXPORT_DEPTH_MAX:
        raise CarnetError("Dossier invalide")
    folders, system = _folders(), _system_names()
    if parts[0] not in folders:
        raise CarnetError("Dossier invalide (Inbox, Uni ou Print)")
    for part in parts:
        if (
            not part
            or part in (".", "..")
            or part.startswith(".")
            or part != part.strip()
            or part.endswith(".")
            or len(part) > EXPORT_PART_MAX
            or _EXPORT_PART_BAD.search(part)
            or part.lower() in system
            or part.split(".")[0].lower() in rich._RESERVED
        ):
            raise CarnetError("Dossier invalide")
    return parts


def _export_dir(root: Path | str, parts: list[str]) -> Path:
    """Walk ``parts`` below the real ROOT: no link, no escape, roots must already exist.

    Only missing sub-folders (never the Inbox/Uni/Print roots) are created, one level at a
    time, each verified after creation.
    """
    cur = Path(os.path.abspath(os.fspath(root)))
    real_cur = os.path.realpath(cur)
    for index, part in enumerate(parts):
        nxt = cur / part
        try:
            if os.path.lexists(nxt):
                if _is_link(nxt) or not nxt.is_dir():
                    raise CarnetError("Dossier invalide")
            elif index == 0:
                raise CarnetError("Dossier racine introuvable")
            else:
                nxt.mkdir()
            real_nxt = os.path.realpath(nxt)
        except OSError as e:
            raise CarnetStorageError("Dossier inaccessible", 503) from e
        if not _same(real_nxt, os.path.join(real_cur, part)) or _is_link(nxt):
            raise CarnetError("Dossier invalide")
        cur, real_cur = nxt, real_nxt
    return cur


def render_export(content: dict, fmt: str, asset_paths: dict[str, str] | None = None) -> str:
    return rich.render_markdown(content, asset_paths) if fmt == "md" else rich.render_txt(content)


def export_copy(data: dict) -> dict:
    """Write a TXT/Markdown snapshot of the persisted page revision into Inbox/Uni/Print.

    The note text is read server-side (nothing but ids/paths travel in the request), the
    target is confined, the name sanitised, and an existing file is NEVER overwritten
    (409 ``export_exists``). Carnet stays the source of truth; the file is a snapshot.
    """
    _only_keys(data, {"action", "id", "expected_rev", "format", "dir", "filename"})
    page_id = _req_id(data, "id", "page")
    expected = _req_int(data, "expected_rev")
    fmt = data.get("format")
    if fmt not in EXPORT_FORMATS:
        raise CarnetError("Format invalide")
    filename = data.get("filename")
    if filename is not None and (not isinstance(filename, str) or len(filename) > 200):
        raise CarnetError("Nom de fichier invalide")
    parts = _export_parts(data.get("dir"))
    nb_path = _path()
    with hq_state.path_lock(nb_path):
        state = _load_locked(create=False)
        page = _find(state["pages"], page_id, "Page")
        _check_page_rev(state, page, expected)
        if page["deleted_at"] is not None:
            raise CarnetError("Page dans la corbeille — restaure-la d'abord")
        content = _copy(page["content"])
        rev = page["rev"]
    name = rich.export_filename(filename, derive_title(rich.flat_text(content)), fmt)
    leaf_ok = _cb.get("safe_leaf_name")
    if callable(leaf_ok) and leaf_ok(name) is None:
        raise CarnetError("Nom de fichier invalide")
    directory = _export_dir(_cb["root"], parts)
    target = directory / name
    images = rich.assets_of(content) if fmt == "md" else []
    package: Path | None = None
    asset_paths: dict[str, str] = {}
    exists = CarnetConflict({"error": "Un fichier du même nom existe déjà — choisis un autre nom", "code": "export_exists"})
    if os.path.lexists(target):
        raise exists
    if images:
        # Markdown with images is a package: ``<stem>.md`` + ``<stem>.assets/figure-NN.<ext>`` (relative links).
        package_name = name[: -len(".md")] + ".assets"
        if callable(leaf_ok) and leaf_ok(package_name) is None:
            raise CarnetError("Nom de fichier invalide")
        package = directory / package_name
        if os.path.lexists(package):
            raise exists
        for asset in images:
            if asset["id"] not in asset_paths:
                asset_paths[asset["id"]] = f"{package_name}/figure-{len(asset_paths) + 1:02d}{media.MIME_EXT[asset['mime']]}"
    payload = render_export(content, fmt, asset_paths or None).encode("utf-8")
    created: list[Path] = []
    made_package = False

    def _undo() -> None:
        for item in reversed(created):
            try:
                item.unlink()
            except OSError:
                pass
        if made_package and package is not None:
            try:
                package.rmdir()
            except OSError:
                pass

    try:
        if package is not None:
            try:
                package.mkdir()
            except FileExistsError as e:
                raise exists from e
            made_package = True
            for asset_id, rel in asset_paths.items():
                dest = package / rel.rsplit("/", 1)[1]
                created.append(dest)
                try:
                    media.copy_asset(asset_id, dest)
                except media.MediaError as e:
                    raise CarnetError("Image manquante — export refusé") from e
        created.append(target)
        with open(target, "xb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError as e:
        created = [item for item in created if item != target]  # never delete a file that is not ours
        _undo()
        raise exists from e
    except (CarnetError, CarnetConflict):
        _undo()
        raise
    except OSError as e:
        _undo()
        raise CarnetStorageError("Écriture de la copie impossible", 503) from e
    return {
        "ok": True,
        "path": "/".join(parts + [name]),
        "name": name,
        "bytes": len(payload),
        "rev": rev,
        "format": fmt,
        "exported_at": _now(),
        **({"assets_dir": "/".join(parts + [package.name]), "assets": len(asset_paths)} if package is not None else {}),
    }


# ---------------------------------------------------------------- HTTP helpers


def http_get(query: dict[str, list[str]]) -> tuple[int, dict]:
    """``query`` is ``parse_qs`` output. Only ``meta=1`` (page metadata) or ``sources=1`` (Stage 05) is accepted."""
    try:
        extra = set(query) - {"meta", "sources"}
        if extra:
            raise CarnetError("Paramètre inconnu")
        if "sources" in query:
            if query["sources"] != ["1"] or "meta" in query:
                raise CarnetError("sources invalide")
            return 200, sources.get_sources()
        values = query.get("meta")
        meta = False
        if values is not None:
            if values != ["1"]:
                raise CarnetError("meta invalide")
            meta = True
        return 200, get_notebook(meta=meta)
    except CarnetError as e:
        return e.status, {"error": str(e), "code": e.code}
    except CarnetStorageError as e:
        return e.status, {"error": str(e), "code": e.code}
    except (sources.SourceError, sources.SourceStorageError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        # Never echo OS error text: it can contain absolute paths.
        return 503, {"error": "Carnet inaccessible", "code": "storage_error"}


def http_post(data: Any) -> tuple[int, dict]:
    try:
        if isinstance(data, dict) and data.get("action") == EXPORT_ACTION:
            return 200, export_copy(data)
        if isinstance(data, dict) and isinstance(data.get("action"), str) and data["action"].startswith("source_"):
            return 200, sources.mutate(data)
        return 200, mutate(data)
    except (CarnetConflict, sources.SourceConflict) as e:
        return e.status, e.payload
    except (sources.SourceError, sources.SourceStorageError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except CarnetError as e:
        return e.status, {"error": str(e), "code": e.code}
    except CarnetStorageError as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        # Never echo OS error text: it can contain absolute paths.
        return 503, {"error": "Carnet inaccessible", "code": "storage_error"}


# ---------------------------------------------------------------- media (Stage 06)


def http_asset_upload(read, length: Any, declared_mime: str | None) -> tuple[int, dict]:
    """``POST /api/carnet/asset``: ``read(n)`` streams the raw body. Every refusal is path-free."""
    try:
        return 200, media.store_upload(read, length, declared_mime)
    except media.MediaError as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        return 503, {"error": "Enregistrement de l'image impossible", "code": "storage_error"}


def http_asset_usage() -> tuple[int, dict]:
    try:
        return 200, media.usage()
    except media.MediaError as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        return 503, {"error": "Images inaccessibles", "code": "storage_error"}


# ---------------------------------------------------------------- backup


def _write_exclusive(out: Path, payload: bytes) -> None:
    created = False
    try:
        with open(out, "xb") as handle:
            created = True
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
    except Exception:
        # Only remove our own partial file; an existing snapshot (same-second
        # backup stamp) must never be deleted.
        if created:
            try:
                out.unlink()
            except OSError:
                pass
        raise


def snapshot_to(root: Path | str, dest_dir: Path) -> dict:
    """Copy committed Carnet bytes into ``dest_dir``: ``notebook.json``, (Stage 05) ``sources.json`` and
    (Stage 06) the image assets the snapshotted notebook references, under ``assets/``.

    Each file is taken under its own path lock (coherent with writers); citations only carry edition
    ids + a snapshot, so the two files are independently consistent. Only committed files are copied,
    never ``*.tmp``. Missing notebook AND sources is not an error (``status: "absent"``). Malformed
    bytes are copied as-is and reported ``valid: False``. A redirected (symlink/junction) path is
    refused (CarnetStorageError) and never followed. Linked PDFs live under Inbox/Uni/Print and are
    covered by the legacy folder backup: only the metadata is copied here.

    Assets: the referenced set is derived from the SAME notebook bytes that are copied (snapshot
    consistency). Assets are write-once and never deleted in Stage 06, so a file added after the notebook
    read is simply not part of this snapshot and nothing referenced can disappear mid-copy. Only
    referenced assets are copied (no temp files, no unrelated files, no symlinks). A referenced asset that
    is missing/unreadable, or an asset reference that does not validate, makes the snapshot ``valid: False``
    (which blocks backup retention) without failing the legacy backup. Lock order: assets lock (outer),
    then the notebook lock briefly.
    """
    with media.assets_lock(root):
        return _snapshot_locked(root, dest_dir)


def _snapshot_locked(root: Path | str, dest_dir: Path) -> dict:
    src = notebook_path(root)
    payload: bytes | None = None
    valid = True
    parsed: Any = None
    with hq_state.path_lock(src):
        confined_path(root)
        if os.path.lexists(src):
            if not src.is_file():
                raise CarnetStorageError("notebook.json n'est pas un fichier — conservé")
            payload = src.read_bytes()
    refs: set[str] = set()
    if payload is not None:
        try:
            parsed = json.loads(payload.decode("utf-8"))
            valid = isinstance(parsed, dict) and parsed.get("version") == VERSION and _usable(parsed)
        except (UnicodeDecodeError, json.JSONDecodeError):
            valid = False
        if valid:
            refs = referenced_assets(parsed)
    try:
        src_payload, src_valid = sources.snapshot_bytes(root)
    except sources.SourceStorageError as e:
        raise CarnetStorageError(str(e)) from e
    if payload is None and src_payload is None:
        return {"ok": True, "included": False, "status": "absent"}
    if refs:
        try:
            media.confined_assets_dir(root)  # a redirected assets directory is refused before anything is written
        except media.MediaError as e:
            raise CarnetStorageError(str(e), e.status if e.status >= 500 else 409) from e
    dest_dir.mkdir(parents=True, exist_ok=True)
    if payload is not None:
        _write_exclusive(dest_dir / FILE_NAME, payload)
    if src_payload is not None:
        _write_exclusive(dest_dir / sources.FILE_NAME, src_payload)
    assets_report: dict | None = None
    if refs:
        assets_report = media.copy_assets_to(root, sorted(refs), dest_dir / "assets")
        if assets_report["missing"]:
            valid = False
    out: dict = {"ok": True, "included": True, "status": "included", "bytes": len(payload or b""), "valid": bool(valid and src_valid)}
    if src_payload is not None:  # the accepted Stage-01 status shape is unchanged when there are no sources
        out["sources"] = {"bytes": len(src_payload), "valid": bool(src_valid)}
    if assets_report is not None:  # ... and when there are no images
        out["assets"] = assets_report
    return out
