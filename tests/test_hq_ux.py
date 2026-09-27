"""Markup checks for the HQ readability pass. No browser, no network."""

from __future__ import annotations

import unittest
from pathlib import Path

import iphone_bridge

ROOT = Path(__file__).resolve().parents[1]


class UxMarkupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = iphone_bridge.render_app().decode("utf-8")
        cls.css = iphone_bridge.BASE_CSS
        cls.hq_js = (ROOT / "assets" / "hq.js").read_text(encoding="utf-8")
        cls.cal_js = (ROOT / "assets" / "hq-calendar.js").read_text(encoding="utf-8")
        cls.cal_css = (ROOT / "assets" / "hq-calendar.css").read_text(encoding="utf-8")

    def test_type_and_light_accent(self):
        self.assertIn("--text-xs:.75rem", self.css)
        self.assertIn("--text-sm:.82rem", self.css)
        self.assertIn("--tap-min:44px", self.css)
        self.assertIn("--focus-ring:2px solid var(--accent)", self.css)
        self.assertIn("--accent:#08724f", self.css)
        light = self.css.split("prefers-color-scheme: light", 1)[1].split("}", 1)[0]
        root = self.css.split("@media (prefers-color-scheme: light)", 1)[0]
        self.assertIn("--warn:#8b5e00", light)
        self.assertNotIn("--warn:#b87a12", light)
        self.assertIn("--warn:#e8a838", root)
        relay = self.css.split(".path-badge.path-relay{", 1)[1].split("}", 1)[0]
        self.assertIn("var(--warn)", relay)
        self.assertNotIn("#e8a838", relay)
        self.assertIn('item.level === "critical"', self.hq_js)
        self.assertIn('critical + " critiques"', self.hq_js)
        self.assertIn('"1 critique"', self.hq_js)
        self.assertIn('others + " autres"', self.hq_js)
        self.assertIn('"1 autre"', self.hq_js)
        self.assertNotIn('n + " critiques"', self.hq_js)
        self.assertIn("(hover:hover) and (pointer:fine)", self.css)
        self.assertIn("prefers-reduced-motion:reduce", self.css)
        self.assertIn(":focus-visible", self.css)

    def test_help_targets_and_nav(self):
        html = self.html
        accueil = html.split('<div data-panel="accueil"', 1)[1].split('<div data-panel="calendrier"', 1)[0]
        plus = html.split('<div data-panel="plus"', 1)[1].split("</main>", 1)[0]
        self.assertIn("Activité récente", accueil)
        self.assertNotIn('id="hq-events"', accueil)
        self.assertIn('id="system-journal"', plus)
        self.assertIn("Journal technique", plus)
        self.assertIn('data-nav="plus"', html)
        self.assertIn("Système", html)
        self.assertIn("nav-svg", html)
        self.assertNotIn('title="Statut"', html)
        self.assertNotIn('title="Masquer', html)
        self.assertIn('data-help="Verrouille la session Windows de ce PC."', html)
        self.assertIn('id="hq-device-dialog" aria-labelledby="hq-device-title"', html)
        self.assertIn('aria-modal="true"', html)
        import re
        helps = " ".join(re.findall(r'data-help="([^"]*)"', html)).lower()
        for secret in ("webhook", "password", "api_key", "token"):
            self.assertNotIn(secret, helps)

    def test_help_controller_is_text_only(self):
        start = self.hq_js.index("function finePointer")
        end = self.hq_js.index("function boot(")
        block = self.hq_js[start:end]
        for name in ("ensureTooltip", "scheduleHelp", "showHelp", "hideHelp", "positionHelp", "cancelHelp"):
            self.assertIn("function " + name, block)
        self.assertNotIn("innerHTML", block)
        self.assertIn("textContent", block)
        self.assertIn("(hover: hover) and (pointer: fine)", block)
        self.assertIn("2000", block)
        self.assertIn("250", block)

    def test_calendar_a11y_preserves_month_clip(self):
        self.assertIn("Mois précédent", self.cal_js)
        self.assertIn("Agenda suivant", self.cal_js)
        self.assertIn('class: "danger"', self.cal_js)
        self.assertIn("max-width: 700px", self.cal_js)
        self.assertNotIn("button.title", self.cal_js)
        self.assertIn("text-overflow:ellipsis", self.cal_css)
        self.assertIn("white-space:nowrap", self.cal_css)
        self.assertIn("hq-cal-week{min-width:760px}", self.cal_css.replace(" ", ""))
        self.assertIn("min-height:32px", self.cal_css)
        self.assertIn("@media (pointer:coarse)", self.cal_css)
        coarse = self.cal_css.split("@media (pointer:coarse){", 1)[1].split(".hq-cal-event{", 1)[0]
        self.assertIn(".hq-cal-mcell .hq-cal-chip", coarse)
        self.assertIn(".hq-cal-more", coarse)
        self.assertIn("min-height:32px", coarse)
        grouped = self.cal_css.split(".hq-cal-mcell .hq-cal-chip,.hq-cal-mcell .hq-cal-more{", 1)[1].split("}", 1)[0]
        self.assertIn("min-height:32px", grouped)
        self.assertNotIn("min-height:0", grouped)
        self.assertIn("hq-cal-face", self.cal_css)
        self.assertIn("function assignHitSlop", self.cal_js)
        self.assertIn("pointer: coarse", self.cal_js)
        self.assertNotIn("min-height:28px", self.cal_css)

    def test_home_summaries_collapse(self):
        html = self.html
        accueil = html.split('<div data-panel="accueil"', 1)[1].split('<div data-panel="calendrier"', 1)[0]
        banner, today = accueil.split('id="hq-cal-home"', 1)
        attention_head, attention_panel = banner.split('id="hq-attention-panel"', 1)
        today_head, today_panel = today.split('id="hq-today-panel"', 1)
        self.assertIn('id="hq-attention-toggle"', attention_head)
        self.assertIn('aria-expanded="false"', attention_head)
        self.assertIn('aria-controls="hq-attention-panel"', attention_head)
        self.assertIn('id="btn-palette"', attention_head)
        self.assertNotIn('id="btn-palette"', attention_panel)
        self.assertIn('class="secondary" id="btn-sync-captures"', accueil)
        self.assertNotIn("<button", attention_head.split("<button", 1)[1].split("</button>", 1)[0])
        self.assertIn('id="hq-today-toggle"', today_head)
        self.assertIn('aria-controls="hq-today-panel"', today_head)
        self.assertIn('id="hq-cal-next"', today_head)
        self.assertNotIn('id="hq-cal-next"', today_panel)
        self.assertIn('id="hq-cal-open"', today_panel)
        self.assertIn("hq_home_attention_open", self.hq_js)
        self.assertIn("hq_home_today_open", self.hq_js)
        self.assertIn("function setDisclosure", self.hq_js)
        self.assertIn("function setupHomeDisclosures", self.hq_js)
        self.assertIn("function noteHqState", self.hq_js)
        self.assertIn('state === "critical" && hqStateSeen !== "critical"', self.hq_js)
        paint_home = self.cal_js.split("function paintHome", 1)[1].split("function fmtNextDay", 1)[0]
        self.assertNotIn("Prochain", paint_home)
        self.assertIn("function nextParts", self.cal_js)
        self.assertIn("function paintNext", self.cal_js)
        self.assertIn("hq-next-when", self.cal_js)
        self.assertIn("hq-next-title", self.cal_js)
        self.assertIn('text: "Prochain"', self.cal_js)
        parts = self.cal_js.split("function nextParts", 1)[1].split("function paintNext", 1)[0]
        self.assertNotIn("notes", parts)
        self.assertIn("weekday: \"short\"", self.cal_js)
        self.assertIn("hq-cal-next", self.cal_js)
        self.assertIn('class="accueil-summaries"', accueil)
        self.assertLess(accueil.index("accueil-summaries"), accueil.index('id="hq-banner"'))
        self.assertLess(accueil.index('id="hq-cal-home"'), accueil.index("accueil-main"))
        hq_css = (ROOT / "assets" / "hq.css").read_text(encoding="utf-8")
        self.assertIn("minmax(0,1fr) minmax(0,1fr)", hq_css)
        self.assertIn("align-items:start", hq_css)
        self.assertIn("@media (min-width:1160px)", hq_css)
        self.assertNotIn("@media (min-width:1100px)", hq_css)
        self.assertIn(".accueil-summaries{grid-column:1/-1}", hq_css.replace(" ", ""))
        before_pair = hq_css.split("@media (min-width:1160px)", 1)[0]
        self.assertNotIn("minmax(0,1fr) minmax(0,1fr)", before_pair)
        narrow = hq_css.split("@media (max-width:430px)", 1)[1].replace("\n", "")
        self.assertIn("#hq-attention-toggle .hq-disclosure-meta{order:4;flex:1 0 100%;margin-left:20px}", narrow)
        self.assertIn(".hq-next-when{color:var(--text)}", hq_css.replace(" ", ""))
        self.assertIn(".hq-next-title{", hq_css.replace(" ", ""))
        self.assertIn("text-overflow:ellipsis", hq_css)
        self.assertNotIn("grid-column:1 / -1", self.cal_css)
        self.assertNotIn("#hq-banner{grid-column", hq_css.replace(" ", ""))
