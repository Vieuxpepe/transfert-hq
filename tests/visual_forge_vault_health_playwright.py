"""Forge Studio vault health check: the read-only summary in Mes coffres (works locked) and the deep
check of the open vault. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault folders (never the real vault).

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_vault_health_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import PROD_PORTS, Run, start_server
from visual_forge_multivault_playwright import create, listing, open_fold, to_private, unlock_card
from visual_forge_multivault_v5_playwright import import_one

PASS = "synthetic horse battery"
PASS_B = "another synthetic phrase"


def section_summary(run: Run) -> None:
    print("Health summary, every vault, locked")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Atelier", PASS)
    create(run, page, "Hirondelle", PASS_B, discret=True)
    unlock_card(run, page, 0, PASS)
    vid = listing(run, page)["vaults"][0]["id"]
    import_one(run, page, vid)
    open_fold(page, "forge-vault-backup-fold")
    with page.expect_download():
        page.locator("#forge-vault-backup-zip").click()
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => [...document.querySelectorAll('.forge-vault-card')].every((c) => c.dataset.open === 'false')", 10)
    page.locator("#forge-vaults-health-fold summary").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vaults-health-list .forge-health-row').length === 2", 10), "opening the fold lists every vault, all locked")
    rows = page.evaluate("() => [...document.querySelectorAll('.forge-health-row')].map((r) => ({ state: r.dataset.state, text: r.innerText }))")
    run.check(rows[0]["state"] == "ok" and "Bon état" in rows[0]["text"] and "Sauvegardé aujourd'hui" in rows[0]["text"] and "1 image sur" in rows[0]["text"], "the backed-up vault is in good shape: " + rows[0]["text"].replace("\n", " | "))
    run.check(rows[1]["state"] == "warn" and "À regarder" in rows[1]["text"] and "Jamais sauvegardé" in rows[1]["text"], "the other one says it was never backed up (state in words, not colour only)")
    run.check(rows[1]["text"].startswith("Coffre n"), "the Discret vault is named by its number")
    run.check(not page.evaluate("(n) => document.documentElement.outerHTML.includes(n)", "Hirondelle"), "no Discret name anywhere in the page")
    run.check("Lecture seule" in page.locator("#forge-vaults-health-fold").inner_text(), "the fold says it is read-only")
    run.check(page.locator("#forge-vaults-health-total").inner_text().startswith("Ensemble : 1 image sur "), "totals against the global limits, singular when one")
    size = page.evaluate("() => { const r = document.getElementById('forge-vaults-health-run').getBoundingClientRect(); return Math.min(r.width, r.height); }")
    run.check(size >= 44, f"Actualiser is a 44 px target ({size})")
    run.shot(page, "health-summary", "#forge-vaults-health-fold")
    ctx.close()


def section_deep(run: Run) -> None:
    print("Deep check of the open vault")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Atelier", PASS)
    unlock_card(run, page, 0, PASS)
    vid = listing(run, page)["vaults"][0]["id"]
    import_one(run, page, vid)
    import_one(run, page, vid)
    open_fold(page, "forge-vault-check-fold")
    page.locator("#forge-vault-check-run").click()
    run.check(run.until(page, "() => /Tout est intact/.test(document.querySelector('#forge-vault-check-status').textContent)", 20), "every image decrypts: Tout est intact")
    run.check("2 images intactes sur 2" in page.locator("#forge-vault-check-result").inner_text(), "the result counts the images")
    run.shot(page, "health-deep", "#forge-vault-check-fold")
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => document.querySelector('.forge-vault-card').dataset.open === 'false'", 10)
    run.check(page.evaluate("() => document.querySelector('#forge-vault-check-result').children.length === 0 && document.querySelector('#forge-vault-check-status').textContent === ''"), "locking clears the result")
    r = page.request.post(run.base + "/api/forge/vaults/" + vid + "/check", data="{}", headers={"origin": run.base, "content-type": "application/json"})
    run.check(r.status == 401, "locked: the server refuses the deep check (401)")
    ctx.close()


SECTIONS = {"summary": section_summary, "deep": section_deep}


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
