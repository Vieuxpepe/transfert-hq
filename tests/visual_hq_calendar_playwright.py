"""Calendar layout in a browser (phone 375 px and desktop): hour slots are flat rows (not buttons
drawn as pills), the header is three rows, events show their start time, phone month shows marks on
one line, agenda rows line up, no empty box under the grid, and the existing flows still work
(view switching, tap a slot to create, open an event). Throwaway loopback HQ, fake PINs.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_calendar_playwright.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from datetime import date, timedelta
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


def event(title, day, start=None, end=None, cat="other", all_day=False):
    if all_day:
        return {"title": title, "all_day": True, "category": cat, "start": day.isoformat(), "end": (day + timedelta(days=1)).isoformat()}
    return {"title": title, "all_day": False, "category": cat, "start": f"{day}T{start}", "end": f"{day}T{end}"}


def shot(page, name, browser_name):
    if SHOTS:
        SHOTS.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SHOTS / f"{browser_name}-cal-{name}.png"))


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-calview-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    today = date.today()
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            for label, viewport in (("phone", {"width": 375, "height": 812}), ("desktop", {"width": 1440, "height": 900})):
                ctx = browser.new_context(viewport=viewport, bypass_csp=True)
                page = ctx.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(base + "/")
                page.fill('input[name="pin"]', info["admin_pin"])
                page.click('button[type="submit"]')
                page.wait_for_load_state("networkidle")
                if label == "phone":
                    for e in (event("Réunion équipe", today, "09:30", "10:30", "hq"), event("Dentiste", today, "14:00", "15:00", "appointment"),
                              event("Appel", today, "18:00", "18:30", "personal"), event("Lecture", today, "20:00", "21:00", "study"),
                              event("Anniversaire Léa", today + timedelta(days=2), cat="personal", all_day=True)):
                        r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                                              data=json.dumps({"action": "save", "expected_rev": 0, "event": e}))
                        check(r.ok, "synthetic event saved: " + e["title"])
                print(f"[{label}]")
                page.click('.bottom-nav [data-nav="calendrier"]')
                check(until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')"), "the calendar renders")
                page.locator('#hq-cal-app [data-view="day"]').click()
                until(page, "() => !!document.querySelector('.hq-cal-day')")
                slots = page.evaluate("""() => [...document.querySelectorAll('.hq-cal-day .hq-cal-slot')].map((s) => { const r = s.getBoundingClientRect(), c = getComputedStyle(s);
                    return { w: r.width, h: r.height, bg: c.backgroundColor, radius: c.borderTopLeftRadius }; })""")
                col = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-col').getBoundingClientRect().width")
                check(len(slots) == 24 and all(abs(s["w"] - col) < 1.5 and 47 <= s["h"] <= 49 for s in slots),
                      f"24 hour slots, each a full-width 48 px row ({slots[0]['w']:.0f}/{col:.0f} px)")
                check(all(s["bg"] in ("rgba(0, 0, 0, 0)", "transparent") and s["radius"] == "0px" for s in slots), "slots are flat and transparent (no pill buttons)")
                rows = page.evaluate("() => [...document.querySelector('.hq-cal-bar').children].map((c) => c.className)")
                check(rows == ["hq-cal-head", "hq-cal-views", "hq-cal-tools"], f"the header is three rows {rows}")
                check(page.locator(".hq-cal-today").count() == 0, "Aujourd'hui is hidden while today is on screen")
                labels = page.evaluate("() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event, .hq-cal-day .hq-cal-face')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())")
                check(any(t.startswith("09:30") and "Réunion équipe" in t for t in labels), f"events show their start time {labels[:3]}")
                check(page.locator(".hq-cal-cond").count() == 0, "no empty box under the grid")
                check(page.evaluate("() => !document.querySelector('.hq-cal-allday') || document.querySelector('.hq-cal-allday').children.length > 0 || getComputedStyle(document.querySelector('.hq-cal-allday')).display === 'none'"),
                      "an empty all-day lane takes no room")
                shot(page, f"day-{label}", browser_name)
                page.locator("#hq-cal-app [data-cal=next]").click()
                check(until(page, "() => !!document.querySelector('.hq-cal-today')"), "after moving away, Aujourd'hui appears")
                page.locator(".hq-cal-today").click()
                check(until(page, "() => !document.querySelector('.hq-cal-today')"), "and brings back today")
                page.locator('.hq-cal-day .hq-cal-slot[data-hour="11"]').click()
                check(until(page, "() => !![...document.querySelectorAll('.hq-sheet')].find((s) => !s.hidden)"), "tapping an hour opens the new-event sheet")
                page.keyboard.press("Escape")
                until(page, "() => ![...document.querySelectorAll('.hq-sheet')].find((s) => !s.hidden)")
                page.locator('#hq-cal-app [data-view="month"]').click()
                until(page, "() => !!document.querySelector('.hq-cal-month')")
                if label == "phone":
                    marks = page.evaluate("""() => { const c = document.querySelector('.hq-cal-mcell.is-today'); const d = c.querySelector('.hq-cal-dots');
                        if (!d) return null; const mids = [...d.children].map((x) => { const r = x.getBoundingClientRect(); return r.top + r.height / 2; });
                        return { n: d.children.length, rows: Math.max(...mids) - Math.min(...mids) < 3 ? 1 : 2,
                        text: d.innerText.trim(), inside: d.getBoundingClientRect().right <= c.getBoundingClientRect().right + 0.5 }; }""")
                    check(marks and marks["rows"] == 1 and marks["inside"] and marks["text"] == "+2", f"phone month: marks on one line inside the cell, 2 marks and +2 {marks}")
                    check(page.locator(".hq-cal-mcell .hq-cal-chip").count() == 0, "phone month shows marks, not cramped titles")
                else:
                    check(page.locator(".hq-cal-mcell.is-today .hq-cal-chip").count() == 2 and page.locator(".hq-cal-mcell.is-today .hq-cal-more").count() == 1,
                          "desktop month shows two titles and +n")
                shot(page, f"month-{label}", browser_name)
                page.locator(".hq-cal-mcell.is-today .hq-cal-mday").click()
                check(until(page, "() => !!document.querySelector('.hq-cal-day')"), "tapping a month day opens that day")
                page.locator('#hq-cal-app [data-view="agenda"]').click()
                until(page, "() => !!document.querySelector('.hq-cal-agenda .hq-cal-row')")
                cols = page.evaluate("() => [...document.querySelectorAll('.hq-cal-agenda .hq-cal-row time')].map((t) => Math.round(t.getBoundingClientRect().left))")
                check(len(set(cols)) == 1, f"agenda times line up in one column {sorted(set(cols))}")
                page.locator(".hq-cal-agenda .hq-cal-row", has_text="Dentiste").click()
                check(until(page, "() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.innerText.includes('Dentiste'))"), "an agenda row opens its event")
                page.keyboard.press("Escape")
                shot(page, f"agenda-{label}", browser_name)
                page.locator('#hq-cal-app [data-view="week"]').click()
                check(until(page, "() => document.querySelectorAll('.hq-cal-weekcol').length === 7"), "the week shows seven columns")
                shot(page, f"week-{label}", browser_name)
                check(not errors, f"no page errors {errors[:3]}")
                ctx.close()
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
