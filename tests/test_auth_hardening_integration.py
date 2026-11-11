"""End-to-end integration test suite for Authentication Hardening & Security Telemetry (Phase 16).

Covers all 4 phases:
1. Stronger session expiration and idle-timeout management
2. Persistent, bounded brute-force protection
3. Strict reverse-proxy, Host, and CSRF-origin validation
4. Structured, privacy-preserving security telemetry
"""

from __future__ import annotations

import http.client
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import hq_diagnostics as D
import hq_security as SEC
import iphone_bridge as bridge


PIN = "test-auth-pin"
ADMIN_PIN = "admin-secret-pin"
UPLOAD_PIN = "upload-secret-pin"


def _http_req(
    port: int,
    path: str,
    method: str = "GET",
    body: bytes | str | None = None,
    headers: dict | None = None,
) -> tuple[int, dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    hdrs = dict(headers or {})
    if "Host" not in hdrs:
        hdrs["Host"] = f"127.0.0.1:{port}"
    if isinstance(body, str):
        body = body.encode("utf-8")
    try:
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, resp_headers, resp.read()
    finally:
        conn.close()


class AuthHardeningIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-auth-e2e-"))
        cls.root = cls.tmp / "root"
        cls.root.mkdir()
        for d in ("Inbox", "Uni", "Print", "assets"):
            (cls.root / d).mkdir(exist_ok=True)
        cls.sessions_path = cls.root / "bridge_sessions.json"
        cls.config_path = cls.tmp / "bridge_config.json"
        cls.config_path.write_text(json.dumps({"pin": ""}), encoding="utf-8")

        cls.saved_state = (
            bridge.ROOT,
            bridge.SESSIONS_PATH,
            bridge.CONFIG_PATH,
            json.loads(json.dumps(bridge.CONFIG)),
            dict(bridge._DIAG_STATE),
        )

        bridge.ROOT = cls.root
        bridge.SESSIONS_PATH = cls.sessions_path
        bridge.CONFIG_PATH = cls.config_path

        bridge.CONFIG.update({
            "pin": "",
            "auth_generation": 1,
            "session_ttl_sec": 86400,
            "admin_session_absolute_sec": 86400,
            "admin_session_idle_sec": 2700,
            "upload_session_absolute_sec": 86400,
            "upload_session_idle_sec": 3600,
            "users": [
                {"name": "admin_user", "pin": ADMIN_PIN, "role": "admin"},
                {"name": "uploader_user", "pin": UPLOAD_PIN, "role": "upload"},
            ],
            "public_base_urls": ["https://vieuxpeepee.taila4d470.ts.net"],
            "trusted_hosts": ["custom.lan"],
        })

        bridge.bind_cc_ext()
        bridge.bind_hq()
        D.ERRORS.clear_for_tests()
        bridge._DIAG_STATE.update(root=None, assets=None, last_probe=None)

        class TestHandler(bridge.Handler):
            def log_message(self, *args):
                pass

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), TestHandler)
        cls.port = cls.httpd.server_address[1]
        cls.base_url = f"http://127.0.0.1:{cls.port}"
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        bridge.ROOT = cls.saved_state[0]
        bridge.SESSIONS_PATH = cls.saved_state[1]
        bridge.CONFIG_PATH = cls.saved_state[2]
        bridge.CONFIG.clear()
        bridge.CONFIG.update(cls.saved_state[3])
        bridge._DIAG_STATE.clear()
        bridge._DIAG_STATE.update(cls.saved_state[4])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS.clear()
        bridge.AUTH_RATE_LIMITER.clear_for_tests()
        D.SECURITY_LOG.clear_for_tests()
        D.ERRORS.clear_for_tests()

    # -------------------------------------------------------------------------
    # PHASE 1: Session Security & Idle Timeout
    # -------------------------------------------------------------------------

    def test_session_policy_enforcement(self) -> None:
        admin_tok = bridge.issue_session("admin_user", "admin")
        upload_tok = bridge.issue_session("uploader_user", "upload")

        admin_rec = bridge._SESSIONS[admin_tok]
        upload_rec = bridge._SESSIONS[upload_tok]

        self.assertEqual(admin_rec["role"], "admin")
        self.assertEqual(upload_rec["role"], "upload")
        self.assertEqual(admin_rec["idle_sec"], 2700.0)
        self.assertEqual(upload_rec["idle_sec"], 3600.0)
        self.assertAlmostEqual(admin_rec["exp"] - admin_rec["created_at"], 86400.0, delta=2.0)

    def test_session_idle_expiration(self) -> None:
        token = bridge.issue_session("admin_user", "admin")
        now = time.time()

        # Simulate 50 minutes of inactivity (idle timeout is 45 min = 2700s)
        synthetic_time = now + 3000.0
        is_valid, reason = SEC.evaluate_session(
            bridge._SESSIONS[token],
            current_gen=1,
            now=synthetic_time,
            touch=False,
        )
        self.assertFalse(is_valid)
        self.assertEqual(reason, "idle_timeout")

    def test_session_absolute_expiration(self) -> None:
        token = bridge.issue_session("admin_user", "admin")
        now = time.time()

        # Simulate 25 hours elapsed (absolute timeout is 24h)
        synthetic_time = now + (25 * 3600.0)
        is_valid, reason = SEC.evaluate_session(
            bridge._SESSIONS[token],
            current_gen=1,
            now=synthetic_time,
            touch=False,
        )
        self.assertFalse(is_valid)
        self.assertEqual(reason, "absolute_timeout")

    def test_activity_touch_does_not_extend_beyond_absolute_expiration(self) -> None:
        token = bridge.issue_session("admin_user", "admin")
        rec = bridge._SESSIONS[token]
        abs_exp = rec["exp"]

        # Touch at time after absolute expiration should be capped at abs_exp
        over_time = abs_exp + 1000.0
        SEC.evaluate_session(rec, current_gen=1, now=over_time, touch=True)
        self.assertLessEqual(rec["last_active"], abs_exp)

    # -------------------------------------------------------------------------
    # PHASE 2: Persistent Bounded Rate Limiting
    # -------------------------------------------------------------------------

    def test_login_rate_limiting_and_retry_after(self) -> None:
        # 12 failed attempts allowed, 13th should be 429
        client_origin = f"http://127.0.0.1:{self.port}"
        for i in range(12):
            st, hdrs, body = _http_req(
                self.port,
                "/login",
                method="POST",
                body=urlencode({"pin": "wrong-pin"}),
                headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": client_origin},
            )
            self.assertEqual(st, 401, f"Attempt {i+1} should fail with 401")

        # 13th attempt should trigger 429
        st, hdrs, body = _http_req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": "wrong-pin"}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": client_origin},
        )
        self.assertEqual(st, 429)
        self.assertIn("retry-after", hdrs)
        retry_val = int(hdrs["retry-after"])
        self.assertGreaterEqual(retry_val, 1)

    def test_successful_login_clears_rate_limit(self) -> None:
        client_origin = f"http://127.0.0.1:{self.port}"
        # A few failed attempts
        for _ in range(3):
            _http_req(
                self.port,
                "/login",
                method="POST",
                body=urlencode({"pin": "wrong-pin"}),
                headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": client_origin},
            )

        # Successful login
        st, hdrs, body = _http_req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": ADMIN_PIN}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": client_origin},
        )
        self.assertEqual(st, 303)
        self.assertIn("set-cookie", hdrs)

    # -------------------------------------------------------------------------
    # PHASE 3: Host Header, Trusted Proxy & CSRF Validation
    # -------------------------------------------------------------------------

    def test_host_header_validation_rejects_untrusted_host(self) -> None:
        # Untrusted external host attempting DNS rebinding
        st, hdrs, body = _http_req(
            self.port,
            "/api/health",
            method="GET",
            headers={"Host": "attacker.evil.com"},
        )
        self.assertEqual(st, 400)

        # Check telemetry event recorded
        tail = D.SECURITY_LOG.tail(10)
        events = [e["event"] for e in tail]
        self.assertIn(SEC.SecurityLog.EVENT_HOST_REJECTED, events)

    def test_host_header_accepts_approved_hosts(self) -> None:
        admin_tok = bridge.issue_session("admin_user", "admin")
        # Loopback with port and authenticated session
        st, hdrs, body = _http_req(
            self.port,
            "/api/health",
            method="GET",
            headers={
                "Host": f"127.0.0.1:{self.port}",
                "Cookie": f"transfert_session={admin_tok}",
            },
        )
        self.assertEqual(st, 200)

        # Unauthenticated request to /login with valid host should return 200 login page (not 400 Host rejected)
        st, hdrs, body = _http_req(
            self.port,
            "/login",
            method="GET",
            headers={"Host": f"localhost:{self.port}"},
        )
        self.assertEqual(st, 200)

    def test_csrf_validation_rejects_cross_origin_state_change(self) -> None:
        st, hdrs, body = _http_req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": ADMIN_PIN}),
            headers={
                "Content-Type": "application/x-www-form-urlencoded",
                "Origin": "http://evil-site.com",
            },
        )
        self.assertEqual(st, 403)

        tail = D.SECURITY_LOG.tail(10)
        events = [e["event"] for e in tail]
        self.assertIn(SEC.SecurityLog.EVENT_CSRF_REJECTED, events)

    def test_trusted_proxy_detection_and_secure_cookie(self) -> None:
        client_origin = "https://vieuxpeepee.taila4d470.ts.net"
        # Request simulating Tailscale Serve reverse proxy over loopback
        st, hdrs, body = _http_req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": ADMIN_PIN}),
            headers={
                "Host": "vieuxpeepee.taila4d470.ts.net",
                "X-Forwarded-Proto": "https",
                "X-Forwarded-Host": "vieuxpeepee.taila4d470.ts.net",
                "Origin": client_origin,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        self.assertEqual(st, 303)
        self.assertIn("set-cookie", hdrs)
        cookie = hdrs["set-cookie"]
        # Must have Secure attribute because it arrived through trusted HTTPS proxy
        self.assertIn("Secure", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Lax", cookie)

    # -------------------------------------------------------------------------
    # PHASE 4: Security Telemetry & Diagnostics Endpoint
    # -------------------------------------------------------------------------

    def test_api_diag_security_access_control_and_structure(self) -> None:
        # 1. Unauthenticated request to /api/diag/security is 401
        st, hdrs, body = _http_req(self.port, "/api/diag/security")
        self.assertEqual(st, 401)

        # 2. Upload role request is 403
        upload_tok = bridge.issue_session("uploader_user", "upload")
        st, hdrs, body = _http_req(
            self.port,
            "/api/diag/security",
            headers={"Cookie": f"transfert_session={upload_tok}"},
        )
        self.assertEqual(st, 403)

        # 3. Admin request is 200
        admin_tok = bridge.issue_session("admin_user", "admin")
        st, hdrs, body = _http_req(
            self.port,
            "/api/diag/security",
            headers={"Cookie": f"transfert_session={admin_tok}"},
        )
        self.assertEqual(st, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertIn("events", data)
        self.assertIn("summary", data)
        self.assertIn("rate_limiter", data)

        # 4. Verify privacy: no raw PIN, secret token, or cookie in events
        events_str = json.dumps(data["events"])
        self.assertNotIn(ADMIN_PIN, events_str)
        self.assertNotIn(UPLOAD_PIN, events_str)
        self.assertNotIn(admin_tok, events_str)

    def test_concurrent_login_rate_limiting(self) -> None:
        """Verify that concurrent login requests cannot defeat the attempt limit."""
        client_origin = f"http://127.0.0.1:{self.port}"
        statuses: list[int] = []
        lock = threading.Lock()

        def _attempt(i: int) -> None:
            st, _, _ = _http_req(
                self.port,
                "/login",
                method="POST",
                body=urlencode({"pin": f"wrong-{i}"}),
                headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": client_origin},
            )
            with lock:
                statuses.append(st)

        # Launch 20 threads simultaneously
        threads = [threading.Thread(target=_attempt, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # At most 12 can be 401; remaining must be 429
        unauth_count = statuses.count(401)
        rate_limited_count = statuses.count(429)
        self.assertEqual(len(statuses), 20)
        self.assertLessEqual(unauth_count, 12)
        self.assertGreaterEqual(rate_limited_count, 8)

    def test_privileged_action_audit_lifecycle(self) -> None:
        """Verify that privileged operations log attempted followed by success or failed."""
        admin_tok = bridge.issue_session("admin_user", "admin")
        client_origin = f"http://127.0.0.1:{self.port}"

        # 1. Successful privileged action (/api/pc/lock)
        import unittest.mock as mock
        with mock.patch("iphone_bridge.pc_lock", return_value=None), mock.patch("iphone_bridge.notify_discord", return_value=None):
            st, _, body = _http_req(
                self.port,
                "/api/pc/lock",
                method="POST",
                body=b"{}",
                headers={
                    "Cookie": f"transfert_session={admin_tok}",
                    "Origin": client_origin,
                    "Content-Type": "application/json",
                },
            )
            self.assertEqual(st, 200)

        # Verify attempted and success logged in order
        tail = D.SECURITY_LOG.tail(10)
        pc_events = [e for e in tail if e.get("event") == SEC.SecurityLog.EVENT_PRIVILEGED_ACTION and e.get("action") == "/api/pc/lock"]
        self.assertGreaterEqual(len(pc_events), 2)
        results = [e.get("result") for e in pc_events]
        self.assertIn("attempted", results)
        self.assertIn("success", results)

        # 2. Failing privileged action (/api/pc/action with invalid payload)
        with mock.patch("iphone_bridge.pc_run_action", side_effect=ValueError("unknown action")):
            st, _, body = _http_req(
                self.port,
                "/api/pc/action",
                method="POST",
                body=json.dumps({"id": "invalid_id"}),
                headers={
                    "Cookie": f"transfert_session={admin_tok}",
                    "Origin": client_origin,
                    "Content-Type": "application/json",
                },
            )
            self.assertEqual(st, 400)

        tail2 = D.SECURITY_LOG.tail(10)
        action_events = [e for e in tail2 if e.get("event") == SEC.SecurityLog.EVENT_PRIVILEGED_ACTION and e.get("action") == "/api/pc/action"]
        self.assertGreaterEqual(len(action_events), 2)
        action_results = [e.get("result") for e in action_events]
        self.assertIn("attempted", action_results)
        self.assertIn("failed", action_results)

    def test_proxy_zero_authorization_guarantee(self) -> None:
        """Verify that arriving via trusted proxy confers zero authorization without valid credentials."""
        proxy_headers = {
            "Host": "vieuxpeepee.taila4d470.ts.net",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "vieuxpeepee.taila4d470.ts.net",
        }

        # 1. Unauthenticated request to protected endpoint via proxy headers is rejected with 401
        st, _, body = _http_req(self.port, "/api/pc/restart-bridge", headers=proxy_headers)
        self.assertEqual(st, 401)

        # 2. POST to protected endpoint without session cookie is 401
        st_post, _, _ = _http_req(
            self.port,
            "/api/pc/lock",
            method="POST",
            body=b"{}",
            headers=dict(proxy_headers, **{"Origin": "https://vieuxpeepee.taila4d470.ts.net", "Content-Type": "application/json"}),
        )
        self.assertEqual(st_post, 401)
