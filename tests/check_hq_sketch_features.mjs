// Arbre de fonctions: lignes, ordre, répression, point de retour, erreurs lisibles.
// Run: node tests/check_hq_sketch_features.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");

function part() {
  const d = S.createDoc({ units: "mm", spacing: 10 });
  d.version = S.SKETCH_VERSION;
  const rect = S.addRect(d, { x: 0, y: 0 }, { x: 40, y: 20 });
  const boss = S.addFeature(d, "extrude", rect.lines, 6, "blind");
  assert.ok(boss.ok, boss.error);
  const circle = S.addCircle(boss.doc, { x: 20, y: 10 }, 3);
  const hole = S.addSolidStep(boss.doc, { type: "hole", at: [circle], standard: "M6", fit: "clearance", extent: "throughAll" });
  assert.ok(hole.ok, hole.error);
  const shell = S.addSolidStep(hole.doc, { type: "shell", thickness: 1.5, open: true });
  assert.ok(shell.ok, shell.error);
  const doc = shell.doc;
  return { doc: doc, circle: circle, boss: doc.features[0].id, hole: hole.id, shell: shell.id };
}

{
  const { doc, boss, hole, shell } = part();
  const rows = S.featureRows(doc);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => r.label), ["Bossage", "Trou", "Évidement"]);
  assert.deepEqual(rows.map(r => r.index), [0, 1, 2]);
  assert.deepEqual(rows.map(r => r.id), [boss, hole, shell]);
  assert.equal(rows[0].detail, "6", "la profondeur est lisible");
  assert.equal(rows[1].detail, "M6 · clearance");
  assert.ok(rows.every(r => r.active), "sans point de retour, tout est actif");
  assert.deepEqual(rows.map(r => r.errors), [[], [], []], JSON.stringify(rows));
  assert.deepEqual(S.activeFeatures(doc).map(f => f.id), [boss, hole, shell]);
}
{
  // l'œil: réprimé, mais toujours là et toujours dans l'arbre
  const { doc, hole } = part();
  const off = S.setFeatureSuppressed(doc, hole, true);
  assert.ok(off.ok, off.error);
  assert.ok(S.validateDoc(off.doc).ok);
  const rows = S.featureRows(off.doc);
  assert.equal(rows.length, 3, "réprimer ne supprime rien");
  assert.equal(rows[1].suppressed, true);
  assert.deepEqual(S.activeFeatures(off.doc).map(f => f.id).includes(hole), false);
  const on = S.setFeatureSuppressed(off.doc, hole, false);
  assert.ok(on.ok);
  assert.equal(S.featureRows(on.doc)[1].suppressed, false);
  assert.equal(S.setFeatureSuppressed(doc, "fz", true).ok, false, "fonction inconnue");
}
{
  // point de retour: on reconstruit jusqu'à la fonction n
  const { doc, hole } = part();
  const rb = S.setFeatureRollback(doc, 2);
  assert.ok(rb.ok, rb.error);
  const rows = S.featureRows(rb.doc);
  assert.deepEqual(rows.map(r => r.active), [true, true, false]);
  assert.equal(S.activeFeatures(rb.doc).length, 2);
  const back = S.setFeatureRollback(rb.doc, 3);
  assert.ok(back.ok);
  assert.equal(back.doc.rollback, undefined, "revenir à la fin efface le point de retour");
  assert.equal(S.setFeatureRollback(doc, 0).ok, false, "un point de retour à 0 n'a pas de sens");
  assert.ok(S.validateDoc(rb.doc).ok);
}
{
  // réordonner: la base ne bouge pas, une répétition ne passe pas avant sa source
  const { doc, hole, shell } = part();
  const moved = S.moveFeature(doc, shell, -1);
  assert.ok(moved.ok, moved.error);
  assert.deepEqual(S.featureRows(moved.doc).map(r => r.type), ["extrude", "shell", "hole"]);
  assert.equal(S.moveFeature(doc, hole, -1).ok, false, "on ne passe pas devant la base");
  assert.equal(S.moveFeature(doc, doc.features[0].id, -1).ok, false, "la première fonction reste la base");
  const pattern = S.addSolidStep(doc, { type: "pattern", source: hole, mode: "linear", count: 2, dx: 10, dy: 0 });
  assert.ok(pattern.ok, pattern.error);
  assert.equal(S.moveFeature(pattern.doc, pattern.id, -2).ok, false, "la répétition resterait devant sa source");
  const okMove = S.moveFeature(pattern.doc, pattern.id, -1);
  assert.ok(okMove.ok, okMove.error);
}
{
  // les erreurs sont dites, pas devinées: profil manquant, objet parti, coupe en base
  const { doc, hole } = part();
  const broken = S.clone(doc);
  broken.objects = broken.objects.filter(o => o.id !== doc.features[0].profile[1]);
  const rows = S.featureRows(broken);
  assert.ok(rows[0].errors.some(e => /introuvable/.test(e)), JSON.stringify(rows[0].errors));
  assert.equal(S.validateDoc(broken).ok, false, "un document cassé ne s'enregistre pas");

  const cutBase = S.clone(doc);
  cutBase.features[0].op = "cut";
  assert.ok(S.featureRows(cutBase)[0].errors.some(e => /base/.test(e)));
  assert.equal(S.validateDoc(cutBase).ok, false);

  const ghostProfile = S.clone(doc);
  ghostProfile.features[0].profile = [];
  assert.ok(S.featureRows(ghostProfile)[0].errors.includes("profil vide"));

  const ghostHole = S.clone(doc);
  ghostHole.features[1].at = ["c99"];
  assert.equal(S.featureRows(ghostHole)[1].errors.length, 1);
  assert.equal(S.validateDoc(ghostHole).ok, false);

  const orphan = S.clone(doc);
  orphan.features = [orphan.features[0], { ...orphan.features[1], type: "pattern", source: hole, mode: "linear", count: 2, dx: 5, dy: 0 }];
  const orphanRows = S.featureRows(orphan);
  assert.equal(orphanRows.length, 2);
  assert.ok(orphanRows[1].errors.some(e => /source/.test(e)), JSON.stringify(orphanRows[1].errors));
  assert.equal(S.validateDoc(orphan).ok, false, "une répétition sans sa source n'est pas valide");
  // réprimer la source reste cohérent: la répétition suit simplement une fonction en veille
  const muted = S.setFeatureSuppressed(doc, hole, true);
  assert.ok(muted.ok, muted.error);
  assert.ok(S.validateDoc(muted.doc).ok);
  assert.equal(S.activeFeatures(muted.doc).some(f => f.type === "pattern"), false, "rien à répéter quand la source est en veille");
}
{
  // noms et familles: un nom d'usage, sinon le libellé; la famille groupe sans changer le schéma
  const { doc, boss, hole, shell } = part();
  const named = S.updateFeature(doc, hole, { name: "  Perçage M6  " });
  assert.ok(named.ok, named.error);
  assert.equal(named.doc.features[1].name, "Perçage M6", "le nom est nettoyé");
  const rows = S.featureRows(named.doc);
  assert.deepEqual(rows.map(r => r.name), ["Bossage", "Perçage M6", "Évidement"], "sans nom, le libellé");
  assert.deepEqual(rows.map(r => r.family), ["base", "cut", "trim"], "la base reste la base");
  assert.ok(rows.every(r => typeof r.value === "string" && r.value.length), JSON.stringify(rows));
  const long = S.updateFeature(doc, hole, { name: "x".repeat(41) });
  assert.ok(long.ok, long.error);
  assert.equal(long.doc.features[1].name.length, 40, "40 caractères au plus");
  const ctrl = S.updateFeature(doc, hole, { name: "a\tb" });
  assert.ok(ctrl.ok, ctrl.error);
  assert.equal(ctrl.doc.features[1].name, "a b", "les caractères de contrôle deviennent des espaces");
  assert.equal(S.updateFeature(doc, hole, { name: 12 }).ok, false, "un nom non textuel est refusé");
  assert.equal(S.updateFeature(doc, hole, { name: "" }).ok, true, "un nom vide revient au libellé");
  assert.equal(S.featureRows(S.updateFeature(doc, hole, { name: "" }).doc)[1].name, "Trou");
}
{
  // glisser-déposer: on vise une position, la base ne bouge jamais
  const { doc, boss, hole, shell } = part();
  const down = S.moveFeatureTo(doc, hole, 2);
  assert.ok(down.ok, down.error);
  assert.deepEqual(S.featureRows(down.doc).map(r => r.id), [boss, shell, hole]);
  assert.equal(S.moveFeatureTo(doc, boss, 2).ok, false, "la base ne bouge pas");
  assert.equal(S.moveFeatureTo(doc, hole, 0).ok, false, "on ne passe pas devant la base");
  assert.equal(S.moveFeatureTo(doc, hole, "f2").ok, false, "une position non numérique est refusée");
  assert.equal(S.moveFeatureTo(doc, "nope", 1).ok, false, "fonction inconnue");
  const same = S.moveFeatureTo(doc, hole, 1);
  assert.ok(same.ok, same.error);
  assert.deepEqual(S.featureRows(same.doc).map(r => r.id), [boss, hole, shell]);
}
{
  // valeurs pilotées: résolues avant la reconstruction, une expression cassée est dite et laisse le nombre
  const { doc, boss } = part();
  const driven = S.updateFeature(doc, boss, { driven: { depth: "ep * 2" } });
  assert.ok(driven.ok, driven.error);
  assert.equal(S.featureRows(driven.doc)[0].driven.depth, "ep * 2");
  const vals = S.applyFeatureValues(driven.doc, { ep: 4 });
  assert.ok(vals.ok, JSON.stringify(vals.errors));
  assert.equal(vals.doc.features[0].depth, 8);
  const bad = S.applyFeatureValues(driven.doc, {});
  assert.equal(bad.ok, false, "un paramètre absent est signalé");
  assert.equal(bad.doc.features[0].depth, 6, "le dernier nombre connu reste");
  assert.equal(bad.errors[0].field, "depth");
  assert.equal(S.updateFeature(doc, boss, { driven: { type: "1" } }).ok, false, "seuls les champs numériques se pilotent");
  assert.equal(S.updateFeature(doc, boss, { driven: { depth: "" } }).ok, false, "une expression vide est refusée");
}
{
  // un document sans fonction n'a pas d'arbre, et l'arbre ne modifie jamais le document
  const empty = S.createDoc({ units: "mm" });
  assert.deepEqual(S.featureRows(empty), []);
  assert.deepEqual(S.activeFeatures(empty), []);
  const { doc } = part();
  const before = S.clone(doc);
  S.featureRows(doc); S.activeFeatures(doc);
  assert.deepEqual(S.clone(doc), before);
}

console.log("check_hq_sketch_features: ok");
