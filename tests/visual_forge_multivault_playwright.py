"""Forge Studio multi-vault V4: 'Mes coffres', creation, unlock, switching, destination of a private
generation, lock on background, and the migration screen. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault folders (never the real vault).

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_multivault_playwright.py [section ...]
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import PROD_PORTS, STORAGE_PROBE, VISIBILITY_STUB, Run, _png_bytes, start_server

PASS = "synthetic horse battery"
PASS_B = "another synthetic phrase"
SECRET_NAME = "Album cache"

GEO = """() => { const cards = [...document.querySelectorAll('.forge-vault-card')].map((c) => c.getBoundingClientRect());
  const tall = (id) => { const n = document.getElementById(id); return n && !n.closest('[hidden]') ? n.getBoundingClientRect().height : 99; };
  return { sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth,
    minCard: Math.min(...cards.map((r) => r.height)), sameRow: cards.length > 1 && Math.abs(cards[0].top - cards[1].top) < 1 && cards[1].left > cards[0].right,
    targets: Math.min(...['forge-vaults-new', 'forge-vault-open', 'forge-vault-unlock-cancel', 'forge-private-target', 'forge-vault-lock'].map(tall)) }; }"""
DOM_HAS = "(needle) => document.documentElement.outerHTML.includes(needle)"


def to_private(run: Run, page) -> None:
    run.dest(page, "private")
    page.locator("#forge-vault").wait_for()
    run.until(page, "() => !document.querySelector('#forge-vaults').hidden || !document.querySelector('#forge-migrate').hidden", 10)


def create(run: Run, page, label: str, passphrase: str, glyph: str = "coffre", colour: str = "ardoise", discret: bool = False) -> str:
    page.locator("#forge-vaults-new").click()
    page.locator("#forge-vault-label").fill(label)
    page.locator("#forge-vault-glyph").select_option(glyph)
    page.locator("#forge-vault-colour").select_option(colour)
    if discret:
        page.locator("#forge-vault-discret").check()
    page.locator("#forge-vault-new").fill(passphrase)
    page.locator("#forge-vault-confirm").fill(passphrase)
    page.locator("#forge-vault-create").click()
    run.until(page, "() => !document.querySelector('#forge-vault-recovery').hidden", 10)
    key = page.locator("#forge-vault-recovery-key").input_value()
    page.locator("#forge-vault-recovery-ok").click()
    run.until(page, "() => document.querySelector('#forge-vault-recovery').hidden && document.querySelector('#forge-vault-recovery-key').value === ''", 5)
    return key


def unlock_card(run: Run, page, index: int, passphrase: str) -> None:
    page.locator(".forge-vault-card").nth(index).click()
    page.locator("#forge-vault-pass").fill(passphrase)
    page.locator("#forge-vault-open").click()
    run.until(page, "(i) => document.querySelectorAll('.forge-vault-card')[i] && document.querySelectorAll('.forge-vault-card')[i].dataset.open === 'true' && !document.querySelector('#forge-vault-open-tools').hidden", 10, index)


def listing(run: Run, page) -> dict:
    return page.request.get(run.base + "/api/forge/vaults").json()


def section_cards(run: Run) -> None:
    print("V4.1-4.3 Mes coffres, creation, unlock, switching")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    run.check(page.locator("#forge-vaults").is_visible() and "Aucun coffre" in page.locator("#forge-vaults-empty").inner_text(), "an empty install shows Mes coffres with no card")
    run.check(page.locator("#forge-vault-setup").is_hidden(), "the creation form waits for Nouveau coffre")
    page.locator("#forge-vaults-new").click()
    warn = page.locator("#forge-vault-label-warn").inner_text()
    run.check("Ne mets rien de sensible dans le nom" in warn, "the name warning is visible: " + warn)
    run.shot(page, "mv-create", "#forge-vault-setup")
    page.locator("#forge-vault-discret").check()
    run.check("Discret" in page.locator("#forge-vault-label-warn").inner_text() and "sensible" not in page.locator("#forge-vault-label-warn").inner_text(), "in Discret mode the warning explains the number instead")
    page.locator("#forge-vault-create-cancel").click()
    page.locator("#forge-vaults-new").click()
    page.locator("#forge-vault-label").fill("Jardin")
    page.locator("#forge-vault-new").fill(PASS)
    page.locator("#forge-vault-confirm").fill("not the same phrase")
    page.locator("#forge-vault-create").click()
    run.check(run.until(page, "() => document.querySelector('#forge-vault-create-error').textContent.length > 0", 5) and page.locator("#forge-vault-new").input_value() == "", "a mismatch is refused in French and the phrases are cleared")
    page.locator("#forge-vault-create-cancel").click()
    key = create(run, page, "Jardin", PASS, "etoile", "bleu")
    run.check(len(key) > 20, "the recovery key is shown once")
    run.check(page.locator("#forge-vault-recovery-key").input_value() == "" and not page.evaluate(DOM_HAS, key), "after J'ai enregistre la cle the key is gone from the page")
    create(run, page, SECRET_NAME, PASS_B, "lune", "violet", discret=True)
    run.check(run.until(page, "() => document.querySelectorAll('.forge-vault-card').length === 2", 5), "two cards are listed")
    names = page.evaluate("() => [...document.querySelectorAll('.forge-vault-card-name')].map((n) => n.textContent)")
    states = page.evaluate("() => [...document.querySelectorAll('.forge-vault-card-state')].map((n) => n.textContent)")
    run.check(names == ["Jardin", "Coffre n\u00b0\u00a02"] and states == ["Verrouill\u00e9", "Verrouill\u00e9"], "names or numbers, both locked: " + repr(names))
    run.check(not page.evaluate(DOM_HAS, SECRET_NAME), "a locked Discret vault's name is nowhere in the page")
    tiles = page.evaluate("() => [...document.querySelectorAll('.forge-vault-card .forge-vault-tile')].map((t) => [t.dataset.colour, t.textContent, getComputedStyle(t).backgroundColor])")
    run.check(tiles[0][0] == "bleu" and tiles[0][1] == "\u2605" and tiles[1][0] == "violet", "each tile shows its glyph on its colour: " + repr(tiles))
    geo = page.evaluate(GEO)
    run.check(geo["sw"] <= geo["vw"] and geo["sameRow"] and geo["minCard"] >= 44 and geo["targets"] >= 44, "at 375 px two columns, no overflow, 44 px targets: " + repr(geo))
    run.shot(page, "mv-cards", "#forge-vaults")
    unlock_card(run, page, 0, PASS)
    run.until(page, "() => document.querySelector('#forge-vaults-note').textContent.includes('Jardin')", 10)
    run.check("\u00ab\u00a0Jardin\u00a0\u00bb est ouvert." in page.locator("#forge-vaults-note").inner_text(), "the note says which vault is open")
    run.check(page.locator("#forge-private-target").input_value() == listing(run, page)["open"], "the vault just opened becomes the destination")
    page.locator(".forge-vault-card").nth(1).click()
    switch = page.locator("#forge-vault-switch-note").inner_text()
    run.check("verrouillera \u00ab\u00a0Jardin\u00a0\u00bb" in switch, "the sheet says the open vault will be locked: " + switch)
    run.shot(page, "mv-switch-sheet", "#forge-vault-unlock")
    page.locator("#forge-vault-pass").fill("wrong but long enough")
    page.locator("#forge-vault-open").click()
    run.check(run.until(page, "() => /refus/.test(document.querySelector('#forge-vault-error').textContent)", 5) and page.locator("#forge-vault-pass").input_value() == "", "a wrong phrase is refused and cleared")
    run.check(listing(run, page)["open"] is not None, "a refused phrase leaves the first vault as it was")
    page.locator("#forge-vault-pass").fill(PASS_B)
    page.locator("#forge-vault-open").click()
    run.check(run.until(page, "() => document.querySelectorAll('.forge-vault-card')[1].dataset.open === 'true'", 10), "the Discret vault opens")
    # The card flips during the refresh; the note is written right after it. Wait for the note, not a sleep.
    run.until(page, "() => /est verrouill/.test(document.querySelector('#forge-vaults-note').textContent)", 10)
    note = page.locator("#forge-vaults-note").inner_text()
    run.check("\u00ab\u00a0Jardin\u00a0\u00bb est verrouill\u00e9." in note and SECRET_NAME in note, "switching says the first vault was locked: " + note)
    run.check(page.evaluate("() => document.querySelectorAll('.forge-vault-card')[0].dataset.open") == "false", "only one card is open")
    run.check(page.locator(".forge-vault-card-name").nth(1).inner_text() == SECRET_NAME, "while open, the Discret name shows")
    run.shot(page, "mv-switched", "#forge-vaults")
    page.locator("#forge-vault-lock").click()
    run.check(run.until(page, "() => !document.querySelector('.forge-vault-card[data-open=true]') && document.querySelector('#forge-vault-open-tools').hidden", 5), "Verrouiller closes the open vault")
    run.check(not page.evaluate(DOM_HAS, SECRET_NAME), "after the lock the Discret name is gone from the DOM (cards, notes, menu)")
    run.check(listing(run, page)["open"] is None, "the server has no vault open")
    hits = page.evaluate(STORAGE_PROBE, SECRET_NAME) + page.evaluate(STORAGE_PROBE, "Jardin") + page.evaluate(STORAGE_PROBE, "vlt-")
    run.check([h for h in hits if h != "session:hqForgeDraft"] == [], "no vault name or id in browser storage: " + repr(hits))
    ctx.close()


def section_destination(run: Run) -> None:
    print("V4.4 destination of a private generation")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, "Atelier", PASS)
    create(run, page, "Archives", PASS_B, "cle", "vert")
    vids = [v["id"] for v in listing(run, page)["vaults"]]
    run.check(page.locator("#forge-private-target").input_value() == "", "nothing is chosen while every vault is locked")
    page.locator("#forge-prompt").fill("phare prive")
    run.until(page, "() => !document.querySelector('#forge-generate-private').disabled", 15)
    page.locator("#forge-generate-private").click()
    run.check(run.until(page, "() => /Choisis d'abord/.test(document.querySelector('#forge-private-target-note').textContent)", 5), "Generate without a destination asks for one, no silent choice")
    run.check(page.request.get(run.base + "/api/forge/jobs").json()["jobs"] == [], "no job was sent")
    page.locator("#forge-private-target").select_option(vids[1])
    run.check(run.until(page, "() => !document.querySelector('#forge-vault-unlock').hidden && /Archives/.test(document.querySelector('#forge-vault-unlock-for').textContent)", 5), "choosing a locked vault opens its unlock sheet")
    run.shot(page, "mv-destination-sheet", "#forge-vault-unlock")
    page.locator("#forge-vault-pass").fill(PASS_B)
    page.locator("#forge-vault-open").click()
    run.check(run.until(page, "(v) => document.querySelector('#forge-private-target').value === v && /Archives/.test(document.querySelector('#forge-private-target-note').textContent)", 10, vids[1]), "the opened vault is the destination and it says so")
    run.shot(page, "mv-destination", "#forge-private-target-row")
    bodies = []
    page.on("request", lambda r: bodies.append(r.post_data or "") if r.url.endswith("/api/forge/jobs") and r.method == "POST" else None)
    page.locator("#forge-generate-private").click()
    done = False
    for _ in range(80):
        jobs = page.request.get(run.base + "/api/forge/jobs").json()["jobs"]
        if jobs and jobs[0].get("state") in ("completed", "failed", "cancelled"):
            done = jobs[0].get("state") == "completed"
            break
        page.wait_for_timeout(250)
    run.check(done, "the private job completes on the mock Forge")
    run.check(bodies and ('"vault":"' + vids[1] + '"') in bodies[0].replace(" ", ""), "the job names the destination vault")
    gallery = page.request.get(run.base + "/api/forge/vaults/" + vids[1] + "/gallery").json()
    run.check(len(gallery.get("images", [])) == 1, "the image landed in Archives")
    run.check("phare prive" not in page.request.get(run.base + "/api/forge/jobs").text() and "phare prive" not in page.request.get(run.base + "/api/forge/gallery?view=history&limit=50").text(), "the private prompt is in neither jobs nor history")
    page.locator(".forge-vault-card").nth(0).click()
    page.locator("#forge-vault-pass").fill(PASS)
    page.locator("#forge-vault-open").click()
    run.until(page, "() => document.querySelectorAll('.forge-vault-card')[0].dataset.open === 'true'", 10)
    run.check(page.request.get(run.base + "/api/forge/vaults/" + vids[0] + "/gallery").json().get("images") == [], "Atelier stays empty")
    ctx.close()


def section_away(run: Run) -> None:
    print("V4.7 leaving the app locks every vault and clears the page")
    ctx = run.context(VISIBILITY_STUB)
    page = ctx.new_page()
    page.clock.install()
    run.open_forge(page)
    to_private(run, page)
    create(run, page, SECRET_NAME, PASS, discret=True)
    unlock_card(run, page, 0, PASS)
    vid = listing(run, page)["open"]
    image = page.request.post(run.base + "/api/forge/vaults/" + vid + "/import", data=_png_bytes(), headers={"origin": run.base, "content-type": "application/octet-stream"})
    run.check(image.status == 201, "a synthetic image is imported into the open vault")
    run.dest(page, "normal")
    to_private(run, page)
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card img[src^=blob]').length === 1", 10), "its thumbnail shows while open")
    run.until(page, "() => !document.querySelector('#forge-vault-open-tools').hidden && document.querySelector('#forge-vault-away').getBoundingClientRect().width > 0", 10)
    page.locator("#forge-vault-away").check()
    page.evaluate("() => window.__setVisibility('hidden')")
    page.clock.fast_forward(31_000)
    run.check(run.until(page, "() => !document.querySelector('.forge-vault-card[data-open=true]') && document.querySelector('#forge-vault-open-tools').hidden", 5), "30 s in the background locks")
    run.check(listing(run, page)["open"] is None, "the server closed it too")
    run.check(page.evaluate("() => [...document.querySelectorAll('img')].filter((i) => (i.getAttribute('src') || '').startsWith('blob:')).length") == 0, "no decrypted thumbnail stays")
    run.check(not page.evaluate(DOM_HAS, SECRET_NAME), "no Discret name stays in the DOM")
    page.evaluate("() => window.__setVisibility('visible')")
    run.shot(page, "mv-after-away", "#forge-vaults")
    ctx.close()


def seed_legacy(vault_dir: Path) -> None:
    """A single pre-migration vault with one image, in a throwaway folder (as the real one looks before V4)."""
    os.environ["HQ_FORGE_VAULT_DIR"] = str(vault_dir)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import hq_forge_vault as V
    hq = Path(tempfile.mkdtemp(prefix="hq-forge-mv-seed-"))
    V.setup(hq, PASS, PASS)
    token = "seed-session-0123456789abcdef"
    V.unlock(hq, token, PASS)
    V.store_image(hq, token, _png_bytes(), None)
    V.drop_session(token)
    del os.environ["HQ_FORGE_VAULT_DIR"]


def section_migration(run: Run) -> None:
    print("V4.5 migration screen")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    to_private(run, page)
    run.check(page.locator("#forge-migrate").is_visible() and page.locator("#forge-vaults").is_hidden(), "the single vault shows the migration screen, not the list")
    text = page.locator("#forge-migrate").inner_text()
    run.check("sans \u00eatre rechiffr\u00e9" in text and "Rien ne se fait tout seul" in text, "it says the vault moves without re-encryption and never by itself")
    run.shot(page, "mv-migrate-locked", "#forge-migrate")
    page.locator("#forge-migrate-pass").fill("wrong but long enough")
    page.locator("#forge-migrate-open").click()
    run.check(run.until(page, "() => /refus/.test(document.querySelector('#forge-migrate-status').textContent)", 5), "a wrong phrase is refused in French")
    page.locator("#forge-migrate-pass").fill(PASS)
    page.locator("#forge-migrate-open").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-migrate-offer').hidden && document.querySelector('#forge-migrate-confirm').hidden", 5), "once open, the ZIP is offered first and there is nothing to confirm yet")
    run.shot(page, "mv-migrate-offer", "#forge-migrate")
    page.once("dialog", lambda d: d.dismiss())
    page.locator("#forge-migrate-skip").click()
    page.wait_for_timeout(300)
    run.check(page.locator("#forge-migrate-confirm").is_hidden(), "dismissing Continuer sans sauvegarde does nothing")
    with page.expect_download(timeout=10_000) as dl:
        page.locator("#forge-migrate-zip").click()
    run.check(dl.value.suggested_filename == "coffre-chiffre.zip", "the ZIP is downloaded")
    run.check(run.until(page, "() => !document.querySelector('#forge-migrate-confirm').hidden && document.querySelector('#forge-migrate-go').disabled", 5), "then the confirmation appears, disabled until ticked")
    run.check("15 minutes" in page.locator("#forge-migrate-offer-note").inner_text(), "it says the offer lasts 15 minutes and what cancels it")
    run.check(V_layout(run, page) == "legacy", "downloading never migrates")
    run.shot(page, "mv-migrate-confirm", "#forge-migrate")
    page.locator("#forge-migrate-lock").click()
    run.check(run.until(page, "() => /annul\u00e9e/.test(document.querySelector('#forge-migrate-status').textContent) && document.querySelector('#forge-migrate-confirm').hidden && !document.querySelector('#forge-migrate-unlock').hidden", 5),
              "locking cancels the offer and the screen says so")
    run.shot(page, "mv-migrate-cancelled", "#forge-migrate")
    page.locator("#forge-migrate-pass").fill(PASS)
    page.locator("#forge-migrate-open").click()
    run.until(page, "() => !document.querySelector('#forge-migrate-offer').hidden", 5)
    run.check(page.locator("#forge-migrate-confirm").is_hidden(), "after reopening the confirmation needs a new ZIP")
    forced = page.evaluate("async () => { const r = await fetch('/api/forge/vaults/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return [r.status, (await r.json()).code]; }")
    run.check(forced == [409, "backup_first"], "the server refuses too: the old offer died with the lock " + repr(forced))
    with page.expect_download(timeout=10_000):
        page.locator("#forge-migrate-zip").click()
    run.until(page, "() => !document.querySelector('#forge-migrate-confirm').hidden", 5)
    page.locator("#forge-migrate-ack").check()
    run.check(page.locator("#forge-migrate-go").is_enabled(), "ticking J'ai compris enables the button")
    page.locator("#forge-migrate-go").click()
    run.check(run.until(page, "() => document.querySelector('#forge-migrate').hidden && document.querySelectorAll('.forge-vault-card').length === 1", 15), "after confirming, the vault is in Mes coffres")
    run.check("d\u00e9plac\u00e9" in page.locator("#forge-vaults-note").inner_text(), "the note says it was moved")
    run.check(V_layout(run, page) == "multi", "the server layout is multi")
    run.shot(page, "mv-migrated", "#forge-vaults")
    unlock_card(run, page, 0, PASS)
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 1", 10), "the same phrase opens it and the image is still there")
    ctx.close()


def V_layout(run: Run, page) -> str:
    return page.request.get(run.base + "/api/forge/vaults").json()["layout"]


SECTIONS = {"cards": section_cards, "destination": section_destination, "away": section_away, "migration": section_migration}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
            extra = None
            if name == "migration":
                vault = Path(tempfile.mkdtemp(prefix="hq-forge-mv-legacy-"))
                seed_legacy(vault)
                extra = {"HQ_FORGE_VAULT_DIR": str(vault)}
            proc, info = start_server(extra)
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