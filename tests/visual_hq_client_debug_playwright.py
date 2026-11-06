"""Browser smoke: debug HUD present when HQ_CLIENT_DEBUG=1, no console errors on quick nav.

python tests/visual_hq_client_debug_playwright.py
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
SOURCE = HERE.parent


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-debug-vis-"))
    proc = subprocess.Popen(
        [sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=dict(os.environ, HQ_CLIENT_DEBUG="1"),
    )
    try:
        info = json.loads(proc.stdout.readline().decode("utf-8"))
        base = info["base"]
        pin = info["admin_pin"]
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(bypass_csp=True)
            assert ctx.request.post(base + "/login", form={"pin": pin}, headers={"origin": base}, max_redirects=0).status == 303
            page = ctx.new_page()
            problems: list[str] = []
            page.on("pageerror", lambda e: problems.append("pageerror: " + str(e)))
            page.goto(base + "/", wait_until="domcontentloaded")
            if not page.locator("#hq-debug-panel").count():
                problems.append("missing #hq-debug-panel")
            if not page.locator("body[data-hq-session]").count():
                problems.append("missing data-hq-session")
            page.locator('.bottom-nav [data-nav="carnet"]').click()
            page.wait_for_timeout(400)
            if problems:
                raise SystemExit("FAIL:\n" + "\n".join(problems))
            print("PASS client debug HUD smoke")
            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=8)


if __name__ == "__main__":
    main()
