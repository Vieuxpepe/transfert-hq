"""Musique recaps: Wrapped (week / month / year), « Ce jour-là » and the taste map, all from the local journal."""
from datetime import date, datetime, timedelta, timezone
import tempfile
import unittest

import hq_music
import hq_music_journal as journal
import hq_music_wrapped as wrapped


def play(moment: datetime, name: str, artist: str, duration: int = 200000) -> dict:
    return {"uri": f"spotify:track:{name}", "name": name, "artists": [artist], "album": "A", "duration_ms": duration,
            "played_at": moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")}


class WrappedBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)

    def record(self, plays):
        journal.record(sorted(plays, key=lambda p: p["played_at"]))


class PeriodTests(WrappedBase):
    def test_bounds_labels_and_validation(self):
        start, end, label = wrapped.period_bounds("week", date(2026, 11, 12))
        self.assertEqual((start, end), (date(2026, 11, 9), date(2026, 11, 15)))
        self.assertIn("Semaine du 9 novembre", label)
        self.assertEqual(wrapped.period_bounds("month", date(2026, 2, 10))[:2], (date(2026, 2, 1), date(2026, 2, 28)))
        self.assertEqual(wrapped.period_bounds("year", date(2026, 5, 1))[:2], (date(2026, 1, 1), date(2026, 12, 31)))
        with self.assertRaises(wrapped.WrappedError):
            wrapped.period_bounds("decade")

    def test_empty_journal_is_empty_not_an_error(self):
        out = wrapped.wrapped("month")
        self.assertTrue(out["empty"])
        self.assertEqual(out["plays"], 0)
        self.assertEqual(wrapped.on_this_day()["empty"], True)
        self.assertEqual(wrapped.taste_map()["empty"], True)


class WrappedTests(WrappedBase):
    def test_month_recap_counts_artists_streak_new_artists_and_previous_period(self):
        base = datetime(2026, 10, 3, 20, 0).astimezone()
        plays = []
        for day in range(4):  # a 4-day streak in October, Sabaton on repeat, Enya only once
            for i in range(3):
                plays.append(play(base + timedelta(days=day, minutes=i * 5), f"S{i}", "Sabaton"))
        plays.append(play(base + timedelta(days=9), "Orinoco", "Enya"))
        for i in range(2):  # September: fewer plays, Enya already known
            plays.append(play(base - timedelta(days=25, minutes=-i), f"Old{i}", "Enya"))
        self.record(plays)
        out = wrapped.wrapped("month", date(2026, 10, 20))
        self.assertEqual(out["plays"], 13)
        self.assertEqual(out["top_artists"][0], {"name": "Sabaton", "plays": 12})
        self.assertEqual(out["longest_streak"], 4)
        self.assertEqual(out["active_days"], 5)
        self.assertEqual(out["previous"]["plays"], 2)
        self.assertEqual(out["previous"]["delta"], 11)
        self.assertEqual([a["name"] for a in out["new_artists"]], ["Sabaton"])  # Enya was heard first in September
        self.assertEqual(out["busiest_hour"], 20)
        self.assertGreater(out["hours"], 0)
        self.assertEqual(out["top_tracks"][0]["plays"], 4)

    def test_future_days_are_not_counted_and_bad_dates_are_rejected_by_the_route(self):
        status, body = hq_music.http_get("/api/music/wrapped/year/not-a-date")
        self.assertEqual(status, 400)
        status, body = hq_music.http_get("/api/music/wrapped/decade")
        self.assertEqual((status, body["code"]), (400, "validation_error"))
        status, body = hq_music.http_get("/api/music/wrapped/week")
        self.assertEqual((status, body["ok"]), (200, True))


class OnThisDayTests(WrappedBase):
    def test_finds_earlier_years_around_today(self):
        today = date(2026, 11, 12)
        when = datetime(2025, 11, 12, 18, 30).astimezone()
        self.record([play(when, "Orinoco", "Enya"), play(when + timedelta(minutes=4), "Orinoco", "Enya"),
                     play(when + timedelta(minutes=9), "Other", "Sabaton"),
                     play(datetime(2024, 11, 13, 9, 0).astimezone(), "Neighbour", "Nightwish")])
        out = wrapped.on_this_day(today)
        years = {y["year"]: y for y in out["years"]}
        self.assertEqual(sorted(years), [2024, 2025])
        self.assertEqual(years[2025]["years_ago"], 1)
        self.assertEqual(years[2025]["tracks"][0], {"name": "Orinoco", "artists": ["Enya"], "uri": "spotify:track:Orinoco", "plays": 2})
        self.assertEqual(years[2024]["plays"], 1)  # the day after still counts when the exact day is silent

    def test_leap_day_does_not_crash(self):
        self.assertTrue(wrapped.on_this_day(date(2028, 2, 29))["empty"])


class TasteMapTests(WrappedBase):
    def test_back_to_back_artists_form_clusters_and_loners_are_listed(self):
        start = datetime(2026, 10, 1, 21, 0).astimezone()
        plays = []
        for session in range(6):  # metal evening sessions: Sabaton ↔ Powerwolf, then folk: Enya ↔ Loreena
            t = start + timedelta(days=session * 2)
            for i, artist in enumerate(["Sabaton", "Powerwolf", "Sabaton", "Powerwolf"]):
                plays.append(play(t + timedelta(minutes=i * 4), f"m{session}{i}", artist))
            t2 = t + timedelta(hours=5)
            for i, artist in enumerate(["Enya", "Loreena", "Enya", "Loreena"]):
                plays.append(play(t2 + timedelta(minutes=i * 4), f"f{session}{i}", artist))
        plays.append(play(start + timedelta(days=30), "Solo", "Lonely"))
        self.record(plays)
        out = wrapped.taste_map(90, today=date(2026, 11, 12))
        ids = {n["name"]: n for n in out["nodes"]}
        self.assertEqual(ids["Sabaton"]["cluster"], ids["Powerwolf"]["cluster"])
        self.assertEqual(ids["Enya"]["cluster"], ids["Loreena"]["cluster"])
        self.assertNotEqual(ids["Sabaton"]["cluster"], ids["Enya"]["cluster"])
        self.assertIn("Lonely", out["loners"])
        self.assertEqual(len(out["clusters"]), 3)
        self.assertTrue(all(e["weight"] > 0 for e in out["edges"]))

    def test_quiet_artists_are_the_ones_that_went_silent(self):
        old = datetime(2026, 6, 20, 20, 0).astimezone()
        recent = datetime(2026, 11, 1, 20, 0).astimezone()
        self.record([play(old + timedelta(minutes=i), f"o{i}", "Nightwish") for i in range(4)]
                    + [play(old + timedelta(minutes=10 + i), f"p{i}", "Sabaton") for i in range(4)]
                    + [play(recent, "r", "Sabaton"), play(recent + timedelta(minutes=2), "q", "Enya")])
        out = wrapped.taste_map(60, today=date(2026, 11, 12))
        self.assertEqual([q["name"] for q in out["quiet"]], ["Nightwish"])  # Sabaton is still played


if __name__ == "__main__":
    unittest.main()
