"""Static client contracts for Else chip upgrades (moods, prefs, voice, DND, portraits)."""
from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHIP_JS = ROOT / "assets" / "hq-else-chip.js"
SISTER_JS = ROOT / "assets" / "hq-sister.js"
CSS = ROOT / "assets" / "hq-companion.css"
PORTRAITS = ROOT / "assets" / "companion"


class ElseChipClientContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.js = CHIP_JS.read_text(encoding="utf-8")
        cls.sister = SISTER_JS.read_text(encoding="utf-8")
        cls.css = CSS.read_text(encoding="utf-8")

    def test_mood_portrait_assets_exist(self) -> None:
        for mood in ("listening", "speaking", "proactive", "sister", "busy"):
            self.assertTrue((PORTRAITS / f"else-chip-{mood}.jpg").is_file(), mood)
            self.assertTrue((PORTRAITS / f"else-chip-{mood}@2x.jpg").is_file(), mood)
            self.assertIn(f"else-chip-{mood}.jpg", self.js)

    def test_server_voice_path_and_browser_fallback(self) -> None:
        self.assertIn('op: "voice"', self.js)
        self.assertIn("thoughtful", self.js)
        self.assertIn("fallbackBrowserSpeech", self.js)
        self.assertIn("audio_url", self.js)

    def test_dnd_gates_cover_mute_nsfw_forge(self) -> None:
        self.assertIn("LS_MUTE_UNTIL", self.js)
        self.assertIn("setMuteMinutes", self.js)
        self.assertIn("DND_VIEWS", self.js)
        self.assertIn("forge", self.js)
        self.assertIn("nsfwOn", self.js)
        self.assertIn("muteUntil", self.js)

    def test_compact_prefs_host_secondary_toggles(self) -> None:
        self.assertIn('data-else-pref="ambient"', self.js)
        self.assertIn('data-else-pref="react"', self.js)
        self.assertIn('data-else-pref="proactive"', self.js)
        self.assertIn('data-else-pref="mute"', self.js)
        self.assertNotIn("hq-else-ambient-toggle", self.js)
        self.assertNotIn("hq-else-proactive-toggle", self.js)

    def test_sister_event_chip_wiring(self) -> None:
        self.assertIn("hq-else-sister-event", self.js)
        self.assertIn("applySisterEventChip", self.js)
        self.assertIn("__lastEvent", self.sister)
        self.assertIn("hq-else-sister-event", self.css)
        self.assertIn("hq-companion-sister-event", self.css)

    def test_motion_tier_hooks(self) -> None:
        self.assertIn("hq:motion-mode", self.js)
        self.assertIn("is-anim-paused", self.js)
        self.assertIn("is-motion-lite", self.js)
        self.assertIn(".hq-else.is-anim-paused", self.css)


if __name__ == "__main__":
    unittest.main()
