"""Accueil « Redémarrer »: restart the bridge from the page (Windows PC only, admin, one request at a time, detached)."""
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import iphone_bridge as b  # noqa: E402


class RestartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "assets").mkdir()
        for f in ("a.py", "assets/x.js"):
            (self.root / f).write_text("x")
        old = time.time() - 3600
        for f in self.root.rglob("*"):
            os.utime(f, (old, old))
        b._RESTART["at"] = 0.0

    def tearDown(self):
        self.tmp.cleanup()
        b._RESTART["at"] = 0.0

    def test_code_newer_than_the_process_means_a_restart_is_due(self):
        started = time.time() - 60
        self.assertFalse(b.bridge_code_changed(self.root, started))
        (self.root / "assets" / "x.js").write_text("y")
        self.assertTrue(b.bridge_code_changed(self.root, started), "an asset changed after the start")
        self.assertFalse(b.bridge_code_changed(self.root / "missing", started))

    def test_boot_revision_is_stable_and_changes_with_content(self):
        paths = ("a.py", "assets/x.js")
        first = b.boot_revision_fingerprint(self.root, paths)
        self.assertEqual(first, b.boot_revision_fingerprint(self.root, paths))
        (self.root / "assets" / "x.js").write_text("changed")
        self.assertNotEqual(first, b.boot_revision_fingerprint(self.root, paths))

    def test_boot_revision_is_embedded_in_the_page(self):
        page = b.render_app().decode("utf-8")
        self.assertIn(f'data-hq-boot-revision="{b._BOOT_REVISION}"', page)
        self.assertIn('meta name="hq-boot-revision"', page)
        self.assertIn("window.HQ_BOOT_REVISION=Object.freeze(", page)
        self.assertIn('id="hq-build-rev"', page)

    def test_only_on_windows_with_the_script(self):
        with mock.patch.object(b, "_is_windows", lambda: False):
            self.assertFalse(b.restart_supported(self.root))
        (self.root / "Restart-Bridge.ps1").write_text("#")
        with mock.patch.object(b, "_is_windows", lambda: True):
            self.assertTrue(b.restart_supported(self.root))
        cmd = b.restart_command(self.root)
        self.assertEqual(cmd[0], "powershell.exe")
        self.assertEqual(cmd[-1], str(self.root / "Restart-Bridge.ps1"))
        self.assertIn("Hidden", cmd)

    def test_one_request_at_a_time(self):
        with mock.patch.object(b, "restart_supported", lambda root=None: True):
            self.assertEqual(b.request_restart(1000.0)[0], 200)
            self.assertEqual(b.request_restart(1010.0)[0], 429, "a second tap during the restart is refused")
            self.assertEqual(b.request_restart(1031.0)[0], 200)
        with mock.patch.object(b, "restart_supported", lambda root=None: False):
            code, out = b.request_restart(5000.0)
            self.assertEqual(code, 501)
            self.assertIn("Windows", out["error"])

    def test_detached_spawn_runs_the_script(self):
        got = []
        b.restart_bridge_detached(spawn=got.append)
        self.assertEqual(got, [b.restart_command()])

    def test_wired_in_the_page_and_routes(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn('id="btn-restart-bridge" hidden', src, "hidden until the server says it is supported")
        self.assertIn('if raw == "/api/pc/restart-bridge":\n            if not self._require_admin():', src, "admin only")
        self.assertIn("api('/api/diag/live')", src, "the page waits for a new process before reloading")
        self.assertIn("boot_revision_status()", src, "live and restart routes expose the loaded revision")


if __name__ == "__main__":
    unittest.main()
