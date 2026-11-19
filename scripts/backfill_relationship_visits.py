#!/usr/bin/env python3
"""Fold the visits that really happened into each pair's relationship evidence.

The visit logs have recorded assistant-to-assistant exchanges since 2026-11-13,
but ``hq_relationships.note_exchange`` only started counting them later, so a
pair with two real days of visits still read as a one-day acquaintance and the
panel could never show a rung above ``premier_jour``.

This reads every ``*_visits.json`` under the state root, merges the two copies
the recorder writes for each visit (both sides share one timestamp), and folds
the real days and counts into the owner's relationship file through
``hq_relationships.fold_visits``: distinct days join the stored list, the
exchange count becomes the larger of what is stored and what the logs prove, and
``last_at`` only moves forward. ``family_at``, ``kind`` and ``motif`` are left
alone, so the house's daily pacing is untouched. Nothing is invented and a
second run changes nothing.

    python scripts/backfill_relationship_visits.py [--root .] [--owner admin]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_relationships as relationships  # noqa: E402

VISIT_SUFFIX = "_visits.json"
SKIP_DIRS = {".git", "assets", "node_modules", "__pycache__"}


def visit_files(root: Path) -> list[Path]:
    found: list[Path] = []
    for base, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            if name.endswith(VISIT_SUFFIX):
                found.append(Path(base) / name)
    return sorted(found)


def evidence_from(root: Path) -> dict[tuple[str, str], set[float]]:
    """Real visit moments per pair, deduplicated across the two copies."""
    moments: dict[tuple[str, str], set[float]] = defaultdict(set)
    for path in visit_files(root):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rows = data.get("visits") if isinstance(data, dict) else None
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            me = str(row.get("self") or "").strip().lower()
            other = str(row.get("other") or "").strip().lower()
            at = row.get("at")
            if not me or not other or me == other or not isinstance(at, (int, float)):
                continue
            moments[(me, other)].add(round(float(at), 3))
    return moments


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=str(ROOT))
    parser.add_argument("--owner", default="admin")
    args = parser.parse_args()
    root = Path(args.root)
    moments = evidence_from(root)
    print(f"visit files read under {root}: {len(visit_files(root))}")
    print(f"pairs with recorded visits: {len(moments)}")
    changed = relationships.fold_visits(root, moments, owner=args.owner)
    if not changed:
        print("nothing to fold: the relationship store already counts these visits")
        return 0
    print(f"pairs updated: {len(changed)}")
    for row in sorted(changed, key=lambda r: r["after"][1], reverse=True):
        before, after = row["before"], row["after"]
        print(f"  {row['a']}|{row['b']}: days {before[0]}->{after[0]}, "
              f"exchanges {before[1]}->{after[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
