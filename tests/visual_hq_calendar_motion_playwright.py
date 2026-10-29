"""Calendar motion in a browser: moved events glide (FLIP), an event grows into its sheet and back
(View Transitions), changed words roll, a dragged event leans, shows its landing footprint, clicks onto
a neighbour's edge and lights up clashes, events in progress fill up, the end-of-day recap celebrates
once, the streak flame shows, a free day has a sky, the strip scrubs, pulling down comes back to today,
and a long press peeks at a day. Throwaway loopback HQ, fake PINs.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_calendar_motion_playwright.py
"""

from __future__ import annotations

import json
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
OPEN_SHEET = "() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)"


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
        page.screenshot(path=str(SHOTS / f"{browser_name}-motion-{name}.png"))


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


def minute(dt):
    return dt.strftime("%Y-%m-%dT%H:%M")


def timed(title, start, end, cat="other", done=False):
    ev = {"title": title, "all_day": False, "category": cat, "start": minute(start), "end": minute(end)}
    if done:
        ev["done"] = True
    return ev


def strip_day(page):
    return page.evaluate("() => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day")


def open_day(page, day):
    page.evaluate("(k) => window.hqCalendarOpenDay(k)", day.isoformat())
    until(page, "(k) => { const b = document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]'); return b && b.dataset.day === k; }", day.isoformat())
    page.wait_for_timeout(450)


def login(browser, base, info, **ctx_args):
    ctx = browser.new_context(bypass_csp=True, **ctx_args)
    page = ctx.new_page()
    page.goto(base + "/")
    page.fill('input[name="pin"]', info["admin_pin"])
    page.click('button[type="submit"]')
    page.wait_for_load_state("networkidle")
    return ctx, page


def to_calendar(page):
    if page.locator('.bottom-nav [data-nav="calendrier"]').is_visible():
        page.click('.bottom-nav [data-nav="calendrier"]')
    else:
        page.evaluate("() => setView('calendrier')")
    until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')")
    page.locator('#hq-cal-app [data-view="day"]').click()
    until(page, "() => !!document.querySelector('.hq-cal-day')")


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-calmotion-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    today = date.today()
    tomorrow = today + timedelta(days=1)
    now = datetime.now()
    timed_today = 3 <= now.hour <= 21
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            ctx, page = login(browser, base, info, viewport={"width": 375, "height": 812}, has_touch=True)
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.evaluate("() => { try { localStorage.removeItem('hq_cal_cheer'); } catch (_) {} }")

            if timed_today:
                # End of day: only finished events today, so the recap shows now.
                check(bool(save(page, base, timed("Matin fini", now - timedelta(hours=3), now - timedelta(hours=2), "study"))), "seed: a finished event today")
                yday = now - timedelta(days=1)
                check(bool(save(page, base, timed("Hier fait", yday.replace(hour=9, minute=0), yday.replace(hour=10, minute=0), done=True))), "seed: yesterday, done")
                to_calendar(page)
                if page.locator(".hq-cal-today").count():
                    page.locator(".hq-cal-today").click()
                check(until(page, "() => !!document.querySelector('.hq-cal-recap')"), "with everything finished today, the recap shows")
                check("0 sur 1" in page.locator(".hq-cal-recap").inner_text(), "it counts what got done")
                page.locator(".hq-cal-day .hq-cal-event", has_text="Matin fini").locator(".hq-cal-check").click()
                check(until(page, "() => !!document.querySelector('.hq-cal-recap.is-complete')"), "ticking the last one: « Journée bouclée »")
                check(until(page, "() => !!document.querySelector('canvas.hq-cal-confetti')", None, 3), "with confetti")
                check(page.evaluate("() => localStorage.getItem('hq_cal_cheer')") == today.isoformat(), "once a day (remembered)")
                shot(page, "recap", browser_name)
                check(until(page, "() => { const s = document.querySelector('.hq-cal-weekstrip .is-today .hq-cal-streak'); return s && s.textContent.includes('2'); }"),
                      "the streak flame shows two days in a row")
                check("2 jours" in page.locator(".hq-cal-recap").inner_text(), "and the recap says so")
                check(until(page, "() => !document.querySelector('canvas.hq-cal-confetti')", None, 4), "the confetti cleans up after itself")
                page.evaluate("() => window.hqCalendarShow()")
                page.wait_for_timeout(600)
                check(page.locator("canvas.hq-cal-confetti").count() == 0, "and does not come back on the next refresh")

                # Live fill.
                check(bool(save(page, base, timed("En cours", now - timedelta(minutes=30), now + timedelta(minutes=30), "personal"))), "seed: an event in progress")
                page.evaluate("() => window.hqCalendarShow()")
                check(until(page, "() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event.is-live')].some((e) => e.innerText.includes('En cours'))"), "an event in progress is live")
                fill = page.evaluate("() => parseFloat([...document.querySelectorAll('.hq-cal-event.is-live')][0].style.getPropertyValue('--fill'))")
                check(0.35 < fill < 0.65, f"and filled about halfway ({fill:.2f})")
                check(until(page, "() => !document.querySelector('.hq-cal-recap')"), "with something still to come, the recap waits for the evening")

                # Glide: an overlapping event makes its neighbour narrow, smoothly.
                page.evaluate("""() => { window.__glides = []; const orig = Element.prototype.animate;
                    Element.prototype.animate = function (...a) { if (this.dataset && this.dataset.id) window.__glides.push(this.innerText); return orig.apply(this, a); }; }""")
                quick = page.locator("#hq-cal-quick-input")
                t = now - timedelta(minutes=20)
                quick.fill(f"Chevauche {t.hour}h{t.minute:02d}")
                quick.press("Enter")
                check(until(page, "() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((e) => e.innerText.includes('Chevauche'))"), "an overlapping event is added")
                check(until(page, "() => window.__glides.some((t) => t.includes('En cours'))"), "its neighbour glides to its new width")
                check(not page.evaluate("() => window.__glides.some((t) => t.includes('Chevauche'))"), "the new one lands instead of gliding")

                # Morph: the event grows into its sheet and shrinks back.
                if page.evaluate("() => typeof document.startViewTransition === 'function'"):
                    page.evaluate("""() => { window.__vt = 0; const orig = document.startViewTransition.bind(document);
                        document.startViewTransition = (cb) => { window.__vt += 1; return orig(cb); }; }""")
                    page.wait_for_timeout(5500)  # let the Annuler bar go
                    page.locator(".hq-cal-day .hq-cal-event", has_text="En cours").click()
                    check(until(page, OPEN_SHEET) and page.evaluate("() => window.__vt") == 1, "tapping an event grows it into its sheet (a view transition)")
                    page.wait_for_timeout(500)
                    shot(page, "morph", browser_name)
                    page.keyboard.press("Escape")
                    check(until(page, "() => !(" + OPEN_SHEET[6:] + ")") and page.evaluate("() => window.__vt") == 2, "closing shrinks it back into its block")
                else:
                    print("  --   no View Transitions here: the sheet opens the ordinary way")

            else:
                to_calendar(page)
                print("  --   too close to midnight for today's timed checks")

            # Rolling title.
            page.locator("#hq-cal-app [data-cal=next]").click()
            check(until(page, "() => document.querySelectorAll('.hq-cal-title .hq-roll').length > 0"), "stepping a day rolls the words that changed in the title")
            check(page.evaluate("() => [...document.querySelectorAll('.hq-cal-title .hq-roll')].every((r) => r.classList.contains('is-up'))"), "forward rolls up")
            page.locator("#hq-cal-app [data-cal=prev]").click()
            check(until(page, "() => [...document.querySelectorAll('.hq-cal-title .hq-roll')].some((r) => r.classList.contains('is-down'))"), "back rolls down")

            # A free day has a sky.
            open_day(page, today + timedelta(days=5))
            check(page.locator(".hq-cal-hint.is-empty .hq-cal-free .hq-cal-free-orb").count() == 1, "a free day shows a small sky with its sun or moon")
            check("Journée libre" in page.locator(".hq-cal-hint.is-empty").inner_text(), "« Journée libre »")
            shot(page, "free", browser_name)

            # Scrub along the strip.
            open_day(page, today)
            btns = page.locator(".hq-cal-weekstrip button")
            first, last = btns.nth(0).bounding_box(), btns.nth(6).bounding_box()
            page.mouse.move(first["x"] + first["width"] / 2, first["y"] + first["height"] / 2)
            page.mouse.down()
            visited = set()
            for i in range(1, 13):
                page.mouse.move(first["x"] + first["width"] / 2 + (last["x"] - first["x"]) * i / 12, first["y"] + first["height"] / 2)
                visited.add(strip_day(page))
            page.mouse.up()
            want = btns.nth(6).get_attribute("data-day")
            check(strip_day(page) == want, "sliding along the strip lands on the day under the finger")
            check(len(visited) >= 5, f"passing through the days on the way ({len(visited)})")
            page.wait_for_timeout(300)
            check(not page.evaluate(OPEN_SHEET), "a scrub opens nothing")

            # Peek: long-press a day, lift to close; long-press and slide up to open.
            open_day(page, today)
            target = btns.nth(0) if btns.nth(0).get_attribute("data-day") != today.isoformat() else btns.nth(6)
            key = target.get_attribute("data-day")
            tb = target.bounding_box()
            page.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            page.mouse.down()
            check(until(page, "() => !!document.querySelector('.hq-cal-peekday')", None, 2), "a long press peeks at the day")
            check(key[-2:].lstrip("0") in page.locator(".hq-cal-peekday h3").inner_text(), "showing that day")
            shot(page, "peek", browser_name)
            page.mouse.up()
            check(until(page, "() => !document.querySelector('.hq-cal-peekday')"), "lifting closes it")
            check(strip_day(page) == today.isoformat(), "without moving the calendar")
            page.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] + tb["height"] / 2)
            page.mouse.down()
            until(page, "() => !!document.querySelector('.hq-cal-peekday')", None, 2)
            page.mouse.move(tb["x"] + tb["width"] / 2, tb["y"] - 70, steps=5)
            check(page.evaluate("() => document.querySelector('.hq-cal-peekday').classList.contains('is-go')"), "sliding up arms it")
            page.mouse.up()
            check(until(page, "(k) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day === k", key), "and opens that day")

            # Pull down to today (touch events; Chromium builds them).
            if page.evaluate("() => { try { return !!new Touch({ identifier: 1, target: document.body }); } catch (_) { return false; } }"):
                open_day(page, tomorrow)
                page.evaluate("() => { const s = document.querySelector('.hq-cal-stage .hq-cal-scroll'); s.scrollTop = 0; s.scrollIntoView({ block: 'center' }); }")
                page.wait_for_timeout(200)
                page.evaluate("""() => { const s = document.querySelector('.hq-cal-stage .hq-cal-scroll'), r = s.getBoundingClientRect();
                    const x = r.left + r.width / 2, y = Math.min(r.top + 40, innerHeight - 40), el = document.elementFromPoint(x, y);
                    window.__pullTop = [r.top, innerHeight, el && el.className];
                    const t = (yy) => new Touch({ identifier: 5, target: el, clientX: x, clientY: yy });
                    el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t(y)], targetTouches: [t(y)], changedTouches: [t(y)] }));
                    for (const d of [12, 40, 80, 120, 170]) el.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, cancelable: true, touches: [t(y + d)], targetTouches: [t(y + d)], changedTouches: [t(y + d)] }));
                    window.__pullArmed = !!document.querySelector('.hq-cal-pull.is-armed');
                    el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t(y + 170)] })); }""")
                check(page.evaluate("() => window.__pullArmed"), f"{page.evaluate('() => window.__pullTop')} pulling the hours down arms « Aujourd'hui · maintenant »")
                check(until(page, "(k) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day === k", today.isoformat()), "letting go comes back to today")
            else:
                print("  --   no Touch constructor here: pull to today is covered in Chromium")
            check(not errors, f"no page errors {errors[:3]}")
            ctx.close()

            # Desktop drag: lean, footprint, clash, magnet, wobble.
            ctx, page = login(browser, base, info, viewport={"width": 1440, "height": 900})
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            check(bool(save(page, base, timed("Ancre", datetime.combine(tomorrow, datetime.min.time()).replace(hour=10, minute=5),
                                              datetime.combine(tomorrow, datetime.min.time()).replace(hour=11)))), "seed: Ancre 10:05–11:00 tomorrow")
            check(bool(save(page, base, timed("Mobile", datetime.combine(tomorrow, datetime.min.time()).replace(hour=7),
                                              datetime.combine(tomorrow, datetime.min.time()).replace(hour=8)))), "seed: Mobile 07:00–08:00 tomorrow")
            to_calendar(page)
            open_day(page, tomorrow)
            ev = page.locator(".hq-cal-day .hq-cal-event", has_text="Mobile")
            ev.evaluate("(e) => e.scrollIntoView({ block: 'center' })")
            page.wait_for_timeout(300)
            b = ev.bounding_box()
            hour = page.locator('.hq-cal-day .hq-cal-slot[data-hour="7"]').bounding_box()["height"]
            x, y = b["x"] + 40, b["y"] + 10
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + 6, y + hour * 3.5, steps=10)  # 10:30–11:30: over Ancre
            check(page.locator(".hq-cal-footprint").count() == 1, "the landing slot shows as a footprint")
            check(page.evaluate("() => document.querySelector('.hq-cal-ghost').style.getPropertyValue('--tilt') !== ''"), "the ghost leans with the hand")
            check(page.evaluate("() => [...document.querySelectorAll('.hq-cal-event.is-clash')].some((e) => e.innerText.includes('Ancre'))"), "an overlapped event glows")
            check(page.evaluate("() => document.querySelector('.hq-cal-ghost').classList.contains('is-clash')"), "and so does the ghost")
            shot(page, "clash", browser_name)
            page.mouse.move(x, y + hour * (2 + 2 / 60), steps=8)  # raw 09:02–10:02: 3 minutes from Ancre's start
            check(page.evaluate("() => !document.querySelector('.hq-cal-event.is-clash')"), "touching is not clashing")
            label = page.locator(".hq-cal-ghost-time").inner_text()
            check(label.startswith("09:05"), f"the end clicks onto Ancre's start ({label})")
            page.mouse.up()
            ok, item = server_until(page, base, tomorrow, "Mobile", lambda e: bool(e) and e["start"].endswith("T09:05"))
            check(ok and item["end"].endswith("T10:05"), f"and is saved there ({item and item['start']}–{item and item['end']})")
            check(not errors, f"no page errors {errors[:3]}")
            ctx.close()
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
