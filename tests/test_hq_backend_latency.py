"""Loopback HTTP latency budgets for bounded HQ read routes."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import cc_ext
import iphone_bridge as B
from scripts.fetch_session_bundle import login

ROOT = Path(__file__).resolve().parents[1]
ROUTE_MAX_MS = 750.0
ROUTES = (
    "/api/ai",
    "/api/hq",
    "/api/events?limit=30",
    "/api/calendar?from=2026-11-01&to=2026-12-01",
    "/api/list?path=Inbox&limit=50",
    "/api/companion/art",
)


class ContentDispositionEncoding(unittest.TestCase):
    def test_unicode_filename_stays_latin1_safe(self) -> None:
        header = B.content_disposition("inline", "l’été.txt")
        header.encode("latin-1")
        self.assertIn("filename*=UTF-8''", header)
        self.assertNotIn("’", header)


class BackendReadCaches(unittest.TestCase):
    def test_recent_media_cache_avoids_repeated_directory_scan(self) -> None:
        with tempfile.TemporaryDirectory(prefix="hq-media-cache-") as tmp:
            root = Path(tmp)
            photos = root / "Inbox" / "Photos"
            photos.mkdir(parents=True)
            (photos / "a.jpg").write_bytes(b"a")
            saved = cc_ext._recent_media_cache
            cc_ext._recent_media_cache = None
            try:
                with mock.patch.object(cc_ext, "_root", return_value=root):
                    self.assertEqual([row["name"] for row in cc_ext.recent_media()], ["a.jpg"])
                    (photos / "b.jpg").write_bytes(b"b")
                    self.assertEqual([row["name"] for row in cc_ext.recent_media()], ["a.jpg"])
                    cache_root, cached_at, rows, fp = cc_ext._recent_media_cache
                    cc_ext._recent_media_cache = (
                        cache_root,
                        cached_at - cc_ext.RECENT_MEDIA_CACHE_SEC - 1,
                        rows,
                        fp,
                    )
                    self.assertEqual(
                        {row["name"] for row in cc_ext.recent_media()},
                        {"a.jpg", "b.jpg"},
                    )
            finally:
                cc_ext._recent_media_cache = saved

    def test_hq_snapshot_reuses_two_second_snapshot(self) -> None:
        saved = B._HQ_SNAPSHOT_CACHE
        B._HQ_SNAPSHOT_CACHE = None
        try:
            with mock.patch.object(B, "cached_roster_devices", return_value=[]) as roster, \
                 mock.patch.object(B.hq_devices, "normalize_all", return_value=[]), \
                 mock.patch.object(B, "hq_attention", return_value=[]), \
                 mock.patch.object(B.hq_events, "recent", return_value=[]), \
                 mock.patch.object(B.hq_companion, "summary", return_value={}):
                B.hq_snapshot()
                B.hq_snapshot()
            self.assertEqual(roster.call_count, 1)
        finally:
            B._HQ_SNAPSHOT_CACHE = saved


class BackendLatencyGate(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory(prefix="hq-backend-latency-")
        cls.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "tests" / "carnet_test_server.py"), cls.tmp.name],
            cwd=str(ROOT),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert cls.proc.stdout is not None
        info = json.loads(cls.proc.stdout.readline().decode("utf-8"))
        cls.base = info["base"]
        cls.opener = login(cls.base, info["admin_pin"])

    @classmethod
    def tearDownClass(cls) -> None:
        cls.proc.terminate()
        try:
            cls.proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            cls.proc.kill()
            cls.proc.wait(timeout=3)
        cls.tmp.cleanup()

    def test_bounded_read_routes_stay_below_budget(self) -> None:
        observed: dict[str, list[float]] = {}
        for path in ROUTES:
            samples: list[float] = []
            for _ in range(3):
                started = time.perf_counter()
                with self.opener.open(self.base + path, timeout=10) as response:
                    self.assertEqual(response.status, 200, path)
                    response.read()
                samples.append((time.perf_counter() - started) * 1000)
            observed[path] = samples
        slow = {
            path: round(max(samples), 1)
            for path, samples in observed.items()
            if max(samples) > ROUTE_MAX_MS
        }
        self.assertFalse(slow, f"route latency exceeded {ROUTE_MAX_MS:.0f}ms: {slow}")


if __name__ == "__main__":
    unittest.main()
