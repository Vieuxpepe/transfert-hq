"""Tile or seam-bake tit_pull_02.mp3 for pull loop (no ElevenLabs)."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
PREVIEW = ROOT / "artifacts" / "elevenlabs-expressive-sample-test" / "tit_pull_02.mp3"
SRC = ROOT / "artifacts" / "elevenlabs-sound-design-src" / "Else_tit_pull_02.mp3"
BANK = ROOT / "assets/companion/chat/reactions"
REPEATS = 1
CROSSFADE_S = 0.022
SEAMLESS_FADE_MS = 58
JOIN_CROSSFADE_S = 0.24
GRAIN_BED_S = 5.0
GRAIN_LEN_S = 0.13
GRAIN_HOP_S = 0.034
LOAD_RATE = 44100


def tit_pull_02_manifest_url(man: dict) -> str | None:
    runtime_path = BANK / "manifest.runtime.json"
    if runtime_path.is_file():
        runtime = json.loads(runtime_path.read_text(encoding="utf-8"))
        for item in runtime.get("impacts", {}).get("tit_pull") or []:
            url = item.get("url") or ""
            if re.search(r"else_tit_pull_02\.", url, re.I):
                return url
    for item in man.get("impacts", {}).get("tit_pull") or []:
        url = item.get("url") or ""
        if re.search(r"else_tit_pull_02\.", url, re.I):
            return url
    for item in man.get("samples", {}).get("impacts", {}).get("tit_pull") or []:
        url = item.get("url") or ""
        if re.search(r"else_tit_pull_02\.", url, re.I):
            return url
    return None


def load_mono_f32(ffmpeg: str, inp: Path, rate: int = LOAD_RATE) -> tuple[np.ndarray, int]:
    cmd = [
        ffmpeg,
        "-v",
        "error",
        "-i",
        str(inp.resolve()),
        "-ac",
        "1",
        "-ar",
        str(rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    raw = subprocess.check_output(cmd)
    return np.frombuffer(raw, dtype=np.float32).copy(), rate


def write_mono_mp3(ffmpeg: str, samples: np.ndarray, rate: int, out: Path) -> None:
    cmd = [
        ffmpeg,
        "-y",
        "-v",
        "error",
        "-f",
        "f32le",
        "-ar",
        str(rate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(out.resolve()),
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    assert proc.stdin is not None
    proc.stdin.write(samples.astype(np.float32).tobytes())
    proc.stdin.close()
    err = proc.stderr.read().decode("utf-8", errors="replace") if proc.stderr else ""
    code = proc.wait()
    if code != 0:
        raise subprocess.CalledProcessError(code, cmd, output=err)


def _leading_trim_idx(ch: np.ndarray, rate: int) -> int:
    max_scan = min(len(ch), int(rate * 0.04))
    thresh = 0.007
    for i in range(max_scan):
        if abs(float(ch[i])) > thresh:
            return max(0, i - int(rate * 0.0015))
    return 0


def _best_loop_end_idx(ch: np.ndarray, rate: int, start_i: int) -> int:
    dur = len(ch) / rate
    tail_pad = min(int(rate * 0.012), int(len(ch) * 0.015))
    end_default = len(ch) - max(int(rate * 0.006), tail_pad)
    min_period = int(min(len(ch) - tail_pad, start_i + max(rate * 0.58, len(ch) * 0.78)))
    step = max(1, int(rate * 0.0025))
    win = max(8, int(rate * 0.014))
    best_score = float("inf")
    best_end = end_default
    search_hi = end_default
    search_lo = max(start_i + int(rate * 0.35), min_period)
    for e in range(search_hi, search_lo, -step):
        diff = 0.0
        n = 0
        for k in range(0, win, max(1, win // 14)):
            i = start_i + k
            j = e - win + k
            if j < start_i or i >= len(ch) or j >= len(ch):
                continue
            diff += abs(float(ch[i]) - float(ch[j]))
            n += 1
        if not n:
            continue
        diff /= n
        if diff < best_score:
            best_score = diff
            best_end = e
    return max(start_i + int(rate * 0.38), min(best_end, len(ch) - 3))


def bake_seamless_loop(samples: np.ndarray, rate: int, fade_ms: int = SEAMLESS_FADE_MS) -> tuple[np.ndarray, int]:
    ch = samples
    start_i = _leading_trim_idx(ch, rate)
    loop_end_i = _best_loop_end_idx(ch, rate, start_i)
    segment = ch[start_i:loop_end_i].astype(np.float64, copy=True)
    fade = max(8, int(rate * fade_ms / 1000))
    fade = min(fade, max(8, len(segment) // 5))
    if fade >= len(segment):
        return segment.astype(np.float32), rate
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float64)
    tail = segment[-fade:]
    head = segment[:fade]
    segment[-fade:] = tail * (1.0 - ramp) + head * ramp
    # Pull end toward start so the wrap is sample-continuous after crossfade.
    segment[-1] = segment[0]
    peak = float(np.max(np.abs(segment))) or 1.0
    if peak > 0.98:
        segment *= 0.98 / peak
    return segment.astype(np.float32), rate


SEAMLESS_FADE_MS = 58
JOIN_CROSSFADE_S = 0.24


def build_grain_loop_bed(mono: np.ndarray, rate: int, target_s: float = GRAIN_BED_S) -> np.ndarray:
    """Smear elastic body into a long bed so runtime loop period is not ~1s squeak."""
    start_i = _leading_trim_idx(mono, rate)
    end_i = _best_loop_end_idx(mono, rate, start_i)
    body = mono[start_i:end_i].astype(np.float64, copy=True)
    if len(body) < int(rate * 0.2):
        body = mono.astype(np.float64, copy=True)
    out_n = int(rate * target_s)
    out = np.zeros(out_n, dtype=np.float64)
    grain_n = max(32, int(rate * GRAIN_LEN_S))
    hop_n = max(1, int(rate * GRAIN_HOP_S))
    hann = np.hanning(grain_n)
    rng = np.random.default_rng(20261104)
    pos = 0
    while pos + grain_n <= out_n:
        if len(body) <= grain_n:
            g = np.interp(
                np.linspace(0, max(1, len(body) - 1), grain_n),
                np.arange(len(body)),
                body,
            )
        else:
            off = int(rng.integers(0, len(body) - grain_n))
            g = body[off : off + grain_n]
        out[pos : pos + grain_n] += g * hann * 0.38
        pos += hop_n
    peak = float(np.max(np.abs(out))) or 1.0
    out *= 0.9 / peak
    baked, _ = bake_seamless_loop(out.astype(np.float32), rate, fade_ms=54)
    return baked


def seamless_from_single(ffmpeg: str, inp: Path, out: Path) -> None:
    mono, rate = load_mono_f32(ffmpeg, inp)
    baked = build_grain_loop_bed(mono, rate)
    write_mono_mp3(ffmpeg, baked, rate, out)


def extend_with_ffmpeg(ffmpeg: str, inp: Path, out: Path) -> None:
    if REPEATS <= 1:
        shutil.copy2(inp, out)
        return
    cmd = [ffmpeg, "-y"]
    for _ in range(REPEATS):
        cmd.extend(["-i", str(inp.resolve())])
    if REPEATS == 2:
        fc = f"[0][1]acrossfade=d={CROSSFADE_S}:c1=tri:c2=tri[out]"
    elif REPEATS == 3:
        fc = (
            f"[0][1]acrossfade=d={CROSSFADE_S}:c1=tri:c2=tri[a01];"
            f"[a01][2]acrossfade=d={CROSSFADE_S}:c1=tri:c2=tri[out]"
        )
    else:
        raise ValueError(f"unsupported REPEATS={REPEATS}")
    cmd.extend(["-filter_complex", fc, "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", str(out.resolve())])
    subprocess.check_call(cmd)


def reencode_02_ogg() -> None:
    sys.path.insert(0, str(ROOT / "scripts"))
    from fingerprint_reaction_oggs import apply_fingerprints
    from reaction_ogg_preset import encode_reaction_ogg
    from slim_reaction_manifest import write_runtime_manifest
    from transcode_reaction_bank_to_ogg import patch_sample_meta

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print("ffmpeg missing", file=sys.stderr)
        return

    man_path = BANK / "manifest.json"
    man = json.loads(man_path.read_text(encoding="utf-8"))
    url = tit_pull_02_manifest_url(man)
    if not url:
        print("no else_tit_pull_02 in manifest", file=sys.stderr)
        return

    ogg_path = ROOT / url.lstrip("/")
    temp = ogg_path.with_suffix(".extend.tmp.ogg")
    result = encode_reaction_ogg(ffmpeg, SRC, temp, ffprobe=ffprobe, loudness_class="impact")
    temp.replace(ogg_path)
    patch_sample_meta(man, url, result["duration_ms"])
    man_path.write_text(json.dumps(man, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_runtime_manifest()
    apply_fingerprints("2026-11-04-expressive")
    print(f"reencoded {ogg_path.name} duration_ms={result['duration_ms']}")


def restore_single() -> None:
    backup = PREVIEW.with_suffix(".mp3.single")
    if not backup.is_file():
        raise SystemExit(f"missing {backup}")
    shutil.copy2(backup, PREVIEW)
    shutil.copy2(backup, SRC)
    reencode_02_ogg()


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--restore", action="store_true", help="Restore one-shot mp3 from .mp3.single and reencode OGG")
    parser.add_argument(
        "--seamless",
        action="store_true",
        help="Bake tail→head crossfade loop from .mp3.single (keeps backup) and reencode OGG",
    )
    parser.add_argument("--tile", type=int, default=0, help="Tile N times (usually 0/1; avoid obvious triple repeat)")
    args = parser.parse_args()

    if args.seamless:
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            print("ffmpeg missing", file=sys.stderr)
            return 2
        backup = PREVIEW.with_suffix(".mp3.single")
        if not backup.is_file():
            raise SystemExit(f"missing {backup}")
        seamless_from_single(ffmpeg, backup, PREVIEW)
        shutil.copy2(PREVIEW, SRC)
        reencode_02_ogg()
        dur = subprocess.check_output(
            [
                shutil.which("ffprobe") or "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(PREVIEW),
            ],
            text=True,
        ).strip()
        print(f"grain loop bed ~{GRAIN_BED_S}s -> {PREVIEW} (~{dur}s)")
        return 0

    if args.restore or args.tile == 1:
        if args.restore:
            restore_single()
            dur = subprocess.check_output(
                [shutil.which("ffprobe") or "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(PREVIEW)],
                text=True,
            ).strip()
            print(f"restored single -> {PREVIEW} (~{dur}s)")
            return 0

    global REPEATS
    if args.tile and args.tile > 1:
        REPEATS = args.tile

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or not PREVIEW.is_file():
        print("need ffmpeg and tit_pull_02.mp3 preview", file=sys.stderr)
        return 2

    backup = PREVIEW.with_suffix(".mp3.single")
    if not backup.is_file():
        shutil.copy2(PREVIEW, backup)

    tmp = PREVIEW.with_name("tit_pull_02_tiled.mp3")
    extend_with_ffmpeg(ffmpeg, backup, tmp)
    tmp.replace(PREVIEW)
    shutil.copy2(PREVIEW, SRC)
    reencode_02_ogg()
    dur = subprocess.check_output(
        [shutil.which("ffprobe") or "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(PREVIEW)],
        text=True,
    ).strip()
    print(f"tiled x{REPEATS} crossfade={CROSSFADE_S}s -> {PREVIEW} (~{dur}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
