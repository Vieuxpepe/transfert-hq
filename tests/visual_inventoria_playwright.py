"""Inventoria panel browser checks — Chromium, phone viewports: Suivi tab, item sheet, offline queue, language, layout.

Not part of unittest discovery. Runs a throwaway loopback HQ (temp ROOT, fake PINs, see visual_carnet_playwright.Server); never touches
the live root. Skips (exit 0) when Playwright or Chromium is unavailable.

    python tests/visual_inventoria_playwright.py [--shots <dir>]
"""
import json
import sys
import time
from pathlib import Path

from hq_browser_nav import open_section

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(SOURCE / "tests"))

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover
    print("SKIP: playwright not installed")
    sys.exit(0)

import visual_carnet_playwright as V  # noqa: E402

FAILS = []
# other modules' console noise that is not Inventoria's: auth probes and unfinished work elsewhere in the tree
IGNORED = ("401", "404", "Failed to load resource", "createClock")


def check(ok, msg):
    print(("  OK   " if ok else "  FAIL ") + msg)
    if not ok:
        FAILS.append(msg)


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    srv = V.Server()
    errors = []
    try:
        import hq_inventory as inv
        import hq_inventoria_habits as habits
        import hq_inventoria_links as links

        inv.apply({"action": "place.create", "name": "Atelier", "kind": "shelf"})
        place = inv.snapshot()["places"][0]["id"]
        for name, qty, unit, mn in (("Lait", 5, "L", 2), ("Vis M3", 40, "pcs", 20)):
            inv.apply({"action": "item.create", "name": name, "qty": qty, "unit": unit, "min": mn, "place": place})
        ids = {i["name"]: i["id"] for i in inv.snapshot()["items"]}
        habits.link_barcode(srv.root, "0123456789012", ids["Lait"])

        def qty(name):
            return next(i["qty"] for i in inv.snapshot()["items"] if i["name"] == name)

        def minimum(name):
            return next(i["min"] for i in inv.snapshot()["items"] if i["name"] == name)

        hdr = {"Origin": srv.base, "Content-Type": "application/json"}
        with sync_playwright() as pw:
            for width in (390, 320):
                b = pw.chromium.launch()
                ctx = b.new_context(viewport={"width": width, "height": 844}, has_touch=True, is_mobile=True, device_scale_factor=2)
                ctx.request.post(srv.base + "/login", form={"pin": V.ADMIN_PIN}, headers={"Origin": srv.base}, max_redirects=0)
                page = ctx.new_page()
                page.on("pageerror", lambda e: errors.append("pageerror " + str(e)) if not any(x in str(e) for x in IGNORED) else None)
                page.on("console", lambda m: errors.append("console " + m.text) if m.type == "error" and not any(x in m.text for x in IGNORED) else None)
                page.goto(srv.base + "/")
                open_section(page, "inventaire")
                page.wait_for_selector("#hq-inv-app .inv-main")
                page.evaluate("() => window.HqInventoria.open()")
                page.wait_for_timeout(900)
                print(f"-- phone {width}px")
                tabs = page.evaluate("() => [...document.querySelectorAll('.hq-inventoria-tab')].map((e) => ({id: e.dataset.tab, w: e.getBoundingClientRect().width, h: e.getBoundingClientRect().height}))")
                check([t["id"] for t in tabs] == ["chat", "shop", "suivi", "settings"], "four tabs: Chat, To buy, Tracking, Settings")
                check(all(t["h"] >= 43.5 for t in tabs), "every tab is at least 44px tall")
                check(page.evaluate("() => { const e = document.querySelector('.hq-inventoria-tabs'); return e.scrollWidth <= e.clientWidth + 1; }"), "the tab bar does not overflow")
                lang = ctx.request.get(srv.base + "/api/inventoria/status").json().get("language")
                label = page.locator("#hq-inv-tab-chat").inner_text().strip()
                check(label == ("Chat" if lang == "en" else "Discuter"), f"the tab labels follow the language setting ({lang}: {label!r})")
                if width != 390:
                    b.close()
                    continue
                if lang == "en":
                    page.evaluate("() => document.querySelectorAll('#hq-inventoria details').forEach((d) => { d.open = true; })")
                    seen = set()
                    for tab in ("chat", "shop", "suivi", "settings"):
                        page.locator(f"#hq-inv-tab-{tab}").click()
                        page.evaluate("() => document.querySelectorAll('#hq-inventoria details').forEach((d) => { d.open = true; })")
                        page.wait_for_timeout(500)
                        seen.update(page.evaluate("""() => {
                          const out = [], root = document.getElementById('hq-inventoria');
                          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n;
                          while ((n = w.nextNode())) { if (n.parentElement.closest('.hq-inventoria-thread-log,textarea,select,option,script,style')) continue; const t = n.nodeValue.replace(/\s+/g, ' ').trim(); if (t) out.push(t); }
                          root.querySelectorAll('[aria-label],[title],[placeholder]').forEach((e) => ['aria-label', 'title', 'placeholder'].forEach((a) => { const v = e.getAttribute(a); if (v) out.push(v); }));
                          return out; }"""))
                    import re
                    french = re.compile(r"[éèêàâçùûôîï]|(le|la|les|une|des|du|pour|avec|dans|sur|tu|ton|est|sont|pas|aussi|tout|rien|déjà|puis|sans|que|qui)", re.I)
                    left = sorted(x for x in seen if french.search(x))
                    check(not left, "no French left in the English panel " + json.dumps(left[:6], ensure_ascii=False))
                    page.locator("#hq-inv-tab-chat").click()
                sid = ctx.request.post(srv.base + "/api/inventoria/sessions", data=json.dumps({"device_id": "t"}), headers=hdr).json()["session"]["id"]
                ctx.request.post(srv.base + "/api/inventoria/quick", data=json.dumps({"session_id": sid, "item_id": ids["Lait"], "delta": -1}), headers=hdr)
                check(qty("Lait") == 4, "a trusted change applied at once")
                page.evaluate("() => window.HqInventoria.ui.refreshStatus({force: true})")
                page.locator("#hq-inv-tab-suivi").click()
                page.evaluate("() => { const d = document.querySelector('details[data-sec=history]'); if (!d.open) d.open = true; }")   # the text scan left another section open
                page.wait_for_selector(".hq-inventoria-history-row")
                check(page.locator(".hq-inventoria-history-row").count() == 1, "History lists the change")
                page.locator(".hq-inventoria-history-undo").click()
                try:
                    page.wait_for_selector(".hq-inventoria-history-row.is-undone", timeout=10000)   # validate + preview + commit take a moment
                except Exception:
                    pass
                check(qty("Lait") == 5, "Undo from History puts the stock back")
                check(page.locator(".hq-inventoria-history-row.is-undone").count() == 1, "the undone change is marked")
                # the item sheet
                page.evaluate(f"() => window.HqInventoria.openItem('{ids['Lait']}')")
                page.wait_for_selector(".hq-inventoria-sheet input[type=number]")
                page.locator(".hq-inventoria-sheet input[type=number]").fill("9")
                page.locator(".hq-inventoria-sheet button", has_text=("Save" if lang == "en" else "Enregistrer")).first.click()
                page.wait_for_timeout(700)
                check(minimum("Lait") == 9, "the minimum saved from the sheet reaches the inventory")
                check(qty("Lait") == 5, "and it did not touch the quantity")
                soon = time.strftime("%Y-%m-%d", time.localtime(time.time() + 2 * 86400))
                page.locator(".hq-inventoria-sheet input[type=date]").fill(soon)
                page.locator(".hq-inventoria-sheet button", has_text=("Save" if lang == "en" else "Enregistrer")).nth(1).click()
                page.wait_for_timeout(700)
                check(links.get_expiry(srv.root, ids["Lait"]) == soon, "the expiry date saved from the sheet is stored")
                page.locator(".hq-inventoria-sheet button[aria-label*='0123456789012']").click()
                page.wait_for_timeout(700)
                check(habits.barcodes_for(srv.root, ids["Lait"]) == [], "unlinking a barcode from the sheet removes it")
                if shots:
                    page.screenshot(path=str(shots / "inventoria-sheet.png"))
                page.keyboard.press("Escape")
                check(page.locator(".hq-inventoria-sheet").count() == 0, "Escape closes the sheet")
                # offline: kept, shown, sent once
                page.locator("#hq-inv-tab-chat").click()
                ctx.set_offline(True)
                page.evaluate("() => window.dispatchEvent(new Event('offline'))")
                page.evaluate(f"() => window.HqInventoria.ui.quickAdjust('{ids['Vis M3']}', -3, 'Vis -3')")
                page.wait_for_timeout(500)
                check(page.evaluate("() => JSON.parse(localStorage.getItem('hq_inventoria_queue_v1') || '[]').length") == 1, "an offline change is queued")
                check(page.locator(".hq-inventoria-offline:not([hidden])").count() == 1, "and the banner says so")
                check(qty("Vis M3") == 40, "nothing reached the server while offline")
                ctx.set_offline(False)
                page.evaluate("() => window.dispatchEvent(new Event('online'))")
                for _ in range(60):                              # the page's CSP forbids wait_for_function: poll instead (up to 12 s under load)
                    if page.evaluate("() => JSON.parse(localStorage.getItem('hq_inventoria_queue_v1') || '[]').length") == 0:
                        break
                    page.wait_for_timeout(200)
                page.wait_for_timeout(300)
                check(qty("Vis M3") == 37, "on reconnect the change landed exactly once")
                check(page.evaluate("() => JSON.parse(localStorage.getItem('hq_inventoria_queue_v1') || '[]').length") == 0, "and the queue is empty")

                # feel pass: a slow network must not make a tap feel slow
                cdp = ctx.new_cdp_session(page)
                cdp.send("Network.enable")
                cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 1500, "downloadThroughput": -1, "uploadThroughput": -1})
                page.locator("#hq-inv-tab-chat").click()
                got = page.evaluate("""async (id) => {
                  const t0 = performance.now();
                  window.HqInventoria.ui.quickAdjust(id, -1, 'Vis -1');
                  return await new Promise((res) => { const i = setInterval(() => { const t = document.querySelector('.hq-inventoria-toast');
                    if (t && !t.hidden && t.textContent.trim()) { clearInterval(i); res({ ms: performance.now() - t0, text: t.textContent.trim() }); } }, 4); }); }""", ids["Vis M3"])
                check(got["ms"] < 150 and ("Saving" in got["text"] or "Enregistrement" in got["text"]),
                      f"the tap is acknowledged at once on a 1.5 s network ({got['ms']:.0f} ms: {got['text']!r})")
                page.wait_for_selector(".hq-inventoria-toast-undo", timeout=12000)
                check(qty("Vis M3") == 36, "and the real answer then replaces it, applied once")
                cdp.send("Network.emulateNetworkConditions", {"offline": False, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1})

                # calm state: with the use-by date cleared and nothing low, the panel says so (and only then)
                links.set_expiry(srv.root, ids["Lait"], None)
                page.evaluate("() => window.HqInventoria.ui.refreshStatus({force: true})")
                page.locator("#hq-inv-tab-shop").click()
                page.wait_for_timeout(600)
                low = page.locator(".hq-inventoria-checks li input[type=checkbox]").count()
                check(low >= 1, "Lait is low (minimum 9, five on the shelf): the list shows it, so no calm line")
                check(not page.locator(".hq-inventoria-shop-empty").is_visible(), "nothing is declared 'all good' while something is low")

                # shop mode: big rows, the row is the checkbox, the bar to finish stays in view, one gesture marks it bought
                page.locator(".hq-inventoria-shopmode").click()
                check(page.evaluate("() => document.getElementById('hq-inv-pane-shop').classList.contains('is-shopping')"), "shop mode turns on")
                row = page.locator(".hq-inventoria-checks li", has=page.locator("input[type=checkbox]")).first
                box = row.bounding_box()
                check(box["height"] >= 55, f"shop-mode rows are big enough for a thumb ({box['height']:.0f}px)")
                row.locator("span").first.click()
                check(page.locator(".hq-inventoria-checks li input[type=checkbox]").first.is_checked(), "tapping the name ticks the row")
                check(page.locator(".hq-inventoria-sheet").count() == 0, "and does not open the item sheet instead")
                check(page.evaluate("() => Object.keys(JSON.parse(localStorage.getItem('hq_inventoria_checked_v1') || '{}')).length") == 1, "the tick survives a closed app")
                done_btn = page.locator("#hq-inv-pane-shop button.is-primary")
                dbox = done_btn.bounding_box()
                check(dbox["y"] + dbox["height"] <= 844 + 1 and dbox["height"] >= 51, f"the finish button stays on screen ({dbox['y']:.0f}+{dbox['height']:.0f})")
                before = qty("Lait")
                if shots:
                    page.screenshot(path=str(shots / "inventoria-shop-mode.png"))
                done_btn.click()
                try:
                    page.wait_for_selector(".hq-inventoria-toast-undo", timeout=10000)
                except Exception:
                    pass
                check(qty("Lait") > before, "one tap marked it bought and the stock went up")
                check(page.evaluate("() => Object.keys(JSON.parse(localStorage.getItem('hq_inventoria_checked_v1') || '{}')).length") == 0, "the ticks are cleared once bought")
                page.evaluate("() => window.HqInventoria.ui.refreshStatus({force: true})")
                page.wait_for_timeout(800)
                check(not page.evaluate("() => document.getElementById('hq-inv-pane-shop').classList.contains('is-shopping')"), "shop mode ends by itself once the list is done")
                page.locator("#hq-inv-tab-shop").click()                 # the Undo toast lives in Chat, where a purchase sends you
                calm = page.locator(".hq-inventoria-shop-empty")
                check(calm.is_visible() and ("Nothing to buy" in calm.inner_text() or "Rien à acheter" in calm.inner_text()), "now the panel says nothing needs attention: " + calm.inner_text().strip())

                # discretion settings
                import hq_inventoria_feel as feel
                page.locator("#hq-inv-tab-settings").click()
                page.evaluate("() => { const d = document.querySelector('.hq-inventoria-quietbox'); if (!d.open) d.open = true; }")
                cap = page.locator(".hq-inventoria-quietbox input").first
                cap.fill("3")
                cap.dispatch_event("change")
                page.wait_for_timeout(700)
                check(feel.asks_get(srv.root)["max_per_day"] == 3, "the daily cap saved from the panel reaches the server")
                if shots:
                    page.screenshot(path=str(shots / "inventoria-discretion.png"))
                b.close()
    finally:
        srv.close()
    errs = [e for e in errors if "favicon" not in e]
    check(not errs, "no page errors from Inventoria " + json.dumps(errs[:5], ensure_ascii=False))
    print("FAILED: %d" % len(FAILS) if FAILS else "visual_inventoria: ok")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
