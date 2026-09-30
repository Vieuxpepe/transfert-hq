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

Canonical form: marks sorted, non-empty, same-type/same-target marks merged when they
overlap or touch. The browser (``hq-carnet-rich.js``) implements the same rules; the
shared vectors in the tests keep both in step. Page text never appears in errors.
"""

from __future__ import annotations

import json
import re
import secrets
import unicodedata
from typing import Any
from urllib.parse import urlsplit

CONTENT_VERSION = 2
LEGACY_CONTENT_VERSION = 1

BLOCK_TYPES = ("paragraph", "heading", "bullet", "number", "check")
INLINE_MARKS = ("bold", "italic", "underline", "highlight", "code")
MARK_ORDER = INLINE_MARKS + ("link", "citation")
REF_KINDS = ("note", "file", "drawing", "model", "media")
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
    for incoming in blocks:
        if not isinstance(incoming, dict):
            raise ContentError("Bloc invalide")
        if not set(incoming) <= {"id", "type", "text", "marks", "checked"} or not {"type", "text"} <= set(incoming):
            raise ContentError("Bloc invalide")
        kind = incoming["type"]
        if kind not in BLOCK_TYPES:
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
        out.append((block["type"], bool(block.get("checked", False)), block["text"], [_mark_key(m) for m in block["marks"]]))
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
            if set(block) != keys or block["type"] not in BLOCK_TYPES:
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


def render_txt(content: dict) -> str:
    """Deterministic plain text (a snapshot, not a source of truth)."""
    labels = _number_labels(content["blocks"])
    lines = []
    for block, label in zip(content["blocks"], labels):
        text = _txt_inline(block)
        kind = block["type"]
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


def render_markdown(content: dict) -> str:
    """Deterministic Markdown for the supported structure (a snapshot)."""
    labels = _number_labels(content["blocks"])
    parts: list[tuple[str, str, bool]] = []  # (kind, rendered, after a blank separator)
    gap = False
    for block, label in zip(content["blocks"], labels):
        kind = block["type"]
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
