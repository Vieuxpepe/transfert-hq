#!/usr/bin/env python3
"""Run all agent quota verify scripts (maps, debug, bridge, carnet)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = (
    "verify_agent_pipeline.py",
    "verify_bridge_smoke.py",
    "verify_carnet_smoke.py",
)


def main() -> int:
    for name in SCRIPTS:
        path = ROOT / "scripts" / name
        cmd = [sys.executable, str(path)]
        print("+", " ".join(cmd), flush=True)
        subprocess.check_call(cmd, cwd=str(ROOT))
    print("verify_all_agent_maps: OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
