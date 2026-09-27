"""Focused checks for palette, Système, calendar legend, and file sorting."""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

import iphone_bridge

ROOT = Path(__file__).resolve().parents[1]


class UxFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = iphone_bridge.render_app().decode("utf-8")
        cls.hq_js = (ROOT / "assets" / "hq.js").read_text(encoding="utf-8")
        cls.features = (ROOT / "assets" / "hq-features.js").read_text(encoding="utf-8")
        cls.cal_js = (ROOT / "assets" / "hq-calendar.js").read_text(encoding="utf-8")
        cls.cal_css = (ROOT / "assets" / "hq-calendar.css").read_text(encoding="utf-8")
        cls.app_js = iphone_bridge.APP_JS

    def test_palette_groups_recents_and_keyboard(self):
        html = self.html
        self.assertIn("Recherche HQ", html)
        self.assertIn("↑ ↓ naviguer · Entrée ouvrir · Échap fermer", html)
        self.assertIn('class="kbd-hint">Ctrl K</kbd>', html)
        self.assertIn("hq_palette_recents", self.hq_js)
        self.assertIn("function showPaletteHome", self.hq_js)
        self.assertIn('label: "Récents"', self.hq_js)
        self.assertIn('label: "Favoris"', self.hq_js)
        self.assertIn("hqGroupPaletteHits", self.hq_js)
        self.assertIn("Aucun résultat pour", self.hq_js)
        self.assertIn("function dispatchPalette", self.hq_js)
        self.assertIn("function runPalette", self.hq_js)
        run = self.hq_js.split("async function runPalette", 1)[1].split("function openPalette", 1)[0]
        self.assertIn("dispatchPalette(hit)", run)
        self.assertIn("rememberRecent(hit)", run)
        self.assertIn("forgetRecent(hit)", run)
        self.assertNotIn("hit.cmd", run)
        self.assertNotIn("/api/palette", run)
        dispatch = self.hq_js.split("async function dispatchPalette", 1)[1].split("async function runPalette", 1)[0]
        self.assertIn('"/api/scene"', dispatch)
        self.assertIn('"/api/pc/action"', dispatch)
        self.assertIn('"/api/terminal"', dispatch)
        self.assertIn("navigate(hit.id)", dispatch)
        self.assertIn("openDevice(hit.id)", dispatch)
        self.assertIn("ev.ctrlKey || ev.metaKey", self.hq_js)
        self.assertIn("typingTarget(ev.target)", self.hq_js)
        self.assertIn('dialog[open]', self.hq_js)
        self.assertIn("Dossiers", self.features)
        self.assertIn("Commandes", self.features)
        self.assertNotIn("localStorage", self.features)
        stored = self.features.split("function paletteRecentEntry", 1)[1].split("function sanitizeRecents", 1)[0]
        self.assertIn("kind: kind", stored)
        self.assertNotIn("cmd", stored)

    def test_system_jump_and_access_disclosure(self):
        plus = self.html.split('<div data-panel="plus"', 1)[1].split("</main>", 1)[0]
        nav, rest = plus.split("</nav>", 1)
        self.assertIn('aria-label="Sections Système"', nav)
        for target in (
            "system-session",
            "system-backups",
            "system-notifications",
            "system-alerts",
            "system-info",
            "system-automations",
            "system-tasks",
            "system-journal",
            "system-brief",
        ):
            self.assertIn(f'id="{target}"', plus)
            if target != "system-brief":
                self.assertIn(f'data-jump="{target}"', nav)
        self.assertIn("mode-complet-only", nav)
        self.assertIn('data-jump="system-journal"', nav.split("mode-complet-only", 1)[1])
        session, after = rest.split('id="system-brief"', 1)
        self.assertLess(session.index('id="hq-disk"'), session.index("<details"))
        self.assertIn("Partager l'accès", session)
        self.assertIn('aria-label="QR d\'accès"', session)
        source = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        share = source.split('class="access-share"', 1)[1].split("</details>", 1)[0]
        self.assertIn("{qr_lan}", share)
        self.assertIn("{qr_ts}", share)
        self.assertNotIn("<details", session.split('id="hq-status"', 1)[0])
        self.assertIn("scrollIntoView", self.hq_js)
        self.assertIn("prefers-reduced-motion: reduce", self.hq_js)
        self.assertNotIn("IntersectionObserver", self.hq_js)
        self.assertIn('id="hq-role"', session)

    def test_calendar_legend_is_static_ui(self):
        legend = self.cal_js.split("function legendPanel", 1)[1].split("function dayView", 1)[0]
        for label in ("Personnel", "Étude", "Rendez-vous", "Maintenance", "HQ", "Autre"):
            self.assertIn('"' + label + '"', self.cal_js)
        self.assertIn("Planning HQ · lecture seule", legend)
        self.assertIn("Activité observée", legend)
        self.assertIn('aria-expanded', self.cal_js)
        self.assertIn('aria-controls": "hq-cal-legend"', self.cal_js)
        self.assertIn('text: "Légende"', self.cal_js)
        toggle = self.cal_js.split('kind === "legend"', 1)[1].split('kind === "create"', 1)[0]
        self.assertIn("render()", toggle)
        self.assertNotIn("refresh(", toggle)
        self.assertNotIn("/api/", legend)
        self.assertIn(".hq-cal-legend-mark::before", self.cal_css)
        self.assertIn(".hq-cal-legend-mark.is-schedule", self.cal_css)
        self.assertIn(".hq-cal-legend-activity", self.cal_css)
        self.assertIn("hq-cal-legend[hidden]{display:none}", self.cal_css.replace(" ", ""))

    def test_files_sort_labels_and_empty_states(self):
        files = self.html.split('<div data-panel="fichiers"', 1)[1].split('<div data-panel="ops"', 1)[0]
        self.assertIn("Recherche globale", files)
        self.assertIn("Chercher un fichier ou du texte dans les notes", files)
        self.assertIn('placeholder="Ex. facture, capture, notes…"', files)
        self.assertIn('aria-label="Filtrer ce dossier"', files)
        self.assertIn('placeholder="Filtrer ce dossier…"', files)
        self.assertIn('id="file-sort"', files)
        self.assertIn(">Nom</option>", files)
        self.assertIn(">Récent</option>", files)
        self.assertIn(">Taille</option>", files)
        self.assertNotIn(">Recherche</h2>", files)
        self.assertIn("hq_files_sort", self.app_js)
        self.assertIn("Aucun résultat dans ce dossier", self.app_js)
        self.assertIn("Aucun fichier ici", self.app_js)
        self.assertIn("hqSortFolderItems", self.app_js)
        refresh = self.app_js.split("async function refreshFiles", 1)[1].split("async function deleteItem", 1)[0]
        self.assertNotIn("qs.set('q'", refresh)
        self.assertIn('value="name"', files)
        self.assertIn("Opérations", self.html)
        self.assertNotIn(">Activité</button>", self.html.split('id="recents-filters"', 1)[1].split("</div>", 1)[0])

    def test_feature_helpers_with_node(self):
        script = ROOT / "tests" / "check_hq_features.mjs"
        for path in (ROOT / "assets" / "hq.js", ROOT / "assets" / "hq-features.js", ROOT / "assets" / "hq-calendar.js", script):
            subprocess.run(["node", "--check", str(path)], check=True)
        subprocess.run(["node", str(script)], check=True, cwd=ROOT)


if __name__ == "__main__":
    unittest.main()
