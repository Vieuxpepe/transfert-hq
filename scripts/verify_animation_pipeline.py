#!/usr/bin/env python3
"""Animation & motion perf guards (companion Live2D, dangling member, home idle).

Run after changes to hq-companion.js, hq-dangling-member.js, hq-home-fx.*,
hq-chrome.css, or companion/dangle CSS. CI: .github/workflows/animation-perf.yml
"""

from __future__ import annotations

import fnmatch
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "animation-perf.yml"

VERIFIER_ASSETS = (
    "assets/hq-motion-coordinator.js",
    "assets/hq-kinetic-score.js",
    "assets/hq-companion-gaze.js",
    "assets/hq-companion-mouth.js",
    "assets/hq-companion.js",
    "assets/hq-dangling-member.js",
    "assets/hq-home-fx.js",
)

NODE_TESTS = (
    "tests/check_hq_files.mjs",
    "tests/test_hq_kinetic_score.mjs",
    "tests/check_hq_companion_gaze.mjs",
    "tests/check_hq_companion_mouth.mjs",
    "tests/check_hq_companion_audio_spam.mjs",
    "tests/check_hq_companion_natural_voice.mjs",
)

UNITTEST_MODULES = (
    "tests.test_hq_animation_workflow_guard",
    "tests.test_hq_motion_coordinator",
    "tests.test_hq_motion_tools",
    "tests.test_hq_kinetic_score",
    "tests.test_hq_motion_perf14",
    "tests.test_hq_motion_perf16",
    "tests.test_hq_avatar_idle_perf12",
    "tests.test_hq_idle_perf11",
)

# Loaded directly by run_dangling_perf15(), not through unittest discovery.
PYTHON_TEST_FILES = ("tests/test_hq_dangling_perf15.py",)


def run(cmd: list[str]) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=str(ROOT))


def node_check(rel: str) -> None:
    run(["node", "--check", str(ROOT / rel)])


def unittest_modules(*modules: str) -> None:
    run([sys.executable, "-m", "unittest", *modules, "-v"])


def workflow_event_paths(event: str) -> set[str]:
    """The path filter for one workflow event, or a hard failure."""
    text = WORKFLOW.read_text(encoding="utf-8")
    match = re.search(rf"^  {re.escape(event)}:\n    paths:\n((?:      - .*\n)+)", text, re.M)
    if not match:
        raise RuntimeError(f"cannot read {event}.paths from {WORKFLOW}")
    paths = set(re.findall(r'-\s*"([^"]+)"', match.group(1)))
    if not paths:
        raise RuntimeError(f"empty {event}.paths in {WORKFLOW}")
    return paths


def node_test_assets() -> set[str]:
    """Assets the verifier node-checks or its node tests read directly."""
    found = set(VERIFIER_ASSETS)
    for rel in NODE_TESTS:
        text = (ROOT / rel).read_text(encoding="utf-8")
        found.update(re.findall(r"assets/[A-Za-z0-9_./-]+\.(?:json|js|css)\b", text))
        for name in re.findall(r'"assets"\s*,\s*"([A-Za-z0-9_./-]+\.(?:json|js|css))"', text):
            found.add("assets/" + name)
    return found


def required_workflow_paths() -> set[str]:
    """Every test and asset whose change must trigger the verifier."""
    modules = {module.replace(".", "/") + ".py" for module in UNITTEST_MODULES}
    return (set(NODE_TESTS) | modules | set(PYTHON_TEST_FILES) | node_test_assets()
            | {"scripts/verify_animation_pipeline.py"})


def guard_workflow_paths() -> None:
    """Fail if a verifier test or an asset it reads cannot trigger the workflow."""
    required = required_workflow_paths()
    problems = []
    for event in ("push", "pull_request"):
        listed = workflow_event_paths(event)
        missing = sorted(path for path in required
                         if not any(fnmatch.fnmatchcase(path, pattern) for pattern in listed))
        if missing:
            problems.append((event, missing))
    if problems:
        for event, missing in problems:
            print(f"workflow {event}.paths missing:", ", ".join(missing), file=sys.stderr)
        raise RuntimeError("animation-perf workflow path guard failed")
    print(f"animation workflow paths: {len(required)} tests/assets trigger push and pull_request",
          flush=True)


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
    guard_workflow_paths()
    for rel in VERIFIER_ASSETS:
        node_check(rel)

    for rel in NODE_TESTS:
        run(["node", str(ROOT / rel)])

    unittest_modules(*UNITTEST_MODULES)

    print("+ dangling perf15 (function tests)", flush=True)
    run_dangling_perf15()

    print("verify_animation_pipeline: OK", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
