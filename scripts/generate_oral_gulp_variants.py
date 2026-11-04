"""Generate oral gulp previews via ElevenLabs Sound Effects (foley), not voice TTS."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "elevenlabs-expressive-sample-test"
SRC = ROOT / "artifacts" / "elevenlabs-sound-design-src"
BANK = ROOT / "assets/companion/chat/reactions"
RESULTS = OUT / "oral_gulp_variants.json"
SFX_API = "https://api.elevenlabs.io/v1/sound-generation"

# Foley prompts — no [audio tags], no spoken lines (text-to-sound-effects)
GULP_VARIANTS: list[tuple[str, str, float, float]] = [
    # file, prompt, duration_seconds, prompt_influence
    ("oral_gulp_01.mp3", "Single human throat swallow gulp, close microphone foley, wet mouth, no speech", 0.9, 0.72),
    ("oral_gulp_02.mp3", "Two quick consecutive swallow gulps, throat and mouth foley, no voice", 1.1, 0.7),
    ("oral_gulp_03.mp3", "Tiny quick swallow gulp after suction, subtle wet mouth, ASMR foley", 0.65, 0.68),
    ("oral_gulp_04.mp3", "Slow audible single swallow with saliva, adam's apple click, no talking", 1.4, 0.74),
    ("oral_gulp_05.mp3", "Deep long swallow gulp taking liquid, throat glug, mouth foley only", 1.6, 0.72),
    ("oral_gulp_06.mp3", "Nervous single swallow gulp, dry then wet throat, foley no speech", 0.85, 0.7),
    ("oral_gulp_07.mp3", "Heavy loud swallow gulp with wet lip smack after, close mic", 1.0, 0.73),
    ("oral_gulp_08.mp3", "Throat clear followed by one swallow gulp, human mouth foley", 1.2, 0.68),
    ("oral_gulp_09.mp3", "Rhythmic double swallow gulp gulp, wet intake, no vocals", 1.0, 0.71),
    ("oral_gulp_10.mp3", "Sticky thick swallow after oral wetness, single gulp foley", 1.1, 0.72),
    ("oral_gulp_11.mp3", "Muffled swallow gulp with lips mostly closed, internal mouth sound", 0.9, 0.69),
    ("oral_gulp_12.mp3", "Fast desperate triple swallow gulps in a row, throat foley", 1.3, 0.75),
    ("oral_gulp_13.mp3", "Satisfied slow swallow exhale, one big gulp, relaxed foley", 1.5, 0.7),
    ("oral_gulp_14.mp3", "Three rapid tiny swallow gulps, close throat clicks", 1.0, 0.74),
    ("oral_gulp_15.mp3", "Big swallow with hollow cheek suction then gulp, wet foley", 1.2, 0.72),
    ("oral_gulp_16.mp3", "Swallow gulp immediately followed by wet saliva lip smack, no speech", 1.0, 0.71),
    ("oral_gulp_17.mp3", "Shallow small swallow at front of mouth, gentle gulp foley", 0.7, 0.67),
    ("oral_gulp_18.mp3", "Full depth throat swallow gulp, long glottal wave, close mic", 1.7, 0.76),
    ("oral_gulp_19.mp3", "Breath inhale then single swallow gulp, natural throat foley", 1.3, 0.7),
    ("oral_gulp_20.mp3", "Close mic adam's apple bob single swallow gulp, wet", 0.95, 0.73),
    ("oral_gulp_21.mp3", "Soft subtle swallow gulp, quiet ASMR throat, no moaning", 0.8, 0.66),
    ("oral_gulp_22.mp3", "Urgent repeated swallow gulps four times, panicked throat foley", 1.6, 0.75),
    ("oral_gulp_23.mp3", "Lazy slow swallow with tongue wetness then gulp, mouth foley", 1.4, 0.69),
    ("oral_gulp_24.mp3", "Final big relieving swallow gulp after long hold, throat release", 1.5, 0.72),
    ("oral_gulp_25.mp3", "Tiny sip-swallow gulp, delicate wet lips, minimal", 0.6, 0.65),
    ("oral_gulp_26.mp3", "Hollow mouth cavity echo then single swallow gulp foley", 1.1, 0.7),
    ("oral_gulp_27.mp3", "Choke-back half swallow then full gulp, throat struggle foley no voice", 1.2, 0.74),
    ("oral_gulp_28.mp3", "Syncopated swallow gulp with wet smack accent, percussive throat", 0.95, 0.71),
]


def catalog_name(preview_name: str) -> str:
    stem = Path(preview_name).stem
    num = stem.split("_")[-1]
    return f"Else_oral_gulp_{num}.mp3"


def synthesize_sfx(
    api_key: str,
    text: str,
    duration_seconds: float,
    prompt_influence: float,
) -> bytes:
    from elevenlabs_sound_design_common import DEFAULT_SFX_MODEL, sound_effect_request_body

    url = f"{SFX_API}?output_format=mp3_44100_128"
    body = json.dumps(
        sound_effect_request_body(
            text,
            duration_seconds=duration_seconds,
            prompt_influence=prompt_influence,
            model_id=DEFAULT_SFX_MODEL,
        )
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "xi-api-key": api_key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def reencode_gulp_oggs() -> None:
    import re

    from fingerprint_reaction_oggs import apply_fingerprints
    from reaction_ogg_preset import collect_manifest_urls, encode_reaction_ogg
    from slim_reaction_manifest import write_runtime_manifest
    from transcode_reaction_bank_to_ogg import patch_sample_meta, source_for_url

    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if not ffmpeg or not ffprobe:
        print("ffmpeg missing — skip OGG reencode", file=sys.stderr)
        return

    manifest_path = BANK / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    urls = sorted(
        u
        for u in collect_manifest_urls(manifest)
        if u.endswith(".ogg") and "else_oral_gulp_" in u.lower()
    )
    if not urls:
        print("no gulp OGG urls in manifest")
        return

    encoded = 0
    for url in urls:
        ogg_path = ROOT / url.lstrip("/")
        source = source_for_url(url, manifest, ogg_path)
        if source is None or not source.is_file():
            print(f"skip reencode (no source): {url}")
            continue
        temp = ogg_path.with_suffix(".reencode.tmp.ogg")
        try:
            result = encode_reaction_ogg(ffmpeg, source, temp, ffprobe=ffprobe)
            temp.replace(ogg_path)
            patch_sample_meta(manifest, url, result["duration_ms"])
            encoded += 1
            print(f"reencoded: {ogg_path.name}")
        except (OSError, subprocess.CalledProcessError) as exc:
            print(f"FAIL reencode {ogg_path.name}: {exc}", file=sys.stderr)
        finally:
            if temp.exists():
                temp.unlink(missing_ok=True)

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_runtime_manifest()
    apply_fingerprints("2026-11-04-expressive")
    reaction_js = ROOT / "assets/hq-companion-reaction-audio.js"
    text = reaction_js.read_text(encoding="utf-8")
    text = re.sub(
        r"const MANIFEST_REVISION='[^']*';",
        "const MANIFEST_REVISION='2026-11-04-expressive';",
        text,
        count=1,
    )
    reaction_js.write_text(text, encoding="utf-8")
    print(f"gulp_oggs_reencoded={encoded}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--no-src-copy", action="store_true")
    parser.add_argument("--no-reencode", action="store_true", help="Skip OGG refresh after MP3 replace")
    args = parser.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key.startswith("sk_"):
        print("Set ELEVENLABS_API_KEY (sk_...)", file=sys.stderr)
        return 2

    OUT.mkdir(parents=True, exist_ok=True)
    if not args.no_src_copy:
        SRC.mkdir(parents=True, exist_ok=True)

    results: list[dict] = []
    for dest_name, text, dur, influence in GULP_VARIANTS:
        dest = OUT / dest_name
        entry = {
            "engine": "eleven_text_to_sound_v3",
            "file": dest_name,
            "catalog_file": catalog_name(dest_name),
            "prompt_in": text,
            "duration_seconds": dur,
            "prompt_influence": influence,
            "path": str(dest),
        }
        if args.skip_existing and dest.is_file() and dest.stat().st_size > 0:
            entry["ok"] = True
            entry["skipped"] = True
            entry["bytes"] = dest.stat().st_size
            if not args.no_src_copy:
                shutil.copy2(dest, SRC / entry["catalog_file"])
            results.append(entry)
            print(f"skip: {dest_name}")
            continue
        try:
            data = synthesize_sfx(api_key, text, dur, influence)
            dest.write_bytes(data)
            entry["ok"] = True
            entry["bytes"] = len(data)
            if not args.no_src_copy:
                shutil.copy2(dest, SRC / entry["catalog_file"])
            print(f"ok: {dest_name} ({len(data)} bytes)")
        except urllib.error.HTTPError as exc:
            entry["ok"] = False
            entry["error"] = exc.read().decode("utf-8", errors="replace")
            print(f"FAIL: {dest_name}: {entry['error'][:200]}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            entry["ok"] = False
            entry["error"] = str(exc)
            print(f"FAIL: {dest_name}: {exc}", file=sys.stderr)
        results.append(entry)

    RESULTS.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    ok = sum(1 for r in results if r.get("ok"))
    print(f"{ok}/{len(results)} SFX previews -> {OUT}")

    if ok and not args.no_reencode and not args.no_src_copy:
        reencode_gulp_oggs()

    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
