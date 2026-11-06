#!/usr/bin/env python3
"""Admin: POST save-agent-packet → .hq-carnet/diagnostics/agent-packet-latest.md"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_fb_path = ROOT / "scripts" / "fetch_session_bundle.py"
_spec = importlib.util.spec_from_file_location("_hq_fetch_session_bundle", _fb_path)
assert _spec and _spec.loader
_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_mod)


def main() -> None:
    p = argparse.ArgumentParser(description="Save HQ agent packet markdown on the bridge host.")
    p.add_argument("--base", default="http://127.0.0.1:8765")
    p.add_argument("--pin", required=True)
    p.add_argument("--limit", type=int, default=50)
    args = p.parse_args()
    op = _mod.login(args.base, args.pin)
    url = args.base.rstrip("/") + "/api/diag/save-agent-packet"
    body = json.dumps({"limit": int(args.limit)}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": args.base.rstrip("/"),
        },
    )
    try:
        with op.open(req, timeout=60) as resp:
            raw = resp.read()
            st = resp.status
    except urllib.error.HTTPError as e:
        st = e.code
        raw = e.read()
    rep = json.loads(raw.decode("utf-8"))
    if st != 200 or not rep.get("ok"):
        raise SystemExit(f"save failed HTTP {st}: {rep}")
    print(rep.get("relative") or rep, file=sys.stderr)


if __name__ == "__main__":
    main()
