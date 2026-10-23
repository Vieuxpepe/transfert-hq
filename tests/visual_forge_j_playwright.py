"""Forge Studio phase J: prompt bricks, lineage tree, house style, couch mode. Mock Forge only.

No GPU, no real Forge, no production port, throwaway data and vault. Same harness as quick wins.

FORGE_BROWSER=chromium|webkit FORGE_QW_SHOTS=dir python tests/visual_forge_j_playwright.py [section ...]
"""

from __future__ import annotations

import json
import os
import sys

from playwright.sync_api import sync_playwright

from visual_forge_quick_wins_playwright import Run, generate_once, start_server, STORAGE_PROBE, open_vault

LORAS = [{"name": "lanterne_v2", "alias": "Lanterne", "metadata": {"ss_tag_frequency": {"10_l": {"lanternlight": 30, "glow": 9}}}},
         {"name": "grain", "alias": "grain", "metadata": {}}]
GEO = """(sel) => { const els = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent);
  return { sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, n: els.length,
    h: els.length ? Math.min(...els.map((e) => e.getBoundingClientRect().height)) : 0,
    w: els.length ? Math.min(...els.map((e) => e.getBoundingClientRect().width)) : 0 }; }"""


def track(page):
    posts = []
    page.on("request", lambda r: posts.append(r.url.split("/", 3)[-1]) if r.method == "POST" else None)
    return posts


def section_bricks(run: Run) -> None:
    print("J1 prompt bricks")
    ctx = run.context()
    page = ctx.new_page()
    posts = track(page)
    run.open_forge(page)
    page.locator("#forge-bricks > summary").click()
    run.check(run.until(page, "() => !document.querySelector('#forge-bricks-empty').hidden", 5), "an empty brick list says so")
    page.locator("#forge-brick-new").click()
    run.check(page.evaluate("() => document.querySelector('#forge-brick-text').value") == "", "a new brick is never prefilled from the prompt")
    run.check(run.until(page, "() => document.querySelectorAll('#forge-brick-lora option').length === 3", 5), "this PC's LoRAs are offered")
    page.locator("#forge-brick-name").fill("Lanterne")
    page.locator("#forge-brick-text").fill("lumiere chaude")
    page.locator("#forge-brick-lora").select_option("lanterne_v2")
    run.check(run.until(page, "() => !document.querySelector('#forge-brick-suggest').hidden && /lanternlight/.test(document.querySelector('#forge-brick-suggest').textContent)", 5),
              "trigger words are suggested from the LoRA's metadata")
    page.locator("#forge-brick-suggest button", has_text="lanternlight").click()
    run.check(page.evaluate("() => document.querySelector('#forge-brick-words').value") == "lanternlight", "a tapped suggestion becomes a trigger word")
    page.locator("#forge-brick-weight").fill("0.7")
    geo = page.evaluate(GEO, "#forge-brick-editor button, #forge-brick-editor input, #forge-brick-editor select")
    run.check(geo["sw"] <= geo["vw"] and geo["h"] >= 44, "at 375 px the brick editor fits with 44 px targets: " + repr(geo))
    run.shot(page, "bricks-editor", "#forge-brick-editor")
    page.locator("#forge-brick-save").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-bricks-list .forge-brick').length === 1 && document.querySelector('#forge-brick-editor').hidden", 5), "the brick is saved")
    page.locator("#forge-prompt").fill("phare")
    before = [p for p in posts if "jobs" in p or "night" in p or "inpaint" in p]
    page.locator("#forge-bricks-list .forge-brick-add").first.click()
    value = page.evaluate("() => document.querySelector('#forge-prompt').value")
    run.check(value == "phare, <lora:lanterne_v2:0.7>, lanternlight, lumiere chaude", "touching a brick adds LoRA, trigger word and text to the prompt: " + repr(value))
    page.wait_for_timeout(400)
    run.check([p for p in posts if "jobs" in p or "night" in p or "inpaint" in p] == before, "adding a brick starts nothing")
    geo = page.evaluate(GEO, "#forge-bricks-list button")
    run.check(geo["sw"] <= geo["vw"] and geo["h"] >= 44 and geo["w"] >= 44, "at 375 px brick buttons are 44 px targets: " + repr(geo))
    run.shot(page, "bricks", "#forge-bricks")
    # Private mode: bricks can be added to the prompt but never saved.
    open_vault(run, page)
    run.dest(page, "private")
    page.locator("#forge-prompt").fill("lanterne secrete du coffre")
    page.locator("#forge-bricks-list .forge-brick-add").first.click()
    run.check("lanterne secrete du coffre, <lora:lanterne_v2" in page.evaluate("() => document.querySelector('#forge-prompt').value"), "in private mode a brick still fills the prompt")
    page.locator("#forge-brick-new").click()
    run.check(page.evaluate("() => document.querySelector('#forge-brick-save').disabled && /Mode priv/.test(document.querySelector('#forge-brick-note').textContent)"), "in private mode a brick cannot be saved, and it says why")
    stored = page.request.get(run.base + "/api/forge/bricks").json()
    run.check(len(stored["bricks"]) == 1 and "secrete" not in json.dumps(stored), "the private prompt never reaches the brick store")
    hits = page.evaluate(STORAGE_PROBE, "secrete")
    run.check(hits == [], "no private prompt in browser storage: " + repr(hits))
    ctx.close()


def section_lineage(run: Run) -> None:
    print("J2 lineage tree")
    from visual_forge_ghi_playwright import STROKE
    ctx = run.context()
    page = ctx.new_page()
    run.open_forge(page)
    generate_once(run, page, "phare de depart")
    page.locator("#forge-gallery .forge-card").first.click()
    run.until(page, "() => document.querySelector('#forge-viewer').open && document.querySelector('#forge-viewer-img').naturalWidth > 0", 10)
    source = page.evaluate("() => window.hqForgeHooks.currentDetail().id")
    page.locator("#forge-lineage > summary").click()
    run.check(run.until(page, "() => /ni image d'origine/.test(document.querySelector('#forge-lineage-note').textContent) && document.querySelectorAll('#forge-lineage-tree li').length === 1", 5),
              "an image with no links says so")
    page.locator("#forge-viewer-inpaint").click()
    run.until(page, "() => document.querySelector('#forge-inpaint').open", 5)
    page.evaluate(STROKE, [0.3, 0.3, 0.6, 0.6])
    page.locator("#forge-inpaint-send").click()
    run.check(run.until(page, "(src) => document.querySelector('#forge-viewer').open && window.hqForgeHooks.currentDetail() && window.hqForgeHooks.currentDetail().id !== src", 15, source),
              "a retouch of the image opens in the viewer")
    result = page.evaluate("() => window.hqForgeHooks.currentDetail().id")
    run.check(not page.evaluate("() => document.querySelector('#forge-lineage').open"), "the tree closes when another image opens")
    page.locator("#forge-lineage > summary").click()
    run.check(run.until(page, "() => document.querySelectorAll('#forge-lineage-tree li').length === 2", 5), "the tree shows the start image and its retouch")
    labels = page.evaluate("() => [...document.querySelectorAll('#forge-lineage-tree .forge-lineage-node')].map((b) => [b.dataset.id, b.getAttribute('aria-current'), b.textContent])")
    run.check(labels[0][0] == source and labels[0][2].startswith("Image de d") and labels[1][0] == result and labels[1][1] == "true" and labels[1][2].startswith("Retouche"),
              "start image first, the retouch below it is marked as shown: " + repr(labels))
    page.locator("#forge-lineage .forge-help").click()
    run.check(page.evaluate("() => getComputedStyle(document.querySelector('#forge-help-lineage')).display !== 'none'"), "Aide opens on tap (no hover needed)")
    page.locator("#forge-lineage .forge-help").click()
    geo = page.evaluate(GEO, "#forge-lineage-tree button, #forge-lineage > summary")
    run.check(geo["sw"] <= geo["vw"] and geo["h"] >= 44, "at 375 px the tree fits with 44 px targets: " + repr(geo))
    run.shot(page, "lineage", "#forge-lineage")
    page.locator("#forge-lineage-tree .forge-lineage-node").first.click()
    run.check(run.until(page, "(src) => document.querySelector('#forge-viewer').open && window.hqForgeHooks.currentDetail() && window.hqForgeHooks.currentDetail().id === src", 10, source),
              "tapping a node opens that image")
    status = page.request.get(run.base + "/api/forge/gallery/pvt-" + "0" * 24 + "/lineage").status
    run.check(status == 404, "a vault id has no lineage: " + repr(status))
    ctx.close()


KEEP_ALL = """async () => { const g = await (await fetch('/api/forge/gallery?limit=48')).json();
  for (const im of g.images) await fetch('/api/forge/gallery/' + im.id + '/triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 'keep' }) });
  return g.images.length; }"""


def section_style(run: Run) -> None:
    print("J3 house style")
    ctx = run.context()
    page = ctx.new_page()
    posts = track(page)
    run.open_forge(page)
    page.locator("#forge-style > summary").click()
    run.check(run.until(page, "() => /Indicatif. Il faut au moins 5 images/.test(document.querySelector('#forge-style-note').textContent)", 5),
              "with too few kept images it says so, labelled Indicatif")
    page.locator("#forge-style > summary").click()
    page.evaluate("() => { document.querySelector('#forge-negative-fold').open = true; }")
    page.locator("#forge-negative").fill("flou, texte")
    for i in range(5):
        generate_once(run, page, f"phare maison {i}")
    kept = page.evaluate(KEEP_ALL)
    run.check(kept == 5, "five images kept: " + repr(kept))
    page.locator("#forge-negative").fill("")
    page.locator("#forge-steps").fill("7")
    model = page.evaluate("() => document.querySelector('#forge-checkpoint').value")
    page.locator("#forge-style > summary").click()
    run.check(run.until(page, "() => /Indicatif, tir/.test(document.querySelector('#forge-style-note').textContent) && !document.querySelector('#forge-style-apply').hidden", 5),
              "the house style is computed from the kept images")
    text = page.evaluate("() => document.querySelector('#forge-style-list').textContent")
    run.check("jamais appliqu" in text and "(5 sur 5)" in text and "flou, texte" in text, "it shows shares, the model as shown-only and the usual negative prompt: " + repr(text[:200]))
    before = [p for p in posts if "jobs" in p or "night" in p]
    page.locator("#forge-style-apply").click()
    run.check(page.evaluate("() => document.querySelector('#forge-steps').value") == "20", "Appliquer fills the steps back from the style")
    run.check(page.evaluate("() => document.querySelector('#forge-checkpoint').value") == model, "the model is never changed")
    run.check("Rien n'est lanc" in page.evaluate("() => document.querySelector('#forge-style-done').textContent"), "it says nothing was started")
    page.locator("#forge-style-negative").click()
    run.check(page.evaluate("() => document.querySelector('#forge-negative').value") == "flou, texte", "the usual negative prompt can be taken back")
    page.wait_for_timeout(400)
    run.check([p for p in posts if "jobs" in p or "night" in p] == before, "applying the style starts nothing")
    geo = page.evaluate(GEO, "#forge-style button, #forge-style > summary")
    run.check(geo["sw"] <= geo["vw"] and geo["h"] >= 44, "at 375 px the style panel fits with 44 px targets: " + repr(geo))
    run.shot(page, "house-style", "#forge-style")
    ctx.close()


def section_couch(run: Run) -> None:
    print("J4 couch mode")
    ctx = run.context()
    page = ctx.new_page()
    reqs = []
    page.on("request", lambda r: reqs.append((r.method, r.url, r.post_data)))
    run.open_forge(page)
    page.evaluate("() => { document.querySelector('#forge-sampling').open = true; }")
    page.locator("#forge-steps").fill("13")
    page.wait_for_timeout(2500)  # let the debounced plan reads settle
    cookies = sorted((c["name"], c["value"], c.get("expires")) for c in ctx.cookies())
    count = len(reqs)
    page.locator("#forge-couch").click()
    page.wait_for_timeout(500)
    run.check(page.evaluate("() => document.querySelector('#forge-studio').classList.contains('is-couch') && document.querySelector('#forge-couch').getAttribute('aria-pressed') === 'true'"), "Mode canape turns on and says so")
    seen = {u.split("?")[0] for _m, u, _b in reqs[:count]}
    extra = [(m, u) for m, u, _b in reqs[count:] if m != "GET" or u.split("?")[0] not in seen]
    run.check(extra == [], "turning it on sends no request of its own (only the page's usual polls): " + repr(extra))
    run.check(sorted((c["name"], c["value"], c.get("expires")) for c in ctx.cookies()) == cookies, "the session cookie is untouched (not extended)")
    hidden = page.evaluate("() => ['forge-sampling', 'forge-advanced', 'forge-presets', 'forge-lab', 'forge-night', 'forge-sweep', 'forge-devices', 'forge-style'].filter((id) => { const e = document.getElementById(id); return e && e.offsetParent !== null; })")
    run.check(hidden == [], "settings panels are hidden: " + repr(hidden))
    geo = page.evaluate("() => { const g = document.querySelector('#forge-generate').getBoundingClientRect(); const p = document.querySelector('#forge-prompt'); return { sw: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, gh: g.height, fs: parseFloat(getComputedStyle(p).fontSize), shown: !!p.offsetParent && !!document.querySelector('#forge-couch').offsetParent, note: !document.querySelector('#forge-couch-note').hidden }; }")
    run.check(geo["sw"] <= geo["vw"] and geo["gh"] >= 56 and geo["fs"] >= 18 and geo["shown"] and geo["note"], "at 375 px: large prompt and Generer, exit button and note shown, no overflow: " + repr(geo))
    store = page.evaluate("() => Object.keys(localStorage).filter((k) => /couch/i.test(k)).map((k) => [k, localStorage.getItem(k)])")
    run.check(store == [["hqForgeCouch", "1"]], "only the on/off choice is remembered on this device: " + repr(store))
    run.shot(page, "couch")
    generate_once(run, page, "phare depuis le canape")
    sent = [json.loads(b) for m, u, b in reqs if m == "POST" and u.endswith("/api/forge/jobs") and b]
    run.check(sent and sent[-1].get("steps") == 13, "hidden settings still apply to the job: steps " + repr(sent[-1].get("steps") if sent else None))
    page.reload()
    run.open_forge(page)
    run.check(page.evaluate("() => document.querySelector('#forge-studio').classList.contains('is-couch')"), "the choice survives a reload on this device")
    page.locator("#forge-couch").click()
    run.check(page.evaluate("() => !document.querySelector('#forge-studio').classList.contains('is-couch') && localStorage.getItem('hqForgeCouch') === null && document.querySelector('#forge-sampling').offsetParent !== null"),
              "Quitter le mode canape restores the full studio")
    anon = run.browser.new_context(viewport={"width": 375, "height": 812})
    apage = anon.new_page()
    apage.add_init_script("localStorage.setItem('hqForgeCouch', '1')")
    apage.goto(run.base + "/")
    status = apage.request.get(run.base + "/api/forge/status").status
    run.check(status == 401, "couch mode never opens Forge without a session: " + repr(status))
    anon.close()
    ctx.close()


SECTIONS = {"bricks": section_bricks, "lineage": section_lineage, "style": section_style, "couch": section_couch}
EXTRA_ENV = {"bricks": {"HQ_FORGE_MOCK_LORAS": json.dumps(LORAS)}}


def main() -> None:
    wanted = sys.argv[1:] or list(SECTIONS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    total = 0
    with sync_playwright() as playwright:
        browser = getattr(playwright, browser_name).launch()
        print("BROWSER", browser_name, browser.version)
        for name in wanted:
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
