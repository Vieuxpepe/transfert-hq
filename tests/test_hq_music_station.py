"""DJ Musica as a station: the weekly grid, « previously on Musica », her memory page, and the HTTP routes."""
import time
import unittest
from datetime import datetime
from unittest import mock

import hq_music
import hq_music_dj as dj
import hq_music_station as station
from tests.test_hq_music_dj import DjBase

THURSDAY = datetime(2026, 11, 12, 20, 10)  # a Thursday (weekday 3)


def slot(**over):
    return {"label": "Soirée duel", "kind": "duel", "days": [3], "time": "20:00", "enabled": True, **over}


class GridTests(DjBase):
    def test_save_validates_and_normalizes(self):
        saved = station.save_slots([slot(days=[3, 3, 1], label="  Duel   du jeudi ")])
        self.assertEqual(saved[0]["days"], [1, 3])
        self.assertEqual(saved[0]["label"], "Duel du jeudi")
        self.assertEqual(station.slots(), saved)
        bad = ({"kind": "nope"}, {"time": "25:00"}, {"time": "7:30"}, {"days": []}, {"days": [7]}, {"days": [True]})
        for over in bad:
            with self.assertRaises(station.StationError, msg=str(over)):
                station.save_slots([slot(**over)])
        with self.assertRaises(station.StationError):
            station.save_slots([slot()] * (station.MAX_SLOTS + 1))
        with self.assertRaises(station.StationError):
            station.save_slots("x")

    def test_suggested_grid_is_offered_not_applied(self):
        self.assertEqual(station.slots(), [])
        self.assertTrue(station.view()["suggested"])
        station.apply_suggested()
        kinds = {s["kind"] for s in station.slots()}
        self.assertEqual(kinds, {"daily", "duel", "dj", "tournament"})  # morning and recap keep their own switches

    def test_upcoming_merges_grid_and_settings_and_skips_what_aired(self):
        station.save_slots([slot(days=[3]), slot(label="Tournoi", kind="tournament", days=[6], time="15:00")])
        dj.update_settings({"morning": {"enabled": True, "time": "07:30", "days": [4]}})
        rows = station.upcoming(THURSDAY)
        self.assertEqual([r["label"] for r in rows], ["Soirée duel", "Matinale", "Tournoi"])
        self.assertTrue(rows[0]["today"] and rows[0]["source"] == "grid")
        self.assertEqual(rows[1]["source"], "settings")
        self.assertEqual([r["ts"] for r in rows], sorted(r["ts"] for r in rows))
        station.tick(THURSDAY)  # airs (or announces) today's duel
        later = station.upcoming(THURSDAY)
        self.assertFalse(any(r["label"] == "Soirée duel" and r["today"] for r in later))

    def test_disabled_slot_is_not_listed(self):
        station.save_slots([slot(enabled=False)])
        self.assertEqual(station.upcoming(THURSDAY), [])


class TickTests(DjBase):
    def setUp(self):
        super().setUp()
        self.sent = []
        hq_music.bind(root=self.tmp.name, notify=lambda title, body: self.sent.append(body))

    def test_due_slot_notifies_once_and_is_ready(self):
        station.save_slots([slot()])
        station.tick(THURSDAY)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("Soirée duel", self.sent[0])
        self.assertEqual([r["label"] for r in station.view(THURSDAY)["ready"]], ["Soirée duel"])
        station.tick(THURSDAY)
        self.assertEqual(len(self.sent), 1)  # once a day
        station.tick(datetime(2026, 11, 12, 21, 30))  # window over
        self.assertEqual(len(self.sent), 1)

    def test_wrong_day_or_too_early_does_nothing(self):
        station.save_slots([slot()])
        station.tick(datetime(2026, 11, 13, 20, 5))  # Friday
        station.tick(datetime(2026, 11, 12, 19, 30))
        self.assertEqual(self.sent, [])

    def test_station_on_airs_it_on_the_pc(self):
        station.save_slots([slot(kind="daily", label="Défi")])
        dj.update_settings({"station": False})
        st = dj.settings()
        st["station"] = True
        with mock.patch.object(dj, "settings", return_value=st), mock.patch.object(dj, "_local_device_playing_or_ready", return_value=True), \
             mock.patch.object(station, "_begin") as begin:
            station.tick(THURSDAY)
        begin.assert_called_once_with("daily", {})
        self.assertEqual(station.view(THURSDAY)["ready"], [])  # nothing left to launch by hand
        self.assertIn("commence sur le PC", self.sent[0])

    def test_dj_tick_runs_the_grid(self):
        station.save_slots([slot()])
        dj.tick(THURSDAY)
        self.assertEqual(len(self.sent), 1)

    def test_launch_dispatches_by_kind_and_clears_ready(self):
        station.save_slots([slot(), slot(label="Libre", kind="dj", days=[3], time="21:00")])
        station.tick(THURSDAY)
        rows = {s["kind"]: s["id"] for s in station.slots()}
        with mock.patch.object(dj, "begin", return_value={"ok": True}) as begin:
            station.launch(rows["duel"], "dev1")
            begin.assert_called_with("duel", {"device_id": "dev1"})
            station.launch(rows["dj"])
            begin.assert_called_with("start", {"show": "dj"})
        self.assertEqual(station.view(THURSDAY)["ready"], [])
        with self.assertRaises(station.StationError) as caught:
            station.launch("zzz")
        self.assertEqual(caught.exception.status, 404)


class PreviouslyTests(DjBase):
    def test_first_visit_then_news_then_quiet(self):
        self.assertTrue(station.previously()["first_visit"])
        station.mark_seen()
        self.assertEqual(station.previously()["items"], [])
        self.assertIn("Nothing new", station.previously()["line"])
        with dj._lock:
            state = dj._state()
            state["duels"] = {"champion": {"name": "Song 1", "defenses": 2}, "history": [{"at": time.time() + 5}]}
            dj._save_state(state)
        out = station.previously()
        self.assertTrue(any("Song 1" in i and "2 defences" in i for i in out["items"]))
        self.assertTrue(any("1 vote cast" in i for i in out["items"]))
        self.assertIn("Since your last visit", out["line"])


class SummaryCacheTests(DjBase):
    def test_archive_summary_is_cached_until_the_file_changes(self):
        import hq_music_dj_archive as archive
        seg = {"id": "s1", "show": "dj", "title": "Show", "tracks": [{"uri": "spotify:track:1", "name": "T", "artists": ["A"]}]}
        archive.record("ep1", seg)
        with mock.patch.object(archive, "_load", wraps=archive._load) as load:
            first = archive.summary()
            archive.summary()
            archive.summary()
            self.assertEqual(load.call_count, 1)  # parsed once, then served from the cache
        self.assertEqual([title for _, title in first], ["Show"])
        archive.record("ep2", {**seg, "id": "s2", "title": "Second"})
        self.assertEqual(len(archive.summary()), 2)  # a changed file is re-read
        self.assertEqual(archive.summary()[0][0] >= archive.summary()[1][0], True)  # newest first

    def test_learned_view_is_cached_and_reset_clears_it(self):
        dj._learned_cache.update(at=0.0, value=None)
        with mock.patch.object(dj, "taste_profile", return_value={"artists": [], "cooling": [], "dayparts": {}, "pools_liked": [],
                                                                  "pools_skipped": [], "steers": [], "scores": {}}) as profile:
            dj.learned_view()
            dj.learned_view()
            self.assertEqual(profile.call_count, 1)
            dj.reset_learned()
            dj.learned_view()
            self.assertEqual(profile.call_count, 2)


class MemoryTests(DjBase):
    def test_memory_and_corrections(self):
        hq_music.update_taste({"ban": "Nickelback"})
        out = station.memory()
        self.assertEqual(out["banned"], ["Nickelback"])
        self.assertTrue(out["history_sharing"])
        out = station.correct({"ban": "Coldplay"})
        self.assertIn("Coldplay", out["banned"])
        out = station.correct({"unban": "Nickelback"})
        self.assertNotIn("Nickelback", out["banned"])
        with self.assertRaises(station.StationError):
            station.correct({"explode": 1})


class RouteTests(DjBase):
    def test_routes(self):
        status, body = dj.http_get("/api/musica/dj/station")
        self.assertEqual(status, 200)
        self.assertTrue({"on_air", "upcoming", "ready", "daily", "previously", "slots", "kinds", "moments"} <= set(body))
        status, body = dj.http_post("/api/musica/dj/station/grid", {"suggested": True})
        self.assertEqual((status, len(body["slots"])), (200, 4))
        status, body = dj.http_post("/api/musica/dj/station/grid", {"slots": [slot(kind="bad")]})
        self.assertEqual((status, body["code"]), (400, "validation_error"))
        self.assertEqual(dj.http_post("/api/musica/dj/station/launch", {"id": "nope"})[0], 404)
        self.assertEqual(dj.http_post("/api/musica/dj/station/seen", {})[0], 200)
        self.assertEqual(dj.http_get("/api/musica/dj/station/memory")[0], 200)
        self.assertEqual(dj.http_post("/api/musica/dj/station/memory", {"ban": "X"})[0], 200)
        self.assertEqual(dj.http_post("/api/musica/dj/station/dismiss", {"id": "x"})[0], 200)

    def test_moments_setting(self):
        self.assertTrue(dj.settings()["moments"])
        status, _ = dj.http_post("/api/musica/dj/settings", {"moments": False})
        self.assertEqual(status, 200)
        self.assertFalse(station.view()["moments"])
        with self.assertRaises(dj.DjError):
            dj.update_settings({"moments": "no"})

    def test_a_blind_match_never_leaks_into_the_on_air_line(self):
        with dj._lock:
            state = dj._state()
            state.update(active=True, segment={"show": "duel", "title": "Le Duel", "tracks": [{"name": "Secret", "artists": ["Hidden"]}]},
                         duel={"blind": True, "vote": None})
            dj._save_state(state)
        air = station.view()["on_air"]
        self.assertEqual(air["title"], "Le Duel")
        self.assertIsNone(air["track"])
        self.assertIsNone(air["artist"])


if __name__ == "__main__":
    unittest.main()
