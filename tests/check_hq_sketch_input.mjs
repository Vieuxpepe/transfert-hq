// Dessiner fluid-input helpers (hq-sketch-input.js). Run: node tests/check_hq_sketch_input.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const I = require("../assets/hq-sketch-input.js");
const near = (a, b) => Math.abs(a - b) < 1e-6;

// typed numbers
assert.equal(I.parseNum("120"), 120);
assert.equal(I.parseNum("12,5"), 12.5);
assert.equal(I.parseNum(" 100/4 "), 25);
assert.equal(I.parseNum("2*25+4"), 54);
assert.equal(I.parseNum("(10+2)*2"), 24);
assert.equal(I.parseNum("-7.5"), -7.5);
for (const bad of ["", "abc", "1+", "2**3", "alert(1)", "1/0"]) assert.equal(I.parseNum(bad), null, bad);

// typed shapes: missing values keep the pointer's, signs follow the drag
{
  const a = { x: 10, y: 10 };
  const f = I.fieldsFor("line"); f[0].text = "120";
  const r = I.typedShape("line", a, { x: 10, y: 40 }, f); // dragged straight up
  assert.ok(near(r.b.x, 10) && near(r.b.y, 130), "length typed, direction kept");
  f[1].text = "45";
  const r2 = I.typedShape("line", a, { x: 10, y: 40 }, f);
  assert.ok(near(r2.b.x, 10 + 120 * Math.SQRT1_2) && near(r2.b.y, 10 + 120 * Math.SQRT1_2), "length and angle typed");
  const rf = I.fieldsFor("rect"); rf[0].text = "60"; rf[1].text = "25";
  const rr = I.typedShape("rect", a, { x: -5, y: 3 }, rf); // dragged left and down
  assert.deepEqual(rr.b, { x: -50, y: -15 });
  const cf = I.fieldsFor("circle"); cf[0].text = "7,5";
  assert.equal(I.typedShape("circle", a, { x: 12, y: 10 }, cf).r, 7.5);
  assert.deepEqual(I.fieldsFor("stroke"), []);
}

// alignment guides
{
  const pts = [{ x: 0, y: 0 }, { x: 50, y: 30 }];
  const s = I.alignSnap(pts, { x: 49.6, y: 80 }, 1);
  assert.deepEqual([s.x, s.y, s.gx, s.gy], [50, 80, 50, null], "lines up with X = 50");
  const t = I.alignSnap(pts, { x: 90, y: 0.4 }, 1);
  assert.deepEqual([t.x, t.y, t.gy], [90, 0, 0], "lines up with Y = 0");
  const u = I.alignSnap(pts, { x: 50.2, y: 30.3 }, 1);
  assert.deepEqual([u.gx, u.gy], [null, null], "on the point itself is point snapping's job, not a guide");
}

// automatic constraints
{
  const rules = I.autoRules([
    { id: "h", a: { x: 0, y: 5 }, b: { x: 40, y: 5 } },
    { id: "v", a: { x: 3, y: 0 }, b: { x: 3, y: 9 } },
    { id: "slant", a: { x: 0, y: 0 }, b: { x: 10, y: 1 } },
  ]);
  assert.deepEqual(rules, [{ type: "horizontal", line: "h" }, { type: "vertical", line: "v" }]);
}

// push / pull preview: only the cap side moves
{
  const tri = [[[0, 0, 0], [10, 0, 20], [0, 10, 20]]];
  const out = I.stretch(tri, [0, 0, 1], 20, 5);
  assert.deepEqual(out[0], [[0, 0, 0], [10, 0, 25], [0, 10, 25]]);
}

// the face → extrusion match
{
  const doc = { objects: [{ id: "l1", type: "line" }, { id: "b1", type: "line", sketch: "sk" }], sketches: [{ id: "sk", plane: "XZ", offset: 0 }],
    features: [{ id: "f1", type: "extrude", profile: ["l1"], depth: 20 }, { id: "f2", type: "extrude", profile: ["b1"], depth: 6, op: "add" }] };
  const top = I.capFeature(doc, { origin: [37, 12, 20], normal: [0, 0, 1] });
  assert.equal(top && top.id, "f1", "the top face is the base extrusion's end");
  const front = I.capFeature(doc, { origin: [40, -6, 3], normal: [0, -1, 0] });
  assert.equal(front && front.id, "f2", "the boss' end face on the XZ sketch");
  assert.equal(I.capFeature(doc, { origin: [0, 0, 0], normal: [0, 0, -1] }), null, "the bottom is no extrusion's end");
  doc.features[1].suppressed = true;
  assert.equal(I.capFeature(doc, { origin: [40, -6, 3], normal: [0, -1, 0] }), null, "a suppressed feature has no face");
}

console.log("check_hq_sketch_input: ok");
