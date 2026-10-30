// Pure checks for the Phase 16G sizing layer (assets/hq-carnet-sizing.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const Z = require("../assets/hq-carnet-sizing.js");
const P = Z.pure;

// page width: clamps, snaps to presets, full width near the edge
assert.deepEqual(P.snapPage(100, 1400), { w: P.PAGE_MIN, preset: "" });
assert.deepEqual(P.snapPage(650, 1400), { w: 640, preset: "narrow" });
assert.deepEqual(P.snapPage(800, 1400), { w: 820, preset: "normal" });
assert.deepEqual(P.snapPage(1090, 1400), { w: 1080, preset: "wide" });
assert.deepEqual(P.snapPage(930, 1400), { w: 930, preset: "" });
assert.deepEqual(P.snapPage(1390, 1400), { w: 0, preset: "full" });
assert.deepEqual(P.snapPage(5000, 1400), { w: 0, preset: "full" });
assert.equal(P.snapPage(1090, 1000).w, 0, "a preset wider than the room is full width");
assert.equal(P.presetLabel(820), "Normale");
assert.equal(P.presetLabel(0), "Pleine largeur");
assert.equal(P.presetLabel(930), "930 px");
// library width
assert.equal(P.clampSide(10), P.SIDE_MIN);
assert.equal(P.clampSide(9999), P.SIDE_MAX);
assert.equal(P.clampSide(300.4), 300);
// text size: whole pixels, font and line height move together, steps are bounded
const d = P.fontFor(P.FONT_DEFAULT, 18, 30);
assert.deepEqual(d, { fs: 18, lh: 30, pct: 100 });
let prev = 0;
for (let i = 0; i < P.FONT_STEPS.length; i += 1) {
  const f = P.fontFor(i, 18, 30);
  assert.ok(Number.isInteger(f.fs) && Number.isInteger(f.lh) && f.lh > f.fs && f.lh >= prev, "step " + i);
  prev = f.lh;
}
assert.deepEqual(P.fontFor(-5, 18, 30), P.fontFor(0, 18, 30));
assert.deepEqual(P.fontFor(99, 18, 30), P.fontFor(P.FONT_STEPS.length - 1, 18, 30));
// stored settings: anything odd falls back to defaults
const D = { page: null, font: P.FONT_DEFAULT, side: null, paper: "lines", tint: "auto" };
assert.deepEqual(P.parse(""), D);
assert.deepEqual(P.parse("{broken"), D);
assert.deepEqual(P.parse(JSON.stringify({ page: 0, font: 4, side: 300, paper: "grid", tint: "sepia" })), { page: 0, font: 4, side: 300, paper: "grid", tint: "sepia" });
assert.deepEqual(P.parse(JSON.stringify({ page: 12, font: 99, side: "x", paper: "lava", tint: "#f00" })), D);
// 16H: paper looks and tints are closed lists
assert.deepEqual(P.PAPERS.map((x) => x.id), ["lines", "grid", "dots", "blank", "blueprint"]);
assert.deepEqual(P.TINTS.map((x) => x.id), ["auto", "cream", "white", "sepia", "slate", "black"]);
// hygiene: view preferences only
const code = readFileSync(new URL("../assets/hq-carnet-sizing.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "sessionStorage", "indexedDB"]) assert.ok(!code.includes(bad), "no " + bad);
assert.equal((code.match(/localStorage/g) || []).length, 2, "one read, one write of the device preference");
console.log("check_hq_carnet_sizing: ok");
