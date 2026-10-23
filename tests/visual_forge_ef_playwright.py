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


PINCH = """(spread) => {
  const s = document.querySelector('#forge-compare-stage'); const r = s.getBoundingClientRect();
  const y = r.top + r.height / 2, x = r.left + r.width / 2;
  const fire = (type, id, px) => s.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: px, clientY: y, bubbles: true, isPrimary: id === 1, pointerType: 'touch' }));
  fire('pointerdown', 1, x - 25); fire('pointerdown', 2, x + 25);
  for (let i = 1; i <= 5; i++) { fire('pointermove', 1, x - 25 - spread * i / 5); fire('pointermove', 2, x + 25 + spread * i / 5); }
  fire('pointerup', 1, x - 25 - spread); fire('pointerup', 2, x + 25 + spread);
  const layers = [...s.querySelectorAll('.forge-compare-layer')].map((n) => getComputedStyle(n).transform);
  return { zoom: Number(getComputedStyle(s).getPropertyValue('--zoom')), layers };
}"""


def section_compare(run: Run) -> None:
    print("E3 A/B comparator")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    generate_once(run, page, "phare comparatif A")
    generate_once(run, page, "phare comparatif B")
    ids = page.evaluate("() => [...document.querySelectorAll('#forge-gallery .forge-card')].map((c) => c.dataset.id)")
    page.locator('#forge-gallery .forge-card[data-id="' + ids[0] + '"]').click()
    page.locator("#forge-viewer").wait_for()
    page.locator("#forge-compare-start").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-viewer').open && !document.querySelector('#forge-compare-pick').hidden", 5), "Comparer closes the viewer and asks for the second image")
    run.shot(page, "compare-pick")
    page.locator('#forge-gallery .forge-card[data-id="' + ids[0] + '"]').click()
    run.check(run.until(page, "() => /autre image/.test(document.querySelector('#forge-compare-pick').textContent) && !document.querySelector('#forge-viewer').open", 5), "picking A again is refused, the viewer stays closed")
    page.locator('#forge-gallery .forge-card[data-id="' + ids[1] + '"]').click()
    run.check(run.until(page, "() => document.querySelector('#forge-compare').open", 5), "the second pick opens the comparator")
    run.check(run.until(page, "() => ['a', 'b'].every((k) => { const i = document.querySelector('#forge-compare-' + k); return i.complete && i.naturalWidth > 0; })", 10), "both originals are shown")
    first = page.request.get(run.base + "/api/forge/gallery/" + ids[0]).json()["settings"]["prompt"]
    second = page.request.get(run.base + "/api/forge/gallery/" + ids[1]).json()["settings"]["prompt"]
    diff = page.locator("#forge-compare-diff").inner_text()
    run.check(first != second and "Prompt" in diff and "A : " + first in diff and "B : " + second in diff, "the settings that differ are listed side by side")
    page.evaluate("() => { const r = document.querySelector('#forge-compare-reveal'); r.value = '20'; r.dispatchEvent(new Event('input', { bubbles: true })); }")
    run.check(page.evaluate("() => getComputedStyle(document.querySelector('#forge-compare-stage')).getPropertyValue('--reveal').trim()") == "20%", "the reveal slider moves the split")
    clip = page.evaluate("() => getComputedStyle(document.querySelector('.forge-compare-clip')).clipPath")
    run.check("inset" in clip, "B is clipped by the split, not redrawn: " + clip)
    pinch = page.evaluate(PINCH, 100)
    run.check(2.5 < pinch["zoom"] <= 6, "a pinch zooms: " + repr(pinch["zoom"]))
    run.check(pinch["layers"][0] == pinch["layers"][1] and pinch["layers"][0] != "none", "the same zoom moves A and B together")
    geo = page.evaluate("() => ({ doc: document.documentElement.scrollWidth, stage: document.querySelector('#forge-compare-stage').getBoundingClientRect().width })")
    run.check(geo["doc"] <= 375 and geo["stage"] <= 375, "the comparator fits 375 px: " + repr(geo))
    run.shot(page, "compare-zoom")
    page.locator("#forge-compare-reset").click()
    run.check(page.evaluate("() => getComputedStyle(document.querySelector('#forge-compare-stage')).getPropertyValue('--zoom').trim()") == "1", "Zoom initial resets both")
    page.locator("#forge-compare-swap").click()
    run.check("A : " + second in page.locator("#forge-compare-diff").inner_text(), "Inverser swaps A and B")
    run.shot(page, "compare-diff", "#forge-compare-diff")
    page.locator("#forge-compare-close").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-compare').open && !document.querySelector('#forge-compare-a').hasAttribute('src') && !document.querySelector('#forge-compare-b').hasAttribute('src')", 5),
              "closing drops both decoded images")
    page.locator('#forge-gallery .forge-card[data-id="' + ids[1] + '"]').click()
    run.check(run.until(page, "() => document.querySelector('#forge-viewer').open", 5), "after the comparison a card opens the viewer again")
    page.locator("#forge-viewer-close").click()
    hits = page.evaluate(STORAGE_PROBE, "comparatif")
    run.check([h for h in hits if h != "session:hqForgeDraft"] == [], "nothing of the comparison in browser storage: " + repr(hits))
    ctx.close()


def section_wake(run: Run) -> None:
    print("F1 wake-on-LAN")
    ctx = run.context(width=820, height=1000)
    page = ctx.new_page()
    run.open_forge(page)
    card = lambda n: page.locator(".forge-device", has_text=n)
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-device')].some((c) => /PC endormi/.test(c.textContent) && /Hors ligne/.test(c.textContent))", 20), "the quiet PC is listed offline")
    run.check(card("PC endormi").locator(".forge-device-wake-btn").count() == 0, "no wake button before a MAC is saved")
    note = card("PC endormi").locator(".forge-device-wake-note").inner_text()
    run.check("Tailscale" in note and "BIOS" in note and "m\u00eame r\u00e9seau local" in note, "the card says same LAN, not Tailscale, BIOS/NIC: " + note)
    card("PC endormi").locator(".forge-device-wake-form input").fill("zz:zz")
    card("PC endormi").locator(".forge-device-wake-form button").click()
    run.check(run.until(page, "() => /Adresse MAC invalide/.test(document.querySelector('#forge-devices-note').textContent)", 5), "an invalid MAC is refused in plain French")
    card("PC endormi").locator(".forge-device-wake-form input").fill("3C:7A:1B:2C:4D:5E")
    card("PC endormi").locator(".forge-device-wake-form button").click()
    run.check(run.until(page, "() => /R\u00e9glage de r\u00e9veil enregistr\u00e9/.test(document.querySelector('#forge-devices-note').textContent)", 5), "the MAC is saved")
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-device')].some((c) => /PC endormi/.test(c.textContent) && c.querySelector('.forge-device-wake-btn'))", 10), "the offline PC now offers R\u00e9veiller")
    ph = card("PC endormi").locator(".forge-device-wake-form input").get_attribute("placeholder")
    run.check("4d:5e" in ph.lower() and "1b" not in ph.lower() and card("PC endormi").locator(".forge-device-wake-form input").input_value() == "", "only the MAC tail is shown, the field is emptied: " + repr(ph))
    run.shot(page, "wake-card", ".forge-device:has-text('PC endormi')")
    card("PC endormi").locator(".forge-device-wake-btn").click()
    run.check(run.until(page, "() => /Paquet de r\u00e9veil envoy\u00e9/.test(document.querySelector('#forge-devices-note').textContent)", 5), "R\u00e9veiller says the packet left (mocked sender)")
    page.wait_for_timeout(1700)
    card("PC endormi").locator(".forge-device-wake-btn").click()
    run.check(run.until(page, "() => /d\u00e9j\u00e0 envoy\u00e9/.test(document.querySelector('#forge-devices-note').textContent)", 5), "a second press within 10 s is held back")
    run.shot(page, "wake-sent", ".forge-device:has-text('PC endormi')")
    card("PC salon").locator(".forge-device-wake-form input").fill("3C-7A-1B-2C-4D-60")
    card("PC salon").locator(".forge-device-wake-form button").click()
    run.until(page, "() => /R\u00e9glage de r\u00e9veil enregistr\u00e9/.test(document.querySelector('#forge-devices-note').textContent)", 5)
    page.wait_for_timeout(800)
    run.check(card("PC salon").locator(".forge-device-wake-btn").count() == 0, "an online PC never shows R\u00e9veiller")
    run.check(page.locator(".forge-device[data-id='local']").count() == 1 and page.locator(".forge-device[data-id='local'] .forge-device-wake").count() == 0, "this HQ has no wake block")
    html = page.content()
    api = page.request.get(run.base + "/api/forge/devices").text()
    run.check(not any(s in html.lower() or s in api.lower() for s in ("1b:2c", "1b-2c", "3c7a1b")), "the MAC is in neither the page nor the devices API")
    hits = [h for s in ("1B-2C", "1B:2C", "1b:2c", "1b-2c") for h in page.evaluate(STORAGE_PROBE, s)]
    run.check(hits == [], "the MAC is in no browser storage: " + repr(hits))
    page.set_viewport_size({"width": 375, "height": 812})
    page.wait_for_timeout(200)
    geo = page.evaluate("""() => { const c = [...document.querySelectorAll('.forge-device')].find((n) => /PC endormi/.test(n.textContent)); const d = c.querySelector('.forge-device-more'); d.open = true;
        const i = c.querySelector('.forge-device-wake-form input').getBoundingClientRect(); const b = c.querySelector('.forge-device-wake-btn').getBoundingClientRect();
        return { sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, ih: i.height, bh: b.height, right: Math.max(i.right, b.right) }; }""")
    run.check(geo["sw"] <= geo["vw"] and geo["right"] <= geo["vw"] and geo["ih"] >= 44 and geo["bh"] >= 44, "at 375 px the wake controls fit and are 44 px touch targets: " + repr(geo))
    card("PC endormi").locator(".forge-device-wake").scroll_into_view_if_needed()
    run.shot(page, "wake-375", ".forge-device:has-text('PC endormi')")
    ctx.close()


SECTIONS = {"sweep": section_sweep, "finish": section_finish, "compare": section_compare, "wake": section_wake}
EXTRA_ENV: dict = {"sweep": {"HQ_FORGE_FLEET_MOCK": "2", "HQ_FORGE_FLEET_DELAY": "0.3"}, "wake": {"HQ_FORGE_FLEET_MOCK": "1", "HQ_FORGE_FLEET_DELAY": "0.3", "HQ_FORGE_FLEET_WAKE": "1"}}


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