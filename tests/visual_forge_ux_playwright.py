"""Forge Studio t85u: responsive workspace, Dernier prompt, Historique. Mock Forge only.

No GPU, no port 7860. The HQ test server binds 127.0.0.1 on an ephemeral port
with throwaway data and vault directories.

FORGE_UX_SHOTS=dir python tests/visual_forge_ux_playwright.py
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
SHOTS = Path(os.environ["FORGE_UX_SHOTS"]) if os.environ.get("FORGE_UX_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)
SOFT = os.environ.get("FORGE_UX_SOFT") == "1"  # evidence runs: report every failed check instead of stopping
soft_failed: list[str] = []

VIEWPORTS = [
    (320, 640, "320-portrait"), (375, 667, "375-portrait"), (390, 844, "390-portrait"), (430, 932, "430-portrait"),
    (768, 1024, "768-portrait"), (1024, 768, "1024-landscape"), (1440, 900, "1440-desktop"),
    (640, 320, "320-landscape"), (667, 375, "375-landscape"), (844, 390, "390-landscape"), (932, 430, "430-landscape"),
    (1024, 768, "768-landscape-as-1024"), (1024, 1366, "1024-portrait"),
]

LAYOUT_PROBE = """() => {
  const vw = document.documentElement.clientWidth;
  const studio = document.querySelector('#forge-studio');
  const bad = [];
  studio.querySelectorAll('button, select, input, textarea, summary, label, .forge-ratio').forEach((node) => {
    if (node.closest('dialog') || node.offsetParent === null) return;
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return;
    if (box.left < -1 || box.right > vw + 1) bad.push((node.id || node.className || node.tagName) + ':' + Math.round(box.left) + '-' + Math.round(box.right));
  });
  const rect = (sel) => { const n = document.querySelector(sel); return n ? n.getBoundingClientRect().toJSON() : null; };
  const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
  return {
    scrollWidth: document.documentElement.scrollWidth, vw, bad,
    compose: rect('#forge-form'), side: rect('.forge-side'), bar: rect('#forge-actionbar'), gen: rect('#forge-generate'),
    navTop: nav.top, navBottomFixed: getComputedStyle(document.querySelector('.bottom-nav')).position === 'fixed',
    innerHeight: window.innerHeight,
    small: [...studio.querySelectorAll('button:not([hidden]), summary, .forge-tool')].filter((n) => n.offsetParent !== null && !n.closest('dialog') && !n.closest('.forge-help-pop')).map((n) => [n.id || n.textContent.trim().slice(0, 20), n.getBoundingClientRect().height]).filter((x) => x[1] > 0 && x[1] < 43.5)
  };
}"""


# On failure only: what sticks out past the viewport edge.
WIDE_PROBE = "() => [...document.querySelectorAll('body *')].filter((n) => n.getClientRects().length && n.getBoundingClientRect().right > document.documentElement.clientWidth + 1).slice(0, 6).map((n) => (n.id || n.className || n.tagName) + ':' + Math.round(n.getBoundingClientRect().right))"


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-forge-ux-"))
    vault = Path(tempfile.mkdtemp(prefix="hq-forge-ux-vault-"))
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
        assert base.startswith("http://127.0.0.1:") and not base.endswith((":8765", ":8766", ":8776", ":7860"))
        with sync_playwright() as playwright:
            browser_name = os.environ.get("FORGE_BROWSER", "chromium")
            browser = getattr(playwright, browser_name).launch()
            print("BROWSER", browser_name, browser.version)
            errors: list[str] = []
            requests: list[str] = []
            failed: list[str] = []

            def check(cond: bool, message: str) -> None:
                nonlocal passed
                if not cond:
                    if SOFT:
                        soft_failed.append(message)
                        print("  SOFT-FAIL", message)
                        return
                    raise SystemExit("FAIL: " + message)
                passed += 1
                print("  OK  ", message)

            def track(page):
                page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
                page.on("pageerror", lambda exc: errors.append("pageerror " + str(exc)))
                page.on("request", lambda request: requests.append(request.method + " " + request.url))
                page.on("response", lambda response: failed.append(str(response.status) + " " + response.url) if response.status >= 400 else None)

            admin = browser.new_context(bypass_csp=True)
            login = admin.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0)
            if login.status != 303:
                raise SystemExit("login failed")
            page = admin.new_page()
            page.set_viewport_size({"width": 1440, "height": 900})
            track(page)

            def open_forge(p):
                p.goto(base + "/")
                p.locator('.bottom-nav [data-nav="forge"]').click()
                p.wait_for_function("() => document.querySelector('#forge-checkpoint').value && !document.querySelector('#forge-generate').disabled", timeout=15000)

            def generate(p, prompt, steps):
                p.locator("#forge-prompt").fill(prompt)
                p.locator("#forge-steps").fill(str(steps))
                p.locator("#forge-steps").dispatch_event("change")
                before = p.locator("#forge-gallery .forge-card").count()
                p.locator("#forge-generate").click()
                p.wait_for_function("(n) => document.querySelectorAll('#forge-gallery .forge-card').length > n", arg=before, timeout=20000)
                p.wait_for_function("() => !document.querySelector('#forge-generate').disabled", timeout=15000)

            def no_job_post(p, action, label):
                fired = True
                try:
                    with p.expect_request(lambda r: r.method == "POST" and "/api/forge/jobs" in r.url, timeout=900):
                        action()
                except Exception:
                    fired = False
                check(not fired, label)

            open_forge(page)
            check(page.locator("#forge-last-prompt").is_visible() and page.locator("#forge-history-open").is_visible(), "Dernier prompt and Historique are next to the prompt")
            generate(page, "phare rouge au crépuscule", 12)
            generate(page, "forêt brumeuse, lumière douce", 18)

            # Dernier prompt
            page.locator("#forge-prompt").fill("")
            no_job_post(page, lambda: page.locator("#forge-last-prompt").click(), "Dernier prompt does not start a generation")
            check(page.locator("#forge-prompt").input_value() == "forêt brumeuse, lumière douce", "Dernier prompt restores the latest normal prompt")
            check("Rien n'est lancé" in page.locator("#forge-history-note").inner_text(), "restoring says nothing was generated")

            # Unsaved text is never silently replaced
            page.locator("#forge-prompt").fill("mon brouillon non envoyé")
            page.locator("#forge-last-prompt").click()
            check(page.locator("#forge-restore-confirm").is_visible(), "unsaved text triggers a confirmation")
            check(page.locator("#forge-prompt").input_value() == "mon brouillon non envoyé", "text is untouched before confirmation")
            check(page.evaluate("() => document.activeElement.id") == "forge-restore-replace", "confirmation takes focus")
            page.locator("#forge-restore-keep").click()
            check(page.locator("#forge-prompt").input_value() == "mon brouillon non envoyé", "Garder mon texte keeps the draft")
            page.locator("#forge-last-prompt").click()
            page.locator("#forge-restore-replace").click()
            check(page.locator("#forge-prompt").input_value() == "forêt brumeuse, lumière douce", "Remplacer swaps the draft explicitly")

            # Historique dialog
            page.locator("#forge-history-open").click()
            page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 2")
            check(page.evaluate("() => document.querySelector('#forge-history').open"), "history dialog opens")
            check(page.evaluate("() => document.activeElement.id") == "forge-history-search", "history focuses its search field")
            texts = page.locator("#forge-history-list .forge-history-text").all_inner_texts()
            check(texts[0].startswith("forêt") and texts[1].startswith("phare"), "history lists newest first")
            for _ in range(25):
                page.keyboard.press("Tab")
            check(page.evaluate("() => !!document.activeElement.closest('#forge-history')"), "Tab stays inside the history dialog")
            with page.expect_request(lambda r: "view=history" in r.url and "q=phare" in r.url, timeout=3000):
                page.locator("#forge-history-search").fill("phare")
            page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length === 1")
            check(page.locator("#forge-history-list li").count() == 1, "history search asks HQ to search the whole gallery")
            check("dans toute la galerie" in page.locator("#forge-history-state").inner_text(), "search result says it covers the whole gallery")
            page.locator("#forge-history-search").fill("introuvable-zzz")
            page.wait_for_function("() => /Aucun prompt/.test(document.querySelector('#forge-history-state').textContent)")
            check("Aucun prompt" in page.locator("#forge-history-state").inner_text(), "empty search is explained")
            page.locator("#forge-history-search").fill("")
            page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 2")
            page.keyboard.press("Escape")
            page.wait_for_function("() => !document.querySelector('#forge-history').open")
            check(page.evaluate("() => document.activeElement.id") == "forge-history-open", "Escape closes and returns focus")

            # Reuse parameters only
            page.locator("#forge-steps").fill("33")
            page.locator("#forge-steps").dispatch_event("change")
            page.locator("#forge-prompt").fill("forêt brumeuse, lumière douce")
            page.locator("#forge-history-open").click()
            page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 2")
            item = page.locator("#forge-history-list li", has_text="phare rouge")
            no_job_post(page, lambda: item.get_by_role("button", name="Réutiliser les paramètres").click(), "reusing parameters does not generate")
            check(page.locator("#forge-steps").input_value() == "12", "parameters are restored from the history entry")
            check(page.locator("#forge-prompt").input_value() == "forêt brumeuse, lumière douce", "reusing parameters keeps the prompt")
            check(page.locator("#forge-steps-range").input_value() == "12", "linked slider follows restored settings")
            page.locator("#forge-history-open").click()
            page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 2")
            page.locator("#forge-history-list li", has_text="phare rouge").get_by_role("button", name="Réutiliser le prompt").click()
            check(page.locator("#forge-prompt").input_value() == "phare rouge au crépuscule", "Réutiliser le prompt restores the prompt (previous text was already used)")

            # Viewer reuse path still works and goes through the same guard
            page.locator("#forge-prompt").fill("brouillon viewer")
            page.locator("#forge-gallery .forge-card").first.click()
            page.locator("#forge-viewer").wait_for(state="visible")
            page.locator("#forge-reuse").click()
            check(page.locator("#forge-restore-confirm").is_visible(), "gallery viewer reuse also protects a draft")
            page.locator("#forge-restore-replace").click()
            check(page.locator("#forge-prompt").input_value() == "forêt brumeuse, lumière douce", "gallery viewer reuse restores settings")

            # Reload: history is server-side, nothing about prompts in web storage
            page.reload()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
            page.locator("#forge-prompt").fill("")
            page.locator("#forge-last-prompt").click()
            page.wait_for_function("() => document.querySelector('#forge-prompt').value.length > 0")
            check(page.locator("#forge-prompt").input_value() == "forêt brumeuse, lumière douce", "Dernier prompt survives a reload (from the HQ gallery)")
            storage = page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
            check("phare" not in storage and "forêt" not in storage and "for\\u00eat" not in storage, "no prompt text in localStorage or sessionStorage")

            # Dernier prompt follows HQ job records: a failed submission with no image, across a reload
            page.locator("#forge-prompt").fill("envoi échoué mock-fail")
            page.locator("#forge-generate").click()
            page.wait_for_function("() => !document.querySelector('#forge-generate').disabled && document.querySelector('#forge-progress').hidden !== undefined && !/Envoi/.test(document.querySelector('#forge-progress-label').textContent)", timeout=20000)
            for _ in range(80):
                first = page.request.get(base + "/api/forge/jobs").json()["jobs"][0]
                if first["state"] not in ("queued", "starting", "generating", "saving"):
                    break
                page.wait_for_timeout(250)
            jobs = page.request.get(base + "/api/forge/jobs").json()["jobs"]
            check(jobs[0]["settings"].get("prompt") == "envoi échoué mock-fail" and not jobs[0]["images"], f"the failed submission is an HQ job without image ({jobs[0]['state']})")
            page.reload()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
            page.locator("#forge-prompt").fill("")
            page.locator("#forge-last-prompt").click()
            page.wait_for_function("() => document.querySelector('#forge-prompt').value.length > 0")
            check(page.locator("#forge-prompt").input_value() == "envoi échoué mock-fail", "Dernier prompt restores a failed submission after a reload")
            page.locator("#forge-history-open").click()
            page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 1")
            check("mock-fail" not in page.locator("#forge-history-list").inner_text(), "history lists gallery images only (the failed job has none)")
            page.locator("#forge-history-close").click()

            # Private mode isolation
            page.locator('input[name="forge-destination"][value="private"]').check()
            check(page.locator("#forge-last-prompt").is_disabled() and page.locator("#forge-history-open").is_disabled(), "private mode disables Dernier prompt and Historique")
            check("désactivés en génération privée" in page.locator("#forge-history-note").inner_text(), "private mode explains why")
            page.locator("#forge-prompt").fill("secret-prive-xyz")
            page.evaluate("() => document.querySelector('#forge-history-open').click()")
            check(not page.evaluate("() => document.querySelector('#forge-history').open"), "history cannot be opened in private mode")
            storage = page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
            check("secret-prive" not in storage, "a private prompt is not stored in web storage")
            page.locator('input[name="forge-destination"][value="normal"]').check()
            check(not page.locator("#forge-last-prompt").is_disabled(), "normal mode re-enables history")
            check(page.locator("#forge-history-note").inner_text() == "", "private explanation clears in normal mode")

            # Errors and loading
            page.route("**/api/forge/gallery?*", lambda route: route.fulfill(status=500, content_type="application/json", body=json.dumps({"error": "boom", "message": "La galerie n'a pas répondu."})))
            page.evaluate("() => window.hqForgeHide && window.hqForgeHide()")
            page.locator("#forge-history-open").click()
            page.wait_for_function("() => !/Chargement/.test(document.querySelector('#forge-history-state').textContent)")
            check(len(page.locator("#forge-history-state").inner_text()) > 0 and page.locator("#forge-history-list li").count() == 0, "history load failure is reported in the dialog")
            page.keyboard.press("Escape")
            page.unroute("**/api/forge/gallery?*")
            page.route("**/api/forge/jobs", lambda route: route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": "forge_busy", "message": "Forge est occupé."})) if route.request.method == "POST" else route.continue_())
            page.locator("#forge-prompt").fill("erreur attendue")
            page.locator("#forge-generate").click()
            page.wait_for_function("() => (document.querySelector('#forge-progress-label').textContent || '').length > 0 && !/Envoi/.test(document.querySelector('#forge-progress-label').textContent)")
            check(page.locator("#forge-progress-label").is_visible(), "generation error stays visible in the action bar")
            page.unroute("**/api/forge/jobs")

            # Layout preference
            page.locator("#forge-layout").select_option("compact")
            box = page.evaluate("() => [document.querySelector('#forge-form').getBoundingClientRect().bottom, document.querySelector('.forge-side').getBoundingClientRect().top]")
            check(box[1] >= box[0] - 1, "Compacte forces one column on desktop")
            page.reload()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            check(page.locator("#forge-layout").input_value() == "compact", "layout preference survives reload")
            page.locator("#forge-layout").select_option("auto")

            # Normal <-> private transitions never leak a private prompt
            SECRET = "secret-coffre-qq7"
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.locator("#forge-vault").wait_for()
            page.locator("#forge-vault-new").fill("synthetic horse battery")
            page.locator("#forge-vault-confirm").fill("synthetic horse battery")
            page.locator("#forge-vault-create").click()
            page.locator("#forge-vault-recovery-ok").click()
            page.locator("#forge-vault-pass").fill("synthetic horse battery")
            page.locator("#forge-vault-open").click()
            page.locator("#forge-vault-lock").wait_for()
            page.wait_for_function("() => !document.querySelector('#forge-generate-private').disabled", timeout=15000)
            page.locator("#forge-prompt").fill(SECRET)
            page.locator("#forge-generate-private").click()
            job0 = {}
            for _ in range(80):
                job0 = page.evaluate("async () => (await (await fetch('/api/forge/jobs', {credentials: 'same-origin'})).json()).jobs[0] || {}")
                if job0.get("destination") == "private" and job0.get("state") in ("completed", "failed", "cancelled", "unknown"):
                    break
                page.wait_for_timeout(250)
            check(job0["destination"] == "private" and job0["state"] == "completed" and job0["settings"] == {}, f"private job completed and the job list hides its settings {json.dumps(job0)[:300]} / {page.locator('#forge-progress-label').inner_text()} / {page.locator('#forge-generate-reason').inner_text()}")
            page.locator('input[name="forge-destination"][value="normal"]').check()
            page.locator("#forge-prompt").fill("")
            page.locator("#forge-last-prompt").click()
            page.wait_for_function("() => document.querySelector('#forge-prompt').value.length > 0 || /Aucun/.test(document.querySelector('#forge-history-note').textContent)")
            check(SECRET not in page.locator("#forge-prompt").input_value(), "Dernier prompt (in-page) never returns the private prompt")
            page.reload()
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => document.querySelector('#forge-checkpoint').value")
            page.locator('input[name="forge-destination"][value="normal"]').check()
            page.locator("#forge-prompt").fill("")
            page.locator("#forge-last-prompt").click()
            page.wait_for_function("() => document.querySelector('#forge-prompt').value.length > 0")
            check(SECRET not in page.locator("#forge-prompt").input_value(), "Dernier prompt after reload skips the private job")
            for path in ("/api/forge/jobs", "/api/forge/gallery?view=history&limit=50", "/api/forge/gallery?view=history&q=" + SECRET, "/api/forge/gallery?limit=50"):
                text = page.request.get(base + path).text()
                check(SECRET not in text, f"{path} never contains the private prompt (vault unlocked)")
            page.locator("#forge-history-open").click()
            page.locator("#forge-history-search").fill(SECRET)
            page.wait_for_function("() => /Aucun prompt/.test(document.querySelector('#forge-history-state').textContent)")
            check(page.locator("#forge-history-list li").count() == 0, "history search cannot find the private prompt")
            page.locator("#forge-history-search").fill("")
            page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 1")
            page.locator("#forge-history-close").click()
            storage = page.evaluate("() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
            check(SECRET not in storage, "the private prompt is not in web storage")
            page.locator('input[name="forge-destination"][value="private"]').check()
            page.locator("#forge-vault-lock").click()
            page.locator("#forge-vault-pass").wait_for()
            text = page.request.get(base + "/api/forge/jobs").text()
            check(SECRET not in text, "job list never contains the private prompt (vault locked)")
            page.locator('input[name="forge-destination"][value="normal"]').check()

            # Responsive matrix
            for width, height, name in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                # Park the pointer: after a resize it can land on an "Aide" button, and its hover tooltip
                # (absolute, width min(42ch,70vw)) then widens the page. That is hover, not layout.
                page.mouse.move(0, 0)
                page.wait_for_timeout(150)
                page.evaluate("() => window.scrollTo(0, 0)")
                top = page.evaluate(LAYOUT_PROBE)
                if SHOTS:
                    page.screenshot(path=str(SHOTS / f"ux-{name}.png"))
                    page.screenshot(path=str(SHOTS / f"ux-{name}-full.png"), full_page=True)
                # measure where the user works: prompt at the top of the screen
                page.evaluate("() => document.querySelector('#forge-form').scrollIntoView({block: 'start'})")
                m = page.evaluate(LAYOUT_PROBE)
                check(top["scrollWidth"] <= top["vw"] + 1, f"{name}: no horizontal overflow at the top of the page ({top['scrollWidth']} <= {top['vw']}, wide: {page.evaluate(WIDE_PROBE) if top['scrollWidth'] > top['vw'] + 1 else []})")
                check(m["scrollWidth"] <= m["vw"] + 1, f"{name}: no horizontal overflow ({m['scrollWidth']} <= {m['vw']})")
                check(not m["bad"], f"{name}: no clipped controls {m['bad'][:4]}")
                check(m["gen"]["height"] >= 44 and m["gen"]["width"] >= 44, f"{name}: Générer meets the touch size")
                check(not m["small"], f"{name}: touch targets >= 44px {m['small'][:4]}")
                studio_w = page.evaluate("() => document.querySelector('#forge-studio').getBoundingClientRect().width")
                two = m["side"]["left"] >= m["compose"]["right"] - 1
                if studio_w >= 760:
                    check(two, f"{name}: two columns at studio width {round(studio_w)}")
                else:
                    check(not two and m["side"]["top"] >= m["compose"]["bottom"] - 1, f"{name}: one column at studio width {round(studio_w)}")
                fab = page.evaluate("() => { const f = document.querySelector('.hq-capture-fab'); if (!f || getComputedStyle(f).display === 'none' || getComputedStyle(f).visibility === 'hidden') return null; const a = f.getBoundingClientRect(); return [a.left, a.top, a.right, a.bottom]; }")
                if fab:
                    for sel in ("#forge-generate", "#forge-cancel"):
                        b = page.evaluate("(s) => { const r = document.querySelector(s).getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }", sel)
                        overlap = not (fab[2] <= b[0] or fab[0] >= b[2] or fab[3] <= b[1] or fab[1] >= b[3])
                        check(not overlap, f"{name}: the HQ capture button does not cover {sel}")
                if height <= 500:
                    check(m["bar"]["height"] <= 60, f"{name}: slim action bar on a short screen ({round(m['bar']['height'])}px)")
                if m["navBottomFixed"]:
                    check(m["bar"]["bottom"] <= m["navTop"] + 1, f"{name}: sticky Générer sits above the bottom nav ({round(m['bar']['bottom'])} <= {round(m['navTop'])}, vh {m['innerHeight']})")
                # the focused prompt is never under the sticky bar
                page.locator("#forge-prompt").focus()
                page.locator("#forge-prompt").scroll_into_view_if_needed()
                pr = page.evaluate("() => [document.querySelector('#forge-prompt').getBoundingClientRect().toJSON(), document.querySelector('#forge-actionbar').getBoundingClientRect().toJSON()]")
                check(pr[0]["bottom"] <= pr[1]["top"] + 1 or pr[0]["top"] >= pr[1]["bottom"] - 1, f"{name}: action bar does not cover the prompt")
                if SHOTS:
                    page.screenshot(path=str(SHOTS / f"ux-{name}-working.png"))
            # Capturer (HQ quick capture) inside Forge Studio: header button, floating launcher hidden here only
            CAP_PROBE = """() => {
  const cap = document.querySelector('#forge-capture');
  const fab = document.querySelector('#hq-capture-fab');
  const r = (n) => { const b = n.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; };
  const hit = (a, b) => !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);
  const c = r(cap);
  const hits = [];
  document.querySelectorAll('#forge-studio button, #forge-studio select, #forge-studio input, #forge-studio textarea, #forge-studio summary, #forge-studio label, #forge-studio .forge-ratio').forEach((n) => {
    if (n === cap || n.closest('dialog') || n.offsetParent === null || n.closest('.forge-help-pop')) return;
    if (n.closest('.forge-head-tools') && !n.closest('.forge-layout-pick')) return;
    const b = r(n); if (b[2] - b[0] === 0) return;
    // a control scrolled out of an overflow box (the sticky settings column) is clipped, not visible: use its visible part
    for (let a = n.parentElement; a && a !== document.body; a = a.parentElement) {
      const o = getComputedStyle(a); if (o.overflowY === 'visible' && o.overflowX === 'visible') continue;
      const k = r(a); b[0] = Math.max(b[0], k[0]); b[1] = Math.max(b[1], k[1]); b[2] = Math.min(b[2], k[2]); b[3] = Math.min(b[3], k[3]);
    }
    if (b[2] <= b[0] || b[3] <= b[1]) return;
    if (!hit(c, b)) return;
    const x = (Math.max(c[0], b[0]) + Math.min(c[2], b[2])) / 2, y = (Math.max(c[1], b[1]) + Math.min(c[3], b[3])) / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return;
    const e = document.elementFromPoint(x, y);
    if (e && (e === cap || cap.contains(e))) hits.push(n.id || n.className || n.tagName); // Capturer painted over a Forge control
  });
  const fixed = [];
  document.querySelectorAll('body *').forEach((n) => {
    const s = getComputedStyle(n);
    if ((s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none' && s.visibility !== 'hidden' && n.offsetParent !== null || (s.position === 'fixed' && s.display !== 'none' && n.getClientRects().length)) {
      if (n.contains(cap) || n.closest('dialog') || n.closest('.forge-side')) return;
      const b = r(n); if (!hit(c, b)) return;
      const x = (Math.max(c[0], b[0]) + Math.min(c[2], b[2])) / 2, y = (Math.max(c[1], b[1]) + Math.min(c[3], b[3])) / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return;
      const e = document.elementFromPoint(x, y);
      if (e && (e === cap || cap.contains(e))) fixed.push(n.id || n.className || n.tagName); // Capturer over the sticky bar / nav
    }
  });
  const vis = c[3] > 0 && c[1] < innerHeight;
  const ce = document.elementFromPoint(Math.min(Math.max((c[0] + c[2]) / 2, 0), innerWidth - 1), Math.min(Math.max((c[1] + c[3]) / 2, 0), innerHeight - 1));
  const top = !!ce && (ce === cap || cap.contains(ce));
  return { cap: c, w: c[2] - c[0], h: c[3] - c[1], shown: !cap.hidden && getComputedStyle(cap).display !== 'none', vis, top,
    fabShown: !!fab && getComputedStyle(fab).display !== 'none', hits, fixed,
    bar: r(document.querySelector('#forge-actionbar')), nav: r(document.querySelector('.bottom-nav')) };
}"""
            page.set_viewport_size({"width": 1440, "height": 900})
            page.locator('.bottom-nav [data-nav="accueil"]').click()
            page.wait_for_timeout(200)
            fab_home = page.evaluate("() => { const f = document.querySelector('#hq-capture-fab'); const s = getComputedStyle(f); return [s.display, s.position, s.bottom, s.right, f.getBoundingClientRect().toJSON()]; }")
            check(fab_home[0] != "none" and fab_home[1] == "fixed", "outside Forge Studio the floating Capturer is shown and fixed")
            page.evaluate("() => { window.__capOpens = 0; const o = window.hqCapture.open; window.hqCapture.open = function () { window.__capOpens++; return o.apply(this, arguments); }; }")
            for _ in range(4):
                page.locator('.bottom-nav [data-nav="forge"]').click()
                page.wait_for_timeout(80)
                page.locator('.bottom-nav [data-nav="accueil"]').click()
                page.wait_for_timeout(80)
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => !document.querySelector('#forge-capture').hidden", timeout=15000)
            check(page.locator("#forge-capture").is_visible() and page.get_by_role("button", name="Capturer").count() >= 1, "Forge Studio shows its own Capturer button")
            check(page.evaluate("() => getComputedStyle(document.querySelector('#hq-capture-fab')).display") == "none", "the floating Capturer is hidden in Forge Studio")
            page.locator("#forge-capture").click()
            page.locator("#hq-capture").wait_for(state="visible")
            check(page.evaluate("() => window.__capOpens") == 1, "one click opens the capture sheet once after repeated view switches (no duplicate listener)")
            check(page.locator("#forge-capture").get_attribute("aria-expanded") == "true", "Capturer reports the open sheet (aria-expanded)")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "cap-1440-sheet-open.png"))
            page.locator("#hq-capture-text").fill("note capturée depuis Forge")
            page.locator("#hq-capture-save").click()
            page.wait_for_function("() => document.querySelector('#hq-capture').hidden", timeout=15000)
            check("Captur" in page.locator("#hq-capture-toast").inner_text(), "a note captured from Forge Studio is saved by the same capture flow")
            check(page.evaluate("() => document.activeElement && document.activeElement.id") == "forge-capture", "focus returns to the Forge Capturer button")
            check(page.locator("#forge-capture").get_attribute("aria-expanded") == "false", "Capturer reports the closed sheet")
            page.locator("#forge-capture").focus()
            page.keyboard.press("Enter")
            page.locator("#hq-capture").wait_for(state="visible")
            page.keyboard.press("Escape")
            page.wait_for_function("() => document.querySelector('#hq-capture').hidden")
            check(page.evaluate("() => document.activeElement.id") == "forge-capture", "keyboard: Enter opens, Escape closes, focus comes back")
            page.evaluate("() => { const t = document.querySelector('#hq-capture-toast'); if (t) t.hidden = true; }")
            for width, height, name in VIEWPORTS:
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(120)
                for adv in (False, True):
                    page.evaluate("(o) => ['forge-advanced', 'forge-sampling', 'forge-seed-fold', 'forge-hr-fold'].forEach((id) => { const d = document.getElementById(id); if (d) d.open = o; })", adv)
                    for pos in ("top", "prompt", "advanced", "bottom"):
                        if pos == "top":
                            page.evaluate("() => window.scrollTo({top: 0, behavior: 'instant'})")
                        elif pos == "prompt":
                            page.evaluate("() => document.querySelector('#forge-form').scrollIntoView({block: 'start', behavior: 'instant'})")
                        elif pos == "advanced":
                            page.evaluate("() => document.querySelector('#forge-advanced').scrollIntoView({block: 'center', behavior: 'instant'})")
                        else:
                            page.evaluate("() => window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'})")
                        page.wait_for_timeout(60)
                        c = page.evaluate(CAP_PROBE)
                        tag = f"{name}{' adv' if adv else ''} @{pos}"
                        check(c["shown"] and not c["fabShown"], f"{tag}: header Capturer shown, floating one hidden")
                        check(not c["hits"], f"{tag}: Capturer is never painted over a Forge control {c['hits'][:4]}")
                        check(not c["fixed"], f"{tag}: Capturer is never painted over the sticky bar or bottom nav {c['fixed'][:4]}")
                        if pos == "top":
                            check(c["w"] >= 44 and c["h"] >= 44, f"{tag}: Capturer target >= 44px ({round(c['w'])}x{round(c['h'])})")
                            check(c["vis"] and c["cap"][0] >= 0 and c["cap"][2] <= width + 1, f"{tag}: Capturer fully on screen")
                            check(c["top"], f"{tag}: nothing covers the Capturer at the top of the page")
                            g = page.evaluate("() => { const b = document.querySelector('#forge-generate'); const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === b || b.contains(e)); }")
                            check(g, f"{tag}: Générer is reachable (nothing on top of it)")
                        if SHOTS and pos in ("top", "advanced") and (adv or pos == "top"):
                            page.screenshot(path=str(SHOTS / f"cap-{name}{'-adv' if adv else ''}-{pos}.png"))
                page.evaluate("() => ['forge-advanced', 'forge-sampling', 'forge-seed-fold', 'forge-hr-fold'].forEach((id) => { const d = document.getElementById(id); if (d) d.open = false; })")
                page.evaluate("() => window.scrollTo(0, 0)")
                m = page.evaluate(LAYOUT_PROBE)
                check(m["scrollWidth"] <= m["vw"] + 1 and not m["bad"], f"{name}: no horizontal overflow with the Capturer in the header")
                check(not m["small"], f"{name}: touch targets >= 44px with Capturer {m['small'][:4]}")
                hd = page.evaluate("() => { const r = (s) => document.querySelector(s).getBoundingClientRect(); const a = r('#forge-studio .forge-head > h1'), b = r('.forge-head-tools'), st = r('#forge-status'); const hit = (x, y) => !(x.right <= y.left || x.left >= y.right || x.bottom <= y.top || x.top >= y.bottom); return [hit(a, b), hit(b, st), document.querySelector('#forge-studio .forge-head > h1').scrollWidth <= Math.ceil(a.width) + 1]; }")
                check(not hd[0] and not hd[1] and hd[2], f"{name}: header title, Disposition/Capturer and status do not overlap {hd}")
                page.locator("#forge-history-open").click()
                page.wait_for_function("() => document.querySelector('#forge-history').open")
                page.wait_for_timeout(350)
                top_ok = page.evaluate("""() => {
  const d = document.querySelector('#forge-history'); const r = d.getBoundingClientRect();
  const pts = [[r.left + 8, r.top + 8], [r.right - 8, r.top + 8], [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
  const fab = document.querySelector('#hq-capture-fab');
  return { ok: pts.every(([x, y]) => { const e = document.elementFromPoint(Math.min(Math.max(x, 0), innerWidth - 1), Math.min(Math.max(y, 0), innerHeight - 1)); return !!e && d.contains(e); }), fab: getComputedStyle(fab).display };
}""")
                check(top_ok["ok"] and top_ok["fab"] == "none", f"{name}: History is on top, no floating control above it")
                if SHOTS and name in ("320-portrait", "375-landscape", "1440-desktop"):
                    page.screenshot(path=str(SHOTS / f"cap-{name}-history.png"))
                page.keyboard.press("Escape")
                page.wait_for_function("() => !document.querySelector('#forge-history').open")
            # on-screen keyboard emulation: the --hq-kb lift never brings the floating launcher back in Forge
            page.set_viewport_size({"width": 390, "height": 844})
            page.evaluate("() => document.documentElement.style.setProperty('--hq-kb', '300px')")
            page.locator("#forge-prompt").focus()
            check(page.evaluate("() => getComputedStyle(document.querySelector('#hq-capture-fab')).display") == "none", "390: with a keyboard inset the floating Capturer stays hidden in Forge")
            page.evaluate("() => document.documentElement.style.removeProperty('--hq-kb')")
            page.set_viewport_size({"width": 1440, "height": 900})
            page.locator('.bottom-nav [data-nav="accueil"]').click()
            page.wait_for_timeout(200)
            fab_back = page.evaluate("() => { const f = document.querySelector('#hq-capture-fab'); const s = getComputedStyle(f); return [s.display, s.position, s.bottom, s.right, f.getBoundingClientRect().toJSON()]; }")
            check(fab_back == fab_home, "leaving Forge Studio restores the floating Capturer exactly")
            page.locator("#hq-capture-fab").click()
            page.locator("#hq-capture").wait_for(state="visible")
            check(page.locator("#hq-capture").is_visible() and page.locator("#hq-capture-fab").get_attribute("aria-expanded") == "true", "the floating Capturer still opens the capture sheet elsewhere")
            page.keyboard.press("Escape")
            page.wait_for_function("() => document.querySelector('#hq-capture').hidden")
            for width, height, name in ((375, 667, "375"), (667, 375, "375-landscape")):
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(120)
                if SHOTS:
                    page.screenshot(path=str(SHOTS / f"cap-other-section-{name}.png"))
            page.locator('.bottom-nav [data-nav="forge"]').click()
            page.wait_for_function("() => !document.querySelector('#forge-generate').disabled", timeout=15000)

            # Aide tooltips stay inside the viewport (hover, keyboard focus, click/tap), every tooltip in Forge Studio
            HELP_PROBE = """(id) => {
  const pop = document.getElementById(id);
  const r = pop.getBoundingClientRect();
  const de = document.documentElement;
  return { shown: getComputedStyle(pop).display !== 'none' && r.width > 0, l: r.left, r: r.right, t: r.top, b: r.bottom,
    vw: de.clientWidth, vh: innerHeight, sw: de.scrollWidth };
}"""
            FOLD_IDS = ["forge-negative-fold", "forge-sampling", "forge-cfg-fold", "forge-seed-fold", "forge-advanced", "forge-batch-fold", "forge-hr-fold", "forge-presets"]

            def help_ids(p):
                p.evaluate("(ids) => ids.forEach((id) => { const d = document.getElementById(id); if (d) d.open = true; })", FOLD_IDS)
                return p.evaluate("() => [...document.querySelectorAll('#forge-studio .forge-help')].filter((b) => b.offsetParent !== null && !b.closest('dialog')).map((b) => [b.id || '', b.getAttribute('aria-controls')])")

            def help_ok(p, pop_id, tag):
                h = p.evaluate(HELP_PROBE, pop_id)
                check(h["shown"], f"{tag}: tooltip {pop_id} opens")
                check(h["sw"] <= h["vw"] + 1, f"{tag}: tooltip {pop_id} causes no horizontal overflow ({round(h['sw'])} <= {h['vw']}) {p.evaluate(WIDE_PROBE) if h['sw'] > h['vw'] + 1 else ''}")
                check(h["l"] >= -0.5 and h["r"] <= h["vw"] + 0.5 and h["t"] >= -0.5 and h["b"] <= h["vh"] + 0.5, f"{tag}: tooltip {pop_id} fully inside the viewport ({round(h['l'])},{round(h['t'])})-({round(h['r'])},{round(h['b'])}) in {h['vw']}x{h['vh']}")

            def reset_help(p):
                p.evaluate("() => { document.querySelectorAll('#forge-studio .forge-help-wrap.is-open').forEach((w) => { w.classList.remove('is-open'); const b = w.querySelector('.forge-help'); if (b) b.setAttribute('aria-expanded', 'false'); }); if (document.activeElement) document.activeElement.blur(); }")
                p.mouse.move(0, 0)

            for width, height, name in ((320, 640, "320-portrait"), (375, 667, "375-portrait"), (667, 375, "375-landscape"), (1440, 900, "1440-desktop")):
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(120)
                ids = help_ids(page)
                check(len(ids) >= 10, f"{name}: Aide buttons found ({len(ids)})")
                for idx, (_bid, pop_id) in enumerate(ids):
                    sel = f"#forge-studio .forge-help[aria-controls='{pop_id}']"
                    btn = page.locator(sel)
                    page.evaluate("(s) => document.querySelector(s).scrollIntoView({block: 'center', behavior: 'instant'})", sel)
                    reset_help(page)
                    box = btn.bounding_box()
                    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                    page.wait_for_timeout(30)
                    help_ok(page, pop_id, f"{name} hover")
                    if SHOTS and pop_id == "forge-help-private" and width <= 375:
                        page.screenshot(path=str(SHOTS / f"help-{name}-private-hover.png"))
                    reset_help(page)
                    btn.focus()
                    help_ok(page, pop_id, f"{name} focus")
                    page.keyboard.press("Enter")
                    check(btn.get_attribute("aria-expanded") == "true", f"{name}: Enter toggles {pop_id} (aria-expanded)")
                    help_ok(page, pop_id, f"{name} keyboard open")
                    reset_help(page)
                    btn.click()
                    page.mouse.move(0, 0)
                    help_ok(page, pop_id, f"{name} click")
                    reset_help(page)
                page.evaluate("(ids) => ids.forEach((id) => { const d = document.getElementById(id); if (d) d.open = false; })", FOLD_IDS)
                page.evaluate("() => window.scrollTo({top: 0, behavior: 'instant'})")
            page.set_viewport_size({"width": 1440, "height": 900})

            touch_opts = {"is_mobile": True} if browser_name != "firefox" else {}
            for width, height, name in ((320, 640, "320"), (375, 667, "375")):
                ctx = browser.new_context(bypass_csp=True, viewport={"width": width, "height": height}, has_touch=True, device_scale_factor=2, **touch_opts)
                ctx.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0)
                tpp = ctx.new_page()
                track(tpp)
                open_forge(tpp)
                ids = help_ids(tpp)
                for _bid, pop_id in ids:
                    sel = f"#forge-studio .forge-help[aria-controls='{pop_id}']"
                    tpp.evaluate("(s) => document.querySelector(s).scrollIntoView({block: 'center', behavior: 'instant'})", sel)
                    tpp.locator(sel).tap()
                    help_ok(tpp, pop_id, f"touch {name} tap")
                    if SHOTS and pop_id == "forge-help-private":
                        tpp.screenshot(path=str(SHOTS / f"help-touch-{name}-private.png"))
                    tpp.locator(sel).tap()
                    check(tpp.locator(sel).get_attribute("aria-expanded") == "false", f"touch {name}: second tap closes {pop_id}")
                    tpp.evaluate("() => document.activeElement && document.activeElement.blur()")
                ctx.close()

            # Aide tooltips next to the sticky bar / bottom nav, and at the top edge (flip below)
            EDGE_PROBE = """(id) => {
  const pop = document.getElementById(id);
  const r = pop.getBoundingClientRect();
  const hit = (b) => !(r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom);
  const blocks = [];
  ['#forge-actionbar', '.bottom-nav'].forEach((s) => { const n = document.querySelector(s); if (n && n.getClientRects().length && !n.contains(pop) && hit(n.getBoundingClientRect())) blocks.push(s); });
  // corners inset past the 10px border radius
  const pts = [[r.left + 8, r.top + 8], [r.right - 8, r.top + 8], [r.left + 8, r.bottom - 8], [r.right - 8, r.bottom - 8], [(r.left + r.right) / 2, (r.top + r.bottom) / 2]];
  const hidden = pts.filter(([x, y]) => { const e = document.elementFromPoint(x, y); return !e || !(e === pop || pop.contains(e)); }).map(([x, y]) => { const e = document.elementFromPoint(x, y); return Math.round(x) + ',' + Math.round(y) + ':' + (e ? (e.id || e.className || e.tagName) : 'none'); });
  return { shown: getComputedStyle(pop).display !== 'none' && r.width > 0, below: pop.classList.contains('is-below'), blocks, hidden,
    inView: r.left >= -0.5 && r.right <= document.documentElement.clientWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
    sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] };
}"""
            PLACE_TRIGGER = """([sel, where]) => {
  const b = document.querySelector(sel);
  b.scrollIntoView({block: 'center', behavior: 'instant'});
  const limits = ['#forge-actionbar', '.bottom-nav'].map((s) => document.querySelector(s)).filter((n) => n && n.getClientRects().length && !n.contains(b)).map((n) => n.getBoundingClientRect().top).filter((t) => t > 0 && t <= innerHeight);
  const floor = limits.length ? Math.min(...limits) : innerHeight;
  const r = b.getBoundingClientRect();
  const side = b.closest('.forge-side');
  const target = where === 'bottom' ? floor - 6 - r.bottom : 70 - r.top;
  const sc = side && side.scrollHeight > side.clientHeight + 1 ? side : null;
  if (sc) sc.scrollBy(0, -target); else window.scrollBy(0, -target);
  if (sc) { const r2 = b.getBoundingClientRect(); const t2 = where === 'bottom' ? floor - 6 - r2.bottom : 70 - r2.top; window.scrollBy(0, -t2); }
  const f = b.getBoundingClientRect();
  return [Math.round(f.top), Math.round(f.bottom), Math.round(floor)];
}"""
            flips = 0
            edge_cases = 0
            for width, height, name in ((320, 640, "320-portrait"), (375, 667, "375-portrait"), (667, 375, "375-landscape"), (844, 390, "390-landscape"), (1440, 900, "1440-desktop")):
                page.set_viewport_size({"width": width, "height": height})
                page.wait_for_timeout(120)
                ids = help_ids(page)
                for _bid, pop_id in ids:
                    sel = f"#forge-studio .forge-help[aria-controls='{pop_id}']"
                    for where in ("bottom", "top"):
                        reset_help(page)
                        pos = page.evaluate(PLACE_TRIGGER, [sel, where])
                        if pos[0] < 0 or pos[1] > height:
                            continue  # cannot be scrolled there (page start/end): nothing to test at this edge
                        for mode in ("focus", "hover"):
                            reset_help(page)
                            if mode == "focus":
                                page.locator(sel).focus()
                            else:
                                bb = page.locator(sel).bounding_box()
                                page.mouse.move(bb["x"] + bb["width"] / 2, bb["y"] + bb["height"] / 2)
                            page.wait_for_timeout(20)
                            e = page.evaluate(EDGE_PROBE, pop_id)
                            edge_cases += 1
                            flips += 1 if e["below"] else 0
                            tag = f"{name} {where} {mode} {pop_id}"
                            check(e["shown"] and not e["blocks"] and e["inView"] and not e["hidden"] and e["sw"] <= e["vw"] + 1,
                                  f"{tag}: tooltip clear of the sticky bar and nav, fully visible (trigger {pos}) {e}")
                            if SHOTS and pop_id in ("forge-help-steps", "forge-help-private", "forge-help-hr-denoise") and mode == "focus" and width < 900:
                                page.screenshot(path=str(SHOTS / f"edge-{name}-{where}-{pop_id}.png"))
                reset_help(page)
                page.evaluate("(ids) => ids.forEach((id) => { const d = document.getElementById(id); if (d) d.open = false; })", FOLD_IDS)
                page.evaluate("() => { window.scrollTo({top: 0, behavior: 'instant'}); const s = document.querySelector('.forge-side'); if (s) s.scrollTop = 0; }")
            check(edge_cases > 100 and flips > 0, f"edge placements tested ({edge_cases}), some flipped below ({flips})")
            page.set_viewport_size({"width": 1440, "height": 900})

            # Completed generation: auto-scroll only when the user stayed idle, otherwise "Voir le résultat"
            page.set_viewport_size({"width": 390, "height": 844})
            page.wait_for_timeout(150)

            def run_job(prompt, during=None):
                page.evaluate("() => window.scrollTo({top: 0, behavior: 'instant'})")
                page.locator("#forge-prompt").fill(prompt)
                page.mouse.move(0, 0)
                page.evaluate("() => document.activeElement && document.activeElement.blur()")
                page.wait_for_timeout(100)
                before = page.locator("#forge-gallery .forge-card").count()
                page.locator("#forge-generate").click()
                page.wait_for_function("() => document.querySelector('#forge-generate').disabled || !document.querySelector('#forge-progress').hidden", timeout=5000)
                if during:
                    during()
                y0 = page.evaluate("() => scrollY")
                page.wait_for_function("(n) => document.querySelectorAll('#forge-gallery .forge-card').length > n", arg=before, timeout=20000)
                page.wait_for_function("() => !document.querySelector('#forge-generate').disabled", timeout=15000)
                page.wait_for_timeout(900)
                res = page.evaluate("() => { const r = document.querySelector('#forge-normal-results').getBoundingClientRect(); const b = document.querySelector('#forge-see-result'); return { top: r.top, y: scrollY, see: !!b && !b.hidden && b.getBoundingClientRect().height > 0 }; }")
                res["y0"] = y0
                return res

            r = run_job("idle mock")
            check(-2 <= r["top"] < 844 * 0.5 and r["y"] > r["y0"] + 50 and not r["see"], f"idle: the finished result is scrolled into view (top {round(r['top'])}, scrollY {r['y0']} -> {r['y']}) without the chip")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "result-idle-390.png"))

            def typing():
                page.locator("#forge-negative-fold > summary").click()
                page.locator("#forge-negative").click()
                page.keyboard.type("flou", delay=20)

            def setting():
                page.locator("#forge-steps").fill("21")

            def wheel():
                page.mouse.move(195, 400)
                page.mouse.wheel(0, 220)
                page.wait_for_timeout(200)

            for label, act in (("typing", typing), ("settings change", setting), ("user scroll", wheel)):
                r = run_job("busy mock " + label, act)
                check(abs(r["y"] - r["y0"]) < 6, f"{label}: no jump to the result while the user was busy (scrollY {r['y0']} -> {r['y']})")
                check(r["see"], f"{label}: 'Voir le résultat' is offered instead")
                if r["see"]:
                    ov = page.evaluate("""() => {
  const a = document.querySelector('#forge-see-result').getBoundingClientRect();
  const hit = (b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  const bad = [];
  ['#forge-generate', '#forge-cancel', '#forge-capture', '.bottom-nav', '#forge-generate-private', '#forge-generate-reason', '#forge-progress'].forEach((s) => { const n = document.querySelector(s); if (n && n.offsetParent !== null && hit(n.getBoundingClientRect())) bad.push(s); });
  const e = document.elementFromPoint((a.left + a.right) / 2, (a.top + a.bottom) / 2);
  return { bad, top: !!e && (e.id === 'forge-see-result' || !!e.closest('#forge-see-result')), h: a.height, w: a.width, inView: a.top >= 0 && a.bottom <= innerHeight && a.left >= 0 && a.right <= innerWidth };
}""")
                    check(not ov["bad"] and ov["top"] and ov["inView"] and ov["h"] >= 44, f"{label}: the chip is visible, >= 44px and overlaps no control {ov}")
                    if SHOTS and label == "typing":
                        page.screenshot(path=str(SHOTS / "result-chip-390.png"))
                    if label == "typing":
                        f = page.evaluate("() => { const a = document.activeElement; return [a && a.id, a && a.selectionStart, a && a.selectionEnd, a && a.value.length]; }")
                        check(f[0] == "forge-negative" and f[1] == f[2] == f[3], f"typing: the chip does not steal focus or move the caret {f}")
                        y1 = page.evaluate("() => scrollY")
                        page.keyboard.type(" net", delay=15)
                        check(page.locator("#forge-negative").input_value().endswith("flou net") and abs(page.evaluate("() => scrollY") - y1) < 6, "typing: the next words go on uninterrupted, no scroll")
                    if label == "user scroll":
                        page.evaluate("() => document.querySelector('#forge-normal-results').scrollIntoView({block: 'center', behavior: 'instant'})")
                        page.wait_for_timeout(400)
                        check(page.evaluate("() => document.querySelector('#forge-see-result').hidden"), "user scroll: the chip goes away once the result is on screen")
                    else:
                        page.locator("#forge-see-result").click()
                        page.wait_for_timeout(900)
                        after = page.evaluate("() => [document.querySelector('#forge-normal-results').getBoundingClientRect().top, document.querySelector('#forge-see-result').hidden]")
                        check(-2 <= after[0] < 844 * 0.5 and after[1], f"{label}: tapping the chip shows the result and dismisses the chip (top {round(after[0])})")
            # Result already mostly on screen but scrolled past its top: no chip lingers
            r = run_job("busy mock partial", lambda: (page.mouse.move(195, 400), page.mouse.wheel(0, 30)))
            page.evaluate("() => { const r = document.querySelector('#forge-normal-results'); window.scrollTo({top: scrollY + r.getBoundingClientRect().top + 40, behavior: 'instant'}); }")
            page.wait_for_timeout(300)
            check(page.evaluate("() => document.querySelector('#forge-see-result').hidden"), "result partly visible (top scrolled past): chip hidden")
            page.locator("#forge-steps").fill("20")
            page.locator("#forge-negative").fill("")
            page.set_viewport_size({"width": 1440, "height": 900})

            for width, height, name in ((390, 844, "390"), (1440, 900, "1440")):
                page.set_viewport_size({"width": width, "height": height})
                page.locator("#forge-history-open").click()
                page.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 1")
                page.wait_for_timeout(400)  # let the open animation finish
                d = page.evaluate("() => { const r = document.querySelector('#forge-history').getBoundingClientRect(); return [r.left, r.right, r.top, r.bottom, innerWidth, innerHeight]; }")
                check(d[0] >= -1 and d[1] <= d[4] + 1 and d[3] <= d[5] + 1, f"history {name}: panel fits the screen {d}")
                if width < 900:
                    check(d[3] >= d[5] - 2 and d[2] > 0, "history 390: bottom sheet anchored to the bottom")
                else:
                    check(d[1] >= d[4] - 2 and d[0] > d[4] / 2, "history 1440: drawer on the right")
                if SHOTS:
                    page.screenshot(path=str(SHOTS / f"ux-history-{name}.png"))
                page.keyboard.press("Escape")

            # Sticky bar never covers the confirmation box on a phone
            page.set_viewport_size({"width": 375, "height": 667})
            page.locator("#forge-prompt").fill("brouillon téléphone")
            page.locator("#forge-last-prompt").click()
            page.locator("#forge-restore-replace").scroll_into_view_if_needed()
            r = page.evaluate("() => [document.querySelector('#forge-restore-confirm').getBoundingClientRect().bottom, document.querySelector('#forge-actionbar').getBoundingClientRect().top]")
            check(r[0] <= r[1] + 1, "375: confirmation is not under the sticky bar")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "ux-375-confirm.png"))
            page.locator("#forge-restore-keep").click()

            # Reduced motion
            page.emulate_media(reduced_motion="reduce")
            page.locator("#forge-history-open").click()
            anim = page.evaluate("() => getComputedStyle(document.querySelector('#forge-history')).animationName")
            check(anim in ("none", ""), "reduced motion removes the sheet animation")
            page.keyboard.press("Escape")

            # Touch device emulation (not physical hardware)
            mobile_opts = {"is_mobile": True} if browser_name != "firefox" else {}
            phone = browser.new_context(bypass_csp=True, viewport={"width": 390, "height": 844}, has_touch=True, device_scale_factor=3, **mobile_opts)
            phone.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0)
            tp = phone.new_page()
            track(tp)
            open_forge(tp)
            check(not tp.evaluate("() => document.querySelector('#forge-presets').open"), "phone: presets start folded")
            tp.locator("#forge-history-open").tap()
            tp.wait_for_function("() => document.querySelectorAll('#forge-history-list li').length >= 1")
            tp.locator("#forge-history-list li").first.get_by_role("button", name="Réutiliser le prompt").tap()
            check(tp.locator("#forge-prompt").input_value() != "", "phone: tap reuses a prompt")
            tp.locator('.forge-ratio[data-forge-ratio="9:16"]').tap()
            check(tp.locator("#forge-width").input_value() == "576", "phone: tap selects a ratio")
            tp.locator("#forge-presets > summary").tap()
            check(tp.evaluate("() => document.querySelector('#forge-presets').open"), "phone: presets unfold with a tap")
            m = tp.evaluate(LAYOUT_PROBE)
            check(m["scrollWidth"] <= m["vw"] + 1, "phone: no horizontal overflow with presets open")
            if SHOTS:
                tp.screenshot(path=str(SHOTS / "ux-touch-390-full.png"), full_page=True)
            phone.close()

            check(not any(":7860" in url for url in requests), "browser never calls Forge directly")
            outside = [url for url in requests if not url.split(" ", 1)[1].startswith((base, "data:", "blob:" + base))]
            check(not outside, "browser stays on the isolated HQ " + " | ".join(outside[:3]))
            serious = [e for e in errors if "pageerror" in e or "TypeError" in e or "ReferenceError" in e]
            check(not serious, "no page errors: " + " | ".join(serious))
            print("HTTP_ERRORS", " | ".join(failed))
            print("CONSOLE_ERRORS", len(errors), " | ".join(errors)[:600])
            browser.close()
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()
        shutil.rmtree(root, ignore_errors=True)
        shutil.rmtree(vault, ignore_errors=True)
    print("PASSED", passed)
    if SOFT:
        print("SOFT_FAILED", len(soft_failed))
        if soft_failed:
            raise SystemExit(1)


if __name__ == "__main__":
    main()
