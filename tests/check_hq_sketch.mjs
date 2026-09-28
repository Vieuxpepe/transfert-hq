// node tests/check_hq_sketch.mjs — pure geometry/model checks for assets/hq-sketch-core.js
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} expected ${b}, got ${a}`);
const P = (doc, id) => S.pointMap(doc).get(id);
let n = 0;
function test(name, fn) { fn(); n++; }

test("new doc is valid, Y-up units and grid explicit", () => {
  const d = S.createDoc({ units: "mm", spacing: 5 });
  assert.equal(d.units, "mm");
  assert.equal(d.grid.spacing, 5);
  assert.deepEqual(S.validateDoc(d), { ok: true });
});

test("driving length: fixed endpoint stays, other moves along the line", () => {
  let d = S.createDoc();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 3, y: 4 });
  const line = S.getObj(d, l);
  let r = S.setLineLength(d, l, line.p1, 25);
  assert.ok(r.ok, r.error);
  near(S.lineLength(r.doc, l), 25);
  assert.deepEqual([P(r.doc, line.p1).x, P(r.doc, line.p1).y], [0, 0]);
  near(P(r.doc, line.p2).x, 15); near(P(r.doc, line.p2).y, 20);
  // other endpoint fixed
  r = S.setLineLength(r.doc, l, line.p2, 5);
  assert.ok(r.ok, r.error);
  near(P(r.doc, line.p2).x, 15); near(P(r.doc, line.p2).y, 20);
  near(P(r.doc, line.p1).x, 12); near(P(r.doc, line.p1).y, 16);
  assert.equal(r.doc.constraints.length, 1, "one length constraint per line (upsert)");
  assert.equal(r.doc.constraints[0].fixed, line.p2);
  // original untouched (pure)
  near(S.lineLength(d, l), 5);
});

test("driving length on an open chain translates attached geometry rigidly", () => {
  const d = S.createDoc();
  const l1 = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const b = S.getObj(d, l1).p2;
  const l2 = S.addLine(d, { id: b }, { x: 10, y: 10 });
  const c = S.addCircle(d, { id: S.getObj(d, l2).p2 }, 3);
  const r = S.setLineLength(d, l1, S.getObj(d, l1).p1, 40);
  assert.ok(r.ok, r.error);
  near(S.lineLength(r.doc, l2), 10, 1e-9, "attached line keeps length");
  near(P(r.doc, S.getObj(r.doc, l2).p2).x, 40);
  near(P(r.doc, S.getObj(r.doc, c).center).y, 10);
});

test("driving length on a rectangle side keeps it rectangular (parallel side stretches)", () => {
  const d = S.createDoc();
  const rect = S.addRect(d, { x: 0, y: 0 }, { x: 20, y: 10 });
  const bottom = rect.lines[0]; // p0 -> p1 along +X
  const r = S.setLineLength(d, bottom, rect.points[0], 35);
  assert.ok(r.ok, r.error);
  const L = id => S.lineLength(r.doc, id);
  near(L(rect.lines[0]), 35); near(L(rect.lines[2]), 35);
  near(L(rect.lines[1]), 10); near(L(rect.lines[3]), 10);
  for (let i = 0; i < 4; i++) near(S.angleBetween(r.doc, rect.lines[i], rect.lines[(i + 1) % 4]).deg, 90, 1e-9);
  assert.deepEqual([P(r.doc, rect.points[0]).x, P(r.doc, rect.points[0]).y], [0, 0]);
  // vertical side, fixed top corner
  const r2 = S.setLineLength(r.doc, rect.lines[1], rect.points[2], 4);
  assert.ok(r2.ok, r2.error);
  near(S.lineLength(r2.doc, rect.lines[1]), 4);
  near(S.lineLength(r2.doc, rect.lines[0]), 35, 1e-9, "bottom length constraint preserved");
});

test("unsolvable closed geometry is refused and the doc is left intact", () => {
  const d = S.createDoc();
  const l1 = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const o = S.getObj(d, l1);
  const top = S.addPoint(d, 5, 8);
  S.addLine(d, { id: o.p2 }, { id: top });
  S.addLine(d, { id: top }, { id: o.p1 });
  const before = JSON.stringify(d);
  const r = S.setLineLength(d, l1, o.p1, 20);
  assert.equal(r.ok, false);
  assert.match(r.error, /non résoluble/);
  assert.equal(JSON.stringify(d), before);
  const a = S.setAngle(d, l1, S.linesAtPoint(d, o.p1).find(x => x.id !== l1).id, 45);
  assert.equal(a.ok, false);
  assert.match(a.error, /contour fermé/);
});

test("driving angle rotates the chosen line about the shared endpoint, preserving length", () => {
  const d = S.createDoc();
  const ref = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const v = S.getObj(d, ref).p1;
  const mv = S.addLine(d, { id: v }, { x: 0, y: 7 });
  const tail = S.addLine(d, { id: S.getObj(d, mv).p2 }, { x: 5, y: 7 });
  const r = S.setAngle(d, mv, ref, 60);
  assert.ok(r.ok, r.error);
  near(S.angleBetween(r.doc, ref, mv).deg, 60, 1e-9);
  near(S.lineLength(r.doc, mv), 7, 1e-9);
  near(P(r.doc, S.getObj(r.doc, mv).p2).x, 3.5, 1e-9);
  near(P(r.doc, S.getObj(r.doc, mv).p2).y, 7 * Math.sin(Math.PI / 3), 1e-9);
  near(S.lineLength(r.doc, tail), 5, 1e-9, "chain rotates rigidly");
  near(S.angleBetween(r.doc, mv, tail).deg, S.angleBetween(d, mv, tail).deg, 1e-9, "internal angle kept");
  assert.deepEqual([P(r.doc, v).x, P(r.doc, v).y], [0, 0]);
  // ref line untouched
  assert.deepEqual(P(r.doc, S.getObj(r.doc, ref).p2), P(d, S.getObj(d, ref).p2));
  // clockwise side is preserved
  const d2 = S.createDoc();
  const ref2 = S.addLine(d2, { x: 0, y: 0 }, { x: 10, y: 0 });
  const mv2 = S.addLine(d2, { id: S.getObj(d2, ref2).p1 }, { x: 3, y: -3 });
  const r2 = S.setAngle(d2, mv2, ref2, 30);
  assert.ok(r2.ok);
  assert.ok(P(r2.doc, S.getObj(r2.doc, mv2).p2).y < 0);
  assert.equal(S.setAngle(d2, mv2, ref2, 180).ok, false);
});

test("driving constraints are enforced: later edits that would break them are refused", () => {
  const d = S.createDoc();
  const ref = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const v = S.getObj(d, ref).p1;
  const mv = S.addLine(d, { id: v }, { x: 0, y: 7 });
  let r = S.setAngle(d, mv, ref, 45);
  assert.ok(r.ok);
  r = S.setLineLength(r.doc, mv, v, 20); // fixed at vertex: direction kept, angle survives
  assert.ok(r.ok, r.error);
  near(S.angleBetween(r.doc, ref, mv).deg, 45, 1e-6);
  const moved = S.moveObjects(r.doc, [mv], 3, 1); // drags the shared vertex -> breaks angle
  assert.equal(moved.ok, false);
  assert.match(moved.error, /Déplacement refusé/);
  const whole = S.moveObjects(r.doc, [mv, ref], 3, 1); // moving both lines is fine
  assert.ok(whole.ok, whole.error);
  // removing the constraint unlocks it
  const free = S.moveObjects(S.removeConstraint(S.removeConstraint(r.doc, r.doc.constraints[0].id), r.doc.constraints[1].id), [mv], 3, 1);
  assert.ok(free.ok);
});

test("manual cotations are annotations: editing labels never changes geometry", () => {
  const d = S.createDoc();
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const dim = S.addDimLinear(d, [0, 0], [10, 0], 5, "10");
  const ang = S.addDimAngle(d, [0, 0], [10, 0], [0, 10], 4, "");
  near(S.measureAngle([0, 0], [10, 0], [0, 10]), 90);
  const r = S.updateObject(d, dim, { label: "999 (faux)" });
  assert.ok(r.ok);
  near(S.lineLength(r.doc, l), 10);
  assert.equal(S.getObj(r.doc, dim).label, "999 (faux)");
  assert.equal(r.doc.constraints.length, 0);
  assert.deepEqual(r.doc.points, d.points);
  assert.ok(S.getObj(r.doc, ang));
});

test("units and scale: conversion preserves real-world size", () => {
  const d = S.createDoc({ units: "mm", spacing: 10 });
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 25.4, y: 0 });
  const r0 = S.setLineLength(d, l, S.getObj(d, l).p1, 50.8);
  const r = S.convertUnits(r0.doc, "in");
  assert.ok(r.ok);
  near(S.lineLength(r.doc, l), 2);
  near(r.doc.grid.spacing, 10 / 25.4, 1e-6);
  near(r.doc.constraints[0].value, 2);
  assert.deepEqual(S.checkConstraints(r.doc), []);
  const back = S.convertUnits(r.doc, "cm");
  near(S.lineLength(back.doc, l), 5.08, 1e-6);
  assert.equal(S.convertUnits(d, "furlong").ok, false);
});

test("view transforms are Y-up and zoom keeps the pointer anchored", () => {
  const view = { x0: -10, y0: -5, ppu: 4 };
  const H = 400;
  const a = S.toScreen(view, H, 0, 0), b = S.toScreen(view, H, 0, 10);
  assert.ok(b.y < a.y, "higher Y is higher on screen");
  const m = S.toModel(view, H, a.x, a.y);
  near(m.x, 0); near(m.y, 0);
  const z = S.zoomAt(view, H, 123, 77, 2.5);
  const before = S.toModel(view, H, 123, 77), after = S.toModel(z, H, 123, 77);
  near(before.x, after.x, 1e-9); near(before.y, after.y, 1e-9);
  near(z.ppu, 10);
});

test("grid and angle snapping", () => {
  assert.deepEqual(S.snapGrid({ x: 12.4, y: -7.6 }, 5), { x: 10, y: -10 });
  const p = S.snapAngle({ x: 0, y: 0 }, { x: 10, y: 1 }, 15);
  near(p.y, 0, 1e-9);
  const q = S.snapAngle({ x: 0, y: 0 }, { x: 10, y: 9 }, 15);
  near(Math.atan2(q.y, q.x) * 180 / Math.PI, 45, 1e-9);
  const e = S.snapSegmentEnd({ x: 0, y: 0 }, { x: 13, y: 12 }, { angle: true, angleStep: 45, grid: true, spacing: 5 });
  near(Math.hypot(e.x, e.y), 20, 1e-6); // |(13,12)| = 17.7 -> rounds to 20 along 45°
});

test("undo / redo restore exact documents", () => {
  const h = S.createHistory(3);
  let d = S.createDoc();
  h.push(d); d = S.clone(d); S.addLine(d, { x: 0, y: 0 }, { x: 5, y: 0 });
  h.push(d); d = S.clone(d); S.addText(d, 1, 1, "note", 2);
  assert.equal(d.objects.length, 2);
  d = h.undo(d); assert.equal(d.objects.length, 1);
  d = h.undo(d); assert.equal(d.objects.length, 0);
  assert.equal(h.undo(d), null);
  d = h.redo(d); assert.equal(d.objects.length, 1);
  d = h.redo(d); assert.equal(d.objects.length, 2);
  assert.equal(h.redo(d), null);
  h.push(d); h.push(d); h.push(d); h.push(d);
  assert.equal(h.past.length, 3, "history is bounded");
});

test("save/reopen roundtrip keeps notes and cotations editable", () => {
  const d = S.createDoc({ units: "mm" });
  d.mode = "construction";
  const l = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  S.addStroke(d, [[0, 0], [1, 0.001], [2, 0], [3, 3]], 0.01);
  const t = S.addText(d, 2, 3, "Percer Ø6", 2.5);
  const dm = S.addDimLinear(d, [0, 0], [10, 0], 4, "");
  const r = S.setLineLength(d, l, S.getObj(d, l).p1, 12);
  const reopened = JSON.parse(JSON.stringify(r.doc));
  assert.deepEqual(S.validateDoc(reopened), { ok: true });
  assert.equal(reopened.mode, "construction", "mode is stored in the same doc");
  const e1 = S.updateObject(reopened, t, { text: "Percer Ø8" });
  assert.equal(S.getObj(e1.doc, t).text, "Percer Ø8");
  const e2 = S.updateObject(e1.doc, dm, { label: "12 ±0.1" });
  assert.equal(S.getObj(e2.doc, dm).label, "12 ±0.1");
  const mv = S.moveObjects(e2.doc, [t], 5, 5);
  assert.ok(mv.ok);
  near(S.getObj(mv.doc, t).x, 7);
  near(S.lineLength(mv.doc, l), 12);
});

test("draft recovery via storage (localStorage-like)", () => {
  const store = new Map();
  const storage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const d = S.createDoc();
  S.addText(d, 0, 0, "brouillon", 2);
  assert.equal(S.saveDraft(storage, { doc: d, name: "support", dirty: true }), true);
  const got = S.loadDraft(storage);
  assert.equal(got.name, "support");
  assert.equal(got.dirty, true);
  assert.deepEqual(got.doc, d);
  store.set(S.DRAFT_KEY, "{not json");
  assert.equal(S.loadDraft(storage), null);
  store.set(S.DRAFT_KEY, JSON.stringify({ v: 1, doc: { format: "x" } }));
  assert.equal(S.loadDraft(storage), null);
  S.clearDraft(storage);
  assert.equal(S.loadDraft(storage), null);
  const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); }, removeItem: () => {} };
  assert.equal(S.saveDraft(full, { doc: d }), false);
});

test("delete prunes constraints and orphan points; hit test prefers notes", () => {
  const d = S.createDoc();
  const l1 = S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const l2 = S.addLine(d, { id: S.getObj(d, l1).p2 }, { x: 10, y: 10 });
  const r = S.setAngle(d, l2, l1, 90);
  const t = S.addText(r.doc, 4, -0.5, "ici", 2);
  assert.equal(S.hitTest(r.doc, 5, 0, 0.5), t);
  const del = S.deleteObjects(r.doc, [l1]);
  assert.equal(del.constraints.length, 0);
  assert.equal(del.points.length, 2);
  assert.deepEqual(S.validateDoc(del), { ok: true });
});

test("malformed documents are rejected", () => {
  const d = S.createDoc();
  S.addLine(d, { x: 0, y: 0 }, { x: 1, y: 0 });
  const bad1 = S.clone(d); bad1.objects[0].p2 = "nope";
  const bad2 = S.clone(d); bad2.points[0].x = Infinity;
  const bad3 = S.clone(d); bad3.version = 99;
  const bad4 = S.clone(d); bad4.objects.push({ id: bad4.objects[0].id, type: "text", x: 0, y: 0, text: "dup" });
  for (const b of [bad1, bad2, bad3, bad4, null, "x"]) assert.equal(S.validateDoc(b).ok, false);
});

test("freehand simplification and source hint", () => {
  const pts = []; for (let i = 0; i <= 100; i++) pts.push([i, 0]);
  assert.deepEqual(S.simplify(pts, 0.01), [[0, 0], [100, 0]]);
  assert.equal(S.sourceHint({ coarse: true, width: 390, height: 844 }), "mobile");
  assert.equal(S.sourceHint({ coarse: false, finePointer: true, width: 1440, height: 900 }), "desktop");
  assert.equal(S.sourceHint({ coarse: true, finePointer: true, width: 1920, height: 1080 }), "desktop");
  assert.equal(S.sourceHint({ coarse: false, finePointer: true, touchPoints: 5, width: 390, height: 664 }), "mobile", "touch + phone viewport");
  assert.equal(S.sourceHint({ coarse: false, finePointer: true, touchPoints: 10, width: 2880, height: 1800 }), "desktop", "touch laptop");
});

console.log(`hq sketch checks ok (${n} groups)`);
