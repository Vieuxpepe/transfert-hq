"""DJ Musica show engine: settings, planning, drops, observe/advance/skip, steering, schedules, jingles."""
from datetime import datetime
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import hq_music
import hq_music_dj as dj
import hq_musica
import hq_spotify


def row(i, pool="top"):
    return {"uri": f"spotify:track:{i}", "name": f"Song {i}", "artists": [f"Artist {i}"], "album": "A",
            "image": None, "duration_ms": 200000, "why": f"raison {i}", "pool": pool}


POOLS = {"top": [row(i) for i in range(1, 9)], "premiere": [row(99, "premiere")]}


class DjBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        hq_musica.bind(root=self.tmp.name)
        self.addCleanup(dj.stop_station)
        dj._prep.clear()
        self.addCleanup(dj._prep.clear)
        patcher = mock.patch.object(dj, "candidate_pools", return_value=POOLS)
        patcher.start()
        self.addCleanup(patcher.stop)
        # live reactions must never start real voice work from a test: no warm-up thread, no queued line voice
        import hq_music_dj_live as live
        for name, value in (("warm_due", False), ("queue_voice", None)):
            quiet = mock.patch.object(live, name, return_value=value)
            quiet.start()
            self.addCleanup(quiet.stop)

    def model(self, payload):
        return mock.patch("hq_ai.generate", return_value=(json.dumps(payload), "m"))


class SettingsTests(DjBase):
    def test_validation_and_defaults(self):
        self.assertEqual(dj.settings()["chattiness"], "normal")
        with mock.patch.object(dj, "start_station") as start_station:
            out = dj.update_settings({"chattiness": "bavarde", "guests": "souvent", "station": True,
                                      "morning": {"enabled": True, "time": "06:45", "days": [0, 2, 2]}})
            start_station.assert_called_once()
        self.assertEqual(out["morning"], {"enabled": True, "time": "06:45", "days": [0, 2]})
        for bad in ({"chattiness": "loud"}, {"morning": {"time": "25:00"}}, {"station": "yes"},
                    {"morning": {"days": [9]}}):
            with self.assertRaises(dj.DjError):
                dj.update_settings(bad)


class PlanTests(DjBase):
    def test_plan_keeps_only_candidate_handles_and_budget(self):
        payload = {"title": "Retour aux sources", "theme": "nostalgie", "tracks": ["c2", "c3", "zz", "c4", "c2"],
                   "intro": "**On remonte** le temps.", "lines": {"c3": "Celle-ci, tu l'adorais.", "c2": "x"},
                   "guest_line": ""}
        with self.model(payload) as gen:
            seg = dj.plan_segment()
        # c1 is the premiere row (premiere pool comes first); c2..c4 are top rows 1..3; "zz" and the repeat are dropped.
        self.assertEqual([t["uri"] for t in seg["tracks"]], ["spotify:track:1", "spotify:track:2", "spotify:track:3"])
        self.assertNotIn("**", seg["intro"])
        self.assertIsNone(seg["tracks"][0]["line"])  # never a line on the first track (the intro covers it)
        self.assertIn("candidats", gen.call_args.args[2][0]["parts"][0]["text"].casefold())

    def test_default_direction_is_more_energy_and_a_steer_replaces_it(self):
        self.assertEqual(dj.settings()["direction"], "energie")
        reply = {"tracks": ["c1", "c2", "c3"], "intro": "x"}
        with self.model(reply) as gen:
            dj.plan_segment()
        self.assertIn(dj.STEER_PRESETS["energie"], gen.call_args.args[2][0]["parts"][0]["text"])
        with self.model(reply) as gen:
            dj.plan_segment(steer="Du jazz.")
        self.assertNotIn("Direction par défaut", gen.call_args.args[2][0]["parts"][0]["text"])
        dj.update_settings({"direction": "aucune"})
        with self.model(reply) as gen:
            dj.plan_segment()
        self.assertNotIn("Direction par défaut", gen.call_args.args[2][0]["parts"][0]["text"])
        with self.assertRaises(dj.DjError):
            dj.update_settings({"direction": "loud"})

    def test_discreet_has_no_track_lines_and_fallback_without_model(self):
        dj.update_settings({"chattiness": "discret"})
        with self.model({"tracks": ["c1", "c2", "c3"], "intro": "Salut.", "lines": {"c2": "ligne", "c3": "ligne"}}):
            seg = dj.plan_segment()
        self.assertTrue(all(t["line"] is None for t in seg["tracks"]))
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            seg = dj.plan_segment()
        self.assertEqual(len(seg["tracks"]), 5)
        self.assertTrue(seg["intro"])

    def test_guest_requested_and_recent_uris_excluded(self):
        dj.request_guest("transferania")
        state = dj._state()
        state["recent_uris"] = [r["uri"] for r in POOLS["top"][:6]]
        payload = {"tracks": ["c1", "c2", "c3"], "intro": "On y va.", "guest_line": "Coucou Maître !!"}
        with self.model(payload) as gen:
            seg = dj.plan_segment(state=state)
        self.assertIn("Transferania", gen.call_args.args[1])
        self.assertEqual(seg["guest"]["who"], "transferania")
        self.assertFalse({t["uri"] for t in seg["tracks"]} & set(state["recent_uris"]))
        with self.assertRaises(dj.DjError):
            dj.request_guest("static")

    def test_not_enough_candidates(self):
        with mock.patch.object(dj, "candidate_pools", return_value={"top": [row(1)]}):
            with self.assertRaises(dj.DjError) as caught:
                dj.plan_segment()
        self.assertEqual(caught.exception.code, "dj_not_enough")


class FlowTests(DjBase):
    def segment(self, ids, sid):
        tracks = [dict(row(i), line=f"ligne {i}" if i != ids[0] else None, drop=f"drop-{i:020d}.mp3") for i in ids]
        return {"id": sid, "show": "dj", "title": f"S{sid}", "theme": "", "intro": "Intro " + sid,
                "intro_drop": "drop-" + "a" * 20 + ".mp3", "guest": None, "tracks": tracks, "premiere_uris": []}

    def test_start_observe_advance_skip_and_leave(self):
        first = self.segment([1, 2, 3], "one")
        second = self.segment([4, 5, 6], "two")
        with mock.patch.object(dj, "plan_segment", side_effect=[first, second]), \
             mock.patch.object(dj, "make_drop", return_value=None), \
             mock.patch.object(dj, "_spawn") as spawn, \
             mock.patch.object(hq_spotify, "player_action") as action:
            out = dj.start({"show": "dj"})
            self.assertTrue(out["active"])
            # Her voice first: nothing plays until her intro is over (go), a fallback is armed.
            self.assertNotIn("play", [c.args[0] for c in action.call_args_list])
            self.assertEqual(out["awaiting"]["segment_id"], "one")
            self.assertEqual(out["awaiting"]["drops"], [])  # make_drop is mocked out: no recorded intro here
            self.assertEqual([c.args[0] for c in spawn.call_args_list], ["go-fallback"])
            started = dj.go("one")
            self.assertTrue(started["started"])
            self.assertIsNone(started["awaiting"])
            self.assertFalse(dj.go("one")["started"])  # idempotent: browser, station and fallback may all call it
            plays = [c for c in action.call_args_list if c.args[0] == "play"]
            self.assertEqual(plays[-1].args[1]["uris"], [t["uri"] for t in first["tracks"]])
            self.assertEqual([c.args[0] for c in spawn.call_args_list][1:], ["prepare-current", "plan-next"])
            # Track 2: its prepared line; skip of track 1 after 10 s counts as "not now".
            with mock.patch.object(hq_music, "record_feedback") as feedback:
                answer = dj.observe("spotify:track:2", "spotify:track:1", 10000)
                feedback.assert_called_once()
                self.assertEqual(feedback.call_args.kwargs["action"], "dismiss")
            self.assertEqual(answer["drops"], ["drop-00000000000000000002.mp3"])
            self.assertTrue(dj.observe("spotify:track:2")["duplicate"])
            # Last track: plan the next segment (in background) and queue it.
            dj.observe("spotify:track:3", "spotify:track:2", 190000)
            self.assertEqual(spawn.call_args.args[0], "plan-next")
            with mock.patch.object(dj, "_prepare_drops"),                  mock.patch.object(hq_spotify, "append_playback_tracks") as append:
                dj._plan_next("one")
            append.assert_called_once_with([t["uri"] for t in second["tracks"]])  # the playing context flows on
            promoted = dj.observe("spotify:track:4", "spotify:track:3", 200000)
            self.assertTrue(promoted["segment_start"])
            self.assertTrue(promoted["voice_first"])  # drivers pause, play her intro, then the song from its start
            self.assertEqual(promoted["drops"], [second["intro_drop"]])
            self.assertEqual(dj._state()["segment"]["id"], "two")
            left = dj.observe("spotify:track:777")
            self.assertTrue(left["left"])
            self.assertFalse(dj._state()["active"])

    def test_second_quick_skip_becomes_dislike(self):
        with mock.patch.object(dj, "plan_segment", return_value=self.segment([1, 2, 3], "one")), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"), \
             mock.patch.object(hq_music, "record_feedback") as feedback:
            dj.start({})
            dj.record_skip("spotify:track:1")
            dj.record_skip("spotify:track:1")
        self.assertEqual([c.kwargs["action"] for c in feedback.call_args_list], ["dismiss", "dislike"])

    def test_playback_failure_still_returns_show(self):
        err = hq_spotify.SpotifyError("no device", 404, "spotify_no_device")
        with mock.patch.object(dj, "plan_segment", return_value=self.segment([1, 2, 3], "one")), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action", side_effect=err):
            dj.start({})
            out = dj.go()
        self.assertEqual(out["playback"]["code"], "spotify_no_device")

    def test_steer_ban_preset_bans_current_artist(self):
        seg = self.segment([1, 2, 3], "one")
        with mock.patch.object(dj, "plan_segment", return_value=seg) as plan, \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"):
            dj.start({})
            dj.steer({"preset": "ban"})
            self.assertIn("Artist 1", plan.call_args.kwargs["steer"])
        self.assertIn("Artist 1", hq_music.get_taste()["banned_artists"])
        with self.assertRaises(dj.DjError):
            dj.steer({})


class ScheduleTests(DjBase):
    def test_morning_due_once_and_notifies(self):
        sent = []
        hq_music.bind(root=self.tmp.name, notify=lambda t, b: sent.append(t))
        dj.update_settings({"morning": {"enabled": True, "time": "07:30", "days": [3]}})
        thursday = datetime(2026, 11, 12, 7, 40)
        dj.tick(thursday)
        self.assertEqual(dj._state()["pending_show"], "matinale")
        self.assertEqual(sent, ["DJ Musica"])
        dj.tick(thursday)
        self.assertEqual(len(sent), 1)
        dj.update_settings({"recap": {"enabled": True}})
        dj.tick(datetime(2026, 11, 13, 18, 5))  # Friday: no recap
        self.assertEqual(len(sent), 1)

    def test_premiere_hook(self):
        dj.note_releases([{"id": "a", "uri": "spotify:album:a", "name": "A", "artists": ["X"]}])
        self.assertEqual(dj.public_state()["pending_premiere"], 1)
        dj.update_settings({"premiere": False})
        dj.note_releases([{"id": "b", "uri": "spotify:album:b"}])
        self.assertEqual(dj.public_state()["pending_premiere"], 1)


class DropTests(DjBase):
    def test_drop_path_validation(self):
        for bad in ("../x.mp3", "drop-zz.mp3", "voice.wav"):
            with self.assertRaises(dj.DjError):
                dj.drop_path(bad)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_real_mix_jingle_voice_bed(self):
        base = Path(self.tmp.name)
        def tone(name, freq, seconds):
            path = base / name
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}",
                            str(path)], check=True)
            return path
        voice, jingle, bed = tone("v.wav", 440, 2), tone("j.wav", 880, 5), tone("b.wav", 220, 1)
        out = base / "mix.mp3"
        self.assertTrue(dj._mix(voice, jingle=jingle, bed=bed, out=out))
        probe = subprocess.run(["ffmpeg", "-i", str(out), "-f", "null", "-"], capture_output=True, text=True)
        self.assertIn("time=00:00:06", probe.stderr)  # 3.5 s jingle + 2 s voice + 0.5 s pad
        self.assertTrue(dj._mix(voice, jingle=None, bed=None, out=base / "plain.mp3"))


class JingleTests(DjBase):
    def test_jingle_jobs_hidden_from_studio_list(self):
        import hq_music_studio as studio
        root = Path(self.tmp.name)
        for ident, extra in (("a" * 32, {"jingle": "ident"}), ("b" * 32, {})):
            folder = root / ".hq-music" / "studio" / ident
            folder.mkdir(parents=True)
            (folder / "job.json").write_text(json.dumps({"id": ident, "status": "running", **extra}), encoding="utf-8")
        self.assertEqual([j["id"] for j in studio.list_jobs(root)], ["b" * 32])
        self.assertEqual(len(studio.list_jobs(root, include_jingles=True)), 2)

    def test_make_jingles_starts_first_missing(self):
        with mock.patch("hq_music_studio.start", return_value={"id": "c" * 32}) as start:
            out = dj.make_jingles()
        self.assertEqual(out["started"], "ident")
        self.assertEqual(start.call_args.kwargs["jingle"], "ident")
        self.assertEqual(dj.settings()["jingle_jobs"]["ident"], "c" * 32)


class LearningTests(DjBase):
    def seg(self):
        tracks = [dict(row(i), line=None, drop=None) for i in (1, 2, 3)]
        return {"id": "one", "show": "dj", "title": "S", "theme": "", "intro": "Intro", "intro_drop": None,
                "guest": None, "tracks": tracks, "premiere_uris": [], "joke": "Troisième fois, je connais le refrain."}

    def started(self):
        with mock.patch.object(dj, "plan_segment", return_value=self.seg()),              mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"),              mock.patch.object(hq_spotify, "player_action"):
            dj.start({})

    def test_completion_is_a_light_like_then_a_real_like(self):
        self.started()
        with mock.patch.object(hq_music, "record_feedback") as feedback:
            dj.observe("spotify:track:2", "spotify:track:1", 195000)  # 200 s track played to the end
            self.assertEqual(dj._state()["completions"]["spotify:track:1"], 1)
            feedback.assert_not_called()
            dj.record_completion("spotify:track:1")
            dj.record_completion("spotify:track:1")
            self.assertEqual(feedback.call_args.kwargs["action"], "like")
        stats = dj._state()["pool_stats"]["top"]
        self.assertEqual(stats["done"], 3)
        self.assertGreater(dj.taste_profile()["scores"]["artist 1"], 0)

    def test_profile_ranks_likes_and_cools_skips_and_boosts_candidates(self):
        hq_music.record_feedback("Artist 7", "Song 7", True, action="like", uri="spotify:track:7")
        self.started()
        with mock.patch.object(hq_music, "record_feedback"):
            for _ in range(3):
                dj.record_skip("spotify:track:2")
        profile = dj.taste_profile()
        self.assertEqual(profile["artists"][0]["name"], "Artist 7")
        self.assertIn("Artist 2", [a["name"] for a in profile["cooling"]])
        state = dj._state()
        state["recent_uris"] = []
        with mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3"], "intro": "x"}), "m")) as gen:
            dj.plan_segment(state=state)
        listing = gen.call_args.args[2][0]["parts"][0]["text"]
        self.assertIn('"aime": true', listing)
        self.assertLess(listing.index("Song 7"), listing.index("Song 2"))  # loved artist boosted, skipped one pushed back
        self.assertIn("Goûts appris", listing)
        self.assertIn("Artist 7", listing)

    def test_steers_remembered_jokes_not_repeated_and_reset(self):
        self.started()
        self.assertIn("Troisième fois", dj._state()["recent_jokes"][-1])
        with mock.patch.object(dj, "start", return_value={}) as start:
            dj.steer({"preset": "calme"})
        self.assertEqual(dj._state()["steers"][-1]["text"], dj.STEER_PRESETS["calme"])
        state = dj._state()
        state["segments_done"] = 2
        dj.update_settings({"humor": "parfois"})
        with mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3"], "intro": "x",
                                                                   "joke": "Nouvelle blague"}), "m")) as gen:
            seg = dj.plan_segment(state=state)
        self.assertIn("Troisième fois", gen.call_args.args[1])  # told not to reuse it
        self.assertEqual(seg["joke"], "Nouvelle blague")
        dj.update_settings({"humor": "jamais"})
        with mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3"], "intro": "x"}), "m")) as gen:
            dj.plan_segment(state=state)
        self.assertIn("Pas de blague", gen.call_args.args[1])
        with self.assertRaises(dj.DjError):
            dj.update_settings({"humor": "toujours"})
        out = dj.reset_learned()
        self.assertEqual(out["learned"]["steers"], [])
        self.assertEqual(dj._state()["recent_jokes"], [])

    def test_history_off_sends_no_taste_brief(self):
        hq_music.update_taste({"history_sharing": False})
        hq_music.record_feedback("Artist 7", "Song 7", True, action="like", uri="spotify:track:7")
        with mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3"], "intro": "x"}), "m")) as gen:
            dj.plan_segment()
        self.assertNotIn("Goûts appris", gen.call_args.args[2][0]["parts"][0]["text"])


class PrepTests(DjBase):
    def wait(self):
        import time
        for _ in range(200):
            if not dj._prep.get("running"):
                return
            time.sleep(0.01)
        self.fail("preparation did not finish")

    def test_start_route_returns_at_once_and_reports_progress(self):
        import threading
        gate = threading.Event()
        seen = []
        seg = {"id": "s", "show": "dj", "title": "T", "theme": "", "intro": "Intro", "intro_drop": None, "guest": None,
               "tracks": [dict(row(i), line=None, drop=None) for i in (1, 2, 3)], "premiere_uris": [], "joke": None}

        def slow_plan(**_kwargs):
            dj._progress("pools")
            seen.append(dj.prep_view()["stage"])
            gate.wait(2)
            dj._progress("writing")
            return seg

        with mock.patch.object(dj, "plan_segment", side_effect=slow_plan),              mock.patch.object(dj, "make_drop", return_value="drop-" + "b" * 20 + ".mp3"),              mock.patch.object(dj, "_spawn"), mock.patch.object(hq_spotify, "player_action"):
            code, out = dj.http_post("/api/musica/dj/start", {"show": "dj"})
            self.assertEqual(code, 202)
            self.assertTrue(out["prep"]["running"])
            self.assertEqual(dj.http_post("/api/musica/dj/start", {})[1]["prep"]["id"], out["prep"]["id"])  # no double start
            gate.set()
            self.wait()
        view = dj.prep_view()
        self.assertEqual((view["stage"], view["pct"]), ("done", 100))
        self.assertEqual(view["announce"]["drops"], ["drop-" + "b" * 20 + ".mp3"])
        self.assertEqual(seen, ["pools"])
        self.assertTrue(dj.public_state()["active"])

    def test_failure_is_reported_in_prep(self):
        with mock.patch.object(dj, "plan_segment", side_effect=dj.DjError("Pas assez", 409, "dj_not_enough")):
            dj.begin("start", {})
            self.wait()
        view = dj.prep_view()
        self.assertEqual(view["code"], "dj_not_enough")
        self.assertFalse(view["running"])
        self.assertEqual(dj.http_post("/api/musica/dj/steer", {})[0], 400)


class PlaybackPlaylistTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        hq_spotify.bind(root=self.tmp.name, config_getter=lambda: {})
        self.addCleanup(hq_spotify.reset_for_tests)

    def test_track_lists_play_through_the_private_playlist(self):
        calls = []

        def api(method, path, **kwargs):
            calls.append((method, path, kwargs.get("body")))
            if path == "/me/playlists":
                return {"id": "PL1aaaaaaaaaaaaaaaaaaa", "uri": "spotify:playlist:PL1aaaaaaaaaaaaaaaaaaa", "name": "Musica · Lecture"}
            return {}

        with mock.patch.object(hq_spotify, "api_request", side_effect=api),              mock.patch.object(hq_spotify, "ensure_playback_device", return_value={"id": "dev"}):
            hq_spotify.player_action("play", {"uris": ["spotify:track:a", "spotify:track:b"], "position_ms": 5000})
            hq_spotify.player_action("play", {"uris": ["spotify:track:c"]})
        replaced = [c for c in calls if c[0] == "PUT" and c[1] == "/playlists/PL1aaaaaaaaaaaaaaaaaaa/items"]
        self.assertEqual([c[2]["uris"] for c in replaced], [["spotify:track:a", "spotify:track:b"], ["spotify:track:c"]])
        plays = [c[2] for c in calls if c[1] == "/me/player/play"]
        self.assertEqual(plays[0], {"context_uri": "spotify:playlist:PL1aaaaaaaaaaaaaaaaaaa", "offset": {"position": 0}, "position_ms": 5000})
        self.assertEqual(len([c for c in calls if c[1] == "/me/playlists"]), 1)  # created once, then reused
        with mock.patch.object(hq_spotify, "api_request", side_effect=api):
            hq_spotify.append_playback_tracks(["spotify:track:d"])
        self.assertEqual(calls[-1][:2], ("POST", "/playlists/PL1aaaaaaaaaaaaaaaaaaa/items"))

    def test_deleted_playlist_is_recreated(self):
        made = iter(["PL1aaaaaaaaaaaaaaaaaaa", "PL2bbbbbbbbbbbbbbbbbbb"])
        def api(method, path, **kwargs):
            if path == "/me/playlists":
                pid = next(made)
                return {"id": pid, "uri": f"spotify:playlist:{pid}"}
            if method == "PUT" and path == "/playlists/PL1aaaaaaaaaaaaaaaaaaa/items":
                raise hq_spotify.SpotifyError("gone", 404, "spotify_not_found")
            if method == "PUT" and path == "/playlists/PL1aaaaaaaaaaaaaaaaaaa/tracks":
                raise hq_spotify.SpotifyError("gone", 404, "spotify_not_found")
            return {}
        with mock.patch.object(hq_spotify, "api_request", side_effect=api):
            hq_spotify._playback_playlist_id()
            self.assertEqual(hq_spotify.load_playback_playlist(["spotify:track:a"]), "spotify:playlist:PL2bbbbbbbbbbbbbbbbbbb")


class LanguageTests(DjBase):
    def test_english_voice_makes_an_english_show(self):
        with mock.patch("hq_voice_phonon.reply_language", return_value="en"):
            self.assertEqual(dj.show_language(), "en")
            with self.model({"tracks": ["c1", "c2", "c3"], "intro": "Welcome back, Master."}) as gen:
                seg = dj.plan_segment()
            self.assertIn("anglais", gen.call_args.args[1])
            self.assertEqual(seg["language"], "en")
            with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
                self.assertIn("Master", dj.plan_segment()["intro"])
            with mock.patch.object(dj, "_voice_file", return_value=None) as voice:
                dj.make_drop("Hello there")
            self.assertEqual(voice.call_args.args[2], "en")
        dj.update_settings({"language": "fr"})
        with mock.patch("hq_voice_phonon.reply_language", return_value="en"):
            self.assertEqual(dj.show_language(), "fr")  # the manual setting wins over the voice
        with self.assertRaises(dj.DjError):
            dj.update_settings({"language": "de"})

    def test_quiz_lines_follow_the_language(self):
        import hq_music_quiz
        with mock.patch.object(dj, "show_language", return_value="en"):
            self.assertIn(hq_music_quiz._line("right"), hq_music_quiz.LINES_EN["right"])
        with mock.patch.object(dj, "show_language", return_value="fr"):
            self.assertIn(hq_music_quiz._line("right"), hq_music_quiz.LINES["right"])


class SkipTests(DjBase):
    def seg(self, ids, sid):
        return {"id": sid, "show": "dj", "title": sid, "theme": "", "intro": "Intro " + sid, "intro_drop": None,
                "guest": None, "tracks": [dict(row(i), line=None, drop=None) for i in ids], "premiere_uris": [], "joke": None}

    def started(self):
        with mock.patch.object(dj, "plan_segment", return_value=self.seg([1, 2, 3], "one")),              mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"),              mock.patch.object(hq_spotify, "player_action"):
            dj.start({})
            dj.go()  # her intro is over: the segment's music started
        state = dj._state()
        state["next"] = dict(self.seg([4, 5, 6], "two"), position=3)
        dj._save_state(state)

    def test_running_past_her_picks_pulls_the_show_back(self):
        self.started()
        with mock.patch.object(dj, "_spawn") as spawn,              mock.patch.object(hq_spotify, "playback_playlist_uri", return_value="spotify:playlist:ours"):
            out = dj.observe("spotify:track:autoplay", "spotify:track:3", 4000, context="spotify:playlist:ours")
        self.assertTrue(out["rescue"])
        self.assertEqual(spawn.call_args.args[0], "jump-next")
        self.assertTrue(dj._state()["active"])

    def test_master_choosing_something_else_still_ends_the_show(self):
        self.started()
        with mock.patch.object(hq_spotify, "playback_playlist_uri", return_value="spotify:playlist:ours"):
            out = dj.observe("spotify:track:x", "spotify:track:2", 4000, context="spotify:playlist:his")
        self.assertTrue(out["left"])
        self.started()
        hq_spotify.playback_generation += 1  # a « Lire » elsewhere replaced the playback playlist
        try:
            with mock.patch.object(hq_spotify, "playback_playlist_uri", return_value="spotify:playlist:ours"):
                out = dj.observe("spotify:track:y", "spotify:track:2", 4000, context="spotify:playlist:ours")
        finally:
            hq_spotify.playback_generation -= 1
        self.assertTrue(out["left"])

    def test_next_segment_button_pauses_introduces_then_plays_its_position(self):
        self.started()
        dj.go()
        with mock.patch.object(hq_spotify, "playback_playlist_uri", return_value="spotify:playlist:ours"), \
             mock.patch.object(hq_spotify, "player_action") as action, mock.patch.object(dj, "_spawn") as spawn:
            out = dj.next_segment()
            self.assertEqual(out["jump"], "now")
            self.assertEqual(out["segment"]["id"], "two")  # promoted at once: her intro is for this segment
            self.assertEqual(out["awaiting"]["segment_id"], "two")
            self.assertNotIn("play", [c.args[0] for c in action.call_args_list])
            self.assertEqual([c.args[0] for c in spawn.call_args_list], ["plan-next", "go-fallback"])
            dj.go("two")
            self.assertEqual(action.call_args.args[1]["offset"], {"position": 3})
        with mock.patch.object(hq_music, "record_feedback") as feedback:
            dj.observe("spotify:track:4", "spotify:track:1", 3000)  # the jump is not a skip of track 1
        feedback.assert_not_called()

    def test_next_segment_waits_when_not_ready(self):
        self.started()
        state = dj._state()
        state["next"] = None
        dj._save_state(state)
        with mock.patch.object(dj, "_spawn") as spawn:
            self.assertEqual(dj.next_segment()["jump"], "pending")
        self.assertEqual(spawn.call_args.args[0], "jump-next")
        dj.stop()
        with self.assertRaises(dj.DjError):
            dj.next_segment()


class SeamlessTests(DjBase):
    def test_switch_fades_out_plays_then_fades_back(self):
        calls = []
        player = {"playing": True, "device": {"id": "dev", "volume_percent": 60}}
        with mock.patch.object(hq_spotify, "get_player", return_value=player),              mock.patch.object(hq_spotify, "player_action", side_effect=lambda a, p=None: calls.append((a, (p or {}).get("volume_percent")))),              mock.patch.object(dj.time, "sleep"):
            dj._faded_switch(lambda: calls.append(("play", None)))
        names = [c[0] for c in calls]
        self.assertEqual(names.index("play"), 4)  # four steps down first
        self.assertEqual([c[1] for c in calls[:4]], [48, 36, 24, 12])  # smooth steps down to 20 %
        self.assertEqual(calls[-1], ("volume", 60))  # back to where it was

    def test_nothing_playing_means_no_fade(self):
        calls = []
        with mock.patch.object(hq_spotify, "get_player", return_value={"playing": False, "device": None}),              mock.patch.object(hq_spotify, "player_action", side_effect=lambda a, p=None: calls.append(a)):
            dj._faded_switch(lambda: calls.append("play"))
        self.assertEqual(calls, ["play"])

    def test_her_voice_is_ready_before_any_music(self):
        order = []
        seg = {"id": "s", "show": "dj", "title": "T", "theme": "", "intro": "Hi", "intro_drop": None, "guest": None,
               "tracks": [dict(row(i), line=None, drop=None) for i in (1, 2, 3)], "premiere_uris": [], "joke": None}
        with mock.patch.object(dj, "plan_segment", return_value=seg),              mock.patch.object(dj, "make_drop", side_effect=lambda *a, **k: order.append("voice") or "drop-" + "c" * 20 + ".mp3"),              mock.patch.object(dj, "_spawn"), mock.patch.object(dj, "_fade_out_and_pause", side_effect=lambda: order.append("pause")), \
             mock.patch.object(hq_spotify, "player_action", side_effect=lambda a, p=None: order.append(a)):
            out = dj.start({})
            self.assertEqual(order, ["voice", "pause"])  # intro recorded, current music paused, nothing started yet
            dj.go("s")
        self.assertIn("play", order)
        self.assertEqual(out["announce"]["drops"], ["drop-" + "c" * 20 + ".mp3"])


if __name__ == "__main__":
    unittest.main()
