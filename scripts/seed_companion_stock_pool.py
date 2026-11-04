#!/usr/bin/env python3
"""Copy canonical pose JPGs into assets/companion/stock/{pose_id}/ for Mix pools."""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_companion_art as art  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="List copies only")
    parser.add_argument("--pose", action="append", help="Limit to pose id (repeatable)")
    args = parser.parse_args()
    poses = args.pose or list(art.POSE_DEFAULT_DEST.keys())
    companion = ROOT / "assets" / "companion"
    copied = 0
    skipped = 0
    for pose_id in poses:
        dest_name = art.default_dest(pose_id)
        if not dest_name:
            skipped += 1
            continue
        src = companion / dest_name
        if not src.is_file():
            skipped += 1
            continue
        stock_dir = companion / "stock" / pose_id
        dst = stock_dir / dest_name
        if dst.is_file() and dst.stat().st_size == src.stat().st_size:
            skipped += 1
            continue
        if args.dry_run:
            print(f"copy {src.relative_to(ROOT)} -> {dst.relative_to(ROOT)}")
            copied += 1
            continue
        stock_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        print(f"seeded {dst.relative_to(ROOT)}")
        copied += 1
    print(f"done: {copied} copied, {skipped} skipped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
