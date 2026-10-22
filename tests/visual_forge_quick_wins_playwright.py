"""Forge Studio quick wins (F3, F4, F5, F14, F18, F21 UI). Mock Forge only.

No GPU, no port 7860. The HQ test server binds 127.0.0.1 on an ephemeral port
with throwaway data and vault directories. Browser APIs that touch the device
(wake lock, share) are stubbed in the page.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_quick_wins_playwright.py [section ...]
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
SHOTS = Path(os.environ["FORGE_QW_SHOTS"]) if os.environ.get("FORGE_QW_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)
PROD_PORTS = (":8765", ":8766", ":8776", ":7860")

STORAGE_PROBE = """async (needle) => {
  const hits = [];
  for (const [name, store] of [["local", localStorage], ["session", sessionStorage]]) {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      const v = store.getItem(k) || "";
      if (k === "hqForgeDraft" || v.includes(needle) || k.includes(needle)) hits.push(name + ":" + k);
    }
  }
  if (window.indexedDB && indexedDB.databases) {
    try { (await indexedDB.databases()).forEach((db) => hits.push("idb:" + db.name)); } catch (_) {}
  }
  if (window.caches) {
    try {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) if (decodeURIComponent(req.url).includes(needle)) hits.push("cache:" + req.url);
      }
    } catch (_) {}
  }
  return hits;
}"""


def start_server(extra_env: dict | None = None):
    root = Path(tempfile.mkdtemp(prefix="hq-forge-qw-"))
    vault = Path(tempfile.mkdtemp(prefix="hq-forge-qw-vault-"))
    env = os.environ.copy()
    env["HQ_FORGE_MOCK"] = "ready"
    env["HQ_FORGE_VAULT_DIR"] = str(vault)
    env.update(extra_env or {})
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    assert info["base"].startswith("http://127.0.0.1:") and not info["base"].endswith(PROD_PORTS)
    return proc, info


class Run:
    def __init__(self, browser, info):
        self.browser = browser
        self.base = info["base"]
        self.info = info
        self.passed = 0
        self.errors: list[str] = []

    def check(self, cond: bool, message: str) -> None:
        if not cond:
            raise SystemExit("FAIL: " + message)
        self.passed += 1
        print("  OK  ", message)

    def context(self, init_script: str | None = None, width: int = 375, height: int = 812):
        ctx = self.browser.new_context(bypass_csp=True, viewport={"width": width, "height": height})
        if init_script:
            ctx.add_init_script(init_script)
        login = ctx.request.post(self.base + "/login", form={"pin": self.info["admin_pin"]}, headers={"origin": self.base}, max_redirects=0)
        if login.status != 303:
            raise SystemExit("login failed")
        return ctx

    def open_forge(self, page):
        page.on("pageerror", lambda exc: None if "due to access control checks" in str(exc) else self.errors.append("pageerror " + str(exc)))  # WebKit: requests aborted by a navigation
        page.goto(self.base + "/")
        page.locator('.bottom-nav [data-nav="forge"]').click()
        if not self.until(page, "() => !!(document.querySelector('#forge-checkpoint').value && !document.querySelector('#forge-generate').disabled)", 15):
            raise SystemExit("FAIL: Forge Studio did not become ready")

    def dest(self, page, value: str) -> None:
        # A DOM click fires click, input and change like a tap; help popovers cannot swallow it.
        page.evaluate("(v) => document.querySelector('input[name=\"forge-destination\"][value=\"' + v + '\"]').click()", value)

    def until(self, page, expression: str, timeout: float = 10.0, arg=None) -> bool:
        """Poll with evaluate (WebKit refuses string wait_for_function under the page CSP)."""
        import time
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if page.evaluate(expression, arg):
                return True
            page.wait_for_timeout(100)
        return False

    def shot(self, page, name: str, selector: str | None = None):
        if not SHOTS:
            return
        width = page.viewport_size["width"]
        path = SHOTS / f"{os.environ.get('FORGE_BROWSER', 'chromium')}-{name}-{width}.png"
        if selector:
            page.locator(selector).first.scroll_into_view_if_needed()
        page.screenshot(path=str(path))


def section_draft(run: Run) -> None:
    print("F3 prompt draft")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    page.locator("#forge-prompt").fill("brouillon de phare")
    page.evaluate("() => { const n = document.querySelector('#forge-negative'); n.value = 'flou'; n.dispatchEvent(new Event('input', { bubbles: true })); }")
    page.wait_for_timeout(700)
    run.check(json.loads(page.evaluate("() => sessionStorage.getItem('hqForgeDraft')") or "{}").get("prompt") == "brouillon de phare", "the normal draft is saved to sessionStorage")
    run.open_forge(page)  # a fresh load, as after an iOS tab discard
    run.check(page.locator("#forge-prompt").input_value() == "brouillon de phare", "the prompt is restored after a reload")
    run.check(page.locator("#forge-negative").input_value() == "flou", "the negative prompt is restored")
    run.check(page.locator("#forge-draft-note").is_visible() and "Brouillon repris" in page.locator("#forge-draft-note").inner_text(), "the status says Brouillon repris")
    run.shot(page, "draft-restored", "#forge-prompt")
    # Private: the key disappears on the switch and nothing is written while private.
    run.dest(page, "private")
    run.check(page.evaluate("() => sessionStorage.getItem('hqForgeDraft')") is None, "switching to Coffre privé wipes the draft key")
    page.locator("#forge-prompt").fill("prompt prive tres secret")
    page.wait_for_timeout(700)
    hits = page.evaluate(STORAGE_PROBE, "prompt prive tres secret")
    run.check(hits == [], "no draft and no private text in any browser storage while private: " + repr(hits))
    run.open_forge(page)
    run.check(page.locator("#forge-prompt").input_value() == "", "after a reload in private mode the prompt is empty")
    # A pending save cannot land after the switch.
    page.locator("#forge-prompt").fill("tape juste avant")
    run.dest(page, "private")
    page.wait_for_timeout(700)
    run.check(page.evaluate("() => sessionStorage.getItem('hqForgeDraft')") is None, "a debounced save queued before the switch never runs")
    run.dest(page, "normal")
    # A successful generate clears the draft.
    page.locator("#forge-prompt").fill("image a lancer")
    page.wait_for_timeout(700)
    page.locator("#forge-generate").click()
    run.check(run.until(page, "() => sessionStorage.getItem('hqForgeDraft') === null"), "a successful generate wipes the draft")
    run.until(page, "() => !document.querySelector('#forge-generate').disabled", 15)
    ctx.close()


SECTIONS = {"draft": section_draft}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
            proc, info = start_server(EXTRA_ENV.get(name))
            try:
                run = Run(browser, info)
                SECTIONS[name](run)
                if run.errors:
                    raise SystemExit("FAIL: page errors " + repr(run.errors[:3]))
                total += run.passed
            finally:
                proc.stdin.close()
                proc.wait(timeout=10)
        browser.close()
    print(f"PASS {total} checks ({browser_name})")


EXTRA_ENV: dict[str, dict] = {}

if __name__ == "__main__":
    main()
