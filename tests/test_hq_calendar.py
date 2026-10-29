"""Transfert HQ calendar — model, API, projection, reminders.

Offline only: no Windows desktop, no live :8765, no Tailscale.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import unittest
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import hq_automation
import hq_calendar
import hq_events
import hq_state
import iphone_bridge


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

    def test_done_flag_recent_titles_and_next(self):
        first = hq_calendar.save_event(self._payload(title="Sport", start="2026-09-28T08:00", end="2026-09-28T09:00"))
        self.assertNotIn("done", first)
        done = hq_calendar.save_event(self._payload(id=first["id"], title="Sport", start="2026-09-28T08:00", end="2026-09-28T09:00", done=True), expected_rev=1)
        self.assertTrue(done["done"])
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._payload(done="oui"))
        hq_calendar.save_event(self._payload(title="Cours", start="2026-09-28T14:00", end="2026-09-28T15:30"))
        hq_calendar.save_event(self._payload(title="cours", start="2026-09-29T14:00", end="2026-09-29T15:00"))
        recent = hq_calendar.recent_titles()
        self.assertEqual([row["title"].casefold() for row in recent], ["cours", "sport"])
        self.assertEqual(hq_calendar.recent_titles()[1]["time"], "08:00")
        nxt = hq_calendar.next_manual()
        self.assertEqual((nxt["title"], nxt["start"]), ("Cours", "2026-09-28T14:00"))
        body = hq_calendar.query(datetime(2026, 9, 28), datetime(2026, 9, 29))
        self.assertEqual(body["next"]["title"], "Cours")
        self.assertEqual(hq_calendar.summary()["next_mine"]["title"], "Cours")
        self.assertEqual(len(body["recent"]), 2)

    def test_streak_counts_fully_done_days(self):
        def ev(day, done, hour=8):
            saved = hq_calendar.save_event(self._payload(start=f"2026-09-{day}T{hour:02d}:00", end=f"2026-09-{day}T{hour:02d}:30"))
            if done:
                hq_calendar.save_event(self._payload(id=saved["id"], start=saved["start"], end=saved["end"], done=True), expected_rev=1)
        self.assertEqual(hq_calendar.streak(), {"days": 0, "today": False})
        ev(25, True)
        ev(26, True)
        ev(26, True, hour=9)
        # the 27th is empty: it neither counts nor breaks
        ev(28, False)  # today (10:00): unfinished, does not break
        self.assertEqual(hq_calendar.streak(), {"days": 2, "today": False})
        ev(28, False, hour=14)  # still to come today: ignored
        ev(24, False)  # a day missed before: stops the count there
        self.assertEqual(hq_calendar.streak()["days"], 2)
        ev(22, True)
        self.assertEqual(hq_calendar.streak()["days"], 2)

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


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-cal-proj-"))
        self.calls = []
        self.jobs = []
        _bind(
            self.tmp,
            queue_load=lambda: self.jobs,
            run_scene=lambda sid: self.calls.append(("scene", sid)) or {"ok": True, "id": sid},
            run_action=lambda aid: self.calls.append(("action", aid)) or {"ok": True, "id": aid},
            scenes=lambda: [{"id": "ping", "label": "Ping"}],
            actions=lambda: [{"id": "open-inbox", "label": "Inbox"}],
            events_between=self._events,
        )
        self._markers = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _events(self, _start, _end, limit):
        return list(self._markers)[:limit]

    def _day(self, **over):
        base = {
            "title": "Cours",
            "all_day": False,
            "start": "2026-09-28T14:00",
            "end": "2026-09-28T15:00",
            "category": "study",
        }
        base.update(over)
        return base

    def test_projects_grid_whens_and_leaves_queue_untouched(self):
        secret = "RAW_QUEUE_FIELD_SHOULD_NOT_APPEAR"
        once_at = datetime(2026, 9, 30, 15, 30).timestamp()
        self.jobs.extend(
            [
                {"id": "day", "label": "Chaque jour", "when": "daily", "type": "backup", "at": "08:00", "status": "pending", "cmd": secret},
                {"id": "wd", "label": "Semaine", "when": "weekdays", "type": "notify", "at": "08:00", "status": "pending"},
                {"id": "wk", "label": "Lundi", "when": "weekly", "type": "scene", "at": "09:00", "weekday": 0, "status": "pending", "scene_id": "ping"},
                {"id": "one", "label": "Une fois", "when": "once", "type": "notify", "once_at": once_at, "status": "pending"},
                {"id": "edge", "label": "Au retour", "when": "on-online", "type": "scene", "device_id": "pc-host", "status": "pending", "scene_id": "ping"},
                {"id": "wake", "label": "Réveil", "when": "wake", "type": "backup", "status": "pending"},
                {"id": "online", "label": "En ligne", "when": "online", "type": "explore", "status": "pending"},
                {"id": "soon", "label": "Maintenant", "when": "now", "type": "notify", "status": "pending"},
            ]
        )
        before = json.dumps(self.jobs, sort_keys=True)
        path = self.tmp / "bridge_queue.json"
        path.write_text(before, encoding="utf-8")
        raw = path.read_bytes()
        start = datetime(2026, 9, 28)
        end = datetime(2026, 10, 5)
        body = hq_calendar.query(start, end)
        self.assertEqual(json.dumps(self.jobs, sort_keys=True), before)
        self.assertEqual(path.read_bytes(), raw)
        self.assertNotIn(secret, json.dumps(body))
        self.assertNotIn("next_run", json.dumps(self.jobs))
        grid = [item for item in body["items"] if item["source"] == "schedule"]
        whens = {item["when"] for item in grid}
        self.assertEqual(whens, {"daily", "weekdays", "weekly", "once"})
        self.assertTrue(all(item["read_only"] for item in grid))
        daily = [item for item in grid if item["schedule_id"] == "day"]
        self.assertEqual(len(daily), 7)
        weekdays = [item for item in grid if item["schedule_id"] == "wd"]
        self.assertEqual(len(weekdays), 5)
        weekly = [item for item in grid if item["schedule_id"] == "wk"]
        self.assertEqual([item["start"] for item in weekly], ["2026-09-28T09:00"])
        once = [item for item in grid if item["schedule_id"] == "one"]
        self.assertEqual([item["start"] for item in once], ["2026-09-30T15:30"])
        cond_whens = sorted(item["when"] for item in body["conditional"])
        self.assertEqual(cond_whens, ["on-online", "online", "wake"])
        self.assertTrue(all(item["when"] != "on-online" for item in grid))
        self.assertEqual(self.calls, [])

    def test_slot_helper_does_not_mutate_and_skips_conditional(self):
        job = {"id": "day", "when": "daily", "at": "08:00", "label": "Jour"}
        snapshot = json.dumps(job, sort_keys=True)
        slots = hq_automation.project_schedule_slots(job, datetime(2026, 9, 28), datetime(2026, 9, 30))
        self.assertEqual([slot.strftime("%Y-%m-%dT%H:%M") for slot in slots], ["2026-09-28T08:00", "2026-09-29T08:00"])
        self.assertEqual(json.dumps(job, sort_keys=True), snapshot)
        online = {"id": "edge", "when": "on-online", "device_id": "pc-host", "at": "08:00"}
        self.assertEqual(hq_automation.project_schedule_slots(online, datetime(2026, 9, 28), datetime(2026, 10, 5)), [])

    def test_activity_is_bounded_and_omits_extra_fields(self):
        self._markers = [
            {"kind": "upload", "message": "m" * 200, "at": "10:00:00", "ts": i, "notes": "secret-note"}
            for i in range(80)
        ]
        body = hq_calendar.query(datetime(2026, 9, 28), datetime(2026, 9, 29), include_activity=True)
        self.assertEqual(len(body["activity"]), 50)
        self.assertTrue(all(len(item["message"]) <= 80 for item in body["activity"]))
        self.assertNotIn("secret-note", json.dumps(body["activity"]))
        self.assertNotIn("activity", hq_calendar.query(datetime(2026, 9, 28), datetime(2026, 9, 29)))

    def test_run_scene_and_action_are_explicit(self):
        saved = hq_calendar.save_event(self._day(scene_id="ping", action_id="open-inbox"))
        self.assertEqual(self.calls, [])
        ran = hq_calendar.run_linked(saved["id"], "scene")
        self.assertEqual(ran["target"], "scene")
        self.assertEqual(self.calls, [("scene", "ping")])
        hq_calendar.run_linked(saved["id"], "action")
        self.assertEqual(self.calls[-1], ("action", "open-inbox"))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.run_linked(saved["id"], "device")
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.run_linked("sched-day-20260928T0900", "scene")

    def test_unknown_scene_and_action_rejected_on_save(self):
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._day(scene_id="missing"))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.save_event(self._day(action_id="nope"))
        self.assertFalse((self.tmp / "hq_calendar.json").exists())
        saved = hq_calendar.save_event(self._day(scene_id="ping", action_id="open-inbox"))
        self.assertEqual(saved["scene_id"], "ping")
        self.assertEqual(saved["action_id"], "open-inbox")
        self.assertEqual(self.calls, [])

    def test_unknown_scene_rejected_without_runner(self):
        saved = hq_calendar.save_event(self._day(scene_id="ping"))
        _bind(
            self.tmp,
            queue_load=lambda: self.jobs,
            run_scene=lambda sid: self.calls.append(("scene", sid)) or {"ok": True, "id": sid},
            run_action=lambda aid: self.calls.append(("action", aid)) or {"ok": True, "id": aid},
            scenes=lambda: [],
            actions=lambda: [{"id": "open-inbox", "label": "Inbox"}],
            events_between=self._events,
        )
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.run_linked(saved["id"], "scene")
        self.assertEqual(self.calls, [])

    def test_recurring_projection_not_before_created(self):
        created = datetime(2026, 10, 6, 10, 0).timestamp()
        self.jobs.append(
            {
                "id": "day",
                "label": "Chaque jour",
                "when": "daily",
                "type": "backup",
                "at": "08:00",
                "status": "pending",
                "created": created,
            }
        )
        before = json.dumps(self.jobs, sort_keys=True)
        body = hq_calendar.query(datetime(2026, 9, 1), datetime(2026, 10, 10))
        starts = [item["start"] for item in body["items"] if item.get("schedule_id") == "day"]
        self.assertEqual(starts, ["2026-10-07T08:00", "2026-10-08T08:00", "2026-10-09T08:00"])
        self.assertNotIn("2026-10-06T08:00", starts)
        self.assertTrue(all(not start.startswith("2026-09") for start in starts))
        self.assertEqual(json.dumps(self.jobs, sort_keys=True), before)
        weekly = {
            "id": "wk",
            "when": "weekly",
            "at": "09:00",
            "weekday": 0,
            "created": created,
            "label": "Lundi",
        }
        slots = hq_automation.project_schedule_slots(weekly, datetime(2026, 9, 1), datetime(2026, 10, 20))
        self.assertEqual(
            [slot.strftime("%Y-%m-%dT%H:%M") for slot in slots],
            ["2026-10-12T09:00", "2026-10-19T09:00"],
        )
        weekdays = {
            "id": "wd",
            "when": "weekdays",
            "at": "08:00",
            "created": datetime(2026, 10, 2, 18, 0).timestamp(),
            "label": "Ouvres",
        }
        slots = hq_automation.project_schedule_slots(weekdays, datetime(2026, 9, 1), datetime(2026, 10, 8))
        self.assertEqual(
            [slot.strftime("%Y-%m-%dT%H:%M") for slot in slots],
            ["2026-10-05T08:00", "2026-10-06T08:00", "2026-10-07T08:00"],
        )

    def test_activity_local_at_is_hq_wall_time(self):
        moment = datetime(2026, 9, 28, 15, 45, 30)
        self._markers = [{"kind": "upload", "message": "fichier", "ts": moment.timestamp(), "notes": "secret-note"}]
        body = hq_calendar.query(datetime(2026, 9, 28), datetime(2026, 9, 29), include_activity=True)
        marker = body["activity"][0]
        self.assertEqual(marker["local_at"], "2026-09-28T15:45")
        self.assertNotIn("ts", marker)
        self.assertNotIn("secret-note", json.dumps(marker))

    def test_summary_today_and_next_without_notes(self):
        self.jobs.append(
            {"id": "day", "label": "Routine", "when": "daily", "type": "backup", "at": "11:00", "status": "pending"}
        )
        before = json.dumps(self.jobs, sort_keys=True)
        hq_calendar.save_event(self._day(title="Matin", start="2026-09-28T09:00", end="2026-09-28T09:30", notes="SECRET_NOTE"))
        hq_calendar.save_event(self._day(title="Apres-midi", start="2026-09-28T15:00", end="2026-09-28T16:00"))
        hq_calendar.save_event(self._day(title="Journee", all_day=True, start="2026-09-28", end="2026-09-29", notes="SECRET_NOTE"))
        info = hq_calendar.summary()
        titles = [item["title"] for item in info["today"]]
        self.assertIn("Journee", titles)
        self.assertIn("Matin", titles)
        self.assertIn("Routine", titles)
        self.assertLessEqual(len(info["today"]), 5)
        self.assertEqual(info["next"]["title"], "Routine")
        self.assertEqual(info["next"]["start"], "2026-09-28T11:00")
        self.assertTrue(info["next"]["read_only"])
        self.assertNotIn("SECRET_NOTE", json.dumps(info))
        self.assertNotIn("notes", info["today"][0])
        self.assertEqual(json.dumps(self.jobs, sort_keys=True), before)

    def test_span_limits(self):
        start = datetime(2026, 1, 1)
        hq_calendar.query(start, start + timedelta(days=366))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.query(start, start + timedelta(days=367))
        with self.assertRaises(hq_calendar.CalendarError):
            hq_calendar.query(start, start)


def _http(port, method, path, *, body=None, headers=None, cookie=None):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    hdrs = {"Host": f"127.0.0.1:{port}"}
    if headers:
        hdrs.update(headers)
    if cookie:
        hdrs["Cookie"] = cookie
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    payload = resp.read()
    conn.close()
    return resp.status, dict(resp.getheaders()), payload


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-cal-api-"))
        cls._root = iphone_bridge.ROOT
        cls._config = json.loads(json.dumps(iphone_bridge.CONFIG))
        iphone_bridge.ROOT = cls.tmp
        for name in ("Inbox", "Uni", "Print"):
            (cls.tmp / name).mkdir()
        iphone_bridge.CONFIG["pin"] = "424242"
        iphone_bridge.CONFIG["users"] = []
        iphone_bridge.CONFIG["discord_webhook_url"] = ""
        iphone_bridge.CONFIG["scenes"] = [
            {"id": "ping", "label": "Ping", "steps": [{"type": "notify", "title": "ping", "body": "ok"}]}
        ]
        iphone_bridge.CONFIG["actions"] = [
            {"id": "open-inbox", "label": "Inbox", "type": "explore", "path": str(cls.tmp / "missing-action-path")}
        ]
        iphone_bridge.bind_cc_ext()
        iphone_bridge.bind_hq()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), iphone_bridge.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.admin = cls._login("424242")

    @classmethod
    def _login(cls, pin: str) -> str:
        status, headers, _body = _http(
            cls.port,
            "POST",
            "/login",
            body=urlencode({"pin": pin}).encode(),
            headers={
                "Origin": f"http://127.0.0.1:{cls.port}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        if status != 303:
            raise AssertionError(status)
        raw = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
        return raw.split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        iphone_bridge.ROOT = cls._root
        iphone_bridge.CONFIG.clear()
        iphone_bridge.CONFIG.update(cls._config)
        iphone_bridge.bind_cc_ext()
        iphone_bridge.bind_hq()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _get(self, path, cookie=None):
        return _http(self.port, "GET", path, cookie=self.admin if cookie is None else cookie)

    def _post(self, path, payload, *, cookie=None, origin=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        return _http(
            self.port,
            "POST",
            path,
            body=json.dumps(payload).encode(),
            headers=headers,
            cookie=self.admin if cookie is None else cookie,
        )

    def test_auth_csrf_and_allowlist(self):
        self.assertNotIn("/api/calendar", iphone_bridge.UPLOAD_GET_EXACT)
        self.assertNotIn("/api/calendar", iphone_bridge.UPLOAD_POST_EXACT)
        self.assertNotIn("/api/calendar/run", iphone_bridge.UPLOAD_POST_EXACT)
        status, _h, _b = _http(self.port, "GET", "/api/calendar?from=2026-09-28&to=2026-09-29")
        self.assertEqual(status, 401)
        iphone_bridge.CONFIG["users"] = [
            {"name": "admin", "pin": "424242", "role": "admin"},
            {"name": "phone", "pin": "111111", "role": "upload"},
        ]
        try:
            phone = type(self)._login("111111")
            status, _h, _b = self._get("/api/calendar?from=2026-09-28&to=2026-09-29", cookie=phone)
            self.assertEqual(status, 403)
            status, _h, _b = self._post(
                "/api/calendar",
                {"action": "save", "event": {"title": "x", "all_day": True, "start": "2026-09-28", "end": "2026-09-29"}},
                cookie=phone,
            )
            self.assertEqual(status, 403)
            status, _h, _b = self._post("/api/calendar/run", {"id": "cal-" + "ab" * 8, "target": "scene"}, cookie=phone)
            self.assertEqual(status, 403)
        finally:
            iphone_bridge.CONFIG["users"] = []
        status, _h, body = self._post(
            "/api/calendar",
            {"action": "save", "event": {"title": "x", "all_day": True, "start": "2026-09-28", "end": "2026-09-29"}},
            origin=False,
        )
        self.assertEqual(status, 403)
        self.assertIn("CSRF", body.decode())

    def test_save_rev_conflict_and_range(self):
        status, _h, body = self._post(
            "/api/calendar",
            {
                "action": "save",
                "event": {
                    "title": "Visite",
                    "all_day": False,
                    "start": "2026-09-28T11:00",
                    "end": "2026-09-28T12:00",
                    "category": "appointment",
                    "scene_id": "ping",
                },
            },
        )
        self.assertEqual(status, 200, body)
        event = json.loads(body)["event"]
        status, _h, body = self._post(
            "/api/calendar",
            {"action": "save", "expected_rev": 1, "event": {**event, "title": "Visite 2"}},
        )
        self.assertEqual(status, 200, body)
        status, _h, body = self._post(
            "/api/calendar",
            {"action": "save", "expected_rev": 1, "event": {**event, "title": "Visite 3"}},
        )
        self.assertEqual(status, 409, body)
        status, _h, body = self._get("/api/calendar?from=2026-09-28&to=2026-09-29")
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertIn("server_now", payload)
        self.assertIn("server_date", payload)
        self.assertIn("server_utc_offset_min", payload)
        self.assertTrue(any(item["id"] == event["id"] for item in payload["items"]))
        status, _h, _b = self._get("/api/calendar?from=2026-01-01&to=2027-01-03")
        self.assertEqual(status, 400)
        status, _h, _b = self._get("/api/calendar?from=2026-09-29&to=2026-09-28")
        self.assertEqual(status, 400)
        status, _h, _b = self._get("/api/calendar")
        self.assertEqual(status, 400)
        status, _h, _b = self._get("/api/calendar?from=2026-09-28&to=2026-09-29&include_activity=2")
        self.assertEqual(status, 400)
        status, _h, body = self._post("/api/calendar/run", {"id": event["id"], "target": "scene"})
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["target"], "scene")
        status, _h, body = self._post("/api/calendar/run", {"id": event["id"], "target": "action"})
        self.assertEqual(status, 400)

    def test_projection_endpoint_does_not_write_queue(self):
        secret = "QUEUE_SECRET_NOT_FOR_CALENDAR"
        queue = [
            {"id": "day", "label": "Chaque jour", "when": "daily", "type": "backup", "at": "07:30", "status": "pending", "cmd": secret},
            {"id": "edge", "label": "Au retour", "when": "on-online", "type": "scene", "device_id": "pc-host", "status": "armed", "scene_id": "ping"},
        ]
        path = self.tmp / "bridge_queue.json"
        path.write_text(json.dumps(queue), encoding="utf-8")
        before = path.read_bytes()
        status, _h, body = self._get("/api/calendar?from=2026-09-28&to=2026-09-29")
        self.assertEqual(status, 200)
        self.assertEqual(path.read_bytes(), before)
        text = body.decode()
        self.assertNotIn(secret, text)
        payload = json.loads(body)
        self.assertTrue(any(item.get("source") == "schedule" and item.get("when") == "daily" for item in payload["items"]))
        self.assertTrue(all(item.get("when") != "on-online" for item in payload["items"]))
        self.assertTrue(any(item.get("when") == "on-online" for item in payload["conditional"]))

    def test_hq_summary_does_not_probe_or_leak_notes(self):
        note = "NOTE_ABSENTE_DU_RESUME"
        now = datetime.now().replace(second=0, microsecond=0)
        start = now + timedelta(hours=2)
        end = start + timedelta(hours=1)
        status, _h, body = self._post(
            "/api/calendar",
            {
                "action": "save",
                "event": {
                    "title": "Bientot HQ",
                    "all_day": False,
                    "start": start.strftime("%Y-%m-%dT%H:%M"),
                    "end": end.strftime("%Y-%m-%dT%H:%M"),
                    "category": "hq",
                    "notes": note,
                },
            },
        )
        self.assertEqual(status, 200, body)
        calls = []
        original = iphone_bridge.tailscale_peers

        def boom():
            calls.append(1)
            raise AssertionError("tailscale probe")

        iphone_bridge.tailscale_peers = boom
        try:
            status, _h, body = self._get("/api/hq")
            self.assertEqual(status, 200, body)
            self.assertEqual(calls, [])
            data = json.loads(body)
            calendar = data["calendar"]
            self.assertIsInstance(calendar["today"], list)
            self.assertLessEqual(len(calendar["today"]), 5)
            blob = json.dumps(calendar)
            self.assertNotIn(note, blob)
            self.assertIn("Bientot HQ", blob)
        finally:
            iphone_bridge.tailscale_peers = original


class ReminderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-cal-rem-"))
        self.moment = datetime(2026, 9, 28, 10, 0, 0)
        self.alerts = []
        self.notes = []
        self.runs = []
        _bind(
            self.tmp,
            local_now=lambda: self.moment,
            now=lambda: self.moment.timestamp(),
            alert=lambda title, detail, **kwargs: self.alerts.append((title, detail, kwargs.get("discord", True))),
            journal=lambda kind, message, **_extra: self.notes.append((kind, message)),
            run_scene=lambda sid: self.runs.append(sid) or {"ok": True, "id": sid},
            scenes=lambda: [{"id": "ping", "label": "Ping"}],
        )

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _event(self, **over):
        base = {
            "title": "Cours",
            "all_day": False,
            "start": "2026-09-28T10:15",
            "end": "2026-09-28T11:00",
            "category": "study",
            "notes": "SECRET_NOTE",
            "reminders_min": [15],
            "scene_id": "ping",
        }
        base.update(over)
        return base

    def test_fires_once_and_does_not_run_scene(self):
        saved = hq_calendar.save_event(self._event(reminders_min=[15, 5]))
        self.moment = datetime(2026, 9, 28, 10, 15, 0)
        fired = hq_calendar.tick()
        offsets = sorted(item["offset"] for item in fired)
        self.assertEqual(offsets, [5])
        self.assertEqual(len(self.alerts), 1)
        self.assertEqual(self.alerts[0][2], False)
        self.assertTrue(any(kind == "calendar_reminder" for kind, _message in self.notes))
        self.assertNotIn("SECRET_NOTE", json.dumps(self.alerts))
        self.assertNotIn("SECRET_NOTE", json.dumps(self.notes))
        self.assertEqual(self.runs, [])
        again = hq_calendar.tick()
        self.assertEqual(again, [])
        self.assertEqual(len(self.alerts), 1)
        disk = json.loads((self.tmp / "hq_calendar.json").read_text(encoding="utf-8"))
        self.assertEqual(disk["reminder_fired"][f"{saved['id']}|2026-09-28T10:15|15"]["status"], "skipped")
        self.assertEqual(disk["reminder_fired"][f"{saved['id']}|2026-09-28T10:15|5"]["status"], "fired")

    def test_reminder_does_not_call_discord(self):
        discord = []

        def alert(title, detail, discord_flag=True):
            self.alerts.append((title, detail, discord_flag))
            if discord_flag:
                discord.append(title)

        _bind(
            self.tmp,
            local_now=lambda: self.moment,
            now=lambda: self.moment.timestamp(),
            alert=lambda title, detail, discord=True: alert(title, detail, discord),
            journal=lambda kind, message, **_extra: self.notes.append((kind, message)),
            run_scene=lambda sid: self.runs.append(sid) or {"ok": True, "id": sid},
            scenes=lambda: [{"id": "ping", "label": "Ping"}],
        )
        hq_calendar.save_event(self._event(reminders_min=[0], start="2026-09-28T10:00", end="2026-09-28T10:30"))
        self.moment = datetime(2026, 9, 28, 10, 0, 0)
        fired = hq_calendar.tick()
        self.assertEqual(len(fired), 1)
        self.assertEqual(discord, [])
        self.assertEqual(self.alerts[-1][2], False)
        self.assertTrue(any(kind == "calendar_reminder" for kind, _message in self.notes))
        self.assertEqual(self.runs, [])

    def test_catchup_window_and_stale_skip(self):
        hq_calendar.save_event(self._event(start="2026-09-28T10:00", end="2026-09-28T10:30", reminders_min=[0], scene_id=None))
        self.moment = datetime(2026, 9, 28, 10, 5, 0)
        self.assertEqual(len(hq_calendar.tick()), 1)
        hq_calendar.save_event(self._event(title="Tard", start="2026-09-28T12:00", end="2026-09-28T12:30", reminders_min=[0]))
        self.moment = datetime(2026, 9, 28, 12, 6, 0)
        self.assertEqual(hq_calendar.tick(), [])
        self.assertEqual(len(self.alerts), 1)
        self.assertEqual(self.runs, [])

    def test_all_day_anchor_is_eight(self):
        hq_calendar.save_event(
            self._event(all_day=True, start="2026-09-28", end="2026-09-29", reminders_min=[0, 1440], title="Journee")
        )
        self.moment = datetime(2026, 9, 27, 8, 2, 0)
        fired = hq_calendar.tick()
        self.assertEqual([item["offset"] for item in fired], [1440])
        self.moment = datetime(2026, 9, 28, 7, 50, 0)
        self.assertEqual(hq_calendar.tick(), [])
        self.moment = datetime(2026, 9, 28, 8, 1, 0)
        fired = hq_calendar.tick()
        self.assertEqual([item["offset"] for item in fired], [0])
        self.assertEqual(self.runs, [])

    def test_edit_allows_a_new_reminder_identity(self):
        saved = hq_calendar.save_event(self._event())
        self.moment = datetime(2026, 9, 28, 10, 0, 0)
        self.assertEqual(len(hq_calendar.tick()), 1)
        hq_calendar.save_event(
            self._event(id=saved["id"], start="2026-09-28T12:15", end="2026-09-28T13:00"),
            expected_rev=saved["rev"],
        )
        self.moment = datetime(2026, 9, 28, 12, 0, 0)
        fired = hq_calendar.tick()
        self.assertEqual(len(fired), 1)
        self.assertEqual(fired[0]["start"], "2026-09-28T12:15")
        self.assertEqual(self.runs, [])

    def test_tick_leaves_missing_and_malformed_files(self):
        path = self.tmp / "hq_calendar.json"
        self.assertEqual(hq_calendar.tick(), [])
        self.assertFalse(path.exists())
        original = "{ not json"
        path.write_text(original, encoding="utf-8")
        self.assertEqual(hq_calendar.tick(), [])
        self.assertEqual(path.read_text(encoding="utf-8"), original)
        self.assertEqual(self.alerts, [])
        self.assertEqual(self.runs, [])


if __name__ == "__main__":
    unittest.main()
