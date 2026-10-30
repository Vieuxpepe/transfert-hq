"""Transfert HQ — Inventaire: what you own and where it is. Stdlib only.

Places nest (room > shelf > box, as deep as ``DEPTH_MAX``); items live in a place (or nowhere yet) with a quantity, a unit,
an optional low-stock threshold, tags, a note and up to ``PHOTOS_MAX`` photos. Photos are images of the Carnet image store
(``/api/carnet/asset``: validated, write-once, never deleted), referenced here by id only.

Runtime state: ``<ROOT>/.hq-inventory/inventory.json`` (own folder, own lock, own revision)::

    {"version": 1, "rev": 12,
     "places": [{"id": "plc-<16 hex>", "parent": null, "name": "Garage", "kind": "room", "code": "K7QF",
                 "note": "", "photos": [], "created_at": 1790680000.0, "updated_at": 1790680000.0, "rev": 1}],
     "items":  [{"id": "itm-<16 hex>", "place": "plc-…", "name": "Vis M4×12", "qty": 140, "unit": "pcs", "min": 50,
                 "tags": ["visserie"], "note": "", "photos": ["asset-…"], "created_at": …, "updated_at": …, "rev": 3}]}

Every place has a short ``code`` (4 letters/digits, no look-alikes) printed on its QR label; the label's link opens
``/#inventaire/<place id>``. Writes are revision-aware per record: an update or delete naming an older ``rev`` is refused (409,
the current record is returned) and nothing changes. Quantity nudges (``item.adjust``) are deltas and need no revision, so two
phones counting at once both land. A malformed or redirected file is never rewritten (503) and its bytes stay untouched.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

DIR_NAME = ".hq-inventory"
FILE_NAME = "inventory.json"
VERSION = 1

KINDS = ("room", "furniture", "shelf", "drawer", "box", "bag", "other")
NAME_MAX = 120
NOTE_MAX = 2000
UNIT_MAX = 16
TAG_MAX = 32
TAGS_MAX = 12
PHOTOS_MAX = 6
PLACES_MAX = 2000
ITEMS_MAX = 10000
DEPTH_MAX = 8
QTY_MAX = 10_000_000
BULK_MAX = 500
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"  # no 0/O, 1/I/L
CODE_LEN = 4

PLACE_RE = re.compile(r"^plc-[0-9a-f]{16}\Z")
ITEM_RE = re.compile(r"^itm-[0-9a-f]{16}\Z")
ASSET_RE = re.compile(r"^asset-[0-9a-f]{24}\Z")
CODE_RE = re.compile(r"^[" + CODE_ALPHABET + r"]{4}\Z")
_CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_ONE_LINE_RE = re.compile(r"[\x00-\x1f\x7f]")
_PLACE_KEYS = {"id", "parent", "name", "kind", "code", "note", "photos", "created_at", "updated_at", "rev"}
_ITEM_KEYS = {"id", "place", "name", "qty", "unit", "min", "tags", "note", "photos", "created_at", "updated_at", "rev"}

_cb: dict[str, Any] = {}
_guard = threading.Lock()
_lock = threading.RLock()


class InventoryError(ValueError):
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
    """``root`` (Path), optional ``now`` (clock) and ``asset_exists`` (photo id -> bool, the Carnet image store)."""
    with _guard:
        _cb.update({k: v for k, v in kwargs.items() if k in ("root", "now", "asset_exists")})


def _now() -> float:
    fn = _cb.get("now")
    return round(float(fn()) if callable(fn) else time.time(), 3)


def inventory_path(root: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(root))) / DIR_NAME / FILE_NAME


def _is_link(path: Path | str) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def confined_path(root: Path | str) -> Path:
    """The store path after refusing any redirection (symlink / junction) of the folder, the file or its temp."""
    path = inventory_path(root)
    base = path.parent
    try:
        real_base = os.path.join(os.path.realpath(base.parent), DIR_NAME)
        if os.path.lexists(base) and (_is_link(base) or not _same(os.path.realpath(base), real_base)):
            raise InventoryError("Emplacement de l'inventaire redirigé — refusé, fichier conservé", 503, "storage_error")
        for name in (FILE_NAME, FILE_NAME + ".tmp"):
            item = base / name
            if os.path.lexists(item) and (_is_link(item) or not _same(os.path.realpath(item), os.path.join(real_base, name))):
                raise InventoryError("Emplacement de l'inventaire redirigé — refusé, fichier conservé", 503, "storage_error")
    except OSError as e:
        raise InventoryError("Inventaire inaccessible", 503, "storage_error") from e
    return path


def _path() -> Path:
    root = _cb.get("root")
    if root is None:
        raise InventoryError("Inventaire non initialisé", 503, "storage_error")
    return confined_path(root)


# ---------------------------------------------------------------- validation helpers

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _line(v: Any, field: str, cap: int, *, required: bool = False) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise InventoryError(f"{field} invalide")
    s = _ONE_LINE_RE.sub(" ", v).strip()
    s = re.sub(r"\s{2,}", " ", s)
    if required and not s:
        raise InventoryError(f"{field} requis")
    if len(s) > cap:
        raise InventoryError(f"{field} trop long (max {cap})")
    return s


def _text(v: Any, field: str, cap: int) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise InventoryError(f"{field} invalide")
    s = _CTRL_RE.sub("", v.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if len(s) > cap:
        raise InventoryError(f"{field} trop long (max {cap})")
    return s


def _qty(v: Any, field: str = "Quantité", *, allow_none: bool = False) -> int | None:
    if v is None and allow_none:
        return None
    if isinstance(v, float) and _is_num(v) and v.is_integer():
        v = int(v)
    if not _is_int(v) or v < 0 or v > QTY_MAX:
        raise InventoryError(f"{field} invalide (entier de 0 à {QTY_MAX})")
    return v


def _tags(v: Any) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > TAGS_MAX:
        raise InventoryError(f"Étiquettes invalides (max {TAGS_MAX})")
    out: list[str] = []
    for t in v:
        s = _line(t, "Étiquette", TAG_MAX).lstrip("#").strip().lower()
        if s and s not in out:
            out.append(s)
    return out


def _photos(v: Any, *, check: bool = True) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > PHOTOS_MAX:
        raise InventoryError(f"Photos invalides (max {PHOTOS_MAX})")
    out: list[str] = []
    exists: Callable[[str], bool] | None = _cb.get("asset_exists") if check else None
    for p in v:
        if not isinstance(p, str) or not ASSET_RE.match(p):
            raise InventoryError("Photo invalide")
        if exists is not None and not exists(p):
            raise InventoryError("Photo introuvable — renvoie-la", 400, "missing_photo")
        if p not in out:
            out.append(p)
    return out


def _kind(v: Any) -> str:
    if v is None or v == "":
        return "box"
    if v not in KINDS:
        raise InventoryError("Type d'emplacement invalide")
    return v


# ---------------------------------------------------------------- load / save

def _empty() -> dict:
    return {"version": VERSION, "rev": 0, "places": [], "items": []}


def _valid_place(p: Any) -> bool:
    return (isinstance(p, dict) and set(p) == _PLACE_KEYS and isinstance(p["id"], str) and PLACE_RE.match(p["id"]) is not None
            and (p["parent"] is None or (isinstance(p["parent"], str) and PLACE_RE.match(p["parent"]) is not None))
            and isinstance(p["name"], str) and 0 < len(p["name"]) <= NAME_MAX and p["kind"] in KINDS
            and isinstance(p["code"], str) and CODE_RE.match(p["code"]) is not None
            and isinstance(p["note"], str) and len(p["note"]) <= NOTE_MAX
            and isinstance(p["photos"], list) and len(p["photos"]) <= PHOTOS_MAX and all(isinstance(x, str) and ASSET_RE.match(x) for x in p["photos"])
            and _is_num(p["created_at"]) and _is_num(p["updated_at"]) and _is_int(p["rev"]) and p["rev"] >= 1)


def _valid_item(i: Any) -> bool:
    return (isinstance(i, dict) and set(i) == _ITEM_KEYS and isinstance(i["id"], str) and ITEM_RE.match(i["id"]) is not None
            and (i["place"] is None or (isinstance(i["place"], str) and PLACE_RE.match(i["place"]) is not None))
            and isinstance(i["name"], str) and 0 < len(i["name"]) <= NAME_MAX
            and _is_int(i["qty"]) and 0 <= i["qty"] <= QTY_MAX and isinstance(i["unit"], str) and len(i["unit"]) <= UNIT_MAX
            and (i["min"] is None or (_is_int(i["min"]) and 0 <= i["min"] <= QTY_MAX))
            and isinstance(i["tags"], list) and len(i["tags"]) <= TAGS_MAX and all(isinstance(t, str) and 0 < len(t) <= TAG_MAX for t in i["tags"])
            and isinstance(i["note"], str) and len(i["note"]) <= NOTE_MAX
            and isinstance(i["photos"], list) and len(i["photos"]) <= PHOTOS_MAX and all(isinstance(x, str) and ASSET_RE.match(x) for x in i["photos"])
            and _is_num(i["created_at"]) and _is_num(i["updated_at"]) and _is_int(i["rev"]) and i["rev"] >= 1)


def validate_doc(doc: Any) -> bool:
    """Whole-file check: shape, ids unique, parents and places exist, no cycles, depth bounded, codes unique."""
    if not isinstance(doc, dict) or set(doc) != {"version", "rev", "places", "items"} or doc["version"] != VERSION:
        return False
    if not _is_int(doc["rev"]) or doc["rev"] < 0 or not isinstance(doc["places"], list) or not isinstance(doc["items"], list):
        return False
    if len(doc["places"]) > PLACES_MAX or len(doc["items"]) > ITEMS_MAX:
        return False
    if not all(_valid_place(p) for p in doc["places"]) or not all(_valid_item(i) for i in doc["items"]):
        return False
    places = {p["id"]: p for p in doc["places"]}
    if len(places) != len(doc["places"]) or len({p["code"] for p in doc["places"]}) != len(doc["places"]):
        return False
    if len({i["id"] for i in doc["items"]}) != len(doc["items"]):
        return False
    for p in doc["places"]:
        if p["parent"] is not None and p["parent"] not in places:
            return False
        if _depth(places, p["id"]) is None:
            return False
    return all(i["place"] is None or i["place"] in places for i in doc["items"])


def _depth(places: dict, pid: str) -> int | None:
    """1 for a top-level place; None for a cycle or a chain deeper than DEPTH_MAX."""
    d = 0
    seen = set()
    cur: str | None = pid
    while cur is not None:
        if cur in seen or d >= DEPTH_MAX:
            return None
        seen.add(cur)
        p = places.get(cur)
        if p is None:
            return None
        d += 1
        cur = p["parent"]
    return d


def _subtree_height(places: dict, pid: str) -> int:
    kids = [p["id"] for p in places.values() if p["parent"] == pid]
    return 1 + max((_subtree_height(places, k) for k in kids), default=0)


def _load(path: Path) -> dict:
    if not os.path.lexists(path):
        return _empty()
    try:
        raw = path.read_bytes()
    except OSError as e:
        raise InventoryError("Inventaire illisible", 503, "storage_error") from e
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise InventoryError("inventory.json illisible — fichier conservé", 503, "storage_error") from e
    if not validate_doc(doc):
        raise InventoryError("inventory.json invalide — fichier conservé", 503, "storage_error")
    return doc


def _save(path: Path, doc: dict) -> None:
    if not validate_doc(doc):  # never write what we would refuse to read
        raise InventoryError("État incohérent — rien n'a été enregistré", 500, "internal_error")
    base = path.parent
    try:
        base.mkdir(parents=True, exist_ok=True)
        confined_path(_cb["root"])
        tmp = base / (FILE_NAME + ".tmp")
        data = (json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with open(tmp, "wb") as out:
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, path)
    except OSError as e:
        raise InventoryError("Enregistrement de l'inventaire impossible", 503, "storage_error") from e


def snapshot() -> dict:
    with _lock:
        return _load(_path())


def snapshot_bytes() -> bytes | None:
    """Exact bytes for a backup, or None when there is no inventory yet."""
    with _lock:
        path = _path()
        if not os.path.lexists(path):
            return None
        _load(path)
        return path.read_bytes()


# ---------------------------------------------------------------- mutations

def _new_code(taken: set[str]) -> str:
    for _ in range(200):
        c = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if c not in taken:
            return c
    raise InventoryError("Plus de codes disponibles", 507, "quota")


def _find(rows: list[dict], rid: Any) -> dict | None:
    for r in rows:
        if r["id"] == rid:
            return r
    return None


def _need_rev(rec: dict, rev: Any, what: str) -> None:
    if not _is_int(rev):
        raise InventoryError("Révision requise")
    if rev != rec["rev"]:
        raise InventoryError(f"{what} modifié ailleurs — rechargé", 409, "conflict", {what_key(what): dict(rec)})


def what_key(what: str) -> str:
    return "place" if what.startswith("Emplacement") else "item"


def _check_parent(places: dict, pid: str | None, parent: Any, *, moving_height: int = 1) -> str | None:
    if parent is None or parent == "":
        return None
    if not isinstance(parent, str) or parent not in places:
        raise InventoryError("Emplacement parent introuvable", 404, "not_found")
    if pid is not None:
        cur: str | None = parent
        while cur is not None:
            if cur == pid:
                raise InventoryError("Un emplacement ne peut pas aller dans lui-même", 400, "cycle")
            cur = places[cur]["parent"]
    d = _depth(places, parent)
    if d is None or d + moving_height > DEPTH_MAX:
        raise InventoryError(f"Trop de niveaux (max {DEPTH_MAX})", 400, "too_deep")
    return parent


def _place_from(data: dict, places: dict, codes: set[str], now: float, *, keep: dict | None = None) -> dict:
    rec = {
        "id": keep["id"] if keep else "plc-" + secrets.token_hex(8),
        "parent": _check_parent(places, keep["id"] if keep else None, data.get("parent")),
        "name": _line(data.get("name"), "Nom", NAME_MAX, required=True),
        "kind": _kind(data.get("kind")),
        "code": keep["code"] if keep and isinstance(keep.get("code"), str) and CODE_RE.match(keep["code"]) and keep["code"] not in codes else _new_code(codes),
        "note": _text(data.get("note"), "Note", NOTE_MAX),
        "photos": _photos(data.get("photos")),
        "created_at": keep["created_at"] if keep else now,
        "updated_at": now,
        "rev": 1,
    }
    return rec


def _item_from(data: dict, places: dict, now: float, *, keep: dict | None = None) -> dict:
    place = data.get("place")
    if place in ("", None):
        place = None
    elif not isinstance(place, str) or place not in places:
        raise InventoryError("Emplacement introuvable", 404, "not_found")
    return {
        "id": keep["id"] if keep else "itm-" + secrets.token_hex(8),
        "place": place,
        "name": _line(data.get("name"), "Nom", NAME_MAX, required=True),
        "qty": _qty(data.get("qty", 1)),
        "unit": _line(data.get("unit"), "Unité", UNIT_MAX),
        "min": _qty(data.get("min"), "Seuil", allow_none=True),
        "tags": _tags(data.get("tags")),
        "note": _text(data.get("note"), "Note", NOTE_MAX),
        "photos": _photos(data.get("photos")),
        "created_at": keep["created_at"] if keep else now,
        "updated_at": now,
        "rev": 1,
    }


_PLACE_FIELDS = ("parent", "name", "kind", "note", "photos")
_ITEM_FIELDS = ("place", "name", "qty", "unit", "min", "tags", "note", "photos")


def apply(data: dict) -> dict:
    """One write. Returns the response payload (always carrying the new store ``rev``)."""
    if not isinstance(data, dict):
        raise InventoryError("Requête invalide")
    action = data.get("action")
    with _lock:
        path = _path()
        doc = _load(path)
        places = {p["id"]: p for p in doc["places"]}
        now = _now()
        out: dict[str, Any] = {}

        if action in ("place.create", "place.restore"):
            if len(doc["places"]) >= PLACES_MAX:
                raise InventoryError(f"Limite d'emplacements atteinte ({PLACES_MAX})", 507, "quota")
            keep = None
            if action == "place.restore":
                src = data.get("place")
                if not isinstance(src, dict) or not isinstance(src.get("id"), str) or not PLACE_RE.match(src["id"]):
                    raise InventoryError("Emplacement à rétablir invalide")
                if src["id"] in places:
                    raise InventoryError("Cet emplacement existe déjà", 409, "exists")
                keep = {"id": src["id"], "code": src.get("code"), "created_at": src["created_at"] if _is_num(src.get("created_at")) else now}
                fields = dict(src)
                if fields.get("parent") not in places:
                    fields["parent"] = None  # its parent is gone: back to the top level, never lost
            else:
                fields = data
            rec = _place_from(fields, places, {p["code"] for p in doc["places"]}, now, keep=keep)
            doc["places"].append(rec)
            out["place"] = rec

        elif action == "place.update":
            rec = places.get(data.get("id"))
            if rec is None:
                raise InventoryError("Emplacement introuvable", 404, "not_found")
            _need_rev(rec, data.get("rev"), "Emplacement")
            if "parent" in data:
                rec["parent"] = _check_parent(places, rec["id"], data.get("parent"), moving_height=_subtree_height(places, rec["id"]))
            if "name" in data:
                rec["name"] = _line(data["name"], "Nom", NAME_MAX, required=True)
            if "kind" in data:
                rec["kind"] = _kind(data["kind"])
            if "note" in data:
                rec["note"] = _text(data["note"], "Note", NOTE_MAX)
            if "photos" in data:
                rec["photos"] = _photos(data["photos"])
            rec["updated_at"] = now
            rec["rev"] += 1
            out["place"] = rec

        elif action == "place.delete":
            rec = places.get(data.get("id"))
            if rec is None:
                raise InventoryError("Emplacement introuvable", 404, "not_found")
            _need_rev(rec, data.get("rev"), "Emplacement")
            kids = [p for p in doc["places"] if p["parent"] == rec["id"]]
            items = [i for i in doc["items"] if i["place"] == rec["id"]]
            if (kids or items) and data.get("contents") != "parent":
                raise InventoryError("Cet emplacement n'est pas vide", 409, "not_empty", {"places": len(kids), "items": len(items)})
            for k in kids:  # contents go up one level; depth only shrinks
                k["parent"] = rec["parent"]
                k["updated_at"] = now
                k["rev"] += 1
            for i in items:
                i["place"] = rec["parent"]
                i["updated_at"] = now
                i["rev"] += 1
            doc["places"] = [p for p in doc["places"] if p["id"] != rec["id"]]
            out["deleted"] = rec
            out["moved"] = {"places": [k["id"] for k in kids], "items": [i["id"] for i in items], "to": rec["parent"]}

        elif action in ("item.create", "item.restore"):
            if len(doc["items"]) >= ITEMS_MAX:
                raise InventoryError(f"Limite d'objets atteinte ({ITEMS_MAX})", 507, "quota")
            keep = None
            fields = data
            if action == "item.restore":
                src = data.get("item")
                if not isinstance(src, dict) or not isinstance(src.get("id"), str) or not ITEM_RE.match(src["id"]):
                    raise InventoryError("Objet à rétablir invalide")
                if _find(doc["items"], src["id"]) is not None:
                    raise InventoryError("Cet objet existe déjà", 409, "exists")
                keep = {"id": src["id"], "created_at": src["created_at"] if _is_num(src.get("created_at")) else now}
                fields = dict(src)
                if fields.get("place") not in places:
                    fields["place"] = None  # its place is gone: back to « Sans emplacement », never lost
            rec = _item_from(fields, places, now, keep=keep)
            doc["items"].append(rec)
            out["item"] = rec

        elif action == "item.update":
            rec = _find(doc["items"], data.get("id"))
            if rec is None:
                raise InventoryError("Objet introuvable", 404, "not_found")
            _need_rev(rec, data.get("rev"), "Objet")
            if "place" in data:
                p = data["place"]
                if p in ("", None):
                    rec["place"] = None
                elif isinstance(p, str) and p in places:
                    rec["place"] = p
                else:
                    raise InventoryError("Emplacement introuvable", 404, "not_found")
            if "name" in data:
                rec["name"] = _line(data["name"], "Nom", NAME_MAX, required=True)
            if "qty" in data:
                rec["qty"] = _qty(data["qty"])
            if "unit" in data:
                rec["unit"] = _line(data["unit"], "Unité", UNIT_MAX)
            if "min" in data:
                rec["min"] = _qty(data["min"], "Seuil", allow_none=True)
            if "tags" in data:
                rec["tags"] = _tags(data["tags"])
            if "note" in data:
                rec["note"] = _text(data["note"], "Note", NOTE_MAX)
            if "photos" in data:
                rec["photos"] = _photos(data["photos"])
            rec["updated_at"] = now
            rec["rev"] += 1
            out["item"] = rec

        elif action == "item.adjust":
            rec = _find(doc["items"], data.get("id"))
            if rec is None:
                raise InventoryError("Objet introuvable", 404, "not_found")
            delta = data.get("delta")
            if not _is_int(delta) or delta == 0 or abs(delta) > QTY_MAX:
                raise InventoryError("Variation invalide")
            rec["qty"] = max(0, min(QTY_MAX, rec["qty"] + delta))
            rec["updated_at"] = now
            rec["rev"] += 1
            out["item"] = rec

        elif action == "item.delete":
            rec = _find(doc["items"], data.get("id"))
            if rec is None:
                raise InventoryError("Objet introuvable", 404, "not_found")
            _need_rev(rec, data.get("rev"), "Objet")
            doc["items"] = [i for i in doc["items"] if i["id"] != rec["id"]]
            out["deleted"] = rec

        elif action == "item.move":
            ids = data.get("ids")
            if not isinstance(ids, list) or not ids or len(ids) > BULK_MAX or not all(isinstance(x, str) for x in ids):
                raise InventoryError(f"Sélection invalide (1 à {BULK_MAX} objets)")
            dest = data.get("place")
            if dest in ("", None):
                dest = None
            elif not isinstance(dest, str) or dest not in places:
                raise InventoryError("Emplacement introuvable", 404, "not_found")
            byid = {i["id"]: i for i in doc["items"]}
            missing = [x for x in ids if x not in byid]
            if missing:
                raise InventoryError("Objet introuvable", 404, "not_found")
            moved = []
            for x in dict.fromkeys(ids):
                rec = byid[x]
                if rec["place"] != dest:
                    rec["place"] = dest
                    rec["updated_at"] = now
                    rec["rev"] += 1
                moved.append(rec)
            out["items"] = moved

        else:
            raise InventoryError("Action inconnue")

        doc["rev"] += 1
        _save(path, doc)
        out["ok"] = True
        out["rev"] = doc["rev"]
        return out


# ---------------------------------------------------------------- pure queries (also used by tests)

def place_path(doc: dict, pid: str | None) -> list[dict]:
    """Root-first chain of places ending at ``pid`` ([] for None / unknown)."""
    places = {p["id"]: p for p in doc["places"]}
    chain: list[dict] = []
    cur = pid
    while cur is not None and cur in places and len(chain) < DEPTH_MAX:
        chain.append(places[cur])
        cur = places[cur]["parent"]
    return list(reversed(chain))


def low_stock(doc: dict) -> list[dict]:
    return [i for i in doc["items"] if i["min"] is not None and i["qty"] <= i["min"]]


def summary() -> dict:
    """Small numbers for the Accueil (no names)."""
    doc = snapshot()
    return {"places": len(doc["places"]), "items": len(doc["items"]), "low": len(low_stock(doc))}


# ---------------------------------------------------------------- HTTP

def http_get(qs: dict) -> tuple[int, dict]:
    try:
        since = (qs.get("since") or [""])[0]
        doc = snapshot()
        if since and since.isdigit() and int(since) == doc["rev"]:
            return 200, {"ok": True, "rev": doc["rev"], "unchanged": True}
        return 200, {"ok": True, "rev": doc["rev"], "places": doc["places"], "items": doc["items"],
                     "limits": {"photos": PHOTOS_MAX, "depth": DEPTH_MAX, "name": NAME_MAX, "note": NOTE_MAX, "tags": TAGS_MAX}}
    except InventoryError as e:
        return e.status, {"error": str(e), "code": e.code, **e.extra}


def http_post(data: dict) -> tuple[int, dict]:
    try:
        return 200, apply(data)
    except InventoryError as e:
        payload = {"error": str(e), "code": e.code, **e.extra}
        if e.status == 409:
            try:
                payload["rev"] = snapshot()["rev"]
            except InventoryError:
                pass
        return e.status, payload
