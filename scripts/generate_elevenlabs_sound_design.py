"""Generate MP3s from scripts/elevenlabs_sound_design_catalog.json via ElevenLabs v4 TTS."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from elevenlabs_sound_design_common import CATALOG, ROOT, load_catalog, tts_request_body

API = "https://api.elevenlabs.io/v1/text-to-speech"
TAG_ONLY = re.compile(r"^\[[^\]]+\]\s*$")


def normalize_prompt(text: str) -> str:
    text = text.strip()
    if TAG_ONLY.match(text):
        return f"{text} ..."
    return text


def synthesize(api_key: str, voice_id: str, model_id: str, text: str, catalog: dict) -> bytes:
    url = f"{API}/{voice_id}?output_format=mp3_44100_128"
    body = json.dumps(tts_request_body(text, model_id, catalog)).encode("utf-8")
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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "artifacts" / "elevenlabs-sound-design-src",
        help="Folder for generated Else_*.mp3 files",
    )
    parser.add_argument("--skip-existing", action="store_true")
    args = parser.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key.startswith("sk_"):
        print("Set ELEVENLABS_API_KEY (sk_...)", file=sys.stderr)
        return 2

    catalog = load_catalog()
    voice_id = catalog.get("voice_id") or "hBlh399It8ij4tnAyFcj"
    model_id = catalog.get("model_id") or "eleven_v4"
    args.out.mkdir(parents=True, exist_ok=True)

    results = []
    for clip in catalog["clips"]:
        dest = args.out / clip["file"]
        entry = {"file": clip["file"], "text": clip["text"]}
        if args.skip_existing and dest.exists() and dest.stat().st_size > 0:
            entry["ok"] = True
            entry["skipped"] = True
            results.append(entry)
            print(f"skip: {clip['file']}")
            continue
        prompt = normalize_prompt(clip["text"])
        try:
            dest.write_bytes(synthesize(api_key, voice_id, model_id, prompt, catalog))
            entry["ok"] = True
            entry["bytes"] = dest.stat().st_size
            print(f"ok: {clip['file']}")
        except urllib.error.HTTPError as exc:
            entry["ok"] = False
            entry["error"] = exc.read().decode("utf-8", errors="replace")
            print(f"FAIL: {clip['file']}", file=sys.stderr)
        results.append(entry)

    (args.out / "generation_results.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    failed = sum(1 for item in results if not item.get("ok"))
    print(f"Generated {len(results) - failed}/{len(results)} clips -> {args.out}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
