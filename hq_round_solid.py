"""Selective radius fillets on bounded convex, straight mesh edges."""

from __future__ import annotations

import math


def _sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _unit(a):
    length = math.sqrt(_dot(a, a))
    return tuple(x / length for x in a) if length > 1e-10 else None


def _fail(message):
    from hq_solid import SolidError
    raise SolidError(message)


def eligible_edges(triangles):
    """Return convex creases with two adjacent, outward-oriented planar faces."""
    adjacency = {}
    for tri in triangles:
        a, b, c = (tuple(p) for p in tri)
        normal = _unit(_cross(_sub(b, a), _sub(c, a)))
        if normal is None:
            continue
        for start, end, third in ((a, b, c), (b, c, a), (c, a, b)):
            key = tuple(sorted((start, end)))
            adjacency.setdefault(key, []).append((normal, third))
    result = []
    for (a, b), neighbors in adjacency.items():
        if len(neighbors) != 2:
            continue
        (n1, q1), (n2, q2) = neighbors
        cos_angle = _dot(n1, n2)
        if not (-0.9659 < cos_angle < 0.9659):  # 15°..165° planar dihedral
            continue
        length = math.dist(a, b)
        if length <= 1e-6:
            continue
        # On a convex crease, each face extends away from the other face's
        # outward normal. The opposite sign denotes an internal/concave edge.
        limit = length * 1e-8
        if _dot(_sub(q1, a), n2) >= -limit or _dot(_sub(q2, a), n1) >= -limit:
            continue
        result.append({"a": a, "b": b, "normals": (n1, n2), "length": length})
    return result


def _find_edge(triangles, a, b):
    scale = max(math.dist(a, b), 1)
    for edge in eligible_edges(triangles):
        if ((math.dist(a, edge["a"]) < scale * 1e-7 and math.dist(b, edge["b"]) < scale * 1e-7) or
                (math.dist(a, edge["b"]) < scale * 1e-7 and math.dist(b, edge["a"]) < scale * 1e-7)):
            return edge
    _fail("Arête droite convexe introuvable sur la pièce actuelle")


def _fillet_tool(edge, radius, m):
    from hq_solid import _normal_ring
    a, b = edge["a"], edge["b"]
    n1, n2 = edge["normals"]
    t = _unit(_sub(b, a))
    cosine = _dot(n1, n2)
    sine = math.sqrt(max(0, 1 - cosine * cosine))
    center = tuple(-radius * (n1[i] + n2[i]) / (1 + cosine) for i in range(3))
    tangent1 = tuple(center[i] + radius * n1[i] for i in range(3))
    tangent2 = tuple(center[i] + radius * n2[i] for i in range(3))
    perp = tuple((n2[i] - cosine * n1[i]) / sine for i in range(3))
    steps = max(8, min(64, math.ceil(math.acos(cosine) / (math.pi / 48))))
    arc = [tuple(center[i] + radius * (math.cos(angle) * n1[i] + math.sin(angle) * perp[i]) for i in range(3))
           for angle in (math.acos(cosine) * k / steps for k in range(1, steps))]
    u = _unit(tuple(n1[i] + n2[i] for i in range(3)))
    v = _cross(t, u)
    world = [(0, 0, 0), tangent1, *arc, tangent2]
    ring = [[_dot(p, u), _dot(p, v)] for p in world]
    section = m.CrossSection([_normal_ring(ring, True)])
    if section.is_empty():
        _fail("Arrondi impossible pour cette arête")
    return section.extrude(edge["length"]).transform(((u[0], v[0], t[0], a[0]),
                                                      (u[1], v[1], t[1], a[1]),
                                                      (u[2], v[2], t[2], a[2])))


def apply_round_features(triangles, features):
    if not features:
        return triangles
    try:
        import manifold3d as m
        import numpy as np
    except (ImportError, OSError):
        _fail("Arrondis indisponibles : installer manifold3d==3.5.4")
    from hq_face_solid import _to_manifold, _triangle_mesh
    solid = _to_manifold(triangles, m, np)
    mesh = triangles
    for feature in features:
        edge = _find_edge(mesh, feature["a"], feature["b"])
        radius = feature["radius"]
        if not (1e-6 < radius < edge["length"]):
            _fail("Rayon d'arrondi hors limites pour cette arête")
        cutter = _fillet_tool(edge, radius, m)
        previous = solid.volume()
        updated = solid - cutter
        removed = previous - updated.volume()
        if (not math.isclose(removed, cutter.volume(), rel_tol=1e-5, abs_tol=1e-6) or
                updated.is_empty() or len(updated.decompose()) != 1):
            _fail("Rayon trop grand ou arête en conflit avec la pièce")
        if updated.num_tri() > 200_000:
            _fail("Modèle trop complexe pour STL")
        solid = updated
        mesh = _triangle_mesh(solid)
    return mesh
