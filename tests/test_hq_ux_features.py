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
        # The plus panel now carries two navs: the space links first, then the Système jump list.
        nav, rest = plus.split('<nav class="sys-jump"', 1)[1].split("</nav>", 1)
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
        journal = nav.split('data-jump="system-journal"', 1)[0].rsplit("<button", 1)[1]
        self.assertNotIn("mode-complet-only", journal)
        self.assertIn('id="system-journal"', plus)
        for advanced in ("system-automations", "system-tasks"):
            button = nav.split(f'data-jump="{advanced}"', 1)[0].rsplit("<button", 1)[1]
            self.assertIn("mode-complet-only", button)
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
        self.assertIn("renderKeep()", toggle, "the legend toggle re-renders locally, it never refetches")
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

    def test_terminal_tab_controls_and_timeouts(self):
        panel = self.html.split('<div data-panel="ops"', 1)[1].split('<div data-panel="forge"', 1)[0]
        self.assertIn('id="btn-shell-refresh"', panel)
        self.assertIn('<option value="raw">Commande brute (SSH)</option>', panel)
        self.assertIn('id="shell-target-note"', panel)
        self.assertIn('autocapitalize="none"', panel)
        self.assertIn('spellcheck="false"', panel)
        self.assertIn('enterkeyhint="send"', panel)
        for control in ("btn-term-copy", "btn-term-clear", "btn-term-save", "btn-term-expand"):
            self.assertIn(f'id="{control}"', panel)
        self.assertIn('role="log"', panel)
        self.assertIn('tabindex="0"', panel)
        self.assertIn('id="term-recent"', panel)
        # A command is a job: POST returns an id, the view polls, Arrêter kills the tree.
        self.assertIn('id="btn-term-stop"', panel)
        self.assertIn("const HQ_SHELL_POLL_MS = 700;", self.app_js)
        for helper in (
            "function hqTermStart",
            "function hqTermPoll",
            "function hqTermFinish",
            "function hqTermStopNow",
            "window.hqTermAttachJob",
            "function hqTermHistoryAdd",
            "function hqShellSyncTarget",
            "function renderTerminalRecent",
        ):
            self.assertIn(helper, self.app_js)
        self.assertIn("/api/shell/job?id=", self.app_js)
        self.assertIn("/api/shell/job/stop", self.app_js)
        self.assertIn("data.job_id", self.app_js)
        self.assertIn("sortie tronquée", self.app_js)
        # A job dies with the bridge: the view says « tâche perdue » instead of retrying a dead id.
        self.assertIn("function hqTermLost", self.app_js)
        self.assertIn("const HQ_SHELL_LOST_MS = 6000;", self.app_js)
        self.assertIn("tâche perdue", self.app_js)
        self.assertIn("a peut-être continué sans suivi", self.app_js)
        # This session's jobs are listed, and a click reopens the transcript.
        self.assertIn('id="term-jobs"', panel)
        # Console header: state word + coloured dot, and the jobs card wrapper.
        self.assertIn('id="term-status"', panel)
        self.assertIn('id="term-dot"', panel)
        self.assertIn('id="term-jobs-wrap"', panel)
        self.assertIn("function hqTermStatus", self.app_js)
        # The header counts while a job runs, then freezes on the final duration.
        self.assertIn('id="term-elapsed"', panel)
        self.assertIn("function hqTermElapsedStart", self.app_js)
        self.assertIn("function hqTermElapsedStop", self.app_js)
        self.assertIn("setInterval(paint, 1000)", self.app_js)
        # A running row in the list counts too, without rebuilding the list.
        self.assertIn("function hqTermListTick", self.app_js)
        self.assertIn("function hqTermListStart", self.app_js)
        self.assertIn("'term-job-elapsed'", self.app_js)
        self.assertIn("setInterval(hqTermListTick, 1000)", self.app_js)
        # The live row wears the console's pulsing dot.
        self.assertIn("'term-dot running'", self.app_js)
        self.assertIn(".term-job .term-dot{", self.html)
        # Job actions, find, follow, send, pins, stats and queue.
        for control in (
            "btn-term-next-target", "btn-term-pin", "btn-term-find", "btn-term-follow", "btn-term-send",
            "btn-term-stop-all", "btn-term-jobs-clear", "term-find-input", "term-stats", "term-pinned",
        ):
            self.assertIn(f'id="{control}"', panel)
        for helper in (
            "hqTermStopById", "hqTermStopAll", "hqTermRerun", "hqTermNextTarget", "hqTermPinsRender",
            "hqTermComplete", "hqTermSetFollow", "hqTermFindRun", "hqTermOpenToken", "hqTermSendToInbox",
            "hqTermClearSaved", "hqTermStatsLoad", "hqTermLongNotify",
        ):
            self.assertIn(f"function {helper}", self.app_js)
        self.assertIn("stdin fermé", panel)
        # Long-job finish: toast with the duration, plus a system notification when the tab is hidden.
        self.assertIn("const HQ_TERM_NOTIFY_MS = 30000;", self.app_js)
        self.assertIn("Notification.requestPermission", self.app_js)
        self.assertIn("if (ms < HQ_TERM_NOTIFY_MS || !document.hidden) return;", self.app_js)
        self.assertIn("note.onclick", self.app_js)
        # ⟳ on a row: same command, same target/shell.
        self.assertIn("term-job-rerun", self.app_js)
        self.assertIn("Relancer la même commande sur le même PC.", self.app_js)
        self.assertIn(".term-job-actions", self.html)
        # Global stop: one action for every live job, with the count when several run.
        self.assertIn("body: JSON.stringify({ all: true })", self.app_js)
        self.assertIn("'Tout arrêter ('", self.app_js)
        self.assertIn("hqTermStopById(job.job_id)", self.app_js)
        # Live screen card: this PC only, one frame every 2 s, nothing while hidden or paused.
        for control in ("btn-screen-live", "btn-screen-pause", "screen-live", "screen-frame", "screen-frame-age"):
            self.assertIn(f'id="{control}"', panel)
        for helper in ("hqScreenSetOpen", "hqScreenLoad", "hqScreenPause", "hqScreenVisible"):
            self.assertIn(f"function {helper}", self.app_js)
        self.assertIn("const HQ_SCREEN_FRAME_MS = 2000;", self.app_js)
        self.assertIn("/api/screen/frame?w=1280", self.app_js)
        self.assertIn("if (document.hidden || !hqScreenVisible()) return;", self.app_js)
        # Same card, any SSH target from the terminal's list.
        self.assertIn('id="screen-target"', panel)
        self.assertIn('id="screen-note"', panel)
        for helper in ("hqScreenTargetsLoad", "hqScreenSync"):
            self.assertIn(f"function {helper}", self.app_js)
        self.assertIn("'/api/screen/frame?w=1280&target='", self.app_js)
        self.assertIn("/api/terminal/export", self.app_js)
        self.assertIn("/api/shell/stats", self.app_js)
        self.assertIn("/api/shell/jobs/clear", self.app_js)
        self.assertIn("all: true", self.app_js)
        # Enter / Ctrl+Enter / ⌘+Enter launch through one guarded path.
        self.assertIn("function hqTermRunFromInput", self.app_js)
        # Wide screens: console left, jobs card right, and the right column only when used.
        self.assertIn('class="hq hq-primary term-view"', panel)
        self.assertIn('class="hq term-recent-block"', panel)
        self.assertIn(".term-view.has-jobs{", self.html)
        self.assertIn("classList.toggle('has-jobs'", self.app_js)
        self.assertIn("Ctrl+Entrée lance", panel)
        self.assertIn("Une commande tourne déjà", self.app_js)
        self.assertIn("function hqTermRecentRefresh", self.app_js)
        self.assertIn("function hqTermOpen", self.app_js)
        self.assertIn("/api/shell/jobs", self.app_js)
        self.assertIn("hqTermOpen(job.job_id", self.app_js)
        # The list can be narrowed by state or by name.
        self.assertIn('id="term-jobs-filter"', panel)
        self.assertIn('id="term-jobs-state"', panel)
        for helper in ("function hqTermRecentRender", "function hqTermJobsMatch", "function hqTermFold", "hqTermJobsCache"):
            self.assertIn(helper, self.app_js)
        self.assertIn("Aucune tâche pour ce filtre.", self.app_js)
        # The filter survives a refresh (sessionStorage, like target/shell).
        self.assertIn("hqShellRead('jobs_filter'", self.app_js)
        self.assertIn("hqShellStore('jobs_filter'", self.app_js)
        self.assertIn("hqShellRead('jobs_state'", self.app_js)
        self.assertIn("hqShellStore('jobs_state'", self.app_js)
        # The list is grouped by day, each day carrying its own state counts.
        for helper in ("function hqTermDayKey", "function hqTermDayLabel", "function hqTermDayCounts"):
            self.assertIn(helper, self.app_js)
        self.assertIn("function hqTermOrderRows", self.app_js)
        self.assertIn("Aujourd'hui", self.app_js)
        self.assertIn("Hier", self.app_js)
        self.assertIn("hq_shell_history", self.app_js)
        self.assertIn("hq_shell_", self.app_js)
        copy_block = self.app_js.split("$('#btn-term-copy')", 1)[1].split("$('#btn-term-clear')", 1)[0]
        self.assertIn("navigator.clipboard.writeText", copy_block)
        expand_block = self.app_js.split("$('#btn-term-expand')", 1)[1].split("hqTermHistoryRender();", 1)[0]
        self.assertIn("aria-pressed", expand_block)
        self.assertIn("renderTerminalRecent();", self.app_js.split("function renderActivity", 1)[1].split("function renderRecents", 1)[0])

    def test_feature_helpers_with_node(self):
        script = ROOT / "tests" / "check_hq_features.mjs"
        for path in (ROOT / "assets" / "hq.js", ROOT / "assets" / "hq-features.js", ROOT / "assets" / "hq-calendar.js", script):
            subprocess.run(["node", "--check", str(path)], check=True)
        subprocess.run(["node", str(script)], check=True, cwd=ROOT)


if __name__ == "__main__":
    unittest.main()
