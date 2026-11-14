// « Forge peint » scheduling/sizing and the pad's sketch-to-3D gesture helpers. Run: node tests/check_hq_sketch_paint_lift.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const P = require("../assets/hq-sketch-paint.js");
const DESK = require("../assets/hq-desk.js");

// ---- Forge-friendly sizes: the sketch's aspect, multiples of 64, long side 768
for (const [w, h] of [[1200, 800], [800, 1200], [1000, 1000], [1920, 500], [10, 1000]]) {
  const s = P.sizeFor(w, h);
  assert.equal(s.w % 64, 0); assert.equal(s.h % 64, 0);
  assert.equal(Math.max(s.w, s.h), 768);
  assert.ok(Math.min(s.w, s.h) >= 384, "never thinner than 384");
  assert.equal(s.w >= s.h, w >= h, "orientation kept");
}
assert.deepEqual(P.sizeFor(1200, 800), { w: 768, h: 512 });

// ---- live repainting: one at a time, after a short pause, only when something changed
{
  const base = { live: true, prompt: "une cabane", inFlight: false, version: 3, sentVersion: 2, dirtyAt: 1000 };
  assert.equal(P.nextStep(base, 1000 + P.LIVE_DELAY_MS), "paint");
  assert.equal(P.nextStep(base, 1100), "wait", "still drawing: wait for the pause");
  assert.equal(P.nextStep({ ...base, inFlight: true }, 99999), "wait", "never two at once");
  assert.equal(P.nextStep({ ...base, sentVersion: 3 }, 99999), "idle", "nothing new since the last painting");
  assert.equal(P.nextStep({ ...base, live: false }, 99999), "idle", "« En direct » off: only the button paints");
  assert.equal(P.nextStep({ ...base, prompt: "  " }, 99999), "idle", "no description, no painting");
}

// ---- sketch to 3D: two fingers straight up lift; anything else moves the view
{
  const at = (y, x0 = 100, x1 = 160) => [[x0, y], [x1, y]];
  assert.equal(DESK.liftIntent(at(300), at(295), true), "", "too small to decide");
  assert.equal(DESK.liftIntent(at(300), at(288), true), "", "one 12 px step is still undecided");
  assert.equal(DESK.liftIntent(at(300), at(276), true), "lift", "two steps up: a lift");
  assert.equal(DESK.liftIntent(at(300), at(260), true), "lift");
  assert.equal(DESK.liftIntent(at(300), at(260), false), "view", "no closed shape waiting: it is a pan");
  assert.equal(DESK.liftIntent(at(300), at(340), true), "view", "down is a pan");
  assert.equal(DESK.liftIntent(at(300), [[100, 260], [200, 260]], true), "view", "fingers spreading: a pinch");
  assert.equal(DESK.liftIntent(at(300), at(270, 140, 200), true), "view", "mostly sideways: a pan");
  assert.equal(DESK.liftHeight(0, 500), 0);
  assert.equal(DESK.liftHeight(200, 500), 0.5);
  assert.equal(DESK.liftHeight(900, 500), 1, "capped");
  assert.equal(DESK.liftHeight(-50, 500), 0, "never below the paper");
  const q = [{ type: "pad", data: { op: "lift", phase: "move", h: 0.1 } }];
  assert.equal(DESK.mergeMove(q, { type: "pad", data: { op: "lift", phase: "move", h: 0.3 } }), true);
  assert.equal(q[0].data.h, 0.3, "only the latest height travels");
  assert.equal(DESK.mergeMove(q, { type: "pad", data: { op: "lift", phase: "end", h: 0.3 } }), false, "the end is its own message");
}

console.log("check_hq_sketch_paint_lift: ok");
