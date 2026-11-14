"""Time machine track (hq_timeline): moments from every source, privacy, bounds, Inbox scan, calendar rows, HTTP span check."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import hq_timeline as tl  # noqa: E402

NOW = 1_800_000_000.0


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts).astimezone().isoformat()


class BuildTests(unittest.TestCase):
    def test_every_source_lands_in_its_lane_oldest_first(self):
        out = tl.build(
            now=NOW, span="day",
            gallery=[{"id": "img-1", "created": iso(NOW - 3600), "thumb": "/api/forge/gallery/img-1/thumb", "prompt": "SECRET PROMPT"}],
            pages=[{"id": "page-a", "title": "Plan du garage", "created_at": NOW - 7200, "updated_at": NOW - 600, "deleted_at": None}],
            files=[{"rel": "Inbox/Photos/x.jpg", "name": "x.jpg", "dir": "Inbox/Photos", "mtime": NOW - 1800}],
            calendar=[{"at": NOW - 5000, "title": "Dentiste", "id": "ev-1", "day": "2027-01-15", "all_day": False}],
            events=[{"ts": NOW - 100, "kind": "backup", "level": "info", "message": "Sauvegarde OK"},
                    {"ts": NOW - 90, "kind": "presence", "message": "ping"}],
        )
        lanes = [m["lane"] for m in out["moments"]]
        self.assertEqual(sorted(set(lanes)), sorted(["forge", "carnet", "fichiers", "calendrier", "systeme"]))
        ats = [m["at"] for m in out["moments"]]
        self.assertEqual(ats, sorted(ats), "oldest first")
        self.assertEqual(out["counts"]["carnet"], 2, "creation and a later edit are two moments")
        self.assertNotIn("SECRET PROMPT", repr(out), "a Forge moment never carries the prompt")
        self.assertNotIn("presence", [m["kind"] for m in out["moments"]], "journal noise stays out")
        forge = next(m for m in out["moments"] if m["lane"] == "forge")
        self.assertEqual(forge["open"], {"kind": "prompt", "id": "img-1"})
        photo = next(m for m in out["moments"] if m["lane"] == "fichiers")
        self.assertEqual(photo["thumb"], "/files/Inbox/Photos/x.jpg")
        self.assertEqual(photo["open"]["dir"], "Inbox/Photos")

    def test_window_bounds_and_trashed_pages(self):
        out = tl.build(now=NOW, span="day", pages=[
            {"id": "page-old", "title": "old", "created_at": NOW - 3 * 86400, "updated_at": NOW - 2 * 86400, "deleted_at": None},
            {"id": "page-gone", "title": "gone", "created_at": NOW - 60, "updated_at": NOW - 30, "deleted_at": NOW - 10},
        ])
        self.assertEqual(out["moments"], [])
        week = tl.build(now=NOW, span="week", pages=[{"id": "page-old", "title": "old", "created_at": NOW - 3 * 86400, "updated_at": NOW - 3 * 86400, "deleted_at": None}])
        self.assertEqual(len(week["moments"]), 1, "an edit within a minute of creation is not a second moment")

    def test_drawing_companions_are_one_moment(self):
        files = [{"rel": "Inbox/Drawings/" + n, "name": n, "dir": "Inbox/Drawings", "mtime": NOW - 50}
                 for n in ("bracket.hqdraw.json", "bracket.png", "bracket.dxf")]
        out = tl.build(now=NOW, files=files)
        self.assertEqual(len(out["moments"]), 1)
        self.assertEqual(out["moments"][0]["kind"], "drawing")
        self.assertEqual(out["moments"][0]["thumb"], "/files/Inbox/Drawings/bracket.png")

    def test_lanes_are_capped_newest_kept(self):
        files = [{"rel": f"Inbox/f{i}.txt", "name": f"f{i}.txt", "dir": "Inbox", "mtime": NOW - i} for i in range(tl.MAX_PER_LANE + 50)]
        out = tl.build(now=NOW, files=files)
        self.assertEqual(out["counts"]["fichiers"], tl.MAX_PER_LANE)
        self.assertTrue(out["truncated"])
        self.assertEqual(out["moments"][-1]["title"], "f0.txt", "the track still reaches now")

    def test_bad_rows_are_ignored_and_span_is_checked(self):
        out = tl.build(now=NOW, gallery=[None, {"id": 3}, {"id": "x", "created": "nope"}], pages=["x", {"id": 1}],
                       files=[{"rel": "", "name": "a", "dir": "Inbox", "mtime": NOW}], events=[{"kind": "backup", "ts": "x"}])
        self.assertEqual(out["moments"], [])
        with self.assertRaises(ValueError):
            tl.build(now=NOW, span="month")


class InboxScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.inbox = self.tmp / "Inbox"
        (self.inbox / "Photos").mkdir(parents=True)
        (self.inbox / "_hidden").mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_scans_top_and_subfolders_skipping_hidden_and_old(self):
        (self.inbox / "a.txt").write_text("a")
        (self.inbox / "Photos" / "b.jpg").write_bytes(b"x")
        (self.inbox / "_hidden" / "c.txt").write_text("c")
        (self.inbox / ".d").write_text("d")
        old = self.inbox / "old.txt"
        old.write_text("o")
        os.utime(old, (time.time() - 10 * 86400, time.time() - 10 * 86400))
        rows = tl.inbox_files(self.inbox, time.time() - 86400)
        self.assertEqual(sorted(r["rel"] for r in rows), ["Inbox/Photos/b.jpg", "Inbox/a.txt"])
        self.assertTrue(all(not os.path.isabs(r["rel"]) for r in rows))

    def test_scan_is_bounded(self):
        for i in range(30):
            (self.inbox / f"f{i}.txt").write_text("x")
        self.assertLessEqual(len(tl.inbox_files(self.inbox, 0, limit=10)), 10)

    def test_missing_inbox_is_empty(self):
        self.assertEqual(tl.inbox_files(self.tmp / "nope", 0), [])


class CalendarRowsTests(unittest.TestCase):
    def test_minute_and_all_day_events(self):
        rows = tl.calendar_rows([
            {"start": "2027-01-15T14:30", "end": "2027-01-15T15:00", "all_day": False, "title": "RDV", "id": "ev-1"},
            {"start": "2027-01-16", "end": "2027-01-17", "all_day": True, "title": "Congé", "id": "ev-2"},
            {"start": "garbage", "all_day": False},
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual(datetime.fromtimestamp(rows[0]["at"]).strftime("%Y-%m-%d %H:%M"), "2027-01-15 14:30")
        self.assertEqual(rows[1]["day"], "2027-01-16")
        self.assertTrue(rows[1]["all_day"])


if __name__ == "__main__":
    unittest.main()
