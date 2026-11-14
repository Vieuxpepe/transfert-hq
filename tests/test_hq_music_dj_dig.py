"""La Fouille (hq_music_dj_dig): sources, journal filters, cache, steering weights, the mix and the deadline."""
from collections import Counter
from datetime import datetime, timedelta, timezone
import json
import tempfile
import time
import unittest
from unittest import mock

import hq_ai
import hq_music
import hq_music_dj as dj
import hq_music_dj_dig as dig
import hq_music_journal as journal
import hq_musica
import hq_spotify


def track(i, artist=None, pool="top"):
    return {"uri": f"spotify:track:{i}", "name": f"Song {i}", "artists": [artist or f"Artist {i}"], "album": "A",
            "image": None, "duration_ms": 200000, "why": "w", "pool": pool}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        hq_musica.bind(root=self.tmp.name)

    def play(self, moment, uri, n=1):
        month = moment.astimezone().strftime("%Y-%m")
        data = hq_music._load(journal._month_file(month), {"plays": []})
        for i in range(n):
            t = (moment + timedelta(minutes=4 * i)).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            data["plays"].append({"t": t, "n": uri, "a": ["Band"], "u": f"spotify:track:{uri}", "d": 200000})
        hq_music._write(journal._month_file(month), data)


class JournalSourceTests(Base):
    def test_habits_last_year_and_repeat(self):
        now = datetime.now().astimezone().replace(minute=0, second=0, microsecond=0)
        self.play(now - timedelta(days=14), "habit", n=1)
        self.play(now - timedelta(days=21), "habit", n=1)
        self.play(now - timedelta(days=1), "loop", n=3)
        last_year = now.replace(year=now.year - 1, day=min(now.day, 28))
        self.play(last_year, "old", n=2)
        pools = dig.journal_pools(now.astimezone(timezone.utc), {"tracks": {}, "artists": {}})
        self.assertEqual([r["uri"] for r in pools["repeat"]], ["spotify:track:loop"])
        self.assertEqual([r["uri"] for r in pools["habits"]], ["spotify:track:habit"])
        self.assertIn("vers", pools["habits"][0]["why"])
        self.assertEqual(pools["last_year"][0]["uri"], "spotify:track:old")
        self.assertIn("joué 2 fois", pools["last_year"][0]["why"])

    def test_loved_in_hq_becomes_a_source(self):
        with mock.patch.object(hq_music, "get_taste", return_value={"loved": [
                {"uri": "spotify:track:9", "kind": "track", "artist": "Band", "title": "Hymn"},
                {"uri": "spotify:album:1", "kind": "album", "artist": "Band", "title": "LP"}]}):
            rows = dig.loved_pool()
        self.assertEqual([(r["uri"], r["name"], r["pool"]) for r in rows], [("spotify:track:9", "Hymn", "loved")])


class FilterAndCacheTests(Base):
    def test_journal_filters_on_cached_rows(self):
        now = datetime.now(timezone.utc)
        index = {"tracks": {"spotify:track:1": {"last": (now - timedelta(days=5)).isoformat(), "count": 9},
                            "spotify:track:2": {"last": (now - timedelta(days=200)).isoformat(), "count": 1}},
                 "artists": {}}
        rows = [dict(track(1), pool="classics"), dict(track(2), pool="classics"), dict(track(3), pool="classics")]
        self.assertEqual(sorted(r["uri"] for r in dig._resolve("classics", rows, index, now)),
                         ["spotify:track:2", "spotify:track:3"])  # played 5 days ago: not a « classic to return to »
        liked = dig._resolve("liked", [dict(track(1), pool="liked"), dict(track(2), pool="liked")], index, now)
        self.assertEqual([r["uri"] for r in liked], ["spotify:track:2"])
        self.assertEqual(liked[0]["why"], "aimé sur Spotify, presque jamais écouté")
        cuts = dig._resolve("deep_cuts", [dict(track(2), pool="deep_cuts"), dict(track(5), pool="deep_cuts")], index, now)
        self.assertEqual([r["uri"] for r in cuts], ["spotify:track:5"])

    def test_cache_reused_within_ttl_and_failures_not_cached(self):
        calls = []
        with mock.patch.dict(dig.RAW_SOURCES, {"liked": lambda: calls.append(1) or [dict(track(1), pool="liked")]}):
            dig._cached("liked", 1000.0)
            dig._cached("liked", 1000.0 + 60)
            self.assertEqual(len(calls), 1)
            dig._cached("liked", 1000.0 + dig.CACHE_TTL["liked"] + 1)
            self.assertEqual(len(calls), 2)
        with mock.patch.dict(dig.RAW_SOURCES, {"playlists": lambda: []}):
            dig._cached("playlists", 1000.0)
        self.assertNotIn("playlists", hq_music._load(dig.CACHE_FILE, {}))

    def test_followed_falls_back_to_all_time_artists_when_closed(self):
        with mock.patch.object(hq_spotify, "followed_artists", side_effect=hq_spotify.SpotifyError("closed", 403)), \
             mock.patch.object(hq_spotify, "top_artists", return_value={"artists": [{"id": "a1", "name": "Band"}]}):
            artists = dig._raw_followed()
        self.assertEqual([(a["id"], a["origin"]) for a in artists], [("a1", "toujours")])
        albums = {"albums": [{"id": "old", "release_date": "2019-01-01"}, {"id": "new", "name": "Fresh", "release_date": "2026-10-01"}]}
        with mock.patch.object(hq_spotify, "artist_albums", return_value=albums), \
             mock.patch.object(hq_spotify, "get_album", return_value={"tracks": [track(1), track(2), track(3)]}) as got:
            rows = dig._followed_tracks(artists, {}, datetime.now(timezone.utc))
        got.assert_called_once_with("new")
        self.assertEqual(len(rows), 2)
        self.assertIn("un de tes artistes de toujours", rows[0]["why"])

    def test_playlists_skip_hers_and_closed_ones(self):
        lists = {"items": [{"id": "a", "name": "Road trip", "uri": "spotify:playlist:a", "tracks_total": 3},
                           {"id": "b", "name": "Musica · Gardés", "uri": "spotify:playlist:b", "tracks_total": 3},
                           {"id": "c", "name": "Public", "uri": "spotify:playlist:c", "tracks_total": 3}]}

        def items(pid, **kwargs):
            if pid == "c":
                raise hq_spotify.SpotifyError("closed", 403)
            return {"items": [track(1), track(2)]}

        with mock.patch.object(hq_spotify, "playback_playlist_uri", return_value=None), \
             mock.patch.object(hq_spotify, "list_playlists", return_value=lists), \
             mock.patch.object(hq_spotify, "get_playlist_tracks", side_effect=items) as got:
            rows = dig._raw_playlists()
        self.assertNotIn("b", [c.args[0] for c in got.call_args_list])
        self.assertEqual({r["why"] for r in rows}, {"de ta playlist « Road trip »"})


class SteeringTests(Base):
    def test_focus_and_search_triggers(self):
        self.assertEqual(dig.focus_of(dj.STEER_PRESETS["nostalgie"]), "nostalgie")
        self.assertEqual(dig.focus_of("Des trucs que je n'ai jamais entendus"), "decouverte")
        self.assertEqual(dig.focus_of(dj.STEER_PRESETS["nouveautes"]), "nouveautes")
        self.assertIsNone(dig.focus_of("plus fort"))
        self.assertTrue(dig.wants_search("du jazz des années 60"))
        self.assertTrue(dig.wants_search(dj.STEER_PRESETS["decouverte"]))
        self.assertFalse(dig.wants_search(dj.STEER_PRESETS["calme"]))
        self.assertFalse(dig.wants_search(""))

    def test_weights_follow_focus_and_record(self):
        with mock.patch.object(dig.random, "betavariate", side_effect=lambda a, b: a / (a + b)):
            calm = dig.weights(["repeat", "forgotten"], focus=None, pool_stats={})
            old = dig.weights(["repeat", "forgotten"], focus="nostalgie", pool_stats={})
            record = dig.weights(["top", "radar"], focus=None,
                                 pool_stats={"top": {"done": 1, "skipped": 9}, "radar": {"done": 9, "skipped": 1}})
        self.assertGreater(old["forgotten"] / old["repeat"], calm["forgotten"] / calm["repeat"] * 5)
        self.assertGreater(record["radar"], record["top"])  # the source he finishes gets more slots

    def test_search_plan_is_validated(self):
        reply = {"queries": [{"q": 'genre:"jazz" year:1960-1969', "label": "jazz des années 60"},
                             {"q": "<script>", "label": "x"}, {"q": "rainy tokyo night", "label": "nuit"},
                             {"q": "a", "label": "too short"}, {"q": "b c", "label": "4"}, {"q": "d e", "label": "5"}]}
        with mock.patch("hq_ai.generate", return_value=(json.dumps(reply), "m")):
            plan = dig.search_plan("60s jazz", "Band")
        self.assertEqual([p["q"] for p in plan], ['genre:"jazz" year:1960-1969', "rainy tokyo night", "b c", "d e"])
        with mock.patch.object(hq_spotify, "search", return_value={"tracks": [track(7)]}):
            rows = dig.search_pool(plan[:1])
        self.assertEqual(rows[0]["pool"], "search")
        self.assertIn("jazz des années 60", rows[0]["why"])


class WebDigTests(Base):
    REPLY = {"label": "jazz des années 60", "tracks": [
        {"title": "So What", "artist": "Miles Davis", "site": "allmusic.com"},
        {"title": "Imaginary Song", "artist": "Nobody", "site": "blog.example"},
        {"title": "Take Five", "artist": "The Dave Brubeck Quartet"}]}

    def grounded(self, reply, sources=True):
        def fake(*args, **kwargs):
            assert kwargs.get("search") is True
            if sources:
                kwargs["grounding"].update(sources=[{"title": "allmusic.com", "uri": "https://x"}], queries=[])
            return "Here you go:\n" + json.dumps(reply), "gemini"
        return fake

    @staticmethod
    def spotify(q, **kwargs):
        catalog = [{"uri": "spotify:track:sowhat", "name": "So What (Remastered 2009)", "artists": ["Miles Davis"]},
                   {"uri": "spotify:track:five", "name": "Take Five", "artists": ["The Dave Brubeck Quartet"]},
                   {"uri": "spotify:track:so", "name": "So", "artists": ["Miles Davis"]}]
        return {"tracks": [t for t in catalog if t["artists"][0].split()[0].casefold() in q.casefold()]}

    def test_web_finds_are_verified_on_spotify_before_airing(self):
        with mock.patch("hq_ai.generate", side_effect=self.grounded(self.REPLY)):
            finds = dig.web_finds("60s jazz", "")
        self.assertEqual(len(finds["tracks"]), 3)
        self.assertEqual(finds["tracks"][2]["site"], "allmusic.com")  # no site given: the grounding source
        with mock.patch.object(hq_spotify, "search", side_effect=self.spotify):
            rows = dig.web_pool(finds)
        self.assertEqual([r["uri"] for r in rows], ["spotify:track:sowhat", "spotify:track:five"])  # the invented one is dropped
        self.assertEqual(rows[0]["why"], "trouvé sur le web (allmusic.com) : jazz des années 60")
        self.assertEqual(rows[0]["pool"], "web")
        self.assertIsNone(dig.verify_on_spotify("So", "Nobody Else"))

    def test_search_queries_count_as_searched_and_sites_are_checked(self):
        def queries_only(*args, **kwargs):
            self.assertEqual(args[0], hq_ai.SEARCH_CHAIN)  # Gemini 3+ has no web-search quota
            kwargs["grounding"].update(sources=[], queries=["modal jazz 1960s"])
            return json.dumps({"label": "x", "tracks": [{"title": "So What", "artist": "Miles Davis", "site": "Kind of Blue"}]}), "m"

        with mock.patch("hq_ai.generate", side_effect=queries_only):
            finds = dig.web_finds("60s jazz", "")
        self.assertEqual(finds["tracks"][0]["site"], "le web")  # an album name is not a site

    def test_album_names_resolve_to_one_of_their_tracks(self):
        album = {"id": "alb1", "name": "Point of Departure", "artists": ["Andrew Hill"]}
        with mock.patch.object(hq_spotify, "search", side_effect=lambda q, **k: {"albums": [album]} if k.get("types") == "album" else {"tracks": []}),              mock.patch.object(hq_spotify, "get_album", return_value={"tracks": [{"uri": "spotify:track:refuge", "name": "Refuge", "artists": ["Andrew Hill"]}]}):
            rows = dig.web_pool({"label": "jazz", "tracks": [{"title": "Point of Departure", "artist": "Andrew Hill", "site": "allmusic.com"}]})
        self.assertEqual([r["uri"] for r in rows], ["spotify:track:refuge"])
        self.assertEqual(rows[0]["album"], "Point of Departure")

    def test_no_grounding_or_too_few_finds_falls_back_to_spotify_search(self):
        with mock.patch("hq_ai.generate", side_effect=self.grounded(self.REPLY, sources=False)):
            self.assertEqual(dig.web_finds("60s jazz", "")["tracks"], [])
        with mock.patch.object(dig, "web_finds", return_value={"label": "x", "tracks": [], "sites": []}), \
             mock.patch.object(dig, "search_plan", return_value=[{"q": "jazz", "label": "jazz"}]), \
             mock.patch.object(dig, "search_pool", return_value=[track(7, pool="search")]) as native:
            pools = dig.request_pools("60s jazz", "")
        native.assert_called_once()
        self.assertEqual(list(pools), ["search"])
        many = [dict(track(i), pool="web") for i in range(6)]
        with mock.patch.object(dig, "web_finds", return_value={}), mock.patch.object(dig, "web_pool", return_value=many), \
             mock.patch.object(dig, "search_pool") as native:
            self.assertEqual(list(dig.request_pools("60s jazz", "")), ["web"])
        native.assert_not_called()

    def test_daily_cap_and_longer_deadline(self):
        with mock.patch.object(dig, "WEB_DAILY_CAP", 1), \
             mock.patch("hq_ai.generate", side_effect=self.grounded(self.REPLY)) as gen:
            dig.web_finds("a", "")
            self.assertEqual(dig.web_finds("b", ""), {"label": "", "tracks": [], "sites": []})
        self.assertEqual(gen.call_count, 1)
        seen = {}

        def fake_wait(futures, timeout):
            seen["timeout"] = timeout
            return set(), set(futures)

        with mock.patch.object(dig, "wait", side_effect=fake_wait), \
             mock.patch.object(dig, "request_pools", return_value={}), \
             mock.patch("hq_music_radar.get_radar", return_value={"items": []}), \
             mock.patch.object(hq_musica, "_run_tool", return_value={"tracks": []}):
            dig.collect(history=False, steer="60s jazz")
        self.assertEqual(seen["timeout"], dig.DEADLINE_SEC + dig.WEB_EXTRA_SEC)


class MixTests(unittest.TestCase):
    def test_premieres_first_artist_cap_quotas_and_rest(self):
        pools = {"premiere": [track(100, pool="premiere")],
                 "top": [track(i, artist="Same") for i in range(1, 5)] + [track(i) for i in range(5, 30)],
                 "radar": [track(i, pool="radar") for i in range(40, 70)]}
        out = dig.mix(pools, affinity={}, weight={"top": 1, "radar": 3}, skip_uris={"spotify:track:41"},
                      banned={"artist 42"}, aired={"spotify:track:40": time.time()}, cap=16)
        uris = [r["uri"] for r in out]
        self.assertEqual(uris[0], "spotify:track:100")
        self.assertLessEqual(sum(1 for r in out if r["artists"] == ["Same"]), 2)
        self.assertNotIn("spotify:track:40", uris)  # aired yesterday: resting
        self.assertNotIn("spotify:track:41", uris)  # already in the show
        self.assertNotIn("spotify:track:42", uris)  # banned artist
        pools_count = Counter(r["pool"] for r in out[1:])
        self.assertGreaterEqual(pools_count["radar"], 2 * pools_count["top"])

    def test_rested_tracks_come_back_when_too_few(self):
        pools = {"top": [track(i) for i in range(1, 6)]}
        aired = {f"spotify:track:{i}": time.time() for i in range(1, 6)}
        out = dig.mix(pools, affinity={}, weight={"top": 1}, skip_uris=set(), banned=set(), aired=aired, cap=48)
        self.assertEqual(len(out), 5)

    def test_affinity_orders_inside_a_source(self):
        pools = {"top": [track(1), track(2), track(3)]}
        out = dig.mix(pools, affinity={"artist 3": 5.0}, weight={"top": 1}, skip_uris=set(), banned=set(), aired={}, cap=3)
        self.assertEqual(out[0]["uri"], "spotify:track:3")


class CollectTests(Base):
    def test_late_source_is_dropped_not_awaited(self):
        def slow(*a, **k):
            time.sleep(1.5)
            return {"tracks": [track(1)]}

        with mock.patch.object(dig, "DEADLINE_SEC", 0.4), \
             mock.patch("hq_music_radar.get_radar", return_value={"items": [{"id": "alb", "name": "New"}]}), \
             mock.patch.object(hq_spotify, "get_album", return_value={"tracks": [track(5)]}), \
             mock.patch.object(hq_musica, "_run_tool", side_effect=slow):
            started = time.monotonic()
            pools = dig.collect(history=False)
        self.assertLess(time.monotonic() - started, 1.2)
        self.assertEqual(list(pools), ["radar"])
        self.assertEqual(dig.summary(pools), "Fouille : Radar 1")

    def test_plan_reports_the_dig_and_aired_tracks_rest(self):
        pools = {"top": [track(i) for i in range(1, 7)], "forgotten": [track(i, pool="forgotten") for i in range(10, 14)]}
        with mock.patch.object(dj, "candidate_pools", return_value=pools) as cand, \
             mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3"], "intro": "x"}), "m")):
            seg = dj.plan_segment(steer=dj.STEER_PRESETS["nostalgie"])
        self.assertEqual(cand.call_args.kwargs["steer"], dj.STEER_PRESETS["nostalgie"])
        self.assertEqual(seg["dig"]["found"], {"top": 6, "forgotten": 4})
        self.assertEqual(seg["dig"]["focus"], "nostalgie")
        state = dj._state()
        dj._remember_segment(state, seg)
        self.assertEqual(set(state["aired"]), {t["uri"] for t in seg["tracks"]})
        state.update(segment=seg)
        dj._save_state(state)
        view = dj.public_state()["segment"]
        self.assertEqual(view["dig"]["labels"]["forgotten"], "Oublié")
        self.assertTrue(all(t["pool"] for t in view["tracks"]))


if __name__ == "__main__":
    unittest.main()
