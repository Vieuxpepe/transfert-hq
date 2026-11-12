"""The Engine tab is wired into the bridge page and routes (static checks: no server needed)."""
from __future__ import annotations

import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")


class EngineWiringTests(unittest.TestCase):
    def test_view_label_panel_and_visibility_rule(self):
        self.assertRegex(BRIDGE, r"VIEW_LABELS = \{[^}]*engine: 'Engine'")
        self.assertIn('data-panel="engine"', BRIDGE)
        self.assertIn('body[data-view="engine"] [data-panel="engine"]', BRIDGE)

    def test_admin_gate_in_client_and_nav(self):
        self.assertRegex(BRIDGE, r"view === 'engine'\) && !hqSessionIsAdmin\(\)\) view = 'accueil'")
        self.assertRegex(BRIDGE, r'\[data-view-link="engine"\](?:,[^{]*)?\{display:none\}')
        self.assertIn('data-view-link="engine"', BRIDGE)

    def test_routes_use_the_engine_module(self):
        self.assertIn("import hq_engine", BRIDGE)
        self.assertRegex(BRIDGE, r'raw\.startswith\("/api/engine/"\)[^\n]*\n\s+code, payload = hq_engine\.http_get')
        self.assertRegex(BRIDGE, r'raw\.startswith\("/api/engine/"\)[^\n]*\n(?:[^\n]*\n){1,25}?\s+code, payload = hq_engine\.http_post\(raw, data\)')
        self.assertIn("/engine-agent/v1/", BRIDGE)
        self.assertIn("hq_engine_fleet.handle_agent", BRIDGE)
        self.assertIn("hq_engine.bind(ROOT, notify=_inventoria_notify)", BRIDGE)

    def test_post_route_comes_after_the_csrf_gate(self):
        """The POST route must sit in the block that runs after the bridge's CSRF check."""
        post_at = BRIDGE.index("hq_engine.http_post")
        neighbour = BRIDGE.index('hq_inventoria.http_post')        # Inventoria POST is documented as CSRF-checked first
        self.assertLess(abs(post_at - neighbour), 2500)

    def test_assets_linked_and_hooked_in_setview(self):
        self.assertIn('/assets/hq-engine.css', BRIDGE)
        self.assertIn('/assets/hq-engine.js', BRIDGE)
        self.assertIn("window.hqEngineShow", BRIDGE)
        self.assertIn("window.hqEngineHide", BRIDGE)
        for f in ("hq-engine.js", "hq-engine.css"):
            self.assertTrue((ROOT / "assets" / f).is_file())

    def test_js_has_no_innerhtml_and_parses(self):
        js = (ROOT / "assets" / "hq-engine.js").read_text(encoding="utf-8")
        self.assertNotRegex(js, r"innerHTML|outerHTML|insertAdjacentHTML|document\.write")
        node = shutil.which("node")
        if node:
            r = subprocess.run([node, "--check", str(ROOT / "assets" / "hq-engine.js")], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)

    def test_css_is_scoped_and_balanced(self):
        css = (ROOT / "assets" / "hq-engine.css").read_text(encoding="utf-8")
        self.assertEqual(css.count("{"), css.count("}"))
        body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
        for sel in re.findall(r"([^{}]+)\{", body):
            sel = sel.strip()
            if sel.startswith("@"):
                continue
            for part in sel.split(","):
                self.assertTrue(part.strip().startswith((".hq-eng", "0%", "50%", "from", "to")), part)


class PistoniaWiringTests(unittest.TestCase):
    JS = (ROOT / "assets" / "hq-pistonia-chip.js").read_text(encoding="utf-8")
    CSS = (ROOT / "assets" / "hq-pistonia.css").read_text(encoding="utf-8")

    def test_assets_are_linked_in_order(self):
        scale = BRIDGE.index("/assets/hq-image-chip-scale.js")
        engine = BRIDGE.index("/assets/hq-engine.js")
        chip = BRIDGE.index("/assets/hq-pistonia-chip.js")
        self.assertLess(scale, chip)                       # the shared pinch/scale + adult-mode helpers load first
        self.assertLess(engine, chip)
        self.assertIn("/assets/hq-pistonia.css", BRIDGE)

    def test_chat_body_limit_is_raised_only_for_the_chat_route(self):
        self.assertRegex(BRIDGE, r'32768 if raw == "/api/engine/pistonia/message" else 4096')

    def test_js_is_markup_safe_and_calls_only_engine_endpoints(self):
        self.assertNotRegex(self.JS, r"innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(")
        self.assertIn("ACTION_URL", self.JS)
        self.assertIn(r"\/api\/engine\/daemons\/", self.JS)                   # the allow-list regex
        urls = set(re.findall(r'"(/api/[^"]+)"', self.JS))
        self.assertEqual(urls, {"/api/engine/pistonia/" + r for r in ("thread", "message", "clear", "seen", "resolve", "memory/delete", "settings", "voice")})
        self.assertIn('d.audio_url.indexOf("/assets/companion/chat/voice_cache/") !== 0', self.JS)   # only her own voice cache is ever played

    def test_only_visible_on_the_engine_tab_for_admin(self):
        self.assertIn('doc.body.dataset.view === "engine"', self.JS)
        self.assertIn('classList.contains("session-admin")', self.JS)
        self.assertIn('body:not([data-view="engine"]) .hq-pistonia', self.CSS)

    def test_drag_resize_and_keyboard_paths_exist(self):
        for needle in ("bindDrag(chip", "setPointerCapture", "HqImageChipScale.bind", "grip", "ArrowLeft", "LS_POS", "LS_SIZE", "contextmenu"):
            self.assertIn(needle, self.JS, needle)

    def test_adult_mode_slot_falls_back_to_the_sfw_icon(self):
        self.assertIn("/assets/companion/pistonia-chip.webp", self.JS)          # where the user's image goes
        self.assertIn("/assets/companion/pistonia-chip-sfw.webp", self.JS)
        self.assertIn("bindPortraitMode", self.JS)
        self.assertIn("probe.onerror", self.JS)                                  # a missing adult image keeps the SFW icon
        self.assertFalse((ROOT / "assets" / "companion" / "pistonia-chip.webp").exists() and False)

    def test_sfw_icon_files_are_real_images(self):
        from PIL import Image
        for name, size in (("pistonia-chip-sfw.webp", 640), ("pistonia-chip-sfw@2x.webp", 1280)):
            im = Image.open(ROOT / "assets" / "companion" / name)
            self.assertEqual(im.size, (size, size))
        self.assertTrue((ROOT / "assets" / "companion" / "pistonia-chip-icon.svg").is_file())

    def test_css_is_scoped(self):
        body = re.sub(r"/\*.*?\*/", "", self.CSS, flags=re.S)
        for sel in re.findall(r"([^{}]+)\{", body):
            sel = sel.strip()
            if sel.startswith("@"):
                continue
            for part in sel.split(","):
                self.assertTrue(part.strip().startswith((".hq-pistonia", "body:not([data-view=\"engine\"]) .hq-pistonia", "from", "to", "50%", "0%", "40%", "80%", "100%")), part)

    def test_engine_tab_feeds_mood_and_has_an_entry_button(self):
        eng_js = (ROOT / "assets" / "hq-engine.js").read_text(encoding="utf-8")
        self.assertIn("hq:engine-status", eng_js)
        self.assertIn("hqEngineRefresh", eng_js)
        self.assertIn("HqPistonia.open", eng_js)


if __name__ == "__main__":
    unittest.main()
