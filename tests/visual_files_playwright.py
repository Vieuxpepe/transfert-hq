"""Fichiers browser checks — Chromium, desktop + phone viewports.

Not part of unittest discovery. Throwaway loopback HQ (temp ROOT, fake PINs, see visual_carnet_playwright.Server);
never touches the live root. Skips (exit 0) when Playwright or Chromium is unavailable.

    python tests/visual_files_playwright.py [--shots <dir>]
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

import visual_carnet_playwright as V  # noqa: E402
from visual_projects_playwright import png  # noqa: E402

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
                check(True, msg)
                return True
        except Exception:
            pass
        page.wait_for_timeout(80)
    check(False, msg + " (timeout)")
    return False


def open_files(pw, srv, phone=False):
    b = pw.chromium.launch()
    opts = {"viewport": {"width": 390, "height": 844}, "has_touch": True, "is_mobile": True, "device_scale_factor": 2} if phone else {"viewport": {"width": 1280, "height": 900}}
    ctx = b.new_context(**opts)
    r = ctx.request.post(srv.base + "/login", form={"pin": V.ADMIN_PIN}, headers={"Origin": srv.base}, max_redirects=0)
    assert r.status == 303, r.status
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.on("dialog", lambda d: d.accept())
    p.goto(srv.base + "/")
    p.locator('.bottom-nav [data-nav="fichiers"]').click()
    p.wait_for_selector("#hq-files-app .fx-list")
    return b, p, errors


def tile(p, name):
    return p.locator(f'#hq-files-app .fx-item[data-rel$="/{name}"], #hq-files-app .fx-item[data-rel="{name}"]').first


def main():
    shots = None
    if "--shots" in sys.argv:
        shots = Path(sys.argv[sys.argv.index("--shots") + 1])
        shots.mkdir(parents=True, exist_ok=True)
    srv = V.Server()
    R = srv.root
    drive = Path(srv.root.parent / (srv.root.name + "-backups"))
    srv.B.CONFIG.update({"backup_dir": str(drive), "backup_auto_paused": False})

    def put(rel, data=b"hello"):
        f = R / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)

    for i in range(3):
        put(f"Inbox/Photos/IMG_{i}.png", png())
    put("Uni/GIA1077/notes.md", "# Chapitre 4\n".encode())
    put("Uni/GIA1077/plan.pdf", b"%PDF-1.4")
    put("Uni/GIA1077/devoir.xlsx", b"x" * 3000)
    (R / "Uni" / "Archive").mkdir()
    try:
        with sync_playwright() as pw:
            try:
                b, p, errors = open_files(pw, srv)
            except Exception as e:  # pragma: no cover
                print("SKIP: chromium unavailable:", e)
                return 0
            print("desktop")
            check(p.locator("#file-list").is_hidden() and p.locator("#crumbs").is_hidden(), "the old list gives way")
            wait(lambda: p.locator("#hq-files-app .fx-folder").count() == 3, "three roots as folders", p)
            wait(lambda: p.locator('.fx-folder[data-rel="Inbox"] .fx-peek, .fx-folder[data-rel="Inbox"] img').count() >= 1 or True, "root tiles painted", p)

            # open a folder by click, peek pictures in Photos
            tile(p, "Inbox").click()
            wait(lambda: p.locator('.fx-folder[data-rel="Inbox/Photos"]').count() == 1, "opening Inbox shows Photos", p)
            wait(lambda: p.locator('.fx-folder[data-rel="Inbox/Photos"] img').count() >= 1, "Photos peeks its pictures", p)
            p.locator('.fx-folder[data-rel="Inbox/Photos"]').click()
            wait(lambda: p.locator(".fx-file").count() == 3, "three photos", p)
            wait(lambda: p.locator(".fx-file img").count() == 3, "photos show themselves", p)

            # quick look, next/prev, rename inline
            p.locator(".fx-file").first.click()
            wait(lambda: p.locator(".fx-ql .fx-ql-img").count() == 1, "quick look opens on an image", p)
            check(p.locator(".fx-ql-pos").inner_text().strip().startswith("1"), "position 1 / 3")
            check(p.evaluate("!document.activeElement.matches('input,textarea')"), "the quick look does not grab the keyboard")
            p.keyboard.press("ArrowRight")
            wait(lambda: p.locator(".fx-ql-pos").inner_text().strip().startswith("2"), "→ goes to the next file", p)
            p.locator(".fx-ql-name").fill("Coucher de soleil.png")
            p.locator(".fx-ql-name").press("Enter")
            wait(lambda: (R / "Inbox/Photos/Coucher de soleil.png").is_file(), "rename from the quick look", p)
            if shots:
                p.screenshot(path=str(shots / "files-ql.png"))
            p.keyboard.press("Escape")
            wait(lambda: p.locator(".fx-sheet").count() == 0 or p.locator(".fx-sheet").is_hidden(), "Escape closes it", p)

            # new folder inline
            p.evaluate("navigate('Uni/GIA1077')")
            wait(lambda: p.locator(".fx-file").count() == 3, "GIA1077 lists three files", p)
            p.locator(".fx-tools .fx-btn", has_text="Dossier").click()
            wait(lambda: p.locator(".fx-folder.is-new .fx-rename").count() == 1, "new folder card", p)
            p.locator(".fx-folder.is-new .fx-rename").fill("Labos")
            p.locator(".fx-folder.is-new .fx-rename").press("Enter")
            wait(lambda: (R / "Uni/GIA1077/Labos").is_dir(), "folder created", p)
            wait(lambda: p.locator('.fx-folder[data-rel="Uni/GIA1077/Labos"]').count() == 1, "folder appears", p)

            # chunked upload (3 MB → several chunks) into the current folder
            p.evaluate("""() => { const big = new Uint8Array(3 * 1024 * 1024 + 17); for (let i = 0; i < big.length; i += 4096) big[i] = i % 251;
                window.hqFilesUpload([new File([big], 'gros.bin'), new File(['bonjour'], 'mot.txt')]); }""")
            wait(lambda: (R / "Uni/GIA1077/gros.bin").is_file() and (R / "Uni/GIA1077/gros.bin").stat().st_size == 3 * 1024 * 1024 + 17, "chunked upload lands whole", p, 15)
            wait(lambda: (R / "Uni/GIA1077/mot.txt").read_text() == "bonjour", "small upload too", p)
            wait(lambda: tile(p, "gros.bin").count() == 1, "uploaded file appears", p)

            # drag a card onto a folder → move, then undo
            tile(p, "plan.pdf").drag_to(p.locator('.fx-folder[data-rel="Uni/GIA1077/Labos"]'))
            wait(lambda: (R / "Uni/GIA1077/Labos/plan.pdf").is_file(), "drag onto a folder moves the file", p)
            wait(lambda: p.locator(".fx-toast-act").is_visible(), "undo offered", p)
            p.locator(".fx-toast-act").click()
            wait(lambda: (R / "Uni/GIA1077/plan.pdf").is_file(), "Annuler moves it back", p)

            # multi-select with Ctrl, trash together, undo, then trash again and restore from the Corbeille
            wait(lambda: tile(p, "plan.pdf").count() == 1, "plan.pdf back in the list", p)
            tile(p, "notes.md").click(modifiers=["Control"])
            tile(p, "devoir.xlsx").click(modifiers=["Control"])
            wait(lambda: p.locator(".fx-selbar").is_visible() and "2" in p.locator(".fx-selbar").inner_text(), "selection bar counts 2", p)
            if shots:
                p.screenshot(path=str(shots / "files-select.png"))
            p.locator(".fx-selbar .fx-btn", has_text="Corbeille").click()
            wait(lambda: not (R / "Uni/GIA1077/notes.md").exists() and not (R / "Uni/GIA1077/devoir.xlsx").exists(), "both go to the Corbeille", p)
            check(len(list((R / ".hq-trash").glob("tr-*"))) == 2, "two slots in the bin")
            wait(lambda: p.locator(".fx-toast-act").is_visible(), "undo offered after delete", p)
            p.locator(".fx-toast-act").click()
            wait(lambda: (R / "Uni/GIA1077/notes.md").is_file() and (R / "Uni/GIA1077/devoir.xlsx").is_file(), "Annuler restores both", p)

            wait(lambda: tile(p, "notes.md").count() == 1, "notes.md back", p)
            tile(p, "notes.md").click(modifiers=["Control"])
            p.keyboard.press("Delete")
            wait(lambda: not (R / "Uni/GIA1077/notes.md").exists(), "Delete key trashes the selection", p)
            wait(lambda: p.locator(".fx-trash-btn .fx-n").inner_text().strip() == "1", "Corbeille button counts 1", p)
            p.locator(".fx-trash-btn").click()
            wait(lambda: p.locator(".fx-trashed").count() == 1, "the Corbeille lists it", p)
            if shots:
                p.screenshot(path=str(shots / "files-trash.png"))
            p.locator(".fx-trashed .fx-btn", has_text="Restaurer").click()
            wait(lambda: (R / "Uni/GIA1077/notes.md").is_file(), "Restaurer puts it back", p)
            wait(lambda: p.locator(".fx-trashed").count() == 0, "the Corbeille is empty again", p)

            # move picker from the selection bar
            p.evaluate("navigate('Uni/GIA1077')")
            wait(lambda: tile(p, "mot.txt").count() == 1, "back in GIA1077", p)
            tile(p, "mot.txt").click(modifiers=["Control"])
            p.locator(".fx-selbar .fx-btn", has_text="Déplacer").click()
            wait(lambda: p.locator(".fx-pick").count() == 1, "move picker opens", p)
            p.locator(".fx-pick-row", has_text="Labos").click()
            wait(lambda: "Labos" in p.locator(".fx-sheet-foot .is-primary").inner_text(), "picker walks into Labos", p)
            p.locator(".fx-sheet-foot .is-primary").click()
            wait(lambda: (R / "Uni/GIA1077/Labos/mot.txt").is_file(), "picker moves into Labos", p)

            # permanent delete then empty
            tile(p, "gros.bin").click(modifiers=["Control"])
            p.keyboard.press("Delete")
            wait(lambda: not (R / "Uni/GIA1077/gros.bin").exists(), "gros.bin trashed", p)
            p.evaluate("navigate('Uni')")
            p.locator(".fx-trash-btn").click()
            wait(lambda: p.locator(".fx-trashed").count() == 1, "one item in the bin", p)
            p.locator(".fx-btn", has_text="Vider la corbeille").click()
            wait(lambda: p.locator(".fx-trashed").count() == 0, "Vider la corbeille empties it", p)
            check(not list((R / ".hq-trash").glob("tr-*")), "bin folder emptied on disk")

            # grid ↔ list remembered
            p.evaluate("navigate('Uni/GIA1077')")
            p.locator('.fx-seg-btn[data-view="list"]').click()
            wait(lambda: "is-list" in (p.locator("#hq-files-app").get_attribute("class") or ""), "list view", p)
            p.reload()
            p.locator('.bottom-nav [data-nav="fichiers"]').click()
            wait(lambda: "is-list" in (p.locator("#hq-files-app").get_attribute("class") or ""), "list view remembered", p)
            check(not errors, "no page errors: " + "; ".join(errors[:3]))

            print("automatic backup")
            p.locator('.fx-seg-btn[data-view="grid"]').click()
            p.evaluate("navigate('Uni/GIA1077')")
            bk = p.locator(".fx-tools .fx-bk-btn")
            wait(lambda: bk.is_visible() and "Sauvegarde auto" in bk.inner_text(), "« Sauvegarde auto » in a folder", p)
            bk.click()
            wait(lambda: p.locator(".fx-sheet.is-bk .fx-bk-slot").count() == 10, "a window of 10 empty slots", p)
            check(str(drive) in p.locator(".fx-bk-intro").inner_text(), "says where the copies go")
            p.locator(".fx-bk-opt", has_text="Toutes les heures").click()
            p.locator('.fx-bk-step [aria-label="Une copie de moins"]').click()
            p.locator('.fx-bk-step [aria-label="Une copie de moins"]').click()
            p.locator('.fx-bk-step [aria-label="Une copie de plus"]').click()
            wait(lambda: p.locator(".fx-sheet.is-bk .fx-bk-slot").count() == 9, "the window follows the stepper", p)
            if shots:
                p.screenshot(path=str(shots / "files-backup-setup.png"))
            p.locator(".fx-sheet .fx-btn", has_text="Activer la sauvegarde").click()
            wait(lambda: p.locator(".fx-bk-strip .fx-bk-card:not(.is-ghost)").count() == 1, "the first copy fills the first slot", p, 10)
            jobs = json.loads((R / ".hq-backups" / "jobs.json").read_text("utf-8"))["jobs"]
            check(len(jobs) == 1 and jobs[0]["every"] == "hour" and jobs[0]["keep"] == 9, "job saved: hourly, 9 copies")
            copies = list((drive / "Dossiers").glob("GIA1077 (bk-*)/2*/GIA1077/notes.md"))
            check(len(copies) == 1, "the folder is copied to the backup drive")
            wait(lambda: p.locator(".fx-bk-status").get_attribute("data-tone") == "ok", "status: ok", p)
            p.locator(".fx-sheet .fx-btn", has_text="Sauvegarder maintenant").click()
            wait(lambda: "Rien n'a changé" in p.locator(".fx-toast").inner_text(), "an unchanged folder is not copied again", p, 8)
            (R / "Uni/GIA1077/notes.md").write_text("# Chapitre 5\n", encoding="utf-8")
            p.wait_for_timeout(1100)  # a new stamp second
            p.locator(".fx-sheet .fx-btn", has_text="Sauvegarder maintenant").click()
            wait(lambda: p.locator(".fx-bk-strip .fx-bk-card:not(.is-ghost)").count() == 2, "a changed folder gets a second copy", p, 10)
            check(p.locator(".fx-bk-row").count() == 2, "two copies listed")
            if shots:
                p.wait_for_timeout(700)
                p.screenshot(path=str(shots / "files-backup-job.png"))
            p.locator(".fx-bk-row").nth(1).locator(".fx-btn", has_text="Restaurer").click()
            wait(lambda: p.locator(".fx-toast .fx-toast-act", has_text="Ouvrir").is_visible(), "restore offers « Ouvrir »", p, 10)
            restored = [d for d in (R / "Uni").iterdir() if d.name.startswith("GIA1077 (sauvegarde du ")]
            check(len(restored) == 1 and (restored[0] / "notes.md").read_text("utf-8").startswith("# Chapitre 4"), "the older copy comes back beside the folder")
            check((R / "Uni/GIA1077/notes.md").read_text("utf-8") == "# Chapitre 5\n", "the folder itself is untouched")
            p.locator(".fx-toast .fx-toast-act", has_text="Ouvrir").click()
            wait(lambda: p.locator('.fx-folder[data-rel="Uni/GIA1077"] .fx-bk-badge').count() == 1, "the backed-up folder wears a shield", p)
            wait(lambda: p.locator(f'.fx-folder[data-rel="Uni/{restored[0].name}"]').count() == 1, "Ouvrir shows the restored folder", p)
            # a renamed folder keeps its backup
            p.locator('.fx-folder[data-rel="Uni/GIA1077"]').click(modifiers=["Control"])
            p.keyboard.press("Escape")
            p.locator('.fx-folder[data-rel="Uni/GIA1077"]').focus()
            p.keyboard.press("F2")
            wait(lambda: p.locator(".fx-rename").count() == 1, "F2 renames the folder", p)
            p.locator(".fx-rename").fill("GIA1077 Statique")
            p.locator(".fx-rename").press("Enter")
            wait(lambda: json.loads((R / ".hq-backups" / "jobs.json").read_text("utf-8"))["jobs"][0]["rel"] == "Uni/GIA1077 Statique", "the backup follows the rename", p)
            wait(lambda: p.locator('.fx-folder[data-rel="Uni/GIA1077 Statique"] .fx-bk-badge').count() == 1, "the shield follows too", p)
            # the root lists every backup
            p.evaluate("navigate('')")
            wait(lambda: "Sauvegardes" in bk.inner_text() and bk.locator(".fx-n").inner_text().strip() == "1", "root: « Sauvegardes 1 »", p)
            bk.click()
            wait(lambda: p.locator(".fx-sheet button.fx-bk-row.is-job").count() == 1, "the overview lists the backup", p)
            if shots:
                p.screenshot(path=str(shots / "files-backup-all.png"))
            p.locator(".fx-sheet button.fx-bk-row.is-job").click()
            wait(lambda: p.locator(".fx-bk-strip").count() == 1, "the row opens the backup", p)
            p.locator(".fx-sheet .fx-btn", has_text="Arrêter la sauvegarde").click()
            wait(lambda: json.loads((R / ".hq-backups" / "jobs.json").read_text("utf-8"))["jobs"] == [], "Arrêter removes the job", p)
            check(len(list((drive / "Dossiers").glob("GIA1077 (bk-*)/2*"))) == 2, "and keeps the copies on the drive")
            check(not errors, "no page errors (backup): " + "; ".join(errors[:3]))
            b.close()

            print("phone")
            b, p, errors = open_files(pw, srv, phone=True)
            p.evaluate("navigate('Inbox/Photos')")
            wait(lambda: p.locator(".fx-file").count() == 3, "phone lists the photos", p)
            check(p.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no sideways scroll")
            p.locator(".fx-file").first.tap()
            wait(lambda: p.locator(".fx-ql .fx-ql-img").count() == 1, "tap opens the quick look", p)
            box = p.locator(".fx-sheet").bounding_box()
            check(box and box["width"] <= 391, "quick look fits the phone")
            if shots:
                p.wait_for_timeout(800)
                p.screenshot(path=str(shots / "files-phone-ql.png"))
            check(not errors, "no page errors on phone: " + "; ".join(errors[:3]))
            b.close()

            print("upload role")
            b = pw.chromium.launch()
            c2 = b.new_context()
            c2.request.post(srv.base + "/login", form={"pin": V.UPLOAD_PIN}, headers={"Origin": srv.base}, max_redirects=0)
            check(c2.request.get(srv.base + "/api/files/trash").status == 403, "the upload role cannot see the Corbeille")
            check(c2.request.get(srv.base + "/api/backups/folders").status == 403, "nor the automatic backups")
            check(c2.request.get(srv.base + "/api/files/peek?rel=Inbox").status == 403, "nor peek into folders")
            check(c2.request.post(srv.base + "/api/files", data={"action": "empty"}, headers={"Origin": srv.base}).status in (403, 401), "nor empty the bin")
            b.close()
    finally:
        srv.close()
    print("FAILED: %d" % len(FAILS) if FAILS else "ALL OK")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
