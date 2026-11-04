"""Generate many ElevenLabs previews for deep oral suction (wet_mouth SFX tags only)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "elevenlabs-expressive-sample-test"
RESULTS = OUT / "oral_suction_deep_variants.json"

# Tag-only prompts (no spoken lines) — same family as oral_suction_deep_01
DEEP_VARIANTS: list[tuple[str, str]] = [
    ("oral_suction_deep_02.mp3", "[deep hollow cheek suction wet slurp] ..."),
    ("oral_suction_deep_03.mp3", "[slow deep throat pull vacuum wet mouth] ..."),
    ("oral_suction_deep_04.mp3", "[rhythmic deep bobbing suction gulp] ..."),
    ("oral_suction_deep_05.mp3", "[tight lips deep shaft suction smack wet] ..."),
    ("oral_suction_deep_06.mp3", "[muffled deep oral suction close mic] ..."),
    ("oral_suction_deep_07.mp3", "[urgent deep swallow suction wet] ..."),
    ("oral_suction_deep_08.mp3", "[soft deep throat suction with saliva smack] ..."),
    ("oral_suction_deep_09.mp3", "[heavy wet gulp deep intake suction] ..."),
    ("oral_suction_deep_10.mp3", "[deep suction release inhale wet pop] ..."),
    ("oral_suction_deep_11.mp3", "[layered cheek and throat deep suction] ..."),
    ("oral_suction_deep_12.mp3", "[sticky wet deep pull off and re-suck] ..."),
    ("oral_suction_deep_13.mp3", "[low rumble deep throat vacuum wet] ..."),
    ("oral_suction_deep_14.mp3", "[fast shallow-to-deep suction crescendo wet] ..."),
    ("oral_suction_deep_15.mp3", "[breathy deep suction with tongue wet smack] ..."),
    ("oral_suction_deep_16.mp3", "[double gulp deep throat suction wet] ..."),
]


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-existing", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key.startswith("sk_"):
        print("Set ELEVENLABS_API_KEY (sk_...)", file=sys.stderr)
        return 2

    from elevenlabs_sound_design_common import load_catalog
    from generate_elevenlabs_sound_design import normalize_prompt, synthesize

    OUT.mkdir(parents=True, exist_ok=True)
    catalog = load_catalog()
    voice_id = catalog.get("voice_id") or "hBlh399It8ij4tnAyFcj"
    model_id = catalog.get("model_id") or "eleven_v4"

    results: list[dict] = []
    for dest_name, text in DEEP_VARIANTS:
        dest = OUT / dest_name
        entry = {"file": dest_name, "prompt_in": text, "path": str(dest)}
        if args.skip_existing and dest.is_file() and dest.stat().st_size > 0:
            entry["ok"] = True
            entry["skipped"] = True
            entry["bytes"] = dest.stat().st_size
            results.append(entry)
            print(f"skip: {dest_name}")
            continue
        prompt = normalize_prompt(text)
        entry["prompt_sent"] = prompt
        try:
            dest.write_bytes(synthesize(api_key, voice_id, model_id, prompt, catalog))
            entry["ok"] = True
            entry["bytes"] = dest.stat().st_size
            print(f"ok: {dest_name} ({entry['bytes']} bytes)")
        except Exception as exc:  # noqa: BLE001
            entry["ok"] = False
            entry["error"] = str(exc)
            print(f"FAIL: {dest_name}: {exc}", file=sys.stderr)
        results.append(entry)

    RESULTS.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    ok = sum(1 for r in results if r.get("ok"))
    print(f"{ok}/{len(results)} -> {OUT}")
    print(f"manifest: {RESULTS}")
    return 0 if ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
