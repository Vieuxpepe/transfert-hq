"""Browser QA for the Lecteur 3D viewer (.stl / .glb) against a throwaway loopback HQ.

Self-contained: temp ROOT, fake PIN, 127.0.0.1 only; never the live root. Needs Playwright.
Fixtures are generated with struct: a binary STL (L-shaped block), an ASCII STL, a GLB with a
node hierarchy (TRS + matrix, uint16 indices, two base colours), a GLB that requires Draco
(French notice, no hang) and a truncated STL (French error). Runs Chromium with iPhone 13
emulation (CDP touch for the one-finger orbit) and WebKit's iPhone 13 profile (mouse drag for
the orbit; the pinch is synthetic touch pointer events in both). Checks: double tap opens the
Lecteur, non-blank render, orbit sign, pinch zoom, pan, Recadrer back to the fitted view.
Set HQ_MODEL_SCREENSHOTS=<dir> to save screenshots.
"""
import json
import os
import shutil
import struct
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import iphone_bridge
from playwright.sync_api import sync_playwright

FAKE_PIN = "246810"
SHOTS = os.environ.get("HQ_MODEL_SCREENSHOTS")
FOLDER = "Uni/Modeles"


def box_tris(x0, y0, z0, x1, y1, z1):
    v = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return [[v[i] for i in f] for f in faces]


def binary_stl(tris):
    out = bytearray(b"HQ test STL".ljust(80, b" ")) + struct.pack("<I", len(tris))
    for t in tris:
        out += struct.pack("<3f", 0, 0, 0) + b"".join(struct.pack("<3f", *p) for p in t) + b"\0\0"
    return bytes(out)


def ascii_stl(tris):
    lines = ["solid pyramide"]
    for t in tris:
        lines += ["facet normal 0 0 0", " outer loop"] + [f"  vertex {p[0]:.6e} {p[1]:.6e} {p[2]:.6e}" for p in t] + [" endloop", "endfacet"]
    return ("\n".join(lines + ["endsolid pyramide"]) + "\n").encode()


def glb(extra_json=None):
    # Unit cube (8 vertices, 36 uint16 indices) instanced by two nodes with different materials.
    verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    idx = [i for f in [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)] for i in f]
    pos = b"".join(struct.pack("<3f", *v) for v in verts)
    ind = struct.pack(f"<{len(idx)}H", *idx)
    bin_ = pos + ind + b"\0" * ((4 - len(ind) % 4) % 4)
    doc = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(bin_)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pos)}, {"buffer": 0, "byteOffset": len(pos), "byteLength": len(ind)}],
        "accessors": [{"bufferView": 0, "componentType": 5126, "count": 8, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 1]},
                      {"bufferView": 1, "componentType": 5123, "count": len(idx), "type": "SCALAR"}],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.9, 0.2, 0.15, 1]}},
                      {"pbrMetallicRoughness": {"baseColorFactor": [0.15, 0.35, 0.9, 1]}}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]},
                   {"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 1}]}],
        "nodes": [{"children": [1, 2], "translation": [0, 0.5, 0]},
                  {"mesh": 0, "scale": [3, 1, 1]},                                                   # long red bar
                  {"mesh": 1, "matrix": [1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 2, 1, 0, 1]}],         # tall blue post on top
        "scenes": [{"nodes": [0]}], "scene": 0,
    }
    doc.update(extra_json or {})
    js = json.dumps(doc).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    return (struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js
            + struct.pack("<II", len(bin_), 0x004E4942) + bin_)


def make_fixtures(root: Path):
    d = root / "Uni" / "Modeles"
    d.mkdir(parents=True)
    (d / "support.stl").write_bytes(binary_stl(box_tris(0, 0, 0, 40, 10, 5) + box_tris(0, 0, 5, 10, 10, 30)))
    pyr = [[(0, 0, 0), (10, 0, 0), (5, 5, 8)], [(10, 0, 0), (10, 10, 0), (5, 5, 8)], [(10, 10, 0), (0, 10, 0), (5, 5, 8)],
           [(0, 10, 0), (0, 0, 0), (5, 5, 8)], [(0, 0, 0), (10, 10, 0), (10, 0, 0)], [(0, 0, 0), (0, 10, 0), (10, 10, 0)]]
    (d / "pyramide ascii.stl").write_bytes(ascii_stl(pyr))
    (d / "assemblage.glb").write_bytes(glb())
    (d / "compresse.glb").write_bytes(glb({"extensionsUsed": ["KHR_draco_mesh_compression"], "extensionsRequired": ["KHR_draco_mesh_compression"]}))
    (d / "abime.stl").write_bytes(binary_stl(box_tris(0, 0, 0, 1, 1, 1))[:300])


def login(page, url):
    page.goto(url)
    page.fill('input[name="pin"]', FAKE_PIN)
    page.click('button[type="submit"]')
    page.wait_for_selector('.bottom-nav [data-nav="lecteur"]')


def open_folder(page):
    page.click('.bottom-nav [data-nav="fichiers"]')
    page.click('#file-list [data-open="Uni"].fname')
    page.click(f'#file-list [data-open="{FOLDER}"].fname')
    page.wait_for_selector(f'#file-list li.file[data-rel="{FOLDER}/support.stl"]')


def double_tap_row(page, name):
    if page.evaluate("document.body.dataset.view") != "fichiers":
        page.click('#btn-player-back')
        page.wait_for_function("() => document.body.dataset.view === 'fichiers'")
        page.wait_for_load_state("networkidle"); page.wait_for_timeout(300)
    rel = f"{FOLDER}/{name}"
    for _ in range(30):  # the list may re-render after Retour: tap only once the row is centred and still
        meta = page.locator(f'#file-list li.file[data-rel="{rel}"] .meta')
        meta.evaluate("el => el.scrollIntoView({ block: 'center' })")  # not under the fixed bottom nav
        page.wait_for_timeout(150)
        b = meta.bounding_box()
        x, y = b["x"] + min(40, b["width"] / 2), b["y"] + b["height"] / 2
        page.wait_for_timeout(150)
        hit = page.evaluate("([x, y]) => { const e = document.elementFromPoint(x, y), r = e && e.closest('li.file'); return r ? r.dataset.rel : null; }", [x, y])
        if hit == rel and meta.bounding_box() == b:
            break
    else:
        raise AssertionError(("row never settled", rel))
    page.touchscreen.tap(x, y); page.touchscreen.tap(x, y)
    page.wait_for_function("() => document.body.dataset.view === 'lecteur'", timeout=5000)
    shown = page.locator("#player-name").inner_text()
    assert shown == name, (name, shown)


def wait_model(page, triangles):
    page.wait_for_function("(n) => { const c=document.querySelector('#player-model-canvas'); return c && c.hqModelView && c.hqModelView().triangles === n; }",
                           arg=triangles, timeout=20000)
    page.wait_for_timeout(100)


def snap(page):
    return page.evaluate("document.querySelector('#player-model-canvas').hqModelSnapshot()")


def view(page):
    return page.evaluate("document.querySelector('#player-model-canvas').hqModelView()")


def canvas_box(page):
    page.locator('#player-model-canvas').scroll_into_view_if_needed()
    return page.locator('#player-model-canvas').bounding_box()


def synthetic_pinch(page, spread):
    """Two touch pointers moving apart by `spread` px each (plus a common drift): pinch zoom + pan."""
    page.evaluate("""(spread) => {
      const c = document.querySelector('#player-model-canvas'), r = c.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const ev = (type, id, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 11,
        clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, cancelable: true }));
      ev('pointerdown', 11, cx - 40, cy); ev('pointerdown', 12, cx + 40, cy);
      for (let i = 1; i <= 5; i++) { const s = spread * i / 5; ev('pointermove', 11, cx - 40 - s + i * 4, cy); ev('pointermove', 12, cx + 40 + s + i * 4, cy); }
      ev('pointerup', 11, cx - 40 - spread + 20, cy); ev('pointerup', 12, cx + 40 + spread + 20, cy);
    }""", spread)


def orbit_drag(page, engine, dx):
    b = canvas_box(page)
    x0, y0 = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    if engine == "chromium":
        cdp = page.context.new_cdp_session(page)
        cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x0, "y": y0, "id": 1}]})
        for i in range(1, 7):
            cdp.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x0 + dx * i / 6, "y": y0, "id": 1}]})
        cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        cdp.detach()
    else:
        page.mouse.move(x0, y0); page.mouse.down()
        page.mouse.move(x0 + dx, y0, steps=6); page.mouse.up()
    page.wait_for_timeout(100)


def check_model_view(page, engine, label):
    s0, v0 = snap(page), view(page)
    assert s0["nonBackground"] > 0.02 * s0["width"] * s0["height"], (label, "blank render", s0)
    # Fit: the model sits inside the canvas with a margin (sphere fit at 0.8).
    x0, y0, x1, y1 = s0["bbox"]
    assert x0 > 0 and y0 > 0 and x1 < s0["width"] - 1 and y1 < s0["height"] - 1, (label, "fit", s0)
    assert abs(v0["zoom"] - 1) < 1e-9 and v0["panX"] == 0 and v0["panY"] == 0, v0
    # Orbit: a drag to the right decreases yaw by dx*0.012 (the Dessiner sign: the front follows the finger).
    orbit_drag(page, engine, 60)
    v1, s1 = view(page), snap(page)
    assert abs((v0["yaw"] - v1["yaw"]) - 60 * 0.012) < 0.05, (label, "orbit", v0, v1)
    assert s1["bbox"] != s0["bbox"] or s1["nonBackground"] != s0["nonBackground"], (label, "orbit did not redraw")
    # Pinch out: zoom grows, pan follows the fingers' drift; the model gets bigger on screen.
    synthetic_pinch(page, 60)
    v2, s2 = view(page), snap(page)
    assert v2["zoom"] > 1.5 and v2["panX"] > 0, (label, "pinch", v2)
    assert abs(v2["yaw"] - v1["yaw"]) < 1e-9, (label, "pinch must not orbit", v1, v2)
    assert s2["nonBackground"] > s1["nonBackground"], (label, "zoom", s1, s2)
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/model-{label}-zoomed.png")
    # Recadrer: zoom 1, no pan, same orientation, model back inside the frame.
    page.click('#btn-player-fit')
    page.wait_for_timeout(100)
    v3, s3 = view(page), snap(page)
    assert (v3["zoom"], v3["panX"], v3["panY"]) == (1, 0, 0) and abs(v3["yaw"] - v1["yaw"]) < 1e-9, (label, "recadrer", v3)
    assert s3["bbox"] == s1["bbox"], (label, "recadrer bbox", s1, s3)
    return v3


def touch_flow(browser, device, url, engine, label):
    ctx = browser.new_context(**device)
    page = ctx.new_page()
    errors, console_errors = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    external = []
    page.on("request", lambda r: external.append(r.url) if not r.url.startswith(url) and not r.url.startswith("data:") and not r.url.startswith("blob:") else None)
    login(page, url)
    open_folder(page)
    assert "🧊" in page.locator(f'#file-list li.file[data-rel="{FOLDER}/support.stl"] a.fname').inner_text()
    # Binary STL
    double_tap_row(page, "support.stl")
    wait_model(page, 24)
    assert "STL binaire · 24 triangles" in page.locator('#player-model-info').inner_text()
    assert page.evaluate("document.querySelector('#player-msg').hidden")
    gl = view(page)["webgl"]
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/model-{label}-stl.png")
    check_model_view(page, engine, label + "-stl")
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/model-{label}-stl-orbit.png")
    # GLB with hierarchy and colours: both materials visible.
    double_tap_row(page, "assemblage.glb")
    wait_model(page, 24)
    assert "GLB · 24 triangles" in page.locator('#player-model-info').inner_text()
    colors = page.evaluate("""() => { const c = document.querySelector('#player-model-canvas'); c.hqModelSnapshot();
      const t = document.createElement('canvas'); t.width = c.width; t.height = c.height; const x = t.getContext('2d'); x.drawImage(c, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data; let red = 0, blue = 0;
      for (let i = 0; i < d.length; i += 4) { if (d[i] > d[i + 2] + 40 && d[i] > d[i + 1] + 30) red++; if (d[i + 2] > d[i] + 40) blue++; }
      return { red, blue }; }""")
    assert colors["red"] > 500 and colors["blue"] > 500, (label, "materials", colors)
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/model-{label}-glb.png")
    check_model_view(page, engine, label + "-glb")
    # ASCII STL from the Lecteur list (tap on the library entry).
    page.locator(f'#player-list [data-play="{FOLDER}/pyramide ascii.stl"]').click()
    wait_model(page, 6)
    assert "STL ASCII · 6 triangles" in page.locator('#player-model-info').inner_text()
    assert snap(page)["nonBackground"] > 0
    # Unsupported required extension: French message, no model, no hang.
    double_tap_row(page, "compresse.glb")
    page.wait_for_function("() => !document.querySelector('#player-msg').hidden", timeout=10000)
    msg = page.locator('#player-msg').inner_text()
    assert "extensions non prises en charge : KHR_draco_mesh_compression" in msg, msg
    # The message is on screen, not left below the fold after a double tap from far down the list.
    mb = page.locator('#player-msg').bounding_box()
    assert 0 <= mb["y"] and mb["y"] + mb["height"] <= page.viewport_size["height"], ("message off-screen", mb)
    assert page.evaluate("document.querySelector('#player-model').hidden")
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/model-{label}-unsupported.png")
    # Truncated STL: French error.
    double_tap_row(page, "abime.stl")
    page.wait_for_function("() => !document.querySelector('#player-msg').hidden", timeout=10000)
    msg = page.locator('#player-msg').inner_text()
    assert "STL" in msg and ("tronqué" in msg or "illisible" in msg), msg
    # Switching back to audio-less state: the model view hides when another model fails; reopen works.
    double_tap_row(page, "support.stl")
    wait_model(page, 24)
    assert page.evaluate("document.querySelector('#player-msg').hidden")
    assert not errors, errors
    assert not external, external
    assert not [e for e in console_errors if "hq-model" in e or "WebGL" in e], console_errors
    ctx.close()
    return gl


def run():
    source = Path(__file__).resolve().parents[1]
    old_root, old_sessions = iphone_bridge.ROOT, iphone_bridge.SESSIONS_PATH
    old_config = json.loads(json.dumps(iphone_bridge.CONFIG))
    notes = []
    with tempfile.TemporaryDirectory(prefix="hq-model-browser-") as td:
        root = Path(td)
        shutil.copytree(source / "assets", root / "assets")
        make_fixtures(root)
        iphone_bridge.ROOT = root
        iphone_bridge.SESSIONS_PATH = root / "bridge_sessions.json"
        iphone_bridge.CONFIG.update({"pin": FAKE_PIN, "users": [{"name": "admin", "pin": FAKE_PIN, "role": "admin"}],
                                     "discord_webhook_url": "", "push_enabled": False})
        iphone_bridge.bind_cc_ext(); iphone_bridge.bind_hq()

        class QuietHandler(iphone_bridge.Handler):
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch()
                gl = touch_flow(browser, p.devices["iPhone 13"], url, "chromium", "chromium-iphone")
                notes.append("Chromium iPhone 13: " + ("WebGL" if gl else "canvas 2D fallback"))
                browser.close()
                webkit = p.webkit.launch()
                gl = touch_flow(webkit, p.devices["iPhone 13"], url, "webkit", "webkit-iphone")
                notes.append("WebKit iPhone 13: " + ("WebGL" if gl else "canvas 2D fallback"))
                webkit.close()
        finally:
            server.shutdown(); server.server_close()
            iphone_bridge.ROOT, iphone_bridge.SESSIONS_PATH = old_root, old_sessions
            iphone_bridge.CONFIG.clear(); iphone_bridge.CONFIG.update(old_config)
    print("Lecteur 3D browser flow passed: double tap opens STL/GLB, non-blank render, GLB materials, orbit sign, pinch zoom + pan, "
          "Recadrer, ASCII STL from the list, Draco notice, truncated STL error, no external requests. " + "; ".join(notes))


if __name__ == "__main__":
    run()
