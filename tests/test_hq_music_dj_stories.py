"""DJ Musica: web-checked facts in her lines, and the Sunday audio recap of the week."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import hq_music
import hq_music_dj as dj
import hq_music_dj_facts as facts
import hq_music_journal as journal
import hq_music_weekly as weekly
import hq_musica


def track(i, line=None):
    return {"uri": f"spotify:track:{i}", "name": f"Song {i}", "artists": [f"Artist {i}"], "album": "A", "line": line,
            "drop": None, "mood": "warm"}


def segment():
    return {"id": "seg1", "show": "dj", "language": "en", "intro": "Hello Master!", "intro_drop": None,
            "tracks": [track(0), track(1, "Nice one."), track(2)]}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        hq_musica.bind(root=self.tmp.name)


def grounded(reply, sources=True):
    def fake(*args, **kwargs):
        assert kwargs.get("search") is True
        if sources:
            kwargs["grounding"].update(sources=[{"title": "wikipedia.org", "uri": "https://example.org/a"}], queries=[])
        return json.dumps(reply), "gemini"
    return fake


class FactTests(Base):
    REPLY = {"t1": {"line": "This one samples a 1970 soul record, listen!", "fact": "It samples a 1970 record.",
                    "confident": True},
             "intro": {"line": "Hello Master, guess what.", "fact": "", "confident": False}}

    def test_confident_facts_replace_lines_and_unsure_ones_keep_hers(self):
        with mock.patch("hq_ai.generate", side_effect=grounded(self.REPLY)):
            out = facts.enrich(segment(), language="en", intro=True)
        self.assertEqual(out["lines"], {1: self.REPLY["t1"]["line"]})
        self.assertIsNone(out["intro"])  # not confident: her intro stays
        self.assertEqual(out["facts"], [{"for": "t1", "fact": "It samples a 1970 record."}])
        self.assertEqual(out["sources"][0]["title"], "wikipedia.org")

    def test_renamed_keys_are_matched_by_order(self):
        reply = {"t2": {"line": "This one was cut in a single afternoon, wow!", "fact": "Recorded in one afternoon.",
                        "confident": True}}
        with mock.patch("hq_ai.generate", side_effect=grounded(reply)):
            out = facts.enrich(segment(), language="en", intro=False)
        self.assertEqual(out["lines"], {1: reply["t2"]["line"]})  # only entry t1: the copied example key « t2 » maps to it

    def test_no_web_sources_means_no_rewrite_and_daily_cap(self):
        with mock.patch("hq_ai.generate", side_effect=grounded(self.REPLY, sources=False)):
            self.assertEqual(facts.enrich(segment(), language="en", intro=False)["lines"], {})
        with mock.patch.object(facts, "DAILY_CAP", 1), mock.patch("hq_ai.generate") as gen:
            facts.enrich(segment(), language="en", intro=False)
        gen.assert_not_called()  # the call above already used today's single slot
        self.assertEqual(facts.usage()["calls_today"], 1)

    def test_lines_are_checked_before_they_are_recorded(self):
        state = dj._state()
        state.update(active=True, segment=segment())
        dj._save_state(state)
        found = {"lines": {1: "Checked story line here."}, "intro": "Fresh intro with a fact.",
                 "facts": [{"for": "t1", "fact": "f"}], "sources": [{"title": "w", "uri": "https://example.org"}]}
        spoken = []
        with mock.patch.object(dj, "_find_facts", return_value=found), \
             mock.patch.object(dj, "make_drop", side_effect=lambda text, **k: spoken.append(text) or "drop-" + "a" * 20 + ".mp3"):
            dj._prepare_drops("seg1", "segment")
        self.assertEqual(spoken, ["Fresh intro with a fact.", "Checked story line here."])
        view = dj.public_state()["segment"]
        self.assertTrue(view["tracks"][1]["fact"])
        self.assertEqual(view["fact_sources"][0]["title"], "w")
        with mock.patch.object(dj, "_find_facts") as again, mock.patch.object(dj, "make_drop", return_value=None):
            dj._prepare_drops("seg1", "segment")
        again.assert_not_called()  # checked once per segment

    def test_setting_off_or_focus_skips_the_search(self):
        with mock.patch("hq_music_dj_facts.enrich") as enrich:
            self.assertEqual(dj._find_facts(dict(segment(), show="focus")), {})
        enrich.assert_not_called()
        dj.update_settings({"facts": False})
        with mock.patch("hq_music_dj_facts.enrich") as enrich:
            self.assertEqual(dj._find_facts(segment()), {})
        enrich.assert_not_called()


class WeeklyTests(Base):
    def seed(self, now, days_ago, name="Song", artist="Artist", n=1):
        moment = (now - timedelta(days=days_ago)).astimezone(timezone.utc)
        month = moment.astimezone().strftime("%Y-%m")
        data = hq_music._load(journal._month_file(month), {"plays": []})
        for i in range(n):
            data["plays"].append({"t": (moment + timedelta(minutes=i)).isoformat().replace("+00:00", "Z"),
                                  "n": name, "a": [artist], "u": f"spotify:track:{name}", "d": 180000})
        hq_music._write(journal._month_file(month), data)

    def test_stats_cover_the_last_seven_days_and_compare(self):
        now = datetime(2026, 11, 15, 12, 0).astimezone()
        self.seed(now, 1, "Loop", "Band A", n=4)
        self.seed(now, 3, "Other", "Band B", n=2)
        self.seed(now, 10, "Old", "Band C", n=3)
        stats = weekly.week_stats(now)
        self.assertEqual(stats["plays"], 6)
        self.assertEqual(stats["previous"]["plays"], 3)
        self.assertEqual(stats["top_artists"][0], {"name": "Band A", "plays": 4})
        self.assertEqual(stats["top_tracks"][0]["name"], "Loop")
        self.assertEqual(stats["minutes"], 18)

    def test_build_writes_the_episode_and_notifies(self):
        now = datetime.now()
        self.seed(now, 1, "Loop", "Band A", n=6)
        script = {"title": "Big week", "parts": [{"text": f"Part {i} of the show.", "mood": "warm"} for i in range(5)]}
        voice = Path(self.tmp.name) / "v.wav"
        voice.write_bytes(b"RIFF")

        def assemble(voices, out, **kwargs):
            self.assertEqual(len(voices), 5)
            out.write_bytes(b"ID3")
            return True

        with mock.patch("hq_ai.generate", return_value=(json.dumps(script), "m")), \
             mock.patch.object(weekly, "_engine", return_value="phonon"), \
             mock.patch.object(dj, "_voice_file", return_value=voice), \
             mock.patch.object(weekly, "_assemble", side_effect=assemble), \
             mock.patch.object(dj, "_drop_seconds", return_value=184), \
             mock.patch.object(hq_music, "notify") as notify:
            entry = weekly.build(now, automatic=True)
        self.assertEqual(entry["title"], "Big week")
        self.assertFalse(entry["fallback"])
        self.assertTrue(dj.drop_path(entry["file"]).is_file())  # served by the DJ audio route
        latest = weekly.view()["latest"]
        self.assertEqual(latest["audio_url"], "/api/musica/dj/audio/" + entry["file"])
        self.assertIn("3 min", notify.call_args.args[1])

    def test_model_down_gives_a_plain_script_and_too_few_plays_refuses(self):
        stats = {"plays": 9, "minutes": 30, "active_days": 2, "top_artists": [{"name": "Band A", "plays": 5}],
                 "top_tracks": [{"name": "Loop", "plays": 4}], "new_artists": ["Band Z"]}
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            script = weekly.write_script(stats, "en", "parfois")
        self.assertTrue(script["fallback"])
        self.assertIn("Band A", " ".join(p["text"] for p in script["parts"]))
        with self.assertRaises(dj.DjError):
            weekly.build(datetime.now())  # empty journal

    def test_tick_runs_once_on_sunday_morning(self):
        now = datetime(2026, 11, 15, 11, 0)  # a Sunday
        self.seed(now.astimezone(), 1, n=6)
        with mock.patch.object(weekly, "begin") as begin:
            weekly.tick(datetime(2026, 11, 14, 11, 0))  # Saturday
            weekly.tick(datetime(2026, 11, 15, 9, 0))  # too early
            weekly.tick(now)
            weekly.tick(now + timedelta(minutes=30))
        begin.assert_called_once_with(automatic=True)
        dj.update_settings({"weekly_audio": False})
        hq_music._write(weekly.STATE_FILE, {"weeks": {}})
        with mock.patch.object(weekly, "begin") as begin:
            weekly.tick(now)
        begin.assert_not_called()

    def test_routes(self):
        code, out = dj.http_get("/api/musica/dj/weekly")
        self.assertEqual(code, 200)
        self.assertIsNone(out["latest"])
        with mock.patch.object(weekly, "begin", return_value={"ok": True, "started": True}) as begin:
            code, out = dj.http_post("/api/musica/dj/weekly", {"force": True})
        self.assertEqual(code, 202)
        begin.assert_called_once_with(force=True)


def candidate(i, pool="top"):
    return {"uri": f"spotify:track:{i}", "name": f"Song {i}", "artists": [f"Artist {i}"], "album": "A",
            "image": None, "duration_ms": 200000, "why": "w", "pool": pool}


class PlannerBase(Base):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.object(dj, "candidate_pools",
                                    return_value={"top": [candidate(i) for i in range(1, 6)],
                                                  "discovery": [candidate(9, "discovery")]})
        patcher.start()
        self.addCleanup(patcher.stop)

    def plan(self, reply):
        with mock.patch("hq_ai.generate", return_value=(json.dumps(reply), "m")) as gen:
            seg = dj.plan_segment()
        return seg, gen.call_args.args[1], gen.call_args.args[2][0]["parts"][0]["text"]


class PickTests(PlannerBase):
    def test_planner_marks_her_bet_and_never_on_the_opener(self):
        seg, system, user = self.plan({"tracks": ["c1", "c2", "c3"], "intro": "Hi", "musica_pick": "c1",
                                       "lines": {"c2": "My bet!"}})
        self.assertIn("pari de Musica", system)
        self.assertIn("musica_pick", system)
        self.assertIn("Tes paris : aucun encore", user)
        self.assertEqual([t.get("pick", False) for t in seg["tracks"]], [False, True, False])  # moved off the opener
        _seg, _system, _user = self.plan({"tracks": ["c1", "c2", "c3"], "intro": "Hi", "musica_pick": "zz"})
        self.assertFalse(any(t.get("pick") for t in _seg["tracks"]))  # not one of her tracks: no bet
        dj.update_settings({"picks": False})
        _seg, system, user = self.plan({"tracks": ["c1", "c2", "c3"], "intro": "Hi", "musica_pick": "c2"})
        self.assertNotIn("musica_pick", system)
        self.assertNotIn("Tes paris", user)
        self.assertFalse(any(t.get("pick") for t in _seg["tracks"]))

    def test_bets_are_scored_once_with_streaks_and_fed_back(self):
        seg = segment()
        seg["tracks"][1]["pick"] = True
        seg["tracks"][2]["pick"] = True
        state = dj._state()
        state.update(active=True, segment=seg)
        dj._save_state(state)
        with mock.patch.object(hq_music, "record_feedback"):
            dj.record_completion("spotify:track:1")
            dj.record_completion("spotify:track:1")  # already scored
            dj.record_completion("spotify:track:0")  # not a bet
            self.assertEqual(dj.picks_view()["wins"], 1)
            self.assertEqual(dj.picks_view()["streak"], 1)
            dj.record_skip("spotify:track:2")
        view = dj.picks_view()
        self.assertEqual((view["wins"], view["losses"], view["streak"]), (1, 1, -1))
        self.assertEqual([h["result"] for h in view["recent"]], ["lost", "won"])
        brief = dj._picks_brief(dj._state())
        self.assertIn("1 gagné(s), 1 perdu(s)", brief)
        self.assertIn("Song 1 — Artist 1 (gagné)", brief)
        self.assertIn("Artist 2", brief)  # her missed artist, to avoid as a bet
        self.assertEqual(dj.public_state()["segment"]["tracks"][1]["pick_result"], "won")
        dj.reset_learned()
        self.assertEqual(dj.picks_view()["wins"], 0)


class CharmTests(PlannerBase):
    def test_default_is_complice_and_adds_nothing(self):
        self.assertEqual(dj.settings()["charm"], "complice")
        _seg, system, _user = self.plan({"tracks": ["c1", "c2", "c3"], "intro": "Hi"})
        self.assertNotIn("Registre", system)

    def test_seduisante_needs_the_adult_gate_when_chosen_and_when_used(self):
        with self.assertRaises(dj.DjError) as refused:
            dj.update_settings({"charm": "seduisante"})
        self.assertEqual(refused.exception.status, 403)
        with self.assertRaises(dj.DjError):
            dj.update_settings({"charm": "irresistible"})
        dj.update_settings({"charm": "seduisante"}, adult_ok=True)
        with mock.patch.object(dj, "adult_enabled", return_value=True):
            self.assertEqual(dj.charm_level(), "seduisante")
            _seg, system, _user = self.plan({"tracks": ["c1", "c2", "c3"], "intro": "Hi"})
            self.assertIn("Registre Séduisante", system)
        with mock.patch.object(dj, "adult_enabled", return_value=False):  # adult mode switched off later
            self.assertEqual(dj.charm_level(), "charmeuse")
            _seg, system, _user = self.plan({"tracks": ["c1", "c2", "c3"], "intro": "Hi"})
            self.assertIn("Registre Charmeuse", system)
            self.assertNotIn("Séduisante", system)
            self.assertEqual(dj.public_state()["charm"], {"level": "charmeuse", "adult": False})

    def test_route_passes_the_request_gate(self):
        with mock.patch("hq_ai.nsfw_allowed", return_value=False):
            code, _out = hq_musica.http_post("/api/musica/dj/settings", {"charm": "seduisante"}, role="admin")
        self.assertEqual(code, 403)
        with mock.patch("hq_ai.nsfw_allowed", return_value=True), mock.patch.object(dj, "start_station"):
            code, out = hq_musica.http_post("/api/musica/dj/settings", {"charm": "seduisante"}, role="admin")
        self.assertEqual(code, 200)
        self.assertEqual(out["settings"]["charm"], "seduisante")

    def test_remarks_follow_the_setting_and_focus_stays_neutral(self):
        dj.update_settings({"charm": "charmeuse"})
        hq_musica._LAST_AMBIENT_AT = 0.0
        with mock.patch("hq_ai.generate", return_value=("Coucou", "m")) as gen:
            hq_musica.ambient_line(track="Song", artist="A", playing=False)
        self.assertIn("charming register", gen.call_args.args[1])
        with mock.patch("hq_ai.generate", return_value=(json.dumps({"tracks": ["c1", "c2", "c3", "c4"], "intro": "x"}), "m")) as gen, \
             mock.patch("hq_music.mood_suggestion", return_value={"minutes": 20}):
            dj.plan_segment(show="focus")
        self.assertNotIn("Registre", gen.call_args.args[1])


if __name__ == "__main__":
    unittest.main()
