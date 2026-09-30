"""Carnet Stage 03 — library / organization / retrieval.

Server contracts the library relies on (throwaway ROOTs only) and static wiring/privacy
checks of the single responsive editor. Behaviour (reconciliation, search, recents, trash)
is covered by tests/check_hq_carnet_library.mjs; browsers by tests/visual_carnet_playwright.py.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_carnet  # noqa: E402
import iphone_bridge  # noqa: E402
from test_hq_carnet import CarnetBase, _fixture  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


class LibraryServerContractTests(CarnetBase):
    def setUp(self):
        super().setUp()
        self.seed(_fixture())

    def test_create_in_context_and_global_unfiled(self):
        out = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 4})
        self.assertEqual((out["page"]["project_id"], out["page"]["category_id"]), (None, None))
        out = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 5, "project_id": "proj-fixture"})
        self.assertEqual(out["page"]["project_id"], "proj-fixture")
        out = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": 6, "category_id": "cat-measures"})
        self.assertEqual(out["page"]["category_id"], "cat-measures")

    def test_assign_and_clear_through_page_save(self):
        out = self.save("page-idea", 1, "Try a split clamp instead", project_id="proj-fixture", category_id="cat-measures")
        self.assertEqual((out["page"]["project_id"], out["page"]["category_id"], out["page"]["rev"]), ("proj-fixture", "cat-measures", 2))
        out = self.save("page-idea", 2, "Try a split clamp instead", project_id=None, category_id=None)
        self.assertEqual((out["page"]["project_id"], out["page"]["category_id"], out["page"]["rev"]), (None, None, 3))

    def test_pin_is_page_metadata(self):
        out = hq_carnet.mutate({"action": "page_save", "id": "page-idea", "expected_rev": 1, "pinned": True,
                                "content": {"version": 1, "blocks": [{"id": "block-idea", "type": "text", "text": "Try a split clamp instead", "marks": []}]}})
        self.assertTrue(out["page"]["pinned"])
        self.assertEqual(out["page"]["rev"], 2)
        self.assertEqual(out["notebook_rev"], 4, "pin never bumps the structural notebook rev")

    def test_meta_carries_what_home_and_library_need(self):
        meta = hq_carnet.get_notebook(meta=True)
        shaft = next(p for p in meta["pages"] if p["id"] == "page-shaft")
        for key in ("title", "preview", "pinned", "deleted_at", "updated_at", "project_id", "category_id", "rev"):
            self.assertIn(key, shaft)
        self.assertEqual(shaft["title"], "Shaft inspection")
        self.assertNotIn("content", shaft)

    def test_trash_undo_restore_rev_flow(self):
        out = hq_carnet.mutate({"action": "page_trash", "id": "page-idea", "expected_rev": 1, "expected_notebook_rev": 4})
        self.assertIsNotNone(out["page"]["deleted_at"])
        with self.assertRaises(hq_carnet.CarnetError):
            self.save("page-idea", 2, "edit while trashed")
        out = hq_carnet.mutate({"action": "page_restore", "id": "page-idea", "expected_rev": 2, "expected_notebook_rev": 5})
        self.assertIsNone(out["page"]["deleted_at"])
        with self.assertRaises(hq_carnet.CarnetError):
            hq_carnet.mutate({"action": "page_delete_permanent", "id": "page-idea", "expected_rev": 3, "expected_notebook_rev": 6})


class LibraryStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = iphone_bridge.render_app().decode("utf-8")
        cls.app_js = iphone_bridge.APP_JS
        cls.js = (ROOT / "assets" / "hq-carnet.js").read_text(encoding="utf-8")
        cls.css = (ROOT / "assets" / "hq-carnet.css").read_text(encoding="utf-8")

    def test_frozen_stage03_selectors(self):
        for sel in ("hq-carnet-library", "hq-carnet-search", "carnet-library-list", "btn-carnet-focus", "btn-carnet-focus-exit",
                    "hq-carnet-context", "btn-home-carnet-open", "btn-home-carnet-new", "hq-carnet-home"):
            self.assertIn(f'"{sel}"', self.js, sel)
        for attr in ("data-carnet-page-id", "data-carnet-filter", "data-carnet-project", "data-carnet-category",
                     "data-carnet-trash", "data-carnet-restore", "data-carnet-delete-permanent"):
            self.assertIn(attr, self.js, attr)
        for label in ("Toutes", "Épinglées", "Récentes", "À classer", "Corbeille", "Aujourd'hui", "Hier", "Cette semaine"):
            self.assertIn(label, self.js)

    def test_home_host_is_empty_hidden_and_near_top(self):
        self.assertIn('<section class="hq carnet-home" id="hq-carnet-home" aria-label="Carnet" hidden></section>', self.html)
        accueil = self.html.split('<div data-panel="accueil"', 1)[1]
        self.assertLess(accueil.index('id="hq-carnet-home"'), accueil.index('id="hq-cal-home"'))
        self.assertIn("if (view === 'accueil' && window.hqCarnetHome) {\n"
                      "    try { window.hqCarnetHome(); } catch (e) { console.error(e); }", self.app_js)

    def test_home_privacy_role_gate_before_any_carnet_fetch(self):
        home = self.js.split("async function refreshHome()", 1)[1].split("global.hqCarnetHome", 1)[0]
        role_check = home.index('ui.role !== "admin"')
        fetch = home.index('apiCall("/api/carnet?meta=1"')
        me = home.index('apiCall("/api/me"')
        self.assertLess(me, fetch)
        self.assertLess(role_check, fetch)
        self.assertNotIn("drafts", home, "Home never reads local drafts")
        render = self.js.split("function renderHome(data)", 1)[1].split("\n  }\n", 1)[0]
        self.assertIn('ui.role !== "admin"', render)

    def test_one_editor_one_state_machine(self):
        # Stage 04: the editor is one contenteditable surface; the only textarea left is the legacy copy buffer.
        self.assertEqual(self.js.count('"textarea"'), 1)
        self.assertEqual(self.js.count('el("div", {\n      id: "hq-carnet-editor"'), 1)
        self.assertEqual(self.js.count("createCore({"), 1)
        self.assertEqual(self.js.count('id: "hq-carnet-editor"'), 1)

    def test_no_html_sinks_and_fixed_endpoints(self):
        for sink in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
            self.assertNotIn(sink, self.js)
        self.assertEqual(sorted(set(re.findall(r'"(/api/[^"]*)"', self.js))), ["/api/carnet", "/api/carnet?meta=1", "/api/me"])
        self.assertNotIn("/api/carnet", iphone_bridge.UPLOAD_GET_EXACT)
        self.assertNotIn("/api/carnet", iphone_bridge.UPLOAD_POST_EXACT)

    def test_org_never_sent_from_draft_snapshot(self):
        record = self.js.split("function draftRecord(e) {", 1)[1].split("\n    }\n", 1)[0]
        self.assertNotIn("project_id: e.local", record)
        self.assertNotIn("category_id: e.local", record)
        drafts = self.js.split("function applyDrafts(map) {", 1)[1].split("\n    async function load()", 1)[0]
        self.assertNotIn("d.project_id", drafts)
        self.assertNotIn("d.category_id", drafts)

    def test_responsive_css(self):
        self.assertIn("@media (max-width:599px)", self.css)
        self.assertRegex(self.css, r"height:88dvh")
        self.assertIn("grid-template-columns:280px minmax(0,1fr)", self.css)
        self.assertIn('.carnet-library[data-mode="drawer"]', self.css)
        self.assertIn('.carnet-library[data-mode="sheet"]', self.css)
        # capability-aware dock: wide screens, or desktop-usable fine-pointer windows (1024x768)
        self.assertIn('"(min-width: 1100px)"', self.js)
        self.assertIn('"(min-width: 1000px) and (hover: hover) and (pointer: fine)"', self.js)
        self.assertNotIn("userAgent", self.js)
        self.assertIn("body.carnet-focus", self.css)
        self.assertIn("@media (prefers-reduced-motion:no-preference)", self.css)
        for m in re.finditer(r"\.wrap\{[^}]*\}", self.css):
            self.assertIn('body[data-view="carnet"]', self.css[max(0, m.start() - 40):m.start()])


if __name__ == "__main__":
    unittest.main()
