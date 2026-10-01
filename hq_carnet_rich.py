"""Carnet Stage 04: structured content model (pure functions, stdlib only).

Content V2 (never HTML, never a free-form tree)::

    {"version": 2, "blocks": [
        {"id": "block-…", "type": "paragraph|heading|bullet|number|check",
         "text": "one line, no newline", "marks": [...], "checked": bool  # check only
        }]}

A page is a list of one-line blocks; the flat page text is ``"\\n".join(texts)``.
Marks are inline ranges over the block text, in UTF-16 code units (the unit a browser
uses), never splitting a surrogate pair::

    {"type": "bold|italic|underline|highlight|code", "start": 0, "end": 3}
    {"type": "link", "start": 0, "end": 3, "href": "https://…"}                 # http/https only
    {"type": "link", "start": 0, "end": 3, "ref": {"kind": "note", "id": "page-…"}}

Legacy V1 content (one text block ``{"id","type":"text","text","marks":[]}``) stays valid
forever and is migrated LAZILY, page by page, only when that page is written:

- reads never convert anything (a V1 page is served as-is; the browser understands it);
- writing a plain page that fits (<= ``BLOCKS_MAX`` lines and inside the notebook line budget)
  stores it as V2; a plain page that does not fit stays a compact V1 block (no text lost, no
  amplification) — but ONLY while it is still legacy V1: an existing V2 page is never downgraded
  (its block ids would be lost), growth beyond the limits is refused instead; structured content
  that does not fit is refused, never truncated;
- block ids are server-owned: a client may send an id only if it already belongs to that page;
  blocks without an id are new and get a random id.

A ``citation`` mark (Stage 05) is an ATOM over the visible label text::

    {"type": "citation", "start": 0, "end": 18, "cite": {
        "src": "srce-…",                       # source EDITION id (never a family, never derived from text)
        "loc": {"kind": "page|section|clause|chapter|figure|table|custom", "text": "417"},
        "pdf": 439,                             # actual PDF page index (1-based) or null: NOT the printed page
        "ok": false,                            # user-verified LOCATION only (never "the information is true")
        "snap": {"title": "…", "author": "…", "edition": "12e", "year": 2026, "ident": "…"},  # bounded essential snapshot
        "from": null | {"src": "srce-…", "loc": {...}, "pdf": 416|null, "ok": bool}}}       # migration provenance

Citations are never merged (two identical adjacent citations stay two), never overlap each other or a
link, and take part in canonical equality like every other mark.

An ``image`` block (Stage 06, additive: pages without images are byte-identical to Stage 05) carries
only bounded metadata, never bytes or a path::

    {"id": "block-…", "type": "image", "text": "", "marks": [],
     "asset": {"id": "asset-<24 hex>", "mime": "image/jpeg|png|webp", "w": 1600, "h": 1200,
               "width": 30..100,            # percent of the content width
               "layout": "inline"|"center"|"right",  # bounded alignment in the flow (no free position; old images are "inline")
               "caption": "one line"}}

``text`` is always empty (an image line occupies no text offset: marks, find/replace and titles never touch
it) and ``marks`` is always empty. The caption lives in ``asset.caption``.

Engineering blocks (Stage 07, additive: pages without them are byte-identical to Stage 06) carry one bounded,
declarative payload under a key named like the block type (see ``hq_carnet_eng``)::

    {"id": "block-…", "type": "calc",     "text": "", "marks": [], "calc":     {expr, result, unit, at, v}}
    {"id": "block-…", "type": "measure",  "text": "", "marks": [], "measure":  {label, observed, mode, nominal, tol, at, link}}
    {"id": "block-…", "type": "decision", "text": "one line", "marks": [...], "decision": {at}}

``calc`` and ``measure`` are atoms (no text, no marks); a ``decision`` is an ordinary text line. Nothing executable is ever
stored and a stored result is never recomputed silently.

Structured blocks (Product Phase 2, additive: pages without them are byte-identical to Phase 1) are ATOMS too (``text`` is
always ``""`` and ``marks`` always ``[]``, so offsets, marks, find/replace, titles and previews never touch them). Each carries
one bounded payload under its own key; every string is one line (no C0/DEL/C1 control, no U+2028/9, no unpaired surrogate)
except the explicit multi-line ``body`` fields::

    {"type": "table",      "table":   {"header": bool, "rows": [[cell, ...], ...]}}         # 1-20 rows x 1-10 cols, rectangular
    {"type": "callout",    "callout": {"kind": "note|info|warning", "title": "", "body": "lines\nof text"}}
    {"type": "toggle",     "toggle":  {"summary": "one line", "body": "lines\nof plain text"}}  # nesting depth 0: never child blocks
    {"type": "imagegroup", "group":   {"layout": "two|three|compare", "items": [{id, mime, w, h, caption}, ...]}}

Collapsed/expanded state of a toggle is UI state and never stored. ``structured_bytes`` (the UTF-8 size of the visible
structured strings, NOT of the JSON) is bounded per page. Image-group children are Stage-06 assets: ``assets_of`` yields them,
so backup closure, history, export and the media checks see them like any other image.

Canonical form: marks sorted, non-empty, same-type/same-target marks merged when they
overlap or touch. The browser (``hq-carnet-rich.js``) implements the same rules; the
shared vectors in the tests keep both in step. Page text never appears in errors.
"""

from __future__ import annotations

import copy
import json
import re
import secrets
import unicodedata
from typing import Any
from urllib.parse import urlsplit

import hq_carnet_eng as eng

CONTENT_VERSION = 2
LEGACY_CONTENT_VERSION = 1

TABLE_TYPE, CALLOUT_TYPE, TOGGLE_TYPE, GROUP_TYPE = "table", "callout", "toggle", "imagegroup"
DRAWING_TYPE = "drawing"  # Phase 3: a reference to ONE immutable Dessiner stem; Dessiner owns the drawing, Carnet stores only the id
STRUCT_TYPES = (TABLE_TYPE, CALLOUT_TYPE, TOGGLE_TYPE, GROUP_TYPE, DRAWING_TYPE)
STRUCT_KEY = {TABLE_TYPE: "table", CALLOUT_TYPE: "callout", TOGGLE_TYPE: "toggle", GROUP_TYPE: "group", DRAWING_TYPE: "drawing"}  # block type -> payload key
BLOCK_TYPES = ("paragraph", "heading", "bullet", "number", "check", "image") + eng.ENG_TYPES + STRUCT_TYPES
TABLE_ROWS_MAX, TABLE_COLS_MAX = 20, 10
CELL_U16_MAX, CELL_BYTES_MAX = 200, 800
TABLE_BYTES_MAX = 16 * 1024  # UTF-8 bytes of all cells of one table
TABLES_PER_PAGE_MAX = 20
CALLOUT_KINDS = ("note", "info", "warning")
CALLOUT_TITLE_MAX, CALLOUT_BODY_MAX, CALLOUT_BODY_LINES_MAX = 120, 2000, 20
TOGGLE_SUMMARY_MAX, TOGGLE_BODY_MAX, TOGGLE_BODY_LINES_MAX = 160, 4000, 50
NOTES_PER_PAGE_MAX = 100  # callouts + toggles
GROUP_LAYOUTS = {"two": 2, "three": 3, "compare": 2}  # layout -> exact number of children
GROUP_ITEM_KEYS = {"id", "mime", "w", "h", "caption"}
GROUPS_PER_PAGE_MAX = 16
DRAWINGS_PER_PAGE_MAX = 32
STRUCT_BYTES_MAX = 96 * 1024  # visible structured text per page (UTF-8 bytes of the strings, never the JSON overhead)
IMAGE_TYPE = "image"  # Stage 06 (additive to V2): metadata only, see ``check_asset``
ASSET_ID_RE = re.compile(r"^asset-[0-9a-f]{24}\Z")
ASSET_MIMES = ("image/jpeg", "image/png", "image/webp")
ASSET_LONG_SIDE_MAX = 2560
ASSET_WIDTH_MIN, ASSET_WIDTH_MAX = 30, 100
ASSET_CAPTION_MAX = 300
IMAGES_PER_PAGE_MAX = 32
ENG_ATOMS_PER_PAGE_MAX = 50  # calc + measure atoms per page (bounds the notebook file size)
DECISIONS_PER_PAGE_MAX = 100
ASSET_KEYS = {"id", "mime", "w", "h", "width", "layout", "caption"}
ASSET_LAYOUTS = ("inline", "center", "right")
INLINE_MARKS = ("bold", "italic", "underline", "highlight", "code")
MARK_ORDER = INLINE_MARKS + ("link", "citation")
REF_KINDS = ("note", "file", "drawing", "model", "media", "project")
LOCATOR_KINDS = ("page", "section", "clause", "chapter", "figure", "table", "custom")
LOCATOR_TEXT_MAX = 120
CITE_PAGE_MAX = 100000
_EDITION_ID_RE = re.compile(r"^srce-[A-Za-z0-9_-]{1,64}\Z")

BLOCKS_MAX = 8192  # V2 lines per page (a longer plain page stays a compact V1 block)
NOTEBOOK_BLOCKS_MAX = 40000  # stored blocks over all pages incl. trash (a V1 page counts 1): bounds the file size
MARKS_PER_BLOCK_MAX = 128
MARKS_TOTAL_MAX = 4000
HREF_MAX = 2048
REF_PATH_MAX = 512

MODEL_EXT = (".glb", ".stl", ".obj", ".3mf")
MEDIA_EXT = (".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".mp4", ".mov", ".m4v", ".webm", ".mp3", ".m4a", ".wav")

_BLOCK_ID_RE = re.compile(r"^block-[A-Za-z0-9_-]{1,64}\Z")
_PAGE_ID_RE = re.compile(r"^page-[A-Za-z0-9_-]{1,64}\Z")
_PROJECT_ID_RE = re.compile(r"^proj-[A-Za-z0-9_-]{1,64}\Z")
_STEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,119}\Z")
_TEXT_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_URL_BAD_RE = re.compile(r"[\x00-\x20\x7f\\<>\"'`]")
_DEFAULT_FOLDERS = ("Inbox", "Uni", "Print")


class ContentError(ValueError):
    """Invalid content (mapped to a 400 validation error by hq_carnet). Never carries text."""


# ---------------------------------------------------------------- helpers


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def u16_len(text: str) -> int:
    return sum(2 if ord(ch) > 0xFFFF else 1 for ch in text)


def _u16_units(text: str) -> list[int]:
    data = text.encode("utf-16-le")
    return [data[i] | (data[i + 1] << 8) for i in range(0, len(data), 2)]


def new_block_id() -> str:
    return "block-" + secrets.token_hex(12)


def flat_text(content: dict) -> str:
    return "\n".join(block["text"] for block in content["blocks"])


def is_plain(content: dict) -> bool:
    """True when the content carries no structure at all (only plain paragraphs)."""
    return all(block["type"] in ("paragraph", "text") and not block["marks"] for block in content["blocks"])


def content_ids(content: dict) -> list[str]:
    return [block["id"] for block in content["blocks"]]


# ---------------------------------------------------------------- links


def safe_href(value: Any) -> str:
    """Return ``value`` when it is a plain http(s) URL with a host; else raise ContentError."""
    if not isinstance(value, str) or not value or len(value) > HREF_MAX:
        raise ContentError("Lien invalide")
    if _URL_BAD_RE.search(value):
        raise ContentError("Lien invalide")
    lowered = value.lower()
    if not (lowered.startswith("http://") or lowered.startswith("https://")):
        raise ContentError("Lien non autorisé (http/https uniquement)")
    try:
        parts = urlsplit(value)
        host = parts.hostname
        parts.port  # noqa: B018 - raises ValueError on a malformed port
    except ValueError as e:
        raise ContentError("Lien invalide") from e
    if parts.scheme.lower() not in ("http", "https") or not host or "@" in parts.netloc:
        raise ContentError("Lien invalide")
    return value


def _valid_rel(rel: Any, folders: tuple[str, ...] | None, system_names: frozenset[str]) -> str:
    """Structural path check. ``folders=None`` (stored data) skips root membership: a later
    change of the configured roots must never make a stored notebook look malformed."""
    if not isinstance(rel, str) or not rel or len(rel) > REF_PATH_MAX:
        raise ContentError("Référence invalide")
    if "\\" in rel or "%" in rel or _TEXT_CTRL_RE.search(rel) or "\n" in rel or "\r" in rel or "\t" in rel:
        raise ContentError("Référence invalide")
    parts = rel.split("/")
    if len(parts) < 2 or (folders is not None and parts[0] not in folders):
        raise ContentError("Référence invalide")
    for part in parts:
        if not part or part in (".", "..") or part.startswith(".") or part.lower() in system_names:
            raise ContentError("Référence invalide")
        if part != part.strip() or ":" in part or part.endswith("."):
            raise ContentError("Référence invalide")
    return rel


def check_ref(ref: Any, folders: tuple[str, ...] | None = _DEFAULT_FOLDERS, system_names: frozenset[str] = frozenset()) -> dict:
    """Validate an internal stable reference; returns a fresh canonical dict."""
    if not isinstance(ref, dict) or set(ref) != {"kind", "id"}:
        raise ContentError("Référence invalide")
    kind, ident = ref["kind"], ref["id"]
    if kind not in REF_KINDS or not isinstance(ident, str):
        raise ContentError("Référence invalide")
    if kind == "note":
        if not _PAGE_ID_RE.match(ident):
            raise ContentError("Référence invalide")
    elif kind == "project":
        if not _PROJECT_ID_RE.match(ident):
            raise ContentError("Référence invalide")
    elif kind == "drawing":
        if not _STEM_RE.match(ident):
            raise ContentError("Référence invalide")
    else:
        _valid_rel(ident, folders, system_names)
        lowered = ident.lower()
        if kind == "model" and not lowered.endswith(MODEL_EXT):
            raise ContentError("Référence invalide")
        if kind == "media" and not lowered.endswith(MEDIA_EXT):
            raise ContentError("Référence invalide")
    return {"kind": kind, "id": ident}


# ---------------------------------------------------------------- citations


# Whitespace is an EXPLICIT set shared with the browser (assets/hq-carnet-rich.js WS): never a language default
# (Python str.split and ECMAScript \s disagree on U+0085, U+FEFF, U+001C..U+001F). C0/C1 controls are refused, not folded.
WS_CHARS = " \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
_WS_RE = re.compile("[" + WS_CHARS + "]+")
_CITE_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")


def norm_ws(value: str) -> str:
    return " ".join(part for part in _WS_RE.split(value) if part)


def _cite_text(value: Any, limit: int, label: str, *, required: bool = False) -> str:
    if not isinstance(value, str) or _CITE_CTRL_RE.search(value) or "\n" in value or "\r" in value or "\t" in value:
        raise ContentError(f"{label} invalide")
    out = norm_ws(value)
    if (required and not out) or u16_len(out) > limit:  # UTF-16 units, like the browser and the Stage-04 offsets
        raise ContentError(f"{label} invalide")
    try:
        out.encode("utf-8")
    except UnicodeEncodeError as e:
        raise ContentError(f"{label} invalide") from e
    return out


def check_locator(loc: Any, verified: bool = False) -> dict:
    if not isinstance(loc, dict) or set(loc) != {"kind", "text"} or loc["kind"] not in LOCATOR_KINDS:
        raise ContentError("Emplacement invalide")
    text = _cite_text(loc["text"], LOCATOR_TEXT_MAX, "Emplacement")
    return {"kind": loc["kind"], "text": text}


def _check_pdf(value: Any) -> int | None:
    if value is None:
        return None
    if not _is_int(value) or not (1 <= value <= CITE_PAGE_MAX):
        raise ContentError("Page PDF invalide")
    return value


def check_cite(cite: Any) -> dict:
    """Validate a citation payload into its canonical (fixed key order) form. Raises ContentError."""
    if not isinstance(cite, dict) or set(cite) != {"src", "loc", "pdf", "ok", "snap", "from"}:
        raise ContentError("Citation invalide")
    src = cite["src"]
    if not isinstance(src, str) or not _EDITION_ID_RE.match(src) or not isinstance(cite["ok"], bool):
        raise ContentError("Citation invalide")
    loc = check_locator(cite["loc"])
    pdf = _check_pdf(cite["pdf"])
    if cite["ok"] and not loc["text"] and pdf is None:
        raise ContentError("Un emplacement vérifié doit avoir un emplacement")  # nothing to have verified
    snap_in = cite["snap"]
    if not isinstance(snap_in, dict) or not set(snap_in) <= {"title", "author", "edition", "year", "ident"} or "title" not in snap_in:
        raise ContentError("Citation invalide")
    snap: dict[str, Any] = {"title": _cite_text(snap_in["title"], 200, "Titre", required=True)}
    for key, limit in (("author", 120), ("edition", 40), ("ident", 60)):
        if key in snap_in:
            snap[key] = _cite_text(snap_in[key], limit, "Citation", required=True)
    if "year" in snap_in:
        if not _is_int(snap_in["year"]) or not (1400 <= snap_in["year"] <= 2200):
            raise ContentError("Citation invalide")
        snap["year"] = snap_in["year"]
    origin = cite["from"]
    if origin is not None:
        if not isinstance(origin, dict) or set(origin) != {"src", "loc", "pdf", "ok"}:
            raise ContentError("Citation invalide")
        if not isinstance(origin["src"], str) or not _EDITION_ID_RE.match(origin["src"]) or not isinstance(origin["ok"], bool):
            raise ContentError("Citation invalide")
        origin = {"src": origin["src"], "loc": check_locator(origin["loc"]), "pdf": _check_pdf(origin["pdf"]), "ok": origin["ok"]}
    return {"src": src, "loc": loc, "pdf": pdf, "ok": cite["ok"], "snap": snap, "from": origin}


def cite_key(cite: dict) -> str:
    return json.dumps(cite, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


# ---------------------------------------------------------------- marks


def _target(mark: dict) -> tuple:
    if mark["type"] == "citation":
        return ("c", cite_key(mark["cite"]))
    if mark["type"] != "link":
        return ()
    if "href" in mark:
        return ("h", mark["href"])
    return ("r", mark["ref"]["kind"], mark["ref"]["id"])


def canonical_marks(marks: list[dict]) -> list[dict]:
    """Merge overlapping/touching marks of the same type (+ link target); sort. Input is valid."""
    groups: dict[tuple, list[list[Any]]] = {}
    cites = [m for m in marks if m["type"] == "citation"]
    marks = [m for m in marks if m["type"] != "citation"]  # a citation is an atom: never merged
    for mark in marks:
        key = (mark["type"],) + _target(mark)
        groups.setdefault(key, []).append([mark["start"], mark["end"], mark])
    merged: list[dict] = []
    for key, ranges in groups.items():
        ranges.sort(key=lambda r: (r[0], r[1]))
        cur = None
        for start, end, mark in ranges:
            if cur is not None and start <= cur[1]:
                cur[1] = max(cur[1], end)
                continue
            if cur is not None:
                merged.append(_with_range(cur[2], cur[0], cur[1]))
            cur = [start, end, mark]
        if cur is not None:
            merged.append(_with_range(cur[2], cur[0], cur[1]))
    merged.extend(_with_range(m, m["start"], m["end"]) for m in cites)
    merged.sort(key=lambda m: (m["start"], m["end"], MARK_ORDER.index(m["type"]), _target(m)))
    # Two different links may never overlap (a character has at most one link target).
    links = [m for m in merged if m["type"] == "link"]
    for a, b in zip(links, links[1:]):
        if b["start"] < a["end"]:
            raise ContentError("Liens superposés")
    # Citations never overlap each other nor a link (the atom is one indivisible reference).
    atoms = [m for m in merged if m["type"] == "citation"]
    for a, b in zip(atoms, atoms[1:]):
        if b["start"] < a["end"]:
            raise ContentError("Citations superposées")
    for atom in atoms:
        for link in links:
            if atom["start"] < link["end"] and link["start"] < atom["end"]:
                raise ContentError("Citation et lien superposés")
    return merged


def _with_range(mark: dict, start: int, end: int) -> dict:
    out = dict(mark)
    out["start"] = start
    out["end"] = end
    return out


def _check_marks(text: str, raw: Any, folders: tuple[str, ...] | None, system_names: frozenset[str]) -> list[dict]:
    if raw is None:
        raw = []
    if not isinstance(raw, list) or len(raw) > MARKS_PER_BLOCK_MAX:
        raise ContentError("Mise en forme invalide")
    if not raw:
        return []
    size = u16_len(text)
    units = _u16_units(text)
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ContentError("Mise en forme invalide")
        kind = item.get("type")
        if kind not in MARK_ORDER:
            raise ContentError("Mise en forme non prise en charge")
        allowed = {"type", "start", "end"}
        if kind == "citation":
            allowed = allowed | {"cite"}
        if kind == "link":
            allowed = allowed | ({"href"} if "href" in item else {"ref"})
            if ("href" in item) == ("ref" in item):
                raise ContentError("Lien invalide")
        if set(item) != allowed:
            raise ContentError("Mise en forme invalide")
        start, end = item["start"], item["end"]
        if not _is_int(start) or not _is_int(end) or not (0 <= start < end <= size):
            raise ContentError("Mise en forme hors limites")
        for edge in (start, end):
            if edge < size and 0xDC00 <= units[edge] <= 0xDFFF:
                raise ContentError("Mise en forme hors limites")
        mark: dict[str, Any] = {"type": kind, "start": start, "end": end}
        if kind == "citation":
            mark["cite"] = check_cite(item["cite"])
        if kind == "link":
            if "href" in item:
                mark["href"] = safe_href(item["href"])
            else:
                mark["ref"] = check_ref(item["ref"], folders, system_names)
        out.append(mark)
    return canonical_marks(out)


# ---------------------------------------------------------------- content validation


_CAPTION_CTRL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")  # C0 (tab, CR, LF), DEL, C1 (NEL), U+2028/U+2029 line/paragraph separators: one line


def check_caption(caption: Any) -> str:
    """Image caption rule, identical in the browser (hq-carnet-rich.js ``captionOk``): a string stored as-is, no C0/DEL/C1
    control and no U+2028/U+2029 (so no tab/CR/LF/NEL or Unicode line break), no unpaired surrogate, at most ``ASSET_CAPTION_MAX`` UTF-16 code units."""
    if not isinstance(caption, str) or _CAPTION_CTRL_RE.search(caption) or u16_len(caption) > ASSET_CAPTION_MAX:
        raise ContentError("Légende invalide")
    try:
        caption.encode("utf-8")  # an unpaired surrogate cannot be encoded
    except UnicodeEncodeError as e:
        raise ContentError("Légende invalide") from e
    return caption


def check_asset(asset: Any) -> dict:
    """Validate the bounded metadata of an image block. Returns a clean copy. Never carries client text."""
    if not isinstance(asset, dict) or set(asset) != ASSET_KEYS:
        raise ContentError("Image invalide")
    ident = asset["id"]
    if not isinstance(ident, str) or not ASSET_ID_RE.match(ident):
        raise ContentError("Image invalide")
    if asset["mime"] not in ASSET_MIMES:
        raise ContentError("Image invalide")
    for key in ("w", "h"):
        if not _is_int(asset[key]) or not 1 <= asset[key] <= ASSET_LONG_SIDE_MAX:
            raise ContentError("Image invalide")
    width = asset["width"]
    if not _is_int(width) or not ASSET_WIDTH_MIN <= width <= ASSET_WIDTH_MAX:
        raise ContentError("Largeur d'image invalide")
    layout = asset["layout"]
    if not isinstance(layout, str) or layout not in ASSET_LAYOUTS:
        raise ContentError("Disposition d'image non prise en charge")
    caption = check_caption(asset["caption"])
    return {"id": ident, "mime": asset["mime"], "w": asset["w"], "h": asset["h"], "width": width, "layout": layout, "caption": caption}


def asset_key(asset: dict) -> tuple:
    """Identity of the stored file an image block points at (what the server must verify on the real file)."""
    return (asset["id"], asset["mime"], asset["w"], asset["h"])


def block_assets(block: dict) -> list[dict]:
    """Every stored image asset a block points at: the image itself, or the children of an image group (Phase 2)."""
    if not isinstance(block, dict):
        return []
    kind = block.get("type")
    if kind == IMAGE_TYPE and isinstance(block.get("asset"), dict):
        return [block["asset"]]
    if kind == GROUP_TYPE and isinstance(block.get("group"), dict) and isinstance(block["group"].get("items"), list):
        return [a for a in block["group"]["items"] if isinstance(a, dict)]
    return []


def block_drawings(block: dict) -> list[str]:
    """Drawing stems a block references: a drawing block, or an inline link mark to a drawing (Phase 3 backup closure)."""
    if not isinstance(block, dict):
        return []
    out = []
    if block.get("type") == DRAWING_TYPE and isinstance(block.get("drawing"), dict) and isinstance(block["drawing"].get("id"), str):
        out.append(block["drawing"]["id"])
    for mark in block.get("marks") or []:
        ref = mark.get("ref") if isinstance(mark, dict) and mark.get("type") == "link" else None
        if isinstance(ref, dict) and ref.get("kind") == "drawing" and isinstance(ref.get("id"), str):
            out.append(ref["id"])
    return [x for x in out if _STEM_RE.match(x)]


def drawings_of(content: dict) -> list[str]:
    return [d for b in content["blocks"] for d in block_drawings(b)]


def assets_of(content: dict) -> list[dict]:
    """All image assets of a page in document order (single images AND image-group children): the ONE scanner that backup
    closure, media verification, export packaging and the report use."""
    return [a for b in content["blocks"] for a in block_assets(b)]


# ---------------------------------------------------------------- structured blocks (Phase 2)


def _struct_line(value: Any, limit: int, label: str, *, allow_empty: bool = True) -> str:
    """One line of visible structured text: same rule as an image caption (no control, no line separator, no unpaired surrogate)."""
    if not isinstance(value, str) or _CAPTION_CTRL_RE.search(value) or u16_len(value) > limit or (not allow_empty and not value):
        raise ContentError(f"{label} invalide")
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as e:
        raise ContentError(f"{label} invalide") from e
    return value


def _struct_body(value: Any, limit: int, max_lines: int, label: str) -> str:
    """Several lines separated by ``\n`` only; every line follows the one-line rule (no CR, tab or other control)."""
    if not isinstance(value, str) or u16_len(value) > limit:
        raise ContentError(f"{label} invalide")
    lines = value.split("\n")
    if len(lines) > max_lines:
        raise ContentError(f"{label} invalide")
    for line in lines:
        _struct_line(line, limit, label)
    return value


def check_table(table: Any) -> dict:
    if not isinstance(table, dict) or set(table) != {"header", "rows"} or not isinstance(table["header"], bool):
        raise ContentError("Tableau invalide")
    rows = table["rows"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= TABLE_ROWS_MAX:
        raise ContentError("Tableau invalide")
    width = None
    total = 0
    out = []
    for row in rows:
        if not isinstance(row, list) or not 1 <= len(row) <= TABLE_COLS_MAX or (width is not None and len(row) != width):
            raise ContentError("Tableau invalide")
        width = len(row)
        clean = []
        for cell in row:
            text = _struct_line(cell, CELL_U16_MAX, "Cellule")
            size = len(text.encode("utf-8"))
            if size > CELL_BYTES_MAX:
                raise ContentError("Cellule invalide")
            total += size
            clean.append(text)
        out.append(clean)
    if total > TABLE_BYTES_MAX:
        raise ContentError("Tableau trop volumineux")
    return {"header": table["header"], "rows": out}


def check_callout(callout: Any) -> dict:
    if not isinstance(callout, dict) or set(callout) != {"kind", "title", "body"} or callout["kind"] not in CALLOUT_KINDS:
        raise ContentError("Encadré invalide")
    return {
        "kind": callout["kind"],
        "title": _struct_line(callout["title"], CALLOUT_TITLE_MAX, "Titre d'encadré"),
        "body": _struct_body(callout["body"], CALLOUT_BODY_MAX, CALLOUT_BODY_LINES_MAX, "Texte d'encadré"),
    }


def check_toggle(toggle: Any) -> dict:
    if not isinstance(toggle, dict) or set(toggle) != {"summary", "body"}:
        raise ContentError("Section repliable invalide")
    return {
        "summary": _struct_line(toggle["summary"], TOGGLE_SUMMARY_MAX, "Résumé", allow_empty=False),
        "body": _struct_body(toggle["body"], TOGGLE_BODY_MAX, TOGGLE_BODY_LINES_MAX, "Texte de section"),
    }


def check_group(group: Any) -> dict:
    """Image group: 2 or 3 distinct Stage-06 assets. Each child is validated with the SAME checks as a single image (id shape,
    mime, bounded dimensions, caption); the server additionally verifies the real files (see hq_carnet ``_verify_media``)."""
    if not isinstance(group, dict) or set(group) != {"layout", "items"} or group["layout"] not in GROUP_LAYOUTS:
        raise ContentError("Groupe d'images invalide")
    items = group["items"]
    if not isinstance(items, list) or len(items) != GROUP_LAYOUTS[group["layout"]]:
        raise ContentError("Groupe d'images invalide")
    out = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or set(item) != GROUP_ITEM_KEYS:
            raise ContentError("Groupe d'images invalide")
        full = check_asset({**item, "width": ASSET_WIDTH_MAX, "layout": "inline"})
        if full["id"] in seen:
            raise ContentError("Image en double dans le groupe")
        seen.add(full["id"])
        out.append({k: full[k] for k in ("id", "mime", "w", "h", "caption")})
    return {"layout": group["layout"], "items": out}


def check_drawing(drawing: Any) -> dict:
    """Drawing reference: EXACTLY ``{"id": <stem>}`` (the canonical Dessiner stem). No name, thumbnail, path, URL or drawing state:
    existence and access are resolved by Dessiner's own API, never trusted from the browser."""
    if not isinstance(drawing, dict) or set(drawing) != {"id"} or not isinstance(drawing["id"], str) or not _STEM_RE.match(drawing["id"]):
        raise ContentError("Référence de croquis invalide")
    return {"id": drawing["id"]}


_DRAWING_SUFFIX_RE = re.compile(r"_HQWeb(?:-Mobile|-Desktop)?\Z")


def drawing_label(stem: str) -> str:
    """Readable name derived from the stem itself (the stem already carries the user's base name); never stored."""
    return _DRAWING_SUFFIX_RE.sub("", stem) or stem


_STRUCT_CHECK = {TABLE_TYPE: check_table, CALLOUT_TYPE: check_callout, TOGGLE_TYPE: check_toggle, GROUP_TYPE: check_group, DRAWING_TYPE: check_drawing}


def check_struct(kind: str, payload: Any) -> dict:
    return _STRUCT_CHECK[kind](payload)


def structured_strings(block: dict) -> list[str]:
    """The visible user text of a structured block, in reading order (cells, titles, bodies, captions)."""
    kind = block.get("type")
    if kind == TABLE_TYPE:
        return [cell for row in block["table"]["rows"] for cell in row]
    if kind == CALLOUT_TYPE:
        return [x for x in (block["callout"]["title"], block["callout"]["body"]) if x]
    if kind == TOGGLE_TYPE:
        return [x for x in (block["toggle"]["summary"], block["toggle"]["body"]) if x]
    if kind == GROUP_TYPE:
        return [a["caption"] for a in block["group"]["items"] if a["caption"]]
    return []


def structured_bytes(content: dict) -> int:
    """UTF-8 size of the visible structured strings of a page (not the JSON size)."""
    if content.get("version") != CONTENT_VERSION:
        return 0
    return sum(len(x.encode("utf-8")) for b in content["blocks"] for x in structured_strings(b))


def text_bytes(content: dict) -> int:
    """Notebook budget size of a page: its flat text plus its visible structured text."""
    return len(flat_text(content).encode("utf-8")) + structured_bytes(content)


def search_text(content: dict) -> str:
    """Visible text for library search: the flat text followed by the structured strings (never any key, kind or id)."""
    extra = [x for b in content["blocks"] if b.get("type") in STRUCT_TYPES for x in structured_strings(b)] if content.get("version") == CONTENT_VERSION else []
    return "\n".join([flat_text(content)] + extra) if extra else flat_text(content)


def check_eng(kind: str, payload: Any, folders: tuple[str, ...] | None = _DEFAULT_FOLDERS, system_names: frozenset[str] = frozenset()) -> dict:
    """Validate the payload of a Stage-07 block; returns a clean copy. The measurement link reuses ``check_ref``."""

    def link_check(link: Any) -> dict:
        if not isinstance(link, dict) or set(link) != {"kind", "id"} or link["kind"] not in eng.LINK_KINDS or not isinstance(link["id"], str):
            raise ContentError("Mesure invalide")
        if link["kind"] == "source":
            if not eng.check_source_id(link["id"]):
                raise ContentError("Mesure invalide")
            return {"kind": "source", "id": link["id"]}
        return check_ref(link, folders, system_names)

    try:
        return eng.check_payload(kind, payload, link_check)
    except eng.EngError as e:
        raise ContentError(str(e)) from e


def eng_payloads(content: dict) -> list[dict]:
    return [b[b["type"]] for b in content["blocks"] if b.get("type") in eng.ENG_TYPES]


def _check_line(text: Any) -> str:
    if not isinstance(text, str) or "\n" in text or _TEXT_CTRL_RE.search(text):
        raise ContentError("Texte invalide")
    try:
        text.encode("utf-8")
    except UnicodeEncodeError as e:
        raise ContentError("Texte invalide") from e
    return text


def _check_block_ids(blocks: list, existing: dict | None) -> None:
    old = set(content_ids(existing)) if existing is not None else set()
    claimed: set[str] = set()
    for incoming in blocks:
        if isinstance(incoming, dict) and "id" in incoming:
            ident = incoming["id"]
            if not isinstance(ident, str) or not _BLOCK_ID_RE.match(ident) or ident not in old or ident in claimed:
                raise ContentError("Bloc étranger à cette page")
            claimed.add(ident)


def parse_content(
    content: Any,
    *,
    existing: dict | None,
    folders: tuple[str, ...] | None = _DEFAULT_FOLDERS,
    system_names: frozenset[str] = frozenset(),
    text_limit: int,
) -> dict:
    """Validate client content (V2, or legacy V1 for a still-plain page). Nothing is stored here.

    Returns ``{"blocks": [...], "plain": bool}``; each block is V2-shaped and carries an ``id``
    only when the client sent one that already belongs to the page. Raises ContentError.
    """
    if not isinstance(content, dict) or set(content) != {"version", "blocks"}:
        raise ContentError("Contenu invalide")
    version = content["version"]
    blocks = content["blocks"]
    if version == LEGACY_CONTENT_VERSION:
        if existing is not None and not is_plain(existing):
            raise ContentError("Version de contenu obsolète — recharge la page")
        if not isinstance(blocks, list) or len(blocks) != 1 or not isinstance(blocks[0], dict):
            raise ContentError("Une page contient exactement un bloc texte")
        legacy = blocks[0]
        if not set(legacy) <= {"id", "type", "text", "marks"} or not {"type", "text"} <= set(legacy):
            raise ContentError("Bloc invalide")
        if legacy.get("type") != "text" or legacy.get("marks", []) != []:
            raise ContentError("Mise en forme non prise en charge")
        text = legacy.get("text")
        if not isinstance(text, str) or _TEXT_CTRL_RE.search(text):
            raise ContentError("Texte invalide")
        if "id" in legacy and (existing is None or legacy["id"] != existing["blocks"][0]["id"]):
            raise ContentError("Bloc étranger à cette page")
        old_ids = content_ids(existing) if existing is not None else []
        out = []
        for i, line in enumerate(text.split("\n")):
            # A legacy client has no notion of block ids: keep the page's own ids by position.
            block = {"type": "paragraph", "text": _check_line(line), "marks": []}
            if i < len(old_ids):
                block["id"] = old_ids[i]
            out.append(block)
        _check_size(out, text_limit)
        return {"blocks": out, "plain": True}
    if version != CONTENT_VERSION:
        raise ContentError("Version de contenu non prise en charge")
    if not isinstance(blocks, list) or not blocks:
        raise ContentError("Contenu invalide")
    if len(blocks) > text_limit + 1:
        raise ContentError(f"Page trop longue (max {text_limit} octets)")  # one block costs >= 1 byte
    _check_block_ids(blocks, existing)
    out = []
    total_marks = 0
    plain = True
    images = 0
    atoms = 0
    decisions = 0
    tables = notes = groups = drawings = 0
    struct_bytes = 0
    for incoming in blocks:
        if not isinstance(incoming, dict):
            raise ContentError("Bloc invalide")
        if not set(incoming) <= {"id", "type", "text", "marks", "checked", "asset", *eng.ENG_TYPES, *STRUCT_KEY.values()} or not {"type", "text"} <= set(incoming):
            raise ContentError("Bloc invalide")
        kind = incoming["type"]
        if kind not in BLOCK_TYPES:
            raise ContentError("Bloc invalide")
        asset = None
        if kind == IMAGE_TYPE:
            if "asset" not in incoming or "checked" in incoming or incoming["text"] != "" or incoming.get("marks", []) != []:
                raise ContentError("Bloc image invalide")
            asset = check_asset(incoming["asset"])
            images += 1
            if images > IMAGES_PER_PAGE_MAX:
                raise ContentError(f"Trop d'images sur la page (max {IMAGES_PER_PAGE_MAX})")
        elif "asset" in incoming:
            raise ContentError("Bloc invalide")
        payload = None
        carried = set(incoming) & set(eng.ENG_TYPES)
        if kind in eng.ENG_TYPES:
            if carried != {kind} or "checked" in incoming or "asset" in incoming:
                raise ContentError("Bloc invalide")
            if kind in eng.ATOM_TYPES:
                if incoming["text"] != "" or incoming.get("marks", []) != []:
                    raise ContentError("Bloc invalide")
                atoms += 1
                if atoms > ENG_ATOMS_PER_PAGE_MAX:
                    raise ContentError(f"Trop de calculs/mesures sur la page (max {ENG_ATOMS_PER_PAGE_MAX})")
            else:
                decisions += 1
                if decisions > DECISIONS_PER_PAGE_MAX:
                    raise ContentError(f"Trop de décisions sur la page (max {DECISIONS_PER_PAGE_MAX})")
            payload = check_eng(kind, incoming[kind], folders, system_names)
        elif carried:
            raise ContentError("Bloc invalide")
        sdata = None
        if kind in STRUCT_TYPES:
            key = STRUCT_KEY[kind]
            if set(incoming) & (set(STRUCT_KEY.values()) - {key}) or key not in incoming or "checked" in incoming or "asset" in incoming or carried:
                raise ContentError("Bloc invalide")
            if incoming["text"] != "" or incoming.get("marks", []) != []:
                raise ContentError("Bloc invalide")
            sdata = check_struct(kind, incoming[key])
            if kind == TABLE_TYPE:
                tables += 1
                if tables > TABLES_PER_PAGE_MAX:
                    raise ContentError(f"Trop de tableaux sur la page (max {TABLES_PER_PAGE_MAX})")
            elif kind == DRAWING_TYPE:
                drawings += 1
                if drawings > DRAWINGS_PER_PAGE_MAX:
                    raise ContentError(f"Trop de croquis sur la page (max {DRAWINGS_PER_PAGE_MAX})")
            elif kind == GROUP_TYPE:
                groups += 1
                images += len(sdata["items"])
                if groups > GROUPS_PER_PAGE_MAX:
                    raise ContentError(f"Trop de groupes d'images sur la page (max {GROUPS_PER_PAGE_MAX})")
                if images > IMAGES_PER_PAGE_MAX:
                    raise ContentError(f"Trop d'images sur la page (max {IMAGES_PER_PAGE_MAX})")
            else:
                notes += 1
                if notes > NOTES_PER_PAGE_MAX:
                    raise ContentError(f"Trop d'encadrés/sections sur la page (max {NOTES_PER_PAGE_MAX})")
            struct_bytes += sum(len(x.encode("utf-8")) for x in structured_strings({"type": kind, STRUCT_KEY[kind]: sdata}))
            if struct_bytes > STRUCT_BYTES_MAX:
                raise ContentError("Trop de texte structuré sur la page")
        elif set(incoming) & set(STRUCT_KEY.values()):
            raise ContentError("Bloc invalide")
        checked = False
        if kind == "check":
            checked = incoming.get("checked", False)
            if not isinstance(checked, bool):
                raise ContentError("Bloc invalide")
        elif "checked" in incoming:
            raise ContentError("Bloc invalide")
        text = _check_line(incoming["text"])
        marks = _check_marks(text, incoming.get("marks"), folders, system_names)
        total_marks += len(marks)
        if total_marks > MARKS_TOTAL_MAX:
            raise ContentError("Trop de mises en forme")
        block: dict[str, Any] = {"type": kind, "text": text, "marks": marks}
        if "id" in incoming:
            block["id"] = incoming["id"]
        if kind == "check":
            block["checked"] = checked
        if asset is not None:
            block["asset"] = asset
        if payload is not None:
            block[kind] = payload
        if sdata is not None:
            block[STRUCT_KEY[kind]] = sdata
        if kind != "paragraph" or marks:
            plain = False
        out.append(block)
    _check_size(out, text_limit)
    return {"blocks": out, "plain": plain}


def _check_size(blocks: list[dict], limit: int) -> None:
    size = sum(len(b["text"].encode("utf-8")) for b in blocks) + len(blocks) - 1
    if size > limit:
        raise ContentError(f"Page trop longue (max {limit} octets)")


def same_as_stored(parsed: dict, existing: dict) -> bool:
    """Semantic equality between parsed client content and the stored content (ids ignored)."""
    if existing["version"] == LEGACY_CONTENT_VERSION:
        return parsed["plain"] and "\n".join(b["text"] for b in parsed["blocks"]) == existing["blocks"][0]["text"]
    if len(parsed["blocks"]) != len(existing["blocks"]):
        return False
    return strip_ids({"blocks": parsed["blocks"]}) == strip_ids(existing)


def store_content(parsed: dict, existing: dict, *, blocks_limit: int | None = None, budget_ok=None) -> dict:
    """Decide the stored form of already-validated content and assign block ids.

    V2 when it fits (``blocks_limit`` lines and ``budget_ok(delta_blocks)``); otherwise a plain page
    stays (or becomes) a compact V1 block; structured content that does not fit is refused. Never
    truncates. ``existing`` is the page's current stored content (V1 or V2).
    """
    limit = BLOCKS_MAX if blocks_limit is None else blocks_limit
    blocks = parsed["blocks"]
    legacy = existing["version"] == LEGACY_CONTENT_VERSION
    old_n = len(existing["blocks"])
    delta = len(blocks) - old_n
    # A page that is already V2 may keep (never grow past) its own size even if it somehow exceeds the limit.
    fits_page = len(blocks) <= limit or (not legacy and len(blocks) <= old_n)
    fits_budget = budget_ok is None or budget_ok(delta)
    if fits_page and fits_budget:
        used = {b["id"] for b in blocks if "id" in b}
        out = []
        for block in blocks:
            ident = block.get("id")
            if ident is None:
                ident = new_block_id()
                while ident in used:
                    ident = new_block_id()
                used.add(ident)
            item: dict[str, Any] = {"id": ident, "type": block["type"], "text": block["text"], "marks": block["marks"]}
            if block["type"] == "check":
                item["checked"] = block["checked"]
            if block["type"] == IMAGE_TYPE:
                item["asset"] = dict(block["asset"])
            if block["type"] in eng.ENG_TYPES:
                item[block["type"]] = copy.deepcopy(block[block["type"]])
            if block["type"] in STRUCT_TYPES:
                item[STRUCT_KEY[block["type"]]] = copy.deepcopy(block[STRUCT_KEY[block["type"]]])
            out.append(item)
        return {"version": CONTENT_VERSION, "blocks": out}
    if legacy and parsed["plain"]:
        # Compact fallback ONLY for a page that is still legacy V1: nothing to lose but the line split.
        text = "\n".join(b["text"] for b in blocks)
        return {"version": LEGACY_CONTENT_VERSION, "blocks": [{"id": existing["blocks"][0]["id"], "type": "text", "text": text, "marks": []}]}
    # An existing V2 page is never downgraded (that would destroy its logical block identity) and
    # structured content is never truncated: growth beyond the limits is refused, the page is untouched.
    if not fits_page:
        what = "" if parsed["plain"] else " pour la mise en forme"
        raise ContentError(f"Trop de lignes{what} (max {limit}) — réduis la page")
    raise ContentError("Carnet trop volumineux (trop de lignes structurées)")


def strip_ids(content: dict) -> list:
    out = []
    for block in content["blocks"]:
        row = (block["type"], bool(block.get("checked", False)), block["text"], [_mark_key(m) for m in block["marks"]])
        if block["type"] == IMAGE_TYPE:
            row += (tuple(sorted(block["asset"].items())),)
        if block["type"] in eng.ENG_TYPES:
            row += (json.dumps(block[block["type"]], sort_keys=True, ensure_ascii=True),)
        if block["type"] in STRUCT_TYPES:
            row += (json.dumps(block[STRUCT_KEY[block["type"]]], sort_keys=True, ensure_ascii=True),)
        out.append(row)
    return out


def _mark_key(mark: dict) -> tuple:
    return (mark["type"], mark["start"], mark["end"]) + _target(mark)


# ---------------------------------------------------------------- stored shape


def valid_v1(content: Any) -> bool:
    if not isinstance(content, dict) or set(content) != {"version", "blocks"} or content.get("version") != LEGACY_CONTENT_VERSION:
        return False
    blocks = content.get("blocks")
    if not isinstance(blocks, list) or len(blocks) != 1:
        return False
    block = blocks[0]
    return (
        isinstance(block, dict)
        and set(block) == {"id", "type", "text", "marks"}
        and isinstance(block["id"], str)
        and bool(_BLOCK_ID_RE.match(block["id"]))
        and block["type"] == "text"
        and isinstance(block["text"], str)
        and block["marks"] == []
    )


def valid_v2(content: Any) -> bool:
    """Strict check of STORED V2 content: must already be canonical."""
    if not isinstance(content, dict) or set(content) != {"version", "blocks"} or content.get("version") != CONTENT_VERSION:
        return False
    blocks = content.get("blocks")
    if not isinstance(blocks, list) or not blocks:
        return False
    seen: set[str] = set()
    total = 0
    try:
        for block in blocks:
            if not isinstance(block, dict):
                return False
            keys = {"id", "type", "text", "marks"} | ({"checked"} if block.get("type") == "check" else set())
            if block.get("type") == IMAGE_TYPE:
                keys = {"id", "type", "text", "marks", "asset"}
            if block.get("type") in eng.ENG_TYPES:
                keys = {"id", "type", "text", "marks", block["type"]}
            if block.get("type") in STRUCT_TYPES:
                keys = {"id", "type", "text", "marks", STRUCT_KEY[block["type"]]}
            if set(block) != keys or block["type"] not in BLOCK_TYPES:
                return False
            if block["type"] in STRUCT_TYPES:
                if block["text"] != "" or block["marks"] != [] or check_struct(block["type"], block[STRUCT_KEY[block["type"]]]) != block[STRUCT_KEY[block["type"]]]:
                    return False
            if block["type"] in eng.ENG_TYPES:
                if block["type"] in eng.ATOM_TYPES and (block["text"] != "" or block["marks"] != []):
                    return False
                if check_eng(block["type"], block[block["type"]], None, frozenset()) != block[block["type"]]:
                    return False
            if block["type"] == IMAGE_TYPE:
                if block["text"] != "" or block["marks"] != [] or check_asset(block["asset"]) != block["asset"]:
                    return False
            ident = block["id"]
            if not isinstance(ident, str) or not _BLOCK_ID_RE.match(ident) or ident in seen:
                return False
            seen.add(ident)
            if block["type"] == "check" and not isinstance(block["checked"], bool):
                return False
            text = _check_line(block["text"])
            marks = _check_marks(text, block["marks"], None, frozenset())
            if marks != block["marks"]:
                return False
            total += len(marks)
            if total > MARKS_TOTAL_MAX:
                return False
    except (ContentError, KeyError, TypeError):
        return False
    return True


# ---------------------------------------------------------------- export rendering


def _segments(text: str, marks: list[dict]) -> list[tuple[str, list[dict]]]:
    """Split ``text`` at every mark boundary: [(chunk, active marks)] (UTF-16 offsets)."""
    if not text:
        return []
    units = _u16_units(text)
    cuts = {0, len(units)}
    for mark in marks:
        cuts.add(mark["start"])
        cuts.add(mark["end"])
    edges = sorted(cuts)
    raw = text.encode("utf-16-le")
    out = []
    for a, b in zip(edges, edges[1:]):
        chunk = raw[a * 2 : b * 2].decode("utf-16-le")
        active = [m for m in marks if m["start"] <= a and m["end"] >= b]
        out.append((chunk, active))
    return out


def _number_labels(blocks: list[dict]) -> list[int]:
    labels, counter = [], 0
    for block in blocks:
        if block["type"] == "number":
            counter += 1
            labels.append(counter)
        else:
            counter = 0
            labels.append(0)
    return labels


def _link_of(active: list[dict]) -> dict | None:
    for mark in active:
        if mark["type"] == "link":
            return mark
    return None


CALLOUT_LABEL = {"note": "Note", "info": "Info", "warning": "Attention"}  # words, never colour alone; same in the browser
GROUP_ITEM_LABEL = {"compare": ("Avant", "Après")}


def _txt_struct(block: dict) -> list[str]:
    kind = block["type"]
    if kind == TABLE_TYPE:
        return ["[Tableau]"] + [" | ".join(row) for row in block["table"]["rows"]]
    if kind == CALLOUT_TYPE:
        c = block["callout"]
        head = f"[{CALLOUT_LABEL[c['kind']]}]" + (f" {c['title']}" if c["title"] else "")
        return [head] + (c["body"].split("\n") if c["body"] else [])
    if kind == TOGGLE_TYPE:
        t = block["toggle"]
        return ["[Section] " + t["summary"]] + (t["body"].split("\n") if t["body"] else [])
    if kind == DRAWING_TYPE:
        return [f"[Croquis : {drawing_label(block['drawing']['id'])}]"]
    g = block["group"]  # image group: one line per child, labelled for a before/after pair
    labels = GROUP_ITEM_LABEL.get(g["layout"])
    out = []
    for n, a in enumerate(g["items"]):
        label = labels[n] if labels else "Image"
        out.append(f"[{label} : {a['caption']}]" if a["caption"] else f"[{label}]")
    return out


def _md_cell(text: str) -> str:
    return _md_escape(text)


def _md_struct(block: dict, asset_paths: dict[str, str] | None) -> str:
    kind = block["type"]
    if kind == TABLE_TYPE:
        rows = block["table"]["rows"]
        width = len(rows[0])
        if block["table"]["header"]:
            head, body = rows[0], rows[1:]
        else:
            head, body = [""] * width, rows  # a synthetic EMPTY header: row 0 stays data, it is never promoted to a header
        lines = ["| " + " | ".join(_md_cell(c) for c in head) + " |", "|" + "|".join(["---"] * width) + "|"]
        lines += ["| " + " | ".join(_md_cell(c) for c in row) + " |" for row in body]
        return "\n".join(lines)
    if kind == CALLOUT_TYPE:
        c = block["callout"]
        head = "> **" + CALLOUT_LABEL[c["kind"]] + "**" + (" \u2014 " + _md_escape(c["title"]) if c["title"] else "")
        lines = [head]
        for line in c["body"].split("\n") if c["body"] else []:
            if line.strip():
                lines += [">", "> " + _md_line_start_escape(_md_escape(line))]
        return "\n".join(lines)
    if kind == TOGGLE_TYPE:
        t = block["toggle"]
        parts = ["**" + _md_escape(t["summary"]) + "**"]
        parts += [_md_line_start_escape(_md_escape(line)) for line in t["body"].split("\n") if line.strip()]
        return "\n\n".join(parts)
    if kind == DRAWING_TYPE:  # a text label only: no path, no URL, no preview asset (Dessiner owns the drawing)
        return f"*\\[Croquis : {_md_escape(drawing_label(block['drawing']['id']))}\\]*"
    g = block["group"]
    labels = GROUP_ITEM_LABEL.get(g["layout"])
    parts = []
    for n, a in enumerate(g["items"]):
        rel = (asset_paths or {}).get(a["id"])
        label = labels[n] if labels else "Image"
        piece = []
        if labels:
            piece.append("**" + label + "**")
        if rel:
            piece.append(f"![{_md_alt(a['caption'])}]({_md_path(rel)})")
            if a["caption"]:
                piece.append(f"*{_md_escape(a['caption'])}*")
        else:
            piece.append(f"*\\[{label} : {_md_escape(a['caption'])}\\]*" if a["caption"] else f"*\\[{label}\\]*")
        parts.append("\n\n".join(piece))
    return "\n\n".join(parts)


def render_txt(content: dict) -> str:
    """Deterministic plain text (a snapshot, not a source of truth)."""
    labels = _number_labels(content["blocks"])
    lines = []
    for block, label in zip(content["blocks"], labels):
        kind = block["type"]
        if kind == IMAGE_TYPE:
            caption = block["asset"]["caption"]
            lines.append(f"[Image : {caption}]" if caption else "[Image]")
            continue
        if kind in STRUCT_TYPES:
            lines.extend(_txt_struct(block))
            continue
        if kind == "calc":
            lines.append("[" + eng.describe_calc(block["calc"]) + "]")
            continue
        if kind == "measure":
            lines.append("[" + eng.describe_measure(block["measure"]) + "]")
            continue
        if kind == "decision":
            body = _txt_inline(block)
            lines.append(eng.decision_label(block["decision"]) + (" \u2014 " + body if body else ""))
            continue
        text = _txt_inline(block)
        if kind == "bullet":
            text = "- " + text
        elif kind == "number":
            text = f"{label}. " + text
        elif kind == "check":
            text = ("[x] " if block["checked"] else "[ ] ") + text
        lines.append(text)
    return "\n".join(lines) + "\n"


def _txt_inline(block: dict) -> str:
    text = block["text"]
    links = [m for m in block["marks"] if m["type"] == "link" and "href" in m]
    if not links:
        return text
    raw = text.encode("utf-16-le")
    out, pos = [], 0
    for mark in sorted(links, key=lambda m: m["start"]):
        out.append(raw[pos * 2 : mark["end"] * 2].decode("utf-16-le"))
        out.append(f" ({mark['href']})")
        pos = mark["end"]
    out.append(raw[pos * 2 :].decode("utf-16-le"))
    return "".join(out)


_MD_ESC_RE = re.compile(r"([\\`*_\[\]<>&|~])")


def _md_escape(text: str) -> str:
    return _MD_ESC_RE.sub(r"\\\1", text)


def _md_line_start_escape(text: str) -> str:
    if re.match(r"^(#{1,6}\s|[-+*]\s|\d+[.)]\s|>|={3,}|-{3,}|\|)", text):
        return "\\" + text
    return text


def _md_wrap(chunk: str, active: list[dict]) -> str:
    if not chunk:
        return ""
    code = any(m["type"] == "code" for m in active)
    body = chunk
    lead = body[: len(body) - len(body.lstrip())]
    trail = body[len(body.rstrip()) :]
    core = body.strip()
    if not core:
        return chunk
    if code:
        fence = "`"
        while fence in core:
            fence += "`"
        pad = " " if core.startswith("`") or core.endswith("`") else ""
        core = f"{fence}{pad}{core}{pad}{fence}"
    else:
        core = _md_escape(core)
    kinds = {m["type"] for m in active}
    if "bold" in kinds:
        core = f"**{core}**"
    if "italic" in kinds:
        core = f"*{core}*"
    if "underline" in kinds:
        core = f"<u>{core}</u>"
    if "highlight" in kinds:
        core = f"<mark>{core}</mark>"
    link = _link_of(active)
    if link is not None and "href" in link:
        core = f"[{core}]({_md_url(link['href'])})"
    return lead + core + trail


def _md_url(url: str) -> str:
    return url.replace("(", "%28").replace(")", "%29").replace(" ", "%20")


def _md_inline(block: dict) -> str:
    return "".join(_md_wrap(chunk, active) for chunk, active in _segments(block["text"], block["marks"]))


_MD_PATH_SAFE = re.compile(r"[^A-Za-z0-9._~/-]")


def _md_path(rel: str) -> str:
    """Percent-encode a package-relative path for a Markdown link: only [A-Za-z0-9._~/-] stay literal (so ``#``,
    ``?``, ``%``, spaces, parentheses and non-ASCII can never break or redirect the link). Mirrors the JS renderer."""
    return _MD_PATH_SAFE.sub(lambda m: "".join("%%%02X" % b for b in m.group(0).encode("utf-8")), rel)


def _md_alt(text: str) -> str:
    return re.sub(r"([\\\[\]])", r"\\\1", text)


def render_markdown(content: dict, asset_paths: dict[str, str] | None = None) -> str:
    """Deterministic Markdown for the supported structure (a snapshot).

    ``asset_paths`` maps an asset id to its path RELATIVE to the export package (never absolute); an image
    without an entry is rendered as a text placeholder (no dangling link, no binary).
    """
    labels = _number_labels(content["blocks"])
    parts: list[tuple[str, str, bool]] = []  # (kind, rendered, after a blank separator)
    gap = False
    for block, label in zip(content["blocks"], labels):
        kind = block["type"]
        if kind == IMAGE_TYPE:
            asset = block["asset"]
            caption = asset["caption"]
            rel = (asset_paths or {}).get(asset["id"])
            if rel:
                text = f"![{_md_alt(caption)}]({_md_path(rel)})"
                if caption:
                    text += f"\n\n*{_md_escape(caption)}*"
            else:
                text = f"*\\[Image : {_md_escape(caption)}\\]*" if caption else "*\\[Image\\]*"
            parts.append(("img", text, gap))
            gap = False
            continue
        if kind in STRUCT_TYPES:
            parts.append(("struct", _md_struct(block, asset_paths), gap))
            gap = False
            continue
        if kind in ("calc", "measure"):
            inner = eng.describe_calc(block["calc"]) if kind == "calc" else eng.describe_measure(block["measure"])
            parts.append((kind, f"*\\[{_md_escape(inner)}\\]*", gap))
            gap = False
            continue
        if kind == "decision":
            body = _md_inline(block)
            parts.append(("decision", "**" + _md_escape(eng.decision_label(block["decision"])) + "**" + (" \u2014 " + body if body else ""), gap))
            gap = False
            continue
        if kind in ("paragraph", "heading") and not block["text"].strip():
            gap = True  # a blank line ends any list: numbering restarts, like the TXT export
            continue
        text = _md_inline(block)
        if kind == "paragraph":
            parts.append(("p", _md_line_start_escape(text), gap))
        elif kind == "heading":
            parts.append(("h", "## " + text, gap))
        elif kind == "bullet":
            parts.append(("bullet", "- " + text, gap))
        elif kind == "number":
            parts.append(("number", f"{label}. " + text, gap))
        else:
            parts.append(("bullet", ("- [x] " if block["checked"] else "- [ ] ") + text, gap))
        gap = False
    out = []
    prev = None
    for kind, text, after_gap in parts:
        if prev is not None:
            out.append("\n" if kind == prev and kind in ("bullet", "number") and not after_gap else "\n\n")
        out.append(text)
        prev = kind
    return "".join(out) + "\n"


def export_name_stem(title: str) -> str:
    """Filesystem-safe stem derived from a page title."""
    return sanitize_stem(title)


_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
_NAME_BAD_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f]')


def sanitize_stem(value: str, default: str = "note", limit: int = 80) -> str:
    text = unicodedata.normalize("NFC", str(value or ""))
    text = _NAME_BAD_RE.sub("-", text)
    text = " ".join(text.split())
    text = text.strip(" .-")
    text = re.sub(r"-{2,}", "-", text)
    if len(text) > limit:
        text = text[:limit].rstrip(" .-")
    if not text:
        text = default
    if text.split(".")[0].lower() in _RESERVED:
        text = "_" + text
    return text


def export_filename(name: str | None, title: str, fmt: str) -> str:
    """Safe leaf name with the extension of ``fmt`` (``txt`` or ``md``). ``name`` may be user-edited."""
    ext = ".md" if fmt == "md" else ".txt"
    stem = name if isinstance(name, str) and name.strip() else title
    lowered = stem.lower()
    for known in (".txt", ".md"):
        if lowered.endswith(known):
            stem = stem[: -len(known)]
            break
    return sanitize_stem(stem or title) + ext
