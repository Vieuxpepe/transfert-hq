#!/usr/bin/env python3
"""Animation & motion perf guards (companion Live2D, dangling member, home idle).

Run after changes to hq-companion.js, hq-dangling-member.js, hq-home-fx.*,
hq-chrome.css, or companion/dangle CSS. CI: .github/workflows/animation-perf.yml
"""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=str(ROOT))


def node_check(rel: str) -> None:
    run(["node", "--check", str(ROOT / rel)])


def unittest_modules(*modules: str) -> None:
    run([sys.executable, "-m", "unittest", *modules, "-v"])


def run_dangling_perf15() -> None:
    path = ROOT / "tests" / "test_hq_dangling_perf15.py"
    spec = importlib.util.spec_from_file_location("test_hq_dangling_perf15", path)
    if not spec or not spec.loader:
        raise RuntimeError("cannot load test_hq_dangling_perf15.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    for name in sorted(n for n in dir(mod) if n.startswith("test_")):
        fn = getattr(mod, name, None)
        if not callable(fn):
            continue
        print(f"  dangling perf15: {name}", flush=True)
        fn()


def main() -> int:
    for rel in (
        "assets/hq-motion-coordinator.js",
        "assets/hq-companion.js",
        "assets/hq-dangling-member.js",
        "assets/hq-home-fx.js",
    ):
        node_check(rel)

    run(["node", str(ROOT / "tests" / "check_hq_files.mjs")])

    unittest_modules(
        "tests.test_hq_motion_coordinator",
        "tests.test_hq_motion_tools",
        "tests.test_hq_motion_perf14",
        "tests.test_hq_motion_perf16",
        "tests.test_hq_avatar_idle_perf12",
        "tests.test_hq_idle_perf11",
    )

    print("+ dangling perf15 (function tests)", flush=True)
    run_dangling_perf15()

    print("verify_animation_pipeline: OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
