"""Static checks for Musique view wiring (no browser required)."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class MusicUiWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        cls.js = (ROOT / "assets/hq-music.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "assets/hq-music.css").read_text(encoding="utf-8")

    def test_view_and_nav_registered(self):
        self.assertIn("musique: 'Musique'", self.bridge)
        self.assertIn('data-nav="musique"', self.bridge)
        self.assertIn('data-panel="musique"', self.bridge)
        self.assertIn('id="hq-music-app"', self.bridge)
        self.assertIn("body[data-view=\"musique\"] [data-panel=\"musique\"]", self.bridge)

    def test_lecteur_untouched_label(self):
        self.assertIn("lecteur: 'Lecteur'", self.bridge)
        self.assertIn('data-nav="lecteur"', self.bridge)
        self.assertIn("hq-lecteur.js", self.bridge)

    def test_lazy_load_and_cleanup_hooks(self):
        self.assertIn("function hqMusicLoad()", self.bridge)
        self.assertIn("hqMusicEnsureMounted", self.bridge)
        self.assertIn("hqMusicHide", self.bridge)
        self.assertIn("unmount:", self.js)
        self.assertIn("stopPoll", self.js)

    def test_four_sections_present(self):
        for label in ("Lecture", "Playlists", "Mixer", "Découvertes"):
            self.assertIn(label, self.js)

    def test_reduced_motion_support(self):
        self.assertIn("prefers-reduced-motion", self.css)

    def test_api_routes_wired(self):
        self.assertIn('raw.startswith("/api/music/")', self.bridge)
        self.assertIn('raw.startswith("/api/spotify/")', self.bridge)
        self.assertIn("hq_music.bind", self.bridge)
        self.assertIn("hq_spotify.bind", self.bridge)

    def test_admin_gated(self):
        self.assertIn("nav-musique", self.bridge)
        self.assertIn("view === 'musique'", self.bridge)


if __name__ == "__main__":
    unittest.main()
