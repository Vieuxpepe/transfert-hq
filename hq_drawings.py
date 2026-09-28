"""Transfert HQ — « Dessiner » sketch storage (stdlib only).

Saved drawings live in ROOT/Inbox/Drawings (same resolution as Inbox/Voice,
Inbox/Photos, …). The client never supplies a filesystem path: it sends a base
name, a coarse source hint, the vector document and a PNG preview. The server
sanitizes the name, validates and normalizes the document, renders the DXF
itself, and publishes <stem>.hqdraw.json / <stem>.png / <stem>.dxf without ever
overwriting an existing file (unique stem on collision).

Filesystem rules:
  * Inbox/Drawings must not be a symlink, junction or other reparse point and
    must resolve inside the resolved Inbox folder.
  * Listed/opened files must be regular files (lstat), never links/reparse.
  * Writes go to a hidden temp file in the same directory (O_EXCL, fsync) and
    are published with os.link (fails if the target exists) — atomic and
    never clobbering.

Document format (version 1) — kept ready for a future 3D step:
  stable object ids, explicit point table (lines/circles reference point ids,
  so connectivity is explicit), units, grid, driving constraints.
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

FORMAT = "transfert-hq-sketch"
VERSION = 1
SUBDIR = ("Inbox", "Drawings")
DOC_SUFFIX = ".hqdraw.json"
PNG_SUFFIX = ".png"
DXF_SUFFIX = ".dxf"

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


def validate_document(doc) -> dict:
    """Validate + normalize a client document. Returns a clean copy (known keys only)."""
    if not isinstance(doc, dict):
        raise DrawingError("Document invalide")
    if doc.get("format") != FORMAT:
        raise DrawingError("Format de dessin inconnu")
    if doc.get("version") != VERSION:
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
        "version": VERSION,
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
    if "nextId" in doc:
        out["nextId"] = int(_num(doc.get("nextId"), "nextId", lo=0, hi=1e9))

    ids: set[str] = set()

    def claim(i: str) -> str:
        if i in ids:
            raise DrawingError(f"Identifiant en double : {i}")
        ids.add(i)
        return i

    raw_points = doc.get("points") or []
    if not isinstance(raw_points, list) or len(raw_points) > MAX_POINTS:
        raise DrawingError("Points invalides ou trop nombreux", 413 if isinstance(raw_points, list) else 400)
    points = []
    point_ids: set[str] = set()
    for i, p in enumerate(raw_points):
        if not isinstance(p, dict):
            raise DrawingError(f"Point {i} invalide")
        pid = claim(_id(p.get("id"), f"point {i}"))
        point_ids.add(pid)
        points.append({"id": pid, "x": _num(p.get("x"), f"point {pid}"), "y": _num(p.get("y"), f"point {pid}")})
    out["points"] = points

    raw_objects = doc.get("objects") or []
    if not isinstance(raw_objects, list):
        raise DrawingError("Objets invalides")
    if len(raw_objects) > MAX_OBJECTS:
        raise DrawingError("Trop d'objets", 413)
    objects = []
    line_ends: dict[str, tuple[str, str]] = {}
    total_stroke = 0
    for i, o in enumerate(raw_objects):
        if not isinstance(o, dict):
            raise DrawingError(f"Objet {i} invalide")
        oid = claim(_id(o.get("id"), f"objet {i}"))
        kind = o.get("type")
        item: dict = {"id": oid, "type": kind}
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
        else:
            raise DrawingError(f"{kid} : type de contrainte inconnu")
    out["constraints"] = cons
    return out


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
        if t in ("line", "centerline"):
            line("GEOMETRIE" if t == "line" else "AXES", pts[o["p1"]], pts[o["p2"]])
        elif t == "circle":
            cx, cy = pts[o["center"]]
            r = o["r"]
            seen(cx - r, cy - r)
            seen(cx + r, cy + r)
            ents.append(("CIRCLE", [(8, "GEOMETRIE"), (10, _f(cx)), (20, _f(cy)), (30, "0"), (40, _f(r))]))
        elif t == "stroke":
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


def save_drawing(root: Path, payload: dict, *, now=time.time) -> dict:
    if not isinstance(payload, dict):
        raise DrawingError("Requête invalide")
    doc = validate_document(payload.get("doc"))
    png = decode_png(payload.get("png"))
    base = sanitize_base_name(payload.get("name"))
    suffix = source_suffix(payload.get("source"))
    saved_at = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now()))
    directory = drawings_dir(root, create=True)
    dxf_bytes = build_dxf(doc).encode("cp1252", errors="replace")

    with _SAVE_LOCK:
        temps: list[Path] = []
        try:
            png_tmp = _write_temp(directory, png)
            temps.append(png_tmp)
            dxf_tmp = _write_temp(directory, dxf_bytes)
            temps.append(dxf_tmp)
            for n in range(0, 1000):
                stem = f"{base}{'' if n == 0 else '-' + str(n + 1)}{suffix}"
                names = [stem + DOC_SUFFIX, stem + PNG_SUFFIX, stem + DXF_SUFFIX]
                if any(os.path.lexists(directory / nm) for nm in names):
                    continue
                doc_out = dict(doc)
                doc_out["meta"] = {
                    "stem": stem,
                    "name": base,
                    "source": suffix.lstrip("_"),
                    "saved_at": saved_at,
                    "files": {"png": names[1], "dxf": names[2]},
                }
                body = json.dumps(doc_out, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
                if len(body) > MAX_DOC_BYTES:
                    raise DrawingError("Document trop volumineux", 413)
                doc_tmp = _write_temp(directory, body)
                temps.append(doc_tmp)
                published: list[Path] = []
                try:
                    for tmp, nm in ((png_tmp, names[1]), (dxf_tmp, names[2]), (doc_tmp, names[0])):
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
                    "files": {k: rel_for(nm) for k, nm in zip(("json", "png", "dxf"), names)},
                }
            raise DrawingError("Trop de dessins portant ce nom", 409)
        finally:
            for t in temps:
                _unlink_quiet(t)


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
    return {"ok": True, "stem": stem, "doc": doc}


def read_file(root: Path, stem, kind: str) -> tuple[bytes, str, str]:
    stem = valid_stem(stem)
    suffix, ctype, cap = {
        "png": (PNG_SUFFIX, "image/png", MAX_PNG_BYTES),
        "dxf": (DXF_SUFFIX, "application/dxf", 16 * 1024 * 1024),
        "json": (DOC_SUFFIX, "application/json; charset=utf-8", MAX_DOC_BYTES),
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
                "source": "Mobile" if stem.endswith("_HQWeb-Mobile") else ("Desktop" if stem.endswith("_HQWeb-Desktop") else ""),
            })
    items.sort(key=lambda x: (-x["mtime"], x["stem"]))
    return {"ok": True, "dir": "/".join(SUBDIR), "items": items[:LIST_MAX], "total": len(items)}
