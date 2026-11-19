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
        import hq_musica_profile as mp
        mp.save_overrides({"boosted_artists": ["Artist 6"], "custom_notes": "Secret note"})
        with mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3"], "intro": "x"}), "m")) as gen:
            dj.plan_segment()
        user_msg = gen.call_args.args[2][0]["parts"][0]["text"]
        self.assertNotIn("Goûts appris", user_msg)
        self.assertNotIn("Dossier musical approfondi", user_msg)

    def test_plan_uses_deep_profile_overrides_and_fatigue(self):
        import hq_musica_profile as mp
        active_key = dj._PART_TO_RULE_KEY.get(dj.daypart(), "soirée")
        mp.save_overrides({
            "boosted_artists": ["Artist 6"],
            "boosted_genres": ["darksynth"],
            "pinned_tracks": ["Artist 6 - Song 6"],
            "mood_rules_override": {active_key: "Tension sombre et cinématique"},
            "target_bpm_range": {"min": 130, "max": 165},
            "language_preferences": ["en", "de"],
            "context_tags": ["night-drive", "coding"],
            "novelty_target": 0.28,
            "custom_notes": "Priorité aux textures industrielles",
        })
        analysis = {
            "version": 2,
            "analyzed_utc": "2026-11-15T12:00:00Z",
            "history_sharing": True,
            "artist_affinities": [{"name": "Artist 6", "score": 85.0, "tier": "core_pillar", "trajectory": "surging",
                                   "genres": ["darksynth", "ebm"]}],
            "genre_profile": {"top_genres": [{"genre": "darksynth", "score": 10.0}], "surging_genres": ["ebm"], "macro_families": []},
            "fatigue_profile": {
                "overplay_fatigue": [{"name": "Artist 1", "historical_plays": 12, "recent_14d": 0, "dj_skipped": 2, "recommended_rest_days": 14}],
                "track_burnout": [{"name": "Song 2", "artists": ["Artist 2"], "historical_plays": 8, "recommended_rest_days": 14}],
                "true_dislikes": [],
                "track_feedback_rejects": [],
            },
            "novelty_profile": {"optimal_familiarity": 0.65, "manual_target_familiarity": 0.28},
            "circadian_profile": {"dayparts": {active_key: {"top_artists": ["Artist 6", "Artist 8"], "share_pct": 40.0}}},
            "track_signatures": {"top_tracks": []},
            "acoustic_fingerprint": {},
            "lyrical_profile": {},
            "sonic_axes": {"aggression": {"score": 82}},
        }
        mp._save_analysis(analysis)
        hq_musica.save_beat_grid({"key": "6", "source": "live", "bpm": 145, "offset": 0.2,
                                  "energy": [0.8, 0.9], "energy_step": 1})

        profile = dj.taste_profile()
        self.assertEqual(profile["boosted_artists"], ["Artist 6"])
        self.assertEqual(profile["boosted_genres"], ["darksynth"])
        self.assertEqual(profile["context_tags"], ["night-drive", "coding"])
        self.assertEqual(profile["language_preferences"], ["en", "de"])
        self.assertIn("Artist 1", profile["fatigued"])
        self.assertEqual(profile["target_familiarity"], 0.28)
        self.assertGreater(profile["scores"]["artist 6"], 0)

        rich_pools = {
            "top": [row(i) for i in range(1, 18)],
            "discovery": [row(i, pool="discovery") for i in range(20, 26)],
        }
        with mock.patch.object(dj, "candidate_pools", return_value=rich_pools) as cand, \
             mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3"], "intro": "x"}), "m")) as gen:
            dj.plan_segment()

        hint = cand.call_args.kwargs["taste_hint"]
        self.assertIn("Artist 6", hint)
        self.assertIn("darksynth", hint)
        self.assertIn("ebm", hint)
        self.assertIn("night-drive", hint)
        user_msg = gen.call_args.args[2][0]["parts"][0]["text"]
        self.assertIn("Artist 6", user_msg)
        self.assertIn("Tension sombre et cinématique", user_msg)
        self.assertIn("Priorité aux textures industrielles", user_msg)
        self.assertIn("Dossier musical approfondi", user_msg)
        self.assertIn('"bpm": 145', user_msg)
        self.assertIn('"genres": ["darksynth", "ebm"]', user_msg)
        self.assertNotIn('"Song 1"', user_msg)   # Artist 1 in overplay_fatigue rested
        self.assertNotIn('"Artist 1"', user_msg)
        self.assertNotIn('"Song 2"', user_msg)   # Song 2 in track_burnout rested
        self.assertIn('"Song 6"', user_msg)      # Boosted Artist 6 included and prioritized
        self.assertIn('"aime": true', user_msg)

        # Duels also exclude fatigued contenders on rested passes and inject dossier context
        duel_pools = {
            "classics": [row(1, pool="classics")] + [row(i, pool="classics") for i in range(3, 8)],
            "discovery": [row(i, pool="discovery") for i in range(20, 25)],
        }
        with mock.patch.object(dj, "candidate_pools", return_value=duel_pools) as dcand, \
             mock.patch("hq_ai.generate", return_value=(json.dumps({"intro": "x", "line_b": "y", "prediction": "a"}), "m")) as dgen:
            duel_seg = dj.plan_duel()
        self.assertIn("night-drive", dcand.call_args.kwargs["taste_hint"])
        self.assertNotEqual(duel_seg["tracks"][0]["artists"][0], "Artist 1")
        duel_prompt = dgen.call_args.args[2][0]["parts"][0]["text"]
        self.assertIn("Profil musical du Maître", duel_prompt)


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
    def setUp(self):  # the per-request mechanism; the English-only policy has its own tests
        super().setUp()
        import os
        patcher = mock.patch.dict(os.environ, {"HQ_ENGLISH_ONLY": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)

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


class UpgradesTests(DjBase):
    def test_cross_segment_continuity_and_two_turn_sister_banter(self):
        dj.request_guest("else")
        first_payload = {
            "title": "Ouverture synth", "theme": "synthwave", "tracks": ["c1", "c2", "c3", "c4"],
            "intro": "On démarre!", "lines": {"c2": "Belle montée."},
            "guest_line": "Calibrage parfait, Maître.", "guest_reply": "Toujours au millimètre, Else!",
        }
        second_payload = {
            "title": "Montée nocturne", "theme": "rock", "tracks": ["c1", "c2", "c3", "c4"],
            "intro": "On continue sur l'élan!", "lines": {"c2": "Toujours plus haut."}, "guest_line": "", "guest_reply": "",
        }
        with mock.patch("hq_ai.generate", return_value=(json.dumps(first_payload), "m")), \
             mock.patch.object(dj, "make_drop", side_effect=lambda txt, character="musica", **kw: f"drop-{character}-{'a' * 15}.mp3"[:29] if False else "drop-" + ("b" if character == "else" else ("c" if "Else" in txt else "a")) + "0" * 19 + ".mp3"), \
             mock.patch.object(dj, "_spawn"), mock.patch.object(dj, "_fade_out_and_pause"):
            out = dj.start({})
        seg = dj._state()["segment"]
        self.assertEqual(seg["arc"], "ouverture")
        self.assertEqual(seg["guest"]["who"], "else")
        self.assertEqual(seg["guest"]["reply"], "Toujours au millimètre, Else!")
        self.assertEqual(len(out["announce"]["drops"]), 3)
        self.assertEqual(len(dj._intro_drops(seg)), 3)
        self.assertIn("Toujours au millimètre, Else!", dj._intro_text(seg))

        seen_prompts = []
        with mock.patch("hq_ai.generate", side_effect=lambda *a, **k: (seen_prompts.append(a[2][0]["parts"][0]["text"]), (json.dumps(second_payload), "m"))[1]):
            next_seg = dj.plan_segment(show="dj", state=dj._state())
        self.assertEqual(next_seg["arc"], "montée")
        self.assertIn("Ouverture synth", seen_prompts[0])

    def test_persistent_session_steer_and_clear(self):
        dj.set_session_steer({"text": "synthwave sombre"})
        self.assertEqual(dj.public_state()["session_steer"]["label"], "synthwave sombre")
        seen_prompts = []
        with mock.patch("hq_ai.generate", side_effect=lambda *a, **k: (seen_prompts.append(a[2][0]["parts"][0]["text"]), (json.dumps({
            "title": "Nuit", "theme": "synth", "tracks": ["c1", "c2", "c3"], "intro": "Go.", "lines": {}, "guest_line": "",
        }), "m"))[1]):
            dj.plan_segment(show="dj", state=dj._state())
        self.assertIn("synthwave sombre", seen_prompts[0])
        dj.set_session_steer({"clear": True})
        self.assertIsNone(dj.public_state()["session_steer"])

    def test_similar_now_and_skip_reason_without_blacklisting(self):
        payload = {"title": "Dans la même veine", "theme": "similaire", "tracks": ["c1", "c2", "c3"],
                   "intro": "On prolonge ce son.", "lines": {}, "guest_line": ""}
        with mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(dj, "_fade_out_and_pause"), \
             mock.patch("hq_ai.generate", return_value=(json.dumps(payload), "m")):
            dj.start({})
            with mock.patch.object(dj, "candidate_pools", return_value={"similar": [row(20, "similar"), row(21, "similar"), row(22, "similar")]}) as cp:
                out = dj.similar_now({})
            self.assertEqual(cp.call_args.kwargs["seed_track"]["uri"], "spotify:track:99")
            self.assertEqual(out["segment"]["title"], "Dans la même veine")

            with mock.patch.object(hq_music, "record_feedback"):
                dj.record_skip("spotify:track:20")
            st = dj.record_skip_reason({"reason": "too_slow"})
            self.assertEqual(st["mood"]["energy"], 4)
            st2 = dj.record_skip_reason({"reason": "overplayed"})
            self.assertEqual(st2["last_skipped"]["reason"], "overplayed")
            self.assertIn("spotify:track:20", dj._state()["session_rest_uris"])

    def test_show_facts_calendar_and_session_gap_no_titles(self):
        with mock.patch.object(hq_music, "mood_suggestion", return_value={"events_today": 2, "next_event": {"start": "18:30", "title": "SECRET_TITLE"}, "minutes": 45}):
            facts = dj._show_facts("dj", True, {"last_ended_at": 1.0, "active": False})
        self.assertIn("18:30", facts)
        self.assertNotIn("SECRET_TITLE", facts)
        self.assertIn("Retour d'émission", facts)

    def test_play_on_pc_uses_wasapi_duck_and_falls_back_to_api_ramp(self):
        import contextlib
        import hq_music_audio_duck as audio_duck

        drop_name = "drop-" + "d" * 20 + ".mp3"
        (Path(self.tmp.name) / "dj-cache").mkdir(parents=True, exist_ok=True)
        (Path(self.tmp.name) / "dj-cache" / drop_name).write_bytes(b"mp3")

        @contextlib.contextmanager
        def ok_duck(**kw):
            yield True

        @contextlib.contextmanager
        def no_duck(**kw):
            yield False

        with mock.patch.object(audio_duck, "duck_spotify", side_effect=ok_duck), \
             mock.patch.object(subprocess, "run"), \
             mock.patch.object(dj, "_ramp") as ramp:
            dj._play_on_pc([drop_name], {"id": "dev", "volume_percent": 70})
        ramp.assert_not_called()

        with mock.patch.object(audio_duck, "duck_spotify", side_effect=no_duck), \
             mock.patch.object(subprocess, "run"), \
             mock.patch.object(dj, "_ramp") as ramp:
            dj._play_on_pc([drop_name], {"id": "dev", "volume_percent": 70})
        self.assertEqual(ramp.call_count, 2)


class PipelineTests(DjBase):
    """Stage timings, busy/queue/cancel, the polled snapshot, the cache budget and the reactive replan."""

    def setUp(self):
        super().setUp()
        # Another case's preparation thread (they gate on events) must not make this one look busy.
        self.addCleanup(self.quiet_prep)
        dj._bg.clear()

    def quiet_prep(self):
        import time
        end = time.time() + 5
        while time.time() < end and dj._prep.get("running"):
            time.sleep(0.02)
        with dj._lock:
            dj._prep.clear()

    def wait_until(self, condition, timeout=5.0):
        import time
        end = time.time() + timeout
        while time.time() < end:
            if condition():
                return True
            time.sleep(0.01)
        self.fail("condition never became true")

    def seg(self, ids=(1, 2, 3), sid="one"):
        return {"id": sid, "show": "dj", "title": sid, "theme": "", "intro": "Intro", "intro_drop": None,
                "guest": None, "tracks": [dict(row(i), line=f"ligne {i}", drop=None) for i in ids],
                "premiere_uris": [], "joke": None}

    def test_prep_records_stage_timings_and_the_last_run(self):
        import threading
        gate = threading.Event()

        def slow_plan(**_kwargs):
            dj._progress("pools")
            gate.wait(5)
            dj._progress("writing")
            return self.seg()

        with mock.patch.object(dj, "plan_segment", side_effect=slow_plan), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(dj, "_air", return_value={"ok": True}), mock.patch.object(hq_spotify, "player_action"):
            dj.begin("start", {"show": "dj"})
            self.wait_until(lambda: (dj.prep_view() or {}).get("stage") == "pools")
            gate.set()
            self.wait_until(lambda: not dj.prep_view()["running"])
        view = dj.prep_view()
        self.assertIn("pools", view["timings"])
        self.assertGreaterEqual(view["timings"]["pools"], 0.0)
        self.assertIn("drop_hits", view["stats"])
        last = dj.public_state()["last_prep"]
        self.assertIsNone(last["error"])
        self.assertIn("total", last)

    def test_a_second_request_is_queued_or_refused_never_silent(self):
        import threading
        gate = threading.Event()
        with mock.patch.object(dj, "plan_segment", side_effect=lambda **k: (gate.wait(5), self.seg())[1]), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(dj, "_air", return_value={"ok": True}), \
             mock.patch.object(dj, "_fade_out_and_pause"), mock.patch.object(hq_spotify, "player_action"):
            out = dj.begin("start", {"show": "dj"})
            self.assertTrue(out["prep"]["running"])
            same = dj.begin("start", {"show": "dj"})  # the button again: idempotent, and it says so
            self.assertTrue(same["busy"])
            self.assertEqual(same["prep"]["id"], out["prep"]["id"])
            with self.assertRaises(dj.DjError) as caught:
                dj.begin("start", {"show": "matinale"})
            self.assertEqual(caught.exception.code, "dj_busy")
            queued = dj.begin("steer", {"text": "du jazz"})
            self.assertEqual(queued["queued"], "steer")
            self.assertTrue(dj.prep_view()["queued"])
            gate.set()
            self.wait_until(lambda: dj._state().get("steers"))
            self.wait_until(lambda: not dj.prep_view()["running"])
        self.assertEqual(dj._state()["steers"][-1]["text"], "du jazz")  # the queued request really ran

    def test_cancel_stops_the_preparation_at_its_checkpoint(self):
        import threading
        gate = threading.Event()

        def slow_plan(**_kwargs):
            dj._progress("pools")
            gate.wait(5)
            return self.seg()

        with mock.patch.object(dj, "plan_segment", side_effect=slow_plan), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"):
            dj.begin("start", {"show": "dj"})
            self.wait_until(lambda: (dj.prep_view() or {}).get("stage") == "pools")
            self.assertTrue(dj.cancel_prep()["cancelled"])
            gate.set()
            self.wait_until(lambda: not dj.prep_view()["running"])
        self.assertEqual(dj.prep_view()["code"], "dj_cancelled")
        self.assertFalse(dj._state()["active"])  # nothing went on air
        self.assertFalse(dj.cancel_prep()["cancelled"])

    def test_the_polled_state_is_reused_until_something_writes(self):
        dj.public_state()
        with mock.patch.object(dj, "_state", wraps=dj._state) as probe:
            dj.public_state()
            dj.public_state()
        self.assertEqual(probe.call_count, 0)  # the file is not re-read on every poll
        dj._save_state(dj._state())
        with mock.patch.object(dj, "_state", wraps=dj._state) as probe:
            dj.public_state()
        self.assertEqual(probe.call_count, 1)  # a write invalidates it at once

    def test_voice_status_is_served_stale_while_it_refreshes(self):
        dj._voice_cache.update(value={"engine_now": "old"}, at=0.0, busy=False)
        with mock.patch.object(dj, "voice_status", return_value={"engine_now": "new"}) as probe:
            self.assertEqual(dj.voice_status_cached(), {"engine_now": "old"})  # a poll never blocks on the probe
            self.wait_until(lambda: dj._voice_cache["value"] == {"engine_now": "new"})
        self.assertGreaterEqual(probe.call_count, 1)

    def test_the_cache_is_pruned_by_size_and_spares_the_archives(self):
        import os
        cache = dj._cache_dir()  # <root>/.hq-music/dj-cache
        names = []
        for i in range(6):
            path = cache / ("drop-" + f"{i:020d}" + ".mp3")
            path.write_bytes(b"x" * 1000)
            os.utime(path, (1000 + i, 1000 + i))  # i=0 is the oldest
            names.append(path.name)
        with mock.patch.object(dj, "CACHE_MAX_BYTES", 3500), \
             mock.patch.object(dj, "_exported_drops", return_value=set()):
            dj._prune_cache(keep=10, force=True)
        self.assertEqual(sorted(p.name for p in cache.glob("drop-*.mp3")), names[3:])

    def test_the_mix_normalises_loudness_and_ducks_the_bed(self):
        with mock.patch.object(dj.subprocess, "run") as run:
            dj._mix(Path(self.tmp.name) / "v.wav", jingle=Path("j.wav"), bed=Path("b.wav"),
                    out=Path(self.tmp.name) / "x.mp3")
        mix = " ".join(run.call_args_list[0].args[0])
        encode = " ".join(run.call_args_list[-1].args[0])
        self.assertIn("sidechaincompress", mix)
        # An unreadable measure falls back to the single-pass chain, still at the -16 LUFS target.
        self.assertIn("loudnorm=I=-16.0", encode)
        self.assertIn("alimiter", encode)

    def test_the_mix_applies_the_measured_gain_to_the_finished_drop(self):
        # ebur128 on the raw PCM: -18.5 LUFS, true peak -8 dBFS -> a +2.5 dB gain reaches the target.
        measured = mock.Mock(stderr="    I:         -18.5 LUFS\n    Peak:       -8.0 dBFS\n")
        with mock.patch.object(dj.subprocess, "run", return_value=measured) as run:
            dj._mix(Path(self.tmp.name) / "v.wav", jingle=None, bed=None, out=Path(self.tmp.name) / "x.mp3")
        encode = " ".join(run.call_args_list[-1].args[0])
        self.assertIn("volume=2.50dB", encode)
        self.assertIn(f"alimiter=limit={dj.LIMIT_LINEAR}", encode)

    def test_a_peaky_drop_keeps_its_level_and_the_limiter_holds_the_ceiling(self):
        # -17.5 LUFS with peaks at -1.9 dBFS: the gain still reaches the target, alimiter shaves the peaks.
        # Capping the gain here instead is what put a real intro at -20.4 LUFS.
        measured = mock.Mock(stderr="    I:         -17.5 LUFS\n    Peak:       -1.9 dBFS\n")
        with mock.patch.object(dj.subprocess, "run", return_value=measured) as run:
            dj._mix(Path(self.tmp.name) / "v.wav", jingle=None, bed=None, out=Path(self.tmp.name) / "x.mp3")
        encode = " ".join(run.call_args_list[-1].args[0])
        self.assertIn("volume=1.50dB", encode)
        self.assertIn("alimiter=limit=" + str(dj.LIMIT_LINEAR), encode)

    def test_the_drop_key_follows_the_mastering_revision(self):
        st = dj.settings()
        key, _text = dj._drop_key("Salut", "musica", None, False, "en", "warm", "phonon", st)
        with mock.patch.object(dj, "MIX_REV", dj.MIX_REV + 1):
            other, _text = dj._drop_key("Salut", "musica", None, False, "en", "warm", "phonon", st)
        self.assertNotEqual(key, other)  # an old drop is never replayed with the previous chain

    def test_two_mood_skips_replan_the_segment(self):
        with mock.patch.object(dj, "plan_segment", return_value=self.seg()), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn") as spawn, \
             mock.patch.object(hq_spotify, "player_action"):
            dj.start({})
            dj.go()
            spawn.reset_mock()
            with mock.patch.object(hq_music, "record_feedback"):
                dj.record_skip_reason({"reason": "wrong_mood"})
                spawn.assert_not_called()  # one skip is not a pattern
                dj.record_skip_reason({"reason": "too_slow"})
        self.assertEqual(spawn.call_args.args[0], "reactive-replan")
        fired = dj._state()["last_reactive"]
        self.assertEqual(fired["reason"], "too_slow")
        self.assertEqual(fired["segment"], dj._state()["segment"]["id"])

    def test_a_failed_plan_does_not_consume_the_next_reaction(self):
        state = dj._state()
        state.update(active=True, segment={**self.seg(), "skip_reasons": ["wrong_mood"]},
                     last_reactive={"segment": "other", "at": 0.0})
        self.assertTrue(dj._note_mood_skip(state, "wrong_mood"))
        state["segment"]["skip_reasons"] = ["wrong_mood"]
        self.assertFalse(dj._note_mood_skip(state, "wrong_mood"))  # once per segment


class LocalPlaybackTests(unittest.TestCase):
    """A file in the Lecteur makes the show step aside, like a foreign Spotify track."""

    def test_local_play_steps_aside(self):
        with mock.patch.object(dj, "_state", return_value={"active": True, "segment": {"id": "s"}}), \
                mock.patch.object(dj, "_save_state") as save:
            answer = dj.local_playback(True)
        self.assertTrue(answer["left"])
        self.assertFalse(answer["active"])
        self.assertTrue(save.called)

    def test_no_show_no_change(self):
        with mock.patch.object(dj, "_state", return_value={"active": False}):
            self.assertFalse(dj.local_playback(True)["left"])


if __name__ == "__main__":
    unittest.main()
