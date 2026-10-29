"""Calendar delight in a browser: the swipe follows the finger (and springs back or on), pinch and
Ctrl + wheel change the hour height, quick add draws its event in the grid while typing, recent titles
are one tap, every change has Annuler (delete has no confirm), agenda rows swipe away, the next-up
card counts down, finished events tick off (burst, day ring), the light follows the hour, Sons is a
toggle, and an idle calendar never rebuilds itself. Throwaway loopback HQ, fake PINs.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_calendar_delight_playwright.py
"""

from __future__ import annotations

import json
import re
import os
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timedelta
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
        page.screenshot(path=str(SHOTS / f"{browser_name}-delight-{name}.png"))


def save(page, base, ev):
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0, "event": ev}))
    return r.json().get("event") if r.ok else None


def events_on(page, base, day):
    data = page.request.get(f"{base}/api/calendar?from={day.isoformat()}&to={(day + timedelta(days=1)).isoformat()}").json()
    return {item["title"]: item for item in data.get("items") or []}


def server_until(page, base, day, title, ok, tries=40):
    item = None
    for _ in range(tries):
        item = events_on(page, base, day).get(title)
        if ok(item):
            return True, item
        page.wait_for_timeout(150)
    return False, item


AGENDA_ROWS = "() => [document.querySelector('.hq-cal-title').textContent, ...[...document.querySelectorAll('.hq-cal-row')].map((r) => r.innerText.slice(0, 30))]"


def minute(dt):
    return dt.strftime("%Y-%m-%dT%H:%M")


def strip_day(page):
    return page.evaluate("() => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day")


def touch(page, kind, x, y, pid=11, target=None):
    page.evaluate("""([kind, x, y, pid, sel]) => {
        const el = sel ? document.querySelector(sel) : document.elementFromPoint(x, y);
        const ev = new PointerEvent(kind, { bubbles: true, pointerType: 'touch', pointerId: pid, clientX: x, clientY: y, isPrimary: pid === 11 });
        (kind === 'pointerdown' ? el : window).dispatchEvent(ev); }""", [kind, x, y, pid, target])


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-caldelight-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    today = date.today()
    now = datetime.now()
    timed_today = 3 <= now.hour <= 21  # room for an event that ended and one that starts soon, both today
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            ctx = browser.new_context(viewport={"width": 375, "height": 812}, bypass_csp=True, has_touch=True)
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(base + "/")
            page.fill('input[name="pin"]', info["admin_pin"])
            page.click('button[type="submit"]')
            page.wait_for_load_state("networkidle")
            if timed_today:
                done_ev = save(page, base, {"title": "Fini tôt", "all_day": False, "category": "study",
                                            "start": minute(now - timedelta(hours=3)), "end": minute(now - timedelta(hours=2))})
                soon_ev = save(page, base, {"title": "Bientôt", "all_day": False, "category": "appointment",
                                            "start": minute(now + timedelta(minutes=40)), "end": minute(now + timedelta(minutes=100))})
                check(bool(done_ev and soon_ev), "seed events saved")
            save(page, base, {"title": "Agenda à glisser", "all_day": True, "category": "personal",
                              "start": (today + timedelta(days=3)).isoformat(), "end": (today + timedelta(days=4)).isoformat()})
            page.click('.bottom-nav [data-nav="calendrier"]')
            check(until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')"), "the calendar renders")
            page.locator('#hq-cal-app [data-view="day"]').click()
            until(page, "() => !!document.querySelector('.hq-cal-day')")
            if page.locator(".hq-cal-today").count():
                page.locator(".hq-cal-today").click()
            until(page, "() => !document.querySelector('.hq-cal-today')")
            page.wait_for_timeout(500)

            # Idle: nothing rebuilds by itself.
            page.evaluate("""() => { window.__muts = 0; new MutationObserver((m) => { window.__muts += m.filter((r) => r.target.id === 'hq-cal-app').length; })
                .observe(document.getElementById('hq-cal-app'), { childList: true }); }""")
            page.wait_for_timeout(2500)
            check(page.evaluate("() => window.__muts") == 0, "an idle calendar never rebuilds itself")

            # Now line pill and ambient light.
            pill = page.evaluate("() => { const t = document.querySelector('.hq-cal-now-time'); return t ? t.textContent : ''; }")
            check(re.fullmatch(r"\d{2}\s?(:|h)\s?\d{2}", pill) is not None, f"the now line shows the time ({pill})")
            amb = page.evaluate("() => { const s = document.querySelector('.hq-cal'); return [s.classList.contains('hq-cal-ambient'), s.style.getPropertyValue('--hq-amb')]; }")
            check(amb[0] and amb[1].startswith("rgb("), f"the calendar's light follows the hour {amb}")

            if timed_today:
                # Next-up card with a ring.
                card = page.locator("#hq-cal-nextup")
                check(card.count() == 1 and "Bientôt" in card.inner_text(), "the next-up card names the next event")
                when = page.locator(".hq-cal-nextup-when").inner_text()
                check(when.startswith("dans ") and "min" in when, f"it counts down ({when})")
                check(until(page, "() => { const f = document.querySelector('.hq-cal-ring .fill'); return f && parseFloat(f.style.strokeDashoffset) < parseFloat(f.style.strokeDasharray); }"),
                      "its ring has started to fill")
                shot(page, "nextup", browser_name)
                # Tick off the finished event.
                ev = page.locator(".hq-cal-day .hq-cal-event", has_text="Fini tôt")
                check(ev.locator(".hq-cal-check").count() == 1, "a finished event has a check")
                check(page.locator(".hq-cal-day .hq-cal-event", has_text="Bientôt").locator(".hq-cal-check").count() == 0, "an event still to come does not")
                ev.locator(".hq-cal-check").click()
                check(until(page, "() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event.is-done')].some((e) => e.innerText.includes('Fini tôt'))"), "ticking it marks it done")
                ok, item = server_until(page, base, today, "Fini tôt", lambda e: bool(e and e.get("done")))
                check(ok, "done is saved on the server")
                check(until(page, "() => { const b = document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]'); return b.classList.contains('has-ring') && b.classList.contains('is-complete'); }"),
                      "the day's ring fills once everything finished is done")
                check(page.locator(".hq-cal-day .hq-cal-event", has_text="Fini tôt").locator(".hq-cal-check").count() == 1, "the check stays to undo it")
                ring = page.evaluate("""() => { const b = document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]');
                    return [getComputedStyle(b, '::after').backgroundColor, getComputedStyle(document.querySelector('.hq-cal-weekstrip'), '::before').backgroundColor]; }""")
                check(ring[0] != ring[1], f"the full ring stands out on the selected day {ring}")
                shot(page, "done", browser_name)
                page.locator(".hq-cal-day .hq-cal-event", has_text="Fini tôt").locator(".hq-cal-check").click()
                ok, _ = server_until(page, base, today, "Fini tôt", lambda e: bool(e) and not e.get("done"))
                check(ok, "ticking again takes it back")

            # Quick add: live preview in the grid, then it lands; Annuler takes it back.
            quick = page.locator("#hq-cal-quick-input")
            quick.fill("Aperçu vivant 15h")
            check(until(page, "() => !!document.querySelector('.hq-cal-day .hq-cal-ghost.is-preview')"), "typing draws the event see-through in its slot")
            top1 = page.evaluate("() => parseFloat(document.querySelector('.hq-cal-ghost.is-preview').style.top)")
            check(abs(top1 - 15 / 24 * 100) < 0.2, f"at 15:00 ({top1:.2f}%)")
            quick.fill("Aperçu vivant 17h30 pendant 2h")
            top2 = page.evaluate("() => parseFloat(document.querySelector('.hq-cal-ghost.is-preview').style.top)")
            h2 = page.evaluate("() => parseFloat(document.querySelector('.hq-cal-ghost.is-preview').style.height)")
            check(abs(top2 - 17.5 / 24 * 100) < 0.2 and abs(h2 - 2 / 24 * 100) < 0.2, "it moves and stretches as the words change")
            check(page.evaluate("() => document.querySelectorAll('.hq-cal-ghost.is-preview').length") == 1, "one preview, moved (not redrawn)")
            check(until(page, """() => { const g = document.querySelector('.hq-cal-ghost.is-preview').getBoundingClientRect(), s = document.querySelector('.hq-cal-scroll').getBoundingClientRect();
                return g.top >= s.top - 1 && g.top < s.bottom - 20; }"""), "the grid scrolls the preview into view")
            shot(page, "preview", browser_name)
            quick.press("Enter")
            check(until(page, "() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((e) => e.innerText.includes('Aperçu vivant'))"), "Entrée: the saved event lands there")
            check(until(page, "() => !document.querySelector('.hq-cal-ghost.is-preview')"), "and the preview is gone")
            check(until(page, "() => !document.getElementById('hq-cal-undo').hidden"), "Annuler is offered")
            shot(page, "undo", browser_name)
            page.locator("#hq-cal-undo .hq-cal-undo-btn").click()
            ok, _ = server_until(page, base, today, "Aperçu vivant", lambda e: e is None)
            check(ok, "Annuler removes the new event")
            check(until(page, "() => ![...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((e) => e.innerText.includes('Aperçu vivant'))"), "and the grid follows")

            # Recent titles: one tap writes the title and its usual time.
            check(until(page, "() => !document.getElementById('hq-cal-quick-recent').hidden && document.querySelectorAll('.hq-cal-recent-chip').length > 0"),
                  "recent titles sit under the empty field")
            check(page.locator(".hq-cal-recent-chip", has_text="Aperçu vivant").count() == 0, "an event taken back with Annuler is not among them")
            chip = page.locator(".hq-cal-recent-chip", has_text="Bientôt") if timed_today else page.locator(".hq-cal-recent-chip").first
            want = chip.get_attribute("data-quick")
            chip.click()
            val = quick.input_value()
            check(val == want and (not timed_today or (val.startswith("Bientôt ") and "h" in val and "pendant" not in val)),
                  f"a tap writes the title, its usual time and length ({val!r})")
            check(until(page, "() => !!document.querySelector('.hq-cal-ghost.is-preview') || !!document.querySelector('.hq-cal-chip.is-preview')"), "and its preview appears")
            check(page.locator("#hq-cal-quick-recent").is_hidden(), "the chips step aside while typing")
            quick.fill("")

            # Delete without a confirm; Annuler brings it back.
            if timed_today:
                page.on("dialog", lambda d: errors.append("unexpected dialog: " + d.message))
                page.locator(".hq-cal-day .hq-cal-event", has_text="Bientôt").click()
                page.locator('.hq-sheet-card [data-sheet="delete"]').click()
                ok, _ = server_until(page, base, today, "Bientôt", lambda e: e is None)
                check(ok, "Supprimer deletes at once (no confirm)")
                check(until(page, "() => document.querySelector('.hq-cal-undo-text').textContent.startsWith('Supprimé')"), "with Annuler")
                page.locator("#hq-cal-undo .hq-cal-undo-btn").click()
                ok, _ = server_until(page, base, today, "Bientôt", lambda e: e is not None)
                check(ok, "Annuler brings it back")

            # The swipe follows the finger: a short pull springs back, a long one goes on.
            page.evaluate("() => document.querySelector('.hq-cal-scroll').scrollTop = 300")
            day0 = strip_day(page)
            box = None
            for _ in range(30):  # the visible hours (wait out a refresh that is rebuilding them)
                box = page.locator(".hq-cal-stage .hq-cal-scroll").bounding_box()
                if box:
                    break
                page.wait_for_timeout(100)
            y = box["y"] + min(160, box["height"] / 2)
            x0 = box["x"] + box["width"] - 40
            touch(page, "pointerdown", x0, y)
            for dx in (12, 30, 50, 70):
                touch(page, "pointermove", x0 - dx, y)
                page.wait_for_timeout(40)
            tx = page.evaluate("() => getComputedStyle(document.querySelector('.hq-cal-stage')).transform")
            check(tx not in ("none", "") and tx.startswith("matrix"), f"the day follows the finger ({tx})")
            check(page.evaluate("() => { const p = document.querySelector('.hq-cal-peek.is-next'); return p && parseFloat(p.style.opacity) > 0.5 && p.innerText.length > 3; }"),
                  "the next day is named at the edge")
            shot(page, "swipe", browser_name)
            page.wait_for_timeout(120)
            touch(page, "pointerup", x0 - 70, y)
            page.wait_for_timeout(700)
            check(strip_day(page) == day0 and page.evaluate("() => getComputedStyle(document.querySelector('.hq-cal-stage')).transform") in ("none", "matrix(1, 0, 0, 1, 0, 0)"),
                  "a short, slow pull springs back")
            check(page.locator(".hq-cal-peek").count() == 0, "and the edge label goes away")
            touch(page, "pointerdown", x0, y)
            for dx in (12, 60, 120, 180, 240):
                touch(page, "pointermove", x0 - dx, y)
                page.wait_for_timeout(30)
            touch(page, "pointerup", x0 - 240, y)
            check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day !== d", day0), "a long pull goes to the next day")
            check(not page.evaluate("() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)"), "and opens nothing")
            # A flick: short but fast.
            day1 = strip_day(page)
            page.evaluate("""([x, y]) => {  // one burst: a fast finger
                const fire = (kind, dx, el) => (el || window).dispatchEvent(new PointerEvent(kind, { bubbles: true, pointerType: 'touch', pointerId: 11, clientX: x + dx, clientY: y, isPrimary: true }));
                fire('pointerdown', 0, document.elementFromPoint(x, y)); [12, 30, 55].forEach((dx) => fire('pointermove', dx)); fire('pointerup', 55); }""", [box["x"] + 60, y])
            check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day !== d", day1), "a quick flick back goes to the previous day")
            # A vertical move stays a scroll.
            day2 = strip_day(page)
            touch(page, "pointerdown", box["x"] + 100, y)
            for dy in (12, 30, 60):
                touch(page, "pointermove", box["x"] + 104, y + dy)
            touch(page, "pointerup", box["x"] + 104, y + 60)
            page.wait_for_timeout(400)
            check(strip_day(page) == day2 and page.locator(".hq-cal-peek").count() == 0, "a vertical move is not a swipe")

            # Pinch: two fingers spread the hours; the zoom is remembered.
            page.wait_for_timeout(500)
            h0 = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-slot').getBoundingClientRect().height")
            sb = page.locator(".hq-cal-scroll").bounding_box()
            cx, cy = sb["x"] + sb["width"] / 2, sb["y"] + sb["height"] / 2
            touch(page, "pointerdown", cx, cy - 40, 21, ".hq-cal-scroll")
            touch(page, "pointerdown", cx, cy + 40, 22, ".hq-cal-scroll")
            for spread in (50, 70, 90, 110):
                touch(page, "pointermove", cx, cy - spread, 21)
                touch(page, "pointermove", cx, cy + spread, 22)
            touch(page, "pointerup", cx, cy - 110, 21)
            touch(page, "pointerup", cx, cy + 110, 22)
            h1 = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-slot').getBoundingClientRect().height")
            check(h1 > h0 * 2.2, f"spreading two fingers makes the hours taller ({h0:.0f} → {h1:.0f} px)")
            check(page.evaluate("() => document.getElementById('hq-cal-app').classList.contains('is-zoomed')"), "tall hours show half-hour lines")
            check(page.evaluate("() => Number(localStorage.getItem('hq_cal_zoom'))") > 2, "the hour height is remembered")
            shot(page, "zoomed", browser_name)
            check(strip_day(page) == day2, "a pinch is not a swipe")
            page.evaluate("() => localStorage.setItem('hq_cal_zoom', '1')")

            # Agenda: swipe a row left to delete it, Annuler brings it back.
            page.locator('#hq-cal-app [data-view="agenda"]').click()
            until(page, "() => !!document.querySelector('.hq-cal-agenda')")
            row = page.locator(".hq-cal-row", has_text="Agenda à glisser")
            check(until(page, "() => [...document.querySelectorAll('.hq-cal-row')].some((r) => r.innerText.includes('Agenda à glisser'))"), f"the agenda lists the event {page.evaluate(AGENDA_ROWS)}")
            rb = row.bounding_box()
            sel = "[data-id='" + row.get_attribute("data-id") + "']"
            touch(page, "pointerdown", rb["x"] + rb["width"] - 30, rb["y"] + rb["height"] / 2, 31, ".hq-cal-row" + sel)
            for dx in (12, 60, 120, 180, 230):
                touch(page, "pointermove", rb["x"] + rb["width"] - 30 - dx, rb["y"] + rb["height"] / 2, 31)
                page.wait_for_timeout(30)
            check(page.evaluate("(s) => document.querySelector('.hq-cal-row' + s).classList.contains('is-armed')", sel), "pulled far enough, it is ready to go")
            shot(page, "rowswipe", browser_name)
            touch(page, "pointerup", rb["x"] + rb["width"] - 260, rb["y"] + rb["height"] / 2, 31)
            ok, _ = server_until(page, base, today + timedelta(days=3), "Agenda à glisser", lambda e: e is None)
            check(ok, "letting go deletes it")
            check(until(page, "() => document.querySelector('.hq-cal-undo-text').textContent.startsWith('Supprimé')"), "with Annuler")
            page.locator("#hq-cal-undo .hq-cal-undo-btn").click()
            ok, _ = server_until(page, base, today + timedelta(days=3), "Agenda à glisser", lambda e: e is not None)
            check(ok, "Annuler brings the row back")

            # Sons: a toggle, remembered.
            sons = page.locator('#hq-cal-app [data-cal="sound"]')
            check(sons.get_attribute("aria-pressed") == "false", "Sons is off by default")
            sons.click()
            check(sons.get_attribute("aria-pressed") == "true" and page.evaluate("() => localStorage.getItem('hq_cal_sound')") == "1", "Sons turns on and is remembered")
            sons.click()

            # iPhone tap: where vibrate is missing (Safari), the hidden switch is used.
            if not page.evaluate("() => 'vibrate' in navigator"):
                check(page.locator("label.hq-cal-haptic input[switch]").count() == 1, "without vibrate, the hidden switch gives the tap")
            tops = page.evaluate("() => ['.hq-cal-toggle', '.hq-cal-create'].map((q) => Math.round(document.querySelector('#hq-cal-app ' + q).getBoundingClientRect().top))")
            check(abs(tops[0] - tops[1]) < 8, f"on a phone the toggles and + Événement share one row {tops}")
            check(not errors, f"no page errors {errors[:3]}")
            ctx.close()

            # Desktop: Ctrl + wheel (a trackpad pinch) zooms the hours.
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, bypass_csp=True)
            page = ctx.new_page()
            page.goto(base + "/")
            page.fill('input[name="pin"]', info["admin_pin"])
            page.click('button[type="submit"]')
            page.wait_for_load_state("networkidle")
            page.click('.bottom-nav [data-nav="calendrier"]') if page.locator('.bottom-nav [data-nav="calendrier"]').is_visible() else page.evaluate("() => setView('calendrier')")
            until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')")
            page.locator('#hq-cal-app [data-view="day"]').click()
            until(page, "() => !!document.querySelector('.hq-cal-day')")
            page.wait_for_timeout(400)
            h0 = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-slot').getBoundingClientRect().height")
            sb = page.locator(".hq-cal-day").bounding_box()
            page.mouse.move(sb["x"] + 200, 400)
            page.keyboard.down("Control")
            for _ in range(4):
                page.mouse.wheel(0, -40)
                page.wait_for_timeout(30)
            page.keyboard.up("Control")
            h1 = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-slot').getBoundingClientRect().height")
            check(h1 > h0 * 1.3, f"Ctrl + wheel makes the hours taller ({h0:.0f} → {h1:.0f} px)")
            ctx.close()
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
