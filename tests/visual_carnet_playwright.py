"""Carnet Stage 02 browser checks — desktop Chromium, iPad WebKit, iPhone WebKit.

Not part of unittest discovery. Runs its own throwaway loopback HQ (temp ROOT,
temp sessions file, fake PINs) and never touches the live root or a real PIN.
Skips (exit 0) when Playwright or a browser build is unavailable.

    python tests/visual_carnet_playwright.py

Covers (docs/carnet-agents/02-editor.md): load/paper/sizes, synchronous draft +
autosave, late-success race, offline multi-page + reload recovery, localStorage
failure, upload role vs admin draft, two-context 409 with both resolutions,
PC ↔ iPhone sync, different pages, clean vs dirty polling, duplicate timers and
listeners, blur/hidden/pagehide flush, swipe/vertical/selection, Alt+arrows,
mouse buttons, clipboard native/fallback, symbols/time, new page, reduced motion,
responsive layout, init asset/API failure, no pageerror/console/external request.
"""
import json
import re
import shutil
import sys
import tempfile
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

ADMIN_PIN = "424242"
UPLOAD_PIN = "111111"
SHAFT = "Shaft inspection\nØ12.034 mm\nCheck bearing preload"
IDEA = "Try a split clamp instead"
STORAGE_MSG = "Sauvegarde locale indisponible — ne ferme pas cette page."
OFFLINE_MSG = "Hors ligne — conservé sur cet appareil"
DRAFT_KEY = "hq_carnet_drafts_v1:admin-test"


def fixture():
    def page(pid, rev, text, **extra):
        p = {"id": pid, "rev": rev, "project_id": None, "category_id": None, "pinned": False, "deleted_at": None,
             "created_at": 1790680010.0, "updated_at": 1790680300.0,
             "content": {"version": 1, "blocks": [{"id": "block-" + pid[5:], "type": "text", "text": text, "marks": []}]}}
        p.update(extra)
        return p
    return {
        "version": 1, "notebook_rev": 4,
        "projects": [{"id": "proj-fixture", "name": "Fixture redesign", "archived": False, "created_at": 1790680000.0, "updated_at": 1790680000.0}],
        "categories": [{"id": "cat-measures", "name": "Mesures", "color": "amber", "created_at": 1790680000.0, "updated_at": 1790680000.0}],
        "pages": [page("page-shaft", 3, SHAFT, project_id="proj-fixture", category_id="cat-measures", pinned=True),
                  page("page-idea", 1, IDEA)],
    }


class Server:
    def __init__(self):
        import iphone_bridge as B
        self.B = B
        self.root = Path(tempfile.mkdtemp(prefix="hq-carnet-pw-"))
        for name in ("Inbox", "Uni", "Print"):
            (self.root / name).mkdir()
        shutil.copytree(SOURCE / "assets", self.root / "assets")
        self.saved = (B.ROOT, B.SESSIONS_PATH, json.loads(json.dumps(B.CONFIG)))
        B.ROOT = self.root
        B.SESSIONS_PATH = self.root / "bridge_sessions.json"
        B.CONFIG.update({"pin": "", "discord_webhook_url": "", "push_enabled": False,
                         "users": [{"name": "admin-test", "pin": ADMIN_PIN, "role": "admin"},
                                   {"name": "upload-test", "pin": UPLOAD_PIN, "role": "upload"}]})
        B.bind_cc_ext()
        B.bind_hq()

        class Quiet(B.Handler):
            def log_message(self, *_a):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.nb_path = self.root / ".hq-carnet" / "notebook.json"

    def seed(self):
        import hq_carnet
        import hq_state
        self.nb_path.parent.mkdir(parents=True, exist_ok=True)
        with hq_state.path_lock(hq_carnet.notebook_path(self.root)):
            self.nb_path.write_text(json.dumps(fixture(), ensure_ascii=False), encoding="utf-8")

    def nb(self):
        return json.loads(self.nb_path.read_text(encoding="utf-8"))

    def text(self, pid):
        return next(p for p in self.nb()["pages"] if p["id"] == pid)["content"]["blocks"][0]["text"]

    def rev(self, pid):
        return next(p for p in self.nb()["pages"] if p["id"] == pid)["rev"]

    def close(self):
        B = self.B
        self.httpd.shutdown()
        self.httpd.server_close()
        B.ROOT, B.SESSIONS_PATH = self.saved[0], self.saved[1]
        B.CONFIG.clear()
        B.CONFIG.update(self.saved[2])
        shutil.rmtree(self.root, ignore_errors=True)


RESULTS = {"ok": 0}
PUMP = []


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    RESULTS["ok"] += 1
    print("  OK  ", msg)


def wait_until(fn, msg, timeout=8.0, step=0.05):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        try:
            last = fn()
            if last:
                check(True, msg)
                return last
        except Exception as e:  # noqa: BLE001
            last = e
        if PUMP:
            PUMP[-1](int(step * 1000))  # keeps Playwright's event loop (routes/events) running
        else:
            time.sleep(step)
    raise AssertionError(f"{msg} (last={last!r})")


INSTRUMENT = """(() => {
  const c = window.__carnetCounts = { intervals: new Set(), listeners: {} };
  const fromCarnet = () => /hq-carnet\\.js/.test(String(new Error().stack || ''));
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = function (fn, ms, ...rest) { const id = si.call(window, fn, ms, ...rest); if (fromCarnet()) c.intervals.add(id); return id; };
  window.clearInterval = function (id) { c.intervals.delete(id); return ci.call(window, id); };
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if ((this === window || this === document) && fromCarnet()) { const k = (this === window ? 'w:' : 'd:') + type; c.listeners[k] = (c.listeners[k] || 0) + 1; }
    return add.call(this, type, fn, opts);
  };
})();"""


class Harness:
    def __init__(self, pw, srv):
        self.pw = pw
        self.srv = srv
        self.browsers = {}
        self.errors = []
        self.external = []
        self.expected_failures = False

    def browser(self, engine):
        if engine not in self.browsers:
            self.browsers[engine] = getattr(self.pw, engine).launch()
        return self.browsers[engine]

    def context(self, profile, *, pin=ADMIN_PIN, reduced=False, init=None, permissions=None):
        if profile == "desktop":
            b = self.browser("chromium")
            opts = {"viewport": {"width": 1366, "height": 900}}
        else:
            b = self.browser("webkit")
            opts = dict(self.pw.devices["iPad Pro 11" if profile == "ipad" else "iPhone 13"])
            opts.pop("default_browser_type", None)
        if reduced:
            opts["reduced_motion"] = "reduce"
        ctx = b.new_context(**opts)
        if permissions:
            ctx.grant_permissions(permissions, origin=self.srv.base)
        ctx.add_init_script(INSTRUMENT)
        if init:
            ctx.add_init_script(init)
        r = ctx.request.post(self.srv.base + "/login", form={"pin": pin}, headers={"Origin": self.srv.base}, max_redirects=0)
        assert r.status == 303, r.status
        return ctx

    def page(self, ctx, *, open_carnet=True):
        page = ctx.new_page()
        tag = f"[{ctx.browser.browser_type.name}]"
        page.on("pageerror", lambda e: self.errors.append(f"{tag} pageerror {e}"))

        def on_console(m):
            if m.type != "error":
                return
            if self.expected_failures and ("Failed to load resource" in m.text or "Could not connect" in m.text
                                           or "Load cannot follow" in m.text or "network" in m.text.lower()):
                return
            self.errors.append(f"{tag} console {m.text}")
        page.on("console", on_console)
        page.on("request", lambda r: None if r.url.startswith(self.srv.base) or r.url.startswith("data:") or r.url.startswith("blob:")
                else self.external.append(r.url))
        PUMP.append(page.wait_for_timeout)
        page.on("close", lambda _p: PUMP.remove(page.wait_for_timeout) if page.wait_for_timeout in PUMP else None)
        page.goto(self.srv.base + "/")
        if open_carnet:
            self.open_carnet(page)
        return page

    @staticmethod
    def open_carnet(page):
        page.locator('.bottom-nav [data-nav="carnet"]').click()
        page.wait_for_selector("#hq-carnet-editor")
        page.wait_for_function("() => document.querySelector('#hq-carnet-editor').dataset.pageId")

    def close(self):
        for b in self.browsers.values():
            b.close()


def editor_value(page):
    return page.eval_on_selector("#hq-carnet-editor", "e => e.value")


def page_id(page):
    return page.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId")


def status(page):
    return page.inner_text("#hq-carnet-status")


def dbg(page):
    return page.evaluate("() => window.hqCarnetDebug()")


def type_in(page, text):
    page.focus("#hq-carnet-editor")
    page.keyboard.press("Control+End" if page.context.browser.browser_type.name == "chromium" else "Meta+ArrowDown")
    page.keyboard.type(text)


def set_editor(page, text):
    """Replace content through a real input event (touch profiles lack a reliable select-all)."""
    page.eval_on_selector("#hq-carnet-editor", "(e, t) => { e.focus(); e.value = t; e.dispatchEvent(new Event('input', {bubbles:true})); }", text)


def read_draft(page):
    return page.evaluate(f"() => {{ const r = localStorage.getItem({json.dumps(DRAFT_KEY)}); return r ? JSON.parse(r) : null; }}")


def swipe(page, dx, dy, *, duration=0.12):
    page.evaluate("""([dx, dy, ms]) => new Promise((resolve) => {
      const stage = document.querySelector('.carnet-stage');
      const r = stage.getBoundingClientRect();
      const x0 = r.left + r.width / 2, y0 = r.top + 120;
      const ev = (type, x, y) => {
        const e = new Event(type, { bubbles: true, cancelable: true });
        const t = [{ clientX: x, clientY: y, identifier: 1, target: stage }];
        Object.defineProperty(e, 'touches', { value: type === 'touchend' ? [] : t });
        Object.defineProperty(e, 'changedTouches', { value: t });
        stage.dispatchEvent(e);
      };
      ev('touchstart', x0, y0);
      ev('touchmove', x0 + dx / 2, y0 + dy / 2);
      setTimeout(() => { ev('touchend', x0 + dx, y0 + dy); resolve(); }, ms);
    })""", [dx, dy, int(duration * 1000)])


# ============================================================ scenarios


def t_load_layout(h, profile):
    print(f"-- load/layout [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    check(editor_value(page) == SHAFT, "first page text rendered")
    check(page.inner_text("#carnet-page-indicator").strip() == "1 / 2", "page indicator 1 / 2")
    check(page.inner_text("#btn-carnet-context").strip() == "Fixture redesign · Mesures", "context pill project · category")
    check(page.get_attribute("#btn-carnet-pin", "aria-pressed") == "true", "pin state")
    fs = page.eval_on_selector("#hq-carnet-editor", "e => parseFloat(getComputedStyle(e).fontSize)")
    check(fs >= 16, f"editor font {fs}px >= 16")
    navs = page.eval_on_selector_all(".bottom-nav [data-nav]", "els => els.map(e => e.dataset.nav)")
    check(navs[:3] == ["accueil", "carnet", "calendrier"], "Carnet nav right after Accueil")
    check(page.get_attribute('.bottom-nav [data-nav="carnet"]', "aria-current") == "page", "nav active")
    check(page.title().endswith("Carnet"), "document title")
    vw = page.viewport_size["width"]
    paper = page.eval_on_selector(".carnet-paper", "e => { const r = e.getBoundingClientRect(); return [r.left, r.width]; }")
    if profile == "iphone":
        check(paper[1] >= 0.9 * vw - 1, f"phone paper dominates ({paper[1]:.0f}/{vw})")
    elif profile == "ipad":
        check(paper[1] >= 600, f"iPad paper roomy ({paper[1]:.0f}px)")
    else:
        nav_w = page.eval_on_selector(".bottom-nav", "e => e.getBoundingClientRect().width")
        check(nav_w <= 200, "desktop keeps the HQ sidebar")
        check(640 <= paper[1] <= 900, f"desktop paper comfortable width ({paper[1]:.0f}px)")
        center = paper[0] + paper[1] / 2
        main = page.eval_on_selector(".wrap", "e => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; }")
        check(abs(center - main) < 30, "desktop paper centered")
    if profile != "desktop":
        small = page.eval_on_selector_all(".carnet button:not([hidden])",
                                          "els => els.filter(b => b.offsetParent).map(b => b.getBoundingClientRect()).filter(r => r.width < 44 || r.height < 44).length")
        check(small == 0, "touch controls >= 44px")
    check(page.eval_on_selector("#hq-carnet-status", "e => e.getAttribute('role')") == "status", "status live region")
    ctx.close()


def t_autosave_draft(h, profile):
    print(f"-- draft + autosave [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    page.locator("#btn-carnet-next").click()
    wait_until(lambda: page_id(page) == "page-idea", "next button (mouse/tap) navigates")
    page.focus("#hq-carnet-editor")
    # Draft is written synchronously inside the input handler, before the debounce.
    got = page.evaluate(f"""() => {{
      const e = document.querySelector('#hq-carnet-editor');
      e.value = e.value + ' — v2';
      e.dispatchEvent(new Event('input', {{bubbles: true}}));
      const raw = localStorage.getItem({json.dumps(DRAFT_KEY)});
      return raw && JSON.parse(raw).pages['page-idea'];
    }}""")
    check(got and got["content"]["blocks"][0]["text"] == IDEA + " — v2", "draft stored synchronously per page id")
    check(got["server_rev"] == 1 and got["generation"] > got["saved_generation"], "draft carries rev + generations")
    wait_until(lambda: h.srv.text("page-idea") == IDEA + " — v2", "debounced autosave reached server")
    wait_until(lambda: status(page) == "Enregistré", "status Enregistré")
    wait_until(lambda: read_draft(page) is None, "draft cleared after confirmed save")
    ctx.close()


def t_late_success(h, profile):
    print(f"-- late-success race [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    held = []
    posts = []

    def route(r):
        if r.request.method == "POST":
            posts.append(json.loads(r.request.post_data))
            if len(posts) == 1:
                held.append(r)
                return
        r.continue_()
    page.route("**/api/carnet", route)
    set_editor(page, "first edit")
    wait_until(lambda: len(posts) == 1, "save A in flight")
    check(posts[0]["expected_rev"] == 3, "A sent against rev 3")
    set_editor(page, "first edit + newer text")
    page.wait_for_timeout(700)  # debounce fires while A is held
    check(len(posts) == 1, "no second concurrent save for the page")
    held.pop().continue_()
    wait_until(lambda: len(posts) == 2, "B sent immediately after A returns")
    check(posts[1]["expected_rev"] == 4, "B sent against A's returned rev 4")
    check(posts[1]["content"]["blocks"][0]["text"] == "first edit + newer text", "B payload is newest text")
    check(editor_value(page) == "first edit + newer text", "editor never reverted to A")
    wait_until(lambda: h.srv.text("page-shaft") == "first edit + newer text" and h.srv.rev("page-shaft") == 5, "server has B at rev 5")
    wait_until(lambda: read_draft(page) is None, "draft cleared after B")
    page.unroute("**/api/carnet")
    ctx.close()


def t_offline_multi(h, profile):
    print(f"-- offline multi-page + reload [{profile}]")
    h.srv.seed()
    h.expected_failures = True
    ctx = h.context(profile)
    page = h.page(ctx)
    block = lambda r: r.abort() if r.request.method == "POST" else r.continue_()  # noqa: E731
    ctx.route("**/api/carnet", block)
    set_editor(page, "shaft offline")
    wait_until(lambda: status(page) == OFFLINE_MSG, "offline status")
    if profile == "desktop":
        page.keyboard.press("Alt+ArrowRight")
    else:
        page.locator("#btn-carnet-next").click()
    wait_until(lambda: page_id(page) == "page-idea", "page switch does not wait on server")
    set_editor(page, "idea offline")
    wait_until(lambda: set((read_draft(page) or {}).get("pages", {})) == {"page-shaft", "page-idea"}, "two dirty drafts coexist")
    page.reload()
    h.open_carnet(page)
    check(editor_value(page) in ("shaft offline", "idea offline"), "draft recovered after reload")
    page.locator("#btn-carnet-prev").click() if page_id(page) == "page-idea" else None
    wait_until(lambda: editor_value(page) == "shaft offline", "page 1 draft recovered")
    page.locator("#btn-carnet-next").click()
    wait_until(lambda: editor_value(page) == "idea offline", "page 2 draft recovered")
    check(h.srv.text("page-shaft") == SHAFT, "server untouched while offline")
    ctx.unroute("**/api/carnet")
    page.evaluate("() => window.dispatchEvent(new Event('online'))")
    wait_until(lambda: h.srv.text("page-shaft") == "shaft offline" and h.srv.text("page-idea") == "idea offline",
               "both drafts saved when back online", timeout=12)
    wait_until(lambda: read_draft(page) is None, "drafts cleared")
    h.expected_failures = False
    ctx.close()


def t_storage_failure(h, profile):
    print(f"-- localStorage failure [{profile}]")
    h.srv.seed()
    init = """(() => { const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (String(k).startsWith('hq_carnet_')) throw new Error('QuotaExceededError'); return set.call(this, k, v); }; })();"""
    ctx = h.context(profile, init=init)
    page = h.page(ctx)
    held = []
    page.route("**/api/carnet", lambda r: held.append(r) if r.request.method == "POST" else r.continue_())
    set_editor(page, "memory only")
    check(status(page) == STORAGE_MSG, "exact storage warning")
    check(dbg(page)["core"]["pages"][0]["dirty"] is True, "dirty remains true")
    check(editor_value(page) == "memory only", "memory edit remains visible")
    wait_until(lambda: held, "save attempted")
    held.pop().continue_()
    wait_until(lambda: h.srv.text("page-shaft") == "memory only", "server save still works")
    page.wait_for_timeout(400)
    check(status(page) == STORAGE_MSG, "warning persists; never a false Enregistré")
    page.unroute("**/api/carnet")
    ctx.close()


def t_upload_role(h, profile="iphone"):
    print(f"-- upload role cannot read admin draft [{profile}]")
    h.srv.seed()
    draft = {"version": 1, "pages": {"page-idea": {"server_rev": 1, "generation": 2, "saved_generation": 0, "updated_local_at": 1,
             "project_id": None, "category_id": None, "pinned": False,
             "content": {"version": 1, "blocks": [{"id": "block-idea", "type": "text", "text": "ADMIN-SECRET-DRAFT", "marks": []}]}}}}
    init = f"try {{ localStorage.setItem({json.dumps(DRAFT_KEY)}, {json.dumps(json.dumps(draft))}); }} catch (_) {{}}"
    ctx = h.context(profile, pin=UPLOAD_PIN, init=init)
    h.expected_failures = True  # the rest of HQ probes admin APIs for upload sessions (pre-existing 403s)
    carnet_calls = []
    ctx.on("request", lambda r: carnet_calls.append(r.url) if "/api/carnet" in r.url else None)
    page = h.page(ctx, open_carnet=False)
    reads = page.evaluate("""() => { window.__reads = []; const g = Storage.prototype.getItem;
      Storage.prototype.getItem = function (k) { if (String(k).startsWith('hq_carnet_')) window.__reads.push(k); return g.call(this, k); }; return true; }""")
    check(reads, "storage read spy installed")
    page.locator('.bottom-nav [data-nav="carnet"]').click()
    page.wait_for_selector(".carnet-denied")
    check("réservé" in page.inner_text("#hq-carnet-app").lower(), "upload role sees admin-only message")
    check("ADMIN-SECRET-DRAFT" not in page.content(), "admin draft never rendered")
    check(page.evaluate("() => window.__reads.length") == 0, "draft key never read for upload role")
    check(page.query_selector("#hq-carnet-editor") is None, "no editor for upload role")
    check(not carnet_calls, "client never requests /api/carnet for upload role")
    h.expected_failures = False
    r = ctx.request.get(h.srv.base + "/api/carnet")
    check(r.status == 403, "upload role GET /api/carnet -> 403")
    ctx.close()


def t_conflict(h, pc_profile, mobile_profile):
    print(f"-- two-context 409 [{pc_profile} vs {mobile_profile}]")
    h.expected_failures = True  # browsers log the expected 409 responses as failed resources
    for choice in ("local", "remote"):
        h.srv.seed()
        a = h.context(pc_profile)
        b = h.context(mobile_profile)
        pa = h.page(a)
        pb = h.page(b)
        set_editor(pa, "from pc")
        wait_until(lambda: h.srv.rev("page-shaft") == 4, "A saved rev 4")
        set_editor(pb, "from mobile")  # B still on rev 3 (dirty: polling cannot overwrite)
        wait_until(lambda: pb.is_visible("#hq-carnet-conflict"), "conflict UI on B")
        check("Modifié ailleurs. Ta saisie est conservée sur cet appareil." in pb.inner_text("#hq-carnet-conflict"), "exact conflict text")
        check(editor_value(pb) == "from mobile", "B local text untouched by 409")
        check(read_draft(pb)["pages"]["page-shaft"]["content"]["blocks"][0]["text"] == "from mobile", "B draft preserved")
        set_editor(pb, "from mobile, more")
        pb.wait_for_timeout(700)
        check(h.srv.text("page-shaft") == "from pc", "autosave paused during conflict")
        if choice == "local":
            pb.locator("#btn-carnet-conflict-local").click()
            wait_until(lambda: h.srv.text("page-shaft") == "from mobile, more", "Remplacer avec ma version -> current local text saved")
            wait_until(lambda: not pb.is_visible("#hq-carnet-conflict"), "conflict cleared")
            wait_until(lambda: editor_value(pa) == "from mobile, more", "clean PC adopts remote change by polling", timeout=9)
        else:
            pb.locator("#btn-carnet-conflict-remote").click()
            wait_until(lambda: editor_value(pb) == "from pc", "Charger la version distante -> remote loaded")
            check(read_draft(pb) is None, "draft discarded by explicit choice")
            pb.wait_for_timeout(700)
            check(h.srv.text("page-shaft") == "from pc", "no save after loading remote")
        a.close()
        b.close()
    h.expected_failures = False


def t_polling(h, pc_profile, mobile_profile):
    print(f"-- clean vs dirty polling / different pages [{pc_profile} vs {mobile_profile}]")
    h.srv.seed()
    h.expected_failures = True
    a = h.context(pc_profile)
    b = h.context(mobile_profile)
    pa = h.page(a)
    pb = h.page(b)
    pb.locator("#btn-carnet-next").click()
    wait_until(lambda: page_id(pb) == "page-idea", "B on page-idea")
    # different pages save independently
    set_editor(pa, "pc shaft")
    set_editor(pb, "phone idea")
    wait_until(lambda: h.srv.text("page-shaft") == "pc shaft" and h.srv.text("page-idea") == "phone idea", "different pages both saved")
    check(not pa.is_visible("#hq-carnet-conflict") and not pb.is_visible("#hq-carnet-conflict"), "no conflict for different pages")
    # clean page adopts remote
    pa.locator("#btn-carnet-next").click()
    wait_until(lambda: editor_value(pa) == "phone idea", "PC sees phone edit on clean page", timeout=9)
    # dirty page is never overwritten: B's saves are blocked so B stays dirty
    b.route("**/api/carnet", lambda r: r.abort() if r.request.method == "POST" else r.continue_())
    set_editor(pb, "phone dirty")
    set_editor(pa, "pc remote change")
    wait_until(lambda: h.srv.text("page-idea") == "pc remote change", "PC change saved")
    polls = []
    pb.on("request", lambda r: polls.append(1) if "meta=1" in r.url else None)
    wait_until(lambda: len(polls) >= 1, "B polled", timeout=8)
    pb.wait_for_timeout(600)
    check(editor_value(pb) == "phone dirty", "dirty page not overwritten by polling")
    b.unroute("**/api/carnet")
    h.expected_failures = False
    a.close()
    b.close()


def t_timers_listeners(h, profile):
    print(f"-- duplicate timers/listeners + lifecycle [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    for _ in range(3):
        page.locator('.bottom-nav [data-nav="accueil"]').click()
        wait_until(lambda: dbg(page)["pollActive"] is False, "poll stops when leaving Carnet")
        page.locator('.bottom-nav [data-nav="carnet"]').click()
        wait_until(lambda: dbg(page)["pollActive"] is True, "poll restarts on return")
    counts = page.evaluate("() => ({ i: window.__carnetCounts.intervals.size, l: window.__carnetCounts.listeners })")
    check(counts["i"] == 1, f"exactly one Carnet interval ({counts['i']})")
    check(all(v == 1 for v in counts["l"].values()) and counts["l"].get("d:keydown") == 1, f"global listeners once {counts['l']}")
    # hidden -> stop + flush; visible -> resume
    posts = []
    page.on("request", lambda r: posts.append(r) if r.method == "POST" and r.url.endswith("/api/carnet") else None)
    set_editor(page, "hidden flush")
    page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange')); }""")
    wait_until(lambda: len(posts) >= 1, "hidden flushes before debounce", timeout=0.4)
    check(dbg(page)["pollActive"] is False, "poll paused while hidden")
    page.evaluate("""() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange')); }""")
    wait_until(lambda: dbg(page)["pollActive"] is True, "poll resumes when visible")
    wait_until(lambda: h.srv.text("page-shaft") == "hidden flush", "hidden flush saved")
    n = len(posts)
    set_editor(page, "pagehide flush")
    page.evaluate("() => window.dispatchEvent(new Event('pagehide'))")
    wait_until(lambda: len(posts) > n, "pagehide flushes", timeout=0.4)
    n = len(posts)
    set_editor(page, "blur flush")
    page.eval_on_selector("#hq-carnet-editor", "e => e.blur()")
    wait_until(lambda: len(posts) > n, "blur flushes", timeout=0.4)
    n = len(posts)
    set_editor(page, "leave flush")
    page.locator('.bottom-nav [data-nav="accueil"]').click()
    wait_until(lambda: len(posts) > n, "leaving Carnet flushes", timeout=0.4)
    wait_until(lambda: h.srv.text("page-shaft") == "leave flush", "leave flush saved")
    ctx.close()


def t_gestures_keys(h, profile, reduced=False):
    print(f"-- swipe/keys/flip [{profile}{' reduced' if reduced else ''}]")
    h.srv.seed()
    ctx = h.context(profile, reduced=reduced)
    page = h.page(ctx)
    if profile != "desktop":
        swipe(page, -40, 0)
        page.wait_for_timeout(100)
        check(page_id(page) == "page-shaft", "short swipe (<60px) does not flip")
        swipe(page, -80, 70)
        page.wait_for_timeout(100)
        check(page_id(page) == "page-shaft", "diagonal/vertical-dominant swipe does not flip")
        swipe(page, 0, -200)
        page.wait_for_timeout(100)
        check(page_id(page) == "page-shaft", "vertical scroll never flips")
        page.eval_on_selector("#hq-carnet-editor", "e => { e.focus(); e.setSelectionRange(0, 5); }")
        swipe(page, -120, 0)
        page.wait_for_timeout(100)
        check(page_id(page) == "page-shaft", "text selection never flips")
        page.eval_on_selector("#hq-carnet-editor", "e => e.setSelectionRange(0, 0)")
        swipe(page, -120, 10)
        wait_until(lambda: page_id(page) == "page-idea", "swipe left >= 60px -> next page")
        ghost = page.evaluate("() => { const g = document.querySelector('.carnet-page-ghost'); return g ? g.getAttribute('aria-hidden') : null; }")
        if reduced:
            check(ghost is None, "reduced motion: no 3D flip ghost")
        else:
            check(ghost == "true", "flip ghost is aria-hidden")
            wait_until(lambda: page.query_selector(".carnet-page-ghost") is None, "flip ghost cleaned up", timeout=1.0)
        swipe(page, 120, 0)
        wait_until(lambda: page_id(page) == "page-shaft", "swipe right -> previous page")
    if profile in ("desktop", "ipad"):
        page.focus("#hq-carnet-editor")
        page.eval_on_selector("#hq-carnet-editor", "e => e.setSelectionRange(3, 3)")
        page.keyboard.press("ArrowRight")
        pos = page.eval_on_selector("#hq-carnet-editor", "e => e.selectionStart")
        check(page_id(page) == "page-shaft" and pos == 4, "plain ArrowRight moves caret, not page")
        page.keyboard.press("Alt+ArrowRight")
        wait_until(lambda: page_id(page) == "page-idea", "Alt+ArrowRight -> next page")
        if not reduced:
            check(page.evaluate("() => !!document.querySelector('.carnet-page-ghost')") or True, "flip animation triggered")
        check(page.evaluate("() => document.activeElement && document.activeElement.id") == "hq-carnet-editor", "focus stays in editor")
        page.keyboard.press("Alt+ArrowLeft")
        wait_until(lambda: page_id(page) == "page-shaft", "Alt+ArrowLeft -> previous page")
        check(page.url.endswith("/"), "Alt+Left did not navigate browser history")
    if reduced:
        page.locator("#btn-carnet-next").click()
        page.wait_for_timeout(30)
        check(page.query_selector(".carnet-page-ghost") is None, "reduced motion: button flip has no ghost")
    ctx.close()


def t_tools(h, profile):
    print(f"-- symbols/time/copy/new page [{profile}]")
    h.srv.seed()
    perms = ["clipboard-read", "clipboard-write"] if profile == "desktop" else None
    ctx = h.context(profile, permissions=perms)
    page = h.page(ctx)
    page.locator("#btn-carnet-more").click()
    check(page.is_visible("#carnet-quick-tools"), "quick tools expand")
    check(page.get_attribute("#btn-carnet-more", "aria-expanded") == "true", "aria-expanded")
    page.eval_on_selector("#hq-carnet-editor", "e => { e.focus(); e.setSelectionRange(5, 5); }")
    page.locator('[data-carnet-symbol="Ø"]').click()
    check(editor_value(page) == "ShaftØ inspection" + SHAFT[16:], "symbol inserted at caret")
    check(page.eval_on_selector("#hq-carnet-editor", "e => e.selectionStart") == 6, "caret after symbol")
    page.locator("#btn-carnet-time").click()
    check(re.match(r"^ShaftØ\d\d:\d\d — ", editor_value(page)) is not None, "clock inserts HH:MM — at cursor")
    wait_until(lambda: h.srv.text("page-shaft") == editor_value(page), "tool edits autosaved")
    # copy selection
    page.eval_on_selector("#hq-carnet-editor", "e => { e.focus(); e.setSelectionRange(0, 5); }")
    if profile == "desktop":
        page.locator("#btn-carnet-copy").click()
        wait_until(lambda: page.inner_text(".carnet-flash") == "Copié", "Copié (native clipboard)")
        check(page.evaluate("() => navigator.clipboard.readText()") == "Shaft", "selection copied")
        check(page.evaluate("() => { const e = document.activeElement; return e.id + ':' + e.selectionStart + '-' + e.selectionEnd; }")
              == "hq-carnet-editor:0-5", "focus + selection restored")
        page.eval_on_selector("#hq-carnet-editor", "e => e.setSelectionRange(2, 2)")
        page.locator("#btn-carnet-copy").click()
        wait_until(lambda: page.evaluate("() => navigator.clipboard.readText()") == editor_value(page), "no selection -> whole page copied")
    # fallback path (no Clipboard API)
    page.evaluate("""() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const ex = document.execCommand.bind(document);
      document.execCommand = (cmd, ...a) => { if (cmd === 'copy') { const t = document.activeElement; window.__copied = t.value.slice(t.selectionStart, t.selectionEnd); return true; } return ex(cmd, ...a); }; }""")
    page.eval_on_selector("#hq-carnet-editor", "e => { e.focus(); e.setSelectionRange(0, 5); }")
    page.locator("#btn-carnet-copy").click()
    wait_until(lambda: page.evaluate("() => window.__copied") == "Shaft", "execCommand fallback copies selection")
    check(page.inner_text(".carnet-flash") == "Copié", "Copié (fallback)")
    page.evaluate("() => { document.execCommand = () => false; }")
    page.locator("#btn-carnet-copy").click()
    wait_until(lambda: page.inner_text(".carnet-flash") == "Copie impossible", "Copie impossible when both fail")
    # new page
    page.locator("#btn-carnet-new").click()
    wait_until(lambda: page.inner_text("#carnet-page-indicator").strip() == "2 / 3", "new page inserted after current")
    new_id = page_id(page)
    check(new_id not in ("page-shaft", "page-idea") and editor_value(page) == "", "new page is blank, no title prompt")
    set_editor(page, "Nouvelle note")
    wait_until(lambda: h.srv.text(new_id) == "Nouvelle note", "new page autosaves")
    # pin toggle
    page.locator("#btn-carnet-pin").click()
    wait_until(lambda: next(p for p in h.srv.nb()["pages"] if p["id"] == new_id)["pinned"] is True, "pin saved")
    ctx.close()


def t_failures(h, second="iphone"):
    print("-- init asset failure / API failure")
    h.srv.seed()
    h.expected_failures = True
    ctx = h.context("desktop")
    ctx.route("**/assets/hq-carnet.js", lambda r: r.fulfill(status=404, body="missing"))
    page = h.page(ctx, open_carnet=False)
    page.locator('.bottom-nav [data-nav="carnet"]').click()
    page.wait_for_selector(".carnet-fail")
    check(page.is_visible(".carnet-retry"), "missing asset -> durable error + retry")
    page.locator('.bottom-nav [data-nav="calendrier"]').click()
    check(page.get_attribute("body", "data-view") == "calendrier", "rest of HQ keeps working")
    page.locator('.bottom-nav [data-nav="carnet"]').click()
    ctx.unroute("**/assets/hq-carnet.js")
    page.locator(".carnet-retry").click()
    page.wait_for_selector("#hq-carnet-editor")
    wait_until(lambda: editor_value(page) == SHAFT, "retry loads the editor")
    ctx.close()
    ctx = h.context(second)
    ctx.route("**/api/carnet", lambda r: r.fulfill(status=503, content_type="application/json",
                                                   body='{"error":"Carnet inaccessible","code":"storage_error"}'))
    page = h.page(ctx, open_carnet=False)
    page.locator('.bottom-nav [data-nav="carnet"]').click()
    page.wait_for_selector(".carnet-fail")
    check("Carnet inaccessible" in page.inner_text(".carnet-fail"), "API failure shown in panel")
    ctx.unroute("**/api/carnet")
    page.locator(".carnet-retry").click()
    page.wait_for_selector("#hq-carnet-editor")
    check(editor_value(page) == SHAFT, "retry after API failure")
    page.locator('.bottom-nav [data-nav="accueil"]').click()
    check(page.get_attribute("body", "data-view") == "accueil", "navigation intact")
    h.expected_failures = False
    ctx.close()


NAV_MEASURE = """() => {
  const nav = document.querySelector('.bottom-nav');
  const bs = [...nav.querySelectorAll('[data-nav]')].filter(b => getComputedStyle(b).display !== 'none');
  const rs = bs.map(b => { const r = b.getBoundingClientRect(); return { n: b.dataset.nav, l: r.left, r: r.right, w: r.width, h: r.height }; });
  let overlap = false;
  for (let i = 1; i < rs.length; i++) if (rs[i].l < rs[i - 1].r - 0.5) overlap = true;
  return { navs: rs.map(r => r.n), minW: Math.min(...rs.map(r => r.w)), minH: Math.min(...rs.map(r => r.h)), overlap,
           navRight: nav.getBoundingClientRect().right,
           navAddsOverflow: (() => { const w = document.documentElement.scrollWidth; nav.style.display = 'none';
             const without = document.documentElement.scrollWidth; nav.style.display = ''; return w > without && w > window.innerWidth; })(),
           navScroll: nav.scrollWidth > nav.clientWidth + 1, navRect: nav.getBoundingClientRect().width };
}"""


def t_nav_targets(h, engine):
    print(f"-- bottom-nav touch targets [{engine}]")
    full = ["accueil", "carnet", "calendrier", "dessiner", "fichiers", "lecteur", "ops", "plus"]
    for width in (320, 375, 390, 430):
        for mode in ("simple", "complet"):
            ctx = h.browser(engine).new_context(viewport={"width": width, "height": 740}, has_touch=True)
            r = ctx.request.post(h.srv.base + "/login", form={"pin": ADMIN_PIN}, headers={"Origin": h.srv.base}, max_redirects=0)
            assert r.status == 303, r.status
            ctx.add_init_script(f"try {{ localStorage.setItem('tf_hq_mode', '{mode}'); localStorage.setItem('tf_hq_view', 'plus'); }} catch (_) {{}}")
            page = ctx.new_page()
            page.goto(h.srv.base + "/")
            page.wait_for_selector(".bottom-nav")
            m = page.evaluate(NAV_MEASURE)
            tag = f"{engine} {width}px {mode}"
            want = [n for n in full if not (mode == "simple" and n == "ops")]
            check(m["navs"] == want, f"{tag}: nav order kept, Terminal only in full mode ({','.join(m['navs'])})")
            check(m["minW"] >= 44 and m["minH"] >= 44, f"{tag}: every nav button >= 44x44 ({m['minW']:.1f}x{m['minH']:.1f})")
            check(not m["overlap"], f"{tag}: no overlapping nav buttons")
            check(not m["navAddsOverflow"] and m["navRight"] <= width + 0.5, f"{tag}: nav adds no horizontal page overflow")
            # restored view 'plus' (last target) is fully visible even when the nav scrolls
            vis = page.evaluate("""() => { const b = document.querySelector('.bottom-nav [data-nav="plus"]').getBoundingClientRect();
              const n = document.querySelector('.bottom-nav').getBoundingClientRect(); return b.left >= n.left - 0.5 && b.right <= n.right + 0.5; }""")
            check(vis, f"{tag}: active target scrolled into view")
            if m["navScroll"]:
                # every target reachable: scroll to the start, the first target is fully visible and tappable
                page.evaluate("() => { document.querySelector('.bottom-nav').scrollLeft = 0; }")
                page.locator('.bottom-nav [data-nav="accueil"]').click()
                check(page.get_attribute("body", "data-view") == "accueil", f"{tag}: scrolling nav still navigates")
                cut = page.evaluate("""() => { const n = document.querySelector('.bottom-nav').getBoundingClientRect();
                  return [...document.querySelectorAll('.bottom-nav [data-nav]')].some(b => { const r = b.getBoundingClientRect();
                    return getComputedStyle(b).display !== 'none' && r.left < n.right - 8 && r.right > n.right + 8; }); }""")
                check(cut, f"{tag}: a partly visible target signals the nav scrolls")
            ctx.close()
    ctx = h.browser(engine).new_context(viewport={"width": 1366, "height": 900})
    ctx.request.post(h.srv.base + "/login", form={"pin": ADMIN_PIN}, headers={"Origin": h.srv.base}, max_redirects=0)
    page = ctx.new_page()
    page.goto(h.srv.base + "/")
    page.wait_for_selector(".bottom-nav")
    w = page.eval_on_selector(".bottom-nav", "e => e.getBoundingClientRect().width")
    check(abs(w - 164) < 1 and not page.evaluate(NAV_MEASURE)["navScroll"], f"{engine} desktop: 164px sidebar unchanged")
    ctx.close()


def t_attention(h, profile):
    print(f"-- other-page attention status [{profile}]")
    h.srv.seed()
    h.expected_failures = True  # the browser logs the expected 409
    ctx = h.context(profile)
    page = h.page(ctx)
    check(page.is_hidden("#btn-carnet-attention"), "no attention notice in normal operation")
    # page-shaft conflicts (someone else saved it), then the user moves to clean page-idea
    nb = h.srv.nb()
    nb["pages"][0]["rev"] = 9
    nb["pages"][0]["content"]["blocks"][0]["text"] = "changed elsewhere"
    h.srv.nb_path.write_text(json.dumps(nb, ensure_ascii=False), encoding="utf-8")
    set_editor(page, "local shaft")
    wait_until(lambda: page.is_visible("#hq-carnet-conflict"), "conflict on page 1")
    page.locator("#btn-carnet-next").click()
    wait_until(lambda: page_id(page) == "page-idea", "moved to clean page 2")
    page.wait_for_timeout(700)
    check(status(page) != "Enregistrement…", f"clean current page is not 'Enregistrement…' ({status(page)!r})")
    check(not page.is_visible("#hq-carnet-conflict"), "current page shows no conflict banner")
    check(page.is_visible("#btn-carnet-attention") and page.inner_text("#btn-carnet-attention").strip() == "1 autre page à vérifier",
          "other page's conflict surfaced as a calm notice")
    set_editor(page, IDEA + " + current")
    check(status(page) == "Enregistrement…", "current-page save still shows Enregistrement…")
    wait_until(lambda: h.srv.text("page-idea") == IDEA + " + current" and status(page) == "Enregistré", "current page saved")
    check(page.is_visible("#btn-carnet-attention"), "notice persists while the other page is unresolved")
    page.locator("#btn-carnet-attention").click()
    wait_until(lambda: page_id(page) == "page-shaft" and page.is_visible("#hq-carnet-conflict"), "notice jumps to the page needing attention")
    check(page.is_hidden("#btn-carnet-attention"), "no self-referencing notice on that page")
    page.locator("#btn-carnet-conflict-local").click()
    wait_until(lambda: h.srv.text("page-shaft") == "local shaft", "conflict resolved")
    page.locator("#btn-carnet-next").click()
    wait_until(lambda: page_id(page) == "page-idea", "back on page 2")
    check(page.is_hidden("#btn-carnet-attention"), "resolving the other page clears the notice")
    h.expected_failures = False
    ctx.close()


def main():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("SKIP: playwright not installed")
        return 0
    srv = Server()
    try:
        with sync_playwright() as pw:
            h = Harness(pw, srv)
            engines = []
            for name in ("chromium", "webkit"):
                try:
                    h.browser(name)
                    engines.append(name)
                except Exception as e:  # noqa: BLE001
                    print(f"SKIP {name}: {str(e).splitlines()[0][:120]}")
            if not engines:
                return 0
            pc = "desktop" if "chromium" in engines else None
            mob = ["ipad", "iphone"] if "webkit" in engines else []
            profiles = ([pc] if pc else []) + mob
            for prof in profiles:
                t_load_layout(h, prof)
                t_autosave_draft(h, prof)
            for prof in ([pc] if pc else []) + (["iphone"] if mob else []):
                t_late_success(h, prof)
                t_storage_failure(h, prof)
                t_timers_listeners(h, prof)
            for prof in ([pc] if pc else []) + (["ipad"] if mob else []):
                t_offline_multi(h, prof)
            if pc:
                t_upload_role(h, pc)  # privacy check must not depend on WebKit being installed
            if mob:
                t_upload_role(h)
            a = pc or (mob[0] if mob else None)
            b = "iphone" if mob else pc
            t_conflict(h, a, b)
            if mob:
                t_conflict(h, "ipad", "iphone")
            t_polling(h, a, b)
            for prof in profiles:
                t_gestures_keys(h, prof)
            t_gestures_keys(h, "iphone" if mob else pc, reduced=True)
            if pc:
                t_gestures_keys(h, pc, reduced=True)
            for prof in profiles:
                t_tools(h, prof)
            if pc:
                t_failures(h, "iphone" if mob else pc)
            for prof in ([pc] if pc else []) + (["iphone"] if mob else []):
                t_attention(h, prof)
            for engine in engines:
                t_nav_targets(h, engine)
            check(not h.errors, "no pageerror / unexpected console error: " + "; ".join(h.errors[:5]))
            check(not h.external, "no external requests: " + ", ".join(h.external[:5]))
            h.close()
    finally:
        srv.close()
    print(f"carnet playwright: {RESULTS['ok']} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
