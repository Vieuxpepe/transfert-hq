"""Feel pass for the drawing pad. Throwaway server only.

Env: HQ_BASE (required), HQ_TEST_PIN (default 424242), HQ_SCREENS.
Never point this at the live bridge.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("HQ_BASE", "").rstrip("/")
PIN = os.environ.get("HQ_TEST_PIN", "424242")
OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-pad-feel")))
OUT.mkdir(parents=True, exist_ok=True)
if not BASE or any(BASE.endswith(":" + p) for p in ("8765", "8766", "8776", "7860")):
    raise SystemExit("HQ_BASE must be a throwaway server")

results = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    print(results[-1], flush=True)
    return bool(cond)


HIDE = """() => {
  const p = document.querySelector('#hq-debug-panel');
  if (p) p.style.setProperty('display', 'none', 'important');
}"""


def login(page):
    page.goto(BASE + "/", wait_until="domcontentloaded")
    pin = page.locator('input[name="pin"]')
    if pin.count():
        pin.fill(PIN)
        page.click('button[type="submit"]')
    page.wait_for_selector("#btn-timemachine", timeout=25000)
    page.evaluate(HIDE)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        desk = browser.new_context(viewport={"width": 1440, "height": 900})
        pad = browser.new_context(**pw.devices["iPad Pro 11 landscape"])
        pc = desk.new_page()
        phone = pad.new_page()
        login(pc)
        login(phone)
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(HIDE)
        phone.evaluate(HIDE)
        phone.click("#btn-desk")
        phone.wait_for_selector("#hq-desk.is-open", timeout=10000)
        linked = False
        for _ in range(30):
            if "Dessiner" in phone.locator(".desk-status-t").inner_text():
                linked = True
                break
            phone.wait_for_timeout(300)
        check(linked, "pad sees Dessiner")

        # sample the PC's live stroke inside the page every 10 ms: Python-side polling is too coarse to see pacing
        pc.evaluate("""() => { window.__tl = []; const iv = setInterval(() => { const r = window.hqSketchState().remote;
          window.__tl.push(r ? r.pts.length : 0); }, 10); setTimeout(() => clearInterval(iv), 2000); }""")
        phone.evaluate("""() => {
          const L = window.hqDesk.link;
          const s = 77;
          const pts = [];
          for (let i = 0; i < 36; i++) pts.push([0.12 + i * 0.02, 0.42, 0.01, i * 16]);
          L.send('pc', 'pad', { op: 'begin', s, tool: 'pen', pts: [pts[0]] });
          for (let b = 0; b < 6; b++) {
            const batch = pts.slice(1 + b * 6, 1 + (b + 1) * 6);
            setTimeout(() => L.send('pc', 'pad', { op: 'move', s, tool: 'pen', pts: batch }), b * 45);
          }
          setTimeout(() => L.send('pc', 'pad', { op: 'end', s, tool: 'pen', pts: [] }), 6 * 45 + 40);
          window.__padSent = pts.length;
        }""")
        pc.wait_for_timeout(2100)
        growth = sorted({n for n in pc.evaluate("window.__tl") if n})
        steps = len(growth)
        final = pc.evaluate("""() => {
          const s = window.hqSketchState();
          const o = s.doc.objects.filter(x => x.type === 'stroke').slice(-1)[0];
          const xs = o ? o.pts.map(p => p[0]) : [];
          return { n: o ? o.pts.length : 0, span: xs.length ? Math.max(...xs) - Math.min(...xs) : 0, remote: s.remote && s.remote.pts.length };
        }""")
        check(steps >= 4, "replay grows in small steps (" + str(growth) + ")")
        # the PC simplifies a straight line to its two ends, so check the stroke's reach, not its point count
        check(final["n"] >= 2 and final["span"] > 0 and not final["remote"], "the whole stroke was committed (" + str(final) + ")")
        lat = pc.evaluate("() => window.hqDeskLatency ? window.hqDeskLatency() : null")
        print("A3 latency ms:", lat, flush=True)
        (OUT / "latency.txt").write_text("pad-to-pc-median-ms=" + str(lat) + "\n", encoding="utf-8")

        pbox = phone.locator(".desk-pad").bounding_box()
        session = phone.context.new_cdp_session(phone)
        x0, y0 = pbox["x"] + 50, pbox["y"] + pbox["height"] * 0.3
        x1 = pbox["x"] + pbox["width"] - 50
        session.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.6, "clickCount": 1})
        for k in range(1, 13):  # a real stroke: many moves, not one jump
            session.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0 + (x1 - x0) * k / 12, "y": y0 + 30 * k / 12, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.6, "clickCount": 1})
        session.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x1, "y": y0 + 30, "button": "left", "buttons": 0, "pointerType": "pen", "clickCount": 1})
        phone.wait_for_timeout(40)
        # measure before the screenshot: taking it can outlast the handoff window
        ink = phone.evaluate("""() => {
          const c = document.querySelector('.desk-pad-ink');
          if (!c) return 0;
          const g = c.getContext('2d');
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 16) if (d[i] > 20) n++;
          return n;
        }""")
        phone.evaluate(HIDE)
        phone.screenshot(path=str(OUT / "a2-just-after-stroke.png"))
        check(ink > 10, "local ink still visible just after the pen lifts (" + str(ink) + " samples)")

        blocked = {"on": True}

        def delay_send(route):
            if blocked["on"] and route.request.method == "POST":
                route.abort("failed")
            else:
                route.continue_()

        phone.route("**/api/desk/send", delay_send)
        session.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0 + 80, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.5, "clickCount": 1})
        for i in range(4):
            session.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x0 + (i + 1) * 40, "y": y0 + 80, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.5, "clickCount": 1})
        session.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x0 + 200, "y": y0 + 80, "button": "left", "buttons": 0, "pointerType": "pen", "clickCount": 1})
        phone.wait_for_timeout(400)
        retrying = "Reconnexion" in phone.locator("#hq-desk .desk-ack").inner_text()
        before = pc.evaluate("() => window.hqSketchState().doc.objects.length")
        blocked["on"] = False
        phone.wait_for_timeout(4000)
        after = pc.evaluate("""() => {
          const objs = window.hqSketchState().doc.objects;
          const o = objs.filter(x => x.type === 'stroke').slice(-1)[0];
          return { n: objs.length, pts: o ? o.pts.length : 0 };
        }""")
        phone.unroute("**/api/desk/send")
        check(retrying, "Reconnexion… showed during the dropout")
        check(after["n"] >= before and after["pts"] >= 2, "stroke arrived whole after the blip (" + str(after) + ")")

        # palm must not open the ring; a small still finger must
        session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": pbox["x"] + 120, "y": pbox["y"] + 120, "id": 7, "radiusX": 50, "radiusY": 40}]})
        phone.wait_for_timeout(600)
        palm = phone.evaluate("() => document.querySelector('.desk-ring') && !document.querySelector('.desk-ring').hidden")
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        check(not palm, "a palm-sized contact does not open the ring")
        session.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "pointerType": "pen", "force": 0.4, "clickCount": 1})
        session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": pbox["x"] + 140, "y": pbox["y"] + 140, "id": 8, "radiusX": 6, "radiusY": 6}]})
        phone.wait_for_timeout(600)
        during = phone.evaluate("() => document.querySelector('.desk-ring') && !document.querySelector('.desk-ring').hidden")
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        session.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x0, "y": y0, "button": "left", "buttons": 0, "pointerType": "pen", "clickCount": 1})
        check(not during, "a finger during a Pencil stroke does not open the ring")
        phone.wait_for_timeout(700)
        session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": pbox["x"] + 160, "y": pbox["y"] + 160, "id": 9, "radiusX": 6, "radiusY": 6}]})
        phone.wait_for_timeout(600)
        opened = phone.evaluate("() => { const r = document.querySelector('.desk-ring'); return !!(r && !r.hidden && r.children.length >= 4); }")
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        check(opened, "a small still finger opens the tool ring")
        phone.screenshot(path=str(OUT / "d1-ring.png"))

        phone.goto(BASE + "/?desk=pad", wait_until="domcontentloaded")
        phone.wait_for_selector("#btn-timemachine", timeout=20000)
        phone.wait_for_selector("#hq-desk.is-open [data-pane='pad']:not([hidden])", timeout=10000)
        check(True, "deep link /?desk=pad opens the Pad tab")
        mani = json.loads(urllib.request.urlopen(BASE + "/manifest.webmanifest", timeout=10).read().decode())
        check(any("desk=pad" in (s.get("url") or "") for s in mani.get("shortcuts") or []), "manifest lists the pad shortcut")

        phone.set_viewport_size({"width": 834, "height": 1194})
        phone.wait_for_timeout(400)
        ar = phone.evaluate("() => getComputedStyle(document.querySelector('.desk-pad')).getPropertyValue('--ar')")
        check(bool(ar and float(ar) > 0.2), "portrait keeps the PC aspect (" + str(ar) + ")")
        phone.screenshot(path=str(OUT / "b4-portrait.png"))
        pc.screenshot(path=str(OUT / "pc.png"))

        fails = [r for r in results if r.startswith("FAIL")]
        browser.close()
        if fails:
            raise SystemExit(len(fails))


if __name__ == "__main__":
    main()
