"""Isolated UI regression: journal evidence editing and reply expressions.

Uses a throwaway HQ root and fake provider responses; never touches live memory.
"""
import copy
import json
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent


def main():
    with tempfile.TemporaryDirectory(prefix="hq-character-") as root:
        proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), root],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            info = json.loads(proc.stdout.readline().decode("utf-8"))
            assert not info["base"].endswith(":8765")
            with sync_playwright() as p:
                browser = p.chromium.launch()
                for label, width, reduced, adult in (("desktop", 1440, False, False), ("phone", 390, False, False),
                        ("reduced", 390, True, False), ("portrait", 1440, False, True), ("portrait-phone", 390, False, True)):
                    ctx = browser.new_context(viewport={"width": width, "height": 1000 if width > 400 else 844},
                                              reduced_motion="reduce" if reduced else "no-preference")
                    ctx.add_init_script("localStorage.setItem('hq_companion_collapsed','0');localStorage.setItem('hq_companion_persona','warm')")
                    if adult:
                        ctx.add_init_script("localStorage.setItem('hq_companion_nsfw','1');localStorage.setItem('hq_companion_layered_portrait','1')")
                    page = ctx.new_page()
                    errors, seen = [], []
                    page.on("pageerror", lambda e: errors.append(str(e)))
                    memory = {"ok": True, "revision": 7, "memories": [], "followups": [],
                        "episodes": [{"id": "source-1", "kind": "ritual", "text": "Our ritual is coffee before painting.", "at": 1793520000, "evidence": "user_statement"}],
                        "development": [{"kind": "ritual", "label": "Rituel partagé", "topic": "coffee before painting", "description": "Un clin d'œil facultatif.",
                                         "evidence": "Our ritual is coffee before painting.", "source_ids": ["source-1"], "updated_at": 1793520000, "reinforcement_days": 1}]}

                    def handle(route, request):
                        if request.method == "GET":
                            return route.fulfill(json={"ok": True, "configured": True, "companion_cap": "flirt", "nsfw_allowed": adult, "personality": {}, "models": []})
                        body = json.loads(request.post_data or "{}")
                        seen.append(body)
                        op = body.get("op")
                        if op in {"personality", "context_preview"}:
                            return route.continue_()  # Real local assembler; still no model generation.
                        if op == "memory":
                            return route.fulfill(json=copy.deepcopy(memory))
                        if op == "episode_correct":
                            assert body["revision"] == 7
                            if body["text"].startswith("Imagine"):
                                return route.fulfill(status=400, json={"error": "Une déclaration explicite est requise"})
                            memory["revision"] += 1
                            memory["episodes"][0]["text"] = body["text"]
                            memory["development"][0].update(topic="tea before painting", evidence=body["text"])
                            return route.fulfill(json=copy.deepcopy(memory))
                        if op == "memory_forget":
                            memory.update(episodes=[], development=[])
                            return route.fulfill(json=copy.deepcopy(memory))
                        if op == "send":
                            return route.fulfill(json={"ok": True, "reply": "Une intuition, puis une réserve : regardons le détail.",
                                "expression": {"primary": "curiosity", "secondary": "thoughtful", "voice": "thoughtful"},
                                "context_usage": {"conversation_mode": "social"}})
                        if body.get("action") == "ambient":
                            return route.fulfill(json={"ok": True, "line": "Un détail intéressant.", "mood": {"soft": .5, "warm": .4}})
                        return route.fulfill(json={"ok": True, "messages": [], "prefs": {}, "mood": {"soft": .5, "warm": .4}})

                    page.route("**/api/ai**", handle)
                    page.goto(info["base"])
                    page.locator('input[name="pin"]').fill(info["admin_pin"])
                    page.locator('button[type="submit"]').click()
                    # Journal controls live in a continuously swaying bubble.
                    # Stabilize that panel only; portrait physics stays active.
                    page.add_style_tag(content=".hq-companion-bubble{animation:none!important}")
                    page.locator(".hq-companion-open-chat").click()
                    page.locator('button[data-icon="edit"]').click()
                    editor = page.locator('#hq-companion-editor')
                    editor.locator('textarea').first.wait_for()
                    editor.get_by_role('button', name='Contexte API', exact=True).click()
                    editor.get_by_role('button', name='Préparer l’aperçu sans envoyer', exact=True).click()
                    editor.get_by_text('Pourquoi ces sections sont incluses ou omises', exact=True).click()
                    selection = editor.locator('.hq-companion-context-selection')
                    selection.wait_for()
                    assert selection.get_by_role('cell', name='Protégé', exact=True).count() == 2
                    editor.get_by_role('button', name='Fermer l’éditeur', exact=True).click()
                    page.locator('button[data-icon="memory"]').click()
                    panel = page.locator(".hq-companion-memory-panel")
                    panel.get_by_role("heading", name="Journal de caractère").wait_for()
                    panel.locator("summary").click()
                    panel.get_by_role("button", name="Corriger ce moment").click()
                    panel.get_by_label("Correction du moment source").fill("Imagine our ritual is tea.")
                    panel.get_by_role("button", name="Enregistrer la correction").click()
                    panel.get_by_role("alert").wait_for()
                    assert panel.get_by_label("Correction du moment source").input_value() == "Imagine our ritual is tea."
                    panel.get_by_label("Correction du moment source").fill("Our ritual is tea before painting.")
                    panel.get_by_role("button", name="Annuler", exact=True).click()
                    panel.get_by_role("button", name="Corriger ce moment").click()
                    panel.get_by_label("Correction du moment source").fill("Our ritual is tea before painting.")
                    panel.get_by_role("button", name="Enregistrer la correction").click()
                    panel.get_by_text("tea before painting", exact=False).first.wait_for()
                    panel.locator("summary").click()
                    panel.get_by_role("button", name="Retirer ce moment").click()
                    panel.get_by_text("Les expériences, intérêts et rituels partagés feront apparaître des repères ici.").wait_for()
                    page.locator('button[data-icon="memory"]').click()
                    page.locator(".hq-companion-input").fill("Why are leaves shaped this way?")
                    page.locator(".hq-companion-send").click()
                    page.locator("#hq-companion:not(.hq-companion-chat-busy)").wait_for(state="attached")
                    assert any(b.get("op") == "send" for b in seen)
                    if adult:
                        page.wait_for_selector(".has-layered-portrait")
                        assert page.locator('img.hq-companion-rig-hair-base').evaluate('(e)=>e.complete&&e.naturalHeight===1354')
                        assert page.locator('.hq-companion-rig-body').evaluate('(e)=>getComputedStyle(e).scale') == '1.17'
                        assert abs(float(page.locator('.hq-companion-frame.is-in-rig').evaluate('(e)=>getComputedStyle(e).scale')) * 1.17 - 1) < .00001
                        page.screenshot(path=str(HERE.parent / 'artifacts' / ('companion-body-size-' + label + '.png')))
                        box = page.locator('.hq-companion-avatar').bounding_box()
                        x, y = box['x']+box['width']*.35, box['y']+box['height']*.72
                        page.mouse.move(x, y)
                        page.mouse.down()
                        page.mouse.move(x-20, y-25, steps=8)
                        assert page.locator('#hq-companion').evaluate('(e)=>e.classList.contains("is-bust-pull")')
                        assert page.locator('img.hq-companion-rig-hair-left').evaluate('(e)=>getComputedStyle(e).transform') == 'none'
                        assert page.locator('.hq-companion-rig-hair-sheen').count() == 2
                        assert page.locator('.hq-companion-rig-hair-sheen').evaluate_all('(els)=>els.every(e=>getComputedStyle(e).transform==="none" && getComputedStyle(e).pointerEvents==="none")')
                        assert page.locator('#hq-companion').evaluate('(e)=>e.style.getPropertyValue("--rig-head-sway")') == ''
                        page.mouse.up()
                    assert not errors, errors
                    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                    print(label + ": real prompt inspector, journal edits, reply plan and no browser errors passed", flush=True)
                    ctx.close()
                browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=10)


if __name__ == "__main__":
    main()
