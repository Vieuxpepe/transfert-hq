"""Scripted chat aliveness through the real send path (fake provider, no calls)."""
import unittest

from tests.companion_chat_aliveness import TURNS, run


class ChatAlivenessTests(unittest.TestCase):
    def test_scripted_turns_vary_openings_and_keep_shape_scope(self):
        report = run()
        self.assertEqual(len(report["turns"]), len(TURNS))
        self.assertEqual(report["model_calls"], 0)
        self.assertGreaterEqual(len(report["openings"]), 4)
        self.assertEqual(len(set(report["openings"])), len(report["openings"]),
                         "consecutive replies reused an opening")
        self.assertEqual(len(set(report["avoided"])), len(report["avoided"]),
                         "the same opening was forbidden twice in a row")
        self.assertEqual([row["mode"] for row in report["turns"]],
                         ["social", "social", "comfort", "recall", "social", "social"])


if __name__ == "__main__":
    unittest.main()
