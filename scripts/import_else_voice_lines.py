"""Import and master ElevenLabs downloads from original MP3s; route existing events."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import wave
import array
import math
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BANK = ROOT / "assets/companion/chat/reactions"
PREFIX = "/assets/companion/chat/reactions/"
ROUTES = {
    "big_yawn": ("samples", "yawn"),
    "cute_jiggling": ("samples", "giggle"),
    "enthusiastic_kiss": ("samples", "kiss"),
    "loud_kiss": ("samples", "kiss"),
    "smacking_lips": ("samples", "lipsmack"),
    "enthusiastic_slap_on_tits": ("impacts", "slap"),
    "gasp_of_shock": ("samples", "surprised"),
    "humming_a_song": ("samples", "humming"),
    "loud_moaning_yip": ("samples", "moan"),
    "seductive_moan": ("samples", "moan"),
    "sigh_of_satisfaction": ("samples", "contented"),
    "whimpering_-_aaaa": ("samples", "whimper"),
    "yap_of_pleasure": ("samples", "pleasure"),
    "moaning_loudly_-_cum_all_over_me": ("phases", "cum_begging"),
    "moaning_loudly_-_let_me_drain_those_massive_balls_with_my_tight_throat": ("phases", "deepthroat"),
    "moaning_of_pleasure_-_allez_frappe_mes_seins_plus_fort": ("phases", "phase9_breast_vivid"),
    "orgasm_-_oui_oui_encore_plus": ("phases", "climax_fever"),
    "orgasm_loudly": ("phases", "climax_fever"),
    "whimpering_-_oh_my_fucking_god": ("phases", "pull_surrender"),
    "whimpering_-_such_a_fat_cock": ("phases", "phase7_size_worship"),
}
CONTEXTS = {
    "samples.yawn": "Morning stretch and quiet-session stretch",
    "samples.giggle": "Cursor tickling and playful conversation laughter",
    "samples.kiss": "Lip kiss gesture, requested kiss and kiss treat",
    "samples.lipsmack": "Lip-bite gesture and existing close whisper gesture",
    "impacts.slap": "Rotating physical impact sounds for existing slap events",
    "samples.surprised": "Existing surprise and gasp reactions",
    "samples.humming": "Occasional quiet idle humming, actual media playback starts and music nods",
    "samples.moan": "Existing heightened contact reaction tiers",
    "samples.contented": "Gentle petting, contentment and release sighs",
    "samples.whimper": "Existing held pull gesture, one recording per gesture",
    "samples.pleasure": "Existing sustained contact and release response",
    "phases.cum_begging": "Existing matching spoken phase",
    "phases.deepthroat": "Existing matching spoken phase",
    "phases.phase9_breast_vivid": "Existing strong slap payoff",
    "phases.climax_fever": "Existing climax event and maximum warmth event",
    "phases.pull_surrender": "Existing pull surrender and pull release",
    "phases.phase7_size_worship": "Existing matching size-reaction phase",
}


def audio_hash(path):
    data = path.read_bytes()
    if data[:3] == b"ID3":
        size = 0
        for byte in data[6:10]:
            size = (size << 7) | byte
        data = data[10 + size:]
    return hashlib.sha256(data).hexdigest()


def soften_recording(ffmpeg, source, dest, base_filters, profile, impact):
    # Measure after EQ/base gain; always start from the original MP3, never an earlier master.
    with tempfile.TemporaryDirectory(prefix="else-audio-") as scratch:
        stage = Path(scratch) / "stage.wav"
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(source), "-map_metadata", "-1",
                        "-af", base_filters, "-c:a", "pcm_s16le", str(stage)], check=True)
        with wave.open(str(stage)) as wav:
            rate, channels, frames = wav.getframerate(), wav.getnchannels(), wav.getnframes()
            samples = array.array("h", wav.readframes(frames))
        duration = frames / rate
        block = max(1, rate // 100) * channels
        active = []
        for offset in range(0, len(samples), block):
            chunk = samples[offset:offset + block]
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
        reduction = max(-float(profile["max_level_reduction_db"]), min(0,
            float(profile[kind + "_target_rms_dbfs"]) - rms_db,
            float(profile["peak_ceiling_dbfs"]) - peak_db))
        fade_in = min(float(profile[kind + "_fade_in_ms"]) / 1000, (end - start) / 3)
        fade_out = min(float(profile[kind + "_fade_out_ms"]) / 1000, (end - start) / 3)
        filters = (f"volume={reduction}dB,afade=t=in:st={start}:d={fade_in},"
                   f"afade=t=out:st={max(start + fade_in, end - fade_out)}:d={fade_out}")
        subprocess.run([ffmpeg, "-v", "error", "-y", "-i", str(stage), "-map_metadata", "-1",
                        "-af", filters, "-c:a", "pcm_s16le", str(dest)], check=True)
        return {"level_reduction_db": round(reduction, 3), "measured_rms_dbfs": round(rms_db, 3),
                "measured_peak_dbfs": round(peak_db, 3), "fade_in_ms": round(fade_in * 1000),
                "fade_out_ms": round(fade_out * 1000), "active_start_ms": round(start * 1000),
                "active_end_ms": round(end * 1000)}


def main(source):
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise SystemExit("ffmpeg is required to decode the existing MP3s")
    profile = json.loads((Path(__file__).with_name("voice_recording_mastering.json")).read_text(encoding="utf-8"))
    gain = float(profile["gain_db"])
    treble = float(profile["treble_gain_db"])
    frequency = float(profile["treble_frequency_hz"])
    if not (-24 <= gain <= 0 and -12 <= treble <= 0 and 1000 <= frequency <= 10000):
        raise ValueError("Mastering settings are outside supported attenuation ranges")
    filters = f"treble=g={treble}:f={frequency},volume={gain}dB"
    with (source / "rename_log.csv").open(encoding="utf-8-sig", newline="") as handle:
        provenance = {row["new_name"]: row for row in csv.DictReader(handle)}
    manifest = json.loads((BANK / "manifest.json").read_text(encoding="utf-8"))
    pools = {"samples": {}, "phases": {}, "impacts": {}}
    imported, seen = [], {}
    folder = BANK / "elevenlabs_20261103"
    folder.mkdir(parents=True, exist_ok=True)
    for path in sorted(source.glob("Else_*.mp3")):
        key = path.stem.removeprefix("Else_").rsplit("_", 1)[0]
        section, event = ROUTES[key]
        context = section + "." + event
        if context not in CONTEXTS:
            raise ValueError(f"No natural context assigned for {path.name}")
        digest = audio_hash(path)
        if digest not in seen:
            name = path.stem.lower().replace("_-_", "_") + ".wav"
            dest = folder / name
            mastering = soften_recording(ffmpeg, path, dest, filters, profile, section == "impacts")
            with wave.open(str(dest)) as wav:
                duration = round(1000 * wav.getnframes() / wav.getframerate())
            sample = {"url": PREFIX + folder.name + "/" + name,
                      "duration_ms": duration, "natural": True, "model": "eleven_v4", "mastering": mastering}
            seen[digest] = sample
        sample = seen[digest]
        pool = pools[section].setdefault(event, [])
        if sample not in pool:
            pool.append(sample)
        imported.append({"source": path.name, "source_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                         "audio_sha256": digest, "section": section, "event": event,
                         "url": sample["url"], "context": context,
                         "match_method": provenance[path.name]["match_method"]})
    pools["samples"]["laugh"] = pools["samples"]["giggle"]
    pools["samples"]["exhale"] = pools["samples"]["contented"]
    manifest["samples"].update(pools["samples"])
    for key in list(manifest["samples"]):
        if key.startswith("pleasure_grunt") or key == "slap":
            del manifest["samples"][key]
    manifest.update({"model": "mixed", "phases": pools["phases"], "contexts": CONTEXTS, "impacts": pools["impacts"],
                     "mastering": {**profile, "filters": filters, "source": "original MP3; never previously mastered WAV"},
                     "import": {"date": "2026-11-03", "model": "eleven_v4", "files": len(imported), "unique_audio": len(seen),
                                "sources": imported}})
    (BANK / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Imported {len(imported)} recordings as {len(seen)} unique WAVs")
    print({section: {key: len(value) for key, value in groups.items()} for section, groups in pools.items()})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    main(parser.parse_args().source)
