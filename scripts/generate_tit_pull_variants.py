"""Curated bust pull foley (5 clips): elastic 01/02/07 + slosh 10/13. Regenerate via ElevenLabs SFX."""

from __future__ import annotations

import argparse
import json
import os
import re
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
CURATED_PATH = _SCRIPTS / "tit_pull_curated.json"
RESULTS = OUT / "tit_pull_variants.json"
SFX_API = "https://api.elevenlabs.io/v1/sound-generation"

SFX_FOLEY_TAIL = ", human body foley only, no birds, no animals, no speech, no impacts or gunshots"

# Curated pool only (Maître trim). 02 = long seamless loop bed while pulling.
TIT_PULL_VARIANTS: list[tuple[str, str, float, float]] = [
    (
        "tit_pull_01.mp3",
        "Soft rubbery elastic skin stretch on boob, gentle sustained tension squeak while flesh pulls"
        + SFX_FOLEY_TAIL,
        0.85,
        0.76,
    ),
    (
        "tit_pull_02.mp3",
        "Comic rubber elastic stretch pull with prominent rubber squeak and squeaky tension creak, "
        "twangy elastic skin elongation, sharpish but muted squeaks not cartoon boing, body foley"
        + SFX_FOLEY_TAIL,
        0.95,
        0.78,
    ),
    (
        "tit_pull_07.mp3",
        "Micro elastic fibers stretching in boob skin through thin fabric, tiny rubber tension"
        + SFX_FOLEY_TAIL,
        0.65,
        0.72,
    ),
    (
        "tit_pull_10.mp3",
        "Soft boob slosh jiggle, gentle internal liquid flesh movement, close mic body foley"
        + SFX_FOLEY_TAIL,
        0.9,
        0.78,
    ),
    (
        "tit_pull_13.mp3",
        "Subtle underboob slosh while chest rocks, quiet wet flesh liquid shuffle"
        + SFX_FOLEY_TAIL,
        0.8,
        0.75,
    ),
]

CURATED_STEMS = {int(Path(n).stem.split("_")[-1]) for n, *_ in TIT_PULL_VARIANTS}


def catalog_name(preview: str) -> str:
    num = Path(preview).stem.split("_")[-1]
    return f"Else_tit_pull_{num}.mp3"


def stem_kind(stem: int) -> str:
    return "elastic" if stem in (1, 2, 7) else "slosh"


def synthesize_sfx(api_key: str, text: str, duration: float, influence: float) -> bytes:
    from elevenlabs_sound_design_common import DEFAULT_SFX_MODEL, sound_effect_request_body

    url = f"{SFX_API}?output_format=mp3_44100_128"
    body = json.dumps(
        sound_effect_request_body(
            text,
            duration_seconds=duration,
            prompt_influence=influence,
            model_id=DEFAULT_SFX_MODEL,
        )
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"xi-api-key": api_key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return resp.read()


def trim_manifest_tit_pull_pool() -> int:
    """Keep only curated stems in impacts.tit_pull (latest url per stem)."""
    man_path = BANK / "manifest.json"
    man = json.loads(man_path.read_text(encoding="utf-8"))
    pool = man.get("impacts", {}).get("tit_pull")
    if not isinstance(pool, list):
        return 0
    by_n: dict[int, dict] = {}
    stem_re = re.compile(r"else_tit_pull_(\d+)", re.I)
    for item in pool:
        m = stem_re.search(item.get("url", ""))
        if not m:
            continue
        n = int(m.group(1))
        if n not in CURATED_STEMS:
            continue
        prev = by_n.get(n)
        if not prev or item.get("url", "") > prev.get("url", ""):
            by_n[n] = item
    ordered = [by_n[n] for n in sorted(by_n)]
    man.setdefault("impacts", {})["tit_pull"] = ordered
    ctx = man.get("contexts") or {}
    ctx["impacts.tit_pull"] = "Curated bust pull: elastic 01/02/07 (02 loops while pulling) + slosh 10/13"
    man["contexts"] = ctx
    man_path.write_text(json.dumps(man, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    from slim_reaction_manifest import write_runtime_manifest

    write_runtime_manifest()
    return len(ordered)


def reencode_tit_pull_oggs() -> None:
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
    trim_manifest_tit_pull_pool()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    urls = sorted(
        u
        for u in collect_manifest_urls(manifest)
        if u.endswith(".ogg") and "else_tit_pull_" in u.lower()
    )
    encoded = 0
    for url in urls:
        m = re.search(r"else_tit_pull_(\d+)", url, re.I)
        if not m or int(m.group(1)) not in CURATED_STEMS:
            continue
        ogg_path = ROOT / url.lstrip("/")
        source = source_for_url(url, manifest, ogg_path)
        if not source or not source.is_file():
            print(f"skip reencode (no source): {url}")
            continue
        temp = ogg_path.with_suffix(".reencode.tmp.ogg")
        try:
            result = encode_reaction_ogg(ffmpeg, source, temp, ffprobe=ffprobe, loudness_class="impact")
            temp.replace(ogg_path)
            patch_sample_meta(manifest, url, result["duration_ms"])
            encoded += 1
            print(f"reencoded: {ogg_path.name}")
        except (OSError, subprocess.CalledProcessError) as exc:
            print(f"FAIL {ogg_path.name}: {exc}", file=sys.stderr)
        finally:
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
    print(f"tit_pull_oggs_reencoded={encoded}")


def sync_expansion_catalog() -> None:
    rows = []
    notes = {}
    if CURATED_PATH.is_file():
        notes = json.loads(CURATED_PATH.read_text(encoding="utf-8")).get("notes") or {}
    for dest_name, text, _dur, _infl in TIT_PULL_VARIANTS:
        stem = Path(dest_name).stem.split("_")[-1]
        cat = catalog_name(dest_name)
        row = {
            "file": cat,
            "section": "impacts",
            "event": "tit_pull",
            "impact": True,
            "text": text,
        }
        if notes.get(stem):
            row["note"] = notes[stem]
        rows.append(row)
    exp_path = ROOT / "scripts/sound_expansion_catalog.json"
    exp = json.loads(exp_path.read_text(encoding="utf-8"))
    exp = [e for e in exp if e.get("event") != "tit_pull"]
    exp.extend(rows)
    exp_path.write_text(json.dumps(exp, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    el_path = ROOT / "scripts/elevenlabs_sound_design_catalog.json"
    el = json.loads(el_path.read_text(encoding="utf-8"))
    el["clips"] = [c for c in el["clips"] if c.get("event") != "tit_pull"] + rows
    el_path.write_text(json.dumps(el, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-existing", action="store_true")
    parser.add_argument("--no-reencode", action="store_true")
    parser.add_argument("--only", nargs="+", help="Regenerate stems only, e.g. 02")
    parser.add_argument("--trim-manifest-only", action="store_true")
    args = parser.parse_args()

    if args.trim_manifest_only:
        n = trim_manifest_tit_pull_pool()
        print(f"manifest tit_pull entries={n}")
        return 0

    sync_expansion_catalog()

    only_stems: set[int] | None = None
    if args.only:
        only_stems = {int(x.lstrip("0") or "0") for x in args.only}

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key.startswith("sk_"):
        print("Set ELEVENLABS_API_KEY (sk_...)", file=sys.stderr)
        return 2

    OUT.mkdir(parents=True, exist_ok=True)
    SRC.mkdir(parents=True, exist_ok=True)

    variants = TIT_PULL_VARIANTS
    if only_stems:
        variants = [v for v in TIT_PULL_VARIANTS if int(Path(v[0]).stem.split("_")[-1]) in only_stems]

    results: list[dict] = []
    for dest_name, text, dur, infl in variants:
        stem = int(Path(dest_name).stem.split("_")[-1])
        dest = OUT / dest_name
        cat = catalog_name(dest_name)
        entry = {
            "engine": "eleven_text_to_sound_v3",
            "file": dest_name,
            "catalog_file": cat,
            "kind": stem_kind(stem),
            "prompt_in": text,
            "duration_seconds": dur,
            "prompt_influence": infl,
            "path": str(dest),
        }
        if args.skip_existing and dest.is_file() and dest.stat().st_size > 0:
            entry["ok"] = True
            entry["skipped"] = True
            entry["bytes"] = dest.stat().st_size
            shutil.copy2(dest, SRC / cat)
            results.append(entry)
            print(f"skip: {dest_name}")
            continue
        try:
            data = synthesize_sfx(api_key, text, dur, infl)
            dest.write_bytes(data)
            (SRC / cat).write_bytes(data)
            entry["ok"] = True
            entry["bytes"] = len(data)
            print(f"ok: {dest_name} -> {cat}")
        except urllib.error.HTTPError as exc:
            entry["ok"] = False
            entry["error"] = exc.read().decode("utf-8", errors="replace")
            print(f"FAIL: {dest_name}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001
            entry["ok"] = False
            entry["error"] = str(exc)
            print(f"FAIL: {dest_name}: {exc}", file=sys.stderr)
        results.append(entry)

    if RESULTS.is_file():
        prior = json.loads(RESULTS.read_text(encoding="utf-8"))
        by_file = {r["file"]: r for r in prior if isinstance(r, dict) and r.get("file")}
        for r in results:
            by_file[r["file"]] = r
        results = [by_file[k] for k in sorted(by_file)]
    RESULTS.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    ok = sum(1 for r in results if r.get("ok"))
    print(f"{ok}/{len(variants)} generated -> {OUT}")

    if ok and not args.no_reencode and variants:
        import subprocess as sp

        sp.check_call([sys.executable, str(_SCRIPTS / "integrate_sound_expansion.py")], cwd=str(ROOT))
        n = trim_manifest_tit_pull_pool()
        print(f"manifest tit_pull entries={n}")
        reencode_tit_pull_oggs()

    return 0 if ok == len(variants) else 1


if __name__ == "__main__":
    raise SystemExit(main())
