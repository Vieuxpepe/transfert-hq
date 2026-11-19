"""Bounded legacy 2.5D builder for Dessiner (stdlib path).

One closed outer sketch profile is extruded from Z=0.  Further closed,
non-touching profiles can remove material from its top, blind or through all.
All geometry here is in document units; STL conversion to mm is separate.
Optional planar-face features use hq_face_solid and a pinned Boolean kernel.
"""

from __future__ import annotations

import math
import struct

from hq_earcut import earcut

MAX_FEATURES = 50
MAX_TRIANGLES = 200_000
MAX_PROFILE_EDGES = 500
MAX_TOTAL_EDGES = 2048
CIRCLE_STEPS = 96
EPS = 1e-8
UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}


class SolidError(ValueError):
    pass


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1])) / 2


def _on_segment(a, b, p):
    return abs(_cross(a, b, p)) <= EPS and min(a[0], b[0]) - EPS <= p[0] <= max(a[0], b[0]) + EPS and min(a[1], b[1]) - EPS <= p[1] <= max(a[1], b[1]) + EPS


def _segments_touch(a, b, c, d):
    o1, o2, o3, o4 = _cross(a, b, c), _cross(a, b, d), _cross(c, d, a), _cross(c, d, b)
    if (o1 > EPS and o2 < -EPS or o1 < -EPS and o2 > EPS) and (o3 > EPS and o4 < -EPS or o3 < -EPS and o4 > EPS):
        return True
    return any((_on_segment(a, b, c), _on_segment(a, b, d), _on_segment(c, d, a), _on_segment(c, d, b)))


def _edges(ring):
    return list(zip(ring, ring[1:] + ring[:1]))


def _point_inside(p, ring):
    inside = False
    x, y = p
    for a, b in _edges(ring):
        if _on_segment(a, b, p):
            return False
        if (a[1] > y) != (b[1] > y):
            ix = a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])
            if ix > x:
                inside = not inside
    return inside


def _check_ring(ring):
    n = len(ring)
    if n < 3 or not all(math.isfinite(x) and math.isfinite(y) for x, y in ring) or abs(_area(ring)) <= EPS:
        raise SolidError("Profil fermé de surface non nulle requis")
    for i, (a, b) in enumerate(_edges(ring)):
        if math.dist(a, b) <= EPS:
            raise SolidError("Profil avec arête nulle")
        for j, (c, d) in enumerate(_edges(ring)):
            if j <= i or (j - i) == 1 or (i == 0 and j == n - 1):
                continue
            if _segments_touch(a, b, c, d):
                raise SolidError("Profil croisé ou auto-intersecté")


def spline_polyline(pts, closed, steps: int = 12):
    """Catmull-Rom samples of a spline, matching hq-sketch-core.js `splineSamples` and the canvas curve.

    A closed curve includes its wrap span and does not repeat its first point; an open one ends on its last point.
    """
    pts = [(float(p[0]), float(p[1])) for p in (pts or [])]
    if len(pts) < 2:
        return []
    closed = bool(closed) and len(pts) >= 3
    n = len(pts)
    spans = n if closed else n - 1

    def at(i):
        return pts[i % n]

    out = []
    for i in range(spans):
        p1, p2 = at(i), at(i + 1)
        p0 = at(i - 1) if closed else (pts[i - 1] if i > 0 else p1)
        p3 = at(i + 2) if closed else (pts[i + 2] if i + 2 < n else p2)
        for k in range(max(1, int(steps))):
            t = k / max(1, int(steps))
            t2, t3 = t * t, t * t * t
            out.append((0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
                        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)))
    if not closed:
        out.append(pts[-1])
    return out


def ellipse_ring(cx, cy, rx, ry, steps: int = 96):
    return [(cx + rx * math.cos(2 * math.pi * k / steps), cy + ry * math.sin(2 * math.pi * k / steps)) for k in range(steps)]


def curve_kind(o):
    """Return 'ellipse' or 'spline' when o can form a closed profile alone, '' for any other object type.

    A malformed curve is refused here rather than at the mesher, so every caller (legacy, OCC, save validation)
    gives the same reason.
    """
    kind = o.get("type")
    if kind == "ellipse":
        rx, ry = o.get("rx"), o.get("ry")
        if not (isinstance(rx, (int, float)) and isinstance(ry, (int, float))
                and math.isfinite(rx) and math.isfinite(ry) and rx > 0 and ry > 0):
            raise SolidError("Ellipse invalide")
        return "ellipse"
    if kind == "spline":
        pts = o.get("pts")
        if not o.get("closed"):
            raise SolidError("Une spline ouverte ne forme pas un profil fermé")
        if not isinstance(pts, list) or len(pts) < 3:
            raise SolidError("Une spline fermée demande au moins trois points")
        return "spline"
    return ""


def _profile(doc, ids):
    if not isinstance(ids, list) or not ids or len(ids) > MAX_PROFILE_EDGES:
        raise SolidError("Sélectionne un contour fermé (lignes, cercle, ellipse ou spline fermée)")
    if len(set(ids)) != len(ids):
        raise SolidError("Profil avec objets en double")
    objects = {o["id"]: o for o in doc["objects"]}
    points = {p["id"]: (p["x"], p["y"]) for p in doc["points"]}
    chosen = [objects.get(i) for i in ids]
    if any(o is None for o in chosen):
        raise SolidError("Profil avec objet supprimé")
    if any(o.get("construction") for o in chosen):
        raise SolidError("La géométrie de construction ne forme pas un profil 3D")
    kinds = [curve_kind(o) for o in chosen]
    if len(chosen) == 1 and chosen[0]["type"] == "circle":
        o = chosen[0]
        if not (o.get("r", 0) > 0):
            raise SolidError("Cercle invalide")
        cx, cy = points[o["center"]]
        ring = ellipse_ring(cx, cy, o["r"], o["r"], CIRCLE_STEPS)
        _check_ring(ring)
        return ring
    if any(kinds):
        if len(chosen) != 1:
            raise SolidError("Une ellipse ou une spline fermée forme seule son contour")
        o = chosen[0]
        if kinds[0] == "ellipse":
            cx, cy = points[o["center"]]
            ring = ellipse_ring(cx, cy, o["rx"], o["ry"])
        else:
            ring = spline_polyline([points[i] for i in o["pts"]], True)
        _check_ring(ring)
        return ring
    if any(o["type"] != "line" for o in chosen):
        raise SolidError("Seules les lignes forment un profil 3D (un cercle, une ellipse ou une spline fermée suffit)")
    graph = {}
    for o in chosen:
        a, b = o["p1"], o["p2"]
        graph.setdefault(a, []).append(b)
        graph.setdefault(b, []).append(a)
    if len(graph) != len(chosen) or any(len(v) != 2 for v in graph.values()):
        raise SolidError("Contour ouvert ou ramifié : accroche les extrémités")
    start = min(graph)
    order = [start]
    prev = None
    cur = start
    while True:
        nxt = next(v for v in graph[cur] if v != prev)
        if nxt == start:
            break
        if nxt in order:
            raise SolidError("Profil cyclique invalide")
        order.append(nxt)
        prev, cur = cur, nxt
    if len(order) != len(graph):
        raise SolidError("Sélectionne un seul contour fermé")
    ring = [points[i] for i in order]
    _check_ring(ring)
    return ring


def _normal_ring(ring, ccw):
    return ring if (_area(ring) > 0) == ccw else list(reversed(ring))


def _non_touching_inside(inner, outer):
    if not all(_point_inside(p, outer) for p in inner):
        return False
    return not any(_segments_touch(a, b, c, d) for a, b in _edges(inner) for c, d in _edges(outer))


def _non_overlapping(a, b):
    if _point_inside(a[0], b) or _point_inside(b[0], a):
        return False
    return not any(_segments_touch(p, q, r, s) for p, q in _edges(a) for r, s in _edges(b))


def _triangulate(outer, holes):
    rings = [_normal_ring(outer, True)] + [_normal_ring(h, False) for h in holes]
    vertices = [p for ring in rings for p in ring]
    data = [v for p in vertices for v in p]
    starts = []
    offset = len(rings[0])
    for ring in rings[1:]:
        starts.append(offset)
        offset += len(ring)
    indices = earcut(data, starts or None, 2)
    target = abs(_area(rings[0])) - sum(abs(_area(r)) for r in rings[1:])
    got = sum(abs(_cross(vertices[indices[i]], vertices[indices[i + 1]], vertices[indices[i + 2]])) / 2 for i in range(0, len(indices), 3))
    if not indices or abs(got - target) > 1e-5 * max(1, target):
        raise SolidError("Triangulation du profil impossible")
    return vertices, indices


def _cap(mesh, outer, holes, z, up):
    verts, indices = _triangulate(outer, holes)
    for i in range(0, len(indices), 3):
        a, b, c = (verts[indices[i + j]] for j in range(3))
        if abs(_cross(a, b, c)) <= EPS:
            continue
        if (_cross(a, b, c) > 0) != up:
            b, c = c, b
        mesh.append(((a[0], a[1], z), (b[0], b[1], z), (c[0], c[1], z)))


def _walls(mesh, ring, lo, hi):
    for a, b in _edges(ring):
        a0, b0, a1, b1 = (a[0], a[1], lo), (b[0], b[1], lo), (a[0], a[1], hi), (b[0], b[1], hi)
        mesh.append((a0, b0, b1))
        mesh.append((a0, b1, a1))


def _build_legacy_mesh(doc):
    """Return a triangle soup in document units; reject invalid/non-manifold plans."""
    features = doc.get("features") or []
    if not features:
        return []
    if len(features) > MAX_FEATURES or features[0].get("type") != "extrude" or any(f.get("type") != "cut" for f in features[1:]):
        raise SolidError("Une extrusion de base suivie de coupes est requise")
    types = {o["id"]: o["type"] for o in doc["objects"]}
    complexity = sum(CIRCLE_STEPS if types.get(oid) == "circle" else 1 for f in features for oid in f["profile"])
    if complexity > MAX_TOTAL_EDGES:
        raise SolidError("Trop de segments pour le calcul 3D")
    base = features[0]
    height = base["depth"]
    if not (height > 0):
        raise SolidError("Profondeur d'extrusion invalide")
    outer = _normal_ring(_profile(doc, base["profile"]), True)
    cuts = []
    for f in features[1:]:
        ring = _normal_ring(_profile(doc, f["profile"]), False)
        if not _non_touching_inside(ring, outer):
            raise SolidError("La coupe doit rester strictement dans la pièce")
        if any(not _non_overlapping(ring, c["ring"]) for c in cuts):
            raise SolidError("Les coupes ne doivent pas se toucher ou se recouvrir")
        through = f.get("extent") == "throughAll"
        depth = height if through else f["depth"]
        if not (0 < depth <= height):
            raise SolidError("Profondeur de coupe hors de la pièce")
        cuts.append({"ring": ring, "floor": 0 if through else height - depth, "through": through or abs(height - depth) <= EPS})
    mesh = []
    _cap(mesh, outer, [c["ring"] for c in cuts], height, True)
    _cap(mesh, outer, [c["ring"] for c in cuts if c["through"]], 0, False)
    _walls(mesh, outer, 0, height)
    for c in cuts:
        _walls(mesh, c["ring"], c["floor"], height)
        if not c["through"]:
            _cap(mesh, _normal_ring(c["ring"], True), [], c["floor"], True)
    if len(mesh) > MAX_TRIANGLES:
        raise SolidError("Modèle trop complexe pour STL")
    return mesh


def build_mesh(doc):
    """Build the part (legacy extrusion + cuts, or v5 features on the Boolean kernel), then optional face features
    and fillets."""
    import hq_solid_ops
    import hq_solid_occ
    if hq_solid_occ.uses_occ(doc):  # version 6: one exact solid (it rebuilds face features and fillets itself)
        return hq_solid_occ.build(doc)
    mesh = hq_solid_ops.build(doc) if hq_solid_ops.uses_v5(doc) else _build_legacy_mesh(doc)
    face_features = doc.get("faceFeatures") or []
    if face_features:
        from hq_face_solid import apply_face_features
        mesh = apply_face_features(mesh, face_features)
    round_features = doc.get("roundFeatures") or []
    if round_features:
        from hq_round_solid import apply_round_features
        mesh = apply_round_features(mesh, round_features)
    return mesh


def binary_stl(mesh, units):
    """Binary STL has no unit field. Coordinates are always converted to mm."""
    scale = UNIT_MM[units]
    body = bytearray(b"Transfert HQ Dessiner | millimetres".ljust(80, b"\0"))
    body += struct.pack("<I", len(mesh))
    for tri in mesh:
        a, b, c = [tuple(v * scale for v in p) for p in tri]
        u = tuple(b[i] - a[i] for i in range(3))
        v = tuple(c[i] - a[i] for i in range(3))
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        ln = math.sqrt(sum(x * x for x in n))
        if ln <= EPS:
            raise SolidError("Triangle STL dégénéré")
        body += struct.pack("<12fH", *(x / ln for x in n), *a, *b, *c, 0)
    return bytes(body)
