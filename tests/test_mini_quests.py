"""Mini-Quêtes: unit + bridge HTTP (auth, CSRF, validation, concurrency, logging, no busy-wait)."""

from __future__ import annotations

import http.cookiejar
import json
import os
import re
import shutil
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
import mini_quests as mq  # noqa: E402

ADMIN_PIN, UPLOAD_PIN = "424242", "111111"
SECRET = "S3CR3T-WEBHOOK-TOKEN-0123456789abcdef0123456789abcdef"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Client:
    def __init__(self, base: str, pin: str | None) -> None:
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        if pin:
            st, _h, _b = self.req(
                "/login",
                "POST",
                ("pin=" + pin).encode(),
                {"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert st == 303, st

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

    def j(self, path: str, method: str = "GET", data: dict | None = None, **kw):
        body = None
        headers = dict(kw.pop("headers", {}) or {})
        if data is not None:
            body = json.dumps(data).encode("utf-8")
            headers.setdefault("Content-Type", "application/json")
        st, h, b = self.req(path, method, body, headers, **kw)
        try:
            return st, json.loads(b.decode("utf-8"))
        except ValueError:
            return st, {"_raw": b.decode("utf-8", "replace")}


class UnitQuests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="mq-unit-")
        self.root = Path(self.tmp.name)
        mq.reset_for_tests()
        self.slept: list[float] = []
        mq.bind(root=self.root, now=lambda: 1_800_000_000.0, sleep=lambda s: self.slept.append(float(s)))

    def tearDown(self) -> None:
        mq.reset_for_tests()
        self.tmp.cleanup()

    def test_no_busy_wait_in_source(self):
        self.assertFalse(mq.source_has_busy_wait())
        text = Path(mq.__file__).read_text(encoding="utf-8")
        self.assertNotRegex(text, r"while\s+time\.time\s*\(\s*\)\s*<\s*end")

    def test_simmer_uses_sleep_not_spin(self):
        done = threading.Event()

        def start(fn, job_id, duration):
            fn(job_id, duration)
            done.set()

        mq.bind(root=self.root, now=lambda: 1_800_000_000.0, sleep=lambda s: self.slept.append(float(s)), worker_start=start)
        out = mq.simmer(duration_sec=0.2)
        self.assertEqual(out["status"], "running")
        self.assertTrue(done.wait(2))
        self.assertEqual(self.slept, [0.2])
        job = mq.get_job(out["job"]["id"])["job"]
        self.assertEqual(job["status"], "done")
        self.assertFalse(job["result"]["cpu_busy_wait"])

    def test_pulse_is_explicitly_simulated(self):
        got = mq.pulse()
        self.assertTrue(got["simulated"])
        self.assertFalse(got["sensor"])
        self.assertFalse(got["biological"])
        self.assertFalse(got["hardware"])
        self.assertEqual(got["kind"], "synthetic")

    def test_concurrency_limit(self):
        blockers: list[threading.Event] = []

        def sleep_block(seconds: float) -> None:
            ev = threading.Event()
            blockers.append(ev)
            ev.wait(timeout=5)

        started = []

        def start(fn, job_id, duration):
            t = threading.Thread(target=fn, args=(job_id, duration), daemon=True)
            started.append(t)
            t.start()

        mq.bind(root=self.root, sleep=sleep_block, worker_start=start)
        a = mq.simmer(duration_sec=0.5)
        b = mq.simmer(duration_sec=0.5)
        with self.assertRaises(mq.QuestError) as cm:
            mq.simmer(duration_sec=0.5)
        self.assertEqual(cm.exception.status, 429)
        self.assertEqual(cm.exception.code, "busy")
        for ev in blockers:
            ev.set()
        for t in started:
            t.join(timeout=2)
        self.assertEqual(a["status"], "running")
        self.assertEqual(b["status"], "running")

    def test_duration_bounds(self):
        with self.assertRaises(mq.QuestError) as cm:
            mq.simmer(duration_sec=99)
        self.assertEqual(cm.exception.status, 400)

    def test_whisper_rejects_control_chars_and_scrubs_secrets(self):
        with self.assertRaises(mq.QuestError):
            mq.gear_whisper("line1\nline2")
        with self.assertRaises(mq.QuestError):
            mq.gear_whisper("null\x00byte")
        token = "A" * 40
        mq.gear_whisper("hello " + token)
        log = mq.log_path(self.root).read_text(encoding="utf-8")
        self.assertIn("hello", log)
        self.assertNotIn(token, log)
        self.assertIn("<redacted>", log)
        self.assertEqual(log.count("\n"), 1)

    def test_log_rotation(self):
        path = mq.log_path(self.root)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"x" * (mq.LOG_ROTATE_BYTES + 10))
        mq.gear_whisper("rotate-me")
        self.assertTrue(path.with_name(path.name + ".1").is_file())
        self.assertIn("rotate-me", path.read_text(encoding="utf-8"))

    def test_http_helpers_methods_and_validation(self):
        code, body = mq.http_get("/api/mini-quests/")
        self.assertEqual(code, 200)
        self.assertEqual(len(body["quests"]), 3)
        code, body = mq.http_post("/api/mini-quests/pulse", {"nope": 1})
        self.assertEqual(code, 400)
        code, body = mq.http_post("/api/mini-quests/pulse", [])
        self.assertEqual(code, 400)
        code, body = mq.http_post("/api/mini-quests/", {})
        self.assertEqual(code, 405)
        code, body = mq.http_get("/api/mini-quests/jobs/not-hex")
        self.assertEqual(code, 400)


class BridgeHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="mq-http-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for n in ("Inbox", "Uni", "Print"):
            (cls.root / n).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.cfg_path = Path(cls.tmp) / "bridge_config.json"
        cls.cfg_path.write_text(json.dumps({"pin": ""}), encoding="utf-8")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG))
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = cls.cfg_path
        B.CONFIG.update({
            "pin": "",
            "discord_webhook_url": SECRET,
            "push_enabled": False,
            "backup_dir": str(Path(cls.tmp) / "backups"),
            "users": [
                {"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
                {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"},
            ],
        })
        B.bind_cc_ext()
        B.bind_hq()
        mq.reset_for_tests()
        mq.bind(root=cls.root, sleep=lambda _s: None)

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
        mq.reset_for_tests()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        mq.reset_for_tests()
        mq.bind(root=self.root, sleep=lambda _s: None)

    def test_auth_roles_and_csrf(self):
        self.assertEqual(self.anon.j("/api/mini-quests/")[0], 401)
        self.assertEqual(self.upload.j("/api/mini-quests/")[0], 403)
        st, body = self.admin.j("/api/mini-quests/")
        self.assertEqual(st, 200, body)
        self.assertTrue(body.get("ok"))

        self.assertEqual(self.admin.j("/api/mini-quests/pulse", "POST", {}, origin=False)[0], 403)
        self.assertEqual(
            self.admin.j(
                "/api/mini-quests/pulse",
                "POST",
                {},
                headers={"Origin": "http://evil.example"},
                origin=False,
            )[0],
            403,
        )
        st, body = self.admin.j("/api/mini-quests/pulse", "POST", {})
        self.assertEqual(st, 200, body)
        self.assertTrue(body["simulated"])
        self.assertFalse(body["hardware"])

        self.assertEqual(self.upload.j("/api/mini-quests/pulse", "POST", {})[0], 403)

    def test_methods_body_validation_and_deterministic_errors(self):
        # GET must not mutate — pulse/whisper/simmer are POST-only paths.
        st, body = self.admin.j("/api/mini-quests/pulse")
        self.assertEqual(st, 404, body)
        self.assertNotIn(SECRET, json.dumps(body))

        st, body = self.admin.j("/api/mini-quests/whisper", "POST", {"context": "ok"})
        self.assertEqual(st, 200, body)

        st, body = self.admin.j("/api/mini-quests/whisper", "POST", {"context": "a\nb"})
        self.assertEqual(st, 400, body)
        self.assertEqual(body.get("code"), "validation_error")

        huge = json.dumps({"context": "x" * (mq.BODY_MAX + 50)}).encode()
        st, _h, raw = self.admin.req(
            "/api/mini-quests/whisper",
            "POST",
            huge,
            {"Content-Type": "application/json"},
        )
        self.assertEqual(st, 413, raw)

        st, body = self.admin.j("/api/mini-quests/simmer", "POST", {"duration_sec": "nope"})
        self.assertEqual(st, 400, body)

    def test_simmer_job_poll_and_no_request_auto_log(self):
        log = mq.log_path(self.root)
        before = log.read_text(encoding="utf-8") if log.is_file() else ""
        # Catalog GET must not append a gear-whisper / request line.
        self.assertEqual(self.admin.j("/api/mini-quests/")[0], 200)
        mid = log.read_text(encoding="utf-8") if log.is_file() else ""
        self.assertEqual(mid, before)

        st, body = self.admin.j("/api/mini-quests/simmer", "POST", {"duration_sec": 0.1})
        self.assertEqual(st, 202, body)
        job_id = body["job"]["id"]
        deadline = time.time() + 3
        status = "running"
        while time.time() < deadline:
            st, got = self.admin.j("/api/mini-quests/jobs/" + job_id)
            self.assertEqual(st, 200, got)
            status = got["job"]["status"]
            if status in ("done", "error"):
                break
            time.sleep(0.05)
        self.assertEqual(status, "done")

    def test_existing_routes_still_respond(self):
        self.assertEqual(self.admin.j("/api/me")[0], 200)
        self.assertEqual(self.admin.j("/api/health")[0], 200)
        self.assertEqual(self.admin.j("/api/projects")[0], 200)

    def test_ui_assets_wired(self):
        st, _h, body = self.admin.req("/")
        self.assertEqual(st, 200)
        text = body.decode("utf-8", "replace")
        self.assertIn("/assets/hq-mini-quests.js", text)
        self.assertIn("/assets/hq-mini-quests.css", text)
        self.assertIn('id="system-mini-quests"', text)
        self.assertNotIn('data-nav="mini-quests"', text)


if __name__ == "__main__":
    unittest.main()
