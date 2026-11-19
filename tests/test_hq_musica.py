"""Unit tests for Musica steward (no live Gemini / Spotify)."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import hq_musica as musica
import hq_music


class MusicaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        musica.reset_for_tests()
        musica.bind(root=self.tmp.name)
        hq_music.bind(root=self.tmp.name)

    def tearDown(self):
        musica.reset_for_tests()
        hq_music.reset_for_tests()
        self.tmp.cleanup()

    def test_taste_ban_artist(self):
        results = musica.execute_tools([{"name": "ban_artist", "args": {"name": "Slop Artist"}}])
        self.assertTrue(results[0]["ok"])
        taste = musica.get_taste()
        self.assertIn("Slop Artist", taste["banned_artists"])

    def test_parse_model_json_fence(self):
        raw = 'Sure.\n```json\n{"reply":"Salut","tools":[{"name":"get_status","args":{}}]}\n```'
        parsed = musica._parse_model_json(raw)
        self.assertEqual(parsed["reply"], "Salut")
        self.assertEqual(parsed["tools"][0]["name"], "get_status")

    def test_thread_roundtrip(self):
        musica._append_messages([
            {"role": "user", "text": "hello", "utc": "2026-01-01T00:00:00Z"},
            {"role": "assistant", "text": "hi", "utc": "2026-01-01T00:00:01Z"},
        ])
        thread = musica.get_thread()
        self.assertEqual(len(thread["messages"]), 2)
        cleared = musica.clear_thread()
        self.assertEqual(cleared["messages"], [])

    def test_unknown_tool(self):
        results = musica.execute_tools([{"name": "hack_the_planet", "args": {}}])
        self.assertFalse(results[0]["ok"])
        self.assertEqual(results[0]["code"], "unknown_tool")

    def test_chat_with_mocked_generate(self):
        payload = {"reply": "Spotify est prêt.", "tools": [{"name": "ban_artist", "args": {"name": "X"}}]}

        def fake_generate(*_a, **_k):
            return json.dumps(payload), "test-model"

        with mock.patch.dict("sys.modules", {"hq_ai": mock.Mock(generate=fake_generate, ASK_CHAIN=("m",), AiError=Exception)}):
            # Re-import path uses hq_ai inside chat(); patch where used.
            with mock.patch("hq_ai.generate", side_effect=fake_generate), mock.patch("hq_ai.ASK_CHAIN", ("m",)):
                with mock.patch("hq_spotify.status", return_value={"connected": True, "ok": True}):
                    with mock.patch("hq_music.get_profile", return_value={
                        "favorite_artists": [], "preferred_genres": [], "musical_patterns": [], "feedback_history": []
                    }):
                        # First generate returns tool call; second returns final reply
                        calls = [
                            json.dumps(payload),
                            json.dumps({"reply": "X est banni.", "tools": []}),
                        ]

                        def gen2(*_a, **_k):
                            return calls.pop(0), "test-model"

                        with mock.patch("hq_ai.generate", side_effect=gen2):
                            out = musica.chat("ban X")
        self.assertTrue(out["ok"])
        self.assertIn("banni", out["reply"].casefold())
        self.assertTrue(out["tools"][0]["ok"])
        self.assertIn("X", musica.get_taste()["banned_artists"])

    def test_http_routes(self):
        code, body = musica.http_get("/api/musica/thread")
        self.assertEqual(code, 200)
        self.assertTrue(body["ok"])
        code, body = musica.http_post("/api/musica/clear", {})
        self.assertEqual(code, 200)
        code, body = musica.http_get("/api/musica/nope")
        self.assertEqual(code, 404)

    def test_model_gets_handles_and_no_account_or_machine_details(self):
        import hq_ai

        private = ["private-user-172", "HQ-HOST-88", r"C:\Users\HQUser\Spotify.exe",
                   "spotify:track:sample", "open.spotify.com", "/api/spotify/image"]
        track = {"id": "sample", "uri": private[3], "name": "Sample", "artists": ["Artist"],
                 "album": "Album", "image": "/api/spotify/image?url=https://open.spotify.com/sample"}
        responses = [
            {"tools": [{"name": "get_status"}, {"name": "search_tracks", "args": {"q": "Sample"}}]},
            {"reply": "Sample est disponible."},
        ]
        status = {"connected": True, "user_id": private[0],
                  "local": {"hostnames": [private[1]], "path": private[2]}}
        with mock.patch("hq_spotify.status", return_value=status), \
             mock.patch("hq_spotify.list_devices", return_value={"devices": [
                 {"id": "device-id", "name": private[1], "type": "Computer", "is_active": True}
             ]}), mock.patch("hq_music.get_profile", return_value={"feedback_history": [private[0]]}), \
             mock.patch("hq_spotify.search", return_value={"tracks": [track]}), \
             mock.patch.object(hq_ai, "generate", side_effect=[(json.dumps(r), "test") for r in responses]) as gen:
            musica.chat("Cherche Sample")
        for call in gen.call_args_list:
            request = str(call.args[1:3])
            for value in private + ["device-id", "user_id"]:
                self.assertNotIn(value, request)
        self.assertIn('"handle": "t1"', str(gen.call_args.args[2]))
        self.assertIn('"handle": "d1"', str(gen.call_args.args[2]))
        self.assertEqual(musica._thread_state()["handles"]["t1"]["item"]["uri"], private[3])

    def test_history_preference_defaults_on_and_persists(self):
        self.assertTrue(musica.get_taste()["history_sharing"])
        code, _ = musica.http_post("/api/musica/taste", {"history_sharing": False})
        self.assertEqual(code, 200)
        self.assertFalse(musica.get_taste()["history_sharing"])

    def test_search_then_play_and_follow_up(self):
        import hq_ai

        tracks = [{"id": f"track{i}", "uri": f"spotify:track:track{i}", "name": name}
                  for i, name in enumerate(("First", "Second"), 1)]
        responses = [
            {"tools": [{"name": "search_tracks", "args": {"q": "Sabaton"}}]},
            {"tools": [{"name": "play", "args": {"track": "t1"}}]},
            {"reply": "Lecture lancée."},
            {"tools": [{"name": "play", "args": {"track": "t2"}}]},
            {"reply": "Second en lecture."},
        ]
        with mock.patch("hq_spotify.status", return_value={"connected": True}), \
             mock.patch("hq_music.get_profile", return_value={}), \
             mock.patch("hq_spotify.search", return_value={"tracks": tracks}), \
             mock.patch("hq_spotify.player_action", return_value={"ok": True}) as play, \
             mock.patch.object(hq_ai, "generate", side_effect=[(json.dumps(r), "test") for r in responses]) as gen:
            first = musica.chat("Joue du Sabaton")
            second = musica.chat("Joue la deuxième")
        self.assertEqual(first["cards"][1]["name"], "Second")
        self.assertTrue(second["actions"][0]["ok"])
        self.assertEqual([call.args[1]["uris"] for call in play.call_args_list],
                         [[tracks[0]["uri"]], [tracks[1]["uri"]]])
        self.assertIn('"handle": "t2"', str(gen.call_args_list[3].args[2]))

    def test_budget_and_invented_uri(self):
        import hq_ai

        response = {"tools": [{"name": "play", "args": {"track": "spotify:track:invented"}}] * 4}
        responses = [response, response, {"reply": "Aucune lecture.", **response}]
        with mock.patch("hq_spotify.status", return_value={"connected": True}), \
             mock.patch("hq_music.get_profile", return_value={}), \
             mock.patch("hq_spotify.player_action") as play, \
             mock.patch.object(hq_ai, "generate", side_effect=[(json.dumps(r), "test") for r in responses]) as gen:
            out = musica.chat("Joue ce morceau")
        play.assert_not_called()
        self.assertEqual(len(out["actions"]), musica.MAX_TOTAL_TOOLS)
        self.assertTrue(all(row["code"] == "unknown_reference" for row in out["actions"]))
        self.assertIn("Tool budget", gen.call_args.args[1])
        self.assertEqual(out["reply"], "Aucune lecture.")

    def test_artist_playback_recovers_when_model_only_suggests_and_dedupes_follow_up(self):
        import hq_ai

        tracks = [{"id": f"song{i}", "uri": f"spotify:track:song{i}", "name": title, "artists": ["Sabaton"]}
                  for i, title in enumerate(("First", "Second"), 1)]
        repeated = {"name": "play", "args": {"track": "t2"}}
        responses = [
            {"tools": [{"name": "play_album", "args": {"album": "Sabaton"}},
                       {"name": "search", "args": {"q": "Sabaton", "type": "track"}}]},
            {"reply": "Veux-tu que je joue quelque chose ?"},
            {"tools": [repeated, repeated]},
            {"tools": [repeated]},
            {"reply": "Second en lecture."},
        ]
        with mock.patch("hq_spotify.status", return_value={"connected": True}), \
             mock.patch("hq_music.get_profile", return_value={}), \
             mock.patch("hq_spotify.search", return_value={"tracks": tracks}), \
             mock.patch("hq_spotify.player_action", return_value={"ok": True}) as play, \
             mock.patch.object(hq_ai, "generate", side_effect=[(json.dumps(r), "test") for r in responses]):
            first = musica.chat("Musica, joue du Sabaton")
            second = musica.chat("joue la deuxième")
        self.assertIn("Playing \u201cFirst\u201d", first["reply"])
        self.assertEqual([call.args[1]["uris"] for call in play.call_args_list],
                         [[tracks[0]["uri"]], [tracks[1]["uri"]]])
        self.assertEqual(len(second["actions"]), 1)

    def test_confirmation_is_single_use(self):
        import hq_ai

        responses = [{"tools": [{"name": "delete_preset", "args": {"preset_id": "my-preset"}}]},
                     {"reply": "Confirme la suppression."}]
        with mock.patch("hq_spotify.status", return_value={"connected": False}), \
             mock.patch("hq_music.get_profile", return_value={}), \
             mock.patch("hq_music.delete_preset") as delete, \
             mock.patch.object(hq_ai, "generate", side_effect=[(json.dumps(r), "test") for r in responses]):
            out = musica.chat("Supprime ce préréglage")
            delete.assert_not_called()
            token = out["actions"][0]["token"]
            self.assertEqual(musica.http_post("/api/musica/confirm", {"token": token})[0], 200)
            self.assertEqual(musica.http_post("/api/musica/confirm", {"token": token})[0], 409)
            delete.assert_called_once_with("my-preset")

    def test_disabling_history_omits_old_history_and_blocks_tool(self):
        import hq_ai

        responses = [
            {"tools": [{"name": "my_top"}]}, {"reply": "Private Artist."},
            {"tools": [{"name": "my_top"}]}, {"reply": "Partage désactivé."},
        ]
        with mock.patch("hq_spotify.status", return_value={"connected": True}), \
             mock.patch("hq_music.get_profile", return_value={}), \
             mock.patch("hq_spotify.api_request", return_value={"items": [
                 {"id": "private", "uri": "spotify:artist:private", "name": "Private Artist"}
             ]}) as spotify, \
             mock.patch.object(hq_ai, "generate", side_effect=[(json.dumps(r), "test") for r in responses]) as gen:
            musica.chat("Mon top du mois")
            musica.http_post("/api/musica/taste", {"history_sharing": False})
            out = musica.chat("Encore mon top")
        self.assertEqual(spotify.call_count, 1)
        self.assertNotIn("Private Artist", str(gen.call_args_list[2].args))
        self.assertNotIn("- my_top", gen.call_args_list[2].args[1])
        self.assertEqual(out["tools"][0]["code"], "history_disabled")

    def test_voice_route_uses_local_tts_and_strips_markup(self):
        url = "/assets/companion/chat/voice_cache/voice_123abc.wav"
        with mock.patch("hq_voice.synthesize", return_value={"ok": True, "audio_url": url}) as tts:
            code, result = musica.http_post("/api/musica/speak", {
                "text": "**Bonsoir** [Maître](https://example.com)", "language": "fr",
            })
        self.assertEqual((code, result["audio_url"]), (200, url))
        self.assertEqual(tts.call_args.args[0], "Bonsoir Maître")
        with mock.patch("hq_voice.synthesize", return_value={"ok": True, "audio_url": "https://invalid"}):
            self.assertEqual(musica.http_post("/api/musica/speak", {"text": "Bonsoir"})[0], 503)

    def test_album_artist_and_playlist_tools_resolve_catalog_handles(self):
        album = {"id": "album", "uri": "spotify:album:album", "name": "Album", "artists": ["Band"]}
        artist = {"id": "artist", "uri": "spotify:artist:artist", "name": "Band"}
        track = {"id": "track", "uri": "spotify:track:track", "name": "Song"}
        playlist = {"id": "mine1234567890", "uri": "spotify:playlist:mine1234567890", "name": "Mine"}
        refs = musica.ThreadReferences({})
        refs.add("album", album)
        refs.add("artist", artist)
        refs.add("track", track)
        refs.add("playlist", playlist)

        def tool(tool_name, **args):
            result = musica.execute_tools([{"name": tool_name, "args": args}], refs)[0]
            self.assertTrue(result["ok"], result)
            return result["result"]

        with mock.patch("hq_spotify.api_request", return_value={"id": "album", "tracks": {"items": []}}) as api:
            tool("open_album", album="a1")
            self.assertEqual(api.call_args.args, ("GET", "/albums/album"))
        with mock.patch("hq_spotify.api_request", return_value={"items": []}) as api:
            tool("artist_albums", artist="r1")
            self.assertEqual(api.call_args.kwargs["query"]["include_groups"], "album,single")
            tool("artist_tracks", artist="r1")
            self.assertEqual(api.call_args.kwargs["query"]["q"], 'artist:"Band"')
        with mock.patch("hq_spotify.player_action", return_value={"ok": True}) as player:
            tool("play_album", album="a1")
            self.assertEqual(player.call_args.args[1]["context_uri"], album["uri"])
        with mock.patch("hq_spotify.api_request", return_value={"id": "mine", "name": "Mine"}) as api:
            tool("create_playlist", name="Mine")
            self.assertFalse(api.call_args.kwargs["body"]["public"])
            tool("add_to_playlist", playlist="p1", track="t1")
            self.assertEqual(api.call_args.kwargs["body"]["uris"], [track["uri"]])
        tool("save_album", album="a1")
        self.assertEqual(hq_music.get_taste()["loved"][0]["uri"], album["uri"])


if __name__ == "__main__":
    unittest.main()

    def test_cancel_is_job_scoped_and_stops_before_storing(self):
        self.assertFalse(musica.request_cancel("nope")["cancelled"])
        self.assertTrue(musica.request_cancel("mus-testjob")["cancelled"])
        self.assertTrue(musica._is_cancelled("mus-testjob"))
        self.assertFalse(musica._is_cancelled(""))
        with mock.patch("hq_ai.generate") as generate:
            out = musica.chat("Salut Musica", job="mus-testjob")
        generate.assert_not_called()
        self.assertTrue(out["cancelled"])
        self.assertEqual(musica.get_thread()["messages"], [])

    def test_cancel_route_answers(self):
        code, payload = musica.http_post("/api/musica/cancel", {"job": "mus-routejob"})
        self.assertEqual(code, 200)
        self.assertTrue(payload["cancelled"])

    def test_beat_grid_roundtrip_and_tap_wins_over_live(self):
        code, payload = musica.http_get("/api/musica/beats/s-abc123")
        self.assertEqual((code, payload["grid"]), (200, None))
        code, payload = musica.http_post("/api/musica/beats", {
            "key": "s-abc123", "source": "tap", "bpm": 128.04, "offset": 30.25, "confidence": 1})
        self.assertEqual(code, 200)
        code, payload = musica.http_post("/api/musica/beats", {
            "key": "s-abc123", "source": "live", "bpm": 64.0, "offset": 1.0, "confidence": 0.4,
            "energy": [0.2, 1, 0.5], "energy_step": 1, "drops": [61.5, 30.0]})
        grid = musica.http_get("/api/musica/beats/s-abc123")[1]["grid"]
        self.assertEqual((grid["bpm"], grid["offset"], grid["source"]), (128.04, 30.25, "tap"))
        self.assertEqual(grid["energy"], [0.2, 1.0, 0.5])
        self.assertEqual(grid["drops"], [30.0, 61.5])

    def test_beat_grid_rejects_bad_input(self):
        bad = [
            {"key": "../x", "source": "tap", "bpm": 120, "offset": 0},
            {"key": "s-a", "source": "guess", "bpm": 120, "offset": 0},
            {"key": "s-a", "source": "tap", "bpm": 500, "offset": 0},
            {"key": "s-a", "source": "tap", "bpm": True, "offset": 0},
            {"key": "s-a", "source": "live", "bpm": 120, "offset": 0, "energy": [2]},
            {"key": "s-a", "source": "live", "bpm": 120, "offset": 0, "drops": list(range(30))},
        ]
        for body in bad:
            code, payload = musica.http_post("/api/musica/beats", body)
            self.assertEqual((code, payload["code"]), (400, "validation_error"), body)
        self.assertEqual(musica.http_get("/api/musica/beats/a b")[0], 400)

    def test_beat_grid_store_is_bounded(self):
        with mock.patch.object(musica, "MAX_BEAT_GRIDS", 3):
            for i in range(5):
                musica.save_beat_grid({"key": f"l-{i}", "source": "live", "bpm": 120, "offset": 0.5})
        self.assertIsNone(musica.beat_grid("l-0")["grid"])
        self.assertIsNotNone(musica.beat_grid("l-4")["grid"])

    def test_discover_from_profile_rotates_seeds_and_skips_fatigued(self):
        import hq_musica_profile as mp
        mp.save_overrides({"boosted_artists": ["SeedBoost", "SeedSecond"], "boosted_genres": ["darksynth", "ebm"]})
        mp._save_analysis({
            "version": 2,
            "analyzed_utc": "2026-11-15T12:00:00Z",
            "history_sharing": True,
            "artist_affinities": [
                {"name": "TiredBand", "score": 90.0},
                {"name": "FreshBand", "score": 70.0},
            ],
            "genre_profile": {"top_genres": [{"genre": "industrial", "score": 9}], "surging_genres": ["aggrotech"]},
            "fatigue_profile": {"overplay_fatigue": [{"name": "TiredBand"}]},
        })
        seen_calls = []

        def fake_disc(seed, genre, limit=15, known_artists=()):
            seen_calls.append((seed, genre))
            idx = len(seen_calls)
            return [{"uri": f"spotify:track:d{idx}", "name": f"D{idx}", "artists": [seed], "why": "w"}]

        with mock.patch.object(musica, "listening_snapshot", return_value={"top": {}, "recent": []}), \
             mock.patch("hq_music_radar.discovery_tracks", side_effect=fake_disc):
            out = musica._run_tool("discover_from_profile", {"limit": 4, "unknown_only": True})
        self.assertGreaterEqual(len(seen_calls), 2)
        self.assertTrue(all(seed != "TiredBand" for seed, _ in seen_calls))
        self.assertEqual(len({s for s, _ in seen_calls}), 2)
        self.assertEqual(len(out["tracks"]), 2)


class SpeechIdentityTests(unittest.TestCase):
    """Her speech may only describe a song the client actually identified (wrong-song report, 2026-11-18)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        musica.reset_for_tests()
        musica.bind(root=self.tmp.name)
        hq_music.bind(root=self.tmp.name)

    def tearDown(self):
        musica.reset_for_tests()
        hq_music.reset_for_tests()
        self.tmp.cleanup()

    def test_dance_prompt_names_the_known_song(self):
        song, ctx, rule = musica.dance_prompt_context(
            track="Song A", artist="Band A", album="", intensity=0.9, bpm=140,
            song_sec=30, duration_sec=200, lyric_hint="hello", late_night=False, hits=0, replays=3,
        )
        self.assertIn("Song A", song)
        self.assertIn("replayed this track 3", ctx)
        self.assertIn("HEAR THIS EXACT SONG", rule)

    def test_dance_prompt_without_a_song_never_names_one(self):
        song, ctx, rule = musica.dance_prompt_context(
            track="", artist="", album="", intensity=0.7, bpm=0,
            song_sec=0, duration_sec=0, lyric_hint="", late_night=True, hits=0, replays=0,
        )
        self.assertNotIn("recently played", (song + ctx + rule).lower())
        self.assertIn("you do not know", ctx.lower())
        self.assertIn("never name", ctx.lower())
        self.assertIn("never name", rule.lower())

    def test_ambient_without_a_song_forbids_naming_one(self):
        unknown = musica.ambient_now_playing("", "", False).lower()
        self.assertIn("never name", unknown)
        self.assertNotIn("recent track", unknown)
        self.assertIn("Song A", musica.ambient_now_playing("Song A", "Band A", True))

    def test_speech_log_is_bounded_and_routed(self):
        self.assertEqual(musica.MAX_SPEECH_ITEMS, 200)
        for i in range(5):
            code, _ = musica.http_post("/api/musica/speech", {
                "key": "l-abc", "title": "Song A", "source": "local",
                "kind": "start", "model": "pack", "text": "line %d" % i,
            })
            self.assertEqual(code, 200)
        code, payload = musica.http_get("/api/musica/speech")
        self.assertEqual(code, 200)
        self.assertEqual([row["text"] for row in payload["items"]], ["line %d" % i for i in range(5)])
        self.assertEqual(payload["items"][-1]["key"], "l-abc")
        self.assertEqual(payload["items"][-1]["source"], "local")

    def test_empty_speech_is_rejected(self):
        code, payload = musica.http_post("/api/musica/speech", {"text": "  "})
        self.assertEqual(code, 400)
        self.assertEqual(payload["code"], "validation_error")

    def test_play_memory_keeps_the_source(self):
        musica._record_play_memory("Song A", "Band A", "local")
        musica._record_play_memory("Song A", "Band A", "local")
        rows = musica._get_play_memory(5)
        self.assertEqual(rows[0]["track"], "Song A")
        self.assertEqual(rows[0]["source"], "local")
        self.assertEqual(rows[0]["play_count"], 1)

    def test_play_memory_source_is_unknown_when_absent(self):
        # Old rows and callers that never knew the source must not be reported as Spotify.
        musica._record_play_memory("Old Local Song", "Someone")
        rows = musica._get_play_memory(5)
        self.assertEqual(rows[0]["track"], "Old Local Song")
        self.assertEqual(rows[0]["source"], "")


class SongTitleOverrideTests(unittest.TestCase):
    """The owner's title lives in .hq-music state, so every device and the prompt itself use it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        musica.reset_for_tests()
        musica.bind(root=self.tmp.name)
        hq_music.bind(root=self.tmp.name)

    def tearDown(self):
        musica.reset_for_tests()
        hq_music.reset_for_tests()
        self.tmp.cleanup()

    def test_override_round_trips_and_the_prompt_uses_it(self):
        code, payload = musica.http_post("/api/musica/song-titles", {"key": "l-abc", "title": "Le vrai titre", "artist": "Elle"})
        self.assertEqual(code, 200)
        self.assertEqual(payload["item"]["title"], "Le vrai titre")
        code, got = musica.http_get("/api/musica/song-titles/l-abc")
        self.assertEqual(code, 200)
        self.assertEqual(got["item"]["artist"], "Elle")
        song, _ctx, _rule = musica.dance_prompt_context(
            track="track01", artist="", album="", intensity=0.8, bpm=0, song_sec=0,
            duration_sec=0, lyric_hint="", late_night=False, hits=0, replays=0, key="l-abc",
        )
        self.assertIn("Le vrai titre", song)
        self.assertNotIn("track01", song)

    def test_clearing_restores_the_detected_title(self):
        musica.http_post("/api/musica/song-titles", {"key": "s-abc", "title": "Titre"})
        code, payload = musica.http_post("/api/musica/song-titles", {"key": "s-abc", "title": ""})
        self.assertEqual(code, 200)
        self.assertEqual(payload["item"], {})
        self.assertEqual(musica.song_title_get("s-abc"), {})
        self.assertEqual(musica.http_get("/api/musica/song-titles")[1]["items"], {})

    def test_bad_key_is_rejected(self):
        code, payload = musica.http_post("/api/musica/song-titles", {"key": "../x", "title": "T"})
        self.assertEqual(code, 400)
        self.assertEqual(payload["code"], "validation_error")

    def test_override_is_per_key(self):
        musica.http_post("/api/musica/song-titles", {"key": "l-one", "title": "One"})
        self.assertEqual(musica.song_title_get("l-two"), {})

    def test_conceal_route_reads_the_blind_duel(self):
        from unittest import mock
        import hq_music_dj
        with mock.patch.object(hq_music_dj, "_state", return_value={"duel": {"blind": True, "vote": None}}):
            code, payload = musica.http_get("/api/musica/conceal")
        self.assertEqual(code, 200)
        self.assertTrue(payload["concealed"])
        with mock.patch.object(hq_music_dj, "_state", return_value={"duel": {"blind": True, "vote": "a"}}):
            self.assertFalse(musica.http_get("/api/musica/conceal")[1]["concealed"])
