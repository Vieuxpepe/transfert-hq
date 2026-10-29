"""Forge Studio multi-vault V6: per-vault backup ZIP, restore as a new vault, delete a vault, change the
phrase and the recovery key. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault folders (never the real vault).

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_multivault_v6_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import PROD_PORTS, STORAGE_PROBE, Run, start_server
from visual_forge_multivault_playwright import create, listing, open_fold, to_private, unlock_card
from visual_forge_multivault_v5_playwright import import_one

PASS = "synthetic horse battery"
PASS_B = "another synthetic phrase"
PASS_NEW = "a brand new synthetic phrase"

TARGETS = """(ids) => ids.map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return Math.min(r.width, r.height); })"""


def download_backup(run: Run, page) -> Path:
    open_fold(page, "forge-vault-backup-fold")
    with page.expect_download() as info:
        page.locator("#forge-vault-backup-zip").click()
    download = info.value
    run.check(download.suggested_filename == "coffre-chiffre.zip", "the backup downloads as coffre-chiffre.zip")
    target = Path(tempfile.mkdtemp(prefix="forge-v6-")) / "coffre-chiffre.zip"
    download.save_as(str(target))
    run.check(run.until(page, "() => /téléchargée/.test(document.querySelector('#forge-vault-backup-status').textContent)", 10), "the panel confirms the download")
    return target


def section_backup_restore(run: Run) -> None:
    print("V6.1 backup ZIP per vault, restore as a new vault")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Album", PASS)
    unlock_card(run, page, 0, PASS)
    vid = listing(run, page)["vaults"][0]["id"]
    image_id = import_one(run, page, vid)
    run.shot(page, "v6-backup", "#forge-vault-backup-fold")
    zip_path = download_backup(run, page)
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => document.querySelector('.forge-vault-card').dataset.open === 'false'", 10)
    run.check(page.request.get(run.base + "/api/forge/vaults/" + vid + "/backup").status == 401, "locked: the server refuses the backup (401)")

    page.locator("#forge-vaults-restore").click()
    run.check(page.locator("#forge-vault-restore").is_visible() and page.locator("#forge-vault-setup").is_hidden(), "Restaurer un ZIP opens its own form")
    run.check("Aucun coffre existant n'est remplacé" in page.locator("#forge-vault-restore").inner_text(), "the form says nothing is replaced")
    sizes = page.evaluate(TARGETS, ["forge-vaults-new", "forge-vaults-restore", "forge-vault-restore-go", "forge-vault-restore-cancel"])
    run.check(min(sizes) >= 44, f"touch targets >= 44 px {sizes}")
    page.locator("#forge-vault-restore-pass").fill("wrong synthetic phrase")  # the phrase is natively required
    page.locator("#forge-vault-restore-go").click()
    run.check(run.until(page, "() => /Choisis d'abord/.test(document.querySelector('#forge-vault-restore-error').textContent)", 5), "no ZIP chosen: a plain message")
    page.locator("#forge-vault-restore-file").set_input_files(str(zip_path))
    run.check("Mo" in page.locator("#forge-vault-restore-picked").inner_text() and "coffre-chiffre" not in page.locator("#forge-vault-restore-picked").inner_text(), "the picked ZIP shows its size, not its file name")
    page.locator("#forge-vault-restore-label").fill("Album")
    page.locator("#forge-vault-restore-pass").fill("wrong synthetic phrase")
    page.locator("#forge-vault-restore-go").click()
    run.check(run.until(page, "() => /Phrase refusée/.test(document.querySelector('#forge-vault-restore-error').textContent)", 15), "a wrong phrase is refused in plain French")
    run.check(page.locator("#forge-vault-restore-pass").input_value() == "" and len(listing(run, page)["vaults"]) == 1, "the phrase field is cleared and nothing was added")
    run.shot(page, "v6-restore-form", "#forge-vault-restore")
    page.locator("#forge-vault-restore-pass").fill(PASS)
    page.locator("#forge-vault-restore-go").click()
    run.check(run.until(page, "() => document.querySelectorAll('.forge-vault-card').length === 2 || /restauré/.test(document.querySelector('#forge-vaults-note').textContent)", 15), "the restored vault appears")
    run.until(page, "() => /restauré/.test(document.querySelector('#forge-vaults-note').textContent)", 10)
    note = page.locator("#forge-vaults-note").inner_text()
    run.check("Album (2)" in note or "numéro" in note, "a name already taken gets a number: " + note)
    rows = listing(run, page)["vaults"]
    run.check(len(rows) == 2 and rows[1]["id"] != vid and rows[1]["label"] == "Album (2)", "a new id, listed last, never a replacement")
    run.check(page.locator("#forge-vault-restore").is_hidden() and page.locator("#forge-vault-restore-pass").input_value() == "", "the form closes and forgets the phrase")
    run.shot(page, "v6-restored", "#forge-vaults")
    unlock_card(run, page, 1, PASS)
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 1", 10), "the restored vault opens with its old phrase and holds the image")
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => [...document.querySelectorAll('.forge-vault-card')].every((c) => c.dataset.open === 'false')", 10)
    hits = [h for h in page.evaluate(STORAGE_PROBE, image_id) if not h.endswith(":hqForgeDraft")]
    run.check(hits == [], f"nothing about the vault in browser storage {hits}")
    ctx.close()


def section_restore_discret(run: Run) -> None:
    print("V6.1 a Discret backup comes back Discret")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Hirondelle", PASS, discret=True)
    unlock_card(run, page, 0, PASS)
    zip_path = download_backup(run, page)
    page.locator("#forge-vault-lock").click()
    run.until(page, "() => document.querySelector('.forge-vault-card').dataset.open === 'false'", 10)
    page.locator("#forge-vaults-restore").click()
    page.locator("#forge-vault-restore-file").set_input_files(str(zip_path))
    page.locator("#forge-vault-restore-pass").fill(PASS)
    page.locator("#forge-vault-restore-go").click()
    run.check(run.until(page, "() => /Discret est restauré/.test(document.querySelector('#forge-vaults-note').textContent)", 15), "the note names it only as a Discret vault")
    rows = listing(run, page)["vaults"]
    run.check(len(rows) == 2 and rows[1]["discret"] and rows[1]["label"] is None, "restored Discret, no name in the list")
    run.check(not page.evaluate("(n) => document.documentElement.outerHTML.includes(n)", "Hirondelle"), "locked: the sealed name is nowhere in the DOM")
    unlock_card(run, page, 1, PASS)
    run.check(run.until(page, "() => [...document.querySelectorAll('.forge-vault-card-name')].some((n) => n.textContent === 'Hirondelle')", 10), "open: its sealed name comes back")
    ctx.close()


def section_delete(run: Run) -> None:
    print("V6.2 delete a vault: phrase + SUPPRIMER, honest copy")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Brouillons", PASS)
    create(run, page, "Garder", PASS_B)
    unlock_card(run, page, 0, PASS)
    open_fold(page, "forge-vault-destroy-fold")
    text = page.locator("#forge-vault-destroy").inner_text()
    run.check("Irréversible" in text and "sauvegarde" in text, "the form warns it is irreversible and suggests a backup first")
    run.check("SSD" in text and "ne garantit pas" in text, "the form says an overwrite does not guarantee erasure on an SSD")
    run.check(page.locator("#forge-vault-destroy-go").is_disabled(), "the delete button waits for the typed word")
    page.locator("#forge-vault-destroy-word").fill("supprime")
    run.check(page.locator("#forge-vault-destroy-go").is_disabled(), "a near miss keeps it disabled")
    page.locator("#forge-vault-destroy-word").fill("supprimer")
    run.check(page.locator("#forge-vault-destroy-go").is_enabled(), "SUPPRIMER (any case) enables it")
    sizes = page.evaluate(TARGETS, ["forge-vault-destroy-go", "forge-vault-destroy-pass", "forge-vault-destroy-word"])
    run.check(min(sizes) >= 44, f"touch targets >= 44 px {sizes}")
    page.locator("#forge-vault-destroy-pass").fill(PASS_B)
    page.locator("#forge-vault-destroy-go").click()
    run.check(run.until(page, "() => /Phrase refusée/.test(document.querySelector('#forge-vault-destroy-error').textContent)", 10), "another vault's phrase is refused")
    run.check(len(listing(run, page)["vaults"]) == 2 and page.locator("#forge-vault-destroy-pass").input_value() == "", "nothing deleted; the phrase field is cleared")
    run.shot(page, "v6-delete", "#forge-vault-destroy-fold")
    page.locator("#forge-vault-destroy-pass").fill(PASS)
    page.locator("#forge-vault-destroy-go").click()
    run.check(run.until(page, "() => /est supprimé/.test(document.querySelector('#forge-vaults-note').textContent)", 15), "the panel says the vault is deleted")
    rows = listing(run, page)["vaults"]
    run.check([r["label"] for r in rows] == ["Garder"] and listing(run, page)["open"] is None, "only the other vault is left, nothing open")
    run.check(page.locator("#forge-vault-open-tools").is_hidden() and page.locator("#forge-vault-destroy-pass").input_value() == "", "the open tools are gone and the form is cleared")
    run.shot(page, "v6-deleted", "#forge-vaults")
    ctx.close()


def section_phrase(run: Run) -> None:
    print("V6.3 change the phrase and the recovery key of one vault")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Atelier", PASS)
    unlock_card(run, page, 0, PASS)
    open_fold(page, "forge-vault-security-fold")
    run.shot(page, "v6-security", "#forge-vault-security-fold")
    page.locator("#forge-vault-current").fill(PASS)
    page.locator("#forge-vault-next").fill(PASS_NEW)
    page.locator("#forge-vault-next-confirm").fill(PASS_NEW)
    page.locator("#forge-vault-rotate button[type=submit]").click()
    run.check(run.until(page, "() => /Phrase changée/.test(document.querySelector('#forge-vaults-note').textContent)", 15), "the panel confirms the new phrase and says the vault locked")
    run.check(listing(run, page)["open"] is None, "the vault is locked after the change")
    unlock_card(run, page, 0, PASS_NEW)
    run.check(listing(run, page)["open"] is not None, "it opens with the new phrase")
    open_fold(page, "forge-vault-security-fold")
    page.locator("#forge-vault-rekey-pass").fill(PASS_NEW)
    page.locator("#forge-vault-rekey button[type=submit]").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-vault-recovery').hidden && document.querySelector('#forge-vault-recovery-key').value.length > 20", 15), "a new recovery key is shown once")
    run.check("ne fonctionne plus" in page.locator("#forge-vault-recovery-extra").inner_text(), "it says the old key stopped working")
    page.locator("#forge-vault-recovery-ok").click()
    run.check(run.until(page, "() => document.querySelector('#forge-vault-recovery-key').value === ''", 5), "the key leaves the page once acknowledged")
    ctx.close()


SECTIONS = {"backup": section_backup_restore, "discret": section_restore_discret, "delete": section_delete, "phrase": section_phrase}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
            proc, info = start_server()
            assert not info["base"].endswith(PROD_PORTS)
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


if __name__ == "__main__":
    main()
