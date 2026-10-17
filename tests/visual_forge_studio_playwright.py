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


def _png_bytes() -> bytes:
    import io
    from PIL import Image
    image = Image.new("RGB", (256, 256), (12, 40, 180))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-forge-ui-"))
    vault = Path(tempfile.mkdtemp(prefix="hq-forge-vault-"))
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

            # Layout measurements use page.evaluate. The served policy stays unchanged.
            admin = browser.new_context(bypass_csp=True)
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
            page.locator('[data-nav="carnet"]').click()
            check(page.evaluate("() => getComputedStyle(document.querySelector('#forge-studio')).display") == "none", "forge panel is hidden while Carnet is open")
            check(page.locator('[data-panel="carnet"] #forge-generate').count() == 0, "forge generate is not inside the Carnet panel")
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelectorAll('#forge-checkpoint option').length > 0 && document.querySelector('#forge-checkpoint').value")
            check("Forge Studio" in page.locator("#forge-studio h1").inner_text(), "forge heading")
            page.locator("#forge-checkpoint").focus()
            check(page.evaluate("() => document.activeElement.id") == "forge-checkpoint", "model selector takes keyboard focus")
            page.locator("#forge-sampler").focus()
            check(page.evaluate("() => document.activeElement.id") == "forge-sampler", "sampler selector takes keyboard focus")
            page.locator("#forge-scheduler").focus()
            check(page.evaluate("() => document.activeElement.id") == "forge-scheduler", "scheduler selector takes keyboard focus")
            page.locator("#forge-checkpoint").select_option(index=0)
            page.locator("#forge-sampler").select_option(index=0)
            page.locator("#forge-scheduler").select_option(index=0)
            check("example.safetensors" in page.locator("#forge-choice-note").inner_text(), "selected model is written beside the menu")
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.locator("#forge-vault").wait_for()
            check("compte Windows" in page.locator("#forge-private-note").inner_text(), "private generation waits for a restricted vault")
            check(page.locator("#forge-generate-private").is_disabled(), "private generate is disabled before the vault exists")
            page.locator("#forge-vault-new").fill("synthetic horse battery")
            page.locator("#forge-vault-confirm").fill("synthetic horse battery")
            page.locator("#forge-vault-create").click()
            page.locator("#forge-vault-recovery-key").wait_for()
            check(len(page.locator("#forge-vault-recovery-key").input_value()) > 20, "recovery key is shown once")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "forge-vault-recovery.png"), full_page=True)
            page.locator("#forge-vault-recovery-ok").click()
            page.locator("#forge-vault-pass").wait_for()
            check("0 image" not in page.locator("#forge-vault").inner_text(), "locked vault hides inventory")
            page.locator("#forge-vault-pass").fill("synthetic horse battery")
            page.locator("#forge-vault-open").click()
            page.locator("#forge-vault-lock").wait_for()
            check(page.locator("#forge-generate-private").is_enabled(), "private generate enables once the vault is restricted")
            image = page.request.post(
                base + "/api/forge/vault/import",
                data=_png_bytes(),
                headers={"origin": base, "content-type": "application/octet-stream"},
            )
            check(image.status == 201, "private import is accepted while unlocked")
            image_id = image.json()["id"]
            opened = page.request.get(base + "/api/forge/vault/images/" + image_id + "/thumb")
            check(opened.status == 200 and "no-store" in opened.headers.get("cache-control", ""), "private thumb is not cached")
            page.locator("#forge-vault-lock").click()
            page.locator("#forge-vault-pass").wait_for()
            closed = page.request.get(base + "/api/forge/vault/images/" + image_id + "/thumb")
            check(closed.status == 401, "private thumb is refused after lock")
            page.locator('input[name="forge-destination"][value="normal"]').check()
            check("autre travail" in page.locator("#forge-cancel-note").inner_text(), "cancel limitation is visible")
            colors = page.eval_on_selector("#forge-status", "node => [getComputedStyle(node).color, getComputedStyle(node).backgroundColor]")
            check(contrast(colors[0], colors[1]) >= 4.5, "status contrast")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "forge-desktop-dark.png"), full_page=True)
            page.locator("#forge-prompt").fill("un cercle rouge")
            page.locator("#forge-prompt").press("Tab")
            landed = page.evaluate("() => document.activeElement.getAttribute('aria-controls') || document.activeElement.id")
            check(landed in ("forge-help-negative", "forge-negative"), "tab leaves the prompt")
            if landed != "forge-negative":
                page.keyboard.press("Tab")
            check(page.evaluate("() => document.activeElement.id") == "forge-negative", "the next field after help is the negative prompt")
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
                for width, height, name in ((360, 800, "forge-360.png"), (390, 844, "forge-phone.png"), (834, 1112, "forge-834.png"), (1280, 900, "forge-1280.png"), (1440, 900, "forge-1440.png")):
                    phone.set_viewport_size({"width": width, "height": height})
                    phone.screenshot(path=str(SHOTS / name), full_page=True)

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

            scripted = {}

            def scripted_route(route):
                payload = scripted["status"] if route.request.url.endswith("/api/forge/status") else scripted["catalog"]
                route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

            page.route("**/api/forge/status", scripted_route)
            page.route("**/api/forge/catalog", scripted_route)

            def open_forge():
                page.locator('[data-nav="carnet"]').click()
                page.locator('.bottom-nav [data-nav="forge"]').click()

            scripted["status"] = {"forge": "offline", "code": "forge_offline", "message": "Forge n'est pas démarré.", "model": None}
            scripted["catalog"] = {"forge": "offline", "code": "forge_offline", "message": "Forge n'est pas démarré.", "models": [], "samplers": [], "schedulers": []}
            open_forge()
            page.wait_for_function("() => (document.querySelector('#forge-status').textContent || '').includes(\"n'est pas démarré\")")
            check("lanceur API" in page.locator("#forge-status").inner_text(), "offline explains the owner launcher")
            check(page.locator("#forge-generate").is_disabled(), "generate stays disabled while Forge is stopped")
            check("Indisponible" in page.locator("#forge-checkpoint").inner_text(), "stopped Forge does not leave a blank model menu")

            scripted["status"] = {"forge": "api_disabled", "code": "api_disabled", "message": "Forge est ouvert, mais son API n'est pas activée.", "model": None}
            scripted["catalog"] = {"forge": "api_disabled", "code": "api_disabled", "message": "Forge est ouvert, mais son API n'est pas activée.", "models": [], "samplers": [], "schedulers": []}
            open_forge()
            page.wait_for_function("() => (document.querySelector('#forge-choice-note').textContent || '').includes(\"n'est pas activée\")")
            check("n'est pas activée" in page.locator("#forge-choice-note").inner_text(), "missing API is distinct from an empty catalog")

            scripted["status"] = {"forge": "ready", "code": "ready", "message": "Forge est en ligne.", "model": "example.safetensors"}
            scripted["catalog"] = {"forge": "error", "code": "catalog_empty", "message": "Forge répond, mais le catalogue utilisable est vide.", "models": [], "samplers": [], "schedulers": []}
            open_forge()
            page.wait_for_function("() => (document.querySelector('#forge-choice-note').textContent || '').includes('vide')")
            check(page.locator("#forge-generate").is_disabled(), "empty catalog does not enable generate")

            scripted["catalog"] = {"forge": "error", "code": "forge_malformed", "message": "Forge a renvoyé un JSON illisible.", "models": [], "samplers": [], "schedulers": []}
            open_forge()
            page.wait_for_function("() => (document.querySelector('#forge-choice-note').textContent || '').includes('illisible')")
            check("illisible" in page.locator("#forge-choice-note").inner_text(), "malformed catalog is explained")

            scripted["catalog"] = {
                "forge": "ready", "code": "ready", "message": "Forge est en ligne.",
                "models": [{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd"}],
                "samplers": [{"name": "Euler a"}, {"name": "DPM++ 2M"}],
                "schedulers": [{"name": "automatic", "label": "Automatic"}],
            }
            open_forge()
            page.wait_for_function("() => [...document.querySelectorAll('#forge-sampler option')].some((item) => item.textContent.includes('DPM++'))")
            page.locator("#forge-sampler").select_option(label="DPM++ 2M")
            check(page.locator("#forge-generate").is_enabled(), "generate enables when the catalog is valid")
            scripted["catalog"]["samplers"] = [{"name": "Euler a"}]
            open_forge()
            page.wait_for_function("() => (document.querySelector('#forge-choice-note').textContent || '').includes('plus proposé')")
            check("Euler a" == page.locator("#forge-sampler").input_value(), "a removed sampler is not kept")

            page.unroute("**/api/forge/status", scripted_route)
            page.unroute("**/api/forge/catalog", scripted_route)

            def abort_forge(route):
                route.abort()

            page.route("**/api/forge/**", abort_forge)
            open_forge()
            page.wait_for_function("() => (document.querySelector('#forge-choice-note').textContent || '').includes('échoué')")
            check(page.locator("#forge-generate").is_disabled(), "a lost connection disables generate")
            check("Indisponible" in page.locator("#forge-checkpoint").inner_text(), "a lost connection clears the model menu")

            page.unroute("**/api/forge/**", abort_forge)
            open_forge()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.locator("#forge-vault-pass").fill("synthetic horse battery")
            page.locator("#forge-vault-open").click()
            page.locator("#forge-vault-lock").wait_for()
            check(page.locator("#forge-generate-private").is_enabled(), "private generate is enabled with a ready catalog and an unlocked vault")
            failed_refresh = page.evaluate("""() => new Promise((resolve) => {
              const original = window.fetch.bind(window);
              window.__forgeFetch = original;
              window.fetch = (url, options) => {
                const target = String(url);
                if (target.includes('/api/forge/status') || target.includes('/api/forge/catalog')) {
                  return Promise.reject(new TypeError('Failed to fetch'));
                }
                if (target.includes('/api/forge/vault/status')) return new Promise(() => {});
                return original(url, options);
              };
              window.hqForgeShow();
              const watch = () => {
                const note = document.querySelector('#forge-choice-note').textContent || '';
                if (!note.includes('échoué')) {
                  requestAnimationFrame(watch);
                  return;
                }
                const text = (id) => document.querySelector(id).textContent || '';
                const value = (id) => document.querySelector(id).value;
                resolve({
                  generateDisabled: document.querySelector('#forge-generate').disabled,
                  privateDisabled: document.querySelector('#forge-generate-private').disabled,
                  checkpoint: text('#forge-checkpoint'),
                  sampler: text('#forge-sampler'),
                  scheduler: text('#forge-scheduler'),
                  checkpointValue: value('#forge-checkpoint'),
                  samplerValue: value('#forge-sampler'),
                  schedulerValue: value('#forge-scheduler'),
                  note,
                  reason: text('#forge-generate-reason')
                });
              };
              watch();
            })""")
            check(failed_refresh["generateDisabled"] and failed_refresh["privateDisabled"], "a lost catalog disables normal and private generate")
            check(
                failed_refresh["checkpointValue"] == "" and failed_refresh["samplerValue"] == "" and failed_refresh["schedulerValue"] == ""
                and "Indisponible" in failed_refresh["checkpoint"] and "Indisponible" in failed_refresh["sampler"] and "Indisponible" in failed_refresh["scheduler"],
                "a lost catalog makes the selectors unavailable",
            )
            check("échoué" in failed_refresh["note"] and "n'a pas répondu" in failed_refresh["reason"], "a lost catalog shows the connection error")
            page.evaluate("() => { window.fetch = window.__forgeFetch; window.hqForgeShow(); }")
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value && !document.querySelector('#forge-generate-private').disabled && !document.querySelector('#forge-generate').disabled")
            check(page.locator("#forge-generate-private").is_enabled(), "private generate recovers when the catalog returns")
            check(page.locator("#forge-generate").is_enabled(), "generate recovers when the catalog returns")
            check("Indisponible" not in page.locator("#forge-sampler").inner_text(), "selectors recover when the catalog returns")
            check(page.locator("#forge-generate-reason").inner_text() == "", "the connection error clears when the catalog returns")

            loading = admin.new_page()
            loading.goto(base + "/")
            connecting = loading.evaluate("""() => {
              window.fetch = () => new Promise(() => {});
              window.hqForgeShow();
              return document.querySelector('#forge-status').textContent || '';
            }""")
            check("Connexion à Forge" in connecting, "connecting shows a loading state before the catalog returns")
            browser.close()
        print("PASSED", passed)
    finally:
        proc.kill()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(vault, ignore_errors=True)


if __name__ == "__main__":
    main()
