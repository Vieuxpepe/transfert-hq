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


def generate_once(run: Run, page, prompt: str) -> None:
    before = page.locator("#forge-gallery .forge-card").count()
    page.locator("#forge-prompt").fill(prompt)
    page.locator("#forge-generate").click()
    if not run.until(page, "(n) => document.querySelectorAll('#forge-gallery .forge-card').length > n", 20, before):
        raise SystemExit("FAIL: generation did not finish")
    run.until(page, "() => !document.querySelector('#forge-generate').disabled", 15)


def section_eta(run: Run) -> None:
    print("F4 ETA and usual duration")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    run.check(page.locator("#forge-usual-duration").is_hidden(), "no usual duration before three samples")
    page.locator("#forge-prompt").fill("premier essai")
    page.locator("#forge-generate").click()
    run.check(run.until(page, "() => /\u2248 25 s restantes/.test(document.querySelector('#forge-progress-label').textContent)", 10),
              "the progress line shows ≈ 25 s restantes from Forge's eta_relative")
    run.shot(page, "eta", "#forge-actionbar")
    run.until(page, "() => !document.querySelector('#forge-generate').disabled", 15)
    run.check("restantes" not in page.locator("#forge-progress-label").inner_text(), "the ETA disappears at the end")
    generate_once(run, page, "deuxieme essai")
    run.check(page.locator("#forge-usual-duration").is_hidden(), "still hidden with two samples")
    generate_once(run, page, "troisieme essai")
    run.check(run.until(page, "() => { const n = document.querySelector('#forge-usual-duration'); return !n.hidden && /^Dur\u00e9e habituelle : ~\\d+ s$/.test(n.textContent); }", 5),
              "Durée habituelle : ~N s appears after three samples")
    run.shot(page, "usual-duration", "#forge-actionbar")
    page.locator("#forge-steps").fill("13")
    page.locator("#forge-steps").dispatch_event("change")
    run.check(run.until(page, "() => document.querySelector('#forge-usual-duration').hidden", 5), "another bucket (steps) hides it again")
    ctx.close()


WAKE_STUB = """(() => {
  window.__wake = { requests: 0, releases: 0, active: 0 };
  const lock = { request: async (type) => {
    window.__wake.requests++; window.__wake.active++;
    const s = new EventTarget(); s.type = type; s.released = false;
    s.release = async () => { if (!s.released) { s.released = true; window.__wake.active--; window.__wake.releases++; s.dispatchEvent(new Event("release")); } };
    return s;
  } };
  Object.defineProperty(Navigator.prototype, "wakeLock", { get: () => lock, configurable: true });
})();"""

VISIBILITY_STUB = """(() => {
  let state = "visible";
  Object.defineProperty(Document.prototype, "visibilityState", { get: () => state, configurable: true });
  Object.defineProperty(Document.prototype, "hidden", { get: () => state === "hidden", configurable: true });
  window.__setVisibility = (next) => { state = next; document.dispatchEvent(new Event("visibilitychange")); };
})();"""

NO_WAKE = """Object.defineProperty(Navigator.prototype, "wakeLock", { get: () => undefined, configurable: true });"""


def section_wake(run: Run) -> None:
    print("F5 wake lock and instant resume")
    ctx = run.context(NO_WAKE)
    page = ctx.new_page()
    run.open_forge(page)
    run.check(page.locator("#forge-wake-wrap").is_hidden(), "the toggle is hidden when the Wake Lock API is missing")
    ctx.close()

    ctx = run.context(WAKE_STUB + "\n" + VISIBILITY_STUB)
    page = ctx.new_page()
    run.open_forge(page)
    run.check(page.locator("#forge-wake-wrap").is_visible() and not page.locator("#forge-wake").is_checked(), "Garder l'écran allumé is shown and off by default")
    page.locator("#forge-prompt").fill("sans verrou")
    page.locator("#forge-generate").click()
    run.until(page, "() => !document.querySelector('#forge-progress').hidden", 5)
    page.wait_for_timeout(600)
    run.check(page.evaluate("() => window.__wake.requests") == 0, "no wake lock is requested while the toggle is off")
    run.until(page, "() => !document.querySelector('#forge-generate').disabled", 20)
    page.locator("#forge-wake").check()
    run.check(page.evaluate("() => localStorage.getItem('hqForgeWakeLock')") == "1", "the preference is kept in localStorage")
    run.shot(page, "wake-toggle", "#forge-prefs")
    page.locator("#forge-prompt").fill("avec verrou")
    page.locator("#forge-generate").click()
    run.check(run.until(page, "() => window.__wake.active === 1", 5), "a wake lock is held while the job runs")
    # Background: the browser drops the lock; coming back re-acquires it and polls at once.
    page.evaluate("() => window.__setVisibility('hidden')")
    seen = []
    page.on("request", lambda r: seen.append(r.url) if "/api/forge/jobs/job-" in r.url else None)
    page.wait_for_timeout(100)
    before = len(seen)
    page.evaluate("() => window.__setVisibility('visible')")
    page.wait_for_timeout(400)
    run.check(len(seen) > before, "returning to the app polls the job immediately (no 2 s wait)")
    run.check(run.until(page, "() => !document.querySelector('#forge-generate').disabled", 20), "the job finishes")
    run.check(run.until(page, "() => window.__wake.active === 0", 5), "the wake lock is released on a terminal state")
    page.locator("#forge-wake").uncheck()
    run.check(page.evaluate("() => localStorage.getItem('hqForgeWakeLock')") == "0", "turning it off is remembered")
    ctx.close()


SHARE_STUB = """(() => {
  window.__shared = [];
  Navigator.prototype.canShare = function (data) { return !!(data && data.files && data.files.length && data.files.every((f) => f.type === "image/png")); };
  Navigator.prototype.share = async function (data) { window.__shared.push(data.files.map((f) => [f.name, f.type, f.size])); };
})();"""

NO_SHARE = """(() => { Navigator.prototype.canShare = undefined; Navigator.prototype.share = undefined; })();"""

PASSPHRASE = "synthetic horse battery"


def _png_bytes() -> bytes:
    import io
    from PIL import Image
    buffer = io.BytesIO()
    Image.new("RGB", (256, 256), (90, 30, 120)).save(buffer, format="PNG")
    return buffer.getvalue()


def open_vault(run: Run, page) -> None:
    """Create and unlock a throwaway vault through the UI, then import one synthetic image."""
    run.dest(page, "private")
    page.locator("#forge-vault").wait_for()
    if page.locator("#forge-vault-new").is_visible():
        page.locator("#forge-vault-new").fill(PASSPHRASE)
        page.locator("#forge-vault-confirm").fill(PASSPHRASE)
        page.locator("#forge-vault-create").click()
        page.locator("#forge-vault-recovery-key").wait_for()
        page.locator("#forge-vault-recovery-ok").click()
    page.locator("#forge-vault-pass").wait_for()
    page.locator("#forge-vault-pass").fill(PASSPHRASE)
    page.locator("#forge-vault-open").click()
    page.locator("#forge-vault-lock").wait_for()


def import_private(run: Run, page) -> None:
    image = page.request.post(run.base + "/api/forge/vault/import", data=_png_bytes(),
                              headers={"origin": run.base, "content-type": "application/octet-stream"})
    run.check(image.status == 201, "a synthetic private image is imported")
    page.evaluate("() => { document.querySelector('input[name=\\'forge-destination\\'][value=\\'normal\\']').click(); }")
    run.dest(page, "private")
    run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length > 0", 10)


def section_share(run: Run) -> None:
    print("F14 Enregistrer dans Photos")
    ctx = run.context(NO_SHARE)
    page = ctx.new_page()
    run.open_forge(page)
    generate_once(run, page, "phare pour partage")
    page.locator("#forge-gallery .forge-card").first.click()
    page.locator("#forge-viewer").wait_for()
    page.wait_for_timeout(500)
    run.check(page.locator("#forge-share").is_hidden(), "the button is hidden when canShare is unavailable")
    ctx.close()

    ctx = run.context(SHARE_STUB)
    page = ctx.new_page()
    run.open_forge(page)
    page.locator("#forge-gallery .forge-card").first.click()
    run.check(run.until(page, "() => !document.querySelector('#forge-share').hidden", 5), "Enregistrer dans Photos appears in the viewer")
    run.shot(page, "share-normal", "#forge-share")
    page.locator("#forge-share").click()
    run.check(run.until(page, "() => window.__shared.length === 1", 5), "a tap shares one PNG file")
    shared = page.evaluate("() => window.__shared[0]")
    run.check(shared[0][1] == "image/png" and shared[0][0].startswith("forge-img-") and shared[0][2] > 100, "the shared file is the original PNG: " + repr(shared))
    hits = page.evaluate(STORAGE_PROBE, "img-")
    run.check(not [h for h in hits if not h.startswith("session:hqForge")], "no image bytes or URLs land in browser storage: " + repr(hits))
    page.locator("#forge-viewer-close").click()

    open_vault(run, page)
    import_private(run, page)
    page.locator("#forge-vault-gallery .forge-card").first.click()
    run.check(run.until(page, "() => !document.querySelector('#forge-vault-share').hidden", 5), "the vault viewer offers Enregistrer dans Photos")
    run.shot(page, "share-private", "#forge-vault-share")
    messages = []

    def dismiss(dialog):
        messages.append(dialog.message)
        dialog.dismiss()
    page.once("dialog", dismiss)
    page.locator("#forge-vault-share").click()
    page.wait_for_timeout(400)
    run.check(messages and "Cette image quittera le coffre." in messages[0], "a private share asks: Cette image quittera le coffre.")
    run.check(page.evaluate("() => window.__shared.length") == 1, "declining the confirm shares nothing")
    page.once("dialog", lambda dialog: dialog.accept())
    page.locator("#forge-vault-share").click()
    run.check(run.until(page, "() => window.__shared.length === 2", 5), "accepting shares the private image once")
    run.check(page.evaluate("() => window.__shared[1][0][0]") == "coffre.png", "the private file name carries no prompt or id")
    page.locator("#forge-vault-viewer-close").click()
    run.check(page.locator("#forge-vault-share").is_hidden(), "closing the vault viewer drops the prepared file")
    ctx.close()


def section_away(run: Run) -> None:
    print("F18 vault lock on background")
    ctx = run.context(VISIBILITY_STUB)
    page = ctx.new_page()
    page.clock.install()
    run.open_forge(page)
    open_vault(run, page)
    import_private(run, page)
    unlocked = lambda: page.request.get(run.base + "/api/forge/vault/status").json().get("unlocked")
    run.check(not page.locator("#forge-vault-away").is_checked(), "Verrouiller en quittant l'app is off by default")
    run.shot(page, "vault-away", "#forge-vault-open-tools")
    page.evaluate("() => window.__setVisibility('hidden')")
    page.clock.fast_forward(31_000)
    page.wait_for_timeout(300)
    run.check(unlocked() is True, "without the option, 30 s in the background does not lock")
    page.evaluate("() => window.__setVisibility('visible')")
    page.locator("#forge-vault-away").check()
    run.check(page.evaluate("() => localStorage.getItem('hqForgeVaultAway')") == "1", "the option is kept in localStorage")
    page.evaluate("() => window.__setVisibility('hidden')")
    page.clock.fast_forward(20_000)
    page.evaluate("() => window.__setVisibility('visible')")
    page.clock.fast_forward(20_000)
    page.wait_for_timeout(300)
    run.check(unlocked() is True, "coming back within 30 s cancels the lock")
    page.evaluate("() => window.__setVisibility('hidden')")
    page.clock.fast_forward(31_000)
    run.check(run.until(page, "() => !document.querySelector('#forge-vault-unlock').hidden", 5), "after 30 s hidden the vault UI is locked")
    run.check(unlocked() is False, "the server session is locked too")
    run.check(page.locator("#forge-vault-gallery .forge-card").count() == 0, "the private thumbnail shown before is cleared")
    ctx.close()


SECTIONS = {"away": section_away, "share": section_share, "wake": section_wake, "draft": section_draft, "eta": section_eta}


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


EXTRA_ENV: dict[str, dict] = {"eta": {"HQ_FORGE_MOCK_DELAY": "4"}, "wake": {"HQ_FORGE_MOCK_DELAY": "3"}}

if __name__ == "__main__":
    main()
