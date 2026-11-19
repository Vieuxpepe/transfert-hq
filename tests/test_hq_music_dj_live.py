"""DJ Musica live reactions (skip, skip streak, bets, acknowledgements), warm-up of their voices, and talk back."""
import json
import random
import time
import unittest
from unittest import mock

import hq_music
import hq_music_dj as dj
import hq_music_dj_live as live
import hq_music_dj_talk as talk
from tests.test_hq_music_dj import DjBase, row

REAL_WARM_DUE = live.warm_due  # DjBase silences the module attribute during tests


class Rng:
    """A deterministic stand-in for `random`: always passes the probability roll and takes the first choice."""
    def __init__(self, roll=0.0):
        self.roll = roll

    def random(self):
        return self.roll

    def choice(self, seq):
        return seq[0]


def fresh_state():
    return {"live": {"last_at": 0.0, "tracks": 99, "recent": [], "skip_times": [], "warm_at": 0.0}}


class ChooseTests(DjBase):
    def test_pacing_gap_tracks_and_probability(self):
        state = fresh_state()
        with mock.patch.object(dj, "peek_drop", return_value=None):
            first = live.choose(state, "skip", "fr", now=1000.0, rng=Rng())
            self.assertEqual(first["event"], "skip")
            self.assertNotIn("[", first["text"])  # the mood tag is a stage direction, never shown
            self.assertIsNone(live.choose(state, "skip", "fr", now=1050.0, rng=Rng()))  # inside the gap
            state["live"]["tracks"] = 5
            self.assertIsNone(live.choose(state, "skip", "fr", now=1050.0, rng=Rng()))  # gap still not over
            self.assertIsNotNone(live.choose(state, "skip", "fr", now=1200.0, rng=Rng()))
            state["live"]["tracks"] = 0
            self.assertIsNone(live.choose(state, "skip", "fr", now=1500.0, rng=Rng()))  # not enough tracks since
            state["live"]["tracks"] = 5
            self.assertIsNone(live.choose(state, "skip", "fr", now=2000.0, rng=Rng(roll=0.9)))  # the dice said no
            self.assertIsNone(live.choose(state, "nothing", "fr"))

    def test_a_streak_and_an_acknowledgement_are_less_paced(self):
        state = fresh_state()
        state["live"]["last_at"] = 1000.0
        with mock.patch.object(dj, "peek_drop", return_value=None):
            self.assertIsNone(live.choose(state, "skip", "fr", now=1010.0, rng=Rng()))
            self.assertIsNotNone(live.choose(state, "skips", "fr", now=1100.0, rng=Rng()))  # 75 s gap only
            self.assertIsNotNone(live.choose(state, "ack", "fr", now=1101.0, rng=Rng(roll=0.99), force=True))

    def test_lines_are_not_repeated_and_follow_the_language(self):
        state = fresh_state()
        seen = []
        with mock.patch.object(dj, "peek_drop", return_value=None):
            for i in range(len(live.lines_for("skip", "fr"))):
                state["live"].update(last_at=0.0, tracks=9)
                seen.append(live.choose(state, "skip", "fr", now=5000.0 + i * 1000, rng=Rng())["line"])
            self.assertEqual(len(set(seen)), len(seen))  # six different lines before any repeat
            en = live.choose(state, "skip", "en", now=99999.0, rng=Rng(), force=True)
        self.assertIn(en["line"], live.lines_for("skip", "en"))

    def test_a_line_whose_voice_is_cached_is_preferred(self):
        state = fresh_state()
        lines = live.lines_for("skip", "fr")
        cached = lines[3]
        peek = lambda text, **kw: "drop-" + "a" * 20 + ".mp3" if text == cached else None
        with mock.patch.object(dj, "peek_drop", side_effect=peek):
            out = live.choose(state, "skip", "fr", now=1000.0, rng=Rng())
        self.assertEqual(out["line"], cached)
        self.assertEqual(out["drop"], "drop-" + "a" * 20 + ".mp3")

    def test_skip_streak(self):
        state = fresh_state()
        self.assertFalse(live.note_skip(state, now=100.0))
        self.assertFalse(live.note_skip(state, now=200.0))
        self.assertTrue(live.note_skip(state, now=300.0))
        self.assertFalse(live.note_skip(state, now=400.0))  # reset after a streak
        self.assertFalse(live.note_skip(state, now=900.0))  # the first two are too old
        self.assertFalse(live.note_skip(state, now=2000.0))


class WarmTests(DjBase):
    def test_warm_records_missing_lines_one_by_one_and_yields_to_other_voice_work(self):
        recorded = []
        with mock.patch.object(dj, "peek_drop", return_value=None), mock.patch.object(dj, "voice_busy", return_value=False), \
             mock.patch.object(dj, "make_drop", side_effect=lambda text, **kw: recorded.append(text) or "drop.mp3"):
            self.assertEqual(live.warm("fr", limit=3), 3)
        self.assertEqual(len(recorded), 3)
        calls = {"n": 0}

        def busy():
            calls["n"] += 1
            return calls["n"] > 2  # a segment starts preparing its own voice after two lines

        recorded.clear()
        with mock.patch.object(dj, "peek_drop", return_value=None), mock.patch.object(dj, "voice_busy", side_effect=busy), \
             mock.patch.object(dj, "make_drop", side_effect=lambda text, **kw: recorded.append(text) or "drop.mp3"):
            self.assertEqual(live.warm("fr", limit=6), 2)
        with mock.patch.object(dj, "peek_drop", return_value="x.mp3"), mock.patch.object(dj, "make_drop") as make:
            self.assertEqual(live.warm("fr"), 0)  # everything cached: nothing to do
            make.assert_not_called()

    def test_warm_is_due_once_per_window(self):
        state = fresh_state()
        self.assertTrue(REAL_WARM_DUE(state, now=1000.0))
        self.assertFalse(REAL_WARM_DUE(state, now=1100.0))
        self.assertTrue(REAL_WARM_DUE(state, now=1000.0 + live.WARM_EVERY + 1))

    def test_peek_never_synthesizes_or_wakes_a_daemon(self):
        with mock.patch.object(dj, "make_drop") as make, mock.patch.object(dj, "voice_engine_for", return_value="phonon") as engine:
            self.assertIsNone(dj.peek_drop("Hello there", mood="warm"))
            make.assert_not_called()
            self.assertFalse(engine.call_args.kwargs.get("warm", True))  # warm=False: no daemon start

    def test_peek_finds_what_make_drop_recorded(self):
        key, _ = dj._drop_key("Hi there", "musica", None, False, "fr", "warm", "phonon", dj.settings())
        path = dj._cache_dir() / f"drop-{key}.mp3"
        path.write_bytes(b"ID3")
        with mock.patch.object(dj, "voice_engine_for", return_value="phonon"), mock.patch.object(dj, "show_language", return_value="fr"):
            self.assertEqual(dj.peek_drop("Hi there", mood="warm"), path.name)


class ObserveReactionTests(DjBase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(dj, "_spawn")
        self.spawn = patcher.start()
        self.addCleanup(patcher.stop)
        peek = mock.patch.object(dj, "peek_drop", return_value=None)
        peek.start()
        self.addCleanup(peek.stop)
        due = mock.patch.object(live, "warm_due", return_value=True)  # DjBase silences it; here the spawn itself is the subject
        due.start()
        self.addCleanup(due.stop)
        lang = mock.patch.object(dj, "show_language", return_value="fr")
        lang.start()
        self.addCleanup(lang.stop)
        for event in live.EVENTS.values():  # no dice in these tests
            event["p"] = 1.0
        self.addCleanup(lambda: [event.update(p=p) for event, p in zip(live.EVENTS.values(), self.original)])
        with dj._lock:
            tracks = [dict(row(i), line=f"ligne {i}", drop=f"drop-{i:020d}.mp3", pick=(i == 2)) for i in (1, 2, 3, 4)]
            state = dj._state()
            state.update(active=True, segment={"id": "one", "show": "dj", "title": "S", "theme": "", "intro": "x", "tracks": tracks},
                         observed={"uri": "spotify:track:1", "at": time.time(), "source": "browser"})
            dj._save_state(state)

    original = [0.5, 0.9, 0.8, 0.8, 1.0]  # the production probabilities, restored after each test

    def test_a_quick_skip_is_answered_before_the_next_line(self):
        with mock.patch.object(hq_music, "record_feedback"):
            out = dj.observe("spotify:track:2", "spotify:track:1", 8000)
        self.assertEqual(out["reaction"]["event"], "skip")
        self.assertFalse(out["reaction"]["voiced"])  # no cached voice yet: the text goes out alone
        self.assertTrue(out["text"].endswith("ligne 2"))
        self.assertTrue(out["text"].startswith(out["reaction"]["text"]))
        self.assertIn("live-voice", [c.args[0] for c in self.spawn.call_args_list])  # and its voice is queued for next time
        self.assertIn("live-warm", [c.args[0] for c in self.spawn.call_args_list])  # the cache warm-up starts with the show

    def test_a_cached_reaction_is_voiced_and_comes_first(self):
        with mock.patch.object(dj, "peek_drop", return_value="drop-" + "b" * 20 + ".mp3"), mock.patch.object(hq_music, "record_feedback"):
            out = dj.observe("spotify:track:2", "spotify:track:1", 8000)
        self.assertEqual(out["drops"], ["drop-" + "b" * 20 + ".mp3", "drop-00000000000000000002.mp3"])
        self.assertTrue(out["reaction"]["voiced"])

    def test_a_lost_bet_and_a_won_bet(self):
        with mock.patch.object(hq_music, "record_feedback"):
            dj.observe("spotify:track:2", "spotify:track:1", 200000 * 0 + 150000)  # track 1 completed (no bet): no reaction
            lost = dj.observe("spotify:track:3", "spotify:track:2", 6000)  # track 2 was her bet, skipped
        self.assertEqual(lost["reaction"]["event"], "pick_lost")
        with dj._lock:
            state = dj._state()
            state["live"].update(last_at=0.0, tracks=9)
            state["segment"]["tracks"][3]["pick"] = True
            dj._save_state(state)
        with mock.patch.object(hq_music, "record_feedback"):
            won = dj.observe("spotify:track:4", "spotify:track:3", 100)  # a skip of a plain track
            self.assertEqual(won["reaction"]["event"], "skip")
            with dj._lock:
                state = dj._state()
                state["live"].update(last_at=0.0, tracks=9)
                dj._save_state(state)
            done = dj.observe("spotify:track:1", "spotify:track:4", 199000)  # her bet played to the end
        self.assertEqual(done["reaction"]["event"], "pick_won")

    def test_three_quick_skips_make_a_streak_line(self):
        with mock.patch.object(hq_music, "record_feedback"):
            events = []
            for prev, now in (("1", "2"), ("2", "3"), ("3", "4")):
                with dj._lock:
                    state = dj._state()
                    state["live"] = {"last_at": 0.0, "tracks": 9, "recent": [], "skip_times": state.get("live", {}).get("skip_times", []), "warm_at": 0.0}
                    dj._save_state(state)
                out = dj.observe(f"spotify:track:{now}", f"spotify:track:{prev}", 5000)
                events.append((out.get("reaction") or {}).get("event"))
        self.assertEqual(events[-1], "skips")

    def test_no_reaction_on_a_segment_start(self):
        with dj._lock:
            state = dj._state()
            state["next"] = {"id": "two", "show": "dj", "title": "N", "theme": "", "intro": "Intro two", "intro_drop": "d.mp3",
                             "tracks": [dict(row(8), line="x", drop=None)]}
            dj._save_state(state)
        with mock.patch.object(hq_music, "record_feedback"):
            started = dj.observe("spotify:track:8", "spotify:track:1", 3000)  # a skip, but the next segment starts
        self.assertTrue(started["segment_start"])
        self.assertNotIn("reaction", started)  # her intro already speaks
        self.assertEqual(dj._state()["live"]["last_at"], 0.0)  # and the reaction was not spent

    def test_none_inside_the_gap(self):
        with mock.patch.object(hq_music, "record_feedback"):
            first = dj.observe("spotify:track:2", "spotify:track:1", 4000)
            second = dj.observe("spotify:track:3", "spotify:track:2", 4000)
        self.assertIn("reaction", first)
        self.assertNotIn("reaction", second)  # 150 s have not passed

    def test_a_blind_duel_is_untouched(self):
        with dj._lock:
            state = dj._state()
            state["segment"]["show"] = "duel"
            state["duel"] = {"blind": True, "vote": None, "heard": False, "id": "one"}
            dj._save_state(state)
        out = dj.observe("spotify:track:2", "spotify:track:1", 3000)
        self.assertNotIn("reaction", out)


class ClassifyTests(unittest.TestCase):
    def test_questions_and_requests(self):
        asks = ["Pourquoi cette chanson ?", "c'est quoi ce morceau", "Qui chante ça", "quelle année cette chanson", "Comment tu l'as trouvée",
                "why did you pick this", "What is this song?", "who sings this", "tell me about this artist", "Explique-moi ce titre"]
        steers = ["du métal des années 2000", "quelque chose de calme", "mets du jazz", "joue du Daft Punk", "plus de piano",
                  "play something upbeat", "skip this", "", "tu peux mettre du rock ?"]
        for text in asks:
            self.assertEqual(talk.classify(text), "ask", text)
        for text in steers:
            self.assertEqual(talk.classify(text), "steer", text)


class AskTests(DjBase):
    def setUp(self):
        super().setUp()
        for name in ("_spawn",):
            patcher = mock.patch.object(dj, name)
            patcher.start()
            self.addCleanup(patcher.stop)
        lang = mock.patch.object(dj, "show_language", return_value="fr")
        lang.start()
        self.addCleanup(lang.stop)
        self.addCleanup(dj._asks.clear)
        with dj._lock:
            state = dj._state()
            state.update(active=True, observed={"uri": "spotify:track:2", "at": time.time(), "source": "browser"},
                         segment={"id": "s", "show": "dj", "title": "Soirée", "theme": "calme", "intro": "i", "facts": ["Fait vérifié A."],
                                  "tracks": [dict(row(2), line="[warm] Une douceur.", drop=None, pick=True)]})
            dj._save_state(state)

    def test_a_question_is_answered_from_the_facts_only(self):
        sent = {}

        def generate(chain, system, messages, **kw):
            sent["user"] = messages[0]["parts"][0]["text"]
            return json.dumps({"text": "Je l'ai prise parce qu'elle est douce."}), "m"

        with mock.patch("hq_ai.generate", side_effect=generate):
            out = dj.ask({"text": "Pourquoi cette chanson ?"})
        self.assertEqual(out["kind"], "ask")
        self.assertTrue(out["modelled"])
        self.assertIn("douce", out["text"])
        self.assertIn("raison 2", sent["user"])      # why she picked it
        self.assertIn("Fait vérifié A.", sent["user"])  # the facts she checked
        self.assertIn("Soirée", sent["user"])
        self.assertTrue(out["pending"])
        self.assertTrue(dj._asks[out["id"]]["pending"])

    def test_facts_now_includes_taste_dossier(self):
        import hq_musica_profile as mp
        mp._save_analysis({
            "version": 2,
            "analyzed_utc": "2026-11-15T12:00:00Z",
            "history_sharing": True,
            "artist_affinities": [{"name": "Artist 2", "score": 80.0, "tier": "core_pillar"}],
            "genre_profile": {"top_genres": [{"genre": "darksynth", "score": 9.0}], "macro_families": [], "surging_genres": []},
            "track_signatures": {"top_tracks": []},
            "circadian_profile": {"dayparts": {}},
            "acoustic_fingerprint": {},
            "lyrical_profile": {},
            "fatigue_profile": {},
        })
        facts = talk.facts_now(dj._state())
        self.assertIn("profil musical du Maître", facts)
        self.assertIn("Artist 2", facts["profil musical du Maître"])

    def test_with_the_model_down_a_plain_answer_still_comes_from_the_facts(self):
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            out = dj.ask({"text": "pourquoi ce titre"})
        self.assertFalse(out["modelled"])
        self.assertIn("raison 2", out["text"])

    def test_nothing_known_is_said_honestly(self):
        with dj._lock:
            state = dj._state()
            state["segment"]["tracks"][0]["why"] = None
            dj._save_state(state)
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            out = dj.ask({"text": "qui chante ça ?"})
        self.assertIn("rien de fiable", out["text"])

    def test_no_show_on_air(self):
        with dj._lock:
            state = dj._state()
            state["active"] = False
            dj._save_state(state)
        with mock.patch("hq_ai.generate", side_effect=AssertionError("no model call without a show")):
            out = dj.ask({"text": "why this song?"})
        self.assertIn("pas d'émission", out["text"])

    def test_a_blind_match_never_leaks(self):
        with dj._lock:
            state = dj._state()
            state["duel"] = {"blind": True, "vote": None, "id": "d"}
            dj._save_state(state)
        with mock.patch("hq_ai.generate", side_effect=AssertionError("the model must not see a blind match")):
            out = dj.ask({"text": "c'est quoi ce morceau ?"})
        self.assertIn("aveugle", out["text"])
        self.assertNotIn("Song 2", out["text"])

    def test_a_request_steers_and_is_acknowledged_at_once(self):
        with mock.patch.object(dj, "begin", return_value={"ok": True, "prep": {"running": True}}) as begin, \
             mock.patch.object(dj, "peek_drop", return_value="drop-" + "c" * 20 + ".mp3"):
            out = dj.ask({"text": "quelque chose de calme", "device_id": "d1"})
        self.assertEqual(out["kind"], "steer")
        self.assertEqual(begin.call_args.args[0], "steer")
        self.assertEqual(begin.call_args.args[1]["text"], "quelque chose de calme")
        self.assertTrue(out["ack"]["text"])
        self.assertEqual(out["ack"]["drop"], "drop-" + "c" * 20 + ".mp3")  # cached: she answers instantly
        with self.assertRaises(dj.DjError):
            dj.ask({"text": "   "})

    def test_the_voice_arrives_after_the_text(self):
        out = {}
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            out = dj.ask({"text": "pourquoi cette chanson"})
        with mock.patch.object(dj, "make_drop", return_value="drop-" + "d" * 20 + ".mp3") as make:
            dj._finish_ask(out["id"], out["text"])
        self.assertEqual(make.call_args.kwargs["mood"], "warm")
        view = dj.ask_view(out["id"])
        self.assertEqual((view["pending"], view["drop"]), (False, "drop-" + "d" * 20 + ".mp3"))
        self.assertEqual(dj.ask_view("unknown")["drop"], None)

    def test_warm_route_starts_one_background_run(self):
        with mock.patch.object(dj, "_bg", {}):
            status, body = dj.http_post("/api/musica/dj/live/warm", {})
        self.assertEqual((status, body["started"]), (202, True))
        dj._spawn.assert_called_with("live-warm", live.warm, "fr", live.WARM_LIMIT * 4)
        key, fn, *args = dj._spawn.call_args.args
        recorded = []
        with mock.patch.object(dj, "peek_drop", return_value=None), mock.patch.object(dj, "voice_busy", return_value=False), \
             mock.patch.object(dj, "make_drop", side_effect=lambda text, **kw: recorded.append(text) or "x.mp3"):
            fn(*args)  # exactly how the background thread calls it: with the arguments _spawn was given
        self.assertEqual(len(recorded), sum(len(live.lines_for(e, "fr")) for e in live.EVENTS))  # all of them: fewer than the limit

    def test_routes(self):
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            status, body = dj.http_post("/api/musica/dj/ask", {"text": "pourquoi cette chanson ?"})
        self.assertEqual((status, body["kind"]), (200, "ask"))
        self.assertEqual(dj.http_get("/api/musica/dj/ask/" + body["id"])[0], 200)
        with mock.patch.object(dj, "begin", return_value={"ok": True}):
            status, body = dj.http_post("/api/musica/dj/ask", {"text": "du jazz"})
        self.assertEqual((status, body["kind"]), (202, "steer"))
        self.assertEqual(dj.http_post("/api/musica/dj/ask", {"text": ""})[0], 400)


if __name__ == "__main__":
    unittest.main()
