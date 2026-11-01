// Pure checks for the living Accueil (assets/hq-home-fx.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const H = require("../assets/hq-home-fx.js").pure;

assert.equal(H.phase(2), "night");
assert.equal(H.phase(5.5), "dawn");
assert.equal(H.phase(12), "day");
assert.equal(H.phase(19), "dusk");
assert.equal(H.phase(21), "night");
assert.equal(H.phase(-1), "night", "wraps");

const rise = H.orbAt(6);
assert.deepEqual([rise.kind, rise.p, rise.h, rise.x, rise.y], ["sun", 0, 0, 58, 95], "the sun rises low, left of its corner");
const noon = H.orbAt(13);
assert.deepEqual([noon.kind, noon.p, noon.h, noon.x, noon.y], ["sun", 0.5, 1, 77, 65], "at its highest halfway");
const late = H.orbAt(19.9);
assert.ok(late.p > 0.99 && late.h < 0.03, "and sets low on the right");
const moon = H.orbAt(1);
assert.deepEqual([moon.kind, moon.p, moon.h], ["moon", 0.5, 1], "the moon peaks at 1 h");
assert.equal(H.orbAt(20).kind, "moon");
assert.equal(H.orbAt(20).p, 0);
assert.equal(H.orbAt(5.99).kind, "moon");

assert.deepEqual(H.digits(new Date(2026, 9, 31, 9, 5)), [0, 9, 0, 5]);
assert.deepEqual(H.digits(new Date(2026, 9, 31, 23, 59)), [2, 3, 5, 9]);

const a = H.starField(20, 42);
const b = H.starField(20, 42);
assert.deepEqual(a, b, "the same stars every visit");
assert.ok(a.every((s) => s.x >= 0 && s.x <= 100 && s.y >= 0 && s.y <= 88 && s.size >= 1 && s.size <= 3));
assert.notDeepEqual(H.starField(20, 43), a);

// the background
assert.deepEqual(H.palette("day", false).length, 4);
assert.notDeepEqual(H.palette("night", false), H.palette("day", false));
assert.notDeepEqual(H.palette("day", false), H.palette("day", true), "light theme gets its own pastels");
assert.deepEqual(H.palette("nowhere", false), H.palette("night", false));
for (const waves of [1, 2, 3]) {
  const d = H.wavePath(1440, 220, 20, waves, 0.7);
  const pts = [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const at = (x) => pts.find((p) => Math.abs(p[0] - x) < 0.01)[1];
  assert.ok(Math.abs(at(0) - at(1440)) < 0.2 && Math.abs(at(0) - at(2880)) < 0.2, "the waves loop without a seam (" + waves + ")");
}

// every page has its own sunset
const views = [...readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8").matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]);
const seen = new Set();
for (const v of new Set(views)) {
  const pal = H.pagePalette(v, "dusk", false);
  assert.equal(pal.length, 4, v);
  assert.equal(H.pagePalette(v, "dusk", true).length, 4, v);
  if (v !== "ops" && v !== "plus") {
    assert.ok(!seen.has(pal.join()), "a sunset of its own: " + v);
    seen.add(pal.join());
  }
}
assert.deepEqual(H.pagePalette("accueil", "night", false), H.palette("night", false), "Accueil follows the hour");
assert.deepEqual(H.pagePalette("inconnu", "day", false), H.palette("day", false));

// house rules
const src = readFileSync(new URL("../assets/hq-home-fx.js", import.meta.url), "utf8");
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|fetch\(/.test(src), "no HTML from strings, no network");
assert.ok(/prefers-reduced-motion/.test(src));
assert.ok(/S\.win\.hqNow\(\)/.test(src) && !/new Date\(\)\.get/.test(src), "the sky and the clock read the PC's time, like the greeting");
assert.ok(readFileSync(new URL("../assets/hq-home.js", import.meta.url), "utf8").includes("window.hqNow = now"));
const css = readFileSync(new URL("../assets/hq-home-fx.css", import.meta.url), "utf8");
const loops = css.split("@media (prefers-reduced-motion:no-preference)")[0];
assert.ok(!/animation:[^;}]*infinite/.test(loops), "every loop lives in the no-preference block");
const bridge = readFileSync(new URL("../iphone_bridge.py", import.meta.url), "utf8");
assert.ok(bridge.indexOf('<script src="/assets/hq-home.js"></script>') < bridge.indexOf('<script src="/assets/hq-home-fx.js"></script>'), "loads after hq-home.js");
assert.ok(bridge.includes('<link rel="stylesheet" href="/assets/hq-home-fx.css"/>'));
console.log("check_hq_home_fx: ok");
