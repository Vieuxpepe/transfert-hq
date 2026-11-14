// Shared ink look (assets/hq-ink.js), width-aware stroke simplification, and the pad's feel helpers.
// Run: node tests/check_hq_ink.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const INK = require("../assets/hq-ink.js");
const S = require("../assets/hq-sketch-core.js");
const DESK = require("../assets/hq-desk.js");

const line = (n, w, step = 4) => Array.from({ length: n }, (_, i) => ({ x: i * step, y: 0, w: typeof w === "function" ? w(i) : w }));

// ---- smoothing keeps the ends and blends widths
{
  const pts = [{ x: 0, y: 0, w: 2 }, { x: 10, y: 10, w: 6 }, { x: 20, y: 0, w: 2 }];
  const sm = INK.smooth(pts, 2);
  assert.deepEqual(sm[0], pts[0]);
  assert.deepEqual(sm[sm.length - 1], pts[2]);
  assert.ok(sm.length > pts.length, "corners are cut into more points");
  assert.ok(Math.max(...sm.map((p) => p.y)) < 10, "the sharp corner is rounded");
  assert.ok(sm.every((p) => p.w >= 2 && p.w <= 6), "widths stay between their neighbours");
  assert.deepEqual(INK.smooth([{ x: 1, y: 1, w: 1 }], 2), [{ x: 1, y: 1, w: 1 }]);
}

// ---- tapers: thin tips, full middle, and a start that never changes as the stroke grows
{
  const t = INK.taper(line(60, 10));
  assert.ok(Math.abs(t[0].w - 10 * INK.TAPER_MIN) < 1e-9, "the first point is the thin tip");
  assert.ok(Math.abs(t[59].w - 10 * INK.TAPER_MIN) < 1e-9, "so is the last");
  assert.equal(t[30].w, 10, "the middle keeps its width");
  const short = INK.taper(line(20, 10)), long = INK.taper(line(60, 10));
  for (let i = 0; i < 8; i++) assert.equal(short[i].w, long[i].w, "the start taper depends only on the start");
  const noEnd = INK.taper(line(60, 10), { start: true, end: false });
  assert.equal(noEnd[59].w, 10, "end taper can be left off (the pad's cached part)");
}

// ---- the outline sits half a width either side of the line
{
  const E = INK.edges(line(5, 8));
  E.left.forEach((p, i) => assert.ok(Math.abs(Math.abs(p.y) - 4) < 1e-9 && Math.abs(p.x - i * 4) < 1e-9));
  E.right.forEach((p) => assert.ok(Math.abs(Math.abs(p.y) - 4) < 1e-9));
  assert.ok(E.left[0].y * E.right[0].y < 0, "left and right are on opposite sides");
  assert.equal(INK.edges([{ x: 0, y: 0, w: 2 }, { x: 0, y: 0, w: 5 }]).pts.length, 1, "repeated points collapse, keeping the widest");
}

// ---- one fill per stroke (no per-segment strokes: no beads, translucency stays even)
{
  const calls = [];
  const ctx = new Proxy({}, { get: (_, k) => (...a) => calls.push(k) });
  INK.fill(ctx, line(30, (i) => 2 + (i % 7)));
  assert.equal(calls.filter((k) => k === "fill").length, 1);
  assert.equal(calls.filter((k) => k === "stroke").length, 0);
  assert.equal(calls.filter((k) => k === "arc").length, 2, "two round caps");
  assert.ok(calls.includes("quadraticCurveTo"), "curved edges, not facets");
  calls.length = 0;
  INK.fill(ctx, [{ x: 3, y: 3, w: 4 }]);
  assert.deepEqual(calls.filter((k) => k === "arc" || k === "fill"), ["arc", "fill"], "a dot is a disc");
}

// ---- two cached pieces of one stroke meet without a seam (the pad draws long strokes in pieces)
{
  // sparse samples on a bend, like a fast pen: smoothing still leaves small corners there
  const curve = Array.from({ length: 60 }, (_, i) => ({ x: i * 25, y: 160 * Math.sin(i / 4), w: 6 + 3 * Math.sin(i / 5) }));
  const rec = () => { const pts = []; return { pts, moveTo: (x, y) => pts.push(["m", x, y]), lineTo: (x, y) => pts.push(["l", x, y]),
    quadraticCurveTo: (cx, cy, x, y) => pts.push(["q", x, y]), arc() {}, closePath() {}, beginPath() {}, fill() {} }; };
  const A = rec(), B = rec();
  INK.fillRange(A, curve, 0, 30);
  INK.fillRange(B, curve, 30, 59);
  const aJoin = A.pts.find((p) => p[0] === "l"); // the first piece's edge where it stops, just before its end cap
  const bJoin = B.pts[0]; // the second piece's edge where it starts
  assert.ok(Math.hypot(aJoin[1] - bJoin[1], aJoin[2] - bJoin[2]) < 0.01, "both pieces reach the same edge at the join (" + Math.hypot(aJoin[1] - bJoin[1], aJoin[2] - bJoin[2]) + ")");
}

// ---- saving a pen stroke keeps where only the pressure changed
{
  const pts = Array.from({ length: 40 }, (_, i) => [i, 0]);
  const ks = pts.map((_, i) => (i < 20 ? 1 : 2.5)); // a straight line that gets heavier half way
  const d = S.createDoc ? S.createDoc() : { version: 1, points: [], objects: [] };
  S.addStroke(d, pts, 0.6, { w: 0.5, k: ks });
  const o = d.objects[d.objects.length - 1];
  assert.ok(o.pts.length > 2, "the width change survives simplification (" + o.pts.length + " points)");
  assert.ok(o.k && o.k.includes(1) && o.k.includes(2.5));
  const flat = S.createDoc ? S.createDoc() : { version: 1, points: [], objects: [] };
  S.addStroke(flat, pts, 0.6, { w: 0.5, k: pts.map(() => 1) });
  assert.equal(flat.objects[flat.objects.length - 1].pts.length, 2, "an even straight line still collapses to its ends");
  const plain = S.createDoc ? S.createDoc() : { version: 1, points: [], objects: [] };
  S.addStroke(plain, pts, 0.6);
  assert.equal(plain.objects[plain.objects.length - 1].pts.length, 2, "strokes without width are unchanged");
}

// ---- pad feel helpers
{
  assert.equal(DESK.easePressure(0, 0.8), 0.8, "a fresh stroke starts at the real pressure");
  const e = DESK.easePressure(0.2, 1);
  assert.ok(e > 0.2 && e < 1, "a jump is eased");
  assert.equal(DESK.easePressure(0.5, NaN), 0.5 * 0.6, "a missing reading eases toward zero, never NaN");

  assert.equal(DESK.tiltFactor(Math.PI / 2), 1, "upright Pencil: normal width");
  assert.equal(DESK.tiltFactor(undefined, 0, 0), 1, "no tilt data: normal width");
  assert.ok(DESK.tiltFactor(Math.PI / 2 - 0.3) < 1.01, "a natural writing angle changes nothing");
  assert.ok(Math.abs(DESK.tiltFactor(0.2) - 1.8) < 1e-9, "laid low: broad, like shading");
  assert.ok(DESK.tiltFactor(undefined, 50, 30) > 1.3, "tiltX/tiltY work when altitudeAngle is missing");

  assert.deepEqual(DESK.streamline(null, [0.5, 0.5], 2), [0.5, 0.5], "the first point is exact");
  assert.deepEqual(DESK.streamline([0, 0], [1, 1], 0), [1, 1], "« Lissage : non » follows the pen exactly");
  const strong = DESK.streamline([0, 0], [1, 0], 2), light = DESK.streamline([0, 0], [1, 0], 1);
  assert.ok(strong[0] < light[0] && light[0] < 1, "stronger smoothing trails further");

  assert.equal(DESK.flushWait(1000, 0), 0, "nothing sent recently: send now");
  assert.equal(DESK.flushWait(1005, 1000), 7, "just sent: wait out the gap");

  assert.equal(DESK.safeColor("#9fb0c3"), "#9fb0c3");
  assert.equal(DESK.safeColor("rgba(10, 20, 30, .5)"), "rgba(10, 20, 30, .5)");
  for (const bad of ["red;background:url(x)", "url(javascript:x)", "", null, "#12", "expression(1)"]) assert.equal(DESK.safeColor(bad), null, String(bad));
}

console.log("check_hq_ink: ok");
