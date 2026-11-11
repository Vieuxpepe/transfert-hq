"""Inventoria HTTP security — admin, CSRF, upload 403."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_inventoria as ivo  # noqa: E402
import iphone_bridge as B  # noqa: E402

ADMIN_PIN, UPLOAD_PIN = "424242", "111111"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Client:
    def __init__(self, base: str, pin: str | None) -> None:
        self.base = base
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(), NoRedirect)
        if pin:
            st, _h, _b = self.req(
                "/login",
                "POST",
                ("pin=" + pin).encode(),
                {"Content-Type": "application/x-www-form-urlencoded"},
            )
            assert st == 303

    def req(self, path, method="GET", data=None, headers=None, origin=True):
        h = dict(headers or {})
        if origin:
            h.setdefault("Origin", self.base)
        r = urllib.request.Request(self.base + path, data=data, method=method, headers=h)
        try:
            with self.op.open(r, timeout=20) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def j(self, path, method="GET", data=None, **kw):
        body = None
        headers = kw.pop("headers", {}) or {}
        if data is not None:
            body = json.dumps(data).encode()
            headers["Content-Type"] = "application/json"
        st, _h, raw = self.req(path, method, body, headers, **kw)
        try:
            return st, json.loads(raw.decode())
        except ValueError:
            return st, {"_raw": raw.decode("utf-8", "replace")}


class InventoriaSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="ivo-sec-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for n in ("Inbox", "Uni", "Print"):
            (cls.root / n).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.cfg = Path(cls.tmp) / "bridge_config.json"
        cls.cfg.write_text(json.dumps({"pin": ""}), encoding="utf-8")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG))
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = cls.cfg
        B.CONFIG.update({
            "pin": "",
            "push_enabled": False,
            "users": [
                {"name": "admin", "pin": ADMIN_PIN, "role": "admin"},
                {"name": "upload", "pin": UPLOAD_PIN, "role": "upload"},
            ],
        })
        B.bind_cc_ext()
        B.bind_hq()
        ivo.reset_for_tests()

        class Quiet(B.Handler):
            def log_message(self, *_a):
                pass

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = Client(cls.base, ADMIN_PIN)
        cls.upload = Client(cls.base, UPLOAD_PIN)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.httpd.shutdown()
        cls.httpd.server_close()
        B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH = cls.saved[0], cls.saved[1], cls.saved[2]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[3])
        ivo.reset_for_tests()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_upload_forbidden(self) -> None:
        st, _ = self.upload.j("/api/inventoria/sessions", "POST", {"device_id": "x"})
        self.assertEqual(st, 403)
        st2, _ = self.upload.j("/api/inventoria/sessions")
        self.assertEqual(st2, 403)

    def test_csrf_missing_origin(self) -> None:
        st, _ = self.admin.j("/api/inventoria/sessions", "POST", {"device_id": "x"}, origin=False)
        self.assertEqual(st, 403)
