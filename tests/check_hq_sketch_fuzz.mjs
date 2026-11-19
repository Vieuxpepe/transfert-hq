// Seeded random operation sequences over hq-sketch-core.js: every accepted edit must leave a valid document, unique ids,
// arcs whose endpoints sit exactly on their circle, no zero-length line, and an exact undo/redo round trip.
// A constraint that names something missing must be refused, never silently dropped.
// Run: node tests/check_hq_sketch_fuzz.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
}
const pick = (r, list) => list[Math.floor(r() * list.length) % list.length];

function idsOf(doc) {
  return [...doc.points, ...doc.objects, ...doc.constraints, ...(doc.sketches || []), ...(doc.features || [])].map(x => x.id);
}

function invariants(doc, where) {
  const v = S.validateDoc(doc);
  assert.ok(v.ok, where + " → validateDoc: " + v.error);
  const seen = new Set();
  for (const id of idsOf(doc)) {
    assert.ok(!seen.has(id), where + " → identifiant en double : " + id);
    seen.add(id);
  }
  const pm = S.pointMap(doc);
  for (const o of doc.objects) {
    if (o.type === "arc") {
      const g = S.arcGeom(o, pm), a = pm.get(o.p1), b = pm.get(o.p2);
      assert.ok(a && b, where + " → arc avec un point manquant");
      const tol = 1e-6 * Math.max(1, g.r); // the same relative tolerance validateDoc applies to arcs
      assert.ok(Math.abs(Math.hypot(a.x - g.c.x, a.y - g.c.y) - g.r) <= tol, where + " → arc p1 hors du cercle");
      assert.ok(Math.abs(Math.hypot(b.x - g.c.x, b.y - g.c.y) - g.r) <= tol, where + " → arc p2 hors du cercle");
    }
    if (S.isLine(o)) {
      const a = pm.get(o.p1), b = pm.get(o.p2);
      assert.ok(a && b, where + " → ligne avec un point manquant");
      assert.ok(Math.hypot(b.x - a.x, b.y - a.y) > 1e-9, where + " → ligne de longueur nulle acceptée");
    }
    if (o.type === "circle") assert.ok(o.r > 0, where + " → cercle sans rayon");
  }
}

const grid = (r, k = 20) => Math.round(r() * k) * 10;

// each op: (doc, r) → { ok, doc } | null. The doc passed in is never relied on afterwards.
const OPS = [
  ["ligne", (d, r) => { const id = S.addLine(d, { x: grid(r), y: grid(r) }, { x: grid(r), y: grid(r) }); return id ? { doc: d } : null; }],
  ["cercle", (d, r) => { const id = S.addCircle(d, { x: grid(r), y: grid(r) }, 2.5 + Math.round(r() * 8)); return id ? { doc: d } : null; }],
  ["arc", (d, r) => {
    const c = { x: grid(r), y: grid(r) }, rad = 10 + Math.round(r() * 20);
    const a0 = r() * Math.PI * 2, a1 = a0 + 0.4 + r() * 2.4;
    const id = S.addArc(d, c, { x: c.x + Math.cos(a0) * rad, y: c.y + Math.sin(a0) * rad }, { x: c.x + Math.cos(a1) * rad, y: c.y + Math.sin(a1) * rad });
    return id ? { doc: d } : null;
  }],
  ["rectangle", (d, r) => { const w = 10 + Math.round(r() * 5) * 10, h = 10 + Math.round(r() * 5) * 10, x = grid(r), y = grid(r); const res = S.addRect(d, { x: x, y: y }, { x: x + w, y: y + h }); return res ? { doc: d } : null; }],
  ["tracé", (d, r) => {
    const pts = Array.from({ length: 6 }, () => [grid(r, 10) + r(), grid(r, 10) + r()]);
    const id = S.addStroke(d, pts, 0.1, 1.5);
    return id ? { doc: d } : null;
  }],
  ["déplacer un point", (d, r) => { const p = pick(r, d.points); if (!p) return null; return S.movePoint(d, p.id, p.x + grid(r, 3), p.y + grid(r, 3)); }],
  ["déplacer la sélection", (d, r) => { const o = pick(r, d.objects); if (!o) return null; return S.moveObjects(d, [o.id], grid(r, 3), grid(r, 3)); }],
  ["tourner", (d, r) => { const o = pick(r, d.objects); if (!o) return null; return S.transformObjects(d, [o.id], { kind: "rotate", angle: Math.round(r() * 8) * 45 }); }],
  ["échelle", (d, r) => { const o = pick(r, d.objects); if (!o) return null; return S.transformObjects(d, [o.id], { kind: "scale", factor: 0.5 + Math.round(r() * 4) * 0.5 }); }],
  ["répétition", (d, r) => { const o = pick(r, d.objects); if (!o) return null; return S.arrayObjects(d, [o.id], { mode: "linear", count: 2 + Math.floor(r() * 3), dx: 10, dy: 0 }); }],
  ["supprimer", (d, r) => { const o = pick(r, d.objects); if (!o) return null; return { doc: S.deleteObjects(d, [o.id]) }; }], // returns the doc itself
  ["contrainte", (d, r) => {
    const line = d.objects.find(o => S.isLine(o));
    if (!line) return null;
    return S.addConstraint(d, { type: pick(r, ["horizontal", "vertical"]), line: line.id });
  }],
  ["cote", (d, r) => { const id = S.addDimLinear(d, [grid(r), grid(r)], [grid(r) + 20, grid(r)], 8, ""); return id ? { doc: d } : null; }],
];

const SEEDS = [7, 21, 1337, 90210];
let accepted = 0, refused = 0;

for (const seed of SEEDS) {
  const r = rng(seed);
  let doc = S.createDoc();
  doc.version = S.SKETCH_VERSION;
  doc.sketches = [];
  const hist = S.createHistory(200);
  invariants(doc, "graine " + seed + " (départ)");

  for (let step = 0; step < 40; step++) {
    const [name, run] = pick(r, OPS);
    const before = S.clone(doc);
    let res = null;
    try { res = run(S.clone(doc), r); } catch (e) { throw new Error("graine " + seed + " étape " + step + " (" + name + ") a levé : " + e.message); }
    if (!res) { refused++; continue; }
    if (res.ok === false) { refused++; continue; }
    const next = res.doc;
    invariants(next, "graine " + seed + " étape " + step + " (" + name + ")");
    // undo/redo must come back to the exact same documents
    hist.push(doc);
    doc = next;
    if (step % 5 === 0) {
      const back = hist.undo(doc);
      assert.ok(back, "annuler doit rendre l'étape précédente");
      assert.equal(JSON.stringify(back), JSON.stringify(before), "graine " + seed + " étape " + step + " : Annuler ne rend pas le document d'avant");
      const again = hist.redo(back);
      assert.equal(JSON.stringify(again), JSON.stringify(doc), "graine " + seed + " étape " + step + " : Rétablir ne rend pas le document d'après");
    }
    accepted++;
  }
}

// a constraint on something that does not exist is refused, and the document is untouched
{
  const d = S.createDoc();
  d.version = S.SKETCH_VERSION;
  S.addLine(d, { x: 0, y: 0 }, { x: 10, y: 0 });
  const before = JSON.stringify(d);
  for (const bad of [{ type: "horizontal", line: "l404" }, { type: "fixed", point: "p404" }, { type: "radius", item: "c404", value: 4 }]) {
    const res = S.addConstraint(d, bad);
    assert.equal(res.ok, false, "contrainte invalide acceptée : " + JSON.stringify(bad));
    assert.equal(JSON.stringify(d), before, "une contrainte refusée a modifié le document");
  }
}

// the reading of a document is never destructive either
{
  const d = S.createDoc();
  d.version = S.SKETCH_VERSION;
  S.addLine(d, { x: 0, y: 0 }, { x: 25, y: 0 });
  const before = JSON.stringify(d);
  S.diagnose(d); S.repair(d); S.extents(d); S.freedom(d); S.solve(d); S.buildHitIndex(d, 10);
  assert.equal(JSON.stringify(d), before, "une lecture a modifié le document");
}

console.log("check_hq_sketch_fuzz: ok (" + SEEDS.length + " graines, " + accepted + " éditions acceptées, " + refused + " refusées)");
