"""Forge Studio browser flow. Mock Forge only. No GPU and no port 7860.

FORGE_SHOTS=dir python tests/visual_forge_studio_playwright.py
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = Path(os.environ["FORGE_SHOTS"]) if os.environ.get("FORGE_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)


def contrast(a: str, b: str) -> float:
    def lum(color: str) -> float:
        nums = [float(part) for part in color.replace("rgba", "").replace("rgb", "").replace("(", "").replace(")", "").split(",")[:3]]
        channels = []
        for value in nums:
            channel = value / 255
            channels.append(channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4)
        red, green, blue = channels
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue

    left, right = lum(a), lum(b)
    return (max(left, right) + 0.05) / (min(left, right) + 0.05)


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-forge-ui-"))
    env = os.environ.copy()
    env["HQ_FORGE_MOCK"] = "ready"
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    passed = 0
    try:
        info = json.loads(proc.stdout.readline().decode("utf-8"))
        base = info["base"]
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            requests = []
            errors = []
            failed = []

            def track(page):
                page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
                page.on("pageerror", lambda exc: errors.append(str(exc)))
                page.on("request", lambda request: requests.append(request.url))
                page.on("response", lambda response: failed.append(str(response.status) + " " + response.url) if response.status >= 400 else None)

            def check(cond: bool, message: str) -> None:
                nonlocal passed
                if not cond:
                    raise SystemExit("FAIL: " + message)
                passed += 1
                print("  OK  ", message)

            admin = browser.new_context()
            login = admin.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0)
            if login.status != 303:
                raise SystemExit("login failed")
            page = admin.new_page()
            page.set_viewport_size({"width": 1280, "height": 900})
            page.emulate_media(color_scheme="dark", reduced_motion="reduce")
            track(page)
            page.goto(base + "/")
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => /en ligne/i.test(document.querySelector('#forge-status').textContent || '')")
            check("Générer" in page.locator("#forge-studio h1").inner_text(), "forge heading")
            check("autre travail" in page.locator("#forge-cancel-note").inner_text(), "cancel limitation is visible")
            colors = page.eval_on_selector("#forge-status", "node => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor]")
            check(contrast(colors[0], colors[1]) >= 4.5, "status contrast")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "forge-desktop-dark.png"), full_page=True)
            page.locator("#forge-prompt").fill("un cercle rouge")
            page.locator("#forge-prompt").press("Tab")
            check(page.evaluate("() => document.activeElement.id") == "forge-negative", "tab leaves the prompt")
            page.locator("#forge-generate").click()
            page.locator("#forge-results img").wait_for(timeout=10000)
            check(page.locator("#forge-results img").count() >= 1, "result preview")
            page.locator("#forge-results .forge-card").click()
            page.locator("#forge-viewer").wait_for(state="visible")
            page.keyboard.press("Escape")
            page.wait_for_function("() => !document.querySelector('#forge-viewer').open")
            check(bool(page.evaluate("() => document.activeElement.closest('#forge-results')")), "escape restores focus")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "forge-result-desktop.png"), full_page=True)
                page.evaluate("() => document.body.classList.add('theme-oled')")
                page.screenshot(path=str(SHOTS / "forge-oled.png"), full_page=True)
                page.evaluate("() => { document.body.classList.remove('theme-oled'); document.body.classList.add('theme-midnight'); }")
                page.screenshot(path=str(SHOTS / "forge-midnight.png"), full_page=True)
                page.emulate_media(color_scheme="light", reduced_motion="reduce")
                page.screenshot(path=str(SHOTS / "forge-light.png"), full_page=True)

            phone = admin.new_page()
            phone.set_viewport_size({"width": 390, "height": 844})
            track(phone)
            phone.goto(base + "/")
            phone.locator('.bottom-nav [data-nav="forge"]').click()
            phone.locator("#forge-generate").wait_for()
            boxes = phone.evaluate("""() => {
              const button = document.querySelector('#forge-generate').getBoundingClientRect();
              const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
              return { button: button.bottom, nav: nav.top, width: button.width, height: button.height };
            }""")
            check(boxes["button"] <= boxes["nav"] + 1, "generate sits above the nav")
            check(boxes["width"] >= 44 and boxes["height"] >= 44, "generate meets the touch size")
            if SHOTS:
                phone.screenshot(path=str(SHOTS / "forge-phone.png"), full_page=True)

            upload = browser.new_context()
            upload.request.post(base + "/login", form={"pin": info["upload_pin"]}, headers={"origin": base}, max_redirects=0)
            check(upload.request.get(base + "/api/forge/status").status == 403, "upload role is rejected")
            anon = browser.new_context()
            check(anon.request.get(base + "/api/forge/status").status == 401, "anonymous is rejected")
            check(all(url.startswith(base) or url.startswith("data:") for url in requests), "browser stays on HQ")
            check(not any(":7860" in url for url in requests), "browser does not call Forge")
            print("FAILED_URLS", " | ".join(failed))
            check(not [item for item in errors if "pageerror" in item or "TypeError" in item or "ReferenceError" in item], "no page errors: " + " | ".join(errors))
            check(not [item for item in failed if "/api/forge/" in item or "/assets/hq-forge" in item], "no forge 404s: " + " | ".join(failed))
            browser.close()
        print("PASSED", passed)
    finally:
        proc.kill()
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    main()
