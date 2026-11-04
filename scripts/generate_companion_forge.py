#!/usr/bin/env py3
"""Generate a Transferania companion JPG via local Forge (127.0.0.1:7860).

Example:
  py -3 scripts/generate_companion_forge.py rhythm-lick --dest transferania-adult-rhythm-lick.jpg
  py -3 scripts/generate_companion_forge.py rhythm-lick --dry-run
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_companion_art as art


def main() -> int:
    parser = argparse.ArgumentParser(description="Forge companion portrait")
    parser.add_argument("pose", nargs="?", default="rhythm-lick", help="pose id (see --list)")
    parser.add_argument("--dest", default="", help="output filename under assets/companion/")
    parser.add_argument("--chat", action="store_true", help="write to assets/companion/chat/")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()
    if args.list:
        print(json.dumps(art.list_poses(), indent=2))
        return 0
    try:
        gen = art.generate_pose(args.pose, seed=args.seed, dry_run=args.dry_run, root=ROOT)
    except art.CompanionArtError as exc:
        print(f"error: {exc.message} ({exc.code})", file=sys.stderr)
        return 2
    if args.dry_run:
        print(json.dumps(gen, indent=2, ensure_ascii=False))
        return 0
    dest = args.dest or f"forge-{args.pose}.jpg"
    saved = art.save_generation(ROOT, dest, gen["bytes"], chat=args.chat)
    print(json.dumps({"ok": True, "href": saved["href"], "seed": gen.get("seed"), "bytes": saved["bytes"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
