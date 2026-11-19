// « Valider le dessin »: S.diagnose in hq-sketch-core.js reports dangling point / object / constraint references,
// sketches left on a face that no longer exists, and degenerate shapes — without touching the document.
// Run: node tests/check_hq_sketch_validate.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const O = (d, id) => S.getObj(d, id);
const P = (d, id) => S.pointMap(d).get(id);
const kinds = rep => rep.issues.map(i => i.kind).sort();

function v6() {
  const d = S.createDoc();
  d.version = S.SKETCH_VERSION;
  d.sketches = [];
  return d;
}

// a clean drawing reports nothing
{
  const d = v6();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  S.addCircle(d, { x: 10, y: 10 }, 5);
  const k = S.addConstraint(d, { type: "horizontal", line: l });
  assert.ok(k.ok, k.error);
  const rep = S.diagnose(k.doc);
  assert.equal(rep.ok, true, JSON.stringify(rep.issues));
  assert.equal(rep.total, 0);
  assert.deepEqual(rep.issues, []);
}

// an object whose point was deleted
{
  const d = v6();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  const gone = O(d, l).p2;
  d.points = d.points.filter(p => p.id !== gone);
  const rep = S.diagnose(d);
  assert.equal(rep.ok, false);
  assert.deepEqual(kinds(rep), ["object.point"]);
  assert.equal(rep.issues[0].id, l);
  assert.match(rep.issues[0].message, new RegExp(gone));
}

// an arc whose centre point is missing names the point
{
  const d = v6();
  const arc = S.addArc(d, { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 });
  assert.ok(arc, "arc created");
  const c = O(d, arc).center;
  d.points = d.points.filter(p => p.id !== c);
  const rep = S.diagnose(d);
  assert.deepEqual(kinds(rep), ["object.point"]);
  assert.equal(rep.issues[0].id, arc);
  assert.match(rep.issues[0].message, /point/);
}

// a constraint that points at a deleted line
{
  const d = v6();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  const k = S.addConstraint(d, { type: "horizontal", line: l });
  assert.ok(k.ok, k.error);
  const d2 = S.clone(k.doc);
  d2.objects = d2.objects.filter(o => o.id !== l);
  const rep = S.diagnose(d2);
  assert.deepEqual(kinds(rep), ["constraint.ref"]);
  assert.equal(rep.issues[0].id, k.id);
  assert.match(rep.issues[0].message, new RegExp(l));
}

// a length constraint whose line is gone, and an angle constraint whose vertex is gone
// (S.addConstraint only takes geometric constraints: length and angle are pushed as the UI stores them)
{
  const d = v6();
  const a = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  const b = S.addLine(d, { x: 40, y: 0, id: O(d, a).p2 }, { x: 40, y: 40 });
  d.constraints.push({ id: "k1", type: "length", line: a, fixed: O(d, a).p1, value: 40 });
  d.constraints.push({ id: "k2", type: "angle", lines: [a, b], vertex: O(d, a).p2, value: 90 });
  assert.deepEqual(S.diagnose(d).issues, []);

  const d2 = S.clone(d);
  d2.constraints[0].line = "l404";
  let rep = S.diagnose(d2);
  assert.deepEqual(kinds(rep), ["constraint.ref"]);
  assert.equal(rep.issues[0].id, "k1");
  assert.match(rep.issues[0].message, /ligne l404/);

  const d3 = S.clone(d);
  d3.constraints[1].vertex = "p404";
  d3.constraints[0].line = "l404";
  rep = S.diagnose(d3);
  assert.deepEqual(kinds(rep), ["constraint.ref", "constraint.ref"]);
  assert.ok(rep.issues.some(i => /sommet p404/.test(i.message)));
}

// a point or an object tagged with a sketch that no longer exists
{
  const d = v6();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  O(d, l).sketch = "sk404";
  d.points[0].sketch = "sk404";
  const rep = S.diagnose(d);
  assert.deepEqual(kinds(rep), ["object.sketch", "point.sketch"]);
}

// zero-length lines: the same point twice, and two points at the same place
{
  const d = v6();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  O(d, l).p2 = O(d, l).p1;
  assert.deepEqual(kinds(S.diagnose(d)), ["line.zero"]);

  const d2 = v6();
  const l2 = S.addLine(d2, { x: 0, y: 0 }, { x: 40, y: 0 });
  const q = P(d2, O(d2, l2).p2);
  q.x = 0; q.y = 0;
  const rep = S.diagnose(d2);
  assert.deepEqual(kinds(rep), ["line.zero"]);
  assert.equal(rep.issues[0].id, l2);
}

// a circle without a radius, an arc with coincident points
{
  const d = v6();
  const c = S.addCircle(d, { x: 0, y: 0 }, 5);
  O(d, c).r = 0;
  assert.deepEqual(kinds(S.diagnose(d)), ["circle.degenerate"]);

  const d2 = v6();
  const arc = S.addArc(d2, { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 });
  O(d2, arc).p2 = O(d2, arc).p1;
  assert.deepEqual(kinds(S.diagnose(d2)), ["arc.degenerate"]);
}

// a sketch drawn on a face, without the part that face belonged to
{
  const d = v6();
  const r = S.addSketch(d, "XY", 10, "Face", 1);
  assert.ok(r.ok, r.error);
  let rep = S.diagnose(r.doc);
  assert.deepEqual(kinds(rep), ["sketch.face"]);
  assert.equal(rep.issues[0].id, r.id);

  // the same sketch is fine once its part exists; a sketch on the plane (face = null) never complains
  const d2 = S.clone(r.doc);
  const c = S.addCircle(d2, { x: 0, y: 0 }, 5);
  O(d2, c).sketch = r.id;
  for (const p of d2.points) p.sketch = r.id;
  d2.features = [{ id: "f1", type: "extrude", op: "add", profile: [c], depth: 10, extent: "blind" }];
  assert.deepEqual(S.diagnose(d2).issues, []);
  const p = S.addSketch(d2, "XY", 0, "Plan");
  assert.deepEqual(S.diagnose(p.doc).issues, []);
}

// 3D features pointing at deleted objects, and a pattern whose source is gone
{
  const d = v6();
  const c = S.addCircle(d, { x: 0, y: 0 }, 5);
  d.features = [
    { id: "f1", type: "extrude", op: "add", profile: [c], depth: 10, extent: "blind" },
    { id: "f2", type: "cut", op: "cut", profile: ["l404"], depth: 2, extent: "blind" },
    { id: "f3", type: "pattern", source: "f404", mode: "linear", count: 3, dx: 5, dy: 0 },
  ];
  const rep = S.diagnose(d);
  assert.deepEqual(kinds(rep), ["feature.ref", "feature.source"]);
  assert.ok(rep.issues.some(i => i.id === "f2" && /l404/.test(i.message)));
  assert.ok(rep.issues.some(i => i.id === "f3" && /f404/.test(i.message)));
}

// the check is read-only: the document is byte-identical afterwards, even a broken one
{
  const d = v6();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 40, y: 0 });
  const z = S.addLine(d, { x: 5, y: 5 }, { x: 9, y: 5 });
  const q = P(d, O(d, z).p2); q.x = 5; q.y = 5; // two distinct points, same place: a zero-length line
  S.addConstraint(d, { type: "horizontal", line: l });
  d.sketches.push({ id: "sk1", name: "Face", plane: "XY", offset: 10, face: -1 });
  const victim = O(d, z).p1;
  d.objects = d.objects.filter(o => o.id !== l);
  d.points = d.points.filter(p => p.id !== victim);
  const before = JSON.stringify(d);
  const sel = ["x"];
  const rep = S.diagnose(d);
  assert.ok(rep.total > 0);
  assert.equal(JSON.stringify(d), before, "diagnose must not touch the document");
  assert.deepEqual(sel, ["x"]);
  // every finding carries an id and a sentence the dialog can show as is
  for (const it of rep.issues) {
    assert.equal(typeof it.kind, "string");
    assert.equal(typeof it.id, "string");
    assert.ok(it.message.length > 3);
  }
}

// repair: only what points at nothing goes, the result validates, and the input document is untouched
{
  let doc = v6();
  const l = S.addLine(doc, { x: 0, y: 0 }, { x: 40, y: 0 });
  const c = S.addCircle(doc, { x: 0, y: 0 }, 4);
  const k = S.addConstraint(doc, { type: "horizontal", line: l });
  assert.ok(k.ok, k.error);
  doc = k.doc;
  const dim = S.addDimDiameter(doc, c, 0);
  const sk = S.addSketch(doc, "XY", 12, "Face", 1);
  assert.ok(sk.ok, sk.error);
  doc = sk.doc;
  const gone = O(doc, l).p2;
  doc.points = doc.points.filter(p => p.id !== gone);   // the line now dangles
  doc.objects = doc.objects.filter(o => o.id !== c);    // and the Ø cote lost its circle
  const before = JSON.stringify(doc);
  const rep = S.repair(doc);
  assert.equal(JSON.stringify(doc), before, "repair must not touch the document it is given");
  assert.equal(rep.ok, true, rep.error);
  assert.deepEqual(rep.actions.map(a => a.kind).sort(), ["constraint.ref", "dim.item", "object.point", "sketch.face"]);
  assert.deepEqual(rep.left, [], "repair left something it could have fixed");
  assert.equal(S.getObj(rep.doc, l), null, "the dangling line is gone");
  assert.equal(S.getObj(rep.doc, dim), null, "the Ø cote without a circle is gone");
  assert.equal(rep.doc.constraints.length, 0, "the constraint on the removed line is gone");
  assert.equal(rep.doc.sketches[0].face, undefined, "the face sketch is detached, never deleted");
  assert.equal(rep.doc.objects.length, 0);
  assert.ok(S.validateDoc(rep.doc).ok);
  assert.deepEqual(S.diagnose(rep.doc).issues, [], "a repaired document has nothing left to report");
}

// repair leaves alone what it cannot fix safely: a 3D feature whose profile vanished stays, and says so
{
  const doc = v6();
  S.addCircle(doc, { x: 0, y: 0 }, 5);
  doc.features = [{ id: "f1", type: "extrude", op: "add", profile: ["l404"], depth: 5, extent: "blind" }];
  const rep = S.repair(doc);
  assert.deepEqual(rep.actions, [], "no repair may drop a 3D function");
  assert.equal(rep.ok, false);
  assert.deepEqual(rep.left.map(i => i.kind), ["feature.ref"]);
  assert.equal(rep.doc.features.length, 1);
}

// a broken document must not take the canvas, the view or the pointer path down with it
{
  const doc = v6();
  const l = S.addLine(doc, { x: 0, y: 0 }, { x: 40, y: 0 });
  const a = S.addArc(doc, { x: 0, y: 0 }, 10, 0, Math.PI);
  S.addCircle(doc, { x: 100, y: 100 }, 5);
  const goneL = S.getObj(doc, l).p2, goneA = S.getObj(doc, a).center;
  doc.points = doc.points.filter(p => p.id !== goneL && p.id !== goneA);
  assert.equal(S.objectBox(doc, S.getObj(doc, l)), null, "no box for a line without its point");
  assert.equal(S.objectBox(doc, S.getObj(doc, a)), null, "no box for an arc without its centre");
  const e = S.extents(doc);
  assert.deepEqual(e, { x0: 95, y0: 95, x1: 105, y1: 105 }, "the reading only counts what still exists");
  assert.equal(S.hitTest(doc, 5, 5, 1), null, "hit-testing a broken arc does not throw");
  assert.deepEqual(S.hitAll(doc, 5, 5, 30), [], "and reports no candidate at all");
  const onlyBroken = v6();
  const bl = S.addLine(onlyBroken, { x: 0, y: 0 }, { x: 9, y: 0 });
  onlyBroken.points = onlyBroken.points.filter(p => p.id !== S.getObj(onlyBroken, bl).p2);
  assert.equal(S.extents(onlyBroken), null, "nothing measurable left");
  assert.ok(S.fitView(onlyBroken, 800, 500, 40).ppu > 0, "and the view still has a usable scale");
}

// DXF import: a good file lands in its own sketch, a damaged drawing does not block it, an empty file is refused
{
  const dxf = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "4", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES",
    "0", "LWPOLYLINE", "8", "PERCAGE", "90", "4", "70", "1", "10", "0", "20", "0", "10", "60", "20", "0", "10", "60", "20", "40", "10", "0", "20", "40",
    "0", "CIRCLE", "8", "TROU", "10", "30", "20", "20", "40", "5", "0", "ENDSEC", "0", "EOF"].join("\n");
  const parsed = S.parseDXF(dxf);
  assert.equal(parsed.units, "mm");
  assert.deepEqual(parsed.entities.map(e => e.layer), ["PERCAGE", "TROU"], "the layers come through");
  const res = S.importDXF(v6(), parsed, { name: "perçage", units: "mm" });
  assert.ok(res.ok, res.error);
  assert.equal(res.added, 5, "4 sides + 1 circle");
  assert.equal(res.doc.objects.filter(o => o.type === "line").length, 4, "a closed polyligne is a closed profile");
  assert.equal(res.doc.sketches.length, 1);
  assert.equal(res.sketch, res.doc.sketches[0].id);
  assert.ok(S.validateDoc(res.doc).ok);
  const broken = v6();
  const bl = S.addLine(broken, { x: 0, y: 0 }, { x: 5, y: 0 });
  broken.points = broken.points.filter(p => p.id !== S.getObj(broken, bl).p2);
  const res2 = S.importDXF(broken, parsed, { name: "b", units: "mm" });
  assert.ok(res2.ok, res2.error);
  assert.equal(S.importDXF(v6(), { entities: [] }).ok, false, "an empty file is refused");
}

console.log("check_hq_sketch_validate: ok");
