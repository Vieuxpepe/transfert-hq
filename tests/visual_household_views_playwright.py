"""Render the standalone Meal Planner and Budget views. No production bridge."""

from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PAGE = HERE / "fixtures" / "household_views.html"
SHOTS = Path(os.environ["HQ_SHOTS"]) if os.environ.get("HQ_SHOTS") else HERE / "_household_view_shots"


def main() -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    url = PAGE.as_uri()
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for name, width in (("desktop", 1280), ("phone", 390)):
                page = browser.new_page(viewport={"width": width, "height": 1400})
                page.goto(url)
                page.locator("#repas[data-state='ready']").wait_for()
                page.locator("#budget[data-state='ready']").wait_for()
                page.locator("#repas").get_by_role("alert").wait_for(state="hidden")
                assert page.locator("#repas img").count() == 0
                assert "<img src=x onerror=alert(1)>" in page.locator("#repas").inner_text()
                assert "restrictions alimentaires" in page.locator("#repas").inner_text()
                assert "2\u00a0482,00\u00a0$" in page.locator("#budget").inner_text()
                assert "2\u00a0432,00\u00a0$" not in page.locator("#budget").inner_text()
                assert "50,00\u00a0USD" in page.locator("#budget").inner_text()
                assert "25,00\u00a0USD" in page.locator("#budget").inner_text()
                assert page.locator("#budget").get_attribute("data-totals") == "complete"
                assert "non additionné" in page.locator("#budget").inner_text()
                assert page.locator("#hq-budget-correct").is_hidden()
                page.locator("#repas [aria-label='Semaine suivante']").focus()
                assert page.evaluate("document.activeElement.getAttribute('aria-label')") == "Semaine suivante"
                page.keyboard.press("Enter")
                page.locator("#repas[data-state='ready']").wait_for()
                assert "2026-11-16" in page.locator("#hq-meals-title").inner_text()
                page.locator("#repas [aria-label='Semaine précédente']").click()
                page.locator("#repas").get_by_role("gridcell", name="Souper 2026-11-11").click()
                assert "Rincer" in page.locator("#repas").inner_text()
                assert "1,25 g" in page.locator("#repas").inner_text()
                page.locator("#repas").get_by_role("button", name="Préparer la liste").click()
                page.get_by_text("0,25 g").wait_for()
                assert page.locator("#repas").get_by_role("button", name="Enregistrer la liste d'épicerie").count() == 1
                assert page.locator("#repas svg.hq-hh-ico").count() >= 4
                assert page.locator('#repas [data-hh-icon="tomato"]').count() >= 1
                assert page.locator('#repas [data-hh-icon="rice"]').count() >= 1
                page.screenshot(path=str(SHOTS / f"household-views-{name}.png"), full_page=True)
                page.close()
        finally:
            browser.close()
    print("household views rendered")


if __name__ == "__main__":
    main()
