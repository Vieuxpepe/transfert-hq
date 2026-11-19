"""Run the visits panel's own DOM path against the running bridge.

Mints the CSRF for the admin session in-process (never printed), then hands the
cookie to the node harness through the environment. The harness loads
``assets/hq-assistant-visits.js`` unmodified, mounts the two chips, lets the panel
pick and fetch, and reads the rendered bubbles back.

    python -X utf8 scripts/verify_visit_panel.py culinia pistonia
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _admin_token() -> str:
    sessions = json.loads((ROOT / "bridge_sessions.json").read_text(encoding="utf-8"))
    rows = [(entry.get("last_active", 0), key) for key, entry in sessions.items()
            if isinstance(entry, dict) and entry.get("user") == "Administrateur" and entry.get("role") == "admin"]
    if not rows:
        raise SystemExit("no admin session")
    return sorted(rows)[-1][1]


def main() -> int:
    host = (sys.argv[1] if len(sys.argv) > 1 else "culinia").lower()
    visitor = (sys.argv[2] if len(sys.argv) > 2 else "pistonia").lower()
    token = _admin_token()
    env = dict(os.environ)
    env.update({
        "HQ_COOKIE": f"transfert_session={token}",
        "HQ_CSRF": "",
        "HQ_BRIDGE": "http://127.0.0.1:8765",
    })
    wait = float(os.environ.get("HQ_PANEL_WAIT", "110"))   # the pair's own generation cooldown
    harness = "tests/check_hq_visit_scheduler.mjs" if "--scheduler" in sys.argv else "tests/check_hq_visit_panel.mjs"
    proc = None
    for attempt in range(2):
        if wait > 0:
            time.sleep(wait)
        proc = subprocess.run(["node", harness, host, visitor],
                              cwd=ROOT, env=env, capture_output=True, text=True, timeout=180)
        if proc.returncode == 0:
            break
        wait = 110      # a canned visit spent the pair's slot: wait out the cooldown once
    sys.stdout.write(proc.stdout)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-2000:])
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
