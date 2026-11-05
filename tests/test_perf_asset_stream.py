"""/assets/ binary delivery: streamed in chunks, single byte ranges, If-Range, HEAD, 304, concurrency. Temp server, temp root."""
import gzip
import http.client
import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path

import iphone_bridge as B


class _Q(B.Handler):
    def log_message(self, *_a):
        pass


class AssetStreamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._root = B.ROOT
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-stream-"))
        (cls.tmp / "assets").mkdir()
        cls.data = os.urandom(B.ASSET_STREAM_MIN + B.ASSET_STREAM_CHUNK + 12345)  # above the whole-read threshold: streamed in several chunks
        (cls.tmp / "assets" / "clip.wav").write_bytes(cls.data)
        cls.text = ("transfert " * 5000).encode()
        (cls.tmp / "assets" / "big.js").write_bytes(cls.text)
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

    def get(self, path, method="GET", **headers):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            c.request(method, path, headers=headers)
            r = c.getresponse()
            return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
        finally:
            c.close()

    def test_full_body_is_exact_and_length_correct(self):
        st, h, body = self.get("/assets/clip.wav")
        self.assertEqual(st, 200)
        self.assertEqual(body, self.data)
        self.assertEqual(int(h["content-length"]), len(self.data))
        self.assertEqual(h["accept-ranges"], "bytes")

    def test_ranges(self):
        n = len(self.data)
        st, h, body = self.get("/assets/clip.wav", Range="bytes=100-199")
        self.assertEqual((st, body), (206, self.data[100:200]))
        self.assertEqual(h["content-range"], f"bytes 100-199/{n}")
        st, h, body = self.get("/assets/clip.wav", Range="bytes=-50")
        self.assertEqual((st, body), (206, self.data[-50:]))
        st, h, body = self.get("/assets/clip.wav", Range=f"bytes={B.ASSET_STREAM_CHUNK - 5}-{B.ASSET_STREAM_CHUNK + 5}")
        self.assertEqual(body, self.data[B.ASSET_STREAM_CHUNK - 5:B.ASSET_STREAM_CHUNK + 6])  # across a chunk boundary
        st, h, body = self.get("/assets/clip.wav", Range=f"bytes={n}-")
        self.assertEqual((st, body), (416, b""))
        self.assertEqual(h["content-range"], f"bytes */{n}")
        st, h, body = self.get("/assets/clip.wav", Range="bytes=0-1,5-6")  # several ranges: ignored, whole file
        self.assertEqual((st, len(body)), (200, n))
        st, h, body = self.get("/assets/clip.wav", Range="garbage")
        self.assertEqual((st, len(body)), (200, n))

    def test_if_range(self):
        _, h, _ = self.get("/assets/clip.wav")
        etag = h["etag"]
        st, _, body = self.get("/assets/clip.wav", Range="bytes=0-9", **{"If-Range": etag})
        self.assertEqual((st, len(body)), (206, 10))
        st, _, body = self.get("/assets/clip.wav", Range="bytes=0-9", **{"If-Range": '"stale"'})
        self.assertEqual((st, len(body)), (200, len(self.data)))

    def test_conditional_304(self):
        st, h, body = self.get("/assets/clip.wav")
        st, _, body = self.get("/assets/clip.wav", **{"If-None-Match": h["etag"]})
        self.assertEqual((st, body), (304, b""))

    def test_gzip_text_unchanged_and_range_uses_identity(self):
        st, h, body = self.get("/assets/big.js", **{"Accept-Encoding": "gzip"})
        self.assertEqual((st, h.get("content-encoding")), (200, "gzip"))
        self.assertEqual(gzip.decompress(body), self.text)
        st, h, body = self.get("/assets/big.js", Range="bytes=0-9", **{"Accept-Encoding": "gzip"})
        self.assertEqual((st, body, h.get("content-encoding")), (206, self.text[:10], None))

    def test_concurrent_streams(self):
        out = []

        def work():
            out.append(self.get("/assets/clip.wav")[2] == self.data)

        ts = [threading.Thread(target=work) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(out, [True] * 8)

    def test_small_file_ranges_and_handle_released(self):
        small = os.urandom(5000)
        p = self.tmp / "assets" / "small.wav"
        p.write_bytes(small)
        st, h, body = self.get("/assets/small.wav", Range="bytes=10-19")
        self.assertEqual((st, body), (206, small[10:20]))
        p.write_bytes(b"x")  # must not be locked after the response (Windows)
        p.unlink()

    def test_missing_file_404(self):
        self.assertEqual(self.get("/assets/nope.wav")[0], 404)


if __name__ == "__main__":
    unittest.main()
