"""Forge Studio next features: quick triage + bin (B), lab (B), planner (C), journal (D). Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault. Same harness as quick wins.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_next_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import Run, open_vault, import_private, generate_once, start_server, STORAGE_PROBE


def swipe(page, selector: str, dx: int, dy: int) -> None:
    box = page.locator(selector).bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=6)
    page.mouse.up()


def section_triage(run: Run) -> None:
    print("B quick triage and bin")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    for n in range(4):
        generate_once(run, page, "phare a trier " + str(n))
    page.locator("#forge-triage-open").click()
    page.locator("#forge-triage").wait_for()
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '1 / 4'", 5), "quick triage opens on the 4 untriaged images")
    run.check(run.until(page, "() => !!document.querySelector('#forge-triage-img').getAttribute('src')", 5), "the first image is shown full screen")
    run.shot(page, "triage-normal")
    swipe(page, "#forge-triage-stage", 150, 0)
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '2 / 4'", 5), "swipe right keeps")
    swipe(page, "#forge-triage-stage", -150, 0)
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '3 / 4'", 5), "swipe left rejects")
    run.check("corbeille" in page.locator("#forge-triage-note").inner_text(), "the note says the rejected image went to the bin")
    page.locator("#forge-triage-undo").click()
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '2 / 4'", 5), "undo brings the last image back")
    page.locator("#forge-triage-reject").click()
    run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '3 / 4'", 5)
    page.locator("#forge-triage-favorite").click()
    run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '4 / 4'", 5)
    page.locator("#forge-triage-keep").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-triage-empty').hidden", 5), "the end says nothing is left to sort")
    page.locator("#forge-triage-close").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-gallery .forge-card').length === 3", 10), "the rejected image leaves the gallery (3 left)")
    run.check(run.until(page, "() => !!document.querySelector('#forge-gallery .forge-card[data-triage=\"favorite\"] .forge-card-badge')", 5), "the favourite carries a badge")
    run.shot(page, "triage-gallery", "#forge-normal-gallery")
    page.locator("#forge-trash-open").click()
    page.locator("#forge-trash").wait_for()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-trash-grid .forge-trash-item').length === 1", 5), "the bin holds the rejected image")
    run.shot(page, "triage-bin")
    page.locator("#forge-trash-grid button").first.click()
    run.check(run.until(page, "() => !document.querySelector('#forge-trash-empty').hidden", 5), "Remettre empties the bin")
    page.locator("#forge-trash-close").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-gallery .forge-card').length === 4", 10), "the image is back in the gallery, nothing was deleted")
    page.locator('#forge-gallery .forge-card[data-triage="favorite"]').first.click()
    page.locator("#forge-viewer").wait_for()
    run.check(run.until(page, "() => document.querySelector('#forge-viewer-triage [data-state=\"favorite\"]').getAttribute('aria-pressed') === 'true'", 5), "the viewer shows the current flag")
    page.locator('#forge-viewer-triage [data-state="none"]').click()
    run.check(run.until(page, "() => document.querySelector('#forge-viewer-triage [data-state=\"none\"]').getAttribute('aria-pressed') === 'true'", 5), "the flag can be changed back from the viewer")
    run.shot(page, "triage-viewer", "#forge-viewer-triage")
    page.locator("#forge-viewer-close").click()
    # Vault: same triage, flags kept in the encrypted vault, nothing in browser storage.
    open_vault(run, page)
    import_private(run, page)
    import_private(run, page)
    page.locator("#forge-vault-triage-open").click()
    page.locator("#forge-triage").wait_for()
    run.check(run.until(page, "() => /\\/ 2$/.test(document.querySelector('#forge-triage-count').textContent)", 5), "vault triage lists the 2 private images")
    run.check(run.until(page, "() => (document.querySelector('#forge-triage-img').getAttribute('src') || '').startsWith('blob:')", 5), "private pixels come from a blob URL")
    run.shot(page, "triage-vault")
    page.locator("#forge-triage-reject").click()
    run.until(page, "() => /^2 \\//.test(document.querySelector('#forge-triage-count').textContent)", 5)
    page.locator("#forge-triage-close").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 1", 10), "the rejected private image leaves the vault gallery")
    page.locator("#forge-vault-trash-open").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-trash-grid .forge-trash-item').length === 1", 5), "the vault bin holds it")
    hits = page.evaluate(STORAGE_PROBE, "pvt-")
    run.check([h for h in hits if h not in ("session:hqForgeDraft",)] == [], "no vault id or flag in browser storage: " + repr(hits))
    page.locator("#forge-trash-close").click()
    stats = page.request.get(run.base + "/api/forge/gallery?view=trash").json()["images"]
    run.check(all(not row["id"].startswith("pvt-") for row in stats), "vault images never appear in the normal bin")
    page.locator("#forge-vault-lock").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 0", 5), "locking the vault drops the private views")
    ctx.close()


SECTIONS = {"triage": section_triage}
EXTRA_ENV: dict = {}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
            proc, info = start_server(EXTRA_ENV.get(name))
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