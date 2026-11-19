"""Forge generation is refused before dispatch when the gallery quota is full or too small.

Mock Forge only, throwaway server, 375 px. The gallery usage answer is replaced by a
controlled one so the two refusal reasons can be proven without storing 400 images.

    python tests/visual_forge_quota_playwright.py
    FORGE_QUOTA_SHOTS=dir python tests/visual_forge_quota_playwright.py
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from hq_browser_nav import open_section
from visual_forge_quick_wins_playwright import Run, start_server

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    except (AttributeError, ValueError):
        pass

SHOTS = Path(os.environ["FORGE_QUOTA_SHOTS"]) if os.environ.get("FORGE_QUOTA_SHOTS") else None
if SHOTS:
    SHOTS.mkdir(parents=True, exist_ok=True)

GIB = 1024 ** 3
GALLERY = re.compile(r"/api/forge/gallery\?limit=24$")


def open_quiet(run: Run, page) -> None:
    """Open Forge without waiting for Générer: here it must stay disabled."""
    page.goto(run.base + "/")
    open_section(page, "forge")
    if not run.until(page, "() => !!document.querySelector('#forge-checkpoint') && !!document.querySelector('#forge-checkpoint').value", 20):
        raise SystemExit("FAIL: Forge Studio did not load its catalogue")
    run.until(page, "() => !!document.querySelector('#forge-gallery-usage')", 5)


def iter_count(page, count: int) -> None:
    page.evaluate(
        """(value) => {
            const field = document.querySelector('#forge-iter');
            field.value = String(value);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
        }""",
        count,
    )


def main() -> int:
    proc, info = start_server()
    state = {"usage": {"images": 4, "quota_images": 4, "bytes": 0, "quota_bytes": 2 * GIB}}
    errors: list[str] = []
    passed = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            run = Run(browser, info)
            ctx = run.context()
            page = ctx.new_page()
            page.on("pageerror", lambda exc: errors.append("pageerror " + str(exc)))

            def usage(route):
                route.fulfill(
                    status=200,
                    headers={"content-type": "application/json", "cache-control": "no-store"},
                    body=json.dumps({"images": [], "next_cursor": None, "usage": state["usage"]}),
                )

            ctx.route(GALLERY, usage)

            print("gallery full (400 / 400 images)")
            open_quiet(run, page)
            run.check(run.until(page, "() => /galerie est pleine/.test(document.querySelector('#forge-generate-reason').textContent)", 10),
                      "the reason says the gallery is full")
            run.check(page.locator("#forge-generate").is_disabled(), "Générer is disabled on a full gallery")
            run.check("Corbeille" in page.locator("#forge-generate-reason").inner_text(),
                      "the reason points at the bin / backup")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "forge-quota-full.png"))
            passed += 3

            print("gallery full by bytes (0 / 4 images, 2 GiB used)")
            state["usage"] = {"images": 0, "quota_images": 4, "bytes": 2 * GIB, "quota_bytes": 2 * GIB}
            page.reload()
            open_section(page, "forge")
            run.check(run.until(page, "() => /galerie est pleine/.test(document.querySelector('#forge-generate-reason').textContent)", 15),
                      "a byte-full gallery uses the same full reason")
            run.check(page.locator("#forge-generate").is_disabled(), "Générer is disabled when the bytes are used up")
            passed += 2

            print("one slot left, two images asked")
            state["usage"] = {"images": 3, "quota_images": 4, "bytes": 0, "quota_bytes": 2 * GIB}
            page.reload()
            open_section(page, "forge")
            run.until(page, "() => !!document.querySelector('#forge-checkpoint')?.value", 15)
            iter_count(page, 2)
            run.check(run.until(page, "() => /1 place\\(s\\) restante\\(s\\) pour 2 image\\(s\\)/.test(document.querySelector('#forge-generate-reason').textContent)", 10),
                      "the reason states the remaining slots and the batch size")
            run.check(page.locator("#forge-generate").is_disabled(), "Générer is disabled for a batch larger than the room left")
            if SHOTS:
                page.screenshot(path=str(SHOTS / "forge-quota-short.png"))
            passed += 2

            print("two slots left, two images asked")
            state["usage"] = {"images": 2, "quota_images": 4, "bytes": 0, "quota_bytes": 2 * GIB}
            page.reload()
            open_section(page, "forge")
            run.check(run.until(page, "() => !!document.querySelector('#forge-checkpoint')?.value && !!document.querySelector('#forge-sampler')?.value", 15),
                      "Forge is ready again")
            iter_count(page, 2)
            run.check(run.until(page, "() => !document.querySelector('#forge-generate').disabled", 10),
                      "Générer is enabled when the batch fits the remaining slots")
            run.check(page.locator("#forge-generate-reason").inner_text().strip() == "",
                      "no quota reason is shown when the batch fits")
            passed += 2

            ctx.close()
            browser.close()
    finally:
        proc.terminate()

    if errors:
        print("page errors:", *errors, sep="\n - ")
    print(f"{passed} checks passed")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
