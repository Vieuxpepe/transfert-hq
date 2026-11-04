"""Transferania alive, in a browser (desktop 1440 px + phone 390 px), Gemini faked by intercepting /api/ai:
a true event from the pulse is spoken first, word by word; clicking around fast keeps her quiet; the face has two
eyes that blink and glance towards the cursor; the day's mood sets the breath; Voix toggles; no page errors.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_companion_life_playwright.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PROD_PORTS = (":8765", ":8766", ":8776", ":7860")
SHOTS = Path(os.environ["HQ_SHOTS"]) if os.environ.get("HQ_SHOTS") else None
LINE = "Backup fini, tout est au chaud. Tu peux souffler un peu, toi aussi."
passed = 0


def check(cond: bool, message: str) -> None:
    global passed
    if not cond:
        raise SystemExit("FAIL: " + message)
    passed += 1
    print("  OK  ", message)


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-life-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            for label, viewport in (("desktop", {"width": 1440, "height": 900}), ("phone", {"width": 390, "height": 844})):
                print(f"[{label}]")
                ctx = browser.new_context(viewport=viewport, bypass_csp=True)
                ctx.add_init_script("try{localStorage.setItem('hq_companion_collapsed','0');localStorage.setItem('hq_companion_persona','warm')}catch(e){}")
                # Network-idle may arrive after typing finishes. Observe an
                # actual partial DOM message when it occurs, rather than
                # assuming the later assertion happens inside that interval.
                ctx.add_init_script("(() => { const expected = " + json.dumps(LINE) + "; "
                    "const observer = new MutationObserver(() => { const value = document.querySelector('.hq-companion-line')?.textContent || ''; "
                    "if (value.length > 0 && value.length < expected.length && expected.startsWith(value)) { "
                    "window.__hqLifePartialLength = value.length; observer.disconnect(); } }); "
                    "observer.observe(document, {subtree:true, childList:true, characterData:true}); })();")
                page = ctx.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                seen: list[dict] = []
                pulses = [0]

                def handle(route, request):
                    if request.method == "GET":
                        return route.fulfill(json={"ok": True, "configured": True, "companion_cap": "flirt", "nsfw_allowed": False,
                                                   "personality": {}, "models": [], "ambient": {"used": 0, "per_day": 48}})
                    body = json.loads(request.post_data or "{}")
                    seen.append(body)
                    a = body.get("action")
                    if a == "pulse":
                        pulses[0] += 1
                        ev = {"id": "act:1", "kind": "backup_done", "text": "Le backup complet de HQ vient de se terminer."} if pulses[0] == 1 else None
                        return route.fulfill(json={"ok": True, "event": ev, "mood": {"soft": 0.9, "warm": 0.2}})
                    if a == "ambient":
                        return route.fulfill(json={"ok": True, "line": LINE, "event_id": body.get("event_id"), "mood": {"soft": 0.9, "warm": 0.2}})
                    return route.fulfill(json={"ok": True, "messages": [], "prefs": {}})
                page.route("**/api/ai**", handle)
                page.goto(base + "/")
                page.fill('input[name="pin"]', info["admin_pin"])
                page.click('button[type="submit"]')
                page.wait_for_load_state("networkidle")

                page.wait_for_selector("#hq-companion .hq-companion-face", timeout=8000)
                check(page.locator("#hq-companion .hq-companion-eye").count() == 2, "the orb has a face with two eyes")
                page.wait_for_function("() => [...document.querySelectorAll('#hq-companion .hq-companion-line')].some(l => l.textContent.length > 0)", timeout=10000)
                amb = [b for b in seen if b.get("action") == "ambient"]
                check(len(amb) >= 1 and amb[0].get("event_id") == "act:1", "the first thing she says is the true event (sent by id)")
                check([b.get("action") for b in seen].index("pulse") < [b.get("action") for b in seen].index("ambient"), "pulse first (no model), then the line")
                partial_length = page.evaluate("window.__hqLifePartialLength || 0")
                check(0 < partial_length < len(LINE), f"the line arrives word by word ({partial_length}/{len(LINE)} chars observed)")
                page.wait_for_function(f"() => document.querySelector('#hq-companion .hq-companion-line').textContent === {json.dumps(LINE)}", timeout=10000)
                check(True, "and finishes whole")
                check(page.evaluate("() => getComputedStyle(document.getElementById('hq-companion')).getPropertyValue('--breath').trim()") == "6.36s",
                      "a soft mood slows the breath")
                check(page.evaluate("() => document.getElementById('hq-companion').classList.contains('is-soft')"), "and softens the eyes")
                check(page.evaluate("""() => new Promise(r => { const el = document.getElementById('hq-companion');
                    const mo = new MutationObserver(() => { if (el.classList.contains('is-blink')) { mo.disconnect(); r(true); } });
                    mo.observe(el, {attributes: true}); setTimeout(() => r(false), 9000); })"""), "she blinks on her own")

                if label == "desktop":
                    box = page.locator("#hq-companion .hq-companion-avatar").bounding_box()
                    page.mouse.move(box["x"] - 600, box["y"] + box["height"] / 2)
                    page.wait_for_timeout(250)
                    gx = page.evaluate("() => parseFloat(document.querySelector('#hq-companion .hq-companion-face').style.getPropertyValue('--gx'))")
                    check(gx < -1.5, f"her eyes glance towards the cursor (--gx {gx}px)")

                # Clicking around fast: no new line.
                n0 = len([b for b in seen if b.get("action") == "ambient"])
                for v in ("carnet", "calendrier", "fichiers", "projets", "accueil"):
                    page.evaluate("v => window.setView ? setView(v) : (document.body.dataset.view = v)", v)
                    page.wait_for_timeout(400)
                page.wait_for_timeout(8500)
                n1 = len([b for b in seen if b.get("action") == "ambient"])
                check(n1 == n0, "clicking around fast keeps her quiet")

                vb = page.locator("#hq-companion .hq-companion-voice")
                if vb.is_visible():
                    vb.click()
                    check(vb.get_attribute("aria-pressed") == "true", "Voix turns on")
                    vb.click()
                    check(vb.get_attribute("aria-pressed") == "false", "and off")
                check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), "no sideways scroll")
                if SHOTS:
                    SHOTS.mkdir(parents=True, exist_ok=True)
                    page.locator("#hq-companion").screenshot(path=str(SHOTS / f"{browser_name}-life-{label}.png"))
                check(errors == [], f"no page errors {errors}")
                ctx.close()
            browser.close()
    finally:
        proc.terminate()
    print(f"visual_hq_companion_life: {passed} checks ok")


if __name__ == "__main__":
    main()
