"""Chip touch holds — spank and title editor on a phone viewport.

Drives the real chip in Chromium mobile emulation (touch events, 390x844) on the throwaway HQ from
visual_carnet_playwright; never touches the live root. Skips (exit 0) without Playwright.

    python tests/visual_musica_chip_touch_playwright.py

Covers: a first-stage hold (~0.55 s) on the head and on the tail still spanks (chip memory hit), a
short hold does not open the title editor, a second-stage hold (~1.25 s) opens it while the spank has
already fired, and on the cheek the squeeze starts at 280 ms, the editor still opens at 1.25 s while
squeezed, and the squeeze releases on lift. A drag past the threshold, a second finger (pinch) and a
pointercancel during the hold must each suppress both the spank and the editor.
"""
import json
import sys
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(SOURCE / "tests"))

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover
    print("SKIP: playwright not installed")
    sys.exit(0)

import visual_carnet_playwright as V  # noqa: E402

FAILS = []


def check(ok, msg):
    print(("  OK   " if ok else "  FAIL ") + msg)
    if not ok:
        FAILS.append(msg)


PRESS_DOWN = """
([fx, fy, pointerId]) => {
  const b = document.querySelector('#hq-musica-chip');
  const r = b.getBoundingClientRect();
  b.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true, pointerId,
    pointerType: 'touch', isPrimary: true, button: 0, buttons: 1,
    clientX: r.left + r.width * fx, clientY: r.top + r.height * fy}));
}
"""

PRESS_UP = """
(pointerId) => {
  document.querySelector('#hq-musica-chip').dispatchEvent(new PointerEvent('pointerup', {bubbles: true,
    cancelable: true, pointerId, pointerType: 'touch', isPrimary: true, button: 0, buttons: 0,
    clientX: 0, clientY: 0}));
}
"""

NEGATIVE_HOLD = """
([kind]) => new Promise((resolve) => {
  const b = document.querySelector('#hq-musica-chip');
  const fire = (type, id, fx, fy, primary, buttons) => {
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new PointerEvent(type, {bubbles: true, cancelable: true, pointerId: id,
      pointerType: 'touch', isPrimary: primary, button: 0, buttons,
      clientX: r.left + r.width * fx, clientY: r.top + r.height * fy}));
  };
  fire('pointerdown', 90, 0.50, 0.70, true, 1);
  window.setTimeout(() => {
    if (kind === 'drag') fire('pointermove', 90, 0.65, 0.70, true, 1);
    else if (kind === 'pinch') fire('pointerdown', 91, 0.50, 0.45, false, 1);
    else fire('pointercancel', 90, 0.50, 0.70, true, 0);
  }, 80);
  window.setTimeout(() => {
    if (kind === 'pinch') fire('pointerup', 91, 0.50, 0.45, false, 0);
    fire('pointerup', 90, 0.65, 0.70, true, 0);
    resolve(true);
  }, 1600);
})
"""

HOLD = """
([holdMs, fy]) => new Promise((resolve) => {
  const b = document.querySelector('#hq-musica-chip');
  const r = b.getBoundingClientRect();
  const opts = {bubbles: true, cancelable: true, pointerId: 77, pointerType: 'touch',
                isPrimary: true, button: 0, buttons: 1,
                clientX: r.left + r.width * 0.5, clientY: r.top + r.height * fy};
  b.dispatchEvent(new PointerEvent('pointerdown', opts));
  window.setTimeout(() => {
    b.dispatchEvent(new PointerEvent('pointerup', Object.assign({}, opts, {buttons: 0})));
    resolve(true);
  }, holdMs);
})
"""


def hit_count(page):
    raw = page.evaluate("() => localStorage.getItem('hq_musica_chip_mem_v1')")
    try:
        return int((json.loads(raw or "{}") or {}).get("hits") or 0)
    except (TypeError, ValueError):
        return 0


def main():
    srv = V.Server()
    try:
        with sync_playwright() as pw:
            h = V.Harness(pw, srv)
            try:
                browser = h.browser("chromium")
            except Exception as exc:  # pragma: no cover
                print("SKIP: Chromium unavailable (%s)" % exc)
                return 0
            ctx = browser.new_context(
                viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True,
                device_scale_factor=2,
            )
            ctx.add_init_script(V.INSTRUMENT)
            ctx.add_init_script("localStorage.setItem('hq_companion_nsfw','1')")
            login = ctx.request.post(
                srv.base + "/login", form={"pin": V.ADMIN_PIN}, headers={"Origin": srv.base},
                max_redirects=0,
            )
            assert login.status == 303, login.status
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(srv.base + "/?nc=chiptouch")
            page.evaluate("setView('musique')")
            page.wait_for_selector("#hq-musica-chip", state="visible", timeout=20000)
            nsfw = page.evaluate("() => document.querySelector('#hq-musica-chip').classList.contains('is-nsfw')")
            check(nsfw, "the chip is in adult mode for the touch test")

            hits = hit_count(page)
            page.evaluate(HOLD, [900, 0.70])  # head zone
            page.wait_for_timeout(250)
            after_short = hit_count(page)
            check(after_short > hits, "a 0.9 s touch hold on the head still spanks (hits %d -> %d)" % (hits, after_short))
            check(
                page.locator(".hq-musica-chip-bubble.is-edit").count() == 0,
                "a first-stage hold does not open the title editor",
            )

            page.evaluate(HOLD, [1600, 0.70])
            page.wait_for_selector(".hq-musica-chip-bubble.is-edit", state="visible", timeout=4000)
            after_long = hit_count(page)
            check(after_long > after_short, "the long hold spanks before the editor opens (hits %d -> %d)" % (after_short, after_long))
            check(
                page.locator(".hq-musica-chip-bubble.is-edit input").count() == 1,
                "a second-stage hold opens the title editor on the phone",
            )
            field_px = page.evaluate(
                "() => getComputedStyle(document.querySelector('.hq-musica-chip-bubble.is-edit input')).fontSize"
            )
            check(field_px == "16px", "the field is 16px on touch, so iOS does not zoom the page (got %s)" % field_px)
            page.evaluate("() => { const b = document.querySelector('.hq-musica-chip-bubble.is-edit'); if (b) b.remove(); }")

            tail_before = hit_count(page)
            page.evaluate(HOLD, [900, 0.10])  # tail zone
            page.wait_for_timeout(250)
            check(hit_count(page) > tail_before, "the tail spank still fires on touch too")

            # Cheek/thigh: squeeze at 280 ms, editor still opens at ~1.25 s, squeeze released on lift.
            page.evaluate(PRESS_DOWN, [0.50, 0.45, 78])
            page.wait_for_timeout(500)
            check(page.evaluate("() => window.hqMusicaChipDebug().squeeze"), "the cheek squeeze starts at 280 ms on a touch hold")
            check(
                page.locator(".hq-musica-chip-bubble.is-edit").count() == 0,
                "the squeeze alone does not open the editor",
            )
            page.wait_for_timeout(800)  # ~1.3 s after the press
            page.wait_for_selector(".hq-musica-chip-bubble.is-edit", state="visible", timeout=2000)
            check(
                page.evaluate("() => window.hqMusicaChipDebug().squeeze"),
                "the editor opens at 1.25 s while the cheek squeeze is still active",
            )
            page.evaluate(PRESS_UP, 78)
            page.wait_for_timeout(350)
            check(not page.evaluate("() => window.hqMusicaChipDebug().squeeze"), "the squeeze releases cleanly on lift")
            check(
                page.locator(".hq-musica-chip-bubble.is-edit").count() == 1,
                "the editor stays open after the lift",
            )
            page.evaluate("() => { const b = document.querySelector('.hq-musica-chip-bubble.is-edit'); if (b) b.remove(); }")

            # Negative paths: a drag, a pinch, or a pointercancel must kill both timers. The interfering event
            # is fired 80 ms after the press inside the page, so runner latency can never push it past 550 ms.
            for kind, label in (
                ("drag", "a drag past the threshold"),
                ("pinch", "a second finger during the hold"),
                ("cancel", "pointercancel during the hold"),
            ):
                before = page.evaluate("() => window.hqMusicaChipDebug().spanks")
                page.evaluate(NEGATIVE_HOLD, [kind])
                check(
                    page.evaluate("() => window.hqMusicaChipDebug().spanks") == before,
                    label + " does not spank",
                )
                check(
                    page.locator(".hq-musica-chip-bubble.is-edit").count() == 0,
                    label + " does not open the editor",
                )
                check(not page.evaluate("() => window.hqMusicaChipDebug().holding"), label + " leaves no hold")

            before_menu = hit_count(page)
            page.evaluate("() => document.querySelector('#hq-musica-chip').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true}))")
            page.wait_for_selector(".hq-musica-chip-bubble.is-edit", state="visible", timeout=2000)
            check(
                hit_count(page) == before_menu,
                "right-click opens the editor without a second spank (one contextmenu handler)",
            )
            check(not errors, "no page errors (got %r)" % errors[:3])
            ctx.close()
    finally:
        srv.close()

    if FAILS:
        print("Chip touch: %d failure(s)" % len(FAILS))
        return 1
    print("Chip touch: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
