"""The assistant panel in a browser (phone 390 px, desktop 1440 px): the sparkle button opens it, Demander shows
an answer with source chips that lead to the page, Noter shows proposals to tick, Enregistrer reports what was
done, Escape closes, no sideways scroll, no page errors. Gemini is faked by intercepting /api/ai.

FORGE_BROWSER=chromium|webkit HQ_SHOTS=dir python tests/visual_hq_ai_playwright.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PROD_PORTS = (":8765", ":8766", ":8776", ":7860")
SHOTS = Path(os.environ["HQ_SHOTS"]) if os.environ.get("HQ_SHOTS") else None
passed = 0

STATUS = {"ok": True, "configured": True, "models": [
    {"id": "gemini-3.1-flash-lite", "label": "Gemini 3.1 Flash Lite", "per_day": 500, "used": 12},
    {"id": "gemma-4-26b-a4b-it", "label": "Gemma 4 26B", "per_day": 14400, "used": 3}]}
ASK = {"ok": True, "model": "gemini-3.1-flash-lite", "model_label": "Gemini 3.1 Flash Lite",
       "answer": "Cette semaine tu as **le labo GIA1077** jeudi [1].\n- Imprimer la base du bras [2]\n- Racheter des vis M3 [3]",
       "sources": [{"n": 1, "kind": "event", "label": "Labo GIA1077 · jeu. 14:00", "href": "#calendrier"},
                   {"n": 2, "kind": "project", "label": "Bras robot", "href": "#projets"},
                   {"n": 3, "kind": "item", "label": "Vis M3 x 10", "href": "#inventaire"}], "cited": [1, 2, 3]}
CAPTURE = {"ok": True, "model": "gemma-4-26b-a4b-it", "reply": "Deux choses à noter.", "refused": [], "proposals": [
    {"kind": "event", "title": "Dentiste", "start": "2026-11-03T15:00", "end": "2026-11-03T16:00", "all_day": False,
     "category": "appointment", "label": "Événement · Dentiste · 2026-11-03 15:00–16:00"},
    {"kind": "task", "title": "Imprimer un support", "project": None, "due": None, "label": "Tâche · Imprimer un support · Tâches libres"}]}


def check(cond: bool, message: str) -> None:
    global passed
    if not cond:
        raise SystemExit("FAIL: " + message)
    passed += 1
    print("  OK  ", message)


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-ai-"))
    proc = subprocess.Popen([sys.executable, str(HERE / "carnet_test_server.py"), str(root)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    info = json.loads(proc.stdout.readline().decode("utf-8"))
    base = info["base"]
    assert base.startswith("http://127.0.0.1:") and not base.endswith(PROD_PORTS)
    browser_name = os.environ.get("FORGE_BROWSER", "chromium")
    try:
        with sync_playwright() as p:
            browser = getattr(p, browser_name).launch()
            for label, viewport in (("phone", {"width": 390, "height": 844}), ("desktop", {"width": 1440, "height": 900})):
                print(f"[{label}]")
                ctx = browser.new_context(viewport=viewport, bypass_csp=True)
                page = ctx.new_page()
                errors: list[str] = []
                page.on("pageerror", lambda e: errors.append(str(e)))
                applied: list = []

                def handle(route, request):
                    if request.method == "GET":
                        return route.fulfill(json=STATUS)
                    body = json.loads(request.post_data or "{}")
                    if body.get("action") == "ask":
                        return route.fulfill(json=ASK)
                    if body.get("action") == "capture":
                        return route.fulfill(json=CAPTURE)
                    applied.append(body)
                    return route.fulfill(json={"ok": True, "done": [{"label": x["label"], "href": "#calendrier"} for x in body["proposals"]], "failed": []})
                page.route("**/api/ai**", handle)
                page.goto(base + "/")
                page.fill('input[name="pin"]', info["admin_pin"])
                page.click('button[type="submit"]')
                page.wait_for_load_state("networkidle")

                check(page.locator("#btn-ai").is_visible(), "the sparkle button is in the toolbar")
                page.click("#btn-ai")
                panel = page.locator(".ai-panel")
                panel.wait_for(state="visible")
                check(True, "it opens the panel")
                page.locator(".ai-panel textarea").first.fill("Qu'est-ce que j'ai cette semaine ?")
                page.keyboard.press("Enter")
                page.wait_for_selector(".ai-panel .ai-sources .ai-ref", timeout=8000)
                chips = page.locator(".ai-panel .ai-sources .ai-ref").count()
                check(chips >= 3, f"the answer cites its sources ({chips} chips)")
                check("labo GIA1077" in panel.inner_text(), "the answer is shown")
                check(page.locator(".ai-panel strong").count() >= 1, "bold is rendered, not shown as **")
                page.wait_for_timeout(500)
                if SHOTS:
                    SHOTS.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(SHOTS / f"{browser_name}-ai-{label}-ask.png"))

                page.get_by_role("tab", name="Noter").click()
                page.locator(".ai-panel textarea").last.fill("Dentiste mardi 15h et imprimer un support")
                page.get_by_role("button", name="Comprendre").click()
                page.wait_for_selector(".ai-panel .ai-card", timeout=8000)
                check(page.locator(".ai-panel .ai-card").count() == 2, "one sentence becomes two proposals")
                check(applied == [], "nothing is written before Enregistrer")
                page.wait_for_timeout(500)
                if SHOTS:
                    page.screenshot(path=str(SHOTS / f"{browser_name}-ai-{label}-capture.png"))
                page.get_by_role("button", name="Enregistrer").click()
                page.wait_for_timeout(600)
                check(len(applied) == 1 and len(applied[0]["proposals"]) == 2, "Enregistrer sends the ticked proposals")
                check("Ouvrir" in panel.inner_text(), "what was done can be opened")

                check(page.evaluate("() => document.documentElement.scrollWidth <= innerWidth"), "no sideways scroll")
                page.keyboard.press("Escape")
                page.wait_for_timeout(500)
                check(not panel.is_visible(), "Escape closes it")
                check(errors == [], f"no page errors {errors}")
                ctx.close()
            browser.close()
    finally:
        proc.terminate()
    print(f"visual_hq_ai: {passed} checks ok")


if __name__ == "__main__":
    main()
