"""Shared helpers for ElevenLabs sound-design generation and merge."""
from __future__ import annotations

import array
import hashlib
import json
import math
import subprocess
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BANK = ROOT / "assets/companion/chat/reactions"
PREFIX = "/assets/companion/chat/reactions/"
CATALOG = Path(__file__).with_name("elevenlabs_sound_design_catalog.json")
MASTERING = Path(__file__).with_name("voice_recording_mastering.json")


def load_catalog() -> dict:
    return json.loads(CATALOG.read_text(encoding="utf-8"))


def load_mastering_profile() -> dict:
    return json.loads(MASTERING.read_text(encoding="utf-8"))


def audio_hash(path: Path) -> str:
    data = path.read_bytes()
    if data[:3] == b"ID3":
        size = 0
        for byte in data[6:10]:
            size = (size << 7) | byte
        data = data[10 + size :]
    return hashlib.sha256(data).hexdigest()


def soften_recording(ffmpeg: str, source: Path, dest: Path, base_filters: str, profile: dict, impact: bool) -> dict:
    with tempfile.TemporaryDirectory(prefix="else-audio-") as scratch:
        stage = Path(scratch) / "stage.wav"
        subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-y",
                "-i",
                str(source),
                "-map_metadata",
                "-1",
                "-af",
                base_filters,
                "-c:a",
                "pcm_s16le",
                str(stage),
            ],
            check=True,
        )
        with wave.open(str(stage)) as wav:
            rate, channels, frames = wav.getframerate(), wav.getnchannels(), wav.getnframes()
            samples = array.array("h", wav.readframes(frames))
        duration = frames / rate
        block = max(1, rate // 100) * channels
        active = []
        for offset in range(0, len(samples), block):
            chunk = samples[offset : offset + block]
            power = sum(value * value for value in chunk) / max(1, len(chunk))
            if power > (32768 * 10 ** (-48 / 20)) ** 2:
                active.append((offset, min(offset + block, len(samples))))
        start = active[0][0] / channels / rate if active else 0
        end = active[-1][1] / channels / rate if active else duration
        count = sum(b - a for a, b in active)
        power = sum(sum(value * value for value in samples[a:b]) for a, b in active)
        rms_db = 20 * math.log10(max(math.sqrt(power / max(1, count)) / 32768, 1e-10))
        peak_db = 20 * math.log10(max(max((abs(value) for value in samples), default=0) / 32768, 1e-10))
        kind = "impact" if impact else "voice"
        reduction = max(
            -float(profile["max_level_reduction_db"]),
            min(
                0,
                float(profile[kind + "_target_rms_dbfs"]) - rms_db,
                float(profile["peak_ceiling_dbfs"]) - peak_db,
            ),
        )
        fade_in = min(float(profile[kind + "_fade_in_ms"]) / 1000, (end - start) / 3)
        fade_out = min(float(profile[kind + "_fade_out_ms"]) / 1000, (end - start) / 3)
        filters = (
            f"volume={reduction}dB,afade=t=in:st={start}:d={fade_in},"
            f"afade=t=out:st={max(start + fade_in, end - fade_out)}:d={fade_out}"
        )
        subprocess.run(
            [
                ffmpeg,
                "-v",
                "error",
                "-y",
                "-i",
                str(stage),
                "-map_metadata",
                "-1",
                "-af",
                filters,
                "-c:a",
                "pcm_s16le",
                str(dest),
            ],
            check=True,
        )
        return {
            "level_reduction_db": round(reduction, 3),
            "measured_rms_dbfs": round(rms_db, 3),
            "measured_peak_dbfs": round(peak_db, 3),
            "fade_in_ms": round(fade_in * 1000),
            "fade_out_ms": round(fade_out * 1000),
            "active_start_ms": round(start * 1000),
            "active_end_ms": round(end * 1000),
        }


def as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def sample_key(sample: dict) -> str:
    return str(sample.get("url") or "")


def mastering_filters(profile: dict) -> str:
    gain = float(profile["gain_db"])
    treble = float(profile["treble_gain_db"])
    frequency = float(profile["treble_frequency_hz"])
    return f"treble=g={treble}:f={frequency},volume={gain}dB"


def default_voice_settings(catalog: dict | None = None) -> dict:
    """Eleven v4: lower stability = more expressive delivery; style/speed are not supported."""
    base = {
        "stability": 0,
        "similarity_boost": 1,
        "use_speaker_boost": True,
    }
    if catalog:
        overrides = catalog.get("voice_settings") or {}
        base.update({k: v for k, v in overrides.items() if v is not None})
    return base


def tts_request_body(text: str, model_id: str, catalog: dict | None = None) -> dict:
    body: dict = {
        "text": text,
        "model_id": model_id,
        "voice_settings": default_voice_settings(catalog),
    }
    if catalog:
        clone_strength = catalog.get("clone_strength")
        if clone_strength is not None:
            body["clone_strength"] = clone_strength
    return body


SFX_API = "https://api.elevenlabs.io/v1/sound-generation"
DEFAULT_SFX_MODEL = "eleven_text_to_sound_v3"


def sound_effect_request_body(
    text: str,
    *,
    model_id: str = DEFAULT_SFX_MODEL,
    duration_seconds: float | None = None,
    prompt_influence: float = 0.65,
    loop: bool = False,
) -> dict:
    body: dict = {
        "text": text,
        "model_id": model_id,
        "prompt_influence": max(0.0, min(1.0, float(prompt_influence))),
        "loop": bool(loop),
    }
    if duration_seconds is not None:
        body["duration_seconds"] = max(0.5, min(30.0, float(duration_seconds)))
    return body
