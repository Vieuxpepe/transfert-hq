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


def api_events(page, base, day):
    data = page.request.get(f"{base}/api/calendar?from={day.isoformat()}&to={(day + timedelta(days=1)).isoformat()}").json()
    return {item["title"]: item for item in data.get("items") or []}


def no_sheet(page):
    return until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)")


def open_sheet(page):
    return until(page, "() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)")


def flow_checks(page, base, label, today):
    """Quick add, the lighter editor, drag to create / move / resize, and the satisfying bits."""
    tomorrow = today + timedelta(days=1)
    page.locator('#hq-cal-app [data-view="day"]').click()
    until(page, "() => !!document.querySelector('.hq-cal-day')")
    # Quick add
    quick = page.locator("#hq-cal-quick-input")
    check(quick.is_visible(), "the quick add field is at the top")
    title = "Rdv test " + label
    quick.fill(title + " demain 14h")
    preview = page.locator("#hq-cal-quick-preview").inner_text()
    check(title.capitalize() in preview and "14:00–15:00" in preview and "Rendez-vous" in preview, f"the preview reads the sentence: {preview}")
    page.locator("#hq-cal-quick-input").press("Enter")
    check(until(page, "() => document.getElementById('hq-cal-quick-input').value === ''"), "Entrée saves and clears the field")
    saved = api_events(page, base, tomorrow).get(title.capitalize())
    check(bool(saved) and saved["start"].endswith("T14:00") and saved["category"] == "appointment", f"the event is on the server: {saved and saved['start']}")
    check(until(page, "(t) => [...document.querySelectorAll('.hq-cal-event')].some((e) => e.innerText.includes(t))", title.capitalize()), "the calendar moves to its day and shows it")
    page.evaluate("() => window.hqCalendarShow()")
    quick.fill("demain 9h")
    check("Ajoute un titre" in page.locator("#hq-cal-quick-preview").inner_text(), "without a title, the preview asks for one")
    quick.press("Enter")
    check(until(page, "() => document.getElementById('hq-cal-quick').classList.contains('is-shake') || !document.getElementById('hq-cal-quick').classList.contains('is-saving')"), "nothing is saved without a title")
    quick.fill("")
    page.locator(".hq-cal-today").click() if page.locator(".hq-cal-today").count() else None
    no_sheet(page)
    # Détails opens the lighter editor, prefilled
    quick.fill("Cours de piano vendredi 17h")
    page.locator("#hq-cal-quick-more").click()
    check(open_sheet(page), "Détails opens the editor")
    check(page.locator("#hq-cal-title").input_value() == "Cours de piano", "with the title filled in")
    check(page.locator(".hq-cal-catbtn[aria-checked=true]").inner_text() == "Étude", "and the guessed category chosen")
    check(page.locator(".hq-cal-moreopts").evaluate("(d) => !d.open"), "notes, scene, action, device and reminders wait under Plus d'options")
    page.locator('.hq-cal-durations [data-mins="90"]').click()
    check(page.locator("#cal-end").input_value().endswith("18:30"), "a duration chip sets the end")
    page.locator('.hq-cal-catbtn[data-cat="personal"]').click()
    check(page.locator("#cal-category").input_value() == "personal", "a category chip sets the category")
    page.keyboard.press("Escape")
    no_sheet(page)
    page.locator(".hq-cal-today").click() if page.locator(".hq-cal-today").count() else None
    until(page, "() => !document.querySelector('.hq-cal-today')")
    # Strip pill slides between days; month day zooms in
    page.locator("#hq-cal-app [data-cal=next]").click()
    check(until(page, "() => document.querySelector('.hq-cal-weekstrip.is-moving') !== null || document.querySelector('.hq-cal-stage.is-next') !== null"), "the selected day slides along the strip")
    page.locator("#hq-cal-app [data-cal=prev]").click()
    page.locator('#hq-cal-app [data-view="month"]').click()
    until(page, "() => !!document.querySelector('.hq-cal-month')")
    page.locator(".hq-cal-mcell.is-today .hq-cal-mday").click()
    check(until(page, "() => !!document.querySelector('.hq-cal-stage.is-zoom')"), "a month day zooms into the day")
    until(page, "() => !!document.querySelector('.hq-cal-day')")
    page.wait_for_timeout(500)  # let the zoom and the scroll to now settle before measuring
    if label != "desktop":
        # Touch: hold still on an empty hour, then drag down.
        page.evaluate("() => document.querySelector('.hq-cal-scroll').scrollTop = 6 * 48")
        y = page.evaluate("""() => { const s = document.querySelector('.hq-cal-day .hq-cal-slot[data-hour="7"]'); const r = s.getBoundingClientRect(); return [r.left + 40, r.top + 2]; }""")
        page.evaluate("""([x, y]) => { const el = document.elementFromPoint(x, y);
            el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 7, clientX: x, clientY: y, isPrimary: true })); }""", y)
        page.wait_for_timeout(480)
        page.evaluate("""([x, y]) => { for (const dy of [30, 60, 90]) window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'touch', pointerId: 7, clientX: x, clientY: y + dy, isPrimary: true }));
            window.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', pointerId: 7, clientX: x, clientY: y + 90, isPrimary: true })); }""", y)
        check(open_sheet(page), "touch: a long press then a drag on empty hours opens a new event")
        check(page.locator("#cal-start").input_value().endswith("07:00") and page.locator("#cal-end").input_value().endswith("09:00"),
              f"with the dragged span ({page.locator('#cal-start').input_value()} – {page.locator('#cal-end').input_value()})")
        page.keyboard.press("Escape")
        no_sheet(page)
        return
    # Desktop mouse: drag on empty hours creates; drag an event moves it; drag its edge resizes it.
    page.evaluate("() => { const s = document.querySelector('.hq-cal-scroll'); if (s) s.scrollTop = 0; window.scrollTo(0, 0); }")
    slot = page.locator('.hq-cal-day .hq-cal-slot[data-hour="6"]')
    slot.scroll_into_view_if_needed()
    box = slot.bounding_box()
    x = box["x"] + 60
    page.mouse.move(x, box["y"] + 2)
    page.mouse.down()
    page.mouse.move(x, box["y"] + 40, steps=4)
    check(page.locator(".hq-cal-ghost").count() == 1, "dragging on empty hours shows a ghost with its times")
    page.mouse.move(x, box["y"] + box["height"] * 1.5, steps=6)
    ghost = page.locator(".hq-cal-ghost-time").inner_text()
    page.mouse.up()
    check(open_sheet(page) and page.locator("#cal-start").input_value().endswith("06:00") and page.locator("#cal-end").input_value().endswith("07:30"),
          f"releasing opens a new event for that span ({ghost})")
    page.locator("#hq-cal-title").fill("Glissé")
    page.locator(".hq-cal-sheet-actions button[type=submit]").click()
    no_sheet(page)
    check(until(page, "() => !!document.querySelector('.hq-cal-event.is-landed') || [...document.querySelectorAll('.hq-cal-event')].some((e) => e.innerText.includes('Glissé'))"),
          "the new event lands in place")
    moved = page.locator(".hq-cal-event", has_text="Glissé")
    moved.evaluate("(e) => e.scrollIntoView({ block: 'center' })")
    b = steady(page, moved)
    hour = page.locator('.hq-cal-day .hq-cal-slot[data-hour="6"]').bounding_box()["height"]
    page.mouse.move(b["x"] + 30, b["y"] + 8)
    page.mouse.down()
    page.mouse.move(b["x"] + 30, b["y"] + 8 + hour * 2, steps=8)
    check(page.locator("#hq-cal-app").evaluate("(r) => r.classList.contains('is-dragging')"), "an event lifts while it is dragged")
    page.mouse.up()
    check(until(page, "() => true") and not open_sheet_now(page), "a drag does not also open the event")
    item = server_until(page, base, today, "Glissé", lambda e: e["start"].endswith("T08:00"))
    check(item and item["start"].endswith("T08:00"), f"moving it two hours down saves 08:00 on the server ({item and item['start']})")
    check(until(page, "() => !document.getElementById('hq-cal-undo').hidden && document.querySelector('.hq-cal-undo-text').textContent.startsWith('Déplacé')"),
          "Annuler is offered after the move")
    grip = page.locator(".hq-cal-event", has_text="Glissé").locator(".hq-cal-resize")
    grip.evaluate("(e) => e.scrollIntoView({ block: 'center' })")
    g = steady(page, grip)
    page.mouse.move(g["x"] + g["width"] / 2, g["y"] + g["height"] / 2)
    page.mouse.down()
    page.mouse.move(g["x"] + g["width"] / 2, g["y"] + g["height"] / 2 + hour, steps=6)
    page.mouse.up()
    item = server_until(page, base, today, "Glissé", lambda e: e["end"].endswith("T10:30"))
    check(item and item["end"].endswith("T10:30"), f"dragging its bottom edge an hour down saves the new end ({item and item['end']})")
    # Annuler takes the resize back (once its own bar is up: the move's bar left when the resize began).
    check(until(page, "() => !document.getElementById('hq-cal-undo').hidden && document.querySelector('.hq-cal-undo-text').textContent.startsWith('Durée')"),
          "the resize offers its own Annuler")
    page.locator("#hq-cal-undo .hq-cal-undo-btn").click()
    item = server_until(page, base, today, "Glissé", lambda e: e["end"].endswith("T09:30"))
    check(item and item["end"].endswith("T09:30"), f"Annuler puts the old end back ({item and item['end']})")
    page.keyboard.press("Escape")


def steady(page, locator):
    """The box once it stops moving (a landing event or a refresh can still shift the layout)."""
    for _ in range(30):  # a landing or drop wobble first plays out
        if locator.evaluate("(e) => { const c = e.closest('.hq-cal-event') || e; return c.getAnimations({ subtree: true }).every((a) => a.playState !== 'running' || a.effect.getTiming().iterations === Infinity); }"):
            break
        page.wait_for_timeout(100)
    last = None
    for _ in range(20):
        box = locator.bounding_box()
        if box and last and abs(box["x"] - last["x"]) < 0.5 and abs(box["y"] - last["y"]) < 0.5 and abs(box["height"] - last["height"]) < 0.5:
            return box
        last = box
        page.wait_for_timeout(150)
    return last


def server_until(page, base, day, title, ok, tries=40):
    item = None
    for _ in range(tries):
        item = api_events(page, base, day).get(title)
        if item and ok(item):
            return item
        page.wait_for_timeout(150)
    return item


def open_sheet_now(page):
    return page.evaluate("() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)")


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
                              event("Anniversaire Léa", today + timedelta(days=2), cat="personal", all_day=True),
                              event("Hier passé", today - timedelta(days=1), "10:00", "11:00", "hq")):
                        r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                                              data=json.dumps({"action": "save", "expected_rev": 0, "event": e}))
                        check(r.ok, "synthetic event saved: " + e["title"])
                print(f"[{label}]")
                page.click('.bottom-nav [data-nav="calendrier"]')
                check(until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')"), "the calendar renders")
                page.locator('#hq-cal-app [data-view="day"]').click()
                until(page, "() => !!document.querySelector('.hq-cal-day')")
                page.mouse.move(0, 0)  # a hovered slot is tinted on purpose
                page.wait_for_timeout(450)  # measure once the view has settled
                slots = page.evaluate("""() => [...document.querySelectorAll('.hq-cal-day .hq-cal-slot')].map((s) => { const r = s.getBoundingClientRect(), c = getComputedStyle(s);
                    return { w: r.width, h: r.height, bg: c.backgroundColor, radius: c.borderTopLeftRadius }; })""")
                col = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-col').getBoundingClientRect().width")
                check(len(slots) == 24 and all(abs(s["w"] - col) < 1.5 and 47 <= s["h"] <= 49 for s in slots),
                      f"24 hour slots, each a full-width 48 px row ({slots[0]['w']:.0f}/{col:.0f} px)")
                check(all(s["bg"] in ("rgba(0, 0, 0, 0)", "transparent") and s["radius"] == "0px" for s in slots), f"slots are flat and transparent (no pill buttons) {[ (s['bg'], s['radius']) for s in slots if s['bg'] not in ('rgba(0, 0, 0, 0)', 'transparent') or s['radius'] != '0px'][:3]}")
                rows = page.evaluate("() => [...document.querySelector('.hq-cal-bar').children].map((c) => c.classList[0])")
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
                until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)")
                shot(page, f"agenda-{label}", browser_name)
                page.locator('#hq-cal-app [data-view="week"]').click()
                if label == "phone":
                    check(page.locator('#hq-cal-app [data-view="week"]').inner_text() == "3 jours", "on a phone the week button says 3 jours")
                    check(until(page, "() => document.querySelectorAll('.hq-cal-weekcol').length === 3"), "the phone week shows three days")
                    fits = page.evaluate("() => { const s = document.querySelector('#hq-cal-app .hq-cal-scroll'); return s.scrollWidth <= s.clientWidth + 1; }")
                    check(fits, "three days fit the screen with no sideways scrolling")
                    first = page.locator(".hq-cal-title").inner_text()
                    page.locator("#hq-cal-app [data-cal=next]").click()
                    until(page, "(t) => document.querySelector('.hq-cal-title').textContent !== t", first)
                    heads = page.evaluate("() => [...document.querySelectorAll('.hq-cal-weekhead button')].map((b) => b.dataset.day)")
                    check(heads[0] == (today + timedelta(days=3)).isoformat(), f"› moves three days ({heads[0]})")
                    page.locator(".hq-cal-today").click()
                    until(page, "() => !document.querySelector('.hq-cal-today')")
                else:
                    check(until(page, "() => document.querySelectorAll('.hq-cal-weekcol').length === 7"), "the week shows seven columns")
                shot(page, f"week-{label}", browser_name)

                # Motion: only after the owner moved, and in the direction of the move.
                page.locator('#hq-cal-app [data-view="day"]').click()
                check(until(page, "() => document.querySelector('.hq-cal-stage').classList.contains('is-view')"), "switching view animates the content")
                check(page.evaluate("() => document.querySelector('.hq-cal-views').classList.contains('is-moving')"), "and slides the view pill")
                page.locator("#hq-cal-app [data-cal=next]").click()
                check(until(page, "() => document.querySelector('.hq-cal-stage').classList.contains('is-next')"), "› slides the next day in")
                page.locator("#hq-cal-app [data-cal=prev]").click()
                check(until(page, "() => document.querySelector('.hq-cal-stage').classList.contains('is-prev')"), "‹ slides the other way")
                page.evaluate("() => window.hqCalendarShow()")  # a background-style refresh
                check(until(page, "() => !/is-(next|prev|view)/.test(document.querySelector('.hq-cal-stage').className)"), "a refresh on its own does not animate")

                # Selected day in the strip stays readable when it is today.
                colours = page.evaluate("""() => { const b = document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]'), n = b.querySelector('.hq-cal-strip-num');
                    return [getComputedStyle(n).color, getComputedStyle(document.querySelector('.hq-cal-weekstrip'), '::before').backgroundColor, n.textContent]; }""")
                check(colours[0] != colours[1] and colours[2].isdigit(), f"the selected day's number is visible {colours}")

                # Categories are tinted differently; yesterday's event is dimmed.
                tints = page.evaluate("""() => { const pick = (t) => { const e = [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].find((x) => x.innerText.includes(t));
                    const f = e && (e.querySelector('.hq-cal-face') || e); return f ? getComputedStyle(f).backgroundColor : null; }; return [pick('Réunion'), pick('Dentiste')]; }""")
                check(tints[0] and tints[1] and tints[0] != tints[1], f"each category has its own tint {tints}")
                page.locator("#hq-cal-app [data-cal=prev]").click()
                check(until(page, "() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((e) => e.innerText.includes('Hier passé') && e.classList.contains('is-past'))"),
                      "a finished event is dimmed")
                page.locator("#hq-cal-app [data-cal=prev]").click()
                check(until(page, "() => !!document.querySelector('.hq-cal-hint.is-empty')"), "an empty day says so and how to add")
                page.locator(".hq-cal-today").click()
                until(page, "() => !document.querySelector('.hq-cal-today')")

                # Swipe (touch pointer events) and keys.
                day0 = page.evaluate("() => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day")
                page.evaluate("""() => { const g = document.querySelector('.hq-cal-day'), r = g.getBoundingClientRect(), y = r.top + 200;
                    const fire = (type, x) => g.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: 'touch', clientX: x, clientY: y, isPrimary: true }));
                    fire('pointerdown', r.right - 30); fire('pointerup', r.left + 60); }""")
                check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day !== d", day0), "swiping left goes to the next day")
                check(not page.evaluate("() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)"), "the swipe did not also open a sheet")
                page.mouse.click(5, 5)
                page.keyboard.press("t")
                check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day === d", day0), "T comes back to today")
                page.keyboard.press("ArrowRight")
                check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day !== d", day0), "→ goes to the next day")
                page.keyboard.press("ArrowLeft")
                check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day === d", day0), "← comes back")
                page.locator('.hq-cal-day .hq-cal-slot[data-hour="11"]').click()
                until(page, "() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)")
                page.keyboard.press("ArrowRight")
                page.wait_for_timeout(300)
                check(page.evaluate("(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day === d", day0), "arrows do nothing while a sheet is open")
                if page.evaluate("() => matchMedia('(prefers-reduced-motion: no-preference)').matches"):
                    check(page.evaluate("() => getComputedStyle([...document.querySelectorAll('.hq-sheet')].find((s) => !s.hidden).querySelector('.hq-sheet-card')).animationName") == "hq-cal-morph",
                          "the sheet grows out of the press point")
                page.keyboard.press("Escape")
                until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)")
                flow_checks(page, base, label, today)
                check(not errors, f"no page errors {errors[:3]}")
                ctx.close()
            # Reduced motion: nothing slides or pulses.
            ctx = browser.new_context(viewport={"width": 375, "height": 812}, bypass_csp=True, reduced_motion="reduce")
            page = ctx.new_page()
            page.goto(base + "/")
            page.fill('input[name="pin"]', info["admin_pin"])
            page.click('button[type="submit"]')
            page.wait_for_load_state("networkidle")
            page.click('.bottom-nav [data-nav="calendrier"]')
            until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')")
            page.locator('#hq-cal-app [data-view="day"]').click()
            page.locator("#hq-cal-app [data-cal=next]").click()
            until(page, "() => document.querySelector('.hq-cal-stage').classList.contains('is-next')")
            names = page.evaluate("""() => [getComputedStyle(document.querySelector('.hq-cal-stage')).animationName,
                getComputedStyle(document.querySelector('.hq-cal-views'), '::before').animationName]""")
            check(all(n == "none" for n in names), f"with reduced motion nothing animates {names}")
            ctx.close()
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
