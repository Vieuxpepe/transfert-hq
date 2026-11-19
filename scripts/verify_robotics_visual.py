#!/usr/bin/env python3
"""Responsive and accessibility smoke for the Robotique view.

This is intentionally a check, not a pixel-perfect reference image. Pass
--screenshots to write review images under .tmp/robotique-visual/; those files
are local artefacts and are not part of the app.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from playwright.sync_api import expect, sync_playwright  # noqa: E402
from tests.test_hq_robotics_http import ADMIN, fixture  # noqa: E402
from tests.test_hq_diagnostics_http import Client  # noqa: E402
import iphone_bridge as bridge  # noqa: E402


# Colours only the light scheme may use: on a dark panel they fall well under 4.5:1. Each one must sit
# inside its own @media (prefers-color-scheme: light) block, never in the shared rules.
LIGHT_ONLY_COLOURS = (
    "#08724f", "#065c40", "#8b5e00", "#6f4b00", "#8a5a00", "#c27c00", "#a35a00", "#b45309",
    "#b4233d", "#a22035", "#5a40af", "#2b63c7",
)

# Measures a foreground colour against the background actually behind it: ancestors' background
# colours are alpha-composited downward, and every gradient stop of the element counts as a candidate.
CONTRAST_JS = r"""
(args) => {
  const [selector, fgProp, bgSelector] = args;
  const fgEl = document.querySelector(selector);
  const bgEl = bgSelector ? document.querySelector(bgSelector) : fgEl;
  if (!fgEl || !bgEl) return null;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (color) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (top, bottom) => [
    top[0] * top[3] + bottom[0] * (1 - top[3]),
    top[1] * top[3] + bottom[1] * (1 - top[3]),
    top[2] * top[3] + bottom[2] * (1 - top[3]),
  ];
  const lum = (rgb) => {
    const lin = rgb.map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  };
  const ratio = (a, b) => {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const chain = [];
  for (let node = bgEl; node; node = node.parentElement) chain.push(node);
  let base = [255, 255, 255];
  for (const node of chain.reverse()) base = over(paint(getComputedStyle(node).backgroundColor), base);
  const style = getComputedStyle(bgEl);
  const tokens = (style.backgroundImage !== 'none' ? style.backgroundImage : '')
    .match(/(?:rgba?|color)\([^)]*\)|#[0-9a-f]{3,8}/gi) || [];
  const backgrounds = tokens.length ? tokens.map((token) => over(paint(token), base)) : [base];
  const fg = paint(getComputedStyle(fgEl)[fgProp]);
  const worst = Math.min(...backgrounds.map((bg) => ratio(fg, bg)));
  return {
    ratio: worst,
    fg: fg.slice(0, 3).map(Math.round),
    backgrounds: backgrounds.map((bg) => bg.map(Math.round)),
  };
}
"""


# The open chat must outrank the companion chips and their alert whispers (z 1179–1185). The log is
# hit-tested on a grid: every point must land inside the chat, and no fixed body layer may sit above.
CHAT_STACKING_JS = r"""
() => {
  const root = document.querySelector('.rb-ai');
  const chat = document.querySelector('#hq-robotics-chat');
  const z = Number(getComputedStyle(root).zIndex) || 0;
  // Only companion surfaces count: a visit overlay (z 1300) is a separate, intentional full-screen
  // layer that sits above every view, not a chip competing with the chat.
  const above = [...document.body.children]
    .filter((el) => el !== root && !root.contains(el))
    .filter((el) => !el.hidden && getComputedStyle(el).position === 'fixed'
        && getComputedStyle(el).visibility !== 'hidden')
    .filter((el) => el.matches("[class*='-chip-dock'], [class*='-drawer'], .hq-else, .hq-else-toggle, .hq-pistonia"))
    .map((el) => ({ cls: String(el.className || el.id), z: Number(getComputedStyle(el).zIndex) || 0 }))
    .filter((el) => el.z > z && el.z > 100);
  const panel = chat.getBoundingClientRect();
  const points = [];
  for (let i = 1; i <= 7; i += 1) {
    for (let j = 1; j <= 9; j += 1) {
      points.push([panel.left + (panel.width * i) / 8, panel.top + (panel.height * j) / 10]);
    }
  }
  const covered = points.filter(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return !hit || !chat.contains(hit);
  });
  const alerts = [...chat.ownerDocument.querySelectorAll('.hq-securia-whisper')]
    .map((el) => el.getBoundingClientRect());
  const alertPoints = points.filter(([x, y]) => alerts.some(
    (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)).length;
  return { z, above, covered, alertPoints };
}
"""


# With the chat closed the floating chips keep their own stacking, so they must stay whole: inside the
# viewport, not cut by an overflow-clipping ancestor, reachable by a click through the topmost element,
# and clear of Securia's alert whisper.
CLOSED_CHIPS_JS = r"""
() => {
  const shown = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility === 'visible'
      && Number(cs.opacity) >= .99 && r.width > 8 && r.height > 8;
  };
  const clipOf = (el) => {
    let box = { l: 0, t: 0, r: innerWidth, b: innerHeight };
    for (let node = el.parentElement; node; node = node.parentElement) {
      const cs = getComputedStyle(node);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const r = node.getBoundingClientRect();
      box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top),
              r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) };
    }
    return box;
  };
  const chips = [...document.querySelectorAll(
      '.rb-ai .rb-ai-chip, .hq-securia-chip-dock, .hq-culinia-chip-dock, .hq-forgia-chip-dock')]
    .filter(shown);
  const whisper = document.querySelector('.hq-securia-whisper');
  const w = whisper && shown(whisper) ? whisper.getBoundingClientRect() : null;
  const result = chips.map((el) => {
    const r = el.getBoundingClientRect();
    const clip = clipOf(el);
    const misses = [[.5, .5], [.3, .5], [.7, .5]].map(([fx, fy]) => {
      const x = r.left + r.width * fx;
      const y = r.top + r.height * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return null;
      return { x, y, stack: document.elementsFromPoint(x, y).slice(0, 3)
        .map((n) => String(n.id || n.className || n.tagName).slice(0, 50)) };
    }).filter(Boolean);
    return {
      label: String(el.id || el.className || el.tagName).slice(0, 60),
      rect: [r.left, r.top, r.right, r.bottom],
      inView: r.left >= -.5 && r.top >= -.5 && r.right <= innerWidth + .5
        && r.bottom <= innerHeight + .5,
      clipped: r.left < clip.l - .5 || r.top < clip.t - .5
        || r.right > clip.r + .5 || r.bottom > clip.b + .5,
      clickable: misses.length === 0,
      misses,
      underWhisper: !!(w && w.right > r.left + .5 && w.left < r.right - .5
        && w.bottom > r.top + .5 && w.top < r.bottom - .5),
    };
  });
  return {
    rootZ: getComputedStyle(document.querySelector('.rb-ai')).zIndex,
    chatOpen: !document.querySelector('#hq-robotics-chat').hidden,
    chips: result,
  };
}
"""


# Guarantees the previously overlapping case: the fixture's proactive alert is intermittent, so put
# the chip's own whisper markup on its dock (the same element and CSS a real alert produces) and set
# the dock's alert state. The stacking checks then run against a real alert layer, not an empty page.
ENSURE_ALERT_JS = r"""
() => {
  const dock = document.querySelector('.hq-securia-chip-dock');
  if (!dock) return false;
  // A status poll that finds no alert clears has-alert and hides the dock; keep the probe laid out.
  dock.hidden = false;
  dock.style.setProperty('display', 'inline-flex', 'important');
  dock.classList.add('has-alert');
  // The app announces this transition so the chips sharing the rail re-park; the probe must too.
  window.dispatchEvent(new CustomEvent('hq:securia-dock', { detail: { alert: true } }));
  if (!dock.querySelector('.hq-securia-whisper')) {
    const box = document.createElement('div');
    box.className = 'hq-securia-whisper';
    const title = document.createElement('strong');
    title.textContent = 'Securia · Alerte';
    const text = document.createElement('div');
    text.textContent = 'Maître, 15 erreurs serveur 5xx détectées. Un module tousse — viens jeter un œil.';
    box.append(title, text);
    dock.append(box);
  }
  return true;
}
"""


def unguarded_light_colours(paths, colours=LIGHT_ONLY_COLOURS):
    """Declarations that use a light-only colour outside a light-scheme media block."""
    problems = []
    for path in paths:
        text = re.sub(r"/\*.*?\*/", "", Path(path).read_text(encoding="utf-8"), flags=re.S)
        stack: list[str] = []
        buffer = ""
        quote = None
        line = 1
        for char in text:
            if quote:
                if char == quote:
                    quote = None
                buffer += char
                continue
            if char == "\n":
                line += 1
            if char in "\"'":
                quote = char
                buffer += char
            elif char in "{};":
                declaration = buffer.strip().lower()
                hit = next((colour for colour in colours if colour in declaration), None)
                if hit and not any("prefers-color-scheme: light" in frame for frame in stack):
                    problems.append(f"{Path(path).name}:{line} {hit}")
                if char == "{":
                    stack.append(buffer.strip())
                elif char == "}" and stack:
                    stack.pop()
                buffer = ""
            else:
                buffer += char
    return problems


def capture_ui(browser, base, admin, target):
    """Light and dark renders of the Kinétia surfaces at phone, small-desktop and desktop widths."""
    for scheme in ("light", "dark"):
        for width, height in ((430, 900), (1024, 900), (1440, 960)):
            phone = width <= 620
            context = browser.new_context(
                viewport={"width": width, "height": height}, device_scale_factor=2,
                color_scheme=scheme, is_mobile=phone, has_touch=phone)
            page = context.new_page()
            page.context.add_cookies([{"name": bridge.COOKIE_NAME,
                                      "value": admin.token, "url": base}])
            page.goto(base + "/#robotique", wait_until="domcontentloaded")
            expect(page.locator('[data-rb="arm"]')).to_be_enabled(timeout=15000)
            page.evaluate("() => window.scrollTo(0, 0)")
            # The previously overlapping case: a Securia alert whisper sits over the chat position.
            # The fixture raises one intermittently; when it stays quiet, mount the component's own
            # whisper markup on its dock so this screenshot case is still covered.
            whisper = page.locator('.hq-securia-whisper')
            page.wait_for_timeout(2500)
            page.evaluate(ENSURE_ALERT_JS)
            expect(whisper).to_be_visible(timeout=5000)
            page.screenshot(path=str(target / f"closed-{width}-{scheme}.png"))
            # The fixture's status poll can clear the alert while the page shot is written, so
            # re-mount the same whisper right before its close-up.
            page.evaluate(ENSURE_ALERT_JS)
            expect(whisper).to_be_visible(timeout=5000)
            whisper.screenshot(path=str(target / f"alert-{width}-{scheme}.png"))
            # The bar comes first, while « Moniteur » is still the selected chip: on a phone the open
            # chat sheet covers the bar, and switching to the full view clears the selection.
            page.locator('.rb-section-bar').screenshot(path=str(target / f"bar-{width}-{scheme}.png"))

            def chip_clip(name):
                box = page.locator('.rb-ai .rb-ai-chip').bounding_box()
                if not box:
                    return
                pad = 30
                page.screenshot(path=str(target / name), clip={
                    "x": max(0, box["x"] - pad), "y": max(0, box["y"] - pad),
                    "width": box["width"] + pad * 2, "height": box["height"] + pad * 2})

            # The chip's two looks, with the other companions' fixed overlays hidden for the close-up:
            # its portrait, and the glass/glyph fallback used when portraits are off.
            if not phone:
                page.evaluate("""() => {
                    for (const el of document.body.children) {
                        if (el.id === 'hq-robotics-app' || el.classList.contains('rb-ai')) continue;
                        if (getComputedStyle(el).position === 'fixed') {
                            el.dataset.rbShotHidden = '1';
                            el.style.visibility = 'hidden';
                        }
                    }
                }""")
                chip_clip(f"chip-{width}-{scheme}.png")
                page.evaluate("""() => {
                    const img = document.querySelector('.rb-ai .rb-ai-chip img');
                    if (img) { img.dataset.rbShotSrc = img.getAttribute('src') || ''; img.removeAttribute('src'); img.hidden = true; }
                }""")
                page.wait_for_timeout(120)
                chip_clip(f"chip-glass-{width}-{scheme}.png")
                page.evaluate("""() => {
                    const img = document.querySelector('.rb-ai .rb-ai-chip img');
                    if (img && img.dataset.rbShotSrc) { img.src = img.dataset.rbShotSrc; delete img.dataset.rbShotSrc; img.hidden = false; }
                    for (const el of document.body.children) {
                        if (el.dataset.rbShotHidden) { delete el.dataset.rbShotHidden; el.style.visibility = ''; }
                    }
                }""")

            page.locator('[data-rb="section-overview"]').click()
            page.evaluate("() => window.scrollTo(0, 0)")
            if phone:
                page.locator('[data-rb="section-ai"]').tap()
            else:
                page.get_by_role("button", name="Ouvrir Kinétia", exact=True).click()
            chat = page.locator('#hq-robotics-chat')
            expect(chat).to_be_visible(timeout=12000)
            page.wait_for_timeout(900)  # the opening check-in fills both chip rows
            page.screenshot(path=str(target / f"ui-{width}-{scheme}.png"))
            chat.screenshot(path=str(target / f"chat-{width}-{scheme}.png"))
            # The strip is hidden until a real alert. Reveal the app's own markup with representative
            # text for its close-up, after the true-state shots above.
            page.evaluate("""() => {
                const strip = document.querySelector('.rb-copilot');
                if (!strip) return;
                strip.hidden = false;
                // The app hides the strip again while its own alert state is empty; pin it
                // for this product-markup close-up so the capture cannot race that reset.
                strip.style.setProperty('display', 'flex', 'important');
                strip.classList.add('is-alert');
                const text = strip.querySelector('.rb-copilot-text');
                if (text && !text.textContent.trim()) {
                    text.textContent = 'Pince proche de la butée : vérifie le cycle avant de lancer.';
                }
            }""")
            if page.locator('.rb-copilot').first.is_visible():
                page.locator('.rb-copilot').first.screenshot(
                    path=str(target / f"copilot-{width}-{scheme}.png"))
            context.close()


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

    unguarded = unguarded_light_colours(
        [ROOT / "assets/hq-robotics.css", ROOT / "assets/hq-robotics-assistant.css"])
    check(not unguarded, "css: every light-only colour sits inside its light-scheme block"
          + ("" if not unguarded else f" — {unguarded[:3]}"))

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
            # The view opens on one section: the responsive checks below want the whole page.
            expect(page.locator('.rb-workspace > [data-section="camera"]')).to_be_visible(timeout=8000)
            expect(page.locator('.rb-workspace > [data-section="motion"]')).to_be_hidden()
            page.locator('[data-rb="section-overview"]').click()
            expect(page.locator('.rb-workspace > [data-section="motion"]')).to_be_visible()
            expect(page.locator('[data-rb="feedback-state"]')).to_be_visible()
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
            check(page.locator(".rb-section-nav").is_visible(),
                  f"{width}px: section navigation visible")
            check(page.locator('[data-rb="keepout"]').count() == 1,
                  f"{width}px: keep-out editor present")
            check(page.locator('[data-rb="routines"]').count() == 1,
                  f"{width}px: routines selector present")
            if args.screenshots:
                target = ROOT / ".tmp" / "robotique-visual"
                target.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(target / f"robotique-{width}.png"), full_page=True)
            page.close()

        # Editor workflow: auto title, live check without a click, undo, Delete, draft kept across a reload.
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        context.add_cookies([{"name": bridge.COOKIE_NAME, "value": admin.token, "url": base}])
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/#robotique", wait_until="domcontentloaded")
        expect(page.locator('[data-rb="arm"]')).to_be_enabled(timeout=15000)
        page.locator('[data-rb="section-overview"]').click()  # the editor flow needs every card
        rows = lambda: page.locator(".rb-compose-list li").count()
        page.locator('[data-monitor="space"]').click()
        page.locator('[data-rb="compose-toggle"]').click()
        page.locator('[data-rb="compose-add-fields"]').click()
        check(page.locator('[data-rb="compose-title"]').input_value().startswith("Mouvement du"),
              "editor: a title is proposed")
        page.locator("#rb-base").fill("30")
        page.locator('[data-rb="compose-add-fields"]').click()
        check(rows() == 2, "editor: two points")
        expect(page.locator('[data-rb="compose-result"]')).to_contain_text("Vérifié par HQ", timeout=5000)
        check(True, "editor: the script is checked without a click")
        check(page.locator(".rb-compose-xyz").count() == 2, "editor: each point shows its XYZ")
        page.locator("body").click(position={"x": 5, "y": 5})
        page.keyboard.press("Delete")
        check(rows() == 1, "editor: Delete removes the selected point")
        page.locator('[data-rb="compose-undo"]').click()
        check(rows() == 2, "editor: the undo button brings it back")
        page.keyboard.press("Control+z")
        check(rows() == 1, "editor: Ctrl+Z undoes the last added point")
        page.locator('[data-rb="compose-add-fields"]').click()
        check(rows() == 2, "editor: a point can be added again")
        page.wait_for_timeout(700)
        page.reload(wait_until="domcontentloaded")
        expect(page.locator('[data-rb="arm"]')).to_be_enabled(timeout=15000)
        page.locator('[data-monitor="space"]').click()
        page.locator('[data-rb="compose-toggle"]').click()
        check(rows() == 2, "editor: the draft is kept across a reload")
        page.locator('[data-rb="zones-toggle"]').click()
        page.locator('[data-rb="zones-add"]').click()
        page.locator('[data-rb="zones-add"]').click()
        page.locator("body").click(position={"x": 5, "y": 5})
        page.keyboard.press("Delete")
        page.keyboard.press("Control+z")
        check(page.locator(".rb-zone").count() == 2, "zones: Delete then Ctrl+Z restores the zone")
        # A jog rewrites the Pilotage fields: the editor lets go of its point, so a later slider nudge cannot
        # copy the jogged values into it (simulation only).
        page.locator('[data-rb="compose-toggle"]').click()  # the zones panel had closed the editor
        page.locator(".rb-compose-pick").first.click()
        before = page.locator(".rb-compose-pick").first.inner_text()
        page.locator('[data-rb="arm"]').click()
        expect(page.locator('[data-step="base"][data-direction="1"]').first).to_be_enabled(timeout=5000)
        page.locator('[data-step="base"][data-direction="1"]').first.click()
        expect(page.locator('.rb-compose-list li[aria-selected="true"]')).to_have_count(0, timeout=5000)
        page.locator('[data-rb="slider-elbow"]').fill("60")
        check(page.locator(".rb-compose-pick").first.inner_text() == before,
              "editor: a jog lets go of the selected point, which then stays unchanged")
        page.locator('[data-rb="cancel"]').click()
        check(not errors, "editor: no page errors")
        # An arc composed before the 3D module has loaded still gets its default via point.
        page.evaluate("""() => {
          const q = s => document.querySelector(s);
          q('[data-rb=compose-clear]').click(); q('[data-rb=compose-clear]').click();
          q('[data-rb=compose-add-fields]').click();
          const base = q('#rb-base'); base.value = '30'; base.dispatchEvent(new Event('input', {bubbles: true}));
          q('[data-rb=compose-add-fields]').click();
          const shoulder = q('#rb-shoulder'); shoulder.value = '25'; shoulder.dispatchEvent(new Event('input', {bubbles: true}));
          const leg = document.querySelector('select.rb-compose-leg'); leg.value = 'arc'; leg.dispatchEvent(new Event('change'));
        }""")
        expect(page.locator('[data-rb="compose-result"]')).to_contain_text("Vérifié par HQ", timeout=5000)
        check(True, "editor: an arc leg is checked with its default via point")
        context.close()

        # Movement (simulation): cost on Déplacer, speed in deg/s, progress and time left, jog limits, go to a point.
        context = browser.new_context(viewport={"width": 1440, "height": 1000})
        context.add_cookies([{"name": bridge.COOKIE_NAME, "value": admin.token, "url": base}])
        page = context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(base + "/#robotique", wait_until="domcontentloaded")
        expect(page.locator('[data-rb="arm"]')).to_be_enabled(timeout=15000)
        page.locator('[data-rb="section-overview"]').click()  # the motion flow needs every card
        # Speed, tool and torque live under the « Pilotage avancé » disclosure; open it to read them.
        page.locator(".rb-motion-advanced summary").click()
        check("°/s" in page.locator('[data-rb="speed-deg"]').inner_text(),
              "motion: speed shown in degrees per second")
        page.locator('[data-rb="arm"]').click()
        expect(page.locator('[data-step="base"][data-direction="1"]').first).to_be_enabled(timeout=5000)
        page.locator("#rb-base").fill("40")
        # The simulated arm may not be at 0 (earlier checks jog it): check the format, not the number.
        expect(page.locator('[data-rb="move"]')).to_have_text(re.compile(r"Déplacer · \d+(,\d)?° · ≈ \d+(,\d)? s"))
        check(True, "motion: Déplacer shows the change and the time")
        page.locator('[data-rb="move"]').click()
        expect(page.locator('[data-rb="motion-progress"]')).to_be_visible(timeout=3000)
        check(page.locator('[data-rb="arm-state"]').inner_text().startswith("En mouvement"),
              "motion: progress bar and time left in the status strip")
        expect(page.locator('[data-rb="motion-progress"]')).to_be_hidden(timeout=15000)
        page.locator('[data-rb="angle-step"]').select_option("5")
        page.locator("#rb-base").fill("78")
        page.locator('[data-rb="move"]').click()
        expect(page.locator('[data-rb="motion-progress"]')).to_be_hidden(timeout=15000)
        plus = page.locator('[data-step="base"][data-direction="1"]').first
        expect(plus).to_have_attribute("title", re.compile("Limite haute"), timeout=8000)
        check(plus.is_disabled(), "motion: a jog past the joint limit is greyed out with the reason")
        check(page.locator('[data-step="base"][data-direction="-1"]').first.is_enabled(), "motion: the other direction stays available")
        page.locator('[data-monitor="space"]').click()
        page.locator('[data-rb="compose-toggle"]').click()
        page.locator('[data-rb="compose-add-fields"]').click()
        page.locator('[data-rb="compose-add-fields"]').click()
        page.locator("#rb-base").fill("-30")
        goto = page.locator("[data-compose-goto]").nth(1)
        expect(goto).to_be_enabled(timeout=5000)
        goto.click()
        expect(page.locator('[data-rb="motion-state"]')).not_to_have_text("À l’arrêt", timeout=5000)
        target = page.evaluate("fetch('/api/robotics/status', {credentials: 'same-origin'}).then(r => r.json()).then(s => s.target)")
        check(abs(target["base"] + 30) < .2, "motion: « Aller à ce point » sends the arm to that point")
        page.locator('[data-rb="cancel"]').click()
        check(not errors, "motion: no page errors")
        context.close()

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
        # With the chat closed the assistant keeps its normal stacking and the companion chips stay
        # usable. Only the open chat may sit above them.
        page.evaluate(ENSURE_ALERT_JS)
        closed = page.evaluate("""() => {
            const root = document.querySelector('.rb-ai');
            const dock = [...document.querySelectorAll(
                '.hq-securia-chip-dock, .hq-culinia-chip-dock, .hq-forgia-chip-dock')]
                .find(el => !el.hidden && getComputedStyle(el).display !== 'none'
                    && el.getBoundingClientRect().width > 0);
            if (!dock) return { z: getComputedStyle(root).zIndex, clickable: null };
            const r = dock.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return { z: getComputedStyle(root).zIndex, clickable: !!(hit && dock.contains(hit)) };
        }""")
        check(closed["z"] == "1170", "chat closed: the assistant keeps its normal z-index")
        check(closed["clickable"] is not False, "chat closed: companion chips stay clickable")
        # A phone keeps the Kinétia entry in the sticky bar, where scrolling cannot take it away.
        ai = page.locator('[data-rb="section-ai"]')
        check(ai.is_visible(), "light: Kinétia entry in the sticky bar")
        ai.click()
        check(page.locator('#hq-robotics-chat').is_visible(), "light: the bar entry opens Kinétia")
        # The chip rows scroll on a phone: the section bar's edge fade marks the rest, the card never
        # overflows sideways, and a chip still sends its text.
        chips = page.locator('.rb-ai-chips')
        check(chips.evaluate("el => el.scrollWidth > el.clientWidth + 2"),
              "chat: the suggestion row is wider than the card")
        check(chips.evaluate("el => el.classList.contains('is-overflow') && el.classList.contains('is-end')"),
              "chat: the suggestion row marks the content waiting off-screen")
        check(chips.evaluate("el => getComputedStyle(el).maskImage !== 'none'"),
              "chat: the suggestion row fades at the card edge")
        check(page.locator('.rb-ai-macros').evaluate("el => getComputedStyle(el).maskImage !== 'none'"),
              "chat: the macro row fades too")
        check(page.locator('#hq-robotics-chat').evaluate("el => el.scrollWidth <= el.clientWidth + 1"),
              "chat: no horizontal overflow on a phone")
        chips.evaluate("el => { el.scrollLeft = el.scrollWidth; }")
        page.wait_for_timeout(150)
        check(chips.evaluate("el => !el.classList.contains('is-end') && el.classList.contains('is-start')"),
              "chat: the fade follows the scroll to the end")
        suggestion = chips.locator('button').first
        text = suggestion.inner_text()
        suggestion.tap(timeout=8000)
        page.wait_for_timeout(200)
        check(text in page.locator('[data-chat="log"]').inner_text(), "chat: tapping a suggestion sends it")
        # The bench-tool pill only exists when a reply carries a tool, so a probe puts one in the
        # worst-case context (the teal user bubble) and it is removed once both schemes are measured.
        page.evaluate("""() => {
            const host = document.querySelector('#hq-robotics-chat .rb-ai-message.is-user') ||
                document.querySelector('#hq-robotics-chat');
            const probe = document.createElement('button');
            probe.type = 'button';
            probe.className = 'rb-ai-tool-btn';
            probe.dataset.rbContrastProbe = '1';
            probe.textContent = 'Outil';
            host.append(probe);
        }""")

        # Contrast is measured on the declared colours, with alpha and gradient stops composited: every
        # pill/foreground pair must clear 4.5:1. A miss is fixed in the CSS, never by relaxing this.
        pairs = [
            (".rb-ai .rb-ai-icon", "borderTopColor", ".rb-ai .rb-ai-chip", "floating chip glyph"),
            (".rb-ai-macros button", "color", None, "macro pill text"),
            (".rb-ai-chips button", "color", None, "suggestion pill text"),
            ("[data-rb-contrast-probe]", "color", None, "chat tool pill text"),
            ("#hq-robotics-app .rb-section-nav button", "color", None, "section chip text"),
            ('#hq-robotics-app .rb-section-nav button[aria-pressed="true"]', "color", None,
             "selected section chip"),
            ("#hq-robotics-app .rb-copilot-badge", "color", None, "co-pilot badge"),
        ]

        def measure_pairs(scheme, width):
            measured = 0
            for selector, prop, bg_selector, label in pairs:
                if not page.locator(selector).count():
                    continue
                data = page.evaluate(CONTRAST_JS, [selector, prop, bg_selector])
                check(bool(data), f"{scheme} {width}px: {label} measured")
                check(data["ratio"] >= 4.5,
                      f"{scheme} {width}px: {label} {data['ratio']:.2f}:1 ≥ 4.5:1")
                measured += 1
            return measured

        # 430 is below the floating chip's phone breakpoint, but its colours still resolve there; 1024
        # and 1440 measure it where it is actually shown. The fades hold at every width.
        for width in (430, 1024, 1440):
            page.set_viewport_size({"width": width, "height": 960})
            page.wait_for_timeout(220)
            check(measure_pairs("light", width) >= 4, f"light {width}px: every pill measured")
            # The fixture's status poll can clear the alert during the checks above; re-mount it
            # so the stacking measurement always has a real alert layer.
            page.evaluate(ENSURE_ALERT_JS)
            page.wait_for_timeout(120)
            stacking = page.evaluate(CHAT_STACKING_JS)
            check(stacking["z"] == 1186, f"light {width}px: the open chat outranks the companions")
            check(not stacking["above"], f"light {width}px: no companion layer sits above the chat")
            check(not stacking["covered"], f"light {width}px: no overlay covers the open chat")
            check(stacking["alertPoints"] > 0,
                  f"light {width}px: the alert really overlaps the chat area")
            if width > 620:
                # The %-sized glyph must actually be drawn: it once collapsed into a 4 px dot.
                check(page.locator('.rb-ai .rb-ai-icon').evaluate(
                          "el => { const r = el.getBoundingClientRect(); return r.width >= 24 && r.height >= 24; }"),
                      f"chip: the robot glyph is drawn at {width} px")
            check(chips.evaluate("el => el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).maskImage !== 'none'"),
                  f"chat: the suggestion row fades at {width} px")
            check(page.locator('.rb-ai-macros').evaluate("el => getComputedStyle(el).maskImage !== 'none'"),
                  f"chat: the macro row fades at {width} px")
            # The section bar only fades while it actually overflows; then it must say so, and the
            # trailing control must be a real button that reveals the rest of the row.
            nav = page.locator(".rb-section-nav")
            more = page.locator('[data-rb="section-more"]')
            overflowing = nav.evaluate("el => el.scrollWidth > el.clientWidth + 2")
            check(not overflowing or (nav.evaluate("el => el.classList.contains('is-overflow')")
                                      and nav.evaluate("el => getComputedStyle(el).maskImage !== 'none'")
                                      and nav.evaluate("el => el.classList.contains('is-end')")),
                  f"sections: an overflowing bar fades at {width} px")
            if overflowing and width > 620:
                check(more.is_visible(), f"sections: the scroll button is shown at {width} px")
                check(more.get_attribute("aria-label") == "Sections suivantes",
                      f"sections: the scroll button is named at {width} px")
                before = nav.evaluate("el => el.scrollLeft")
                more.click()
                page.wait_for_timeout(450)
                check(nav.evaluate("el => el.scrollLeft") > before,
                      f"sections: the scroll button advances the row at {width} px")
                nav.evaluate("el => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event('scroll')); }")
                page.wait_for_timeout(150)
                check(more.is_hidden(), f"sections: the scroll button leaves at the row's end at {width} px")
                check(nav.evaluate("el => { const b = el.lastElementChild.getBoundingClientRect();"
                                           " const r = el.getBoundingClientRect(); return b.right <= r.right + 1; }"),
                      f"sections: the last chip is whole at the row's end at {width} px")
                nav.evaluate("el => { el.scrollLeft = 0; el.dispatchEvent(new Event('scroll')); }")
                page.wait_for_timeout(100)
            elif width > 620:
                check(more.is_hidden(), f"sections: no scroll button without overflow at {width} px")
            else:
                check(more.is_hidden(), f"sections: the phone bar keeps the fade without a button at {width} px")

        # Dark keeps exactly the palette it shipped with: the light block must not leak into it.
        page.emulate_media(color_scheme="dark")
        page.set_viewport_size({"width": 1440, "height": 960})
        page.wait_for_timeout(250)
        dark = page.evaluate("""() => {
            const ai = getComputedStyle(document.querySelector('.rb-ai'));
            return {
                accent: ai.getPropertyValue('--rb-ai-accent').trim(),
                chipBorder: ai.getPropertyValue('--rb-ai-chip-border').trim(),
                chipBg: ai.getPropertyValue('--rb-ai-chip-bg').trim(),
                glyph: getComputedStyle(document.querySelector('.rb-ai .rb-ai-icon')).borderTopColor,
                macro: getComputedStyle(document.querySelector('.rb-ai-macros button')).color,
            };
        }""")
        check(dark["accent"] == "#5ed3bc", "dark: the chat accent is still #5ed3bc")
        check(dark["chipBorder"] == "#58c9b4", "dark: the floating chip border token is unchanged")
        check("#1d4954" in dark["chipBg"] and "#0f252c" in dark["chipBg"],
              "dark: the floating chip glass is unchanged")
        check(dark["glyph"] == "rgb(134, 225, 205)", "dark: the floating chip glyph is unchanged")
        check(dark["macro"] == "rgb(115, 237, 206)", "dark: the macro pills are still teal")
        for width in (430, 1440):
            page.set_viewport_size({"width": width, "height": 960})
            page.wait_for_timeout(220)
            check(measure_pairs("dark", width) >= 5, f"dark {width}px: every pill measured")
            page.evaluate(ENSURE_ALERT_JS)
            page.wait_for_timeout(120)
            stacking = page.evaluate(CHAT_STACKING_JS)
            check(stacking["z"] == 1186, f"dark {width}px: the open chat outranks the companions")
            check(not stacking["above"] and not stacking["covered"],
                  f"dark {width}px: the chat stays unobstructed")
            check(stacking["alertPoints"] > 0,
                  f"dark {width}px: the alert really overlaps the chat area")
        # Closed-chat review at 1024 in both schemes: the Kinétia chip and the companion dock on this
        # view must stay whole, inside the viewport, unclipped, clickable and clear of the alert bubble.
        for scheme in ("light", "dark"):
            context = browser.new_context(viewport={"width": 1024, "height": 900},
                                          device_scale_factor=2, color_scheme=scheme)
            closed_page = context.new_page()
            closed_errors = []
            closed_page.on("pageerror", lambda error: closed_errors.append(str(error)))
            closed_page.context.add_cookies([{"name": bridge.COOKIE_NAME,
                                              "value": admin.token, "url": base}])
            closed_page.goto(base + "/#robotique", wait_until="domcontentloaded")
            expect(closed_page.locator('[data-rb="arm"]')).to_be_enabled(timeout=15000)
            closed_page.evaluate(ENSURE_ALERT_JS)
            expect(closed_page.locator('.hq-securia-whisper')).to_be_visible(timeout=5000)
            # The alert mounts with an entrance transition and the status poll can nudge the dock; probe
            # once the chip geometry has settled, so a hit test never races a moving box.
            signature = None
            for _ in range(12):
                closed_page.wait_for_timeout(120)
                current = closed_page.evaluate(
                    "() => [...document.querySelectorAll('.rb-ai .rb-ai-chip, .hq-securia-chip-dock')]"
                    ".map(el => { const r = el.getBoundingClientRect();"
                    " return [r.left, r.top, r.width, r.height]; }).join('|')")
                if current and current == signature:
                    break
                signature = current
            closed_state = closed_page.evaluate(CLOSED_CHIPS_JS)
            check(closed_state["rootZ"] == "1170",
                  f"{scheme} 1024px closed: the assistant keeps its normal z-index")
            check(not closed_state["chatOpen"],
                  f"{scheme} 1024px closed: the chat really is closed")
            check(len(closed_state["chips"]) >= 2,
                  f"{scheme} 1024px closed: the Kinétia chip and the companion dock are shown")
            rects = [(chip["label"], chip["rect"]) for chip in closed_state["chips"]]
            for i in range(len(rects)):
                for j in range(i + 1, len(rects)):
                    (first, a), (second, b) = rects[i], rects[j]
                    overlap_x = min(a[2], b[2]) - max(a[0], b[0])
                    overlap_y = min(a[3], b[3]) - max(a[1], b[1])
                    check(overlap_x <= 0 or overlap_y <= 0,
                          f"{scheme} 1024px closed: {first} and {second} do not overlap")
            for chip in closed_state["chips"]:
                check(chip["inView"],
                      f"{scheme} 1024px closed: {chip['label']} sits inside the viewport")
                check(not chip["clipped"], f"{scheme} 1024px closed: {chip['label']} is not clipped")
                check(chip["clickable"],
                      f"{scheme} 1024px closed: {chip['label']} is clickable"
                      + ("" if chip["clickable"] else f" — misses {chip['misses']}"))
                check(not chip["underWhisper"],
                      f"{scheme} 1024px closed: the alert bubble clears {chip['label']}")
            check(not closed_errors, f"{scheme} 1024px closed: no page errors")
            context.close()
        page.evaluate("() => document.querySelectorAll('[data-rb-contrast-probe]').forEach(el => el.remove())")
        check(not errors, "light: no page errors")
        if args.screenshots:
            target = ROOT / ".tmp" / "robotique-visual"
            target.mkdir(parents=True, exist_ok=True)
            capture_ui(browser, base, admin, target)
            print(f"  screenshots: {target}")
        browser.close()

    print(f"verify_robotics_visual: OK ({checks} checks)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
