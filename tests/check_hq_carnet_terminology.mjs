// Phase 13: terminology pins. The vocabulary is a PRODUCT contract (a label that shortens can silently broaden a claim), so it is pinned here.
//   node tests/check_hq_carnet_terminology.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(here, "..", "assets");
const src = (n) => readFileSync(path.join(assets, n), "utf8");
const ALL = readdirSync(assets).filter((n) => /^hq-carnet.*\.js$/.test(n));

let groups = 0;
const group = (name, fn) => {
  try { fn(); groups += 1; } catch (e) { console.log("FAIL group: " + name); throw e; }
};

group("one word for evidence: Preuve (never « évidence »)", () => {
  for (const n of ALL) assert.ok(!/[Éé]vidence/.test(src(n)), n + ": the word « évidence » must not appear (use « preuve »)");
  const R = require("../assets/hq-carnet-reader.js");
  assert.match(R.MSG.sealRefused, /la preuve figée/);
  const A = require("../assets/hq-carnet-annotations.js");
  assert.equal(A.MSG.viewEvidence, "Lire la preuve");
});

group("semantic precision is never shortened", () => {
  const R = require("../assets/hq-carnet-reader.js");
  const txt = Object.values(R.MSG).filter((v) => typeof v === "string").join("\n") + src("hq-carnet-reader-ui.js");
  assert.match(txt, /Emplacement vérifié/);
  const V = require("../assets/hq-carnet-verifications.js");
  const RS = require("../assets/hq-carnet-reasoning.js");
  assert.match(RS.MSG.confirmDone, /Hypothèse confirmée/);
  assert.ok(!/Fait confirmé/.test(ALL.map(src).join("\n")), "« Hypothèse confirmée » must never become « Fait confirmé »");
  assert.ok(!/Approuvé/.test(ALL.map(src).join("\n")), "a recorded verification is never « Approuvé »");
  assert.ok(typeof V.MSG === "object");
});

group("the reasoning register: withdrawn vs retired are named by object, never a naked « Retirée »", () => {
  const R = require("../assets/hq-carnet-reasoning.js");
  assert.equal(R.STATUS_LABEL.withdrawn, "Décision retirée");
  assert.equal(R.STATUS_LABEL.retired, "Hypothèse retirée");
  assert.equal(R.EVENT_LABEL.withdrawn, "Décision retirée");
  assert.equal(R.EVENT_LABEL.retired, "Hypothèse retirée du raisonnement");
  assert.notEqual(R.EVENT_LABEL.withdrawn, R.EVENT_LABEL.retired);
  assert.match(R.MSG.terminalHelpDecision, /Cette transition est définitive\. La décision restera consultable dans l'historique et ne pourra plus être modifiée\./);
  assert.match(R.MSG.terminalHelp, /Cette transition est définitive\. L'hypothèse restera consultable/);
  assert.equal(R.MSG.withdraw, "Retirer la décision", "the button stays « Retirer la décision » (the consequence is in the confirmation)");
  // state keys are untouched
  assert.deepEqual(Object.keys(R.STATUS_LABEL).slice(0, 6), ["active", "confirmed", "invalidated", "retired", "withdrawn", "superseded"]);
});

group("destructive buttons name the object or the consequence", () => {
  const A = require("../assets/hq-carnet-annotations.js");
  const V = require("../assets/hq-carnet-verifications.js");
  const RS = require("../assets/hq-carnet-reasoning.js");
  assert.equal(A.MSG.del, "Supprimer l'annotation");
  assert.equal(V.MSG.del, "Supprimer la vérification");
  assert.equal(RS.MSG.del, "Supprimer l'enregistrement");
  assert.equal(RS.MSG.removeEvidence, "Retirer la preuve");
  const rv = src("hq-carnet-reviews-ui.js");
  assert.match(rv, /Supprimer définitivement la revue/);
  assert.match(rv, /Retirer la question/);
  assert.match(rv, /Retirer le point/);
  const field = src("hq-carnet-field-ui.js");
  assert.match(field, /Écarter la capture locale/);
  assert.match(field, /Écarter cette capture locale \?/);
  assert.match(field, /Les données non enregistrées de cette capture seront perdues\./);
  // no bare « Supprimer » / « Retirer » / « Voir » button label remains in the Phase 8–12 workflow surfaces
  for (const n of ["hq-carnet-annotations-ui.js", "hq-carnet-verifications-ui.js", "hq-carnet-reasoning-ui.js", "hq-carnet-reviews-ui.js", "hq-carnet-reader-ui.js", "hq-carnet-portals-ui.js"]) {
    const s = src(n);
    assert.ok(!/(btn|button|mut)\("(Supprimer|Retirer|Voir)"/.test(s), n + ": a bare destructive / navigation label");
  }
});

group("navigation verb model", () => {
  const P = require("../assets/hq-carnet-portals.js");
  assert.equal(P.MSG.openReader, "Lire la preuve");
  assert.equal(P.MSG.inspect, "Inspecter");
  assert.equal(P.MSG.open, "Ouvrir");
  const R = require("../assets/hq-carnet-reader.js");
  assert.equal(R.MSG.openTab, "Ouvrir le PDF dans un onglet");
  assert.equal(require("../assets/hq-carnet-verifications.js").MSG.view, "Détails");
  assert.equal(require("../assets/hq-carnet-reasoning.js").MSG.view, "Détails");
  const sources = src("hq-carnet-sources.js");
  assert.ok(!/btn\("[a-z-]+", "Voir le PDF"/.test(sources), "« Voir le PDF » opened the very same Reader as « Lire la preuve »: one entry only");
  const all = ALL.map(src).join("\n");
  assert.ok(!/(text|btn\([^)]*,|button\() ?"Ouvrir dans le lecteur"/.test(all), "the Reader entry is « Lire la preuve »");
  assert.ok(!/button\("Inspecter/.test(src("hq-carnet-structured-ui.js")), "zoom is « Agrandir », « Inspecter » is read-only metadata");
});

group("snapshot vs restore point", () => {
  const all = ALL.map(src).join("\n");
  assert.ok(/Point de restauration/.test(src("hq-carnet-history-ui.js")), "history keeps « Point de restauration »");
  assert.ok(/Jalon/.test(src("hq-carnet-intel-ui.js")), "the cockpit keeps « Jalon »");
  assert.ok(all.length > 0);
});

group("no visible label is the bare word « Erreur »; typed fallbacks", () => {
  const E = require("../assets/hq-carnet-errors.js");
  for (const n of ALL) {
    const s = src(n);
    assert.ok(!/\|\| "Erreur"/.test(s), n + ": bare « Erreur » fallback");
    assert.ok(!/text: "Erreur"/.test(s), n + ": bare « Erreur » label");
    assert.ok(!/"Action impossible\."/.test(s), n + ": « Action impossible. » says nothing");
  }
  assert.equal(E.kind({ status: 0, name: "TypeError", message: "Failed to fetch" }), "offline");
  assert.equal(E.kind({ status: 403 }), "access");
  assert.equal(E.kind({ status: 404 }), "missing");
  assert.equal(E.kind({ status: 409 }), "conflict");
  assert.equal(E.kind({ status: 500 }), "server");
  assert.equal(E.kind({ status: 400, data: { code: "x_corrupt" } }), "corrupt");
  assert.equal(E.kind({ status: 409, data: { code: "integrity_anomaly" } }), "integrity");
  assert.match(E.message({ status: 409 }), /a changé depuis son ouverture\. Recharge-le avant de réessayer\./);
  assert.equal(E.message({ status: 500, data: { error: "Disque plein" } }), "Disque plein", "the server's own message wins");
  const kinds = ["offline", "access", "missing", "conflict", "corrupt", "integrity", "server", "unknown"];
  assert.equal(new Set(kinds.map((k) => E.MSG[k])).size, kinds.length, "every failure kind has its own sentence");
  for (const k of kinds) assert.ok(!/^Erreur\.?$/.test(E.MSG[k]));
});

group("empty states say what the absence means", () => {
  assert.equal(require("../assets/hq-carnet-annotations.js").MSG.none, "Aucune annotation pour cette preuve.");
  assert.equal(require("../assets/hq-carnet-verifications.js").MSG.noneHere, "Aucune vérification liée à cette preuve.");
  assert.equal(require("../assets/hq-carnet-reasoning.js").MSG.noneHere, "Aucune décision ni hypothèse liée à cette preuve.");
});

console.log("check_hq_carnet_terminology: " + groups + " groups OK");
