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
