#!/usr/bin/env python3
"""Responsive and accessibility smoke for the Robotique view.

This is intentionally a check, not a pixel-perfect reference image. Pass
--screenshots to write review images under .tmp/robotique-visual/; those files
are local artefacts and are not part of the app.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import expect, sync_playwright  # noqa: E402
from tests.test_hq_robotics_http import ADMIN, fixture  # noqa: E402
from tests.test_hq_diagnostics_http import Client  # noqa: E402
import iphone_bridge as bridge  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshots", action="store_true")
    args = parser.parse_args()
    checks = 0

    def check(condition, label):
        nonlocal checks
        checks += 1
        if not condition:
            raise AssertionError(label)
        print("  OK", label)

    with fixture() as (base, _lab), sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        admin = Client(base, ADMIN)
        for width, height, mobile in ((360, 810, True), (620, 900, False), (1440, 960, False)):
            page = browser.new_page(viewport={"width": width, "height": height},
                                    is_mobile=mobile, has_touch=mobile)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.context.add_cookies([{"name": bridge.COOKIE_NAME,
                                       "value": admin.token, "url": base}])
            page.goto(base + "/#robotique", wait_until="domcontentloaded")
            expect(page.locator('[data-rb="arm"]')).to_be_enabled(timeout=15000)
            expect(page.locator('[data-rb="estop"]')).to_be_visible()
            expect(page.locator('[data-rb="load-alert"]')).to_be_visible()
            widths = page.evaluate("({scroll: document.documentElement.scrollWidth, inner: innerWidth})")
            check(widths["scroll"] <= widths["inner"], f"{width}px: no horizontal overflow")
            check(not errors, f"{width}px: no page errors")
            duplicates = page.evaluate("""() => {
              const hooks = [...document.querySelectorAll('[data-rb]')].map(el => el.dataset.rb);
              const ids = [...document.querySelectorAll('[id]')].map(el => el.id);
              return { hooks: hooks.filter((v, i) => hooks.indexOf(v) !== i),
                       ids: ids.filter((v, i) => ids.indexOf(v) !== i) };
            }""")
            check(not duplicates["hooks"] and not duplicates["ids"],
                  f"{width}px: no duplicate hooks or IDs")
            is_mobile = width <= 620
            check(page.locator(".rb-section-nav").is_visible() == is_mobile,
                  f"{width}px: mobile section navigation visibility")
            check(page.locator('[data-rb="keepout"]').count() == 1,
                  f"{width}px: keep-out editor present")
            check(page.locator('[data-rb="routines"]').count() == 1,
                  f"{width}px: routines selector present")
            if args.screenshots:
                target = ROOT / ".tmp" / "robotique-visual"
                target.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(target / f"robotique-{width}.png"), full_page=True)
            page.close()

        # Light scheme must redraw the XY plot without a page error.
        page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.context.add_cookies([{"name": bridge.COOKIE_NAME, "value": admin.token, "url": base}])
        page.emulate_media(color_scheme="light")
        page.goto(base + "/#robotique", wait_until="domcontentloaded")
        expect(page.locator('[data-rb="arm"]')).to_be_enabled(timeout=15000)
        page.locator('[data-monitor="position"]').click()
        check(page.locator('[data-rb="plot"]').is_visible(), "light: plot visible")
        check(not errors, "light: no page errors")
        browser.close()

    print(f"verify_robotics_visual: OK ({checks} checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
