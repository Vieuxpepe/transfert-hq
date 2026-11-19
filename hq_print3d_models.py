"""The Master's 3D model library — an index over folders he already owns.

Roots (read only): the ``Print/`` share (where Fichiers uploads of .stl/.3mf
already land) and one optional extra folder chosen in the settings. Nothing is
moved or rewritten; only our own metadata (tags, notes, origin, print count,
MakerWorld link) lives in ``.hq-print3d/models.json``.

Confinement: every file is reached by walking from a root with symlinks and
junctions skipped, and is re-checked by realpath before it is opened.
3MF thumbnails are read as bytes from the zip (``Metadata/*.png``), never decoded.
"""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
import uuid
import zipfile
import zlib
from pathlib import Path
from typing import Any, Callable

import hq_state
from hq_print3d_slicer import (
    ADVANCED_PARAM_SCHEMA,
    CANONICAL_PROFILES,
    FAMILY_MODELS,
    OBJECT_OVERRIDE_KEYS,
    QUALITY_PRESETS,
    SPEED_PRESET_FACTORS,
    SlicerConfigError,
    inspect_printer_slicer_defaults,
    printer_capabilities,
    printer_catalog,
    resolve_slicer_config,
    resolve_vendor_model_name,
    validate_and_normalize_object_overrides,
)

MODEL_EXT = {".stl", ".glb", ".3mf", ".step", ".stp", ".obj", ".f3d", ".scad", ".gcode", ".gx", ".fcstd", ".blend"}
MAX_FILES = 5000
MAX_DEPTH = 8
MAX_THUMB = 2 * 1024 * 1024
MAX_SERVE = 300 * 1024 * 1024
SCAN_TTL = 60.0
MAX_TAGS = 12
MAX_NOTE = 2000
ORIGINS = ("owned", "designed", "downloaded")
_THUMB_NAMES = ("Metadata/plate_1.png", "Metadata/thumbnail.png", "Metadata/plate_1_small.png",
                "Auxiliaries/.thumbnails/thumbnail_3mf.png")


class ModelError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


MAX_SLICE_INFO = 1024 * 1024
GCODE_HEAD_BYTES = 128 * 1024   # a slicer's header comments are at the top; never read the body
MAX_STL_BYTES = 64 * 1024 * 1024
MAX_GCODE_BYTES = 128 * 1024 * 1024
MAX_GCODE_ZIP_ENTRIES = 2000
MAX_GCODE_ZIP_RATIO = 250
MAX_PLATE_TRIANGLES = 600000
SLICER_SEM = threading.Semaphore(2)


class GcodeStream:
    """Bounded, close-safe binary stream for plain .gcode/.gx or 3MF plate G-code."""

    def __init__(self, *, stream: Any, size: int, name: str, plate: int,
                 source_kind: str, etag: str, range_ok: bool,
                 base_offset: int = 0, max_bytes: int = MAX_GCODE_BYTES,
                 extra_close: tuple[Any, ...] = ()) -> None:
        self._stream = stream
        self.size = max(0, int(size))
        self.name = name
        self.plate = int(plate)
        self.source_kind = source_kind
        self.etag = etag
        self.range_ok = bool(range_ok)
        self._base_offset = max(0, int(base_offset))
        self._max_bytes = int(max_bytes)
        self._extra_close = extra_close
        self._bytes_read = 0
        self._closed = False

    def seek(self, offset: int) -> None:
        if not self.range_ok:
            raise OSError("Stream does not support seeking")
        self._stream.seek(self._base_offset + max(0, int(offset)))

    def read(self, n: int) -> bytes:
        if self._closed:
            return b""
        limit = min(int(n), self._max_bytes - self._bytes_read + 1)
        if limit <= 0:
            raise ModelError("G-code décompressé trop volumineux (> 128 Mo)", 413, "too_large")
        try:
            chunk = self._stream.read(limit)
        except (zipfile.BadZipFile, zlib.error, EOFError, OSError) as exc:
            raise ModelError("Flux G-code illisible", 422, "unreadable") from exc
        if chunk:
            self._bytes_read += len(chunk)
            if self._bytes_read > self._max_bytes:
                raise ModelError("G-code décompressé trop volumineux (> 128 Mo)", 413, "too_large")
        return chunk

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        for obj in (self._stream, *self._extra_close):
            if obj is not None:
                try:
                    obj.close()
                except Exception:
                    pass

    def __enter__(self) -> "GcodeStream":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()

PRINTER_PROFILES: dict[str, dict[str, Any]] = {
    "bambu": {
        "bed": (256.0, 256.0, 256.0), "origin": (0.0, 0.0),
        "travel_box": (-50.0, 270.0, -5.0, 268.0, -6.0, 258.0),
        "max_nozzle_temp": 300.0, "max_bed_temp": 110.0,
        "physical_extruders": 1, "max_tools": 16, "dialect": "bambu",
    },
    "flashforge": {
        "bed": (256.0, 256.0, 256.0), "origin": (0.0, 0.0),
        "travel_box": (-5.0, 261.0, -5.0, 261.0, -2.0, 258.0),
        "max_nozzle_temp": 280.0, "max_bed_temp": 110.0,
        "physical_extruders": 4, "max_tools": 16, "dialect": "marlin_ff",
    },
    **{k: dict(v) for k, v in CANONICAL_PROFILES.items()},
}

_MATERIAL_TEMPS = {
    "PLA": (215, 60),
    "PETG": (245, 75),
    "ABS": (260, 100),
    "TPU": (225, 50),
}


def file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(256 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _atomic_publish(src_file: Path, dst_file: Path) -> None:
    if dst_file.is_symlink() or (dst_file.exists() and _is_link(dst_file)):
        raise ModelError("Destination lien symbolique refusée", 403, "unsafe_path")
    fd, tmp_name = tempfile.mkstemp(prefix=".hq-tmp-", dir=str(dst_file.parent))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out_fh, open(src_file, "rb") as in_fh:
            shutil.copyfileobj(in_fh, out_fh, 256 * 1024)
            out_fh.flush()
            os.fsync(out_fh.fileno())
        os.replace(tmp_path, dst_file)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


_INTERNAL_SLICE_RE = re.compile(r"_(?:sliced|studio)(?:_[0-9a-f]{8}_[0-9a-f]{6})?\.gcode\.3mf$", re.IGNORECASE)
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)


def is_internal_sliced_name(name: str) -> bool:
    """Return True if filename matches an Atelier 3D / Studio generated slice artifact."""
    return bool(_INTERNAL_SLICE_RE.search(str(name or "").strip()))


@contextlib.contextmanager
def _interprocess_file_lock(lock_path: Path):
    """Advisory inter-process exclusive lock for non-hardlink publication fallback."""
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(lock_path, "a+b")
    try:
        if os.name == "nt":
            import msvcrt
            while True:
                try:
                    fh.seek(0)
                    msvcrt.locking(fh.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    time.sleep(0.01)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        fh.close()


def _file_sha256_path(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(256 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


_STL_BOUNDS_LOCK = threading.Lock()
_STL_BOUNDS_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}
_SOURCE_SHA_CACHE: dict[tuple[str, int, int, int], str] = {}
_STL_NUM_RE = re.compile(r"^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$")


def _source_sha256_path(path: Path) -> str:
    """Safely compute/cache lowercase SHA-256 hex digest using O_NOFOLLOW."""
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = -1
    try:
        fd = os.open(path, flags)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_SERVE:
            return ""
        key = (str(path), int(getattr(st, "st_ino", 0)), int(st.st_size), int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))))
        with _STL_BOUNDS_LOCK:
            cached = _SOURCE_SHA_CACHE.get(key)
            if cached:
                return cached
        h = hashlib.sha256()
        with os.fdopen(fd, "rb", closefd=False) as fh:
            while True:
                chunk = fh.read(256 * 1024)
                if not chunk:
                    break
                h.update(chunk)
        digest = h.hexdigest().lower()
        with _STL_BOUNDS_LOCK:
            if len(_SOURCE_SHA_CACHE) > 512:
                _SOURCE_SHA_CACHE.clear()
            _SOURCE_SHA_CACHE[key] = digest
        return digest
    except OSError:
        return ""
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def _parse_stl_triplet(parts: list[str]) -> tuple[float, float, float]:
    import math
    if len(parts) != 3:
        raise ModelError("Coordonnées STL ASCII invalides", 422, "unreadable")
    vals: list[float] = []
    for tok in parts:
        if not _STL_NUM_RE.fullmatch(tok):
            raise ModelError("Littéral numérique STL ASCII invalide", 422, "unreadable")
        num = float(tok)
        if not math.isfinite(num):
            raise ModelError("Géométrie STL invalide (NaN/Inf)", 422, "unreadable")
        vals.append(num)
    return (vals[0], vals[1], vals[2])


def _iter_ascii_stl_facets(lines: Any):
    """Strictly stream ASCII STL facets without skipping invalid lines or regrouping across facets."""
    state = "init"
    cur_verts: list[tuple[float, float, float]] = []
    loop_seen = False
    tri_count = 0
    for idx, raw_line in enumerate(lines):
        if isinstance(raw_line, (bytes, bytearray)):
            try:
                line = raw_line.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                raise ModelError("STL ASCII non UTF-8", 422, "unreadable") from None
        else:
            line = raw_line
        if idx == 0:
            line = line.lstrip("\ufeff")
        s = line.strip()
        if not s:
            continue
        parts = s.split()
        kw = parts[0].lower()
        if state == "init":
            if kw != "solid":
                raise ModelError("En-tête 'solid' manquant dans le STL ASCII", 422, "unreadable")
            state = "top"
            continue
        if state == "ended":
            raise ModelError("Contenu inattendu après 'endsolid' dans le STL ASCII", 422, "unreadable")
        if state == "top":
            if kw == "facet":
                if len(parts) != 5 or parts[1].lower() != "normal":
                    raise ModelError("En-tête 'facet normal' STL ASCII malformé", 422, "unreadable")
                _parse_stl_triplet(parts[2:5])
                cur_verts = []
                loop_seen = False
                state = "in_facet"
            elif kw == "endsolid":
                state = "ended"
            else:
                raise ModelError(f"Instruction STL ASCII inattendue ({kw})", 422, "unreadable")
        elif state == "in_facet":
            if not loop_seen:
                if [p.lower() for p in parts] != ["outer", "loop"]:
                    raise ModelError("Mot-clé 'outer loop' attendu dans la facette STL ASCII", 422, "unreadable")
                loop_seen = True
                state = "in_loop"
            else:
                if [p.lower() for p in parts] != ["endfacet"]:
                    raise ModelError("Mot-clé 'endfacet' attendu après 'endloop'", 422, "unreadable")
                tri_count += 1
                if tri_count > 300000:
                    raise ModelError("STL ASCII trop lourd (> 300k triangles)", 422, "unreadable")
                yield (cur_verts[0], cur_verts[1], cur_verts[2])
                state = "top"
        elif state == "in_loop":
            if kw == "vertex":
                if len(cur_verts) >= 3:
                    raise ModelError("Facette STL ASCII non triangulaire (> 3 sommets)", 422, "unreadable")
                cur_verts.append(_parse_stl_triplet(parts[1:]))
            elif [p.lower() for p in parts] == ["endloop"]:
                if len(cur_verts) != 3:
                    raise ModelError("Facette STL ASCII incomplète (< 3 sommets)", 422, "unreadable")
                state = "in_facet"
            else:
                raise ModelError(f"Instruction STL ASCII inattendue dans boucle ({kw})", 422, "unreadable")
    if state in ("in_facet", "in_loop") or tri_count <= 0:
        raise ModelError("STL ASCII incomplet ou vide", 422, "unreadable")


def _detect_binary_stl(header84: bytes, file_size: int) -> int | None:
    import struct
    if file_size < 84 or len(header84) < 84:
        return None
    n_tri = struct.unpack_from("<I", header84, 80)[0]
    if 0 < n_tri <= 300000 and file_size == 84 + n_tri * 50:
        return n_tri
    if not header84[:5].lstrip().lower().startswith(b"solid") and 0 < n_tri <= 300000 and file_size >= 84 + n_tri * 50:
        return n_tri
    return None


def parse_stl_triangles(raw: bytes) -> list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]:
    """Parse binary or ASCII STL triangles cleanly without silent vertex dropping."""
    import math
    import struct
    if len(raw) < 15:
        raise ModelError("STL trop court ou illisible", 422, "unreadable")
    n_tri = _detect_binary_stl(raw[:84], len(raw))
    if n_tri is not None:
        mv = memoryview(raw)[84:84 + n_tri * 50]
        tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]] = []
        append = tris.append
        isfinite = math.isfinite
        for v in struct.iter_unpack("<12fH", mv):
            if not (isfinite(v[3]) and isfinite(v[4]) and isfinite(v[5])
                    and isfinite(v[6]) and isfinite(v[7]) and isfinite(v[8])
                    and isfinite(v[9]) and isfinite(v[10]) and isfinite(v[11])):
                raise ModelError("Géométrie STL invalide (NaN/Inf)", 422, "unreadable")
            append(((v[3], v[4], v[5]), (v[6], v[7], v[8]), (v[9], v[10], v[11])))
        return tris
    return list(_iter_ascii_stl_facets(io.BytesIO(raw)))


def stl_bounds(path: Path) -> dict[str, Any] | None:
    """Stream STL bounds in O(1) memory under strict no-follow symlink checks."""
    import math
    import struct
    if _is_link(path):
        return None
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(str(path), flags)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size < 15 or st.st_size > MAX_STL_BYTES:
            return None
        key = (str(path), int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9))), int(st.st_size))
        with _STL_BOUNDS_LOCK:
            cached = _STL_BOUNDS_CACHE.get(key)
            if cached is not None:
                return dict(cached)
        with os.fdopen(fd, "rb") as fh:
            fd = -1
            head = fh.read(84)
            n_tri = _detect_binary_stl(head, st.st_size)
            min_x = min_y = min_z = 1e9
            max_x = max_y = max_z = -1e9
            isfinite = math.isfinite
            if n_tri is not None:
                remaining = n_tri
                chunk_tris = 65536
                while remaining > 0:
                    take = chunk_tris if remaining > chunk_tris else remaining
                    buf = fh.read(take * 50)
                    if len(buf) != take * 50:
                        return None
                    for v in struct.iter_unpack("<12fH", buf):
                        x0, y0, z0, x1, y1, z1, x2, y2, z2 = v[3:12]
                        if not (isfinite(x0) and isfinite(y0) and isfinite(z0)
                                and isfinite(x1) and isfinite(y1) and isfinite(z1)
                                and isfinite(x2) and isfinite(y2) and isfinite(z2)):
                            return None
                        lo_x = x0 if x0 < x1 else x1
                        if x2 < lo_x: lo_x = x2
                        hi_x = x0 if x0 > x1 else x1
                        if x2 > hi_x: hi_x = x2
                        lo_y = y0 if y0 < y1 else y1
                        if y2 < lo_y: lo_y = y2
                        hi_y = y0 if y0 > y1 else y1
                        if y2 > hi_y: hi_y = y2
                        lo_z = z0 if z0 < z1 else z1
                        if z2 < lo_z: lo_z = z2
                        hi_z = z0 if z0 > z1 else z1
                        if z2 > hi_z: hi_z = z2
                        if lo_x < min_x: min_x = lo_x
                        if hi_x > max_x: max_x = hi_x
                        if lo_y < min_y: min_y = lo_y
                        if hi_y > max_y: max_y = hi_y
                        if lo_z < min_z: min_z = lo_z
                        if hi_z > max_z: max_z = hi_z
                    remaining -= take
                tri_total = n_tri
            else:
                fh.seek(0)
                tri_total = 0
                try:
                    for tri in _iter_ascii_stl_facets(fh):
                        tri_total += 1
                        for px, py, pz in tri:
                            if px < min_x: min_x = px
                            if px > max_x: max_x = px
                            if py < min_y: min_y = py
                            if py > max_y: max_y = py
                            if pz < min_z: min_z = pz
                            if pz > max_z: max_z = pz
                except ModelError:
                    return None
        if tri_total <= 0:
            return None
        info = {
            "dims_mm": [round(max(0.0, max_x - min_x), 2),
                        round(max(0.0, max_y - min_y), 2),
                        round(max(0.0, max_z - min_z), 2)],
            "triangles": tri_total,
        }
        with _STL_BOUNDS_LOCK:
            if len(_STL_BOUNDS_CACHE) > 512:
                _STL_BOUNDS_CACHE.clear()
            _STL_BOUNDS_CACHE[key] = dict(info)
        return info
    finally:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def _obb_2d_corners(cx: float, cy: float, lx0: float, lx1: float, ly0: float, ly1: float,
                    cs: float, sn: float) -> list[tuple[float, float]]:
    return [
        (cx + lx * cs - ly * sn, cy + lx * sn + ly * cs)
        for lx, ly in ((lx0, ly0), (lx1, ly0), (lx1, ly1), (lx0, ly1))
    ]


def _sat_obb_collide(c1: list[tuple[float, float]], c2: list[tuple[float, float]], margin_mm: float = 0.5) -> bool:
    """Return True if two convex 2D quads overlap with penetration > margin_mm."""
    import math
    for poly in (c1, c2):
        for idx in range(4):
            p0 = poly[idx]
            p1 = poly[(idx + 1) % 4]
            ex, ey = p1[0] - p0[0], p1[1] - p0[1]
            elen = math.hypot(ex, ey)
            if elen <= 1e-9:
                continue
            nx, ny = -ey / elen, ex / elen
            p1_proj = [q[0] * nx + q[1] * ny for q in c1]
            p2_proj = [q[0] * nx + q[1] * ny for q in c2]
            overlap = min(max(p1_proj), max(p2_proj)) - max(min(p1_proj), min(p2_proj))
            if overlap <= margin_mm:
                return False
    return True


def lay_flat_angles_for_normal(nx: float, ny: float, nz: float) -> tuple[float, float]:
    """Compute canonical (rot_x, rot_y) degrees so Ry(rot_y)*Rx(rot_x)*(nx,ny,nz) = (0,0,-1)."""
    import math
    if not (math.isfinite(nx) and math.isfinite(ny) and math.isfinite(nz)):
        raise ModelError("Normale de face invalide pour poser à plat", 422, "unreadable")
    length = math.hypot(nx, ny, nz)
    if length <= 1e-9:
        raise ModelError("Face dégénérée impossible à poser à plat", 422, "unreadable")
    ux, uy, uz = nx / length, ny / length, nz / length
    h = math.hypot(uy, uz)
    if h <= 1e-9:
        rx = 0.0
        nz1 = 0.0
    else:
        rx = math.atan2(-uy, -uz)
        nz1 = -h
    ry = math.atan2(ux, -nz1)
    return (round(math.degrees(rx), 4), round(math.degrees(ry), 4))


def best_lay_flat_angles(raw_tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]]) -> tuple[float, float]:
    """Pick the largest coplanar cluster facing outward with minimum resulting Z height."""
    import math
    if not raw_tris:
        raise ModelError("Maillage STL vide", 422, "unreadable")
    buckets: dict[tuple[int, int, int], list[Any]] = {}
    for p0, p1, p2 in raw_tris:
        ax, ay, az = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
        bx, by, bz = p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]
        cx, cy, cz = ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx
        l = math.hypot(cx, cy, cz)
        if l <= 1e-8:
            continue
        nx, ny, nz = cx / l, cy / l, cz / l
        key = (round(nx * 20), round(ny * 20), round(nz * 20))
        entry = buckets.get(key)
        area = 0.5 * l
        if entry is None:
            buckets[key] = [area, nx * area, ny * area, nz * area]
        else:
            entry[0] += area
            entry[1] += nx * area
            entry[2] += ny * area
            entry[3] += nz * area
    if not buckets:
        return (0.0, 0.0)
    best = max(buckets.values(), key=lambda e: e[0])
    return lay_flat_angles_for_normal(best[1], best[2], best[3])


def transform_stl_triangles(
    raw_tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]],
    *,
    scale: float = 1.0,
    rot_x: float = 0.0,
    rot_y: float = 0.0,
    rot_z: float = 0.0,
    x: float = 0.0,
    y: float = 0.0,
    z: float = 0.0,
    ox: float = 0.0,
    oy: float = 0.0,
) -> dict[str, Any]:
    """Apply canonical Studio transform: center -> scale -> Rx -> Ry -> tilted-ground -> Rz -> translate."""
    import math
    if not raw_tris:
        raise ModelError("Maillage STL vide", 422, "unreadable")
    for val in (scale, rot_x, rot_y, rot_z, x, y, z, ox, oy):
        if not math.isfinite(float(val)):
            raise ModelError("Paramètres de transformation invalides (NaN/Inf)", 422, "unreadable")
    if float(z) < -0.01:
        raise ModelError("Objet placé sous le plateau (Z < 0 mm)", 422, "below_plate")
    sc = max(0.1, min(10.0, float(scale)))
    z_off = 0.0 if abs(float(z)) <= 0.01 else float(z)

    rmin_x = rmin_y = rmin_z = 1e18
    rmax_x = rmax_y = rmax_z = -1e18
    for tri in raw_tris:
        for px, py, pz in tri:
            if px < rmin_x: rmin_x = px
            if px > rmax_x: rmax_x = px
            if py < rmin_y: rmin_y = py
            if py > rmax_y: rmax_y = py
            if pz < rmin_z: rmin_z = pz
            if pz > rmax_z: rmax_z = pz
    rcx = (rmin_x + rmax_x) * 0.5
    rcy = (rmin_y + rmax_y) * 0.5
    rcz = (rmin_z + rmax_z) * 0.5

    rx_rad = math.radians(float(rot_x))
    ry_rad = math.radians(float(rot_y))
    rz_rad = math.radians(float(rot_z))
    crx, srx = math.cos(rx_rad), math.sin(rx_rad)
    cry, sry = math.cos(ry_rad), math.sin(ry_rad)
    crz, srz = math.cos(rz_rad), math.sin(rz_rad)

    tmin_x = tmin_y = tmin_z = 1e18
    tmax_x = tmax_y = tmax_z = -1e18
    tilted_tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]] = []
    for tri in raw_tris:
        pts_out = []
        for vx, vy, vz in tri:
            px = (vx - rcx) * sc
            py = (vy - rcy) * sc
            pz = (vz - rcz) * sc
            # Extrinsic X then Y
            x1 = px
            y1 = py * crx - pz * srx
            z1 = py * srx + pz * crx
            x2 = x1 * cry + z1 * sry
            y2 = y1
            z2 = -x1 * sry + z1 * cry
            if x2 < tmin_x: tmin_x = x2
            if x2 > tmax_x: tmax_x = x2
            if y2 < tmin_y: tmin_y = y2
            if y2 > tmax_y: tmax_y = y2
            if z2 < tmin_z: tmin_z = z2
            if z2 > tmax_z: tmax_z = z2
            pts_out.append((x2, y2, z2))
        tilted_tris.append((pts_out[0], pts_out[1], pts_out[2]))

    tcx = (tmin_x + tmax_x) * 0.5
    tcy = (tmin_y + tmax_y) * 0.5
    tdx = max(0.0, tmax_x - tmin_x)
    tdy = max(0.0, tmax_y - tmin_y)
    tdz = max(0.0, tmax_z - tmin_z)

    obb = _obb_2d_corners(float(x) + float(ox), float(y) + float(oy),
                          tmin_x - tcx, tmax_x - tcx, tmin_y - tcy, tmax_y - tcy, crz, srz)

    wmin_x = wmin_y = wmin_z = 1e18
    wmax_x = wmax_y = wmax_z = -1e18
    placed_tris: list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]] = []
    tx_off = float(x) + float(ox)
    ty_off = float(y) + float(oy)
    for tri in tilted_tris:
        wpts = []
        for fx, fy, fz in tri:
            lx = fx - tcx
            ly = fy - tcy
            lz = fz - tmin_z
            wx = lx * crz - ly * srz + tx_off
            wy = lx * srz + ly * crz + ty_off
            wz = lz + z_off
            if wx < wmin_x: wmin_x = wx
            if wx > wmax_x: wmax_x = wx
            if wy < wmin_y: wmin_y = wy
            if wy > wmax_y: wmax_y = wy
            if wz < wmin_z: wmin_z = wz
            if wz > wmax_z: wmax_z = wz
            wpts.append((wx, wy, wz))
        placed_tris.append((wpts[0], wpts[1], wpts[2]))

    return {
        "triangles": placed_tris,
        "obb": obb,
        "tilted_dims": (tdx, tdy, tdz),
        "world_bounds": (wmin_x, wmin_y, wmin_z, wmax_x, wmax_y, wmax_z),
    }


def _publish_immutable_slice(src_file: Path, dest_dir: Path, base_stem: str, tag: str) -> tuple[Path, str]:
    """Write src_file completely to a hidden dot-temp file, fsync, re-hash, and publish atomically without overwriting."""
    if dest_dir.is_symlink() or _is_link(dest_dir):
        raise ModelError("Répertoire de destination lien symbolique refusé", 403, "unsafe_path")
    src_digest = _file_sha256_path(src_file)
    safe_stem = re.sub(r"[^A-Za-z0-9._-]+", "_", (base_stem or "plate").strip("._-"))[:48] or "plate"
    fd, tmp_name = tempfile.mkstemp(prefix=f".hq-slice-{src_digest[:8]}-", suffix=".tmp", dir=str(dest_dir))
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as out_fh, open(src_file, "rb") as in_fh:
            shutil.copyfileobj(in_fh, out_fh, 256 * 1024)
            out_fh.flush()
            os.fsync(out_fh.fileno())
        digest = _file_sha256_path(tmp_path)
        if digest != src_digest:
            raise ModelError("Altération détectée pendant la copie de l'artefact tranché", 500, "slice_failed")
        for _attempt in range(8):
            candidate = dest_dir / f"{safe_stem}_{tag}_{digest[:8]}_{uuid.uuid4().hex[:6]}.gcode.3mf"
            if candidate.is_symlink() or (candidate.exists() and _is_link(candidate)):
                raise ModelError("Destination lien symbolique refusée", 403, "unsafe_path")
            try:
                os.link(str(tmp_path), str(candidate))
                tmp_path.unlink(missing_ok=True)
                return candidate, digest
            except FileExistsError:
                continue
            except OSError:
                # Filesystems without hardlinks: hold inter-process lock, verify non-existence, then single-step rename
                lock_name = f".hq-slice-pub-{hashlib.sha1(str(dest_dir.resolve()).encode('utf-8')).hexdigest()[:12]}.lock"
                with _interprocess_file_lock(Path(tempfile.gettempdir()) / lock_name):
                    if candidate.exists() or candidate.is_symlink():
                        continue
                    os.replace(str(tmp_path), str(candidate))
                return candidate, digest
        raise ModelError("Impossible de publier un artefact tranché unique", 500, "slice_failed")
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _arc_extrema_and_length(
    cmd: str,
    x: float, y: float, z: float,
    nx: float, ny: float, nz: float,
    raw_i: float | None, raw_j: float | None,
    raw_k: float | None, raw_r: float | None,
    raw_p: int | None,
) -> tuple[float, float, float, float, float]:
    """Compute exact G17 XY extrema (min_x, max_x, min_y, max_y) and 3D arc length, failing closed on invalid arcs."""
    import math
    if raw_k is not None and abs(raw_k) > 1e-6:
        raise ModelError(f"Paramètre K interdit dans un arc G17 ({cmd})", 422, "unsafe_gcode")
    has_ij = (raw_i is not None or raw_j is not None)
    has_r = (raw_r is not None)
    if has_ij == has_r:
        raise ModelError(f"Arc {cmd} incomplet ou ambigu (I/J vs R)", 422, "unsafe_gcode")
    chord_xy = math.hypot(nx - x, ny - y)
    turns = int(raw_p) if raw_p is not None else 1
    if has_r:
        if raw_p is not None or chord_xy <= 1e-6:
            raise ModelError(f"Arc {cmd} ambigu au format R", 422, "unsafe_gcode")
        radius = abs(float(raw_r))
        if radius <= 1e-6 or 2.0 * radius + 1e-4 < chord_xy:
            raise ModelError(f"Rayon d'arc {cmd} R{raw_r} impossible pour la corde", 422, "unsafe_gcode")
        h = math.sqrt(max(0.0, radius * radius - (chord_xy * 0.5) ** 2))
        mx, my = (x + nx) * 0.5, (y + ny) * 0.5
        ux, uy = -(ny - y) / chord_xy, (nx - x) / chord_xy
        # G3 CCW minor (R>0): left normal (+h); G2 CW minor (R>0): right normal (-h); flip sign for R<0
        side = 1.0 if cmd == "G3" else -1.0
        if float(raw_r) < 0:
            side = -side
        cx = mx + side * h * ux
        cy = my + side * h * uy
    else:
        iv = float(raw_i or 0.0)
        jv = float(raw_j or 0.0)
        cx, cy = x + iv, y + jv
        r1 = math.hypot(iv, jv)
        r2 = math.hypot(nx - cx, ny - cy)
        if r1 <= 1e-6:
            raise ModelError(f"Rayon nul pour l'arc {cmd}", 422, "unsafe_gcode")
        if abs(r1 - r2) > max(0.08, 0.015 * max(r1, r2)):
            raise ModelError(f"Arc {cmd} géométriquement incohérent (écart rayon {abs(r1 - r2):.2f} mm)", 422, "unsafe_gcode")
        radius = max(r1, r2)

    two_pi = 2.0 * math.pi
    if chord_xy <= 1e-5:
        sweep = two_pi * max(1, turns)
        min_x, max_x = cx - radius, cx + radius
        min_y, max_y = cy - radius, cy + radius
    else:
        a0 = math.atan2(y - cy, x - cx)
        a1 = math.atan2(ny - cy, nx - cx)
        if cmd == "G3":
            sweep = (a1 - a0) % two_pi
        else:
            sweep = (a0 - a1) % two_pi
        if turns > 1:
            sweep += two_pi * (turns - 1)
        min_x, max_x = min(x, nx), max(x, nx)
        min_y, max_y = min(y, ny), max(y, ny)
        full = sweep >= two_pi - 1e-9
        for theta, px, py in (
            (0.0, cx + radius, None),
            (math.pi, cx - radius, None),
            (math.pi * 0.5, None, cy + radius),
            (-math.pi * 0.5, None, cy - radius),
        ):
            rel = ((theta - a0) % two_pi) if cmd == "G3" else ((a0 - theta) % two_pi)
            if full or rel <= sweep + 1e-7:
                if px is not None:
                    min_x = min(min_x, px)
                    max_x = max(max_x, px)
                if py is not None:
                    min_y = min(min_y, py)
                    max_y = max(max_y, py)
    arc_len = math.hypot(radius * sweep, abs(nz - z))
    return min_x, max_x, min_y, max_y, arc_len


def _validate_klipper_line(s: str, dialect: str) -> bool:
    """Validate allowlisted Klipper extended commands for Flashforge profiles."""
    parts = s.split()
    kw = parts[0].upper()
    if kw == "SET_VELOCITY_LIMIT":
        if dialect not in ("klipper_ff", "marlin_ff") or len(parts) < 2:
            raise ModelError(f"Commande G-code non autorisée ({kw})", 422, "unsafe_gcode")
        limits = {
            "VELOCITY": (0.1, 1000.0),
            "ACCEL": (1.0, 30000.0),
            "ACCEL_TO_DECEL": (1.0, 30000.0),
            "MINIMUM_CRUISE_RATIO": (0.0, 1.0),
            "SQUARE_CORNER_VELOCITY": (0.0, 50.0),
        }
        for tok in parts[1:]:
            k, sep, v = tok.partition("=")
            k_up = k.upper()
            if not sep or k_up not in limits:
                raise ModelError(f"Paramètre SET_VELOCITY_LIMIT non autorisé ({tok})", 422, "unsafe_gcode")
            try:
                num = float(v)
            except ValueError:
                raise ModelError("Paramètre SET_VELOCITY_LIMIT invalide", 422, "unsafe_gcode") from None
            lo, hi = limits[k_up]
            if not (num == num and lo <= num <= hi):
                raise ModelError(f"Valeur SET_VELOCITY_LIMIT hors limites ({tok})", 422, "unsafe_gcode")
        return True
    if kw == "SET_PRESSURE_ADVANCE":
        if dialect not in ("klipper_ff", "marlin_ff") or len(parts) < 2:
            raise ModelError(f"Commande G-code non autorisée ({kw})", 422, "unsafe_gcode")
        for tok in parts[1:]:
            k, sep, v = tok.partition("=")
            k_up = k.upper()
            if not sep or k_up not in ("ADVANCE", "SMOOTH_TIME", "EXTRUDER"):
                raise ModelError(f"Paramètre SET_PRESSURE_ADVANCE non autorisé ({tok})", 422, "unsafe_gcode")
            if k_up == "EXTRUDER":
                if not re.fullmatch(r"[A-Za-z0-9_]{1,32}", v):
                    raise ModelError("Extrudeur SET_PRESSURE_ADVANCE invalide", 422, "unsafe_gcode")
                continue
            try:
                num = float(v)
            except ValueError:
                raise ModelError("Paramètre SET_PRESSURE_ADVANCE invalide", 422, "unsafe_gcode") from None
            hi = 2.0 if k_up == "ADVANCE" else 0.5
            if not (num == num and 0.0 <= num <= hi):
                raise ModelError(f"Valeur SET_PRESSURE_ADVANCE hors limites ({tok})", 422, "unsafe_gcode")
        return True
    if kw in ("EXCLUDE_OBJECT_DEFINE", "EXCLUDE_OBJECT_START", "EXCLUDE_OBJECT_END"):
        if dialect not in ("klipper_ff", "marlin_ff"):
            raise ModelError(f"Commande Klipper non autorisée ({kw})", 422, "unsafe_gcode")
        for tok in parts[1:]:
            k, sep, v = tok.partition("=")
            k_up = k.upper()
            if not sep:
                raise ModelError(f"Paramètre {kw} invalide", 422, "unsafe_gcode")
            if k_up == "NAME":
                if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", v):
                    raise ModelError(f"Identifiant {kw} invalide", 422, "unsafe_gcode")
            elif k_up == "CENTER":
                if not re.fullmatch(r"-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?", v):
                    raise ModelError("Coordonnées CENTER invalides", 422, "unsafe_gcode")
            elif k_up == "POLYGON":
                if not re.fullmatch(r"[\[\]\d.,-]+", v) or len(v) > 8192:
                    raise ModelError("Polygone EXCLUDE_OBJECT invalide", 422, "unsafe_gcode")
            else:
                raise ModelError(f"Paramètre {kw} non autorisé ({k})", 422, "unsafe_gcode")
        return True
    return False


def preflight_gcode(path: Path, plate: int, profile: dict[str, Any]) -> dict[str, Any]:
    """Stream-validate G-code bounds, temperatures, and tool indices against a printer capability profile."""
    import math
    bed_x, bed_y, bed_z = profile.get("bed") or (256.0, 256.0, 256.0)
    origin = profile.get("origin") or (0.0, 0.0)
    ox, oy = float(origin[0]), float(origin[1])
    max_noz = float(profile.get("max_nozzle_temp") or 300.0)
    max_bed = float(profile.get("max_bed_temp") or 110.0)
    max_tools = int(profile.get("max_tools") or 16)
    dialect = str(profile.get("dialect") or "").strip().lower()
    tol_xy, tol_z = 5.0, 2.0
    ex_min_x, ex_max_x = ox - tol_xy, ox + bed_x + tol_xy
    ex_min_y, ex_max_y = oy - tol_xy, oy + bed_y + tol_xy
    ex_min_z, ex_max_z = -tol_z, bed_z + tol_z
    tbox = profile.get("travel_box")
    if tbox and len(tbox) == 6:
        txmin, txmax, tymin, tymax, tzmin, tzmax = [float(v) for v in tbox]
    else:
        txmin, txmax, tymin, tymax, tzmin, tzmax = ex_min_x, ex_max_x, ex_min_y, ex_max_y, ex_min_z, ex_max_z
    ext = path.suffix.lower()

    _SAFE_CMDS = {
        "G0", "G1", "G2", "G3", "G4", "G17", "G21", "G28", "G90", "G91", "G91.1", "G92",
        "M17", "M18", "M73", "M82", "M83", "M84",
        "M104", "M106", "M107", "M109", "M140", "M190",
        "M204", "M205", "M220", "M221", "M400", "M412",
        "M600", "M620", "M621", "M622", "M623", "M624", "M625",
        "M900", "M960", "M975", "M981", "M982", "M983", "M984", "M1002", "M1005",
    }
    _BAMBU_CMDS = {
        "G29", "G29.1", "G29.2", "G29.4", "G39", "G39.3", "G39.4", "G380", "G392", "G2814",
        "M73.2", "M142", "M191", "M201", "M201.2", "M203", "M211", "M290", "M500",
        "M620.1", "M620.3", "M620.10", "M620.11", "M622.1", "M628", "M629", "M630", "M710",
        "M963", "M964", "M969", "M970", "M970.2", "M970.3", "M971", "M972", "M973", "M974",
        "M976", "M977", "M980.3", "M982.2", "M9833", "M9833.2", "M991", "M1004", "M1006", "M1007",
    }
    _FF_MARLIN_CMDS = {"M191"}
    if not dialect or dialect == "bambu":
        _SAFE_CMDS = _SAFE_CMDS | _BAMBU_CMDS
    if not dialect or dialect == "marlin_ff":
        _SAFE_CMDS = _SAFE_CMDS | _FF_MARLIN_CMDS

    def _scan_lines(stream) -> dict[str, Any]:
        abs_xyz = True
        abs_e = True
        plane = "G17"
        x = y = z = 0.0
        e_pos = 0.0
        total_e = 0.0
        stationary_e = 0.0
        in_flush = False
        max_n = 0.0
        max_b = 0.0
        tools: set[int] = set()
        seen_bytes = 0
        for raw_line in stream:
            seen_bytes += len(raw_line)
            if seen_bytes > MAX_GCODE_BYTES:
                raise ModelError("G-code trop volumineux (> 128 Mo)", 413, "too_large")
            raw_txt = raw_line.decode("utf-8", "replace")
            head_txt, _, comment_txt = raw_txt.partition(";")
            if comment_txt:
                cm = comment_txt.strip().upper()
                if cm.startswith("FLUSH_START"):
                    in_flush = True
                elif cm.startswith("FLUSH_END"):
                    in_flush = False
            s = head_txt.strip()
            if not s:
                continue
            head_kw = s.split(None, 1)[0].upper()
            if "_" in head_kw and _validate_klipper_line(s, dialect):
                continue
            if head_kw == "M1002" and (not dialect or dialect == "bambu"):
                if not re.fullmatch(r"M1002(?:\s+[A-Za-z0-9_.:=-]+)*", s):
                    raise ModelError("Paramètre M1002 non autorisé", 422, "unsafe_gcode")
                continue
            tokens = re.findall(r"[A-Za-z][^A-Za-z\s]*", s)
            if not tokens or "".join(tokens) != re.sub(r"\s+", "", s):
                raise ModelError("Syntaxe G-code non reconnue", 422, "unsafe_gcode")
            cmd = tokens[0].upper()
            if cmd.startswith("T"):
                if not re.fullmatch(r"T\d+", cmd):
                    raise ModelError("Commande d'outil invalide dans le G-code", 422, "unsafe_gcode")
                t_idx = int(cmd[1:])
                if (not dialect or dialect == "bambu") and t_idx in (255, 1000):
                    continue
                if t_idx >= max_tools:
                    raise ModelError(f"Extrudeur T{t_idx} non supporté (max {max_tools})", 422, "tool_out_of_range")
                tools.add(t_idx)
                continue
            if cmd not in _SAFE_CMDS:
                raise ModelError(f"Commande G-code non autorisée ({cmd})", 422, "unsafe_gcode")
            if cmd == "G17":
                plane = "G17"
                continue
            if cmd == "G91.1":
                continue
            if cmd == "G90":
                abs_xyz = True
                continue
            if cmd == "G91":
                abs_xyz = False
                continue
            if cmd == "M82":
                abs_e = True
                continue
            if cmd == "M83":
                abs_e = False
                continue
            if cmd == "G92":
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    if ax != "E":
                        raise ModelError(f"G92 autorisé uniquement sur E ({ax} refusé)", 422, "unsafe_gcode")
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError("Paramètre G92 E invalide", 422, "unsafe_gcode") from None
                    if not math.isfinite(val) or abs(val) > 500.0:
                        raise ModelError("Réinitialisation G92 E hors limites", 422, "unsafe_gcode")
                    e_pos = val
                continue
            if cmd == "G4":
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError("Paramètre G4 invalide", 422, "unsafe_gcode") from None
                    if not math.isfinite(val) or val < 0:
                        raise ModelError("Temporisation G4 invalide", 422, "unsafe_gcode")
                    if ax == "P" and val > 60000:
                        raise ModelError("Temporisation G4 P > 60s", 422, "unsafe_gcode")
                    elif ax == "S" and val > 60:
                        raise ModelError("Temporisation G4 S > 60s", 422, "unsafe_gcode")
                    elif ax not in ("P", "S"):
                        raise ModelError(f"Paramètre G4 non autorisé ({ax})", 422, "unsafe_gcode")
                continue
            if cmd == "M900":
                bambu_like = (not dialect or dialect == "bambu")
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    if bambu_like and tok.upper() in ("S", "C", "R"):
                        continue
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError("Paramètre M900 invalide", 422, "unsafe_gcode") from None
                    if not math.isfinite(val):
                        raise ModelError("Paramètre M900 NaN/Inf", 422, "unsafe_gcode")
                    if ax == "K" and not (0 <= val <= 2.0):
                        raise ModelError(f"Advance M900 {ax}{val} hors limites (0–2.0)", 422, "unsafe_gcode")
                    elif ax == "L" and not (0 <= val <= (2000.0 if bambu_like else 2.0)):
                        raise ModelError(f"Advance M900 {ax}{val} hors limites", 422, "unsafe_gcode")
                    elif ax == "M":
                        if not bambu_like or not (0 <= val <= 10.0):
                            raise ModelError(f"Paramètre M900 M{val} hors limites", 422, "unsafe_gcode")
                    elif ax == "T" and (val != int(val) or not (0 <= val < max_tools)):
                        raise ModelError(f"Outil M900 T{val} invalide", 422, "tool_out_of_range")
                    elif ax == "S" and not (0 <= val <= (10 if bambu_like else 1)):
                        raise ModelError(f"Paramètre M900 S{val} invalide", 422, "unsafe_gcode")
                    elif ax not in ("K", "L", "M", "T", "S"):
                        raise ModelError(f"Paramètre M900 non autorisé ({ax})", 422, "unsafe_gcode")
                continue
            if cmd in ("M620", "M621"):
                bambu_like = (not dialect or dialect == "bambu")
                for tok in tokens[1:]:
                    if bambu_like and tok.upper() in ("M", "A", "B"):
                        continue
                    ax = tok[:1].upper()
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError(f"Paramètre {cmd} invalide", 422, "unsafe_gcode") from None
                    if not math.isfinite(val) or val != int(val):
                        raise ModelError(f"Paramètre {cmd} non entier", 422, "unsafe_gcode")
                    if ax == "S" and not (0 <= val <= 255):
                        raise ModelError(f"Slot {cmd} S{int(val)} hors limites", 422, "unsafe_gcode")
                    elif ax == "P" and not (0 <= val < max_tools):
                        raise ModelError(f"Outil {cmd} P{int(val)} hors limites", 422, "tool_out_of_range")
                    elif ax not in ("S", "P"):
                        raise ModelError(f"Paramètre {cmd} non autorisé ({ax})", 422, "unsafe_gcode")
                continue
            if cmd == "M620.1":
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    if ax == "E" and len(tok) == 1:
                        continue
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError("Paramètre M620.1 invalide", 422, "unsafe_gcode") from None
                    if not math.isfinite(val):
                        raise ModelError("Paramètre M620.1 NaN/Inf", 422, "unsafe_gcode")
                    if ax == "T" and not (0 <= val <= max_noz):
                        raise ModelError(f"Température M620.1 T{val:.0f}°C > limite", 422, "temp_out_of_range")
                    elif ax == "F" and not (0 < val <= 60000):
                        raise ModelError("Vitesse M620.1 F hors limites", 422, "unsafe_gcode")
                    elif ax not in ("E", "F", "T", "S", "P"):
                        raise ModelError(f"Paramètre M620.1 non autorisé ({ax})", 422, "unsafe_gcode")
                continue
            if cmd in ("M104", "M109", "M140", "M190", "M142", "M191"):
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    if ax == "T" and cmd in ("M104", "M109"):
                        try:
                            t_idx = int(tok[1:])
                        except ValueError:
                            raise ModelError(f"Sélecteur d'outil invalide ({tok})", 422, "unsafe_gcode") from None
                        if t_idx < 0 or t_idx >= max_tools:
                            raise ModelError(f"Extrudeur T{t_idx} non supporté (max {max_tools})", 422, "tool_out_of_range")
                        tools.add(t_idx)
                        continue
                    if ax == "P" and cmd in ("M142", "M191"):
                        continue
                    if ax == "N" and cmd in ("M104", "M109") and dialect in ("klipper_ff", "marlin_ff"):
                        if tok[1:] not in ("0", "1"):
                            raise ModelError(f"Paramètre {cmd} N invalide ({tok})", 422, "unsafe_gcode")
                        continue
                    if ax == "H" and cmd == "M109" and (not dialect or dialect == "bambu"):
                        try:
                            ht = float(tok[1:])
                        except ValueError:
                            raise ModelError("Paramètre M109 H invalide", 422, "unsafe_gcode") from None
                        if not math.isfinite(ht) or ht < 0 or ht > max_noz:
                            raise ModelError(f"Température M109 H{ht:.0f}°C hors limites", 422, "temp_out_of_range")
                        continue
                    if ax not in ("S", "R"):
                        raise ModelError(f"Paramètre {cmd} non autorisé ({ax})", 422, "unsafe_gcode")
                    try:
                        temp = float(tok[1:])
                    except ValueError:
                        raise ModelError("Consigne thermique invalide dans le G-code", 422, "unsafe_gcode") from None
                    if not math.isfinite(temp) or temp < 0:
                        raise ModelError("Température invalide dans le G-code", 422, "unsafe_gcode")
                    if cmd in ("M104", "M109"):
                        max_n = max(max_n, temp)
                        if temp > max_noz:
                            raise ModelError(f"Température buse {temp:.0f}°C > limite {max_noz:.0f}°C", 422, "temp_out_of_range")
                    elif cmd in ("M142", "M191"):
                        if temp > 70.0:
                            raise ModelError(f"Température enceinte {temp:.0f}°C > limite 70°C", 422, "temp_out_of_range")
                    else:
                        max_b = max(max_b, temp)
                        if temp > max_bed:
                            raise ModelError(f"Température plateau {temp:.0f}°C > limite {max_bed:.0f}°C", 422, "temp_out_of_range")
                continue
            if cmd in ("M201", "M201.2", "M203"):
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError(f"Paramètre invalide pour {cmd}", 422, "unsafe_gcode") from None
                    if ax not in ("X", "Y", "Z", "E", "P", "T", "S", "K") or not math.isfinite(val) or not (0 <= val <= 100000):
                        raise ModelError(f"Paramètre {cmd} hors limites ({tok})", 422, "unsafe_gcode")
                continue
            if cmd in ("M220", "M221", "M204", "M205"):
                bambu_like = (not dialect or dialect == "bambu")
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    if cmd == "M221" and bambu_like and tok.upper() in ("S", "R"):
                        continue
                    if cmd == "M220" and bambu_like and tok.upper() in ("B", "R"):
                        continue
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError(f"Paramètre invalide pour {cmd}", 422, "unsafe_gcode") from None
                    if not math.isfinite(val):
                        raise ModelError(f"Paramètre NaN/Inf pour {cmd}", 422, "unsafe_gcode")
                    if cmd == "M220":
                        if ax != "S" or not (10 <= val <= 200):
                            raise ModelError(f"Paramètre M220 {ax}{val:.0f} hors limites (S 10–200%)", 422, "unsafe_gcode")
                    elif cmd == "M221":
                        if ax == "S" and not (50 <= val <= 150):
                            raise ModelError(f"Débit M221 S{val:.0f}% hors limites (50–150%)", 422, "unsafe_gcode")
                        elif ax == "T":
                            if val != int(val):
                                raise ModelError(f"Outil M221 fractionnaire refusé ({tok})", 422, "unsafe_gcode")
                            if not (0 <= val < max_tools):
                                raise ModelError(f"Outil M221 T{int(val)} non supporté (max {max_tools})", 422, "tool_out_of_range")
                            tools.add(int(val))
                        elif bambu_like and ax in ("X", "Y", "Z"):
                            if not (0 <= val <= 100):
                                raise ModelError(f"Paramètre M221 {ax}{val:.0f} hors limites", 422, "unsafe_gcode")
                        elif ax not in ("S", "T"):
                            raise ModelError(f"Paramètre M221 non autorisé ({ax})", 422, "unsafe_gcode")
                    elif cmd == "M204":
                        if ax not in ("S", "P", "T", "R") or not (1 <= val <= 30000):
                            raise ModelError(f"Accélération M204 {ax}{val:.0f} hors limites", 422, "unsafe_gcode")
                    elif cmd == "M205":
                        limits = {"X": 50.0, "Y": 50.0, "Z": 20.0, "E": 50.0, "J": 1.0}
                        if ax not in limits or not (0 <= val <= limits[ax]):
                            raise ModelError(f"Paramètre M205 {ax}{val:.0f} hors limites", 422, "unsafe_gcode")
                continue
            if cmd in ("G0", "G1", "G2", "G3"):
                nx, ny, nz = x, y, z
                has_xyz = False
                move_de: float | None = None
                arc_i: float | None = None
                arc_j: float | None = None
                arc_k: float | None = None
                arc_r: float | None = None
                arc_p: int | None = None
                allowed_axes = ("X", "Y", "Z", "F", "E") if cmd in ("G0", "G1") else ("X", "Y", "Z", "I", "J", "K", "R", "P", "F", "E")
                seen_arc_axes: set[str] = set()
                for tok in tokens[1:]:
                    ax = tok[:1].upper()
                    if ax not in allowed_axes:
                        raise ModelError(f"Paramètre {cmd} non autorisé ({ax})", 422, "unsafe_gcode")
                    if cmd in ("G2", "G3"):
                        if ax in seen_arc_axes:
                            raise ModelError(f"Paramètre d'arc {cmd} dupliqué ({ax})", 422, "unsafe_gcode")
                        seen_arc_axes.add(ax)
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        raise ModelError("Paramètre de mouvement invalide dans le G-code", 422, "unsafe_gcode") from None
                    if not math.isfinite(val):
                        raise ModelError("Coordonnée NaN/Inf dans le G-code", 422, "unsafe_gcode")
                    if ax == "P":
                        if val != int(val) or not (1 <= val <= 100):
                            raise ModelError(f"Paramètre d'arc {cmd} P{val} hors limites", 422, "unsafe_gcode")
                        arc_p = int(val)
                    elif ax == "F":
                        if val <= 0 or val > 60000:
                            raise ModelError(f"Vitesse d'avance hors limites ({val})", 422, "unsafe_gcode")
                    elif ax == "E":
                        de = val if not abs_e else (val - e_pos)
                        e_pos = (e_pos + val) if not abs_e else val
                        if abs(de) > 100.0:
                            raise ModelError(f"Extrusion par segment hors limites ({de:.1f} mm)", 422, "unsafe_gcode")
                        if de > 0:
                            total_e += de
                            if total_e > 250000.0:
                                raise ModelError("Extrusion cumulée excessive (> 250 m)", 422, "unsafe_gcode")
                        move_de = de
                    elif ax == "X":
                        nx = val if abs_xyz else x + val
                        has_xyz = True
                    elif ax == "Y":
                        ny = val if abs_xyz else y + val
                        has_xyz = True
                    elif ax == "Z":
                        nz = val if abs_xyz else z + val
                        has_xyz = True
                    elif ax in ("I", "J", "K", "R"):
                        if abs(val) > 500.0:
                            raise ModelError(f"Paramètre d'arc {cmd} {ax}{val:.1f} hors limites", 422, "unsafe_gcode")
                        if ax == "I":
                            arc_i = val
                        elif ax == "J":
                            arc_j = val
                        elif ax == "K":
                            arc_k = val
                        elif ax == "R":
                            arc_r = val
                if cmd in ("G2", "G3"):
                    if plane != "G17":
                        raise ModelError(f"Plan d'arc non supporté ({plane})", 422, "unsafe_gcode")
                    path_min_x, path_max_x, path_min_y, path_max_y, xyz_dist = _arc_extrema_and_length(
                        cmd, x, y, z, nx, ny, nz, arc_i, arc_j, arc_k, arc_r, arc_p,
                    )
                    path_min_z, path_max_z = min(z, nz), max(z, nz)
                else:
                    xyz_dist = math.sqrt((nx - x) ** 2 + (ny - y) ** 2 + (nz - z) ** 2)
                    path_min_x = path_max_x = nx
                    path_min_y = path_max_y = ny
                    path_min_z = path_max_z = nz
                if xyz_dist > 0.5:
                    stationary_e = 0.0
                extruding = move_de is not None and move_de > 0
                if extruding:
                    if xyz_dist <= 0.05:
                        stationary_e += move_de
                        bambu_flush = (not has_xyz and (not dialect or dialect == "bambu")
                                       and (in_flush or x < 0 or x > bed_x or y > bed_y))
                        stat_cap = 250.0 if bambu_flush else 50.0
                        if move_de > 50.0 or stationary_e > stat_cap:
                            raise ModelError(f"Purge/extrusion stationnaire hors limites ({stationary_e:.1f} mm)", 422, "unsafe_gcode")
                    elif (move_de / xyz_dist) > 10.0:
                        raise ModelError(
                            f"Ratio extrusion/déplacement excessif ({move_de:.1f} mm sur {xyz_dist:.2f} mm)",
                            422, "unsafe_gcode",
                        )
                if extruding and xyz_dist > 0.05:
                    if (path_min_x < ex_min_x or path_max_x > ex_max_x
                            or path_min_y < ex_min_y or path_max_y > ex_max_y
                            or path_min_z < ex_min_z or path_max_z > ex_max_z):
                        raise ModelError(
                            f"Extrusion hors plateau ({path_min_x:.1f}..{path_max_x:.1f}, {path_min_y:.1f}..{path_max_y:.1f}, {path_max_z:.1f}) > {bed_x:.0f}×{bed_y:.0f}×{bed_z:.0f} mm",
                            422, "out_of_bounds",
                        )
                if (path_min_x < txmin or path_max_x > txmax
                        or path_min_y < tymin or path_max_y > tymax
                        or path_min_z < tzmin or path_max_z > tzmax):
                    raise ModelError(
                        f"Mouvement hors volume ({path_min_x:.1f}..{path_max_x:.1f}, {path_min_y:.1f}..{path_max_y:.1f}, {path_max_z:.1f}) > {bed_x:.0f}×{bed_y:.0f}×{bed_z:.0f} mm",
                        422, "out_of_bounds",
                    )
                x, y, z = nx, ny, nz
        return {"max_nozzle": max_n, "max_bed": max_b, "tools": sorted(tools)}

    if ext in (".gcode", ".gx"):
        if path.stat().st_size > MAX_GCODE_BYTES:
            raise ModelError("G-code trop volumineux (> 128 Mo)", 413, "too_large")
        with open(path, "rb") as fh:
            return _scan_lines(fh)
    if ext == ".3mf":
        try:
            with zipfile.ZipFile(path) as zf:
                target = f"Metadata/plate_{int(plate)}.gcode"
                info = zf.getinfo(target)
                if info.file_size > MAX_GCODE_BYTES:
                    raise ModelError("G-code du 3MF trop volumineux (> 128 Mo)", 413, "too_large")
                with zf.open(info) as fh:
                    return _scan_lines(fh)
        except KeyError:
            raise ModelError(f"Plateau {plate} absent du 3MF", 422, "not_sliced") from None
        except (zipfile.BadZipFile, OSError):
            raise ModelError("3MF illisible", 422, "unreadable") from None
    raise ModelError("Format non vérifiable", 422, "unsupported")
BAMBU_MODELS = {"N1": "A1 mini", "N2S": "A1", "C11": "P1P", "C12": "P1S", "C13": "X1E",
                "BL-P001": "X1 Carbon", "BL-P002": "X1", "N6": "H2D"}


def parse_slice_info(raw: bytes, plate: int = 1) -> dict[str, Any]:
    """Printer model, filaments (type, colour, grams, metres), time and weight of one plate
    from Bambu's ``slice_info.config``."""
    import xml.etree.ElementTree as ET
    if len(raw) > MAX_SLICE_INFO or b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
        return {}
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return {}
    chosen = None
    for candidate in root.findall("plate"):
        idx = {m.get("key"): m.get("value") for m in candidate.findall("metadata")}.get("index")
        if str(idx) == str(int(plate)):
            chosen = candidate
            break
    if chosen is None:
        return {}
    meta = {m.get("key"): m.get("value") for m in chosen.findall("metadata")}

    def number(value: Any) -> float | None:
        try:
            f = float(value)
        except (TypeError, ValueError):
            return None
        return f if f == f and f >= 0 else None

    filaments = []
    for f in chosen.findall("filament")[:16]:
        colour = str(f.get("color") or "")
        fid = str(f.get("id") or "")
        filaments.append({"id": int(fid) if fid.isdigit() else 0,
                          "type": str(f.get("type") or "")[:24],
                          "colour": colour.upper() if re.fullmatch(r"#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", colour) else "",
                          "g": number(f.get("used_g")), "m": number(f.get("used_m"))})
    model_id = str(meta.get("printer_model_id") or "")
    prediction = number(meta.get("prediction"))
    weight = number(meta.get("weight"))
    objects = []
    for obj in chosen.findall("object")[:64]:
        oid = str(obj.get("identify_id") or obj.get("id") or "")
        if oid.isdigit():
            objects.append({"id": int(oid), "name": str(obj.get("name") or f"Objet {oid}")[:64]})
    return {"printer_model": BAMBU_MODELS.get(model_id, model_id[:16]), "filaments": filaments,
            "prediction_sec": int(prediction) if prediction else None,
            "weight_g": round(weight, 1) if weight else None,
            "objects": objects}


def _fallback_project_model(zf: "zipfile.ZipFile") -> str:
    """Resolve canonical printer model from verified ``Metadata/project_settings.config``."""
    import json
    if "Metadata/project_settings.config" not in zf.namelist():
        return ""
    info = zf.getinfo("Metadata/project_settings.config")
    if info.file_size > MAX_SLICE_INFO * 4:
        return ""
    try:
        with zf.open(info) as fh:
            data = json.loads(fh.read(MAX_SLICE_INFO * 4 + 1).decode("utf-8", "replace"))
    except Exception:
        return ""
    if not isinstance(data, dict):
        return ""
    return resolve_vendor_model_name(str(data.get("printer_model") or ""))


def parse_all_plates(zf: "zipfile.ZipFile", plate_nums: list[int]) -> list[dict[str, Any]]:
    """Return metadata for every plate present in a sliced 3MF."""
    names = set(zf.namelist())
    raw = b""
    if "Metadata/slice_info.config" in names:
        info = zf.getinfo("Metadata/slice_info.config")
        if info.file_size <= MAX_SLICE_INFO:
            raw = zf.read(info)
    out = []
    proj_model: str | None = None
    for num in plate_nums:
        row = parse_slice_info(raw, num) if raw else {}
        pm = row.get("printer_model") or ""
        if row and not pm:
            if proj_model is None:
                proj_model = _fallback_project_model(zf)
            pm = proj_model
        out.append({
            "plate": num,
            "printer_model": pm,
            "filaments": row.get("filaments") or [],
            "prediction_sec": row.get("prediction_sec"),
            "weight_g": row.get("weight_g"),
            "objects": row.get("objects") or [],
            "has_thumb": f"Metadata/plate_{num}.png" in names or f"Metadata/plate_{num}_small.png" in names,
        })
    return out


def parse_gcode_header(raw: bytes) -> list[dict[str, Any]]:
    """Filament types named in a slicer's G-code header comments (``; filament_type = PLA;PETG``),
    with their colours when the same header names them. No header means no filaments: nothing is
    inferred from the file name or the toolpaths."""
    types: list[str] = []
    colours: list[str] = []
    for line in raw.decode("utf-8", "replace").splitlines()[:4000]:
        if not line.startswith(";"):
            continue
        key, _, value = line[1:].partition("=")
        key = key.strip().lower()
        if key not in ("filament_type", "filament_colour", "filament_color", "extruder_colour", "extruder_color"):
            continue
        parts = [p.strip().strip('"') for p in value.split(";")][:16]
        parts = [p for p in parts if p]
        if key == "filament_type" and not types:
            types = parts
        elif key != "filament_type" and not colours:
            colours = parts
    out = []
    for i, kind in enumerate(types):
        colour = colours[i] if i < len(colours) else ""
        out.append({"id": i + 1, "type": kind[:24],
                    "colour": colour.upper() if re.fullmatch(r"#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?", colour) else "",
                    "g": None, "m": None})
    return out


def read_slice_info(zf: "zipfile.ZipFile", plate: int = 1) -> dict[str, Any]:
    """``parse_slice_info`` from an open 3MF, bounded."""
    if "Metadata/slice_info.config" not in zf.namelist():
        return {}
    info = zf.getinfo("Metadata/slice_info.config")
    if info.file_size > MAX_SLICE_INFO:
        return {}
    with zf.open(info) as fh:
        row = parse_slice_info(fh.read(MAX_SLICE_INFO + 1), plate)
    if row and not row.get("printer_model"):
        pm = _fallback_project_model(zf)
        if pm:
            row["printer_model"] = pm
    return row


def _is_link(path: Path) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return True
    if stat.S_ISLNK(st.st_mode):
        return True
    attrs = getattr(st, "st_file_attributes", 0)
    return bool(attrs & 0x400)       # FILE_ATTRIBUTE_REPARSE_POINT (junctions)


class Library:
    def __init__(self, state_dir: Path, roots: Callable[[], dict[str, Path | None]]) -> None:
        self._state_dir = state_dir
        self._roots = roots
        self._lock = threading.RLock()
        self._cache: list[dict[str, Any]] = []
        self._by_id: dict[str, dict[str, Any]] = {}
        self._scanned_at = 0.0

    # ── metadata ──
    def _meta_path(self) -> Path:
        return self._state_dir / "models.json"

    def _read_meta(self) -> dict[str, Any]:
        p = self._meta_path()
        if not p.is_file():
            return {"models": {}}
        try:
            import json
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ModelError("métadonnées illisibles — fichier conservé", 409, "state_unreadable") from exc
        if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
            raise ModelError("métadonnées illisibles — fichier conservé", 409, "state_unreadable")
        return data

    # ── scan ──
    @staticmethod
    def model_id(root_key: str, rel: str) -> str:
        return hashlib.sha1(f"{root_key}:{rel}".encode("utf-8")).hexdigest()[:16]

    def _walk(self, root_key: str, root: Path, out: list[dict[str, Any]]) -> None:
        try:
            base = root.resolve(strict=True)
        except OSError:
            return
        if _is_link(root) or not base.is_dir():
            return
        stack: list[tuple[Path, int]] = [(base, 0)]
        while stack and len(out) < MAX_FILES:
            folder, depth = stack.pop()
            try:
                entries = list(os.scandir(folder))
            except OSError:
                continue
            for entry in entries:
                if entry.name.startswith(".") or entry.name.startswith("~$"):
                    continue
                p = Path(entry.path)
                if _is_link(p):
                    continue
                try:
                    if entry.is_dir(follow_symlinks=False):
                        if depth < MAX_DEPTH:
                            stack.append((p, depth + 1))
                        continue
                    if not entry.is_file(follow_symlinks=False):
                        continue
                    ext = p.suffix.lower()
                    if ext not in MODEL_EXT:
                        continue
                    st = entry.stat(follow_symlinks=False)
                except OSError:
                    continue
                rel = p.relative_to(base).as_posix()
                mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
                out.append({"id": self.model_id(root_key, rel), "root": root_key, "rel": rel,
                            "name": p.name, "folder": str(Path(rel).parent.as_posix()).strip("."),
                            "ext": ext[1:], "size": st.st_size, "mtime": int(st.st_mtime),
                            "version": f"{st.st_size}:{mtime_ns}"})

    def scan(self, force: bool = False) -> list[dict[str, Any]]:
        with self._lock:
            if not force and self._cache and time.monotonic() - self._scanned_at < SCAN_TTL:
                return self._cache
            if force:
                with _STL_BOUNDS_LOCK:
                    _STL_BOUNDS_CACHE.clear()
                    _SOURCE_SHA_CACHE.clear()
            rows: list[dict[str, Any]] = []
            for key, root in (self._roots() or {}).items():
                if root:
                    self._walk(key, Path(root), rows)
            rows.sort(key=lambda r: r["mtime"], reverse=True)
            self._cache = rows
            self._by_id = {r["id"]: r for r in rows}
            self._scanned_at = time.monotonic()
            return rows

    def _with_meta(self, row: dict[str, Any], meta: dict[str, Any],
                   prov: dict[str, Any] | None = None) -> dict[str, Any]:
        m = meta.get(row["id"]) if isinstance(meta.get(row["id"]), dict) else {}
        out = dict(row)
        out.update({"tags": list(m.get("tags") or []), "notes": str(m.get("notes") or ""),
                    "origin": m.get("origin") if m.get("origin") in ORIGINS else "",
                    "printed_count": int(m.get("printed_count") or 0),
                    "makerworld_design_id": int(m.get("makerworld_design_id") or 0),
                    "has_thumb": row["ext"] == "3mf"})
        p = prov if prov is not None else self.get_slice_provenance(row["id"])
        if isinstance(p, dict):
            if p.get("slice_sha256"):
                out["slice_sha256"] = p["slice_sha256"]
            if isinstance(p.get("slice_settings"), dict):
                out["slice_settings"] = dict(p["slice_settings"])
        return out


    def list(self, query: str = "", origin: str = "", tag: str = "", limit: int = 500,
             brief: bool = False, offset: int = 0) -> dict[str, Any]:
        """``brief`` drops ``notes``/``printed_count`` from the rows (the grid shows neither);
        ``offset`` pages through a library bigger than one page (``total`` is always the full match)."""
        rows = self.scan()
        meta = self._read_meta()["models"]
        prov_map = self._all_slice_provenance()
        q = (query or "").strip().lower()
        out = []
        tags: dict[str, int] = {}
        for row in rows:
            full = self._with_meta(row, meta, prov=prov_map.get(row["id"]) or {})
            for t in full["tags"]:
                tags[t] = tags.get(t, 0) + 1
            if origin and full["origin"] != origin:
                continue
            if tag and tag not in full["tags"]:
                continue
            if q and q not in (full["name"] + " " + full["folder"] + " " + " ".join(full["tags"]) + " "
                               + full["notes"]).lower():
                continue
            out.append(full)
        start = max(0, int(offset))
        rows_out = out[start:start + max(1, min(2000, limit))]
        if brief:   # the search still matched note text; the payload does not carry it
            rows_out = [{k: v for k, v in m.items() if k not in ("notes", "printed_count")} for m in rows_out]
        return {"models": rows_out, "total": len(out), "indexed": len(rows),
                "tags": sorted(tags.items(), key=lambda kv: (-kv[1], kv[0]))[:60]}

    def get(self, model_id: str) -> dict[str, Any]:
        self.scan()
        row = self._by_id.get(str(model_id or ""))
        if row is None:
            self.scan(force=True)
            row = self._by_id.get(str(model_id or ""))
        if row is None:
            raise ModelError("Modèle introuvable", 404, "not_found")
        out = self._with_meta(row, self._read_meta()["models"])
        try:
            confined = self._resolve_row_path(row)
        except ModelError:
            confined = None
        if confined is not None:
            sha = _source_sha256_path(confined)
            if sha:
                out["source_sha256"] = sha
                out["version"] = sha
            if row["ext"] == "stl":
                b = stl_bounds(confined)
                if b:
                    out["bounds_mm"] = b["dims_mm"]
                    out["triangles"] = b["triangles"]
        return out

    def update_meta(self, model_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        self.get(model_id)
        with hq_state.path_lock(self._meta_path()):
            data = self._read_meta()
            m = dict(data["models"].get(model_id) or {})
            if "tags" in changes:
                raw = changes["tags"]
                if isinstance(raw, str):
                    raw = raw.split(",")
                if not isinstance(raw, list):
                    raise ModelError("Étiquettes invalides")
                tags = []
                for t in raw:
                    t = str(t).strip().lower()[:32]
                    if t and t not in tags:
                        tags.append(t)
                m["tags"] = tags[:MAX_TAGS]
            if "notes" in changes:
                m["notes"] = str(changes["notes"] or "")[:MAX_NOTE]
            if "origin" in changes:
                if changes["origin"] not in ORIGINS + ("",):
                    raise ModelError("Origine invalide")
                m["origin"] = changes["origin"]
            if "printed_count" in changes:
                try:
                    m["printed_count"] = max(0, min(100000, int(changes["printed_count"])))
                except (TypeError, ValueError):
                    raise ModelError("Compteur invalide") from None
            if "makerworld_design_id" in changes:
                try:
                    m["makerworld_design_id"] = max(0, int(changes["makerworld_design_id"] or 0))
                except (TypeError, ValueError):
                    raise ModelError("Identifiant MakerWorld invalide") from None
            data["models"][model_id] = m
            self._state_dir.mkdir(parents=True, exist_ok=True)
            try:
                hq_state.write_json_atomic(self._meta_path(), data)
            except RuntimeError as exc:
                raise ModelError(str(exc), 409, "state_unreadable") from exc
        return self.get(model_id)

    def _provenance_db_path(self) -> Path:
        return self._state_dir / "slice_provenance.db"

    def _provenance_conn(self) -> sqlite3.Connection:
        self._state_dir.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(self._provenance_db_path()), timeout=5.0, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS slice_provenance ("
            "model_id TEXT PRIMARY KEY, "
            "source_kind TEXT NOT NULL, "
            "rel_path TEXT NOT NULL, "
            "slice_sha256 TEXT NOT NULL, "
            "settings_json TEXT NOT NULL, "
            "sliced_at INTEGER NOT NULL)"
        )
        return conn

    def get_slice_provenance(self, model_id: str) -> dict[str, Any] | None:
        """Read durable slice provenance for model_id; fail closed if DB is unreadable."""
        mid = str(model_id or "").strip()
        if not mid or not self._provenance_db_path().is_file():
            return None
        try:
            conn = self._provenance_conn()
            try:
                row = conn.execute(
                    "SELECT source_kind, rel_path, slice_sha256, settings_json, sliced_at "
                    "FROM slice_provenance WHERE model_id=?",
                    (mid,),
                ).fetchone()
            finally:
                conn.close()
            if not row:
                return None
            settings = json.loads(row[3]) if row[3] else {}
            if not isinstance(settings, dict):
                raise ValueError("settings_json must be an object")
            return {
                "source_kind": str(row[0] or "sliced"),
                "rel_path": str(row[1] or ""),
                "slice_sha256": str(row[2] or "").lower(),
                "slice_settings": settings,
                "sliced_at": int(row[4] or 0),
            }
        except (sqlite3.Error, ValueError, OSError) as exc:
            raise ModelError("Base de provenance de tranchage illisible", 409, "state_unreadable") from exc

    def _all_slice_provenance(self) -> dict[str, dict[str, Any]]:
        if not self._provenance_db_path().is_file():
            return {}
        out: dict[str, dict[str, Any]] = {}
        try:
            conn = self._provenance_conn()
            try:
                rows = conn.execute(
                    "SELECT model_id, source_kind, rel_path, slice_sha256, settings_json, sliced_at "
                    "FROM slice_provenance"
                ).fetchall()
            finally:
                conn.close()
            for r in rows:
                try:
                    settings = json.loads(r[4]) if r[4] else {}
                    if not isinstance(settings, dict):
                        settings = {}
                except ValueError:
                    settings = {}
                out[str(r[0])] = {
                    "source_kind": str(r[1] or "sliced"),
                    "rel_path": str(r[2] or ""),
                    "slice_sha256": str(r[3] or "").lower(),
                    "slice_settings": settings,
                    "sliced_at": int(r[5] or 0),
                }
            return out
        except (sqlite3.Error, OSError) as exc:
            raise ModelError("Base de provenance de tranchage illisible", 409, "state_unreadable") from exc

    def _record_slice_meta(self, model_id: str, digest: str, slice_settings: dict[str, Any], *,
                           rel_path: str = "", source_kind: str = "sliced") -> None:
        mid = str(model_id or "").strip()
        sha = str(digest or "").strip().lower()
        if not mid or not _SHA256_RE.fullmatch(sha):
            raise ModelError("Identifiant ou empreinte SHA-256 de tranchage invalide", 500, "slice_registration_failed")
        payload_json = json.dumps(dict(slice_settings or {}), sort_keys=True, ensure_ascii=False)
        now_ts = int(time.time())
        try:
            conn = self._provenance_conn()
            try:
                conn.execute("BEGIN IMMEDIATE")
                conn.execute(
                    "INSERT OR REPLACE INTO slice_provenance "
                    "(model_id, source_kind, rel_path, slice_sha256, settings_json, sliced_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (mid, str(source_kind or "sliced"), str(rel_path or ""), sha, payload_json, now_ts),
                )
                conn.execute("COMMIT")
            except Exception:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            finally:
                conn.close()
        except ModelError:
            raise
        except (sqlite3.Error, OSError, ValueError, RuntimeError) as exc:
            raise ModelError("Échec d'enregistrement durable de l'empreinte de tranchage", 503, "slice_registration_failed") from exc

    # ── file access ──
    def _resolve_row_path(self, row: dict[str, Any]) -> Path:
        """Confinement-checked real path resolution without triggering get() recursion."""
        root = (self._roots() or {}).get(row["root"])
        if not root:
            raise ModelError("Dossier indisponible", 404, "not_found")
        if _is_link(Path(root)):
            raise ModelError("Lien refusé", 403, "forbidden")
        try:
            base = Path(root).resolve(strict=True)
        except OSError:
            raise ModelError("Dossier indisponible", 404, "not_found") from None
        target = base.joinpath(*row["rel"].split("/"))
        cur = base
        for part in row["rel"].split("/"):
            cur = cur / part
            if _is_link(cur):
                raise ModelError("Lien refusé", 403, "forbidden")
        try:
            real = target.resolve(strict=True)
        except OSError:
            raise ModelError("Modèle introuvable", 404, "not_found") from None
        try:
            real.relative_to(base)
        except ValueError:
            raise ModelError("Hors du dossier", 403, "forbidden") from None
        if not real.is_file():
            raise ModelError("Modèle introuvable", 404, "not_found")
        return real

    def resolve(self, model_id: str) -> Path:
        return self._resolve_row_path(self.get(model_id))

    def open_file(self, model_id: str) -> tuple[Any, int, str]:
        path = self.resolve(model_id)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > MAX_SERVE:
            os.close(fd)
            raise ModelError("Fichier trop grand", 413, "too_large")
        return os.fdopen(fd, "rb"), st.st_size, path.name

    def open_file_with_sha(self, model_id: str) -> tuple[Any, int, str, str]:
        """Open confined regular file and compute authoritative SHA-256 directly from its fd."""
        fh, size, name = self.open_file(model_id)
        try:
            h = hashlib.sha256()
            while True:
                chunk = fh.read(256 * 1024)
                if not chunk:
                    break
                h.update(chunk)
            fh.seek(0)
            return fh, size, name, h.hexdigest().lower()
        except Exception:
            fh.close()
            raise

    @staticmethod
    def _find_xgcode_offset(head: bytes) -> int:
        """Locate the ASCII G-code start inside a FlashForge binary ``xgcode 1.0`` .gx header."""
        for m in re.finditer(rb"(?:\r?\n)([;GMT][^\r\n]{0,120})", head):
            pos = m.start(1)
            sample = head[pos:pos + 256]
            if b"\x00" in sample:
                continue
            try:
                sample.decode("utf-8")
                return pos
            except UnicodeDecodeError:
                continue
        return -1

    def open_gcode(self, model_id: str, plate: int = 1) -> GcodeStream:
        """Open a confined, size- and ZIP-bomb-bounded read-only G-code stream.

        Supports plain ``.gcode``, FlashForge ``.gx`` (text or ``xgcode`` header),
        and ``Metadata/plate_N.gcode`` inside sliced ``.3mf`` archives.
        """
        if type(plate) is bool or not isinstance(plate, int) or plate < 1 or plate > 99:
            raise ModelError("Numéro de plateau invalide", 400, "validation_error")
        path = self.resolve(model_id)
        ext = path.suffix.lower()
        if ext not in (".gcode", ".gx", ".3mf"):
            raise ModelError("Ce fichier ne contient pas de G-code", 422, "not_sliced")

        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(path, flags)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise ModelError("Type de fichier non autorisé", 403, "forbidden")
            if ext in (".gcode", ".gx"):
                if st.st_size > MAX_GCODE_BYTES:
                    raise ModelError("G-code trop volumineux (> 128 Mo)", 413, "too_large")
                fh = os.fdopen(fd, "rb")
                fd = -1
                try:
                    probe = fh.read(4096)
                    if probe.startswith(b"PK\x03\x04"):
                        raise ModelError("Archive ZIP inattendue pour un fichier G-code", 422, "unreadable")
                    start_offset = 0
                    if ext == ".gx" and probe.startswith(b"xgcode "):
                        fh.seek(0)
                        head = fh.read(512 * 1024)
                        start_offset = self._find_xgcode_offset(head)
                        if start_offset < 0:
                            raise ModelError("En-tête binaire .gx sans G-code lisible", 422, "unreadable")
                    elif b"\x00" in probe:
                        raise ModelError("Fichier binaire non pris en charge comme G-code", 422, "unreadable")
                    fh.seek(start_offset)
                    etag = f'"g{st.st_mtime_ns:x}-{st.st_size:x}-{plate}"'
                    return GcodeStream(
                        stream=fh,
                        size=max(0, st.st_size - start_offset),
                        name=path.name,
                        plate=1,
                        source_kind=ext[1:],
                        etag=etag,
                        range_ok=True,
                        base_offset=start_offset,
                    )
                except Exception:
                    fh.close()
                    raise

            # .3mf sliced container
            if st.st_size > MAX_SERVE:
                raise ModelError("Archive 3MF trop volumineuse", 413, "too_large")
            fh = os.fdopen(fd, "rb")
            fd = -1
            zf = None
            try:
                zf = zipfile.ZipFile(fh)
                infos = zf.infolist()
                if len(infos) > MAX_GCODE_ZIP_ENTRIES:
                    raise ModelError("Archive 3MF trop complexe", 422, "unreadable")
                plates = sorted({
                    int(m.group(1))
                    for info_item in infos
                    for m in [re.fullmatch(r"Metadata/plate_(\d{1,2})\.gcode", info_item.filename)]
                    if m
                })
                if not plates:
                    raise ModelError("Ce fichier 3MF n'est pas tranché (aucun G-code de plateau)", 422, "not_sliced")
                target = f"Metadata/plate_{plate}.gcode"
                info = next((i for i in infos if i.filename == target), None)
                if info is None:
                    raise ModelError(f"Plateau {plate} absent du 3MF", 404, "bad_plate")
                if info.is_dir():
                    raise ModelError("Entrée G-code invalide dans le 3MF", 422, "unreadable")
                if info.file_size > MAX_GCODE_BYTES:
                    raise ModelError("G-code du plateau trop volumineux (> 128 Mo)", 413, "too_large")
                if (info.compress_type != zipfile.ZIP_STORED and info.compress_size > 0
                        and info.file_size > 10 * 1024 * 1024
                        and (info.file_size / info.compress_size) > MAX_GCODE_ZIP_RATIO):
                    raise ModelError("Entrée G-code compressée hors limites", 413, "too_large")
                zstream = zf.open(info, "r")
                etag = f'"g{st.st_mtime_ns:x}-{st.st_size:x}-p{plate}"'
                return GcodeStream(
                    stream=zstream,
                    size=info.file_size,
                    name=f"{path.stem}_plate_{plate}.gcode",
                    plate=plate,
                    source_kind="3mf",
                    etag=etag,
                    range_ok=False,
                    extra_close=(zf, fh),
                )
            except ModelError:
                if zf is not None:
                    try:
                        zf.close()
                    except Exception:
                        pass
                fh.close()
                raise
            except (zipfile.BadZipFile, OSError, EOFError, ValueError, RuntimeError, NotImplementedError):
                if zf is not None:
                    try:
                        zf.close()
                    except Exception:
                        pass
                fh.close()
                raise ModelError("3MF illisible", 422, "unreadable") from None
        finally:
            if fd >= 0:
                os.close(fd)

    def inspect_print_file(self, model_id: str, plate: int = 1,
                           source_path: Path | None = None,
                           display_name: str | None = None) -> dict[str, Any]:
        """What a printer could run from this file, read from the bytes only.

        * a Bambu "sliced" 3MF has ``Metadata/plate_N.gcode`` (+ ``slice_info.config``);
        * a ``.gcode`` / ``.gx`` file is plain G-code (Flashforge).
        A plain project 3MF or an STL is not printable: it must be sliced first.
        """
        path = source_path if source_path is not None else self.resolve(model_id)
        ext = path.suffix.lower()
        size = path.stat().st_size
        out: dict[str, Any] = {"id": model_id, "name": display_name or path.name, "ext": ext[1:], "size": size,
                               "kind": "", "plates": [], "printer_model": "", "filaments": [],
                               "prediction_sec": None, "weight_g": None}
        if ext in (".gcode", ".gx"):
            out["kind"] = "gcode"
            try:
                with open(path, "rb") as fh:
                    out["filaments"] = parse_gcode_header(fh.read(GCODE_HEAD_BYTES))
            except OSError:
                pass
            return out

        if ext != ".3mf":
            return out

        try:
            with zipfile.ZipFile(path) as zf:
                names = zf.namelist()
                plates = sorted({int(m.group(1)) for n in names
                                 for m in [re.fullmatch(r"Metadata/plate_(\d{1,2})\.gcode", n)] if m})
                if plates:
                    out["kind"] = "bambu3mf"
                    out["plates"] = plates
                    out["plates_info"] = parse_all_plates(zf, plates)
                out.update(read_slice_info(zf, plate))
        except (zipfile.BadZipFile, OSError):
            raise ModelError("3MF illisible", 422, "unreadable") from None
        return out


    @staticmethod
    def _job_stem(name: str) -> str:
        low = str(name or "").strip().lower()
        for suffix in (".gcode.3mf", ".3mf", ".gcode", ".gx"):
            if low.endswith(suffix):
                low = low[: -len(suffix)]
        return low

    def find_by_job_name(self, name: str) -> str:
        """The id of a sliced 3MF whose name matches a printer's job name, or ""."""
        stem = self._job_stem(name)
        if not stem:
            return ""
        for row in self.scan():
            if row["ext"] == "3mf" and self._job_stem(row["name"]) == stem:
                return row["id"]
        return ""

    def find_slice_file(self, name: str) -> str:
        """The id of any printable file carrying this job's slice data, or "".

        A sliced 3MF wins over a plain G-code; for the latter only the header comments name the
        materials, so a file without them is still returned but tells nothing."""
        stem = self._job_stem(name)
        if not stem:
            return ""
        found = ""
        for row in self.scan():
            if self._job_stem(row["name"]) != stem:
                continue
            if row["ext"] == "3mf":
                return row["id"]
            if row["ext"] in ("gcode", "gx") and not found:
                found = row["id"]
        return found

    def thumbnail(self, model_id: str, plate: int = 1) -> bytes:
        path = self.resolve(model_id)
        if path.suffix.lower() != ".3mf":
            raise ModelError("Pas de vignette", 404, "not_found")
        try:
            with zipfile.ZipFile(path) as zf:
                names = set(zf.namelist())
                candidates = (f"Metadata/plate_{int(plate)}.png", f"Metadata/plate_{int(plate)}_small.png") + _THUMB_NAMES
                pick = next((n for n in candidates if n in names), None)
                if pick is None:
                    pick = next((n for n in sorted(names) if n.lower().startswith("metadata/")
                                 and n.lower().endswith(".png")), None)
                if pick is None:
                    raise ModelError("Pas de vignette", 404, "not_found")
                info = zf.getinfo(pick)
                if info.file_size > MAX_THUMB:
                    raise ModelError("Vignette trop grande", 413, "too_large")
                with zf.open(info) as fh:
                    data = fh.read(MAX_THUMB + 1)
        except (zipfile.BadZipFile, OSError):
            raise ModelError("3MF illisible", 422, "unreadable") from None
        if len(data) > MAX_THUMB or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ModelError("Vignette invalide", 422, "unreadable")
        return data

    def gcode_layers(self, model_id: str, plate: int = 1) -> dict[str, Any]:
        """Sample G-code extrusion paths per layer for the 2D layer previewer."""
        path = self.resolve(model_id)
        ext = path.suffix.lower()
        max_bytes = 24 * 1024 * 1024
        raw = b""
        if ext in (".gcode", ".gx"):
            with open(path, "rb") as fh:
                raw = fh.read(max_bytes)
        elif ext == ".3mf":
            try:
                with zipfile.ZipFile(path) as zf:
                    target = f"Metadata/plate_{int(plate)}.gcode"
                    if target not in zf.namelist():
                        raise ModelError("Aucun G-code pour ce plateau", 404, "not_sliced")
                    with zf.open(target) as fh:
                        raw = fh.read(max_bytes)
            except (zipfile.BadZipFile, OSError):
                raise ModelError("3MF illisible", 422, "unreadable") from None
        else:
            raise ModelError("Ce fichier ne contient pas de G-code", 422, "not_sliced")
        layers: list[dict[str, Any]] = []
        cur_paths: list[dict[str, Any]] = []
        cur_seg: list[list[float]] = []
        cur_type = "other"
        cur_tool = 0
        tools_used: set[int] = set()
        cur_z = 0.0
        x = y = 0.0
        min_x = min_y = 1e9
        max_x = max_y = -1e9
        for line in raw.decode("utf-8", "replace").splitlines():
            s = line.strip()
            if not s:
                continue
            if s.startswith(";LAYER_CHANGE") or s.startswith("; layer "):
                if len(cur_seg) >= 2 and len(cur_paths) < 300:
                    cur_paths.append({"t": cur_type, "e": cur_tool, "pts": cur_seg})
                cur_seg = []
                if cur_paths:
                    layers.append({"z": round(cur_z, 2), "paths": cur_paths[:300]})
                    cur_paths = []
                    if len(layers) >= 400:
                        break
                continue
            if s.startswith(";TYPE:"):
                if len(cur_seg) >= 2 and len(cur_paths) < 300:
                    cur_paths.append({"t": cur_type, "e": cur_tool, "pts": cur_seg})
                cur_seg = []
                low_t = s[6:].strip().lower()
                if "outer" in low_t or "external" in low_t:
                    cur_type = "outer"
                elif "inner" in low_t or "perimeter" in low_t:
                    cur_type = "inner"
                elif "infill" in low_t or "fill" in low_t:
                    cur_type = "infill"
                elif "support" in low_t:
                    cur_type = "support"
                else:
                    cur_type = "other"
                continue
            if s.startswith(";Z:"):
                try:
                    cur_z = float(s[3:].strip())
                except ValueError:
                    pass
                continue
            if s.startswith(";"):
                continue
            tm = re.match(r"^T(\d{1,2})(?:\s|;|$)", s)
            if tm:
                if len(cur_seg) >= 2 and len(cur_paths) < 300:
                    cur_paths.append({"t": cur_type, "e": cur_tool, "pts": cur_seg})
                cur_seg = []
                cur_tool = min(15, int(tm.group(1)))
                continue
            if s.startswith(("G0 ", "G1 ")):
                nx = x
                ny = y
                extrude = False
                for tok in s.split()[1:]:
                    if tok.startswith(";"):
                        break
                    code = tok[0]
                    try:
                        val = float(tok[1:])
                    except ValueError:
                        continue
                    if code == "X":
                        nx = val
                    elif code == "Y":
                        ny = val
                    elif code == "Z":
                        cur_z = val
                    elif code == "E" and val > 0:
                        extrude = True
                if extrude and (nx != x or ny != y):
                    tools_used.add(cur_tool)
                    if not cur_seg:
                        cur_seg.append([round(x, 1), round(y, 1)])
                    if len(cur_seg) < 60:
                        cur_seg.append([round(nx, 1), round(ny, 1)])
                    min_x, min_y = min(min_x, x, nx), min(min_y, y, ny)
                    max_x, max_y = max(max_x, x, nx), max(max_y, y, ny)
                else:
                    if len(cur_seg) >= 2 and len(cur_paths) < 300:
                        cur_paths.append({"t": cur_type, "e": cur_tool, "pts": cur_seg})
                    cur_seg = []
                x, y = nx, ny
        if len(cur_seg) >= 2 and len(cur_paths) < 300:
            cur_paths.append({"t": cur_type, "e": cur_tool, "pts": cur_seg})
        if cur_paths and len(layers) < 400:
            layers.append({"z": round(cur_z, 2), "paths": cur_paths[:300]})
        bounds = [round(min_x, 1), round(min_y, 1), round(max_x, 1), round(max_y, 1)] if max_x > min_x else [0, 0, 256, 256]
        return {"layers": layers, "bounds": bounds, "count": len(layers),
                "tools": sorted(tools_used) if tools_used else [0]}

    @staticmethod
    def find_slicer() -> str:
        for exe in ("orca-slicer", "orca-slicer.exe",
                    r"C:\Program Files\OrcaSlicer\orca-slicer.exe",
                    r"C:\Program Files\Bambu Studio\bambu-studio.exe"):
            found = shutil.which(exe) or (exe if os.path.isfile(exe) else None)
            if found:
                return found
        return ""

    @staticmethod
    def _run_resolved_slice(slicer: str, resolved: Any, slice_input: Path,
                            dest_dir: Path, stem: str, tag: str, work_dir: Path) -> tuple[Path, str]:
        settings_files, filament_files = resolved.write_files(work_dir)
        tmp_out_name = f"{stem}_{tag}.gcode.3mf"
        cmd = [
            slicer,
            "--load-settings", ";".join(str(p) for p in settings_files),
            "--load-filaments", ";".join(str(p) for p in filament_files),
            "--slice", "0",
            "--outputdir", str(work_dir),
            "--export-3mf", tmp_out_name,
            str(slice_input),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, timeout=180, check=False)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ModelError("Tranchage expiré ou impossible", 500, "slice_failed") from exc
        produced = work_dir / tmp_out_name
        if proc.returncode != 0 or not produced.is_file():
            raw_err = getattr(proc, "stderr", None) or getattr(proc, "stdout", None) or b""
            if isinstance(raw_err, str):
                err_txt = raw_err
            else:
                err_txt = bytes(raw_err).decode("utf-8", "replace")
            snippet = " ".join(err_txt.strip().splitlines()[-2:])[:220]
            msg = f"Le trancheur n'a pas produit de 3MF tranché ({snippet})" if snippet else "Le trancheur n'a pas produit de 3MF tranché"
            raise ModelError(msg, 422, "slice_failed")
        preflight_gcode(produced, 1, resolved.profile)
        return _publish_immutable_slice(produced, dest_dir, stem, tag)

    def slice_model(self, model_id: str, printer_model: str = "", *,
                    nozzle: Any = None, material: str | None = None,
                    plate_type: str = "textured_pei",
                    layer_height: float | None = None, first_layer_height: float | None = None,
                    wall_loops: int | None = None, infill: int | None = None,
                    infill_pattern: str | None = None, supports: bool = False,
                    support_type: str | None = None, brim: bool = False,
                    brim_type: str | None = None,
                    profile_roots: list[Path] | tuple[Path, ...] | None = None) -> dict[str, Any]:
        """Headless slice an STL/3MF via OrcaSlicer/Bambu Studio CLI into <stem>_sliced.gcode.3mf."""
        slicer = self.find_slicer()
        if not slicer:
            raise ModelError("Aucun trancheur CLI détecté (OrcaSlicer / Bambu Studio)", 501, "no_slicer")
        if not str(printer_model or "").strip():
            raise ModelError("Modèle d'imprimante cible requis", 400, "missing_printer_model")
        src = self.resolve(model_id)
        if src.suffix.lower() not in (".stl", ".3mf", ".obj", ".step", ".stp"):
            raise ModelError("Format non tranchable directement", 422, "unsupported")
        if src.stat().st_size > MAX_STL_BYTES:
            raise ModelError("Fichier source trop volumineux (> 64 Mo)", 413, "too_large")
        try:
            resolved = resolve_slicer_config(
                printer_model,
                nozzle=nozzle,
                material=material or "PLA",
                used_tool_count=1,
                plate_type=plate_type,
                layer_height=layer_height,
                first_layer_height=first_layer_height,
                wall_loops=wall_loops,
                infill=infill,
                infill_pattern=infill_pattern,
                supports=supports,
                support_type=support_type,
                brim=brim,
                brim_type=brim_type,
                profile_roots=profile_roots,
                slicer_path=slicer,
            )
        except SlicerConfigError as exc:
            raise ModelError(str(exc), exc.status, exc.code) from None
        stem = self._job_stem(src.name) or src.stem
        with SLICER_SEM, tempfile.TemporaryDirectory(prefix="hq-slice-") as tmp:
            published_path, digest = self._run_resolved_slice(slicer, resolved, src, src.parent, stem, "sliced", Path(tmp))
        out_name = published_path.name
        self.scan(force=True)
        new_id = next((r["id"] for r in self.scan() if r["name"] == out_name and Path(self.resolve(r["id"])).parent == src.parent), "")
        slice_meta = {
            "printer_model": resolved.profile["model"],
            "nozzle": resolved.nozzle,
            "plate_type": str(plate_type or "textured_pei"),
            "material": str(material or "PLA"),
            "layer_height": resolved.process.get("layer_height"),
            "first_layer_height": resolved.process.get("initial_layer_print_height"),
            "infill": resolved.process.get("sparse_infill_density"),
            "supports": bool(supports),
            "brim": bool(brim),
            "filaments": list(resolved.filament_names),
        }
        try:
            if not new_id:
                raise ModelError("Artefact tranché introuvable après publication", 500, "slice_registration_failed")
            rel = next((r["rel"] for r in self.scan() if r["id"] == new_id), out_name)
            self._record_slice_meta(new_id, digest, slice_meta, rel_path=rel, source_kind="sliced")
        except Exception:
            published_path.unlink(missing_ok=True)
            self.scan(force=True)
            raise
        return self.get(new_id)

    def analyze_stl(self, model_id: str, auto_orient: bool = False) -> dict[str, Any]:
        """Check STL watertightness (non-manifold/open edges) and optionally auto-orient flat."""
        import struct
        src = self.resolve(model_id)
        if src.suffix.lower() != ".stl":
            raise ModelError("Analyse maillage disponible uniquement pour .stl", 422, "unsupported")
        if src.stat().st_size > MAX_STL_BYTES:
            raise ModelError("STL trop volumineux (> 64 Mo)", 413, "too_large")
        raw = src.read_bytes()
        tris = parse_stl_triangles(raw)
        tri_count = len(tris)
        edge_counts: dict[tuple[tuple[int, int, int], tuple[int, int, int]], int] = {}
        min_v = [1e9, 1e9, 1e9]
        max_v = [-1e9, -1e9, -1e9]
        for pts in tris:
            qpts = []
            for p in pts:
                for k in range(3):
                    min_v[k] = min(min_v[k], p[k])
                    max_v[k] = max(max_v[k], p[k])
                qpts.append((round(p[0] * 1000), round(p[1] * 1000), round(p[2] * 1000)))
            for a, b in ((qpts[0], qpts[1]), (qpts[1], qpts[2]), (qpts[2], qpts[0])):
                ek = (a, b) if a <= b else (b, a)
                edge_counts[ek] = edge_counts.get(ek, 0) + 1
        open_edges = sum(1 for c in edge_counts.values() if c == 1)
        non_manifold = sum(1 for c in edge_counts.values() if c > 2)
        dims = [round(max_v[k] - min_v[k], 2) for k in range(3)]
        # Pick best axis alignment (largest base area X*Y, lowest height Z)
        candidates = [
            ("xy", lambda p: (p[0], p[1], p[2]), dims[0] * dims[1], dims[2]),
            ("xz", lambda p: (p[0], p[2], -p[1]), dims[0] * dims[2], dims[1]),
            ("yz", lambda p: (p[1], p[2], p[0]), dims[1] * dims[2], dims[0]),
        ]
        best = max(candidates, key=lambda c: (c[2], -c[3]))
        out: dict[str, Any] = {
            "triangles": tri_count,
            "dims_mm": dims,
            "watertight": open_edges == 0 and non_manifold == 0,
            "open_edges": open_edges,
            "non_manifold_edges": non_manifold,
            "best_orientation": best[0],
        }
        if auto_orient and best[0] != "xy":
            fn = best[1]
            r_tris = [[fn(p) for p in t] for t in tris]
            rmin = [min(p[k] for t in r_tris for p in t) for k in range(3)]
            buf = bytearray(84 + len(r_tris) * 50)
            buf[:80] = b"Atelier3D auto-oriented".ljust(80, b" ")
            struct.pack_into("<I", buf, 80, len(r_tris))
            pos = 84
            for t in r_tris:
                s_pts = [(p[0] - rmin[0], p[1] - rmin[1], p[2] - rmin[2]) for p in t]
                struct.pack_into("<12fH", buf, pos, 0.0, 0.0, 0.0,
                                 s_pts[0][0], s_pts[0][1], s_pts[0][2],
                                 s_pts[1][0], s_pts[1][1], s_pts[1][2],
                                 s_pts[2][0], s_pts[2][1], s_pts[2][2], 0)
                pos += 50
            out_name = f"{src.stem}_oriented.stl"
            with tempfile.NamedTemporaryFile(delete=False) as tf:
                tf.write(bytes(buf))
                tmp_stl = Path(tf.name)
            try:
                _atomic_publish(tmp_stl, src.parent / out_name)
            finally:
                tmp_stl.unlink(missing_ok=True)
            self.scan(force=True)
            nid = next((r["id"] for r in self.scan() if r["name"] == out_name and Path(self.resolve(r["id"])).parent == src.parent), "")
            out["oriented_model"] = self.get(nid) if nid else {"name": out_name}
        return out

    @staticmethod
    def _write_multitool_3mf(out_3mf: Path,
                             item_meshes: list[tuple[Any, ...]]) -> None:
        """Package transformed meshes into a 3MF with per-object extruder & metadata overrides."""
        from xml.sax.saxutils import quoteattr as _xml_quoteattr
        content_types = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
            '<Default Extension="config" ContentType="text/xml"/>'
            '</Types>'
        )
        rels = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel-1" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
            '</Relationships>'
        )
        obj_xml: list[str] = []
        build_xml: list[str] = []
        cfg_xml: list[str] = []
        for idx, entry in enumerate(item_meshes, start=1):
            name, tool_idx, tris = entry[0], entry[1], entry[2]
            obj_meta = entry[3] if len(entry) >= 4 and isinstance(entry[3], dict) else {}
            vmap: dict[tuple[float, float, float], int] = {}
            verts: list[str] = []
            tri_xml: list[str] = []
            for tri in tris:
                ids: list[int] = []
                for p in tri:
                    key = (round(p[0], 4), round(p[1], 4), round(p[2], 4))
                    vid = vmap.get(key)
                    if vid is None:
                        vid = len(verts)
                        vmap[key] = vid
                        verts.append(f'<vertex x="{key[0]}" y="{key[1]}" z="{key[2]}"/>')
                    ids.append(vid)
                tri_xml.append(f'<triangle v1="{ids[0]}" v2="{ids[1]}" v3="{ids[2]}"/>')
            obj_xml.append(
                f'<object id="{idx}" type="model">'
                f'<mesh><vertices>{"".join(verts)}</vertices>'
                f'<triangles>{"".join(tri_xml)}</triangles></mesh></object>'
            )
            build_xml.append(f'<item objectid="{idx}" printable="1"/>')
            extra_xml = "".join(
                f'<metadata key={_xml_quoteattr(str(mk))} value={_xml_quoteattr(str(mv))}/>'
                for mk, mv in sorted(obj_meta.items())
            )
            cfg_xml.append(
                f'<object id="{idx}">'
                f'<metadata key="name" value={_xml_quoteattr(str(name)[:64])}/>'
                f'<metadata key="extruder" value="{int(tool_idx) + 1}"/>'
                f'{extra_xml}'
                f'</object>'
            )
        model_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<model unit="millimeter" xml:lang="en-US" '
            'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
            f'<resources>{"".join(obj_xml)}</resources>'
            f'<build>{"".join(build_xml)}</build></model>'
        )
        settings_xml = f'<?xml version="1.0" encoding="UTF-8"?><config>{"".join(cfg_xml)}</config>'
        with zipfile.ZipFile(out_3mf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("[Content_Types].xml", content_types)
            zf.writestr("_rels/.rels", rels)
            zf.writestr("3D/3dmodel.model", model_xml)
            zf.writestr("Metadata/model_settings.config", settings_xml)

    def assemble_and_slice_plate(self, items: list[dict[str, Any]], printer_model: str = "",
                                 settings: dict[str, Any] | None = None,
                                 bed: tuple[float, float, float] | None = None,
                                 profile_roots: list[Path] | tuple[Path, ...] | None = None) -> dict[str, Any]:
        """Assemble one or more placed Studio models onto a single plate and slice via OrcaSlicer."""
        import math
        import struct
        if not isinstance(items, list) or not items:
            raise ModelError("Ajoute au moins un modèle sur le plateau")
        if len(items) > 16:
            raise ModelError("Maximum 16 objets par plateau Studio", 422, "too_many_items")
        for it in items:
            for key, default in (("x", 0.0), ("y", 0.0), ("z", 0.0), ("scale", 1.0),
                                 ("rot_x", 0.0), ("rot_y", 0.0), ("rot_z", 0.0)):
                try:
                    fv = float(it.get(key) if it.get(key) is not None else default)
                except (TypeError, ValueError):
                    raise ModelError("Paramètres de placement invalides (NaN/Inf)", 422, "unreadable") from None
                if not math.isfinite(fv):
                    raise ModelError("Paramètres de placement invalides (NaN/Inf)", 422, "unreadable")
            z_val = float(it.get("z") if it.get("z") is not None else 0.0)
            if z_val < -0.01:
                raise ModelError("Objet placé sous le plateau (Z < 0 mm)", 422, "below_plate")
            if z_val > 0.01:
                raise ModelError(
                    "Placement en Z surélevé (> 0 mm) non pris en charge : pose l'objet à Z = 0 mm",
                    422, "unsupported_z",
                )
        if not str(printer_model or "").strip():
            raise ModelError("Modèle d'imprimante cible requis", 400, "missing_printer_model")
        slicer = self.find_slicer()
        if not slicer:
            raise ModelError("Aucun trancheur CLI détecté (OrcaSlicer / Bambu Studio)", 501, "no_slicer")
        cfg = settings if isinstance(settings, dict) else {}
        tool_indices: list[int] = []
        for it in items:
            try:
                t_val = int(it.get("tool") or 0)
            except (TypeError, ValueError):
                raise ModelError("Indice d'outil invalide", 422, "tool_out_of_range") from None
            if t_val < 0 or t_val > 15:
                raise ModelError(f"Extrudeur T{t_val} hors limites", 422, "tool_out_of_range")
            tool_indices.append(t_val)
        try:
            sif_idx = int(cfg.get("support_interface_filament") or 0)
        except (TypeError, ValueError):
            sif_idx = 0
        used_tool_count = max([*tool_indices, max(0, sif_idx - 1)]) + 1
        tools_cfg = cfg.get("tools") if isinstance(cfg.get("tools"), list) else []
        global_mat = str(cfg.get("material") or "").strip()
        if used_tool_count == 1:
            slot0 = dict(tools_cfg[0]) if tools_cfg and isinstance(tools_cfg[0], dict) else {}
            eff_mat = global_mat or str(slot0.get("material") or "PLA")
            eff_tools = [{"material": eff_mat, "color": slot0.get("color") or "", "preset": slot0.get("preset") or ""}]
        else:
            eff_tools = [dict(t) if isinstance(t, dict) else {} for t in tools_cfg]
        lh = cfg.get("layer_height")
        flh = cfg.get("first_layer_height")
        wl = cfg.get("wall_loops")
        inf = cfg.get("infill")
        try:
            resolved = resolve_slicer_config(
                printer_model,
                nozzle=cfg.get("nozzle"),
                material=global_mat or "PLA",
                tools=eff_tools,
                used_tool_count=used_tool_count,
                plate_type=str(cfg.get("plate_type") or "textured_pei"),
                quality_preset=str(cfg.get("quality_preset") or "") or None,
                speed_preset=str(cfg.get("speed_preset") or "") or None,
                layer_height=float(lh) if lh not in (None, "") else None,
                first_layer_height=float(flh) if flh not in (None, "") else None,
                wall_loops=int(wl) if wl not in (None, "") else None,
                infill=int(inf) if inf not in (None, "") else None,
                infill_pattern=str(cfg.get("infill_pattern") or "") or None,
                supports=bool(cfg.get("supports")),
                support_type=str(cfg.get("support_type") or "") or None,
                brim=bool(cfg.get("brim")),
                brim_type=str(cfg.get("brim_type") or "") or None,
                advanced=cfg,
                bed_override=bed,
                profile_roots=profile_roots,
                slicer_path=slicer,
            )
        except SlicerConfigError as exc:
            raise ModelError(str(exc), exc.status, exc.code) from None
        profile = resolved.profile
        bed_x, bed_y, bed_z = profile["bed"]
        ox, oy = profile.get("origin") or (0.0, 0.0)
        first_src = self.resolve(str(items[0].get("model_id") or ""))
        stem = self._job_stem(first_src.name) or first_src.stem
        with SLICER_SEM, tempfile.TemporaryDirectory(prefix="hq-studio-") as tmp:
            tpath = Path(tmp)
            def _has_xform(it_obj: dict[str, Any]) -> bool:
                return (
                    abs(float(it_obj.get("scale") if it_obj.get("scale") is not None else 1.0) - 1.0) > 1e-3
                    or abs(float(it_obj.get("rot_x") or 0.0)) > 1e-3
                    or abs(float(it_obj.get("rot_y") or 0.0)) > 1e-3
                    or abs(float(it_obj.get("rot_z") or 0.0)) > 1e-3
                    or abs(float(it_obj.get("z") or 0.0)) > 1e-3
                    or bool(isinstance(it_obj.get("overrides"), dict) and any(
                        it_obj["overrides"].get(k) not in (None, "") for k in OBJECT_OVERRIDE_KEYS
                    ))
                )
            has_xform = _has_xform(items[0])
            use_direct = (len(items) == 1 and first_src.suffix.lower() != ".stl" and tool_indices[0] == 0 and not has_xform)
            source_hashes: dict[str, str] = {}
            per_object_meta_summary: list[dict[str, Any]] = []
            def _check_expected_sha(mid: str, src_path: Path, actual_hex: str, exp_raw: Any) -> None:
                exp = str(exp_raw or "").strip().lower()
                if exp and exp != actual_hex:
                    raise ModelError(
                        f"'{src_path.name}' a été modifié sur le disque depuis sa préparation : recharge le modèle.",
                        409, "source_changed",
                    )
                if actual_hex:
                    source_hashes[mid] = actual_hex

            if use_direct:
                slice_input = first_src
                _check_expected_sha(
                    str(items[0].get("model_id") or ""), first_src,
                    _source_sha256_path(first_src), items[0].get("expected_sha256"),
                )
            else:
                total_tris = 0
                item_meshes: list[tuple[str, int, list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]], dict[str, str]]] = []
                placed_obbs: list[tuple[str, list[tuple[float, float]], float]] = []
                parsed_cache: dict[str, tuple[list[tuple[tuple[float, float, float], tuple[float, float, float], tuple[float, float, float]]], str]] = {}
                has_obj_overrides = False
                for idx_it, it in enumerate(items):
                    mid_key = str(it.get("model_id") or "")
                    src = self.resolve(mid_key)
                    it_xform = _has_xform(it)
                    tool_idx = tool_indices[idx_it]
                    try:
                        obj_meta = validate_and_normalize_object_overrides(
                            it.get("overrides"), resolved.profile, resolved.machine
                        )
                    except SlicerConfigError as exc:
                        raise ModelError(str(exc), exc.status, exc.code) from None
                    if obj_meta:
                        has_obj_overrides = True
                    per_object_meta_summary.append({"name": src.name, "tool": tool_idx, "overrides": obj_meta})
                    if src.suffix.lower() != ".stl":
                        if len(items) == 1 and not it_xform and tool_idx == 0:
                            slice_input = src
                            use_direct = True
                            _check_expected_sha(mid_key, src, _source_sha256_path(src), it.get("expected_sha256"))
                            break
                        raise ModelError("Les transformations, surcharges objet et assemblages multi-objets exigent des .stl", 422, "unsupported")
                    if mid_key in parsed_cache:
                        raw_tris, actual_sha = parsed_cache[mid_key]
                    else:
                        if src.stat().st_size > MAX_STL_BYTES:
                            raise ModelError(f"'{src.name}' dépasse la limite de 64 Mo", 413, "too_large")
                        raw_bytes = src.read_bytes()
                        actual_sha = hashlib.sha256(raw_bytes).hexdigest().lower()
                        raw_tris = parse_stl_triangles(raw_bytes)
                        parsed_cache[mid_key] = (raw_tris, actual_sha)
                    _check_expected_sha(mid_key, src, actual_sha, it.get("expected_sha256"))
                    n_tri = len(raw_tris)
                    total_tris += n_tri
                    if total_tris > MAX_PLATE_TRIANGLES:
                        raise ModelError("Trop de triangles cumulés sur le plateau (> 600k)", 413, "too_large")
                    scale = float(it.get("scale") if it.get("scale") is not None else 1.0)
                    rot_x = float(it.get("rot_x") or 0.0)
                    rot_y = float(it.get("rot_y") or 0.0)
                    rot_z = float(it.get("rot_z") or 0.0)
                    dx, dy = float(it.get("x") or 0.0), float(it.get("y") or 0.0)
                    dz_off = float(it.get("z") or 0.0)
                    xformed = transform_stl_triangles(
                        raw_tris,
                        scale=scale,
                        rot_x=rot_x,
                        rot_y=rot_y,
                        rot_z=rot_z,
                        x=dx,
                        y=dy,
                        z=dz_off,
                        ox=ox,
                        oy=oy,
                    )
                    obb = xformed["obb"]
                    height_z = xformed["tilted_dims"][2]
                    for prev_name, prev_obb, prev_h in placed_obbs:
                        if height_z > 0.0 and prev_h > 0.0 and _sat_obb_collide(obb, prev_obb):
                            raise ModelError(
                                f"Collision détectée entre '{prev_name}' et '{src.name}' sur le plateau",
                                422, "collision",
                            )
                    if resolved.prime_tower_box is not None:
                        tx0, ty0, tx1, ty1 = resolved.prime_tower_box
                        tower_obb = [(tx0, ty0), (tx1, ty0), (tx1, ty1), (tx0, ty1)]
                        if height_z > 0.0 and _sat_obb_collide(obb, tower_obb):
                            raise ModelError(
                                f"'{src.name}' entre en collision avec la tour de purge ({tx0:.0f}–{tx1:.0f}, {ty0:.0f}–{ty1:.0f} mm)",
                                422, "prime_tower_collision",
                            )
                    placed_obbs.append((src.name, obb, height_z))
                    wmin_x, wmin_y, wmin_z, wmax_x, wmax_y, wmax_z = xformed["world_bounds"]
                    if (wmin_x < ox - 1.0 or wmax_x > ox + bed_x + 1.0
                            or wmin_y < oy - 1.0 or wmax_y > oy + bed_y + 1.0
                            or wmax_z > bed_z + 1.0):
                        raise ModelError(
                            f"'{src.name}' dépasse du plateau {bed_x:.0f}×{bed_y:.0f}×{bed_z:.0f} mm",
                            422, "out_of_bounds",
                        )
                    if wmin_z < -0.01:
                        raise ModelError(f"'{src.name}' est sous le plateau (Z < 0 mm)", 422, "below_plate")
                    item_meshes.append((str(it.get("local_name") or it.get("localName") or src.stem), tool_idx, xformed["triangles"], obj_meta))
                if not use_direct:
                    used_tools = {t for _, t, _, _ in item_meshes}
                    if len(used_tools) > 1 or any(t > 0 for t in used_tools) or has_obj_overrides:
                        plate_3mf = tpath / "studio_plate.3mf"
                        self._write_multitool_3mf(plate_3mf, item_meshes)
                        slice_input = plate_3mf
                    else:
                        all_tris = [t for _, _, tris, _ in item_meshes for t in tris]
                        plate_stl = tpath / "studio_plate.stl"
                        buf = bytearray(84 + len(all_tris) * 50)
                        buf[:80] = b"Atelier3D Studio Plate".ljust(80, b" ")
                        struct.pack_into("<I", buf, 80, len(all_tris))
                        pos = 84
                        for t in all_tris:
                            struct.pack_into("<12fH", buf, pos, 0.0, 0.0, 0.0,
                                             t[0][0], t[0][1], t[0][2],
                                             t[1][0], t[1][1], t[1][2],
                                             t[2][0], t[2][1], t[2][2], 0)
                            pos += 50
                        plate_stl.write_bytes(bytes(buf))
                        slice_input = plate_stl
            published_path, digest = self._run_resolved_slice(slicer, resolved, slice_input, first_src.parent, stem, "studio", tpath)
        out_name = published_path.name
        self.scan(force=True)
        new_id = next((r["id"] for r in self.scan() if r["name"] == out_name and Path(self.resolve(r["id"])).parent == first_src.parent), "")
        slice_meta = {
            "printer_model": resolved.profile["model"],
            "nozzle": resolved.nozzle,
            "plate_type": str(cfg.get("plate_type") or "textured_pei"),
            "material": str(global_mat or "PLA"),
            "quality_preset": resolved.quality_preset,
            "speed_preset": resolved.speed_preset,
            "layer_height": resolved.process.get("layer_height"),
            "first_layer_height": resolved.process.get("initial_layer_print_height"),
            "wall_loops": resolved.process.get("wall_loops"),
            "infill": resolved.process.get("sparse_infill_density"),
            "infill_pattern": resolved.process.get("sparse_infill_pattern"),
            "seam_position": resolved.process.get("seam_position"),
            "ironing_type": resolved.process.get("ironing_type"),
            "supports": resolved.process.get("enable_support") == "1",
            "support_type": resolved.process.get("support_type"),
            "brim": resolved.process.get("brim_type", "no_brim") != "no_brim",
            "prime_tower": resolved.prime_tower_box is not None,
            "filaments": list(resolved.filament_names),
            "object_overrides": per_object_meta_summary,
            "source_hashes": source_hashes,
        }
        try:
            if not new_id:
                raise ModelError("Artefact Studio tranché introuvable après publication", 500, "slice_registration_failed")
            rel = next((r["rel"] for r in self.scan() if r["id"] == new_id), out_name)
            self._record_slice_meta(new_id, digest, slice_meta, rel_path=rel, source_kind="studio")
        except Exception:
            published_path.unlink(missing_ok=True)
            self.scan(force=True)
            raise
        model = self.get(new_id)
        info = self.inspect_print_file(new_id, 1)
        return {"model": model, "info": info}
