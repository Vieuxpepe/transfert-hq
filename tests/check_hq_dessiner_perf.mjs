// Dessiner render harness: the frame ring buffer, the 500-object budget, the static/overlay split, culling and LOD,
// and the hit-test grid (same answers as the linear scan, far fewer tests). Run: node tests/check_hq_dessiner_perf.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const ui = readFileSync(new URL("../assets/hq-dessiner.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../assets/hq-dessiner.css", import.meta.url), "utf8");

// --- frame statistics
assert.deepEqual(S.perfStats([]), { n: 0, median: 0, p95: 0, max: 0 });
assert.deepEqual(S.perfStats(["x", null, NaN, -1]), S.perfStats([]));
{
  const s = S.perfStats(Array.from({ length: 100 }, (_, i) => i));
  assert.equal(s.n, 100);
  assert.ok(s.median >= 49 && s.median <= 50, "médiane " + s.median);
  assert.ok(s.p95 >= 94 && s.p95 <= 96, "p95 " + s.p95);
  assert.equal(s.max, 99);
}

// --- the budget: 500 objects ≤ 6 ms of JS (p95); above that size p95 stays informational
assert.deepEqual(S.DRAW_BUDGET, { objects: 500, ms: 6 });
assert.equal(S.budgetOk(S.perfStats([1, 2, 3, 4, 5]), 500), true);
assert.equal(S.budgetOk(S.perfStats([1, 2, 3, 4, 20]), 500), false);
assert.equal(S.budgetOk(S.perfStats([40, 40, 40]), 5000), true, "hors budget de taille : informatif");
assert.equal(S.budgetOk(S.perfStats([]), 500), true);

// --- the harness is wired into the real draw path
for (const needle of ["window.hqDessinerPerf", "S.perfStats", "st.perf.push", "function perfFrame", "function drawBase",
  "noBg: true", "onlySel: true", "st.docRev", "st.baseKey", "function themeKey"]) {
  assert.ok(ui.includes(needle), "harnais absent : " + needle);
}
assert.ok(ui.includes('class="sk-base"'), "le calque statique n'existe pas dans le gabarit");
assert.ok(css.includes(".sk-base{position:absolute"), "le calque statique n'est pas empilé sous la zone de dessin");
assert.ok(ui.includes("sk-perf"), "le HUD ne peut pas afficher la mesure");

// --- culling and LOD are real branches of drawScene
for (const needle of ["bb[2] < vx0", "sub-pixel LOD", "ob.r * view.ppu < 0.8", "g.r * view.ppu >= 0.8", "Math.hypot(s.x - lx, s.y - ly) < 0.5"]) {
  assert.ok(ui.includes(needle), "branche de rendu absente : " + needle);
}

// --- the hit-test grid gives exactly the same answers as the linear scan
function docWith(n) {
  const d = S.createDoc();
  d.version = S.SKETCH_VERSION;
  d.sketches = [];
  let seed = 12345;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < n; i++) {
    const kind = i % 4;
    const x = Math.round(r() * 200), y = Math.round(r() * 200);
    if (kind === 0) S.addLine(d, { x: x, y: y }, { x: x + 5 + Math.round(r() * 40), y: y + Math.round(r() * 40) });
    else if (kind === 1) S.addCircle(d, { x: x, y: y }, 1 + r() * 12);
    else if (kind === 2) S.addArc(d, { x: x, y: y }, { x: x + 15, y: y }, { x: x, y: y + 15 });
    else S.addStroke(d, Array.from({ length: 8 }, (_, k) => [x + k * 3 + r(), y + r() * 10]), 0, 1);
  }
  return d;
}
for (const n of [50, 400]) {
  const d = docWith(n);
  const index = S.buildHitIndex(d, 12);
  let seed = 999;
  const r = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 300; i++) {
    const x = r() * 240 - 20, y = r() * 240 - 20, tol = 0.5 + r() * 4;
    assert.equal(S.hitTestIndexed(d, index, x, y, tol), S.hitTest(d, x, y, tol), "hitTest indexé ≠ linéaire en " + x.toFixed(2) + "," + y.toFixed(2));
    assert.deepEqual(S.hitAllIndexed(d, index, x, y, tol), S.hitAll(d, x, y, tol), "hitAll indexé ≠ linéaire");
  }
  // a long stroke goes to the spill list and is still found
  const big = S.createDoc();
  big.version = S.SKETCH_VERSION;
  S.addStroke(big, [[0, 0], [500, 0], [500, 500], [0, 500]], 0, 1);
  assert.deepEqual(S.hitAllIndexed(big, S.buildHitIndex(big, 12), 250, 0, 1), S.hitAll(big, 250, 0, 1));
}

// --- objectBox never throws on a broken document, and culling relies on it
{
  const d = S.createDoc();
  d.version = S.SKETCH_VERSION;
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  S.addCircle(d, { x: 0, y: 0 }, 3);
  d.points = d.points.filter(p => p.id !== S.getObj(d, l).p2);
  for (const o of d.objects) {
    const b = S.objectBox(d, o);
    assert.ok(b === null || (b.length === 4 && b.every(Number.isFinite)), "objectBox invalide");
  }
}

// --- layer freshness: everything keys on the document revision, so nothing may replace st.doc behind its back
{
  const writes = [...ui.matchAll(/\bst\.doc = /g)].length;
  assert.equal(writes, 2, "only commit() and setDoc() assign st.doc (found " + writes + ")");
  assert.match(ui, /function setDoc\(next\) \{ st\.doc = next; bumpDoc\(\); \}/);
  // the canvas fit has four owners, no more: show (synchronous), the window resize, and the two ResizeObservers
  const fits = [...ui.matchAll(/fitStage\(\)/g)].length;
  assert.equal(fits, 4, "fitStage: one definition + the resize handler, the chrome observer and the synchronous show (found " + fits + ")");
  assert.match(ui, /window\.addEventListener\("resize", resize\)/);
  assert.match(ui, /roFit = new ResizeObserver\(\(\) => fitStage\(\)\)/);
  assert.match(ui, /\$\("\.sk-bar", root\), \$\("\.sk-tools", root\), \$\("\.sk-view-tabs", root\), \$\("\.sk-settings", root\)/,
    "the chrome observer must keep watching the bars that can move the fold");
  assert.match(ui, /function bumpDoc\(\) \{ st\.docRev\+\+; st\.baseKey = ""; st\.hit = null; st\.boxes\.clear\(\); \}/,
    "a new revision must dirty the static layer, the hit index and the culling boxes");
  assert.match(ui, /if \(!baseCtx\) \{[\s\S]{0,200}drawScene\(ctx, shown/, "one canvas must still draw everything when the static layer is missing");
  assert.match(ui, /st\.cull = \{ considered/, "the frame must say how many objects survived culling");
  assert.match(ui, /drawn: st\.drawnBase == null/, "and the ring buffer must carry it");
}

console.log("check_hq_dessiner_perf: ok");
