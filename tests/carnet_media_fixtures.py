"""Stdlib-only image byte builders for the Carnet Stage 06 tests (no binary fixtures in the repo).

The server validates container structure, never pixels, so the PNG/JPEG here are real decodable files
(solid colour) while the WebP builders are structurally valid containers (``webp_real_1x1`` is a real
decodable lossless file). Browser tests produce real encoder output through canvas instead.
"""

from __future__ import annotations

import base64
import struct
import zlib


def _chunk(kind: bytes, data: bytes, *, bad_crc: bool = False) -> bytes:
    crc = zlib.crc32(kind + data) & 0xFFFFFFFF
    if bad_crc:
        crc ^= 1
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)


def tiff_exif(orientation: int | None, *, endian: str = "<", prefix: bool = True) -> bytes:
    """Exif payload with one IFD0 entry (Orientation) or an empty IFD0 when ``orientation`` is None."""
    bo = b"II" if endian == "<" else b"MM"
    head = bo + struct.pack(endian + "HI", 42, 8)
    if orientation is None:
        ifd = struct.pack(endian + "H", 0) + struct.pack(endian + "I", 0)
    else:
        ifd = struct.pack(endian + "H", 1) + struct.pack(endian + "HHIHH", 0x0112, 3, 1, orientation, 0) + struct.pack(endian + "I", 0)
    return (b"Exif\x00\x00" if prefix else b"") + head + ifd


def png(w: int = 8, h: int = 6, *, exif: bytes | None = None, idat: bytes | None = None, bad_crc: bool = False,
        truncate: int = 0, animated: bool = False, color: int = 2) -> bytes:
    """PNG (8-bit RGB by default). ``idat`` overrides the compressed payload (used to reach a target size)."""
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color]
    if idat is None:
        row = b"\x00" + bytes([200, 120, 40][:channels] + [255] * max(0, channels - 3)) * w
        idat = zlib.compress(row * h, 9)
    out = b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, color, 0, 0, 0))
    if animated:
        out += _chunk(b"acTL", struct.pack(">II", 1, 0))
    if exif is not None:
        out += _chunk(b"eXIf", exif[6:] if exif.startswith(b"Exif\x00\x00") else exif)
    out += _chunk(b"IDAT", idat, bad_crc=bad_crc) + _chunk(b"IEND", b"")
    return out[: len(out) - truncate] if truncate else out


def png_of_size(target: int, w: int = 2560, h: int = 2560) -> bytes:
    """A structurally valid PNG of exactly ``target`` bytes (IDAT payload is filler, not a decodable stream)."""
    base = len(png(w, h, idat=b""))
    return png(w, h, idat=b"\x55" * (target - base))


_STD_DC = {0: "00", 1: "010", 2: "011", 3: "100", 4: "101", 5: "110", 6: "1110"}


def jpeg(w: int = 16, h: int = 16, *, orientation: int | None = None, exif: bytes | None = None, eoi: bool = True,
         truncate: int = 0, com_pad: int = 0, progressive: bool = False, components: int = 1, two_exif: bool = False) -> bytes:
    """Baseline grayscale JPEG (solid mid-gray), decodable by every browser. Standard tables, DC-only MCUs."""
    def seg(marker: int, data: bytes) -> bytes:
        return bytes([0xFF, marker]) + struct.pack(">H", len(data) + 2) + data

    out = b"\xff\xd8" + seg(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
    if orientation is not None and exif is None:
        exif = tiff_exif(orientation)
    if exif is not None:
        out += seg(0xE1, exif)
        if two_exif:
            out += seg(0xE1, exif)
    left = com_pad
    while left > 0:  # COM filler segments (<= 65533 bytes each) to reach a target size
        n = min(65533, left)
        out += seg(0xFE, b"\x00" * n)
        left -= n
    out += seg(0xDB, b"\x00" + bytes([16] * 64))
    out += seg(0xC2 if progressive else 0xC0, struct.pack(">BHHB", 8, h, w, components) + b"".join(bytes([i + 1, 0x11, 0]) for i in range(components)))
    counts = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
    out += seg(0xC4, b"\x00" + bytes(counts) + bytes(range(12)))
    ac_counts = [0, 1] + [0] * 14
    out += seg(0xC4, b"\x10" + bytes(ac_counts) + bytes([0x00]))  # AC table: only EOB, 1-bit code '0'
    out += seg(0xDA, bytes([components]) + b"".join(bytes([i + 1, 0x00]) for i in range(components)) + b"\x00\x3f\x00")
    mcus = ((w + 7) // 8) * ((h + 7) // 8) * components
    bits = ""
    for n in range(mcus):
        diff = 8 if n == 0 else 0  # first DC = +8 (gray 144), the rest repeat it
        if diff == 0:
            bits += _STD_DC[0]
        else:
            cat = diff.bit_length()
            bits += _STD_DC[cat] + format(diff, "b")
        bits += "00"  # AC EOB (the only AC code, 2 bits)
    bits += "1" * (-len(bits) % 8)
    data = bytearray(int(bits[i : i + 8], 2) for i in range(0, len(bits), 8))
    out += bytes(data).replace(b"\xff", b"\xff\x00")
    if eoi:
        out += b"\xff\xd9"
    return out[: len(out) - truncate] if truncate else out


def jpeg_of_size(target: int, w: int = 2560, h: int = 2560) -> bytes:
    need = target - len(jpeg(w, h))
    data = need
    while True:  # COM segments cost 4 bytes of framing each
        segs = -(-data // 65533) if data > 0 else 0
        if data + 4 * segs >= need:
            break
        data += 1
    data = need - 4 * (-(-data // 65533))
    out = jpeg(w, h, com_pad=data)
    assert len(out) == target, (len(out), target)
    return out


def riff(chunks: list[bytes], *, size_delta: int = 0) -> bytes:
    body = b"WEBP" + b"".join(chunks)
    return b"RIFF" + struct.pack("<I", len(body) + size_delta) + body


def _wchunk(fourcc: bytes, data: bytes) -> bytes:
    return fourcc + struct.pack("<I", len(data)) + data + (b"\x00" if len(data) & 1 else b"")


def webp_vp8l(w: int = 8, h: int = 8, *, exif: bytes | None = None, animated: bool = False, size_delta: int = 0) -> bytes:
    bits = (w - 1) | ((h - 1) << 14)
    image = _wchunk(b"VP8L", b"\x2f" + struct.pack("<I", bits) + b"\x00" * 8)
    chunks: list[bytes] = []
    if exif is not None or animated:
        flags = (0x08 if exif is not None else 0) | (0x02 if animated else 0)
        chunks.append(_wchunk(b"VP8X", bytes([flags, 0, 0, 0]) + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")))
    chunks.append(image)
    if exif is not None:
        chunks.append(_wchunk(b"EXIF", exif))
    return riff(chunks, size_delta=size_delta)


def webp_vp8(w: int = 8, h: int = 8) -> bytes:
    frame = b"\x10\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", w, h) + b"\x00" * 6
    return riff([_wchunk(b"VP8 ", frame)])


def webp_of_size(target: int, w: int = 2560, h: int = 2560) -> bytes:
    """Structurally valid lossless WebP of exactly ``target`` bytes (target must be even)."""
    payload = target - 20
    out = riff([b"VP8L" + struct.pack("<I", payload) + b"\x2f" + struct.pack("<I", (w - 1) | ((h - 1) << 14)) + b"\x00" * (payload - 5)])
    assert len(out) == target, (len(out), target)
    return out


def webp_real_1x1() -> bytes:
    return base64.b64decode("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==")
