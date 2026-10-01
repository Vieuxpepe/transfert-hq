// Carnet Stage 08 — the history UI module loads headless, has no dangerous sinks, never touches browser storage for its own state,
// the local-draft audit works, and the Python and JS engines agree on citation labels and on the Stage-05 "à vérifier" migration
// (shared vectors: tests/fixtures_carnet_history.json, generated from the server implementation and also asserted by Python).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ui = require("../assets/hq-carnet-history-ui.js");
const R = require("../assets/hq-carnet-rich.js");
const S = require("../assets/hq-carnet-sources.js");
const fx = JSON.parse(readFileSync(new URL("./fixtures_carnet_history.json", import.meta.url), "utf8"));
let groups = 0;
const ok = () => { groups += 1; };

// ---------------------------------------------------------------- JS <-> Python parity
{
  for (const c of fx.cases) {
    assert.equal(R.citationLabel(c.old), c.old_label, "old label");
    const got = S.migrateCite(c.old, c.edition, "todo");
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.new, "migrated payload: " + JSON.stringify(c.old.loc));
    assert.equal(R.citationLabel(got), c.new_label, "migrated label");
    assert.equal(got.ok, false);
    assert.equal(got.pdf, null);
    assert.equal(got.loc.text, "", "the old locator text is never carried over");
    assert.deepEqual(got.from, { src: c.old.src, loc: c.old.loc, pdf: c.old.pdf, ok: c.old.ok });
  }
  ok();
}

// ---------------------------------------------------------------- module surface and sinks
{
  assert.equal(typeof Ui.mount, "function");
  assert.equal(typeof Ui.auditStorage, "function");
  assert.deepEqual(Ui.OPS.map((o) => o[0]), ["replace", "context_move", "trash", "source_migrate", "file_replace"]);
  assert.equal(Ui.TARGETS_MAX, 64);
  const code = readFileSync(new URL("../assets/hq-carnet-history-ui.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  assert.ok(!/\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\beval\s*\(|new\s+Function\s*\(|document\.write|\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|importScripts/.test(code), "no HTML injection / eval / network of its own");
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code.replace(/auditStorage[\s\S]*?\n  \}\n/, "")), "no browser storage of its own");
  ok();
}

// ---------------------------------------------------------------- local-draft privacy audit
{
  const mem = (obj) => ({ get length() { return Object.keys(obj).length; }, key: (i) => Object.keys(obj)[i] ?? null, getItem: (k) => (k in obj ? obj[k] : null) });
  const P = "hq_carnet_drafts_v1:";
  const clean = Ui.auditStorage(mem({ [P + "admin"]: JSON.stringify({ version: 1, pages: { "page-a": { text: "bonjour" }, "page-b": { text: "x" } } }), unrelated: "C:\\Users\\me\\secret" }), P);
  assert.equal(clean.drafts, 2);
  assert.deepEqual(clean.flagged, [], "other apps' keys are not read");
  assert.deepEqual(clean.foreign, []);
  const leaky = Ui.auditStorage(mem({ [P + "u"]: JSON.stringify({ version: 1, pages: { "page-a": { text: "see C:\\Users\\me\\a.pdf and csrf=abcd" } } }), hq_carnet_old: "ok" }), P);
  assert.ok(leaky.flagged.some((f) => f.why === "chemin absolu apparent"));
  assert.ok(leaky.flagged.some((f) => f.why === "jeton ou secret apparent"));
  assert.deepEqual(leaky.foreign, ["hq_carnet_old"], "a stray carnet key is reported");
  assert.ok(!JSON.stringify(leaky).includes("abcd"), "the audit never repeats stored content");
  const broken = Ui.auditStorage({ get length() { throw new Error("denied"); } }, P);
  assert.equal(broken.readable, false);
  ok();
}

console.log("check_hq_carnet_history: " + groups + " groups ok");
