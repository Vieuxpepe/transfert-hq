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
sys.path.insert(0, str(HERE.parent))
import hq_forge_worker as W  # noqa: E402  (pairs a "new PC" from the test process for the detection step)
SHOTS = Path(os.environ["FORGE_SHOTS"]) if os.environ.get("FORGE_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)
WIDTHS = ((375, 812), (430, 932), (768, 1024), (1440, 900))
CLIPBOARD_STUB = """
window.__copied = [];
try {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.__copied.push(String(t)); } } });
} catch (_) {}
"""


def start_server(root: Path, vault: Path, extra: dict):
    env = os.environ.copy()
    env["HQ_FORGE_MOCK"] = "ready"
    env["HQ_FORGE_VAULT_DIR"] = str(vault)
    env.update(extra)
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
    )
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    assert int(info["base"].rsplit(":", 1)[1]) not in (8765, 8766, 8776, 7860)
    return proc, info


def stop_server(proc) -> None:
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.kill()
    proc.wait(timeout=5)


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
            admin.add_init_script(CLIPBOARD_STUB)
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
            salon = card("PC salon")
            check(salon.locator(".forge-device-check").inner_text().strip() == "\u2713" and "Choisi" in salon.locator(".forge-device-chosen").inner_text(),
                  "selection shows a check badge and a word, not colour alone")
            check(salon.evaluate("n => getComputedStyle(n).outlineStyle") != "none", "a selected card gets an outline as well as a border")
            check(salon.locator('input[type="checkbox"]').evaluate("n => n.checked && n.getAttribute('aria-describedby') !== null"), "the checkbox carries the checked state and its reason")
            check(card("Atelier").locator(".forge-device-next").count() == 1 and "\u00c0 faire" in card("Atelier").locator(".forge-device-next").inner_text(),
                  "an incompatible card gives a next step")
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
                cols = page.evaluate("() => getComputedStyle(document.querySelector('#forge-device-list')).gridTemplateColumns.split(' ').length")
                check(cols == 1 if width <= 430 else cols >= 2, f"{cols} card column(s) at {width}px")
                widths = page.evaluate("() => [...document.querySelectorAll('#forge-device-list .forge-device')].map((n) => n.getBoundingClientRect().width)")
                check(min(widths) >= (min(width - 60, 250)), f"cards are wide enough at {width}px ({int(min(widths))}px)")
                rows = page.evaluate("() => { const m = {}; document.querySelectorAll('#forge-device-list .forge-device').forEach((n) => { const r = n.getBoundingClientRect(); const k = Math.round(r.top); (m[k] = m[k] || []).push(Math.round(r.height)); }); return Object.values(m); }")
                check(all(max(r) - min(r) <= 1 for r in rows), f"cards in a row share a height at {width}px")
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

            states = page.locator("#forge-fleet-batch-workers .forge-fleet-batch-worker-state").all_inner_texts()
            check(len(states) == 3 and all(s == "Termin\u00e9" for s in states), "each device row has its own status")

            # Live updates never steal focus, move the caret, scroll, or rewrite the prompt.
            page.set_viewport_size({"width": 1440, "height": 900})
            page.locator("#forge-fleet-count").fill("6")
            page.locator("#forge-fleet-count").dispatch_event("input")
            page.wait_for_function("() => !document.querySelector('#forge-generate').disabled")
            page.locator("#forge-generate").click()
            page.wait_for_function("() => (document.querySelector('#forge-fleet-batch-state').textContent || '') === 'En cours'")
            page.wait_for_function("() => [...document.querySelectorAll('#forge-fleet-batch-workers .forge-fleet-batch-worker-state')].some((n) => n.textContent.startsWith('En cours'))", timeout=15000)
            check(True, "a running row says En cours")
            prompt = page.locator("#forge-prompt")
            prompt.scroll_into_view_if_needed()
            prompt.focus()
            page.evaluate("() => { const t = document.querySelector('#forge-prompt'); t.setSelectionRange(5, 5); }")
            before = page.evaluate("() => ({ y: window.scrollY, v: document.querySelector('#forge-prompt').value })")
            page.evaluate("() => { window.__rowsBefore = [...document.querySelectorAll('#forge-fleet-batch-workers li')]; window.__promptNode = document.querySelector('#forge-prompt'); }")
            for _ in range(4):
                page.wait_for_timeout(1000)
                page.keyboard.type("x")
            after = page.evaluate("""() => { const t = document.querySelector('#forge-prompt'); return { y: window.scrollY, focus: document.activeElement === t, caret: t.selectionStart, v: t.value,
                same: window.__promptNode === t, rows: [...document.querySelectorAll('#forge-fleet-batch-workers li')].every((n, i) => n === window.__rowsBefore[i]) }; }""")
            check(after["focus"], "the prompt keeps focus during progress")
            check(after["caret"] == 9 and after["v"] == before["v"][:5] + "xxxx" + before["v"][5:], "typing lands at the caret during progress")
            check(abs(after["y"] - before["y"]) <= 1, "progress does not scroll the page")
            check(after["same"] and after["rows"], "progress updates rows in place (no rebuild)")
            page.wait_for_function("() => (document.querySelector('#forge-fleet-batch-totals').textContent || '').startsWith('6 / 6')", timeout=60000)
            prompt.fill("phare au cr\u00e9puscule, trois appareils")

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
                check(page.locator("#forge-device-dialog .forge-guide > li").count() == 6, "the guide has six steps")
                guide = page.locator("#forge-device-dialog .forge-guide").inner_text()
                check(all(word in guide for word in ("Python 3.10", "Tailscale", "--api", "--listen", "hq_forge_worker.py", "invite masqu")), "the steps name the software, Tailscale, Forge flags, the file and the hidden prompt")
                page.evaluate("() => { window.__copied = []; }")
                page.locator('#forge-device-dialog [data-copy="pair"]').click()
                page.locator('#forge-device-dialog [data-copy="run"]').click()
                page.wait_for_function("() => window.__copied.length === 2")
                copied = page.evaluate("() => window.__copied")
                check(copied[0].startswith("py -3 .\\hq_forge_worker.py pair --hq " + base) and copied[1] == "py -3 .\\hq_forge_worker.py run", "copy buttons copy the pair and run commands")
                check(all(code not in text and code.replace("-", "") not in text for text in copied), "copied commands never contain the code")
                check("Copi\u00e9" in page.locator('#forge-device-dialog [data-copy="run"]').inner_text(), "the copy button confirms")
                check(code not in page.evaluate("() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage)"), "the code is not stored in the browser")
                check("En attente d'un nouvel appareil" in page.locator("#forge-device-detect").inner_text(), "step 6 waits for the new device")
                if width == 1440:
                    W.pair(base, code, "PC d\u00e9tect\u00e9", dev=True, hardware={"gpus": [{"name": "Mock GPU", "vram_mb": 8192, "source": "nvidia-smi"}], "cpu": "Mock CPU", "ram_mb": 16384})
                    page.wait_for_function("() => (document.querySelector('#forge-device-detect').textContent || '').includes('Appareil d\u00e9tect\u00e9 \u2713')", timeout=15000)
                    check("PC d\u00e9tect\u00e9" in page.locator("#forge-device-detect").inner_text(), "the sheet detects the new device live")
                    check(page.locator("#forge-device-code").inner_text() == "", "the spent code is hidden once the device is detected")
                    page.locator("#forge-device-detect").scroll_into_view_if_needed()
                    shot("enroll-detected-1440")
                    page.locator("#forge-device-code-new").click()
                    page.wait_for_function("() => /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(document.querySelector('#forge-device-code').textContent)")
                    code = page.locator("#forge-device-code").inner_text()
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

            # Diagnostics: one simulated worker per state, all from real worker telemetry.
            droot = Path(tempfile.mkdtemp(prefix="hq-forge-fleet-diag-"))
            dvault = Path(tempfile.mkdtemp(prefix="hq-forge-fleet-diag-vault-"))
            dproc, dinfo = start_server(droot, dvault, {"HQ_FORGE_FLEET_DIAG": "1", "HQ_FORGE_FLEET_ONLINE_SEC": "4"})
            try:
                dbase = dinfo["base"]
                browser = playwright.chromium.launch()
                ctx = browser.new_context(bypass_csp=True, has_touch=True)
                if ctx.request.post(dbase + "/login", form={"pin": dinfo["admin_pin"]}, headers={"origin": dbase}, max_redirects=0).status != 303:
                    raise SystemExit("login failed (diagnostics)")
                page = ctx.new_page()
                page.emulate_media(reduced_motion="reduce")
                page.set_viewport_size({"width": 1440, "height": 900})
                page.goto(dbase + "/")
                page.locator('.bottom-nav [data-nav="forge"]').click()
                page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
                page.wait_for_function("() => document.querySelectorAll('#forge-device-list .forge-device').length === 10")
                page.wait_for_function("() => [...document.querySelectorAll('.forge-device')].some((n) => n.textContent.includes('ne r\u00e9pond plus depuis'))", timeout=20000)
                page.wait_for_function("() => [...document.querySelectorAll('.forge-device')].some((n) => n.textContent.includes('refuse les identifiants'))", timeout=20000)
                expect = {
                    "Sans Forge": ("API Forge indisponible", "--api"),
                    "Forge occup\u00e9": ("occup\u00e9 par un autre travail", "Attendez"),
                    "Sans pilote": ("Mat\u00e9riel incomplet", "nvidia-smi"),
                    "Autre mod\u00e8le": ("absent", "\u00c0 faire"),
                    "En veille": ("Le service worker ne r\u00e9pond plus depuis", "pas forc\u00e9ment une panne Tailscale"),
                    "R\u00e9seau instable": ("ne pas pouvoir joindre HQ", "Tailscale est connect\u00e9"),
                    "Identifiants refus\u00e9s": ("refuse les identifiants", "pair"),
                    "Ancien secret": ("Secret non prot\u00e9g\u00e9", "nouveau code"),
                }
                for name, (title, action) in expect.items():
                    text = card(name).locator(".forge-device-why").inner_text()
                    check(title in text and action in text, f"diagnostic for {name}: {title}")
                check("Tailscale" not in card("En veille").locator(".forge-device-diag").inner_text(), "a stale worker is not called a Tailscale outage")
                check(card("En veille").locator('input[type="checkbox"]').is_disabled() and card("Ancien secret").locator('input[type="checkbox"]').is_disabled(),
                      "offline and unprotected devices cannot be selected")
                long = card("Studio graphique")
                name_el = long.locator(".forge-device-name")
                check(name_el.get_attribute("title") == "Studio graphique du fond, poste n°1", "a long name keeps its full text in the title")
                check(name_el.evaluate("n => getComputedStyle(n).textOverflow") == "ellipsis", "a long name ellipsizes")
                check("Radeon Graphics" in long.locator(".forge-device-specs").inner_text(), "the full CPU name is in the expanded specs")
                check(long.locator(".forge-device-gpu").get_attribute("title").endswith("16 Go"), "the GPU line keeps its full text in the title")
                for width, height in WIDTHS:
                    page.set_viewport_size({"width": width, "height": height})
                    page.wait_for_timeout(200)
                    check(no_overflow(), f"diagnostic cards fit at {width}px")
                    page.locator("#forge-devices").scroll_into_view_if_needed()
                    shot(f"diag-cards-{width}")
                    if SHOTS:
                        page.locator("#forge-device-list").screenshot(path=str(SHOTS / f"{engine}-diag-list-{width}.png"))
                for theme in ("theme-midnight", "theme-oled", ""):
                    page.evaluate("(t) => { document.body.classList.remove('theme-oled','theme-midnight'); if (t) document.body.classList.add(t); }", theme)
                    page.wait_for_timeout(100)
                    check(card("Sans Forge").evaluate("n => getComputedStyle(n).color !== getComputedStyle(n).backgroundColor"), f"cards stay legible in {theme or 'default'}")
                    card("Sans Forge").scroll_into_view_if_needed()
                    shot(f"diag-{theme or 'default'}")
                browser.close()
            finally:
                stop_server(dproc)
        print("PASSED", passed)
    finally:
        stop_server(proc)


if __name__ == "__main__":
    main()
