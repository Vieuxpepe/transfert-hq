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

    def test_else_chip_bust_layers(self) -> None:
        self.assertTrue((PORTRAITS / "else-chip-breast-left.png").is_file())
        self.assertTrue((PORTRAITS / "else-chip-breast-right.png").is_file())
        self.assertTrue((PORTRAITS / "else-chip-body.jpg").is_file())
        self.assertIn("else-chip-breast-left", self.js)
        self.assertIn("ensureBustLoop", self.js)
        self.assertIn("nudgeBust", self.js)
        self.assertIn("hq-else-bust", self.css)
        self.assertIn("is-bust", self.js)
        # The chip is ~136 CSS px: the page loads sized derivatives, never the 1280 px masters.
        for stem, ext in (("else-chip-body", "jpg"), ("else-chip-breast-left", "png"), ("else-chip-breast-right", "png")):
            for tag in ("@1x", "@2x"):
                sized = PORTRAITS / f"{stem}{tag}.{ext}"
                self.assertTrue(sized.is_file(), sized.name)
                self.assertLess(sized.stat().st_size, 80_000, sized.name)
            self.assertNotIn(f'{stem}.{ext}"', self.js)
        # Breathing is a CSS keyframe; the rAF loop only runs while a drag impulse decays.
        self.assertIn("hq-else-bust-breathe-l", self.css)
        self.assertIn("bustHasEnergy", self.js)

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

    def test_sticky_mood_holds(self) -> None:
        self.assertIn("moodHolds", self.js)
        self.assertIn("setHold", self.js)
        self.assertIn("paintMood", self.js)
        self.assertIn("holdSister", self.js)
        self.assertIn('setHold("typing"', self.js)
        self.assertIn('setHold("speech"', self.js)
        self.assertIn("speakVisual", self.js)
        self.assertIn("favorPrimed", self.js)
        # Sticky busy must stay owned by syncChromeBusy, not setMood.
        self.assertIn("Sticky busy is owned by syncChromeBusy", self.js)

    def test_voice_lip_sync_hooks(self) -> None:
        self.assertIn("startLipSync", self.js)
        self.assertIn("bindSpeechAudio", self.js)
        self.assertIn("onboundary", self.js)
        self.assertIn("is-lip-pulse", self.js)
        self.assertIn("is-lip-pulse", self.css)
        self.assertIn("hq-else-lip-pulse", self.css)
        # No JS interval thrash for lip pulse (comment may mention setInterval).
        self.assertNotRegex(self.js, r"win\.setInterval\s*\(")

    def test_presence_perf_guards(self) -> None:
        self.assertIn("scheduleSyncMotionPerf", self.js)
        self.assertIn("armMoodExpiry", self.js)
        self.assertIn("requestAnimationFrame", self.js)
        self.assertNotIn("void root.offsetWidth", self.js)
        # Continuous box-shadow glow keyframes were paint-heavy.
        self.assertNotIn("@keyframes hq-else-mood-glow", self.css)

    def test_micro_reactions_and_alive_idle(self) -> None:
        self.assertIn("fireMicro", self.js)
        self.assertIn("scheduleAliveIdle", self.js)
        self.assertIn("hq-else-chip-fx", self.js)
        self.assertIn("hq-else-breathe", self.css)
        self.assertIn("is-fx-blink", self.css)
        self.assertIn("is-mood-idle", self.css)

    def test_context_moods_carnet_forge_favor(self) -> None:
        self.assertIn("syncContextMood", self.js)
        self.assertIn("is-ctx-carnet", self.js)
        self.assertIn("is-ctx-forge", self.js)
        self.assertIn("is-favor-spike", self.js)
        self.assertIn("is-ctx-carnet", self.css)
        self.assertIn("is-ctx-forge", self.css)
        # Context is CSS tint only — must not pin a busy mood hold.
        self.assertIn("do not pin busy hold", self.js)


if __name__ == "__main__":
    unittest.main()
