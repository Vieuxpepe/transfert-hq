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

    def test_musica_cards_and_composer(self):
        for snippet in ("(m.cards || []).forEach", "renderMusicCard(item)", "▶ Lire l’album",
                        "+ File", "+ Playlist…", "★ Sauver découverte", "Discographie", "Mixer+",
                        "Réessayer", "Musica réfléchit…", "log.scrollTop = log.scrollHeight",
                        '!ev.shiftKey', 'log.setAttribute("aria-live", "polite")'):
            self.assertIn(snippet, self.js)
        self.assertIn(".hqm-result-card", self.css)

    def test_catalog_filters_and_pagination(self):
        for label in ("Titres", "Albums", "Artistes", "Playlists"):
            self.assertIn(label, self.js)
        self.assertIn('types.setAttribute("data-hqm", "catalog-type")', self.js)
        self.assertIn("state.searchResults.next_offset", self.js)


class MusicUiRecapAndSteeringTests(unittest.TestCase):
    """Static wiring for the recap cards, taste map, steering bar, playback recovery, daily challenge and a11y hooks."""

    @classmethod
    def setUpClass(cls):
        cls.js = (ROOT / "assets/hq-music.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "assets/hq-music.css").read_text(encoding="utf-8")

    def test_recap_cards_call_their_routes(self):
        for route in ("/api/music/wrapped/", "/api/music/on-this-day", "/api/music/taste-map"):
            self.assertIn(route, self.js)
        for fn in ("renderWrapped", "renderOnThisDay", "renderTasteMap", "wrappedCard", "tasteMapSvg"):
            self.assertIn("function " + fn, self.js)
        self.assertIn("renderTasteMap(panel)", self.js)

    def test_instant_vote_streams_her_reaction(self):
        self.assertIn("function streamReaction", self.js)
        self.assertIn("/api/musica/dj/duel/reaction/", self.js)
        vote = self.js[self.js.index("async function djVote"):self.js.index("function streamReaction")]
        self.assertIn("data.reaction.pending", vote)  # only the final line is spoken when it is streamed

    def test_blind_match_masks_the_queue_card(self):
        fill = self.js[self.js.index("function fillQueue"):]
        self.assertIn("blindMasking()", fill[:300])
        self.assertIn("refreshQueueCard()", self.js[self.js.index("async function djVote"):self.js.index("function streamReaction")])

    def test_match_keyboard_shortcuts_ignore_typing(self):
        keys = self.js[self.js.index("function bindMatchKeys"):self.js.index("function seedLabel")]
        for token in ("INPUT|TEXTAREA|SELECT", "isContentEditable", "ctrlKey", ".hqm-tn-pick"):
            self.assertIn(token, keys)
        self.assertIn("bindMatchKeys();", self.js[self.js.index("HqMusic = {"):])

    def test_taste_map_zooms_and_opens_artists(self):
        self.assertIn("function mapZoom", self.js)
        self.assertIn("openArtist({ name: n.name })", self.js)
        self.assertIn("hqm-map-node", self.css)

    def test_daily_reminder_dot_and_covers(self):
        self.assertIn("function dailyPending", self.js)
        self.assertIn("hqm-tab-dot", self.css)
        self.assertIn("hqm-tn-row-cover", self.css)

    def test_older_safari_and_touch_fallbacks(self):
        self.assertIn("(pointer: coarse)", self.css)
        start = self.css.index("/* Older Safari")
        self.assertLess(start, self.css.index("/* ---- Le Tournoi ----"))  # fallbacks come first, so color-mix wins where supported

    def test_station_card_programme_previously_and_memory(self):
        for fn in ("renderStationCard", "renderStationGrid", "renderStationMemory", "loadStation", "takeTabHint"):
            self.assertIn("function " + fn, self.js)
        for route in ("/api/musica/dj/station", "/api/musica/dj/station/grid", "/api/musica/dj/station/launch",
                      "/api/musica/dj/station/seen", "/api/musica/dj/station/memory"):
            self.assertIn(route, self.js)
        self.assertIn("host.appendChild(renderStationCard());", self.js)
        self.assertIn("hq_music_tab", self.js)  # Accueil and the moments bubble open a given tab
        self.assertIn("hqm-station-day", self.css)

    def test_home_card_and_moments_are_wired(self):
        home_js = (ROOT / "assets/hq-home.js").read_text(encoding="utf-8")
        cards = (ROOT / "assets/hq-home-cards.js").read_text(encoding="utf-8")
        bridge = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn('["musica", "#home-musica", "Musica"]', home_js)
        self.assertIn('["home-musica", paintMusica]', cards)
        self.assertIn('id="home-musica"', bridge)
        self.assertIn("/assets/hq-musica-moments.js", bridge)
        import hq_home
        self.assertIn("musica", hq_home.KEYS)

    def test_moments_have_a_cooldown_a_daily_cap_and_off_switches(self):
        moments = (ROOT / "assets/hq-musica-moments.js").read_text(encoding="utf-8")
        for token in ("MIN_GAP_MS", 'view() === "musique"', "document.hidden", "memory.off", "[kind] === key", "moments: !!on",
                      "stopped = true", "Plus de nudges"):
            self.assertIn(token, moments)
        self.assertIn(".hq-musica-moment", (ROOT / "assets/hq-musica-chip.css").read_text(encoding="utf-8"))

    def test_talk_back_and_live_reactions_are_wired(self):
        for fn in ("djAsk", "pollAskVoice"):
            self.assertIn("function " + fn, self.js)
        self.assertIn("/api/musica/dj/ask", self.js)
        voice = self.js[self.js.index("async function voiceIntent"):self.js.index("sendMusica(text)", self.js.index("async function voiceIntent"))]
        self.assertIn("djAsk(", voice)  # « DJ, … » goes through the question/request split
        request = self.js[self.js.index("async function djRequest"):self.js.index("async function djAsk")]
        self.assertIn("djAsk(text)", request)
        track_change = self.js[self.js.index("function onTrackChange"):self.js.index("async function djAnnounce")]
        self.assertIn("answer.reaction", track_change)
        self.assertIn("data.ack", self.js[self.js.index("async function djAsk"):self.js.index("function pollAskVoice")])

    def test_steering_is_global_not_only_in_the_dj_card(self):
        for fn in ("renderRequestBar", "renderOnAirStrip", "renderMoodDial", "renderPlaybackBanner", "recoverDevice"):
            self.assertIn("function " + fn, self.js)
        self.assertIn("/api/musica/dj/mood", self.js)
        self.assertIn("/api/spotify/devices/wake", self.js)
        # the three global bars are added by render(), so they show on every tab
        render = self.js[self.js.index("  function render() {"):]
        for call in ("renderPlaybackBanner()", "renderOnAirStrip()", "renderRequestBar()"):
            self.assertIn(call, render[:2600])

    def test_last_known_playback_is_cached_for_offline(self):
        self.assertIn("hqm_last_playback", self.js)
        self.assertIn("useLastKnownWhenOffline", self.js)

    def test_daily_challenge_and_kinds(self):
        self.assertIn("/api/musica/dj/daily", self.js)
        self.assertIn("renderDailyCard", self.js)
        self.assertIn("body.kind = tn.kind", self.js)
        for kind in ("games", "decade", "artists", "albums", "library"):
            self.assertIn(kind + ":", self.js.split("var KIND_LABELS")[1][:400])

    def test_accessibility_hooks(self):
        for needle in ('aria-live", "polite"', "function announce(", 'setAttribute("aria-current", "step")',
                       'setAttribute("aria-pressed"', "Tableau du tournoi", 'role", "group"'):
            self.assertIn(needle, self.js)
        for selector in (".hqm-sr-only", ".hqm-mood-step:focus-visible", "prefers-reduced-motion"):
            self.assertIn(selector, self.css)

    def test_styles_exist_for_every_new_component(self):
        for cls in (".hqm-request", ".hqm-onair", ".hqm-mood-dial", ".hqm-dev-banner", ".hqm-seg", ".hqm-wrapped", ".hqm-today",
                    ".hqm-map", ".hqm-daily", ".hqm-tn-arena", ".hqm-tn-tree"):
            self.assertIn(cls, self.css)
        self.assertEqual(self.css.count("{"), self.css.count("}"))


if __name__ == "__main__":
    unittest.main()
