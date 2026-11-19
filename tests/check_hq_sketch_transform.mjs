// 2D transforms, arrays and sketch management in hq-sketch-core.js (rotate / mirror / scale, linear and circular
// arrays, rename/lock/reorder/delete a sketch, stroke ink). Run: node tests/check_hq_sketch_transform.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const P = (d, id) => S.pointMap(d).get(id);
const O = (d, id) => S.getObj(d, id);

function v6() {
  const d = S.createDoc();
  d.version = S.SKETCH_VERSION;
  d.sketches = [];
  return d;
}
function L() { // an L: (0,0)-(40,0) then (40,0)-(40,40); its box centre is (20,20)
  const d = v6();
  const a = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  const b = S.addLine(d, { x: 40, y: 0, id: O(d, a).p2 }, { x: 40, y: 40 });
  return { d, a, b, ids: [a, b] };
}

// rotate 90° about the selection centre: corner (0,0) lands on (40,0)
{
  const { d, a, ids } = L();
  const r = S.transformObjects(d, ids, { kind: "rotate", angle: 90 });
  assert.ok(r.ok, r.error);
  const line = O(r.doc, a);
  assert.ok(near(P(r.doc, line.p1).x, 40) && near(P(r.doc, line.p1).y, 0), "rotation maps (0,0) to (40,0)");
  assert.ok(near(P(r.doc, line.p2).x, 40) && near(P(r.doc, line.p2).y, 40), "rotation maps (40,0) to (40,40)");
  assert.equal(r.doc.points.length, d.points.length, "a rigid move creates no point");
  assert.equal(d.objects[0].pts, undefined);
  assert.ok(near(P(d, O(d, a).p1).x, 0), "the source document is untouched");
}

// mirror: axis "h" flips vertically, axis "v" flips horizontally, both about the selection centre
{
  const { d, a, ids } = L();
  const h = S.transformObjects(d, ids, { kind: "mirror", axis: "h" });
  assert.ok(h.ok, h.error);
  assert.ok(near(P(h.doc, O(h.doc, a).p1).y, 40), "mirror h sends y=0 to y=40");
  const v = S.transformObjects(d, ids, { kind: "mirror", axis: "v" });
  assert.ok(v.ok, v.error);
  assert.ok(near(P(v.doc, O(v.doc, a).p1).x, 40), "mirror v sends x=0 to x=40");
  assert.ok(near(P(v.doc, O(v.doc, a).p1).y, 0), "mirror v keeps y");
}

// scale: geometry and radii follow the factor
{
  const d = v6();
  const a = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  const c = S.addCircle(d, { x: 40, y: 0 }, 10);
  const r = S.transformObjects(d, [a, c], { kind: "scale", factor: 2 });
  assert.ok(r.ok, r.error);
  assert.ok(near(P(r.doc, O(r.doc, a).p2).x, 55), "line doubles about the selection centre x=25");
  assert.ok(near(O(r.doc, c).r, 20), "circle radius doubles");
  const bad = S.transformObjects(d, [a], { kind: "scale", factor: 0 });
  assert.equal(bad.ok, false);
  assert.equal(S.transformObjects(d, [a], { kind: "rotate", angle: NaN }).ok, false);
  assert.equal(S.transformObjects(d, [], { kind: "rotate", angle: 90 }).ok, false);
  assert.equal(S.transformObjects(d, [a], { kind: "shear" }).ok, false);
}

// a mirrored arc keeps the same visible span (its two ends are swapped, not reordered by position)
{
  const d = v6();
  const id = S.addArc(d, { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 20 });
  const before = O(d, id);
  const r = S.transformObjects(d, [id], { kind: "mirror", axis: "h" });
  assert.ok(r.ok, r.error);
  const after = O(r.doc, id);
  assert.equal(r.doc.objects.length, 1, "still one arc");
  assert.equal(after.type, "arc");
  assert.ok(after.p1 && after.p2, "both ends survive the mirror");
  assert.notEqual(after.p1 + "|" + after.p2, before.p1 + "|" + before.p2, "the ends are relabelled");
}

// linear array: count-1 copies, each on fresh points so editing one never deforms another
{
  const { d, a, ids } = L();
  const r = S.arrayObjects(d, ids, { mode: "linear", count: 3, dx: 50, dy: 0 });
  assert.ok(r.ok, r.error);
  assert.equal(r.doc.objects.length, d.objects.length * 3, "two copies added");
  assert.equal(r.doc.points.length, d.points.length * 3, "copies never share points");
  const ids2 = r.doc.objects.map(o => o.id);
  assert.equal(new Set(ids2).size, ids2.length, "ids stay unique");
  const copy = r.doc.objects.find(o => o.id !== a && o.type === "line");
  assert.ok(copy, "a copied line exists");
  assert.equal(r.doc.points.filter(p => near(p.x, 50) && near(p.y, 0)).length >= 1, true, "first copy starts at +50");
  assert.equal(S.arrayObjects(d, ids, { mode: "linear", count: 3, dx: 0, dy: 0 }).ok, false);
  assert.equal(S.arrayObjects(d, ids, { mode: "linear", count: 1, dx: 10 }).ok, false);
  assert.equal(S.arrayObjects(d, ids, { mode: "linear", count: 51, dx: 10 }).ok, false);
  assert.equal(S.arrayObjects(d, [], { mode: "linear", count: 3, dx: 10 }).ok, false);
}

// circular array: the copies turn around the centre, and a group gets a per-copy suffix
{
  const d = v6();
  const a = S.addLine(d, { x: 40, y: 0 }, { x: 50, y: 0 });
  d.objects[0].group = "g";
  const r = S.arrayObjects(d, [a], { mode: "circular", count: 4, angle: 360 });
  assert.ok(r.ok, r.error);
  assert.equal(r.doc.objects.length, 4);
  const groups = r.doc.objects.map(o => o.group || "");
  assert.equal(groups[0], "g");
  assert.ok(groups.slice(1).every(g => /^g-\d$/.test(g)), "copies leave the original group");
  const quarter = r.doc.objects.find(o => o.group === "g-1");
  const p = S.pointMap(r.doc).get(quarter.p1);
  // the array turns about the selection centre (45,0): a quarter turn sends (40,0) to (45,-5)
  assert.ok(near(p.x, 45, 1e-6) && near(p.y, -5, 1e-6), "the copy is a quarter turn around the centre");
}

// stroke ink travels with the stroke, and stays absent when the theme ink is wanted
{
  const d = v6();
  const red = S.addStroke(d, [[0, 0], [10, 10]], 0.5, { w: 2, color: "#C62828" });
  assert.equal(O(d, red).color, "#c62828");
  const plain = S.addStroke(d, [[0, 5], [10, 5]], 0.5, { w: 2, color: "" });
  assert.equal(O(d, plain).color, undefined, "no colour key for theme ink");
  const bad = S.addStroke(d, [[0, 9], [10, 9]], 0.5, { w: 2, color: "red" });
  assert.equal(O(d, bad).color, undefined, "a non-hex colour is ignored");
}

// sketch manager: activate-order, rename, lock, delete
{
  const d = v6();
  d.sketches = [{ id: "sk1", name: "Base", plane: "XY", offset: 0 }, { id: "sk2", name: "Dessus", plane: "XZ", offset: 5 }];
  let l = "";
  S.withSketch(d, "sk1", x => { l = S.addLine(x, { x: 0, y: 0 }, { x: 10, y: 0 }); });
  S.withSketch(d, "sk2", x => { S.addLine(x, { x: 0, y: 20 }, { x: 10, y: 20 }); });
  d.sketches.unshift({ id: "sk0", name: "Vide", plane: "YZ", offset: 0 });

  const ren = S.updateSketch(d, "sk1", { name: "  Base élargie  " });
  assert.ok(ren.ok, ren.error);
  assert.equal(ren.doc.sketches.find(x => x.id === "sk1").name, "Base élargie");
  assert.equal(S.updateSketch(d, "sk1", { name: "   " }).doc.sketches.find(x => x.id === "sk1").name, "Base", "an empty name keeps the old one");
  assert.equal(S.updateSketch(d, "nope", { name: "x" }).ok, false);

  const lock = S.updateSketch(d, "sk2", { locked: true });
  assert.equal(lock.doc.sketches.find(x => x.id === "sk2").locked, true);
  assert.equal(S.updateSketch(lock.doc, "sk2", { locked: false }).doc.sketches.find(x => x.id === "sk2").locked, undefined);

  const down = S.moveSketch(d, "sk1", 1);
  assert.ok(down.ok, down.error);
  assert.deepEqual(down.doc.sketches.map(x => x.id), ["sk0", "sk2", "sk1"]);
  assert.equal(S.moveSketch(d, "sk0", -1).ok, false, "already first");
  assert.equal(S.moveSketch(down.doc, "sk1", 1).ok, false, "already last");
  assert.equal(S.moveSketch(d, "nope", 1).ok, false);

  const del = S.removeSketch(d, "sk2");
  assert.ok(del.ok, del.error);
  assert.deepEqual(del.doc.sketches.map(x => x.id), ["sk0", "sk1"]);
  assert.equal(del.doc.objects.some(o => S.sketchOf(o) === "sk2"), false, "its geometry is gone");
  assert.ok(del.doc.objects.some(o => o.id === l), "the other sketch keeps its geometry");
  assert.equal(S.removeSketch(d, "nope").ok, false);

  const kept = S.clone(d);
  kept.features = [{ id: "f1", type: "extrude", profile: [l], depth: 10 }];
  const refused = S.removeSketch(kept, "sk1");
  assert.equal(refused.ok, false, "a 3D function using the sketch blocks the delete");
}

// selection box: what the transform panel measures around
{
  const d = v6();
  const a = S.addLine(d, { x: -10, y: 5 }, { x: 30, y: 25 });
  const c = S.addCircle(d, { x: 50, y: 50 }, 10);
  const box = S.selectionBox(d, [O(d, a), O(d, c)]);
  assert.ok(near(box.x0, -10) && near(box.y0, 5) && near(box.x1, 60) && near(box.y1, 60));
  assert.ok(near(box.cx, 25) && near(box.cy, 32.5));
  assert.equal(S.selectionBox(d, []), null);
}

// visibility: a hidden sketch is drawn nowhere, the other visible ones stay in the 2D view
{
  const d = v6();
  d.sketches = [{ id: "sk1", name: "Base", plane: "XY", offset: 0 }, { id: "sk2", name: "Dessus", plane: "XZ", offset: 5 }];
  S.withSketch(d, "sk1", x => { S.addLine(x, { x: 0, y: 0 }, { x: 10, y: 0 }); });
  S.withSketch(d, "sk2", x => { S.addLine(x, { x: 0, y: 20 }, { x: 10, y: 20 }); });
  assert.equal(S.visibleView(d, "sk1").objects.length, 2, "both sketches are drawn while both are visible");
  assert.equal(S.visibleView(d, "").objects.length, 2, "the base sketch's view also shows the visible sketches");
  const hidden = S.updateSketch(d, "sk2", { hidden: true });
  assert.ok(hidden.ok, hidden.error);
  assert.equal(hidden.doc.sketches[1].hidden, true);
  assert.equal(S.visibleView(hidden.doc, "sk1").objects.length, 1, "a hidden sketch is not drawn");
  assert.equal(S.visibleView(d, "sk1").objects.length, 2, "the source document and its cached view are untouched");
  assert.equal(S.updateSketch(hidden.doc, "sk2", { hidden: false }).doc.sketches[1].hidden, undefined, "showing it again drops the key");
  const solo = S.updateSketch(d, "sk2", { hidden: true }).doc;
  assert.equal(S.visibleView(solo, "sk1"), S.inSketch(solo, "sk1"), "one visible sketch that is the active one: the plain view");
  assert.equal(S.visibleView(d, "sk1"), S.visibleView(d, "sk1"), "the merged view is cached per document");
}

console.log("check_hq_sketch_transform: OK");
