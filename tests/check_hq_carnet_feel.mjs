// Pure checks for the Phase 16I feel layer (assets/hq-carnet-feel.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const F = require("../assets/hq-carnet-feel.js");
const P = F.pure;

// numbers at the start of a displayed value
assert.deepEqual(P.parseLeadingNumber("12,5 mm"), { n: 12.5, decimals: 1, comma: true, neg: false, rest: " mm", grouped: false });
assert.equal(P.parseLeadingNumber("−3.25").n, -3.25);
assert.equal(P.parseLeadingNumber("1 250 N").n, 1250);
assert.equal(P.parseLeadingNumber("Ø 12"), null);
assert.equal(P.parseLeadingNumber(""), null);
assert.equal(P.parseLeadingNumber("9999999999999"), null, "absurd lengths are left alone");
// a count formats like the original, and ends exactly on it
for (const s of ["12,5 mm", "−3.25", "1 250 N", "0.040 mm", "7"]) {
  const p = P.parseLeadingNumber(s);
  assert.equal(P.formatLike(p.n, p).replace(/ /g, " "), s.replace(/ /g, " "), s);
}
assert.equal(P.formatLike(6.25, P.parseLeadingNumber("12,5 mm")), "6,3 mm");
// snapping
assert.deepEqual(P.snap1(103, [0, 100, 200], 8), { v: 100, at: 100 });
assert.deepEqual(P.snap1(150, [0, 100, 200], 8), { v: 150, at: null });
assert.deepEqual(P.snap1(196, [190, 199], 8), { v: 199, at: 199 }, "the nearest target wins");
// sheets: a quarter of the height or a flick closes
assert.equal(P.sheetCloses(30, 600, 0.1), false);
assert.equal(P.sheetCloses(160, 600, 0.1), true);
assert.equal(P.sheetCloses(40, 600, 0.9), true);
assert.equal(P.sheetCloses(10, 600, 2), false, "a tap-sized move never closes");
// outline: the last heading above the reading line
assert.equal(P.activeIndex([-300, -20, 400], 140), 1);
assert.equal(P.activeIndex([300, 500], 140), 0);
assert.equal(P.activeIndex([10, 20, 30], 140), 2);
// one motion vocabulary with the Calendar
const cal = readFileSync(new URL("../assets/hq-calendar.css", import.meta.url), "utf8");
assert.ok(cal.includes("--hq-spring:" + P.EASE.spring), "same spring as the Calendar");
assert.ok(cal.includes("--hq-out:" + P.EASE.out), "same ease-out as the Calendar");

// house rules
const src = readFileSync(new URL("../assets/hq-carnet-feel.js", import.meta.url), "utf8");
for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "eval(", "new Function", "localStorage", "fetch(", "XMLHttpRequest", "document.write"]) assert.ok(!src.includes(bad), "no " + bad);
assert.ok(!/addEventListener\(\s*["']online/.test(src), "does not own the online listener");
assert.ok(src.includes("prefers-reduced-motion"), "respects reduced motion");
const css = readFileSync(new URL("../assets/hq-carnet.css", import.meta.url), "utf8");
assert.ok(css.includes("Phase 16I"), "16I styles present");
console.log("check_hq_carnet_feel: OK");
