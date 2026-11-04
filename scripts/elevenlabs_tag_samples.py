"""Generate ElevenLabs v4 TTS clips from [audio tag] prompts for sound-design passes.

Requires ELEVENLABS_API_KEY (must start with sk_). Does not read keys from disk.

Usage:
  set ELEVENLABS_API_KEY=sk_...
  python scripts/elevenlabs_tag_samples.py --out artifacts/elevenlabs-tag-samples
"""

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

from elevenlabs_sound_design_common import load_catalog, tts_request_body

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "assets" / "companion" / "chat" / "reactions" / "manifest.json"
API = "https://api.elevenlabs.io/v1/text-to-speech"
MODEL = "eleven_v4"
TAG_ONLY = re.compile(r"^\[[^\]]+\]\s*$")


def load_voice_id() -> str:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    voice_id = data.get("voice_id")
    if not voice_id:
        raise SystemExit(f"voice_id missing in {MANIFEST}")
    return str(voice_id)


def normalize_prompt(text: str, filler: str) -> str:
    text = text.strip()
    if TAG_ONLY.match(text):
        return f"{text} {filler}".strip()
    return text


def synthesize(api_key: str, voice_id: str, text: str, catalog: dict) -> bytes:
    url = f"{API}/{voice_id}?output_format=mp3_44100_128"
    body = json.dumps(tts_request_body(text, catalog.get("model_id") or MODEL, catalog)).encode("utf-8")
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
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--out",
        type=Path,
        default=ROOT / "artifacts" / "elevenlabs-tag-samples",
        help="Output directory for MP3 files",
    )
    parser.add_argument(
        "--filler",
        default="...",
        help="Trailing text appended when the prompt is tag-only (default: ...)",
    )
    parser.add_argument(
        "prompts",
        nargs="*",
        help="Prompt strings; default is a small test set",
    )
    args = parser.parse_args()

    api_key = os.environ.get("ELEVENLABS_API_KEY", "").strip()
    if not api_key.startswith("sk_"):
        print(
            "Set ELEVENLABS_API_KEY to your secret key (starts with sk_). "
            "ElevenLabs rejects key IDs / hashes.",
            file=sys.stderr,
        )
        return 2

    prompts = args.prompts or [
        "[thunder reverberating] ...",
        "[water sloshing sounds] ...",
        "[soft sigh of satisfaction] ...",
        "[enthusiastic kiss with lip smack] ...",
        "[loud moan] ...",
        "[thunder reverberating]",
    ]

    voice_id = load_voice_id()
    catalog = load_catalog()
    args.out.mkdir(parents=True, exist_ok=True)
    results: list[dict] = []

    for raw in prompts:
        text = normalize_prompt(raw, args.filler)
        slug = re.sub(r"[^\w]+", "_", raw.strip().lower()).strip("_")[:60] or "sample"
        out_path = args.out / f"{slug}.mp3"
        entry: dict = {"prompt_in": raw, "prompt_sent": text, "path": str(out_path)}
        try:
            audio = synthesize(api_key, voice_id, text, catalog)
            out_path.write_bytes(audio)
            entry["ok"] = True
            entry["bytes"] = len(audio)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            entry["ok"] = False
            entry["error"] = detail
        results.append(entry)
        status = "ok" if entry.get("ok") else "FAIL"
        print(f"{status}: {text!r} -> {out_path.name}")

    (args.out / "results.json").write_text(
        json.dumps(results, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    failed = sum(1 for r in results if not r.get("ok"))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
