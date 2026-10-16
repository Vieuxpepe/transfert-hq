"""Forge Studio F1 HTTP boundary. Disposable root, fake PINs, mock Forge transport."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_diagnostics as D  # noqa: E402
import hq_forge as F  # noqa: E402
import hq_forge_jobs as J  # noqa: E402
import iphone_bridge as B  # noqa: E402

ADMIN_PIN, UPLOAD_PIN = "424242", "111111"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


class Client:
    def __init__(self, base: str, pin: str | None) -> None:
        self.base = base
        self.jar = CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect)
        if pin:
            status, _headers, _body = self.req("/login", "POST", ("pin=" + pin).encode(), {"Content-Type": "application/x-www-form-urlencoded"})
            assert status == 303, status

    def req(self, path: str, method: str = "GET", data: bytes | None = None, headers: dict | None = None, origin: bool = True):
        hdrs = dict(headers or {})
        if origin:
            hdrs.setdefault("Origin", self.base)
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=hdrs)
        try:
            with self.op.open(request, timeout=20) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def json(self, path: str, method: str = "GET", **kwargs):
        status, _headers, body = self.req(path, method, **kwargs)
        return status, json.loads(body.decode("utf-8"))


class ForgeHttp(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.mkdtemp(prefix="forge-f1-")
        cls.root = Path(cls.tmp) / "root"
        cls.root.mkdir()
        for name in ("Inbox", "Uni", "Print"):
            (cls.root / name).mkdir()
        shutil.copytree(SOURCE / "assets", cls.root / "assets")
        cls.saved = (B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH, dict(B.CONFIG), dict(B._DIAG_STATE))
        B.ROOT = cls.root
        B.SESSIONS_PATH = cls.root / "bridge_sessions.json"
        B.CONFIG_PATH = cls.root / "bridge_config.json"
        B.CONFIG_PATH.write_text("{}", encoding="utf-8")
        B.CONFIG.update({
            "pin": "",
            "users": [
                {"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
                {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"},
            ],
        })
        B.bind_cc_ext()
        B.bind_hq()
        D.ERRORS.clear_for_tests()
        B._DIAG_STATE.update(root=None, assets=None, last_probe=None)

        class Quiet(B.Handler):
            def log_message(self, *_args):
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
        F.reset_for_tests()
        B.ROOT, B.SESSIONS_PATH, B.CONFIG_PATH = cls.saved[0], cls.saved[1], cls.saved[2]
        B.CONFIG.clear()
        B.CONFIG.update(cls.saved[3])
        B._DIAG_STATE.clear()
        B._DIAG_STATE.update(cls.saved[4])
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def setUp(self) -> None:
        F.reset_for_tests()
        J.reset_for_tests()
        F.set_transport_for_tests(lambda method, url, timeout: (_ for _ in ()).throw(ConnectionRefusedError()))

    def tearDown(self) -> None:
        F.set_transport_for_tests(None)

    def test_admin_status_is_offline_without_calling_a_real_forge(self):
        urls = []

        def transport(method, url, timeout):
            urls.append(url)
            raise ConnectionRefusedError()

        F.set_transport_for_tests(transport)
        status, payload = self.admin.json("/api/forge/status?upstream=http://evil.example")
        self.assertEqual(status, 200)
        self.assertEqual(payload["forge"], "offline")
        self.assertTrue(urls)
        self.assertTrue(all(url.startswith("http://127.0.0.1:7860/") for url in urls))
        self.assertNotIn("evil.example", json.dumps(payload))

    def test_upload_and_anonymous_are_rejected(self):
        self.assertEqual(self.anon.req("/api/forge/status")[0], 401)
        self.assertEqual(self.anon.req("/api/forge/catalog")[0], 401)
        self.assertEqual(self.upload.req("/api/forge/status")[0], 403)
        self.assertEqual(self.upload.req("/api/forge/catalog")[0], 403)

    def test_post_is_csrf_gated_and_empty_generation_is_rejected(self):
        self.assertEqual(self.admin.req("/api/forge/status", "POST", b"{}", origin=False)[0], 403)
        self.assertEqual(self.admin.req("/api/forge/jobs", "POST", b"{}", {"Origin": "http://evil.example"}, origin=False)[0], 403)
        self.assertEqual(self.admin.req("/api/forge/jobs", "POST", b"{}")[0], 400)
        self.assertEqual(self.admin.req("/api/forge/jobs/job-1/cancel", "POST", b"{}")[0], 404)

    def test_readiness_does_not_depend_on_forge(self):
        self.assertNotIn("hq_forge", D.REQUIRED_MODULES)
        status, _headers, body = self.admin.req("/api/diag/ready")
        payload = json.loads(body.decode("utf-8"))
        self.assertIn(status, (200, 503))
        self.assertNotIn("forge", payload.get("checks", {}))
        self.assertNotIn("forge", payload.get("summary", "").lower())

    def test_catalog_response_has_no_filename(self):
        def transport(method, url, timeout):
            if url.endswith("/sdapi/v1/sd-models"):
                body = [{"title": "example", "model_name": "example", "hash": "abcd", "sha256": None, "filename": r"C:\hidden\a.safetensors"}]
            elif url.endswith("/sdapi/v1/samplers"):
                body = [{"name": "Euler", "aliases": []}]
            elif url.endswith("/sdapi/v1/schedulers"):
                body = [{"name": "automatic", "label": "Automatic"}]
            else:
                raise AssertionError(url)
            return 200, json.dumps(body).encode("utf-8")

        F.set_transport_for_tests(transport)
        status, payload = self.admin.json("/api/forge/catalog")
        self.assertEqual(status, 200)
        self.assertNotIn("filename", json.dumps(payload))
        self.assertNotIn("hidden", json.dumps(payload))
        self.assertEqual(payload["models"][0]["title"], "example")


if __name__ == "__main__":
    unittest.main()
