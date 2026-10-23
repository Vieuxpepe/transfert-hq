"""Forge Studio next features: quick triage + bin (B), lab (B), planner (C), journal (D). Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault. Same harness as quick wins.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_next_playwright.py [section ...]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

import visual_forge_quick_wins_playwright as QW
from visual_forge_quick_wins_playwright import Run, open_vault, import_private, generate_once, start_server, STORAGE_PROBE


def seeded_records() -> list:
    rows = []
    def add(n, **over):
        for i in range(n):
            row = {"ts": "2026-10-01T10:00:00Z", "kind": "batch", "outcome": "completed", "device_id": "w1", "device_name": "PC salon",
                   "checkpoint": "absent-model", "sampler_name": "Euler a", "steps": 20, "width": 768, "height": 512, "hires": False,
                   "cfg_scale": 6.5, "duration_s": 8.0 + (i % 4), "attempt": 1, "count": 1}
            row.update(over)
            rows.append(row)
    add(24)
    add(21, device_id="w2", device_name="Bureau", duration_s=14.0)
    add(3, device_id="w2", device_name="Bureau", outcome="failed", error="forge_oom", duration_s=None)
    add(5, device_id="w3", device_name="Portable", checkpoint="autre-modele", duration_s=20.0)
    return rows


def start_seeded(extra_env: dict | None = None, records: list | None = None):
    """Same isolated server as the quick-wins harness, plus synthetic statistics."""
    root = Path(tempfile.mkdtemp(prefix="hq-forge-next-"))
    vault = Path(tempfile.mkdtemp(prefix="hq-forge-next-vault-"))
    env = os.environ.copy()
    env["HQ_FORGE_MOCK"] = "ready"
    env["HQ_FORGE_VAULT_DIR"] = str(vault)
    env.update(extra_env or {})
    proc = subprocess.Popen([sys.executable, str(QW.HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    assert info["base"].startswith("http://127.0.0.1:") and not info["base"].endswith(QW.PROD_PORTS)
    # The server refuses a non-empty root, so the synthetic statistics land right after it starts.
    (root / ".hq-forge").mkdir(parents=True, exist_ok=True)
    (root / ".hq-forge" / "stats.json").write_text(json.dumps({"version": 1, "records": records or []}), encoding="utf-8")
    return proc, info


def swipe(page, selector: str, dx: int, dy: int) -> None:
    box = page.locator(selector).bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + dx, y + dy, steps=6)
    page.mouse.up()


def section_triage(run: Run) -> None:
    print("B quick triage and bin")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    for n in range(4):
        generate_once(run, page, "phare a trier " + str(n))
    page.locator("#forge-triage-open").click()
    page.locator("#forge-triage").wait_for()
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '1 / 4'", 5), "quick triage opens on the 4 untriaged images")
    run.check(run.until(page, "() => !!document.querySelector('#forge-triage-img').getAttribute('src')", 5), "the first image is shown full screen")
    run.shot(page, "triage-normal")
    swipe(page, "#forge-triage-stage", 150, 0)
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '2 / 4'", 5), "swipe right keeps")
    swipe(page, "#forge-triage-stage", -150, 0)
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '3 / 4'", 5), "swipe left rejects")
    run.check("corbeille" in page.locator("#forge-triage-note").inner_text(), "the note says the rejected image went to the bin")
    page.locator("#forge-triage-undo").click()
    run.check(run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '2 / 4'", 5), "undo brings the last image back")
    page.locator("#forge-triage-reject").click()
    run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '3 / 4'", 5)
    page.locator("#forge-triage-favorite").click()
    run.until(page, "() => document.querySelector('#forge-triage-count').textContent === '4 / 4'", 5)
    page.locator("#forge-triage-keep").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-triage-empty').hidden", 5), "the end says nothing is left to sort")
    page.locator("#forge-triage-close").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-gallery .forge-card').length === 3", 10), "the rejected image leaves the gallery (3 left)")
    run.check(run.until(page, "() => !!document.querySelector('#forge-gallery .forge-card[data-triage=\"favorite\"] .forge-card-badge')", 5), "the favourite carries a badge")
    run.shot(page, "triage-gallery", "#forge-normal-gallery")
    page.locator("#forge-trash-open").click()
    page.locator("#forge-trash").wait_for()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-trash-grid .forge-trash-item').length === 1", 5), "the bin holds the rejected image")
    run.shot(page, "triage-bin")
    page.locator("#forge-trash-grid button").first.click()
    run.check(run.until(page, "() => !document.querySelector('#forge-trash-empty').hidden", 5), "Remettre empties the bin")
    page.locator("#forge-trash-close").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-gallery .forge-card').length === 4", 10), "the image is back in the gallery, nothing was deleted")
    page.locator('#forge-gallery .forge-card[data-triage="favorite"]').first.click()
    page.locator("#forge-viewer").wait_for()
    run.check(run.until(page, "() => document.querySelector('#forge-viewer-triage [data-state=\"favorite\"]').getAttribute('aria-pressed') === 'true'", 5), "the viewer shows the current flag")
    page.locator('#forge-viewer-triage [data-state="none"]').click()
    run.check(run.until(page, "() => document.querySelector('#forge-viewer-triage [data-state=\"none\"]').getAttribute('aria-pressed') === 'true'", 5), "the flag can be changed back from the viewer")
    run.shot(page, "triage-viewer", "#forge-viewer-triage")
    page.locator("#forge-viewer-close").click()
    # Vault: same triage, flags kept in the encrypted vault, nothing in browser storage.
    open_vault(run, page)
    import_private(run, page)
    import_private(run, page)
    page.locator("#forge-vault-triage-open").click()
    page.locator("#forge-triage").wait_for()
    run.check(run.until(page, "() => /\\/ 2$/.test(document.querySelector('#forge-triage-count').textContent)", 5), "vault triage lists the 2 private images")
    run.check(run.until(page, "() => (document.querySelector('#forge-triage-img').getAttribute('src') || '').startsWith('blob:')", 5), "private pixels come from a blob URL")
    run.shot(page, "triage-vault")
    page.locator("#forge-triage-reject").click()
    run.until(page, "() => /^2 \\//.test(document.querySelector('#forge-triage-count').textContent)", 5)
    page.locator("#forge-triage-close").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 1", 10), "the rejected private image leaves the vault gallery")
    page.locator("#forge-vault-trash-open").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-trash-grid .forge-trash-item').length === 1", 5), "the vault bin holds it")
    hits = page.evaluate(STORAGE_PROBE, "pvt-")
    run.check([h for h in hits if h not in ("session:hqForgeDraft",)] == [], "no vault id or flag in browser storage: " + repr(hits))
    page.locator("#forge-trash-close").click()
    stats = page.request.get(run.base + "/api/forge/gallery?view=trash").json()["images"]
    run.check(all(not row["id"].startswith("pvt-") for row in stats), "vault images never appear in the normal bin")
    page.locator("#forge-vault-lock").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-vault-gallery .forge-card').length === 0", 5), "locking the vault drops the private views")
    lab = page.request.get(run.base + "/api/forge/lab").json()
    run.check(lab["records"] == 4 and lab["vault_excluded"], "the lab counts the 4 gallery images only, never the vault")
    run.dest(page, "normal")
    page.locator("#forge-lab summary").click()
    page.locator("#forge-lab-tab-keep").click()
    run.check(run.until(page, "() => /Pas assez de donn\u00e9es \\(2 \\/ 20\\)/.test(document.querySelector('#forge-lab-panel').textContent)", 10),
              "keep rate counts the 2 sorted images and says it is not enough yet")
    ctx.close()


def section_lab(run: Run) -> None:
    print("B laboratoire")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    page.locator("#forge-prompt").fill("mon prompt reste")
    page.locator("#forge-lab summary").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-lab-panel .forge-lab-group').length === 2", 10), "speed view: one block per comparable checkpoint/size")
    run.check(page.locator("#forge-lab-tab-speed").get_attribute("aria-selected") == "true", "Vitesse is the first view")
    rows = page.locator("#forge-lab-panel .forge-lab-group").first.locator(".forge-lab-row")
    run.check(rows.count() == 2 and "PC salon" in rows.nth(0).inner_text() and "Bureau" in rows.nth(1).inner_text(), "the faster PC comes first inside the comparable block")
    run.check("par image" in rows.nth(0).inner_text() and page.locator("#forge-lab-panel meter").count() >= 2, "simple bars with seconds per image")
    run.check("Pas assez de donn\u00e9es (5 / 20)" in page.locator("#forge-lab-panel").inner_text(), "a setting with 5 images says Pas assez de donn\u00e9es")
    run.check("Portable" in page.locator("#forge-lab-mixed").inner_text() and "autre-modele" in page.locator("#forge-lab-mixed").inner_text(), "confounded settings are named (Portable only with autre-modele)")
    run.check("score" not in page.locator("#forge-lab").inner_text().lower(), "no single score anywhere")
    run.shot(page, "lab-speed", "#forge-lab")
    page.locator("#forge-lab-tab-reliability").click()
    text = page.locator("#forge-lab-panel").inner_text()
    run.check("88 % r\u00e9ussies sur 24" in text and "m\u00e9moire GPU \u00d73" in text, "reliability: Bureau 21/24 with the memory errors named, no cause invented")
    run.shot(page, "lab-reliability", "#forge-lab")
    page.locator("#forge-lab-tab-keep").click()
    run.check("Ce que tu gardes" in page.locator("#forge-lab-panel").inner_text(), "keep rate is labelled Ce que tu gardes")
    run.check(page.locator("#forge-lab-panel .forge-lab-empty").count() == 1, "no sorted image yet: an honest empty state")
    run.shot(page, "lab-keep", "#forge-lab")
    page.locator("#forge-lab-tab-speed").click()
    page.locator("#forge-lab-panel .forge-lab-apply").first.click()
    note = page.locator("#forge-lab-applied").inner_text()
    run.check("taille 768\u00d7512" in note and "20 pas" in note and "absent-model" in note and "rien n\u2019est lanc\u00e9" in note,
              "Appliquer says what changed, what this HQ lacks, and that nothing starts: " + note)
    run.check(page.locator("#forge-width").input_value() == "768" and page.locator("#forge-height").input_value() == "512", "the form now has 768\u00d7512")
    run.check(page.locator("#forge-prompt").input_value() == "mon prompt reste", "the prompt is untouched")
    jobs = page.request.get(run.base + "/api/forge/jobs").json()["jobs"]
    run.check(jobs == [], "nothing was generated by applying")
    run.shot(page, "lab-applied", "#forge-lab-applied")
    ctx.close()


def set_size(page, width: int, height: int, steps: int) -> None:
    page.evaluate("([w, h, s]) => { for (const [id, v] of [['forge-width', w], ['forge-height', h], ['forge-steps', s]]) { const n = document.getElementById(id); n.value = String(v); n.dispatchEvent(new Event('input', {bubbles: true})); n.dispatchEvent(new Event('change', {bubbles: true})); } }", [width, height, steps])


def section_plan(run: Run) -> None:
    print("C honest planner")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    set_size(page, 768, 512, 20)
    page.evaluate("() => { const n = document.getElementById('forge-iter'); n.value = '2'; n.dispatchEvent(new Event('input', {bubbles: true})); }")
    run.check(run.until(page, "() => !document.querySelector('#forge-plan').hidden && /2 images/.test(document.querySelector('#forge-plan').textContent)", 10), "the planner shows measured durations for 2 images " + repr(page.evaluate("() => [document.querySelector('#forge-plan').textContent, document.getElementById('forge-width').value, document.getElementById('forge-iter').value]")))
    text = page.locator("#forge-plan").inner_text()
    run.check("PC salon : " in text and "Bureau : " in text and "mesures" in text, "a duration range per PC from real measurements: " + text.replace("\n", " | "))
    run.check("Partage sugg\u00e9r\u00e9 : " in text and "Indicatif" in text, "a suggested split, marked as indicative")
    run.check("manqu\u00e9 de m\u00e9moire GPU sur Bureau (3 fois)" in text, "a warning for the size that already ran out of GPU memory")
    run.shot(page, "plan-measured", "#forge-plan")
    set_size(page, 1024, 1024, 20)
    run.check(run.until(page, "() => /pas assez de donn\u00e9es pour 1024\u00d71024/.test(document.querySelector('#forge-plan').textContent)", 10), "an unmeasured size says pas assez de donn\u00e9es " + repr(page.evaluate("() => [document.querySelector('#forge-plan').textContent, document.getElementById('forge-width').value, document.getElementById('forge-height').value]")))
    run.check("m\u00e9moire" not in page.locator("#forge-plan").inner_text(), "no memory warning where nothing failed")
    run.shot(page, "plan-not-enough", "#forge-plan")
    run.check(page.request.get(run.base + "/api/forge/jobs").json()["jobs"] == [], "the planner never starts anything")
    ctx.close()


SECTIONS = {"triage": section_triage, "lab": section_lab, "plan": section_plan}
EXTRA_ENV: dict = {}
SEEDED = {"lab": seeded_records, "plan": seeded_records}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
            if name in SEEDED:
                proc, info = start_seeded(EXTRA_ENV.get(name), SEEDED[name]())
            else:
                proc, info = start_server(EXTRA_ENV.get(name))
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