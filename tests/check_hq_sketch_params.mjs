// Paramètres et cotes pilotantes: expressions, dépendances, cycles, et la géométrie qui suit le nombre.
// Run: node tests/check_hq_sketch_params.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");

function doc() {
  const d = S.createDoc({ units: "mm", spacing: 10 });
  d.version = S.SKETCH_VERSION;
  return d;
}

// --- expressions
assert.equal(S.evalExpr("2+3*4").value, 14);
assert.equal(S.evalExpr("(2+3)*4").value, 20);
assert.equal(S.evalExpr("2^3^2").value, 512, "l'exposant est associatif à droite");
assert.equal(S.evalExpr("-4 + 10").value, 6);
assert.equal(S.evalExpr("12,5 * 2").value, 25, "la virgule décimale française est acceptée");
assert.equal(S.evalExpr("round(10/3, 2)").value, 3.33);
assert.equal(S.evalExpr("max(3, min(9, 5))").value, 5);
assert.equal(S.evalExpr("sqrt(81)").value, 9);
assert.equal(S.evalExpr("sin(30)").value, 0.5);
assert.equal(S.evalExpr("pi > 3", {}).ok, false, "aucune comparaison: refusé, pas deviné");
assert.equal(S.evalExpr("2*").ok, false);
assert.equal(S.evalExpr("1/0").ok, false);
assert.equal(S.evalExpr("inconnu+1").ok, false);
assert.equal(S.evalExpr("inconnu+1").unknown, "inconnu");
assert.equal(S.evalExpr("1e400").ok, false, "l'infini est refusé");

// --- paramètres et dépendances
{
  let d = doc();
  d = S.addParam(d, "largeur", "120").doc;
  d = S.addParam(d, "marge", "largeur/10").doc;
  d = S.addParam(d, "trou", "marge*2 + 1").doc;
  const ev = S.evalParams(d);
  assert.ok(ev.ok, JSON.stringify(ev.errors));
  assert.deepEqual(ev.values, { largeur: 120, marge: 12, trou: 25 });
  assert.ok(S.validateDoc(d).ok, "un document avec paramètres est valide");
  // l'ordre de résolution suit les dépendances, pas la déclaration
  const reversed = S.evalParams({ ...d, params: [...d.params].reverse() });
  assert.deepEqual(reversed.values, ev.values, "l'ordre de déclaration ne change rien");
}
{
  let d = doc();
  d = S.addParam(d, "a", "1").doc;
  assert.equal(S.addParam(d, "a", "2").ok, false, "nom en double");
  assert.equal(S.addParam(d, "2a", "2").ok, false, "nom invalide");
  assert.equal(S.addParam(d, "__proto__", "2").ok, false, "nom réservé");
  assert.equal(S.addParam(d, "b", "  ").ok, false, "expression vide");
  assert.equal(S.addParam(d, "b", "a+").ok, false, "expression invalide");
}
{
  let d = doc();
  d = S.addParam(d, "a", "1").doc;
  d = S.addParam(d, "b", "2").doc;
  const cyc = S.updateParam(d, "a", { expr: "b+1" });
  const cyc2 = S.updateParam(cyc.ok ? cyc.doc : d, "b", { expr: "a+1" });
  assert.equal(cyc2.ok, false, "un cycle est refusé");
  assert.match(cyc2.error, /circulaire|inconnu/i);
}
{
  let d = doc();
  d = S.addParam(d, "largeur", "10").doc;
  const id = d.params[0].id;
  const up = S.updateParam(d, id, { expr: "20" });
  assert.ok(up.ok);
  assert.equal(up.values.largeur, 20);
  const renamed = S.updateParam(up.doc, id, { name: "longueur" });
  assert.ok(renamed.ok);
  assert.equal(S.evalParams(renamed.doc).values.longueur, 20);
  const gone = S.removeParam(renamed.doc, id);
  assert.ok(gone.ok);
  assert.equal(gone.doc.params, undefined, "plus de tableau vide qui traîne");
  assert.equal(S.removeParam(gone.doc, id).ok, false);
}

// --- une cote linéaire pilote la géométrie
function lineDoc() {
  const d = doc();
  const a = S.addPoint(d, 0, 0), b = S.addPoint(d, 30, 0);
  const l = S.addLine(d, { id: a }, { id: b });
  const dim = S.addDimLinear(d, d.points[0], d.points[1], 5);
  return { d: d, a: a, b: b, l: l, dim: dim };
}
{
  const { d, a, b, dim } = lineDoc();
  const driven = S.setDimDrive(d, dim, { points: [a, b], expr: "45" });
  assert.ok(driven.ok, driven.error);
  const res = S.applyParameters(driven.doc);
  assert.ok(res.ok, res.error);
  assert.equal(res.applied, 1);
  const pm = S.pointMap(res.doc);
  assert.ok(Math.abs(Math.hypot(pm.get(b).x - pm.get(a).x, pm.get(b).y - pm.get(a).y) - 45) < 1e-6, "la ligne mesure 45");
  assert.equal(S.getObj(res.doc, dim).label, "45", "la cote affiche la valeur pilotée");
  assert.equal(res.doc.constraints.some(k => String(k.id).startsWith("pdrive:")), false, "les contraintes temporaires ne restent pas");
  assert.ok(S.validateDoc(res.doc).ok);
  assert.equal(S.diagnose(res.doc).issues.length, 0);
}
{
  // pilotée par un paramètre, et la cote suit un déplacement manuel des points
  const { d, a, b, dim } = lineDoc();
  let doc2 = S.addParam(d, "largeur", "60").doc;
  doc2 = S.setDimDrive(doc2, dim, { points: [a, b], expr: "largeur" }).doc;
  const res = S.applyParameters(doc2);
  assert.ok(res.ok, res.error);
  let pm = S.pointMap(res.doc);
  assert.ok(Math.abs(Math.hypot(pm.get(b).x - pm.get(a).x, pm.get(b).y - pm.get(a).y) - 60) < 1e-6);
  // l'utilisateur change le paramètre
  const id = res.doc.params[0].id;
  const bumped = S.updateParam(res.doc, id, { expr: "80" });
  const res2 = S.applyParameters(bumped.doc);
  assert.ok(res2.ok, res2.error);
  pm = S.pointMap(res2.doc);
  assert.ok(Math.abs(Math.hypot(pm.get(b).x - pm.get(a).x, pm.get(b).y - pm.get(a).y) - 80) < 1e-6, "80 après changement du paramètre");
  assert.equal(S.getObj(res2.doc, dim).label, "80");
}
{
  // une cote pilotée contradite par une contrainte fixe est refusée, pas appliquée à moitié
  const { d, a, b, l, dim } = lineDoc();
  const fixedDoc = S.clone(d); // « length » is a dimensional constraint, added by its own tool rather than addConstraint
  fixedDoc.constraints.push({ id: "klen", type: "length", line: l, value: 100, fixed: b });
  assert.ok(S.validateDoc(fixedDoc).ok, S.validateDoc(fixedDoc).error);
  const driven = S.setDimDrive(fixedDoc, dim, { points: [a, b], expr: "20" });
  assert.ok(driven.ok, driven.error);
  const res = S.applyParameters(driven.doc);
  assert.equal(res.ok, false, "30, 100 et 20 ne peuvent pas tenir ensemble");
  assert.ok(res.error);
  assert.equal(S.validateDoc(res.doc).ok, true, "le document proposé reste valide en cas d'échec");
}
{
  // cote d'angle pilotée
  const d = doc();
  const v = S.addPoint(d, 0, 0);
  const l1 = S.addLine(d, { id: v }, { x: 40, y: 0 });
  const l2 = S.addLine(d, { id: v }, { x: 0, y: 40 });
  const dim = S.addDimAngle(d, d.points[0], d.points[1], d.points[2], 20);
  const driven = S.setDimDrive(d, dim, { lines: [l1, l2], vertex: v, expr: "60" });
  assert.ok(driven.ok, driven.error);
  const res = S.applyParameters(driven.doc);
  assert.ok(res.ok, res.error);
  const pm = S.pointMap(res.doc);
  const A = pm.get(S.getObj(res.doc, l1).p2), B = pm.get(S.getObj(res.doc, l2).p2), V = pm.get(v);
  const ang = Math.acos(((A.x - V.x) * (B.x - V.x) + (A.y - V.y) * (B.y - V.y)) /
    (Math.hypot(A.x - V.x, A.y - V.y) * Math.hypot(B.x - V.x, B.y - V.y))) * 180 / Math.PI;
  assert.ok(Math.abs(ang - 60) < 1e-4, "angle " + ang);
  assert.equal(S.getObj(res.doc, dim).label, "60°");
}
{
  // erreurs de cote pilotée
  const { d, dim } = lineDoc();
  assert.equal(S.setDimDrive(d, dim, { expr: "10" }).ok, false, "sans points, pas de pilotage");
  assert.equal(S.setDimDrive(d, dim, { points: ["pz1", "pz2"], expr: "10" }).ok, false, "points inconnus");
  assert.equal(S.setDimDrive(d, dim, { points: [d.points[0].id, d.points[1].id], expr: "0" }).ok, false, "valeur nulle");
  assert.equal(S.setDimDrive(d, dim, { points: [d.points[0].id, d.points[1].id], expr: "cinq" }).ok, false, "expression invalide");
  const ok = S.setDimDrive(d, dim, { points: [d.points[0].id, d.points[1].id], expr: "12" });
  assert.ok(ok.ok);
  const cleared = S.clearDimDrive(ok.doc, dim);
  assert.ok(cleared.ok);
  assert.equal(S.getObj(cleared.doc, dim).drive, undefined);
}
{
  // un document v5 ne peut pas porter de paramètres ni de cote pilotée
  const d = S.createDoc({ units: "mm" });
  d.version = 5;
  d.params = [{ id: "v1", name: "a", expr: "1" }];
  assert.equal(S.validateDoc(d).ok, false);
}

console.log("check_hq_sketch_params: ok");
