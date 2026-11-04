import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { bustPullResponse: pull, bustPullSpring: spring, bustPullSettle: settle, bustPullGravity: gravity, bustPullFollow: follow, rigSecondaryMotion: secondary, rigHairMotion: hair, anchoredPullFrame: anchored } = require("../assets/hq-companion.js").pure;

for (const size of [72, 112, 168]) {
  assert.deepEqual(pull(0, 0, size), { x: 0, y: 0, tension: 0 });
  const a = pull(15, 20, size), opposite = pull(-15, -20, size);
  assert.ok(Math.abs(a.x / a.y - 15 / 20) < 1e-10, "diagonal drags preserve the hand direction");
  assert.equal(a.x, -opposite.x);
  assert.equal(a.y, -opposite.y);
  const distances = [0, 5, 10, 15, 20, 25].map(n => pull(n, 0, size).x);
  const increments = distances.slice(1).map((v, i) => v - distances[i]);
  assert.ok(increments[0] > 1, "small movements respond immediately");
  increments.forEach((v, i) => {
    assert.ok(v > 0, "resistance never reverses a drag");
    if (i) assert.ok(v < increments[i - 1], "resistance progressively increases");
  });
  const far = pull(9000, -9000, size);
  assert.ok(Math.hypot(far.x, far.y) <= size * .160001, "large drags remain inside the safe deformation limit");
  assert.ok(far.tension <= 1 && far.tension > .99);
  for (const [x, y] of [[0, 0], [2, 3], [100, -100], [9000, 0], [0, -9000]]) {
    const frame = { x, y, tension: .8 }, a = anchored(frame, size, size);
    assert.ok(a.stretch >= .5 && a.stretch <= 3, "the texture never folds or inverts");
    const anchor = size * .62;
    for (const seamX of [size * .2, size * .5, size * .8]) {
      assert.equal(seamX + a.shear * (anchor - anchor), seamX, "every point on the attachment seam stays fixed");
      assert.equal(anchor + a.stretch * (anchor - anchor), anchor);
    }
    assert.ok(Math.abs(a.shear * size * .18 - a.x) < 1e-8, "the grab region follows the horizontal drag");
    assert.equal(a.tension, .8, "resistance does not step the expression or sound envelope");
  }
  assert.ok(pull(size * 2, 0, size, .52).x > size * .5, "deep drags have enough reach to leave the ring");
  const mobile = anchored(pull(size * 2, size * 2, size, .18), size, size, .18, 1.45);
  assert.ok(mobile.stretch <= 1.45 && mobile.stretch >= .72, "mobile transform remains within its own stretch envelope");
  assert.ok(mobile.x <= size * .18 + 1e-8, "mobile horizontal motion stays inside the touch cap");
  const settlingMobile = anchored({ x: settle(size * .18, 40, .5), y: 0, tension: 0 }, size, size, .18, 1.45, .18);
  assert.ok(settlingMobile.x <= size * .18 + 1e-8, "the mobile cap also holds during release");
}

assert.equal(spring(20, 0, 0), 20, "release starts exactly at the held position");
assert.ok(Math.abs((spring(20, 40, .00001) - 20) / .00001 - 40) < .05,
  "release carries the hand velocity without a position jump");
const settled = Array.from({ length: 73 }, (_, i) => spring(20, 0, i / 100));
assert.ok(Math.min(...settled) < 0, "release crosses the resting point");
assert.ok(Math.min(...settled) > -1, "overshoot stays small");
assert.ok(Math.abs(settled.at(-1)) < .02, "spring settles before handing back to idle");
const outward = Array.from({ length: 73 }, (_, i) => spring(20, 80, i / 100));
assert.ok(Math.max(...outward) < 20 * 1.04, "outward inertia stays restrained");
const target = { x: 20, y: -10, tension: .8 };
const first = follow({ x: 0, y: 0, tension: 0 }, target, .016);
assert.ok(first.x > 0 && first.x < target.x, "held drag reacts promptly with a little weight");
const second = follow(first, target, .016);
assert.ok(second.x > first.x && second.x < target.x, "held drag continues toward the hand without overshooting");
assert.deepEqual(follow(first, target, .016, true), target, "reduced motion follows directly");
assert.equal(settle(20, 40, 0), 20, "long settle starts exactly at the held position");
const tail = Array.from({ length: 61 }, (_, i) => settle(20, 0, 1.2 + i / 100));
assert.ok(Math.max(...tail) - Math.min(...tail) > .5, "small jiggle remains visible well after the main spring");
assert.ok(Math.abs(settle(20, 0, 2.2)) < .001, "the tail fades cleanly at the end");
assert.equal(gravity(20, 0), 0, "gravity preserves the release position and velocity");
assert.ok(gravity(20, .55) > gravity(20, .15), "weight gathers after release");
assert.ok(gravity(20, 1.4) < gravity(20, .55), "the downward dip relaxes");
assert.ok(gravity(1000, .55, 1.4) <= 1.4, "mobile gravity stays bounded");
assert.equal(gravity(20, 2.2), 0, "gravity finishes with the settling motion");
assert.deepEqual(secondary(0, 0), { shear: 0, stretch: 1 }, "idle physics starts at the registered seam");
assert.ok(secondary(4, -4).shear > 0 && secondary(4, -4).stretch > 1, "secondary motion follows lateral and vertical impulses");
assert.ok(secondary(100, -100).shear <= .16 && secondary(100, -100).stretch <= 1.1, "other animations cannot overextend the rig");
assert.deepEqual(hair(0, 0, 0, 0), { x: 0, y: 0, rotation: 0 }, "hair rests at the registered pose");
assert.ok(hair(0, 0, 0, 1).y > 0, "hair moves slightly with the idle breath");
assert.ok(hair(5, -5, 5, 0).x > 0 && hair(5, -5, 5, 0).y < 0, "hair follows existing directional inertia");
assert.ok(hair(0, 0, 0, 0, 1).x > 1 && hair(0, 0, 0, 0, -1).x < -1, "the breeze sways hair both ways");
const hairLimit = hair(100, -100, 100, 1);
assert.ok(hairLimit.x <= 4.5 && hairLimit.y >= -2.8 && hairLimit.rotation <= 2.8, "hair remains inside its visual bounds");
console.log("check_hq_companion_pull: resistance, direction, limits, velocity and settling ok");
