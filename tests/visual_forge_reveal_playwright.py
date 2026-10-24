"""Forge Studio result reveal: a finished image is centered on screen (once per submit, never while the
user is busy), plays a scan-line reveal (plus a soft ripple when the house style was used), and reduced motion gets no animation and an instant scroll.
Normal, private (throwaway vault) and fleet batch. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault folders (never the real vault).

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_reveal_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import PROD_PORTS, STORAGE_PROBE, Run, start_server
from visual_forge_multivault_playwright import create, to_private
from visual_forge_j_playwright import KEEP_ALL

PASS = "synthetic reveal phrase"

# Records every scrollIntoView on a result card (target and options) without changing what it does.
SCROLL_SPY = """(() => {
  window.__scrolls = [];
  const orig = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (opts) {
    if (this.classList && this.classList.contains('forge-card')) window.__scrolls.push({ id: this.dataset.id || '', parent: this.parentElement ? this.parentElement.id : '', opts: opts || null });
    return orig.apply(this, arguments);
  };
})();"""

CARD_GEO = """(sel) => { const n = document.querySelector(sel); if (!n) return null; const r = n.getBoundingClientRect();
  const nav = document.querySelector('.bottom-nav'); const bar = document.querySelector('#forge-actionbar');
  const tops = [nav, bar].filter((x) => x && x.offsetParent !== null).map((x) => x.getBoundingClientRect().top).filter((t) => t > innerHeight / 2);
  const floor = tops.length ? Math.min(...tops) : innerHeight;
  return { top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2, vh: innerHeight, floor, y: scrollY,
    cls: n.className, anim: getComputedStyle(n.querySelector('img')).animationName, line: getComputedStyle(n, '::before').animationName,
    ring: getComputedStyle(n, '::after').animationName, card: getComputedStyle(n).animationName,
    clip: getComputedStyle(n.querySelector('img')).clipPath,
    see: !document.querySelector('#forge-see-result').hidden }; }"""


def generate(run: Run, page, sel: str, button: str = "#forge-generate", during=None) -> dict:
    page.evaluate("() => { window.scrollTo({top: 0, behavior: 'instant'}); document.activeElement && document.activeElement.blur(); window.__scrolls = []; }")
    page.mouse.move(0, 0)
    page.wait_for_timeout(100)
    before = page.evaluate("(s) => [...document.querySelectorAll(s)].map((n) => n.dataset.id)", sel)
    page.locator(button).click()
    if during:
        page.wait_for_timeout(300)
        during()
    y0 = page.evaluate("() => scrollY")
    if not run.until(page, "(a) => [...document.querySelectorAll(a[0])].some((n) => !a[1].includes(n.dataset.id) && n.classList.contains('forge-reveal'))", 30, [sel, before]):
        raise SystemExit("FAIL: no revealed result for " + sel)
    g = page.evaluate(CARD_GEO, sel)
    g["y0"] = y0
    return g


def in_view(g: dict) -> bool:
    return g["top"] >= -1 and g["bottom"] <= g["floor"] + 1


def section_normal(run: Run) -> None:
    print("R1 normal generation: center, reveal, no yank, chip")
    ctx = run.context(SCROLL_SPY, 375, 667)
    page = ctx.new_page()
    run.open_forge(page)
    page.locator("#forge-prompt").fill("phare au crepuscule")
    g = generate(run, page, "#forge-results .forge-card")
    run.check("forge-reveal" in g["cls"] and g["anim"] == "forge-scan" and g["line"] == "forge-scan-line", f"the new card plays the scan-line reveal ({g['anim']}, {g['line']})")
    run.check(g["ring"] == "forge-reveal-ring" and "forge-reveal-celebrate" not in g["cls"] and g["card"] in ("none", ""), "without the house style: completion ring, no ripple")
    page.wait_for_timeout(250)
    mid = page.evaluate("() => { const i = document.querySelector('#forge-results .forge-card img'); return [getComputedStyle(i).clipPath, parseFloat(getComputedStyle(i.parentElement, '::before').top), i.parentElement.getBoundingClientRect().height]; }")
    run.check(mid[0].startswith("inset(") and mid[0] != "inset(0px)" and 0 < mid[1] < mid[2], f"mid-scan: the image is partly uncovered and the line is inside the card {mid}")
    run.shot(page, "reveal-375-mid-scan")
    page.wait_for_timeout(1200)
    g = page.evaluate(CARD_GEO, "#forge-results .forge-card")
    s = page.evaluate("() => window.__scrolls")
    run.check(len(s) == 1 and s[0]["parent"] == "forge-results" and s[0]["opts"]["block"] == "center" and s[0]["opts"]["behavior"] == "smooth", f"one smooth centered scroll onto the result {s}")
    run.check(in_view(g) and abs(g["mid"] - g["vh"] / 2) < g["vh"] * 0.3 and g["y"] > 50 and not g["see"], f"the finished image is on screen, near the middle, no chip {g}")
    run.check(page.evaluate("() => getComputedStyle(document.querySelector('#forge-results .forge-card')).opacity") == "1", "the reveal ends fully opaque")
    run.shot(page, "reveal-375-centered")

    # Busy user: scrolled away mid-render -> no jump, quiet chip, tap jumps.
    def wheel():
        page.mouse.move(187, 300)
        page.mouse.wheel(0, 160)
        page.wait_for_timeout(150)
    page.locator("#forge-prompt").fill("phare occupe")
    g = generate(run, page, "#forge-results .forge-card", during=wheel)
    page.wait_for_timeout(600)
    g2 = page.evaluate(CARD_GEO, "#forge-results .forge-card")
    run.check(page.evaluate("() => window.__scrolls.length") == 0 and abs(g2["y"] - g["y0"]) < 6, f"busy: no jump while the user scrolled ({g['y0']} -> {g2['y']})")
    run.check(g2["see"] and page.locator("#forge-see-result").inner_text().strip() == "Voir le r\u00e9sultat", "busy: 'Voir le r\u00e9sultat' is offered instead")
    run.check("forge-reveal" in g2["cls"], "busy: the card still gets its reveal")
    run.shot(page, "reveal-375-chip")
    page.locator("#forge-see-result").click()
    page.wait_for_timeout(1000)
    g = page.evaluate(CARD_GEO, "#forge-results .forge-card")
    run.check(in_view(g) and page.locator("#forge-see-result").is_hidden(), f"tapping the chip centers the result and hides the chip {g}")
    run.check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), "375px: no horizontal overflow")
    ctx.close()


def section_reduced(run: Run) -> None:
    print("R2 reduced motion: no animation, instant scroll")
    ctx = run.context(SCROLL_SPY, 375, 667)
    page = ctx.new_page()
    page.emulate_media(reduced_motion="reduce")
    run.open_forge(page)
    page.locator("#forge-prompt").fill("phare calme")
    g = generate(run, page, "#forge-results .forge-card")
    run.check(all(g[k] in ("none", "") for k in ("anim", "line", "ring", "card")), f"reduced motion: no scan, line, ring or ripple ({g['anim']}, {g['line']}, {g['ring']}, {g['card']})")
    run.check(g["clip"] in ("none", ""), "reduced motion: the image is never clipped")
    s = page.evaluate("() => window.__scrolls")
    run.check(len(s) == 1 and s[0]["opts"]["behavior"] == "auto" and s[0]["opts"]["block"] == "center", f"reduced motion: the scroll is instant {s}")
    g = page.evaluate(CARD_GEO, "#forge-results .forge-card")
    run.check(in_view(g), f"reduced motion: the result is on screen right away {g}")
    run.check(page.evaluate("() => getComputedStyle(document.querySelector('#forge-results .forge-card')).opacity") == "1", "reduced motion: the card is fully visible at once")
    run.shot(page, "reveal-375-reduced")
    ctx.close()


def section_private(run: Run) -> None:
    print("R3 private generation: the vault card is centered and revealed, nothing stored")
    ctx = run.context(SCROLL_SPY, 375, 667)
    page = ctx.new_page()
    page.on('console', lambda m: print('CONSOLE', m.text) if 'LAND' in m.text else None)
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Atelier", PASS)
    vid = page.request.get(run.base + "/api/forge/vaults").json()["vaults"][0]["id"]
    page.locator("#forge-private-target").select_option(vid)
    if run.until(page, "() => !document.querySelector('#forge-vault-unlock').hidden", 3):
        page.locator("#forge-vault-pass").fill(PASS)
        page.locator("#forge-vault-open").click()
    run.until(page, "() => !document.querySelector('#forge-vault-open-tools').hidden", 10)
    page.locator("#forge-prompt").fill("phare secret")
    run.until(page, "() => !document.querySelector('#forge-generate-private').disabled", 15)
    g = generate(run, page, "#forge-vault-gallery .forge-card", "#forge-generate-private")
    run.check("forge-reveal" in g["cls"] and g["anim"] == "forge-scan" and "forge-reveal-celebrate" not in g["cls"], "the new vault card plays the scan-line reveal, no ripple without the house style")
    page.wait_for_timeout(1200)
    g = page.evaluate(CARD_GEO, "#forge-vault-gallery .forge-card")
    s = page.evaluate("() => window.__scrolls")
    run.check(len(s) == 1 and s[0]["parent"] == "forge-vault-gallery" and s[0]["opts"]["block"] == "center", f"one centered scroll onto the vault card {s}")
    run.check(in_view(g) and not g["see"], f"the private result is on screen {g}")
    image_id = page.evaluate("() => document.querySelector('#forge-vault-gallery .forge-card').dataset.id")
    hits = [h for h in page.evaluate(STORAGE_PROBE, image_id) if not h.endswith(":hqForgeDraft")]
    run.check(bool(image_id) and hits == [], f"no browser storage holds the private image id {hits}")
    run.shot(page, "reveal-375-private")
    ctx.close()


def section_batch(run: Run) -> None:
    print("R4 fleet batch: center the first finished image once, never yank afterwards")
    ctx = run.context(SCROLL_SPY, 375, 667)
    page = ctx.new_page()
    run.open_forge(page)
    run.until(page, "() => [...document.querySelectorAll('#forge-device-list .forge-device')].filter((n) => n.dataset.state === 'available').length >= 3", 20)
    page.locator("#forge-devices-all").click()
    run.until(page, "() => !document.querySelector('#forge-fleet-count-field').hidden", 5)
    page.locator("#forge-prompt").fill("phare en lot")
    generate(run, page, "#forge-results .forge-card")
    run.until(page, "() => (document.querySelector('#forge-fleet-batch-state').textContent || '').startsWith('Termin')", 60)
    page.wait_for_timeout(800)
    s = page.evaluate("() => window.__scrolls")
    n = page.locator("#forge-results .forge-card").count()
    run.check(n >= 2 and len(s) == 1 and s[0]["parent"] == "forge-results", f"one centering scroll for the whole batch ({len(s)} for {n} images)")
    run.check(page.evaluate("() => [...document.querySelectorAll('#forge-results .forge-card')].every((c) => c.classList.contains('forge-reveal'))"), "every batch image gets its reveal as it lands")
    run.shot(page, "reveal-375-batch")

    page.locator("#forge-prompt").fill("phare en lot occupe")
    page.evaluate("() => { window.scrollTo({top: 0, behavior: 'instant'}); window.__scrolls = []; }")
    page.locator("#forge-generate").click()
    run.until(page, "() => window.__scrolls.length > 0", 30)
    page.wait_for_timeout(700)
    page.mouse.move(187, 300)
    page.mouse.wheel(0, -300)
    page.wait_for_timeout(400)
    y = page.evaluate("() => scrollY")
    count = page.evaluate("() => window.__scrolls.length")
    run.until(page, "() => (document.querySelector('#forge-fleet-batch-state').textContent || '').startsWith('Termin')", 60)
    page.wait_for_timeout(800)
    run.check(count == 1 and page.evaluate("() => window.__scrolls.length") == 1 and abs(page.evaluate("() => scrollY") - y) < 6, "after the user scrolled away mid-batch, later images never move the page")
    run.check(page.locator("#forge-see-result").is_visible(), "the batch end offers 'Voir le r\u00e9sultat' instead")
    ctx.close()



def apply_house_style(run: Run, page) -> None:
    page.locator("#forge-style > summary").click()
    run.until(page, "() => !document.querySelector('#forge-style-apply').hidden", 10)
    page.locator("#forge-style-apply").click()
    run.until(page, "() => /Rien n'est lanc/.test(document.querySelector('#forge-style-done').textContent)", 5)
    page.locator("#forge-style > summary").click()


def section_ripple(run: Run) -> None:
    print("R5 soft ripple: only when the house style was applied, normal and private")
    ctx = run.context(SCROLL_SPY, 375, 667)
    page = ctx.new_page()
    run.open_forge(page)
    for i in range(5):
        page.locator("#forge-prompt").fill(f"phare garde {i}")
        generate(run, page, "#forge-results .forge-card")
        run.until(page, "() => !document.querySelector('#forge-generate').disabled", 15)
    run.check(page.evaluate(KEEP_ALL) >= 5, "five kept images give a house style")
    page.locator("#forge-steps").fill("9")
    page.locator("#forge-steps").dispatch_event("change")
    apply_house_style(run, page)
    page.locator("#forge-prompt").fill("phare maison")
    g = generate(run, page, "#forge-results .forge-card")
    run.check("forge-reveal-celebrate" in g["cls"] and g["anim"] == "forge-scan", "house style applied: scan line, then the ripple class")
    page.wait_for_timeout(1000)
    g = page.evaluate(CARD_GEO, "#forge-results .forge-card")
    run.check(g["card"] == "forge-ripple-out" and g["ring"] == "forge-ripple-in", f"the ripple plays after the scan ({g['card']}, {g['ring']})")
    run.shot(page, "reveal-375-ripple")
    page.wait_for_timeout(2500)
    run.check(page.evaluate("() => getComputedStyle(document.querySelector('#forge-results .forge-card')).outlineStyle") in ("none", "solid") and page.evaluate("() => getComputedStyle(document.querySelector('#forge-results .forge-card')).outlineColor") in ("rgba(0, 0, 0, 0)", "transparent") or page.evaluate("() => getComputedStyle(document.querySelector('#forge-results .forge-card')).outlineStyle") == "none", "after the ripple no outline lingers")
    page.locator("#forge-steps").fill("13")
    page.locator("#forge-steps").dispatch_event("change")
    page.locator("#forge-prompt").fill("phare change")
    g = generate(run, page, "#forge-results .forge-card")
    run.check("forge-reveal-celebrate" not in g["cls"], "settings changed after applying: no ripple")
    run.until(page, "() => !document.querySelector('#forge-generate').disabled", 15)

    to_private(run, page)
    create(run, page, "Atelier", PASS)
    vid = page.request.get(run.base + "/api/forge/vaults").json()["vaults"][0]["id"]
    page.locator("#forge-private-target").select_option(vid)
    if run.until(page, "() => !document.querySelector('#forge-vault-unlock').hidden", 3):
        page.locator("#forge-vault-pass").fill(PASS)
        page.locator("#forge-vault-open").click()
    run.until(page, "() => !document.querySelector('#forge-vault-open-tools').hidden", 10)
    apply_house_style(run, page)
    page.locator("#forge-prompt").fill("phare maison secret")
    run.until(page, "() => !document.querySelector('#forge-generate-private').disabled", 15)
    g = generate(run, page, "#forge-vault-gallery .forge-card", "#forge-generate-private")
    run.check("forge-reveal-celebrate" in g["cls"] and g["anim"] == "forge-scan", "private + house style: scan line and ripple on the vault card")
    image_id = page.evaluate("() => document.querySelector('#forge-vault-gallery .forge-card').dataset.id")
    hits = [h for h in page.evaluate(STORAGE_PROBE, image_id) if not h.endswith(":hqForgeDraft")]
    run.check(hits == [] and page.evaluate("() => Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter((k) => /house|style|celebr/i.test(k))") == [], f"nothing about the private image or the ripple is stored {hits}")
    page.emulate_media(reduced_motion="reduce")
    page.wait_for_timeout(100)
    g = page.evaluate(CARD_GEO, "#forge-vault-gallery .forge-card")
    run.check(g["card"] in ("none", "") and g["ring"] in ("none", ""), "reduced motion: no ripple")
    ctx.close()


SECTIONS = {"normal": section_normal, "reduced": section_reduced, "private": section_private, "batch": section_batch, "ripple": section_ripple}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
            extra = {"HQ_FORGE_FLEET_MOCK": "3", "HQ_FORGE_FLEET_DELAY": "1.5"} if name == "batch" else None
            proc, info = start_server(extra)
            assert not info["base"].endswith(PROD_PORTS)
            try:
                run = Run(browser, info)
                SECTIONS[name](run)
                if run.errors:
                    raise SystemExit("FAIL: page errors " + repr(run.errors[:3]))
                total += run.passed
            finally:
                proc.stdin.close()
                proc.wait(timeout=10)
        browser.close()
    print(f"PASS {total} checks ({browser_name})")


if __name__ == "__main__":
    main()