"""Accueil in a browser (phone 390 px, desktop 1440 px): the welcome header (date, greeting, status,
next-event countdown), the action row (photo, note, event, file, search), Carnet « Reprendre », Today
open, device tiles, this PC with line icons, the activity card (since yesterday, five lines then « Tout
voir »), drop a file anywhere (desktop), and a layout with no holes. Throwaway loopback HQ, fake PINs.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_home_playwright.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta
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


def until(page, js: str, arg=None, timeout: float = 8.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if page.evaluate(js, arg):
            return True
        page.wait_for_timeout(100)
    return False


def shot(page, name, browser_name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{browser_name}-home-{name}.png"), full_page=True)


def minute(dt):
    return dt.strftime("%Y-%m-%dT%H:%M")


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-home-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    soon = datetime.now() + timedelta(minutes=50)
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            for label, viewport in (("phone", {"width": 390, "height": 844}), ("desktop", {"width": 1440, "height": 900})):
                print(f"[{label}]")
                ctx = browser.new_context(viewport=viewport, bypass_csp=True)
                page = ctx.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(base + "/")
                page.fill('input[name="pin"]', info["admin_pin"])
                page.click('button[type="submit"]')
                page.wait_for_load_state("networkidle")
                if label == "phone":
                    events = [{"title": "Bientôt", "all_day": False, "category": "appointment", "start": minute(soon), "end": minute(soon + timedelta(hours=1))}]
                    events += [{"title": f"Remplissage {i}", "all_day": False, "category": "other",
                                "start": minute(soon + timedelta(days=3, hours=i)), "end": minute(soon + timedelta(days=3, hours=i, minutes=30))} for i in range(6)]
                    for ev in events:
                        r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                                              data=json.dumps({"action": "save", "expected_rev": 0, "event": ev}))
                        check(r.ok, "seed: " + ev["title"])
                    page.reload()
                    page.wait_for_load_state("networkidle")

                # Welcome header.
                check(until(page, "() => document.getElementById('home-greet').textContent.startsWith('Bon')"), "a greeting for the hour")
                date_txt = page.inner_text("#home-date")
                check(len(date_txt) > 6 and date_txt[0].isupper(), f"today's date ({date_txt})")
                check(page.evaluate("() => document.getElementById('hq-banner').style.getPropertyValue('--home-amb').startsWith('rgb(')"), "the header takes the hour's light")
                check(until(page, "() => !document.getElementById('home-next').hidden"), "the next event shows as a card")
                card = page.inner_text("#home-next")
                check("Bientôt" in card and "dans" in card, f"with a countdown ({card!r})")
                check(page.evaluate("() => { const f = document.querySelector('#home-next .hq-cal-ring .fill'); return parseFloat(f.style.strokeDashoffset) < parseFloat(f.style.strokeDasharray); }"),
                      "its ring has started to fill")
                # A critical state opens the panel by itself (README « Un état critique ouvre HQ »), so the toggle
                # is checked from whatever state it is in: one click flips it, a second puts it back.
                was_open = page.get_attribute("#hq-attention-toggle", "aria-expanded") == "true"
                page.click("#hq-attention-toggle")
                check(page.locator("#hq-attention-panel").is_visible() != was_open, "the status opens (or closes) what needs attention")
                page.click("#hq-attention-toggle")
                check(page.locator("#hq-attention-panel").is_visible() == was_open, "and a second tap puts it back")

                # Today open, Carnet « Reprendre ».
                check(page.get_attribute("#hq-today-toggle", "aria-expanded") == "true", "Today is open by default")
                check(until(page, "() => !!document.querySelector('#hq-carnet-home .carnet-home-resume')"), "Carnet offers « Reprendre »")

                # Devices, this PC.
                check(until(page, "() => document.querySelectorAll('#hq-devices .device-tile').length > 0"), "devices are small tiles")
                check(page.evaluate("() => [...document.querySelectorAll('#hq-devices .device-tile.is-off')].every((t) => getComputedStyle(t).display === 'none')"),
                      "offline devices are folded away")
                if page.locator("#home-devices-off").count():
                    page.click("#home-devices-off")
                    check(page.evaluate("() => [...document.querySelectorAll('#hq-devices .device-tile.is-off')].every((t) => getComputedStyle(t).display !== 'none')"),
                          "« n hors ligne » unfolds them")
                check(page.locator("#hq-actions .icon-btn:not([hidden]) svg").count() == 4, "this PC: four line icons (Relancer only on the Windows PC)")
                metas = page.locator("#hq-devices .device-tile:not(.is-off) .device-tile-total").all_inner_texts()
                check(any(m.startswith("sur ") and "Go" in m for m in metas), f"a device with storage gives its total ({metas})")
                check(page.evaluate("() => [...document.querySelectorAll('#hq-devices .device-tile-meta')].every((m) => m.scrollWidth <= m.clientWidth + 1)"),
                      "free and total fit without being cut")

                # Activity: five lines, then « Tout voir ».
                check(until(page, "() => document.querySelectorAll('#hq-recents > li:not(.hint)').length > 5"), "more than five recent lines")
                visible = page.evaluate("() => [...document.querySelectorAll('#hq-recents > li')].filter((li) => getComputedStyle(li).display !== 'none').length")
                check(visible == 5, f"only five show ({visible})")
                check(page.locator("#home-feed-more").is_visible(), "« Tout voir » is offered")
                page.click("#home-feed-more")
                visible = page.evaluate("() => [...document.querySelectorAll('#hq-recents > li')].filter((li) => getComputedStyle(li).display !== 'none').length")
                check(visible > 5 and page.inner_text("#home-feed-more") == "Moins", "and shows them all")
                page.click("#home-feed-more")
                check(page.evaluate("() => !!document.getElementById('hq-since').closest('.home-feed')"), "« Depuis hier » leads the activity card")

                # Layout.
                if label == "phone":
                    check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), "no sideways scroll")
                    height = page.evaluate("() => document.documentElement.scrollHeight")
                    check(height < 2300, f"shorter than before ({height} px, was about 2 400)")
                    tops = page.evaluate("""() => ['#hq-banner', '.home-actions', '#hq-carnet-home', '#hq-cal-home', '.home-devices', '.home-pc', '.home-send', '.home-feed']
                        .map((q) => document.querySelector(q).getBoundingClientRect().top)""")
                    check(tops == sorted(tops), "phone: header, actions, Carnet, Today, devices, this PC, send, activity")
                else:
                    boxes = page.evaluate("""() => Object.fromEntries(['#hq-banner', '.home-actions', '.home-col-main', '.home-col-side']
                        .map((q) => { const r = document.querySelector(q).getBoundingClientRect(); return [q, [r.left, r.top, r.width]]; }))""")
                    hero, acts, main_col, side_col = boxes["#hq-banner"], boxes[".home-actions"], boxes[".home-col-main"], boxes[".home-col-side"]
                    check(hero[1] < acts[1] < main_col[1], "desktop: header, then actions, then the columns")
                    check(abs(main_col[1] - side_col[1]) < 2 and main_col[0] < side_col[0], "two columns side by side")
                    check(abs(hero[2] - acts[2]) < 2 and hero[2] > main_col[2] + side_col[2], "header and actions span both columns")
                check(page.evaluate("() => { const f = document.getElementById('hq-capture-fab'); return !f || getComputedStyle(f).display === 'none'; }"),
                      "no floating capture button over Accueil")
                shot(page, label, browser_name)

                # The cards arrive one after another when Accueil opens.
                page.evaluate("() => setView('carnet')")
                page.evaluate("() => setView('accueil')")
                check(page.evaluate("() => document.querySelector('.home-v2').classList.contains('is-entering') && getComputedStyle(document.querySelector('.home-actions')).animationName === 'home-in'"),
                      "opening Accueil brings the cards in one after another")
                page.wait_for_timeout(1200)

                # Pull down to refresh (touch; Chromium builds the events).
                if page.evaluate("() => { try { return !!new Touch({ identifier: 1, target: document.body }); } catch (_) { return false; } }"):
                    page.evaluate("() => window.scrollTo(0, 0)")
                    page.evaluate("""() => { window.__ptr = []; const el = document.querySelector('.home-hero'), x = 150, y = 200;
                        const t = (yy) => new Touch({ identifier: 9, target: el, clientX: x, clientY: yy });
                        el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t(y)], targetTouches: [t(y)], changedTouches: [t(y)] }));
                        for (const d of [12, 50, 100, 160, 200]) el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [t(y + d)], targetTouches: [t(y + d)], changedTouches: [t(y + d)] }));
                        window.__ptr.push(document.querySelector('.home-ptr').classList.contains('is-armed'));
                        el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t(y + 200)] }));
                        window.__ptr.push(document.querySelector('.home-ptr').classList.contains('is-spinning')); }""")
                    check(page.evaluate("() => window.__ptr[0] && window.__ptr[1]"), "pulling down at the top arms, then refreshes")
                    check(until(page, "() => !document.querySelector('.home-ptr').classList.contains('is-spinning')"), "and settles when everything is fresh")
                    check(page.locator("#hq-devices .device-tile").count() > 0, "with the cards still there")

                # Drop a file anywhere (desktop): the page becomes the drop zone, the file arrives.
                if label == "desktop":
                    page.evaluate("""() => { const dt = new DataTransfer(); dt.items.add(new File(['bonjour'], 'depose.txt', { type: 'text/plain' }));
                        window.__dt = dt; window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true })); }""")
                    check(page.evaluate("() => document.getElementById('drop-zone').classList.contains('is-active')"), "dragging a file over Accueil shows the drop zone")
                    shot(page, "drop", browser_name)
                    page.evaluate("""() => { const z = document.getElementById('drop-zone');
                        z.dispatchEvent(new DragEvent('dragover', { dataTransfer: window.__dt, bubbles: true, cancelable: true }));
                        z.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dt, bubbles: true, cancelable: true })); }""")
                    check(until(page, "() => !document.getElementById('drop-zone').classList.contains('is-active')"), "dropping hides it")
                    found = False
                    for _ in range(40):
                        found = any(f.name.startswith("depose") for f in root.rglob("depose*"))
                        if found:
                            break
                        page.wait_for_timeout(150)
                    check(found, "and the file is uploaded")

                # Actions.
                with page.expect_file_chooser() as chooser:
                    page.click("#home-act-file")
                check(chooser.value.is_multiple(), "Fichier opens the file picker")
                with page.expect_file_chooser() as chooser:
                    page.click("#btn-camera")
                check(not chooser.value.is_multiple(), "Photo opens the camera picker")
                check(until(page, "() => !document.getElementById('home-act-note').hidden"), "Note shows for the owner")
                page.click("#home-act-note")
                check(until(page, "() => { const b = document.getElementById('hq-capture'); return b && !b.hidden; }"), "Note opens the quick capture")
                page.keyboard.press("Escape")
                until(page, "() => { const b = document.getElementById('hq-capture'); return !b || b.hidden; }")
                page.click("#btn-palette")
                check(until(page, "() => !document.getElementById('hq-palette').hidden"), "Recherche opens the search")
                page.keyboard.press("Escape")
                page.click("#home-act-event")
                check(page.evaluate("() => document.body.dataset.view") == "calendrier", "Événement opens the calendar")
                check(page.evaluate("() => document.activeElement && document.activeElement.id === 'hq-cal-quick-input'"), "with the quick add ready to type")
                page.click('.bottom-nav [data-nav="accueil"]') if page.locator('.bottom-nav [data-nav="accueil"]').is_visible() else page.evaluate("() => setView('accueil')")
                until(page, "() => !document.getElementById('home-next').hidden")
                page.click("#home-next")
                check(until(page, "() => document.body.dataset.view === 'calendrier' && !!document.querySelector('.hq-cal-day')"), "the next-event card opens its day in the calendar")

                # « Modifier l'accueil » (desktop): hide, reorder, switch column; saved on HQ, back after a reload.
                if label == "desktop":
                    page.evaluate("() => setView('accueil')")
                    check(until(page, "() => !document.getElementById('home-edit-row').hidden"), "« Modifier l'accueil » is offered to the owner")
                    page.click("#home-edit")
                    check(page.locator(".home-edit-bar").count() == 6, "each card gets its controls")
                    page.evaluate("() => window.hqCarnetHome()")  # the Carnet summary redraws itself
                    check(until(page, "() => !!document.querySelector('#hq-carnet-home > .home-edit-bar')"), "the Carnet card keeps its controls when it redraws")
                    page.wait_for_timeout(1300)  # let the cards finish arriving
                    shot(page, "edit", browser_name)
                    page.locator('.home-send .home-edit-bar [data-edit="hide"]').click()
                    page.locator('#hq-cal-home .home-edit-bar [data-edit="up"]').click()
                    page.locator('.home-devices .home-edit-bar [data-edit="side"]').click()
                    def server_layout():
                        return page.request.get(base + "/api/home-layout").json()["layout"]
                    lay = None
                    for _ in range(30):
                        lay = server_layout()
                        if "send" in lay["hidden"] and lay["order"].index("today") < lay["order"].index("carnet") and "devices" not in lay["side"]:
                            break
                        page.wait_for_timeout(150)
                    check("send" in lay["hidden"], f"hiding a card is saved on HQ ({lay})")
                    check(lay["order"].index("today") < lay["order"].index("carnet"), "moving a card up is saved")
                    check("devices" not in lay["side"], "moving a card to the other column is saved")
                    check(page.evaluate("() => !!document.querySelector('.home-col-main .home-devices')"), "and it moves there at once")
                    page.click("#home-edit")
                    check(page.evaluate("() => getComputedStyle(document.querySelector('.home-send')).display === 'none'"), "the hidden card is gone once done")
                    page.reload()
                    page.wait_for_load_state("networkidle")
                    check(until(page, "() => getComputedStyle(document.querySelector('.home-send')).display === 'none' && !!document.querySelector('.home-col-main .home-devices')"),
                          "after a reload (any device) the arrangement is the same")
                    tops = page.evaluate("() => ['#hq-cal-home', '#hq-carnet-home'].map((q) => document.querySelector(q).getBoundingClientRect().top)")
                    check(tops[0] < tops[1], "Today now comes before Carnet")
                    page.click("#home-edit")
                    page.locator('[data-edit="reset"]').click()
                    for _ in range(30):
                        if server_layout()["hidden"] == []:
                            break
                        page.wait_for_timeout(150)
                    check(server_layout()["order"][0] == "carnet" and server_layout()["hidden"] == [], "« Par défaut » puts everything back")
                    page.keyboard.press("Escape")
                    check(not page.evaluate("() => document.querySelector('.home-v2').classList.contains('is-editing')"), "Échap closes the editing")
                check(not errors, f"no page errors {errors[:3]}")
                ctx.close()
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
