"""USDZ for AR Quick Look (iPhone / iPad): the Dessiner part at real size, standing on the table.

A USDZ is an uncompressed zip whose files start on 64-byte boundaries. It holds one ASCII ``model.usda``: a single
mesh in metres, Y up (the drawing is Z up), centred on the origin and resting on Y = 0, with a plain
UsdPreviewSurface material. Stdlib only. Recently built files are kept briefly in memory so Safari can fetch one by
URL (Quick Look opens a link, not a blob).
"""

from __future__ import annotations

import os
import re
import struct
import threading
import time
import zlib

UNIT_M = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254}
USDZ_RE = re.compile(r"^usdz-[0-9a-f]{24}$")
KEEP_SEC = 600
KEEP_MAX = 4
COLOR = (0.2, 0.62, 0.7)  # the teal of the 3D preview

_LOCK = threading.Lock()
_files: dict[str, tuple[float, bytes]] = {}


def _f(v: float) -> str:
    out = f"{v:.6f}".rstrip("0").rstrip(".")
    return "0" if out in ("", "-0") else out


def usda(mesh, units: str, name: str = "Piece") -> str:
    """The scene as USD ASCII. ``mesh`` is a triangle soup in document units (Z up)."""
    k = UNIT_M.get(units, 0.001)
    pts = [(p[0] * k, p[2] * k, -p[1] * k) for tri in mesh for p in tri]  # Z up -> Y up
    if not pts:
        raise ValueError("empty mesh")
    xs, ys, zs = [p[0] for p in pts], [p[1] for p in pts], [p[2] for p in pts]
    cx, cz, y0 = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2, min(ys)
    pts = [(x - cx, y - y0, z - cz) for x, y, z in pts]
    normals = []
    for i in range(0, len(pts), 3):
        a, b, c = pts[i], pts[i + 1], pts[i + 2]
        u = (b[0] - a[0], b[1] - a[1], b[2] - a[2])
        v = (c[0] - a[0], c[1] - a[1], c[2] - a[2])
        n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
        ln = (n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5 or 1.0
        normals.extend([(n[0] / ln, n[1] / ln, n[2] / ln)] * 3)
    tri = len(pts) // 3
    vec = lambda rows: ", ".join("(" + ", ".join(_f(x) for x in r) + ")" for r in rows)
    safe = re.sub(r"[^A-Za-z0-9_]", "_", name) or "Piece"
    if safe[0].isdigit():
        safe = "P_" + safe
    return f'''#usda 1.0
(
    customLayerData = {{
        string creator = "Transfert HQ Dessiner"
    }}
    defaultPrim = "{safe}"
    metersPerUnit = 1
    upAxis = "Y"
)

def Xform "{safe}" (
    assetInfo = {{
        string name = "{safe}"
    }}
    kind = "component"
)
{{
    def Mesh "Mesh"
    {{
        int[] faceVertexCounts = [{", ".join(["3"] * tri)}]
        int[] faceVertexIndices = [{", ".join(str(i) for i in range(len(pts)))}]
        rel material:binding = </{safe}/Materials/Matiere>
        normal3f[] normals = [{vec(normals)}] (
            interpolation = "faceVarying"
        )
        point3f[] points = [{vec(pts)}]
        uniform token subdivisionScheme = "none"
    }}

    def Scope "Materials"
    {{
        def Material "Matiere"
        {{
            token outputs:surface.connect = </{safe}/Materials/Matiere/Surface.outputs:surface>

            def Shader "Surface"
            {{
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = ({_f(COLOR[0])}, {_f(COLOR[1])}, {_f(COLOR[2])})
                float inputs:metallic = 0
                float inputs:roughness = 0.55
                token outputs:surface
            }}
        }}
    }}
}}
'''


def package(files: list[tuple[str, bytes]]) -> bytes:
    """A stored (uncompressed) zip with each file's data aligned on 64 bytes, as USDZ requires."""
    out = bytearray()
    central = bytearray()
    for name, data in files:
        raw_name = name.encode("ascii")
        crc = zlib.crc32(data) & 0xFFFFFFFF
        offset = len(out)
        header_len = 30 + len(raw_name)
        pad = (-(offset + header_len + 4)) % 64  # a 4-byte extra-field header, then padding
        extra = struct.pack("<HH", 0x1986, pad) + b"\0" * pad
        out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, 0, 0, 0x21, crc, len(data), len(data), len(raw_name), len(extra))
        out += raw_name + extra
        assert len(out) % 64 == 0
        out += data
        central += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 0, 0, 0x21, crc, len(data), len(data),
                               len(raw_name), 0, 0, 0, 0, 0, offset) + raw_name
    start = len(out)
    out += central
    out += struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(files), len(files), len(central), start, 0)
    return bytes(out)


def build(mesh, units: str, name: str = "Piece") -> bytes:
    return package([("model.usda", usda(mesh, units, name).encode("utf-8"))])


def keep(data: bytes, *, now: float | None = None) -> str:
    """Hold a built file for a few minutes; returns its id."""
    t = time.time() if now is None else now
    fid = "usdz-" + os.urandom(12).hex()
    with _LOCK:
        for key in [k for k, (at, _b) in _files.items() if t - at > KEEP_SEC]:
            del _files[key]
        while len(_files) >= KEEP_MAX:
            del _files[min(_files, key=lambda k: _files[k][0])]
        _files[fid] = (t, data)
    return fid


def fetch(fid: str, *, now: float | None = None) -> bytes | None:
    t = time.time() if now is None else now
    with _LOCK:
        item = _files.get(fid) if USDZ_RE.fullmatch(fid or "") else None
        if item is None or t - item[0] > KEEP_SEC:
            return None
        return item[1]


def reset_for_tests() -> None:
    with _LOCK:
        _files.clear()
