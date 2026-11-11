"""Navigation into Repas and Budget. No production bridge and no Household database."""

from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
PAGE = HERE / "fixtures" / "household_nav.html"
SHOTS = Path(os.environ["HQ_SHOTS"]) if os.environ.get("HQ_SHOTS") else HERE / "_household_nav_shots"


def main() -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        try:
            for name, width in (("desktop", 1280), ("phone", 390)):
                page = browser.new_page(viewport={"width": width, "height": 900})
                page.goto(PAGE.as_uri() + "?household=missing#budget")
                page.locator("#hq-budget-app[data-state='error']").wait_for()
                assert "n'est pas activé" in page.locator("#hq-budget-app").inner_text()
                assert page.evaluate("hqHouseholdPosts") == 0
                page.locator("#hq-budget-app").get_by_role("button", name="Réessayer").click()
                page.wait_for_timeout(50)
                assert page.evaluate("hqHouseholdPosts") == 0
                page.locator("[data-nav='repas']").focus()
                page.keyboard.press("Enter")
                page.locator("#hq-repas-app[data-state='error']").wait_for()
                assert page.evaluate("document.body.dataset.view") == "repas"
                assert page.evaluate("hqHouseholdPosts") == 0
                page.locator("[data-nav='forge']").click()
                assert page.locator("#forge-copy").is_visible()
                assert page.evaluate("document.getElementById('hq-repas-app').childElementCount") == 0
                assert page.evaluate("hqForgeShows") == 1
                page.go_back()
                page.locator("#hq-repas-app[data-state='error']").wait_for()
                page.go_forward()
                assert page.locator("#forge-copy").is_visible()
                page.screenshot(path=str(SHOTS / f"household-nav-{name}.png"), full_page=True)
                page.close()

            ready = browser.new_page(viewport={"width": 1100, "height": 800})
            ready.goto(PAGE.as_uri())
            ready.locator("[data-nav='repas']").click()
            ready.locator("#hq-repas-app[data-state='empty']").wait_for()
            ready.locator("[data-nav='accueil']").click()
            ready.locator("[data-nav='repas']").click()
            ready.locator("#hq-repas-app").get_by_role("button", name="Créer la semaine").click()
            ready.wait_for_timeout(50)
            assert ready.evaluate("hqHouseholdPosts") == 1
            ready.close()

            partial = browser.new_page(viewport={"width": 1100, "height": 800})
            partial.goto(PAGE.as_uri() + "?household=recipe#repas")
            partial.locator("#hq-repas-app[data-state='empty']").wait_for()
            partial.evaluate("hqHouseholdRequest({method:'GET', path:'/api/meals/recipes?id=rcp-0000000000000001'})")
            partial.locator("#hq-repas-app").get_by_role("button", name="Créer la semaine").click()
            partial.wait_for_timeout(50)
            assert partial.evaluate("hqHouseholdPosts") == 1
            partial.locator("[data-nav='budget']").click()
            partial.locator("#hq-budget-app[data-state='ready']").wait_for()
            partial.locator("[data-nav='repas']").click()
            partial.locator("#hq-repas-app").wait_for()
            assert partial.evaluate("document.getElementById('hq-budget-app').childElementCount") == 0
            partial.close()
        finally:
            browser.close()
    print("household navigation rendered")


if __name__ == "__main__":
    main()
