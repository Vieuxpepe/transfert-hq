"""Optional WebKit (Safari engine) check that « Dessiner » never hangs on « Chargement… ».

Not part of unittest discovery. Runs its own throwaway loopback HQ (temp root,
fake PIN) and never touches the live root or a real PIN. Skips (exit 0) when
Playwright or its WebKit build is unavailable.

    python -m pip install playwright && python -m playwright install webkit
    python tests/visual_dessiner_webkit.py            # one pass
    python tests/visual_dessiner_webkit.py --repeat 3

Cases (iPhone 13 profile): tap Dessiner from Accueil, reload with Dessiner saved,
one drawing interaction, away/back without duplicate canvas or handlers;
hq-sketch-core.js failing (fast 404) and hq-dessiner.js failing (network abort):
error state, retry failing again, leave/return, reload, then « Réessayer »
recovering without reload; each script loading but throwing while it runs;
hqSketchShow() throwing during init (logged, error state, « Réessayer » reloads).
"""
import json
import shutil
import sys
import tempfile
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

FAKE_PIN = "246810"
FAIL_TITLE = "Dessiner n'a pas pu démarrer."


def _server():
    import iphone_bridge

    root = Path(tempfile.mkdtemp(prefix="hq-dessiner-webkit-"))
    (root / "Inbox").mkdir()
    shutil.copytree(SOURCE / "assets", root / "assets")
    saved = (iphone_bridge.ROOT, json.loads(json.dumps(iphone_bridge.CONFIG)))
    iphone_bridge.ROOT = root
    iphone_bridge.CONFIG.update({"pin": FAKE_PIN, "users": [{"name": "admin", "pin": FAKE_PIN, "role": "admin"}],
                                 "discord_webhook_url": "", "push_enabled": False})
    iphone_bridge.bind_cc_ext()  # what main() does: bind the HQ helpers to the temp root
    iphone_bridge.ensure_hq()

    class Quiet(iphone_bridge.Handler):
        def log_message(self, *_args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    def close():
        httpd.shutdown()
        httpd.server_close()
        iphone_bridge.ROOT = saved[0]
        iphone_bridge.CONFIG.clear()
        iphone_bridge.CONFIG.update(saved[1])
        shutil.rmtree(root, ignore_errors=True)

    return f"http://127.0.0.1:{httpd.server_address[1]}", close


def _check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  OK  ", msg)


def _app_text(page):
    return page.locator("#hq-sk-app").inner_text()


# Counts window/document listeners and ResizeObservers so duplicate registration
# shows up; sessionStorage "skBreakInit" makes the Dessiner canvas throw in init.
INSTRUMENT = """(() => {
  const c = window.__skCounts = { ro: 0 };
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (this === window || this === document) { const k = (this === window ? 'w:' : 'd:') + type; c[k] = (c[k] || 0) + 1; }
    return add.call(this, type, fn, opts);
  };
  const RO = window.ResizeObserver;
  if (RO) window.ResizeObserver = function (cb) { c.ro++; return new RO(cb); };
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    if (sessionStorage.getItem('skBreakInit') === '1' && this.classList.contains('sk-canvas')) throw new Error('injected-init');
    return getContext.apply(this, args);
  };
})();"""
COUNT_KEYS = ("d:keydown", "w:pagehide", "d:visibilitychange", "w:resize", "ro")


def _counts(page):
    return page.evaluate("keys => keys.map(k => window.__skCounts[k] || 0)", list(COUNT_KEYS))


def _delta(after, before):
    return [a - b for a, b in zip(after, before)]


def _single_ui(page, label):
    n = page.evaluate("[document.querySelectorAll('.sk-canvas').length, document.querySelector('#hq-sk-app').children.length]")
    _check(n == [1, 1], f"{label}: one .sk-canvas and one #hq-sk-app child ({n})")


def _away_and_back(page, label):
    before = _counts(page)
    for _ in range(2):
        page.tap(".bottom-nav [data-nav=accueil]")
        page.tap(".bottom-nav [data-nav=dessiner]")
    _check(_counts(page) == before, f"{label}: away/back adds no window/document handler or ResizeObserver")


def _new_page(browser, device, errors):
    ctx = browser.new_context(**device)
    ctx.add_init_script(INSTRUMENT)
    page = ctx.new_page()
    page.set_default_timeout(10000)
    page.on("pageerror", lambda e: errors.append(str(e)[:200]))
    return ctx, page


def _login(page, url):
    page.goto(url + "/")
    page.fill('input[name="pin"]', FAKE_PIN)
    page.click('button[type="submit"]')
    page.wait_for_selector(".bottom-nav [data-nav=dessiner]")


def _expect_fail_state(page, module):
    page.wait_for_selector("#hq-sk-app .sk-fail")
    text = _app_text(page)
    _check(FAIL_TITLE in text and module in text, f"error state names {module}")
    _check("Chargement" not in text, "no « Chargement… » left in #hq-sk-app")
    _check(page.locator("#hq-sk-app button.sk-retry").inner_text().strip() == "Réessayer", "Réessayer button shown")


def _expect_ready(page, label):
    page.wait_for_selector("#hq-sk-app .sk-canvas", state="visible")
    _check("Chargement" not in _app_text(page) and page.locator("#hq-sk-app .sk-fail").count() == 0,
           f"{label}: Dessiner initialized (.sk-canvas, no placeholder)")


def case_happy(browser, device, url):
    errors = []
    ctx, page = _new_page(browser, device, errors)
    _login(page, url)
    before = _counts(page)
    page.tap(".bottom-nav [data-nav=dessiner]")
    _expect_ready(page, "tap from Accueil")
    init_delta = _delta(_counts(page), before)
    _check(init_delta[0] >= 1 and init_delta[4] >= 1, f"init registers Dessiner handlers once {dict(zip(COUNT_KEYS, init_delta))}")
    _single_ui(page, "after init")
    _away_and_back(page, "after init")
    _single_ui(page, "after away/back")
    page.reload()
    _check(page.evaluate("document.body.dataset.view") == "dessiner", "reload restored the saved Dessiner view")
    _expect_ready(page, "reload with Dessiner saved")
    page.tap('[data-tool="pen"]')
    _check(page.evaluate("window.hqSketchState().tool") == "pen", "pen tool selected")
    box = page.locator(".sk-canvas").bounding_box()
    before = page.evaluate("window.hqSketchState().doc.objects.length")
    x, y = box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.4
    page.mouse.move(x, y); page.mouse.down(); page.mouse.move(x + 80, y + 40, steps=12); page.mouse.up()
    _check(page.evaluate("window.hqSketchState().doc.objects.length") == before + 1, "one pen stroke adds exactly one object")
    _check(not errors, f"no pageerror ({errors})")
    ctx.close()
    return init_delta


def case_blocked(browser, device, url, module, init_delta, how="abort"):
    errors = []
    ctx, page = _new_page(browser, device, errors)
    pattern = "**/assets/" + module
    if how == "404":  # fast failure: the error event must not be missed
        page.route(pattern, lambda route: route.fulfill(status=404, body="missing"))
    else:
        page.route(pattern, lambda route: route.abort())
    _login(page, url)
    page.tap(".bottom-nav [data-nav=dessiner]")
    _expect_fail_state(page, module)
    _check(page.evaluate("[...skFailedScripts]") == [module], f"capture listener saw the first-load {how} of {module}")
    page.evaluate("document.querySelector('#hq-sk-app .sk-fail').dataset.old = '1'")
    page.tap("#hq-sk-app button.sk-retry")
    page.wait_for_selector("#hq-sk-app .sk-fail:not([data-old])")  # a real new attempt, not the old box
    _expect_fail_state(page, module)  # still blocked: retry fails visibly again
    page.tap(".bottom-nav [data-nav=accueil]")
    page.tap(".bottom-nav [data-nav=dessiner]")
    _expect_fail_state(page, module)  # leaving and returning keeps a single error state
    _check(page.locator("#hq-sk-app .sk-fail").count() == 1, "leave/return: exactly one error box")
    page.reload()  # saved view + still blocked: error state without any tap
    _expect_fail_state(page, module)
    page.unroute(pattern)
    before = _counts(page)
    page.tap("#hq-sk-app button.sk-retry")
    _expect_ready(page, f"Réessayer after unblocking {module}")
    _check(_delta(_counts(page), before) == init_delta, "recovered init registers the same handlers as a clean init")
    _single_ui(page, "after recovery")
    _away_and_back(page, "after recovery")
    _check(page.evaluate("document.querySelectorAll('script[data-sk=\"hq-dessiner.js\"]').length") <= 2,
           "hq-dessiner.js injected at most once more")
    page.tap('[data-tool="eraser"]')
    _check(page.evaluate("window.hqSketchState().tool") == "eraser", "tool works after recovery")
    _check(not errors, f"no pageerror ({errors})")
    ctx.close()


def case_throwing_script(browser, device, url, module, init_delta):
    """The request succeeds but the script throws while it runs (no element error event)."""
    errors = []
    ctx, page = _new_page(browser, device, errors)
    pattern = "**/assets/" + module
    page.route(pattern, lambda route: route.fulfill(status=200, content_type="application/javascript; charset=utf-8",
                                                     body="throw new Error('injected-" + module + "');"))
    _login(page, url)
    page.tap(".bottom-nav [data-nav=dessiner]")
    _expect_fail_state(page, module)
    page.unroute(pattern)
    before = _counts(page)
    page.tap("#hq-sk-app button.sk-retry")
    _expect_ready(page, f"Réessayer after {module} stopped throwing")
    _check(_delta(_counts(page), before) == init_delta, "no duplicate handlers after re-running the script")
    _single_ui(page, "after recovery")
    _check(errors and all("injected-" + module in e for e in errors), f"only the injected error reached the page ({errors})")
    ctx.close()


def case_init_throws(browser, device, url):
    """hqSketchShow() throws inside init: logged, error state kept, « Réessayer » reloads."""
    errors, logged = [], []
    ctx, page = _new_page(browser, device, errors)
    page.on("console", lambda m: logged.append(m.text) if m.type == "error" else None)
    _login(page, url)
    page.evaluate("sessionStorage.setItem('skBreakInit', '1')")
    page.tap(".bottom-nav [data-nav=dessiner]")
    _expect_fail_state(page, "erreur d'initialisation")
    _check(any("injected-init" in t for t in logged), "init error still logged to the console")
    _check(not errors, f"init error contained, no pageerror ({errors})")
    page.tap(".bottom-nav [data-nav=accueil]")
    page.tap(".bottom-nav [data-nav=dessiner]")
    _check(page.locator("#hq-sk-app .sk-fail").count() == 1 and page.locator("#hq-sk-app .sk-canvas").count() == 0,
           "leave/return after init failure: error state kept, no half-built canvas")
    page.evaluate("sessionStorage.removeItem('skBreakInit')")
    with page.expect_navigation():
        page.tap("#hq-sk-app button.sk-retry")
    _expect_ready(page, "Réessayer after init failure (reload, saved view)")
    _single_ui(page, "after reload")
    ctx.close()


def run_once(p, browser):
    url, close = _server()
    try:
        device = p.devices["iPhone 13"]
        print("case: happy path"); init_delta = case_happy(browser, device, url)
        print("case: hq-sketch-core.js 404"); case_blocked(browser, device, url, "hq-sketch-core.js", init_delta, how="404")
        print("case: hq-dessiner.js aborted"); case_blocked(browser, device, url, "hq-dessiner.js", init_delta)
        print("case: hq-sketch-core.js throws"); case_throwing_script(browser, device, url, "hq-sketch-core.js", init_delta)
        print("case: hq-dessiner.js throws"); case_throwing_script(browser, device, url, "hq-dessiner.js", init_delta)
        print("case: hqSketchShow() init throws"); case_init_throws(browser, device, url)
    finally:
        close()


def main(argv):
    repeat = int(argv[argv.index("--repeat") + 1]) if "--repeat" in argv else 1
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("SKIP: playwright not installed")
        return 0
    with sync_playwright() as p:
        try:
            browser = p.webkit.launch()
        except Exception as exc:  # browser build or system libraries missing
            print("SKIP: WebKit unavailable:", str(exc).splitlines()[0][:160])
            return 0
        try:
            print("WebKit", browser.version)
            for i in range(repeat):
                print(f"--- pass {i + 1}/{repeat}")
                run_once(p, browser)
        finally:
            browser.close()
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
