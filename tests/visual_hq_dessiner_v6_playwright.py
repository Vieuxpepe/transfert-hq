"""Dessiner v6 in a browser: constraints and degrees of freedom, arcs, a sketch on another plane, a boss from it, a
fillet on an edge picked in 3D, suppress / reorder / rollback, STEP export and mass properties.

Throwaway server only, run by a Python that has the exact engine (requirements-occ.txt):
  tail -f /dev/null | <python with OCP> tests/carnet_test_server.py <empty dir>
  HQ_BASE=http://127.0.0.1:<port> python tests/visual_hq_dessiner_v6_playwright.py
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visual_hq_desk_feel_playwright as V  # noqa: E402  (login, HIDE; refuses live ports)
from visual_hq_solid_v5_playwright import box_doc, wait_js  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-dessiner-v6")))
results = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    print(results[-1], flush=True)
    return bool(cond)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1440, "height": 1100}, accept_downloads=True)
        pc = ctx.new_page()
        V.login(pc)
        pc.evaluate("""(doc) => localStorage.setItem('tf_hq_sketch_draft_v1', JSON.stringify({ v: 1, at: Date.now(), name: 'boitier', stem: '', dirty: true, doc }))""", box_doc())
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(V.HIDE)
        st = lambda js: pc.evaluate("() => { const s = window.hqSketchState(); " + js + " }")
        wait_js(pc, "window.hqSketchState().doc && window.hqSketchState().doc.objects.length === 5 && window.hqSketchState().W > 0", 15000)
        wait_js(pc, "window.hqSketchState().caps && window.hqSketchState().caps.exact", 15000)
        pc.wait_for_timeout(800)  # the view settles after the toolbar re-renders with the sketch selector
        wait_js(pc, "document.querySelector('.sk-sketch-sel')", 10000)
        check(True, "the exact engine is available: the sketch selector is offered")

        def settle():
            for _ in range(150):
                if not st("return s.solidBusy;"):
                    break
                pc.wait_for_timeout(100)
            pc.wait_for_timeout(300)

        def to_screen(x, y):
            return pc.evaluate("""([x, y]) => { const s = window.hqSketchState(); const c = document.querySelector('.sk-canvas').getBoundingClientRect();
              const q = window.HQSketch.toScreen(s.view, s.H, x, y); return [c.left + q.x, c.top + q.y]; }""", [x, y])

        def click_model(x, y):
            pc.mouse.click(*to_screen(x, y))
            pc.wait_for_timeout(150)

        def drag_model(a, bpt, steps=8):
            pa, pb = to_screen(*a), to_screen(*bpt)
            pc.mouse.move(*pa); pc.mouse.down(); pc.mouse.move(*pb, steps=steps); pc.mouse.up()
            pc.wait_for_timeout(200)

        # ---- a geometric constraint turns the drawing into v6 and shows its degrees of freedom
        click_model(50, 0)  # bottom side of the 100 x 60 rectangle
        check(st("return s.sel.length;") == 1, "a side of the rectangle is selected")
        pc.click('[data-geo="horizontal"]')
        pc.wait_for_timeout(300)
        k = st("return { v: s.doc.version, k: s.doc.constraints.map(c => c.type) };")
        check(k["v"] == 6 and k["k"] == ["horizontal"], "« Horizontale » added a v6 constraint (%s)" % k)
        dof = pc.locator(".sk-geo .sk-prop-head").inner_text()
        check("degré" in dof, "the panel shows the degrees of freedom left (« %s »)" % dof.strip())
        blue = pc.evaluate("""() => { const c = document.querySelector('.sk-canvas'), g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
          let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 80 && d[i + 1] > 90 && d[i + 1] < 140 && d[i + 2] > 190) n++; return n; }""")
        check(blue > 50, "under-defined geometry is drawn blue (%d px)" % blue)

        # ---- arc tool: centre, drag to the start, click the end
        pc.click('[data-tool="arc"]')
        drag_model((50, 30), (70, 30))  # inside the view, on the grid
        click_model(50, 50)
        arc = st("return s.doc.objects.filter(o => o.type === 'arc').length;")
        check(arc == 1, "the arc tool drew an arc")

        # ---- a sketch on the XZ plane, and a boss from it
        pc.click('[data-tool="select"]')
        pc.click('[data-act="newSketch"]')
        pc.select_option('[data-ns="plane"]', "XZ")
        pc.fill('[data-ns="name"]', "Face avant")
        pc.click('[data-do="createSketch"]')
        pc.wait_for_timeout(400)
        sk = st("return { active: s.sketch, n: (s.doc.sketches || []).length };")
        check(sk["n"] == 1 and sk["active"], "« Nouvelle esquisse » on XZ is now the active sketch (%s)" % sk)
        check(st("return window.HQSketch.inSketch(s.doc, s.sketch).objects.length;") == 0, "the new sketch starts empty (the base drawing is hidden)")
        pc.click('[data-tool="rect"]')
        drag_model((30, 0), (60, 10))  # on the 10 mm grid
        tagged = st("return s.doc.objects.filter(o => o.sketch === s.sketch).length;")
        check(tagged == 4, "a rectangle drawn there belongs to that sketch (%d lines)" % tagged)
        pc.click('[data-tool="select"]')
        click_model(45, 0)
        check(len(st("return s.sel;")) >= 1, "its side is selected in that sketch")
        pc.fill('[data-solid="boss.depth"]', "6")
        pc.click('[data-act="solid-boss"]')
        settle()
        f = st("return s.doc.features.map(f => f.type + (f.op ? ':' + f.op : ''));")
        check(f == ["extrude", "extrude:add"], "a boss grew from the XZ sketch (%s)" % f)
        m = st("return s.mass;")
        check(m and abs(m["volume"] - (120000 + 30 * 10 * 6)) < 1e-3, "exact volume with the boss: %s" % (m and round(m["volume"], 3)))
        check(m and abs(m["size"][1] - 66) < 1e-6, "the boss sticks 6 mm out of the front face (depth %s)" % (m and m["size"]))

        # ---- fillet on an edge picked in the 3D view
        pc.click('[data-act="edgePick"]')
        pc.wait_for_timeout(600)
        pc.locator(".sk-3d-canvas").scroll_into_view_if_needed()
        pc.wait_for_timeout(300)
        # the vertical corner edge nearest the camera (hidden edges are rightly not pickable)
        target = st("""const c = document.querySelector('.sk-3d-canvas'), r = c.getBoundingClientRect();
          let best = null;
          s.edges.forEach((e, i) => {
            if (!(e.line && Math.abs(e.a[0] - e.b[0]) < 1e-9 && Math.abs(e.a[1] - e.b[1]) < 1e-9 && [0, 100].includes(e.a[0]) && [0, 60].includes(e.a[1]))) return;
            const p = c.hqSolidProject(e.m);
            if (!best || p[2] < best.d) best = { i: i, d: p[2], x: r.left + (p[0] + 1) / 2 * r.width, y: r.top + (1 - p[1]) / 2 * r.height, corner: [e.a[0], e.a[1]] };
          });
          return best;""")
        check(target is not None, "the exact part lists its edges for picking")
        if target:
            pc.mouse.click(target["x"], target["y"])
            pc.wait_for_timeout(300)
        picks = st("return s.edgePick ? s.edgePick.picks.slice() : null;")
        check(picks == [target and target["i"]], "a click in 3D picked that edge (%s)" % picks)
        pc.fill('[data-solid="rf.radius"]', "5")
        before = st("return s.mass.volume;")
        pc.click('[data-act="solid-fillet"]')
        settle()
        after = st("return s.mass ? s.mass.volume : 0;")
        check(st("return s.doc.features.slice(-1)[0].type;") == "fillet" and abs((before - after) - (25 - 25 * 3.141592653589793 / 4) * 20) < 1e-3,
              "an exact 5 mm congé on that edge (removed %s mm³)" % round(before - after, 3))
        pc.locator(".sk-3d-stage").screenshot(path=str(OUT / "v6-part.png"))

        # ---- suppress, reorder, rollback
        pc.locator('.sk-feat[data-type="fillet"] input[data-active]').uncheck()
        settle()
        check(st("return !!s.doc.features[2].suppressed;") and abs(st("return s.mass.volume;") - before) < 1e-3, "unticking « active » suppresses the congé")
        pc.locator('.sk-feat[data-type="fillet"] input[data-active]').check()
        settle()
        pc.click('.sk-feat[data-type="fillet"] [data-act="featUp"]')
        settle()
        check(st("return s.doc.features.map(f => f.type);") == ["extrude", "fillet", "extrude"], "↑ moved the congé before the boss")
        pc.evaluate("() => { const r = document.querySelector('[data-rollback]'); r.value = '1'; r.dispatchEvent(new Event('change', { bubbles: true })); }")
        settle()
        check(st("return s.doc.rollback;") == 1 and abs(st("return s.mass.volume;") - 120000) < 1e-3, "the rollback point builds only the base")
        pc.evaluate("() => { const r = document.querySelector('[data-rollback]'); r.value = r.max; r.dispatchEvent(new Event('change', { bubbles: true })); }")
        settle()
        check(st("return s.doc.rollback;") is None, "moving it to the end builds everything again")
        pc.locator(".sk-solid").screenshot(path=str(OUT / "v6-panel.png"))

        # ---- STEP
        with pc.expect_download(timeout=30000) as dl:
            pc.click('[data-act="step3d"]')
        data = Path(dl.value.path()).read_bytes()
        check(data.startswith(b"ISO-10303-21;") and dl.value.suggested_filename.endswith(".step"), "« Exporter STEP » downloaded %s (%d bytes)" % (dl.value.suggested_filename, len(data)))
        b.close()
    print("\n".join(results))
    print("FAILED" if any(r.startswith("FAIL") for r in results) else "ALL OK")


if __name__ == "__main__":
    main()
