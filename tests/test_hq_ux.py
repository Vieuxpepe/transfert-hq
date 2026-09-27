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
        self.assertIn("(hover:hover) and (pointer:fine)", self.css)
        self.assertIn("prefers-reduced-motion:reduce", self.css)
        self.assertIn(":focus-visible", self.css)

    def test_help_targets_and_nav(self):
        html = self.html
        accueil = html.split('<div data-panel="accueil"', 1)[1].split('<div data-panel="calendrier"', 1)[0]
        plus = html.split('<div data-panel="plus"', 1)[1].split("</main>", 1)[0]
        self.assertIn("Activité récente", accueil)
        self.assertNotIn('id="hq-events"', accueil)
        self.assertIn('id="hq-journal"', plus)
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
        self.assertNotIn('text: "Prochain"', self.cal_js)
        self.assertIn("function nextSummary", self.cal_js)
        self.assertIn("hq-cal-next", self.cal_js)
        self.assertIn('class="accueil-summaries"', accueil)
        self.assertLess(accueil.index("accueil-summaries"), accueil.index('id="hq-banner"'))
        self.assertLess(accueil.index('id="hq-cal-home"'), accueil.index("accueil-main"))
        hq_css = (ROOT / "assets" / "hq.css").read_text(encoding="utf-8")
        self.assertIn("minmax(0,1fr) minmax(0,1fr)", hq_css)
        self.assertIn("align-items:start", hq_css)
        self.assertIn("@media (min-width:900px)", hq_css)
        self.assertNotIn("grid-column:1 / -1", self.cal_css)
        self.assertNotIn("#hq-banner{grid-column", hq_css.replace(" ", ""))
