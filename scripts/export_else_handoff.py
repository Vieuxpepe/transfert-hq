#!/usr/bin/env python3
"""Export Else's Transfert HQ digest for Gemini-Test boot ingest."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device-id", default="", help="Else thread device id (default: newest)")
    parser.add_argument("--gemini-root", default="", help="Gemini-Test root (default C:\\Gemini-Test)")
    parser.add_argument("--owner", default="admin")
    parser.add_argument("--dry-run", action="store_true", help="Build digest without writing Gemini-Test files")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    import hq_ai as ai
    import hq_else_handoff

    # Minimal bind for store root when running offline.
    if not getattr(ai, "_cb", None) or not ai._cb.get("root"):
        ai.bind(root=str(ROOT))

    out = hq_else_handoff.export_else_handoff(
        device_id=args.device_id or None,
        owner=args.owner,
        gemini_root=args.gemini_root or None,
        dry_run=args.dry_run,
    )
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    elif out.get("dry_run"):
        print(f"Dry-run digest hash={out['content_hash']} bullets={out['bullets']} empty={out.get('empty')}")
    else:
        print(f"Wrote {out['path']} ({out['bullets']} bullets, hash={out['content_hash']})")
        print(f"Markdown {out['markdown_path']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
