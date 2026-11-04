import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const {expressionPose} = require("../assets/hq-companion.js").pure;

const zero = {tilt:0, browLeft:0, browRight:0, nod:0};
for (const primary of ["neutral", "curiosity", "concentration", "reassurance", "pride", "thoughtful", "playful", "toString", "__proto__"]) {
  const plan = {primary, secondary:"attentive"};
  assert.deepEqual(expressionPose(plan, 1000, true), zero, "pull/reduced-motion/drag must suppress the pose");
  assert.deepEqual(expressionPose(plan, 0, false), zero, "no arrival jump");
  assert.deepEqual(expressionPose(plan, 7000, false), zero, "no persistent expression");
  for (const t of [200, 600, 3000, 6500]) {
    const p = expressionPose(plan, t, false);
    assert.ok(Math.abs(p.tilt)<=.65 && Math.abs(p.browLeft)<=.42 && Math.abs(p.browRight)<=.28 && Math.abs(p.nod)<=.004);
  }
}
assert.ok(expressionPose({primary:"curiosity"}, 1000).tilt>0);
assert.ok(expressionPose({primary:"pride",secondary:"cautious"}, 1000).browLeft < expressionPose({primary:"pride"}, 1000).browLeft);
assert.deepEqual(expressionPose(null, NaN), zero);
console.log("Companion character: bounded, blended, fading poses and motion suppression passed");
