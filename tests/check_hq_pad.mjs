/* Pad shape snap + stroke width. Run: node tests/check_hq_pad.mjs */
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Snap = require("../assets/hq-shape-snap.js");
const S = require("../assets/hq-sketch-core.js");
const DESK = require("../assets/hq-desk.js");

function line(n, noise, bend) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const y = (bend || 0) * Math.sin(t * Math.PI) + ((i % 2 ? 1 : -1) * (noise || 0));
    pts.push([0.1 + t * 0.8, 0.5 + y]);
  }
  return pts;
}

function circle(n, noise) {
  const pts = [];
  const cx = 0.5, cy = 0.5, r = 0.2;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const j = (i % 2 ? 1 : -1) * (noise || 0);
    pts.push([cx + Math.cos(a) * (r + j), cy + Math.sin(a) * (r + j)]);
  }
  return pts;
}

function rect(noise) {
  const pts = [];
  const corners = [[0.2, 0.3], [0.8, 0.3], [0.8, 0.7], [0.2, 0.7], [0.2, 0.3]];
  for (let e = 0; e < 4; e++) {
    for (let i = 0; i < 8; i++) {
      const t = i / 8;
      const x = corners[e][0] + (corners[e + 1][0] - corners[e][0]) * t;
      const y = corners[e][1] + (corners[e + 1][1] - corners[e][1]) * t;
      pts.push([x + (i % 2 ? noise : -noise), y + (i % 2 ? -noise : noise)]);
    }
  }
  pts.push(corners[4].slice());
  return pts;
}

const noisyLine = Snap.recognise(line(40, 0.004));
assert.equal(noisyLine && noisyLine.kind, "line", "a noisy straight stroke is a line");
assert.equal(Snap.recognise(line(40, 0.05)), null, "a bent stroke stays freehand");

const round = Snap.recognise(circle(64, 0.004));
assert.equal(round && round.kind, "circle", "a closed noisy loop is a circle");
assert.ok(round && Math.abs(round.params.r - 0.2) < 0.02, "radius stays near the synthetic circle");
assert.equal(Snap.recognise(circle(64, 0.05).slice(0, 20)), null, "an open arc is not a circle");

const box = Snap.recognise(rect(0.002));
assert.equal(box && box.kind, "rect", "four square corners become a rectangle");
assert.ok(box && box.params.a[0] < box.params.b[0] && box.params.a[1] < box.params.b[1]);

const tilted = rect(0).map(([x, y]) => {
  const dx = x - 0.5, dy = y - 0.5, a = 0.4;
  return [0.5 + dx * Math.cos(a) - dy * Math.sin(a), 0.5 + dx * Math.sin(a) + dy * Math.cos(a)];
});
assert.equal(Snap.recognise(tilted), null, "a rotated rectangle is not an axis-aligned entity");

const scribble = [];
for (let i = 0; i < 30; i++) scribble.push([0.2 + (i % 5) * 0.1, 0.2 + ((i * 3) % 7) * 0.08]);
assert.equal(Snap.recognise(scribble), null, "a scribble stays freehand");

const doc = S.createDoc({ units: "mm" });
assert.equal(doc.version, 2);
const id = S.addStroke(doc, [[0, 0], [10, 1], [20, 0]], 0, { w: 1.5, k: [1, 0.4, 1.2] });
assert.equal(doc.version, 4, "a width bumps the document");
const stroke = S.getObj(doc, id);
assert.equal(stroke.pts.length, 3);
assert.equal(stroke.w, 1.5);
assert.deepEqual(stroke.k, [1, 0.4, 1.2]);
assert.equal(S.validateDoc(doc).ok, true);
assert.ok(Math.abs(S.strokePx(stroke.w, stroke.k[1], 10) - 6) < 1e-6, "screen width is w * factor * ppu");

const legacy = S.createDoc();
S.addStroke(legacy, [[0, 0], [5, 5], [10, 0]], 0);
assert.equal(legacy.version, 2);
assert.equal(S.getObj(legacy, "s1").w, undefined);
assert.equal(S.validateDoc(legacy).ok, true);
assert.equal(S.strokePx(undefined, 1, 10), 2, "old strokes keep the 2 px hairline");

const rejected = S.clone(doc);
rejected.version = 3;
assert.equal(S.validateDoc(rejected).ok, false, "width is illegal before version 4");
const badK = S.clone(doc);
badK.objects[0].k = [1];
assert.equal(S.validateDoc(badK).ok, false, "factors must match the points");

const cm = S.convertUnits(doc, "cm");
assert.equal(cm.ok, true);
assert.ok(Math.abs(cm.doc.objects.find((o) => o.type === "stroke").w - 0.15) < 1e-6, "width converts with the units");
assert.deepEqual(cm.doc.objects.find((o) => o.type === "stroke").k, [1, 0.4, 1.2], "factors are dimensionless");

const oldRead = S.clone(legacy);
oldRead.version = 1;
assert.equal(S.validateDoc(oldRead).ok, true, "version 1 still reads");

const step0 = DESK.replayStep({ t0: 1000, delay: 40, events: [
  { op: "pt", t: 0, p: [0, 0] }, { op: "pt", t: 10, p: [1, 0] }, { op: "pt", t: 20, p: [2, 0] }, { op: "end" },
] }, 1030);
assert.equal(step0.release.length, 0, "nothing is due before its timestamp plus the delay");
assert.ok(step0.wait > 0);
const step1 = DESK.replayStep({ t0: 1000, delay: 40, events: step0.rest }, 1040);
assert.equal(step1.release[0].t, 0);
assert.equal(step1.release.length, 1, "points leave in timestamp order");
const step2 = DESK.replayStep({ t0: 1000, delay: 40, events: step1.rest }, 1060);
assert.deepEqual(step2.release.map((e) => e.op), ["pt", "pt", "end"], "end waits until the points before it are out");
const gap = DESK.replayStep({ t0: 0, delay: 40, events: [{ op: "pt", t: 2000, p: [0, 0] }] }, 100);
assert.equal(gap.release.length, 0, "a 2 s gap is not released early");
assert.ok(gap.wait > 1800);
const late = DESK.replayStep({ t0: 0, delay: 40, events: [{ op: "pt", t: 2000, p: [0, 0] }] }, 2100);
assert.equal(late.release.length, 1);
const old = DESK.replayStep({ t0: 0, delay: 40, events: [{ op: "pt", t: null, p: [0, 0] }, { op: "end" }] }, 0);
assert.deepEqual(old.release.map((e) => e.op), ["pt", "end"], "points without a time are added at once");
const nowish = DESK.replayStep({ t0: 0, delay: 80, immediate: true, events: [{ op: "pt", t: 500, p: [1, 1] }, { op: "end" }] }, 0);
assert.equal(nowish.release.length, 2, "reduced motion does not delay");
assert.equal(DESK.tuneDelay(40, 0), 26);
assert.equal(DESK.tuneDelay(20, 0), 20);
assert.equal(DESK.tuneDelay(40, 500), 150);
assert.equal(DESK.retryDecision(0, 100), "retry");
assert.equal(DESK.retryDecision(503, 100), "retry");
assert.equal(DESK.retryDecision(400, 100), "drop");
assert.equal(DESK.retryDecision(0, 20001), "drop");
assert.equal(DESK.retryWait(1), 250);
assert.equal(DESK.retryWait(6), 2000);
const ramp = [];
for (let i = 1; i <= 8; i++) ramp.push({ p: i / 8, target: Math.pow(i / 8, 2) });
assert.ok(Math.abs(DESK.fitGamma(ramp) - 2) <= 0.1, "gamma fits a squared pressure ramp");
assert.equal(DESK.fitGamma([]), 1);
assert.equal(DESK.ringGuard({ kind: "touch", sincePen: -1, width: 8, height: 8, fingers: 1, moved: 0 }), true);
assert.equal(DESK.ringGuard({ kind: "pen" }), false);
assert.equal(DESK.ringGuard({ kind: "touch", penDown: true }), false);
assert.equal(DESK.ringGuard({ kind: "touch", sincePen: 100, width: 8, height: 8 }), false);
assert.equal(DESK.ringGuard({ kind: "touch", sincePen: -1, width: 60, height: 40 }), false);
assert.equal(DESK.ringGuard({ kind: "touch", sincePen: -1, width: 8, height: 8, fingers: 2 }), false);

console.log("check_hq_pad: ok");

// Regression: a 3D face feature or a fillet must never downgrade a version-4 drawing (it may hold stroke widths).
{
  const d = S.createDoc({ units: "mm", spacing: 10 });
  const tri = [S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 }), S.addLine(d, { x: 10, y: 0 }, { x: 10, y: 10 }), S.addLine(d, { x: 10, y: 10 }, { x: 0, y: 0 })];
  const solid = S.addFeature(d, "extrude", tri, 5, "blind");
  assert.ok(solid.ok, solid.error);
  const doc = solid.doc;
  S.addStroke(doc, [[0, 20], [10, 20], [20, 25]], 0, { w: 0.8, k: [1, 1.5, 0.5] });
  assert.equal(doc.version, 4);
  assert.ok(S.validateDoc(doc).ok);
  const plane = { origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };
  const face = S.addFaceFeature(doc, "extrude", plane, [[0, 0], [5, 0], [5, 5]], 2, "blind");
  assert.ok(face.ok, face.error);
  assert.equal(face.doc.version, 4, "a face feature keeps version 4");
  const round = S.addRoundFeature(face.doc, [0, 0, 0], [5, 0, 0], 1);
  assert.ok(round.ok, round.error);
  assert.equal(round.doc.version, 4, "a fillet keeps version 4");
  assert.ok(S.validateDoc(round.doc).ok, "and the drawing still validates");
}
console.log("check_hq_pad: version guard ok");

// Send queue: points drawn while a message is on the wire (or waiting to retry) must never merge into it.
{
  const posted = [];
  let release = null, failNext = true;
  const fakeWin = {
    crypto: { getRandomValues: (b) => b.fill(7) },
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)),
    api: (path, opts) => {
      const body = JSON.parse(opts.body);
      return new Promise((ok, bad) => {
        release = () => {
          if (failNext) { failNext = false; const e = new Error("net"); e.status = 0; bad(e); return; }
          posted.push(body); ok({ ok: true });
        };
      });
    },
  };
  const L = DESK.link(fakeWin, "phone");
  const tick = () => new Promise((r) => setTimeout(r, 15));
  L.send("pc", "pad", { op: "move", s: 1, pts: [[0, 0, 0.01, 0]] });
  await tick();
  L.send("pc", "pad", { op: "move", s: 1, pts: [[0.1, 0.1, 0.01, 10]] }); // drawn while the first is in flight
  release(); await tick(); // the first send fails; its retry must go out exactly as first sent
  L.send("pc", "pad", { op: "move", s: 1, pts: [[0.2, 0.2, 0.01, 20]] }); // drawn while it waits to retry
  release(); await tick(); // the retry succeeds
  L.send("pc", "pad", { op: "move", s: 1, pts: [[0.3, 0.3, 0.01, 30]] }); // drawn while the next one is in flight
  for (let i = 0; i < 6 && L.queue.length; i++) { if (release) { const r = release; release = null; r(); } await tick(); }
  const got = posted.flatMap((b) => b.data.pts.map((p) => p[3]));
  assert.deepEqual(got, [0, 10, 20, 30], "every point arrives once, in order, even across a retry");
  assert.equal(new Set(posted.map((b) => b.data.id)).size, posted.length, "each delivered message has its own id");
  assert.ok(posted.every((b) => Object.keys(b).sort().join() === "client,data,to,type"), "only the relay's own fields go on the wire");
}
console.log("check_hq_pad: send queue ok");
