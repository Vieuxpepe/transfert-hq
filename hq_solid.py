"""Bounded 2.5D solid builder for Dessiner (no runtime dependencies).

One closed outer sketch profile is extruded from Z=0.  Further closed,
non-touching profiles can remove material from its top, blind or through all.
All geometry here is in document units; STL conversion to mm is separate.
"""

from __future__ import annotations

import math
import struct

from hq_earcut import earcut

MAX_FEATURES = 50
MAX_TRIANGLES = 200_000
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
    if n < 3 or abs(_area(ring)) <= EPS:
        raise SolidError("Profil fermé de surface non nulle requis")
    for i, (a, b) in enumerate(_edges(ring)):
        if math.dist(a, b) <= EPS:
            raise SolidError("Profil avec arête nulle")
        for j, (c, d) in enumerate(_edges(ring)):
            if j <= i or (j - i) == 1 or (i == 0 and j == n - 1):
                continue
            if _segments_touch(a, b, c, d):
                raise SolidError("Profil croisé ou auto-intersecté")


def _profile(doc, ids):
    if not isinstance(ids, list) or not ids or len(ids) > 500:
        raise SolidError("Sélectionne un contour fermé (lignes ou cercle)")
    if len(set(ids)) != len(ids):
        raise SolidError("Profil avec objets en double")
    objects = {o["id"]: o for o in doc["objects"]}
    points = {p["id"]: (p["x"], p["y"]) for p in doc["points"]}
    chosen = [objects.get(i) for i in ids]
    if any(o is None for o in chosen):
        raise SolidError("Profil avec objet supprimé")
    if len(chosen) == 1 and chosen[0]["type"] == "circle":
        o = chosen[0]
        cx, cy = points[o["center"]]
        ring = [(cx + o["r"] * math.cos(2 * math.pi * k / CIRCLE_STEPS),
                 cy + o["r"] * math.sin(2 * math.pi * k / CIRCLE_STEPS)) for k in range(CIRCLE_STEPS)]
        _check_ring(ring)
        return ring
    if any(o["type"] != "line" for o in chosen):
        raise SolidError("Seules les lignes de construction et les cercles forment un profil 3D")
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


def build_mesh(doc):
    """Return a triangle soup in document units; reject invalid/non-manifold plans."""
    features = doc.get("features") or []
    if not features:
        return []
    if len(features) > MAX_FEATURES or features[0].get("type") != "extrude" or any(f.get("type") != "cut" for f in features[1:]):
        raise SolidError("Une extrusion de base suivie de coupes est requise")
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
