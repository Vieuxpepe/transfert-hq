"""Real local-model coverage for phonetic visual speech, without AI calls."""
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import hq_pronunciation as P


class PronunciationTests(unittest.TestCase):
    def test_language_selection_and_explicit_override(self):
        self.assertEqual(P.language_for("Bonjour, comment vas-tu ?"), "fr-fr")
        self.assertEqual(P.language_for("Hello, how are you today?"), "en-us")
        self.assertEqual(P.language_for("read", "en"), "en-us")
        self.assertEqual(P.language_for("hello", "fr-ca"), "fr-fr")

    def test_ipa_stress_nasal_and_diphthong_mapping(self):
        self.assertEqual(P.phoneme_visemes("ˈaɪ"), ["A", "I"])
        self.assertEqual(P.phoneme_visemes("ɔ̃"), ["O"])
        self.assertEqual(P.phoneme_visemes("t͡ʃ"), ["T", "SH"])
        self.assertEqual(P.phoneme_visemes("ɚ"), ["R"])
        self.assertEqual(P.phoneme_visemes("s"), ["S"])
        self.assertEqual(P.phoneme_visemes("z"), ["S"])
        self.assertEqual(P.phoneme_visemes("ʃ"), ["SH"])

    def test_limits_and_missing_engine_fallback(self):
        self.assertIsNone(P.pronunciation(""))
        self.assertIsNone(P.pronunciation("a" * 4001))
        with patch.object(P, "_plan", side_effect=ImportError("optional engine absent")):
            self.assertIsNone(P.pronunciation("A unique test phrase", "en"))
            original = {"reply": "Another fallback phrase"}
            self.assertIs(P.enrich(original), original)

    @unittest.skipUnless(importlib.util.find_spec("gruut"), "optional local engine not installed")
    def test_real_engine_irregular_french_and_liaison(self):
        plan = P.pronunciation("La femme et le monsieur arrivent.", "fr")
        self.assertIsNotNone(plan)
        self.assertEqual(plan["words"][1]["visemes"], ["F", "A", "M"])
        self.assertIn("U", plan["words"][4]["visemes"])
        liaison = P.pronunciation("Les amis arrivent.", "fr")
        self.assertIn("z", liaison["words"][0]["phonemes"])

    @unittest.skipUnless(importlib.util.find_spec("gruut"), "optional local engine not installed")
    def test_real_engine_context_and_original_token_alignment(self):
        text = "I read it yesterday, but I like to read."
        plan = P.pronunciation(text, "en")
        self.assertEqual([w["text"] for w in plan["words"]], text.split())
        self.assertNotEqual(plan["words"][1]["phonemes"], plan["words"][-1]["phonemes"])
        numbers = P.pronunciation("J’ai 12 euros. …", "fr")
        self.assertEqual([w["text"] for w in numbers["words"]], ["J’ai", "12", "euros.", "…"])
        self.assertTrue(numbers["words"][1]["visemes"])
        self.assertEqual(numbers["words"][-1]["visemes"], [])

    @unittest.skipUnless(importlib.util.find_spec("gruut"), "optional local engine not installed")
    def test_chat_and_ambient_attach_plans_without_ai_requests(self):
        import hq_ai
        with patch.object(hq_ai, "transferania_post", return_value={"reply": "Bonjour"}):
            code, result = hq_ai.http_post({"action": "transferania", "op": "send", "pronunciation_language": "fr"}, role="admin")
            self.assertEqual(code, 200)
            self.assertEqual(result["pronunciation"]["engine"], "gruut")
        with patch.object(hq_ai, "ambient", return_value={"line": "Hello"}):
            code, result = hq_ai.http_post({"action": "ambient", "pronunciation_language": "en"}, role="admin")
            self.assertEqual(code, 200)
            self.assertEqual(result["pronunciation"]["language"], "en-us")


if __name__ == "__main__":
    unittest.main()
