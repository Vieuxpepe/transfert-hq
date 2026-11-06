#!/usr/bin/env python3
"""Print HQ agent brief markdown to stdout (admin PIN required).

Thin wrapper around fetch_session_bundle — default is paste-friendly brief_md.

Example:
  python scripts/agent_hq_brief.py --pin 424242
  python scripts/agent_hq_brief.py --pin 424242 --packet   # includes request_id_index JSON appendix
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import importlib.util

_fb_path = ROOT / "scripts" / "fetch_session_bundle.py"
_spec = importlib.util.spec_from_file_location("_hq_fetch_session_bundle", _fb_path)
assert _spec and _spec.loader
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)
fetch_bundle = _mod.fetch_bundle


def main() -> None:
    p = argparse.ArgumentParser(description="Print HQ agent brief for Cursor/agents.")
    p.add_argument("--base", default="http://127.0.0.1:8765", help="Bridge base URL")
    p.add_argument("--pin", required=True, help="Admin PIN")
    p.add_argument("--limit", type=int, default=50, help="Tail limit")
    p.add_argument(
        "--packet",
        action="store_true",
        help="Print packet_md (brief + config_effective + request_id_index appendix)",
    )
    p.add_argument("-o", "--output", help="Write text to file instead of stdout")
    args = p.parse_args()
    payload = fetch_bundle(args.base, args.pin, args.limit, brief=True)
    field = "packet_md" if args.packet else "brief_md"
    text = payload.get(field) or payload.get("brief_md") or ""
    if not isinstance(text, str) or not text.strip():
        raise SystemExit("agent-brief response missing brief_md")
    text = text if text.endswith("\n") else text + "\n"
    if args.output:
        with open(args.output, "w", encoding="utf-8") as fh:
            fh.write(text)
        print(args.output, file=sys.stderr)
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
