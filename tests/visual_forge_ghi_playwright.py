"""Forge Studio phases G, H and I: night workshop, searchable vault, finger inpainting. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault. Same harness as quick wins.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_ghi_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import Run, generate_once, start_server, STORAGE_PROBE, open_vault, import_private


def section_night(run: Run) -> None:
    print("G night workshop")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    page.locator("#forge-prompt").fill("phare nocturne")
    page.locator("#forge-night summary").click()
    run.check(run.until(page, "() => /Rien n'est interrompu/.test(document.querySelector('#forge-night').textContent)", 5), "the panel says nothing is interrupted")
    page.locator("#forge-night-tonight").click()
    run.check(run.until(page, "() => /pour ce soir/.test(document.querySelector('#forge-night-note').textContent) && document.querySelectorAll('#forge-night-list li[data-state=queued]').length === 1", 5), "Lancer ce soir queues one entry")
    run.shot(page, "night-queued", "#forge-night")
    page.locator("#forge-night-list .forge-night-cancel").first.click()
    ok = run.until(page, "() => document.querySelectorAll('#forge-night-list li[data-state=cancelled]').length === 1", 5)
    if not ok:
        print("DEBUG", page.evaluate("() => [document.querySelector('#forge-night-note').textContent, document.querySelector('#forge-night-list').innerHTML.slice(0, 400)]"))
    run.check(ok, "a waiting entry can be cancelled")
    run.dest(page, "private")
    run.check(run.until(page, "() => document.querySelector('#forge-night-tonight').disabled && document.querySelector('#forge-night-idle').disabled && /Mode priv/.test(document.querySelector('#forge-night-note').textContent)", 5),
              "in private mode nothing can be queued and it says why")
    run.shot(page, "night-private", "#forge-night")
    status = page.evaluate("""async () => { const r = await fetch('/api/forge/night', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HQ-CSRF': document.querySelector('meta[name=hq-csrf]') ? document.querySelector('meta[name=hq-csrf]').content : '' },
        body: JSON.stringify({ when: 'idle', destination: 'private', settings: { prompt: 'secret nuit', checkpoint: 'x' } }) }); return r.status; }""")
    run.check(status in (403,), "the server refuses a private entry too: " + repr(status))
    run.dest(page, "normal")
    page.locator("#forge-prompt").fill("phare quand libre")
    page.locator("#forge-night-idle").click()
    run.check(run.until(page, "() => /Forge est libre/.test(document.querySelector('#forge-night-note').textContent)", 5), "Quand Forge est libre queues it")
    data = None
    for _ in range(80):
        data = page.request.get(run.base + "/api/forge/night").json()
        if any(e["state"] == "done" for e in data["entries"]):
            break
        page.wait_for_timeout(250)
    run.check(any(e["state"] == "done" and e["images"] for e in data["entries"]), "the idle entry ran on the mock Forge")
    page.reload()
    run.open_forge(page)
    run.check(run.until(page, "() => !document.querySelector('#forge-night-summary').hidden && /1 termin/.test(document.querySelector('#forge-night-summary-text').textContent) && document.querySelectorAll('#forge-night-summary img').length === 1", 10),
              "one quiet summary card on the next visit")
    perm = page.evaluate("() => typeof Notification === 'undefined' ? 'none' : Notification.permission")
    run.check(perm != "granted", "no notification permission is used: " + perm)
    geo = page.evaluate("() => { const s = document.querySelector('#forge-night-summary'); const b = s.querySelector('button.secondary').getBoundingClientRect(); return { sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, h: b.height }; }")
    run.check(geo["sw"] <= geo["vw"] and geo["h"] >= 44, "at 375 px the summary fits, Vu is a 44 px target: " + repr(geo))
    run.shot(page, "night-summary", "#forge-night-summary")
    page.locator("#forge-night-summary-ok").click()
    page.wait_for_timeout(400)
    page.reload()
    run.open_forge(page)
    page.wait_for_timeout(800)
    run.check(page.locator("#forge-night-summary").is_hidden(), "after Vu the summary stays quiet")
    hits = page.evaluate(STORAGE_PROBE, "phare quand libre") + page.evaluate(STORAGE_PROBE, "secret nuit")
    run.check([h for h in hits if h != "session:hqForgeDraft"] == [], "no night prompt in browser storage: " + repr(hits))
    ctx.close()


def section_vault_search(run: Run) -> None:
    print("H searchable vault")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    open_vault(run, page)
    import_private(run, page)
    import_private(run, page)
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 2", 10), "two vault images are listed")
    page.locator("#forge-vault-gallery .forge-card").first.click()
    page.locator("#forge-vault-viewer").wait_for()
    run.until(page, "() => document.querySelector('#forge-vault-viewer').open", 5)
    page.locator("#forge-vault-tags").fill("lucioles, nuit d'\u00e9t\u00e9")
    page.locator("#forge-vault-collection").fill("Jardin secret")
    page.locator("#forge-vault-labels-save").click()
    run.check(run.until(page, "() => /Enregistr/.test(document.querySelector('#forge-vault-labels-note').textContent)", 5), "tags and a collection are saved from the viewer")
    run.shot(page, "vault-labels", "#forge-vault-labels")
    page.locator("#forge-vault-viewer-close").click()
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-vault-chip')].some((b) => /lucioles/.test(b.textContent))", 5), "the tag shows as a filter chip")
    page.locator("#forge-vault-q").fill("LUCIOLE")
    page.locator("#forge-vault-search button").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 1 && /1 image trouv/.test(document.querySelector('#forge-vault-search-note').textContent)", 5), "a search finds the tagged image only")
    page.locator("#forge-vault-q").fill("")
    page.locator(".forge-vault-chip", has_text="Jardin secret").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 1", 5), "the collection chip filters")
    geo = page.evaluate("() => ({ sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, h: document.querySelector('#forge-vault-q').getBoundingClientRect().height, c: document.querySelector('.forge-vault-chip').getBoundingClientRect().height })")
    run.check(geo["sw"] <= geo["vw"] and geo["h"] >= 44 and geo["c"] >= 44, "at 375 px search and chips fit as 44 px targets: " + repr(geo))
    run.shot(page, "vault-search", "#forge-vault")
    urls = []
    page.on("request", lambda r: urls.append(r.url))
    page.locator("#forge-vault-q").fill("lucioles")
    page.locator("#forge-vault-search button").click()
    page.wait_for_timeout(400)
    run.check(urls and not any("lucioles" in u for u in urls), "search words never travel in a URL")
    hits = [h for w in ("lucioles", "Jardin secret") for h in page.evaluate(STORAGE_PROBE, w)]
    run.check(hits == [], "no tag, collection or search word in browser storage: " + repr(hits))
    vid = page.evaluate("() => window.hqForgeHooks.openVault()")
    page.locator("#forge-vault-lock").click()
    run.check(run.until(page, "() => document.querySelector('#forge-vault-q').value === '' && !document.querySelectorAll('.forge-vault-chip').length && !document.querySelectorAll('#forge-vault-gallery .forge-card').length", 5),
              "locking wipes the search, chips and results from the page")
    status = page.evaluate("async (vid) => (await fetch('/api/forge/vaults/' + vid + '/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'lucioles' }) })).status", vid)
    run.check(status == 401, "a locked vault refuses the search: " + repr(status))
    ctx.close()


STROKE = """(args) => { const c = document.querySelector('#forge-inpaint-canvas'); const b = c.getBoundingClientRect();
  const at = (fx, fy) => ({ clientX: b.left + b.width * fx, clientY: b.top + b.height * fy, pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true });
  c.dispatchEvent(new PointerEvent('pointerdown', at(args[0], args[1])));
  for (let i = 1; i <= 8; i++) c.dispatchEvent(new PointerEvent('pointermove', at(args[0] + (args[2] - args[0]) * i / 8, args[1] + (args[3] - args[1]) * i / 8)));
  c.dispatchEvent(new PointerEvent('pointerup', at(args[2], args[3]))); }"""
INPAINT_GEO = """() => { const d = document.querySelector('#forge-inpaint'); const ids = ['forge-inpaint-undo', 'forge-inpaint-clear', 'forge-inpaint-send', 'forge-inpaint-close'];
  return { sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, dw: d.getBoundingClientRect().width,
    h: Math.min(...ids.map((id) => document.getElementById(id).getBoundingClientRect().height)),
    ta: getComputedStyle(document.querySelector('#forge-inpaint-canvas')).touchAction, cw: document.querySelector('#forge-inpaint-canvas').width }; }"""


TOPMOST = """() => { const d = document.querySelector('#forge-inpaint'); const r = d.getBoundingClientRect();
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const hit = (el) => { const b = el.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!e && el.contains(e); };
  const seen = (el) => { const b = el.getBoundingClientRect(); return b.top >= 0 && b.left >= 0 && b.bottom <= vh + 0.5 && b.right <= vw + 0.5 && b.height >= 44; };
  const corners = [[r.left + 2, r.top + 2], [r.right - 3, r.top + 2], [r.left + 2, r.bottom - 3], [r.right - 3, r.bottom - 3]]
    .map(([x, y]) => { const e = document.elementFromPoint(x, y); return !!e && d.contains(e); });
  return { inside: r.left >= 0 && r.top >= 0 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5, corners: corners.every(Boolean),
    close: hit(document.getElementById('forge-inpaint-close')) && seen(document.getElementById('forge-inpaint-close')),
    send: hit(document.getElementById('forge-inpaint-send')) && seen(document.getElementById('forge-inpaint-send')),
    stage: hit(document.getElementById('forge-inpaint-canvas')), modal: d.matches(':modal'), r: [r.left, r.top, r.width, r.height], vw, vh }; }"""
AWAY_GEO = """() => { const w = document.querySelector('.forge-vault-away'); const l = w.querySelector('label').getBoundingClientRect(); const b = w.querySelector('.forge-help').getBoundingClientRect();
  const sameRow = b.top < l.bottom && l.top < b.bottom;
  return { gap: sameRow ? b.left - l.right : b.top - l.bottom, h: b.height, w: b.width, sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth }; }"""


def check_topmost(run: Run, page, where: str) -> None:
    geo = page.evaluate(TOPMOST)
    run.check(geo["inside"] and geo["corners"] and geo["modal"],
              f"at {where} the retouch dialog is the topmost layer and fully inside the viewport: " + repr(geo))
    run.check(geo["close"] and geo["send"] and geo["stage"],
              f"at {where} Fermer, Retoucher and the canvas are visible, 44 px and not covered: " + repr(geo))


def section_inpaint(run: Run) -> None:
    print("I finger inpainting")
    ctx = run.context()
    page = ctx.new_page()
    bodies = []
    urls = []
    page.on("request", lambda r: (urls.append(r.url), bodies.append(r.post_data) if r.url.endswith("/api/forge/inpaint") and r.method == "POST" else None))
    run.open_forge(page)
    generate_once(run, page, "phare a retoucher")
    page.locator("#forge-gallery .forge-card").first.click()
    run.until(page, "() => document.querySelector('#forge-viewer').open && document.querySelector('#forge-viewer-img').naturalWidth > 0", 10)
    source = page.evaluate("() => window.hqForgeHooks.currentDetail().id")
    page.locator("#forge-viewer-inpaint").click()
    run.check(run.until(page, "() => document.querySelector('#forge-inpaint').open", 5), "Retoucher une zone opens the canvas")
    run.check(page.evaluate("() => document.querySelector('#forge-inpaint-prompt').value") == "phare a retoucher", "the prompt is prefilled from the image")
    run.check(page.evaluate("() => document.querySelector('#forge-inpaint-send').disabled"), "nothing to send before a stroke")
    geo = page.evaluate(INPAINT_GEO)
    run.check(geo["sw"] <= geo["vw"] and geo["dw"] <= geo["vw"] and geo["h"] >= 44 and geo["ta"] == "none" and geo["cw"] == 256,
              "at 375 px the canvas fits, buttons are 44 px, touch-action none, mask at natural size: " + repr(geo))
    run.check(run.until(page, "() => /^Utilise le mod\\u00e8le charg\\u00e9 dans Forge : \\S/.test(document.querySelector('#forge-inpaint-model').textContent)", 5),
              "the dialog names the model loaded in Forge: " + repr(page.evaluate("() => document.querySelector('#forge-inpaint-model').textContent")))
    check_topmost(run, page, "375 px")
    run.shot(page, "inpaint-modal")
    page.set_viewport_size({"width": 1440, "height": 900})
    page.wait_for_timeout(150)
    check_topmost(run, page, "1440 px")
    run.shot(page, "inpaint-modal")
    page.set_viewport_size({"width": 375, "height": 812})
    page.wait_for_timeout(150)
    page.evaluate(STROKE, [0.3, 0.3, 0.6, 0.6])
    run.check(not page.evaluate("() => document.querySelector('#forge-inpaint-send').disabled"), "a finger stroke enables Retoucher")
    page.locator("#forge-inpaint-undo").click()
    run.check(page.evaluate("() => document.querySelector('#forge-inpaint-send').disabled"), "Annuler removes the stroke")
    page.evaluate(STROKE, [0.2, 0.5, 0.8, 0.5])
    page.evaluate(STROKE, [0.5, 0.2, 0.5, 0.8])
    page.locator("#forge-inpaint-clear").click()
    run.check(page.evaluate("() => document.querySelector('#forge-inpaint-send').disabled"), "Effacer clears every stroke")
    box = page.locator("#forge-inpaint-canvas").bounding_box()
    page.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.4)
    page.mouse.down()
    page.mouse.move(box["x"] + box["width"] * 0.7, box["y"] + box["height"] * 0.6, steps=6)
    page.mouse.up()
    page.locator("#forge-inpaint-invert").check()
    run.check(page.evaluate("() => document.querySelector('#forge-inpaint-canvas').classList.contains('is-inverted')"), "Inverser is shown on the canvas")
    page.locator("#forge-inpaint-invert").uncheck()
    run.shot(page, "inpaint-canvas", "#forge-inpaint")
    page.locator("#forge-inpaint-send").click()
    ok = run.until(page, "(src) => document.querySelector('#forge-viewer').open && !document.querySelector('#forge-inpaint').open && window.hqForgeHooks.currentDetail() && window.hqForgeHooks.currentDetail().id !== src", 15, source)
    run.check(ok, "the result opens in the viewer")
    detail = page.evaluate("() => window.hqForgeHooks.currentDetail()")
    run.check((detail.get("origin") or {}).get("inpaint_of") == source, "the retouch is a gallery image linked to its source: " + repr(detail.get("origin")))
    sent = __import__("json").loads(bodies[0]) if bodies else {}
    mask_ok = str(sent.get("mask", "")).startswith("data:image/png;base64,") and sent.get("source") == {"kind": "normal", "id": source}
    run.check(mask_ok and sent.get("inpainting_fill") == 1 and sent.get("inpaint_full_res") is True, "one POST carries the PNG mask and options")
    run.shot(page, "inpaint-result", "#forge-viewer")
    page.locator("#forge-viewer-close").click()
    # Private: memory only, result straight into the vault.
    open_vault(run, page)
    import_private(run, page)
    page.evaluate("() => { document.getElementById('forge-vault-security-fold').open = true; }")  # panel redesign: in S\u00e9curit\u00e9
    away = page.evaluate(AWAY_GEO)
    run.check(away["gap"] >= 8 and away["h"] >= 44 and away["w"] >= 44 and away["sw"] <= away["vw"],
              "at 375 px the vault Aide keeps its gap and 44 px target: " + repr(away))
    run.shot(page, "vault-panel", "#forge-vault-open-tools")
    run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 1", 10)
    gallery_before = page.request.get(run.base + "/api/forge/gallery").text()
    jobs_before = page.request.get(run.base + "/api/forge/jobs").text()
    page.locator("#forge-vault-gallery .forge-card").first.click()
    run.until(page, "() => document.querySelector('#forge-vault-viewer').open && document.querySelector('#forge-vault-viewer-img').naturalWidth > 0", 10)
    page.locator("#forge-vault-viewer-inpaint").click()
    run.check(run.until(page, "() => document.querySelector('#forge-inpaint').open && /coffre/.test(document.querySelector('#forge-inpaint-where').textContent)", 5), "a private retouch says it goes to the vault")
    page.locator("#forge-inpaint-prompt").fill("braise secrete du coffre")
    page.evaluate(STROKE, [0.2, 0.2, 0.7, 0.7])
    run.shot(page, "inpaint-private", "#forge-inpaint")
    check_topmost(run, page, "375 px over the vault viewer")
    page.locator("#forge-inpaint-send").click()
    run.check(run.until(page, "() => document.querySelector('#forge-vault-viewer').open && !document.querySelector('#forge-inpaint').open && document.querySelectorAll('#forge-vault-gallery .forge-card').length === 2", 15),
              "the private result lands in the vault and opens there")
    run.check(page.request.get(run.base + "/api/forge/gallery").text() == gallery_before, "nothing was added to the normal gallery")
    jobs_after = page.request.get(run.base + "/api/forge/jobs").text()
    run.check(jobs_after == jobs_before and "braise" not in jobs_after, "no job or history record for the private retouch")
    run.check(not any("braise" in u for u in urls), "the private prompt never travels in a URL")
    hits = page.evaluate(STORAGE_PROBE, "braise secrete") + page.evaluate(STORAGE_PROBE, "phare a retoucher")
    run.check([h for h in hits if h != "session:hqForgeDraft"] == [], "no retouch prompt or mask in browser storage: " + repr(hits))
    page.locator("#forge-vault-viewer-inpaint").click()
    page.locator("#forge-inpaint-prompt").fill("braise secrete du coffre")
    page.evaluate("() => window.hqForgeScrubPrivate()")
    run.check(run.until(page, "() => !document.querySelector('#forge-inpaint').open && document.querySelector('#forge-inpaint-prompt').value === '' && !document.querySelector('#forge-inpaint-img').getAttribute('src')", 5),
              "locking the vault closes and wipes an open private retouch")
    ctx.close()


SECTIONS = {"night": section_night, "vault_search": section_vault_search, "inpaint": section_inpaint}
EXTRA_ENV: dict = {"night": {"HQ_FORGE_NIGHT_TICK": "0.3", "HQ_FORGE_NIGHT_HOUR": "14"}}


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