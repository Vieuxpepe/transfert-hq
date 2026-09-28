"""Manual visual check for the « Dessiner » tab (not part of unittest discovery).

Needs Playwright (pip install playwright && python -m playwright install chromium)
and a bridge running on a THROWAWAY root with a fake PIN, e.g.:

    mkdir /tmp/hq-visual-root && cp -r *.py assets /tmp/hq-visual-root/
    echo '{"pin":"246810","bind_host":"127.0.0.1","discord_webhook_url":""}' > /tmp/hq-visual-root/bridge_config.json
    (cd /tmp/hq-visual-root && python3 iphone_bridge.py) &
    HQ_TEST_PIN=246810 HQ_ROOT=/tmp/hq-visual-root python3 tests/visual_dessiner_playwright.py

Never point this at the live controller or a real PIN.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("HQ_BASE", "http://127.0.0.1:8765")
PIN = os.environ.get("HQ_TEST_PIN", "246810")
ROOT = Path(os.environ.get("HQ_ROOT", "/tmp/hq-visual-root"))
OUT = Path(os.environ.get("HQ_SCREENS", "/workspace/dessiner-screens"))
OUT.mkdir(parents=True, exist_ok=True)
results: list[str] = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    if not cond:
        print("\n".join(results))
        raise SystemExit("visual check failed: " + msg)


def login(page):
    page.goto(BASE + "/")
    page.fill('input[name="pin"]', PIN)
    page.click('button[type="submit"]')
    page.wait_for_selector(".bottom-nav")


def open_tab(page):
    page.click('.bottom-nav [data-nav="dessiner"]')
    page.wait_for_selector(".sk-canvas")
    page.wait_for_timeout(400)


def st(page):
    return page.evaluate("""() => { const s = window.hqSketchState(); return {
      n: s.doc.objects.length, types: s.doc.objects.map(o => o.type), objects: s.doc.objects, cons: s.doc.constraints,
      mode: s.doc.mode, ppu: s.view.ppu, sel: s.sel, dirty: s.dirty, stem: s.stem, points: s.doc.points } }""")


def canvas_box(page):
    page.locator(".sk-canvas").scroll_into_view_if_needed()
    return page.locator(".sk-canvas").bounding_box()


def mouse_drag(page, a, b, steps=12):
    page.mouse.move(*a)
    page.mouse.down()
    page.mouse.move(*b, steps=steps)
    page.mouse.up()
    page.wait_for_timeout(60)


def click_obj(page, oid, multi=False):
    """Click an object's midpoint on the canvas through the real UI."""
    page.locator(".sk-canvas").scroll_into_view_if_needed()
    pos = page.evaluate("""(id) => { const s = window.hqSketchState(), d = s.doc, o = HQSketch.getObj(d, id), pm = HQSketch.pointMap(d);
      let x, y; if (HQSketch.isLine(o)) { const a = pm.get(o.p1), b = pm.get(o.p2); x = (a.x + b.x) / 2; y = (a.y + b.y) / 2; }
      else if (o.type === 'dim_linear') { const g = HQSketch.dimLinearGeom(o); x = g.mid[0]; y = g.mid[1]; }
      else { x = o.x; y = o.y; }
      const p = HQSketch.toScreen(s.view, s.H, x, y), r = document.querySelector('.sk-canvas').getBoundingClientRect();
      return [r.left + p.x, r.top + p.y]; }""", oid)
    if multi:
        page.keyboard.down("Shift")
    page.mouse.click(pos[0], pos[1])
    if multi:
        page.keyboard.up("Shift")
    page.wait_for_timeout(60)


def desktop(pw, errors):
    browser = pw.chromium.launch(channel=os.environ.get("HQ_BROWSER_CHANNEL") or None)
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("desktop pageerror: " + str(e) + " @ " + (getattr(e, "stack", "") or "")[:600]))
    page.on("console", lambda m: errors.append("desktop console: " + m.text) if m.type == "error" else None)
    login(page)
    page.evaluate("localStorage.removeItem('tf_hq_sketch_draft_v1')")
    page.reload()
    open_tab(page)
    b = canvas_box(page)
    X = lambda fx: page.locator(".sk-canvas").bounding_box()["x"] + b["width"] * fx
    Y = lambda fy: page.locator(".sk-canvas").bounding_box()["y"] + b["height"] * fy

    page.click('.sk-seg [data-mode="construction"]')
    page.click('[data-tool="line"]')
    mouse_drag(page, (X(0.12), Y(0.78)), (X(0.34), Y(0.78)))
    s = st(page)
    l1 = s["objects"][-1]
    end = next(p for p in s["points"] if p["id"] == l1["p2"])
    # second line starts on the first line's end point (endpoint snap -> shared point id)
    b = page.locator(".sk-canvas").bounding_box()
    sx = b["x"] + (end["x"] - page.evaluate("window.hqSketchState().view.x0")) * s["ppu"]
    sy = b["y"] + b["height"] - (end["y"] - page.evaluate("window.hqSketchState().view.y0")) * s["ppu"]
    mouse_drag(page, (sx + 2, sy + 1), (sx + 120, sy - 150))
    s = st(page)
    l2 = s["objects"][-1]
    check(s["types"].count("line") == 2 and l2["p1"] == l1["p2"], "desktop: two connected lines share an explicit point id")

    page.click('[data-tool="rect"]')
    mouse_drag(page, (X(0.52), Y(0.82)), (X(0.72), Y(0.55)))
    page.click('[data-tool="circle"]')
    mouse_drag(page, (X(0.62), Y(0.3)), (X(0.66), Y(0.3)))
    page.click('[data-tool="centerline"]')
    mouse_drag(page, (X(0.5), Y(0.3)), (X(0.74), Y(0.3)))
    s = st(page)
    check(s["types"].count("line") == 6 and "circle" in s["types"] and "centerline" in s["types"], "desktop: rect, circle, centerline created")

    # driving length on line 1 (fixed = start)
    page.click('[data-tool="select"]')
    mid = ((X(0.12) + X(0.34)) / 2, Y(0.78))
    page.mouse.click(*mid)
    page.wait_for_selector('input[data-apply="length"]')
    page.fill('input[data-apply="length"]', "120")
    page.click('[data-do="length"]')
    s = st(page)
    L = page.evaluate(f"HQSketch.lineLength(window.hqSketchState().doc, '{l1['id']}')")
    check(abs(L - 120) < 1e-6, f"desktop: driving length applied (L={L})")
    check(any(k["type"] == "length" and k["value"] == 120 for k in s["cons"]), "desktop: length stored as driving constraint")
    page.screenshot(path=str(OUT / "02-desktop-driving-length.png"))

    # driving angle between the two connected lines (select, then shift-click the second)
    page.keyboard.press("Escape")
    click_obj(page, l1["id"])
    click_obj(page, l2["id"], multi=True)
    check(st(page)["sel"] == [l1["id"], l2["id"]], "desktop: multi-select two lines")
    page.wait_for_selector('input[data-apply="angle"]')
    page.fill('input[data-apply="angle"]', "60")
    page.click('[data-do="angle"]')
    ang = page.evaluate(f"HQSketch.angleBetween(window.hqSketchState().doc, '{l1['id']}', '{l2['id']}').deg")
    L1 = page.evaluate(f"HQSketch.lineLength(window.hqSketchState().doc, '{l1['id']}')")
    check(abs(ang - 60) < 1e-6 and abs(L1 - 120) < 1e-6, f"desktop: driving angle 60° applied, length kept (angle={ang:.6f})")

    # refused edit on a closed rectangle is visible (toast), geometry unchanged
    rect_lines = [o["id"] for o in st(page)["objects"] if o.get("group")]
    page.keyboard.press("Escape")
    page.click('[data-tool="select"]')
    click_obj(page, rect_lines[0])
    page.click('[data-act="multi"]')  # touch-style multi-select toggle
    click_obj(page, rect_lines[1])
    page.click('[data-act="multi"]')
    before = json.dumps(st(page)["points"])
    page.wait_for_selector('input[data-apply="angle"]')
    page.fill('input[data-apply="angle"]', "60")
    page.click('[data-do="angle"]')
    page.wait_for_selector(".toast.err")
    toast = page.inner_text(".toast.err")
    check("contour fermé" in toast, "desktop: unsafe angle edit on closed rectangle refused visibly: " + toast)
    check(json.dumps(st(page)["points"]) == before, "desktop: refused edit leaves geometry unchanged")
    page.screenshot(path=str(OUT / "08-desktop-refused-edit.png"))
    click_obj(page, l1["id"])
    click_obj(page, rect_lines[0], multi=True)
    check("partagent pas" in page.inner_text(".sk-props"), "desktop: angle between unconnected lines not offered (explained)")

    # quick sketch: pen, text note, manual cotation — same document
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('#toasts .toast')", timeout=8000)
    page.click('.sk-seg [data-mode="quick"]')
    n_before = st(page)["n"]
    page.click('[data-tool="pen"]')
    page.mouse.move(X(0.1), Y(0.3)); page.mouse.down()
    for i in range(30):
        page.mouse.move(X(0.1 + i * 0.008), Y(0.3 + 0.05 * ((-1) ** i) * (i % 5) / 5))
    page.mouse.up()
    page.click('[data-tool="text"]')
    page.mouse.click(X(0.12), Y(0.12))
    page.wait_for_selector(".sk-textin:not([hidden])")
    page.keyboard.type("Percer Ø6 H7 — 4x")
    page.keyboard.press("Enter")
    page.click('[data-tool="dimlin"]')
    mouse_drag(page, (X(0.52), Y(0.82)), (X(0.72), Y(0.82)))
    page.fill('input[data-edit="label"]', "70 ±0.1", timeout=5000)
    page.press('input[data-edit="label"]', "Tab")
    s = st(page)
    check(s["mode"] == "quick" and s["n"] == n_before + 3, "desktop: quick mode adds stroke + note + cotation to the same drawing")
    check(any(o["type"] == "text" and o["text"] == "Percer Ø6 H7 — 4x" for o in s["objects"]), "desktop: typed note stored as editable text")
    check(s["types"].count("line") == 6, "desktop: construction geometry preserved across mode switch")
    page.keyboard.press("Escape")
    page.mouse.move(X(0.4), Y(0.5))
    page.screenshot(path=str(OUT / "01-desktop-quick-and-construction.png"))

    # undo / redo
    n = st(page)["n"]
    page.click('[data-act="undo"]')
    check(st(page)["n"] == n - 1 or st(page)["objects"] != s["objects"], "desktop: undo")
    page.click('[data-act="redo"]')
    check(st(page)["n"] == n, "desktop: redo")

    # save -> JSON + PNG + DXF in Inbox/Drawings with _HQWeb-Desktop suffix
    page.click('[data-act="save"]')
    page.fill("#sk-save-name", "support moteur")
    page.click("#sk-save-go")
    page.wait_for_selector(".sk-props a.sk-link", timeout=15000)
    stem = st(page)["stem"]
    check(stem == "support-moteur_HQWeb-Desktop", f"desktop: saved stem {stem}")
    d = ROOT / "Inbox" / "Drawings"
    check(all((d / (stem + ext)).is_file() for ext in (".hqdraw.json", ".png", ".dxf")), "desktop: JSON/PNG/DXF written under Inbox/Drawings")
    page.screenshot(path=str(OUT / "03-desktop-saved.png"))
    # saving again never overwrites
    page.click('[data-act="save"]')
    page.fill("#sk-save-name", "support moteur")
    page.click("#sk-save-go")
    page.wait_for_function("() => window.hqSketchState().stem === 'support-moteur-2_HQWeb-Desktop'", timeout=15000)
    check(True, "desktop: second save got unique stem support-moteur-2_HQWeb-Desktop")

    # open dialog + reopen keeps notes/cotations editable
    page.click('[data-act="open"]')
    page.wait_for_selector(".sk-item img")
    page.wait_for_timeout(500)
    page.screenshot(path=str(OUT / "04-desktop-open-dialog.png"))
    page.click(f'[data-open="{stem}"]')
    page.wait_for_function(f"() => window.hqSketchState().stem === '{stem}'")
    s = st(page)
    dim = next(o for o in s["objects"] if o["type"] == "dim_linear")
    check(dim["label"] == "70 ±0.1", "desktop: reopened cotation label intact")
    page.click('[data-tool="select"]')
    click_obj(page, dim["id"])
    page.wait_for_selector('input[data-edit="label"]')
    page.fill('input[data-edit="label"]', "70 H7")
    page.press('input[data-edit="label"]', "Tab")
    check(any(o.get("label") == "70 H7" for o in st(page)["objects"]), "desktop: cotation editable after reopen")

    # draft recovery after reload (unsaved change survives)
    page.click('[data-tool="pen"]')
    mouse_drag(page, (X(0.3), Y(0.2)), (X(0.4), Y(0.25)))
    n = st(page)["n"]
    page.wait_for_timeout(500)
    page.reload()
    open_tab(page)
    s = st(page)
    check(s["n"] == n and s["dirty"], f"desktop: draft restored after reload ({s['n']} objects, dirty)")
    browser.close()


def iphone(pw, errors):
    browser = pw.chromium.launch(channel=os.environ.get("HQ_BROWSER_CHANNEL") or None)
    dev = dict(pw.devices["iPhone 13"])
    ctx = browser.new_context(**dev)
    page = ctx.new_page()
    page.on("pageerror", lambda e: errors.append("iphone pageerror: " + str(e) + " @ " + (getattr(e, "stack", "") or "")[:600]))
    page.on("console", lambda m: errors.append("iphone console: " + m.text) if m.type == "error" else None)
    cdp = ctx.new_cdp_session(page)

    def touch(kind, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": [{"x": x, "y": y, "id": i} for i, (x, y) in enumerate(pts)]})

    def touch_drag(a, b, steps=14):
        touch("touchStart", [a])
        for i in range(1, steps + 1):
            t = i / steps
            touch("touchMove", [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t + 12 * (t * (1 - t)))])
        touch("touchEnd", [])
        page.wait_for_timeout(80)

    login(page)
    page.evaluate("localStorage.removeItem('tf_hq_sketch_draft_v1')")
    page.reload()
    open_tab(page)
    check(page.evaluate("matchMedia('(pointer: coarse)').matches"), "iphone: coarse pointer emulated")
    page.locator(".sk-stage").scroll_into_view_if_needed()
    X = lambda fx: page.locator(".sk-canvas").bounding_box()["x"] + page.locator(".sk-canvas").bounding_box()["width"] * fx
    Y = lambda fy: page.locator(".sk-canvas").bounding_box()["y"] + page.locator(".sk-canvas").bounding_box()["height"] * fy

    page.tap('[data-tool="pen"]')
    touch_drag((X(0.15), Y(0.3)), (X(0.8), Y(0.45)))
    s = st(page)
    check(s["types"] == ["stroke"], "iphone: touch drag draws a freehand stroke")

    ppu0 = s["ppu"]
    cx, cy = X(0.5), Y(0.6)
    touch("touchStart", [(cx - 30, cy), (cx + 30, cy)])
    for i in range(1, 11):
        touch("touchMove", [(cx - 30 - i * 8, cy), (cx + 30 + i * 8, cy)])
    touch("touchEnd", [])
    s = st(page)
    check(s["ppu"] > ppu0 * 1.8 and s["n"] == 1, f"iphone: pinch zooms ({ppu0:.2f} -> {s['ppu']:.2f}) without drawing")
    # fingers lifting one at a time: the remaining finger must not start drawing
    touch("touchStart", [(cx - 40, cy + 40), (cx + 40, cy + 40)])
    touch("touchMove", [(cx - 50, cy + 40), (cx + 50, cy + 40)])
    touch("touchEnd", [(cx + 50, cy + 40)])
    touch("touchMove", [(cx + 90, cy + 80)])
    touch("touchMove", [(cx + 120, cy + 110)])
    touch("touchEnd", [])
    check(st(page)["n"] == 1, "iphone: lifting one pinch finger then moving the other draws nothing")

    page.tap('[data-tool="text"]')
    # Windows Chrome can consume the first synthetic tap after a CDP pinch.
    if page.evaluate("window.hqSketchState().tool") != "text":
        page.tap('[data-tool="text"]')
    check(page.evaluate("window.hqSketchState().tool") == "text", "iphone: text tool selected after pinch")
    page.locator(".sk-canvas").scroll_into_view_if_needed()
    touch("touchStart", [(X(0.2), Y(0.15))]); touch("touchEnd", [])
    page.wait_for_selector(".sk-textin:not([hidden])")
    page.keyboard.type("Note iPhone : chanfrein 1x45")
    page.keyboard.press("Enter")
    s = st(page)
    check(any(o["type"] == "text" and o["text"] == "Note iPhone : chanfrein 1x45" for o in s["objects"]), "iphone: tap + keyboard adds a note")
    page.screenshot(path=str(OUT / "05-iphone-quick-sketch.png"))

    page.tap('.sk-seg [data-mode="construction"]')
    page.tap('[data-tool="line"]')
    touch_drag((X(0.2), Y(0.75)), (X(0.75), Y(0.75)))
    page.tap('[data-tool="select"]')
    line = [o for o in st(page)["objects"] if o["type"] == "line"][0]
    touch("touchStart", [(X(0.47), Y(0.75))]); touch("touchEnd", [])
    page.wait_for_selector('input[data-apply="length"]')
    page.fill('input[data-apply="length"]', "50")
    page.tap('[data-fixed="p2"]')
    page.tap('[data-do="length"]')
    L = page.evaluate(f"HQSketch.lineLength(window.hqSketchState().doc, '{line['id']}')")
    check(abs(L - 50) < 1e-6, f"iphone: driving length via touch UI (L={L})")
    page.screenshot(path=str(OUT / "06-iphone-construction-length.png"))

    page.tap('[data-act="save"]')
    page.fill("#sk-save-name", "croquis chantier")
    check("_HQWeb-Mobile" in page.inner_text("#sk-save-preview"), "iphone: save dialog previews the _HQWeb-Mobile suffix")
    page.tap("#sk-save-go")
    page.wait_for_function("() => window.hqSketchState().stem !== ''", timeout=15000)
    stem = st(page)["stem"]
    check(stem == "croquis-chantier_HQWeb-Mobile", f"iphone: saved with mobile suffix ({stem})")
    # full-page capture last: Chromium resets touch emulation while it overrides device metrics
    page.screenshot(path=str(OUT / "07-iphone-full-page.png"), full_page=True)
    browser.close()


def main():
    errors: list[str] = []
    with sync_playwright() as pw:
        if os.environ.get("HQ_VISUAL_MOBILE_ONLY") != "1":
            desktop(pw, errors)
        if os.environ.get("HQ_VISUAL_DESKTOP_ONLY") != "1":
            iphone(pw, errors)
    real = [e for e in errors if "favicon" not in e]
    check(not real, "no page errors / console errors" + ("" if not real else ": " + "; ".join(real[:5])))
    print("\n".join(results))
    print("screens:", ", ".join(sorted(str(p) for p in OUT.glob("*.png"))))


if __name__ == "__main__":
    sys.exit(main())
