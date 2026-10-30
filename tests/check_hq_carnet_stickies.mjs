// Pure checks for the Phase 16D sticky notes UI (assets/hq-carnet-stickies.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const S = require("../assets/hq-carnet-stickies.js");
const P = S.pure;

// position round trip: fraction <-> px, always fully on the page
assert.equal(P.leftPx(0.5, 800, 200), 400);
assert.equal(P.leftPx(0.95, 800, 200), 600, "clamped so the note stays on the page");
assert.equal(P.leftPx(0.95, 360, 230), 130, "same note on a phone stays visible");
assert.equal(P.leftPx(-1, 800, 200), 0);
assert.equal(P.fracX(400, 800, 200), 0.5);
assert.equal(P.fracX(9999, 800, 200), 0.75);
assert.equal(P.fracX(10, 0, 200), 0);
for (const l of [0, 13, 250, 599]) assert.ok(Math.abs(P.leftPx(P.fracX(l, 800, 200), 800, 200) - l) <= 1, "round trip " + l);
assert.equal(P.clampY(-20, 1000, 100), 0);
assert.equal(P.clampY(5000, 1000, 100), 940);
// colours cycle through all five and wrap
const seen = [];
let c = "yellow";
for (let i = 0; i < 5; i += 1) {
  seen.push(c);
  c = P.nextColor(c);
}
assert.deepEqual(seen, P.COLORS);
assert.equal(c, "yellow");
// placement: top-right of the visible part, never exactly on top of another note
const a = P.placement(800, 0, [], 230);
assert.equal(a.y, 24 > 16 ? 24 : 16);
assert.equal(P.leftPx(a.x, 800, a.w) + a.w, 800 - 16);
const b = P.placement(800, 0, [{ x: a.x, y: a.y }], 230);
assert.ok(b.y > a.y, "nudged down");
assert.ok(P.placement(300, 0, [], 230).w <= 300 - 16, "narrow page: note fits");
// labels
assert.equal(P.label("\n\n  Couple 25 N·m  \nsuite"), "Couple 25 N·m");
assert.equal(P.label(""), "Note vide");
assert.equal(P.label("x".repeat(90)).length, 60);
// source hygiene: presentation + its own API only
const code = readFileSync(new URL("../assets/hq-carnet-stickies.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage", "indexedDB", "XMLHttpRequest", "sendBeacon", "WebSocket", "fetch("]) {
  assert.ok(!code.includes(bad), "no " + bad);
}
assert.ok(code.includes('"/api/carnet/stickies"'), "own endpoint only");
console.log("check_hq_carnet_stickies: ok");
