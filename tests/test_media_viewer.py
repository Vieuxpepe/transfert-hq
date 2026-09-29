"""Lecteur (media viewer): /media/ streaming with HTTP Range, /api/media/library, and the tab.

Offline only: a throwaway ROOT and a loopback server with a fake PIN; never the live root.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import cc_ext
import iphone_bridge as B

PIN = "246810"
UPLOAD_PIN = "135790"


def _http(port, path, *, method="GET", body=None, headers=None, cookie=None):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    hdrs = {"Host": f"127.0.0.1:{port}"}
    hdrs.update(headers or {})
    if cookie:
        hdrs["Cookie"] = cookie
    try:
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        return resp.status, {k.lower(): v for k, v in resp.getheaders()}, resp.read()
    finally:
        conn.close()


class ParseByteRangeTests(unittest.TestCase):
    def test_table(self):
        cases = {
            None: None, "": None, "bytes=0-9": (0, 9), "bytes=5-": (5, 99), "bytes=-10": (90, 99),
            "bytes=-500": (0, 99), "bytes=90-1000": (90, 99), "bytes=99-99": (99, 99), "BYTES=1-2": (1, 2),
            "bytes=100-": "unsatisfiable", "bytes=150-160": "unsatisfiable", "bytes=-0": "unsatisfiable",
            "bytes=5-2": None, "bytes=0-1,4-5": None, "items=0-1": None, "bytes=abc": None, "bytes=-": None,
            "bytes=1.5-2": None, "bytes=" + "9" * 30 + "-": None,
        }
        for header, want in cases.items():
            self.assertEqual(B.parse_byte_range(header, 100), want, header)
        self.assertEqual(B.parse_byte_range("bytes=0-", 0), "unsatisfiable")
        self.assertEqual(B.parse_byte_range("bytes=-5", 0), "unsatisfiable")


class MediaRouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = (B.ROOT, B.SESSIONS_PATH, json.loads(json.dumps(B.CONFIG)), B._HQ_BOUND)
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-media-test-"))
        for folder in ("Inbox", "Uni", "Print"):
            (cls.tmp / folder).mkdir()
        B.ROOT = cls.tmp
        B.SESSIONS_PATH = cls.tmp / "bridge_sessions.json"
        B.CONFIG.update({"pin": PIN, "discord_webhook_url": "", "push_enabled": False, "daily_brief_discord": False,
                         "users": [{"name": "admin", "pin": PIN, "role": "admin"},
                                   {"name": "phone", "pin": UPLOAD_PIN, "role": "upload"}]})
        B.bind_cc_ext()
        B.bind_hq()
        inbox = cls.tmp / "Inbox"
        cls.song = bytes((i * 7) % 256 for i in range(3 * 1024 * 1024 + 123))  # > CHUNK: several chunks
        (inbox / "Musique").mkdir()
        (inbox / "Musique" / "chanson été.wav").write_bytes(cls.song)
        (inbox / "notes.txt").write_text("pas un média", encoding="utf-8")
        (inbox / "evil.html").write_text("<script>alert(1)</script>", encoding="utf-8")
        (inbox / "film.mkv").write_bytes(b"\x1a\x45\xdf\xa3")
        (inbox / "vide.mp3").write_bytes(b"")
        (inbox / ".cache.mp3").write_bytes(b"hidden")
        (cls.tmp / "Uni" / "cours.mp4").write_bytes(b"\x00" * 64)
        cls.types = dict(B.MEDIA_CONTENT_TYPES)
        for ext in cls.types:
            (cls.tmp / "Print" / f"t{ext}").write_bytes(b"x" * 10)
        (cls.tmp / "secret.mp3").write_bytes(b"outside the served folders")
        cls.symlinked = False
        try:
            os.symlink(cls.tmp / "secret.mp3", inbox / "lien.mp3")
            os.symlink(cls.tmp, inbox / "boucle", target_is_directory=True)
            cls.symlinked = True
        except (OSError, NotImplementedError):
            pass
        class Quiet(B.Handler):
            def log_message(self, *_args):
                pass

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = cls._login(PIN)
        cls.phone = cls._login(UPLOAD_PIN)

    @classmethod
    def _login(cls, pin):
        B._LOGIN_FAILS.clear()
        status, headers, _ = _http(cls.port, "/login", method="POST", body=urlencode({"pin": pin}).encode(),
                                   headers={"Origin": f"http://127.0.0.1:{cls.port}",
                                            "Content-Type": "application/x-www-form-urlencoded"})
        assert status == 303, status
        return headers["set-cookie"].split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        B.ROOT, B.SESSIONS_PATH, config, hq_bound = cls._saved
        B.CONFIG.clear()
        B.CONFIG.update(config)
        B.bind_cc_ext()
        B._HQ_BOUND = False  # next ensure_hq() rebinds to the restored ROOT
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path, headers=None, cookie="admin"):
        return _http(self.port, path, headers=headers, cookie={"admin": self.admin, "phone": self.phone}.get(cookie, cookie))

    SONG = "/media/Inbox/Musique/chanson%20%C3%A9t%C3%A9.wav"

    def assert_common(self, headers, ctype="audio/wav"):
        self.assertEqual(headers["content-type"], ctype)
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertEqual(headers["accept-ranges"], "bytes")
        self.assertTrue(headers["content-disposition"].startswith("inline;"), headers["content-disposition"])
        csp = headers["content-security-policy"]
        self.assertIn("default-src 'self'", csp)
        self.assertIn("script-src 'self' 'unsafe-inline'", csp)
        self.assertNotIn("unsafe-eval", csp)
        self.assertNotIn("\n", headers["content-disposition"])

    def test_auth_required(self):
        for path in (self.SONG, "/api/media/library"):
            status, headers, body = self.get(path, cookie="")
            self.assertEqual(status, 401, path)
            self.assertIn("application/json", headers["content-type"])
            self.assertNotIn(PIN.encode(), body)
            status, _h, _b = self.get(path, cookie="transfert_session=forged")
            self.assertEqual(status, 401, path)

    def test_upload_role_refused(self):
        for path in (self.SONG, "/api/media/library"):
            status, _h, _b = self.get(path, cookie="phone")
            self.assertEqual(status, 403, path)

    def test_full_file(self):
        status, headers, body = self.get(self.SONG)
        self.assertEqual(status, 200)
        self.assertEqual(body, self.song)
        self.assertEqual(headers["content-length"], str(len(self.song)))
        self.assertNotIn("content-range", headers)
        self.assert_common(headers)
        self.assertIn("filename*=UTF-8''chanson%20%C3%A9t%C3%A9.wav", headers["content-disposition"])

    def test_ranges(self):
        n = len(self.song)
        chunk = B.CHUNK
        for header, (a, b) in {
            "bytes=0-9": (0, 9), "bytes=0-1": (0, 1),
            f"bytes={chunk - 5}-{chunk + 5}": (chunk - 5, chunk + 5),   # across a read chunk boundary
            "bytes=1000-": (1000, n - 1),                               # open-ended
            "bytes=-777": (n - 777, n - 1),                             # suffix
            f"bytes={n - 3}-{n + 1000}": (n - 3, n - 1),                # end clamped
        }.items():
            status, headers, body = self.get(self.SONG, {"Range": header})
            self.assertEqual(status, 206, header)
            self.assertEqual(headers["content-range"], f"bytes {a}-{b}/{n}", header)
            self.assertEqual(headers["content-length"], str(b - a + 1), header)
            self.assertEqual(body, self.song[a:b + 1], header)
            self.assert_common(headers)

    def test_unsatisfiable(self):
        n = len(self.song)
        for header in (f"bytes={n}-", f"bytes={n + 10}-{n + 20}", "bytes=-0"):
            status, headers, body = self.get(self.SONG, {"Range": header})
            self.assertEqual(status, 416, header)
            self.assertEqual(headers["content-range"], f"bytes */{n}")
            self.assertEqual(body, b"")
            self.assertEqual(headers["x-content-type-options"], "nosniff")
        status, headers, _b = self.get("/media/Inbox/vide.mp3", {"Range": "bytes=0-"})
        self.assertEqual((status, headers["content-range"]), (416, "bytes */0"))
        status, headers, body = self.get("/media/Inbox/vide.mp3")
        self.assertEqual((status, body, headers["content-length"]), (200, b"", "0"))

    def test_ignored_ranges_send_whole_file(self):
        for header in ("bytes=0-1,5-9", "items=0-5", "bytes=9-3", "bytes=x-"):
            status, _h, body = self.get(self.SONG, {"Range": header})
            self.assertEqual((status, len(body)), (200, len(self.song)), header)

    def test_if_range(self):
        _s, headers, _b = self.get(self.SONG, {"Range": "bytes=0-0"})
        etag, modified = headers["etag"], headers["last-modified"]
        for validator in (etag, modified):
            status, _h, body = self.get(self.SONG, {"Range": "bytes=0-3", "If-Range": validator})
            self.assertEqual((status, body), (206, self.song[:4]))
        status, _h, body = self.get(self.SONG, {"Range": "bytes=0-3", "If-Range": '"stale"'})
        self.assertEqual((status, len(body)), (200, len(self.song)))

    def test_traversal_and_confinement(self):
        for path in ("/media/Inbox/../../iphone_bridge.py", "/media/Inbox/%2e%2e/secret.mp3", "/media/Inbox/..%2Fsecret.mp3",
                     "/media/secret.mp3", "/media/../secret.mp3", "/media/Inbox/.cache.mp3", "/media/Inbox/bridge_config.json",
                     "/media/C:/Windows/win.ini", "/media/Inbox/Musique/", "/media/Inbox/absent.mp3", "/media/%2Fetc%2Fpasswd"):
            status, _h, body = self.get(path)
            self.assertIn(status, (404, 415), path)
            self.assertNotIn(b"outside the served folders", body, path)
        if self.symlinked:
            status, _h, body = self.get("/media/Inbox/lien.mp3")
            self.assertEqual(status, 404)
            self.assertNotIn(b"outside", body)
            status, _h, _b = self.get("/media/Inbox/boucle/secret.mp3")
            self.assertEqual(status, 404)

    def test_non_media_refused_existing_routes_unchanged(self):
        for name in ("notes.txt", "evil.html", "film.mkv"):
            status, headers, body = self.get(f"/media/Inbox/{name}")
            self.assertEqual(status, 415, name)
            self.assertIn("application/json", headers["content-type"])
            self.assertNotIn(b"alert", body)
        # The existing file routes keep their policy: /download/ is an attachment, active content never inline.
        status, headers, _b = self.get("/download/Inbox/notes.txt")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers["content-disposition"])
        status, headers, _b = self.get("/files/Inbox/evil.html")
        self.assertIn("attachment", headers["content-disposition"])
        self.assertNotIn("text/html", headers["content-type"])

    def test_deterministic_types(self):
        expected = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".flac": "audio/flac",
                    ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp4": "video/mp4", ".m4v": "video/mp4",
                    ".mov": "video/quicktime", ".webm": "video/webm"}
        self.assertEqual(self.types, expected)
        for ext, ctype in expected.items():
            status, headers, body = self.get(f"/media/Print/t{ext}")
            self.assertEqual((status, headers["content-type"], body), (200, ctype, b"x" * 10), ext)
            self.assertTrue(headers["content-disposition"].startswith("inline;"))

    def test_library(self):
        status, headers, body = self.get("/api/media/library")
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers["content-type"])
        data = json.loads(body)
        rels = {i["rel"]: i for i in data["items"]}
        self.assertIn("Inbox/Musique/chanson été.wav", rels)
        self.assertEqual(rels["Inbox/Musique/chanson été.wav"]["kind"], "audio")
        self.assertEqual(rels["Uni/cours.mp4"]["kind"], "video")
        for rel in ("Inbox/notes.txt", "Inbox/film.mkv", "Inbox/.cache.mp3", "Inbox/lien.mp3", "Inbox/boucle/secret.mp3", "secret.mp3"):
            self.assertNotIn(rel, rels)
        self.assertFalse(any("boucle" in r for r in rels))
        self.assertEqual(len(rels), len(self.types) + 3)  # Print/t.*, the wav, the mp4, the empty mp3
        mtimes = [i["mtime"] for i in data["items"]]
        self.assertEqual(mtimes, sorted(mtimes, reverse=True))
        self.assertFalse(data["truncated"])
        for rel in rels:  # every listed file is streamable through the confined route
            self.assertIsNotNone(B.safe_rel_path(rel), rel)

    def test_library_caps(self):
        old = B.MEDIA_SCAN_MAX
        try:
            B.MEDIA_SCAN_MAX = 3
            self.assertTrue(B.media_library()["truncated"])
        finally:
            B.MEDIA_SCAN_MAX = old
        data = B.media_library(limit=2)
        self.assertEqual(len(data["items"]), 2)
        self.assertTrue(data["truncated"])


class LecteurTabStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = B.render_app().decode("utf-8")
        cls.js = B.APP_JS

    def test_tab_and_panel(self):
        self.assertIn('data-nav="lecteur"', self.html)
        self.assertIn('<span class="nav-label">Lecteur</span>', self.html)
        self.assertIn('data-panel="lecteur"', self.html)
        self.assertRegex(self.html, r'<video id="player-video"[^>]*\bplaysinline\b[^>]*\bcontrols\b|<video id="player-video"[^>]*\bcontrols\b[^>]*\bplaysinline\b')
        self.assertIn('<audio id="player-audio" controls', self.html)
        self.assertIn("Retour aux fichiers", self.html)
        self.assertIn("lecteur: 'Lecteur'", self.js)
        self.assertIn('body[data-view="lecteur"] [data-panel="lecteur"]', B.BASE_CSS)
        self.assertIn("if (window.hqPlayerView) window.hqPlayerView(view);", self.js)

    def test_gestures(self):
        self.assertIn("document.addEventListener('dblclick'", self.js)
        self.assertIn("document.addEventListener('pointerup'", self.js)
        self.assertIn("now - hqLastTap.t <= 300", self.js)
        self.assertIn("if (e.pointerType === 'mouse') return;", self.js)
        # Links and buttons in a row keep their single-click behavior.
        self.assertIn("target.closest('a, button, input, select, textarea, label, .file-more-menu')", self.js)
        self.assertIn("li.file[data-media]{touch-action:manipulation}", B.BASE_CSS)

    def test_media_name_double_click(self):
        # Only media names are delayed; the selector is scoped to rows marked data-media.
        self.assertIn("e.target.closest('#file-list li.file[data-media] a.fname')", self.js)
        self.assertIn("window.open(href, '_blank', 'noopener'); }, 300)", self.js)
        # Modified / non-primary clicks keep the browser default (new tab, save link…).
        self.assertIn("e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey", self.js)
        # Non-media names are still plain links opening immediately.
        self.assertIn('<a class="fname" href="${fmtRel(f.rel)}" target="_blank" rel="noopener">', self.js)

    def test_js_types_match_server(self):
        block = re.search(r"const HQ_MEDIA_TYPES = \{(.*?)\};", self.js, re.S).group(1)
        js_types = dict(re.findall(r"(\w+): '([^']+)'", block))
        self.assertEqual({"." + k: v for k, v in js_types.items()}, B.MEDIA_CONTENT_TYPES)
        self.assertIn("'mkv', 'avi'", self.js)
        self.assertIn("ne se lit pas dans un navigateur", self.js)

    def test_no_secrets_in_media_urls(self):
        self.assertIn("return '/media/' + rel.split('/').map(encodeURIComponent).join('/');", self.js)
        self.assertNotRegex(self.js, r"/media/[^'\"]*\?(token|pin|session)")

    def test_csp_unchanged(self):
        class Probe:
            def __init__(self):
                self.headers = []

            def send_header(self, k, v):
                self.headers.append((k, v))

        probe = Probe()
        B.Handler._security_headers(probe)
        csp = dict(probe.headers)["Content-Security-Policy"]
        self.assertEqual(csp, "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                              "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'")


if __name__ == "__main__":
    unittest.main()
