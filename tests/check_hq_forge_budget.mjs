// Forge tab load budget: the assets a cold Forge tab downloads, measured (gzip) and
// compiled against a fixed cap. The tab is the heaviest view, so it gets a budget
// like Dessiner's 500-objects/6 ms harness: run `node tests/check_hq_forge_budget.mjs`.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Script } from "node:vm";
import { gzipSync } from "node:zlib";

// Measured 2026-11: ~141 KB gz before the bin/quota/backup/journal work. The cap leaves
// room for one feature-sized change and fails on regrowth (a duplicated module, a
// vendored library, or a copy-pasted component).
const BUDGET = { totalGzKb: 160, fileGzKb: 60, compileMs: 250 };

const dir = new URL("../assets/", import.meta.url);
const files = readdirSync(dir).filter((name) => /^hq-forge.*\.(js|css)$/.test(name)).sort();
assert.ok(files.length >= 10, "assets Forge introuvables : " + files.length);

const rows = files.map((name) => {
  const source = readFileSync(new URL(name, dir));
  return { name, raw: source.length, gz: gzipSync(source, { level: 9 }).length };
});

for (const row of rows) {
  assert.ok(row.gz <= BUDGET.fileGzKb * 1024,
    row.name + " : " + Math.ceil(row.gz / 1024) + " Ko gz, budget " + BUDGET.fileGzKb + " Ko");
}

const totalGz = rows.reduce((sum, row) => sum + row.gz, 0);
assert.ok(totalGz <= BUDGET.totalGzKb * 1024,
  "onglet Forge : " + Math.ceil(totalGz / 1024) + " Ko gz au total, budget " + BUDGET.totalGzKb + " Ko");

// A syntax error would also break the tab: compile every script the tab loads, without
// running it (no DOM here). The timing is the parse cost paid once per cold load.
const started = performance.now();
for (const row of rows.filter((row) => row.name.endsWith(".js"))) {
  new Script(readFileSync(new URL(row.name, dir), "utf8"), { filename: row.name });
}
const compileMs = Math.round(performance.now() - started);
assert.ok(compileMs <= BUDGET.compileMs,
  "compilation JS de l'onglet Forge : " + compileMs + " ms, budget " + BUDGET.compileMs + " ms");

console.log("check_hq_forge_budget: ok · " + rows.length + " fichiers · " +
  Math.ceil(totalGz / 1024) + " Ko gz (budget " + BUDGET.totalGzKb + ") · compilation " + compileMs + " ms");
