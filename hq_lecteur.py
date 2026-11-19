"""Lecteur backend helpers: shared state, audio tags + cover art, subtitles.

Standard library only. No import of iphone_bridge: the bridge passes already-confined Paths.
State (playlists, favourites, resume points, recents, preferences) lives in
``<root>/.hq-lecteur/state.json`` and goes through ``hq_state.write_json_atomic``.
"""
from __future__ import annotations

import copy
import json
import os
import re
import secrets
import struct
import time
from pathlib import Path
from typing import Any

import hq_state

STATE_FOLDER = ".hq-lecteur"
STATE_FILE = "state.json"
MAX_PLAYLISTS = 60
MAX_PLAYLIST_ITEMS = 1000
MAX_FAVORITES = 3000
MAX_POSITIONS = 600
MAX_RECENTS = 120
MAX_NAME = 80
MAX_REL = 500
MAX_TAG_BYTES = 12 * 1024 * 1024      # ID3 / FLAC picture blocks are read up to this size
MAX_ART_BYTES = 6 * 1024 * 1024
MAX_SUB_BYTES = 2 * 1024 * 1024
MAX_META_BATCH = 40
SUB_EXTS = (".srt", ".vtt")
AUDIO_TAG_EXTS = (".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wav")

_bound_root: Path | None = None


class LecteurError(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error"):
        super().__init__(message)
        self.status = status
        self.code = code


def bind(*, root: str | Path) -> None:
    global _bound_root
    _bound_root = Path(os.path.abspath(os.fspath(root)))


def reset_for_tests() -> None:
    global _bound_root
    _bound_root = None
    _TAG_CACHE.clear()


# ---------------------------------------------------------------- state ----

def _is_link(path: Path) -> bool:
    try:
        return path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction())
    except OSError:
        return True


def _state_path() -> Path:
    if _bound_root is None:
        raise LecteurError("Lecteur is not initialised", 503, "storage_error")
    base = _bound_root / STATE_FOLDER
    file = base / STATE_FILE
    if _is_link(base) or _is_link(file):
        raise LecteurError("Lecteur storage location was redirected", 503, "storage_error")
    return file


def _default_state() -> dict[str, Any]:
    return {"v": 1, "playlists": [], "favorites": [], "positions": {}, "recents": [], "prefs": {}}


def _clean_rel(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    rel = value.strip().replace("\\", "/")
    if not rel or len(rel) > MAX_REL or rel.startswith("/") or any(ord(c) < 32 for c in rel):
        return None
    if any(part in ("", ".", "..") for part in rel.split("/")):
        return None
    return rel


def _num(value: Any, lo: float, hi: float, default: float = 0.0) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return default
    if n != n or n in (float("inf"), float("-inf")):
        return default
    return max(lo, min(hi, n))


def _normalise(raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce whatever is on disk into the documented shape (never raises)."""
    state = _default_state()
    for pl in raw.get("playlists") or []:
        if not isinstance(pl, dict):
            continue
        pid = str(pl.get("id") or "")
        name = str(pl.get("name") or "").strip()[:MAX_NAME]
        if not re.fullmatch(r"[a-z0-9]{6,20}", pid) or not name:
            continue
        items = [r for r in (_clean_rel(x) for x in (pl.get("items") or [])) if r][:MAX_PLAYLIST_ITEMS]
        state["playlists"].append({"id": pid, "name": name, "items": items,
                                   "updated": int(_num(pl.get("updated"), 0, 4e9))})
    state["playlists"] = state["playlists"][:MAX_PLAYLISTS]
    favs = [r for r in (_clean_rel(x) for x in (raw.get("favorites") or [])) if r]
    state["favorites"] = list(dict.fromkeys(favs))[:MAX_FAVORITES]
    positions = raw.get("positions")
    if isinstance(positions, dict):
        for rel, pos in positions.items():
            clean = _clean_rel(rel)
            if clean and isinstance(pos, dict):
                state["positions"][clean] = {
                    "t": _num(pos.get("t"), 0, 1e7), "d": _num(pos.get("d"), 0, 1e7),
                    "at": int(_num(pos.get("at"), 0, 4e9)), "done": bool(pos.get("done")),
                }
    recents = []
    for item in raw.get("recents") or []:
        if isinstance(item, dict):
            rel = _clean_rel(item.get("rel"))
            if rel:
                recents.append({"rel": rel, "at": int(_num(item.get("at"), 0, 4e9))})
    state["recents"] = recents[:MAX_RECENTS]
    prefs = raw.get("prefs")
    if isinstance(prefs, dict):
        state["prefs"] = _clean_prefs(prefs)
    return state


def _clean_prefs(prefs: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if "rate" in prefs:
        out["rate"] = round(_num(prefs.get("rate"), 0.5, 2.5, 1.0), 2)
    if "shuffle" in prefs:
        out["shuffle"] = bool(prefs.get("shuffle"))
    if prefs.get("repeat") in ("off", "all", "one"):
        out["repeat"] = prefs["repeat"]
    if "volume" in prefs:
        out["volume"] = round(_num(prefs.get("volume"), 0, 1, 1.0), 2)
    return out


def get_state() -> dict[str, Any]:
    file = _state_path()
    with hq_state.path_lock(file):
        if not file.exists():
            return _default_state()
        try:
            obj = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, ValueError) as exc:
            raise LecteurError("Lecteur state is unreadable", 503, "storage_error") from exc
        if not isinstance(obj, dict):
            raise LecteurError("Lecteur state is invalid", 503, "storage_error")
        return _normalise(obj)


def apply_op(body: dict[str, Any]) -> dict[str, Any]:
    """One validated mutation; returns the full state afterwards."""
    if not isinstance(body, dict):
        raise LecteurError("Invalid JSON body")
    op = str(body.get("op") or "")
    file = _state_path()
    with hq_state.path_lock(file):
        state = get_state()
        now = int(time.time())
        if op == "playlist_save":
            raw = body.get("playlist")
            if not isinstance(raw, dict):
                raise LecteurError("playlist manquante")
            name = str(raw.get("name") or "").strip()[:MAX_NAME]
            if not name:
                raise LecteurError("Nom de playlist requis")
            items = [r for r in (_clean_rel(x) for x in (raw.get("items") or [])) if r][:MAX_PLAYLIST_ITEMS]
            pid = str(raw.get("id") or "")
            existing = next((p for p in state["playlists"] if p["id"] == pid), None)
            if existing:
                existing.update(name=name, items=items, updated=now)
            else:
                if len(state["playlists"]) >= MAX_PLAYLISTS:
                    raise LecteurError("Trop de playlists", 409, "limit")
                state["playlists"].append({"id": secrets.token_hex(5), "name": name, "items": items, "updated": now})
        elif op == "playlist_delete":
            pid = str(body.get("id") or "")
            state["playlists"] = [p for p in state["playlists"] if p["id"] != pid]
        elif op == "favorite":
            rel = _clean_rel(body.get("rel"))
            if not rel:
                raise LecteurError("Chemin invalide")
            favs = [r for r in state["favorites"] if r != rel]
            if body.get("on"):
                favs.insert(0, rel)
            state["favorites"] = favs[:MAX_FAVORITES]
        elif op == "position":
            rel = _clean_rel(body.get("rel"))
            if not rel:
                raise LecteurError("Chemin invalide")
            done = bool(body.get("done"))
            state["positions"][rel] = {"t": 0.0 if done else _num(body.get("t"), 0, 1e7),
                                       "d": _num(body.get("d"), 0, 1e7), "at": now, "done": done}
            if len(state["positions"]) > MAX_POSITIONS:
                keep = sorted(state["positions"].items(), key=lambda kv: kv[1]["at"], reverse=True)[:MAX_POSITIONS]
                state["positions"] = dict(keep)
        elif op == "recent":
            rel = _clean_rel(body.get("rel"))
            if not rel:
                raise LecteurError("Chemin invalide")
            state["recents"] = ([{"rel": rel, "at": now}] + [r for r in state["recents"] if r["rel"] != rel])[:MAX_RECENTS]
        elif op == "clear_recents":
            state["recents"] = []
        elif op == "prefs":
            raw = body.get("prefs")
            if not isinstance(raw, dict):
                raise LecteurError("prefs manquantes")
            state["prefs"].update(_clean_prefs(raw))
        else:
            raise LecteurError("Opération inconnue")
        try:
            hq_state.write_json_atomic(file, state)
        except RuntimeError as exc:
            raise LecteurError(str(exc), 503, "storage_error") from exc
        return copy.deepcopy(state)


# ------------------------------------------------------------ subtitles ----

def find_subtitles(video: Path) -> list[dict[str, str]]:
    """Sibling .srt/.vtt named like the video (``clip.srt``, ``clip.fr.srt``)."""
    stem = video.stem.lower()
    found: list[dict[str, str]] = []
    try:
        entries = sorted(os.scandir(video.parent), key=lambda e: e.name.lower())
    except OSError:
        return found
    for entry in entries:
        low = entry.name.lower()
        ext = os.path.splitext(low)[1]
        if ext not in SUB_EXTS or not (low.startswith(stem + ".")):
            continue
        try:
            if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
                continue
            if entry.stat(follow_symlinks=False).st_size > MAX_SUB_BYTES:
                continue
        except OSError:
            continue
        middle = entry.name[len(video.stem) + 1: len(entry.name) - len(ext)].strip(". ")
        found.append({"name": entry.name, "label": middle or "Sous-titres",
                      "lang": middle.lower() if re.fullmatch(r"[a-z]{2,3}(-[a-z0-9]{2,8})?", middle.lower()) else ""})
    return found[:12]


def subtitle_vtt(path: Path) -> str:
    if path.suffix.lower() not in SUB_EXTS:
        raise LecteurError("Format de sous-titres non pris en charge", 415, "unsupported")
    with path.open("rb") as handle:
        data = handle.read(MAX_SUB_BYTES + 1)
    if len(data) > MAX_SUB_BYTES:
        raise LecteurError("Fichier de sous-titres trop volumineux", 413, "too_large")
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = data.decode("cp1252", errors="replace")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if text.lstrip().startswith("WEBVTT"):
        return text
    text = re.sub(r"(\d{1,2}:\d{2}:\d{2}),(\d{3})", r"\1.\2", text)
    return "WEBVTT\n\n" + text.strip() + "\n"


# ------------------------------------------------------------ audio tags ---

_TAG_CACHE: dict[tuple[str, int, int], dict[str, Any]] = {}
_TAG_CACHE_MAX = 3000


def _dec(enc: int, raw: bytes) -> str:
    try:
        if enc == 1:
            return raw.decode("utf-16", errors="replace")
        if enc == 2:
            return raw.decode("utf-16-be", errors="replace")
        if enc == 3:
            return raw.decode("utf-8", errors="replace")
        return raw.decode("latin-1", errors="replace")
    except Exception:
        return ""


def _clean_text(value: str) -> str:
    return re.sub(r"[\x00-\x1f]+", " ", value).strip()[:200]


def _syncsafe(b: bytes) -> int:
    return (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]


def _id3_text(payload: bytes) -> str:
    if not payload:
        return ""
    enc, body = payload[0], payload[1:]
    return _clean_text(_dec(enc, body).split("\x00")[0])


def _split_term(enc: int, data: bytes) -> tuple[bytes, bytes]:
    """Split at the encoding's string terminator: (string, rest)."""
    if enc in (1, 2):
        i = 0
        while i + 1 < len(data):
            if data[i] == 0 and data[i + 1] == 0 and i % 2 == 0:
                return data[:i], data[i + 2:]
            i += 1
        return data, b""
    i = data.find(b"\x00")
    return (data, b"") if i < 0 else (data[:i], data[i + 1:])


def _parse_id3(buf: bytes, want_art: bool, tags: dict[str, Any]) -> tuple[int, tuple[str, bytes] | None]:
    """Fill ``tags`` from an ID3v2 block at the start of ``buf``; return (total tag size, art)."""
    if len(buf) < 10 or buf[:3] != b"ID3":
        return 0, None
    major, flags = buf[3], buf[5]
    size = _syncsafe(buf[6:10])
    end = min(len(buf), 10 + size)
    pos = 10
    if flags & 0x40 and major in (3, 4) and pos + 4 <= end:  # extended header
        ext = _syncsafe(buf[pos:pos + 4]) if major == 4 else struct.unpack(">I", buf[pos:pos + 4])[0] + 4
        pos += max(0, ext)
    art: tuple[str, bytes] | None = None
    names = {"TIT2": "title", "TPE1": "artist", "TALB": "album", "TRCK": "track", "TDRC": "year", "TYER": "year",
             "TT2": "title", "TP1": "artist", "TAL": "album", "TRK": "track", "TYE": "year"}
    while pos + (6 if major == 2 else 10) <= end:
        if major == 2:
            fid = buf[pos:pos + 3].decode("latin-1")
            flen = int.from_bytes(buf[pos + 3:pos + 6], "big")
            hdr = 6
        else:
            fid = buf[pos:pos + 4].decode("latin-1")
            flen = _syncsafe(buf[pos + 4:pos + 8]) if major == 4 else struct.unpack(">I", buf[pos + 4:pos + 8])[0]
            hdr = 10
        if not fid.strip("\x00") or flen <= 0 or pos + hdr + flen > end:
            break
        payload = buf[pos + hdr: pos + hdr + flen]
        if fid in names:
            key = names[fid]
            if key not in tags:
                text = _id3_text(payload)
                if text:
                    tags[key] = text[:4] if key == "year" else text
        elif fid in ("APIC", "PIC") and art is None:
            tags["has_art"] = True
            if want_art:
                enc, rest = payload[0], payload[1:]
                if fid == "PIC":
                    mime = "image/" + rest[:3].decode("latin-1").lower().replace("jpg", "jpeg")
                    rest = rest[3:]
                else:
                    raw_mime, rest = _split_term(0, rest)
                    mime = raw_mime.decode("latin-1")
                rest = rest[1:]  # picture type
                _, data = _split_term(enc, rest)
                art = (mime, data)
        pos += hdr + flen
    return 10 + size, art


_MP3_BITRATES = {
    (1, 1): [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    (1, 2): [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    (1, 3): [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
    (2, 1): [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    (2, 2): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    (2, 3): [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
_MP3_RATES = {1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 3: [11025, 12000, 8000]}


def _mp3_duration(handle, start: int, size: int) -> float | None:
    handle.seek(start)
    head = handle.read(65536)
    for i in range(len(head) - 4):
        if head[i] != 0xFF or head[i + 1] & 0xE0 != 0xE0:
            continue
        b1, b2, b3 = head[i + 1], head[i + 2], head[i + 3]
        ver_bits, layer_bits = (b1 >> 3) & 3, (b1 >> 1) & 3
        if ver_bits == 1 or layer_bits == 0 or (b2 >> 4) in (0, 15) or ((b2 >> 2) & 3) == 3:
            continue
        version = 1 if ver_bits == 3 else 2
        layer = 4 - layer_bits
        table = _MP3_BITRATES.get((version, layer))
        if not table:
            continue
        bitrate = table[b2 >> 4] * 1000
        rate = _MP3_RATES[1 if ver_bits == 3 else (2 if ver_bits == 2 else 3)][(b2 >> 2) & 3]
        mono = (b3 >> 6) == 3
        spf = 384 if layer == 1 else (1152 if layer == 2 or version == 1 else 576)
        side = (17 if mono else 32) if version == 1 else (9 if mono else 17)
        for marker in (b"Xing", b"Info"):
            at = head.find(marker, i + 4, i + 4 + side + 40)
            if at >= 0 and at + 12 <= len(head):
                flags = struct.unpack(">I", head[at + 4:at + 8])[0]
                if flags & 1:
                    frames = struct.unpack(">I", head[at + 8:at + 12])[0]
                    if frames:
                        return frames * spf / rate
        at = head.find(b"VBRI", i + 4, i + 4 + 40)
        if at >= 0 and at + 18 <= len(head):
            frames = struct.unpack(">I", head[at + 14:at + 18])[0]
            if frames:
                return frames * spf / rate
        if bitrate:
            return max(0, size - (start + i)) * 8 / bitrate
        return None
    return None


def _boxes(buf: bytes, start: int = 0, end: int | None = None):
    end = len(buf) if end is None else end
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack(">I4s", buf[pos:pos + 8])
        hdr = 8
        if size == 1 and pos + 16 <= end:
            size = struct.unpack(">Q", buf[pos + 8:pos + 16])[0]
            hdr = 16
        elif size == 0:
            size = end - pos
        if size < hdr or pos + size > end:
            break
        yield kind, pos + hdr, pos + size
        pos += size


def _parse_mp4(handle, size: int, want_art: bool, tags: dict[str, Any]) -> tuple[str, bytes] | None:
    moov = None
    pos = 0
    while pos + 8 <= size:
        handle.seek(pos)
        head = handle.read(16)
        if len(head) < 8:
            break
        box_size, kind = struct.unpack(">I4s", head[:8])
        hdr = 8
        if box_size == 1 and len(head) >= 16:
            box_size = struct.unpack(">Q", head[8:16])[0]
            hdr = 16
        elif box_size == 0:
            box_size = size - pos
        if box_size < hdr:
            break
        if kind == b"moov":
            if box_size - hdr > MAX_TAG_BYTES:
                break
            handle.seek(pos + hdr)
            moov = handle.read(box_size - hdr)
            break
        pos += box_size
    if not moov:
        return None
    art = None
    for kind, a, b in _boxes(moov):
        if kind == b"mvhd" and b - a >= 20:
            if moov[a] == 1 and b - a >= 32:
                timescale, duration = struct.unpack(">IQ", moov[a + 20:a + 32])
            else:
                timescale, duration = struct.unpack(">II", moov[a + 12:a + 20])
            if timescale and duration:
                tags["duration"] = duration / timescale
        elif kind == b"udta":
            for k2, a2, b2 in _boxes(moov, a, b):
                if k2 != b"meta":
                    continue
                for k3, a3, b3 in _boxes(moov, a2 + 4, b2):
                    if k3 != b"ilst":
                        continue
                    for item, a4, b4 in _boxes(moov, a3, b3):
                        for k5, a5, b5 in _boxes(moov, a4, b4):
                            if k5 != b"data" or b5 - a5 < 8:
                                continue
                            dtype = int.from_bytes(moov[a5 + 1:a5 + 4], "big")
                            payload = moov[a5 + 8:b5]
                            keys = {b"\xa9nam": "title", b"\xa9ART": "artist", b"\xa9alb": "album", b"\xa9day": "year"}
                            if item in keys and keys[item] not in tags:
                                text = _clean_text(payload.decode("utf-8", errors="replace"))
                                if text:
                                    tags[keys[item]] = text[:4] if keys[item] == "year" else text
                            elif item == b"aART" and "artist" not in tags:
                                text = _clean_text(payload.decode("utf-8", errors="replace"))
                                if text:
                                    tags["artist"] = text
                            elif item == b"trkn" and len(payload) >= 4 and "track" not in tags:
                                n = struct.unpack(">H", payload[2:4])[0]
                                if n:
                                    tags["track"] = str(n)
                            elif item == b"covr" and art is None:
                                tags["has_art"] = True
                                if want_art:
                                    art = ("image/png" if dtype == 14 else "image/jpeg", bytes(payload))
    return art


def _vorbis_comments(data: bytes, tags: dict[str, Any]) -> None:
    try:
        vlen = struct.unpack("<I", data[:4])[0]
        pos = 4 + vlen
        count = struct.unpack("<I", data[pos:pos + 4])[0]
        pos += 4
        keys = {"TITLE": "title", "ARTIST": "artist", "ALBUM": "album", "TRACKNUMBER": "track", "DATE": "year"}
        for _ in range(min(count, 200)):
            clen = struct.unpack("<I", data[pos:pos + 4])[0]
            entry = data[pos + 4:pos + 4 + clen].decode("utf-8", errors="replace")
            pos += 4 + clen
            if "=" not in entry:
                continue
            k, v = entry.split("=", 1)
            key = keys.get(k.upper())
            if key and key not in tags:
                text = _clean_text(v)
                if text:
                    tags[key] = text[:4] if key == "year" else text.split("/")[0] if key == "track" else text
    except (struct.error, IndexError):
        return


def _parse_flac(handle, size: int, want_art: bool, tags: dict[str, Any]) -> tuple[str, bytes] | None:
    handle.seek(4)
    art = None
    while handle.tell() < size:
        head = handle.read(4)
        if len(head) < 4:
            break
        last, kind, length = head[0] & 0x80, head[0] & 0x7F, int.from_bytes(head[1:4], "big")
        if kind == 0 and length >= 18:
            info = handle.read(length)
            rate = (info[10] << 12) | (info[11] << 4) | (info[12] >> 4)
            total = ((info[13] & 0x0F) << 32) | int.from_bytes(info[14:18], "big")
            if rate and total:
                tags["duration"] = total / rate
        elif kind == 4 and length <= MAX_TAG_BYTES:
            _vorbis_comments(handle.read(length), tags)
        elif kind == 6 and length <= MAX_TAG_BYTES:
            tags["has_art"] = True
            blob = handle.read(length)
            if want_art and art is None:
                try:
                    mlen = struct.unpack(">I", blob[4:8])[0]
                    mime = blob[8:8 + mlen].decode("latin-1")
                    p = 8 + mlen
                    dlen = struct.unpack(">I", blob[p:p + 4])[0]
                    p += 4 + dlen + 16
                    plen = struct.unpack(">I", blob[p:p + 4])[0]
                    art = (mime, blob[p + 4:p + 4 + plen])
                except (struct.error, IndexError):
                    pass
        else:
            handle.seek(length, 1)
        if last:
            break
    return art


def _parse_ogg(handle, tags: dict[str, Any]) -> None:
    handle.seek(0)
    head = handle.read(65536)
    for marker in (b"OpusTags", b"\x03vorbis"):
        at = head.find(marker)
        if at >= 0:
            _vorbis_comments(head[at + len(marker):], tags)
            return


def _parse_wav(handle, size: int, tags: dict[str, Any]) -> None:
    handle.seek(12)
    byte_rate = 0
    while handle.tell() + 8 <= size:
        head = handle.read(8)
        if len(head) < 8:
            return
        kind, length = head[:4], struct.unpack("<I", head[4:])[0]
        if kind == b"fmt " and length >= 12:
            byte_rate = struct.unpack("<I", handle.read(length)[8:12])[0]
            handle.seek(length & 1, 1)
        elif kind == b"data":
            if byte_rate:
                tags["duration"] = min(length, size) / byte_rate
            return
        else:
            handle.seek(length + (length & 1), 1)


def _read_audio(path: Path, want_art: bool) -> tuple[dict[str, Any], tuple[str, bytes] | None]:
    ext = path.suffix.lower()
    tags: dict[str, Any] = {}
    art = None
    if ext not in AUDIO_TAG_EXTS:
        return tags, None
    with path.open("rb") as handle:
        size = os.fstat(handle.fileno()).st_size
        magic = handle.read(12)
        handle.seek(0)
        if magic[:3] == b"ID3" or ext == ".mp3":
            buf = handle.read(min(size, MAX_TAG_BYTES)) if magic[:3] == b"ID3" else b""
            tag_size, art = _parse_id3(buf, want_art, tags)
            dur = _mp3_duration(handle, tag_size, size)
            if dur:
                tags["duration"] = dur
        elif magic[:4] == b"fLaC":
            art = _parse_flac(handle, size, want_art, tags)
        elif magic[4:8] == b"ftyp":
            art = _parse_mp4(handle, size, want_art, tags)
        elif magic[:4] == b"OggS":
            _parse_ogg(handle, tags)
        elif magic[:4] == b"RIFF":
            _parse_wav(handle, size, tags)
    return tags, art


def read_tags(path: Path) -> dict[str, Any]:
    """Cached by (path, size, mtime). Never raises on a malformed file: returns what it could read."""
    try:
        st = path.stat()
    except OSError:
        return {}
    key = (str(path), st.st_size, st.st_mtime_ns)
    hit = _TAG_CACHE.get(key)
    if hit is not None:
        return dict(hit)
    try:
        tags, _ = _read_audio(path, False)
    except (OSError, struct.error, ValueError, IndexError):
        tags = {}
    if "duration" in tags:
        tags["duration"] = round(float(tags["duration"]), 2)
    if len(_TAG_CACHE) >= _TAG_CACHE_MAX:
        _TAG_CACHE.pop(next(iter(_TAG_CACHE)))
    _TAG_CACHE[key] = tags
    return dict(tags)


_ART_TYPES = ((b"\xff\xd8\xff", "image/jpeg"), (b"\x89PNG\r\n\x1a\n", "image/png"), (b"RIFF", "image/webp"))


def read_art(path: Path) -> tuple[str, bytes] | None:
    """Embedded cover as (mime, bytes); the type comes from the bytes, never from the tag."""
    try:
        _, art = _read_audio(path, True)
    except (OSError, struct.error, ValueError, IndexError):
        return None
    if not art or not art[1] or len(art[1]) > MAX_ART_BYTES:
        return None
    data = art[1]
    for magic, mime in _ART_TYPES:
        if data.startswith(magic) and (mime != "image/webp" or data[8:12] == b"WEBP"):
            return mime, data
    return None
