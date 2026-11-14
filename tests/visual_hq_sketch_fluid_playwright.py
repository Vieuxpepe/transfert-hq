"""Dessiner's fluid editing in a browser: typed dimensions while drawing, click-click shapes, automatic constraints,
alignment guides, outline and box selection, the action ring, shortcuts, remembered values, 2D + 3D side by side,
and push / pull of an extrusion's end face with its instant preview.

Throwaway server only, on a Python with OCP (the exact engine drives automatic constraints and the exact preview):
  tail -f /dev/null | <python> tests/carnet_test_server.py <empty dir>
  HQ_BASE=http://127.0.0.1:<port> python tests/visual_hq_sketch_fluid_playwright.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visual_hq_desk_feel_playwright as V  # noqa: E402  (login, HIDE; refuses live ports)
from visual_hq_solid_v5_playwright import box_doc, wait_js  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-sketch-fluid")))
results = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    print(results[-1], flush=True)
    return bool(cond)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1500, "height": 1000})
        pc = ctx.new_page()
        errors = []
        pc.on("pageerror", lambda e: errors.append(str(e)))
        V.login(pc)
        pc.evaluate("""(doc) => { localStorage.removeItem('tf_hq_sketch_prefs_v1');
          localStorage.setItem('tf_hq_sketch_draft_v1', JSON.stringify({ v: 1, at: Date.now(), name: 'fluide', stem: '', dirty: true, doc })); }""", box_doc())
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(V.HIDE)
        st = lambda js: pc.evaluate("() => { const s = window.hqSketchState(); " + js + " }")
        wait_js(pc, "window.hqSketchState().doc && window.hqSketchState().W > 0", 15000)
        wait_js(pc, "window.hqSketchState().caps && window.hqSketchState().caps.exact", 15000)
        pc.wait_for_timeout(900)
        pc.locator(".sk-stage").scroll_into_view_if_needed()
        pc.evaluate("() => { const s = window.hqSketchState(); s.doc.snap.angle = false; s.doc.grid.snap = false; s.view.ppu = 3; s.view.x0 = -20; s.view.y0 = -40; }")
        pc.mouse.move(5, 5)

        def to_screen(x, y):
            return pc.evaluate("""([x, y]) => { const s = window.hqSketchState(); const c = document.querySelector('.sk-canvas').getBoundingClientRect();
              const q = window.HQSketch.toScreen(s.view, s.H, x, y); return [c.left + q.x, c.top + q.y]; }""", [x, y])

        def settle():
            for _ in range(200):
                if not st("return s.solidBusy;"):
                    break
                pc.wait_for_timeout(100)
            pc.wait_for_timeout(300)

        def tool(key):
            pc.mouse.move(*to_screen(300, 300))
            pc.keyboard.press(key)
            pc.wait_for_timeout(120)

        def last_obj(kind):
            return st("const o = s.doc.objects.filter(o => o.type === '%s').slice(-1)[0]; const pm = window.HQSketch.pointMap(s.doc);"
                      " return o && Object.assign({ id: o.id, r: o.r }, o.p1 ? { a: pm.get(o.p1), b: pm.get(o.p2) } : {});" % kind)

        # ---- 1. click once, type the length and angle, Enter
        n_lines = st("return s.doc.objects.filter(o => o.type === 'line').length;")
        tool("l")
        pc.mouse.click(*to_screen(0, 120))
        pc.mouse.move(*to_screen(30, 125), steps=4)
        check(st("return !!(s.action && s.action.click);"), "a click with the line tool waits for the end (click-click drawing)")
        pc.keyboard.type("80")
        pc.keyboard.press("Tab")
        pc.keyboard.type("0")
        hud = pc.evaluate("document.querySelector('.sk-hud').textContent")
        check("L 80" in hud and "∠ 0" in hud, "the typed values show in the HUD (« %s »)" % hud.strip()[:60])
        pc.keyboard.press("Enter")
        pc.wait_for_timeout(250)
        ln = last_obj("line")
        check(st("return s.doc.objects.filter(o => o.type === 'line').length;") == n_lines + 1 and ln
              and abs(ln["b"]["x"] - 80) < 1e-6 and abs(ln["b"]["y"] - 120) < 1e-6, "typing 80 Tab 0 Enter drew an 80 mm horizontal line (%s)" % (ln and ln["b"]))
        check(st("return s.doc.version;") >= 6 and st("return s.doc.constraints.some(k => k.type === 'horizontal' && k.line === '%s');" % ln["id"]),
              "« Contraintes automatiques »: the horizontal line got its H constraint")

        # ---- 2. drag a rectangle and type its size while dragging
        tool("r")
        pc.mouse.move(*to_screen(150, 0))
        pc.mouse.down()
        pc.mouse.move(*to_screen(170, 20), steps=5)
        pc.keyboard.type("40")
        pc.keyboard.press("Tab")
        pc.keyboard.type("25")
        pc.mouse.up()
        pc.wait_for_timeout(250)
        rect = st("""const ls = s.doc.objects.filter(o => o.type === 'line').slice(-4); const pm = window.HQSketch.pointMap(s.doc);
          const xs = ls.flatMap(o => [pm.get(o.p1).x, pm.get(o.p2).x]), ys = ls.flatMap(o => [pm.get(o.p1).y, pm.get(o.p2).y]);
          return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), ls.map(o => o.id)];""")
        check(abs(rect[0] - 40) < 1e-6 and abs(rect[1] - 25) < 1e-6, "a rectangle dragged with 40 Tab 25 typed is 40 × 25 (%s × %s)" % (rect[0], rect[1]))
        check(st("return %s.every(id => s.doc.constraints.some(k => (k.type === 'horizontal' || k.type === 'vertical') && k.line === id));" % rect[2]),
              "its four sides are constrained H / V automatically")

        # ---- 3. alignment guide, then a click-click circle
        tool("l")
        pc.mouse.click(*to_screen(200, 150))
        pc.mouse.move(*to_screen(100.4, 160), steps=6)  # straight above the rectangle's corner x = 100
        g = st("return s.guides;")
        end = st("return s.action && s.action.b;")
        check(g and g.get("x") == 100 and end and end["x"] == 100, "an alignment guide shows at x = 100 and the end lines up (%s)" % g)
        pc.keyboard.press("Escape")
        pc.wait_for_timeout(150)
        check(not st("return s.action;"), "Escape drops the unfinished line")
        tool("c")
        pc.mouse.click(*to_screen(250, 100))
        pc.mouse.move(*to_screen(262, 100), steps=6)
        pc.mouse.click(*to_screen(262, 100))
        pc.wait_for_timeout(250)
        c = last_obj("circle")
        check(c and abs(c["r"] - 12) < 0.2, "two clicks drew a circle of radius 12 (%s)" % (c and c["r"]))
        new_circle = c["id"]

        # ---- 4. double click: the whole outline; box select; the ring
        tool("v")
        pc.mouse.dblclick(*to_screen(50, 0))
        pc.wait_for_timeout(250)
        check(sorted(st("return s.sel;")) == ["l0", "l1", "l2", "l3"], "double-clicking a side selects the whole outline (%s)" % st("return s.sel;"))
        pc.keyboard.press("Escape")
        pa, pb = to_screen(10, 10), to_screen(30, 30)
        pc.mouse.move(*pa); pc.mouse.down(); pc.mouse.move(*pb, steps=6)
        check(st("return s.action && s.action.kind;") == "box", "dragging on empty space draws a selection box")
        pc.mouse.up()
        pc.wait_for_timeout(200)
        check(st("return s.sel;") == ["c1"], "the box selected only what it encloses: the small circle (%s)" % st("return s.sel;"))
        pc.keyboard.press("Escape")  # the selection's bubble would sit where we right-click
        pc.wait_for_timeout(150)
        pc.mouse.click(*to_screen(0, 30), button="right")
        pc.wait_for_timeout(300)
        ring = pc.evaluate("[...document.querySelectorAll('.sk-ring .sk-ring-item')].map(b => b.textContent)")
        check(len(ring) >= 3 and "Supprimer" in ring, "a right click opens the action ring (%s)" % ring)
        pc.screenshot(path=str(OUT / "fluid-ring.png"))
        pc.keyboard.press("Escape")
        pc.wait_for_timeout(200)
        if pc.evaluate("!!document.querySelector('.sk-ring')"):
            pc.mouse.click(*to_screen(400, 400))
        check(not pc.evaluate("!!document.querySelector('.sk-ring')"), "the ring closes")

        # ---- 5. shortcuts: ? sheet, Space repeats the bubble's last action
        pc.mouse.move(*to_screen(300, 300))
        pc.keyboard.press("?")
        check(pc.evaluate("!!document.querySelector('.sk-keys')"), "? opens the shortcut sheet")
        pc.keyboard.press("?")
        check(not pc.evaluate("!!document.querySelector('.sk-keys')"), "? again closes it")
        tool("v")
        pc.mouse.click(*to_screen(24, 20))  # the small circle (r 4)
        pc.wait_for_timeout(250)
        pc.locator('.sk-stage .sk-bubble [data-key="rad"]').fill("6")
        pc.locator('.sk-stage .sk-bubble [data-key="rad"]').press("Enter")
        pc.wait_for_timeout(250)
        check(st("return window.HQSketch.getObj(s.doc, 'c1').r;") == 6, "the bubble set the small circle's radius to 6")
        pc.mouse.click(*to_screen(262, 100))  # the new circle's rim
        pc.wait_for_timeout(250)
        check(st("return s.sel;") == [new_circle], "the drawn circle is selected")
        pc.mouse.move(*to_screen(400, 300))
        pc.keyboard.press("Space")
        pc.wait_for_timeout(250)
        check(st("return window.HQSketch.getObj(s.doc, '%s').r;" % new_circle) == 6, "Space repeated « Rayon 6 » on it")

        # ---- 6. 2D + 3D side by side, push / pull, remembered height
        pc.click('[data-act="viewSplit"]')
        pc.wait_for_timeout(600)
        boxes = pc.evaluate("""() => { const a = document.querySelector('.sk-stage').getBoundingClientRect(), b = document.querySelector('.sk-3d-stage').getBoundingClientRect();
          return [a.left, a.right, b.left, b.right, a.top, b.top, a.width > 0, b.width > 0]; }""")
        check(boxes[6] and boxes[7] and boxes[1] <= boxes[2] + 1 and abs(boxes[4] - boxes[5]) < 2, "« 2D + 3D » shows the drawing and the part side by side (%s)" % boxes[:6])
        wait_js(pc, "window.hqSketchState().mesh && window.hqSketchState().mesh.length > 0", 30000)
        settle()
        pc.screenshot(path=str(OUT / "fluid-split.png"))
        # the top face (z = 20) of the extrusion
        target = st("""const c = document.querySelector('.sk-3d-canvas'), r = c.getBoundingClientRect(); let best = null;
          s.mesh.forEach(t => { if (!t.every(p => Math.abs(p[2] - 20) < 1e-6)) return; const m = [0, 1, 2].map(k => (t[0][k] + t[1][k] + t[2][k]) / 3);
            const p = c.hqSolidProject(m); const x = r.left + (p[0] + 1) / 2 * r.width, y = r.top + (1 - p[1]) / 2 * r.height;
            if (x > r.left && x < r.right && y > r.top && y < r.bottom && (!best || p[2] < best.d)) best = { d: p[2], x, y }; });
          return best;""")
        check(target is not None, "the top face is visible in the 3D view")
        pc.mouse.click(target["x"], target["y"])
        pc.wait_for_timeout(400)
        check(st("return s.pushPull && s.pushPull.id;") == "f1", "clicking the top face picks the extrusion for push / pull")
        keys = pc.evaluate("[...document.querySelectorAll('.sk-3d-stage .sk-bubble [data-key]')].map(i => i.dataset.key)")
        check("pp" in keys and "ppr" in keys, "the 3D bubble offers a height field and a slider (%s)" % keys)
        tris0 = st("return JSON.stringify(document.querySelector('.sk-3d-canvas') && s.mesh.length);")
        pc.evaluate("""() => { const r = document.querySelector('.sk-3d-stage .sk-bubble [data-key="ppr"]'); r.value = '30'; r.dispatchEvent(new Event('input', { bubbles: true })); }""")
        pc.wait_for_timeout(200)
        check("Hauteur 30" in pc.evaluate("document.querySelector('.sk-3d-status').textContent"), "dragging the slider stretches the part at once (« Hauteur 30 »)")
        check(pc.evaluate("document.querySelector('.sk-3d-stage .sk-bubble [data-key=\"pp\"]').value") == "30", "the number follows the slider")
        pc.locator('.sk-3d-stage .sk-bubble [data-key="pp"]').fill("35")
        pc.wait_for_timeout(1200)
        check("Aperçu" in pc.evaluate("document.querySelector('.sk-3d-status').textContent"), "typing 35 shows the exact preview before applying")
        check(st("return s.doc.features[0].depth;") == 20, "the preview did not change the drawing yet")
        pc.locator('.sk-3d-stage .sk-bubble [data-key="pp"]').press("Enter")
        settle()
        wait_js(pc, "window.hqSketchState().doc.features[0].depth === 35", 15000)
        check(st("return s.doc.features[0].depth;") == 35, "Enter applied the new height: 35 mm")
        zmax = st("return Math.max(...s.mesh.flat().map(p => p[2]));")
        check(abs(zmax - 35) < 1e-6, "the part is rebuilt to 35 mm (%s; before: %s triangles)" % (zmax, tris0))
        pc.screenshot(path=str(OUT / "fluid-pushpull.png"))

        # ---- push / pull by dragging the face itself (the camera must not orbit)
        tgt = st("""const c = document.querySelector('.sk-3d-canvas'), r = c.getBoundingClientRect(); let best = null;
          s.mesh.forEach(t => { if (!t.every(p => Math.abs(p[2] - 35) < 1e-6)) return; const m = [0, 1, 2].map(k => (t[0][k] + t[1][k] + t[2][k]) / 3);
            const a = c.hqSolidProject(m), b = c.hqSolidProject([m[0], m[1], m[2] + 5]); const area = Math.abs((t[1][0]-t[0][0])*(t[2][1]-t[0][1]) - (t[2][0]-t[0][0])*(t[1][1]-t[0][1]));
            if (!best || area > best.area) best = { area, x: r.left + (a[0] + 1) / 2 * r.width, y: r.top + (1 - a[1]) / 2 * r.height, x2: r.left + (b[0] + 1) / 2 * r.width, y2: r.top + (1 - b[1]) / 2 * r.height }; });
          return best;""")
        pc.mouse.click(tgt["x"], tgt["y"])
        pc.wait_for_timeout(400)
        check(st("return s.pushPull && s.pushPull.depth;") == 35, "the top face is picked for a drag")
        pc.wait_for_timeout(450)
        pc.mouse.move(tgt["x"], tgt["y"])
        pc.mouse.down()
        pc.mouse.move((tgt["x"] + tgt["x2"]) / 2, (tgt["y"] + tgt["y2"]) / 2, steps=6)
        pc.mouse.move(tgt["x2"], tgt["y2"], steps=6)  # five model units outward on screen
        live = st("return [s.previewing, Math.max(...s.mesh.flat().map(p => p[2]))];")
        check(live[0] is True, "while dragging, the shown part is the live stretch")
        status = pc.evaluate("document.querySelector('.sk-3d-status').textContent")
        pc.mouse.up()
        settle()
        wait_js(pc, "Math.abs(window.hqSketchState().doc.features[0].depth - 35) > 0.5", 15000)
        d2 = st("return s.doc.features[0].depth;")
        check(38 <= d2 <= 42, "releasing applied the dragged height, about 40 mm (%s; status « %s »)" % (d2, status))
        z2 = st("return Math.max(...s.mesh.flat().map(p => p[2]));")
        check(abs(z2 - d2) < 1e-6, "and the exact part was rebuilt to it (%s)" % z2)
        prefs = pc.evaluate("JSON.parse(localStorage.getItem('tf_hq_sketch_prefs_v1') || '{}')")
        check(prefs.get("radius") or prefs.get("autoRules") is True, "the last values are remembered on this device (%s)" % prefs)
        check(not errors, "no page errors (%s)" % errors[:3])
        ctx.close()
        b.close()
    print("\n".join(results))
    print("FAILED" if any(r.startswith("FAIL") for r in results) else "ALL OK")


if __name__ == "__main__":
    main()
