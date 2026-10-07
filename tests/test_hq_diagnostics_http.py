"""Phase 15 — the /api/diag/* and /diagnostics HTTP surface: access control, secrecy, error recording, failure classification.

In-process loopback server on a disposable root with fake PINs (the same arrangement as tests/carnet_test_server.py). Nothing here
touches a live root, the network beyond 127.0.0.1, or the real bridge_config.json.
"""

from __future__ import annotations

import http.cookiejar
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_diagnostics as D  # noqa: E402
import iphone_bridge as B  # noqa: E402

SECRET = "S3CR3T-WEBHOOK-TOKEN-0123456789abcdef0123456789abcdef"
ADMIN_PIN, UPLOAD_PIN = "424242", "111111"
SHA = "457c665a643a737e812423f9922cd6bf33d8ba18"
GET_EPS = ("/api/diag/live", "/api/diag/ready", "/api/diag/info", "/api/diag/subsystems", "/api/diag/backup", "/api/diag/errors")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Client:
    def __init__(self, base: str, pin: str | None) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        self.token = ""
        if pin:
            st, _h, _b = self.req("/login", "POST", ("pin=" + pin).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
            assert st == 303, st
            self.token = next((c.value for c in self.jar), "")

    def req(self, path: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, origin: bool = True):
        h = dict(headers or {})
        if origin:
            h.setdefault("Origin", self.base)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.op.open(r, timeout=20) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def j(self, path: str, method: str = "GET", **kw):
        st, h, b = self.req(path, method, **kw)
        try:
            return st, json.loads(b.decode("utf-8"))
        except ValueError:
            return st, {"_raw": b.decode("utf-8", "replace")}


class Http(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="p15-http-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for n in ("Inbox", "Uni", "Print"):
            (cls.root / n).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.backup_dir = Path(cls.tmp) / "backups"
        cls.backup_dir.mkdir()
        cls.cfg_path = Path(cls.tmp) / "bridge_config.json"
        cls.cfg_path.write_text(json.dumps({"pin": ""}), encoding="utf-8")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG), dict(B._DIAG_STATE))
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = cls.cfg_path
        B.CONFIG.update({
            "pin": "", "discord_webhook_url": SECRET, "push_enabled": False, "backup_dir": str(cls.backup_dir),
            "users": [{"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"}, {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"}],
        })
        B.CONFIG.pop("transcribe_command", None)
        B.bind_cc_ext()
        B.bind_hq()
        D.ERRORS.clear_for_tests()
        B._DIAG_STATE.update(root=None, assets=None, last_probe=None)

        class Quiet(B.Handler):
            def log_message(self, *_a):
                pass

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base, ADMIN_PIN)
        cls.upload = Client(cls.base, UPLOAD_PIN)
        cls.anon = Client(cls.base, None)

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

    def setUp(self) -> None:
        D.ERRORS.clear_for_tests()

    def all_admin_text(self) -> str:
        out = []
        for ep in GET_EPS + ("/diagnostics", "/api/diag/backup?verify=1"):
            out.append(self.admin.req(ep)[2].decode("utf-8", "replace"))
        out.append(self.admin.req("/api/diag/write-probe", "POST", b"{}")[2].decode("utf-8", "replace"))
        return "\n".join(out)


class AccessControl(Http):
    def test_unauthenticated_is_refused_everywhere(self):
        for ep in GET_EPS:
            self.assertEqual(self.anon.req(ep)[0], 401, ep)
        self.assertEqual(self.anon.req("/api/diag/write-probe", "POST", b"{}")[0], 401)
        st, _h, body = self.anon.req("/diagnostics")
        self.assertNotIn(b"hq-diagnostics.js", body)  # the login page, not the diagnostics page

    def test_upload_role_cannot_reach_any_diagnostics(self):
        for ep in GET_EPS:
            self.assertEqual(self.upload.req(ep)[0], 403, ep)
        self.assertEqual(self.upload.req("/diagnostics")[0], 403)
        self.assertEqual(self.upload.req("/api/diag/write-probe", "POST", b"{}")[0], 403)
        self.assertEqual(self.upload.req("/api/diag/backup?verify=1")[0], 403)

    def test_admin_allowed(self):
        for ep in GET_EPS:
            self.assertIn(self.admin.req(ep)[0], (200, 503), ep)
        self.assertEqual(self.admin.req("/diagnostics")[0], 200)

    def test_write_probe_is_post_only_and_csrf_protected(self):
        self.assertEqual(self.admin.req("/api/diag/write-probe")[0], 404)  # GET is not a write
        self.assertEqual(self.admin.req("/api/diag/write-probe", "POST", b"{}", origin=False)[0], 403)
        self.assertEqual(self.admin.req("/api/diag/write-probe", "POST", b"{}", {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(self.admin.req("/api/diag/write-probe", "POST", b"{}")[0], 200)

    def test_unknown_diag_routes_are_404_not_500(self):
        self.assertEqual(self.admin.req("/api/diag/nope")[0], 404)
        self.assertEqual(self.admin.req("/api/diag/", "POST", b"{}")[0], 404)
        self.assertEqual(self.admin.req("/api/diag/write-probe/../x", "POST", b"{}")[0], 404)


class Secrecy(Http):
    def test_no_secret_pin_token_or_full_path_in_any_diagnostics_response(self):
        text = self.all_admin_text()
        for bad in (SECRET, ADMIN_PIN, UPLOAD_PIN, self.admin.token, self.upload.token, str(self.root), self.tmp, str(self.backup_dir)):
            self.assertTrue(bad)
            self.assertNotIn(bad, text)

    def test_cookies_and_headers_are_not_echoed(self):
        self.assertNotIn("Cookie", self.admin.req("/api/diag/info")[2].decode())

    def test_csp_is_unchanged_and_page_has_no_inline_script(self):
        st, h, body = self.admin.req("/diagnostics")
        csp = h.get("Content-Security-Policy", "")
        self.assertIn("default-src 'self'", csp)
        self.assertNotIn("wasm-unsafe-eval", csp)
        self.assertNotIn("unsafe-eval", csp)
        self.assertIn("frame-ancestors 'none'", csp)
        self.assertIsNone(re.search(rb"<script(?![^>]*\bsrc=)[^>]*>", body), "no inline script")

    def test_diagnostics_script_has_no_dynamic_html_eval_network_or_timers(self):
        js = (SOURCE / "assets" / "hq-diagnostics.js").read_text(encoding="utf-8")
        for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "XMLHttpRequest", "WebSocket",
                    "setInterval", "setTimeout", "http://", "https://", "localStorage", "sendBeacon"):
            self.assertNotIn(bad, js, bad)
        self.assertEqual(sorted(set(re.findall(r'api\("(/api/diag/[a-z-]+)', js))), ["/api/diag/backup", "/api/diag/errors", "/api/diag/info", "/api/diag/live", "/api/diag/ready", "/api/diag/subsystems", "/api/diag/write-probe"])

    def test_write_probe_ignores_any_body_and_writes_nowhere_else(self):
        before = sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*"))
        evil = json.dumps({"path": "../../escape.txt", "name": "x/../../y", "root": "/etc"}).encode()
        st, res = self.admin.j("/api/diag/write-probe", "POST", data=evil, headers={"Content-Type": "application/json"})
        self.assertEqual((st, res["status"]), (200, "ok"))
        self.assertEqual(sorted(str(p.relative_to(self.root)) for p in self.root.rglob("*")), before)
        self.assertFalse((Path(self.tmp) / "escape.txt").exists())
        self.assertFalse(any(Path(self.tmp).rglob("y")))


class ErrorRecording(Http):
    def test_exception_is_recorded_with_request_id_and_nothing_sensitive(self):
        boom = RuntimeError(f"cannot open {self.root}/.hq-carnet/notebook.json token={SECRET} a@b.co")
        import io
        buf = io.StringIO()
        with mock.patch.object(B.hq_carnet, "http_get", side_effect=boom), mock.patch.object(sys, "stderr", buf):
            st, body = self.admin.j("/api/carnet?question=MY-PRIVATE-QUESTION&pin=999999")
        self.assertEqual(st, 500)
        # the console / log line (what a visible launch or a redirected stderr would capture) carries neither query text, path nor token
        for bad in (SECRET, "MY-PRIVATE-QUESTION", "999999", str(self.root), "a@b.co"):
            self.assertNotIn(bad, buf.getvalue())
        self.assertIn("GET error /api/carnet #", buf.getvalue())
        rid = body.get("request_id")
        self.assertTrue(rid and re.fullmatch(r"[0-9a-f]{8}", rid))
        # the existing 500 body no longer carries paths / tokens either (Phase 15 scrub)
        for bad in (SECRET, str(self.root), "a@b.co"):
            self.assertNotIn(bad, json.dumps(body))
        st, errs = self.admin.j("/api/diag/errors")
        e = next(x for x in errs["errors"] if x["request_id"] == rid)
        self.assertEqual((e["subsystem"], e["path_category"], e["type"], e["status"]), ("/api/carnet", "/api/carnet", "RuntimeError", 500))
        self.assertTrue(e["trace"])
        blob = json.dumps(errs) + (self.root / ".hq-carnet" / "diagnostics" / "errors.jsonl").read_text(encoding="utf-8")
        for bad in (SECRET, "MY-PRIVATE-QUESTION", "999999", str(self.root), "a@b.co", "question="):
            self.assertNotIn(bad, blob)

    def test_post_body_text_is_never_recorded(self):
        secret_body = json.dumps({"action": "ask", "question": "TOP-SECRET-BODY-TEXT"}).encode()
        with mock.patch.object(B.hq_carnet, "http_post", side_effect=RuntimeError("TOP-SECRET-BODY-TEXT leaked in message")):
            st, _ = self.admin.j("/api/carnet", "POST", data=secret_body, headers={"Content-Type": "application/json"})
        self.assertEqual(st, 500)
        st, errs = self.admin.j("/api/diag/errors")
        # the exception MESSAGE may mention text, so assert the contract that matters: the request body is not captured as such
        self.assertTrue(errs["errors"])
        self.assertNotIn("action", json.dumps(errs))

    def test_5xx_with_fixed_code_is_recorded_by_code_not_message(self):
        with mock.patch.object(B.hq_carnet, "http_get", return_value=(503, {"error": "Écriture du carnet impossible — texte libre", "code": "storage_error"})):
            self.admin.j("/api/carnet")
        e = self.admin.j("/api/diag/errors")[1]["errors"][0]
        self.assertEqual((e["status"], e["code"], e["message"]), (503, "storage_error", "storage_error"))
        self.assertNotIn("texte libre", json.dumps(e))

    def test_4xx_is_not_an_error_record(self):
        self.admin.j("/api/carnet/reader-pdf")  # a structured 4xx refusal is normal operation
        self.assertEqual(self.admin.j("/api/diag/errors")[1]["errors"], [])

    def test_ring_stays_bounded_over_http(self):
        with mock.patch.object(B.hq_carnet, "http_get", side_effect=RuntimeError("x")):
            for _ in range(D.RING_MAX + 25):
                self.admin.req("/api/carnet")
        self.assertEqual(len(self.admin.j("/api/diag/errors?limit=1000")[1]["errors"]), D.RING_MAX)

    def test_diagnostics_internal_exception_answers_500_with_id_and_is_recorded(self):
        with mock.patch.object(D, "liveness", side_effect=RuntimeError("diag bug")):
            st, body = self.admin.j("/api/diag/live")
        self.assertEqual((st, body["error"]), (500, "diagnostic_failed"))
        self.assertTrue(body["request_id"])
        self.assertEqual(self.admin.req("/api/carnet")[0], 200)  # the application itself is unaffected


class HealthAndReadiness(Http):
    def test_legacy_health_contract_is_unchanged(self):
        st, h = self.admin.j("/api/health")
        self.assertEqual(st, 200)
        self.assertTrue(h["ok"])
        for k in ("version", "uptime_sec", "disk_root", "backup", "tailscale", "bridge"):
            self.assertIn(k, h)

    def test_liveness_and_readiness_shapes(self):
        st, lv = self.admin.j("/api/diag/live")
        self.assertEqual((st, lv["status"]), (200, "alive"))
        st, rd = self.admin.j("/api/diag/ready")
        self.assertIn(rd["status"], ("ready", "degraded"))
        self.assertEqual(st, 200)
        self.assertIsInstance(rd["summary"], str)
        for name, c in rd["checks"].items():
            self.assertIn(c["status"], D.STATUSES, name)
            self.assertIn("detail", c)

    def test_missing_asset_turns_readiness_not_ready_with_503_and_names_it(self):
        target = self.root / "assets" / "hq-carnet.js"
        data = target.read_bytes()
        try:
            target.unlink()
            st, rd = self.admin.j("/api/diag/ready")
            self.assertEqual((st, rd["status"]), (503, "not_ready"))
            self.assertEqual(rd["checks"]["static_assets"]["missing"], ["hq-carnet.js"])
            self.assertEqual(self.admin.j("/api/diag/errors")[1]["errors"], [], "the designed 503 of readiness is not an application error")
            self.assertEqual(self.admin.req("/assets/hq-carnet.js")[0], 404)
            st, h = self.admin.j("/api/health")
            self.assertTrue(h["ok"], "documented: the legacy /api/health stays a liveness-style answer; readiness is the new signal")
        finally:
            target.write_bytes(data)
        self.assertEqual(self.admin.j("/api/diag/ready")[0], 200)

    def test_corrupt_config_file_on_disk_makes_readiness_fail(self):
        good = self.cfg_path.read_text(encoding="utf-8")
        try:
            self.cfg_path.write_text("{not json", encoding="utf-8")
            st, rd = self.admin.j("/api/diag/ready")
            self.assertEqual((st, rd["status"], rd["checks"]["config"]["detail"]), (503, "not_ready", "config_file_malformed"))
        finally:
            self.cfg_path.write_text(good, encoding="utf-8")

    def test_data_directory_missing_or_unusable(self):
        dd = self.root / ".hq-carnet"
        existed = dd.exists()
        backup = None
        try:
            if existed:
                backup = Path(self.tmp) / "dd-moved"
                dd.rename(backup)
            dd.write_text("file in the way", encoding="utf-8")
            st, rd = self.admin.j("/api/diag/ready")
            self.assertEqual((st, rd["checks"]["carnet_dir"]["status"]), (503, "unavailable"))
            st, probe = self.admin.j("/api/diag/write-probe", "POST", data=b"{}")
            self.assertEqual((st, probe["status"], probe["failed_step"]), (503, "error", "mkdir"))
            st, errs = self.admin.j("/api/diag/errors")
            self.assertTrue(any(e["subsystem"] == "diagnostics.write_probe" for e in errs["errors"]))
        finally:
            if dd.is_file():
                dd.unlink()
            if backup is not None:
                backup.rename(dd)

    def test_info_identity_and_expected_sha(self):
        D.init_identity(self.root, version="7.0", env={"HQ_BUILD_SHA": SHA})
        B._DIAG_STATE["root"] = str(self.root)
        st, info = self.admin.j("/api/diag/info?expect=" + SHA[:10])
        self.assertTrue(info["expected"]["matches"])
        self.assertFalse(self.admin.j("/api/diag/info?expect=deadbeef")[1]["expected"]["matches"])
        self.assertFalse(self.admin.j("/api/diag/info?expect=%3Cscript%3E")[1]["expected"]["valid"])
        for k in ("build_sha", "python", "platform", "pid", "uptime_sec", "started_at_utc", "root_name", "data_dir", "run_mode", "version", "errors"):
            self.assertIn(k, info)
        self.assertEqual(info["pid"], os.getpid())
        self.assertEqual(info["root_name"], "root")

    def test_subsystems_after_notebook_exists(self):
        self.admin.req("/api/carnet")  # normal use creates the notebook
        st, sub = self.admin.j("/api/diag/subsystems")
        self.assertEqual(st, 200)
        s = sub["subsystems"]
        self.assertEqual((s["carnet_read"]["status"], s["reader"]["status"], s["static_assets"]["status"]), ("ok", "ok", "ok"))
        self.assertEqual(s["transcription"]["status"], "not_configured")
        self.assertEqual(sum(sub["counts"].values()), len(s))

    def test_subsystem_failure_is_visible_over_http(self):
        self.admin.req("/api/carnet")
        with mock.patch.object(B.hq_carnet, "http_get", return_value=(503, {"code": "storage_error"})):
            s = self.admin.j("/api/diag/subsystems")[1]["subsystems"]
        self.assertEqual(s["carnet_read"]["status"], "unavailable")
        with mock.patch.object(B.hq_carnet, "http_reader_pdf", side_effect=RuntimeError("reader down")):
            s = self.admin.j("/api/diag/subsystems")[1]["subsystems"]
        self.assertEqual(s["reader"]["status"], "error")

    def test_backup_endpoint_states(self):
        st, rep = self.admin.j("/api/diag/backup")
        self.assertEqual((rep["status"], rep["detail"]), ("degraded", "no_backups_found"))
        import time as _t
        b = self.backup_dir / _t.strftime("%Y%m%d_%H%M%S", _t.localtime(_t.time() - 3600))
        (b / "Carnet").mkdir(parents=True)
        (b / "Carnet" / "notebook.json").write_text("{broken", encoding="utf-8")
        try:
            self.assertEqual(self.admin.j("/api/diag/backup")[1]["status"], "ok")
            v = self.admin.j("/api/diag/backup?verify=1")[1]
            self.assertEqual((v["status"], v["verified"]["carnet_notebook"]), ("error", "json_corrupt"))
            shutil.rmtree(b)
            shutil.rmtree(self.backup_dir)
            self.assertEqual(self.admin.j("/api/diag/backup")[1]["status"], "unavailable")
        finally:
            self.backup_dir.mkdir(exist_ok=True)
            shutil.rmtree(b, ignore_errors=True)


class AccessLog(Http):
    """Phase 15 review fix: the ordinary HTTP access log must not retain query strings (literal or percent-encoded)."""

    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        # The shared server above uses a silenced Handler subclass; the access log is only exercised on the REAL Handler.
        cls.httpd2 = ThreadingHTTPServer(("127.0.0.1", 0), B.Handler)
        cls.base = f"http://127.0.0.1:{cls.httpd2.server_address[1]}"
        threading.Thread(target=cls.httpd2.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base, ADMIN_PIN)
        cls.anon = Client(cls.base, None)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd2.shutdown()
        cls.httpd2.server_close()
        super().tearDownClass()

    SENT = "QSENTINEL-9f3a1c"
    ENC = "%51%53%45%4e%54%49%4e%45%4c-ENC%2Dd00d"      # decodes to QSENTINEL-ENC-d00d

    def _capture(self, fn):
        import io
        import time
        buf = io.StringIO()
        with mock.patch.object(sys, "stderr", buf):
            fn()
            time.sleep(0.3)          # handler threads write after responding
        return buf.getvalue()

    def test_literal_and_encoded_query_values_never_reach_the_access_log(self):
        def go():
            self.admin.req("/api/diag/info?expect=" + self.SENT)
            self.admin.req("/api/carnet?question=" + self.SENT + "&x=" + self.ENC)
            self.admin.req("/api/diag/errors?limit=1&q=" + self.ENC)
            self.admin.req("/api/health?token=" + self.SENT + "#frag" + self.SENT)
            self.anon.req("/login?next=" + self.SENT)
        out = self._capture(go)
        for bad in (self.SENT, self.ENC, "QSENTINEL", "ENC%2D", "d00d", "expect=", "question=", "frag"):
            self.assertNotIn(bad, out)

    def test_access_log_is_not_suppressed_it_keeps_method_path_and_status(self):
        out = self._capture(lambda: self.admin.req("/api/diag/live?a=" + self.SENT))
        line = next((l for l in out.splitlines() if "/api/diag/live" in l), "")
        self.assertTrue(line, out)
        self.assertIn("GET /api/diag/live", line)
        self.assertRegex(line, r'" 200 ')
        self.assertIn("127.0.0.1", line)

    def test_malformed_request_line_with_a_query_is_not_echoed(self):
        import socket
        host, port = self.base.replace("http://", "").split(":")

        def go():
            for raw in (b"GET /x?" + self.SENT.encode() + b" is bad HTTP/1.1 extra\r\n\r\n", b"GET /y?" + self.SENT.encode() + b"\r\n\r\n"):
                with socket.create_connection((host, int(port)), timeout=5) as c:
                    c.sendall(raw)
                    try:
                        c.recv(4096)
                    except OSError:
                        pass
        out = self._capture(go)
        self.assertNotIn(self.SENT, out)

    def test_log_message_unit_and_control_characters(self):
        h = B.Handler.__new__(B.Handler)
        h.client_address = ("127.0.0.1", 1)
        import io
        buf = io.StringIO()
        with mock.patch.object(sys, "stderr", buf):
            h.log_message('"%s" %s %s', "GET /a?b=" + self.SENT + " HTTP/1.1", "200", "-")
            h.log_message("Bad request syntax (%r)", "GET /a?" + self.SENT + " x y z")
            h.log_message("msg %s", "line1\nFORGED 200\x00x")
        out = buf.getvalue()
        self.assertNotIn(self.SENT, out)
        self.assertIn("GET /a?<q> HTTP/1.1", out)
        self.assertEqual(len(out.strip().splitlines()), 3)


class BuildIdentityAtLoad(unittest.TestCase):
    def test_identity_is_captured_when_the_module_loads_not_at_first_request(self):
        env = dict(os.environ, HQ_BUILD_SHA=SHA)
        r = subprocess.run([sys.executable, "-c", "import iphone_bridge, hq_diagnostics as D; i = D.identity(); print(i['build_sha'], i['build_sha_source'])"],
                           cwd=str(SOURCE), capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.stdout.strip(), SHA + " env", r.stderr[-300:])

    def test_a_moved_head_is_reported_as_restart_pending_not_as_the_running_build(self):
        co = Path(tempfile.mkdtemp(prefix="p15-head-"))
        self.addCleanup(shutil.rmtree, co, ignore_errors=True)
        (co / ".git" / "refs" / "heads").mkdir(parents=True)
        (co / ".git" / "HEAD").write_text("ref: refs/heads/main\n")
        (co / ".git" / "refs" / "heads" / "main").write_text(SHA + "\n")
        D.init_identity(co, version="7.0", env={})
        (co / ".git" / "refs" / "heads" / "main").write_text("f8c2ceec5548535f1575fcd7d23d4ca1b5cafd0d\n")  # a pull while running
        info = D.identity(co)
        self.assertEqual((info["build_sha"], info["restart_pending"]), (SHA, True))


class StartupFatal(unittest.TestCase):
    """A malformed bridge_config.json aborts startup; before Phase 15 that was visible only in a hidden console."""

    def test_malformed_config_leaves_a_scrubbed_note_and_exits_nonzero(self):
        tmp = Path(tempfile.mkdtemp(prefix="p15-fatal-"))
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        for f in SOURCE.glob("*.py"):
            shutil.copy(f, tmp / f.name)
        (tmp / "bridge_config.json").write_text('{"discord_webhook_url": "' + SECRET + '", "pin": ', encoding="utf-8")
        r = subprocess.run([sys.executable, str(tmp / "iphone_bridge.py")], cwd=str(tmp), capture_output=True, text=True, timeout=60)
        self.assertNotEqual(r.returncode, 0)
        note = tmp / D.STARTUP_FATAL_NAME
        self.assertTrue(note.is_file(), r.stderr[-300:])
        txt = note.read_text(encoding="utf-8")
        self.assertIn("malformed", txt)
        self.assertNotIn(SECRET, txt)
        self.assertNotIn(str(tmp), txt)
        self.assertLess(len(txt), 700)
        self.assertEqual(D.startup_fatal(tmp)["message"][:5], "FATAL")


if __name__ == "__main__":
    unittest.main()
