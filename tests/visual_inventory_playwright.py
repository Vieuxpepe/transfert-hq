"""Inventaire browser checks — Chromium, desktop + phone viewports.

Not part of unittest discovery. Runs a throwaway loopback HQ (temp ROOT, fake PINs, see visual_carnet_playwright.Server);
never touches the live root. Skips (exit 0) when Playwright or Chromium is unavailable.

    python tests/visual_inventory_playwright.py [--shots <dir>]
"""
import json
import struct
import sys
import time
import zlib
from pathlib import Path

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


def check(ok, msg):
    print(("  OK   " if ok else "  FAIL ") + msg)
    if not ok:
        FAILS.append(msg)


def wait(fn, msg, page, timeout=6.0):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if fn():
                return True
        except Exception:
            pass
        page.wait_for_timeout(80)
    check(False, msg + " (timeout)")
    return False


def png(w=64, h=48):
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            row += bytes([(x * 4) % 256, (y * 5) % 256, 140])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def ctx_for(pw, srv, phone, login=True):
    b = pw.chromium.launch()
    opts = {"viewport": {"width": 390, "height": 844}, "has_touch": True, "is_mobile": True, "device_scale_factor": 2} if phone else {"viewport": {"width": 1280, "height": 860}}
    ctx = b.new_context(**opts)
    if login:
        r = ctx.request.post(srv.base + "/login", form={"pin": V.ADMIN_PIN}, headers={"Origin": srv.base}, max_redirects=0)
        assert r.status == 303, r.status
    return b, ctx


def store(srv):
    p = srv.root / ".hq-inventory" / "inventory.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {"places": [], "items": []}


def open_inv(ctx, srv, errors, hash_=""):
    p = ctx.new_page()
    p.on("pageerror", lambda e: errors.append("pageerror " + str(e)))
    p.on("console", lambda m: errors.append("console " + m.text) if m.type == "error" else None)
    p.goto(srv.base + "/" + hash_)
    if not hash_:
        p.locator('.bottom-nav [data-nav="inventaire"]').click()
    p.wait_for_selector("#hq-inv-app .inv-main")
    p.wait_for_timeout(400)
    return p


def sheet_save(p):
    p.locator(".inv-sheet .inv-save").click()
    p.wait_for_selector(".inv-sheet", state="detached")
    p.wait_for_timeout(250)


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    srv = V.Server()
    errors = []
    img = srv.root / "photo.png"
    img.write_bytes(png())
    try:
        with sync_playwright() as pw:
            b, ctx = ctx_for(pw, srv, False)
            p = open_inv(ctx, srv, errors)
            print("-- empty inventory [desktop]")
            check(p.evaluate("() => document.body.dataset.view") == "inventaire", "the Inventaire section opens from the nav")
            check(p.locator(".inv-welcome").count() == 1, "an empty inventory explains how to start")
            check(p.title().endswith("Inventaire"), "the tab title names the section")
            print("-- places")
            p.locator(".inv-welcome .inv-primary").click()
            p.wait_for_selector(".inv-sheet")
            p.locator(".inv-sheet input[type=text]").first.fill("Garage")
            check(p.eval_on_selector(".inv-sheet select", "s => s.value") == "room", "a top-level place defaults to « Pièce »")
            sheet_save(p)
            check(p.locator(".inv-toast:not([hidden])").inner_text().startswith("Emplacement créé"), "creating a place offers its label")
            garage = store(srv)["places"][0]
            check(garage["name"] == "Garage" and garage["parent"] is None, "the place is saved")
            p.locator(f'.inv-tile[data-inv-place="{garage["id"]}"]').click()
            check(p.locator(".inv-place-head .inv-title").inner_text() == "Garage", "a tile opens its place")
            check(p.evaluate("() => location.hash") == "#inventaire/" + garage["id"], "the address names the place")
            p.locator(".inv-actions button", has_text="Emplacement").click()
            p.locator(".inv-sheet input[type=text]").first.fill("Boîte visserie")
            check(p.eval_on_selector(".inv-sheet select >> nth=1", "s => s.value") == garage["id"], "a new place goes inside the open one")
            sheet_save(p)
            box = next(x for x in store(srv)["places"] if x["name"] == "Boîte visserie")
            check(box["parent"] == garage["id"] and box["kind"] == "box", "nested as a box")
            check(p.locator(f'.inv-tree [data-inv-place="{box["id"]}"]').count() == 1, "the tree shows the nested place")
            p.locator(f'.inv-tile[data-inv-place="{box["id"]}"]').click()
            check(p.locator(".inv-crumbs").inner_text().replace("\n", " ").count("Garage") == 1, "breadcrumbs show the path")
            print("-- items")
            p.locator(".inv-actions button", has_text="Objet").click()
            p.wait_for_selector(".inv-sheet")
            f = p.locator(".inv-sheet")
            f.locator("input[type=text]").nth(0).fill("Vis M4×12")
            f.locator("input[type=number]").nth(0).fill("10")
            f.locator("input[type=text]").nth(1).fill("pcs")
            f.locator("input[type=number]").nth(1).fill("12")
            f.locator("input[type=text]").nth(2).fill("#visserie M4")
            with p.expect_file_chooser() as fc:
                f.locator(".inv-photo-btns button", has_text="Choisir").click()
            fc.value.set_files(str(img))
            wait(lambda: f.locator(".inv-photo img").count() == 1, "the photo uploads", p)
            check(p.eval_on_selector(".inv-sheet .inv-photo img", "i => i.complete && i.naturalWidth > 0"), "and shows its thumbnail")
            sheet_save(p)
            item = store(srv)["items"][0]
            check((item["name"], item["qty"], item["unit"], item["min"], item["tags"], item["place"]) == ("Vis M4×12", 10, "pcs", 12, ["visserie", "m4"], box["id"]), f"the item is saved ({item['tags']})")
            check(len(item["photos"]) == 1 and item["photos"][0].startswith("asset-"), "with its photo in the image store")
            card = p.locator(f'.inv-item[data-inv-item="{item["id"]}"]')
            check("is-low" in (card.get_attribute("class") or ""), "10 under a threshold of 12 shows as low")
            check(p.locator('[data-inv-filter="low"] .inv-count').inner_text() == "1", "the Stock bas chip counts it")
            for _ in range(3):
                card.locator(".inv-step").nth(1).click()
            check(card.locator(".inv-qty-val").inner_text() == "13 pcs", "steppers move the number at once")
            wait(lambda: store(srv)["items"][0]["qty"] == 13, "quick taps are saved", p)
            check(store(srv)["items"][0]["rev"] == 2, "three taps became one write")
            check("is-low" not in (card.get_attribute("class") or ""), "back above the threshold")
            print("-- search")
            p.locator(".inv-search input").fill("ecrou")
            check(p.locator(".inv-main .inv-empty").count() == 1, "no match says so")
            p.locator(".inv-search input").fill("garage vis")
            check(p.locator(".inv-item .inv-item-path").first.inner_text() == "Garage › Boîte visserie", "results show where the item is")
            p.locator(".inv-search input").fill(box["code"].lower())
            check(p.locator(f'.inv-tile[data-inv-place="{box["id"]}"]').count() == 1, "the label code finds its place")
            p.locator(".inv-search input").fill("")
            print("-- QR labels")
            p.locator(f'.inv-tree [data-inv-place="{box["id"]}"]').click()
            p.locator(".inv-place-acts button", has_text="Étiquette").click()
            p.wait_for_selector(".inv-sheet .inv-label")
            q = p.evaluate("() => { const s = document.querySelector('.inv-sheet .inv-qr'); return s ? [s.getAttribute('viewBox'), s.querySelector('path').getAttribute('d').length] : null; }")
            check(q is not None and int(q[0].split()[2]) >= 25 and q[1] > 500, f"a real QR code is drawn ({q and q[0]})")
            check(p.locator(".inv-sheet .inv-label-code").inner_text() == box["code"], "the label prints the short code")
            check(p.locator(".inv-sheet .inv-label-path").inner_text() == "Garage", "and where the box lives")
            if shots:
                p.wait_for_timeout(450)
                p.screenshot(path=str(shots / "inv-labels.jpg"), type="jpeg", quality=60, scale="css")
            p.keyboard.press("Escape")
            p.wait_for_selector(".inv-sheet", state="detached")
            print("-- delete + undo")
            p.locator(f'.inv-item[data-inv-item="{item["id"]}"] .inv-item-open').click()
            p.locator(".inv-sheet-foot button", has_text="Supprimer").click()
            wait(lambda: not store(srv)["items"], "deleted", p)
            p.locator(".inv-toast .inv-toast-act").click()
            wait(lambda: len(store(srv)["items"]) == 1, "Annuler brings it back", p)
            back = store(srv)["items"][0]
            check((back["id"], back["photos"], back["qty"]) == (item["id"], item["photos"], 13), "exactly as it was")
            p.locator(f'.inv-tree [data-inv-place="{garage["id"]}"]').click()
            p.locator(".inv-place-acts .inv-danger").click()
            check(p.locator(".inv-sheet").inner_text().count("Boîte visserie") == 0 and "1 emplacement" in p.locator(".inv-sheet").inner_text(), "a full place asks before deleting")
            p.keyboard.press("Escape")
            p.wait_for_selector(".inv-sheet", state="detached")
            if shots:
                p.locator(f'.inv-tree [data-inv-place="{box["id"]}"]').click()
                p.wait_for_timeout(500)
                p.screenshot(path=str(shots / "inv-desktop.jpg"), type="jpeg", quality=60, scale="css")
            b.close()

            print("-- scanned label link [phone]")
            b, ctx = ctx_for(pw, srv, True, login=False)
            p = ctx.new_page()
            p.on("pageerror", lambda e: errors.append("pageerror " + str(e)))
            p.goto(srv.base + "/#inventaire/" + box["id"])
            check(p.locator("input[name=pin]").count() == 1, "an unknown phone gets the PIN page")
            p.fill("input[name=pin]", V.ADMIN_PIN)
            p.locator("form button[type=submit]").click()
            p.wait_for_selector("#hq-inv-app .inv-place-head")
            p.wait_for_timeout(500)
            check(p.evaluate("() => document.body.dataset.view") == "inventaire", "after the PIN it opens the Inventaire")
            check(p.locator(".inv-place-head .inv-title").inner_text() == "Boîte visserie", "on the scanned box")
            check(p.locator(".inv-item").count() == 1, "showing what is inside")
            check(p.evaluate("() => getComputedStyle(document.querySelector('.inv-tree')).display") == "none", "no side tree on a phone")
            over = p.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(over <= 0, f"no sideways scroll ({over}px)")
            p.locator(".inv-item .inv-item-open").click()
            p.wait_for_selector(".inv-sheet")
            p.wait_for_timeout(450)
            sb = p.locator(".inv-sheet").bounding_box()
            check(abs(sb["y"] + sb["height"] - 844) < 2, "the editor is a bottom sheet")
            if shots:
                p.screenshot(path=str(shots / "inv-phone-sheet.jpg"), type="jpeg", quality=60, scale="css")
            p.keyboard.press("Escape")
            p.wait_for_selector(".inv-sheet", state="detached")
            p.locator(".inv-crumbs .inv-crumb", has_text="Tout").click()
            p.wait_for_timeout(400)
            cols = p.evaluate("() => getComputedStyle(document.querySelector('.inv-places')).gridTemplateColumns.split(' ').length")
            check(cols == 2, "places are two tiles wide")
            if shots:
                p.screenshot(path=str(shots / "inv-phone.jpg"), type="jpeg", quality=60, scale="css")
            b.close()

            print("-- reload keeps the place; upload role is refused")
            b, ctx = ctx_for(pw, srv, False)
            p = open_inv(ctx, srv, errors, "#inventaire/" + garage["id"])
            check(p.locator(".inv-place-head .inv-title").inner_text() == "Garage", "a deep link opens its place")
            p.goto(srv.base + "/#inventaire/plc-" + "f" * 16)
            p.wait_for_timeout(900)
            check("n'existe plus" in p.locator(".inv-toast").inner_text(), "a label for a deleted place says so")
            b.close()
            b = pw.chromium.launch()
            ctx = b.new_context()
            r = ctx.request.post(srv.base + "/login", form={"pin": V.UPLOAD_PIN}, headers={"Origin": srv.base}, max_redirects=0)
            check(ctx.request.get(srv.base + "/api/inventory").status == 403, "the upload role cannot read the inventory")
            check(ctx.request.post(srv.base + "/api/inventory", data=json.dumps({"action": "place.create", "name": "x"}), headers={"Origin": srv.base, "Content-Type": "application/json"}).status == 403, "nor write it")
            b.close()
            b = pw.chromium.launch()
            ctx = b.new_context()
            ctx.request.post(srv.base + "/login", form={"pin": V.ADMIN_PIN}, headers={"Origin": srv.base}, max_redirects=0)
            check(ctx.request.post(srv.base + "/api/inventory", data=json.dumps({"action": "place.create", "name": "x"}), headers={"Origin": "http://evil.example", "Content-Type": "application/json"}).status == 403, "a cross-site write is refused")
            b.close()
    finally:
        srv.close()
    errs = [e for e in errors if "favicon" not in e and "409 (Conflict)" not in e and "404 (Not Found)" not in e]
    check(not errs, "no page errors " + json.dumps(errs[:5], ensure_ascii=False))
    print("FAILED: %d" % len(FAILS) if FAILS else "visual_inventory: ok")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
