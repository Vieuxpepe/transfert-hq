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

Engineering (Stage 07, ``hq_carnet_eng``): ``calc`` / ``measure`` atoms and ``decision`` lines are ordinary V2 blocks with a
bounded declarative payload. ``task_extract`` turns a selection into a card of the EXISTING Kanban board through the
``task_add`` callback bound by the host (no second task engine, no Carnet-only task store); it never writes the notebook.

History / bulk / reports (Stage 08): ``hq_carnet_history`` keeps a bounded, separate ``history.json`` of MEANINGFUL events only
(explicit restore points, restores, bulk operations and their Undo, single-page lifecycle moves; never autosaves);
``hq_carnet_bulk`` is the one reusable scope -> preview -> confirm -> revision-aware apply -> Undo framework;
``hq_carnet_restore`` takes restore points and restores them as a new revision; ``hq_carnet_links`` derives "Liée depuis…"
lazily from the stored references; ``hq_carnet_report`` assembles an explicit, ordered, read-only report.

Revisions:
- every page has its own ``rev`` (``page_save`` checks ``expected_rev``);
- structural actions check ``expected_notebook_rev``;
- a stale request is refused (409) before any disk write.

Note contents never go to logs, URLs or error messages.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
from collections import OrderedDict
from pathlib import Path
from typing import Any

import hq_carnet_annotations as annotations
import hq_carnet_bulk as bulk
import hq_carnet_history as history
import hq_carnet_links as links
import hq_carnet_media as media
import hq_carnet_evidence as evidence
import hq_carnet_portals as portals
import hq_carnet_reader as reader
import hq_carnet_report as report
import hq_carnet_restore as restore
import hq_carnet_review as review
import hq_carnet_reviews as reviews
import hq_carnet_rcomments as rcomments
import hq_carnet_rich as rich
import hq_carnet_snapshots as snapshots
import hq_carnet_sources as sources
import hq_carnet_voice as voice
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

TASK_ACTION = "task_extract"  # selection -> card of the existing Kanban board; never mutates the notebook
TASK_TITLE_MAX = 120  # the Kanban card title limit (cc_ext.kanban_add cuts at 120)
TASK_TEXT_MAX = 500  # UTF-16 units of selected text accepted
TASK_SEEN_MAX = 256  # bounded in-memory idempotency memory (per process)
TASK_TEXT_TYPES = ("paragraph", "heading", "bullet", "number", "check", "decision")
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
_task_lock = threading.Lock()
_task_seen: "OrderedDict[str, dict]" = OrderedDict()
# page_create idempotency (Quick Capture / templates): request_id -> (fingerprint, page_id). Bounded, per process, like _task_seen.
_create_seen: "OrderedDict[str, tuple[str, str]]" = OrderedDict()
CREATE_SEEN_MAX = 256
_REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}\Z")


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


class CarnetTaskUnavailable(RuntimeError):
    """The task system cannot take a card right now (HTTP 503). Nothing was created, the note is untouched."""

    status = 503
    code = "tasks_unavailable"


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
        voice.bind(**kwargs)  # Phase 4: voice-note storage shares the root
        history.bind(**kwargs)  # Stage 08: the history file shares the root and clock
        snapshots.bind(**kwargs)  # Phase 5: the write-once snapshot store shares the root and clock
        reviews.bind(**kwargs)  # Phase 7: the review-pack store shares the root and clock
        annotations.bind(**kwargs)  # Phase 10: the live-annotation store (review comments reuse its root and clock)
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
        "eng_atoms_per_page": rich.ENG_ATOMS_PER_PAGE_MAX,
        "decisions_per_page": rich.DECISIONS_PER_PAGE_MAX,
        "task_title_chars": TASK_TITLE_MAX,
        "derived_blocks_per_page": rich.DERIVED_BLOCKS_PER_PAGE_MAX,
        **media.limits(),
        **voice.limits(),
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
    return sum(rich.text_bytes(page["content"]) for page in _active(state) if page["id"] != skip)


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
    _only_keys(data, {"action", "expected_notebook_rev", "after_id", "project_id", "category_id", "content", "request_id"})
    expected = _req_int(data, "expected_notebook_rev")
    after_id = _opt_ref(data, "after_id", "page")
    project_id = _opt_ref(data, "project_id", "proj")
    category_id = _opt_ref(data, "category_id", "cat")
    request_id = data.get("request_id")
    fingerprint = None
    if request_id is not None:
        if not isinstance(request_id, str) or not _REQUEST_ID_RE.match(request_id):
            raise CarnetError("request_id invalide")
        # Idempotent retry: the SAME request (same content / classification) returns the page already created for this id —
        # no second page, no revision bump. Checked before the revision guard (a retry carries a stale notebook_rev by design).
        fingerprint = hashlib.sha256(json.dumps([data.get("content"), project_id, category_id, after_id], sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()
        known = _create_seen.get(request_id)
        if known is not None:
            if known[0] != fingerprint:
                raise CarnetError("request_id déjà utilisé pour une autre requête")
            existing = next((p for p in state["pages"] if p["id"] == known[1]), None)
            if existing is not None:  # still there (active or in the trash): answer with THAT page
                return {"page": existing, "duplicate": True}
            # A COMMITTED request id never creates a second page, even after its page was permanently deleted: a stale retry
            # must not resurrect what the user deleted on purpose. The client is told so and starts a new attempt only on an explicit Save.
            raise CarnetConflict({"error": "Cette capture avait déjà été créée, puis supprimée : rien n'a été recréé", "code": "request_result_gone", "notebook_rev": state["notebook_rev"]})
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
    if "content" in data:
        # Templates / Quick Capture: the page is born WITH its content in this single atomic action. The content goes through
        # exactly the validation, id assignment, budgets and media checks of page_save; any failure raises before the page
        # is inserted, so a refused creation leaves no page (and no notebook revision bump) behind.
        blank = page["content"]
        new_content = _parse_store_content(state, blank, data["content"], blocks_already_counted=len(blank["blocks"]))
        if new_content is not None:
            if _active_text_bytes(state) + rich.text_bytes(new_content) > NOTEBOOK_TEXT_BYTES:
                raise CarnetError(f"Carnet trop volumineux (max {NOTEBOOK_TEXT_BYTES} octets)")
            page["content"] = new_content
    state["pages"].insert(index, page)
    state["notebook_rev"] += 1
    out: dict = {"page": page}
    if request_id is not None:
        # Remembered as COMMITTED only after mutate() has persisted the notebook (a failed write releases the id: the retry may create).
        page_id = page["id"]

        def commit() -> None:
            _create_seen[request_id] = (fingerprint, page_id)
            while len(_create_seen) > CREATE_SEEN_MAX:
                _create_seen.popitem(last=False)

        out["_after_write"] = commit
    return out


def _parse_store_content(state: dict, existing: dict, raw: Any, *, blocks_already_counted: int | None = None) -> dict | None:
    """Validate ``raw`` against ``existing`` exactly like ``page_save`` and return the NEW stored content (``None`` when it is
    identical to ``existing``). Raises ``CarnetError``. ``blocks_already_counted``: when ``existing`` is a page that is NOT yet
    part of ``state`` (a page being created) its blocks are not in the notebook total yet, so the budget delta is the full count."""
    try:
        parsed = rich.parse_content(
            raw,
            existing=existing,
            folders=_folders(),
            system_names=_system_names(),
            text_limit=PAGE_TEXT_BYTES,
        )
        if rich.same_as_stored(parsed, existing) and blocks_already_counted is None:
            return None
        extra = blocks_already_counted or 0
        new_content = rich.store_content(parsed, existing, budget_ok=lambda delta: _block_budget_ok(state, delta + extra))
        _verify_media(existing, new_content)
        return new_content
    except rich.ContentError as e:
        raise CarnetError(str(e)) from e


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
        new_content = _parse_store_content(state, page["content"], data["content"])
        changed = changed or new_content is not None
    if not changed:
        return {"page": page}
    new_bytes = rich.text_bytes(new_content) if new_content is not None else rich.text_bytes(page["content"])
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

    Phase 4: a NEWLY added voice note is verified on its real container, and a newly added provenance (``from``) must point at
    a stored image asset / voice note (existence only: provenance never re-validates the source's content).
    """
    old_v2 = old["version"] == rich.CONTENT_VERSION
    known = {rich.asset_key(a) for a in rich.assets_of(old)} if old_v2 else set()
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
    if new["version"] != rich.CONTENT_VERSION:
        return
    known_voice = {tuple(sorted(v.items())) for v in rich.voice_blocks_of(old)} if old_v2 else set()
    seen_voice: set[tuple] = set()
    for payload in rich.voice_blocks_of(new):
        key = tuple(sorted(payload.items()))
        if key in known_voice or key in seen_voice:
            continue
        seen_voice.add(key)
        try:
            voice.verify_voice(payload)
        except voice.VoiceError as e:
            if e.status >= 500:
                raise CarnetStorageError(str(e), 503) from e
            raise CarnetError(str(e)) from e
    old_sources = {(b["from"]["source_kind"], b["from"]["source_id"]) for b in old["blocks"] if "from" in b} if old_v2 else set()
    for block in new["blocks"]:
        src = block.get("from")
        if src is None or (src["source_kind"], src["source_id"]) in old_sources:
            continue
        old_sources.add((src["source_kind"], src["source_id"]))
        exists = media.asset_exists(src["source_id"]) if src["source_kind"] == "asset" else voice.voice_exists(src["source_id"])
        if not exists:
            raise CarnetError("Source de provenance inconnue du carnet")


def referenced_assets(state: dict) -> set[str]:
    """Asset ids referenced by any page (trash included). Derived, never a stored counter."""
    out: set[str] = set()
    for page in state["pages"]:
        content = page["content"]
        if content.get("version") == rich.CONTENT_VERSION:
            out.update(a["id"] for a in rich.assets_of(content))
            out.update(x for b in content["blocks"] for x in rich.block_provenance_assets(b))  # OCR sources are kept as evidence
    return out


def referenced_voices(state: dict) -> set[str]:
    """Voice asset ids referenced by any page (trash included): voice blocks and transcript provenance. Derived, never stored."""
    out: set[str] = set()
    for page in state["pages"]:
        content = page["content"]
        if content.get("version") == rich.CONTENT_VERSION:
            out.update(rich.voices_of(content))
    return out


def referenced_drawings(state: dict) -> set[str]:
    """Drawing stems referenced by any page (trash included): blocks and inline links. Derived, never stored."""
    out: set[str] = set()
    for page in state["pages"]:
        content = page["content"]
        if content.get("version") == rich.CONTENT_VERSION:
            out.update(rich.drawings_of(content))
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
    if _active_text_bytes(state) + rich.text_bytes(page["content"]) > NOTEBOOK_TEXT_BYTES:
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
        after_write = result.pop("_after_write", None)
        if write:
            _write(state)
            if callable(after_write):
                after_write()
        out = {"ok": True, "notebook_rev": state["notebook_rev"]}
        out.update(_copy(result))
        if write and action in _LIFECYCLE:
            _record_lifecycle(action, out, now)
    return out


_LIFECYCLE = {"page_trash": "trash", "page_restore": "restore", "page_delete_permanent": "delete_permanent"}
_LIFECYCLE_TEXT = {"trash": "Page mise à la corbeille", "restore": "Page restaurée de la corbeille", "delete_permanent": "Page supprimée définitivement"}


def _record_lifecycle(action: str, out: dict, now: float) -> None:
    """Single-page trash / restore / permanent delete -> a metadata-only history event. BEST EFFORT: the lifecycle change is
    already committed and a damaged or full history must never block it (the audit trail is the only thing lost)."""
    kind = _LIFECYCLE[action]
    page = out.get("page")
    page_id = page["id"] if isinstance(page, dict) else out.get("id")
    try:
        history.append("lifecycle", "applied", _LIFECYCLE_TEXT[kind], {"page_id": page_id, "action": kind, "rev_after": page["rev"] if isinstance(page, dict) else None}, now=now)
    except (history.HistoryStorageError, OSError, KeyError, TypeError):
        pass


# ---------------------------------------------------------------- task extraction (Stage 07)


def _u16_slice(text: str, start: int, end: int) -> str | None:
    """``text[start:end]`` in UTF-16 code units, or None when the range is outside the text or cuts a surrogate pair."""
    raw = text.encode("utf-16-le")
    if end * 2 > len(raw):
        return None
    try:
        return raw[start * 2 : end * 2].decode("utf-16-le")
    except UnicodeDecodeError:
        return None


def _task_title(value: Any) -> str:
    if not isinstance(value, str) or _CTRL_RE.search(value) or not value.strip() or len(value) > TASK_TITLE_MAX:
        raise CarnetError("Titre de tâche invalide")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise CarnetError("Titre de tâche invalide") from e
    return value


def _task_board_ok() -> None:
    """Refuse (before anything is written) when the Kanban file exists but is not a usable board.

    The Kanban helpers silently replace an unreadable board by the default one on the next save; Carnet must never
    trigger that: a malformed ``kanban.json`` is preserved byte for byte and the extraction fails closed.
    A missing file is normal (the board creates its default).
    """
    path_fn = _cb.get("task_path")
    try:
        path = Path(path_fn()) if callable(path_fn) else None
    except Exception as e:
        raise CarnetTaskUnavailable("Tâches indisponibles") from e
    if path is None:
        raise CarnetTaskUnavailable("Tâches indisponibles")
    if not os.path.lexists(path):
        return
    try:
        if path.is_symlink() or not path.is_file():
            raise CarnetTaskUnavailable("Tâches indisponibles")
        board = json.loads(path.read_bytes().decode("utf-8"))
    except CarnetTaskUnavailable:
        raise
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise CarnetTaskUnavailable("Tâches indisponibles — tableau illisible, conservé") from e
    cols = board.get("columns") if isinstance(board, dict) else None
    bad = CarnetTaskUnavailable("Tâches indisponibles — tableau illisible, conservé")
    if not isinstance(cols, list) or not cols:
        raise bad
    todo_seen = False
    for col in cols:  # shape only: nothing is repaired, anything unexpected fails closed
        if not isinstance(col, dict) or not isinstance(col.get("id"), str) or not col["id"]:
            raise bad
        cards = col.get("cards", [])
        if not isinstance(cards, list) or not all(isinstance(c, dict) for c in cards):
            raise bad
        if col["id"] == "todo":
            todo_seen = True
    if not todo_seen:
        raise bad


def task_extract(data: Any) -> dict:
    """Create ONE Kanban card (column ``todo``) from text selected in a note.

    The request is bound to the object it was opened against: page id + ``expected_rev`` + block id + UTF-16 range +
    the exact selected text. Any mismatch fails closed (409 ``stale_selection`` / ``revision_conflict``) and creates
    nothing. The notebook is never written: the original text stays as it is. ``request_id`` makes a repeated submit
    return the first card instead of creating another (bounded, per process). No backlink is stored: the Kanban
    card model has no source field and Stage 07 does not extend it.
    """
    if not isinstance(data, dict):
        raise CarnetError("Requête invalide")
    _only_keys(data, {"action", "page_id", "expected_rev", "block_id", "start", "end", "text", "title", "request_id"})
    page_id = _req_id(data, "page_id", "page")
    block_id = _req_id(data, "block_id", "block")
    expected = _req_int(data, "expected_rev")
    start = _req_int(data, "start")
    end = _req_int(data, "end")
    request_id = data.get("request_id")
    if not isinstance(request_id, str) or not _REQUEST_ID_RE.match(request_id):
        raise CarnetError("request_id invalide")
    text = data.get("text")
    if not isinstance(text, str) or not text or rich.u16_len(text) > TASK_TEXT_MAX or _CTRL_RE.search(text):
        raise CarnetError("Texte sélectionné invalide")
    title = _task_title(data.get("title"))
    if not end > start:
        raise CarnetError("Sélection vide")
    add = _cb.get("task_add")
    if not callable(add):
        raise CarnetTaskUnavailable("Tâches indisponibles")
    # Lock order: _task_lock -> notebook lock. The notebook lock is HELD until the card is created and confirmed, so the
    # selection cannot change between validation and the Kanban side effect (a concurrent save waits, then bumps rev).
    with _task_lock:
        known = _task_seen.get(request_id)
        if known is not None:
            return {"ok": True, "duplicate": True, "task": dict(known), "rev": expected}
        with hq_state.path_lock(_path()):
            state = _load_locked(create=False)
            page = _find(state["pages"], page_id, "Page")
            _check_page_rev(state, page, expected)
            nb_rev = state["notebook_rev"]
            if page["deleted_at"] is not None:
                raise CarnetError("Page dans la corbeille")
            content = page["content"]
            block = None
            if content.get("version") == rich.CONTENT_VERSION:
                block = next((b for b in content["blocks"] if b["id"] == block_id), None)
            stale = {"error": "Sélection modifiée — aucune tâche créée", "code": "stale_selection", "page": _copy(page), "notebook_rev": nb_rev}
            if block is None or block["type"] not in TASK_TEXT_TYPES:
                raise CarnetConflict(stale)
            if _u16_slice(block["text"], start, end) != text:
                raise CarnetConflict(stale)
            _task_board_ok()
            try:
                board = add("todo", title)
            except (OSError, ValueError, TypeError, AttributeError) as e:
                raise CarnetTaskUnavailable("Tâches indisponibles") from e
            card = None
            try:
                todo = next(c for c in board["columns"] if c.get("id") == "todo")
                first = (todo.get("cards") or [None])[0]
                if isinstance(first, dict) and isinstance(first.get("id"), str) and first.get("title") == title:
                    card = {"id": first["id"][:80], "title": title, "column": "todo"}
            except (StopIteration, KeyError, TypeError, AttributeError):
                card = None
            if card is None:
                raise CarnetTaskUnavailable("Tâche non confirmée — vérifie le tableau des tâches")
            _task_seen[request_id] = card
            while len(_task_seen) > TASK_SEEN_MAX:
                _task_seen.popitem(last=False)
            return {"ok": True, "duplicate": False, "task": dict(card), "rev": expected}


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
    images = rich.assets_of(content) if fmt == "md" else []
    size, package, assets = _write_export(directory, name, images, lambda paths: render_export(content, fmt, paths), leaf_ok)
    return {
        "ok": True,
        "path": "/".join(parts + [name]),
        "name": name,
        "bytes": size,
        "rev": rev,
        "format": fmt,
        "exported_at": _now(),
        **({"assets_dir": "/".join(parts + [package.name]), "assets": assets} if package is not None else {}),
    }


def _write_export(directory: Path, name: str, images: list[dict], render, leaf_ok) -> tuple[int, Path | None, int]:
    """Write ``<name>`` (+ ``<stem>.assets/figure-NN.<ext>`` when ``images``) below the confined ``directory``.

    Shared by the page export and the Stage-08 report export: an existing file is NEVER overwritten (409
    ``export_exists``), nothing is left behind on failure, links are relative. ``render(asset_paths) -> str``.
    Returns ``(bytes written, package dir or None, number of assets)``.
    """
    target = directory / name
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
    payload = render(asset_paths or None).encode("utf-8")
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
    return len(payload), package, len(asset_paths)


# ---------------------------------------------------------------- HTTP helpers


def http_get(query: dict[str, list[str]]) -> tuple[int, dict]:
    """``query`` is ``parse_qs`` output. Accepted (one at a time): ``meta=1`` (page metadata), ``sources=1`` (Stage 05),
    ``history=1[&page=<page-id>]`` and ``backlinks=<kind>&id=<id>`` (Stage 08, read-only, nothing is written)."""
    try:
        extra = set(query) - {"meta", "sources", "history", "page", "backlinks", "id", "cockpit", "snapshots", "snapshot", "verify", "view", "baselines", "diff", "base", "to", "project", "at", "reviews", "review", "freshness"}
        if extra:
            raise CarnetError("Paramètre inconnu")
        if any(len(v) != 1 for v in query.values()):
            raise CarnetError("Paramètre invalide")
        phase7 = _phase7_get(query)
        if phase7 is not None:
            return 200, phase7
        phase5 = _phase5_get(query)
        if phase5 is not None:
            return 200, phase5
        if "history" in query:
            if query["history"] != ["1"] or (set(query) - {"history", "page"}) or ("page" in query and len(query["page"]) != 1):
                raise CarnetError("history invalide")
            return 200, history.list_events(query["page"][0] if "page" in query else None)
        if "backlinks" in query:
            if set(query) != {"backlinks", "id"} or len(query["backlinks"]) != 1 or len(query["id"]) != 1:
                raise CarnetError("backlinks invalide")
            return 200, links.backlinks(query["backlinks"][0], query["id"][0])
        if "page" in query or "id" in query:
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
    except reviews.ReviewConflict as e:
        return e.status, e.payload
    except (history.HistoryError, snapshots.SnapshotError, reviews.ReviewError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except CarnetError as e:
        return e.status, {"error": str(e), "code": e.code}
    except (CarnetStorageError, history.HistoryStorageError, snapshots.SnapshotStorageError, reviews.ReviewStorageError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except (sources.SourceError, sources.SourceStorageError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        # Never echo OS error text: it can contain absolute paths.
        return 503, {"error": "Carnet inaccessible", "code": "storage_error"}


def _phase7_get(query: dict[str, list[str]]) -> dict | None:
    """Phase 7 review packs (read-only). ``reviews=1[&project=]`` lists; ``review=<id>[&freshness=1]`` reads one (freshness is observed, never written)."""
    keys = set(query)
    if "reviews" in keys:
        if query["reviews"] != ["1"] or keys - {"reviews", "project"}:
            raise CarnetError("reviews invalide")
        project = query["project"][0] if "project" in keys else None
        if project is not None and not _ID_RE["proj"].match(project):
            raise CarnetError("Projet invalide")
        return reviews.list_reviews(project)
    if "review" in keys:
        if keys - {"review", "freshness"} or ("freshness" in keys and query["freshness"] != ["1"]):
            raise CarnetError("review invalide")
        got = reviews.get(query["review"][0])
        if "freshness" in keys:
            return {"ok": True, "review_id": got["review"]["id"], "rev": got["review"]["rev"], "freshness": evidence.freshness(got["review"])}
        return {"ok": True, **got}
    if "freshness" in keys:
        raise CarnetError("Paramètre inconnu")
    return None


def _phase5_get(query: dict[str, list[str]]) -> dict | None:
    """Phase 5 read-only views. Each form accepts EXACTLY its own keys; ``None`` means "not a Phase 5 query"."""
    keys = set(query)
    one = lambda k: query[k][0]  # noqa: E731
    if "cockpit" in keys:
        if keys != {"cockpit"}:
            raise CarnetError("cockpit invalide")
        return review.cockpit(one("cockpit"))
    if "snapshots" in keys:
        if query["snapshots"] != ["1"] or keys - {"snapshots", "project"}:
            raise CarnetError("snapshots invalide")
        project = one("project") if "project" in keys else None
        if project is not None and not _ID_RE["proj"].match(project):
            raise CarnetError("Projet invalide")
        return snapshots.list_snapshots(project)
    if "snapshot" in keys:
        if keys - {"snapshot", "verify", "view"} or ("verify" in keys and "view" in keys):
            raise CarnetError("snapshot invalide")
        if "verify" in keys:
            if query["verify"] != ["1"]:
                raise CarnetError("verify invalide")
            return snapshots.verify(one("snapshot"))
        view = one("view") if "view" in keys else "cockpit"
        if view == "cockpit":
            return review.snapshot_cockpit(one("snapshot"))
        if view == "full":
            return {"ok": True, **snapshots.get(one("snapshot"))}
        raise CarnetError("view invalide")
    if "baselines" in keys:
        if query["baselines"] != ["1"] or keys - {"baselines", "project", "page", "at"}:
            raise CarnetError("baselines invalide")
        return review.baselines(one("project") if "project" in keys else None, one("page") if "page" in keys else None, one("at") if "at" in keys else None)
    if "diff" in keys:
        if query["diff"] != ["1"] or keys - {"diff", "base", "to", "page", "project"} or "base" not in keys:
            raise CarnetError("diff invalide")
        return review.diff(one("base"), one("to") if "to" in keys else None, one("page") if "page" in keys else None, one("project") if "project" in keys else None)
    if keys & {"verify", "view", "base", "to", "project", "at"}:
        raise CarnetError("Paramètre inconnu")
    return None


def http_review_export(review_id: str) -> tuple[int, str, Any]:
    """``(200, filename, zip bytes)`` or ``(status, "", error payload)``. Read-only; the observation is made now, the stored pack is untouched."""
    try:
        got = reviews.get(review_id)
        pack = got["review"]
        data = evidence.export_zip(pack, evidence.freshness(pack), got["integrity"], rcomments.thread(pack["id"]))
        return 200, f"carnet-review-{pack['id']}-r{pack['rev']}.zip", data
    except reviews.ReviewError as e:
        return e.status, "", {"error": str(e), "code": e.code}
    except reviews.ReviewStorageError as e:
        return e.status, "", {"error": str(e), "code": e.code}
    except (annotations.AnnotationError, annotations.AnnotationStorageError) as e:  # the comment thread is part of the handoff: never silently dropped
        return e.status, "", {"error": str(e), "code": e.code}
    except OSError:
        return 503, "", {"error": "Carnet inaccessible", "code": "storage_error"}


def http_reader_pdf(qs: dict) -> tuple[int, Any, Any]:
    """``(200, name, (spool, size))`` or ``(status, "", error payload)``. Read-only. The hash is bound to the streamed bytes (see reader)."""
    try:
        context, sid = reader.parse_verified_query(qs)
        spool, size, name = reader.open_verified_pdf(context, sid)
        return 200, name, (spool, size)
    except reader.ReaderError as e:
        return e.status, "", {"error": str(e), "code": e.code}
    except OSError:
        return 503, "", {"error": "Carnet inaccessible", "code": "storage_error"}


_STAGE08 = {
    "bulk_preview": bulk.preview,
    "bulk_apply": bulk.apply,
    "bulk_undo": bulk.undo,
    "history_checkpoint": restore.checkpoint,
    "history_restore": restore.restore,
    "report_build": report.build,
    "snapshot_create": snapshots.create,
    "ask": review.ask,
    "portal_resolve": portals.resolve,  # Phase 8: READ-ONLY (a POST only because 100 references do not fit a query string)
    "reader_resolve": reader.resolve,  # Phase 9: READ-ONLY, identities in / captured-current-integrity out
    "annotation_list": annotations.list_targets,  # Phase 10: READ-ONLY, batched by target
    "annotation_create": annotations.mutate,  # Phase 10: live commentary (never evidence; never touches a page / source / review)
    "annotation_update": annotations.mutate,
    "annotation_delete": annotations.mutate,
    "rcomment_list": rcomments.mutate,  # Phase 10: READ-ONLY thread of one review
    "rcomment_add": rcomments.mutate,  # Phase 10: append-only review comment, request_id idempotent
}


def http_post(data: Any) -> tuple[int, dict]:
    try:
        if isinstance(data, dict) and data.get("action") == EXPORT_ACTION:
            return 200, export_copy(data)
        if isinstance(data, dict) and data.get("action") == TASK_ACTION:
            return 200, task_extract(data)
        if isinstance(data, dict) and isinstance(data.get("action"), str) and data["action"].startswith("source_"):
            return 200, sources.mutate(data)
        if isinstance(data, dict) and isinstance(data.get("action"), str) and data["action"].startswith("review_"):
            return 200, reviews.mutate(data)
        action = data.get("action") if isinstance(data, dict) else None
        if action in _STAGE08:
            return 200, _STAGE08[action](data)
        return 200, mutate(data)
    except (CarnetConflict, sources.SourceConflict, reviews.ReviewConflict, annotations.AnnotationError) as e:
        return e.status, getattr(e, "payload", None) or {"error": str(e), "code": e.code}
    except (history.HistoryError, snapshots.SnapshotError, reviews.ReviewError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except (history.HistoryStorageError, snapshots.SnapshotStorageError, reviews.ReviewStorageError, annotations.AnnotationStorageError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except (sources.SourceError, sources.SourceStorageError, portals.PortalError, reader.ReaderError) as e:
        return e.status, {"error": str(e), "code": e.code}
    except CarnetError as e:
        return e.status, {"error": str(e), "code": e.code}
    except (CarnetStorageError, CarnetTaskUnavailable) as e:
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


def http_voice_upload(read, length: Any, declared_mime: str | None) -> tuple[int, dict]:
    """``POST /api/carnet/voice``: raw-body voice upload. Every refusal is path-free."""
    try:
        return 200, voice.store_upload(read, length, declared_mime)
    except voice.VoiceError as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        return 503, {"error": "Enregistrement de la note vocale impossible", "code": "storage_error"}


def http_voice_usage() -> tuple[int, dict]:
    try:
        return 200, voice.usage()
    except voice.VoiceError as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        return 503, {"error": "Notes vocales inaccessibles", "code": "storage_error"}


def http_voice_transcribe(voice_id: str, read, length: Any) -> tuple[int, dict]:
    """``POST /api/carnet/voice/<id>/transcribe``: the optional adapter. 501 'Transcription non configurée' without an engine."""
    cmd_fn = _cb.get("transcribe_command")
    command = cmd_fn() if callable(cmd_fn) else None
    try:
        return 200, voice.transcribe(voice_id, read, length, command)
    except voice.VoiceError as e:
        return e.status, {"error": str(e), "code": e.code}
    except OSError:
        return 503, {"error": "Transcription impossible", "code": "transcribe_failed"}


def http_transcribe_status() -> tuple[int, dict]:
    cmd_fn = _cb.get("transcribe_command")
    return 200, voice.transcribe_status(cmd_fn() if callable(cmd_fn) else None)


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
    """Copy committed Carnet bytes into ``dest_dir``: ``notebook.json``, (Stage 05) ``sources.json``, (Stage 08) ``history.json`` and
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
    voices: set[str] = set()  # Phase 4: voice notes / transcript sources the notebook and history reference
    stems: set[str] = set()  # Phase 3: drawing stems the notebook / history reference (one-hop underlay closure)
    if payload is not None:
        try:
            parsed = json.loads(payload.decode("utf-8"))
            valid = isinstance(parsed, dict) and parsed.get("version") == VERSION and _usable(parsed)
        except (UnicodeDecodeError, json.JSONDecodeError):
            valid = False
        if valid:
            refs = referenced_assets(parsed)
            voices = referenced_voices(parsed)
            stems = referenced_drawings(parsed)
    try:
        src_payload, src_valid = sources.snapshot_bytes(root)
    except sources.SourceStorageError as e:
        raise CarnetStorageError(str(e)) from e
    try:
        hist_payload, hist_valid = history.snapshot_bytes(root)  # Stage 08: its own file, its own lock
    except history.HistoryStorageError as e:
        raise CarnetStorageError(str(e)) from e
    if hist_payload is not None and hist_valid:  # Stage 08: the media closure of every retained restore point travels with it
        try:
            hist_data = json.loads(hist_payload.decode("utf-8"))
            refs = refs | history.referenced_assets(hist_data)
            voices = voices | history.referenced_voices(hist_data)
            stems = stems | history.referenced_drawings(hist_data)
        except (UnicodeDecodeError, ValueError):
            hist_valid = False
    snap_closure = snapshots.closure(root)  # Phase 5: the write-once freezes and the media they pinned travel with the backup
    rev_closure = reviews.closure(root)  # Phase 7: every review pack file, byte-for-byte (no binaries: referenced material follows the closures above)
    ann_closure = annotations.closure(root)  # Phase 10: every live-annotation shard, byte-for-byte (a referenced source / PDF / page is NOT followed)
    rcm_closure = rcomments.closure(root)  # Phase 10: the comment thread of every EXISTING pack, byte-for-byte (an orphan thread is unreachable: skipped)
    refs = refs | snap_closure["assets"]
    voices = voices | snap_closure["voices"]
    stems = stems | snap_closure["stems"]
    drawings_report: dict | None = None
    if stems:
        # Dessiner owns the drawings (the legacy Inbox/ backup copies them). Carnet only follows ONE hop: the Stage-06 underlay
        # asset an annotation drawing needs. A missing drawing is a broken reference (counted, never fatal); a malformed one
        # makes the snapshot invalid (blocks retention) and contributes nothing.
        import hq_drawings

        try:
            found = hq_drawings.underlay_assets(Path(root), stems)
        except (OSError, hq_drawings.DrawingError):
            found = {"ids": set(), "missing": 0, "invalid": len(stems)}
        refs = refs | found["ids"]
        drawings_report = {"referenced": len(stems), "missing": found["missing"], "invalid": found["invalid"], "underlays": len(found["ids"])}
        if found["invalid"]:
            valid = False
    if payload is None and src_payload is None and hist_payload is None and not snap_closure["files"] and not rev_closure["files"] and rev_closure["valid"] \
            and not ann_closure["files"] and ann_closure["valid"] and not rcm_closure["files"] and rcm_closure["valid"]:
        return {"ok": True, "included": False, "status": "absent"}
    if refs:
        try:
            media.confined_assets_dir(root)  # a redirected assets directory is refused before anything is written
        except media.MediaError as e:
            raise CarnetStorageError(str(e), e.status if e.status >= 500 else 409) from e
    if voices:
        try:
            voice.confined_voice_dir(root)  # a redirected voice directory is refused before anything is written
        except voice.VoiceError as e:
            raise CarnetStorageError(str(e), e.status if e.status >= 500 else 409) from e
    dest_dir.mkdir(parents=True, exist_ok=True)
    if payload is not None:
        _write_exclusive(dest_dir / FILE_NAME, payload)
    if src_payload is not None:
        _write_exclusive(dest_dir / sources.FILE_NAME, src_payload)
    if hist_payload is not None:
        _write_exclusive(dest_dir / history.FILE_NAME, hist_payload)
    snap_report: dict | None = None
    if snap_closure["files"] or not snap_closure["valid"]:
        if snap_closure["files"]:
            (dest_dir / snapshots.SNAP_DIR).mkdir(parents=True, exist_ok=True)
            snap_bytes = snapshots.copy_to(root, dest_dir / snapshots.SNAP_DIR, snap_closure["files"])
        else:
            snap_bytes = 0
        snap_report = {"count": len(snap_closure["files"]), "bytes": snap_bytes, "valid": bool(snap_closure["valid"])}
        if not snap_closure["valid"]:
            valid = False
    rev_report: dict | None = None
    if rev_closure["files"] or not rev_closure["valid"]:
        if rev_closure["files"]:
            (dest_dir / reviews.REV_DIR).mkdir(parents=True, exist_ok=True)
            rev_bytes = reviews.copy_to(root, dest_dir / reviews.REV_DIR, rev_closure["files"])
        else:
            rev_bytes = 0
        rev_report = {"count": len(rev_closure["files"]), "bytes": rev_bytes, "valid": bool(rev_closure["valid"])}
        if not rev_closure["valid"]:
            valid = False
    ann_refused: list = []
    rcm_refused: list = []
    ann_report: dict | None = None
    if ann_closure["files"] or not ann_closure["valid"]:
        if ann_closure["files"]:
            (dest_dir / annotations.ANN_DIR).mkdir(parents=True, exist_ok=True)
            ann_bytes = annotations.copy_to(root, dest_dir / annotations.ANN_DIR, ann_closure["files"], ann_refused)
        else:
            ann_bytes = 0
        ann_report = {"count": len(ann_closure["files"]) - len(ann_refused), "bytes": ann_bytes, "valid": bool(ann_closure["valid"]) and not ann_refused}
        if ann_refused:
            ann_report["refused"] = len(ann_refused)  # redirected / replaced / vanished between validation and copy: never followed, not copied
        if not ann_closure["valid"] or ann_refused:
            valid = False
    rcm_report: dict | None = None
    if rcm_closure["files"] or not rcm_closure["valid"]:
        if rcm_closure["files"]:
            (dest_dir / rcomments.COMMENT_DIR).mkdir(parents=True, exist_ok=True)
            rcm_bytes = rcomments.copy_to(root, dest_dir / rcomments.COMMENT_DIR, rcm_closure["files"], rcm_refused)
        else:
            rcm_bytes = 0
        rcm_report = {"count": len(rcm_closure["files"]) - len(rcm_refused), "bytes": rcm_bytes, "valid": bool(rcm_closure["valid"]) and not rcm_refused}
        if rcm_refused:
            rcm_report["refused"] = len(rcm_refused)  # redirected / replaced / vanished between validation and copy: never followed, not copied
        if not rcm_closure["valid"] or rcm_refused:
            valid = False
    assets_report: dict | None = None
    if refs:
        assets_report = media.copy_assets_to(root, sorted(refs), dest_dir / "assets")
        if assets_report["missing"]:
            valid = False
    voice_report: dict | None = None
    if voices:
        voice_report = voice.copy_voices_to(root, sorted(voices), dest_dir / "voice")
        if voice_report["missing"]:
            valid = False
    out: dict = {"ok": True, "included": True, "status": "included", "bytes": len(payload or b""), "valid": bool(valid and src_valid and hist_valid)}
    if src_payload is not None:  # the accepted Stage-01 status shape is unchanged when there are no sources
        out["sources"] = {"bytes": len(src_payload), "valid": bool(src_valid)}
    if hist_payload is not None:  # ... and when there is no history
        out["history"] = {"bytes": len(hist_payload), "valid": bool(hist_valid)}
    if snap_report is not None:  # ... and when there are no snapshots
        out["snapshots"] = snap_report
    if rev_report is not None:  # ... and when there are no review packs
        out["reviews"] = rev_report
    if ann_report is not None:  # ... and when there are no live annotations
        out["annotations"] = ann_report
    if rcm_report is not None:  # ... and when there are no review comments
        out["review_comments"] = rcm_report
    if assets_report is not None:  # ... and when there are no images
        out["assets"] = assets_report
    if drawings_report is not None:  # ... and when there are no drawing references
        out["drawings"] = drawings_report
    if voice_report is not None:  # ... and when there are no voice notes
        out["voice"] = voice_report
    return out
