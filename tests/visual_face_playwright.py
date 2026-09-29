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
                r = face.bounding_box()
                start = (r['x'] + r['width'] * .42, r['y'] + r['height'] * .42)
                end = (r['x'] + r['width'] * .56, r['y'] + r['height'] * .57)
                page.mouse.move(*start); page.mouse.down(); page.mouse.move(*end, steps=8); page.mouse.up()
                page.fill('[data-face-depth]', '5')
                page.click('[data-face="extrude"]')
                try:
                    page.wait_for_function('() => window.hqSketchState().doc.faceFeatures?.length === 1', timeout=5000)
                except Exception:
                    raise AssertionError('Face sketch failed: ' + page.locator('.sk-face-message').inner_text())
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
                if os.environ.get('HQ_FACE_SCREENSHOTS'):
                    touch.screenshot(path=os.environ['HQ_FACE_SCREENSHOTS'] + '-mobile.png', full_page=True)
                phone.close()
                browser.close()
        finally:
            server.shutdown(); server.server_close()
            iphone_bridge.ROOT = old_root
            iphone_bridge.CONFIG.clear(); iphone_bridge.CONFIG.update(old_config)
    print('Face sketch and edge round browser flow passed: side selection, extrusion, fillet, STL save, reopen')


if __name__ == '__main__':
    run()
