"""Presets, setting help, and the live selection sentence. Mock Forge only."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

# Windows consoles default to cp1252: never crash on ✓ or ≥ in a check message.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, ValueError):
        pass

HERE = Path(__file__).resolve().parent
SHOTS = Path(os.environ["FORGE_PRESET_SHOTS"]) if os.environ.get("FORGE_PRESET_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)

CATALOG = {
    "forge": "ready",
    "code": "ready",
    "message": "Forge est en ligne.",
    "models": [{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd"}],
    "samplers": [{"name": "Euler a"}, {"name": "DPM++ 2M"}],
    "schedulers": [{"name": "automatic", "label": "Automatic"}, {"name": "karras", "label": "Karras"}],
}
STATUS = {"forge": "ready", "code": "ready", "message": "Forge est en ligne.", "model": "example.safetensors"}


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-forge-presets-"))
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
            context = browser.new_context(bypass_csp=True)
            login = context.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0)
            if login.status != 303:
                raise SystemExit("login failed")
            page = context.new_page()
            page.set_viewport_size({"width": 1440, "height": 900})

            def check(cond: bool, message: str) -> None:
                nonlocal passed
                if not cond:
                    raise SystemExit("FAIL: " + message)
                passed += 1
                print("  OK  ", message)

            scripted = {"status": STATUS, "catalog": CATALOG}

            def fulfill(route):
                payload = scripted["status"] if route.request.url.endswith("/status") else scripted["catalog"]
                route.fulfill(status=200, content_type="application/json", body=json.dumps(payload))

            page.route("**/api/forge/status", fulfill)
            page.route("**/api/forge/catalog", fulfill)
            page.goto(base + "/")
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
            page.evaluate("() => { document.querySelector('#forge-sampling').open = true; document.querySelector('#forge-negative-fold').open = true; }")
            page.locator("#forge-sampler").select_option(label="DPM++ 2M")
            check("DPM++ 2M" in page.locator("#forge-choice-note").inner_text(), "selection sentence updates immediately")
            page.locator("#forge-scheduler").select_option(label="Karras")
            check("Karras" in page.locator("#forge-choice-note").inner_text(), "scheduler sentence updates immediately")
            page.locator("#forge-prompt").fill("un phare rouge")
            page.locator("#forge-negative").fill("flou")
            page.locator("#forge-preset-save").click()
            page.locator("#forge-preset-name").fill("Rapide")
            page.locator('input[name="forge-preset-kind"][value="technical"]').check()
            page.locator("#forge-preset-confirm").click()
            page.wait_for_function("() => (document.querySelector('#forge-preset-state').textContent || '').includes('Correspond')")
            check("Correspond" in page.locator("#forge-preset-state").inner_text(), "a saved technical preset matches the form")
            page.locator("#forge-prompt").fill("garder ce prompt")
            page.locator("#forge-preset-load").click()
            check(page.locator("#forge-prompt").input_value() == "garder ce prompt", "a technical preset does not replace the positive prompt")
            check(page.locator("#forge-negative").input_value() == "flou", "the negative prompt is restored")
            page.locator("#forge-sampler").select_option(label="Euler a")
            page.wait_for_function("() => (document.querySelector('#forge-preset-state').textContent || '').includes('Modifié')")
            check("Modifié" in page.locator("#forge-preset-state").inner_text(), "manual edits mark the preset dirty")
            page.locator("#forge-sampler").select_option(label="DPM++ 2M")
            page.locator("#forge-preset-rename").click()
            page.locator("#forge-preset-name").fill("Soigné")
            page.locator("#forge-preset-confirm").click()
            page.wait_for_function("() => [...document.querySelectorAll('#forge-preset-list option')].some((item) => item.textContent.includes('Soigné'))")
            check(any("Soigné" in text for text in page.locator("#forge-preset-list option").all_inner_texts()), "preset rename is listed")
            page.locator("#forge-preset-duplicate").click()
            page.wait_for_function("() => document.querySelectorAll('#forge-preset-list option').length >= 3")
            check(page.locator("#forge-preset-list option").count() >= 3, "preset duplicate adds a second entry")
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.locator("#forge-prompt").fill("prompt-prive-ne-pas-copier")
            page.locator("#forge-preset-save").click()
            page.locator("#forge-preset-name").fill("Privé")
            page.locator('input[name="forge-preset-kind"][value="creative"]').check()
            check(page.locator("#forge-preset-privacy-vault").is_visible(), "private mode says a creative preset is not encrypted by the vault")
            check("coffre" in page.locator("#forge-preset-privacy-vault").inner_text().lower(), "private disclosure names the vault")
            check(page.locator("#forge-preset-confirm").is_disabled(), "private creative save waits for acknowledgment")
            refused = False
            try:
                with page.expect_request(lambda request: request.method == "POST" and request.url.endswith("/api/forge/presets"), timeout=800):
                    page.locator("#forge-preset-name").press("Enter")
                refused = False
            except Exception:
                refused = True
            check(refused, "a private prompt is not copied into presets before acknowledgment")
            page.locator("#forge-preset-cancel").click()
            page.locator('input[name="forge-destination"][value="normal"]').check()
            page.locator("#forge-prompt").fill("phare du matin\nsur l'île")
            page.locator("#forge-negative").fill("flou\nfiligrane")
            page.locator("#forge-preset-save").click()
            page.locator("#forge-preset-name").fill("Créatif")
            page.locator('input[name="forge-preset-kind"][value="creative"]').check()
            check(page.locator("#forge-preset-privacy").is_visible(), "creative save discloses plaintext storage before confirmation")
            check("clair" in page.locator("#forge-preset-privacy-plain").inner_text(), "creative disclosure says the prompt is stored in clear text")
            check(page.locator("#forge-preset-privacy-vault").is_hidden(), "the vault warning stays for private generation")
            check(page.locator("#forge-preset-confirm").is_disabled(), "creative save waits for an explicit acknowledgment")
            page.locator("#forge-preset-privacy-ack").check()
            check(page.locator("#forge-preset-confirm").is_enabled(), "acknowledgment allows the creative save")
            page.locator("#forge-preset-confirm").click()
            page.wait_for_function("() => [...document.querySelectorAll('#forge-preset-list option')].some((item) => item.textContent.includes('Créatif'))")
            page.reload()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => [...document.querySelectorAll('#forge-preset-list option')].some((item) => item.textContent.includes('Créatif'))")
            page.evaluate("() => { document.querySelector('#forge-sampling').open = true; document.querySelector('#forge-negative-fold').open = true; }")
            check(any("Créatif" in text for text in page.locator("#forge-preset-list option").all_inner_texts()), "presets remain after a refresh")
            page.locator("#forge-preset-list").select_option(label="Créatif · créatif")
            page.locator("#forge-prompt").fill("")
            page.locator("#forge-preset-load").click()
            check(page.locator("#forge-prompt").input_value() == "phare du matin\nsur l'île", "a creative preset restores the multiline positive prompt")
            check(page.locator("#forge-negative").input_value() == "flou\nfiligrane", "a creative preset restores the multiline negative prompt")
            check(page.locator("#forge-generate").is_enabled(), "a valid loaded preset enables generate")
            page.locator("#forge-prompt").fill("prompt remplacé en privé")
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.locator("#forge-preset-update").click()
            check(page.locator("#forge-preset-update-vault").is_visible(), "updating a creative preset in private mode discloses the vault limit")
            check(page.locator("#forge-preset-update-confirm").is_disabled(), "creative update waits for acknowledgment")
            stored_prompt = page.evaluate(
                """async () => {
                  const data = await fetch('/api/forge/presets', {credentials: 'same-origin'}).then((response) => response.json());
                  const item = (data.presets || []).find((entry) => entry.name === 'Créatif');
                  return item ? item.prompt : '';
                }"""
            )
            check(stored_prompt == "phare du matin\nsur l'île", "a private prompt is not written over the creative preset before acknowledgment")
            page.locator("#forge-preset-update-cancel").click()
            page.locator("#forge-preset-export").click()
            check(page.locator("#forge-preset-export-gate").is_visible(), "export shows the plaintext warning before downloading")
            check("clair" in page.locator("#forge-preset-export-plain").inner_text(), "export disclosure says prompts are clear text")
            check(page.locator("#forge-preset-export-vault").is_visible(), "export in private mode says the file is not a vault backup")
            with page.expect_download() as download_info:
                page.locator("#forge-preset-export-confirm").click()
            check(download_info.value.suggested_filename == "forge-presets.json", "the export downloads only after the plaintext warning")
            page.locator('input[name="forge-destination"][value="normal"]').check()

            scripted["catalog"] = dict(CATALOG, samplers=[{"name": "Euler a"}])
            page.locator('.bottom-nav [data-nav="carnet"]').click()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-sampler').value")
            page.locator("#forge-preset-list").select_option(label="Soigné · technique")
            page.locator("#forge-preset-load").click()
            page.wait_for_function("() => (document.querySelector('#forge-preset-state').textContent || '').includes('Introuvable')")
            check(page.locator("#forge-generate").is_disabled(), "a missing sampler blocks generate")
            check("Indisponible" in page.locator("#forge-sampler").inner_text(), "a missing sampler is flagged in the menu")
            page.locator("#forge-sampler").select_option(label="Euler a")
            check("Euler a" in page.locator("#forge-choice-note").inner_text(), "replacing the missing sampler updates the sentence")
            check(page.locator("#forge-generate").is_enabled(), "generate returns once the missing sampler is replaced")
            page.locator("#forge-preset-update").click()
            page.wait_for_function("() => (document.querySelector('#forge-preset-state').textContent || '').includes('Correspond')")
            check("Correspond" in page.locator("#forge-preset-state").inner_text(), "updating the preset stores the repaired sampler")

            page.evaluate("() => { document.querySelector('#forge-sampling').open = true; }")
            help_button = page.locator('#forge-help-sampler').locator("xpath=preceding-sibling::button")
            help_button.focus()
            check(page.locator("#forge-help-sampler").evaluate("node => getComputedStyle(node).display") == "block", "keyboard focus shows sampler help")
            help_button.hover()
            check("pas à pas" in page.locator("#forge-help-sampler").inner_text(), "hover shows sampler help")
            page.locator("#forge-advanced summary").click()
            page.locator("#forge-preset-save").click()
            page.locator('input[name="forge-preset-kind"][value="creative"]').check()
            check(page.locator("#forge-preset-privacy-plain").is_visible(), "the plaintext warning is on screen for the screenshots")
            for width, height, name in ((1280, 900, "desktop-1280.png"), (1440, 900, "desktop-1440.png"), (834, 1112, "tablet-834.png"), (390, 844, "mobile-390.png"), (360, 800, "mobile-360.png")):
                page.set_viewport_size({"width": width, "height": height})
                if SHOTS:
                    page.screenshot(path=str(SHOTS / name), full_page=True)
            page.locator("#forge-preset-cancel").click()
            page.set_viewport_size({"width": 390, "height": 844})
            help_button.click()
            check(help_button.get_attribute("aria-expanded") == "true", "a tap opens sampler help")
            page.locator("#forge-sampler").select_option(label="Euler a")
            check(page.locator("#forge-sampler").input_value() == "Euler a", "help does not block the sampler")
            for help_id in ("forge-help-checkpoint", "forge-help-scheduler", "forge-help-steps", "forge-help-cfg", "forge-help-width", "forge-help-height", "forge-help-seed", "forge-help-iter", "forge-help-batch", "forge-help-negative", "forge-help-gallery", "forge-help-private"):
                check((page.locator("#" + help_id).text_content() or "").strip() != "", "help text present for " + help_id)

            page.once("dialog", lambda dialog: dialog.accept())
            page.locator("#forge-preset-list").select_option(label="Soigné · technique")
            page.locator("#forge-preset-delete").click()
            page.wait_for_function("() => !(document.querySelector('#forge-preset-state').textContent || '').includes('Soigné') || (document.querySelector('#forge-preset-state').textContent || '').includes('supprimé')")
            check("supprimé" in page.locator("#forge-preset-state").inner_text().lower() or not any("Soigné · technique" == text for text in page.locator("#forge-preset-list option").all_inner_texts()), "delete removes the preset")

            scripted["status"] = {"forge": "offline", "code": "forge_offline", "message": "Forge n'est pas démarré.", "model": None}
            scripted["catalog"] = {"forge": "offline", "code": "forge_offline", "message": "Forge n'est pas démarré.", "models": [], "samplers": [], "schedulers": []}
            page.locator('.bottom-nav [data-nav="carnet"]').click()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => (document.querySelector('#forge-status').textContent || '').includes(\"n'est pas démarré\")")
            check(page.locator("#forge-generate").is_disabled() and page.locator("#forge-generate-private").is_disabled(), "offline disables both generate buttons")
            page.unroute("**/api/forge/status", fulfill)
            page.unroute("**/api/forge/catalog", fulfill)
            page.route("**/api/forge/status", lambda route: route.abort())
            page.route("**/api/forge/catalog", lambda route: route.abort())
            page.locator('.bottom-nav [data-nav="carnet"]').click()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => (document.querySelector('#forge-choice-note').textContent || '').includes('échoué') || (document.querySelector('#forge-generate-reason').textContent || '').includes(\"n'a pas répondu\")")
            check(page.locator("#forge-generate").is_disabled() and page.locator("#forge-generate-private").is_disabled(), "connection failure disables both generate buttons")
            browser.close()
        print("PASSED", passed)
    finally:
        proc.kill()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(vault, ignore_errors=True)


if __name__ == "__main__":
    main()
