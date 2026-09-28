"""Optional end-to-end 3D QA against a throwaway HQ with a fake PIN.

Set HQ_BASE, HQ_ROOT, HQ_TEST_PIN, HQ_SCREENS and optionally HQ_BROWSER_CHANNEL.
Never point this test at the live controller.
"""
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("HQ_BASE", "http://127.0.0.1:9877")
ROOT = Path(os.environ.get("HQ_ROOT", "/tmp/hq-visual-root"))
PIN = os.environ.get("HQ_TEST_PIN", "246810")
OUT = Path(os.environ.get("HQ_SCREENS", "/tmp/dessiner-screens"))
OUT.mkdir(parents=True, exist_ok=True)


def sketch_point(page, x, y):
    return page.evaluate("""([x,y]) => {const s=window.hqSketchState(),p=HQSketch.toScreen(s.view,s.H,x,y),r=document.querySelector('.sk-canvas').getBoundingClientRect();return [r.left+p.x,r.top+p.y]}""", [x, y])


def drag(page, a, b):
    page.mouse.move(*a); page.mouse.down(); page.mouse.move(*b, steps=12); page.mouse.up()


def run():
    errors = []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=os.environ.get("HQ_BROWSER_CHANNEL") or None)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(BASE + "/")
        page.fill('input[name="pin"]', PIN); page.click('button[type="submit"]')
        page.click('.bottom-nav [data-nav="dessiner"]')
        page.wait_for_selector(".sk-canvas")
        page.click('.sk-seg [data-mode="construction"]')
        page.locator(".sk-canvas").scroll_into_view_if_needed()
        box = page.locator(".sk-canvas").bounding_box()
        a = (box["x"] + box["width"] * .2, box["y"] + box["height"] * .25)
        b = (box["x"] + box["width"] * .78, box["y"] + box["height"] * .73)
        page.click('[data-tool="rect"]'); drag(page, a, b)
        doc = page.evaluate("window.hqSketchState().doc")
        rect = [o for o in doc["objects"] if o["type"] == "line"]
        assert len(rect) == 4, rect
        pts = {v["id"]: v for v in doc["points"]}
        p1, p2 = pts[rect[0]["p1"]], pts[rect[0]["p2"]]
        page.click('[data-tool="select"]')
        page.locator(".sk-canvas").scroll_into_view_if_needed()
        page.mouse.click(*sketch_point(page, (p1["x"] + p2["x"]) / 2, (p1["y"] + p2["y"]) / 2))
        assert page.evaluate("window.hqSketchState().sel.length") == 1
        page.fill('[data-solid="base-depth"]', "20")
        page.click('[data-act="solid-extrude"]')
        page.wait_for_function("() => window.hqSketchState().doc.features.length === 1 && window.hqSketchState().mesh.length > 0")
        assert page.locator('.sk-3d-canvas').is_visible()
        page.screenshot(path=str(OUT / "3d-base-desktop.png"))
        page.click('[data-act="view2d"]')
        doc = page.evaluate("window.hqSketchState().doc")
        xs = [v["x"] for v in doc["points"]]; ys = [v["y"] for v in doc["points"]]
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        radius = min(max(xs) - min(xs), max(ys) - min(ys)) / 6
        page.click('[data-tool="circle"]')
        drag(page, sketch_point(page, cx, cy), sketch_point(page, cx + radius, cy))
        assert page.evaluate("window.hqSketchState().doc.objects.filter(o=>o.type==='circle').length") == 1
        page.click('[data-tool="select"]')
        page.mouse.click(*sketch_point(page, cx + radius, cy))
        assert page.evaluate("window.hqSketchState().sel.length") == 1
        page.check('[data-solid="through"]')
        page.click('[data-act="solid-cut"]')
        page.wait_for_function("() => window.hqSketchState().doc.features.length === 2 && window.hqSketchState().meshLoadedVersion === window.hqSketchState().meshVersion")
        page.screenshot(path=str(OUT / "3d-through-cut-desktop.png"))
        page.click('[data-act="view2d"]')
        second_x = min(xs) + .76 * (max(xs) - min(xs))
        page.click('[data-tool="circle"]')
        drag(page, sketch_point(page, second_x, cy), sketch_point(page, second_x + radius * .75, cy))
        page.click('[data-tool="select"]')
        page.mouse.click(*sketch_point(page, second_x + radius * .75, cy))
        page.uncheck('[data-solid="through"]')
        page.fill('[data-solid="cut-depth"]', "5")
        page.click('[data-act="solid-cut"]')
        page.wait_for_function("() => window.hqSketchState().doc.features.length === 3 && window.hqSketchState().meshLoadedVersion === window.hqSketchState().meshVersion")
        page.screenshot(path=str(OUT / "3d-blind-and-through-cut-desktop.png"))
        page.click('[data-act="save"]'); page.fill('#sk-save-name', '3d-visual-check'); page.click('#sk-save-go')
        page.wait_for_function("() => window.hqSketchState().stem.includes('3d-visual-check')")
        stem = page.evaluate("window.hqSketchState().stem")
        assert (ROOT / "Inbox" / "Drawings" / (stem + ".stl")).is_file()
        page.click('[data-act="open"]'); page.wait_for_selector('.sk-item')
        page.click(f'[data-open="{stem}"]')
        page.wait_for_function("() => window.hqSketchState().doc.features.length === 3")
        page.click('[data-act="view3d"]')
        page.wait_for_function("() => window.hqSketchState().meshLoadedVersion === window.hqSketchState().meshVersion")
        assert not errors, errors
        phone = browser.new_context(**p.devices["iPhone 13"])
        touch = phone.new_page()
        touch.on("pageerror", lambda e: errors.append("mobile: " + str(e)))
        touch.goto(BASE + "/")
        touch.fill('input[name="pin"]', PIN); touch.click('button[type="submit"]')
        touch.click('.bottom-nav [data-nav="dessiner"]')
        touch.wait_for_selector(".sk-canvas")
        touch.click('[data-act="open"]'); touch.wait_for_selector('.sk-item')
        touch.click(f'[data-open="{stem}"]')
        touch.wait_for_function("() => window.hqSketchState().doc.features.length === 3")
        touch.click('[data-act="view3d"]')
        touch.wait_for_function("() => window.hqSketchState().meshLoadedVersion === window.hqSketchState().meshVersion")
        assert touch.locator('.sk-3d-canvas').is_visible()
        assert touch.locator('.sk-3d-stage').bounding_box()['height'] >= 380
        touch.screenshot(path=str(OUT / "3d-iphone-emulation.png"), full_page=True)
        assert not errors, errors
        phone.close()
        print("Dessiner 3D visual flow passed: extrusion, through and blind cuts, preview, STL save, reopen")
        browser.close()


if __name__ == "__main__":
    run()
