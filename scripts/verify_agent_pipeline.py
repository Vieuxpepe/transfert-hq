#!/usr/bin/env python3
"""Run agent-debug pipeline smoke tests (CI/local)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=str(ROOT))


def main() -> int:
    run([sys.executable, str(ROOT / "tests" / "test_hq_client_debug_smoke.py")])
    run(
        [
            sys.executable,
            "-m",
            "unittest",
            "tests.test_hq_diagnostics.AgentTriage",
            "tests.test_hq_diagnostics.SessionBundle",
            "-v",
        ]
    )
    print("verify_agent_pipeline: OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
