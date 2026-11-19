"""The Accueil greeting bank: the line filter, the top-up from the small LLM, and the background kick."""
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_greetings as g  # noqa: E402


class FilterTests(unittest.TestCase):
    def test_keeps_short_french_lines_and_fixes_the_capital(self):
        self.assertEqual(g.clean_line("  bonsoir, Marc-Antoine "), "Bonsoir, Marc-Antoine")
        self.assertEqual(g.clean_line("Encore debout ?"), "Encore debout ?")
        self.assertEqual(g.clean_line("« Belle soirée »"), "Belle soirée")
        self.assertEqual(g.clean_line("Ça va?"), "Ça va ?")  # French spacing before the question mark

    def test_refuses_everything_else(self):
        for bad in ("", "ok", "x" * 40, "Bonne soirée.", "Bonsoir 😊", "Bonsoir <b>", "Bonjour, vous allez bien ?", "Bonjour Maître",
                    "Good evening Marc", "Une très longue phrase de plus", "Salut,", "Il est 18:37", 12, None, ["a"]):
            self.assertIsNone(g.clean_line(bad), bad)


class RefillTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "hq_greetings.json"
        self.asked = []

    def ask_ok(self, messages, temperature, max_tokens, timeout, json_mode=False):
        self.asked.append((messages, json_mode))
        n = len(self.asked)
        return json.dumps({"lines": [f"Salut numéro {chr(96 + n)}{chr(96 + i)}" for i in range(1, 12)] + ["Bad line.", "Hello there"]})

    def test_tops_up_every_moment_with_clean_unique_lines_only(self):
        result = g.refill(self.path, self.ask_ok)
        self.assertEqual(len(self.asked), len(g.BUCKETS))
        self.assertTrue(all(json_mode for _m, json_mode in self.asked))  # JSON mode asked for
        self.assertEqual(result["missing"], [])
        bank = g.load(self.path)
        for name in g.BUCKETS:
            self.assertGreaterEqual(len(bank["lines"][name]), g.TARGET)
            self.assertNotIn("Bad line.", bank["lines"][name])
        self.assertGreater(bank["generated"], 0)
        self.assertIn("Marc-Antoine", self.asked[0][0][0]["content"])  # the person is named in the prompt, in French

    def test_an_unavailable_laptop_writes_nothing_and_stops_at_the_first_refusal(self):
        calls = []
        result = g.refill(self.path, lambda *a, **k: calls.append(1))  # returns None: offline, busy or slow
        self.assertEqual((result["added"], len(calls)), (0, 1))
        self.assertFalse(self.path.exists())

        def boom(*a, **k):
            raise OSError("down")
        self.assertEqual(g.refill(self.path, boom)["added"], 0)

    def test_garbage_replies_add_nothing(self):
        for text in ("Bonjour !", "[]", '{"lines": "x"}', '{"lines": [1, null]}'):
            self.assertEqual(g.refill(self.path, lambda *a, **k: text)["added"], 0, text)

    def test_a_corrupt_file_is_treated_as_empty_and_bad_lines_are_dropped_on_load(self):
        self.path.write_text("{not json", encoding="utf-8")
        self.assertEqual(g.load(self.path)["lines"]["early"], [])
        self.path.write_text(json.dumps({"lines": {"early": ["Bon matin", "Bad line.", "Bon matin", 4]}}), encoding="utf-8")
        self.assertEqual(g.load(self.path)["lines"]["early"], ["Bon matin"])
        self.assertEqual(g.snapshot(self.path)["lines"]["noon"], [])


class KickTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "hq_greetings.json"
        g._state.update(last_try=0.0, running=False)

    def wait_idle(self):
        end = time.time() + 5
        while g._state["running"] and time.time() < end:
            time.sleep(0.02)

    def test_starts_one_background_refill_and_not_again_within_the_gap(self):
        asked = []
        ask = lambda *a, **k: asked.append(1) or None  # noqa: E731
        self.assertTrue(g.kick(self.path, ask, lambda: True))
        self.wait_idle()
        self.assertFalse(g.kick(self.path, ask, lambda: True))  # too soon
        self.assertEqual(len(asked), 1)

    def test_nothing_when_the_laptop_is_not_ready_or_the_bank_is_full(self):
        self.assertFalse(g.kick(self.path, lambda *a, **k: None, lambda: False))
        g._state["last_try"] = 0.0
        full = {"lines": {name: [f"Salut {chr(97 + i)}{chr(97 + n)}" for i in range(g.TARGET)] for n, name in enumerate(g.BUCKETS)}}
        g.save(self.path, full)
        self.assertFalse(g.kick(self.path, lambda *a, **k: None, lambda: True))
        g._state["last_try"] = 0.0
        self.assertFalse(g.kick(self.path, lambda *a, **k: None, lambda: 1 / 0))  # a failing check never raises


if __name__ == "__main__":
    unittest.main()
