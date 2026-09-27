"""Transfert HQ calendar — model, API, projection, reminders.

Offline only: no Windows desktop, no live :8765, no Tailscale.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import unittest
from datetime import datetime
from pathlib import Path

import hq_calendar
import hq_state


def _bind(root: Path, **extra):
    hq_calendar.bind(
        root=root,
        journal=extra.get("journal"),
        alert=extra.get("alert"),
        now=extra.get("now") or (lambda: 1_700_000_000.0),
        local_now=extra.get("local_now") or (lambda: datetime(2026, 9, 28, 10, 0, 0)),
        queue_load=extra.get("queue_load"),
        run_scene=extra.get("run_scene"),
        run_action=extra.get("run_action"),
        scenes=extra.get("scenes"),
        actions=extra.get("actions"),
        devices=extra.get("devices"),
        events_between=extra.get("events_between"),
    )


class ModelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-cal-"))
        self.notes: list[tuple] = []
        _bind(self.tmp, journal=lambda kind, message, **extra: self.notes.append((kind, message, extra)))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _payload(self, **over):
        base = {
            "title": "Cours",
            "all_day": False,
            "start": "2026-09-28T14:00",
            "end": "2026-09-28T15:00",
            "category": "study",
            "notes": "Chapitre 2",
            "location": "Bureau",
            "reminders_min": [15, 5],
        }
        base.update(over)
        return base

    def test_roundtrip_and_server_id(self):
        saved = hq_calendar.save_event(self._payload())
        self.assertTrue(saved["id"].startswith("cal-"))
        self.assertEqual(saved["rev"], 1)
        self.assertEqual(saved["title"], "Cours")
        self.assertNotIn("notes", self.notes[0][1])
        path = self.tmp / "hq_calendar.json"
        disk = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(disk["version"], 1)
        self.assertEqual(disk["events"][0]["id"], saved["id"])
        self.assertFalse((self.tmp / "hq_calendar.json.tmp").exists())
        start = datetime(2026, 9, 28)
        end = datetime(2026, 9, 29)
        items, bad = hq_calendar.manual_between(start, end)
        self.assertFalse(bad)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["source"], "manual")
        self.assertFalse(items[0]["read_only"])

    def test_malformed_preserved(self):
        path = self.tmp / "hq_calendar.json"
        original = "{ this is not json"
        path.write_text(original, encoding="utf-8")
        self.assertTrue(hq_calendar.malformed())
        with self.assertRaises(hq_calendar.CalendarConflict):
            hq_calendar.save_event(self._payload())
        self.assertEqual(path.read_text(encoding="utf-8"), original)
        path.write_text("[]\n", encoding="utf-8")
        with self.assertRaises(hq_calendar.CalendarConflict):
            hq_calendar.save_event(self._payload())
        self.assertEqual(path.read_text(encoding="utf-8"), "[]\n")
        path.write_text('{"version": 1, "events": "nope"}\n', encoding="utf-8")
        with self.assertRaises(hq_calendar.CalendarConflict):
            hq_calendar.delete_event("cal-" + "ab" * 8, 1)
        self.assertIn('"events": "nope"', path.read_text(encoding="utf-8"))

    def test_validation(self):
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(title="  "))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(title="x" * 121))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(end="2026-09-28T14:00"))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(end="2026-09-28T13:00"))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(all_day=True, start="2026-09-28", end="2026-09-28"))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(all_day=True, start="2026-09-28T00:00", end="2026-09-29"))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(category="secret"))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(reminders_min=[1]))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(reminders_min=[5, 15, 30, 60]))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(notes="n" * 4001))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(location="l" * 201))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(scene_id="../etc"))
        for key in ("cmd", "command", "shell", "host", "exec", "terminal_id", "rrule"):
            with self.assertRaises(hq_calendar.CalendarError):
                hq_calendar.save_event(self._payload(**{key: "nope"}))
        saved = hq_calendar.save_event(
            self._payload(all_day=True, start="2026-09-28", end="2026-09-30", category="hq")
        )
        self.assertTrue(saved["all_day"])
        self.assertEqual(saved["end"], "2026-09-30")
        self.assertNotIn("terminal_id", saved)

    def test_revision_conflict_and_update(self):
        saved = hq_calendar.save_event(self._payload())
        updated = hq_calendar.save_event(
            self._payload(id=saved["id"], title="Cours avancé"),
            expected_rev=1,
        )
        self.assertEqual(updated["rev"], 2)
        self.assertEqual(updated["id"], saved["id"])
        self.assertEqual(updated["created_at"], saved["created_at"])
        with self.assertRaises(hq_calendar.CalendarConflict):
            hq_calendar.save_event(self._payload(id=saved["id"], title="Encore"), expected_rev=1)
        disk = json.loads((self.tmp / "hq_calendar.json").read_text(encoding="utf-8"))
        self.assertEqual(disk["events"][0]["title"], "Cours avancé")
        with self.assertRaises(hq_calendar.CalendarConflict):
            hq_calendar.delete_event(saved["id"], 1)
        gone = hq_calendar.delete_event(saved["id"], 2)
        self.assertTrue(gone["ok"])
        disk = json.loads((self.tmp / "hq_calendar.json").read_text(encoding="utf-8"))
        self.assertEqual(disk["events"], [])

    def test_cap_and_missing_file_not_created_on_read(self):
        items, bad = hq_calendar.manual_between(datetime(2026, 9, 1), datetime(2026, 10, 1))
        self.assertEqual(items, [])
        self.assertFalse(bad)
        self.assertFalse((self.tmp / "hq_calendar.json").exists())
        blob = {
            "version": 1,
            "events": [
                {
                    "id": f"cal-{i:016x}",
                    "title": "Plein",
                    "all_day": True,
                    "start": "2026-09-01",
                    "end": "2026-09-02",
                    "category": "other",
                    "notes": "",
                    "location": "",
                    "reminders_min": [],
                    "created_at": "2026-09-01T00:00:00",
                    "updated_at": "2026-09-01T00:00:00",
                    "rev": 1,
                }
                for i in range(hq_calendar.EVENTS_MAX)
            ],
            "reminder_fired": {},
        }
        hq_state.write_json_atomic(self.tmp / "hq_calendar.json", blob)
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload())
        self.assertEqual(len(json.loads((self.tmp / "hq_calendar.json").read_text(encoding="utf-8"))["events"]), 2000)

    def test_exclusive_all_day_and_range_edges(self):
        hq_calendar.save_event(self._payload(all_day=True, start="2026-09-28", end="2026-09-29", title="Un jour"))
        inside, _ = hq_calendar.manual_between(datetime(2026, 9, 28), datetime(2026, 9, 29))
        self.assertEqual(len(inside), 1)
        after, _ = hq_calendar.manual_between(datetime(2026, 9, 29), datetime(2026, 9, 30))
        self.assertEqual(after, [])
        before, _ = hq_calendar.manual_between(datetime(2026, 9, 27), datetime(2026, 9, 28))
        self.assertEqual(before, [])

    def test_parallel_saves_keep_both_events(self):
        errors = []
        barrier = threading.Barrier(2)

        def worker(title: str):
            try:
                barrier.wait(timeout=2)
                hq_calendar.save_event(self._payload(title=title))
            except Exception as exc:  # noqa: BLE001 — test collects failures
                errors.append(exc)

        threads = [threading.Thread(target=worker, args=(name,)) for name in ("A", "B")]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertEqual(errors, [])
        disk = json.loads((self.tmp / "hq_calendar.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(item["title"] for item in disk["events"]), ["A", "B"])

    def test_edit_drops_stale_reminder_keys(self):
        saved = hq_calendar.save_event(self._payload(reminders_min=[15]))
        path = self.tmp / "hq_calendar.json"
        disk = json.loads(path.read_text(encoding="utf-8"))
        stale = f"{saved['id']}|2026-09-28T14:00|15"
        disk["reminder_fired"] = {stale: {"at": 1, "status": "fired"}, "other|x|0": {"at": 1, "status": "fired"}}
        path.write_text(json.dumps(disk), encoding="utf-8")
        hq_calendar.save_event(
            self._payload(id=saved["id"], start="2026-09-28T16:00", end="2026-09-28T17:00", reminders_min=[5]),
            expected_rev=1,
        )
        disk = json.loads(path.read_text(encoding="utf-8"))
        self.assertNotIn(stale, disk["reminder_fired"])
        self.assertIn("other|x|0", disk["reminder_fired"])

    def test_clock_fields(self):
        info = hq_calendar.clock()
        self.assertEqual(info["server_now"], "2026-09-28T10:00")
        self.assertEqual(info["server_date"], "2026-09-28")
        self.assertIsInstance(info["server_utc_offset_min"], int)


if __name__ == "__main__":
    unittest.main()
