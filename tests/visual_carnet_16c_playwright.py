"""Carnet Phase 16C browser checks (ergonomics + motion) — Chromium, phone + desktop viewports.

Not part of unittest discovery. Runs the same throwaway loopback HQ as visual_carnet_playwright.py (temp ROOT, fake PINs);
never touches the live root. Skips (exit 0) when Playwright or Chromium is unavailable.

    python tests/visual_carnet_16c_playwright.py [--shots <dir>]

Covers: DF-1 (page bar folded into the field dock on phones, every button reachable, back in focus mode / on desktop),
DF-3 (Capture button tucks while typing, returns when idle), Carnet-scoped accent (shell stays), block delete -> "Annuler"
toast -> exact restore (and fail-closed after a later edit), finished checklist chip, finger-following page flip (touch),
pull-down -> outline, menu grows from its origin, reduced motion (no animations), no page errors.
"""
import json
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(SOURCE / "tests"))

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover
    print("SKIP: playwright not installed")
    sys.exit(0)

import visual_carnet_playwright as V  # noqa: E402  (Server, ADMIN_PIN)

FAILS = []


def check(ok, msg):
    print(("  OK   " if ok else "  FAIL ") + msg)
    if not ok:
        FAILS.append(msg)


def blk(i, text, typ="paragraph", **extra):
    b = {"id": "block-c16%02d" % i, "type": typ, "text": text, "marks": []}
    b.update(extra)
    return b


def seed():
    def page(pid, rev, blocks):
        return {"id": pid, "rev": rev, "project_id": None, "category_id": None, "pinned": False, "deleted_at": None,
                "created_at": 1790680010.0, "updated_at": 1790680300.0, "content": {"version": 2, "blocks": blocks}}
    lines = [blk(1, "Inspection de l'arbre"), blk(2, "Mesurer le diamètre"), blk(3, "Contrôler le jeu", "check", checked=False),
             blk(4, "Serrer à 25 N·m", "check", checked=False), blk(5, "Fin de liste")]
    lines += [blk(10 + i, "Ligne %d" % i) for i in range(30)]
    return {"version": 1, "notebook_rev": 4, "projects": [], "categories": [],
            "pages": [page("page-a", 2, lines), page("page-b", 1, [blk(90, "Deuxième page")])]}


def seed16i():
    base = seed()
    lines = [blk(1, "Avant-propos"), blk(2, "Section A", "heading")] + [blk(10 + i, "Texte A %d" % i) for i in range(18)]
    lines += [blk(3, "Section B", "heading")] + [blk(40 + i, "Texte B %d" % i) for i in range(18)]
    lines += [blk(4, "Tâche à faire", "check", checked=False), blk(5, "Phrase à surligner ici")]
    base["pages"][0]["content"]["blocks"] = lines
    return base


def wait(fn, msg, timeout=6.0, page=None):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn():
                return True
        except Exception:
            pass
        if page:
            page.wait_for_timeout(80)
        else:
            time.sleep(0.08)
    check(False, msg + " (timeout)")
    return False


def ctx_for(pw, srv, phone, reduced=False):
    b = pw.chromium.launch()
    opts = {"viewport": {"width": 390, "height": 844}, "has_touch": True, "is_mobile": True, "device_scale_factor": 2} if phone else {"viewport": {"width": 1280, "height": 860}}
    if reduced:
        opts["reduced_motion"] = "reduce"
    ctx = b.new_context(**opts)
    r = ctx.request.post(srv.base + "/login", form={"pin": V.ADMIN_PIN}, headers={"Origin": srv.base}, max_redirects=0)
    assert r.status == 303, r.status
    return b, ctx


def open_page(ctx, srv, errors):
    p = ctx.new_page()
    p.on("pageerror", lambda e: errors.append("pageerror " + str(e)))
    p.on("console", lambda m: errors.append("console " + m.text) if m.type == "error" else None)
    p.goto(srv.base + "/")
    p.locator('.bottom-nav [data-nav="carnet"]').click()
    p.wait_for_selector("#hq-carnet-editor")
    p.wait_for_function("() => document.querySelector('#hq-carnet-editor').dataset.pageId && window.HqCarnetMotion")
    p.wait_for_timeout(900)  # the motion layer attaches on its watch tick
    return p


def hit_ok(p, sel):
    return p.evaluate("""(sel) => { const b = document.querySelector(sel); if (!b) return 'missing';
      b.scrollIntoView({block:'nearest'}); const r = b.getBoundingClientRect(); if (!r.width) return 'hidden';
      const h = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2); return h === b || b.contains(h) ? 'ok' : ('covered by ' + (h && (h.id || h.className))); }""", sel)


def touch_drag(p, sel, x0, y0, x1, y1, steps=8, ms=12):
    p.evaluate("""([sel,x0,y0,x1,y1,steps,ms]) => new Promise(res => {
      const t = document.querySelector(sel); let i = 0;
      const mk = (x, y) => new Touch({identifier: 1, target: t, clientX: x, clientY: y});
      const fire = (type, x, y) => t.dispatchEvent(new TouchEvent(type, {bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [mk(x,y)], changedTouches: [mk(x,y)]}));
      fire('touchstart', x0, y0);
      const step = () => { i++; const x = x0 + (x1-x0)*i/steps, y = y0 + (y1-y0)*i/steps; fire('touchmove', x, y);
        if (i < steps) setTimeout(step, ms); else { fire('touchend', x1, y1); res(); } };
      setTimeout(step, ms); })""", [sel, x0, y0, x1, y1, steps, ms])


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    srv = V.Server()
    errors = []
    try:
        with sync_playwright() as pw:
            # ---------------------------------------------------------------- phone
            srv.seed(seed())
            b, ctx = ctx_for(pw, srv, True)
            p = open_page(ctx, srv, errors)
            print("-- DF-1 dock [phone 390]")
            check(p.evaluate("() => document.querySelector('.carnet').classList.contains('carnet-docked')"), "root is docked")
            check(p.evaluate("() => !!document.querySelector('#hq-carnet-field-hud #btn-carnet-prev') && !!document.querySelector('#hq-carnet-field-hud #btn-carnet-next')"), "prev/next live in the dock")
            check(p.evaluate("() => getComputedStyle(document.querySelector('.carnet-bar-bottom')).display === 'none'"), "the hidden page bar is gone")
            check(p.evaluate("() => document.querySelectorAll('.carnet-field-hud-btn').length === 5"), "the five capture actions are unchanged")
            for sel in ("#btn-carnet-prev", "#btn-carnet-next", "#btn-carnet-new", "#btn-carnet-copy"):
                r = hit_ok(p, sel)
                check(r == "ok", f"{sel} reachable by touch ({r})")
            if shots:
                p.screenshot(path=str(shots / "phone-dock.jpg"), type="jpeg", quality=55, scale="css")
            p.locator("#btn-carnet-next").click()
            wait(lambda: p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-b", "next page from the dock", page=p)
            p.locator("#btn-carnet-prev").click()
            wait(lambda: p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-a", "previous page from the dock", page=p)

            print("-- accent scope")
            acc = p.evaluate("() => [getComputedStyle(document.querySelector('.hq-carnet')).getPropertyValue('--accent').trim(), getComputedStyle(document.body).getPropertyValue('--accent').trim()]")
            check(acc[0].lower() in ("#9da1f5", "#4a4fb5"), f"Carnet accent is indigo ({acc[0]})")
            check(acc[1].lower() != "#9da1f5", f"shell keeps its accent ({acc[1]})")

            print("-- DF-3 Capture button tucks")
            if p.locator(".hq-capture-fab").count():
                p.focus("#hq-carnet-editor")
                p.keyboard.press("End")
                p.keyboard.type("x")
                check(p.evaluate("() => document.body.classList.contains('hq-fab-tucked')"), "tucked while typing")
                p.wait_for_timeout(1700)
                check(not p.evaluate("() => document.body.classList.contains('hq-fab-tucked')"), "back when idle")
                p.keyboard.press("Backspace")
            else:
                check(False, "Capture button present")

            print("-- block delete -> Annuler")
            p.evaluate("() => document.activeElement && document.activeElement.blur()")
            p.wait_for_timeout(1500)
            before = srv.text("page-a")
            ok = p.evaluate("() => window.hqCarnetBlockMenu(document.querySelector('[data-carnet-block-id=\"block-c1602\"]'))")
            check(ok, "long-press entry point opens the block menu")
            p.wait_for_selector(".carnet-block-menu:not([hidden])")
            org = p.evaluate("() => document.querySelector('.carnet-block-menu').style.getPropertyValue('--c16-origin')")
            check(bool(org), f"menu has a grow origin ({org!r})")
            p.locator('.carnet-block-menu [data-carnet-block="delete"]').click()
            if p.locator('.carnet-block-menu:not([hidden]) [data-carnet-block="delete"]').count():
                p.locator('.carnet-block-menu [data-carnet-block="delete"]').click()  # the existing second confirmation
            wait(lambda: "Mesurer le diamètre" not in srv.text("page-a"), "block deleted and saved", timeout=8, page=p)
            check(p.locator(".c16-toast").count() == 1, "an Annuler toast is offered")
            if shots:
                p.screenshot(path=str(shots / "phone-undo.jpg"), type="jpeg", quality=55, scale="css")
            p.locator(".c16-toast-act").click()
            wait(lambda: srv.text("page-a") == before, "undo restores the exact page", timeout=8, page=p)
            check(p.locator(".c16-toast").count() == 0, "toast gone after Annuler")
            # fail closed: an edit after the operation makes Undo refuse
            p.evaluate("() => window.hqCarnetBlockMenu(document.querySelector('[data-carnet-block-id=\"block-c1605\"]'))")
            p.wait_for_selector(".carnet-block-menu:not([hidden])")
            p.locator('.carnet-block-menu [data-carnet-block="delete"]').click()
            if p.locator('.carnet-block-menu:not([hidden]) [data-carnet-block="delete"]').count():
                p.locator('.carnet-block-menu [data-carnet-block="delete"]').click()
            wait(lambda: "Fin de liste" not in srv.text("page-a"), "second delete saved", timeout=8, page=p)
            p.focus("#hq-carnet-editor")
            p.keyboard.press("Control+Home")
            p.keyboard.type("Z")
            p.evaluate("() => document.activeElement.blur()")
            wait(lambda: srv.text("page-a").startswith("Z"), "later edit saved", timeout=8, page=p)
            after = srv.text("page-a")
            if p.locator(".c16-toast-act").count():
                p.locator(".c16-toast-act").click()
                p.wait_for_timeout(1500)
                check(srv.text("page-a") == after, "Undo after a later edit changes nothing (fails closed)")
            else:
                check(False, "toast still there for the fail-closed check")

            print("-- checklist done")
            for bid in ("block-c1603", "block-c1604"):
                p.locator(f'[data-carnet-block-id="{bid}"] [data-carnet-check]').click()
                p.wait_for_timeout(250)
            p.evaluate("""() => { window.__conf = 0; new MutationObserver(m => m.forEach(r => r.addedNodes.forEach(n => { if (n.classList && n.classList.contains('c16-confetti')) window.__conf++; }))).observe(document.body, {childList: true}); }""")
            check(wait(lambda: p.locator(".c16-done").count() == 1, "finished-checklist chip", page=p), "finished checklist is announced")
            check(p.evaluate("() => window.__conf") >= 10 or p.locator(".c16-confetti").count() >= 10, "a little confetti burst")
            if shots:
                p.screenshot(path=str(shots / "phone-checklist.jpg"), type="jpeg", quality=55, scale="css")

            print("-- finger-following flip")
            p.evaluate("() => window.scrollTo(0, 0)")
            p.wait_for_timeout(300)
            box = p.eval_on_selector(".carnet-stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width]; }")
            y = box[1] + 200
            touch_drag(p, ".carnet-stage", box[0] + box[2] - 40, y, box[0] + 30, y + 6)
            wait(lambda: p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-b", "drag left turns to the next page", timeout=4, page=p)
            p.wait_for_timeout(700)
            check(p.eval_on_selector(".carnet-paper", "e => !e.style.transform && !e.classList.contains('c16-dragging') && !e.style.getPropertyValue('--c16-curl')"), "paper back at rest (curl cleared)")
            touch_drag(p, ".carnet-stage", box[0] + 40, y, box[0] + 90, y, steps=10, ms=60)  # short and slow: springs back
            p.wait_for_timeout(700)
            check(p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-b", "a short slow drag does not turn the page")
            touch_drag(p, ".carnet-stage", box[0] + 40, y, box[0] + 90, y, steps=4, ms=12)  # short but flicked: turns back
            wait(lambda: p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-a", "a flick turns the page", timeout=4, page=p)
            p.wait_for_timeout(600)
            touch_drag(p, ".carnet-stage", box[0] + 40, y, box[0] + 50, y + 260)  # vertical: never a flip
            p.wait_for_timeout(500)
            check(p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-a", "a vertical drag never turns the page")

            print("-- pull down -> outline")
            p.evaluate("() => window.scrollTo(0, 0)")
            touch_drag(p, ".carnet-stage", box[0] + 160, box[1] + 40, box[0] + 162, box[1] + 260, steps=10)
            check(wait(lambda: p.evaluate("() => { const o = document.querySelector('#hq-carnet-outline'); return !!o && !o.hidden; }"), "outline opened by pulling", page=p), "pull-down opens the page outline")
            if shots:
                p.screenshot(path=str(shots / "phone-outline.jpg"), type="jpeg", quality=55, scale="css")
            b.close()

            # ---------------------------------------------------------------- focus mode undocks (phone)
            srv.seed(seed())
            b, ctx = ctx_for(pw, srv, True)
            p = open_page(ctx, srv, errors)
            print("-- focus mode [phone]")
            p.locator("#btn-carnet-focus").click()
            wait(lambda: p.evaluate("() => !document.querySelector('.carnet').classList.contains('carnet-docked')"), "focus mode undocks", page=p)
            check(p.evaluate("() => !!document.querySelector('.carnet-bar-bottom #btn-carnet-prev')"), "buttons back in the page bar")
            r = hit_ok(p, "#btn-carnet-next")
            check(r == "ok", f"next reachable in focus mode ({r})")
            p.locator("#btn-carnet-focus-exit").click()
            wait(lambda: p.evaluate("() => document.querySelector('.carnet').classList.contains('carnet-docked')"), "docked again after focus mode", page=p)
            b.close()

            # ---------------------------------------------------------------- desktop
            srv.seed(seed())
            b, ctx = ctx_for(pw, srv, False)
            ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=srv.base)
            p = open_page(ctx, srv, errors)
            print("-- desktop 1280")
            check(p.evaluate("() => !document.querySelector('.carnet').classList.contains('carnet-docked')"), "not docked on desktop")
            check(hit_ok(p, "#btn-carnet-next") == "ok", "page bar reachable on desktop")
            pid = lambda: p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId")  # noqa: E731

            print("-- PC: ripples, rolling page number, library cascade")
            nb = p.locator("#btn-carnet-next").bounding_box()
            p.mouse.move(nb["x"] + 8, nb["y"] + 8)
            p.mouse.down()
            check(p.locator("#btn-carnet-next .c16-ripple").count() == 1, "pressing a button spreads a ripple from the pointer")
            p.mouse.up()
            check(p.evaluate("() => document.getElementById('carnet-page-indicator').getAnimations().length > 0"), "the page number rolls")
            wait(lambda: pid() == "page-b", "Suivant (ripple press)", page=p)
            p.wait_for_timeout(700)
            check(p.locator(".c16-ripple").count() == 0, "ripples clean themselves up")
            p.locator("#btn-carnet-prev").click()
            wait(lambda: pid() == "page-a", "back to page a", page=p)
            p.wait_for_timeout(500)

            print("-- PC: buttons slide, trackpad swipe")
            p.locator("#btn-carnet-next").click()
            check(p.eval_on_selector(".carnet-paper", "e => e.getAnimations().some(a => a.id === 'c16-flip')"), "page slides in after Suivant")
            wait(lambda: pid() == "page-b", "Suivant works", page=p)
            p.wait_for_timeout(500)
            box = p.eval_on_selector(".carnet-stage", "e => { const r = e.getBoundingClientRect(); return [r.left + r.width/2, r.top + 260]; }")
            p.mouse.move(box[0], box[1])
            for _ in range(14):  # two-finger swipe to the right = previous page
                p.mouse.wheel(-30, 0)
                p.wait_for_timeout(12)
            wait(lambda: pid() == "page-a", "trackpad swipe right turns back", timeout=4, page=p)
            p.wait_for_timeout(700)
            for _ in range(10):  # vertical wheel never turns
                p.mouse.wheel(0, 60)
                p.wait_for_timeout(12)
            p.wait_for_timeout(500)
            check(pid() == "page-a", "a vertical wheel never turns the page")
            for _ in range(10):  # Shift+wheel (horizontal scrolling with a mouse) never turns
                p.keyboard.down("Shift")
                p.mouse.wheel(0, 60)
                p.keyboard.up("Shift")
            p.wait_for_timeout(500)
            check(pid() == "page-a", "Shift+wheel never turns the page")

            print("-- PC: right-click a block")
            p.evaluate("() => window.scrollTo(0, 0)")
            r = p.eval_on_selector('[data-carnet-block-id="block-c1602"]', "e => { const ed = document.getElementById('hq-carnet-editor').getBoundingClientRect(); const r = e.getBoundingClientRect(); return [ed.left + 10, r.top + r.height/2, r.left + 120]; }")
            p.mouse.click(r[0], r[1], button="right")
            check(wait(lambda: p.locator(".carnet-block-menu:not([hidden])").count() == 1, "menu after right-click", page=p), "right-click in the margin opens the block menu")
            p.keyboard.press("Escape")
            p.wait_for_timeout(200)
            p.mouse.click(r[2], r[1], button="right")
            p.wait_for_timeout(300)
            check(p.locator(".carnet-block-menu:not([hidden])").count() == 0, "right-click in the text keeps the browser menu")
            p.keyboard.press("Escape")

            print("-- PC: wheel up at the top -> outline")
            p.evaluate("() => window.scrollTo(0, 0)")
            p.wait_for_timeout(600)
            p.mouse.move(box[0], box[1])
            for _ in range(8):
                p.mouse.wheel(0, -60)
                p.wait_for_timeout(16)
            check(wait(lambda: p.evaluate("() => { const o = document.querySelector('#hq-carnet-outline'); return !!o && !o.hidden; }"), "outline by wheel", page=p), "scrolling up at the top opens the outline")
            p.keyboard.press("Escape")
            p.wait_for_timeout(300)

            print("-- sticky notes [desktop]")
            sfile = srv.root / ".hq-carnet" / "stickies.json"
            notes = lambda: json.loads(sfile.read_text(encoding="utf-8"))["notes"] if sfile.exists() else []  # noqa: E731
            check(hit_ok(p, "#btn-carnet-sticky") == "ok", "Note button in the top bar")
            p.locator("#btn-carnet-sticky").click()
            check(wait(lambda: len(notes()) == 1, "note created", page=p), "a click adds a note (stored on HQ)")
            p.wait_for_selector(".carnet-sticky")
            check(p.eval_on_selector(".carnet-sticky", "e => e.getAnimations().length > 0"), "a new note lands with a little drop")
            check(p.evaluate("() => document.activeElement && document.activeElement.classList.contains('carnet-sticky-text')"), "the new note is ready to type in")
            p.keyboard.type("Vérifier le jeu\nCouple 25 N·m")
            p.wait_for_timeout(100)
            check(wait(lambda: notes() and notes()[0]["text"] == "Vérifier le jeu\nCouple 25 N·m", "text saved", page=p), "typing is saved")
            check(p.evaluate("() => !document.getElementById('hq-carnet-editor').contains(document.querySelector('.carnet-sticky'))"), "the note is not inside the page text")
            check("Vérifier le jeu" not in json.dumps(json.loads((srv.root / ".hq-carnet" / "notebook.json").read_text(encoding="utf-8"))), "the note never enters notebook.json")
            before = dict(notes()[0])
            bar = p.eval_on_selector(".carnet-sticky-grip", "e => { const r = e.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; }")
            p.mouse.move(bar[0], bar[1])
            p.mouse.down()
            p.mouse.move(bar[0] - 300, bar[1] + 180, steps=12)
            p.mouse.up()
            check(wait(lambda: notes()[0]["x"] < before["x"] and notes()[0]["y"] > before["y"], "moved", page=p), "dragging moves the note (saved)")
            p.locator(".carnet-sticky-color").click()
            check(wait(lambda: notes()[0]["color"] != before["color"], "colour", page=p), "colour changes")
            p.locator(".carnet-sticky-copy").click()
            p.wait_for_timeout(300)
            clip = p.evaluate("() => navigator.clipboard.readText()")
            check(clip == "Vérifier le jeu\nCouple 25 N·m", f"copy puts the note text on the clipboard ({clip!r})")
            p.locator(".carnet-sticky-fold").click()
            check(wait(lambda: notes()[0]["collapsed"] is True, "folded", page=p), "fold is saved")
            check(p.eval_on_selector(".carnet-sticky", "e => e.classList.contains('is-folded') && e.querySelector('.carnet-sticky-title').textContent === 'Vérifier le jeu'"), "a folded note shows its first line")
            p.locator(".carnet-sticky-fold").click()
            if shots:
                p.wait_for_timeout(300)
                p.screenshot(path=str(shots / "desktop-sticky.jpg"), type="jpeg", quality=60, scale="css")
            # another device sees it, and the other page does not
            p2 = open_page(ctx, srv, errors)
            check(wait(lambda: p2.locator(".carnet-sticky").count() == 1, "second tab sees it", page=p2), "another device sees the note on the same page")
            p2.locator("#btn-carnet-next").click()
            wait(lambda: p2.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-b", "p2 next", page=p2)
            p2.wait_for_timeout(400)
            check(p2.locator(".carnet-sticky").count() == 0, "notes belong to their page")
            p2.close()
            # conflict: changed elsewhere -> never overwritten
            nid, rev = notes()[0]["id"], notes()[0]["rev"]
            code, _ = __import__("hq_carnet_stickies").http_post({"action": "update", "id": nid, "rev": rev, "text": "changé ailleurs"})
            p.locator(".carnet-sticky-text").click()
            p.keyboard.press("End")
            p.keyboard.type(" !")
            p.evaluate("() => document.activeElement.blur()")
            check(wait(lambda: p.locator(".c16-toast").count() >= 1, "conflict message", page=p), "an edit on a stale note is refused with a message")
            check(notes()[0]["text"] == "changé ailleurs", "the other device's text is kept")
            check(wait(lambda: p.eval_on_selector(".carnet-sticky-text", "e => e.value") == "changé ailleurs", "newest shown", page=p), "the newest version is shown")
            for t in p.locator(".c16-toast-close").all():
                t.click()
            # close + Annuler
            p.locator(".carnet-sticky-close").click()
            check(wait(lambda: len(notes()) == 0, "closed", page=p), "close removes the note")
            p.locator(".c16-toast-act").click()
            check(wait(lambda: len(notes()) == 1 and notes()[0]["text"] == "changé ailleurs", "restored", page=p), "Annuler brings the note back")
            # keyboard: Alt+Shift+N adds, arrows on the grip move
            p.keyboard.press("Escape")
            p.locator("#hq-carnet-editor").click()
            p.keyboard.press("Alt+Shift+N")
            check(wait(lambda: len(notes()) == 2, "shortcut", page=p), "Alt+Maj+N adds a note")
            wait(lambda: p.evaluate("() => !!document.activeElement && document.activeElement.classList.contains('carnet-sticky-text') && !document.activeElement.value"), "new note focused", page=p)
            p.keyboard.press("Escape")
            wait(lambda: p.evaluate("() => !!document.activeElement && document.activeElement.classList.contains('carnet-sticky-grip')"), "grip focused", page=p)
            y0 = [n for n in notes() if n["text"] == ""][0]["y"]
            p.keyboard.press("ArrowDown")
            p.keyboard.press("ArrowDown")
            check(wait(lambda: [n for n in notes() if n["text"] == ""][0]["y"] == y0 + 16, "arrow move", page=p), "arrow keys on the grip move the note")
            b.close()

            # ---------------------------------------------------------------- stickies on a phone
            b, ctx = ctx_for(pw, srv, True)
            p = open_page(ctx, srv, errors)
            print("-- sticky notes [phone 390]")
            check(wait(lambda: p.locator(".carnet-sticky").count() == 2, "phone sees the notes", page=p), "the phone shows the PC's notes")
            fits = p.evaluate("() => [...document.querySelectorAll('.carnet-sticky')].every(n => { const r = n.getBoundingClientRect(), pr = document.querySelector('.carnet-paper').getBoundingClientRect(); return r.left >= pr.left - 1 && r.right <= pr.right + 1; })")
            check(fits, "notes stay inside the narrow page")
            over = p.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(over <= 0, f"no sideways scroll with the extra button ({over}px)")
            check(hit_ok(p, "#btn-carnet-sticky") == "ok", "Note button reachable on the phone")
            if shots:
                p.screenshot(path=str(shots / "phone-sticky.jpg"), type="jpeg", quality=55, scale="css")
            b.close()

            # ---------------------------------------------------------------- 16G: page width, text size, library width
            srv.seed(seed())
            b, ctx = ctx_for(pw, srv, False)
            p = open_page(ctx, srv, errors)
            print("-- 16G sizing [desktop 1920]")
            p.set_viewport_size({"width": 1920, "height": 1000})
            p.wait_for_timeout(900)
            mw = lambda: p.eval_on_selector(".carnet-main", "e => Math.round(e.getBoundingClientRect().width)")  # noqa: E731
            w0 = mw()
            check(p.locator(".carnet-page-grip:not([hidden])").count() == 1, "a width handle on the page edge")
            g = p.locator(".carnet-page-grip").bounding_box()
            p.mouse.move(g["x"] + g["width"] / 2, g["y"] + 300)
            p.mouse.down()
            p.mouse.move(g["x"] + g["width"] / 2 + 140, g["y"] + 300, steps=10)
            check(p.locator(".carnet-size-tip.is-on").count() == 1, "a label shows the width while dragging")
            p.mouse.up()
            p.wait_for_timeout(400)
            w1 = mw()
            check(w1 > w0 + 150, f"dragging the edge widens the page ({w0} -> {w1})")
            check(p.eval_on_selector(".carnet-paper", "e => Math.round(e.getBoundingClientRect().width)") >= w1 - 2, "the paper follows")
            p.reload()
            p.wait_for_timeout(800)
            if not p.locator("#hq-carnet-editor").count():
                p.locator('.bottom-nav [data-nav="carnet"]').click()
            p.wait_for_selector("#hq-carnet-editor")
            p.wait_for_timeout(1200)
            check(abs(mw() - w1) <= 2, "the width is remembered on this device")
            p.locator(".carnet-page-grip").dblclick()
            p.wait_for_timeout(500)
            check(abs(mw() - w0) <= 2, f"double-click goes back to the default width ({mw()} vs {w0})")
            # library width
            check(p.locator(".carnet-side-grip:not([hidden])").count() == 1, "a handle between the library and the page")
            lw = lambda: p.eval_on_selector(".carnet-library", "e => Math.round(e.getBoundingClientRect().width)")  # noqa: E731
            l0 = lw()
            sg = p.locator(".carnet-side-grip").bounding_box()
            p.mouse.move(sg["x"] + sg["width"] / 2, sg["y"] + 200)
            p.mouse.down()
            p.mouse.move(sg["x"] + sg["width"] / 2 + 80, sg["y"] + 200, steps=8)
            p.mouse.up()
            p.wait_for_timeout(400)
            check(lw() >= l0 + 70, f"dragging widens the library ({l0} -> {lw()})")
            p.locator(".carnet-side-grip").dblclick()
            p.wait_for_timeout(500)
            check(abs(lw() - l0) <= 2, "double-click resets the library width")
            # text size
            fs = lambda: p.evaluate("() => { const s = getComputedStyle(document.querySelector('.hq-carnet')); return [parseFloat(s.getPropertyValue('--carnet-fs')), parseFloat(s.getPropertyValue('--carnet-lh'))]; }")  # noqa: E731
            f0 = fs()
            p.locator("#btn-carnet-more").click()
            check(p.locator(".carnet-size-group").count() == 1, "an Affichage group in the tools")
            p.locator(".carnet-size-plus").click()
            p.locator(".carnet-size-plus").click()
            f1 = fs()
            check(f1[0] > f0[0] and f1[1] > f0[1] and float(f1[1]).is_integer(), f"A+ grows text and line height in whole pixels ({f0} -> {f1})")
            check(p.eval_on_selector(".carnet-line", "e => Math.round(e.getBoundingClientRect().height)") == int(f1[1]), "lines stay on the ruled grid")
            p.locator("#hq-carnet-editor").click()
            p.keyboard.press("Control+<")
            check(fs()[0] < f1[0], "Ctrl+< makes the text smaller")
            if p.get_attribute("#btn-carnet-more", "aria-expanded") != "true":
                p.locator("#btn-carnet-more").click()
            p.locator(".carnet-size-reset").click()
            check(fs() == f0, "Défaut restores the text size")
            print("-- 16H paper look + calm top bar [desktop]")
            check(p.locator(".carnet-bar-top #btn-carnet-insert").count() == 1, "« + Insérer » sits in the top bar")
            tb = p.eval_on_selector(".carnet-bar-top", "e => Math.round(e.getBoundingClientRect().height)")
            check(tb <= 60, f"the top bar is one row on a PC ({tb}px)")
            p.locator('[data-carnet-paper="grid"]').click()
            p.locator('[data-carnet-tint="sepia"]').click()
            look = p.evaluate("() => { const h = document.querySelector('.hq-carnet'); return [h.dataset.paper, h.dataset.tint, getComputedStyle(document.querySelector('.carnet-paper')).backgroundColor, getComputedStyle(document.querySelector('.carnet-editor')).backgroundImage.split('linear-gradient').length - 1]; }")
            check(look[0] == "grid" and look[1] == "sepia", f"paper and tint are applied ({look[:2]})")
            check(look[3] == 2, "squared paper draws both directions")
            check(p.eval_on_selector('[data-carnet-paper="grid"]', "e => e.getAttribute('aria-pressed')") == "true", "the chosen paper shows as selected")
            p.locator('[data-carnet-paper="blueprint"]').click()
            p.wait_for_timeout(600)  # the paper colour cross-fades
            check(p.evaluate("() => getComputedStyle(document.querySelector('.carnet-paper')).backgroundColor") == "rgb(15, 58, 107)", "blueprint paper is blue")
            p.locator('[data-carnet-paper="lines"]').click()
            p.locator('[data-carnet-tint="auto"]').click()
            check(p.evaluate("() => !document.querySelector('.hq-carnet').hasAttribute('data-paper') && !document.querySelector('.hq-carnet').hasAttribute('data-tint')"), "Lignes + Auto is the default look again")
            p.locator("#hq-carnet-editor").click()
            p.keyboard.type("calme")
            p.wait_for_timeout(1400)
            op = p.eval_on_selector(".carnet-bar-top", "e => parseFloat(getComputedStyle(e).opacity)")
            check(op < 0.3, f"the top bar fades while typing ({op})")
            box = p.eval_on_selector("#hq-carnet-editor", "e => { const r = e.getBoundingClientRect(); return [r.left + 200, r.top + 200]; }")
            p.mouse.move(box[0], box[1])
            p.mouse.move(box[0] + 60, box[1] + 30, steps=6)
            p.wait_for_timeout(500)
            op = p.eval_on_selector(".carnet-bar-top", "e => parseFloat(getComputedStyle(e).opacity)")
            check(op > 0.9, f"it comes back when the mouse moves ({op})")
            for _ in range(5):
                p.keyboard.press("Backspace")
            if p.get_attribute("#btn-carnet-more", "aria-expanded") != "true":
                p.locator("#btn-carnet-more").click()
            p.locator('.carnet-size-width[data-carnet-width="0"]').click()
            p.wait_for_timeout(400)
            check(mw() >= w1, "Pleine largeur uses all the room")
            if shots:
                p.screenshot(path=str(shots / "desktop-full-width.jpg"), type="jpeg", quality=55, scale="css")
            over = p.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(over <= 0, f"no sideways scroll at full width ({over}px)")
            b.close()
            b, ctx = ctx_for(pw, srv, True)
            p = open_page(ctx, srv, errors)
            print("-- 16G sizing [phone]")
            check(p.locator(".carnet-page-grip:not([hidden])").count() == 0 and p.locator(".carnet-side-grip:not([hidden])").count() == 0, "no width handles on a phone")
            p.locator("#btn-carnet-more").click()
            check(p.locator(".carnet-size-widths[hidden]").count() == 1, "width presets are PC-only")
            p.locator(".carnet-size-plus").click()
            check(p.evaluate("() => parseFloat(getComputedStyle(document.querySelector('.hq-carnet')).getPropertyValue('--carnet-fs'))") > 17, "A+ works on the phone")
            p.locator('[data-carnet-tint="black"]').click()
            p.wait_for_timeout(600)
            check(p.evaluate("() => getComputedStyle(document.querySelector('.carnet-paper')).backgroundColor") == "rgb(0, 0, 0)", "black paper on the phone")
            tb = p.eval_on_selector(".carnet-bar-top", "e => Math.round(e.getBoundingClientRect().height)")
            check(tb <= 110, f"the phone top bar takes two rows at most ({tb}px)")
            over = p.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(over <= 0, f"no sideways scroll with bigger text ({over}px)")
            b.close()

            # ---------------------------------------------------------------- 16I feel
            srv.seed(seed16i())
            b, ctx = ctx_for(pw, srv, False)
            p = open_page(ctx, srv, errors)
            p.wait_for_function("() => !!window.HqCarnetFeel")
            print("-- 16I feel [desktop]")
            # smooth caret
            p.locator('[data-carnet-block-id="block-c1601"]').click()
            p.wait_for_timeout(250)
            cr = p.evaluate("""() => { const c = document.querySelector('.c16-caret.is-on'); if (!c) return null;
              const s = getSelection().getRangeAt(0).getClientRects(); const pr = document.querySelector('.carnet-paper').getBoundingClientRect();
              return [c.getBoundingClientRect().left, s.length ? s[0].left : null,
              document.querySelector('#hq-carnet-editor').classList.contains('c16-caret-on'), getComputedStyle(document.querySelector('#hq-carnet-editor')).caretColor]; }""")
            check(cr is not None and cr[2], f"a smooth caret replaces the native one ({cr})")
            check(cr is not None and (cr[1] is None or abs(cr[0] - cr[1]) < 3), "it sits exactly where the native caret would")
            x0 = cr[0] if cr else 0
            p.keyboard.press("Home")
            p.wait_for_timeout(250)
            x1 = p.evaluate("() => document.querySelector('.c16-caret').getBoundingClientRect().left")
            check(x1 < x0 - 30, f"it glides to the start of the line ({x0:.0f} -> {x1:.0f})")
            check(p.evaluate("() => getComputedStyle(document.querySelector('.c16-caret')).transitionProperty.includes('transform')"), "the caret move is a transition, not a jump")
            # marker sweep
            p.evaluate("""() => { const ln = document.querySelector('[data-carnet-block-id="block-c1605"]'); const t = ln.querySelector('.carnet-line-text') || ln;
              const w = document.createTreeWalker(t, NodeFilter.SHOW_TEXT); const n = w.nextNode(); const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 6);
              const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new Event('selectionchange')); }""")
            p.wait_for_timeout(300)
            hb = p.locator('.carnet-sel-toolbar:not([hidden]) [data-carnet-sel="highlight"]')
            if hb.count():
                hb.click()
                swept = wait(lambda: p.evaluate("() => !!document.querySelector('[data-carnet-block-id=\"block-c1605\"] .c16-sweep')"), "the highlight sweeps in", timeout=2, page=p)
                if swept:
                    check(p.evaluate("() => getComputedStyle(document.querySelector('.c16-sweep')).animationName") == "c16-sweep", "with the marker animation")
                p.wait_for_timeout(800)
                check(p.locator(".c16-sweep").count() == 0, "the sweep leaves nothing behind")
            else:
                check(False, "the selection toolbar offers « Surligné »")
            # strike-through drawn across a ticked item
            p.locator('[data-carnet-block-id="block-c1604"] .carnet-check').click()
            check(wait(lambda: p.locator(".c16-strike").count() >= 1, "a stroke is drawn", timeout=2, page=p), "ticking draws a stroke across the item")
            p.wait_for_timeout(900)
            check(p.locator(".c16-strike").count() == 0, "the stroke overlay cleans up")
            # exits
            p.evaluate("() => window.hqCarnetBlockMenu(document.querySelector('[data-carnet-block-id=\"block-c1601\"]'))")
            p.wait_for_selector(".carnet-block-menu:not([hidden])")
            p.keyboard.press("Escape")
            gh = p.evaluate("() => { const g = document.querySelector('.carnet-block-menu.c16-ghost'); return g ? [g.hasAttribute('inert'), g.getAttribute('aria-hidden'), g.querySelectorAll('[id],[data-carnet-cmd]').length, getComputedStyle(g).pointerEvents] : null; }")
            check(gh is not None, "the block menu plays an exit")
            check(gh is not None and gh[0] and gh[1] == "true" and gh[2] == 0 and gh[3] == "none", f"the exit copy is inert and unfindable ({gh})")
            check(p.locator(".carnet-block-menu:not([hidden])").count() == 0, "the real menu is already closed")
            p.wait_for_timeout(500)
            check(p.locator(".c16-ghost").count() == 0, "exit copies are removed")
            p.locator("#btn-carnet-more").click()
            p.wait_for_timeout(300)
            p.locator("#btn-carnet-more").click()
            check(p.locator(".carnet-tools.c16-ghost").count() == 1, "the « ⋯ » tools fold away instead of vanishing")
            p.wait_for_timeout(500)
            # outline scrollspy
            p.locator("#btn-carnet-outline").click()
            p.wait_for_selector(".carnet-outline:not([hidden]):not(.c16-ghost)")
            p.wait_for_timeout(200)
            cur = lambda: p.evaluate("() => { const c = document.querySelector('.carnet-outline:not(.c16-ghost) .c16-current'); return c ? c.textContent.trim() : ''; }")  # noqa: E731
            check(p.locator(".c16-outline-mark").count() == 1, "the outline has a reading marker")
            c0 = cur()
            p.evaluate("() => document.querySelector('[data-carnet-block-id=\"block-c1603\"]').scrollIntoView({block:'start'})")
            p.wait_for_timeout(500)
            c1 = cur()
            check("Section B" not in c0 and "Section B" in c1, f"the marker follows the section being read ({c0!r} -> {c1!r})")
            p.keyboard.press("Escape")
            p.evaluate("() => scrollTo(0, 0)")
            p.wait_for_timeout(400)
            # paper light
            pb = p.locator(".carnet-paper").bounding_box()
            p.mouse.move(pb["x"] + 40, pb["y"] + 60)
            p.mouse.move(pb["x"] + 60, pb["y"] + 80, steps=3)
            p.wait_for_timeout(150)
            lx = p.evaluate("() => document.querySelector('.carnet-paper').style.getPropertyValue('--c16-lx')")
            check(lx.endswith("px") and float(lx[:-2]) > 0, f"the paper's light follows the mouse ({lx})")
            # sticky notes: alignment guides, snapping, crumple
            n0 = p.locator(".carnet-sticky").count()  # notes left by the earlier sections stay on page-a
            p.evaluate("() => window.HqCarnetStickies.add()")
            p.wait_for_timeout(500)
            p.evaluate("() => window.HqCarnetStickies.add()")
            wait(lambda: p.locator(".carnet-sticky").count() == n0 + 2, "two notes", page=p)
            p.wait_for_timeout(600)
            st = p.evaluate("() => [...document.querySelectorAll('.carnet-sticky')].map(n => [n.offsetLeft, n.offsetTop])")
            st = st[n0:]
            bb = p.locator(".carnet-sticky").nth(n0 + 1).locator(".carnet-sticky-bar").bounding_box()
            gx, gy = bb["x"] + 110, bb["y"] + bb["height"] / 2  # the title part of the bar (not a button)
            p.mouse.move(gx, gy)
            p.mouse.down()
            w0 = p.evaluate("(i) => document.querySelectorAll('.carnet-sticky')[i].offsetWidth", n0)
            target_dx = st[0][0] - w0 - 5 - st[1][0]  # its right edge 5 px left of the other note's left edge
            p.mouse.move(gx + target_dx / 2, gy + 120, steps=4)
            p.mouse.move(gx + target_dx, gy + 140, steps=4)
            p.wait_for_timeout(80)
            guide = p.locator(".carnet-sticky-guide.is-on").count()
            p.mouse.up()
            p.wait_for_timeout(500)
            st2 = p.evaluate("() => [...document.querySelectorAll('.carnet-sticky')].map(n => [n.offsetLeft, n.offsetTop])")[n0:]
            check(guide >= 1, "a guide shows while the note lines up")
            check(st2[1][0] + w0 == st2[0][0], f"the note snaps onto the other one's edge ({st2}, w {w0})")
            check(p.locator(".carnet-sticky-guide.is-on").count() == 0, "guides go away on release")
            p.locator(".carnet-sticky").nth(n0 + 1).locator(".carnet-sticky-close").click()
            n_anim = p.evaluate("(i) => { const n = document.querySelectorAll('.carnet-sticky'); return n.length > i ? n[i].getAnimations().length : -1; }", n0 + 1)
            check(n_anim >= 1, "closing a note crumples it")
            wait(lambda: p.locator(".carnet-sticky").count() == n0 + 1, "the crumpled note is removed", page=p)
            p.locator(".carnet-sticky").nth(n0).locator(".carnet-sticky-close").click()
            p.wait_for_timeout(600)
            # new page drops in
            p.locator("#btn-carnet-new").click()
            check(wait(lambda: p.evaluate("() => document.querySelector('.carnet-paper').getAnimations().some(a => a.playState === 'running')"), "the new page lands", timeout=3, page=p), "a new page lands from the stack")
            p.wait_for_timeout(700)
            if shots:
                p.screenshot(path=str(shots / "desktop-16i.jpg"), type="jpeg", quality=55, scale="css")
            # the page goes to the Corbeille
            p.locator("#btn-carnet-more").click()
            p.locator("[data-carnet-trash]").click()
            check(wait(lambda: p.locator(".c16-trash-ghost").count() == 1, "crumple", timeout=2, page=p), "a trashed page crumples toward the Corbeille")
            p.wait_for_timeout(900)
            check(p.locator(".c16-trash-ghost").count() == 0, "and is gone after the flight")
            b.close()
            b, ctx = ctx_for(pw, srv, True)
            p = open_page(ctx, srv, errors)
            print("-- 16I sheets [phone]")
            p.locator("#btn-carnet-library").click()
            p.wait_for_selector('.carnet-library[data-mode="sheet"]:not([hidden]):not(.c16-ghost)')
            p.wait_for_timeout(500)
            hb = p.locator(".carnet-library:not(.c16-ghost) .carnet-lib-head").bounding_box()
            touch_drag(p, ".carnet-library:not(.c16-ghost) .carnet-lib-head", hb["x"] + 60, hb["y"] + 20, hb["x"] + 60, hb["y"] + 70, steps=5, ms=70)
            p.wait_for_timeout(450)
            check(p.locator('.carnet-library[data-mode="sheet"]:not([hidden]):not(.c16-ghost)').count() == 1, "a short pull springs the sheet back")
            check(p.evaluate("() => !document.querySelector('.carnet-library:not(.c16-ghost)').style.transform"), "it settles back in place")
            touch_drag(p, ".carnet-library:not(.c16-ghost) .carnet-lib-head", hb["x"] + 60, hb["y"] + 20, hb["x"] + 60, hb["y"] + 420, steps=10)
            p.wait_for_timeout(60)
            check(p.locator('.carnet-library[data-mode="sheet"]:not([hidden]):not(.c16-ghost)').count() == 0, "a long pull closes the library sheet")
            check(p.locator(".carnet-library.c16-ghost").count() == 1, "it slides away from under the finger")
            p.wait_for_timeout(600)
            p.locator("#btn-carnet-outline").click()
            p.wait_for_selector(".carnet-outline:not([hidden]):not(.c16-ghost)")
            p.wait_for_timeout(500)
            ob = p.locator(".carnet-outline:not(.c16-ghost) .carnet-outline-head").bounding_box()
            touch_drag(p, ".carnet-outline:not(.c16-ghost) .carnet-outline-head", ob["x"] + 60, ob["y"] + 15, ob["x"] + 60, ob["y"] + 330, steps=8)
            p.wait_for_timeout(100)
            check(p.locator(".carnet-outline:not([hidden]):not(.c16-ghost)").count() == 0, "the outline sheet closes the same way")
            p.wait_for_timeout(500)
            check(p.evaluate("() => !document.querySelector('.c16-caret.is-on')"), "no custom caret on a touch screen")
            b.close()

            # ---------------------------------------------------------------- reduced motion
            srv.seed(seed())
            b, ctx = ctx_for(pw, srv, True, reduced=True)
            p = open_page(ctx, srv, errors)
            print("-- reduced motion [phone]")
            rb = p.locator("#btn-carnet-sticky").bounding_box()
            p.mouse.move(rb["x"] + 5, rb["y"] + 5)
            p.mouse.down()
            check(p.locator(".c16-ripple").count() == 0, "no ripple with reduced motion")
            p.mouse.up()
            p.wait_for_timeout(300)
            p.evaluate("() => window.hqCarnetBlockMenu(document.querySelector('[data-carnet-block-id=\"block-c1602\"]'))")
            p.wait_for_selector(".carnet-block-menu:not([hidden])")
            anim = p.evaluate("() => getComputedStyle(document.querySelector('.carnet-block-menu')).animationName")
            check(anim in ("c16-fade", "none"), f"menus only fade ({anim})")
            p.keyboard.press("Escape")
            box = p.eval_on_selector(".carnet-stage", "e => { const r = e.getBoundingClientRect(); return [r.left, r.top, r.width]; }")
            touch_drag(p, ".carnet-stage", box[0] + box[2] - 40, box[1] + 200, box[0] + 30, box[1] + 200)
            wait(lambda: p.eval_on_selector("#hq-carnet-editor", "e => e.dataset.pageId") == "page-b", "a swipe still turns the page", timeout=4, page=p)
            check(p.eval_on_selector(".carnet-paper", "e => !e.style.transform && e.getAnimations().length === 0"), "no page movement at all")
            p.evaluate("() => window.hqCarnetBlockMenu(document.querySelector('[data-carnet-block-id=\"block-c1690\"]'))")
            p.wait_for_selector(".carnet-block-menu:not([hidden])")
            p.keyboard.press("Escape")
            check(p.locator(".c16-ghost").count() == 0, "no exit copies with reduced motion")
            b.close()
    finally:
        srv.close()
    errs = [e for e in errors if "favicon" not in e and "409 (Conflict)" not in e]  # the conflict check provokes one 409 on purpose
    check(not errs, "no page errors " + json.dumps(errs[:5], ensure_ascii=False))
    print("FAILED: %d" % len(FAILS) if FAILS else "visual_carnet_16c: ok")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
