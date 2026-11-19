"""The animation-perf path guard must reject either event list going stale."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFIER = ROOT / "scripts" / "verify_animation_pipeline.py"


def load_verifier():
    spec = importlib.util.spec_from_file_location("verify_animation_pipeline_under_test", VERIFIER)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load verify_animation_pipeline.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def render_workflow(push: list[str], pull: list[str]) -> str:
    """A minimal workflow with the same indentation the guard reads."""
    lines = ["on:", "  push:", "    paths:"]
    lines += [f'      - "{path}"' for path in push]
    lines += ["  pull_request:", "    paths:"]
    lines += [f'      - "{path}"' for path in pull]
    lines += ["jobs:", "  verify:", "    runs-on: ubuntu-latest", "    steps:",
              "      - run: echo ok"]
    return "\n".join(lines) + "\n"


class AnimationWorkflowPathGuardTests(unittest.TestCase):
    def setUp(self):
        self.verifier = load_verifier()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.original = self.verifier.WORKFLOW
        self.addCleanup(setattr, self.verifier, "WORKFLOW", self.original)
        self.required = sorted(self.verifier.required_workflow_paths())

    def workflow(self, push: list[str], pull: list[str]) -> Path:
        path = Path(self.tmp.name) / "animation-perf.yml"
        path.write_text(render_workflow(push, pull), encoding="utf-8")
        self.verifier.WORKFLOW = path
        return path

    def assert_guard_accepts(self, push: list[str], pull: list[str]) -> None:
        self.workflow(push, pull)
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            self.verifier.guard_workflow_paths()
        self.assertIn("trigger push and pull_request", stdout.getvalue())

    def assert_guard_rejects(self, push: list[str], pull: list[str], event: str, victim: str) -> None:
        self.workflow(push, pull)
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(RuntimeError, msg=f"{event} list without {victim} passed"):
                self.verifier.guard_workflow_paths()
        message = stderr.getvalue()
        self.assertIn(f"workflow {event}.paths missing:", message)
        self.assertIn(victim, message)

    def lists_without(self, victim: str, event: str) -> tuple[list[str], list[str]]:
        push = [p for p in self.required if p != victim] if event == "push" else list(self.required)
        pull = [p for p in self.required if p != victim] if event == "pull_request" else list(self.required)
        return push, pull

    def test_complete_lists_pass(self):
        self.assert_guard_accepts(self.required, self.required)

    def test_workflow_glob_covers_required_unittest_path(self):
        victim = "tests/test_hq_motion_perf14.py"
        glob = "tests/test_hq_motion_perf*.py"
        self.assertIn(victim, self.required)
        paths = [glob if p == victim else p for p in self.required]
        self.assert_guard_accepts(paths, paths)

    def test_non_matching_glob_does_not_cover_required_path(self):
        victim = "tests/test_hq_motion_perf14.py"
        wrong_glob = "tests/test_hq_motion_perf*.js"
        self.assertIn(victim, self.required)
        paths = [wrong_glob if p == victim else p for p in self.required]
        self.assert_guard_rejects(paths, list(paths), "push", victim)

    def test_missing_node_test_fails_each_event(self):
        victim = self.verifier.NODE_TESTS[0]
        for event in ("push", "pull_request"):
            with self.subTest(event=event):
                # The victim stays in the other event, so only this list is wrong.
                self.assert_guard_rejects(*self.lists_without(victim, event), event, victim)

    def test_missing_loaded_asset_fails_each_event(self):
        victim = "assets/hq-companion-reaction-audio.js"
        self.assertIn(victim, self.required)
        for event in ("push", "pull_request"):
            with self.subTest(event=event):
                self.assert_guard_rejects(*self.lists_without(victim, event), event, victim)

    def test_missing_unittest_module_fails_each_event(self):
        victim = "tests/test_hq_motion_tools.py"
        self.assertIn(victim, self.required)
        for event in ("push", "pull_request"):
            with self.subTest(event=event):
                self.assert_guard_rejects(*self.lists_without(victim, event), event, victim)


if __name__ == "__main__":
    unittest.main()
