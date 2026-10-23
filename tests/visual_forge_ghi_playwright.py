"""Forge Studio phases G and H: night workshop, searchable vault. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault. Same harness as quick wins.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_ghi_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import Run, generate_once, start_server, STORAGE_PROBE


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


SECTIONS = {"night": section_night}
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