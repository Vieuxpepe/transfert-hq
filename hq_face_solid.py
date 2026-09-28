"""Face-based additive and subtractive prisms for Dessiner v3 documents.

The existing stdlib 2.5D builder remains the source for legacy features.  A
face feature needs a real 3D Boolean; manifold3d is loaded only for documents
that contain one, so older sketches continue to work without the package.
"""

from __future__ import annotations

import math

MAX_FACE_FEATURES = 50
MAX_FACE_VERTICES = 500
MAX_TOTAL_FACE_VERTICES = 2048


def _fail(message):
    from hq_solid import SolidError
    raise SolidError(message)


def _triangle_mesh(manifold):
    mesh = manifold.to_mesh64()
    vertices = mesh.vert_properties
    return [tuple(tuple(float(v) for v in vertices[i, :3]) for i in tri)
            for tri in mesh.tri_verts]


def _to_manifold(triangles, m, np):
    # The legacy triangle soup duplicates coordinates. Weld by position before
    # passing it to Manifold, which requires a shared-index oriented surface.
    indices = {}
    faces = [[indices.setdefault(tuple(p), len(indices)) for p in tri] for tri in triangles]
    solid = m.Manifold(m.Mesh64(np.asarray(list(indices), dtype=np.float64),
                                np.asarray(faces, dtype=np.uint64)))
    if solid.is_empty():
        _fail("La pièce existante n'est pas un volume 3D fermé")
    return solid


def _prism(ring, plane, height, m):
    from hq_solid import _check_ring, _normal_ring
    _check_ring(ring)
    section = m.CrossSection([_normal_ring(ring, True)])
    if section.is_empty() or section.num_contour() != 1:
        _fail("Profil de face fermé et non croisé requis")
    solid = section.extrude(height)
    if solid.is_empty():
        _fail("Extrusion de face impossible")
    o, u, v, n = (plane[k] for k in ("origin", "u", "v", "normal"))
    return solid.transform(((u[0], v[0], n[0], o[0]),
                            (u[1], v[1], n[1], o[1]),
                            (u[2], v[2], n[2], o[2])))


def apply_face_features(base_triangles, features):
    if not features:
        return base_triangles
    try:
        import manifold3d as m
        import numpy as np
    except ImportError as exc:
        _fail("Fonctions sur face indisponibles : installer manifold3d==3.5.4")
    if not base_triangles:
        _fail("Crée d'abord une extrusion de base")
    if len(features) > MAX_FACE_FEATURES or sum(len(f["profile"]) for f in features) > MAX_TOTAL_FACE_VERTICES:
        _fail("Trop de fonctions ou de points sur les faces")
    solid = _to_manifold(base_triangles, m, np)
    for feature in features:
        ring, plane = feature["profile"], feature["plane"]
        if len(ring) < 3 or len(ring) > MAX_FACE_VERTICES:
            _fail("Profil de face invalide")
        depth = feature["depth"]
        if not (0 < depth <= 1e6):
            _fail("Profondeur de face invalide")
        # A thin inward prism tests that the entire selected profile actually
        # lies on the current solid. This rejects floating or outside sketches.
        bounds = solid.bounding_box()
        span = max(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2], 1)
        probe = min(depth * 0.01, span * 1e-4)
        inward = dict(plane)
        inward["normal"] = [-x for x in plane["normal"]]
        sheet = _prism(ring, inward, probe, m)
        contact = (solid ^ sheet).volume()
        if not math.isclose(contact, sheet.volume(), rel_tol=2e-3, abs_tol=1e-5):
            _fail("Le profil doit rester entièrement sur la face sélectionnée")
        previous = solid.volume()
        if feature["type"] == "extrude":
            tool = _prism(ring, plane, depth, m)
            updated = solid + tool
            gain = updated.volume() - previous
            if not math.isclose(gain, tool.volume(), rel_tol=2e-3, abs_tol=1e-5):
                _fail("L'extrusion recoupe une autre partie de la pièce")
        else:
            if feature["extent"] == "throughAll":
                depth = 4 * span + depth
            tool = _prism(ring, inward, depth, m)
            updated = solid - tool
            removed = previous - updated.volume()
            if feature["extent"] == "blind" and not math.isclose(removed, tool.volume(), rel_tol=2e-3, abs_tol=1e-5):
                _fail("La coupe aveugle dépasse la pièce ; utilise Traversant")
            if removed <= 1e-6:
                _fail("La coupe ne retire aucune matière")
        if updated.is_empty() or len(updated.decompose()) != 1:
            _fail("La fonction produit une pièce vide ou séparée")
        if updated.num_tri() > 200_000:
            _fail("Modèle trop complexe pour STL")
        solid = updated
    return _triangle_mesh(solid)
