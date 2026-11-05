"""Gzip asset cache: LRU eviction, byte bound, invalidation on change, single compression under concurrency."""
import gzip
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import iphone_bridge as ib


class GzipCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        with ib._ASSET_GZ_LOCK:
            ib._ASSET_GZ_CACHE.clear()
            ib._ASSET_GZ_BYTES = 0

    def tearDown(self):
        self.tmp.cleanup()

    def _file(self, name, data):
        p = self.dir / name
        p.write_bytes(data)
        return p

    def test_roundtrip_and_invalidation(self):
        p = self._file("a.js", b"a" * 5000)
        self.assertEqual(gzip.decompress(ib.asset_gzip(p, p.stat())), b"a" * 5000)
        p.write_bytes(b"b" * 6000)
        self.assertEqual(gzip.decompress(ib.asset_gzip(p, p.stat())), b"b" * 6000)

    def test_lru_eviction_keeps_recent(self):
        with mock.patch.object(ib, "_ASSET_GZ_MAX_ENTRIES", 3):
            ps = [self._file(f"{i}.js", bytes([65 + i]) * 2000) for i in range(3)]
            for p in ps:
                ib.asset_gzip(p, p.stat())
            ib.asset_gzip(ps[0], ps[0].stat())  # touch 0 -> 1 is now oldest
            p4 = self._file("3.js", b"Z" * 2000)
            ib.asset_gzip(p4, p4.stat())
            keys = list(ib._ASSET_GZ_CACHE)
            self.assertEqual(len(keys), 3)
            self.assertNotIn(str(ps[1]), keys)
            self.assertIn(str(ps[0]), keys)

    def test_byte_bound(self):
        with mock.patch.object(ib, "_ASSET_GZ_MAX_BYTES", 3000):
            for i in range(6):
                p = self._file(f"r{i}.js", os.urandom(1500))
                ib.asset_gzip(p, p.stat())
            self.assertLessEqual(ib._ASSET_GZ_BYTES, 3000 + 1600)
            self.assertEqual(ib._ASSET_GZ_BYTES, sum(len(v[2]) for v in ib._ASSET_GZ_CACHE.values()))

    def test_concurrent_compress_once(self):
        p = self._file("c.js", b"x" * 100000)
        st = p.stat()
        calls = []
        real = gzip.compress

        def counting(*a, **k):
            calls.append(1)
            return real(*a, **k)

        out = []
        with mock.patch.object(ib.gzip, "compress", counting):
            ts = [threading.Thread(target=lambda: out.append(ib.asset_gzip(p, st))) for _ in range(8)]
            [t.start() for t in ts]
            [t.join() for t in ts]
        self.assertEqual(len(calls), 1)
        self.assertEqual(len({bytes(o) for o in out}), 1)


if __name__ == "__main__":
    unittest.main()
