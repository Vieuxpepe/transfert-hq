"""Godot v24 arcade soft-30 stereo OGG preset (matches Desktop compressor GUI).

Canonical filter chain is pinned to the GUI log from
``audio_compressor_godot_v24_quality_presets_keep_stereo.py`` (best arcade preset:
Arcade clean, keep stereo, soft 30 kbps, Light warmth + clarity). When you change
that script, update the constants here and ``REFERENCE_AUDIO_FILTER_SHA256``; run
``python -m unittest tests.test_reaction_ogg_preset``.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

PRESET_ID = "arcade_soft30"
BITRATE_KBPS = 30
SAMPLE_RATE_HZ = 22050

DESKTOP_COMPRESSOR_DEFAULT = Path(
    os.environ.get(
        "GODOT_AUDIO_COMPRESSOR_PRESET",
        r"C:\Users\autm_\Desktop\audio_compressor_godot_v24_quality_presets_keep_stereo.py",
    )
)

# Logged FFmpeg -af for best arcade / soft 30 / keep stereo (2026-11-04).
REFERENCE_AUDIO_FILTER = (
    "lowpass=f=9500,"
    "lowpass=f=8200,equalizer=f=1800:width_type=q:width=1.0:g=-0.8,"
    "equalizer=f=4200:width_type=q:width=1.2:g=-1.1,"
    "acompressor=threshold=0.31:ratio=1.45:attack=24:release=190:makeup=1.04,volume=0.98,"
    "highpass=f=45,equalizer=f=115:width_type=q:width=0.9:g=1.0,"
    "equalizer=f=300:width_type=q:width=1.1:g=-1.2,equalizer=f=2300:width_type=q:width=1.0:g=1.0,"
    "acompressor=threshold=0.30:ratio=1.55:attack=18:release=170:makeup=1.08,volume=0.97"
)
REFERENCE_AUDIO_FILTER_SHA256 = "80a4bb7077dd3ebb58997f73c0ab5dedf74a1347b9ca48b1de6305b5cc67162f"

RETRO_LOWPASS = "lowpass=f=9500"
SOFT_DETAIL_FILTER = (
    "lowpass=f=8200,"
    "equalizer=f=1800:width_type=q:width=1.0:g=-0.8,"
    "equalizer=f=4200:width_type=q:width=1.2:g=-1.1,"
    "acompressor=threshold=0.31:ratio=1.45:attack=24:release=190:makeup=1.04,"
    "volume=0.98"
)
ENHANCEMENT_FILTER = (
    "highpass=f=45,"
    "equalizer=f=115:width_type=q:width=0.9:g=1.0,"
    "equalizer=f=300:width_type=q:width=1.1:g=-1.2,"
    "equalizer=f=2300:width_type=q:width=1.0:g=1.0,"
    "acompressor=threshold=0.30:ratio=1.55:attack=18:release=170:makeup=1.08,"
    "volume=0.97"
)


def build_audio_filter_chain(*, prefix: str | None = None) -> str:
    parts: list[str] = []
    if prefix:
        parts.append(prefix.strip().rstrip(","))
    parts.extend([RETRO_LOWPASS, SOFT_DETAIL_FILTER, ENHANCEMENT_FILTER])
    return ",".join(parts)


def reference_audio_filter_digest() -> str:
    return hashlib.sha256(build_audio_filter_chain().encode("utf-8")).hexdigest()


def _join_quoted_chunks(block: str) -> str:
    return "".join(re.findall(r'"([^"]*)"', block, flags=re.DOTALL))


def audio_filter_from_desktop_compressor(path: Path | None = None) -> str | None:
    """Rebuild best-arcade -af from the Desktop GUI source (regex; no tkinter import)."""
    desktop = path or DESKTOP_COMPRESSOR_DEFAULT
    if not desktop.is_file():
        return None
    text = desktop.read_text(encoding="utf-8")
    retro = re.search(
        r'"Arcade clean - 22\.05 kHz mono":\s*\{[^}]*"filter":\s*"([^"]+)"',
        text,
    )
    soft = re.search(
        r"def get_soft_detail_filter\(self\):.*?return \(\s*(.*?)\n\s*\)",
        text,
        flags=re.DOTALL,
    )
    enh = re.search(
        r'"Light warmth \+ clarity - perfect preset":\s*\{\s*"filter":\s*\(\s*(.*?)\n\s*\),',
        text,
        flags=re.DOTALL,
    )
    if not (retro and soft and enh):
        return None
    return ",".join(
        [
            retro.group(1),
            _join_quoted_chunks(soft.group(1)),
            _join_quoted_chunks(enh.group(1)),
        ]
    )


def build_encode_argv(ffmpeg: str, input_path: Path | str, output_path: Path | str) -> list[str]:
    """FFmpeg argv for arcade_soft30 (matches GUI build_ffmpeg_command for this preset)."""
    return [
        ffmpeg,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(input_path),
        "-vn",
        "-ar",
        str(SAMPLE_RATE_HZ),
        "-af",
        build_audio_filter_chain(),
        "-c:a",
        "libvorbis",
        "-b:a",
        f"{BITRATE_KBPS}k",
        str(output_path),
    ]


def mastering_metadata() -> dict:
    return {
        "encode": PRESET_ID,
        "format": "ogg",
        "bitrate_kbps": BITRATE_KBPS,
        "sample_rate_hz": SAMPLE_RATE_HZ,
        "spatial": "keep_stereo",
        "retro_mode": "Arcade clean - 22.05 kHz mono",
        "enhancement": "Light warmth + clarity - perfect preset",
        "audio_filter": build_audio_filter_chain(),
    }


def probe_duration_ms(probe_bin: str, path: Path) -> int:
    out = subprocess.check_output(
        [
            probe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        text=True,
    ).strip()
    return max(1, round(float(out) * 1000))


def encode_reaction_ogg(
    ffmpeg: str,
    source: Path,
    dest: Path,
    *,
    ffprobe: str | None = None,
    extra_af: str | None = None,
    loudness_class: str = "voice",
) -> dict:
    dest.parent.mkdir(parents=True, exist_ok=True)
    prefix_parts: list[str] = []
    if loudness_class == "impact":
        prefix_parts.append("volume=3.5dB")
    elif loudness_class == "phase":
        prefix_parts.append("volume=-1.5dB")
    if extra_af:
        prefix_parts.insert(0, extra_af.strip().rstrip(","))
    prefix = ",".join(prefix_parts) if prefix_parts else None
    cmd = build_encode_argv(ffmpeg, source, dest)
    if prefix:
        af_index = cmd.index("-af") + 1
        cmd[af_index] = build_audio_filter_chain(prefix=prefix)
    subprocess.run(cmd, check=True)
    probe = ffprobe or shutil.which("ffprobe") or ffmpeg.replace("ffmpeg", "ffprobe")
    duration_ms = probe_duration_ms(probe, dest)
    meta = mastering_metadata()
    meta["duration_ms"] = duration_ms
    meta["source"] = str(source.name)
    return meta


def wav_url_to_ogg(url: str) -> str:
    if url.endswith(".wav"):
        return url[:-4] + ".ogg"
    return url


def rewrite_manifest_urls(obj, url_map: dict[str, str]) -> None:
    if isinstance(obj, dict):
        if "url" in obj and obj["url"] in url_map:
            obj["url"] = url_map[obj["url"]]
        for value in obj.values():
            rewrite_manifest_urls(value, url_map)
    elif isinstance(obj, list):
        for item in obj:
            rewrite_manifest_urls(item, url_map)


def collect_manifest_urls(manifest: dict) -> set[str]:
    urls: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            url = node.get("url")
            if isinstance(url, str) and "/assets/companion/chat/reactions/" in url:
                urls.add(url)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(manifest)
    return urls
