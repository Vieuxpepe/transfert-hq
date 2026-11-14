"""Two-screen check for the drawing pad. Throwaway server only.

    python tests/visual_hq_desk_pad_playwright.py

Env: HQ_BASE (required), HQ_TEST_PIN (default 424242), HQ_SCREENS (screenshot dir).
Never point this at the live bridge or ports 8765/8766/8776/7860.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("HQ_BASE", "").rstrip("/")
PIN = os.environ.get("HQ_TEST_PIN", "424242")
OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-pad-shots")))
OUT.mkdir(parents=True, exist_ok=True)

if not BASE:
    raise SystemExit("HQ_BASE is required")
if any(BASE.endswith(":" + p) or BASE.endswith(":" + p + "/") for p in ("8765", "8766", "8776", "7860")):
    raise SystemExit("refusing a live port")

results: list[str] = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    print(results[-1], flush=True)
    return cond


HIDE = """() => {
  const p = document.querySelector('#hq-debug-panel');
  if (p) p.style.setProperty('display', 'none', 'important');
  if (!document.getElementById('pad-test-hide')) {
    const st = document.createElement('style');
    st.id = 'pad-test-hide';
    st.textContent = '#hq-debug-panel{display:none !important}';
    document.head.appendChild(st);
  }
}"""


def login(page):
    page.goto(BASE + "/", wait_until="domcontentloaded")
    pin = page.locator('input[name="pin"]')
    if pin.count():
        pin.fill(PIN)
        page.click('button[type="submit"]')
    page.wait_for_selector("#btn-timemachine", timeout=25000)
    page.evaluate(HIDE)


def shot(page, name):
    page.evaluate(HIDE)
    path = OUT / name
    page.screenshot(path=str(path), animations="disabled")
    return path


def state(page):
    return page.evaluate("""() => {
      const s = window.hqSketchState && window.hqSketchState();
      if (!s || !s.doc) return null;
      return {
        n: s.doc.objects.length,
        types: s.doc.objects.map(o => o.type),
        widths: s.doc.objects.filter(o => o.type === 'stroke').map(o => o.w || 0),
        underlay: s.doc.underlay || null,
        version: s.doc.version,
        view: s.view,
        name: s.name || '',
        stem: s.stem || '',
      };
    }""")


def pen_stroke(session, points, force=0.7, pause_ms=0):
    x, y = points[0][0], points[0][1]
    force0 = points[0][2] if len(points[0]) > 2 else force
    session.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "pointerType": "pen", "force": force0, "buttons": 0})
    session.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": "pen", "force": force0, "clickCount": 1})
    for px, py, f in points[1:]:
        session.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": px, "y": py, "button": "left", "buttons": 1, "pointerType": "pen", "force": f, "clickCount": 1})
    if pause_ms:
        time.sleep(pause_ms / 1000.0)
    session.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": points[-1][0], "y": points[-1][1], "button": "left", "buttons": 0, "pointerType": "pen", "force": 0, "clickCount": 1})


def main():
    errors = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        desk = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        ipad_opts = dict(pw.devices["iPad Pro 11 landscape"])
        pad = browser.new_context(**ipad_opts)
        pc = desk.new_page()
        phone = pad.new_page()
        for page, name in ((pc, "desktop"), (phone, "ipad")):
            page.on("pageerror", lambda e, name=name: errors.append(name + " " + str(e)[:240]))
        login(pc)
        login(phone)
        check(phone.evaluate("() => matchMedia('(pointer: coarse)').matches"), "iPad context is a coarse pointer (phone role)")
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(HIDE)
        pc.wait_for_timeout(400)
        phone.evaluate(HIDE)
        phone.click("#btn-desk")
        phone.wait_for_selector("#hq-desk.is-open", timeout=10000)
        phone.wait_for_function(
            """() => {
              const t = document.querySelector('.desk-status-t');
              return t && t.textContent.includes('PC connecté') && t.textContent.includes('Dessiner');
            }""",
            timeout=15000,
        )
        check(phone.evaluate("() => !!document.querySelector('.desk-pad:not(.is-off)')"), "pad is live on Dessiner")
        shot(pc, "01-pc-dessiner.png")
        shot(phone, "02-ipad-pad.png")

        before = state(pc)
        box = pc.locator(".sk-canvas").bounding_box()
        pc.click('[data-tool="pen"]')
        pc.mouse.move(box["x"] + 90, box["y"] + 120)
        pc.mouse.down()
        pc.mouse.move(box["x"] + 280, box["y"] + 220, steps=10)
        pc.mouse.up()
        pc.wait_for_timeout(200)
        drawn = state(pc)
        check(drawn and drawn["n"] == before["n"] + 1 and drawn["types"][-1] == "stroke", "PC pen stroke commits")

        phone.wait_for_function(
            """() => {
              const img = document.querySelector('#hq-desk .desk-snap');
              return img && img.complete && img.naturalWidth > 64 && !img.hidden;
            }""",
            timeout=12000,
        )
        varied = phone.evaluate("""() => {
          const img = document.querySelector('#hq-desk .desk-snap');
          const c = document.createElement('canvas');
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let n = 0; const b = d[0] + d[1] + d[2];
          for (let i = 0; i < d.length; i += 16) if (Math.abs(d[i] + d[i+1] + d[i+2] - b) > 30) n++;
          return n;
        }""")
        check(varied > 20, "pad background image is the PC canvas (" + str(varied) + " varying samples)")
        shot(phone, "03-ipad-snapshot.png")
        shot(pc, "04-pc-after-stroke.png")

        reg = pc.evaluate("""() => ({
          sketch: !!(window.hqPadTargets && window.hqPadTargets.get('sketch')),
          alias: window.hqSketchRemote && window.hqPadTargets && window.hqPadTargets.get('sketch') === window.hqSketchRemote,
          hist: window.hqSketchRemote.history(),
        })""")
        check(reg["sketch"] and reg["alias"], "sketch target is registered and aliased")
        check(reg["hist"]["undo"] is True, "PC history says undo is available")
        check(not phone.locator("#hq-desk button", has_text="Annuler").is_disabled(), "pad Annuler enables from PC history")

        # Pencil stroke with pressure, then a held line that should snap.
        pbox = phone.locator(".desk-pad").bounding_box()
        session = phone.context.new_cdp_session(phone)
        x0, y0 = pbox["x"] + 40, pbox["y"] + pbox["height"] * 0.45
        x1, y1 = pbox["x"] + pbox["width"] * 0.55, pbox["y"] + pbox["height"] * 0.7
        pen_stroke(session, [(x0, y0, 0.3), (x0 + 40, y0 + 30, 0.9), (x1, y1, 0.4)])
        phone.wait_for_timeout(600)
        after_pen = state(pc)
        check(after_pen["n"] == drawn["n"] + 1 and after_pen["types"][-1] == "stroke", "Pencil stroke arrives on the PC")
        check(after_pen["widths"][-1] > 0, "Pencil stroke stores a width (" + str(after_pen["widths"][-1]) + ")")

        # straight hold -> line, while the tool is still the pen
        lx0, ly = pbox["x"] + 30, pbox["y"] + 36
        lx1 = pbox["x"] + pbox["width"] - 30
        pen_stroke(session, [(lx0 + i * (lx1 - lx0) / 6, ly, 0.5) for i in range(7)], pause_ms=800)
        phone.wait_for_timeout(500)
        snapped = state(pc)
        check(snapped["types"][-1] == "line", "hold-to-snap commits a line (" + snapped["types"][-1] + ")")
        ack = phone.locator("#hq-desk .desk-ack").inner_text()
        check("Ligne" in ack, "pad ack says Ligne (" + ack + ")")
        phone.locator("#hq-desk button", has_text="Annuler").click()
        phone.wait_for_timeout(400)
        check(state(pc)["n"] == snapped["n"] - 1, "Annuler removes the snapped line")

        phone.locator("#hq-desk [data-thick='bold']").click()
        pen_stroke(session, [(x0, y0 + 20, 0.8), (x0 + 80, y0 + 50, 0.8), (x1, y1 + 10, 0.8)])
        phone.wait_for_timeout(700)
        bold = state(pc)
        check(bold["n"] == after_pen["n"] + 1 and bold["widths"][-1] > after_pen["widths"][-1], "bold thickness is wider (" + str(bold["widths"][-1:]) + ")")
        phone.locator("#hq-desk [data-pad-tool]").click()
        mid = pbox["y"] + pbox["height"] * 0.55
        pts = [(pbox["x"] + 12 + (i / 14) * (pbox["width"] - 24), mid, 0.6) for i in range(15)]
        pen_stroke(session, pts)
        phone.wait_for_timeout(800)
        erased = state(pc)
        check(erased["n"] < bold["n"], "eraser removes geometry (" + str(bold["n"]) + " -> " + str(erased["n"]) + ")")
        phone.locator("#hq-desk [data-pad-tool]").click()

        # one finger does nothing once the Pencil has been seen; two fingers pan
        view_before = state(pc)["view"]["x0"]
        n_before_finger = state(pc)["n"]
        session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": pbox["x"] + 80, "y": pbox["y"] + 80, "id": 1}]})
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        phone.wait_for_timeout(300)
        check(state(pc)["n"] == n_before_finger, "one finger does not draw after a Pencil")
        session.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [
            {"x": pbox["x"] + 70, "y": pbox["y"] + 90, "id": 1},
            {"x": pbox["x"] + 180, "y": pbox["y"] + 90, "id": 2},
        ]})
        session.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [
            {"x": pbox["x"] + 120, "y": pbox["y"] + 90, "id": 1},
            {"x": pbox["x"] + 230, "y": pbox["y"] + 90, "id": 2},
        ]})
        phone.wait_for_timeout(200)
        session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        phone.wait_for_timeout(400)
        view_after = state(pc)["view"]["x0"]
        check(abs(view_after - view_before) > 0.01, "two-finger pan moves the PC view")
        try:
            from PIL import Image
            photo = OUT / "trace.jpg"
            Image.new("RGB", (48, 32), (180, 30, 40)).save(photo, "JPEG", quality=80)
            phone.locator("#hq-desk [data-pane='pad'] input[type='file']").set_input_files(str(photo))
            under = None
            ack = ""
            for _ in range(40):
                ack = phone.locator("#hq-desk .desk-ack").inner_text()
                under = (state(pc) or {}).get("underlay")
                if under or "impossible" in ack or "invalide" in ack or "indisponible" in ack:
                    break
                phone.wait_for_timeout(500)
            check(bool(under and str(under.get("asset_id", "")).startswith("asset-")), "photo underlay on the current drawing (" + ack + ")")
        except Exception as exc:
            check(False, "photo underlay (" + str(exc)[:140] + ")")

        phone.locator("#hq-desk button", has_text="Enregistrer").click()
        ack_save = ""
        saved_ok = False
        for _ in range(40):
            ack_save = phone.locator("#hq-desk .desk-ack").inner_text()
            if "Enregistré" in ack_save or "impossible" in ack_save:
                saved_ok = "Enregistré" in ack_save
                break
            phone.wait_for_timeout(500)
        saved = state(pc)
        check(saved_ok and (saved["stem"] != "" or "iPad" in (saved["name"] or "")), "save from the pad (" + ack_save + " / " + (saved["name"] or saved["stem"]) + ")")
        shot(pc, "05-pc-saved.png")
        shot(phone, "06-ipad-saved.png")

        # Forge inpaint target registers when the Forge scripts load. No gallery image on a fresh root.
        pc.evaluate("setView('forge')")
        found = False
        for _ in range(16):
            found = pc.evaluate("() => !!(window.hqPadTargets && window.hqPadTargets.get('inpaint'))")
            if found:
                break
            pc.wait_for_timeout(500)
        check(found, "inpaint target registers when Forge loads")
        shot(pc, "07-pc-forge.png")

        if errors:
            print("PAGE ERRORS:")
            for e in errors[:12]:
                print(" -", e)
        fails = [r for r in results if r.startswith("FAIL")]
        print("screenshots:", OUT)
        browser.close()
        if fails:
            raise SystemExit(len(fails))


if __name__ == "__main__":
    main()
