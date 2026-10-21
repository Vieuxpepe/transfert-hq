"""Forge Studio multi-device UI. Mock local Forge, three simulated workers with mock Forges.

No GPU, no real Forge, no port 7860/8765/8766/8776, no live root or vault.

FORGE_SHOTS=dir python tests/visual_forge_fleet_playwright.py
python tests/run_forge_visual_webkit.py tests/visual_forge_fleet_playwright.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
SHOTS = Path(os.environ["FORGE_SHOTS"]) if os.environ.get("FORGE_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)
WIDTHS = ((375, 812), (430, 932), (768, 1024), (1440, 900))


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-forge-fleet-"))
    vault = Path(tempfile.mkdtemp(prefix="hq-forge-fleet-vault-"))
    env = os.environ.copy()
    env["HQ_FORGE_MOCK"] = "ready"
    env["HQ_FORGE_VAULT_DIR"] = str(vault)
    env["HQ_FORGE_FLEET_MOCK"] = "3"
    env["HQ_FORGE_FLEET_DELAY"] = "2.0"
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    passed = 0
    engine = "chromium"
    try:
        info = json.loads(proc.stdout.readline().decode("utf-8"))
        base = info["base"]
        port = int(base.rsplit(":", 1)[1])
        assert port not in (8765, 8766, 8776, 7860)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            engine = browser.browser_type.name
            admin = browser.new_context(bypass_csp=True, has_touch=True)
            login = admin.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0)
            if login.status != 303:
                raise SystemExit("login failed")
            page = admin.new_page()
            page.emulate_media(reduced_motion="reduce")
            page.on("dialog", lambda dialog: dialog.accept())

            def check(cond: bool, message: str) -> None:
                nonlocal passed
                if not cond:
                    raise SystemExit(f"FAIL [{engine}]: " + message)
                passed += 1
                print("  OK  ", message)

            def shot(name: str) -> None:
                if SHOTS:
                    page.screenshot(path=str(SHOTS / f"{engine}-{name}.png"), full_page=False)

            def card(name: str):
                return page.locator(".forge-device", has=page.locator(".forge-device-name", has_text=name))

            def no_overflow() -> bool:
                return page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")

            page.set_viewport_size({"width": 375, "height": 812})
            page.goto(base + "/")
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
            page.wait_for_function("() => document.querySelectorAll('#forge-device-list .forge-device').length === 4")
            page.wait_for_function("() => [...document.querySelectorAll('#forge-device-list .forge-device')].filter((n) => n.dataset.state === 'available').length >= 3")
            check(card("Cet HQ").count() == 1, "the HQ machine is the built-in device")
            check("RTX 4070" in card("PC salon").inner_text() and "12 Go" in card("PC salon").inner_text(), "GPU and VRAM come from the worker report")
            check("VRAM inconnue" in card("Portable").inner_text(), "VRAM stays unknown without nvidia-smi")
            atelier = card("Atelier")
            check(atelier.get_attribute("data-state") == "incompatible", "a worker without the chosen model is marked incompatible")
            check("Modèle incompatible" in atelier.inner_text() and "absent" in atelier.inner_text(), "the incompatibility is explained in French")
            check(atelier.locator('input[type="checkbox"]').is_disabled(), "an incompatible worker cannot be selected")
            check("En ligne" in card("PC salon").inner_text() and "Disponible" in card("PC salon").inner_text(), "link and Forge states are shown separately")
            check(page.locator("#forge-fleet-count-field").is_hidden(), "with only this HQ selected the single-job path stays as before")
            check(page.locator("#forge-generate").inner_text().strip() == "Générer", "the Générer label is unchanged in single-device mode")

            card("PC salon").locator(".forge-device-gpu").click()
            check(card("PC salon").locator('input[type="checkbox"]').is_checked(), "a tap on the card selects it")
            page.locator("#forge-devices-all").click()
            check(page.locator("#forge-devices-count").inner_text() == "3 appareils choisis", "select-all takes the compatible devices only")
            check(not atelier.locator('input[type="checkbox"]').is_checked(), "select-all skips the incompatible one")
            check(page.locator("#forge-fleet-count-field").is_visible(), "the image count appears in multi-device mode")
            page.locator("#forge-fleet-count").fill("6")
            page.locator("#forge-fleet-count").dispatch_event("input")
            check(page.locator("#forge-generate").inner_text().strip() == "Générer 6 sur 3 appareils", "Générer says what will happen")
            check(page.locator("#forge-actionbar").evaluate("n => getComputedStyle(n).position") == "sticky", "the action bar stays sticky")
            for width, height in WIDTHS:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(150)
                check(no_overflow(), f"no horizontal overflow at {width}px")
                page.locator("#forge-devices").scroll_into_view_if_needed()
                shot(f"cards-{width}")

            page.set_viewport_size({"width": 375, "height": 812})
            page.locator("#forge-prompt").fill("phare au crépuscule, trois appareils")
            page.locator("#forge-generate").click()
            page.wait_for_function("() => !document.querySelector('#forge-fleet-batch').hidden")
            page.wait_for_function("() => document.querySelectorAll('#forge-fleet-batch-workers .forge-fleet-batch-worker').length === 3")
            check(True, "the batch monitor lists one row per device")
            page.wait_for_function("() => document.querySelector('#forge-device-list .forge-device progress') !== null", timeout=15000)
            check(True, "device cards show live progress")
            page.locator("#forge-fleet-batch").scroll_into_view_if_needed()
            shot("monitor-running-375")
            page.wait_for_function("() => (document.querySelector('#forge-fleet-batch-totals').textContent || '').startsWith('6 / 6')", timeout=60000)
            check("Terminé" in page.locator("#forge-fleet-batch-state").inner_text(), "the batch completes")
            page.wait_for_function("() => document.querySelectorAll('#forge-results .forge-card').length === 6")
            check(True, "the six images land in the results grid")
            rows = page.locator("#forge-fleet-batch-workers .forge-fleet-batch-worker-text").all_inner_texts()
            check(sum(int(re.match(r"(\d+)", text).group(1)) for text in rows) == 6, "per-device counts add up")
            check(sum(1 for text in rows if not text.startswith("0")) >= 2, "work was spread over several devices")
            gallery = admin.request.get(base + "/api/forge/gallery?limit=48").json()
            check(len(gallery["images"]) == 6, "the normal HQ gallery holds the batch")
            detail = admin.request.get(base + "/api/forge/gallery/" + gallery["images"][0]["id"]).json()
            check(detail["origin"]["batch_id"].startswith("bt-") and detail["origin"]["worker_name"], "gallery metadata records the device and batch")
            for width, height in WIDTHS:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(150)
                check(no_overflow(), f"monitor fits at {width}px")
                page.locator("#forge-fleet-batch").scroll_into_view_if_needed()
                shot(f"monitor-done-{width}")

            # Cancel: queued images are dropped; the ones already sent finish.
            page.set_viewport_size({"width": 1440, "height": 900})
            page.locator("#forge-fleet-count").fill("12")
            page.locator("#forge-fleet-count").dispatch_event("input")
            page.wait_for_function("() => !document.querySelector('#forge-generate').disabled")
            page.locator("#forge-generate").click()
            page.wait_for_function("() => !document.querySelector('#forge-fleet-batch-cancel').hidden")
            page.locator("#forge-fleet-batch-cancel").click()
            page.wait_for_function("() => ['Terminé en partie', 'Annulé'].includes(document.querySelector('#forge-fleet-batch-state').textContent)", timeout=60000)
            totals = page.locator("#forge-fleet-batch-totals").inner_text()
            check("annulées" in totals, "cancel drops the queued images")
            page.locator("#forge-fleet-batch").scroll_into_view_if_needed()
            shot("monitor-cancelled-1440")

            # Private mode stays local.
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.wait_for_function("() => !document.querySelector('#forge-fleet-private').hidden")
            check(card("PC salon").locator('input[type="checkbox"]').is_disabled(), "remote devices are disabled in private mode")
            check("cet HQ" in card("PC salon").inner_text(), "the card explains why")
            check(page.locator("#forge-fleet-count-field").is_hidden(), "private mode uses the single local path")
            page.locator("#forge-devices").scroll_into_view_if_needed()
            shot("private-1440")
            refused = admin.request.post(base + "/api/forge/batches", data=json.dumps({
                "workers": [info["workers"][0]], "count": 1, "destination": "private",
                "settings": {"prompt": "x", "checkpoint": "example.safetensors [abcd]", "sampler_name": "Euler", "scheduler": "automatic",
                             "width": 512, "height": 512, "steps": 10, "cfg_scale": 7, "seed": 1}}),
                headers={"content-type": "application/json", "origin": base, "idempotency-key": "private-ui-check-1"})
            check(refused.status == 403, "the server refuses a private batch on a remote device")
            page.locator('input[name="forge-destination"][value="normal"]').check()

            # Pairing dialog.
            for width, height in WIDTHS:
                page.set_viewport_size({"width": width, "height": height})
                page.locator("#forge-device-add").click()
                check(page.locator("#forge-device-dialog").evaluate("n => n.open"), f"the pairing sheet opens at {width}px")
                page.locator("#forge-device-code-new").click()
                page.wait_for_function("() => /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector('#forge-device-code').textContent)")
                code = page.locator("#forge-device-code").inner_text()
                check(code not in page.url, "the code is never in the URL")
                check(("pair --hq " + base) in page.locator("#forge-device-snippet").inner_text(), "the setup snippet targets this HQ")
                check("--code" not in page.locator("#forge-device-snippet").inner_text() and code not in page.locator("#forge-device-snippet").inner_text(), "the snippet never carries the code")
                check(page.evaluate("() => { const d = document.querySelector('#forge-device-dialog'); const r = d.getBoundingClientRect(); return r.left >= -1 && r.right <= innerWidth + 1; }"), f"the sheet fits at {width}px")
                shot(f"enroll-{width}")
                page.locator("#forge-device-dialog-close").click()
                check(not page.locator("#forge-device-dialog").evaluate("n => n.open"), "the sheet closes")
                check(page.evaluate("() => document.activeElement && document.activeElement.id") == "forge-device-add", "focus returns to Ajouter un appareil")
                check(page.locator("#forge-device-code").inner_text() == "", "the code is cleared on close")

            # Management: rename and disable from the expanded card.
            page.set_viewport_size({"width": 430, "height": 932})
            target = card("Portable")
            more = target.locator(".forge-device-more")
            if not more.evaluate("n => n.open"):
                more.locator("summary").click()
            check("CPU" in more.inner_text() and "RAM" in more.inner_text(), "specs expand on phone")
            target.locator(".forge-device-rename input").fill("Portable bureau")
            target.locator(".forge-device-rename button").click()
            page.wait_for_function("() => [...document.querySelectorAll('.forge-device-name')].some((n) => n.textContent === 'Portable bureau')")
            check(True, "rename updates the card")
            card("Portable bureau").locator("button", has_text="Désactiver").click()
            page.wait_for_function("() => [...document.querySelectorAll('.forge-device')].some((n) => n.dataset.state === 'disabled')")
            check("Désactivé" in card("Portable bureau").inner_text(), "a disabled device says so")
            card("Portable bureau").locator(".forge-device-more").scroll_into_view_if_needed()
            shot("manage-430")
            card("Portable bureau").locator("button", has_text="Réactiver").click()
            page.wait_for_function("() => ![...document.querySelectorAll('.forge-device')].some((n) => n.dataset.state === 'disabled')")
            check(True, "the device can be re-enabled")

            # Capturer and help tooltips are untouched.
            page.set_viewport_size({"width": 1440, "height": 900})
            check(page.locator("#forge-capture").count() == 1, "the header Capturer button is still present")
            browser.close()
        print("PASSED", passed)
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.kill()
        proc.wait(timeout=5)


if __name__ == "__main__":
    main()
