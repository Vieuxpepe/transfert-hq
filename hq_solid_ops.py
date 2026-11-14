"""Dessiner v5 solid features on the pinned Boolean kernel (manifold3d), in document units.

The legacy stdlib builder (hq_solid) keeps building every drawing whose features are an extrusion followed by cuts,
exactly as before. A drawing that uses any v5 feature is built here instead, feature after feature:

  base    extrude  closed profile, height ``depth`` from Z=0
          revolve  closed profile turned ``angle`` degrees around a sketch line (``axis``); the part lies along that
                   line in the sketch plane and is raised so it rests on Z=0, so sketch X/Y keep their meaning
  then    cut      closed profile removed from the top down (blind ``depth`` or through all)
          hole     standard metric hole at each selected circle's centre, drilled from the top down
          shell    the base profile hollowed by ``thickness`` (extrusions: open at the top or closed; revolves: closed)
          pattern  copies of an earlier cut or hole, linear (dx, dy per step) or circular (around cx, cy)

Every subtractive step must remove material and leave one piece; refusals are SolidError with a French message.
"""

from __future__ import annotations

import math

# Load the Boolean kernel once, at import, on the importing (main) thread. On Windows a first import of numpy's
# compiled core inside a request thread can stall while other request threads start subprocesses; the bridge then
# stops answering. Absent packages are fine: the v5, face and fillet features report a clear error instead.
try:  # pragma: no cover - depends on the optional runtime packages
    import numpy as _np_preload  # noqa: F401
    import manifold3d as _m_preload  # noqa: F401
except (ImportError, OSError):
    pass

MAX_COPIES = 50
HOLE_SEGMENTS = 48
REVOLVE_SEGMENTS = 96
V5_TYPES = ("revolve", "hole", "shell", "pattern")

# ISO metric holes, mm. Clearance: ISO 273 medium. Tap drill: coarse thread. Countersunk head: ISO 10642 dk.
# Heat-set insert: the usual 3D-printing brass insert hole (diameter, depth).
HOLES_MM = {
    "M2": {"clearance": 2.4, "tap": 1.6, "head": 4.4, "insert": (3.2, 4.0)},
    "M2.5": {"clearance": 2.9, "tap": 2.05, "head": 5.5, "insert": (3.6, 5.0)},
    "M3": {"clearance": 3.4, "tap": 2.5, "head": 6.72, "insert": (4.0, 5.7)},
    "M4": {"clearance": 4.5, "tap": 3.3, "head": 8.96, "insert": (5.6, 8.1)},
    "M5": {"clearance": 5.5, "tap": 4.2, "head": 11.2, "insert": (6.4, 9.5)},
    "M6": {"clearance": 6.6, "tap": 5.0, "head": 13.44, "insert": (8.0, 12.7)},
    "M8": {"clearance": 9.0, "tap": 6.8, "head": 17.92, "insert": (10.0, 12.7)},
}
FITS = ("clearance", "countersunk", "insert", "tap")
UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}


def _fail(message):
    from hq_solid import SolidError
    raise SolidError(message)


def uses_v5(doc) -> bool:
    return any((f.get("type") in V5_TYPES) for f in doc.get("features") or [])


def hole_geometry(standard: str, fit: str, units: str) -> dict:
    """Hole dimensions in document units: radius, plus head radius (countersunk) or depth (insert)."""
    row = HOLES_MM.get(standard)
    if row is None or fit not in FITS:
        _fail("Trou inconnu")
    k = 1.0 / UNIT_MM.get(units, 1.0)
    if fit == "insert":
        d, depth = row["insert"]
        return {"r": d / 2 * k, "insert_depth": depth * k}
    if fit == "tap":
        return {"r": row["tap"] / 2 * k}
    out = {"r": row["clearance"] / 2 * k}
    if fit == "countersunk":
        out["head_r"] = row["head"] / 2 * k
    return out


def _kernel():
    try:
        import manifold3d as m
        import numpy as np
    except (ImportError, OSError):
        _fail("Fonctions 3D avancées indisponibles : installer manifold3d==3.5.4")
    return m, np


def _section(ring, m):
    from hq_solid import _normal_ring
    section = m.CrossSection([_normal_ring(list(ring), True)])
    if section.is_empty():
        _fail("Profil fermé et non croisé requis")
    return section


def _base(doc, feature, m):
    from hq_solid import _profile
    ring = _profile(doc, feature["profile"])
    if feature["type"] == "extrude":
        solid = _section(ring, m).extrude(feature["depth"])
        return solid, {"ring": ring, "kind": "extrude", "height": feature["depth"]}
    # revolve around a sketch line
    points = {p["id"]: (p["x"], p["y"]) for p in doc["points"]}
    axis = next((o for o in doc["objects"] if o["id"] == feature["axis"]), None)
    if axis is None or axis.get("type") not in ("line", "centerline"):
        _fail("Axe de révolution introuvable")
    if feature["axis"] in feature["profile"]:
        _fail("L'axe ne fait pas partie du profil")
    a, b = points[axis["p1"]], points[axis["p2"]]
    length = math.dist(a, b)
    if length <= 1e-9:
        _fail("Axe de révolution nul")
    ux, uy = (b[0] - a[0]) / length, (b[1] - a[1]) / length
    nx, ny = -uy, ux
    local = [((p[0] - a[0]) * nx + (p[1] - a[1]) * ny, (p[0] - a[0]) * ux + (p[1] - a[1]) * uy) for p in ring]
    span = max(abs(r) for r, _h in local) or 1.0
    if all(r >= -1e-9 * span for r, _h in local):
        pass
    elif all(r <= 1e-9 * span for r, _h in local):
        local = [(-r, -h) for r, h in local]  # same as turning the axis around: the profile is on the other side
        ux, uy, nx, ny = -ux, -uy, -nx, -ny
    else:
        _fail("Le profil doit rester d'un seul côté de l'axe")
    local = [(max(0.0, r), h) for r, h in local]
    angle = feature.get("angle", 360)
    solid = _section(local, m).revolve(REVOLVE_SEGMENTS, angle)
    if solid.is_empty():
        _fail("Révolution impossible")
    # local (x = radial, y = around, z = along the axis) -> world (n, up, u) placed on the axis' first point
    solid = solid.transform(((nx, 0.0, ux, a[0]), (ny, 0.0, uy, a[1]), (0.0, 1.0, 0.0, 0.0)))
    box = solid.bounding_box()
    solid = solid.translate((0.0, 0.0, -box[2]))  # rest on the table
    return solid, {"kind": "revolve", "local": local, "frame": (a, (ux, uy), (nx, ny)), "angle": angle, "lift": -box[2]}


def _top_bottom(solid):
    box = solid.bounding_box()
    return box[5], box[2], max(box[3] - box[0], box[4] - box[1], box[5] - box[2], 1e-6)


def _cut_tool(doc, feature, solid, m):
    from hq_solid import _profile
    ring = _profile(doc, feature["profile"])
    top, bottom, span = _top_bottom(solid)
    section = _section(ring, m)
    if feature.get("extent") == "throughAll":
        return section.extrude(top - bottom + 2 * span).translate((0.0, 0.0, bottom - span))
    depth = feature["depth"]
    if not (0 < depth <= top - bottom + 1e-9):
        _fail("Profondeur de coupe hors de la pièce")
    return section.extrude(depth + span).translate((0.0, 0.0, top - depth))


def _hole_centers(doc, feature):
    points = {p["id"]: (p["x"], p["y"]) for p in doc["points"]}
    objects = {o["id"]: o for o in doc["objects"]}
    out = []
    for oid in feature["at"]:
        o = objects.get(oid)
        if o is None or o.get("type") != "circle":
            _fail("Un trou se place au centre d'un cercle du croquis")
        out.append(points[o["center"]])
    return out


def _hole_tool(doc, feature, solid, m):
    geo = hole_geometry(feature["standard"], feature["fit"], doc["units"])
    top, bottom, span = _top_bottom(solid)
    r = geo["r"]
    through = feature.get("extent") == "throughAll"
    depth = geo.get("insert_depth") if feature["fit"] == "insert" and not feature.get("depth") else feature.get("depth")
    if through:
        lo, hi = bottom - span, top + span
    else:
        if not (depth and 0 < depth <= top - bottom + 1e-9):
            _fail("Profondeur de trou hors de la pièce")
        lo, hi = top - depth, top + span
    tools = []
    for cx, cy in _hole_centers(doc, feature):
        tool = m.Manifold.cylinder(hi - lo, r, r, HOLE_SEGMENTS).translate((cx, cy, lo))
        if "head_r" in geo:  # 90° countersink: a cone from the head diameter at the top surface down to the hole
            sink = geo["head_r"] - r
            cone = m.Manifold.cylinder(sink, r, geo["head_r"], HOLE_SEGMENTS).translate((cx, cy, top - sink))
            cap = m.Manifold.cylinder(span, geo["head_r"], geo["head_r"], HOLE_SEGMENTS).translate((cx, cy, top))
            tool = tool + cone + cap
        tools.append(tool)
    return m.Manifold.batch_boolean(tools, m.OpType.Add) if len(tools) > 1 else tools[0]


def _shell_tool(base_info, feature, solid, m):
    t = feature["thickness"]
    if not (t > 0):
        _fail("Épaisseur de coque invalide")
    if base_info["kind"] == "extrude":
        inner = _section(base_info["ring"], m).offset(-t, m.JoinType.Miter)
        if inner.is_empty() or inner.area() <= 0:
            _fail("Coque trop épaisse pour cette pièce")
        height = base_info["height"]
        if feature.get("open", True):
            if not (t < height):
                _fail("Coque trop épaisse pour cette pièce")
            return inner.extrude(height).translate((0.0, 0.0, t))
        if not (2 * t < height):
            _fail("Coque trop épaisse pour cette pièce")
        return inner.extrude(height - 2 * t).translate((0.0, 0.0, t))
    if feature.get("open", True):
        _fail("Une pièce tournée s'évide fermée : décoche « Ouverte en haut »")
    # the whole cross-section (half-profile and its mirror) shrinks inward, then its positive half is turned: the
    # cavity reaches the axis, like the inside of a bottle
    half = [(max(0.0, r), h) for r, h in base_info["local"]]
    full = _section(half, m) + _section([(-r, h) for r, h in half], m)
    shrunk = full.offset(-t, m.JoinType.Miter)
    hs = [h for _r, h in half]
    reach = max(r for r, _h in half) + t + 1.0
    keep = m.CrossSection.square((reach, max(hs) - min(hs) + 2 * t + 2.0)).translate((0.0, min(hs) - t - 1.0))
    inner = shrunk ^ keep
    if inner.is_empty() or inner.area() <= 0:
        _fail("Coque trop épaisse pour cette pièce")
    tool = inner.revolve(REVOLVE_SEGMENTS, base_info["angle"])
    (ax, ay), (ux, uy), (nx, ny) = base_info["frame"]
    return tool.transform(((nx, 0.0, ux, ax), (ny, 0.0, uy, ay), (0.0, 1.0, 0.0, base_info["lift"])))


def _pattern_copies(tool, feature, m):
    count = feature["count"]
    copies = []
    if feature["mode"] == "linear":
        for i in range(1, count):
            copies.append(tool.translate((feature["dx"] * i, feature["dy"] * i, 0.0)))
    else:
        total = feature.get("angle", 360)
        step = total / count if abs(total - 360) < 1e-9 else total / (count - 1)
        cx, cy = feature["cx"], feature["cy"]
        for i in range(1, count):
            copies.append(tool.translate((-cx, -cy, 0.0)).rotate((0.0, 0.0, step * i)).translate((cx, cy, 0.0)))
    return copies


def _subtract(solid, tool, what):
    previous = solid.volume()
    updated = solid - tool
    if previous - updated.volume() <= 1e-9 * max(1.0, previous):
        _fail(what + " ne retire aucune matière")
    # a closed shell leaves an inner void: count solid pieces only (a void's surface encloses negative volume)
    if updated.is_empty() or sum(1 for piece in updated.decompose() if piece.volume() > 1e-12) != 1:
        _fail(what + " coupe la pièce en morceaux")
    if updated.num_tri() > 200_000:
        _fail("Modèle trop complexe pour STL")
    return updated


def build(doc):
    """Triangle soup (document units) for a drawing whose features use v5 types."""
    from hq_face_solid import _triangle_mesh
    m, _np = _kernel()
    features = doc.get("features") or []
    if not features or features[0]["type"] not in ("extrude", "revolve"):
        _fail("Une extrusion ou une révolution de base est requise")
    solid, info = _base(doc, features[0], m)
    if solid.is_empty() or solid.volume() <= 0:
        _fail("La pièce de base est vide")
    tools = {}
    shells = 0
    for f in features[1:]:
        kind = f["type"]
        if kind == "cut":
            tool = _cut_tool(doc, f, solid, m)
            solid = _subtract(solid, tool, "La coupe")
        elif kind == "hole":
            tool = _hole_tool(doc, f, solid, m)
            solid = _subtract(solid, tool, "Le perçage")
        elif kind == "shell":
            shells += 1
            if shells > 1:
                _fail("Une seule coque par pièce")
            tool = _shell_tool(info, f, solid, m)
            solid = _subtract(solid, tool, "La coque")
        elif kind == "pattern":
            source = tools.get(f["source"])
            if source is None:
                _fail("La répétition doit reprendre une coupe ou un trou placé avant elle")
            copies = _pattern_copies(source, f, m)
            tool = m.Manifold.batch_boolean(copies, m.OpType.Add) if len(copies) > 1 else copies[0]
            solid = _subtract(solid, tool, "La répétition")
        else:
            _fail("Fonction 3D inconnue")
        tools[f["id"]] = tool
    return _triangle_mesh(solid)
