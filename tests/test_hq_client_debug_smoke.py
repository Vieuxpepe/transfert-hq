"""Smoke test: client-log ingest + session-bundle + client-log tail (in-process test server)."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_diagnostics as D  # noqa: E402
import iphone_bridge as B  # noqa: E402
from scripts.fetch_session_bundle import fetch_bundle  # noqa: E402
from tests.test_hq_diagnostics_http import ADMIN_PIN, Client, NoRedirect  # noqa: E402


class ClientDebugSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="hq-clog-smoke-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for n in ("Inbox", "Uni", "Print"):
            (cls.root / n).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG), dict(B._DIAG_STATE))
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = Path(cls.tmp) / "bridge_config.json"
        B.CONFIG_PATH.write_text(json.dumps({"pin": ""}), encoding="utf-8")
        B.CONFIG.update(
            {
                "pin": "",
                "users": [{"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"}],
                "client_debug_hud": True,
            }
        )
        B.bind_cc_ext()
        B.bind_hq()
        D.CLIENT_LOG.clear_for_tests()
        D.ERRORS.clear_for_tests()
        B._DIAG_STATE.update(root=None, assets=None, last_probe=None)

        class Quiet(B.Handler):
            def log_message(self, *_a):
                pass

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base, ADMIN_PIN)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH = cls.saved[0], cls.saved[1], cls.saved[2]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[3])
        B._DIAG_STATE.clear()
        B._DIAG_STATE.update(cls.saved[4])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_session_bundle_and_client_log_tail(self):
        body = json.dumps(
            {
                "page": "/",
                "view": "accueil",
                "session_id": "abc123",
                "entries": [
                    {
                        "level": "info",
                        "kind": "view",
                        "message": "view change accueil → carnet",
                        "view": "carnet",
                        "session_id": "abc123",
                        "data": {"from": "accueil", "to": "carnet"},
                    }
                ],
            }
        ).encode()
        st, rep = self.admin.j(
            "/api/hq/client-log",
            "POST",
            data=body,
            headers={"Content-Type": "application/json"},
        )
        self.assertEqual(st, 200, rep)
        self.assertEqual(rep.get("accepted"), 1)

        st, bundle = self.admin.j("/api/diag/session-bundle?limit=10")
        self.assertEqual(st, 200, bundle)
        self.assertIn("client_log", bundle)
        self.assertIn("redaction", bundle)
        self.assertIn("agent_triage", bundle)
        self.assertIn("timeline", bundle)
        self.assertEqual(set(bundle["agent_triage"].keys()), D.AGENT_TRIAGE_KEYS)
        self.assertTrue(any("carnet" in str(x.get("message", "")) for x in bundle.get("client_log") or []))

        st, brief = self.admin.j("/api/diag/agent-brief?limit=10")
        self.assertEqual(st, 200, brief)
        self.assertEqual(set(brief.keys()), D.AGENT_BRIEF_KEYS)
        self.assertIn("brief_md", brief)
        self.assertEqual(bundle["agent_triage"], brief["agent_triage"])
        self.assertEqual(bundle["timeline"], brief["timeline"])
        self.assertTrue(brief["agent_triage"].get("capture_ok"))

        st, tail = self.admin.j("/api/diag/client-log?limit=5")
        self.assertEqual(st, 200, tail)
        self.assertTrue(tail.get("lines"))

    def test_diagnostic_cli_accepts_expected_login_redirect(self):
        brief = fetch_bundle(self.base, ADMIN_PIN, 5, brief=True)
        self.assertEqual(set(brief.keys()), D.AGENT_BRIEF_KEYS)


if __name__ == "__main__":
    unittest.main()
