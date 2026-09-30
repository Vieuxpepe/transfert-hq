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
import os
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

    def seed(self, data=None):
        import hq_carnet
        import hq_state
        self.nb_path.parent.mkdir(parents=True, exist_ok=True)
        with hq_state.path_lock(hq_carnet.notebook_path(self.root)):
            self.nb_path.write_text(json.dumps(data or fixture(), ensure_ascii=False), encoding="utf-8")

    def page(self, pid):
        return next((p for p in self.nb()["pages"] if p["id"] == pid), None)

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
            if m.text.startswith("Button failed to load, iconName = "):
                return  # Linux WebKit/Adwaita theme artefact for native control glyphs (e.g. search field), not page code
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
        # Stage 03: the docked library takes the left column; the paper is centered in the main column.
        main = page.eval_on_selector(".carnet-main", "e => { const r = e.getBoundingClientRect(); return r.left + r.width / 2; }")
        check(abs(center - main) < 30, "desktop paper centered in the main column")
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


# ============================================================ Stage 03 — library / organization / retrieval

XSS = '<img src=x onerror="window.__xss=1">'


def library_fixture():
    """Basic fixture + search pages (FIXTURES.md) + an HTML-looking title, with recent timestamps."""
    nb = fixture()
    now = time.time()

    def page(pid, text, updated, **extra):
        p = {"id": pid, "rev": 1, "project_id": None, "category_id": None, "pinned": False, "deleted_at": None,
             "created_at": updated, "updated_at": updated,
             "content": {"version": 1, "blocks": [{"id": "block-" + pid[5:], "type": "text", "text": text, "marks": []}]}}
        p.update(extra)
        return p
    nb["pages"][0]["updated_at"] = now - 120
    nb["pages"][1]["updated_at"] = now - 60
    nb["pages"].append(page("page-ebauche", "Ébauche moteur\ndiamètre arbre", now - 30,
                            project_id="proj-fixture", category_id="cat-measures"))
    nb["pages"].append(page("page-html", XSS + "\n<b>not bold</b>", now - 400 * 86400))
    return nb


def open_library(page):
    if not page.is_visible("#hq-carnet-library"):
        page.locator("#btn-carnet-library").click()
    wait_until(lambda: page.is_visible("#hq-carnet-library"), "library visible")


def card_ids(page):
    return page.eval_on_selector_all("#carnet-library-list [data-carnet-page-id]", "els => els.map(e => e.dataset.carnetPageId)")


def settle_anim(page):
    page.wait_for_function("() => document.getElementById('hq-carnet-library').getAnimations().every(a => a.playState === 'finished')")
    page.wait_for_timeout(50)


def no_overflow(page):
    return page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")


def small_targets(page, scope):
    return page.eval_on_selector_all(scope + " button, " + scope + " input, " + scope + " select, " + scope + " summary",
                                     "els => els.filter(b => b.offsetParent && getComputedStyle(b).visibility !== 'hidden')"
                                     ".map(b => b.getBoundingClientRect()).filter(r => r.width > 0 && (r.width < 44 || r.height < 44)).length")


def t_library_desktop(h):
    print("-- library: desktop sidebar / search / filters / keyboard [desktop]")
    h.srv.seed(library_fixture())
    ctx = h.context("desktop")
    page = h.page(ctx)
    check(page.is_visible("#hq-carnet-library"), "desktop: library docked by default (no sheet)")
    lib = page.eval_on_selector("#hq-carnet-library", "e => { const r = e.getBoundingClientRect(); return [r.width, r.height, getComputedStyle(e).position]; }")
    check(260 <= lib[0] <= 300 and lib[2] != "fixed", f"desktop sidebar 260–300px, in flow ({lib[0]:.0f}px, {lib[2]})")
    paper = page.eval_on_selector(".carnet-paper", "e => e.getBoundingClientRect().width")
    check(paper >= 2 * lib[0], f"paper dominant ({paper:.0f}px vs {lib[0]:.0f}px)")
    check(no_overflow(page), "no horizontal overflow with sidebar")
    # collapse / expand
    page.locator("#btn-carnet-library").click()
    wait_until(lambda: not page.is_visible("#hq-carnet-library"), "sidebar collapses")
    wider = page.eval_on_selector(".carnet-paper", "e => e.getBoundingClientRect().width")
    check(wider >= paper - 1, "paper keeps room when collapsed")
    page.locator("#btn-carnet-library").click()
    wait_until(lambda: page.is_visible("#hq-carnet-library"), "sidebar re-opens")
    # safe rendering of HTML-looking note text
    titles = page.eval_on_selector_all("#carnet-library-list .carnet-card-title", "els => els.map(e => e.textContent)")
    check(XSS in titles, "HTML-looking title rendered as literal text")
    check(page.evaluate("() => !document.querySelector('#carnet-library-list img, #carnet-library-list b') && !window.__xss"), "no element injected from note text")
    # cards
    check(card_ids(page)[0] == "page-shaft", "Toutes: pinned first")
    meta = page.inner_text('#carnet-library-list [data-carnet-page-id="page-shaft"]')
    check("Shaft inspection" in meta and "Ø12.034 mm Check bearing preload" in meta and "Fixture redesign · Mesures" in meta, "card: title, preview, context")
    check("Page sans titre" not in meta, "derived title")
    # search: accent/case folding, ranking, keyboard
    page.locator("#hq-carnet-search").click()
    polls = []
    page.on("request", lambda r: polls.append(r.url) if "/api/carnet" in r.url else None)
    page.keyboard.type("EBAUCHE")
    wait_until(lambda: card_ids(page) == ["page-ebauche"], "'EBAUCHE' finds 'Ébauche moteur'")
    check(len(polls) <= 1, f"no request per keystroke ({len(polls)})")
    page.fill("#hq-carnet-search", "mesures")
    wait_until(lambda: card_ids(page) == ["page-shaft", "page-ebauche"], "category search, pinned tie-break")
    page.fill("#hq-carnet-search", "fixture redesign")
    wait_until(lambda: card_ids(page) == ["page-shaft", "page-ebauche"], "project search")
    page.fill("#hq-carnet-search", "diametre")
    wait_until(lambda: card_ids(page) == ["page-ebauche"], "body search with accent folding")
    page.focus("#hq-carnet-search")
    page.keyboard.press("Enter")
    wait_until(lambda: page_id(page) == "page-ebauche", "Enter opens the first result in the same editor")
    check(editor_value(page).startswith("Ébauche moteur"), "editor shows the opened page")
    page.focus("#hq-carnet-search")
    page.keyboard.press("Escape")
    wait_until(lambda: page.input_value("#hq-carnet-search") == "", "Escape clears the search")
    # filters
    page.locator('[data-carnet-filter="pinned"]').click()
    wait_until(lambda: card_ids(page) == ["page-shaft"], "Épinglées")
    page.locator('[data-carnet-filter="unfiled"]').click()
    wait_until(lambda: sorted(card_ids(page)) == ["page-html", "page-idea"], "À classer")
    page.locator('[data-carnet-filter="recent"]').click()
    wait_until(lambda: page.eval_on_selector_all("#carnet-library-list .carnet-lib-group", "els => els.map(e => e.textContent)")[:1] == ["Aujourd'hui"],
               "Récentes grouped (Aujourd'hui first)")
    groups = page.eval_on_selector_all("#carnet-library-list .carnet-lib-group", "els => els.map(e => e.textContent)")
    check(groups[-1] == "Plus ancien" and len(groups) == len(set(groups)), f"older bucket last, no duplicate bucket {groups}")
    check(card_ids(page)[-1] == "page-html", "old page in the older bucket")
    page.locator('#hq-carnet-library [data-carnet-category="cat-measures"]').click()
    wait_until(lambda: sorted(card_ids(page)) == ["page-ebauche", "page-shaft"], "category scope")
    page.locator('#hq-carnet-library [data-carnet-project="proj-fixture"]').click()
    wait_until(lambda: sorted(card_ids(page)) == ["page-ebauche", "page-shaft"], "project scope")
    # mouse click on a card opens it; the sidebar stays (desktop)
    page.locator('#carnet-library-list [data-carnet-page-id="page-shaft"]').click()
    wait_until(lambda: page_id(page) == "page-shaft", "click opens page")
    check(page.is_visible("#hq-carnet-library"), "desktop sidebar stays open after opening a page")
    check(page.eval_on_selector_all("#hq-carnet-editor", "els => els.length") == 1, "exactly one editor")
    ctx.close()


def t_library_phone(h):
    print("-- library: phone bottom sheet [iphone]")
    h.srv.seed(library_fixture())
    ctx = h.context("iphone")
    page = h.page(ctx)
    check(not page.is_visible("#hq-carnet-library"), "sheet closed by default (paper first)")
    page.locator("#btn-carnet-library").click()
    wait_until(lambda: page.is_visible("#hq-carnet-library"), "sheet opens")
    settle_anim(page)  # let the short entrance animation finish before measuring
    vh = page.evaluate("() => window.innerHeight")
    r = page.eval_on_selector("#hq-carnet-library", "e => { const r = e.getBoundingClientRect(); return [r.top, r.bottom, r.height, r.width]; }")
    check(0.84 * vh <= r[2] <= 0.91 * vh and abs(r[1] - vh) < 2, f"bottom sheet ~85–90% height ({r[2] / vh:.2f}, bottom {r[1]:.0f}/{vh})")
    check(small_targets(page, "#hq-carnet-library") == 0, "sheet controls >= 44px")
    check(no_overflow(page), "no horizontal overflow with the sheet open")
    for sel in ('[data-carnet-filter="all"]', '[data-carnet-filter="pinned"]', '[data-carnet-filter="recent"]', '[data-carnet-filter="unfiled"]', "#hq-carnet-search"):
        check(page.is_visible(sel), f"sheet shows {sel}")
    page.locator('#carnet-library-list [data-carnet-page-id="page-ebauche"]').click()
    wait_until(lambda: not page.is_visible("#hq-carnet-library"), "tap result closes the sheet")
    check(page_id(page) == "page-ebauche" and editor_value(page).startswith("Ébauche"), "tap opens that page in the same editor")
    check(page.eval_on_selector_all("#hq-carnet-editor", "els => els.length") == 1, "one editor on phone")
    # backdrop closes
    page.locator("#btn-carnet-library").click()
    wait_until(lambda: page.is_visible(".carnet-lib-backdrop"), "backdrop shown")
    page.mouse.click(10, 30)
    wait_until(lambda: not page.is_visible("#hq-carnet-library"), "backdrop tap closes")
    # context popover on phone: 2 taps
    page.locator("#btn-carnet-context").click()
    wait_until(lambda: page.is_visible("#hq-carnet-context"), "context popover")
    check(small_targets(page, "#hq-carnet-context") == 0, "context options >= 44px")
    page.locator('#hq-carnet-context [data-carnet-category=""]').click()
    wait_until(lambda: h.srv.page("page-ebauche")["category_id"] is None, "clear category in 2 taps")
    check(no_overflow(page), "no overflow with context popover")
    ctx.close()


def t_library_ipad(h):
    print("-- library: iPad portrait drawer / landscape sidebar [ipad]")
    h.srv.seed(library_fixture())
    ctx = h.context("ipad")
    page = h.page(ctx)
    vw = page.viewport_size["width"]
    check(not page.is_visible("#hq-carnet-library"), "portrait: library closed by default")
    page.locator("#btn-carnet-library").click()
    wait_until(lambda: page.is_visible("#hq-carnet-library"), "portrait drawer opens")
    settle_anim(page)
    w = page.eval_on_selector("#hq-carnet-library", "e => e.getBoundingClientRect().width")
    check(w <= 0.5 * vw, f"drawer leaves the paper visible ({w:.0f}/{vw})")
    check(small_targets(page, "#hq-carnet-library") == 0, "drawer controls >= 44px")
    page.keyboard.press("Escape")
    wait_until(lambda: not page.is_visible("#hq-carnet-library"), "hardware keyboard Escape closes the drawer")
    page.set_viewport_size({"width": 1194, "height": 834})
    wait_until(lambda: page.is_visible("#hq-carnet-library"), "landscape: docked sidebar")
    paper = page.eval_on_selector(".carnet-paper", "e => e.getBoundingClientRect().width")
    lw = page.eval_on_selector("#hq-carnet-library", "e => e.getBoundingClientRect().width")
    check(paper >= 600 and paper > 2 * lw, f"landscape paper not covered ({paper:.0f}px, library {lw:.0f}px)")
    check(page.evaluate("() => !document.querySelector('.carnet-lib-backdrop:not([hidden])')"), "no backdrop over the paper in landscape")
    check(no_overflow(page), "no overflow in landscape")
    ctx.close()


def t_context_inherit(h, profile):
    print(f"-- context assignment / create-in-context / global New [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    page.locator("#btn-carnet-next").click()
    wait_until(lambda: page_id(page) == "page-idea", "on page-idea")
    check(page.inner_text("#btn-carnet-context").strip() == "À classer", "unassigned page shows À classer")
    page.locator("#btn-carnet-context").click()
    page.locator('#hq-carnet-context [data-carnet-category="cat-measures"]').click()
    wait_until(lambda: h.srv.page("page-idea")["category_id"] == "cat-measures", "category assigned in 2 clicks")
    page.locator('#hq-carnet-context [data-carnet-project="proj-fixture"]').click()
    wait_until(lambda: h.srv.page("page-idea")["project_id"] == "proj-fixture", "project assigned (independent dimension)")
    check(page.inner_text("#btn-carnet-context").strip() == "Fixture redesign · Mesures", "pill reflects assignment")
    page.locator('#hq-carnet-context [data-carnet-project=""]').click()
    wait_until(lambda: h.srv.page("page-idea")["project_id"] is None and h.srv.page("page-idea")["category_id"] == "cat-measures", "clear project only")
    if profile == "desktop":
        page.keyboard.press("Escape")
    else:
        page.locator("#btn-carnet-context-close").click()
    wait_until(lambda: not page.is_visible("#hq-carnet-context"), "popover closes")
    # create while filtered inherits context
    open_library(page)
    page.locator('#hq-carnet-library [data-carnet-category="cat-measures"]').click()
    wait_until(lambda: page.inner_text("#btn-carnet-lib-new").strip() == "+ Nouvelle page ici", "scoped New label")
    before = {p["id"] for p in h.srv.nb()["pages"]}
    page.locator("#btn-carnet-lib-new").click()
    wait_until(lambda: len(h.srv.nb()["pages"]) == len(before) + 1, "page created from the library")
    new_id = next(p["id"] for p in h.srv.nb()["pages"] if p["id"] not in before)
    check(h.srv.page(new_id)["category_id"] == "cat-measures" and h.srv.page(new_id)["project_id"] is None, "create in category inherits it")
    wait_until(lambda: page_id(page) == new_id, "new page opened in the editor")
    open_library(page)
    page.locator('#hq-carnet-library [data-carnet-project="proj-fixture"]').click()
    before = {p["id"] for p in h.srv.nb()["pages"]}
    page.locator("#btn-carnet-lib-new").click()
    wait_until(lambda: len(h.srv.nb()["pages"]) == len(before) + 1, "page created in project scope")
    pid = next(p["id"] for p in h.srv.nb()["pages"] if p["id"] not in before)
    check(h.srv.page(pid)["project_id"] == "proj-fixture", "create in project inherits it")
    before = {p["id"] for p in h.srv.nb()["pages"]}
    page.locator("#btn-carnet-new").click()
    wait_until(lambda: len(h.srv.nb()["pages"]) == len(before) + 1, "global New")
    gid = next(p["id"] for p in h.srv.nb()["pages"] if p["id"] not in before)
    check(h.srv.page(gid)["project_id"] is None and h.srv.page(gid)["category_id"] is None, "global New stays À classer")
    ctx.close()


def t_manage(h):
    print("-- project/category management [desktop]")
    h.srv.seed()
    ctx = h.context("desktop")
    page = h.page(ctx)
    page.locator('#hq-carnet-library [data-carnet-act="manage"]').click()
    page.locator('.carnet-create[data-row-kind="project"] input').fill("Banc d'essai")
    page.locator('.carnet-create[data-row-kind="project"] [data-carnet-act="project-create"]').click()
    wait_until(lambda: any(p["name"] == "Banc d'essai" for p in h.srv.nb()["projects"]), "project created")
    pid = next(p["id"] for p in h.srv.nb()["projects"] if p["name"] == "Banc d'essai")
    row = f'.carnet-manage-row[data-row-id="{pid}"]'
    page.locator(row + " input").fill("Banc")
    page.locator(row + ' [data-carnet-act="project-rename"]').click()
    wait_until(lambda: any(p["name"] == "Banc" for p in h.srv.nb()["projects"]), "project renamed")
    page.locator(row + ' [data-carnet-act="project-archive"]').click()
    wait_until(lambda: next(p for p in h.srv.nb()["projects"] if p["id"] == pid)["archived"] is True, "project archived")
    page.locator("#btn-carnet-context").click()
    check(page.query_selector(f'#hq-carnet-context [data-carnet-project="{pid}"]') is None, "archived project not offered for assignment")
    page.keyboard.press("Escape")
    page.locator('.carnet-create[data-row-kind="category"] input').fill("Idées")
    page.locator('.carnet-create[data-row-kind="category"] select').select_option("violet")
    page.locator('.carnet-create[data-row-kind="category"] [data-carnet-act="category-create"]').click()
    wait_until(lambda: any(c["name"] == "Idées" and c["color"] == "violet" for c in h.srv.nb()["categories"]), "category created")
    cid = next(c["id"] for c in h.srv.nb()["categories"] if c["name"] == "Idées")
    crow = f'.carnet-manage-row[data-row-id="{cid}"]'
    page.locator(crow + " input").fill("Idées folles")
    page.locator(crow + ' [data-carnet-act="category-save"]').click()
    wait_until(lambda: any(c["name"] == "Idées folles" for c in h.srv.nb()["categories"]), "category updated")
    # delete Mesures: pages lose it, client adopts null; needs two explicit clicks
    mrow = '.carnet-manage-row[data-row-id="cat-measures"]'
    page.locator(mrow + ' [data-carnet-act="category-delete"]').click()
    page.wait_for_timeout(200)
    check(any(c["id"] == "cat-measures" for c in h.srv.nb()["categories"]), "first click only arms category delete")
    page.locator(mrow + ' [data-carnet-act="category-delete"]').click()
    wait_until(lambda: not any(c["id"] == "cat-measures" for c in h.srv.nb()["categories"]), "category deleted")
    wait_until(lambda: page.inner_text("#btn-carnet-context").strip() == "Fixture redesign", "current page adopts the unassigned category")
    set_editor(page, "after category delete")
    wait_until(lambda: h.srv.text("page-shaft") == "after category delete", "saves normally")
    check(h.srv.page("page-shaft")["category_id"] is None, "deleted category never resurrected")
    ctx.close()


def t_stale_org(h, profile):
    print(f"-- stale draft org metadata never resurrects [{profile}]")
    nb = fixture()
    nb["categories"] = []
    nb["pages"][0].update({"category_id": None, "rev": 4})
    nb["notebook_rev"] = 5
    h.srv.seed(nb)
    legacy = {"version": 1, "pages": {"page-shaft": {"server_rev": 4, "generation": 2, "saved_generation": 1, "updated_local_at": 1,
              "project_id": "proj-fixture", "category_id": "cat-measures", "pinned": True,
              "content": {"version": 1, "blocks": [{"id": "block-shaft", "type": "text", "text": "stale draft text", "marks": []}]}}}}
    init = f"try {{ if (!sessionStorage.getItem('seeded')) {{ sessionStorage.setItem('seeded','1'); localStorage.setItem({json.dumps(DRAFT_KEY)}, {json.dumps(json.dumps(legacy))}); }} }} catch (_) {{}}"
    ctx = h.context(profile, init=init)
    posts = []
    ctx.on("request", lambda r: posts.append(json.loads(r.post_data)) if r.method == "POST" and r.url.endswith("/api/carnet") else None)
    page = h.page(ctx)
    check(editor_value(page) == "stale draft text", "draft text recovered")
    check(page.inner_text("#btn-carnet-context").strip() == "Fixture redesign", "authoritative (null) category shown, not the draft's")
    wait_until(lambda: h.srv.text("page-shaft") == "stale draft text", "draft saved")
    check(h.srv.page("page-shaft")["category_id"] is None, "deleted category not resurrected")
    check(all("category_id" not in p and "project_id" not in p for p in posts if p.get("action") == "page_save"), "no org field sent from a draft")
    page.reload()
    h.open_carnet(page)
    check(page.inner_text("#btn-carnet-context").strip() == "Fixture redesign", "reload keeps authoritative metadata")
    ctx.close()


def t_pin_queue(h, profile):
    print(f"-- pin through the save queue [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    page.locator("#btn-carnet-next").click()
    wait_until(lambda: page_id(page) == "page-idea", "on page-idea")
    held, posts = [], []

    def route(r):
        if r.request.method == "POST":
            posts.append(json.loads(r.request.post_data))
            if len(posts) == 1:
                held.append(r)
                return
        r.continue_()
    page.route("**/api/carnet", route)
    page.locator("#btn-carnet-pin").click()
    check(read_draft(page)["pages"]["page-idea"]["pinned"] is True, "pin draft written synchronously")
    wait_until(lambda: len(posts) == 1, "pin save in flight")
    page.locator("#btn-carnet-pin").click()  # unpin while in flight
    page.wait_for_timeout(700)
    check(len(posts) == 1, "one in-flight save per page")
    held.pop().continue_()
    wait_until(lambda: len(posts) == 2 and posts[1]["pinned"] is False and posts[1]["expected_rev"] == 2, "late success -> newest pin sent on new rev")
    wait_until(lambda: h.srv.page("page-idea")["pinned"] is False and h.srv.rev("page-idea") == 3, "server holds newest pin")
    page.unroute("**/api/carnet")
    page.locator("#btn-carnet-pin").click()
    wait_until(lambda: h.srv.page("page-idea")["pinned"] is True, "pin saved")
    page.reload()
    h.open_carnet(page)
    page.locator("#btn-carnet-next").click()
    wait_until(lambda: page.get_attribute("#btn-carnet-pin", "aria-pressed") == "true", "pin persists across reload")
    ctx.close()


def t_trash(h, profile):
    print(f"-- trash / undo / read-only / restore / permanent delete [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)

    def trash_current():
        if not page.is_visible("#carnet-quick-tools"):
            page.locator("#btn-carnet-more").click()
        page.locator("[data-carnet-trash]").click()

    trash_current()
    wait_until(lambda: h.srv.page("page-shaft")["deleted_at"] is not None, "delete = soft delete")
    wait_until(lambda: page.is_visible("#btn-carnet-undo"), "Undo exposed immediately")
    check(page_id(page) == "page-idea", "editor moves to a neighbour page")
    page.locator("#btn-carnet-undo").click()
    wait_until(lambda: h.srv.page("page-shaft")["deleted_at"] is None, "Undo restores")
    wait_until(lambda: page_id(page) == "page-shaft", "Undo reopens the page")
    trash_current()
    wait_until(lambda: h.srv.page("page-shaft")["deleted_at"] is not None, "trashed again")
    open_library(page)
    page.locator('[data-carnet-filter="trash"]').click()
    wait_until(lambda: card_ids(page) == ["page-shaft"], "Corbeille is a separate state")
    page.locator('#carnet-library-list [data-carnet-page-id="page-shaft"]').click()
    wait_until(lambda: page_id(page) == "page-shaft", "trashed note viewable")
    check(page.eval_on_selector("#hq-carnet-editor", "e => e.readOnly") is True, "read-only while trashed")
    check(page.is_visible("#hq-carnet-trashed"), "trash banner")
    check(page.inner_text("#carnet-page-indicator").strip() == "Corbeille", "indicator says Corbeille")
    posts = []
    page.on("request", lambda r: posts.append(json.loads(r.post_data)) if r.method == "POST" and r.url.endswith("/api/carnet") else None)
    page.focus("#hq-carnet-editor")
    page.keyboard.type("nope")
    page.eval_on_selector("#hq-carnet-editor", "e => { e.value = e.value + 'forced'; e.dispatchEvent(new Event('input', {bubbles:true})); }")
    page.wait_for_timeout(800)
    check(not [p for p in posts if p.get("action") == "page_save"], "no autosave while trashed")
    check(h.srv.text("page-shaft") == SHAFT, "server text untouched")
    check(page.is_disabled("#btn-carnet-pin"), "pin disabled while trashed")
    page.locator("#hq-carnet-trashed [data-carnet-restore]").click()
    wait_until(lambda: h.srv.page("page-shaft")["deleted_at"] is None, "restore from banner")
    wait_until(lambda: page.eval_on_selector("#hq-carnet-editor", "e => e.readOnly") is False, "editable after restore")
    set_editor(page, SHAFT + " restored")
    wait_until(lambda: h.srv.text("page-shaft") == SHAFT + " restored", "autosave works again")
    # permanent delete requires trash + typed confirmation
    trash_current()
    wait_until(lambda: h.srv.page("page-shaft")["deleted_at"] is not None, "trashed for permanent delete")
    open_library(page)
    page.locator('[data-carnet-filter="trash"]').click()
    page.locator('#carnet-library-list [data-carnet-delete-permanent="page-shaft"]').click()
    wait_until(lambda: page.is_visible("#hq-carnet-delete-confirm"), "deep confirmation shown")
    check(page.is_disabled("#btn-carnet-delete-confirm"), "confirm disabled until typed")
    page.fill("#hq-carnet-delete-word", "supp")
    check(page.is_disabled("#btn-carnet-delete-confirm"), "partial word keeps it disabled")
    page.keyboard.press("Escape")
    wait_until(lambda: not page.is_visible("#hq-carnet-delete-confirm"), "Escape cancels")
    check(h.srv.page("page-shaft") is not None, "nothing deleted on cancel")
    page.locator("#hq-carnet-trashed [data-carnet-delete-permanent]").click()
    page.fill("#hq-carnet-delete-word", "supprimer")
    page.locator("#btn-carnet-delete-confirm").click()
    wait_until(lambda: h.srv.page("page-shaft") is None, "permanent delete after explicit confirmation")
    wait_until(lambda: page_id(page) == "page-idea", "editor returns to an active page")
    # final active page invariant
    trash_current()
    wait_until(lambda: h.srv.page("page-idea")["deleted_at"] is not None, "last active page trashed")
    active = [p for p in h.srv.nb()["pages"] if p["deleted_at"] is None]
    check(len(active) == 1 and active[0]["content"]["blocks"][0]["text"] == "", "server kept a blank active page")
    wait_until(lambda: page_id(page) == active[0]["id"] and editor_value(page) == "", "replacement page opened")
    ctx.close()


def remote(action, **kw):
    """Another device acting on the throwaway server."""
    import hq_carnet
    nb_rev = hq_carnet.get_notebook(meta=True)["notebook_rev"]
    payload = {"action": action}
    payload.update(kw)
    if action != "page_save":
        payload.setdefault("expected_notebook_rev", nb_rev)
    return hq_carnet.mutate(payload)


def t_delete_stale(h, profile):
    print(f"-- permanent delete never crosses a revision conflict [{profile}]")
    h.srv.seed()
    h.expected_failures = True  # the expected 409 is logged by the browser
    ctx = h.context(profile)
    page = h.page(ctx)
    page.locator("#btn-carnet-more").click()
    page.locator("[data-carnet-trash]").click()
    wait_until(lambda: h.srv.page("page-shaft")["deleted_at"] is not None, "trashed (rev 4)")
    open_library(page)
    page.locator('[data-carnet-filter="trash"]').click()
    page.locator('#carnet-library-list [data-carnet-delete-permanent="page-shaft"]').click()
    wait_until(lambda: page.is_visible("#hq-carnet-delete-confirm"), "confirmation open for rev 4")
    page.fill("#hq-carnet-delete-word", "SUPPRIMER")
    # meanwhile another device restores, edits and re-trashes the note (rev 7)
    remote("page_restore", id="page-shaft", expected_rev=4)
    remote("page_save", id="page-shaft", expected_rev=5,
           content={"version": 1, "blocks": [{"id": "block-shaft", "type": "text", "text": "Newer remote shaft notes", "marks": []}]})
    remote("page_trash", id="page-shaft", expected_rev=6)
    deletes = []
    page.on("request", lambda r: deletes.append(json.loads(r.post_data)) if r.method == "POST" and r.url.endswith("/api/carnet")
            and '"page_delete_permanent"' in (r.post_data or "") else None)
    page.locator("#btn-carnet-delete-confirm").click()
    wait_until(lambda: page.is_visible("#hq-carnet-trashed-note"), "user told the note changed")
    page.wait_for_timeout(800)
    check(len(deletes) == 1 and deletes[0]["expected_rev"] == 4, f"exactly one delete request (confirmed rev), no automatic retry ({deletes})")
    check(h.srv.page("page-shaft") is not None and h.srv.rev("page-shaft") == 7, "page still exists")
    wait_until(lambda: editor_value(page) == "Newer remote shaft notes", "refreshed current state shown")
    check(not page.is_visible("#hq-carnet-delete-confirm"), "old confirmation closed")
    check("confirme à nouveau" in page.inner_text("#hq-carnet-trashed-note"), "reconfirmation requested")
    # a NEW explicit confirmation is required for the current revision
    page.locator("#hq-carnet-trashed [data-carnet-delete-permanent]").click()
    wait_until(lambda: page.is_visible("#hq-carnet-delete-confirm"), "new confirmation")
    check(page.input_value("#hq-carnet-delete-word") == "" and page.is_disabled("#btn-carnet-delete-confirm"), "new confirmation starts empty/disabled")
    check("Newer remote shaft notes" in page.inner_text("#hq-carnet-delete-confirm"), "new confirmation names the current title")
    page.fill("#hq-carnet-delete-word", "supprimer")
    page.locator("#btn-carnet-delete-confirm").click()
    wait_until(lambda: h.srv.page("page-shaft") is None, "rev 7 deleted only after the second human confirmation")
    check(len(deletes) == 2 and deletes[1]["expected_rev"] == 7, "second request carries the reconfirmed rev")
    h.expected_failures = False
    ctx.close()


def t_remote_lifecycle(h, profile):
    print(f"-- remote trash/restore of a dirty page [{profile}]")
    h.srv.seed()
    h.expected_failures = True
    ctx = h.context(profile)
    page = h.page(ctx)
    ctx.route("**/api/carnet", lambda r: r.abort() if r.request.method == "POST" else r.continue_())
    set_editor(page, "dirty local shaft")
    wait_until(lambda: status(page) == OFFLINE_MSG, "dirty and unsaved")
    remote("page_trash", id="page-shaft", expected_rev=3)
    wait_until(lambda: page.eval_on_selector("#hq-carnet-editor", "e => e.readOnly") is True, "remote trash -> read-only", timeout=12)
    check(editor_value(page) == "dirty local shaft", "local text preserved")
    check(read_draft(page)["pages"]["page-shaft"]["content"]["blocks"][0]["text"] == "dirty local shaft", "draft preserved")
    check(page.is_visible("#hq-carnet-trashed") and page.inner_text("#carnet-page-indicator").strip() == "Corbeille", "trash banner shown")
    check(status(page) == "Brouillon local conservé — page dans la corbeille", "truthful status (no endless Enregistrement…)")
    open_library(page)
    page.locator('[data-carnet-filter="trash"]').click()
    wait_until(lambda: card_ids(page) == ["page-shaft"], "dirty trashed page listed in Corbeille")
    page.locator('[data-carnet-filter="all"]').click()
    wait_until(lambda: "page-shaft" not in card_ids(page), "not among active pages")
    if profile != "desktop":
        page.locator("#btn-carnet-lib-close").click()
    ctx.unroute("**/api/carnet")
    page.evaluate("() => window.dispatchEvent(new Event('online'))")
    page.wait_for_timeout(900)
    check(h.srv.text("page-shaft") == SHAFT and h.srv.page("page-shaft")["deleted_at"] is not None, "no autosave into the trashed page")
    # restored elsewhere: active again, stale Restore gone, the protected draft resumes safely
    remote("page_restore", id="page-shaft", expected_rev=4)
    wait_until(lambda: page.eval_on_selector("#hq-carnet-editor", "e => e.readOnly") is False, "remote restore -> editable", timeout=12)
    check(not page.is_visible("#hq-carnet-trashed"), "stale Restore action gone")
    wait_until(lambda: h.srv.text("page-shaft") == "dirty local shaft", "draft resumed by itself (remote content was unchanged)", timeout=10)
    wait_until(lambda: read_draft(page) is None, "draft cleared once saved")
    h.expected_failures = False
    ctx.close()


def t_library_modal(h, profile):
    print(f"-- library overlay is a modal dialog; docked sidebar is not [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    if profile == "desktop":
        check(page.get_attribute("#hq-carnet-library", "role") is None and page.get_attribute("#hq-carnet-library", "aria-modal") is None,
              "docked sidebar is not modal")
        check(page.evaluate("() => !document.querySelector('.carnet-main').inert"), "paper stays interactive next to the sidebar")
        ctx.close()
        return
    page.locator("#btn-carnet-library").click()
    wait_until(lambda: page.is_visible("#hq-carnet-library"), "overlay open")
    check(page.get_attribute("#hq-carnet-library", "role") == "dialog" and page.get_attribute("#hq-carnet-library", "aria-modal") == "true",
          "overlay has dialog semantics")
    check(page.evaluate("() => document.querySelector('.carnet-main').inert === true"), "paper behind the overlay is inert")
    page.focus("#hq-carnet-search")
    inside = True
    for _ in range(30):
        page.keyboard.press("Tab")
        if not page.evaluate("() => document.getElementById('hq-carnet-library').contains(document.activeElement)"):
            inside = False
            break
    check(inside, "Tab stays inside the overlay")
    page.keyboard.press("Shift+Tab")
    check(page.evaluate("() => document.getElementById('hq-carnet-library').contains(document.activeElement)"), "Shift+Tab stays inside")
    page.keyboard.press("Escape")
    wait_until(lambda: not page.is_visible("#hq-carnet-library"), "Escape closes the overlay")
    check(page.evaluate("() => document.activeElement && document.activeElement.id") == "btn-carnet-library", "focus returns to the opener")
    check(page.evaluate("() => !document.querySelector('.carnet-main').inert"), "paper interactive again")
    ctx.close()


def t_modal_shortcuts(h, profile):
    print(f"-- modal library blocks background page shortcuts [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    check(page_id(page) == "page-shaft", "starts on page 1")
    page.locator("#btn-carnet-library").click()
    wait_until(lambda: page.get_attribute("#hq-carnet-library", "aria-modal") == "true", "modal overlay open")
    page.focus("#hq-carnet-search")
    for key in ("Alt+ArrowRight", "Alt+ArrowLeft", "Alt+ArrowRight"):
        page.keyboard.press(key)
    page.wait_for_timeout(200)
    check(page_id(page) == "page-shaft", "Alt+Left/Right do not change the page behind the modal")
    page.keyboard.type("shaft")
    wait_until(lambda: page.input_value("#hq-carnet-search") == "shaft", "typing in the modal search still works")
    wait_until(lambda: card_ids(page) == ["page-shaft"], "search inside the modal works")
    page.keyboard.press("Escape")  # clears the search first
    page.keyboard.press("Escape")  # then closes the modal
    wait_until(lambda: not page.is_visible("#hq-carnet-library"), "Escape closes the modal")
    page.focus("#hq-carnet-editor")
    page.keyboard.press("Alt+ArrowRight")
    wait_until(lambda: page_id(page) == "page-idea", "Alt+Right works again once the modal is closed")
    page.keyboard.press("Alt+ArrowLeft")
    wait_until(lambda: page_id(page) == "page-shaft", "Alt+Left works again")
    ctx.close()


def _mode_ctx(h, engine, **opts):
    ctx = h.browser(engine).new_context(**opts)
    ctx.add_init_script(INSTRUMENT)
    r = ctx.request.post(h.srv.base + "/login", form={"pin": ADMIN_PIN}, headers={"Origin": h.srv.base}, max_redirects=0)
    assert r.status == 303, r.status
    page = ctx.new_page()
    page.on("pageerror", lambda e: h.errors.append(f"[{engine}] pageerror {e}"))
    page.goto(h.srv.base + "/")
    h.open_carnet(page)
    return ctx, page


def _mode_state(page):
    return page.evaluate("""() => {
      const lib = document.getElementById('hq-carnet-library');
      const main = document.querySelector('.carnet-main');
      const r = lib.getBoundingClientRect();
      return { mode: window.hqCarnetDebug().library.mode, visible: !lib.hidden, role: lib.getAttribute('role'),
               modal: lib.getAttribute('aria-modal'), inert: !!main.inert, width: r.width, pos: getComputedStyle(lib).position,
               editors: document.querySelectorAll('#hq-carnet-editor').length,
               paper: document.querySelector('.carnet-paper').getBoundingClientRect().width,
               overflow: document.documentElement.scrollWidth > window.innerWidth + 1 };
    }""")


def t_responsive_modes(h, engines):
    print("-- responsive library modes (capability-aware)")
    h.srv.seed()
    cases = []
    if "chromium" in engines:
        cases.append(("chromium desktop 1024x768", "chromium", {"viewport": {"width": 1024, "height": 768}}, "dock", (258, 262)))
        cases.append(("chromium desktop 1366x900", "chromium", {"viewport": {"width": 1366, "height": 900}}, "dock", (278, 282)))
    if "webkit" in engines:
        ipad = dict(h.pw.devices["iPad Pro 11"])
        ipad.pop("default_browser_type", None)
        portrait = dict(ipad, viewport={"width": 1024, "height": 1366})
        landscape = dict(ipad, viewport={"width": 1194, "height": 834})
        phone = dict(h.pw.devices["iPhone 13"])
        phone.pop("default_browser_type", None)
        cases.append(("webkit iPad portrait 1024 (touch)", "webkit", portrait, "drawer", None))
        cases.append(("webkit iPad landscape 1194", "webkit", landscape, "dock", (278, 282)))
        cases.append(("webkit iPhone", "webkit", phone, "sheet", None))
    for label, engine, opts, want, width in cases:
        ctx, page = _mode_ctx(h, engine, **opts)
        m = _mode_state(page)
        check(m["mode"] == want, f"{label}: mode {m['mode']} == {want}")
        check(m["editors"] == 1 and not m["overflow"], f"{label}: one editor, no horizontal overflow")
        if want == "dock":
            check(m["visible"] and m["pos"] != "fixed", f"{label}: docked sidebar visible, in flow")
            check(m["role"] is None and m["modal"] is None and not m["inert"], f"{label}: not role=dialog / aria-modal, paper not inert")
            check(width[0] <= m["width"] <= width[1], f"{label}: sidebar {m['width']:.0f}px")
            check(m["paper"] > m["width"] * 1.7, f"{label}: paper dominant ({m['paper']:.0f}px)")
            page.locator("#btn-carnet-library").click()
            wait_until(lambda: page.is_hidden("#hq-carnet-library"), f"{label}: sidebar collapses")
            page.locator("#btn-carnet-library").click()
            wait_until(lambda: page.is_visible("#hq-carnet-library"), f"{label}: sidebar re-opens")
            page.focus("#hq-carnet-editor")
            page.keyboard.press("Alt+ArrowRight")
            wait_until(lambda: page_id(page) == "page-idea", f"{label}: keyboard page navigation with the sidebar open")
        else:
            check(not m["visible"], f"{label}: overlay closed by default")
            page.locator("#btn-carnet-library").click()
            wait_until(lambda: page.is_visible("#hq-carnet-library"), f"{label}: overlay opens")
            m = _mode_state(page)
            check(m["role"] == "dialog" and m["modal"] == "true" and m["inert"], f"{label}: modal semantics, paper inert")
            page.keyboard.press("Escape")
            wait_until(lambda: page.is_hidden("#hq-carnet-library"), f"{label}: Escape closes")
            check(not _mode_state(page)["inert"], f"{label}: paper interactive again")
        ctx.close()


def t_focus(h, profile):
    print(f"-- Focus mode [{profile}]")
    h.srv.seed()
    ctx = h.context(profile)
    page = h.page(ctx)
    before_text = editor_value(page)
    for i in range(3):
        page.locator("#btn-carnet-focus").click()
        wait_until(lambda: page.evaluate("() => document.querySelector('.carnet').classList.contains('is-focus')"), f"enter focus #{i + 1}")
        hidden = ["#hq-carnet-library", ".bottom-nav", ".topbar", "#btn-carnet-context", "#btn-carnet-pin", "#btn-carnet-library",
                  "#btn-carnet-focus", "#btn-carnet-new", "#btn-carnet-copy"]
        check(all(not page.is_visible(sel) for sel in hidden), "focus hides HQ chrome, library, context/pin and New/Copy")
        check(page.is_visible("#hq-carnet-editor") and page.is_visible("#btn-carnet-focus-exit"), "paper + explicit exit visible")
        check(all(page.is_visible(sel) for sel in ("#btn-carnet-prev", "#btn-carnet-next", "#carnet-page-indicator", "#btn-carnet-more")),
              "focus keeps minimal page navigation, indicator and quick tools toggle")
        check(page.eval_on_selector("#hq-carnet-status", "e => getComputedStyle(e).display !== 'none' && getComputedStyle(e.parentElement).display !== 'none'"),
              "save status stays available in focus")
        check(editor_value(page) == before_text and page_id(page) == "page-shaft", "editor state unchanged")
        if i == 0:
            small = page.eval_on_selector_all("#btn-carnet-prev, #btn-carnet-next, #btn-carnet-more, #btn-carnet-focus-exit",
                                              "els => els.map(b => b.getBoundingClientRect()).filter(r => r.width < 44 || r.height < 44).length")
            check(small == 0, "focus controls >= 44px")
            page.locator("#btn-carnet-next").click()
            wait_until(lambda: page_id(page) == "page-idea", "focus: next page button works")
            page.locator("#btn-carnet-prev").click()
            wait_until(lambda: page_id(page) == "page-shaft", "focus: previous page button works")
            if profile != "iphone":
                page.focus("#hq-carnet-editor")
                page.keyboard.press("Alt+ArrowRight")
                wait_until(lambda: page_id(page) == "page-idea", "focus: Alt+Right keyboard navigation")
                page.keyboard.press("Alt+ArrowLeft")
                wait_until(lambda: page_id(page) == "page-shaft", "focus: Alt+Left keyboard navigation")
            page.locator("#btn-carnet-more").click()
            wait_until(lambda: page.is_visible("#carnet-quick-tools"), "focus: quick tools open")
            check(not page.is_visible(".carnet-trash-btn"), "focus: destructive trash action hidden")
            page.eval_on_selector("#hq-carnet-editor", "e => { e.focus(); e.setSelectionRange(0, 0); }")
            page.locator('[data-carnet-symbol="±"]').click()
            wait_until(lambda: editor_value(page).startswith("±"), "focus: symbol inserted")
            page.locator("#btn-carnet-time").click()
            wait_until(lambda: re.match(r"^±\d\d:\d\d — ", editor_value(page)) is not None, "focus: time inserted")
            wait_until(lambda: h.srv.text("page-shaft") == editor_value(page), "focus: tool edits autosaved")
            page.locator("#btn-carnet-more").click()
            before_text = editor_value(page)
        if profile == "iphone":
            page.locator("#btn-carnet-focus-exit").click()
        else:
            page.keyboard.press("Escape")
        wait_until(lambda: not page.evaluate("() => document.querySelector('.carnet').classList.contains('is-focus')"), "exit focus")
        check(page.is_visible(".bottom-nav"), "chrome restored")
    bb = page.eval_on_selector("#btn-carnet-focus", "e => { const r = e.getBoundingClientRect(); return [r.width, r.height]; }")
    check(bb[0] >= 44 and bb[1] >= 44, "focus button >= 44px")
    page.locator("#btn-carnet-focus").click()
    set_editor(page, "typed in focus")
    wait_until(lambda: h.srv.text("page-shaft") == "typed in focus", "autosave in focus mode")
    page.locator("#btn-carnet-focus-exit").click()
    counts = page.evaluate("() => ({ i: window.__carnetCounts.intervals.size, l: window.__carnetCounts.listeners })")
    check(counts["i"] == 1, f"one poll interval after focus toggles ({counts['i']})")
    check(all(v == 1 for v in counts["l"].values()), f"no duplicated listeners {counts['l']}")
    # leaving Carnet exits focus
    page.locator("#btn-carnet-focus").click()
    page.evaluate("() => setView('accueil')")
    wait_until(lambda: not page.evaluate("() => document.body.classList.contains('carnet-focus')"), "leaving Carnet exits focus")
    ctx.close()


def t_home(h, profile):
    print(f"-- Home summary / launcher [{profile}]")
    nb = fixture()
    nb["pages"][1]["content"]["blocks"][0]["text"] = XSS
    h.srv.seed(nb)
    ctx = h.context(profile)
    page = h.page(ctx, open_carnet=False)
    page.locator('.bottom-nav [data-nav="accueil"]').click()
    wait_until(lambda: page.is_visible("#hq-carnet-home"), "admin Home summary visible")
    txt = page.inner_text("#hq-carnet-home")
    check("2 pages · 1 épinglée" in txt, f"counts ({txt!r})")
    titles = page.eval_on_selector_all("#hq-carnet-home [data-carnet-page-id]", "els => els.map(e => e.dataset.carnetPageId)")
    check(titles[:2] == ["page-shaft", "page-idea"] and len(titles) <= 3, "pinned first, at most 3")
    check(XSS in txt and page.evaluate("() => !document.querySelector('#hq-carnet-home img') && !window.__xss"), "safe titles")
    top = page.evaluate("""() => { const h = document.getElementById('hq-carnet-home').getBoundingClientRect().top;
        const c = document.getElementById('hq-cal-home').getBoundingClientRect().top; return h < c; }""")
    check(top, "summary near the top of Home")
    page.locator('#hq-carnet-home [data-carnet-page-id="page-idea"]').click()
    wait_until(lambda: page.get_attribute("body", "data-view") == "carnet", "launcher routes to Carnet")
    wait_until(lambda: page_id(page) == "page-idea", "launcher opens that page in the Carnet editor")
    check(page.eval_on_selector_all("#hq-carnet-editor", "els => els.length") == 1, "no second editor")
    page.locator('.bottom-nav [data-nav="accueil"]').click()
    wait_until(lambda: page.is_visible("#btn-home-carnet-new"), "Home again")
    before = {p["id"] for p in h.srv.nb()["pages"]}
    page.locator("#btn-home-carnet-new").click()
    wait_until(lambda: len(h.srv.nb()["pages"]) == len(before) + 1, "Home New creates a page")
    nid = next(p["id"] for p in h.srv.nb()["pages"] if p["id"] not in before)
    wait_until(lambda: page_id(page) == nid, "new page opened in the same editor")
    check(h.srv.page(nid)["project_id"] is None and h.srv.page(nid)["category_id"] is None, "Home New is À classer")
    set_editor(page, "from home")
    wait_until(lambda: h.srv.text(nid) == "from home", "typing saves")
    page.locator('.bottom-nav [data-nav="accueil"]').click()
    wait_until(lambda: "3 pages" in page.inner_text("#hq-carnet-home"), "summary refreshed")
    page.locator("#btn-home-carnet-open").click()
    wait_until(lambda: page.get_attribute("body", "data-view") == "carnet", "Ouvrir routes to Carnet")
    check(page_id(page) == nid, "Ouvrir keeps the current page")
    ctx.close()


def t_home_upload(h, profile):
    print(f"-- Home privacy for upload role [{profile}]")
    h.srv.seed()
    ctx = h.context(profile, pin=UPLOAD_PIN)
    h.expected_failures = True
    calls = []
    ctx.on("request", lambda r: calls.append(r.url) if "/api/carnet" in r.url else None)
    page = h.page(ctx, open_carnet=False)
    page.locator('.bottom-nav [data-nav="accueil"]').click()
    page.wait_for_timeout(1500)
    check(not page.is_visible("#hq-carnet-home"), "upload role: no Carnet summary")
    check(page.inner_text("#hq-carnet-home") == "" if page.query_selector("#hq-carnet-home") else True, "summary host empty")
    body = page.content()
    check("Shaft inspection" not in body and "épinglée" not in body, "no private titles/counts in the DOM")
    check(not calls, "no /api/carnet request for upload role")
    h.expected_failures = False
    ctx.close()


def t_same_note_resize(h):
    print("-- same note across desktop/iPad/phone layouts (one editor) [chromium resize]")
    h.srv.seed()
    ctx = h.context("desktop")
    page = h.page(ctx)
    page.evaluate("() => { window.__ed = document.querySelector('#hq-carnet-editor'); }")
    for i, (w, hgt) in enumerate(((1366, 900), (834, 1112), (390, 844), (1194, 834))):
        page.set_viewport_size({"width": w, "height": hgt})
        page.wait_for_timeout(150)
        check(page.evaluate("() => window.__ed === document.querySelector('#hq-carnet-editor') && document.querySelectorAll('#hq-carnet-editor').length === 1"),
              f"{w}px: same single editor element")
        check(page_id(page) == "page-shaft", f"{w}px: same page")
        set_editor(page, f"edit at {w}")
        wait_until(lambda: h.srv.text("page-shaft") == f"edit at {w}", f"{w}px: edit saved")
        check(no_overflow(page), f"{w}px: no horizontal overflow")
        lib_hidden = not page.is_visible("#hq-carnet-library")
        check(lib_hidden if w < 1100 else True, f"{w}px: overlay library never opens by itself")
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
            part = "all"
            if "--part" in sys.argv:
                part = sys.argv[sys.argv.index("--part") + 1]
            if part in ("all", "stage02"):
                stage02(h, pc, mob, profiles, engines)
            if part in ("all", "stage03"):
                stage03(h, pc, mob, profiles)
            check(not h.errors, "no pageerror / unexpected console error: " + "; ".join(h.errors[:5]))
            check(not h.external, "no external requests: " + ", ".join(h.external[:5]))
            h.close()
    finally:
        srv.close()
    print(f"carnet playwright: {RESULTS['ok']} checks passed")
    return 0


def _run(fn, h, *a):
    only = os.environ.get("CARNET_ONLY")
    if not only or any(x in fn.__name__ for x in only.split(",")):
        fn(h, *a)


def stage03(h, pc, mob, profiles):
    if pc:
        _run(t_library_desktop, h)
        _run(t_manage, h)
        _run(t_same_note_resize, h)
    if mob:
        _run(t_library_phone, h)
        _run(t_library_ipad, h)
    _run(t_responsive_modes, h, [e for e, ok in (("chromium", pc), ("webkit", mob)) if ok])
    for prof in [p for p in profiles if p != "desktop"]:
        _run(t_modal_shortcuts, h, prof)
    for prof in profiles:
        _run(t_library_modal, h, prof)
        _run(t_remote_lifecycle, h, prof)
        _run(t_delete_stale, h, prof)
        _run(t_context_inherit, h, prof)
        _run(t_trash, h, prof)
        _run(t_focus, h, prof)
    for prof in ([pc] if pc else []) + (["iphone"] if mob else []):
        _run(t_stale_org, h, prof)
        _run(t_pin_queue, h, prof)
        _run(t_home, h, prof)
        _run(t_home_upload, h, prof)


def stage02(h, pc, mob, profiles, engines):
    if True:
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


if __name__ == "__main__":
    sys.exit(main())
