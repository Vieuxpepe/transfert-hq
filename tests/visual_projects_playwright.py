"""Projets browser checks — Chromium, desktop + phone viewports.

Not part of unittest discovery. Throwaway loopback HQ (temp ROOT, fake PINs, see visual_carnet_playwright.Server);
never touches the live root. Skips (exit 0) when Playwright or Chromium is unavailable.

    python tests/visual_projects_playwright.py [--shots <dir>]
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
    rows = b"".join(b"\x00" + b"".join(bytes([(x * 4) % 256, (y * 5) % 256, 90]) for x in range(w)) for y in range(h))

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def login(pw, srv, phone=False, pin=None):
    b = pw.chromium.launch()
    opts = {"viewport": {"width": 390, "height": 844}, "has_touch": True, "is_mobile": True, "device_scale_factor": 2} if phone else {"viewport": {"width": 1280, "height": 900}}
    ctx = b.new_context(**opts)
    r = ctx.request.post(srv.base + "/login", form={"pin": pin or V.ADMIN_PIN}, headers={"Origin": srv.base}, max_redirects=0)
    assert r.status == 303, r.status
    return b, ctx


def store(srv):
    p = srv.root / ".hq-projects" / "projects.json"
    return json.loads(p.read_text("utf-8")) if p.exists() else {"projects": []}


def board(srv):
    return json.loads((srv.root / "kanban.json").read_text("utf-8"))


def cards(srv):
    return [dict(c, column=col["id"]) for col in board(srv)["columns"] for c in col.get("cards") or []]


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    srv = V.Server()
    errors = []
    img = srv.root / "photo.png"
    img.write_bytes(png())
    # a card made earlier (by the old board or the Carnet) must show up, untouched, under « Tâches libres »
    (srv.root / "kanban.json").write_text(json.dumps({"columns": [{"id": "todo", "title": "À faire", "cards": [{"id": "c-1790395795045", "title": "Carte du Carnet", "created": 1790395795.0}]},
                                                                  {"id": "doing", "title": "En cours", "cards": []}, {"id": "done", "title": "Fait", "cards": []}]}), "utf-8")
    try:
        with sync_playwright() as pw:
            b, ctx = login(pw, srv)
            H = {"Origin": srv.base, "Content-Type": "application/json"}
            servo = ctx.request.post(srv.base + "/api/inventory", data=json.dumps({"action": "item.create", "name": "Servo MG996R", "qty": 6, "unit": "pcs"}), headers=H).json()["item"]
            p = ctx.new_page()
            p.on("pageerror", lambda e: errors.append("pageerror " + str(e)))
            p.on("console", lambda m: errors.append("console " + m.text) if m.type == "error" else None)
            p.goto(srv.base + "/")
            p.locator('.bottom-nav [data-nav="projets"]').click()
            p.wait_for_selector("#hq-prj-app .prj-cards")
            print("-- list [desktop]")
            check(p.evaluate("() => document.body.dataset.view") == "projets", "Projets opens from the nav")
            check(p.locator('.prj-card[data-prj="libres"]').count() == 1, "« Tâches libres » is there")
            p.locator('.prj-card[data-prj="libres"]').click()
            check(p.locator(".prj-task", has_text="Carte du Carnet").count() == 1, "an old card shows up under Tâches libres")
            p.locator(".prj-back").click()
            print("-- create a project")
            p.locator(".prj-list-head .prj-btn").click()
            p.wait_for_selector(".prj-sheet")
            p.locator(".prj-sheet input[type=text]").first.fill("Bras robot")
            p.locator(".prj-sheet textarea").first.fill("Un bras de table")
            p.locator(".prj-sheet input[type=date]").nth(1).fill("2030-12-15")
            p.locator(".prj-sheet .prj-hue").nth(7).click()
            p.locator(".prj-sheet .prj-save").click()
            p.wait_for_selector(".prj-sheet-title")
            pr = store(srv)["projects"][0]
            check((pr["name"], pr["goal"], pr["due"], pr["hue"]) == ("Bras robot", "Un bras de table", "2030-12-15", 222), f"saved ({pr['name']}, {pr['hue']})")
            check(p.evaluate("() => location.hash") == "#projets/" + pr["id"], "the address names the project")
            check(p.locator(".prj-tb-name").inner_text() == "Bras robot", "the title block shows the name")
            check(p.evaluate("() => document.querySelector('.prj-main').classList.contains('is-enter')"), "a newly opened project plays its entrance")
            check(p.locator(".prj-tab-ink").count() == 1, "the tabs have a gliding marker")
            check("15 déc. 2030" in p.locator(".prj-tb-grid").inner_text(), "and the due date in the title block")
            print("-- Où j'en suis")
            p.locator(".prj-resume-text").fill("Je câblais l'épaule. Prochaine étape : le ressort.")
            wait(lambda: store(srv)["projects"][0]["resume"] == "Je câblais l'épaule. Prochaine étape : le ressort.", "the note saves while typing", p)
            check(p.locator(".prj-resume-state.is-saved").count() == 1, "it says it is saved")
            check(p.evaluate("() => document.activeElement && document.activeElement.classList.contains('prj-resume-text')"), "saving never steals the cursor")
            p.locator(".prj-back").click()
            check("Prochaine étape" in p.locator(f'.prj-card[data-prj="{pr["id"]}"] .prj-card-resume').inner_text(), "the project card shows where you left off")
            p.locator(f'.prj-card[data-prj="{pr["id"]}"]').click()
            p.wait_for_selector(".prj-sheet-title")
            check(p.locator(".prj-resume-text").input_value().startswith("Je câblais"), "and the project page keeps it")
            print("-- tasks")
            for t in ("Couper les profilés", "Câbler les servos"):
                p.locator(".prj-quick input").fill(t)
                p.keyboard.press("Enter")
                wait(lambda: p.locator(".prj-task", has_text=t).count() == 1, "task " + t, p)
            mine = [c for c in cards(srv) if c.get("project") == pr["id"]]
            check(len(mine) == 2 and all(c["column"] == "todo" for c in mine), "quick add puts cards on the shared board, in « À faire »")
            check(any(c["title"] == "Carte du Carnet" and "project" not in c for c in cards(srv)), "the free card is untouched")
            p.locator(".prj-task", has_text="Câbler").locator(".prj-mini").last.click()
            wait(lambda: next(c for c in cards(srv) if c["title"] == "Câbler les servos")["column"] == "doing", "move right", p)
            check(p.locator('.prj-col.is-doing .prj-task', has_text="Câbler").count() == 1, "the arrow moves it to « En cours »")
            src = p.locator(".prj-task", has_text="Couper")
            dst = p.locator(".prj-col.is-done")
            src.drag_to(dst)
            sparks = p.locator(".prj-spark").count()
            check(sparks > 0, f"finishing a task throws sparks ({sparks})")
            check(wait(lambda: next(c for c in cards(srv) if c["title"] == "Couper les profilés")["column"] == "done", "drag", p), "drag and drop moves a card to « Fait »")
            check(p.locator(".prj-tb-grid").inner_text().count("50 %") == 1, "progress follows (1 of 2)")
            print("-- milestones")
            p.locator('.prj-tab[id="prj-tab-milestones"]').click()
            p.locator(".prj-ms .prj-quick input[type=text]").fill("Châssis")
            p.locator(".prj-ms .prj-quick input[type=date]").fill("2030-11-01")
            p.keyboard.press("Enter")
            wait(lambda: len(store(srv)["projects"][0]["milestones"]) == 1, "milestone saved", p)
            check(p.evaluate("() => location.hash").endswith("/milestones"), "the tab is in the address")
            p.locator(".prj-ms-check").first.click()
            check(wait(lambda: p.locator(".prj-ms-item.is-just-done").count() == 1, "pop", p, 2), "ticking a milestone plays its check")
            wait(lambda: store(srv)["projects"][0]["milestones"][0]["done"], "milestone done", p)
            check(p.locator(".prj-ms-item.is-done").count() == 1, "ticking a milestone marks it done")
            ms = store(srv)["projects"][0]["milestones"][0]
            p.locator('.prj-tab[id="prj-tab-tasks"]').click()
            p.locator(".prj-task", has_text="Câbler").locator(".prj-task-open").click()
            p.wait_for_selector(".prj-sheet")
            p.locator(".prj-sheet select").nth(1).select_option(ms["id"])
            p.locator(".prj-sheet .prj-save").click()
            wait(lambda: next(c for c in cards(srv) if c["title"] == "Câbler les servos").get("milestone") == ms["id"], "task linked to milestone", p)
            check(p.locator(".prj-task", has_text="Câbler").locator(".prj-chiplet.is-ms").count() == 1, "the card shows its milestone")
            print("-- parts list + inventory")
            p.locator('.prj-tab[id="prj-tab-bom"]').click()
            p.locator(".prj-bom-sum .prj-btn").click()
            p.wait_for_selector(".prj-sheet")
            p.locator(".prj-sheet select").first.select_option(servo["id"])
            check(p.locator(".prj-sheet input[type=text]").first.input_value() == "Servo MG996R", "picking an inventory item fills the name")
            p.locator(".prj-sheet input[type=number]").fill("4")
            p.locator(".prj-sheet input[inputmode=decimal]").fill("8,99")
            p.locator(".prj-sheet .prj-save").click()
            p.wait_for_selector(".prj-bom-row")
            check("35,96 $" in p.locator(".prj-bom-row").inner_text() and "en stock : 6" in p.locator(".prj-bom-row").inner_text(), "the line shows its total and the stock")
            check("35,96 $" in p.locator(".prj-tb-grid").inner_text(), "the title block shows the parts cost")
            p.locator(".prj-bom-row .is-take").click()
            wait(lambda: json.loads((srv.root / ".hq-inventory" / "inventory.json").read_text("utf-8"))["items"][0]["qty"] == 2, "stock taken", p)
            check("sorti de l'inventaire" in p.locator(".prj-bom-row").inner_text(), "« Sortir du stock » takes 4 from the Inventaire, once")
            check(p.locator(".prj-bom-row .is-take").count() == 0, "and cannot be done twice")
            p.locator(".prj-bom-state").click()
            wait(lambda: store(srv)["projects"][0]["bom"][0]["status"] == "need", "state cycles", p)
            print("-- links + journal")
            p.locator('.prj-tab[id="prj-tab-links"]').click()
            p.locator(".prj-links-head .prj-btn").click()
            p.wait_for_selector(".prj-sheet")
            p.locator(".prj-sheet select").select_option("file")
            p.locator(".prj-sheet input[type=text]").first.fill("Uni/GIA1077/plan.pdf")
            p.locator(".prj-sheet .prj-save").click()
            wait(lambda: len(store(srv)["projects"][0]["links"]) == 1, "link saved", p)
            check(p.locator(".prj-link-title").inner_text() == "plan.pdf", "a file link shows its name")
            p.locator('.prj-tab[id="prj-tab-log"]').click()
            p.locator(".prj-compose textarea").fill("Premier montage")
            with p.expect_file_chooser() as fc:
                p.locator(".prj-compose .prj-photo-btns .prj-btn", has_text="Choisir").click()
            fc.value.set_files(str(img))
            wait(lambda: p.locator(".prj-compose .prj-photo img").count() == 1, "photo uploaded", p)
            p.locator(".prj-compose .prj-save").click()
            wait(lambda: len(store(srv)["projects"][0]["timeline"]) == 1, "entry saved", p)
            check(p.locator(".prj-log-entry img").count() == 1 and "Premier montage" in p.locator(".prj-log-entry").inner_text(), "the journal shows the photo and the words")
            if shots:
                p.wait_for_timeout(500)
                p.screenshot(path=str(shots / "prj-desktop.jpg"), type="jpeg", quality=60, scale="css")
            print("-- delete + undo")
            p.locator(".prj-tb-acts .is-danger").click()
            p.locator(".prj-sheet .prj-save").click()
            wait(lambda: not store(srv)["projects"], "deleted", p)
            check(any(c.get("project") == pr["id"] for c in cards(srv)), "its cards stay on the board")
            p.locator(".prj-toast .prj-toast-act").click()
            wait(lambda: len(store(srv)["projects"]) == 1, "restored", p)
            check(p.locator(".prj-tb-name").inner_text() == "Bras robot" and len(store(srv)["projects"][0]["milestones"]) == 1, "Annuler brings the whole project back")
            print("-- System › Tâches points here")
            p.evaluate("() => { applyMode(false); setView('plus'); }")  # the block is advanced (Mode complet)
            p.locator("#system-tasks summary").click()
            p.locator("#system-tasks button", has_text="Ouvrir Projets").click()
            check(p.evaluate("() => document.body.dataset.view") == "projets", "the old Tâches block opens Projets")
            b.close()

            print("-- phone")
            b, ctx = login(pw, srv, phone=True)
            p = ctx.new_page()
            p.on("pageerror", lambda e: errors.append("pageerror " + str(e)))
            p.goto(srv.base + "/#projets/" + pr["id"])
            p.wait_for_selector(".prj-sheet-title")
            p.wait_for_timeout(500)
            check(p.evaluate("() => document.body.dataset.view") == "projets", "a project link opens Projets on the phone")
            vis = p.evaluate("() => [...document.querySelectorAll('.prj-col')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.col)")
            check(vis == ["todo"], f"one column at a time ({vis})")
            p.locator(".prj-seg-btn", has_text="Fait").click()
            check(p.evaluate("() => [...document.querySelectorAll('.prj-col')].filter(c => getComputedStyle(c).display !== 'none').map(c => c.dataset.col)") == ["done"], "the switch shows « Fait »")
            over = p.evaluate("() => document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check(over <= 0, f"no sideways scroll ({over}px)")
            p.locator(".prj-col.is-done .prj-task-open").first.click()
            p.wait_for_selector(".prj-sheet")
            p.wait_for_timeout(450)
            sb = p.locator(".prj-sheet").bounding_box()
            check(abs(sb["y"] + sb["height"] - 844) < 2, "editors are bottom sheets")
            if shots:
                p.screenshot(path=str(shots / "prj-phone.jpg"), type="jpeg", quality=60, scale="css")
            p.keyboard.press("Escape")
            b.close()

            print("-- access")
            b = pw.chromium.launch()
            c2 = b.new_context()
            c2.request.post(srv.base + "/login", form={"pin": V.UPLOAD_PIN}, headers={"Origin": srv.base}, max_redirects=0)
            check(c2.request.get(srv.base + "/api/projects").status == 403, "the upload role cannot read projects")
            check(c2.request.post(srv.base + "/api/projects", data=json.dumps({"action": "task.create", "title": "x"}), headers=H).status == 403, "nor write them")
            b.close()
            b = pw.chromium.launch()
            c3 = b.new_context()
            c3.request.post(srv.base + "/login", form={"pin": V.ADMIN_PIN}, headers={"Origin": srv.base}, max_redirects=0)
            check(c3.request.post(srv.base + "/api/projects", data=json.dumps({"action": "task.create", "title": "x"}), headers={"Origin": "http://evil.example", "Content-Type": "application/json"}).status == 403, "a cross-site write is refused")
            b.close()
    finally:
        srv.close()
    errs = [e for e in errors if "favicon" not in e and "404 (Not Found)" not in e]
    check(not errs, "no page errors " + json.dumps(errs[:5], ensure_ascii=False))
    print("FAILED: %d" % len(FAILS) if FAILS else "visual_projects: ok")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
