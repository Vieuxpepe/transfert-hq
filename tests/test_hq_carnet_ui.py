"""Carnet Stage 02 — static wiring/security checks for the editor UI.

No browser, no network, no live data: only render_app() output and asset text.
Behaviour (drafts, save queue, conflicts, polling) is covered by
tests/check_hq_carnet.mjs (Node) and tests/visual_carnet_playwright.py (browsers).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import iphone_bridge

ROOT = Path(__file__).resolve().parents[1]


class CarnetShellTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = iphone_bridge.render_app().decode("utf-8")
        cls.app_js = iphone_bridge.APP_JS
        cls.css = iphone_bridge.BASE_CSS
        cls.js = (ROOT / "assets" / "hq-carnet.js").read_text(encoding="utf-8")
        cls.carnet_css = (ROOT / "assets" / "hq-carnet.css").read_text(encoding="utf-8")

    def test_nav_first_class_after_accueil(self):
        navs = re.findall(r'data-nav="([a-z]+)"', self.html.split('<nav class="bottom-nav"', 1)[1].split("</nav>", 1)[0])
        self.assertEqual(navs[:3], ["accueil", "carnet", "calendrier"])
        self.assertIn("carnet: 'Carnet'", self.app_js)
        self.assertIn('body[data-view="carnet"] [data-panel="carnet"]', self.css)

    def test_panel_host_matches_dom_contract(self):
        panel = self.html.split('<div data-panel="carnet">', 1)[1].split('<div data-panel="calendrier">', 1)[0]
        self.assertIn('<section class="hq hq-carnet" aria-labelledby="carnet-title">', panel)
        self.assertIn('<h2 id="carnet-title" class="visually-hidden">Carnet</h2>', panel)
        self.assertIn('<div id="hq-carnet-app">', panel)
        self.assertIn("Chargement…", panel)
        order = [self.html.index(f'<div data-panel="{p}"') for p in ("accueil", "carnet", "calendrier")]
        self.assertEqual(order, sorted(order))

    def test_assets_same_origin(self):
        self.assertIn('<link rel="stylesheet" href="/assets/hq-carnet.css"/>', self.html)
        self.assertIn('<script src="/assets/hq-carnet.js"></script>', self.html)
        self.assertTrue((ROOT / "assets" / "hq-carnet.js").is_file())
        self.assertTrue((ROOT / "assets" / "hq-carnet.css").is_file())
        for text in (self.js, self.carnet_css):
            self.assertNotRegex(text, r"https?://(?!www\.w3\.org/2000/svg)")
            self.assertNotIn("@import", text)
            self.assertNotIn("url(", text)

    def test_guarded_show_hook_and_missing_fallback(self):
        self.assertIn("if (view === 'carnet' && window.hqCarnetShow) {\n"
                      "    try { window.hqCarnetShow(); } catch (e) { console.error(e); }", self.app_js)
        self.assertIn("function hqCarnetMissing()", self.app_js)
        self.assertIn("carnet-retry", self.app_js)

    def test_api_error_status_and_data(self):
        body = self.app_js.split("async function api(url, opts={}) {", 1)[1].split("\nfunction ", 1)[0]
        self.assertIn("err.status = res.status", body)
        self.assertIn("err.data = data", body)
        self.assertIn("throw fail((data && data.error) || ('Erreur ' + res.status), data);", body)
        self.assertIn("location.replace('/logout')", body)  # 401 UX preserved
        self.assertIn("throw fail('PIN requis')", body)
        self.assertIn("let msg = 'Réservé admin'", body)  # 403 UX preserved

    def test_security_headers_and_allowlists_unchanged(self):
        self.assertNotIn("/api/carnet", iphone_bridge.UPLOAD_GET_EXACT)
        self.assertNotIn("/api/carnet", iphone_bridge.UPLOAD_POST_EXACT)
        self.assertEqual(iphone_bridge.UPLOAD_GET_PREFIX, ("/assets/",))
        self.assertEqual(iphone_bridge.UPLOAD_POST_PREFIX, ())
        src = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn("script-src 'self' 'unsafe-inline'; connect-src 'self'", src)
        self.assertIn('self.send_header("X-Content-Type-Options", "nosniff")', src)

    def test_js_never_uses_html_sinks_or_leaks(self):
        code = self.js
        for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
            self.assertNotIn(sink, code)
        self.assertNotIn("sendBeacon", code)  # would drop required same-origin/CSRF behaviour
        self.assertNotIn("console.log", code)
        # No note content in URLs: only fixed endpoints.
        self.assertEqual(sorted(set(re.findall(r'"(/api/[^"]*)"', code))), ["/api/carnet", "/api/carnet?meta=1", "/api/me"])

    def test_drafts_only_after_admin_identity(self):
        boot = self.js.split("async function boot()", 1)[1]
        me = boot.index('apiCall("/api/me"')
        role = boot.index('me.role !== "admin"')
        store = boot.index("createDraftStore(safeStorage(), me.user)")
        self.assertLess(me, role)
        self.assertLess(role, store)
        # localStorage is reached only through the draft store created there.
        before_boot = self.js.split("async function boot()", 1)[0]
        self.assertEqual(before_boot.count("localStorage"), 1)  # safeStorage() accessor only
        self.assertIn('const DRAFT_PREFIX = "hq_carnet_drafts_v1:"', self.js)
        self.assertIn("DRAFT_PREFIX + encodeURIComponent(String(", self.js)

    def test_frozen_messages(self):
        for text in (
            "Sauvegarde locale indisponible — ne ferme pas cette page.",
            "Hors ligne — conservé sur cet appareil",
            "Modifié ailleurs. Ta saisie est conservée sur cet appareil.",
            "Charger la version distante",
            "Remplacer avec ma version",
            "Copié",
            "Copie impossible",
        ):
            self.assertIn(text, self.js)
        self.assertIn("const POLL_MS = 5000;", self.js)
        self.assertIn("const DEBOUNCE_MS = 450;", self.js)
        self.assertIn('["Ø", "±", "°", "µ", "Δ", "×", "→", "≤", "≥", "²", "³"]', self.js)

    def test_stable_selectors_present(self):
        for sel in (
            "hq-carnet-editor", "hq-carnet-status", "btn-carnet-prev", "btn-carnet-next", "btn-carnet-new",
            "carnet-page-indicator", "btn-carnet-context", "btn-carnet-pin", "btn-carnet-library",
            "btn-carnet-more", "btn-carnet-copy", "carnet-quick-tools", "btn-carnet-time",
            "hq-carnet-conflict", "btn-carnet-conflict-remote", "btn-carnet-conflict-local",
        ):
            self.assertIn(f'"{sel}"', self.js, sel)
        for cls in ("carnet-fail", "carnet-retry", "carnet-page-ghost", "data-carnet-symbol"):
            self.assertIn(cls, self.js)

    def test_css_sizes_motion_and_scope(self):
        css = self.carnet_css
        sizes = [int(x) for x in re.findall(r"--carnet-fs:(\d+)px", css)]
        self.assertTrue(sizes and min(sizes) >= 16, sizes)
        taps = [int(x) for x in re.findall(r"--carnet-tap:(\d+)px", css)]
        self.assertTrue(taps and min(taps) >= 44, taps)
        self.assertIn("@media (prefers-reduced-motion:reduce)", css)
        self.assertIn("rotateY", css)
        self.assertNotIn("@font-face", css)
        # Wider layout is Carnet-scoped; other HQ views keep .wrap max-width:980px.
        for m in re.finditer(r"\.wrap\{[^}]*\}", css):
            prefix = css[max(0, m.start() - 40):m.start()]
            self.assertIn('body[data-view="carnet"]', prefix)


if __name__ == "__main__":
    unittest.main()
