"""Exact solids for Dessiner v6 drawings: OpenCascade through OCP (package ``cadquery-ocp-novtk``), in document units.

Older drawings keep their builders (hq_solid: extrusion + cuts; hq_solid_ops: v5 features on manifold3d). A version-6
drawing is built here, as a true B-rep, feature after feature in list order, honouring ``suppressed`` features and
the ``rollback`` point:

  extrude / revolve / sweep / loft   add material (``op`` "add", the default) or remove it (``op`` "cut")
  cut / hole / shell / pattern       as in v5 (from the part's top for the base XY sketch, else from the sketch plane)
  fillet / chamfer                   exact rounds or bevels on picked edges (any edge: straight or curved)

Sketches live on planes: ``doc["sketches"]`` = [{id, name, plane: "XY"|"XZ"|"YZ", offset}]; a point or object without
``sketch`` is on the base XY plane. Profiles may hold lines, arcs (centre + start + end, counter-clockwise) and a
circle. Legacy ``faceFeatures`` and ``roundFeatures`` are rebuilt exactly too.

Everything returned to callers is plain Python (triangles, edges, bytes, numbers). Refusals are hq_solid.SolidError.
"""

from __future__ import annotations

import math
import os
import tempfile
import threading

try:  # load the engine once, on the importing (main) thread, like hq_solid_ops does for manifold3d
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    from OCP.BRepBuilderAPI import (BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeWire,
                                    BRepBuilderAPI_Transform, BRepBuilderAPI_MakePolygon)
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell, BRepOffsetAPI_MakeThickSolid, BRepOffsetAPI_ThruSections
    from OCP.BRepBuilderAPI import BRepBuilderAPI_RoundCorner
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.collections import List_TopoDS_Shape
    from OCP.GC import GC_MakeArcOfCircle
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.GProp import GProp_GProps
    from OCP.gp import gp_Ax1, gp_Ax2, gp_Circ, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
    from OCP.Interface import Interface_Static
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    _AVAILABLE = True
    try:  # OCC prints transfer statistics on stdout: the bridge log stays quiet
        from OCP.Message import Message
        _printers = Message.DefaultMessenger_s().Printers()
        for _i in range(_printers.Size(), 0, -1):
            Message.DefaultMessenger_s().RemovePrinter(_printers.Value(_i))
    except Exception:  # pragma: no cover - cosmetic only
        pass
except (ImportError, OSError):  # pragma: no cover - optional runtime package
    _AVAILABLE = False

import hq_solid_ops

PLANES = {  # (u, v, normal): u x v = normal
    "XY": ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
    "XZ": ((1.0, 0.0, 0.0), (0.0, 0.0, 1.0), (0.0, -1.0, 0.0)),
    "YZ": ((0.0, 1.0, 0.0), (0.0, 0.0, 1.0), (1.0, 0.0, 0.0)),
}
OCC_TYPES = ("fillet", "chamfer", "sweep", "loft")
UNIT_MM = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
_LOCK = threading.Lock()  # OCC global state (STEP writer settings, mesher) is shared: one build at a time


def _as_edge(shape):
    return (TopoDS.Edge if hasattr(TopoDS, "Edge") else TopoDS.Edge_s)(shape)  # OCP 8 dropped the _s suffix here


def _as_face(shape):
    return (TopoDS.Face if hasattr(TopoDS, "Face") else TopoDS.Face_s)(shape)


def available() -> bool:
    return _AVAILABLE


def _fail(message):
    from hq_solid import SolidError
    raise SolidError(message)


def uses_occ(doc) -> bool:
    return (doc.get("version") or 0) >= 6


# ---------------------------------------------------------------- planes and profiles
def frame(doc, sketch_id):
    """(origin, u, v, n) of a sketch's plane."""
    if not sketch_id:
        u, v, n = PLANES["XY"]
        return (0.0, 0.0, 0.0), u, v, n
    sk = next((s for s in doc.get("sketches") or [] if s["id"] == sketch_id), None)
    if sk is None:
        _fail("Esquisse introuvable")
    u, v, n = PLANES[sk["plane"]]
    off = sk.get("offset", 0.0)
    return (n[0] * off, n[1] * off, n[2] * off), u, v, n


def _p3(fr, x, y):
    o, u, v, _n = fr
    return gp_Pnt(o[0] + u[0] * x + v[0] * y, o[1] + u[1] * x + v[1] * y, o[2] + u[2] * x + v[2] * y)


def _maps(doc):
    return {o["id"]: o for o in doc["objects"]}, {p["id"]: p for p in doc["points"]}


def _sketch_of(doc, ids):
    objects, points = _maps(doc)
    sks = set()
    for i in ids:
        o = objects.get(i)
        if o is None:
            _fail("Profil avec objet supprimé")
        sks.add(o.get("sketch") or "")
    if len(sks) != 1:
        _fail("Un profil reste dans une seule esquisse")
    return sks.pop()


def _ends(o):
    if o["type"] in ("line", "centerline"):
        return o["p1"], o["p2"]
    if o["type"] == "arc":
        return o["p1"], o["p2"]
    return None


def _chain(doc, ids, closed=True):
    """Order a profile's objects end to end. Returns [(object, forward)]; a lone circle is its own loop."""
    objects, _points = _maps(doc)
    chosen = [objects[i] for i in ids]
    if closed and len(chosen) == 1 and chosen[0]["type"] == "circle":
        return [(chosen[0], True)]
    if any(o["type"] not in ("line", "arc") for o in chosen):
        _fail("Un profil se compose de lignes et d'arcs (ou d'un seul cercle)")
    graph = {}
    for o in chosen:
        a, b = _ends(o)
        if a == b:
            _fail("Segment de longueur nulle dans le profil")
        graph.setdefault(a, []).append(o)
        graph.setdefault(b, []).append(o)
    degrees = {p: len(v) for p, v in graph.items()}
    if closed and any(d != 2 for d in degrees.values()):
        _fail("Contour ouvert ou ramifié : accroche les extrémités")
    if not closed:
        ends = [p for p, d in degrees.items() if d == 1]
        if len(ends) != 2 or any(d > 2 for d in degrees.values()):
            _fail("Le chemin doit être une suite de segments sans branche")
        start = min(ends)
    else:
        start = min(graph)
    out, used, cur = [], set(), start
    while True:
        nxt = next((o for o in graph[cur] if o["id"] not in used), None)
        if nxt is None:
            break
        a, b = _ends(nxt)
        forward = a == cur
        out.append((nxt, forward))
        used.add(nxt["id"])
        cur = b if forward else a
        if closed and cur == start:
            break
    if len(used) != len(chosen):
        _fail("Sélectionne un seul contour continu")
    if closed and cur != start:
        _fail("Contour ouvert : accroche les extrémités")
    return out


def _arc_points(points, o):
    c, a, b = points[o["center"]], points[o["p1"]], points[o["p2"]]
    r = math.hypot(a["x"] - c["x"], a["y"] - c["y"])
    t0 = math.atan2(a["y"] - c["y"], a["x"] - c["x"])
    t1 = math.atan2(b["y"] - c["y"], b["x"] - c["x"])
    sweep = (t1 - t0) % (2 * math.pi) or 2 * math.pi
    tm = t0 + sweep / 2
    return (a["x"], a["y"]), (c["x"] + r * math.cos(tm), c["y"] + r * math.sin(tm)), (b["x"], b["y"]), r


def _wire(doc, ids, closed=True):
    """(TopoDS_Wire, frame) of a profile or a path, in 3D on its sketch plane."""
    sid = _sketch_of(doc, ids)
    fr = frame(doc, sid)
    _objects, points = _maps(doc)
    builder = BRepBuilderAPI_MakeWire()
    for o, forward in _chain(doc, ids, closed):
        if o["type"] == "circle":
            c = points[o["center"]]
            edge = BRepBuilderAPI_MakeEdge(gp_Circ(gp_Ax2(_p3(fr, c["x"], c["y"]), gp_Dir(*fr[3])), o["r"])).Edge()
        elif o["type"] == "line":
            a, b = points[o["p1"]], points[o["p2"]]
            if not forward:
                a, b = b, a
            edge = BRepBuilderAPI_MakeEdge(_p3(fr, a["x"], a["y"]), _p3(fr, b["x"], b["y"])).Edge()
        else:
            a, m, b, _r = _arc_points(points, o)
            if not forward:
                a, b = b, a
            arc = GC_MakeArcOfCircle(_p3(fr, *a), _p3(fr, *m), _p3(fr, *b)).Value()
            edge = BRepBuilderAPI_MakeEdge(arc).Edge()
        builder.Add(edge)
        if not builder.IsDone():
            _fail("Profil discontinu")
    wire = builder.Wire()
    return wire, fr


def _face(doc, ids):
    wire, fr = _wire(doc, ids, True)
    mk = BRepBuilderAPI_MakeFace(wire, True)
    if not mk.IsDone():
        _fail("Profil fermé et plan requis")
    return mk.Face(), fr


# ---------------------------------------------------------------- solids
def _volume(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def _solids(shape):
    ex, n = TopExp_Explorer(shape, TopAbs_SOLID), 0
    while ex.More():
        n += 1
        ex.Next()
    return n


def _bounds(shape):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)  # tight: the plain box is padded by the shapes' tolerance
    lo, hi = box.CornerMin(), box.CornerMax()  # Bnd_Box.Get() does not cross into Python with OCP 8
    x0, y0, z0, x1, y1, z1 = lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()
    return (x0, y0, z0, x1, y1, z1), max(x1 - x0, y1 - y0, z1 - z0, 1e-6)


def _boolean(shape, tool, op, what):
    if shape is None:
        if op == "cut":
            _fail("Crée d'abord une pièce de base")
        return tool
    before = _volume(shape)
    mk = BRepAlgoAPI_Cut(shape, tool) if op == "cut" else BRepAlgoAPI_Fuse(shape, tool)
    if not mk.IsDone():
        _fail(what + " impossible")
    out = mk.Shape()
    after = _volume(out)
    if op == "cut" and before - after <= 1e-9 * max(1.0, before):
        _fail(what + " ne retire aucune matière")
    if op == "add" and after - before <= 1e-9 * max(1.0, before):
        _fail(what + " n'ajoute aucune matière")
    if _solids(out) != 1:
        _fail(what + " sépare la pièce en morceaux")
    return out


def _prism(face, fr, depth, direction=1, both=False):
    n = fr[3]
    if both:
        moved = _moved(face, gp_Vec(-n[0] * depth / 2, -n[1] * depth / 2, -n[2] * depth / 2))
        return BRepPrimAPI_MakePrism(moved, gp_Vec(n[0] * depth, n[1] * depth, n[2] * depth)).Shape()
    s = direction * depth
    return BRepPrimAPI_MakePrism(face, gp_Vec(n[0] * s, n[1] * s, n[2] * s)).Shape()


def _moved(shape, vec):
    t = gp_Trsf()
    t.SetTranslation(vec)
    return BRepBuilderAPI_Transform(shape, t, True).Shape()


def _rotated(shape, center, angle_deg):
    t = gp_Trsf()
    t.SetRotation(gp_Ax1(gp_Pnt(center[0], center[1], 0.0), gp_Dir(0, 0, 1)), math.radians(angle_deg))
    return BRepBuilderAPI_Transform(shape, t, True).Shape()


def _axis(doc, fid, axis_id, sid):
    objects, points = _maps(doc)
    ax = objects.get(axis_id)
    if ax is None or ax["type"] not in ("line", "centerline"):
        _fail("Axe de révolution introuvable")
    if (ax.get("sketch") or "") != sid:
        _fail("L'axe doit être dans l'esquisse du profil")
    fr = frame(doc, sid)
    a, b = points[ax["p1"]], points[ax["p2"]]
    pa, pb = _p3(fr, a["x"], a["y"]), _p3(fr, b["x"], b["y"])
    d = gp_Vec(pa, pb)
    if d.Magnitude() <= 1e-12:
        _fail("Axe de révolution nul")
    return gp_Ax1(pa, gp_Dir(d))


def _top_tool(doc, face, fr, sid, shape, depth, through):
    """Removal tool for a cut / hole: the base XY sketch removes from the part's top down (as before); another
    sketch removes from its plane against its normal."""
    (_x0, _y0, z0, _x1, _y1, z1), span = _bounds(shape)
    if not sid:
        if through:
            return _moved(_prism(face, fr, (z1 - z0) + 4 * span), gp_Vec(0, 0, z0 - 2 * span))
        if not (0 < depth <= z1 - z0 + 1e-9):
            _fail("Profondeur hors de la pièce")
        return _moved(_prism(face, fr, depth + span), gp_Vec(0, 0, z1 - depth))
    if through:
        return _prism(face, fr, 8 * span, both=True)
    return _prism(face, fr, depth, direction=-1)


def _hole_tool(doc, f, shape):
    objects, points = _maps(doc)
    geo = hq_solid_ops.hole_geometry(f["standard"], f["fit"], doc["units"])
    (_x0, _y0, z0, _x1, _y1, z1), span = _bounds(shape)
    r = geo["r"]
    through = f.get("extent") == "throughAll"
    depth = geo.get("insert_depth") if f["fit"] == "insert" and not f.get("depth") else f.get("depth")
    tools = []
    for cid in f["at"]:
        o = objects[cid]
        sid = o.get("sketch") or ""
        fr = frame(doc, sid)
        c = points[o["center"]]
        n = fr[3]
        top = _p3(fr, c["x"], c["y"])
        if not sid:  # the base sketch drills from the part's top
            top = gp_Pnt(top.X(), top.Y(), z1)
        down = gp_Dir(-n[0], -n[1], -n[2])
        if through:
            length = (z1 - z0) + 4 * span
        else:
            if not (depth and depth > 0):
                _fail("Profondeur de trou invalide")
            length = depth
        start = gp_Pnt(top.X() + n[0] * span, top.Y() + n[1] * span, top.Z() + n[2] * span)
        tool = BRepPrimAPI_MakeCylinder(gp_Ax2(start, down), r, length + span).Shape()
        if "head_r" in geo:
            sink = geo["head_r"] - r
            cone = BRepPrimAPI_MakeCone(gp_Ax2(top, down), geo["head_r"], r, sink).Shape()
            cap = BRepPrimAPI_MakeCylinder(gp_Ax2(start, down), geo["head_r"], span).Shape()
            tool = BRepAlgoAPI_Fuse(BRepAlgoAPI_Fuse(tool, cone).Shape(), cap).Shape()
        tools.append(tool)
    out = tools[0]
    for t in tools[1:]:
        out = BRepAlgoAPI_Fuse(out, t).Shape()
    return out


def _top_faces(shape):
    (_x0, _y0, _z0, _x1, _y1, z1), span = _bounds(shape)
    faces = List_TopoDS_Shape()
    ex, n = TopExp_Explorer(shape, TopAbs_FACE), 0
    while ex.More():
        f = _as_face(ex.Current())
        s = BRepAdaptor_Surface(f)
        if s.GetType() == GeomAbs_Plane:
            pl = s.Plane()
            d = pl.Axis().Direction()
            normal_up = d.Z() if f.Orientation() != TopAbs_REVERSED else -d.Z()
            if normal_up > 0.999 and abs(pl.Location().Z() - z1) < 1e-7 * span:
                faces.Append(f)
                n += 1
        ex.Next()
    return faces, n


def _shell(shape, f):
    t = f["thickness"]
    mk = BRepOffsetAPI_MakeThickSolid()
    opened = f.get("open", True)
    if opened:
        faces, n = _top_faces(shape)
        if not n:
            _fail("Pas de face plane en haut à ouvrir")
        mk.MakeThickSolidByJoin(shape, faces, -t, 1e-5)
    else:  # with no face removed, the offset is the inner core: the closed shell is the part minus that core
        mk.MakeThickSolidByJoin(shape, List_TopoDS_Shape(), -t, 1e-5)
    try:
        out = mk.Shape()
    except Exception:
        _fail("Coque trop épaisse pour cette pièce")
    if out is None or out.IsNull() or not BRepCheck_Analyzer(out).IsValid() or not (0 < _volume(out) < _volume(shape)):
        _fail("Coque trop épaisse pour cette pièce")
    if not opened:
        cut = BRepAlgoAPI_Cut(shape, out)
        if not cut.IsDone():
            _fail("Coque fermée impossible")
        out = cut.Shape()
        if not (0 < _volume(out) < _volume(shape)):
            _fail("Coque trop épaisse pour cette pièce")
    return out


# ---------------------------------------------------------------- edges (fillet / chamfer picking)
def _edge_info(edge):
    c = BRepAdaptor_Curve(edge)
    t0, t1 = c.FirstParameter(), c.LastParameter()
    a, b, m = c.Value(t0), c.Value(t1), c.Value((t0 + t1) / 2)
    return [a.X(), a.Y(), a.Z()], [b.X(), b.Y(), b.Z()], [m.X(), m.Y(), m.Z()], c


def _edge_map(shape):
    """Each edge of the shape once (an edge shared by two faces is visited twice by an explorer)."""
    from OCP.TopExp import TopExp
    try:
        from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as IndexedMap  # OCP 8
    except ImportError:  # pragma: no cover - older OCP
        from OCP.TopTools import TopTools_IndexedMapOfShape as IndexedMap
    m = IndexedMap()
    TopExp.MapShapes_s(shape, TopAbs_EDGE, m)
    return m


def edges_of(shape):
    """Every edge once: its ends, middle and a short polyline for display/picking."""
    m = _edge_map(shape)
    out = []
    for i in range(1, m.Extent() + 1):
        e = _as_edge(m.FindKey(i))
        a, b, mid, c = _edge_info(e)
        t0, t1 = c.FirstParameter(), c.LastParameter()
        line = math.dist(a, mid) + math.dist(mid, b) <= math.dist(a, b) * (1 + 1e-9) + 1e-12
        steps = 1 if line else 24
        pts = [[c.Value(t0 + (t1 - t0) * k / steps).X(), c.Value(t0 + (t1 - t0) * k / steps).Y(), c.Value(t0 + (t1 - t0) * k / steps).Z()] for k in range(steps + 1)]
        out.append({"a": a, "b": b, "m": mid, "pts": pts, "line": line})
    return out


def _find_edges(shape, refs):
    _box, span = _bounds(shape)
    tol = span * 1e-5
    m = _edge_map(shape)
    edges = [_as_edge(m.FindKey(i)) for i in range(1, m.Extent() + 1)]
    infos = [_edge_info(e) for e in edges]
    found = []
    for ref in refs:
        hit = None
        for e, (a, b, mid, _c) in zip(edges, infos):
            if math.dist(mid, ref["m"]) <= tol and min(math.dist(a, ref["a"]) + math.dist(b, ref["b"]), math.dist(a, ref["b"]) + math.dist(b, ref["a"])) <= 2 * tol:
                hit = e
                break
        if hit is None:
            _fail("Arête introuvable sur la pièce actuelle (la pièce a changé avant cet arrondi ?)")
        found.append(hit)
    return found


def _round(shape, f):
    edges = _find_edges(shape, f["edges"])
    if f["type"] == "fillet":
        mk = BRepFilletAPI_MakeFillet(shape)
        for e in edges:
            mk.Add(f["radius"], e)
    else:
        mk = BRepFilletAPI_MakeChamfer(shape)
        for e in edges:
            mk.Add(f["distance"], e)
    try:
        mk.Build()
        ok = mk.IsDone()
        out = mk.Shape() if ok else None
    except Exception:
        ok, out = False, None
    if not ok or out is None or out.IsNull() or not BRepCheck_Analyzer(out).IsValid():
        _fail(("Rayon" if f["type"] == "fillet" else "Chanfrein") + " trop grand pour ces arêtes")
    return out


# ---------------------------------------------------------------- the build
def _build_locked(doc):
    features = list(doc.get("features") or [])
    stop = doc.get("rollback")
    if isinstance(stop, int):
        features = features[:stop]
    shape, tools, ops = None, {}, {}
    for f in features:
        if f.get("suppressed"):
            continue
        kind = f["type"]
        if kind == "extrude":
            face, fr = _face(doc, f["profile"])
            tool = _prism(face, fr, f["depth"], -1 if f.get("reverse") else 1, both=f.get("both", False))
            op = f.get("op", "add")
            shape = _boolean(shape, tool, op, "L'extrusion" if op == "add" else "L'enlèvement")
        elif kind == "revolve":
            face, _fr = _face(doc, f["profile"])
            ax = _axis(doc, f["id"], f["axis"], _sketch_of(doc, f["profile"]))
            tool = BRepPrimAPI_MakeRevol(face, ax, math.radians(f.get("angle", 360))).Shape()
            op = f.get("op", "add")
            shape = _boolean(shape, tool, op, "La révolution")
        elif kind == "cut":
            face, fr = _face(doc, f["profile"])
            if shape is None:
                _fail("Crée d'abord une pièce de base")
            tool = _top_tool(doc, face, fr, _sketch_of(doc, f["profile"]), shape, f.get("depth", 0), f.get("extent") == "throughAll")
            op = "cut"
            shape = _boolean(shape, tool, "cut", "La coupe")
        elif kind == "hole":
            if shape is None:
                _fail("Crée d'abord une pièce de base")
            tool, op = _hole_tool(doc, f, shape), "cut"
            shape = _boolean(shape, tool, "cut", "Le perçage")
        elif kind == "shell":
            if shape is None:
                _fail("Crée d'abord une pièce de base")
            shape, tool, op = _shell(shape, f), None, None
        elif kind == "pattern":
            src = tools.get(f["source"])
            if src is None:
                _fail("La répétition reprend une fonction active placée avant elle")
            op = ops[f["source"]]
            count = f["count"]
            copies = []
            for i in range(1, count):
                if f["mode"] == "linear":
                    copies.append(_moved(src, gp_Vec(f["dx"] * i, f["dy"] * i, 0)))
                else:
                    total = f.get("angle", 360)
                    step = total / count if abs(total - 360) < 1e-9 else total / (count - 1)
                    copies.append(_rotated(src, (f["cx"], f["cy"]), step * i))
            tool = copies[0]
            for c in copies[1:]:
                tool = BRepAlgoAPI_Fuse(tool, c).Shape()
            shape = _boolean(shape, tool, op, "La répétition")
        elif kind in ("fillet", "chamfer"):
            if shape is None:
                _fail("Crée d'abord une pièce de base")
            shape, tool, op = _round(shape, f), None, None
        elif kind == "sweep":
            profile, _fr = _wire(doc, f["profile"], True)
            path, _pfr = _wire(doc, f["path"], closed=False)
            mk = BRepOffsetAPI_MakePipeShell(path)  # follows every leg of the path, corners rounded
            mk.SetMode(False)
            mk.SetTransitionMode(BRepBuilderAPI_RoundCorner)
            mk.Add(profile)
            try:
                mk.Build()
                ok = mk.IsDone() and mk.MakeSolid()
            except Exception:
                ok = False
            if not ok:
                _fail("Balayage impossible : le profil doit se trouver au départ du chemin")
            tool, op = mk.Shape(), f.get("op", "add")
            shape = _boolean(shape, tool, op, "Le balayage")
        elif kind == "loft":
            mk = BRepOffsetAPI_ThruSections(True, False)
            for ids in f["profiles"]:
                wire, _fr = _wire(doc, ids, True)
                mk.AddWire(wire)
            mk.Build()
            if not mk.IsDone():
                _fail("Lissage impossible entre ces profils")
            tool, op = mk.Shape(), f.get("op", "add")
            shape = _boolean(shape, tool, op, "Le lissage")
        else:
            _fail("Fonction 3D inconnue")
        if tool is not None:
            tools[f["id"]] = tool
            ops[f["id"]] = op
    if shape is None:
        return None
    for ff in doc.get("faceFeatures") or []:  # legacy face features, exact now
        plane = ff["plane"]
        fr = (tuple(plane["origin"]), tuple(plane["u"]), tuple(plane["v"]), tuple(plane["normal"]))
        poly = BRepBuilderAPI_MakePolygon()
        for x, y in ff["profile"]:
            poly.Add(_p3(fr, x, y))
        poly.Close()
        face = BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()
        _box, span = _bounds(shape)
        if ff["type"] == "extrude":
            shape = _boolean(shape, _prism(face, fr, ff["depth"]), "add", "L'ajout sur face")
        else:
            depth = 8 * span if ff["extent"] == "throughAll" else ff["depth"]
            shape = _boolean(shape, _prism(face, fr, depth, direction=-1), "cut", "L'enlèvement sur face")
    for rf in doc.get("roundFeatures") or []:  # legacy fillets: an edge given by its two ends
        a, b = rf["a"], rf["b"]
        shape = _round(shape, {"type": "fillet", "radius": rf["radius"], "edges": [{"a": a, "b": b, "m": [(a[i] + b[i]) / 2 for i in range(3)]}]})
    return shape


def build_shape(doc):
    if not _AVAILABLE:
        _fail("Modélisation exacte indisponible : installer requirements-occ.txt (cadquery-ocp-novtk)")
    with _LOCK:
        return _build_locked(doc)


def triangles(shape, tolerance=None):
    """Triangle soup in document units (outward winding), for the 3D view and STL."""
    if shape is None:
        return []
    with _LOCK:
        _box, span = _bounds(shape)
        BRepMesh_IncrementalMesh(shape, tolerance or span * 1e-3, False, 0.3, True)
        out = []
        ex = TopExp_Explorer(shape, TopAbs_FACE)
        while ex.More():
            face = _as_face(ex.Current())
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is not None:
                trsf = loc.Transformation()
                reversed_face = face.Orientation() == TopAbs_REVERSED
                nodes = [tri.Node(i).Transformed(trsf) for i in range(1, tri.NbNodes() + 1)]
                eps = (span * 1e-9) ** 2
                for i in range(1, tri.NbTriangles() + 1):
                    a, b, c = tri.Triangle(i).Get()
                    if reversed_face:
                        b, c = c, b
                    t = tuple((nodes[k - 1].X(), nodes[k - 1].Y(), nodes[k - 1].Z()) for k in (a, b, c))
                    u = [t[1][j] - t[0][j] for j in range(3)]
                    v = [t[2][j] - t[0][j] for j in range(3)]
                    n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                    if n[0] * n[0] + n[1] * n[1] + n[2] * n[2] <= eps:
                        continue  # a zero-area sliver (pole of a rounded sweep corner): nothing to draw, and STL refuses it
                    out.append(t)
            ex.Next()
        return out


def build(doc):
    """Triangles of a v6 drawing (empty when it has no part yet)."""
    shape = build_shape(doc)
    return triangles(shape)


def step_bytes(doc) -> bytes:
    """The part as STEP (AP214), in millimetres."""
    shape = build_shape(doc)
    if shape is None:
        _fail("Crée d'abord une pièce 3D")
    k = UNIT_MM.get(doc["units"], 1.0)
    with _LOCK:
        if k != 1.0:
            t = gp_Trsf()
            t.SetScale(gp_Pnt(0, 0, 0), k)
            shape = BRepBuilderAPI_Transform(shape, t, True).Shape()
        Interface_Static.SetCVal_s("write.step.unit", "MM")
        Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
        writer = STEPControl_Writer()
        writer.Transfer(shape, STEPControl_AsIs)
        folder = tempfile.mkdtemp(prefix="hq-step-")
        path = os.path.join(folder, "piece.step")
        try:
            if int(writer.Write(path)) != 1:
                _fail("Export STEP impossible")
            with open(path, "rb") as fh:
                return fh.read()
        finally:
            try:
                os.remove(path)
                os.rmdir(folder)
            except OSError:
                pass


def mass_properties(doc) -> dict:
    shape = build_shape(doc)
    if shape is None:
        return {}
    with _LOCK:
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, props)
        c = props.CentreOfMass()
        sprops = GProp_GProps()
        BRepGProp.SurfaceProperties_s(shape, sprops)
        (x0, y0, z0, x1, y1, z1), _span = _bounds(shape)
        return {"volume": props.Mass(), "area": sprops.Mass(), "center": [c.X(), c.Y(), c.Z()],
                "size": [x1 - x0, y1 - y0, z1 - z0]}
