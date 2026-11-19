"""UI pass on the Inventaire page and the Inventoria chip: static contracts for what the offline DOM harness cannot reach."""
from __future__ import annotations

import re
import unittest
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"
PAGE_JS = (ASSETS / "hq-inventory.js").read_text(encoding="utf-8")
PAGE_CSS = (ASSETS / "hq-inventory.css").read_text(encoding="utf-8")
CHIP_JS = (ASSETS / "hq-inventoria-chip.js").read_text(encoding="utf-8")
CHIP_CSS = (ASSETS / "hq-inventoria.css").read_text(encoding="utf-8")


def rule(css: str, selector: str) -> str:
    """Bodies of every rule whose selector list contains ``selector`` exactly, joined (media-query rules included)."""
    found = []
    for m in re.finditer(r"([^{}]+)\{([^{}]*)\}", css):
        if selector in [s.strip() for s in m.group(1).split(",")]:
            found.append(m.group(2))
    return ";".join(found)


class InventairePageTests(unittest.TestCase):
    def test_search_placeholder_fits_a_phone(self) -> None:
        chunk = PAGE_JS[PAGE_JS.index("S.searchEl = el("):]
        chunk = chunk[:chunk.index("autocomplete")]
        texts = re.findall(r'"([^"]*…)"', chunk)
        self.assertEqual(len(texts), 2)
        self.assertLessEqual(len(texts[1]), 28)           # the old 56-character text was cut at 34 on a 390px screen
        self.assertLessEqual(len(texts[0]), 12)           # under 360px the scan button leaves room for about 16 characters
        self.assertIn("innerWidth < 360", chunk)

    def test_scan_button_only_when_the_chip_can_scan_and_calls_it(self) -> None:
        self.assertIn('typeof chipApi().scan === "function"', PAGE_JS)
        self.assertIn("a.scan()", PAGE_JS)
        self.assertIn("inv-scan", PAGE_CSS)

    def test_filters_are_one_swipeable_row(self) -> None:
        body = rule(PAGE_CSS, ".inv-chips")
        self.assertIn("flex-wrap:nowrap", body)
        self.assertIn("overflow-x:auto", body)
        self.assertIn("flex:0 0 auto", rule(PAGE_CSS, ".inv-chips .inv-chip"))

    def test_empty_state_offers_ways_to_start_that_need_no_tree(self) -> None:
        self.assertIn("welcomeShortcuts()", PAGE_JS)
        self.assertIn("Dis-lui ce que tu as", PAGE_JS)
        self.assertIn("Photo d'une étagère", PAGE_JS)
        self.assertIn("api.say(", PAGE_JS)
        self.assertIn("api.photo()", PAGE_JS)

    def test_search_leads_with_where_it_is(self) -> None:
        self.assertIn('class: "inv-where"', PAGE_JS)
        self.assertIn("pathText(S.ix, top.place", PAGE_JS)

    def test_content_can_scroll_clear_of_the_chip(self) -> None:
        self.assertIn(".inv{padding-bottom:calc(150px + env(safe-area-inset-bottom,0px))}", PAGE_CSS)


class ChipPanelTests(unittest.TestCase):
    def test_chip_exposes_scan_photo_and_say_to_the_page(self) -> None:
        for needle in ("scan: () =>", "photo: () =>", "say: (text) =>"):
            self.assertIn(needle, CHIP_JS)

    def test_touch_targets_are_44px_where_it_matters(self) -> None:
        for selector in (".hq-inventoria .hq-inventoria-bubble button.hq-inventoria-toast-undo",
                         ".hq-inventoria .hq-inventoria-bubble button.hq-inventoria-tab",
                         ".hq-inventoria .hq-inventoria-bubble button.hq-inventoria-chat-send",
                         ".hq-inventoria .hq-inventoria-bubble button.hq-inventoria-head-btn"):
            self.assertIn("min-height:44px", rule(CHIP_CSS, selector), selector)
        self.assertIn("min-width:44px", rule(CHIP_CSS, ".hq-inventoria .hq-inventoria-bubble button.hq-inventoria-chat-mic"))

    def test_the_older_phone_overrides_no_longer_shrink_targets_below_44(self) -> None:
        self.assertNotRegex(CHIP_CSS, r"button:not\(\.hq-inventoria-head-btn\):not\(\.hq-inventoria-tab\)\{min-height:(?:3\d|40)px")
        self.assertNotIn("button.hq-inventoria-quick-btn{min-height:36px}", CHIP_CSS)
        self.assertNotIn("button.hq-inventoria-tab{min-height:38px", CHIP_CSS)

    def test_queued_cards_are_hidden_without_being_dropped(self) -> None:
        body = rule(CHIP_CSS, ".hq-inventoria-draft.is-queued")
        self.assertIn("display:none", body)
        self.assertIn("is-queued", CHIP_JS)

    def test_send_is_icon_only_on_narrow_panels_but_keeps_its_name(self) -> None:
        self.assertIn("hq-inventoria-chat-send .hq-inv-lbl{position:absolute", CHIP_CSS)
        self.assertIn('chatSend.textContent = "Envoyer"', CHIP_JS)

    def test_toast_respects_reduced_motion_and_reads_as_applied(self) -> None:
        self.assertIn("prefers-reduced-motion:reduce", CHIP_CSS)
        self.assertIn('ico("check", "hq-inventoria-toast-ico")', CHIP_JS)


class LegibilityAndMotionTests(unittest.TestCase):
    def test_nothing_but_the_count_badge_is_set_below_12px(self) -> None:
        small = [(m.start(), m.group(0)) for m in re.finditer(r"font-size:(?:10(?:\.\d)?|11(?:\.\d)?)px", CHIP_CSS)]
        for pos, _txt in small:
            line = CHIP_CSS[CHIP_CSS.rfind(chr(10), 0, pos) + 1:CHIP_CSS.find(chr(10), pos)]
            self.assertTrue("badge" in line or "min-width:16px" in line or "font-weight:800;line-height:18px" in line,
                            "small type outside the badge: " + line.strip()[:90])

    def test_disabled_buttons_stay_readable(self) -> None:
        m = re.search(r"button:disabled\{opacity:([.\d]+)", CHIP_CSS)
        self.assertGreaterEqual(float(m.group(1)), 0.6)

    def test_motion_is_opt_in_short_and_compositor_only(self) -> None:
        block = CHIP_CSS[CHIP_CSS.index("/* Motion:"):]
        self.assertIn("@media (prefers-reduced-motion:no-preference){", block)
        self.assertIn("@media (prefers-reduced-motion:reduce){", block)
        self.assertIn(":not(.is-motion-lite)", block)                      # HQ's own low-motion mode also turns it off
        for name in ("hq-inv-rise", "hq-inv-fade", "hq-inv-menu", "hq-inv-pop"):
            body = re.search(r"@keyframes " + name + r"\{(.*?)\}\s*(?=@keyframes|\.hq-inventoria)", block, re.S)
            self.assertIsNotNone(body, name)
            props = set(re.findall(r"([a-z-]+):", body.group(1)))
            self.assertTrue(props <= {"opacity", "transform"}, f"{name} animates {props}")
        for dur in re.findall(r"animation:hq-inv-[a-z]+ \.?(\d+\.?\d*)s", block):
            self.assertLessEqual(float("0." + dur) if not dur.startswith("0") else float(dur), 0.4)

    def test_page_motion_is_gated_too(self) -> None:
        tail = PAGE_CSS[PAGE_CSS.index("/* Legibility + motion pass (page) */"):]
        self.assertIn("@media (prefers-reduced-motion:no-preference){", tail)
        self.assertNotIn("animation:inv-rise-in", tail.split("@media (prefers-reduced-motion:no-preference){")[0])

    def test_summary_icon_is_decorated_once_not_per_refresh(self) -> None:
        self.assertIn('const insightSum = decorate(doc.createElement("summary"), "eye");', CHIP_JS)
        self.assertEqual(CHIP_JS.count("decorate(insightSum"), 0)

    def test_new_messages_are_flagged_only_when_added_live(self) -> None:
        self.assertIn('fresh.classList.add("is-new")', CHIP_JS)
        render = CHIP_JS[CHIP_JS.index("const renderThread = (msgs) =>"):CHIP_JS.index("const appendThread = (role, text) =>")]
        self.assertNotIn("is-new", render)                                  # a restored thread must not animate all at once


class SuiviContractTests(unittest.TestCase):
    SUIVI = (ASSETS / "hq-inventoria-suivi.js").read_text(encoding="utf-8")
    I18N = (ASSETS / "hq-inventoria-i18n.js").read_text(encoding="utf-8")
    BRIDGE = (ASSETS.parent / "iphone_bridge.py").read_text(encoding="utf-8")
    SERVER = (ASSETS.parent / "hq_inventoria.py").read_text(encoding="utf-8")

    def test_every_route_the_ui_calls_exists_on_the_server(self) -> None:
        paths = set(re.findall(r'"(/api/inventoria/[a-z-]+)', self.SUIVI + CHIP_JS))
        self.assertGreater(len(paths), 15)
        for path in sorted(paths):
            if path == "/api/inventoria/item":                       # GET /item/<id>, matched by ITEM_RE
                self.assertIn("ITEM_RE", self.SERVER)
                continue
            if path in ("/api/inventoria/sessions", "/api/inventoria/ops"):   # regex-routed families
                self.assertIn(path.split("/")[-1], self.SERVER)
                continue
            self.assertIn('"' + path + '"', self.SERVER, "the UI calls " + path + " but the server has no such route")

    def test_scripts_load_in_the_right_order(self) -> None:
        i18n, chip, suivi = (self.BRIDGE.index(f'<script src="/assets/{n}"></script>') for n in
                             ("hq-inventoria-i18n.js", "hq-inventoria-chip.js", "hq-inventoria-suivi.js"))
        self.assertTrue(i18n < chip < suivi, "language layer, then the chip, then the extension")

    def test_the_sheet_closes_on_escape_even_after_focus_is_lost(self) -> None:
        self.assertIn('doc.addEventListener("keydown", onEscape, true)', self.SUIVI)
        self.assertIn('doc.removeEventListener("keydown", onEscape, true)', self.SUIVI)

    def test_dictionary_has_no_duplicate_keys(self) -> None:
        # entries look like  ["French key", "English"]  possibly several per line; keys are the first string of each pair
        pairs_block = self.I18N[self.I18N.index("const PAIRS = ["):self.I18N.index("// Patterns:")]
        keys = re.findall(r'\["((?:[^"\\]|\\.)+)",\s*\n?\s*"', pairs_block)
        self.assertGreater(len(keys), 60)
        dup = {k for k in keys if keys.count(k) > 1}
        self.assertFalse(dup, f"duplicate dictionary keys: {sorted(dup)[:5]}")

    def test_chat_messages_are_never_rewritten_by_the_language_layer(self) -> None:
        self.assertIn(".hq-inventoria-thread-log,.hq-inventoria-msg", self.I18N)

    def test_queued_requests_always_carry_a_client_id(self) -> None:
        self.assertIn("client_id: cid", CHIP_JS)
        self.assertIn("const cid = newCid();", CHIP_JS)


if __name__ == "__main__":
    unittest.main()
