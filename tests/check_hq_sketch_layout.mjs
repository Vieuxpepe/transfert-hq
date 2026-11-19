// Dessiner layout guard: the action bar stays one row on wide desktops, the phone
// actions keep the intended 6/3/1 arrangement, and the sketch/parameter controls
// stay aligned instead of dropping to a full-width row. Run:
//   node tests/check_hq_sketch_layout.mjs
// The browser measurement lives in check_hq_sketch_layout_probe.py so this stays a
// small assert-style harness alongside the other tests/check_hq_sketch_*.mjs files.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const S = require("../assets/hq-sketch-core.js");
const HERE = path.dirname(fileURLToPath(import.meta.url));

// A valid populated document: two sketches and two parameters make the phone rows
// render, while dirty:true (set by the probe's draft) exposes the wrapped-bar case.
let doc = S.createDoc({ units: "mm", spacing: 10, mode: "construction" });
doc.version = S.SKETCH_VERSION;
for (const [plane, name] of [["XY", "Plaque"], ["XZ", "Poches"]]) {
  const added = S.addSketch(doc, plane, plane === "XZ" ? 6 : 0, name);
  assert.ok(added.ok, added.error);
  doc = added.doc;
}
assert.ok(S.addRect(doc, { x: 0, y: 0 }, { x: 40, y: 20 }), "fixture rectangle");
for (const [name, expr] of [["largeur", "100"], ["marge", "12"]]) {
  const added = S.addParam(doc, name, expr);
  assert.ok(added.ok, added.error);
  doc = added.doc;
}
assert.ok(S.validateDoc(doc).ok, S.validateDoc(doc).error);

const probe = spawnSync(process.env.PYTHON || "python", [path.join(HERE, "check_hq_sketch_layout_probe.py")], {
  input: JSON.stringify(doc),
  encoding: "utf8",
  env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  timeout: 120000,
  maxBuffer: 10 * 1024 * 1024,
});
if (probe.error) throw probe.error;
assert.equal(probe.status, 0, `layout probe failed\n${probe.stdout || ""}\n${probe.stderr || ""}`);
let data;
try {
  data = JSON.parse(probe.stdout);
} catch (err) {
  assert.fail(`layout probe did not return JSON: ${err.message}\n${probe.stdout}\n${probe.stderr}`);
}

const near = (a, b, tolerance = 2.5) => Math.abs(a - b) <= tolerance;
const assertNoOverflow = (label, m) => {
  assert.equal(m.docW, m.win, `${label}: horizontal overflow (docW ${m.docW} > ${m.win})`);
};

for (const [width, m] of [[1440, data.wide[0]], [1280, data.wide[1]]]) {
  assert.ok(m.bar && m.acts, `${width}: toolbar missing`);
  assert.ok(m.dirtyChip, `${width}: fixture should be dirty so the wrapped-bar case is covered`);
  assert.ok(m.bar.h <= 64, `${width}: action bar wrapped (${m.bar.h}px; expected a single ~50px row)`);
  assert.ok(m.sameRow, `${width}: mode and actions are not on the same bar row`);
  assert.deepEqual(m.actionRows, [10], `${width}: action buttons should be one row, got ${m.actionRows}`);
  assertNoOverflow(width, m);
}

for (const [label, m] of [["640", data.params640], ["520", data.phone520], ["390", data.phone390]]) {
  assertNoOverflow(`${label}: params`, m);
  assert.ok(m.params.length >= 2, `${label}: expected parameter rows`);
  for (const [i, row] of m.params.entries()) {
    assert.ok(row.val && row.del && row.expr && row.name, `${label}: parameter ${i} is missing a control`);
    assert.ok(row.del.top < row.expr.top, `${label}: parameter ${i} delete dropped below its expression (${row.del.top} vs ${row.expr.top})`);
    assert.ok(row.del.top < row.val.top + row.val.h && row.val.top < row.del.top + row.del.h,
      `${label}: parameter ${i} delete is not on the value row (${row.val.top}/${row.val.h} vs ${row.del.top}/${row.del.h})`);
    assert.ok(row.del.w < row.row.w / 3, `${label}: parameter ${i} delete is full-width (${row.del.w}/${row.row.w})`);
    assert.ok(row.expr.top > row.name.top, `${label}: parameter ${i} expression should sit below its name`);
  }
}

for (const [label, m] of [["520", data.phone520], ["390", data.phone390]]) {
  assertNoOverflow(`${label}: sketches`, m);
  assert.ok(m.sketches.length >= 2, `${label}: expected sketch rows`);
  for (const [i, row] of m.sketches.entries()) {
    assert.ok(row.up && row.down && row.del, `${label}: sketch ${i} is missing a reorder/delete control`);
    assert.ok(near(row.up.top, row.down.top) && near(row.down.top, row.del.top),
      `${label}: sketch ${i} reorder/delete controls are not on one row (${row.up.top}/${row.down.top}/${row.del.top})`);
    assert.ok(row.del.w < row.row.w / 3, `${label}: sketch ${i} delete is full-width (${row.del.w}/${row.row.w})`);
    for (const [j, button] of row.primary.entries()) {
      assert.ok(button.w < row.row.w / 3, `${label}: sketch ${i} action ${j} is full-width (${button.w}/${row.row.w})`);
    }
  }
}

const phone = data.phone390;
assert.ok(phone.bar.h > 150, `390: phone action grid should take multiple rows (${phone.bar.h}px)`);
assert.deepEqual(phone.actionRows, [6, 3, 1], `390: expected the 6/3/1 action arrangement, got ${phone.actionRows}`);

console.log("check_hq_sketch_layout: ok");
