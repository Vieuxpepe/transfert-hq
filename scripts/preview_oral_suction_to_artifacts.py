"""Copy in-game oral/suction MP3s and generate expansion previews into expressive-sample-test."""
from __future__ import annotations

import json
import os
import re
import shutil
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts" / "elevenlabs-expressive-sample-test"
SRC = ROOT / "artifacts" / "elevenlabs-sound-design-src"
EXPANSION = ROOT / "scripts" / "sound_expansion_catalog.json"

COPY_MAP = [
    (SRC / "Else_wet_mouth_sfx_01.mp3", "in_game_wet_mouth_sfx.mp3", "[wet mouth sounds] (in-game wet_mouth pool)"),
    (SRC / "Else_soft_swallow_01.mp3", "in_game_soft_swallow.mp3", "[soft swallow gulp] (in-game wet_mouth pool)"),
    (SRC / "Else_lip_pop_01.mp3", "in_game_lip_pop_release_01.mp3", "[crisp lip pop] (in-game release pop)"),
    (SRC / "Else_lip_pop_02.mp3", "in_game_lip_pop_release_02.mp3", "[playful bubble pop] (in-game release pop)"),
]

ORAL_PREFIX = re.compile(r"Else_oral_suction_", re.I)


def slug_from_file(name: str) -> str:
    base = Path(name).stem
    if base.lower().startswith("else_"):
        base = base[5:]
    return base.lower() + ".mp3"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    results_path = OUT / "oral_suction_preview_results.json"
    prior: list = []
    if results_path.is_file():
        prior = json.loads(results_path.read_text(encoding="utf-8"))
    by_path = {item["path"]: item for item in prior if item.get("path")}

    for src, dest_name, note in COPY_MAP:
        dest = OUT / dest_name
        entry = {
            "kind": "copy",
            "source": str(src),
            "prompt_in": note,
            "path": str(dest),
        }
        if not src.is_file():
            entry["ok"] = False
            entry["error"] = "missing source"
            print(f"missing: {src}")
        else:
            shutil.copy2(src, dest)
            entry["ok"] = True
            entry["bytes"] = dest.stat().st_size
            print(f"copy: {dest_name}")
        by_path[str(dest)] = entry

    expansion = json.loads(EXPANSION.read_text(encoding="utf-8"))
    oral_clips = [c for c in expansion if ORAL_PREFIX.search(c.get("file", ""))]
    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if oral_clips and api_key.startswith("sk_"):
        from elevenlabs_sound_design_common import load_catalog, tts_request_body
        from generate_elevenlabs_sound_design import normalize_prompt, synthesize

        catalog = load_catalog()
        voice_id = catalog.get("voice_id") or "hBlh399It8ij4tnAyFcj"
        model_id = catalog.get("model_id") or "eleven_v4"
        for clip in oral_clips:
            dest_name = slug_from_file(clip["file"])
            dest = OUT / dest_name
            entry = {
                "kind": "generated",
                "catalog_file": clip["file"],
                "prompt_in": clip["text"],
                "path": str(dest),
            }
            if dest.is_file() and dest.stat().st_size > 0:
                entry["ok"] = True
                entry["skipped"] = True
                entry["bytes"] = dest.stat().st_size
                print(f"skip: {dest_name}")
            else:
                prompt = normalize_prompt(clip["text"])
                entry["prompt_sent"] = prompt
                try:
                    dest.write_bytes(synthesize(api_key, voice_id, model_id, prompt, catalog))
                    entry["ok"] = True
                    entry["bytes"] = dest.stat().st_size
                    print(f"ok: {dest_name}")
                except Exception as exc:  # noqa: BLE001
                    entry["ok"] = False
                    entry["error"] = str(exc)
                    print(f"FAIL: {dest_name}: {exc}")
            by_path[str(dest)] = entry
    elif oral_clips:
        print("ELEVENLABS_API_KEY not set — skipped generating new oral_suction_* previews.")

    merged = sorted(by_path.values(), key=lambda x: x.get("path", ""))
    results_path.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(merged)} entries -> {results_path}")
    print(f"Folder: {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
