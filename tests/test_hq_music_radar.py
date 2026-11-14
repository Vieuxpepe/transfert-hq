"""Radar and exploration tests using mocked Spotify Web API responses."""
from datetime import date
import tempfile
import unittest
from unittest import mock

import hq_music
import hq_music_radar as radar
import hq_spotify


class RadarTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.root.name)
        hq_music.update_preferences({"favorite_artists": ["Sabaton"]})
        hq_music.update_taste({"history_sharing": False})

    @staticmethod
    def album(id):
        return {"id": id, "uri": f"spotify:album:{id}", "name": id,
                "artists": [{"name": "Sabaton"}], "release_date": date.today().isoformat()}

    def test_dedupes_search_results_and_omits_saved_and_seen(self):
        hq_music.update_taste({"seen": "spotify:album:seen"})

        def api(_method, path, **kwargs):
            if path == "/search":
                self.assertEqual(kwargs["query"]["limit"], 10)
                self.assertFalse(kwargs["retry_429"])
                return {"albums": {"items": [self.album("new"), self.album("saved"), self.album("seen")]}}
            self.assertEqual(path, "/me/library/contains")
            self.assertEqual(kwargs["query"]["uris"], "spotify:album:new,spotify:album:saved")
            return [False, True]

        with mock.patch.object(hq_spotify, "api_request", side_effect=api) as request, \
             mock.patch.object(radar.time, "sleep"):
            result = radar.run()
            self.assertEqual([row["id"] for row in result["items"]], ["new"])
            self.assertIn("tag:new", result["items"][0]["source_query"])
            self.assertEqual(radar.run(), result)
            self.assertEqual(request.call_count, 3)
        hq_music.update_taste({"seen": "spotify:album:new"})
        self.assertEqual(radar.get_radar()["items"], [])

    def test_rate_limit_stops_scanning_and_applies_even_to_forced_runs(self):
        error = hq_spotify.SpotifyError("Rate limit", 429, "spotify_rate_limited", retry_after=123)
        with mock.patch.object(hq_spotify, "api_request", side_effect=error) as request, \
             mock.patch.object(radar.time, "time", return_value=1000):
            result = radar.run(force=True)
            self.assertEqual(result["retry_at"], 1123)
            self.assertEqual(result["code"], "spotify_rate_limited")
            self.assertEqual(radar.run(force=True), result)
            request.assert_called_once()

    def test_counts_artist_once_per_playlist_and_filters_excluded(self):
        first = [{"artists": ["Artist", "Banned"]}, {"artists": ["Artist"]}]
        second = [{"artists": ["artist", "Other"]}]
        rows = radar.cooccurring_artists([first, second], excluded={"banned"})
        self.assertEqual([(row["name"].lower(), row["count"]) for row in rows], [("artist", 2), ("other", 1)])

    def test_restricted_public_playlist_falls_back_to_genre(self):
        calls = []

        def api(_method, path, **kwargs):
            calls.append(path)
            if path == "/playlists/public12345678/items":
                raise hq_spotify.SpotifyError("Unavailable", 403, "spotify_unavailable_endpoint")
            self.assertEqual(path, "/search")
            if kwargs["query"]["type"] == "playlist":
                return {"playlists": {"items": [{"id": "public12345678", "name": "Sabaton Mix"}]}}
            self.assertEqual(kwargs["query"]["q"], 'genre:"metal"')
            return {"tracks": {"items": [{"id": "song", "uri": "spotify:track:song", "name": "Song"}]}}

        with mock.patch.object(hq_spotify, "api_request", side_effect=api):
            rows = radar.discovery_tracks("Sabaton", "metal", limit=1)
        self.assertEqual(calls, ["/search", "/playlists/public12345678/items", "/search"])
        self.assertEqual(rows[0]["uri"], "spotify:track:song")
        self.assertIn("genre metal", rows[0]["why"])
