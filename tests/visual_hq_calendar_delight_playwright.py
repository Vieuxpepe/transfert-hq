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
    r = page.context.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                          data=json.dumps({"action": "save", "expected_rev": 0, "event": ev}))
    return r.json().get("event") if r.ok else None


def events_on(page, base, day):
    data = page.context.request.get(f"{base}/api/calendar?from={day.isoformat()}&to={(day + timedelta(days=1)).isoformat()}").json()
    return {item["title"]: item for item in data.get("items") or []}


ERGO_JS = r"""
() => {
  const out = { hits: [], overlaps: [], clipped: [], off: [], small: [], doc: null, count: 0 };
  const app = document.getElementById('hq-cal-app');
  const sheet = [...document.querySelectorAll('.hq-sheet')].find((s) => !s.hidden && s.getBoundingClientRect().width > 0);
  const scope = sheet ? [sheet] : [app, document.getElementById('btn-search-bar')].filter(Boolean);
  const label = (el) => (el.tagName + '.' + (typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30) + '"');
  const sr = (el) => { const r = el.getBoundingClientRect(), c = getComputedStyle(el); return r.width <= 1 || r.height <= 1 || (c.clip && c.clip !== 'auto') || (c.clipPath && c.clipPath !== 'none'); };
  const seen = (el) => {
    if (!el || el.disabled) return false;
    const c = getComputedStyle(el);
    if (c.visibility === 'hidden' || c.display === 'none' || c.pointerEvents === 'none' || c.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth;
  };
  const list = [];
  const isCtl = 'button, input, select, textarea, a[href], [role=button], [tabindex]:not([tabindex="-1"])';
  for (const s of scope) {
    if (s.matches(isCtl) && seen(s) && !s.classList.contains('hq-cal-event')) list.push(s);
    for (const el of s.querySelectorAll(isCtl)) if (seen(el) && !el.classList.contains('hq-cal-event')) list.push(el);  // event blocks are time-proportional overlays, not discrete targets
  }
  out.count = list.length;
  for (const el of list) {
    const r = el.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) out.hits.push([label(el), Math.round(r.width), Math.round(r.height)]);
    if (r.left < -1 || r.right > innerWidth + 1) out.off.push([label(el), Math.round(r.left), Math.round(r.right)]);
  }
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j];
    if (a.parentElement !== b.parentElement || a.contains(b) || b.contains(a)) continue;
    const A = a.getBoundingClientRect(), B = b.getBoundingClientRect();
    const ox = Math.min(A.right, B.right) - Math.max(A.left, B.left);
    const oy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
    if (ox > 1 && oy > 1) out.overlaps.push([label(a), label(b), Math.round(ox), Math.round(oy)]);
  }
  for (const s of scope) for (const el of s.querySelectorAll('*')) {
    const c = getComputedStyle(el), r = el.getBoundingClientRect();
    if (!r.width || !r.height || sr(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join(' ').trim();
    if (own) { const px = parseFloat(c.fontSize); if (px > 0 && px < 12) out.small.push([label(el), own.slice(0, 24), px]); }
    if (!el.childElementCount && (el.textContent || '').trim() && c.overflow !== 'visible') {
      const cx = el.scrollWidth > el.clientWidth + 1, cy = el.scrollHeight > el.clientHeight + 1;
      const nw = c.whiteSpace === 'nowrap' || c.whiteSpace === 'pre';
      if ((cx && nw && c.textOverflow !== 'ellipsis') || cy) out.clipped.push([label(el), el.textContent.trim().slice(0, 30)]);
    }
  }
  if (document.documentElement.scrollWidth > innerWidth + 1) out.doc = [document.documentElement.scrollWidth, innerWidth];
  return out;
}
"""

FOCUS_JS = r"""
() => {
  const app = document.getElementById('hq-cal-app');
  const sheet = [...document.querySelectorAll('.hq-sheet')].find((s) => !s.hidden && s.getBoundingClientRect().width > 0);
  const scope = sheet ? [sheet] : [app, document.getElementById('btn-search-bar')].filter(Boolean);
  const list = [];
  const focusable = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"]), .hq-cal-slot';
  const add = (el) => {
    const c = getComputedStyle(el), r = el.getBoundingClientRect();
    if (c.visibility === 'hidden' || c.display === 'none' || r.width === 0 || r.height === 0) return;
    if (!list.includes(el)) list.push(el);
  };
  for (const s of scope) {
    if (s.matches(focusable)) add(s);
    for (const el of s.querySelectorAll(focusable)) add(el);
  }
  const fails = [];
  for (const el of list) {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const b = getComputedStyle(el);
    const base = [b.outlineStyle, b.outlineWidth, b.outlineColor, b.boxShadow, b.borderColor, b.backgroundColor].join('|');
    el.focus({ preventScroll: true });
    if (document.activeElement !== el) continue;
    const a = getComputedStyle(el);
    const on = [a.outlineStyle, a.outlineWidth, a.outlineColor, a.boxShadow, a.borderColor, a.backgroundColor].join('|');
    const ring = a.outlineStyle !== 'none' && parseFloat(a.outlineWidth) >= 1;
    const other = a.boxShadow !== b.boxShadow || a.borderColor !== b.borderColor || a.backgroundColor !== b.backgroundColor;
    if (!(ring || other) || on === base) fails.push(el.tagName + '.' + (typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 2).join('.') : '') + ' "' + (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24) + '"');
  }
  return { count: list.length, fails };
}
"""


def ergonomics(page, viewport, view):
    data = page.evaluate(ERGO_JS)
    check(not data["hits"] and not data["overlaps"],
          f"{viewport} {view}: every discrete control is at least 44x44 with no overlapping neighbors {data['hits'][:4]} {data['overlaps'][:3]}")
    check(not data["clipped"] and not data["small"] and not data["off"] and not data["doc"],
          f"{viewport} {view}: no clipped text, no text under 12px, no horizontal overflow, no control outside the viewport {data['clipped'][:3]} {data['small'][:3]} {data['off'][:3]} {data['doc']}")


def ergonomics_focus(page, viewport, view):
    page.keyboard.press("Tab")
    data = page.evaluate(FOCUS_JS)
    check(not data["fails"],
          f"{viewport} {view}: a visible focus indicator paints on all {data['count']} keyboard-reachable controls {data['fails'][:4]}")


def ergonomics_short_events(page, viewport, touch):
    titles = ("Ergonomie avant", "Ergonomie 30 min", "Ergonomie après",
              "Ergonomie 15 min", "Ergonomie 15 voisine", "Ergonomie 15 après")
    for title in titles:
        page.evaluate("""(title) => {
            const el = [...document.querySelectorAll('.hq-cal-event[data-id]')].find((e) => (e.getAttribute('aria-label') || '').includes(title));
            if (el) el.scrollIntoView({ block: 'center' });
        }""", title)
        page.wait_for_timeout(250)
        rect = page.evaluate("""(title) => {
            const el = [...document.querySelectorAll('.hq-cal-event[data-id]')].find((e) => (e.getAttribute('aria-label') || '').includes(title));
            if (!el) return null;
            const face = el.querySelector('.hq-cal-face') || el;
            const f = face.getBoundingClientRect(), h = el.getBoundingClientRect();
            const scroll = document.querySelector('.hq-cal-scroll')?.getBoundingClientRect();
            const strip = document.querySelector('.hq-cal-weekstrip')?.getBoundingClientRect();
            return { x: f.left + f.width / 2, y: f.top + f.height / 2, fw: f.width, fh: f.height,
                     hw: h.width, hh: h.height, top: h.top, bottom: h.bottom,
                     st: scroll ? scroll.top : 0, sb: scroll ? scroll.bottom : 0,
                     strip: strip ? strip.bottom : 0 };
        }""", title)
        if not rect:
            check(False, f"{viewport}: {title} is in the day grid")
            continue
        check(rect["hh"] >= 43.5 and rect["hw"] >= 43.5,
              f"{viewport}: {title}: a 44 px target around a {rect['fw']:.0f}x{rect['fh']:.0f} block ({rect['hw']:.0f}x{rect['hh']:.0f})")
        check(8 <= rect["fh"] < 44,
              f"{viewport}: {title}: the visible block keeps its real time height ({rect['fh']:.0f} px)")
        check(rect["top"] >= rect["st"] - 1 and rect["bottom"] <= rect["sb"] + 1 and rect["top"] >= rect["strip"] - 1,
              f"{viewport}: {title}: the halo stays inside the grid, clear of the week strip")
        if touch:
            page.touchscreen.tap(rect["x"], rect["y"])
        else:
            page.mouse.click(rect["x"], rect["y"])
        opened = ""
        end = time.monotonic() + 2.0
        while time.monotonic() < end:
            opened = page.evaluate("""() => {
                const s = [...document.querySelectorAll('.hq-sheet')].find((s) => !s.hidden && s.getBoundingClientRect().width > 0);
                return s ? ((s.querySelector('#hq-cal-detail-title') || {}).textContent || '') : '';
            }""")
            if opened == title:
                break
            page.wait_for_timeout(100)
        check(opened == title, f"{viewport}: tapping {title} selects it, not a neighbour ({opened!r})")
        page.keyboard.press("Escape")
        until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)")
        page.wait_for_timeout(550)  # let the detail-to-block morph finish before the next tap
    strip = page.locator('.hq-cal-weekstrip button[aria-pressed="true"]')
    if strip.count():
        strip.click()
        page.wait_for_timeout(250)
        check(page.evaluate("() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
              f"{viewport}: the week strip keeps its own target over a short event")


def empty_slot_under_short_halo(page, viewport, touch_mode, today):
    """Tap the rim of an empty hour slot that lies under a short event's transparent halo."""
    page.evaluate("""() => {
        const el = [...document.querySelectorAll('.hq-cal-event.is-halo[data-id]')].find((e) =>
            (e.getAttribute('aria-label') || '').includes('Ergonomie 15 après'));
        if (!el) return;
        const col = el.closest('[data-col-day]');
        const slot = col && [...col.querySelectorAll('.hq-cal-slot')].find((s) => {
            const r = s.getBoundingClientRect();
            const halo = el.getBoundingClientRect();
            return r.top > halo.top + 1 && r.top < halo.bottom - 2;
        });
        if (slot) slot.scrollIntoView({ block: 'center' });
    }""")
    page.wait_for_timeout(250)
    geom = page.evaluate("""() => {
        const el = [...document.querySelectorAll('.hq-cal-event.is-halo[data-id]')].find((e) =>
            (e.getAttribute('aria-label') || '').includes('Ergonomie 15 après'));
        if (!el) return null;
        const halo = el.getBoundingClientRect();
        const col = el.closest('[data-col-day]');
        const slot = col && [...col.querySelectorAll('.hq-cal-slot')].find((s) => {
            const r = s.getBoundingClientRect();
            return r.top > halo.top + 1 && r.top < halo.bottom - 2;
        });
        if (!slot) return null;
        const r = slot.getBoundingClientRect();
        const x = halo.left + halo.width / 2;
        const y = r.top + 3; // the slot's own top rim, still inside the event halo
        const hit = document.elementFromPoint(x, y);
        const face = el.querySelector('.hq-cal-face')?.getBoundingClientRect();
        return { x, y, hour: slot.dataset.hour, selected: hit === slot,
                 hit: hit ? (hit.tagName + '.' + (typeof hit.className === 'string' ? hit.className : '')) : '',
                 faceBottom: face ? face.bottom : null, slotTop: r.top };
    }""")
    check(bool(geom and geom["selected"]),
          f"{viewport}: an empty slot rim under the short-event halo stays an empty-slot target {geom}")
    if not geom:
        return
    if touch_mode:
        page.touchscreen.tap(geom["x"], geom["y"])
    else:
        page.mouse.click(geom["x"], geom["y"])
    check(until(page, "() => document.getElementById('hq-cal-editor-title')?.textContent === 'Nouvel événement'"),
          f"{viewport}: tapping that rim starts a new event")
    start = page.locator("#cal-start").input_value()
    check(start.startswith(today) and f"T{geom['hour'].zfill(2)}:00" in start,
          f"{viewport}: the rim creates at its own hour ({start!r})")
    page.keyboard.press("Escape")
    until(page, "() => ![...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)")


def drag_short_blocks(page, base, viewport, touch_mode, today):
    """Drag every seeded 15/30-minute block by its visible face. The face is now the press target,
    including where a former halo used to paint over it. Each move is checked on the server and then
    put back."""
    titles = ("Ergonomie avant", "Ergonomie 30 min", "Ergonomie après",
              "Ergonomie 15 min", "Ergonomie 15 voisine", "Ergonomie 15 après")
    hour_px = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-slot')?.getBoundingClientRect().height || 48")
    step = max(6, hour_px / 4)  # one 15-minute snap
    for index, title in enumerate(titles):
        page.evaluate("""(title) => {
            const el = [...document.querySelectorAll('.hq-cal-event[data-id]')].find((e) => (e.getAttribute('aria-label') || '').includes(title));
            const scroll = document.querySelector('.hq-cal-scroll');
            if (!el || !scroll) return;
            const r = el.getBoundingClientRect(), s = scroll.getBoundingClientRect();
            const top = r.top - s.top + scroll.scrollTop;
            scroll.scrollTop = top - scroll.clientHeight / 2 + r.height / 2;
        }""", title)
        page.wait_for_timeout(300)
        geom = page.evaluate("""(title) => {
            const el = [...document.querySelectorAll('.hq-cal-event[data-id]')].find((e) => (e.getAttribute('aria-label') || '').includes(title));
            if (!el) return null;
            const face = el.querySelector('.hq-cal-face') || el;
            const f = face.getBoundingClientRect();
            const scroll = document.querySelector('.hq-cal-scroll')?.getBoundingClientRect();
            const strip = document.querySelector('.hq-cal-weekstrip')?.getBoundingClientRect();
            const x = f.left + Math.max(4, f.width * 0.12);
            const y = f.top + f.height * 0.8;
            const top = document.elementFromPoint(x, y)?.closest?.('.hq-cal-event[data-id]');
            return { x, y, target: el.dataset.id, top: top?.dataset.id || '', inside: !!scroll && !!strip && y > Math.max(scroll.top, strip.bottom) && y < scroll.bottom - 1,
                     scrollTop: document.querySelector('.hq-cal-scroll')?.scrollTop || 0,
                     scroll: scroll ? [scroll.top, scroll.bottom] : null, strip: strip ? strip.bottom : null,
                     face: [f.top, f.bottom], faceHeight: f.height };
        }""", title)
        check(bool(geom and geom["inside"]), f"{viewport}: {title} is reachable in the grid for a drag {geom}")
        check(bool(geom["top"] and geom["top"] == geom["target"]),
              f"{viewport}: the press point on {title} belongs to its visible face, not a halo")
        before = events_on(page, base, today)
        if title not in before:
            check(False, f"{viewport}: {title} is on the server before its drag")
        if touch_mode:
            touch(page, "pointerdown", geom["x"], geom["y"], 41)
            page.wait_for_timeout(470)  # the long press turns the press into a drag
            for dy in (step / 2, step):
                touch(page, "pointermove", geom["x"], geom["y"] + dy, 41)
                page.wait_for_timeout(40)
            touch(page, "pointerup", geom["x"], geom["y"] + step, 41)
        else:
            page.mouse.move(geom["x"], geom["y"])
            page.mouse.down()
            page.mouse.move(geom["x"], geom["y"] + step, steps=6)
            page.mouse.up()
        moved_ok, moved = server_until(page, base, today, title,
                                       lambda e: e and (e["start"] != before[title]["start"] or e["end"] != before[title]["end"]))
        check(moved_ok, f"{viewport}: dragging {title} moves that block, not its halo neighbour ({moved and moved['start']})")
        after = events_on(page, base, today)
        disturbed = [name for name, item in before.items() if name != title
                     and (after.get(name, {}).get("start") != item["start"] or after.get(name, {}).get("end") != item["end"])]
        check(not disturbed, f"{viewport}: dragging {title} leaves every neighbour where it was {disturbed[:3]}")
        until(page, "() => !document.querySelector('#hq-cal-app').dataset.busy")
        current = after.get(title)
        if not current:
            check(False, f"{viewport}: {title} is still on the server after its drag")
        restored = dict(current)
        restored["start"] = before[title]["start"]
        restored["end"] = before[title]["end"]
        r = page.context.request.post(base + "/api/calendar", headers={"origin": base, "content-type": "application/json"},
                                      data=json.dumps({"action": "save", "expected_rev": current["rev"], "event": restored}))
        check(r.ok, f"{viewport}: {title} can be put back after the drag")
        back_ok, _ = server_until(page, base, today, title,
                                  lambda e: e and e["start"] == before[title]["start"] and e["end"] == before[title]["end"])
        check(back_ok, f"{viewport}: {title} is back at its original time")
        page.evaluate("() => window.hqCalendarShow()")
        until(page, "() => !document.querySelector('#hq-cal-app').dataset.busy && !!document.querySelector('.hq-cal-stage')")
        page.wait_for_timeout(500)  # the refreshed stage may settle and reset its scroll


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
            ctx = browser.new_context(viewport={"width": 375, "height": 812}, bypass_csp=True)
            page = ctx.new_page()
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            login = ctx.request.post(base + "/login", headers={"Origin": base},
                                     form={"pin": info["admin_pin"]}, max_redirects=0)
            check(login.status == 303, "the fixture admin session is ready")
            if timed_today:
                done_ev = save(page, base, {"title": "Fini tôt", "all_day": False, "category": "study",
                                            "start": minute(now - timedelta(hours=3)), "end": minute(now - timedelta(hours=2))})
                soon_ev = save(page, base, {"title": "Bientôt", "all_day": False, "category": "appointment",
                                            "start": minute(now + timedelta(minutes=40)), "end": minute(now + timedelta(minutes=100))})
                check(bool(done_ev and soon_ev), "seed events saved")
            save(page, base, {"title": "Agenda à glisser", "all_day": True, "category": "personal",
                              "start": (today + timedelta(days=3)).isoformat(), "end": (today + timedelta(days=4)).isoformat()})
            page.goto(base + "/#calendrier", wait_until="domcontentloaded")
            page.locator("body.session-admin").wait_for(timeout=20000)
            page.add_style_tag(content="#hq-debug-panel{display:none!important}")  # the perf HUD covers the sheet actions
            page.locator('.bottom-nav [data-nav="calendrier"]').dispatch_event("click")
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
                check(bool(card.locator(".hq-cal-nextup-start").get_attribute("datetime")), "the countdown shows the event's start time")
                shot(page, "nextup", browser_name)
                card.click()
                check(until(page, """() => {
                    const event = document.querySelector('.hq-cal-event.is-selected');
                    return event?.textContent.includes('Bientôt') && document.activeElement === event;
                }"""), "the next-up card selects and focuses the event on the grid")
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
            quick.focus()
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
            # Keep clear of the event's move grip: this gesture is a day swipe, not a drag.
            x0 = box["x"] + box["width"] - 84
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
            check(page.locator(".hq-cal-stage .hq-cal-slot").first.evaluate("(slot) => getComputedStyle(slot).backgroundImage").startswith("linear-gradient"),
                  "the half-hour line remains visible at the taller zoom")
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
            page.locator(".hq-cal-options-trigger").click()
            sons = page.locator('#hq-cal-app [data-cal="sound"]')
            check(sons.get_attribute("aria-pressed") == "false", "Sons is off by default")
            sons.click()
            check(sons.get_attribute("aria-pressed") == "true" and page.evaluate("() => localStorage.getItem('hq_cal_sound')") == "1", "Sons turns on and is remembered")
            sons.click()
            page.keyboard.press("Escape")

            # iPhone tap: where vibrate is missing (Safari), the hidden switch is used.
            if not page.evaluate("() => 'vibrate' in navigator"):
                check(page.locator("label.hq-cal-haptic input[switch]").count() == 1, "without vibrate, the hidden switch gives the tap")
            tops = page.evaluate("() => ['.hq-cal-options-trigger', '.hq-cal-create'].map((q) => Math.round(document.querySelector('#hq-cal-app ' + q).getBoundingClientRect().top))")
            check(abs(tops[0] - tops[1]) < 8, f"on a phone the toggles and + Événement share one row {tops}")
            check(not errors, f"no page errors {errors[:3]}")
            ctx.close()

            # Desktop: Ctrl + wheel (a trackpad pinch) zooms the hours.
            ctx = browser.new_context(viewport={"width": 1440, "height": 900}, bypass_csp=True)
            page = ctx.new_page()
            login = ctx.request.post(base + "/login", headers={"Origin": base},
                                     form={"pin": info["admin_pin"]}, max_redirects=0)
            check(login.status == 303, "the fixture admin session is ready")
            page.goto(base + "/#calendrier", wait_until="domcontentloaded")
            page.locator("body.session-admin").wait_for(timeout=20000)
            page.add_style_tag(content="#hq-debug-panel{display:none!important}")  # the perf HUD covers the sheet actions
            page.locator('.bottom-nav [data-nav="calendrier"]').dispatch_event("click") if page.locator('.bottom-nav [data-nav="calendrier"]').is_visible() else page.evaluate("() => setView('calendrier')")
            until(page, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')")
            page.locator('#hq-cal-app [data-view="day"]').click()
            until(page, "() => !!document.querySelector('.hq-cal-day')")
            page.wait_for_timeout(400)
            h0 = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-slot').getBoundingClientRect().height")
            page.locator(".hq-cal-stage .hq-cal-scroll").hover(position={"x": 100, "y": 90})
            page.keyboard.down("Control")
            for _ in range(4):
                page.mouse.wheel(0, -40)
                page.wait_for_timeout(30)
            page.keyboard.up("Control")
            h1 = page.evaluate("() => document.querySelector('.hq-cal-day .hq-cal-slot').getBoundingClientRect().height")
            check(h1 > h0 * 1.3, f"Ctrl + wheel makes the hours taller ({h0:.0f} → {h1:.0f} px)")
            ctx.close()

            # Physical ergonomics at both target viewports: every discrete control is thumb-sized,
            # legible, inside the viewport, and clearly focused; the jump sheet is checked too.
            ergo_errors: list[str] = []
            ergo_seeded = False
            for ew, eh in ((390, 844), (1280, 800)):
                ectx = browser.new_context(viewport={"width": ew, "height": eh}, bypass_csp=True,
                                           has_touch=ew < 900, is_mobile=ew < 900)
                epage = ectx.new_page()
                epage.on("pageerror", lambda e: ergo_errors.append(str(e)))
                elogin = ectx.request.post(base + "/login", headers={"Origin": base},
                                           form={"pin": info["admin_pin"]}, max_redirects=0)
                check(elogin.status == 303, f"{ew}x{eh}: the fixture admin session is ready")
                if not ergo_seeded:
                    for ev in ({"title": "Ergonomie 1 h", "all_day": False, "category": "hq", "start": f"{today}T10:00", "end": f"{today}T11:00"},
                               {"title": "Ergonomie avant", "all_day": False, "category": "study", "start": f"{today}T12:30", "end": f"{today}T13:00"},
                               {"title": "Ergonomie 30 min", "all_day": False, "category": "study", "start": f"{today}T13:00", "end": f"{today}T13:30"},
                               {"title": "Ergonomie après", "all_day": False, "category": "study", "start": f"{today}T13:30", "end": f"{today}T14:00"},
                               {"title": "Ergonomie 15 min", "all_day": False, "category": "hq", "start": f"{today}T15:00", "end": f"{today}T15:15"},
                               {"title": "Ergonomie 15 voisine", "all_day": False, "category": "study", "start": f"{today}T15:15", "end": f"{today}T15:30"},
                               {"title": "Ergonomie 15 après", "all_day": False, "category": "study", "start": f"{today}T15:30", "end": f"{today}T16:00"},
                               {"title": "Ergonomie journée", "all_day": True, "category": "hq", "start": today.isoformat(), "end": (today + timedelta(days=1)).isoformat()}):
                        check(save(epage, base, ev) is not None, f"the ergonomics fixture saved {ev['title']}")
                    ergo_seeded = True
                epage.goto(base + "/#calendrier", wait_until="domcontentloaded")
                epage.locator("body.session-admin").wait_for(timeout=20000)
                epage.add_style_tag(content="#hq-debug-panel{display:none!important}")
                if epage.locator('.bottom-nav [data-nav="calendrier"]').is_visible():
                    epage.locator('.bottom-nav [data-nav="calendrier"]').dispatch_event("click")
                else:
                    epage.evaluate("() => setView('calendrier')")
                until(epage, "() => !!document.querySelector('#hq-cal-app .hq-cal-bar')")
                epage.locator('#hq-cal-app .hq-cal-view[data-view="day"]').click()
                epage.wait_for_timeout(700)
                epage.evaluate("(d) => window.hqCalendarOpenDay(d)", today.isoformat())
                epage.wait_for_timeout(700)
                epage.fill('#hq-cal-quick-input', 'Ergonomie')
                epage.wait_for_timeout(200)
                ergonomics(epage, f"{ew}x{eh}", "day")
                ergonomics_focus(epage, f"{ew}x{eh}", "day")
                epage.fill('#hq-cal-quick-input', '')
                epage.wait_for_timeout(200)
                ergonomics_short_events(epage, f"{ew}x{eh}", ew < 900)
                empty_slot_under_short_halo(epage, f"{ew}x{eh}", ew < 900, today.isoformat())
                drag_short_blocks(epage, base, f"{ew}x{eh}", ew < 900, today)
                epage.locator('#hq-cal-app .hq-cal-view[data-view="month"]').click()
                epage.wait_for_timeout(700)
                ergonomics(epage, f"{ew}x{eh}", "month")
                ergonomics_focus(epage, f"{ew}x{eh}", "month")
                if ew >= 900:
                    epage.locator('#hq-cal-app .hq-cal-view[data-view="week"]').click()
                    epage.wait_for_timeout(700)
                    ergonomics(epage, f"{ew}x{eh}", "week")
                    head = epage.locator(".hq-cal-weekhead button").first
                    if head.count():
                        head.click()
                        epage.wait_for_timeout(250)
                        check(not epage.evaluate("() => [...document.querySelectorAll('.hq-sheet')].some((s) => !s.hidden && s.getBoundingClientRect().width > 0)"),
                              f"{ew}x{eh}: the sticky week head keeps its own target over a short event")
                epage.locator('.hq-cal-date-trigger').first.click()
                check(until(epage, "() => { const i = document.getElementById('hq-cal-jump-input'); return !!i && i.offsetParent !== null; }"),
                      f"{ew}x{eh}: the date jump sheet opens")
                epage.wait_for_timeout(600)  # the sheet morphs in; measure its final geometry
                ergonomics(epage, f"{ew}x{eh}", "jump")
                ergonomics_focus(epage, f"{ew}x{eh}", "jump")
                epage.keyboard.press("Escape")
                ectx.close()
            check(not ergo_errors, f"the ergonomics viewports raised no page errors {ergo_errors[:3]}")
            browser.close()
    finally:
        proc.stdin.close()
        proc.kill()
    print(f"PASS {passed} checks ({browser_name})")


if __name__ == "__main__":
    main()
