"""Phase J4 couch mode: a page-side display choice that never touches requests, sessions or locks."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]


class Couch(unittest.TestCase):
    def test_couch_script_sends_nothing_and_sets_no_timer(self):
        js = (SOURCE / "assets" / "hq-forge-couch.js").read_text(encoding="utf-8")
        code = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
        for banned in ("fetch(", "XMLHttpRequest", "sendBeacon", "setTimeout", "setInterval", "/api/", "document.cookie", "sessionStorage", "WebSocket", "EventSource"):
            self.assertNotIn(banned, code, banned)
        self.assertEqual(re.findall(r"localStorage\.(\w+)\(", code), ["setItem", "removeItem", "getItem"])
        self.assertIn('"hqForgeCouch"', code)

    def test_page_wires_the_toggle_without_inline_handlers(self):
        html = (SOURCE / "iphone_bridge.py").read_text(encoding="utf-8")
        # Forge modules are loaded on first visit by hqForgeLoad(), no longer as page tags.
        self.assertNotIn('<script src="/assets/hq-forge-couch.js"></script>', html)
        self.assertIn("'hq-forge-couch.js'", html)
        tag = re.search(r'<button[^>]*id="forge-couch"[^>]*>', html).group(0)
        self.assertNotRegex(tag, r"\son\w+=")
        self.assertIn('aria-pressed="false"', tag)

    def test_session_and_idle_code_is_not_part_of_couch_mode(self):
        css = (SOURCE / "assets" / "hq-forge.css").read_text(encoding="utf-8")
        self.assertIn("#forge-studio.is-couch #forge-sampling", css)
        js = (SOURCE / "assets" / "hq-forge.js").read_text(encoding="utf-8")
        self.assertNotIn("couch", js.lower(), "the studio's idle lock and session code never read the couch flag")


if __name__ == "__main__":
    unittest.main()
