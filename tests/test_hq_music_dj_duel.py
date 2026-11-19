"""DJ Musica: Rembobiner (episode archive + replay) and Le Duel (head to head, vote, champion)."""
import json
from datetime import date, datetime, timedelta, timezone
import time
import unittest
from unittest import mock

import hq_music_dj as dj
import hq_music_dj_archive as archive
import hq_spotify
from tests.test_hq_music_dj import DjBase, FlowTests, row

DUEL_POOLS = {"forgotten": [row(1, "forgotten")], "discovery": [row(2, "discovery")], "radar": [row(3, "radar")]}


class ArchiveTests(DjBase):
    def seg(self, sid, ids):
        return {"id": sid, "show": "dj", "title": "T" + sid, "theme": "", "intro": "[hype] Salut.",
                "intro_drop": "drop-" + "a" * 20 + ".mp3", "guest": None, "premiere_uris": [],
                "tracks": [dict(row(i), line=f"ligne {i}" if i != ids[0] else None, drop=None, pick=(i == ids[1]))
                           for i in ids]}

    def test_record_refresh_view_and_replay_copy(self):
        archive.record("ep1", self.seg("s1", [1, 2, 3]))
        archive.record("ep1", self.seg("s2", [4, 5, 6]))
        refreshed = self.seg("s1", [1, 2, 3])
        refreshed["tracks"][1]["pick_result"] = "won"
        archive.refresh(refreshed)
        episode = archive.episode("ep1")
        self.assertEqual([s["id"] for s in episode["segments"]], ["s1", "s2"])
        self.assertEqual(episode["segments"][0]["tracks"][1]["pick_result"], "won")
        view = archive.view()["episodes"][0]
        self.assertEqual(view["tracks"], 6)
        self.assertNotIn("[hype]", view["segments"][0]["intro"])
        copy = dj._replay_segment("ep1", 0)
        self.assertNotEqual(copy["id"], "s1")
        self.assertTrue(copy["replay"])
        self.assertTrue(all("pick" not in t and "pick_result" not in t for t in copy["tracks"]))
        self.assertIsNone(copy["intro_drop"])  # not in the cache: recorded again
        self.assertIsNone(dj._replay_segment("ep1", 5))

    def test_aired_segments_join_their_episode_and_replay_does_not(self):
        state = dj._state()
        first, second = self.seg("s1", [1, 2, 3]), self.seg("s2", [4, 5, 6])
        dj._remember_segment(state, first)
        dj._remember_segment(state, second)
        self.assertEqual(len(archive.episode(state["episode"])["segments"]), 2)
        before = archive.view()
        dj._remember_segment(state, dict(self.seg("s3", [7, 8, 9]), replay={"episode": "x", "index": 0}))
        self.assertEqual(archive.view(), before)

    def test_replay_airs_in_order_then_continues_live(self):
        archive.record("ep1", self.seg("s1", [1, 2, 3]))
        archive.record("ep1", self.seg("s2", [4, 5, 6]))
        with mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"):
            out = dj.replay({"id": "ep1"})
        self.assertTrue(out["segment"]["replay"])
        self.assertEqual([t["uri"] for t in out["segment"]["tracks"]], [f"spotify:track:{i}" for i in (1, 2, 3)])
        self.assertIsNone(dj._state()["episode"])
        with mock.patch.object(dj, "_prepare_drops"), mock.patch.object(hq_spotify, "append_playback_tracks"):
            dj._plan_next(dj._state()["segment"]["id"])
        self.assertEqual([t["uri"] for t in dj._state()["next"]["tracks"]], [f"spotify:track:{i}" for i in (4, 5, 6)])
        with self.assertRaises(dj.DjError):
            dj.replay({"id": "nope"})

    def test_archived_drops_survive_cache_pruning(self):
        name = "drop-" + "b" * 20 + ".mp3"
        seg = self.seg("s1", [1, 2, 3])
        seg["tracks"][1]["drop"] = name
        archive.record("ep1", seg)
        (dj._cache_dir() / name).write_bytes(b"x")
        other = dj._cache_dir() / ("drop-" + "c" * 20 + ".mp3")
        other.write_bytes(b"x")
        dj._prune_cache(keep=0, force=True)  # the prune is throttled per minute in normal use
        self.assertTrue((dj._cache_dir() / name).is_file())
        self.assertFalse(other.exists())


class DuelTests(DjBase):
    def setUp(self):
        super().setUp()
        spawn = mock.patch.object(dj, "_spawn")
        spawn.start()
        self.addCleanup(spawn.stop)
        offline = mock.patch("hq_ai.generate", side_effect=RuntimeError("offline"))
        offline.start()
        self.addCleanup(offline.stop)
        patcher = mock.patch.object(dj, "candidate_pools", return_value=DUEL_POOLS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def start(self, prediction="a"):
        payload = {"intro": "Duel !", "line_b": "Le challenger.", "prediction": prediction}
        with self.model(payload), mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"):
            return dj.start_duel({})

    def test_first_duel_old_favourite_against_a_novelty(self):
        out = self.start()
        duel = out["duels"]["current"]
        self.assertEqual(duel["a"]["pool"], "forgotten")
        self.assertIn(duel["b"]["pool"], dj.DUEL_NEW)
        self.assertIsNone(duel["prediction"])  # her forecast stays hidden until the vote
        self.assertEqual(out["segment"]["show"], "duel")
        self.assertEqual(len(out["segment"]["tracks"]), 2)

    def test_vote_crowns_scores_forecast_and_likes(self):
        self.start(prediction="b")
        with mock.patch.object(dj.music, "record_feedback") as feedback:
            out = dj.vote_duel("b")
        feedback.assert_called_once()
        self.assertTrue(out["result"]["foreseen"])
        self.assertEqual(out["duels"]["right"], 1)
        self.assertEqual(out["duels"]["champion"]["name"], out["result"]["winner"]["name"])
        self.assertNotEqual(out["result"]["winner"]["name"], "Song 1")
        self.assertEqual(out["duels"]["current"]["prediction"], "b")
        with self.assertRaises(dj.DjError) as caught:
            dj.vote_duel("a")
        self.assertEqual(caught.exception.code, "duel_closed")
        with self.assertRaises(dj.DjError):
            dj.vote_duel("c")

    def test_http_vote_is_instant_and_her_reaction_streams_after(self):
        self.start(prediction="a")
        spawned = mock.patch.object(dj, "_spawn").start()
        self.addCleanup(mock.patch.stopall)
        with mock.patch("hq_ai.generate", side_effect=AssertionError("the verdict must not wait for the model")):
            status, out = dj.http_post("/api/musica/dj/duel/vote", {"choice": "a"})
        self.assertEqual(status, 200)
        self.assertTrue(out["reaction"]["pending"])
        self.assertIn("Song 1", out["text"])  # the scripted line is already there
        spawned.assert_called_once()
        key, fn, *args = spawned.call_args.args
        self.assertEqual(key, "reaction")
        rid = out["reaction"]["id"]
        self.assertTrue(dj.http_get("/api/musica/dj/duel/reaction/" + rid)[1]["pending"])
        with mock.patch("hq_ai.generate", return_value=(json.dumps({"text": "Bien vu, Maître, tu craques pour les classiques."}), "m")):
            fn(*args)
        view = dj.http_get("/api/musica/dj/duel/reaction/" + rid)[1]
        self.assertFalse(view["pending"])
        self.assertIn("classiques", view["text"])
        self.assertEqual(dj.http_get("/api/musica/dj/duel/reaction/unknown")[1]["text"], "")

    def test_voice_compare_uses_the_worker_without_a_local_daemon(self):
        import hq_voice_chatterbox as cb
        with mock.patch.object(dj, "show_language", return_value="en"), mock.patch.object(cb, "_remote_ok", return_value=True), \
             mock.patch.object(cb, "installed", return_value=False), mock.patch.object(cb, "daemon_ready", return_value=False), \
             mock.patch.object(cb, "start_daemon") as start, mock.patch.object(dj, "make_drop", return_value="drop.wav") as drop:
            out = dj.voice_compare({"text": "Hello Master"})
        start.assert_not_called()
        self.assertEqual(out["chatterbox"], "drop.wav")
        self.assertIsNone(out["note"])
        self.assertEqual(drop.call_args_list[-1].kwargs["engine"], "chatterbox")

    def test_voice_status_is_cached_between_polls(self):
        dj._voice_cache["value"] = None
        with mock.patch.object(dj, "voice_status", return_value={"engine_now": "x"}) as probe:
            for _ in range(5):
                dj.public_state()
            self.assertEqual(probe.call_count, 1)
            dj.update_settings({})  # a settings change drops the cache
            dj.public_state()
            self.assertEqual(probe.call_count, 2)

    def test_streamed_reaction_falls_back_to_the_scripted_line(self):
        self.start()
        spawned = mock.patch.object(dj, "_spawn").start()
        self.addCleanup(mock.patch.stopall)
        out = dj.vote_duel("a", defer=True)
        _, fn, *args = spawned.call_args.args
        fn(*args)  # hq_ai.generate is offline in setUp
        self.assertEqual(dj.reaction_view(out["reaction"]["id"])["text"], out["text"])

    def test_champion_defends_then_retires_to_the_hall(self):
        self.start()
        dj.vote_duel("a")  # Song 1 crowned (0 defenses)
        for expected in (1, 2):
            self.start()
            duel = dj._state()["duel"]
            self.assertEqual(duel["champion"], "a")
            self.assertEqual(duel["a"]["uri"], "spotify:track:1")
            out = dj.vote_duel("a")
            self.assertEqual(out["duels"]["champion"]["defenses"], expected)
        self.start()
        out = dj.vote_duel("a")
        self.assertTrue(out["result"]["retired"])
        self.assertIsNone(out["duels"]["champion"])
        self.assertEqual(out["duels"]["hall"][0]["name"], "Song 1")

    def test_not_enough_titles_and_banned_champion(self):
        with mock.patch.object(dj, "candidate_pools", return_value={"top": [row(1)]}):
            with self.assertRaises(dj.DjError) as caught:
                dj.start_duel({})
        self.assertEqual(caught.exception.code, "dj_not_enough")

    def test_model_down_still_airs_a_plain_duel(self):
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"):
            out = dj.start_duel({})
        self.assertTrue(out["segment"]["intro"])
        self.assertTrue(out["segment"]["fallback_reason"])

    def test_http_routes(self):
        status, _ = dj.http_post("/api/musica/dj/duel/vote", {"choice": "a"})
        self.assertEqual(status, 409)
        status, body = dj.http_post("/api/musica/dj/archive/replay", {"id": "nope"})
        self.assertEqual(status, 404)
        status, body = dj.http_get("/api/musica/dj/archive")
        self.assertEqual((status, body["episodes"]), (200, []))


class ReactionTests(DjBase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(dj, "candidate_pools", return_value=DUEL_POOLS)
        patcher.start()
        self.addCleanup(patcher.stop)

    def duel(self):
        payload = {"intro": "Duel !", "line_b": "Le challenger.", "prediction": "a"}
        with self.model(payload), mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"):
            dj.start_duel({})

    def test_presentation_asks_for_a_remark_on_each_choice(self):
        payload = {"intro": "Duel !", "line_b": "Le challenger.", "prediction": "a"}
        with self.model(payload) as gen, mock.patch.object(dj, "make_drop", return_value=None), \
             mock.patch.object(dj, "_spawn"), mock.patch.object(hq_spotify, "player_action"):
            dj.start_duel({})
        self.assertIn("remarque personnelle sur chacun", gen.call_args.args[1])

    def test_vote_reaction_is_written_by_the_model_from_the_choice(self):
        self.duel()
        with self.model({"text": "Tu as laissé tomber le classique, Maître… audacieux."}) as gen:
            out = dj.vote_duel("b")
        self.assertEqual(out["text"], "Tu as laissé tomber le classique, Maître… audacieux.")
        prompt = gen.call_args.args[2][0]["parts"][0]["text"]
        self.assertIn(out["result"]["winner"]["name"], prompt)
        self.assertIn(out["result"]["loser"]["name"], prompt)
        self.assertNotIn("spotify:", prompt + gen.call_args.args[1])

    def test_vote_reaction_falls_back_to_the_scripted_line(self):
        self.duel()
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            out = dj.vote_duel("a")
        self.assertIn(out["result"]["winner"]["name"], out["text"])
        self.assertRegex(out["text"], "titre|title")

    def test_later_votes_know_what_he_chose_before(self):
        self.duel()
        dj.vote_duel("b")
        self.duel()
        with self.model({"text": "Encore !"}) as gen:
            dj.vote_duel("a")
        self.assertIn("Ses choix récents", gen.call_args.args[2][0]["parts"][0]["text"])


class MoodDialTests(DjBase):
    reply = {"tracks": ["c1", "c2", "c3", "c4", "c5", "c6"], "intro": "Salut.", "lines": {}}

    def plan(self):
        with self.model(self.reply) as gen:
            seg = dj.plan_segment()
        return seg, gen.call_args.args[1]

    def test_validation_and_state(self):
        for bad in ({}, {"energy": 0}, {"energy": 6}, {"energy": "x"}, {"minutes": 5}, {"minutes": 500}, {"minutes": True}):
            with self.assertRaises(dj.DjError):
                dj.set_mood(bad)
        out = dj.set_mood({"energy": 2, "minutes": 45})
        self.assertEqual(out["mood"]["energy"], 2)
        self.assertAlmostEqual(out["mood"]["remaining_min"], 45, delta=0.2)
        self.assertEqual(dj.set_mood({"energy": 5})["mood"]["minutes"], 45)  # a later change keeps the budget
        self.assertIsNone(dj.set_mood({"clear": True})["mood"])

    def test_energy_reaches_the_planner_and_nothing_changes_without_a_mood(self):
        _seg, system = self.plan()
        self.assertNotIn("cadran", system)
        dj.set_mood({"energy": 1})
        _seg, system = self.plan()
        self.assertIn("très calme", system)
        self.assertIn("1", system.split("cadran 1 à 5) :")[1][:4])

    def test_time_budget_keeps_the_thread_then_lands_softly_and_signs_off(self):
        dj.set_mood({"minutes": 60})
        seg, system = self.plan()
        self.assertIn("Il reste environ", system)
        self.assertFalse(seg["closing"])
        state = dj._state()
        state["mood"]["ends_at"] = time.time() + 5 * 60  # five minutes left
        dj._save_state(state)
        seg, system = self.plan()
        self.assertIn("DERNIER segment", system)
        self.assertTrue(seg["closing"])
        self.assertLessEqual(len(seg["tracks"]), 3)  # a short landing, not a full block
        # nothing is planned behind the closing segment, and leaving it ends the show
        state = dj._state()
        dj._remember_segment(state, seg)
        state.update(active=True, segment=seg, next=None, observed={"uri": "x", "at": time.time()}, playlist_gen=0)
        dj._save_state(state)
        self.assertTrue(dj.mood_state()["closing"])
        with mock.patch.object(dj, "plan_segment") as plan:
            dj._plan_next(seg["id"])
        plan.assert_not_called()
        out = dj.observe("spotify:track:elsewhere", seg["tracks"][-1]["uri"], 100000, context="spotify:playlist:ours")
        self.assertEqual((out["active"], out.get("finished")), (False, True))
        self.assertIsNone(dj._state()["mood"])

    def test_focus_blocks_ignore_the_mood_and_the_route_works(self):
        dj.set_mood({"energy": 5})
        with self.model(self.reply) as gen:
            dj.plan_segment(show="focus")
        self.assertNotIn("cadran", gen.call_args.args[1])
        status, body = dj.http_post("/api/musica/dj/mood", {"energy": 3, "minutes": 30})
        self.assertEqual((status, body["mood"]["energy"]), (200, 3))
        status, body = dj.http_post("/api/musica/dj/mood", {"energy": 9})
        self.assertEqual(status, 400)
