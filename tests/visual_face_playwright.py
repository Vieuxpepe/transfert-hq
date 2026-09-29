"""Browser QA for planar-face sketching against a throwaway loopback HQ.

Run with Playwright and manifold3d on PYTHONPATH. Never uses the live root.
"""
import json
import os
import shutil
import tempfile
import threading
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import iphone_bridge
from playwright.sync_api import sync_playwright


FAKE_PIN = "246810"

# Face-sketch view as the page sees it (canvas device px) and the drawn face fill found by scanning pixels.
FACE_INFO = """() => {const c=document.querySelector('.sk-face-canvas'), v=c.hqFaceView(), r=c.getBoundingClientRect();
  const all=window.hqSketchState().faceSelection.triangles.flat(), xs=all.map(p=>p[0]), ys=all.map(p=>p[1]);
  const lo=[Math.min(...xs),Math.min(...ys)], hi=[Math.max(...xs),Math.max(...ys)];
  const sx=x=>v.width/2+(x-v.x)*v.scale, sy=y=>v.height/2-(y-v.y)*v.scale;
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data; let px=[1e9,1e9,-1,-1], n=0;
  for (let y=0;y<c.height;y++) for (let x=0;x<c.width;x++) {const i=(y*c.width+x)*4;
    if (Math.abs(d[i]-216)<6&&Math.abs(d[i+1]-238)<6&&Math.abs(d[i+2]-230)<6) {n++; px=[Math.min(px[0],x),Math.min(px[1],y),Math.max(px[2],x),Math.max(px[3],y)];}}
  return {v, rect:[r.left,r.top,r.width,r.height], lo, hi, bbox:[sx(lo[0]),sy(hi[1]),sx(hi[0]),sy(lo[1])], fill:n, px};}"""


def face_client(info, p, view=None):
    """Face UV point -> client CSS px using a given (or the current) face-sketch view."""
    v = view or info['v']; left, top, width, height = info['rect']
    return (left + (v['width'] / 2 + (p[0] - v['x']) * v['scale']) * width / v['width'],
            top + (v['height'] / 2 - (p[1] - v['y']) * v['scale']) * height / v['height'])


def assert_face_framed(page, label):
    """The whole face is inside the face-sketch canvas, centred, with a margin (view math and real pixels)."""
    page.wait_for_function("() => { const c=document.querySelector('.sk-face-canvas'); return c && c.hqFaceView && c.hqFaceView(); }")
    info = page.evaluate(FACE_INFO); v = info['v']; x0, y0, x1, y1 = info['bbox']
    margin = min(25, v['width'] / 4, v['height'] / 4) - 1
    assert x0 >= margin and y0 >= margin and x1 <= v['width'] - margin and y1 <= v['height'] - margin, (label, info['bbox'], v)
    assert abs((x0 + x1) / 2 - v['width'] / 2) < 1 and abs((y0 + y1) / 2 - v['height'] / 2) < 1, (label, 'not centred', info['bbox'], v)
    px = info['px']
    assert info['fill'] > 0 and px[0] > 2 and px[1] > 2 and px[2] < v['width'] - 3 and px[3] < v['height'] - 3, (label, 'face pixels cut off', px, v)
    return info


def assert_moved(info0, info1, p, delta, label):
    a, b = face_client(info0, p), face_client(info1, p)
    assert abs(b[0] - a[0] - delta[0]) < 1.5 and abs(b[1] - a[1] - delta[1]) < 1.5, (label, a, b, delta)


def desktop_face_navigation(page):
    """Right-drag pan, draw a rectangle after panning, wheel zoom around the cursor, Recadrer. Returns the expected profile corners."""
    fit = assert_face_framed(page, 'desktop side face')
    centre = [(fit['lo'][i] + fit['hi'][i]) / 2 for i in (0, 1)]
    half = [(fit['hi'][i] - fit['lo'][i]) * f for i, f in ((0, .12), (1, .18))]
    c = face_client(fit, centre); pan = (46, 18)
    page.mouse.move(*c); page.mouse.down(button='right'); page.mouse.move(c[0] + pan[0], c[1] + pan[1], steps=6); page.mouse.up(button='right')
    panned = page.evaluate(FACE_INFO)
    assert_moved(fit, panned, centre, pan, 'right-drag pan')
    # Where the rectangle corners are after the pan, predicted from the pre-pan fit and the drag only.
    lo, hi = [centre[0] - half[0], centre[1] - half[1]], [centre[0] + half[0], centre[1] + half[1]]
    a, b = face_client(fit, lo), face_client(fit, hi)
    a, b = (a[0] + pan[0], a[1] + pan[1]), (b[0] + pan[0], b[1] + pan[1])
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=8); page.mouse.up()
    q = (c[0] + pan[0] + 30, c[1] + pan[1] - 10); under = face_client(panned, centre)
    page.mouse.move(*q); page.mouse.wheel(0, -300); page.wait_for_timeout(100)
    zoomed = page.evaluate(FACE_INFO)
    assert zoomed['v']['scale'] > panned['v']['scale'] * 1.2, ('wheel zoom in', panned['v'], zoomed['v'])
    # The face point under the cursor stays under the cursor.
    qv = panned['v']; l, t, w, h = panned['rect']
    qface = [qv['x'] + ((q[0] - l) * qv['width'] / w - qv['width'] / 2) / qv['scale'], qv['y'] - ((q[1] - t) * qv['height'] / h - qv['height'] / 2) / qv['scale']]
    qafter = face_client(zoomed, qface)
    assert abs(qafter[0] - q[0]) < 1.5 and abs(qafter[1] - q[1]) < 1.5, ('zoom anchor', q, qafter, under)
    page.click('[data-face="fit"]')
    refit = assert_face_framed(page, 'Recadrer')
    assert all(abs(refit['v'][k] - fit['v'][k]) < 1e-6 for k in ('x', 'y', 'scale')), (refit['v'], fit['v'])
    return lo, hi, 1.5 / fit['v']['scale'] * fit['v']['width'] / fit['rect'][2]


def touch_face_navigation(page, cdp):
    """Two-finger pan and pinch zoom (CDP touch), then Recadrer restores the fitted view."""
    fit = assert_face_framed(page, 'mobile top face')
    centre = [(fit['lo'][i] + fit['hi'][i]) / 2 for i in (0, 1)]
    c = face_client(fit, centre)
    send = lambda kind, pts: cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': pts})
    f1, f2, pan = (c[0] - 40, c[1]), (c[0] + 40, c[1]), (-35, 28)
    send('touchStart', [{'x': f1[0], 'y': f1[1], 'id': 1}, {'x': f2[0], 'y': f2[1], 'id': 2}])
    for i in range(1, 7):
        send('touchMove', [{'x': f1[0] + pan[0] * i / 6, 'y': f1[1] + pan[1] * i / 6, 'id': 1}, {'x': f2[0] + pan[0] * i / 6, 'y': f2[1] + pan[1] * i / 6, 'id': 2}])
    send('touchEnd', [])
    panned = page.evaluate(FACE_INFO)
    assert_moved(fit, panned, centre, pan, 'two-finger pan')
    assert abs(panned['v']['scale'] - fit['v']['scale']) < 1e-6 * fit['v']['scale'], 'parallel two-finger drag must not zoom'
    m = face_client(panned, centre)
    send('touchStart', [{'x': m[0] - 30, 'y': m[1], 'id': 1}, {'x': m[0] + 30, 'y': m[1], 'id': 2}])
    for i in range(1, 7):
        send('touchMove', [{'x': m[0] - 30 - 10 * i, 'y': m[1], 'id': 1}, {'x': m[0] + 30 + 10 * i, 'y': m[1], 'id': 2}])
    send('touchEnd', [])
    pinched = page.evaluate(FACE_INFO)
    assert pinched['v']['scale'] > panned['v']['scale'] * 1.8, ('pinch zoom', panned['v'], pinched['v'])
    after = face_client(pinched, centre)
    assert abs(after[0] - m[0]) < 2 and abs(after[1] - m[1]) < 2, ('pinch keeps the point between the fingers', m, after)
    page.click('[data-face="fit"]')
    refit = assert_face_framed(page, 'mobile Recadrer')
    assert all(abs(refit['v'][k] - fit['v'][k]) < 1e-6 for k in ('x', 'y', 'scale')), (refit['v'], fit['v'])


def select_face(page, want, grid=(0.25, 0.4, 0.55, 0.7), tap=False):
    page.locator('.sk-3d-canvas').scroll_into_view_if_needed()
    stage = page.locator('.sk-3d-canvas').bounding_box(); seen = []
    for fy in grid:
        for fx in grid:
            x, y = stage['x'] + stage['width'] * fx, stage['y'] + stage['height'] * fy
            (page.touchscreen.tap if tap else page.mouse.click)(x, y)
            normal = page.evaluate('window.hqSketchState().faceSelection?.plane.normal')
            seen.append(normal and [round(v, 2) for v in normal])
            if normal and want(normal):
                return True
    print('select_face: no match; normals seen', seen, 'stage', stage)
    return False


def run():
    source = Path(__file__).resolve().parents[1]
    old_root = iphone_bridge.ROOT
    old_config = json.loads(json.dumps(iphone_bridge.CONFIG))
    with tempfile.TemporaryDirectory(prefix="hq-face-browser-") as td:
        root = Path(td)
        (root / "Inbox").mkdir()
        shutil.copytree(source / "assets", root / "assets")
        iphone_bridge.ROOT = root
        iphone_bridge.CONFIG["pin"] = FAKE_PIN
        iphone_bridge.CONFIG["users"] = [{"name": "admin", "pin": FAKE_PIN, "role": "admin"}]
        iphone_bridge.CONFIG["discord_webhook_url"] = ""
        iphone_bridge.CONFIG["push_enabled"] = False
        class QuietHandler(iphone_bridge.Handler):
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_address[1]}"
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(channel="chrome")
                page = browser.new_page(viewport={"width": 1440, "height": 900})
                errors = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(url)
                page.fill('input[name="pin"]', FAKE_PIN)
                page.click('button[type="submit"]')
                page.click('.bottom-nav [data-nav="dessiner"]')
                page.click('.sk-seg [data-mode="construction"]')
                page.click('[data-tool="rect"]')
                box = page.locator('.sk-canvas').bounding_box()
                a = (box['x'] + box['width'] * .22, box['y'] + box['height'] * .28)
                b = (box['x'] + box['width'] * .75, box['y'] + box['height'] * .72)
                page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=10); page.mouse.up()
                page.click('[data-tool="select"]')
                page.mouse.click((a[0] + b[0]) / 2, a[1])
                page.fill('[data-solid="base-depth"]', '20')
                page.click('[data-act="solid-extrude"]')
                page.wait_for_function('() => window.hqSketchState().mesh.length > 0')
                stage = page.locator('.sk-3d-canvas').bounding_box()
                found = False
                for fy in (0.25, 0.4, 0.55, 0.7):
                    for fx in (0.25, 0.4, 0.55, 0.7):
                        page.mouse.click(stage['x'] + stage['width'] * fx, stage['y'] + stage['height'] * fy)
                        normal = page.evaluate('window.hqSketchState().faceSelection?.plane.normal')
                        if normal and abs(normal[0]) > .9:
                            found = True; break
                    if found: break
                assert found, 'No side face could be selected'
                page.click('[data-act="faceSketch"]')
                face = page.locator('.sk-face-canvas')
                assert face.is_visible()
                lo, hi, tol = desktop_face_navigation(page)
                page.fill('[data-face-depth]', '5')
                page.click('[data-face="extrude"]')
                try:
                    page.wait_for_function('() => window.hqSketchState().doc.faceFeatures?.length === 1', timeout=5000)
                except Exception:
                    raise AssertionError('Face sketch failed: ' + page.locator('.sk-face-message').inner_text())
                # The rectangle drawn after panning landed where the pointer was, in face coordinates.
                profile = page.evaluate('window.hqSketchState().doc.faceFeatures[0].profile')
                for got, want in ((profile[0], lo), (profile[2], hi)):
                    assert all(abs(got[i] - want[i]) < tol for i in (0, 1)), ('rectangle after pan', profile, lo, hi, tol)
                # Regression: a second face (other UV frame, same canvas size) must be re-framed, not shown with the old view.
                assert select_face(page, lambda n: n[2] > .9), 'No top face could be selected'
                page.click('[data-act="faceSketch"]')
                assert_face_framed(page, 'desktop second face (top)')
                page.click('[data-face="cancel"]')
                page.click('[data-act="roundMode"]')
                edge_points = page.evaluate('''() => {
                  const s=window.hqSketchState(), c=document.querySelector('.sk-3d-canvas'), r=c.getBoundingClientRect();
                  const all=s.mesh.flat(), lo=[0,1,2].map(i=>Math.min(...all.map(p=>p[i])));
                  const hi=[0,1,2].map(i=>Math.max(...all.map(p=>p[i])));
                  const center=lo.map((v,i)=>(v+hi[i])/2), span=Math.max(...lo.map((v,i)=>hi[i]-v),1e-6);
                  const cy=Math.cos(-.72), sy=Math.sin(-.72), cp=Math.cos(.62), sp=Math.sin(.62);
                  const scale=1.42/span, aspect=c.width/c.height;
                  function xy(p) {let x=p[0]-center[0],y=p[1]-center[1],z=p[2]-center[2];
                    let rx=cy*x-sy*y,ry=sy*x+cy*y;
                    return [r.left+(rx*scale/Math.max(1,aspect)+1)*r.width/2,
                            r.top+(1-(cp*z-sp*ry)*scale)*r.height/2];}
                  return s.edges.map(e=>xy(e.a.map((v,i)=>(v+e.b[i])/2)));
                }''')
                found = False
                for x, y in edge_points:
                    if not (stage['x'] < x < stage['x'] + stage['width'] and stage['y'] < y < stage['y'] + stage['height']):
                        continue
                    page.mouse.click(x, y)
                    if page.evaluate('!!window.hqSketchState().edgeSelection'):
                        found = True; break
                assert found, 'No visible convex edge could be selected'
                page.fill('[data-solid="round-radius"]', '1')
                page.click('[data-act="roundApply"]')
                page.wait_for_function('() => window.hqSketchState().doc.roundFeatures?.length === 1')
                page.click('[data-act="roundMode"]')
                assert not errors, errors
                if os.environ.get('HQ_FACE_SCREENSHOTS'):
                    page.screenshot(path=os.environ['HQ_FACE_SCREENSHOTS'] + '-desktop.png', full_page=True)
                page.click('[data-act="save"]')
                page.fill('#sk-save-name', 'face-browser-check')
                page.click('#sk-save-go')
                page.wait_for_function('() => window.hqSketchState().stem.includes("face-browser-check")')
                stem = page.evaluate('window.hqSketchState().stem')
                assert (root / 'Inbox' / 'Drawings' / (stem + '.stl')).is_file()
                page.click('[data-act="open"]')
                page.click(f'[data-open="{stem}"]')
                page.wait_for_function('() => window.hqSketchState().doc.faceFeatures?.length === 1')
                assert page.evaluate('window.hqSketchState().doc.roundFeatures?.length') == 1
                page.click('[data-act="removeRound3d"]')
                page.wait_for_function('() => window.hqSketchState().doc.roundFeatures?.length === 0')
                page.click('[data-act="removeFace3d"]')
                page.wait_for_function('() => window.hqSketchState().doc.faceFeatures?.length === 0')
                page.click('[data-act="undo"]')
                page.wait_for_function('() => window.hqSketchState().doc.faceFeatures?.length === 1')
                phone = browser.new_context(**p.devices['iPhone 13'])
                touch = phone.new_page()
                touch.goto(url)
                touch.fill('input[name="pin"]', FAKE_PIN)
                touch.click('button[type="submit"]')
                touch.click('.bottom-nav [data-nav="dessiner"]')
                touch.click('[data-act="open"]')
                touch.click(f'[data-open="{stem}"]')
                touch.click('[data-act="view3d"]')
                touch.wait_for_function('() => window.hqSketchState().mesh.length > 0')
                stage = touch.locator('.sk-3d-canvas').bounding_box()
                found = False
                for fy in (0.3, 0.45, 0.6, 0.75):
                    for fx in (0.3, 0.45, 0.6, 0.75):
                        touch.touchscreen.tap(stage['x'] + stage['width'] * fx, stage['y'] + stage['height'] * fy)
                        normal = touch.evaluate('window.hqSketchState().faceSelection?.plane.normal')
                        if normal and normal[2] > .9:
                            found = True; break
                    if found: break
                assert found, 'No top face could be selected on touch screen'
                if os.environ.get('HQ_FACE_SCREENSHOTS'):
                    touch.screenshot(path=os.environ['HQ_FACE_SCREENSHOTS'] + '-mobile-select.png', full_page=True)
                touch.click('[data-act="faceSketch"]')
                if os.environ.get('HQ_FACE_SCREENSHOTS'):
                    touch.screenshot(path=os.environ['HQ_FACE_SCREENSHOTS'] + '-mobile-editor.png')
                touch_face_navigation(touch, phone.new_cdp_session(touch))
                touch.click('[data-face-tool="polygon"]')
                points = touch.evaluate('''() => {
                  const f=window.hqSketchState().faceSelection, c=document.querySelector('.sk-face-canvas'), r=c.getBoundingClientRect();
                  const all=f.triangles.flat(), xs=all.map(p=>p[0]), ys=all.map(p=>p[1]);
                  const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
                  const s=Math.min((c.width-50)/Math.max(x1-x0,1),(c.height-50)/Math.max(y1-y0,1));
                  const tri=f.triangles[0], center=[0,1].map(i=>tri.reduce((a,p)=>a+p[i],0)/3);
                  return tri.map(p=>{const q=[0,1].map(i=>.8*center[i]+.2*p[i]);
                    return [r.left+(c.width/2+(q[0]-(x0+x1)/2)*s)*r.width/c.width,
                            r.top+(c.height/2-(q[1]-(y0+y1)/2)*s)*r.height/c.height];});
                }''')
                for x, y in points:
                    touch.touchscreen.tap(x, y)
                touch.click('[data-face="close"]')
                touch.fill('[data-face-depth]', '2')
                touch.click('[data-face="extrude"]')
                try:
                    touch.wait_for_function('() => window.hqSketchState().doc.faceFeatures?.length === 2', timeout=5000)
                except Exception:
                    raise AssertionError('Mobile face sketch failed: ' + touch.locator('.sk-face-message').inner_text())
                # Regression on touch: re-opening on another face re-frames it.
                assert select_face(touch, lambda n: abs(n[2]) < .1, grid=(0.15, 0.3, 0.45, 0.6, 0.72, 0.82, 0.9), tap=True), 'No side face on touch screen'
                touch.click('[data-act="faceSketch"]')
                assert_face_framed(touch, 'mobile second face (side)')
                touch.click('[data-face="cancel"]')
                if os.environ.get('HQ_FACE_SCREENSHOTS'):
                    touch.screenshot(path=os.environ['HQ_FACE_SCREENSHOTS'] + '-mobile.png', full_page=True)
                phone.close()
                browser.close()
        finally:
            server.shutdown(); server.server_close()
            iphone_bridge.ROOT = old_root
            iphone_bridge.CONFIG.clear(); iphone_bridge.CONFIG.update(old_config)
    print('Face sketch and edge round browser flow passed: side selection, framing on re-open, pan/zoom/Recadrer, extrusion, fillet, STL save, reopen')


if __name__ == '__main__':
    run()
