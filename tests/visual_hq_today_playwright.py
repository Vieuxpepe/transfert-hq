"""Accueil 'Aujourd'hui' > 'Depuis hier' in a browser: the list under today's calendar, counts only,
private Forge jobs left out, taps open the matching view. Throwaway loopback HQ, fake PINs.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_today_playwright.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PROD_PORTS = (":8765", ":8766", ":8776", ":7860")
SHOTS = Path(os.environ["HQ_SHOTS"]) if os.environ.get("HQ_SHOTS") else None
passed = 0


def check(cond: bool, message: str) -> None:
    global passed
    if not cond:
        raise SystemExit("FAIL: " + message)
    passed += 1
    print("  OK  ", message)


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-today-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    # Seed after start (the server wants an empty root): two Inbox files, one normal and one private job.
    (root / "Inbox" / "photo-secrete.jpg").write_bytes(b"x")
    (root / "Inbox" / "Captures").mkdir(exist_ok=True)
    (root / "Inbox" / "Captures" / "capture.png").write_bytes(b"x")
    (root / ".hq-forge").mkdir(exist_ok=True)
    (root / ".hq-forge" / "jobs.json").write_text(json.dumps({"idempotency": {}, "jobs": [
        {"id": "fj-1", "state": "completed", "destination": "normal", "updated": iso_now(), "images": [{"id": "a"}, {"id": "b"}], "settings": {"prompt": "renard roux"}},
        {"id": "fj-2", "state": "completed", "destination": "private", "updated": iso_now(), "images": [{"id": "c"}, {"id": "d"}, {"id": "e"}]},
    ]}), encoding="utf-8")
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
            check(page.get_attribute("#hq-today-toggle", "aria-expanded") == "true", "Today is open by default")
            page.wait_for_function("() => !document.getElementById('hq-since').hidden", timeout=10000)
            check(page.locator("#hq-cal-today").is_visible(), "today's calendar shows in its own card")
            check(page.evaluate("() => !!document.getElementById('hq-since').closest('.home-feed')"), "« Depuis hier » leads the activity card")
            texts = page.locator(".hq-since-text").all_inner_texts()
            check("2 fichiers arrivés dans Inbox" in texts, f"Inbox arrivals are counted {texts}")
            check("Forge : 2 images terminées" in texts, "normal Forge images are counted; the private job is left out")
            html = page.content()
            check("photo-secrete" not in html and "renard roux" not in html, "no file name or prompt in the page")
            times = page.locator(".hq-since-time").all_inner_texts()
            check(all(len(t) >= 5 for t in times), f"each line has a time {times}")
            heights = page.evaluate("() => [...document.querySelectorAll('.hq-since-item')].map((li) => li.getBoundingClientRect().height)")
            check(min(heights) >= 44, f"rows are 44 px touch targets {heights}")
            if SHOTS:
                SHOTS.mkdir(parents=True, exist_ok=True)
                page.locator(".home-feed").screenshot(path=str(SHOTS / f"{browser_name}-today-375.png"))
            page.locator(".hq-since-open", has_text="Forge").click()
            check(page.evaluate("document.body.dataset.view") == "forge", "tapping the Forge line opens Forge")
            page.click('.bottom-nav [data-nav="accueil"]')
            page.locator(".hq-since-open", has_text="Inbox").click()
            check(page.evaluate("document.body.dataset.view") == "fichiers", "tapping the Inbox line opens Fichiers")
            page.click('.bottom-nav [data-nav="accueil"]')
            page.click("#hq-today-toggle")
            check(page.locator("#hq-today-panel").is_hidden(), "Today still folds on a tap")
            page.click('.bottom-nav [data-nav="carnet"]')
            page.click('.bottom-nav [data-nav="accueil"]')
            check(page.locator("#hq-today-panel").is_hidden(), "and stays folded once the owner folded it")
            page.click("#hq-today-toggle")
            check(not errors, f"no page errors {errors[:3]}")
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
