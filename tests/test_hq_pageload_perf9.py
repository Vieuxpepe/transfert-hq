"""perf9 page-load fixes: HTTP/1.1 keep-alive safety, TCP_NODELAY, versioned immutable assets. Temp server, temp root."""
import gzip
import http.client
import re
import shutil
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path

import iphone_bridge as B

SOURCE = Path(B.__file__).resolve().parent


class _Q(B.Handler):
    conns = 0
    nodelay = []

    def log_message(self, *_a):
        pass

    def setup(self):
        type(self).conns += 1
        super().setup()
        type(self).nodelay.append(self.connection.getsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY))


class PageLoadPerf9(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._root = B.ROOT
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-perf9-"))
        (cls.tmp / "assets").mkdir()
        cls.js = cls.tmp / "assets" / "big.js"
        cls.js.write_text("/* " + "transfert " * 3000 + "*/\n", encoding="utf-8")
        (cls.tmp / "assets" / "a.css").write_text("a{b:c}" * 400, encoding="utf-8")
        B.ROOT = cls.tmp
        cls.httpd = B.HQServer(("127.0.0.1", 0), _Q)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        B.ROOT = cls._root
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def conn(self):
        return http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)

    def test_keepalive_reuses_one_connection_for_many_gets(self):
        _Q.conns = 0
        c = self.conn()
        try:
            for i in range(12):
                c.request("GET", "/assets/big.js" if i % 2 else "/assets/a.css", headers={"Accept-Encoding": "gzip"})
                r = c.getresponse()
                body = r.read()
                self.assertEqual(r.status, 200)
                self.assertEqual(int(r.getheader("Content-Length")), len(body))
                self.assertFalse(r.will_close)
            c.request("GET", "/assets/big.js", headers={"If-None-Match": r.getheader("ETag")})
            r = c.getresponse()
            self.assertEqual((r.status, r.read()), (304, b""))
            c.request("GET", "/assets/nope.js")
            r = c.getresponse()
            self.assertEqual((r.status, r.read()), (404, b"missing"))
            c.request("GET", "/assets/a.css")
            self.assertEqual(c.getresponse().read()[:6], b"a{b:c}")
        finally:
            c.close()
        self.assertEqual(_Q.conns, 1)
        self.assertTrue(all(_Q.nodelay))

    def test_post_and_bodies_and_head_close_the_connection(self):
        for method, body in (("POST", b'{"x":1}'), ("POST", None), ("HEAD", None), ("PUT", b"z")):
            c = self.conn()
            try:
                c.request(method, "/api/nope", body=body, headers={"Content-Type": "application/json"})
                r = c.getresponse()
                r.read()
                self.assertTrue(r.will_close, method)
                self.assertEqual((r.getheader("Connection") or "").lower(), "close", method)
            finally:
                c.close()
        c = self.conn()  # a GET carrying a body never keeps the connection (the body is unread)
        try:
            c.request("GET", "/assets/a.css", body=b"junk")
            r = c.getresponse()
            r.read()
            self.assertTrue(r.will_close)
        finally:
            c.close()

    def test_http10_client_still_closes(self):
        s = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        try:
            s.sendall(b"GET /assets/a.css HTTP/1.0\r\nHost: x\r\n\r\n")
            data = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
            self.assertTrue(data.startswith(b"HTTP/1.1 200"))
            self.assertIn(b"Connection: close", data)
        finally:
            s.close()

    def test_reply_without_length_forces_close(self):
        class NoLen(_Q):
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.end_headers()
                self.wfile.write(b"stream")
        srv = B.HQServer(("127.0.0.1", 0), NoLen)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            c = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=10)
            c.request("GET", "/")
            r = c.getresponse()
            self.assertEqual(r.read(), b"stream")
            self.assertTrue(r.will_close)
            c.close()
        finally:
            srv.shutdown()
            srv.server_close()

    def test_idle_keepalive_releases_semaphore_and_times_out(self):
        old = B.KEEPALIVE_IDLE_SEC
        B.KEEPALIVE_IDLE_SEC = 1
        try:
            c = self.conn()
            c.request("GET", "/assets/a.css")
            c.getresponse().read()
            time.sleep(0.3)
            free = 0
            while B._REQ_SEM.acquire(blocking=False):
                free += 1
            for _ in range(free):
                B._REQ_SEM.release()
            self.assertEqual(free, B.REQ_SEM_MAX)  # the idle connection holds no slot
            time.sleep(1.5)
            c.sock.settimeout(3)
            self.assertEqual(c.sock.recv(10), b"")  # server closed the idle connection
            c.close()
        finally:
            B.KEEPALIVE_IDLE_SEC = old

    def test_versioned_assets_are_immutable_only_when_current(self):
        ver = B.asset_version(self.js.stat())
        for q, cc in (("?v=" + ver, B.ASSET_IMMUTABLE_CC), ("?v=stale", "no-cache"), ("", "no-cache")):
            c = self.conn()
            try:
                c.request("GET", "/assets/big.js" + q, headers={"Accept-Encoding": "gzip"})
                r = c.getresponse()
                body = r.read()
                self.assertEqual(r.status, 200)
                self.assertEqual(r.getheader("Cache-Control"), cc, q)
                self.assertEqual(gzip.decompress(body), self.js.read_bytes())
            finally:
                c.close()

    def test_page_links_get_versions_and_render_app_is_unchanged(self):
        page = b'<link rel="stylesheet" href="/assets/a.css"/><script src="/assets/big.js"></script><script src="/assets/gone.js"></script>'
        out = B.version_page_assets(page).decode()
        self.assertIn('href="/assets/a.css?v=%s"' % B.asset_version((self.tmp / "assets" / "a.css").stat()), out)
        self.assertIn('src="/assets/big.js?v=%s"' % B.asset_version(self.js.stat()), out)
        self.assertIn('<script src="/assets/gone.js"></script>', out)  # missing file: left as is

    def test_real_page_every_static_link_versioned_order_kept(self):
        B.ROOT = SOURCE
        try:
            raw = B.render_app()
            out = B.version_page_assets(raw).decode("utf-8")
        finally:
            B.ROOT = self.tmp
        before = re.findall(r'<script src="/assets/([^"?]+)"', raw.decode("utf-8"))
        after = re.findall(r'<script src="/assets/([^"?]+)\?v=[0-9a-f]+"', out)
        self.assertEqual(before, after)
        self.assertNotIn('<script src="/assets/hq.js"></script>', out)
        self.assertEqual(len(re.findall(r'<link rel="stylesheet" href="/assets/[^"?]+\?v=', out)),
                         len(re.findall(r'<link rel="stylesheet" href="/assets/', raw.decode("utf-8"))))
        self.assertIn("'hq-carnet-modal.js'", out)  # JS loader lists stay un-versioned


if __name__ == "__main__":
    unittest.main()
