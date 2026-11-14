"""Dessiner 3D v5 in a browser: holes, edits that rebuild the part, refusals, profile dimensions, 3D history, revolve,
AR export, and the live 3D view in a Carnet page. Throwaway server only, run by a Python with manifold3d:

  python tests/visual_hq_solid_v5_playwright.py seed <seed.json>          # writes the Carnet seed
  tail -f /dev/null | <py313> tests/carnet_test_server.py <empty dir> <seed.json>
  <py313> tests/visual_hq_solid_v5_playwright.py save <that dir>          # saving builds the part: needs manifold3d
  HQ_BASE=http://127.0.0.1:<port> python tests/visual_hq_solid_v5_playwright.py   # a Python with Playwright
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

STEM = "piece-carnet_HQWeb-Desktop"
OUT = Path(os.environ.get("HQ_SCREENS", str(Path(os.environ.get("TEMP", ".")) / "hq-solid-v5")))
results = []


def check(cond, msg):
    results.append(("OK   " if cond else "FAIL ") + msg)
    print(results[-1], flush=True)
    return bool(cond)


def box_doc(version=2):
    pts = [{"id": "a0", "x": 0, "y": 0}, {"id": "a1", "x": 100, "y": 0}, {"id": "a2", "x": 100, "y": 60}, {"id": "a3", "x": 0, "y": 60},
           {"id": "c0", "x": 20, "y": 20}]
    lines = [{"id": f"l{i}", "type": "line", "p1": f"a{i}", "p2": f"a{(i + 1) % 4}", "group": "g1"} for i in range(4)]
    return {"format": "transfert-hq-sketch", "version": version, "units": "mm", "mode": "construction",
            "grid": {"spacing": 10, "visible": True, "snap": True}, "snap": {"angle": True, "angleStep": 15},
            "points": pts, "objects": lines + [{"id": "c1", "type": "circle", "center": "c0", "r": 4}], "constraints": [],
            "features": [{"id": "f1", "type": "extrude", "profile": [l["id"] for l in lines], "depth": 20, "extent": "blind"}]}


def seed(path):
    nb = {"version": 1, "notebook_rev": 4, "projects": [], "categories": [], "pages": [{
        "id": "page-3d", "rev": 1, "project_id": None, "category_id": None, "pinned": False, "deleted_at": None,
        "created_at": 1790680010.0, "updated_at": 1790680300.0,
        "content": {"version": 2, "blocks": [
            {"id": "block-p1", "type": "paragraph", "text": "Ma pièce imprimée", "marks": []},
            {"id": "block-d", "type": "drawing", "text": "", "marks": [], "drawing": {"id": STEM}}]}}]}
    Path(path).write_text(json.dumps(nb), encoding="utf-8")


def save_drawing_on_disk(root):
    import hq_drawings
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (240, 240, 240)).save(buf, format="PNG")
    doc = box_doc(5)
    doc["features"].append({"id": "f2", "type": "hole", "at": ["c1"], "standard": "M4", "fit": "clearance", "extent": "throughAll", "depth": 0})
    out = hq_drawings.save_drawing(Path(root), {"doc": doc, "name": "piece-carnet", "source": "desktop",
                                                "png": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()})
    return out


def wait_js(page, js, timeout=20000):
    """Poll a JS expression (the page's CSP forbids Playwright's eval-based waits)."""
    end = time.monotonic() + timeout / 1000
    while time.monotonic() < end:
        if page.evaluate("() => !!(" + js + ")"):
            return True
        page.wait_for_timeout(150)
    raise AssertionError("timed out waiting for " + js)


def run():
    import visual_hq_desk_feel_playwright as V  # login + HIDE; refuses live ports
    from playwright.sync_api import sync_playwright
    OUT.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1440, "height": 1000}, accept_downloads=True)
        pc = ctx.new_page()
        V.login(pc)
        pc.evaluate("""(doc) => localStorage.setItem('tf_hq_sketch_draft_v1', JSON.stringify({ v: 1, at: Date.now(), name: 'boite', stem: '', dirty: true, doc }))""", box_doc())
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(V.HIDE)
        pc.wait_for_timeout(600)
        st = lambda js: pc.evaluate("() => { const s = window.hqSketchState(); " + js + " }")
        mesh_z = "const zs = s.mesh.flat().map(p => p[2]); const xs = s.mesh.flat().map(p => p[0]); return { n: s.mesh.length, z: Math.max(...zs), x0: Math.min(...xs), x1: Math.max(...xs), f: s.doc.features.map(f => f.type), busy: s.solidBusy };"

        def settle():
            for _ in range(100):
                if not st("return s.solidBusy;"):
                    break
                pc.wait_for_timeout(100)
            pc.wait_for_timeout(250)

        def click_model(x, y):
            p = pc.evaluate("""([x, y]) => { const s = window.hqSketchState(); const c = document.querySelector('.sk-canvas').getBoundingClientRect();
              const q = window.HQSketch.toScreen(s.view, s.H, x, y); return [c.left + q.x, c.top + q.y]; }""", [x, y])
            pc.mouse.click(p[0], p[1])

        # select the circle in 2D, then drill it from the 3D panel
        click_model(24, 20)
        pc.wait_for_timeout(200)
        check(st("return s.sel.slice();") == ["c1"], "the circle is selected (%s)" % st("return s.sel.slice();"))
        pc.click('[data-act="view3d"]')
        wait_js(pc, "/triangles/.test(document.querySelector('.sk-3d-status').textContent)")
        base = st(mesh_z)
        pc.select_option('[data-solid="hole.standard"]', "M5")
        pc.select_option('[data-solid="hole.fit"]', "countersunk")
        pc.click('[data-act="solid-hole"]')
        settle()
        drilled = st(mesh_z)
        check(drilled["f"] == ["extrude", "hole"] and drilled["n"] > base["n"], "« Percer » drilled a countersunk M5 hole (%s → %s triangles)" % (base["n"], drilled["n"]))
        hole = st("return s.doc.features[1];")
        check(hole["standard"] == "M5" and hole["fit"] == "countersunk" and st("return s.doc.version;") == 5, "stored as a v5 hole (%s)" % hole)

        # repeat it in a line
        pc.fill('[data-solid="pat.count"]', "3")
        pc.fill('[data-solid="pat.dx"]', "25")
        pc.click('[data-act="solid-pattern"]')
        settle()
        check(st("return s.doc.features.map(f => f.type);") == ["extrude", "hole", "pattern"], "« Répéter » added 3 holes in a row")

        # change a number, the part updates: base height 20 -> 30
        row = pc.locator('.sk-feat[data-type="extrude"] input[data-edit="depth"]')
        row.fill("30")
        row.press("Enter")
        row.evaluate("e => e.dispatchEvent(new Event('change', { bubbles: true }))")
        settle()
        check(abs(st(mesh_z)["z"] - 30) < 1e-6, "editing the height rebuilt the part to 30 mm (%s)" % st(mesh_z)["z"])
        # the hole size too
        pc.select_option('.sk-feat[data-type="hole"] select[data-edit="standard"]', "M3")
        settle()
        check(st("return s.doc.features[1].standard;") == "M3", "editing the hole size applied (M3)")
        # a value that breaks the part is refused and nothing changes
        before = st("return JSON.stringify(s.doc.features);")
        pc.fill('[data-solid="shell.t"]', "40")
        pc.click('[data-act="solid-shell"]')
        settle()
        check(st("return JSON.stringify(s.doc.features);") == before, "an impossible shell (40 mm walls) is refused, the part is unchanged")
        pc.fill('[data-solid="shell.t"]', "2")
        pc.click('[data-act="solid-shell"]')
        settle()
        check(st("return s.doc.features.map(f => f.type);")[-1] == "shell", "a 2 mm open shell hollows it")
        # profile dimension: first side 100 -> 120
        side = pc.locator('input[data-dim-line]').first
        side.fill("120")
        side.evaluate("e => e.dispatchEvent(new Event('change', { bubbles: true }))")
        settle()
        w = st(mesh_z)
        check(abs((w["x1"] - w["x0"]) - 120) < 1e-6, "editing a profile side made the part 120 mm long (%s)" % round(w["x1"] - w["x0"], 3))
        pc.locator(".sk-3d-stage").screenshot(path=str(OUT / "pc-v5-part.png"))
        pc.wait_for_timeout(5000)  # toasts and the panel's motion settle
        pc.locator(".sk-solid").screenshot(path=str(OUT / "pc-v5-panel.png"))

        # 3D history: preview the first step, then go back to it, then undo
        steps = pc.evaluate("() => document.querySelector('[data-hist3d]') ? Number(document.querySelector('[data-hist3d]').max) + 1 : 0")
        check(steps >= 5, "the 3D history lists every step (%d)" % steps)
        now_doc = st("return JSON.stringify(s.doc.features);")
        pc.evaluate("() => { const r = document.querySelector('[data-hist3d]'); r.value = '0'; r.dispatchEvent(new Event('input', { bubbles: true })); }")
        pc.wait_for_timeout(1500)
        prev = pc.evaluate("() => document.querySelector('.sk-3d-status').textContent")
        check("Aperçu de l'étape 1" in prev and st("return JSON.stringify(s.doc.features);") == now_doc, "previewing step 1 changes nothing (« %s »)" % prev)
        pc.screenshot(path=str(OUT / "pc-v5-history.png"))
        pc.click('[data-act="hist3dGo"]')
        settle()
        check(st("return s.doc.features.map(f => f.type);") == ["extrude"], "« Revenir à cette étape » restored step 1")
        pc.click('.sk-acts [data-act="undo"]')
        settle()
        check(st("return JSON.stringify(s.doc.features);") == now_doc, "and Annuler brings the full part back")

        # AR export: on a desktop browser the .usdz is downloaded
        with pc.expect_download(timeout=30000) as dl:
            pc.click('[data-act="ar3d"]')
        data = Path(dl.value.path()).read_bytes()
        zf = zipfile.ZipFile(io.BytesIO(data))
        usda = zf.read("model.usda").decode()
        check(zf.namelist() == ["model.usda"] and 'upAxis = "Y"' in usda, "« Voir en AR » produced a USDZ (%d bytes)" % len(data))
        ctx.close()

        # revolve, from a fresh drawing: a half profile and an axis
        ctx = b.new_context(viewport={"width": 1440, "height": 1000})
        pc = ctx.new_page()
        V.login(pc)
        rev = {"format": "transfert-hq-sketch", "version": 2, "units": "mm", "mode": "construction",
               "grid": {"spacing": 10, "visible": True, "snap": True}, "snap": {"angle": True, "angleStep": 15},
               "points": [{"id": "r0", "x": 0, "y": 0}, {"id": "r1", "x": 15, "y": 0}, {"id": "r2", "x": 15, "y": 40}, {"id": "r3", "x": 0, "y": 40},
                          {"id": "x0", "x": 0, "y": -10}, {"id": "x1", "x": 0, "y": 50}],
               "objects": [{"id": f"m{i}", "type": "line", "p1": f"r{i}", "p2": f"r{(i + 1) % 4}", "group": "g1"} for i in range(4)] +
                          [{"id": "ax", "type": "centerline", "p1": "x0", "p2": "x1"}], "constraints": [], "features": []}
        pc.evaluate("""(doc) => localStorage.setItem('tf_hq_sketch_draft_v1', JSON.stringify({ v: 1, at: Date.now(), name: 'bouton', stem: '', dirty: true, doc }))""", rev)
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(V.HIDE)
        pc.wait_for_timeout(600)
        st = lambda js: pc.evaluate("() => { const s = window.hqSketchState(); " + js + " }")
        pc.click('[data-act="multi"]') if pc.locator('[data-act="multi"]').count() else None
        click_model(7.5, 40)  # the profile's top side (its group)
        click_model(0, 47)  # the axis, above the profile
        pc.wait_for_timeout(200)
        sel = st("return s.sel.slice();")
        check("ax" in sel and len(sel) >= 2, "profile and axis selected (%s)" % sel)
        pc.click('[data-act="view3d"]')
        pc.wait_for_timeout(500)
        pc.click('[data-act="solid-revolve"]')
        settle()
        r = st("const zs = s.mesh.flat().map(p => p[2]); return { f: s.doc.features.map(f => f.type), n: s.mesh.length, z0: Math.min(...zs), z1: Math.max(...zs) };")
        check(r["f"] == ["revolve"] and r["n"] > 100 and abs(r["z0"]) < 1e-6 and abs(r["z1"] - 30) < 1e-3, "« Tourner » made a Ø30 turned part resting on the table (%s)" % r)
        pc.screenshot(path=str(OUT / "pc-v5-revolve.png"))
        ctx.close()

        # AR from the second screen: the pad asks, the PC builds, the pad gets a Quick Look link
        ctx = b.new_context(viewport={"width": 1440, "height": 1000})
        pc = ctx.new_page()
        pad_ctx = b.new_context(**pw.devices["iPad Pro 11 landscape"])
        pad = pad_ctx.new_page()
        V.login(pc)
        V.login(pad)
        pc.evaluate("""(doc) => localStorage.setItem('tf_hq_sketch_draft_v1', JSON.stringify({ v: 1, at: Date.now(), name: 'boite', stem: '', dirty: true, doc }))""", box_doc())
        pc.evaluate("setView('dessiner')")
        pc.wait_for_selector(".sk-canvas", timeout=20000)
        pc.evaluate(V.HIDE)
        pad.click("#btn-desk")
        pad.wait_for_selector("#hq-desk.is-open")
        pad.evaluate(V.HIDE)
        wait_js(pad, "!document.querySelector('.desk-ar').hidden", 20000)
        check(True, "the pad offers « Voir en AR » while the PC shows a part")
        pad.click(".desk-ar")
        wait_js(pad, "!document.querySelector('.desk-ar-go').hidden", 30000)
        link = pad.evaluate("() => { const a = document.querySelector('.desk-ar-go'); return [a.getAttribute('rel'), a.getAttribute('href'), !!a.querySelector('img')]; }")
        check(link[0] == "ar" and str(link[1]).startswith("/api/drawings/usdz/") and link[2], "the pad gets a Quick Look link (%s)" % link)
        got = pad.evaluate("(u) => fetch(u, { credentials: 'same-origin' }).then(r => [r.status, r.headers.get('content-type')])", link[1])
        check(got == [200, "model/vnd.usdz+zip"], "and the pad can fetch the model with its own session (%s)" % got)
        pad.locator(".desk-pane[data-pane='pad']").screenshot(path=str(OUT / "pad-ar.png"))
        ctx.close(); pad_ctx.close()

        # Carnet: the saved drawing's part, live in 3D in the page
        ctx = b.new_context(viewport={"width": 1440, "height": 1000})
        pc = ctx.new_page()
        V.login(pc)
        pc.evaluate(V.HIDE)
        nav = pc.locator('[data-nav="carnet"]:visible').first
        if nav.count():
            nav.click()
        else:
            pc.evaluate("setView('carnet')")
        wait_js(pc, "document.querySelector('#hq-carnet-editor') && document.querySelector('#hq-carnet-editor').dataset.pageId", 30000)
        wait_js(pc, "document.querySelector('#hq-carnet-editor [data-carnet-struct=\"drawing\"]')", 20000)
        pc.evaluate(V.HIDE)
        for _ in range(60):
            if pc.evaluate("() => { const i = document.querySelector('#hq-carnet-editor img.carnet-drawing-img'); return !!(i && i.complete && i.naturalWidth); }"):
                break
            pc.wait_for_timeout(200)
        btn = pc.locator(".carnet-drawing-3d-btn")
        check(btn.is_visible(), "the drawing card offers « Voir en 3D »")
        btn.click()
        pc.wait_for_selector("canvas.carnet-drawing-3d", timeout=30000)
        pc.wait_for_timeout(600)
        from PIL import Image
        shot = Image.open(io.BytesIO(pc.locator("canvas.carnet-drawing-3d").screenshot())).convert("RGB")
        lit = sum(1 for r, g, bl in shot.getdata() if g > r + 40 and bl > r + 40)  # the part's teal, not the backdrop
        check(lit > 2000, "the part is drawn live in the page (%d teal pixels)" % lit)
        cv = pc.locator("canvas.carnet-drawing-3d").bounding_box()
        pc.mouse.move(cv["x"] + cv["width"] / 2, cv["y"] + cv["height"] / 2)
        pc.mouse.down(); pc.mouse.move(cv["x"] + cv["width"] / 2 + 120, cv["y"] + cv["height"] / 2, steps=8); pc.mouse.up()
        pc.locator(".carnet-drawing").first.screenshot(path=str(OUT / "carnet-3d.png"))
        check(pc.locator(".carnet-drawing-3d-btn").inner_text() == "Vue 2D", "and it can go back to the 2D preview")
        b.close()
    print("\n".join(results))
    print("FAILED" if any(r.startswith("FAIL") for r in results) else "ALL OK")


if __name__ == "__main__":
    if sys.argv[1:2] == ["seed"]:
        seed(sys.argv[2])
    elif sys.argv[1:2] == ["save"]:
        out = save_drawing_on_disk(sys.argv[2])
        print("saved", out.get("stem"))
        sys.exit(0 if out.get("stem") == STEM else 1)
    else:
        run()
