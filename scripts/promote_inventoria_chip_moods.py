#!/usr/bin/env python3
"""Promote Inventoria forge keepers from backup branch → chip mood WebPs (no docs/demos on main).

Source tree: backup/inventoria-forge-demos-pr33-contaminated:docs/demos/
Output: assets/companion/inventoria-chip-{mood}.webp (+ @2x)
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "companion"
GIT = "git"
BACKUP = "backup/inventoria-forge-demos-pr33-contaminated"
DEMO_PREFIX = "docs/demos"

# Else-parity moods → forge keeper (character sheet / v19d keepers)
MOOD_SOURCES: dict[str, str] = {
    "idle": "inventoria-forge-sdxl-v16-shorter-h1536.png",
    "listening": "inventoria-forge-sdxl-v19d-short-squat-txt.png",
    "speaking": "inventoria-forge-sdxl-v19d-short-wave-txt.png",
    "proactive": "inventoria-forge-sdxl-v19d-short-lean-txt.png",
    "busy": "inventoria-forge-sdxl-v19-sheet-hands-hips.png",
    "sister": "inventoria-forge-sdxl-v19-sheet-sit-dangle.png",
}


def git_cat(git_path: str) -> bytes:
    spec = f"{BACKUP}:{git_path}"
    proc = subprocess.run(
        [GIT, "-C", str(ROOT), "show", spec],
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise FileNotFoundError(spec + " — " + proc.stderr.decode("utf-8", errors="replace")[:240])
    return proc.stdout


def chip_crop(im: Image.Image, focus_x: float = 0.52) -> Image.Image:
    w, h = im.size
    if h > w * 1.08:
        side = w
        top = max(0, int(h * 0.03))
        if top + side > h:
            top = max(0, h - side)
        box = (0, top, w, top + side)
    else:
        side = int(min(w, h) * 0.92)
        left = max(0, min(int(w * focus_x - side // 2), w - side))
        top = max(0, int(h * 0.04))
        box = (left, top, left + side, top + side)
    return im.crop(box)


def save_chip_pair(mood: str, im: Image.Image) -> None:
    crop = chip_crop(im.convert("RGB"))
    a = crop.resize((640, 640), Image.Resampling.LANCZOS)
    b = crop.resize((1280, 1280), Image.Resampling.LANCZOS)
    if mood == "idle":
        a.save(OUT / "inventoria-chip.webp", "WEBP", quality=88, method=6)
        b.save(OUT / "inventoria-chip@2x.webp", "WEBP", quality=88, method=6)
    else:
        a.save(OUT / f"inventoria-chip-{mood}.webp", "WEBP", quality=88, method=6)
        b.save(OUT / f"inventoria-chip-{mood}@2x.webp", "WEBP", quality=88, method=6)
    print(f"  {mood}: {crop.size} → webp 640/1280")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--moods", nargs="*", default=list(MOOD_SOURCES))
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    for mood in args.moods:
        rel = MOOD_SOURCES.get(mood)
        if not rel:
            print("unknown mood", mood, file=sys.stderr)
            return 1
        path = f"{DEMO_PREFIX}/{rel}"
        print(path)
        raw = git_cat(path)
        im = Image.open(BytesIO(raw))
        save_chip_pair(mood, im)
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
