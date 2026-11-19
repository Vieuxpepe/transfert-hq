"""Transfert HQ — « Dessiner » sketch storage (stdlib only).

Saved drawings live in ROOT/Inbox/Drawings (same resolution as Inbox/Voice,
Inbox/Photos, …). The client never supplies a filesystem path: it sends a base
name, a coarse source hint, the vector document and a PNG preview. The server
sanitizes the name, validates and normalizes the document, renders the DXF and
optional 3D STL itself, and publishes <stem>.hqdraw.json / <stem>.png / <stem>.dxf
(and .stl for a solid) without ever
overwriting an existing file (unique stem on collision).

Filesystem rules:
  * Inbox/Drawings must not be a symlink, junction or other reparse point and
    must resolve inside the resolved Inbox folder.
  * Listed/opened files must be regular files (lstat), never links/reparse.
  * Writes go to a hidden temp file in the same directory (O_EXCL, fsync) and
    are published with os.link (fails if the target exists) — atomic and
    never clobbering.

Document format (version 6; versions 1 to 5 remain readable):
  stable object ids, explicit point table (lines/circles reference point ids,
  so connectivity is explicit), units, grid, driving constraints, 3D features.
  Version 4 adds an optional stroke width: ``w`` in model units and ``k``, a
  per-point factor of the same length. DXF keeps a plain polyline (no width).
  Version 5 adds 3D features built on the Boolean kernel (hq_solid_ops): a ``revolve`` base, and after the base
  ``hole``, ``shell`` and ``pattern`` steps. A drawing with only an extrusion and cuts keeps building as before.
  Version 6 is built as an exact solid (hq_solid_occ, OpenCascade): sketches on planes (``sketches``, and ``sketch``
  on points and objects), arcs, geometric constraints (horizontal, vertical, parallel, perpendicular, equal, tangent,
  radius, fixed), features that add or cut (``op``), ``fillet`` / ``chamfer`` on picked edges, ``sweep``, ``loft``,
  ``suppressed`` features and a ``rollback`` point. STEP export and mass properties come with it.
"""

from __future__ import annotations

import base64
import json
import math
import os
import re
import secrets
import base64
import stat
import struct
import threading
import time
import unicodedata
from pathlib import Path

import hq_params
import hq_solid
import hq_solid_occ  # noqa: F401  (loads OpenCascade on the main thread at startup, when installed)
import hq_solid_ops

FORMAT = "transfert-hq-sketch"
VERSION = 6
SUPPORTED_VERSIONS = (1, 2, 3, 4, 5, 6)
SKETCH_PLANES = ("XY", "XZ", "YZ")
MAX_SKETCHES = 20
SUBDIR = ("Inbox", "Drawings")
DOC_SUFFIX = ".hqdraw.json"
PNG_SUFFIX = ".png"
DXF_SUFFIX = ".dxf"
STL_SUFFIX = ".stl"
PDF_SUFFIX = ".pdf"
DRAFT_KEEP = 5                      # per stem: the latest draft plus up to four earlier snapshots
DRAFT_TTL_DAYS = 14                 # older snapshots are pruned when the library is listed
DRAFTS_DIR = ".drafts"                # scratch copies live in a hidden sub-folder: never listed, never part of a lineage
DRAFT_SUFFIX = ".hqdraw.draft.json"

MAX_BODY = 6 * 1024 * 1024          # whole POST body
MAX_DOC_BYTES = 2 * 1024 * 1024     # normalized JSON document
MAX_PNG_BYTES = 4 * 1024 * 1024     # decoded PNG
MAX_PNG_SIDE = 4096
MAX_POINTS = 20000
MAX_OBJECTS = 5000
MAX_CONSTRAINTS = 2000
MAX_STROKE_PTS = 4000
MAX_TOTAL_STROKE_PTS = 100000
MAX_TEXT = 500
MAX_COORD = 1e6
MAX_NAME = 60
LIST_MAX = 200

UNITS = {"mm": 4, "cm": 5, "m": 6, "in": 1}   # DXF $INSUNITS codes
SOURCES = {"mobile": "_HQWeb-Mobile", "desktop": "_HQWeb-Desktop"}
DEFAULT_SOURCE_SUFFIX = "_HQWeb"
MODES = {"quick", "construction"}
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
STEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$")
COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")  # annotation ink on a stroke (optional; the theme ink is used when absent)
PARAM_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,30}")  # a named value driving dimensions
DRIVABLE = ("depth", "thickness", "radius", "distance", "angle", "dx", "dy", "cx", "cy")  # feature fields an expression may drive
PARAM_RESERVED = {"__proto__", "constructor", "prototype"}
_CTRL_RE = re.compile(r"[\x00-\x1f\x7f]")  # control characters never reach a saved name or expression
WIN_RESERVED = {"con", "prn", "aux", "nul"} | {f"com{i}" for i in range(1, 10)} | {f"lpt{i}" for i in range(1, 10)}
FILE_ATTRIBUTE_REPARSE_POINT = 0x400
PNG_SIG = b"\x89PNG\r\n\x1a\n"
UNDERLAY_ASSET_RE = re.compile(r"^asset-[0-9a-f]{24}\Z")  # a Carnet Stage-06 asset id (the SAME shape Carnet validates)
UNDERLAY_FITS = ("contain",)
# Underlay placement contract (permanent for this key): the image is scaled UNIFORMLY (aspect ratio taken from the image itself)
# to fit inside the square of side UNDERLAY_BOX_MM millimetres centred on the document origin (0, 0), expressed in the
# document's own units. There is no x / y / scale / rotation / crop: the key is only an asset id + the word "contain".
UNDERLAY_BOX_MM = 1000.0
UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}


def underlay_rect(units: str, w: int, h: int) -> dict:
    """The document-space rectangle of an underlay image of ``w`` x ``h`` pixels (the shared contract; hq-sketch-core.js mirrors it)."""
    if units not in UNIT_MM or any(type(v) is not int or v < 1 for v in (w, h)):
        raise DrawingError("Fond de dessin invalide")
    box = UNDERLAY_BOX_MM / UNIT_MM[units]
    k = box / max(w, h)
    half_w, half_h = w * k / 2, h * k / 2
    return {"x0": -half_w, "y0": -half_h, "x1": half_w, "y1": half_h}

LAYERS = {
    # name: (ACI color, linetype)
    "GEOMETRIE": (7, "CONTINUOUS"),
    "AXES": (1, "CENTER"),
    "REFERENCE_MAIN_LEVEE": (8, "CONTINUOUS"),
    "NOTES": (3, "CONTINUOUS"),
    "COTATIONS": (5, "CONTINUOUS"),
}

_SAVE_LOCK = threading.Lock()


class DrawingError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- paths

def _is_link_or_reparse(st: os.stat_result) -> bool:
    if stat.S_ISLNK(st.st_mode):
        return True
    attrs = getattr(st, "st_file_attributes", 0) or 0
    return bool(attrs & FILE_ATTRIBUTE_REPARSE_POINT)


def drawings_dir(root: Path, *, create: bool = False) -> Path | None:
    """ROOT/Inbox/Drawings, refusing links/junctions. None if absent and not create."""
    inbox = Path(root) / SUBDIR[0]
    if not inbox.is_dir():
        if not create:
            return None
        inbox.mkdir(parents=True, exist_ok=True)
    inbox_real = inbox.resolve()
    target = inbox / SUBDIR[1]
    try:
        st = os.lstat(target)
    except FileNotFoundError:
        if not create:
            return None
        try:
            os.mkdir(target)
        except FileExistsError:
            pass
        st = os.lstat(target)
    if _is_link_or_reparse(st):
        raise DrawingError("Inbox/Drawings est un lien ou une jonction : refusé", 400)
    if not stat.S_ISDIR(st.st_mode):
        raise DrawingError("Inbox/Drawings n'est pas un dossier", 400)
    real = target.resolve()
    try:
        real.relative_to(inbox_real)
    except ValueError:
        raise DrawingError("Inbox/Drawings sort de l'Inbox : refusé", 400)
    return real


def rel_for(name: str) -> str:
    return "/".join(SUBDIR + (name,))


# ---------------------------------------------------------------- names

def sanitize_base_name(raw) -> str:
    """User base name -> safe ASCII stem fragment. Never a path."""
    text = str(raw or "")
    text = text.replace("\\", "/").split("/")[-1]
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"\.(hqdraw\.json|json|png|dxf)$", "", text, flags=re.I)
    text = re.sub(r"[^A-Za-z0-9_-]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-_.")
    text = text[:MAX_NAME].strip("-_")
    if not text:
        text = "croquis"
    if text.lower() in WIN_RESERVED or text.split("_")[0].lower() in WIN_RESERVED:
        text = "dessin-" + text
    return text


def source_suffix(source) -> str:
    return SOURCES.get(str(source or "").strip().lower(), DEFAULT_SOURCE_SUFFIX)


def valid_stem(stem) -> str:
    stem = str(stem or "")
    if not STEM_RE.match(stem):
        raise DrawingError("Nom de dessin invalide", 400)
    return stem


# ---------------------------------------------------------------- validation

def _num(v, what: str, *, lo: float = -MAX_COORD, hi: float = MAX_COORD) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise DrawingError(f"{what} : nombre attendu")
    f = float(v)
    if not math.isfinite(f) or f < lo or f > hi:
        raise DrawingError(f"{what} : hors limites")
    return round(f, 6)


def _id(v, what: str) -> str:
    if not isinstance(v, str) or not ID_RE.match(v):
        raise DrawingError(f"{what} : identifiant invalide")
    return v


def _text(v, what: str, *, max_len: int = MAX_TEXT, allow_empty: bool = True) -> str:
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise DrawingError(f"{what} : texte attendu")
    v = "".join(" " if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") else c for c in v).strip()
    if len(v) > max_len:
        raise DrawingError(f"{what} : trop long")
    if not v and not allow_empty:
        raise DrawingError(f"{what} : vide")
    return v


def _xy(v, what: str) -> list[float]:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        raise DrawingError(f"{what} : point [x, y] attendu")
    return [_num(v[0], what), _num(v[1], what)]


GEOMETRIC_CONSTRAINTS = ("horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "radius", "fixed",
                        "concentric", "symmetric", "midpoint", "collinear", "point_on_curve")


def _edge_ref(e, fid) -> dict:
    """A picked edge, found again on the rebuilt part by its two ends and its middle."""
    if not isinstance(e, dict):
        raise DrawingError(f"{fid} : arête invalide")
    out = {}
    for key in ("a", "b", "m"):
        v = e.get(key)
        if not isinstance(v, list) or len(v) != 3:
            raise DrawingError(f"{fid} : arête invalide")
        out[key] = [_num(x, f"{fid} arête") for x in v]
    return out


def _geometric_constraint(k, kid, kind, line_ends, arc_ids, kinds, point_ids) -> dict:
    lines = {i for i, t in kinds.items() if t in ("line", "centerline")}
    rounds = {i for i, t in kinds.items() if t in ("circle", "arc")}
    if kind in ("horizontal", "vertical"):
        line = _id(k.get("line"), kid)
        if line not in lines:
            raise DrawingError(f"{kid} : ligne inconnue")
        return {"id": kid, "type": kind, "line": line}
    if kind == "fixed":
        point = _id(k.get("point"), kid)
        if point not in point_ids:
            raise DrawingError(f"{kid} : point inconnu")
        return {"id": kid, "type": kind, "point": point}
    if kind == "radius":
        item = _id(k.get("item"), kid)
        if item not in rounds:
            raise DrawingError(f"{kid} : cercle ou arc attendu")
        return {"id": kid, "type": kind, "item": item, "value": _num(k.get("value"), f"{kid} rayon", lo=1e-9)}
    if kind == "midpoint":
        point, line = _id(k.get("point"), kid), _id(k.get("line"), kid)
        if point not in point_ids or line not in lines:
            raise DrawingError(f"{kid} : un point et une ligne attendus")
        return {"id": kid, "type": kind, "point": point, "line": line}
    if kind == "symmetric":
        pts = k.get("points")
        if not isinstance(pts, list) or len(pts) != 2:
            raise DrawingError(f"{kid} : deux points attendus")
        pa, pb = _id(pts[0], kid), _id(pts[1], kid)
        line = _id(k.get("line"), kid)
        if pa == pb or pa not in point_ids or pb not in point_ids or line not in lines:
            raise DrawingError(f"{kid} : deux points et une ligne d'axe attendus")
        return {"id": kid, "type": kind, "points": [pa, pb], "line": line}
    if kind == "point_on_curve":
        point, item = _id(k.get("point"), kid), _id(k.get("item"), kid)
        if point not in point_ids or kinds.get(item) not in ("line", "centerline", "circle", "arc", "ellipse"):
            raise DrawingError(f"{kid} : point ou courbe inconnue")
        return {"id": kid, "type": kind, "point": point, "item": item}
    items = k.get("items")
    if not isinstance(items, list) or len(items) != 2:
        raise DrawingError(f"{kid} : deux éléments attendus")
    a, b = _id(items[0], kid), _id(items[1], kid)
    if a == b:
        raise DrawingError(f"{kid} : deux éléments distincts attendus")
    if kind in ("parallel", "perpendicular", "collinear") and not ({a, b} <= lines):
        raise DrawingError(f"{kid} : deux lignes attendues")
    if kind == "concentric" and not ({a, b} <= rounds):
        raise DrawingError(f"{kid} : deux cercles ou arcs attendus")
    if kind == "equal" and not ({a, b} <= lines or {a, b} <= rounds):
        raise DrawingError(f"{kid} : deux lignes ou deux cercles/arcs attendus")
    if kind == "tangent" and not ((a in lines and b in rounds) or (a in rounds and b in lines) or {a, b} <= rounds):
        raise DrawingError(f"{kid} : une ligne et un cercle/arc, ou deux cercles/arcs")
    return {"id": kid, "type": kind, "items": [a, b]}


def check_underlay(value, version=VERSION) -> dict:
    """Optional fixed underlay: ``{"asset_id": "asset-<24 hex>", "fit": "contain"}`` and nothing else (version 3 and later)."""
    if version < 3 or not isinstance(value, dict) or set(value) != {"asset_id", "fit"}:
        raise DrawingError("Fond de dessin invalide")
    if not isinstance(value["asset_id"], str) or not UNDERLAY_ASSET_RE.match(value["asset_id"]) or value["fit"] not in UNDERLAY_FITS:
        raise DrawingError("Fond de dessin invalide")
    return {"asset_id": value["asset_id"], "fit": value["fit"]}


def validate_document(doc, *, build: bool = True) -> dict:
    """Validate + normalize a client document. Returns a clean copy (known keys only).

    `build=False` keeps every structural and field check (names, driven expressions, profiles) but skips the exact
    mesh: the shared-drawing hub validates what it publishes without paying for a rebuild on each edit."""
    if not isinstance(doc, dict):
        raise DrawingError("Document invalide")
    if doc.get("format") != FORMAT:
        raise DrawingError("Format de dessin inconnu")
    if doc.get("version") not in SUPPORTED_VERSIONS:
        raise DrawingError("Version de dessin non prise en charge")
    units = doc.get("units")
    if units not in UNITS:
        raise DrawingError("Unités invalides")
    if doc["version"] >= 6:  # same expressions the editor evaluates, now enforced on the server
        try:
            doc = hq_params.resolve(doc)
        except hq_params.ParamError as e:
            raise DrawingError(str(e)) from e
    grid = doc.get("grid") or {}
    snap = doc.get("snap") or {}
    if not isinstance(grid, dict) or not isinstance(snap, dict):
        raise DrawingError("Grille invalide")
    out: dict = {
        "format": FORMAT,
        "version": doc["version"],
        "units": units,
        "mode": doc.get("mode") if doc.get("mode") in MODES else "quick",
        "grid": {
            "spacing": _num(grid.get("spacing", 10), "grille", lo=1e-6, hi=1e5),
            "visible": bool(grid.get("visible", True)),
            "snap": bool(grid.get("snap", True)),
        },
        "snap": {
            "angle": bool(snap.get("angle", True)),
            "angleStep": _num(snap.get("angleStep", 15), "pas d'angle", lo=0.5, hi=90),
        },
    }
    view = doc.get("view")
    if isinstance(view, dict):
        out["view"] = {
            "x0": _num(view.get("x0", 0), "vue"),
            "y0": _num(view.get("y0", 0), "vue"),
            "ppu": _num(view.get("ppu", 4), "zoom", lo=1e-6, hi=1e6),
        }
    if doc.get("underlay") is not None:
        out["underlay"] = check_underlay(doc["underlay"], doc["version"])
    if "nextId" in doc:
        out["nextId"] = int(_num(doc.get("nextId"), "nextId", lo=0, hi=1e9))

    ids: set[str] = set()

    def claim(i: str) -> str:
        if i in ids:
            raise DrawingError(f"Identifiant en double : {i}")
        ids.add(i)
        return i

    v6 = doc["version"] >= 6
    raw_sketches = doc.get("sketches", [])
    if not isinstance(raw_sketches, list) or len(raw_sketches) > MAX_SKETCHES or (raw_sketches and not v6):
        raise DrawingError("Esquisses invalides")
    sketches = []
    for i, sk in enumerate(raw_sketches):
        if not isinstance(sk, dict) or sk.get("plane") not in SKETCH_PLANES:
            raise DrawingError(f"Esquisse {i} invalide")
        entry = {"id": claim(_id(sk.get("id"), f"esquisse {i}")), "name": _text(sk.get("name", ""), f"esquisse {i} nom")[:40],
                 "plane": sk["plane"], "offset": _num(sk.get("offset", 0), f"esquisse {i} décalage")}
        if sk.get("face") is not None:
            if sk["face"] not in (1, -1) or isinstance(sk["face"], bool):
                raise DrawingError(f"Esquisse {i} : face invalide")
            entry["face"] = sk["face"]  # a sketch on a part's face: which way is outward along its normal
        if sk.get("locked") is True:
            entry["locked"] = True  # locked sketch: the editor refuses to draw in it
        if sk.get("hidden") is True:
            entry["hidden"] = True  # hidden sketch: drawn nowhere in the 2D editor
        sketches.append(entry)
    if v6:
        out["sketches"] = sketches
    sketch_ids = {sk["id"] for sk in sketches}

    raw_params = doc.get("params") or []
    if not isinstance(raw_params, list) or len(raw_params) > 40 or (raw_params and not v6):
        raise DrawingError("Paramètres invalides")
    params = []
    param_names: set[str] = set()
    for i, p in enumerate(raw_params):
        if not isinstance(p, dict):
            raise DrawingError(f"Paramètre {i} invalide")
        name = p.get("name")
        if not isinstance(name, str) or not PARAM_RE.fullmatch(name) or name in PARAM_RESERVED:
            raise DrawingError(f"Paramètre {i} : nom invalide")
        if name in param_names:
            raise DrawingError(f"Paramètre en double : {name}")
        param_names.add(name)
        expr = p.get("expr")
        if not isinstance(expr, str) or not expr.strip() or len(expr) > 120 or _CTRL_RE.search(expr):
            raise DrawingError(f"Paramètre {name} : expression invalide")
        params.append({"id": claim(_id(p.get("id"), f"paramètre {i}")), "name": name, "expr": expr.strip()})
    if v6 and params:
        out["params"] = params

    raw_assumptions = doc.get("assumptions") or []
    if not isinstance(raw_assumptions, list) or len(raw_assumptions) > 20 or (raw_assumptions and not v6):
        raise DrawingError("Hypothèses invalides")
    assumptions = []
    for i, item in enumerate(raw_assumptions):
        if not isinstance(item, dict):
            raise DrawingError(f"Hypothèse {i} invalide")
        aid = claim(_id(item.get("id"), f"hypothèse {i}"))
        assumptions.append({
            "id": aid,
            "name": _text(item.get("name"), f"{aid} nom", max_len=40, allow_empty=False),
            "value": _text(item.get("value"), f"{aid} valeur", max_len=200, allow_empty=False),
            "reason": _text(item.get("reason"), f"{aid} raison", max_len=200),
        })
    if v6:
        out["assumptions"] = assumptions

    def sketch_of(item, raw, label):
        sid = raw.get("sketch")
        if sid is None:
            return ""
        if not v6 or sid not in sketch_ids:
            raise DrawingError(f"{label} : esquisse inconnue")
        item["sketch"] = sid
        return sid

    raw_points = doc.get("points") or []
    if not isinstance(raw_points, list) or len(raw_points) > MAX_POINTS:
        raise DrawingError("Points invalides ou trop nombreux", 413 if isinstance(raw_points, list) else 400)
    points = []
    point_ids: set[str] = set()
    point_sketch: dict[str, str] = {}
    for i, p in enumerate(raw_points):
        if not isinstance(p, dict):
            raise DrawingError(f"Point {i} invalide")
        pid = claim(_id(p.get("id"), f"point {i}"))
        point_ids.add(pid)
        item = {"id": pid, "x": _num(p.get("x"), f"point {pid}"), "y": _num(p.get("y"), f"point {pid}")}
        point_sketch[pid] = sketch_of(item, p, pid)
        points.append(item)
    out["points"] = points
    point_xy = {p["id"]: (p["x"], p["y"]) for p in points}

    raw_objects = doc.get("objects") or []
    if not isinstance(raw_objects, list):
        raise DrawingError("Objets invalides")
    if len(raw_objects) > MAX_OBJECTS:
        raise DrawingError("Trop d'objets", 413)
    objects = []
    arc_ids: set[str] = set()
    line_ends: dict[str, tuple[str, str]] = {}
    total_stroke = 0
    for i, o in enumerate(raw_objects):
        if not isinstance(o, dict):
            raise DrawingError(f"Objet {i} invalide")
        oid = claim(_id(o.get("id"), f"objet {i}"))
        kind = o.get("type")
        item: dict = {"id": oid, "type": kind}
        osk = sketch_of(item, o, oid)

        def same_sketch(*pids):
            if any(point_sketch.get(pid, "") != osk for pid in pids):
                raise DrawingError(f"{oid} : points d'une autre esquisse")

        if kind == "arc":
            if not v6:
                raise DrawingError(f"{oid} : les arcs exigent la version 6")
            c, p1, p2 = _id(o.get("center"), oid), _id(o.get("p1"), oid), _id(o.get("p2"), oid)
            if not {c, p1, p2} <= point_ids or len({c, p1, p2}) != 3:
                raise DrawingError(f"{oid} : arc invalide")
            same_sketch(c, p1, p2)
            r1, r2 = math.dist(point_xy[c], point_xy[p1]), math.dist(point_xy[c], point_xy[p2])
            if r1 <= 1e-9 or abs(r1 - r2) > 1e-6 * max(1.0, r1):
                raise DrawingError(f"{oid} : les extrémités de l'arc doivent être à la même distance du centre")
            item.update(center=c, p1=p1, p2=p2)
            line_ends[oid] = (p1, p2)
            arc_ids.add(oid)
            objects.append(item)
            continue
        if kind in ("line", "centerline", "circle"):
            same_sketch(*[x for x in (o.get("p1"), o.get("p2"), o.get("center")) if isinstance(x, str) and x in point_ids])
        if kind in ("line", "centerline"):
            p1, p2 = _id(o.get("p1"), oid), _id(o.get("p2"), oid)
            if p1 not in point_ids or p2 not in point_ids or p1 == p2:
                raise DrawingError(f"{oid} : extrémités invalides")
            item.update(p1=p1, p2=p2)
            line_ends[oid] = (p1, p2)
        elif kind == "circle":
            c = _id(o.get("center"), oid)
            if c not in point_ids:
                raise DrawingError(f"{oid} : centre invalide")
            item.update(center=c, r=_num(o.get("r"), f"{oid} rayon", lo=1e-9))
        elif kind == "ellipse":
            if not v6:
                raise DrawingError(f"{oid} : les ellipses exigent la version 6")
            c = _id(o.get("center"), oid)
            if c not in point_ids:
                raise DrawingError(f"{oid} : centre d'ellipse invalide")
            same_sketch(c)
            item.update(center=c, rx=_num(o.get("rx"), f"{oid} rayon x", lo=1e-9), ry=_num(o.get("ry"), f"{oid} rayon y", lo=1e-9))
        elif kind == "spline":
            if not v6:
                raise DrawingError(f"{oid} : les splines exigent la version 6")
            pts = o.get("pts")
            if not isinstance(pts, list) or not 2 <= len(pts) <= 500:
                raise DrawingError(f"{oid} : spline invalide")
            pts = [_id(p, oid) for p in pts]
            if len(set(pts)) != len(pts) or any(p not in point_ids for p in pts):
                raise DrawingError(f"{oid} : points de spline invalides")
            same_sketch(*pts)
            item["pts"] = pts
            closed = o.get("closed")
            if closed is not None and not isinstance(closed, bool):
                raise DrawingError(f"{oid} : spline invalide")
            if closed is True:
                if len(pts) < 3:
                    raise DrawingError(f"{oid} : une spline fermée demande au moins trois points")
                item["closed"] = True
        elif kind == "stroke":
            pts = o.get("pts")
            if not isinstance(pts, list) or len(pts) < 1:
                raise DrawingError(f"{oid} : tracé vide")
            if len(pts) > MAX_STROKE_PTS:
                raise DrawingError(f"{oid} : tracé trop long", 413)
            total_stroke += len(pts)
            if total_stroke > MAX_TOTAL_STROKE_PTS:
                raise DrawingError("Tracés main levée trop volumineux", 413)
            item["pts"] = [_xy(p, oid) for p in pts]
            has_w = o.get("w") is not None
            has_k = o.get("k") is not None
            if has_w or has_k:
                if doc["version"] < 4:
                    raise DrawingError(f"{oid} : épaisseur non prise en charge")
                if not has_w:
                    raise DrawingError(f"{oid} : épaisseur invalide")
                item["w"] = _num(o.get("w"), f"{oid} épaisseur", lo=1e-9, hi=MAX_COORD)
                if has_k:
                    ks = o.get("k")
                    if not isinstance(ks, list) or len(ks) != len(item["pts"]):
                        raise DrawingError(f"{oid} : épaisseur invalide")
                    item["k"] = [_num(v, f"{oid} facteur", lo=0.05, hi=4) for v in ks]
            color = o.get("color")
            if color is not None:
                if not isinstance(color, str) or not COLOR_RE.fullmatch(color):
                    raise DrawingError(f"{oid} : couleur invalide")
                item["color"] = color.lower()
        elif kind == "text":
            item.update(
                x=_num(o.get("x"), oid),
                y=_num(o.get("y"), oid),
                text=_text(o.get("text"), f"{oid} texte", allow_empty=False),
                h=_num(o.get("h", 5), f"{oid} hauteur", lo=1e-6, hi=1e5),
            )
        elif kind == "dim_linear":
            item.update(
                a=_xy(o.get("a"), oid),
                b=_xy(o.get("b"), oid),
                offset=_num(o.get("offset", 0), f"{oid} décalage"),
                label=_text(o.get("label"), f"{oid} libellé"),
            )
        elif kind == "dim_angle":
            item.update(
                c=_xy(o.get("c"), oid),
                a=_xy(o.get("a"), oid),
                b=_xy(o.get("b"), oid),
                r=_num(o.get("r", 10), f"{oid} rayon", lo=1e-9),
                label=_text(o.get("label"), f"{oid} libellé"),
            )
        else:
            raise DrawingError(f"{oid} : type d'objet inconnu")
        if o.get("drive") is not None:
            drv = o["drive"]
            if kind not in ("dim_linear", "dim_angle"):
                raise DrawingError(f"{oid} : seules les cotes pilotent la géométrie")
            if not v6:
                raise DrawingError(f"{oid} : cote pilotée en version 6 requise")
            if not isinstance(drv, dict) or not isinstance(drv.get("expr"), str) or not drv["expr"].strip() or len(drv["expr"]) > 120:
                raise DrawingError(f"{oid} : cote pilotée invalide")
            entry: dict = {"expr": drv["expr"].strip()}
            if kind == "dim_linear":
                pts = drv.get("points")
                if not isinstance(pts, list) or len(pts) != 2:
                    raise DrawingError(f"{oid} : cote pilotée invalide")
                entry["points"] = [_id(pid, oid) for pid in pts]
            else:
                lines = drv.get("lines")
                if not isinstance(lines, list) or len(lines) != 2:
                    raise DrawingError(f"{oid} : cote pilotée invalide")
                entry["lines"] = [_id(lid, oid) for lid in lines]
                entry["vertex"] = _id(drv.get("vertex"), oid)
            if drv.get("keepLabel") is True:
                entry["keepLabel"] = True
            item["drive"] = entry
        group = o.get("group")
        if group is not None:
            item["group"] = _id(group, f"{oid} groupe")
        if o.get("construction") is True:
            item["construction"] = True
        objects.append(item)
    out["objects"] = objects

    object_kinds = {o["id"]: o["type"] for o in objects}
    for o in objects:
        drv = o.get("drive")
        if not drv:
            continue
        if o["type"] == "dim_linear":
            if any(pid not in point_ids for pid in drv["points"]) or drv["points"][0] == drv["points"][1]:
                raise DrawingError(f"{o['id']} : cote pilotée sur des points inconnus")
        else:
            if drv["vertex"] not in point_ids or any(object_kinds.get(lid) != "line" for lid in drv["lines"]):
                raise DrawingError(f"{o['id']} : cote pilotée sur des lignes inconnues")
    raw_cons = doc.get("constraints") or []
    if not isinstance(raw_cons, list):
        raise DrawingError("Contraintes invalides")
    if len(raw_cons) > MAX_CONSTRAINTS:
        raise DrawingError("Trop de contraintes", 413)
    cons = []
    for i, k in enumerate(raw_cons):
        if not isinstance(k, dict):
            raise DrawingError(f"Contrainte {i} invalide")
        kid = claim(_id(k.get("id"), f"contrainte {i}"))
        kind = k.get("type")
        if kind == "length":
            line = _id(k.get("line"), kid)
            if line not in line_ends:
                raise DrawingError(f"{kid} : ligne inconnue")
            fixed = _id(k.get("fixed"), kid)
            if fixed not in line_ends[line]:
                raise DrawingError(f"{kid} : extrémité fixe invalide")
            cons.append({"id": kid, "type": "length", "line": line, "fixed": fixed,
                         "value": _num(k.get("value"), f"{kid} longueur", lo=1e-9)})
        elif kind == "angle":
            lines = k.get("lines")
            if not isinstance(lines, list) or len(lines) != 2:
                raise DrawingError(f"{kid} : deux lignes attendues")
            l1, l2 = _id(lines[0], kid), _id(lines[1], kid)
            if l1 not in line_ends or l2 not in line_ends or l1 == l2:
                raise DrawingError(f"{kid} : lignes inconnues")
            vertex = _id(k.get("vertex"), kid)
            if vertex not in line_ends[l1] or vertex not in line_ends[l2]:
                raise DrawingError(f"{kid} : les lignes ne partagent pas ce sommet")
            cons.append({"id": kid, "type": "angle", "lines": [l1, l2], "vertex": vertex,
                         "value": _num(k.get("value"), f"{kid} angle", lo=0, hi=180)})
        elif kind in GEOMETRIC_CONSTRAINTS and v6:
            cons.append(_geometric_constraint(k, kid, kind, line_ends, arc_ids, object_kinds, point_ids))
        else:
            raise DrawingError(f"{kid} : type de contrainte inconnu")
    out["constraints"] = cons
    raw_features = doc.get("features", [])
    if not isinstance(raw_features, list) or len(raw_features) > hq_solid.MAX_FEATURES:
        raise DrawingError("Fonctions 3D invalides ou trop nombreuses")
    if doc["version"] == 1 and raw_features:
        raise DrawingError("Les fonctions 3D exigent la version 2")
    features = []
    object_types = {o["id"]: o["type"] for o in objects}
    objects_by_id = {o["id"]: o for o in objects}
    construction_ids = {o["id"] for o in objects if o.get("construction")}
    seen_features = []
    for i, f in enumerate(raw_features):
        if not isinstance(f, dict):
            raise DrawingError(f"Fonction 3D {i} invalide")
        fid = claim(_id(f.get("id"), f"fonction 3D {i}"))
        kind = f.get("type")
        if v6:
            allowed = ("extrude", "revolve", "sweep", "loft") if i == 0 else ("extrude", "revolve", "sweep", "loft", "cut", "hole", "shell", "pattern", "fillet", "chamfer")
        else:
            allowed = ("extrude", "revolve") if i == 0 else ("cut", "hole", "shell", "pattern")
        if kind not in allowed:
            raise DrawingError("Une pièce de base (extrusion, révolution, balayage, lissage), puis des fonctions, sont requises")
        if kind in hq_solid_ops.V5_TYPES and doc["version"] < 5:
            raise DrawingError(f"{fid} : cette fonction 3D exige la version 5")
        profile_kinds = ("line", "circle", "arc", "ellipse", "spline") if v6 else ("line", "circle")

        def profile_shape(profile):
            curves = [objects_by_id[v] for v in profile if objects_by_id[v]["type"] in ("ellipse", "spline")]
            if curves:
                if len(profile) != 1:
                    raise DrawingError(f"{fid} : une ellipse ou une spline fermée forme seule son contour")
                try:
                    hq_solid.curve_kind(curves[0])
                except hq_solid.SolidError as exc:
                    raise DrawingError(f"{fid} : {exc}") from exc
            return profile

        def profile_of(key="profile"):
            profile = f.get(key)
            if not isinstance(profile, list) or not 1 <= len(profile) <= 500:
                raise DrawingError(f"{fid} : profil invalide")
            profile = [_id(v, f"{fid} profil") for v in profile]
            if len(set(profile)) != len(profile) or any(object_types.get(v) not in profile_kinds for v in profile):
                raise DrawingError(f"{fid} : profil invalide")
            if any(v in construction_ids for v in profile):
                raise DrawingError(f"{fid} : la géométrie de construction ne forme pas un profil")
            return profile_shape(profile)

        if kind in ("extrude", "cut"):
            profile = profile_of()
            extent = f.get("extent", "blind")
            if extent not in ("blind", "throughAll") or (kind == "extrude" and extent != "blind"):
                raise DrawingError(f"{fid} : étendue invalide")
            depth = _num(f.get("depth", 0), f"{fid} profondeur", lo=0, hi=MAX_COORD)
            if (kind == "extrude" or extent == "blind") and depth <= 0:
                raise DrawingError(f"{fid} : profondeur positive requise")
            item = {"id": fid, "type": kind, "profile": profile, "depth": depth, "extent": extent}
        elif kind == "revolve":
            profile = profile_of()
            axis = _id(f.get("axis"), f"{fid} axe")
            if object_types.get(axis) not in ("line", "centerline") or axis in profile:
                raise DrawingError(f"{fid} : axe de révolution invalide")
            angle = _num(f.get("angle", 360), f"{fid} angle", lo=1, hi=360)
            item = {"id": fid, "type": kind, "profile": profile, "axis": axis, "angle": angle}
        elif kind == "hole":
            at = f.get("at")
            if not isinstance(at, list) or not 1 <= len(at) <= hq_solid_ops.MAX_COPIES:
                raise DrawingError(f"{fid} : trous invalides")
            at = [_id(v, f"{fid} trou") for v in at]
            if len(set(at)) != len(at) or any(object_types.get(v) != "circle" for v in at):
                raise DrawingError(f"{fid} : un trou se place au centre d'un cercle")
            standard, fit = f.get("standard"), f.get("fit")
            if standard not in hq_solid_ops.HOLES_MM or fit not in hq_solid_ops.FITS:
                raise DrawingError(f"{fid} : trou inconnu")
            extent = f.get("extent", "throughAll")
            if extent not in ("blind", "throughAll"):
                raise DrawingError(f"{fid} : étendue invalide")
            depth = _num(f.get("depth", 0), f"{fid} profondeur", lo=0, hi=MAX_COORD)
            if extent == "blind" and depth <= 0 and fit != "insert":
                raise DrawingError(f"{fid} : profondeur positive requise")
            item = {"id": fid, "type": kind, "at": at, "standard": standard, "fit": fit, "extent": extent, "depth": depth}
        elif kind == "shell":
            if any(x["type"] == "shell" for x in seen_features):
                raise DrawingError(f"{fid} : une seule coque par pièce")
            thickness = _num(f.get("thickness"), f"{fid} épaisseur", lo=0, hi=MAX_COORD)
            if thickness <= 0 or not isinstance(f.get("open", True), bool):
                raise DrawingError(f"{fid} : coque invalide")
            item = {"id": fid, "type": kind, "thickness": thickness, "open": f.get("open", True)}
        elif kind == "pattern":
            source = _id(f.get("source"), f"{fid} source")
            # an earlier cut or hole; in v6 also an earlier boss or cut feature (not the base, which is the part itself)
            repeatable = ("cut", "hole", "extrude", "revolve", "sweep", "loft") if v6 else ("cut", "hole")
            if not any(x["id"] == source and x["type"] in repeatable for x in seen_features[1:]):
                raise DrawingError(f"{fid} : la répétition reprend une fonction placée avant elle (pas la pièce de base)")
            mode = f.get("mode")
            count = f.get("count")
            if mode not in ("linear", "circular") or isinstance(count, bool) or not isinstance(count, int) or not 2 <= count <= hq_solid_ops.MAX_COPIES:
                raise DrawingError(f"{fid} : répétition invalide")
            item = {"id": fid, "type": kind, "source": source, "mode": mode, "count": count}
            if mode == "linear":
                item["dx"] = _num(f.get("dx", 0), f"{fid} pas X", lo=-MAX_COORD, hi=MAX_COORD)
                item["dy"] = _num(f.get("dy", 0), f"{fid} pas Y", lo=-MAX_COORD, hi=MAX_COORD)
                if abs(item["dx"]) + abs(item["dy"]) <= 0:
                    raise DrawingError(f"{fid} : pas de répétition nul")
            else:
                item["cx"] = _num(f.get("cx", 0), f"{fid} centre X", lo=-MAX_COORD, hi=MAX_COORD)
                item["cy"] = _num(f.get("cy", 0), f"{fid} centre Y", lo=-MAX_COORD, hi=MAX_COORD)
                item["angle"] = _num(f.get("angle", 360), f"{fid} angle", lo=1, hi=360)
        elif kind in ("fillet", "chamfer"):
            edges = f.get("edges")
            if not isinstance(edges, list) or not 1 <= len(edges) <= 100:
                raise DrawingError(f"{fid} : arêtes invalides")
            item = {"id": fid, "type": kind, "edges": [_edge_ref(e, fid) for e in edges]}
            key = "radius" if kind == "fillet" else "distance"
            item[key] = _num(f.get(key), f"{fid} {key}", lo=1e-9, hi=MAX_COORD)
        elif kind == "sweep":
            path = f.get("path")
            if not isinstance(path, list) or not 1 <= len(path) <= 500 or any(object_types.get(_id(v, fid)) not in ("line", "arc") for v in path):
                raise DrawingError(f"{fid} : chemin invalide")
            item = {"id": fid, "type": kind, "profile": profile_of(), "path": [str(v) for v in path]}
        elif kind == "loft":
            profiles = f.get("profiles")
            if not isinstance(profiles, list) or not 2 <= len(profiles) <= 10:
                raise DrawingError(f"{fid} : il faut de 2 à 10 profils")
            out_profiles = []
            for prof in profiles:
                if not isinstance(prof, list) or not 1 <= len(prof) <= 500 or any(object_types.get(_id(v, fid)) not in profile_kinds for v in prof):
                    raise DrawingError(f"{fid} : profil invalide")
                if any(v in construction_ids for v in prof):
                    raise DrawingError(f"{fid} : la géométrie de construction ne forme pas un profil")
                out_profiles.append(profile_shape([str(v) for v in prof]))
            item = {"id": fid, "type": kind, "profiles": out_profiles}
        name = f.get("name")
        if name is not None:
            if not isinstance(name, str) or not name.strip() or len(name) > 40 or _CTRL_RE.search(name):
                raise DrawingError(f"{fid} : nom de fonction invalide")
            item["name"] = name.strip()
        driven = f.get("driven")
        if driven is not None:
            if not v6 or not isinstance(driven, dict) or not driven or len(driven) > 6:
                raise DrawingError(f"{fid} : valeur pilotée invalide")
            for field, expr in driven.items():
                if field not in DRIVABLE or not isinstance(expr, str) or not expr.strip() or len(expr) > 120 or _CTRL_RE.search(expr):
                    raise DrawingError(f"{fid} : valeur pilotée invalide")
            item["driven"] = {str(field): expr.strip() for field, expr in driven.items()}
        if v6:
            op = f.get("op", "add")
            if kind in ("extrude", "revolve", "sweep", "loft"):
                if op not in ("add", "cut") or (i == 0 and op != "add"):
                    raise DrawingError(f"{fid} : opération invalide")
                item["op"] = op
            for flag in ("reverse", "both", "suppressed"):
                if f.get(flag) is not None:
                    if not isinstance(f.get(flag), bool):
                        raise DrawingError(f"{fid} : {flag} invalide")
                    if f[flag]:
                        item[flag] = True
        elif any(f.get(k) is not None for k in ("op", "reverse", "both", "suppressed")):
            raise DrawingError(f"{fid} : option de la version 6")
        seen_features.append(item)
        features.append(item)
    out["features"] = features if doc["version"] >= 2 else []
    rollback = doc.get("rollback")
    if rollback is not None:
        if not v6 or isinstance(rollback, bool) or not isinstance(rollback, int) or not 0 <= rollback <= len(features):
            raise DrawingError("Point de retour invalide")
        out["rollback"] = rollback
    raw_faces = doc.get("faceFeatures", [])
    if not isinstance(raw_faces, list) or len(raw_faces) > 50 or (doc["version"] < 3 and raw_faces):
        raise DrawingError("Fonctions sur face invalides")
    face_features = []
    face_ids = set(ids)
    total_vertices = 0
    for i, face in enumerate(raw_faces):
        if not isinstance(face, dict):
            raise DrawingError(f"Fonction sur face {i} invalide")
        fid = _id(face.get("id"), f"fonction sur face {i}")
        if fid in face_ids:
            raise DrawingError("Identifiant de fonction sur face en double")
        face_ids.add(fid)
        kind = face.get("type")
        extent = face.get("extent", "blind")
        if kind not in ("extrude", "cut") or extent not in ("blind", "throughAll") or (kind == "extrude" and extent != "blind"):
            raise DrawingError(f"{fid} : type ou étendue invalide")
        depth = _num(face.get("depth"), f"{fid} profondeur", lo=1e-9, hi=MAX_COORD)
        profile = face.get("profile")
        if not isinstance(profile, list) or not 3 <= len(profile) <= 500:
            raise DrawingError(f"{fid} : contour invalide")
        total_vertices += len(profile)
        if total_vertices > 2048:
            raise DrawingError("Trop de sommets sur les faces", 413)
        ring = [_xy(point, f"{fid} contour") for point in profile]
        plane = face.get("plane")
        if not isinstance(plane, dict):
            raise DrawingError(f"{fid} : plan invalide")
        vectors = {}
        for key in ("origin", "u", "v", "normal"):
            value = plane.get(key)
            if not isinstance(value, (list, tuple)) or len(value) != 3:
                raise DrawingError(f"{fid} : {key} invalide")
            vectors[key] = [_num(n, f"{fid} {key}") for n in value]
        u, v, n = (vectors[k] for k in ("u", "v", "normal"))
        dot = lambda a, b: sum(x * y for x, y in zip(a, b))
        cross = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        if any(abs(dot(a, a) - 1) > 1e-4 for a in (u, v, n)) or any(abs(dot(a, b)) > 1e-4 for a, b in ((u, v), (u, n), (v, n))) or any(abs(a - b) > 1e-4 for a, b in zip(cross, n)):
            raise DrawingError(f"{fid} : axes du plan invalides")
        face_features.append({"id": fid, "type": kind, "extent": extent, "depth": depth, "plane": vectors, "profile": ring})
    out["faceFeatures"] = face_features if doc["version"] >= 3 else []
    raw_rounds = doc.get("roundFeatures", [])
    if not isinstance(raw_rounds, list) or len(raw_rounds) > 50 or (doc["version"] < 3 and raw_rounds):
        raise DrawingError("Arrondis invalides")
    round_features = []
    for i, item in enumerate(raw_rounds):
        if not isinstance(item, dict):
            raise DrawingError(f"Arrondi {i} invalide")
        rid = _id(item.get("id"), f"arrondi {i}")
        if rid in face_ids:
            raise DrawingError("Identifiant d'arrondi en double")
        face_ids.add(rid)
        a, b = item.get("a"), item.get("b")
        if not all(isinstance(p, (list, tuple)) and len(p) == 3 for p in (a, b)):
            raise DrawingError(f"{rid} : arête invalide")
        start = [_num(v, f"{rid} arête") for v in a]
        end = [_num(v, f"{rid} arête") for v in b]
        radius = _num(item.get("radius"), f"{rid} rayon", lo=1e-6, hi=MAX_COORD)
        round_features.append({"id": rid, "a": start, "b": end, "radius": radius})
    out["roundFeatures"] = round_features if doc["version"] >= 3 else []
    if build and (features or face_features or round_features):
        try:
            hq_solid.build_mesh(out)
        except hq_solid.SolidError as e:
            raise DrawingError(str(e), 422) from e
    return out


def live_doc(doc) -> dict:
    """A document published to the shared hub: the same validation as a save, without the geometry build."""
    return validate_document(doc, build=False)


def stroke_widths(obj: dict) -> list[float]:
    """Per-point model widths for a validated stroke. Empty when the stroke has no stored width
    (versions 1–3, drawn as the historical hairline). Not used by DXF."""
    pts = obj.get("pts") or []
    w = obj.get("w")
    if not w:
        return []
    ks = obj.get("k") or [1.0] * len(pts)
    return [float(w) * float(ks[i] if i < len(ks) else 1.0) for i in range(len(pts))]


def decode_png(data_url) -> bytes:
    if not isinstance(data_url, str):
        raise DrawingError("Aperçu PNG manquant")
    prefix = "data:image/png;base64,"
    if not data_url.startswith(prefix):
        raise DrawingError("Aperçu PNG invalide")
    b64 = data_url[len(prefix):]
    if len(b64) > (MAX_PNG_BYTES * 4) // 3 + 8:
        raise DrawingError("Aperçu PNG trop volumineux", 413)
    try:
        raw = base64.b64decode(b64, validate=True)
    except (ValueError, TypeError):
        raise DrawingError("Aperçu PNG invalide")
    if len(raw) > MAX_PNG_BYTES:
        raise DrawingError("Aperçu PNG trop volumineux", 413)
    if len(raw) < 33 or raw[:8] != PNG_SIG or raw[12:16] != b"IHDR":
        raise DrawingError("Aperçu PNG invalide")
    width, height = struct.unpack(">II", raw[16:24])
    if not (0 < width <= MAX_PNG_SIDE and 0 < height <= MAX_PNG_SIDE):
        raise DrawingError("Aperçu PNG : dimensions hors limites")
    return raw


# ---------------------------------------------------------------- DXF

def _dxf_text(s: str) -> str:
    # One DXF value per line: strip every control char so no group code can be injected.
    s = "".join(" " if (unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp")) else c for c in str(s))
    return s.strip()[:MAX_TEXT]


def _f(v: float) -> str:
    out = f"{float(v):.6f}".rstrip("0").rstrip(".")
    return "0" if out in ("-0", "") else out


def simplify(pts: list, tol: float) -> list:
    """Ramer–Douglas–Peucker (iterative)."""
    n = len(pts)
    if n < 3 or tol <= 0:
        return [list(p) for p in pts]
    keep = [False] * n
    keep[0] = keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        i0, i1 = stack.pop()
        ax, ay = pts[i0]
        bx, by = pts[i1]
        dx, dy = bx - ax, by - ay
        seg = math.hypot(dx, dy)
        best, idx = -1.0, -1
        for i in range(i0 + 1, i1):
            px, py = pts[i]
            if seg == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / seg
            if d > best:
                best, idx = d, i
        if idx >= 0 and best > tol:
            keep[idx] = True
            stack.append((i0, idx))
            stack.append((idx, i1))
    return [list(pts[i]) for i in range(n) if keep[i]]


def _curve_points(o: dict, pts: dict) -> list[tuple[float, float]]:
    """Sampled model-space points of an ellipse or spline; the one curve sampler used by DXF, PDF and extents."""
    if o.get("type") == "ellipse":
        c = pts.get(o.get("center"))
        return hq_solid.ellipse_ring(c[0], c[1], o["rx"], o["ry"]) if c else []
    if o.get("type") == "spline":
        ids = o.get("pts") or []
        ctrl = [pts[i] for i in ids if i in pts]
        return hq_solid.spline_polyline(ctrl, bool(o.get("closed"))) if len(ctrl) == len(ids) else []
    return []


def build_dxf(doc: dict) -> str:
    """ASCII DXF (AC1009 entities + $INSUNITS). doc must be validated."""
    units = doc["units"]
    pts = {p["id"]: (p["x"], p["y"]) for p in doc["points"]}
    spacing = float(doc["grid"]["spacing"])
    ents: list[tuple[str, list[tuple[int, str]]]] = []
    xs: list[float] = []
    ys: list[float] = []

    def seen(x, y):
        xs.append(x)
        ys.append(y)

    def line(layer, a, b):
        seen(*a)
        seen(*b)
        ents.append(("LINE", [(8, layer), (10, _f(a[0])), (20, _f(a[1])), (30, "0"),
                              (11, _f(b[0])), (21, _f(b[1])), (31, "0")]))

    def polyline(layer, points, closed=False):
        """An R12 POLYLINE (closed flag optional); the faithful flattening for curves R12 has no entity for."""
        points = [(float(x), float(y)) for x, y in points]
        if len(points) < 2:
            return
        for x, y in points:
            seen(x, y)
        ents.append(("POLYLINE", [(8, layer), (66, "1"), (70, "1" if closed else "0"),
                                  (10, "0"), (20, "0"), (30, "0")]))
        for x, y in points:
            ents.append(("VERTEX", [(8, layer), (10, _f(x)), (20, _f(y)), (30, "0")]))
        ents.append(("SEQEND", [(8, layer)]))

    def text(layer, x, y, h, s, rot=0.0):
        s = _dxf_text(s)
        if not s:
            return
        seen(x, y)
        codes = [(8, layer), (10, _f(x)), (20, _f(y)), (30, "0"), (40, _f(h)), (1, s)]
        if rot:
            codes.append((50, _f(rot)))
        ents.append(("TEXT", codes))

    sketches = {s["id"]: s for s in doc.get("sketches") or []}
    sketch_layers: dict[str, str] = {}

    def layer_of(o) -> str | None:
        """The layer for one object: GEOMETRIE / AXES / … for the flat drawing, one layer per sketch in the XY plane.
        A sketch on XZ/YZ (or raised above XY) is part of the 3D part and stays out of the DXF, as before."""
        sid = o.get("sketch")
        if not sid:
            return "GEOMETRIE"
        sk = sketches.get(sid)
        if sk is None or sk.get("plane") != "XY" or abs(float(sk.get("offset") or 0.0)) > 1e-9:
            return None
        name = sketch_layers.get(sid)
        if name is None:
            # ASCII only: a DXF layer name travels through cp1252 and every CAM tool, accents do not survive it
            folded = unicodedata.normalize("NFKD", str(sk.get("name") or sid)).encode("ascii", "ignore").decode("ascii")
            safe = "".join(c if c.isalnum() else "_" for c in folded).strip("_").upper()[:20]
            name = "ESQ_" + (safe or "%s" % sid.upper())
            n = 1
            while name in sketch_layers.values():
                n += 1
                name = "ESQ_" + (safe or sid.upper())[:18] + "_" + str(n)
            sketch_layers[sid] = name
            LAYERS.setdefault(name, (7, "CONTINUOUS"))
        return name

    for o in doc["objects"]:
        t = o["type"]
        layer = layer_of(o)
        if layer is None:
            continue
        if t == "arc":
            cx, cy = pts[o["center"]]
            ax, ay = pts[o["p1"]]
            bx, by = pts[o["p2"]]
            r = math.hypot(ax - cx, ay - cy)
            seen(cx - r, cy - r)
            seen(cx + r, cy + r)
            start = math.degrees(math.atan2(ay - cy, ax - cx)) % 360
            end = math.degrees(math.atan2(by - cy, bx - cx)) % 360
            ents.append(("ARC", [(8, layer), (10, _f(cx)), (20, _f(cy)), (30, "0"), (40, _f(r)), (50, _f(start)), (51, _f(end))]))
            continue
        if t in ("line", "centerline"):
            line(layer if t == "line" else "AXES", pts[o["p1"]], pts[o["p2"]])
        elif t == "circle":
            cx, cy = pts[o["center"]]
            r = o["r"]
            seen(cx - r, cy - r)
            seen(cx + r, cy + r)
            ents.append(("CIRCLE", [(8, layer), (10, _f(cx)), (20, _f(cy)), (30, "0"), (40, _f(r))]))
        elif t in ("ellipse", "spline"):
            polyline(layer, _curve_points(o, pts), t == "ellipse" or bool(o.get("closed")))
        elif t == "stroke":
            # Width (w, k) is a screen/PNG concern. DXF stays a plain POLYLINE: no width group codes.
            simp = simplify(o["pts"], spacing * 0.05)
            if len(simp) == 1:
                simp = [simp[0], simp[0]]
            for p in simp:
                seen(*p)
            ents.append(("POLYLINE", [(8, "REFERENCE_MAIN_LEVEE"), (66, "1"), (70, "0"),
                                      (10, "0"), (20, "0"), (30, "0")]))
            for p in simp:
                ents.append(("VERTEX", [(8, "REFERENCE_MAIN_LEVEE"), (10, _f(p[0])), (20, _f(p[1])), (30, "0")]))
            ents.append(("SEQEND", [(8, "REFERENCE_MAIN_LEVEE")]))
        elif t == "text":
            text("NOTES", o["x"], o["y"], o["h"], o["text"])
        elif t == "dim_linear":
            _dim_linear(o, spacing, line, text)
        elif t == "dim_angle":
            _dim_angle(o, spacing, line, text, ents, seen)
        elif t in ("dim_diameter", "dim_radius"):
            _dim_radial(o, doc, pts, spacing, line, text, seen)

    if not xs:
        xs, ys = [0.0], [0.0]
    out: list[str] = []

    def g(code, value):
        out.append(str(code))
        out.append(str(value))

    g(0, "SECTION"); g(2, "HEADER")
    g(9, "$ACADVER"); g(1, "AC1009")
    g(9, "$DWGCODEPAGE"); g(3, "ANSI_1252")
    g(9, "$INSUNITS"); g(70, UNITS[units])
    g(9, "$MEASUREMENT"); g(70, 0 if units == "in" else 1)
    g(9, "$EXTMIN"); g(10, _f(min(xs))); g(20, _f(min(ys))); g(30, "0")
    g(9, "$EXTMAX"); g(10, _f(max(xs))); g(20, _f(max(ys))); g(30, "0")
    g(0, "ENDSEC")

    # linetype pattern expressed in drawing units (base mm)
    per_mm = {"mm": 1.0, "cm": 0.1, "m": 0.001, "in": 1 / 25.4}[units]
    pattern = [12.0 * per_mm, -3.0 * per_mm, 3.0 * per_mm, -3.0 * per_mm]
    g(0, "SECTION"); g(2, "TABLES")
    g(0, "TABLE"); g(2, "LTYPE"); g(70, 2)
    g(0, "LTYPE"); g(2, "CONTINUOUS"); g(70, 0); g(3, "Solid line"); g(72, 65); g(73, 0); g(40, "0")
    g(0, "LTYPE"); g(2, "CENTER"); g(70, 0); g(3, "Center ____ _ ____"); g(72, 65); g(73, len(pattern))
    g(40, _f(sum(abs(x) for x in pattern)))
    for x in pattern:
        g(49, _f(x))
    g(0, "ENDTAB")
    g(0, "TABLE"); g(2, "LAYER"); g(70, len(LAYERS) + 1)
    g(0, "LAYER"); g(2, "0"); g(70, 0); g(62, 7); g(6, "CONTINUOUS")
    for name, (color, ltype) in LAYERS.items():
        g(0, "LAYER"); g(2, name); g(70, 0); g(62, color); g(6, ltype)
    g(0, "ENDTAB")
    g(0, "ENDSEC")

    g(0, "SECTION"); g(2, "ENTITIES")
    for kind, codes in ents:
        g(0, kind)
        for code, value in codes:
            g(code, value)
    g(0, "ENDSEC")
    g(0, "EOF")
    return "\r\n".join(out) + "\r\n"


def _dim_linear(o, spacing, line, text):
    (ax, ay), (bx, by) = o["a"], o["b"]
    dx, dy = bx - ax, by - ay
    length = math.hypot(dx, dy)
    if length <= 0:
        return
    ux, uy = dx / length, dy / length
    nx, ny = -uy, ux
    off = o["offset"]
    a2 = (ax + nx * off, ay + ny * off)
    b2 = (bx + nx * off, by + ny * off)
    ext = math.copysign(spacing * 0.15, off) if off else 0.0
    line("COTATIONS", (ax, ay), (a2[0] + nx * ext, a2[1] + ny * ext))
    line("COTATIONS", (bx, by), (b2[0] + nx * ext, b2[1] + ny * ext))
    line("COTATIONS", a2, b2)
    t = spacing * 0.15  # oblique ticks (architectural style, no arrow blocks needed)
    for px, py in (a2, b2):
        line("COTATIONS", (px - (ux + nx) * t, py - (uy + ny) * t), (px + (ux + nx) * t, py + (uy + ny) * t))
    rot = math.degrees(math.atan2(dy, dx))
    if rot > 90 or rot <= -90:
        rot += 180
    h = spacing * 0.35
    mx, my = (a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2
    label = o["label"] or _f(round(length, 3))
    text("COTATIONS", mx + nx * h * 0.4, my + ny * h * 0.4, h, label, rot % 360)


def _dim_radial(o, doc, pts, spacing, line, text, seen):
    """Ø / R cote: the leader through (or from) the centre, tick marks on the edge, the real value as text."""
    item = next((x for x in doc["objects"] if x["id"] == o.get("item")), None)
    if item is None:
        return
    if item["type"] == "circle":
        cx, cy = pts[item["center"]]
        r = float(item["r"])
    elif item["type"] == "arc":
        cx, cy = pts[item["center"]]
        ax, ay = pts[item["p1"]]
        r = math.hypot(ax - cx, ay - cy)
    else:
        return
    if r <= 0:
        return
    ang = float(o.get("ang") if o.get("ang") is not None else 0.6)
    ux, uy = math.cos(ang), math.sin(ang)
    edge = (cx + ux * r, cy + uy * r)
    diameter = o["type"] == "dim_diameter" and item["type"] == "circle"
    far = (cx - ux * r, cy - uy * r) if diameter else (cx, cy)
    line("COTATIONS", far, edge)
    t = spacing * 0.12  # the tick across the leader (same style as the other cotes: no arrow blocks in AC1009 here)
    line("COTATIONS", (edge[0] - uy * t, edge[1] + ux * t), (edge[0] + uy * t, edge[1] - ux * t))
    if diameter:
        line("COTATIONS", (far[0] - uy * t, far[1] + ux * t), (far[0] + uy * t, far[1] - ux * t))
    raw = str(o.get("label") or "").strip()
    if raw:
        label = raw
    elif o["type"] == "dim_diameter":
        label = "%%c" + _f(round(2 * r, 3))
    else:
        label = "R" + _f(round(r, 3))
    if o.get("tol"):
        label += " " + str(o["tol"])
    if o.get("ref"):
        label = "(" + label + ")"
    h = spacing * 0.35
    text("COTATIONS", edge[0] + ux * h * 0.9, edge[1] + uy * h * 0.9, h, label)


def _dim_angle(o, spacing, line, text, ents, seen):
    (cx, cy), (ax, ay), (bx, by) = o["c"], o["a"], o["b"]
    a1 = math.degrees(math.atan2(ay - cy, ax - cx))
    a2 = math.degrees(math.atan2(by - cy, bx - cx))
    sweep = (a2 - a1) % 360
    if sweep > 180:
        a1, a2 = a2, a1
        sweep = 360 - sweep
    r = o["r"]
    seen(cx - r, cy - r)
    seen(cx + r, cy + r)
    ents.append(("ARC", [(8, "COTATIONS"), (10, _f(cx)), (20, _f(cy)), (30, "0"), (40, _f(r)),
                         (50, _f(a1 % 360)), (51, _f(a2 % 360))]))
    for ang in (a1, a2):
        rad = math.radians(ang)
        line("COTATIONS", (cx, cy), (cx + math.cos(rad) * r * 1.1, cy + math.sin(rad) * r * 1.1))
    mid = math.radians(a1 + sweep / 2)
    h = spacing * 0.35
    label = o["label"] or (_f(round(sweep, 2)) + "%%d")
    text("COTATIONS", cx + math.cos(mid) * (r + h), cy + math.sin(mid) * (r + h), h, label)


GLYPH_FIX = {"\u2300": "\u00d8", "\u2205": "\u00d8", "\u2192": "->", "\u2190": "<-", "\u2264": "<=", "\u2265": ">=",
             "\u2212": "-", "\u2013": "-", "\u2014": "-", "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
             "\u00a0": " "}


def _pdf_text(s: str) -> str:
    """One PDF string literal: glyphs WinAnsi cannot carry mapped to their plain equivalent (a Ø cote must not print as
    "?10" on the shop sheet), control chars out, parentheses escaped, WinAnsi bytes in latin-1."""
    s = "".join(" " if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") else GLYPH_FIX.get(c, c) for c in str(s or ""))
    s = s.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
    return s.encode("cp1252", "replace").decode("latin-1").strip()


def _drawing_extent(doc: dict) -> tuple[float, float, float, float] | None:
    pts = {p["id"]: (p["x"], p["y"]) for p in doc["points"]}
    circles = {o["id"]: o for o in doc["objects"] if o["type"] in ("circle", "arc")}
    xs: list[float] = []
    ys: list[float] = []

    def see(x, y):
        xs.append(float(x))
        ys.append(float(y))

    for o in doc["objects"]:
        t = o["type"]
        if t in ("line", "centerline"):
            for k in ("p1", "p2"):
                if o.get(k) in pts:
                    see(*pts[o[k]])
        elif t == "circle":
            c = pts.get(o.get("center"))
            if c:
                see(c[0] - o["r"], c[1] - o["r"])
                see(c[0] + o["r"], c[1] + o["r"])
        elif t == "arc":
            c, p1 = pts.get(o.get("center")), pts.get(o.get("p1"))
            if c and p1:
                r = math.hypot(p1[0] - c[0], p1[1] - c[1])
                see(c[0] - r, c[1] - r)
                see(c[0] + r, c[1] + r)
        elif t in ("ellipse", "spline"):
            for x, y in _curve_points(o, pts):
                see(x, y)
        elif t == "stroke":
            for p in o["pts"]:
                see(p[0], p[1])
        elif t == "text":
            see(o["x"], o["y"])
        elif t == "dim_linear":
            see(o["a"][0], o["a"][1])
            see(o["b"][0], o["b"][1])
        elif t == "dim_angle":
            see(o["c"][0] - o["r"], o["c"][1] - o["r"])
            see(o["c"][0] + o["r"], o["c"][1] + o["r"])
        elif t in ("dim_diameter", "dim_radius"):
            item = circles.get(o.get("item"))
            c = pts.get(item.get("center")) if item else None
            if c and item:
                if item["type"] == "circle":
                    r = float(item["r"])
                else:
                    p1 = pts.get(item.get("p1"))
                    r = math.hypot(p1[0] - c[0], p1[1] - c[1]) if p1 else 0.0
                see(c[0] - r, c[1] - r)
                see(c[0] + r, c[1] + r)
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


def build_pdf(doc: dict, *, name: str = "", material: str = "", note: str = "", now=None) -> bytes:
    """One A4 landscape shop sheet: frame, the flat drawing at a stated scale, a title block.

    Vector output built from the same document the DXF carries (no raster, no external library, standard library only).
    """
    W, H = 842.0, 595.0  # A4 landscape, points
    AREA = (30.0, 150.0, W - 30.0, H - 40.0)  # left, bottom, right, top of the drawing area
    ops: list[str] = []

    def line(x0, y0, x1, y1):
        ops.append(f"{x0:.2f} {y0:.2f} m {x1:.2f} {y1:.2f} l S")

    def rect(x, y, w, h, width=0.8):
        ops.append(f"{width:.2f} w {x:.2f} {y:.2f} {w:.2f} {h:.2f} re S")

    def text_at(x, y, s, size=9.0, bold=False):
        body = _pdf_text(s)
        if body:
            ops.append(f"BT /{'F2' if bold else 'F1'} {size:.1f} Tf {x:.2f} {y:.2f} Td ({body}) Tj ET")

    ops.append("0.8 w 0.15 0.15 0.15 RG")
    rect(18, 18, W - 36, H - 36, 1.0)
    ax0, ay0, ax1, ay1 = AREA

    ext = _drawing_extent(doc)
    if ext:
        ex0, ey0, ex1, ey1 = ext
        dw, dh = max(ex1 - ex0, 1e-9), max(ey1 - ey0, 1e-9)
        k = min((ax1 - ax0) * 0.94 / dw, (ay1 - ay0) * 0.94 / dh)
        ox = ax0 + ((ax1 - ax0) - dw * k) / 2 - ex0 * k
        oy = ay0 + ((ay1 - ay0) - dh * k) / 2 - ey0 * k
    else:
        k, ox, oy = 1.0, ax0, ay0

    def P(x, y):
        return (ox + float(x) * k, oy + float(y) * k)

    pts = {p["id"]: (p["x"], p["y"]) for p in doc["points"]}
    ops.append("0.7 w 0 0 0 RG")
    for o in doc["objects"]:
        t = o["type"]
        if t in ("line", "centerline"):
            if o.get("p1") in pts and o.get("p2") in pts:
                a, b = P(*pts[o["p1"]]), P(*pts[o["p2"]])
                line(a[0], a[1], b[0], b[1])
        elif t == "circle":
            c = pts.get(o.get("center"))
            r = float(o["r"]) * k
            if c and r > 0:
                cx, cy = P(*c)
                bc = 0.5523 * r
                ops.append(f"{cx + r:.2f} {cy:.2f} m "
                           f"{cx + r:.2f} {cy + bc:.2f} {cx + bc:.2f} {cy + r:.2f} {cx:.2f} {cy + r:.2f} c "
                           f"{cx - bc:.2f} {cy + r:.2f} {cx - r:.2f} {cy + bc:.2f} {cx - r:.2f} {cy:.2f} c "
                           f"{cx - r:.2f} {cy - bc:.2f} {cx - bc:.2f} {cy - r:.2f} {cx:.2f} {cy - r:.2f} c "
                           f"{cx + bc:.2f} {cy - r:.2f} {cx + r:.2f} {cy - bc:.2f} {cx + r:.2f} {cy:.2f} c S")
        elif t == "arc":
            c, p1, p2 = pts.get(o.get("center")), pts.get(o.get("p1")), pts.get(o.get("p2"))
            if c and p1 and p2:
                r = math.hypot(p1[0] - c[0], p1[1] - c[1])
                a0 = math.atan2(p1[1] - c[1], p1[0] - c[0])
                a1 = math.atan2(p2[1] - c[1], p2[0] - c[0])
                sweep = a1 - a0
                while sweep <= 0:
                    sweep += 2 * math.pi
                steps = max(8, int(48 * sweep / (2 * math.pi)))
                first = P(c[0] + math.cos(a0) * r, c[1] + math.sin(a0) * r)
                ops.append(f"{first[0]:.2f} {first[1]:.2f} m")
                for i in range(1, steps + 1):
                    a = a0 + sweep * i / steps
                    q = P(c[0] + math.cos(a) * r, c[1] + math.sin(a) * r)
                    ops.append(f"{q[0]:.2f} {q[1]:.2f} l")
                ops.append("S")
        elif t in ("ellipse", "spline"):
            curve = _curve_points(o, pts)
            if len(curve) > 1:
                first = P(*curve[0])
                ops.append(f"{first[0]:.2f} {first[1]:.2f} m")
                for p in curve[1:]:
                    q = P(*p)
                    ops.append(f"{q[0]:.2f} {q[1]:.2f} l")
                ops.append("h S" if t == "ellipse" or o.get("closed") else "S")
        elif t == "stroke":
            if len(o["pts"]) > 1:
                first = P(o["pts"][0][0], o["pts"][0][1])
                ops.append(f"{first[0]:.2f} {first[1]:.2f} m")
                for p in o["pts"][1:]:
                    q = P(p[0], p[1])
                    ops.append(f"{q[0]:.2f} {q[1]:.2f} l")
                ops.append("S")
        elif t == "text":
            q = P(o["x"], o["y"])
            text_at(q[0], q[1], o["text"], max(5.0, min(12.0, float(o["h"]) * k)))
        elif t == "dim_linear":
            dx, dy = o["b"][0] - o["a"][0], o["b"][1] - o["a"][1]
            length = math.hypot(dx, dy)
            if length > 0:
                nx, ny = -dy / length, dx / length
                off = float(o.get("offset") or 0.0)
                a2 = (o["a"][0] + nx * off, o["a"][1] + ny * off)
                b2 = (o["b"][0] + nx * off, o["b"][1] + ny * off)
                A, B, A2, B2 = P(*o["a"]), P(*o["b"]), P(*a2), P(*b2)
                line(A[0], A[1], A2[0], A2[1])
                line(B[0], B[1], B2[0], B2[1])
                line(A2[0], A2[1], B2[0], B2[1])
                text_at((A2[0] + B2[0]) / 2, (A2[1] + B2[1]) / 2 + 3, o.get("label") or _f(round(length, 3)), 8.0)
        elif t == "dim_angle":
            c = P(o["c"][0], o["c"][1])
            r = float(o["r"]) * k
            a0 = math.atan2(o["a"][1] - o["c"][1], o["a"][0] - o["c"][0])
            a1 = math.atan2(o["b"][1] - o["c"][1], o["b"][0] - o["c"][0])
            sweep = a1 - a0
            while sweep <= 0:
                sweep += 2 * math.pi
            steps = max(6, int(32 * sweep / (2 * math.pi)))
            first = (c[0] + math.cos(a0) * r, c[1] + math.sin(a0) * r)
            ops.append(f"{first[0]:.2f} {first[1]:.2f} m")
            for i in range(1, steps + 1):
                a = a0 + sweep * i / steps
                ops.append(f"{c[0] + math.cos(a) * r:.2f} {c[1] + math.sin(a) * r:.2f} l")
            ops.append("S")
            mid = a0 + sweep / 2
            text_at(c[0] + math.cos(mid) * (r + 6), c[1] + math.sin(mid) * (r + 6),
                     o.get("label") or (_f(round(math.degrees(sweep), 2)) + "\u00b0"), 8.0)
        elif t in ("dim_diameter", "dim_radius"):
            item = next((x for x in doc["objects"] if x["id"] == o.get("item")), None)
            c = pts.get(item.get("center")) if item else None
            if item and c:
                r = float(item["r"]) if item["type"] == "circle" else math.hypot(
                    pts[item["p1"]][0] - c[0], pts[item["p1"]][1] - c[1])
                ang = float(o.get("ang") if o.get("ang") is not None else 0.6)
                ux, uy = math.cos(ang), math.sin(ang)
                edge = (c[0] + ux * r, c[1] + uy * r)
                far = (c[0] - ux * r, c[1] - uy * r) if (o["type"] == "dim_diameter" and item["type"] == "circle") else c
                A, B = P(*far), P(*edge)
                line(A[0], A[1], B[0], B[1])
                raw = str(o.get("label") or "").strip()
                if not raw:
                    raw = ("\u2300" + _f(round(2 * r, 3))) if o["type"] == "dim_diameter" else ("R" + _f(round(r, 3)))
                if o.get("tol"):
                    raw += " " + str(o["tol"])
                if o.get("ref"):
                    raw = "(" + raw + ")"
                text_at(B[0] + ux * 8, B[1] + uy * 8, raw, 8.0)

    unit_mm = UNIT_MM.get(doc.get("units"), 1.0)
    paper_mm = k * 25.4 / 72.0  # one model unit, in millimetres on the sheet
    ratio = unit_mm / paper_mm if paper_mm > 0 else 0.0
    if ratio >= 1:
        scale_txt = "1:%d" % max(1, round(ratio))
    else:
        scale_txt = "%.1f:1" % (1.0 / ratio if ratio > 0 else 1.0)
    stamp = time.strftime("%Y-%m-%d", time.localtime(now() if now else time.time()))
    bx, by, bw, bh = W - 348.0, 24.0, 330.0, 108.0
    rect(bx, by, bw, bh, 0.9)
    line(bx, by + bh - 26, bx + bw, by + bh - 26)
    text_at(bx + 10, by + bh - 18, name or "Sans nom", 13.0, bold=True)
    rows = [("\u00c9chelle", scale_txt), ("Unit\u00e9s", str(doc.get("units") or "mm")), ("Date", stamp),
            ("Mati\u00e8re", material or "\u2014"), ("Note", note or "\u2014")]
    for i, (label, value) in enumerate(rows):
        y = by + bh - 44 - i * 15
        text_at(bx + 10, y, label, 9.0, bold=True)
        text_at(bx + 86, y, str(value), 9.0)
    text_at(30, 30, "Transfert HQ \u00b7 Dessiner \u00b7 fiche d'atelier", 9.0)
    if ext:
        text_at(30, 44, "%s \u00d7 %s %s" % (_f(round(ext[2] - ext[0], 2)), _f(round(ext[3] - ext[1], 2)), doc.get("units") or ""), 9.0)
    assumptions = doc.get("assumptions") or []
    for i, item in enumerate(assumptions[:8]):
        reason = (" \u2014 " + item["reason"]) if item.get("reason") else ""
        text_at(30, 140 - i * 10, "%s : %s%s" % (item.get("name"), item.get("value"), reason), 6.5)
    if len(assumptions) > 8:
        text_at(30, 140 - 8 * 10, "(+ %d autres hypoth\u00e8ses)" % (len(assumptions) - 8), 6.5)

    content = ("\n".join(ops)).encode("latin-1", "replace")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        ("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
         % (W, H)).encode(),
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ]
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += ("%d 0 obj\n" % i).encode() + body + b"\nendobj\n"
    xref = len(out)
    out += ("xref\n0 %d\n" % (len(objects) + 1)).encode() + b"0000000000 65535 f \n"
    for off in offsets:
        out += ("%010d 00000 n \n" % off).encode()
    out += ("trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)).encode()
    return bytes(out)


# ---------------------------------------------------------------- storage

def _write_temp(directory: Path, data: bytes) -> Path:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    for _ in range(20):
        tmp = directory / f".hqdraw-{secrets.token_hex(8)}.part"
        try:
            fd = os.open(tmp, flags, 0o644)
        except FileExistsError:
            continue
        try:
            view = memoryview(data)
            while view:
                n = os.write(fd, view)
                view = view[n:]
            os.fsync(fd)
        finally:
            os.close(fd)
        return tmp
    raise DrawingError("Impossible de créer un fichier temporaire", 500)


def _publish_noclobber(tmp: Path, final: Path) -> None:
    """Atomically make tmp visible as final; FileExistsError if final exists."""
    try:
        os.link(tmp, final)
        return
    except FileExistsError:
        raise
    except (OSError, NotImplementedError, AttributeError):
        pass
    # Filesystems without hard links (FAT/exFAT, some shares): exclusive create +
    # copy. Not atomic, but never clobbers and keeps tmp reusable for a retry.
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(final, flags, 0o644)
    try:
        with open(tmp, "rb") as src:
            while True:
                chunk = src.read(1 << 16)
                if not chunk:
                    break
                os.write(fd, chunk)
        os.fsync(fd)
    finally:
        os.close(fd)


def _unlink_quiet(p: Path) -> None:
    try:
        os.unlink(p)
    except OSError:
        pass


def _require_parent(root: Path, base) -> str:
    """``base`` establishes LINEAGE only: a canonical stem whose drawing document exists now. Never a path, never overwritten,
    never an implicit 'latest'."""
    if not isinstance(base, str):
        raise DrawingError("Version précédente invalide")
    stem = valid_stem(base)
    directory = drawings_dir(root, create=False)
    if directory is None:
        raise DrawingError("Version précédente introuvable", 409)
    try:
        st = os.lstat(directory / (stem + DOC_SUFFIX))
    except FileNotFoundError:
        raise DrawingError("Version précédente introuvable", 409)
    if _is_link_or_reparse(st) or not stat.S_ISREG(st.st_mode):
        raise DrawingError("Version précédente refusée", 400)
    return stem


def save_drawing(root: Path, payload: dict, *, now=time.time, asset_exists=None) -> dict:
    if not isinstance(payload, dict):
        raise DrawingError("Requête invalide")
    doc = validate_document(payload.get("doc"))
    if "underlay" in doc:
        try:
            found = asset_exists is not None and bool(asset_exists(doc["underlay"]["asset_id"]))
        except Exception:  # an unreadable asset store is "not verified", never "present"
            found = False
        if not found:
            raise DrawingError("Image du fond introuvable", 409)
    parent = _require_parent(root, payload["base"]) if payload.get("base") not in (None, "") else None
    png = decode_png(payload.get("png"))
    base = sanitize_base_name(payload.get("name"))
    suffix = source_suffix(payload.get("source"))
    saved_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now()))
    directory = drawings_dir(root, create=True)
    dxf_bytes = build_dxf(doc).encode("cp1252", errors="replace")
    mesh = hq_solid.build_mesh(doc) if doc["features"] or doc["faceFeatures"] or doc["roundFeatures"] else []
    stl_bytes = hq_solid.binary_stl(mesh, doc["units"]) if mesh else None

    with _SAVE_LOCK:
        temps: list[Path] = []
        try:
            png_tmp = _write_temp(directory, png)
            temps.append(png_tmp)
            dxf_tmp = _write_temp(directory, dxf_bytes)
            temps.append(dxf_tmp)
            stl_tmp = _write_temp(directory, stl_bytes) if stl_bytes is not None else None
            if stl_tmp is not None:
                temps.append(stl_tmp)
            for n in range(0, 1000):
                stem = f"{base}{'' if n == 0 else '-' + str(n + 1)}{suffix}"
                names = [stem + DOC_SUFFIX, stem + PNG_SUFFIX, stem + DXF_SUFFIX]
                if stl_tmp is not None:
                    names.append(stem + STL_SUFFIX)
                if any(os.path.lexists(directory / nm) for nm in names):
                    continue
                doc_out = dict(doc)
                doc_out["meta"] = {
                    "stem": stem,
                    "name": base,
                    "source": suffix.lstrip("_"),
                    "saved_at": saved_at,
                    **({"parent": parent} if parent else {}),
                    "files": {"png": names[1], "dxf": names[2], **({"stl": names[3]} if stl_tmp is not None else {})},
                }
                body = json.dumps(doc_out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                if len(body) > MAX_DOC_BYTES:
                    raise DrawingError("Document trop volumineux", 413)
                doc_tmp = _write_temp(directory, body)
                temps.append(doc_tmp)
                published: list[Path] = []
                try:
                    publications = [(png_tmp, names[1]), (dxf_tmp, names[2])]
                    if stl_tmp is not None:
                        publications.append((stl_tmp, names[3]))
                    publications.append((doc_tmp, names[0]))
                    for tmp, nm in publications:
                        _publish_noclobber(tmp, directory / nm)
                        published.append(directory / nm)
                except FileExistsError:
                    for p in published:
                        _unlink_quiet(p)
                    _unlink_quiet(doc_tmp)
                    temps.remove(doc_tmp)
                    continue
                except BaseException:
                    for p in published:  # never leave a half-published drawing behind
                        _unlink_quiet(p)
                    raise
                return {
                    "ok": True,
                    "stem": stem,
                    "saved_at": saved_at,
                    **({"parent": parent} if parent else {}),
                    "files": {k: rel_for(nm) for k, nm in zip(("json", "png", "dxf", "stl"), names)},
                }
            raise DrawingError("Trop de dessins portant ce nom", 409)
        finally:
            for t in temps:
                _unlink_quiet(t)


def preview_mesh(payload: dict) -> dict:
    """Compute an unsaved 3D preview from the same validated mesh as STL."""
    if not isinstance(payload, dict):
        raise DrawingError("Requête invalide")
    doc = validate_document(payload.get("doc"))
    if hq_solid_occ.uses_occ(doc):
        # exact part: every edge (curves as short polylines) can be picked for a fillet or chamfer
        try:
            shape = hq_solid_occ.build_shape(doc)
            mesh = hq_solid_occ.triangles(shape)
            edges = hq_solid_occ.edges_of(shape) if shape is not None else []
            mass = hq_solid_occ.mass_properties(doc) if shape is not None else {}
        except hq_solid.SolidError as e:
            raise DrawingError(str(e), 422) from e
        return {"ok": True, "units": doc["units"], "triangles": mesh, "count": len(mesh), "exact": True,
                "edges": edges[:5000], "edgesTruncated": len(edges) > 5000, "mass": mass}
    mesh = hq_solid.build_mesh(doc)
    from hq_round_solid import eligible_edges
    edges = eligible_edges(mesh)
    return {"ok": True, "units": doc["units"], "triangles": mesh, "count": len(mesh),
            "edges": [{"a": e["a"], "b": e["b"], "length": e["length"]} for e in edges[:5000]],
            "edgesTruncated": len(edges) > 5000}


def step_file(payload: dict) -> tuple[bytes, str]:
    """The part as a STEP file (exact solid, millimetres): version-6 drawings only."""
    if not isinstance(payload, dict):
        raise DrawingError("Requête invalide")
    doc = validate_document(payload.get("doc"))
    if not hq_solid_occ.uses_occ(doc):
        raise DrawingError("L'export STEP demande une pièce exacte (dessin version 6)", 409)
    try:
        data = hq_solid_occ.step_bytes(doc)
    except hq_solid.SolidError as e:
        raise DrawingError(str(e), 422) from e
    name = sanitize_base_name(payload.get("name") or "piece") if payload.get("name") else "piece"
    return data, name + ".step"


def ar_model(payload: dict) -> dict:
    """Build a USDZ of the drawing's part for AR Quick Look and hold it briefly in memory (hq_usdz)."""
    import hq_usdz
    if not isinstance(payload, dict):
        raise DrawingError("Requête invalide")
    doc = validate_document(payload.get("doc"))
    mesh = hq_solid.build_mesh(doc)
    if not mesh:
        raise DrawingError("Crée d'abord une pièce 3D", 409)
    name = payload.get("name") if isinstance(payload.get("name"), str) else "Piece"
    data = hq_usdz.build(mesh, doc["units"], name[:40])
    fid = hq_usdz.keep(data)
    return {"ok": True, "id": fid, "url": f"/api/drawings/usdz/{fid}.usdz", "bytes": len(data), "triangles": len(mesh)}


def _read_regular(directory: Path, name: str, cap: int) -> bytes:
    path = directory / name
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise DrawingError("Dessin introuvable", 404)
    if _is_link_or_reparse(st) or not stat.S_ISREG(st.st_mode):
        raise DrawingError("Fichier refusé (lien ou jonction)", 400)
    if st.st_size > cap:
        raise DrawingError("Fichier trop volumineux", 413)
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or fst.st_size > cap:
            raise DrawingError("Fichier refusé", 400)
        chunks = []
        remaining = cap + 1
        while remaining > 0:
            chunk = os.read(fd, min(1 << 16, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    finally:
        os.close(fd)
    data = b"".join(chunks)
    if len(data) > cap:
        raise DrawingError("Fichier trop volumineux", 413)
    return data


def open_drawing(root: Path, stem) -> dict:
    stem = valid_stem(stem)
    directory = drawings_dir(root, create=False)
    if directory is None:
        raise DrawingError("Dessin introuvable", 404)
    raw = _read_regular(directory, stem + DOC_SUFFIX, MAX_DOC_BYTES)
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DrawingError("Dessin illisible", 422)
    try:
        doc = validate_document(data)
    except DrawingError as e:
        raise DrawingError(f"Dessin illisible : {e}", 422)
    meta = data.get("meta") if isinstance(data, dict) else None
    if isinstance(meta, dict):
        doc["meta"] = {
            "stem": stem,
            "name": _text(meta.get("name"), "nom", max_len=MAX_NAME + 20) if isinstance(meta.get("name"), str) else stem,
            "source": _text(meta.get("source"), "source", max_len=40) if isinstance(meta.get("source"), str) else "",
            "saved_at": _text(meta.get("saved_at"), "date", max_len=40) if isinstance(meta.get("saved_at"), str) else "",
        }
        if isinstance(meta.get("parent"), str) and STEM_RE.match(meta["parent"]):
            doc["meta"]["parent"] = meta["parent"]
    return {"ok": True, "stem": stem, "doc": doc}


def read_file(root: Path, stem, kind: str) -> tuple[bytes, str, str]:
    stem = valid_stem(stem)
    if kind == "pdf":
        # the shop sheet is built from the stored document on demand: nothing extra is written next to the drawing
        doc = open_drawing(root, stem)["doc"]
        meta = doc.get("meta") or {}
        return (build_pdf(doc, name=str(meta.get("name") or stem), material=str(meta.get("material") or ""),
                          note=str(meta.get("note") or "")), "application/pdf", stem + PDF_SUFFIX)
    suffix, ctype, cap = {
        "png": (PNG_SUFFIX, "image/png", MAX_PNG_BYTES),
        "dxf": (DXF_SUFFIX, "application/dxf", 16 * 1024 * 1024),
        "json": (DOC_SUFFIX, "application/json; charset=utf-8", MAX_DOC_BYTES),
        "stl": (STL_SUFFIX, "model/stl", 12 * 1024 * 1024),
    }.get(kind, (None, None, 0))
    if not suffix:
        raise DrawingError("Type de fichier invalide", 400)
    directory = drawings_dir(root, create=False)
    if directory is None:
        raise DrawingError("Dessin introuvable", 404)
    name = stem + suffix
    return _read_regular(directory, name, cap), ctype, name


def delete_drawing(root: Path, stem) -> dict:
    """Delete one saved drawing and its companions (PNG / DXF / STL). The stem is the only key: never a path.

    Only the known regular files of that stem are removed: no directory, no link / reparse point, never another
    drawing. A stem with nothing left to remove is a 404 so the caller can refresh its list.
    """
    stem = valid_stem(stem)
    directory = drawings_dir(root, create=False)
    if directory is None:
        raise DrawingError("Dessin introuvable", 404)
    removed: list[str] = []
    for suffix in (DOC_SUFFIX, PNG_SUFFIX, DXF_SUFFIX, STL_SUFFIX):
        path = directory / (stem + suffix)
        try:
            est = os.lstat(path)
        except OSError:
            continue
        if not stat.S_ISREG(est.st_mode) or _is_link_or_reparse(est):
            continue
        try:
            path.unlink()
        except OSError as e:
            raise DrawingError("Suppression impossible", 500) from e
        removed.append(path.name)
    if not removed:
        raise DrawingError("Dessin introuvable", 404)
    return {"ok": True, "stem": stem, "removed": removed}


def _drafts_dir(root: Path, *, create: bool) -> Path | None:
    """The hidden scratch folder inside Inbox/Drawings. Never a link, never the drawings folder itself."""
    directory = drawings_dir(root, create=create)
    if directory is None:
        return None
    store = directory / DRAFTS_DIR
    if create:
        try:
            store.mkdir(exist_ok=True)
        except OSError as e:
            raise DrawingError("Brouillon impossible", 500) from e
    try:
        est = os.lstat(store)
    except OSError:
        return None
    if not stat.S_ISDIR(est.st_mode) or _is_link_or_reparse(est):
        raise DrawingError("Brouillon impossible", 409)
    return store


def write_draft(root: Path, payload: dict, *, now=time.time) -> dict:
    """One scratch copy of the drawing in progress, overwritten each time it is flushed.

    It is validated exactly like a save, but it never enters the library or a lineage: it is only the durable copy
    that replaces a full localStorage. Stored in Inbox/Drawings/.drafts so no listing ever shows it.
    """
    if not isinstance(payload, dict):
        raise DrawingError("Requête invalide")
    doc = validate_document(payload.get("doc"))
    stem = payload.get("stem")
    key = valid_stem(stem) if isinstance(stem, str) and STEM_RE.match(stem) else "scratch"
    store = _drafts_dir(root, create=True)
    if store is None:
        raise DrawingError("Brouillon impossible", 500)
    at = int(now())
    body = json.dumps({"format": FORMAT, "draft": 1, "at": at, "stem": "" if key == "scratch" else key,
                       "name": str(payload.get("name") or "")[:120],
                       "objects": len(doc["objects"]), "points": len(doc["points"]), "doc": doc},
                      ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_DOC_BYTES:
        raise DrawingError("Brouillon trop volumineux", 413)
    with _SAVE_LOCK:
        tmp = _write_temp(store, body)
        try:
            _keep_previous(store, key, store / (key + DRAFT_SUFFIX))
            os.replace(tmp, store / (key + DRAFT_SUFFIX))
        except OSError as e:
            raise DrawingError("Brouillon impossible", 500) from e
        finally:
            _unlink_quiet(tmp)
        try:
            _prune_key(store, key)  # bounded: the latest + DRAFT_KEEP-1 dated snapshots
        except OSError:
            pass
    return {"ok": True, "key": key, "at": at}


def _draft_snapshot_name(key: str, at: int) -> str:
    return f"{key}.hqdraw.draft-{int(at)}.json"


def _draft_snapshots(store: Path, key: str) -> list[tuple[int, Path]]:
    """Dated copies of a draft, newest first. Only plain files: never a link or a reparse point."""
    prefix, suffix = key + ".hqdraw.draft-", ".json"
    out: list[tuple[int, Path]] = []
    try:
        names = os.listdir(store)
    except OSError:
        return out
    for name in names:
        if not (name.startswith(prefix) and name.endswith(suffix)):
            continue
        middle = name[len(prefix):-len(suffix)]
        if not middle.isdigit():
            continue
        path = store / name
        try:
            est = os.lstat(path)
        except OSError:
            continue
        if stat.S_ISREG(est.st_mode) and not _is_link_or_reparse(est):
            out.append((int(middle), path))
    out.sort(key=lambda x: x[0], reverse=True)
    return out


def _keep_previous(store: Path, key: str, latest: Path) -> None:
    """The draft being replaced becomes a dated snapshot, so a bad edit never destroys the only copy."""
    try:
        est = os.lstat(latest)
    except OSError:
        return
    if not stat.S_ISREG(est.st_mode) or _is_link_or_reparse(est):
        return
    try:
        at = int(json.loads(latest.read_text("utf-8")).get("at") or est.st_mtime)
    except (OSError, ValueError, TypeError, AttributeError):
        at = int(est.st_mtime)
    target = store / _draft_snapshot_name(key, at)
    if os.path.lexists(target):
        return
    os.replace(latest, target)


def _prune_key(store: Path, key: str) -> int:
    removed = 0
    for i, (_, path) in enumerate(_draft_snapshots(store, key)):
        if i < max(0, DRAFT_KEEP - 1):  # the latest draft counts as one of the kept copies
            continue
        _unlink_quiet(path)
        removed += 1
    return removed


def prune_drafts(root: Path, *, now=time.time) -> dict:
    """Bounded scratch storage: per stem the latest draft + DRAFT_KEEP-1 snapshots; snapshots older than
    DRAFT_TTL_DAYS (their write time) go, and a draft whose drawing was deleted goes with it. Never follows links.

    Cheap by design: it stats the folder, never parses a draft.
    """
    try:
        store = _drafts_dir(root, create=False)
    except DrawingError:
        return {"ok": True, "removed": 0}
    if store is None:
        return {"ok": True, "removed": 0}
    directory = drawings_dir(root, create=False)
    names: set[str] = set()
    if directory is not None:
        try:
            names = set(os.listdir(directory))
        except OSError:
            names = set()
    cutoff = now() - DRAFT_TTL_DAYS * 86400
    removed = 0
    keys: set[str] = set()
    snaps: dict[str, list[tuple[int, str]]] = {}  # per key, the dated copies seen in THIS pass (one listing, no rescans)
    try:
        entries = list(os.scandir(store))
    except OSError:
        return {"ok": True, "removed": 0}
    for entry in entries:
        name = entry.name
        ts = None
        if name.endswith(DRAFT_SUFFIX):
            key = name[: -len(DRAFT_SUFFIX)]
        else:
            m = re.match(r"^(.*)\.hqdraw\.draft-(\d+)\.json$", name)
            if not m:
                continue
            key, ts = m.group(1), int(m.group(2))
        if not re.match(r"^[A-Za-z0-9_-]{1,120}$", key):
            continue
        path = store / name
        try:
            est = entry.stat(follow_symlinks=False)  # already cached by scandir: no second syscall per file
        except OSError:
            try:
                est = os.lstat(path)
            except OSError:
                continue
        if not stat.S_ISREG(est.st_mode) or _is_link_or_reparse(est):
            continue
        # The write time, not the draft's content: a listing must not parse every draft (a full drawing document each
        # time, ~1 s for a thousand files). Each write sets it, and turning the previous draft into a snapshot is a
        # rename, which keeps the moment that content was written.
        written = float(est.st_mtime)
        orphan = key != "scratch" and directory is not None and (key + DOC_SUFFIX) not in names
        if orphan or written < cutoff:
            _unlink_quiet(path)
            removed += 1
        else:
            keys.add(key)
            if ts is not None:
                snaps.setdefault(key, []).append((ts, name))
    for key in keys:
        dated = sorted(snaps.get(key, ()), key=lambda item: item[0], reverse=True)
        for i, (_, name) in enumerate(dated):
            if i < max(0, DRAFT_KEEP - 1):  # the latest draft counts as one of the kept copies
                continue
            _unlink_quiet(store / name)
            removed += 1
    return {"ok": True, "removed": removed}


def clear_draft(root: Path, key) -> dict:
    """Forget the scratch copy of one key (called once the drawing is really saved)."""
    stem = str(key or "")
    name = (stem if STEM_RE.match(stem) else "scratch") + DRAFT_SUFFIX
    try:
        store = _drafts_dir(root, create=False)
    except DrawingError:
        return {"ok": True, "cleared": False}
    if store is None:
        return {"ok": True, "cleared": False}
    path = store / name
    try:
        est = os.lstat(path)
    except OSError:
        return {"ok": True, "cleared": False}
    if not stat.S_ISREG(est.st_mode) or _is_link_or_reparse(est):
        return {"ok": True, "cleared": False}
    _unlink_quiet(path)
    try:  # the dated snapshots of that key go with it: a saved drawing needs no scratch copy
        for _, snap in _draft_snapshots(store, stem if STEM_RE.match(stem) else "scratch"):
            _unlink_quiet(snap)
    except OSError:
        pass
    return {"ok": True, "cleared": True}


def duplicate_drawing(root: Path, stem, name=None, *, now=time.time) -> dict:
    """Save a copy of an existing drawing under a new immutable stem, with the same PNG and its lineage kept."""
    opened = open_drawing(root, stem)
    doc = opened["doc"]
    meta = doc.pop("meta", None) or {}
    directory = drawings_dir(root, create=False)
    if directory is None:
        raise DrawingError("Dessin introuvable", 404)
    png = _read_regular(directory, valid_stem(stem) + PNG_SUFFIX, MAX_PNG_BYTES)
    label = str(name or "").strip()[:MAX_NAME] or ((str(meta.get("name") or stem))[:MAX_NAME] + " copie")
    res = save_drawing(root, {
        "name": label,
        "source": "desktop",
        "doc": doc,
        "png": "data:image/png;base64," + base64.b64encode(png).decode("ascii"),
        "base": valid_stem(stem),
    }, now=now)
    res["name"] = label
    return res


PARENT_RE = re.compile(r'"parent"\s*:\s*"([A-Za-z0-9][A-Za-z0-9_-]{0,119})"')


def _doc_tail(directory: Path, name: str, cap: int = 2048) -> str:
    """The end of a saved document — `meta` is written last, so it is all a lineage needs (no full parse)."""
    path = directory / name
    try:
        st = os.lstat(path)
    except OSError:
        return ""
    if _is_link_or_reparse(st) or not stat.S_ISREG(st.st_mode) or st.st_size <= 0:
        return ""
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError:
        return ""
    try:
        size = os.fstat(fd).st_size
        os.lseek(fd, max(0, size - cap), os.SEEK_SET)
        raw = os.read(fd, cap)
    except OSError:
        return ""
    finally:
        os.close(fd)
    return raw.decode("utf-8", errors="ignore")


def lineage_of(tail: str) -> str:
    """The parent stem stored in the document's meta, read from its tail; "" when it has none."""
    at = tail.rfind('"meta"')
    if at < 0:
        return ""
    m = PARENT_RE.search(tail, at)
    return m.group(1) if m else ""


def _attach_lineage(directory: Path, items: list[dict]) -> None:
    """Add `parent` / `root` / `versions` to a library listing: each copy points at its source, and a family shares
    one root, so the list can say « version de … » without opening a single drawing."""
    by_stem = {it["stem"]: it for it in items}
    if len(items) < 2:
        return
    for it in items:
        parent = lineage_of(_doc_tail(directory, it["stem"] + DOC_SUFFIX))
        if parent and parent != it["stem"] and parent in by_stem:
            it["parent"] = parent
    roots: dict[str, str] = {}
    for it in items:
        seen = {it["stem"]}
        cur = it
        for _ in range(50):  # a hand-edited cycle must never hang the listing
            up = cur.get("parent")
            if not up or up in seen or up not in by_stem:
                break
            seen.add(up)
            cur = by_stem[up]
        roots[it["stem"]] = cur["stem"]
    counts: dict[str, int] = {}
    for root in roots.values():
        counts[root] = counts.get(root, 0) + 1
    for it in items:
        it["root"] = roots[it["stem"]]
        if counts[it["root"]] > 1:
            it["versions"] = counts[it["root"]]


def list_drawings(root: Path) -> dict:
    try:
        prune_drafts(root)  # no silent disk growth: old scratch copies and orphans go at every listing
    except Exception:  # pruning is housekeeping: it must never make the library fail to list
        pass
    directory = drawings_dir(root, create=False)
    items: list[dict] = []
    if directory is not None:
        with os.scandir(directory) as it:
            entries = list(it)
        names = set()
        for e in entries:  # companions count only if they are plain files (no links / reparse points)
            try:
                est = os.lstat(directory / e.name)
            except OSError:
                continue
            if stat.S_ISREG(est.st_mode) and not _is_link_or_reparse(est):
                names.add(e.name)
        for e in entries:
            if not e.name.endswith(DOC_SUFFIX) or e.name.startswith("."):
                continue
            stem = e.name[: -len(DOC_SUFFIX)]
            if not STEM_RE.match(stem):
                continue
            if e.name not in names:
                continue
            st = os.lstat(directory / e.name)
            items.append({
                "stem": stem,
                "mtime": int(st.st_mtime),
                "size": int(st.st_size),
                "png": (stem + PNG_SUFFIX) in names,
                "dxf": (stem + DXF_SUFFIX) in names,
                "stl": (stem + STL_SUFFIX) in names,
                "source": "Mobile" if stem.endswith("_HQWeb-Mobile") else ("Desktop" if stem.endswith("_HQWeb-Desktop") else ""),
            })
    if directory is not None:
        _attach_lineage(directory, items)
    items.sort(key=lambda x: (-x["mtime"], x["stem"]))
    return {"ok": True, "dir": "/".join(SUBDIR), "items": items[:LIST_MAX], "total": len(items)}


def underlay_assets(root: Path, stems) -> dict:
    """Carnet backup closure, ONE hop: the Stage-06 underlay asset of each referenced drawing.

    Read-only. ``ids``: asset ids found; ``missing``: drawings that do not exist (a broken reference is not an error);
    ``invalid``: drawings that exist but are unreadable / malformed / oversized (the caller fails closed). Stems are
    re-validated here and never joined to a path before that; nothing is followed recursively."""
    ids: set[str] = set()
    missing = invalid = 0
    for stem in sorted(set(stems)):
        try:
            opened = open_drawing(root, stem)
        except DrawingError as e:
            if e.status == 404:
                missing += 1
            else:
                invalid += 1
            continue
        except OSError:
            invalid += 1
            continue
        under = opened["doc"].get("underlay")
        if under:
            ids.add(under["asset_id"])
    return {"ids": ids, "missing": missing, "invalid": invalid}
