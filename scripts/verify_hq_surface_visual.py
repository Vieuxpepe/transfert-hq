#!/usr/bin/env python3
"""Cross-view visual surface check.

Walks the five working pages at every review width in both schemes, captures a full-page image,
and flags clipped text, off-viewport fixed controls and companion-chip collisions. Pass
--screenshots to write the images under .tmp/hq-surface/ (local artefacts, not app files).
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import expect, sync_playwright  # noqa: E402
from tests.test_hq_robotics_http import ADMIN, fixture  # noqa: E402
from tests.test_hq_diagnostics_http import Client  # noqa: E402
import iphone_bridge as bridge  # noqa: E402
from scripts.verify_robotics_visual import ENSURE_ALERT_JS  # noqa: E402

WIDTHS = (380, 430, 540, 620, 700, 768, 900, 1024, 1440)
# view -> (selector, settle ms, readiness) where readiness is "visible" or "enabled"
VIEWS = {
    "carnet": ("[data-panel='carnet']", 2200, "visible"),
    "forge": ("#forge-studio", 2400, "visible"),
    "repas": ("#hq-repas-app[data-state]", 1400, "visible"),
    "intime": ("#hq-intime-panel", 2000, "visible"),
    # The arm lives in the Pilotage card, which section mode hides on first open.
    "robotique": ("[data-rb='arm']", 1400, "enabled"),
}

# Text that is deliberately shortened by its own control (line clamps, ellipsis) is not a defect.
CLIP_SCAN_JS = r"""
() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (el.closest('[hidden], .visually-hidden, [aria-hidden="true"]')) continue;
    if (['INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'CANVAS', 'SVG', 'IMG'].includes(el.tagName)) continue;
    const text = (el.innerText || '').trim();
    if (!text || el.childElementCount > 1) continue;
    const clips = ['hidden', 'clip'].includes(cs.overflowX) || ['hidden', 'clip'].includes(cs.overflowY);
    if (!clips || cs.textOverflow === 'ellipsis') continue;
    if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1) continue;
    out.push({
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        + (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 3).join('.') : ''),
      text: text.replace(/\s+/g, ' ').slice(0, 90),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
      over: [el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight],
    });
  }
  return out.slice(0, 25);
}
"""

OFF_VIEWPORT_JS = r"""
() => {
  const out = [];
  for (const el of document.querySelectorAll('button, a, input, select, textarea, summary, [role="button"]')) {
    const cs = getComputedStyle(el);
    if (!['fixed', 'absolute', 'sticky'].includes(cs.position)) continue;
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (el.closest('[hidden], .visually-hidden, .skip-link')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (r.right <= innerWidth + 1 && r.left >= -1) continue;
    out.push({
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        + (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 3).join('.') : ''),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    });
  }
  return out.slice(0, 20);
}
"""

IN_FLOW_WIDE_JS = r"""
() => {
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (!['static', 'relative'].includes(cs.position)) continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (el.closest('[hidden], .visually-hidden')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.right <= innerWidth + 1) continue;
    // Ignore content that a scrolling ancestor intentionally keeps out of view.
    let clipped = false;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const parent = getComputedStyle(node);
      if (['hidden', 'clip', 'auto', 'scroll'].includes(parent.overflowX)) { clipped = true; break; }
    }
    if (clipped) continue;
    out.push({
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '')
        + (el.className ? '.' + String(el.className).trim().split(/\s+/).slice(0, 3).join('.') : ''),
      box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
    });
  }
  return out.slice(0, 15);
}
"""

COMPANION_JS = r"""
() => {
  const shown = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > .01
      && r.width > 8 && r.height > 8;
  };
  const leaves = [...document.querySelectorAll(
      '[class*="-chip-dock"], .hq-else-toggle, .rb-ai .rb-ai-chip')].filter(shown);
  const whisper = [...document.querySelectorAll('.hq-securia-whisper')].find(shown);
  // A user-dragged companion chip (is-floated) is allowed to sit at the edge: its drag clamp
  // keeps a usable part on-screen, so require that part instead of the whole rect. Every control
  // in its default docked state still has to fit entirely.
  const box = (el) => {
    const r = el.getBoundingClientRect();
    const host = el.closest('.is-floated') || el;
    const floated = host.classList.contains('is-floated');
    const visible = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
    return {
      label: String(el.id || el.className || el.tagName).slice(0, 70),
      rect: [r.left, r.top, r.right, r.bottom],
      floated,
      inView: floated
        ? visible >= 24 && r.bottom > 0 && r.top < innerHeight
        : r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
    };
  };
  return {
    chips: leaves.map(box),
    whisper: whisper ? box(whisper) : null,
    docWidth: document.documentElement.scrollWidth,
    viewWidth: innerWidth,
  };
}
"""


BUBBLE_JS = r"""
() => {
  let contentRight = 0;
  document.querySelectorAll('main.wrap').forEach((wrap) => {
    const wr = wrap.getBoundingClientRect();
    if (!wr.width) return;
    const cs = getComputedStyle(wrap);
    contentRight = Math.max(contentRight, wr.right - parseFloat(cs.paddingRight || 0));
  });
  if (!contentRight) return null;
  const bubble = document.querySelector('.hq-companion-bubble');
  const root = document.querySelector('.hq-companion');
  if (!bubble || !root) return {skipped: true};
  const rootStyle = root.getAttribute('style') || '';
  const bubbleStyle = bubble.getAttribute('style') || '';
  // An expanded chat is a user-opened panel; this check is about the speech bubble.
  const wasExpanded = root.classList.contains('is-expanded');
  if (wasExpanded) root.classList.remove('is-expanded');
  // Views such as Intime dock the companion in the reading flow; an in-flow bubble is part of
  // the page layout and cannot overlay it. Only floating companions are checked.
  const floating = ['fixed', 'absolute'].includes(getComputedStyle(root).position);
  if (!floating) {
    if (wasExpanded) root.classList.add('is-expanded');
    return {skipped: true};
  }
  // A minimal companion hides the bubble with !important; force it for the measurement.
  root.style.setProperty('display', 'flex', 'important');
  root.style.setProperty('visibility', 'visible', 'important');
  root.style.setProperty('opacity', '1', 'important');
  bubble.style.setProperty('display', 'flex', 'important');
  bubble.style.setProperty('visibility', 'visible', 'important');
  bubble.style.setProperty('opacity', '1', 'important');
  // Pull/drag effects scale the bubble visually; measure its resting footprint.
  bubble.style.setProperty('transform', 'none', 'important');
  bubble.style.setProperty('scale', '1', 'important');
  bubble.style.setProperty('translate', 'none', 'important');
  const line = bubble.querySelector('.hq-companion-line');
  if (line && !line.textContent.trim()) {
    line.textContent = 'Bulles de contrôle : le compagnon reste dans sa voie réservée à droite.';
  }
  const r = bubble.getBoundingClientRect();
  const out = {left: r.left, right: r.right, contentRight, width: r.width,
               clear: r.width > 0 && r.left >= contentRight - 1};
  if (rootStyle) root.setAttribute('style', rootStyle); else root.removeAttribute('style');
  if (bubbleStyle) bubble.setAttribute('style', bubbleStyle); else bubble.removeAttribute('style');
  if (wasExpanded) root.classList.add('is-expanded');
  return out;
}
"""


def intersects(a, b, slack=1.0):
    return (min(a[2], b[2]) - max(a[0], b[0]) > slack
            and min(a[3], b[3]) - max(a[1], b[1]) > slack)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshots", action="store_true")
    parser.add_argument("--views", default=",".join(VIEWS))
    parser.add_argument("--widths", default=",".join(str(width) for width in WIDTHS))
    args = parser.parse_args()
    views = [view.strip() for view in args.views.split(",") if view.strip()]
    widths = [int(width) for width in args.widths.split(",") if width.strip()]
    checks = 0
    problems: list[str] = []
    clips: list[dict] = []
    offscreen: list[dict] = []

    def check(condition, label):
        nonlocal checks
        checks += 1
        if not condition:
            problems.append(label)
            print("  FAIL", label)
        else:
            print("  OK", label)

    with fixture() as (base, _lab), sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        admin = Client(base, ADMIN)
        for scheme in ("light", "dark"):
            for width in widths:
                height = 900 if width <= 1024 else 960
                context = browser.new_context(
                    viewport={"width": width, "height": height}, device_scale_factor=1,
                    color_scheme=scheme, is_mobile=width <= 620, has_touch=width <= 620)
                page = context.new_page()
                # Ambient companion visits dim the whole page for several seconds (z 1300). They are a
                # separate feature, so keep them out of the layout review instead of photographing a veil.
                page.route("**/hq-assistant-visits.js*", lambda route: route.abort())
                errors: list[str] = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                page.context.add_cookies([{"name": bridge.COOKIE_NAME,
                                           "value": admin.token, "url": base}])
                page.goto(base + "/#accueil", wait_until="domcontentloaded")
                expect(page.locator("#main")).to_be_visible(timeout=15000)
                for view in views:
                    selector, settle, readiness = VIEWS[view]
                    page.evaluate("(v) => { if (window.setView) setView(v); else location.hash = '#' + v; }", view)
                    expect(page.locator("body")).to_have_attribute("data-view", view, timeout=20000)
                    try:
                        ready = page.locator(selector).first
                        if readiness == "enabled":
                            expect(ready).to_be_enabled(timeout=15000)
                        else:
                            expect(ready).to_be_visible(timeout=15000)
                    except AssertionError:
                        check(False, f"{view} {scheme} {width}px: the page rendered its panel")
                    page.wait_for_timeout(settle)
                    page.evaluate("() => window.scrollTo(0, 0)")
                    page.wait_for_timeout(150)
                    if args.screenshots:
                        target = ROOT / ".tmp" / "hq-surface"
                        target.mkdir(parents=True, exist_ok=True)
                        # A full-page capture resizes the viewport, which re-triggers reveal
                        # transitions and photographs them half-faded. Freeze them at their end state.
                        page.add_style_tag(content="*,*::before,*::after"
                                           "{animation:none !important;transition:none !important}")
                        # View changes fade through the Web Animations API, which animation:none
                        # does not stop: finish those so a capture is never taken mid-fade.
                        page.evaluate("() => document.getAnimations().forEach((a) => {"
                                      " try { a.finish(); } catch (_) { a.cancel(); } })")
                        page.wait_for_timeout(250)
                        page.screenshot(path=str(target / f"{view}-{width}-{scheme}.png"),
                                        full_page=True)
                    tag = f"{view} {scheme} {width}px"
                    width_state = page.evaluate(COMPANION_JS)
                    wide = page.evaluate(IN_FLOW_WIDE_JS)
                    check(width_state["docWidth"] <= width_state["viewWidth"] + 1,
                          f"{tag}: no horizontal page overflow"
                          f" (doc {width_state['docWidth']} vs {width_state['viewWidth']})"
                          + ("" if not wide else f" — {wide[:3]}"))
                    bubble = page.evaluate(BUBBLE_JS)
                    if bubble and not bubble.get("skipped"):
                        check(bubble["clear"],
                              f"{tag}: a displayed speech bubble stays clear of the page"
                              f" (left {round(bubble['left'])} vs content"
                              f" {round(bubble['contentRight'])})")
                    found = page.evaluate(CLIP_SCAN_JS)
                    for item in found:
                        clips.append({"page": tag, **item})
                    off = page.evaluate(OFF_VIEWPORT_JS)
                    for item in off:
                        offscreen.append({"page": tag, **item})

                # Second pass: a real alert layer over each page, for chip geometry.
                for view in views:
                    selector, _settle, readiness = VIEWS[view]
                    page.evaluate("(v) => { if (window.setView) setView(v); else location.hash = '#' + v; }", view)
                    expect(page.locator("body")).to_have_attribute("data-view", view, timeout=20000)
                    ready = page.locator(selector).first
                    if readiness == "enabled":
                        expect(ready).to_be_enabled(timeout=15000)
                    else:
                        expect(ready).to_be_visible(timeout=15000)
                    page.evaluate(ENSURE_ALERT_JS)
                    page.wait_for_timeout(450)
                    state = page.evaluate(COMPANION_JS)
                    tag = f"{view} {scheme} {width}px alert"
                    for chip in state["chips"]:
                        check(chip["inView"], f"{tag}: {chip['label']} stays inside the viewport")
                    for index, first in enumerate(state["chips"]):
                        for second in state["chips"][index + 1:]:
                            check(not intersects(first["rect"], second["rect"]),
                                  f"{tag}: {first['label']} and {second['label']} do not overlap")
                    if state["whisper"]:
                        check(state["whisper"]["inView"], f"{tag}: the alert bubble stays readable")
                        for chip in state["chips"]:
                            check(not intersects(state["whisper"]["rect"], chip["rect"]),
                                  f"{tag}: the alert bubble clears {chip['label']}")
                check(not errors, f"{scheme} {width}px: no page errors"
                      + ("" if not errors else f" — {errors[:2]}"))
                context.close()

        if args.screenshots:
            report = ROOT / ".tmp" / "hq-surface" / "report.json"
            report.write_text(json.dumps({"clipped": clips, "offscreen": offscreen},
                                         ensure_ascii=False, indent=1), encoding="utf-8")
            print(f"  screenshots + report: {report.parent}")
            if clips:
                print(f"  clipped text candidates: {len(clips)}")
                for item in clips[:12]:
                    print(f"    {item['page']}: {item['sel']} over={item['over']} “{item['text'][:60]}”")
            if offscreen:
                print(f"  off-viewport fixed/absolute controls: {len(offscreen)}")
                for item in offscreen[:12]:
                    print(f"    {item['page']}: {item['sel']} {item['box']}")
        browser.close()

    if problems:
        print(f"verify_hq_surface_visual: FAILED ({len(problems)} of {checks} checks)")
        return 1
    print(f"verify_hq_surface_visual: OK ({checks} checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
