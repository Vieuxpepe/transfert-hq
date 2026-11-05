"""Every HQ module must initialise: Accueil (Aujourd'hui), Carnet and Forge Studio.

Isolated test server (production HQServer class), throwaway admin, mock Forge. Fresh context
plus reload, with console errors and HTTP >= 400 captured.

python tests/visual_frontend_boot_playwright.py
python tests/run_forge_visual_webkit.py tests/visual_frontend_boot_playwright.py
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


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-boot-"))
    vault = Path(tempfile.mkdtemp(prefix="hq-boot-vault-"))
    env = dict(os.environ, HQ_FORGE_MOCK="ready", HQ_FORGE_VAULT_DIR=str(vault))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    passed = 0
    engine = "chromium"
    try:
        info = json.loads(proc.stdout.readline().decode("utf-8"))
        base = info["base"]
        assert int(base.rsplit(":", 1)[1]) not in (8765, 8766, 8776, 7860)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            engine = browser.browser_type.name
            ctx = browser.new_context(bypass_csp=True)  # Playwright wait_for_function needs eval; the served CSP is unchanged
            if ctx.request.post(base + "/login", form={"pin": info["admin_pin"]}, headers={"origin": base}, max_redirects=0).status != 303:
                raise SystemExit("login failed")
            page = ctx.new_page()
            problems: list[str] = []
            page.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
            page.on("console", lambda m: problems.append("console: " + m.text) if m.type == "error" else None)
            page.on("response", lambda r: problems.append(f"HTTP {r.status} {r.url}") if r.status >= 400 else None)

            def check(cond: bool, message: str) -> None:
                nonlocal passed
                if not cond:
                    raise SystemExit(f"FAIL [{engine}]: {message} | {problems[:8]}")
                passed += 1
                print("  OK  ", message)

            for attempt in ("fresh", "reload"):
                if attempt == "fresh":
                    page.goto(base + "/")
                else:
                    problems.clear()
                    page.reload()
                page.wait_for_load_state("load")
                page.wait_for_timeout(800)
                check(page.evaluate("() => typeof window.hqCarnetShow === 'function'"), f"{attempt}: hq-carnet.js initialised")
                check(page.evaluate("() => typeof window.hqForgeShow === 'undefined'"), f"{attempt}: hq-forge.js is not loaded until Forge is opened")
                page.locator('.bottom-nav [data-nav="accueil"]').click()
                page.locator("#hq-today-toggle").click()
                page.wait_for_function("() => !/Chargement/.test(document.querySelector('#hq-cal-today').textContent || '')", timeout=10000)
                check(True, f"{attempt}: Accueil Aujourd'hui leaves Chargement")
                page.locator('.bottom-nav [data-nav="carnet"]').click()
                page.wait_for_function("() => document.querySelector('#hq-carnet-app .carnet, #hq-carnet-app .carnet-fail')", timeout=10000)
                check(page.locator("#hq-carnet-app .carnet-fail").count() == 0, f"{attempt}: Carnet opens")
                page.locator('.bottom-nav [data-nav="forge"]').click()
                page.wait_for_function("() => typeof window.hqForgeShow === 'function'", timeout=10000)
                check(True, f"{attempt}: hq-forge.js initialised on first visit")
                page.wait_for_function("() => !/^Lecture de Forge/.test(document.querySelector('#forge-status').textContent || '') && document.querySelector('#forge-checkpoint').options.length > 0", timeout=10000)
                check(True, f"{attempt}: Forge Studio reads Forge and fills the model menu")
                real = [p for p in problems if "due to access control checks" not in p]  # WebKit: fetches aborted by the reload itself
                check(not real, f"{attempt}: no console errors and no failed requests")
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
