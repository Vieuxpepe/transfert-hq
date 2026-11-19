// Gaze policy: one full turn, sampled at 60 Hz, with no browser and no timers.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const G = require('../assets/hq-companion-gaze.js');

const FRAME = 1000 / 60;
let now = 1000;
const st = G.create();
const feed = (extra = {}) => {
  now += FRAME;
  return G.step(st, Object.assign({now, dt: FRAME}, extra));
};
const cursor = (dx, dy, at = now) => ({dx, dy, at});
const run = (frames, extra = {}) => {
  const out = [];
  for (let i = 0; i < frames; i += 1) out.push(feed(Object.assign({}, extra, {
    pointer: typeof extra.pointer === 'function' ? extra.pointer() : extra.pointer,
  })));
  return out;
};

// 1. He points at her: the eyes follow the cursor, in one short saccade, bounded.
let frames = run(30, {pointer: () => cursor(220, 120)});
assert.ok(frames.every(f => Math.abs(f.x) <= G.MAX_X && Math.abs(f.y) <= G.MAX_Y));
const firstStep = Math.hypot(frames[0].x, frames[0].y);
assert.ok(firstStep <= G.SPEED + 0.11, 'the first frame is a saccade, not a jump: ' + firstStep);
assert.equal(frames[frames.length - 1].mode, 'cursor');
assert.ok(frames[frames.length - 1].x > 1.8 && frames[frames.length - 1].y > 0.6);

// 2. He sends a message: composing turns the eyes away and slightly down.
frames = run(18, {composing: true, pointer: () => cursor(220, 120)});
assert.equal(frames[frames.length - 1].mode, 'aversion');
assert.ok(frames[frames.length - 1].y >= 1.4, 'aversion looks down');
assert.ok(Math.abs(Math.abs(frames[frames.length - 1].x) - G.AVERSION_X) < 0.11);
const aversionX = frames[frames.length - 1].x;
const steps = frames.slice(1).map((f, i) => Math.hypot(f.x - frames[i].x, f.y - frames[i].y));
assert.ok(steps.every(s => s <= G.SPEED + 0.11), 'aversion is a saccade too');
// Long composition flips the side, but never jumps.
frames = run(130, {composing: true});
assert.ok(frames.some(f => Math.abs(f.x - aversionX) > 1), 'a long pause changes the aversion side');

// 3. She starts speaking: the eyes come back, at saccade speed.
const fromAversion = {x: st.x, y: st.y};
frames = run(20, {speaking: true, pointer: () => cursor(-200, -150)});
assert.equal(frames[frames.length - 1].mode, 'speak');
assert.ok(frames[frames.length - 1].x < 0, 'she looks back toward him while talking');
assert.ok(Math.abs(frames[0].x - fromAversion.x) <= G.SPEED + 0.11);

// 4. A reply lands in the bubble: one look toward it, then released.
const anchor = {x: -2.4, y: 2.6, until: now + 1400};
frames = run(12, {anchor});
assert.equal(frames[frames.length - 1].mode, 'bubble');
assert.equal(frames[frames.length - 1].y, G.MAX_Y, 'the anchor is clamped to the eyes, not the bubble');
const shortAnchor = {x: -2.4, y: 2.6, until: now + 100};
frames = run(30, {anchor: shortAnchor});
assert.equal(frames[frames.length - 1].mode, 'idle', 'the look at the bubble expires by itself');

// 5. No cursor, not speaking: she holds, then makes a small idle saccade, once.
frames = run(6, {});
assert.equal(frames[frames.length - 1].mode, 'idle');
assert.ok(Math.abs(frames[frames.length - 1].x - frames[0].x) < 0.9, 'idle does not drift');
const held = frames[frames.length - 1];
frames = run(400, {});
assert.equal(frames[frames.length - 1].mode, 'idle');
const moved = Math.hypot(frames[frames.length - 1].x - held.x, frames[frames.length - 1].y - held.y);
assert.ok(moved > 0.5, 'idle still glances somewhere after a hold');
assert.ok(frames.every(f => Math.abs(f.x) <= G.MAX_X && Math.abs(f.y) <= G.MAX_Y));
const idleSteps = frames.slice(1).map((f, i) => Math.hypot(f.x - frames[i].x, f.y - frames[i].y));
assert.ok(idleSteps.every(s => s <= G.SPEED + 0.11), 'idle glances are saccades, not springs');

// 6. Reduced motion: the eyes stay put and the mode says so.
frames = run(6, {reduced: true, composing: true});
assert.ok(frames.every(f => f.x === 0 && f.y === 0 && f.mode === 'off'));

// 7. The original cursor amplitude is preserved exactly.
assert.deepEqual(G.glance(0, 0), {x: 0, y: 0});
assert.deepEqual(G.glance(480, 0), {x: 2.4, y: 0});
assert.deepEqual(G.glance(0, -480), {x: 0, y: -1.6});

console.log('check_hq_companion_gaze: cursor, aversion, return, bubble, idle hold, reduced motion ok;',
  'max step', G.SPEED, 'px/frame, amplitude', G.MAX_X + 'x' + G.MAX_Y);

// One head: the look sets direction, the gesture shapes it, and both pass one cap.
const {arbitrateHead, HEAD_CAP, ROT_PER_PX} = require('../assets/hq-companion-gaze.js');
const {gestureHead} = require('../assets/hq-companion-mouth.js');
const lookOnly = arbitrateHead({look: -0.51});
assert.ok(lookOnly.total < 0 && Math.abs(lookOnly.total - (-0.51)) < 0.035, 'a look alone survives arbitration');
assert.ok(Math.abs(lookOnly.total) <= 0.51, 'arbitration never amplifies a single look');
const gestureOnly = arbitrateHead({gesture: 0.26});
assert.ok(gestureOnly.total > 0.24 && gestureOnly.total < 0.27, 'a gesture alone keeps its amplitude');
const lead = arbitrateHead({gesture: gestureHead('smile', 60, 1, 1).tilt});
const over = arbitrateHead({gesture: gestureHead('smile', 395, 1, 1).tilt});
const settle = arbitrateHead({gesture: gestureHead('smile', 620, 1, 1).tilt});
assert.ok(lead.total < 0 && over.total > 0, 'the 90 ms counter-move and its overshoot both survive');
assert.ok(over.total > settle.total * 1.12, 'the overshoot is still a peak, not a smoothed ramp: ' + (over.total / settle.total).toFixed(3));
const same = arbitrateHead({look: -0.51, gesture: -0.26});
assert.ok(Math.abs(same.total) < 0.77, 'two drives on the same side decay instead of stacking: ' + same.total);
assert.ok(Math.abs(same.total) > Math.abs(lookOnly.total), 'the gesture still shapes the look it joins');
const oppositeLook = arbitrateHead({look: -0.60});
const opposite = arbitrateHead({look: -0.60, gesture: 0.26});
assert.ok(opposite.total < 0, 'a counter-move never turns the head against the look');
assert.ok(Math.abs(opposite.total) >= Math.abs(oppositeLook.total) * 0.8,
  'the look keeps authority over its own direction: ' + opposite.total + ' vs ' + oppositeLook.total);
const deep = arbitrateHead({look: -1.27, gesture: -0.30});
assert.ok(Math.abs(deep.total) <= HEAD_CAP, 'the composed drive never exceeds its cap');
assert.ok(Math.abs(deep.total) < 1.57, 'a deep look with a gesture is compressed: ' + deep.total);
const nod = arbitrateHead({nod: 0.040, speechNod: 0.034});
assert.ok(nod.nod > 0.040 && nod.nod <= 0.05, 'two nods compress into the rig range: ' + nod.nod);
assert.equal(arbitrateHead({}).total, 0);
assert.equal(arbitrateHead({look: 5}).total, arbitrateHead({look: 99}).total, 'inputs are clamped');
assert.deepEqual(arbitrateHead({look: -0.4, gesture: 0.1}), arbitrateHead({look: -0.4, gesture: 0.1}), 'arbitration is deterministic');
let worst = 0, prev = arbitrateHead({look: -0.51, gesture: gestureHead('hmm', 0, -1, 1).tilt}).total;
for (let t = 0; t <= 1900; t += 1) {
  const cur = arbitrateHead({look: -0.51, gesture: gestureHead('hmm', t, -1, 1).tilt}).total;
  worst = Math.max(worst, Math.abs(cur - prev)); prev = cur;
}
assert.ok(worst < 0.02, 'no frame step above the 0.02 deg/ms budget: ' + worst.toFixed(5));
let flips = 0, lastSign = 0;
for (let t = 0; t <= 1900; t += 1) {
  const v = arbitrateHead({look: -0.51, gesture: gestureHead('hmm', t, -1, 1).tilt}).total;
  const s = Math.sign(v);
  if (s !== lastSign) { flips += 1; lastSign = s; }
}
assert.equal(flips, 1, 'the composed drive holds one direction through the gesture');
console.log('check_hq_companion_gaze: head arbitration ok — look owns direction, gestures shape, cap ' + HEAD_CAP + 'deg');

// One head, one channel: translation and rotation come from the same look.
const lookRight = arbitrateHead({lookX: 4, lookY: -2});
const lookLeft = arbitrateHead({lookX: -4, lookY: 2});
assert.equal(lookRight.x, 4, 'look translation passes through unchanged inside the rig clamp');
assert.equal(lookRight.y, -2);
assert.ok(lookRight.sway > 0 && lookLeft.sway < 0, 'rotation follows the same look as the translation');
const half = arbitrateHead({lookX: 2});
assert.ok(Math.abs(half.sway - lookRight.sway / 2) < .06, 'rotation is proportional to the translation it comes from: '
  + half.sway + ' vs ' + lookRight.sway / 2);
assert.ok(Math.abs(lookRight.sway - HEAD_CAP * Math.tanh(4 * ROT_PER_PX / HEAD_CAP)) < .01, "rotation uses the rig's own per-pixel factor: " + lookRight.sway);
assert.equal(arbitrateHead({lookX: 99}).x, 7.5, 'translation is clamped where the rig clamps it');
assert.equal(arbitrateHead({lookX: 0, lookY: -99}).y, -5.5);
const scaled = arbitrateHead({lookX: 4, scale: 1.4});
assert.ok(scaled.sway > lookRight.sway, 'the circadian/warmth scale still applies to the look rotation');
const turned = arbitrateHead({lookX: -2, gesture: gestureHead('smile', 395).tilt});
assert.ok(turned.x < 0 && turned.sway < 0, 'a gesture cannot reverse the look direction while it owns the head');
assert.ok(Object.values(arbitrateHead({lookX: 3, lookY: 2, gesture: .2, nod: .03}))
  .every(v => Number.isFinite(v)), 'the composed drive is finite on every channel');
for (const t of [0, 60, 230, 395, 620, 900]) {
  const d = arbitrateHead({lookX: 5, lookY: 0, gesture: gestureHead('hmm', t, -1).tilt});
  assert.ok(Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.sway) && Number.isFinite(d.nod));
}
console.log('check_hq_companion_gaze: one composed head drive — translation, rotation, gesture, nod');
