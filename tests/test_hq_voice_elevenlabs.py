"""ElevenLabs voice for DJ Musica: config, quota guard, length cap, cache, fallback to the local voices."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import hq_music
import hq_music_dj as dj
import hq_musica
import hq_voice_elevenlabs as el

KEY = "sk_" + "0" * 48


class FakeResponse:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class ElevenLabsModuleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cfg_path = self.root / "elevenlabs.json"
        el._quota.update(at=0.0, left=None)

    def cfg(self, **extra):
        self.cfg_path.write_text(json.dumps({"api_key": KEY, **extra}), encoding="utf-8")
        return el.load_config(self.cfg_path)

    def test_no_key_means_unconfigured(self):
        with mock.patch.dict("os.environ", {"ELEVENLABS_API_KEY": ""}):
            self.assertIsNone(el.load_config(self.cfg_path))
            self.cfg_path.write_text(json.dumps({"api_key": "nope"}), encoding="utf-8")
            self.assertIsNone(el.load_config(self.cfg_path))

    def test_bad_values_fall_back_to_defaults(self):
        cfg = self.cfg(voice_id="../x", max_chars=-5, model_id="bad model")
        self.assertEqual(cfg["voice_id"], el.DEFAULTS["voice_id"])
        self.assertEqual(cfg["max_chars"], el.DEFAULTS["max_chars"])
        self.assertEqual(cfg["model_id"], el.DEFAULTS["model_id"])

    def test_synthesize_writes_once_and_caches(self):
        cfg = self.cfg()
        out = self.root / "a.mp3"
        calls = []

        def urlopen(req, timeout=None):
            calls.append(req.full_url)
            if "subscription" in req.full_url:
                return FakeResponse(json.dumps({"character_limit": 40000, "character_count": 100}).encode())
            return FakeResponse(b"ID3mp3")

        with mock.patch.object(el.urllib.request, "urlopen", side_effect=urlopen):
            self.assertEqual(el.synthesize("[hype] Hello Master!", cfg, out), out)
            self.assertEqual(el.synthesize("[hype] Hello Master!", cfg, out), out)
        self.assertEqual(out.read_bytes(), b"ID3mp3")
        self.assertEqual(sum("text-to-speech" in c for c in calls), 1)

    def test_long_line_and_low_credits_are_refused(self):
        cfg = self.cfg(max_chars=20, min_credits_left=1500)
        out = self.root / "b.mp3"
        with mock.patch.object(el.urllib.request, "urlopen") as urlopen:
            self.assertIsNone(el.synthesize("x" * 21, cfg, out))
            urlopen.assert_not_called()
        el._quota.update(at=0.0, left=None)
        low = FakeResponse(json.dumps({"character_limit": 40000, "character_count": 39000}).encode())
        with mock.patch.object(el.urllib.request, "urlopen", return_value=low):
            self.assertFalse(el.usable(cfg))
            self.assertIsNone(el.synthesize("short line", cfg, out))

    def test_network_error_returns_none(self):
        cfg = self.cfg()
        with mock.patch.object(el.urllib.request, "urlopen", side_effect=OSError("down")):
            self.assertIsNone(el.synthesize("short line", cfg, self.root / "c.mp3"))


class DjElevenLabsEngineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        hq_musica.bind(root=self.tmp.name)
        dj.update_settings({"voice_engine": "elevenlabs"})

    def test_without_key_it_behaves_like_auto(self):
        with mock.patch.object(dj, "_elevenlabs", return_value=(el, None)):
            self.assertEqual(dj.voice_engine_for("musica", "fr", warm=False), "phonon")

    def test_with_key_musica_only(self):
        cfg = dict(el.DEFAULTS, api_key=KEY)
        with mock.patch.object(dj, "_elevenlabs", return_value=(el, cfg)), mock.patch.object(el, "usable", return_value=True):
            self.assertEqual(dj.voice_engine_for("musica", "en", warm=False), "elevenlabs")
            self.assertEqual(dj.voice_engine_for("musica", "fr", warm=False), "elevenlabs")
            self.assertEqual(dj.voice_engine_for("transferania", "en", warm=False), "phonon")  # guests keep their voice

    def test_failure_falls_back_to_phonon(self):
        cfg = dict(el.DEFAULTS, api_key=KEY)
        with mock.patch.object(dj, "_elevenlabs", return_value=(el, cfg)), mock.patch.object(el, "synthesize", return_value=None), \
             mock.patch.object(dj, "voice_engine_for", return_value="phonon") as pick, \
             mock.patch("hq_voice.synthesize", return_value=None) as phonon:
            self.assertIsNone(dj._voice_file("Hello", "musica", "en", "hype", engine="elevenlabs"))
        pick.assert_called_once()  # the local fallback is chosen as « auto », never « elevenlabs » again
        self.assertEqual(pick.call_args.args[2]["voice_engine"], "auto")
        phonon.assert_called_once()

    def test_changed_voice_changes_drop_key(self):
        st = dj.settings()
        a = dict(el.DEFAULTS, api_key=KEY)
        b = dict(el.DEFAULTS, api_key=KEY, voice_id="AAAAAAAAAAAA")
        with mock.patch.object(dj, "_elevenlabs", return_value=(el, a)):
            ka, _ = dj._drop_key("Hi", "musica", None, False, "en", "neutral", "elevenlabs", st)
        with mock.patch.object(dj, "_elevenlabs", return_value=(el, b)):
            kb, _ = dj._drop_key("Hi", "musica", None, False, "en", "neutral", "elevenlabs", st)
        self.assertNotEqual(ka, kb)


if __name__ == "__main__":
    unittest.main()
