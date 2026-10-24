"""Forge Studio multi-vault V5: glyphs and colours (contrast checked), the photo icon sealed in its vault,
the clear/Discret switch with honest copy, and manual order with up/down buttons. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault folders (never the real vault).

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_multivault_v5_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import PROD_PORTS, STORAGE_PROBE, Run, _png_bytes, start_server
from visual_forge_multivault_playwright import create, listing, open_fold, show_all, to_private, unlock_card

PASS = "synthetic horse battery"
PASS_B = "another synthetic phrase"
PASS_C = "third synthetic phrase"

CONTRAST = """() => {
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const out = {};
  [...document.querySelectorAll('#forge-vault-edit-colour option')].forEach((o) => {
    const t = document.createElement('span'); t.className = 'forge-vault-tile'; t.dataset.colour = o.value; t.textContent = 'A';
    document.body.appendChild(t); const s = getComputedStyle(t); out[o.value] = ratio(s.color, s.backgroundColor); t.remove();
  });
  return out; }"""


def import_one(run: Run, page, vid: str) -> str:
    before = page.evaluate("() => document.querySelectorAll('#forge-vault-gallery .forge-card').length")
    r = page.request.post(run.base + "/api/forge/vaults/" + vid + "/import", data=_png_bytes(),
                          headers={"origin": run.base, "content-type": "application/octet-stream"})
    run.check(r.status == 201, "a synthetic private image is imported")
    run.dest(page, "normal")
    run.dest(page, "private")
    run.until(page, "(n) => document.querySelectorAll('#forge-vault-gallery .forge-card').length > n && !document.querySelector('#forge-vault-open-tools').hidden", 10, before)
    return r.json()["id"]


def section_palette(run: Run) -> None:
    print("V5.1 glyphs and colours")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Atelier", PASS)
    unlock_card(run, page, 0, PASS)
    glyphs = page.evaluate("() => [...document.querySelectorAll('#forge-vault-glyph option')].map((o) => o.value)")
    run.check(len(glyphs) == 20 and len(set(glyphs)) == 20, f"a fixed set of 20 glyphs ({len(glyphs)})")
    ratios = page.evaluate(CONTRAST)
    run.check(len(ratios) >= 8 and all(r >= 4.5 for r in ratios.values()), "every tile colour keeps white text >= 4.5:1 " + repr({k: round(v, 2) for k, v in ratios.items()}))
    ctx.close()


def section_icon(run: Run) -> None:
    print("V5.2 photo icon, sealed in its vault, shown only while open")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Atelier", PASS)
    unlock_card(run, page, 0, PASS)
    vid = listing(run, page)["vaults"][0]["id"]
    image_id = import_one(run, page, vid)
    page.locator("#forge-vault-gallery .forge-card").first.click()
    page.locator("#forge-vault-icon-use").wait_for()
    page.locator("#forge-vault-icon-use").click()
    run.check(run.until(page, "() => /chiffr/.test(document.querySelector('#forge-vault-icon-note').textContent)", 10), "the viewer confirms the icon is sealed in this vault")
    page.locator("#forge-vault-viewer-close").click()
    run.check(run.until(page, "() => { const i = document.querySelector('.forge-vault-card[data-open=\"true\"] .forge-vault-tile img'); return !!i && i.src.startsWith('blob:') && i.naturalWidth > 0; }", 10), "open: the card shows the photo icon from a blob URL")
    run.check(listing(run, page)["vaults"][0]["icon"] is True and page.evaluate("() => document.getElementById('forge-vault-icon-row').hidden") is False, "the listing says icon only for the open vault")
    run.shot(page, "v5-icon-open", "#forge-vaults")
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => document.querySelector('.forge-vault-card').dataset.open === 'false'", 10)
    tile = page.evaluate("() => { const t = document.querySelector('.forge-vault-tile'); return { img: !!t.querySelector('img'), text: t.textContent }; }")
    run.check(not tile["img"] and tile["text"], f"locked: glyph and colour only {tile}")
    run.check(page.evaluate("() => [...document.querySelectorAll('img')].filter((i) => (i.src || '').startsWith('blob:')).length") == 0, "locked: no blob image left in the page")
    run.check(listing(run, page)["vaults"][0]["icon"] is False, "locked: the listing does not even say there is an icon")
    hits = [h for h in page.evaluate(STORAGE_PROBE, image_id) if not h.endswith(":hqForgeDraft")]
    run.check(hits == [], f"nothing about the icon in browser storage {hits}")
    run.shot(page, "v5-icon-locked", "#forge-vaults")
    unlock_card(run, page, 0, PASS)
    run.check(run.until(page, "() => !!document.querySelector('.forge-vault-card[data-open=\"true\"] .forge-vault-tile img')", 10), "reopened: the icon comes back")
    page.evaluate("() => { document.querySelector('#forge-vault-edit-fold').open = true; }")
    page.locator("#forge-vault-icon-clear").click()
    run.check(run.until(page, "() => !document.querySelector('.forge-vault-tile img') && /retir/.test(document.querySelector('#forge-vaults-note').textContent)", 10), "the photo icon can be removed")
    ctx.close()


def section_discret(run: Run) -> None:
    print("V5.3 clear <-> Discret with honest copy")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Jardin", PASS)
    unlock_card(run, page, 0, PASS)
    page.evaluate("() => { document.querySelector('#forge-vault-edit-fold').open = true; }")
    run.check(page.locator("#forge-vault-rename-current").inner_text() == "Jardin", "the settings show the current name")
    page.locator("#forge-vault-edit-discret").check()
    honest = page.locator("#forge-vault-edit-honest").inner_text()
    run.check("espace libre du disque" in honest and "anciennes sauvegardes" in honest and "ne peut pas garantir" in honest, "turning Discret on says an old name may remain, no false promise")
    page.locator('.forge-pick-grid[data-for="forge-vault-edit-glyph"] [data-value="ancre"]').click()
    page.locator('.forge-pick-grid[data-for="forge-vault-edit-colour"] [data-value="violet"]').click()
    picked = page.evaluate("() => [...document.querySelectorAll('#forge-vault-edit .forge-pick-cell[aria-checked=true]')].map((b) => b.dataset.value)")
    cells = page.evaluate("() => [...document.querySelectorAll('#forge-vault-edit .forge-pick-cell')].map((b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); })")
    run.check(picked == ["ancre", "violet"] and min(cells) >= 44, f"icon and colour as square grids, 44 px cells, one checked each {picked} {min(cells)}")
    run.shot(page, "v5-settings", "#forge-vault-edit")
    page.locator("#forge-vault-edit button[type=submit]").click()
    run.check(run.until(page, "() => /enregistr/.test(document.querySelector('#forge-vault-edit-status').textContent)", 10), "settings saved")
    row = listing(run, page)["vaults"][0]
    run.check(row["discret"] is True and row["glyph"] == "ancre" and row["colour"] == "violet" and row["label"] == "Jardin", "Discret, new glyph and colour; the name shows while open")
    reg = page.request.get(run.base + "/api/forge/vaults").text()
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => document.querySelector('.forge-vault-card').dataset.open === 'false'", 10)
    locked = listing(run, page)["vaults"][0]
    run.check(locked["label"] is None and page.locator(".forge-vault-card-name").first.inner_text().startswith("Coffre n"), "locked: shown by its number")
    run.check(not page.evaluate("(n) => document.documentElement.outerHTML.includes(n)", "Jardin"), "locked: the Discret name is nowhere in the DOM")
    run.shot(page, "v5-discret-locked", "#forge-vaults")
    unlock_card(run, page, 0, PASS)
    page.evaluate("() => { document.querySelector('#forge-vault-edit-fold').open = true; }")
    run.until(page, "() => document.querySelector('#forge-vault-rename-current').textContent === 'Jardin'", 5)
    page.locator("#forge-vault-edit-discret").uncheck()
    run.check("lisible dans la liste" in page.locator("#forge-vault-edit-honest").inner_text(), "turning Discret off warns the name becomes readable while locked")
    page.locator("#forge-vault-edit button[type=submit]").click()
    run.until(page, "() => /enregistr/.test(document.querySelector('#forge-vault-edit-status').textContent)", 10)
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => document.querySelector('.forge-vault-card').dataset.open === 'false'", 10)
    run.check(listing(run, page)["vaults"][0]["label"] == "Jardin", "back to clear: the name is in the list again")
    ctx.close()


def section_order(run: Run) -> None:
    print("V5.4 manual order with buttons, sort by name and by recent")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Bravo", PASS)
    create(run, page, "Alpha", PASS_B, "lune", "bleu")
    create(run, page, "Charlie", PASS_C, "ancre", "vert")
    names = lambda: page.evaluate("() => [...document.querySelectorAll('.forge-vault-card-name')].map((n) => n.textContent)")
    run.until(page, "() => document.querySelectorAll('.forge-vault-card-name').length === 3", 10)
    show_all(page)
    run.check(names() == ["Bravo", "Alpha", "Charlie"], f"creation order first {names()}")
    geo = page.evaluate("() => [...document.querySelectorAll('.forge-vault-move button')].map((b) => { const r = b.getBoundingClientRect(); return [r.width, r.height, b.disabled]; })")
    run.check(len(geo) == 6 and all(w >= 44 and h >= 44 for w, h, _d in geo), f"each move button is at least 44 px {geo}")
    run.check(geo[0][2] and geo[5][2] and not geo[1][2], "the first cannot go up, the last cannot go down")
    run.shot(page, "v5-order", "#forge-vaults")
    page.locator('.forge-vault-move button[data-move="down"]').first.click()
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-vault-card-name')].map((n) => n.textContent).join() === 'Alpha,Bravo,Charlie'", 10), "Descendre moves Bravo down")
    run.check([v["label"] for v in listing(run, page)["vaults"]] == ["Alpha", "Bravo", "Charlie"], "the order is saved on HQ")
    run.check(page.evaluate("() => document.activeElement && document.activeElement.closest('.forge-vault-move') !== null"), "focus stays on a move button")
    page.locator('.forge-vault-move button[data-move="up"]').nth(2).click()
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-vault-card-name')].map((n) => n.textContent).join() === 'Alpha,Charlie,Bravo'", 10), "Monter moves Charlie up")
    page.locator("#forge-vaults-sort").select_option("nom")
    run.check(names() == ["Alpha", "Bravo", "Charlie"] and page.locator(".forge-vault-move").count() == 0, "sort by name, move buttons only in the chosen order")
    page.locator("#forge-vaults-sort").select_option("recent")
    run.check(page.locator("#forge-vaults-sort-note").is_visible() and "verrouill" in page.locator("#forge-vaults-sort-note").inner_text(), "sort by recent says the day is visible while locked")
    page.locator("#forge-vaults-sort").select_option("manuel")
    run.check(names() == ["Alpha", "Charlie", "Bravo"], "back to the chosen order")
    run.check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), "375 px: no horizontal overflow")
    ctx.close()


def section_rename(run: Run) -> None:
    print("Rename: Renommer in the open vault's settings; Discret names stay sealed")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Jardin", PASS)
    unlock_card(run, page, 0, PASS)
    page.evaluate("() => { document.querySelector('#forge-vault-edit-fold').open = true; }")
    shown = page.evaluate("() => [document.querySelector('#forge-vault-edit-fold summary').textContent, document.querySelector('#forge-vault-edit legend').textContent, document.querySelector('#forge-vaults-sort option[value=recent]').textContent, document.querySelector('#forge-vault-edit button[type=submit]').textContent, document.querySelector('#forge-vault-security-fold summary').textContent]")
    run.check(shown == ["Apparence", "Ic\u00f4ne", "Par r\u00e9cent", "Enregistrer les r\u00e9glages", "S\u00e9curit\u00e9"] and not page.evaluate("() => /[A-Za-z]\\?[A-Za-z\\u00c0-\\u00ff]/.test(document.querySelector('#forge-vault').textContent)"), "accents render, no '?' inside words: " + repr(shown))
    opener = page.locator("#forge-vault-rename-open")
    run.check(opener.is_visible() and page.locator("#forge-vault-rename").is_hidden(), "a quiet Renommer button, the form stays folded")
    opener.click()
    run.check(page.evaluate("() => document.activeElement.id") == "forge-vault-rename-label" and page.locator("#forge-vault-rename-label").input_value() == "Jardin", "Renommer opens the field with the current name, focused")
    run.check("lisible" in page.locator("#forge-vault-rename-honest").inner_text(), "clear vault: says the new name stays readable while locked")
    geo = page.evaluate("() => [...document.querySelectorAll('#forge-vault-rename button, #forge-vault-rename input')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height))")
    run.check(len(geo) == 3 and min(geo) >= 44, f"44 px targets {geo}")
    run.check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth + 1"), "375 px: no horizontal overflow")
    run.shot(page, "rename-open", "#forge-vault-edit-fold")
    page.locator("#forge-vault-rename-label").fill("   ")
    page.locator("#forge-vault-rename button[type=submit]").click()
    run.check(run.until(page, "() => /vide/.test(document.querySelector('#forge-vault-rename-status').textContent)", 5), "an empty name is refused in French")
    page.locator("#forge-vault-rename-label").fill("Potager")
    page.locator("#forge-vault-rename button[type=submit]").click()
    run.check(run.until(page, "() => /renomm/.test(document.querySelector('#forge-vault-rename-status').textContent)", 10), "Coffre renomm?")
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-vault-card-name')].some((n) => n.textContent === 'Potager')", 10), "the card shows the new name")
    run.check(page.locator("#forge-vault-rename").is_hidden() and page.evaluate("() => document.activeElement.id") == "forge-vault-rename-open", "the form folds back, focus returns to Renommer")
    run.check(listing(run, page)["vaults"][0]["label"] == "Potager", "saved on HQ")
    # Discret: rename, then lock; the new name must be nowhere.
    page.locator("#forge-vault-edit-discret").check()
    page.locator("#forge-vault-edit button[type=submit]").click()
    run.until(page, "() => /enregistr/.test(document.querySelector('#forge-vault-edit-status').textContent)", 10)
    run.until(page, "() => !document.querySelector('#forge-vault-rename-open').hidden", 5)
    page.locator("#forge-vault-rename-open").click()
    run.check("chiffr" in page.locator("#forge-vault-rename-honest").inner_text(), "Discret vault: says the new name is encrypted in this vault")
    page.locator("#forge-vault-rename-label").fill("Serre secrete")
    page.locator("#forge-vault-rename button[type=submit]").click()
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-vault-card-name')].some((n) => n.textContent === 'Serre secrete')", 10), "Discret: the new name shows while open")
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => document.querySelector('.forge-vault-card').dataset.open === 'false'", 10)
    run.check(not page.evaluate("(n) => document.documentElement.outerHTML.includes(n)", "Serre secrete") and listing(run, page)["vaults"][0]["label"] is None, "locked: the new Discret name is nowhere in the page or the list")
    run.check(page.locator("#forge-vault-rename-open").is_hidden() or not page.locator("#forge-vault-rename-open").is_visible(), "locked: no Renommer")
    r = page.request.post(run.base + "/api/forge/vaults/" + listing(run, page)["vaults"][0]["id"] + "/rename", data='{"label":"X"}', headers={"origin": run.base, "content-type": "application/json"})
    run.check(r.status == 401, "locked: the server refuses a rename (401)")
    run.shot(page, "rename-discret-locked", "#forge-vaults")
    ctx.close()


SECTIONS = {"palette": section_palette, "icon": section_icon, "discret": section_discret, "order": section_order, "rename": section_rename}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
            proc, info = start_server()
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