"""Repeatable assembly contracts for grounding, character, repetition and size."""
import unittest

from tests.companion_prompt_eval import CASES, evaluate_case


class PromptEvaluationTests(unittest.TestCase):
    def test_synthetic_prompt_contracts(self):
        for case in CASES:
            with self.subTest(case=case["id"]):
                self.assertTrue(evaluate_case(case)["passed"])
