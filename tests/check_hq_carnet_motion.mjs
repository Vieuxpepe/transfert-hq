// Pure checks for the Phase 16C ergonomics + motion layer (assets/hq-carnet-motion.js). No browser, no server.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const M = require("../assets/hq-carnet-motion.js");
const P = M.pure;

// overlap: a page switch shares nothing, an edit shares almost everything
assert.equal(P.overlap([], ["a"]), 0);
assert.equal(P.overlap(["a", "b", "c"], ["x", "y"]), 0);
assert.equal(P.overlap(["a", "b", "c", "d"], ["a", "b", "c", "d", "e"]), 0.8);
assert.equal(P.overlap(["a", "b"], ["b", "a"]), 1);
assert.ok(P.sameSeq(["a", "b"], ["a", "b"]) && !P.sameSeq(["a", "b"], ["b", "a"]) && !P.sameSeq(["a"], ["a", "b"]));

// flipPlan: moved blocks get the inverse offset, new blocks are listed, huge changes animate nothing
{
  const before = new Map([["a", 0], ["b", 28], ["c", 56]]);
  const after = new Map([["a", 0], ["c", 28], ["n", 56], ["b", 84]]);
  const p = P.flipPlan(before, after);
  assert.deepEqual(p.moves.sort((x, y) => (x.key < y.key ? -1 : 1)), [{ key: "b", dy: -56 }, { key: "c", dy: 28 }]);
  assert.deepEqual(p.added, ["n"]);
  const big = new Map();
  const big2 = new Map();
  for (let i = 0; i < 200; i += 1) {
    big.set("k" + i, i * 28);
    big2.set("k" + i, i * 28 + 28);
  }
  assert.equal(P.flipPlan(big, big2).moves.length, 0, "over the cap: no animation at all");
  const far = P.flipPlan(new Map([["a", 0]]), new Map([["a", 5000]]));
  assert.equal(far.moves.length, 0, "a jump far away is not animated");
  const paste = new Map([["a", 0], ["p1", 28], ["p2", 56], ["p3", 84], ["p4", 112]]);
  assert.deepEqual(P.flipPlan(new Map([["a", 0]]), paste).added, [], "a paste does not fade in line by line");
}

// checklistRun: the contiguous run around the toggled line
{
  const L = [
    { type: "paragraph" }, { type: "check", checked: true }, { type: "check", checked: true }, { type: "check", checked: false },
    { type: "heading" }, { type: "check", checked: true },
  ];
  assert.deepEqual(P.checklistRun(L, 2), { done: 2, total: 3, from: 1, to: 3 });
  assert.deepEqual(P.checklistRun(L, 5), { done: 1, total: 1, from: 5, to: 5 });
  assert.equal(P.checklistRun(L, 0).total, 0);
  L[3].checked = true;
  const r = P.checklistRun(L, 3);
  assert.ok(r.done === r.total && r.total === 3);
}

// pull stages, menu origin, toast swipe, caret scroll
assert.equal(P.pullStage(0), 0);
assert.equal(P.pullStage(P.PULL_ARM - 1), 0);
assert.equal(P.pullStage(P.PULL_ARM), 1);
assert.equal(P.pullStage(P.PULL_FAR), 2);
assert.equal(P.originFor({ left: 100, top: 200, width: 300, height: 100 }, { x: 150, y: 190 }), "50px 0px");
assert.equal(P.originFor({ left: 100, top: 200, width: 300, height: 100 }, { x: 900, y: 900 }), "300px 100px", "clamped into the box");
assert.equal(P.originFor(null, { x: 1, y: 1 }), "50% 0");
assert.equal(P.dismissBySwipe(10, 0.1, 300), false);
assert.equal(P.dismissBySwipe(120, 0, 300), true);
assert.equal(P.dismissBySwipe(-30, -0.8, 300), true, "a flick dismisses");
assert.equal(P.caretScroll(500, 700, 16), 0);
assert.equal(P.caretScroll(690, 700, 16), 6);
assert.equal(P.caretScroll(900, 700, 16), 216);

// toast() / buzz() are safe without a browser
assert.equal(M.toast({ text: "x" }), null);
M.buzz(8);

// source hygiene: presentation only
const code = readFileSync(new URL("../assets/hq-carnet-motion.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket"]) {
  assert.ok(!code.includes(bad), "no " + bad);
}
// every movement is gated: animate() checks calm(), CSS has reduced-motion fallbacks
assert.ok(/function animate\([\s\S]*?calm\(\)/.test(code), "animate() honours reduced motion");
const css = readFileSync(new URL("../assets/hq-carnet.css", import.meta.url), "utf8");
const c16 = css.slice(css.indexOf("Phase 16C"));
assert.ok(c16.length > 1000, "16C section present");
for (const kf of (c16.match(/animation:c16-[a-z-]+/g) || [])) {
  const name = kf.slice("animation:".length);
  assert.ok(c16.includes("@keyframes " + name), "keyframes defined: " + name);
}
assert.ok((c16.match(/prefers-reduced-motion:reduce/g) || []).length >= 3, "reduced-motion fallbacks");
assert.ok(!/animation:[^;}]*\bboth\b/.test(c16), "no fill-mode both (it would pin transforms after the animation)");
console.log("check_hq_carnet_motion: ok");
