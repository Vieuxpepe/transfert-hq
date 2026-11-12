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
        self.assertIn('[data-view-link="engine"]{display:none}', BRIDGE)
        self.assertIn('data-view-link="engine"', BRIDGE)

    def test_routes_use_the_engine_module(self):
        self.assertIn("import hq_engine", BRIDGE)
        self.assertRegex(BRIDGE, r'raw\.startswith\("/api/engine/"\)[^\n]*\n\s+code, payload = hq_engine\.http_get')
        self.assertRegex(BRIDGE, r'raw\.startswith\("/api/engine/"\)[^\n]*\n\s+code, payload = hq_engine\.http_post')

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


if __name__ == "__main__":
    unittest.main()
