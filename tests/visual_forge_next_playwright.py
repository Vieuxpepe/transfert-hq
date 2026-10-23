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
    env.update({k: v for k, v in (extra_env or {}).items() if not k.startswith("_")})
    proc = subprocess.Popen([sys.executable, str(QW.HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    assert info["base"].startswith("http://127.0.0.1:") and not info["base"].endswith(QW.PROD_PORTS)
    # The server refuses a non-empty root, so the synthetic statistics land right after it starts.
    (root / ".hq-forge").mkdir(parents=True, exist_ok=True)
    (root / ".hq-forge" / "stats.json").write_text(json.dumps({"version": 1, "records": records or []}), encoding="utf-8")
    if name_jobs := (extra_env or {}).get("_JOBS"):
        (root / ".hq-forge" / "jobs.json").write_text(name_jobs, encoding="utf-8")
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


JOB_ID = "job-" + "c" * 24
UNCERTAIN_JOBS = json.dumps({"jobs": [{"id": JOB_ID, "state": "generating", "destination": "normal", "submitted": True,
                                       "settings": {"prompt": "phare incertain", "negative_prompt": "", "width": 640, "height": 512, "steps": 12},
                                       "created": "2026-10-22T18:00:00Z", "started_at": "2026-10-22T18:00:01Z"}], "idempotency": {}})


def section_journal(run: Run) -> None:
    print("D journal and explicit choices")
    ctx = run.context(init_script="sessionStorage.setItem('hqForgeJob', '" + JOB_ID + "');")
    page = ctx.new_page()
    run.open_forge(page)
    run.check(run.until(page, "() => !document.querySelector('#forge-job-choice').hidden", 10), "an uncertain job offers an explicit choice")
    labels = page.locator("#forge-job-choice button").all_inner_texts()
    run.check(labels == ["Relancer", "Marquer perdue", "Garder tel quel"], "the three choices: " + repr(labels))
    run.check("Rien n\u2019est relanc\u00e9 sans vous" in page.locator("#forge-job-choice").inner_text(), "it says nothing restarts on its own")
    run.check(not page.locator("#forge-job-journal").get_attribute("open") and page.locator("#forge-job-journal").is_visible(), "the journal is there, collapsed by default")
    page.locator("#forge-job-journal summary").click()
    text = page.locator("#forge-job-journal-list").inner_text()
    run.check("Cet HQ" in text and "Envoy\u00e9 \u00e0 Forge" in text and "incertain" in text, "a readable timeline: which PC, what, when: " + text.replace("\n", " | "))
    check_choices(run, page, "local job")
    check_reach(run, page, "#forge-job-choice", "the job choice")
    run.shot(page, "journal-job-uncertain", "#forge-normal-results")
    page.wait_for_timeout(1500)
    run.check(len(page.request.get(run.base + "/api/forge/jobs").json()["jobs"]) == 1, "no automatic relaunch while waiting for the choice")
    page.locator("#forge-job-choice button", has_text="Relancer").click()
    run.check(page.locator("#forge-width").input_value() == "640" and "Touchez G\u00e9n\u00e9rer" in page.locator("#forge-job-choice").inner_text(),
              "Relancer only puts the settings back in the form")
    run.check(len(page.request.get(run.base + "/api/forge/jobs").json()["jobs"]) == 1, "Relancer itself starts nothing")
    resolved = page.request.post(run.base + "/api/forge/jobs/" + JOB_ID + "/resolve", data=json.dumps({"action": "keep"}),
                                 headers={"origin": run.base, "content-type": "application/json"})
    run.check(resolved.status == 200 and resolved.json()["job"]["resolution"] == "kept", "Garder tel quel is recorded")
    ctx.close()
    # A multi-device batch: one line per image in a collapsed journal.
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    run.until(page, "() => document.querySelectorAll('.forge-device').length >= 3", 20)
    for name in ("PC salon", "Portable"):
        box = page.locator(".forge-device", has_text=name).locator('input[type="checkbox"]')
        if not box.is_checked():
            box.check()
    page.locator("#forge-fleet-count").fill("3")
    page.locator("#forge-fleet-count").dispatch_event("input")
    page.locator("#forge-prompt").fill("phare en lot journal")
    page.locator("#forge-generate").click()
    run.check(run.until(page, "() => /Termin/.test(document.querySelector('#forge-fleet-batch-state').textContent)", 40), "the batch finishes")
    run.check(not page.locator("#forge-fleet-batch-journal").get_attribute("open"), "the batch journal is collapsed by default")
    page.locator("#forge-fleet-batch-journal summary").click()
    items = page.locator("#forge-fleet-journal-list li").all_inner_texts()
    run.check(len(items) == 3 and all("envoy\u00e9e" in t and "termin\u00e9e" in t for t in items), "one timeline line per image with PC and times: " + repr(items[:2]))
    run.shot(page, "journal-batch", "#forge-fleet-batch")
    ctx.close()


def tell(run: Run, command: str) -> str:
    run.proc.stdin.write((command + "\n").encode())
    run.proc.stdin.flush()
    return run.proc.stdout.readline().decode().strip()


def section_uncertain(run: Run) -> None:
    print("D batch: explicit choices for uncertain images")
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    run.check(run.until(page, "() => document.querySelectorAll('.forge-device').length >= 4", 20), "PC salon and three silent PCs are listed")
    for card in page.locator(".forge-device").all():
        box = card.locator('input[type="checkbox"]')
        want = any(n in card.inner_text() for n in ("PC salon", "PC muet"))
        if box.count() and box.is_checked() != want:
            box.click()
    page.locator("#forge-fleet-count").fill("4")
    page.locator("#forge-fleet-count").dispatch_event("input")
    page.locator("#forge-prompt").fill("phare lot incertain")
    tell(run, "beat")
    page.locator("#forge-generate").click()
    run.until(page, "() => !document.querySelector('#forge-fleet-batch').hidden", 10)
    ids = {}
    for name in "ABC":
        reply = tell(run, "claim " + name)
        run.check(reply.startswith("ok tk-"), "PC muet " + name + " takes one image and goes silent")
        ids[name] = reply[3:]
    tell(run, "start")
    run.check(run.until(page, "() => /1 \\/ 4 termin/.test(document.querySelector('#forge-fleet-batch-totals').textContent)", 30), "PC salon finishes the fourth image")
    tell(run, "expire")
    run.check(run.until(page, "() => /3 incertaines/.test(document.querySelector('#forge-fleet-batch-totals').textContent) && !document.querySelector('#forge-fleet-batch-cancel').checkVisibility()", 20),
              "the silent PCs' images become uncertain and the batch ends")
    tell(run, "unexpire")
    batch_id = page.request.get(run.base + "/api/forge/batches").json()["batches"][-1]["batch_id"]
    src = lambda: page.request.get(run.base + "/api/forge/batches/" + batch_id).json()["batch"]
    run.check(src()["retryable"] == 3, "three images can be retried")
    calls_before = len(page.request.get(run.base + "/api/forge/batches").json()["batches"])
    page.wait_for_timeout(1500)
    run.check(len(page.request.get(run.base + "/api/forge/batches").json()["batches"]) == calls_before and src()["retryable"] == 3, "no automatic retry")
    page.locator("#forge-fleet-batch-journal summary").click()
    def row_of(name):
        index = next(t["index"] for t in src()["tasks"] if t["id"] == ids[name])
        return page.locator("#forge-fleet-journal-list li", has_text="Image " + str(index + 1) + " ")
    run.check(page.locator("#forge-fleet-journal-list .forge-journal-choice").count() == 3, "each uncertain image offers Relancer / Marquer perdue / Garder tel quel")
    check_choices(run, page, "batch")
    page.evaluate("() => { const rows = document.querySelectorAll('#forge-fleet-journal-list .forge-journal-choice'); rows[rows.length - 1].dataset.reach = '1'; }")
    check_reach(run, page, "#forge-fleet-journal-list [data-reach]", "the last uncertain choice row")
    run.shot(page, "uncertain-choices", "#forge-fleet-batch")
    # Marquer perdue (A)
    row_of("A").locator("button", has_text="Marquer perdue").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-fleet-journal-list .forge-journal-choice').length === 2", 10), "A: its choices disappear")
    run.check("marqu\u00e9e perdue" in row_of("A").inner_text(), "A: the journal says marqu\u00e9e perdue")
    run.check(src()["retryable"] == 2 and "2 images manquantes" in page.locator("#forge-fleet-batch-retry").inner_text(), "A is no longer offered for retry (2 left)")
    # Garder tel quel (C)
    row_of("C").locator("button", has_text="Garder tel quel").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-fleet-journal-list .forge-journal-choice').length === 1", 10), "C: its choices disappear")
    run.check("gard\u00e9e telle quelle" in row_of("C").inner_text(), "C: the journal says gard\u00e9e telle quelle")
    run.check(src()["retryable"] == 1 and "l'image manquante" in page.locator("#forge-fleet-batch-retry").inner_text(), "C is no longer offered for retry (1 left)")
    # Relancer (B): a retry batch with only that image, run once
    row_of("B").locator("button", has_text="Relancer").click()
    run.check(run.until(page, "() => /Termin/.test(document.querySelector('#forge-fleet-batch-state').textContent) && /1 \\/ 1 termin/.test(document.querySelector('#forge-fleet-batch-totals').textContent)", 30),
              "B: a retry batch of exactly one image runs and finishes")
    batches = page.request.get(run.base + "/api/forge/batches").json()["batches"]
    retry = [b for b in batches if b.get("retry_of") == batch_id]
    run.check(len(retry) == 1 and [t["retry_of_task"] for t in retry[0]["tasks"]] == [ids["B"]] and retry[0]["tasks"][0]["attempt"] == 2,
              "the retry holds only B's task, attempt 2")
    s = src()
    b_row = next(t for t in s["tasks"] if t["id"] == ids["B"])
    run.check(s["retryable"] == 0 and b_row["retried"], "nothing is left to retry in the source batch")
    again = page.request.post(run.base + "/api/forge/batches/" + batch_id + "/retry", data=json.dumps({"tasks": [ids["B"]]}),
                              headers={"origin": run.base, "content-type": "application/json", "Idempotency-Key": "uncertain-again-0001"})
    run.check(again.status == 409, "B cannot be retried a second time")
    run.check(s["counts"] == {"total": 4, "done": 1, "failed": 0, "pending": 0, "running": 0, "uncertain": 3, "cancelled": 0}, "source counts stay coherent: " + repr(s["counts"]))
    run.shot(page, "uncertain-after-retry", "#forge-fleet-batch")
    # The silent PC A finally answers: still accepted on its original task.
    tell(run, "late A")
    s = src()
    a_row = next(t for t in s["tasks"] if t["id"] == ids["A"])
    run.check(a_row["state"] == "completed" and a_row["image_id"] and a_row["resolution"] is None, "a late upload from PC muet A is accepted on its task (the lost mark no longer applies)")
    run.check(s["counts"]["done"] == 2 and s["counts"]["uncertain"] == 2 and sum(v for k, v in s["counts"].items() if k != "total") == 4, "counts after the late image: " + repr(s["counts"]))
    run.check(s["retryable"] == 0, "still nothing offered for retry")
    ctx.close()


REACH_PROBE = """(sel) => {
  const el = document.querySelector(sel);
  if (!el || !el.getClientRects().length) return {ok: false, why: 'missing ' + sel};
  const nav = document.querySelector('.bottom-nav');
  const navTop = nav && nav.getClientRects().length ? nav.getBoundingClientRect().top : innerHeight;
  const covered = () => { const r = el.getBoundingClientRect(); const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1);
    const hit = document.elementFromPoint(x, r.bottom - 2); return { r, hit, ok: r.bottom <= navTop + 0.5 && !!hit && (hit === el || el.contains(hit)) }; };
  el.scrollIntoView({block: 'center', behavior: 'instant'});
  let c = covered();
  if (!c.ok) { window.scrollTo({top: document.documentElement.scrollHeight, behavior: 'instant'}); c = covered(); }
  const pad = parseFloat(getComputedStyle(document.querySelector('#forge-studio')).paddingBottom) || 0;
  return {ok: c.ok, bottom: Math.round(c.r.bottom), navTop: Math.round(navTop), hit: c.hit ? (c.hit.id || c.hit.className || c.hit.tagName) : 'none',
    pad: Math.round(pad), navH: nav ? Math.round(nav.getBoundingClientRect().height) : 0};
}"""

CHOICE_PROBE = """(sel) => {
  const rows = [...document.querySelectorAll(sel)];
  return rows.map((row) => { const b = [...row.querySelectorAll('button')].map((x) => x.getBoundingClientRect());
    const tops = new Set(b.map((r) => Math.round(r.top)));
    return {n: b.length, lines: tops.size, minH: Math.min(...b.map((r) => r.height)), right: Math.max(...b.map((r) => r.right)), vw: document.documentElement.clientWidth}; });
}"""


def check_reach(run: Run, page, selector: str, label: str) -> None:
    r = page.evaluate(REACH_PROBE, selector)
    run.check(r["ok"] and r["pad"] >= r["navH"], label + " can be scrolled fully above the bottom nav " + repr(r))


def check_choices(run: Run, page, label: str) -> None:
    rows = page.evaluate(CHOICE_PROBE, "#forge-fleet-journal-list .forge-journal-choice, #forge-job-choice .forge-journal-choice")
    run.check(rows and all(r["lines"] in (1, r["n"]) and r["minH"] >= 44 and r["right"] <= r["vw"] for r in rows),
              label + ": choice buttons sit on one row or stack one per line, never 2+1, \u2265 44 px " + repr(rows))


def section_layout(run: Run) -> None:
    print("D3 375px layout: wake toggle, planner, bin vs bottom nav")
    ctx = run.context(init_script=QW.WAKE_STUB)
    page = ctx.new_page()
    run.open_forge(page)
    run.check(run.until(page, "() => !document.querySelector('#forge-wake-wrap').hidden", 5), "the wake toggle is shown")
    gap = page.evaluate("""() => { const l = document.querySelector('#forge-wake-wrap label').getBoundingClientRect();
      const b = document.querySelector('#forge-wake-wrap .forge-help').getBoundingClientRect();
      return {gap: Math.round((b.left - l.right) * 10) / 10, bh: Math.round(b.height), bw: Math.round(b.width), lh: Math.round(l.height), overlap: !(l.right <= b.left || b.right <= l.left || l.bottom <= b.top || b.bottom <= l.top)}; }""")
    run.check(gap["gap"] >= 8 and not gap["overlap"], "Garder l'\u00e9cran allum\u00e9 and Aide have \u2265 8 px between them " + repr(gap))
    run.check(gap["bh"] >= 44 and gap["bw"] >= 44 and gap["lh"] >= 44, "both are \u2265 44 px touch targets " + repr(gap))
    page.locator("#forge-wake-wrap").scroll_into_view_if_needed()
    run.shot(page, "layout-wake", "#forge-wake-wrap")
    set_size(page, 768, 512, 20)
    run.until(page, "() => !document.querySelector('#forge-plan').hidden", 10)
    check_reach(run, page, "#forge-plan", "the planner")
    run.shot(page, "layout-plan", "#forge-plan")
    check_reach(run, page, "#forge-trash-open", "Corbeille")
    check_reach(run, page, "#forge-lab summary", "Laboratoire")
    run.shot(page, "layout-bottom")
    ctx.close()


SECTIONS = {"layout": section_layout, "triage": section_triage, "lab": section_lab, "plan": section_plan, "journal": section_journal, "uncertain": section_uncertain}
EXTRA_ENV: dict = {"uncertain": {"HQ_FORGE_FLEET_MOCK": "1", "HQ_FORGE_FLEET_DELAY": "0.2", "HQ_FORGE_FLEET_STALL": "3"}, "journal": {"_JOBS": UNCERTAIN_JOBS, "HQ_FORGE_FLEET_MOCK": "2", "HQ_FORGE_FLEET_DELAY": "0.3"}}
SEEDED = {"layout": seeded_records, "lab": seeded_records, "plan": seeded_records, "journal": list}


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
                run.proc = proc
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