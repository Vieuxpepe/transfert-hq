"""Chatterbox voice for DJ Musica: engine choice, mood mapping, cache, fallback to Phonon, A/B comparison."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import hq_music
import hq_music_dj as dj
import hq_musica
import hq_voice_chatterbox as cb


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ChatterboxModuleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for name, value in (("CACHE_DIR", root / "cache"), ("VOICES_DIR", root / "voices"),
                            ("CB_PYTHON", root / "python.exe")):
            patcher = mock.patch.object(cb, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (root / "python.exe").touch()
        (root / "voices").mkdir()
        (root / "voices" / "musica.wav").write_bytes(b"RIFF")

    def test_mood_controls_are_sent_and_result_cached(self):
        sent = []

        def urlopen(req, timeout=None):
            if getattr(req, "data", None):
                sent.append(json.loads(req.data))
                return FakeResponse(b"RIFFwav")
            return FakeResponse(json.dumps({"ready": True}).encode())

        with mock.patch.object(cb.urllib.request, "urlopen", side_effect=urlopen), mock.patch("hq_engine.touch"):
            first = cb.synthesize("Let's go, Master!", mood="hype")
            again = cb.synthesize("Let's go, Master!", mood="hype")
        self.assertTrue(first["ok"])
        self.assertTrue(again["cached"])
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["voice"], "musica")
        self.assertEqual(sent[0]["exaggeration"], cb.MOODS["hype"]["exaggeration"])
        self.assertTrue(first["audio_url"].startswith("/assets/companion/chat/voice_cache/voice_cb"))

    def test_daemon_down_returns_none_and_starts_it(self):
        with mock.patch.object(cb, "_health", return_value={}), mock.patch.object(cb, "start_daemon") as start:
            self.assertIsNone(cb.synthesize("Hello there"))
        start.assert_called_once()

    def test_recloned_voice_changes_cache_key(self):
        before = cb.cache_key("x", "musica", "hype")
        ref = cb.VOICES_DIR / "musica.wav"
        stamp = ref.stat().st_mtime + 60
        os.utime(ref, (stamp, stamp))
        self.assertNotEqual(cb.cache_key("x", "musica", "hype"), before)

    def test_unknown_mood_falls_back_to_neutral_key(self):
        self.assertEqual(cb.cache_key("x", "musica", "neutral"), cb.cache_key("x", "musica", "neutral"))
        self.assertNotEqual(cb.cache_key("x", "musica", "hype"), cb.cache_key("x", "musica", "tender"))


class DjEngineChoiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        hq_musica.bind(root=self.tmp.name)

    def test_engine_rules(self):
        with mock.patch.object(cb, "installed", return_value=True), mock.patch.object(cb, "daemon_ready", return_value=True):
            self.assertEqual(dj.voice_engine_for("musica", "en"), "chatterbox")
            self.assertEqual(dj.voice_engine_for("musica", "fr"), "phonon")  # English-only model
            self.assertEqual(dj.voice_engine_for("transferania", "en"), "phonon")  # guests keep their own voice
            dj.update_settings({"voice_engine": "phonon"})
            self.assertEqual(dj.voice_engine_for("musica", "en"), "phonon")
        dj.update_settings({"voice_engine": "auto"})
        with mock.patch.object(cb, "installed", return_value=True), mock.patch.object(cb, "daemon_ready", return_value=False), \
             mock.patch.object(cb, "start_daemon") as start:
            self.assertEqual(dj.voice_engine_for("musica", "en"), "phonon")  # warming up: this line uses Phonon
            start.assert_called_once()
        with self.assertRaises(dj.DjError):
            dj.update_settings({"voice_engine": "bogus"})

    def test_chatterbox_failure_falls_back_to_phonon(self):
        with mock.patch.object(cb, "synthesize", return_value=None), \
             mock.patch("hq_voice.synthesize", return_value=None) as phonon:
            self.assertIsNone(dj._voice_file("Hello", "musica", "en", "hype", engine="chatterbox"))
        phonon.assert_called_once()  # tried Phonon after Chatterbox gave nothing

    def test_planner_moods_reach_tracks_and_intro(self):
        rows = [{"uri": f"spotify:track:{i}", "name": f"S{i}", "artists": [f"A{i}"], "album": "A", "image": None,
                 "duration_ms": 200000, "why": "w", "pool": "top"} for i in range(1, 6)]
        reply = {"tracks": ["c1", "c2", "c3"], "intro": "Hi!", "lines": {"c2": "Nice one."},
                 "moods": {"intro": "playful", "c2": "tender", "c3": "shouty"}}
        with mock.patch.object(dj, "candidate_pools", return_value={"top": rows}), \
             mock.patch("hq_ai.generate", return_value=(json.dumps(reply), "m")) as gen:
            seg = dj.plan_segment()
        self.assertIn("humeur", gen.call_args.args[1])
        self.assertEqual(seg["intro_mood"], "playful")
        self.assertEqual(seg["tracks"][1]["mood"], "tender")
        self.assertEqual(seg["tracks"][2]["mood"], "warm")  # unknown mood -> default

    def test_compare_reports_when_chatterbox_not_ready(self):
        with mock.patch.object(dj, "show_language", return_value="en"), \
             mock.patch.object(dj, "make_drop", return_value="drop-" + "d" * 20 + ".mp3"), \
             mock.patch.object(cb, "installed", return_value=True), mock.patch.object(cb, "daemon_ready", return_value=False), \
             mock.patch.object(cb, "start_daemon"):
            out = dj.voice_compare({})
        self.assertTrue(out["phonon"])
        self.assertIsNone(out["chatterbox"])
        self.assertIn("démarre", out["note"])


class ExpressivenessTests(unittest.TestCase):
    def test_inline_tags_split_moods_and_short_bits_merge(self):
        chunks = cb.plan_chunks("Good evening! Big one. [tender] Breathe with me… slowly. [playful] Don't judge me!", "hype")
        self.assertEqual([m for _t, m in chunks], ["hype", "tender", "playful"])
        self.assertEqual(chunks[0][0], "Good evening! Big one.")
        self.assertEqual(cb.strip_tags("Hi! [tender] Soft."), "Hi! Soft.")

    def test_intensity_raises_emotion_and_slows_pacing(self):
        calm, vivid = cb.controls("hype", 1.0), cb.controls("hype", 1.4)
        self.assertGreater(vivid["exaggeration"], calm["exaggeration"])
        self.assertLess(vivid["cfg_weight"], calm["cfg_weight"])
        self.assertLessEqual(cb.controls("hype", 9)["exaggeration"], 1.3)
        self.assertNotEqual(cb.cache_key("x", "musica", "hype", 1.0), cb.cache_key("x", "musica", "hype", 1.4))

    def test_multi_sentence_line_is_generated_per_mood_and_joined(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        moods = []
        with mock.patch.object(cb, "CACHE_DIR", root), mock.patch.object(cb, "installed", return_value=True),              mock.patch.object(cb, "daemon_ready", return_value=True), mock.patch.object(cb, "has_voice", return_value=True),              mock.patch.object(cb, "_generate", side_effect=lambda text, ch, mood, k, t: moods.append(mood) or b"RIFF"),              mock.patch.object(cb, "_join", side_effect=lambda parts, out: out.write_bytes(b"RIFFjoined") or True),              mock.patch.object(cb, "_master", return_value=False), mock.patch("hq_engine.touch"):
            out = cb.synthesize("Hello there, Master! [tender] This one is much softer, so breathe.", mood="hype")
        self.assertEqual(moods, ["hype", "tender"])
        self.assertEqual(out["chunks"], 2)
        self.assertFalse(list(root.glob("part*")))  # sentence parts cleaned up


class DjTagTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)

    def test_phonon_never_reads_tags_and_setting_validates(self):
        seen = []
        with mock.patch.object(dj, "_voice_file", side_effect=lambda text, *a, **k: seen.append(text)):
            dj.make_drop("Hi! [tender] Soft now.", engine="phonon", language="en")
        self.assertEqual(seen, ["Hi! Soft now."])
        self.assertEqual(dj._strip_tags("Go! [hype] Now!"), "Go! Now!")
        dj.update_settings({"expressiveness": 1.4})
        self.assertEqual(dj.settings()["expressiveness"], 1.4)
        with self.assertRaises(dj.DjError):
            dj.update_settings({"expressiveness": 3})


if __name__ == "__main__":
    unittest.main()
