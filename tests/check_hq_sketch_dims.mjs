// Ø / R dimensions: leader geometry, real value, REF flag and tolerance suffix (hq-sketch-core.js), plus what happens
// when their circle disappears. Run: node tests/check_hq_sketch_dims.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const O = (d, id) => S.getObj(d, id);
const v6 = () => { const d = S.createDoc(); d.version = S.SKETCH_VERSION; d.sketches = []; return d; };

// a Ø cote on a circle: leader through the centre, value 2r, diameter glyph
{
  const d = v6();
  const c = S.addCircle(d, { x: 10, y: 20 }, 5);
  const dia = S.addDimDiameter(d, c, 0, "");
  const rad = S.addDimRadius(d, c, Math.PI / 2, "");
  assert.ok(dia && rad, "les deux cotes sont créées");
  assert.equal(O(d, dia).type, "dim_diameter");
  assert.equal(O(d, rad).type, "dim_radius");
  const g = S.dimRadialGeom(d, O(d, dia));
  assert.equal(g.value, 10);
  assert.deepEqual(g.edge.map(v => Math.round(v)), [15, 20]); // ang 0 → edge on +X of the centre (10,20), r 5
  assert.deepEqual(g.far.map(v => Math.round(v)), [5, 20]);  // the far arrow is across the centre
  assert.equal(S.dimRadialLabel(d, O(d, dia)), "\u230010");
  assert.equal(S.dimRadialLabel(d, O(d, rad)), "R5");
  assert.deepEqual(S.objectBox(d, O(d, dia)), [5, 15, 15, 25]);
  assert.ok(S.validateDoc(d).ok);
}

// REF flag, tolerance suffix and a manual label
{
  const d = v6();
  const c = S.addCircle(d, { x: 0, y: 0 }, 3);
  const id = S.addDimDiameter(d, c, 0.5);
  let r = S.updateObject(d, id, { ref: true });
  assert.ok(r.ok, r.error);
  assert.equal(S.dimRadialLabel(r.doc, O(r.doc, id)), "(\u23006)");
  r = S.updateObject(r.doc, id, { tol: "±0,1" });
  assert.equal(S.dimRadialLabel(r.doc, O(r.doc, id)), "(\u23006 ±0,1)");
  r = S.updateObject(r.doc, id, { label: "Ø6 H7" });
  assert.equal(S.dimRadialLabel(r.doc, O(r.doc, id)), "(Ø6 H7 ±0,1)");
  r = S.updateObject(r.doc, id, { ref: false, tol: "" });
  assert.equal(S.dimRadialLabel(r.doc, O(r.doc, id)), "Ø6 H7");
  r = S.updateObject(r.doc, id, { ang: 1.25 });
  assert.equal(O(r.doc, id).ang, 1.25);
  assert.ok(S.validateDoc(r.doc).ok);
}

// an arc can be dimensioned with R, and the geometry follows the arc's own radius
{
  const d = v6();
  const arc = S.addArc(d, { x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 8 });
  const id = S.addDimRadius(d, arc, 0);
  const g = S.dimRadialGeom(d, O(d, id));
  assert.equal(g.value, 8);
  assert.equal(S.dimRadialLabel(d, O(d, id)), "R8");
}

// only a circle or an arc can carry one
{
  const d = v6();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(S.addDimDiameter(d, l), null);
  assert.equal(S.addDimRadius(d, "c404"), null);
}

// the circle goes: the cote is reported, refused by the document check, and repaired away
{
  const d = v6();
  const c = S.addCircle(d, { x: 0, y: 0 }, 4);
  const id = S.addDimDiameter(d, c, 0);
  const d2 = S.deleteObjects(d, [c]);
  assert.equal(S.dimRadialGeom(d2, O(d2, id)), null);
  assert.deepEqual(S.diagnose(d2).issues.map(i => i.kind), ["dim.item"]);
  assert.equal(S.validateDoc(d2).ok, false);
  const rep = S.repair(d2);
  assert.ok(rep.ok, rep.error);
  assert.deepEqual(rep.actions.map(a => a.kind), ["dim.item"]);
  assert.equal(S.getObj(rep.doc, id), null);
  assert.equal(S.validateDoc(rep.doc).ok, true);
}

// the drawing extents include a cote whose leader points outward
{
  const d = v6();
  const c = S.addCircle(d, { x: 0, y: 0 }, 5);
  S.addDimRadius(d, c, 0);
  const e = S.extents(d);
  assert.ok(e.x0 <= -5 && e.x1 >= 5 && e.y0 <= -5 && e.y1 >= 5, JSON.stringify(e));
}

console.log("check_hq_sketch_dims: ok");
