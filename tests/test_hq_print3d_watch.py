import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_print3d
import hq_print3d_watch as watch

FRAME = b"\xff\xd8" + b"x" * 3000


class Rig:
    def __init__(self, verdicts, **settings):
        self.now = 10_000.0
        self.verdicts = list(verdicts)
        self.calls, self.pauses, self.notes, self.images = 0, [], [], []
        self.settings = watch.clean_settings({"enabled": True, **settings})
        self.w = watch.Watcher(frame=lambda pid: FRAME, pause=self.pauses.append,
                               notify=lambda t, b: self.notes.append((t, b)), ai=self._ai,
                               clock=lambda: self.now, run=lambda fn: fn())
        self.state, self.progress, self.start = "printing", 30.0, 10_000.0 - 1000

    def _ai(self, system, frames):
        self.calls += 1
        self.images.append(len(frames))
        v = self.verdicts.pop(0) if self.verdicts else "ok"
        return '{"verdict": "%s", "reason": "reason %s"}' % (v, v)

    def tick(self, advance=0):
        self.now += advance
        self.w.tick([{"id": "p1", "name": "A1 mini", "state": self.state, "progress": self.progress,
                      "job_start": self.start}], self.settings)

    def alarm(self):
        return (self.w.public("p1") or {}).get("alarm")


class SettingsTests(unittest.TestCase):
    def test_off_by_default_and_booleans_are_strict(self):
        d = watch.clean_settings(None)
        self.assertEqual((d["enabled"], d["auto_pause"]), (False, False))
        d = watch.clean_settings({"enabled": "yes", "auto_pause": 1, "interval_sec": 5})
        self.assertEqual((d["enabled"], d["auto_pause"], d["interval_sec"]), (False, False, watch.MIN_INTERVAL))
        self.assertEqual(watch.clean_settings({"interval_sec": 99999})["interval_sec"], watch.MAX_INTERVAL)
        self.assertTrue(watch.clean_settings({"auto_pause": True}, {"enabled": True})["enabled"])

    def test_unreadable_verdicts_never_alarm(self):
        self.assertEqual(watch.parse_verdict("I think it's fine")[0], "ok")
        self.assertEqual(watch.parse_verdict('{"verdict": "catastrophe"}')[0], "ok")
        self.assertEqual(watch.parse_verdict('```json\n{"verdict":"failure","reason":"spaghetti"}\n```'),
                         ("failure", "spaghetti"))


class WatchTests(unittest.TestCase):
    def test_nothing_happens_when_disabled(self):
        r = Rig(["failure"] * 3, enabled=False)
        r.tick()
        self.assertEqual(r.calls, 0)

    def test_no_look_while_settling_paused_or_out_of_range(self):
        r = Rig(["ok"])
        r.start = r.now - 60
        r.tick()
        r.start, r.progress = r.now - 1000, 1.0
        r.tick()
        r.progress, r.state = 99.5, "printing"
        r.tick()
        r.progress, r.state = 40.0, "paused"
        r.tick()
        self.assertEqual(r.calls, 0)
        r.state = "preparing"
        r.tick()
        self.assertEqual(r.calls, 0)

    def test_first_clean_frame_becomes_the_comparison_and_interval_is_kept(self):
        r = Rig(["ok", "ok"])
        r.tick()
        r.tick(60)
        self.assertEqual(r.calls, 1)
        r.tick(r.settings["interval_sec"])
        self.assertEqual(r.calls, 2)
        self.assertEqual(r.images, [1, 2])

    def test_one_bad_look_only_triggers_a_quick_second_look(self):
        r = Rig(["failure", "ok"])
        r.tick()
        self.assertIsNone(r.alarm())
        r.tick(watch.RECHECK_SEC)
        self.assertEqual(r.calls, 2)
        self.assertIsNone(r.alarm())
        self.assertEqual((r.pauses, r.notes), ([], []))

    def test_two_failures_alarm_and_notify_but_do_not_pause_by_default(self):
        r = Rig(["failure", "failure"])
        r.tick()
        r.tick(watch.RECHECK_SEC)
        a = r.alarm()
        self.assertEqual(a["level"], "failure")
        self.assertFalse(a["paused"])
        self.assertEqual(r.pauses, [])
        self.assertEqual(len(r.notes), 1)
        self.assertIn("A1 mini", r.notes[0][0])
        r.tick(r.settings["interval_sec"])                       # still failing: no second notification
        r.tick(watch.RECHECK_SEC)
        self.assertEqual(len(r.notes), 1)

    def test_auto_pause_pauses_once_and_respects_a_resume(self):
        r = Rig(["failure"] * 6, auto_pause=True)
        r.tick()
        r.tick(watch.RECHECK_SEC)
        self.assertEqual(r.pauses, ["p1"])
        self.assertTrue(r.alarm()["paused"])
        r.state = "paused"
        r.tick(5)
        self.assertIsNotNone(r.alarm())                          # the alarm stays visible while paused
        r.state = "printing"                                     # the Master resumes
        r.tick(5)
        self.assertIsNone(r.alarm())
        for _ in range(4):
            r.tick(r.settings["interval_sec"])
        self.assertEqual(r.pauses, ["p1"])                       # never a second automatic pause

    def test_public_exposes_when_it_looked_and_when_it_looks_next(self):
        r = Rig(["ok"])
        r.tick()
        p = r.w.public("p1")
        self.assertEqual(p["looked"], int(r.now))
        self.assertEqual(p["checked"], int(r.now))
        self.assertAlmostEqual(p["next"], r.now + r.settings["interval_sec"])
        r.tick(60)
        self.assertEqual(r.w.public("p1")["next"], p["next"])       # not due yet: unchanged

    def test_a_settling_job_announces_its_first_look(self):
        r = Rig(["ok"])
        r.start = r.now - 60
        r.tick()
        p = r.w.public("p1")
        self.assertEqual(p["looked"], 0)
        self.assertAlmostEqual(p["next"], r.start + watch.SETTLE_SEC)

    def test_the_model_that_answered_is_recorded(self):
        r = Rig([])
        r.w._ai = lambda s, f: ('{"verdict": "ok", "reason": "fine"}', "gemma-4-26b-a4b-it")
        r.tick()
        self.assertEqual(r.w.public("p1")["model"], "gemma-4-26b-a4b-it")

    def test_chain_starts_with_gemma(self):
        self.assertTrue(watch.CHAIN[0].startswith("gemma-"))

    def test_suspect_alone_never_pauses(self):
        r = Rig(["suspect", "suspect"], auto_pause=True)
        r.tick()
        r.tick(watch.RECHECK_SEC)
        self.assertEqual(r.alarm()["level"], "suspect")
        self.assertEqual(r.pauses, [])

    def test_an_ok_look_resets_the_streak(self):
        r = Rig(["failure", "ok", "failure", "ok"], auto_pause=True)
        for _ in range(4):
            r.tick(watch.RECHECK_SEC + r.settings["interval_sec"])
        self.assertIsNone(r.alarm())
        self.assertEqual(r.pauses, [])

    def test_failed_pause_is_reported_not_hidden(self):
        r = Rig(["failure", "failure"], auto_pause=True)
        r.w._pause = lambda pid: (_ for _ in ()).throw(RuntimeError("offline"))
        r.tick()
        r.tick(watch.RECHECK_SEC)
        self.assertFalse(r.alarm()["paused"])
        self.assertIn("could not reach", r.notes[0][1])

    def test_model_error_backs_off_without_alarm(self):
        r = Rig([])
        r.w._ai = lambda s, f: (_ for _ in ()).throw(RuntimeError("quota"))
        r.tick()
        r.tick(60)
        r.w._ai = r._ai
        r.tick(60)
        self.assertEqual(r.calls, 0)
        r.tick(watch.ERROR_BACKOFF)
        self.assertEqual(r.calls, 1)
        self.assertIsNone(r.alarm())

    def test_a_new_job_starts_clean(self):
        r = Rig(["failure"])
        r.tick()
        r.start = r.now - 500
        r.tick()
        self.assertEqual(r.w.public("p1")["verdict"], "ok")   # not the old job's failure
        self.assertEqual(r.w.public("p1")["checks"], 1)
        r.state = "idle"
        r.tick(1)
        self.assertIsNone(r.w.public("p1"))

    def test_daily_cap(self):
        r = Rig(["ok"] * 5)
        r.w._count = watch.MAX_CHECKS_PER_DAY
        r.w._day = r.w._today()
        r.tick()
        self.assertEqual(r.calls, 0)

    def test_tiny_frames_are_ignored(self):
        r = Rig(["failure"])
        r.w._frame = lambda pid: b"x" * 10
        r.tick()
        self.assertEqual(r.calls, 0)


class ControllerTests(unittest.TestCase):
    def test_default_config_is_off_and_saves_strictly(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctl = hq_print3d.Controller(Path(tmp))
            cfg = ctl.public_config()["watch"]
            self.assertEqual((cfg["enabled"], cfg["auto_pause"]), (False, False))
            cfg = ctl.save_settings({"watch": {"enabled": True}})["watch"]
            self.assertTrue(cfg["enabled"])
            self.assertFalse(cfg["auto_pause"])
            cfg = ctl.save_settings({"watch": {"auto_pause": True}})["watch"]
            self.assertTrue(cfg["enabled"] and cfg["auto_pause"])
            ctl.tick()                                           # must not raise with no printers


if __name__ == "__main__":
    unittest.main()
