"""Carnet Stage 06: note images (confined storage, bounded upload, structural validation).

Storage: ``<ROOT>/.hq-carnet/assets/asset-<24 hex>.<jpg|png|webp>``. File names are server-generated and opaque;
no client path, file name or extension is ever read. Binary data never enters ``notebook.json``: a page only
stores bounded metadata on an ``image`` block (see ``hq_carnet_rich``).

What the server does and does NOT do (there is no image decoder in this stdlib-only server):

- it never transforms pixels. The browser resizes (<= ``MAX_LONG_SIDE`` px), bakes the EXIF orientation into
  the pixels and re-encodes (which also drops EXIF/GPS) BEFORE uploading;
- it validates the container structure of the persisted artifact (magic, segment/chunk walk, CRC for PNG, RIFF
  size for WebP, end-of-image marker for JPEG), reads the real dimensions from the header and refuses anything
  that is out of bounds, animated, unsupported, truncated, or JPEG/PNG/WebP with an EXIF orientation other
  than 1 (the server will not reinterpret dimensions). It cannot detect corrupt entropy-coded pixel data
  inside an otherwise well-formed container;
- the declared MIME (``X-Carnet-Mime``) is never trusted: if present it must equal the detected type.

Lifecycle: an upload is durable as soon as it is finalised. Removing/replacing an image block deletes
nothing. Orphans keep consuming the quota. There is NO deletion API and no garbage collection in Stage 06:
server-side reference scanning cannot see offline/browser drafts, so reachability is deferred to a later
stage with draft/history-aware semantics.

Locks: the assets lock (``assets_lock``) is the OUTER lock. Code holding it may briefly take the notebook
lock; ``page_save`` holds only the notebook lock and never takes the assets lock (assets are write-once).

Errors never contain a filesystem path.
"""

from __future__ import annotations

import os
import re
import secrets
import struct
import threading
import time
import zlib
from pathlib import Path
from typing import Any, Callable

import hq_state

DIR_NAME = ".hq-carnet"
ASSET_DIR = "assets"

MAX_FILE_BYTES = 12 * 1024 * 1024  # persisted artifact (the browser pre-checks its 16 MiB source)
SOURCE_MAX_BYTES = 16 * 1024 * 1024  # browser-side source cap (advertised in limits, enforced by the UI)
MAX_TOTAL_BYTES = 250 * 1024 * 1024
MAX_FILES = 512
MAX_LONG_SIDE = 2560
IMAGES_PER_PAGE_MAX = 32
CAPTION_MAX = 300
WIDTH_MIN, WIDTH_MAX = 30, 100
CONCURRENT_UPLOADS = 2
READ_CHUNK = 64 * 1024
STALE_TMP_SECONDS = 3600

MIME_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
EXT_MIME = {ext: mime for mime, ext in MIME_EXT.items()}

ID_RE = re.compile(r"^asset-[0-9a-f]{24}\Z")
_NAME_RE = re.compile(r"^(asset-[0-9a-f]{24})(\.jpg|\.png|\.webp)\Z")
_TMP_PREFIX = ".tmp-"

_cb: dict[str, Any] = {}
_slots = threading.BoundedSemaphore(CONCURRENT_UPLOADS)
_reserved: dict[str, int] = {}  # in-flight tmp name -> declared bytes (process local)
_reserved_guard = threading.Lock()


class MediaError(ValueError):
    """Refusal (HTTP ``status``, ``code``). Messages are French, path-free and never echo client input."""

    def __init__(self, message: str, status: int = 400, code: str = "media_error"):
        super().__init__(message)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    _cb.update(kwargs)


def limits() -> dict:
    return {
        "media_file_bytes": MAX_FILE_BYTES,
        "media_source_bytes": SOURCE_MAX_BYTES,
        "media_total_bytes": MAX_TOTAL_BYTES,
        "media_files": MAX_FILES,
        "media_long_side": MAX_LONG_SIDE,
        "media_images_per_page": IMAGES_PER_PAGE_MAX,
        "media_caption_chars": CAPTION_MAX,
        "media_width_min": WIDTH_MIN,
        "media_width_max": WIDTH_MAX,
        "media_mimes": sorted(MIME_EXT),
    }


# ---------------------------------------------------------------- confinement


def _is_link(path: Path) -> bool:
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    return bool(is_junction and is_junction(path))


def _same(a: str, b: str) -> bool:
    return os.path.normcase(os.path.normpath(a)) == os.path.normcase(os.path.normpath(b))


_ESCAPED = "Dossier des images redirigé — refusé"


def assets_path(root: Path | str) -> Path:
    """Fixed absolute server path (shared by every caller so they share one lock)."""
    return Path(os.path.abspath(os.fspath(root))) / DIR_NAME / ASSET_DIR


def assets_lock(root: Path | str) -> threading.RLock:
    return hq_state.path_lock(assets_path(root))


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise MediaError("Images non initialisées", 503, "storage_error")
    return Path(root)


def confined_assets_dir(root: Path | str, *, create: bool = False) -> Path:
    """``assets_path(root)`` after refusing any redirection (symlink/junction/escape) of ``.hq-carnet`` or ``assets``.

    Absent directories are fine unless ``create`` (then they are created and re-verified).
    """
    target = assets_path(root)
    base = target.parent
    try:
        real_root = os.path.realpath(base.parent)
        for index, item in enumerate((base, target)):
            if os.path.lexists(item):
                if _is_link(item) or not item.is_dir():
                    raise MediaError(_ESCAPED, 409, "storage_error")
            elif create:
                item.mkdir()
            else:
                continue
            want = os.path.join(real_root, DIR_NAME) if index == 0 else os.path.join(real_root, DIR_NAME, ASSET_DIR)
            if _is_link(item) or not _same(os.path.realpath(item), want):
                raise MediaError(_ESCAPED, 409, "storage_error")
    except OSError as e:
        raise MediaError("Images inaccessibles", 503, "storage_error") from e
    return target


def _usage_locked(directory: Path) -> tuple[int, int]:
    """(file count, bytes) of the directory. Symlinks count as a file (bounds the entries) but contribute 0
    bytes; in-flight tmp files are counted through their reservation, never twice."""
    count, total = 0, 0
    if not directory.is_dir():
        return 0, 0
    with _reserved_guard:
        reserved = dict(_reserved)
    for entry in os.scandir(directory):
        name = entry.name
        if entry.is_symlink():
            count += 1
            continue
        if not entry.is_file(follow_symlinks=False):
            continue
        if name.startswith(_TMP_PREFIX):
            if name in reserved:
                continue  # counted below by its reservation
            count += 1
            try:
                total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                pass
            continue
        if not _NAME_RE.match(name):
            continue  # unrelated file: neither counted nor ever touched
        count += 1
        try:
            total += entry.stat(follow_symlinks=False).st_size
        except OSError:
            pass
    count += len(reserved)
    total += sum(reserved.values())
    return count, total


def usage() -> dict:
    root = _root()
    with assets_lock(root):
        directory = confined_assets_dir(root)
        files, used = _usage_locked(directory)
    return {"ok": True, "files": files, "bytes": used, "max_files": MAX_FILES, "max_bytes": MAX_TOTAL_BYTES,
            "file_bytes": MAX_FILE_BYTES, "long_side": MAX_LONG_SIDE}


def _quota_error(files: int, used: int) -> MediaError:
    mb = lambda n: f"{n / (1024 * 1024):.1f}".replace(".", ",")  # noqa: E731
    return MediaError(
        f"Quota des images atteint ({mb(used)} Mo sur {MAX_TOTAL_BYTES // (1024 * 1024)} Mo, {files} fichiers sur {MAX_FILES}). "
        "Les images retirées d'une page restent stockées et comptent dans le quota : "
        "il n'existe pas encore de nettoyage automatique.",
        409,
        "quota_exceeded",
    )


# ---------------------------------------------------------------- structural validation


def _bad(message: str = "Image corrompue ou tronquée", status: int = 400, code: str = "bad_image") -> MediaError:
    return MediaError(message, status, code)


def _orientation_tiff(tiff: bytes) -> int | None:
    """EXIF orientation from a TIFF block (None when the tag is absent). Malformed -> MediaError."""
    if len(tiff) < 8:
        raise _bad("EXIF invalide", 400, "bad_exif")
    if tiff[:2] == b"II":
        end = "<"
    elif tiff[:2] == b"MM":
        end = ">"
    else:
        raise _bad("EXIF invalide", 400, "bad_exif")
    if struct.unpack(end + "H", tiff[2:4])[0] != 42:
        raise _bad("EXIF invalide", 400, "bad_exif")
    off = struct.unpack(end + "I", tiff[4:8])[0]
    if off < 8 or off + 2 > len(tiff):
        raise _bad("EXIF invalide", 400, "bad_exif")
    count = struct.unpack(end + "H", tiff[off : off + 2])[0]
    if count > 1024 or off + 2 + count * 12 > len(tiff):
        raise _bad("EXIF invalide", 400, "bad_exif")
    for i in range(count):
        entry = tiff[off + 2 + i * 12 : off + 14 + i * 12]
        tag, typ, cnt = struct.unpack(end + "HHI", entry[:8])
        if tag != 0x0112:
            continue
        if typ != 3 or cnt != 1:
            raise _bad("EXIF invalide", 400, "bad_exif")
        value = struct.unpack(end + "H", entry[8:10])[0]
        if not 1 <= value <= 8:
            raise _bad("EXIF invalide", 400, "bad_exif")
        return value
    return None


def _check_orientation(block: bytes) -> None:
    """``block`` is an Exif payload (optionally prefixed ``Exif\\0\\0``)."""
    tiff = block[6:] if block.startswith(b"Exif\x00\x00") else block
    value = _orientation_tiff(tiff)
    if value is not None and value != 1:
        raise _bad(
            "Image pivotée par EXIF (orientation ≠ 1) non prise en charge — le navigateur doit l'appliquer aux pixels",
            415,
            "exif_orientation",
        )


def _dims_ok(w: int, h: int) -> tuple[int, int]:
    if w < 1 or h < 1:
        raise _bad()
    if max(w, h) > MAX_LONG_SIDE:
        raise MediaError(f"Image trop grande (max {MAX_LONG_SIDE} px sur le grand côté)", 413, "image_dimensions")
    return w, h


_JPEG_SOF = {0xC0, 0xC1, 0xC2}
_JPEG_SOF_OTHER = {0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


def _parse_jpeg(f, size: int, quick: bool = False) -> tuple[int, int]:
    f.seek(0)
    if f.read(2) != b"\xff\xd8":
        raise _bad()
    dims: tuple[int, int] | None = None
    exif = False
    while True:
        lead = f.read(1)
        if not lead:
            raise _bad()
        if lead != b"\xff":
            raise _bad()
        marker = f.read(1)
        while marker == b"\xff":
            marker = f.read(1)
        if not marker:
            raise _bad()
        mk = marker[0]
        if mk == 0x00 or mk == 0xD8 or mk == 0xD9:
            raise _bad()
        if mk == 0x01 or 0xD0 <= mk <= 0xD7:
            continue
        raw = f.read(2)
        if len(raw) != 2:
            raise _bad()
        length = struct.unpack(">H", raw)[0]
        if length < 2:
            raise _bad()
        body = length - 2
        if f.tell() + body > size:
            raise _bad()
        if mk in _JPEG_SOF_OTHER:
            raise _bad("JPEG non pris en charge (mode de compression)", 415, "unsupported_image")
        if mk in _JPEG_SOF:
            if dims is not None or body < 6:
                raise _bad()
            data = f.read(body)
            precision, height, width, comps = struct.unpack(">BHHB", data[:6])
            if precision != 8 or comps not in (1, 3) or body != 6 + comps * 3:
                raise _bad("JPEG non pris en charge", 415, "unsupported_image")
            dims = _dims_ok(width, height)
            if quick:
                return dims
        elif mk == 0xE1:
            data = f.read(body)
            if data.startswith(b"Exif\x00\x00"):
                if exif:
                    raise _bad("EXIF invalide", 400, "bad_exif")
                exif = True
                _check_orientation(data)
        elif mk == 0xDA:
            if dims is None:
                raise _bad()
            break
        else:
            f.seek(body, 1)
    f.seek(max(size - 2, 0))
    if f.read(2) != b"\xff\xd9":
        raise _bad()
    return dims


_PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _parse_png(f, size: int, quick: bool = False) -> tuple[int, int]:
    f.seek(0)
    if f.read(8) != _PNG_SIG:
        raise _bad()
    dims: tuple[int, int] | None = None
    color = -1
    seen_idat = seen_plte = False
    first = True
    while True:
        head = f.read(8)
        if len(head) != 8:
            raise _bad()
        length, ctype = struct.unpack(">I4s", head)
        if length > 0x7FFFFFFF or f.tell() + length + 4 > size:
            raise _bad()
        if not all(65 <= c <= 90 or 97 <= c <= 122 for c in ctype):
            raise _bad()
        crc = zlib.crc32(ctype)
        if first:
            if ctype != b"IHDR" or length != 13:
                raise _bad()
            data = f.read(13)
            crc = zlib.crc32(data, crc)
            width, height, depth, color, comp, filt, interlace = struct.unpack(">IIBBBBB", data)
            if color not in (0, 2, 3, 4, 6) or comp != 0 or filt != 0 or interlace not in (0, 1):
                raise _bad()
            if depth not in {0: (1, 2, 4, 8, 16), 2: (8, 16), 3: (1, 2, 4, 8), 4: (8, 16), 6: (8, 16)}[color]:
                raise _bad()
            dims = _dims_ok(width, height)
            if quick:
                return dims
            first = False
        else:
            if ctype == b"IHDR":
                raise _bad()
            if ctype in (b"eXIf", b"PLTE") and length > 65536:
                raise _bad()
            if ctype in (b"acTL", b"fcTL", b"fdAT"):
                raise _bad("PNG animé non pris en charge", 415, "unsupported_image")
            remaining = length
            payload = b""
            keep = ctype == b"eXIf"
            while remaining:
                piece = f.read(min(READ_CHUNK, remaining))
                if not piece:
                    raise _bad()
                crc = zlib.crc32(piece, crc)
                if keep:
                    payload += piece
                remaining -= len(piece)
            if ctype == b"PLTE":
                seen_plte = True
            elif ctype == b"IDAT":
                if color == 3 and not seen_plte:
                    raise _bad()
                seen_idat = True
            elif keep:
                _check_orientation(payload)
        tail = f.read(4)
        if len(tail) != 4 or struct.unpack(">I", tail)[0] != (crc & 0xFFFFFFFF):
            raise _bad()
        if ctype == b"IEND":
            if length != 0 or not seen_idat or f.tell() != size:
                raise _bad()
            return dims


def _parse_webp(f, size: int, quick: bool = False) -> tuple[int, int]:
    f.seek(0)
    head = f.read(12)
    if len(head) != 12 or head[:4] != b"RIFF" or head[8:] != b"WEBP":
        raise _bad()
    if struct.unpack("<I", head[4:8])[0] + 8 != size or size < 20:
        raise _bad()
    canvas: tuple[int, int] | None = None
    image: tuple[int, int] | None = None
    first = True
    pos = 12
    while pos < size:
        f.seek(pos)
        ch = f.read(8)
        if len(ch) != 8:
            raise _bad()
        fourcc, length = ch[:4], struct.unpack("<I", ch[4:])[0]
        span = 8 + length + (length & 1)
        if pos + span > size:
            raise _bad()
        if fourcc == b"VP8X":
            if not first or length != 10:
                raise _bad()
            data = f.read(10)
            if data[0] & 0x02:
                raise _bad("WebP animé non pris en charge", 415, "unsupported_image")
            canvas = _dims_ok(int.from_bytes(data[4:7], "little") + 1, int.from_bytes(data[7:10], "little") + 1)
        elif fourcc in (b"ANIM", b"ANMF"):
            raise _bad("WebP animé non pris en charge", 415, "unsupported_image")
        elif fourcc == b"VP8 ":
            if image is not None or length < 10:
                raise _bad()
            data = f.read(10)
            if data[0] & 1 or data[3:6] != b"\x9d\x01\x2a":
                raise _bad()
            image = _dims_ok(struct.unpack("<H", data[6:8])[0] & 0x3FFF, struct.unpack("<H", data[8:10])[0] & 0x3FFF)
        elif fourcc == b"VP8L":
            if image is not None or length < 5:
                raise _bad()
            data = f.read(5)
            if data[0] != 0x2F:
                raise _bad()
            bits = struct.unpack("<I", data[1:5])[0]
            image = _dims_ok((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
        elif fourcc == b"EXIF":
            if length > 65536:
                raise _bad("EXIF invalide", 400, "bad_exif")
            _check_orientation(f.read(length))
        first = False
        pos += span
        if quick and image is not None:
            return image
    if pos != size or image is None or (canvas is not None and canvas != image):
        raise _bad()
    return image


def sniff(f) -> str:
    """Detect the type from the leading bytes only. Raises 415 for anything else."""
    f.seek(0)
    head = f.read(12)
    if head[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if head[:8] == _PNG_SIG:
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    raise MediaError("Format non pris en charge (JPEG, PNG ou WebP)", 415, "unsupported_type")


def inspect_file(f, size: int, quick: bool = False) -> tuple[str, int, int]:
    """(mime, width, height) of an open binary file, or MediaError. Bounded reads, no decoding.

    ``quick`` stops as soon as the dimensions are known (header only): used to re-check metadata of an asset that
    was fully validated at upload (write-once), so a save never re-reads megabytes under the notebook lock.
    """
    if size < 1 or size > MAX_FILE_BYTES:
        raise MediaError("Fichier trop volumineux", 413, "file_too_large")
    mime = sniff(f)
    parser = {"image/jpeg": _parse_jpeg, "image/png": _parse_png, "image/webp": _parse_webp}[mime]
    w, h = parser(f, size, quick)
    return mime, w, h


# ---------------------------------------------------------------- upload


def _fsync_dir(directory: Path) -> None:
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _remove_quiet(path: Path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def _clean_stale_tmp(directory: Path) -> None:
    now = time.time()
    with _reserved_guard:
        live = set(_reserved)
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return
    for entry in entries:
        if entry.name.startswith(_TMP_PREFIX) and entry.name not in live and entry.is_file(follow_symlinks=False):
            try:
                if now - entry.stat(follow_symlinks=False).st_mtime > STALE_TMP_SECONDS:
                    os.unlink(entry.path)
            except OSError:
                pass


def store_upload(read: Callable[[int], bytes], length: Any, declared_mime: str | None = None) -> dict:
    """Persist one uploaded image. ``read(n)`` yields at most ``n`` bytes (empty = connection ended early).

    Order: cheap refusals (length, slot, quota reservation) -> stream to a generated tmp file -> validate the
    real content -> atomic finalisation under the assets lock. Every failure removes its own tmp file.
    """
    if isinstance(length, bool) or not isinstance(length, int) or length <= 0:
        raise MediaError("Longueur invalide", 400, "bad_length")
    if length > MAX_FILE_BYTES:
        raise MediaError(f"Image trop volumineuse (max {MAX_FILE_BYTES // (1024 * 1024)} Mo)", 413, "file_too_large")
    if declared_mime is not None and declared_mime not in MIME_EXT:
        raise MediaError("Format non pris en charge (JPEG, PNG ou WebP)", 415, "unsupported_type")
    if not _slots.acquire(blocking=False):
        raise MediaError("Un autre téléversement est en cours — réessaie dans un instant", 429, "busy")
    root = _root()
    tmp: Path | None = None
    tmp_name = ""
    try:
        with assets_lock(root):
            directory = confined_assets_dir(root, create=True)
            _clean_stale_tmp(directory)
            files, used = _usage_locked(directory)
            if files >= MAX_FILES or used + length > MAX_TOTAL_BYTES:
                raise _quota_error(files, used)
            tmp_name = _TMP_PREFIX + secrets.token_hex(12)
            tmp = directory / tmp_name
            with _reserved_guard:
                _reserved[tmp_name] = length
        try:
            received = 0
            with open(tmp, "xb") as out:
                while received < length:
                    piece = read(min(READ_CHUNK, length - received))
                    if not piece:
                        raise MediaError("Téléversement interrompu", 400, "interrupted")
                    if len(piece) > length - received:
                        raise MediaError("Corps plus long que annoncé", 400, "bad_length")
                    out.write(piece)
                    received += len(piece)
                out.flush()
                os.fsync(out.fileno())
            with open(tmp, "rb") as check:
                mime, width, height = inspect_file(check, received)
            if declared_mime is not None and declared_mime != mime:
                raise MediaError("Type déclaré différent du contenu réel", 415, "mime_mismatch")
            with assets_lock(root):
                directory = confined_assets_dir(root, create=True)
                asset_id = "asset-" + secrets.token_hex(12)
                final = directory / (asset_id + MIME_EXT[mime])
                if os.path.lexists(final):  # 96 random bits: practically unreachable, still never clobber
                    raise MediaError("Conflit de nom — réessaie", 409, "name_conflict")
                os.replace(tmp, final)
                tmp = None
                _fsync_dir(directory)
                if not _same(os.path.realpath(final), os.path.join(os.path.realpath(directory), final.name)):
                    _remove_quiet(final)
                    raise MediaError(_ESCAPED, 409, "storage_error")
        finally:
            if tmp is not None:
                _remove_quiet(tmp)
            with _reserved_guard:
                _reserved.pop(tmp_name, None)
        return {"ok": True, "asset": {"id": asset_id, "mime": mime, "w": width, "h": height, "bytes": received}}
    except OSError as e:
        raise MediaError("Enregistrement de l'image impossible", 503, "storage_error") from e
    finally:
        _slots.release()


# ---------------------------------------------------------------- lookup / serving / references


def _find_file(directory: Path, asset_id: str) -> Path | None:
    if not isinstance(asset_id, str) or not ID_RE.match(asset_id):
        return None
    for ext in MIME_EXT.values():
        candidate = directory / (asset_id + ext)
        if os.path.lexists(candidate):
            return candidate
    return None


def open_asset(asset_id: str, root: Path | str | None = None) -> tuple[Any, str, int]:
    """Open a stored asset for reading: (binary file, mime, size). 404 for unknown/invalid/redirected."""
    root = _root() if root is None else root
    directory = confined_assets_dir(root)
    candidate = _find_file(directory, asset_id)
    if candidate is None or _is_link(candidate):
        raise MediaError("Image introuvable", 404, "not_found")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(candidate, flags)
    except OSError as e:
        raise MediaError("Image introuvable", 404, "not_found") from e
    try:
        st = os.fstat(fd)
        import stat as _stat

        if not _stat.S_ISREG(st.st_mode) or st.st_size > MAX_FILE_BYTES:
            raise MediaError("Image introuvable", 404, "not_found")
        handle = os.fdopen(fd, "rb")
    except Exception:
        os.close(fd)
        raise
    return handle, EXT_MIME[candidate.suffix], st.st_size


def verify_asset(asset: dict) -> None:
    """A referenced asset must exist and match the stored metadata (mime, w, h) read from the real file."""
    try:
        handle, mime, size = open_asset(asset["id"])
    except MediaError as e:
        if e.code == "not_found":
            raise MediaError("Image inconnue du carnet — téléverse-la à nouveau", 400, "unknown_asset") from e
        raise
    with handle:
        real_mime, w, h = inspect_file(handle, size, quick=True)
    if (real_mime, w, h) != (asset["mime"], asset["w"], asset["h"]) or real_mime != mime:
        raise MediaError("Métadonnées d'image incohérentes avec le fichier", 400, "asset_mismatch")


def asset_exists(asset_id: str) -> bool:
    try:
        handle, _mime, _size = open_asset(asset_id)
    except MediaError:
        return False
    handle.close()
    return True


def copy_asset(asset_id: str, dest: Path, root: Path | str | None = None) -> int:
    """Stream an asset into a NEW file ``dest`` (exclusive create). Returns the bytes copied.

    Only our own partial file is removed on failure. Raises MediaError(not_found) when absent/redirected.
    """
    handle, _mime, size = open_asset(asset_id, root)
    created = False
    copied = 0
    try:
        with handle, open(dest, "xb") as out:
            created = True
            while True:
                piece = handle.read(READ_CHUNK)
                if not piece:
                    break
                out.write(piece)
                copied += len(piece)
            out.flush()
            os.fsync(out.fileno())
        if copied != size:
            raise OSError("short copy")
    except BaseException:
        if created:
            _remove_quiet(dest)
        raise
    return copied


def copy_assets_to(root: Path | str, ids: list[str], dest_dir: Path) -> dict:
    """Backup helper: copy exactly ``ids`` (referenced assets) into ``dest_dir`` (created). The caller holds the
    assets lock. Never copies anything else (temp, unrelated, symlinks). A missing/unreadable asset is counted,
    never raised: the caller marks the snapshot invalid."""
    copied = total = missing = 0
    if ids:
        dest_dir.mkdir(parents=True, exist_ok=True)
    for asset_id in sorted(ids):
        directory = confined_assets_dir(root)
        found = _find_file(directory, asset_id)
        if found is None:
            missing += 1
            continue
        try:
            total += copy_asset(asset_id, dest_dir / found.name, root)
            copied += 1
        except (MediaError, OSError):
            missing += 1
    return {"count": copied, "bytes": total, "missing": missing}
