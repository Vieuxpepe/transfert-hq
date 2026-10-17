"""Forge Studio compact controls. Mock Forge only. No GPU and no port 7860.

FORGE_SHOTS=dir python tests/visual_forge_controls_playwright.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = Path(os.environ["FORGE_SHOTS"]) if os.environ.get("FORGE_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-forge-controls-"))
    vault = Path(tempfile.mkdtemp(prefix="hq-forge-controls-vault-"))
    env = os.environ.copy()
    env["HQ_FORGE_MOCK"] = "ready"
    env["HQ_FORGE_VAULT_DIR"] = str(vault)
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
            admin = browser.new_context(bypass_csp=True, has_touch=True)
            login = admin.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0)
            if login.status != 303:
                raise SystemExit("login failed")
            page = admin.new_page()
            page.set_viewport_size({"width": 1280, "height": 900})
            page.emulate_media(reduced_motion="reduce")

            def check(cond: bool, message: str) -> None:
                nonlocal passed
                if not cond:
                    raise SystemExit("FAIL: " + message)
                passed += 1
                print("  OK  ", message)

            page.goto(base + "/")
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
            check(page.locator("#forge-negative-fold").evaluate("node => node.open") is False, "negative prompt starts closed")
            check(page.locator("#forge-prompt").is_visible() and page.locator("#forge-checkpoint").is_visible(), "prompt and model stay visible")
            check(page.locator(".forge-ratio").count() == 7, "seven aspect shortcuts")
            page.locator('.forge-ratio[data-forge-ratio="16:9"]').click()
            check(page.locator("#forge-width").input_value() == "1024" and page.locator("#forge-height").input_value() == "576", "16:9 sets a valid pair")
            check(page.locator('.forge-ratio[data-forge-ratio="16:9"]').get_attribute("aria-pressed") == "true", "the chosen ratio is marked")
            page.locator("#forge-steps-range").fill("28")
            check(page.locator("#forge-steps").input_value() == "28" and page.locator("#forge-steps-live").inner_text() == "28", "steps slider and number stay together")
            page.locator("#forge-steps").fill("12")
            page.locator("#forge-steps").dispatch_event("input")
            check(page.locator("#forge-steps-range").input_value() == "12", "the steps number updates the slider")
            page.locator("#forge-cfg-fold summary").click()
            page.locator("#forge-cfg-range").fill("8.5")
            check(page.locator("#forge-cfg").input_value() == "8.5", "CFG slider and number stay together")
            page.locator("#forge-negative-fold summary").focus()
            page.keyboard.press("Enter")
            check(page.locator("#forge-negative-fold").evaluate("node => node.open") is True, "enter opens the negative prompt")
            page.keyboard.press("Enter")
            check(page.locator("#forge-negative-fold").evaluate("node => node.open") is False, "enter closes the negative prompt")
            page.locator("#forge-seed-fold summary").click()
            check(page.locator("#forge-seed").is_disabled(), "random seed disables the number")
            page.locator('input[name="forge-seed-mode"][value="fixed"]').check()
            page.locator("#forge-seed").fill("42")
            check(page.locator("#forge-seed").is_enabled(), "fixed seed accepts a number")
            page.locator("#forge-seed-reuse").click()
            page.wait_for_function("() => (document.querySelector('#forge-seed-note').textContent || '').includes('Aucune')")
            check("normale" in page.locator("#forge-seed-note").inner_text(), "reuse explains that no normal seed exists yet")
            page.locator("#forge-hr-fold summary").click()
            check("privée" in page.locator("#forge-hr-private").inner_text(), "hires explains the private restriction")
            page.locator("#forge-hr").check()
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.wait_for_function("() => (document.querySelector('#forge-generate-reason').textContent || '').includes('génération privée')")
            check(page.locator("#forge-generate-private").is_disabled(), "private generation refuses hires")
            page.locator("#forge-hr").uncheck()
            page.locator('input[name="forge-destination"][value="normal"]').check()
            page.locator("#forge-hr").check()
            captured = {}

            def capture(route):
                if route.request.method == "POST" and route.request.url.rstrip("/").endswith("/api/forge/jobs"):
                    captured["body"] = route.request.post_data_json
                    route.fulfill(
                        status=202,
                        content_type="application/json",
                        body=json.dumps({"job": {
                            "job_id": "job-" + "ab" * 12,
                            "state": "completed",
                            "destination": "normal",
                            "progress": 1,
                            "message": "Terminé.",
                            "images": [],
                            "cancel": "unchanged",
                            "seed_used": 42,
                        }}),
                    )
                    return
                route.continue_()

            page.route("**/api/forge/jobs", capture)
            page.locator("#forge-prompt").fill("cercle bleu")
            page.locator("#forge-generate").click()
            for _ in range(30):
                if "body" in captured:
                    break
                page.wait_for_timeout(100)
            body = captured.get("body") or {}
            check(body.get("width") == 1024 and body.get("height") == 576, "generation uses the shortcut size")
            check(body.get("steps") == 12 and body.get("cfg_scale") == 8.5, "generation uses the slider values")
            check(body.get("seed") == 42 and body.get("batch_size") == 1 and body.get("enable_hr") is True, "seed, batch size, and hires are sent as chosen")
            check(body.get("hr_upscaler") == "R-ESRGAN 4x+", "hires uses a catalog upscaler")
            check("sd_vae" not in body and "clip_skip" not in body, "vae and clip skip are not sent")
            page.unroute("**/api/forge/jobs", capture)

            preset = admin.request.post(
                base + "/api/forge/presets",
                data=json.dumps({
                    "action": "create",
                    "name": "Contrôle",
                    "kind": "technical",
                    "prompt": "ne pas garder",
                    "negative_prompt": "flou",
                    "checkpoint": "example.safetensors [abcd]",
                    "sampler_name": "Euler",
                    "scheduler": "automatic",
                    "width": 768,
                    "height": 1152,
                    "steps": 16,
                    "cfg_scale": 6,
                    "seed": -1,
                    "n_iter": 1,
                    "batch_size": 1,
                    "enable_hr": False,
                }),
                headers={"content-type": "application/json", "origin": base},
            )
            check(preset.status == 200, "a preset stores the compact settings")
            page.reload()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => [...document.querySelectorAll('#forge-preset-list option')].some((item) => item.textContent.includes('Contrôle'))")
            page.locator("#forge-preset-list").select_option(label="Contrôle · technique")
            page.locator("#forge-preset-load").click()
            check(page.locator("#forge-width").input_value() == "768" and page.locator("#forge-height").input_value() == "1152", "the preset survives a refresh")
            check(page.locator('.forge-ratio[data-forge-ratio="2:3"]').get_attribute("aria-pressed") == "true", "the loaded size selects its ratio")
            check(page.locator("#forge-hr").is_checked() is False, "an old-style disabled hires preset stays off")

            page.emulate_media(reduced_motion="reduce")
            motion = page.evaluate("() => getComputedStyle(document.querySelector('#forge-negative-fold .forge-fold-body')).animationName")
            check(motion == "none", "reduced motion removes the section animation")

            page.set_viewport_size({"width": 390, "height": 844})
            page.locator('.forge-ratio[data-forge-ratio="1:1"]').tap()
            check(page.locator('.forge-ratio[data-forge-ratio="1:1"]').get_attribute("aria-pressed") == "true", "a tap selects a ratio")
            page.locator("#forge-sampling summary").tap()
            check(page.locator("#forge-sampler").is_visible(), "a tap opens the sampler")
            if SHOTS:
                for width, height, name in ((1440, 900, "controls-after-1440.png"), (834, 1112, "controls-after-834.png"), (390, 844, "controls-after-390.png")):
                    page.set_viewport_size({"width": width, "height": height})
                    page.screenshot(path=str(SHOTS / name), full_page=True)

            page.route("**/api/forge/status", lambda route: route.abort())
            page.route("**/api/forge/catalog", lambda route: route.abort())
            page.locator('.bottom-nav [data-nav="carnet"]').click()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => (document.querySelector('#forge-generate-reason').textContent || '').includes(\"n'a pas répondu\")")
            check(page.locator("#forge-generate").is_disabled(), "a connection error disables generate")
            page.unroute("**/api/forge/status")
            page.unroute("**/api/forge/catalog")
            page.locator('.bottom-nav [data-nav="carnet"]').click()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value && !document.querySelector('#forge-generate').disabled")
            check(page.locator("#forge-generate").is_enabled(), "generate returns after the connection recovers")
            browser.close()
        print("PASSED", passed)
    finally:
        proc.kill()
        proc.wait(timeout=5)


if __name__ == "__main__":
    main()
