"""Forge Studio phases E and F: sweep, finish, A/B comparator, wake-on-LAN, LoRA messages. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault. Same harness as quick wins.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_ef_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import Run, generate_once, start_server, STORAGE_PROBE


def pick_devices(page, names) -> None:
    for card in page.locator(".forge-device").all():
        box = card.locator('input[type="checkbox"]')
        want = any(n in card.inner_text() for n in names)
        if box.count() and box.is_checked() != want:
            box.click()


def section_sweep(run: Run) -> None:
    print("E1 parameter sweep")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    run.check(run.until(page, "() => document.querySelectorAll('.forge-device').length >= 3", 20), "this HQ and two PCs are listed")
    pick_devices(page, ("PC salon", "Portable"))
    page.locator("#forge-prompt").fill("phare balayage")
    page.locator("#forge-sweep summary").click()
    run.check(run.until(page, "() => /4 images, une par valeur/.test(document.querySelector('#forge-sweep-note').textContent)", 5), "the default CFG sweep announces 4 images")
    page.locator("#forge-sweep-values").fill("4")
    run.check(run.until(page, "() => document.querySelector('#forge-sweep-run').disabled && /deux valeurs/.test(document.querySelector('#forge-sweep-note').textContent)", 5), "one value is refused in plain French")
    page.locator("#forge-sweep-values").fill("1 ; 2 ; 3 ; 4 ; 5 ; 6 ; 7 ; 8 ; 9")
    run.check(run.until(page, "() => /Huit valeurs au plus/.test(document.querySelector('#forge-sweep-note').textContent)", 5), "more than 8 cells is refused")
    page.locator("#forge-sweep-axis").select_option("lora_weight")
    run.check(run.until(page, "() => /Ajoutez d'abord un LoRA/.test(document.querySelector('#forge-sweep-note').textContent)", 5), "a LoRA sweep asks for a LoRA in the prompt first")
    page.locator("#forge-sweep-axis").select_option("cfg_scale")
    page.locator("#forge-sweep-values").fill("4 ; 6 ; 8 ; 10")
    run.check(run.until(page, "() => !document.querySelector('#forge-sweep-run').disabled", 5), "four CFG values are accepted")
    page.locator("#forge-sweep-run").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-sweep-strip').hidden && document.querySelectorAll('#forge-sweep-strip .forge-sweep-cell').length === 4", 10),
              "the strip shows one cell per value")
    run.check(run.until(page, "() => document.querySelectorAll('#forge-sweep-strip .forge-card img').length === 4", 40), "all four images arrive in the strip")
    labels = page.locator("#forge-sweep-strip figcaption").all_inner_texts()
    run.check(labels == ["CFG 4", "CFG 6", "CFG 8", "CFG 10"], "cells are labelled in the order typed: " + repr(labels))
    batch = page.request.get(run.base + "/api/forge/batches").json()["batches"][-1]
    full = page.request.get(run.base + "/api/forge/batches/" + batch["batch_id"]).json()["batch"]
    run.check(full["seed_mode"] == "sweep" and len({t["seed"] for t in full["tasks"]}) == 1, "every cell shares one seed")
    run.check(len({t["worker_id"] for t in full["tasks"]}) == 2, "the cells were spread over both PCs")
    cfgs = sorted(page.request.get(run.base + "/api/forge/gallery/" + t["image_id"]).json()["settings"]["cfg_scale"] for t in full["tasks"])
    run.check(cfgs == [4.0, 6.0, 8.0, 10.0], "each gallery image records its own CFG")
    geo = page.evaluate("""() => { const s = document.querySelector('#forge-sweep-strip'); const c = s.querySelector('.forge-sweep-cell');
        return { over: s.scrollWidth > s.clientWidth + 20, snap: getComputedStyle(s).scrollSnapType, cw: c.getBoundingClientRect().width, sw: s.clientWidth,
                 grid: document.querySelector('#forge-results').hidden }; }""")
    run.check(geo["over"] and "x" in geo["snap"] and 0.6 < geo["cw"] / geo["sw"] < 0.85, "at 375 px the strip scrolls sideways with snap: " + repr(geo))
    run.check(geo["grid"], "the plain result grid steps aside while the strip is shown")
    page.evaluate("() => { const s = document.querySelector('#forge-sweep-strip'); s.scrollLeft = s.scrollWidth; }")
    run.check(run.until(page, "() => document.querySelector('#forge-sweep-strip').scrollLeft > 50", 5), "the strip can be swiped to the last cell")
    run.shot(page, "sweep-strip", "#forge-sweep-strip")
    page.evaluate("() => { const s = document.querySelector('#forge-sweep-strip'); s.scrollLeft = 0; }")
    page.locator("#forge-sweep-strip .forge-card").first.click()
    run.check(run.until(page, "() => document.querySelector('#forge-viewer').open", 5), "a cell opens the usual viewer")
    page.locator("#forge-viewer-close").click()
    run.dest(page, "private")
    run.check(run.until(page, "() => document.querySelector('#forge-sweep-run').disabled && /mode normal/.test(document.querySelector('#forge-sweep-note').textContent)", 5),
              "in private mode the sweep is off and says why")
    run.shot(page, "sweep-private", "#forge-sweep")
    run.dest(page, "normal")
    hits = page.evaluate(STORAGE_PROBE, "phare balayage")
    run.check([h for h in hits if h != "session:hqForgeDraft"] == [], "the prompt is in no browser storage but the normal draft: " + repr(hits))
    ctx.close()


def section_finish(run: Run) -> None:
    print("E2 drafts then finish")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    generate_once(run, page, "phare brouillon")
    page.locator("#forge-gallery .forge-card").first.click()
    page.locator("#forge-viewer").wait_for()
    run.check(run.until(page, "() => !document.querySelector('#forge-viewer-finish').hidden && !document.querySelector('#forge-finish').disabled", 5), "a draft offers a finish on this PC")
    note = page.locator("#forge-finish-note").inner_text()
    run.check("pas une copie identique" in note and "composition" in note, "the finish is labelled as a finish, never as identical")
    run.shot(page, "finish-offer", "#forge-viewer-finish")
    before = page.locator("#forge-gallery .forge-card").count()
    draft = page.evaluate("() => document.querySelector('#forge-gallery .forge-card').dataset.id")
    page.locator("#forge-finish-scale").select_option("1.5")
    page.locator("#forge-finish").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-viewer').open", 5), "starting the finish closes the viewer")
    run.check(run.until(page, "(n) => document.querySelectorAll('#forge-gallery .forge-card').length > n", 20, before), "the finished image lands in the gallery")
    jobs = page.request.get(run.base + "/api/forge/jobs").json()["jobs"]
    job = jobs[-1] if jobs[-1].get("finish_of") else jobs[0]
    run.check(job.get("finish_of") == draft and job["settings"]["enable_hr"] is True and job["settings"]["hr_scale"] == 1.5, "the job renders the draft in high resolution x1.5")
    newest = next(i for i in page.evaluate("() => [...document.querySelectorAll('#forge-gallery .forge-card')].map((c) => c.dataset.id)") if i != draft)
    meta = page.request.get(run.base + "/api/forge/gallery/" + newest).json()
    run.check(meta["origin"] == {"finish_of": draft}, "the gallery records which draft it finishes")
    page.locator('#forge-gallery .forge-card[data-id="' + newest + '"]').click()
    page.locator("#forge-viewer").wait_for()
    run.check(run.until(page, "() => !document.querySelector('#forge-finish-of').hidden", 5), "the finished image says it is a finish")
    run.check(run.until(page, "() => document.querySelector('#forge-finish').disabled && /d\u00e9j\u00e0 en haute r\u00e9solution/.test(document.querySelector('#forge-finish-note').textContent)", 5),
              "a finished image is not finished again")
    run.shot(page, "finish-done", "#forge-finish-of")
    page.locator("#forge-finish-source").click()
    run.check(run.until(page, "(d) => document.querySelector('#forge-viewer').open && document.querySelector('#forge-download').getAttribute('href').includes(d)", 5, draft),
              "Voir l'image d'origine opens the draft")
    box = page.locator("#forge-finish").bounding_box()
    run.check(box["height"] >= 44, "the finish button is a 44 px touch target")
    page.locator("#forge-viewer-close").click()
    ctx.close()


SECTIONS = {"sweep": section_sweep, "finish": section_finish}
EXTRA_ENV: dict = {"sweep": {"HQ_FORGE_FLEET_MOCK": "2", "HQ_FORGE_FLEET_DELAY": "0.3"}}


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
                run.proc = proc
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