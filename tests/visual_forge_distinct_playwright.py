"""Forge Studio: fleet parity (A), politeness (B), explore around (C). Mock Forge only.

No GPU, no real Forge, no production port. Same harness as the quick-wins suite.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_distinct_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

import visual_forge_quick_wins_playwright as QW
from visual_forge_quick_wins_playwright import Run, open_vault, import_private, generate_once, start_server, STORAGE_PROBE


def section_parity(run: Run) -> None:
    print("A fleet parity")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    run.check(run.until(page, "() => document.querySelectorAll('.forge-device').length >= 3", 20), "this HQ and the simulated PCs are listed")
    for name in ("PC salon", "Portable"):
        box = page.locator(".forge-device", has_text=name).locator('input[type="checkbox"]')
        if not box.is_checked():
            box.check()
    page.locator("#forge-fleet-count").fill("4")
    page.locator("#forge-fleet-count").dispatch_event("input")
    page.locator("#forge-prompt").fill("phare en lot")
    page.locator("#forge-generate").click()
    run.check(run.until(page, "() => /Portable : autre version du mod\u00e8le/.test(document.querySelector('#forge-fleet-batch-excluded') && document.querySelector('#forge-fleet-batch-excluded').textContent)", 15),
              "the batch names the excluded PC: Portable : autre version du mod\u00e8le \u2026, exclu.")
    run.shot(page, "parity-excluded", "#forge-fleet-batch")
    run.check(run.until(page, "() => /Termin/.test(document.querySelector('#forge-fleet-batch-state').textContent)", 40), "the batch finishes without the excluded PC")
    batches = page.request.get(run.base + "/api/forge/batches").json()["batches"]
    batch = batches[0]
    run.check(all(t["worker_id"] != batch["excluded"][0]["worker_id"] for t in batch["tasks"]), "no task ran on the excluded PC")
    ctx.close()


def section_polite(run: Run) -> None:
    print("B politeness")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    run.check(page.locator("#forge-generate").is_enabled(), "G\u00e9n\u00e9rer stays available while Forge works for someone else")
    run.check("HQ attendra" in page.locator("#forge-generate-reason").inner_text(), "the note says HQ will wait")
    page.locator("#forge-prompt").fill("image polie")
    page.locator("#forge-generate").click()
    run.check(run.until(page, "() => /Forge occup\u00e9, en attente/.test(document.querySelector('#forge-progress-label').textContent)", 10), "the progress says Forge occup\u00e9, en attente")
    run.check(page.locator("#forge-start-now").is_visible(), "Lancer quand m\u00eame is offered while waiting")
    run.shot(page, "polite-waiting", "#forge-actionbar")
    page.locator("#forge-start-now").click()
    run.check(run.until(page, "() => document.querySelector('#forge-wait').hidden", 5), "the waiting row goes away once sent")
    run.check(run.until(page, "() => document.querySelectorAll('#forge-gallery .forge-card').length > 0", 20), "the image completes (queued behind, never interrupted)")
    ctx.close()


def section_explore(run: Run) -> None:
    print("C explore around")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    generate_once(run, page, "phare a explorer")
    page.locator("#forge-gallery .forge-card").first.click()
    page.locator("#forge-viewer").wait_for()
    run.check(run.until(page, "() => !document.querySelector('#forge-viewer-explore').disabled", 5), "Explorer autour is ready for an image with a known seed")
    page.locator("#forge-viewer-explore-range").fill("0.35")
    run.shot(page, "explore-viewer", "#forge-viewer-explore-box")
    before = page.locator("#forge-gallery .forge-card").count()
    page.locator("#forge-viewer-explore").click()
    run.check(run.until(page, "(n) => document.querySelectorAll('#forge-gallery .forge-card').length >= n + 6", 30, before), "a strip of 6 variations lands")
    run.check(run.until(page, "() => document.querySelectorAll('#forge-results .forge-card').length === 6", 10), "the result strip shows the 6 variations")
    run.shot(page, "explore-strip", "#forge-results")
    jobs = page.request.get(run.base + "/api/forge/jobs").json()["jobs"]
    job = jobs[0]
    s = job["settings"]
    run.check(s["subseed_strength"] == 0.35 and s["seed"] == 4 and s["n_iter"] == 6, "same seed, strength 0,35, six images: " + repr({k: s.get(k) for k in ("seed", "subseed", "subseed_strength", "n_iter")}))
    page.locator("#forge-results .forge-card").nth(2).click()
    page.locator("#forge-viewer").wait_for()
    run.check(run.until(page, "() => /Variation 0,35/.test(document.querySelector('#forge-viewer-meta').textContent)", 5), "a variation shows its strength and variation seed")
    page.locator("#forge-reuse").click()
    if page.locator("#forge-restore-replace").is_visible():
        page.locator("#forge-restore-replace").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-variation-chip').hidden", 5), "continuing from it keeps the variation in the form")
    run.shot(page, "explore-continue", "#forge-seed-fold")
    # Private: stays on this HQ, never in browser storage.
    open_vault(run, page)
    secret = "variation privee 31"
    page.locator("#forge-prompt").fill(secret)
    run.until(page, "() => !document.querySelector('#forge-generate-private').disabled", 15)
    before = page.locator("#forge-vault-gallery .forge-card").count()
    page.locator("#forge-generate-private").click()
    run.check(run.until(page, "(n) => document.querySelectorAll('#forge-vault-gallery .forge-card').length > n", 30, before), "a private image is generated")
    page.locator("#forge-vault-gallery .forge-card").first.click()
    page.locator("#forge-vault-viewer").wait_for()
    run.check(run.until(page, "() => !document.querySelector('#forge-vault-explore').disabled", 5), "Explorer autour is offered in the vault viewer")
    run.shot(page, "explore-vault", "#forge-vault-explore-box")
    before = page.locator("#forge-vault-gallery .forge-card").count()
    page.locator("#forge-vault-explore").click()
    run.check(run.until(page, "(n) => document.querySelectorAll('#forge-vault-gallery .forge-card').length >= n + 6", 30, before), "six private variations land in the vault")
    hits = page.evaluate(STORAGE_PROBE, secret)
    run.check([h for h in hits if h != "session:hqForgeJob"] == [], "no private prompt in browser storage: " + repr(hits))
    listed = page.request.get(run.base + "/api/forge/jobs").text()
    run.check(secret not in listed, "the private prompt is not in the job list")
    ctx.close()


SECTIONS = {"parity": section_parity, "polite": section_polite, "explore": section_explore}
EXTRA_ENV = {"parity": {"HQ_FORGE_FLEET_MOCK": "2", "HQ_FORGE_FLEET_DELAY": "0.3", "HQ_FORGE_FLEET_PARITY": "1"},
             "polite": {"HQ_FORGE_MOCK_BUSY_SEC": "25"}}


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
