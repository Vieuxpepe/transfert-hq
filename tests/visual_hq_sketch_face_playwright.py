"""Dessiner: a real, editable sketch on a picked face, extended into matter or cut into the part.

Click a face in the 3D view → « Esquisser sur la face » in the bubble → the 2D sketch opens on that plane at that
height, with the face's outline as a guide → draw, select the outline, « Extruder » Ajouter (outward) or Enlever
(into the part).

Throwaway server only, on a Python with OCP:
  tail -f /dev/null | <python> tests/carnet_test_server.py <empty dir>
  HQ_BASE=http://127.0.0.1:<port> python tests/visual_hq_sketch_face_playwright.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visual_hq_desk_feel_playwright as V  # noqa: E402  (login, HIDE; refuses live ports)
from visual_hq_solid_v5_playwright import box_doc, wait_js  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-sketch-face")))
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
        doc = box_doc()
        doc["objects"] = [o for o in doc["objects"] if o["type"] == "line"]  # a plain 100 x 60 x 20 block
        doc["points"] = [p for p in doc["points"] if p["id"].startswith("a")]
        pc.evaluate("""(doc) => localStorage.setItem('tf_hq_sketch_draft_v1', JSON.stringify({ v: 1, at: Date.now(), name: 'bloc', stem: '', dirty: true, doc }))""", doc)
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(V.HIDE)
        st = lambda js: pc.evaluate("() => { const s = window.hqSketchState(); " + js + " }")
        wait_js(pc, "window.hqSketchState().doc && window.hqSketchState().W > 0", 15000)
        wait_js(pc, "window.hqSketchState().caps && window.hqSketchState().caps.exact", 15000)
        pc.wait_for_timeout(900)
        pc.locator(".sk-stage").scroll_into_view_if_needed()

        def to_screen(x, y):
            return pc.evaluate("""([x, y]) => { const s = window.hqSketchState(); const c = document.querySelector('.sk-canvas').getBoundingClientRect();
              const q = window.HQSketch.toScreen(s.view, s.H, x, y); return [c.left + q.x, c.top + q.y]; }""", [x, y])

        def settle():
            for _ in range(200):
                if not st("return s.solidBusy;"):
                    break
                pc.wait_for_timeout(100)
            pc.wait_for_timeout(400)

        def frame_view():
            pc.evaluate("() => { const s = window.hqSketchState(); s.doc.grid.snap = false; s.doc.snap.angle = false; s.view.ppu = 6; s.view.x0 = -10; s.view.y0 = -10; }")
            pc.mouse.move(5, 5)
            pc.evaluate("window.dispatchEvent(new Event('resize'))")
            pc.wait_for_timeout(300)
            pc.evaluate("() => { const s = window.hqSketchState(); s.view.ppu = 6; s.view.x0 = -10; s.view.y0 = -10; }")
            pc.mouse.move(6, 6)
            pc.wait_for_timeout(200)

        def volume():
            return st("return s.mass && s.mass.volume;")

        def bubble_acts(stage):
            return pc.evaluate("""(stage) => { const b = document.querySelector(stage + ' .sk-bubble'); return b && !b.hidden ? [...b.querySelectorAll('[data-act-key]')].map(i => i.dataset.actKey) : null; }""", stage)

        def click_face(pred_js):
            """Click the biggest visible triangle of a face selected by pred_js(triangle); returns the picked face's normal."""
            pt = st("""const c = document.querySelector('.sk-3d-canvas'), r = c.getBoundingClientRect(); let best = null;
              const pred = %s;
              s.mesh.forEach(t => { if (!pred(t)) return; const area = Math.abs((t[1][0]-t[0][0])*(t[2][1]-t[0][1]) - (t[2][0]-t[0][0])*(t[1][1]-t[0][1])) + Math.abs((t[1][0]-t[0][0])*(t[2][2]-t[0][2]) - (t[2][0]-t[0][0])*(t[1][2]-t[0][2])) + Math.abs((t[1][1]-t[0][1])*(t[2][2]-t[0][2]) - (t[2][1]-t[0][1])*(t[1][2]-t[0][2]));
                if (!best || area > best.area) best = { area, m: [0, 1, 2].map(k => (t[0][k] + t[1][k] + t[2][k]) / 3) }; });
              if (!best) return null; const p = c.hqSolidProject(best.m); return { x: r.left + (p[0] + 1) / 2 * r.width, y: r.top + (1 - p[1]) / 2 * r.height };""" % pred_js)
            if not pt:
                return None
            pc.mouse.click(pt["x"], pt["y"])
            pc.wait_for_timeout(500)
            return st("return s.faceSelection && s.faceSelection.plane.normal.map(v => Math.round(v));")

        # ---- 1. the top face → a sketch at z = 20, outward = +1
        pc.click('[data-act="view3d"]')
        wait_js(pc, "window.hqSketchState().mesh && window.hqSketchState().mesh.length > 0", 30000)
        settle()
        n = click_face("t => t.every(p => Math.abs(p[2] - 20) < 1e-6)")
        check(n == [0, 0, 1], "clicking the top face selects it (normal %s)" % n)
        acts = bubble_acts(".sk-3d-stage")
        check(acts and "faceSketch" in acts, "the 3D bubble offers « Esquisser sur la face » (%s)" % acts)
        pc.wait_for_timeout(500)  # a bubble ignores a click made the instant it appears
        pc.locator('.sk-3d-stage .sk-bubble [data-act-key="faceSketch"]').click()
        pc.wait_for_timeout(600)
        sk = st("return s.doc.sketches.slice(-1)[0];")
        check(sk and sk["plane"] == "XY" and sk["offset"] == 20 and sk["face"] == 1, "a sketch on XY at z = 20, outward +1 was created (%s)" % sk)
        check(st("return s.sketch === s.doc.sketches.slice(-1)[0].id && !s.tab3d && s.tool;") == "rect", "it is the active sketch, in 2D, with the rectangle tool ready")
        frame_view()
        pc.screenshot(path=str(OUT / "face-sketch-top.png"))

        # ---- 2. draw on it, extrude outward
        pa, pb = to_screen(30, 10), to_screen(70, 40)
        pc.mouse.move(*pa); pc.mouse.down(); pc.mouse.move(*pb, steps=8); pc.mouse.up()
        pc.wait_for_timeout(300)
        pc.keyboard.press("v")
        pc.mouse.dblclick(*to_screen(50, 10))
        pc.wait_for_timeout(300)
        check(len(st("return s.sel;")) == 4, "double-click selects the new rectangle's outline (%s)" % st("return s.sel;"))
        v0 = volume()
        pc.wait_for_timeout(500)
        pc.locator('.sk-stage .sk-bubble [data-key="h"]').fill("8")
        pc.locator('.sk-stage .sk-bubble [data-key="h"]').press("Enter")
        settle()
        f = st("return s.doc.features.slice(-1)[0];")
        check(f and f["op"] == "add" and not f.get("reverse") and f["depth"] == 8, "« Extruder » made a boss with no reversal (%s)" % f)
        zmax = st("return Math.max(...s.mesh.flat().map(p => p[2]));")
        check(abs(zmax - 28) < 1e-6, "the part now reaches z = 28 (%s)" % zmax)
        v1 = volume()
        check(v0 is None or True, "")
        results.pop()
        check(v1 and abs(v1 - (100 * 60 * 20 + 40 * 30 * 8)) < 1, "volume = block + 40 × 30 × 8 boss (%s)" % v1)
        pc.screenshot(path=str(OUT / "face-sketch-boss.png"))

        # ---- 3. a side face → a sketch on XZ / YZ, then a pocket INTO the part
        side = None
        for name, pred, expect in (("front", "t => t.every(p => Math.abs(p[1]) < 1e-6)", [0, -1, 0]),
                                   ("right", "t => t.every(p => Math.abs(p[0] - 100) < 1e-6)", [1, 0, 0]),
                                   ("back", "t => t.every(p => Math.abs(p[1] - 60) < 1e-6)", [0, 1, 0]),
                                   ("left", "t => t.every(p => Math.abs(p[0]) < 1e-6)", [-1, 0, 0])):
            n = click_face(pred)
            if n == expect:
                side = name
                break
        check(side is not None, "a side face can be picked in the 3D view (%s)" % side)
        pc.wait_for_timeout(500)
        pc.locator('.sk-3d-stage .sk-bubble [data-act-key="faceSketch"]').click()
        pc.wait_for_timeout(600)
        sk = st("return s.doc.sketches.slice(-1)[0];")
        want = {"front": ("XZ", 0, 1), "back": ("XZ", -60, -1), "right": ("YZ", 100, 1), "left": ("YZ", 0, -1)}.get(side)
        check(sk and (sk["plane"], sk["offset"], sk["face"]) == want, "the %s face gives a sketch on %s at %s, outward %s (%s)" % (side, want and want[0], want and want[1], want and want[2], sk))
        frame_view()
        pa, pb = to_screen(10, 5), to_screen(30, 15)
        pc.mouse.move(*pa); pc.mouse.down(); pc.mouse.move(*pb, steps=8); pc.mouse.up()
        pc.wait_for_timeout(300)
        pc.keyboard.press("v")
        pc.mouse.dblclick(*to_screen(20, 5))
        pc.wait_for_timeout(300)
        check(len(st("return s.sel;")) == 4, "the pocket's outline is selected")
        pc.wait_for_timeout(500)
        pc.locator('.sk-stage .sk-bubble [data-key="op"]').select_option("cut")
        pc.locator('.sk-stage .sk-bubble [data-key="h"]').fill("5")
        pc.locator('.sk-stage .sk-bubble [data-key="h"]').press("Enter")
        settle()
        f = st("return s.doc.features.slice(-1)[0];")
        # a cut goes against the outward side: reversed when the sketch normal points outward (face +1), as is when it points inward (-1)
        check(f and f["op"] == "cut" and bool(f.get("reverse")) == (want[2] > 0), "« Enlever » on the %s face goes into the part (reverse=%s)" % (side, f and f.get("reverse")))
        v2 = volume()
        check(v1 and v2 and abs((v1 - v2) - 20 * 10 * 5) < 1, "the pocket removed 20 × 10 × 5 (volume %s → %s)" % (v1, v2))
        pc.screenshot(path=str(OUT / "face-sketch-pocket.png"))

        # ---- 4. a picked face goes stale with the part: undo drops it and its bubble
        n = click_face("t => t.every(p => Math.abs(p[2] - 28) < 1e-6)")
        check(n == [0, 0, 1] and bubble_acts(".sk-3d-stage"), "the boss' top face is picked again (%s)" % n)
        pc.click('[data-act="undo"]')
        pc.wait_for_timeout(500)
        check(st("return s.faceSelection;") is None and not bubble_acts(".sk-3d-stage"), "undo drops the picked face and closes its bubble")
        check(not pc.evaluate("!document.querySelector('.sk-face-start').hidden"), "« Dessiner sur cette face » is hidden again")

        # ---- 5. the quick face editor (« Dessiner sur cette face ») still works next to the new bubble action
        n_before = st("return (s.doc.faceFeatures || []).length;")
        n = click_face("t => t.every(p => Math.abs(p[2] - 28) < 1e-6)")
        check(n == [0, 0, 1] and pc.evaluate("!document.querySelector('.sk-face-start').hidden"), "the quick « Dessiner sur cette face » button still appears (%s)" % n)
        pc.click(".sk-face-start")
        pc.wait_for_timeout(500)
        check(pc.evaluate("!document.querySelector('.sk-face-editor').hidden"), "it opens the quick face editor")
        box = pc.evaluate("(() => { const r = document.querySelector('.sk-face-canvas').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        pc.mouse.move(box[0] + box[2] * 0.42, box[1] + box[3] * 0.42)
        pc.mouse.down()
        pc.mouse.move(box[0] + box[2] * 0.58, box[1] + box[3] * 0.58, steps=6)
        pc.mouse.up()
        pc.wait_for_timeout(200)
        pc.locator("[data-face-depth]").fill("3")
        pc.click('[data-face="extrude"]')
        pc.wait_for_timeout(400)
        settle()
        wait_js(pc, "(window.hqSketchState().doc.faceFeatures || []).length > %d" % n_before, 15000)
        z_after = st("return Math.max(...s.mesh.flat().map(p => p[2]));")
        check(st("return (s.doc.faceFeatures || []).length;") == n_before + 1 and abs(z_after - 31) < 1e-6, "« Ajouter matière » in the quick editor still adds a face feature: the part now reaches z = 31 (%s)" % z_after)
        check(pc.evaluate("document.querySelector('.sk-face-editor').hidden") and st("return s.faceSelection;") is None, "and the editor closes with the selection cleared")
        check(not errors, "no page errors (%s)" % errors[:3])
        ctx.close()
        b.close()
    print("\n".join(results))
    print("FAILED" if any(r.startswith("FAIL") for r in results) else "ALL OK")


if __name__ == "__main__":
    main()
