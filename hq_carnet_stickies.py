"""Carnet Phase 16D: sticky notes on a page — the store. Stdlib only.

A sticky note is a small, movable piece of text pinned on ONE Carnet page. It is a desk aid, not page content: it never
enters ``notebook.json``, a block, a snapshot, history, search, Ask or a report, and no evidence module imports this one.

Runtime state: ``<ROOT>/.hq-carnet/stickies.json`` (own file, own lock, own revision), shared by every device::

    {"version": 1, "rev": 7, "notes": [
        {"id": "stk-<24 hex>", "page_id": "page-…", "text": "…", "color": "yellow",
         "x": 0.62, "y": 140, "w": 220, "z": 3, "collapsed": false,
         "created_at": 1790680000.0, "updated_at": 1790680300.0, "rev": 2}]}

Position: ``x`` is the note's left edge as a FRACTION of the page width (0..1), so a note keeps its place on a phone and on a
wide PC page; ``y`` is CSS pixels from the top of the page. Writes are revision-aware per note: an update or delete that names
an older ``rev`` is refused (409, the current note is returned) and nothing changes. A malformed or redirected file is never
rewritten (503) and its bytes stay untouched.
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

import hq_state

DIR_NAME = ".hq-carnet"
FILE_NAME = "stickies.json"
VERSION = 1

COLORS = ("yellow", "pink", "blue", "green", "purple")
TEXT_MAX = 4000
PER_PAGE_MAX = 40
TOTAL_MAX = 1000
Y_MAX = 200_000
W_MIN, W_MAX, W_DEFAULT = 160, 520, 230
Z_MAX = 1_000_000

ID_RE = re.compile(r"^stk-[0-9a-f]{24}\Z")
_PAGE_RE = re.compile(r"^page-[A-Za-z0-9_-]{1,64}\Z")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")  # newline and tab are kept
_NOTE_KEYS = {"id", "page_id", "text", "color", "x", "y", "w", "z", "collapsed", "created_at", "updated_at", "rev"}

_cb: dict[str, Any] = {}
_guard = threading.Lock()


class StickyError(ValueError):
    status = 400
    code = "validation_error"

    def __init__(self, msg: str, status: int | None = None, code: str | None = None, extra: dict | None = None):
        super().__init__(msg)
        if status is not None:
            self.status = status
        if code is not None:
            self.code = code
        self.extra = extra or {}


def bind(**kwargs: Any) -> None:
    with _guard:
        _cb.update({k: v for k, v in kwargs.items() if k in ("root", "now")})


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


def stickies_path(root: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(root))) / DIR_NAME / FILE_NAME


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def confined_path(root: Path | str) -> Path:
    """``stickies_path(root)`` after refusing any redirection (symlink / junction) of the folder, the file or its temp."""
    path = stickies_path(root)
    base = path.parent
    try:
        real_base = os.path.join(os.path.realpath(base.parent), DIR_NAME)
        same = lambda a, b: os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))  # noqa: E731
        if _is_link(base) or not same(os.path.realpath(base), real_base):
            raise StickyError("Emplacement des notes redirigé — refusé, fichier conservé", 503, "storage_error")
        for name in (FILE_NAME, FILE_NAME + ".tmp"):
            item = base / name
            if _is_link(item) or not same(os.path.realpath(item), os.path.join(real_base, name)):
                raise StickyError("Emplacement des notes redirigé — refusé, fichier conservé", 503, "storage_error")
    except OSError as e:
        raise StickyError("Notes inaccessibles", 503, "storage_error") from e
    return path


def _path() -> Path:
    root = _cb.get("root")
    if root is None:
        raise StickyError("Notes non initialisées", 503, "storage_error")
    return confined_path(root)


# ---------------------------------------------------------------- validation

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def clean_text(value: Any) -> str:
    if not isinstance(value, str):
        raise StickyError("Texte invalide")
    text = _CTRL_RE.sub("", value.replace("\r\n", "\n").replace("\r", "\n"))
    if len(text) > TEXT_MAX:
        raise StickyError(f"Note trop longue ({TEXT_MAX} caractères au maximum)")
    return text


def _x(v: Any) -> float:
    if not _is_num(v) or not 0 <= v <= 1:
        raise StickyError("Position x invalide")
    return round(float(v), 4)


def _y(v: Any) -> int:
    if not _is_num(v) or not 0 <= v <= Y_MAX:
        raise StickyError("Position y invalide")
    return int(round(float(v)))


def _w(v: Any) -> int:
    if not _is_num(v) or not W_MIN <= v <= W_MAX:
        raise StickyError("Largeur invalide")
    return int(round(float(v)))


def _color(v: Any) -> str:
    if v not in COLORS:
        raise StickyError("Couleur invalide")
    return v


def _valid_note(n: Any) -> bool:
    return (isinstance(n, dict) and set(n) == _NOTE_KEYS and isinstance(n["id"], str) and ID_RE.match(n["id"]) is not None
            and isinstance(n["page_id"], str) and _PAGE_RE.match(n["page_id"]) is not None
            and isinstance(n["text"], str) and len(n["text"]) <= TEXT_MAX and n["color"] in COLORS
            and _is_num(n["x"]) and 0 <= n["x"] <= 1 and _is_int(n["y"]) and 0 <= n["y"] <= Y_MAX
            and _is_int(n["w"]) and W_MIN <= n["w"] <= W_MAX and _is_int(n["z"]) and 0 <= n["z"] <= Z_MAX
            and isinstance(n["collapsed"], bool) and _is_num(n["created_at"]) and _is_num(n["updated_at"])
            and _is_int(n["rev"]) and n["rev"] >= 1)


def _usable(data: Any) -> bool:
    if not (isinstance(data, dict) and set(data) == {"version", "rev", "notes"} and data["version"] == VERSION
            and _is_int(data["rev"]) and data["rev"] >= 0 and isinstance(data["notes"], list) and len(data["notes"]) <= TOTAL_MAX):
        return False
    ids = set()
    for n in data["notes"]:
        if not _valid_note(n) or n["id"] in ids:
            return False
        ids.add(n["id"])
    return True


# ---------------------------------------------------------------- file

def _read_locked(path: Path) -> dict:
    """The current state, or an empty one when the file is absent. Malformed bytes are never rewritten (503)."""
    try:
        exists = os.path.lexists(path)
        if not exists:
            return {"version": VERSION, "rev": 0, "notes": []}
        if not path.is_file():
            raise StickyError("stickies.json n'est pas un fichier — conservé", 503, "storage_error")
        data = json.loads(path.read_bytes().decode("utf-8"))
    except StickyError:
        raise
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise StickyError("stickies.json illisible — fichier conservé", 503, "storage_error") from e
    if not _usable(data):
        raise StickyError("stickies.json illisible — fichier conservé", 503, "storage_error")
    return data


def _write_locked(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        hq_state.write_json_atomic(path, state)
    except (OSError, RuntimeError) as e:
        raise StickyError("Écriture des notes impossible", 503, "storage_error") from e


def snapshot_bytes(root: Path | str) -> tuple[bytes | None, bool]:
    """Committed bytes (under the lock) and whether they validate; ``(None, True)`` when absent. Used by the Carnet backup."""
    src = stickies_path(root)
    with hq_state.path_lock(src):
        confined_path(root)
        if not os.path.lexists(src):
            return None, True
        if not src.is_file():
            raise StickyError("stickies.json n'est pas un fichier — conservé", 503, "storage_error")
        payload = src.read_bytes()
    try:
        return payload, _usable(json.loads(payload.decode("utf-8")))
    except (UnicodeDecodeError, ValueError):
        return payload, False


# ---------------------------------------------------------------- operations

def _page_ok(page_id: str) -> None:
    """The page must exist and not be in the trash (read-only look at the notebook, taken BEFORE the stickies lock)."""
    if not isinstance(page_id, str) or not _PAGE_RE.match(page_id):
        raise StickyError("Page invalide")
    import hq_carnet  # lazy: hq_carnet imports this module

    try:
        pages = hq_carnet.get_notebook(meta=True)["pages"]
    except Exception as e:  # noqa: BLE001 — any notebook problem means "cannot attach now"
        raise StickyError("Carnet indisponible", 503, "storage_error") from e
    page = next((p for p in pages if p.get("id") == page_id), None)
    if page is None:
        raise StickyError("Page introuvable", 404, "not_found")
    if page.get("deleted_at"):
        raise StickyError("Page à la corbeille : impossible d'y ajouter une note", 409, "trashed")


def _only(data: dict, allowed: set[str]) -> None:
    extra = set(data) - allowed
    if extra:
        raise StickyError("Champ inconnu : " + sorted(extra)[0][:40])


def _find(state: dict, note_id: Any) -> dict:
    if not isinstance(note_id, str) or not ID_RE.match(note_id):
        raise StickyError("Note invalide")
    n = next((n for n in state["notes"] if n["id"] == note_id), None)
    if n is None:
        raise StickyError("Note introuvable (supprimée sur un autre appareil ?)", 404, "not_found")
    return n


def _check_rev(n: dict, data: dict, required: bool) -> None:
    if "rev" not in data:
        if required:
            raise StickyError("Révision manquante")
        return
    if not _is_int(data["rev"]):
        raise StickyError("Révision invalide")
    if data["rev"] != n["rev"]:
        raise StickyError("Cette note a changé sur un autre appareil", 409, "conflict", {"note": dict(n)})


def create(data: dict) -> dict:
    _only(data, {"action", "page_id", "text", "color", "x", "y", "w", "collapsed"})
    page_id = data.get("page_id")
    _page_ok(page_id)
    text = clean_text(data.get("text", ""))
    color = _color(data.get("color", "yellow"))
    x = _x(data.get("x", 0.5))
    y = _y(data.get("y", 40))
    w = _w(data.get("w", W_DEFAULT))
    collapsed = data.get("collapsed", False)
    if not isinstance(collapsed, bool):
        raise StickyError("collapsed invalide")
    path = _path()
    with hq_state.path_lock(path):
        state = _read_locked(path)
        on_page = [n for n in state["notes"] if n["page_id"] == page_id]
        if len(on_page) >= PER_PAGE_MAX:
            raise StickyError(f"Trop de notes sur cette page ({PER_PAGE_MAX} au maximum)", 409, "limit")
        if len(state["notes"]) >= TOTAL_MAX:
            raise StickyError(f"Trop de notes dans le carnet ({TOTAL_MAX} au maximum)", 409, "limit")
        now = _now()
        note = {"id": "stk-" + secrets.token_hex(12), "page_id": page_id, "text": text, "color": color, "x": x, "y": y, "w": w,
                "z": min(Z_MAX, max([n["z"] for n in on_page] + [0]) + 1), "collapsed": collapsed,
                "created_at": now, "updated_at": now, "rev": 1}
        state["notes"].append(note)
        state["rev"] += 1
        _write_locked(path, state)
        return {"ok": True, "rev": state["rev"], "note": dict(note)}


def update(data: dict) -> dict:
    _only(data, {"action", "id", "rev", "text", "color", "x", "y", "w", "collapsed", "front"})
    path = _path()
    with hq_state.path_lock(path):
        state = _read_locked(path)
        n = _find(state, data.get("id"))
        _check_rev(n, data, required=True)
        new = dict(n)
        if "text" in data:
            new["text"] = clean_text(data["text"])
        if "color" in data:
            new["color"] = _color(data["color"])
        if "x" in data:
            new["x"] = _x(data["x"])
        if "y" in data:
            new["y"] = _y(data["y"])
        if "w" in data:
            new["w"] = _w(data["w"])
        if "collapsed" in data:
            if not isinstance(data["collapsed"], bool):
                raise StickyError("collapsed invalide")
            new["collapsed"] = data["collapsed"]
        if "front" in data:
            if data["front"] is not True:
                raise StickyError("front invalide")
            top = max(m["z"] for m in state["notes"] if m["page_id"] == n["page_id"])
            if top != n["z"] or sum(1 for m in state["notes"] if m["page_id"] == n["page_id"] and m["z"] == top) > 1:
                new["z"] = min(Z_MAX, top + 1)
        if all(new[k] == n[k] for k in ("text", "color", "x", "y", "w", "collapsed", "z")):
            return {"ok": True, "rev": state["rev"], "note": dict(n), "unchanged": True}
        new["rev"] = n["rev"] + 1
        new["updated_at"] = _now()
        state["notes"] = [new if m["id"] == n["id"] else m for m in state["notes"]]
        state["rev"] += 1
        _write_locked(path, state)
        return {"ok": True, "rev": state["rev"], "note": dict(new)}


def delete(data: dict) -> dict:
    _only(data, {"action", "id", "rev"})
    path = _path()
    with hq_state.path_lock(path):
        state = _read_locked(path)
        n = _find(state, data.get("id"))
        _check_rev(n, data, required=False)
        state["notes"] = [m for m in state["notes"] if m["id"] != n["id"]]
        state["rev"] += 1
        _write_locked(path, state)
        return {"ok": True, "rev": state["rev"], "deleted": n["id"], "note": dict(n)}


def list_notes(page_id: str | None = None, since: int | None = None) -> dict:
    path = _path()
    with hq_state.path_lock(path):
        state = _read_locked(path)
    if since is not None and since == state["rev"]:
        return {"ok": True, "rev": state["rev"], "unchanged": True}
    notes = [dict(n) for n in state["notes"] if page_id is None or n["page_id"] == page_id]
    notes.sort(key=lambda n: (n["page_id"], n["z"], n["created_at"]))
    return {"ok": True, "rev": state["rev"], "notes": notes, "limits": {"per_page": PER_PAGE_MAX, "text": TEXT_MAX, "colors": list(COLORS)}}


# ---------------------------------------------------------------- HTTP

def _fail(e: StickyError) -> tuple[int, dict]:
    out = {"error": str(e)[:200], "code": e.code}
    out.update(e.extra)
    return e.status, out


def http_get(query: dict[str, list[str]]) -> tuple[int, dict]:
    try:
        if set(query) - {"page", "since"} or any(len(v) != 1 for v in query.values()):
            raise StickyError("Paramètre invalide")
        page = query["page"][0] if "page" in query else None
        if page is not None and not _PAGE_RE.match(page):
            raise StickyError("Page invalide")
        since = None
        if "since" in query:
            if not query["since"][0].isdigit() or len(query["since"][0]) > 12:
                raise StickyError("since invalide")
            since = int(query["since"][0])
        return 200, list_notes(page, since)
    except StickyError as e:
        return _fail(e)


def http_post(data: Any) -> tuple[int, dict]:
    try:
        if not isinstance(data, dict):
            raise StickyError("Requête invalide")
        action = data.get("action")
        if action == "create":
            return 200, create(data)
        if action == "update":
            return 200, update(data)
        if action == "delete":
            return 200, delete(data)
        raise StickyError("Action inconnue")
    except StickyError as e:
        return _fail(e)
