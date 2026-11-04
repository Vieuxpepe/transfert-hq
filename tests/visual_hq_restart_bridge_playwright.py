"""Accueil « Redémarrer » in a browser: shown (with its dot) when the PC can restart and code changed, confirm,
POST, wait for a new bridge process, then the page reloads. The restart itself is faked by intercepting the routes.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_restart_bridge_playwright.py
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
PROD_PORTS = (":8765", ":8766", ":8776", ":7860")
SHOTS = Path(os.environ["HQ_SHOTS"]) if os.environ.get("HQ_SHOTS") else None
passed = 0


def check(cond: bool, message: str) -> None:
    global passed
    if not cond:
        raise SystemExit("FAIL: " + message)
    passed += 1
    print("  OK  ", message)


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-restart-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    try:
        with sync_playwright() as p:
            browser = getattr(p, os.environ.get("FORGE_BROWSER", "chromium")).launch()
            for label, viewport in (("phone", {"width": 390, "height": 844}), ("desktop", {"width": 1440, "height": 900})):
                print(f"[{label}]")
                ctx = browser.new_context(viewport=viewport, bypass_csp=True)
                page = ctx.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.goto(base + "/")
                page.fill('input[name="pin"]', info["admin_pin"])
                page.click('button[type="submit"]')
                page.wait_for_load_state("networkidle")
                check(page.locator("#btn-restart-bridge").is_hidden(), "hidden on a machine that cannot restart (this test server)")

                state = {"posted": 0, "pid": 111}

                def status(route, request):
                    if request.method == "POST":
                        state["posted"] += 1
                        state["pid"] = 222  # the « new » bridge
                        return route.fulfill(json={"ok": True, "pid": 111})
                    return route.fulfill(json={"ok": True, "supported": True, "pending": True, "pid": 111})
                page.route("**/api/pc/restart-bridge", status)
                page.route("**/api/diag/live", lambda route, request: route.fulfill(json={"status": "alive", "pid": state["pid"]}))
                page.reload()
                page.wait_for_load_state("networkidle")
                btn = page.locator("#btn-restart-bridge")
                btn.wait_for(state="visible", timeout=8000)
                check(True, "shown on the Windows PC")
                check(btn.evaluate("b => b.classList.contains('is-due')"), "with a dot when code changed since the start")
                check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), "the row still fits")
                if SHOTS:
                    SHOTS.mkdir(parents=True, exist_ok=True)
                    page.locator("#hq-actions").screenshot(path=str(SHOTS / f"restart-{label}.png"))
                dialogs = []
                page.once("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
                btn.click()
                page.wait_for_timeout(300)
                check(dialogs and "Redémarrer le pont HQ" in dialogs[0] and state["posted"] == 0, "asks first; « Annuler » does nothing")
                page.once("dialog", lambda d: d.accept())
                with page.expect_navigation(timeout=15000):
                    btn.click()
                check(state["posted"] == 1, "confirmed: one restart request")
                check(True, "the page reloads once the new bridge answers")
                check(errors == [], f"no page errors {errors}")
                ctx.close()
            browser.close()
    finally:
        proc.terminate()
    print(f"visual_hq_restart_bridge: {passed} checks ok")


if __name__ == "__main__":
    main()
