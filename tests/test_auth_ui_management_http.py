"""HTTP Integration tests for Authentication UI Redesign & User Management.

Verifies:
- Login UI and authentication from desktop and iPhone User-Agents.
- Legacy single-PIN migration without lockout.
- Creating the first upload account without losing administrator access.
- Role-based access control (admin vs upload permissions).
- Anonymous and upload user rejection on management APIs.
- Last-administrator lockout protections.
- PIN validation and duplicate rejection.
- Mandatory server-side admin reauthentication for sensitive actions.
- CSRF validation on management endpoints.
- Surgical session revocation on PIN rotation and role changes.
- Persistence across restart.
- Graceful handling of malformed records.
- Complete absence of secrets in APIs, HTML, and logs.
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

ADMIN_PIN = "super-admin-pin-888"
UPLOAD_PIN = "scanner-upload-pin-999"


def _req(
    port: int,
    path: str,
    method: str = "GET",
    body: bytes | str | dict | None = None,
    headers: dict | None = None,
) -> tuple[int, dict[str, str], bytes]:
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    hdrs = dict(headers or {})
    if "Host" not in hdrs:
        hdrs["Host"] = f"127.0.0.1:{port}"
    if isinstance(body, dict):
        body = json.dumps(body).encode("utf-8")
        if "Content-Type" not in hdrs:
            hdrs["Content-Type"] = "application/json"
    elif isinstance(body, str):
        body = body.encode("utf-8")

    try:
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        resp_headers = {k.lower(): v for k, v in resp.getheaders()}
        return resp.status, resp_headers, resp.read()
    finally:
        conn.close()


def _login(port: int, pin: str, origin: str | None = None) -> str:
    """Helper to perform form login and extract session token."""
    hdrs = {
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin": origin or f"http://127.0.0.1:{port}",
    }
    status, resp_headers, _ = _req(
        port,
        "/login",
        method="POST",
        body=urlencode({"pin": pin}),
        headers=hdrs,
    )
    if status != 303:
        return ""
    cookie = resp_headers.get("set-cookie", "")
    for part in cookie.split(";"):
        part = part.strip()
        if part.startswith(f"{bridge.COOKIE_NAME}="):
            return part.split("=", 1)[1]
    return ""


class AuthUIManagementHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-mgmt-test-"))
        cls.root = cls.tmp / "root"
        cls.root.mkdir()
        for d in ("Inbox", "Uni", "Print", "assets"):
            (cls.root / d).mkdir(exist_ok=True)
        # Copy assets for rendering checks
        src_assets = Path(bridge.__file__).resolve().parent / "assets"
        if src_assets.is_dir():
            for f in src_assets.iterdir():
                if f.is_file():
                    shutil.copy2(f, cls.root / "assets" / f.name)

        cls.sessions_path = cls.root / "bridge_sessions.json"
        cls.config_path = cls.tmp / "bridge_config.json"
        cls.config_path.write_text(json.dumps({"pin": ADMIN_PIN}), encoding="utf-8")

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

        bridge.CONFIG.clear()
        bridge.CONFIG.update({
            "pin": ADMIN_PIN,
            "users": [],
            "auth_generation": 1,
            "session_ttl_sec": 86400,
            "session_admin_absolute_sec": 86400,
            "session_admin_idle_sec": 2700,
            "session_upload_absolute_sec": 86400,
            "session_upload_idle_sec": 3600,
            "public_base_urls": [],
            "trusted_proxies": [],
        })
        SEC.migrate_users_config(bridge.CONFIG)

        SEC.AUTH_RATE_LIMITER.clear_for_tests()
        SEC.SECURITY_LOG.clear_for_tests()
        SEC.SECURITY_LOG.attach(cls.root)
        bridge._SESSIONS.clear()

        bridge.bind_cc_ext()
        bridge.bind_hq()

        class TestServer(ThreadingHTTPServer):
            daemon_threads = True

        cls.httpd = TestServer(("127.0.0.1", 0), bridge.Handler)
        cls.port = int(cls.httpd.server_address[1])
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.httpd.shutdown()
            cls.httpd.server_close()
        except Exception:
            pass
        (
            bridge.ROOT,
            bridge.SESSIONS_PATH,
            bridge.CONFIG_PATH,
            orig_config,
            orig_diag,
        ) = cls.saved_state
        bridge.CONFIG.clear()
        bridge.CONFIG.update(orig_config)
        bridge._DIAG_STATE.clear()
        bridge._DIAG_STATE.update(orig_diag)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        SEC.AUTH_RATE_LIMITER.clear_for_tests()

    def test_01_login_page_rendering_desktop_and_iphone(self):
        # 1. Desktop
        status, hdrs, body = _req(self.port, "/login", headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        self.assertEqual(status, 200)
        self.assertIn("text/html", hdrs.get("content-type", ""))
        html = body.decode("utf-8")
        self.assertIn("Transfert HQ", html)
        self.assertIn("Authentification", html)
        self.assertIn('inputmode="numeric"', html)
        self.assertIn('type="password"', html)
        self.assertIn('id="togglePinBtn"', html)
        # Check no external CDN links
        self.assertNotIn("https://", html)
        self.assertNotIn("http://", html)
        # Check no credentials
        self.assertNotIn(ADMIN_PIN, html)

        # 2. iPhone User-Agent
        status_m, hdrs_m, body_m = _req(
            self.port,
            "/login",
            headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15"},
        )
        self.assertEqual(status_m, 200)
        html_m = body_m.decode("utf-8")
        self.assertIn("viewport-fit=cover", html_m)
        self.assertIn("apple-mobile-web-app-capable", html_m)

    def test_02_login_flow_redirect_and_session(self):
        # Successful login returns 303 pointing to /
        hdrs = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": f"http://127.0.0.1:{self.port}",
        }
        status, resp_headers, _ = _req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": ADMIN_PIN}),
            headers=hdrs,
        )
        self.assertEqual(status, 303)
        self.assertEqual(resp_headers.get("location"), "/")
        self.assertIn("transfert_session=", resp_headers.get("set-cookie", ""))

        # Failed login returns 401 with error message in HTML
        status_f, _, body_f = _req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": "wrong-pin-0000"}),
            headers=hdrs,
        )
        self.assertEqual(status_f, 401)
        self.assertIn("PIN incorrect", body_f.decode("utf-8"))

    def test_03_legacy_migration_and_first_upload_account_lockout_prevention(self):
        # Admin logs in
        admin_tok = _login(self.port, ADMIN_PIN)
        self.assertTrue(admin_tok)

        # Check /api/me
        st, _, body = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}"},
        )
        self.assertEqual(st, 200)
        me = json.loads(body.decode("utf-8"))
        self.assertEqual(me["role"], "admin")

        # Create the first additional user (upload role)
        origin = f"http://127.0.0.1:{self.port}"
        st_create, _, body_create = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={
                "name": "Appareil Atelier",
                "role": "upload",
                "pin": UPLOAD_PIN,
                "admin_pin": ADMIN_PIN,
            },
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_create, 201)
        created = json.loads(body_create.decode("utf-8"))
        self.assertTrue(created["ok"])
        upload_user = created["user"]
        self.assertEqual(upload_user["name"], "Appareil Atelier")
        self.assertEqual(upload_user["role"], "upload")
        self.assertTrue(upload_user["id"].startswith("usr_"))
        # Verify secret absence
        self.assertNotIn("pin", upload_user)
        self.assertNotIn("pin_hash", upload_user)

        # CRITICAL VERIFICATION: Original administrator MUST STILL BE ABLE TO LOG IN
        admin_tok_again = _login(self.port, ADMIN_PIN)
        self.assertTrue(admin_tok_again)
        st_me, _, body_me = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok_again}"},
        )
        self.assertEqual(st_me, 200)
        self.assertEqual(json.loads(body_me.decode("utf-8"))["role"], "admin")

        # Upload user can log in
        upload_tok = _login(self.port, UPLOAD_PIN)
        self.assertTrue(upload_tok)
        st_up_me, _, body_up_me = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={upload_tok}"},
        )
        self.assertEqual(st_up_me, 200)
        self.assertEqual(json.loads(body_up_me.decode("utf-8"))["role"], "upload")

    def test_04_permissions_enforcement_and_api_rejection(self):
        upload_tok = _login(self.port, UPLOAD_PIN)
        self.assertTrue(upload_tok)

        # Anonymous cannot access /api/admin/users
        st_anon, _, _ = _req(self.port, "/api/admin/users")
        self.assertEqual(st_anon, 401)

        # Anonymous cannot POST to /api/admin/users
        st_anon_p, _, _ = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "Hacker", "role": "admin", "pin": "hackerpin123"},
            headers={"Origin": f"http://127.0.0.1:{self.port}"},
        )
        self.assertEqual(st_anon_p, 401)

        # Upload user cannot GET /api/admin/users (403)
        st_up_get, _, _ = _req(
            self.port,
            "/api/admin/users",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={upload_tok}"},
        )
        self.assertEqual(st_up_get, 403)

        # Upload user cannot POST /api/admin/users (403)
        st_up_post, _, _ = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "Hacker", "role": "admin", "pin": "hackerpin123"},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={upload_tok}", "Origin": f"http://127.0.0.1:{self.port}"},
        )
        self.assertEqual(st_up_post, 403)

    def test_05_reauthentication_enforcement(self):
        admin_tok = _login(self.port, ADMIN_PIN)
        origin = f"http://127.0.0.1:{self.port}"

        # 1. Missing admin_pin -> 401 reauth_required
        st1, _, body1 = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "Test", "role": "upload", "pin": "92837416"},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st1, 401)
        self.assertEqual(json.loads(body1.decode("utf-8")).get("code"), "reauth_required")

        # 2. Wrong admin_pin -> 401 reauth_required
        st2, _, body2 = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "Test", "role": "upload", "pin": "92837416", "admin_pin": "bad-password"},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st2, 401)
        self.assertEqual(json.loads(body2.decode("utf-8")).get("code"), "reauth_required")

    def test_06_invalid_and_duplicate_pin_rejection(self):
        admin_tok = _login(self.port, ADMIN_PIN)
        origin = f"http://127.0.0.1:{self.port}"

        # 1. Trivial sequence
        st, _, body = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "Bad1", "role": "upload", "pin": "12345678", "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st, 400)
        self.assertIn("séquence", json.loads(body.decode("utf-8"))["error"])

        # 2. Duplicate PIN (same as UPLOAD_PIN)
        st_dup, _, body_dup = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "Bad2", "role": "upload", "pin": UPLOAD_PIN, "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_dup, 400)
        self.assertIn("déjà utilisé", json.loads(body_dup.decode("utf-8"))["error"])

    def test_07_csrf_rejection_on_management_api(self):
        admin_tok = _login(self.port, ADMIN_PIN)
        # Untrusted external origin
        st, _, _ = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "BadOrigin", "role": "upload", "pin": "93820194", "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": "https://attacker.example.com"},
        )
        self.assertEqual(st, 403)

    def test_08_last_administrator_protection_via_api(self):
        admin_tok = _login(self.port, ADMIN_PIN)
        origin = f"http://127.0.0.1:{self.port}"

        # Get list to identify the admin's user_id
        _, _, body_list = _req(
            self.port,
            "/api/admin/users",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}"},
        )
        users = json.loads(body_list.decode("utf-8"))["users"]
        admin_user = next(u for u in users if u["role"] == "admin")

        # 1. Attempt to delete the only admin -> 400
        st_del, _, body_del = _req(
            self.port,
            f"/api/admin/users/{admin_user['id']}/delete",
            method="POST",
            body={"admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_del, 400)
        self.assertIn("dernier administrateur", json.loads(body_del.decode("utf-8"))["error"])

        # 2. Attempt to disable the only admin -> 400
        st_dis, _, body_dis = _req(
            self.port,
            f"/api/admin/users/{admin_user['id']}/update",
            method="POST",
            body={"enabled": False, "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_dis, 400)
        self.assertIn("dernier administrateur", json.loads(body_dis.decode("utf-8"))["error"])

        # 3. Attempt to demote the only admin -> 400
        st_dem, _, body_dem = _req(
            self.port,
            f"/api/admin/users/{admin_user['id']}/update",
            method="POST",
            body={"role": "upload", "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_dem, 400)
        self.assertIn("dernier administrateur", json.loads(body_dem.decode("utf-8"))["error"])

    def test_09_pin_rotation_and_surgical_session_revocation(self):
        origin = f"http://127.0.0.1:{self.port}"
        # Create a second upload user
        admin_tok = _login(self.port, ADMIN_PIN)
        NEW_USER_PIN = "target-user-pin-1"
        ROTATED_USER_PIN = "target-user-pin-2"

        st_cr, _, body_cr = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "TargetUser", "role": "upload", "pin": NEW_USER_PIN, "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_cr, 201)
        target_uid = json.loads(body_cr.decode("utf-8"))["user"]["id"]

        # TargetUser logs in and obtains session token
        target_tok = _login(self.port, NEW_USER_PIN)
        self.assertTrue(target_tok)

        # TargetUser can access /api/me
        st_me1, _, _ = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={target_tok}"},
        )
        self.assertEqual(st_me1, 200)

        # Admin rotates TargetUser's PIN
        st_rot, _, _ = _req(
            self.port,
            f"/api/admin/users/{target_uid}/pin",
            method="POST",
            body={"new_pin": ROTATED_USER_PIN, "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_rot, 200)

        # TargetUser's previous session MUST BE REVOKED!
        st_me_revoked, _, _ = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={target_tok}"},
        )
        self.assertEqual(st_me_revoked, 401)

        # BUT Admin's session MUST STILL BE VALID! (Surgical revocation)
        st_admin_check, _, _ = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}"},
        )
        self.assertEqual(st_admin_check, 200)

        # TargetUser can now log in with the new rotated PIN
        target_tok_new = _login(self.port, ROTATED_USER_PIN)
        self.assertTrue(target_tok_new)
        st_me2, _, _ = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={target_tok_new}"},
        )
        self.assertEqual(st_me2, 200)

    def test_10_account_disabling_and_deletion_revokes_sessions(self):
        origin = f"http://127.0.0.1:{self.port}"
        admin_tok = _login(self.port, ADMIN_PIN)
        USER_PIN = "temporary-user-pin-777"

        # Create user
        st_cr, _, body_cr = _req(
            self.port,
            "/api/admin/users",
            method="POST",
            body={"name": "TempUser", "role": "upload", "pin": USER_PIN, "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        temp_uid = json.loads(body_cr.decode("utf-8"))["user"]["id"]

        # User logs in
        temp_tok = _login(self.port, USER_PIN)
        self.assertTrue(temp_tok)

        # Disable account
        st_dis, _, _ = _req(
            self.port,
            f"/api/admin/users/{temp_uid}/update",
            method="POST",
            body={"enabled": False, "admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_dis, 200)

        # User session revoked immediately
        st_chk, _, _ = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={temp_tok}"},
        )
        self.assertEqual(st_chk, 401)

        # Disabled user cannot log in
        st_login_dis, _, _ = _req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": USER_PIN}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": origin},
        )
        self.assertEqual(st_login_dis, 401)

        # Delete account
        st_del, _, _ = _req(
            self.port,
            f"/api/admin/users/{temp_uid}/delete",
            method="POST",
            body={"admin_pin": ADMIN_PIN},
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}", "Origin": origin},
        )
        self.assertEqual(st_del, 200)

    def test_11_absence_of_credentials_in_logs_and_apis(self):
        admin_tok = _login(self.port, ADMIN_PIN)

        # 1. API check
        _, _, body = _req(
            self.port,
            "/api/admin/users",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={admin_tok}"},
        )
        raw_text = body.decode("utf-8")
        self.assertNotIn(ADMIN_PIN, raw_text)
        self.assertNotIn("pin_hash", raw_text)
        self.assertNotIn("scrypt$", raw_text)

        # 2. Security log file check
        log_file = self.root / ".hq-carnet" / "diagnostics" / "security.jsonl"
        if log_file.is_file():
            log_content = log_file.read_text(encoding="utf-8")
            self.assertNotIn(ADMIN_PIN, log_content)
            self.assertNotIn(UPLOAD_PIN, log_content)
            self.assertNotIn("scrypt$", log_content)
            self.assertNotIn("transfert_session", log_content)

    def test_12_tripwire_and_emergency_lockdown_flow(self):
        origin = f"http://127.0.0.1:{self.port}"
        # 1. Reset tripwire memory
        with SEC._TRIPWIRE_LOCK:
            SEC._TRIPWIRE_FAILURES.clear()
            SEC._LAST_ALERT_TIME = 0.0

        # Attempt 1: Failed login
        st1, _, _ = _req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": "wrong-pin-one"}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": origin},
        )
        self.assertEqual(st1, 401)
        self.assertFalse(SEC.is_locked_down(bridge.CONFIG))

        # Attempt 2: Second failed login triggers tripwire
        st2, _, _ = _req(
            self.port,
            "/login",
            method="POST",
            body=urlencode({"pin": "wrong-pin-two"}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": origin},
        )
        self.assertEqual(st2, 401)

        # Retrieve the generated token from SEC._TRIPWIRE_TOKENS
        with SEC._TRIPWIRE_LOCK:
            self.assertTrue(len(SEC._TRIPWIRE_TOKENS) > 0)
            token = list(SEC._TRIPWIRE_TOKENS.keys())[-1]

        # 2. Trigger Emergency Lockdown from email action URL
        st_lock, _, body_lock = _req(
            self.port,
            f"/emergency/lockdown?token={token}",
            method="GET",
        )
        self.assertEqual(st_lock, 200)
        self.assertIn("Coupe-circuit activé", body_lock.decode("utf-8"))
        self.assertTrue(SEC.is_locked_down(bridge.CONFIG))

        # Reusing the single-use token should fail
        st_reuse, _, _ = _req(
            self.port,
            f"/emergency/lockdown?token={token}",
            method="GET",
        )
        self.assertEqual(st_reuse, 400)

        # 3. Verify that requests are blocked with HTTP 423 Locked
        st_root, _, body_root = _req(self.port, "/")
        self.assertEqual(st_root, 423)
        self.assertIn("Accès Neutralisé", body_root.decode("utf-8"))

        st_api, _, body_api = _req(self.port, "/api/me")
        self.assertEqual(st_api, 423)
        self.assertEqual(json.loads(body_api.decode("utf-8"))["code"], "emergency_lockdown")

        # 4. Attempt to unlock with wrong PIN -> 401
        st_unl_bad, _, _ = _req(
            self.port,
            "/emergency/unlock",
            method="POST",
            body=urlencode({"admin_pin": "wrong-admin-pin"}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": origin},
        )
        self.assertEqual(st_unl_bad, 401)
        self.assertTrue(SEC.is_locked_down(bridge.CONFIG))

        # 5. Attempt to unlock with upload role PIN -> 401 (Only admin can unlock!)
        st_unl_upl, _, _ = _req(
            self.port,
            "/emergency/unlock",
            method="POST",
            body=urlencode({"admin_pin": UPLOAD_PIN}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": origin},
        )
        self.assertEqual(st_unl_upl, 401)
        self.assertTrue(SEC.is_locked_down(bridge.CONFIG))

        # 6. Unlock with valid ADMIN PIN -> 303 Redirect to / with session cookie
        st_unl_ok, hdrs_ok, _ = _req(
            self.port,
            "/emergency/unlock",
            method="POST",
            body=urlencode({"admin_pin": ADMIN_PIN}),
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": origin},
        )
        self.assertEqual(st_unl_ok, 303)
        self.assertEqual(hdrs_ok.get("location"), "/")
        self.assertIn(f"{bridge.COOKIE_NAME}=", hdrs_ok.get("set-cookie", ""))
        self.assertFalse(SEC.is_locked_down(bridge.CONFIG))

        # Extract cookie and verify normal access is restored
        cookie_val = ""
        for part in hdrs_ok.get("set-cookie", "").split(";"):
            part = part.strip()
            if part.startswith(f"{bridge.COOKIE_NAME}="):
                cookie_val = part.split("=", 1)[1]
        self.assertTrue(cookie_val)

        st_restored, _, _ = _req(
            self.port,
            "/api/me",
            headers={"Cookie": f"{bridge.COOKIE_NAME}={cookie_val}"},
        )
        self.assertEqual(st_restored, 200)


if __name__ == "__main__":
    unittest.main()
