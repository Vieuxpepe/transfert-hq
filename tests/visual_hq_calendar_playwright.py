"""Calendar layout in a browser (phone 375 px and desktop): hour slots are flat rows (not buttons
drawn as pills), the header is two stacked rows, events show their start time, phone month shows marks on
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

# Message strings carry arrows and accents; a cp1252 console must not turn a passing check into a crash.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

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


def idle(page, timeout: float = 20.0) -> bool:
    """The calendar has finished drawing: it stays busy for exactly as long as HQ is out."""
    return until(page, "() => { const r = document.querySelector('#hq-cal-app');\n        return !!r && !r.dataset.busy && !!r.querySelector('.hq-cal-stage'); }", timeout=timeout)


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
    quick_cleared = until(page, "() => document.getElementById('hq-cal-quick-input').value === ''")
    if not quick_cleared:
        print("QUICKDBG", page.evaluate("""() => { const i = document.getElementById('hq-cal-quick-input'), f = i && i.form;
            const toasts = [...document.querySelectorAll('.hq-toast, .toast, [role=status], .hq-cal-toast')].map((n) => n.textContent.trim()).filter(Boolean);
            return { value: i && i.value, form: f && f.className, disabled: document.getElementById('hq-cal-quick-submit')?.disabled,
                     busy: document.getElementById('hq-cal-app')?.dataset.busy, toasts: toasts.slice(-3) }; }"""))
    check(quick_cleared, "Entrée saves and clears the field")
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
    start = page.locator("#cal-start")
    start.fill(start.input_value().split("T")[0] + "T16:00")
    check(page.locator("#cal-end").input_value().endswith("17:30"), "moving the start preserves the edited duration")
    page.locator('.hq-cal-catbtn[data-cat="personal"]').click()
    check(page.locator("#cal-category").input_value() == "personal", "a category chip sets the category")
    page.keyboard.press("Escape")
    no_sheet(page)
    check(quick.input_value() == "Cours de piano vendredi 17h", "closing the editor preserves the quick-add draft")
    quick.fill("")
    page.locator(".hq-cal-today").click() if page.locator(".hq-cal-today").count() else None
    until(page, "() => !document.querySelector('.hq-cal-today')")
    # Strip pill slides between days; month day zooms in
    idle(page)
    page.locator("#hq-cal-app [data-cal=next]").click()
    check(until(page, "() => document.querySelector('.hq-cal-weekstrip.is-moving') !== null || document.querySelector('.hq-cal-stage.is-next') !== null"),
          "the selected day slides along the strip")
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
    page.evaluate("() => { const s = document.querySelector('.hq-cal-scroll'); if (s) s.scrollTop = 4 * s.querySelector('.hq-cal-slot').offsetHeight; window.scrollTo(0, 0); }")
    idle(page)  # the zoom's refresh has landed, so the grid will not be rebuilt under this drag
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
    page.evaluate("""() => {
        const animate = Element.prototype.animate;
        window.__calendarDrop = [];
        Element.prototype.animate = function (frames, timing) {
            if (this.closest('.hq-cal-event')?.textContent.includes('Glissé')) {
                window.__calendarDrop.push({ first: frames[0], delay: timing.delay });
            }
            return animate.call(this, frames, timing);
        };
    }""")
    page.mouse.up()
    check(until(page, "() => true") and not open_sheet_now(page), "a drag does not also open the event")
    item = server_until(page, base, today, "Glissé", lambda e: e["start"].endswith("T08:00"))
    check(item and item["start"].endswith("T08:00"), f"moving it two hours down saves 08:00 on the server ({item and item['start']})")
    check(until(page, "() => window.__calendarDrop.some(effect => effect.first.transformOrigin === 'top left')"),
          "the event settles from its drag preview")
    check(until(page, """() => {
        const glows = window.__calendarDrop.filter(effect => effect.first.boxShadow);
        return glows.length >= 2 && glows[1].delay < glows[0].delay;
    }"""), "the refresh continues the same drop highlight")
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
    if not (item and item["end"].endswith("T10:30")):
        print("RESIZEDBG", page.evaluate("""() => { const toasts = [...document.querySelectorAll('.hq-toast, .toast, [role=status], .hq-cal-toast')].map((n) => n.textContent.trim()).filter(Boolean);
            return { end: document.querySelector('.hq-cal-event[data-id] .hq-cal-time')?.textContent, undo: document.getElementById('hq-cal-undo')?.hidden,
                     undo_text: document.querySelector('.hq-cal-undo-text')?.textContent, toasts: toasts.slice(-3) }; }"""))
    check(item and item["end"].endswith("T10:30"), f"dragging its bottom edge an hour down saves the new end ({item and item['end']})")
    # Annuler takes the resize back and leaves the earlier changes available.
    check(until(page, "() => !document.getElementById('hq-cal-undo').hidden && document.querySelector('.hq-cal-undo-text').textContent.startsWith('Durée')"),
          "the resize offers its own Annuler")
    page.locator("#hq-cal-undo .hq-cal-undo-btn").click()
    item = server_until(page, base, today, "Glissé", lambda e: e["end"].endswith("T09:30"))
    check(item and item["end"].endswith("T09:30"), f"Annuler puts the old end back ({item and item['end']})")
    page.locator(".hq-cal-event", has_text="Glissé").click()
    page.locator("#hq-cal-detail [data-sheet=delete]").click()
    no_sheet(page)
    check("Glissé" not in api_events(page, base, today), "the event can be deleted after undoing a resize")
    page.locator(".hq-cal-options-trigger").click()
    page.locator('[data-cal="history"]').click()
    history = page.locator("#hq-cal-history")
    undo = history.locator(".hq-cal-history-undo")
    for label in ("Supprimé", "Déplacé", "Ajouté"):
        check(history.locator("li").first.inner_text().startswith(label + " · Glissé"), f"history shows {label.lower()} next")
        undo.click()
        until(page, "(label) => !document.querySelector('#hq-cal-history li')?.textContent.startsWith(label + ' · Glissé')", label)
    check("Glissé" not in api_events(page, base, today), "undo can restore a deletion, reverse a move and remove the original creation")
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


def keyboard_checks(page, base, label, today):
    """The grid is a keyboard surface: arrows walk hours and days, Enter / Space open a cell, N
    creates on the focused cell, Esc hands focus back, and every advertised shortcut does its job."""
    page.mouse.click(5, 5)
    page.keyboard.press("t")
    page.keyboard.press("1")
    check(until(page, "() => !!document.querySelector('.hq-cal-day')"), "1 brings up the day view")
    stops = page.evaluate("() => [...document.querySelectorAll('.hq-cal-day .hq-cal-slot')].filter((s) => s.tabIndex === 0).length")
    check(stops == 1, f"one hour cell per day is the tab stop ({stops})")

    # ↓ / ↑ walk the hours of the focused day.
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.keyboard.press("ArrowDown")
    hour = page.evaluate("() => document.activeElement.classList.contains('hq-cal-slot') && document.activeElement.dataset.hour")
    check(hour == "11", f"↓ walks from 10:00 to 11:00 in the same day ({hour})")
    ring = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth]; }")
    check(ring[0] == "solid" and ring[1] == "2px", f"the focused cell draws a visible ring {ring}")
    page.keyboard.press("ArrowUp")
    check(page.evaluate("() => document.activeElement.dataset.hour") == "10", "↑ comes back to 10:00")
    page.keyboard.press("Tab")
    check(page.evaluate("() => !document.activeElement.classList.contains('hq-cal-slot') && document.activeElement !== document.body"),
          "Tab leaves the hour grid instead of walking 24 slots")
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.keyboard.press("Escape")
    check(page.evaluate("() => document.activeElement.classList.contains('hq-cal-date-trigger')"),
          "Esc leaves the grid for the period title")

    # → in the day view slides to the next day and keeps the same hour focused.
    day0 = page.evaluate("() => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day")
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.keyboard.press("ArrowRight")
    check(until(page, """(d) => { const a = document.activeElement;
        return a.classList?.contains('hq-cal-slot') && a.dataset.day !== d && a.dataset.hour === '10'; }""", day0),
          "→ moves to the next day and keeps 10:00 focused")
    check(page.evaluate("() => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day === document.activeElement.dataset.day"),
          "the strip follows the focused day")
    page.keyboard.press("ArrowLeft")
    check(until(page, """(d) => { const a = document.activeElement;
        return a.classList?.contains('hq-cal-slot') && a.dataset.day === d; }""", day0), "← comes back to the first day")

    # Enter opens the focused hour; closing puts focus back on that hour (no trap, no orphan).
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.keyboard.press("Enter")
    check(open_sheet(page), "Entrée opens the editor on the focused hour")
    check(page.locator("#cal-start").input_value().endswith("10:00"), "with 10:00 filled in")
    page.keyboard.press("Escape")
    no_sheet(page)
    check(until(page, "() => document.activeElement.classList.contains('hq-cal-slot') && document.activeElement.dataset.hour === '10'"),
          "closing it returns focus to the same hour")

    # N creates on the focused day and hour; Ctrl+Entrée saves from the title field.
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="16"]').focus()
    page.keyboard.press("n")
    check(open_sheet(page), "N opens a new event from the grid")
    check(page.locator("#cal-start").input_value().endswith("16:00"), "on the focused hour")
    title = "Clavier " + label
    page.locator("#hq-cal-title").fill(title)
    page.keyboard.press("Control+Enter")
    no_sheet(page)
    focused_day = page.evaluate("() => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]').dataset.day")
    saved = server_until(page, base, date.fromisoformat(focused_day), title, lambda e: e["end"].endswith("T17:00"))
    check(saved and saved["start"].endswith("T16:00"), f"Ctrl+Entrée saves it on the focused day ({saved and saved['start']})")

    # The toolbar is a stable surface too: its bar and the focused control keep their exact nodes, so
    # a click already in flight cannot fall between a removed bar and its replacement.
    idle(page)
    page.evaluate("""() => {
        window.__calBar = document.querySelector('.hq-cal-bar');
        window.__calBarBtn = document.querySelector('.hq-cal-bar [data-cal="search"]');
        window.__calBarBtn.focus({ preventScroll: true }); }""")
    page.evaluate("() => window.hqCalendarShow()")
    check(idle(page), "the toolbar's background refresh finishes")
    check(page.evaluate("() => window.__calBar === document.querySelector('.hq-cal-bar')"),
          "the toolbar keeps its very node through a background refresh")
    check(page.evaluate("() => document.activeElement === window.__calBarBtn"),
          "a focused toolbar control survives the refresh")

    # A real click must round-trip through a background refresh that is still in flight: hold the
    # response, click the toolbar, then release it with new data. The click opens the options, the
    # in-place repaint keeps them open, and the bar and the clicked control stay the same nodes.
    idle(page)
    click_ev = event("Pendant le clic " + label, date.fromisoformat(focused_day), "05:00", "05:15")
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0, "event": click_ev}))
    check(r.ok, "an event lands before the held background refresh")
    held_refreshes = []
    pending = {"hold": True}

    def hold_background(route):
        if pending["hold"] and route.request.method == "GET":
            held_refreshes.append(route)
            return
        route.continue_()

    page.route("**/api/calendar?*", hold_background)
    try:
        page.evaluate("""() => {
            window.__clickBar = document.querySelector('.hq-cal-bar');
            window.__clickOptions = document.querySelector('.hq-cal-options-trigger'); }""")
        page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
        deadline = time.monotonic() + 6
        while not held_refreshes and time.monotonic() < deadline:
            page.wait_for_timeout(50)
        check(bool(held_refreshes), "the background refresh's response is held in flight")
        check(page.evaluate("() => document.querySelector('#hq-cal-app').dataset.busy === '1'"),
              "the app is still waiting on it before the click")

        page.locator(".hq-cal-options-trigger").click()
        check(page.evaluate("""() => {
            const trigger = document.querySelector('.hq-cal-options-trigger');
            const list = document.getElementById('hq-cal-option-list');
            return trigger === window.__clickOptions && trigger.getAttribute('aria-expanded') === 'true' && !list.hidden; }"""),
              "the click opens the options while the refresh is still in flight")
        check(page.evaluate("() => document.querySelector('#hq-cal-app').dataset.busy === '1'"),
              "the click is handled before the held response is released")

        pending["hold"] = False
        while held_refreshes:
            held_refreshes.pop().continue_()
        check(idle(page), "the held background refresh finishes")
        check(page.evaluate("(title) => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((node) => node.textContent.includes(title))",
            click_ev["title"]), "the held refresh actually repaints the new event")
        check(page.evaluate("() => window.__clickBar === document.querySelector('.hq-cal-bar')"),
              "the toolbar is the same node after the click and the in-place refresh")
        check(page.evaluate("() => window.__clickOptions === document.querySelector('.hq-cal-options-trigger')"),
              "the clicked control is the same node after the click and the in-place refresh")
        check(page.evaluate("""() => {
            const trigger = document.querySelector('.hq-cal-options-trigger');
            const list = document.getElementById('hq-cal-option-list');
            return trigger.getAttribute('aria-expanded') === 'true' && !list.hidden; }"""),
              "the click's open state survives the in-place refresh")
        page.locator(".hq-cal-options-trigger").click()
        check(until(page, "() => document.getElementById('hq-cal-option-list').hidden"),
              "the options close on a second click")
    finally:
        pending["hold"] = False
        for held_route in held_refreshes:
            held_route.continue_()
        page.unroute("**/api/calendar?*", hold_background)

    # A background refresh is non-destructive: an unchanged payload leaves the focused cell alone.
    idle(page)
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.evaluate("() => { window.__calCell = document.activeElement; }")
    page.evaluate("() => window.hqCalendarShow()")
    check(idle(page), "the background refresh finishes")
    check(page.evaluate("() => document.activeElement === window.__calCell"),
          "an unchanged refresh keeps the very cell you were on")
    check(page.evaluate("() => document.activeElement.dataset.hour === '10' && document.activeElement.tabIndex === 0"),
          "with its hour and its roving tab stop")

    # A genuine data change repaints in place: the focused cell, its tab stop and the scroll stay
    # put, an unchanged event keeps its very node, an edited one updates in its own node, a new one
    # arrives and a deleted one leaves — while the quick add keeps its text.
    idle(page)
    seed_day = date.fromisoformat(focused_day)
    anchor_title = "Ancre stable " + label
    edit_title = "À changer " + label
    gone_title = "À supprimer " + label
    for seeded in (event(anchor_title, seed_day, "08:00", "08:30"),
                   event(edit_title, seed_day, "09:00", "09:30"),
                   event(gone_title, seed_day, "13:30", "14:00")):
        r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                              data=json.dumps({"action": "save", "expected_rev": 0, "event": seeded}))
        check(r.ok, f"seeded “{seeded['title']}”")
    page.evaluate("() => window.hqCalendarShow()")
    check(idle(page), "the seeded events are drawn")
    quick = page.locator("#hq-cal-quick-input")
    quick.fill("Dentiste demain 9h30")
    quick.evaluate("(el) => el.setSelectionRange(7, 7)")
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.evaluate("() => { window.__calCell = document.activeElement; }")
    check(page.evaluate("() => window.__calCell.classList.contains('hq-cal-slot')"), "the cell holds focus when the data changes")
    page.evaluate("""() => { const s = document.querySelector('.hq-cal-stage .hq-cal-scroll');
        s.scrollTop = Math.round(s.scrollHeight * 0.25); window.__calScroll = s; window.__calTop = s.scrollTop; }""")
    found = page.evaluate("""(titles) => {
        const nodes = [...document.querySelectorAll('.hq-cal-day .hq-cal-event')];
        window.__keepEvent = nodes.find((node) => node.textContent.includes(titles[0]));
        window.__editEvent = nodes.find((node) => node.textContent.includes(titles[1]));
        window.__quick = document.querySelector('#hq-cal-quick-input');
        return { keep: !!window.__keepEvent, edit: !!window.__editEvent, top: window.__calTop }; }""", [anchor_title, edit_title])
    check(found["keep"] and found["edit"], "the events that will not change are on screen")
    check(found["top"] > 0, f"the grid is scrolled before the change ({found['top']}px)")

    added = event("Nouveau pendant la frappe " + label, seed_day, "12:00", "13:00")
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0, "event": added}))
    check(r.ok, "an event lands while a cell is focused")
    rows = api_events(page, base, seed_day)
    edit_item, gone_item = rows[edit_title], rows[gone_title]
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": edit_item["rev"],
                                           "event": {**edit_item, "title": "Changement " + label}}))
    check(r.ok, "an event is edited")
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "delete", "id": gone_item["id"], "expected_rev": gone_item["rev"]}))
    check(r.ok, "and another is deleted")
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")  # the app's own background sync
    check(idle(page), "the refresh that fetched it finishes")
    check(page.evaluate("() => document.activeElement === window.__calCell"),
          "the very cell you were on is still focused")
    check(page.evaluate("() => document.activeElement.dataset.hour === '10' && document.activeElement.tabIndex === 0"),
          "the focused hour survives a refresh that changed the grid")
    check(page.evaluate("() => [...document.querySelectorAll('.hq-cal-day .hq-cal-slot')].filter((s) => s.tabIndex === 0).length === 1"),
          "and the roving tab stop is still one cell")
    check(page.evaluate("""() => window.__calScroll === document.querySelector('.hq-cal-stage .hq-cal-scroll')
        && window.__calScroll.scrollTop === window.__calTop"""), "the grid keeps its scroll position")
    check(page.evaluate("""() => window.__quick === document.querySelector('#hq-cal-quick-input')
        && window.__quick.value === 'Dentiste demain 9h30' && window.__quick.selectionStart === 7"""),
          "the quick add keeps its typed text and caret")
    check(page.evaluate("""() => { const node = window.__keepEvent;
        return node.isConnected && document.querySelector('.hq-cal-day .hq-cal-event[data-id="' + node.dataset.id + '"]') === node; }"""),
          "an unchanged event keeps its very node")
    check(page.evaluate("""(title) => { const node = window.__editEvent;
        return node.isConnected && node.textContent.includes(title)
          && document.querySelector('.hq-cal-day .hq-cal-event[data-id="' + node.dataset.id + '"]') === node; }""",
        "Changement " + label), "the edited event is repainted inside its own node")
    check(page.evaluate("(title) => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((node) => node.textContent.includes(title))",
        added["title"]), "the added event is on screen")
    check(page.evaluate("(title) => ![...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((node) => node.textContent.includes(title))",
        gone_title), "the deleted event is gone")

    # And while someone is typing, a data change leaves the field, its text and its caret alone.
    page.evaluate("() => { window.__quick.focus(); window.__quick.setSelectionRange(7, 7); }")
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0,
                                           "event": event("Pendant la saisie " + label, seed_day, "15:00", "15:30")}))
    check(r.ok, "an event lands while the quick add is being typed in")
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    check(idle(page), "that refresh finishes")
    check(page.evaluate("() => document.activeElement === window.__quick"),
          "the quick add keeps focus through a data change")
    check(page.evaluate("""() => window.__quick.value === 'Dentiste demain 9h30'
        && window.__quick.selectionStart === 7 && window.__quick.selectionEnd === 7"""),
          "with the typed text and its caret exactly where they were")

    # Guard: typing never triggers a shortcut.
    quick = page.locator("#hq-cal-quick-input")
    quick.fill("")
    quick.focus()
    page.keyboard.type("2")
    check(page.evaluate("() => !!document.querySelector('.hq-cal-day')") and quick.input_value() == "2",
          "a digit typed in the quick add stays text and does not switch view")
    quick.fill("")

    # Week: ← → cross the visible day columns, ↑ ↓ change the hour.
    page.mouse.click(5, 5)
    page.keyboard.press("2")
    check(until(page, "() => !!document.querySelector('.hq-cal-week')"), "2 brings up the week view")
    first = page.evaluate("() => document.querySelector('.hq-cal-weekcol').dataset.colDay")
    page.locator(f'.hq-cal-weekcol[data-col-day="{first}"] .hq-cal-slot[data-hour="9"]').focus()
    page.keyboard.press("ArrowRight")
    check(until(page, """(d) => { const a = document.activeElement;
        return a.classList?.contains('hq-cal-slot') && a.dataset.day !== d && a.dataset.hour === '9'; }""", first),
          "→ crosses to the next day column at the same hour")
    page.keyboard.press("ArrowUp")
    check(page.evaluate("() => document.activeElement.dataset.hour") == "8", "↑ moves up an hour in that column")

    # A data change in the week keeps the focused hour and draws the new event in place.
    page.evaluate("() => { window.__weekCell = document.activeElement; }")
    week_key = page.evaluate("() => document.activeElement.dataset.day")
    week_ev = event("Semaine " + label, date.fromisoformat(week_key), "14:00", "14:30")
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0, "event": week_ev}))
    check(r.ok, "a week event lands")
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    check(idle(page), "the week refresh finishes")
    check(page.evaluate("() => document.activeElement === window.__weekCell"),
          "the focused week cell survives the change")
    check(page.evaluate("(title) => [...document.querySelectorAll('.hq-cal-week .hq-cal-event')].some((node) => node.textContent.includes(title))",
        week_ev["title"]), "and the new event appears in the week")

    # Agenda: ↑ ↓ walk the rows, Space opens one, Esc leaves for the period title.
    page.keyboard.press("4")
    check(until(page, "() => !!document.querySelector('.hq-cal-agenda')"), "4 brings up the agenda")
    rows = page.locator(".hq-cal-agenda .hq-cal-row")
    check(rows.count() >= 2, f"the agenda has rows to walk ({rows.count()})")
    rows.first.focus()
    page.keyboard.press("ArrowDown")
    check(page.evaluate("() => [...document.querySelectorAll('.hq-cal-agenda .hq-cal-row')].indexOf(document.activeElement)") == 1,
          "↓ walks to the next agenda row")
    page.keyboard.press("ArrowUp")
    check(page.evaluate("() => [...document.querySelectorAll('.hq-cal-agenda .hq-cal-row')].indexOf(document.activeElement)") == 0,
          "↑ comes back")
    page.keyboard.press("Escape")
    check(page.evaluate("() => document.activeElement.classList.contains('hq-cal-date-trigger')"), "Esc leaves the agenda")
    rows.first.focus()
    page.keyboard.press(" ")
    check(open_sheet(page), "Espace opens the focused agenda row")
    page.keyboard.press("Escape")
    no_sheet(page)

    # A data change in the agenda keeps the row you were on; the unchanged rows keep their nodes.
    rows.first.focus()
    page.evaluate("() => { window.__agendaRow = document.activeElement; }")
    agenda_day = page.evaluate("() => document.activeElement.dataset.day")
    agenda_ev = event("Agenda " + label, date.fromisoformat(agenda_day), "10:00", "10:30")
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0, "event": agenda_ev}))
    check(r.ok, "an agenda event lands")
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    check(idle(page), "the agenda refresh finishes")
    check(page.evaluate("() => document.activeElement === window.__agendaRow"),
          "the focused agenda row survives the change")

    # Month: arrows walk the 6 × 7 board.
    page.keyboard.press("3")
    check(until(page, "() => !!document.querySelector('.hq-cal-month')"), "3 brings up the month")
    page.locator(".hq-cal-mcell:not(.is-out) .hq-cal-mday").first.focus()
    before = page.evaluate("() => document.activeElement.dataset.day")
    page.keyboard.press("ArrowDown")
    after = page.evaluate("() => document.activeElement.dataset.day")
    check((date.fromisoformat(after) - date.fromisoformat(before)).days == 7,
          f"↓ moves a week down the month board ({before} → {after})")
    page.keyboard.press("ArrowRight")
    check((date.fromisoformat(page.evaluate("() => document.activeElement.dataset.day")) - date.fromisoformat(after)).days == 1,
          "→ moves one day across")

    # A data change in the month keeps the focused day and counts the new event in place.
    page.evaluate("() => { window.__monthDay = document.activeElement; }")
    month_key = page.evaluate("() => document.activeElement.dataset.day")
    count_js = """(key) => { const b = document.querySelector('.hq-cal-mday[data-day="' + key + '"]');
        const m = /(\d+) élément/.exec(b.getAttribute('aria-label') || ''); return m ? Number(m[1]) : 0; }"""
    before_count = page.evaluate(count_js, month_key)
    month_ev = event("Mois " + label, date.fromisoformat(month_key), "11:00", "11:30")
    r = page.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0, "event": month_ev}))
    check(r.ok, "a month event lands")
    page.evaluate("() => document.dispatchEvent(new Event('visibilitychange'))")
    check(idle(page), "the month refresh finishes")
    check(page.evaluate("() => document.activeElement === window.__monthDay"),
          "the focused month day survives the change")
    after_count = page.evaluate(count_js, month_key)
    check(after_count == before_count + 1, f"the new event is counted in its day ({before_count} → {after_count})")
    page.keyboard.press("Escape")
    check(page.evaluate("() => document.activeElement.classList.contains('hq-cal-date-trigger')"), "Esc leaves the month board")

    # Enter on a month cell hands the keyboard cursor to that day's grid, at 09:00.
    page.locator(".hq-cal-mcell:not(.is-out) .hq-cal-mday").first.focus()
    month_pick = page.evaluate("() => document.activeElement.dataset.day")
    page.keyboard.press("Enter")
    check(idle(page), "the month pick opens its day")
    landed = page.evaluate("""() => { const a = document.activeElement;
        return a.classList.contains('hq-cal-slot') ? [a.dataset.day, a.dataset.hour, a.tabIndex] : null; }""")
    check(landed is not None and landed[0] == month_pick and landed[1] == "9" and landed[2] == 0,
          f"focus lands on the picked day at 09:00 with its tab stop ({landed})")
    ring = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth]; }")
    check(ring[0] == "solid" and ring[1] == "2px", f"the handed-off cell draws its ring {ring}")
    check(until(page, """() => { const a = document.activeElement, s = a.closest('.hq-cal-scroll');
        if (!s) return false; const r = a.getBoundingClientRect(), sr = s.getBoundingClientRect();
        return r.top >= sr.top && r.bottom <= sr.bottom; }"""), "and the timeline scrolled it into view")
    page.keyboard.press("ArrowDown")
    moved = page.evaluate("() => [document.activeElement.dataset.day, document.activeElement.dataset.hour]")
    check(moved == [month_pick, "10"], f"the next arrow key moves inside the new day ({moved})")
    page.keyboard.press("Enter")
    check(open_sheet(page), "Enter right after opens the editor")
    picked_start = page.locator("#cal-start").input_value()
    check(picked_start.startswith(month_pick) and picked_start.endswith("10:00"),
          f"on the picked day and hour ({picked_start})")
    page.keyboard.press("Escape")
    no_sheet(page)

    # Enter on a day-strip day hands the cursor into that day too, at 09:00.
    picker = page.locator('.hq-cal-weekstrip button[aria-pressed="false"]').first
    picker.focus()
    strip_pick = picker.get_attribute("data-day")
    page.keyboard.press("Enter")
    check(idle(page), "the strip pick opens its day")
    landed = page.evaluate("""() => { const a = document.activeElement;
        return a.classList.contains('hq-cal-slot') ? [a.dataset.day, a.dataset.hour, a.tabIndex] : null; }""")
    check(landed is not None and landed[0] == strip_pick and landed[1] == "9" and landed[2] == 0,
          f"the strip hands focus to {strip_pick} at 09:00 ({landed})")
    ring = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth]; }")
    check(ring[0] == "solid" and ring[1] == "2px", f"the strip's cell draws its ring {ring}")
    page.keyboard.press("ArrowUp")
    moved = page.evaluate("() => [document.activeElement.dataset.day, document.activeElement.dataset.hour]")
    check(moved == [strip_pick, "8"], f"the next arrow moves inside the strip's new day ({moved})")
    page.keyboard.press("n")
    check(open_sheet(page), "N right after opens a new event")
    strip_start = page.locator("#cal-start").input_value()
    check(strip_start.startswith(strip_pick) and strip_start.endswith("08:00"),
          f"on the new day at the cursor hour ({strip_start})")
    page.keyboard.press("Escape")
    no_sheet(page)

    # T from inside the grid keeps the cursor in the grid, on today at the same hour.
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.keyboard.press("ArrowRight")
    check(until(page, "(d) => document.activeElement.dataset.day && document.activeElement.dataset.day !== d", today.isoformat()),
          "→ steps away from today inside the grid")
    page.keyboard.press("t")
    check(idle(page), "T redraws today")
    until(page, "() => document.activeElement.classList?.contains('hq-cal-slot')")
    t_focus = page.evaluate("""() => { const a = document.activeElement;
        return [a.classList.contains('hq-cal-slot'), a.dataset.day, a.dataset.hour, a.tagName + '.' + a.className]; }""")
    check(t_focus[0] and t_focus[1] == today.isoformat() and t_focus[2] == "10",
          f"focus stays in the grid on today at the same hour ({t_focus})")

    # Search from the keyboard: F opens it (the app-wide palette owns /), ↓ walks the results.
    page.keyboard.press("f")
    check(open_sheet(page) and page.evaluate("() => !!document.getElementById('hq-cal-search-input')"), "F opens the search")
    page.locator("#hq-cal-search-input").fill("e")
    check(until(page, "() => document.querySelectorAll('.hq-cal-search-result').length >= 2"), "the results are there")
    page.keyboard.press("ArrowDown")
    check(page.evaluate("() => document.activeElement.classList.contains('hq-cal-search-result')"), "↓ enters the results")
    page.keyboard.press("ArrowDown")
    check(page.evaluate("() => [...document.querySelectorAll('.hq-cal-search-result')].indexOf(document.activeElement)") == 1,
          "↓ walks to the second result")
    page.keyboard.press("ArrowUp")
    check(page.evaluate("() => [...document.querySelectorAll('.hq-cal-search-result')].indexOf(document.activeElement)") == 0,
          "↑ comes back to the first")
    page.keyboard.press("Enter")
    check(until(page, "() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.id === 'hq-cal-detail')"),
          "Enter opens the focused result")
    page.keyboard.press("Escape")
    no_sheet(page)

    # G, ? and T.
    page.keyboard.press("g")
    check(open_sheet(page) and page.evaluate("() => !!document.getElementById('hq-cal-date-jump')"), "G opens the date jump")
    page.keyboard.press("Escape")
    no_sheet(page)

    # A keyboard G jump carries the cursor into the jumped-to day's grid at the carried hour.
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    jump_target = (today + timedelta(days=9)).isoformat()
    page.keyboard.press("g")
    check(open_sheet(page) and page.evaluate("() => !!document.getElementById('hq-cal-date-jump')"), "G reopens the date jump from the grid")
    page.locator("#hq-cal-jump-input").fill(jump_target)
    page.locator("#hq-cal-date-jump").get_by_role("button", name="Aller à cette date").focus()
    page.keyboard.press("Enter")
    check(idle(page), "the G jump finishes")
    until(page, "() => document.activeElement.classList?.contains('hq-cal-slot')")
    landed = page.evaluate("""() => { const a = document.activeElement;
        return a.classList.contains('hq-cal-slot') ? [a.dataset.day, a.dataset.hour, a.tabIndex] : null; }""")
    check(landed is not None and landed[0] == jump_target and landed[1] == "10" and landed[2] == 0,
          f"G lands on the jumped-to day at the carried hour ({landed})")
    ring = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth]; }")
    check(ring[0] == "solid" and ring[1] == "2px", f"the G-jumped cell draws its ring {ring}")
    check(until(page, """() => { const a = document.activeElement, s = a.closest('.hq-cal-scroll');
        if (!s) return false; const r = a.getBoundingClientRect(), sr = s.getBoundingClientRect();
        return r.top >= sr.top && r.bottom <= sr.bottom; }"""), "and the timeline scrolled the G-jumped cell into view")
    page.keyboard.press("ArrowDown")
    moved = page.evaluate("() => [document.activeElement.dataset.day, document.activeElement.dataset.hour]")
    check(moved == [jump_target, "11"], f"the next arrow moves inside the G-jumped day ({moved})")
    page.keyboard.press("Enter")
    check(open_sheet(page), "Enter right after the G jump opens the editor")
    g_start = page.locator("#cal-start").input_value()
    check(g_start.startswith(jump_target) and g_start.endswith("11:00"), f"on the G-jumped day and hour ({g_start})")
    page.keyboard.press("Escape")
    no_sheet(page)
    page.keyboard.press("h")
    check(open_sheet(page) and page.evaluate("() => !!document.getElementById('hq-cal-gestures')"), "H opens the guide")
    keys = page.evaluate("() => [...document.querySelectorAll('#hq-cal-gestures .hq-cal-key')].map((k) => k.textContent)")
    check(len(keys) == 14 and "Ctrl + Entrée" in keys and "Ctrl + Z" in keys and "H" in keys and "E" in keys
          and "Page ↑ ↓" in keys and "Entrée" in keys and "Échap" in keys, f"the guide lists every keyboard key {keys}")
    page.keyboard.press("Escape")
    no_sheet(page)
    page.keyboard.press("1")
    check(until(page, "() => !!document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]')"), "1 returns to the day view")

    # A palette search result opens its day and carries the cursor into the grid at the carried hour.
    page.locator('.hq-cal-day .hq-cal-slot[data-hour="10"]').focus()
    page.keyboard.press("/")
    check(until(page, "() => { const p = document.getElementById('hq-palette'); return !!p && !p.hidden && document.activeElement?.id === 'hq-palette-input'; }"),
          "the palette opens over the grid")
    page.locator("#hq-palette-input").fill(week_ev["title"])
    check(until(page, """(title) => [...document.querySelectorAll('#hq-palette-list li')].some((li) => li.textContent.includes(title))""", week_ev["title"]),
          "the calendar event is in the palette")
    for _ in range(6):
        if page.evaluate("(t) => document.querySelector('#hq-palette-list li.active')?.textContent.includes(t)", week_ev["title"]):
            break
        page.keyboard.press("ArrowDown")
    check(page.evaluate("(t) => document.querySelector('#hq-palette-list li.active')?.textContent.includes(t)", week_ev["title"]),
          "the calendar event is the selected hit")
    page.keyboard.press("Enter")
    check(idle(page), "the search result opens its day")
    until(page, "() => document.activeElement.classList?.contains('hq-cal-slot')")
    landed = page.evaluate("""() => { const a = document.activeElement;
        return a.classList.contains('hq-cal-slot') ? [a.dataset.day, a.dataset.hour, a.tabIndex] : null; }""")
    check(landed is not None and landed[0] == week_key and landed[1] == "10" and landed[2] == 0,
          f"the search result lands on its day at the carried hour ({landed})")
    ring = page.evaluate("() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth]; }")
    check(ring[0] == "solid" and ring[1] == "2px", f"the search-opened cell draws its ring {ring}")
    check(until(page, """() => { const a = document.activeElement, s = a.closest('.hq-cal-scroll');
        if (!s) return false; const r = a.getBoundingClientRect(), sr = s.getBoundingClientRect();
        return r.top >= sr.top && r.bottom <= sr.bottom; }"""), "and the timeline scrolled the search day's cell into view")
    page.keyboard.press("ArrowDown")
    moved = page.evaluate("() => [document.activeElement.dataset.day, document.activeElement.dataset.hour]")
    check(moved == [week_key, "11"], f"the next arrow moves inside the searched day ({moved})")
    page.keyboard.press("n")
    check(open_sheet(page), "N right after the search open creates a new event")
    search_start = page.locator("#cal-start").input_value()
    check(search_start.startswith(week_key) and search_start.endswith("11:00"), f"on the searched day at the cursor hour ({search_start})")
    page.keyboard.press("Escape")
    no_sheet(page)
    page.mouse.click(5, 5)
    page.keyboard.press("ArrowRight")
    check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]')?.dataset.day !== d", today.isoformat()),
          "→ moves away from today")
    page.keyboard.press("t")
    check(until(page, "(d) => document.querySelector('.hq-cal-weekstrip button[aria-pressed=true]')?.dataset.day === d", today.isoformat()),
          "T comes back to today")


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-calview-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    today = date.today()
    browser = None
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            for label, viewport in (("phone", {"width": 375, "height": 812}), ("desktop", {"width": 1440, "height": 900})):
                ctx = browser.new_context(viewport=viewport, bypass_csp=True)
                page = ctx.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                login = ctx.request.post(base + "/login", headers={"Origin": base},
                                         form={"pin": info["admin_pin"]}, max_redirects=0)
                check(login.status == 303, "the fixture admin session is ready")
                if label == "phone":
                    for e in (event("Réunion équipe", today, "09:30", "10:30", "hq"), event("Dentiste", today, "14:00", "15:00", "appointment"),
                              event("Appel", today, "18:00", "18:30", "personal"), event("Lecture", today, "20:00", "21:00", "study"),
                              event("Anniversaire Léa", today + timedelta(days=2), cat="personal", all_day=True),
                              event("Hier passé", today - timedelta(days=1), "10:00", "11:00", "hq")):
                        r = ctx.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                                              data=json.dumps({"action": "save", "expected_rev": 0, "event": e}))
                        check(r.ok, "synthetic event saved: " + e["title"])
                print(f"[{label}]")
                page.goto(base + "/#calendrier", wait_until="domcontentloaded")
                page.locator("body.session-admin").wait_for(timeout=20000)
                check(until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')"), "the calendar renders")
                page.locator('#hq-cal-app [data-view="day"]').click()
                until(page, "() => !!document.querySelector('.hq-cal-day')")
                page.mouse.move(0, 0)  # a hovered slot is tinted on purpose
                page.wait_for_timeout(450)  # measure once the view has settled
                slots = page.evaluate("""() => [...document.querySelectorAll('.hq-cal-day .hq-cal-slot')].map((s) => { const r = s.getBoundingClientRect(), c = getComputedStyle(s);
                    return { w: r.width, h: r.height, bg: c.backgroundColor, radius: c.borderTopLeftRadius }; })""")
                col = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-col').getBoundingClientRect().width")
                # Phone density is one 44 px hour (48 on desktop), so ~9 h stay on screen.
                check(len(slots) == 24 and all(abs(s["w"] - col) < 1.5 and 43 <= s["h"] <= 49 for s in slots),
                      f"24 hour slots, each a full-width hour row ({slots[0]['w']:.0f}/{col:.0f} px, {slots[0]['h']:.0f} px high)")
                check(all(s["bg"] in ("rgba(0, 0, 0, 0)", "transparent") and s["radius"] == "0px" for s in slots), f"slots are flat and transparent (no pill buttons) {[ (s['bg'], s['radius']) for s in slots if s['bg'] not in ('rgba(0, 0, 0, 0)', 'transparent') or s['radius'] != '0px'][:3]}")
                rhythm = page.locator(".hq-cal-stage .hq-cal-slot").first.evaluate("(slot) => getComputedStyle(slot).backgroundImage")
                check(rhythm.startswith("linear-gradient"), "the timeline shows a quiet half-hour line at its default zoom")
                rows = page.evaluate("() => [...document.querySelector('.hq-cal-bar').children].map((c) => c.classList[0])")
                stacked = page.evaluate("() => { const [a, b] = [...document.querySelector('.hq-cal-bar').children]; return b.getBoundingClientRect().top > a.getBoundingClientRect().bottom - 2; }")
                check(rows == ["hq-cal-top", "hq-cal-views-row"] and stacked, f"the header is two stacked rows {rows}")
                check(page.locator(".hq-cal-today").count() == 0, "Aujourd'hui is hidden while today is on screen")
                page.locator('[data-cal="search"]').click()
                search = page.get_by_role("dialog", name="Rechercher un événement")
                search.get_by_role("searchbox").fill("reunion")
                search.get_by_role("button", name="Réunion équipe", exact=False).click()
                check(page.get_by_role("dialog", name="Réunion équipe").is_visible(), "search matches accents and opens the event")
                page.keyboard.press("Escape")
                no_sheet(page)
                labels = page.evaluate("() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event, .hq-cal-day .hq-cal-face')].map((e) => e.innerText.replace(/\\s+/g, ' ').trim())")
                check(any(t.startswith("Réunion équipe") and "09:30" in t for t in labels), f"events show the title before the start time {labels[:3]}")
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
                jump_date = (today + timedelta(days=70)).isoformat()
                page.locator(".hq-cal-date-trigger").click()
                jump = page.get_by_role("dialog", name="Aller à une date")
                jump.get_by_label("Date").fill(jump_date)
                jump.get_by_role("button", name="Aller à cette date").click()
                check(until(page, "(d) => !!document.querySelector('.hq-cal-month .hq-cal-mday[data-day=\"' + d + '\"]')", jump_date),
                      "the date picker jumps to the requested month")
                page.locator(".hq-cal-date-trigger").click()
                check(jump.get_by_label("Date").input_value() == jump_date, "the picker remembers the selected date")
                jump.get_by_role("button", name="Aujourd’hui").click()
                check(until(page, "() => !!document.querySelector('.hq-cal-month .hq-cal-mcell.is-today')"), "Aujourd’hui returns to the current month")
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
                    idle(page)
                    page.locator("#hq-cal-app [data-cal=next]").click()
                    check(until(page, "(t) => document.querySelector('.hq-cal-title').textContent !== t", first),
                          "› moves the phone week forward")
                    idle(page)  # the three fresh days are drawn before their headers are read
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

                # Categories are tinted differently; yesterday's event keeps full text opacity.
                tints = page.evaluate("""() => { const pick = (t) => { const e = [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].find((x) => x.innerText.includes(t));
                    const f = e && (e.querySelector('.hq-cal-face') || e); return f ? getComputedStyle(f).backgroundColor : null; }; return [pick('Réunion'), pick('Dentiste')]; }""")
                check(tints[0] and tints[1] and tints[0] != tints[1], f"each category has its own tint {tints}")
                page.locator("#hq-cal-app [data-cal=prev]").click()
                check(until(page, "() => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')].some((e) => e.innerText.includes('Hier passé') && e.classList.contains('is-past'))"),
                      "a finished event gets the past-event treatment")
                past = page.locator(".hq-cal-day .hq-cal-event.is-past", has_text="Hier passé")
                check(past.evaluate("(e) => getComputedStyle(e).opacity === '1' && getComputedStyle(e.querySelector('.hq-cal-face') || e).opacity === '1'"),
                      "the past event keeps its text at full opacity")
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
                keyboard_checks(page, base, label, today)
                check(not errors, f"no page errors {errors[:3]}")
                ctx.close()
            # Calendar keeps its gentle action feedback with system reduced motion enabled.
            ctx = browser.new_context(viewport={"width": 375, "height": 812}, bypass_csp=True, reduced_motion="reduce")
            page = ctx.new_page()
            login = ctx.request.post(base + "/login", headers={"Origin": base},
                                     form={"pin": info["admin_pin"]}, max_redirects=0)
            check(login.status == 303, "the reduced-motion fixture admin session is ready")
            page.goto(base + "/#calendrier", wait_until="domcontentloaded")
            page.locator("body.session-admin").wait_for(timeout=20000)
            until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')")
            page.locator('#hq-cal-app [data-view="day"]').click()
            page.locator("#hq-cal-app [data-cal=now]").click()
            now_animation = page.locator(".hq-cal-now.is-focused").evaluate("(line) => getComputedStyle(line).animationName")
            check(now_animation == "hq-cal-now-focus", f"Maintenant still highlights the current hour ({now_animation})")
            page.locator("#hq-cal-app [data-cal=next]").click()
            until(page, "() => document.querySelector('.hq-cal-stage').classList.contains('is-next')")
            slide = page.locator(".hq-cal-stage").evaluate("(stage) => getComputedStyle(stage).animationName")
            check(slide == "hq-cal-in-next", f"the day still eases in ({slide})")
            page.locator("#hq-cal-app [data-cal=free-slots]").click()
            sheet_animation = page.locator("#hq-cal-free-slots .hq-sheet-card").evaluate("(card) => getComputedStyle(card).animationName")
            check(sheet_animation == "hq-cal-morph", f"the free-slot sheet still eases in ({sheet_animation})")
            ctx.close()
            browser.close()
    finally:
        try:
            if browser is not None:
                browser.close()
        except Exception:
            pass
        proc.stdin.close()
        proc.kill()
        proc.wait(timeout=10)
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
