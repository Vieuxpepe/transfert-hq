"""Phase 15 focused pins: each one reproduces a REAL operational blind spot of 457c665 (they FAIL on that tree) and passes after
Phase 15. Deliberately standalone: no import of hq_diagnostics, so the same file runs unchanged against the untouched baseline.
"""

from __future__ import annotations

import http.cookiejar
import io
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
import iphone_bridge as B  # noqa: E402

SECRET = "S3CR3T-WEBHOOK-TOKEN-0123456789abcdef0123456789abcdef"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Pins(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="p15-pin-"))
        cls.root = cls.tmp / "root"
        cls.root.mkdir()
        for n in ("Inbox", "Uni", "Print"):
            (cls.root / n).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, dict(B.CONFIG))
        B.ROOT, B.SESSIONS_PATH = cls.root, cls.root / "bridge_sessions.json"
        B.CONFIG.update({"pin": "", "discord_webhook_url": SECRET, "push_enabled": False, "users": [{"name": "a", "pin": "424242", "role": "admin"}]})
        B.bind_cc_ext()
        B.bind_hq()

        class Quiet(B.Handler):
            def log_message(self, *_a):
                pass
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.jar = http.cookiejar.CookieJar()
        cls.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cls.jar), NoRedirect)
        try:
            cls.op.open(urllib.request.Request(cls.base + "/login", data=b"pin=424242", method="POST", headers={"Origin": cls.base}))
        except urllib.error.HTTPError as e:
            assert e.code == 303

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        B.ROOT, B.SESSIONS_PATH = cls.saved[0], cls.saved[1]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[2])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path, method="GET", data=None):
        r = urllib.request.Request(self.base + path, data=data, method=method, headers={"Origin": self.base})
        try:
            with self.op.open(r, timeout=20) as resp:
                return resp.status, resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")

    def test_pin1_a_readiness_signal_exists_and_sees_a_missing_asset(self):
        target = self.root / "assets" / "hq-carnet.js"
        data = target.read_bytes()
        try:
            target.unlink()
            st, body = self.get("/api/diag/ready")
            self.assertEqual(st, 503, "blind spot: /api/health stays ok:true with a missing asset and there is no readiness signal")
            self.assertEqual(json.loads(body)["status"], "not_ready")
        finally:
            target.write_bytes(data)

    def test_pin2_build_identity_is_retrievable(self):
        st, body = self.get("/api/diag/info")
        self.assertEqual(st, 200, "blind spot: nothing reports pid / python / uptime / build identity (only a hard-coded version '7.0')")
        self.assertIn("pid", json.loads(body))

    def test_pin3_recent_failures_are_visible(self):
        with mock.patch.object(B.hq_carnet, "http_get", side_effect=RuntimeError("boom")), mock.patch.object(sys, "stderr", io.StringIO()):
            self.get("/api/carnet")
        st, body = self.get("/api/diag/errors")
        self.assertEqual(st, 200, "blind spot: a 500 leaves only a line on a (hidden) console")
        self.assertTrue(json.loads(body)["errors"])

    def test_pin4_500_body_and_console_line_do_not_carry_paths_tokens_or_query_text(self):
        buf = io.StringIO()
        boom = RuntimeError(f"cannot open {self.root}/.hq-carnet/notebook.json token={SECRET}")
        with mock.patch.object(B.hq_carnet, "http_get", side_effect=boom), mock.patch.object(sys, "stderr", buf):
            st, body = self.get("/api/carnet?question=MY-PRIVATE-QUESTION")
        self.assertEqual(st, 500)
        for bad in (SECRET, str(self.root)):
            self.assertNotIn(bad, body, "blind spot: the 500 JSON body echoes the raw exception text")
        for bad in (SECRET, str(self.root), "MY-PRIVATE-QUESTION"):
            self.assertNotIn(bad, buf.getvalue(), "blind spot: the console line echoes the raw query string and exception text")

    def test_pin5_corrupt_config_aborts_visibly(self):
        tmp = Path(tempfile.mkdtemp(prefix="p15-fatal-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        for f in SOURCE.glob("*.py"):
            shutil.copy(f, tmp / f.name)
        (tmp / "bridge_config.json").write_text('{"pin": ', encoding="utf-8")
        r = subprocess.run([sys.executable, str(tmp / "iphone_bridge.py")], cwd=str(tmp), capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue((tmp / "hq-startup-error.txt").is_file(), "blind spot: the abort message exists only in a hidden console")

    def test_pin6_backup_state_is_judged_by_content_not_only_by_volume_presence(self):
        backups = self.tmp / "backups"
        stamp = backups / time.strftime("%Y%m%d_%H%M%S")
        (stamp / "Carnet").mkdir(parents=True)
        (stamp / "Carnet" / "notebook.json").write_text("{corrupt", encoding="utf-8")
        B.CONFIG["backup_dir"] = str(backups)
        st, body = self.get("/api/diag/backup?verify=1")
        self.assertEqual(st, 200, "blind spot: backup health only checks that the volume exists")
        self.assertEqual(json.loads(body)["status"], "error")


if __name__ == "__main__":
    unittest.main()
