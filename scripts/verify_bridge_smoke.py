#!/usr/bin/env python3
"""Bridge HTTP + diagnostics smoke (agents)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    steps = [
        [sys.executable, str(ROOT / "tests" / "test_hq_client_debug_smoke.py")],
        [
            sys.executable,
            "-m",
            "unittest",
            "tests.test_hq_diagnostics_http.Secrecy.test_cookies_and_headers_are_not_echoed",
            "tests.test_hq_diagnostics_http.ErrorRecording.test_save_agent_packet_http",
            "-v",
        ],
        [
            sys.executable,
            "-m",
            "unittest",
            "tests.test_hq_diagnostics_http.ClientLogHttp.test_upload_role_can_ship_browser_logs",
            "-v",
        ],
    ]
    for cmd in steps:
        print("+", " ".join(cmd), flush=True)
        subprocess.check_call(cmd, cwd=str(ROOT))
    print("verify_bridge_smoke: OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
