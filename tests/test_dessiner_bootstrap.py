"""Dessiner bootstrap: deterministic /assets/* types and a tab that never hangs on « Chargement… »."""
import http.client
import json
import mimetypes
import re
import shutil
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import iphone_bridge

SOURCE = Path(iphone_bridge.__file__).resolve().parent
JS = "application/javascript; charset=utf-8"
CSS = "text/css; charset=utf-8"
DESSINER_JS = ("hq-sketch-core.js", "hq-solid-view.js", "hq-face-sketch.js", "hq-dessiner.js")
CSP = ("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; "
       "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")
SENTINEL = b"HQ-OUTSIDE-ASSETS-SENTINEL"


class _QuietHandler(iphone_bridge.Handler):
    def log_message(self, *_args):
        pass


def _get(port, path):
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    try:
        conn.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", f"127.0.0.1:{port}")
        conn.endheaders()
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


class AssetHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._root = iphone_bridge.ROOT
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-assets-http-"))
        shutil.copytree(SOURCE / "assets", cls.tmp / "assets")
        (cls.tmp / "secret.txt").write_bytes(SENTINEL)
        iphone_bridge.ROOT = cls.tmp
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _QuietHandler)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        iphone_bridge.ROOT = cls._root
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _asset(self, name, expected_type):
        status, headers, body = _get(self.port, "/assets/" + name)
        self.assertEqual(status, 200, name)
        self.assertEqual(headers.get("content-type"), expected_type, name)
        self.assertEqual(headers.get("x-content-type-options"), "nosniff", name)
        self.assertEqual(headers.get("cache-control"), "no-cache", name)  # revalidated every load (ETag), never stale
        self.assertTrue(headers.get("etag", "").startswith('"a'), name)
        self.assertEqual(headers.get("content-security-policy"), CSP, name)
        self.assertEqual(body, (SOURCE / "assets" / name).read_bytes(), name)

    def test_dessiner_scripts_and_css_have_exact_types(self):
        for name in DESSINER_JS:
            self._asset(name, JS)
        self._asset("hq-dessiner.css", CSS)

    def test_types_ignore_a_broken_mimetypes_registry(self):
        # Windows mimetypes reads HKCR; a text/plain .js there must not reach browsers.
        broken = lambda *_a, **_k: ("text/plain", None)
        with mock.patch.object(mimetypes, "guess_type", side_effect=broken):
            for name in DESSINER_JS:
                self._asset(name, JS)
            self._asset("hq-dessiner.css", CSS)

    def test_every_shipped_asset_has_an_explicit_type(self):
        for path in (SOURCE / "assets").iterdir():
            if path.is_dir() or path.suffix.lower() == ".bak":
                continue
            self.assertIn(path.suffix.lower(), iphone_bridge.ASSET_CONTENT_TYPES, path.name)
        self.assertEqual(iphone_bridge.ASSET_CONTENT_TYPES[".mjs"], JS)

    def test_unknown_suffix_falls_back_to_octet_stream(self):
        (self.tmp / "assets" / "notes.bin").write_bytes(b"x")
        try:
            status, headers, _ = _get(self.port, "/assets/notes.bin")
            self.assertEqual(status, 200)
            self.assertEqual(headers.get("content-type"), "application/octet-stream")
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        finally:
            (self.tmp / "assets" / "notes.bin").unlink()

    def test_missing_asset_is_404(self):
        status, headers, body = _get(self.port, "/assets/nope-does-not-exist.js")
        self.assertEqual(status, 404)
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertNotIn(b"function", body)

    def test_asset_traversal_is_impossible(self):
        for path in ("/assets/../secret.txt", "/assets/..%2Fsecret.txt", "/assets/%2e%2e/secret.txt",
                     "/assets/%2e%2e%2fsecret.txt", "/assets/..\\secret.txt", "/assets/..%5Csecret.txt",
                     "/assets/..\\..\\secret.txt", "/assets//etc/passwd", "/assets/%2Fetc%2Fpasswd",
                     "/assets/C:\\Windows\\win.ini", "/assets/C:%5CWindows%5Cwin.ini",
                     "/assets/../iphone_bridge.py", "/assets/", "/assets/.."):
            status, _headers, body = _get(self.port, path)
            self.assertEqual(status, 404, path)
            self.assertNotIn(SENTINEL, body, path)
            self.assertNotIn(b"import ", body, path)


class BootstrapPageTests(unittest.TestCase):
    def setUp(self):
        self.html = iphone_bridge.render_app().decode("utf-8")
        self.app_js = iphone_bridge.APP_JS
        self.dessiner = (SOURCE / "assets" / "hq-dessiner.js").read_text(encoding="utf-8")

    def test_dessiner_scripts_are_tagged_in_order(self):
        tags = re.findall(r'<script src="/assets/([^"]+)" data-sk="([^"]+)"></script>', self.html)
        self.assertEqual([t[0] for t in tags], list(DESSINER_JS))
        self.assertTrue(all(src == sk for src, sk in tags))
        self.assertLess(self.html.index("function setView"), self.html.index('data-sk="hq-sketch-core.js"'))
        self.assertIn('<div id="hq-sk-app"><p class="hint">Chargement…</p></div>', self.html)

    def _block(self, start, end):
        i = self.app_js.index(start)
        return self.app_js[i:self.app_js.index(end, i)]

    def test_error_state_is_french_escaped_and_retryable(self):
        fail = self._block("window.hqSketchFail = function", "\n};\n")
        self.assertIn("Dessiner n'a pas pu démarrer.", fail)
        self.assertIn("'Réessayer'", fail)
        self.assertIn("textContent", fail)
        self.assertNotIn("innerHTML", fail)
        self.assertNotIn(".stack", self.app_js)
        self.assertIn("module de dessin non chargé (hq-sketch-core.js)", self.app_js)
        self.assertIn("erreur d'initialisation", self.app_js)

    def test_watchdog_is_event_driven_and_bounded(self):
        watchdog = self._block("// Dessiner bootstrap watchdog", "function setView(")
        self.assertIn("window.addEventListener('error'", watchdog)
        self.assertIn("window.addEventListener('load'", watchdog)
        self.assertIn("{ once: true }", watchdog)
        for forbidden in ("setInterval", "setTimeout", "location.href", "?pin", "token"):
            self.assertNotIn(forbidden, watchdog)
        # Retry re-injects only missing modules, in page order.
        order = [watchdog.index("'%s'" % name) for name in DESSINER_JS]
        self.assertEqual(order, sorted(order))
        self.assertIn("filter(([, glob]) => !window[glob])", watchdog)

    def test_show_hooks_cannot_abort_startup(self):
        view = self._block("function setView(name) {", "\n}\n")
        self.assertIn("try { window.hqCalendarShow(); } catch (e) { console.error(e); }", view)
        self.assertNotIn("toast(", view)  # calendar behavior unchanged apart from not aborting startup
        self.assertIn("hqSketchStart()", view)
        start = self._block("function hqSketchStart() {", "\n}\n")
        self.assertIn("try { window.hqSketchShow(); } catch (e) { console.error(e);", start)

    def test_dessiner_module_fails_visibly_and_registers_once(self):
        head = self.dessiner[: self.dessiner.index("const TOOLS")]
        self.assertIn("if (window.hqSketchShow) return;", head)
        self.assertIn('if (!S) { fail("module de dessin non chargé (hq-sketch-core.js)", "load"); return; }', head)
        self.assertNotIn("if (!S) return;", self.dessiner)
        self.assertIn('fail("erreur d\'initialisation", "init")', self.dessiner)
        self.assertIn("console.error(err);", self.dessiner)
        self.assertTrue(self.dessiner.rstrip().endswith(
            'if (document.body && document.body.dataset.view === "dessiner") window.hqSketchShow();\n})();'))


if __name__ == "__main__":
    unittest.main()
