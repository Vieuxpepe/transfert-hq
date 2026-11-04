"""Verify every manifest reaction URL is arcade_soft30 OGG on disk."""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parent
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

from reaction_ogg_preset import (  # noqa: E402
    PRESET_ID,
    SAMPLE_RATE_HZ,
    collect_manifest_urls,
)
from elevenlabs_sound_design_common import BANK, ROOT  # noqa: E402

from slim_reaction_manifest import slim_manifest  # noqa: E402

REACTION_BANK = ROOT / "assets/companion/chat/reactions"
RUNTIME = BANK / "manifest.runtime.json"


def probe_stream(path: Path, ffprobe: str) -> tuple[str, str]:
    out = subprocess.check_output(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "a:0",
            "-show_entries",
            "stream=codec_name,sample_rate",
            "-of",
            "csv=p=0",
            str(path),
        ],
        text=True,
    ).strip()
    parts = out.split(",")
    return (parts[0] if parts else "?", parts[1] if len(parts) > 1 else "?")


def main() -> None:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        raise SystemExit("ffprobe is required")

    manifest = json.loads((BANK / "manifest.json").read_text(encoding="utf-8"))
    urls = sorted(collect_manifest_urls(manifest))
    not_ogg: list[str] = []
    missing: list[str] = []
    bad_stream: list[tuple[str, str]] = []
    bad_fingerprint: list[str] = []

    for url in urls:
        if not url.endswith(".ogg"):
            not_ogg.append(url)
            continue
        if not re.search(r"\.[0-9a-f]{8}\.ogg$", url):
            bad_fingerprint.append(url)
            continue
        path = ROOT / url.lstrip("/")
        if not path.is_file():
            missing.append(url)
            continue
        codec, rate = probe_stream(path, ffprobe)
        if codec != "vorbis" or rate != str(SAMPLE_RATE_HZ):
            bad_stream.append((url, f"{codec}@{rate}"))

    orphan_wav = sorted(
        p.relative_to(REACTION_BANK).as_posix()
        for p in REACTION_BANK.rglob("*.wav")
        if "elevenlabs_" in str(p)
    )
    disk_ogg = {
        "/assets/companion/chat/reactions/"
        + p.relative_to(REACTION_BANK).as_posix().replace("\\", "/")
        for p in REACTION_BANK.rglob("*.ogg")
    }
    orphan_ogg = sorted(disk_ogg - set(urls))

    runtime_ok = True
    runtime_bytes = 0
    if not RUNTIME.is_file():
        runtime_ok = False
        print("runtime_manifest=missing")
    else:
        runtime_bytes = RUNTIME.stat().st_size
        on_disk = json.loads(RUNTIME.read_text(encoding="utf-8"))
        if on_disk != slim_manifest(manifest):
            runtime_ok = False
            print("runtime_manifest=stale (regenerate with slim_reaction_manifest.py)")

    print(f"manifest_unique_urls={len(urls)}")
    print(f"not_ogg={len(not_ogg)}")
    print(f"missing_file={len(missing)}")
    print(f"bad_fingerprint={len(bad_fingerprint)}")
    print(f"elevenlabs_orphan_wav={len(orphan_wav)}")
    print(f"orphan_ogg_not_in_manifest={len(orphan_ogg)}")
    print(f"expected_preset={PRESET_ID} sample_rate={SAMPLE_RATE_HZ}")
    print(f"runtime_manifest_bytes={runtime_bytes} ok={runtime_ok}")

    if not_ogg:
        print("not_ogg:", not_ogg[:5])
    if missing:
        print("missing:", missing[:5])
    if bad_fingerprint:
        print("bad_fingerprint:", bad_fingerprint[:5])
    if bad_stream:
        print("bad_stream:", bad_stream[:5])
    if orphan_wav:
        print("orphan_wav:", orphan_wav[:5])

    ok = runtime_ok and not any([not_ogg, missing, bad_stream, bad_fingerprint, orphan_wav, orphan_ogg])
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
