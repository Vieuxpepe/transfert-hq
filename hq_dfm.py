"""Manufacturing checks for an exact Dessiner part.

Everything here reads the OpenCascade tetrahedral surface (the same triangle soup the STL and the
3D view use), never a second approximation:

* minimum wall: inward rays from triangle centroids to the opposite surface;
* fastener holes: the hole feature's standard/fit checked against hq_solid_ops.HOLES_MM, plus the
  material left between each hole and the outside contour;
* print orientation: downward-facing area, bridges and whether support is needed.

A thin wall or an undersized clearance hole makes ``ok`` false. Support is reported separately: a
part that needs support is still printable, it just is not support-free.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any, Iterable

import hq_solid_ops

DEFAULT_MIN_WALL_MM = 1.2
DEFAULT_OVERHANG_DEG = 45.0
ORIENTATIONS = {"Z": (0.0, 0.0, 1.0), "X": (1.0, 0.0, 0.0), "Y": (0.0, 1.0, 0.0)}


class DfmError(ValueError):
    pass


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(a):
    return math.sqrt(_dot(a, a))


def _normal(tri):
    n = _cross(_sub(tri[1], tri[0]), _sub(tri[2], tri[0]))
    length = _norm(n)
    return (0.0, 0.0, 0.0) if length <= 1e-15 else (n[0] / length, n[1] / length, n[2] / length)


def _area(tri):
    return _norm(_cross(_sub(tri[1], tri[0]), _sub(tri[2], tri[0]))) * 0.5


def _edges(mesh) -> Counter:
    counts: Counter = Counter()
    for tri in mesh:
        keys = [tuple(round(float(c), 6) for c in p) for p in tri]
        for a, b in ((keys[0], keys[1]), (keys[1], keys[2]), (keys[2], keys[0])):
            counts[tuple(sorted((a, b)))] += 1
    return counts


def watertight(mesh) -> bool:
    if not mesh:
        return False
    counts = _edges(mesh)
    return bool(counts) and all(n == 2 for n in counts.values())


def _ray_hit(origin, direction, tri, skip):
    """Möller–Trumbore: nearest positive distance from origin to tri, or None."""
    e1 = _sub(tri[1], tri[0])
    e2 = _sub(tri[2], tri[0])
    p = _cross(direction, e2)
    det = _dot(e1, p)
    if abs(det) < 1e-12:
        return None
    inv = 1.0 / det
    tvec = _sub(origin, tri[0])
    u = _dot(tvec, p) * inv
    if u < -1e-9 or u > 1 + 1e-9:
        return None
    q = _cross(tvec, e1)
    v = _dot(direction, q) * inv
    if v < -1e-9 or u + v > 1 + 1e-9:
        return None
    t = _dot(e2, q) * inv
    if t <= skip:
        return None
    return t


def _wall_samples(mesh, span, limit=900):
    """Thickness at up to ``limit`` triangle centroids: the inward ray's first exit distance."""
    tris = [(tri, _normal(tri), _area(tri)) for tri in mesh]
    tris = [row for row in tris if row[2] > 1e-12]
    if not tris:
        return []
    # Large faces carry most of the surface: sampling by decreasing area follows the part, not mesh noise.
    tris.sort(key=lambda row: row[2], reverse=True)
    stride = max(1, len(tris) // limit)
    chosen = tris[::stride][:limit]
    eps = max(1e-7, span * 1e-7)
    skip = eps * 2
    values = []
    for tri, n, area in chosen:
        centroid = ((tri[0][0] + tri[1][0] + tri[2][0]) / 3,
                    (tri[0][1] + tri[1][1] + tri[2][1]) / 3,
                    (tri[0][2] + tri[1][2] + tri[2][2]) / 3)
        origin = (centroid[0] - n[0] * eps, centroid[1] - n[1] * eps, centroid[2] - n[2] * eps)
        direction = (-n[0], -n[1], -n[2])
        nearest = None
        for other in mesh:
            t = _ray_hit(origin, direction, other, skip)
            if t is not None and (nearest is None or t < nearest):
                nearest = t
        values.append((nearest if nearest is not None else 0.0) + eps)
    return values


def _quantile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(math.ceil(q * len(ordered))) - 1))
    return ordered[idx]


def _expected_hole_mm(row: dict, fit: str) -> float:
    if fit == "clearance" or fit == "countersunk":
        return float(row["clearance"])
    if fit == "tap":
        return float(row["tap"])
    if fit == "insert":
        return float(row["insert"][0])
    raise DfmError("Trou inconnu")


def _hole_checks(doc: dict, mesh, bounds, scale: float, min_wall_mm: float, required_fit: str | None):
    objects = {o["id"]: o for o in doc.get("objects") or []}
    points = {p["id"]: p for p in doc.get("points") or []}
    x0, y0, _z0, x1, y1, _z1 = bounds
    checks = []
    centres = []
    ok = True
    for feature in doc.get("features") or []:
        if feature.get("type") != "hole":
            continue
        standard, fit = feature.get("standard"), feature.get("fit")
        row = hq_solid_ops.HOLES_MM.get(standard)
        if row is None or fit not in hq_solid_ops.FITS:
            checks.append({"id": feature.get("id"), "pass": False, "error": "Trou hors norme"})
            ok = False
            continue
        geo = hq_solid_ops.hole_geometry(standard, fit, doc.get("units") or "mm")
        actual_mm = 2 * float(geo["r"]) * scale
        expected_mm = _expected_hole_mm(row, fit)
        diameter_ok = abs(actual_mm - expected_mm) <= 0.05
        fit_ok = required_fit is None or fit == required_fit
        edge_margin = None
        for cid in feature.get("at") or []:
            obj = objects.get(cid)
            if not obj or obj.get("sketch"):
                continue
            centre = points.get(obj.get("center"))
            if not centre:
                continue
            r = float(obj.get("r") or 0.0)
            centres.append((float(centre["x"]), float(centre["y"]), r))
            margin = min(centre["x"] - x0, x1 - centre["x"], centre["y"] - y0, y1 - centre["y"]) - r
            margin_mm = margin * scale
            edge_margin = margin_mm if edge_margin is None else min(edge_margin, margin_mm)
        margin_ok = edge_margin is None or edge_margin >= min_wall_mm - 1e-6
        passed = diameter_ok and fit_ok and margin_ok
        ok = ok and passed
        checks.append({
            "id": feature.get("id"),
            "standard": standard,
            "fit": fit,
            "actual_diameter_mm": round(actual_mm, 3),
            "expected_diameter_mm": round(expected_mm, 3),
            "clearance_diameter_mm": float(row["clearance"]),
            "edge_margin_mm": None if edge_margin is None else round(edge_margin, 3),
            "pass": passed,
            "reason": "" if passed else (
                "diamètre hors norme" if not diameter_ok else
                "ajustement différent de celui demandé" if not fit_ok else
                "matière insuffisante entre le trou et le bord"),
        })
    ligament = None
    for i, (ax, ay, ar) in enumerate(centres):
        for bx, by, br in centres[i + 1:]:
            gap = (math.hypot(ax - bx, ay - by) - ar - br) * scale
            ligament = gap if ligament is None else min(ligament, gap)
    ligament_ok = ligament is None or ligament >= min_wall_mm - 1e-6
    if checks:  # hole-to-hole ligaments are part of the minimum wall too
        for row in checks:
            row["minimum_ligament_mm"] = None if ligament is None else round(ligament, 3)
            if row["pass"] and not ligament_ok:
                row["pass"] = False
                row["reason"] = "matière insuffisante entre deux trous"
        ok = ok and ligament_ok
    return {
        "ok": ok,
        "required_fit": required_fit,
        "holes": checks,
        "minimum_ligament_mm": None if ligament is None else round(ligament, 3),
        "ligament_ok": ligament_ok,
        "count": sum(len(f.get("at") or []) for f in doc.get("features") or [] if f.get("type") == "hole"),
    }


def _overhang_checks(mesh, scale: float, orientation: str, threshold_deg: float):
    axis = ORIENTATIONS.get(str(orientation or "Z").upper())
    if axis is None:
        raise DfmError("Orientation d'impression invalide (Z, X ou Y)")
    height = [_dot(p, axis) for tri in mesh for p in tri]
    if not height:
        return {"ok": True, "area_mm2": 0.0, "bridge_area_mm2": 0.0, "needs_support": False}
    bed = min(height)
    span = max(height) - bed
    # The layer touching the bed is not an overhang: it is supported by the build plate.
    bed_band = max(0.02, span * 0.001)
    threshold = math.sin(math.radians(max(1.0, min(89.0, threshold_deg))))
    overhang = bridge = 0.0
    max_height = 0.0
    for tri in mesh:
        n = _normal(tri)
        down = _dot(n, axis)
        if down >= -threshold:
            continue
        centroid_h = sum(_dot(p, axis) for p in tri) / 3
        if centroid_h <= bed + bed_band:
            continue
        area = _area(tri) * scale * scale
        overhang += area
        max_height = max(max_height, (centroid_h - bed) * scale)
        if down <= -0.995:
            bridge += area
    needs = overhang > 1.0
    return {
        "ok": True,
        "orientation": str(orientation or "Z").upper(),
        "threshold_deg": threshold_deg,
        "area_mm2": round(overhang, 3),
        "bridge_area_mm2": round(bridge, 3),
        "max_height_mm": round(max_height, 3),
        "needs_support": bool(needs),
        "note": ("support nécessaire sous les surplombs" if needs else "aucun support nécessaire"),
    }


def analyze(doc: dict, mesh: list, *, bounds: Iterable[float], orientation: str = "Z",
            min_wall_mm: float = DEFAULT_MIN_WALL_MM, overhang_deg: float = DEFAULT_OVERHANG_DEG,
            required_fit: str | None = None, valid: bool = True) -> dict:
    """Run all manufacturing checks against the exact tessellation.

    ``bounds`` is the OCC tight bounding box in document units. ``valid`` states whether the BRep
    itself passed its own check; a false value always makes the report fail.
    """
    if not isinstance(doc, dict) or not isinstance(mesh, list) or not mesh:
        raise DfmError("Géométrie exacte manquante")
    if min_wall_mm <= 0:
        raise DfmError("Épaisseur minimale invalide")
    scale = float(hq_solid_ops.UNIT_MM.get(doc.get("units") or "mm", 1.0))
    box = tuple(float(v) for v in bounds)
    span = max(max(box[0], box[1], box[2]) - min(box[0], box[1], box[2]),
               max(box[3], box[4], box[5]) - min(box[3], box[4], box[5]), 1e-6)
    samples = [v * scale for v in _wall_samples(mesh, span)]
    measured = min(samples) if samples else 0.0
    p05 = _quantile(samples, 0.05)
    wall_ok = bool(samples) and measured >= min_wall_mm - 1e-6
    wall = {
        "pass": wall_ok,
        "required_mm": round(min_wall_mm, 3),
        "measured_mm": round(measured, 3),
        "p05_mm": round(p05, 3),
        "samples": len(samples),
        "reason": "" if wall_ok else "paroi plus fine que le minimum imprimable",
    }
    holes = _hole_checks(doc, mesh, box, scale, min_wall_mm, required_fit)
    overhang = _overhang_checks(mesh, scale, orientation, overhang_deg)
    watertight_ok = watertight(mesh)
    printable = bool(valid and watertight_ok and wall["pass"] and holes["ok"])
    return {
        "ok": printable,
        "printable": printable,
        "wall": wall,
        "holes": holes,
        "overhang": overhang,
        "validity": {"brep_valid": bool(valid), "watertight": watertight_ok, "triangles": len(mesh)},
        "positioning": {
            "support_free": not overhang["needs_support"],
            "note": overhang["note"],
        },
    }
