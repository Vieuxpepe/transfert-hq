// Tracé libre -> géométrie propre: reconnaissance, accrochage, contraintes implicites.
// Run: node tests/check_hq_sketch_recognize.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");

function doc() {
  const d = S.createDoc({ units: "mm", spacing: 10 });
  d.version = S.SKETCH_VERSION;
  return d;
}
// A hand-drawn stroke: straight-ish or curved, with the jitter a stylus produces.
function jitterLine(x0, y0, x1, y1, n, amp) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, w = Math.sin(i * 2.7) * amp;
    const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1;
    pts.push([x0 + dx * t - dy / L * w, y0 + dy * t + dx / L * w]);
  }
  return pts;
}
function arcPts(cx, cy, r, a0, a1, n, amp) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = a0 + (a1 - a0) * t, w = Math.sin(i * 1.9) * (amp || 0);
    pts.push([cx + (r + w) * Math.cos(a), cy + (r + w) * Math.sin(a)]);
  }
  return pts;
}

// --- ligne: une ligne droite dessinée à main levée redevient une ligne, et se cale à l'horizontale
{
  const p = S.recognizeStroke(jitterLine(0, 0, 60, 1.5, 40, 0.6));
  assert.ok(p.ok, p.reason);
  assert.equal(p.kind, "line");
  assert.ok(p.confidence > 0.5, "confiance " + p.confidence);
  assert.equal(Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]) > 55, true);
}
{
  const p = S.recognizeStroke(jitterLine(5, 20, 65, 22, 40, 0.5));
  assert.ok(p.ok, p.reason);
  assert.equal(p.horizontal, true, "une pente de 2° est une horizontale");
  assert.equal(p.a[1], p.b[1], "les deux extrémités partagent la même ordonnée");
  assert.deepEqual(p.constraints, ["horizontal"]);
}
{
  const p = S.recognizeStroke(jitterLine(10, 30, 12, -20, 40, 0.5));
  assert.ok(p.ok, p.reason);
  assert.equal(p.vertical, true);
  assert.equal(p.a[0], p.b[0]);
  assert.deepEqual(p.constraints, ["vertical"]);
}
{
  // une diagonale franche reste une diagonale: pas de contrainte inventée
  const p = S.recognizeStroke(jitterLine(0, 0, 40, 40, 30, 0.4));
  assert.ok(p.ok, p.reason);
  assert.equal(p.kind, "line");
  assert.equal(p.horizontal || p.vertical, false);
  assert.deepEqual(p.constraints, []);
}

// --- cercle et arc
{
  const p = S.recognizeStroke(arcPts(5, 5, 10, 0, 2 * Math.PI * 0.999, 80, 0.35));
  assert.ok(p.ok, p.reason);
  assert.equal(p.kind, "circle");
  assert.ok(Math.abs(p.r - 10) < 0.4, "rayon " + p.r);
  assert.ok(Math.abs(p.c[0] - 5) < 0.4 && Math.abs(p.c[1] - 5) < 0.4);
  assert.ok(p.confidence > 0.5);
}
{
  const p = S.recognizeStroke(arcPts(0, 0, 20, Math.PI, 2 * Math.PI, 60, 0.4));
  assert.ok(p.ok, p.reason);
  assert.equal(p.kind, "arc");
  assert.ok(Math.abs(p.r - 20) < 0.5, "rayon " + p.r);
  const d1 = Math.hypot(p.p1[0] - p.c[0], p.p1[1] - p.c[1]);
  const d2 = Math.hypot(p.p2[0] - p.c[0], p.p2[1] - p.c[1]);
  assert.ok(Math.abs(d1 - p.r) < 1e-6 && Math.abs(d2 - p.r) < 1e-6, "les extrémités sont sur le cercle");
  assert.ok(Math.abs(p.p1[1]) < 0.5 && Math.abs(p.p2[1]) < 0.5, "les deux extrémités sont sur l'axe");
}
{
  // un tracé court ou quasi nul n'est pas une forme
  assert.equal(S.recognizeStroke([[0, 0], [1, 0]]).ok, false);
  assert.equal(S.recognizeStroke([[5, 5], [5, 5], [5, 5], [5, 5], [5, 5]]).ok, false);
  assert.equal(S.recognizeStroke([]).ok, false);
}

// --- polyligne: un L dessiné à main levée
{
  const pts = jitterLine(0, 0, 0, 40, 20, 0.4).concat(jitterLine(0, 40, 50, 40, 20, 0.4));
  const p = S.recognizeStroke(pts);
  assert.ok(p.ok, p.reason);
  assert.equal(p.kind, "polyline");
  assert.ok(p.points.length >= 3 && p.points.length <= 6, "sommets " + p.points.length);
  const corner = p.points.find(q => Math.abs(q[0]) < 3 && Math.abs(q[1] - 40) < 3);
  assert.ok(corner, "le coin est conservé");
}

// --- matérialisation
{
  const p = S.recognizeStroke(jitterLine(5, 20, 65, 22, 40, 0.5));
  const d = doc();
  const out = S.applyStrokeShape(d, p, {});
  assert.ok(out.ok, out.error);
  assert.equal(out.ids.length, 1);
  assert.equal(S.getObj(out.doc, out.ids[0]).type, "line");
  assert.ok(Math.abs(S.lineLength(out.doc, out.ids[0]) - 60) < 0.5, "longueur " + S.lineLength(out.doc, out.ids[0]));
  assert.equal(out.doc.constraints.length, 1);
  assert.equal(out.doc.constraints[0].type, "horizontal");
  assert.ok(S.validateDoc(out.doc).ok);
  assert.equal(S.diagnose(out.doc).issues.length, 0, "la ligne est totalement contrainte en direction");
}
{
  // accrochage: la nouvelle forme reprend le point existant au lieu d'en créer un second au même endroit
  const d = doc();
  const anchor = S.addPoint(d, 10, 10);
  const p = { ok: true, kind: "line", a: [10.3, 10.2], b: [60, 40], constraints: [] };
  const out = S.applyStrokeShape(d, p, { snapTol: 2 });
  assert.ok(out.ok, out.error);
  assert.equal(S.getObj(out.doc, out.ids[0]).p1, anchor, "le point existant est réutilisé");
  assert.equal(out.doc.points.length, 2, "un seul point ajouté, l'autre extrémité réutilisée");
}
{
  const p = S.recognizeStroke(arcPts(0, 0, 12, 0, Math.PI * 1.99, 70, 0.3));
  const d = doc();
  const out = S.applyStrokeShape(d, p, {});
  assert.ok(out.ok, out.error);
  const circ = S.getObj(out.doc, out.ids[0]);
  assert.equal(circ.type, "circle");
  assert.ok(Math.abs(circ.r - 12) < 0.5);
  assert.ok(S.validateDoc(out.doc).ok);
}
{
  const p = S.recognizeStroke(arcPts(0, 0, 20, Math.PI, 2 * Math.PI, 60, 0.4));
  const d = doc();
  const out = S.applyStrokeShape(d, p, {});
  assert.ok(out.ok, out.error);
  assert.equal(S.getObj(out.doc, out.ids[0]).type, "arc");
  assert.ok(S.validateDoc(out.doc).ok);
  const arc = S.getObj(out.doc, out.ids[0]);
  const pm = S.pointMap(out.doc), A = pm.get(arc.p1), B = pm.get(arc.p2);
  assert.ok(Math.abs(A.y) < 0.5 && Math.abs(B.y) < 0.5, "l'arc va d'un bout à l'autre de l'axe");
  assert.ok(Math.abs(Math.hypot(A.x - B.x, A.y - B.y) - 40) < 0.5, "le diamètre fait 40, pas le rayon");
}
{
  const pts = jitterLine(0, 0, 0, 40, 20, 0.4).concat(jitterLine(0, 40, 50, 40, 20, 0.4));
  const p = S.recognizeStroke(pts);
  const d = doc();
  const out = S.applyStrokeShape(d, p, {});
  assert.ok(out.ok, out.error);
  assert.equal(out.ids.length, p.points.length - 1);
  assert.ok(out.ids.every(id => S.getObj(out.doc, id).type === "line"));
  assert.ok(S.validateDoc(out.doc).ok);
}
{
  assert.equal(S.applyStrokeShape(doc(), { ok: false, reason: "trop court" }).ok, false);
  assert.equal(S.applyStrokeShape(doc(), null).ok, false);
  assert.equal(S.applyStrokeShape(doc(), { ok: true, kind: "blob" }).ok, false);
}

// --- le tracé d'origine reste intact tant qu'on ne l'a pas remplacé
{
  const d = doc();
  const raw = S.addStroke(d, jitterLine(0, 0, 60, 2, 30, 0.5), 0, 1);
  assert.ok(raw);
  const before = S.clone(d);
  S.recognizeStroke(jitterLine(0, 0, 60, 2, 30, 0.5));
  assert.deepEqual(S.clone(d), before, "reconnaître ne modifie jamais le document");
}

console.log("check_hq_sketch_recognize: ok");
