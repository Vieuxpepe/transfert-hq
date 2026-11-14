// Dessiner v5 3D model in the browser core (hq-sketch-core.js): steps, editable values, validation. Run: node tests/check_hq_solid_v5.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");

function box() {
  const d = S.createDoc();
  const r = S.addRect(d, { x: 0, y: 0 }, { x: 100, y: 60 });
  const res = S.addFeature(d, "extrude", r.lines, 20, "blind");
  assert.ok(res.ok, res.error);
  return { doc: res.doc, rect: r };
}

// a plain extrusion stays a version-2-era drawing: nothing new forced on old readers
{
  const { doc } = box();
  assert.ok(doc.version < S.SOLID_V5_VERSION);
  assert.ok(S.validateDoc(doc).ok);
}

// holes, pattern, shell
{
  let { doc } = box();
  const c = S.addCircle(doc, { x: 20, y: 20 }, 4);
  const h = S.addSolidStep(doc, { type: "hole", at: [c], standard: "M3", fit: "countersunk", extent: "throughAll" });
  assert.ok(h.ok, h.error);
  assert.equal(h.doc.version, S.SOLID_V5_VERSION, "a v5 step raises the version");
  assert.equal(S.addSolidStep(doc, { type: "hole", at: [c], standard: "M7", fit: "clearance" }).ok, false, "unknown size refused");
  assert.equal(S.addSolidStep(doc, { type: "hole", at: [doc.features[0].profile[0]], standard: "M3", fit: "clearance" }).ok, false, "a hole sits on a circle");
  const p = S.addSolidStep(h.doc, { type: "pattern", source: h.id, mode: "circular", count: 6, cx: 50, cy: 30, angle: 360 });
  assert.ok(p.ok, p.error);
  assert.equal(S.addSolidStep(h.doc, { type: "pattern", source: doc.features[0].id, mode: "linear", count: 3, dx: 5 }).ok, false, "only a cut or hole repeats");
  const sh = S.addSolidStep(p.doc, { type: "shell", thickness: 2, open: true });
  assert.ok(sh.ok, sh.error);
  assert.equal(S.addSolidStep(sh.doc, { type: "shell", thickness: 1 }).ok, false, "one shell per part");
  // change a number, the model follows
  const e1 = S.updateFeature(sh.doc, p.id, { count: 8 });
  assert.ok(e1.ok); assert.equal(e1.doc.features[2].count, 8);
  assert.equal(S.updateFeature(sh.doc, p.id, { count: 99 }).ok, false, "out-of-range edits are refused");
  assert.equal(S.updateFeature(sh.doc, h.id, { at: [] }).ok, false, "structure is not editable inline");
  const e2 = S.updateFeature(sh.doc, h.id, { standard: "M5", extent: "blind", depth: 6 });
  assert.ok(e2.ok, e2.error); assert.deepEqual([e2.doc.features[1].standard, e2.doc.features[1].depth], ["M5", 6]);
  const e3 = S.updateFeature(sh.doc, sh.id, { open: false, thickness: 3 });
  assert.ok(e3.ok); assert.deepEqual([e3.doc.features[3].open, e3.doc.features[3].thickness], [false, 3]);
  const e4 = S.updateFeature(sh.doc, sh.doc.features[0].id, { depth: 35 });
  assert.ok(e4.ok); assert.equal(e4.doc.features[0].depth, 35);
  // removing a hole removes the repetitions of it
  const rm = S.removeFeature(sh.doc, h.id);
  assert.ok(rm.ok); assert.deepEqual(rm.doc.features.map(f => f.type), ["extrude", "shell"]);
  // circles keep their editable radius
  const cr = S.setCircleRadius(sh.doc, c, 6.5);
  assert.ok(cr.ok); assert.equal(S.getObj(cr.doc, c).r, 6.5);
  assert.equal(S.setCircleRadius(sh.doc, c, -1).ok, false);
}

// revolve: a base only, with an axis that is not part of the profile
{
  const d = S.createDoc();
  const r = S.addRect(d, { x: 0, y: 0 }, { x: 10, y: 40 });
  const ax = S.addLine(d, { x: 0, y: -5 }, { x: 0, y: 45 }, "centerline");
  const rv = S.addSolidStep(d, { type: "revolve", profile: r.lines, axis: ax, angle: 270 });
  assert.ok(rv.ok, rv.error);
  assert.equal(rv.doc.features[0].type, "revolve");
  const boss = S.addSolidStep(rv.doc, { type: "revolve", profile: r.lines, axis: ax });
  assert.ok(boss.ok && boss.doc.version === S.SKETCH_VERSION && boss.doc.features[1].op === "add", "a second revolve is a v6 boss (exact engine)");
  assert.equal(S.addSolidStep(d, { type: "revolve", profile: r.lines, axis: r.lines[0] }).ok, false, "the axis is not part of the profile");
  assert.equal(S.updateFeature(rv.doc, rv.doc.features[0].id, { angle: 400 }).ok, false);
  assert.ok(S.updateFeature(rv.doc, rv.doc.features[0].id, { angle: 180 }).ok);
}

console.log("check_hq_solid_v5: ok");
