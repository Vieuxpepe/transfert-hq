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
import stat
import struct
import threading
import time
import unicodedata
from pathlib import Path

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


GEOMETRIC_CONSTRAINTS = ("horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "radius", "fixed")


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
    items = k.get("items")
    if not isinstance(items, list) or len(items) != 2:
        raise DrawingError(f"{kid} : deux éléments attendus")
    a, b = _id(items[0], kid), _id(items[1], kid)
    if a == b:
        raise DrawingError(f"{kid} : deux éléments distincts attendus")
    if kind in ("parallel", "perpendicular") and not ({a, b} <= lines):
        raise DrawingError(f"{kid} : deux lignes attendues")
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


def validate_document(doc) -> dict:
    """Validate + normalize a client document. Returns a clean copy (known keys only)."""
    if not isinstance(doc, dict):
        raise DrawingError("Document invalide")
    if doc.get("format") != FORMAT:
        raise DrawingError("Format de dessin inconnu")
    if doc.get("version") not in SUPPORTED_VERSIONS:
        raise DrawingError("Version de dessin non prise en charge")
    units = doc.get("units")
    if units not in UNITS:
        raise DrawingError("Unités invalides")
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
        sketches.append(entry)
    if v6:
        out["sketches"] = sketches
    sketch_ids = {sk["id"] for sk in sketches}

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
        group = o.get("group")
        if group is not None:
            item["group"] = _id(group, f"{oid} groupe")
        objects.append(item)
    out["objects"] = objects

    object_kinds = {o["id"]: o["type"] for o in objects}
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
        profile_kinds = ("line", "circle", "arc") if v6 else ("line", "circle")

        def profile_of(key="profile"):
            profile = f.get(key)
            if not isinstance(profile, list) or not 1 <= len(profile) <= 500:
                raise DrawingError(f"{fid} : profil invalide")
            profile = [_id(v, f"{fid} profil") for v in profile]
            if len(set(profile)) != len(profile) or any(object_types.get(v) not in profile_kinds for v in profile):
                raise DrawingError(f"{fid} : profil invalide")
            return profile

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
                out_profiles.append([str(v) for v in prof])
            item = {"id": fid, "type": kind, "profiles": out_profiles}
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
    if features or face_features or round_features:
        try:
            hq_solid.build_mesh(out)
        except hq_solid.SolidError as e:
            raise DrawingError(str(e), 422) from e
    return out


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

    def text(layer, x, y, h, s, rot=0.0):
        s = _dxf_text(s)
        if not s:
            return
        seen(x, y)
        codes = [(8, layer), (10, _f(x)), (20, _f(y)), (30, "0"), (40, _f(h)), (1, s)]
        if rot:
            codes.append((50, _f(rot)))
        ents.append(("TEXT", codes))

    for o in doc["objects"]:
        t = o["type"]
        if o.get("sketch"):
            continue  # DXF is the base XY drawing; sketches on other planes live in the 3D part (STEP)
        if t == "arc":
            cx, cy = pts[o["center"]]
            ax, ay = pts[o["p1"]]
            bx, by = pts[o["p2"]]
            r = math.hypot(ax - cx, ay - cy)
            seen(cx - r, cy - r)
            seen(cx + r, cy + r)
            start = math.degrees(math.atan2(ay - cy, ax - cx)) % 360
            end = math.degrees(math.atan2(by - cy, bx - cx)) % 360
            ents.append(("ARC", [(8, "GEOMETRIE"), (10, _f(cx)), (20, _f(cy)), (30, "0"), (40, _f(r)), (50, _f(start)), (51, _f(end))]))
            continue
        if t in ("line", "centerline"):
            line("GEOMETRIE" if t == "line" else "AXES", pts[o["p1"]], pts[o["p2"]])
        elif t == "circle":
            cx, cy = pts[o["center"]]
            r = o["r"]
            seen(cx - r, cy - r)
            seen(cx + r, cy + r)
            ents.append(("CIRCLE", [(8, "GEOMETRIE"), (10, _f(cx)), (20, _f(cy)), (30, "0"), (40, _f(r))]))
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


def list_drawings(root: Path) -> dict:
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
