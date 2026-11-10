"""Behavioral checks for Else chip sticky mood hold priority."""
from __future__ import annotations

import unittest

HOLD_ORDER = ["busy", "speech", "typing", "sister", "context", "flash"]


def resolve_mood(holds: dict, now: int = 1_000_000) -> str:
    for key in HOLD_ORDER:
        h = holds.get(key)
        if not h:
            continue
        until = h.get("until")
        if until is not None and now >= until:
            continue
        return h["mood"]
    return "idle"


class ElseMoodHoldPriority(unittest.TestCase):
    def test_speech_beats_typing_and_flash(self) -> None:
        holds = {
            "speech": {"mood": "speaking", "until": None},
            "typing": {"mood": "listening", "until": None},
            "flash": {"mood": "proactive", "until": 2_000_000},
        }
        self.assertEqual(resolve_mood(holds), "speaking")

    def test_typing_beats_sister_and_context(self) -> None:
        holds = {
            "typing": {"mood": "listening", "until": None},
            "sister": {"mood": "sister", "until": 2_000_000},
            "context": {"mood": "busy", "until": None},
        }
        self.assertEqual(resolve_mood(holds), "listening")

    def test_busy_beats_speech(self) -> None:
        holds = {
            "busy": {"mood": "busy", "until": None},
            "speech": {"mood": "speaking", "until": None},
        }
        self.assertEqual(resolve_mood(holds), "busy")

    def test_expired_flash_falls_to_idle(self) -> None:
        holds = {"flash": {"mood": "proactive", "until": 500}}
        self.assertEqual(resolve_mood(holds, now=1000), "idle")

    def test_sister_survives_after_speech_clears(self) -> None:
        holds = {
            "sister": {"mood": "sister", "until": 2_000_000},
            "flash": {"mood": "listening", "until": 500},
        }
        self.assertEqual(resolve_mood(holds, now=1000), "sister")


if __name__ == "__main__":
    unittest.main()
