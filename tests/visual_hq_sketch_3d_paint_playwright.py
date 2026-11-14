"""Sketch to 3D from the pad, and « Forge peint ». Throwaway server only, with the fake Forge:

  HQ_FORGE_MOCK=ready HQ_FORGE_MOCK_DELAY=1.5 tail -f /dev/null | python tests/carnet_test_server.py <empty dir>
  HQ_BASE=http://127.0.0.1:<port> python tests/visual_hq_sketch_3d_paint_playwright.py

Never point this at the live bridge or a real Forge.
"""
from __future__ import annotations

import base64
import io
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visual_hq_desk_feel_playwright as V  # noqa: E402  (login, HIDE; refuses live ports)
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-sketch-3d-paint")))
OUT.mkdir(parents=True, exist_ok=True)
results = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    print(results[-1], flush=True)
    return bool(cond)


def setup(pw):
    b = pw.chromium.launch(headless=True)
    pc = b.new_context(viewport={"width": 1440, "height": 900}).new_page()
    phone = b.new_context(**pw.devices["iPad Pro 11 landscape"]).new_page()
    V.login(pc)
    V.login(phone)
    pc.evaluate("setView('dessiner')")
    pc.wait_for_selector(".sk-canvas", timeout=20000)
    pc.evaluate(V.HIDE)
    pc.wait_for_function("window.hqSketchRemote && window.hqSketchRemote.ready()", timeout=20000)
    pc.wait_for_timeout(1500)
    phone.click("#btn-desk")
    phone.wait_for_selector("#hq-desk.is-open")
    phone.evaluate(V.HIDE)
    phone.wait_for_function("document.querySelector('.desk-pad').classList.contains('has-ink')", timeout=20000)
    return b, pc, phone


def pen_rect(phone, cdp, box, x0, y0, x1, y1):
    """A hand-drawn rectangle, held still at the end so the pad snaps it."""
    def pen(t, x, y, buttons):
        cdp.send("Input.dispatchMouseEvent", {"type": t, "x": x, "y": y, "button": "left", "buttons": buttons, "pointerType": "pen", "force": 0.5, "clickCount": 1})
    X = lambda f: box["x"] + box["width"] * f
    Y = lambda f: box["y"] + box["height"] * f
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)]
    pen("mousePressed", X(x0), Y(y0), 1)
    for (ax, ay), (bx, by) in zip(corners, corners[1:]):
        for i in range(1, 13):
            pen("mouseMoved", X(ax + (bx - ax) * i / 12), Y(ay + (by - ay) * i / 12), 1)
    phone.wait_for_timeout(700)  # held still: the shape snaps
    pen("mouseReleased", X(x0), Y(y0), 0)


def lift_3d(pw):
    b, pc, phone = setup(pw)
    box = phone.locator(".desk-pad").bounding_box()
    cdp = phone.context.new_cdp_session(phone)
    pen_rect(phone, cdp, box, 0.35, 0.35, 0.6, 0.6)
    phone.wait_for_timeout(900)
    lines = pc.evaluate("window.hqSketchState().doc.objects.filter(o => o.type === 'line').length")
    check(lines == 4, "the pad's rectangle became 4 lines on the PC (%d)" % lines)
    check(phone.is_visible(".desk-lift"), "the pad offers « Extruder » for the closed shape")
    check("deux doigts" in phone.locator(".desk-ack").inner_text(), "and says how: « %s »" % phone.locator(".desk-ack").inner_text())

    # two fingers straight up
    cx, cy = box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.8
    pts = lambda dy: [{"x": cx - 40, "y": cy - dy, "id": 1}, {"x": cx + 40, "y": cy - dy, "id": 2}]
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": pts(0)})
    heights = []
    for k in range(1, 26):
        cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pts(k * 12)})
        phone.wait_for_timeout(30)
        if k in (8, 16, 25):
            pc.wait_for_timeout(250)
            heights.append(pc.evaluate("""() => { const st = window.hqSketchState(); const t = document.querySelector('.sk-3d-status');
              return { tab3d: !!st.tab3d, lifting: !!st.lift, status: t ? t.textContent : '' }; }"""))
            if k == 16:
                pc.screenshot(path=str(OUT / "pc-3d-growing.png"))
    check(all(h["tab3d"] and h["lifting"] for h in heights), "the PC switched to 3D and follows the lift (%s)" % [h["status"] for h in heights])
    nums = [float(h["status"].split("Hauteur ")[1].split(" ")[0].replace(",", ".")) for h in heights if "Hauteur " in h["status"]]
    check(len(nums) == 3 and nums[0] < nums[1] < nums[2], "the part grows as the fingers rise (%s)" % nums)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    pc.wait_for_timeout(2500)
    done = pc.evaluate("""() => { const st = window.hqSketchState(); const f = (st.doc.features || [])[0];
      return { features: (st.doc.features || []).length, depth: f && f.depth, type: f && f.type, lifting: !!st.lift, tri: (st.mesh || []).length,
               status: document.querySelector('.sk-3d-status').textContent }; }""")
    check(done["features"] == 1 and done["type"] == "extrude" and done["depth"] and not done["lifting"], "release saved a normal extrusion (%s)" % done)
    check(done["tri"] > 0, "the saved part has a real mesh (%d triangles)" % done["tri"])
    check(bool(nums) and done["depth"] is not None and done["depth"] >= nums[-1], "at the height the fingers reached (%s vs %s)" % (done["depth"], nums[-1:]))
    pc.screenshot(path=str(OUT / "pc-3d-done.png"))
    phone.screenshot(path=str(OUT / "pad-after-lift.png"))
    check("Extrusion" in phone.locator(".desk-ack").inner_text(), "the pad confirms: « %s »" % phone.locator(".desk-ack").inner_text())
    b.close()


def lift_pill(pw):
    """Finger-only path: « Extruder » then one drag up; and a drag back down cancels."""
    b, pc, phone = setup(pw)
    box = phone.locator(".desk-pad").bounding_box()
    cdp = phone.context.new_cdp_session(phone)
    pen_rect(phone, cdp, box, 0.3, 0.3, 0.5, 0.55)
    phone.wait_for_timeout(900)
    phone.click(".desk-lift")
    x, y = box["x"] + box["width"] * 0.7, box["y"] + box["height"] * 0.85
    phone.mouse.move(x, y)
    phone.mouse.down()
    for k in range(1, 15):
        phone.mouse.move(x, y - k * 15)
        phone.wait_for_timeout(25)
    pc.wait_for_timeout(300)
    mid = pc.evaluate("document.querySelector('.sk-3d-status').textContent")
    for k in range(14, -1, -1):  # back to the paper
        phone.mouse.move(x, y - k * 15 + 4)
        phone.wait_for_timeout(15)
    phone.mouse.up()
    pc.wait_for_timeout(900)
    st = pc.evaluate("() => { const st = window.hqSketchState(); return { features: (st.doc.features || []).length, tab3d: !!st.tab3d, lifting: !!st.lift }; }")
    check("Hauteur" in mid, "« Extruder » + a drag up grows the part too (« %s »)" % mid)
    check(st == {"features": 0, "tab3d": False, "lifting": False}, "dragging back to the paper cancels and returns to 2D (%s)" % st)
    b.close()


def paint(pw):
    b, pc, phone = setup(pw)
    box = phone.locator(".desk-pad").bounding_box()
    cdp = phone.context.new_cdp_session(phone)
    pen_rect(phone, cdp, box, 0.3, 0.4, 0.7, 0.75)
    phone.wait_for_timeout(900)
    posts = []
    pc.on("request", lambda r: posts.append(r.url) if r.method == "POST" and r.url.endswith("/api/forge/sketch") else None)
    pc.click('[data-act="paint"]')
    check(pc.is_visible(".sk-paint"), "« Forge peint » opens beside the drawing")
    src = pc.evaluate("window.hqSketchPaintSource()")
    from PIL import Image
    img = Image.open(io.BytesIO(base64.b64decode(src.split(",", 1)[1]))).convert("L")
    dark = sum(1 for v in img.getdata() if v < 100)
    grey = sum(1 for v in img.getdata() if 100 <= v < 245)
    check(img.size[0] % 64 == 0 and img.size[1] % 64 == 0 and max(img.size) == 768, "the sketch goes to Forge at a model-friendly size %s" % (img.size,))
    check(dark > 200 and grey < dark * 3, "black ink on white paper, no grid (%d ink px, %d grey px)" % (dark, grey))
    img.save(OUT / "forge-input.png")
    pc.fill(".sk-paint-prompt", "une maison au bord d'un lac")
    for _ in range(75):  # the page's CSP forbids eval-based waits: poll instead
        if pc.evaluate("() => { const i = document.querySelector('.sk-paint-img'); return !!(i && !i.hidden && i.complete && i.naturalWidth); }"):
            break
        pc.wait_for_timeout(200)
    check(len(posts) == 1, "typing the description painted it once, live (%d request)" % len(posts))
    pc.wait_for_timeout(300)
    check("prête" in pc.locator(".sk-paint-status").inner_text(), "status: « %s »" % pc.locator(".sk-paint-status").inner_text())
    nat = pc.evaluate("document.querySelector('.sk-paint-img').naturalWidth")
    check(nat > 0, "the painting is shown (%d px wide)" % nat)
    pc.screenshot(path=str(OUT / "pc-paint.png"))
    # a new stroke on the pad repaints, once, after a pause
    pen_rect(phone, cdp, box, 0.1, 0.1, 0.2, 0.2)
    pc.wait_for_timeout(5500)
    check(len(posts) == 2, "a new stroke repainted it once more (%d requests)" % len(posts))
    pc.click(".sk-paint-acts button:nth-child(3)")
    pc.wait_for_timeout(800)
    check("galerie" in pc.locator(".sk-paint-status").inner_text(), "« Garder dans la galerie » : « %s »" % pc.locator(".sk-paint-status").inner_text())
    gal = pc.evaluate("window.api('/api/forge/gallery').then(r => (r.images || r.items || []).length).catch(e => -1)")
    check(gal == 1, "exactly one image reached the gallery (%s)" % gal)
    b.close()


def main():
    with sync_playwright() as pw:
        which = sys.argv[1:] or ["lift", "pill", "paint"]
        if "lift" in which:
            lift_3d(pw)
        if "pill" in which:
            lift_pill(pw)
        if "paint" in which:
            paint(pw)
    print("\n".join(results))
    print("FAILED" if any(r.startswith("FAIL") for r in results) else "ALL OK")


if __name__ == "__main__":
    main()
