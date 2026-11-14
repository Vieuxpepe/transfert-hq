// Dessiner v6 sketcher (hq-sketch-core.js): constraint solver, degrees of freedom, drag, arcs, sketches on planes,
// feature tree helpers. Run: node tests/check_hq_sketch_v6.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const P = (d, id) => S.pointMap(d).get(id);

function quad() { // a slightly crooked quadrilateral, v6
  const d = S.createDoc();
  d.version = S.SKETCH_VERSION; d.sketches = [];
  const a = S.addLine(d, { x: 0, y: 0 }, { x: 52, y: 3 });
  const lA = S.getObj(d, a);
  const b = S.addLine(d, { x: 52, y: 3, id: lA.p2 }, { x: 49, y: 31 });
  const lB = S.getObj(d, b);
  const c = S.addLine(d, { x: 49, y: 31, id: lB.p2 }, { x: -2, y: 28 });
  const lC = S.getObj(d, c);
  const e = S.addLine(d, { x: -2, y: 28, id: lC.p2 }, { x: 0, y: 0, id: lA.p1 });
  return { d, ids: [a, b, c, e] };
}

// horizontal / vertical / perpendicular / equal / length: the solver squares the shape up
{
  let { d, ids: [a, b, c, e] } = quad();
  for (const k of [{ type: "horizontal", line: a }, { type: "vertical", line: b }, { type: "horizontal", line: c }, { type: "vertical", line: e }]) {
    const r = S.addConstraint(d, k);
    assert.ok(r.ok, r.error);
    d = r.doc;
  }
  const la = S.getObj(d, a), lb = S.getObj(d, b);
  assert.ok(near(P(d, la.p1).y, P(d, la.p2).y), "horizontal holds");
  assert.ok(near(P(d, lb.p1).x, P(d, lb.p2).x), "vertical holds");
  // degrees of freedom: 4 points x 2 = 8, minus 4 constraints = 4 (position x, y, width, height)
  assert.equal(S.freedom(d).dof, 4);
  assert.equal(S.freedom(d).defined.size, 0, "nothing is fixed yet: everything is blue");
  // a fixed corner and two lengths define it fully
  d = S.addConstraint(d, { type: "fixed", point: la.p1 }).doc;
  d.constraints.push({ id: "kL1", type: "length", line: a, fixed: la.p1, value: 60 });
  d.constraints.push({ id: "kL2", type: "length", line: e, fixed: la.p1, value: 25 });
  const s = S.solve(d);
  assert.ok(s.ok, s.error);
  d = s.doc;
  const f = S.freedom(d);
  assert.equal(f.dof, 0, "fully defined");
  assert.equal(f.defined.size, 4, "all black");
  const origin = P(d, la.p1); // squaring the shape moved this corner before it was fixed: sizes are relative to it
  assert.ok(near(P(d, la.p2).x - origin.x, 60, 1e-6) && near(P(d, S.getObj(d, c).p1).y - origin.y, 25, 1e-6), "sizes applied");
  // a conflicting constraint is refused and leaves the sketch as it was
  const bad = S.addConstraint(d, { type: "vertical", line: a });
  assert.equal(bad.ok, false);
}

// dragging a corner of a constrained shape keeps the constraints
{
  let { d, ids: [a, b, c, e] } = quad();
  for (const k of [{ type: "horizontal", line: a }, { type: "vertical", line: b }, { type: "horizontal", line: c }, { type: "vertical", line: e }]) d = S.addConstraint(d, k).doc;
  const corner = S.getObj(d, b).p2; // shared by b and c
  const moved = S.movePoint(d, corner, 80, 50);
  assert.ok(moved.ok, moved.error);
  const m = moved.doc, lb = S.getObj(m, b), lc = S.getObj(m, c);
  assert.ok(near(P(m, corner).x, 80, 1e-6) && near(P(m, corner).y, 50, 1e-6), "the dragged corner goes where the pointer is");
  assert.ok(near(P(m, lb.p1).x, P(m, lb.p2).x) && near(P(m, lc.p1).y, P(m, lc.p2).y), "and the rectangle stays square");
}

// tangent, equal, radius, parallel
{
  const d0 = S.createDoc(); d0.version = S.SKETCH_VERSION; d0.sketches = [];
  const ln = S.addLine(d0, { x: 0, y: 0 }, { x: 100, y: 0 });
  const c1 = S.addCircle(d0, { x: 30, y: 14 }, 9);
  const c2 = S.addCircle(d0, { x: 70, y: 20 }, 5);
  let d = S.addConstraint(d0, { type: "tangent", items: [ln, c1] }).doc;
  d = S.addConstraint(d, { type: "equal", items: [c1, c2] }).doc;
  const r = S.addConstraint(d, { type: "radius", item: c1, value: 12 });
  assert.ok(r.ok, r.error);
  d = r.doc;
  const C1 = S.getObj(d, c1), C2 = S.getObj(d, c2);
  assert.ok(near(C1.r, 12) && near(C2.r, 12), "equal radii follow the radius");
  const L1 = S.getObj(d, ln), q1 = P(d, L1.p1), q2 = P(d, L1.p2), cc = P(d, C1.center);
  const distToLine = Math.abs((cc.x - q1.x) * (q2.y - q1.y) - (cc.y - q1.y) * (q2.x - q1.x)) / Math.hypot(q2.x - q1.x, q2.y - q1.y);
  assert.ok(near(distToLine, 12, 1e-6), "the circle is tangent to the line (" + distToLine + ")");
  const l2 = S.addLine(d, { x: 0, y: 40 }, { x: 50, y: 47 });
  const par = S.addConstraint(d, { type: "parallel", items: [ln, l2] });
  assert.ok(par.ok, par.error);
  const L2 = S.getObj(par.doc, l2);
  const A1 = S.getObj(par.doc, ln), u = [P(par.doc, A1.p2).x - P(par.doc, A1.p1).x, P(par.doc, A1.p2).y - P(par.doc, A1.p1).y];
  const w = [P(par.doc, L2.p2).x - P(par.doc, L2.p1).x, P(par.doc, L2.p2).y - P(par.doc, L2.p1).y];
  assert.ok(near((u[0] * w[1] - u[1] * w[0]) / (Math.hypot(...u) * Math.hypot(...w)), 0, 1e-9), "the two lines are parallel");
}

// arcs: exact radius, hit test, dragging an end keeps it on the circle
{
  const d = S.createDoc(); d.version = S.SKETCH_VERSION; d.sketches = [];
  const id = S.addArc(d, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 7 });
  assert.ok(id);
  const o = S.getObj(d, id), g = S.arcGeom(o, S.pointMap(d));
  assert.ok(near(g.r, 10) && near(Math.hypot(g.b.x, g.b.y), 10), "the end is projected onto the circle");
  assert.ok(S.validateDoc(d).ok);
  assert.equal(S.hitTest(d, 7.07, 7.07, 0.2), id, "the arc is hit along its sweep");
  assert.equal(S.hitTest(d, -7.07, -7.07, 0.2), null, "but not on the missing part of the circle");
  const m = S.movePoint(d, o.p2, 0, 15);
  assert.ok(m.ok, m.error);
  const g2 = S.arcGeom(S.getObj(m.doc, id), S.pointMap(m.doc));
  assert.ok(near(Math.hypot(g2.b.x - g2.c.x, g2.b.y - g2.c.y), g2.r, 1e-6), "both ends stay on one circle");
}

// sketches on planes: visible view, tagging, validation
{
  let d = S.createDoc();
  const sk = S.addSketch(d, "XZ", 5, "Face avant");
  assert.ok(sk.ok); d = sk.doc;
  assert.equal(d.version, S.SKETCH_VERSION);
  const base = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const side = S.withSketch(d, sk.id, x => S.addLine(x, { x: 1, y: 1 }, { x: 4, y: 1 }));
  assert.equal(S.getObj(d, side).sketch, sk.id);
  assert.deepEqual(S.inSketch(d, "").objects.map(o => o.id), [base]);
  assert.deepEqual(S.inSketch(d, sk.id).objects.map(o => o.id), [side]);
  assert.equal(S.findPointNear(S.inSketch(d, sk.id), 0, 0, 0.5), null, "the base sketch's points are not snapped to from another plane");
  assert.ok(S.validateDoc(d).ok);
  const mixed = S.clone(d);
  mixed.objects.push({ id: "zz", type: "line", p1: S.getObj(d, base).p1, p2: S.getObj(d, side).p2 });
  assert.equal(S.validateDoc(mixed).ok, false, "a line cannot join two planes");
}

// deleting geometry: holes / shells / patterns no longer crash, a revolve base survives an unrelated delete
{
  const d = S.createDoc();
  const r = S.addRect(d, { x: 0, y: 0 }, { x: 100, y: 60 });
  let doc = S.addFeature(d, "extrude", r.lines, 20, "blind").doc;
  const c = S.addCircle(doc, { x: 20, y: 20 }, 4);
  const h = S.addSolidStep(doc, { type: "hole", at: [c], standard: "M3", fit: "clearance", extent: "throughAll" });
  const p = S.addSolidStep(h.doc, { type: "pattern", source: h.id, mode: "linear", count: 3, dx: 20, dy: 0 });
  const stray = S.addLine(p.doc, { x: 200, y: 0 }, { x: 210, y: 0 });
  const kept = S.deleteObjects(p.doc, [stray]);
  assert.deepEqual(kept.features.map(f => f.type), ["extrude", "hole", "pattern"], "an unrelated delete keeps every feature");
  const noHole = S.deleteObjects(p.doc, [c]);
  assert.deepEqual(noHole.features.map(f => f.type), ["extrude"], "deleting the hole's circle drops the hole and its repetition");
  const rv = S.createDoc();
  const rr = S.addRect(rv, { x: 0, y: 0 }, { x: 10, y: 40 });
  const ax = S.addLine(rv, { x: 0, y: -5 }, { x: 0, y: 45 }, "centerline");
  const rdoc = S.addSolidStep(rv, { type: "revolve", profile: rr.lines, axis: ax, angle: 360 }).doc;
  const extra = S.addLine(rdoc, { x: 100, y: 0 }, { x: 110, y: 0 });
  assert.equal(S.deleteObjects(rdoc, [extra]).features.length, 1, "a revolved part keeps its base");
}

// feature tree: suppress, reorder, rollback, v6 steps
{
  const d = S.createDoc();
  const r = S.addRect(d, { x: 0, y: 0 }, { x: 100, y: 60 });
  let doc = S.addFeature(d, "extrude", r.lines, 20, "blind").doc;
  const c = S.addCircle(doc, { x: 20, y: 20 }, 4);
  const h = S.addSolidStep(doc, { type: "hole", at: [c], standard: "M3", fit: "clearance", extent: "throughAll" });
  const sh = S.addSolidStep(h.doc, { type: "shell", thickness: 2, open: true });
  const fil = S.addSolidStep(sh.doc, { type: "fillet", radius: 3, edges: [{ a: [0, 0, 0], b: [0, 0, 20], m: [0, 0, 10] }] });
  assert.ok(fil.ok, fil.error);
  assert.equal(fil.doc.version, S.SKETCH_VERSION, "a fillet on picked edges needs the exact engine (v6)");
  const sup = S.updateFeature(fil.doc, h.id, { suppressed: true });
  assert.ok(sup.ok && sup.doc.features[1].suppressed === true);
  assert.ok(S.updateFeature(sup.doc, h.id, { suppressed: false }).doc.features[1].suppressed === undefined);
  const up = S.moveFeature(fil.doc, sh.id, -1);
  assert.ok(up.ok, up.error);
  assert.deepEqual(up.doc.features.map(f => f.type), ["extrude", "shell", "hole", "fillet"]);
  assert.equal(S.moveFeature(fil.doc, h.id, -1).ok, false, "nothing goes before the base");
  const rb = S.setRollback(fil.doc, 2);
  assert.ok(rb.ok && rb.doc.rollback === 2);
  assert.equal(S.setRollback(rb.doc, null).doc.rollback, undefined);
  const boss = S.addSolidStep(fil.doc, { type: "boss", profile: r.lines, depth: 5, op: "add" });
  assert.ok(boss.ok && boss.doc.features[4].type === "extrude" && boss.doc.features[4].op === "add");
  assert.equal(S.updateFeature(fil.doc, fil.doc.features[0].id, { op: "cut" }).ok, false, "the base always adds");
}

{ // a sketch on a part's face: matter grows outward, a pocket goes into the part
  const d = S.createDoc(); d.mode = "construction";
  const base = S.addRect(d, { x: 0, y: 0 }, { x: 10, y: 10 });
  for (const [face, op, reversed] of [[1, "add", false], [1, "cut", true], [-1, "add", true], [-1, "cut", false]]) {
    let doc = S.addFeature(S.clone(d), "extrude", base.lines, 5, "blind").doc;
    const sk = S.addSketch(doc, "XY", 5, "Face", face);
    assert.ok(sk.ok && sk.doc.sketches[0].face === face, "the side is kept");
    doc = sk.doc;
    const r = S.withSketch(doc, sk.id, x => S.addRect(x, { x: 2, y: 2 }, { x: 6, y: 6 }));
    const step = S.addSolidStep(doc, { type: "boss", profile: r.lines, depth: 3, op });
    assert.ok(step.ok, step.error);
    assert.equal(!!step.doc.features.slice(-1)[0].reverse, reversed, `face ${face} ${op}`);
  }
  assert.equal(S.addSketch(S.createDoc(), "XY", 0, "x", 0).doc.sketches[0].face, undefined, "no side unless it is ±1");
  { // switching a face feature between Ajouter and Enlever flips its direction with it
    let doc = S.addFeature(S.clone(d), "extrude", base.lines, 5, "blind").doc;
    const sk = S.addSketch(doc, "XY", 5, "Face", 1);
    const r = S.withSketch(sk.doc, sk.id, x => S.addRect(x, { x: 2, y: 2 }, { x: 6, y: 6 }));
    const add = S.addSolidStep(sk.doc, { type: "boss", profile: r.lines, depth: 3, op: "add" });
    const id = add.doc.features.slice(-1)[0].id;
    const cut = S.updateFeature(add.doc, id, { op: "cut" });
    assert.ok(cut.ok && cut.doc.features.slice(-1)[0].reverse === true, "add → cut reverses on a top face");
    const back = S.updateFeature(cut.doc, id, { op: "add" });
    assert.ok(back.ok && back.doc.features.slice(-1)[0].reverse === undefined, "cut → add restores it");
    // a sketch that is not on a face keeps the user's direction
    const free = S.addSketch(doc, "XY", 5, "Libre");
    const r2 = S.withSketch(free.doc, free.id, x => S.addRect(x, { x: 2, y: 2 }, { x: 6, y: 6 }));
    const b2 = S.addSolidStep(free.doc, { type: "boss", profile: r2.lines, depth: 3, op: "add" });
    const id2 = b2.doc.features.slice(-1)[0].id;
    const t2 = S.updateFeature(S.updateFeature(b2.doc, id2, { reverse: true }).doc, id2, { op: "cut" });
    assert.ok(t2.ok && t2.doc.features.slice(-1)[0].reverse === true, "a free sketch's reverse flag is left alone");
  }
}

console.log("check_hq_sketch_v6: ok");
