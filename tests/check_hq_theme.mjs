// Checks for the shared look (assets/hq-theme.css/.js): page accents readable, fonts in place, house rules.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, statSync } from "node:fs";
const require = createRequire(import.meta.url);
const T = require("../assets/hq-theme.js").pure;

assert.ok(Math.abs(T.contrast("#ffffff", "#000000") - 21) < 0.01);
assert.ok(Math.abs(T.contrast("#08724f", "#ffffff") - 5.95) < 0.05, "matches the note in BASE_CSS");
assert.equal(T.inkBox(null), null);
assert.deepEqual(T.inkBox({ offsetLeft: 10, offsetTop: 20, offsetWidth: 140, offsetHeight: 52 }), { x: 10, y: 20, w: 140, h: 52 });

const css = readFileSync(new URL("../assets/hq-theme.css", import.meta.url), "utf8");
const [darkPart, lightPart] = css.split("@media (prefers-color-scheme: light)");
const accents = (part) => [...part.matchAll(/([^{}]+)\{--accent:(#[0-9a-f]{6})/g)]
  .flatMap((m) => [...m[1].matchAll(/data-view="([a-z]+)"/g)].map((v) => [v[1], m[2]]));
const dark = accents(darkPart);
const light = accents(lightPart.split("::selection")[0]);
const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");
const views = new Set([...bridge.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]));
for (const v of views) {
  assert.ok(dark.some(([k]) => k === v), "dark accent for " + v);
  assert.ok(light.some(([k]) => k === v), "light accent for " + v);
}
// dark: on the cards (#161d26, #1c2530) and under the dark button text (#04140e); light: on white, #e8eef4 and #f0f3f6, under white text
for (const [v, c] of dark) for (const bg of ["#161d26", "#1c2530", "#04140e"]) assert.ok(T.contrast(c, bg) >= 4.5, `dark ${v} ${c} on ${bg}: ${T.contrast(c, bg).toFixed(2)}`);
for (const [v, c] of light) for (const bg of ["#ffffff", "#e8eef4", "#f0f3f6"]) assert.ok(T.contrast(c, bg) >= 4.5, `light ${v} ${c} on ${bg}: ${T.contrast(c, bg).toFixed(2)}`);
const distinct = new Set(dark.filter(([v]) => v !== "ops").map(([, c]) => c));
assert.equal(distinct.size, dark.filter(([v]) => v !== "ops").length, "every page its own colour");
assert.ok(/body:not\(\.theme-midnight\)/.test(css), "the midnight theme keeps its accent");
assert.ok(!/@property --accent/.test(css), "--accent stays a plain custom property (readers get the hex they set)");

for (const f of ["hq-font-inter.woff2", "hq-font-fraunces.woff2"]) {
  const st = statSync(new URL("../assets/" + f, import.meta.url));
  assert.ok(st.size > 20000 && st.size < 200000, f);
  assert.ok(css.includes("/assets/" + f), f + " is used");
}
assert.ok(readFileSync(new URL("../docs/fonts-OFL.txt", import.meta.url), "utf8").includes("SIL Open Font License"), "font licences kept");

const src = readFileSync(new URL("../assets/hq-theme.js", import.meta.url), "utf8");
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|fetch\(/.test(src));
assert.ok(/prefers-reduced-motion/.test(src) && /prefers-reduced-motion/.test(css));
assert.ok(!/animation:[^;}]*infinite/.test(css), "no endless motion in the shared look");
assert.ok(/--hq-spring:/.test(css), "motion tokens live in theme");
assert.ok(/runViewChange/.test(src), "view transitions hook");
assert.ok(/hqViewTransitionHold|vtBlocked/.test(src), "calendar morph can block root VT");
assert.ok(/__hqViewMotionHandled/.test(src), "panel fade fallback when theme bypassed");
assert.ok(bridge.includes('<link rel="stylesheet" href="/assets/hq-theme.css"/>') && bridge.includes('<script src="/assets/hq-theme.js"></script>'));
assert.ok(bridge.includes("hq-chrome.css") && bridge.includes("hq-chrome.js"), "chrome motion layer");
assert.ok(bridge.includes("hq-polish.css") && bridge.includes("hq-polish.js"), "visual polish layer");
assert.ok(bridge.includes("hq-lecteur.css") && bridge.includes("hq-lecteur.js"), "lecteur motion layer");
assert.ok(bridge.includes("hq-dessiner-motion"), "dessiner motion layer");
assert.ok(/rel="preload" href="\/assets\/hq-font-inter\.woff2" as="font"/.test(bridge), "the text font is preloaded");
console.log("check_hq_theme: ok");
