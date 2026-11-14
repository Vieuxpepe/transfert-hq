"""Dessiner's floating action bubble in a browser: the right fields next to the selection, Enter applies, Escape
closes, 3D edge picking, and a docked bubble on a phone. Nothing should need a scroll to the panel below.

Throwaway server only (a Python with OCP shows the v6 constraint chips and the congé):
  tail -f /dev/null | <python> tests/carnet_test_server.py <empty dir>
  HQ_BASE=http://127.0.0.1:<port> python tests/visual_hq_sketch_float_playwright.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visual_hq_desk_feel_playwright as V  # noqa: E402  (login, HIDE; refuses live ports)
from visual_hq_solid_v5_playwright import box_doc, wait_js  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-sketch-float")))
results = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    print(results[-1], flush=True)
    return bool(cond)


def flat_doc():
    d = box_doc()
    d["features"] = []
    return d


def open_dessiner(pw, b, viewport, doc, mobile=False):
    ctx = b.new_context(**(pw.devices["iPhone 13"] if mobile else {"viewport": viewport}))
    pc = ctx.new_page()
    V.login(pc)
    pc.evaluate("""(doc) => localStorage.setItem('tf_hq_sketch_draft_v1', JSON.stringify({ v: 1, at: Date.now(), name: 'piece', stem: '', dirty: true, doc }))""", doc)
    pc.evaluate("setView('dessiner')")
    pc.wait_for_selector(".sk-canvas", timeout=20000)
    pc.evaluate(V.HIDE)
    wait_js(pc, "window.hqSketchState().doc && window.hqSketchState().W > 0", 15000)
    pc.wait_for_timeout(900)
    pc.locator(".sk-stage").scroll_into_view_if_needed()
    return ctx, pc


def helpers(pc):
    st = lambda js: pc.evaluate("() => { const s = window.hqSketchState(); " + js + " }")

    def click_model(x, y):
        p = pc.evaluate("""([x, y]) => { const s = window.hqSketchState(); const c = document.querySelector('.sk-canvas').getBoundingClientRect();
          const q = window.HQSketch.toScreen(s.view, s.H, x, y); return [c.left + q.x, c.top + q.y]; }""", [x, y])
        pc.mouse.click(p[0], p[1])
        pc.wait_for_timeout(250)

    def settle():
        for _ in range(150):
            if not st("return s.solidBusy;"):
                break
            pc.wait_for_timeout(100)
        pc.wait_for_timeout(300)

    def bubble(stage=".sk-stage"):
        return pc.evaluate("""(stage) => { const b = document.querySelector(stage + ' .sk-bubble'); if (!b || b.hidden) return null;
          const r = b.getBoundingClientRect(), s = document.querySelector(stage).getBoundingClientRect();
          return { title: b.querySelector('strong').textContent, keys: [...b.querySelectorAll('[data-key]')].map(i => i.dataset.key),
                   acts: [...b.querySelectorAll('[data-act-key]')].map(i => i.dataset.actKey), docked: b.classList.contains('is-docked'),
                   inStage: r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1,
                   inView: r.top >= 0 && r.bottom <= innerHeight, box: [r.left, r.top, r.right, r.bottom] }; }""", stage)
    return st, click_model, settle, bubble


def desktop(pw, b):
    ctx, pc = open_dessiner(pw, b, {"width": 1440, "height": 1000}, flat_doc())
    st, click_model, settle, bubble = helpers(pc)
    exact = pc.evaluate("!!(window.hqSketchState().caps && window.hqSketchState().caps.exact)")
    click_model(50, 0)  # bottom side of the 100 x 60 rectangle
    bb = bubble()
    check(bb and "len" in bb["keys"] and "h" in bb["keys"], "a selected side shows its length and « Extrusion » next to it (%s)" % (bb and bb["keys"]))
    check(bb and bb["inStage"] and bb["inView"], "the bubble is inside the drawing and on screen, no scroll needed")
    line = pc.evaluate("""() => { const s = window.hqSketchState(); const o = window.HQSketch.getObj(s.doc, s.sel[0]); const pm = window.HQSketch.pointMap(s.doc);
      const c = document.querySelector('.sk-canvas').getBoundingClientRect(); const a = window.HQSketch.toScreen(s.view, s.H, pm.get(o.p1).x, pm.get(o.p1).y), z = window.HQSketch.toScreen(s.view, s.H, pm.get(o.p2).x, pm.get(o.p2).y);
      return [c.left + Math.min(a.x, z.x), c.top + Math.min(a.y, z.y), c.left + Math.max(a.x, z.x), c.top + Math.max(a.y, z.y)]; }""")
    covers = bb and not (bb["box"][2] <= line[0] or bb["box"][0] >= line[2] or bb["box"][3] <= line[1] - 3 or bb["box"][1] >= line[3] + 3)
    check(not covers, "it does not cover the selected line")
    pe = lambda: pc.evaluate("getComputedStyle(document.querySelector('.sk-stage .sk-bubble')).pointerEvents")
    check(pe() == "auto", "the bubble takes clicks normally")
    pc.keyboard.down("Shift")
    check(pe() == "none", "holding Shift makes the bubble click-through, so a second line under it can be added to the selection")
    pc.keyboard.up("Shift")
    check(pe() == "auto", "releasing Shift gives the bubble back")
    pc.click('[data-act="multi"]')
    check(pe() == "none", "the Multi toggle makes it click-through too")
    pc.click('[data-act="multi"]')
    check(pe() == "auto", "and switching Multi off restores it")
    if exact:
        check("geo:horizontal" in bb["acts"], "with the exact engine it offers H / V / Fixer chips")
    pc.locator('.sk-stage .sk-bubble [data-key="len"]').fill("120")
    pc.locator('.sk-stage .sk-bubble [data-key="len"]').press("Enter")
    pc.wait_for_timeout(300)
    L = st("const o = window.HQSketch.getObj(s.doc, s.sel[0]); const pm = window.HQSketch.pointMap(s.doc); return Math.hypot(pm.get(o.p2).x - pm.get(o.p1).x, pm.get(o.p2).y - pm.get(o.p1).y);")
    check(abs(L - 120) < 1e-6, "typing 120 + Enter in « Longueur » applied it (%s)" % L)
    bb = bubble()
    check(bb and "120" in bb["title"], "the bubble follows the new length (« %s »)" % (bb and bb["title"]))
    pc.locator('.sk-stage .sk-bubble [data-key="h"]').fill("15")
    pc.locator('.sk-stage .sk-bubble [data-key="h"]').press("Enter")
    settle()
    f = st("return s.doc.features.map(f => [f.type, f.depth]);")
    check(f == [["extrude", 15]], "Enter in « Extrusion » extruded the shape, 15 mm (%s)" % f)
    pc.click('[data-act="view2d"]')
    pc.wait_for_timeout(400)
    click_model(24, 20)  # the circle
    bb = bubble()
    check(bb and "rad" in bb["keys"] and "hole" in bb["acts"], "a circle shows its radius and « Percer » (%s)" % (bb and bb["acts"]))
    pc.wait_for_timeout(450)  # a person never presses a button the instant it appears (the bubble ignores that)
    pc.locator('.sk-stage .sk-bubble [data-key="std"]').select_option("M4")
    pc.locator('.sk-stage .sk-bubble [data-act-key="hole"]').click()
    settle()
    f = st("return s.doc.features.map(f => f.type + (f.standard ? ':' + f.standard : ''));")
    check(f == ["extrude", "hole:M4"], "« Percer » from the bubble drilled an M4 hole (%s)" % f)
    pc.click('[data-act="view2d"]')
    pc.wait_for_timeout(400)
    click_model(50, 60)
    pc.keyboard.press("Tab")
    pc.locator('.sk-stage .sk-bubble [data-key]').first.press("Escape")
    pc.wait_for_timeout(200)
    check(bubble() is None, "Escape closes the bubble")
    click_model(0, 30)
    check(bubble() is not None, "selecting something else brings it back")
    pc.screenshot(path=str(OUT / "float-2d.png"))
    if exact:
        # 3D edge picking: the bubble carries the congé / chanfrein
        pc.click('[data-act="edgePick"]')
        pc.wait_for_timeout(600)
        bb = bubble(".sk-3d-stage")
        check(bb and "r" in bb["keys"] and "fillet" in bb["acts"], "edge picking shows a bubble with Rayon / Congé / Chanfrein")
        pc.locator(".sk-3d-canvas").scroll_into_view_if_needed()
        wait_js(pc, "window.hqSketchState().edges && window.hqSketchState().edges.length > 0", 20000)
        pc.wait_for_timeout(300)
        target = st("""const c = document.querySelector('.sk-3d-canvas'), r = c.getBoundingClientRect(); let best = null;
          s.edges.forEach((e, i) => { if (!(e.line !== false && Math.abs(e.a[0] - e.b[0]) < 1e-9 && Math.abs(e.a[1] - e.b[1]) < 1e-9)) return;
            const p = c.hqSolidProject(e.m || [(e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2, (e.a[2] + e.b[2]) / 2]); if (!best || p[2] < best.d) best = { i, d: p[2], x: r.left + (p[0] + 1) / 2 * r.width, y: r.top + (1 - p[1]) / 2 * r.height }; });
          return best;""")
        pc.mouse.click(target["x"], target["y"])
        pc.wait_for_timeout(300)
        bb = bubble(".sk-3d-stage")
        check(bb and bb["title"].startswith("1 arête"), "the bubble counts the picked edge (« %s »)" % (bb and bb["title"]))
        pc.locator('.sk-3d-stage .sk-bubble [data-key="r"]').fill("3")
        pc.locator('.sk-3d-stage .sk-bubble [data-key="r"]').press("Enter")
        settle()
        check(st("return s.doc.features.slice(-1)[0].type;") == "fillet", "Enter in « Rayon » applied a 3 mm congé")
        check(bubble(".sk-3d-stage") is None, "and the bubble closed with edge picking")
        pc.locator(".sk-3d-stage").screenshot(path=str(OUT / "float-3d.png"))
    ctx.close()


def phone(pw, b):
    ctx, pc = open_dessiner(pw, b, None, flat_doc(), mobile=True)
    st, click_model, settle, bubble = helpers(pc)
    pc.wait_for_timeout(800)  # the phone page finishes scrolling the drawing into view
    p = pc.evaluate("""() => { const s = window.hqSketchState(); const c = document.querySelector('.sk-canvas').getBoundingClientRect();
      const q = window.HQSketch.toScreen(s.view, s.H, 50, 0); return [c.left + q.x, c.top + q.y]; }""")
    pc.touchscreen.tap(p[0], p[1])  # a finger, as on a real phone
    pc.wait_for_timeout(600)
    bb = bubble()
    check(st("return s.doc.features.length;") == 0 and not st("return s.tab3d;"), "the tap only selected: its follow-up click did not press a bubble button")
    check(bb and not (bb["box"][0] <= p[0] <= bb["box"][2] and bb["box"][1] <= p[1] <= bb["box"][3]), "the docked bubble is not under the finger")
    check(bb and bb["docked"] and bb["inStage"], "on a phone the bubble docks at the bottom of the drawing (%s)" % (bb and bb["docked"]))
    pc.screenshot(path=str(OUT / "float-phone.png"))
    ctx.close()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        desktop(pw, b)
        phone(pw, b)
        b.close()
    print("\n".join(results))
    print("FAILED" if any(r.startswith("FAIL") for r in results) else "ALL OK")


if __name__ == "__main__":
    main()
