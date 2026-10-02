"""Synthetic audio containers for the Phase-4 voice store tests (structure only: the server never decodes audio)."""

from __future__ import annotations

import struct


def _ebml_vint(n: int) -> bytes:
    for length in range(1, 9):
        if n < (1 << (7 * length)) - 1:
            return ((1 << (7 * length)) | n).to_bytes(length, "big")
    raise ValueError(n)


def webm(payload: int = 64, doctype: bytes = b"webm", with_segment: bool = True) -> bytes:
    body = b"\x42\x86\x81\x01" + b"\x42\x82" + _ebml_vint(len(doctype)) + doctype + b"\x42\x87\x81\x04"
    head = b"\x1a\x45\xdf\xa3" + _ebml_vint(len(body)) + body
    if with_segment:
        head += b"\x18\x53\x80\x67" + b"\x01\xff\xff\xff\xff\xff\xff\xff" + b"\x1f\x43\xb6\x75" + _ebml_vint(payload) + b"\x00" * payload
    return head


def _box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", 8 + len(body)) + kind + body


def mp4(payload: int = 64, moov: bool = True, brand: bytes = b"isom") -> bytes:
    out = _box(b"ftyp", brand + b"\x00\x00\x02\x00" + b"isomiso2mp41")
    if moov:
        out += _box(b"moov", _box(b"mvhd", b"\x00" * 24))
    out += _box(b"mdat", b"\x00" * payload)
    return out


def ogg(head: bytes = b"OpusHead\x01\x01\x38\x01\x80\xbb\x00\x00\x00\x00\x00", extra: int = 32) -> bytes:
    page = b"OggS" + b"\x00" + b"\x02" + b"\x00" * 8 + b"\x01\x00\x00\x00" + b"\x00\x00\x00\x00" + b"\x00\x00\x00\x00" + bytes([1]) + bytes([len(head)])
    return page + head + b"\x00" * extra


def wav(seconds: float = 0.1, rate: int = 16000) -> bytes:
    n = int(seconds * rate)
    data = b"\x00\x00" * n
    return b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)) + data
