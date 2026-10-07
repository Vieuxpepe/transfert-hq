"""Phase 15 — tools/smoke_deploy.py against a throwaway loopback bridge: it must PASS a healthy instance, FAIL (non-zero) each
broken one, never print the PIN, and never mutate real records (only the explicit write probe and one login session)."""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_hq_diagnostics_http import ADMIN_PIN, SHA, Http, B, D  # noqa: E402

SMOKE = str(Path(__file__).resolve().parents[1] / "tools" / "smoke_deploy.py")


class Smoke(Http):
    def smoke(self, *args: str, pin: str | None = ADMIN_PIN, base: str | None = None):
        env = {k: v for k, v in os.environ.items() if k != "HQ_SMOKE_PIN"}
        if pin is not None:
            env["HQ_SMOKE_PIN"] = pin
        r = subprocess.run([sys.executable, SMOKE, "--base", base or self.base, "--timeout", "10", *args], capture_output=True, text=True, env=env, timeout=120)
        return r.returncode, r.stdout + r.stderr

    def digest(self) -> str:
        h = hashlib.sha256()
        for p in sorted(self.root.rglob("*")):
            if p.is_file() and p.name != "bridge_sessions.json" and "diagnostics" not in p.parts:
                h.update(str(p.relative_to(self.root)).encode() + p.read_bytes())
        return h.hexdigest()

    def seed(self) -> None:
        self.admin.req("/api/carnet")  # normal use creates the notebook
        D.init_identity(self.root, version="7.0", env={"HQ_BUILD_SHA": SHA})
        B._DIAG_STATE["root"] = str(self.root)

    def test_healthy_instance_passes_every_required_check(self):
        self.seed()
        rc, out = self.smoke("--expect-sha", SHA)
        self.assertEqual(rc, 0, out)
        self.assertIn("RESULT: PASS", out)
        for name in ("diagnostics_require_login", "admin_login", "liveness", "legacy_health", "readiness", "expected_sha", "no_restart_pending",
                     "asset hq-carnet.js", "asset hq-carnet.css", "carnet_read", "reader_route", "subsystems", "write_probe", "no_server_errors_during_smoke"):
            self.assertRegex(out, rf"(PASS|WARN) +{name}", name)
        self.assertNotIn("FAIL", out.replace("0 fail", ""))
        self.assertNotIn(ADMIN_PIN, out)

    def test_smoke_does_not_mutate_real_records(self):
        self.seed()
        before = self.digest()
        self.assertEqual(self.smoke("--expect-sha", SHA)[0], 0)
        self.assertEqual(before, self.digest())
        self.assertEqual(list((self.root / ".hq-carnet" / "diagnostics").glob("hq-diag-probe-*")) if (self.root / ".hq-carnet" / "diagnostics").is_dir() else [], [])

    def test_wrong_expected_sha_fails(self):
        self.seed()
        rc, out = self.smoke("--expect-sha", "deadbeefdeadbeef")
        self.assertEqual(rc, 1)
        self.assertRegex(out, r"FAIL +expected_sha")

    def test_unknown_running_build_cannot_satisfy_an_expected_sha(self):
        D.init_identity(self.root, version="7.0", env={})  # temp root is not a checkout: unknown
        B._DIAG_STATE["root"] = str(self.root)
        rc, out = self.smoke("--expect-sha", SHA)
        self.assertEqual(rc, 1)
        self.assertRegex(out, r"FAIL +expected_sha.*matches=None")

    def test_restart_pending_fails(self):
        self.seed()
        with mock.patch.object(D, "read_git_head", return_value=("f8c2ceec5548535f1575fcd7d23d4ca1b5cafd0d", "git_ref")):
            rc, out = self.smoke("--expect-sha", SHA)
        self.assertEqual(rc, 1)
        self.assertRegex(out, r"FAIL +no_restart_pending")

    def test_missing_asset_fails_readiness_and_asset_check(self):
        self.seed()
        target = self.root / "assets" / "hq-carnet.css"
        data = target.read_bytes()
        try:
            target.unlink()
            rc, out = self.smoke("--expect-sha", SHA)
        finally:
            target.write_bytes(data)
        self.assertEqual(rc, 1)
        self.assertRegex(out, r"FAIL +readiness")
        self.assertRegex(out, r"FAIL +asset hq-carnet.css")

    def test_server_error_on_a_critical_path_fails_and_is_reported(self):
        self.seed()
        with mock.patch.object(B.hq_carnet, "http_get", side_effect=RuntimeError("x")):
            rc, out = self.smoke("--expect-sha", SHA)
        self.assertEqual(rc, 1)
        self.assertRegex(out, r"FAIL +carnet_read")
        self.assertRegex(out, r"FAIL +no_server_errors_during_smoke")

    def test_wrong_pin_fails_and_pin_is_never_printed(self):
        rc, out = self.smoke(pin="999999")
        self.assertEqual(rc, 1)
        self.assertRegex(out, r"FAIL +admin_login")
        self.assertNotIn("999999", out)

    def test_usage_and_unreachable_are_exit_2(self):
        self.assertEqual(self.smoke(pin=None)[0], 2)
        self.assertEqual(self.smoke("--expect-sha", "xyz")[0], 2)
        self.assertEqual(self.smoke(base="ftp://x")[0], 2)
        rc, out = self.smoke(base="http://127.0.0.1:9")
        self.assertEqual(rc, 2)
        self.assertIn("reach_bridge", out)

    def test_pin_is_not_accepted_on_the_command_line(self):
        r = subprocess.run([sys.executable, SMOKE, "--pin", "1234"], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
