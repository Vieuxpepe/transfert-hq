"""/assets/ delivery: gzip when the browser accepts it, ETag revalidation (304), live edits still show."""
import gzip
import http.client
import os
import shutil
import tempfile
import threading
import time
import unittest
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path

import iphone_bridge

SOURCE = Path(iphone_bridge.__file__).resolve().parent


class _Quiet(iphone_bridge.Handler):
    def log_message(self, *_a):
        pass


class AssetDeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._root = iphone_bridge.ROOT
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-asset-delivery-"))
        (cls.tmp / "assets").mkdir()
        cls.js = cls.tmp / "assets" / "big.js"
        cls.js.write_text("/* " + "transfert " * 2000 + "*/\nconsole.log('ok');\n", encoding="utf-8")
        (cls.tmp / "assets" / "tiny.css").write_text("a{b:c}", encoding="utf-8")
        with wave.open(str(cls.tmp / "assets" / "reaction.wav"), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(24000)
            audio.writeframes(b"\0\0" * 240)
        shutil.copy(SOURCE / "assets" / "hq-files.js", cls.tmp / "assets" / "hq-files.js")
        iphone_bridge.ROOT = cls.tmp
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Quiet)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        iphone_bridge.ROOT = cls._root
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path, **headers):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.putrequest("GET", path, skip_host=True, skip_accept_encoding=True)
            conn.putheader("Host", f"127.0.0.1:{self.port}")
            for k, v in headers.items():
                conn.putheader(k.replace("_", "-"), v)
            conn.endheaders()
            r = conn.getresponse()
            return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
        finally:
            conn.close()

    def test_gzip_only_when_accepted(self):
        raw = self.js.read_bytes()
        st, h, body = self.get("/assets/big.js")
        self.assertEqual((st, body), (200, raw))
        self.assertNotIn("content-encoding", h)
        st, h, body = self.get("/assets/big.js", Accept_Encoding="gzip, deflate, br")
        self.assertEqual((st, h.get("content-encoding"), h.get("vary")), (200, "gzip", "Accept-Encoding"))
        self.assertEqual(gzip.decompress(body), raw)
        self.assertLess(len(body), len(raw) // 5)
        self.assertEqual(int(h["content-length"]), len(body))
        self.assertEqual(h.get("x-content-type-options"), "nosniff")
        self.assertIn("frame-ancestors 'none'", h.get("content-security-policy", ""))

    def test_small_files_are_not_compressed(self):
        st, h, body = self.get("/assets/tiny.css", Accept_Encoding="gzip")
        self.assertEqual((st, body), (200, b"a{b:c}"))
        self.assertNotIn("content-encoding", h)

    def test_wav_reactions_are_delivered_as_audio(self):
        st, headers, body = self.get("/assets/reaction.wav", Accept_Encoding="gzip")
        self.assertEqual(st, 200)
        self.assertEqual(headers.get("content-type"), "audio/wav")
        self.assertTrue(body.startswith(b"RIFF"))
        self.assertNotIn("content-encoding", headers)

    def test_etag_gives_304_and_an_edit_shows_at_once(self):
        st, h, _ = self.get("/assets/big.js")
        etag = h["etag"]
        self.assertEqual(h["cache-control"], "no-cache")
        st, h2, body = self.get("/assets/big.js", If_None_Match=etag)
        self.assertEqual((st, body, h2.get("etag")), (304, b"", etag))
        old = self.js.read_text("utf-8")
        try:
            self.js.write_text(old + "// edited\n", encoding="utf-8")
            os.utime(self.js, ns=(time.time_ns(), time.time_ns() + 10_000_000))
            st, h3, body = self.get("/assets/big.js", If_None_Match=etag, Accept_Encoding="gzip")
            self.assertEqual(st, 200)
            self.assertNotEqual(h3["etag"], etag)
            dec = gzip.decompress(body)
            self.assertIn(b"// edited", dec, "the gzip body should reflect the on-disk edit")
        finally:
            self.js.write_text(old, encoding="utf-8")

    def test_missing_and_escapes(self):
        self.assertEqual(self.get("/assets/nope.js")[0], 404)
        self.assertEqual(self.get("/assets/..%2Fsecret.txt")[0], 404)

    def test_the_page_scripts_shrink(self):
        st, h, body = self.get("/assets/hq-files.js", Accept_Encoding="gzip")
        self.assertEqual(h.get("content-encoding"), "gzip")
        self.assertEqual(gzip.decompress(body), (SOURCE / "assets" / "hq-files.js").read_bytes())


if __name__ == "__main__":
    unittest.main()
