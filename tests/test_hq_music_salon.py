"""Musique salon extras: listening journal, release alerts, quiz, mood, energy curve, DJ line, lyrics, Studio remix."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import hq_music
import hq_music_journal as journal
import hq_music_quiz as quiz
import hq_music_radar as radar
import hq_music_studio as studio
import hq_musica
import hq_spotify


def iso(dt):
    return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def track(name, artist, played, uri=None, duration=200000):
    return {"name": name, "artists": [artist], "uri": uri or f"spotify:track:{name}", "album": "A",
            "duration_ms": duration, "played_at": iso(played)}


class Bound(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        self.root = Path(self.tmp.name)


class JournalTests(Bound):
    def test_records_only_new_plays_and_builds_recap(self):
        now = datetime.now(timezone.utc).replace(hour=12)
        rows = [track("One", "Sabaton", now - timedelta(days=2)), track("Two", "Ghost", now - timedelta(days=1)),
                track("One", "Sabaton", now)]
        self.assertEqual(journal.record(rows)["added"], 3)
        self.assertEqual(journal.record(rows)["added"], 0)  # cursor: the same 50-window is not re-added
        newer = track("Three", "Sabaton", now + timedelta(minutes=5))
        self.assertEqual(journal.record(rows + [newer])["added"], 1)
        month = (now + timedelta(minutes=5)).astimezone().strftime("%Y-%m")
        recap = journal.recap(month)
        self.assertGreaterEqual(recap["plays"], 1)
        self.assertEqual(recap["top_artists"][0]["name"], "Sabaton")
        self.assertEqual(len(recap["heatmap"]), 7)
        self.assertEqual(len(recap["heatmap"][0]), 24)
        lookup = journal.lookup(artist="sabaton")
        self.assertEqual(lookup["artist"]["count"], 3)
        self.assertTrue(lookup["journal_since"])
        self.assertEqual(journal.lookup(artist="Nobody")["artist"]["count"], 0)

    def test_streaks_and_disabled_sync(self):
        today = datetime.now().astimezone()
        rows = [track(f"T{i}", "A", (today - timedelta(days=i)).replace(hour=10)) for i in range(3)]
        journal.record(rows)
        self.assertEqual(journal.current_streak(today.date()), 3)
        journal.set_enabled(False)
        self.assertEqual(journal.sync(force=True)["skipped"], "disabled")
        with self.assertRaises(hq_music.MusicError):
            journal.recap("2026-13")

    def test_sync_reads_recently_played_once_per_interval(self):
        played = datetime.now(timezone.utc)
        api = {"items": [{"played_at": iso(played), "track": {"name": "X", "uri": "spotify:track:x",
                                                              "artists": [{"name": "Y"}], "duration_ms": 1000}}]}
        with mock.patch.object(hq_spotify, "status", return_value={"connected": True}), \
             mock.patch.object(hq_spotify, "api_request", return_value=api) as request:
            self.assertEqual(journal.sync()["added"], 1)
            self.assertEqual(journal.sync()["skipped"], "recent")
            request.assert_called_once()


class AlertTests(Bound):
    def test_release_alert_once_and_only_when_enabled(self):
        sent = []
        hq_music.bind(root=self.tmp.name, notify=lambda title, body: sent.append((title, body)))
        item = {"uri": "spotify:album:new", "name": "Legends", "artists": ["Sabaton"]}
        silent = {"items": [item], "notified": []}
        self.assertEqual(radar._alert_new_releases(silent, previous_uris=set()), [])
        self.assertEqual(sent, [])
        self.assertEqual(silent["notified"], ["spotify:album:new"])  # remembered even while alerts are off
        hq_music.set_alerts({"releases": True})
        fresh = {"items": [item, {"uri": "spotify:album:b", "name": "B", "artists": ["Ghost"]}], "notified": silent["notified"]}
        self.assertEqual(radar._alert_new_releases(fresh, previous_uris=set()), ["spotify:album:b"])
        self.assertEqual(sent[0][0], "Nouvelle sortie : Ghost")
        self.assertEqual(radar._alert_new_releases(fresh, previous_uris=set()), [])
        with self.assertRaises(hq_music.MusicError):
            hq_music.set_alerts({"releases": "yes"})


class MoodTests(Bound):
    def test_mood_from_calendar(self):
        now = datetime(2026, 11, 12, 13, 0)
        events = [{"title": f"Réunion {i}", "start": f"2026-11-12T{h}:00", "end": f"2026-11-12T{h}:45"}
                  for i, h in enumerate(("09", "11", "15", "16"))]
        hq_music.bind(root=self.tmp.name, calendar=lambda start, end: events)
        mood = hq_music.mood_suggestion(now)
        self.assertIn("focus", mood["label"].lower())
        self.assertEqual(mood["next_event"]["start"], "15:00")
        self.assertLessEqual(mood["minutes"], 60)
        soon = hq_music.mood_suggestion(datetime(2026, 11, 12, 14, 50))
        self.assertEqual(soon["activity"], "transition")
        hq_music.bind(root=self.tmp.name, calendar=lambda start, end: (_ for _ in ()).throw(RuntimeError("x")))
        self.assertIn("activity", hq_music.mood_suggestion(datetime(2026, 11, 12, 22, 0)))


class EnergyTests(unittest.TestCase):
    def test_arc_orders_calm_then_peak_then_calm(self):
        tracks = [{"uri": f"t{i}", "source_id": src, "artists": [f"a{i}"]}
                  for i, src in enumerate(["calm"] * 4 + ["hot"] * 4)]
        session = hq_music.apply_energy_curve({"tracks": tracks}, {"calm": 1, "hot": 5}, "arc")
        energies = [t["energy"] for t in session["tracks"]]
        self.assertEqual(energies[0], 1)
        self.assertEqual(max(energies), 5)
        self.assertEqual(energies[-1], 1)
        self.assertEqual([t["position"] for t in session["tracks"]], list(range(1, 9)))


class QuizTests(Bound):
    def setUp(self):
        super().setUp()
        hq_spotify.bind(root=self.tmp.name, config_getter=lambda: {})
        self.addCleanup(hq_spotify.reset_for_tests)

    def pool(self, n=12):
        return {"items": [{"track": {"id": str(i), "uri": f"spotify:track:{i}", "name": f"Song {i}",
                                     "artists": [{"name": f"Artist {i}"}], "duration_ms": 200000}} for i in range(n)],
                "next": None}

    def test_round_flow_hides_answer_and_scores(self):
        calls = []

        def api(method, path, **kwargs):
            calls.append((method, path, kwargs))
            if path == "/me/tracks":
                return self.pool()
            if path == "/me/playlists":  # track lists play through HQ's private playback playlist
                return {"id": "PL1aaaaaaaaaaaaaaaaaaa", "uri": "spotify:playlist:PL1aaaaaaaaaaaaaaaaaaa"}
            return {}

        with mock.patch.object(hq_spotify, "api_request", side_effect=api), \
             mock.patch.object(hq_spotify, "ensure_playback_device", return_value={"id": "dev"}):
            game = quiz.start({"rounds": 5, "source": "saved"})
            self.assertNotIn("rounds", game)
            self.assertEqual(game["total"], 5)
            played = quiz.next_round(game["id"])
            self.assertTrue(played["awaiting"])
            self.assertEqual(len(played["choices"]), 4)
            self.assertTrue(all("uri" not in c for c in played["choices"]))
            put = [c for c in calls if c[1] == "/me/player/play"][-1]
            self.assertGreater(put[2]["body"]["position_ms"], 0)
            secret = json.loads((self.root / ".hq-music" / "quiz.json").read_text(encoding="utf-8"))
            right = secret["rounds"][0]["answer"]
            result = quiz.answer(game["id"], right)
            self.assertTrue(result["right"])
            self.assertEqual(result["score"], 1)
            with self.assertRaises(hq_music.MusicError):
                quiz.answer(game["id"], right)  # no round awaiting
            for _ in range(4):
                quiz.next_round(game["id"])
                result = quiz.answer(game["id"], 0)
            self.assertTrue(result["done"])
            self.assertGreaterEqual(result["best"], 1)

    def test_reaction_streams_in_after_the_scripted_line(self):
        with mock.patch("hq_ai.generate", return_value=("Ha, tu as reconnu ce riff en trois notes !", "m")) as gen:
            facts = {"right": True, "track": "Song — Art", "picked": None, "round": 2, "total": 5, "score": 2,
                     "streak": 2, "done": False, "best_before": 3}
            quiz._reactions["g1-1"] = {"pending": True, "text": "scripted"}
            quiz._stream_reaction("g1-1", facts, "scripted")
        self.assertEqual(quiz.reaction_view("g1-1"), {"ok": True, "pending": False, "text": "Ha, tu as reconnu ce riff en trois notes !"})
        system = gen.call_args.args[1]
        self.assertIn("streak", gen.call_args.args[2][0]["parts"][0]["text"])
        self.assertIn("quiz", system)
        # a model failure keeps the scripted line; an unknown id is an empty, finished reaction
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("down")):
            quiz._reactions["g1-2"] = {"pending": True, "text": "scripted"}
            quiz._stream_reaction("g1-2", facts, "scripted")
        self.assertEqual(quiz.reaction_view("g1-2")["text"], "scripted")
        self.assertEqual(quiz.reaction_view("nope"), {"ok": True, "pending": False, "text": ""})
        # while pending the view hides the placeholder
        quiz._reactions["g1-3"] = {"pending": True, "text": "scripted"}
        self.assertEqual(quiz.reaction_view("g1-3"), {"ok": True, "pending": True, "text": ""})

    def test_small_pool_and_bad_input(self):
        with mock.patch.object(hq_spotify, "api_request", return_value=self.pool(5)):
            with self.assertRaises(hq_music.MusicError) as caught:
                quiz.start({"rounds": 5})
            self.assertEqual(caught.exception.code, "quiz_pool_small")
        with self.assertRaises(hq_music.MusicError):
            quiz.start({"rounds": 7})
        with self.assertRaises(hq_music.MusicError):
            quiz.answer("nope", 0)


class MusicaExtrasTests(Bound):
    def setUp(self):
        super().setUp()
        hq_musica.bind(root=self.tmp.name)
        hq_musica._DJ_LAST.update(at=0.0, uri="")

    def test_dj_line_uses_model_and_cools_down(self):
        with mock.patch("hq_ai.generate", return_value=("« Place à Sabaton, ça va cogner ! »", "m")) as gen:
            first = hq_musica.dj_line({"track": "Primo Victoria", "artist": "Sabaton", "uri": "spotify:track:1"})
            self.assertEqual(first["line"], "Place à Sabaton, ça va cogner !")
            again = hq_musica.dj_line({"track": "Other", "artist": "X", "uri": "spotify:track:2"})
            self.assertTrue(again["cooldown"])
            gen.assert_called_once()
            system = gen.call_args.args[1]
            self.assertIn("DJ Musica", system)
        with self.assertRaises(hq_musica.MusicaError):
            hq_musica.dj_line({"track": ""})

    def test_ambient_line_signature_fixed(self):
        hq_musica._LAST_AMBIENT_AT = 0.0
        with mock.patch("hq_ai.generate", return_value=("Hé, Maître !", "m")) as gen:
            out = hq_musica.ambient_line(track="T", artist="A", playing=False)
        self.assertEqual(out["line"], "Hé, Maître !")
        self.assertIsInstance(gen.call_args.args[1], str)

    def test_dance_lines_parse_cooldown_and_fallback(self):
        hq_musica._LAST_DANCE_AT = 0.0
        reply = "\n".join(
            f"{kind}: Phrase {kind} numéro {i} ♡" for kind in hq_musica.DANCE_KINDS for i in (1, 2)
        ) + "\nbruit sans format"
        with mock.patch("hq_ai.generate", return_value=(reply, "m")) as gen:
            out = hq_musica.dance_lines(track="Song", artist="A", intensity=0.9)
            again = hq_musica.dance_lines(track="Song", artist="A")
        self.assertEqual(set(out["lines"]), set(hq_musica.DANCE_KINDS) - hq_musica.ADULT_KINDS)  # no spank lines outside adult mode
        self.assertEqual(len(out["lines"]["drop"]), 2)
        self.assertIn("shake", out["lines"])
        self.assertTrue(again["cooldown"])
        gen.assert_called_once()
        self.assertEqual(gen.call_args.args[0][0], "gemini-3.5-flash-lite")  # fastest model leads
        hq_musica._LAST_DANCE_AT = 0.0
        with mock.patch("hq_ai.generate", return_value=("n'importe quoi", "m")):
            self.assertEqual(hq_musica.dance_lines()["lines"], {})
        hq_musica._LAST_DANCE_AT = 0.0
        with mock.patch("hq_ai.generate", side_effect=RuntimeError("boom")):
            self.assertEqual(hq_musica.dance_lines()["lines"], {})

    def test_lyrics_draft_and_refine(self):
        reply = json.dumps({"lyrics": "[Verse]\nLights over the forge\n[Chorus]\nRise", "note": "Un refrain qui cogne."})
        with mock.patch("hq_ai.generate", return_value=(reply, "m")):
            out = hq_musica.draft_lyrics({"mode": "draft", "prompt": "industrial metal", "language": "en"})
        self.assertIn("[Chorus]", out["lyrics"])
        with self.assertRaises(hq_musica.MusicaError):
            hq_musica.draft_lyrics({"mode": "refine", "lyrics": ""})
        with mock.patch("hq_ai.generate", return_value=("not json", "m")):
            with self.assertRaises(hq_musica.MusicaError):
                hq_musica.draft_lyrics({"mode": "draft", "idea": "x"})

    def test_journal_tool_is_history_gated(self):
        hq_music.update_taste({"history_sharing": False})
        with self.assertRaises(hq_musica.MusicaError):
            hq_musica._run_tool("my_listening_journal", {"artist": "X"})
        hq_music.update_taste({"history_sharing": True})
        self.assertTrue(hq_musica._run_tool("my_listening_journal", {"artist": "X"})["ok"])
        self.assertTrue(hq_musica._run_tool("my_listening_memory", {})["ok"])


class StudioRemixTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        python = self.root / "ACE-Step-1.5" / ".venv" / "Scripts" / "python.exe"
        python.parent.mkdir(parents=True)
        python.touch()
        studio._active = None
        self.addCleanup(setattr, studio, "_active", None)
        self.parent = "d" * 32
        folder = self.root / ".hq-music" / "studio" / self.parent
        folder.mkdir(parents=True)
        (folder / "job.json").write_text(json.dumps({"id": self.parent, "status": "running", "prompt": "metal",
                                                    "lyrics": "[Verse] hi", "seed": 1, "duration": 60}), encoding="utf-8")
        (folder / "result.json").write_text(json.dumps({"status": "completed", "duration_seconds": 60.0}), encoding="utf-8")
        (folder / "song.mp3").write_bytes(b"parent")

    def start(self, body):
        process = mock.Mock()
        process.poll.return_value = None
        with mock.patch.object(studio.subprocess, "Popen", return_value=process), \
             mock.patch.object(studio.threading.Thread, "start"):
            return studio.start(self.root, body)

    def test_remix_validation(self):
        with self.assertRaises(studio.StudioError):
            self.start({"prompt": "x", "task": "lego"})
        with self.assertRaises(studio.StudioError):
            self.start({"prompt": "x", "task": "repaint", "source_id": self.parent, "start": 50, "end": 51})
        with self.assertRaises(studio.StudioError):
            self.start({"prompt": "x", "task": "extend", "source_id": self.parent, "extra": 200})
        with self.assertRaises(studio.StudioError):
            self.start({"prompt": "x", "variants": 4})
        with self.assertRaises(studio.StudioError):
            self.start({"prompt": "x", "variants": 3, "duration": 120})

    def test_repaint_and_extend_jobs_carry_source(self):
        job = self.start({"prompt": "new chorus", "task": "repaint", "source_id": self.parent, "start": 10, "end": 22})
        self.assertEqual((job["task"], job["start"], job["end"], job["duration"]), ("repaint", 10.0, 22.0, 60))
        self.assertEqual(job["lyrics"], "[Verse] hi")  # inherited from the source take
        self.assertTrue(job["src_audio"].endswith("song.mp3"))
        listed = studio._status(self.root, job["id"])
        self.assertNotIn("src_audio", listed)
        studio._active = None
        ext = self.start({"prompt": "outro", "task": "extend", "source_id": self.parent, "extra": 30})
        self.assertEqual((ext["start"], ext["end"], ext["duration"]), (58.0, 90.0, 90))

    def test_variants_pick_and_library_copy(self):
        ident = "e" * 32
        folder = self.root / ".hq-music" / "studio" / ident
        folder.mkdir(parents=True)
        (folder / "job.json").write_text(json.dumps({"id": ident, "status": "running", "prompt": "Dark synth",
                                                    "seed": 5, "variants": 2, "duration": 60}), encoding="utf-8")
        (folder / "result.json").write_text(json.dumps({"status": "completed", "variants_ready": 2, "seeds": [5, 6],
                                                       "duration_seconds": 60}), encoding="utf-8")
        (folder / "song.mp3").write_bytes(b"A")
        (folder / "song-2.mp3").write_bytes(b"B")
        status = studio._status(self.root, ident)
        self.assertEqual(len(status["variant_urls"]), 2)
        self.assertEqual(studio.audio_path(self.root, ident + ".2").read_bytes(), b"B")
        with self.assertRaises(studio.StudioError):
            studio.audio_path(self.root, ident + ".9")
        picked = studio.pick(self.root, ident, 2)
        self.assertEqual((folder / "song.mp3").read_bytes(), b"B")
        self.assertFalse((folder / "song-2.mp3").exists())
        self.assertNotIn("variant_urls", picked)
        self.assertEqual(picked["seed"], 6)
        with self.assertRaises(studio.StudioError):
            studio.pick(self.root, ident, 1)
        copied = studio.copy_to_library(self.root, ident)
        self.assertTrue((self.root / "Inbox" / "Musica Studio" / copied["name"]).is_file())
        self.assertTrue(copied["name"].startswith("Dark synth"))


if __name__ == "__main__":
    unittest.main()
