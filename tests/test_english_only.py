"""Nothing an assistant says or speaks may come out in French (hq_language).

The user-interface labels are out of scope: they are drawn by the browser. These tests
guard the three ways French used to get in: a prompt that asks for it, a language
parameter that defaults to it, and a speech engine told to use it.
"""
from __future__ import annotations

import os
import re
import unittest
from pathlib import Path
from unittest import mock

import hq_language

ROOT = Path(__file__).resolve().parent.parent


class PolicyTests(unittest.TestCase):
    def test_every_language_choice_is_english(self):
        for asked in ("fr", "en", None, "", "auto", "de"):
            self.assertEqual(hq_language.pick(asked), "en", asked)

    def test_the_policy_is_appended_once_to_any_prompt(self):
        once = hq_language.apply("Tu es Transferania. Réponds en JSON.")
        self.assertIn(hq_language.MARKER, once)
        self.assertTrue(once.startswith("Tu es Transferania."))
        self.assertEqual(hq_language.apply(once), once, "never doubled")
        self.assertIn("English", once)
        self.assertIn("JSON keys", once, "the exact field names a caller asked for survive")

    def test_it_can_be_switched_off_for_the_legacy_bilingual_mechanism(self):
        with mock.patch.dict(os.environ, {"HQ_ENGLISH_ONLY": "0"}):
            self.assertFalse(hq_language.english_only())
            self.assertEqual(hq_language.pick("fr"), "fr")
            self.assertEqual(hq_language.pick("en"), "en")
            self.assertEqual(hq_language.apply("x"), "x")


class SpeechAndRepliesTests(unittest.TestCase):
    def test_speech_and_reply_language_are_english_for_every_character(self):
        import hq_ai
        import hq_voice_phonon
        for who in ("else", "transferania", "culinia", "forgia", "musica", "inventoria", "pistonia", "securia"):
            self.assertEqual(hq_ai.speech_language(who), "en", who)
            self.assertEqual(hq_voice_phonon.reply_language(who), "en", who)
            self.assertIn("English", hq_voice_phonon.language_directive(who), who)

    def test_the_dj_and_the_shopping_list_speak_english(self):
        import hq_inventoria_ai
        import hq_music_dj
        self.assertEqual(hq_music_dj.show_language({"language": "fr"}), "en")
        self.assertEqual(hq_inventoria_ai.language(), "en")

    def test_both_synthesis_entry_points_normalise_the_language(self):
        """Their defaults still say "fr" for the legacy bilingual mode, but under the policy
        the language is forced to English before any engine sees it."""
        import inspect
        import hq_voice
        import hq_voice_phonon
        for fn in (hq_voice.synthesize, hq_voice_phonon.synthesize):
            self.assertIn("hq_language.pick(", inspect.getsource(fn), fn.__module__)
        with mock.patch("hq_voice._synthesize_xtts", return_value={"ok": True}) as xtts:
            hq_voice.synthesize("Salut mon Maître", language="fr")
        self.assertEqual(xtts.call_args.kwargs["language"], "en")


class ModelCallTests(unittest.TestCase):
    def test_every_model_call_carries_the_policy_even_for_a_french_prompt(self):
        import hq_ai
        sent = []

        def post(url, body, headers, timeout):
            sent.append(body["systemInstruction"]["parts"][0]["text"])
            return 200, {"candidates": [{"content": {"parts": [{"text": "ok"}]}, "finishReason": "STOP"}],
                         "usageMetadata": {"promptTokenCount": 10}}
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            hq_ai._minute.clear()
            hq_ai._health.clear()
            hq_ai.bind(companion_context_config=lambda: {}, root=Path(tmp), extra_keys=lambda: [],
                       key=lambda: "k", post=post, nvidia_key=lambda: "", nim_fallback=lambda: False,
                       local_llm=lambda: False, local_llm_call=None)
            hq_ai.generate(("gemini-3.1-flash-lite",), "Tu es Transferania, réponds en JSON.",
                           [{"role": "user", "parts": [{"text": "Salut, ça va ?"}]}])
            self.assertEqual(len(sent), 1)
            self.assertTrue(sent[0].startswith("Tu es Transferania"))
            self.assertIn(hq_language.MARKER, sent[0])
            with mock.patch.dict(os.environ, {"HQ_ENGLISH_ONLY": "0"}):
                hq_ai._minute.clear()
                hq_ai.generate(("gemini-3.1-flash-lite",), "Tu es Transferania.",
                               [{"role": "user", "parts": [{"text": "Salut"}]}])
            self.assertNotIn(hq_language.MARKER, sent[1])


# ---- what must never come back: an unconditional request for French
_ASK_FRENCH = re.compile(
    r"(?i)(r[ée]ponds?|[ée]cris|garde|parle)\s+(tout\s+le\s+texte\s+parl[ée]\s+|toujours\s+)?en\s+fran[cç]ais"
    r"|reply in french|answer in french|respond in french|en fran[cç]ais qu[ée]b[ée]cois"
    r"|dans la langue du ma[iî]tre|s'il [ée]crit en fran[cç]ais, en anglais")
# lines that are the opt-out branch of a language choice, or the legacy definition of it
_OPT_OUT_BRANCH = re.compile(r"\belse\b|\bif\b|^\s*LANG_FR\s*=")


class RegressionGuardTests(unittest.TestCase):
    def test_no_prompt_asks_for_french_unconditionally(self):
        offenders = []
        for path in sorted(ROOT.glob("hq_*.py")):
            if path.name == "hq_language.py":
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if _ASK_FRENCH.search(line) and not _OPT_OUT_BRANCH.search(line):
                    offenders.append(f"{path.name}:{number}: {line.strip()[:120]}")
        self.assertEqual(offenders, [], "a prompt asks for French:\n" + "\n".join(offenders))

    def test_no_language_parameter_defaults_to_french(self):
        offenders = []
        # Only `language` parameters: the `lang` of resolve_voice/others_line/line picks a voice
        # catalogue or the wording of a prompt line, not the language of what is said. The Phonon
        # `synthesize` default is normalised by hq_language.pick() before it is used.
        pattern = re.compile(r'\blanguage\s*(:\s*str)?\s*=\s*["\']fr["\']')
        neutralised = re.compile(r"def synthesize\(text: str, \*, character: str")
        for path in sorted(ROOT.glob("hq_*.py")):
            if path.name == "hq_voice.py":  # its entry point normalises the language (see above)
                continue
            for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if pattern.search(line) and "def " in line and not neutralised.search(line):
                    offenders.append(f"{path.name}:{number}: {line.strip()[:120]}")
        self.assertEqual(offenders, [], "a language parameter defaults to French:\n" + "\n".join(offenders))

    def test_the_browser_never_speaks_or_listens_in_french(self):
        offenders = []
        pattern = re.compile(r"""\.lang\s*=\s*[^;\n]*["']fr""")
        for path in sorted((ROOT / "assets").glob("*.js")):
            for number, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
                if pattern.search(line):
                    offenders.append(f"{path.name}:{number}: {line.strip()[:120]}")
        self.assertEqual(offenders, [], "speech language set to French:\n" + "\n".join(offenders))


if __name__ == "__main__":
    unittest.main()
