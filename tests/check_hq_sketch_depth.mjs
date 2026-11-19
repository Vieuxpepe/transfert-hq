// Dessiner sketch depth (hq-sketch-core.js): slot/ellipse/spline/polygon, offset/trim/extend/mirror/convert,
// construction geometry, the new relations, DOF 0 and over-constraint reporting.
// Run: node tests/check_hq_sketch_depth.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const P = (d, id) => S.pointMap(d).get(id);
const O = (d, id) => S.getObj(d, id);
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const len = (d, id) => { const o = O(d, id), a = P(d, o.p1), b = P(d, o.p2); return Math.hypot(b.x - a.x, b.y - a.y); };
const ok = (r, what) => assert.ok(r && r.ok, (what || "") + " — " + (r && r.error));

let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log("ok " + checks + " — " + name); };

check("slot: two parallel sides closed by two semicircles, tangent by construction", () => {
  const d = S.createDoc();
  const slot = S.addSlot(d, { x: 0, y: 0 }, { x: 40, y: 20 }, 5);
  assert.ok(slot, "slot created");
  assert.equal(slot.lines.length, 2);
  assert.equal(slot.arcs.length, 2);
  assert.equal(new Set(slot.ids).size, 4);
  const pm = S.pointMap(d);
  for (const aid of slot.arcs) {
    const a = O(d, aid), c = pm.get(a.center);
    assert.ok(near(Math.hypot(pm.get(a.p1).x - c.x, pm.get(a.p1).y - c.y), 5), "arc radius");
    assert.ok(near(Math.hypot(pm.get(a.p2).x - c.x, pm.get(a.p2).y - c.y), 5), "arc closes on its radius");
  }
  // both centers lie on the slot axis, and the sides are exactly r away from it
  const centers = slot.arcs.map(id => pm.get(O(d, id).center));
  assert.ok(near(centers[0].x, 0) && near(centers[0].y, 0));
  assert.ok(near(centers[1].x, 40) && near(centers[1].y, 20));
  const L = Math.hypot(40, 20), nx = -20 / L, ny = 40 / L;
  for (const lid of slot.lines) { const a = pm.get(O(d, lid).p1); assert.ok(near(Math.abs(a.x * nx + a.y * ny), 5, 1e-6), "side offset by r"); }
  const box = S.extents(d);
  assert.ok(box.x0 <= -5 + 1e-6 && box.x1 >= 45 - 1e-6 && box.y0 <= -5 + 1e-6 && box.y1 >= 25 - 1e-6, "extents");
  assert.ok(S.validateDoc(d).ok, "slot validates");
});

check("polygon, ellipse and spline are real objects with solver variables", () => {
  const d = S.createDoc();
  const poly = S.addPolygon(d, { x: 0, y: 0 }, { x: 10, y: 0 }, 6);
  assert.equal(poly.lines.length, 6);
  assert.equal(new Set(poly.points).size, 6);
  const e = S.addEllipse(d, { x: 20, y: 0 }, 8, 4);
  const sp = S.addSpline(d, [{ x: 30, y: 0 }, { x: 35, y: 6 }, { x: 40, y: 0 }], false);
  assert.ok(e && sp);
  assert.equal(O(d, e).rx, 8); assert.equal(O(d, e).ry, 4);
  assert.equal(O(d, sp).pts.length, 3);
  assert.ok(S.validateDoc(d).ok, "geometry validates");

  const only = S.createDoc();
  S.addEllipse(only, { x: 0, y: 0 }, 5, 2);
  assert.equal(S.freedom(only).dof, 4, "ellipse = centre (2) + two radii");
  const onlySpline = S.createDoc();
  S.addSpline(onlySpline, [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }], false);
  assert.equal(S.freedom(onlySpline).dof, 6, "spline control points");
  assert.ok(S.extents(only).x0 <= -5 && S.extents(only).x1 >= 5, "ellipse extents");
});

check("concentric, midpoint, symmetric, collinear and point-on-curve drive the solver", () => {
  // concentric
  let d = S.createDoc();
  const c1 = S.addCircle(d, { x: 0, y: 0 }, 5), c2 = S.addCircle(d, { x: 20, y: 10 }, 8);
  let r = S.addConstraint(d, { type: "concentric", items: [c1, c2] });
  ok(r, "concentric");
  d = r.doc;
  let a = P(d, O(d, c1).center), b = P(d, O(d, c2).center);
  assert.ok(near(a.x, b.x) && near(a.y, b.y), "centres coincide");

  // midpoint
  d = S.createDoc();
  const line = S.addLine(d, { x: 0, y: 0 }, { x: 20, y: 0 });
  const circle = S.addCircle(d, { x: 3, y: 7 }, 2);
  r = S.addConstraint(d, { type: "midpoint", point: O(d, circle).center, line });
  ok(r, "midpoint");
  d = r.doc;
  a = P(d, O(d, circle).center); b = P(d, O(d, line).p1);
  const b2 = P(d, O(d, line).p2);
  assert.ok(near(a.x, (b.x + b2.x) / 2) && near(a.y, (b.y + b2.y) / 2), "point on the middle of the line");

  // symmetric about a fixed vertical centreline
  d = S.createDoc();
  const axis = S.addLine(d, { x: 0, y: -20 }, { x: 0, y: 20 }, "centerline");
  const ax = O(d, axis);
  let doc = d;
  for (const pid of [ax.p1, ax.p2]) { r = S.addConstraint(doc, { type: "fixed", point: pid }); ok(r, "fixed axis"); doc = r.doc; }
  const m1 = S.addCircle(doc, { x: 8, y: 4 }, 2), m2 = S.addCircle(doc, { x: -20, y: 9 }, 2);
  r = S.addConstraint(doc, { type: "symmetric", points: [O(doc, m1).center, O(doc, m2).center], line: axis });
  ok(r, "symmetric");
  doc = r.doc;
  a = P(doc, O(doc, m1).center); b = P(doc, O(doc, m2).center);
  assert.ok(near(a.x, -b.x, 1e-4) && near(a.y, b.y, 1e-4), "mirror pair about the fixed axis");

  // collinear
  d = S.createDoc();
  const l1 = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const l2 = S.addLine(d, { x: 20, y: 6 }, { x: 32, y: 11 });
  r = S.addConstraint(d, { type: "collinear", items: [l1, l2] });
  ok(r, "collinear");
  d = r.doc;
  const g1 = O(d, l1), g2 = O(d, l2);
  const p1 = P(d, g1.p1), p2 = P(d, g1.p2), p3 = P(d, g2.p1), p4 = P(d, g2.p2);
  const cross = (u, v, w) => (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  assert.ok(near(cross(p1, p2, p3), 0, 1e-4) && near(cross(p1, p2, p4), 0, 1e-4), "second line lies on the first");

  // point on curve (circle and line)
  d = S.createDoc();
  const cc = S.addCircle(d, { x: 0, y: 0 }, 10);
  const edge = S.addLine(d, { x: 15, y: 3 }, { x: 25, y: 12 });
  r = S.addConstraint(d, { type: "point_on_curve", point: O(d, edge).p1, item: cc });
  ok(r, "point on circle");
  d = r.doc;
  a = P(d, O(d, edge).p1);
  const ccNow = O(d, cc), ccCenter = P(d, ccNow.center);
  assert.ok(near(Math.hypot(a.x - ccCenter.x, a.y - ccCenter.y), ccNow.r, 1e-4), "endpoint lies on the circle (the circle itself may move)");

  d = S.createDoc();
  const flat = S.addLine(d, { x: 0, y: 0 }, { x: 20, y: 0 });
  const peg = S.addCircle(d, { x: 8, y: 7 }, 1);
  r = S.addConstraint(d, { type: "point_on_curve", point: O(d, peg).center, item: flat });
  ok(r, "point on line");
  d = r.doc;
  const fl = O(d, flat), fa = P(d, fl.p1), fb = P(d, fl.p2), pc = P(d, O(d, peg).center);
  const off = Math.abs((fb.x - fa.x) * (pc.y - fa.y) - (fb.y - fa.y) * (pc.x - fa.x)) / Math.hypot(fb.x - fa.x, fb.y - fa.y);
  assert.ok(near(off, 0, 1e-4), "circle centre lies on the line");
});

check("over-constrained sketch names the conflicting relations instead of failing silently", () => {
  const d = S.createDoc();
  const c1 = S.addCircle(d, { x: 0, y: 0 }, 5), c2 = S.addCircle(d, { x: 0, y: 0 }, 10);
  let doc = d, r;
  r = S.addConstraint(doc, { type: "concentric", items: [c1, c2] }); ok(r, "concentric"); doc = r.doc;
  r = S.addConstraint(doc, { type: "radius", item: c1, value: 5 }); ok(r, "radius 1"); doc = r.doc;
  r = S.addConstraint(doc, { type: "radius", item: c2, value: 10 }); ok(r, "radius 2"); doc = r.doc;
  assert.ok(S.sketchReport(doc).ok, "three relations are consistent");
  r = S.addConstraint(doc, { type: "tangent", items: [c1, c2] });
  assert.equal(r.ok, false, "concentric + different radii + tangency is refused");
  assert.match(r.error, /concentr/i, "the message names the concentric relation: " + r.error);
  assert.match(r.error, /tangent/i, "the message names the refused tangency: " + r.error);

  const bad = S.clone(doc);
  bad.constraints.push({ id: "k_bad", type: "tangent", items: [c1, c2] });
  const rep = S.sketchReport(bad);
  assert.equal(rep.ok, false, "the raw document does not solve");
  assert.ok(rep.redundant.includes("k_bad") || rep.conflicts.includes("k_bad"), "the tangent is reported as the conflicting relation");
});

check("a fully constrained bracket (slot + tangent arc + mirrored holes) reports DOF 0", () => {
  const d = S.createDoc();
  const slot = S.addSlot(d, { x: 0, y: 0 }, { x: 40, y: 0 }, 6);
  const arc = S.addArc(d, { x: 20, y: 12 }, { x: 14, y: 12 }, { x: 26, y: 12 });
  const h1 = S.addCircle(d, { x: 10, y: 20 }, 3), h2 = S.addCircle(d, { x: 30, y: 20 }, 3);
  assert.ok(slot && arc && h1 && h2);
  const slotObjs = slot.ids.map(id => O(d, id)), ao = O(d, arc);
  assert.ok(near(P(d, ao.center).y - 6, 6), "arc centre sits one radius above the slot top");
  let doc = d;
  const pts = new Set([
    ...slotObjs.flatMap(o => [o.p1, o.p2, o.center].filter(Boolean)),
    ao.center, ao.p1, ao.p2, O(d, h1).center, O(d, h2).center,
  ]);
  for (const pid of pts) { const r = S.addConstraint(doc, { type: "fixed", point: pid }); ok(r, "fix " + pid); doc = r.doc; }
  for (const hid of [h1, h2]) { const r = S.addConstraint(doc, { type: "radius", item: hid, value: 3 }); ok(r, "hole radius"); doc = r.doc; }
  const rep = S.sketchReport(doc);
  assert.equal(rep.ok, true);
  assert.equal(rep.dof, 0, "fully defined");
  assert.equal(rep.redundant.length, 0, "no redundant relation");
  assert.equal(rep.conflicts.length, 0, "no conflict");
  assert.equal(S.freedom(doc).dof, 0);
  // the two holes are a mirror pair about the slot axis
  assert.ok(near(P(doc, O(doc, h1).center).x + P(doc, O(doc, h2).center).x, 40), "holes mirrored about x=20");
  assert.equal(P(doc, O(doc, h1).center).y, P(doc, O(doc, h2).center).y);
});

check("changing a dimension rebuilds deterministically to the expected geometry", () => {
  const d = S.createDoc();
  const l1 = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const L1 = O(d, l1);
  const l2 = S.addLine(d, { id: L1.p2 }, { x: 10, y: 5 });
  const L2 = O(d, l2);
  let doc = d, r;
  r = S.addConstraint(doc, { type: "fixed", point: L1.p1 }); ok(r, "root fixed"); doc = r.doc;
  r = S.addConstraint(doc, { type: "horizontal", line: l1 }); ok(r, "base horizontal"); doc = r.doc;
  const a = S.setLineLength(doc, l1, L1.p1, 20);
  ok(a, "dimension 20");
  const b = S.setLineLength(doc, l1, L1.p1, 20);
  ok(b, "same dimension again");
  assert.deepEqual(a.doc.points, b.doc.points, "same input rebuilds to the same points");
  assert.ok(near(len(a.doc, l1), 20), "length applied");
  const shared = P(a.doc, L2.p1), top = P(a.doc, L2.p2);
  assert.ok(near(shared.x, 20) && near(shared.y, 0), "the attached line follows the new end");
  assert.ok(near(top.x, 20) && near(top.y, 5), "the rest of the chain translates");
  const s1 = S.solve(a.doc), s2 = S.solve(a.doc);
  assert.ok(s1.ok && s2.ok, "the rebuilt sketch solves");
  assert.deepEqual(s1.doc.points, s2.doc.points, "solver is deterministic");
  assert.ok(near(len(s1.doc, l1), 20), "the solved geometry keeps the dimension");
  const c = S.setLineLength(doc, l1, L1.p1, 30);
  ok(c);
  assert.ok(near(len(c.doc, l1), 30), "a second dimension change moves the geometry");
  assert.ok(near(P(c.doc, L2.p2).x, 30), "the attached line follows again");
});

check("offset copies lines, circles, arcs and ellipses", () => {
  const d = S.createDoc();
  const line = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const circle = S.addCircle(d, { x: 0, y: 20 }, 5);
  const arc = S.addArc(d, { x: 0, y: 40 }, { x: 10, y: 40 }, { x: 0, y: 50 });
  const ell = S.addEllipse(d, { x: 30, y: 0 }, 8, 4);
  let r = S.offsetObjects(d, [line, circle, arc, ell], 2);
  ok(r, "offset");
  assert.equal(r.ids.length, 4);
  assert.ok(S.validateDoc(r.doc).ok);
  const nl = O(r.doc, r.ids[0]), a = P(r.doc, nl.p1), b = P(r.doc, nl.p2);
  assert.ok(near(a.y, 2) && near(b.y, 2), "line offset to its left");
  assert.ok(near(O(r.doc, r.ids[1]).r, 7), "circle grown by 2");
  const na = O(r.doc, r.ids[2]), naP = P(r.doc, na.p1);
  assert.ok(near(Math.hypot(naP.x - 0, naP.y - 40), 12), "arc radius grown by 2");
  assert.ok(near(O(r.doc, r.ids[3]).rx, 10) && near(O(r.doc, r.ids[3]).ry, 6), "ellipse radii grown by 2");
  const back = S.offsetObjects(d, [circle], -1);
  ok(back);
  assert.ok(near(O(back.doc, back.ids[0]).r, 4));
});

check("trim removes the clicked span between intersections (line and circle)", () => {
  const d = S.createDoc();
  const base = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  S.addLine(d, { x: 5, y: -5 }, { x: 5, y: 5 });
  const h = S.addConstraint(d, { type: "horizontal", line: base });
  ok(h, "the trimmed line is constrained");
  let r = S.trimObject(h.doc, base, { x: 2, y: 0 });
  ok(r, "line trim");
  assert.equal(r.doc.constraints.some(k => k.line === base), false, "constraints of the removed span are dropped instead of leaving a dangling relation");
  assert.equal(r.ids.length, 1);
  const kept = O(r.doc, r.ids[0]), a = P(r.doc, kept.p1), b = P(r.doc, kept.p2);
  assert.ok(near(a.x, 5) && near(b.x, 10), "the clicked half is gone");
  assert.ok(S.validateDoc(r.doc).ok);

  const c = S.createDoc();
  const circle = S.addCircle(c, { x: 0, y: 0 }, 10);
  S.addLine(c, { x: 0, y: -20 }, { x: 0, y: 20 });
  r = S.trimObject(c, circle, { x: 10, y: 0 });
  ok(r, "circle trim");
  const arc = O(r.doc, r.ids[0]);
  assert.equal(arc.type, "arc");
  const g = S.arcGeom(arc, S.pointMap(r.doc));
  assert.ok(near(g.sweep, Math.PI, 1e-6), "half the circle remains");
  const mid = { x: g.c.x + g.r * Math.cos(g.t0 + g.sweep / 2), y: g.c.y + g.r * Math.sin(g.t0 + g.sweep / 2) };
  assert.ok(near(mid.x, -10, 1e-6), "the kept side is the one away from the click");
  assert.ok(S.validateDoc(r.doc).ok);
});

check("extend reaches the next edge, mirror copies about a centreline", () => {
  const d = S.createDoc();
  const short = S.addLine(d, { x: 0, y: 0 }, { x: 5, y: 0 });
  S.addLine(d, { x: 10, y: -5 }, { x: 10, y: 5 });
  let r = S.extendObject(d, short, { x: 5, y: 0 });
  ok(r, "extend");
  const nl = O(r.doc, short), a = P(r.doc, nl.p1), b = P(r.doc, nl.p2);
  assert.ok(near(Math.max(a.x, b.x), 10), "reached the vertical edge");
  assert.ok(near(Math.min(a.x, b.x), 0), "the other end did not move");

  const m = S.createDoc();
  const axis = S.addLine(m, { x: 0, y: -10 }, { x: 0, y: 10 }, "centerline");
  const hole = S.addCircle(m, { x: 6, y: 3 }, 2);
  r = S.mirrorObjects(m, [hole], axis);
  ok(r, "mirror");
  const mirrored = O(r.doc, r.ids[0]), mc = P(r.doc, mirrored.center);
  assert.ok(near(mc.x, -6) && near(mc.y, 3), "centre reflected");
  assert.ok(near(mirrored.r, 2));
  assert.ok(S.validateDoc(r.doc).ok);
});

check("construction geometry is excluded from profiles and 3D features", () => {
  const d = S.createDoc();
  const line = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const f = S.addFeature(d, "extrude", [line], 5);
  ok(f, "feature on a normal line");
  const con = S.setConstruction(f.doc, [line], true);
  ok(con, "mark construction");
  assert.equal(O(con.doc, line).construction, true);
  assert.equal(S.profileObject(O(con.doc, line)), false);
  const v = S.validateDoc(con.doc);
  assert.equal(v.ok, false, "a feature cannot use construction geometry");
  assert.match(v.error, /construction/i);
  const free = S.setConstruction(con.doc, [line], false);
  ok(free);
  assert.ok(S.validateDoc(free.doc).ok, "back to normal geometry");
  const direct = S.addFeature(d, "extrude", [line], 5);
  assert.equal(direct.ok, true);
  const marked = S.setConstruction(d, [line], true);
  const rejected = S.addFeature(marked.doc, "extrude", [line], 5);
  assert.equal(rejected.ok, false, "addFeature refuses a construction profile");
  assert.match(rejected.error, /construction/i);
});

check("convert a closed ring into sketch lines", () => {
  const d = S.createDoc();
  const r = S.convertRing(d, [[0, 0], [10, 0], [10, 10], [0, 10]]);
  ok(r, "convert");
  assert.equal(r.ids.length, 4);
  assert.equal(r.points.length, 4);
  const pm = S.pointMap(r.doc);
  for (let i = 0; i < 4; i++) { const o = O(r.doc, r.ids[i]); assert.equal(o.group, r.group); assert.ok(o.p1 && o.p2); }
  assert.ok(near(pm.get(O(r.doc, r.ids[0]).p2).x, 10), "ring follows the outline");
  assert.ok(S.validateDoc(r.doc).ok);
  const c = S.convertRing(d, [[0, 0], [10, 0], [10, 10]], { construction: true });
  ok(c);
  assert.ok(O(c.doc, c.ids[0]).construction, "converted reference outline can be construction");
});

check("a closed ellipse and a closed spline are solid profiles, open splines are refused", () => {
  const d = S.createDoc();
  const e = S.addEllipse(d, { x: 0, y: 0 }, 10, 5);
  const r = S.addFeature(d, "extrude", [e], 4);
  ok(r, "ellipse extrusion");
  assert.equal(r.doc.version, 6);
  assert.ok(S.validateDoc(r.doc).ok, "the ellipse profile validates");
  const badEllipse = S.createDoc(), be = S.addEllipse(badEllipse, { x: 0, y: 0 }, 10, 5);
  O(badEllipse, be).rx = -1;
  const beFeature = S.addFeature(badEllipse, "extrude", [be], 3);
  assert.equal(beFeature.ok, false, "a negative ellipse radius is refused");
  assert.match(beFeature.error, /Ellipse invalide/);

  const rev = S.createDoc();
  const e2 = S.addEllipse(rev, { x: 10, y: 0 }, 5, 3);
  const axis = S.addLine(rev, { x: 0, y: -20 }, { x: 0, y: 20 }, "centerline");
  const rr = S.addSolidStep(rev, { type: "revolve", profile: [e2], axis: axis, angle: 360 });
  ok(rr, "ellipse revolve");
  assert.ok(S.validateDoc(rr.doc).ok, "the revolved ellipse profile validates");

  const loop = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const sd = S.createDoc();
  const sp = S.addSpline(sd, loop, true);
  assert.equal(S.profileObject(O(sd, sp)), true, "a closed spline is profile geometry");
  assert.equal(S.closedCurve(O(sd, sp)), true, "the shared closed-curve predicate is exported for the UI");
  assert.ok(S.splineSamples(O(sd, sp), S.pointMap(sd)).length > 12, "the closed spline samples its wrap span");
  const sr = S.addFeature(sd, "extrude", [sp], 3);
  ok(sr, "closed spline extrusion");
  assert.ok(S.validateDoc(sr.doc).ok, "the closed spline profile validates");

  const od = S.createDoc();
  const open = S.addSpline(od, loop, false);
  assert.equal(S.profileObject(O(od, open)), false, "an open spline is not a profile");
  const bad = S.addFeature(od, "extrude", [open], 3);
  assert.equal(bad.ok, false, "an open spline is refused");
  assert.match(bad.error, /ouverte/i);
  const vd = S.validateDoc({ ...od, version: 6, sketches: [], features: [{ id: "f1", type: "extrude", profile: [open], depth: 3, extent: "blind" }] });
  assert.equal(vd.ok, false);
  assert.match(vd.error, /ouverte/i, "the validator names the open spline");

  const md = S.createDoc();
  const me = S.addEllipse(md, { x: 0, y: 0 }, 4, 2);
  const ml = S.addLine(md, { x: 0, y: 0 }, { x: 1, y: 0 });
  const mixed = S.addFeature(md, "extrude", [me, ml], 3);
  assert.equal(mixed.ok, false, "an ellipse cannot be mixed with other edges");
  assert.match(mixed.error, /seule/i);
});

check("face triangulation becomes a closed sketch ring", () => {
  const ring = S.outlineFromTriangles([[[0, 0], [10, 0], [10, 10]], [[0, 0], [10, 10], [0, 10]]]);
  ok(ring, "face outline");
  assert.equal(ring.pts.length, 4);
  const r = S.convertRing(S.createDoc(), ring.pts, { construction: true });
  ok(r, "face outline converts");
  assert.equal(r.ids.length, 4);
  assert.ok(r.ids.every(id => O(r.doc, id).construction));
  assert.ok(S.validateDoc(r.doc).ok);
});

console.log("\n" + checks + " sketch-depth checks passed");
