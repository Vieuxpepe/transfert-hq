#!/usr/bin/env python3
"""Fast Carnet storage/API smoke (agents)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    cmd = [
        sys.executable,
        "-m",
        "unittest",
        "tests.test_hq_carnet.InitTests",
        "tests.test_hq_carnet.PageTests",
        "tests.test_hq_carnet.StorageTests",
        "-v",
    ]
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=str(ROOT))
    print("verify_carnet_smoke: OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
