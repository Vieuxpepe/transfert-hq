"""Assistant chat UI — offline DOM checks for the stop controls, Securia's card and Musica's composer."""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CASES = (
    "forgia",
    "culinia",
    "securia",
    "securia-confirm",
    "securia-dismiss",
    "securia-confirm-failure",
    "inventoria",
    "inventoria-draft",
    "inventoria-undo",
    "inventoria-dismiss",
    "musica",
    "musica-confirm",
    "musica-cancel-failure",
    "inventoria-ignorer",
    "inventoria-ignorer-failure",
    "inventoria-ignorer-detect",
    "inventoria-ignorer-detect-failure",
    "inventoria-ignorer-adjust",
    "inventoria-ignorer-ambiguous",
    "inventoria-ignorer-multi-row",
    "inventoria-ignorer-detect-multi-row",
    "inventoria-restore-grocery",
    "inventoria-restore-detect",
    "inventoria-restore-ambiguous",
    "inventoria-restore-op-gone",
    "inventoria-undo-toast",
    "inventoria-deep-link-say",
    "inventoria-where-is",
    "inventoria-one-card",
    "inventoria-camera-menu",
    "inventoria-toast-hold",
    "inventoria-settings-shop",
    "inventoria-where-chip",
    "inventoria-where-no-card",
    "inventoria-validate-failure",
)


class AssistantChatUiChecks(unittest.TestCase):
    def _run(self, **env: str) -> str:
        proc = subprocess.run(
            ["node", "tests/check_assistant_chat_ui.mjs"],
            capture_output=True,
            text=True,
            cwd=ROOT,
            timeout=120,
            env={**os.environ, **env},
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        return proc.stdout

    def test_chat_ui_syntax(self) -> None:
        for rel in (
            "assets/hq-forgia-chip.js",
            "assets/hq-culinia-chip.js",
            "assets/hq-securia-chip.js",
            "assets/hq-inventoria-chip.js",
            "assets/hq-music.js",
            "tests/hq_dom_stub.mjs",
            "tests/check_assistant_chat_ui.mjs",
        ):
            path = ROOT / rel
            self.assertTrue(path.is_file(), rel)
            subprocess.run(["node", "--check", str(path)], check=True, cwd=ROOT)

    def test_stop_controls_and_securia_card(self) -> None:
        out = self._run()
        self.assertIn(f"{len(CASES)} cases", out)
        for name in CASES:
            self.assertIn("ok  " + name, out)

    def test_checks_fail_when_the_wiring_is_removed(self) -> None:
        out = self._run(HQ_UI_PROVE="1")
        self.assertIn("load-bearing", out)
        self.assertIn(f"{len(CASES)}/{len(CASES)}", out)


if __name__ == "__main__":
    unittest.main()
