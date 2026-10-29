"""Global search in the Ctrl+K palette: Carnet, Forge, Calendrier and Fichiers groups appear under the
catalog; each result opens where it belongs; content results never reach browser storage.
Throwaway loopback HQ, fake PINs.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_search_playwright.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PROD_PORTS = (":8765", ":8766", ":8776", ":7860")
SHOTS = Path(os.environ["HQ_SHOTS"]) if os.environ.get("HQ_SHOTS") else None
IMG = "img-" + "b" * 24
passed = 0


def check(cond: bool, message: str) -> None:
    global passed
    if not cond:
        raise SystemExit("FAIL: " + message)
    passed += 1
    print("  OK  ", message)


def until(page, js: str, arg=None, timeout: float = 8.0) -> bool:
    """Poll with page.evaluate (WebKit refuses wait_for_function's string eval under HQ's CSP)."""
    import time
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if page.evaluate(js, arg):
            return True
        page.wait_for_timeout(100)
    return False


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-search-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    (root / "Inbox" / "Factures").mkdir(parents=True, exist_ok=True)
    (root / "Inbox" / "Factures" / "facture-electricite.pdf").write_bytes(b"%PDF")
    folder = root / ".hq-forge" / "gallery" / IMG
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "meta.json").write_text(json.dumps({"id": IMG, "created": "2026-10-20T10:00:00Z", "width": 64, "height": 64,
                                                  "settings": {"prompt": "un renard roux dans la neige"}}), encoding="utf-8")
    day = (date.today() + timedelta(days=5)).isoformat()
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            ctx = browser.new_context(viewport={"width": 375, "height": 812}, bypass_csp=True)
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + "/")
            page.fill('input[name="pin"]', info["admin_pin"])
            page.click('button[type="submit"]')
            page.wait_for_load_state("networkidle")
            headers = {"origin": base, "content-type": "application/json"}
            r = page.request.post(base + "/api/calendar", headers=headers, data=json.dumps({"action": "save", "expected_rev": 0, "event": {
                "title": "Dentiste Martin", "all_day": True, "category": "other", "start": day,
                "end": (date.today() + timedelta(days=6)).isoformat()}}))
            check(r.ok, "a synthetic calendar event is saved")
            rev = page.request.get(base + "/api/carnet").json()["notebook_rev"]
            created = page.request.post(base + "/api/carnet", headers=headers, data=json.dumps({"action": "page_create", "expected_notebook_rev": rev})).json()["page"]
            saved = page.request.post(base + "/api/carnet", headers=headers, data=json.dumps({"action": "page_save", "id": created["id"], "expected_rev": created["rev"],
                "content": {"version": 2, "blocks": [{"type": "paragraph", "text": "Plan du potager", "marks": []},
                                                     {"type": "paragraph", "text": "semer les tomates en avril", "marks": []}]}}))
            check(saved.ok, "a synthetic Carnet page is saved")
            word, page_id = "tomates", created["id"]

            def search(q: str):
                if page.locator("#hq-palette").is_hidden():
                    view = page.evaluate("document.body.dataset.view")
                    size = page.evaluate("() => { const r = document.getElementById('btn-search-bar').getBoundingClientRect(); return Math.min(r.width, r.height); }")
                    check(page.locator("#btn-search-bar").is_visible() and size >= 44, f"the header search button is there on {view} ({size} px)")
                    page.click("#btn-search-bar")
                page.fill("#hq-palette-input", q)
                until(page, "(q) => { const e = document.querySelector('#hq-palette-list'); return !!e && (!!e.querySelector('li') || e.textContent.includes(q)); }", q)
                page.wait_for_timeout(400)  # the 120 ms debounce, then the answer
                return page.evaluate("() => [...document.querySelectorAll('#hq-palette-list .palette-group')].map((g) => ({ label: g.querySelector('.palette-group-label').textContent, items: [...g.querySelectorAll('.palette-label')].map((n) => n.textContent) }))")

            groups = search("facture")
            check({"label": "Fichiers", "items": ["facture-electricite.pdf"]} in groups, f"Inbox file names are found {groups}")
            if SHOTS:
                SHOTS.mkdir(parents=True, exist_ok=True)
                page.locator(".palette-card").screenshot(path=str(SHOTS / f"{browser_name}-search-files-375.png"))
            page.locator("#hq-palette-list li", has_text="facture-electricite.pdf").click()
            check(page.evaluate("document.body.dataset.view") == "fichiers", "a file opens Fichiers")

            groups = search("renard")
            check({"label": "Forge", "items": ["un renard roux dans la neige"]} in groups, "Forge prompts are found")
            page.locator("#hq-palette-list li", has_text="renard").click()
            check(page.evaluate("document.body.dataset.view") == "forge", "a prompt opens Forge")
            check(until(page, "() => !!document.getElementById('forge-viewer') && document.getElementById('forge-viewer').open"), "and shows that image in the viewer")
            page.keyboard.press("Escape")

            groups = search("dentiste")
            check(any(g["label"] == "Calendrier" and "Dentiste Martin" in g["items"] for g in groups), "calendar titles are found")
            page.locator("#hq-palette-list li", has_text="Dentiste Martin").click()
            check(page.evaluate("document.body.dataset.view") == "calendrier", "an event opens the calendar")

            if word:
                groups = search(word)
                check(any(g["label"] == "Carnet" for g in groups), f"Carnet pages are found ({word})")
                page.locator("#hq-palette-list .palette-group", has_text="Carnet").locator("li").first.click()
                check(until(page, "() => document.body.dataset.view === 'carnet'"), "a page opens the Carnet")
            else:
                print("  --   the throwaway Carnet has no page to search; covered by the Python tests")

            stored = page.evaluate("() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage))")
            check(all(s not in stored for s in ("facture-electricite", "renard", "Dentiste")), "no file name, prompt or event title in browser storage")
            check(not errors, f"no page errors {errors[:3]}")
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
