"""Carnet Product Phase 4: voice notes (confined, write-once audio storage) and the optional transcription adapter.

Storage: ``<ROOT>/.hq-carnet/voice/voice-<24 hex>.<webm|m4a|ogg>``. File names are server-generated and opaque; no client
path, file name or extension is ever read. Audio never enters ``notebook.json``: a page stores one bounded ``voice`` block
(``{id, mime, dur_ms, recorded_at}``, see ``hq_carnet_rich``). ``id`` is the VOICE ASSET id, never the block id.

This is a sibling of the Stage-06 image store with the same guarantees (streamed bounded upload, quota reservation, atomic
finalisation, redirected directories refused, errors never contain a path) and its OWN quota, so audio cannot exhaust the
image budget. What the server does and does NOT do (there is no audio decoder in this stdlib-only server):

- it never transcodes: the browser records in its native container (WebM/Opus on Chromium, MP4/AAC on Safari, Ogg/Opus on
  Firefox) and that exact file is what is stored;
- it validates the CONTAINER structure (WebM: EBML header with DocType ``webm`` followed by a Segment; MP4: ``ftyp`` first,
  a top-level box walk that ends exactly at the end of the file, a ``moov`` box; Ogg: capture pattern and an Opus/Vorbis head
  packet) and refuses anything else; it cannot detect corrupt entropy-coded audio inside a well-formed container, and it
  cannot tell an audio-only file from one that also carries a video track;
- the duration is client-recorded display metadata, never trusted as a size or security measure: the byte size and the
  quota are authoritative;
- the declared MIME (``X-Carnet-Mime``) is never trusted: if present it must equal the detected type.

Lifecycle: an upload is durable as soon as it is finalised. Removing a voice block deletes nothing; there is NO deletion API
and no garbage collection (an orphan keeps consuming the quota, exactly like Stage-06 images).

Transcription (adapter only, nothing is downloaded or installed by this code): ``bridge_config.json`` may carry
``"transcribe_command": ["<absolute exe>", ..., "{input}", ...]``. Without it the endpoint answers "Transcription non
configurée". The command runs WITHOUT a shell, with a hard timeout, on a temporary 16 kHz mono WAV produced by the browser;
the only client-influenced argument is the generated temp path.

Locks: the voice lock is independent of the assets lock; neither takes the other (backup takes the assets lock, then this one
briefly). ``page_save`` holds only the notebook lock and never takes this lock (voice files are write-once).
"""

from __future__ import annotations

import os
import re
import secrets
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

import hq_carnet_media as _media
import hq_state

DIR_NAME = ".hq-carnet"
VOICE_DIR = "voice"

MAX_FILE_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 250 * 1024 * 1024
MAX_FILES = 256
DUR_MS_MAX = 10 * 60 * 1000  # display metadata (the browser stops recording at this duration)
VOICES_PER_PAGE_MAX = 32
TRANSCRIPT_CHARS_MAX = 20000
WAV_MAX_BYTES = 24 * 1024 * 1024  # 16 kHz / 16 bit / mono for 10 minutes is ~19.2 MB
CONCURRENT_UPLOADS = 2
READ_CHUNK = 64 * 1024
STALE_TMP_SECONDS = 3600
TRANSCRIBE_TIMEOUT_SECONDS = 900
TRANSCRIBE_OUTPUT_MAX = 1024 * 1024

MIME_EXT = {"audio/webm": ".webm", "audio/mp4": ".m4a", "audio/ogg": ".ogg"}
EXT_MIME = {ext: mime for mime, ext in MIME_EXT.items()}
ID_RE = re.compile(r"^voice-[0-9a-f]{24}\Z")
_NAME_RE = re.compile(r"^(voice-[0-9a-f]{24})(\.webm|\.m4a|\.ogg)\Z")
_TMP_PREFIX = ".tmp-"
_ESCAPED = "Dossier des notes vocales redirigé — refusé"

_cb: dict[str, Any] = {}
_slots = threading.BoundedSemaphore(CONCURRENT_UPLOADS)
_transcribe_slot = threading.BoundedSemaphore(1)
_reserved: dict[str, int] = {}
_reserved_guard = threading.Lock()


class VoiceError(ValueError):
    """Refusal (HTTP ``status``, ``code``). Messages are French, path-free and never echo client input."""

    def __init__(self, message: str, status: int = 400, code: str = "voice_error"):
        super().__init__(message)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    _cb.update(kwargs)


def limits() -> dict:
    return {
        "voice_file_bytes": MAX_FILE_BYTES,
        "voice_total_bytes": MAX_TOTAL_BYTES,
        "voice_files": MAX_FILES,
        "voice_duration_ms": DUR_MS_MAX,
        "voice_per_page": VOICES_PER_PAGE_MAX,
        "voice_mimes": sorted(MIME_EXT),
        "transcript_chars": TRANSCRIPT_CHARS_MAX,
    }


# ---------------------------------------------------------------- confinement


def voice_path(root: Path | str) -> Path:
    return Path(os.path.abspath(os.fspath(root))) / DIR_NAME / VOICE_DIR


def voice_lock(root: Path | str) -> threading.RLock:
    return hq_state.path_lock(voice_path(root))


def _root() -> Path:
    root = _cb.get("root")
    if root is None:
        raise VoiceError("Notes vocales non initialisées", 503, "storage_error")
    return Path(root)


def confined_voice_dir(root: Path | str, *, create: bool = False) -> Path:
    """``voice_path(root)`` after refusing any redirection (symlink/junction/escape) of ``.hq-carnet`` or ``voice``."""
    target = voice_path(root)
    base = target.parent
    try:
        real_root = os.path.realpath(base.parent)
        for index, item in enumerate((base, target)):
            if os.path.lexists(item):
                if _media._is_link(item) or not item.is_dir():
                    raise VoiceError(_ESCAPED, 409, "storage_error")
            elif create:
                item.mkdir()
            else:
                continue
            want = os.path.join(real_root, DIR_NAME) if index == 0 else os.path.join(real_root, DIR_NAME, VOICE_DIR)
            if _media._is_link(item) or not _media._same(os.path.realpath(item), want):
                raise VoiceError(_ESCAPED, 409, "storage_error")
    except OSError as e:
        raise VoiceError("Notes vocales inaccessibles", 503, "storage_error") from e
    return target


def _usage_locked(directory: Path) -> tuple[int, int]:
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
                continue
            count += 1
            try:
                total += entry.stat(follow_symlinks=False).st_size
            except OSError:
                pass
            continue
        if not _NAME_RE.match(name):
            continue
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
    with voice_lock(root):
        directory = confined_voice_dir(root)
        files, used = _usage_locked(directory)
    return {"ok": True, "files": files, "bytes": used, "max_files": MAX_FILES, "max_bytes": MAX_TOTAL_BYTES, "file_bytes": MAX_FILE_BYTES}


def _quota_error(files: int, used: int) -> VoiceError:
    mb = lambda n: f"{n / (1024 * 1024):.0f}"  # noqa: E731
    return VoiceError(
        f"Quota des notes vocales atteint ({mb(used)} Mo sur {MAX_TOTAL_BYTES // (1024 * 1024)} Mo, {files} fichiers sur {MAX_FILES}). "
        "Aucune note vocale n'est supprimée automatiquement.",
        507,
        "quota_exceeded",
    )


# ---------------------------------------------------------------- container validation


def _bad(message: str = "Note vocale corrompue ou tronquée") -> VoiceError:
    return VoiceError(message, 400, "bad_audio")


def _vint(data: bytes, pos: int) -> tuple[int, int, bool]:
    """EBML variable-size integer at ``pos``: (value, length, all-ones 'unknown')."""
    if pos >= len(data):
        raise _bad()
    first = data[pos]
    length = 1
    mask = 0x80
    while length <= 8 and not (first & mask):
        length += 1
        mask >>= 1
    if length > 8 or pos + length > len(data):
        raise _bad()
    value = first & (mask - 1)
    unknown = value == mask - 1
    for b in data[pos + 1 : pos + length]:
        value = (value << 8) | b
        unknown = unknown and b == 0xFF
    return value, length, unknown


def _check_webm(head: bytes, size: int) -> None:
    if head[:4] != b"\x1a\x45\xdf\xa3":
        raise _bad()
    body_size, vlen, unknown = _vint(head, 4)
    if unknown or body_size < 4 or body_size > 512:
        raise _bad()
    start = 4 + vlen
    end = start + body_size
    if end + 4 > len(head) or end + 4 > size:
        raise _bad()
    if b"\x42\x82" not in head[start:end] or b"webm" not in head[start:end]:
        raise _bad("Format audio non pris en charge (WebM attendu)")
    if head[end : end + 4] != b"\x18\x53\x80\x67":  # Segment must follow the EBML header
        raise _bad()


def _check_mp4(f, size: int) -> None:
    pos = 0
    saw_ftyp = saw_moov = False
    boxes = 0
    while pos < size:
        boxes += 1
        if boxes > 200000:
            raise _bad()
        f.seek(pos)
        header = f.read(16)
        if len(header) < 8:
            raise _bad()
        box = int.from_bytes(header[:4], "big")
        kind = header[4:8]
        header_len = 8
        if box == 1:
            if len(header) < 16:
                raise _bad()
            box = int.from_bytes(header[8:16], "big")
            header_len = 16
        elif box == 0:
            box = size - pos
        if box < header_len or pos + box > size:
            raise _bad()
        if pos == 0:
            if kind != b"ftyp" or box < 16 or box > 512 or not re.match(rb"^[A-Za-z0-9 ]{4}$", header[8:12]):
                raise _bad("Format audio non pris en charge (MP4/M4A attendu)")
            saw_ftyp = True
        if kind == b"moov":
            saw_moov = True
        pos += box
    if pos != size or not saw_ftyp or not saw_moov:
        raise _bad()


def _check_ogg(head: bytes, size: int) -> None:
    if len(head) < 28 or head[:4] != b"OggS" or head[4] != 0 or not (head[5] & 0x02):  # version 0, first page of a stream
        raise _bad()
    segments = head[26]
    first = 27 + segments
    payload = head[first : first + 16]
    if not (payload.startswith(b"OpusHead") or payload.startswith(b"\x01vorbis")):
        raise _bad("Format audio non pris en charge (Ogg Opus ou Vorbis attendu)")


def sniff(f, size: int) -> str:
    f.seek(0)
    head = f.read(4096)
    if head[:4] == b"\x1a\x45\xdf\xa3":
        _check_webm(head, size)
        return "audio/webm"
    if head[4:8] == b"ftyp":
        _check_mp4(f, size)
        return "audio/mp4"
    if head[:4] == b"OggS":
        _check_ogg(head, size)
        return "audio/ogg"
    raise VoiceError("Format audio non pris en charge (WebM, MP4/M4A ou Ogg)", 415, "unsupported_type")


# ---------------------------------------------------------------- upload


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
    """Persist one uploaded voice note. ``read(n)`` yields at most ``n`` bytes (empty = connection ended early)."""
    if isinstance(length, bool) or not isinstance(length, int) or length <= 0:
        raise VoiceError("Longueur invalide", 400, "bad_length")
    if length > MAX_FILE_BYTES:
        raise VoiceError(f"Note vocale trop volumineuse (max {MAX_FILE_BYTES // (1024 * 1024)} Mo)", 413, "file_too_large")
    if declared_mime is not None and declared_mime not in MIME_EXT:
        raise VoiceError("Format non pris en charge (WebM, MP4/M4A ou Ogg)", 415, "unsupported_type")
    if not _slots.acquire(blocking=False):
        raise VoiceError("Un autre envoi est en cours — réessaie dans un instant", 429, "busy")
    root = _root()
    tmp: Path | None = None
    tmp_name = ""
    try:
        with voice_lock(root):
            directory = confined_voice_dir(root, create=True)
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
                        raise VoiceError("Envoi interrompu", 400, "interrupted")
                    if len(piece) > length - received:
                        raise VoiceError("Corps plus long que annoncé", 400, "bad_length")
                    out.write(piece)
                    received += len(piece)
                out.flush()
                os.fsync(out.fileno())
            with open(tmp, "rb") as check:
                mime = sniff(check, received)
            if declared_mime is not None and declared_mime != mime:
                raise VoiceError("Type déclaré différent du contenu réel", 415, "mime_mismatch")
            with voice_lock(root):
                directory = confined_voice_dir(root, create=True)
                voice_id = "voice-" + secrets.token_hex(12)
                final = directory / (voice_id + MIME_EXT[mime])
                if os.path.lexists(final):
                    raise VoiceError("Conflit de nom — réessaie", 409, "name_conflict")
                os.replace(tmp, final)
                tmp = None
                _media._fsync_dir(directory)
                if not _media._same(os.path.realpath(final), os.path.join(os.path.realpath(directory), final.name)):
                    _media._remove_quiet(final)
                    raise VoiceError(_ESCAPED, 409, "storage_error")
        finally:
            if tmp is not None:
                _media._remove_quiet(tmp)
            with _reserved_guard:
                _reserved.pop(tmp_name, None)
        return {"ok": True, "voice": {"id": voice_id, "mime": mime, "bytes": received}}
    except OSError as e:
        raise VoiceError("Enregistrement de la note vocale impossible", 503, "storage_error") from e
    finally:
        _slots.release()


# ---------------------------------------------------------------- lookup / serving / references


def _find_file(directory: Path, voice_id: str) -> Path | None:
    if not isinstance(voice_id, str) or not ID_RE.match(voice_id):
        return None
    for ext in MIME_EXT.values():
        candidate = directory / (voice_id + ext)
        if os.path.lexists(candidate):
            return candidate
    return None


def open_voice(voice_id: str, root: Path | str | None = None) -> tuple[Any, str, int]:
    """Open a stored voice note for reading: (binary file, mime, size). 404 for unknown/invalid/redirected."""
    root = _root() if root is None else root
    directory = confined_voice_dir(root)
    candidate = _find_file(directory, voice_id)
    if candidate is None or _media._is_link(candidate):
        raise VoiceError("Note vocale introuvable", 404, "not_found")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(candidate, flags)
    except OSError as e:
        raise VoiceError("Note vocale introuvable", 404, "not_found") from e
    try:
        import stat as _stat

        st = os.fstat(fd)
        if not _stat.S_ISREG(st.st_mode) or st.st_size > MAX_FILE_BYTES:
            raise VoiceError("Note vocale introuvable", 404, "not_found")
        handle = os.fdopen(fd, "rb")
    except Exception:
        os.close(fd)
        raise
    return handle, EXT_MIME[candidate.suffix], st.st_size


def verify_voice(voice: dict) -> None:
    """A referenced voice note must exist and its real container must match the stored MIME."""
    try:
        handle, mime, size = open_voice(voice["id"])
    except VoiceError as e:
        if e.code == "not_found":
            raise VoiceError("Note vocale inconnue du carnet — envoie-la à nouveau", 400, "unknown_voice") from e
        raise
    with handle:
        real = sniff(handle, size)
    if real != voice["mime"] or real != mime:
        raise VoiceError("Métadonnées de note vocale incohérentes avec le fichier", 400, "voice_mismatch")


def voice_exists(voice_id: str) -> bool:
    try:
        handle, _mime, _size = open_voice(voice_id)
    except VoiceError:
        return False
    handle.close()
    return True


def copy_voice(voice_id: str, dest: Path, root: Path | str | None = None) -> int:
    handle, _mime, size = open_voice(voice_id, root)
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
            _media._remove_quiet(dest)
        raise
    return copied


def copy_voices_to(root: Path | str, ids: list[str], dest_dir: Path) -> dict:
    """Backup helper: copy exactly ``ids`` into ``dest_dir`` (created). A missing/unreadable file is counted, never raised."""
    copied = total = missing = 0
    if ids:
        dest_dir.mkdir(parents=True, exist_ok=True)
    for voice_id in sorted(ids):
        with voice_lock(root):
            directory = confined_voice_dir(root)
            found = _find_file(directory, voice_id)
            if found is None:
                missing += 1
                continue
            try:
                total += copy_voice(voice_id, dest_dir / found.name, root)
                copied += 1
            except (VoiceError, OSError):
                missing += 1
    return {"count": copied, "bytes": total, "missing": missing}


# ---------------------------------------------------------------- transcription adapter (optional, never installed here)


def transcribe_configured(command: Any) -> bool:
    return (
        isinstance(command, list)
        and 2 <= len(command) <= 32
        and all(isinstance(x, str) and x and "\x00" not in x and len(x) <= 1024 for x in command)
        and any("{input}" in x for x in command)
        and os.path.isabs(command[0])
        and os.path.isfile(command[0])
    )


def transcribe_status(command: Any) -> dict:
    ok = transcribe_configured(command)
    return {"ok": True, "configured": ok, "max_chars": TRANSCRIPT_CHARS_MAX, "max_wav_bytes": WAV_MAX_BYTES}


def transcribe(voice_id: str, read: Callable[[int], bytes], length: Any, command: Any, timeout: float | None = None) -> dict:
    """Run the configured engine on the browser-provided temporary WAV for the stored voice note ``voice_id``.

    Refusals before any work: unknown voice id, no engine configured, bad/oversized body. The WAV lives in a private temp
    directory and is always removed. The engine output is bounded; a transcript above the limit is REFUSED, never truncated.
    """
    if not isinstance(voice_id, str) or not ID_RE.match(voice_id) or not voice_exists(voice_id):
        raise VoiceError("Note vocale introuvable", 404, "not_found")
    if not transcribe_configured(command):
        raise VoiceError("Transcription non configurée", 501, "transcribe_unconfigured")
    if isinstance(length, bool) or not isinstance(length, int) or length < 44 or length > WAV_MAX_BYTES:
        raise VoiceError("Audio de transcription invalide", 400, "bad_length")
    if not _transcribe_slot.acquire(blocking=False):
        raise VoiceError("Une transcription est déjà en cours — réessaie", 429, "busy")
    try:
        with tempfile.TemporaryDirectory(prefix="hq-transcribe-") as tmp_dir:
            wav = Path(tmp_dir) / "input.wav"
            received = 0
            head = b""
            with open(wav, "xb") as out:
                while received < length:
                    piece = read(min(READ_CHUNK, length - received))
                    if not piece:
                        raise VoiceError("Envoi interrompu", 400, "interrupted")
                    if len(piece) > length - received:
                        raise VoiceError("Corps plus long que annoncé", 400, "bad_length")
                    if not head:
                        head = piece[:12]
                    out.write(piece)
                    received += len(piece)
            if head[:4] != b"RIFF" or head[8:12] != b"WAVE":
                raise VoiceError("Audio de transcription invalide (WAV attendu)", 400, "bad_wav")
            argv = [x.replace("{input}", str(wav)) for x in command]
            try:
                proc = subprocess.run(  # noqa: S603 - fixed argv from the admin's own config, no shell
                    argv,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    timeout=timeout or TRANSCRIBE_TIMEOUT_SECONDS,
                    cwd=tmp_dir,
                    check=False,
                )
            except subprocess.TimeoutExpired as e:
                raise VoiceError("La transcription a pris trop de temps", 504, "transcribe_timeout") from e
            except OSError as e:
                raise VoiceError("Moteur de transcription inaccessible", 503, "transcribe_failed") from e
            if proc.returncode != 0:
                raise VoiceError("La transcription a échoué", 502, "transcribe_failed")
            raw = proc.stdout[:TRANSCRIBE_OUTPUT_MAX + 1]
            if len(raw) > TRANSCRIBE_OUTPUT_MAX:
                raise VoiceError("Transcription trop longue", 413, "transcript_too_long")
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError as e:
                raise VoiceError("Réponse du moteur illisible", 502, "transcribe_failed") from e
            lines = [" ".join(line.split()) for line in text.replace("\r", "\n").split("\n")]
            lines = [line for line in lines if line]
            cleaned = "\n".join(lines)
            if not cleaned:
                raise VoiceError("Aucun texte reconnu", 422, "transcript_empty")
            if len(cleaned) > TRANSCRIPT_CHARS_MAX:
                raise VoiceError(f"Transcription trop longue (max {TRANSCRIPT_CHARS_MAX} caractères)", 413, "transcript_too_long")
            return {"ok": True, "text": cleaned, "chars": len(cleaned)}
    except OSError as e:
        raise VoiceError("Transcription impossible", 503, "transcribe_failed") from e
    finally:
        _transcribe_slot.release()
