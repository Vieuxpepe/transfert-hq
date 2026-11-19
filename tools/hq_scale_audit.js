/* HQ type-scale audit — paste into the browser console on a live page and read the table.
 *
 * The static guard (tests/check_hq_scale.mjs) catches declarations; this catches what the cascade
 * actually paints: inheritance, clamp() at the current viewport, and a component whose own size
 * overrides a step. It walks every [data-panel] (hidden ones too, so one call covers the whole app)
 * and lists text that is not on the six steps. Display art (>= 38px) and icon resets are skipped
 * the same way the static check skips them.
 */
(() => {
  const STEPS = [11, 13, 15, 17, 20, 26];
  const DISPLAY_MIN = 38;
  const onStep = (px) => STEPS.some((s) => Math.abs(s - px) < 0.5);
  const rows = [];
  for (const panel of document.querySelectorAll("[data-panel]")) {
    for (const el of panel.querySelectorAll("*")) {
      if (!el.textContent || !el.textContent.trim()) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (!px || px === 0 || px >= DISPLAY_MIN) continue;
      if (onStep(px)) continue;
      rows.push({
        panel: panel.getAttribute("data-panel"),
        px: Math.round(px * 100) / 100,
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || "").slice(0, 48),
      });
    }
  }
  if (rows.length) console.table(rows.slice(0, 80));
  return rows.length ? `${rows.length} off-scale text node(s)` : "ok: every text node is on a step";
})()
