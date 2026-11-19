"""Recurring events in a real browser: create a weekly series through the editor, reload, read it
in day/week/month/agenda, search it, filter it, keep its occurrences out of free-slot search, edit
the whole series, and delete it immediately with the same Annuler/undo offer as a single event.

FORGE_BROWSER=chromium HQ_CAL_TEST_HOUR=9 python tests/visual_hq_calendar_recurrence_playwright.py
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
passed = 0
TITLE = "Série hebdo test"
RENAMED = "Série hebdo renommée"
DAILY = "Série quotidienne test"
ALL_DAY = "Série journée test"
MULTI = "Série multi test"
MULTI_RENAMED = "Série multi renommée"
KEY_SERIES = "Clavier série test"
KEY_SERIES_RENAMED = "Clavier série modifiée"


def check(cond: bool, message: str) -> None:
    global passed
    if not cond:
        raise SystemExit("FAIL: " + message)
    passed += 1
    print("  OK  ", message)


def until(page, js: str, arg=None, timeout: float = 8.0) -> bool:
    end = __import__("time").monotonic() + timeout
    while __import__("time").monotonic() < end:
        if page.evaluate(js, arg):
            return True
        page.wait_for_timeout(100)
    return False


def server_events(page, base: str, first: date, last: date) -> list[dict]:
    data = page.context.request.get(f"{base}/api/calendar?from={first.isoformat()}&to={last.isoformat()}").json()
    return data.get("items") or []


def titled(items: list[dict], title: str) -> list[dict]:
    return [item for item in items if item.get("title") == title]


def open_day(page, day: date) -> None:
    """Open a date through the month grid, the same path a user takes."""
    page.locator('#hq-cal-app [data-view="month"]').click()
    check(until(page, "() => !!document.querySelector('.hq-cal-month')"), f"the month grid opens for {day}")
    today_btn = page.locator('#hq-cal-app .hq-cal-today')
    if today_btn.is_visible():
        today_btn.click()
        page.wait_for_timeout(300)
    cell = page.locator(f'.hq-cal-mday[data-day="{day.isoformat()}"]')
    check(cell.count() == 1, f"the month grid carries {day}")
    cell.click()
    check(until(page, "() => !!document.querySelector('.hq-cal-day')"), f"the day view opens for {day}")
    page.wait_for_timeout(250)


def month_has(page, title: str, days: list[date]) -> bool:
    return bool(page.evaluate("""([title, days]) => days.every((day) => {
        const cell = [...document.querySelectorAll('.hq-cal-mcell')].find((node) =>
            node.querySelector('.hq-cal-mday[data-day="' + day + '"]'));
        return !!cell && [...cell.querySelectorAll('.hq-cal-chip')]
            .some((chip) => chip.textContent.includes(title));
    })""", [title, [day.isoformat() for day in days]]))


def week_has(page, title: str, day: date) -> bool:
    return bool(page.evaluate("""([title, day]) => {
        const cell = document.querySelector('.hq-cal-allcell[data-allday="' + day + '"]');
        return !!cell && [...cell.querySelectorAll('.hq-cal-chip')]
            .some((chip) => chip.textContent.includes(title));
    }""", [title, day.isoformat()]))


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-calrecur-"))
    env = dict(os.environ)
    env["HQ_CAL_TEST_HOUR"] = "9"
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    today = date.today()
    second = (today.weekday() + 2) % 7
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            ctx = browser.new_context(viewport={"width": 1100, "height": 850}, bypass_csp=True)
            page = ctx.new_page()
            errors: list[str] = []
            dialogs: list[str] = []
            page.on("pageerror", lambda exc: errors.append(str(exc)))
            page.on("dialog", lambda dialog: (dialogs.append(dialog.message), dialog.dismiss()))
            login = ctx.request.post(base + "/login", headers={"Origin": base}, form={"pin": info["admin_pin"]},
                                     max_redirects=0)
            check(login.status == 303, "the fixture admin session is ready")
            page.goto(base + "/#calendrier", wait_until="domcontentloaded")
            page.locator("body.session-admin").wait_for(timeout=20000)
            page.add_style_tag(content="#hq-debug-panel{display:none!important}")
            if page.locator('.bottom-nav [data-nav="calendrier"]').is_visible():
                page.locator('.bottom-nav [data-nav="calendrier"]').dispatch_event("click")
            check(until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')"), "the calendar renders")
            check(page.locator('.hq-cal-create').count() == 1, "the create control is available")

            # Create the series through the real editor: weekly, two chosen weekdays, stop after 4.
            page.locator(".hq-cal-create").click()
            check(until(page, "() => document.getElementById('hq-cal-editor-title')?.textContent === 'Nouvel événement'"),
                  "the editor opens for a new event")
            page.locator("#hq-cal-title").fill(TITLE)
            page.locator("#cal-start").fill(f"{today}T10:00")
            page.locator("#cal-end").fill(f"{today}T11:00")
            page.locator("#cal-repeat").select_option("weekly")
            check(page.locator(".hq-cal-repeat-days").is_visible(), "weekly repetition reveals the weekday picker")
            start_button = page.locator(f'.hq-cal-repeat-day[data-day="{today.weekday()}"]')
            second_button = page.locator(f'.hq-cal-repeat-day[data-day="{second}"]')
            check(start_button.get_attribute("aria-pressed") == "true", "the start weekday is selected by default")
            second_button.click()
            check(second_button.get_attribute("aria-pressed") == "true", "a second weekday can be chosen")
            page.locator("#cal-repeat-end").select_option("count")
            page.locator("#cal-repeat-count").fill("4")
            page.locator('.hq-cal-editor .hq-cal-catbtn[data-cat="study"]').click()
            check("4 occurrences" in page.locator(".hq-cal-repeat-note").inner_text(),
                  "the form explains the stop condition and occurrence count")
            page.locator('#hq-cal-editor button[type="submit"]').click()
            closed = until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)")
            check(closed, "the series saves and the editor closes" + ("" if closed else " — " + page.locator("#hq-cal-editor").inner_text()))

            first = today - timedelta(days=1)
            last = today + timedelta(days=40)
            items = server_events(page, base, first, last)
            series = [item for item in items if item.get("title") == TITLE]
            check(len(series) == 4, f"the server projects four occurrences ({len(series)})")
            check(all(item.get("series_id") for item in series), "every occurrence carries its series id")
            check(len({item["id"] for item in series}) == 4, "occurrence ids are distinct")
            check([item["start"][11:16] for item in series] == ["10:00"] * 4, "every occurrence keeps the series time")
            check([(item["start"][:10]) for item in series] == [
                today.isoformat(),
                (today + timedelta(days=(second - today.weekday()) % 7)).isoformat(),
                (today + timedelta(days=7)).isoformat(),
                (today + timedelta(days=7 + (second - today.weekday()) % 7)).isoformat(),
            ], "the chosen weekday set is used for the four occurrences")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            check(len(disk["events"]) == 1, "the backend stores one series record, not four rows")
            check(disk["events"][0]["recurrence"] == {
                "frequency": "weekly", "weekdays": sorted([today.weekday(), second]),
                "until": None, "count": 4,
            }, "the stored pattern is structured frequency + weekdays + count")

            # Reload and find it in each of the four views.
            page.reload(wait_until="domcontentloaded")
            page.locator("body.session-admin").wait_for(timeout=20000)
            page.add_style_tag(content="#hq-debug-panel{display:none!important}")
            if page.locator('.bottom-nav [data-nav="calendrier"]').is_visible():
                page.locator('.bottom-nav [data-nav="calendrier"]').dispatch_event("click")
            check(until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')"), "the calendar returns after reload")
            for view, scope in (("day", ".hq-cal-day"), ("week", ".hq-cal-weekcol"), ("month", ".hq-cal-month"), ("agenda", ".hq-cal-agenda")):
                page.locator(f'#hq-cal-app [data-view="{view}"]').click()
                page.wait_for_timeout(500)
                if view == "month":
                    check(page.locator(f"{scope} .hq-cal-chip", has_text=TITLE).count() >= 1,
                          "the weekly series renders in the month view")
                elif view == "agenda":
                    check(page.locator(f"{scope} .hq-cal-row", has_text=TITLE).count() >= 1,
                          "the weekly series renders in the agenda view")
                else:
                    check(page.locator(f"{scope} .hq-cal-event", has_text=TITLE).count() >= 1,
                          f"the weekly series renders in the {view} view")

            # Search returns one result per occurrence and marks it as a series.
            page.locator('#hq-cal-app [data-cal="search"]').click()
            page.locator("#hq-cal-search-input").fill(TITLE)
            check(until(page, "() => document.querySelectorAll('.hq-cal-search-result').length === 4"),
                  "search finds all four occurrences")
            check(all("Série" in row for row in page.locator(".hq-cal-search-result").all_inner_texts()),
                  "search results say that each match belongs to a series")
            page.locator(".hq-cal-search-result").first.click()
            check(until(page, "() => !!document.querySelector('#hq-cal-detail .hq-cal-series-note')"),
                  "opening a result shows the series scope in the detail sheet")

            # Editing from an occurrence edits the whole series.
            page.locator('#hq-cal-detail [data-sheet="edit"]').click()
            check(until(page, "() => document.getElementById('hq-cal-editor-title')?.textContent === 'Modifier la série'"),
                  "the editor labels the whole-series edit")
            check("Toutes les occurrences" in page.locator(".hq-cal-editor .hq-cal-series-note").inner_text(),
                  "the editor states that all occurrences change")
            check(page.locator("#cal-repeat").input_value() == "weekly", "the existing frequency is loaded")
            check(page.locator("#cal-repeat-count").input_value() == "4", "the existing count is loaded")
            page.locator("#hq-cal-title").fill(RENAMED)
            page.keyboard.press("Control+Enter")
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "the series edit closes the editor")
            items = server_events(page, base, first, last)
            renamed = [item for item in items if item.get("title") == RENAMED]
            check(len(renamed) == 4, "renaming one occurrence updates all four")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            check(len(disk["events"]) == 1 and disk["events"][0]["title"] == RENAMED,
                  "the single stored series keeps the new title")

            # Category filtering uses the occurrence's own category.
            page.locator('.hq-cal-options-trigger').click()
            page.locator('.hq-cal-option-list [data-cal="categories"]').click()
            page.locator('#hq-cal-categories .hq-cal-category-tag', has_text="Étude").click()
            page.locator('#hq-cal-categories button', has_text="Fermer").click()
            page.locator('#hq-cal-app [data-view="day"]').click()
            page.wait_for_timeout(400)
            check(page.locator(".hq-cal-day .hq-cal-event", has_text=RENAMED).count() >= 1,
                  "the series remains visible under its selected category filter")
            page.locator('.hq-cal-options-trigger').click()
            page.locator('.hq-cal-option-list [data-cal="categories"]').click()
            page.locator('#hq-cal-categories .hq-cal-category-tag', has_text="Personnel").click()
            page.locator('#hq-cal-categories .hq-cal-category-tag', has_text="Étude").click()
            page.locator('#hq-cal-categories button', has_text="Fermer").click()
            page.wait_for_timeout(400)
            check(page.locator(".hq-cal-day .hq-cal-event", has_text=RENAMED).count() == 0,
                  "deselecting the series category hides its occurrences")
            page.locator(".hq-cal-filter-clear").click()
            page.wait_for_timeout(400)
            check(page.locator(".hq-cal-day .hq-cal-event", has_text=RENAMED).count() >= 1,
                  "showing every category brings the series back")

            # Free-slot search must treat the occurrence as busy from 10:00 to 11:00.
            page.locator('#hq-cal-app [data-cal="free-slots"]').click()
            check(until(page, "() => !!document.querySelector('#hq-cal-free-slots .hq-cal-free-slot')"),
                  "free-slot search offers slots")
            slots = page.locator("#hq-cal-free-slots .hq-cal-free-slot strong").all_inner_texts()
            import re

            def minutes(text: str) -> tuple[int, int]:
                left, right = [part.strip() for part in text.split("–")]
                def one(value: str) -> int:
                    match = re.search(r"(\d{1,2})\s*(?:h|:)\s*(\d{2})", value)
                    if not match:
                        raise AssertionError(f"unreadable slot time {text!r}")
                    return int(match.group(1)) * 60 + int(match.group(2))
                return one(left), one(right)
            check(all(not (a < 11 * 60 and b > 10 * 60) for a, b in (minutes(text) for text in slots)),
                  f"no offered free slot overlaps the recurring occurrence ({slots})")
            page.locator("#hq-cal-free-slots button", has_text="Fermer").click()

            # A grip press explains why a single occurrence cannot be dragged, without changing the series.
            page.wait_for_timeout(300)
            grip = page.locator(".hq-cal-day .hq-cal-event", has_text=RENAMED).locator(".hq-cal-move-grip").first
            check(grip.count() == 1, "a recurring occurrence still has its own grip")
            box = grip.bounding_box()
            if box:
                page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                page.mouse.down()
                page.wait_for_timeout(80)
                page.mouse.move(1, 1)  # release off the block: not a click on the occurrence
                page.mouse.up()
                check(until(page, "() => document.body.innerText.includes('fait partie d’une série')", timeout=3),
                      "pressing the grip explains that the series must be edited from its sheet")
            page.wait_for_timeout(500)
            page.evaluate("() => document.querySelector('#hq-cal-detail [data-sheet=close]')?.click()")
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "no sheet is left open after the blocked drag")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            check(disk["events"][0]["start"] == f"{today}T10:00" and disk["events"][0]["end"] == f"{today}T11:00",
                  "the blocked drag leaves the stored series untouched")

            # Delete the series from one occurrence: immediate, in-app, and reversible exactly like
            # a single event. No page.once("dialog") here: a native confirm would fail the counter.
            page.locator('#hq-cal-app [data-view="day"]').click()
            page.wait_for_timeout(400)
            page.locator(".hq-cal-day .hq-cal-event", has_text=RENAMED).first.click()
            check(until(page, "() => !!document.querySelector('#hq-cal-detail')"), "the occurrence detail opens")
            page.locator('#hq-cal-detail [data-sheet="delete"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "deleting the series closes the detail immediately")
            items = server_events(page, base, first, last)
            check(not [item for item in items if item.get("title") == RENAMED], "no occurrence remains after series deletion")
            check(not dialogs, f"series deletion opens no native browser dialog ({dialogs})")
            check(until(page, "() => document.querySelector('.hq-cal-undo-text').textContent.startsWith('Série supprimée')"),
                  "series deletion offers the same Annuler affordance")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            check(disk["events"] == [], "the single stored series is gone")

            # Annuler restores the whole series, announces it, and focuses the restored occurrence.
            page.locator("#hq-cal-undo .hq-cal-undo-btn").click()
            check(until(page, """(title) => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')]
                .some((node) => node.innerText.includes(title))""", RENAMED), "Annuler restores the series in the day view")
            restored = titled(server_events(page, base, first, last), RENAMED)
            check(len(restored) == 4, f"Annuler restores all four occurrences ({len(restored)})")
            check(until(page, """(title) => !!document.activeElement?.classList.contains('hq-cal-event')
                && document.activeElement.innerText.includes(title)""", RENAMED),
                  "Annuler focuses the restored occurrence")
            check(until(page, "() => (document.getElementById('hq-cal-live')?.textContent || '').includes('Suppression annulée')"),
                  "Annuler announces the restored deletion")

            # Delete it again to continue the rest of the suite from an empty calendar.
            page.locator(".hq-cal-day .hq-cal-event", has_text=RENAMED).first.click()
            check(until(page, "() => !!document.querySelector('#hq-cal-detail')"), "the restored occurrence detail opens")
            page.locator('#hq-cal-detail [data-sheet="delete"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "the restored series deletes immediately too")
            items = server_events(page, base, first, last)
            check(not [item for item in items if item.get("title") == RENAMED], "no occurrence remains after the second deletion")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            check(disk["events"] == [], "the restored series is gone from storage as one record")

            # A daily series stopping on a date also works through the editor.
            page.locator(".hq-cal-create").click()
            check(until(page, "() => document.getElementById('hq-cal-editor-title')?.textContent === 'Nouvel événement'"),
                  "the editor reopens for a second series")
            page.locator("#hq-cal-title").fill(DAILY)
            page.locator("#cal-start").fill(f"{today}T12:00")
            page.locator("#cal-end").fill(f"{today}T12:30")
            page.locator("#cal-repeat").select_option("daily")
            check(page.locator(".hq-cal-repeat-days").is_hidden(), "daily repetition hides the weekday picker")
            page.locator("#cal-repeat-end").select_option("until")
            page.locator("#cal-repeat-until").fill((today + timedelta(days=2)).isoformat())
            check("jusqu’au" in page.locator(".hq-cal-repeat-note").inner_text(),
                  "the form explains the end date")
            page.locator('#hq-cal-editor button[type="submit"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "the daily series saves and the editor closes")
            daily = [item for item in server_events(page, base, first, last) if item.get("title") == DAILY]
            check([item["start"][:10] for item in daily] == [
                today.isoformat(), (today + timedelta(days=1)).isoformat(), (today + timedelta(days=2)).isoformat(),
            ], "the daily series stops on the chosen date")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            check(disk["events"][0]["recurrence"] == {
                "frequency": "daily", "weekdays": [], "until": (today + timedelta(days=2)).isoformat(), "count": None,
            }, "the daily series stores its structured end date")

            # All-day daily series, counted: it must behave as an ordinary all-day event.
            all_days = [today + timedelta(days=offset) for offset in range(3)]
            page.locator(".hq-cal-create").click()
            check(until(page, "() => document.getElementById('hq-cal-editor-title')?.textContent === 'Nouvel événement'"),
                  "the editor opens for the all-day series")
            page.locator("#cal-all-day").check()
            check(page.locator("#cal-start").get_attribute("type") == "date" and
                  page.locator("#cal-end").get_attribute("type") == "date",
                  "the all-day switch turns both bounds into dates")
            page.locator("#hq-cal-title").fill(ALL_DAY)
            page.locator("#cal-start").fill(all_days[0].isoformat())
            page.locator("#cal-end").fill(all_days[0].isoformat())
            page.locator("#cal-repeat").select_option("daily")
            page.locator("#cal-repeat-end").select_option("count")
            page.locator("#cal-repeat-count").fill("3")
            page.locator('.hq-cal-editor .hq-cal-catbtn[data-cat="study"]').click()
            page.locator('#hq-cal-editor button[type="submit"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "the all-day series saves")
            all_occurrences = titled(server_events(page, base, today - timedelta(days=3), today + timedelta(days=10)), ALL_DAY)
            check([(item["start"], item["end"]) for item in all_occurrences] == [
                (day.isoformat(), (day + timedelta(days=1)).isoformat()) for day in all_days
            ], "the all-day daily series has three one-day occurrences")
            check(all(item.get("all_day") and item.get("series_id") for item in all_occurrences),
                  "the all-day occurrences are projected as all-day series items")
            check(not titled(server_events(page, base, today - timedelta(days=10), today - timedelta(days=1)), ALL_DAY),
                  "the all-day series has nothing before its start")
            check(not titled(server_events(page, base, today + timedelta(days=3), today + timedelta(days=10)), ALL_DAY),
                  "the all-day counted series has nothing after its last occurrence")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            stored_all = next(item for item in disk["events"] if item["title"] == ALL_DAY)
            check(stored_all["recurrence"] == {"frequency": "daily", "weekdays": [], "until": None, "count": 3},
                  "the all-day series stores its counted pattern")

            # Day, month, week and agenda use the ordinary all-day surfaces.
            page.locator('#hq-cal-app [data-view="day"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-day')"), "the day view opens on the all-day series")
            all_chip = page.locator(".hq-cal-allday .hq-cal-chip", has_text=ALL_DAY)
            check(all_chip.count() == 1, "the all-day occurrence sits in the day all-day lane")
            check("cat-study" in (all_chip.first.get_attribute("class") or ""), "the all-day occurrence keeps its category colour class")
            all_chip.first.click()
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); const c = s && s.querySelector('.hq-sheet-card'); return !!c && s.getBoundingClientRect().width > 0; }"),
                  "the all-day occurrence opens its details")
            all_detail = page.locator("#hq-cal-detail").inner_text()
            check(ALL_DAY in all_detail and "Toute la journée" in all_detail, f"the all-day details show a whole-day date ({all_detail!r})")
            check("Toute modification ou suppression s’applique à toutes les occurrences" in all_detail,
                  "the all-day details carry the whole-series note")
            check(page.locator('#hq-cal-detail [data-sheet="edit"]').inner_text() == "Modifier la série",
                  "the all-day details label the series edit")
            page.keyboard.press("Escape")
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)"), "the all-day details close")

            page.locator('#hq-cal-app [data-view="month"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-month')"), "the month view opens for the all-day series")
            check(month_has(page, ALL_DAY, all_days), "the all-day daily occurrences cover their month cells")
            page.locator('#hq-cal-app [data-view="week"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-week')"), "the week view opens for the all-day series")
            all_week_seen = {day for day in all_days if week_has(page, ALL_DAY, day)}
            for _ in range(2):
                if len(all_week_seen) == len(all_days):
                    break
                page.locator('#hq-cal-app [data-cal="next"]').click()
                page.wait_for_timeout(300)
                all_week_seen |= {day for day in all_days if week_has(page, ALL_DAY, day)}
            check(all_week_seen == set(all_days), "the all-day occurrences cover the week's all-day cells")
            open_day(page, today)
            page.locator('#hq-cal-app [data-view="agenda"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-agenda')"), "the agenda opens for the all-day series")
            check(page.evaluate("""(title) => [...document.querySelectorAll('.hq-cal-row')]
                .filter((row) => row.innerText.includes(title))
                .every((row) => row.querySelector('time')?.innerText === 'Journée')""", ALL_DAY),
                  "the agenda labels each all-day occurrence as a whole day")
            all_agenda_days = page.evaluate("""(title) => [...document.querySelectorAll('.hq-cal-row')]
                .filter((row) => row.innerText.includes(title)).map((row) => row.dataset.day).sort()""", ALL_DAY)
            check(all_agenda_days == [day.isoformat() for day in all_days], "the agenda lists every all-day occurrence")

            # A weekly all-day pattern whose occurrences last three days, ending on a date.
            next_month_first = date(today.year + (today.month == 12), today.month % 12 + 1, 1)
            multi_start = next_month_first - timedelta(days=9)
            multi_last = multi_start + timedelta(days=2)
            multi_until = multi_start + timedelta(days=9)  # the last day of the second span
            multi_first_span = [multi_start + timedelta(days=offset) for offset in range(3)]
            multi_second_span = [multi_start + timedelta(days=7 + offset) for offset in range(3)]
            page.locator(".hq-cal-create").click()
            check(until(page, "() => document.getElementById('hq-cal-editor-title')?.textContent === 'Nouvel événement'"),
                  "the editor opens for the multi-day series")
            page.locator("#cal-all-day").check()
            page.locator("#hq-cal-title").fill(MULTI)
            page.locator("#cal-start").fill(multi_start.isoformat())
            page.locator("#cal-end").fill(multi_last.isoformat())
            page.locator("#cal-repeat").select_option("weekly")
            page.locator(f'.hq-cal-repeat-day[data-day="{multi_start.weekday()}"]').click()
            page.locator("#cal-repeat-end").select_option("until")
            page.locator("#cal-repeat-until").fill(multi_until.isoformat())
            page.locator('.hq-cal-editor .hq-cal-catbtn[data-cat="study"]').click()
            page.locator('#hq-cal-editor button[type="submit"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "the multi-day weekly series saves")
            multi_occurrences = titled(server_events(page, base, multi_start - timedelta(days=10), multi_until + timedelta(days=5)), MULTI)
            check([(item["start"], item["end"]) for item in multi_occurrences] == [
                (multi_start.isoformat(), (multi_start + timedelta(days=3)).isoformat()),
                ((multi_start + timedelta(days=7)).isoformat(), (multi_start + timedelta(days=10)).isoformat()),
            ], "the weekly multi-day series keeps a three-day span for each occurrence")
            check(all(item.get("all_day") and item.get("series_id") for item in multi_occurrences),
                  "the multi-day occurrences are all-day series items")
            check(not titled(server_events(page, base, multi_start - timedelta(days=10), multi_start - timedelta(days=1)), MULTI),
                  "the multi-day series has nothing before its start")
            check(not titled(server_events(page, base, multi_until + timedelta(days=1), multi_until + timedelta(days=10)), MULTI),
                  "the multi-day series has nothing after its stop date")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            stored_multi = next(item for item in disk["events"] if item["title"] == MULTI)
            check(stored_multi["recurrence"] == {
                "frequency": "weekly", "weekdays": [multi_start.weekday()], "until": multi_until.isoformat(), "count": None,
            }, "the multi-day series stores its weekday and stop date")

            # Every day is visible in the all-day band; the second span crosses the month boundary.
            page.locator('#hq-cal-app [data-view="month"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-month')"), "the month view opens on the multi-day series")
            check(month_has(page, MULTI, multi_first_span + multi_second_span),
                  "every day of both multi-day spans is in its month cell")
            page.locator('#hq-cal-app [data-view="week"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-week')"), "the week view opens on the multi-day series")
            multi_week_seen = {day for day in multi_first_span + multi_second_span if week_has(page, MULTI, day)}
            for _ in range(3):
                if len(multi_week_seen) == 6:
                    break
                page.locator('#hq-cal-app [data-cal="next"]').click()
                page.wait_for_timeout(300)
                multi_week_seen |= {day for day in multi_first_span + multi_second_span if week_has(page, MULTI, day)}
            check(multi_week_seen == set(multi_first_span + multi_second_span),
                  "the multi-day span covers every week column it touches")
            open_day(page, multi_start)
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI).count() == 1,
                  "the multi-day occurrence starts in the day all-day lane")
            page.locator('#hq-cal-app [data-cal="next"]').click()
            page.wait_for_timeout(300)
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI).count() == 1,
                  "the multi-day occurrence continues in the next day's all-day lane")
            page.locator('#hq-cal-app [data-cal="next"]').click()
            page.wait_for_timeout(300)
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI).count() == 1,
                  "the multi-day occurrence reaches the month-boundary day's all-day lane")
            open_day(page, multi_start + timedelta(days=7))
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI).count() == 1,
                  "the second multi-day occurrence has its own day all-day lane")
            open_day(page, multi_start)
            page.locator('#hq-cal-app [data-view="agenda"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-agenda')"), "the agenda opens on the multi-day series")
            multi_agenda_days = page.evaluate("""(title) => [...document.querySelectorAll('.hq-cal-row')]
                .filter((row) => row.innerText.includes(title)).map((row) => row.dataset.day).sort()""", MULTI)
            check(multi_agenda_days == [day.isoformat() for day in multi_first_span + multi_second_span],
                  "the agenda repeats the multi-day occurrence on every covered day")
            check(page.evaluate("""(title) => [...document.querySelectorAll('.hq-cal-row')]
                .filter((row) => row.innerText.includes(title))
                .every((row) => row.querySelector('time')?.innerText === 'Journée')""", MULTI),
                  "the agenda labels the multi-day rows as whole days")

            # Details/edit/delete stay series-scoped for the all-day multi-day occurrence.
            open_day(page, multi_start)
            page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI).first.click()
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); const c = s && s.querySelector('.hq-sheet-card'); return !!c && s.getBoundingClientRect().width > 0; }"),
                  "the multi-day occurrence details open")
            multi_detail = page.locator("#hq-cal-detail").inner_text()
            check("Toute la journée" in multi_detail and " au " in multi_detail,
                  f"the multi-day details show the correct whole-day span ({multi_detail!r})")
            check("Toute modification ou suppression s’applique à toutes les occurrences" in multi_detail,
                  "the multi-day details carry the whole-series note")
            page.locator('#hq-cal-detail [data-sheet="edit"]').click()
            check(until(page, "() => document.getElementById('hq-cal-editor-title')?.textContent === 'Modifier la série'"),
                  "the multi-day editor labels the series edit")
            check(page.locator("#cal-all-day").is_checked() and page.locator("#cal-start").get_attribute("type") == "date",
                  "the multi-day editor keeps its all-day bounds")
            page.locator("#hq-cal-title").fill(MULTI_RENAMED)
            page.locator('#hq-cal-editor button[type="submit"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "the multi-day series edit saves")
            renamed_multi = titled(server_events(page, base, multi_start - timedelta(days=10), multi_until + timedelta(days=5)), MULTI_RENAMED)
            check(len(renamed_multi) == 2, "renaming the multi-day series updates both occurrences")

            # Search, category filter and free-slot exclusion see all-day occurrences.
            page.locator('#hq-cal-app [data-cal="search"]').click()
            page.locator("#hq-cal-search-input").fill(MULTI_RENAMED)
            check(until(page, "() => document.querySelectorAll('.hq-cal-search-result').length === 2"),
                  "search finds both multi-day occurrences")
            check(all("Série" in row and "Toute la journée" in row for row in page.locator(".hq-cal-search-result").all_inner_texts()),
                  "search marks all-day series results as whole-day series")
            page.locator("#hq-cal-search button", has_text="Fermer").click()
            page.locator('#hq-cal-app [data-cal="search"]').click()
            page.locator("#hq-cal-search-input").fill(ALL_DAY)
            check(until(page, "() => document.querySelectorAll('.hq-cal-search-result').length === 3"),
                  "search finds all three all-day daily occurrences")
            check(all("Série" in row and "Toute la journée" in row for row in page.locator(".hq-cal-search-result").all_inner_texts()),
                  "search marks the daily all-day results as whole-day series")
            page.locator("#hq-cal-search button", has_text="Fermer").click()
            page.locator('#hq-cal-app [data-view="day"]').click()
            page.wait_for_timeout(300)
            page.locator(".hq-cal-options-trigger").click()
            page.locator('.hq-cal-option-list [data-cal="categories"]').click()
            page.locator('#hq-cal-categories .hq-cal-category-tag', has_text="Étude").click()
            page.locator('#hq-cal-categories button', has_text="Fermer").click()
            page.wait_for_timeout(300)
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI_RENAMED).count() == 1,
                  "the all-day series survives its category filter")
            page.locator(".hq-cal-options-trigger").click()
            page.locator('.hq-cal-option-list [data-cal="categories"]').click()
            page.locator('#hq-cal-categories .hq-cal-category-tag', has_text="Personnel").click()
            page.locator('#hq-cal-categories .hq-cal-category-tag', has_text="Étude").click()
            page.locator('#hq-cal-categories button', has_text="Fermer").click()
            page.wait_for_timeout(300)
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI_RENAMED).count() == 0,
                  "deselecting the all-day series category hides it")
            page.locator(".hq-cal-filter-clear").click()
            page.wait_for_timeout(300)
            for free_day in multi_first_span:
                open_day(page, free_day)
                page.locator('#hq-cal-app [data-cal="free-slots"]').click()
                check(until(page, "() => !!document.querySelector('#hq-cal-free-slots')"),
                      f"free-slot search opens on {free_day}")
                check(page.locator("#hq-cal-free-slots .hq-cal-free-slot").count() == 0 and
                      "Aucun créneau" in page.locator('#hq-cal-free-slots .hint[role="status"]').inner_text(),
                      f"the multi-day all-day occurrence removes every free slot on {free_day}")
                page.locator("#hq-cal-free-slots button", has_text="Fermer").click()

            # A drag gesture on the all-day chip is blocked with the series message, not a move.
            page.locator('#hq-cal-app [data-view="day"]').click()
            page.wait_for_timeout(300)
            check(page.evaluate("""(title) => {
                const chip = [...document.querySelectorAll('.hq-cal-allday .hq-cal-chip')]
                    .find((node) => node.textContent.includes(title));
                return !!chip && !chip.hasAttribute('data-grip') && !chip.hasAttribute('data-resize') &&
                    !chip.querySelector('[data-grip], .hq-cal-resize');
            }""", MULTI_RENAMED), "an all-day series chip exposes no resize handle")
            drag_chip = page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI_RENAMED).first
            drag_box = drag_chip.bounding_box()
            if drag_box:
                page.mouse.move(drag_box["x"] + 20, drag_box["y"] + 10)
                page.mouse.down()
                page.mouse.move(drag_box["x"] + 56, drag_box["y"] + 10, steps=4)
                page.mouse.up()
                check(until(page, "() => document.body.innerText.includes('fait partie d’une série')"),
                      "dragging an all-day series occurrence explains the series scope")
            check(not page.evaluate("() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden)"),
                  "the blocked all-day drag opens no sheet")

            # Reload keeps the same rendered dates and spans; then delete the multi-day series as a whole.
            page.reload(wait_until="domcontentloaded")
            page.locator("body.session-admin").wait_for(timeout=20000)
            page.add_style_tag(content="#hq-debug-panel{display:none!important}")
            if page.locator('.bottom-nav [data-nav="calendrier"]').is_visible():
                page.locator('.bottom-nav [data-nav="calendrier"]').dispatch_event("click")
            check(until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')"), "the calendar returns with the all-day series")
            page.locator('#hq-cal-app [data-view="month"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-month')"), "the month grid returns after reload")
            check(month_has(page, ALL_DAY, all_days), "the all-day daily occurrences survive reload in the month grid")
            check(month_has(page, MULTI_RENAMED, multi_first_span + multi_second_span),
                  "both multi-day spans survive reload in the month grid")
            open_day(page, multi_start)
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI_RENAMED).count() == 1,
                  "the multi-day occurrence survives reload in the day all-day lane")
            page.locator('#hq-cal-app [data-view="week"]').click()
            check(until(page, "() => !!document.querySelector('.hq-cal-week')"), "the week view returns after reload")
            reload_week_seen = {day for day in multi_first_span + multi_second_span if week_has(page, MULTI_RENAMED, day)}
            for _ in range(3):
                if len(reload_week_seen) == 6:
                    break
                page.locator('#hq-cal-app [data-cal="next"]').click()
                page.wait_for_timeout(300)
                reload_week_seen |= {day for day in multi_first_span + multi_second_span if week_has(page, MULTI_RENAMED, day)}
            check(reload_week_seen == set(multi_first_span + multi_second_span),
                  "the multi-day spans survive reload in the week columns")
            open_day(page, multi_start)
            check(page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI_RENAMED).count() == 1,
                  "the reloaded multi-day day lane is back at the start date")
            page.locator(".hq-cal-allday .hq-cal-chip", has_text=MULTI_RENAMED).first.click()
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); const c = s && s.querySelector('.hq-sheet-card'); return !!c && s.getBoundingClientRect().width > 0; }"),
                  "the reloaded multi-day detail opens")
            page.locator('#hq-cal-detail [data-sheet="delete"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "deleting the all-day multi-day series closes the detail immediately")
            check(until(page, "() => document.querySelector('.hq-cal-undo-text').textContent.startsWith('Série supprimée')"),
                  "the all-day multi-day series offers Annuler")
            check(not titled(server_events(page, base, multi_start - timedelta(days=10), multi_until + timedelta(days=5)), MULTI_RENAMED),
                  "deleting the multi-day occurrence removes both occurrences")
            disk = json.loads((root / "hq_calendar.json").read_text(encoding="utf-8"))
            check(not [item for item in disk["events"] if item["title"] == MULTI_RENAMED],
                  "the multi-day series is removed from storage as one record")

            # Delete the all-day daily series too; it also edits/deletes as a series.
            open_day(page, today)
            page.locator(".hq-cal-allday .hq-cal-chip", has_text=ALL_DAY).first.click()
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); const c = s && s.querySelector('.hq-sheet-card'); return !!c && s.getBoundingClientRect().width > 0; }"),
                  "the reloaded all-day daily detail opens")
            page.locator('#hq-cal-detail [data-sheet="delete"]').click()
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "deleting the all-day daily series closes the detail immediately")
            check(until(page, "() => document.querySelector('.hq-cal-undo-text').textContent.startsWith('Série supprimée')"),
                  "the all-day daily series offers Annuler")
            check(not titled(server_events(page, base, today - timedelta(days=3), today + timedelta(days=10)), ALL_DAY),
                  "deleting the all-day daily series removes all three occurrences")

            # ---- keyboard-only loop: no pointer, from navigation through create/edit/delete ----
            def active():
                return page.evaluate("""() => { const a = document.activeElement; return {
                    tag: a ? a.tagName : '', cls: String(a && a.className || ''), id: a && a.dataset ? a.dataset.id || '' : '',
                    day: a && a.dataset ? a.dataset.day || '' : '', hour: a && a.dataset ? a.dataset.hour || '' : '',
                    text: a ? (a.innerText || a.value || '').trim().slice(0, 90) : '',
                }; }""")

            def live_text():
                return page.evaluate("() => document.getElementById('hq-cal-live')?.textContent || ''")

            def wait_live(fragment: str) -> bool:
                return until(page, "(needle) => (document.getElementById('hq-cal-live')?.textContent || '').includes(needle)", fragment)

            def tab_to(text: str, limit: int = 12) -> bool:
                for _ in range(limit):
                    page.keyboard.press("Tab")
                    if text in active()["text"]:
                        return True
                return False

            page.evaluate("""() => { window.__calPointer = 0;
                for (const name of ['pointerdown', 'mousedown']) document.addEventListener(name, () => { window.__calPointer += 1; }, true);
            }""")
            page.locator("#hq-cal-app .hq-cal-date-trigger").focus()
            page.keyboard.press("1")
            check(until(page, "() => !!document.querySelector('.hq-cal-day')"), "keyboard: 1 opens the day view")
            page.keyboard.press("t")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: T finishes on today")

            # G is a keyboard-only way into the grid: it lands on the carried hour (09:00 here).
            page.keyboard.press("g")
            check(until(page, "() => !!document.querySelector('#hq-cal-date-jump')"), "keyboard: G opens the date jump")
            page.keyboard.press("Enter")
            check(until(page, "() => document.activeElement.classList.contains('hq-cal-slot')"),
                  "keyboard: the date jump lands in the grid")
            entered = active()
            check(entered["day"] == today.isoformat() and entered["hour"] == "9",
                  f"keyboard: the grid cursor is today at 09:00 ({entered['day']} {entered['hour']})")
            ring = page.evaluate("""() => { const s = getComputedStyle(document.activeElement);
                return { style: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow, offset: s.outlineOffset }; }""")
            check(ring["style"] == "solid" and ring["width"] == "2px" and ring["shadow"] != "none" and ring["offset"].startswith("-"),
                  f"keyboard: the focused cell has an inset high-contrast ring ({ring})")

            # A visible shortcut guide lists the keyboard path (H), and Escape returns to the cell.
            page.keyboard.press("h")
            check(until(page, "() => !!document.getElementById('hq-cal-gestures')"), "keyboard: H opens the shortcut guide")
            guide_keys = page.evaluate("() => [...document.querySelectorAll('#hq-cal-gestures .hq-cal-key')].map((node) => node.textContent)")
            guide_text = page.locator("#hq-cal-gestures").inner_text()
            check(len(guide_keys) == 14 and "E" in guide_keys and "Page ↑ ↓" in guide_keys and "Entrée" in guide_keys
                  and "Échap" in guide_keys and "Ctrl + Z" in guide_keys,
                  f"keyboard: the guide lists every shortcut ({guide_keys})")
            check("Parcourir les événements" in guide_text and "Période précédente" in guide_text,
                  "keyboard: the guide explains event and period navigation")
            page.keyboard.press("Escape")
            check(until(page, "() => document.activeElement.classList.contains('hq-cal-slot')"),
                  "keyboard: Escape from the guide returns to the grid cell")

            # Shortcuts stay inert while typing in the quick-add input, including PageDown.
            page.locator("#hq-cal-quick-input").focus()
            page.keyboard.type("n t 1 2")
            page.keyboard.press("PageDown")
            check(page.evaluate("() => !!document.querySelector('.hq-cal-day')") and
                  page.locator("#hq-cal-quick-input").input_value() == "n t 1 2",
                  "keyboard: shortcuts do not fire while typing in the quick add")
            page.keyboard.press("Control+a")
            page.keyboard.press("Backspace")
            page.locator(".hq-cal-day .hq-cal-slot[data-hour='9']").focus()

            # Create a counted series from the keyboard and confirm it lands in the current day.
            page.keyboard.press("n")
            check(until(page, "() => document.activeElement.id === 'hq-cal-title'"), "keyboard: N opens the editor on the focused hour")
            page.keyboard.type(KEY_SERIES)
            page.locator("#cal-repeat").focus()
            page.keyboard.press("ArrowDown")
            check(page.locator("#cal-repeat").input_value() == "daily", "keyboard: the repeat select becomes daily")
            page.locator("#cal-repeat-end").focus()
            page.keyboard.press("ArrowDown")
            page.keyboard.press("ArrowDown")
            check(page.locator("#cal-repeat-end").input_value() == "count", "keyboard: the end select becomes counted")
            page.locator("#cal-repeat-count").focus()
            page.keyboard.press("Control+a")
            page.keyboard.type("2")
            page.keyboard.press("Control+Enter")
            check(until(page, "() => document.getElementById('hq-cal-editor').hidden || document.getElementById('hq-cal-editor').classList.contains('is-closing')"),
                  "keyboard: Ctrl+Enter saves the new series")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: the saved series refresh finishes")
            created = titled(server_events(page, base, today - timedelta(days=2), today + timedelta(days=5)), KEY_SERIES)
            check(len(created) == 2 and all(item.get("series_id") for item in created),
                  "keyboard: the counted daily series has two projected occurrences")
            check(page.locator(".hq-cal-day .hq-cal-event", has_text=KEY_SERIES).count() >= 1,
                  "keyboard: the saved series appears in the current day view")
            check(wait_live("Ajouté") and "Clavier" in live_text(), "keyboard: saving is announced in the live region")
            saved_active = active()
            check(saved_active["cls"].find("hq-cal-event") >= 0 and saved_active["id"],
                  f"keyboard: focus lands on the saved occurrence ({saved_active})")

            # View and period navigation from the keyboard, with announcements and focus in the new view.
            page.keyboard.press("2")
            check(until(page, "() => !!document.querySelector('.hq-cal-week')"), "keyboard: 2 opens the week view")
            check(until(page, "() => document.activeElement.classList.contains('hq-cal-slot')"),
                  "keyboard: the week view receives the grid cursor")
            page.keyboard.press("3")
            check(until(page, "() => !!document.querySelector('.hq-cal-month')"), "keyboard: 3 opens the month view")
            check(until(page, "() => document.activeElement.classList.contains('hq-cal-mday')"),
                  "keyboard: the month view focuses a date cell")
            month_ring = page.evaluate("""() => { const s = getComputedStyle(document.activeElement);
                return { style: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow, offset: s.outlineOffset }; }""")
            check(month_ring["style"] == "solid" and month_ring["width"] == "2px" and month_ring["shadow"] != "none" and month_ring["offset"].startswith("-"),
                  f"keyboard: the focused month date keeps its ring inside the cell ({month_ring})")
            month_before = active()["day"]
            page.keyboard.press("PageDown")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: PageDown changes the month")
            check(active()["day"] != month_before and active()["cls"].find("hq-cal-mday") >= 0,
                  "keyboard: the month cursor follows PageDown")
            check(wait_live("Vue mois") or wait_live("Jour"), "keyboard: the month change is announced")
            page.keyboard.press("PageUp")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: PageUp returns to the first month")

            page.keyboard.press("2")
            check(until(page, "() => !!document.querySelector('.hq-cal-week')"), "keyboard: 2 returns to the week view")
            week_before = active()["day"]
            page.keyboard.press("PageDown")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: PageDown changes the week")
            check(active()["day"] != week_before and active()["cls"].find("hq-cal-slot") >= 0,
                  "keyboard: the week cursor follows PageDown")
            page.keyboard.press("PageUp")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: PageUp returns to the original week")
            page.keyboard.press("4")
            check(until(page, "() => !!document.querySelector('.hq-cal-agenda')"), "keyboard: 4 opens the agenda")
            check(until(page, "() => document.activeElement.classList.contains('hq-cal-row')"),
                  "keyboard: the agenda list receives focus")
            page.keyboard.press("1")
            check(until(page, "() => !!document.querySelector('.hq-cal-day')"), "keyboard: 1 returns to the day view")
            check(until(page, "() => document.activeElement.classList.contains('hq-cal-slot')"),
                  "keyboard: the day grid receives focus again")
            page.keyboard.press("t")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: T returns to today")

            # E cycles onto an occurrence; Enter opens its sheet; Escape returns to that occurrence.
            page.keyboard.press("e")
            event_focus = active()
            check(event_focus["cls"].find("hq-cal-event") >= 0 and event_focus["id"],
                  f"keyboard: E moves focus onto an event ({event_focus})")
            event_id = event_focus["id"]
            event_ring = page.evaluate("""() => { const s = getComputedStyle(document.activeElement);
                return { style: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow, offset: s.outlineOffset }; }""")
            check(event_ring["style"] == "solid" and event_ring["width"] == "2px" and event_ring["shadow"] != "none" and event_ring["offset"].startswith("-"),
                  f"keyboard: the focused event has a visible inset ring ({event_ring})")
            page.keyboard.press("Enter")
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); return !!s && !s.hidden && s.getBoundingClientRect().width > 0; }"),
                  "keyboard: Enter opens the event sheet")
            check(KEY_SERIES in page.locator("#hq-cal-detail").inner_text(), "keyboard: the sheet shows the event")
            page.keyboard.press("Escape")
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "keyboard: Escape closes the event sheet")
            check(active()["id"] == event_id, "keyboard: focus returns to the triggering occurrence")

            # Cancel the whole-series editor and return to the same occurrence.
            page.keyboard.press("Enter")
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); return !!s && !s.hidden; }"), "keyboard: the event sheet reopens")
            check(tab_to("Modifier la série"), "keyboard: Tab reaches the whole-series edit action")
            page.keyboard.press("Enter")
            check(until(page, "() => document.activeElement.id === 'hq-cal-title'"), "keyboard: the series editor opens on its title")
            page.keyboard.press("3")
            check("3" in page.locator("#hq-cal-title").input_value(), "keyboard: number shortcuts do not fire in the editor")
            page.keyboard.press("Escape")
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "keyboard: Escape cancels the editor")
            check(active()["id"] == event_id, "keyboard: cancel restores focus to the triggering occurrence")
            check(len(titled(server_events(page, base, today - timedelta(days=2), today + timedelta(days=5)), KEY_SERIES)) == 2,
                  "keyboard: cancelling the detail deletes nothing")

            # Edit the series, then delete it immediately with a day-cell fallback.
            page.keyboard.press("Enter")
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); return !!s && !s.hidden; }"), "keyboard: the event sheet opens for editing")
            check(tab_to("Modifier la série"), "keyboard: Tab reaches edit again")
            page.keyboard.press("Enter")
            check(until(page, "() => document.activeElement.id === 'hq-cal-title'"), "keyboard: the editor opens for the edit")
            page.keyboard.press("Control+a")
            page.keyboard.type(KEY_SERIES_RENAMED)
            page.keyboard.press("Control+Enter")
            check(until(page, "() => document.getElementById('hq-cal-editor').hidden || document.getElementById('hq-cal-editor').classList.contains('is-closing')"),
                  "keyboard: Ctrl+Enter saves the edit")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: the edit refresh finishes")
            renamed = titled(server_events(page, base, today - timedelta(days=2), today + timedelta(days=5)), KEY_SERIES_RENAMED)
            check(len(renamed) == 2, "keyboard: editing one occurrence updates the whole series")
            check(wait_live("Série modifiée"), "keyboard: the edit is announced in the live region")
            page.keyboard.press("Enter")
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); return !!s && !s.hidden; }"), "keyboard: the edited sheet opens for deletion")
            check(tab_to("Supprimer la série"), "keyboard: Tab reaches the whole-series delete action")
            page.keyboard.press("Enter")
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "keyboard: deleting the series closes the sheet immediately")
            check(until(page, "() => document.querySelector('.hq-cal-undo-text').textContent.startsWith('Série supprimée')"),
                  "keyboard: the series delete offers Annuler")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: the delete refresh finishes")
            check(not titled(server_events(page, base, today - timedelta(days=2), today + timedelta(days=5)), KEY_SERIES_RENAMED),
                  "keyboard: the whole series is gone")
            deleted_focus = active()
            check(deleted_focus["cls"].find("hq-cal-slot") >= 0 and deleted_focus["day"] == today.isoformat(),
                  f"keyboard: delete lands focus on the triggering day cell ({deleted_focus})")
            check(wait_live("Série supprimée"), "keyboard: the deletion is announced in the live region")

            # The Annuler bar is at the end of the page; Ctrl+Z brings undo to the calendar surface.
            page.keyboard.press("Control+z")
            check(until(page, """(title) => [...document.querySelectorAll('.hq-cal-day .hq-cal-event')]
                .some((node) => node.innerText.includes(title))""", KEY_SERIES_RENAMED),
                  "keyboard: Ctrl+Z restores the deleted series")
            restored = titled(server_events(page, base, today - timedelta(days=2), today + timedelta(days=5)), KEY_SERIES_RENAMED)
            check(len(restored) == 2, f"keyboard: Ctrl+Z restores both occurrences ({len(restored)})")
            check(until(page, """(title) => !!document.activeElement?.classList.contains('hq-cal-event')
                && document.activeElement.innerText.includes(title)""", KEY_SERIES_RENAMED),
                  "keyboard: Ctrl+Z focuses the restored occurrence")
            check(wait_live("Suppression annulée"), "keyboard: Ctrl+Z announces the undo")

            # Delete again from the keyboard to leave the loop in its final deleted state.
            page.keyboard.press("Enter")
            check(until(page, "() => { const s = document.querySelector('#hq-cal-detail'); return !!s && !s.hidden; }"),
                  "keyboard: the restored occurrence detail opens")
            check(tab_to("Supprimer la série"), "keyboard: Tab reaches delete after undo")
            page.keyboard.press("Enter")
            check(until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                  "keyboard: the second delete closes the sheet")
            check(until(page, "() => !document.getElementById('hq-cal-app').dataset.busy"), "keyboard: the second delete refresh finishes")
            check(not titled(server_events(page, base, today - timedelta(days=2), today + timedelta(days=5)), KEY_SERIES_RENAMED),
                  "keyboard: the second delete removes the series again")
            final_focus = active()
            check(final_focus["cls"].find("hq-cal-slot") >= 0 and final_focus["day"] == today.isoformat(),
                  f"keyboard: the second delete returns focus to the day cell ({final_focus})")
            check(wait_live("Série supprimée"), "keyboard: the second delete is announced")

            surface = page.evaluate("""() => { const root = document.getElementById('hq-cal-app'); const bar = document.querySelector('.hq-cal-bar');
                const stage = document.querySelector('.hq-cal-stage'); const live = document.getElementById('hq-cal-live'); return {
                    rootRole: root.getAttribute('role'), rootLabel: root.getAttribute('aria-label'),
                    barRole: bar.getAttribute('role'), barLabel: bar.getAttribute('aria-label'),
                    stageRole: stage.getAttribute('role'), stageLabel: stage.getAttribute('aria-label'),
                    liveRole: live.getAttribute('role'), liveMode: live.getAttribute('aria-live'), liveText: live.textContent,
                }; }""")
            check(surface["rootRole"] == "region" and surface["rootLabel"] == "Calendrier",
                  "keyboard: the calendar root is a labelled region")
            check(surface["barRole"] == "toolbar" and "Calendrier" in surface["barLabel"],
                  "keyboard: the calendar toolbar has a toolbar role and label")
            check(surface["stageRole"] == "region" and surface["stageLabel"].startswith("Vue jour"),
                  f"keyboard: the active view is a labelled region ({surface['stageLabel']})")
            check(surface["liveRole"] == "status" and surface["liveMode"] == "polite" and surface["liveText"],
                  "keyboard: the live region is a polite status with an announcement")
            check(page.evaluate("() => window.__calPointer") == 0, "keyboard: the whole loop used no pointer input")
            check(not dialogs, f"the whole suite opened no native browser dialog ({dialogs})")

            # WebKit reports CORS noise from unrelated shell panels (inbox, desk, client log).
            relevant_errors = [error for error in errors
                               if not any(noise in error for noise in ("api/hq/client-log", "api/desk/leave", "api/inbox", "api/securia/status"))]
            check(not relevant_errors, f"the page has no uncaught calendar errors ({relevant_errors[:2]})")
            print("PASS", passed, "checks")
            browser.close()
    finally:
        proc.kill()
        proc.wait(timeout=5)
        import shutil
        shutil.rmtree(root, ignore_errors=True)
        if proc.stderr:
            err = proc.stderr.read().decode("utf-8", "replace")
            if err.strip():
                print(err[-2000:])


if __name__ == "__main__":
    main()
