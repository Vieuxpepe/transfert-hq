"""Transfert HQ — Projets: long builds. Stdlib only.

A project has a status, a goal, dates, a colour, an optional cover photo, milestones, a parts list (BOM) that can point at
Inventaire items, links (Carnet pages, Forge images, Dessiner drawings, files) and a photo timeline.

Its tasks are the cards of the EXISTING Kanban board (``kanban.json``, owned by cc_ext): a card gains optional fields
``project``, ``milestone``, ``note``, ``due`` and ``updated``. Cards without a project stay on the general board (« Tâches
libres »); the Carnet keeps adding cards there exactly as before. Projets reads the board strictly and writes it atomically
under its path lock: a malformed board is never repaired or overwritten (503), its bytes stay as they are.

Runtime state: ``<ROOT>/.hq-projects/projects.json`` (own folder, own lock, own revision). Writes are revision-aware per
project (409 returns the current project). Photos are images of the Carnet image store, referenced by id only.
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

import hq_state

DIR_NAME = ".hq-projects"
FILE_NAME = "projects.json"
KANBAN_NAME = "kanban.json"
VERSION = 1

STATUSES = ("idea", "active", "paused", "done")
LINK_KINDS = ("carnet", "forge", "drawing", "file")
BOM_STATUSES = ("need", "ordered", "have")
COLUMNS = ("todo", "doing", "done")
NAME_MAX = 120
TEXT_MAX = 4000
NOTE_MAX = 2000
UNIT_MAX = 16
PROJECTS_MAX = 300
MILESTONES_MAX = 60
BOM_MAX = 400
LINKS_MAX = 200
TIMELINE_MAX = 600
QTY_MAX = 10_000_000
COST_MAX = 100_000_000  # cents
CARDS_MAX = 5000

PROJECT_RE = re.compile(r"^prj-[0-9a-f]{16}\Z")
SUB_RE = {"milestone": re.compile(r"^mst-[0-9a-f]{10}\Z"), "bom": re.compile(r"^bom-[0-9a-f]{10}\Z"),
          "link": re.compile(r"^lnk-[0-9a-f]{10}\Z"), "entry": re.compile(r"^ent-[0-9a-f]{10}\Z")}
ASSET_RE = re.compile(r"^asset-[0-9a-f]{24}\Z")
ITEM_RE = re.compile(r"^itm-[0-9a-f]{16}\Z")
DATE_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\Z")
CARD_RE = re.compile(r"^c-[0-9A-Za-z_-]{1,40}\Z")
REF_RE = {
    "carnet": re.compile(r"^page-[A-Za-z0-9_-]{1,64}\Z"),
    "forge": re.compile(r"^[A-Za-z0-9_-]{1,80}\Z"),
    "drawing": re.compile(r"^[A-Za-z0-9_.-]{1,120}\Z"),
    "file": re.compile(r"^(?!/)(?!.*(^|/)\.\.?(/|$))[^\x00-\x1f\\:*?\"<>|]{1,400}\Z"),
}
_CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_ONE_LINE_RE = re.compile(r"[\x00-\x1f\x7f]")
_PROJECT_KEYS = {"id", "name", "status", "goal", "hue", "start", "due", "cover", "carnet_project", "milestones", "bom", "links",
                 "timeline", "resume", "resume_at", "created_at", "updated_at", "rev"}
RESUME_MAX = 1000

_cb: dict[str, Any] = {}
_guard = threading.Lock()
_lock = threading.RLock()


class ProjectError(ValueError):
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
    """``root``; optional ``now``, ``asset_exists`` (photo id -> bool), ``inventory_adjust`` (item id, delta -> item dict)."""
    with _guard:
        _cb.update({k: v for k, v in kwargs.items() if k in ("root", "now", "asset_exists", "inventory_adjust")})


def _now() -> float:
    fn = _cb.get("now")
    return round(float(fn()) if callable(fn) else time.time(), 3)


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise ProjectError("Projets non initialisés", 503, "storage_error")
    return Path(os.path.abspath(os.fspath(root)))


def _is_link(path: Path | str) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


def projects_path(root: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(root))) / DIR_NAME / FILE_NAME


def confined_path(root: Path | str) -> Path:
    path = projects_path(root)
    base = path.parent
    msg = "Emplacement des projets redirigé — refusé, fichier conservé"
    try:
        real_base = os.path.join(os.path.realpath(base.parent), DIR_NAME)
        if os.path.lexists(base) and (_is_link(base) or not _same(os.path.realpath(base), real_base)):
            raise ProjectError(msg, 503, "storage_error")
        for name in (FILE_NAME, FILE_NAME + ".tmp"):
            item = base / name
            if os.path.lexists(item) and (_is_link(item) or not _same(os.path.realpath(item), os.path.join(real_base, name))):
                raise ProjectError(msg, 503, "storage_error")
    except OSError as e:
        raise ProjectError("Projets inaccessibles", 503, "storage_error") from e
    return path


# ---------------------------------------------------------------- validation helpers

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _line(v: Any, field: str, cap: int, *, required: bool = False) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise ProjectError(f"{field} invalide")
    s = re.sub(r"\s{2,}", " ", _ONE_LINE_RE.sub(" ", v)).strip()
    if required and not s:
        raise ProjectError(f"{field} requis")
    if len(s) > cap:
        raise ProjectError(f"{field} trop long (max {cap})")
    return s


def _text(v: Any, field: str, cap: int) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise ProjectError(f"{field} invalide")
    s = _CTRL_RE.sub("", v.replace("\r\n", "\n").replace("\r", "\n")).strip()
    if len(s) > cap:
        raise ProjectError(f"{field} trop long (max {cap})")
    return s


def _date(v: Any, field: str) -> str | None:
    if v in (None, ""):
        return None
    if not isinstance(v, str) or not DATE_RE.match(v):
        raise ProjectError(f"{field} invalide (AAAA-MM-JJ)")
    return v


def _int(v: Any, field: str, lo: int, hi: int, *, allow_none: bool = False) -> int | None:
    if v is None and allow_none:
        return None
    if isinstance(v, float) and _is_num(v) and v.is_integer():
        v = int(v)
    if not _is_int(v) or v < lo or v > hi:
        raise ProjectError(f"{field} invalide")
    return v


def _asset(v: Any, *, allow_none: bool = True, check: bool = True) -> str | None:
    if v in (None, "") and allow_none:
        return None
    if not isinstance(v, str) or not ASSET_RE.match(v):
        raise ProjectError("Photo invalide")
    exists: Callable[[str], bool] | None = _cb.get("asset_exists") if check else None
    if exists is not None and not exists(v):
        raise ProjectError("Photo introuvable — renvoie-la", 400, "missing_photo")
    return v


def _choice(v: Any, field: str, allowed: tuple, default: str) -> str:
    if v in (None, ""):
        return default
    if v not in allowed:
        raise ProjectError(f"{field} invalide")
    return v


def _sub_id(kind: str) -> str:
    prefix = {"milestone": "mst", "bom": "bom", "link": "lnk", "entry": "ent"}[kind]
    return prefix + "-" + secrets.token_hex(5)


# ---------------------------------------------------------------- record shapes

def _valid_milestone(m: Any) -> bool:
    return (isinstance(m, dict) and set(m) == {"id", "title", "due", "done"} and isinstance(m["id"], str) and SUB_RE["milestone"].match(m["id"]) is not None
            and isinstance(m["title"], str) and 0 < len(m["title"]) <= NAME_MAX and (m["due"] is None or (isinstance(m["due"], str) and DATE_RE.match(m["due"]) is not None))
            and isinstance(m["done"], bool))


def _valid_bom(b: Any) -> bool:
    return (isinstance(b, dict) and set(b) == {"id", "item", "name", "qty", "unit", "cost", "status", "note", "used"}
            and isinstance(b["id"], str) and SUB_RE["bom"].match(b["id"]) is not None
            and (b["item"] is None or (isinstance(b["item"], str) and ITEM_RE.match(b["item"]) is not None))
            and isinstance(b["name"], str) and 0 < len(b["name"]) <= NAME_MAX and _is_int(b["qty"]) and 0 < b["qty"] <= QTY_MAX
            and isinstance(b["unit"], str) and len(b["unit"]) <= UNIT_MAX and (b["cost"] is None or (_is_int(b["cost"]) and 0 <= b["cost"] <= COST_MAX))
            and b["status"] in BOM_STATUSES and isinstance(b["note"], str) and len(b["note"]) <= NOTE_MAX and isinstance(b["used"], bool))


def _valid_link(lk: Any) -> bool:
    return (isinstance(lk, dict) and set(lk) == {"id", "kind", "ref", "title"} and isinstance(lk["id"], str) and SUB_RE["link"].match(lk["id"]) is not None
            and lk["kind"] in LINK_KINDS and isinstance(lk["ref"], str) and REF_RE[lk["kind"]].match(lk["ref"]) is not None
            and isinstance(lk["title"], str) and len(lk["title"]) <= NAME_MAX)


def _valid_entry(e: Any) -> bool:
    return (isinstance(e, dict) and set(e) == {"id", "at", "text", "photos"} and isinstance(e["id"], str) and SUB_RE["entry"].match(e["id"]) is not None
            and _is_num(e["at"]) and isinstance(e["text"], str) and len(e["text"]) <= NOTE_MAX
            and isinstance(e["photos"], list) and len(e["photos"]) <= 6 and all(isinstance(x, str) and ASSET_RE.match(x) for x in e["photos"])
            and (e["text"] or e["photos"]))


def _valid_project(p: Any) -> bool:
    return (isinstance(p, dict) and set(p) == _PROJECT_KEYS and isinstance(p["id"], str) and PROJECT_RE.match(p["id"]) is not None
            and isinstance(p["name"], str) and 0 < len(p["name"]) <= NAME_MAX and p["status"] in STATUSES
            and isinstance(p["goal"], str) and len(p["goal"]) <= TEXT_MAX and _is_int(p["hue"]) and 0 <= p["hue"] < 360
            and all(p[k] is None or (isinstance(p[k], str) and DATE_RE.match(p[k]) is not None) for k in ("start", "due"))
            and (p["cover"] is None or (isinstance(p["cover"], str) and ASSET_RE.match(p["cover"]) is not None))
            and (p["carnet_project"] is None or (isinstance(p["carnet_project"], str) and len(p["carnet_project"]) <= 80))
            and isinstance(p["milestones"], list) and len(p["milestones"]) <= MILESTONES_MAX and all(_valid_milestone(m) for m in p["milestones"])
            and isinstance(p["bom"], list) and len(p["bom"]) <= BOM_MAX and all(_valid_bom(b) for b in p["bom"])
            and isinstance(p["links"], list) and len(p["links"]) <= LINKS_MAX and all(_valid_link(x) for x in p["links"])
            and isinstance(p["timeline"], list) and len(p["timeline"]) <= TIMELINE_MAX and all(_valid_entry(e) for e in p["timeline"])
            and isinstance(p["resume"], str) and len(p["resume"]) <= RESUME_MAX and (p["resume_at"] is None or _is_num(p["resume_at"]))
            and _is_num(p["created_at"]) and _is_num(p["updated_at"]) and _is_int(p["rev"]) and p["rev"] >= 1)


def validate_doc(doc: Any) -> bool:
    if not isinstance(doc, dict) or set(doc) != {"version", "rev", "projects"} or doc["version"] != VERSION:
        return False
    if not _is_int(doc["rev"]) or doc["rev"] < 0 or not isinstance(doc["projects"], list) or len(doc["projects"]) > PROJECTS_MAX:
        return False
    if not all(_valid_project(p) for p in doc["projects"]):
        return False
    return len({p["id"] for p in doc["projects"]}) == len(doc["projects"])


# ---------------------------------------------------------------- projects file

def _empty() -> dict:
    return {"version": VERSION, "rev": 0, "projects": []}


def _load(path: Path) -> dict:
    if not os.path.lexists(path):
        return _empty()
    try:
        raw = path.read_bytes()
        doc = json.loads(raw.decode("utf-8"))
    except OSError as e:
        raise ProjectError("Projets illisibles", 503, "storage_error") from e
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise ProjectError("projects.json illisible — fichier conservé", 503, "storage_error") from e
    if isinstance(doc, dict) and isinstance(doc.get("projects"), list):  # files written before « Où j'en suis » existed
        for p in doc["projects"]:
            if isinstance(p, dict) and "resume" not in p and "resume_at" not in p:
                p["resume"] = ""
                p["resume_at"] = None
    if not validate_doc(doc):
        raise ProjectError("projects.json invalide — fichier conservé", 503, "storage_error")
    return doc


def _write_bytes(path: Path, data: bytes) -> None:
    tmp = path.parent / (path.name + ".tmp")
    with open(tmp, "wb") as out:
        out.write(data)
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp, path)


def _save(path: Path, doc: dict) -> None:
    if not validate_doc(doc):
        raise ProjectError("État incohérent — rien n'a été enregistré", 500, "internal_error")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        confined_path(_root())
        _write_bytes(path, (json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    except OSError as e:
        raise ProjectError("Enregistrement des projets impossible", 503, "storage_error") from e


def snapshot() -> dict:
    with _lock:
        return _load(confined_path(_root()))


# ---------------------------------------------------------------- the Kanban board (shared with cc_ext and the Carnet)

def kanban_path() -> Path:
    return _root() / KANBAN_NAME


def _default_board() -> dict:
    return {"columns": [{"id": "todo", "title": "À faire", "cards": []}, {"id": "doing", "title": "En cours", "cards": []},
                        {"id": "done", "title": "Fait", "cards": []}]}


def _load_board(path: Path) -> dict:
    """Strict: a missing board is the default one; anything unusable is refused and left byte for byte."""
    bad = ProjectError("Tableau des tâches illisible — fichier conservé", 503, "board_unreadable")
    if not os.path.lexists(path):
        return _default_board()
    try:
        if _is_link(path) or not path.is_file():
            raise bad
        board = json.loads(path.read_bytes().decode("utf-8"))
    except ProjectError:
        raise
    except (OSError, UnicodeDecodeError, ValueError) as e:
        raise bad from e
    cols = board.get("columns") if isinstance(board, dict) else None
    if not isinstance(cols, list) or not cols:
        raise bad
    ids = set()
    for col in cols:
        if not isinstance(col, dict) or not isinstance(col.get("id"), str) or not col["id"]:
            raise bad
        cards = col.get("cards", [])
        if not isinstance(cards, list) or not all(isinstance(c, dict) and isinstance(c.get("id"), str) for c in cards):
            raise bad
        ids.add(col["id"])
    if not set(COLUMNS) <= ids:
        raise bad
    return board


def _save_board(path: Path, board: dict) -> None:
    try:
        if os.path.lexists(path) and (_is_link(path) or not path.is_file()):
            raise ProjectError("Tableau des tâches redirigé — refusé", 503, "board_unreadable")
        _write_bytes(path, (json.dumps(board, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    except OSError as e:
        raise ProjectError("Enregistrement des tâches impossible", 503, "storage_error") from e


def _find_card(board: dict, cid: Any) -> tuple[dict, int, dict] | None:
    for col in board["columns"]:
        for k, c in enumerate(col.get("cards") or []):
            if c.get("id") == cid:
                return col, k, c
    return None


def _col(board: dict, cid: Any) -> dict:
    for col in board["columns"]:
        if col["id"] == cid:
            col.setdefault("cards", [])
            return col
    raise ProjectError("Colonne inconnue")


def _card_view(card: dict, column: str) -> dict:
    out = {"id": card.get("id"), "column": column, "title": str(card.get("title") or "")[:NAME_MAX]}
    for k in ("project", "milestone", "note", "due", "created", "updated"):
        if k in card:
            out[k] = card[k]
    return out


def tasks(board: dict) -> list[dict]:
    out = []
    for col in board["columns"]:
        if col["id"] not in COLUMNS:
            continue
        for c in col.get("cards") or []:
            out.append(_card_view(c, col["id"]))
    return out


# ---------------------------------------------------------------- mutations

def _project(doc: dict, pid: Any) -> dict:
    for p in doc["projects"]:
        if p["id"] == pid:
            return p
    raise ProjectError("Projet introuvable", 404, "not_found")


def _need_rev(p: dict, rev: Any) -> None:
    if not _is_int(rev):
        raise ProjectError("Révision requise")
    if rev != p["rev"]:
        raise ProjectError("Projet modifié ailleurs — rechargé", 409, "conflict", {"project": json.loads(json.dumps(p))})


def _sub(p: dict, key: str, sid: Any) -> dict:
    for x in p[key]:
        if x["id"] == sid:
            return x
    raise ProjectError("Élément introuvable", 404, "not_found")


def _apply_fields(p: dict, data: dict) -> None:
    if "name" in data:
        p["name"] = _line(data["name"], "Nom", NAME_MAX, required=True)
    if "status" in data:
        p["status"] = _choice(data["status"], "Statut", STATUSES, "active")
    if "goal" in data:
        p["goal"] = _text(data["goal"], "Objectif", TEXT_MAX)
    if "hue" in data:
        p["hue"] = _int(data["hue"], "Couleur", 0, 359)
    if "start" in data:
        p["start"] = _date(data["start"], "Début")
    if "due" in data:
        p["due"] = _date(data["due"], "Échéance")
    if "cover" in data:
        p["cover"] = _asset(data["cover"])
    if "carnet_project" in data:
        v = data["carnet_project"]
        if v in (None, ""):
            p["carnet_project"] = None
        elif isinstance(v, str) and re.match(r"^[A-Za-z0-9_-]{1,80}\Z", v):
            p["carnet_project"] = v
        else:
            raise ProjectError("Projet Carnet invalide")
    if p["start"] and p["due"] and p["due"] < p["start"]:
        raise ProjectError("L'échéance est avant le début")


def _milestone_from(d: dict, keep: dict | None = None) -> dict:
    return {"id": keep["id"] if keep else _sub_id("milestone"), "title": _line(d.get("title", keep and keep["title"]), "Jalon", NAME_MAX, required=True),
            "due": _date(d.get("due") if "due" in d else (keep and keep["due"]), "Date du jalon"),
            "done": bool(d.get("done")) if "done" in d else bool(keep and keep["done"])}


def _bom_from(d: dict, keep: dict | None = None) -> dict:
    g = lambda k, default: d[k] if k in d else (keep[k] if keep else default)  # noqa: E731
    item = g("item", None)
    if item in ("", None):
        item = None
    elif not isinstance(item, str) or not ITEM_RE.match(item):
        raise ProjectError("Objet d'inventaire invalide")
    return {"id": keep["id"] if keep else _sub_id("bom"), "item": item, "name": _line(g("name", ""), "Pièce", NAME_MAX, required=True),
            "qty": _int(g("qty", 1), "Quantité", 1, QTY_MAX), "unit": _line(g("unit", ""), "Unité", UNIT_MAX),
            "cost": _int(g("cost", None), "Prix", 0, COST_MAX, allow_none=True), "status": _choice(g("status", "need"), "État", BOM_STATUSES, "need"),
            "note": _text(g("note", ""), "Note", NOTE_MAX), "used": bool(g("used", False))}


def _link_from(d: dict) -> dict:
    kind = d.get("kind")
    if kind not in LINK_KINDS:
        raise ProjectError("Type de lien invalide")
    ref = d.get("ref")
    if not isinstance(ref, str) or not REF_RE[kind].match(ref):
        raise ProjectError("Lien invalide")
    return {"id": _sub_id("link"), "kind": kind, "ref": ref, "title": _line(d.get("title"), "Titre", NAME_MAX)}


def _entry_from(d: dict, now: float) -> dict:
    photos = d.get("photos") or []
    if not isinstance(photos, list) or len(photos) > 6:
        raise ProjectError("Photos invalides (max 6)")
    photos = [_asset(x, allow_none=False) for x in photos]
    text = _text(d.get("text"), "Texte", NOTE_MAX)
    if not text and not photos:
        raise ProjectError("Ajoute une photo ou un mot")
    at = d.get("at")
    if at is not None and (not _is_num(at) or at < 0 or at > now + 86400):
        raise ProjectError("Date invalide")
    return {"id": _sub_id("entry"), "at": round(float(at), 3) if at is not None else now, "text": text, "photos": list(dict.fromkeys(photos))}


_SUBS = {"milestone": ("milestones", MILESTONES_MAX), "bom": ("bom", BOM_MAX), "link": ("links", LINKS_MAX), "entry": ("timeline", TIMELINE_MAX)}


def _project_action(action: str, data: dict) -> dict:
    with _lock:
        path = confined_path(_root())
        doc = _load(path)
        now = _now()
        out: dict[str, Any] = {}
        if action == "project.create":
            if len(doc["projects"]) >= PROJECTS_MAX:
                raise ProjectError(f"Limite de projets atteinte ({PROJECTS_MAX})", 507, "quota")
            p = {"id": "prj-" + secrets.token_hex(8), "name": "", "status": "active", "goal": "", "hue": secrets.randbelow(360), "start": None,
                 "due": None, "cover": None, "carnet_project": None, "milestones": [], "bom": [], "links": [], "timeline": [],
                 "resume": "", "resume_at": None, "created_at": now, "updated_at": now, "rev": 1}
            _apply_fields(p, {k: v for k, v in data.items() if k in ("name", "status", "goal", "hue", "start", "due", "cover", "carnet_project")})
            if not p["name"]:
                raise ProjectError("Nom requis")
            doc["projects"].append(p)
            out["project"] = p
        elif action == "project.restore":
            src = data.get("project")
            if not isinstance(src, dict) or not _valid_project(src):
                raise ProjectError("Projet à rétablir invalide")
            if any(x["id"] == src["id"] for x in doc["projects"]):
                raise ProjectError("Ce projet existe déjà", 409, "exists")
            doc["projects"].append(src)
            out["project"] = src
        else:
            p = _project(doc, data.get("id"))
            if action != "project.resume":  # the resume note is one field typed in place: the last words written win
                _need_rev(p, data.get("rev"))
            if action == "project.resume":
                p["resume"] = _text(data.get("text"), "Note", RESUME_MAX)
                p["resume_at"] = now if p["resume"] else None
            elif action == "project.update":
                _apply_fields(p, data)
            elif action == "project.delete":
                doc["projects"] = [x for x in doc["projects"] if x["id"] != p["id"]]
                out["deleted"] = p
            elif action.endswith(".add"):
                kind = action.split(".")[0]
                key, cap = _SUBS[kind]
                if len(p[key]) >= cap:
                    raise ProjectError(f"Limite atteinte ({cap})", 507, "quota")
                rec = {"milestone": _milestone_from, "bom": _bom_from}.get(kind)
                rec = rec(data.get(kind) or {}) if rec else (_link_from(data.get("link") or {}) if kind == "link" else _entry_from(data.get("entry") or {}, now))
                if kind == "link" and any(x["kind"] == rec["kind"] and x["ref"] == rec["ref"] for x in p["links"]):
                    raise ProjectError("Déjà lié à ce projet", 409, "exists")
                p[key].append(rec)
                if kind == "entry":
                    p[key].sort(key=lambda e: e["at"])
                out[kind] = rec
            elif action.endswith(".update"):
                kind = action.split(".")[0]
                if kind not in ("milestone", "bom"):
                    raise ProjectError("Action inconnue")
                key = _SUBS[kind][0]
                cur = _sub(p, key, data.get("sub"))
                new = (_milestone_from if kind == "milestone" else _bom_from)(data.get(kind) or {}, cur)
                p[key][p[key].index(cur)] = new
                out[kind] = new
            elif action.endswith(".delete"):
                kind = action.split(".")[0]
                if kind not in _SUBS:
                    raise ProjectError("Action inconnue")
                key = _SUBS[kind][0]
                cur = _sub(p, key, data.get("sub"))
                p[key].remove(cur)
                out["removed"] = cur
            elif action.endswith(".move"):
                kind = action.split(".")[0]
                if kind not in ("milestone", "bom", "link"):
                    raise ProjectError("Action inconnue")
                key = _SUBS[kind][0]
                cur = _sub(p, key, data.get("sub"))
                to = _int(data.get("index"), "Position", 0, len(p[key]) - 1)
                p[key].remove(cur)
                p[key].insert(to, cur)
            elif action == "bom.use":
                line = _sub(p, "bom", data.get("sub"))
                if line["used"]:
                    raise ProjectError("Déjà retiré du stock", 409, "already_used")
                if not line["item"]:
                    raise ProjectError("Cette pièce n'est liée à aucun objet de l'inventaire")
                adjust = _cb.get("inventory_adjust")
                if not callable(adjust):
                    raise ProjectError("Inventaire indisponible", 503, "storage_error")
                out["inventory_item"] = adjust(line["item"], -line["qty"])  # raises if the item is gone; nothing below runs then
                line["used"] = True
                line["status"] = "have"
                out["bom"] = line
            else:
                raise ProjectError("Action inconnue")
            if action != "project.delete":
                p["updated_at"] = now
                p["rev"] += 1
                out["project"] = p
        doc["rev"] += 1
        _save(path, doc)
        out["ok"] = True
        out["rev"] = doc["rev"]
        return out


def _task_action(action: str, data: dict) -> dict:
    with _lock:
        projects = {p["id"] for p in _load(confined_path(_root()))["projects"]}
        path = kanban_path()
        with hq_state.path_lock(path):
            board = _load_board(path)
            now = _now()
            out: dict[str, Any] = {}

            def project_of(v: Any) -> str | None:
                if v in (None, ""):
                    return None
                if v not in projects:
                    raise ProjectError("Projet introuvable", 404, "not_found")
                return v

            def fields(card: dict, d: dict) -> None:
                if "title" in d:
                    card["title"] = _line(d["title"], "Titre", NAME_MAX, required=True)
                if "project" in d:
                    v = project_of(d["project"])
                    if v is None:
                        card.pop("project", None)
                        card.pop("milestone", None)
                    else:
                        card["project"] = v
                if "milestone" in d:
                    v = d["milestone"]
                    if v in (None, ""):
                        card.pop("milestone", None)
                    elif isinstance(v, str) and SUB_RE["milestone"].match(v) and card.get("project"):
                        card["milestone"] = v
                    else:
                        raise ProjectError("Jalon invalide")
                if "note" in d:
                    v = _text(d["note"], "Note", NOTE_MAX)
                    if v:
                        card["note"] = v
                    else:
                        card.pop("note", None)
                if "due" in d:
                    v = _date(d["due"], "Échéance")
                    if v:
                        card["due"] = v
                    else:
                        card.pop("due", None)
                card["updated"] = now

            if action == "task.create":
                if sum(len(c.get("cards") or []) for c in board["columns"]) >= CARDS_MAX:
                    raise ProjectError("Trop de tâches", 507, "quota")
                col = _col(board, _choice(data.get("column"), "Colonne", COLUMNS, "todo"))
                card = {"id": "c-" + str(int(now * 1000)) + "-" + secrets.token_hex(2), "title": "", "created": now}
                fields(card, {k: v for k, v in data.items() if k in ("title", "project", "milestone", "note", "due")})
                if not card["title"]:
                    raise ProjectError("Titre requis")
                col["cards"].insert(0, card)
                out["task"] = _card_view(card, col["id"])
            elif action == "task.restore":
                src = data.get("task")
                if not isinstance(src, dict) or not isinstance(src.get("id"), str) or not CARD_RE.match(src["id"]):
                    raise ProjectError("Tâche à rétablir invalide")
                if _find_card(board, src["id"]):
                    raise ProjectError("Cette tâche existe déjà", 409, "exists")
                col = _col(board, _choice(src.get("column"), "Colonne", COLUMNS, "todo"))
                card = {"id": src["id"], "title": "", "created": src["created"] if _is_num(src.get("created")) else now}
                d = {k: v for k, v in src.items() if k in ("title", "note", "due", "project", "milestone")}
                if d.get("project") not in projects:
                    d.pop("project", None)
                    d.pop("milestone", None)
                fields(card, d)
                idx = data.get("index")
                col["cards"].insert(idx if _is_int(idx) and 0 <= idx <= len(col["cards"]) else 0, card)
                out["task"] = _card_view(card, col["id"])
            else:
                found = _find_card(board, data.get("id"))
                if found is None:
                    raise ProjectError("Tâche introuvable", 404, "not_found")
                col, k, card = found
                if action == "task.update":
                    fields(card, data)
                    out["task"] = _card_view(card, col["id"])
                elif action == "task.move":
                    dest = _col(board, _choice(data.get("column"), "Colonne", COLUMNS, col["id"]))
                    col["cards"].pop(k)
                    idx = data.get("index")
                    dest["cards"].insert(idx if _is_int(idx) and 0 <= idx <= len(dest["cards"]) else 0, card)
                    card["updated"] = now
                    out["task"] = _card_view(card, dest["id"])
                elif action == "task.delete":
                    col["cards"].pop(k)
                    out["deleted"] = dict(_card_view(card, col["id"]), index=k)
                else:
                    raise ProjectError("Action inconnue")
            _save_board(path, board)
            out["ok"] = True
            out["tasks"] = tasks(board)
            return out


def apply(data: dict) -> dict:
    if not isinstance(data, dict):
        raise ProjectError("Requête invalide")
    action = data.get("action")
    if not isinstance(action, str):
        raise ProjectError("Action inconnue")
    if action.startswith("task."):
        return _task_action(action, data)
    return _project_action(action, data)


# ---------------------------------------------------------------- reads

def progress(p: dict, cards: list[dict]) -> dict:
    """Done/total over the project's tasks and milestones together."""
    mine = [c for c in cards if c.get("project") == p["id"]]
    total = len(mine) + len(p["milestones"])
    done = sum(1 for c in mine if c["column"] == "done") + sum(1 for m in p["milestones"] if m["done"])
    return {"done": done, "total": total, "pct": round(100 * done / total) if total else 0}


def summary() -> dict:
    doc = snapshot()
    return {"active": sum(1 for p in doc["projects"] if p["status"] == "active"), "projects": len(doc["projects"])}


def http_get(qs: dict) -> tuple[int, dict]:
    try:
        doc = snapshot()
        out: dict[str, Any] = {"ok": True, "rev": doc["rev"], "projects": doc["projects"]}
        try:
            with hq_state.path_lock(kanban_path()):
                out["tasks"] = tasks(_load_board(kanban_path()))
        except ProjectError as e:
            out["tasks"] = []
            out["tasks_error"] = str(e)
        return 200, out
    except ProjectError as e:
        return e.status, {"error": str(e), "code": e.code, **e.extra}


def http_post(data: dict) -> tuple[int, dict]:
    try:
        return 200, apply(data)
    except ProjectError as e:
        return e.status, {"error": str(e), "code": e.code, **e.extra}
    except ValueError as e:  # the inventory refused the stock change (item gone, ...)
        status = getattr(e, "status", 400)
        return status, {"error": str(e), "code": getattr(e, "code", "inventory_error")}
