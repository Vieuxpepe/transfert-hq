"""Bounded local delivery shaping. No cloud calls or transcript changes."""
import math
import os
import struct
import uuid
import wave

PROFILES = {
    "expressive": (.84, .90, 1.0, 0),  # legacy sound-bank/cache behavior
    "neutral": (.76, .85, 1.0, 160),
    "thoughtful": (.72, .85, .96, 360),
    "deadpan": (.65, .82, 1.0, 280),
    "warm": (.76, .87, .98, 240),
    "playful": (.80, .90, 1.025, 180),
}


def normalize_style(style):
    return style if isinstance(style, str) and style in PROFILES else "neutral"


def shape_pauses(path, style):
    """Lengthen only existing internal silence; never cut speech or add fake sounds."""
    target_ms = PROFILES[normalize_style(style)][3]
    if not target_ms:
        return 0
    try:
        with wave.open(str(path), "rb") as audio:
            params = audio.getparams()
            if params.sampwidth != 2 or params.comptype != "NONE" or params.nchannels not in (1, 2) or params.nframes > params.framerate * 120:
                return 0
            raw = audio.readframes(params.nframes)
        frame_bytes = params.nchannels * 2
        block_frames = max(1, params.framerate // 50)  # 20 ms
        block_bytes = block_frames * frame_bytes
        blocks = [raw[i:i + block_bytes] for i in range(0, len(raw), block_bytes)]
        quiet = []
        for block in blocks:
            values = [s[0] for s in struct.iter_unpack("<h", block)]
            quiet.append(bool(values) and math.sqrt(sum(v * v for v in values) / len(values)) < 60)
        insertions = {}
        start = None
        for i, silent in enumerate(quiet + [False]):
            if silent and start is None:
                start = i
            elif not silent and start is not None:
                length_ms = (i - start) * 20
                if start > 0 and i < len(quiet) and 120 <= length_ms < target_ms and len(insertions) < 6:
                    extra_ms = min(150, target_ms - length_ms)
                    insertions[i] = b"\0" * (round(params.framerate * extra_ms / 1000) * frame_bytes)
                start = None
        if not insertions:
            return 0
        tmp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with wave.open(str(tmp), "wb") as audio:
                audio.setparams(params)
                audio.writeframes(b"".join(insertions.get(i, b"") + block for i, block in enumerate(blocks)))
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
        return len(insertions)
    except (OSError, ValueError, EOFError, wave.Error):
        return 0
